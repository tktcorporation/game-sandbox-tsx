/**
 * Tiny, side-effect-free switch for the WASM tick host. Kept separate so `step.ts` can
 * skip importing / calling the heavy tick module on the default (bench) path.
 *
 * Opt-in only: `RINGFALL_TICK=1` / `?ringfallTick=1`. Browser and Node both default **off**
 * until statistical equivalence passes (see docs/ringfall/native.md).
 */
type NodeProcess = { env?: Record<string, string | undefined> };

function raw(): string | undefined {
  try {
    if (typeof location !== "undefined") {
      const q = new URLSearchParams(location.search).get("ringfallTick");
      if (q != null) return q;
    }
  } catch {
    /* ignore */
  }
  try {
    if (typeof localStorage !== "undefined") {
      const s = localStorage.getItem("ringfallTick");
      if (s != null) return s;
    }
  } catch {
    /* ignore */
  }
  const env = (globalThis as { process?: NodeProcess }).process?.env;
  return env?.RINGFALL_TICK;
}

const v = raw();

function isOn(s: string | undefined): boolean {
  return s === "1" || s === "wasm" || s === "on" || s === "true" || s === "check";
}

/** WASM tick: sense + engaged combat + orbs. Explicit opt-in only (browser + Node default off). */
export const TICK_WASM = isOn(v);
export const TICK_CHECK = v === "check";
/**
 * Orbs run in WASM whenever the tick host is on (folded into TICK). Kept as an alias so older
 * call sites / docs that mention `ORBS_WASM` still compile.
 */
export const ORBS_WASM = TICK_WASM;
