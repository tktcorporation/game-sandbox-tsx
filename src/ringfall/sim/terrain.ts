import { WORLD } from "./config";

/*
 * The ground: a dried-up reservoir. A dam once held a lake in the middle of the
 * island; the water is gone and the drowned old town stands on the cracked lakebed,
 * the lowest ground on the island. Around it the ground steps up: the south shore
 * where the player lands, the west plateau and the old ridge, the dam crest in the
 * north with the landing pad behind it, and the east mesa with the relay tower.
 * A quarry pit is sunk into the west, below even the lakebed.
 *
 * Everything people walk on is an open shape at its own level: a basin (a POI, a
 * district) or a road, whose level runs from one end to the other, so roads are the
 * ramps between levels. Between open shapes the ground rises to high ground that
 * cannot be reached, with cliffs on every side. Where two levels meet edge to edge
 * the higher one ends at a cliff: a body can drop down it but never climb back, so
 * the lakebed is easy to fall into and left only by its ramps. The spillway, a dry
 * canyon from the lakebed's north-east corner up to the landing pad's east side, is
 * the hidden way round the dam.
 *
 * Everything built by hand stands on flat ground: the field is pressed to the level
 * of each authored box and point (see buildTerrain), so buildings, posts and paths
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

/** Value at fraction `t` of a list of values spaced evenly along a line's points. */
const along = (vals: readonly number[], t: number) => {
  const f = t * (vals.length - 1);
  const i = Math.min(vals.length - 2, Math.floor(f));
  return vals[i] + (vals[i + 1] - vals[i]) * (f - i);
};

/**
 * Walkable ground: everything within `half` metres of the line is at `level`. A road
 * gives one level per point of its line and ramps between them; ramps stay under
 * 0.45 rise per metre so they read as slopes, well short of STEEP.
 */
interface Open {
  name: string;
  line: readonly P[];
  half: number;
  level: number | readonly number[];
}

const levelOf = (o: Open, t: number) => (typeof o.level === "number" ? o.level : along(o.level, t));

/** A trench with a flat floor `floor` metres either side of its line, at `levels` along it. */
interface Cut {
  line: readonly P[];
  floor: number;
  levels: readonly number[];
  slope: number;
}

/** Height of the high ground, and how steeply its cliffs fall to the low ground. */
const HIGH = 17;
const CLIFF = 2.4;

/** The levels people walk on, from the lakebed up. */
export const LEVEL = { pit: -10, lakebed: -7, shore: 0, ridge: 5, mesa: 7, dam: 8 } as const;

/** The dam's face: the cliff from the crest walkway down to the lakebed, drawn as concrete. */
export const DAM_FACE = (x: number, z: number) => Math.abs(x) < 28 && z > -76 && z < -63;

/** Basins: the POIs and the districts. Each holds everything built there. */
const BASINS: Open[] = [
  { name: "補給所", line: [[0, 86], [0, 130]], half: 28, level: LEVEL.shore },
  { name: "湖底", line: [[0, -40], [0, 18]], half: 26, level: LEVEL.lakebed },
  { name: "発着場", line: [[-8, -118], [10, -118]], half: 32, level: LEVEL.dam },
  // The dam crest: a walkway along the top of the dam face, the lakebed 15 m below.
  { name: "堤", line: [[-24, -79], [24, -79]], half: 5, level: LEVEL.dam },
  { name: "採掘場", line: [[-116, 8], [-86, 24]], half: 26, level: LEVEL.pit },
  { name: "中継塔", line: [[78, -36], [102, -28]], half: 25, level: LEVEL.mesa },
  { name: "住宅地", line: [[104, 26], [122, 2]], half: 14, level: LEVEL.mesa },
  { name: "尾根", line: [[-66, 70], [-34, 70]], half: 10, level: LEVEL.ridge },
  // Close enough to the lakebed that its east side is a clean drop into it.
  { name: "台地", line: [[-58, -46], [-43, -46]], half: 14, level: LEVEL.shore },
  { name: "工場", line: [[54, 42], [60, 58]], half: 16, level: LEVEL.shore },
  { name: "廃村", line: [[-114, -68], [-96, -60]], half: 15, level: LEVEL.shore },
];

/**
 * Roads between basins, 8 to 10 m wide. Each area has two or three of them; the
 * lakebed has four ramps out and the spillway, and the cliffs everywhere else make
 * the choice of road the choice of approach.
 */
const ROADS: Open[] = [
  { name: "湖への坂", line: [[0, 62], [0, 40]], half: 5, level: [LEVEL.shore, LEVEL.lakebed] },
  // Up onto the ridge at its east end, along its top, and down the haul road into the pit at its west end.
  // The climb starts at the supply basin's edge: a ramp rising inside a basin would leave a step where they meet.
  { name: "尾根道", line: [[-20, 106], [-29, 93], [-40, 77]], half: 5, level: [LEVEL.shore, LEVEL.shore, LEVEL.ridge] },
  { name: "採掘場の運搬路", line: [[-70, 64], [-90, 60], [-104, 46], [-106, 40]], half: 5, level: [LEVEL.ridge, -1, -8, LEVEL.pit] },
  { name: "西道", line: [[-24, 16], [-46, 16], [-62, 20]], half: 5, level: [LEVEL.lakebed, -8, LEVEL.pit] },
  { name: "廃村道", line: [[-112, -16], [-112, -44]], half: 5, level: [LEVEL.pit, LEVEL.shore] },
  { name: "湖の西坂", line: [[-22, -30], [-44, -38]], half: 5, level: [LEVEL.lakebed, LEVEL.shore] },
  { name: "堤の西坂", line: [[-56, -58], [-52, -82], [-30, -80]], half: 5, level: [LEVEL.shore, 6, LEVEL.dam] },
  { name: "廃村の北道", line: [[-96, -74], [-66, -96], [-40, -110]], half: 5, level: [LEVEL.shore, 4, LEVEL.dam] },
  { name: "工場道", line: [[24, 104], [44, 76], [52, 60]], half: 5, level: LEVEL.shore },
  { name: "住宅道", line: [[70, 52], [92, 38], [106, 28]], half: 5, level: [LEVEL.shore, 4, LEVEL.mesa] },
  { name: "東の坂", line: [[22, 0], [44, -8], [58, -24], [62, -34]], half: 5, level: [LEVEL.lakebed, -1, 5, LEVEL.mesa] },
  // To the canyon bridge: the deck is at the mesa's level, a step down from the pad.
  { name: "橋の西道", line: [[26, -100], [40, -95]], half: 4, level: [LEVEL.dam, LEVEL.mesa] },
  { name: "橋の東道", line: [[64, -96], [76, -78], [84, -60]], half: 4, level: LEVEL.mesa },
];

/**
 * Rock shelves along a basin's wall, inside it: a band `width` metres deep and
 * `height` above the basin floor, `span` radians either side of the bearing `at`
 * from the basin's middle. One end is a ramp up from the floor; the inner edge is a
 * cliff. They give each POI a high way round its side, reached from one end only.
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
 * The spillway: from the lakebed's north-east corner it sinks to 3 m below the
 * lakebed under the canyon bridge, then climbs to the landing pad's east side.
 */
const CUTS: Cut[] = [
  {
    line: [[20, -40], [36, -55], [48, -75], [52, -95], [56, -115], [48, -132], [36, -128]],
    floor: 5,
    levels: [LEVEL.lakebed, -8, LEVEL.pit, LEVEL.pit, -8, 0, LEVEL.mesa],
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
  const top = levelOf(basin, 0) + sh.height * Math.min(1, fromRampEnd / sh.ramp);
  return top - Math.max(0, inner - d) * CLIFF;
}

/**
 * The lowest of the open shapes' cones at (x, z): each rises from its level at its
 * edge at the cliff slope. `level` is the level of the shape that gives it.
 */
function lowest(x: number, z: number): { h: number; level: number } {
  let h = Infinity;
  let level = 0;
  for (const o of [...BASINS, ...ROADS]) {
    const { d, along: t } = toPolyline(x, z, o.line);
    const lv = levelOf(o, t);
    const cone = lv + Math.max(0, d - o.half) * CLIFF;
    if (cone < h) {
      h = cone;
      level = lv;
    }
  }
  for (const c of CUTS) {
    const { d, along: t } = toPolyline(x, z, c.line);
    const lv = along(c.levels, t);
    const cone = lv + Math.max(0, d - c.floor) * c.slope;
    if (cone < h) {
      h = cone;
      level = lv;
    }
  }
  return { h, level };
}

/** The shaped ground before anything is flattened for buildings. */
function natural(x: number, z: number): number {
  const top = HIGH + vnoise(x / 30, z / 30) * 5;
  return Math.min(top, lowest(x, z).h) + (vnoise(x / 9, z / 9) - 0.5) * 0.5;
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
let floors: Float32Array | null = null;

const smooth = (a: number, b: number, v: number) => {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export interface FlatShape {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** The level it stands on. Left out, the ground under it follows the walkable floor, ramps included. */
  y?: number;
}

/**
 * Builds the cached field. `flat` is everything placed by hand: within 3 m of any
 * of it the ground is exactly at its level, and the shapes blend back in over the
 * next 7 m. Shapes standing below their level (the canyon bridge's pillars) are not given.
 */
export function buildTerrain(flat: FlatShape[]) {
  // Distance from each grid point to the nearest flat shape, and that shape's level,
  // by a two-pass chamfer.
  const dist = new Float32Array(N * N).fill(1e9);
  const at = new Float32Array(N * N);
  // For a shape with no level of its own: the level of the ground at its middle.
  const mid = new Float32Array(N * N);
  for (const b of flat) {
    const y = b.y ?? NaN;
    const m = lowest((b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2).level;
    const i0 = Math.max(0, Math.floor((b.x0 + WORLD.half) / RES));
    const i1 = Math.min(N - 1, Math.ceil((b.x1 + WORLD.half) / RES));
    const j0 = Math.max(0, Math.floor((b.z0 + WORLD.half) / RES));
    const j1 = Math.min(N - 1, Math.ceil((b.z1 + WORLD.half) / RES));
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        dist[j * N + i] = 0;
        at[j * N + i] = y;
        mid[j * N + i] = m;
      }
  }
  const D = RES;
  const DD = RES * Math.SQRT2;
  const relax = (k: number, from: number, step: number) => {
    if (dist[from] + step < dist[k]) {
      dist[k] = dist[from] + step;
      at[k] = at[from];
      mid[k] = mid[from];
    }
  };
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const k = j * N + i;
      if (i > 0) relax(k, k - 1, D);
      if (j > 0) relax(k, k - N, D);
      if (i > 0 && j > 0) relax(k, k - N - 1, DD);
      if (i < N - 1 && j > 0) relax(k, k - N + 1, DD);
    }
  for (let j = N - 1; j >= 0; j--)
    for (let i = N - 1; i >= 0; i--) {
      const k = j * N + i;
      if (i < N - 1) relax(k, k + 1, D);
      if (j < N - 1) relax(k, k + N, D);
      if (i < N - 1 && j < N - 1) relax(k, k + N + 1, DD);
      if (i > 0 && j < N - 1) relax(k, k + N - 1, DD);
    }
  field = new Float32Array(N * N);
  floors = new Float32Array(N * N);
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const x = i * RES - WORLD.half;
      const z = j * RES - WORLD.half;
      const k = j * N + i;
      floors[k] = lowest(x, z).level;
      // A shape with no level follows the floor under each cell (so a ramp stays a ramp),
      // unless that floor is another level altogether: a patrol point on the dam's crest
      // would otherwise press its corner of the dam face down to the lakebed, leaving a pit.
      const level = !Number.isNaN(at[k]) ? at[k] : Math.abs(floors[k] - mid[k]) > 2 ? mid[k] : floors[k];
      // Shelves stand right up to hand-built things (a 1 m gap); other shapes leave them room to blend.
      const dd = dist[k];
      let shelf = -Infinity;
      for (const sh of SHELVES) shelf = Math.max(shelf, shelfAt(sh, x, z));
      const base = level + (natural(x, z) - level) * smooth(3, 10, dd);
      field[k] = (shelf > base ? base + (shelf - base) * smooth(1, 2, dd) : base) + rim(x, z);
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

/**
 * The level of the walkable ground at or nearest (x, z): the basin, road or
 * spillway floor whose cliffs rise lowest here. On high ground it is the level of
 * the low ground at its foot.
 */
export function floorLevel(x: number, z: number): number {
  const i = Math.round((x + WORLD.half) / RES);
  const j = Math.round((z + WORLD.half) / RES);
  if (!floors || i < 0 || j < 0 || i >= N || j >= N) return lowest(x, z).level;
  return floors[j * N + i];
}

/** True on high ground or a cliff: anywhere well above the walkable floor nearby. */
export const highGround = (x: number, z: number) => terrainHeight(x, z) > floorLevel(x, z) + 2;

/** True anywhere outside the walkable shapes, their cliffs included. */
export function offLowGround(x: number, z: number): boolean {
  const { h, level } = lowest(x, z);
  return h > level + 0.5;
}

/**
 * Unit vector from (x, z) toward the nearest walkable ground: down the slope of the
 * open shapes' cones, which ignores the noise on the high ground's top.
 */
export function towardLowGround(x: number, z: number): { x: number; z: number } {
  const e = 0.5;
  const gx = lowest(x + e, z).h - lowest(x - e, z).h;
  const gz = lowest(x, z + e).h - lowest(x, z - e).h;
  const n = Math.hypot(gx, gz) || 1;
  return { x: -gx / n, z: -gz / n };
}
