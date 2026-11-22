/**
 * CLI / env flags for RINGFALL's balance sim (scripts/ringfall-sim.ts).
 * Default with a bare count keeps the historical fixed-N tables; stop and compare are opt-in.
 *
 *   npm run sim:ringfall -- [runs] [region]
 *   npm run sim:ringfall -- [runs] [region] --stop [--stop-min=8] [--stop-max=30] [--stop-batch=4]
 *       [--stop-abs=0.08] [--stop-rel=0.15]
 *   npm run sim:ringfall -- --compare [--runs=20] [--patch PATH=VALUE] [--region=reservoir] [--skill=casual]
 *
 * Env mirrors (used when the flag is absent):
 *   RINGFALL_SIM_STOP=1, RINGFALL_SIM_STOP_MIN, RINGFALL_SIM_STOP_MAX, RINGFALL_SIM_STOP_BATCH,
 *   RINGFALL_SIM_STOP_ABS, RINGFALL_SIM_STOP_REL, RINGFALL_SIM_COMPARE=1, RINGFALL_SIM_PATCH,
 *   RINGFALL_SIM_COMPARE_RUNS, RINGFALL_SIM_COMPARE_REGION, RINGFALL_SIM_COMPARE_SKILL
 */
import { DEFAULT_STOP_METRICS, type StopOptions } from "./ringfall-stats";
import type { RegionId } from "../src/ringfall/sim/map";

export type SimFlags = {
  /** Positional fixed-N count (historical argv[2]); also the stop max when --stop is on. */
  runs: number;
  only?: RegionId;
  /** Optional override for RINGFALL_SIM_JOBS / defaultSimJobs (`--jobs N`). */
  jobsOpt?: string;
  stop: boolean;
  stopOpts: StopOptions;
  compare: boolean;
  compareRuns: number;
  compareRegion: RegionId;
  compareSkill: string;
  /** Config patches applied only to the B arm of --compare (`dotted.path=number`). */
  patches: { path: string; value: number }[];
};

const num = (v: string | undefined, fallback: number) => {
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const flagValue = (args: string[], name: string): string | undefined => {
  const eq = args.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = args.indexOf(name);
  if (i >= 0 && args[i + 1] && !args[i + 1]!.startsWith("-")) return args[i + 1];
  return undefined;
};

const hasFlag = (args: string[], name: string) => args.includes(name) || args.some((a) => a.startsWith(`${name}=`));

/** Parse argv after `tsx scripts/ringfall-sim.ts`. Positional runs/region stay first for compatibility. */
export function parseSimFlags(argv: string[], env: NodeJS.ProcessEnv = process.env): SimFlags {
  const positional: string[] = [];
  const flags: string[] = [];
  let jobsOpt: string | undefined;
  const patchRaws: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--jobs" || a.startsWith("--jobs=")) {
      jobsOpt = a.includes("=") ? a.slice("--jobs=".length) : argv[++i];
      continue;
    }
    if (a === "--patch" || a.startsWith("--patch=")) {
      const raw = a.includes("=") ? a.slice("--patch=".length) : argv[++i];
      if (raw) patchRaws.push(raw);
      continue;
    }
    // Flag forms that take a value as the next argv token (not `--name=value`).
    if (a === "--stop-min" || a === "--stop-max" || a === "--stop-batch" || a === "--stop-abs" || a === "--stop-rel" || a === "--runs" || a === "--region" || a === "--skill") {
      const v = argv[i + 1];
      flags.push(a);
      if (v !== undefined && !v.startsWith("--")) {
        flags.push(v);
        i++;
      }
      continue;
    }
    if (a.startsWith("--")) flags.push(a);
    else positional.push(a);
  }

  const runs = num(positional[0], 12);
  const only = positional[1] as RegionId | undefined;

  const stop =
    hasFlag(flags, "--stop") || env.RINGFALL_SIM_STOP === "1" || env.RINGFALL_SIM_STOP === "true";
  const stopMax = num(flagValue(flags, "--stop-max") ?? env.RINGFALL_SIM_STOP_MAX, runs > 0 ? runs : 30);
  const stopMin = num(flagValue(flags, "--stop-min") ?? env.RINGFALL_SIM_STOP_MIN, Math.min(8, stopMax));
  const stopBatch = num(flagValue(flags, "--stop-batch") ?? env.RINGFALL_SIM_STOP_BATCH, 4);
  const stopAbs = num(flagValue(flags, "--stop-abs") ?? env.RINGFALL_SIM_STOP_ABS, 0.2);
  const stopRel = num(flagValue(flags, "--stop-rel") ?? env.RINGFALL_SIM_STOP_REL, 0.25);

  // Alive uses the CLI abs/rel; other metrics keep their DEFAULT_STOP_METRICS targets.
  const metrics = DEFAULT_STOP_METRICS.map((m) =>
    m.name === "alive" ? { ...m, target: { ...m.target, abs: stopAbs, rel: stopRel } } : { ...m, target: { ...m.target } },
  );

  const compare =
    hasFlag(flags, "--compare") || env.RINGFALL_SIM_COMPARE === "1" || env.RINGFALL_SIM_COMPARE === "true";
  const compareRuns = num(flagValue(flags, "--runs") ?? env.RINGFALL_SIM_COMPARE_RUNS, runs > 0 ? runs : 20);
  const compareRegion = (flagValue(flags, "--region") ?? env.RINGFALL_SIM_COMPARE_REGION ?? only ?? "reservoir") as RegionId;
  const compareSkill = flagValue(flags, "--skill") ?? env.RINGFALL_SIM_COMPARE_SKILL ?? "casual";

  const patches: { path: string; value: number }[] = [];
  for (const raw of patchRaws) {
    const eq = raw.indexOf("=");
    if (eq > 0) {
      const path = raw.slice(0, eq);
      const value = Number(raw.slice(eq + 1));
      if (path && Number.isFinite(value)) patches.push({ path, value });
    }
  }
  if (!patches.length && env.RINGFALL_SIM_PATCH) {
    for (const part of env.RINGFALL_SIM_PATCH.split(",")) {
      const eq = part.indexOf("=");
      if (eq > 0) {
        const path = part.slice(0, eq).trim();
        const value = Number(part.slice(eq + 1));
        if (path && Number.isFinite(value)) patches.push({ path, value });
      }
    }
  }

  return {
    runs,
    only,
    jobsOpt,
    stop,
    stopOpts: {
      min: Math.max(2, Math.min(stopMin, stopMax)),
      max: Math.max(2, stopMax),
      batch: Math.max(1, stopBatch),
      metrics,
    },
    compare,
    compareRuns: Math.max(2, compareRuns),
    compareRegion,
    compareSkill,
    patches,
  };
}

/**
 * Apply `patches` to a nested config object graph (mutates). Paths are dotted from the
 * exported binding name, e.g. `REINFORCE.first` or `PLAYER.sprint`. Returns previous values
 * so the caller can restore them after the B arm.
 */
export function applyPatches(
  root: Record<string, unknown>,
  patches: { path: string; value: number }[],
): { path: string; prev: number }[] {
  const undone: { path: string; prev: number }[] = [];
  for (const { path, value } of patches) {
    const parts = path.split(".");
    let cur: unknown = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!cur || typeof cur !== "object") throw new Error(`patch ${path}: missing ${parts.slice(0, i + 1).join(".")}`);
      cur = (cur as Record<string, unknown>)[parts[i]!];
    }
    const key = parts[parts.length - 1]!;
    if (!cur || typeof cur !== "object" || !(key in (cur as object))) throw new Error(`patch ${path}: no such field`);
    const prev = (cur as Record<string, unknown>)[key];
    if (typeof prev !== "number") throw new Error(`patch ${path}: not a number (got ${typeof prev})`);
    undone.push({ path, prev });
    (cur as Record<string, unknown>)[key] = value;
  }
  return undone;
}

export function restorePatches(root: Record<string, unknown>, undone: { path: string; prev: number }[]): void {
  for (const { path, prev } of [...undone].reverse()) {
    const parts = path.split(".");
    let cur: unknown = root;
    for (let i = 0; i < parts.length - 1; i++) cur = (cur as Record<string, unknown>)[parts[i]!];
    (cur as Record<string, unknown>)[parts[parts.length - 1]!] = prev;
  }
}
