/**
 * Child worker for tick equivalence: env (RINGFALL_TICK / RINGFALL_ORBS) must be set before this loads.
 */
import "./ringfall-terrain-store";
import { writeFileSync } from "node:fs";
import type { RaidResult } from "./ringfall-table";
import { BENCH_JOBS } from "./ringfall-bench-jobs";
import { tickAvailable } from "../src/ringfall/sim/native/tick";
import { ORBS_WASM, TICK_WASM } from "../src/ringfall/sim/native/tick-flag";

export type RaidMetrics = {
  job: string;
  r: number;
  error?: string;
  extracted?: number;
  minutes?: number;
  haul?: number;
  kills?: number;
  damage?: number;
  cleared?: number;
  downs?: number;
  shots?: number;
  hits?: number;
  crits?: number;
  flanks?: number;
  titanHits?: number;
  waves?: number;
  firstMeet?: number;
  quiet?: number;
  met?: number;
  metAway?: number;
  peakSq?: number;
  peakBots?: number;
  ults?: number;
  allyShare?: number;
  allyDowns?: number;
  rescues?: number;
  helped?: number;
};

function metrics(job: string, r: number, raid: RaidResult): RaidMetrics {
  const base: RaidMetrics = { job, r, ults: raid.ults };
  if (raid.error || !raid.ended) {
    return { ...base, error: raid.error ?? "no ended" };
  }
  const e = raid.ended;
  const rec = e.record;
  return {
    ...base,
    extracted: e.got ? 1 : 0,
    minutes: e.minutes,
    haul: e.got?.haul ?? 0,
    kills: rec.stats.kills,
    damage: rec.stats.damage,
    cleared: e.cleared,
    downs: e.downs,
    shots: e.shots,
    hits: e.hits,
    crits: e.crits,
    flanks: e.flanks,
    titanHits: e.titanHits,
    waves: e.waves,
    firstMeet: e.firstMeet,
    quiet: e.quiet,
    met: e.met,
    metAway: e.metAway,
    peakSq: e.peakSq,
    peakBots: e.peakBots,
    allyShare: e.allyShare,
    allyDowns: e.allyDowns,
    rescues: e.rescues,
    helped: e.helped,
  };
}

const mode = process.argv[2] ?? "ts";
const n = Math.max(1, Number(process.argv[3] ?? 30));
const out = process.argv[4];
if (!out) throw new Error("usage: ringfall-tick-equiv-worker.ts <ts|wasm> <n> <out.json>");

const cpu0 = process.cpuUsage();
const wall0 = performance.now();
const rows: RaidMetrics[] = [];
for (const { name, play } of BENCH_JOBS) {
  const t0 = performance.now();
  for (let r = 0; r < n; r++) rows.push(metrics(name, r, play(r)));
  console.error(`${mode} ${name}: ${n} raids in ${((performance.now() - t0) / 1e3).toFixed(1)}s`);
}
const cpu = process.cpuUsage(cpu0);
const wallMs = performance.now() - wall0;

writeFileSync(
  out,
  JSON.stringify({
    mode,
    n,
    tick_wasm: TICK_WASM,
    orbs_wasm: ORBS_WASM,
    wasm_available: tickAvailable(),
    jobs: BENCH_JOBS.length,
    samples: rows.length,
    cpu_s: (cpu.user + cpu.system) / 1e6,
    wall_s: wallMs / 1e3,
    rows,
  }),
);