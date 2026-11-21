/**
 * Builds a long landmark path with TypeScript fill and with WASM, comparing path hashes,
 * then once more with RINGFALL_FILL=check (both kernels, throw on packed-field mismatch).
 *
 *   npm run fill:ringfall
 *   node scripts/ringfall-fill-ab.mjs
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const cache = join(root, "node_modules/.cache/ringfall-nav");
const work = join(root, "node_modules/.cache/ringfall-fill-ab");
const worker = join(root, "scripts/ringfall-fill-ab-worker.ts");

mkdirSync(work, { recursive: true });

function run(mode) {
  rmSync(cache, { recursive: true, force: true });
  const out = join(work, `${mode}.json`);
  const env = { ...process.env };
  if (mode === "ts") env.RINGFALL_FILL = "ts";
  else if (mode === "check") env.RINGFALL_FILL = "check";
  else delete env.RINGFALL_FILL;
  const r = spawnSync("npx", ["tsx", worker, out], { cwd: root, env, encoding: "utf8" });
  if (r.status !== 0) {
    console.error(r.stderr || r.stdout);
    process.exit(r.status ?? 1);
  }
  return JSON.parse(readFileSync(out, "utf8"));
}

const ts = run("ts");
const wasm = run("wasm");
const check = run("check");
console.log(JSON.stringify({ ts, wasm, check }, null, 2));
const same = ts.path_hash === wasm.path_hash && ts.path_hash === check.path_hash && ts.pts > 0;
console.log(`identity_match=${same}`);
console.log(`cold_speedup=${(ts.cpu_ms / wasm.cpu_ms).toFixed(3)}x (findPath cold, includes grid)`);
if (!same) process.exit(1);
