/**
 * Headroom probe: how FAR_THINK.every changes bench CPU and the outcome hash.
 * Patches the live config object for this process only (FAR_THINK is a mutable export).
 *
 *   npx tsx scripts/headroom/far-think-probe.ts
 */
import { createHash } from "node:crypto";
import "../ringfall-terrain-store";
import { FAR_THINK } from "../../src/ringfall/sim/config";
import { playRaid, playState, type RaidResult } from "../ringfall-table";
import { NODES, REGIONS, type NodeId } from "../../src/ringfall/sim/map";
import { newRun, starterKit } from "../../src/ringfall/sim/state";
import { holds } from "../../src/ringfall/meta/island";
import { newProfile } from "../../src/ringfall/meta/profile";

const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 12);
const cpu = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1e6;
};

function battleRaid(freed: NodeId[], factory: number, skill: string, r: number): RaidResult {
  const p = newProfile(7);
  const poiState = { ...p.poiState };
  for (const id of freed) poiState[id] = { state: "freed" };
  return playState(newRun(4000 + r * 7919, starterKit(), "reservoir", { island: holds({ ...p, poiState }), battle: { factory } }), skill, r);
}

const jobs: [string, () => RaidResult][] = [
  ...REGIONS.flatMap((g) => ["beginner", "good"].map((skill): [string, () => RaidResult] => [`${g.id} ${skill}`, () => playRaid(g.id, skill, 0)])),
  ["battle, 2 nodes, casual", () => battleRaid(["supply", "quarry"], 1, "casual", 0)],
  ["battle, 8 nodes, good", () => battleRaid(NODES.slice(0, 8).map((n) => n.id), 3, "good", 1)],
];

function runOnce(every: number) {
  FAR_THINK.every = every;
  const hashes: string[] = [];
  const c0 = cpu();
  const t0 = performance.now();
  for (const [, play] of jobs) hashes.push(hash(play()));
  return { every, cpu: cpu() - c0, wall: (performance.now() - t0) / 1000, h: hash(hashes), raids: hashes };
}

const baseline = FAR_THINK.every;
console.log(`baseline FAR_THINK.every=${baseline} dist=${FAR_THINK.dist}`);
const settings = [1, 2, 4, 8, 16];
const rows = [];
for (const every of settings) {
  const r = runOnce(every);
  rows.push(r);
  console.log(`every=${String(every).padStart(2)}  cpu=${r.cpu.toFixed(1).padStart(5)}s  wall=${r.wall.toFixed(1).padStart(5)}s  hash=${r.h}`);
}
const base = rows.find((r) => r.every === 4)!;
console.log("--- vs every=4 ---");
for (const r of rows) {
  const same = r.h === base.h;
  console.log(`every=${String(r.every).padStart(2)}  cpu_ratio=${(r.cpu / base.cpu).toFixed(3)}  hash_same=${same}`);
}
// restore
FAR_THINK.every = baseline;
