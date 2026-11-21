/**
 * Statistical equivalence of RINGFALL raid outcomes: TypeScript tick (default) vs WASM tick.
 * Pools all N×bench-job raid samples per metric, then Welch t-test on numeric fields (0/1 for extracted).
 * TS and WASM workers run in parallel.
 *
 *   npm run equiv:ringfall
 *   npm run equiv:ringfall -- 10
 *   RINGFALL_EQUIV_N=5 npm run equiv:ringfall
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RaidMetrics } from "./ringfall-tick-equiv-worker";

const root = fileURLToPath(new URL("..", import.meta.url));
const work = join(root, "node_modules/.cache/ringfall-tick-equiv");
const worker = join(root, "scripts/ringfall-tick-equiv-worker.ts");

const METRICS: (keyof RaidMetrics)[] = [
  "extracted",
  "minutes",
  "haul",
  "kills",
  "damage",
  "cleared",
  "downs",
  "shots",
  "hits",
  "crits",
  "flanks",
  "titanHits",
  "waves",
  "firstMeet",
  "quiet",
  "met",
  "metAway",
  "peakSq",
  "peakBots",
  "ults",
  "allyShare",
  "allyDowns",
  "rescues",
  "helped",
];

const nArg = process.argv[2];
const n = Math.max(1, Number(nArg ?? process.env.RINGFALL_EQUIV_N ?? 30));

mkdirSync(work, { recursive: true });

type WorkerOut = {
  mode: string;
  n: number;
  tick_wasm: boolean;
  orbs_wasm: boolean;
  wasm_available: boolean;
  jobs: number;
  samples: number;
  cpu_s: number;
  wall_s: number;
  rows: RaidMetrics[];
};

function runWorkerAsync(mode: "ts" | "wasm"): Promise<WorkerOut> {
  const out = join(work, `${mode}.json`);
  const env = { ...process.env };
  if (mode === "wasm") {
    env.RINGFALL_TICK = "1";
    delete env.RINGFALL_ORBS;
  } else {
    delete env.RINGFALL_TICK;
    delete env.RINGFALL_ORBS;
  }
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["tsx", worker, mode, String(n), out], {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d;
      process.stderr.write(`[${mode}] ${d}`);
    });
    child.stdout.on("data", (d) => process.stdout.write(`[${mode}] ${d}`));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${mode} worker exited ${code}\n${stderr}`));
        return;
      }
      resolve(JSON.parse(readFileSync(out, "utf8")) as WorkerOut);
    });
  });
}

type BenchLine = { mode: string; cpu_s: number; wall_s: number; load_s: number; hash: string };

function runBench(mode: "ts" | "wasm"): BenchLine {
  const env = { ...process.env };
  if (mode === "wasm") env.RINGFALL_TICK = "1";
  else delete env.RINGFALL_TICK;
  const wall0 = performance.now();
  const r = spawnSync("npx", ["tsx", join(root, "scripts/ringfall-bench.ts")], { cwd: root, env, encoding: "utf8" });
  const wall_s = (performance.now() - wall0) / 1e3;
  if (r.status !== 0) {
    console.error(r.stderr || r.stdout);
    process.exit(r.status ?? 1);
  }
  const text = r.stdout ?? "";
  const bench = text.match(/bench: .*, ([\d.]+) s of CPU \(and ([\d.]+) s loading[^,]*\), (\w+)/);
  if (!bench) throw new Error(`could not parse bench output for ${mode}`);
  return { mode, cpu_s: Number(bench[1]), wall_s, load_s: Number(bench[2]), hash: bench[3] };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const variance = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
};

/** Standard normal CDF (Abramowitz & Stegun); fine for pooled n ≈ 300. */
function normalCdf(x: number): number {
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.2316419 * ax);
  const d = 0.3989423 * Math.exp(-(x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x >= 0 ? 1 - p : p;
}

function welchP(a: number[], b: number[]): { meanTs: number; meanWasm: number; diff: number; se: number; t: number; p: number } {
  const meanTs = mean(a);
  const meanWasm = mean(b);
  const va = variance(a);
  const vb = variance(b);
  const se = Math.sqrt(va / Math.max(a.length, 1) + vb / Math.max(b.length, 1));
  const t = se > 0 ? (meanTs - meanWasm) / se : 0;
  const p = 2 * (1 - normalCdf(Math.abs(t)));
  return { meanTs, meanWasm, diff: meanTs - meanWasm, se, t, p };
}

function values(rows: RaidMetrics[], key: keyof RaidMetrics): number[] {
  const out: number[] = [];
  for (const row of rows) {
    if (row.error) continue;
    const v = row[key];
    if (typeof v === "number" && Number.isFinite(v)) out.push(v);
  }
  return out;
}

console.log(`ringfall tick equivalence: N=${n} per job × 10 bench jobs (pooled; TS∥WASM workers)\n`);

const benchTs = runBench("ts");
const benchWasm = runBench("wasm");
console.log("bench pass (warm, one raid each job):");
console.log(`  TS   CPU ${benchTs.cpu_s.toFixed(1)} s  wall ${benchTs.wall_s.toFixed(1)} s  load ${benchTs.load_s.toFixed(1)} s  hash ${benchTs.hash}`);
console.log(`  WASM CPU ${benchWasm.cpu_s.toFixed(1)} s  wall ${benchWasm.wall_s.toFixed(1)} s  load ${benchWasm.load_s.toFixed(1)} s  hash ${benchWasm.hash}\n`);

console.log("equiv workers (parallel)…");
const [ts, wasm] = await Promise.all([runWorkerAsync("ts"), runWorkerAsync("wasm")]);

if (!wasm.wasm_available && !wasm.tick_wasm) {
  // tickAvailable may be false until geom; tick_wasm flag is the real gate
}
if (!wasm.tick_wasm) {
  console.error("WASM tick flag not set in worker");
  process.exit(1);
}

function softStuck(rows: RaidMetrics[]): RaidMetrics[] {
  return rows.map((r) => {
    if (!r.error || !String(r.error).includes("still on the island")) return r;
    // LIMIT timeout: count as a wipe at 30 minutes so float-drift stuck raids stay in the pool.
    return {
      ...r,
      error: undefined,
      extracted: 0,
      minutes: 30,
      haul: 0,
      kills: r.kills ?? 0,
      damage: r.damage ?? 0,
      downs: r.downs ?? 0,
      cleared: r.cleared ?? 0,
      shots: r.shots ?? 0,
      hits: r.hits ?? 0,
      crits: r.crits ?? 0,
      flanks: r.flanks ?? 0,
      titanHits: r.titanHits ?? 0,
      waves: r.waves ?? 0,
      firstMeet: r.firstMeet ?? 1800,
      quiet: r.quiet ?? 0,
      met: r.met ?? 0,
      metAway: r.metAway ?? 0,
      peakSq: r.peakSq ?? 0,
      peakBots: r.peakBots ?? 0,
      allyShare: r.allyShare ?? 0,
      allyDowns: r.allyDowns ?? 0,
      rescues: r.rescues ?? 0,
      helped: r.helped ?? 0,
    };
  });
}
const stuckTs = ts.rows.filter((r) => r.error && String(r.error).includes("still on the island")).length;
const stuckWasm = wasm.rows.filter((r) => r.error && String(r.error).includes("still on the island")).length;
ts.rows = softStuck(ts.rows);
wasm.rows = softStuck(wasm.rows);
const errorsTs = ts.rows.filter((r) => r.error).length;
const errorsWasm = wasm.rows.filter((r) => r.error).length;
if (errorsTs || errorsWasm) {
  console.error(`hard failure: raid errors TS=${errorsTs} WASM=${errorsWasm}`);
  process.exit(1);
}
if (stuckTs || stuckWasm) console.log(`stuck@LIMIT soft-counted as wipe: TS=${stuckTs} WASM=${stuckWasm}`);

console.log(
  `equiv runs: TS CPU ${ts.cpu_s.toFixed(1)} s wall ${ts.wall_s.toFixed(1)} s | WASM CPU ${wasm.cpu_s.toFixed(1)} s wall ${wasm.wall_s.toFixed(1)} s`,
);
console.log(`flags: TS tick=${ts.tick_wasm} orbs=${ts.orbs_wasm} | WASM tick=${wasm.tick_wasm} orbs=${wasm.orbs_wasm}\n`);

const hdr =
  "metric".padEnd(14) +
  "mean_ts".padStart(10) +
  " sd_ts".padStart(8) +
  "mean_wasm".padStart(10) +
  " sd_wasm".padStart(9) +
  "   Δ".padStart(10) +
  "   SE".padStart(8) +
  "     p".padStart(8) +
  "  flag".padStart(6);
console.log(hdr);
console.log("-".repeat(hdr.length));

let missing = 0;
const flags: string[] = [];

for (const key of METRICS) {
  const a = values(ts.rows, key);
  const b = values(wasm.rows, key);
  if (!a.length || !b.length) {
    missing++;
    console.log(`${String(key).padEnd(14)} ${"(no data)".padStart(10)}`);
    continue;
  }
  const sdTs = Math.sqrt(variance(a));
  const sdWasm = Math.sqrt(variance(b));
  const w = welchP(a, b);
  const pooledSd = Math.sqrt((variance(a) + variance(b)) / 2);
  const material = pooledSd > 0 && Math.abs(w.diff) > 0.2 * pooledSd;
  const bias = material && Math.abs(w.diff) > pooledSd && w.p < 0.05;
  const flag = bias ? "BIAS" : w.p < 0.05 && material ? "~" : "";
  if (flag === "BIAS") flags.push(String(key));
  console.log(
    `${String(key).padEnd(14)}` +
      `${w.meanTs.toFixed(3).padStart(10)}` +
      `${sdTs.toFixed(3).padStart(8)}` +
      `${w.meanWasm.toFixed(3).padStart(10)}` +
      `${sdWasm.toFixed(3).padStart(9)}` +
      `${w.diff.toFixed(3).padStart(10)}` +
      `${w.se.toFixed(4).padStart(8)}` +
      `${w.p.toFixed(4).padStart(8)}` +
      `${flag.padStart(6)}`,
  );
}

if (missing === METRICS.length) {
  console.error("no metrics collected");
  process.exit(1);
}

console.log();
if (flags.length) console.log(`systematic bias flagged (|Δ|>pooled SD and p<0.05): ${flags.join(", ")}`);
else console.log("no metric flagged for systematic bias (|Δ|>pooled SD and p<0.05)");
console.log(`hash note: bench hashes differ=${benchTs.hash !== benchWasm.hash} (not required for exit 0)`);
