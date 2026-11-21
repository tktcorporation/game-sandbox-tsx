/**
 * Headroom probe: cheap proxies for algorithmic headroom inside one reservoir raid.
 * - Counts how many enemy ticks are FAR_THINK-skipped vs full calm (already in game).
 * - Times a synthetic O(n²) separate vs cell-sweep on N walkers (separate()'s shape).
 * - Times TypedArray SoA ground queries vs object field access (allocation proxy).
 *
 *   npx tsx scripts/headroom/algo-probe.ts
 */
import "../ringfall-terrain-store";
import { FAR_THINK, TICK } from "../../src/ringfall/sim/config";
import { playRaid } from "../ringfall-table";
import { step } from "../../src/ringfall/sim/step";
import { Bot, SKILLS } from "../../src/ringfall/sim/bot";
import { starterKit, newRun, idleInput } from "../../src/ringfall/sim/state";
import { hypot2 } from "../../src/ringfall/sim/hypot";

const cpu = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1e6;
};

/** Instrument one raid: count calm calls that would be skipped at various FAR_THINK.every. */
function farThinkShare() {
  const s = newRun(1000, starterKit(), "reservoir", { entry: 0 });
  const bot = new Bot(SKILLS[0], 31);
  let prev = false;
  let ticks = 0;
  let enemies = 0;
  let engaged = 0;
  let calmNear = 0;
  let calmFar = 0;
  const r2 = FAR_THINK.dist * FAR_THINK.dist;
  while (s.phase !== "done" && s.time < 8 * 60) {
    const inp = bot.input(s);
    step(s, inp, prev);
    prev = inp.crouch;
    ticks++;
    const p = s.player.pos;
    const a = s.ally.pos;
    const near = new Uint8Array(s.squads.length);
    for (const e of s.enemies) {
      if (e.squad < 0 || near[e.squad]) continue;
      const px = e.pos.x - p.x;
      const pz = e.pos.z - p.z;
      const ax = e.pos.x - a.x;
      const az = e.pos.z - a.z;
      if (px * px + pz * pz < r2 || ax * ax + az * az < r2) near[e.squad] = 1;
    }
    for (const e of s.enemies) {
      enemies++;
      if (e.aware === "engaged") engaged++;
      else if (e.squad >= 0 && near[e.squad]) calmNear++;
      else calmFar++;
    }
  }
  console.log(`raid sample ticks=${ticks} enemy_slots=${enemies} engaged=${engaged} calm_near=${calmNear} calm_far=${calmFar}`);
  console.log(`calm_far_share=${((100 * calmFar) / Math.max(1, enemies)).toFixed(1)}%  (FAR_THINK already skips 3/4 of these at every=4)`);
  for (const every of [1, 4, 8, 16]) {
    const full = calmNear + engaged + Math.ceil(calmFar / every);
    const base = calmNear + engaged + calmFar;
    console.log(`  every=${every}: relative_enemy_think≈${(full / base).toFixed(3)} of every=1`);
  }
}

/** separate()-shaped: naive O(n²) vs column sweep, N walkers. */
function separateShapes() {
  const Ns = [40, 80, 160, 320];
  for (const n of Ns) {
    const x = Float64Array.from({ length: n }, (_, i) => (i % 40) * 3 + Math.sin(i));
    const z = Float64Array.from({ length: n }, (_, i) => ((i / 40) | 0) * 3 + Math.cos(i));
    const cell = 8;
    const cx = Int32Array.from({ length: n }, (_, i) => Math.floor(x[i] / cell));
    const cz = Int32Array.from({ length: n }, (_, i) => Math.floor(z[i] / cell));
    const rounds = 2000;
    let pairsNaive = 0;
    const t0 = performance.now();
    for (let r = 0; r < rounds; r++) {
      for (let i = 0; i < n; i++)
        for (let j = i + 1; j < n; j++) {
          if (Math.abs(cx[i] - cx[j]) > 1 || Math.abs(cz[i] - cz[j]) > 1) continue;
          const dx = x[j] - x[i];
          const dz = z[j] - z[i];
          if (hypot2(dx, dz) < 1.5) pairsNaive++;
        }
    }
    const naiveMs = performance.now() - t0;

    let pairsSweep = 0;
    const order = Int32Array.from({ length: n }, (_, i) => i);
    const t1 = performance.now();
    for (let r = 0; r < rounds; r++) {
      order.sort((a, b) => cx[a] - cx[b] || a - b);
      for (let a = 0; a < n; a++) {
        const i = order[a];
        for (let b = a + 1; b < n; b++) {
          const j = order[b];
          if (cx[j] - cx[i] > 1) break;
          if (Math.abs(cz[i] - cz[j]) > 1) continue;
          const dx = x[j] - x[i];
          const dz = z[j] - z[i];
          if (hypot2(dx, dz) < 1.5) pairsSweep++;
        }
      }
    }
    const sweepMs = performance.now() - t1;
    console.log(`separate N=${n} rounds=${rounds} naive_ms=${naiveMs.toFixed(1)} sweep_ms=${sweepMs.toFixed(1)} speedup=${(naiveMs / sweepMs).toFixed(2)}x pairs=${pairsNaive}/${pairsSweep}`);
  }
}

/** Object AoS vs SoA typed access microbench (proxy for packing enemy state). */
function soaProxy() {
  const n = 200;
  const rounds = 200_000;
  const objs = Array.from({ length: n }, (_, i) => ({ x: i * 0.1, z: i * 0.2, hp: 100, aware: i % 3 }));
  const xs = Float64Array.from({ length: n }, (_, i) => i * 0.1);
  const zs = Float64Array.from({ length: n }, (_, i) => i * 0.2);
  const hp = Float64Array.from({ length: n }, () => 100);
  const aware = Uint8Array.from({ length: n }, (_, i) => i % 3);
  let acc = 0;
  const t0 = performance.now();
  for (let r = 0; r < rounds; r++) for (let i = 0; i < n; i++) acc += objs[i].x + objs[i].z + objs[i].hp + objs[i].aware;
  const aos = performance.now() - t0;
  acc = 0;
  const t1 = performance.now();
  for (let r = 0; r < rounds; r++) for (let i = 0; i < n; i++) acc += xs[i] + zs[i] + hp[i] + aware[i];
  const soa = performance.now() - t1;
  console.log(`AoS_vs_SoA n=${n} rounds=${rounds} aos_ms=${aos.toFixed(1)} soa_ms=${soa.toFixed(1)} speedup=${(aos / soa).toFixed(2)}x acc=${acc}`);
}

console.log("=== FAR_THINK share in one raid ===");
farThinkShare();
console.log("=== separate shapes ===");
separateShapes();
console.log("=== SoA proxy ===");
soaProxy();
// Baseline one raid CPU for context
const c0 = cpu();
playRaid("reservoir", "beginner", 0);
console.log(`context: one reservoir beginner raid cpu=${(cpu() - c0).toFixed(1)}s`);
