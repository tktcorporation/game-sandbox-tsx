/**
 * Headroom probe: play the same 10 fixed raids as `bench:ringfall`, once in this process
 * and once across N worker processes (one raid per job). Prints wall and CPU, and the hash
 * of each raid so a parallel run can be checked against the serial one.
 *
 *   npx tsx scripts/headroom/parallel-bench.ts [workers]
 */
import { createHash } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import "../ringfall-terrain-store";
import { playRaid, playState, type RaidResult } from "../ringfall-table";
import { NODES, REGIONS, type NodeId } from "../../src/ringfall/sim/map";
import { newRun, starterKit } from "../../src/ringfall/sim/state";
import { holds } from "../../src/ringfall/meta/island";
import { newProfile } from "../../src/ringfall/meta/profile";

const workersN = Math.max(1, Number(process.argv[2] ?? availableParallelism()) || 1);
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

type Job = { name: string; kind: "raid" | "battle"; region?: string; skill: string; r: number; freed?: NodeId[]; factory?: number };

const jobs: Job[] = [
  ...REGIONS.flatMap((g) =>
    ["beginner", "good"].map(
      (skill): Job => ({ name: `${g.id} ${skill}`, kind: "raid", region: g.id, skill, r: 0 }),
    ),
  ),
  { name: "battle, 2 nodes, casual", kind: "battle", skill: "casual", r: 0, freed: ["supply", "quarry"], factory: 1 },
  { name: "battle, 8 nodes, good", kind: "battle", skill: "good", r: 1, freed: NODES.slice(0, 8).map((n) => n.id), factory: 3 },
];

function play(job: Job): RaidResult {
  if (job.kind === "raid") return playRaid(job.region as never, job.skill, job.r);
  return battleRaid(job.freed!, job.factory!, job.skill, job.r);
}

async function runParallel(n: number): Promise<{ hashes: string[]; wall: number; cpuParent: number }> {
  const worker = fileURLToPath(new URL("./parallel-bench-worker.ts", import.meta.url));
  const results = Array.from({ length: jobs.length }, () => Promise.withResolvers<{ i: number; h: string; cpu: number }>());
  let next = 0;
  const t0 = performance.now();
  const c0 = cpu();
  const lanes = Array.from({ length: Math.min(n, jobs.length) }, () =>
    new Promise<void>((done, fail) => {
      const w: ChildProcess = fork(worker, { serialization: "advanced" });
      let playing: number | null = null;
      const give = () => {
        if (next < jobs.length) {
          playing = next;
          w.send({ i: next, job: jobs[next++] });
        } else w.disconnect();
      };
      w.on("message", (m: { i: number; h: string; cpu: number }) => {
        results[m.i].resolve(m);
        playing = null;
        give();
      });
      w.on("error", fail);
      w.on("exit", (code) => {
        if (playing !== null) fail(new Error(`worker died on job ${playing} code ${code}`));
        else done();
      });
      give();
    }),
  );
  await Promise.all(lanes);
  const wall = (performance.now() - t0) / 1000;
  const cpuParent = cpu() - c0;
  const out = await Promise.all(results.map((r) => r.promise));
  out.sort((a, b) => a.i - b.i);
  return { hashes: out.map((o) => o.h), wall, cpuParent };
}

function runSerial(): { hashes: string[]; wall: number; cpuTotal: number } {
  const t0 = performance.now();
  const c0 = cpu();
  const hashes: string[] = [];
  for (const job of jobs) hashes.push(hash(play(job)));
  return { hashes, wall: (performance.now() - t0) / 1000, cpuTotal: cpu() - c0 };
}

console.log(`cores=${availableParallelism()} workers=${workersN} jobs=${jobs.length}`);
const serial = runSerial();
console.log(`serial  wall=${serial.wall.toFixed(1)}s cpu=${serial.cpuTotal.toFixed(1)}s hash=${hash(serial.hashes)}`);
for (let i = 0; i < jobs.length; i++) console.log(`  ${jobs[i].name.padEnd(26)} ${serial.hashes[i]}`);

const parallel = await runParallel(workersN);
console.log(`parallel wall=${parallel.wall.toFixed(1)}s parentCpu=${parallel.cpuParent.toFixed(1)}s hash=${hash(parallel.hashes)}`);
for (let i = 0; i < jobs.length; i++) console.log(`  ${jobs[i].name.padEnd(26)} ${parallel.hashes[i]}`);

const same = serial.hashes.every((h, i) => h === parallel.hashes[i]);
console.log(`hashes_match=${same} wall_speedup=${(serial.wall / parallel.wall).toFixed(2)}x`);
if (!same) process.exit(1);
