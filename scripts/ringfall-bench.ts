/**
 * The sim gate's weight, measured on a fixed handful of raids (CLAUDE.md, the sim gate's speed):
 * a beginner's and a good bot's first raid in each region as the gate's tables play them, and two
 * raids of an island with its battle as the campaign plays them, one after another in this one
 * process. It prints each raid's CPU time and a hash of what the raid came to, then the total and
 * the hash of all of them.
 *
 * The total is what a change is weighed by: run it before and after, back to back. CPU time, not
 * wall time, so another job on the machine moves it little. The hash tells in three minutes
 * whether a change left these raids as they were; a speed-up must leave it unchanged (the whole
 * gate, run once after, is still what shows that for every raid).
 *
 *   npm run bench:ringfall
 */
import { createHash } from "node:crypto";
import "./ringfall-terrain-store";
import { BENCH_ONCE } from "./ringfall-bench-jobs";

const cpu = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1e6;
};
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 12);

const jobs = BENCH_ONCE;

const loaded = cpu();
const hashes: string[] = [];
let total = 0;
for (const [name, play] of jobs) {
  const t = cpu();
  const h = hash(play());
  const took = cpu() - t;
  total += took;
  hashes.push(h);
  console.log(`${name.padEnd(26)} ${took.toFixed(1).padStart(6)} s  ${h}`);
}
console.log(`bench: ${jobs.length} raids, ${total.toFixed(1)} s of CPU (and ${loaded.toFixed(1)} s loading the world), ${hash(hashes)}`);
