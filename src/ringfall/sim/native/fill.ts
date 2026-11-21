/**
 * Optional WASM Dial fill + A* for nav.ts (Node sim / bench only). Instantiates the committed
 * module in `fill-wasm.ts`. Browser keeps TypeScript. `RINGFALL_FILL=ts` / `RINGFALL_ASTAR=ts`
 * force TS. Weighted (avoid-disk) fills stay on TS — WASM was slower on warm raids.
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
const fillMode = () => nodeProcess()?.env?.RINGFALL_FILL;
const astarMode = () => nodeProcess()?.env?.RINGFALL_ASTAR;
const isNode = () => !!nodeProcess()?.versions?.node;

function envDisabled(): boolean {
  if (!isNode()) return true;
  const v = fillMode();
  return v === "0" || v === "ts" || v === "off" || v === "false";
}

export const fillCheckMode = () => fillMode() === "check";
export const astarCheckMode = () => astarMode() === "check";

function tryLoad(): boolean {
  if (loadTried) return loadOk;
  loadTried = true;
  if (envDisabled()) return (loadOk = false);
  try {
    const bin = atob(RINGFALL_FILL_WASM_BASE64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
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
/** A* WASM is opt-in: set `RINGFALL_ASTAR=1` (or `wasm` / `check`). Default stays TypeScript — warm profiles showed WASM A* slower once field uploads and the scratch grid are counted. */
export function wasmAstarAvailable(): boolean {
  const v = astarMode();
  if (v !== "1" && v !== "wasm" && v !== "on" && v !== "check") return false;
  return tryLoad();
}

export function setNavWorld(nx: number, nz: number, world: { x0: number; z0: number; res: number }, reach: number): boolean {
  if (!ensureEngine(nx, nz) || !exportsRef) return false;
  exportsRef.ringfall_nav_set_world(engine, world.x0, world.z0, world.res, reach);
  worldSet = true;
  return true;
}

/** Upload a packed field into a WASM slot for A* heuristics. */
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
  const lo = Int32Array.from(viewI32(exportsRef.ringfall_fill_lo_ptr(engine), rows));
  const hi = Int32Array.from(viewI32(exportsRef.ringfall_fill_hi_ptr(engine), rows));
  const off = Int32Array.from(viewI32(exportsRef.ringfall_fill_off_ptr(engine), rows));
  const d = Uint16Array.from(viewU16(exportsRef.ringfall_fill_d_ptr(engine), size));
  if (slot >= 0) exportsRef.ringfall_nav_store_last(engine, slot);
  return { d, j0, lo, hi, off };
}

/**
 * Cell path. `undefined` = WASM not used (caller should run TS);
 * `null` = unreachable; array = path.
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
