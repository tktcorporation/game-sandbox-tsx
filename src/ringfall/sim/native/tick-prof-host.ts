/**
 * Section timers for RINGFALL tick profiling (`RINGFALL_TICK_PROF=1`).
 * Accumulates JS sync / leftover TS, and reads Rust section ms when WASM tick is on.
 */
import { nativeExports } from "./fill";

type NodeProcess = { env?: Record<string, string | undefined>; hrtime?: { bigint?: () => bigint } };
const nodeProcess = (): NodeProcess | undefined => (globalThis as { process?: NodeProcess }).process;

/** `1` = coarse (sync + totals); `2` / `fine` = also time every sense/calm/hunt call (slow). */
const _prof = nodeProcess()?.env?.RINGFALL_TICK_PROF;
export const PROF_ON = _prof === "1" || _prof === "on" || _prof === "2" || _prof === "fine";
export const PROF_FINE = _prof === "2" || _prof === "fine";

const SECS = [
  "sense",
  "calm",
  "fightFoe",
  "cover",
  "hunt",
  "engaged",
  "orbs",
  "enemies",
  "tick",
] as const;

export type SecName = (typeof SECS)[number] | "syncAdopt" | "syncSquads" | "syncOrbs" | "setPlayer" | "pullRobots" | "pullSquads" | "pullOrbs" | "applyHits" | "stepSquads" | "stepFriends" | "stepFactions" | "tsEnemies" | "tsOrbs" | "other";

const ms: Record<string, number> = Object.create(null);
const counts: Record<string, number> = Object.create(null);

function nowNs(): number {
  const ht = nodeProcess()?.hrtime;
  if (ht?.bigint) return Number(ht.bigint());
  if (typeof performance !== "undefined") return performance.now() * 1e6;
  return Date.now() * 1e6;
}

export function profReset(): void {
  for (const k of Object.keys(ms)) delete ms[k];
  for (const k of Object.keys(counts)) delete counts[k];
  const e = nativeExports();
  e?.ringfall_sim_prof_reset?.();
}

export function profEnableWasm(): void {
  nativeExports()?.ringfall_sim_prof_enable?.(1);
}

export function profDisableWasm(): void {
  nativeExports()?.ringfall_sim_prof_enable?.(0);
}

export function profAdd(name: SecName, dtNs: number): void {
  if (!PROF_ON || !(dtNs > 0)) return;
  ms[name] = (ms[name] || 0) + dtNs * 1e-6;
}

export function profCount(name: string, n = 1): void {
  if (!PROF_ON) return;
  counts[name] = (counts[name] || 0) + n;
}

/** Time a sync section. No-op when profiling off. */
export function profTimed<T>(name: SecName, fn: () => T): T {
  if (!PROF_ON) return fn();
  const t0 = nowNs();
  try {
    return fn();
  } finally {
    profAdd(name, nowNs() - t0);
  }
}

export function beginScope(name: SecName): () => void {
  if (!PROF_ON) return () => {};
  const t0 = nowNs();
  return () => profAdd(name, nowNs() - t0);
}

/** Pull Rust section timers (ms) into the host map under `wasm.*`. */
export function pullWasmProf(): void {
  if (!PROF_ON) return;
  const e = nativeExports();
  if (!e?.ringfall_sim_prof_ms_ptr || !e.memory) return;
  const n = e.ringfall_sim_prof_ms_len?.() ?? SECS.length;
  const ptr = e.ringfall_sim_prof_ms_ptr();
  const view = new Float64Array(e.memory.buffer, ptr, n);
  for (let i = 0; i < n && i < SECS.length; i++) {
    ms[`wasm.${SECS[i]}`] = view[i];
  }
  if (e.ringfall_sim_prof_counts_ptr) {
    const cn = e.ringfall_sim_prof_counts_len?.() ?? 7;
    const cptr = e.ringfall_sim_prof_counts_ptr();
    const cv = new BigUint64Array(e.memory.buffer, cptr, cn);
    const names = ["huntBuilds", "huntCells", "calm", "fight", "cover", "sense", "engaged"];
    for (let i = 0; i < names.length && i < cn; i++) counts[`wasm.${names[i]}`] = Number(cv[i]);
  }
}

export function profSnapshot(): { ms: Record<string, number>; counts: Record<string, number> } {
  return {
    ms: { ...ms },
    counts: { ...counts },
  };
}

export function profNowNs(): number {
  return nowNs();
}
