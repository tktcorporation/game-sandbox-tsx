/**
 * Headroom probe: how many raids per skill×region change wall time and the noise of the
 * table's median alive% (reservoir beginner only, several seeds of the table).
 *
 *   npx tsx scripts/headroom/trials-probe.ts
 */
import "../ringfall-terrain-store";
import { playTable } from "../ringfall-table";

const cpu = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1e6;
};

/** Parse alive% from a summarize line like "beginner  70%  ..." */
function alivePct(line: string): number {
  const m = line.match(/\s(\d+)%\s/);
  return m ? Number(m[1]) : NaN;
}

const Ns = [5, 10, 12, 20, 30];
console.log("reservoir × 3 skills, one table each; wall/cpu for that block");
for (const n of Ns) {
  const c0 = cpu();
  const t0 = performance.now();
  const tables = ["beginner", "casual", "good"].map((skill) => playTable("reservoir", skill, n));
  const wall = (performance.now() - t0) / 1000;
  const c = cpu() - c0;
  const alives = tables.map((t) => alivePct(t.lines.find((l) => !l.err)!.text));
  console.log(`n=${String(n).padStart(2)}  wall=${wall.toFixed(1).padStart(6)}s  cpu=${c.toFixed(1).padStart(6)}s  alive%=${alives.map((a) => a + "%").join("/")}`);
}

/** Noise: for n in {10,30}, replay the beginner table with different entry offsets by shifting seeds via playTable's fixed seeds — instead run 6 independent "folds" of n raids by using playRaid directly with offset seeds is hard; approximate by splitting. */
console.log("--- fold noise: reservoir beginner, k folds of n raids (disjoint seeds via playRaid index) ---");
import { playRaid } from "../ringfall-table";

function foldAlive(n: number, fold: number): number {
  let alive = 0;
  for (let i = 0; i < n; i++) {
    const r = playRaid("reservoir", "beginner", fold * 100 + i);
    if (r.ended?.got) alive++;
  }
  return Math.round((100 * alive) / n);
}

// 4 folds × {5,10,20} keeps wall under ~15 min while still showing SD vs n.
for (const n of [5, 10, 20]) {
  const folds = [0, 1, 2, 3].map((f) => foldAlive(n, f));
  const mean = folds.reduce((a, b) => a + b, 0) / folds.length;
  const sd = Math.sqrt(folds.reduce((a, b) => a + (b - mean) ** 2, 0) / folds.length);
  console.log(`n=${n} folds=${folds.join(",")} mean=${mean.toFixed(1)} sd=${sd.toFixed(1)}`);
}
