/**
 * Loads the committed WASM embed the way the browser and Node do (base64 → Instance)
 * and checks the coarse ABI exports. No map import — stays fast for CI-adjacent smoke.
 *
 *   node scripts/ringfall-native-smoke.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const embedPath = fileURLToPath(new URL("../src/ringfall/sim/native/fill-wasm.ts", import.meta.url));
const src = readFileSync(embedPath, "utf8");
const m = src.match(/RINGFALL_FILL_WASM_BASE64 = "([A-Za-z0-9+/=]+)"/);
if (!m) {
  console.error("ringfall-native-smoke: missing base64 embed");
  process.exit(1);
}
const bytes = Buffer.from(m[1], "base64");
const copy = new Uint8Array(bytes.byteLength);
copy.set(bytes);
const inst = new WebAssembly.Instance(new WebAssembly.Module(copy.buffer), {});
const ex = inst.exports;
const need = [
  "ringfall_fill_new",
  "ringfall_nav_astar",
  "ringfall_sim_abi_version",
  "ringfall_step_tick",
  "memory",
];
for (const n of need) {
  if (!(n in ex)) {
    console.error(`ringfall-native-smoke: missing export ${n}`);
    process.exit(1);
  }
}
const abi = ex.ringfall_sim_abi_version();
if (abi < 4) {
  console.error(`ringfall-native-smoke: unexpected abi ${abi} (want >= 4)`);
  process.exit(1);
}
if (typeof ex.ringfall_sim_step_tick !== "function" || typeof ex.ringfall_sim_los !== "function") {
  console.error("ringfall-native-smoke: missing tick host exports");
  process.exit(1);
}
if (typeof ex.ringfall_sim_set_combat !== "function" || typeof ex.ringfall_sim_squads_begin !== "function") {
  console.error("ringfall-native-smoke: missing ABI 3 combat exports");
  process.exit(1);
}
if (
  typeof ex.ringfall_sim_robot_via_x_ptr !== "function" ||
  typeof ex.ringfall_sim_robot_skip_ptr !== "function"
) {
  console.error("ringfall-native-smoke: missing ABI 4 via/skip exports");
  process.exit(1);
}
// Without geom, step_tick returns -1 (not ready).
const stub = ex.ringfall_step_tick(0);
if (stub !== -1) {
  console.error(`ringfall-native-smoke: step_tick without geom should be -1, got ${stub}`);
  process.exit(1);
}
const eng = ex.ringfall_fill_new(32, 32);
if (!eng) {
  console.error("ringfall-native-smoke: fill_new failed");
  process.exit(1);
}
ex.ringfall_fill_free(eng);
console.log(`ringfall-native-smoke: ok abi=${abi} step_tick_unready=${stub} bytes=${bytes.length}`);
