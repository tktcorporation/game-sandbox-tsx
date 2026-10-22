import { STRENGTH, THREAT } from "./config";
import { PACKS, POIS, REGIONS, regionHere, type DebrisId, type Squad } from "./map";
import { mix } from "./state";

/*
 * What a POI's standing on the island (meta/island.ts) means inside a raid: whether its robots
 * stand there. The rules that move a POI from one standing to another live in the meta.
 */

/** Who holds a POI: the enemy (red on the maps) or the player (blue). */
export type PoiHold = "held" | "freed";

/** The squad guarding a POI's vault: the one with a member in armour plate. */
export const isVaultGuard = (sq: Squad) => sq.members.some((m) => m.plate !== undefined);

/** The squads of POI `poi` that stand in a raid: all of them while the enemy holds it, none once it is the player's. */
export const garrison = (poi: number, hold: PoiHold): Squad[] => (hold === "held" ? POIS[poi].squads : []);

/** A hash of the raid's seed and a salt, for choices that must not draw on the raid's random numbers. */
const seeded = (seed: number, salt: number, k: number) => mix(Math.imul(seed + 1, 0x9e3779b1) ^ Math.imul(salt, 0x85ebca6b) ^ Math.imul(k + 1, 0xc2b2ae35));

/**
 * The drone packs flying in a raid from `seed` at the enemy's strength `level`: in each region,
 * as many of its packs as the level gives, picked from the seed. All of them at the levels that fly every pack.
 */
export function activePacks(seed: number, level: number): Squad[] {
  const want = STRENGTH.levels[level].packs;
  const keep = new Set<Squad>();
  for (const r of REGIONS) {
    const mine = PACKS.map((sq, i) => ({ sq, i })).filter(({ sq }) => regionHere(sq.patrol?.[0] ?? { x: 0, z: 0 }).id === r.id);
    const n = Math.min(mine.length, want[r.id]);
    if (n >= mine.length) mine.forEach(({ sq }) => keep.add(sq));
    else [...mine].sort((a, b) => seeded(seed, 0x51, a.i) - seeded(seed, 0x51, b.i)).slice(0, n).forEach(({ sq }) => keep.add(sq));
  }
  return PACKS.filter((sq) => keep.has(sq));
}

/** Whether a plain grunt or heavy numbered `id` in a raid from `seed` wears a tier-1 plate at threat `threat`. */
export const netPlated = (seed: number, id: number, threat = 0) => {
  const share = THREAT.levels[threat].plate;
  return share > 0 && (seeded(seed, 0x9a, id) % 10_000) / 10_000 < share;
};

/** The day's island event (`EVENTS`), as a raid plays it: a piece of the ring down at a spot, a storm, or a salvage crew. */
export type IslandEvent = { t: "debris"; spot: DebrisId } | { t: "storm" } | { t: "crews" };

/** The salvage crews coming into the raid's starting region on a day with `event`. */
export const crewsFor = (event: IslandEvent | null) => (event?.t === "crews" ? 1 : 0);
