/**
 * Shared WASM nav kernel for browser + Node (docs/ringfall/native.md).
 * Instantiates the committed embed in `fill-wasm.ts`. State (moves, fields, A* scratch, path)
 * lives in WASM linear memory; JS calls coarse fill / find-path entry points.
 *
 * Disable: `?ringfallNative=0`, localStorage `ringfallNative=0`, or `RINGFALL_FILL=ts`.
 * A* opt-in: `?ringfallAstar=1` / `RINGFALL_ASTAR=1`. Weighted Dial fills stay on TypeScript.
 */
import { RINGFALL_FILL_WASM_BASE64 } from "./fill-wasm";

export type FillField = { d: Uint16Array; j0: number; lo: Int32Array; hi: Int32Array; off: Int32Array };
export type AstarLandmark = { slot: number; round: boolean };

type Exports = {
  memory: WebAssembly.Memory;
  ringfall_fill_new(nx: number, nz: number): number;
  ringfall_fill_free(e: number): void;
  ringfall_fill_moves_ptr(e: number): number;
  ringfall_fill_moves_len(e: number): number;
  ringfall_fill_run(
    e: number,
    from: number,
    reach: number,
    has_disk: number,
    disk_x: number,
    disk_z: number,
    disk_r: number,
    wx0: number,
    wz0: number,
    res: number,
  ): number;
  ringfall_fill_j0(e: number): number;
  ringfall_fill_rows(e: number): number;
  ringfall_fill_size(e: number): number;
  ringfall_fill_lo_ptr(e: number): number;
  ringfall_fill_hi_ptr(e: number): number;
  ringfall_fill_off_ptr(e: number): number;
  ringfall_fill_d_ptr(e: number): number;
  ringfall_nav_set_world(e: number, wx0: number, wz0: number, res: number, reach: number): void;
  ringfall_nav_store_last(e: number, slot: number): void;
  ringfall_nav_lm_slot_ptr(e: number): number;
  ringfall_nav_lm_round_ptr(e: number): number;
  ringfall_nav_upload_begin(e: number, rows: number, size: number): number;
  ringfall_nav_upload_lo_ptr(e: number): number;
  ringfall_nav_upload_hi_ptr(e: number): number;
  ringfall_nav_upload_off_ptr(e: number): number;
  ringfall_nav_upload_d_ptr(e: number): number;
  ringfall_nav_upload_commit(e: number, slot: number, j0: number): number;
  ringfall_nav_astar(
    e: number,
    start: number,
    goal: number,
    si: number,
    sj: number,
    gi: number,
    gj: number,
    has_avoid: number,
    avoid_x: number,
    avoid_z: number,
    avoid_r: number,
    lm_n: number,
  ): number;
  ringfall_nav_path_len(e: number): number;
  ringfall_nav_path_ptr(e: number): number;
  ringfall_sim_abi_version(): number;
  ringfall_step_tick(dt: number): number;
  // Tick host (sim module) — present from ABI 2.
  ringfall_sim_reset?(): void;
  ringfall_sim_terrain_begin?(nx: number, nz: number, x0: number, z0: number, res: number): number;
  ringfall_sim_terrain_commit?(): void;
  ringfall_sim_boxes_begin?(n: number): number;
  ringfall_sim_boxes_commit?(): void;
  ringfall_sim_set_player?(
    x: number,
    y: number,
    z: number,
    crouch: number,
    sliding: number,
    ax: number,
    ay: number,
    az: number,
    ally_up: number,
    wipes: number,
  ): void;
  ringfall_sim_set_combat?(
    pvx: number,
    pvy: number,
    pvz: number,
    avx: number,
    avy: number,
    avz: number,
    player_downed: number,
    phase_play: number,
    sight_scale: number,
    threat_range: number,
    rng: number,
    next_id: number,
  ): void;
  ringfall_sim_get_rng?(): number;
  ringfall_sim_get_next_id?(): number;
  ringfall_sim_squads_begin?(n: number): number;
  ringfall_sim_robots_begin?(n: number): number;
  ringfall_sim_robot_x_ptr?(): number;
  ringfall_sim_robot_y_ptr?(): number;
  ringfall_sim_robot_z_ptr?(): number;
  ringfall_sim_robot_yaw_ptr?(): number;
  ringfall_sim_robot_vx_ptr?(): number;
  ringfall_sim_robot_vy_ptr?(): number;
  ringfall_sim_robot_vz_ptr?(): number;
  ringfall_sim_robot_hp_ptr?(): number;
  ringfall_sim_robot_shield_ptr?(): number;
  ringfall_sim_robot_duck_ptr?(): number;
  ringfall_sim_robot_id_ptr?(): number;
  ringfall_sim_robot_kind_ptr?(): number;
  ringfall_sim_robot_mode_ptr?(): number;
  ringfall_sim_robot_flags_ptr?(): number;
  ringfall_sim_robot_radius_ptr?(): number;
  ringfall_sim_robot_body_h_ptr?(): number;
  ringfall_sim_robot_side_ptr?(): number;
  ringfall_sim_robot_aware_ptr?(): number;
  ringfall_sim_robot_detect_ptr?(): number;
  ringfall_sim_robot_finding_ptr?(): number;
  ringfall_sim_robot_blind_ptr?(): number;
  ringfall_sim_robot_saw_x_ptr?(): number;
  ringfall_sim_robot_saw_z_ptr?(): number;
  ringfall_sim_robot_has_saw_ptr?(): number;
  ringfall_sim_robot_timer_ptr?(): number;
  ringfall_sim_robot_cooldown_ptr?(): number;
  ringfall_sim_robot_shots_left_ptr?(): number;
  ringfall_sim_robot_strafe_ptr?(): number;
  ringfall_sim_robot_strafe_t_ptr?(): number;
  ringfall_sim_robot_jink_ptr?(): number;
  ringfall_sim_robot_steady_ptr?(): number;
  ringfall_sim_robot_stagger_ptr?(): number;
  ringfall_sim_robot_aim_yaw_ptr?(): number;
  ringfall_sim_robot_aim_pitch_ptr?(): number;
  ringfall_sim_robot_opener_ptr?(): number;
  ringfall_sim_robot_peek_side_ptr?(): number;
  ringfall_sim_robot_cover_t_ptr?(): number;
  ringfall_sim_robot_elite_ptr?(): number;
  ringfall_sim_robot_target_ptr?(): number;
  ringfall_sim_robot_target_t_ptr?(): number;
  ringfall_sim_robot_squad_ptr?(): number;
  ringfall_sim_robot_friend_id_ptr?(): number;
  ringfall_sim_robot_poi_ptr?(): number;
  ringfall_sim_robot_last_hit_ptr?(): number;
  ringfall_sim_robot_fired_ptr?(): number;
  ringfall_sim_robot_ally_hit_ptr?(): number;
  ringfall_sim_robot_home_x_ptr?(): number;
  ringfall_sim_robot_home_y_ptr?(): number;
  ringfall_sim_robot_home_z_ptr?(): number;
  ringfall_sim_robot_goal_x_ptr?(): number;
  ringfall_sim_robot_goal_z_ptr?(): number;
  ringfall_sim_robot_has_goal_ptr?(): number;
  ringfall_sim_robot_search_t_ptr?(): number;
  ringfall_sim_squad_since_seen_ptr?(): number;
  ringfall_sim_squad_shot_t_ptr?(): number;
  ringfall_sim_squad_last_x_ptr?(): number;
  ringfall_sim_squad_last_z_ptr?(): number;
  ringfall_sim_squad_chase_x_ptr?(): number;
  ringfall_sim_squad_chase_z_ptr?(): number;
  ringfall_sim_squad_has_chase_ptr?(): number;
  ringfall_sim_squad_chase_t_ptr?(): number;
  ringfall_sim_squad_pin_t_ptr?(): number;
  ringfall_sim_squad_sight_ptr?(): number;
  ringfall_sim_squad_flags_ptr?(): number;
  ringfall_sim_orbs_begin?(n: number): number;
  ringfall_sim_orb_x_ptr?(): number;
  ringfall_sim_orb_y_ptr?(): number;
  ringfall_sim_orb_z_ptr?(): number;
  ringfall_sim_orb_vx_ptr?(): number;
  ringfall_sim_orb_vy_ptr?(): number;
  ringfall_sim_orb_vz_ptr?(): number;
  ringfall_sim_orb_r_ptr?(): number;
  ringfall_sim_orb_dmg_ptr?(): number;
  ringfall_sim_orb_life_ptr?(): number;
  ringfall_sim_orb_flags_ptr?(): number;
  ringfall_sim_orb_by_ptr?(): number;
  ringfall_sim_orb_side_ptr?(): number;
  ringfall_sim_orb_alive_ptr?(): number;
  ringfall_sim_set_ready?(ready: number): void;
  ringfall_sim_n_robots?(): number;
  ringfall_sim_n_orbs?(): number;
  ringfall_sim_hits_len?(): number;
  ringfall_sim_hits_ptr?(): number;
  ringfall_sim_los?(ax: number, ay: number, az: number, bx: number, by: number, bz: number, paths: number): number;
  ringfall_sim_step_tick?(dt: number): number;
};

let exportsRef: Exports | null = null;
let engine = 0;
let engineNx = 0;
let engineNz = 0;
let movesEpoch = -1;
let loadTried = false;
let loadOk = false;
let worldSet = false;

type NodeProcess = { env?: Record<string, string | undefined>; versions?: { node?: string } };
const nodeProcess = (): NodeProcess | undefined => (globalThis as { process?: NodeProcess }).process;

function queryFlag(name: string): string | undefined {
  try {
    if (typeof location === "undefined") return undefined;
    return new URLSearchParams(location.search).get(name) ?? undefined;
  } catch {
    return undefined;
  }
}

function storageFlag(name: string): string | undefined {
  try {
    if (typeof localStorage === "undefined") return undefined;
    return localStorage.getItem(name) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Unified switch: URL → localStorage → env (Node). */
function flag(name: string, envNames: string[]): string | undefined {
  const q = queryFlag(name);
  if (q != null) return q;
  const s = storageFlag(name);
  if (s != null) return s;
  const env = nodeProcess()?.env;
  if (!env) return undefined;
  for (const k of envNames) if (env[k] != null) return env[k];
  return undefined;
}

function isOff(v: string | undefined): boolean {
  return v === "0" || v === "ts" || v === "off" || v === "false";
}

function nativeDisabled(): boolean {
  return isOff(flag("ringfallNative", ["RINGFALL_NATIVE", "RINGFALL_FILL"]));
}

export const fillCheckMode = () => flag("ringfallNative", ["RINGFALL_FILL"]) === "check";
export const astarCheckMode = () => flag("ringfallAstar", ["RINGFALL_ASTAR"]) === "check";

function decodeWasm(): Uint8Array {
  const bin = atob(RINGFALL_FILL_WASM_BASE64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function tryLoad(): boolean {
  if (loadTried) return loadOk;
  loadTried = true;
  if (nativeDisabled()) return (loadOk = false);
  try {
    const bytes = decodeWasm();
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    exportsRef = new WebAssembly.Instance(new WebAssembly.Module(copy.buffer), {}).exports as unknown as Exports;
    loadOk = true;
  } catch {
    loadOk = false;
  }
  return loadOk;
}

const viewU8 = (ptr: number, len: number) => new Uint8Array(exportsRef!.memory.buffer, ptr, len);
const viewI32 = (ptr: number, len: number) => new Int32Array(exportsRef!.memory.buffer, ptr, len);
const viewU16 = (ptr: number, len: number) => new Uint16Array(exportsRef!.memory.buffer, ptr, len);

function ensureEngine(nx: number, nz: number): boolean {
  if (!tryLoad() || !exportsRef) return false;
  if (engine && (engineNx !== nx || engineNz !== nz)) {
    exportsRef.ringfall_fill_free(engine);
    engine = 0;
    movesEpoch = -1;
    worldSet = false;
  }
  if (!engine) {
    engine = exportsRef.ringfall_fill_new(nx, nz);
    if (!engine) return false;
    engineNx = nx;
    engineNz = nz;
  }
  return true;
}

export function syncFillMoves(nx: number, nz: number, moves: Uint8Array, epoch: number): boolean {
  if (!ensureEngine(nx, nz) || !exportsRef) return false;
  if (movesEpoch === epoch) return true;
  const len = exportsRef.ringfall_fill_moves_len(engine);
  if (len !== moves.length) return false;
  viewU8(exportsRef.ringfall_fill_moves_ptr(engine), len).set(moves);
  movesEpoch = epoch;
  return true;
}

export const wasmFillAvailable = () => tryLoad();

/**
 * A* WASM is opt-in (`?ringfallAstar=1` / `RINGFALL_ASTAR=1` / `wasm` / `check`).
 * Warm bench is ~1.3× slower with WASM A* vs TS (field uploads + scratch); keep the
 * in-WASM path for identity checks and the future tick host, default stays TypeScript.
 */
export function wasmAstarAvailable(): boolean {
  const v = flag("ringfallAstar", ["RINGFALL_ASTAR"]);
  if (v !== "1" && v !== "wasm" && v !== "on" && v !== "check") return false;
  return tryLoad();
}

/** Shared WASM exports (nav + tick). One Instance for browser and Node. */
export function nativeExports(): Exports | null {
  return tryLoad() ? exportsRef : null;
}

export function nativeStatus(): {
  wasm: boolean;
  astar: boolean;
  abi: number | null;
  stepTick: number | null;
} {
  const wasm = tryLoad();
  let abi: number | null = null;
  let stepTick: number | null = null;
  if (wasm && exportsRef) {
    abi = exportsRef.ringfall_sim_abi_version();
    stepTick = exportsRef.ringfall_step_tick(0);
  }
  return { wasm, astar: wasmAstarAvailable(), abi, stepTick };
}

export function setNavWorld(nx: number, nz: number, world: { x0: number; z0: number; res: number }, reach: number): boolean {
  if (!ensureEngine(nx, nz) || !exportsRef) return false;
  exportsRef.ringfall_nav_set_world(engine, world.x0, world.z0, world.res, reach);
  worldSet = true;
  return true;
}

/** Upload a packed field into a WASM slot for A* heuristics (stays in linear memory). */
export function uploadNavField(nx: number, nz: number, slot: number, field: FillField): boolean {
  if (!ensureEngine(nx, nz) || !exportsRef || slot < 0 || slot >= 64) return false;
  const rows = field.lo.length;
  const size = field.d.length;
  if (exportsRef.ringfall_nav_upload_begin(engine, rows, size) !== 0) return false;
  viewI32(exportsRef.ringfall_nav_upload_lo_ptr(engine), rows).set(field.lo);
  viewI32(exportsRef.ringfall_nav_upload_hi_ptr(engine), rows).set(field.hi);
  viewI32(exportsRef.ringfall_nav_upload_off_ptr(engine), rows).set(field.off);
  viewU16(exportsRef.ringfall_nav_upload_d_ptr(engine), size).set(field.d);
  return exportsRef.ringfall_nav_upload_commit(engine, slot, field.j0) === 0;
}

/**
 * Plain landmark Dial fill (no avoid-disk). Weighted fills return null → TypeScript path.
 * Packed result is also stored in-WASM when `slot >= 0` (no second upload needed for A*).
 */
export function wasmFill(
  nx: number,
  nz: number,
  moves: Uint8Array,
  epoch: number,
  from: number,
  reach: number,
  disk: { x: number; z: number; r: number } | null,
  world: { x0: number; z0: number; res: number },
  slot = -1,
): FillField | null {
  if (disk) return null;
  if (!syncFillMoves(nx, nz, moves, epoch) || !exportsRef) return null;
  if (!worldSet) setNavWorld(nx, nz, world, reach);
  if (exportsRef.ringfall_fill_run(engine, from, reach, 0, 0, 0, 0, world.x0, world.z0, world.res) !== 0) return null;
  const rows = exportsRef.ringfall_fill_rows(engine);
  const size = exportsRef.ringfall_fill_size(engine);
  const j0 = exportsRef.ringfall_fill_j0(engine);
  // Copy once for JS NavStore / fieldAt; engine also keeps the slot for A*.
  const lo = Int32Array.from(viewI32(exportsRef.ringfall_fill_lo_ptr(engine), rows));
  const hi = Int32Array.from(viewI32(exportsRef.ringfall_fill_hi_ptr(engine), rows));
  const off = Int32Array.from(viewI32(exportsRef.ringfall_fill_off_ptr(engine), rows));
  const d = Uint16Array.from(viewU16(exportsRef.ringfall_fill_d_ptr(engine), size));
  if (slot >= 0) exportsRef.ringfall_nav_store_last(engine, slot);
  return { d, j0, lo, hi, off };
}

/**
 * Cell path. `undefined` = WASM not used; `null` = unreachable; array = path
 * (copied once out of WASM path buffer).
 */
export function wasmAstar(
  nx: number,
  nz: number,
  moves: Uint8Array,
  epoch: number,
  start: number,
  goal: number,
  si: number,
  sj: number,
  gi: number,
  gj: number,
  avoid: { x: number; z: number; r: number } | null,
  landmarks: AstarLandmark[],
  world: { x0: number; z0: number; res: number },
  reach: number,
): number[] | null | undefined {
  if (!wasmAstarAvailable()) return undefined;
  if (!syncFillMoves(nx, nz, moves, epoch) || !exportsRef) return undefined;
  if (!worldSet) setNavWorld(nx, nz, world, reach);
  const n = Math.min(8, landmarks.length);
  const slots = viewU8(exportsRef.ringfall_nav_lm_slot_ptr(engine), 8);
  const rounds = viewU8(exportsRef.ringfall_nav_lm_round_ptr(engine), 8);
  for (let i = 0; i < n; i++) {
    slots[i] = landmarks[i].slot & 255;
    rounds[i] = landmarks[i].round ? 1 : 0;
  }
  const rc = exportsRef.ringfall_nav_astar(
    engine,
    start,
    goal,
    si,
    sj,
    gi,
    gj,
    avoid ? 1 : 0,
    avoid?.x ?? 0,
    avoid?.z ?? 0,
    avoid?.r ?? 0,
    n,
  );
  if (rc < 0) return undefined;
  if (rc === 0) return null;
  const len = exportsRef.ringfall_nav_path_len(engine);
  return Array.from(viewI32(exportsRef.ringfall_nav_path_ptr(engine), len));
}
