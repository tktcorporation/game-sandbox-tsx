import { WORLD } from "./config";
import { BOXES, type Box } from "./map";
import type { Vec3 } from "./state";

/*
 * Boxes span y0..h, so floors, roofs and bridges can float above open space.
 * A coarse grid finds the boxes near a point, and rays walk the cells they cross.
 */
const CELL = 8;
const grid = new Map<number, Box[]>();
const key = (cx: number, cz: number) => (cx + 1000) * 4096 + (cz + 1000);
for (const b of BOXES) {
  for (let cx = Math.floor(b.x0 / CELL); cx <= Math.floor(b.x1 / CELL); cx++)
    for (let cz = Math.floor(b.z0 / CELL); cz <= Math.floor(b.z1 / CELL); cz++) {
      const k = key(cx, cz);
      const list = grid.get(k);
      if (list) list.push(b);
      else grid.set(k, [b]);
    }
}
const indexOf = new Map(BOXES.map((b, i) => [b, i]));
const seenBy = new Int32Array(BOXES.length);
let rayId = 0;
const scratch = new Set<Box>();
function near(x: number, z: number, r: number): Iterable<Box> {
  scratch.clear();
  for (let cx = Math.floor((x - r) / CELL); cx <= Math.floor((x + r) / CELL); cx++)
    for (let cz = Math.floor((z - r) / CELL); cz <= Math.floor((z + r) / CELL); cz++) {
      const list = grid.get(key(cx, cz));
      if (list) for (const b of list) scratch.add(b);
    }
  return scratch;
}

/** Height of the highest surface under a circle at (x, z) that a body with feet at `feet` can stand on. */
export function groundAt(x: number, z: number, r: number, feet: number): number {
  let g = 0;
  for (const b of near(x, z, r)) {
    if (b.h > feet + WORLD.stepUp || b.h <= g) continue;
    if (x + r * 0.7 < b.x0 || x - r * 0.7 > b.x1 || z + r * 0.7 < b.z0 || z - r * 0.7 > b.z1) continue;
    g = b.h;
  }
  return g;
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
  const lim = WORLD.half - r;
  p.x = Math.max(-lim, Math.min(lim, p.x));
  p.z = Math.max(-lim, Math.min(lim, p.z));
  return touched;
}

/** True if a point is inside any box. */
export function solidAt(x: number, y: number, z: number): boolean {
  for (const b of near(x, z, 0)) if (x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1 && y > b.y0 && y < b.h) return true;
  return false;
}

function rayBox(o: Vec3, d: Vec3, b: Box, maxT: number): number {
  let t0 = 0;
  let t1 = maxT;
  const axes: [number, number, number, number][] = [
    [o.x, d.x, b.x0, b.x1],
    [o.y, d.y, b.y0, b.h],
    [o.z, d.z, b.z0, b.z1],
  ];
  for (const [oo, dd, lo, hi] of axes) {
    if (Math.abs(dd) < 1e-9) {
      if (oo < lo || oo > hi) return Infinity;
      continue;
    }
    let a = (lo - oo) / dd;
    let c = (hi - oo) / dd;
    if (a > c) [a, c] = [c, a];
    if (a > t0) t0 = a;
    if (c < t1) t1 = c;
    if (t0 > t1) return Infinity;
  }
  return t0;
}

/** Distance along a unit ray to the first box or the ground, capped at maxT. */
export function rayWorld(o: Vec3, d: Vec3, maxT: number): number {
  let t = maxT;
  if (d.y < -1e-6) t = Math.min(t, -o.y / d.y);
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
    const list = grid.get(key(cx, cz));
    if (list)
      for (const b of list) {
        const i = indexOf.get(b) ?? 0;
        if (seenBy[i] === rayId) continue;
        seenBy[i] = rayId;
        const bt = rayBox(o, d, b, t);
        if (bt < t) t = bt;
      }
    if (Math.min(nextX, nextZ) > t) return t;
    if (nextX < nextZ) {
      cx += stepX;
      nextX += dtX;
    } else {
      cz += stepZ;
      nextZ += dtZ;
    }
  }
}

export function los(a: Vec3, b: Vec3): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-6) return true;
  return rayWorld(a, { x: dx / len, y: dy / len, z: dz / len }, len) >= len - 0.05;
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
