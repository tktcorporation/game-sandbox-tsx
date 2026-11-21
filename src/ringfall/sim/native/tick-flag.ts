/**
 * Tiny, side-effect-free switch for the WASM tick host. Kept separate so `step.ts` can
 * skip importing / calling the heavy tick module on the default (bench) path.
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

function rawOrbs(): string | undefined {
  try {
    if (typeof location !== "undefined") {
      const q = new URLSearchParams(location.search).get("ringfallOrbs");
      if (q != null) return q;
    }
  } catch {
    /* ignore */
  }
  const env = (globalThis as { process?: NodeProcess }).process?.env;
  return env?.RINGFALL_ORBS;
}

const o = rawOrbs();

/** Opt-in WASM tick host (`RINGFALL_TICK=1`). Uploads geom / SoA; enemies still TS until ported. */
export const TICK_WASM = v === "1" || v === "wasm" || v === "on" || v === "true" || v === "check";
export const TICK_CHECK = v === "check";
/**
 * WASM `step_orbs` (off by default). Even with `RINGFALL_TICK=1`, orbs stay on TypeScript until
 * this is set — WASM los/terrain still drifts ~1 ULP/tick and changes the bench hash.
 */
export const ORBS_WASM = o === "1" || o === "wasm" || o === "on" || o === "true" || o === "check";
