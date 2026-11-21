/**
 * The fixed raids `ringfall-bench.ts` and tick-equivalence scripts play.
 */
import { playRaid, playState, type RaidResult } from "./ringfall-table";
import { NODES, REGIONS, type NodeId } from "../src/ringfall/sim/map";
import { newRun, starterKit } from "../src/ringfall/sim/state";
import { holds } from "../src/ringfall/meta/island";
import { newProfile } from "../src/ringfall/meta/profile";

/** A raid of an island holding `freed`, with its battle at factory level `factory`, as a day of the campaign is. */
function battleRaid(freed: NodeId[], factory: number, skill: string, r: number): RaidResult {
  const p = newProfile(7);
  const poiState = { ...p.poiState };
  for (const id of freed) poiState[id] = { state: "freed" };
  return playState(newRun(4000 + r * 7919, starterKit(), "reservoir", { island: holds({ ...p, poiState }), battle: { factory } }), skill, r);
}

export type BenchJob = { name: string; play: (r: number) => RaidResult };

export const BENCH_JOBS: BenchJob[] = [
  ...REGIONS.flatMap((g) =>
    (["beginner", "good"] as const).map(
      (skill): BenchJob => ({
        name: `${g.id} ${skill}`,
        play: (r) => playRaid(g.id, skill, r),
      }),
    ),
  ),
  { name: "battle, 2 nodes, casual", play: (r) => battleRaid(["supply", "quarry"], 1, "casual", r) },
  { name: "battle, 8 nodes, good", play: (r) => battleRaid(NODES.slice(0, 8).map((n) => n.id), 3, "good", r) },
];

/** Single-run jobs for `ringfall-bench.ts` (same raid indices as before extracting jobs). */
export const BENCH_ONCE: [string, () => RaidResult][] = BENCH_JOBS.map((j) => [
  j.name,
  () => j.play(j.name === "battle, 8 nodes, good" ? 1 : 0),
]);