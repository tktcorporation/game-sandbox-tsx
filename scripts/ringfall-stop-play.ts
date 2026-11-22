/**
 * Sequential stopping for RINGFALL balance tables: play raids in batches (optionally across
 * RINGFALL_SIM_JOBS workers), stop each region×skill once key-metric CIs are tight enough
 * (or the max is hit), and report the CIs and runs used.
 */
import { fork, type ChildProcess } from "node:child_process";
import { setPriority } from "node:os";
import { fileURLToPath } from "node:url";
import type { RegionId } from "../src/ringfall/sim/map";
import { playRaid, stopRaidOf, summarize, type RaidResult, type TableResult } from "./ringfall-table";
import type { RaidJob } from "./ringfall-table-worker";
import { decideStop, fmtInterval, nextBatch, type StopOptions, type StopDecision } from "./ringfall-stats";
import { defaultSimJobs } from "./ringfall-parallelism";

export type TableKey = { region: RegionId; skill: string };

export type StoppedTable = {
  key: TableKey;
  result: TableResult;
  decision: StopDecision;
  raids: RaidResult[];
};

/** Play one table in this process, stopping early when the CIs allow. */
export function playTableStopping(region: RegionId, skill: string, opts: StopOptions): StoppedTable {
  const raids: RaidResult[] = [];
  let decision = decideStop([], opts);
  while (true) {
    const more = nextBatch(raids.length, opts, decision);
    if (more <= 0) break;
    for (let k = 0; k < more; k++) raids.push(playRaid(region, skill, raids.length));
    const stops = raids.map(stopRaidOf).filter((x): x is NonNullable<typeof x> => !!x);
    decision = decideStop(stops, opts);
    if (decision.stop) break;
  }
  return { key: { region, skill }, result: summarize(region, skill, raids), decision, raids };
}

type Slot = {
  key: TableKey;
  raids: RaidResult[];
  pending: Map<number, PromiseWithResolvers<RaidResult>>;
  decision: StopDecision;
  stopped: boolean;
};

const safeDisconnect = (w: ChildProcess) => {
  try {
    if (w.connected) w.disconnect();
  } catch {
    /* already gone */
  }
};

/**
 * Play every table with sequential stopping, farming raids to worker processes when
 * `jobs > 1`. A table schedules its next batch only after the previous batch has all returned.
 */
export async function playTablesStopping(
  tables: TableKey[],
  opts: StopOptions,
  jobs = Math.max(1, Number(process.env.RINGFALL_SIM_JOBS ?? defaultSimJobs()) || 1),
  longestFirst: RegionId[] = ["reservoir", "city", "harbor", "launch"],
): Promise<StoppedTable[]> {
  if (jobs <= 1) return tables.map((t) => playTableStopping(t.region, t.skill, opts));

  const slots: Slot[] = tables.map((key) => ({
    key,
    raids: [],
    pending: new Map(),
    decision: decideStop([], opts),
    stopped: false,
  }));

  const queue: RaidJob[] = [];
  const rank = (region: RegionId) => (longestFirst.includes(region) ? longestFirst.indexOf(region) : longestFirst.length);

  const scheduleBatch = (i: number) => {
    const s = slots[i]!;
    if (s.stopped || s.pending.size > 0) return;
    const more = nextBatch(s.raids.length, opts, s.decision);
    if (more <= 0) {
      s.stopped = true;
      return;
    }
    for (let k = 0; k < more; k++) {
      const r = s.raids.length + k;
      s.pending.set(r, Promise.withResolvers<RaidResult>());
      queue.push({ i, r, region: s.key.region, skill: s.key.skill });
    }
  };

  // Longest regions first so the drain ends on short raids.
  const order = tables
    .map((t, i) => i)
    .sort((a, b) => rank(tables[a]!.region) - rank(tables[b]!.region) || a - b);
  for (const i of order) scheduleBatch(i);

  const workers: ChildProcess[] = [];
  process.on("exit", () => {
    for (const w of workers) w.kill();
  });
  const crash = (why: string) => {
    console.error(`sim worker failed: ${why}`);
    process.exit(1);
  };

  await new Promise<void>((resolveAll, rejectAll) => {
    let next = 0;
    let live = 0;
    let settled = false;
    const nWorkers = Math.min(jobs, Math.max(1, queue.length));

    const settle = () => {
      if (settled) return;
      settled = true;
      for (const ww of workers) safeDisconnect(ww);
      resolveAll();
    };

    const give = (w: ChildProcess, playing: { job: RaidJob | null }) => {
      if (settled) return;
      if (next >= queue.length) {
        for (const i of order) scheduleBatch(i);
      }
      if (next >= queue.length) {
        playing.job = null;
        safeDisconnect(w);
        if (slots.every((s) => s.stopped) && live === 0) settle();
        return;
      }
      const job = queue[next++]!;
      playing.job = job;
      live++;
      w.send(job satisfies RaidJob);
    };

    for (let k = 0; k < nWorkers; k++) {
      const w = fork(fileURLToPath(new URL("./ringfall-table-worker.ts", import.meta.url)), { serialization: "advanced" });
      workers.push(w);
      const playing = { job: null as RaidJob | null };
      try {
        if (w.pid !== undefined) setPriority(w.pid, 10);
      } catch {
        /* optional */
      }
      w.on("message", (m: { i: number; r: number; result: RaidResult }) => {
        live--;
        const s = slots[m.i]!;
        const wait = s.pending.get(m.r);
        if (!wait) {
          crash(`unexpected result for ${s.key.region} ${s.key.skill}#${m.r}`);
          return;
        }
        wait.resolve(m.result);
        s.pending.delete(m.r);
        if (s.raids.length === m.r) s.raids.push(m.result);
        else {
          while (s.raids.length < m.r) s.raids.push(undefined as unknown as RaidResult);
          s.raids[m.r] = m.result;
        }
        if (s.pending.size === 0) {
          s.raids = s.raids.filter((x) => x !== undefined);
          const stops = s.raids.map(stopRaidOf).filter((x): x is NonNullable<typeof x> => !!x);
          s.decision = decideStop(stops, opts);
          if (s.decision.stop) s.stopped = true;
          else scheduleBatch(m.i);
        }
        playing.job = null;
        if (slots.every((x) => x.stopped) && live === 0) {
          settle();
          return;
        }
        give(w, playing);
      });
      w.on("error", (err) => {
        if (!settled) rejectAll(err);
      });
      w.on("exit", (code, signal) => {
        if (playing.job) crash(`it exited (${signal ?? `code ${code}`}) while playing ${playing.job.region} ${playing.job.skill}#${playing.job.r}`);
        if (slots.every((s) => s.stopped) && live === 0) settle();
      });
      give(w, playing);
    }
    if (queue.length === 0) settle();
  });

  return slots.map((s) => ({
    key: s.key,
    result: summarize(s.key.region, s.key.skill, s.raids),
    decision: s.decision,
    raids: s.raids,
  }));
}

/** Human-readable stop report lines for one table. */
export function stopReportLines(s: StoppedTable, max: number): string[] {
  const allOk = s.decision.metrics.filter((m) => m.required !== false).every((m) => m.ok);
  const reason = allOk ? "precise" : s.decision.n >= max ? "max" : "stopped";
  const head = `stop ${s.key.region} ${s.key.skill}: n=${s.decision.n}/${max} (${reason})`;
  const mets = s.decision.metrics.map((m) => {
    const pct = m.name === "alive" || m.name === "flank";
    const role = m.required === false ? "info" : m.ok ? "ok" : "wide";
    return `  ${m.name}: ${fmtInterval(m.interval, pct)} [${role}]`;
  });
  return [head, ...mets];
}
