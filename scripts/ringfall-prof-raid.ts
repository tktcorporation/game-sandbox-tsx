/**
 * Warms one reservoir beginner raid, then CPU-profiles only the next raid (V8 Profiler).
 * Writes `/tmp/ringfall-prof/warm.cpuprofile` and prints a short self-time summary.
 */
import "./ringfall-terrain-store";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { playRaid } from "./ringfall-table";

const outDir = "/tmp/ringfall-prof";
mkdirSync(outDir, { recursive: true });

const tWarm = process.cpuUsage();
playRaid("reservoir", "beginner", 0);
const w = process.cpuUsage(tWarm);
console.log(`warmup_cpu_s=${((w.user + w.system) / 1e6).toFixed(2)}`);

const session = new Session();
session.connect();
await session.post("Profiler.enable");
await session.post("Profiler.start");
const t0 = process.cpuUsage();
const r = playRaid("reservoir", "beginner", 1);
const cpu = process.cpuUsage(t0);
const { profile } = await session.post("Profiler.stop");
session.disconnect();

const h = createHash("sha256").update(JSON.stringify(r)).digest("hex").slice(0, 12);
console.log(`cpu_s=${((cpu.user + cpu.system) / 1e6).toFixed(2)} hash=${h}`);

writeFileSync(`${outDir}/warm.cpuprofile`, JSON.stringify(profile));

const nodes = profile.nodes as { hitCount?: number; callFrame?: { functionName?: string; url?: string; lineNumber?: number } }[];
const self: { hits: number; name: string }[] = [];
for (const n of nodes) {
  const hits = n.hitCount || 0;
  if (!hits) continue;
  const fn = n.callFrame || {};
  let url = fn.url || "";
  url = url.replace(/^.*\/src\//, "src/").replace(/^.*\/scripts\//, "scripts/");
  self.push({ hits, name: `${fn.functionName || "(anon)"} @ ${url}` });
}
self.sort((a, b) => b.hits - a.hits);
const total = self.reduce((s, x) => s + x.hits, 0);
const agg = new Map<string, number>();
for (const x of self) agg.set(x.name, (agg.get(x.name) || 0) + x.hits);
const rows = [...agg.entries()].map(([k, hits]) => ({ k, hits })).sort((a, b) => b.hits - a.hits);
console.log(`total_samples=${total}`);
for (const x of rows.slice(0, 30)) console.log(`${((100 * x.hits) / total).toFixed(2)}% ${x.hits} ${x.k}`);
