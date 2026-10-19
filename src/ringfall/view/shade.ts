import { WORLD } from "../sim/config";
import { ceilingAt, groundAt } from "../sim/geom";
import { BOXES, type Box } from "../sim/map";

/*
 * Shade baked into the vertex colours when a chunk is built: what a sky light cannot reach. The
 * hemisphere light lights a room under a roof as brightly as the open ground, and nothing darkens
 * where a wall meets the floor, so without this a building reads as a hollow model and not as a
 * place. It reads the sim's boxes and lookups only; it changes nothing in them.
 */

export const SHADE = {
  /** Light left on a face with a roof, slab or deck close above it (`coverNear` metres or less). */
  cover: 0.62,
  coverNear: 8,
  /** A higher cover shades less, to `coverFarShade` at `coverFar` metres; past that, none. */
  coverFar: 45,
  coverFarShade: 0.82,
  /** Light left on the ground against the foot of a box, rising to full `contactReach` metres away. */
  contact: 0.7,
  contactReach: 1.2,
  /** Light left at the foot of a wall, rising to full `wallBaseUp` metres up it (drawn per pixel by the chunks' material). */
  wallBase: 0.68,
  wallBaseUp: 1,
} as const;

/** Light left at (x, y, z) by the lowest box over it: 1 in the open. */
export function coverAt(x: number, y: number, z: number): number {
  // ceilingAt counts the undersides above `feet + stepUp` and below `head + 0.5`.
  const c = ceilingAt(x, z, 0, y + SHADE.coverFar - 0.5, y - WORLD.stepUp - 0.05);
  if (!(c < Infinity)) return 1;
  const d = c - y;
  if (d <= SHADE.coverNear) return SHADE.cover;
  return SHADE.cover + ((SHADE.coverFarShade - SHADE.cover) * (d - SHADE.coverNear)) / (SHADE.coverFar - SHADE.coverNear);
}

/** The floor a face whose bottom edge is at `bottom` stands on at (x, z): a box top or the ground, at most a hair above it. */
export function floorUnder(x: number, z: number, bottom: number): number {
  return groundAt(x, z, 0, bottom + 0.1 - WORLD.stepUp);
}

const CELL = 8;
const grid = new Map<number, Box[]>();
const key = (cx: number, cz: number) => (cx + 1000) * 4096 + (cz + 1000);
for (const b of BOXES)
  for (let cx = Math.floor(b.x0 / CELL); cx <= Math.floor(b.x1 / CELL); cx++)
    for (let cz = Math.floor(b.z0 / CELL); cz <= Math.floor(b.z1 / CELL); cz++) {
      const list = grid.get(key(cx, cz));
      if (list) list.push(b);
      else grid.set(key(cx, cz), [b]);
    }

/**
 * Light left on the ground at (x, y, z) by the boxes standing on it nearby: the map's and
 * `extra` (the routes' boxes in place). Under a box's footprint it is the darkest.
 */
export function contactAt(x: number, y: number, z: number, extra: readonly Box[]): number {
  const reach: number = SHADE.contactReach;
  let d = reach;
  const visit = (b: Box) => {
    if (b.y0 > y + 0.5 || b.h < y + 0.3) return;
    const dx = Math.max(b.x0 - x, 0, x - b.x1);
    const dz = Math.max(b.z0 - z, 0, z - b.z1);
    if (dx < d && dz < d) d = Math.min(d, Math.hypot(dx, dz));
  };
  for (let cx = Math.floor((x - reach) / CELL); cx <= Math.floor((x + reach) / CELL); cx++)
    for (let cz = Math.floor((z - reach) / CELL); cz <= Math.floor((z + reach) / CELL); cz++) grid.get(key(cx, cz))?.forEach(visit);
  extra.forEach(visit);
  if (d >= reach) return 1;
  const t = d / reach;
  return SHADE.contact + (1 - SHADE.contact) * t * t * (3 - 2 * t);
}
