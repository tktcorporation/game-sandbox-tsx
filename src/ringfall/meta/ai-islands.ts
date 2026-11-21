/*
 * The islands the game runs itself (docs/ringfall/multiplayer.md, AI の島): while the server offers
 * fewer neighbours than the sea has slots (few players, or no server at all), each empty slot holds
 * an island of the game's own, which lives as a player's would. Each day of the player's it takes or
 * loses a node of its own island, plays a raid now and then by the clock, and builds its factory up;
 * once the player holds the node facing it, the sea route is open both ways: the player may send it
 * an expedition, and it now and then sends one at that node, which lands in the next raid as another
 * player's does (`aiLent()`), and stays as its hold if it takes the node. It is marked AI wherever
 * it is shown. Pure: everything follows from a salt (the browser's player, so two players meet
 * different islands), the profile and the clock, with nothing kept but what the profile already
 * keeps (the expeditions sent, the nodes held); the browser's requests are answered from here
 * (island-net.ts), so the factory's panel works the same for them.
 */
import { FACTORY, FACTORY_TOP, type EnemyKind } from "../sim/config";
import { aiOwner, isAiOwner, rivalOf, type PoiHold } from "../sim/holds";
import { FRONT_LINKS, NODES, TIER, nodeIndex, type NodeId } from "../sim/map";
import { CODE_ALPHABET, CODE_LENGTH } from "./island-code";
import { lentRivals, type Incoming, type IslandLogEntry, type IslandView, type LentIn, type Outgoing } from "./expeditions";
import type { RivalExpedition } from "../sim/battle";
import { NEIGHBOUR_MAX, NEIGHBOUR_SLOTS, routeOpen, type Neighbour } from "./neighbours";
import type { Island } from "./island";

/** The numbers of the game's islands. */
export const AI = {
  /** Seconds into the raid's battle the day's expedition comes down by its node: time to read the warning and get there. */
  landAt: 240,
  /** The first day of the player's on which one may send an expedition. */
  start: 4,
  /** The chance a day that an island whose sea route is open sends one, and the more while the player's expedition is on it (仕返し). */
  attack: 0.22,
  answer: 0.5,
  /** The minutes an expedition of the player's is on its way, then fights at its node. */
  coming: 20,
  fighting: 40,
  /** The hours a node it took stays the player's before the island takes it back, at least and at most. */
  hold: [24, 72] as const,
  /** Its chance of taking the node: a base, more for each robot it has, less at a node the island holds. */
  win: { base: 0.3, unit: 0.08, defended: 0.15 },
  /** The nodes it holds on its island's first day, and how many more a day (one rate a slot), and the most. */
  held: { first: 2, rate: [0.42, 0.5, 0.36, 0.56] as const, spare: 2 },
  /** The days to each level of its factory. */
  factoryDays: 5,
  /** The hours between its raids (one a slot), by the clock. */
  every: [6, 9, 7, 11] as const,
};

/** The owners' names, a few a slot; the salt picks one. All of a length, so the cards keep their size. */
const NAMES: readonly (readonly string[])[] = [
  ["ハヤテ", "ミナト", "コハク"],
  ["ツバキ", "シオン", "アサギ"],
  ["クロガネ", "ホムラ", "イカリ"],
  ["カモメ", "スバル", "トキワ"],
];

/** A small integer hash of a few numbers. */
function hash(...xs: number[]): number {
  let h = 0x811c9dc5;
  for (const x of xs) {
    h = Math.imul(h ^ (x >>> 0), 0x01000193) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
    h ^= h >>> 12;
  }
  return h >>> 0;
}
const unit = (...xs: number[]) => (hash(...xs) % 100_000) / 100_000;

/** One of the game's islands, as it stands in its slot whatever day it is. */
export interface AiIsland {
  slot: number;
  code: string;
  name: string;
}

/** The game's island in slot `k` for `salt`: its code (an island code, never handed out by the server but by the slim chance of a draw) and its owner's name. */
export function aiIsland(salt: number, k: number): AiIsland {
  const code = Array.from({ length: CODE_LENGTH }, (_, i) => CODE_ALPHABET[hash(salt, k, 31 + i) % CODE_ALPHABET.length]).join("");
  const names = NAMES[k % NAMES.length];
  return { slot: k, code, name: names[hash(salt, k, 7) % names.length] };
}

/** The game's islands in the slots `taken` leaves free. */
export const aiIslands = (salt: number, taken: readonly number[] = []): AiIsland[] =>
  NEIGHBOUR_SLOTS.map((_, k) => k).filter((k) => !taken.includes(k)).slice(0, NEIGHBOUR_MAX).map((k) => aiIsland(salt, k));

/** The game's island of code `code` among those `taken` leaves free, or null. */
export const aiByCode = (salt: number, code: string, taken: readonly number[] = []): AiIsland | null => aiIslands(salt, taken).find((a) => a.code === code) ?? null;

/** The game's island whose battle owner is `owner` (`aiOwner()`), or null. */
export const aiByOwner = (salt: number, owner: string | null, taken: readonly number[] = []): AiIsland | null => (isAiOwner(owner) ? aiByCode(salt, owner!.slice(3), taken) : null);

/**
 * The nodes of its own island in the order it takes them: out from the camp along the front's
 * links, a hash of the island breaking each step's ties, so each island grows its own way.
 */
function takeOrder(a: AiIsland, salt: number): NodeId[] {
  const out: NodeId[] = [];
  let front = FRONT_LINKS.filter((l) => l[0] === "camp").map((l) => l[1]);
  while (out.length < NODES.length && front.length) {
    const next = [...front].sort((x, y) => hash(salt, a.slot, nodeIndex(x)) - hash(salt, a.slot, nodeIndex(y)))[0];
    out.push(next);
    const seen = new Set<string>(out);
    front = [...new Set(FRONT_LINKS.flatMap((l) => (l[0] === "camp" ? [] : seen.has(l[0]) && !seen.has(l[1]) ? [l[1]] : seen.has(l[1]) && !seen.has(l[0]) ? [l[0]] : [])))] as NodeId[];
  }
  return out;
}

/** How many nodes its island holds on day `day` of the player's: a steady climb at its slot's rate, a day's ups and downs, never all. */
export function aiHeld(a: AiIsland, salt: number, day: number): number {
  const d = Math.max(1, day);
  const climb = AI.held.first + (d - 1) * AI.held.rate[a.slot % AI.held.rate.length];
  const wobble = (hash(salt, a.slot, d, 3) % 3) - 1;
  return Math.max(1, Math.min(NODES.length - AI.held.spare, Math.round(climb) + wobble));
}

/** The nodes its island holds on day `day`. */
export const aiNodes = (a: AiIsland, salt: number, day: number): NodeId[] => takeOrder(a, salt).slice(0, aiHeld(a, salt, day));

/** Its factory's level on day `day`. */
export const aiFactory = (day: number) => Math.max(0, Math.min(FACTORY_TOP, Math.floor((Math.max(1, day) - 1) / AI.factoryDays)));

/** The robots its expedition takes on day `day`: its factory's squad. */
export const aiKinds = (day: number): EnemyKind[] => [...FACTORY.levels[aiFactory(day)].kinds];

/** Its last raid by `now`: when (its raids come every few hours by the clock), the cores it took (the nodes it gained since yesterday) and whether it got home. */
export function aiLast(a: AiIsland, salt: number, day: number, now: number): NonNullable<Neighbour["last"]> {
  const every = AI.every[a.slot % AI.every.length] * 3_600_000;
  const off = hash(salt, a.slot, 5) % every;
  const at = Math.floor((now - off) / every) * every + off;
  const captured = Math.max(0, aiHeld(a, salt, day) - aiHeld(a, salt, day - 1));
  return { at, captured, home: hash(salt, a.slot, day, 9) % 5 !== 0 };
}

/** Its island as a neighbour of the player on day `day`, at `now`. */
export const aiNeighbour = (a: AiIsland, salt: number, day: number, now: number): Neighbour => ({ code: a.code, name: a.name, held: aiHeld(a, salt, day), total: NODES.length, day, slot: a.slot, last: aiLast(a, salt, day, now), ai: true });

/** The server's neighbours with the game's islands in the slots it leaves free, in slot order. */
export function withAi(server: readonly Neighbour[], salt: number, day: number, now: number): Neighbour[] {
  const taken = server.map((n) => n.slot);
  return [...server, ...aiIslands(salt, taken).map((a) => aiNeighbour(a, salt, day, now))].sort((x, y) => x.slot - y.slot);
}

/** What changed on its island overnight, for the map table: the nodes it took, and those it lost. */
export function aiChanges(a: AiIsland, salt: number, day: number): { took: NodeId[]; lost: NodeId[] } {
  const now = aiNodes(a, salt, day);
  const before = aiNodes(a, salt, day - 1);
  return { took: now.filter((id) => !before.includes(id)), lost: before.filter((id) => !now.includes(id)) };
}

/**
 * Its island as anyone sees it (as `GET /api/islands/:code` would answer): its nodes, and those that
 * take an expedition (its own, and the enemy's next to them), with the player's expeditions on it
 * as they stand at `now` (by `mine`, the player's code or empty).
 */
export function aiView(a: AiIsland, salt: number, day: number, sent: readonly Outgoing[], mine: string, now: number): IslandView {
  const own = new Set<string>(aiNodes(a, salt, day));
  // A node one of the player's expeditions is on or holds takes no other (`node-busy` on the server).
  const busy = new Set<string>(sent.filter((o) => o.code === a.code && aiBusy(a, salt, o, now)).map((o) => o.node));
  const near = new Set<string>(FRONT_LINKS.flatMap((l) => (l[0] === "camp" ? [] : own.has(l[0]) && !own.has(l[1]) ? [l[1]] : own.has(l[1]) && !own.has(l[0]) ? [l[0]] : [])));
  const nodes = NODES.map((n) => ({ id: n.id as string, hold: (own.has(n.id) ? "freed" : "held") as PoiHold, open: (own.has(n.id) || near.has(n.id)) && !busy.has(n.id) }));
  const expeditions = sent
    .filter((o) => o.code === a.code && o.id > 0)
    .flatMap((o) => {
      const state = aiOutcome(a, salt, o, now);
      return state === "gone" || state === "sending" || state === "recalling" ? [] : [{ id: o.id, by: { code: mine, name: "" }, target: o.node as string, units: o.units, state: state as "coming" | "attacking" | "holding", arriveAt: o.sentAt + AI.coming * 60_000 }];
    });
  return { code: a.code, owner: a.name, day, factory: aiFactory(day), protectedUntil: 0, nodes, expeditions };
}

/**
 * How the player's expedition `o` on island `a` stands at `now`: on its way, then fighting at its
 * node, then holding it (for a time a hash of it sets, then the island takes it back) or gone, as a
 * hash of it falls against its chance. One being sent, called home or gone stays so.
 */
export function aiOutcome(a: AiIsland, salt: number, o: Outgoing, now: number): Outgoing["state"] {
  if (o.state === "sending" || o.state === "recalling" || o.state === "gone") return o.state;
  const t = (now - o.sentAt) / 60_000;
  if (t < AI.coming) return "coming";
  if (t < AI.coming + AI.fighting) return "attacking";
  const defended = NODES[nodeIndex(o.node)] && hash(salt, a.slot, nodeIndex(o.node)) % 2 === 0;
  const chance = AI.win.base + AI.win.unit * o.units - (defended ? AI.win.defended : 0) - 0.04 * (TIER[o.node] ?? 1);
  if (unit(salt, a.slot, o.id, nodeIndex(o.node), Math.floor(o.sentAt / 60_000)) >= chance) return "gone";
  const [lo, hi] = AI.hold;
  const hours = lo + (hash(salt, a.slot, o.id, 77) % (hi - lo + 1));
  return t < AI.coming + AI.fighting + hours * 60 ? "holding" : "gone";
}

/** Whether the player's expedition `o` on island `a` still takes up its node at `now`: being sent, on its way, fighting or holding. */
export const aiBusy = (a: AiIsland, salt: number, o: Outgoing, now: number): boolean => {
  const state = aiOutcome(a, salt, o, now);
  return state !== "gone" && state !== "recalling";
};

/** The player's expeditions with those on the game's islands brought up to `now`; the list itself when none changes. */
export function aiRefresh(list: Outgoing[], salt: number, taken: readonly number[], now: number): Outgoing[] {
  let out = list;
  list.forEach((o, i) => {
    const a = aiByCode(salt, o.code, taken);
    if (!a) return;
    const state = aiOutcome(a, salt, o, now);
    if (state === o.state) return;
    if (out === list) out = [...list];
    out[i] = { ...o, state };
  });
  return out;
}

/** The number the island gives the player's next expedition to it: one past the highest it has given. */
export const aiNextId = (list: readonly Outgoing[], code: string): number => Math.max(0, ...list.filter((o) => o.code === code).map((o) => o.id)) + 1;

/** What a profile tells the game's islands. */
type Seen = { day: number; poiState: Island; expeditions: readonly Outgoing[] };

/**
 * The game's island sending an expedition at the player for the raid of day `p.day`, or none: of the
 * islands whose sea route the player has opened (holding the node facing it), the first a hash of
 * the day lets go, the more often while the player's expedition is on its island. It is sent at that
 * facing node. At most one a day, none before `AI.start`.
 */
export function aiAttack(p: Seen, salt: number, taken: readonly number[]): { island: AiIsland; node: NodeId } | null {
  if (p.day < AI.start) return null;
  const holds = (id: NodeId) => p.poiState[id]?.state === "freed";
  for (const a of aiIslands(salt, taken).sort((x, y) => hash(salt, p.day, x.slot) - hash(salt, p.day, y.slot))) {
    if (!routeOpen(a.slot, holds)) continue;
    const answering = p.expeditions.some((o) => o.code === a.code && o.state !== "gone" && o.state !== "recalling");
    if (unit(salt, p.day, a.slot, 13) < (answering ? AI.answer : AI.attack)) return { island: a, node: NEIGHBOUR_SLOTS[a.slot].shore };
  }
  return null;
}

/** That expedition as the warning the camp shows (来る遠征): it lands in the next raid (no clock: the island waits for the raid). */
export function aiIncoming(p: Seen, salt: number, taken: readonly number[]): Incoming[] {
  const x = aiAttack(p, salt, taken);
  return x ? [{ id: 0, by: { code: x.island.code, name: x.island.name }, node: x.node, arriveAt: 0, state: "coming" }] : [];
}

/**
 * What the game's islands bring to the raid of day `p.day` (as a lease brings other players'
 * expeditions, `lentRivals()`): the day's expedition, and a squad standing at each node of the
 * player's island one of them holds. Its owner is `aiOwner()` of the island's code, so a node it
 * takes is held as `rival:ai-…`.
 */
export function aiLent(p: Seen, salt: number, taken: readonly number[]): LentIn[] {
  const out: LentIn[] = [];
  for (const n of NODES) {
    const owner = rivalOf(p.poiState[n.id]?.state ?? "held");
    // Every slot's: an island whose slot a player's island has since taken still holds what it took, and stands its squad there.
    const a = aiByOwner(salt, owner);
    if (a) out.push({ id: 0, by: { code: aiOwner(a.code), name: a.name }, target: n.id, kinds: aiKinds(p.day), state: "holding" });
  }
  const x = aiAttack(p, salt, taken);
  if (x && p.poiState[x.node]?.state === "freed") out.push({ id: 0, by: { code: aiOwner(x.island.code), name: x.island.name }, target: x.node, kinds: aiKinds(p.day), state: "coming" });
  return out;
}

/**
 * What the game's islands lent bring to the raid's battle (`BattleStart.rivals`): a squad holding a
 * node stands there from the start; the day's expedition comes down by dropship at the node it is
 * sent at (`near`), `AI.landAt` seconds in, rather than at the pad: from the sea that island lies over.
 */
export const aiRivals = (lent: readonly LentIn[]): RivalExpedition[] => lentRivals(lent).map((x) => (x.at > 0 ? { ...x, at: AI.landAt, near: true as const } : x));

/**
 * The raid's news of the game's islands, as the island's log would tell it (`IslandLogEntry`): each
 * node of the player's one of them took in the raid, and the day's expedition wiped out (it took
 * nothing). `before` is the profile the raid started from, `after` the settled one.
 */
export function aiRaidNews(before: Seen, after: { poiState: Island }, salt: number, taken: readonly number[], now: number): IslandLogEntry[] {
  const out: IslandLogEntry[] = [];
  const by = (a: AiIsland) => ({ code: a.code, name: a.name });
  for (const n of NODES) {
    const was = rivalOf(before.poiState[n.id]?.state ?? "held");
    const is = rivalOf(after.poiState[n.id]?.state ?? "held");
    const a = aiByOwner(salt, is);
    if (a && is !== was) out.push({ seq: 0, at: now, t: "taken", node: n.id, by: by(a) });
  }
  const x = aiAttack(before, salt, taken);
  if (x && before.poiState[x.node]?.state === "freed" && !out.some((e) => e.node === x.node)) out.push({ seq: 0, at: now, t: "wiped", node: x.node, by: by(x.island) });
  return out;
}
