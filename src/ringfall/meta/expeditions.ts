/*
 * The player's side of expeditions between islands (docs/ringfall/multiplayer.md): the expeditions
 * sent from this island's factory and how they stand, what they cost and pay, the server's answers
 * read into plain data, and the server's holds and log taken into the profile. Pure: the requests
 * themselves are made by the browser (island-net.ts), and scripts/ringfall-expeditions-ui.ts drives
 * these rules on made-up answers.
 */
import { FACTORY, FACTORY_TOP, FRONT } from "../sim/config";
import { parseHold, rivalOf, type PoiHold } from "../sim/holds";
import { NODES, nodeIndex, type NodeId } from "../sim/map";
import { isIslandCode } from "./island-code";
import { unfreeable, unlocked, type Island } from "./island";
import { ISLAND_TABLE } from "./island-table";

/**
 * How an expedition stands: still being sent (its request unanswered; its squad already taken from
 * the factory), and on the island it was sent to on its way, fighting at its node, holding it, or
 * gone (wiped out or lost its node).
 */
export type ExpeditionState = "sending" | "coming" | "attacking" | "holding" | "gone";

/** An expedition this island's factory sent: the island and node it went to, when, the server's number for it, its squad's size, and how it last stood. */
export interface Outgoing {
  code: string;
  node: NodeId;
  sentAt: number;
  id: number;
  units: number;
  state: ExpeditionState;
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
  expeditions: { by: { code: string; name: string }; target: string; units: number; state: ServerState }[];
}

/** The states the island an expedition went to reports. */
type ServerState = Exclude<ExpeditionState, "gone" | "sending">;

/** A change on this island the owner reads (`GET …/log`, `LogEntry` in worker/island.ts). */
export interface IslandLogEntry {
  seq: number;
  at: number;
  t: "landed" | "taken" | "wiped" | "retaken" | "released";
  node: string;
  by: { code: string; name: string };
}

const STATES: readonly ServerState[] = ["coming", "attacking", "holding"];
const LOG_KINDS: readonly IslandLogEntry["t"][] = ["landed", "taken", "wiped", "retaken", "released"];

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
    return isObj(e) && by && typeof e.target === "string" && count(e.units) && STATES.includes(e.state as never) ? [{ by, target: e.target, units: e.units, state: e.state as ServerState }] : [];
  });
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return { code: raw.code, owner: raw.owner, day: num(raw.day), factory: num(raw.factory), protectedUntil: num(raw.protectedUntil), nodes, expeditions };
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
export const reportHolds = (p: { poiState: Island }): PoiHold[] => ISLAND_TABLE.nodes.map((n) => p.poiState[n.id as NodeId]?.state ?? "held");

/**
 * The nodes an owner's report names as taken back in the raid (`retaken` of `PUT /api/islands/:code`):
 * those whose core the raid captured, and those another player held as the raid began that are the
 * player's after it (taken back in the battle). The server gives a node another player holds back to
 * the owner only when the report names it here, so a profile that has not yet learned of a capture
 * cannot undo it by reporting the node as its own.
 */
export function retakenNodes(before: { poiState: Island }, after: { poiState: Island }, captured: readonly string[]): NodeId[] {
  return NODES.filter((n) => after.poiState[n.id]?.state === "freed" && (captured.includes(n.id) || rivalOf(before.poiState[n.id]?.state ?? "held") !== null)).map((n) => n.id);
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
}

/**
 * The profile with a sync taken in, and the log's entries it had not seen (shown once). The nodes a
 * report landed for leave the pending list; the holds are merged around those still pending. The
 * profile itself when nothing changes.
 */
export function applySync<P extends { poiState: Island; logSeq: number; retaken: NodeId[] }>(p: P, s: Synced): { profile: P; news: IslandLogEntry[] } {
  const retaken = s.reported ? p.retaken.filter((id) => !s.reported!.includes(id)) : p.retaken;
  const poiState = s.holds ? mergeHolds(p.poiState, s.holds, retaken) : p.poiState;
  const news = s.log ? s.log.entries.filter((e) => e.seq > p.logSeq).sort((a, b) => a.seq - b.seq) : [];
  const logSeq = s.log ? Math.max(p.logSeq, s.log.next) : p.logSeq;
  if (poiState === p.poiState && logSeq === p.logSeq && retaken.length === p.retaken.length) return { profile: p, news };
  return { profile: { ...p, poiState, logSeq, retaken }, news };
}

/** A node's name for the lines below, or its id for one the game does not know. */
const nodeName = (id: string) => NODES[nodeIndex(id)]?.name ?? id;

/** A log entry as a line of news, naming whoever came. */
export function logLine(e: IslandLogEntry): string {
  const at = nodeName(e.node);
  const who = e.by.name || e.by.code;
  switch (e.t) {
    case "landed":
      return `${who}の遠征隊が${at}に来た`;
    case "taken":
      return `${who}に${at}を取られた`;
    case "wiped":
      return `${at}で${who}の遠征隊を全滅させた`;
    case "retaken":
      return `${at}を取り返した`;
    case "released":
      return `${who}が${at}を手放し、敵の拠点に戻った`;
  }
}

/** Expeditions sent and still out (not gone). */
export const alive = (p: { expeditions: readonly Outgoing[] }) => p.expeditions.filter((e) => e.state !== "gone");

/** The squads the expeditions out take from the factory: one each. */
export const squadsAway = (p: { expeditions: readonly Outgoing[] }) => alive(p).length;

/** The squads the factory keeps out at once on its own island: its level's and the nodes' (`factoryMax()` in sim/battle.ts), before the expeditions take theirs. */
export const factorySquads = (p: { factory: number; poiState: Island }) => FACTORY.levels[Math.max(0, Math.min(FACTORY_TOP, p.factory))].max + unlocked(p).squad;

/** The squads left for the island's own battle once the expeditions out take theirs, never below 0. */
export const homeSquads = (p: { factory: number; poiState: Island; expeditions: readonly Outgoing[] }) => Math.max(0, factorySquads(p) - squadsAway(p));

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
export const numbered = (list: readonly Outgoing[]): Set<string> => new Set(list.filter((o) => o.state !== "sending" && o.state !== "gone").map(sentKey));

/**
 * The expeditions as the islands they went to show them now: each one found there (by this
 * island's code and its node) takes the view's state, one missing from a view read is gone, and one
 * whose island was not read stays as it was. Only those in `asked` (`numbered()` as the views were
 * asked for) are judged: one numbered after the view was read may be missing from it only because
 * it is newer.
 */
export function refreshOutgoing(list: readonly Outgoing[], mine: string, views: Readonly<Record<string, IslandView | null | undefined>>, asked: ReadonlySet<string> = numbered(list)): Outgoing[] {
  return list.map((o) => {
    const v = views[o.code];
    if (!v || o.state === "gone" || o.state === "sending" || !asked.has(sentKey(o))) return o;
    const e = v.expeditions.find((x) => x.by.code === mine && x.target === o.node);
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
    .filter((o): o is Outgoing => isObj(o) && isIslandCode(o.code) && typeof o.node === "string" && nodeIndex(o.node) >= 0 && typeof o.sentAt === "number" && count(o.id) && count(o.units) && (o.state === "gone" || o.state === "sending" || STATES.includes(o.state as never)))
    .map((o) => ({ code: o.code, node: o.node, sentAt: o.sentAt, id: o.id, units: o.units, state: o.state }));
  let over = all.length - KEPT;
  const kept = over > 0 ? all.filter((o) => !(o.state === "gone" && over-- > 0)) : all;
  return kept.slice(-KEPT);
}

/** The state's name on the factory's list. */
export const STATE_NAME: Record<ExpeditionState, string> = { sending: "送っている", coming: "向かっている", attacking: "攻撃中", holding: "保持中", gone: "戻らない" };
