import { WORLD } from "./config";
import { AREA, POI_AT, type AreaId } from "./areas";
import type { PoiId } from "./map";
import { hypot2 } from "./hypot";

/*
 * The ground of four regions: two joined by a mountain belt, the machine city's paved basin
 * east of them across a dried strait, and the launch site's plateau west of them across a dry
 * canyon (their ground is at the end). The south one is a dried-up
 * reservoir: a dam once held a lake in the middle of it; the water is gone and the
 * drowned town stands on the cracked lakebed, 14 m under the shore. Around it the ground
 * steps up and down: the dam's 30 m wall in the north with the landing pad on top of it,
 * the plateau over the lakebed's west side, the red quarry dug in terraces into the west,
 * the sandstone mesa with the relay mast in the east, the terraced fields climbing to a
 * hill in the north-west, the works and housing in the south-east, and the dune coast
 * with the supply depot in the south.
 *
 * North of the mountains lies the harbor, a bay gone dry: its town and quays stand at
 * sea level, the salt flats of the old bay floor lie below them with a beached cargo
 * ship on their far side, a tidal channel still holds a little water by the pier, and
 * a lighthouse stands on a headland over the flats. Two ways cross the mountains: the
 * pass road, climbing from the landing pad over the high ground, and the railway,
 * an embankment from the east mesa's foot that crosses a gorge on a bridge and runs on into
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
  const lens = pts.slice(1).map((b, i) => hypot2(b[0] - pts[i][0], b[1] - pts[i][1]));
  const xs = pts.map((q) => q[0]);
  const zs = pts.map((q) => q[1]);
  return { pts, lens, sum: lens.reduce((a, b) => a + b, 0) || 1, x0: Math.min(...xs), z0: Math.min(...zs), x1: Math.max(...xs), z1: Math.max(...zs) };
}

/** Distance from (x, z) to a line's bounding box: never more than the distance to the line. */
const nearBox = (x: number, z: number, l: Polyline) => hypot2(Math.max(l.x0 - x, 0, x - l.x1), Math.max(l.z0 - z, 0, z - l.z1));

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
    const d = hypot2(x - ax - dx * t, z - az - dz * t);
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
  /** Sand dunes on the shape's floor (a basin's), which fade out toward its edge. */
  dunes?: readonly Dune[];
  /** What its ground is painted as (`Ground`); left out, the island's plain soil. */
  ground?: Ground;
}

/**
 * The material a shape's ground shows: each district of the world has its own, so that one reads
 * from another at a glance. Only the renderer and the world map read it: it changes no rule.
 * `quarry` and `sandstone` colour the cliffs round their shapes too (`cliffGround()`).
 */
export type Ground = "dune" | "salt" | "paved" | "mud" | "quarry" | "sandstone" | "scrub" | "oiled" | "concrete" | "asphalt" | "caliche";

/**
 * A dune: its crest runs along `line`, `height` metres over the floor it stands on, and its sides
 * fall away over `half` metres, gentle enough to walk (a crest of 12 m over 26 m rises 0.7 per metre at
 * most). Crests open and close the sightlines over a floor that would otherwise be one flat yard.
 * The floor's level carries it (`floorLevel()`), so things placed out on a dune stand on its sand.
 */
interface Dune {
  line: readonly P[];
  half: number;
  height: number;
}

/** Metres inside its basin's edge over which a dune fades out, so the floor meets the ground beyond at its level. */
const DUNE_FADE = 16;

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

/** The dunes' rise over a shape's floor at (x, z), `d` metres from the shape's line: the highest crest's. */
function duneRise(dunes: readonly { dune: Dune; poly: Polyline }[], half: number, x: number, z: number, d: number): number {
  let rise = 0;
  for (const { dune, poly } of dunes) {
    if (nearBox(x, z, poly) >= dune.half) continue;
    const t = Math.min(1, toPolyline(x, z, poly).d / dune.half);
    rise = Math.max(rise, dune.height * (0.5 + 0.5 * Math.cos(Math.PI * t)));
  }
  return rise * smooth(0, DUNE_FADE, half - d);
}

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
const HIGH = 28;
const CLIFF = 2.4;

/** The levels people walk on, from the lowest up. */
export const LEVEL = {
  /** The quarry's floor, at the bottom of its terraces. */
  pit: -25,
  quarryMid: -16,
  lakebed: -14,
  quarryTop: -7,
  /** The harbor's tidal channel, and the old bay floor (the salt flats, the wreck, the quay). */
  channel: -6,
  seabed: -3,
  shore: 0,
  /** The terraced fields climbing to the village's hill, from the lowest. */
  field: 2,
  /** The smelter's terrace above the harbor town. */
  terrace: 3,
  /** The ground at the mesa's foot, round the ways up it. */
  foot: 5,
  fieldMid: 6,
  headland: 8,
  /** The railway's embankments and the deck of its bridge and viaduct. */
  rail: 10.2,
  fieldTop: 10,
  hill: 14,
  pass: 15,
  /** The dam's crest and the landing pad on top of it, 30 m over the lakebed. */
  dam: 16,
  /** The bluff over the dune coast's west side, above the high ground's usual top. */
  bluff: 26,
  /** The sandstone mesa's flat top, the relay mast on it. */
  mesa: 27.5,
  /** The floors of the nodes built on the open ground between the areas, each near the ground it was built on. */
  station: 3,
  waterworks: 2,
  lodge: 9,
  cannery: -3,
  coldstore: 1,
  /** The dried strait's bed, between the island and the machine city. */
  strait: -10,
  /** The machine city's streets: one paved floor east of the strait. */
  city: 4,
  /** The power plant's yard, east of the city on the ground between it and the coast, level with the streets. */
  powerplant: 4,
  /** The launch site's plateau west of the island, and the dry canyon's floor 25 m under it. */
  plateau: 8,
  canyon: -17,
  /** The control centre's sunk yard: one works storey under the plateau. */
  controlPit: 3.5,
  /** The island's ground at the east ends of the two crossings over the canyon. */
  canyonEast: 4,
} as const;

/** The dam's face: the cliff from the crest down to the lakebed, drawn as concrete. */
export const DAM_FACE = (x: number, z: number) => Math.abs(x - AREA.heart[0]) < 62 && z - AREA.heart[1] > -120 && z - AREA.heart[1] < -103;

/** A line written in an area's frame (areas.ts), in the world. */
const inArea = (a: AreaId, line: readonly P[]): P[] => line.map(([x, z]) => [x + AREA[a][0], z + AREA[a][1]] as const);
/** A line written in a POI's own frame, in the world. */
const inPoi = (p: PoiId, line: readonly P[]): P[] => line.map(([x, z]) => [x + POI_AT[p][0], z + POI_AT[p][1]] as const);

/** Basins: the POIs and the districts. Each holds everything built there, and is written in its area's frame. */
const BASINS: Open[] = [
  // The dune coast's works: a floor some 220 m across, its yards between the sheds flat, dunes
  // up to 13 m high piled against its east side, its south side and round the silos.
  {
    name: "補給所",
    line: inPoi("supply", [[-58, -55], [70, -55], [70, 0], [-58, 0], [-58, 60], [70, 60], [70, 0]]),
    half: 52,
    level: LEVEL.shore,
    ground: "dune",
    dunes: [
      { line: inPoi("supply", [[86, -70], [90, -12], [90, 36]]), half: 26, height: 13 },
      { line: inPoi("supply", [[-80, 72], [-40, 84], [0, 72], [16, 86]]), half: 24, height: 11 },
      { line: inPoi("supply", [[-104, -82], [-66, -98]]), half: 18, height: 7 },
    ],
  },
  // The bluff: a sand-capped tableland over the works' west side, a 26 m cliff to its floor.
  { name: "砂丘の崖", line: inPoi("supply", [[-140, -20], [-140, 50]]), half: 16, level: LEVEL.bluff, walled: true, ground: "dune" },
  // The lakebed: grey cracked mud 14 m under the shore, 150 m across, banks of mud piled up to 7 m
  // on it round the drowned town. Its north end is the straight foot of the dam.
  {
    name: "湖底",
    line: inArea("heart", [[0, -30], [0, 30]]),
    half: 75,
    level: LEVEL.lakebed,
    walled: true,
    ground: "mud",
    dunes: [
      { line: inArea("heart", [[-62, 48], [-34, 76]]), half: 16, height: 7 },
      { line: inArea("heart", [[46, 28], [58, 70]]), half: 15, height: 6 },
      { line: inArea("heart", [[34, -62], [58, -40]]), half: 12, height: 4 },
      { line: inArea("heart", [[-62, -64], [-56, -36]]), half: 12, height: 5 },
    ],
  },
  { name: "湖底", line: inArea("heart", [[-55, -75], [55, -75]]), half: 30, level: LEVEL.lakebed, walled: true, ground: "mud" },
  // The landing pad on top of the dam: a concrete plateau 245 by 135 m, 30 m over the lakebed and
  // 16 m over the ground round it, its south edge the dam's crest.
  { name: "発着場", line: inPoi("pad", [[-55, 0], [55, 0]]), half: 67, level: LEVEL.dam, walled: true, ground: "concrete" },
  { name: "堤", line: inArea("heart", [[-58, -121], [58, -121]]), half: 6, level: LEVEL.dam, walled: true, ground: "concrete" },
  // The plateau over the lakebed's west side: its east edge a clean drop into the lakebed.
  { name: "台地", line: inArea("heart", [[-118, -10], [-100, -10]]), half: 16, level: LEVEL.shore },
  // Small floors that hold the ground at the ends of ramps and of the bridge over the spillway.
  { name: "湖の南岸", line: inArea("heart", [[0, 152], [0, 166]]), half: 12, level: LEVEL.shore },
  { name: "東の岸", line: inArea("heart", [[120, -5], [132, -5]]), half: 10, level: LEVEL.shore },
  { name: "橋の西詰", line: inArea("heart", [[86, -92], [88, -92]]), half: 7, level: LEVEL.terrace },
  { name: "橋の東詰", line: inArea("heart", [[126, -92], [128, -92]]), half: 7, level: LEVEL.terrace },
  // The red quarry: a yard on the rim with the processing plant, and three terraces dug into the
  // bedrock, each 9 m under the last, down to its floor 25 m under the rim.
  { name: "採掘場の縁", line: inPoi("quarry", [[-10, -95], [60, -95]]), half: 24, level: LEVEL.shore, ground: "quarry" },
  { name: "採掘場の上段", line: inPoi("quarry", [[-55, 0], [55, 0]]), half: 70, level: LEVEL.quarryTop, walled: true, ground: "quarry" },
  { name: "採掘場の中段", line: inPoi("quarry", [[-50, 12], [30, 12]]), half: 46, level: LEVEL.quarryMid, walled: true, ground: "quarry" },
  { name: "採掘場", line: inPoi("quarry", [[-40, 18], [10, 18]]), half: 26, level: LEVEL.pit, walled: true, ground: "quarry" },
  // The sandstone mesa: a flat top 170 by 100 m, sheer cliffs 22 m down to its foot all round.
  { name: "中継塔", line: inPoi("relay", [[-35, 0], [35, 0]]), half: 50, level: LEVEL.mesa, walled: true, ground: "sandstone" },
  { name: "台地の麓", line: inPoi("relay", [[-120, 75], [-90, 75]]), half: 14, level: LEVEL.foot },
  { name: "西の麓", line: inPoi("relay", [[-112, -8], [-112, 8]]), half: 14, level: LEVEL.foot },
  { name: "駅前", line: inPoi("relay", [[-90, -80], [-90, -80]]), half: 14, level: LEVEL.foot },
  // The terraced fields stepping up the village's hill, 4 m a step: dry soil under sage-green scrub.
  { name: "段々畑", line: inArea("village", [[-40, 55], [70, 55]]), half: 22, level: LEVEL.field, ground: "scrub" },
  { name: "段々畑", line: inArea("village", [[-60, 15], [60, 15]]), half: 19, level: LEVEL.fieldMid, ground: "scrub" },
  { name: "段々畑", line: inArea("village", [[-60, -23], [50, -23]]), half: 21, level: LEVEL.fieldTop, ground: "scrub" },
  { name: "丘", line: inArea("village", [[-40, -65], [10, -65]]), half: 22, level: LEVEL.hill, ground: "scrub" },
  // The works and the housing beside them, on one oil-stained concrete floor.
  { name: "工場跡", line: inArea("factory", [[-60, 0], [60, 0]]), half: 75, level: LEVEL.shore, ground: "oiled" },
  // The harbor.
  { name: "港町", line: inArea("town", [[-40, -300], [110, -300]]), half: 22, level: LEVEL.shore , ground: "paved" },
  { name: "コンテナヤード", line: inPoi("yard", [[-44, 0], [44, 0]]), half: 42, level: LEVEL.shore , ground: "paved" },
  { name: "製錬所", line: inPoi("smelter", [[-34, 0], [40, 0]]), half: 34, level: LEVEL.terrace , ground: "paved" },
  { name: "塩田", line: inArea("bay", [[-60, -500], [80, -500]]), half: 40, level: LEVEL.seabed , ground: "salt" },
  { name: "難破船", line: inPoi("wreck", [[-84, -8], [78, -8]]), half: 22, level: LEVEL.seabed , ground: "salt" },
  { name: "埠頭", line: inArea("bay", [[60, -565], [140, -568]]), half: 22, level: LEVEL.seabed , ground: "paved" },
  { name: "水路", line: inArea("bay", [[96, -592], [162, -592]]), half: 8, level: LEVEL.channel, walled: true },
  { name: "岬", line: inArea("bay", [[-120, -545], [-106, -560]]), half: 13, level: LEVEL.headland, walled: true },
  // The nodes on the open ground between the areas: a yard pressed flat round each, the ground
  // between running out from it.
  { name: "観測所", line: inPoi("station", [[-20, 0], [20, 0]]), half: 36, level: LEVEL.station, ground: "scrub" },
  { name: "浄水場", line: inPoi("waterworks", [[-18, 0], [18, 0]]), half: 32, level: LEVEL.waterworks, ground: "concrete" },
  { name: "峠の宿舎", line: inPoi("lodge", [[-22, 0], [22, 0]]), half: 32, level: LEVEL.lodge, ground: "paved" },
  { name: "缶詰工場", line: inPoi("cannery", [[-22, 0], [22, 0]]), half: 46, level: LEVEL.cannery, ground: "paved" },
  { name: "冷凍倉庫", line: inPoi("coldstore", [[-20, 0], [20, 0]]), half: 34, level: LEVEL.coldstore, ground: "paved" },
  // The machine city: one asphalt floor from the strait's east cliff to the east coast.
  { name: "機械都市", line: inArea("city", [[0, -320], [0, 240]]), half: 120, level: LEVEL.city, ground: "asphalt" },
  // The power plant's yard, its long side along the coast.
  { name: "発電所", line: inPoi("powerplant", [[0, -78], [0, 84]]), half: 38, level: LEVEL.powerplant, ground: "concrete" },
  // The launch site's plateau: open rolling ground at its level, held there by the runway's apron
  // down its middle (its ground pale caliche, painted so by the view west of the canyon).
  { name: "滑走路", line: inArea("launch", [[-75, -215], [-75, 215]]), half: 30, level: LEVEL.plateau, ground: "concrete" },
  // The control centre's sunk yard round its block, a storey under the plateau.
  { name: "管制室の掘り込み", line: inPoi("control", [[-14, 0], [14, 0]]), half: 13, level: LEVEL.controlPit, walled: true, ground: "concrete" },
  // The ground at both ends of the two crossings over the canyon: the rail bridge's (from the quarry's
  // side) and the road cut's (from the terraced fields' side).
  { name: "引き込み線の東口", line: [[-470, 30], [-470, 30]], half: 9, level: LEVEL.canyonEast },
  { name: "鉄道橋の西詰", line: [[-674, 30], [-662, 30]], half: 8, level: LEVEL.plateau, ground: "caliche" },
  { name: "切り通しの東口", line: [[-498, -90], [-498, -90]], half: 9, level: LEVEL.canyonEast },
  { name: "切り通しの西口", line: [[-716, -90], [-716, -90]], half: 9, level: LEVEL.plateau, ground: "caliche" },
  // The top of the pass: a saddle between the peaks, with the harbor in view.
  { name: "峠", line: inArea("pass", [[-66, -214], [-54, -230]]), half: 9, level: LEVEL.pass },
];

/**
 * Roads between basins, 8 to 10 m wide, in the world's coordinates. Each area has two or three
 * of them; the lakebed has four ramps out and the spillway, and its cliffs make the choice of
 * road the choice of approach. Across the open ground between the areas a road is the way the
 * patrols walk rather than the only way: off it the ground runs on at its level.
 */
const ROADS: Open[] = [
  // Into the lakebed: from the south shore, from the plateau and from the east shore.
  { name: "湖への坂", line: inArea("heart", [[0, 152], [0, 108], [0, 98]]), half: 5, level: [LEVEL.shore, LEVEL.lakebed, LEVEL.lakebed], atPoints: true, walled: true, ground: "mud" },
  { name: "湖の西坂", line: inArea("heart", [[-105, -5], [-78, 25], [-68, 25]]), half: 5, level: [LEVEL.shore, LEVEL.lakebed, LEVEL.lakebed], atPoints: true, walled: true, ground: "mud" },
  { name: "東の坂", line: inArea("heart", [[68, -5], [78, -5], [116, -5]]), half: 5, level: [LEVEL.lakebed, LEVEL.lakebed, LEVEL.shore], atPoints: true, walled: true, ground: "mud" },
  // Out of the spillway's mouth east onto the ground, round the corner of its east wall.
  { name: "放水路の東口", line: [[124, -77], [136, -77]], half: 4, level: [3.2, 5], atPoints: true },
  // Down off the pad's west side, and on along the ground to the terraced fields.
  { name: "発着場の西坂", line: inArea("heart", [[-112, -170], [-120, -170], [-166, -170]]), half: 5, level: [LEVEL.dam, LEVEL.dam, LEVEL.field], atPoints: true, walled: true, ground: "concrete" },
  { name: "村への道", line: [[-166, -90], [-215, -95]], half: 5, level: LEVEL.field },
  // Up the dune coast's bluff from the works' south-west corner, round its south end and onto its top.
  { name: "崖への坂", line: inArea("supply", [[-98, 88], [-126, 100], [-152, 84], [-150, 56]]), half: 5, level: [LEVEL.shore, 11, 20, LEVEL.bluff], atPoints: true, walled: true, ground: "dune" },
  // The quarry's haul roads: from the rim yard down to the top terrace, along the top terrace's
  // south edge down to the middle one, along the middle one's north side to the floor; and the
  // tunnel, cut straight down from the top terrace's west end under the middle one to the floor.
  { name: "採掘場の運搬路", line: inPoi("quarry", [[50, -92], [75, -70], [68, -60]]), half: 5, level: [LEVEL.shore, LEVEL.quarryTop, LEVEL.quarryTop], atPoints: true, walled: true, ground: "quarry" },
  { name: "中段への坂", line: inPoi("quarry", [[40, 63], [-40, 63], [-40, 50]]), half: 5, level: [LEVEL.quarryTop, LEVEL.quarryMid, LEVEL.quarryMid], atPoints: true, walled: true, ground: "quarry" },
  { name: "底への坂", line: inPoi("quarry", [[20, -25], [-50, -25], [-45, 0]]), half: 5, level: [LEVEL.quarryMid, LEVEL.pit, LEVEL.pit], atPoints: true, walled: true, ground: "quarry" },
  { name: "採掘場の坑道", line: inPoi("quarry", [[-118, 25], [-68, 20], [-60, 20]]), half: 4, level: [LEVEL.quarryTop, LEVEL.pit, LEVEL.pit], atPoints: true, walled: true, ground: "quarry" },
  // Up the mesa: a road climbing the scree at its south foot, then a ledge cut into its south face
  // that turns onto the top at its south-west corner.
  { name: "台地への道", line: inPoi("relay", [[-100, 78], [40, 80], [55, 62]]), half: 5, level: [LEVEL.foot, 14, 14.5], atPoints: true },
  { name: "台地の坂", line: inPoi("relay", [[55, 62], [45, 52], [-50, 52], [-62, 40], [-55, 30]]), half: 5, level: [14.5, 15.5, 26, LEVEL.mesa, LEVEL.mesa], atPoints: true, walled: true, ground: "sandstone" },
  // The lane up through the terraced fields to the hill, sunk into each terrace it climbs.
  { name: "村の坂", line: inArea("village", [[65, 58], [62, 22], [55, -14], [15, -55]]), half: 4, level: [LEVEL.field, LEVEL.fieldMid, LEVEL.fieldTop, LEVEL.hill], atPoints: true, ground: "scrub" },
  // Over the mountains to the harbor: up from the landing pad to the saddle and down to the town.
  // Each ramp reaches the level of the basin it runs into at that basin's edge: one still
  // above it there would end in a cliff.
  { name: "峠道", line: [[-55, -165], [-62, -230], [-90, -350], [-96, -430], [-70, -520], [-57, -565]], half: 5, level: [LEVEL.dam, LEVEL.pass, LEVEL.pass, 8, LEVEL.shore, LEVEL.shore], atPoints: true },
  // The railway's embankment from the mesa's north-west foot north to the gorge, and on from the
  // gorge to the harbor, where it ends in a cliff and the viaduct carries the line on.
  { name: "鉄道の土手（南）", line: [[210, -50], [185, -110], [170, -150], [168, -336]], half: 5, level: [LEVEL.foot, 7.5, 9.6, LEVEL.rail], atPoints: true, walled: true },
  { name: "鉄道の土手（北）", line: [[168, -365], [168, -410]], half: 5, level: LEVEL.rail, walled: true },
  { name: "駅の坂", line: [[168, -396], [146, -418], [140, -436], [140, -456], [120, -505], [100, -555]], half: 5, level: [LEVEL.rail, 4, LEVEL.shore, LEVEL.shore, LEVEL.shore, LEVEL.shore], atPoints: true , ground: "paved" },
  // Under the viaduct: a road along the line from the station's foot past the town to the container yard.
  { name: "高架下", line: [[168, -428], [168, -615], [-80, -615], [-110, -650], [-150, -695]], half: 6, level: LEVEL.shore , ground: "paved" },
  { name: "西の道", line: [[-55, -570], [-114.5, -631], [-167, -690]], half: 5, level: LEVEL.shore , ground: "paved" },
  { name: "製錬所の坂", line: [[168, -615], [168, -712]], half: 5, level: [LEVEL.shore, LEVEL.terrace], atPoints: true , ground: "paved" },
  { name: "塩田への坂", line: [[20, -615], [2, -858]], half: 5, level: [LEVEL.shore, LEVEL.seabed], atPoints: true },
  { name: "ヤードの北道", line: [[-167, -740], [-108, -841], [-93, -866]], half: 5, level: [LEVEL.shore, LEVEL.seabed, LEVEL.seabed], atPoints: true },
  { name: "製錬所の北道", line: [[153, -762], [87, -866]], half: 5, level: [LEVEL.terrace, LEVEL.seabed], atPoints: true },
  { name: "岬の坂", line: inArea("bay", [[-92, -526], [-104, -538], [-112, -548]]), half: 5, level: [LEVEL.seabed, 3, LEVEL.headland], atPoints: true, walled: true },
  // A slipway from the quay down into the channel.
  { name: "斜路", line: inArea("bay", [[150, -570], [156, -583], [160, -590]]), half: 4, level: [LEVEL.seabed, LEVEL.channel, LEVEL.channel], atPoints: true, walled: true },
  // The high-rise district's ramp down from its plaza to the underground car park's shutter.
  { name: "地下駐車場の斜路", line: inPoi("highrise", [[-24, -44], [-24, -18]]), half: 3.5, level: [LEVEL.city, LEVEL.city - 4.5], atPoints: true, walled: true, ground: "asphalt" },
  // The launch site's ways over the canyon. The rail spur's embankment from the quarry's side up to
  // the rail bridge's east end (the deck carries it on, `CANYON_SPANS` in map.ts); and the road cut
  // from the terraced fields' side, sunk into the east bank down to the canyon's floor, across it
  // and up the west bank onto the plateau.
  { name: "引き込み線の土手", line: [[-478, 30], [-548, 30], [-568, 30]], half: 5, level: [LEVEL.canyonEast, LEVEL.plateau, LEVEL.plateau], atPoints: true, walled: true },
  { name: "切り通し", line: [[-505, -90], [-586, -90], [-628, -90], [-708, -90]], half: 5, level: [LEVEL.canyonEast, LEVEL.canyon, LEVEL.canyon, LEVEL.plateau], atPoints: true, walled: true, ground: "caliche" },
  // Down into the control centre's sunk yard from the plateau, on its south side.
  { name: "管制室の坂", line: inPoi("control", [[6, 42], [6, 13]]), half: 4, level: [LEVEL.plateau, LEVEL.controlPit], atPoints: true, walled: true, ground: "concrete" },
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

const SHELVES: Shelf[] = [];

/**
 * The spillway: from the lakebed's north-east corner it sinks to 2 m below the lakebed under
 * the canyon bridge, round the dam's east end, then climbs out of its canyon and up onto the
 * landing pad's east side.
 */
const CUTS: Cut[] = [
  {
    line: inArea("heart", [[65, -60], [100, -75], [112, -110], [118, -125], [125, -160], [126, -195], [114, -200]]),
    floor: 5,
    levels: [LEVEL.lakebed, -16, -16, -10, 4, LEVEL.dam, LEVEL.dam],
    slope: CLIFF,
    atPoints: true,
  },
  /**
   * The gorge the railway bridge crosses: a dry river bed from under the mountains,
   * past the bridge and out onto the harbor's plain at the station road. Walled by cliffs.
   */
  {
    line: [[116, -352], [166, -350], [196, -358], [204, -392], [178, -438], [142, -450]],
    floor: 4,
    levels: [-5, -6, -5, -3, LEVEL.shore, LEVEL.shore],
    slope: CLIFF,
    atPoints: true,
  },
  /**
   * The dried strait between the island and the machine city: an old sea bed walled by cliffs,
   * crossed by the rail and road bridges, rising at both ends to the ground, so whoever falls in
   * walks out there.
   */
  {
    line: [[598, -930], [606, -820], [612, -640], [600, -330], [590, 0], [582, 140], [578, 250]],
    floor: 30,
    levels: [LEVEL.shore, LEVEL.strait, LEVEL.strait, LEVEL.strait, LEVEL.strait, LEVEL.strait, LEVEL.shore],
    slope: CLIFF,
    atPoints: true,
  },
  /**
   * The dry canyon between the island and the launch site's plateau, 25 m under the plateau and
   * 40 m across its floor, running north to south from coast to coast. The rail bridge spans it and
   * the road cut climbs down into it and out. At each end it runs into the inlet where the two
   * lands' coasts meet, its floor rising there in a cliff as steep as its walls, so nothing walked
   * in it lies past the coast and no way round it is left on land.
   */
  {
    line: [[-588, -252], [-596, -238], [-606, -190], [-608, -90], [-606, 30], [-603, 150], [-598, 300], [-608, 345], [-614, 362]],
    floor: 20,
    levels: [55, LEVEL.canyon, LEVEL.canyon, LEVEL.canyon, LEVEL.canyon, LEVEL.canyon, LEVEL.canyon, LEVEL.canyon, 55],
    slope: CLIFF,
    atPoints: true,
  },
];

/** Open shapes and cuts with their lines worked out once: `lowest()` runs for every grid cell. */
const OPEN = [...BASINS, ...ROADS].map((o) => ({ o, poly: polyline(o.line), dunes: (o.dunes ?? []).map((dune) => ({ dune, poly: polyline(dune.line) })) }));
const CUT_LINES = CUTS.map((c) => ({ c, poly: polyline(c.line) }));

/** Each open shape's ground by its name (shapes sharing a name share their ground). */
const GROUNDS = new Map(OPEN.flatMap(({ o }) => (o.ground ? [[o.name, o.ground] as const] : [])));

/** The ground the shape named `name` is painted as (`surfaceAt()`'s answers), if it has its own. */
export const groundOf = (name: string): Ground | undefined => GROUNDS.get(name);

/** Grounds whose rock shows in the cliffs round their shapes: the quarry's red bedrock, the mesa's sandstone. */
const CLIFF_GROUNDS = new Set<Ground>(["quarry", "sandstone"]);

/**
 * The ground of a cliff at (x, z), for the renderer: that of the nearest shape within
 * `reach` metres of its edge whose rock shows in its cliffs (`CLIFF_GROUNDS`), if there is one.
 */
export function cliffGround(x: number, z: number, reach = 14): Ground | undefined {
  let best: Ground | undefined;
  let near = reach;
  for (const n of bucketAt(x, z).open) {
    const { o, poly } = OPEN[n];
    if (!o.ground || !CLIFF_GROUNDS.has(o.ground) || nearBox(x, z, poly) - o.half > near) continue;
    const d = Math.abs(toPolyline(x, z, poly).d - o.half);
    if (d < near) {
      near = d;
      best = o.ground;
    }
  }
  return best;
}

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
  // The reservoir's island: wider east to west, 1100 by 820 m.
  { name: "島", x: 0, z: 80, radius: (a) => (560 * 410) / hypot2(410 * Math.cos(a), 560 * Math.sin(a)) + 13.5 * Math.sin(3 * a + 1.1) + 8.4 * Math.sin(7 * a + 2.3) + 5 * Math.sin(13 * a + 0.4), max: 588 },
  // The dune coast, bulging south of the island round the supply depot: wider east to west.
  { name: "砂丘", x: 0, z: 470, radius: (a) => 230 * 175 / hypot2(175 * Math.cos(a), 230 * Math.sin(a)) + 6 * Math.sin(5 * a + 0.9) + 3 * Math.sin(11 * a + 2.1), max: 240 },
  // The mountain belt between the reservoir and the harbor, wider east to west.
  { name: "山地", x: 30, z: -350, radius: (a) => 150 + 60 * Math.abs(Math.cos(a)) + 6 * Math.sin(5 * a + 0.7), max: 216 },
  { name: "港湾", x: 0, z: -775, radius: (a) => 425 + 10 * Math.sin(3 * a + 0.5) + 7 * Math.sin(7 * a + 1.9) + 3.4 * Math.sin(11 * a + 0.3), max: 441 },
  // The east land: joined to the island's, the mountains' and the harbor's east coasts, cut through
  // north to south by the dried strait, the machine city on its far side. Taller than wide.
  { name: "東の陸", x: 740, z: -335, radius: (a) => (350 * 640) / hypot2(640 * Math.cos(a), 350 * Math.sin(a)) + 9 * Math.sin(5 * a + 0.4) + 5 * Math.sin(9 * a + 1.7), max: 655 },
  // The ground along the island's west coast that joins it to the launch site's plateau, the dry
  // canyon cut through it north to south.
  { name: "渓谷", x: -540, z: 80, radius: (a) => (140 * 330) / hypot2(330 * Math.cos(a), 140 * Math.sin(a)) + 3 * Math.sin(7 * a + 1.3), max: 334 },
  // The launch site's plateau west of the island: joined to the island's west coast, cut off from it
  // north to south by the dry canyon. Taller than wide.
  { name: "西の台地", x: -930, z: 20, radius: (a) => (400 * 560) / hypot2(560 * Math.cos(a), 400 * Math.sin(a)) + 8 * Math.sin(5 * a + 2.2) + 4 * Math.sin(11 * a + 0.6), max: 572 },
];

/** How far (x, z) lies outside one land mass's coast; negative inside it. */
export const outsideLand = (l: Land, x: number, z: number) => hypot2(x - l.x, z - l.z) - l.radius(Math.atan2(z - l.z, x - l.x));

/** How far (x, z) lies outside the coast, metres; negative on land, by how far inland. */
export function offshore(x: number, z: number): number {
  // Building the field asks each cell's point twice (its lowest shape, then the rim): the last
  // answer is kept for the next question.
  if (x === lastOff.x && z === lastOff.z) return lastOff.out;
  let out = Infinity;
  // A land whose coast cannot come nearer than the nearest yet changes nothing: the minimum is
  // the same as over every land, in any order.
  for (const l of LANDS) if (hypot2(x - l.x, z - l.z) - l.max < out) out = Math.min(out, outsideLand(l, x, z));
  lastOff.x = x;
  lastOff.z = z;
  lastOff.out = out;
  return out;
}
const lastOff = { x: NaN, z: NaN, out: 0 };

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
  { name: "山地", line: [[-460, -350], [-330, -340], [-230, -355], [-150, -342], [-80, -358], [0, -348], [70, -360], [150, -342], [230, -355], [330, -346], [460, -352]], half: 60 },
  // The reservoir.
  { name: "西の岩山", line: [[-189, 241], [-177, 253]], half: 19 },
  { name: "東の岩稜", line: [[470, 60], [480, 110]], half: 8 },
  { name: "南東の岩", line: [[440, 230], [450, 222]], half: 16 },
  { name: "北西の岩稜", line: [[-450, -60], [-420, -80]], half: 8 },
  { name: "湖の東の岩", line: [[175, 176], [185, 186]], half: 14 },
  { name: "北の岩山", line: [[-160, -260], [-140, -250]], half: 16 },
  { name: "南の岩", line: [[150, 530], [158, 524]], half: 10 },
  // North-east of the landing pad, clear of the fallen tether's east pieces.
  { name: "発着場の北の岩", line: [[118, -250], [128, -260]], half: 12 },
  { name: "西の岩塔", line: [[-205, -176], [-196, -186]], half: 12 },
  { name: "南西の岩", line: [[-156, 362], [-144, 354]], half: 12 },
  { name: "東の岩山", line: [[470, 180], [480, 192]], half: 15 },
  // The harbor.
  { name: "港の岩山", line: [[40, -750], [54, -760]], half: 18 },
  { name: "西の岩稜", line: [[-219, -812], [-196, -782]], half: 7 },
  { name: "東の岩", line: [[277, -745], [287, -735]], half: 16 },
  { name: "北の岩", line: [[204, -825], [212, -833]], half: 12 },
  { name: "西の道の岩", line: [[-233, -630], [-223, -638]], half: 12 },
  { name: "南の野の岩", line: [[-206, -476], [-194, -486]], half: 14 },
  { name: "東の岩塔", line: [[296, -996], [304, -1006]], half: 12 },
  // Cliffs over the far side of the channel: the water stays a waterfront along the quay.
  { name: "水路の崖", line: inArea("bay", [[76, -598], [92, -614], [190, -614]]), half: 13 },
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
    const { o, poly, dunes } = OPEN[n];
    const far = nearBox(x, z, poly) - o.half;
    if (far > FAR) {
      edge = Math.min(edge, far);
      continue;
    }
    const { d, along: t } = toPolyline(x, z, poly);
    const lv = levelOf(o, t, poly) + (dunes.length && d < o.half ? duneRise(dunes, o.half, x, z, d) : 0);
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

/**
 * The shaped ground before anything is flattened for buildings; `low` is `lowest(x, z)` when
 * already known. The high ground's top is capped near HIGH, and rises over a basin or road walked
 * above it (a bluff), so that its floor is not cut down to the cap; the ground between keeps the cap.
 */
function natural(x: number, z: number, low = lowest(x, z)): number {
  const top = HIGH + vnoise(x / 30, z / 30) * 5 + (low.shape < OPEN.length && low.level > HIGH - 1 ? low.level - HIGH + 3 : 0);
  return Math.min(top, low.h) + (vnoise(x / 9, z / 9) - 0.5) * 0.5;
}

/** The rim: cliffs rising beyond the coast, out to the horizon. */
function rim(x: number, z: number): number {
  const out = offshore(x, z);
  if (out <= 0) return 0;
  return Math.min(48, out * 2.2) * (0.8 + vnoise(x * 0.05, z * 0.05) * 0.4) + vnoise(x * 0.2, z * 0.2) * Math.min(out, 6);
}

/**
 * Craters where the ring's pieces came down: round the middle of each the ground is thrown up into a
 * rim from `r0` out to `r1`, highest (`high`, give or take a fifth) at `crest`, and cut back down to
 * the ground where `gaps` cross it (the direction each leaves the middle in, and half its width).
 * Added over the built field as the coast's rim is: what stands inside a crater keeps its own
 * level. The gaps keep the rim off the node's corridors and its rubble heap; the corners of its
 * yard rise with the rim.
 */
export const CRATERS: { name: string; x: number; z: number; r0: number; crest: number; r1: number; high: number; gaps: [number, number][] }[] = [
  {
    name: "環の結節点",
    x: 85,
    z: -1090,
    r0: 60,
    crest: 76,
    r1: 94,
    high: 5,
    gaps: [
      [Math.PI, 10],
      [Math.PI / 2, 10],
      [0, 9],
      [-Math.PI / 2 - 0.32, 8],
      [(3 * Math.PI) / 4, 7],
      [-Math.PI / 4, 7],
    ],
  },
];

function crater(x: number, z: number): number {
  let out = 0;
  for (const c of CRATERS) {
    const [dx, dz] = [x - c.x, z - c.z];
    const d = hypot2(dx, dz);
    if (d <= c.r0 || d >= c.r1) continue;
    const up = d < c.crest ? smooth(c.r0, c.crest, d) : 1 - smooth(c.crest, c.r1, d);
    const a = Math.atan2(dz, dx);
    let kept = 1;
    for (const [g, w] of c.gaps) if (Math.cos(a - g) > 0) kept = Math.min(kept, smooth(w, w + 9, Math.abs(d * Math.sin(a - g))));
    out += c.high * up * kept * (0.8 + vnoise(x * 0.08, z * 0.08) * 0.4);
  }
  return out;
}

/** Grid points of the cached field on each axis, from the world's corner (x0, z0). */
const NX = Math.round((WORLD.x1 - WORLD.x0) / RES) + 1;
const NZ = Math.round((WORLD.z1 - WORLD.z0) / RES) + 1;
let field: Float32Array | null = null;
let steep: Uint8Array | null = null;
let floors: Float32Array | null = null;
let shapes: Uint8Array | null = null;
/** The level the ground at each grid point was built to: a hand-built thing's, or the floor's, with a crater's rim on it. */
let bases: Float32Array | null = null;


export interface FlatShape {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** The level it stands on. Left out, the ground under it follows the walkable floor, ramps included. */
  y?: number;
  /** Ground built to be walked at its level however far over the floor round it (an outpost's yard), not high ground. */
  walked?: true;
}

/**
 * Builds the cached field. `flat` is everything placed by hand: within 3 m of any
 * of it the ground is exactly at its level, and the shapes blend back in over the
 * next 7 m. Shapes standing below their level (the canyon bridge's pillars) are not given.
 */
/**
 * Where a built field may be kept between processes: the sim gate's Node scripts give one
 * (scripts/ringfall-terrain-store.ts), keyed by the flat shapes and the sim's own source, so
 * each worker reads the field the first one built; the browser has none and builds it.
 */
export interface TerrainStore {
  load(flat: FlatShape[]): TerrainArrays | null;
  save(flat: FlatShape[], built: TerrainArrays): void;
}
/** What `buildTerrain()` leaves behind, as the store keeps it. */
export interface TerrainArrays {
  field: Float32Array;
  floors: Float32Array;
  shapes: Uint8Array;
  bases: Float32Array;
  steep: Uint8Array;
  between: Float32Array;
}
let store: TerrainStore | null = null;
/** Sets the store `buildTerrain()` reads and writes; called before the map is loaded. */
export const useTerrainStore = (s: TerrainStore) => {
  store = s;
};

export function buildTerrain(flat: FlatShape[]) {
  const kept = store?.load(flat);
  if (kept && kept.field.length === NX * NZ && kept.between.length === BNX * BNZ) {
    ({ field, floors, shapes, bases, steep } = kept);
    betweenField = kept.between;
    return;
  }
  build(flat);
  store?.save(flat, { field: field!, floors: floors!, shapes: shapes!, bases: bases!, steep: steep!, between: betweenGrid() });
}

function build(flat: FlatShape[]) {
  // Distance from each grid point to the nearest flat shape, and that shape's level,
  // by a two-pass chamfer.
  const dist = new Float32Array(NX * NZ).fill(1e9);
  const at = new Float32Array(NX * NZ);
  // For a shape with no level of its own: the level of the ground at its middle.
  const mid = new Float32Array(NX * NZ);
  // And the shape there, so that a floor rising over dunes is followed rather than terraced.
  const midShape = new Int32Array(NX * NZ);
  // And whether that shape is ground to walk (`FlatShape.walked`).
  const walked = new Uint8Array(NX * NZ);
  for (const b of flat) {
    const y = b.y ?? NaN;
    const ml = lowest((b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2);
    const m = ml.level;
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
        midShape[j * NX + i] = ml.shape;
        walked[j * NX + i] = b.walked ? 1 : 0;
      }
  }
  const D = RES;
  const DD = RES * Math.SQRT2;
  const relax = (k: number, from: number, step: number) => {
    if (dist[from] + step < dist[k]) {
      dist[k] = dist[from] + step;
      at[k] = at[from];
      mid[k] = mid[from];
      midShape[k] = midShape[from];
      walked[k] = walked[from];
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
  bases = new Float32Array(NX * NZ);
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
      // On one floor with dunes the floor is followed: its sand rises and falls within the one shape.
      const dunes = low.shape === midShape[k] && low.shape < OPEN.length && OPEN[low.shape].dunes.length > 0;
      const level = !Number.isNaN(at[k]) ? at[k] : Math.abs(floors[k] - mid[k]) > 2 && !dunes ? mid[k] : floors[k];
      // Shelves stand right up to hand-built things (a 1 m gap); other shapes leave them room to blend.
      const dd = dist[k];
      let shelf = -Infinity;
      for (const n of bucketAt(x, z).shelves) shelf = Math.max(shelf, shelfAt(n, x, z));
      const base = level + (natural(x, z, low) - level) * smooth(3, 10, dd);
      const thrown = crater(x, z);
      field[k] = (shelf > base ? base + (shelf - base) * smooth(1, 2, dd) : base) + rim(x, z) + thrown;
      bases[k] = (walked[k] ? level + (floors[k] - level) * smooth(3, 10, dd) : floors[k]) + thrown;
    }
  steep = new Uint8Array(NX * NZ);
  for (let j = 1; j < NZ - 1; j++)
    for (let i = 1; i < NX - 1; i++) {
      const gx = (field[j * NX + i + 1] - field[j * NX + i - 1]) / (2 * RES);
      const gz = (field[(j + 1) * NX + i] - field[(j - 1) * NX + i]) / (2 * RES);
      // A cell is a cliff when the ground rises steeply across it or onto a neighbour.
      const up = Math.max(Math.abs(gx), Math.abs(gz), hypot2(gx, gz));
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
const carved = new Map<number, { field: number; floor: number; base: number; shape: number; steep: number }>();

/**
 * Puts exactly `carves` into the field, taking out any cut before. The field built by
 * `buildTerrain()` stays the one with nothing carved, so a world with every route closed is
 * the same ground cell for cell. Only the cached field changes: `lowest()` keeps answering for
 * the ground as built, so the leap's glide treats a route's roof as the high
 * ground it covers.
 */
export function carveTerrain(carves: readonly Carve[]) {
  if (!field || !floors || !bases || !shapes || !steep) throw new Error("carveTerrain before buildTerrain");
  for (const [k, v] of carved) {
    field[k] = v.field;
    floors[k] = v.floor;
    bases[k] = v.base;
    shapes[k] = v.shape;
    steep[k] = v.steep;
  }
  carved.clear();
  const save = (k: number) => {
    if (!carved.has(k)) carved.set(k, { field: field![k], floor: floors![k], base: bases![k], shape: shapes![k], steep: steep![k] });
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
        bases[k] = at.level;
        shapes[k] = shape;
      }
    // Cliffs over again where the trench changed the slope, one cell round it included.
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const k = j * NX + i;
        const gx = (field[k + 1] - field[k - 1]) / (2 * RES);
        const gz = (field[k + NX] - field[k - NX]) / (2 * RES);
        const s = Math.max(Math.abs(gx), Math.abs(gz), hypot2(gx, gz)) > STEEP ? 1 : 0;
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

/**
 * The level the ground at (x, z) was built to: the floor's (`floorLevel`), or a yard's built to be
 * walked (`FlatShape.walked`) blending back to the floor round it, with a crater's rim thrown up on it.
 */
export function baseLevel(x: number, z: number): number {
  const i = Math.round((x - WORLD.x0) / RES);
  const j = Math.round((z - WORLD.z0) / RES);
  if (!bases || i < 0 || j < 0 || i >= NX || j >= NZ) return floorLevel(x, z);
  return bases[j * NX + i];
}

/** Ground well over the level it was built to: the crags, the coast's rim, the land's edges. A yard built to be walked over the floor round it, or a crater's rim, is not. */
export const highGround = (x: number, z: number) => terrainHeight(x, z) > baseLevel(x, z) + 2;

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
  const n = hypot2(gx, gz) || 1;
  return { x: -gx / n, z: -gz / n };
}
