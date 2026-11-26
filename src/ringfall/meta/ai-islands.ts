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
import { FACTORY, FACTORY_TOP, type EnemyKind, type ValuableKind } from "../sim/config";
import { aiOwner, isAiOwner, rivalHold, rivalOf, type PoiHold } from "../sim/holds";
import { DEPOTS, FRONT_LINKS, NODES, TIER, nodeIndex, type NodeId, type PoiId } from "../sim/map";
import { CODE_ALPHABET, CODE_LENGTH } from "./island-code";
import { lentRivals, type Incoming, type IslandLogEntry, type IslandView, type LentIn, type Outgoing } from "./expeditions";
import { LOCAL_AID, type Parcel } from "./parcels";
import type { RivalExpedition } from "../sim/battle";
import { aiLabel, CONTESTED_SHORES, NEIGHBOUR_MAX, NEIGHBOUR_SLOTS, routeOpen, type Neighbour } from "./neighbours";
import { TROPHY, clampTrophies } from "./trophies";
import type { Island } from "./island";
import { canLoseOuter, OUTER_GUARD, type OuterGuard } from "./outer-guard";

/** The numbers of the game's islands. */
export const AI = {
  /** Seconds into the raid's battle the day's expedition comes down by its node: time to read the warning and get there. */
  landAt: 240,
  /** The first day the facing island may send its scout (2026-11-26: day 1 — shores start held). */
  scoutDay: 1,
  scout: ["grunt", "grunt"] as EnemyKind[],
  /**
   * The first day a facing island may send a regular expedition (2026-11-26: day 1).
   * Was 4 when shores had to be captured first; with starting shores the delay only postponed first contact.
   */
  start: 1,
  /**
   * Chance a day that an open-route island sends an expedition (2026-11-26 early-MP: was 0.22).
   * Slightly higher so day-1 contact is more often felt after the scout.
   */
  attack: 0.3,
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

/**
 * AI owners' names (TKT-204 案 G): a pool that does not overlap common player short names
 * (旧: ツバキ / ミナト / スバル など). Display always adds 「 · AI」 via `aiLabel()` in copy.ts.
 * A few a slot; the salt picks one. Similar length so the cards keep their size.
 */
const NAMES: readonly (readonly string[])[] = [
  ["カゲウツ", "イソナミ", "オキカゼ"],
  ["ヤマビコ", "サワタリ", "ホシクズ"],
  ["クロサキ", "キンロウ", "ギンカゼ"],
  ["アラシヤマ", "シオサイ", "カスミメ"],
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

/**
 * Contested outer hubs seeded as AI footholds on a new profile (2026-11-26 early-MP).
 * Each is on the front when the four `ROUTE_SHORES` are own, so 「攻める」lists them from day 1.
 * powerplant faces robotworks (slot 2); fuel faces station (slot 0).
 */
export const START_FOOTHOLDS: readonly { id: NodeId; slot: number }[] = [
  { id: "powerplant", slot: 2 },
  { id: "fuel", slot: 0 },
];

/** Apply day-1 rival footholds for `salt` (new profiles only — never rewrite a loaded save). */
export function withStartingFootholds(island: Island, salt: number): Island {
  const out: Island = { ...island };
  for (const f of START_FOOTHOLDS) {
    const a = aiIsland(salt, f.slot);
    out[f.id] = { state: rivalHold(aiOwner(a.code)) };
  }
  return out;
}

/**
 * Rewrite AI owners on `START_FOOTHOLDS` to match the browser neighbour salt (`aiSalt`).
 * Profile seed ≠ identity salt, so `newProfile` footholds must be realigned on load
 * (Codex P2 / 2026-11-26). Leaves human rivals and retaken hubs alone.
 */
export function realignStartingFootholds(island: Island, salt: number): Island {
  let out: Island | null = null;
  for (const f of START_FOOTHOLDS) {
    const cur = island[f.id]?.state ?? "foe";
    const who = rivalOf(cur);
    if (!who || !isAiOwner(who)) continue;
    const want = rivalHold(aiOwner(aiIsland(salt, f.slot).code));
    if (cur === want) continue;
    if (!out) out = { ...island };
    out[f.id] = { state: want };
  }
  return out ?? island;
}

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

/**
 * Ranking standings for an AI neighbour: near `TROPHY.start`, nudged by how many nodes it holds
 * so the map can show a number beside the name (お隣の組み合わせは本物の島のトロフィーで組む).
 */
export const aiTrophies = (a: AiIsland, salt: number, day: number): number =>
  clampTrophies(TROPHY.start + (aiHeld(a, salt, day) - AI.held.first) * 20 + ((hash(salt, a.slot, 41) % 41) - 20));

/** Its island as a neighbour of the player on day `day`, at `now`. */
export const aiNeighbour = (a: AiIsland, salt: number, day: number, now: number): Neighbour => ({
  code: a.code,
  name: a.name,
  held: aiHeld(a, salt, day),
  total: NODES.length,
  day,
  slot: a.slot,
  factory: aiFactory(day),
  trophies: aiTrophies(a, salt, day),
  last: aiLast(a, salt, day, now),
  ai: true,
});

const nodeSalt = (id: string) => {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0;
  return h >>> 0;
};

/**
 * AI islands' 島の守り at depots on nodes they hold (for contested-coast defence views).
 * `taken` lists parcel ids already seized from this island in older saves.
 */
export function aiDefenceParcels(a: AiIsland, salt: number, day: number, held: readonly NodeId[], taken: readonly number[] = []): Parcel[] {
  const gone = new Set(taken);
  const pool: ValuableKind[] = ["parts", "fuse", "board"];
  const out: Parcel[] = [];
  held.forEach((id, n) => {
    if (!DEPOTS.some((d) => d.poi === id)) return;
    const pid = 1 + ((Math.imul(salt ^ 0x85ebca6b, a.slot + 1) >>> 0) % 90_000) + n;
    if (gone.has(pid)) return;
    const kind = pool[(Math.imul(salt + day, nodeSalt(id) + 1) >>> 0) % pool.length]!;
    out.push({ id: pid, poi: id as PoiId, kind, from: { code: LOCAL_AID, name: a.name }, at: 0 });
  });
  return out;
}

/** The server's neighbours with the game's islands in the slots it leaves free, in slot order. */
export function withAi(server: readonly Neighbour[], salt: number, day: number, now: number): Neighbour[] {
  const taken = server.map((n) => n.slot);
  return [...server, ...aiIslands(salt, taken).map((a) => aiNeighbour(a, salt, day, now))].sort((x, y) => x.slot - y.slot);
}

/** What changed on its island overnight: the nodes it took, and those it lost. */
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
export function aiView(
  a: AiIsland,
  salt: number,
  day: number,
  sent: readonly Outgoing[],
  mine: string,
  now: number,
  /** Parcel ids already removed from this island's defence stock (legacy saves). */
  seized: readonly number[] = [],
): IslandView {
  const own = new Set<string>(aiNodes(a, salt, day));
  // A node one of the player's expeditions is on or holds takes no other (`node-busy` on the server).
  const busy = new Set<string>(sent.filter((o) => o.code === a.code && aiBusy(a, salt, o, now)).map((o) => o.node));
  const near = new Set<string>(FRONT_LINKS.flatMap((l) => (l[0] === "camp" ? [] : own.has(l[0]) && !own.has(l[1]) ? [l[1]] : own.has(l[1]) && !own.has(l[0]) ? [l[0]] : [])));
  const nodes = NODES.map((n) => ({ id: n.id as string, hold: (own.has(n.id) ? "own" : "foe") as PoiHold, open: (own.has(n.id) || near.has(n.id)) && !busy.has(n.id) }));
  const expeditions = sent
    .filter((o) => o.code === a.code && o.id > 0)
    .flatMap((o) => {
      const state = aiOutcome(a, salt, o, now);
      return state === "gone" || state === "sending" || state === "recalling" ? [] : [{ id: o.id, by: { code: mine, name: "" }, target: o.node as string, units: o.units, state: state as "coming" | "attacking" | "holding", arriveAt: o.sentAt + AI.coming * 60_000 }];
    });
  const held = aiNodes(a, salt, day);
  const parcels = aiDefenceParcels(a, salt, day, held, seized);
  return {
    code: a.code,
    owner: aiLabel(a.name),
    day,
    factory: aiFactory(day),
    protectedUntil: 0,
    shieldUntil: 0,
    outerLost: 0,
    outerLossCap: OUTER_GUARD.lossCap,
    nodes,
    expeditions,
    pings: [],
    parcels,
  };
}

/**
 * How the player's expedition `o` on island `a` stands at `now`: on its way, then fighting at its
 * node, then holding it (for a time a hash of it sets, then the island takes it back) or gone, as a
 * hash of it falls against its chance. One being sent, called home or gone stays so.
 */
export function aiOutcome(a: AiIsland, salt: number, o: Outgoing, now: number): Outgoing["state"] {
  if (o.state === "sending" || o.state === "recalling" || o.state === "gone") return o.state;
  if (o.x2) return "gone";
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
  if (o.x2) return false;
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
 * islands whose sea route is open (player holds the facing shore — new profiles start with all four),
 * the first a hash of the day lets go, the more often while the player's expedition is on its island.
 * At most one a day, none before `AI.start` (1); while the player has not `scouted`, the first facing
 * island sends its scout (`AI.scout`) at once from `AI.scoutDay`.
 */
export function aiAttack(p: Seen & { outerGuard?: OuterGuard }, salt: number, taken: readonly number[], scouted = true): { island: AiIsland; node: NodeId; scout?: true } | null {
  // 作り順③: island shield / loss cap — no further AI takes while protected.
  if (!canLoseOuter(p.outerGuard, Date.now())) return null;
  const holds = (id: NodeId) => p.poiState[id]?.state === "own";
  // First scout once a facing route is open (from scoutDay; new profiles have all four open).
  if (!scouted && p.day >= AI.scoutDay) {
    const a = aiIslands(salt, taken).find((x) => routeOpen(x.slot, holds));
    if (a) return { island: a, node: NEIGHBOUR_SLOTS[a.slot].shore, scout: true };
  }
  if (p.day < AI.start) return null;
  // One draw a day for all of them, however many face the player's ground: about one day in five,
  // one in two while the player's expedition is on one of them; then the island it falls to (one
  // being answered first).
  const open = aiIslands(salt, taken).filter((a) => routeOpen(a.slot, holds));
  if (!open.length) return null;
  const answered = open.filter((a) => p.expeditions.some((o) => o.code === a.code && o.state !== "gone" && o.state !== "recalling"));
  if (unit(salt, p.day, 13) >= (answered.length ? AI.answer : AI.attack)) return null;
  const pool = answered.length ? answered : open;
  const a = pool[hash(salt, p.day, 17) % pool.length];
  return { island: a, node: NEIGHBOUR_SLOTS[a.slot].shore };
}

/** That expedition as the warning the camp shows (来る遠征): it lands in the next raid (no clock: the island waits for the raid). */
export function aiIncoming(p: Seen, salt: number, taken: readonly number[], scouted = true): Incoming[] {
  const x = aiAttack(p, salt, taken, scouted);
  return x ? [{ id: 0, by: { code: x.island.code, name: aiLabel(x.island.name) }, node: x.node, arriveAt: 0, state: "coming" }] : [];
}

/**
 * What the game's islands bring to the raid of day `p.day` (as a lease brings other players'
 * expeditions, `lentRivals()`): the day's expedition, and a squad standing at each node of the
 * player's island one of them holds. Its owner is `aiOwner()` of the island's code, so a node it
 * takes is held as `rival:ai-…`.
 */
export function aiLent(p: Seen, salt: number, taken: readonly number[], scouted = true): LentIn[] {
  const out: LentIn[] = [];
  for (const n of NODES) {
    const owner = rivalOf(p.poiState[n.id]?.state ?? "foe");
    // Contested coastal hubs stand 工場 + 島の守り as POI garrison (`Start.defence`), not a battle holding squad.
    if (CONTESTED_SHORES.includes(n.id)) continue;
    // Every slot's: an island whose slot a player's island has since taken still holds what it took, and stands its squad there.
    const a = aiByOwner(salt, owner);
    if (a) out.push({ id: 0, by: { code: aiOwner(a.code), name: aiLabel(a.name) }, target: n.id, kinds: aiKinds(p.day), state: "holding" });
  }
  const x = aiAttack(p, salt, taken, scouted);
  if (x && p.poiState[x.node]?.state === "own")
    out.push({
      id: 0,
      by: { code: aiOwner(x.island.code), name: aiLabel(x.island.name) },
      target: x.node,
      kinds: x.scout ? [...AI.scout] : aiKinds(p.day),
      state: "coming",
    });
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
export function aiRaidNews(before: Seen, after: { poiState: Island }, salt: number, taken: readonly number[], now: number, scouted = true): IslandLogEntry[] {
  const out: IslandLogEntry[] = [];
  // News / defence log: always 「名前 · AI」 so it never looks like a real player (TKT-204 案 G).
  const by = (a: AiIsland) => ({ code: a.code, name: aiLabel(a.name) });
  for (const n of NODES) {
    const was = rivalOf(before.poiState[n.id]?.state ?? "foe");
    const is = rivalOf(after.poiState[n.id]?.state ?? "foe");
    const a = aiByOwner(salt, is);
    if (a && is !== was) out.push({ seq: 0, at: now, t: "taken", node: n.id, by: by(a) });
  }
  const x = aiAttack(before, salt, taken, scouted);
  if (x && before.poiState[x.node]?.state === "own" && !out.some((e) => e.node === x.node)) out.push({ seq: 0, at: now, t: "wiped", node: x.node, by: by(x.island) });
  return out;
}
