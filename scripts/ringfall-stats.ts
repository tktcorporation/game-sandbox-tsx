/**
 * Confidence intervals and sequential stopping for RINGFALL's balance tables.
 * Pure helpers: no sim imports. Used by the opt-in `--stop` / `--compare` modes
 * of scripts/ringfall-sim.ts so a fixed `-- 30` run stays byte-identical.
 */

/** Two-sided normal z for the usual 95% CI. */
export const Z95 = 1.959963984540054;

/**
 * Seed of raid index `r` on a balance table (`playRaid`). Deterministic and independent of
 * process order, so common-random-number A/B pairs (same `r` under two configs) stay valid.
 */
export const raidSeed = (r: number): number => 1000 + r * 7919;

export type Interval = { lo: number; hi: number; half: number; n: number; mean: number };

/** Wald CI for a sample mean (unknown σ). Uses z; fine for n ≥ ~8 as used by --stop-min. */
export function meanInterval(xs: number[], z = Z95): Interval {
  const n = xs.length;
  if (n === 0) return { lo: NaN, hi: NaN, half: NaN, n: 0, mean: NaN };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  if (n === 1) return { lo: mean, hi: mean, half: 0, n, mean };
  let ss = 0;
  for (const x of xs) ss += (x - mean) ** 2;
  const se = Math.sqrt(ss / (n - 1) / n);
  const half = z * se;
  return { lo: mean - half, hi: mean + half, half, n, mean };
}

/**
 * Wilson score CI for a Bernoulli proportion (alive rate). Unlike Wald, unanimous samples
 * (0/n or n/n) keep a nonzero half-width, so sequential stopping does not treat eight
 * identical outcomes as exact 0% or 100%.
 */
export function proportionInterval(successes: number, n: number, z = Z95): Interval {
  if (n <= 0) return { lo: NaN, hi: NaN, half: NaN, n: 0, mean: NaN };
  const mean = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (mean + z2 / (2 * n)) / denom;
  const rad = (z * Math.sqrt((mean * (1 - mean)) / n + z2 / (4 * n * n))) / denom;
  const lo = Math.max(0, centre - rad);
  const hi = Math.min(1, centre + rad);
  return { lo, hi, half: (hi - lo) / 2, n, mean };
}

export type StopTarget = {
  /** Absolute half-width target (e.g. 0.08 → ±8 pp for alive). */
  abs?: number;
  /** Relative half-width target: half ≤ rel * max(|mean|, floor). */
  rel?: number;
  /** Floor under |mean| when applying `rel` (avoids tiny means never stopping). */
  floor?: number;
};

/**
 * Whether an interval meets the absolute or relative half-width target (either is enough when
 * both are set — “e.g. relative half-width or absolute”, configurable).
 */
export function preciseEnough(iv: Interval, target: StopTarget): boolean {
  if (!Number.isFinite(iv.half) || iv.n <= 0) return false;
  const checks: boolean[] = [];
  if (target.abs !== undefined) checks.push(iv.half <= target.abs);
  if (target.rel !== undefined) {
    const scale = Math.max(Math.abs(iv.mean), target.floor ?? 0);
    checks.push(scale === 0 ? iv.half === 0 : iv.half <= target.rel * scale);
  }
  return checks.length > 0 && checks.some(Boolean);
}

export type MetricSpec = {
  name: string;
  /** Extract one observation per finished raid (NaN skips that raid for this metric). */
  of: (raid: StopRaid) => number | null;
  /** Bernoulli: treat the observation as 0/1 and use a proportion CI. */
  kind: "mean" | "proportion";
  target: StopTarget;
  /** When false, the metric is reported but does not block stopping (default true). */
  required?: boolean;
};

/** The fields sequential stopping reads off a finished raid (a subset of RaidResult.ended). */
export type StopRaid = {
  alive: boolean;
  downs: number;
  cleared: number;
  minutes: number;
  flankShare: number;
  critShare: number;
};

export type StopOptions = {
  min: number;
  max: number;
  batch: number;
  metrics: MetricSpec[];
};

export type MetricStatus = {
  name: string;
  interval: Interval;
  ok: boolean;
  target: StopTarget;
  required?: boolean;
};

export type StopDecision = {
  stop: boolean;
  n: number;
  metrics: MetricStatus[];
};

/**
 * Default key metrics for a region×skill table (balance.md's main columns).
 * Only `alive` (and `downs`) block stopping; cleared/flank are reported. Absolute half-widths
 * sit at the upper end of the documented n=30 noise (~10–20 pp on alive), so a typical `--stop`
 * with max 30 can finish under a fixed `-- 30`; tighten with `--stop-abs` / `--stop-rel` when
 * recording a balance.md table.
 */
export const DEFAULT_STOP_METRICS: MetricSpec[] = [
  { name: "alive", kind: "proportion", of: (r) => (r.alive ? 1 : 0), target: { abs: 0.2, rel: 0.25, floor: 0.4 }, required: true },
  { name: "downs", kind: "mean", of: (r) => r.downs, target: { abs: 0.5, rel: 0.35, floor: 0.8 }, required: true },
  { name: "cleared", kind: "mean", of: (r) => r.cleared, target: { abs: 0.55, rel: 0.35, floor: 1 }, required: false },
  { name: "flank", kind: "mean", of: (r) => r.flankShare, target: { abs: 0.06, rel: 0.35, floor: 0.1 }, required: false },
];

/** Decide whether a table may stop after `raids.length` finished runs. */
export function decideStop(raids: StopRaid[], opts: StopOptions): StopDecision {
  const n = raids.length;
  const metrics = opts.metrics.map((m) => {
    const vals: number[] = [];
    for (const r of raids) {
      const v = m.of(r);
      if (v !== null && Number.isFinite(v)) vals.push(v);
    }
    const interval =
      m.kind === "proportion"
        ? proportionInterval(
            vals.reduce((a, b) => a + b, 0),
            vals.length,
          )
        : meanInterval(vals);
    return { name: m.name, interval, ok: preciseEnough(interval, m.target), target: m.target, required: m.required !== false };
  });
  if (n < opts.min) return { stop: false, n, metrics };
  if (n >= opts.max) return { stop: true, n, metrics };
  return { stop: metrics.filter((m) => m.required !== false).every((m) => m.ok), n, metrics };
}

/** How many more raids to schedule for a table that has `have` finished so far. */
export function nextBatch(have: number, opts: StopOptions, decision: StopDecision): number {
  if (decision.stop) return 0;
  if (have >= opts.max) return 0;
  return Math.min(opts.batch, opts.max - have);
}

/** Paired difference CI: mean(b − a) with a Wald interval. */
export function pairedDiffInterval(a: number[], b: number[], z = Z95): Interval {
  const n = Math.min(a.length, b.length);
  const diffs = Array.from({ length: n }, (_, i) => b[i]! - a[i]!);
  return meanInterval(diffs, z);
}

/** Format an interval for the stop / compare reports. */
export function fmtInterval(iv: Interval, pct = false): string {
  if (!Number.isFinite(iv.mean)) return "n/a";
  const scale = pct ? 100 : 1;
  const unit = pct ? "%" : "";
  const m = (iv.mean * scale).toFixed(pct ? 0 : 2);
  const h = (iv.half * scale).toFixed(pct ? 1 : 2);
  return `${m}${unit} ±${h}${unit} (n=${iv.n})`;
}
