import { WORLD } from "./config";

/*
 * The ground. A height field under the boxes: rolling hills, mesas with cliffs and
 * one ramp up, a canyon with a walkable floor, and cliffs round the island's edge.
 * Ground steeper than STEEP is a cliff: bodies cannot walk up it, so cliffs, the
 * canyon walls and the rim shape the routes between the POIs.
 *
 * Everything built by hand stands on flat ground: the field is pressed to 0 near
 * every authored box and point (see buildTerrain), so buildings, posts and paths
 * keep the heights they were written with.
 */

/** Rise per metre above which ground is a cliff (45°). */
export const STEEP = 1.0;
/** Grid spacing of the cached field, in metres. */
const RES = 1;

type P = readonly [number, number];

/** Distance from (x, z) to the polyline, and the fraction along it of the nearest point. */
function toPolyline(x: number, z: number, pts: readonly P[]): { d: number; along: number } {
  let best = Infinity;
  let along = 0;
  let total = 0;
  const lens = pts.slice(1).map((b, i) => Math.hypot(b[0] - pts[i][0], b[1] - pts[i][1]));
  const sum = lens.reduce((a, b) => a + b, 0);
  for (let i = 0; i < lens.length; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[i + 1];
    const dx = bx - ax;
    const dz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
    const d = Math.hypot(x - ax - dx * t, z - az - dz * t);
    if (d < best) {
      best = d;
      along = (total + lens[i] * t) / sum;
    }
    total += lens[i];
  }
  return { d: best, along };
}

/** Value at fraction `t` of a list of values spaced evenly along a line. */
const along = (vals: readonly number[], t: number) => {
  const f = t * (vals.length - 1);
  const i = Math.min(vals.length - 2, Math.floor(f));
  return vals[i] + (vals[i + 1] - vals[i]) * (f - i);
};

/** A raised shape: flat on top within `top` metres of its line, falling `slope` per metre beyond. */
interface Rise {
  line: readonly P[];
  top: number;
  height: number;
  slope: number;
}

/** A walkway of ground from height `from` at its first point to `to` at its last, with cliff sides. */
interface Ramp {
  a: P;
  b: P;
  width: number;
  from: number;
  to: number;
}

/** A trench with a flat floor `floor` metres either side of its line; `depth` varies along it. */
interface Cut {
  line: readonly P[];
  floor: number;
  depth: readonly number[];
  slope: number;
}

const CLIFF = 2.6;

/** Hills: smooth bumps, walkable all over. */
const HILLS: { x: number; z: number; r: number; h: number }[] = [
  { x: 125, z: 95, r: 38, h: 7 },
  { x: 92, z: 150, r: 26, h: 5 },
  { x: -62, z: 150, r: 30, h: 6 },
  { x: -158, z: -18, r: 30, h: 8 },
  { x: 155, z: 45, r: 26, h: 6 },
  { x: -165, z: 65, r: 22, h: 5 },
  { x: 20, z: 170, r: 30, h: 4 },
  { x: -120, z: -160, r: 30, h: 7 },
];

/**
 * Mesas and ridges with cliff sides. Each mesa has a ramp (RAMPS) so its top is a
 * vantage point reached one way; the spine in the north cannot be crossed except
 * over its saddle ramp, which splits the run to the landing pad into a west and an
 * east approach.
 */
const RISES: Rise[] = [
  // 西の高台: high ground south-west of the quarry.
  { line: [[-128, 102], [-140, 118]], top: 16, height: 9, slope: CLIFF },
  // 北の尾根: the spine between the plateau district and the canyon.
  { line: [[-8, -40], [-14, -62], [-12, -86]], top: 2.5, height: 11, slope: CLIFF },
  // 東の岩山: a lookout over the relay tower from the north-east.
  { line: [[148, -64], [156, -74]], top: 10, height: 8, slope: CLIFF },
  // 北西の岩山: a lookout over the ruined village and the landing pad.
  { line: [[-150, -104], [-138, -118]], top: 12, height: 10, slope: CLIFF },
  // 南東の岩棚: a low shelf near the drop zone.
  { line: [[96, 120], [112, 128]], top: 8, height: 5, slope: CLIFF },
];

const RAMPS: Ramp[] = [
  { a: [-100, 92], b: [-118, 100], width: 3.5, from: 0, to: 9 },
  { a: [14, -64], b: [-10, -62], width: 3.5, from: 0, to: 11 },
  { a: [-38, -66], b: [-16, -64], width: 3.5, from: 0, to: 11 },
  { a: [128, -54], b: [142, -62], width: 3.5, from: 0, to: 8 },
  { a: [-120, -92], b: [-136, -104], width: 3.5, from: 0, to: 10 },
  { a: [80, 112], b: [92, 118], width: 3, from: 0, to: 5 },
];

/**
 * 涸れ谷: a dry riverbed from the north edge south past the canyon bridge, fading
 * out in the middle of the island. Its far end is a gentle slope, so its floor is a
 * hidden way north, entered from the middle and left by the same way.
 */
const CUTS: Cut[] = [
  {
    line: [[70, -215], [66, -150], [56, -115], [52, -95], [48, -75], [36, -55], [20, -42]],
    floor: 5,
    depth: [8, 8, 7, 6.5, 6, 5, 0],
    slope: CLIFF,
  },
];

/** Island radius by bearing: an uneven coast, cliffs beyond it. */
export function rimRadius(x: number, z: number): number {
  const a = Math.atan2(z, x);
  return 192 + 8 * Math.sin(3 * a + 1.1) + 5 * Math.sin(7 * a + 2.3) + 3 * Math.sin(13 * a + 0.4);
}

const hash = (x: number, z: number) => {
  const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return s - Math.floor(s);
};
function vnoise(x: number, z: number): number {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const xf = x - xi;
  const zf = z - zi;
  const u = xf * xf * (3 - 2 * xf);
  const v = zf * zf * (3 - 2 * zf);
  const a = hash(xi, zi);
  const b = hash(xi + 1, zi);
  const c = hash(xi, zi + 1);
  const d = hash(xi + 1, zi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** The shaped ground before anything is flattened for buildings. */
function natural(x: number, z: number): number {
  let h = (vnoise(x / 38, z / 38) - 0.5) * 2.4;
  for (const k of HILLS) h += k.h * Math.exp((-2 * ((x - k.x) ** 2 + (z - k.z) ** 2)) / (k.r * k.r));
  for (const r of RISES) {
    const { d } = toPolyline(x, z, r.line);
    h = Math.max(h, r.height - Math.max(0, d - r.top) * r.slope);
  }
  for (const r of RAMPS) {
    const { d, along: t } = toPolyline(x, z, [r.a, r.b]);
    const top = r.from + (r.to - r.from) * t;
    h = Math.max(h, top - Math.max(0, d - r.width) * CLIFF);
  }
  for (const c of CUTS) {
    const { d, along: t } = toPolyline(x, z, c.line);
    const depth = along(c.depth, t);
    h = Math.min(h, -depth + Math.max(0, d - c.floor) * c.slope);
  }
  return h;
}

/** The rim: cliffs rising beyond the coast, out to the horizon. */
function rim(x: number, z: number): number {
  const out = Math.hypot(x, z) - rimRadius(x, z);
  if (out <= 0) return 0;
  return Math.min(48, out * 2.2) * (0.8 + vnoise(x * 0.05, z * 0.05) * 0.4) + vnoise(x * 0.2, z * 0.2) * Math.min(out, 6);
}

const N = Math.round((WORLD.half * 2) / RES) + 1;
let field: Float32Array | null = null;
let steep: Uint8Array | null = null;

const smooth = (a: number, b: number, v: number) => {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export interface FlatShape {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

/**
 * Builds the cached field. `flat` is everything placed by hand: within 3 m of any
 * of it the ground is exactly 0, and the shapes blend back in over the next 7 m.
 * Shapes standing below 0 (the canyon bridge's pillars) are not given.
 */
export function buildTerrain(flat: FlatShape[]) {
  // Distance from each grid point to the nearest flat shape, by a two-pass chamfer.
  const dist = new Float32Array(N * N).fill(1e9);
  for (const b of flat) {
    const i0 = Math.max(0, Math.floor((b.x0 + WORLD.half) / RES));
    const i1 = Math.min(N - 1, Math.ceil((b.x1 + WORLD.half) / RES));
    const j0 = Math.max(0, Math.floor((b.z0 + WORLD.half) / RES));
    const j1 = Math.min(N - 1, Math.ceil((b.z1 + WORLD.half) / RES));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) dist[j * N + i] = 0;
  }
  const D = RES;
  const DD = RES * Math.SQRT2;
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      let v = dist[j * N + i];
      if (i > 0) v = Math.min(v, dist[j * N + i - 1] + D);
      if (j > 0) v = Math.min(v, dist[(j - 1) * N + i] + D);
      if (i > 0 && j > 0) v = Math.min(v, dist[(j - 1) * N + i - 1] + DD);
      if (i < N - 1 && j > 0) v = Math.min(v, dist[(j - 1) * N + i + 1] + DD);
      dist[j * N + i] = v;
    }
  for (let j = N - 1; j >= 0; j--)
    for (let i = N - 1; i >= 0; i--) {
      let v = dist[j * N + i];
      if (i < N - 1) v = Math.min(v, dist[j * N + i + 1] + D);
      if (j < N - 1) v = Math.min(v, dist[(j + 1) * N + i] + D);
      if (i < N - 1 && j < N - 1) v = Math.min(v, dist[(j + 1) * N + i + 1] + DD);
      if (i > 0 && j < N - 1) v = Math.min(v, dist[(j + 1) * N + i - 1] + DD);
      dist[j * N + i] = v;
    }
  field = new Float32Array(N * N);
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const x = i * RES - WORLD.half;
      const z = j * RES - WORLD.half;
      field[j * N + i] = natural(x, z) * smooth(3, 10, dist[j * N + i]) + rim(x, z);
    }
  steep = new Uint8Array(N * N);
  for (let j = 1; j < N - 1; j++)
    for (let i = 1; i < N - 1; i++) {
      const gx = (field[j * N + i + 1] - field[j * N + i - 1]) / (2 * RES);
      const gz = (field[(j + 1) * N + i] - field[(j - 1) * N + i]) / (2 * RES);
      // A cell is a cliff when the ground rises steeply across it or onto a neighbour.
      const up = Math.max(Math.abs(gx), Math.abs(gz), Math.hypot(gx, gz));
      if (up > STEEP) steep[j * N + i] = 1;
    }
}

/** Ground height at (x, z). Outside the cached square it is the rim's horizon. */
export function terrainHeight(x: number, z: number): number {
  const fx = (x + WORLD.half) / RES;
  const fz = (z + WORLD.half) / RES;
  if (!field || fx < 0 || fz < 0 || fx >= N - 1 || fz >= N - 1) return rim(x, z) + (field ? 0 : natural(x, z));
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  const u = fx - i;
  const v = fz - j;
  const a = field[j * N + i];
  const b = field[j * N + i + 1];
  const c = field[(j + 1) * N + i];
  const d = field[(j + 1) * N + i + 1];
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** True where the ground is a cliff. Outside the cached square everything is. */
export function steepAt(x: number, z: number): boolean {
  const i = Math.round((x + WORLD.half) / RES);
  const j = Math.round((z + WORLD.half) / RES);
  if (!steep || i < 0 || j < 0 || i >= N || j >= N) return true;
  return steep[j * N + i] === 1;
}

/** Uphill direction scaled by the rise per metre. */
export function terrainGrad(x: number, z: number): { x: number; z: number } {
  const e = 0.5;
  return { x: (terrainHeight(x + e, z) - terrainHeight(x - e, z)) / (2 * e), z: (terrainHeight(x, z + e) - terrainHeight(x, z - e)) / (2 * e) };
}
