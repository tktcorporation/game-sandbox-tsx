import { COVER, WORLD } from "./config";
import { groundAt, inWorld, solidAt } from "./geom";
import { BOXES } from "./map";
import type { Point } from "./state";

/**
 * Spots next to anything tall enough to hide a squatting robot (`COVER.tall`: walls, containers,
 * rocks, stacked pallets, a truck), computed once from the map, on whatever the box stands on: the
 * ground at any level, a mesa, a deck, a roof. `y` is that surface, so a robot takes
 * only cover on its own level. `tx, tz` run along the face, so a robot steps that
 * way to peek out.
 */
export interface CoverPoint extends Point {
  y: number;
  tx: number;
  tz: number;
}

export const COVERS: CoverPoint[] = [];

for (const b of BOXES) {
  // The surface under the box (ground or a box below it), found as a walker standing on it would.
  const cx0 = (b.x0 + b.x1) / 2;
  const cz0 = (b.z0 + b.z1) / 2;
  const base = groundAt(cx0, cz0, 0.3, b.y0 + 0.3 - WORLD.stepUp);
  if (!Number.isFinite(base) || b.y0 - base > 0.3 || b.h - base < COVER.tall) continue;
  const w = b.x1 - b.x0;
  const d = b.z1 - b.z0;
  const cx = (b.x0 + b.x1) / 2;
  const cz = (b.z0 + b.z1) / 2;
  // Each face: centre, outward normal, tangent, length.
  const faces: [number, number, number, number, number, number, number][] = [
    [cx, b.z0, 0, -1, 1, 0, w],
    [cx, b.z1, 0, 1, 1, 0, w],
    [b.x0, cz, -1, 0, 0, 1, d],
    [b.x1, cz, 1, 0, 0, 1, d],
  ];
  for (const [fx, fz, nx, nz, tx, tz, len] of faces) {
    const n = Math.max(1, Math.floor(len / COVER.spacing));
    for (let i = 0; i < n; i++) {
      const t = -len / 2 + ((i + 0.5) * len) / n;
      const x = fx + tx * t + nx * COVER.offset;
      const z = fz + tz * t + nz * COVER.offset;
      if (!inWorld(x, z, 1)) continue;
      if (solidAt(x, base + 0.5, z) || solidAt(x, base + 1.5, z)) continue;
      if (Math.abs(groundAt(x, z, 0.3, base + 0.3) - base) > 0.3) continue;
      COVERS.push({ x, y: base, z, tx, tz });
    }
  }
}

/*
 * The spots by 16 m square, so a robot looking for cover reads only the squares round it
 * rather than every spot on the map. `coversNear()` gives the spots in the squares a disk
 * overlaps, in the order of `COVERS`, so a search that filters and sorts them finds what a
 * pass over all of them would.
 */
const SQUARE = 16;
const squares = new Map<number, number[]>();
const squareKey = (i: number, j: number) => (i + 4096) * 8192 + (j + 4096);
COVERS.forEach((c, n) => {
  const k = squareKey(Math.floor(c.x / SQUARE), Math.floor(c.z / SQUARE));
  const list = squares.get(k);
  if (list) list.push(n);
  else squares.set(k, [n]);
});

/** Every spot within `r` of (x, z), and perhaps some further out, in the order of `COVERS`. */
export function coversNear(x: number, z: number, r: number): CoverPoint[] {
  const found: number[] = [];
  for (let i = Math.floor((x - r) / SQUARE); i <= Math.floor((x + r) / SQUARE); i++)
    for (let j = Math.floor((z - r) / SQUARE); j <= Math.floor((z + r) / SQUARE); j++) {
      const list = squares.get(squareKey(i, j));
      if (list) for (const n of list) found.push(n);
    }
  return found.sort((a, b) => a - b).map((n) => COVERS[n]);
}
