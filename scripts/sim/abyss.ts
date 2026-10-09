/**
 * Headless sim for 深淵採掘. A player ascends once the chance that the next card
 * collapses the shaft exceeds a threshold. Optional shopping buys whatever is
 * affordable in a fixed order while at least `minDivesLeft` dives remain.
 * The game works when the best threshold sits in the middle and shopping pays.
 */
import { ascend, beginDive, bustChance, buy, canBuy, descend, finished, newRun, useLantern, type Item, type Run } from "../../src/games/abyss/logic";

function play(seed: number, threshold: number, shop: Item[] | null, minDivesLeft = 3) {
  let r: Run = newRun(seed);
  let busts = 0;
  while (!finished(r)) {
    if (shop && r.dives - r.dive >= minDivesLeft) for (const it of shop) while (canBuy(r, it)) r = buy(r, it);
    r = beginDive(r);
    while (r.current && !r.current.end) {
      if (bustChance(r.current) > 0) r = useLantern(r);
      const p = bustChance(r.current);
      const shield = r.owned.helmet && !r.current.helmetUsed;
      if (p > threshold && !shield) r = ascend(r);
      else r = descend(r);
    }
    if (r.current?.end === "bust") busts++;
  }
  return { score: r.bank, busts };
}

const runs = Number(process.argv[2] ?? 2000);
const thresholds = [0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 1];
const shops: [string, Item[] | null][] = [
  ["no shop", null],
  ["rope first", ["rope", "lantern", "helmet"]],
  ["helmet first", ["helmet", "lantern", "rope"]],
  ["lantern only", ["lantern"]],
];
console.log(`${runs} runs per cell. cells = mean score (p10–p90), busts/run`);
console.log("threshold  " + shops.map(([n]) => n.padEnd(26)).join(""));
for (const t of thresholds) {
  const cells = shops.map(([, shop]) => {
    const scores: number[] = [];
    let busts = 0;
    for (let i = 0; i < runs; i++) {
      const g = play(9000 + i, t, shop);
      scores.push(g.score);
      busts += g.busts;
    }
    scores.sort((a, b) => a - b);
    const mean = scores.reduce((a, b) => a + b, 0) / runs;
    return `${mean.toFixed(0).padStart(4)} (${scores[Math.floor(runs * 0.1)]}–${scores[Math.floor(runs * 0.9)]}) ${(busts / runs).toFixed(1)}`.padEnd(26);
  });
  console.log(`${t.toFixed(2).padStart(9)}  ${cells.join("")}`);
}
