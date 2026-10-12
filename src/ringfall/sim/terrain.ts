import { WORLD } from "./config";

/*
 * The ground. Most of the island is high ground with cliff sides that cannot be
 * climbed; the places people fight in are basins cut into it, joined by valley
 * roads. So each POI is entered from a few directions only: its main road and one
 * or two side roads, and the way between two POIs is a choice between roads, not
 * a straight walk. A dry canyon cuts the north-east, crossed by the canyon bridge.
 * Ground steeper than STEEP is a cliff: bodies cannot walk up it, only fall down.
 *
 * Everything built by hand stands on flat ground: the field is pressed to 0 near
 * every authored box and point (see buildTerrain), so buildings, posts and paths
 * keep the heights they were written with. Basins are laid out to hold them.
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
  const sum = lens.reduce((a, b) => a + b, 0) || 1;
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

/** Low ground: everything within `half` metres of the line is at ground level. */
interface Open {
  name: string;
  line: readonly P[];
  half: number;
}

/** A trench with a flat floor `floor` metres either side of its line; `depth` varies along it. */
interface Cut {
  line: readonly P[];
  floor: number;
  depth: readonly number[];
  slope: number;
}

/** Height of the high ground, and how steeply its cliffs fall to the low ground. */
const HIGH = 9;
const CLIFF = 2.4;

/** Basins: the POIs and the districts. Each holds everything built there. */
const BASINS: Open[] = [
  { name: "補給所", line: [[0, 86], [0, 130]], half: 32 },
  { name: "採掘場", line: [[-116, 8], [-86, 24]], half: 30 },
  { name: "中継塔", line: [[78, -36], [102, -28]], half: 27 },
  { name: "発着場", line: [[-8, -118], [10, -118]], half: 34 },
  { name: "旧市街", line: [[0, -12], [0, 30]], half: 25 },
  { name: "尾根", line: [[-64, 70], [-36, 70]], half: 13 },
  { name: "台地", line: [[-54, -50], [-36, -50]], half: 18 },
  { name: "工場", line: [[54, 42], [60, 58]], half: 18 },
  { name: "住宅地", line: [[104, 26], [122, 2]], half: 15 },
  { name: "廃村", line: [[-114, -68], [-96, -60]], half: 17 },
];

/**
 * Valley roads between basins, 12 to 16 m wide. Every POI has a main road toward
 * the next one and at least one side road, so the player picks the approach.
 */
const ROADS: Open[] = [
  // 補給所 -> 採掘場: the ridge road (main) and the old-town road (side).
  { name: "尾根道", line: [[-26, 100], [-46, 80], [-66, 52], [-80, 36]], half: 7 },
  { name: "南北道", line: [[0, 58], [0, 36]], half: 7 },
  { name: "旧市街の西道", line: [[-22, 16], [-48, 16], [-68, 20]], half: 6 },
  // 採掘場 -> 中継塔: through the old town (main), or round by the factory (side).
  { name: "旧市街の東道", line: [[22, 8], [44, -6], [58, -22]], half: 6 },
  { name: "工場道", line: [[26, 106], [44, 76], [52, 58]], half: 6 },
  { name: "住宅道", line: [[72, 50], [92, 38], [104, 28]], half: 6 },
  { name: "中継塔の南道", line: [[114, 8], [104, -8]], half: 6 },
  // 採掘場 -> north: the plateau road and the village road.
  { name: "台地道", line: [[-96, -16], [-74, -36], [-56, -48]], half: 6 },
  { name: "台地の北道", line: [[-38, -64], [-28, -86], [-20, -96]], half: 6 },
  { name: "廃村道", line: [[-112, -18], [-110, -50]], half: 6 },
  { name: "廃村の北道", line: [[-96, -74], [-62, -98], [-38, -112]], half: 6 },
  // 旧市街 -> 発着場: the straight road north.
  { name: "北道", line: [[0, -34], [2, -60], [6, -86]], half: 7 },
  // 中継塔 -> 発着場: over the canyon bridge (west bank to the landing pad, east bank to the relay tower).
  { name: "橋の西道", line: [[4, -64], [26, -84], [42, -94]], half: 6 },
  { name: "橋の東道", line: [[62, -96], [76, -78], [86, -58]], half: 6 },
];

/**
 * Rock shelves along a basin's wall, inside it: a band `width` metres deep and
 * `height` high, `span` radians either side of the bearing `at` from the basin's
 * middle. One end is a ramp up from the floor; the inner edge is a cliff. They
 * give each POI a high way round its side, reached from one end only.
 */
interface Shelf {
  basin: string;
  at: number;
  span: number;
  width: number;
  height: number;
  ramp: number;
  /** Which end the ramp is at: -1 the lower bearing, 1 the higher. */
  rampEnd: -1 | 1;
}

const SHELVES: Shelf[] = [
  { basin: "補給所", at: Math.PI, span: 0.5, width: 8, height: 3.4, ramp: 14, rampEnd: 1 },
  { basin: "採掘場", at: -2.4, span: 0.45, width: 8, height: 3.4, ramp: 14, rampEnd: -1 },
  { basin: "中継塔", at: -0.9, span: 0.5, width: 8, height: 3.4, ramp: 14, rampEnd: 1 },
  { basin: "発着場", at: Math.PI, span: 0.45, width: 8, height: 3.4, ramp: 14, rampEnd: -1 },
];

/**
 * 涸れ谷: a dry riverbed from the old town's north-east to the landing pad's east
 * side, 6 m deep under the canyon bridge. Its ends slope gently to ground level, so
 * its floor is a hidden road between the two; the bridge crosses it east to west.
 */
const CUTS: Cut[] = [
  {
    line: [[20, -40], [36, -55], [48, -75], [52, -95], [56, -115], [48, -132], [36, -128]],
    floor: 5,
    depth: [0, 3, 5, 6, 6, 3, 0],
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

function shelfAt(sh: Shelf, x: number, z: number): number {
  const basin = BASINS.find((o) => o.name === sh.basin)!;
  const [a0, b0] = [basin.line[0], basin.line[basin.line.length - 1]];
  const cx = (a0[0] + b0[0]) / 2;
  const cz = (a0[1] + b0[1]) / 2;
  const off = Math.atan2(Math.sin(Math.atan2(z - cz, x - cx) - sh.at), Math.cos(Math.atan2(z - cz, x - cx) - sh.at));
  if (Math.abs(off) > sh.span) return -Infinity;
  const d = toPolyline(x, z, basin.line).d;
  const inner = basin.half - sh.width;
  if (d > basin.half + 1) return -Infinity;
  // Rise from the floor along the ramp end, then flat to the far end.
  const fromRampEnd = (sh.span - off * sh.rampEnd) * (basin.half - sh.width / 2);
  const top = sh.height * Math.min(1, fromRampEnd / sh.ramp);
  return top - Math.max(0, inner - d) * CLIFF;
}

/** The shaped ground before anything is flattened for buildings. */
function natural(x: number, z: number): number {
  // Distance outside the nearest low ground (0 inside it).
  let out = Infinity;
  for (const o of [...BASINS, ...ROADS]) out = Math.min(out, Math.max(0, toPolyline(x, z, o.line).d - o.half));
  const top = HIGH + vnoise(x / 30, z / 30) * 3.5;
  let h = Math.min(top, out * CLIFF) + (vnoise(x / 9, z / 9) - 0.5) * 0.5;
  for (const c of CUTS) {
    const { d, along: t } = toPolyline(x, z, c.line);
    h = Math.min(h, -along(c.depth, t) + Math.max(0, d - c.floor) * c.slope);
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
      // Shelves stand right up to hand-built things (a 1 m gap); other shapes leave them room to blend.
      const dd = dist[j * N + i];
      let shelf = -Infinity;
      for (const sh of SHELVES) shelf = Math.max(shelf, shelfAt(sh, x, z));
      const base = natural(x, z) * smooth(3, 10, dd);
      field[j * N + i] = (shelf > base ? base + (shelf - base) * smooth(1, 2, dd) : base) + rim(x, z);
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
