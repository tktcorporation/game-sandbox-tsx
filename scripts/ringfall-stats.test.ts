/**
 * Unit checks for sequential-stop / CRN helpers (no sim). Run with:
 *   npx tsx scripts/ringfall-stats.test.ts
 */
import assert from "node:assert/strict";
import {
  decideStop,
  DEFAULT_STOP_METRICS,
  meanInterval,
  nextBatch,
  pairedDiffInterval,
  preciseEnough,
  proportionInterval,
  raidSeed,
} from "./ringfall-stats";
import { parseSimFlags } from "./ringfall-sim-flags";

for (let r = 0; r < 40; r++) assert.equal(raidSeed(r), 1000 + r * 7919);

{
  const iv = proportionInterval(15, 30);
  assert.equal(iv.mean, 0.5);
  assert.ok(iv.half > 0.15 && iv.half < 0.2, `alive n=30 half ~0.18, got ${iv.half}`);
  assert.ok(preciseEnough(iv, { abs: 0.2 }), "n=30 at 50% meets default ±20pp");
  assert.ok(!preciseEnough(iv, { abs: 0.08 }), "n=30 at 50% is wider than ±8pp");
  assert.ok(preciseEnough(iv, { abs: 0.08, rel: 0.4 }), "OR: rel alone can pass when abs fails");
  const tight = proportionInterval(100, 200);
  assert.ok(preciseEnough(tight, { abs: 0.08 }), "n=200 at 50% is within ±8pp");
}

{
  const xs = [1, 2, 3, 4, 5, 6, 7, 8];
  const iv = meanInterval(xs);
  assert.equal(iv.mean, 4.5);
  assert.ok(iv.half > 0 && iv.half < 2);
}

{
  const a = [1, 1, 1, 1, 0, 0, 0, 0];
  const b = [1, 1, 1, 1, 1, 1, 0, 0];
  const paired = pairedDiffInterval(a, b);
  assert.ok(Math.abs(paired.mean - 0.25) < 1e-9);
  assert.ok(paired.half < 0.4);
}

{
  const opts = { min: 8, max: 30, batch: 4, metrics: DEFAULT_STOP_METRICS };
  const early = decideStop(
    Array.from({ length: 4 }, () => ({ alive: true, downs: 1, cleared: 2, minutes: 5, flankShare: 0.1, critShare: 0.2 })),
    opts,
  );
  assert.equal(early.stop, false);
  assert.equal(nextBatch(4, opts, early), 4);

  const atMax = decideStop(
    Array.from({ length: 30 }, (_, i) => ({
      alive: i % 2 === 0,
      downs: 1,
      cleared: 2,
      minutes: 5,
      flankShare: 0.1,
      critShare: 0.2,
    })),
    opts,
  );
  assert.equal(atMax.stop, true);
  assert.equal(nextBatch(30, opts, atMax), 0);
}

{
  const f = parseSimFlags(["30", "reservoir", "--stop", "--stop-min=10", "--stop-batch=5", "--jobs", "2"]);
  assert.equal(f.runs, 30);
  assert.equal(f.only, "reservoir");
  assert.equal(f.stop, true);
  assert.equal(f.stopOpts.min, 10);
  assert.equal(f.stopOpts.max, 30);
  assert.equal(f.stopOpts.batch, 5);
  assert.equal(f.jobsOpt, "2");
  assert.equal(f.compare, false);
}

{
  const f = parseSimFlags(["--compare", "--runs=12", "--patch", "REINFORCE.first=450", "--skill=good"]);
  assert.equal(f.compare, true);
  assert.equal(f.compareRuns, 12);
  assert.equal(f.compareSkill, "good");
  assert.deepEqual(f.patches, [{ path: "REINFORCE.first", value: 450 }]);
}

{
  const f = parseSimFlags(["30"]);
  assert.equal(f.runs, 30);
  assert.equal(f.stop, false);
  assert.equal(f.compare, false);
}

console.log("ringfall-stats.test: ok");
