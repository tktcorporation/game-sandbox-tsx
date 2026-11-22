/**
 * Checks the quality governor ignores one-off spikes and only steps down on sustained slowness,
 * then recovers when headroom returns.
 */
import { Governor } from "../src/ringfall/view/quality";

const budget = 1000 / 60;
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    failed++;
    console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
  } else console.log(`ok ${name}${detail ? `: ${detail}` : ""}`);
};

/** Drain the post-construct / post-settle cooldown with on-budget frames. */
const warm = (g: Governor, frames = 200) => {
  for (let i = 0; i < frames; i++) g.frame(budget);
};

{
  const g = new Governor("high", 1, false);
  warm(g);
  const before = g.level;
  // One 200 ms hitch must not by itself force a downgrade.
  g.frame(200);
  warm(g, 60);
  check("spike ignored", g.level.tier === before.tier && g.level.ratio === before.ratio, `level=${g.level.tier}@${g.level.ratio}`);
}

{
  const g = new Governor("high", 1, false);
  warm(g);
  let changed: ReturnType<Governor["frame"]> = null;
  // 1.5× budget is over OVER (1.25×) and under the spike cap (2.2×), so sustained frames count.
  for (let i = 0; i < 400; i++) {
    const n = g.frame(budget * 1.5);
    if (n) {
      changed = n;
      break;
    }
  }
  check("sustained over steps down", !!changed && (changed.ratio < 1 || changed.tier !== "high"), JSON.stringify(changed));
}

{
  const g = new Governor("high", 1, false);
  warm(g);
  for (let i = 0; i < 400 && g.level.tier === "high" && g.level.ratio >= 1; i++) g.frame(budget * 1.6);
  const down = { ...g.level };
  check("reached a lower rung", down.ratio < 1 || down.tier !== "high", JSON.stringify(down));
  // Block starts at 45 s; feed fast frames until the higher rung is tried again and held.
  let recovered = false;
  for (let i = 0; i < 8000; i++) {
    const n = g.frame(budget * 0.7);
    if (n && (n.ratio > down.ratio || (n.tier === "high" && down.tier !== "high"))) {
      recovered = true;
      break;
    }
  }
  check("recovers when headroom returns", recovered || g.level.ratio > down.ratio || g.level.tier === "high", `from ${JSON.stringify(down)} to ${JSON.stringify(g.level)}`);
}

if (failed) {
  console.error(`${failed} checks failed`);
  process.exit(1);
}
console.log("quality governor ok");
