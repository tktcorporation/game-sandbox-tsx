import { rand, randInt, type Seeded } from "../../arcade/rng";

/*
 * 延焼線 — triage against a spreading fire.
 *
 * Fire spreads tile to tile, strongly downwind. The wind's next direction is
 * forecast with a countdown, so the player digs firebreaks for the wind that
 * is coming, not the one blowing now. Crews are scarce: every break costs
 * forest the player chooses to give up.
 */

export type Kind = "grass" | "forest" | "village" | "water" | "rock";
export type Dir = 0 | 1 | 2 | 3; // N E S W
export const DX = [0, 1, 0, -1] as const;
export const DY = [-1, 0, 1, 0] as const;
export const DIR_NAME = ["北", "東", "南", "西"] as const;

export interface Cell {
  kind: Kind;
  /** Ticks left burning; 0 = not burning. */
  fire: number;
  burnt: boolean;
  dug: boolean;
  /** Ticks left of being soaked (cannot ignite). */
  wet: number;
}

export interface State extends Seeded {
  w: number;
  h: number;
  cells: Cell[];
  tick: number;
  wind: Dir;
  nextWind: Dir;
  windIn: number;
  crews: number;
  crewTimer: number;
  level: number;
  startValue: number;
  over: boolean;
}

export const VALUE: Record<Kind, number> = { grass: 0, forest: 1, village: 10, water: 0, rock: 0 };
const BURN_TIME: Record<Kind, number> = { grass: 2, forest: 5, village: 6, water: 0, rock: 0 };
const IGNITE: Record<Kind, number> = { grass: 0.42, forest: 0.24, village: 0.34, water: 0, rock: 0 };

export const MAX_CREWS = 6;
/** Ticks per crew regained; later levels give crews back more slowly. */
export const crewEvery = (level: number) => 2 + Math.floor((level - 1) / 3);
export const DIG_COST = 1;
export const DOUSE_COST = 4;
export const WIND_EVERY = 14;

export const idx = (s: State, x: number, y: number) => y * s.w + x;
export const inBounds = (s: State, x: number, y: number) => x >= 0 && y >= 0 && x < s.w && y < s.h;

export const flammable = (c: Cell) => !c.burnt && !c.dug && c.fire === 0 && c.wet === 0 && IGNITE[c.kind] > 0;

export function value(s: State): number {
  let v = 0;
  for (const c of s.cells) if (!c.burnt && !c.dug) v += VALUE[c.kind];
  return v;
}

export function villages(s: State): { alive: number; total: number } {
  let alive = 0;
  let total = 0;
  for (const c of s.cells)
    if (c.kind === "village") {
      total++;
      if (!c.burnt) alive++;
    }
  return { alive, total };
}

export function burning(s: State): number {
  return s.cells.reduce((n, c) => n + (c.fire > 0 ? 1 : 0), 0);
}

/** Spread multiplier from the wind for fire moving in direction d. */
function windFactor(wind: Dir, d: Dir): number {
  if (d === wind) return 2.2;
  if ((d + 2) % 4 === wind) return 0.2;
  return 0.65;
}

export function step(s0: State): State {
  if (s0.over) return s0;
  const s = structuredClone(s0);
  const ignite: number[] = [];
  for (let y = 0; y < s.h; y++)
    for (let x = 0; x < s.w; x++) {
      const c = s0.cells[idx(s0, x, y)];
      if (c.fire === 0) continue;
      for (const d of [0, 1, 2, 3] as Dir[]) {
        const nx = x + DX[d];
        const ny = y + DY[d];
        if (!inBounds(s, nx, ny)) continue;
        const t = s0.cells[idx(s0, nx, ny)];
        if (!flammable(t)) continue;
        if (rand(s) < IGNITE[t.kind] * windFactor(s0.wind, d)) ignite.push(idx(s, nx, ny));
      }
      // Embers carried two tiles downwind jump a single-tile firebreak.
      const jx = x + DX[s0.wind] * 2;
      const jy = y + DY[s0.wind] * 2;
      if (inBounds(s, jx, jy) && flammable(s0.cells[idx(s0, jx, jy)]) && rand(s) < 0.07) ignite.push(idx(s, jx, jy));
    }
  for (const c of s.cells) {
    if (c.wet > 0) c.wet--;
    if (c.fire > 0) {
      c.fire--;
      if (c.fire === 0) c.burnt = true;
    }
  }
  for (const i of ignite) {
    const c = s.cells[i];
    if (c.fire === 0 && !c.burnt) c.fire = BURN_TIME[c.kind];
  }

  s.tick++;
  s.windIn--;
  if (s.windIn <= 0) {
    s.wind = s.nextWind;
    s.nextWind = rollWind(s);
    s.windIn = WIND_EVERY;
  }
  s.crewTimer++;
  if (s.crewTimer >= crewEvery(s.level)) {
    s.crewTimer = 0;
    s.crews = Math.min(MAX_CREWS, s.crews + 1);
  }
  if (burning(s) === 0) s.over = true;
  return s;
}

/**
 * The wind comes down off the mountains: it never blows north. It swings
 * between south-east, south and south-west, so a forecast is a real choice of
 * which flank to defend.
 */
function rollWind(s: State): Dir {
  if (s.wind === 2) return rand(s) < 0.5 ? 1 : 3;
  return rand(s) < 0.7 ? 2 : (((s.wind + 2) % 4) as Dir);
}

export function canDig(s: State, x: number, y: number): boolean {
  if (s.over || s.crews < DIG_COST || !inBounds(s, x, y)) return false;
  const c = s.cells[idx(s, x, y)];
  return !c.dug && !c.burnt && c.fire === 0 && (c.kind === "grass" || c.kind === "forest");
}

export function dig(s: State, x: number, y: number): State {
  if (!canDig(s, x, y)) return s;
  const n = structuredClone(s);
  n.cells[idx(n, x, y)].dug = true;
  n.crews -= DIG_COST;
  return n;
}

export const DOUSE_SHAPE = [
  [0, 0],
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

export function canDouse(s: State): boolean {
  return !s.over && s.crews >= DOUSE_COST;
}

/** Water drop: puts out and soaks a plus-shaped patch for a while. */
export function douse(s: State, x: number, y: number): State {
  if (!canDouse(s) || !inBounds(s, x, y)) return s;
  const n = structuredClone(s);
  for (const [dx, dy] of DOUSE_SHAPE) {
    const px = x + dx;
    const py = y + dy;
    if (!inBounds(n, px, py)) continue;
    const c = n.cells[idx(n, px, py)];
    if (c.fire > 0) c.fire = 0;
    if (!c.burnt) c.wet = 10;
  }
  n.crews -= DOUSE_COST;
  if (burning(n) === 0) n.over = true;
  return n;
}

// --------------------------------------------------------------- creation

export function newLevel(level: number, seed: number): State {
  const w = 14;
  const h = 20;
  const s: State = {
    rng: (seed ^ Math.imul(level, 0x85ebca6b)) >>> 0,
    w,
    h,
    cells: [],
    tick: 0,
    wind: 2,
    nextWind: 2,
    windIn: WIND_EVERY,
    crews: MAX_CREWS,
    crewTimer: 0,
    level,
    startValue: 0,
    over: false,
  };
  // Value noise: a few random blobs of forest over grass.
  const blobs = Array.from({ length: 9 }, () => ({ x: rand(s) * w, y: rand(s) * h, r: 2.2 + rand(s) * 3 }));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const f = blobs.some((b) => (b.x - x) ** 2 + (b.y - y) ** 2 < b.r * b.r);
      s.cells.push({ kind: f ? "forest" : rand(s) < 0.25 ? "forest" : "grass", fire: 0, burnt: false, dug: false, wet: 0 });
    }
  // A creek and a few rocks give natural breaks to build from.
  let cx = 2 + randInt(s, w - 4);
  for (let y = 0; y < h; y++) {
    if (rand(s) < 0.35) cx = Math.max(0, Math.min(w - 1, cx + (rand(s) < 0.5 ? -1 : 1)));
    if (y > h * 0.35 && y < h * 0.75) s.cells[idx(s, cx, y)].kind = "water";
  }
  for (let i = 0; i < 6; i++) s.cells[idx(s, randInt(s, w), randInt(s, h))].kind = "rock";

  // Villages in the lower half, fire starts in the upper third.
  const villageCount = 3 + (level >= 3 ? 1 : 0);
  let placed = 0;
  while (placed < villageCount) {
    const x = 1 + randInt(s, w - 3);
    const y = Math.floor(h * 0.55) + randInt(s, Math.floor(h * 0.4));
    const cells = [idx(s, x, y), idx(s, x + 1, y)];
    if (cells.some((i) => s.cells[i].kind === "village" || s.cells[i].kind === "water")) continue;
    for (const i of cells) s.cells[i].kind = "village";
    placed++;
  }
  const fires = 2 + Math.min(3, Math.floor(level / 2));
  for (let i = 0; i < fires; i++) {
    const x = randInt(s, w);
    const y = randInt(s, Math.floor(h * 0.3));
    const c = s.cells[idx(s, x, y)];
    if (c.kind === "water" || c.kind === "rock") continue;
    c.kind = "forest";
    c.fire = BURN_TIME.forest;
  }
  s.wind = 2;
  s.nextWind = rollWind(s);
  s.startValue = value(s);
  return s;
}

export function stars(s: State): number {
  const v = villages(s);
  if (v.alive === v.total && value(s) >= s.startValue * 0.45) return 3;
  if (v.alive === v.total) return 2;
  if (v.alive * 2 >= v.total) return 1;
  return 0;
}

/**
 * Wind-weighted estimate of how many ticks until fire reaches each cell
 * (Infinity if it cannot). Uses the forecast wind once the change is close,
 * because that is the wind the fire will be travelling in.
 */
export function arrival(s: State, blocked = -1): Float64Array {
  const dist = new Float64Array(s.w * s.h).fill(Infinity);
  const open: number[] = [];
  s.cells.forEach((c, i) => {
    if (c.fire > 0) {
      dist[i] = 0;
      open.push(i);
    }
  });
  const wind = s.windIn <= 5 ? s.nextWind : s.wind;
  while (open.length) {
    let bi = 0;
    for (let k = 1; k < open.length; k++) if (dist[open[k]] < dist[open[bi]]) bi = k;
    const i = open.splice(bi, 1)[0];
    const x = i % s.w;
    const y = Math.floor(i / s.w);
    for (const d of [0, 1, 2, 3] as Dir[]) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      if (!inBounds(s, nx, ny)) continue;
      const j = idx(s, nx, ny);
      const c = s.cells[j];
      if (j === blocked || c.burnt || c.dug || c.kind === "water" || c.kind === "rock") continue;
      const cost = (d === wind ? 1 : (d + 2) % 4 === wind ? 6 : 2.5) * (c.kind === "grass" ? 0.8 : 1.2);
      if (dist[i] + cost < dist[j]) {
        dist[j] = dist[i] + cost;
        open.push(j);
      }
    }
  }
  return dist;
}
