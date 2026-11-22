/**
 * Common-random-number A/B for RINGFALL balance tables: play the same raid indices (and thus
 * the same seeds) under two configs, then report paired differences with CIs. Fewer runs
 * detect a change than two independent fixed-N tables.
 *
 * Used by `npm run sim:ringfall -- --compare --patch REINFORCE.first=450`.
 */
import * as Config from "../src/ringfall/sim/config";
import type { RegionId } from "../src/ringfall/sim/map";
import { applyPatches, restorePatches } from "./ringfall-sim-flags";
import { playRaid, raidSeed, stopRaidOf, type RaidResult } from "./ringfall-table";
import { fmtInterval, meanInterval, pairedDiffInterval, proportionInterval, type Interval } from "./ringfall-stats";

export type CompareOpts = {
  region: RegionId;
  skill: string;
  runs: number;
  patches: { path: string; value: number }[];
};

export type CompareMetric = {
  name: string;
  a: Interval;
  b: Interval;
  paired: Interval;
  pct?: boolean;
};

export type CompareReport = {
  region: RegionId;
  skill: string;
  runs: number;
  /** Raid indices kept for pairing (both arms finished without error). */
  paired: number;
  seeds: number[];
  patches: { path: string; value: number }[];
  metrics: CompareMetric[];
  /** True when raidSeed(r) matches what playRaid used (pairing is valid). */
  seedsOk: boolean;
  /** Raid errors or unfinished raids on either arm; empty when every pair is usable. */
  failures: string[];
};

function propIv(xs: number[]): Interval {
  return proportionInterval(
    xs.reduce((a, b) => a + b, 0),
    xs.length,
  );
}

/** Keep only raid indices where both arms finished; preserve index alignment for CRN. */
function pairedEnded(aRaids: RaidResult[], bRaids: RaidResult[]): {
  indices: number[];
  failures: string[];
  aAlive: number[];
  bAlive: number[];
  aDowns: number[];
  bDowns: number[];
  aCleared: number[];
  bCleared: number[];
  aFlank: number[];
  bFlank: number[];
} {
  const indices: number[] = [];
  const failures: string[] = [];
  const aAlive: number[] = [];
  const bAlive: number[] = [];
  const aDowns: number[] = [];
  const bDowns: number[] = [];
  const aCleared: number[] = [];
  const bCleared: number[] = [];
  const aFlank: number[] = [];
  const bFlank: number[] = [];
  const n = Math.min(aRaids.length, bRaids.length);
  for (let i = 0; i < n; i++) {
    const a = aRaids[i]!;
    const b = bRaids[i]!;
    if (!a.ended || !b.ended) {
      const why = [
        !a.ended ? `A#${i}: ${a.error ?? "no ended"}` : null,
        !b.ended ? `B#${i}: ${b.error ?? "no ended"}` : null,
      ]
        .filter(Boolean)
        .join("; ");
      failures.push(why);
      continue;
    }
    indices.push(i);
    aAlive.push(a.ended.got ? 1 : 0);
    bAlive.push(b.ended.got ? 1 : 0);
    aDowns.push(a.ended.downs);
    bDowns.push(b.ended.downs);
    aCleared.push(a.ended.cleared);
    bCleared.push(b.ended.cleared);
    const sa = stopRaidOf(a);
    const sb = stopRaidOf(b);
    aFlank.push(sa ? sa.flankShare : 0);
    bFlank.push(sb ? sb.flankShare : 0);
  }
  return { indices, failures, aAlive, bAlive, aDowns, bDowns, aCleared, bCleared, aFlank, bFlank };
}

/** Play A (current config) then B (with patches), same seeds, and summarize paired diffs. */
export function runCompare(opts: CompareOpts): CompareReport {
  const seeds = Array.from({ length: opts.runs }, (_, r) => raidSeed(r));
  // Sanity: seed formula is pure and matches playRaid's call.
  const seedsOk = seeds.every((s, r) => s === 1000 + r * 7919);

  const playArm = () => Array.from({ length: opts.runs }, (_, r) => playRaid(opts.region, opts.skill, r));

  const aRaids = playArm();
  const root = Config as unknown as Record<string, unknown>;
  const undone = applyPatches(root, opts.patches);
  let bRaids: RaidResult[];
  try {
    bRaids = playArm();
  } finally {
    restorePatches(root, undone);
  }

  const paired = pairedEnded(aRaids, bRaids);
  const metrics: CompareMetric[] = [
    {
      name: "alive",
      a: propIv(paired.aAlive),
      b: propIv(paired.bAlive),
      paired: pairedDiffInterval(paired.aAlive, paired.bAlive),
      pct: true,
    },
    {
      name: "downs",
      a: meanInterval(paired.aDowns),
      b: meanInterval(paired.bDowns),
      paired: pairedDiffInterval(paired.aDowns, paired.bDowns),
    },
    {
      name: "cleared",
      a: meanInterval(paired.aCleared),
      b: meanInterval(paired.bCleared),
      paired: pairedDiffInterval(paired.aCleared, paired.bCleared),
    },
    {
      name: "flank",
      a: meanInterval(paired.aFlank),
      b: meanInterval(paired.bFlank),
      paired: pairedDiffInterval(paired.aFlank, paired.bFlank),
      pct: true,
    },
  ];

  return {
    region: opts.region,
    skill: opts.skill,
    runs: opts.runs,
    paired: paired.indices.length,
    seeds,
    patches: opts.patches,
    metrics,
    seedsOk,
    failures: paired.failures,
  };
}

/** Printable lines for a compare report. */
export function compareReportLines(rep: CompareReport): string[] {
  const patch =
    rep.patches.length === 0 ? "(no patch: A and B identical — CI of paired diff should cover 0)" : rep.patches.map((p) => `${p.path}=${p.value}`).join(", ");
  const lines = [
    `compare ${rep.region} ${rep.skill}: ${rep.paired}/${rep.runs} paired raids (CRN), B patches: ${patch}`,
    `seeds: raidSeed(r) = 1000 + r*7919 — ${rep.seedsOk ? "ok" : "FAILED"} (first ${Math.min(5, rep.seeds.length)}: ${rep.seeds.slice(0, 5).join(", ")}${rep.seeds.length > 5 ? ", …" : ""})`,
  ];
  for (const m of rep.metrics) {
    const pct = !!m.pct;
    lines.push(
      `  ${m.name}: A ${fmtInterval(m.a, pct)} | B ${fmtInterval(m.b, pct)} | B−A ${fmtInterval(m.paired, pct)}${m.paired.lo <= 0 && m.paired.hi >= 0 ? " (covers 0)" : " (shift)"}`,
    );
  }
  for (const f of rep.failures) lines.push(`  fail: ${f}`);
  return lines;
}
