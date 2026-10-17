import { WORLD } from "./config";

/*
 * The ground of two regions joined by a mountain belt. The south one is a dried-up
 * reservoir: a dam once held a lake in the middle of it; the water is gone and the
 * drowned old town stands on the cracked lakebed, the lowest ground there. Around it
 * the ground steps up: the south shore where the player lands, the west plateau and
 * the old ridge, the dam crest in the north with the landing pad behind it, and the
 * east mesa with the relay tower. A quarry pit is sunk into the west, below even the
 * lakebed.
 *
 * North of the mountains lies the harbor, a bay gone dry: its town and quays stand at
 * sea level, the salt flats of the old bay floor lie below them with a beached cargo
 * ship on their far side, a tidal channel still holds a little water by the pier, and
 * a lighthouse stands on a headland over the flats. Two ways cross the mountains: the
 * pass road, climbing from the landing pad over the high ground, and the railway,
 * an embankment from the east mesa that crosses a gorge on a bridge and runs on into
 * the harbor on a viaduct.
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

/** A line's points with its segment lengths and their sum, worked out once. */
interface Polyline {
  pts: readonly P[];
  lens: number[];
  sum: number;
  /** Its bounding box: the distance to it is a cheap lower bound of the distance to the line. */
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

function polyline(pts: readonly P[]): Polyline {
  const lens = pts.slice(1).map((b, i) => Math.hypot(b[0] - pts[i][0], b[1] - pts[i][1]));
  const xs = pts.map((q) => q[0]);
  const zs = pts.map((q) => q[1]);
  return { pts, lens, sum: lens.reduce((a, b) => a + b, 0) || 1, x0: Math.min(...xs), z0: Math.min(...zs), x1: Math.max(...xs), z1: Math.max(...zs) };
}

/** Distance from (x, z) to a line's bounding box: never more than the distance to the line. */
const nearBox = (x: number, z: number, l: Polyline) => Math.hypot(Math.max(l.x0 - x, 0, x - l.x1), Math.max(l.z0 - z, 0, z - l.z1));

/**
 * Metres outside a shape beyond which `lowest()` skips working out its cone: there it rises
 * higher than the high ground's top, and the ground between has stopped rolling in from it.
 */
const FAR = 40;

/** Distance from (x, z) to the polyline, and the fraction along it of the nearest point. */
function toPolyline(x: number, z: number, { pts, lens, sum }: Polyline): { d: number; along: number } {
  let best = Infinity;
  let along = 0;
  let total = 0;
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
  /** The levels belong to the line's points (else they are spaced evenly along its length). */
  atPoints?: true;
  /**
   * Cliffs all round, below or above the ground between (`between()`): the lakebed and the
   * quarry pit, most ramps cut down into them (the quarry's north road runs out gently instead), the railway's embankments. Without it the shape
   * runs out into the ground between at its own level.
   */
  walled?: true;
}

/** Value at fraction `t` along a line whose points carry `vals`, one each. */
function atPoint(vals: readonly number[], t: number, { lens, sum }: Polyline): number {
  let d = t * sum;
  for (let i = 0; i < lens.length; i++) {
    if (d <= lens[i] || i === lens.length - 1) return vals[i] + (vals[i + 1] - vals[i]) * Math.min(1, d / (lens[i] || 1));
    d -= lens[i];
  }
  return vals[vals.length - 1];
}

const levelOf = (o: Open, t: number, poly: Polyline) => (typeof o.level === "number" ? o.level : o.atPoints ? atPoint(o.level, t, poly) : along(o.level, t));

/** A trench with a flat floor `floor` metres either side of its line, at `levels` along it. */
export interface Cut {
  line: readonly P[];
  floor: number;
  levels: readonly number[];
  slope: number;
  /** The levels belong to the line's points (else they are spaced evenly along its length). */
  atPoints?: true;
}

/** Height of the high ground, and how steeply its cliffs fall to the low ground. */
const HIGH = 17;
const CLIFF = 2.4;

/** The levels people walk on, from the lowest up. */
export const LEVEL = {
  pit: -10,
  lakebed: -7,
  /** The harbor's tidal channel, and the old bay floor (the salt flats, the wreck, the quay). */
  channel: -6,
  seabed: -3,
  shore: 0,
  /** The smelter's terrace above the harbor town. */
  terrace: 3,
  ridge: 5,
  mesa: 7,
  dam: 8,
  headland: 8,
  /** The railway's embankments and the deck of its bridge and viaduct. */
  rail: 10.2,
  pass: 15,
} as const;

/** The dam's face: the cliff from the crest walkway down to the lakebed, drawn as concrete. */
export const DAM_FACE = (x: number, z: number) => Math.abs(x) < 28 && z > -76 && z < -63;

/** Basins: the POIs and the districts. Each holds everything built there. */
const BASINS: Open[] = [
  { name: "補給所", line: [[0, 126], [0, 170]], half: 28, level: LEVEL.shore },
  { name: "湖底", line: [[0, -40], [0, 18]], half: 26, level: LEVEL.lakebed, walled: true },
  { name: "発着場", line: [[-8, -118], [10, -118]], half: 32, level: LEVEL.dam },
  // The dam crest: a walkway along the top of the dam face, the lakebed 15 m below.
  { name: "堤", line: [[-24, -79], [24, -79]], half: 5, level: LEVEL.dam },
  { name: "採掘場", line: [[-166, 8], [-136, 24]], half: 26, level: LEVEL.pit, walled: true },
  { name: "中継塔", line: [[78, -36], [102, -28]], half: 25, level: LEVEL.mesa },
  { name: "住宅地", line: [[104, 26], [122, 2]], half: 14, level: LEVEL.mesa },
  { name: "尾根", line: [[-66, 70], [-34, 70]], half: 10, level: LEVEL.ridge },
  // Close enough to the lakebed that its east side is a clean drop into it.
  { name: "台地", line: [[-58, -46], [-43, -46]], half: 14, level: LEVEL.shore },
  { name: "工場", line: [[54, 42], [60, 58]], half: 16, level: LEVEL.shore },
  { name: "廃村", line: [[-114, -68], [-96, -60]], half: 15, level: LEVEL.shore },
  // The harbor.
  { name: "港町", line: [[-40, -300], [110, -300]], half: 22, level: LEVEL.shore },
  { name: "コンテナヤード", line: [[-125, -400], [-75, -400]], half: 28, level: LEVEL.shore },
  { name: "製錬所", line: [[100, -415], [140, -415]], half: 30, level: LEVEL.terrace },
  { name: "塩田", line: [[-60, -500], [80, -500]], half: 40, level: LEVEL.seabed },
  { name: "難破船", line: [[-40, -562], [60, -562]], half: 22, level: LEVEL.seabed },
  { name: "埠頭", line: [[60, -565], [140, -568]], half: 22, level: LEVEL.seabed },
  { name: "水路", line: [[96, -592], [162, -592]], half: 8, level: LEVEL.channel, walled: true },
  { name: "岬", line: [[-120, -545], [-106, -560]], half: 13, level: LEVEL.headland, walled: true },
  // The top of the pass: a saddle between the peaks, with the harbor in view.
  { name: "峠", line: [[-66, -214], [-54, -230]], half: 9, level: LEVEL.pass },
];

/**
 * Roads between basins, 8 to 10 m wide. Each area has two or three of them; the
 * lakebed has four ramps out and the spillway, and the cliffs everywhere else make
 * the choice of road the choice of approach.
 */
const ROADS: Open[] = [
  { name: "湖への坂", line: [[0, 102], [0, 40]], half: 5, level: [LEVEL.shore, LEVEL.lakebed], walled: true },
  // Up onto the ridge at its east end, along its top, and down the haul road into the pit at its west end.
  // The climb starts at the supply basin's edge: a ramp rising inside a basin would leave a step where they meet.
  { name: "尾根道", line: [[-20, 106], [-29, 93], [-40, 77]], half: 5, level: [LEVEL.shore, LEVEL.shore, LEVEL.ridge] },
  { name: "採掘場の運搬路", line: [[-70, 64], [-110, 72], [-150, 62], [-172, 30]], half: 5, level: [LEVEL.ridge, -1, -8, LEVEL.pit], walled: true },
  { name: "西道", line: [[-24, 16], [-60, 16], [-112, 20]], half: 5, level: [LEVEL.lakebed, -8, LEVEL.pit], walled: true },
  { name: "廃村道", line: [[-150, -14], [-124, -46]], half: 5, level: [LEVEL.pit, LEVEL.shore] },
  { name: "湖の西坂", line: [[-22, -30], [-44, -38]], half: 5, level: [LEVEL.lakebed, LEVEL.shore], walled: true },
  { name: "堤の西坂", line: [[-56, -58], [-52, -82], [-30, -80]], half: 5, level: [LEVEL.shore, 6, LEVEL.dam] },
  { name: "廃村の北道", line: [[-96, -74], [-66, -96], [-40, -110]], half: 5, level: [LEVEL.shore, 4, LEVEL.dam] },
  { name: "工場道", line: [[24, 104], [44, 76], [52, 60]], half: 5, level: LEVEL.shore },
  { name: "住宅道", line: [[70, 52], [92, 38], [106, 28]], half: 5, level: [LEVEL.shore, 4, LEVEL.mesa] },
  { name: "東の坂", line: [[22, 0], [44, -8], [58, -24], [62, -34]], half: 5, level: [LEVEL.lakebed, -1, 5, LEVEL.mesa], walled: true },
  // To the canyon bridge: the deck is at the mesa's level, a step down from the pad.
  { name: "橋の西道", line: [[26, -100], [40, -95]], half: 4, level: [LEVEL.dam, LEVEL.mesa] },
  { name: "橋の東道", line: [[64, -96], [76, -78], [84, -60]], half: 4, level: LEVEL.mesa },
  // Over the mountains to the harbor: up from the landing pad to the saddle and down to the town.
  // Each ramp reaches the level of the basin it runs into at that basin's edge: one still
  // above it there would end in a cliff.
  { name: "峠道", line: [[-28, -142], [-48, -185], [-60, -222], [-64, -262], [-57, -288], [-52, -300]], half: 5, level: [LEVEL.dam, 12, LEVEL.pass, 8, LEVEL.shore, LEVEL.shore], atPoints: true },
  // The railway's embankment from the mesa north to the gorge, and on from the gorge to the
  // harbor, where it ends in a cliff and the viaduct carries the line on.
  { name: "鉄道の土手（南）", line: [[123, -44], [125, -60], [124, -120], [122, -176]], half: 5, level: [LEVEL.mesa, 7.6, 9.6, LEVEL.rail], atPoints: true, walled: true },
  { name: "鉄道の土手（北）", line: [[122, -205], [122, -250]], half: 5, level: LEVEL.rail, walled: true },
  { name: "駅の坂", line: [[122, -236], [100, -258], [94, -276], [90, -290]], half: 5, level: [LEVEL.rail, 4, LEVEL.shore, LEVEL.shore], atPoints: true },
  // Under the viaduct: a road along the line from the station to the container yard.
  { name: "高架下", line: [[122, -268], [122, -350], [-80, -350], [-95, -378]], half: 6, level: LEVEL.shore },
  { name: "西の道", line: [[-50, -305], [-75, -340], [-95, -375]], half: 5, level: LEVEL.shore },
  { name: "製錬所の坂", line: [[122, -350], [122, -390]], half: 5, level: [LEVEL.shore, LEVEL.terrace], atPoints: true },
  { name: "塩田への坂", line: [[20, -350], [20, -462]], half: 5, level: [LEVEL.shore, LEVEL.seabed], atPoints: true },
  { name: "ヤードの北道", line: [[-95, -425], [-79, -461], [-75, -470]], half: 5, level: [LEVEL.shore, LEVEL.seabed, LEVEL.seabed], atPoints: true },
  { name: "製錬所の北道", line: [[115, -440], [105, -470]], half: 5, level: [LEVEL.terrace, LEVEL.seabed], atPoints: true },
  { name: "岬の坂", line: [[-92, -526], [-104, -538], [-112, -548]], half: 5, level: [LEVEL.seabed, 3, LEVEL.headland], atPoints: true, walled: true },
  // A slipway from the quay down into the channel.
  { name: "斜路", line: [[150, -570], [156, -583], [160, -590]], half: 4, level: [LEVEL.seabed, LEVEL.channel, LEVEL.channel], atPoints: true, walled: true },
];

/** The line of the road named `name` (empty when there is none). */
export const roadLine = (name: string): readonly P[] => ROADS.find((r) => r.name === name)?.line ?? [];

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
  /**
   * The gorge the railway bridge crosses: a dry river bed from under the mountains,
   * past the bridge and down to the harbor town's east end. Walled by cliffs.
   */
  {
    line: [[70, -192], [120, -190], [150, -205], [160, -245], [140, -285], [124, -300]],
    floor: 4,
    levels: [-5, -6, -5, -3, LEVEL.shore, LEVEL.shore],
    slope: CLIFF,
    atPoints: true,
  },
];

/** Open shapes and cuts with their lines worked out once: `lowest()` runs for every grid cell. */
const OPEN = [...BASINS, ...ROADS].map((o) => ({ o, poly: polyline(o.line) }));
const CUT_LINES = CUTS.map((c) => ({ c, poly: polyline(c.line) }));

/**
 * A land mass: its coast lies `radius(bearing)` metres from its middle, the bearing
 * measured from it as `Math.atan2(dz, dx)`. Beyond the coast cliffs rise to the horizon.
 */
export interface Land {
  name: string;
  x: number;
  z: number;
  radius: (bearing: number) => number;
  /** No bearing's radius is larger: `offshore()` skips a land too far off to be the nearest coast. */
  max: number;
}

/** The land masses. The world's coast is the outline of all of them together. */
export const LANDS: Land[] = [
  { name: "島", x: 0, z: 0, radius: (a) => 228 + 8 * Math.sin(3 * a + 1.1) + 5 * Math.sin(7 * a + 2.3) + 3 * Math.sin(13 * a + 0.4), max: 244 },
  // The mountain belt between the two regions, wider east to west.
  { name: "山地", x: 30, z: -205, radius: (a) => 140 + 45 * Math.abs(Math.cos(a)) + 6 * Math.sin(5 * a + 0.7), max: 191 },
  { name: "港湾", x: 0, z: -420, radius: (a) => 252 + 6 * Math.sin(3 * a + 0.5) + 4 * Math.sin(7 * a + 1.9) + 2 * Math.sin(11 * a + 0.3), max: 264 },
  // The quay and its channel, out at the harbor's north-east corner.
  { name: "埠頭", x: 125, z: -575, radius: (a) => 62 + 4 * Math.sin(4 * a + 1.3), max: 66 },
];

/** How far (x, z) lies outside one land mass's coast; negative inside it. */
export const outsideLand = (l: Land, x: number, z: number) => Math.hypot(x - l.x, z - l.z) - l.radius(Math.atan2(z - l.z, x - l.x));

/** How far (x, z) lies outside the coast, metres; negative on land, by how far inland. */
export function offshore(x: number, z: number): number {
  let out = Infinity;
  // A land whose coast cannot come nearer than the nearest yet changes nothing: the minimum is
  // the same as over every land, in any order.
  for (const l of LANDS) if (Math.hypot(x - l.x, z - l.z) - l.max < out) out = Math.min(out, outsideLand(l, x, z));
  return out;
}

/** The land mass whose coast (x, z) lies furthest inside, or nearest to when it is offshore. */
export function landAt(x: number, z: number): Land {
  let best = LANDS[0];
  for (const l of LANDS) if (outsideLand(l, x, z) < outsideLand(best, x, z)) best = l;
  return best;
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

/** Metres a shelf's top runs on past its basin's edge, over the foot of the basin's wall. */
const SHELF_OUT = 3;

const SHELF_BASINS = SHELVES.map((sh) => OPEN.find(({ o }) => o.name === sh.basin)!);

function shelfAt(n: number, x: number, z: number): number {
  const sh = SHELVES[n];
  const { o: basin, poly } = SHELF_BASINS[n];
  if (nearBox(x, z, poly) > basin.half + SHELF_OUT) return -Infinity;
  const [a0, b0] = [basin.line[0], basin.line[basin.line.length - 1]];
  const cx = (a0[0] + b0[0]) / 2;
  const cz = (a0[1] + b0[1]) / 2;
  const off = Math.atan2(Math.sin(Math.atan2(z - cz, x - cx) - sh.at), Math.cos(Math.atan2(z - cz, x - cx) - sh.at));
  if (Math.abs(off) > sh.span) return -Infinity;
  const d = toPolyline(x, z, poly).d;
  const inner = basin.half - sh.width;
  if (d > basin.half + SHELF_OUT) return -Infinity;
  // Rise from the floor along the ramp end, then flat to the far end.
  const fromRampEnd = (sh.span - off * sh.rampEnd) * (basin.half - sh.width / 2);
  const top = levelOf(basin, 0, poly) + sh.height * Math.min(1, fromRampEnd / sh.ramp);
  return top - Math.max(0, inner - d) * CLIFF;
}

const smooth = (a: number, b: number, v: number) => {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * High ground kept among the ground between: the mountain belt between the regions, which
 * only the pass road and the railway cross, and rock outcrops that stand over the open
 * ground as landmarks and break its sightlines. Inside one the ground rises from its edge
 * at the cliff slope to the high ground's top.
 */
const CRAGS: { name: string; line: readonly P[]; half: number }[] = [
  { name: "山地", line: [[-330, -205], [-230, -214], [-150, -200], [-80, -216], [0, -206], [70, -218], [150, -200], [230, -213], [330, -204]], half: 50 },
  // The reservoir.
  { name: "西の岩山", line: [[-128, 112], [-116, 124]], half: 19 },
  { name: "東の岩稜", line: [[150, -30], [165, 20]], half: 7 },
  { name: "南東の岩", line: [[148, 132], [158, 124]], half: 16 },
  { name: "北西の岩稜", line: [[-185, -105], [-150, -122]], half: 8 },
  { name: "南の岩", line: [[45, 190], [52, 186]], half: 9 },
  // The harbor.
  { name: "港の岩山", line: [[36, -422], [50, -432]], half: 18 },
  { name: "西の岩稜", line: [[-135, -470], [-112, -440]], half: 7 },
  { name: "東の岩", line: [[198, -422], [208, -412]], half: 16 },
  { name: "北の岩", line: [[150, -472], [158, -480]], half: 12 },
  { name: "西の道の岩", line: [[-142, -342], [-132, -350]], half: 12 },
  // Cliffs over the far side of the channel: the water stays a waterfront along the quay.
  { name: "水路の崖", line: [[76, -598], [92, -614], [190, -614]], half: 13 },
];
const CRAG_LINES = CRAGS.map((c) => ({ c, poly: polyline(c.line) }));

/** Metres inside the coast where the ground between turns into the coast's cliff. */
const COAST = 8;

/** Cell size of the ground-between grid. */
const BRES = 4;
const BNX = Math.ceil((WORLD.x1 - WORLD.x0) / BRES) + 1;
const BNZ = Math.ceil((WORLD.z1 - WORLD.z0) / BRES) + 1;
let betweenField: Float32Array | null = null;

/**
 * Laplace's equation relaxed over a grid of `res` metres: every cell inside an open shape that
 * is not walled holds that shape's level, and the rest settle to the smoothest surface between
 * them. Free cells start at `start` where given, else at their nearest fixed cell's level.
 */
function relaxed(res: number, sweeps: number, start?: (x: number, z: number) => number): Float32Array {
  const nx = Math.ceil((WORLD.x1 - WORLD.x0) / res) + 1;
  const nz = Math.ceil((WORLD.z1 - WORLD.z0) / res) + 1;
  const u = new Float32Array(nx * nz);
  const fixed = new Uint8Array(nx * nz);
  const queue: number[] = [];
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const x = WORLD.x0 + i * res;
      const z = WORLD.z0 + j * res;
      let lv = Infinity;
      for (const n of bucketAt(x, z).open) {
        const { o, poly } = OPEN[n];
        if (o.walled || nearBox(x, z, poly) > o.half) continue;
        const { d, along: t } = toPolyline(x, z, poly);
        if (d <= o.half) lv = Math.min(lv, levelOf(o, t, poly));
      }
      const k = j * nx + i;
      if (lv < Infinity) {
        u[k] = lv;
        fixed[k] = 1;
        queue.push(k);
      } else if (start) u[k] = start(x, z);
    }
  if (!start) {
    const seen = Uint8Array.from(fixed);
    for (let q = 0; q < queue.length; q++) {
      const k = queue[q];
      const i = k % nx;
      for (const n of [i > 0 ? k - 1 : -1, i < nx - 1 ? k + 1 : -1, k - nx, k + nx]) {
        if (n < 0 || n >= u.length || seen[n]) continue;
        seen[n] = 1;
        u[n] = u[k];
        queue.push(n);
      }
    }
  }
  // Over-relaxed Gauss-Seidel sweeps; the world's edges mirror.
  const w = 1.9;
  for (let it = 0; it < sweeps; it++)
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        if (fixed[k]) continue;
        const l = u[i > 0 ? k - 1 : k + 1];
        const r = u[i < nx - 1 ? k + 1 : k - 1];
        const t = u[j > 0 ? k - nx : k + nx];
        const b = u[j < nz - 1 ? k + nx : k - nx];
        u[k] += w * ((l + r + t + b) / 4 - u[k]);
      }
  return u;
}

/**
 * The ground between the open shapes, before its rolling: the smoothest surface (harmonic)
 * that meets every open shape that is not walled at that shape's level. Walking out of a
 * basin the ground runs on at the basin's level and climbs or falls evenly toward the next
 * one, as steep as their levels and the distance between them make it. Settled first on a
 * coarse grid, whose long-range shape a fine grid takes in only slowly, then on the fine one.
 */
function betweenGrid(): Float32Array {
  if (betweenField) return betweenField;
  const C = 16;
  const cnx = Math.ceil((WORLD.x1 - WORLD.x0) / C) + 1;
  const coarse = relaxed(C, 400);
  const at = (x: number, z: number) => {
    const fx = Math.min(cnx - 1.001, (x - WORLD.x0) / C);
    const fz = (z - WORLD.z0) / C;
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const k = j * cnx + i;
    const u = fx - i;
    const v = fz - j;
    const below = coarse[k] + (coarse[k + 1] - coarse[k]) * u;
    const next = k + cnx < coarse.length ? k + cnx : k;
    const above = coarse[next] + (coarse[next + 1] - coarse[next]) * u;
    return below + (above - below) * v;
  };
  betweenField = relaxed(BRES, 150, at);
  return betweenField;
}

/** The ground between at (x, z), before its rolling. */
function betweenAt(x: number, z: number): number {
  const u = betweenGrid();
  const fx = Math.max(0, Math.min(BNX - 1.001, (x - WORLD.x0) / BRES));
  const fz = Math.max(0, Math.min(BNZ - 1.001, (z - WORLD.z0) / BRES));
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  const a = u[j * BNX + i];
  const b = u[j * BNX + i + 1];
  const c = u[(j + 1) * BNX + i];
  const d = u[(j + 1) * BNX + i + 1];
  const tu = fx - i;
  const tv = fz - j;
  return a + (b - a) * tu + (c - a) * tv + (a - b - c + d) * tu * tv;
}

/** Low rolling hills on the ground between, fading in away from the open shapes' edges. */
const rolling = (x: number, z: number) => (vnoise(x / 60 + 17, z / 60) - 0.5) * 8 + (vnoise(x / 20, z / 20 + 9) - 0.5) * 1.6;

/** Index of the ground between among the shapes `lowest()` answers with. */
const BETWEEN = OPEN.length + CUTS.length;

/**
 * The lowest of the open shapes' cones at (x, z): each rises from its level at its
 * edge at the cliff slope. Outside every open shape the ground between is one more,
 * rising at the cliff slope into the crags and the coast. `level` is the level of the
 * shape that gives it.
 */
/**
 * Which shapes can matter where, in 32 m squares over the world's bounds: each square lists the
 * open shapes and cuts whose cones `lowest()` works out there (within FAR of their edge), the crags
 * that rise there and the shelves that reach there. Every shape left off a square's list is one
 * that `lowest()` and `shelfAt()` would skip at every point of it, so the answers are the same as
 * scanning all of them, at a cost that stays flat however many shapes the world holds.
 */
const BUCKET = 32;
const BX = Math.ceil((WORLD.x1 - WORLD.x0) / BUCKET) + 1;
const BZ = Math.ceil((WORLD.z1 - WORLD.z0) / BUCKET) + 1;

interface Bucket {
  open: number[];
  cuts: number[];
  crags: number[];
  shelves: number[];
}

/** The squares whose ground lies within `reach` of the box (a metre of slack for rounding). */
function squaresNear(l: { x0: number; z0: number; x1: number; z1: number }, reach: number, add: (b: number) => void) {
  const r = reach + 1;
  const i0 = Math.max(0, Math.floor((l.x0 - r - WORLD.x0) / BUCKET));
  const i1 = Math.min(BX - 1, Math.floor((l.x1 + r - WORLD.x0) / BUCKET));
  const j0 = Math.max(0, Math.floor((l.z0 - r - WORLD.z0) / BUCKET));
  const j1 = Math.min(BZ - 1, Math.floor((l.z1 + r - WORLD.z0) / BUCKET));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) add(j * BX + i);
}

const BUCKETS: Bucket[] = (() => {
  const out: Bucket[] = Array.from({ length: BX * BZ }, () => ({ open: [], cuts: [], crags: [], shelves: [] }));
  // Shapes go in in their own order, so ties between equal cones fall the same way as a full scan.
  OPEN.forEach(({ o, poly }, n) => squaresNear(poly, o.half + FAR, (b) => out[b].open.push(n)));
  CUT_LINES.forEach(({ c, poly }, n) => squaresNear(poly, c.floor + FAR, (b) => out[b].cuts.push(n)));
  CRAG_LINES.forEach(({ c, poly }, n) => squaresNear(poly, c.half, (b) => out[b].crags.push(n)));
  SHELVES.forEach((_, n) => {
    const { o, poly } = SHELF_BASINS[n];
    squaresNear(poly, o.half + SHELF_OUT, (b) => out[b].shelves.push(n));
  });
  return out;
})();

/** Every shape, for points outside the world's bounds: there `lowest()` scans them all. */
const EVERY: Bucket = { open: OPEN.map((_, n) => n), cuts: CUT_LINES.map((_, n) => n), crags: CRAG_LINES.map((_, n) => n), shelves: SHELVES.map((_, n) => n) };

function bucketAt(x: number, z: number): Bucket {
  const i = Math.floor((x - WORLD.x0) / BUCKET);
  const j = Math.floor((z - WORLD.z0) / BUCKET);
  return i < 0 || j < 0 || i >= BX || j >= BZ ? EVERY : BUCKETS[j * BX + i];
}

function lowest(x: number, z: number, near = bucketAt(x, z)): { h: number; level: number; shape: number } {
  let h = Infinity;
  let level = 0;
  let shape = 0;
  // How far outside the nearest open shape or cut (x, z) lies; negative inside one.
  let edge = Infinity;
  for (const n of near.open) {
    const { o, poly } = OPEN[n];
    const far = nearBox(x, z, poly) - o.half;
    if (far > FAR) {
      edge = Math.min(edge, far);
      continue;
    }
    const { d, along: t } = toPolyline(x, z, poly);
    const lv = levelOf(o, t, poly);
    edge = Math.min(edge, d - o.half);
    const cone = lv + Math.max(0, d - o.half) * CLIFF;
    if (cone < h) {
      h = cone;
      level = lv;
      shape = n;
    }
  }
  for (const n of near.cuts) {
    const { c, poly } = CUT_LINES[n];
    const far = nearBox(x, z, poly) - c.floor;
    if (far > FAR) {
      edge = Math.min(edge, far);
      continue;
    }
    const { d, along: t } = toPolyline(x, z, poly);
    const lv = c.atPoints ? atPoint(c.levels, t, poly) : along(c.levels, t);
    edge = Math.min(edge, d - c.floor);
    const cone = lv + Math.max(0, d - c.floor) * c.slope;
    if (cone < h) {
      h = cone;
      level = lv;
      shape = OPEN.length + n;
    }
  }
  if (edge > 0) {
    const lv = betweenAt(x, z) + rolling(x, z) * smooth(2, 30, edge);
    let crag = 0;
    for (const n of near.crags) {
      const { c, poly } = CRAG_LINES[n];
      crag = Math.max(crag, c.half - toPolyline(x, z, poly).d);
    }
    const rise = lv + (crag + Math.max(0, offshore(x, z) + COAST)) * CLIFF;
    if (rise < h) {
      h = rise;
      level = lv;
      shape = BETWEEN;
    }
  }
  return { h, level, shape };
}

/**
 * For the sim gate: at `n` points spread over the world (and a little past it), the shapes the
 * index lists give the same lowest ground and shelves as all the shapes do, and no land's coast
 * lies further out than its `max`. Null when they agree, else what differs.
 */
export function checkTerrainIndex(n: number): string | null {
  for (const l of LANDS)
    for (let k = 0; k < 3600; k++) {
      const a = -Math.PI + (k / 3600) * 2 * Math.PI;
      if (l.radius(a) > l.max) return `land ${l.name}: radius ${l.radius(a).toFixed(2)} past its max ${l.max} at bearing ${a.toFixed(3)}`;
    }
  let seed = 4242;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let k = 0; k < n; k++) {
    const x = WORLD.x0 - 40 + rnd() * (WORLD.x1 - WORLD.x0 + 80);
    const z = WORLD.z0 - 40 + rnd() * (WORLD.z1 - WORLD.z0 + 80);
    const a = lowest(x, z);
    const b = lowest(x, z, EVERY);
    if (a.h !== b.h || a.level !== b.level || a.shape !== b.shape) return `terrain index at ${x.toFixed(1)},${z.toFixed(1)}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
    let sa = -Infinity;
    let sb = -Infinity;
    for (const m of bucketAt(x, z).shelves) sa = Math.max(sa, shelfAt(m, x, z));
    for (let m = 0; m < SHELVES.length; m++) sb = Math.max(sb, shelfAt(m, x, z));
    if (sa !== sb) return `shelf index at ${x.toFixed(1)},${z.toFixed(1)}: ${sa} vs ${sb}`;
  }
  return null;
}

/** Names of the open shapes, then "谷" for each cut and "野" for the ground between: what `surfaceAt()` answers with. */
const SHAPE_NAMES = [...OPEN.map(({ o }) => o.name), ...CUTS.map(() => "谷"), "野"];

/** The shaped ground before anything is flattened for buildings; `low` is `lowest(x, z).h` when already known. */
function natural(x: number, z: number, low = lowest(x, z).h): number {
  const top = HIGH + vnoise(x / 30, z / 30) * 5;
  return Math.min(top, low) + (vnoise(x / 9, z / 9) - 0.5) * 0.5;
}

/** The rim: cliffs rising beyond the coast, out to the horizon. */
function rim(x: number, z: number): number {
  const out = offshore(x, z);
  if (out <= 0) return 0;
  return Math.min(48, out * 2.2) * (0.8 + vnoise(x * 0.05, z * 0.05) * 0.4) + vnoise(x * 0.2, z * 0.2) * Math.min(out, 6);
}

/** Grid points of the cached field on each axis, from the world's corner (x0, z0). */
const NX = Math.round((WORLD.x1 - WORLD.x0) / RES) + 1;
const NZ = Math.round((WORLD.z1 - WORLD.z0) / RES) + 1;
let field: Float32Array | null = null;
let steep: Uint8Array | null = null;
let floors: Float32Array | null = null;
let shapes: Uint8Array | null = null;


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
  const dist = new Float32Array(NX * NZ).fill(1e9);
  const at = new Float32Array(NX * NZ);
  // For a shape with no level of its own: the level of the ground at its middle.
  const mid = new Float32Array(NX * NZ);
  for (const b of flat) {
    const y = b.y ?? NaN;
    const m = lowest((b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2).level;
    const i0 = Math.max(0, Math.floor((b.x0 - WORLD.x0) / RES));
    const i1 = Math.min(NX - 1, Math.ceil((b.x1 - WORLD.x0) / RES));
    const j0 = Math.max(0, Math.floor((b.z0 - WORLD.z0) / RES));
    const j1 = Math.min(NZ - 1, Math.ceil((b.z1 - WORLD.z0) / RES));
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        // A shape with a level of its own (a building) keeps it under one without (a bin's room round it).
        if (Number.isNaN(y) && dist[j * NX + i] === 0 && !Number.isNaN(at[j * NX + i])) continue;
        dist[j * NX + i] = 0;
        at[j * NX + i] = y;
        mid[j * NX + i] = m;
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
  for (let j = 0; j < NZ; j++)
    for (let i = 0; i < NX; i++) {
      const k = j * NX + i;
      if (i > 0) relax(k, k - 1, D);
      if (j > 0) relax(k, k - NX, D);
      if (i > 0 && j > 0) relax(k, k - NX - 1, DD);
      if (i < NX - 1 && j > 0) relax(k, k - NX + 1, DD);
    }
  for (let j = NZ - 1; j >= 0; j--)
    for (let i = NX - 1; i >= 0; i--) {
      const k = j * NX + i;
      if (i < NX - 1) relax(k, k + 1, D);
      if (j < NZ - 1) relax(k, k + NX, D);
      if (i < NX - 1 && j < NZ - 1) relax(k, k + NX + 1, DD);
      if (i > 0 && j < NZ - 1) relax(k, k + NX - 1, DD);
    }
  field = new Float32Array(NX * NZ);
  floors = new Float32Array(NX * NZ);
  shapes = new Uint8Array(NX * NZ);
  for (let j = 0; j < NZ; j++)
    for (let i = 0; i < NX; i++) {
      const x = WORLD.x0 + i * RES;
      const z = WORLD.z0 + j * RES;
      const k = j * NX + i;
      const low = lowest(x, z);
      floors[k] = low.level;
      shapes[k] = low.shape;
      // A shape with no level follows the floor under each cell (so a ramp stays a ramp),
      // unless that floor is another level altogether: a patrol point on the dam's crest
      // would otherwise press its corner of the dam face down to the lakebed, leaving a pit.
      const level = !Number.isNaN(at[k]) ? at[k] : Math.abs(floors[k] - mid[k]) > 2 ? mid[k] : floors[k];
      // Shelves stand right up to hand-built things (a 1 m gap); other shapes leave them room to blend.
      const dd = dist[k];
      let shelf = -Infinity;
      for (const n of bucketAt(x, z).shelves) shelf = Math.max(shelf, shelfAt(n, x, z));
      const base = level + (natural(x, z, low.h) - level) * smooth(3, 10, dd);
      field[k] = (shelf > base ? base + (shelf - base) * smooth(1, 2, dd) : base) + rim(x, z);
    }
  steep = new Uint8Array(NX * NZ);
  for (let j = 1; j < NZ - 1; j++)
    for (let i = 1; i < NX - 1; i++) {
      const gx = (field[j * NX + i + 1] - field[j * NX + i - 1]) / (2 * RES);
      const gz = (field[(j + 1) * NX + i] - field[(j - 1) * NX + i]) / (2 * RES);
      // A cell is a cliff when the ground rises steeply across it or onto a neighbour.
      const up = Math.max(Math.abs(gx), Math.abs(gz), Math.hypot(gx, gz));
      if (up > STEEP) steep[j * NX + i] = 1;
    }
}

/**
 * A trench cut into the built field only while the route it belongs to is open (`ROUTES` in
 * map.ts): a floor `floor` metres either side of its line at the levels along it, walls rising
 * at `slope`. It only ever lowers the ground, and `surfaceAt()` answers `name` on it.
 */
export interface Carve extends Cut {
  name: string;
}

/** The trench's ground at (x, z) before the field's own height caps it, or Infinity beyond its reach. */
function carveAt(c: Carve, poly: Polyline, x: number, z: number): { h: number; level: number } {
  const { d, along: t } = toPolyline(x, z, poly);
  const level = c.atPoints ? atPoint(c.levels, t, poly) : along(c.levels, t);
  return { h: level + Math.max(0, d - c.floor) * c.slope + (vnoise(x / 9, z / 9) - 0.5) * 0.5, level };
}

/** Cells the carves now in place changed, with what the built field held there, to put back. */
const carved = new Map<number, { field: number; floor: number; shape: number; steep: number }>();

/**
 * Puts exactly `carves` into the field, taking out any cut before. The field built by
 * `buildTerrain()` stays the one with nothing carved, so a world with every route closed is
 * the same ground cell for cell. Only the cached field changes: `lowest()` keeps answering for
 * the ground as built, so the drop and the leap's glide treat a route's roof as the high
 * ground it covers.
 */
export function carveTerrain(carves: readonly Carve[]) {
  if (!field || !floors || !shapes || !steep) throw new Error("carveTerrain before buildTerrain");
  for (const [k, v] of carved) {
    field[k] = v.field;
    floors[k] = v.floor;
    shapes[k] = v.shape;
    steep[k] = v.steep;
  }
  carved.clear();
  const save = (k: number) => {
    if (!carved.has(k)) carved.set(k, { field: field![k], floor: floors![k], shape: shapes![k], steep: steep![k] });
  };
  for (const c of carves) {
    let shape = SHAPE_NAMES.indexOf(c.name);
    if (shape < 0) shape = SHAPE_NAMES.push(c.name) - 1;
    const poly = polyline(c.line);
    // Beyond this the walls have risen past any high ground: nothing there is lowered.
    const reach = c.floor + (HIGH + 12 - Math.min(...c.levels)) / c.slope;
    const i0 = Math.max(1, Math.floor((poly.x0 - reach - WORLD.x0) / RES));
    const i1 = Math.min(NX - 2, Math.ceil((poly.x1 + reach - WORLD.x0) / RES));
    const j0 = Math.max(1, Math.floor((poly.z0 - reach - WORLD.z0) / RES));
    const j1 = Math.min(NZ - 2, Math.ceil((poly.z1 + reach - WORLD.z0) / RES));
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const k = j * NX + i;
        const at = carveAt(c, poly, WORLD.x0 + i * RES, WORLD.z0 + j * RES);
        if (at.h >= field[k]) continue;
        save(k);
        field[k] = at.h;
        floors[k] = at.level;
        shapes[k] = shape;
      }
    // Cliffs over again where the trench changed the slope, one cell round it included.
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const k = j * NX + i;
        const gx = (field[k + 1] - field[k - 1]) / (2 * RES);
        const gz = (field[k + NX] - field[k - NX]) / (2 * RES);
        const s = Math.max(Math.abs(gx), Math.abs(gz), Math.hypot(gx, gz)) > STEEP ? 1 : 0;
        if (s === steep[k]) continue;
        save(k);
        steep[k] = s;
      }
  }
}

/** Ground height at (x, z). Outside the world's bounds it is the rim's horizon. */
export function terrainHeight(x: number, z: number): number {
  const fx = (x - WORLD.x0) / RES;
  const fz = (z - WORLD.z0) / RES;
  if (!field || fx < 0 || fz < 0 || fx >= NX - 1 || fz >= NZ - 1) return rim(x, z) + (field ? 0 : natural(x, z));
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  const u = fx - i;
  const v = fz - j;
  const a = field[j * NX + i];
  const b = field[j * NX + i + 1];
  const c = field[(j + 1) * NX + i];
  const d = field[(j + 1) * NX + i + 1];
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** True where the ground is a cliff. Outside the world's bounds everything is. */
export function steepAt(x: number, z: number): boolean {
  const i = Math.round((x - WORLD.x0) / RES);
  const j = Math.round((z - WORLD.z0) / RES);
  if (!steep || i < 0 || j < 0 || i >= NX || j >= NZ) return true;
  return steep[j * NX + i] === 1;
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
  const i = Math.round((x - WORLD.x0) / RES);
  const j = Math.round((z - WORLD.z0) / RES);
  if (!floors || i < 0 || j < 0 || i >= NX || j >= NZ) return lowest(x, z).level;
  return floors[j * NX + i];
}

/**
 * The name of the basin or road whose floor is the walkable ground at or nearest (x, z)
 * ("谷" for a canyon floor): the renderer and the map paint the salt flats and the quays
 * by it, and the cover scattered over the salt flats is kept sparse by it.
 */
export function surfaceAt(x: number, z: number): string {
  const i = Math.round((x - WORLD.x0) / RES);
  const j = Math.round((z - WORLD.z0) / RES);
  if (!shapes || i < 0 || j < 0 || i >= NX || j >= NZ) return SHAPE_NAMES[lowest(x, z).shape];
  return SHAPE_NAMES[shapes[j * NX + i]];
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
