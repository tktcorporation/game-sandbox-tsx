import { ISLAND, NETWORK, THREAT } from "./config";
import { PACKS, POIS, REGIONS, regionHere, type DebrisId, type PoiId, type Squad } from "./map";
import { mix } from "./state";

/*
 * What a POI's standing on the island (meta/island.ts) means inside a raid: how many of its
 * robots stand there. The rules that move a POI from one standing to another live in the meta.
 */

/** Who holds a POI: the robots in full (支配), the robots thinly (手薄), or the player (解放). */
export type PoiHold = "held" | "thin" | "freed";

export const HOLD_NAME: Record<PoiHold, string> = { held: "支配", thin: "手薄", freed: "解放" };

/** The squad guarding a POI's vault: the one with a member in armour plate. */
export const isVaultGuard = (sq: Squad) => sq.members.some((m) => m.plate !== undefined);

/**
 * The squads of POI `poi` that stand in a raid from `seed`: all of them while it is held, none
 * once freed. A thin POI keeps its vault guard and enough of the others, picked from the seed
 * without drawing on the raid's random numbers, to make `ISLAND.thinKeep` of its squads.
 */
export function garrison(poi: number, hold: PoiHold, seed: number): Squad[] {
  const all = POIS[poi].squads;
  if (hold === "held") return all;
  if (hold === "freed") return [];
  const keep = Math.max(1, Math.ceil(all.length * ISLAND.thinKeep));
  const guard = all.filter(isVaultGuard);
  const rest = all
    .map((sq, i) => ({ sq, h: mix(Math.imul(seed + 1, 0x9e3779b1) ^ Math.imul(poi + 1, 0x85ebca6b) ^ Math.imul(i + 1, 0xc2b2ae35)) }))
    .filter(({ sq }) => !isVaultGuard(sq))
    .sort((a, b) => a.h - b.h)
    .map(({ sq }) => sq);
  const kept = new Set([...guard, ...rest].slice(0, Math.max(keep, guard.length)));
  // In authored order, so the squads come up in the raid as they would held.
  return all.filter((sq) => kept.has(sq));
}

/** A hash of the raid's seed and a salt, for choices that must not draw on the raid's random numbers. */
const seeded = (seed: number, salt: number, k: number) => mix(Math.imul(seed + 1, 0x9e3779b1) ^ Math.imul(salt, 0x85ebca6b) ^ Math.imul(k + 1, 0xc2b2ae35));

/**
 * The drone packs flying in a raid from `seed` at network `level`: in each region, as many of
 * its packs as the level gives, picked from the seed. All of them at the levels that fly every pack.
 */
export function activePacks(seed: number, level: number): Squad[] {
  const want = NETWORK.levels[level].packs;
  const keep = new Set<Squad>();
  for (const r of REGIONS) {
    const mine = PACKS.map((sq, i) => ({ sq, i })).filter(({ sq }) => regionHere(sq.patrol?.[0] ?? { x: 0, z: 0 }).id === r.id);
    const n = Math.min(mine.length, want[r.id]);
    if (n >= mine.length) mine.forEach(({ sq }) => keep.add(sq));
    else [...mine].sort((a, b) => seeded(seed, 0x51, a.i) - seeded(seed, 0x51, b.i)).slice(0, n).forEach(({ sq }) => keep.add(sq));
  }
  return PACKS.filter((sq) => keep.has(sq));
}

/** Whether a plain grunt or heavy numbered `id` in a raid from `seed` wears a tier-1 plate at network `level` and threat `threat`. */
export const netPlated = (seed: number, level: number, id: number, threat = 0) => {
  const share = NETWORK.levels[level].plate + THREAT.levels[threat].plate;
  return share > 0 && (seeded(seed, 0x9a, id) % 10_000) / 10_000 < share;
};

/**
 * The day's island event (`EVENTS`), as a raid plays it: a piece of the ring down at a spot, a
 * squad sent to retake a freed POI, a storm, or a second salvage crew.
 */
export type IslandEvent = { t: "debris"; spot: DebrisId } | { t: "retake"; poi: PoiId } | { t: "storm" } | { t: "crews" };

/** The salvage crews coming into the raid's starting region at network `level` on a day with `event`. */
export const crewsFor = (level: number, event: IslandEvent | null) => NETWORK.levels[level].crews + (event?.t === "crews" ? 1 : 0);
