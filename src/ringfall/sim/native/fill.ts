/**
 * Optional WASM Dial fill for nav.ts (Node sim / bench only). Instantiates the committed
 * module in `fill-wasm.ts`. The browser always keeps the TypeScript fill (nav is bot-only
 * for players; Chromium automation stays on TS to avoid a large WASM heap). Disable in Node
 * with `RINGFALL_FILL=ts`.
 */
import { RINGFALL_FILL_WASM_BASE64 } from "./fill-wasm";

export type FillField = { d: Uint16Array; j0: number; lo: Int32Array; hi: Int32Array; off: Int32Array };

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
};

let exportsRef: Exports | null = null;
let engine = 0;
let engineNx = 0;
let engineNz = 0;
let movesEpoch = -1;
let loadTried = false;
let loadOk = false;

type NodeProcess = { env?: Record<string, string | undefined>; versions?: { node?: string } };

function nodeProcess(): NodeProcess | undefined {
  const g = globalThis as { process?: NodeProcess };
  return g.process;
}

function fillMode(): string | undefined {
  return nodeProcess()?.env?.RINGFALL_FILL;
}

function isNode(): boolean {
  return !!nodeProcess()?.versions?.node;
}

function envDisabled(): boolean {
  if (!isNode()) return true;
  const v = fillMode();
  return v === "0" || v === "ts" || v === "off" || v === "false";
}

/** When `RINGFALL_FILL=check`, callers compare WASM against TS and throw on mismatch. */
export function fillCheckMode(): boolean {
  return fillMode() === "check";
}

function decodeWasm(): Uint8Array {
  const bin = atob(RINGFALL_FILL_WASM_BASE64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function tryLoad(): boolean {
  if (loadTried) return loadOk;
  loadTried = true;
  if (envDisabled()) return (loadOk = false);
  try {
    const bytes = decodeWasm();
    // Copy into a plain ArrayBuffer: some DOM typings reject SharedArrayBuffer-backed views.
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const mod = new WebAssembly.Module(copy.buffer);
    const inst = new WebAssembly.Instance(mod, {});
    exportsRef = inst.exports as unknown as Exports;
    loadOk = true;
  } catch {
    loadOk = false;
  }
  return loadOk;
}

function viewU8(ptr: number, len: number): Uint8Array {
  return new Uint8Array(exportsRef!.memory.buffer, ptr, len);
}

function viewI32(ptr: number, len: number): Int32Array {
  return new Int32Array(exportsRef!.memory.buffer, ptr, len);
}

function viewU16(ptr: number, len: number): Uint16Array {
  return new Uint16Array(exportsRef!.memory.buffer, ptr, len);
}

function ensureEngine(nx: number, nz: number): boolean {
  if (!tryLoad() || !exportsRef) return false;
  if (engine && (engineNx !== nx || engineNz !== nz)) {
    exportsRef.ringfall_fill_free(engine);
    engine = 0;
    movesEpoch = -1;
  }
  if (!engine) {
    engine = exportsRef.ringfall_fill_new(nx, nz);
    if (!engine) return false;
    engineNx = nx;
    engineNz = nz;
  }
  return true;
}

/** Sync the move mask into WASM when `epoch` changes (nav rebuild). */
export function syncFillMoves(nx: number, nz: number, moves: Uint8Array, epoch: number): boolean {
  if (!ensureEngine(nx, nz) || !exportsRef) return false;
  if (movesEpoch === epoch) return true;
  const len = exportsRef.ringfall_fill_moves_len(engine);
  if (len !== moves.length) return false;
  viewU8(exportsRef.ringfall_fill_moves_ptr(engine), len).set(moves);
  movesEpoch = epoch;
  return true;
}

export function wasmFillAvailable(): boolean {
  return tryLoad();
}

/**
 * Packed landmark field, or null when WASM is unavailable / failed.
 * `disk` null is a plain walk; otherwise avoid-disk costs match nav.ts.
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
): FillField | null {
  if (!syncFillMoves(nx, nz, moves, epoch) || !exportsRef) return null;
  const rc = exportsRef.ringfall_fill_run(
    engine,
    from,
    reach,
    disk ? 1 : 0,
    disk?.x ?? 0,
    disk?.z ?? 0,
    disk?.r ?? 0,
    world.x0,
    world.z0,
    world.res,
  );
  if (rc !== 0) return null;
  const rows = exportsRef.ringfall_fill_rows(engine);
  const size = exportsRef.ringfall_fill_size(engine);
  const j0 = exportsRef.ringfall_fill_j0(engine);
  // Copy out: WASM memory may grow on the next fill and detach these views.
  const lo = Int32Array.from(viewI32(exportsRef.ringfall_fill_lo_ptr(engine), rows));
  const hi = Int32Array.from(viewI32(exportsRef.ringfall_fill_hi_ptr(engine), rows));
  const off = Int32Array.from(viewI32(exportsRef.ringfall_fill_off_ptr(engine), rows));
  const d = Uint16Array.from(viewU16(exportsRef.ringfall_fill_d_ptr(engine), size));
  return { d, j0, lo, hi, off };
}
