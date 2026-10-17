/**
 * A worker process of RINGFALL's sim gate (forked by scripts/ringfall-sim.ts): plays each
 * table it is sent and sends back its result. One process plays several tables, so the
 * fields and grids the sim builds on first use are built once per process.
 */
import { playTable } from "./ringfall-table";
import type { RegionId } from "../src/ringfall/sim/map";

export type TableJob = { i: number; region: RegionId; skill: string; runs: number };

process.on("message", (job: TableJob) => {
  process.send!({ i: job.i, result: playTable(job.region, job.skill, job.runs) });
});
// Without the gate there is no one to report to; this also ends the worker when the gate
// exits early on a failed check.
process.on("disconnect", () => process.exit(0));
