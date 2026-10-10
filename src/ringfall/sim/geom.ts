import { WORLD } from "./config";
import { BOXES, type Box } from "./map";
import type { Vec3 } from "./state";

/** Height of the surface under a circle at (x, z) that a body with feet at `feet` can stand on. */
export function groundAt(x: number, z: number, r: number, feet: number): number {
  let g = 0;
  for (const b of BOXES) {
    if (b.h > feet + WORLD.stepUp) continue;
    if (x + r * 0.7 < b.x0 || x - r * 0.7 > b.x1 || z + r * 0.7 < b.z0 || z - r * 0.7 > b.z1) continue;
    if (b.h > g) g = b.h;
  }
  return g;
}

/** Push a circle out of every box taller than it can step onto. Returns true if it touched one. */
export function collide(p: Vec3, r: number): boolean {
  let touched = false;
  for (const b of BOXES) {
    if (b.h <= p.y + WORLD.stepUp) continue;
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

function rayBox(o: Vec3, d: Vec3, b: Box, maxT: number): number {
  let t0 = 0;
  let t1 = maxT;
  const axes: [number, number, number, number][] = [
    [o.x, d.x, b.x0, b.x1],
    [o.y, d.y, 0, b.h],
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
  for (const b of BOXES) {
    const bt = rayBox(o, d, b, t);
    if (bt < t) t = bt;
  }
  return t;
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
