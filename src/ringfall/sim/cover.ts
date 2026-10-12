import { COVER, WORLD } from "./config";
import { groundAt, solidAt } from "./geom";
import { BOXES } from "./map";
import type { Point } from "./state";

/**
 * Spots on the ground next to anything tall enough to hide a robot (walls,
 * containers, rocks, stacked crates), computed once from the map. `tx, tz` run
 * along the face, so a robot steps that way to peek out.
 */
export interface CoverPoint extends Point {
  tx: number;
  tz: number;
}

export const COVERS: CoverPoint[] = [];

for (const b of BOXES) {
  if (b.y0 > 0.3 || b.h < 1.3) continue;
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
      if (Math.abs(x) > WORLD.half - 1 || Math.abs(z) > WORLD.half - 1) continue;
      if (solidAt(x, 0.5, z) || solidAt(x, 1.5, z)) continue;
      if (Math.abs(groundAt(x, z, 0.3, 0.3)) > 0.3) continue;
      COVERS.push({ x, z, tx, tz });
    }
  }
}
