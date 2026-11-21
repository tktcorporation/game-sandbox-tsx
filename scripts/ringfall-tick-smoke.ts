/**
 * Short raid under RINGFALL_TICK=1 — must not crash.
 *   RINGFALL_TICK=1 npx tsx scripts/ringfall-tick-smoke.ts
 */
import "./ringfall-terrain-store";
import { idleInput, newRun, starterKit } from "../src/ringfall/sim/state";
import { step } from "../src/ringfall/sim/step";
import { TICK_WASM } from "../src/ringfall/sim/native/tick-flag";
import { tickStatus } from "../src/ringfall/sim/native/tick";

console.log("tick-smoke: TICK_WASM=", TICK_WASM, tickStatus());
if (!TICK_WASM) {
  console.error("tick-smoke: expected RINGFALL_TICK=1");
  process.exit(1);
}

const s = newRun(42, starterKit(), "reservoir");
s.phase = "play";
try {
  for (let t = 0; t < 1800; t++) {
    step(s, { ...idleInput(), moveZ: 1, sprint: t % 120 < 60 }, false);
    if (s.phase === "done") break;
  }
} catch (err) {
  console.error("tick-smoke: CRASH", err);
  process.exit(1);
}

const st = tickStatus();
console.log(
  `tick-smoke: ok time=${s.time.toFixed(1)} phase=${s.phase} enemies=${s.enemies.length} orbs=${s.orbs.length} engaged=${s.squads.filter((q) => q.engaged).length} abi=${st.abi} geom=${st.geom}`,
);
if (!st.geom || st.abi == null || st.abi < 3) {
  console.error("tick-smoke: tick host did not engage (geom/abi)");
  process.exit(1);
}
