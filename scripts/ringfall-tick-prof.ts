/**
 * Section profile of the enemy tick: TS vs WASM (ABI 6).
 *
 *   RINGFALL_TICK_PROF=1 npx tsx scripts/ringfall-tick-prof.ts [seconds=30]
 *
 * Also runs a short `node --cpu-prof` pass when RINGFALL_TICK_PROF_CPU=1.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const seconds = Math.max(10, Number(process.argv[2] ?? 30));
const work = join(root, "node_modules/.cache/ringfall-tick-prof");
mkdirSync(work, { recursive: true });

type Snap = {
  mode: string;
  cpu_s: number;
  wall_s: number;
  seconds_sim: number;
  kills: number;
  ms: Record<string, number>;
  counts: Record<string, number>;
};

function run(mode: "ts" | "wasm"): Snap {
  const env = {
    ...process.env,
    RINGFALL_TICK_PROF: "1",
    RINGFALL_COST_SECONDS: String(seconds),
  };
  if (mode === "wasm") env.RINGFALL_TICK = "1";
  else delete env.RINGFALL_TICK;
  const worker = join(root, "scripts/ringfall-tick-prof-worker.ts");
  const r = spawnSync("npx", ["tsx", worker], {
    cwd: root,
    env,
    encoding: "utf8",
    maxBuffer: 32 << 20,
  });
  if (r.status !== 0) {
    console.error(r.stderr || r.stdout);
    process.exit(r.status ?? 1);
  }
  const line = r.stdout.trim().split("\n").filter(Boolean).pop()!;
  return JSON.parse(line) as Snap;
}

function fmt(ms: number): string {
  return ms < 10 ? ms.toFixed(2) : ms.toFixed(1);
}

function row(label: string, ts: number, wasm: number) {
  const ratio = ts > 0 && wasm > 0 ? (ts / wasm).toFixed(2) : "—";
  console.log(
    `  ${label.padEnd(16)} ${fmt(ts).padStart(8)} ${fmt(wasm).padStart(8)}  ×${ratio}`,
  );
}

const fine = process.env.RINGFALL_TICK_PROF === "2" || process.env.RINGFALL_TICK_PROF === "fine";
console.log(
  `tick-prof: ${seconds}s sim (good bot, reservoir seed 1000), RINGFALL_TICK_PROF=${fine ? "2(fine)" : "1(coarse)"}`,
);
// Fair whole-loop CPU without section timers first.
function runBare(mode: "ts" | "wasm") {
  const env = { ...process.env, RINGFALL_COST_SECONDS: String(seconds) };
  delete env.RINGFALL_TICK_PROF;
  if (mode === "wasm") env.RINGFALL_TICK = "1";
  else delete env.RINGFALL_TICK;
  const worker = join(root, "scripts/ringfall-tick-cost-worker.ts");
  const r = spawnSync("npx", ["tsx", worker], { cwd: root, env, encoding: "utf8", maxBuffer: 16 << 20 });
  if (r.status !== 0) {
    console.error(r.stderr || r.stdout);
    process.exit(r.status ?? 1);
  }
  return JSON.parse(r.stdout.trim().split("\n").filter(Boolean).pop()!) as {
    cpu_s: number;
    wall_s: number;
    kills: number;
  };
}
const bareTs = runBare("ts");
const bareWasm = runBare("wasm");
function runBareNosync() {
  const env = {
    ...process.env,
    RINGFALL_COST_SECONDS: String(seconds),
    RINGFALL_TICK: "1",
    RINGFALL_TICK_NOSYNC: "1",
  };
  delete env.RINGFALL_TICK_PROF;
  const worker = join(root, "scripts/ringfall-tick-cost-worker.ts");
  const r = spawnSync("npx", ["tsx", worker], { cwd: root, env, encoding: "utf8", maxBuffer: 16 << 20 });
  if (r.status !== 0) {
    console.error(r.stderr || r.stdout);
    process.exit(r.status ?? 1);
  }
  return JSON.parse(r.stdout.trim().split("\n").filter(Boolean).pop()!) as {
    cpu_s: number;
    wall_s: number;
    kills: number;
  };
}
const bareNosync = runBareNosync();
console.log("\nBare CPU / wall (no section timers):");
console.log(`  TS           CPU ${bareTs.cpu_s.toFixed(2)}s  wall ${bareTs.wall_s.toFixed(2)}s  kills ${bareTs.kills}`);
console.log(`  WASM         CPU ${bareWasm.cpu_s.toFixed(2)}s  wall ${bareWasm.wall_s.toFixed(2)}s  kills ${bareWasm.kills}`);
console.log(
  `  WASM nosync  CPU ${bareNosync.cpu_s.toFixed(2)}s  wall ${bareNosync.wall_s.toFixed(2)}s  kills ${bareNosync.kills}  (timing ceiling; behavior wrong)`,
);
console.log(
  `  speedup CPU TS/WASM ×${(bareTs.cpu_s / Math.max(1e-9, bareWasm.cpu_s)).toFixed(2)}  TS/nosync ×${(bareTs.cpu_s / Math.max(1e-9, bareNosync.cpu_s)).toFixed(2)}`,
);

const ts = run("ts");
const wasm = run("wasm");

// Nested note: hunt/cover sit inside calm/engaged on both sides — do not sum subsections for totals.
const tsEnemies = ts.ms.tsEnemies || 0;
const wasmTick = wasm.ms["wasm.tick"] || wasm.ms.tick || 0;
const wasmEnemies = wasm.ms["wasm.enemies"] || 0;
const wasmOrbs = wasm.ms["wasm.orbs"] || 0;

const wasmSync =
  (wasm.ms.syncAdopt || 0) +
  (wasm.ms.syncSquads || 0) +
  (wasm.ms.syncOrbs || 0) +
  (wasm.ms.setPlayer || 0) +
  (wasm.ms.pullRobots || 0) +
  (wasm.ms.pullSquads || 0) +
  (wasm.ms.pullOrbs || 0) +
  (wasm.ms.applyHits || 0);

const leftover =
  (wasm.ms.stepSquads || 0) + (wasm.ms.stepFriends || 0) + (wasm.ms.stepFactions || 0);

console.log("\nCPU / wall (whole raid loop):");
console.log(`  TS    CPU ${ts.cpu_s.toFixed(2)}s  wall ${ts.wall_s.toFixed(2)}s  kills ${ts.kills}`);
console.log(`  WASM  CPU ${wasm.cpu_s.toFixed(2)}s  wall ${wasm.wall_s.toFixed(2)}s  kills ${wasm.kills}`);

console.log("\nSection ms (nested hunt/cover inside calm/engaged — informational):");
console.log(`  ${"section".padEnd(16)} ${"TS".padStart(8)} ${"WASM".padStart(8)}  TS/WASM`);
row("sense", ts.ms.sense || 0, wasm.ms["wasm.sense"] || 0);
row("calm*", ts.ms.calm || 0, wasm.ms["wasm.calm"] || 0);
row("fightFoe", ts.ms.fightFoe || 0, wasm.ms["wasm.fightFoe"] || 0);
row("cover*", ts.ms.cover || 0, wasm.ms["wasm.cover"] || 0);
row("hunt*", ts.ms.hunt || 0, wasm.ms["wasm.hunt"] || 0);
row("engaged*", 0, wasm.ms["wasm.engaged"] || 0);
row("orbs", ts.ms.tsOrbs || 0, wasmOrbs);
row("enemies total", tsEnemies, wasmEnemies);
row("tick (Rust)", 0, wasmTick);
console.log("  * nested — also counted in calm/engaged/enemies totals");

console.log("\nWASM sync / leftover (ms):");
for (const k of [
  "syncAdopt",
  "syncSquads",
  "syncOrbs",
  "setPlayer",
  "tick",
  "pullRobots",
  "pullSquads",
  "pullOrbs",
  "applyHits",
  "stepSquads",
  "stepFriends",
  "stepFactions",
]) {
  const v = wasm.ms[k] || 0;
  if (v > 0.05) console.log(`  ${k.padEnd(16)} ${fmt(v).padStart(8)}`);
}
console.log(`  ${"Σ sync".padEnd(16)} ${fmt(wasmSync).padStart(8)}`);
console.log(`  ${"Σ leftover".padEnd(16)} ${fmt(leftover).padStart(8)}`);

const wasmCompute = wasmTick > 0 ? wasmTick : wasmEnemies + wasmOrbs;
const syncZero = wasmCompute + leftover; // enemies+orbs in Rust, no sync; squads/factions stay
const enemyTs = tsEnemies + (ts.ms.tsOrbs || 0) + (ts.ms.stepSquads || 0);
const enemyWasm = wasmCompute + wasmSync + (wasm.ms.stepSquads || 0);

console.log("\nSync-zero estimate (enemy path only, ms of section timers):");
console.log(`  TS enemy+orbs+squads     ${fmt(enemyTs)}`);
console.log(`  WASM compute+sync+squads ${fmt(enemyWasm)}`);
console.log(`  WASM compute+squads only ${fmt(syncZero)}  (if sync → 0)`);
const headroom = enemyTs - syncZero;
console.log(
  `  headroom if sync→0       ${fmt(headroom)} ms  (${headroom > 0 ? "Rust compute+leftover faster than TS enemy path" : "still slower than TS even with zero sync"})`,
);

const bareHeadroom = bareTs.cpu_s - bareNosync.cpu_s;
const verdict =
  bareNosync.cpu_s < bareTs.cpu_s * 0.95
    ? "YES — nosync WASM CPU under TS; remaining sync is worth moving into Rust"
    : bareNosync.cpu_s < bareTs.cpu_s
      ? "MARGINAL — nosync slightly under TS; gains may vanish once behavior is restored"
      : "NO — even with sync skipped, WASM CPU ≥ TS; compute (hunt etc.) dominates";

console.log(`\nVerdict (from bare CPU): ${verdict}`);
console.log(
  `  bare headroom TS−nosync = ${bareHeadroom.toFixed(2)}s CPU (${((100 * bareHeadroom) / Math.max(1e-9, bareTs.cpu_s)).toFixed(0)}% of TS)`,
);
console.log(`  section-timer headroom (informational) = ${fmt(headroom)} ms`);

if (wasm.counts["wasm.huntBuilds"] != null) {
  console.log(
    `\nWASM hunt counters: builds=${wasm.counts["wasm.huntBuilds"]} cells=${wasm.counts["wasm.huntCells"]}`,
  );
}

writeFileSync(join(work, "last.json"), JSON.stringify({ ts, wasm, syncZero, headroom, verdict }, null, 2));
console.log(`\nwrote ${join(work, "last.json")}`);

if (process.env.RINGFALL_TICK_PROF_CPU === "1") {
  console.log("\nnode --cpu-prof (WASM, short)…");
  const cpuDir = join(work, "cpu");
  mkdirSync(cpuDir, { recursive: true });
  spawnSync(
    process.execPath,
    ["--cpu-prof", "--cpu-prof-dir=" + cpuDir, "--import", "tsx", join(root, "scripts/ringfall-tick-prof-worker.ts")],
    {
      cwd: root,
      env: { ...process.env, RINGFALL_TICK: "1", RINGFALL_TICK_PROF: "1", RINGFALL_COST_SECONDS: String(Math.min(15, seconds)) },
      encoding: "utf8",
      maxBuffer: 32 << 20,
    },
  );
  const cps = readdirSync(cpuDir).filter((f) => f.endsWith(".cpuprofile"));
  console.log(`  profiles: ${cps.map((f) => join(cpuDir, f)).join(", ") || "(none)"}`);
}

void require;
