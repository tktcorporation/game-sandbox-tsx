/**
 * A worker process of RINGFALL's sim gate (forked by scripts/ringfall-sim.ts): plays each
 * raid it is sent and sends back its result. One process plays many raids, so the grids
 * the sim builds on first use are built once per process.
 */
import "./ringfall-terrain-store";
import { playRaid, type RaidResult } from "./ringfall-table";
import type { RegionId } from "../src/ringfall/sim/map";

/** Raid `r` of table `i` (a region and a skill). */
export type RaidJob = { i: number; r: number; region: RegionId; skill: string };

process.on("message", (job: RaidJob) => {
  process.send!({ i: job.i, r: job.r, result: playRaid(job.region, job.skill, job.r) satisfies RaidResult });
});
// Without the gate there is no one to report to; this also ends the worker when the gate
// exits early on a failed check.
process.on("disconnect", () => process.exit(0));
