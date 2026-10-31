/**
 * A disk store for RINGFALL's built terrain field (`TerrainStore` in sim/terrain.ts), for the sim
 * gate's processes: building the field is most of loading the map, and every worker builds the
 * same one. Imported first by the scripts that load the map, before the map is evaluated. The key
 * is the flat shapes handed to `buildTerrain()` and every source file of the sim, so any change
 * to the sim builds the field afresh; old files are left to be cleared with node_modules/.cache.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { useTerrainStore, type FlatShape, type TerrainArrays } from "../src/ringfall/sim/terrain";

const SIM = fileURLToPath(new URL("../src/ringfall/sim/", import.meta.url));
const DIR = fileURLToPath(new URL("../node_modules/.cache/ringfall-terrain/", import.meta.url));
const NAMES = ["field", "floors", "shapes", "bases", "steep", "between"] as const;

/** The sim's sources, hashed once per process. */
const source = (() => {
  const h = createHash("sha256");
  for (const f of readdirSync(SIM).filter((n) => n.endsWith(".ts")).sort()) h.update(f).update(readFileSync(join(SIM, f)));
  return h.digest("hex");
})();
const fileOf = (flat: FlatShape[]) => join(DIR, `${createHash("sha256").update(source).update(JSON.stringify(flat)).digest("hex").slice(0, 32)}.bin`);

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
