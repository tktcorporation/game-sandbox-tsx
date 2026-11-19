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
import { playRaid, playState, type RaidResult } from "./ringfall-table";
import { NODES, REGIONS, type NodeId } from "../src/ringfall/sim/map";
import { newRun, starterKit } from "../src/ringfall/sim/state";
import { holds } from "../src/ringfall/meta/island";
import { newProfile } from "../src/ringfall/meta/profile";

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

const jobs: [string, () => RaidResult][] = [
  ...REGIONS.flatMap((g) => ["beginner", "good"].map((skill): [string, () => RaidResult] => [`${g.id} ${skill}`, () => playRaid(g.id, skill, 0)])),
  ["battle, 2 nodes, casual", () => battleRaid(["supply", "quarry"], 1, "casual", 0)],
  ["battle, 8 nodes, good", () => battleRaid(NODES.slice(0, 8).map((n) => n.id), 3, "good", 1)],
];

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
