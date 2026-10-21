import { WORLD } from "./config";
import { BOXES, deckAt, ROUTES, type Box } from "./map";
import { steepAt, terrainGrad, terrainHeight } from "./terrain";
import type { Vec3 } from "./state";

/*
 * Boxes span y0..h, so floors, roofs and bridges can float above open space.
 * A coarse grid finds the boxes near a point, and rays walk the cells they cross.
 */
const CELL = 8;
/** Every box any world may hold: the map's, then each route's, closed and open. */
const ALL = [...BOXES, ...ROUTES.flatMap((r) => [...r.closed, ...r.open])];
const indexOf = new Map(ALL.map((b, i) => [b, i]));
/**
 * The grid, as a flat array over the cells any box spans (a cell outside them holds none). A
 * cell's boxes are kept as boxes and, beside them, as their places in `ALL`, in the same order.
 */
let minCx = Infinity;
let maxCx = -Infinity;
let minCz = Infinity;
let maxCz = -Infinity;
for (const b of ALL) {
  minCx = Math.min(minCx, Math.floor(b.x0 / CELL));
  maxCx = Math.max(maxCx, Math.floor(b.x1 / CELL));
  minCz = Math.min(minCz, Math.floor(b.z0 / CELL));
  maxCz = Math.max(maxCz, Math.floor(b.z1 / CELL));
}
const SPAN_Z = maxCz - minCz + 1;
const cellBoxes: (Box[] | undefined)[] = new Array((maxCx - minCx + 1) * SPAN_Z);
const cellIds: (number[] | undefined)[] = new Array(cellBoxes.length);
/** The place of cell (cx, cz) in the grid's arrays, or -1 when no box can lie there. */
const cellAt = (cx: number, cz: number) => (cx < minCx || cx > maxCx || cz < minCz || cz > maxCz ? -1 : (cx - minCx) * SPAN_Z + (cz - minCz));
/** The grid cells a box spans, as places in the grid's arrays. */
function cellsOf(b: Box): number[] {
  const out: number[] = [];
  for (let cx = Math.floor(b.x0 / CELL); cx <= Math.floor(b.x1 / CELL); cx++) for (let cz = Math.floor(b.z0 / CELL); cz <= Math.floor(b.z1 / CELL); cz++) out.push(cellAt(cx, cz));
  return out;
}
const addToGrid = (b: Box) => {
  const i = indexOf.get(b)!;
  for (const c of cellsOf(b)) {
    const list = cellBoxes[c];
    if (list) {
      list.push(b);
      cellIds[c]!.push(i);
    } else {
      cellBoxes[c] = [b];
      cellIds[c] = [i];
    }
  }
};
for (const b of BOXES) addToGrid(b);
const seenBy = new Int32Array(ALL.length);
let rayId = 0;
/** Each box once, in the order the cells list them; a box spanning cells is kept by its stamp. */
const scratch: Box[] = [];
const nearBy = new Int32Array(ALL.length);
let nearId = 0;
const NONE: readonly Box[] = [];
function near(x: number, z: number, r: number): readonly Box[] {
  const cx0 = Math.floor((x - r) / CELL);
  const cx1 = Math.floor((x + r) / CELL);
  const cz0 = Math.floor((z - r) / CELL);
  const cz1 = Math.floor((z + r) / CELL);
  // Within one cell its list holds each box once already.
  if (cx0 === cx1 && cz0 === cz1) {
    const c = cellAt(cx0, cz0);
    return (c >= 0 && cellBoxes[c]) || NONE;
  }
  scratch.length = 0;
  nearId++;
  for (let cx = cx0; cx <= cx1; cx++)
    for (let cz = cz0; cz <= cz1; cz++) {
      const c = cellAt(cx, cz);
      if (c < 0) continue;
      const list = cellBoxes[c];
      if (!list) continue;
      const ids = cellIds[c]!;
      for (let n = 0; n < list.length; n++) {
        const i = ids[n];
        if (nearBy[i] === nearId) continue;
        nearBy[i] = nearId;
        scratch.push(list[n]);
      }
    }
  return scratch;
}

/** The routes' boxes in the grid now: the obstacles of those closed and what stands on those open. */
let routeBoxes: Box[] = [];
/** The closed routes' obstacles among them: 1 at their places in `ALL`. */
const obstacle = new Uint8Array(ALL.length);
/**
 * What stands on the open routes (a roof, a gangway). Path finding (nav.ts, hunt.ts) counts these
 * as it counts the map's boxes, but not a closed route's obstacles: they stand in the cliff a
 * route will be cut through, or on the deck a gangway climbs to, where path finding already goes
 * no further. So with every route closed the walkers' grids are the ones the map alone gives.
 */
export let routeBoxesOpen: readonly Box[] = [];

/** Counts the worlds put in place (`setRouteBoxes()`): an answer of `groundAt()` kept from an earlier world is stale. */
export let worldVersion = 0;

/**
 * Puts the routes' boxes for one set of open routes into the grid (routes.ts), after the map's
 * own: a cell's boxes keep their order, so a world with every route closed meets the map's
 * boxes exactly as before, and its obstacles only where something reaches them.
 */
export function setRouteBoxes(closed: Box[], open: Box[]) {
  for (const b of routeBoxes)
    for (const c of cellsOf(b)) {
      const list = cellBoxes[c]!;
      const ids = cellIds[c]!;
      const keep = list.flatMap((o, n) => (o !== b ? [n] : []));
      if (keep.length) {
        cellBoxes[c] = keep.map((n) => list[n]);
        cellIds[c] = keep.map((n) => ids[n]);
      } else cellBoxes[c] = cellIds[c] = undefined;
    }
  for (const b of routeBoxes) obstacle[indexOf.get(b)!] = 0;
  routeBoxes = [...closed, ...open];
  for (const b of closed) obstacle[indexOf.get(b)!] = 1;
  for (const b of routeBoxes) addToGrid(b);
  routeBoxesOpen = open;
  worldVersion++;
}
setRouteBoxes(
  ROUTES.flatMap((r) => r.closed),
  [],
);

/**
 * Height of the highest surface under a circle at (x, z) that a body with feet at
 * `feet` can stand on: a box top or the terrain. Terrain above reach (a cliff face)
 * does not count, unless nothing else is there to stand on.
 */
export function groundAt(x: number, z: number, r: number, feet: number): number {
  const t = terrainHeight(x, z);
  let g = t <= feet + WORLD.stepUp ? t : -Infinity;
  for (const b of near(x, z, r)) {
    if (b.h > feet + WORLD.stepUp || b.h <= g) continue;
    if (x + r * 0.7 < b.x0 || x - r * 0.7 > b.x1 || z + r * 0.7 < b.z0 || z - r * 0.7 > b.z1) continue;
    g = b.h;
  }
  return g === -Infinity ? t : g;
}

/** Lowest underside of a box above a circle's head, or Infinity. */
export function ceilingAt(x: number, z: number, r: number, head: number, feet: number): number {
  let c = Infinity;
  for (const b of near(x, z, r)) {
    if (b.y0 <= feet + WORLD.stepUp || b.y0 > head + 0.5 || b.y0 >= c) continue;
    if (x + r * 0.7 < b.x0 || x - r * 0.7 > b.x1 || z + r * 0.7 < b.z0 || z - r * 0.7 > b.z1) continue;
    c = b.y0;
  }
  return c;
}

/**
 * Push a circle out of every box that overlaps its body (feet + step .. feet + height).
 * Returns true if it touched one.
 */
export function collide(p: Vec3, r: number, height = 1.75): boolean {
  let touched = false;
  for (const b of near(p.x, p.z, r)) {
    if (b.h <= p.y + WORLD.stepUp || b.y0 >= p.y + height) continue;
    const cx = Math.max(b.x0, Math.min(p.x, b.x1));
    const cz = Math.max(b.z0, Math.min(p.z, b.z1));
    const dx = p.x - cx;
    const dz = p.z - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 >= r * r) continue;
    touched = true;
    if (d2 > 1e-8) {
      const d = Math.sqrt(d2);
      p.x = cx + (dx / d) * r;
      p.z = cz + (dz / d) * r;
    } else {
      // Centre inside the box: leave along the shortest side.
      const out = [p.x - b.x0 + r, b.x1 - p.x + r, p.z - b.z0 + r, b.z1 - p.z + r];
      const m = Math.min(...out);
      if (m === out[0]) p.x = b.x0 - r;
      else if (m === out[1]) p.x = b.x1 + r;
      else if (m === out[2]) p.z = b.z0 - r;
      else p.z = b.z1 + r;
    }
  }
  if (pushOffCliff(p)) touched = true;
  clampToWorld(p, r);
  return touched;
}

/** How far a cliff may rise above a body's feet before it stops the body: barely at all. */
const CLIFF_GRIP = 0.05;

/**
 * A cliff is a wall: a body that would stand on a cliff cell above its feet is moved
 * back downhill until it stands clear. A body moves a few centimetres a tick, far less
 * than a step, so only this small allowance keeps it from walking up a cliff by
 * inches. Walking down a cliff is a fall.
 */
function pushOffCliff(p: Vec3): boolean {
  let moved = false;
  for (let k = 0; k < 16; k++) {
    if (terrainHeight(p.x, p.z) <= p.y + CLIFF_GRIP || !steepAt(p.x, p.z)) break;
    const g = terrainGrad(p.x, p.z);
    const l = Math.hypot(g.x, g.z) || 1;
    p.x -= (g.x / l) * 0.12;
    p.z -= (g.z / l) * 0.12;
    moved = true;
  }
  return moved;
}

/** True if a point is inside any box or under the ground. */
export function solidAt(x: number, y: number, z: number): boolean {
  if (y < terrainHeight(x, z) - 0.05) return true;
  for (const b of near(x, z, 0)) if (x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1 && y > b.y0 && y < b.h) return true;
  return false;
}

function rayBox(o: Vec3, d: Vec3, b: Box, maxT: number): number {
  // The slab of each axis in turn (x, y, z), narrowing [t0, t1]; written out per axis so a test allocates nothing.
  let t0 = 0;
  let t1 = maxT;
  let a: number;
  let c: number;
  if (Math.abs(d.x) < 1e-9) {
    if (o.x < b.x0 || o.x > b.x1) return Infinity;
  } else {
    a = (b.x0 - o.x) / d.x;
    c = (b.x1 - o.x) / d.x;
    if (a > c) {
      const swap = a;
      a = c;
      c = swap;
    }
    if (a > t0) t0 = a;
    if (c < t1) t1 = c;
    if (t0 > t1) return Infinity;
  }
  if (Math.abs(d.y) < 1e-9) {
    if (o.y < b.y0 || o.y > b.h) return Infinity;
  } else {
    a = (b.y0 - o.y) / d.y;
    c = (b.h - o.y) / d.y;
    if (a > c) {
      const swap = a;
      a = c;
      c = swap;
    }
    if (a > t0) t0 = a;
    if (c < t1) t1 = c;
    if (t0 > t1) return Infinity;
  }
  if (Math.abs(d.z) < 1e-9) {
    if (o.z < b.z0 || o.z > b.z1) return Infinity;
  } else {
    a = (b.z0 - o.z) / d.z;
    c = (b.z1 - o.z) / d.z;
    if (a > c) {
      const swap = a;
      a = c;
      c = swap;
    }
    if (a > t0) t0 = a;
    if (c < t1) t1 = c;
    if (t0 > t1) return Infinity;
  }
  return t0;
}

/**
 * Distance along a unit ray to the first box or the ground, capped at maxT. `paths` leaves the
 * closed routes' obstacles out, as the walkers' grids do (`routeBoxesOpen`). Fences are seen and
 * shot through, so they are left out too; `fences` asks for the fences alone, and no ground.
 */
export function rayWorld(o: Vec3, d: Vec3, maxT: number, paths = false, fences = false): number {
  let t = maxT;
  // Walk the grid cells under the ray in order. A box in a cell entered beyond the
  // nearest hit so far cannot be nearer, so the walk stops there.
  rayId++;
  let cx = Math.floor(o.x / CELL);
  let cz = Math.floor(o.z / CELL);
  const ax = Math.abs(d.x);
  const az = Math.abs(d.z);
  const stepX = d.x > 0 ? 1 : -1;
  const stepZ = d.z > 0 ? 1 : -1;
  const dtX = ax > 1e-9 ? CELL / ax : Infinity;
  const dtZ = az > 1e-9 ? CELL / az : Infinity;
  let nextX = ax > 1e-9 ? (d.x > 0 ? (cx + 1) * CELL - o.x : o.x - cx * CELL) / ax : Infinity;
  let nextZ = az > 1e-9 ? (d.z > 0 ? (cz + 1) * CELL - o.z : o.z - cz * CELL) / az : Infinity;
  for (;;) {
    const c = cellAt(cx, cz);
    const list = c >= 0 ? cellBoxes[c] : undefined;
    if (list) {
      const ids = cellIds[c]!;
      for (let n = 0; n < list.length; n++) {
        const b = list[n];
        const i = ids[n];
        if (seenBy[i] === rayId) continue;
        seenBy[i] = rayId;
        if (paths && obstacle[i]) continue;
        // A fence of bars or mesh stops a body, not a look or a shot.
        if ((b.kind === "fence") !== fences) continue;
        const bt = rayBox(o, d, b, t);
        if (bt < t) t = bt;
      }
    }
    if (Math.min(nextX, nextZ) > t) return fences ? t : rayTerrain(o, d, t);
    if (nextX < nextZ) {
      cx += stepX;
      nextX += dtX;
    } else {
      cz += stepZ;
      nextZ += dtZ;
    }
  }
}

/**
 * Distance along a unit ray to the ground, capped at maxT. Marches in steps no
 * longer than the gap above the ground allows, then bisects the crossing.
 */
function rayTerrain(o: Vec3, d: Vec3, maxT: number): number {
  let prev = 0;
  let t = 0;
  for (let n = 0; n < 400 && t < maxT; n++) {
    const gap = o.y + d.y * t - terrainHeight(o.x + d.x * t, o.z + d.z * t);
    if (gap < 0) {
      let lo = prev;
      let hi = t;
      for (let k = 0; k < 6; k++) {
        const m = (lo + hi) / 2;
        if (o.y + d.y * m < terrainHeight(o.x + d.x * m, o.z + d.z * m)) hi = m;
        else lo = m;
      }
      return Math.min(maxT, hi);
    }
    prev = t;
    t = Math.min(maxT, t + Math.max(0.4, Math.min(4, gap * 0.8)));
    if (t === prev) break;
  }
  const end = o.y + d.y * maxT - terrainHeight(o.x + d.x * maxT, o.z + d.z * maxT);
  return end < 0 ? Math.max(prev, maxT - 0.4) : maxT;
}

/** Clear sight from a to b. `paths`: as path finding sees the world, without the closed routes' obstacles (see `rayWorld`). */
export function los(a: Vec3, b: Vec3, paths = false): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-6) return true;
  return rayWorld(a, { x: dx / len, y: dy / len, z: dz / len }, len, paths) >= len - 0.05;
}

/** Whether a fence stands between a and b (at a's knee height): a robot that sees through one cannot walk through it. */
export function fenceBetween(a: Vec3, b: Vec3): boolean {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) return false;
  return rayWorld({ x: a.x, y: a.y + 0.5, z: a.z }, { x: dx / len, y: 0, z: dz / len }, len, false, true) < len - 0.05;
}

/** Distance along a unit ray to a sphere, or Infinity. */
export function raySphere(o: Vec3, d: Vec3, c: Vec3, r: number): number {
  const ox = o.x - c.x;
  const oy = o.y - c.y;
  const oz = o.z - c.z;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - cc;
  if (disc < 0) return Infinity;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : cc < 0 ? 0 : Infinity;
}

/**
 * The ground a walker goes by at (x, z): the railway bridge's deck where it crosses the
 * gorge (DECKS), the terrain everywhere else. Robots and the bot treat the deck as ground,
 * as their path finding does, so they cross the bridge like a road.
 */
export const groundLevel = (x: number, z: number) => deckAt(x, z) ?? terrainHeight(x, z);

/** True for a body standing on the ground (as `groundLevel()`) rather than up on a roof, a floor or a box. */
export const onTerrain = (p: Vec3) => p.y < groundLevel(p.x, p.z) + 0.6;

/** True when (x, z) lies at least `margin` metres inside the world's bounds. */
export const inWorld = (x: number, z: number, margin = 0) => x >= WORLD.x0 + margin && x <= WORLD.x1 - margin && z >= WORLD.z0 + margin && z <= WORLD.z1 - margin;

/** Moves a point back inside the world's bounds, `margin` metres from their edge. */
export function clampToWorld(p: { x: number; z: number }, margin: number) {
  p.x = Math.max(WORLD.x0 + margin, Math.min(WORLD.x1 - margin, p.x));
  p.z = Math.max(WORLD.z0 + margin, Math.min(WORLD.z1 - margin, p.z));
}

export const dist2d = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);

export const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
};

export const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Yaw and pitch that look from `from` to `to`, in the player's convention (yaw 0 = -z). */
export function lookAngles(from: Vec3, to: Vec3): { yaw: number; pitch: number } {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  return { yaw: Math.atan2(dx, -dz), pitch: Math.atan2(to.y - from.y, Math.hypot(dx, dz)) };
}
