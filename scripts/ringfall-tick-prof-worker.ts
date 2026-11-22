/**
 * Child of ringfall-tick-prof.ts — enables section timers and runs a fixed sim.
 */
import "./ringfall-terrain-store";
import { Bot, SKILLS } from "../src/ringfall/sim/bot";
import { TICK } from "../src/ringfall/sim/config";
import { TICK_WASM } from "../src/ringfall/sim/native/tick-flag";
import { tickStatus, uploadGeom } from "../src/ringfall/sim/native/tick";
import {
  PROF_ON,
  profEnableWasm,
  profReset,
  profSnapshot,
} from "../src/ringfall/sim/native/tick-prof-host";
import { idleInput, newRun, starterKit } from "../src/ringfall/sim/state";
import { step } from "../src/ringfall/sim/step";
import { worldVersion } from "../src/ringfall/sim/geom";

const seconds = Number(process.env.RINGFALL_COST_SECONDS || 30);
const skill = SKILLS.find((k) => k.name === "good")!;
const s = newRun(1000, starterKit(), "reservoir");
const bot = new Bot(skill, 31);
let prev = false;

if (PROF_ON) {
  profReset();
  if (TICK_WASM) {
    // Ensure geom/exports exist before enabling Rust timers.
    uploadGeom(worldVersion, s.routes);
    profEnableWasm();
  }
}

const ticks = Math.round(seconds / TICK);
const cpu0 = process.cpuUsage();
const wall0 = Date.now();
for (let i = 0; i < ticks; i++) {
  const input = bot.input(s);
  step(s, input, prev);
  prev = !!input.crouch;
  if (s.phase === "done") break;
}
const cpu = process.cpuUsage(cpu0);
const snap = PROF_ON ? profSnapshot() : { ms: {}, counts: {} };

const out = {
  mode: process.env.RINGFALL_TICK === "1" ? "wasm" : "ts",
  tick_wasm: TICK_WASM,
  status: tickStatus(),
  seconds_asked: seconds,
  seconds_sim: s.time,
  ticks: Math.round(s.time / TICK),
  cpu_s: (cpu.user + cpu.system) / 1e6,
  wall_s: (Date.now() - wall0) / 1000,
  phase: s.phase,
  kills: s.stats.kills,
  damage: s.stats.damage,
  ms: snap.ms,
  counts: snap.counts,
};
console.log(JSON.stringify(out));
void idleInput;
