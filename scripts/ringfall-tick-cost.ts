/**
 * Fixed sim-time cost of the tick path (isolates per-tick work from raid-length drift).
 *
 *   npx tsx scripts/ringfall-tick-cost.ts [seconds=60]
 */
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const work = join(root, "node_modules/.cache/ringfall-tick-cost");
mkdirSync(work, { recursive: true });
const worker = join(root, "scripts/ringfall-tick-cost-worker.ts");
const seconds = Math.max(5, Number(process.argv[2] ?? 60));

function run(mode: "ts" | "wasm") {
  const env = { ...process.env, RINGFALL_COST_SECONDS: String(seconds) };
  if (mode === "wasm") env.RINGFALL_TICK = "1";
  else delete env.RINGFALL_TICK;
  const r = spawnSync("npx", ["tsx", worker], { cwd: root, env, encoding: "utf8", maxBuffer: 16 << 20 });
  if (r.status !== 0) {
    console.error(r.stderr || r.stdout);
    process.exit(r.status ?? 1);
  }
  const line = r.stdout.trim().split("\n").filter(Boolean).pop()!;
  return JSON.parse(line) as {
    mode: string;
    cpu_s: number;
    wall_s: number;
    seconds_sim: number;
    kills: number;
    damage: number;
  };
}

const ts = run("ts");
const wasm = run("wasm");
const cpuRatio = ts.cpu_s / Math.max(1e-9, wasm.cpu_s);
const wallRatio = ts.wall_s / Math.max(1e-9, wasm.wall_s);
console.log(`tick-cost: ${seconds}s sim (good bot, reservoir seed 1000)`);
console.log(`  TS    CPU ${ts.cpu_s.toFixed(2)}s  wall ${ts.wall_s.toFixed(2)}s  sim ${ts.seconds_sim.toFixed(1)}s  kills ${ts.kills}`);
console.log(`  WASM  CPU ${wasm.cpu_s.toFixed(2)}s  wall ${wasm.wall_s.toFixed(2)}s  sim ${wasm.seconds_sim.toFixed(1)}s  kills ${wasm.kills}`);
console.log(`  speedup CPU ×${cpuRatio.toFixed(2)}  wall ×${wallRatio.toFixed(2)}  (per fixed sim time)`);
writeFileSync(join(work, "last.json"), JSON.stringify({ ts, wasm, cpuRatio, wallRatio }, null, 2));
