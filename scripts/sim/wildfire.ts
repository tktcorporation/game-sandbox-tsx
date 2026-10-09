/**
 * Headless sim for 延焼線. Players act once per tick:
 *   none    — watches
 *   random  — digs a random diggable tile whenever a crew is free
 *   planner — digs the tile that most delays the fire's cheapest route to a
 *             village (wind-weighted shortest path), douses fire touching a village
 */
import {
  canDig, canDouse, dig, douse, DX, DY, idx, inBounds, newLevel, stars, step, value, villages,
  DIG_COST, DOUSE_COST, type Dir, type State,
} from "../../src/games/wildfire/logic";

type Policy = (s: State, roll: () => number) => State;

function arrival(s: State, blocked = -1): Float64Array {
  const dist = new Float64Array(s.w * s.h).fill(Infinity);
  const open: number[] = [];
  s.cells.forEach((c, i) => {
    if (c.fire > 0) { dist[i] = 0; open.push(i); }
  });
  const wind = s.windIn <= 5 ? s.nextWind : s.wind;
  while (open.length) {
    let bi = 0;
    for (let k = 1; k < open.length; k++) if (dist[open[k]] < dist[open[bi]]) bi = k;
    const i = open.splice(bi, 1)[0];
    const x = i % s.w, y = Math.floor(i / s.w);
    for (const d of [0, 1, 2, 3] as Dir[]) {
      const nx = x + DX[d], ny = y + DY[d];
      if (!inBounds(s, nx, ny)) continue;
      const j = idx(s, nx, ny);
      const c = s.cells[j];
      if (j === blocked || c.burnt || c.dug || c.kind === "water" || c.kind === "rock") continue;
      const cost = (d === wind ? 1 : (d + 2) % 4 === wind ? 6 : 2.5) * (c.kind === "grass" ? 0.8 : 1.2);
      if (dist[i] + cost < dist[j]) { dist[j] = dist[i] + cost; open.push(j); }
    }
  }
  return dist;
}

const villageMin = (s: State, d: Float64Array) =>
  s.cells.reduce((m, c, i) => (c.kind === "village" && !c.burnt && c.fire === 0 ? Math.min(m, d[i]) : m), Infinity);

const none: Policy = (s) => s;

const random: Policy = (s, roll) => {
  for (let k = 0; k < 20 && s.crews >= DIG_COST; k++) {
    const x = Math.floor(roll() * s.w), y = Math.floor(roll() * s.h);
    if (canDig(s, x, y)) return dig(s, x, y);
  }
  return s;
};

const planner: Policy = (s) => {
  if (canDouse(s)) {
    for (let i = 0; i < s.cells.length; i++) {
      if (s.cells[i].fire === 0) continue;
      const x = i % s.w, y = Math.floor(i / s.w);
      const near = [0, 1, 2, 3].some((d) => {
        const nx = x + DX[d], ny = y + DY[d];
        return inBounds(s, nx, ny) && s.cells[idx(s, nx, ny)].kind === "village" && !s.cells[idx(s, nx, ny)].burnt;
      });
      if (near) return douse(s, x, y);
    }
  }
  if (s.crews < DIG_COST) return s;
  const base = arrival(s);
  const before = villageMin(s, base);
  if (before === Infinity) return s;
  let best = -1, gain = 0;
  for (let i = 0; i < s.cells.length; i++) {
    if (base[i] < 1.5 || base[i] > before) continue;
    const x = i % s.w, y = Math.floor(i / s.w);
    if (!canDig(s, x, y)) continue;
    const g = villageMin(s, arrival(s, i)) - before;
    if (g > gain) { gain = g; best = i; }
  }
  return best >= 0 ? dig(s, best % s.w, Math.floor(best / s.w)) : s;
};

function play(level: number, seed: number, p: Policy) {
  let r = seed * 48271 + 7;
  const roll = () => ((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let s = newLevel(level, seed);
  while (!s.over && s.tick < 500) {
    s = p(s, roll);
    s = step(s);
  }
  const v = villages(s);
  return { stars: stars(s), saved: value(s) / s.startValue, villages: v.alive / v.total, ticks: s.tick };
}

const runs = Number(process.argv[2] ?? 60);
const levels = (process.argv[3] ?? "1,3,5").split(",").map(Number);
const only = process.argv[4];
const policies = ([["none", none], ["random", random], ["planner", planner]] as [string, Policy][]).filter(([n]) => !only || n === only);
console.log(`levels × policy, ${runs} seeds each`);
console.log("level policy    ★0   ★1   ★2   ★3   value saved  villages  ticks");
for (const level of levels)
  for (const [name, p] of policies) {
    const st = [0, 0, 0, 0];
    let saved = 0, vil = 0, ticks = 0;
    for (let i = 0; i < runs; i++) {
      const r = play(level, 500 + i, p);
      st[r.stars]++; saved += r.saved; vil += r.villages; ticks += r.ticks;
    }
    const pct = (n: number) => `${Math.round(n * 100)}%`.padStart(4);
    console.log(`${String(level).padStart(5)} ${name.padEnd(8)} ${st.map((n) => pct(n / runs)).join(" ")}   ${pct(saved / runs).padStart(9)}  ${pct(vil / runs).padStart(8)}  ${(ticks / runs).toFixed(0).padStart(5)}`);
  }
