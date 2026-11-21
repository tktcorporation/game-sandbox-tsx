/**
 * A disk store for RINGFALL's built terrain field (`TerrainStore` in sim/terrain.ts) and the
 * walkers' grids with the landmarks' plain fields (`NavStore` in sim/nav.ts), for the sim gate's
 * processes: building them is most of loading the map and the first path of a process, and every
 * worker builds the same ones. Imported first by the scripts that load the map, before the map is
 * evaluated. The key is the flat shapes handed to `buildTerrain()` and every source file of the
 * sim, so any change to the sim builds them afresh; old files are left to be cleared with
 * node_modules/.cache.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { useTerrainStore, type FlatShape, type TerrainArrays } from "../src/ringfall/sim/terrain";
import { useNavStore, type NavArrays, type NavFieldPack } from "../src/ringfall/sim/nav";

const SIM = fileURLToPath(new URL("../src/ringfall/sim/", import.meta.url));
const DIR = fileURLToPath(new URL("../node_modules/.cache/ringfall-terrain/", import.meta.url));
const NAV_DIR = fileURLToPath(new URL("../node_modules/.cache/ringfall-nav/", import.meta.url));
const NAMES = ["field", "floors", "shapes", "bases", "steep", "between"] as const;

/** The sim's sources, hashed once per process. */
const source = (() => {
  const h = createHash("sha256");
  for (const f of readdirSync(SIM).filter((n) => n.endsWith(".ts")).sort()) h.update(f).update(readFileSync(join(SIM, f)));
  return h.digest("hex");
})();
const fileOf = (flat: FlatShape[]) => join(DIR, `${createHash("sha256").update(source).update(JSON.stringify(flat)).digest("hex").slice(0, 32)}.bin`);
const navFile = join(NAV_DIR, `${createHash("sha256").update(source).update("nav-v1").digest("hex").slice(0, 32)}.bin`);

useTerrainStore({
  load(flat) {
    const file = fileOf(flat);
    if (!existsSync(file)) return null;
    const buf = readFileSync(file);
    // Six arrays, each a byte length then its bytes, in the order of NAMES.
    let at = 0;
    const next = () => {
      const len = buf.readUInt32LE(at);
      const bytes = new Uint8Array(len);
      bytes.set(buf.subarray(at + 4, at + 4 + len));
      at += 4 + len;
      return bytes;
    };
    const f32 = () => new Float32Array(next().buffer);
    return { field: f32(), floors: f32(), shapes: next(), bases: f32(), steep: next(), between: f32() };
  },
  save(flat, built) {
    const parts: Buffer[] = [];
    for (const n of NAMES) {
      const a = built[n];
      const len = Buffer.alloc(4);
      len.writeUInt32LE(a.byteLength);
      parts.push(len, Buffer.from(a.buffer, a.byteOffset, a.byteLength));
    }
    mkdirSync(DIR, { recursive: true });
    // Written aside and renamed, so a worker reading it at the same moment never sees half a file.
    const file = fileOf(flat);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, Buffer.concat(parts));
    renameSync(tmp, file);
  },
});

/** Reads a length-prefixed byte slice from `buf` at `at`, advancing `at`. */
function readBytes(buf: Buffer, at: { n: number }): Uint8Array {
  const len = buf.readUInt32LE(at.n);
  const bytes = new Uint8Array(len);
  bytes.set(buf.subarray(at.n + 4, at.n + 4 + len));
  at.n += 4 + len;
  return bytes;
}

function writeBytes(parts: Buffer[], a: Uint8Array | Uint16Array | Int32Array) {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(a.byteLength);
  parts.push(len, Buffer.from(a.buffer, a.byteOffset, a.byteLength));
}

function readField(buf: Buffer, at: { n: number }): NavFieldPack | null {
  const tag = buf.readUInt8(at.n++);
  if (!tag) return null;
  const j0 = buf.readInt32LE(at.n);
  at.n += 4;
  const lo = new Int32Array(readBytes(buf, at).buffer);
  const hi = new Int32Array(readBytes(buf, at).buffer);
  const off = new Int32Array(readBytes(buf, at).buffer);
  const d = new Uint16Array(readBytes(buf, at).buffer);
  return { d, j0, lo, hi, off };
}

function writeField(parts: Buffer[], f: NavFieldPack | null) {
  parts.push(Buffer.from([f ? 1 : 0]));
  if (!f) return;
  const j0 = Buffer.alloc(4);
  j0.writeInt32LE(f.j0);
  parts.push(j0);
  writeBytes(parts, f.lo);
  writeBytes(parts, f.hi);
  writeBytes(parts, f.off);
  writeBytes(parts, f.d);
}

useNavStore({
  load() {
    if (!existsSync(navFile)) return null;
    const buf = readFileSync(navFile);
    const at = { n: 0 };
    const grid = readBytes(buf, at);
    const moves = readBytes(buf, at);
    const areaBytes = buf.readUInt8(at.n++) as 2 | 4;
    const area = readBytes(buf, at);
    const clearance = readBytes(buf, at);
    const landmarkCells = new Int32Array(readBytes(buf, at).buffer);
    const n = buf.readUInt16LE(at.n);
    at.n += 2;
    const fields: (NavFieldPack | null)[] = [];
    for (let i = 0; i < n; i++) fields.push(readField(buf, at));
    return { grid, moves, areaBytes, area, clearance, landmarkCells, fields };
  },
  save(built: NavArrays) {
    const parts: Buffer[] = [];
    writeBytes(parts, built.grid);
    writeBytes(parts, built.moves);
    parts.push(Buffer.from([built.areaBytes]));
    writeBytes(parts, built.area);
    writeBytes(parts, built.clearance);
    writeBytes(parts, built.landmarkCells);
    const n = Buffer.alloc(2);
    n.writeUInt16LE(built.fields.length);
    parts.push(n);
    for (const f of built.fields) writeField(parts, f);
    mkdirSync(NAV_DIR, { recursive: true });
    const tmp = `${navFile}.${process.pid}.tmp`;
    writeFileSync(tmp, Buffer.concat(parts));
    renameSync(tmp, navFile);
  },
});
