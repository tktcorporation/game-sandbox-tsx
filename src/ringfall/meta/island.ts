import { EVENTS, FACTORY, FACTORY_TOP, FRONT, META, NIGHT, type EventKind, type Rarity } from "../sim/config";
import type { IslandEvent, PoiHold } from "../sim/island";
import { DEBRIS_SPOTS, debrisIndex, DEPOTS, NET_EDGE, NODES, POIS, poiIndex, UNLOCKS, type DebrisId, type NodeId, type NodeUnlock, type PoiId } from "../sim/map";
import { capturedIds, NEIGHBOURS, nodeHolds, type NodeHold } from "../sim/front";
import { guardedNodes, type Battle } from "../sim/battle";
import { mix, type State } from "../sim/state";

/*
 * The island between raids (docs/ringfall/island-v2.md): one raid is one day, and each of the six
 * nodes is the enemy's or the player's. These are the pure rules that move the island from one
 * day to the next; the raid reads the result as each POI's garrison (sim/island.ts) and each
 * node's standing on the front (sim/front.ts).
 */

/** A POI's standing: who holds it. */
export interface PoiStanding {
  state: PoiHold;
}

export type Island = Record<PoiId, PoiStanding>;

/** The POI the titan holds: it is never the player's, and killing the titan does not change it. */
export const unfreeable = (id: PoiId) => !!POIS[poiIndex(id)].boss;

/** The island before the first raid: every POI the enemy's. */
export const newIsland = (): Island => Object.fromEntries(POIS.map((p) => [p.id, { state: "held" }])) as Island;

/**
 * What one raid did to the island: whether the player got off alive, the POIs cleared of robots,
 * the nodes taken by their cores, those come into, whether the titan fell, and the day's battle.
 */
export interface RaidDay {
  alive: boolean;
  cleared: PoiId[];
  /** Nodes whose core the raid captured (`NODES` ids). */
  captured?: NodeId[];
  visited: PoiId[];
  titan: boolean;
  /** The threat the raid was played at (`THREAT`); left out, 0. */
  threat?: number;
  /** The day's battle (sim/battle.ts), reckoned to its end; left out, the raid had none. */
  battle?: BattleDay;
}

/**
 * What the day's battle left: the nodes the player held at its end, at its start and when the
 * player left (the same as at the end for a raid that lasted the battle), the nodes the player's
 * squads stood at as it ended, the factory it was fought with, the raid's seed, and how many times
 * a node changed hands before and after the player left.
 */
export interface BattleDay {
  held: NodeId[];
  start?: NodeId[];
  left?: NodeId[];
  guarded?: NodeId[];
  factory?: number;
  seed?: number;
  turns?: { raid: number; after: number };
}

/**
 * A raid's day as the island counts it. A record of a raid kept from before visits were counted
 * has visited none. The titan fell when its pad was cleared: its fall takes the pad's other
 * robots with it. With a battle, the nodes are as the battle ended (`finishBattle()` first).
 */
export const raidDay = (s: Pick<State, "outcome" | "stats"> & { visited?: boolean[]; threat?: number; battle?: Battle | null; nodes?: NodeHold[]; seed?: number }): RaidDay => ({
  alive: s.outcome === "extracted",
  cleared: s.stats.cleared.map((i) => POIS[i].id),
  captured: capturedIds(s),
  battle: s.battle && s.nodes ? battleDay(s.battle, s.nodes, s.seed ?? 0) : undefined,
  visited: POIS.filter((_, i) => s.visited?.[i]).map((p) => p.id),
  titan: s.stats.cleared.some((i) => !!POIS[i].boss),
  threat: s.threat ?? 0,
});

/** What a battle reckoned to its end leaves for the island (`BattleDay`). */
function battleDay(b: Battle, nodes: readonly NodeHold[], seed: number): BattleDay {
  const ids = (h: readonly NodeHold[]) => NODES.filter((_, i) => h[i] === "freed").map((n) => n.id);
  const leftAt = b.left?.at ?? Infinity;
  return {
    held: ids(nodes),
    start: ids(b.start),
    left: ids(b.left?.nodes ?? nodes),
    guarded: guardedNodes(b).map((i) => NODES[i].id),
    factory: b.factory,
    seed,
    turns: { raid: b.taken.filter((t) => t.t < leftAt).length, after: b.taken.filter((t) => t.t >= leftAt).length },
  };
}

/** The island part of a profile that a day moves. */
export interface IslandDay {
  day: number;
  poiState: Island;
  depots: PoiId[];
  /** The next raid's seed: the day after tomorrow's event is drawn from it and the day. */
  seed?: number;
  /** The island's events: today's (the next raid's) and tomorrow's, announced a day ahead. */
  events?: DayEvents;
}

/** What the maps read of an island day. */
export type IslandView = Pick<IslandDay, "day" | "poiState">;

/** Each node's standing on an island day (sim/front.ts). */
export const islandHolds = (p: Pick<IslandDay, "poiState">): NodeHold[] => nodeHolds((id) => p.poiState[id].state);

/** The nodes the player holds on an island day. */
export const playerNodes = (p: Pick<IslandDay, "poiState">): NodeId[] => NODES.filter((n) => p.poiState[n.id].state === "freed").map((n) => n.id);

/** What the nodes the player holds open together (`UNLOCKS`): the best of each, the squads summed. */
export function unlocked(p: Pick<IslandDay, "poiState">): Required<Omit<NodeUnlock, "depart">> & { depart: NodeId[] } {
  const mine = playerNodes(p).map((id) => ({ id, u: UNLOCKS[id] }));
  return {
    shop: Math.max(META.shopRarity, ...mine.map(({ u }) => u.shop ?? 0)) as Rarity,
    squad: mine.reduce((n, { u }) => n + (u.squad ?? 0), 0),
    scout: mine.some(({ u }) => u.scout),
    shore: mine.some(({ u }) => u.shore),
    depart: mine.filter(({ u }) => u.depart).map(({ id }) => id),
  } as Required<Omit<NodeUnlock, "depart">> & { depart: NodeId[] };
}

/** The best rarity of weapon and tier of armour the trader sells: what the nodes held open (`UNLOCKS`). */
export const shopRarity = (p: Pick<IslandDay, "poiState">): Rarity => unlocked(p).shop;

/** The depots a raid may start from: those on at the nodes held that open a start there (`UNLOCKS`). */
export const departDepots = (p: Pick<IslandDay, "poiState" | "depots">): PoiId[] => {
  const may = unlocked(p).depart;
  return p.depots.filter((d) => may.includes(d as NodeId));
};

/** Today's event and tomorrow's: each null on a quiet day. */
export type DayEvents = [IslandEvent | null, IslandEvent | null];

/** Nodes that turned the player's and nodes the enemy took. */
export interface FrontChange {
  gained: NodeId[];
  lost: NodeId[];
}

/**
 * What moved from one day to the next: the nodes that turned the player's (`gained`, POIs as
 * `freed` too) and those the enemy took (`lost`), all told (`front`), and in turn: in the raid
 * while the player was out (`raid`), in the battle after they left (`after`), and in the night (`night`).
 */
export interface DayChange {
  freed: PoiId[];
  front: FrontChange;
  raid: FrontChange;
  after: FrontChange;
  night: FrontChange;
}

/** The nodes that changed hands between two sets of the player's nodes. */
const changeOf = (from: readonly NodeId[], to: readonly NodeId[]): FrontChange => ({ gained: to.filter((id) => !from.includes(id)), lost: from.filter((id) => !to.includes(id)) });

/**
 * The night's attacks (`NIGHT`): each node of `held` next to the enemy's ground (a node not in
 * `held`, or the landing ground of `NET_EDGE`) falls with a chance that grows with those
 * neighbours and shrinks while the player's squads guard it and with the factory's level, drawn
 * from `seed` and `day`. The nodes that fall, at most `NIGHT.max`, in `NODES` order.
 */
export function nightRaids(held: readonly NodeId[], guarded: readonly NodeId[], factory: number, seed: number, day: number): NodeId[] {
  const out: NodeId[] = [];
  NODES.forEach((n, i) => {
    if (!held.includes(n.id) || out.length >= NIGHT.max) return;
    const foes = NEIGHBOURS[i].filter((k) => !held.includes(NODES[k].id)).length + (NET_EDGE.includes(n.id) ? 1 : 0);
    if (!foes) return;
    // The more of the island the player holds, the more of the enemy's strength falls on what is left of the front.
    const spread = NIGHT.spread + held.length / NODES.length;
    const chance = NIGHT.chance[Math.min(foes, NIGHT.chance.length) - 1] * spread * (guarded.includes(n.id) ? NIGHT.guarded : 1) * FACTORY.levels[Math.max(0, Math.min(FACTORY_TOP, factory))].night;
    if ((dayHash(seed, day, 100 + i) % 10_000) / 10_000 < chance) out.push(n.id);
  });
  return out;
}

/**
 * Ends the day `p.day` with the raid `r` and starts the next. With a battle, each node stays
 * with whoever held it as the battle ended: the nodes the player took (by their cores or with
 * their robots) and the nodes the enemy's squads took back alike. Without one, a node whose core
 * the raid captured is the player's. Clearing a POI of its robots takes nothing. The titan's pad
 * is the enemy's for good. A node the player holds has its depot on.
 */
export function advanceDay<P extends IslandDay>(p: P, r: RaidDay): { profile: P; change: DayChange } {
  const today = p.day;
  const before = islandHolds(p);
  const was = NODES.filter((_, i) => before[i] === "freed").map((n) => n.id);
  const ended = r.battle ? r.battle.held : [...was, ...(r.captured ?? [])];
  // The night: the enemy comes at the nodes next to its ground (a raid with no battle has no night).
  const fell = r.battle ? nightRaids(ended, r.battle.guarded ?? [], r.battle.factory ?? 0, r.battle.seed ?? 0, today) : [];
  const mine = new Set<NodeId>(ended.filter((id) => !fell.includes(id)));
  const poiState = Object.fromEntries(POIS.map((o) => [o.id, { state: !unfreeable(o.id) && mine.has(o.id as NodeId) ? "freed" : "held" }])) as Island;
  const after = islandHolds({ poiState });
  const gained = NODES.filter((_, i) => before[i] !== "freed" && after[i] === "freed").map((n) => n.id);
  const lost = NODES.filter((_, i) => before[i] === "freed" && after[i] !== "freed").map((n) => n.id);
  const depots = DEPOTS.map((d) => d.poi).filter((id) => p.depots.includes(id) || poiState[id].state === "freed");
  // Yesterday's forecast becomes today's event, and tomorrow's is drawn.
  const events: DayEvents = [p.events?.[1] ?? null, eventFor(p.seed ?? 0, today + 2)];
  return {
    profile: { ...p, day: today + 1, poiState, depots, events },
    change: {
      freed: gained,
      front: { gained, lost },
      raid: changeOf(r.battle?.start ?? was, r.battle?.left ?? ended),
      after: changeOf(r.battle?.left ?? ended, ended),
      night: changeOf(ended, [...mine]),
    },
  };
}

/** The credits the island pays at the settle for the nodes the player holds: `FRONT.income` each. */
export const frontIncome = (p: Pick<IslandDay, "poiState">): number => playerNodes(p).length * FRONT.income;

/** A hash of the seed, the day and a salt: the event schedule draws on nothing else. */
const dayHash = (seed: number, day: number, k: number) => mix(Math.imul(seed + 1, 0x9e3779b1) ^ Math.imul(day + 11, 0x85ebca6b) ^ Math.imul(k + 1, 0xc2b2ae35));

/** The event of day `day`, drawn from `seed` and the day: one day in `1 / EVENTS.chance` or so has one, picked by `EVENTS.weights`. */
export function eventFor(seed: number, day: number): IslandEvent | null {
  if ((dayHash(seed, day, 0) % 10_000) / 10_000 >= EVENTS.chance) return null;
  const weights = (Object.keys(EVENTS.weights) as EventKind[]).map((k): [EventKind, number] => [k, EVENTS.weights[k]]).filter(([, w]) => w > 0);
  let r = ((dayHash(seed, day, 1) % 10_000) / 10_000) * weights.reduce((n, [, w]) => n + w, 0);
  const kind = weights.find(([, w]) => (r -= w) < 0)?.[0] ?? weights[weights.length - 1][0];
  switch (kind) {
    case "debris":
      return { t: "debris", spot: DEBRIS_SPOTS[dayHash(seed, day, 2) % DEBRIS_SPOTS.length].id };
    case "storm":
      return { t: "storm" };
    case "crews":
      return { t: "crews" };
  }
}

/** The schedule of a profile before the first raid: a quiet first day, and the second's drawn. */
export const firstEvents = (seed: number): DayEvents => [null, eventFor(seed, 2)];

/** A saved event; null for anything unreadable. */
export function parseEvent(raw: unknown): IslandEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const x = raw as Record<string, unknown>;
  if (x.t === "storm" || x.t === "crews") return { t: x.t };
  if (x.t === "debris" && typeof x.spot === "string" && debrisIndex(x.spot as DebrisId) >= 0) return { t: "debris", spot: x.spot as DebrisId };
  return null;
}

/** An event's name. */
export const eventName = (ev: IslandEvent) => EVENTS.names[ev.t];

/** What an event does, in a line. */
export function eventText(ev: IslandEvent): string {
  switch (ev.t) {
    case "debris": {
      const d = DEBRIS_SPOTS[debrisIndex(ev.spot)];
      return `${d.place}に輪の破片が落ちる。珍しい回収品の箱を、ヘビーとドローン 2 機が守る`;
    }
    case "storm":
      return "自分の視界も、ロボットの見える距離も 6 割になる。近づいてから撃つ日";
    case "crews":
      return "回収部隊が 1 組来て、箱を先に漁る。迎撃の依頼が出る";
  }
}

/** Each POI's standing for a raid's start (`Start.island`). */
export const holds = (p: Pick<IslandDay, "poiState">): Partial<Record<PoiId, PoiHold>> => Object.fromEntries(POIS.map((o) => [o.id, p.poiState[o.id].state]));

/** A saved island; anything unreadable is the enemy's. A POI saved thin is the player's (the enemy held it only thinly); the titan's pad is always the enemy's. */
export function parseIsland(raw: unknown): Island {
  const out = newIsland();
  if (!raw || typeof raw !== "object") return out;
  const o = raw as Record<string, unknown>;
  for (const { id } of POIS) {
    const x = o[id] as Record<string, unknown> | undefined;
    if (!x || typeof x !== "object" || unfreeable(id)) continue;
    out[id] = { state: x.state === "freed" || x.state === "thin" ? "freed" : "held" };
  }
  return out;
}
