import { ZIP } from "./config";
import { terrainHeight } from "./terrain";
import type { Box } from "./map";

/*
 * Where the ziplines run (map.ts lays them; zips.ts rides them). Each link of the front gets a
 * cable from a mast by one end's core to a mast by the other's, straight in plan. Where the
 * ground or something built rises under it, the cable goes over pylons: the tightest line over
 * everything in the way, so it stands no taller than it must. A link whose cable would need a
 * pylon taller than `ZIP.pylonMax` or a slope past `ZIP.slope` gets none.
 */

export interface ZipPoint {
  x: number;
  y: number;
  z: number;
}

/** A cable: its points from end `a` to end `b` (the heads at the masts, the pylons between), and the distance along it at each. */
export interface ZipLine {
  a: string;
  b: string;
  /** A lift: up whoever holds what, from its low end (`a`) to its high end (`b`). */
  fixed?: true;
  pts: ZipPoint[];
  cum: number[];
  length: number;
}

export interface ZipLayout {
  lines: ZipLine[];
  /** The masts, their arms and the pylons. */
  boxes: Box[];
  /** The links that got no cable, and why. */
  missing: { a: string; b: string; why: string }[];
}

const steel = (x0: number, z0: number, x1: number, z1: number, y0: number, h: number, tint: number): Box => ({ x0, z0, x1, z1, y0, h, kind: "steel", tint });

/** A grid of boxes by 16 m cells, for the cable's clearance tests. */
function boxGrid(boxes: readonly Box[]) {
  const C = 16;
  const cells = new Map<number, Box[]>();
  const key = (cx: number, cz: number) => cx * 100_003 + cz;
  for (const b of boxes)
    for (let cx = Math.floor(b.x0 / C); cx <= Math.floor(b.x1 / C); cx++)
      for (let cz = Math.floor(b.z0 / C); cz <= Math.floor(b.z1 / C); cz++) {
        const k = key(cx, cz);
        const list = cells.get(k);
        if (list) list.push(b);
        else cells.set(k, [b]);
      }
  return (x: number, z: number) => cells.get(key(Math.floor(x / C), Math.floor(z / C))) ?? [];
}

/** One cable over the ground from mast `ma` to mast `mb`, or why it cannot be laid; `cost` ranks the ones that can. */
type Laid = { pts: ZipPoint[]; cost: number } | { why: string };

/**
 * The cables for `links`, each between one of the mast spots of its two ends (`spots`, by end id),
 * clear of `boxes` and the ground: of every pair of spots, the cable that needs the least steel
 * (its pylons' heights, and its length), the masts as near their cores as that allows. Each cable's head hangs beside its mast, so a rider
 * coming in passes the mast rather than meeting it.
 */
export function layZips(
  spots: Record<string, readonly { x: number; z: number; r: number }[]>,
  links: readonly (readonly [string, string])[],
  boxes: readonly Box[],
  lifts: readonly { a: string; b: string; from: { x: number; z: number }; to: { x: number; z: number } }[] = [],
): ZipLayout {
  const near = boxGrid(boxes);
  const out: ZipLayout = { lines: [], boxes: [], missing: [] };
  /** The height the cable must keep over (x, z): the hanging body clear of the ground and of anything built. */
  const need = (x: number, z: number) => {
    let h = terrainHeight(x, z) + ZIP.clear;
    for (const b of near(x, z)) if (x > b.x0 - 0.6 && x < b.x1 + 0.6 && z > b.z0 - 0.6 && z < b.z1 + 0.6) h = Math.max(h, b.h + ZIP.clear - 0.3);
    return h;
  };
  const lay = (ma: { x: number; z: number }, mb: { x: number; z: number }): Laid => {
    const dx0 = mb.x - ma.x;
    const dz0 = mb.z - ma.z;
    const d0 = Math.hypot(dx0, dz0);
    const ux = dx0 / d0;
    const uz = dz0 / d0;
    // To the left of the way from a to b: the side both heads hang out to.
    const px = -uz;
    const pz = ux;
    const A = { x: ma.x + px * 1.1, y: terrainHeight(ma.x, ma.z) + ZIP.head, z: ma.z + pz * 1.1 };
    const B = { x: mb.x + px * 1.1, y: terrainHeight(mb.x, mb.z) + ZIP.head, z: mb.z + pz * 1.1 };
    const L = d0;
    // The profile under the cable, every 1.5 m, across the hanging body's width.
    const prof: [number, number][] = [[0, A.y]];
    for (let t = 3; t < L - 3; t += 1.5) {
      const x = A.x + ux * t;
      const z = A.z + uz * t;
      prof.push([t, Math.max(need(x, z), need(x + px * 0.5, z + pz * 0.5), need(x - px * 0.5, z - pz * 0.5))]);
    }
    prof.push([L, B.y]);
    // The tightest line over the profile: its upper hull.
    const hull: [number, number][] = [];
    for (const q of prof) {
      while (hull.length >= 2) {
        const [o, m2] = [hull[hull.length - 2], hull[hull.length - 1]];
        if ((m2[0] - o[0]) * (q[1] - o[1]) - (m2[1] - o[1]) * (q[0] - o[0]) >= 0) hull.pop();
        else break;
      }
      hull.push(q);
    }
    // Pylons closer together than a span are one, raised until the cable clears everything again.
    const above = (h: [number, number][]) =>
      prof.every(([t, y]) => {
        let i = 0;
        while (i < h.length - 2 && h[i + 1][0] < t) i++;
        const [t0, y0] = h[i];
        const [t1, y1] = h[i + 1];
        return y <= y0 + ((y1 - y0) * (t - t0)) / (t1 - t0 || 1) + 1e-6;
      });
    for (let i = 1; i < hull.length - 2; ) {
      if (hull[i + 1][0] - hull[i][0] >= 24) {
        i++;
        continue;
      }
      const t = (hull[i][0] + hull[i + 1][0]) / 2;
      let y = Math.max(hull[i][1], hull[i + 1][1]);
      const trial = () => [...hull.slice(0, i), [t, y] as [number, number], ...hull.slice(i + 2)];
      while (!above(trial()) && y < 200) y += 0.5;
      hull.splice(i, 2, [t, y]);
    }
    // A pylon's legs stand on the ground, through nothing built: one that would is moved along the
    // cable beside what it stood on, and raised until the cable clears everything again.
    const legsClear = (t: number, y: number) =>
      [1, -1].every((s) => {
        const lx = A.x + ux * t + px * 1.4 * s;
        const lz = A.z + uz * t + pz * 1.4 * s;
        const g = terrainHeight(lx, lz);
        return !near(lx, lz).some((b) => lx + 0.5 > b.x0 && lx - 0.5 < b.x1 && lz + 0.5 > b.z0 && lz - 0.5 < b.z1 && b.h > g + 0.1 && b.y0 < y + 2);
      });
    for (let i = 1; i < hull.length - 1; i++) {
      if (legsClear(hull[i][0], hull[i][1])) continue;
      let moved = false;
      for (let k = 1; k <= 14 && !moved; k++)
        for (const t of [hull[i][0] + 2 * k, hull[i][0] - 2 * k]) {
          if (t < hull[i - 1][0] + 4 || t > hull[i + 1][0] - 4) continue;
          let y = hull[i][1];
          const trial = () => [...hull.slice(0, i), [t, y] as [number, number], ...hull.slice(i + 1)];
          while (!above(trial()) && y < hull[i][1] + 30) y += 0.5;
          if (!above(trial()) || !legsClear(t, y)) continue;
          hull[i] = [t, y];
          moved = true;
          break;
        }
      if (!moved) return { why: "a pylon in something built" };
    }
    let cost = L;
    for (const [t, y] of hull.slice(1, -1)) {
      const tall = y - terrainHeight(A.x + ux * t, A.z + uz * t);
      if (tall > ZIP.pylonMax) return { why: `a pylon ${tall.toFixed(0)} m tall` };
      cost += 20 + tall * 3;
    }
    for (let i = 1; i < hull.length; i++) {
      const slope = Math.abs(hull[i][1] - hull[i - 1][1]) / (hull[i][0] - hull[i - 1][0]);
      if (slope > ZIP.slope) return { why: `a slope of ${slope.toFixed(2)}` };
    }
    return { pts: hull.map(([t, y]) => ({ x: A.x + ux * t, y, z: A.z + uz * t })), cost };
  };
  const masts = new Set<string>();
  const jobs = [...links.map(([a, b]) => ({ a, b, as: spots[a] ?? [], bs: spots[b] ?? [], fixed: false })), ...lifts.map((l) => ({ a: l.a, b: l.b, as: [{ ...l.from, r: 0 }], bs: [{ ...l.to, r: 0 }], fixed: true }))];
  for (const { a, b, as, bs, fixed } of jobs) {
    let best: { pts: ZipPoint[]; cost: number; ma: { x: number; z: number }; mb: { x: number; z: number } } | null = null;
    let why = "no mast";
    for (const ma of as)
      for (const mb of bs) {
        const laid = lay(ma, mb);
        if ("why" in laid) why = laid.why;
        // A mast stands by its core when it can: each metre out from it costs as two of cable.
        else if (!best || laid.cost + 2 * (ma.r + mb.r) < best.cost) best = { pts: laid.pts, cost: laid.cost + 2 * (ma.r + mb.r), ma, mb };
      }
    if (!best) {
      out.missing.push({ a, b, why });
      continue;
    }
    const { pts, ma, mb } = best;
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y, pts[i].z - pts[i - 1].z));
    out.lines.push(fixed ? { a, b, fixed: true, pts, cum, length: cum[cum.length - 1] } : { a, b, pts, cum, length: cum[cum.length - 1] });
    // The masts, and the arm from each out over its head.
    const A = pts[0];
    const B = pts[pts.length - 1];
    for (const [m, h] of [[ma, A], [mb, B]] as const) {
      const g = terrainHeight(m.x, m.z);
      const key = `${m.x},${m.z}`;
      if (!masts.has(key)) {
        masts.add(key);
        out.boxes.push(steel(m.x - 0.4, m.z - 0.4, m.x + 0.4, m.z + 0.4, g - 0.3, g + ZIP.head + 1.8, 2));
      }
      out.boxes.push(steel(Math.min(m.x, h.x) - 0.12, Math.min(m.z, h.z) - 0.12, Math.max(m.x, h.x) + 0.12, Math.max(m.z, h.z) + 0.12, h.y + 0.3, h.y + 0.5, 1));
    }
    // Each pylon: two legs either side of the cable and a beam over it, high enough that the cable climbing past it stays under.
    const ux = (B.x - A.x) / Math.hypot(B.x - A.x, B.z - A.z);
    const uz = (B.z - A.z) / Math.hypot(B.x - A.x, B.z - A.z);
    for (const q of pts.slice(1, -1)) {
      const [lx0, lz0, lx1, lz1] = [q.x - uz * 1.4, q.z + ux * 1.4, q.x + uz * 1.4, q.z - ux * 1.4];
      for (const [lx, lz] of [[lx0, lz0], [lx1, lz1]]) out.boxes.push(steel(lx - 0.3, lz - 0.3, lx + 0.3, lz + 0.3, terrainHeight(lx, lz) - 0.5, q.y + 1.8, 0));
      out.boxes.push(steel(Math.min(lx0, lx1) - 0.15, Math.min(lz0, lz1) - 0.15, Math.max(lx0, lx1) + 0.15, Math.max(lz0, lz1) + 0.15, q.y + 1.5, q.y + 1.8, 1));
    }
  }
  return out;
}
