import { FRONT, META, type HealKind, type Rarity } from "../sim/config";
import type { PoiHold } from "../sim/island";
import { parseHold, rivalOf } from "../sim/holds";
import { DEPOTS, NODES, POIS, poiIndex, UNLOCKS, type NodeId, type NodeUnlock, type PoiId } from "../sim/map";
import { capturedIds, nodeHolds, type NodeHold } from "../sim/front";
import { type Battle } from "../sim/battle";
import { type State } from "../sim/state";
import { CONTESTED_SHORES, ROUTE_SHORES } from "./neighbours";

/*
 * The island between raids (docs/ringfall/island-v2.md): one raid is one day, and each node is the
 * enemy's, the player's, or another player's (docs/ringfall/multiplayer.md). These are the pure rules that move the island from one
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

/**
 * The island before the first raid (2026-11-26):
 * the four sea-route shore hubs start as the player's (CoC: the village is raidable from day 1);
 * every other POI is the enemy's. Opens all neighbour routes without a robot-first capture.
 */
export const newIsland = (): Island =>
  Object.fromEntries(
    POIS.map((p) => [p.id, { state: (ROUTE_SHORES as readonly string[]).includes(p.id) ? ("own" as const) : ("foe" as const) }]),
  ) as Island;

/** All-foe island (tests / scenarios that need closed sea routes). */
export const blankIsland = (): Island => Object.fromEntries(POIS.map((p) => [p.id, { state: "foe" as const }])) as Island;

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
 * player left (the same as at the end for a raid that lasted the battle), and how many times a
 * node changed hands before and after the player left.
 */
export interface BattleDay {
  held: NodeId[];
  /** The nodes other players held as the battle ended, as it began and when the player left, and whose; each left out, none. */
  rival?: Partial<Record<NodeId, string>>;
  rivalStart?: Partial<Record<NodeId, string>>;
  rivalLeft?: Partial<Record<NodeId, string>>;
  start?: NodeId[];
  left?: NodeId[];
  turns?: { raid: number; after: number };
}

/**
 * A raid's day as the island counts it. A record of a raid kept from before visits were counted
 * has visited none. The titan fell when its pad was cleared: its fall takes the pad's other
 * robots with it. With a battle, the nodes are as the battle ended (`finishBattle()` first).
 */
export const raidDay = (s: Pick<State, "outcome" | "stats"> & { visited?: boolean[]; threat?: number; battle?: Battle | null; nodes?: NodeHold[] }): RaidDay => ({
  alive: s.outcome === "extracted",
  cleared: s.stats.cleared.map((i) => POIS[i].id),
  captured: capturedIds(s),
  battle: s.battle && s.nodes ? battleDay(s.battle, s.nodes) : undefined,
  visited: POIS.filter((_, i) => s.visited?.[i]).map((p) => p.id),
  titan: s.stats.cleared.some((i) => !!POIS[i].boss),
  threat: s.threat ?? 0,
});

/** What a battle reckoned to its end leaves for the island (`BattleDay`). */
function battleDay(b: Battle, nodes: readonly NodeHold[]): BattleDay {
  const ids = (h: readonly NodeHold[]) => NODES.filter((_, i) => h[i] === "own").map((n) => n.id);
  const leftAt = b.left?.at ?? Infinity;
  const rival = rivalNodes(nodes);
  const rivalStart = rivalNodes(b.start);
  const rivalLeft = rivalNodes(b.left?.nodes ?? nodes);
  return {
    held: ids(nodes),
    ...(Object.keys(rival).length && { rival }),
    ...(Object.keys(rivalStart).length && { rivalStart }),
    ...(Object.keys(rivalLeft).length && { rivalLeft }),
    start: ids(b.start),
    left: ids(b.left?.nodes ?? nodes),
    turns: { raid: b.taken.filter((t) => t.t < leftAt).length, after: b.taken.filter((t) => t.t >= leftAt).length },
  };
}

/** The island part of a profile that a day moves. */
export interface IslandDay {
  day: number;
  poiState: Island;
  depots: PoiId[];
  /** The next raid's seed. */
  seed?: number;
}

/** What the maps read of an island day. */
export type IslandView = Pick<IslandDay, "day" | "poiState">;

/** Each node's standing on an island day (sim/front.ts). */
export const islandHolds = (p: Pick<IslandDay, "poiState">): NodeHold[] => nodeHolds((id) => p.poiState[id].state);

/** The nodes other players hold among `holds` (`NODES` order), and whose. */
export const rivalNodes = (holds: readonly NodeHold[]): Partial<Record<NodeId, string>> => {
  const out: Partial<Record<NodeId, string>> = {};
  NODES.forEach((n, i) => {
    const who = rivalOf(holds[i]);
    if (who !== null) out[n.id] = who;
  });
  return out;
};

/** The nodes the player holds on an island day. */
export const playerNodes = (p: Pick<IslandDay, "poiState">): NodeId[] => NODES.filter((n) => p.poiState[n.id].state === "own").map((n) => n.id);

/** Freeable nodes that are not contested outer hubs (作り順②). */
export const nonContestedNodeCount = (): number => NODES.filter((n) => !CONTESTED_SHORES.includes(n.id)).length;

/** Contested coastal hubs the player holds (方向 A). */
export const contestedOwned = (p: Pick<IslandDay, "poiState">): NodeId[] => playerNodes(p).filter((id) => CONTESTED_SHORES.includes(id));

/** What the nodes the player holds open together (`UNLOCKS`): the best of each, the squads summed. */
export function unlocked(p: Pick<IslandDay, "poiState">): Required<Pick<NodeUnlock, "shop" | "squad" | "scout" | "shore">> & { depart: NodeId[]; heals: HealKind[]; turret: number } {
  const mine = playerNodes(p).map((id) => ({ id, u: UNLOCKS[id] }));
  return {
    shop: Math.max(META.shopRarity, ...mine.map(({ u }) => u.shop ?? 0)) as Rarity,
    squad: mine.reduce((n, { u }) => n + (u.squad ?? 0), 0),
    scout: mine.some(({ u }) => u.scout),
    shore: mine.some(({ u }) => u.shore),
    depart: mine.filter(({ u }) => u.depart).map(({ id }) => id),
    heals: mine.flatMap(({ u }) => (u.heal ? [u.heal] : [])),
    turret: mine.reduce((n, { u }) => n + (u.turret ?? 0), 0),
  } as ReturnType<typeof unlocked>;
}

/** The best rarity of weapon and tier of armour the trader sells: what the nodes held open (`UNLOCKS`). */
export const shopRarity = (p: Pick<IslandDay, "poiState">): Rarity => unlocked(p).shop;

/** The depots a raid may start from: those on at the nodes held that open a start there (`UNLOCKS`). */
export const departDepots = (p: Pick<IslandDay, "poiState" | "depots">): PoiId[] => {
  const may = unlocked(p).depart;
  return p.depots.filter((d) => may.includes(d as NodeId));
};

/** Nodes that turned the player's and nodes the enemy took. */
export interface FrontChange {
  gained: NodeId[];
  lost: NodeId[];
}

/**
 * What moved from one day to the next: the nodes that turned the player's (`gained`) and those
 * the enemy took (`lost`), all told (`front`), and in turn: in the raid while the player was out
 * (`raid`) and in the battle after they left (`after`).
 * `gained` is the overnight gain of nodes (not POI 掃討's `poiState: "own"`).
 */
export interface DayChange {
  /** The nodes other players held as the day began, when the player left the battle, and as it ended; left out when there were none. */
  rivals?: { start: Partial<Record<NodeId, string>>; left: Partial<Record<NodeId, string>>; end: Partial<Record<NodeId, string>> };
  /** Nodes that became the player's overnight (same list as `front.gained`). */
  gained: NodeId[];
  front: FrontChange;
  raid: FrontChange;
  after: FrontChange;
}

/** The nodes that changed hands between two sets of the player's nodes. */
const changeOf = (from: readonly NodeId[], to: readonly NodeId[]): FrontChange => ({ gained: to.filter((id) => !from.includes(id)), lost: from.filter((id) => !to.includes(id)) });

/**
 * What the overnight pass would do to `p` after raid `r`: the next day's island fields and the
 * nodes that changed hands. `settle()` reads the change first (`dayChange`) while the stash is
 * still being packed, then applies the same pass once (`advanceDay`) to the settled profile.
 */
function reckonOvernight<P extends IslandDay>(p: P, r: RaidDay): { profile: P; change: DayChange } {
  const today = p.day;
  const before = islandHolds(p);
  const was = NODES.filter((_, i) => before[i] === "own").map((n) => n.id);
  const ended = r.battle ? r.battle.held : [...was, ...(r.captured ?? [])];
  const rival: Partial<Record<NodeId, string>> = r.battle ? (r.battle.rival ?? {}) : rivalNodes(before);
  const mine = new Set(ended);
  const standing = (id: PoiId): PoiHold => {
    if (unfreeable(id)) return "foe";
    if (mine.has(id as NodeId)) return "own";
    const who = rival[id as NodeId];
    return who !== undefined ? `rival:${who}` : "foe";
  };
  const poiState = Object.fromEntries(POIS.map((o) => [o.id, { state: standing(o.id) }])) as Island;
  const after = islandHolds({ poiState });
  const gained = NODES.filter((_, i) => before[i] !== "own" && after[i] === "own").map((n) => n.id);
  const lost = NODES.filter((_, i) => before[i] === "own" && after[i] !== "own").map((n) => n.id);
  const depots = DEPOTS.map((d) => d.poi).filter((id) => p.depots.includes(id) || poiState[id].state === "own");
  return {
    profile: { ...p, day: today + 1, poiState, depots },
    change: {
      gained,
      front: { gained, lost },
      raid: changeOf(r.battle?.start ?? was, r.battle?.left ?? ended),
      after: changeOf(r.battle?.left ?? ended, ended),
      ...rivalBeats(r.battle ? (r.battle.rivalStart ?? {}) : rivalNodes(before), r.battle ? (r.battle.rivalLeft ?? {}) : rivalNodes(after), rivalNodes(after)),
    },
  };
}

/**
 * The overnight change alone: which nodes the player gained or lost after raid `r`, without
 * writing the next day onto the profile. Used when settle needs the list (contracts, `freedAt`)
 * before the stash is packed onto today's island.
 */
export const dayChange = (p: IslandDay, r: RaidDay): DayChange => reckonOvernight(p, r).change;

/**
 * Ends the day `p.day` with the raid `r` and starts the next. With a battle, each node stays
 * with whoever held it as the battle ended: the nodes the player took (by their cores or with
 * their robots) and the nodes the enemy's squads took back alike, other players' as well. Without
 * one, a node whose core the raid captured is the player's, and other players keep the rest of
 * theirs. Clearing a POI of its robots takes nothing. The titan's pad is the enemy's for good.
 * A node the player holds has its depot on.
 */
export function advanceDay<P extends IslandDay>(p: P, r: RaidDay): { profile: P; change: DayChange } {
  return reckonOvernight(p, r);
}

/** The day's other players' nodes beat by beat (`DayChange.rivals`), or nothing when there were none. */
const rivalBeats = (start: Partial<Record<NodeId, string>>, left: Partial<Record<NodeId, string>>, end: Partial<Record<NodeId, string>>): Pick<DayChange, "rivals"> =>
  Object.keys(start).length || Object.keys(left).length || Object.keys(end).length ? { rivals: { start, left, end } } : {};

/** Credits paid at the settle for every node the player holds: `FRONT.income` each (not only the front). */
export const heldIncome = (p: Pick<IslandDay, "poiState">): number => playerNodes(p).length * FRONT.income;

/** Each POI's standing for a raid's start (`Start.island`). */
export const holds = (p: Pick<IslandDay, "poiState">): Partial<Record<PoiId, PoiHold>> => Object.fromEntries(POIS.map((o) => [o.id, p.poiState[o.id].state]));

/** Node holds in `NODES` order from an island save. */
export const holdsOf = (poiState: Island): PoiHold[] => NODES.map((n) => poiState[n.id]?.state ?? "foe");

/** A saved island; anything unreadable is the enemy's. A POI saved thin is the player's (the enemy held it only thinly); the titan's pad is always the enemy's. Another player's standing is kept as saved where `rivals` (a save that can hold one), else it is the enemy's. */
export function parseIsland(raw: unknown, rivals = true): Island {
  const out = blankIsland();
  if (!raw || typeof raw !== "object") return out;
  const o = raw as Record<string, unknown>;
  for (const { id } of POIS) {
    const x = o[id] as Record<string, unknown> | undefined;
    if (!x || typeof x !== "object" || unfreeable(id)) continue;
    const h = x.state === "thin" ? "own" : (parseHold(x.state) ?? "foe");
    out[id] = { state: !rivals && rivalOf(h) !== null ? "foe" : h };
  }
  return out;
}
