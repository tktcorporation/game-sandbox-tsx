import { SCORE, VALUABLES } from "./config";
import { POIS } from "./map";
import type { State } from "./state";

/** Worth of everything the player carries and has sent home from a depot. */
export const haulValue = (s: State) => [...s.player.haul, ...s.sent].reduce((n, k) => n + VALUABLES[k].value, 0);

/**
 * A raid's score and rank. Getting off the island scores the haul plus a bonus per
 * POI cleared (more for the titan); a wipe scores nothing and has no rank.
 */
export function rank(s: State): { rank: string; score: number; haul: number; cleared: number } {
  const cleared = s.stats.cleared.length;
  const haul = haulValue(s);
  if (s.outcome !== "extracted") return { rank: "-", score: 0, haul, cleared };
  const boss = s.stats.cleared.filter((i) => POIS[i].boss).length;
  const score = haul + (cleared - boss) * SCORE.poi + boss * SCORE.titan;
  return { rank: SCORE.ranks.find(([, min]) => score >= min)![0], score, haul, cleared };
}
