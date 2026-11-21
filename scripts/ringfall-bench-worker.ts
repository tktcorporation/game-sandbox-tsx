/**
 * A worker process of RINGFALL's bench (forked by scripts/ringfall-bench.ts): plays each
 * raid it is sent and sends back its result and the CPU seconds it took. One process plays
 * many raids, so the grids the sim builds on first use are built once per process.
 */
import "./ringfall-terrain-store";
import { playRaid, playState, type RaidResult } from "./ringfall-table";
import { newRun, starterKit } from "../src/ringfall/sim/state";
import { holds } from "../src/ringfall/meta/island";
import { newProfile } from "../src/ringfall/meta/profile";
import type { NodeId, RegionId } from "../src/ringfall/sim/map";

const cpu = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1e6;
};

/** One of the bench's fixed raids (a region's table raid, or an island battle). */
export type BenchJob =
  | { i: number; kind: "raid"; region: RegionId; skill: string; r: number }
  | { i: number; kind: "battle"; skill: string; r: number; freed: NodeId[]; factory: number };

function battleRaid(freed: NodeId[], factory: number, skill: string, r: number): RaidResult {
  const p = newProfile(7);
  const poiState = { ...p.poiState };
  for (const id of freed) poiState[id] = { state: "freed" };
  return playState(newRun(4000 + r * 7919, starterKit(), "reservoir", { island: holds({ ...p, poiState }), battle: { factory } }), skill, r);
}

process.on("message", (job: BenchJob) => {
  const t = cpu();
  const result =
    job.kind === "raid" ? playRaid(job.region, job.skill, job.r) : battleRaid(job.freed, job.factory, job.skill, job.r);
  process.send!({ i: job.i, result: result satisfies RaidResult, cpu: cpu() - t });
});
process.on("disconnect", () => process.exit(0));
