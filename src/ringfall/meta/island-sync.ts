/*
 * The player's side of the island server (docs/ringfall/multiplayer.md): its answers read into plain
 * data (an island's view, the owner's log), the owner's report, and the server's holds and log taken
 * into the profile (`applySync()`). Pure: the requests themselves are made by the browser
 * (island-net.ts), and scripts/ringfall-island-sync.ts drives these rules on made-up answers.
 */
import { isAiOwner, parseHold, rivalOf, type PoiHold } from "../sim/holds";
import { NODES, nodeIndex, type NodeId } from "../sim/map";
import { LOG_WORD as COPY_LOG_WORD, newsRetaken, newsTaken, newsWipedEnemy, trophyLine } from "../view/copy";
import { isIslandCode } from "./island-code";
import { unfreeable, type Island } from "./island";
import { ISLAND_TABLE } from "./island-table";
import { holdsOf } from "./island";
import { parseParcels, type Parcel } from "./parcels";
import { clampTrophies, defenceWin, raidOdds, rivalTrophies, starGain, trophyDelta } from "./trophies";
import { emptyOuterGuard, guardOn, mergeOuterGuard, OUTER_GUARD, recordOuterLoss, utcDay, type OuterGuard } from "./outer-guard";
import { isContestedShore } from "./neighbours";
import { parseReplay, type Replay } from "../sim/replay-data";

/** An island as anyone sees it (`GET /api/islands/:code`, `publicView()` in worker/island.ts). */
export interface IslandView {
  code: string;
  owner: string;
  day: number;
  /** The factory level the owner last reported: what stands round a holding's core in a sortie on it. */
  factory: number;
  protectedUntil: number;
  /** Island shield end (作り順③); 0 when none. Older servers omit → 0. */
  shieldUntil: number;
  /** Outer hubs lost this UTC day (作り順③). Older servers omit → 0. */
  outerLost: number;
  /** Loss cap for outer hubs (作り順③). Older servers omit → OUTER_GUARD.lossCap. */
  outerLossCap: number;
  nodes: { id: string; hold: PoiHold; open: boolean; shielded?: boolean }[];
  /** Parcels at depots (ux-design C2). */
  parcels: Parcel[];
  /** Holdings sorties took that the owner's reports have not shown lost yet (outlives the bounded log). */
  raided: string[];
}

/** A change on this island the owner reads (`GET …/log`, `LogEntry` in worker/island.ts). */
export interface IslandLogEntry {
  seq: number;
  at: number;
  /** A holding taken (取られた), held against a sortie (守りきった), or taken back by its owner. */
  t: "taken" | "wiped" | "retaken";
  node: string;
  by: { code: string; name: string };
  /** A sortie's stars (0–3): what its attacker won, and so what this island's owner loses. */
  stars?: number;
  /** The trophies the sortie's attacker won, as their settle counted them: what this island's owner loses. */
  won?: number;
  /** The sortie's record (攻めの記録, sim/replay.ts), on the latest sorties' lines. */
  replay?: Replay;
}

const LOG_KINDS: readonly IslandLogEntry["t"][] = ["taken", "wiped", "retaken"];

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const count = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const attacker = (v: unknown): { code: string; name: string } | null => (isObj(v) && typeof v.code === "string" && typeof v.name === "string" ? { code: v.code, name: v.name } : null);

/** An island's public view as the server answered it, or null for anything unreadable. Nodes it cannot read are left out. */
export function parseView(raw: unknown): IslandView | null {
  if (!isObj(raw) || !isIslandCode(raw.code) || typeof raw.owner !== "string" || !Array.isArray(raw.nodes)) return null;
  const nodes = raw.nodes.flatMap((n) => {
    const hold = isObj(n) ? parseHold(n.hold) : null;
    return isObj(n) && typeof n.id === "string" && hold ? [{ id: n.id, hold, open: n.open === true, ...(n.shielded === true ? { shielded: true } : {}) }] : [];
  });
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    code: raw.code,
    owner: raw.owner,
    day: num(raw.day),
    factory: num(raw.factory),
    protectedUntil: num(raw.protectedUntil),
    shieldUntil: num(raw.shieldUntil),
    outerLost: num(raw.outerLost),
    outerLossCap: num(raw.outerLossCap) || OUTER_GUARD.lossCap,
    nodes,
    raided: Array.isArray(raw.raided) ? raw.raided.filter((x): x is string => typeof x === "string") : [],
    parcels: parseParcels(raw.parcels),
  };
}

const LOG_NODES: readonly string[] = ISLAND_TABLE.nodes.map((n) => n.id);

/** The owner's log as the server answered it: the entries it can read (a line of a kind since removed is left out), and the number to read after next time; null when unreadable. */
export function parseLog(raw: unknown): { entries: IslandLogEntry[]; next: number } | null {
  if (!isObj(raw) || !Array.isArray(raw.entries) || !count(raw.next)) return null;
  const entries = raw.entries.flatMap((e) => {
    const by = isObj(e) ? attacker(e.by) : null;
    if (!(isObj(e) && by && count(e.seq) && typeof e.at === "number" && LOG_KINDS.includes(e.t as never) && typeof e.node === "string")) return [];
    const stars = count(e.stars) && e.stars <= 3 ? { stars: e.stars } : {};
    const won = count(e.won) && e.won > 0 ? { won: e.won } : {};
    const record = parseReplay(e.replay, LOG_NODES);
    const replay = record && record.node === e.node ? { replay: record } : {};
    return [{ seq: e.seq, at: e.at, t: e.t as IslandLogEntry["t"], node: e.node, by, ...stars, ...won, ...replay }];
  });
  return { entries, next: raw.next };
}

/** The holds of an owner's report (`PUT /api/islands/:code`): each node's in the server's order (`ISLAND_TABLE`). */
export const reportHolds = (p: { poiState: Island }): PoiHold[] =>
  ISLAND_TABLE.nodes.map((n) => {
    const h = p.poiState[n.id as NodeId]?.state ?? "foe";
    // A node one of the game's own islands holds (meta/ai-islands.ts) is no player's to the server: the enemy's.
    return isAiOwner(rivalOf(h)) ? "foe" : h;
  });

/**
 * The nodes an owner's report names as taken back in the raid (`retaken` of `PUT /api/islands/:code`):
 * those whose core the raid captured, and those another player held as the raid began that are the
 * player's after it (taken back in the battle). The server gives a node another player holds back to
 * the owner only when the report names it here, so a profile that has not yet learned of a capture
 * cannot undo it by reporting the node as its own.
 */
export function retakenNodes(before: { poiState: Island }, after: { poiState: Island }, captured: readonly string[]): NodeId[] {
  return NODES.filter((n) => after.poiState[n.id]?.state === "own" && (captured.includes(n.id) || rivalOf(before.poiState[n.id]?.state ?? "foe") !== null)).map((n) => n.id);
}

/** Nodes taken back still to report (`Profile.retaken`) with `more` added: each once, in `NODES` order. */
export const addRetaken = (pending: readonly string[], more: readonly string[]): NodeId[] => NODES.filter((n) => pending.includes(n.id) || more.includes(n.id)).map((n) => n.id);

/** A saved list of nodes taken back still to report: node ids only, each once. */
export const parseRetaken = (raw: unknown): NodeId[] => (Array.isArray(raw) ? addRetaken([], raw.filter((id): id is string => typeof id === "string")) : []);

/** The holds the server answered a report with (in the server's order), as the view's nodes; null when unreadable. */
export function reportedHolds(raw: unknown): { id: string; hold: PoiHold }[] | null {
  if (!isObj(raw) || !Array.isArray(raw.holds) || raw.holds.length !== ISLAND_TABLE.nodes.length) return null;
  const out = raw.holds.map((h, i) => ({ id: ISLAND_TABLE.nodes[i].id, hold: parseHold(h) }));
  return out.every((n) => n.hold !== null) ? (out as { id: string; hold: PoiHold }[]) : null;
}

/**
 * The island with the server's holds taken in. The server is the truth for other players' holds
 * (docs/ringfall/multiplayer.md, 決めたこと): a node it gives to another player is theirs, and a node
 * the profile gives to another player that the server does not is as the server has it. Every other
 * node stays as the profile has it, since the owner's own captures reach the server only with the
 * next report. A node in `pending` (taken back, its report not yet answered) stays as the profile
 * has it: the server still gives it to the other player until the report lands. The island itself
 * when nothing changes.
 */
export function mergeHolds(poiState: Island, server: readonly { id: string; hold: PoiHold }[], pending: readonly string[] = []): Island {
  let out = poiState;
  for (const { id, hold } of server) {
    if (nodeIndex(id) < 0 || unfreeable(id as NodeId) || pending.includes(id)) continue;
    const cur = poiState[id as NodeId]?.state;
    // The game's own islands are the browser's, never the server's: a node one holds stays so until the player takes it back.
    if (cur !== undefined && isAiOwner(rivalOf(cur)) && rivalOf(hold) === null) continue;
    const next = rivalOf(hold) !== null ? hold : cur !== undefined && rivalOf(cur) !== null ? hold : cur;
    if (next === undefined || next === cur) continue;
    if (out === poiState) out = { ...poiState };
    out[id as NodeId] = { state: next };
  }
  return out;
}

/**
 * What one sync with the server brought: the island's holds as the server has them, the log's new
 * entries and the number after them, and the nodes taken back that a report answered 200 for
 * (`reported`); each left out when not read or not reported.
 */
export interface Synced {
  holds?: readonly { id: string; hold: PoiHold }[];
  log?: { entries: IslandLogEntry[]; next: number };
  reported?: readonly string[];
  /** Parcels as the island last showed them (ux-design C2). */
  parcels?: readonly Parcel[];
  /** Server's outer-guard snapshot from the island view (作り順③). */
  outerGuard?: OuterGuard;
  /** Holdings sorties took that the island still waits for the owner to see lost (`IslandView.raided`). */
  raided?: readonly string[];
}

/**
 * Outer-guard from a public island view (作り順③). Older views without shield fields → empty.
 */
export function outerGuardFromView(view: Pick<IslandView, "shieldUntil" | "outerLost">, now = Date.now()): OuterGuard {
  const day = utcDay(now);
  if (view.shieldUntil > now || view.outerLost > 0) {
    return { utcDay: day, lost: Math.max(0, view.outerLost), island: view.shieldUntil > now };
  }
  return guardOn(undefined, now);
}

/**
 * The profile with a sync taken in, and the log's entries it had not seen (shown once). The nodes a
 * report landed for leave the pending list; the holds are merged around those still pending. The
 * profile itself when nothing changes.
 */
export function applySync<P extends { poiState: Island; logSeq: number; retaken: NodeId[]; parcels?: Parcel[]; trophies?: number; outerGuard?: OuterGuard }>(
  p: P,
  s: Synced,
  rivalTrop?: (owner: string) => number,
): { profile: P; news: IslandLogEntry[]; notes: string[] } {
  const retaken = s.reported ? p.retaken.filter((id) => !s.reported!.includes(id)) : p.retaken;
  let poiState = s.holds ? mergeHolds(p.poiState, s.holds, retaken) : p.poiState;
  const news = s.log ? s.log.entries.filter((e) => e.seq > p.logSeq).sort((a, b) => a.seq - b.seq) : [];
  // Another player's sortie took a holding (glossary.md 攻め): it went back to the robots on the server; so here.
  const raidedBy: { seq: number; code: string; stars: number; won?: number }[] = [];
  // What each sortie's line cost the trophies, as reckoned here: the record of it (meta/attacks.ts) shows the same.
  const costs = new Map<number, number>();
  for (const e of news) {
    if (e.t !== "taken" || isAiOwner(e.by.code) || poiState[e.node as NodeId]?.state !== "own") continue;
    const srv = s.holds?.find((h) => h.id === e.node)?.hold;
    if (srv === "own") continue;
    poiState = { ...poiState, [e.node]: { state: "foe" } };
    raidedBy.push({ seq: e.seq, code: e.by.code, stars: e.stars ?? 3, ...(e.won ? { won: e.won } : {}) });
  }
  // A holding a sortie took whose log line has already scrolled away: lost all the same (its trophies are past knowing).
  for (const id of s.raided ?? []) {
    // One taken back since whose report has not reached the island yet (`retaken`) stays the player's.
    if (poiState[id as NodeId]?.state !== "own" || s.holds?.find((h) => h.id === id)?.hold === "own" || p.retaken.includes(id as NodeId)) continue;
    poiState = { ...poiState, [id]: { state: "foe" } };
  }
  const logSeq = s.log ? Math.max(p.logSeq, s.log.next) : p.logSeq;
  // 島の守り stand only at the player's holdings: stock the server still lists at a node lost since (an AI player's attack) stays gone.
  const parcels = s.parcels ? s.parcels.filter((q) => poiState[q.poi as NodeId]?.state === "own") : p.parcels;
  // 作り順③: merge server snapshot with local (AI takes never hit the server), then
  // bump from new "taken" log lines when the sync brought no view snapshot.
  const now = Date.now();
  let outerGuard = s.outerGuard
    ? mergeOuterGuard(p.outerGuard, s.outerGuard, now)
    : (p.outerGuard ?? emptyOuterGuard());
  if (!s.outerGuard) {
    for (const e of news) {
      if (e.t === "taken" && isContestedShore(e.node)) outerGuard = recordOuterLoss(outerGuard, e.at);
    }
  }
  // Ownership (mergeHolds) and 守りきった (wiped log) move trophies once here — settle will not
  // see the same own→rival transition again because `p.poiState` already matches.
  // トロフィーは必ず知らせの一行と一緒に動かす（notes）。
  let trophies = p.trophies;
  const notes: string[] = [];
  if (typeof p.trophies === "number") {
    let gained = 0;
    let lost = 0;
    let next = p.trophies;
    if (poiState !== p.poiState) {
      const lookup = rivalTrop ?? ((o: string) => rivalTrophies(o, p.trophies!));
      const d = trophyDelta(p.trophies, holdsOf(p.poiState), holdsOf(poiState), lookup);
      gained = d.gained;
      lost = d.lost;
      next = d.next;
    }
    // A holding another player's sortie took costs what their stars won (starGain of raidOdds N).
    for (const r of raidedBy) {
      const foe = rivalTrop ? rivalTrop(r.code) : rivalTrophies(r.code, p.trophies!);
      // What the attacker's settle counted, when it says; else what their stars win at today's standings.
      const n = r.won ?? starGain(raidOdds(foe, p.trophies!).N, r.stars);
      costs.set(r.seq, n);
      lost += n;
      next = clampTrophies(next - n);
    }
    // 守りきった → +M of each attacker (TKT-218); a sortie that won a star without the core costs that star instead.
    let defended = 0;
    for (const e of news.filter((n) => n.t === "wiped")) {
      const foe = rivalTrop ? rivalTrop(e.by.code) : rivalTrophies(e.by.code, p.trophies!);
      if (e.stars) {
        const n = e.won ?? starGain(raidOdds(foe, p.trophies!).N, e.stars);
        costs.set(e.seq, n);
        lost += n;
        next = clampTrophies(next - n);
      } else defended += defenceWin(foe, p.trophies!);
    }
    if (defended) next = clampTrophies(next + defended);
    if (next !== p.trophies) {
      trophies = next;
      notes.push(trophyLine(p.trophies, next, gained, lost, defended));
    }
  }
  // The lines with what they cost, where the report did not say (`won`).
  const told = costs.size ? news.map((e) => (!e.won && costs.get(e.seq) ? { ...e, won: costs.get(e.seq)! } : e)) : news;
  const guardChanged = JSON.stringify(outerGuard) !== JSON.stringify(p.outerGuard ?? emptyOuterGuard());
  if (poiState === p.poiState && logSeq === p.logSeq && retaken.length === p.retaken.length && parcels === p.parcels && trophies === p.trophies && !guardChanged)
    return { profile: p, news: told, notes };
  return {
    profile: {
      ...p,
      poiState,
      logSeq,
      retaken,
      parcels,
      ...(trophies !== p.trophies ? { trophies } : {}),
      ...(guardChanged ? { outerGuard } : {}),
    },
    news: told,
    notes,
  };
}

/** A node's name for the lines below, or its id for one the game does not know. */
const nodeName = (id: string) => NODES[nodeIndex(id)]?.name ?? id;

/** A log entry as a line of news, naming whoever came. */
export function logLine(e: IslandLogEntry): string {
  const at = nodeName(e.node);
  const who = e.by.name || e.by.code;
  switch (e.t) {
    case "taken":
      return newsTaken(at, who);
    case "wiped":
      return newsWipedEnemy(at, who);
    case "retaken":
      return newsRetaken(at);
  }
}

/** What happened in a log entry, in a word, for the signal station's marks. */
export const LOG_WORD: Record<IslandLogEntry["t"], string> = { ...COPY_LOG_WORD };

/**
 * 「取られた」行からやり返す対象になるか（TKT-204 案 F / CoC revenge）.
 * AI の `ai-` 所有者も含む。拠点がまだ相手持ちのときだけボタンを出すのは呼び出し側。
 */
export const revengeable = (e: IslandLogEntry): boolean => e.t === "taken" && !!e.by.code && nodeIndex(e.node) >= 0;
