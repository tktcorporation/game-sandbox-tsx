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
  seeds: number[];
  patches: { path: string; value: number }[];
  metrics: CompareMetric[];
  /** True when raidSeed(r) matches what playRaid used (pairing is valid). */
  seedsOk: boolean;
};

const alive = (raids: RaidResult[]) => raids.map((r) => (r.ended?.got ? 1 : 0));
const downs = (raids: RaidResult[]) => raids.map((r) => r.ended?.downs ?? NaN).filter(Number.isFinite);
const cleared = (raids: RaidResult[]) => raids.map((r) => r.ended?.cleared ?? NaN).filter(Number.isFinite);
const flank = (raids: RaidResult[]) =>
  raids
    .map((r) => {
      const s = stopRaidOf(r);
      return s ? s.flankShare : NaN;
    })
    .filter(Number.isFinite);

function propIv(xs: number[]): Interval {
  return proportionInterval(
    xs.reduce((a, b) => a + b, 0),
    xs.length,
  );
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

  const aAlive = alive(aRaids);
  const bAlive = alive(bRaids);
  const aDowns = downs(aRaids);
  const bDowns = downs(bRaids);
  const aCleared = cleared(aRaids);
  const bCleared = cleared(bRaids);
  const aFlank = flank(aRaids);
  const bFlank = flank(bRaids);

  const metrics: CompareMetric[] = [
    { name: "alive", a: propIv(aAlive), b: propIv(bAlive), paired: pairedDiffInterval(aAlive, bAlive), pct: true },
    { name: "downs", a: meanInterval(aDowns), b: meanInterval(bDowns), paired: pairedDiffInterval(aDowns, bDowns) },
    { name: "cleared", a: meanInterval(aCleared), b: meanInterval(bCleared), paired: pairedDiffInterval(aCleared, bCleared) },
    { name: "flank", a: meanInterval(aFlank), b: meanInterval(bFlank), paired: pairedDiffInterval(aFlank, bFlank), pct: true },
  ];

  return {
    region: opts.region,
    skill: opts.skill,
    runs: opts.runs,
    seeds,
    patches: opts.patches,
    metrics,
    seedsOk,
  };
}

/** Printable lines for a compare report. */
export function compareReportLines(rep: CompareReport): string[] {
  const patch =
    rep.patches.length === 0 ? "(no patch: A and B identical — CI of paired diff should cover 0)" : rep.patches.map((p) => `${p.path}=${p.value}`).join(", ");
  const lines = [
    `compare ${rep.region} ${rep.skill}: ${rep.runs} paired raids (CRN), B patches: ${patch}`,
    `seeds: raidSeed(r) = 1000 + r*7919 — ${rep.seedsOk ? "ok" : "FAILED"} (first ${Math.min(5, rep.seeds.length)}: ${rep.seeds.slice(0, 5).join(", ")}${rep.seeds.length > 5 ? ", …" : ""})`,
  ];
  for (const m of rep.metrics) {
    const pct = !!m.pct;
    lines.push(
      `  ${m.name}: A ${fmtInterval(m.a, pct)} | B ${fmtInterval(m.b, pct)} | B−A ${fmtInterval(m.paired, pct)}${m.paired.lo <= 0 && m.paired.hi >= 0 ? " (covers 0)" : " (shift)"}`,
    );
  }
  return lines;
}
