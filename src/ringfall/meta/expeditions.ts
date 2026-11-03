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

/** How an expedition stands on the island it was sent to: on its way, fighting at its node, holding it, or gone (wiped out or lost its node). */
export type ExpeditionState = "coming" | "attacking" | "holding" | "gone";

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
  factory: number;
  protectedUntil: number;
  nodes: { id: string; hold: PoiHold; open: boolean }[];
  expeditions: { by: { code: string; name: string }; target: string; units: number; state: Exclude<ExpeditionState, "gone"> }[];
}

/** A change on this island the owner reads (`GET …/log`, `LogEntry` in worker/island.ts). */
export interface IslandLogEntry {
  seq: number;
  at: number;
  t: "landed" | "taken" | "wiped" | "retaken" | "released";
  node: string;
  by: { code: string; name: string };
}

const STATES: readonly Exclude<ExpeditionState, "gone">[] = ["coming", "attacking", "holding"];
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
    return isObj(e) && by && typeof e.target === "string" && count(e.units) && STATES.includes(e.state as never) ? [{ by, target: e.target, units: e.units, state: e.state as Exclude<ExpeditionState, "gone"> }] : [];
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
 * next report. The island itself when nothing changes.
 */
export function mergeHolds(poiState: Island, server: readonly { id: string; hold: PoiHold }[]): Island {
  let out = poiState;
  for (const { id, hold } of server) {
    if (nodeIndex(id) < 0 || unfreeable(id as NodeId)) continue;
    const cur = poiState[id as NodeId]?.state;
    const next = rivalOf(hold) !== null ? hold : cur !== undefined && rivalOf(cur) !== null ? hold : cur;
    if (next === undefined || next === cur) continue;
    if (out === poiState) out = { ...poiState };
    out[id as NodeId] = { state: next };
  }
  return out;
}

/** What one sync with the server brought: the island's holds as the server has them, the log's new entries and the number after them; each left out when not read. */
export interface Synced {
  holds?: readonly { id: string; hold: PoiHold }[];
  log?: { entries: IslandLogEntry[]; next: number };
}

/** The profile with a sync taken in, and the log's entries it had not seen (shown once). The profile itself when nothing changes. */
export function applySync<P extends { poiState: Island; logSeq: number }>(p: P, s: Synced): { profile: P; news: IslandLogEntry[] } {
  const poiState = s.holds ? mergeHolds(p.poiState, s.holds) : p.poiState;
  const news = s.log ? s.log.entries.filter((e) => e.seq > p.logSeq).sort((a, b) => a.seq - b.seq) : [];
  const logSeq = s.log ? Math.max(p.logSeq, s.log.next) : p.logSeq;
  if (poiState === p.poiState && logSeq === p.logSeq) return { profile: p, news };
  return { profile: { ...p, poiState, logSeq }, news };
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

/** The members an expedition takes: the factory's squad (`FACTORY.levels[].kinds`), as the server allows. */
export const sendUnits = (p: { factory: number }) => FACTORY.levels[Math.max(0, Math.min(FACTORY_TOP, p.factory))].kinds.length;

/** The credits the nodes the expeditions hold on other islands pay at the settle: `FRONT.income` each (陣地の数え方). */
export const awayIncome = (p: { expeditions: readonly Outgoing[] }) => p.expeditions.filter((e) => e.state === "holding").length * FRONT.income;

/**
 * The expeditions as the islands they went to show them now: each one found there (by this
 * island's code and its node) takes the view's state, one missing from a view read is gone, and one
 * whose island was not read stays as it was.
 */
export function refreshOutgoing(list: readonly Outgoing[], mine: string, views: Readonly<Record<string, IslandView | null | undefined>>): Outgoing[] {
  return list.map((o) => {
    const v = views[o.code];
    if (!v || o.state === "gone") return o;
    const e = v.expeditions.find((x) => x.by.code === mine && x.target === o.node);
    const state = e ? e.state : "gone";
    return state === o.state && (!e || e.units === o.units) ? o : { ...o, state, units: e?.units ?? o.units };
  });
}

/** The most expeditions a save keeps: more than any factory can have out. */
const KEPT = 12;

/** Saved expeditions: well-formed ones only, the latest `KEPT`. */
export function parseOutgoing(raw: unknown): Outgoing[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((o): o is Outgoing => isObj(o) && isIslandCode(o.code) && typeof o.node === "string" && nodeIndex(o.node) >= 0 && typeof o.sentAt === "number" && count(o.id) && count(o.units) && (o.state === "gone" || STATES.includes(o.state as never)))
    .map((o) => ({ code: o.code, node: o.node, sentAt: o.sentAt, id: o.id, units: o.units, state: o.state }))
    .slice(-KEPT);
}

/** The state's name on the factory's list. */
export const STATE_NAME: Record<ExpeditionState, string> = { coming: "向かっている", attacking: "攻撃中", holding: "保持中", gone: "戻らない" };
