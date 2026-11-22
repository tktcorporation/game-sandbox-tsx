/**
 * How many worker processes the RINGFALL sim gate and bench should start by default:
 * the machine's physical cores, not logical threads (SMT / Hyper-Threading). CPU-bound
 * raid workers share L1/L2 when two threads sit on one core, so logical parallelism often
 * stretches wall time; physical cores are the safer default. RINGFALL_SIM_JOBS and `--jobs`
 * still override.
 *
 * Detection: Linux `/proc/cpuinfo` (unique physical-id+core-id), then `lscpu`; macOS
 * `sysctl hw.physicalcpu`; else `os.availableParallelism()`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { pathToFileURL } from "node:url";

/** Logical threads Node reports (SMT counted). */
export const logicalCores = (): number => Math.max(1, availableParallelism());

/** Unique (package, core) pairs from `/proc/cpuinfo`, or 0 if unreadable. */
function fromProcCpuinfo(): number {
  try {
    const text = readFileSync("/proc/cpuinfo", "utf8");
    const cores = new Set<string>();
    let physical = "";
    let core = "";
    for (const line of text.split("\n")) {
      if (line.startsWith("physical id")) physical = line.split(":")[1]?.trim() ?? "";
      else if (line.startsWith("core id")) core = line.split(":")[1]?.trim() ?? "";
      else if (line === "" && physical !== "" && core !== "") {
        cores.add(`${physical}:${core}`);
        physical = "";
        core = "";
      }
    }
    if (physical !== "" && core !== "") cores.add(`${physical}:${core}`);
    return cores.size;
  } catch {
    return 0;
  }
}

/** `lscpu` Core(s) per socket × Socket(s), or 0. */
function fromLscpu(): number {
  try {
    const out = execFileSync("lscpu", ["-p=Core,Socket"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const pairs = new Set<string>();
    for (const line of out.split("\n")) {
      if (!line || line.startsWith("#")) continue;
      const [core, socket] = line.split(",");
      if (core !== undefined && socket !== undefined) pairs.add(`${socket}:${core}`);
    }
    return pairs.size;
  } catch {
    return 0;
  }
}

/** macOS `sysctl -n hw.physicalcpu`, or 0. */
function fromSysctl(): number {
  try {
    const n = Number(execFileSync("sysctl", ["-n", "hw.physicalcpu"], { encoding: "utf8" }).trim());
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

/**
 * Physical cores when detectable, else logical. Never returns less than 1, and never more
 * than the logical count (a bad parse must not oversubscribe beyond what the OS exposes).
 */
export function physicalCores(): number {
  const logical = logicalCores();
  const found = fromProcCpuinfo() || fromLscpu() || fromSysctl();
  if (found > 0) return Math.min(logical, found);
  return logical;
}

/** Default worker count for sim / bench when no env or argv override is set. */
export const defaultSimJobs = (): number => physicalCores();

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const physical = physicalCores();
  const logical = logicalCores();
  console.log(`physical=${physical} logical=${logical} default=${defaultSimJobs()} via=${fromProcCpuinfo() ? "proc" : fromLscpu() ? "lscpu" : fromSysctl() ? "sysctl" : "logical"}`);
}
