/**
 * One-shot worker for ringfall-fill-ab.mjs: builds landmark fields (via findPath) and
 * writes a JSON summary to argv[2]. RINGFALL_FILL=ts forces the TypeScript fill.
 */
import "./ringfall-terrain-store";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { ENTRIES, POIS } from "../src/ringfall/sim/map";
import { findPath, resetNav } from "../src/ringfall/sim/nav";
import { wasmFillAvailable } from "../src/ringfall/sim/native/fill";

const from = ENTRIES[0];
const to = POIS.find((p) => p.id === "quarry") ?? POIS[1];

resetNav();
const t0 = process.cpuUsage();
const path = findPath(from.x, from.z, to.x, to.z);
const cpu = process.cpuUsage(t0);
const out = process.argv[2];
const mode = process.env.RINGFALL_FILL === "ts" ? "ts" : "wasm";
writeFileSync(
  out,
  JSON.stringify({
    mode,
    wasm: wasmFillAvailable(),
    pts: path?.length ?? 0,
    cpu_ms: (cpu.user + cpu.system) / 1e3,
    path_hash: createHash("sha256").update(JSON.stringify(path)).digest("hex").slice(0, 16),
  }),
);
