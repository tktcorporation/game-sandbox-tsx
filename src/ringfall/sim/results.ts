import { RANK } from "./config";
import type { State } from "./state";

/**
 * Rank from total time against par, wipes and downs. Each 25% over par, each wipe
 * and every two downs costs one step from S.
 */
export function rank(s: State): { rank: (typeof RANK.steps)[number]; total: number; steps: number } {
  const total = s.stats.poiTimes.reduce((a, b) => a + b, 0);
  const over = Math.max(0, total - RANK.parSeconds) / (RANK.parSeconds * 0.25);
  const steps = Math.floor(over) + s.stats.wipes + Math.floor(s.stats.downs / 2);
  return { rank: RANK.steps[Math.min(steps, RANK.steps.length - 1)], total, steps };
}
