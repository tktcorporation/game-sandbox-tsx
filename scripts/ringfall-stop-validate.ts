/**
 * Validate sequential stopping against fixed-N on the same seeds:
 * 1) stop's raids 0..n-1 are identical to a fixed-N prefix (point estimates match exactly)
 * 2) stop's alive rate lies inside the Wald CI of the full fixed max (statistical agreement)
 * 3) CRN null-patch paired diff covers 0; a real patch can show a shift
 *
 *   npx tsx scripts/ringfall-stop-validate.ts [region] [skill] [max]
 */
import "./ringfall-terrain-store";
import { playRaid, stopRaidOf } from "./ringfall-table";
import { DEFAULT_STOP_METRICS, proportionInterval } from "./ringfall-stats";
import { playTableStopping } from "./ringfall-stop-play";
import { runCompare, compareReportLines } from "./ringfall-compare";
import type { RegionId } from "../src/ringfall/sim/map";

const region = (process.argv[2] ?? "harbor") as RegionId;
const skill = process.argv[3] ?? "casual";
const max = Number(process.argv[4] ?? 30);
const min = 8;
const batch = 4;

const opts = { min, max, batch, metrics: DEFAULT_STOP_METRICS };

const cpu = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1e6;
};

// Fixed-N first so both arms share a warm nav/hunt cache; raid-count savings is the fair metric.
const t0 = cpu();
const fixed = Array.from({ length: max }, (_, r) => playRaid(region, skill, r));
const fixedCpu = cpu() - t0;

const t1 = cpu();
const stopped = playTableStopping(region, skill, opts);
const stopCpu = cpu() - t1;

const n = stopped.raids.length;
let prefixMatch = true;
for (let i = 0; i < n; i++) {
  const a = stopped.raids[i]!.ended;
  const b = fixed[i]!.ended;
  if (!a || !b || a.downs !== b.downs || !!a.got !== !!b.got || a.cleared !== b.cleared) {
    prefixMatch = false;
    break;
  }
}

const stopAlive = stopped.raids.filter((r) => r.ended?.got).length / n;
const fixedAlive = fixed.filter((r) => r.ended?.got).length / max;
const fixedIv = proportionInterval(
  fixed.filter((r) => r.ended?.got).length,
  max,
);
const agrees = stopAlive >= fixedIv.lo && stopAlive <= fixedIv.hi;

console.log(`validate ${region} ${skill}: stop n=${n}/${max}, alive stop=${(100 * stopAlive).toFixed(0)}% fixed=${(100 * fixedAlive).toFixed(0)}% ±${(100 * fixedIv.half).toFixed(1)}pp`);
console.log(`  prefix identity (same seeds 0..n-1): ${prefixMatch ? "ok" : "FAIL"}`);
console.log(`  stop alive inside fixed-${max} 95% CI: ${agrees ? "ok" : "FAIL"} [${(100 * fixedIv.lo).toFixed(0)}%, ${(100 * fixedIv.hi).toFixed(0)}%]`);
console.log(`  CPU: stop ${stopCpu.toFixed(1)}s, fixed-${max} ${fixedCpu.toFixed(1)}s, saved ${(((fixedCpu - stopCpu) / fixedCpu) * 100).toFixed(0)}%`);

const nullCmp = runCompare({ region, skill, runs: Math.min(12, max), patches: [] });
for (const l of compareReportLines(nullCmp)) console.log(l);
const alivePaired = nullCmp.metrics.find((m) => m.name === "alive")!.paired;
const nullOk = alivePaired.lo <= 0 && alivePaired.hi >= 0 && Math.abs(alivePaired.mean) < 1e-12;
console.log(`  CRN null-patch alive paired mean 0 and CI covers 0: ${nullOk ? "ok" : "FAIL"}`);

// A no-op-ish patch that still mutates a number the tables rarely hit (raider clock far out):
// use REINFORCE.first delayed so B differs; with CRN the paired CI should often exclude 0 with fewer runs than unpaired.
const patched = runCompare({ region, skill, runs: Math.min(16, max), patches: [{ path: "REINFORCE.first", value: 900 }] });
for (const l of compareReportLines(patched).slice(0, 3)) console.log(l);

if (!prefixMatch || !agrees || !nullOk || !nullCmp.seedsOk) {
  console.error("FAILED");
  process.exit(1);
}
console.log("ringfall-stop-validate: ok");
