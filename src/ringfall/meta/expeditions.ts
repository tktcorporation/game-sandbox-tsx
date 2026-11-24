/*
 * The player's side of expeditions between islands (docs/ringfall/multiplayer.md): the expeditions
 * sent from this island's factory and how they stand, what they cost and pay, the server's answers
 * read into plain data, and the server's holds and log taken into the profile. Pure: the requests
 * themselves are made by the browser (island-net.ts), and scripts/ringfall-expeditions-ui.ts drives
 * these rules on made-up answers.
 */
import { ENEMIES, FACTORY, FACTORY_TOP, FRONT, type EnemyKind } from "../sim/config";
import type { Battle, RivalExpedition } from "../sim/battle";
import { isAiOwner, parseHold, rivalOf, type PoiHold } from "../sim/holds";
import { NODES, nodeIndex, type NodeId } from "../sim/map";
import { isIslandCode } from "./island-code";
import { unfreeable, unlocked, type Island } from "./island";
import { ISLAND_TABLE } from "./island-table";
import { holdsOf } from "./neighbour-front";
import { parseParcels, parsePings, type Parcel } from "./parcels";
import { trophyDelta } from "./trophies";

/**
 * How an expedition stands: still being sent (its request unanswered; its squad already taken from
 * the factory), and on the island it was sent to on its way, fighting at its node, standing off
 * from it (the node fortified, or the island's day's limit reached), holding it, called home (its
 * squad back with the factory; the island it was on still to be told), or gone (wiped out or lost
 * its node).
 */
export type ExpeditionState = "sending" | "coming" | "attacking" | "waiting" | "holding" | "recalling" | "gone";

/** An expedition this island's factory sent: the island and node it went to, when, the server's number for it, its squad's size, and how it last stood. */
export interface Outgoing {
  code: string;
  node: NodeId;
  sentAt: number;
  id: number;
  units: number;
  state: ExpeditionState;
  /**
   * 他島への短いレイド（Short Raid）の出撃エントリ。
   * 工場のNPC遠征と区別し、自動解決ではなくプレイヤー自身がレイドで制圧する。
   */
  x2?: true;
  /** 短いレイドの結果が防衛側サーバーへの報告（reportAssault）完了待ちであるフラグ。 */
  x2Pending?: true;
  /** 短いレイド勝利による獲得トロフィー（サーバーで拒否された場合はロールバックされる）。 */
  tropGain?: number;
}

/** An island as anyone sees it (`GET /api/islands/:code`, `publicView()` in worker/island.ts). */
export interface IslandView {
  code: string;
  owner: string;
  day: number;
  /** The factory level the owner last reported: what an expedition from this island may take (`squadKinds()` in worker/island.ts). */
  factory: number;
  protectedUntil: number;
  nodes: { id: string; hold: PoiHold; open: boolean }[];
  /** The expeditions on the island; `id` is the number the island gave each when it took it. */
  expeditions: { id: number; by: { code: string; name: string }; target: string; units: number; state: ServerState; arriveAt: number }[];
  /** Live look-pings (ux-design M6). */
  pings: { id: number; x: number; z: number; by: string; until: number }[];
  /** Parcels at depots (ux-design C2). */
  parcels: Parcel[];
}

/**
 * Another player's expedition on this island that has not taken its node (予告): whose, the node it
 * is sent to, when it stands there if no raid meets it first, and how it stands.
 */
export interface Incoming {
  id: number;
  by: { code: string; name: string };
  node: NodeId;
  arriveAt: number;
  state: Exclude<ServerState, "holding">;
}

/** The states the island an expedition went to reports. */
type ServerState = Exclude<ExpeditionState, "gone" | "sending" | "recalling">;

/** A change on this island the owner reads (`GET …/log`, `LogEntry` in worker/island.ts). */
export interface IslandLogEntry {
  seq: number;
  at: number;
  t: "noticed" | "landed" | "taken" | "wiped" | "retaken" | "released" | "recalled";
  node: string;
  by: { code: string; name: string };
}

const STATES: readonly ServerState[] = ["coming", "attacking", "waiting", "holding"];
const LOG_KINDS: readonly IslandLogEntry["t"][] = ["noticed", "landed", "taken", "wiped", "retaken", "released", "recalled"];

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const count = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const attacker = (v: unknown): { code: string; name: string } | null => (isObj(v) && typeof v.code === "string" && typeof v.name === "string" ? { code: v.code, name: v.name } : null);

/** An island's public view as the server answered it, or null for anything unreadable. Nodes and expeditions it cannot read are left out. */
export function parseView(raw: unknown): IslandView | null {
  if (!isObj(raw) || !isIslandCode(raw.code) || typeof raw.owner !== "string" || !Array.isArray(raw.nodes) || !Array.isArray(raw.expeditions)) return null;
  const nodes = raw.nodes.flatMap((n) => {
    const hold = isObj(n) ? parseHold(n.hold) : null;
    return isObj(n) && typeof n.id === "string" && hold ? [{ id: n.id, hold, open: n.open === true }] : [];
  });
  const expeditions = raw.expeditions.flatMap((e) => {
    const by = isObj(e) ? attacker(e.by) : null;
    return isObj(e) && by && count(e.id) && typeof e.target === "string" && count(e.units) && STATES.includes(e.state as never) ? [{ id: e.id, by, target: e.target, units: e.units, state: e.state as ServerState, arriveAt: typeof e.arriveAt === "number" && Number.isFinite(e.arriveAt) ? e.arriveAt : 0 }] : [];
  });
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    code: raw.code,
    owner: raw.owner,
    day: num(raw.day),
    factory: num(raw.factory),
    protectedUntil: num(raw.protectedUntil),
    nodes,
    expeditions,
    pings: parsePings(raw.pings),
    parcels: parseParcels(raw.parcels),
  };
}

/** The owner's log as the server answered it: the entries it can read, and the number to read after next time; null when unreadable. */
export function parseLog(raw: unknown): { entries: IslandLogEntry[]; next: number } | null {
  if (!isObj(raw) || !Array.isArray(raw.entries) || !count(raw.next)) return null;
  const entries = raw.entries.flatMap((e) => {
    const by = isObj(e) ? attacker(e.by) : null;
    return isObj(e) && by && count(e.seq) && typeof e.at === "number" && LOG_KINDS.includes(e.t as never) && typeof e.node === "string" ? [{ seq: e.seq, at: e.at, t: e.t as IslandLogEntry["t"], node: e.node, by }] : [];
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
 * What one sync with the server brought: the island's holds as the server has them, the other
 * players' expeditions on it that hold nothing yet, the log's new entries and the number after
 * them, and the nodes taken back that a report answered 200 for (`reported`); each left out when
 * not read or not reported.
 */
export interface Synced {
  holds?: readonly { id: string; hold: PoiHold }[];
  incoming?: readonly Incoming[];
  log?: { entries: IslandLogEntry[]; next: number };
  reported?: readonly string[];
  /** Parcels as the island last showed them (ux-design C2). */
  parcels?: readonly Parcel[];
}

/**
 * The profile with a sync taken in, and the log's entries it had not seen (shown once). The nodes a
 * report landed for leave the pending list; the holds are merged around those still pending. The
 * profile itself when nothing changes.
 */
export function applySync<P extends { poiState: Island; logSeq: number; retaken: NodeId[]; incoming: Incoming[]; parcels?: Parcel[]; trophies?: number }>(p: P, s: Synced): { profile: P; news: IslandLogEntry[] } {
  const retaken = s.reported ? p.retaken.filter((id) => !s.reported!.includes(id)) : p.retaken;
  const poiState = s.holds ? mergeHolds(p.poiState, s.holds, retaken) : p.poiState;
  const news = s.log ? s.log.entries.filter((e) => e.seq > p.logSeq).sort((a, b) => a.seq - b.seq) : [];
  const logSeq = s.log ? Math.max(p.logSeq, s.log.next) : p.logSeq;
  const incoming = s.incoming && JSON.stringify(s.incoming) !== JSON.stringify(p.incoming) ? [...s.incoming] : p.incoming;
  const parcels = s.parcels ? [...s.parcels] : p.parcels;
  // T1: ownership that changed while away (mergeHolds) moves trophies once here — settle will not
  // see the same own→rival transition again because `p.poiState` already matches.
  let trophies = p.trophies;
  if (poiState !== p.poiState && typeof p.trophies === "number") {
    const next = trophyDelta(p.trophies, holdsOf(p.poiState), holdsOf(poiState)).next;
    if (next !== p.trophies) trophies = next;
  }
  if (poiState === p.poiState && logSeq === p.logSeq && retaken.length === p.retaken.length && incoming === p.incoming && parcels === p.parcels && trophies === p.trophies) return { profile: p, news };
  return { profile: { ...p, poiState, logSeq, retaken, incoming, parcels, ...(trophies !== p.trophies ? { trophies } : {}) }, news };
}

/** The other players' expeditions on an island's view that hold nothing yet, at nodes the game knows: what its owner is warned of. */
export const incomingOf = (v: IslandView): Incoming[] => v.expeditions.flatMap((e) => (e.state !== "holding" && nodeIndex(e.target) >= 0 ? [{ id: e.id, by: { ...e.by }, node: e.target as NodeId, arriveAt: e.arriveAt, state: e.state }] : []));

/** Saved warnings of expeditions: well-formed ones only, a handful at most. */
export function parseIncoming(raw: unknown): Incoming[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .flatMap((e) => {
      const by = isObj(e) ? attacker(e.by) : null;
      return isObj(e) && by && count(e.id) && typeof e.node === "string" && nodeIndex(e.node) >= 0 && typeof e.arriveAt === "number" && (e.state === "coming" || e.state === "attacking" || e.state === "waiting") ? [{ id: e.id, by, node: e.node as NodeId, arriveAt: e.arriveAt, state: e.state as Incoming["state"] }] : [];
    })
    .slice(0, 8);
}

/** A warning as a line: who is coming at which node, and how long the owner has at `now`. */
export function incomingLine(e: Incoming, now: number): string {
  const who = e.by.name || e.by.code;
  const at = nodeName(e.node);
  if (e.state === "waiting") return `${who}の遠征隊が${at}の前で足止めされている`;
  if (e.state === "attacking") return `${who}の遠征隊が${at}を攻めている`;
  if (e.arriveAt <= 0) return `${who}の遠征隊が${at}を狙っている（次のレイドに上陸）`;
  const hours = Math.max(1, Math.ceil((e.arriveAt - now) / 3_600_000));
  return `${who}の遠征隊が${at}を狙っている（次のレイドに上陸。留守ならあと約 ${hours} 時間）`;
}

/** An expedition the owner's raid takes in (`POST …/lease`, `Lent` in worker/island.ts). */
export interface LentIn {
  id: number;
  by: { code: string; name: string };
  target: NodeId;
  kinds: EnemyKind[];
  state: "coming" | "attacking" | "holding";
}

/** A lease as the server answered it: until when the island leaves the expeditions alone, those at nodes and of kinds the game knows, and the nodes still shut to them (fortified in an earlier raid); null when unreadable. */
export function parseLease(raw: unknown): { until: number; expeditions: LentIn[]; shut: NodeId[]; noticed: NodeId[] } | null {
  if (!isObj(raw) || typeof raw.until !== "number" || !Array.isArray(raw.expeditions)) return null;
  const expeditions = raw.expeditions.flatMap((e) => {
    const by = isObj(e) ? attacker(e.by) : null;
    if (!isObj(e) || !by || !count(e.id) || typeof e.target !== "string" || nodeIndex(e.target) < 0 || !Array.isArray(e.kinds) || !e.kinds.length || e.kinds.length > 64) return [];
    if (!e.kinds.every((k) => typeof k === "string" && Object.hasOwn(ENEMIES, k)) || (e.state !== "coming" && e.state !== "attacking" && e.state !== "holding")) return [];
    return [{ id: e.id, by, target: e.target as NodeId, kinds: e.kinds as EnemyKind[], state: e.state as LentIn["state"] }];
  });
  const shut = Array.isArray(raw.shut) ? NODES.filter((n) => (raw.shut as unknown[]).includes(n.id)).map((n) => n.id) : [];
  // 短いレイド（Short Raid）の迎撃対象ノード（ロボット部隊の貸出はなし）
  const noticed = Array.isArray(raw.noticed) ? NODES.filter((n) => (raw.noticed as unknown[]).includes(n.id)).map((n) => n.id) : [];
  return { until: raw.until, expeditions, shut, noticed };
}

/** Seconds into a raid's battle up to which a lease answered late is still taken in (`takeRivals()` in sim/battle.ts): well before the first expedition sets off (`LANDING.first`). */
export const LEASE_LATE = 60;

/**
 * When the expeditions a raid takes in set off for the island, on the battle's clock: the first
 * `first` seconds in, each after it `gap` later, so the player is in and has seen the warning before
 * the first lands.
 */
export const LANDING = { first: 90, gap: 120 };

/**
 * The expeditions a raid takes in, as its battle starts them (`BattleStart.rivals`): one holding its
 * node stands there from the start, the others set off one after another (`LANDING`), those already
 * at their nodes first.
 */
export function lentRivals(lent: readonly LentIn[]): RivalExpedition[] {
  const order = { attacking: 0, coming: 1, holding: 2 };
  let k = 0;
  return [...lent]
    .sort((a, b) => order[a.state] - order[b.state] || a.id - b.id)
    .map((e) => ({ owner: e.by.code, target: e.target, kinds: e.kinds, at: e.state === "holding" ? 0 : LANDING.first + LANDING.gap * k++ }));
}

/**
 * What became of the expeditions a raid took in, for its report (`lent`): the members each has left
 * as the battle ended, by its owner's squads bound for its node (0: wiped out).
 */
export function lentResults(lent: readonly LentIn[], battle: Pick<Battle, "squads" | "rivals"> | null): { id: number; left: number; waiting?: true }[] {
  if (!battle) return [];
  return lent.map((e) => {
    const i = nodeIndex(e.target);
    // By the node a squad is bound for in the end: one of the same owner's only passing through this node on its way to another is not this expedition.
    const squads = battle.squads.filter((q) => q.side === 3 && q.owner === e.by.code && (q.via.length ? q.via[q.via.length - 1] : q.to) === i);
    // One the battle never set off is whole and is reported as never having come (`waiting`): the island leaves it on its own schedule.
    // The battle is reckoned to its end whenever the raid ends (`finishBattle()`), so this is only an expedition due past the battle's end.
    const waiting = battle.rivals.some((x) => x.owner === e.by.code && x.target === e.target);
    return waiting ? { id: e.id, left: e.kinds.length, waiting: true as const } : { id: e.id, left: squads.reduce((n, q) => n + q.units.length, 0) };
  });
}

/** The nodes fortified in a raid that an expedition was sent at (the report's `fortified`): what shuts them on the server for a day. */
export const fortifiedNodes = (battle: Pick<Battle, "fortified" | "noticed"> | null): NodeId[] => (battle ? battle.fortified.filter((i) => battle.noticed.includes(i)).map((i) => NODES[i].id) : []);

/** A node's name for the lines below, or its id for one the game does not know. */
const nodeName = (id: string) => NODES[nodeIndex(id)]?.name ?? id;

/** A log entry as a line of news, naming whoever came. */
export function logLine(e: IslandLogEntry): string {
  const at = nodeName(e.node);
  const who = e.by.name || e.by.code;
  switch (e.t) {
    case "noticed":
      return `${who}が${at}へ遠征に出した`;
    case "landed":
      return `${who}の遠征隊が${at}に来た`;
    case "taken":
      // CoC defence result: losing the node also costs that 中継ボックス's 島の守り.
      return `${who}に${at}を取られた · 島の守りが削られた`;
    case "wiped":
      return `${at}で${who}の遠征隊を全滅させた`;
    case "retaken":
      return `${at}を取り返した · 倉庫へ届く`;
    case "released":
      return `${who}が${at}を手放し、敵の拠点に戻った`;
    case "recalled":
      return `${who}が${at}への遠征隊を引き上げた`;
  }
}

/** What happened in a log entry, in a word, for the signal station's marks. */
export const LOG_WORD: Record<IslandLogEntry["t"], string> = { noticed: "遠征", landed: "上陸", taken: "奪取", wiped: "全滅", retaken: "奪還", released: "手放し", recalled: "撤収" };

/** Whether an entry is someone's attack on this island, answered by sending one back (仕返し). */
export const answerable = (e: IslandLogEntry): boolean => (e.t === "noticed" || e.t === "landed" || e.t === "taken") && isIslandCode(e.by.code);

/**
 * Expeditions that still take a factory squad slot: not `gone`, and not `recalling`
 * (a recall has already returned its squad to the factory).
 */
export const expeditionsOut = (p: { expeditions: readonly Outgoing[] }) => p.expeditions.filter((e) => e.state !== "gone" && e.state !== "recalling");

/**
 * The expeditions with those out called home (引き上げ): each the server has numbered is `recalling`
 * (its squad is back with the factory at once; the island it was on is told by `DELETE`, again at
 * each sync until it answers), `only` of them or all. One still being sent stays as it is. The list
 * itself when nothing changes.
 */
export function recallAll(list: Outgoing[], only?: (o: Outgoing) => boolean): Outgoing[] {
  const out = list.map((o) => (o.id > 0 && (o.state === "coming" || o.state === "attacking" || o.state === "waiting" || o.state === "holding") && (!only || only(o)) ? { ...o, state: "recalling" as const } : o));
  return out.some((o, i) => o !== list[i]) ? out : list;
}

/** The expeditions with the recall of `done` answered (the island took it, or no longer had it): they leave the list. */
export const answerRecall = (list: Outgoing[], done: Pick<Outgoing, "code" | "id">): Outgoing[] => list.filter((o) => !(o.state === "recalling" && o.code === done.code && o.id === done.id));

/** The squads the expeditions out take from the factory: one each. */
export const squadsAway = (p: { expeditions: readonly Outgoing[] }) => expeditionsOut(p).length;

/** The squads the factory keeps out at once on its own island: its level's and the nodes' (`factoryMax()` in sim/battle.ts), before the expeditions take theirs. */
export const factorySquads = (p: { factory: number; poiState: Island }) => FACTORY.levels[Math.max(0, Math.min(FACTORY_TOP, p.factory))].max + unlocked(p).squad;

/** Factory squad slots left for this island's own battle after expeditions take theirs, never below 0. */
export const squadsRemaining = (p: { factory: number; poiState: Island; expeditions: readonly Outgoing[] }) => Math.max(0, factorySquads(p) - squadsAway(p));

/** Whether the factory has a squad to send: an expedition takes one of the squads it keeps out. */
export const canSend = (p: { factory: number; poiState: Island; expeditions: readonly Outgoing[] }) => squadsAway(p) < factorySquads(p);

/**
 * The squad an expedition takes: that of the factory level the server has for this island (its
 * public view's `factory`, the level the owner last reported), which is what the server lets it
 * send. A factory built up since the last report goes out at its new level after the next raid.
 */
export const sendKinds = (serverFactory: number) => FACTORY.levels[Math.max(0, Math.min(FACTORY_TOP, Math.round(serverFactory) || 0))].kinds;

/** Whether the camp's factory is ahead of the level the server has for the island (it reaches the server with the next raid's report). */
export const factoryAhead = (p: { factory: number }, serverFactory: number) => p.factory > serverFactory;

/** How long an expedition may wait as `sending` before a sync drops it: its request was lost (a closed tab). */
export const SENDING_MS = 60_000;

/** An expedition being sent: in the list at once, so the squad it takes is taken while the request is out. */
export const sendingEntry = (code: string, node: NodeId, units: number, now: number): Outgoing => ({ code, node, sentAt: now, id: 0, units, state: "sending" });

/**
 * The expeditions with a send answered: the entry `sending` (found by its island, node and time)
 * becomes the expedition the server numbered `id`, on its way with `units`; with no id (refused, or no answer)
 * it is removed and its squad comes back.
 */
export function answerSend(list: readonly Outgoing[], sending: Outgoing, id: number | null, units = sending.units): Outgoing[] {
  const same = (o: Outgoing) => o.state === "sending" && o.code === sending.code && o.node === sending.node && o.sentAt === sending.sentAt;
  return id === null ? list.filter((o) => !same(o)) : list.map((o) => (same(o) ? { ...o, id, units, state: "coming" as const } : o));
}

/** The expeditions without those left `sending` longer than `SENDING_MS` at `now` (their answer never came). The list itself when none. */
export function dropStale(list: Outgoing[], now: number): Outgoing[] {
  const out = list.filter((o) => o.state !== "sending" || now - o.sentAt <= SENDING_MS);
  return out.length === list.length ? list : out;
}

/** The credits the nodes the expeditions hold on other islands pay at the settle: `FRONT.income` each (陣地の数え方). */
export const awayIncome = (p: { expeditions: readonly Outgoing[] }) => p.expeditions.filter((e) => e.state === "holding").length * FRONT.income;

/** An expedition's key among those sent: its island and the number that island gave it. */
export const sentKey = (o: Pick<Outgoing, "code" | "id">) => `${o.code}:${o.id}`;

/** The keys (`sentKey()`) of the expeditions the server had numbered when views of their islands were asked for: only those may be judged by the views. */
export const numbered = (list: readonly Outgoing[]): Set<string> => new Set(list.filter((o) => o.state !== "sending" && o.state !== "gone" && o.state !== "recalling").map(sentKey));

/**
 * The expeditions as the islands they went to show them now: each one found there (by the number
 * that island gave it, sent from this island) takes the view's state, one missing from a view read is gone, and one
 * whose island was not read stays as it was. Only those in `asked` (`numbered()` as the views were
 * asked for) are judged: one numbered after the view was read may be missing from it only because
 * it is newer.
 */
export function refreshOutgoing(list: readonly Outgoing[], mine: string, views: Readonly<Record<string, IslandView | null | undefined>>, asked: ReadonlySet<string> = numbered(list)): Outgoing[] {
  return list.map((o) => {
    const v = views[o.code];
    if (!v || o.state === "gone" || o.state === "sending" || o.state === "recalling" || !asked.has(sentKey(o))) return o;
    const e = v.expeditions.find((x) => x.id === o.id && x.by.code === mine);
    const state = e ? e.state : "gone";
    return state === o.state && (!e || e.units === o.units) ? o : { ...o, state, units: e?.units ?? o.units };
  });
}

/** The most expeditions a save keeps: more than any factory can have out. */
const KEPT = 12;

/**
 * Saved expeditions: well-formed ones only, at most `KEPT`. Expeditions that are gone make room first
 * (the oldest of them), so a live one is never trimmed for a newer that has already ended.
 */
export function parseOutgoing(raw: unknown): Outgoing[] {
  if (!Array.isArray(raw)) return [];
  const all = raw
    .filter((o): o is Record<string, unknown> => isObj(o) && isIslandCode(o.code) && typeof o.node === "string" && nodeIndex(o.node) >= 0 && typeof o.sentAt === "number" && count(o.id) && count(o.units) && (o.state === "gone" || o.state === "sending" || o.state === "recalling" || STATES.includes(o.state as never)))
    .map(
      (o): Outgoing => ({
        code: o.code as string,
        node: o.node as NodeId,
        sentAt: o.sentAt as number,
        id: o.id as number,
        units: o.units as number,
        state: o.state as ExpeditionState,
        ...(o.x2 === true ? { x2: true as const } : {}),
        ...(o.x2Pending === true ? { x2Pending: true as const } : {}),
        ...(typeof o.tropGain === "number" && Number.isFinite(o.tropGain) && o.tropGain > 0 ? { tropGain: Math.round(o.tropGain) } : {}),
      }),
    );
  let over = all.length - KEPT;
  // 相手サーバーの確認待ちである未報告の短いレイド結果は、通常の gone のように削除せず保持する
  const kept = over > 0 ? all.filter((o) => !((o.state === "gone" && !o.x2Pending) && over-- > 0)) : all;
  return kept.slice(-KEPT);
}

/** The state's name on the factory's list. */
export const STATE_NAME: Record<ExpeditionState, string> = { sending: "送っている", coming: "向かっている", attacking: "攻撃中", waiting: "足止め", holding: "保持中", recalling: "引き上げ中", gone: "戻らない" };
