/**
 * Worker for scripts/headroom/parallel-bench.ts: plays one raid job and returns its hash and CPU.
 */
import { createHash } from "node:crypto";
import "../ringfall-terrain-store";
import { playRaid, playState, type RaidResult } from "../ringfall-table";
import { newRun, starterKit } from "../../src/ringfall/sim/state";
import { holds } from "../../src/ringfall/meta/island";
import { newProfile } from "../../src/ringfall/meta/profile";
import type { NodeId } from "../../src/ringfall/sim/map";

const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 12);
const cpu = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1e6;
};

type Job = {
  name: string;
  kind: "raid" | "battle";
  region?: string;
  skill: string;
  r: number;
  freed?: NodeId[];
  factory?: number;
};

function battleRaid(freed: NodeId[], factory: number, skill: string, r: number): RaidResult {
  const p = newProfile(7);
  const poiState = { ...p.poiState };
  for (const id of freed) poiState[id] = { state: "freed" };
  return playState(newRun(4000 + r * 7919, starterKit(), "reservoir", { island: holds({ ...p, poiState }), battle: { factory } }), skill, r);
}

process.on("message", (m: { i: number; job: Job }) => {
  const t0 = cpu();
  const result =
    m.job.kind === "raid" ? playRaid(m.job.region as never, m.job.skill, m.job.r) : battleRaid(m.job.freed!, m.job.factory!, m.job.skill, m.job.r);
  process.send!({ i: m.i, h: hash(result), cpu: cpu() - t0 });
});
process.on("disconnect", () => process.exit(0));
