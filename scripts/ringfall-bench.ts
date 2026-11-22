/**
 * The sim gate's weight, measured on a fixed handful of raids (CLAUDE.md, the sim gate's speed):
 * a beginner's and a good bot's first raid in each region as the gate's tables play them, and two
 * raids of an island with its battle as the campaign plays them. It prints each raid's CPU time
 * and a hash of what the raid came to, then the total and the hash of all of them.
 *
 * With more than one job the raids run in worker processes (one process per physical core by
 * default; see scripts/ringfall-parallelism.ts), and the lines are still printed in the same
 * order as a single process. RINGFALL_SIM_JOBS or the first argument sets how many workers
 * (1 plays everything in this process, in turn):
 *
 *   npm run bench:ringfall
 *   npm run bench:ringfall -- 1
 *   RINGFALL_SIM_JOBS=4 npm run bench:ringfall
 *
 * The total CPU is what a change is weighed by (jobs=1, or the sum of each raid's CPU): run it
 * before and after, back to back. The hash tells in a few minutes whether a change left these
 * raids as they were; a speed-up must leave it unchanged (the whole gate, run once after, is
 * still what shows that for every raid).
 */
import { createHash } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import "./ringfall-terrain-store";
import { playRaid, playState, type RaidResult } from "./ringfall-table";
import type { BenchJob } from "./ringfall-bench-worker";
import { defaultSimJobs } from "./ringfall-parallelism";
import { NODES, REGIONS, type NodeId, type RegionId } from "../src/ringfall/sim/map";
import { newRun, starterKit } from "../src/ringfall/sim/state";
import { holds } from "../src/ringfall/meta/island";
import { newProfile } from "../src/ringfall/meta/profile";

const workers = Math.max(1, Number(process.argv[2] ?? process.env.RINGFALL_SIM_JOBS ?? defaultSimJobs()) || 1);

const cpu = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1e6;
};
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 12);

/** A raid of an island holding `freed`, with its battle at factory level `factory`, as a day of the campaign is. */
function battleRaid(freed: NodeId[], factory: number, skill: string, r: number): RaidResult {
  const p = newProfile(7);
  const poiState = { ...p.poiState };
  for (const id of freed) poiState[id] = { state: "freed" };
  return playState(newRun(4000 + r * 7919, starterKit(), "reservoir", { island: holds({ ...p, poiState }), battle: { factory } }), skill, r);
}

type Named = { name: string; play: () => RaidResult; job: Omit<BenchJob, "i"> };

/**
 * The regions whose raids take longest first (same order as the sim gate's table workers), so a
 * parallel run finishes sooner when the last workers are on short raids.
 */
const LONGEST_FIRST: RegionId[] = ["reservoir", "city", "harbor", "launch"];
const regionRank = (r: RegionId) => (LONGEST_FIRST.includes(r) ? LONGEST_FIRST.indexOf(r) : LONGEST_FIRST.length);

const named: Named[] = [
  ...REGIONS.flatMap((g) =>
    ["beginner", "good"].map(
      (skill): Named => ({
        name: `${g.id} ${skill}`,
        play: () => playRaid(g.id, skill, 0),
        job: { kind: "raid", region: g.id, skill, r: 0 },
      }),
    ),
  ),
  {
    name: "battle, 2 nodes, casual",
    play: () => battleRaid(["supply", "quarry"], 1, "casual", 0),
    job: { kind: "battle", skill: "casual", r: 0, freed: ["supply", "quarry"], factory: 1 },
  },
  {
    name: "battle, 8 nodes, good",
    play: () => battleRaid(NODES.slice(0, 8).map((n) => n.id), 3, "good", 1),
    job: { kind: "battle", skill: "good", r: 1, freed: NODES.slice(0, 8).map((n) => n.id), factory: 3 },
  },
];

const loaded = cpu();

type Row = { name: string; took: number; h: string };

function printRows(rows: Row[], total: number, wall?: number) {
  for (const row of rows) console.log(`${row.name.padEnd(26)} ${row.took.toFixed(1).padStart(6)} s  ${row.h}`);
  const wallBit = wall !== undefined && workers > 1 ? `, wall ${wall.toFixed(1)} s × ${workers}` : "";
  console.log(`bench: ${rows.length} raids, ${total.toFixed(1)} s of CPU${wallBit} (and ${loaded.toFixed(1)} s loading the world), ${hash(rows.map((r) => r.h))}`);
}

async function runParallel(n: number): Promise<Row[]> {
  const results = Array.from({ length: named.length }, () => Promise.withResolvers<{ i: number; result: RaidResult; cpu: number }>());
  // Longest raids first; print order stays `named`'s order.
  const queue = named
    .map((row, i) => ({ i, rank: row.job.kind === "raid" ? regionRank(row.job.region) : -1 }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map(({ i }) => ({ ...named[i].job, i }) satisfies BenchJob);
  let next = 0;
  const workersRunning: ChildProcess[] = [];
  process.on("exit", () => {
    for (const w of workersRunning) w.kill();
  });
  const crash = (why: string) => {
    console.error(`bench worker failed: ${why}`);
    process.exit(1);
  };
  await Promise.all(
    Array.from({ length: Math.min(n, named.length) }, () =>
      new Promise<void>((done, fail) => {
        const w = fork(fileURLToPath(new URL("./ringfall-bench-worker.ts", import.meta.url)), { serialization: "advanced" });
        workersRunning.push(w);
        let playing: BenchJob | null = null;
        const give = () => {
          if (next < queue.length) w.send((playing = queue[next++]));
          else w.disconnect();
        };
        w.on("message", (m: { i: number; result: RaidResult; cpu: number }) => {
          results[m.i].resolve(m);
          playing = null;
          give();
        });
        w.on("error", (err) => fail(err));
        w.on("exit", (code, signal) => {
          if (playing) crash(`it exited (${signal ?? `code ${code}`}) while playing #${playing.i}`);
          else done();
        });
        give();
      }),
    ),
  );
  const out = await Promise.all(results.map((r) => r.promise));
  return out.map((m) => ({ name: named[m.i].name, took: m.cpu, h: hash(m.result) }));
}

if (workers <= 1) {
  const rows: Row[] = [];
  let total = 0;
  for (const row of named) {
    const t = cpu();
    const h = hash(row.play());
    const took = cpu() - t;
    total += took;
    rows.push({ name: row.name, took, h });
  }
  printRows(rows, total);
} else {
  const wall0 = performance.now();
  const rows = await runParallel(workers);
  const wall = (performance.now() - wall0) / 1000;
  const total = rows.reduce((s, r) => s + r.took, 0);
  printRows(rows, total, wall);
}
