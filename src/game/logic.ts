import { SPECIES, SPECIES_LIST, capOf, swarmBonus } from "./species";
import type { Colony, EvolutionEvent, SpeciesId, SquadMonster } from "./types";

export const now = () => Date.now();

/** Coarse step size for the offline/live catch-up simulation, in seconds. */
const STEP_SECONDS = 30;
/** Bounds simulation cost for very long offline gaps (~16.7h at full resolution). */
const MAX_STEPS = 2000;
/** Safety bound on same-step evolution cascades per colony. */
const MAX_CASCADES_PER_STEP = 5;

function pickWeighted(options: { target: SpeciesId; weight: number }[]): SpeciesId {
  const total = options.reduce((sum, o) => sum + o.weight, 0);
  let r = Math.random() * total;
  for (const o of options) {
    r -= o.weight;
    if (r <= 0) return o.target;
  }
  return options[options.length - 1].target;
}

/**
 * Advances every colony by `dtSeconds`: population grows toward its cap, individuals mature,
 * and mature colonies past their evolution threshold convert a batch into a weighted-random
 * next species. Runs in fixed-size steps so both a 1s UI tick and a multi-hour offline gap
 * are simulated the same way (long gaps just get coarser per-step resolution, capped at
 * MAX_STEPS so the cost stays bounded).
 */
export function advanceColonies(
  colonies: Colony[],
  dex: SpeciesId[],
  nestLevel: number,
  dtSeconds: number,
): { colonies: Colony[]; dex: SpeciesId[]; events: EvolutionEvent[] } {
  if (dtSeconds <= 0) {
    return { colonies, dex, events: [] };
  }

  const buckets = new Map<SpeciesId, { count: number; growth: number }>(
    colonies.map((c) => [c.speciesId, { count: c.count, growth: c.growth }]),
  );
  const dexSet = new Set(dex);
  const events: EvolutionEvent[] = [];

  const steps = Math.min(MAX_STEPS, Math.max(1, Math.ceil(dtSeconds / STEP_SECONDS)));
  const stepDt = dtSeconds / steps;

  for (let i = 0; i < steps; i++) {
    for (const [speciesId, bucket] of buckets) {
      const def = SPECIES[speciesId];
      const cap = capOf(speciesId, nestLevel);
      if (bucket.count <= 0) {
        bucket.count = 1; // a discovered species never fully dies out
      } else if (bucket.count < cap) {
        bucket.count = Math.min(cap, bucket.count * Math.exp(def.growthRate * stepDt));
      }
      if (Number.isFinite(def.maturitySeconds)) {
        bucket.growth = Math.min(1, bucket.growth + stepDt / def.maturitySeconds);
      }
    }

    for (const [speciesId, bucket] of Array.from(buckets.entries())) {
      const def = SPECIES[speciesId];
      if (def.evolvesTo.length === 0) continue;
      let cascades = 0;
      while (
        bucket.growth >= 1 &&
        bucket.count >= def.evolveThreshold &&
        cascades < MAX_CASCADES_PER_STEP
      ) {
        const batch = Math.min(def.evolveBatch, bucket.count - 1);
        if (batch <= 0) break;
        cascades += 1;
        const target = pickWeighted(def.evolvesTo);
        bucket.count -= batch;
        const targetBucket = buckets.get(target) ?? { count: 0, growth: 0 };
        targetBucket.count = Math.min(capOf(target, nestLevel), targetBucket.count + batch);
        buckets.set(target, targetBucket);
        dexSet.add(target);
        events.push({ from: speciesId, to: target, amount: Math.round(batch), at: 0 });
      }
    }
  }

  const outColonies: Colony[] = Array.from(buckets.entries())
    .map(([speciesId, b]) => ({
      speciesId,
      count: Math.round(b.count * 100) / 100,
      growth: b.growth,
      updatedAt: 0,
    }))
    .filter((c) => c.count > 0);

  return { colonies: outColonies, dex: Array.from(dexSet), events };
}

export function colonyOf(colonies: Colony[], speciesId: SpeciesId): Colony | undefined {
  return colonies.find((c) => c.speciesId === speciesId);
}

/** Combat stats for a species as fielded in a squad: base stats plus a capped swarm bonus. */
export function squadMonsterStats(speciesId: SpeciesId, ownedCount: number): SquadMonster {
  const def = SPECIES[speciesId];
  const bonus = 1 + swarmBonus(ownedCount);
  return {
    speciesId,
    hp: Math.round(def.baseStats.hp * bonus),
    atk: Math.round(def.baseStats.atk * bonus),
    def: Math.round(def.baseStats.def * bonus),
    element: def.element,
  };
}

export function dexProgress(dex: SpeciesId[]): { discovered: number; total: number } {
  return { discovered: dex.length, total: SPECIES_LIST.length };
}

export function formatNumber(n: number): string {
  const v = Math.floor(n);
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (v >= 1000) return (v / 1000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(v);
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${s}s`;
}
