/**
 * Tiny, side-effect-free switch for the WASM tick host. Kept separate so `step.ts` can
 * skip importing / calling the heavy tick module on the default (bench) path.
 *
 * `RINGFALL_TICK=1` runs enemies (sense + engaged FSM) and orbs in WASM (ORBS folded in).
 * Browser: default on unless `?ringfallTick=0` / localStorage 0.
 * Node: default off unless `RINGFALL_TICK=1` (keeps the bench hash on TypeScript).
 */
type NodeProcess = { env?: Record<string, string | undefined>; versions?: { node?: string } };

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

function isOff(s: string | undefined): boolean {
  return s === "0" || s === "ts" || s === "off" || s === "false";
}

function isOn(s: string | undefined): boolean {
  return s === "1" || s === "wasm" || s === "on" || s === "true" || s === "check";
}

function isBrowser(): boolean {
  try {
    // Real page (incl. Playwright): DOM + no Node version. Vite may shim `process.env` in the
    // bundle, so do not treat a bare `process` as Node.
    return typeof document !== "undefined" && typeof location !== "undefined" && !(globalThis as { process?: NodeProcess }).process?.versions?.node;
  } catch {
    return false;
  }
}

/** WASM tick: sense + engaged combat + orbs. Off wins; else explicit on; else browser default. */
export const TICK_WASM = isOff(v) ? false : isOn(v) ? true : isBrowser();
export const TICK_CHECK = v === "check";
/**
 * Orbs run in WASM whenever the tick host is on (folded into TICK). Kept as an alias so older
 * call sites / docs that mention `ORBS_WASM` still compile.
 */
export const ORBS_WASM = TICK_WASM;
