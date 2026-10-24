import { FRONT, VAULT, WORLD, ZIP, type EnemyKind, type HealKind, type Rarity, type ToolKind, type ValuableKind, type WeaponKind } from "./config";
import { AREA, inArea, POI_AT, type AreaId } from "./areas";
import { LENGTHS, offStreet, STREETS } from "./streets";
import { layZips, type ZipLine } from "./ziplayout";
import { buildTerrain, type Carve, type FlatShape, floorLevel, highGround, LEVEL, offshore, roadLine, steepAt, surfaceAt, terrainHeight } from "./terrain";

/**
 * The world: two regions, a dried-up reservoir in the south and a dry harbor in the
 * north, joined by a pass road and a railway (see terrain.ts for their levels).
 * Everything solid is an axis-aligned box, so collision, line of sight and standing on
 * top are all the same cheap test (a fence stops only bodies). North is -z. The player chooses the region to start
 * in; every POI, district and way off in both regions is open from the start.
 *
 * Boxes and points are written relative to the ground of their area and lifted to
 * its level here, so a building reads the same on the lakebed as on the mesa.
 */

/**
 * `steel` is painted plate: ship hulls, cranes, girders, carriages (its tint picks the paint).
 * `fence` is a fence or gate of steel bars: it stops a body but not a look or a shot (`rayWorld()`).
 * `prop` is a piece of the cover scattered over the open ground, or of the camp's furniture; its tint is what it is (`PROP`).
 */
export type BoxKind = "crate" | "container" | "wall" | "rock" | "pad" | "tower" | "slab" | "step" | "steel" | "fence" | "prop";

/** What a `prop` box is, by its tint: the renderer draws each as that thing. */
export const PROP = { pallets: 0, sandbags: 1, barrier: 2, cab: 3, bed: 4, car: 5, rubble: 6, tarp: 7, table: 8, board: 9, shelf: 10, counter: 11, bench: 12, bedroll: 13 } as const;

/** A solid spanning y0..h. Floors, roofs and bridges have y0 > 0 and leave open space below. */
export interface Box {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  y0: number;
  h: number;
  kind: BoxKind;
  tint: number; // index into the renderer's palette for this kind
}

const box = (cx: number, cz: number, w: number, d: number, h: number, kind: BoxKind, tint = 0, y0 = 0): Box => ({
  x0: cx - w / 2,
  z0: cz - d / 2,
  x1: cx + w / 2,
  z1: cz + d / 2,
  y0,
  h,
  kind,
  tint,
});

const rect = (x0: number, z0: number, x1: number, z1: number, y0: number, h: number, kind: BoxKind, tint = 0): Box => ({ x0, z0, x1, z1, y0, h, kind, tint });

/** n = -z, s = +z, e = +x, w = -x. */
type Side = "n" | "s" | "e" | "w";
const DIR: Record<Side, [number, number]> = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] };
const SIDES: Side[] = ["n", "s", "e", "w"];

/** Height of one storey; floors and roofs sit at multiples of it. */
const STOREY = 3.4;
const WALL = 0.35;
const STEP_DEPTH = 0.55;

/**
 * The sizes a building is built to: storey height, wall thickness, doors (width and head),
 * windows (width, sill, head), the height of roller doors and the width of stair flights.
 * Most of the world is built to `HOUSE`; a POI built at the scale of real industry (`WORKS`)
 * passes its own to the helpers below.
 */
interface Scale {
  storey: number;
  wall: number;
  door: number;
  doorHead: number;
  window: number;
  sill: number;
  windowHead: number;
  roller: number;
  stair: number;
}
const HOUSE: Scale = { storey: STOREY, wall: WALL, door: 2.2, doorHead: 2.5, window: 1.4, sill: 1.1, windowHead: 2.1, roller: 4.4, stair: 1.4 };
/** Industrial scale: storeys of 4.5 m, half-metre walls, doors 2.4 by 3 m (a heavy, 2.2 m across and 2.9 m tall, walks through), roller doors 6 m high. */
const WORKS: Scale = { storey: 4.5, wall: 0.5, door: 2.4, doorHead: 3.0, window: 2.0, sill: 1.2, windowHead: 2.8, roller: 6, stair: 1.8 };
/** Homes and farms built to the scale of real ones: storeys of 3.2 m, doors 2.2 by 2.4 m, larger windows. */
const HOME: Scale = { storey: 3.2, wall: 0.3, door: 2.2, doorHead: 2.4, window: 1.6, sill: 1.0, windowHead: 2.3, roller: 4.5, stair: 1.4 };
/** The dam's intake tower: storeys of 5 m, six of them from the lakebed to the crest. */
const INTAKE: Scale = { ...WORKS, storey: 5 };
/** Steps a flight needs to climb `rise` with every riser under the step-up height. */
const stepsFor = (rise: number) => Math.ceil(rise / 0.42) - 1;

/**
 * Steps from a lower level (`base`, 0 = the ground) up to a platform edge at height
 * `top`. (ex, ez) is the centre of the edge; the stairs run away from it toward
 * `away`. Each riser is at most 0.42 m, under the step-up height, so they are
 * walked, not jumped.
 */
function stairs(ex: number, ez: number, away: Side, width: number, top: number, tint = 0, base = 0): Box[] {
  const rise = top - base;
  const n = stepsFor(rise);
  const [dx, dz] = DIR[away];
  const out: Box[] = [];
  for (let k = 0; k < n; k++) {
    const h = base + (rise * (n - k)) / (n + 1);
    const c = (k + 0.5) * STEP_DEPTH;
    if (dz !== 0) out.push(box(ex, ez + dz * c, width, STEP_DEPTH, h, "step", tint));
    else out.push(box(ex + dx * c, ez, STEP_DEPTH, width, h, "step", tint));
  }
  return out;
}

/**
 * The four walls of one storey between heights y0 and y1, with doors and pairs of windows cut
 * into the named sides, sized by `sc` (`HOUSE`: 2.2 m doors 2.5 m tall, windows from 1.1 m to 2.1 m).
 */
function walls(cx: number, cz: number, w: number, d: number, y0: number, y1: number, doors: Side[] = [], windows: Side[] = [], sc: Scale = HOUSE): Box[] {
  const WALL = sc.wall;
  const out: Box[] = [];
  for (const side of SIDES) {
    const alongX = side === "n" || side === "s";
    const len = alongX ? w : d;
    const holes: { a: number; b: number; door: boolean }[] = [];
    if (doors.includes(side)) holes.push({ a: -sc.door / 2, b: sc.door / 2, door: true });
    if (windows.includes(side)) {
      const off = doors.includes(side) ? len * 0.32 : len * 0.25;
      for (const sg of [-1, 1]) holes.push({ a: sg * off - sc.window / 2, b: sg * off + sc.window / 2, door: false });
    }
    holes.sort((p, q) => p.a - q.a);
    // Wall piece spanning [a, b] along the side, from height lo to hi.
    const piece = (a: number, b: number, lo: number, hi: number) => {
      const mid = (a + b) / 2;
      const span = b - a;
      if (span <= 0.01 || hi - lo <= 0.01) return;
      const [x, z] = alongX ? [cx + mid, side === "n" ? cz - d / 2 + WALL / 2 : cz + d / 2 - WALL / 2] : [side === "w" ? cx - w / 2 + WALL / 2 : cx + w / 2 - WALL / 2, cz + mid];
      out.push(alongX ? box(x, z, span, WALL, hi, "wall", 0, lo) : box(x, z, WALL, span, hi, "wall", 0, lo));
    };
    let cur = -len / 2;
    for (const hole of holes) {
      piece(cur, hole.a, y0, y1);
      if (hole.door) piece(hole.a, hole.b, y0 + sc.doorHead, y1);
      else {
        piece(hole.a, hole.b, y0, y0 + sc.sill);
        piece(hole.a, hole.b, y0 + sc.windowHead, y1);
      }
      cur = hole.b;
    }
    piece(cur, len / 2, y0, y1);
  }
  return out;
}

/** A 0.7 m wall around a roof at height H, leaving `open` sides free (stairs, bridges). */
function parapet(cx: number, cz: number, w: number, d: number, H: number, open: Side[] = []): Box[] {
  const out: Box[] = [];
  for (const side of SIDES) {
    if (open.includes(side)) continue;
    if (side === "n") out.push(box(cx, cz - d / 2 + 0.12, w, 0.25, H + 0.7, "wall", 1, H));
    if (side === "s") out.push(box(cx, cz + d / 2 - 0.12, w, 0.25, H + 0.7, "wall", 1, H));
    if (side === "e") out.push(box(cx + w / 2 - 0.12, cz, 0.25, d, H + 0.7, "wall", 1, H));
    if (side === "w") out.push(box(cx - w / 2 + 0.12, cz, 0.25, d, H + 0.7, "wall", 1, H));
  }
  return out;
}

/** A floor slab from y0 to h over [x0, x1] x [z0, z1] with a rectangular hole (a stairwell). */
function slabWithHole(x0: number, z0: number, x1: number, z1: number, y0: number, h: number, hx0: number, hz0: number, hx1: number, hz1: number): Box[] {
  const pieces = [rect(x0, z0, hx0, z1, y0, h, "slab"), rect(hx1, z0, x1, z1, y0, h, "slab"), rect(hx0, z0, hx1, hz0, y0, h, "slab"), rect(hx0, hz1, hx1, z1, y0, h, "slab")];
  return pieces.filter((p) => p.x1 - p.x0 > 0.01 && p.z1 - p.z0 > 0.01);
}

interface BuildingOpts {
  doors?: Side[];
  windows?: Side[];
  /** Outside stairs to the roof, at the corner of this side. */
  roof?: Side;
  /** Roof parapet sides left open besides the stairs', where a bridge lands. */
  open?: Side[];
  scale?: Scale;
}

/**
 * A one-room building of height H: walls with door and window openings, a flat roof
 * slab, a low parapet around the roof, and optional outside stairs up to it.
 */
function building(cx: number, cz: number, w: number, d: number, H: number, o: BuildingOpts = {}): Box[] {
  const sc = o.scale ?? HOUSE;
  const out = walls(cx, cz, w, d, 0, H - 0.3, o.doors, o.windows, sc);
  out.push(box(cx, cz, w, d, H, "slab", 0, H - 0.3));
  out.push(...parapet(cx, cz, w, d, H, [...(o.roof ? [o.roof] : []), ...(o.open ?? [])]));
  if (o.roof) out.push(...roofStairs(cx, cz, w, d, H, o.roof, sc.stair));
  return out;
}

/** Outside stairs up to a roof at height H, against the corner of side `r`, running away from the wall. */
function roofStairs(cx: number, cz: number, w: number, d: number, H: number, r: Side, width: number): Box[] {
  const inset = width / 2 + 0.3;
  if (r === "n" || r === "s") return stairs(cx + w / 2 - inset, r === "n" ? cz - d / 2 : cz + d / 2, r, width, H);
  return stairs(r === "e" ? cx + w / 2 : cx - w / 2, cz + d / 2 - inset, r, width, H);
}

interface TowerOpts {
  /** Doors per storey, from the ground floor up. */
  doors?: Side[][];
  windows?: Side[][];
  /** Roof parapet sides left open, where a bridge lands. */
  open?: Side[];
  /** A second stair core at the west end, its flights climbing east: a long building climbed from either end. */
  twin?: true;
  scale?: Scale;
}

/** A floor slab with rectangular holes ([x0, z0, x1, z1] each, apart along x, in order). */
function slabWithHoles(x0: number, z0: number, x1: number, z1: number, y0: number, h: number, holes: [number, number, number, number][]): Box[] {
  const out: Box[] = [];
  let cur = x0;
  for (const [hx0, hz0, hx1, hz1] of holes) {
    out.push(rect(cur, z0, hx0, z1, y0, h, "slab"), rect(hx0, z0, hx1, hz0, y0, h, "slab"), rect(hx0, hz1, hx1, z1, y0, h, "slab"));
    cur = hx1;
  }
  out.push(rect(cur, z0, x1, z1, y0, h, "slab"));
  return out.filter((p) => p.x1 - p.x0 > 0.01 && p.z1 - p.z0 > 0.01);
}

/**
 * A building of several storeys with stairs inside up to every floor and the roof.
 * Each flight climbs westward along the north wall on even storeys and along the
 * south wall on odd ones, under a stairwell in the slab above; enter it at its
 * east end. A door on the north wall of an even storey (south wall of an odd one)
 * would open onto the flight, so doors go on the other sides. Needs w >= 8, d >= 7.
 */
function tower(cx: number, cz: number, w: number, d: number, floors: number, o: TowerOpts = {}): Box[] {
  const sc = o.scale ?? HOUSE;
  const { storey: STOREY, wall: WALL, stair } = sc;
  const x0 = cx - w / 2;
  const x1 = cx + w / 2;
  const z0 = cz - d / 2;
  const z1 = cz + d / 2;
  const n = stepsFor(STOREY);
  const sx1 = x1 - WALL - 0.4;
  const sx0 = sx1 - n * STEP_DEPTH;
  const out: Box[] = [];
  for (let k = 0; k < floors; k++) {
    const base = k * STOREY;
    const top = base + STOREY;
    out.push(...walls(cx, cz, w, d, base, top - 0.3, o.doors?.[k], o.windows?.[k], sc));
    const [za, zb] = k % 2 === 0 ? [z0 + WALL, z0 + WALL + stair] : [z1 - WALL - stair, z1 - WALL];
    for (let j = 0; j < n; j++) {
      const x = sx1 - (j + 0.5) * STEP_DEPTH;
      out.push(rect(x - STEP_DEPTH / 2, za, x + STEP_DEPTH / 2, zb, base, base + (STOREY * (j + 1)) / (n + 1), "step"));
    }
    if (o.twin) {
      const tx0 = x0 + WALL + 0.4;
      for (let j = 0; j < n; j++) {
        const x = tx0 + (j + 0.5) * STEP_DEPTH;
        out.push(rect(x - STEP_DEPTH / 2, za, x + STEP_DEPTH / 2, zb, base, base + (STOREY * (j + 1)) / (n + 1), "step"));
      }
      out.push(...slabWithHoles(x0, z0, x1, z1, top - 0.3, top, [[tx0, za, tx0 + n * STEP_DEPTH, zb], [sx0, za, sx1, zb]]));
    } else out.push(...slabWithHole(x0, z0, x1, z1, top - 0.3, top, sx0, za, sx1, zb));
  }
  out.push(...parapet(cx, cz, w, d, floors * STOREY, o.open));
  return out;
}

/**
 * A tall landmark: `floors` storeys with doors on the south and east of the ground
 * floor and windows all round above, a supply bin on the top floor.
 */
function highRise(cx: number, cz: number, w: number, d: number, floors: number, scale: Scale = HOUSE): Box[] {
  const windows: Side[][] = [["w"]];
  for (let k = 1; k < floors; k++) windows.push(["n", "s", "e", "w"]);
  return tower(cx, cz, w, d, floors, { doors: [["s", "e"]], windows, scale });
}

/** The harbor's lighthouse on its headland, in the bay's frame: the highest view over the harbor. */
const LIGHTHOUSE = { x: -116, z: -553, floors: 7 } as const;

/** The landing pad's control tower, in the pad's frame (190 m north of the heart's). */
const PAD_TOWER = { x: -100, z: 40, floors: 5 } as const;

/**
 * The tether's anchor, in the anchor's frame (areas.ts), its heights over the landing pad's
 * (LEVEL.dam). The plinth is a stepped round of radius `r`, its top a little over the pad's
 * so the pad's ground never shows through it, walked onto from the pad's north edge; its sides go
 * down to `foot`, under the lowest ground round it. On it the clamp ring, of radius `ring`
 * and a storey high, and in that the shaft: `shaft` metres either side of the middle, walls `wall`
 * thick, a scaffold of `floors` storeys inside up to the gallery, and broken off far above.
 */
const ANCHOR = { r: 42, top: 0.3, foot: -12, ring: 22, ringTop: 3.7, shaft: 11, wall: 1.5, floors: 9 } as const;
/** The floor of the shaft's gallery, where its scaffold ends: windows all round, the highest view over the pad. */
const ANCHOR_GALLERY = ANCHOR.ringTop + ANCHOR.floors * STOREY;
/** A bin in the anchor's frame at height `y` over the pad, as EXTRA_BINS writes it (over the floor under it). */
const anchorBin = (fx: number, fz: number, y: number) => {
  const [x, z] = inArea("anchor", fx, fz);
  return { x, z, y: LEVEL.dam + y - floorLevel(x, z) };
};

/**
 * Tall buildings: where they stand in their area's frame, their size, storeys and scale. Their
 * top-floor bins (in EXTRA_BINS) hold the flares that call the plateau pickup.
 */
const HIGH_RISES = (
  [
    { x: -25, z: -14, w: 8, d: 8, floors: 6, level: LEVEL.lakebed, area: "heart", sc: HOUSE }, // the drowned town's church spire (heartTown() puts its steeple on top)
    { x: PAD_TOWER.x, z: PAD_TOWER.z - 190, w: 10, d: 10, floors: PAD_TOWER.floors, level: LEVEL.dam, area: "heart", sc: WORKS }, // the pad's control tower (pad() puts its cab on top)
    { x: -30, z: -55, w: 10, d: 10, floors: 4, level: LEVEL.quarryTop, area: "quarry", sc: WORKS }, // the quarry office on its top terrace
    { x: -25, z: -20, w: 14, d: 12, floors: 4, level: LEVEL.mesa, area: "relay", sc: WORKS }, // the relay's equipment block
    { x: -15, z: 45, w: 30, d: 12, floors: 5, level: LEVEL.shore, area: "factory", sc: HOME }, // a block of flats by the works
  ] as const
).map((h) => {
  const [x, z] = inArea(h.area, h.x, h.z);
  return { ...h, x, z };
});

/** A walkway slab whose top is at height y. */
const bridge = (x0: number, z0: number, x1: number, z1: number, y: number): Box => rect(x0, z0, x1, z1, y - 0.3, y, "slab", 1);

/** Moves boxes authored in a district's own frame into place. */
const place = (dx: number, dz: number, boxes: Box[]): Box[] => boxes.map((b) => ({ ...b, x0: b.x0 + dx, x1: b.x1 + dx, z0: b.z0 + dz, z1: b.z1 + dz }));

/** Moves boxes written in an area's frame (areas.ts) into place. */
const placeIn = (a: AreaId, boxes: Box[]): Box[] => place(AREA[a][0], AREA[a][1], boxes);

/** A point written in an area's frame, moved into place. */
const at = <T extends { x: number; z: number }>(a: AreaId, q: T): T => ({ ...q, x: q.x + AREA[a][0], z: q.z + AREA[a][1] });

/** Raises boxes by `dy`: a building stood on a deck or a roof. */
const lift = (dy: number, boxes: Box[]): Box[] => boxes.map((b) => ({ ...b, y0: b.y0 + dy, h: b.h + dy }));

/** Repaints the boxes of one kind that `which` picks (a ship's walls as steel plate, a lighthouse's bands). */
const paint = (boxes: Box[], from: BoxKind, kind: BoxKind, tint: (b: Box) => number, which: (b: Box) => boolean = () => true): Box[] =>
  boxes.map((b) => (b.kind === from && which(b) ? { ...b, kind, tint: tint(b) } : b));

/** A hole in a wall: `at` metres along its side from the side's middle, `w` wide, from `sill` up to `head` over the wall's foot. */
interface Hole {
  side: Side;
  at?: number;
  w: number;
  head: number;
  sill?: number;
}

/**
 * Four walls between heights y0 and y1 round (cx, cz) with any holes cut into them: the
 * general form of `walls()`, for roller doors and long bands of windows.
 */
function shell(cx: number, cz: number, w: number, d: number, y0: number, y1: number, holes: Hole[], kind: BoxKind = "wall", tint = 0, WALL = HOUSE.wall): Box[] {
  const out: Box[] = [];
  for (const side of SIDES) {
    const alongX = side === "n" || side === "s";
    const len = alongX ? w : d;
    const piece = (a: number, b: number, lo: number, hi: number) => {
      const span = b - a;
      if (span <= 0.01 || hi - lo <= 0.01) return;
      const mid = (a + b) / 2;
      const [x, z] = alongX ? [cx + mid, side === "n" ? cz - d / 2 + WALL / 2 : cz + d / 2 - WALL / 2] : [side === "w" ? cx - w / 2 + WALL / 2 : cx + w / 2 - WALL / 2, cz + mid];
      out.push(alongX ? box(x, z, span, WALL, hi, kind, tint, lo) : box(x, z, WALL, span, hi, kind, tint, lo));
    };
    let cur = -len / 2;
    for (const h of holes.filter((q) => q.side === side).sort((p, q) => (p.at ?? 0) - (q.at ?? 0))) {
      const a = Math.max(-len / 2, (h.at ?? 0) - h.w / 2);
      const b = Math.min(len / 2, (h.at ?? 0) + h.w / 2);
      piece(cur, a, y0, y1);
      piece(a, b, y0, y0 + (h.sill ?? 0));
      piece(a, b, Math.min(y1, y0 + h.head), y1);
      cur = b;
    }
    piece(cur, len / 2, y0, y1);
  }
  return out;
}

interface HallOpts {
  /** Roller doors, as high as the scale's `roller` (tall enough for a truck, and for anything tall to see in), `w` wide (default 0.6 m more than high), at `at` metres along their side from its middle. */
  doors?: { side: Side; at?: number; w?: number }[];
  /** Plain doors, as the scale's. */
  hatches?: { side: Side; at?: number }[];
  /** Sides with a band of high windows, out of reach from the floor: light in, a view out from the mezzanines. */
  windows?: Side[];
  /**
   * Mezzanines: a slab `depth` metres deep along the inside of `side`, its top at `y`, railed
   * along its open edge, with a flight up from the floor at `stair` metres along it from its middle.
   */
  mezz?: { side: Side; depth: number; y: number; stair?: number; from?: number; to?: number }[];
  /** Two rows of columns along the hall's length, this far apart along it. */
  columns?: number;
  /** Roof parapet sides left open (a bridge, a stair tower beside it). */
  open?: Side[];
  /** Walls as painted plate (a shed of corrugated steel) of this tint, rather than concrete. */
  steel?: number;
  /** Outside stairs up to the roof, at the corner of this side (as `building()`'s). */
  roof?: Side;
  scale?: Scale;
}

/** A mezzanine along the inside of one wall of a shed `w` by `d` round (cx, cz), as `HallOpts.mezz` writes it, with its flight `stair` wide. */
type Mezz = NonNullable<HallOpts["mezz"]>[number];
function mezzanine(cx: number, cz: number, w: number, d: number, WALL: number, m: Mezz, sw: number): Box[] {
  const out: Box[] = [];
  const x0 = cx - w / 2 + WALL;
  const x1 = cx + w / 2 - WALL;
  const z0 = cz - d / 2 + WALL;
  const z1 = cz + d / 2 - WALL;
  const alongX = m.side === "n" || m.side === "s";
  const half = (alongX ? x1 - x0 : z1 - z0) / 2;
  const from = m.from ?? -half;
  const to = m.to ?? half;
  // The slab, its edge rail (open over the stairs' landing), and the flight up into the hall.
  const [a0, a1] = alongX ? [cx + from, cx + to] : [cz + from, cz + to];
  const edge = m.side === "n" ? z0 + m.depth : m.side === "s" ? z1 - m.depth : m.side === "w" ? x0 + m.depth : x1 - m.depth;
  const inner = m.side === "n" || m.side === "w" ? 1 : -1;
  if (alongX) out.push(rect(a0, Math.min(edge, m.side === "n" ? z0 : z1), a1, Math.max(edge, m.side === "n" ? z0 : z1), m.y - 0.3, m.y, "slab"));
  else out.push(rect(Math.min(edge, m.side === "w" ? x0 : x1), a0, Math.max(edge, m.side === "w" ? x0 : x1), a1, m.y - 0.3, m.y, "slab"));
  const s = m.stair ?? 0;
  const railTo = (p: number, q: number) =>
    alongX ? rect(p, edge - (inner > 0 ? 0.15 : 0), q, edge + (inner > 0 ? 0 : 0.15), m.y, m.y + 1.0, "steel", 2) : rect(edge - (inner > 0 ? 0.15 : 0), p, edge + (inner > 0 ? 0 : 0.15), q, m.y, m.y + 1.0, "steel", 2);
  const sc = (alongX ? cx : cz) + s;
  out.push(railTo(a0, sc - sw / 2), railTo(sc + sw / 2, a1));
  const away: Side = m.side === "n" ? "s" : m.side === "s" ? "n" : m.side === "w" ? "e" : "w";
  out.push(...(alongX ? stairs(sc, edge, away, sw, m.y) : stairs(edge, sc, away, sw, m.y)));
  return out;
}

/**
 * A large single-volume shed (a warehouse, a hangar, a works hall) of height H: thin walls with
 * wide roller doors, a flat roof, mezzanines inside along its walls with stairs up to them, and
 * columns holding the roof. The roof is reached from outside (a stair tower set against it).
 */
function hall(cx: number, cz: number, w: number, d: number, H: number, o: HallOpts = {}): Box[] {
  const size = o.scale ?? HOUSE;
  const WALL = size.wall;
  const holes: Hole[] = [
    ...(o.doors ?? []).map((q) => ({ side: q.side, at: q.at, w: q.w ?? size.roller + 0.6, head: size.roller })),
    ...(o.hatches ?? []).map((q) => ({ side: q.side, at: q.at, w: size.door, head: size.doorHead })),
  ];
  // A band of windows round the top, broken by piers so it reads as a row of panes.
  for (const side of o.windows ?? []) {
    const len = side === "n" || side === "s" ? w : d;
    // Panes stop short of a door on the same side: a pane's sill is wall from the floor up.
    const doors = holes.filter((q) => q.side === side);
    const clear = (t: number) => doors.every((q) => Math.abs(t - (q.at ?? 0)) >= q.w / 2 + 1.2 + 0.3);
    for (let t = -len / 2 + 3; t <= len / 2 - 3; t += 4) if (clear(t)) holes.push({ side, at: t, w: 2.4, sill: H - 2.6, head: H - 1.2 });
  }
  const kind: BoxKind = o.steel === undefined ? "wall" : "steel";
  const out = shell(cx, cz, w, d, 0, H - 0.3, holes, kind, o.steel ?? 0, WALL);
  out.push(box(cx, cz, w, d, H, "slab", 0, H - 0.3));
  out.push(...parapet(cx, cz, w, d, H, [...(o.open ?? []), ...(o.roof ? [o.roof] : [])]));
  if (o.roof) out.push(...roofStairs(cx, cz, w, d, H, o.roof, size.stair));
  out.push(...(o.mezz ?? []).flatMap((m) => mezzanine(cx, cz, w, d, WALL, m, size.stair)));
  if (o.columns) {
    const long = w >= d;
    const len = long ? w : d;
    for (let t = -len / 2 + o.columns; t <= len / 2 - o.columns + 0.01; t += o.columns)
      for (const k of [-1, 1]) {
        const off = (k * (long ? d : w)) / 6;
        out.push(long ? box(cx + t, cz + off, 0.5, 0.5, H - 0.3, "steel", 2) : box(cx + off, cz + t, 0.5, 0.5, H - 0.3, "steel", 2));
      }
  }
  return out;
}

/**
 * A walkway at height y between two points on a line along x or along z, `width` wide, with a
 * knee-high rail along both sides: low enough that whoever stands on it is seen from below.
 */
function catwalk(ax: number, az: number, bx: number, bz: number, y: number, width = 1.6, tint = 0): Box[] {
  const alongX = Math.abs(bx - ax) >= Math.abs(bz - az);
  const [a, b] = alongX ? [Math.min(ax, bx), Math.max(ax, bx)] : [Math.min(az, bz), Math.max(az, bz)];
  const c = alongX ? az : ax;
  const h = width / 2;
  if (alongX)
    return [rect(a, c - h, b, c + h, y - 0.3, y, "slab", 1), rect(a, c - h - 0.05, b, c - h + 0.2, y, y + 0.5, "steel", tint), rect(a, c + h - 0.2, b, c + h + 0.05, y, y + 0.5, "steel", tint)];
  return [rect(c - h, a, c + h, b, y - 0.3, y, "slab", 1), rect(c - h - 0.05, a, c - h + 0.2, b, y, y + 0.5, "steel", tint), rect(c + h - 0.2, a, c + h + 0.05, b, y, y + 0.5, "steel", tint)];
}

/**
 * A length of railway along x or along z on ground at 0: a dark ballast bed 3 m wide and two
 * rails on it, both under the step-up height, so it is walked over and seen, never climbed.
 */
function track(ax: number, az: number, bx: number, bz: number, y = 0): Box[] {
  const alongX = Math.abs(bx - ax) >= Math.abs(bz - az);
  const [a, b] = alongX ? [Math.min(ax, bx), Math.max(ax, bx)] : [Math.min(az, bz), Math.max(az, bz)];
  const c = alongX ? az : ax;
  const run = (lo: number, hi: number, y0: number, h: number, kind: BoxKind, tint: number) => (alongX ? rect(a, c + lo, b, c + hi, y0, h, kind, tint) : rect(c + lo, a, c + hi, b, y0, h, kind, tint));
  return [run(-1.5, 1.5, y - 0.2, y + 0.12, "step", 1), run(-0.8, -0.66, y + 0.12, y + 0.26, "steel", 2), run(0.66, 0.8, y + 0.12, y + 0.26, "steel", 2)];
}

/**
 * A goods wagon 13 m long left on a track along x (`alongX`) or z, on ground at 0: its dark
 * underframe, and on it a container (`box`), an open hopper (`hopper`) or a low load of pipe
 * (`flat`). A box wagon is cover a heavy hides behind; a flat one, cover to crouch at.
 */
function wagon(cx: number, cz: number, alongX: boolean, load: "box" | "hopper" | "flat", tint: number, y = 0): Box[] {
  const at = (l: number, w: number, y0: number, h: number, kind: BoxKind, t: number) => (alongX ? box(cx, cz, l, w, h, kind, t, y0) : box(cx, cz, w, l, h, kind, t, y0));
  const out = [at(12.4, 2.4, y, y + 1.2, "steel", 1)];
  if (load === "box") out.push(at(12.2, 2.6, y + 1.2, y + 3.8, "container", tint));
  else if (load === "hopper") out.push(at(11.6, 2.8, y + 1.2, y + 3.4, "steel", 3));
  else out.push(at(11, 2.2, y + 1.2, y + 2.0, "steel", 2));
  return out;
}

/**
 * A gantry crane straddling a lane along z at x = cx: a stair tower for one leg (its foot on
 * the north, z0 - 8 .. z0), a railed catwalk at height H from it to the far leg at z1, the
 * driver's cab on the catwalk round `cab`, and the boom running out over all of it.
 */
function gantry(cx: number, z0: number, z1: number, H: number, cab: number): Box[] {
  const floors = Math.round(H / STOREY);
  const out = paint(tower(cx, z0 - 4, 8, 8, floors, { doors: [["e", "w"]], windows: [[], ["e"], ["w"], ["e", "w"]], open: ["s"] }), "wall", "steel", () => 0, (b) => b.tint === 0);
  out.push(rect(cx - 1.2, z0, cx + 1.2, z1, H - 0.3, H, "slab", 1));
  // Railings knee-high, so the catwalk's guard is seen from below; open round the cab.
  for (const [a, b] of [[z0, cab - 2.5], [cab + 2.5, z1]] as const) out.push(rect(cx - 1.25, a, cx - 1.0, b, H, H + 0.5, "steel", 0), rect(cx + 1.0, a, cx + 1.25, b, H, H + 0.5, "steel", 0));
  out.push(rect(cx - 2.5, cab - 2.5, cx + 2.5, cab + 2.5, H - 0.3, H, "slab", 1));
  out.push(...walls(cx, cab, 5, 5, H, H + 2.5, ["n", "s"], ["e", "w"]).map((b) => ({ ...b, kind: "steel" as const, tint: 3 })));
  out.push(rect(cx - 2.5, cab - 2.5, cx + 2.5, cab + 2.5, H + 2.5, H + 2.8, "slab", 1));
  out.push(box(cx, z1 + 1.5, 3, 3, H, "steel", 0));
  const len = z1 - z0 + 30;
  out.push(box(cx, (z0 + z1) / 2, 1.4, len, H + 4.4, "steel", 0, H + 3.6));
  return out;
}

/**
 * A terrace of `n` houses of `floors` storeys in a row along x from x0, each `w` by `d`, their
 * party walls side by side. Every other house has its front door (south); the others are
 * entered through a door in the party wall from the house beside, so the row is one way
 * through. Their roofs join into one long roof, open between the houses.
 */
function rowHouses(x0: number, cz: number, n: number, w: number, d: number, floors: number): Box[] {
  const out: Box[] = [];
  for (let i = 0; i < n; i++) {
    const ground: Side[] = [];
    if (i % 2 === 0) ground.push("s");
    // The party wall between this house and the next has a door when this one has the front door.
    if (i % 2 === 0 && i + 1 < n) ground.push("e");
    if (i % 2 === 1) ground.push("w");
    const windows: Side[][] = [i % 2 === 0 ? [] : ["s"]];
    for (let k = 1; k < floors; k++) windows.push(["s", "n"]);
    const open: Side[] = [...(i > 0 ? ["w" as const] : []), ...(i + 1 < n ? ["e" as const] : [])];
    out.push(...tower(x0 + w / 2 + i * w, cz, w, d, floors, { doors: [ground], windows, open }));
  }
  return out;
}

/**
 * A perimeter wall `h` high round a yard `w` by `d`, with a gap for each gate (`w` wide, at
 * `at` metres along its side from the middle).
 */
function compound(cx: number, cz: number, w: number, d: number, h: number, gates: { side: Side; at?: number; w: number }[]): Box[] {
  return shell(cx, cz, w, d, 0, h, gates.map((g) => ({ side: g.side, at: g.at, w: g.w, head: h + 1 })), "wall", 0).map((b) => ({ ...b, tint: 1 }));
}

/**
 * A round tank `r` metres in radius and `h` high, from crossing boxes (an octagon in steps),
 * painted plate of `tint`, with a thin ladder up the `ladder` side: a landmark, not a climb.
 */
function tank(cx: number, cz: number, r: number, h: number, ladder: Side, tint = 2, y0 = 0): Box[] {
  const s = r * 0.83;
  const q = r * 1.42;
  const out = [box(cx, cz, 2 * r, s, h, "steel", tint, y0), box(cx, cz, s, 2 * r, h, "steel", tint, y0), box(cx, cz, q, q, h, "steel", tint, y0)];
  // A darker cap.
  out.push(box(cx, cz, q * 0.8, q * 0.8, h + 0.6, "steel", 1, h));
  const [dx, dz] = DIR[ladder];
  const lx = cx + dx * (r + 0.1);
  const lz = cz + dz * (r + 0.1);
  out.push(dx !== 0 ? box(lx, lz, 0.2, 0.7, h + 1, "steel", 2, y0 + 1.2) : box(lx, lz, 0.7, 0.2, h + 1, "steel", 2, y0 + 1.2));
  return out;
}

/**
 * An open steel lattice tower `w` by `d`: four corner posts to `top`, a platform with a
 * stairwell at each of its `floors` storeys reached by flights inside (as `tower()`'s), knee
 * rails round each platform (the top one's open on the `open` sides), and girders across above.
 */
function lattice(cx: number, cz: number, w: number, d: number, floors: number, top: number, open: Side[] = []): Box[] {
  const out: Box[] = [];
  const x0 = cx - w / 2;
  const x1 = cx + w / 2;
  const z0 = cz - d / 2;
  const z1 = cz + d / 2;
  for (const [x, z] of [[x0 + 0.2, z0 + 0.2], [x1 - 0.2, z0 + 0.2], [x0 + 0.2, z1 - 0.2], [x1 - 0.2, z1 - 0.2]]) out.push(box(x, z, 0.4, 0.4, top, "steel", 2));
  const n = stepsFor(STOREY);
  const sx1 = x1 - 0.6;
  const sx0 = sx1 - n * STEP_DEPTH;
  for (let k = 0; k < floors; k++) {
    const base = k * STOREY;
    const lvl = base + STOREY;
    const [za, zb] = k % 2 === 0 ? [z0 + 0.4, z0 + 1.8] : [z1 - 1.8, z1 - 0.4];
    for (let j = 0; j < n; j++) {
      const x = sx1 - (j + 0.5) * STEP_DEPTH;
      out.push(rect(x - STEP_DEPTH / 2, za, x + STEP_DEPTH / 2, zb, base, base + (STOREY * (j + 1)) / (n + 1), "step", 0));
    }
    out.push(...slabWithHole(x0, z0, x1, z1, lvl - 0.3, lvl, sx0, za, sx1, zb).map((b) => ({ ...b, tint: 1 })));
    // Knee rails round the platform; the top one's are left off the `open` sides (a roof beside it).
    const rails: [Side, Box][] = [
      ["n", rect(x0, z0, x1, z0 + 0.15, lvl, lvl + 0.5, "steel", 2)],
      ["s", rect(x0, z1 - 0.15, x1, z1, lvl, lvl + 0.5, "steel", 2)],
      ["w", rect(x0, z0, x0 + 0.15, z1, lvl, lvl + 0.5, "steel", 2)],
      ["e", rect(x1 - 0.15, z0, x1, z1, lvl, lvl + 0.5, "steel", 2)],
    ];
    for (const [side, rail] of rails) if (k < floors - 1 || !open.includes(side)) out.push(rail);
  }
  // The mast above the top platform, its girders every few metres.
  for (let y = floors * STOREY + 4; y < top; y += 4) out.push(rect(x0, z0, x1, z0 + 0.25, y - 0.25, y, "steel", 2), rect(x0, z1 - 0.25, x1, z1, y - 0.25, y, "steel", 2));
  return out;
}

/**
 * Boxes written on ground at 0, grouped by the level of the floor each group stands on. A group
 * marked `loose` is lifted without pressing the ground flat under it (a catwalk out over a cliff).
 */
type Floors = ([number, Box[]] | [number, Box[], "loose"])[];

/** Ground the hand-built boxes stand on, pressed flat to their level (buildTerrain). */
const FLAT: FlatShape[] = [];

/**
 * Lifts boxes written on ground at 0 onto ground at `level`. Those standing on the
 * ground (not hanging below it, like the bridge's pillars) keep it flat at that level.
 */
function onLevel(level: number, boxes: Box[]): Box[] {
  const out = boxes.map((b) => ({ ...b, y0: b.y0 + level, h: b.h + level }));
  for (const b of out) if (b.y0 >= level) FLAT.push({ x0: b.x0, z0: b.z0, x1: b.x1, z1: b.z1, y: level });
  return out;
}

/** A point written relative to the ground of its area, at its absolute height. */
const onFloor = <T extends { x: number; z: number; y?: number }>(q: T): T & { y: number } => ({ ...q, y: (q.y ?? 0) + floorLevel(q.x, q.z) });

/** One robot of a squad, placed on the island from the start. */
export interface Member {
  kind: EnemyKind;
  x: number;
  z: number;
  /** Floor height it stands on (a roof, a platform). Authored relative to its area's ground, absolute once placed. */
  y?: number;
  /** Direction it watches while idle (yaw, 0 = north / -z). */
  face?: number;
  /** Its armour plate's tier (see PLATE): each POI's vault guard wears one. */
  plate?: Rarity;
}

/**
 * A squad notices and fights together: when one member engages, all do. Other
 * squads come only if they hear the shooting.
 */
export interface Squad {
  name: string;
  members: Member[];
  /** Waypoints walked in a loop while nothing is wrong. Without it the squad holds its posts. */
  patrol?: { x: number; z: number }[];
  /** Roams the roads between districts: hears gunfire from further away (NOISE.roamMult). */
  roam?: true;
}

/** `valuable` lists the kinds a bin may hold, each with its weight. */
export type LootTable = { weapon: [WeaponKind, Rarity][]; armor: Rarity[]; heals: number; valuable: [ValuableKind, number][] };

/** Stable names for the POIs: saves, quests and other data refer to a POI by these, never by its place in `POIS`. */
export type PoiId = "supply" | "quarry" | "relay" | "pad" | "wreck" | "yard" | "smelter" | "station" | "waterworks" | "lodge" | "cannery" | "coldstore";

export interface Poi {
  id: PoiId;
  name: string;
  x: number;
  z: number;
  /** The objective banner shows when the player comes this close. */
  trigger: number;
  /** The way in from the main road: kept open and flat (the bot's default approach).*/
  entry: { x: number; z: number; yaw: number };
  /** Clearing the POI means beating every one of these squads. */
  squads: Squad[];
  /** The one with `vault` is locked: it takes this POI's key (`VAULT`). */
  bins: { x: number; z: number; y?: number; vault?: true }[];
  /** The POI whose bins may hold this POI's key. */
  keyFrom: PoiId;
  loot: LootTable;
  floor: { x: number; z: number; y?: number; weapon?: [WeaponKind, Rarity]; armor?: Rarity; heal?: HealKind }[];
  carePackage?: { x: number; z: number; weapon: [WeaponKind, Rarity] };
  boss?: true;
}

/** Facing directions for idle robots (yaw). */
const N = 0;
const E = Math.PI / 2;
const S = Math.PI;
const W = -Math.PI / 2;
const SE = (3 * Math.PI) / 4;
const SW = (-3 * Math.PI) / 4;


/** The beached ship's main deck (the roof of its three-storey hull) and the gantry crane's catwalk, above their ground. */
/**
 * The wreck's hull in its frame: its middle along x, length, beam, the middle line it lies on,
 * and the accommodation block's middle along it (that and `DECK_BAYS` from the hull's middle).
 */
const SHIP = { x: 6, length: 140, beam: 26, z: -8, block: 52 } as const;
/** The wreck's main deck, over its three storeys of hull. */
const SHIP_DECK = WORKS.storey * 3;
/** The middles of the deck cargo's bays, forward of the accommodation block. */
const DECK_BAYS = [-52, -36, -20, -4, 12, 28] as const;
const CRANE = STOREY * 4;

/** Moves a squad authored in a district's own frame into place. */
function placeSquad(sq: Squad, dx: number, dz: number): Squad {
  return { ...sq, members: sq.members.map((m) => onFloor({ ...m, x: m.x + dx, z: m.z + dz })), patrol: sq.patrol?.map((p) => ({ x: p.x + dx, z: p.z + dz })) };
}

function placePoi(p: Poi, [dx, dz]: readonly [number, number]): Poi {
  const at = <T extends { x: number; z: number }>(q: T): T => ({ ...q, x: q.x + dx, z: q.z + dz });
  const up = <T extends { x: number; z: number; y?: number }>(q: T) => onFloor(at(q));
  return {
    ...p,
    x: p.x + dx,
    z: p.z + dz,
    entry: at(p.entry),
    squads: p.squads.map((sq) => placeSquad(sq, dx, dz)),
    bins: p.bins.map(up),
    floor: p.floor.map(up),
    carePackage: p.carePackage && at(p.carePackage),
  };
}

/**
 * The supply depot's watchtower, in the depot's frame: four storeys on the crest of the east dune,
 * sunk two storeys into its sand, so that the sand comes up under its third floor's windows. It is
 * not pressed flat (the dune runs up to it), so its storeys are reckoned from the sand at its foot.
 */
const WATCH = (() => {
  const x = 88;
  const z = -12;
  const sand = floorLevel(x + POI_AT.supply[0], z + POI_AT.supply[1]);
  return { x, z, floors: 4, w: 9, sand, base: sand + 0.1 - 2 * WORKS.storey };
})();
/** The height of the watchtower's storey `k` (0 = its buried ground floor) over the depot's floor at (x, z), in its frame. */
const watchFloor = (x: number, z: number, k: number) => WATCH.base + k * WORKS.storey - floorLevel(x + POI_AT.supply[0], z + POI_AT.supply[1]);

/**
 * The tanker beached on the dune coast, in the supply depot's frame: its bow run up the sand to
 * the north, 22 m across, the stem 38 m over the beach and the deck stepping down south (each step
 * too tall to climb) into the dune that buries its stern. Its hold is open from the east and the
 * west through holes torn in its side, with a tween deck along its west side.
 */
const TANKER = { x0: 40, x1: 62, z0: 72, z1: 112, deck: 9 } as const;

/**
 * The ring-segment assembly hall, in the supply depot's frame: 150 m along x, 40 m deep and 40 m
 * high, its concrete plinth `plinth` high under teal steel cladding. The gantry cranes run along
 * its length on girders at `crane`, the height of the open steel stair tower (`lattice()`) in its
 * north-west corner, so the walk from the tower's top out along the north runway to a crane's
 * bridge stays level.
 */
const ASSEMBLY = { x0: -102, x1: 48, z0: -60, z1: -20, H: 40, plinth: 9, crane: 8 * STOREY } as const;
/** The gash torn in the hall's south cladding over the segment, where the debris of the ring's fall came through: x and heights. */
const GASH = { x0: -12, x1: 18, y0: 14, y1: 32 } as const;
/** Where the cranes' bridges stand along the hall: the one with its walkway and cab, the one over the segment, and the one that fell. */
const BRIDGES = { cab: -45, over: 27, fallen: -72 } as const;

/**
 * The bucket-wheel excavator that dug the ring's material, on the quarry's top terrace, in the
 * quarry's frame, its heights over the top terrace: crawlers, a turntable, the machine house (its
 * roof `roof` high, reached by an open stair tower south of it), an A-frame mast `mast` high
 * with stays to both booms, the counterweight boom east, and the wheel boom running west out over
 * the middle terrace down to the wheel (`wheel`, beside the boom's tip) cutting into the pit's edge.
 * A walkway steps down the wheel boom from the roof in `steps` steps a body walks, flat for a
 * landing at the operator's cab (`cab`, the steps it spans) near the wheel.
 */
const BWE = { root: 92, tip: 40, roof: 17, end: 2, mast: 48, steps: 40, cab: [31, 33], wheel: { x: 40, y: 0, r: 9, z0: 7, z1: 10 } } as const;
/** The wheel boom's walkway steps, from the roof out: x from, x to, and the top of each. */
const BOOM_STEPS = (() => {
  const { root, tip, roof, end, steps, cab } = BWE;
  const L = (root - tip) / steps;
  const flat = cab[1] - cab[0];
  const rise = (roof - end) / (steps - flat);
  let y = roof;
  return Array.from({ length: steps }, (_, k) => {
    if (k <= cab[0] || k > cab[1]) y -= rise;
    return { x0: root - (k + 1) * L, x1: root - k * L, y };
  });
})();
/** The cab's floor over the top terrace, and its walls round it. */
const BWE_CAB = (() => {
  const a = BOOM_STEPS[BWE.cab[1]].x0;
  const b = BOOM_STEPS[BWE.cab[0]].x1;
  return { x0: a - 0.5, x1: b + 1.1, z0: 13.5, z1: 17.6, y: BOOM_STEPS[BWE.cab[0]].y, door: (a + b) / 2 };
})();

/**
 * Each POI is written in its own frame (its data and its boxes below) and moved
 * into place by this offset (`POI_AT` in areas.ts, which sets each in its area's frame).
 * The harbor's POIs are written round their own middle.
 */
const AT = (["supply", "quarry", "relay", "pad", "wreck", "yard", "smelter", "station", "waterworks", "lodge", "cannery", "coldstore"] as const).map((id) => POI_AT[id]);

/** The big dish on the mesa, in the relay's frame (`dish()`), its heights over the mesa's top. */
const BIG_DISH = { x: 45, z: -5, y: 23, r: 28, f: 22.4, tilt: Math.PI / 4, cell: 2.5 } as const;
/** The big dish's bowl, and the stair tower west of its lowest rim, its top the gallery's floor. */
const BIG_BOWL = dish(BIG_DISH.x, BIG_DISH.y, BIG_DISH.z, { r: BIG_DISH.r, f: BIG_DISH.f, tilt: BIG_DISH.tilt, face: "w", cell: BIG_DISH.cell, thick: 0.6, rim: 2.5, feed: 2 });
const DISH_RIM_X = Math.min(...BIG_BOWL.filter((b) => b.z0 < BIG_DISH.z && b.z1 > BIG_DISH.z).map((b) => b.x0));
const DISH_STAIRS = { x: DISH_RIM_X - 4, z: BIG_DISH.z, floors: 3 } as const;


/*
 * The nodes built on the open ground between the areas (docs/ringfall/island-v2.md, 拠点を増やす):
 * each a small works inside a waist-high wall (cover to crouch behind, seen over standing), written in its own frame round its middle on ground at 0,
 * its yard open in the middle, where its core stands. A garrison of two squads holds each.
 */

/** The weather station on the west coast: a lattice mast to climb, the office, the instrument shed and a store. */
function station(): Box[] {
  return [
    ...compound(0, 0, 74, 66, 1.1, [{ side: "e", w: 8 }, { side: "w", w: 6 }, { side: "n", at: -10, w: 6 }, { side: "s", at: 12, w: 6 }]),
    ...lattice(-20, -16, 6, 6, 4, 30),
    ...tower(12, -20, 10, 8, 2, { doors: [["s", "w"]], windows: [["e"], ["n", "e", "s"]] }),
    ...building(-20, 18, 12, 8, 3.4, { doors: ["e", "n"], windows: ["s"], roof: "w" }),
    ...building(16, 18, 8, 6, 3.0, { doors: ["w", "n"] }),
    // The instruments' stands and crates out in the yard.
    box(-4, -24, 1.2, 1.2, 1.6, "steel", 2),
    box(4, -26, 1.2, 1.2, 1.6, "steel", 2),
    box(26, 4, 1.2, 1.2, 0.9, "crate"),
    box(27.2, 4, 1.2, 1.2, 1.8, "crate"),
    box(-28, 2, 6, 2.5, 2.6, "container", 2),
  ];
}

/** The waterworks on the south coast east of the supply depot: two tanks, open filter beds behind knee walls, the pump hall and the control house. */
function waterworks(): Box[] {
  return [
    ...compound(0, 0, 70, 64, 1.1, [{ side: "w", w: 8 }, { side: "n", at: 8, w: 6 }, { side: "e", w: 6 }, { side: "s", at: -6, w: 6 }]),
    ...tank(-20, -16, 7, 8, "e", 2),
    ...tank(-20, 12, 7, 8, "e", 2),
    ...hall(14, -16, 24, 14, 6.5, { doors: [{ side: "s", at: -6 }], hatches: [{ side: "w" }, { side: "e" }], windows: ["n"], mezz: [{ side: "n", depth: 3, y: 3.2, stair: 4 }], steel: 1 }),
    // The filter beds: two pools sunk behind knee-high walls, broken where the walks cross.
    rect(4, 6, 14, 6.4, 0, 1.1, "wall", 1),
    rect(18, 6, 28, 6.4, 0, 1.1, "wall", 1),
    rect(4, 16.6, 28, 17, 0, 1.1, "wall", 1),
    rect(4, 6, 4.4, 17, 0, 1.1, "wall", 1),
    rect(27.6, 6, 28, 17, 0, 1.1, "wall", 1),
    ...tower(-2, 24, 8, 8, 2, { doors: [["e", "n"]], windows: [["w"], ["n", "e", "w"]] }),
  ];
}

/** The workers' lodge at the harbor's foot of the pass: a terrace of bunkhouses, the canteen hall, the lodge's office and a garage. */
function lodge(): Box[] {
  return [
    ...compound(0, 0, 76, 64, 1.1, [{ side: "n", w: 8 }, { side: "s", at: 10, w: 6 }, { side: "e", w: 6 }, { side: "w", w: 6 }]),
    ...rowHouses(-34, -18, 4, 7, 8, 2),
    ...hall(20, -14, 22, 14, 6, { doors: [{ side: "s" }], hatches: [{ side: "w" }, { side: "n" }], windows: ["n"], columns: 6 }),
    ...tower(-20, 18, 9, 8, 3, { doors: [["e", "s"]], windows: [["w"], ["n", "e", "s", "w"], ["n", "s"]] }),
    ...building(20, 18, 10, 7, 3.6, { doors: ["w", "n"], roof: "e" }),
    box(4, 22, 2.5, 6, 2.2, "steel", 3),
    box(-6, -2, 1.2, 1.2, 0.9, "crate"),
  ];
}

/** The cannery between the yard and the wreck: the packing hall with its gallery, the office and the cold room, crates of tins on the quay apron. */
function cannery(): Box[] {
  return [
    ...compound(0, 0, 80, 68, 1.1, [{ side: "s", w: 8 }, { side: "n", w: 8 }, { side: "e", at: 8, w: 6 }, { side: "w", at: 8, w: 6 }]),
    ...hall(0, -16, 36, 18, 8, { doors: [{ side: "s", at: -9 }, { side: "s", at: 9 }], hatches: [{ side: "e" }, { side: "w" }], windows: ["n"], columns: 6, mezz: [{ side: "n", depth: 3.4, y: 3.8, stair: 10 }], steel: 4 }),
    ...tower(-24, 18, 9, 8, 2, { doors: [["e", "s"]], windows: [["w"], ["n", "e", "w"]] }),
    ...building(18, 18, 10, 7, 3.6, { doors: ["w", "n"], roof: "e" }),
    box(-32, -2, 6, 2.5, 2.6, "container", 3),
    box(30, -2, 6, 2.5, 2.6, "container", 1),
    box(-8, 26, 1.2, 1.2, 0.9, "crate"),
    box(-6.8, 26, 1.2, 1.2, 1.8, "crate"),
  ];
}

/** The cold store between the smelter and the wreck: the insulated store with a gallery, the engine house and the loading office, a trailer at the dock. */
function coldstore(): Box[] {
  return [
    ...compound(0, 0, 74, 68, 1.1, [{ side: "s", w: 8 }, { side: "n", at: -8, w: 6 }, { side: "e", w: 6 }]),
    ...hall(0, -14, 30, 20, 9, { doors: [{ side: "s", at: -6 }], hatches: [{ side: "e" }, { side: "w" }], mezz: [{ side: "w", depth: 3.2, y: 4.5, stair: 2 }], steel: 0 }),
    ...tower(22, 18, 8, 8, 3, { doors: [["w", "s"]], windows: [["e"], ["n", "e", "s", "w"], ["n", "s"]] }),
    ...building(-20, 18, 10, 7, 3.4, { doors: ["e", "n"], roof: "w" }),
    ...trailer(26, -4, 1),
    box(-30, -2, 6, 2.5, 2.6, "container", 2),
  ];
}

const POI_FRAMES: Poi[] = [
  {
    id: "supply",
    name: "補給所",
    x: 0,
    z: -5,
    trigger: 95,
    entry: { x: 0, z: 114, yaw: 0 },
    squads: [
      // Four squads of two, each a fight of its own: the west and the east of the assembly hall, the
      // east dune and the beach round the tanker. A fight with one leaves another a flank to come
      // round, across a yard 30 m wide.
      { name: "組立棟", members: [{ kind: "grunt", plate: VAULT.guardPlate, x: -76, z: -30, face: W }, { kind: "grunt", x: -50, z: -9, face: S }] },
      { name: "組立棟東", members: [{ kind: "grunt", x: 10, z: -44, face: W }, { kind: "drone", x: 20, z: -36 }] },
      { name: "砂丘", members: [{ kind: "grunt", x: 74, z: 18, face: W }, { kind: "charger", x: 26, z: 44, face: W }] },
      { name: "タンカー", members: [{ kind: "grunt", x: 24, z: 84, face: E }, { kind: "drone", x: 52, z: 66 }] },
    ],
    bins: [
      { x: 24, z: 8, y: WORKS.storey * 3 },
      { x: -46, z: 25 },
      { x: -56, z: -23 },
      { x: 40, z: -28 },
      { x: 43.5, z: 78, y: TANKER.deck },
      { x: WATCH.x - 3, z: WATCH.z, y: watchFloor(WATCH.x - 3, WATCH.z, 3) },
      { x: 30, z: -56.5, y: WORKS.storey },
      // The cab of the crane whose walkway the stair tower climbs to.
      { x: BRIDGES.cab, z: -26.5, y: ASSEMBLY.crane },
      { x: -84, z: -56.5, y: WORKS.storey, vault: true },
    ],
    keyFrom: "pad",
    loot: { weapon: [["hornet", 1], ["maul", 0], ["lance", 0], ["pike", 1]], armor: [1], heals: 1, valuable: [["fuse", 3], ["parts", 4], ["wire", 2], ["drive", 1]] },
    floor: [
      { x: 6, z: 104, weapon: ["hornet", 0] },
      { x: -6, z: 104, heal: "syringe" },
      { x: 26, z: 7, y: WORKS.storey, armor: 1 },
      { x: -36, z: -23, y: WORKS.storey * 2, heal: "battery" },
    ],
  },
  {
    id: "quarry",
    name: "採掘場",
    x: -15,
    z: 18,
    trigger: 140,
    entry: { x: 55, z: -100, yaw: Math.PI },
    squads: [
      // Three squads on the top terrace (by the haul road's foot, at the head of the ramp down, and
      // round the excavator) and one on the floor: the deeper the player goes, the more of the
      // terraces look down on them.
      { name: "上段", members: [{ kind: "grunt", plate: VAULT.guardPlate, x: -12, z: -46, face: S }, { kind: "grunt", x: 88, z: -28, face: SW }] },
      { name: "坂上", members: [{ kind: "grunt", x: 30, z: -50, face: S }, { kind: "drone", x: 40, z: -40 }] },
      { name: "採掘穴", members: [{ kind: "charger", x: -8, z: 28, face: E }, { kind: "grunt", x: -32, z: 8, face: E }] },
      { name: "掘削機", members: [{ kind: "grunt", x: 85, z: 40, face: W }, { kind: "drone", x: 110, z: 40 }] },
    ],
    bins: [
      { x: 104, z: -14 },
      { x: 60, z: 52 },
      { x: 52, z: 6 },
      { x: -28, z: 32 },
      { x: 4, z: 6 },
      // The excavator's cab, out on its boom over the middle terrace.
      { x: (BWE_CAB.x0 + BWE_CAB.x1) / 2, z: 16, y: LEVEL.quarryTop + BWE_CAB.y - LEVEL.quarryMid },
      { x: -31, z: -55, y: WORKS.storey * 2, vault: true },
    ],
    keyFrom: "supply",
    loot: { weapon: [["pike", 1], ["maul", 1], ["lance", 1], ["hornet", 1], ["talon", 1]], armor: [1], heals: 2, valuable: [["parts", 3], ["wire", 4], ["fuse", 1], ["gyro", 1]] },
    floor: [{ x: -20, z: 12, heal: "medkit" }],
    carePackage: { x: -15, z: 22, weapon: ["lance", 1] },
  },
  {
    id: "relay",
    name: "中継塔",
    x: 0,
    z: 0,
    trigger: 100,
    entry: { x: -20, z: 20, yaw: 2.36 },
    squads: [
      { name: "アンテナ", members: [{ kind: "grunt", x: 36, z: -28, face: W }, { kind: "heavy", x: 18, z: 2, face: SW }] },
      { name: "大皿", members: [{ kind: "grunt", x: 50, z: -25, face: W }, { kind: "drone", x: 45, z: 22 }] },
      // Two drones over the mesa's south-east rim, beyond the dish from the way in.
      { name: "南東の縁", members: [{ kind: "drone", x: 60, z: 40 }, { kind: "drone", x: 66, z: 34 }] },
      { name: "機器棟", members: [{ kind: "grunt", plate: VAULT.guardPlate, x: -22, z: -5, face: W }, { kind: "grunt", x: -8, z: -36, face: W }, { kind: "charger", x: 4, z: 14, face: SW }] },
    ],
    bins: [
      { x: 8, z: 18 },
      { x: -42, z: -30 },
      { x: 62, z: 8 },
      // The gallery at the big dish's lowest rim, on its stair tower's top.
      { x: DISH_STAIRS.x - 1.5, z: DISH_STAIRS.z + 2, y: DISH_STAIRS.floors * STOREY },
      { x: -29, z: -20, y: WORKS.storey, vault: true },
    ],
    keyFrom: "quarry",
    loot: { weapon: [["pike", 1], ["hornet", 1], ["maul", 1], ["lance", 1], ["talon", 1]], armor: [1], heals: 2, valuable: [["board", 4], ["drive", 2], ["wire", 1], ["gyro", 1]] },
    floor: [
      { x: -20, z: -18, y: WORKS.storey, weapon: ["lance", 1] },
      { x: -22, z: -18, y: WORKS.storey * 3, armor: 2 },
    ],
  },
  {
    id: "pad",
    name: "発着場",
    x: 0,
    z: 20,
    trigger: 110,
    entry: { x: -105, z: 20, yaw: Math.PI / 2 },
    squads: [{ name: "タイタン", members: [{ kind: "titan", x: 0, z: 16, face: S }, { kind: "drone", x: -10, z: 24 }, { kind: "drone", x: 10, z: 24 }] }],
    bins: [
      { x: -50, z: 18 },
      { x: 50, z: 18 },
      { x: -72, z: -6 },
      { x: 0, z: -24 },
      { x: 80, z: 4, y: WORKS.storey, vault: true },
    ],
    keyFrom: "relay",
    loot: { weapon: [], armor: [1], heals: 2, valuable: [["board", 3], ["drive", 2], ["core", 1]] },
    floor: [],
    boss: true,
  },
  // --- the harbor: three POIs whose squads come in pairs and with heavies more often
  {
    id: "wreck",
    name: "難破船",
    x: 0,
    z: 0,
    trigger: 46,
    entry: { x: 4, z: 26, yaw: 0 },
    squads: [
      // Up high, robots stand on the deck: seen from the ground below, and seeing it.
      { name: "甲板", members: [{ kind: "grunt", plate: VAULT.guardPlate, x: 46, z: -8, y: SHIP_DECK, face: S }, { kind: "heavy", x: 26, z: -3, y: SHIP_DECK, face: S }] },
      {
        name: "浜",
        members: [{ kind: "grunt", x: -12, z: 15, face: S }, { kind: "grunt", x: -9.5, z: 16, face: S }, { kind: "drone", x: -96, z: 14 }],
        patrol: [{ x: -96, z: 14 }, { x: 82, z: 14 }],
      },
      { name: "北の浜", members: [{ kind: "grunt", x: -20, z: -26, face: N }, { kind: "drone", x: 12, z: -25 }] },
      { name: "舳先", members: [{ kind: "charger", x: 30, z: -31, face: W }, { kind: "drone", x: 40, z: -29 }] },
    ],
    bins: [
      { x: -26, z: -4 },
      { x: 32, z: -12 },
      { x: -4, z: -4, y: WORKS.storey },
      { x: -22, z: -8, y: SHIP_DECK },
      { x: 54, z: -10, y: SHIP_DECK + STOREY * 3, vault: true },
    ],
    keyFrom: "smelter",
    loot: { weapon: [["talon", 1], ["lance", 1], ["maul", 1], ["pike", 1]], armor: [1], heals: 2, valuable: [["board", 3], ["drive", 3], ["gyro", 2], ["core", 1]] },
    floor: [
      { x: 2, z: -4, y: WORKS.storey, heal: "medkit" },
      { x: 10, z: -8, y: SHIP_DECK, weapon: ["lance", 1] },
    ],
  },
  {
    id: "yard",
    name: "コンテナヤード",
    x: 0,
    z: 0,
    trigger: 70,
    entry: { x: 0, z: 46, yaw: 0 },
    squads: [
      { name: "クレーン", members: [{ kind: "grunt", plate: VAULT.guardPlate, x: 46.75, z: 16, y: CRANE, face: W }, { kind: "heavy", x: 0, z: -8, face: E }] },
      { name: "通路", members: [{ kind: "grunt", x: -50, z: -29.5, face: E }, { kind: "grunt", x: -46, z: 21.7, face: E }] },
      { name: "北の列", members: [{ kind: "grunt", x: 12, z: -38, face: S }, { kind: "drone", x: -40, z: -45 }] },
      {
        name: "東の列",
        members: [{ kind: "grunt", x: 60, z: -12, face: W }, { kind: "drone", x: 58, z: -12 }],
        patrol: [{ x: 60, z: -12 }, { x: 60, z: 0 }, { x: 24, z: 0 }, { x: 24, z: -12 }],
      },
    ],
    bins: [
      { x: -29.7, z: -29.5 },
      { x: 38.4, z: 21.7 },
      { x: -73, z: 1 },
      { x: -73, z: -1, y: WORKS.storey },
      { x: 47.8, z: 22, y: CRANE, vault: true },
    ],
    keyFrom: "wreck",
    loot: { weapon: [["hornet", 1], ["maul", 1], ["pike", 1], ["lance", 1]], armor: [1], heals: 2, valuable: [["wire", 3], ["board", 3], ["drive", 2], ["gyro", 1]] },
    floor: [
      { x: 14, z: -12, heal: "battery" },
      { x: -67, z: -1, y: WORKS.storey * 2, armor: 2 },
    ],
  },
  {
    id: "smelter",
    name: "製錬所",
    x: 8,
    z: 0,
    trigger: 58,
    entry: { x: 8, z: 40, yaw: 0 },
    squads: [
      { name: "制御棟", members: [{ kind: "grunt", plate: VAULT.guardPlate, x: 35, z: 4, y: WORKS.storey * 3, face: S }, { kind: "grunt", x: 24, z: -1, face: S }] },
      { name: "炉", members: [{ kind: "heavy", x: -14, z: 10, face: S }, { kind: "charger", x: -6, z: 20, face: E }] },
      // Behind the works, away from the way in: the last of the POI, or the first for a player who goes round.
      { name: "裏手", members: [{ kind: "grunt", x: 0, z: -42, face: S }, { kind: "drone", x: -30, z: -30 }] },
      { name: "北東", members: [{ kind: "grunt", x: 40, z: -28, face: S }, { kind: "drone", x: 44, z: -36 }] },
    ],
    bins: [
      { x: -29, z: 10 },
      { x: 18.5, z: 14 },
      { x: -14, z: -3.5, y: 34 },
      { x: -34, z: 17 },
      { x: 35, z: -7, y: WORKS.storey * 2, vault: true },
    ],
    keyFrom: "yard",
    loot: { weapon: [["pike", 1], ["lance", 1], ["maul", 1], ["talon", 1], ["hornet", 1]], armor: [1], heals: 2, valuable: [["wire", 2], ["gyro", 3], ["drive", 2], ["board", 2], ["reactor", 1]] },
    floor: [{ x: 37, z: -9, y: WORKS.storey * 3, weapon: ["talon", 1] }],
  },

  // --- the nodes built on the open ground between the areas: a garrison of two squads each
  {
    id: "station",
    name: "観測所",
    x: 0,
    z: 0,
    trigger: 55,
    entry: { x: 8, z: -42, yaw: S },
    squads: [
      { name: "観測塔", members: [{ kind: "grunt", x: -12, z: -12, face: E }, { kind: "grunt", plate: VAULT.guardPlate, x: 4, z: -12, face: E }] },
      { name: "器材庫", members: [{ kind: "grunt", x: 8, z: 12, face: E }, { kind: "drone", x: -12, z: 24 }] },
    ],
    bins: [
      { x: -20, z: 18 },
      { x: 16, z: 18 },
      { x: 26, z: -6 },
      { x: -18, z: -15.5, y: 4 * STOREY },
      { x: -24, z: 16 },
      { x: 9, z: -22, y: 2 * STOREY },
      { x: 0, z: -21 },
      { x: 8, z: -19, y: STOREY, vault: true },
    ],
    keyFrom: "waterworks",
    loot: { weapon: [["pike", 1], ["talon", 1], ["hornet", 1]], armor: [1], heals: 2, valuable: [["wire", 3], ["gyro", 2], ["board", 2], ["fuse", 1]] },
    floor: [{ x: 9, z: -17, heal: "battery" }],
  },
  {
    id: "waterworks",
    name: "浄水場",
    x: 0,
    z: 0,
    trigger: 55,
    entry: { x: 8, z: -42, yaw: S },
    squads: [
      { name: "ポンプ棟", members: [{ kind: "grunt", x: 8, z: -6, face: S }, { kind: "grunt", x: 22, z: -4, face: S }] },
      { name: "水槽", members: [{ kind: "grunt", plate: VAULT.guardPlate, x: -8, z: -2, face: S }, { kind: "drone", x: -10, z: 22 }] },
    ],
    bins: [
      { x: 20, z: -18 },
      { x: -2, z: 24 },
      { x: 16, z: 11.5 },
      { x: 18, z: -21, y: 3.2 },
      { x: 6, z: -12 },
      { x: -31, z: -2 },
      { x: 30, z: 2 },
      { x: -4, z: 23, y: STOREY, vault: true },
    ],
    keyFrom: "station",
    loot: { weapon: [["pike", 1], ["maul", 1], ["lance", 1]], armor: [1], heals: 2, valuable: [["parts", 3], ["fuse", 2], ["wire", 2], ["drive", 1]] },
    floor: [{ x: 6, z: -12, heal: "syringe" }],
  },
  {
    id: "lodge",
    name: "峠の宿舎",
    x: 0,
    z: 0,
    trigger: 55,
    entry: { x: 0, z: -42, yaw: S },
    squads: [
      { name: "食堂", members: [{ kind: "grunt", x: 16, z: -2, face: N }, { kind: "heavy", x: 4, z: 10, face: N }] },
      { name: "宿舎棟", members: [{ kind: "grunt", plate: VAULT.guardPlate, x: -24, z: -6, face: N }, { kind: "drone", x: -8, z: 22 }] },
    ],
    bins: [
      { x: 24, z: -16 },
      { x: -30, z: -16 },
      { x: 20, z: 18 },
      { x: -17, z: 16, y: 2 * STOREY },
      { x: -26, z: -16, y: STOREY },
      { x: 12, z: -10 },
      { x: -4, z: 26 },
      { x: -16, z: 20, vault: true },
    ],
    keyFrom: "cannery",
    loot: { weapon: [["pike", 1], ["hornet", 1], ["maul", 1], ["talon", 1]], armor: [1], heals: 2, valuable: [["parts", 2], ["wire", 2], ["gyro", 2], ["board", 2]] },
    floor: [{ x: 22, z: -10, heal: "medkit" }],
  },
  {
    id: "cannery",
    name: "缶詰工場",
    x: 0,
    z: 0,
    trigger: 58,
    entry: { x: 0, z: 40, yaw: N },
    squads: [
      { name: "包装棟", members: [{ kind: "grunt", x: -4, z: -14, face: S }, { kind: "heavy", x: 10, z: -4, face: S }] },
      { name: "岸壁", members: [{ kind: "grunt", plate: VAULT.guardPlate, x: -20, z: 6, face: S }, { kind: "drone", x: 22, z: 8 }] },
    ],
    bins: [
      { x: 12, z: -20 },
      { x: -12, z: -20 },
      { x: 18, z: 18 },
      { x: 4, z: -22.5, y: 3.8 },
      { x: -15, z: -10 },
      { x: -26, z: 20 },
      { x: 6, z: 24 },
      { x: -21, z: 16, y: STOREY, vault: true },
    ],
    keyFrom: "coldstore",
    loot: { weapon: [["talon", 1], ["lance", 1], ["pike", 1]], armor: [1], heals: 2, valuable: [["board", 2], ["drive", 2], ["gyro", 2], ["wire", 1]] },
    floor: [{ x: -14, z: -12, heal: "battery" }],
  },
  {
    id: "coldstore",
    name: "冷凍倉庫",
    x: 0,
    z: 0,
    trigger: 55,
    entry: { x: 0, z: 46, yaw: N },
    squads: [
      { name: "冷凍庫", members: [{ kind: "grunt", x: 6, z: -8, face: S }, { kind: "heavy", x: -6, z: 0, face: S }] },
      { name: "荷捌き場", members: [{ kind: "grunt", plate: VAULT.guardPlate, x: 18, z: 6, face: S }, { kind: "drone", x: -16, z: 8 }] },
    ],
    bins: [
      { x: -8, z: -18 },
      { x: -20, z: 18 },
      { x: 10, z: -20 },
      { x: -12, z: -10, y: 4.5 },
      { x: 10, z: -8 },
      { x: 19.5, z: 20 },
      { x: -28, z: 10 },
      { x: 25, z: 16, y: STOREY, vault: true },
    ],
    keyFrom: "lodge",
    loot: { weapon: [["pike", 1], ["lance", 1], ["maul", 1], ["hornet", 1]], armor: [1], heals: 2, valuable: [["wire", 2], ["board", 2], ["drive", 2], ["reactor", 1]] },
    floor: [{ x: -16, z: -4, heal: "medkit" }],
  },
];

export const POIS: Poi[] = POI_FRAMES.map((p, i) => placePoi(p, AT[i]));

/** A POI's place in `POIS` (and in the run's per-POI state), from its id. */
export const poiIndex = (id: PoiId) => POIS.findIndex((p) => p.id === id);

/** A depot (`DEPOT`): a point on the ground facing its POI, with nothing built there to walk round. */
export interface Depot {
  poi: PoiId;
  x: number;
  y: number;
  z: number;
  /** Facing its POI (0 = north / -z). */
  yaw: number;
}

/**
 * How far out from its POI's entry each depot stands, along the line from the POI through
 * the entry: the nearest flat spot where a raid started there is not seen by the POI's
 * squads at once (`checkDepots` in the sim gate holds them to it).
 */
const DEPOT_OUT: Record<PoiId, number> = { supply: 18, quarry: 18, relay: 25, pad: 66, wreck: 22, yard: 18, smelter: 25, station: 20, waterworks: 20, lodge: 20, cannery: 12, coldstore: 20 };

/** A depot's place in `DEPOTS` (and in the run's `depots`), from its POI. */
export const depotIndex = (poi: PoiId) => DEPOTS.findIndex((d) => d.poi === poi);

export type ExtractId = "ship" | "flare" | "village" | "boat";

/**
 * Ways off the island, open from the landing on; the player picks one by walking to it.
 * The dropship is right there but has to be called and held for while reinforcements
 * beam in; the plateau pickup is close and quick but needs a flare (top floors of the
 * high-rises); the village pickup needs nothing but a long walk and a wait.
 */
export interface ExtractPoint {
  id: ExtractId;
  name: string;
  short: string;
  x: number;
  z: number;
  radius: number;
  /** Seconds standing inside to leave once it is ready. */
  hold: number;
  /** Seconds from calling until it can be used (the dropship, the boat). */
  call?: number;
  /** Where the robots that beam in while it comes appear round (SHIP_WAVES.radius), for one that is called. */
  waves?: { x: number; z: number };
  needsFlare?: true;
  note: string;
}

export const EXTRACTS: ExtractPoint[] = [
  { id: "ship", name: "発着場のドロップシップ", short: "ドロップシップ", x: AT[3][0], z: 46 + AT[3][1], radius: 5, hold: 1.5, call: 20, waves: { x: POIS[poiIndex("pad")].x, z: POIS[poiIndex("pad")].z }, note: "呼んで 20 秒守る。増援が降りてくる" },
  { id: "flare", name: "台地の回収地点", short: "台地", ...at("heart", { x: -92, z: -8 }), radius: 5, hold: 4, needsFlare: true, note: "発煙筒を焚けば 4 秒" },
  { id: "village", name: "廃村の回収地点", short: "廃村", ...at("village", { x: -45, z: 62 }), radius: 5, hold: 15, note: "遠いが静か。15 秒待つ" },
  // The harbor's way off: a boat comes up the channel to the quay.
  { id: "boat", name: "埠頭のボート", short: "ボート", ...at("bay", { x: 105, z: -580 }), radius: 5, hold: 1.5, call: 25, waves: at("bay", { x: 100, z: -563 }), note: "呼んで 25 秒守る。増援が降りてくる" },
];
export const EXTRACT = EXTRACTS[0];

/**
 * A diesel locomotive 15 m long on a track along x, on ground at 0: its frame, a long hood, and
 * the cab at its east end standing over the hood. Cover a heavy hides behind.
 */
function engine(cx: number, cz: number): Box[] {
  return [box(cx, cz, 15, 2.6, 1.3, "steel", 1), box(cx - 1.5, cz, 11, 2.2, 3.6, "steel", 0, 1.3), box(cx + 5.5, cz, 3, 2.8, 4.4, "steel", 3, 1.3)];
}

/**
 * A substation's walled yard, round (0, 0) on ground at 0: transformers in a row under a busbar
 * frame, a two-storey control house (its upper floor at (6.5, 10)), a store (at (-12, 10)).
 * Gates west and east, and north at x = 10; lines leave from the busbar's ends and middle.
 */
function substationYard(): Box[] {
  return [
    ...compound(0, 0, 48, 36, 2.4, [
      { side: "w", w: 8 },
      { side: "e", w: 8 },
      { side: "n", at: 10, w: 6 },
    ]),
    ...[-12, 0, 12].flatMap((x) => [
      box(x, -7, 4.4, 3.2, 3.4, "steel", 2),
      box(x, -7, 5.2, 1.0, 2.8, "steel", 1, 0.4),
      ...[-1.2, 0, 1.2].map((dx) => box(x + dx, -7.6, 0.3, 0.3, 4.8, "steel", 4, 3.4)),
    ]),
    // The busbar frame over the transformers: two rows of posts, beams across at 10 m and 8 m.
    ...[-18, -6, 6, 18].map((x) => box(x, -11, 0.5, 0.5, 10, "steel", 2)),
    rect(-18.3, -11.3, 18.3, -10.7, 9.6, 10.2, "steel", 2),
    ...[-18, -6, 6, 18].map((x) => box(x, -3, 0.5, 0.5, 8, "steel", 2)),
    rect(-18.3, -3.3, 18.3, -2.7, 7.6, 8.2, "steel", 2),
    ...tower(10, 9, 12, 8, 2, { doors: [["w", "s"]], windows: [["e"], ["n", "e", "s", "w"]] }),
    ...building(-12, 10, 8, 6, 3.4, { doors: ["e", "n"], windows: ["w"] }),
    // Cable drums and a spare transformer waiting by the west gate.
    box(-20, 12, 2.2, 2.2, 2.2, "crate"),
    box(-17.4, 12, 2.2, 2.2, 2.2, "crate"),
    box(-6, 14, 3.6, 2.6, 2.8, "steel", 2),
  ];
}

/**
/**
 * Outposts: settlements (as `HAMLET_FRAMES`) larger than a hamlet, each a piece of the base's
 * works that joins its region's POIs, held by a squad of two. They stand in the open ground
 * between the POIs, so a walk from one POI to the next passes one, and the lines that leave each
 * (`WORKS_LINES`) lead the eye from it to the POIs it serves.
 */
const OUTPOSTS: Hamlet[] = [
  {
    // Between the yard, the smelter and the quay: the power the cranes and the furnaces ran on.
    // A walled yard of transformers under a busbar frame, a two-storey control house, a store.
    id: "substation",
    name: "変電所",
    x: 75,
    z: -675,
    boxes: substationYard(),
    bins: [
      { x: 6.5, z: 10, y: STOREY, table: "smelter" },
      { x: -12, z: 10, table: "yard" },
    ],
    // Its guards watch the yard inside the walls, not the gates: the substation is passed on
    // the way between the POIs, and is fought by walking in, not met by walking by.
    guard: {
      name: "変電所の守備",
      members: [
        { kind: "grunt", x: 0, z: 2, face: S },
        { kind: "grunt", x: 18, z: 4, face: S },
      ],
    },
  },
  {
    // East of the smelter: the fuel the furnaces and the ships burned. White tanks inside a low
    // bund wall, a pump house, a loading bay under a canopy with a tanker left in it.
    id: "fuel",
    name: "燃料基地",
    x: 350,
    z: -750,
    boxes: [
      ...tank(-16, -10, 6.5, 9, "s", 4),
      ...tank(2, -10, 6.5, 9, "s", 4),
      ...tank(-16, 10, 6.5, 9, "n", 4),
      ...tank(2, 10, 6.5, 9, "n", 4),
      // The bund: knee-high, broken where the aisles leave it.
      rect(-25, -19.5, 11, -19, 0, 1.1, "wall", 1),
      rect(-25, 19, 11, 19.5, 0, 1.1, "wall", 1),
      rect(-25.5, -19.5, -25, -4, 0, 1.1, "wall", 1),
      rect(-25.5, 4, -25, 19.5, 0, 1.1, "wall", 1),
      // Pipes between the tanks and the pump house.
      rect(-16, -0.9, 16, -0.3, 2.9, 3.5, "steel", 2),
      rect(-16, 0.3, 16, 0.9, 2.9, 3.5, "steel", 3),
      ...[-12, -4, 6, 14].map((x) => box(x, 0, 0.4, 2.2, 2.9, "steel", 2)),
      ...tower(20, -8, 10, 8, 2, { doors: [["w", "s"]], windows: [["e"], ["n", "e", "s", "w"]] }),
      // The loading bay's canopy on four posts, and the tanker under it.
      ...[[14, 8], [26, 8], [14, 20], [26, 20]].map(([x, z]) => box(x, z, 0.4, 0.4, 5.6, "steel", 2)),
      rect(13.6, 7.6, 26.4, 20.4, 5.6, 6.0, "slab", 1),
      box(20, 14, 2.6, 7, 3.2, "steel", 4, 0.9),
      box(20, 18.6, 2.5, 2.2, 3.0, "steel", 3),
      box(20, 14, 2.4, 9.2, 0.9, "steel", 1),
    ],
    bins: [
      { x: 16.5, z: -8, y: STOREY, table: "smelter" },
      { x: 22.6, z: 11, table: "smelter" },
    ],
    // Its guards face the pump house and the coast beyond it, away from the ways in from the POIs.
    guard: {
      name: "燃料基地の守備",
      members: [
        { kind: "grunt", x: -7, z: 0, face: E },
        { kind: "charger", x: 9, z: 14, face: E },
      ],
    },
  },
  {
    // West of the yard: where the freight line ended and trains were made up for the yard.
    // Three sidings with wagons left on them, a loading shed with a mezzanine, the yard office.
    id: "freight",
    name: "貨物操車場",
    x: -335,
    z: -700,
    boxes: [
      ...hall(0, -16, 40, 14, 7.5, {
        doors: [{ side: "s", at: -10 }, { side: "s", at: 10 }],
        hatches: [{ side: "w" }, { side: "e" }, { side: "n" }],
        windows: ["n"],
        steel: 3,
        columns: 8,
        mezz: [{ side: "n", depth: 3.2, y: 3.6, stair: 12 }],
      }),
      ...[2, 9, 16].flatMap((z) => track(-40, z, 40, z)),
      ...wagon(-22, 2, true, "box", 0),
      ...wagon(-8, 2, true, "flat", 1),
      ...wagon(24, 9, true, "hopper", 2),
      ...wagon(-26, 16, true, "box", 2),
      ...wagon(4, 16, true, "box", 1),
      ...tower(30, 27, 8, 8, 2, { doors: [["w", "s"]], windows: [["e"], ["n", "e", "s", "w"]] }),
      // Buffer stops at the sidings' west ends.
      ...[2, 9, 16].map((z) => box(-41, z, 1.0, 2.6, 1.3, "steel", 0)),
    ],
    bins: [
      { x: -6, z: -21.4, y: 3.6, table: "yard" },
      { x: 27.5, z: 27, y: STOREY, table: "yard" },
    ],
    guard: {
      name: "操車場の守備",
      members: [
        { kind: "grunt", x: 0, z: 24, face: N },
        { kind: "drone", x: -18, z: 24, face: W },
      ],
    },
  },
  {
    // West of the wreck, on the old shore: where ore came in by rail and went out by ship. An
    // open loading shed with a mezzanine, ore heaps, a crane tower climbed three storeys under its boom, the end of
    // the freight line's spur with wagons on it, the wharf office.
    id: "wharf",
    name: "荷揚げ場",
    x: -280,
    z: -965,
    boxes: [
      ...hall(0, -10, 44, 16, 9, {
        doors: [{ side: "s", at: -12 }, { side: "s", at: 12 }],
        hatches: [{ side: "w" }, { side: "e" }],
        windows: ["n"],
        steel: 0,
        columns: 8,
        mezz: [{ side: "n", depth: 3, y: 4.5, stair: 14 }],
      }),
      ...track(-30, 6, 22, 6),
      ...wagon(-16, 6, true, "hopper", 0),
      ...wagon(-1.5, 6, true, "flat", 0),
      box(-31, 6, 1.0, 2.6, 1.3, "steel", 0),
      // Ore heaps, stepped, as tall as a man and twice that.
      box(-14, 18, 10, 7, 2.2, "rock", 0),
      box(-14, 18, 6, 4, 4.0, "rock", 1),
      box(6, 19, 8, 6, 2.6, "rock", 0),
      ...lattice(26, 14, 5, 5, 3, 22),
      rect(23.5, 13.4, 42, 14.6, 20, 21, "steel", 0),
      ...building(-26, 18, 7, 6, 3.4, { doors: ["e", "n"], windows: ["w"] }),
    ],
    bins: [
      { x: -8, z: -16.5, y: 4.5, table: "wreck" },
      { x: -26, z: 18, table: "wreck" },
    ],
    // Its guards face the shed and the coast, away from the wreck and the fishing village.
    guard: {
      name: "荷揚げ場の守備",
      members: [
        { kind: "grunt", x: 2, z: 12, face: N },
        { kind: "drone", x: 16, z: 22, face: W },
      ],
    },
  },
  {
    // East of the viaduct, where the railway came down into the harbor: the locomotives' shed with
    // its tracks in through roller doors, one engine left inside and one outside, a fuel tank fed
    // by the pipeline from the fuel depot, the two-storey depot office.
    id: "engine",
    name: "保線基地",
    x: 215,
    z: -510,
    boxes: [
      ...hall(0, -6, 40, 16, 8, {
        doors: [{ side: "w", at: -3 }, { side: "w", at: 4 }],
        hatches: [{ side: "e" }, { side: "s" }],
        windows: ["n", "s"],
        steel: 3,
      }),
      ...track(-34, -9, 18, -9),
      ...track(-34, -2, 18, -2),
      ...engine(4, -9),
      ...engine(-26, -2),
      ...tank(24, 14, 3.5, 6, "w", 4),
      ...tower(-16, 14, 8, 8, 2, { doors: [["e", "s"]], windows: [["w"], ["n", "e", "s", "w"]] }),
      box(4, 14, 6.2, 2.5, 2.6, "container", 1),
      box(-35, -9, 1.0, 2.6, 1.3, "steel", 0),
      box(-35, -2, 1.0, 2.6, 1.3, "steel", 0),
    ],
    bins: [
      { x: -18.5, z: 14, y: STOREY, table: "smelter" },
      { x: 14, z: -12.5, table: "smelter" },
    ],
    // Its guards face the depot's own yard and the coast east of it, away from the road under the viaduct.
    guard: {
      name: "保線基地の守備",
      members: [
        { kind: "grunt", x: 2, z: 7, face: E },
        { kind: "charger", x: 20, z: 6, face: N },
      ],
    },
  },
  // --- the reservoir
  {
    // North of the relay's mesa, past the railway: the dam's power stepped down for the relay and
    // the works. The same yard as the harbor's substation.
    id: "eastSubstation",
    name: "東の変電所",
    x: 300,
    z: -175,
    boxes: substationYard(),
    bins: [
      { x: 6.5, z: 10, y: STOREY, table: "relay" },
      { x: -12, z: 10, table: "relay" },
    ],
    // Its guards watch the yard inside the walls, not the gates (as the harbor's).
    guard: {
      name: "東の変電所の守備",
      members: [
        { kind: "grunt", x: 0, z: 2, face: S },
        { kind: "grunt", x: 18, z: 4, face: S },
      ],
    },
  },
  {
    // Between the relay and the east coast: the pumps that lifted water for the works, the housing
    // and the water tower. A pump hall with a mezzanine, two low settling tanks, pipes between, an office.
    id: "pumps",
    name: "揚水ポンプ場",
    x: 375,
    z: 185,
    boxes: [
      ...hall(0, -8, 24, 12, 7, {
        doors: [{ side: "s", at: -5 }],
        hatches: [{ side: "w" }, { side: "e" }],
        windows: ["n"],
        steel: 3,
        mezz: [{ side: "n", depth: 3, y: 3.6, stair: 6 }],
      }),
      ...tank(-16, 14, 6, 3.2, "n", 2),
      ...tank(2, 15, 6, 3.2, "n", 2),
      rect(-16, 4.4, 10, 5.0, 2.8, 3.4, "steel", 3),
      ...[-14, -4, 6].map((x) => box(x, 4.7, 0.4, 0.4, 2.8, "steel", 2)),
      ...building(18, 12, 7, 6, 3.4, { doors: ["w", "n"], windows: ["e"] }),
    ],
    bins: [
      { x: -6, z: -12.5, y: 3.6, table: "relay" },
      { x: 18, z: 12, table: "relay" },
    ],
    // Its guards face the pump hall and the coast, away from the relay and the ranch.
    guard: {
      name: "揚水ポンプ場の守備",
      members: [
        { kind: "grunt", x: -4, z: 2, face: N },
        { kind: "charger", x: 11, z: 4, face: E },
      ],
    },
  },
];

/**
 * A town: where the base's people lived, built along a street as a town is, its houses facing the
 * road, shops across from them, a filling station on the corner and a side street off the main
 * one, with a squad walking its streets. Each building (a group of boxes) stands at the level of
 * the ground under its own middle, so the town follows the lie of the land and its streets are the
 * open ground between; a bin names the building it is in.
 */
interface Town {
  name: string;
  x: number;
  z: number;
  /** Its buildings, each written round the town's middle on ground at 0. */
  buildings: Box[][];
  bins: { building: number; x: number; z: number; y?: number; table: PoiId }[];
  /** Written in the town's frame; its members stand on the ground. */
  guard: Squad;
}

const TOWN_FRAMES: Town[] = [
  {
    // On the lakebed's south shore, the ring road its main street (z about -8 in its frame), the
    // side street south off it at x = 3 (`STREETS`' 町の横通り).
    name: "湖畔の町",
    x: -55,
    z: 245,
    buildings: [
      // North of the main street: a row of two-storey houses, their doors on the street, a small
      // square, and the block of flats the town is seen by.
      rowHouses(-38, -19.5, 5, 8, 10, 2),
      [box(7, -20, 2.4, 2.4, 0.8, "wall", 1), box(4, -14.5, 2.2, 0.6, 0.5, "crate"), box(10, -14.5, 2.2, 0.6, 0.5, "crate")],
      tower(24, -19.5, 14, 10, 3, { doors: [["s", "w"]], windows: [["e"], ["n", "e", "s", "w"], ["n", "e", "s", "w"]] }),
      // South of it: a row of shops, their doors on the street, outside stairs up to two roofs.
      ...[-34, -25, -16, -7].map((x, i) => building(x, 5, 8, 9, 3.6, { doors: ["n"], windows: ["s"], ...(i % 2 === 0 ? { roof: "s" as const } : {}) })),
      // The filling station on the corner: a canopy over two pumps, the kiosk behind.
      [
        ...[[16, 0], [30, 0], [16, 10], [30, 10]].map(([x, z]) => box(x, z, 0.4, 0.4, 5.2, "steel", 2)),
        rect(15.5, -0.5, 30.5, 10.5, 5.2, 5.7, "slab", 1),
        box(20, 5, 1.0, 1.6, 1.8, "steel", 3),
        box(26, 5, 1.0, 1.6, 1.8, "steel", 3),
      ],
      building(23, 18, 10, 6, 3.4, { doors: ["n", "w"], windows: ["e"] }),
      // Along the side street: a house each side, a yard wall behind one.
      [...tower(-10, 30, 10, 8, 2, { doors: [["e", "s"]], windows: [["w"], ["n", "e", "w"]] }), rect(-16, 37, -4, 37.4, 0, 1.6, "wall", 1)],
      building(16, 32, 9, 8, 3.4, { doors: ["w"], windows: ["e", "s"] }),
    ],
    bins: [
      { building: 2, x: 19, z: -19.5, y: STOREY * 2, table: "supply" },
      { building: 4, x: -25, z: 5, table: "supply" },
      { building: 8, x: 23, z: 18, table: "quarry" },
      { building: 9, x: -12.5, z: 30, y: STOREY, table: "quarry" },
    ],
    // A pair walking the main street and the side street.
    guard: {
      name: "町の見回り",
      members: [
        { kind: "grunt", x: -40, z: -6, face: E },
        { kind: "charger", x: -38.6, z: -4.6, face: E },
      ],
      patrol: [{ x: -40, z: -6 }, { x: 36, z: -6 }, { x: 3, z: -6 }, { x: 3, z: 40 }, { x: 3, z: -6 }],
    },
  },
];

/** The towns placed: each building at the level of the ground under its middle, the bins in theirs. */
const TOWNS = TOWN_FRAMES.map((t) => {
  const levels = t.buildings.map((b) => {
    const xs = b.flatMap((q) => [q.x0, q.x1]);
    const zs = b.flatMap((q) => [q.z0, q.z1]);
    return floorLevel(t.x + (Math.min(...xs) + Math.max(...xs)) / 2, t.z + (Math.min(...zs) + Math.max(...zs)) / 2);
  });
  return {
    ...t,
    boxes: t.buildings.flatMap((b, k) => onLevel(levels[k], place(t.x, t.z, b))),
    bins: t.bins.map((b) => ({ x: b.x + t.x, z: b.z + t.z, y: levels[b.building] + (b.y ?? 0), table: b.table })),
  };
});

/**
 * Squads between the POIs. Beating them is optional. Most of the ground between the POIs is
 * quiet: one squad holds the drowned town, and a few walk the roads and the open ground
 * between the areas, met on the way rather than found at a post.
 */
export const ROAMERS: Squad[] = (
  [
    // The drowned town, in the heart's frame: a lookout at the church door and a walker round its
    // streets, both on the mud where they can be fought from the ground.
    ["heart", { name: "教会の見張り", members: [{ kind: "grunt", x: -12, z: 24, face: S }] }],
    [
      "heart",
      {
        name: "旧市街の見回り",
        members: [{ kind: "grunt", x: 0, z: 22, face: E }],
        patrol: [{ x: 0, z: 22 }, { x: 0, z: -32 }, { x: 50, z: -32 }, { x: 50, z: 0 }],
      },
    ],
    // Across the open ground between the areas, in the world's coordinates.
    [
      null,
      {
        name: "西の野の巡回",
        roam: true,
        members: [{ kind: "grunt", x: -150, z: 140 }, { kind: "drone", x: -148, z: 142 }],
        patrol: [{ x: -150, z: 140 }, { x: -190, z: 80 }, { x: -150, z: 20 }, { x: -190, z: 80 }],
      },
    ],
    [
      null,
      {
        name: "東の野の巡回",
        roam: true,
        members: [{ kind: "grunt", x: 140, z: 60 }, { kind: "charger", x: 141.4, z: 61.4 }],
        patrol: [{ x: 140, z: 60 }, { x: 160, z: 120 }, { x: 140, z: 60 }, { x: 150, z: 10 }],
      },
    ],
    // Between the regions.
    [
      null,
      {
        name: "峠道の巡回",
        roam: true,
        members: [{ kind: "grunt", x: -60, z: -230 }, { kind: "drone", x: -58, z: -228 }],
        patrol: [{ x: -60, z: -230 }, { x: -90, z: -350 }, { x: -96, z: -430 }, { x: -90, z: -350 }],
      },
    ],
    // The harbor.
    [
      null,
      {
        name: "高架下の巡回",
        roam: true,
        members: [{ kind: "grunt", x: 164, z: -436 }, { kind: "charger", x: 162.6, z: -434.6 }],
        patrol: [{ x: 164, z: -436 }, { x: 164, z: -611 }, { x: 25, z: -610 }, { x: 164, z: -611 }],
      },
    ],
    [
      "bay",
      {
        name: "塩田の巡回",
        roam: true,
        members: [{ kind: "grunt", x: -40, z: -480 }, { kind: "drone", x: -36, z: -482 }],
        patrol: [{ x: -40, z: -480 }, { x: 60, z: -480 }, { x: 60, z: -518 }, { x: -40, z: -518 }],
      },
    ],
  ] satisfies [AreaId | null, Squad][]
)
  .map(([a, sq]) => (a ? placeSquad(sq, AREA[a][0], AREA[a][1]) : placeSquad(sq, 0, 0)))
  .concat(
    // Each outpost's guard stands on its outpost's ground, flat at the level under its middle (as `HAMLETS`).
    OUTPOSTS.flatMap((o) => {
      if (!o.guard) return [];
      const level = floorLevel(o.x, o.z);
      const members = o.guard.members.map((m) => ({ ...m, x: m.x + o.x, z: m.z + o.z, y: level + (m.y ?? 0) }));
      return [{ ...o.guard, members, patrol: o.guard.patrol?.map((q) => ({ x: q.x + o.x, z: q.z + o.z })) }];
    }),
    // Each town's guard walks its streets, on the ground as a roamer does.
    TOWN_FRAMES.map((t) => placeSquad(t.guard, t.x, t.z)),
  );

/**
 * Drone packs (`PACK` in config.ts), in the world's coordinates: each flies its loop over the open
 * ground between the POIs and along the roads, clear of every POI's own ground, and is met on the
 * way from one POI to the next. A raid starts each at one of its waypoints far from the player,
 * so the members' places here only say how many there are and of what kind.
 */
export const PACKS: Squad[] = [
  // The reservoir: the ground south of the lakebed that the ways between the quarry, the supply
  // depot and the relay share, its west half with the quarry's side and its east half with the
  // relay's side up to the landing pad; and an arc north of the pad.
  {
    name: "西の野のドローン群",
    members: [{ kind: "drone", x: -200, z: 260 }, { kind: "drone", x: -200, z: 260 }],
    patrol: [{ x: -200, z: 260 }, { x: -60, z: 250 }, { x: -110, z: 140 }, { x: -185, z: 105 }],
  },
  {
    name: "東の野のドローン群",
    members: [{ kind: "drone", x: 60, z: 250 }, { kind: "drone", x: 60, z: 250 }],
    patrol: [{ x: 60, z: 250 }, { x: 200, z: 230 }, { x: 170, z: 110 }, { x: 140, z: -40 }, { x: 110, z: 120 }],
  },
  {
    name: "発着場の北のドローン群",
    members: [{ kind: "drone", x: -200, z: 0 }, { kind: "drone", x: -200, z: 0 }],
    patrol: [{ x: -200, z: 0 }, { x: -130, z: -170 }, { x: 60, z: -230 }, { x: 190, z: -110 }, { x: 60, z: -230 }, { x: -130, z: -170 }],
  },
  // The harbor: over the ground between the yard and the smelter, and round the wreck.
  {
    name: "港の野のドローン群",
    members: [{ kind: "drone", x: -90, z: -640 }, { kind: "drone", x: -90, z: -640 }],
    patrol: [{ x: -90, z: -640 }, { x: -110, z: -780 }, { x: 100, z: -730 }, { x: 90, z: -640 }],
  },
  {
    name: "湾のドローン群",
    members: [{ kind: "drone", x: -200, z: -860 }, { kind: "drone", x: -200, z: -860 }],
    patrol: [{ x: -250, z: -960 }, { x: -130, z: -1030 }, { x: 60, z: -1030 }, { x: 40, z: -880 }, { x: 60, z: -1030 }, { x: -130, z: -1030 }],
  },
];

/** Stable names for the outposts (`OUTPOSTS`): places to loot with a guard squad of their own, not nodes of the front. */
export type OutpostId = "substation" | "fuel" | "freight" | "wharf" | "engine" | "eastSubstation" | "pumps";

/** The robots' two factions (see FACTION): the network (網) and the rogues that broke off it (野良機). */
export type Faction = "net" | "rogue";

/** An outpost as the factions see it: where it stands, its region, and the name of the squad that holds it. */
export interface OutpostSite {
  id: OutpostId;
  name: string;
  region: RegionId;
  x: number;
  z: number;
  guard: string;
}

export const OUTPOST_SITES: OutpostSite[] = OUTPOSTS.map((o) => ({
  id: o.id!,
  name: o.name,
  // The reservoir lies south of the mountain belt (+z), the harbor north of it.
  region: o.z > -350 ? "reservoir" : "harbor",
  x: o.x,
  z: o.z,
  guard: o.guard?.name ?? "",
}));

export const outpostSite = (id: OutpostId): OutpostSite => OUTPOST_SITES.find((o) => o.id === id) ?? OUTPOST_SITES[0];

/**
 * Squads that walk out between the POIs, outposts and roads (`STREETS`) rather than hold a post,
 * in the world's coordinates. Each walks its `nodes` out and back by the ground's way (hunt.ts's
 * `walkLine()`), so a node is a place on its walk (a junction, an outpost's gate, a POI's way
 * in), not a straight leg. A beat is walked by squads of a POI's garrison (`from`): about half of
 * each POI's strength, so a POI is a smaller fight and the ground between is where most squads
 * are met. A patrol walks a road; a convoy, heavier, walks the network's nodes from one end of the
 * region to the other. A round is a pair whose walk runs through POIs' grounds, past their posts
 * and bins, so a player looting there meets walkers; like a beat it comes to gunfire only as
 * near as a post would, so it does not pile onto every fight at the POIs it passes. Rogue walks
 * (`faction: "rogue"`) are the rogues': those with `rank` while
 * the enemy is weak enough (`ROGUE.patrols`), the others in every raid.
 */
export interface Mobile {
  name: string;
  kind: "beat" | "patrol" | "convoy" | "round";
  faction: Faction;
  region: RegionId;
  /** A beat: the POI whose garrison squad (by name) walks it. */
  from?: { poi: PoiId; squad: string };
  /** A patrol's or convoy's members. */
  members?: EnemyKind[];
  rank?: number;
  nodes: (readonly [number, number])[];
}

export const MOBILES: Mobile[] = [
  // --- the reservoir: the ring of roads south of the lakebed, the mesa's foot, the ways north-west.
  { name: "補給所の北の巡回", kind: "beat", faction: "net", region: "reservoir", from: { poi: "supply", squad: "組立棟東" }, nodes: [[0, 296], [0, 236], [88, 204], [160, 205]] },
  { name: "湖畔の巡回", kind: "beat", faction: "net", region: "reservoir", from: { poi: "supply", squad: "砂丘" }, nodes: [[0, 296], [0, 236], [-110, 238]] },
  { name: "西の環状路の巡回", kind: "beat", faction: "net", region: "reservoir", from: { poi: "quarry", squad: "坂上" }, nodes: [[-110, 238], [-170, 110], [-265, 10]] },
  { name: "北西の道の巡回", kind: "beat", faction: "net", region: "reservoir", from: { poi: "quarry", squad: "掘削機" }, nodes: [[-265, 10], [-209, -77], [-215, -95]] },
  { name: "台地の麓の巡回", kind: "beat", faction: "net", region: "reservoir", from: { poi: "relay", squad: "大皿" }, nodes: [[125, 75], [200, 108], [187, 32], [210, -50]] },
  { name: "台地の東の巡回", kind: "beat", faction: "net", region: "reservoir", from: { poi: "relay", squad: "南東の縁" }, nodes: [[210, -50], [271, -148], [360, -60]] },
  { name: "環状路の警邏", kind: "patrol", faction: "net", region: "reservoir", members: ["grunt", "drone"], nodes: [[0, 236], [88, 204], [250, 205], [200, 108]] },
  { name: "補給の車列", kind: "convoy", faction: "net", region: "reservoir", members: ["heavy", "grunt", "drone"], nodes: [[0, 296], [0, 236], [88, 204], [250, 205], [200, 108], [187, 32], [210, -50], [271, -148]] },
  { name: "ポンプ場の野良機", kind: "patrol", faction: "rogue", region: "reservoir", members: ["grunt", "charger"], nodes: [[342, 190], [309, 191], [250, 205], [200, 108]] },
  { name: "変電所の野良機", kind: "patrol", faction: "rogue", region: "reservoir", members: ["grunt", "grunt"], nodes: [[271, -148], [210, -50], [187, 32]] },
  { name: "西の野良機", kind: "patrol", faction: "rogue", region: "reservoir", rank: 0, members: ["grunt", "drone"], nodes: [[-170, -40], [-117, 274]] },
  { name: "湖畔の野良機", kind: "patrol", faction: "rogue", region: "reservoir", rank: 1, members: ["grunt", "charger"], nodes: [[-117, 274], [-190, 470]] },
  { name: "東の野良機", kind: "patrol", faction: "rogue", region: "reservoir", rank: 2, members: ["grunt", "grunt"], nodes: [[116, 230], [270, 320]] },
  // Pairs whose walks run through the POIs' grounds, past the posts and bins, so a player looting meets walkers.
  { name: "補給所を抜ける警邏", kind: "round", faction: "net", region: "reservoir", members: ["grunt", "drone"], nodes: [[-110, 238], [-50, 411], [24, 504], [0, 534], [74, 438], [88, 204]] },
  { name: "採掘場を抜ける警邏", kind: "round", faction: "net", region: "reservoir", members: ["grunt", "drone"], nodes: [[-265, 10], [-290, 60], [-352, 118], [-235, 150], [-170, 110]] },
  { name: "浜の道の警邏", kind: "round", faction: "net", region: "reservoir", members: ["grunt", "drone"], nodes: [[20, 585], [0, 534], [24, 504], [-50, 411], [-110, 238]] },
  { name: "湖底の町の警邏", kind: "round", faction: "net", region: "reservoir", members: ["grunt", "charger"], nodes: [[-52, 238], [-52, 290], [0, 296], [0, 236], [88, 204]] },
  { name: "採掘穴の警邏", kind: "round", faction: "net", region: "reservoir", members: ["grunt", "drone"], nodes: [[-268, 116], [-316, 116], [-348, 142], [-260, 162]] },
  { name: "発着場の北の警邏", kind: "round", faction: "net", region: "reservoir", members: ["grunt", "drone"], nodes: [[0, -64], [-105, -90], [-215, -95], [-265, 10]] },
  { name: "廃村の外れの警邏", kind: "round", faction: "net", region: "reservoir", members: ["grunt", "drone"], nodes: [[-265, 10], [-215, -95], [-345, -88]] },
  { name: "東の環状路の警邏", kind: "round", faction: "net", region: "reservoir", members: ["grunt", "drone"], nodes: [[0, 236], [88, 204], [250, 205], [200, 108], [187, 32]] },
  // --- the harbor: the yard's, the smelter's and the wreck's roads, the town, the wharf.
  { name: "難破船の西の巡回", kind: "beat", faction: "net", region: "harbor", from: { poi: "wreck", squad: "北の浜" }, nodes: [[-63, -943], [-117, -973], [-245, -965]] },
  { name: "難破船の北の巡回", kind: "beat", faction: "net", region: "harbor", from: { poi: "wreck", squad: "舳先" }, nodes: [[-63, -943], [-67, -800], [-67, -760]] },
  { name: "操車場の道の巡回", kind: "beat", faction: "net", region: "harbor", from: { poi: "yard", squad: "北の列" }, nodes: [[-167, -690], [-240, -680], [-335, -665]] },
  { name: "信号所の巡回", kind: "beat", faction: "net", region: "harbor", from: { poi: "yard", squad: "東の列" }, nodes: [[-167, -690], [-61, -745], [40, -620]] },
  { name: "変電所の通りの巡回", kind: "beat", faction: "net", region: "harbor", from: { poi: "smelter", squad: "裏手" }, nodes: [[166, -697], [105, -675], [40, -620]] },
  { name: "燃料基地への道の巡回", kind: "beat", faction: "net", region: "harbor", from: { poi: "smelter", squad: "北東" }, nodes: [[205, -735], [275, -763]] },
  { name: "港町の警邏", kind: "patrol", faction: "net", region: "harbor", members: ["grunt", "drone"], nodes: [[40, -590], [240, -625], [215, -540]] },
  { name: "燃料基地の野良機", kind: "patrol", faction: "rogue", region: "harbor", members: ["grunt", "grunt", "charger"], nodes: [[315, -750], [262, -845], [235, -890]] },
  { name: "荷揚げ場の野良機", kind: "patrol", faction: "rogue", region: "harbor", members: ["grunt", "grunt", "drone"], nodes: [[-245, -965], [-287, -925], [-300, -815]] },
  { name: "保線基地の野良機", kind: "patrol", faction: "rogue", region: "harbor", members: ["grunt", "charger"], nodes: [[215, -540], [240, -625], [205, -735]] },
  { name: "操車場の野良機", kind: "patrol", faction: "rogue", region: "harbor", members: ["grunt", "grunt"], nodes: [[-335, -665], [-300, -815]] },
  { name: "漁村の野良機", kind: "patrol", faction: "rogue", region: "harbor", rank: 0, members: ["grunt", "charger"], nodes: [[-277, -835], [-281, -588]] },
  { name: "港町の野良機", kind: "patrol", faction: "rogue", region: "harbor", rank: 1, members: ["grunt", "grunt"], nodes: [[240, -625], [264, -864]] },
  { name: "丘の野良機", kind: "patrol", faction: "rogue", region: "harbor", rank: 2, members: ["grunt", "drone"], nodes: [[240, -625], [105, -675], [166, -697]] },
  { name: "ヤードを抜ける警邏", kind: "round", faction: "net", region: "harbor", members: ["grunt", "drone"], nodes: [[-167, -690], [-218, -693], [-172, -723], [-160, -753], [-61, -745]] },
  { name: "製錬所を抜ける警邏", kind: "round", faction: "net", region: "harbor", members: ["grunt", "drone"], nodes: [[105, -675], [166, -697], [152, -717], [158, -779], [198, -765], [205, -735]] },
  { name: "難破船の浜の警邏", kind: "round", faction: "net", region: "harbor", members: ["grunt", "drone"], nodes: [[-245, -965], [-28, -984], [-20, -943], [-4, -932], [110, -955]] },
  { name: "塩田の警邏", kind: "round", faction: "net", region: "harbor", members: ["grunt", "charger"], nodes: [[45, -675], [-61, -745], [-67, -800], [-63, -943]] },
];

export type DebrisId = "southwest" | "easthill" | "quarryeast" | "townwest" | "eastshore" | "saltwest";

/**
 * Where a piece of the ring can come down on a debris fall's day (`DEBRIS`): open, flat ground
 * between the POIs, clear of boxes, away from the ways in and the stops, so the wreck
 * (drawn by the view only) and its guards stand alone in the open. `region` is the region it
 * lies in; `place` words where it is for the event's line.
 */
export interface DebrisSpot {
  id: DebrisId;
  region: RegionId;
  place: string;
  x: number;
  z: number;
  guards: Squad;
}

/** The debris crate's guards at (x, z): a heavy beside it, two drones over it. */
const debrisGuards = (place: string, x: number, z: number): Squad => ({
  name: `${place}の破片の守り`,
  members: [
    { kind: "heavy", x: x + 4, z: z + 3, face: E },
    { kind: "drone", x: x - 5, z: z - 2, face: W },
    { kind: "drone", x: x + 1, z: z - 6, face: N },
  ],
});

export const DEBRIS_SPOTS: DebrisSpot[] = (
  [
    ["southwest", "reservoir", "南西の野", -200, 400],
    ["easthill", "reservoir", "東の丘", 275, 145],
    ["quarryeast", "reservoir", "採掘場の東の野", -160, 60],
    ["townwest", "harbor", "港町の西の野", -110, -580],
    ["eastshore", "harbor", "東の浜の野", 290, -670],
    ["saltwest", "harbor", "塩田の西", -200, -880],
  ] as const
).map(([id, region, place, x, z]) => ({ id, region, place, x, z, guards: debrisGuards(place, x, z) }));

export const debrisIndex = (id: DebrisId) => DEBRIS_SPOTS.findIndex((d) => d.id === id);

export type RegionId = "reservoir" | "harbor";

export type EntryId = "beach" | "checkpoint" | "jetty" | "outskirts" | "quay" | "shore";

/**
 * A way into a region on foot, out on its open ground: a raid that does not start at a depot
 * begins here, with the teammate beside the player, facing in. Each is out of every robot's
 * sight for the first seconds (`checkEntries` in the sim gate holds them to it), and a walk
 * from the nearest POI.
 */
export interface Entry {
  id: EntryId;
  region: RegionId;
  name: string;
  x: number;
  z: number;
  /** Facing in (0 = north / -z). */
  yaw: number;
}

export const ENTRIES: Entry[] = [
  { id: "beach", region: "reservoir", name: "南の浜", x: 20, z: 590, yaw: 0 },
  { id: "checkpoint", region: "reservoir", name: "東の検問道", x: 470, z: -30, yaw: -Math.PI / 2 },
  { id: "jetty", region: "reservoir", name: "西の釣り桟橋", x: -520, z: 140, yaw: Math.PI / 2 },
  { id: "outskirts", region: "harbor", name: "港町の外れ", x: 40, z: -500, yaw: 0 },
  { id: "quay", region: "harbor", name: "埠頭の東の道", x: 215, z: -940, yaw: -Math.PI / 2 },
  { id: "shore", region: "harbor", name: "西の漁村の浜", x: -340, z: -820, yaw: Math.PI / 2 },
];

export const entryOf = (id: EntryId): Entry => ENTRIES.find((e) => e.id === id) ?? ENTRIES[0];

/**
 * The regions a raid can start in. Each holds its own POIs, ways off and ways in; the pass road
 * and the railway join them, so a raid may cross from one to the other on foot.
 */
export interface Region {
  id: RegionId;
  name: string;
  /** A line for the base's start choice. */
  note: string;
  /** Its ways in on foot (`ENTRIES`), the first of them the one offered first. */
  entries: EntryId[];
  /** A line for the base while the player knows none of its ways in and has no depot of it on: how to open it. */
  locked?: string;
  pois: PoiId[];
  exits: ExtractId[];
  /** Where the world map writes the region's name, large and faint under everything. */
  label: { x: number; z: number };
  /** The part of the world the map frames when it shows this region: its land, its ways in and the ends of the ways out of it. */
  bounds: { x0: number; z0: number; x1: number; z1: number };
}

export const REGIONS: Region[] = [
  { id: "reservoir", name: "ダム湖", note: "干上がったダム湖の島。拠点 6 つ、発着場にタイタン", entries: ["beach", "checkpoint", "jetty"], pois: ["supply", "quarry", "relay", "pad", "station", "waterworks"], exits: ["ship", "flare", "village"], label: { x: -330, z: 300 }, bounds: { x0: WORLD.x0, z0: -340, x1: WORLD.x1, z1: WORLD.z1 } },
  { id: "harbor", name: "港湾地帯", note: "干上がった湾の港。拠点 6 つ、どこにもヘビーがいる", entries: ["outskirts", "quay", "shore"], locked: "峠か鉄橋を越えて港町の外れまで歩き、生きて帰ると選べる", pois: ["wreck", "yard", "smelter", "lodge", "cannery", "coldstore"], exits: ["boat"], label: { x: -250, z: -520 }, bounds: { x0: WORLD.x0, z0: WORLD.z0, x1: WORLD.x1, z1: -380 } },
];

export const regionOf = (id: RegionId): Region => REGIONS.find((r) => r.id === id) ?? REGIONS[0];

/** The region a POI belongs to. */
export const poiRegion = (id: PoiId): Region => REGIONS.find((r) => r.pois.includes(id)) ?? REGIONS[0];

/** The region a point lies in: that of the nearest POI. */
export function regionHere(at: { x: number; z: number }): Region {
  let best = POIS[0];
  for (const p of POIS) if (Math.hypot(p.x - at.x, p.z - at.z) < Math.hypot(best.x - at.x, best.z - at.z)) best = p;
  return poiRegion(best.id);
}

/**
 * A small settlement out on the open ground between the areas: a few buildings to look into
 * and fight round, and a bin or two. No robots post at a hamlet; the roads' patrols and the
 * reinforcements pass by. An outpost (`OUTPOSTS`) is a larger one with a squad of its own.
 */
interface Hamlet {
  /** An outpost's stable name (`OutpostId`). */
  id?: OutpostId;
  name: string;
  x: number;
  z: number;
  /** Its boxes, written round (0, 0) on ground at 0. */
  boxes: Box[];
  /** Its bins in the same frame, with the POI whose loot table each uses. */
  bins: { x: number; z: number; y?: number; table: PoiId }[];
  /** An outpost's squad, written in the same frame (`OUTPOSTS`); a hamlet has none. */
  guard?: Squad;
}

const HAMLET_FRAMES: Hamlet[] = [
  // --- the reservoir
  {
    name: "西の農場",
    x: -110,
    z: 270,
    boxes: [
      ...tower(0, 0, 8, 8, 2, { doors: [["s", "e"]], windows: [["w"], ["n", "e", "w"]] }),
      ...building(14, 4, 12, 8, 4.2, { doors: ["w", "e"], windows: ["n"] }),
      ...building(4, 14, 5, 4, 3.0, { doors: ["n"] }),
      box(-8, 12, 0.5, 10, 1.15, "wall", 1),
      box(-2, 18, 12, 0.5, 1.15, "wall", 1),
      box(8, -7, 1.2, 1.2, 0.9, "crate"),
      box(9.2, -7, 1.2, 1.2, 1.8, "crate"),
    ],
    bins: [{ x: 14, z: 4, table: "quarry" }, { x: -2.5, z: -1.5, y: STOREY, table: "quarry" }],
  },
  {
    name: "西の飯場",
    x: -170,
    z: -40,
    boxes: [
      ...building(-8, -6, 6, 5, 3.4, { doors: ["e"], windows: ["s"] }),
      ...building(-8, 6, 6, 5, 3.4, { doors: ["e"], windows: ["n"], roof: "w" }),
      ...building(8, 0, 7, 6, 3.4, { doors: ["w", "s"], windows: ["e"] }),
      box(0, -14, 6.2, 2.5, 2.6, "container", 1),
      ...walls(2, 14, 6, 6, 0, 2.4, ["n", "s"], ["e"]),
    ],
    bins: [{ x: 8, z: 0, table: "quarry" }],
  },
  {
    name: "南の漁師小屋",
    x: -190,
    z: 470,
    boxes: [
      ...building(-6, 0, 7, 6, 3.4, { doors: ["n", "e"], windows: ["s"] }),
      ...building(8, -4, 6, 5, 3.4, { doors: ["w"], roof: "e" }),
      ...walls(4, 12, 10, 6, 0, 2.6, ["s", "n"]),
      box(-8, 10, 1.2, 1.2, 0.9, "crate"),
      box(-6.8, 10, 1.2, 1.2, 1.8, "crate"),
    ],
    bins: [{ x: -6, z: 0, table: "supply" }],
  },
  {
    name: "給水所",
    x: 110,
    z: 230,
    boxes: [
      // The water tower: seen from the shore, a bin on its top floor.
      ...tower(0, 0, 8, 8, 3, { doors: [["s", "w"]], windows: [[], ["n", "e"], ["n", "e", "s", "w"]] }),
      ...building(14, 6, 7, 6, 3.4, { doors: ["w", "n"], windows: ["e"] }),
      ...walls(-14, 8, 6, 6, 0, 2.4, ["e", "w"], ["n"]),
      box(6, -12, 2.5, 6.2, 2.6, "container", 2),
    ],
    bins: [{ x: -2.5, z: 1.5, y: STOREY * 2, table: "relay" }, { x: 14, z: 6, table: "relay" }],
  },
  {
    name: "東の牧場",
    x: 270,
    z: 175,
    boxes: [
      ...tower(0, 0, 8, 8, 2, { doors: [["w", "s"]], windows: [["e"], ["n", "w", "s"]] }),
      ...building(-14, -4, 12, 8, 4.2, { doors: ["e", "w"], windows: ["s"] }),
      ...building(2, 14, 6, 5, 3.4, { doors: ["n"], roof: "e" }),
      box(-14, 8, 10, 0.5, 1.15, "wall", 1),
      box(10, -8, 0.5, 8, 1.15, "wall", 1),
    ],
    bins: [{ x: -14, z: -4, table: "relay" }],
  },
  {
    name: "東の検問所",
    x: 440,
    z: -110,
    boxes: [
      ...tower(0, 0, 8, 8, 2, { doors: [["w", "s"]], windows: [["e"], ["n", "e", "w", "s"]] }),
      ...building(-12, -8, 6, 5, 3.4, { doors: ["e"], roof: "s" }),
      box(12, -6, 6.2, 2.5, 2.6, "container", 0),
      box(12, 4, 2.5, 6.2, 2.6, "container", 1),
      box(-12, 6, 3.4, 0.5, 1.15, "wall", 1),
      box(-13.5, 7.5, 0.5, 3.4, 1.15, "wall", 1),
    ],
    bins: [{ x: -2, z: 1.5, table: "relay" }],
  },
  // --- the harbor
  {
    name: "西の漁村",
    x: -277,
    z: -835,
    boxes: [
      ...building(-10, -6, 7, 6, 3.4, { doors: ["e", "s"], windows: ["w"] }),
      ...building(4, -10, 6, 6, 3.4, { doors: ["s"], windows: ["n"], roof: "e" }),
      ...tower(8, 6, 8, 8, 2, { doors: [["w", "s"]], windows: [["e"], ["n", "e", "w"]] }),
      ...walls(-12, 10, 6, 6, 0, 2.4, ["n", "e"], ["w"]),
      // A boat hauled up and left to rot.
      box(-2, 20, 8, 3, 1.6, "steel", 3),
    ],
    bins: [{ x: -10, z: -6, table: "wreck" }, { x: 6, z: 8, table: "wreck" }],
  },
  {
    name: "北西の倉庫",
    x: -285,
    z: -595,
    boxes: [
      ...tower(0, 0, 16, 10, 2, { doors: [["s", "e"]], windows: [["w"], ["n", "e", "w"]] }),
      ...building(14, 8, 6, 5, 3.4, { doors: ["w"], roof: "s" }),
      box(-12, 10, 6.2, 2.5, 2.6, "container", 1),
      box(-4, 12, 1.2, 1.2, 0.9, "crate"),
    ],
    bins: [{ x: -5, z: 2, table: "yard" }],
  },
  {
    name: "東の燃料所",
    x: 262,
    z: -865,
    boxes: [
      box(-10, -8, 6, 6, 5, "tower", 1),
      box(-10, 4, 6, 6, 5, "tower", 0),
      ...building(6, -4, 8, 6, 3.4, { doors: ["w", "s"], windows: ["e"], roof: "n" }),
      box(8, 10, 6.2, 2.5, 2.6, "container", 2),
      box(-2, 12, 3.4, 0.5, 1.15, "wall", 1),
    ],
    bins: [{ x: 6, z: -4, table: "smelter" }],
  },
  {
    name: "信号所",
    x: -67,
    z: -745,
    boxes: [
      ...tower(0, 0, 8, 8, 3, { doors: [["e", "s"]], windows: [["w"], ["n", "e", "w"], ["n", "e", "s", "w"]] }),
      ...walls(12, 6, 6, 6, 0, 2.4, ["w", "s"], ["n"]),
      box(-8, 8, 1.2, 1.2, 0.9, "crate"),
      box(-6.8, 8, 1.2, 1.2, 1.8, "crate"),
    ],
    bins: [{ x: -2.5, z: 1.5, y: STOREY * 2, table: "yard" }],
  },
  {
    name: "東の丘の家",
    x: 240,
    z: -625,
    boxes: [
      ...building(-6, 0, 7, 6, 3.4, { doors: ["e", "n"], windows: ["s"], roof: "w" }),
      ...building(8, 4, 6, 6, 3.4, { doors: ["w"], windows: ["e"] }),
      box(0, -10, 8, 0.5, 1.15, "wall", 1),
    ],
    bins: [{ x: -6, z: 0, table: "smelter" }],
  },
  ...OUTPOSTS,
];

/**
 * The frames areas are written in, by name: each POI's (`AT`, by its id) and each hamlet's. Data
 * outside the map that points into one of them (the shots gate's cameras) is written in its frame,
 * so moving an area moves it too.
 */
export const FRAMES: Record<string, { x: number; z: number }> = Object.fromEntries([
  ...POI_FRAMES.map((p, i): [string, { x: number; z: number }] => [p.id, { x: AT[i][0], z: AT[i][1] }]),
  ...HAMLET_FRAMES.map((h): [string, { x: number; z: number }] => [h.name, { x: h.x, z: h.z }]),
  ...TOWN_FRAMES.map((t): [string, { x: number; z: number }] => [t.name, { x: t.x, z: t.z }]),
  // The areas' frames (areas.ts), as "area:" and the area's id.
  ...Object.entries(AREA).map(([id, [x, z]]): [string, { x: number; z: number }] => [`area:${id}`, { x, z }]),
]);

/** Names on the world map for the districts and landmarks between the POIs, where each is written. */
export const LANDMARKS: readonly { name: string; x: number; z: number }[] = [
  at("heart", { name: "湖底の旧市街", x: 0, z: 10 }),
  at("heart", { name: "教会", x: -25, z: -24 }),
  at("heart", { name: "取水塔", x: -35, z: -86 }),
  at("supply", { name: "座礁したタンカー", x: 51, z: 128 }),
  at("supply", { name: "組立工場", x: -27, z: -40 }),
  at("supply", { name: "砂丘の崖", x: -140, z: 15 }),
  at("heart", { name: "堤", x: 0, z: -121 }),
  at("heart", { name: "放水路", x: 122, z: -125 }),
  at("heart", { name: "台地", x: -112, z: -26 }),
  at("factory", { name: "工場", x: -55, z: -62 }),
  at("factory", { name: "住宅地", x: -30, z: 62 }),
  at("factory", { name: "立体駐車場", x: 75, z: -12 }),
  at("village", { name: "段々畑", x: 10, z: 30 }),
  at("village", { name: "風車", x: -35, z: -82 }),
  at("relay", { name: "鉄の階段", x: -120, z: 0 }),
  at("relay", { name: "パラボラアンテナ", x: 45, z: -5 }),
  at("anchor", { name: "アンカー", x: 0, z: 0 }),
  at("anchor", { name: "倒れた昇降路", x: -160, z: 16 }),
  at("quarry", { name: "コンベヤー", x: 10, z: -40 }),
  at("quarry", { name: "バケット掘削機", x: 100, z: 12 }),
  at("pass", { name: "峠", x: -60, z: -236 }),
  at("railway", { name: "鉄橋", x: 140, z: -190 }),
  at("railway", { name: "駅", x: 108, z: -228 }),
  at("town", { name: "港町", x: 20, z: -312 }),
  { name: "高架", x: 30, z: -627 },
  at("bay", { name: "塩田", x: -10, z: -480 }),
  at("bay", { name: "灯台", x: -116, z: -538 }),
  at("bay", { name: "水路", x: 140, z: -604 }),
  // The outposts and the works between the harbor's POIs.
  ...[...OUTPOSTS, ...TOWN_FRAMES].map((o) => ({ name: o.name, x: o.x, z: o.z })),
  { name: "貨物線", x: -130, z: -770 },
  { name: "送電線", x: 100, z: -860 },
  { name: "パイプライン", x: 260, z: -910 },
];

/**
 * Open ground off the POIs where a raid may stop, one or more per district and on the ways
 * between: the sim gate checks that each is reached on foot and that reinforcements find a
 * hidden spot a walk away from each.
 */
export const STOPS: readonly { name: string; x: number; z: number }[] = [
  at("factory", { name: "工場", x: 0, z: 0 }),
  at("factory", { name: "住宅地", x: -50, z: 25 }),
  at("heart", { name: "台地", x: -100, z: 8 }),
  at("village", { name: "廃村", x: 10, z: 64 }),
  at("village", { name: "丘", x: -10, z: -50 }),
  at("heart", { name: "放水路", x: 112, z: -112 }),
  at("anchor", { name: "昇降路の通路", x: -117, z: 0 }),
  at("relay", { name: "台地の麓", x: -110, z: 72 }),
  at("quarry", { name: "採掘場の上段", x: -90, z: -40 }),
  at("pass", { name: "峠", x: -60, z: -222 }),
  at("railway", { name: "駅", x: 122, z: -230 }),
  at("town", { name: "港町", x: 20, z: -306 }),
  { name: "高架下", x: 55, z: -609 },
  at("bay", { name: "塩田", x: 10, z: -500 }),
  at("bay", { name: "岬", x: -122, z: -545 }),
];

/**
 * Where hunting parties (`PARTY` in config.ts) go, by region: stops on the open ground between
 * the POIs and hamlets (`STOPS`, `FRAMES`), all on the ground the parties' field covers. A POI's
 * way in would put a party beside the POI's own squads, where a raid's first fight there would
 * meet both; the village, the plateau and the salt flats by the wreck, beside the quieter ways
 * off and a depot, are left out too, and so is the headland, which the ground's field reaches up
 * a slope too steep for a walker.
 */
export const PARTY_STOPS: Record<RegionId, readonly { name: string; x: number; z: number }[]> = {
  reservoir: [stopAt("工場"), stopAt("住宅地"), stopAt("放水路"), stopAt("昇降路の通路"), stopAt("西の飯場"), stopAt("南の漁師小屋")],
  // The signal box's own middle is its house: the party stands on the open ground south of it.
  harbor: [stopAt("港町"), stopAt("高架下"), stopAt("信号所", 0, 14), stopAt("西の漁村"), stopAt("東の丘の家")],
};

/** A party's stop at the stop or hamlet `name`, `dx`, `dz` metres off it. */
function stopAt(name: string, dx = 0, dz = 0): { name: string; x: number; z: number } {
  const at = STOPS.find((q) => q.name === name) ?? FRAMES[name];
  if (!at) throw new Error(`no stop or hamlet named ${name}`);
  return { name, x: at.x + dx, z: at.z + dz };
}

/** The hamlets placed, each flat at the level of the ground under its middle (an outpost's whole yard, a few metres round its boxes). */
const HAMLETS = HAMLET_FRAMES.map((h) => {
  const level = floorLevel(h.x, h.z);
  if (h.guard) {
    const at = place(h.x, h.z, h.boxes);
    FLAT.push({ x0: Math.min(...at.map((b) => b.x0)) - 4, z0: Math.min(...at.map((b) => b.z0)) - 4, x1: Math.max(...at.map((b) => b.x1)) + 4, z1: Math.max(...at.map((b) => b.z1)) + 4, y: level });
  }
  return {
    ...h,
    boxes: onLevel(level, place(h.x, h.z, h.boxes)),
    bins: h.bins.map((b) => ({ ...b, x: b.x + h.x, z: b.z + h.z, y: level + (b.y ?? 0) })),
  };
});

type ExtraBin = { x: number; z: number; y?: number; table: PoiId; flare?: true };

/** Bins outside the POIs, mostly up high. `table` is the POI whose loot table they use. */
export const EXTRA_BINS: ExtraBin[] = (
  [
    at("supply", { x: -140, z: 10, table: "supply" }),
    // The drowned town: on the mud, inside a house, on the plateau's lookout.
    at("heart", { x: 6, z: -4, table: "quarry" }),
    at("heart", { x: 26, z: -18, y: STOREY, table: "quarry" }),
    at("heart", { x: 12, z: 32, table: "quarry" }),
    at("heart", { x: -117, z: -14, y: 7.2, table: "relay" }),
    // The works and the housing: the sawtooth shed's floor and mezzanine, the car park, a flat.
    at("factory", { x: -40, z: -30, table: "relay" }),
    at("factory", { x: -60, z: -18, y: WORKS.storey, table: "relay" }),
    at("factory", { x: 80, z: -35, y: 6.4, table: "relay" }),
    at("factory", { x: -60, z: 45, y: HOME.storey, table: "relay" }),
    at("factory", { x: 40, z: 5, table: "relay" }),
    // The terraced fields: a barn, the temple, a farmhouse's upper floor, the windmill.
    at("village", { x: 20, z: 12, table: "quarry" }),
    at("village", { x: 2, z: -66, y: 0.4, table: "quarry" }),
    at("village", { x: -21, z: 50, y: HOME.storey, table: "quarry" }),
    at("village", { x: -37, z: -70, y: HOME.storey * 2, table: "quarry" }),
    // Top floor of each tall building, on the side away from its stairs. These hold the
    // flares that call the plateau pickup (EXTRACTS).
    ...HIGH_RISES.map((h) => ({ x: h.x - h.w / 2 + 1.5, z: h.z, y: (h.floors - 1) * h.sc.storey, table: "relay" as const, flare: true as const })),
    // The anchor: by its scaffold's foot inside the shaft, and on the gallery at its top (a flare).
    { ...anchorBin(7.5, 7.5, ANCHOR.ringTop), table: "relay" },
    { ...anchorBin(-7.5, 0, ANCHOR_GALLERY), table: "relay", flare: true },
    // The harbor: the town's hut and warehouse, the viaduct and the road under it, a lone bin
    // out on the salt flats, the saddle of the pass.
    at("town", { x: 14, z: -288, table: "yard" }),
    at("town", { x: 56, z: -290, y: STOREY, table: "yard" }),
    { x: 87, z: -615, y: LEVEL.rail, table: "smelter" },
    { x: 55, z: -620, table: "smelter" },
    at("bay", { x: -20, z: -505, table: "wreck" }),
    at("pass", { x: -62, z: -220, table: "yard" }),
    // The lighthouse's top floor, like the high-rises', holds a flare.
    at("bay", { x: LIGHTHOUSE.x - 2.5, z: LIGHTHOUSE.z + 0.5, y: (LIGHTHOUSE.floors - 1) * STOREY, table: "wreck", flare: true }),
  ] satisfies ExtraBin[]
)
  .map((b): ExtraBin => onFloor(b))
  .concat(HAMLETS.flatMap((h) => h.bins))
  .concat(TOWNS.flatMap((t) => t.bins));

/** The records the story contracts send the player for (meta/story.ts), one to each. */
export type RecordId = "tether" | "dam" | "ship" | "network" | "smelter";

/**
 * Where each record lies: a fixed spot inside a named building (`place`), on its floor. Only the
 * record of the story contract under way lies there in a raid. `poi` is the POI the building
 * stands in, when it stands in one.
 */
export interface RecordSpot {
  id: RecordId;
  /** The record itself, as the HUD and the board name it. */
  name: string;
  place: string;
  region: RegionId;
  poi?: PoiId;
  x: number;
  y: number;
  z: number;
}

/** A spot in the heart's frame at the height `y`. */
const heartAt = (fx: number, fz: number, y: number) => {
  const [x, z] = inArea("heart", fx, fz);
  return { x, z, y };
};

/** A spot in POI `id`'s own frame, `y` over the floor under it. */
const inPoi = (id: PoiId, x: number, z: number, y: number) => onFloor({ x: x + POI_AT[id][0], z: z + POI_AT[id][1], y });

export const RECORD_SPOTS: RecordSpot[] = [
  // On the clamp ring inside the anchor's shaft, at the scaffold's foot across from its bin.
  { id: "tether", name: "昇降路の記録", place: "アンカーの縦穴", region: "reservoir", ...onFloor({ ...anchorBin(-7.5, -7.5, ANCHOR.ringTop) }) },
  // The intake tower's fourth storey, on the side by the dam's face.
  { id: "dam", name: "ダムの運転日誌", place: "取水塔の制御室", region: "reservoir", ...heartAt(-37, -97, LEVEL.lakebed + INTAKE.storey * 3) },
  // The bridge at the top of the wreck's stern, beside its vault.
  { id: "ship", name: "最後の航海日誌", place: "難破船の船橋", region: "harbor", poi: "wreck", ...inPoi("wreck", 56, -8, SHIP_DECK + STOREY * 4) },
  // The equipment building's third floor.
  { id: "network", name: "網の設計記録", place: "中継塔の機器棟", region: "reservoir", poi: "relay", ...inPoi("relay", -24, -14, WORKS.storey * 2) },
  // The control building's top floor, over the vault.
  { id: "smelter", name: "製錬所の出荷台帳", place: "製錬所の制御棟", region: "harbor", poi: "smelter", ...inPoi("smelter", 35, -8, WORKS.storey * 4) },
];

export const recordSpot = (id: RecordId): RecordSpot => RECORD_SPOTS.find((r) => r.id === id) ?? RECORD_SPOTS[0];


/**
 * A ramp of shallow steps (risers of 0.2 m) over [x0, x1] x [z0, z1] from height `from` at one end
 * to `to` at the end toward `up`, each step standing on `base`: a car park's ramp between decks.
 */
function ramp(x0: number, z0: number, x1: number, z1: number, from: number, to: number, up: Side, base: number): Box[] {
  const n = Math.ceil(Math.abs(to - from) / 0.2);
  const out: Box[] = [];
  for (let k = 0; k < n; k++) {
    const [t0, t1] = [k / n, (k + 1) / n];
    const h = from + ((to - from) * (k + 1)) / n;
    if (up === "n") out.push(rect(x0, z1 - (z1 - z0) * t1, x1, z1 - (z1 - z0) * t0, base, h, "step"));
    else if (up === "s") out.push(rect(x0, z0 + (z1 - z0) * t0, x1, z0 + (z1 - z0) * t1, base, h, "step"));
    else if (up === "e") out.push(rect(x0 + (x1 - x0) * t0, z0, x0 + (x1 - x0) * t1, z1, base, h, "step"));
    else out.push(rect(x1 - (x1 - x0) * t1, z0, x1 - (x1 - x0) * t0, z1, base, h, "step"));
  }
  return out;
}

/**
 * A steel lattice mast painted in red and white bands, as `lattice()` (platforms with stairs inside
 * up to its `floors`) but with its corner posts and girders banded every `band` metres, so it reads
 * as a radio mast from anywhere it is seen; a dish and a lamp on its top.
 */
function mast(cx: number, cz: number, w: number, floors: number, top: number, band = 6): Box[] {
  const out: Box[] = [];
  for (const b of lattice(cx, cz, w, w, floors, top)) {
    const post = b.h === top && b.x1 - b.x0 < 0.5 && b.z1 - b.z0 < 0.5;
    if (!post) {
      out.push(b.kind === "steel" && b.y0 > floors * STOREY ? { ...b, tint: Math.floor(b.y0 / band) % 2 === 0 ? 0 : 4 } : b);
      continue;
    }
    for (let y = 0; y < top; y += band) out.push({ ...b, y0: y, h: Math.min(top, y + band), tint: Math.floor(y / band) % 2 === 0 ? 0 : 4 });
  }
  out.push(box(cx, cz, 2, 2, top + 1.4, "tower", 1, top));
  return out;
}

/** The side opposite `s`. */
const BACK: Record<Side, Side> = { n: "s", s: "n", e: "w", w: "e" };

/**
 * Stairs bolted to a cliff: from (x, z) on the lower floor, in the frame of area `a`, it looks
 * toward `toward` for the lip of the floor at height `top`, and runs a flight `width` wide from that lip down to `base`, standing
 * on the cliff and the floor below. Laid once the ground is built, which it does not press flat.
 */
function cliffStairs(a: AreaId, fx: number, fz: number, toward: Side, top: number, base: number, width: number, tint: number, kind: BoxKind = "step"): Box[] {
  const [x, z] = inArea(a, fx, fz);
  const [dx, dz] = DIR[toward];
  for (let d = 0; d < 40; d += 0.25)
    if (terrainHeight(x + dx * d, z + dz * d) >= top - 0.15) return paint(lift(base, stairs(x + dx * d, z + dz * d, BACK[toward], width, top - base, tint)), "step", kind, () => tint);
  throw new Error(`no lip at ${top} m from ${fx},${fz} in ${a} toward ${toward}`);
}

/**
 * Stairs bolted to a cliff up to the open ground above it, whatever its height there: as
 * `cliffStairs()`, its top the ground where the cliff's face ends.
 */
function rimStairs(a: AreaId, fx: number, fz: number, toward: Side, base: number, width: number, tint: number, kind: BoxKind = "step"): Box[] {
  const [x, z] = inArea(a, fx, fz);
  const [dx, dz] = DIR[toward];
  let d = 0;
  while (d < 40 && terrainHeight(x + dx * d, z + dz * d) < base + 2) d += 0.25;
  while (d < 60 && terrainHeight(x + dx * (d + 0.5), z + dz * (d + 0.5)) - terrainHeight(x + dx * d, z + dz * d) > 0.15) d += 0.25;
  return cliffStairs(a, fx, fz, toward, terrainHeight(x + dx * d, z + dz * d), base, width, tint, kind);
}

/** Paints the walls a building was built with (tint 0) as dry stone (wall tint 3): a farmhouse, a barn, a windmill. */
const stone = (boxes: Box[]): Box[] => paint(boxes, "wall", "wall", () => 3, (b) => b.tint === 0);

/** The quarry's processing plant on the rim yard, in the quarry's frame, and the conveyor that runs from it down to the floor. */
const PLANT = { x: 10, z: -104 } as const;
const BELT = { x: 10, z0: -91, z1: 18, y0: 9, y1: LEVEL.pit + 6 } as const;

/** A stay cable from (xa, ya) to (xb, yb) at z: blocks stepping along it, not overlapping along x. */
function stay(xa: number, ya: number, xb: number, yb: number, z: number): Box[] {
  const n = Math.ceil(Math.abs(xb - xa) / 0.8);
  const out: Box[] = [];
  for (let i = 0; i < n; i++) {
    const [a, b] = [xa + ((xb - xa) * i) / n, xa + ((xb - xa) * (i + 1)) / n];
    const [p, q] = [ya + ((yb - ya) * i) / n, ya + ((yb - ya) * (i + 1)) / n];
    out.push(rect(Math.min(a, b), z - 0.15, Math.max(a, b), z + 0.15, Math.min(p, q) - 0.15, Math.max(p, q) + 0.15, "steel", 2));
  }
  return out;
}

/**
 * The excavator (`BWE`): what stands on the top terrace, and what reaches out over the terraces
 * below (laid without pressing them flat).
 */
function excavator(): { on: Box[]; out: Box[] } {
  const { root, roof: R, mast: M, wheel: W } = BWE;
  const on: Box[] = [];
  // Crawlers, the frame between them, the turntable, the deck the house stands on: 10 m inside the
  // top terrace's edges, so the ground pressed flat under them leaves the terraces' walls as they are.
  on.push(rect(88, 2, 112, 7, 0, 4.5, "steel", 1), rect(88, 17, 112, 22, 0, 4.5, "steel", 1), rect(92, 7, 108, 17, 1.5, 4.5, "steel", 2));
  on.push(...disc(100, 12, 9, 2, 4.5, 6, "steel", 2), rect(88, 4, 112, 20, 6, 7, "steel", 0));
  // The machine house, its roof walked on: a band of windows down each side, knee rails round the
  // roof open where the boom's walkway leaves it and where the stair tower's bridge comes in.
  on.push(rect(root, 5, 112, 19, 7, R, "steel", 0));
  for (const x of [95, 101, 107]) on.push(rect(x, 4.94, x + 3.5, 5, 12, 14.5, "steel", 3), rect(x, 19, x + 3.5, 19.06, 12, 14.5, "steel", 3));
  on.push(rect(root, 5, 112, 5.15, R, R + 0.5, "steel", 2), rect(root, 18.85, 101.5, 19, R, R + 0.5, "steel", 2), rect(104.5, 18.85, 112, 19, R, R + 0.5, "steel", 2));
  on.push(rect(root, 5.15, root + 0.15, 10.5, R, R + 0.5, "steel", 2), rect(root, 13.5, root + 0.15, 18.85, R, R + 0.5, "steel", 2), rect(111.85, 5.15, 112, 18.85, R, R + 0.5, "steel", 2));
  // The stair tower south of the house, on past the crawlers, and its bridge onto the roof.
  on.push(...lattice(103, 26.5, 6, 7, 5, R + 0.6, ["n"]), rect(101.5, 19, 104.5, 23, R - 0.3, R, "slab", 1));
  on.push(rect(101.5, 19, 101.65, 23, R, R + 0.5, "steel", 2), rect(104.35, 19, 104.5, 23, R, R + 0.5, "steel", 2));
  // The mast: two legs from the roof, a brace and a head.
  on.push(rect(101, 7.5, 102.2, 8.7, R, M, "steel", 0), rect(101, 15.3, 102.2, 16.5, R, M, "steel", 0), rect(101.1, 8.7, 102.1, 15.3, 32, 33, "steel", 0), rect(100.6, 7.1, 102.6, 16.9, M, M + 1.6, "steel", 0));
  const out: Box[] = [];
  // The wheel boom: per step its box girder, the walkway on it and knee rails, the south rail open at the cab.
  BOOM_STEPS.forEach(({ x0, x1, y }, k) => {
    out.push(rect(x0, 10.2, x1, 13.8, y - 3, y - 0.5, "steel", 0), rect(x0, 10.5, x1, 13.5, y - 0.5, y, "slab", 1), rect(x0, 10.5, x1, 10.7, y, y + 0.5, "steel", 2));
    if (k < BWE.cab[0] || k > BWE.cab[1]) out.push(rect(x0, 13.3, x1, 13.5, y, y + 0.5, "steel", 2));
  });
  // The counterweight boom on its post, out over the terrace's east edge, the weight at its end, and the stays.
  out.push(rect(104, 10, 110, 14, R, 20.5, "steel", 0), rect(104.5, 10.3, 122, 13.7, 20.5, 22.5, "steel", 2), rect(120, 8, 128, 16, 15, 23.5, "steel", 1));
  out.push(...stay(101.6, M, 124, 23.5, 12), ...stay(101.6, M, 44, 6, 12));
  // The boom's head and the wheel's axle; the wheel beside it: a rim of rows, two spokes, buckets round it.
  out.push(rect(W.x - 2, 9.8, W.x, 14.2, -3, BWE.end + 0.5, "steel", 0), rect(W.x - 1.2, W.z0 - 1, W.x + 1.2, 14, W.y - 1.2, W.y + 1.2, "steel", 2));
  const ri = W.r - 2.5;
  for (let y = -W.r; y < W.r; y += 1) {
    const m = y + 0.5;
    const wo = Math.sqrt(W.r * W.r - m * m);
    if (Math.abs(m) < ri) {
      const wi = Math.sqrt(ri * ri - m * m);
      out.push(rect(W.x - wo, W.z0, W.x - wi, W.z1, W.y + y, W.y + y + 1, "steel", 0), rect(W.x + wi, W.z0, W.x + wo, W.z1, W.y + y, W.y + y + 1, "steel", 0));
    } else out.push(rect(W.x - wo, W.z0, W.x + wo, W.z1, W.y + y, W.y + y + 1, "steel", 0));
  }
  const hub = Math.sqrt(ri * ri - 0.25);
  out.push(rect(W.x - hub, W.z0 + 1, W.x + hub, W.z1 - 1, W.y - 0.5, W.y + 0.5, "steel", 2), rect(W.x - 0.5, W.z0 + 0.8, W.x + 0.5, W.z1 - 0.8, W.y - ri, W.y + ri, "steel", 2));
  for (let k = 0; k < 12; k++) {
    const a = ((k + 0.5) * Math.PI) / 6;
    const [x, y] = [W.x + 9.7 * Math.cos(a), W.y + 9.7 * Math.sin(a)];
    out.push(rect(x - 0.95, W.z0 - 0.2, x + 0.95, W.z1 + 0.2, y - 0.95, y + 0.95, "steel", 1));
  }
  // The operator's cab beside the walkway's landing, hung off the boom, its bin inside.
  const c = BWE_CAB;
  const [cx, cz] = [(c.x0 + c.x1) / 2, (c.z0 + 0.3 + c.z1) / 2];
  out.push(rect(c.x0, c.z0, c.x1, c.z1, c.y - 0.3, c.y, "slab", 1), rect(c.x0 + 0.6, 13.8, c.x1 - 0.6, 14.8, c.y - 2.8, c.y - 0.3, "steel", 0));
  const holes: Hole[] = [{ side: "n", at: c.door - cx, w: 2.2, head: 2.2 }, { side: "w", w: 2, sill: 1, head: 2.1 }, { side: "e", w: 2, sill: 1, head: 2.1 }, { side: "s", w: 3, sill: 1, head: 2.1 }];
  out.push(...shell(cx, cz, c.x1 - c.x0, c.z1 - c.z0 - 0.3, c.y, c.y + 2.5, holes, "steel", 3, 0.25), rect(c.x0 - 0.1, c.z0 + 0.2, c.x1 + 0.1, c.z1 + 0.1, c.y + 2.5, c.y + 2.8, "slab", 1));
  return { on, out };
}

/**
 * The quarry, in its own frame, built to `WORKS`: the processing plant and its hoppers on the rim
 * yard, the office tower (`HIGH_RISES`) and the bucket-wheel excavator (`BWE`) on the top terrace, a
 * shed, dump trucks on the terraces, a digger and spoil heaps on the floor. The conveyor down into it, the iron stairs between its
 * terraces and the tunnel's roof are laid once the ground is (`QUARRY_WORKS`). Each part is lifted
 * to the floor it stands on.
 */
function quarry(): Floors {
  const S = WORKS.storey;
  const out: Floors = [];
  // The rim yard: the crusher hall with the belt leaving its west wall, two hoppers on legs, a stack.
  out.push([
    LEVEL.shore,
    [
      ...hall(PLANT.x, PLANT.z, 30, 26, S * 3, { scale: WORKS, steel: 0, doors: [{ side: "e", at: -4, w: 7 }], hatches: [{ side: "s", at: -8 }, { side: "w" }], windows: ["e", "w"], mezz: [{ side: "w", depth: 6, y: S, stair: -4 }], columns: 8, roof: "n" }),
      box(PLANT.x + 8, PLANT.z - 6, 2.4, 2.4, S * 3 + 12, "steel", 2, S * 3),
      ...tank(-20, -110, 4, 9, "e", 0, 5),
      ...tank(-20, -98, 4, 9, "e", 0, 5),
      ...[-1, 1].flatMap((sx) => [-110, -98].map((z) => box(-20 + sx * 2.6, z, 0.5, 0.5, 5, "steel", 2))),
      box(45, -110, 9, 2.6, 3.4, "steel", 0),
      box(39.5, -110, 2.4, 2.6, 2.4, "steel", 3),
    ],
  ]);
  // The top terrace: a shed by the haul road, a dump truck, spoil heaps against the walls.
  out.push([
    LEVEL.quarryTop,
    [
      ...building(95, -48, 14, 9, S, { scale: WORKS, doors: ["s", "w"], windows: ["e"] }),
      box(70, 50, 3.4, 9, 3.6, "steel", 0),
      box(70, 44.5, 3.4, 2.6, 2.8, "steel", 3),
      box(-100, -10, 9, 7, 3.2, "rock", 1),
      box(-60, -52, 7, 6, 2.6, "rock"),
      box(112, 30, 6, 5, 2.4, "rock", 1),
      box(-40, 60, 6.2, 2.5, 2.6, "container", 0),
    ],
  ]);
  // The middle terrace: a truck, a fuel bowser, a site hut.
  out.push([
    LEVEL.quarryMid,
    [
      box(55, 30, 3.4, 9, 3.6, "steel", 0),
      box(55, 24.5, 3.4, 2.6, 2.8, "steel", 3),
      box(62, -8, 2.5, 6.2, 2.6, "container", 2),
      ...building(-75, 30, 8, 7, HOME.storey, { scale: HOME, doors: ["e", "s"], windows: ["n"] }),
      box(-20, -22, 7, 5, 2.4, "rock"),
      box(-80, -10, 5, 6, 3, "rock", 1),
    ],
  ]);
  // The bucket-wheel excavator on the top terrace's east end, its boom out over the middle terrace.
  const bwe = excavator();
  out.push([LEVEL.quarryTop, bwe.on], [LEVEL.quarryTop, bwe.out, "loose"]);
  // The floor: a digger at work, spoil heaps and crates, a rock face to fight round.
  out.push([
    LEVEL.pit,
    [
      box(-14, 36, 1.4, 7, 1.2, "steel", 2),
      box(-8.6, 36, 1.4, 7, 1.2, "steel", 2),
      box(-11.3, 36, 6, 6, 4.2, "steel", 0, 1.2),
      box(-11.3, 33, 2, 2, 6.5, "steel", 3, 4.2),
      box(-11.3, 28, 1.2, 8, 7.2, "steel", 0, 6.2),
      box(-11.3, 23, 2.4, 2, 6.2, "steel", 2, 3),
      box(20, 22, 6, 7, 3.2, "rock", 1),
      box(-40, 28, 5, 5, 2.4, "rock"),
      box(10, 38, 1.2, 1.2, 0.9, "crate"),
      box(11.2, 38, 1.2, 1.2, 1.8, "crate"),
      box(-24, 2, 6.2, 2.5, 2.6, "container", 1),
      box(-50, 14, 1.2, 1.2, 0.9, "crate"),
    ],
  ]);
  return out;
}

/**
 * A parabolic dish antenna of aperture radius `r` and focal length `f`, its vertex at (vx, vy, vz),
 * its axis tilted `tilt` from the vertical toward `face`. The bowl is columns over a plan grid
 * `cell` wide that do not overlap, each from the lowest point of the bowl over it (less `thick`) to
 * the highest, so it reads as one stepped shell: white paint, its outer ring grey. The tilt stays
 * under the bowl's own slope at its rim from the vertical, so a column meets the bowl once. Its
 * feed legs from the rim's sides to the receiver at the focus are blocks stepping along them.
 */
interface DishOpts {
  r: number;
  f: number;
  tilt: number;
  face: Side;
  cell: number;
  thick: number;
  /** How wide the grey ring round the rim is. */
  rim: number;
  /** The receiver's cabin at the focus, its half size, and whether feed legs carry it. */
  feed?: number;
}
/** Plan axes of a dish facing `face`: local X runs back from its face, local Z across it. */
function dishAxes(face: Side) {
  const [dx, dz] = DIR[face];
  return { X: [-dx, -dz] as const, Z: [dz, -dx] as const };
}
/** A point of a dish at local (X, y, Z) in the world, for its vertex at (vx, vz). */
function dishPoint(vx: number, vz: number, face: Side, X: number, Z: number): [number, number] {
  const a = dishAxes(face);
  return [vx + X * a.X[0] + Z * a.Z[0], vz + X * a.X[1] + Z * a.Z[1]];
}
/** Blocks stepping from p to q, `t` thick, along the axis they run furthest on, not overlapping along it. */
function strand(p: readonly [number, number, number], q: readonly [number, number, number], t: number, tint: number): Box[] {
  const d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
  const ax = Math.abs(d[0]) >= Math.abs(d[2]) ? 0 : 2;
  const n = Math.max(1, Math.ceil(Math.abs(d[ax]) / 0.8));
  const out: Box[] = [];
  for (let i = 0; i < n; i++) {
    const a = p.map((v, j) => v + (d[j] * i) / n);
    const b = p.map((v, j) => v + (d[j] * (i + 1)) / n);
    const lo = a.map((v, j) => (j === ax ? Math.min(v, b[j]) : Math.min(v, b[j]) - t / 2));
    const hi = a.map((v, j) => (j === ax ? Math.max(v, b[j]) : Math.max(v, b[j]) + t / 2));
    out.push(rect(lo[0], lo[2], hi[0], hi[2], lo[1], hi[1], "steel", tint));
  }
  return out;
}
function dish(vx: number, vy: number, vz: number, o: DishOpts): Box[] {
  const { r, f, tilt, face, cell, thick } = o;
  const [c, s] = [Math.cos(tilt), Math.sin(tilt)];
  const k = s / (4 * f);
  // The bowl's height over local plan (X, Z), and its distance from the axis there squared, or null off it.
  const at = (X: number, Z: number): { y: number; d2: number } | null => {
    const D = c * c - 4 * k * (X + k * Z * Z);
    if (D < 0) return null;
    const u = (c - Math.sqrt(D)) / (2 * k);
    const d2 = u * u + Z * Z;
    return d2 <= r * r ? { y: vy + u * s + (d2 / (4 * f)) * c, d2 } : null;
  };
  const depth = (r * r) / (4 * f);
  const [x0, x1] = [-r * c - depth * s, r * c - depth * s];
  const out: Box[] = [];
  for (let X = x0; X < x1; X += cell)
    for (let Z = -r; Z < r; Z += cell) {
      const mid = at(X + cell / 2, Z + cell / 2);
      if (!mid) continue;
      const ys = [mid.y];
      for (const [a, b] of [[X, Z], [X + cell, Z], [X, Z + cell], [X + cell, Z + cell]]) {
        const q = at(a, b);
        if (q) ys.push(q.y);
      }
      const [px, pz] = dishPoint(vx, vz, face, X, Z);
      const [qx, qz] = dishPoint(vx, vz, face, X + cell, Z + cell);
      const rim = mid.d2 > (r - o.rim) ** 2;
      const [ax, az, bx, bz, lo] = [Math.min(px, qx), Math.min(pz, qz), Math.max(px, qx), Math.max(pz, qz), Math.min(...ys) - thick];
      out.push(rect(ax, az, bx, bz, lo, Math.max(...ys), "steel", rim ? 2 : 4));
      // The backing trusses under the bowl: a cross through the axis and a ring half way out.
      const d = Math.sqrt(mid.d2);
      const back = Math.abs(Z + cell / 2) < cell / 2 || Math.abs(X + cell / 2) < cell / 2 || Math.abs(d - r * 0.55) < cell / 2;
      if (back && !rim) out.push(rect(ax, az, bx, bz, lo - 1.4, lo, "steel", 2));
    }
  if (o.feed) {
    // The receiver at the focus, on legs from the rim either side of the axis and from its far edge.
    const [fx, fz] = dishPoint(vx, vz, face, -f * s, 0);
    const fy = vy + f * c;
    const h = o.feed;
    out.push(rect(fx - h, fz - h, fx + h, fz + h, fy - h, fy + h, "steel", 2));
    const foot = (X: number, Z: number, y: number): [number, number, number] => {
      const [x, z] = dishPoint(vx, vz, face, X, Z);
      return [x, y, z];
    };
    for (const side of [-1, 1]) out.push(...strand(foot(-depth * s, side * (r - cell / 2), vy + depth * c), [fx, fy, fz], 0.5, 2));
    out.push(...strand(foot(r * c - depth * s - cell / 2, 0, vy + r * s + depth * c), [fx, fy, fz], 0.5, 2));
  }
  return out;
}


/**
 * The relay station on the sandstone mesa, in its own frame, built to `WORKS`: the base's station
 * for talking to the ring. The big dish (`BIG_DISH`, 56 m across, its rim 49 m over the top) faces
 * west over the island on its pedestal, an open stair tower up to a gallery at its lowest rim; two
 * small dishes, the red-and-white mast (62 m) towards the north-west corner, the equipment block
 * (`HIGH_RISES`) and a generator hall inside a walled compound, a hut where the ledge road comes
 * up, a fuel tank.
 */
function relay(): Floors {
  const S = WORKS.storey;
  const D = BIG_DISH;
  // The pedestal: a concrete drum, the turntable on it, the yoke's two arms and the elevation axle
  // behind the dish's vertex, and the hub between the axle and the dish.
  const B = { x: D.x + 6 * Math.sin(D.tilt), y: D.y - 6 * Math.cos(D.tilt) };
  const pedestal: Box[] = [
    ...disc(B.x, D.z, 7, 2, 0, 12, "wall", 0),
    rect(B.x - 6, D.z - 13, B.x + 6, D.z + 13, 12, 13, "steel", 2),
    rect(B.x - 2.5, D.z - 12.5, B.x + 2.5, D.z - 10, 13, B.y + 1.6, "steel", 0),
    rect(B.x - 2.5, D.z + 10, B.x + 2.5, D.z + 12.5, 13, B.y + 1.6, "steel", 0),
    rect(B.x - 1.2, D.z - 10, B.x + 1.2, D.z + 10, B.y - 1.2, B.y + 1.2, "steel", 2),
  ];
  for (const t of [0.25, 0.6]) {
    const [hx, hy] = [B.x + (D.x - B.x) * t, B.y + (D.y - B.y) * t];
    pedestal.push(rect(hx - 1.6, D.z - 4.3, hx + 1.6, D.z + 4.3, hy - 1.6, hy + 1.6, "steel", 2));
  }
  const big = BIG_BOWL;
  // The stair tower to the gallery at the dish's lowest rim, the gallery from its top to the rim.
  const [T, rimX, G] = [DISH_STAIRS, DISH_RIM_X, DISH_STAIRS.floors * STOREY];
  const gallery = [...lattice(T.x, T.z, 6, 7, T.floors, G + 0.6, ["e"]), rect(T.x + 3, T.z - 2, rimX, T.z + 2, G - 0.3, G, "slab", 1)];
  gallery.push(rect(T.x + 3, T.z - 2, rimX, T.z - 1.85, G, G + 0.5, "steel", 2), rect(T.x + 3, T.z + 1.85, rimX, T.z + 2, G, G + 0.5, "steel", 2));
  // Two small dishes on concrete posts: one facing south by the north cliff, one west by the generators.
  const small = (x: number, z: number, face: Side) => [rect(x - 1.4, z - 1.4, x + 1.4, z + 1.4, 0, 5.2, "wall", 0), ...dish(x, 6.2, z, { r: 6, f: 4.8, tilt: Math.PI / 4, face, cell: 1.25, thick: 0.3, rim: 0.7, feed: 0.5 })];
  const top: Box[] = [
    ...pedestal,
    ...gallery,
    ...mast(-48, -28, 7, 4, 62),
    ...hall(45, 22, 20, 14, S + 2.5, { scale: WORKS, steel: 3, doors: [{ side: "w" }], hatches: [{ side: "s", at: 4 }], windows: ["n", "s"] }),
    ...tank(60, -30, 4, 8, "w"),
    ...compound(5, -5, 110, 70, 2.4, [
      { side: "w", at: 20, w: 8 },
      { side: "w", at: -22, w: 6 },
      { side: "s", at: -10, w: 8 },
      { side: "e", at: -5, w: 8 },
      { side: "n", at: 20, w: 6 },
    ]),
    ...building(-70, -20, 10, 8, S, { scale: WORKS, doors: ["e", "s"], windows: ["w"], roof: "n" }),
    box(-5, 12, 2.5, 6.2, 2.6, "container", 1),
    box(30, 14, 6.2, 2.5, 2.6, "container", 2),
    box(-40, -12, 6.2, 2.5, 2.6, "container", 0),
    box(10, -32, 1.2, 1.2, 0.9, "crate"),
    box(11.2, -32, 1.2, 1.2, 1.8, "crate"),
    box(34, -16, 4, 0.6, 2.4, "wall"),
    box(-60, 10, 0.6, 5, 1.2, "wall"),
  ];
  // The iron stairs bolted to the west cliff: a stair tower of five storeys from the foot, its
  // roof level with the top, and a catwalk from it across to the top's edge.
  const stairsTower = paint(tower(-106, 0, 8, 8, 5, { scale: WORKS, doors: [["w", "s"]], windows: [[], ["w"], ["w"], ["w"], ["w"]], open: ["e"] }), "wall", "steel", () => 2, (b) => b.tint === 0);
  return [
    [LEVEL.mesa, top],
    // The dishes stand on the top as it is: their bowls hang out past their posts, and pressing the
    // ground flat under a box near the edge would pull the cliff's foot up toward the top.
    [LEVEL.mesa, [...big, ...small(-25, -36, "s"), ...small(64, 20, "w")], "loose"],
    [LEVEL.foot, stairsTower],
    [LEVEL.foot, catwalk(-102, 0, -80, 0, LEVEL.mesa - LEVEL.foot, 2.2, 2), "loose"],
  ];
}

/**
 * The landing pad on top of the dam, in its own frame (the heart's, 190 m north): the titan's
 * arena on the open pad ringed by blast walls, an old runway along its north side, two hangars
 * between them with mezzanines and stairs up their sides to their roofs, the control tower
 * (`HIGH_RISES`) with its glazed cab, fuel tanks, and a parapet along the dam's crest.
 */
function pad(): Box[] {
  const S = WORKS.storey;
  const out: Box[] = [
    box(0, 34, 16, 14, 0.25, "pad"),
    box(-20, 8, 2.4, 2.4, 3.8, "wall"),
    box(20, 8, 2.4, 2.4, 3.8, "wall"),
    box(-32, 34, 2.4, 2.4, 3.8, "wall"),
    box(32, 34, 2.4, 2.4, 3.8, "wall"),
    box(-30, 18, 1.2, 1.2, 0.9, "crate"),
    box(30, 18, 1.2, 1.2, 0.9, "crate"),
    box(0, -6, 6.2, 2.5, 2.6, "container", 0),
    box(-36, 46, 4, 8, 2.4, "tower"),
    ...stairs(-34, 46, "e", 2, 2.4),
    box(36, 46, 4, 8, 2.4, "tower"),
    ...stairs(34, 46, "w", 2, 2.4),
  ];
  // The runway's paint: a dashed centre line and the thresholds at both ends.
  for (let x = -100; x <= 100; x += 14) out.push(rect(x - 3.5, -42.3, x + 3.5, -41.7, 0, 0.04, "steel", 4));
  for (const x of [-112, 112]) for (let z = -50; z <= -34; z += 2.6) out.push(rect(x - 3, z - 0.5, x + 3, z + 0.5, 0, 0.04, "steel", 4));
  for (const sx of [-1, 1] as const)
    out.push(
      ...hall(sx * 72, -5, 40, 28, S * 3, {
        scale: WORKS,
        steel: 2,
        doors: [{ side: "n", w: 14 }],
        hatches: [{ side: "s", at: -sx * 10 }, { side: sx < 0 ? "e" : "w", at: 4 }],
        windows: ["s"],
        mezz: [{ side: "s", depth: 6, y: S, stair: sx * 8 }],
        columns: 10,
        roof: sx < 0 ? "w" : "e",
      }),
      box(sx * 72, 18, 6.2, 2.5, 2.6, "container", sx < 0 ? 0 : 1),
    );
  // The control tower's cab: glass all round on its roof, an aerial over it.
  const top = PAD_TOWER.floors * S;
  const holes: Hole[] = SIDES.flatMap((side) => [-2.5, 2.5].map((at) => ({ side, at, w: 3.2, sill: 0.9, head: 2.4 })));
  out.push(...shell(PAD_TOWER.x, PAD_TOWER.z, 10, 10, top, top + 2.7, holes));
  out.push(box(PAD_TOWER.x, PAD_TOWER.z, 10.6, 10.6, top + 3.0, "slab", 1, top + 2.7));
  out.push(box(PAD_TOWER.x + 3, PAD_TOWER.z - 3, 0.3, 0.3, top + 9, "steel", 2, top + 3.0));
  out.push(...tank(98, 38, 5, 9, "w", 0), ...tank(98, 54, 4, 7, "w", 1));
  return out;
}

/**
 * A round of radius r about (cx, cz) from y0 to h, built of columns `step` wide along x that do not
 * overlap (so their tops never fight on screen), each as deep as the round at its middle.
 */
function disc(cx: number, cz: number, r: number, step: number, y0: number, h: number, kind: BoxKind, tint = 0): Box[] {
  const out: Box[] = [];
  const n = Math.round((2 * r) / step);
  for (let i = 0; i < n; i++) {
    const x0 = cx - r + i * step;
    const hz = Math.sqrt(r * r - (x0 + step / 2 - cx) ** 2);
    out.push(rect(x0, cz - hz, x0 + step, cz + hz, y0, h, kind, tint));
  }
  return out;
}

/** How far the edge of `disc(0, 0, r, step)` lies from its middle along z at x = 0 (the column there). */
const discEdge = (r: number, step: number) => Math.sqrt(r * r - (step / 2) ** 2);

/**
 * The anchor of the tether that once climbed from here to the orbital ring, in its own frame, in
 * heights over the landing pad (`ANCHOR`): the concrete plinth, the clamp ring on it with stairs up
 * every side and four anchor blocks, and the shaft that held the tether's root. The shaft is of the
 * tether's pale composite, banded and railed at its corners, and broken off at different heights on
 * each side, scorched where it broke; doors at its foot open on a steel scaffold that climbs nine
 * storeys inside it to a gallery with windows all round. The stairs up the plinth's sides from the
 * ground round it are laid once the ground is built (`LAID`).
 */
function anchor(): Box[] {
  const { r, top, foot, ring, ringTop, shaft: S, wall: T, floors } = ANCHOR;
  const G = ANCHOR_GALLERY;
  const out: Box[] = [...disc(0, 0, r, 6, foot, top, "wall", 0), ...disc(0, 0, ring, 5.5, top, ringTop, "wall", 1)];
  // Up onto the clamp ring from the plinth, on every side.
  const edge = discEdge(ring, 5.5);
  for (const side of SIDES) {
    const [dx, dz] = DIR[side];
    const e = dz !== 0 ? edge : ring;
    out.push(...lift(top, stairs(dx * e, dz * e, side, dz !== 0 ? 8 : 5, ringTop - top)));
  }
  // The anchor blocks the tether's cables were made fast to.
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) out.push(box(sx * 13, sz * 13, 5, 5, ringTop + 4.5, "tower", 0, ringTop));
  // The shaft: up to the gallery, doors north and south and tall slits for light; the gallery's
  // band of windows; then the broken walls above it, each side ending at its own height.
  const slits: Hole[] = SIDES.flatMap((side) => [-6.5, 6.5].map((at) => ({ side, at, w: 1.4, sill: 4, head: G - ringTop - 2.5 })));
  out.push(...shell(0, 0, 2 * S, 2 * S, ringTop, G - 0.3, [{ side: "s", w: 6, head: 8 }, { side: "n", w: 6, head: 8 }, ...slits], "steel", 5, T));
  out.push(...shell(0, 0, 2 * S, 2 * S, G - 0.3, G + 3.7, SIDES.flatMap((side) => [-6, 0, 6].map((at) => ({ side, at, w: 3.5, sill: 1.2, head: 3.6 }))), "steel", 5, T));
  const I = S - T;
  const tops: Record<Side, number> = { n: 92, e: 80, s: 70, w: 86 };
  const wallAt: Record<Side, (y0: number, h: number, a?: number, b?: number) => Box> = {
    n: (y0, h, a = -S, b = S) => rect(a, -S, b, -I, y0, h, "steel", 5),
    s: (y0, h, a = -S, b = S) => rect(a, I, b, S, y0, h, "steel", 5),
    w: (y0, h, a = -I, b = I) => rect(-S, a, -I, b, y0, h, "steel", 5),
    e: (y0, h, a = -I, b = I) => rect(I, a, S, b, y0, h, "steel", 5),
  };
  const scorch = (b: Box): Box => ({ ...b, tint: 7 });
  for (const side of SIDES) out.push(wallAt[side](G + 3.7, tops[side] - 5), scorch(wallAt[side](tops[side] - 5, tops[side])));
  // Jagged teeth left standing over the breaks.
  out.push(scorch(wallAt.n(tops.n, tops.n + 7, -S, -6)), scorch(wallAt.n(tops.n, tops.n + 3.5, 2, 5)));
  out.push(scorch(wallAt.w(tops.w, tops.w + 6, 3, I)), scorch(wallAt.e(tops.e, tops.e + 9, -I, -4)), scorch(wallAt.s(tops.s, tops.s + 5, 5, S)));
  // The guide rails up its corners, the tallest still the highest thing on the island.
  const rails: [number, number, number][] = [[-1, -1, 104], [1, -1, 84], [1, 1, 66], [-1, 1, 78]];
  for (const [sx, sz, h] of rails) out.push(box(sx * (S + 0.3), sz * (S + 0.3), 3, 3, h - 3, "steel", 6, ringTop), box(sx * (S + 0.3), sz * (S + 0.3), 3, 3, h, "steel", 7, h - 3));
  // Bands round it every 12 m, below where each side broke.
  for (let y = 14; y < 90; y += 12) {
    if (y > G - 2 && y < G + 5) continue;
    const band: Record<Side, Box> = {
      n: rect(-S - 0.35, -S - 0.35, S + 0.35, -S, y, y + 0.8, "steel", 6),
      s: rect(-S - 0.35, S, S + 0.35, S + 0.35, y, y + 0.8, "steel", 6),
      w: rect(-S - 0.35, -S, -S, S, y, y + 0.8, "steel", 6),
      e: rect(S, -S, S + 0.35, S, y, y + 0.8, "steel", 6),
    };
    for (const side of SIDES) if (y + 0.8 < tops[side] - 5) out.push(band[side]);
  }
  // Inside: the scaffold from the floor to the gallery, open onto it on every side at its top,
  // and the gallery's floor round it to the walls.
  out.push(...lift(ringTop, lattice(0, 0, 10, 10, floors, floors * STOREY + 0.6, ["n", "s", "e", "w"])));
  out.push(...slabWithHole(-I, -I, I, I, G - 0.3, G, -5, -5, 5, 5));
  return out;
}

/**
 * A length of the fallen tether lying along x from x0 to x1 round z = 0 in the anchor's frame,
 * 12 m across: its sides from `foot` up, shoulders stepping in over them, its back's top at `back`, darker ribs
 * every 9 m round it. A broken end (`broken`) is scorched, its back left reaching on past its sides.
 * Hollow (`ceiling`), its floor is a deck at 0 between its sides, under a roof `ceiling` high, its
 * sides open where `breaches` (ranges along x) tore them: a corridor to walk through; else it is
 * solid, to climb onto and to hide behind.
 */
interface TetherPiece {
  x0: number;
  x1: number;
  foot: number;
  back: number;
  broken: { w?: true; e?: true };
  ceiling?: number;
  breaches?: { side: "n" | "s"; a: number; b: number }[];
}

function tetherPiece(t: TetherPiece): Box[] {
  const out: Box[] = [];
  const SCORCH = 1.6;
  // A length along x of one part of the cross-section, its broken ends scorched; `reach` runs it on past the sides there.
  const run = (z0: number, z1: number, y0: number, h: number, reach = 0, a = t.x0, b = t.x1) => {
    const wa = t.broken.w && a === t.x0 ? a - reach : a;
    const eb = t.broken.e && b === t.x1 ? b + reach : b;
    const lo = t.broken.w && a === t.x0 ? wa + SCORCH : wa;
    const hi = t.broken.e && b === t.x1 ? eb - SCORCH : eb;
    out.push(rect(lo, z0, hi, z1, y0, h, "steel", 5));
    if (lo > wa) out.push(rect(wa, z0, lo, z1, y0, h, "steel", 7));
    if (hi < eb) out.push(rect(hi, z0, eb, z1, y0, h, "steel", 7));
  };
  const ribs = (zs: number, y0: number, h: number, skip: (x: number) => boolean = () => false) => {
    for (let x = t.x0 + 4.5; x + 0.8 < t.x1 - 2; x += 9) if (!skip(x)) out.push(rect(x, -zs, x + 0.8, zs, y0, h, "steel", 6));
  };
  // Solid: the sides, a chamfer stepping in over them, and the back, so it reads round from the ground.
  if (t.ceiling === undefined) {
    const [side, chamfer] = [t.back - 3, t.back - 1.5];
    run(-6, 6, t.foot, side);
    run(-5, 5, side, chamfer, 1.2);
    run(-3.5, 3.5, chamfer, t.back, 2.5);
    ribs(6.3, t.foot, side + 0.3);
    ribs(5.3, side, chamfer + 0.3);
    ribs(3.8, chamfer, t.back + 0.25);
    return out;
  }
  const c = t.ceiling;
  // The sides, broken through where breached.
  for (const side of ["n", "s"] as const) {
    const [z0, z1] = side === "n" ? [-6, -4.4] : [4.4, 6];
    const gaps = (t.breaches ?? []).filter((g) => g.side === side).sort((p, q) => p.a - q.a);
    let cur = t.x0;
    for (const g of gaps) {
      run(z0, z1, t.foot, c, 0, cur, g.a);
      cur = g.b;
    }
    run(z0, z1, t.foot, c, 0, cur, t.x1);
  }
  run(-4.8, -3, c, t.back - 1, 1.2);
  run(3, 4.8, c, t.back - 1, 1.2);
  run(-3, 3, c, t.back, 2.5);
  out.push(rect(t.x0, -4.4, t.x1, 4.4, 0, 0.2, "slab"));
  const breached = (x: number) => (t.breaches ?? []).some((g) => x + 0.8 > g.a - 0.5 && x < g.b + 0.5);
  for (const zs of [-1, 1]) for (let x = t.x0 + 4.5; x + 0.8 < t.x1 - 2; x += 9) if (!breached(x)) out.push(rect(x, zs < 0 ? -6.3 : 6, x + 0.8, zs < 0 ? -6 : 6.3, t.foot, c, "steel", 6));
  // Starting inside the roof keeps the rib's underside out of the ceiling's plane, which would flicker.
  ribs(5.1, c + 0.2, t.back - 0.7);
  ribs(3.3, t.back, t.back + 0.3);
  return out;
}

/** The fallen tether's lengths, in the anchor's frame: east of the plinth and west past the pass road, gaps between them to walk through. */
const TETHER = {
  /** The root end, lying from the plinth's east side, its back level with the plinth's top: walked out onto from it. */
  east: { x0: ANCHOR.r, x1: 96 },
  /** Further east, sunk deeper, broken at both ends short of the railway's embankment. */
  far: { x0: 108, x1: 150 },
  /** West of the pass road: hollow, a corridor through it with its sides torn open. */
  corridor: { x0: -150, x1: -84 },
  /** The far west, sunk to its shoulders, stairs of rubble up its south side; it ends short of the village's hill. */
  west: { x0: -250, x1: -162 },
} as const;
/** The corridor's floor: the ground between at its middle, pressed flat under it. */
const TETHER_FLOOR = floorLevel(...inArea("anchor", (TETHER.corridor.x0 + TETHER.corridor.x1) / 2, 0));

/** The parapet along the dam's crest, in the pad's frame, open where the intake tower's catwalk lands and over the inspection gallery's cut. It stands on the crest's edge, which it does not press flat. */
const CREST_PARAPET: Box[] = [rect(-58, 72.4, -37.2, 72.8, 0, 1.0, "wall", 1), rect(-32.8, 72.4, 6.5, 72.8, 0, 1.0, "wall", 1), rect(33.5, 72.4, 58, 72.8, 0, 1.0, "wall", 1)];

/**
 * The dam's face, in the heart's frame, on the lakebed: the intake tower standing in front of it,
 * six storeys of 5 m from the mud to the crest with stairs inside and windows over the lakebed
 * from its second storey up (its ground storey shut, so it is gone down, never climbed into), a
 * catwalk from its roof to the crest; and the outflow pipes lying out from the dam's foot.
 */
function damFace(): Box[] {
  const windows: Side[][] = [[], ["s", "e"], ["s", "w"], ["s", "e", "w"], ["s", "e", "w"], ["s", "e", "w"]];
  const intake = tower(-35, -95, 9, 9, 6, { scale: INTAKE, doors: [[], [], [], [], [], []], windows, open: ["n"] });
  return [
    ...intake,
    box(-12, -96, 3, 15, 3, "steel", 2),
    box(-12, -88.2, 3.6, 0.6, 3.6, "steel", 2),
    box(-4, -97, 3, 13, 3, "steel", 2),
    box(-4, -90.2, 3.6, 0.6, 3.6, "steel", 2),
  ];
}

/**
 * The drowned town on the lakebed, in the heart's frame: houses built to `HOUSE` with stairs up to
 * their roofs and planks between some, so a fight goes from roof to roof; the church with its
 * spire (`HIGH_RISES`, its steeple added here); the piers of the old road bridge across the valley
 * standing out of the mud with a span still on two of them; a bus sunk to its windows.
 */
function heartTown(): Box[] {
  const spire = HIGH_RISES[0];
  const [hx, hz] = AREA.heart;
  const sx = spire.x - hx;
  const sz = spire.z - hz;
  const steeple = spire.floors * STOREY;
  return [
    // The church: a nave of two storeys' height, the spire at its north end, the steeple over it.
    ...hall(-25, 4, 14, 26, 8.5, { hatches: [{ side: "s" }, { side: "e", at: 4 }, { side: "w", at: -4 }], windows: ["e", "w"], columns: 6 }),
    box(sx, sz, 7.4, 7.4, steeple + 1.4, "wall", 1, steeple),
    box(sx, sz, 5, 5, steeple + 4.5, "wall", 1, steeple + 1.4),
    box(sx, sz, 3, 3, steeple + 8, "wall", 1, steeple + 4.5),
    box(sx, sz, 1, 1, steeple + 12, "wall", 1, steeple + 8),
    // Houses round two streets, roofs to climb onto.
    ...building(10, -20, 9, 7, STOREY, { doors: ["s", "w"], windows: ["n"], roof: "e" }),
    ...tower(26, -20, 8, 8, 2, { doors: [["s", "w"]], windows: [["e"], ["n", "e"]] }),
    ...building(42, -14, 8, 8, STOREY, { doors: ["w"], windows: ["e"], roof: "n" }),
    ...tower(10, 10, 10, 8, 2, { doors: [["s", "w"]], windows: [["n"], ["n", "w"]], open: ["e"] }),
    ...tower(26, 10, 8, 8, 2, { doors: [["s", "e"]], windows: [["n"], ["n", "e"]], open: ["w"] }),
    bridge(15, 9, 22, 11, STOREY * 2),
    ...building(42, 14, 7, 8, STOREY, { doors: ["w", "n"], windows: ["e"], roof: "s" }),
    ...building(-2, 34, 10, 6, STOREY, { doors: ["n", "e"], windows: ["s"] }),
    ...building(22, 36, 8, 6, STOREY, { doors: ["w"], windows: ["e"], roof: "s" }),
    ...building(-48, 22, 8, 7, STOREY, { doors: ["e", "n"], windows: ["w"], roof: "s" }),
    ...tower(-50, -22, 9, 8, 2, { doors: [["e", "s"]], windows: [["w"], ["n", "w"]] }),
    ...building(8, -46, 8, 6, STOREY, { doors: ["s", "e"], roof: "w" }),
    box(-6, 12, 1.2, 1.2, 0.9, "crate"),
    box(34, 0, 1.2, 1.2, 1.8, "crate"),
    box(-38, 6, 0.6, 8, 1.4, "wall"),
    box(56, 22, 0.6, 8, 1.4, "wall"),
    // The old road bridge's piers, a span still lying across the middle two.
    ...[-45, -15, 15, 45].map((x) => box(x, 78, 6, 9, 20, "tower")),
    rect(-18, 73.5, 18, 82.5, 19.2, 20, "slab", 1),
    rect(45, 73.5, 54, 82.5, 19.2, 20, "slab", 1),
    // The bus, sunk to its windows.
    box(32, 52, 2.6, 11, 1.6, "steel", 3, -1.4),
    box(32, 52, 2.65, 10.6, 1.25, "steel", 1, 0.85),
  ];
}

/** The catwalk from the intake tower's roof to the crest, in the heart's frame over the lakebed: over the dam's face, which it does not press. */
const INTAKE_CATWALK = catwalk(-35, -99.5, -35, -119, LEVEL.dam - LEVEL.lakebed, 2.2, 2);

/** Where the drowned town's other roofs stick out of the mud banks, in the heart's frame: [x, z, width, depth]. */
const BURIED_ROOFS: [number, number, number, number][] = [
  [-48, 62, 9, 7],
  [52, 46, 8, 9],
  [-58, -50, 8, 6],
];

/** The plateau over the lakebed's west side, in the heart's frame: three rock terraces climbing to a lookout over the lakebed. */
function plateau(): Box[] {
  return [
    box(-112, -10, 30, 24, 2.4, "rock"),
    box(-115, -12, 18, 14, 4.8, "rock", 1),
    box(-118, -14, 8, 8, 7.2, "rock"),
    ...stairs(-97, -5, "e", 3, 2.4, 1),
    ...stairs(-109, -22, "n", 3, 2.4, 1),
    ...stairs(-106, -9, "e", 2, 4.8, 1, 2.4),
    ...stairs(-114, -12, "e", 1.6, 7.2, 1, 4.8),
    box(-118, -19.6, 8, 0.4, 8.2, "wall", 1, 7.2),
  ];
}

/**
 * The terraced fields and the abandoned village, in the village's frame, built to `HOME` in dry
 * stone: farmhouses and barns on the terraces, the windmill and a small temple on the hill,
 * chest-high dry-stone walls along the fields (the cover there), irrigation channels too low to
 * stop a step. Each part is lifted to its terrace; the steps between terraces are laid once the
 * ground is (`TERRACE_STAIRS`).
 */
function village(): Floors {
  const S = HOME.storey;
  const wall = (x0: number, z0: number, x1: number, z1: number) => rect(x0, z0, x1, z1, 0, 1.3, "wall", 3);
  const channel = (x0: number, x1: number, z: number) => [rect(x0, z - 0.7, x1, z - 0.5, 0, 0.4, "wall", 1), rect(x0, z + 0.5, x1, z + 0.7, 0, 0.4, "wall", 1)];
  return [
    [
      LEVEL.field,
      [
      ...stone(tower(-20, 50, 10, 8, 2, { scale: HOME, doors: [["s", "e"]], windows: [["w"], ["n", "s", "w"]] })),
      ...stone(tower(40, 64, 9, 8, 2, { scale: HOME, doors: [["w", "s"]], windows: [["e"], ["n", "e"]] })),
      ...stone(hall(10, 58, 16, 10, 6, { scale: HOME, doors: [{ side: "s", w: 4 }], hatches: [{ side: "n" }] })),
      wall(-58, 40, -30, 40.6),
      wall(-24, 40, 0, 40.6),
      wall(56, 44, 56.6, 72),
      wall(-8, 70, 24, 70.6),
      ...channel(-55, 85, 74),
    ]],
    [
      LEVEL.fieldMid,
      [
      ...stone(hall(20, 12, 20, 12, 6.5, { scale: HOME, doors: [{ side: "s", w: 4 }, { side: "n", w: 4 }], hatches: [{ side: "w" }] })),
      ...stone(building(-40, 18, 9, 7, S, { scale: HOME, doors: ["s", "e"], windows: ["n"], roof: "w" })),
      wall(-70, 4, -52, 4.6),
      wall(-30, 4, 4, 4.6),
      wall(40, 26, 40.6, 32),
      ...channel(-70, 70, 28),
    ]],
    [
      LEVEL.fieldTop,
      [
      ...stone(tower(-40, -25, 10, 8, 2, { scale: HOME, doors: [["s", "e"]], windows: [["w"], ["n", "s"]] })),
      ...stone(building(20, -28, 8, 7, S, { scale: HOME, doors: ["s"], windows: ["e"] })),
      wall(-70, -36, -54, -35.4),
      wall(-14, -36, 8, -35.4),
      wall(32, -40, 32.6, -14),
    ]],
    [
      LEVEL.hill,
      [
      // The windmill: a stone tower of three storeys, its cap, and its sails across its south face.
      ...stone(tower(-35, -70, 8, 8, 3, { scale: HOME, doors: [["e"]], windows: [["w"], ["s", "n"], ["s", "e", "w"]] })),
      box(-35, -70, 8.6, 8.6, S * 3 + 1.4, "wall", 1, S * 3),
      box(-35, -65.6, 1, 1, 9.2, "steel", 2, 8),
      box(-35, -65.3, 1.2, 0.3, 16.6, "steel", 1, 1.2),
      box(-35, -65.3, 15.4, 0.3, 9.2, "steel", 1, 8),
      // The temple: a hall on a low plinth, its roof stepping up to a ridge.
      box(2, -68, 18, 14, 0.4, "wall", 3),
      ...building(2, -68, 14, 10, 4.4, { scale: HOME, doors: ["s"], windows: ["e", "w"] }).map((b) => ({ ...b, y0: b.y0 + 0.4, h: b.h + 0.4 })),
      box(2, -68, 16, 12, 5.2, "wall", 2, 4.8),
      box(2, -68, 11, 7, 6.0, "wall", 2, 5.2),
      box(2, -68, 6, 2, 6.8, "wall", 2, 6.0),
      ...stairs(2, -60.8, "s", 3, 0.4, 1),
      wall(-60, -52, -50, -51.4),
      wall(18, -50, 28, -49.4),
    ]],
  ];
}

/** A stack of storey-high decks over [x0, x1] x [z0, z1] with ramps between them along its east and west edges: a multi-storey car park. */
function carPark(x0: number, z0: number, x1: number, z1: number, decks: number): Box[] {
  const H = HOME.storey;
  const lane = 6;
  const out: Box[] = [];
  for (let k = 1; k <= decks; k++) {
    const y = k * H;
    // The deck, open over the lane its ramp comes up through.
    const [ax0, ax1] = k % 2 === 1 ? [x0, x1 - lane] : [x0 + lane, x1];
    out.push(rect(ax0, z0, ax1, z1, y - 0.3, y, "slab"));
    // Its ramp up from the deck below: east lane rising north, west lane rising south, in turn.
    if (k % 2 === 1) out.push(...ramp(x1 - lane, z0, x1, z1, y - H, y, "n", y - H - 0.3 < 0 ? 0 : y - H));
    else out.push(...ramp(x0, z0, x0 + lane, z1, y - H, y, "s", y - H));
    // A knee-high wall round its outer edges, open at its lanes' ends.
    if (ax0 === x0) out.push(rect(x0, z0, x0 + 0.25, z1, y, y + 1.0, "wall", 1));
    if (ax1 === x1) out.push(rect(x1 - 0.25, z0, x1, z1, y, y + 1.0, "wall", 1));
    out.push(rect(ax0, z1 - 0.25, ax1, z1, y, y + 1.0, "wall", 1));
  }
  for (let x = x0 + 0.4; x <= x1; x += (x1 - x0 - 0.8) / 4)
    for (const z of [z0 + 0.4, (z0 + z1) / 2, z1 - 0.4]) out.push(box(x, z, 0.7, 0.7, decks * H - 0.3, "wall", 0));
  return out;
}

/**
 * The works and the housing beside them, in the factory's frame, on one floor: the sawtooth-roofed
 * shed (`WORKS`), the water tower over it all, the multi-storey car park, four blocks of flats of
 * five storeys (`HOME`, one of them in `HIGH_RISES`), trucks and containers about the yards.
 */
function factory(): Box[] {
  const S = WORKS.storey;
  const out: Box[] = [
    ...hall(-55, -35, 72, 40, S * 2, {
      scale: WORKS,
      doors: [{ side: "n", at: -20, w: 7 }, { side: "s", at: 15, w: 7 }],
      hatches: [{ side: "e" }, { side: "w", at: 6 }, { side: "s", at: -20 }],
      windows: ["n"],
      mezz: [{ side: "s", depth: 6, y: S, stair: -4 }],
      columns: 9,
    }),
  ];
  // The sawtooth roof: six teeth across the shed, each rising east and falling sheer.
  for (let i = 0; i < 6; i++) {
    const xa = -91 + i * 12;
    for (let k = 0; k < 3; k++) out.push(rect(xa + k * 4, -55, xa + (k + 1) * 4, -15, S * 2, S * 2 + (k + 1) * 1.1, k === 2 ? "steel" : "wall", k === 2 ? 2 : 1));
  }
  // The water tower: a tank on four legs, 28 m to its cap.
  for (const [dx, dz] of [[-3.5, -3.5], [3.5, -3.5], [-3.5, 3.5], [3.5, 3.5]]) out.push(box(5 + dx, -50 + dz, 0.6, 0.6, 20, "steel", 2));
  out.push(...tank(5, -50, 4.5, 7, "s", 0, 20));
  out.push(...carPark(55, -50, 95, -20, 3));
  for (const x of [-95, -55, -15, 25]) if (x !== HIGH_RISES[4].x - AREA.factory[0]) out.push(...tower(x, 45, 30, 12, 5, { scale: HOME, doors: [["s", "w"]], windows: [["n", "e"], ["n", "s"], ["n", "s"], ["n", "s"], ["n", "s", "e"]] }));
  out.push(
    box(-10, -5, 3.4, 9, 3.6, "steel", 1),
    box(-10, -10.5, 3.4, 2.6, 2.8, "steel", 3),
    box(30, -10, 6.2, 2.5, 2.6, "container", 0),
    box(30, -10, 6.2, 2.5, 5.2, "container", 2, 2.6),
    box(-100, 0, 2.5, 6.2, 2.6, "container", 1),
    box(60, 10, 1.2, 1.2, 0.9, "crate"),
    box(61.2, 10, 1.2, 1.2, 1.8, "crate"),
    box(-70, 15, 6, 0.6, 1.2, "wall"),
    box(80, 25, 0.6, 6, 1.2, "wall"),
  );
  return out;
}

/**
 * The hall's shell: the segment door the full height of a segment in its east end (its shutter
 * half down), roller doors and plain doors through the plinth, low windows to shoot from, a band
 * of tall windows high in the cladding over the cranes, pilasters outside every 10 m, a cornice,
 * and a roof of four strips with skylights between them, torn open over the fallen crane; the
 * south cladding torn away over the segment (`GASH`), so the sun reaches it and it is seen from the street.
 */
function assemblyShell(): Box[] {
  const { x0, x1, z0, z1, H, plinth: P } = ASSEMBLY;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const w = x1 - x0;
  const d = z1 - z0;
  const along = (x: number) => x - cx;
  const roller = (side: Side, at: number): Hole => ({ side, at, w: 8, head: 7 });
  const hatch = (side: Side, at: number): Hole => ({ side, at, w: WORKS.door, head: WORKS.doorHead });
  const low = (side: Side, at: number): Hole => ({ side, at, w: WORKS.window, sill: WORKS.sill, head: WORKS.windowHead });
  const DOOR = { w: 26, head: 30 };
  const plinthHoles: Hole[] = [
    { side: "e", at: 0, w: DOOR.w, head: DOOR.head },
    roller("w", 0),
    roller("s", along(-70)),
    roller("s", along(12)),
    hatch("s", along(-30)),
    hatch("n", along(-60)),
    roller("n", along(0)),
    ...[-90, -50, -10, 30].map((x) => low("s", along(x))),
    ...[-85, -40, 20, 38].map((x) => low("n", along(x))),
    low("w", -12),
    low("w", 12),
  ];
  // The tall windows over the cranes, between the pilasters; the segment door runs on up through
  // the cladding. Over the segment the south cladding is torn away (`GASH`), its pilasters left standing.
  const high: Hole[] = [{ side: "e", at: 0, w: DOOR.w, head: DOOR.head - P }, { side: "s", at: along((GASH.x0 + GASH.x1) / 2), w: GASH.x1 - GASH.x0, sill: GASH.y0 - P, head: GASH.y1 - P }];
  const pane = (side: Side, at: number): Hole => ({ side, at, w: 4, sill: 30 - P, head: 37 - P });
  for (let x = x0 + 5; x < x1; x += 10) {
    high.push(pane("n", along(x)));
    if (x + 2 < GASH.x0 || x - 2 > GASH.x1) high.push(pane("s", along(x)));
  }
  for (const z of [-10, 0, 10]) high.push(pane("w", z));
  // The plinth stands 0.2 m proud of the cladding, so a ledge runs round the hall at its top.
  const out: Box[] = [...shell(cx, cz, w + 0.4, d + 0.4, 0, P, plinthHoles, "wall", 0, 0.8), ...shell(cx, cz, w, d, P, H - 0.5, high, "steel", 3, 0.5)];
  // Torn cladding left hanging into the gash and standing up from its foot, set into the wall's thickness.
  for (const [a, b, lo, hi] of [[GASH.x0, GASH.x0 + 5, GASH.y0, GASH.y0 + 4], [GASH.x0 + 4, GASH.x0 + 9, GASH.y1 - 5, GASH.y1], [GASH.x1 - 12, GASH.x1 - 7, GASH.y1 - 3, GASH.y1], [GASH.x1 - 6, GASH.x1, GASH.y0, GASH.y0 + 3]] as const) out.push(rect(a + 0.05, z1 - 0.45, b - 0.05, z1 - 0.05, lo, hi, "steel", 3));
  // The shutter of the segment door, half down, and its drum outside over the opening.
  out.push(rect(x1 - 0.4, cz - DOOR.w / 2, x1 - 0.1, cz + DOOR.w / 2, 23, DOOR.head, "steel", 2), rect(x1, cz - DOOR.w / 2 - 1, x1 + 1.3, cz + DOOR.w / 2 + 1, DOOR.head, DOOR.head + 1.6, "steel", 2));
  // Pilasters up the long sides, from the plinth's ledge to the cornice.
  for (let x = x0 + 10; x < x1 - 1; x += 10) out.push(rect(x - 0.45, z0 - 0.6, x + 0.45, z0 + 0.1, P, H - 1.6, "steel", 2), rect(x - 0.45, z1 - 0.1, x + 0.45, z1 + 0.6, P, H - 1.6, "steel", 2));
  // The cornice: the long sides' run the full length, the ends' between them.
  out.push(
    rect(x0 - 0.4, z0 - 0.4, x1 + 0.4, z0, H - 1.6, H + 0.5, "steel", 2),
    rect(x0 - 0.4, z1, x1 + 0.4, z1 + 0.4, H - 1.6, H + 0.5, "steel", 2),
    rect(x0 - 0.4, z0, x0, z1, H - 1.6, H + 0.5, "steel", 2),
    rect(x1, z0, x1 + 0.4, z1, H - 1.6, H + 0.5, "steel", 2),
  );
  // The roof in four strips along the hall, skylights between them; the middle two torn open
  // where the ring's debris came through and brought the crane down.
  // Steel deck, so its underside reads grey from the floor.
  const strips: [number, number, boolean][] = [
    [z0, -53, false],
    [-48, -42.5, true],
    [-37.5, -32, true],
    [-27, z1, false],
  ];
  const skylights = [[-53, -48], [-42.5, -37.5], [-32, -27]] as const;
  const torn = [BRIDGES.fallen - 9, BRIDGES.fallen + 7];
  for (const [a, b, middle] of strips)
    if (middle) out.push(rect(x0, a, torn[0], b, H - 0.5, H, "steel", 2), rect(torn[1], a, x1, b, H - 0.5, H, "steel", 2));
    else out.push(rect(x0, a, x1, b, H - 0.5, H, "steel", 2));
  // Purlins across the skylights every 10 m, under the roof's plane.
  for (let x = x0 + 5; x < x1; x += 10) for (const [a, b] of skylights) if (x < torn[0] || x > torn[1] || a === -53 || a === -32) out.push(rect(x - 0.2, a, x + 0.2, b, H - 1.1, H - 0.6, "steel", 2));
  return out;
}

/**
 * Inside the hall: the mezzanines along its walls, the open stair tower up to the crane runway in
 * its north-west corner, the runway's walkway along the north wall to the cab crane's bridge (its cab
 * at the south end holds a bin), the crane over the segment lowering a frame into it, the crane that
 * fell, its bridge lying from the floor up onto the south mezzanine, the roof's debris round it,
 * rails along the floor out of the segment door, and the stock and the work benches on the floor.
 */
function assemblyFloor(): Box[] {
  const S = WORKS.storey;
  const { x0, x1, z0, z1, crane: C } = ASSEMBLY;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const w = x1 - x0;
  const d = z1 - z0;
  // The plinth's inner face: the mezzanines stop at it.
  const WALL = 0.6;
  const along = (x: number) => x - cx;
  // A concrete floor over the dune's sand.
  const out: Box[] = [rect(x0 + 0.6, z0 + 0.6, x1 - 0.6, z1 - 0.6, 0, 0.1, "step", 0)];
  // The north mezzanine in two lengths (a flight up to each), east of the stair tower; the south
  // one a storey higher, from the west end to the plain door, its rail open where the fallen bridge lands.
  out.push(
    ...mezzanine(cx, cz, w, d, WALL, { side: "n", depth: 6, y: S, stair: along(-60), from: along(-88), to: along(-20) }, WORKS.stair),
    ...mezzanine(cx, cz, w, d, WALL, { side: "n", depth: 6, y: S, stair: along(20), from: along(-20) }, WORKS.stair),
    ...mezzanine(cx, cz, w, d, WALL, { side: "s", depth: 5, y: 2 * S, stair: along(-84), to: along(BRIDGES.fallen - 2) }, WORKS.stair),
    ...mezzanine(cx, cz, w, d, WALL, { side: "s", depth: 5, y: 2 * S, stair: along(-40), from: along(BRIDGES.fallen + 2), to: along(-32) }, WORKS.stair),
    rect(BRIDGES.fallen - 2, z1 - WALL - 5, BRIDGES.fallen + 2, z1 - WALL, 2 * S - 0.3, 2 * S, "slab"),
  );
  // The stair tower, open onto the walkway at its top.
  const T = { x: -95, z: -52 };
  out.push(...lattice(T.x, T.z, 7, 6, 8, C + 1, ["n"]), ...catwalk(T.x + 2, T.z - 3, T.x + 2, -57.6, C, 1.6, 2));
  // The runway's walkway along the north wall: its rail toward the hall open at the tower and at the cab crane's bridge.
  out.push(rect(T.x + 0.5, -59.2, x1 - WALL, -57.6, C - 0.3, C, "slab", 1));
  const gaps = [[T.x + 1.1, T.x + 2.9], [BRIDGES.cab - 1.2, BRIDGES.cab + 1.2]];
  let at = T.x + 0.5;
  for (const [a, b] of gaps) {
    out.push(rect(at, -57.8, a, -57.55, C, C + 0.5, "steel", 2));
    at = b;
  }
  out.push(rect(at, -57.8, x1 - WALL, -57.55, C, C + 0.5, "steel", 2));
  // The runway girders along both walls, on posts every 10 m (none in front of a door).
  out.push(rect(x0 + 0.6, -59.4, x1 - 0.6, -57.4, C - 1.6, C - 0.3, "steel", 2), rect(x0 + 0.6, z1 - 2.6, x1 - 0.6, z1 - 0.6, C - 1.6, C - 0.3, "steel", 2));
  const doorsAt = { n: [-60, 0], s: [-70, 12, -30] };
  for (let x = x0 + 5; x < x1; x += 10) {
    if (doorsAt.n.every((dx) => Math.abs(x - dx) > 5.5)) out.push(rect(x - 0.4, -59.3, x + 0.4, -58.5, 0, C - 1.6, "steel", 2));
    if (doorsAt.s.every((dx) => Math.abs(x - dx) > 5.5)) out.push(rect(x - 0.4, z1 - 1.5, x + 0.4, z1 - 0.7, 0, C - 1.6, "steel", 2));
  }
  // A crane's bridge across the hall at x: its two box girders under the runway's height.
  const girders = (x: number) => [rect(x - 1.75, z0 + 1, x - 1.2, z1 - 1, C - 2.4, C - 0.1, "steel", 0), rect(x + 1.2, z0 + 1, x + 1.75, z1 - 1, C - 2.4, C - 0.1, "steel", 0)];
  // The cab crane: a walkway across from the runway's to the cab at its south end, the cab's bin inside.
  const xb = BRIDGES.cab;
  out.push(...girders(xb), ...catwalk(xb, -57.6, xb, -29.5, C, 2.2, 0));
  out.push(rect(xb - 2.5, -29.5, xb + 2.5, -24.5, C - 0.35, C, "slab", 1));
  out.push(...walls(xb, -27, 5, 5, C, C + 2.5, ["n"], ["e", "w", "s"]).map((b) => ({ ...b, kind: "steel" as const, tint: 0 })));
  out.push(rect(xb - 2.6, -29.6, xb + 2.6, -24.4, C + 2.5, C + 2.8, "slab", 1));
  // The crane over the segment: its trolley, and the cable down to the spreader holding a frame
  // a few metres over its place in the segment (`SEGMENT`).
  const xo = BRIDGES.over;
  const hung = segmentFrame(xo, 2.5);
  const top = Math.max(...hung.map((b) => b.h));
  out.push(...girders(xo), rect(xo - 2.2, -42.2, xo + 2.2, -37.8, C - 0.1, C + 1.6, "steel", 0), ...hung);
  out.push(rect(xo - 0.15, -44.15, xo + 0.15, -43.85, top, top + 1.5, "steel", 2), rect(xo - 0.15, -36.15, xo + 0.15, -35.85, top, top + 1.5, "steel", 2));
  out.push(rect(xo - 0.4, -44.6, xo + 0.4, -35.4, top + 1.5, top + 1.9, "steel", 0), rect(xo - 0.7, -40.7, xo + 0.7, -39.3, top + 1.9, top + 3.1, "steel", 0));
  out.push(rect(xo - 0.12, -40.12, xo + 0.12, -39.88, top + 3.1, C - 0.1, "steel", 2));
  // The fallen crane: its bridge lying from the floor by the north mezzanine up onto the south one
  // in steps a body walks up, its trolley and its cab on the floor beside it.
  const xf = BRIDGES.fallen;
  const [za, zb] = [-54, z1 - WALL - 5];
  const n = Math.ceil(zb - za);
  for (let k = 0; k < n; k++) {
    const t = 2 * S * ((k + 1) / n);
    out.push(rect(xf - 1.7, za + ((zb - za) * k) / n, xf + 1.7, za + ((zb - za) * (k + 1)) / n, Math.max(0, t - 2.2), t, "steel", k < 3 ? 7 : 0));
  }
  out.push(rect(xf + 3, -49, xf + 7.4, -44.6, 0, 1.7, "steel", 0), rect(xf - 7.5, -40, xf - 2.5, -35, 0, 2.5, "steel", 0), rect(xf - 7.3, -39.8, xf - 2.7, -35.2, 2.5, 2.8, "slab", 1));
  // The roof's debris under the hole it tore.
  for (const [x, z, w, dd, h] of [[-78, -46, 4, 3, 1.4], [-66, -38, 3, 4, 2.0], [-62, -46, 2.4, 2.4, 0.9], [-80, -33, 3, 2, 1.1]] as const) out.push(box(x, z, w, dd, h, "wall", 1));
  // Rails the segments rolled out on, from the buffer stop at the west end through the segment door.
  for (const z of [-44, -36]) out.push(rect(x0 + 2, z - 0.12, x1, z + 0.12, 0, 0.18, "steel", 2));
  out.push(rect(x0 + 1, -45, x0 + 2, -35, 0, 1.2, "steel", 0));
  // Stock and benches about the floor: skin panels stacked under the north mezzanine, spare frames
  // in a rack, containers of parts, a site office, crates.
  for (const x of [-30, -8]) for (let k = 0; k < 3; k++) out.push(rect(x - 3, -52.6, x + 3, -50, k * 0.5, k * 0.5 + 0.45, "steel", 5));
  for (const x of [-12, -9.5, -7]) out.push(rect(x, -28, x + 0.6, -23.5, 0, 4.2, "steel", 2));
  out.push(box(-55, -45, 6.1, 2.5, 2.6, "container", 1), box(-55, -45, 6.1, 2.5, 5.2, "container", 0, 2.6), box(-90, -30, 2.5, 6.1, 2.6, "container", 2));
  out.push(...building(-22, -26, 8, 6, 3.4, { doors: ["w", "e"], windows: ["n"] }));
  out.push(box(38, -52, 1.2, 1.2, 1.8, "crate"), box(39.3, -52, 1.2, 1.2, 0.9, "crate"), box(42, -26, 1.2, 1.2, 1.8, "crate"), box(-98, -26, 1.2, 1.2, 0.9, "crate"), box(-38, -48, 1.2, 1.2, 1.8, "crate"));
  return out;
}

/**
 * The ring segment on the hall's floor (`SEGMENT`): a length of the ring's box section curved up
 * like an arch, 60 m along the rails, 12 m across and 8 m deep, its ends on cradles 3 m high, so
 * the floor under its middle is open, 12 m high. Columns 2 m wide along x, not overlapping. The
 * west half is finished, in the ring's pale composite with darker ribs; the east half is still its
 * keel and its frames standing on it, one more frame hung over its place by the crane.
 */
const SEGMENT = { x0: -25, cols: 30, step: 2, z0: -46, z1: -34, end: 3, sag: 9, deep: 8, done: 17 } as const;
/** The segment's underside and top at x. */
function segmentAt(x: number): { lo: number; hi: number } {
  const { x0, cols, step, end, sag, deep } = SEGMENT;
  const half = (cols * step) / 2;
  const mid = x0 + half;
  const R = (half * half + sag * sag) / (2 * sag);
  const y = end + sag - R;
  return { lo: y + Math.sqrt(R * R - (x - mid) ** 2), hi: y + Math.sqrt((R + deep) ** 2 - (x - mid) ** 2) };
}
/** A frame of the segment's section at x, `lift` metres over the keel: flanges top and bottom, webs at its sides. */
function segmentFrame(x: number, lift: number): Box[] {
  const { z0, z1 } = SEGMENT;
  const { lo, hi } = segmentAt(x);
  const b = lo + 0.6 + lift;
  const t = hi + lift;
  return [rect(x - 0.4, z0, x + 0.4, z1, b, b + 0.8, "steel", 2), rect(x - 0.4, z0, x + 0.4, z1, t - 0.8, t, "steel", 2), rect(x - 0.4, z0, x + 0.4, z0 + 0.8, b + 0.8, t - 0.8, "steel", 2), rect(x - 0.4, z1 - 0.8, x + 0.4, z1, b + 0.8, t - 0.8, "steel", 2)];
}
function ringSegment(): Box[] {
  const { x0, cols, step, z0, z1, done } = SEGMENT;
  const out: Box[] = [];
  for (let i = 0; i < cols; i++) {
    const a = x0 + i * step;
    const { lo, hi } = segmentAt(a + step / 2);
    if (i < done) {
      // Finished: skin, a rib every 8 m (and at the finished end) standing proud of it.
      if (i % 4 === 0) out.push(rect(a, z0 - 0.3, a + step, z1 + 0.3, lo - 0.3, hi + 0.3, "steel", 6));
      else out.push(rect(a, z0, a + step, z1, lo, hi, "steel", 5));
    } else out.push(rect(a, z0, a + step, z1, lo, lo + 0.6, "steel", 5));
    // Cradles under its ends, trestles at its sides under its middle and its keel.
    const cradle = i < 2 || i >= cols - 2;
    const trestle = i === 14 || i === 23;
    const under = i % 4 === 0 && i < done ? lo - 0.3 : lo;
    if (cradle) out.push(rect(a, z0 + 1, a + step, z1 - 1, 0, under, "steel", 0));
    if (trestle) out.push(rect(a, z0 + 0.2, a + step, z0 + 1.6, 0, under, "steel", 0), rect(a, z1 - 1.6, a + step, z1 - 0.2, 0, under, "steel", 0));
  }
  // The frames standing on the keel, at the middle of every third column.
  for (const i of [done + 1, done + 4, done + 7, done + 10, cols - 1]) out.push(...segmentFrame(x0 + i * step + step / 2, 0));
  return out;
}

/**
 * A finished length of segment that never shipped, on the flat car outside the segment door: 22 m
 * of the same section, its arch barely showing over that length, its east end run into the dune.
 */
function shippedSegment(): Box[] {
  const { z0, z1, deep } = SEGMENT;
  const out: Box[] = [];
  for (let i = 0; i < 11; i++) {
    const a = 51 + i * 2;
    const t = (a + 1 - 62) / 11;
    const lo = 1.2 + 0.9 * (1 - t * t);
    const rib = i % 4 === 1;
    out.push(rib ? rect(a, z0 - 0.3, a + 2, z1 + 0.3, lo - 0.3, lo + deep + 0.3, "steel", 6) : rect(a, z0, a + 2, z1, lo, lo + deep, "steel", 5));
    // Chocks on the car under it.
    if (a >= 52 && a + 2 <= 62) out.push(rect(a, z0 + 1, a + 2, z1 - 1, 1.2, rib ? lo - 0.3 : lo, "steel", 2));
  }
  return out;
}

/** Rails out of the segment door, on under the east dune's sand: laid without pressing the dune flat. */
const BURIED_RAILS: Box[] = [-44, -36].map((z) => rect(ASSEMBLY.x1, z - 0.12, 100, z + 0.12, -0.3, 0.18, "steel", 2));

/**
 * The supply depot on the dune coast, in its own frame, built to `WORKS`: the base's assembly plant
 * for the ring's segments. The assembly hall north of the yard (`ASSEMBLY`), the long shed of stores
 * south of it and the office block east of that, round a street 31 m wide; the material silos north
 * of the hall, fed by their conveyor house and feeding it by a gallery; the beached tanker on the
 * beach to the south-east, and trailers and containers about the yard.
 */
function supply(): Floors {
  const S = WORKS.storey;
  const out: Box[] = [...assemblyShell(), ...assemblyFloor(), ...ringSegment()];
  // The office block, four storeys, stairs inside up to its roof.
  out.push(...tower(30, 5, 16, 12, 4, { scale: WORKS, doors: [["s", "w"]], windows: [["e"], ["s", "w", "e"], ["s", "w", "e"], ["n", "s", "e", "w"]] }));
  // The long shed south of the yard, two storeys, a mezzanine along its south wall.
  out.push(
    ...hall(-30, 22, 66, 22, S * 2, {
      scale: WORKS,
      doors: [{ side: "n", at: -18, w: 7 }, { side: "n", at: 14, w: 7 }, { side: "e", w: 7 }],
      hatches: [{ side: "s", at: -20 }, { side: "w" }],
      windows: ["n", "s"],
      mezz: [{ side: "s", depth: 5, y: S, stair: -4 }],
      columns: 11,
    }),
  );
  // The material silos, 32 m high, the conveyor house over them and its gallery into the hall.
  for (const x of [-40, -22, -4]) out.push(...tank(x, -84, 6.5, 32, "s"));
  out.push(box(-22, -84, 44, 4, 35, "steel", 0, 32), rect(-24, -82, -20, ASSEMBLY.z0, 32.2, 34.6, "steel", 2));
  // About the yard: trailers left at the doors, a stack of containers, a fuel tank; a flat car on the
  // rails outside the segment door with a length of segment on it.
  out.push(box(-14, -6, 2.6, 13, 4, "container", 1), box(-44, 2, 13, 2.6, 4, "container", 0), box(30, -14, 13, 2.6, 4, "container", 2));
  out.push(box(10, 10, 6.1, 2.5, 2.6, "container", 0), box(10, 10, 6.1, 2.5, 5.2, "container", 2, 2.6), box(10, 13, 6.1, 2.5, 2.6, "container", 1));
  out.push(box(-24, -69, 6.1, 2.5, 2.6, "container", 2), box(-17, -69, 6.1, 2.5, 2.6, "container", 0), box(-17, -69, 6.1, 2.5, 5.2, "container", 1, 2.6));
  out.push(rect(52, -46, 62, -34, 0, 1.2, "steel", 0));
  out.push(...tank(48, 2, 3.5, 7, "w", 0));
  out.push(...tankerBow());
  return [
    [LEVEL.shore, out],
    // The rails and the shipped segment run on into the east dune, which they leave as it is.
    [LEVEL.shore, [...BURIED_RAILS, ...shippedSegment()], "loose"],
  ];
}

/** The tanker's hull (`TANKER`): solid at the bow and the stern, its hold between open. */
function tankerBow(): Box[] {
  const { x0, x1, z0, z1, deck } = TANKER;
  const out: Box[] = [];
  /** A run of hull from y0 to h: red below the boot-top at 6 m, grey above. */
  const hull = (ax0: number, az0: number, ax1: number, az1: number, y0: number, h: number) => {
    if (y0 < 6) out.push(rect(ax0, az0, ax1, az1, y0, Math.min(6, h), "steel", 1));
    if (h > 6) out.push(rect(ax0, az0, ax1, az1, Math.max(6, y0), h, "steel", 2));
  };
  // [z0, z1, the deck's height, how far the hull narrows in from each side]: the stem first.
  const slices = [
    [54, 58, 38, 8],
    [58, 64, 36, 5],
    [64, z0, 33, 1.5],
    [z0, 82, 29.5, 0],
    [82, 92, 26, 0],
    [92, 102, 22.5, 0],
    [102, z1, 19, 0],
    [z1, 120, 15.5, 0],
  ] as const;
  // The holes torn in the hull: z from, z to, and how high, in the east and the west side.
  const tears = { e: [84, 96, 8], w: [100, 106, 5] } as const;
  for (const [a, b, top, inset] of slices) {
    if (a < z0 || b > z1) {
      hull(x0 + inset, a, x1 - inset, b, 0, top);
      continue;
    }
    // The hold: the deck overhead, the sides with their tears.
    out.push(rect(x0, a, x1, b, top - 1, top, "steel", 0));
    for (const [side, xa, xb] of [["w", x0, x0 + 1], ["e", x1 - 1, x1]] as const) {
      const [ta, tb, th] = tears[side];
      const lo = Math.max(a, ta);
      const hi = Math.min(b, tb);
      if (lo >= hi) hull(xa, a, xb, b, 0, top - 1);
      else {
        if (lo > a) hull(xa, a, xb, lo, 0, top - 1);
        if (hi < b) hull(xa, hi, xb, b, 0, top - 1);
        hull(xa, lo, xb, hi, th, top - 1);
      }
    }
  }
  // The tween deck along the west side, its rail open at the head of its stairs.
  out.push(rect(x0 + 1, z0 + 1, x0 + 7, z1 - 1, deck - 0.3, deck, "slab", 1));
  out.push(rect(x0 + 6.85, z0 + 1, x0 + 7, z1 - 7.9, deck, deck + 1, "steel", 2), rect(x0 + 6.85, z1 - 6.1, x0 + 7, z1 - 1, deck, deck + 1, "steel", 2));
  out.push(...stairs(x0 + 7, z1 - 7, "e", WORKS.stair, deck));
  return out;
}

/** The watchtower (`WATCH`), placed: only what stands above the sand. */
function watchtower(): Box[] {
  const { x, z, floors, w, base, sand } = WATCH;
  const t = tower(x, z, w, w, floors, { scale: WORKS, doors: [[], [], ["s", "e"]], windows: [["w"], ["n", "w"], ["w"], ["n", "s", "e", "w"]] });
  return lift(base, t).filter((b) => b.h > sand - 0.5);
}

/**
 * The beached container ship, in its own frame, at the size of a real feeder: a hull 140 m long
 * and 26 m in the beam, three `WORKS` storeys deep, lying east to west on the old bay floor north
 * of its middle line (`SHIP`), holed on both sides of its hold, with stairs inside at both ends up
 * to the main deck and bulkheads cutting each deck into holds. Forward of the accommodation block
 * the deck is stacked with containers in bays (`DECK_BAYS`) with gaps between them, a maze with a
 * narrow way along each side; the block aft rises five storeys over the deck to the bridge, its
 * wings reaching out over both sides, the funnel behind it. Containers lost overboard lie on the
 * sand beside it. The pointed bow is solid.
 */
function wreck(): Box[] {
  const { z: cz, beam } = SHIP;
  const [zn, zs] = [cz - beam / 2, cz + beam / 2];
  const hull = paint(
    tower(0, cz, SHIP.length, beam, 3, { scale: WORKS, doors: [["s", "n"], [], []], windows: [["e", "w"], ["n", "s"], ["n", "s"]], twin: true }),
    "wall",
    "steel",
    (b) => (b.y0 < WORKS.storey ? 1 : 0),
  );
  const out: Box[] = [...hull];
  // Bulkheads across the holds and the decks above, each with a door in the middle.
  for (const x of [-47, -23, 23, 47])
    for (let k = 0; k < 3; k++) {
      const y0 = k * WORKS.storey;
      const y1 = y0 + WORKS.storey - 0.3;
      out.push(rect(x - 0.2, zn + 0.5, x + 0.2, cz - 1.4, y0, y1, "steel", 2), rect(x - 0.2, cz + 1.4, x + 0.2, zs - 0.5, y0, y1, "steel", 2));
      out.push(rect(x - 0.2, cz - 1.4, x + 0.2, cz + 1.4, y0 + 3.0, y1, "steel", 2));
    }
  // The bow, narrowing in steps to a point, and a blunt stern.
  out.push(box(-73.5, cz, 7, 20, SHIP_DECK + 0.7, "steel", 1), box(-79, cz, 4, 15, SHIP_DECK + 1, "steel", 1), box(-83, cz, 4, 8, SHIP_DECK + 1.3, "steel", 1), box(-86, cz, 2, 3, SHIP_DECK + 1.5, "steel", 1));
  out.push(box(71.5, cz, 3, beam - 2, SHIP_DECK, "steel", 1));
  // The deck cargo: bays of containers across the beam, some stacks gone (holes to cut through).
  DECK_BAYS.forEach((x, i) => {
    for (let r = 0; r < 9; r++) {
      const n = STACK[(i * 4 + r * 5 + 3) % STACK.length] % 4;
      for (let k = 0; k < n; k++) out.push(box(x, cz + (r - 4) * 2.5, 12.2, 2.5, SHIP_DECK + 2.6 * (k + 1), "container", (i + r + k) % 3, SHIP_DECK + 2.6 * k));
    }
  });
  // The accommodation block with the bridge on top, its wings over both sides, and the funnel.
  const block = tower(SHIP.block, cz, 14, 18, 5, { doors: [["w", "s"], [], [], [], ["n", "s"]], windows: [["n"], ["n", "s", "w"], ["n", "s", "w"], ["n", "s", "w"], ["n", "s", "w", "e"]] });
  out.push(...lift(SHIP_DECK, block));
  const wing = SHIP_DECK + STOREY * 4;
  for (const [a, b] of [[zn, cz - 9], [cz + 9, zs]] as const) {
    out.push(rect(SHIP.block - 4, a, SHIP.block + 4, b, wing - 0.3, wing, "slab", 1));
    const edge = a === zn ? a : b - 0.15;
    out.push(rect(SHIP.block - 4, edge, SHIP.block + 4, edge + 0.15, wing, wing + 0.9, "steel", 2));
    for (const x of [SHIP.block - 4, SHIP.block + 3.85]) out.push(rect(x, a, x + 0.15, b, wing, wing + 0.9, "steel", 2));
  }
  out.push(box(63, cz, 4, 7, SHIP_DECK + 26, "steel", 3, SHIP_DECK), box(63, cz, 4.4, 7.4, SHIP_DECK + 27, "steel", 1, SHIP_DECK + 26));
  out.push(box(-66, cz, 0.8, 0.8, SHIP_DECK + 14, "steel", 2, SHIP_DECK), box(-66, cz, 0.5, 9, SHIP_DECK + 11.4, "steel", 2, SHIP_DECK + 11));
  // In the holds: containers and crates that came loose.
  out.push(box(-40, cz - 4, 12.2, 2.5, 2.6, "container", 0), box(36, cz + 4, 12.2, 2.5, 2.6, "container", 1), box(-14, cz + 4, 2.5, 6.2, 2.6, "container", 2));
  out.push(box(-19, cz - 7, 1.2, 1.2, 0.9, "crate"), box(-20.2, cz - 7, 1.2, 1.2, 1.8, "crate"), box(5, cz + 8, 1.2, 1.2, 0.9, "crate"));
  // Lost overboard: containers on the sand beside the hull, one crushed under another.
  out.push(box(-10, zs + 3.5, 12.2, 2.5, 2.6, "container", 1), box(15, zs + 3.5, 6.2, 2.5, 2.6, "container", 0), box(15.4, zs + 3.5, 6.2, 2.5, 4.6, "container", 2, 2.6));
  out.push(box(24, zn - 8, 12.2, 2.5, 2.6, "container", 2), box(3.8, zs + 5.5, 2, 1.4, 1.0, "rock", 1), box(-4.2, zs + 6, 1.6, 1.2, 0.7, "rock"));
  return place(SHIP.x, 0, out);
}

/**
 * The yard's stacking blocks of 40-foot containers laid along x: per block the middles of its bays
 * (12.2 m long, end to end but for the alleys between blocks) and of its rows (2.5 m wide, side
 * by side in groups of three or two, an alley between the groups). The north road leaves between
 * the north blocks, the street from the marshalling yard and the roads from the viaduct come in between the south
 * ones, onto an apron, and
 * the main lane runs east and west between north and south, a low island of boxes down its middle.
 */
const NORTH_ROWS = [[-38.5, -35.9, -33.3], [-25.7, -23.1, -20.5]];
const SOUTH_ROWS = [[13.3, 15.9, 18.5], [25, 27.6]];
const YARD_BLOCKS: { bays: number[]; rows: number[][] }[] = [
  { bays: [-64, -51.2, -38.4], rows: NORTH_ROWS },
  { bays: [-21, -8.2], rows: NORTH_ROWS },
  { bays: [32, 44.8, 57.6], rows: NORTH_ROWS },
  { bays: [-64, -51.2, -38.4], rows: SOUTH_ROWS },
  { bays: [46.4, 59.2], rows: SOUTH_ROWS },
];
/** How high each stack stands, from its block, bay and row: 0 (a hole) to 4, never over the gantries' catwalks. */
const STACK = [2, 3, 1, 4, 2, 0, 3, 2, 4, 1, 3, 2, 0, 4, 3];
/**
 * The rubber-tyred gantries, each straddling a block's rows across z at `x`, its stair-tower leg
 * in the main lane (`z0`, the end it climbs from) and its far leg at `z1`, the cab at `cab`.
 */
const GANTRIES = [
  { x: -38.4, z0: -17, z1: -42, cab: -30 },
  { x: 46.4, z0: 10, z1: 31, cab: 22 },
] as const;
/** The quay cranes over the freight line north of the fence: their middles along x; the east one is climbed. */
const QUAY_CRANES = [-40, 46] as const;

/**
 * A ship-to-shore quay crane at `cx`, landmark of the yard: four legs straddling the freight
 * line, the portal and the deck over it 34 m up with the machinery house, the boom 40 m up
 * reaching out north over the old sea floor and back over the yard, and the A-frame holding it
 * by its stays. With `stair` an open stair tower beside its east legs climbs to the deck.
 */
function quayCrane(cx: number, stair: boolean): Box[] {
  const out: Box[] = [];
  const [zs, zn, deck] = [-43, -57, 34];
  for (const x of [cx - 9, cx + 9]) {
    for (const z of [zs, zn]) out.push(box(x, z, 1.6, 1.6, deck - 0.3, "steel", 2));
    out.push(rect(x - 0.6, zn, x + 0.6, zs, 12, 13.2, "steel", 2));
  }
  for (const z of [zs, zn]) out.push(rect(cx - 9.8, z - 0.8, cx + 9.8, z + 0.8, deck - 2, deck - 0.3, "steel", 2));
  out.push(rect(cx - 10, zn - 1, cx + 10, zs + 1, deck - 0.3, deck, "slab", 1));
  for (const b of parapet(cx, (zs + zn) / 2, 20, zs - zn + 2, deck, stair ? ["e"] : [])) out.push({ ...b, kind: "steel", tint: 2, h: deck + 0.5 });
  if (stair) {
    out.push(rect(cx + 9.85, zn - 1, cx + 10, -53, deck, deck + 0.5, "steel", 2), rect(cx + 9.85, -47, cx + 10, zs + 1, deck, deck + 0.5, "steel", 2));
    out.push(...lattice(cx + 13, -50, 6, 6, 10, deck + 4, ["w"]));
  }
  out.push(box(cx - 3, -50, 9, 9, deck + 6, "steel", 3, deck));
  out.push(rect(cx - 1.6, -110, cx + 1.6, -34, 40, 42.4, "steel", 3));
  out.push(box(cx, -50, 2, 2, 58, "steel", 3, 42.4), ...strand([cx, 58, -50], [cx, 42.4, -104], 0.3, 2), ...strand([cx, 58, -50], [cx, 42.4, -36], 0.3, 2));
  return out;
}

/** A road trailer with a container on it, along x: cover in the lanes. */
const trailer = (cx: number, cz: number, tint: number): Box[] => [box(cx, cz, 12.4, 2.5, 1.4, "steel", 1), box(cx, cz, 12.2, 2.5, 4.0, "container", tint, 1.4)];

/**
 * The container yard, in its own frame, at the scale of a real terminal: stacking blocks of
 * 40-foot containers up to four high with alleys between their groups of rows, a rubber-tyred
 * gantry over a north and a south block (one leg a stair tower up to the catwalk along its top,
 * the driver's cab on the catwalk), the main lane between north and south with trailers left in
 * it, two quay cranes over the freight line beyond the north fence, the three-storey terminal
 * office at the west end and the gate house by the way in.
 */
function yard(): Box[] {
  const out: Box[] = [];
  YARD_BLOCKS.forEach(({ bays, rows }, b) =>
    bays.forEach((x, i) =>
      rows.flat().forEach((z, r) => {
        const n = STACK[(b * 5 + i * 3 + r * 7) % STACK.length];
        for (let k = 0; k < n; k++) out.push(box(x, z, 12.2, 2.5, 2.6 * (k + 1), "container", (b + i + r + k) % 3, 2.6 * k));
      }),
    ),
  );
  // The island down the main lane: two rows, one or two high.
  [-12.8, 0, 12.8].forEach((x, i) => [-1.3, 1.3].forEach((z, r) => {
    const n = (i + r) % 2 === 0 ? 2 : 1;
    for (let k = 0; k < n; k++) out.push(box(x, z, 12.2, 2.5, 2.6 * (k + 1), "container", (i + r + k + 1) % 3, 2.6 * k));
  }));
  for (const g of GANTRIES) {
    const crane = gantry(g.x, Math.min(g.z0, g.z1), Math.max(g.z0, g.z1), CRANE, g.cab);
    // The helper climbs from its north end; a gantry climbed from the south is the same, mirrored.
    out.push(...(g.z0 < g.z1 ? crane : crane.map((b) => ({ ...b, z0: g.z0 + g.z1 - b.z1, z1: g.z0 + g.z1 - b.z0 }))));
  }
  QUAY_CRANES.forEach((x, i) => out.push(...quayCrane(x, i === QUAY_CRANES.length - 1)));
  out.push(...trailer(-22, -12, 0), ...trailer(-62, 6, 2), ...trailer(34, -8, 1), ...trailer(30, 14, 2));
  // The terminal office, and the gate house by the way in.
  out.push(...tower(-70, 0, 12, 10, 3, { scale: WORKS, doors: [["e", "s"]], windows: [["n"], ["n", "e", "s"], ["n", "e", "s"]] }));
  out.push(...building(-10, 44, 6, 4, WORKS.storey, { scale: WORKS, doors: ["e"], windows: ["s", "w"] }));
  return out;
}

/**
 * The smelter, in its own frame, built to `WORKS`: the blast furnace in the middle, its hearth
 * against the north wall of the cast house, its shaft rising to a railed platform 34 m up,
 * reached by an open stair tower beside it, and its top and gas uptakes over 50 m. Three
 * hot-blast stoves stand in a row east of it, the skip incline climbs to its top from the ore
 * heaps along the north edge, and the dust catcher and two stacks stand to the west. South of the
 * stoves the rolling mill, joined at roof height to the cast house by a railed bridge and to the
 * five-storey control block north of it; a cooling tower stands south-west and slag heaps east.
 * The stoves, the furnace and the halls close the works into lanes: one between the stoves and
 * the mill, one along the north under the incline, and the alley between the two halls.
 */
function smelter(): Box[] {
  const S = WORKS.storey;
  const H = S * 3;
  const out: Box[] = [];
  // The cast house: the tapping floor on a mezzanine along the furnace side, ladles below.
  out.push(
    ...hall(-14, 5, 36, 16, H, {
      scale: WORKS,
      doors: [{ side: "s", at: -6, w: 7 }],
      hatches: [{ side: "w", at: 3 }, { side: "e", at: -3 }],
      windows: ["s", "w"],
      mezz: [{ side: "n", depth: 5, y: S, stair: 12 }],
      columns: 9,
      open: ["e"],
      roof: "w",
    }),
  );
  out.push(box(-24, 9, 3.2, 3.2, 3, "steel", 3), box(-4, 9, 3.2, 3.2, 3, "steel", 3), rect(-26, 5.5, -2, 6.1, 0, 0.4, "steel", 1));
  // The furnace: hearth, shaft, the platform round its throat, the top and the uptakes.
  const F = { x: -14, z: -10, deck: 34 } as const;
  out.push(box(F.x, F.z, 14, 14, 16, "steel", 2));
  out.push(box(F.x, F.z, 11, 11, F.deck - 0.3, "steel", 3, 16));
  out.push(box(F.x, F.z, 16, 16, F.deck, "slab", 1, F.deck - 0.3));
  for (const b of parapet(F.x, F.z, 16, 16, F.deck, ["w"])) out.push({ ...b, kind: "steel", tint: 2, h: F.deck + 0.5 });
  out.push(rect(F.x - 8, F.z - 8, F.x - 7.85, F.z - 1.4, F.deck, F.deck + 0.5, "steel", 2), rect(F.x - 8, F.z + 1.4, F.x - 7.85, F.z + 8, F.deck, F.deck + 0.5, "steel", 2));
  out.push(box(F.x, F.z, 8, 8, F.deck + 10, "steel", 3, F.deck), box(F.x, F.z, 10, 6, F.deck + 14, "steel", 1, F.deck + 10));
  for (const [dx, dz] of [[-3, -1.8], [3, -1.8], [-3, 1.8], [3, 1.8]] as const) out.push(box(F.x + dx, F.z + dz, 1.2, 1.2, F.deck + 21, "steel", 2, F.deck + 14));
  out.push(...lattice(-26.5, F.z, 6, 6, 10, 40, ["e"]));
  out.push(...catwalk(-23.5, F.z, F.x - 8, F.z, F.deck, 2.4, 2));
  // The downcomer from the top to the dust catcher, west of the stair tower.
  out.push(...tank(-35, F.z, 3.5, 18, "s", 1));
  out.push(rect(-35.8, F.z - 0.8, F.x - 4, F.z + 0.8, F.deck + 12, F.deck + 13.6, "steel", 2), box(-35, F.z, 1.6, 1.6, F.deck + 12, "steel", 2, 18.6));
  // Three hot-blast stoves, their main running to the furnace's tuyeres.
  for (const x of [8, 18, 28]) out.push(...tank(x, F.z, 4.5, 32, "s", 2));
  out.push(rect(F.x + 5.5, F.z - 0.9, 28, F.z + 0.9, 22, 23.8, "steel", 1));
  // The skip incline: a gallery climbing from its hopper by the heaps to the furnace top, on legs.
  const inc = { x0: 32, x1: F.x + 4, z: -17, top: F.deck + 10 } as const;
  const steps = Math.round((inc.x0 - inc.x1) / 2);
  for (let i = 0; i < steps; i++) {
    const xa = inc.x0 - i * 2;
    const y = (inc.top * i) / steps;
    out.push(rect(xa - 2, inc.z - 1.5, xa, inc.z + 1.5, Math.max(0, y - 0.6), y + 2.4, "steel", 3));
  }
  for (const x of [22, 12, 2, -8]) out.push(box(x, inc.z, 0.8, 0.8, (inc.top * (inc.x0 - x)) / (inc.x0 - inc.x1) - 0.6, "steel", 2));
  // The ore heaps along the north edge, either side of the road out north.
  for (const [x0, x1] of [[-36, -12], [4, 34]] as const)
    for (let x = x0; x < x1; x += 4) {
      const t = Math.sin((Math.PI * (x - x0 + 2)) / (x1 - x0));
      out.push(rect(x, -28, x + 4, -21, 0, 1.2 + 4.2 * t, "rock", 1), rect(x + 0.6, -27, x + 3.4, -22, 0, 1.8 + 5.4 * t, "rock", 0));
    }
  // The rolling mill: roll stands along it, its roof bridged to the cast house and the control block.
  out.push(
    ...hall(25, 11, 34, 18, H, {
      scale: WORKS,
      doors: [{ side: "s", at: -15, w: 7 }],
      hatches: [{ side: "e", at: 4 }, { side: "w", at: 4 }, { side: "n", at: -6 }],
      windows: ["n", "s", "e"],
      mezz: [{ side: "s", depth: 4, y: S * 2, stair: 6 }],
      columns: 8,
      open: ["w", "n"],
    }),
  );
  for (const x of [15, 22, 29, 36]) out.push(box(x, 9, 3, 4, 3.4, "steel", 2));
  out.push(bridge(4, 7, 8, 9.5, H), rect(4, 7, 8, 7.2, H, H + 0.8, "steel", 2), rect(4, 9.3, 8, 9.5, H, H + 0.8, "steel", 2));
  out.push(...tower(38, -8, 10, 10, 5, { scale: WORKS, doors: [["w", "s"], [], [], ["s"]], windows: [["e"], ["n", "e"], ["n", "e"], ["n", "e"], ["n", "e", "w"]] }));
  out.push(bridge(37, -3, 39.5, 2, H), rect(37, -3, 37.2, 2, H, H + 0.8, "steel", 2), rect(39.3, -3, 39.5, 2, H, H + 0.8, "steel", 2));
  // The stacks, flued from the cast house.
  out.push(box(-44, 4, 5, 5, 56, "tower"), box(-44, 4, 5.4, 5.4, 60, "steel", 0, 56));
  out.push(box(-44, -6, 4, 4, 44, "tower"), box(-44, -6, 4.4, 4.4, 48, "steel", 0, 44));
  out.push(rect(-41.5, 3.2, -32, 4.8, 9, 10.6, "steel", 2));
  // The cooling tower, waisted and open to nobody.
  for (const [r, y0, h] of [[8, 0, 7], [7.2, 7, 13], [6.6, 13, 19], [7, 19, 24]] as const) out.push(...disc(-22, 24, r, 2, y0, h, "wall", 0));
  // The fuel tank, and slag heaps past the mill.
  out.push(...tank(58, 14, 4, 9, "w", 0));
  out.push(box(50, 24, 7, 5, 2.6, "rock", 1), box(58, 26, 5, 4, 1.8, "rock"), box(48, 14, 4, 6, 2.2, "rock", 1));
  return out;
}

/**
 * The viaduct, in the world's coordinates: from the north embankment's end (`z0`) it runs north
 * along `x` to its corner at `z`, past the town's east end where stairs come down (`stair`),
 * then west along `z`, north of the town, to its end by the container yard at `x0`.
 */
const VIADUCT = { x: 168, z0: -406, z: -615, x0: -67, stair: -564.6 } as const;

/** Everything built in the harbor and on the way there, outside the POIs. */
const HARBOR: Box[] = [
  ...onLevel(LEVEL.seabed, place(AT[4][0], AT[4][1], wreck())),
  ...onLevel(LEVEL.shore, place(AT[5][0], AT[5][1], yard())),
  ...onLevel(LEVEL.terrace, place(AT[6][0], AT[6][1], smelter())),
  // --- 港町: a hut, a warehouse with a roof to watch from, cottages, crates
  ...onLevel(LEVEL.shore, placeIn("town", [
    ...building(14, -288, 6, 5, 3.4, { doors: ["s"], windows: ["e"], roof: "e" }),
    ...tower(60, -293, 16, 10, 2, { doors: [["s", "w"]], windows: [["e"], ["n", "e", "w"]] }),
    ...tower(-22, -308, 8, 8, 2, { doors: [["s", "e"]], windows: [["w"], ["n", "e", "w"]] }),
    ...building(30, -314, 8, 6, 3.4, { doors: ["n", "w"], windows: ["s"], roof: "e" }),
    ...building(92, -311, 7, 6, 3.4, { doors: ["n", "w"], windows: ["e"] }),
    box(-2, -315, 6.2, 2.5, 2.6, "container", 1),
    box(42, -290, 1.2, 1.2, 0.9, "crate"),
    box(43.2, -290, 1.2, 1.2, 1.8, "crate"),
    box(76, -306, 2.5, 6.2, 2.6, "container", 2),
  ])),
  // --- 岬: the lighthouse, banded red every other storey, its lantern on top, and the keeper's cottage
  ...onLevel(LEVEL.headland, placeIn("bay", [
    ...paint(
      tower(LIGHTHOUSE.x, LIGHTHOUSE.z, 8, 8, LIGHTHOUSE.floors, { doors: [["s", "e"]], windows: [[], ["n"], ["e"], ["s"], ["w"], ["n", "e"], ["n", "e", "s", "w"]] }),
      "wall",
      "wall",
      () => 2,
      (b) => b.tint === 0 && Math.floor(b.y0 / STOREY) % 2 === 1,
    ),
    ...[-1, 1].flatMap((sx) => [-1, 1].map((sz) => box(LIGHTHOUSE.x + sx * 3.6, LIGHTHOUSE.z + sz * 3.6, 0.4, 0.4, LIGHTHOUSE.floors * STOREY + 2.5, "steel", 2, LIGHTHOUSE.floors * STOREY))),
    box(LIGHTHOUSE.x, LIGHTHOUSE.z, 1.6, 1.6, LIGHTHOUSE.floors * STOREY + 1.5, "steel", 3, LIGHTHOUSE.floors * STOREY),
    box(LIGHTHOUSE.x, LIGHTHOUSE.z, 8.4, 8.4, LIGHTHOUSE.floors * STOREY + 2.8, "steel", 0, LIGHTHOUSE.floors * STOREY + 2.5),
    ...building(-107, -563, 6, 5, 3.4, { doors: ["w", "s"], windows: ["e"] }),
  ])),
  // --- 峠: a ruined wall and a signpost on the saddle
  ...onLevel(LEVEL.pass, placeIn("pass", [box(-52.5, -219.5, 3.2, 0.6, 1.2, "wall", 1), box(-51, -221, 0.6, 2.4, 1.6, "wall", 1), box(-55, -216.5, 0.3, 0.3, 3.2, "steel", 2)])),
  // --- the station on the railway's north embankment: a canopy over the platform
  ...onLevel(LEVEL.rail, placeIn("railway", [
    box(125.6, -222, 0.3, 0.3, 3.2, "steel", 2),
    box(125.6, -234, 0.3, 0.3, 3.2, "steel", 2),
    rect(124, -236, 127, -220, 3.0, 3.25, "slab", 1),
    box(118.6, -228, 1.2, 1.2, 0.9, "crate"),
  ])),
  // --- the viaduct's pillars, standing on the road under it, and its stairs
  ...onLevel(LEVEL.shore, [
    ...Array.from({ length: 16 }, (_, i) => box(VIADUCT.x, VIADUCT.z0 - 16 - i * 12, 2.4, 1.6, LEVEL.rail - 0.3, "tower")),
    ...Array.from({ length: 19 }, (_, i) => box(VIADUCT.x0 + 6 + i * 12, VIADUCT.z, 1.6, 2.4, LEVEL.rail - 0.3, "tower")),
    ...stairs(VIADUCT.x0, VIADUCT.z, "w", 2.4, LEVEL.rail),
    ...stairs(VIADUCT.x + 3.5, VIADUCT.stair, "s", 1.8, LEVEL.rail),
    // A carriage fallen from the line onto the road below.
    box(-35, VIADUCT.z - 3.8, 12, 2.8, 3, "steel", 3),
  ]),
];

/**
 * Walkways that the ground's path finding (nav.ts for the bot, hunt.ts for routed robots)
 * treats as ground at height `y`: the railway bridge's deck over the gorge, between its
 * railings. Everything else built up off the ground is out of their reach.
 */
export interface Deck {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  y: number;
}
export const DECKS: Deck[] = placeIn("railway", [rect(120.2, -201.5, 123.8, -178.5, 0, 0, "slab")]).map((b) => ({ x0: b.x0, z0: b.z0, x1: b.x1, z1: b.z1, y: LEVEL.rail }));

/**
 * A kerb along the quay's edge, knee high: walkers fighting round the boat's pickup point
 * cannot step off into the channel, where they could not climb out. The slipway east of it
 * stays open.
 */
const QUAY: Box[] = placeIn("bay", [rect(89, -583.2, 146, -582.6, -6.2, -2.3, "wall", 1)]);

/**
 * The railway's decks: the bridge over the gorge on two piers (in the railway's frame), and the
 * viaduct from the north embankment out over the harbor (`VIADUCT`, its pillars and stairs in
 * HARBOR), railed along its length, with an abandoned carriage on it. They are not pressed
 * flat: the gorge and the road run under them, and their ends rest on the embankments.
 */
const { x: VX, z: VZ, z0: VZ0, x0: VX0, stair: VS } = VIADUCT;
const RAILWAY: Box[] = [
  ...placeIn("railway", [
    bridge(119.5, -208, 124.5, -172, LEVEL.rail),
    rect(119.5, -202, 119.8, -178, LEVEL.rail, LEVEL.rail + 1.2, "steel", 2),
    rect(124.2, -202, 124.5, -178, LEVEL.rail, LEVEL.rail + 1.2, "steel", 2),
    box(122, -185, 3, 2, LEVEL.rail - 0.3, "tower", 0, -9),
    box(122, -195, 3, 2, LEVEL.rail - 0.3, "tower", 0, -9),
    ...[121.2, 122.8].map((x) => rect(x - 0.08, -205, x + 0.08, -175, LEVEL.rail, LEVEL.rail + 0.12, "steel", 2)),
  ]),
  // The viaduct: north from the embankment, then west over the road to its end by the yard.
  bridge(VX - 2.5, VZ - 2.5, VX + 2.5, VZ0, LEVEL.rail),
  bridge(VX0, VZ - 2.5, VX - 2.5, VZ + 2.5, LEVEL.rail),
  rect(VX + 2.5, VS - 2.4, VX + 4.6, VS, LEVEL.rail - 0.3, LEVEL.rail, "slab", 1),
  rect(VX - 2.5, VZ + 2.5, VX - 2.25, VZ0 - 12, LEVEL.rail, LEVEL.rail + 0.9, "wall", 1),
  rect(VX + 2.25, VZ - 2.5, VX + 2.5, VS - 2.4, LEVEL.rail, LEVEL.rail + 0.9, "wall", 1),
  rect(VX + 2.25, VS, VX + 2.5, VZ0 - 12, LEVEL.rail, LEVEL.rail + 0.9, "wall", 1),
  rect(VX0 + 3, VZ - 2.5, VX + 2.5, VZ - 2.25, LEVEL.rail, LEVEL.rail + 0.9, "wall", 1),
  rect(VX0 + 3, VZ + 2.25, VX - 2.5, VZ + 2.5, LEVEL.rail, LEVEL.rail + 0.9, "wall", 1),
  // Rails along the decks.
  ...[VX - 0.8, VX + 0.8].map((x) => rect(x - 0.08, VZ, x + 0.08, VZ0 - 4, LEVEL.rail, LEVEL.rail + 0.12, "steel", 2)),
  ...[VZ - 0.8, VZ + 0.8].map((z) => rect(VX0 + 2, z - 0.08, VX - 1, z + 0.08, LEVEL.rail, LEVEL.rail + 0.12, "steel", 2)),
  box(43, VZ, 12, 2.6, LEVEL.rail + 3, "steel", 3, LEVEL.rail),
];

/** Everything placed by hand: POIs, districts, landmarks. */
/** Groups of boxes written in a frame at (dx, dz), each lifted onto the floor it stands on. */
const onFloors = (dx: number, dz: number, floors: Floors): Box[] => floors.flatMap(([level, boxes, loose]) => (loose ? lift(level, place(dx, dz, boxes)) : onLevel(level, place(dx, dz, boxes))));

const PAD_AT = AT[poiIndex("pad")];

/** Everything placed by hand: POIs, districts, landmarks. */
const AUTHORED: Box[] = [
  ...HARBOR,
  ...HAMLETS.flatMap((h) => h.boxes),
  ...TOWNS.flatMap((t) => t.boxes),
  ...onFloors(AT[0][0], AT[0][1], supply()),
  ...place(AT[0][0], AT[0][1], watchtower()),
  ...onFloors(AT[1][0], AT[1][1], quarry()),
  ...onFloors(AT[2][0], AT[2][1], relay()),
  ...onFloors(PAD_AT[0], PAD_AT[1], [
    [LEVEL.dam, pad()],
    [LEVEL.dam, CREST_PARAPET, "loose"],
  ]),
  // --- the tether's anchor north of the pad, and the fallen tether's lengths whose ground is known before it is built
  ...lift(LEVEL.dam, placeIn("anchor", anchor())),
  ...placeIn("anchor", tetherPiece({ ...TETHER.east, foot: 2, back: LEVEL.dam + ANCHOR.top, broken: { e: true } })),
  ...onLevel(
    TETHER_FLOOR,
    placeIn(
      "anchor",
      tetherPiece({
        ...TETHER.corridor,
        foot: -2.5,
        back: 10,
        ceiling: 6.5,
        broken: { w: true, e: true },
        breaches: [
          { side: "s", a: -142, b: -136 },
          { side: "n", a: -122, b: -116 },
          { side: "s", a: -104, b: -98 },
        ],
      }),
    ),
  ),
  // --- the drowned town and the dam's face, on the lakebed
  ...onFloors(AREA.heart[0], AREA.heart[1], [
    [LEVEL.lakebed, [...heartTown(), ...damFace()]],
    [LEVEL.lakebed, INTAKE_CATWALK, "loose"],
  ]),
  // --- tall buildings, seen from anywhere on the island
  ...HIGH_RISES.flatMap((h) => onLevel(h.level, highRise(h.x, h.z, h.w, h.d, h.floors, h.sc))),
  // --- the plateau over the lakebed
  ...onLevel(LEVEL.shore, placeIn("heart", plateau())),
  // --- the terraced fields, and the works and housing
  ...onFloors(AREA.village[0], AREA.village[1], village()),
  ...onLevel(LEVEL.shore, placeIn("factory", factory())),
  // --- the nodes on the open ground between the areas
  ...onLevel(LEVEL.station, placeIn("station", station())),
  ...onLevel(LEVEL.waterworks, placeIn("waterworks", waterworks())),
  ...onLevel(LEVEL.lodge, placeIn("lodge", lodge())),
  ...onLevel(LEVEL.cannery, placeIn("cannery", cannery())),
  ...onLevel(LEVEL.coldstore, placeIn("coldstore", coldstore())),
];

/**
 * The routes' trenches (`ROUTES`), carved only while a route is open. Cover is kept off the
 * ground they lower (`scatterCover`), which is otherwise left as it is: pressing it flat would
 * change the closed world.
 */
// The tunnel under the mountains, straight through them north of the landing pad, its floor at
// the open ground's level at either mouth.
const TUNNEL: Carve = { name: "坑道", line: [[40, -270], [40, -430]], floor: 3, levels: [10, 4], slope: 2.4 };
// The dam's inspection gallery, in the heart's frame: from the lakebed at the dam's foot, up
// through the dam under its crest to the pad behind it.
const GALLERY: Carve = { name: "点検通路", line: [[20 + AREA.heart[0], -105 + AREA.heart[1]], [20 + AREA.heart[0], -171 + AREA.heart[1]]], floor: 2.5, levels: [LEVEL.lakebed, LEVEL.dam], slope: 2.4 };
/** Metres either side of a trench's floor that its walls may lower the ground. */
const TRENCH_ROOM = 10;

/**
 * Cover scattered over the open ground so that a fight is mostly about breaking
 * line of sight and coming back from another side. Pieces are placed on a jittered
 * grid from a fixed seed, and a candidate is dropped when it would crowd a building,
 * another piece, or any authored point (robot posts, patrol routes, bins, entries).
 */
interface Keep {
  points: { x: number; z: number; r: number }[];
  segments: { ax: number; az: number; bx: number; bz: number }[];
}

/**
 * Roads that are the only ways between areas: the way between the regions, the ramps into the
 * lakebed, the quarry and the harbor's bay, and the ways up the pad, the mesa and the fields.
 * Cover is kept off them, and they are pressed to their own floor along their middle, so no
 * rock or building nearby can close them.
 */
const KEPT_ROADS = ["湖への坂", "湖の西坂", "東の坂", "発着場の西坂", "採掘場の運搬路", "中段への坂", "底への坂", "採掘場の坑道", "台地への道", "台地の坂", "村の坂", "峠道", "鉄道の土手（南）", "鉄道の土手（北）", "駅の坂", "高架下", "西の道", "製錬所の坂", "塩田への坂", "ヤードの北道", "製錬所の北道", "岬の坂", "斜路"];

/** Every authored point (with the room it needs), patrol leg and kept road. */
function authoredKeep(): Keep {
  const points: Keep["points"] = [];
  const segments: Keep["segments"] = [];
  for (const name of KEPT_ROADS) {
    const line = roadLine(name);
    for (let i = 0; i + 1 < line.length; i++) segments.push({ ax: line[i][0], az: line[i][1], bx: line[i + 1][0], bz: line[i + 1][1] });
  }
  const squadArea = (sq: Squad) => {
    for (const m of sq.members) points.push({ x: m.x, z: m.z, r: 3 });
    const loop = sq.patrol ?? [];
    loop.forEach((a, i) => {
      const b = loop[(i + 1) % loop.length];
      segments.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z });
    });
  };
  for (const p of POIS) {
    points.push({ x: p.entry.x, z: p.entry.z, r: 5 });
    p.squads.forEach(squadArea);
    for (const b of p.bins) points.push({ x: b.x, z: b.z, r: 2.5 });
    for (const f of p.floor) points.push({ x: f.x, z: f.z, r: 2.5 });
    if (p.carePackage) points.push({ x: p.carePackage.x, z: p.carePackage.z, r: 4 });
    if (p.boss) points.push({ x: p.x, z: p.z, r: 34 }); // the titan's arena stays open
  }
  ROAMERS.forEach(squadArea);
  // The walks of the patrols and convoys between the areas: a lane kept along each leg, so no cover scattered there closes it.
  for (const m of MOBILES) for (let i = 0; i + 1 < m.nodes.length; i++) segments.push({ ax: m.nodes[i][0], az: m.nodes[i][1], bx: m.nodes[i + 1][0], bz: m.nodes[i + 1][1] });
  for (const b of EXTRA_BINS) points.push({ x: b.x, z: b.z, r: 2.5 });
  // The boat's point keeps less flat ground round it: the channel's water starts a few metres off.
  for (const x of EXTRACTS) points.push({ x: x.x, z: x.z, r: x.id === "boat" ? 6 : 10 });
  for (const e of ENTRIES) points.push({ x: e.x, z: e.z, r: 6 });
  return { points, segments };
}

/**
 * The ground scattered with cover, each region with its own seed and grid (`step`, metres
 * between candidate spots), so that adding to one region leaves the other's cover as it was.
 * On the salt flats only one candidate in two
 * stands, and only a container, a truck or a rock: the most open ground, yet with a wreck to get behind
 * a few steps away, since in the open a robot's burst lands. The
 * channel, under water, gets none.
 */
const SCATTER = [
  { x0: WORLD.x0, x1: WORLD.x1, z0: -350, z1: WORLD.z1, seed: 7_332, step: 13 },
  { x0: WORLD.x0, x1: WORLD.x1, z0: WORLD.z0, z1: -351, seed: 4_517, step: 14 },
];
/** Where cover is sparse: the salt flats, and the supply depot's dune coast, whose dunes are its cover. */
const SPARSE = new Set(["塩田", "補給所"]);
/** The harbor's channel, which holds water: nothing is scattered in it. */
const WATER = "水路";
/** The ground between the basins and roads (terrain.ts). */
const BETWEEN = "野";
/** Where on the ground between the cover clumps: above 0.55 in blobs about a hundred metres across. */
const clump = (x: number, z: number) => 0.5 + 0.25 * Math.sin(x / 37 + 1.3) * Math.sin(z / 41 + 0.7) + 0.25 * Math.sin((x + z) / 53);

/** Things in 8 m squares, so a test against "anything near" looks only at the squares it reaches. */
class Near<T> {
  private cells = new Map<number, T[]>();
  private static readonly SIZE = 8;
  /** Every square the box [x0, x1] x [z0, z1] touches. */
  private each(x0: number, z0: number, x1: number, z1: number, f: (k: number) => void) {
    const S = Near.SIZE;
    for (let j = Math.floor(z0 / S); j <= Math.floor(z1 / S); j++) for (let i = Math.floor(x0 / S); i <= Math.floor(x1 / S); i++) f(j * 65_536 + i);
  }
  add(x0: number, z0: number, x1: number, z1: number, t: T) {
    this.each(x0, z0, x1, z1, (k) => {
      const list = this.cells.get(k);
      if (list) list.push(t);
      else this.cells.set(k, [t]);
    });
  }
  /** Whether `ok` holds for everything in the squares the box touches (some things are seen more than once). */
  every(x0: number, z0: number, x1: number, z1: number, ok: (t: T) => boolean): boolean {
    let all = true;
    this.each(x0, z0, x1, z1, (k) => {
      if (all) for (const t of this.cells.get(k) ?? []) if (!ok(t)) return void (all = false);
    });
    return all;
  }
}

/**
 * What a scattered piece must keep clear of, by square: the authored boxes, the pieces already
 * placed, the authored points with their room, and the kept roads and patrol legs as the points
 * along them a piece must stay 2.5 m from. Each is filed under the squares its own box (with the
 * room it keeps) touches, so a piece is tested against exactly the things it could crowd.
 */
interface Clearance {
  authored: Near<Box>;
  laid: Near<Box>;
  points: Near<Keep["points"][number]>;
  along: Near<{ x: number; z: number }>;
}

/** Where a POI's depot stands (`DEPOTS`): on the road out from its entry. */
function depotSpot(p: Poi): { x: number; z: number } {
  const ax = p.entry.x - p.x;
  const az = p.entry.z - p.z;
  const len = Math.hypot(ax, az);
  return { x: +(p.entry.x + (ax / len) * DEPOT_OUT[p.id]).toFixed(1), z: +(p.entry.z + (az / len) * DEPOT_OUT[p.id]).toFixed(1) };
}

function scatterCover(authored: Box[], { points, segments }: Keep): Box[] {
  const near: Clearance = { authored: new Near(), laid: new Near(), points: new Near(), along: new Near() };
  for (const b of authored) near.authored.add(b.x0, b.z0, b.x1, b.z1, b);
  // Each depot keeps room round it and round the start behind it.
  const depots = POIS.map((p) => ({ ...depotSpot(p), r: 6 }));
  // The camp's yard keeps clear: a circle round it, out past its corners.
  const yard = { x: CAMP_AT[0], z: CAMP_AT[1], r: Math.hypot(CAMP_HALF.x, CAMP_HALF.z) + 1 };
  // Where a raid stops and where hunting parties stand stay open too, without pressing the ground.
  const stops = [...STOPS, ...Object.values(PARTY_STOPS).flat()].map((q) => ({ x: q.x, z: q.z, r: 8 }));
  for (const q of [...points, ...depots, ...stops, yard]) near.points.add(q.x - q.r, q.z - q.r, q.x + q.r, q.z + q.r, q);
  // A trench's line keeps cover off as far as its walls may lower the ground.
  for (const c of [TUNNEL, GALLERY]) {
    const [[ax, az], [bx, bz]] = c.line;
    const n = Math.ceil(Math.hypot(bx - ax, bz - az));
    const r = c.floor + TRENCH_ROOM;
    for (let k = 0; k <= n; k++) {
      const x = ax + ((bx - ax) * k) / n;
      const z = az + ((bz - az) * k) / n;
      near.points.add(x - r, z - r, x + r, z + r, { x, z, r });
    }
  }
  for (const sg of segments) {
    const n = Math.max(1, Math.ceil(Math.hypot(sg.bx - sg.ax, sg.bz - sg.az)));
    for (let k = 0; k <= n; k++) {
      const x = sg.ax + ((sg.bx - sg.ax) * k) / n;
      const z = sg.az + ((sg.bz - sg.az) * k) / n;
      near.along.add(x - 2.5, z - 2.5, x + 2.5, z + 2.5, { x, z });
    }
  }
  const placed: Box[] = [];
  for (const area of SCATTER) placed.push(...scatterArea(near, area));
  return placed;
}

function scatterArea(near: Clearance, area: (typeof SCATTER)[number]): Box[] {
  let seed = area.seed;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

  const len = (a: number, b: number) => a + rnd() * (b - a);
  // Set pieces in real sizes, each a group of boxes written along u (its length) and v (across),
  // laid along x or z: low cover to crouch behind (sandbags, barriers, a car, about 1.1 m) and tall
  // cover to stand behind (pallets to 2.2 m, a truck, containers, ruins with 3.2 m walls).
  const pieceAt = (x: number, z: number): Box[] => {
    const alongX = rnd() < 0.5;
    const flip = rnd() < 0.5 ? 1 : -1;
    const at = (u: number, v: number, l: number, w: number, h: number, kind: BoxKind, tint = 0, y0 = 0): Box =>
      alongX ? box(x + u, z + v * flip, l, w, h, kind, tint, y0) : box(x + v * flip, z + u, w, l, h, kind, tint, y0);
    const kind = rnd();
    if (kind < 0.12) {
      // A sandbag line, 1.1 m high, bent in two or three lengths: hides a crouching player.
      const n = 2 + Math.floor(rnd() * 2);
      const out: Box[] = [];
      let u = 0;
      for (let i = 0; i < n; i++) {
        const l = len(1.7, 2.2);
        out.push(at(u + l / 2, i === 1 ? 0.45 : i === 2 ? 1.2 : 0, l + 0.1, 0.85, 1.1, "prop", PROP.sandbags));
        u += l;
      }
      return out;
    }
    if (kind < 0.24) {
      // A row of concrete road barriers, 3 m long and 1.1 m high, one knocked askew.
      const n = 2 + Math.floor(rnd() * 3);
      const askew = Math.floor(rnd() * n);
      return Array.from({ length: n }, (_, i) => at(i * 3.35, i === askew ? len(-0.9, 0.9) : 0, 3, 0.65, 1.1, "prop", PROP.barrier));
    }
    if (kind < 0.42) {
      // Stacked pallets of goods, two rows of two or three stacks from 1 m to 2.2 m, one of them full height.
      const cols = 2 + Math.floor(rnd() * 2);
      const tall = Math.floor(rnd() * cols * 2);
      const out: Box[] = [];
      for (let i = 0; i < cols; i++)
        for (let j = 0; j < 2; j++) {
          const n = i * 2 + j;
          if (n !== tall && rnd() < 0.2) continue;
          out.push(at(i * 1.32, j * 1.12, 1.22, 1.02, n === tall ? 2.2 : [1.0, 1.4, 1.8, 2.2][Math.floor(rnd() * 4)], "prop", PROP.pallets));
        }
      return out;
    }
    if (kind < 0.58) {
      // Shipping containers side by side, staggered, one of them stacked two high.
      const n = 2 + Math.floor(rnd() * 2);
      const tint = Math.floor(rnd() * 3);
      const out: Box[] = [];
      for (let i = 0; i < n; i++) out.push(at(len(-1.6, 1.6), i * 2.6, 6.1, 2.44, 2.6, "container", (tint + i) % 3));
      if (rnd() < 0.6) {
        const under = out[Math.floor(rnd() * n)];
        out.push({ ...under, y0: 2.6, h: 5.2, tint: (under.tint + 1) % 3 });
      }
      return out;
    }
    if (kind < 0.71) {
      // A wrecked flatbed truck: a 3 m cab and a 5 m bed under a tarp, often a car left beside it.
      const out = [at(1.15, 0, 2.3, 2.5, 3.0, "prop", PROP.cab), at(2.3 + 2.5, 0, 5, 2.5, 2.3, "prop", PROP.bed)];
      if (rnd() < 0.55) out.push(at(len(1, 4), 3.9, 4.5, 1.9, 1.5, "prop", PROP.car));
      return out;
    }
    if (kind < 0.82) {
      // An outcrop: two or three rocks leaning together.
      const n = 2 + Math.floor(rnd() * 2);
      const tint = Math.floor(rnd() * 2);
      return Array.from({ length: n }, (_, i) => at(i * 3 + len(-0.5, 0.5), len(-1, 1), len(2.6, 4.5), len(2.4, 4), i === 0 ? len(2.4, 3.4) : len(1.3, 2.6), "rock", tint));
    }
    return ruin(at, len(7.5, 9.5), len(6.5, 8.5));
  };
  /**
   * A roofless ruin: walls 0.45 m thick and up to 3.2 m high, broken into lengths of about 2 m
   * whose tops step down and up again, a doorway at each end and a breach in one side, and a
   * heap of rubble inside.
   */
  const ruin = (at: (u: number, v: number, l: number, w: number, h: number, kind: BoxKind, tint?: number, y0?: number) => Box, w: number, d: number): Box[] => {
    const T = 0.45;
    const out: Box[] = [];
    let top = 3.2;
    const ragged = () => (top = Math.max(1.4, Math.min(3.2, top + [-0.9, -0.5, 0, 0.5, 0.9][Math.floor(rnd() * 5)])));
    const breach = Math.floor(rnd() * 2);
    // One wall: along u from u0 to u1 at v, with a doorway (2 m) in its middle when `door`, a gap when `gap`.
    const run = (u0: number, u1: number, v: number, alongU: boolean, door: boolean, gap: boolean) => {
      const mid = (u0 + u1) / 2;
      const holes = door ? [[mid - 1, mid + 1]] : gap ? [[mid - 0.4 + len(-1, 1), mid + 1.4]] : [];
      let a = u0;
      while (a < u1 - 0.05) {
        let b = Math.min(u1, a + len(1.6, 2.4));
        const hole = holes.find(([h0, h1]) => b > h0 && a < h1);
        if (hole && a < hole[0]) b = hole[0];
        else if (hole) {
          a = hole[1];
          continue;
        }
        if (u1 - b < 0.6) b = u1;
        if (b - a < 0.3) {
          a = b;
          continue;
        }
        const h = ragged();
        out.push(alongU ? at((a + b) / 2, v, b - a, T, h, "wall", 0) : at(v, (a + b) / 2, T, b - a, h, "wall", 0));
        a = b;
      }
    };
    run(-w / 2, w / 2, -d / 2, true, false, breach === 0);
    run(-w / 2, w / 2, d / 2, true, false, breach === 1);
    run(-d / 2 + T, d / 2 - T, -w / 2 + T / 2, false, true, false);
    run(-d / 2 + T, d / 2 - T, w / 2 - T / 2, false, true, false);
    out.push(at(len(-w / 4, w / 4), len(-d / 4, d / 4), len(1.6, 2.6), len(1.2, 2), len(0.5, 0.9), "prop", PROP.rubble));
    return out;
  };

  const clear = (b: Box, gap: number) => (o: Box) => b.x1 + gap <= o.x0 || o.x1 + gap <= b.x0 || b.z1 + gap <= o.z0 || o.z1 + gap <= b.z0;
  const distToBox = (b: Box, x: number, z: number) => Math.hypot(Math.max(b.x0 - x, 0, x - b.x1), Math.max(b.z0 - z, 0, z - b.z1));
  // A piece goes only on low ground that is not a cliff. It starts at the lowest ground
  // under it and keeps its full height above the highest, so it never floats or sinks; what is
  // stacked on it (a container two high) sits on its top.
  const groundUnder = (piece: Box[]): { lo: number; hi: number } | null => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const b of piece)
      for (const [x, z] of [[b.x0, b.z0], [b.x1, b.z0], [b.x0, b.z1], [b.x1, b.z1], [(b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2]]) {
        if (steepAt(x, z) || offshore(x, z) > -4) return null;
        if (highGround(x, z)) return null; // cover belongs on the low ground people walk
        const h = terrainHeight(x, z);
        lo = Math.min(lo, h);
        hi = Math.max(hi, h);
      }
    return hi - lo > 1.2 ? null : { lo, hi };
  };
  // Wrecks out on the salt flats: a rusted container, a truck left where it stopped, or a rock.
  const wreckAt = (x: number, z: number): Box[] => {
    const r = rnd();
    if (r < 0.5) return [rnd() < 0.5 ? box(x, z, 6.1, 2.44, 2.6, "container", 0) : box(x, z, 2.44, 6.1, 2.6, "container", 0)];
    if (r < 0.75) return rnd() < 0.5 ? [box(x, z, 2.3, 2.5, 3.0, "prop", PROP.cab), box(x + 3.65, z, 5, 2.5, 2.3, "prop", PROP.bed)] : [box(x, z, 2.5, 2.3, 3.0, "prop", PROP.cab), box(x, z + 3.65, 2.5, 5, 2.3, "prop", PROP.bed)];
    return [box(x, z, 2.6 + rnd() * 2.5, 2.6 + rnd() * 2.5, 1.5 + rnd() * 1.5, "rock", Math.floor(rnd() * 2))];
  };
  const placed: Box[] = [];
  // Candidates on a grid from 11 m inside the area's bounds, each nudged at random: set pieces
  // up to 10 m across, few enough that the open ground reads as open.
  const edge = 11;
  for (let gx = area.x0 + edge; gx <= area.x1 - edge; gx += area.step)
    for (let gz = area.z0 + edge; gz <= area.z1 - edge; gz += area.step) {
      const x = gx + (rnd() - 0.5) * 7;
      const z = gz + (rnd() - 0.5) * 7;
      const at = surfaceAt(x, z);
      const sparse = SPARSE.has(at);
      if ((sparse && rnd() > 0.5) || at === WATER) continue;
      // The streets' asphalt stays clear. On the ground between the areas, cover gathers along
      // the streets (what was left by the roadside) and in a few clumps a hundred metres or so
      // across away from them: open country to cross, broken by places to break the sightline.
      const road = offStreet(x, z);
      if (road < 2) continue;
      if (at === BETWEEN && (road < 22 ? rnd() > 0.55 || clump(x, z) < 0.45 : rnd() > 0.4 || clump(x, z) < 0.62)) continue;
      const piece = sparse ? wreckAt(x, z) : pieceAt(x, z);
      const base = groundUnder(piece);
      if (base === null) continue;
      for (const b of piece) {
        b.y0 += b.y0 > 0 ? base.hi : base.lo;
        b.h += base.hi;
      }
      const ok = piece.every(
        (b) =>
          near.authored.every(b.x0 - 3, b.z0 - 3, b.x1 + 3, b.z1 + 3, clear(b, 3)) &&
          near.laid.every(b.x0 - 2.5, b.z0 - 2.5, b.x1 + 2.5, b.z1 + 2.5, clear(b, 2.5)) &&
          near.points.every(b.x0, b.z0, b.x1, b.z1, (q) => distToBox(b, q.x, q.z) > q.r) &&
          near.along.every(b.x0, b.z0, b.x1, b.z1, (q) => distToBox(b, q.x, q.z) >= 2.5) &&
          [[b.x0, b.z0], [b.x1, b.z0], [b.x0, b.z1], [b.x1, b.z1], [(b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2]].every(([px, pz]) => offStreet(px, pz) > 0.8),
      );
      if (ok) {
        placed.push(...piece);
        for (const b of piece) near.laid.add(b.x0, b.z0, b.x1, b.z1, b);
      }
    }
  return placed;
}

/**
 * The bridge over the spillway, in the heart's frame: two rock pillars standing on the canyon's
 * floor and a deck between the two small floors that hold the ground at its ends. They are not
 * pressed flat: the spillway runs under them.
 */
const BRIDGE: Box[] = placeIn("heart", [
  box(98, -92, 4, 4, LEVEL.terrace - 0.3, "rock", 0, -18),
  box(114, -92, 4, 4, LEVEL.terrace - 0.3, "rock", 1, -18),
  bridge(90, -94.2, 122, -89.8, LEVEL.terrace),
]);

/**
 * The camp between raids, on the south beach behind the reservoir's first way in: a yard of
 * sheet fence 34 by 28 m with its gate facing north into the region, the stations a raid is
 * made ready at, the truck that drives the player to another start, and the tent they wake in.
 * Written in its own frame round (0, 0), north = -z, on ground at 0; `CAMP` gives its places in
 * the world. Robots never walk in (`inCamp()`), and a raid ends alive when the player walks back
 * into it (`HOME`).
 */
const CAMP_AT: [number, number] = [2, 616];
/** The camp's floor, pressed flat over the whole yard. */
const CAMP_LEVEL = 1;
const CAMP_HALF = { x: 17, z: 14 };
/** Half the gate's width, in the middle of the north fence. */
const CAMP_GATE = 4.25;

export type StationId = "map" | "quests" | "stash" | "shop" | "workshop" | "factory";

/** A place in the camp the use key acts at: a station's panel, or the truck. */
export interface CampSpot {
  id: StationId | "vehicle";
  name: string;
  /** The middle of what stands there; the use key works within `reach` of it. */
  x: number;
  y: number;
  z: number;
  reach: number;
  /** Where its name floats, over the camp's floor. */
  top: number;
}

/** A thin tarp roof `w` by `d` at height `y` round (cx, cz), on a grey post at each corner. */
function tarp(cx: number, cz: number, w: number, d: number, y: number): Box[] {
  const out = [box(cx, cz, w, d, y + 0.1, "prop", PROP.tarp, y)];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) out.push(box(cx + sx * (w / 2 - 0.15), cz + sz * (d / 2 - 0.15), 0.12, 0.12, y, "steel", 2));
  return out;
}

function camp(): Box[] {
  const { x: X, z: Z } = CAMP_HALF;
  const out: Box[] = [];
  // The fence: panels of rust and teal sheet between grey posts, open over the gate.
  const panel = (k: number) => (k % 3 === 1 ? 3 : 0);
  for (let k = 0; k < 8; k++) {
    const u0 = -X + k * 4.25;
    const u1 = u0 + 4.25;
    out.push(rect(u0, Z - 0.1, u1, Z + 0.1, 0, 2.4, "steel", panel(k + 1)));
    if (u1 <= -CAMP_GATE + 0.01 || u0 >= CAMP_GATE - 0.01) out.push(rect(u0, -Z - 0.1, u1, -Z + 0.1, 0, 2.4, "steel", panel(k)));
  }
  for (let k = 0; k < 7; k++) {
    const v0 = -Z + k * 4;
    out.push(rect(-X - 0.1, v0, -X + 0.1, v0 + 4, 0, 2.4, "steel", panel(k + 2)), rect(X - 0.1, v0, X + 0.1, v0 + 4, 0, 2.4, "steel", panel(k)));
  }
  for (let k = 0; k <= 8; k++) for (const v of [-Z, Z]) if (v === Z || Math.abs(-X + k * 4.25) >= CAMP_GATE) out.push(box(-X + k * 4.25, v, 0.22, 0.3, 2.6, "steel", 2));
  for (let k = 1; k < 7; k++) for (const u of [-X, X]) out.push(box(u, -Z + k * 4, 0.3, 0.22, 2.6, "steel", 2));
  // The gate: tall posts, a white bar over them, and its two leaves swung back along the fence.
  for (const s of [-1, 1]) out.push(box(s * (CAMP_GATE + 0.15), -Z, 0.3, 0.3, 3.6, "steel", 2), rect(s > 0 ? CAMP_GATE + 0.3 : -CAMP_GATE - 4.1, -Z + 0.15, s > 0 ? CAMP_GATE + 4.1 : -CAMP_GATE - 0.3, -Z + 0.27, 0.05, 2.0, "fence"));
  out.push(rect(-CAMP_GATE - 0.3, -Z - 0.15, CAMP_GATE + 0.3, -Z + 0.15, 3.3, 3.6, "steel", 4));
  // The truck by the gate, its cab toward the gate.
  out.push(box(8, -9.5, 2.3, 2.5, 3.0, "prop", PROP.cab), box(11.65, -9.5, 5, 2.5, 2.3, "prop", PROP.bed));
  // The quest board west of the gate, on two posts.
  out.push(box(-8, -10.5, 3, 0.12, 2.3, "prop", PROP.board, 0.9));
  for (const u of [-9.4, -6.6]) out.push(box(u, -10.6, 0.14, 0.14, 2.4, "steel", 2));
  // The map table in the middle of the yard, in the open sun.
  out.push(box(-1, -3, 2.6, 1.6, 0.92, "prop", PROP.table));
  // The trader's stall against the east fence, south of the shelves: a counter in the sun, its
  // goods behind it under an awning whose shade falls on the fence (the sun stands to the south-west).
  out.push(box(14, 7.5, 1, 3.4, 1.05, "prop", PROP.counter), box(15.9, 6.2, 1.2, 1.2, 1.2, "crate"), box(16, 7.7, 1.0, 1.2, 0.9, "crate"), box(15.8, 9.1, 1.2, 1.0, 1.6, "crate"), ...tarp(15.6, 7.5, 2.6, 4.6, 2.9));
  // The workshop in the south-west corner: a bench, crates, a container of parts on the south fence.
  out.push(box(-10, 10.5, 3, 1.1, 0.95, "prop", PROP.bench), box(-14.6, 12.4, 1.4, 1.4, 1.4, "crate"), box(-13.2, 12.6, 1.1, 1.1, 0.9, "crate"));
  out.push(box(-1.5, 12.35, 6.1, 2.44, 2.6, "container", 1));
  // Spare crates and sandbags along the west fence.
  out.push(box(-15.4, 1.6, 1.2, 1.2, 1.2, "crate"), box(-15.5, 3.2, 1.0, 1.2, 0.9, "crate"), box(-15.9, -3, 0.85, 3.6, 1.1, "prop", PROP.sandbags));
  // The stash's shelves against the east fence.
  out.push(box(15.9, -0.6, 0.8, 2.8, 2.0, "prop", PROP.shelf), box(15.9, 2.4, 0.8, 2.8, 2.0, "prop", PROP.shelf));
  // The tent on the south fence: two bedrolls under a tarp.
  out.push(box(4.8, 11.6, 0.8, 2.0, 0.22, "prop", PROP.bedroll), box(7.2, 11.6, 0.8, 2.0, 0.22, "prop", PROP.bedroll), ...tarp(6, 11.4, 5, 4.4, 2.3));
  return out;
}

const CAMP_BOXES: Box[] = onLevel(CAMP_LEVEL, place(CAMP_AT[0], CAMP_AT[1], camp()));
FLAT.push({ x0: CAMP_AT[0] - CAMP_HALF.x, z0: CAMP_AT[1] - CAMP_HALF.z, x1: CAMP_AT[0] + CAMP_HALF.x, z1: CAMP_AT[1] + CAMP_HALF.z, y: CAMP_LEVEL });

const campSpot = (id: CampSpot["id"], name: string, u: number, v: number, reach: number, top: number): CampSpot => ({ id, name, x: CAMP_AT[0] + u, y: CAMP_LEVEL, z: CAMP_AT[1] + v, reach, top });

/** The camp's places in the world. */
export const CAMP = {
  x0: CAMP_AT[0] - CAMP_HALF.x,
  x1: CAMP_AT[0] + CAMP_HALF.x,
  z0: CAMP_AT[1] - CAMP_HALF.z,
  z1: CAMP_AT[1] + CAMP_HALF.z,
  y: CAMP_LEVEL,
  /** The gate's opening in the north fence. */
  gate: { x0: CAMP_AT[0] - CAMP_GATE, x1: CAMP_AT[0] + CAMP_GATE, z: CAMP_AT[1] - CAMP_HALF.z },
  /** Where the player wakes between raids, in front of the tent, facing the gate. */
  wake: { x: CAMP_AT[0] + 6, z: CAMP_AT[1] + 8, yaw: 0 },
  spots: [
    campSpot("map", "地図の机", -1, -3, 2.8, 1.9),
    campSpot("quests", "依頼板", -8, -10.5, 2.6, 2.9),
    campSpot("stash", "倉庫の棚", 15.9, 0.9, 3.0, 2.6),
    campSpot("shop", "商人の屋台", 14, 7.5, 2.6, 3.3),
    campSpot("workshop", "作業場", -10, 10.5, 2.6, 2.0),
    // The factory: the parts container on the south fence, where the camp's own robots are put together.
    campSpot("factory", "工場", -1.5, 10.4, 2.4, 3.2),
    campSpot("vehicle", "車両", 9.8, -9.5, 3.4, 3.5),
  ] satisfies CampSpot[],
};

/** Whether (x, z) lies in the camp's yard, or within `r` of its fence. */
export const inCamp = (at: { x: number; z: number }, r = 0) => at.x > CAMP.x0 - r && at.x < CAMP.x1 + r && at.z > CAMP.z0 - r && at.z < CAMP.z1 + r;

const KEEP = authoredKeep();
// Hand-built things keep flat ground around them, at their level.
buildTerrain([
  ...FLAT,
  ...KEEP.points.map((q) => ({ x0: q.x - q.r, z0: q.z - q.r, x1: q.x + q.r, z1: q.z + q.r })),
  ...KEEP.segments.flatMap((sg) => {
    const n = Math.max(1, Math.ceil(Math.hypot(sg.bx - sg.ax, sg.bz - sg.az) / 2));
    return Array.from({ length: n + 1 }, (_, k) => {
      const x = sg.ax + ((sg.bx - sg.ax) * k) / n;
      const z = sg.az + ((sg.bz - sg.az) * k) / n;
      return { x0: x - 1, z0: z - 1, x1: x + 1, z1: z + 1 };
    });
  }),
]);

/**
 * What is laid in the quarry and the fields once the ground is built, standing on it without
 * pressing it flat: the quarry's conveyor from the plant down over its terraces to the floor on
 * its pylons, the iron stairs bolted to the terraces' walls, and the roof over the tunnel where it
 * runs under the middle terrace (a portal at its foot); the stone steps between the fields; and
 * the drowned town's roofs sticking out of the mud banks.
 */
/**
 * The quarry's wider iron stairs, in its frame: each from (x, z) on its floor toward the wall it
 * climbs, to the terrace above or (no `top`) the open ground round the quarry. With the haul road,
 * the ramps, the tunnel, the narrow stairs and the lifts (`QUARRY_LIFTS`) they are the quarry's
 * ways up, which the sim gate walks (`checkQuarryExits()`).
 */
export const QUARRY_EXITS: readonly { name: string; x: number; z: number; toward: Side; base: number; top?: number }[] = [
  { name: "上段から南西へ", x: -90, z: 50, toward: "s", base: LEVEL.quarryTop },
  { name: "上段から南東へ", x: 70, z: 55, toward: "s", base: LEVEL.quarryTop },
  { name: "上段から東へ", x: 105, z: -30, toward: "e", base: LEVEL.quarryTop },
  { name: "上段から西へ", x: -108, z: -20, toward: "w", base: LEVEL.quarryTop },
  { name: "上段から北西へ", x: -60, z: -52, toward: "n", base: LEVEL.quarryTop },
  { name: "中段から東へ", x: 62, z: 12, toward: "e", base: LEVEL.quarryMid, top: LEVEL.quarryTop },
  { name: "中段から北へ", x: 40, z: -15, toward: "n", base: LEVEL.quarryMid, top: LEVEL.quarryTop },
  { name: "底から南へ", x: -20, z: 32, toward: "s", base: LEVEL.pit, top: LEVEL.quarryMid },
  { name: "底から北へ", x: -5, z: 6, toward: "n", base: LEVEL.pit, top: LEVEL.quarryMid },
];

/**
 * The quarry's lifts, in its frame: cables from its floor straight up over the terraces to the
 * ground round it, ridden as the ziplines are but up whoever holds what (zips.ts).
 */
export const QUARRY_LIFTS: readonly { a: string; b: string; from: { x: number; z: number }; to: { x: number; z: number } }[] = [
  { a: "lift:quarry", b: "lift:quarry-s", from: { x: -45, z: 36 }, to: { x: -53, z: 88 } },
  { a: "lift:quarry", b: "lift:quarry-n", from: { x: -25, z: 6 }, to: { x: -25, z: -82 } },
].map((l) => ({ ...l, from: { x: l.from.x + POI_AT.quarry[0], z: l.from.z + POI_AT.quarry[1] }, to: { x: l.to.x + POI_AT.quarry[0], z: l.to.z + POI_AT.quarry[1] } }));

const LAID: Box[] = (() => {
  const [qx, qz] = AT[1];
  const out: Box[] = [];
  // The conveyor: lengths of belt stepping down along its line, a pylon under every third.
  const n = Math.round((BELT.z1 - BELT.z0) / 5);
  const bx = qx + BELT.x;
  for (let k = 0; k < n; k++) {
    const za = qz + BELT.z0 + k * 5;
    const y = BELT.y0 + ((BELT.y1 - BELT.y0) * (k + 0.5)) / n;
    out.push(rect(bx - 0.8, za, bx + 0.8, za + 5, y - 0.5, y, "steel", 2), rect(bx - 0.6, za, bx + 0.6, za + 5, y, y + 0.15, "steel", 1));
    if (k % 3 === 1) {
      const g = terrainHeight(bx, za + 2.5);
      if (y - 0.5 - g > 1) out.push(rect(bx - 0.4, za + 2.1, bx + 0.4, za + 2.9, g - 0.5, y - 0.5, "steel", 0));
    }
  }
  // The iron stairs between the quarry's terraces, and from the top terrace up to the ground on
  // every side the quarry is left by: south toward the station and the supply depot, east toward
  // the reservoir, west to the coast, north-west to the pass.
  out.push(
    ...cliffStairs("quarry", -70, -20, "n", LEVEL.quarryTop, LEVEL.quarryMid, 1.8, 0, "steel"),
    ...cliffStairs("quarry", -86, 12, "w", LEVEL.quarryTop, LEVEL.quarryMid, 1.8, 0, "steel"),
    ...cliffStairs("quarry", 28, 18, "e", LEVEL.quarryMid, LEVEL.pit, 1.8, 0, "steel"),
    ...QUARRY_EXITS.flatMap((q) => {
      // From the floor as it lies at the foot (a terrace dips a little from its level), so the first riser is a step.
      const [x, z] = inArea("quarry", q.x, q.z);
      const [dx, dz] = DIR[q.toward];
      let base = q.base;
      for (let d = 0; d < 30 && terrainHeight(x + dx * d, z + dz * d) < q.base + 1; d += 0.5) base = Math.min(base, terrainHeight(x + dx * d, z + dz * d) - 0.02);
      return q.top === undefined ? rimStairs("quarry", q.x, q.z, q.toward, base, 2.6, 0, "steel") : cliffStairs("quarry", q.x, q.z, q.toward, q.top, base, 2.6, 0, "steel");
    }),
  );
  // The tunnel's roof, flush with the middle terrace over the cut, and its portal on the floor.
  out.push(...placeIn("quarry", [rect(-80, 13, -67, 30, LEVEL.quarryMid - 0.6, LEVEL.quarryMid, "slab", 1), rect(-67.6, 13, -66.8, 16.5, LEVEL.pit, LEVEL.quarryMid, "wall", 0), rect(-67.6, 26.5, -66.8, 30, LEVEL.pit, LEVEL.quarryMid, "wall", 0)]));
  // Stone steps up the walls between the fields.
  out.push(
    ...cliffStairs("village", -30, 40, "n", LEVEL.fieldMid, LEVEL.field, 2, 1),
    ...cliffStairs("village", -10, 2, "n", LEVEL.fieldTop, LEVEL.fieldMid, 2, 1),
    ...cliffStairs("village", -20, -38, "n", LEVEL.hill, LEVEL.fieldTop, 2, 1),
  );
  // The roofs sticking out of the mud: red tiles stepping up to a ridge, from below the mud's top.
  for (const [x, z, w, d] of BURIED_ROOFS) {
    const [rx, rz] = inArea("heart", x, z);
    const g = terrainHeight(rx, rz);
    out.push(box(rx, rz, w, d, g + 0.9, "wall", 2, g - 1), box(rx, rz, w - 2.4, d, g + 1.8, "wall", 2, g + 0.9), box(rx, rz, w - 4.8, d, g + 2.6, "wall", 2, g + 1.8));
  }
  // The anchor's plinth: stairs up its north and west sides from the ground there.
  const top = LEVEL.dam + ANCHOR.top;
  for (const [fx, fz, side, width] of [[0, -discEdge(ANCHOR.r, 6), "n", 8], [-ANCHOR.r, 0, "w", 6]] as const) {
    const [x, z] = inArea("anchor", fx, fz);
    const [dx, dz] = DIR[side];
    // The ground where the flight will end: its length depends on the rise, so look twice.
    let g = terrainHeight(x + dx * 3, z + dz * 3);
    g = terrainHeight(x + dx * (stepsFor(top - g) + 1) * STEP_DEPTH, z + dz * (stepsFor(top - g) + 1) * STEP_DEPTH);
    if (top - g > WORLD.stepUp) out.push(...stairs(x, z, side, width, top, 0, g));
  }
  // The fallen tether's far lengths, sunk into the ground they lie on: their foot under its lowest
  // point, their back a fixed height over it. The far west one has rubble stairs up its south side.
  const sunk = (p: { x0: number; x1: number }, back: number, broken: TetherPiece["broken"]) => {
    let g = Infinity;
    for (let x = p.x0; x <= p.x1; x += 2) for (const fz of [-6, 0, 6]) g = Math.min(g, terrainHeight(...inArea("anchor", x, fz)));
    return { ...p, foot: g - 1.5, back: g + back, broken };
  };
  const far = sunk(TETHER.far, 7.5, { w: true, e: true });
  const west = sunk(TETHER.west, 8.5, { w: true, e: true });
  out.push(...placeIn("anchor", [...tetherPiece(far), ...tetherPiece(west)]));
  const [sx, sz] = inArea("anchor", -196, 3.5);
  out.push(...stairs(sx, sz, "s", 3, west.back, 1, terrainHeight(sx, sz + 9)));
  return out;
})();

// The canyon floors pay for the detour: a bin under each bridge.
for (const { x, z, table } of [at("heart", { x: 108, z: -100, table: "relay" as const }), at("railway", { x: 127, z: -192, table: "smelter" as const })])
  EXTRA_BINS.push({ x, z, y: terrainHeight(x, z), table });

/**
 * One depot per POI, on the road out from its entry: in reach on the way in or out, yet
 * outside the fight round the POI. They are not boxes and do not press the ground flat; the
 * scattered cover only keeps off them (`depotSpot()`). They are placed on the built ground, so
 * each stands at the floor level the walkers find there.
 */
export const DEPOTS: Depot[] = POIS.map((p) => {
  const at = onFloor(depotSpot(p));
  return { poi: p.id, x: at.x, y: at.y, z: at.z, yaw: Math.atan2(p.x - at.x, -(p.z - at.z)) };
});

function outpost(name: string): Hamlet {
  const o = OUTPOSTS.find((h) => h.name === name);
  if (!o) throw new Error(`no outpost named ${name}`);
  return o;
}
const SUBSTATION = outpost("変電所");
const EAST_SUBSTATION = outpost("東の変電所");
const FUEL_DEPOT = outpost("燃料基地");
const ENGINE_DEPOT = outpost("保線基地");
const PUMPS = outpost("揚水ポンプ場");
/**
 * The works that join the POIs and outposts, in the world's coordinates, laid on the ground once
 * it is built (they do not press it flat): what fed the POIs, so a line seen from anywhere leads
 * to the next place worth going.
 * - Power lines on lattice pylons: in the harbor from the substation to the yard, the smelter
 *   and the quay; in the reservoir from the east substation to the dam and to the relay's mesa.
 * - Pipelines on supports high enough to walk under: from the fuel depot to the smelter, the
 *   quay and the engine depot; from the pumping station past the works to the water tower.
 * - The freight line from the marshalling yard round the north of the container yard, past the
 *   signal box, to the smelter, and its spur north past the fishing village to the wharf, with
 *   wagons left on them as cover along the way.
 * Each run is a list of legs along x or along z.
 */
const POWER_LINES: { from: [number, number, number]; pylons: [number, number][] }[] = [
  // The harbor.
  ...[
    { from: -18, pylons: [[46, -685], [0, -685], [-50, -685], [-100, -685]] },
    { from: 18, pylons: [[104, -685], [150, -685]] },
    { from: 6, pylons: [[95, -698], [95, -750], [95, -820], [95, -890], [95, -950]] },
  ].map((l) => busbarLine(SUBSTATION, l.from, l.pylons as [number, number][])),
  // The reservoir: west over the railway toward the dam, south to the foot of the relay's mesa.
  busbarLine(EAST_SUBSTATION, -18, [[262, -186], [215, -186], [140, -186]]),
  busbarLine(EAST_SUBSTATION, 18, [[328, -150], [328, -95], [328, -42]]),
];
/** A power line leaving a substation's busbar `dx` metres from its middle (as `substationYard()` builds it). */
function busbarLine(s: Hamlet, dx: number, pylons: [number, number][]): { from: [number, number, number]; pylons: [number, number][] } {
  return { from: [s.x + dx, floorLevel(s.x, s.z) + 10, s.z - 11], pylons };
}
const PIPELINES: [number, number][][] = [
  [[FUEL_DEPOT.x - 27, -770], [212, -770]],
  [[FUEL_DEPOT.x, FUEL_DEPOT.z - 22], [FUEL_DEPOT.x, -905], [160, -905], [160, -960]],
  [[FUEL_DEPOT.x, FUEL_DEPOT.z + 22], [FUEL_DEPOT.x, -640], [280, -640], [280, ENGINE_DEPOT.z + 14], [ENGINE_DEPOT.x + 28, ENGINE_DEPOT.z + 14]],
  [[PUMPS.x - 21, PUMPS.z + 14], [300, PUMPS.z + 14], [300, 222], [128, 222]],
];
/** The main line from the marshalling yard to the smelter (a buffer stop at its end), and the spur north from it to the wharf. */
const FREIGHT_LINES: [number, number][][] = [
  [[-295, -691], [-258, -691], [-258, -765], [-10, -765], [-10, -712], [118, -712]],
  [[-258, -765], [-258, -959]],
];
const FREIGHT_WAGONS: { x: number; z: number; alongX: boolean; load: "box" | "hopper" | "flat"; tint: number }[] = [
  { x: -200, z: -765, alongX: true, load: "box", tint: 0 },
  { x: -185.5, z: -765, alongX: true, load: "flat", tint: 0 },
  { x: -95, z: -765, alongX: true, load: "hopper", tint: 0 },
  { x: -40, z: -765, alongX: true, load: "box", tint: 1 },
  { x: -10, z: -740, alongX: false, load: "box", tint: 2 },
  { x: 40, z: -712, alongX: true, load: "flat", tint: 0 },
  { x: 54.5, z: -712, alongX: true, load: "box", tint: 0 },
  { x: -258, z: -858, alongX: false, load: "hopper", tint: 0 },
  { x: -258, z: -904, alongX: false, load: "box", tint: 2 },
];
/** A pylon's height, the height its cross-arm carries the wires at, and how far out either side. */
const PYLON = { top: 24, arm: 19.6, reach: 3.4 } as const;

/** A lattice pylon on ground at `g` for a line along x (`alongX`) or z: four legs, bands, a cross-arm and a peak. */
function pylon(cx: number, cz: number, alongX: boolean, g: number): Box[] {
  const out: Box[] = [];
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    out.push(box(cx + sx * 2, cz + sz * 2, 0.45, 0.45, g + PYLON.arm - 1, "steel", 2, g - 0.3));
    out.push(box(cx + sx * 1, cz + sz * 1, 0.35, 0.35, g + PYLON.top, "steel", 2, g + PYLON.arm - 1));
  }
  for (let y = g + 4; y < g + PYLON.arm - 1; y += 4)
    out.push(...(alongX ? [rect(cx - 2.2, cz - 2.2, cx + 2.2, cz - 1.9, y - 0.25, y, "steel", 2), rect(cx - 2.2, cz + 1.9, cx + 2.2, cz + 2.2, y - 0.25, y, "steel", 2)] : [rect(cx - 2.2, cz - 2.2, cx - 1.9, cz + 2.2, y - 0.25, y, "steel", 2), rect(cx + 1.9, cz - 2.2, cx + 2.2, cz + 2.2, y - 0.25, y, "steel", 2)]));
  const r = PYLON.reach + 0.4;
  out.push(alongX ? rect(cx - 0.3, cz - r, cx + 0.3, cz + r, g + PYLON.arm, g + PYLON.arm + 0.5, "steel", 2) : rect(cx - r, cz - 0.3, cx + r, cz + 0.3, g + PYLON.arm, g + PYLON.arm + 0.5, "steel", 2));
  return out;
}

/**
 * A wire from p to q ([x, y, z]) sagging `sag` metres at its middle: lengths stepping along it,
 * short enough that none rises more than a hand's width, so it reads as a line and not as steps.
 */
function wire(p: readonly [number, number, number], q: readonly [number, number, number], sag: number): Box[] {
  const rise = Math.abs(q[1] - p[1]) + 2 * sag;
  const n = Math.max(2, Math.ceil(Math.hypot(q[0] - p[0], q[2] - p[2]) / 3), Math.ceil(rise / 0.12));
  const at = (t: number): [number, number, number] => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t - sag * 4 * t * (1 - t), p[2] + (q[2] - p[2]) * t];
  const out: Box[] = [];
  for (let i = 0; i < n; i++) {
    const a = at(i / n);
    const b = at((i + 1) / n);
    if (Math.abs(a[0] - b[0]) < 0.01 || Math.abs(a[2] - b[2]) < 0.01)
      out.push(rect(Math.min(a[0], b[0]) - 0.06, Math.min(a[2], b[2]) - 0.06, Math.max(a[0], b[0]) + 0.06, Math.max(a[2], b[2]) + 0.06, Math.min(a[1], b[1]) - 0.06, Math.max(a[1], b[1]) + 0.06, "steel", 2));
    else out.push(...strand(a, b, 0.12, 2));
  }
  return out;
}

/** The legs of a run, cut into lengths of about `step` metres: each length's ends and whether it runs along x. */
function lengths(run: readonly [number, number][], step: number): { a: [number, number]; b: [number, number]; alongX: boolean }[] {
  const out: { a: [number, number]; b: [number, number]; alongX: boolean }[] = [];
  for (let i = 0; i + 1 < run.length; i++) {
    const [p, q] = [run[i], run[i + 1]];
    const n = Math.max(1, Math.round(Math.hypot(q[0] - p[0], q[1] - p[1]) / step));
    for (let k = 0; k < n; k++)
      out.push({ a: [p[0] + ((q[0] - p[0]) * k) / n, p[1] + ((q[1] - p[1]) * k) / n], b: [p[0] + ((q[0] - p[0]) * (k + 1)) / n, p[1] + ((q[1] - p[1]) * (k + 1)) / n], alongX: Math.abs(q[0] - p[0]) >= Math.abs(q[1] - p[1]) });
  }
  return out;
}

const WORKS_LINES: Box[] = (() => {
  const out: Box[] = [];
  const g = (x: number, z: number) => terrainHeight(x, z);
  // Power: each line leaves its substation's busbar frame for its first pylon, then runs pylon to pylon.
  for (const line of POWER_LINES) {
    const tips = line.pylons.map(([x, z], i) => {
      const next = line.pylons[Math.min(i + 1, line.pylons.length - 1)];
      const prev = line.pylons[Math.max(i - 1, 0)];
      const alongX = Math.abs(next[0] - prev[0]) >= Math.abs(next[1] - prev[1]);
      const base = Math.min(g(x - 2, z - 2), g(x + 2, z - 2), g(x - 2, z + 2), g(x + 2, z + 2));
      out.push(...pylon(x, z, alongX, base));
      const y = base + PYLON.arm - 0.4;
      return (alongX ? [-1, 1].map((s) => [x, y, z + s * PYLON.reach]) : [-1, 1].map((s) => [x + s * PYLON.reach, y, z])) as [number, number, number][];
    });
    for (const t of tips[0]) out.push(...wire(line.from, t, 0.6));
    for (let i = 0; i + 1 < tips.length; i++) for (let k = 0; k < 2; k++) out.push(...wire(tips[i][k], tips[i + 1][k], 2.2));
  }
  // Fuel: two pipes side by side on a support every length, high enough for a heavy to walk under.
  for (const run of PIPELINES)
    for (const { a, b, alongX } of lengths(run, 10)) {
      const y = Math.max(g(a[0], a[1]), g(b[0], b[1])) + 4;
      for (const [off, tint] of [[-0.5, 2], [0.5, 3]] as const)
        out.push(alongX ? rect(Math.min(a[0], b[0]), a[1] + off - 0.35, Math.max(a[0], b[0]), a[1] + off + 0.35, y, y + 0.7, "steel", tint) : rect(a[0] + off - 0.35, Math.min(a[1], b[1]), a[0] + off + 0.35, Math.max(a[1], b[1]), y, y + 0.7, "steel", tint));
      const base = g(a[0], a[1]);
      for (const off of [-1.1, 1.1]) out.push(alongX ? box(a[0], a[1] + off, 0.35, 0.35, y, "steel", 2, base - 0.3) : box(a[0] + off, a[1], 0.35, 0.35, y, "steel", 2, base - 0.3));
      out.push(alongX ? box(a[0], a[1], 0.35, 2.6, y, "steel", 2, y - 0.3) : box(a[0], a[1], 2.6, 0.35, y, "steel", 2, y - 0.3));
    }
  // Freight: the track in lengths that follow the ground, a buffer stop at its east end, the wagons.
  // A length on a slope is cut shorter, so that no two lengths stand further apart than a step a walker takes along it.
  for (const run of FREIGHT_LINES)
    for (const { a, b } of lengths(run, 6)) {
      const n = Math.max(1, Math.ceil(Math.abs(g(a[0], a[1]) - g(b[0], b[1])) / 0.35));
      for (let k = 0; k < n; k++) {
        const [x0, z0] = [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n];
        const [x1, z1] = [a[0] + ((b[0] - a[0]) * (k + 1)) / n, a[1] + ((b[1] - a[1]) * (k + 1)) / n];
        out.push(...track(x0, z0, x1, z1, g((x0 + x1) / 2, (z0 + z1) / 2)));
      }
    }
  const main = FREIGHT_LINES[0];
  const [ex, ez] = main[main.length - 1];
  out.push(box(ex + 0.5, ez, 1.0, 2.6, g(ex, ez) + 1.3, "steel", 0, g(ex, ez) - 0.2));
  for (const w of FREIGHT_WAGONS) out.push(...wagon(w.x, w.z, w.alongX, w.load, w.tint, Math.min(g(w.x - 6, w.z), g(w.x + 6, w.z), g(w.x, w.z - 6), g(w.x, w.z + 6)) - 0.1));
  return out;
})();

/**
 * Perimeter fences round the base's works, in the world's coordinates: steel bars 2.6 m high in
 * panels that follow the ground, which stop a body but not a look or a shot (`rayWorld` passes
 * them, `cover.ts` takes none behind them). A fence is the way a place is entered only by its
 * gates: each run is a line of legs along x or z, and a panel is left out where a street or a
 * kept road crosses it (a gate, a white post each side), where anything built stands in its way
 * (the freight line's track, a wall) and on cliffs, so it closes the open ground between and
 * nothing else.
 */
const FENCES: { name: string; line: [number, number][] }[] = [
  { name: "コンテナヤードの外周", line: [[-250, -664], [-98, -664], [-98, -762], [-250, -762], [-250, -664]] },
  { name: "製錬所の外周", line: [[104, -696], [224, -696], [224, -780], [104, -780], [104, -696]] },
  { name: "補給所の境界", line: [[-115, 300], [128, 300], [128, 480]] },
];
/** Where a street or a kept road passes through a fence (`FENCES`): the middle of the gate's first missing panel. */
export const GATES: { name: string; x: number; z: number }[] = [];
const FENCE_RUNS: Box[] = (() => {
  const out: Box[] = [];
  const standing = [...AUTHORED, ...BRIDGE, ...RAILWAY, ...QUAY, ...LAID, ...WORKS_LINES].filter((b) => b.y0 < terrainHeight((b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2) + 3);
  const roads = KEPT_ROADS.flatMap((name) => {
    const line = roadLine(name);
    return line.slice(1).map((q, k) => [line[k], q] as const);
  });
  const toRoad = (x: number, z: number) =>
    Math.min(
      ...roads.map(([p, q]) => {
        const dx = q[0] - p[0];
        const dz = q[1] - p[1];
        const t = Math.max(0, Math.min(1, ((x - p[0]) * dx + (z - p[1]) * dz) / (dx * dx + dz * dz || 1)));
        return Math.hypot(x - p[0] - dx * t, z - p[1] - dz * t);
      }),
    );
  const gatePost = (x: number, z: number) => {
    const g = terrainHeight(x, z);
    out.push(box(x, z, 0.3, 0.3, g + 3.0, "steel", 4, g - 0.3));
  };
  for (const f of FENCES) {
    // Whether the last panel stood, and whether the gap since was a street's.
    let open = false;
    let gate = false;
    for (const { a, b, alongX } of lengths(f.line, 3)) {
      const mx = (a[0] + b[0]) / 2;
      const mz = (a[1] + b[1]) / 2;
      const panel = alongX ? rect(Math.min(a[0], b[0]), mz - 0.04, Math.max(a[0], b[0]), mz + 0.04, 0, 1, "fence", 0) : rect(mx - 0.04, Math.min(a[1], b[1]), mx + 0.04, Math.max(a[1], b[1]), 0, 1, "fence", 0);
      const street = offStreet(mx, mz) < 2 || toRoad(mx, mz) < 7;
      const blocked =
        street ||
        steepAt(mx, mz) ||
        steepAt(a[0], a[1]) ||
        steepAt(b[0], b[1]) ||
        offshore(mx, mz) > -2 ||
        standing.some((o) => o.x1 + 0.8 > panel.x0 && panel.x1 + 0.8 > o.x0 && o.z1 + 0.8 > panel.z0 && panel.z1 + 0.8 > o.z0) ||
        KEEP.points.some((q) => Math.hypot(Math.max(panel.x0 - q.x, 0, q.x - panel.x1), Math.max(panel.z0 - q.z, 0, q.z - panel.z1)) < q.r);
      if (blocked) {
        // A gate where a street or road passes: a white post at either side of it.
        if (open && street) gatePost(a[0], a[1]);
        if (street && !gate) GATES.push({ name: f.name, x: mx, z: mz });
        gate = street;
        open = false;
        continue;
      }
      if (gate) gatePost(a[0], a[1]);
      const g = Math.min(terrainHeight(a[0], a[1]), terrainHeight(b[0], b[1]), terrainHeight(mx, mz));
      out.push({ ...panel, y0: g - 0.2, h: g + 2.6 });
      out.push(box(a[0], a[1], 0.14, 0.14, g + 2.8, "steel", 2, g - 0.3));
      open = true;
      gate = false;
    }
  }
  return out;
})();

/**
 * The ring's own wreckage: lengths of the orbital ring that came down on the island on the day it
 * fell, lying on the open ground between the POIs in the world's coordinates. Each is a box girder
 * 20 m across whose back stands about 18 m over the highest ground under it, sunk into the ground
 * along its length, so nothing crosses it but where it is broken: gaps between its lengths to go
 * through, a hollow length to walk through as a tunnel (its sides torn open where `tunnel` says),
 * and heaps of rubble against one side (`rubble`) to climb onto its back, from which the far side
 * is a drop with no way back up. A broken-off length may lie leaning across one (`lean`): its foot
 * on the ground, its top resting on the back, a ramp up whose high end is an arch to walk under.
 * They are the big shapes that close the open ground into ways.
 */
const RING = {
  /** Half its width, and how high its back stands over the highest ground under it. */
  half: 10,
  back: 18,
  /** The lengths its sides follow the ground in, and the tunnel's roof over that highest ground. */
  step: 8,
  tunnel: 6,
  /** Each step of a rubble heap: its rise, its tread out from the side, and how wide it runs along. */
  rise: 1.5,
  tread: 1.8,
  heap: 7,
  /** A leaning length: half its width, its girder's depth under its deck, the most a stride of it rises. */
  leanHalf: 5,
  leanDepth: 3.5,
  leanRise: 0.42,
};
interface RingWreck {
  name: string;
  /** It lies along `along` from `a` to `b`, its middle `at` across. */
  along: "x" | "z";
  at: number;
  a: number;
  b: number;
  broken: { a?: true; b?: true };
  /** Hollow: a tunnel the length of it, its sides torn open over these ranges along it on side -1 or +1. */
  tunnel?: { side: -1 | 1; a: number; b: number }[];
  /** Heaps of rubble against side -1 or +1, centred `u` along it. */
  rubble?: { side: -1 | 1; u: number }[];
  /** A length leaning across it at `u`, its foot on the ground `length` metres out on `side`. */
  lean?: { side: -1 | 1; u: number; length: number };
}
const RING_WRECKS: RingWreck[] = [
  // South of the quarry: three lengths stepping east, the middle one hollow, between the quarry's
  // rim and the dunes of the coast.
  { name: "採掘場の南の残骸（西の端）", along: "x", at: 202, a: -506, b: -470, broken: { b: true } },
  { name: "採掘場の南の残骸（西）", along: "x", at: 215, a: -455, b: -380, broken: { b: true }, rubble: [{ side: 1, u: -420 }] },
  { name: "採掘場の南の残骸（中）", along: "x", at: 230, a: -366, b: -296, broken: { a: true, b: true }, tunnel: [{ side: -1, a: -352, b: -342 }, { side: 1, a: -322, b: -312 }], lean: { side: 1, u: -334, length: 62 } },
  { name: "採掘場の南の残骸（東）", along: "x", at: 250, a: -282, b: -214, broken: { a: true }, rubble: [{ side: -1, u: -240 }] },
  // North of the relay's mesa: lengths across the fields, broken where the roads, a patrol and a
  // power line pass.
  { name: "西の残骸（桟橋の北）", along: "z", at: -498, a: 112, b: 178, broken: { a: true }, rubble: [{ side: 1, u: 150 }] },
  { name: "中継塔の北の残骸（西）", along: "x", at: -115, a: 110, b: 168, broken: { b: true }, rubble: [{ side: 1, u: 140 }] },
  { name: "中継塔の北の残骸（西の端）", along: "x", at: -117, a: 196, b: 230, broken: { a: true, b: true } },
  { name: "中継塔の北の残骸（中）", along: "x", at: -112, a: 252, b: 318, broken: { a: true, b: true }, tunnel: [{ side: 1, a: 266, b: 276 }, { side: -1, a: 294, b: 304 }], lean: { side: 1, u: 286, length: 56 } },
  // The east coast: two lengths along it, the northern one hollow, between the relay's mesa and the
  // shore, the gap between them the way along it.
  { name: "東の浜の残骸（検問道の南）", along: "z", at: 440, a: -34, b: 26, broken: { a: true, b: true }, lean: { side: -1, u: -4, length: 48 } },
  { name: "東の浜の残骸（北）", along: "z", at: 440, a: 40, b: 118, broken: { b: true }, tunnel: [{ side: -1, a: 70, b: 80 }] },
  { name: "東の浜の残骸（南）", along: "z", at: 432, a: 134, b: 200, broken: { a: true }, rubble: [{ side: -1, u: 180 }] },
  { name: "東の浜の残骸（工場の東）", along: "z", at: 436, a: 262, b: 318, broken: { a: true }, tunnel: [{ side: -1, a: 284, b: 294 }] },
  // The west: two lengths along the coast west of the quarry, a length leaning across the
  // southern one from the quarry's side.
  { name: "西の残骸（北）", along: "z", at: -500, a: -56, b: 6, broken: { b: true }, rubble: [{ side: 1, u: -40 }] },
  { name: "西の残骸（南）", along: "z", at: -498, a: 22, b: 96, broken: { a: true }, lean: { side: 1, u: 60, length: 50 } },
  // The harbor: lengths on its open ground in each quarter, between the town, the yard, the smelter
  // and the wreck.
  { name: "難破船の西の残骸（北）", along: "x", at: -1060, a: -260, b: -190, broken: { b: true }, rubble: [{ side: 1, u: -230 }] },
  { name: "難破船の西の残骸（南）", along: "z", at: -210, a: -1035, b: -975, broken: { a: true }, tunnel: [{ side: -1, a: -1015, b: -1005 }] },
  { name: "難破船の西の残骸（漁村の東）", along: "z", at: -214, a: -960, b: -908, broken: { a: true }, rubble: [{ side: 1, u: -934 }] },
  { name: "港町の西の残骸（町の外れ）", along: "x", at: -560, a: -190, b: -140, broken: { a: true }, tunnel: [{ side: 1, a: -170, b: -160 }] },
  { name: "港町の東の残骸（線路の北）", along: "z", at: 334, a: -720, b: -654, broken: { b: true }, rubble: [{ side: -1, u: -700 }] },
  { name: "港町の西の残骸（西）", along: "x", at: -565, a: -350, b: -290, broken: { b: true }, rubble: [{ side: -1, u: -320 }] },
  { name: "港町の西の残骸（東）", along: "x", at: -556, a: -276, b: -205, broken: { a: true }, lean: { side: 1, u: -240, length: 46 } },
  { name: "港町の東の残骸（北）", along: "z", at: 300, a: -628, b: -572, broken: { b: true }, tunnel: [{ side: -1, a: -606, b: -596 }] },
  { name: "港町の東の残骸（南）", along: "z", at: 308, a: -556, b: -486, broken: { a: true }, rubble: [{ side: 1, u: -520 }] },
  { name: "製錬所の北の残骸（難破船の北）", along: "x", at: -1062, a: 56, b: 124, broken: { b: true }, tunnel: [{ side: 1, a: 84, b: 94 }] },
  { name: "製錬所の北の残骸（西）", along: "x", at: -1060, a: 140, b: 205, broken: { b: true }, rubble: [{ side: 1, u: 172 }] },
  { name: "製錬所の北の残骸（東）", along: "x", at: -1024, a: 216, b: 285, broken: { a: true }, lean: { side: 1, u: 250, length: 46 } },
  { name: "中継塔の北の残骸（東）", along: "x", at: -105, a: 340, b: 388, broken: { a: true }, rubble: [{ side: 1, u: 362 }] },
];
/**
 * The ways through the ring's wreckage on foot: the gap between two lengths lying end to end on
 * one line, at its middle, and a hollow length's tunnel, at each of its torn openings.
 */
export const RING_GAPS: { name: string; x: number; z: number }[] = (() => {
  const out: { name: string; x: number; z: number }[] = [];
  const at = (w: RingWreck, u: number, v: number) => (w.along === "x" ? { x: u, z: w.at + v } : { x: w.at + v, z: u });
  for (const w of RING_WRECKS) {
    for (const o of RING_WRECKS) {
      if (o === w || o.along !== w.along || Math.abs(o.at - w.at) > 25 || !w.broken.b || !o.broken.a) continue;
      const gap = o.a - w.b;
      if (gap > 0 && gap < 40) out.push({ name: w.name, ...at(w, (w.b + o.a) / 2, (w.at + o.at) / 2 - w.at) });
    }
    for (const t of w.tunnel ?? []) out.push({ name: w.name, ...at(w, (t.a + t.b) / 2, t.side * (RING.half + 4)) });
  }
  return out;
})();
const RING_RUNS: Box[] = (() => {
  const out: Box[] = [];
  const SCORCH = 1.6;
  for (const w of RING_WRECKS) {
    // A box in the wreck's own terms: u along it, v across it from its middle.
    const R = (u0: number, v0: number, u1: number, v1: number, y0: number, h: number, kind: BoxKind, tint = 0): Box =>
      w.along === "x" ? rect(Math.min(u0, u1), w.at + Math.min(v0, v1), Math.max(u0, u1), w.at + Math.max(v0, v1), y0, h, kind, tint) : rect(w.at + Math.min(v0, v1), Math.min(u0, u1), w.at + Math.max(v0, v1), Math.max(u0, u1), y0, h, kind, tint);
    const ground = (u: number, v: number) => (w.along === "x" ? terrainHeight(u, w.at + v) : terrainHeight(w.at + v, u));
    const H = RING.half;
    let high = -Infinity;
    for (let u = w.a; u <= w.b; u += 2) for (const v of [-H, 0, H]) high = Math.max(high, ground(u, v));
    const top = high + RING.back;
    const side = top - 4;
    const shoulder = top - 2;
    // A run from u0 to u1, its broken ends scorched, `reach` running it on past the sides there.
    const run = (v0: number, v1: number, y0: number, h: number, reach = 0, u0 = w.a, u1 = w.b) => {
      const ua = w.broken.a && u0 === w.a ? u0 - reach : u0;
      const ub = w.broken.b && u1 === w.b ? u1 + reach : u1;
      const lo = w.broken.a && u0 === w.a ? ua + SCORCH : ua;
      const hi = w.broken.b && u1 === w.b ? ub - SCORCH : ub;
      out.push(R(lo, v0, hi, v1, y0, h, "steel", 5));
      if (lo > ua) out.push(R(ua, v0, lo, v1, y0, h, "steel", 7));
      if (hi < ub) out.push(R(hi, v0, ub, v1, y0, h, "steel", 7));
    };
    // The lowest ground under each length, where its sides start: sunk a metre into it.
    const foot = (u0: number, u1: number) => {
      let lo = Infinity;
      for (let u = u0; u <= u1 + 0.01; u += 2) for (const v of [-H - 0.5, 0, H + 0.5]) lo = Math.min(lo, ground(u, v));
      return lo - 1;
    };
    const lengthsAlong: [number, number][] = [];
    for (let u = w.a; u < w.b - 0.01; u += RING.step) lengthsAlong.push([u, Math.min(w.b, u + RING.step)]);
    const torn = (sd: -1 | 1, u: number) => (w.tunnel ?? []).some((g) => g.side === sd && u > g.a && u < g.b);
    if (!w.tunnel) {
      for (const [u0, u1] of lengthsAlong) run(-H, H, foot(u0, u1), side, 0, u0, u1);
    } else {
      // Its sides, torn open where breached, its roof over the tunnel, the back over that.
      const roof = high + RING.tunnel;
      for (const sd of [-1, 1] as const)
        for (const [u0, u1] of lengthsAlong) {
          const f = foot(u0, u1);
          let cur = u0;
          for (const g of (w.tunnel ?? []).filter((g) => g.side === sd && g.b > u0 && g.a < u1).sort((p, q) => p.a - q.a)) {
            if (g.a > cur) run(sd * (H - 1.8), sd * H, f, side, 0, cur, g.a);
            cur = Math.max(cur, g.b);
          }
          if (cur < u1) run(sd * (H - 1.8), sd * H, f, side, 0, cur, u1);
        }
      run(-H + 1.8, H - 1.8, roof, side);
    }
    run(-H + 1.5, H - 1.5, side, shoulder, 1.2);
    run(-H + 4, H - 4, shoulder, top, 2.5);
    // Darker ribs round it every 12 m.
    for (let u = w.a + 6; u + 0.8 < w.b - 2; u += 12) {
      const f = foot(u, u + 0.8);
      for (const sd of [-1, 1] as const) if (!torn(sd, u) && !torn(sd, u + 0.8)) out.push(R(u, sd * H, u + 0.8, sd * (H + 0.3), f, side + 0.3, "steel", 6));
      out.push(R(u, -H + 1.2, u + 0.8, H - 1.2, side, shoulder + 0.3, "steel", 6));
      out.push(R(u, -H + 3.7, u + 0.8, H - 3.7, shoulder, top + 0.3, "steel", 6));
    }
    // Rubble heaped against a side, stepping up to the top of its side: from there a climb of two
    // shoulders onto its back.
    for (const r of w.rubble ?? []) {
      const g0 = ground(r.u, r.side * (H + 4));
      const n = Math.max(1, Math.ceil((side - g0) / RING.rise));
      for (let k = 0; k < n; k++) {
        const out0 = H + (n - k) * RING.tread;
        const wob = ((k * 37) % 5) - 2;
        const lo = Math.min(ground(r.u, r.side * out0), ground(r.u - RING.heap / 2, r.side * out0), ground(r.u + RING.heap / 2, r.side * out0)) - 0.5;
        out.push(R(r.u - RING.heap / 2 + wob * 0.3, r.side * (H - 0.5), r.u + RING.heap / 2 + wob * 0.3, r.side * out0, lo, Math.min(side, g0 + (k + 1) * RING.rise), "rock", k % 2));
      }
    }
    // The leaning length: strides up from the ground to a little over the back, each a girder
    // `leanDepth` deep under its deck or down to the ground where that is nearer, so its low end
    // is solid and its high end an arch. It is crossed only by its deck.
    if (w.lean) {
      const { side: sd, u, length } = w.lean;
      const L = RING.leanHalf;
      const v1 = sd * (H + length);
      const g0 = Math.min(ground(u - L, v1), ground(u + L, v1));
      const end = top + 0.3;
      const n = Math.ceil((end - g0) / RING.leanRise);
      const stride = (length + H - 4) / n;
      for (let k = 0; k < n; k++) {
        const va = v1 - sd * k * stride;
        const vb = v1 - sd * (k + 1) * stride;
        const deck = g0 + (k + 1) * ((end - g0) / n);
        const under = Math.min(ground(u - L, va), ground(u + L, va), ground(u - L, vb), ground(u + L, vb)) - 0.5;
        const y0 = deck - RING.leanDepth < under + 2.6 ? under : deck - RING.leanDepth;
        out.push(R(u - L, va, u + L, vb, y0, deck, "steel", k % 6 === 5 ? 6 : 5));
        // Its webs standing a little over the deck along both edges, so it reads as a girder, not a stair.
        for (const e of [-1, 1]) out.push(R(u + e * L, va, u + e * (L - 0.5), vb, deck, deck + 1.1, "steel", 6));
      }
      // Its foot torn off and scorched where it broke.
      out.push(R(u - L - 0.3, v1, u + L + 0.3, v1 - sd * 1.6, g0 - 1, g0 + 0.9, "steel", 7));
    }
  }
  return out;
})();

/** Everything placed by hand or laid by rule before the streets are lined: what `scripts/ringfall-roads.ts` routes them round. */
export const PLACED: Box[] = [...AUTHORED, ...BRIDGE, ...RAILWAY, ...QUAY, ...LAID, ...WORKS_LINES, ...FENCE_RUNS, ...RING_RUNS];
/**
 * What lines the streets (streets.ts), laid on the ground once it is built: lamp posts along every
 * length on alternate sides, a signpost where each street leaves its first junction, and traffic
 * left where it stopped on the day the ring fell, a queue of cars and lorries in one lane of a
 * street, the other lane left clear. Queues stand only on lengths that run along x or z (their
 * vehicles are boxes along the axes) and away from bends, junctions, authored points,
 * patrol legs and kept roads.
 */
const STREET_SIDE: Box[] = (() => {
  const out: Box[] = [];
  const near = PLACED;
  const free = (b: Box, gap: number) =>
    !steepAt((b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2) &&
    near.every((o) => o.x1 + gap <= b.x0 || b.x1 + gap <= o.x0 || o.z1 + gap <= b.z0 || b.z1 + gap <= o.z0 || o.y0 > terrainHeight((o.x0 + o.x1) / 2, (o.z0 + o.z1) / 2) + 3) &&
    KEEP.points.every((q) => Math.hypot(Math.max(b.x0 - q.x, 0, q.x - b.x1), Math.max(b.z0 - q.z, 0, q.z - b.z1)) > q.r + 1) &&
    KEEP.segments.every((sg) => toSegment(sg, (b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2) > Math.hypot(b.x1 - b.x0, b.z1 - b.z0) / 2 + 2.5);
  const toSegment = (sg: Keep["segments"][number], x: number, z: number) => {
    const dx = sg.bx - sg.ax;
    const dz = sg.bz - sg.az;
    const t = Math.max(0, Math.min(1, ((x - sg.ax) * dx + (z - sg.az) * dz) / (dx * dx + dz * dz || 1)));
    return Math.hypot(x - sg.ax - dx * t, z - sg.az - dz * t);
  };
  // A vehicle stands on the lowest ground under its corners and keeps its height over the highest;
  // ground that rises more than half a metre under one is too rough to have stopped on.
  const underVehicle = (cx: number, cz: number, w: number, d: number): { lo: number; hi: number } | null => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const [x, z] of [[cx - w / 2, cz - d / 2], [cx + w / 2, cz - d / 2], [cx - w / 2, cz + d / 2], [cx + w / 2, cz + d / 2], [cx, cz]]) {
      if (steepAt(x, z)) return null;
      const g = terrainHeight(x, z);
      lo = Math.min(lo, g);
      hi = Math.max(hi, g);
    }
    return hi - lo > 0.5 ? null : { lo, hi };
  };
  const bends = STREETS.flatMap((st) => st.line);
  const nearBend = (x: number, z: number, r: number) => bends.some(([bx, bz]) => Math.hypot(bx - x, bz - z) < r);
  let seed = 9_041;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (const l of LENGTHS) {
    const len = Math.hypot(l.bx - l.ax, l.bz - l.az);
    const ux = (l.bx - l.ax) / len;
    const uz = (l.bz - l.az) / len;
    const h = l.street.half;
    // Lamp posts every 40 m, alternate sides, their arms reaching over the road.
    for (let t = 20, k = 0; t < len - 10; t += 40, k++) {
      const s = k % 2 === 0 ? 1 : -1;
      const x = l.ax + ux * t - uz * s * (h + 0.9);
      const z = l.az + uz * t + ux * s * (h + 0.9);
      if (offStreet(x, z) < 0.4 || nearBend(x, z, h + 6)) continue;
      const g = terrainHeight(x, z);
      const post = box(x, z, 0.22, 0.22, g + 7, "steel", 2, g - 0.3);
      if (!free(post, 0.6)) continue;
      // The arm along whichever axis points most nearly across the road, toward it.
      const ax = Math.abs(uz) > Math.abs(ux);
      const toward = ax ? Math.sign(uz * s) : -Math.sign(ux * s);
      const arm = ax ? rect(Math.min(x, x + toward * 1.8), z - 0.08, Math.max(x, x + toward * 1.8), z + 0.08, g + 6.8, g + 7, "steel", 2) : rect(x - 0.08, Math.min(z, z + toward * 1.8), x + 0.08, Math.max(z, z + toward * 1.8), g + 6.8, g + 7, "steel", 2);
      const head = ax ? box(x + toward * 1.8, z, 0.6, 0.3, g + 6.9, "steel", 4, g + 6.6) : box(x, z + toward * 1.8, 0.3, 0.6, g + 6.9, "steel", 4, g + 6.6);
      out.push(post, arm, head);
    }
    // A queue of traffic: on lengths along an axis, one every 140 m or so, in one lane.
    const alongX = Math.abs(ux) > 0.94;
    const alongZ = Math.abs(uz) > 0.94;
    if (!alongX && !alongZ) continue;
    for (let t = 30 + rnd() * 40; t < len - 30; t += 120 + rnd() * 60) {
      const lane = (rnd() < 0.5 ? 1 : -1) * h * 0.45;
      const queue: Box[] = [];
      let at = t;
      const n = 3 + Math.floor(rnd() * 3);
      for (let i = 0; i < n && at < len - 20; i++) {
        const lorry = rnd() < 0.3;
        const long = lorry ? 7.4 : 4.5;
        const cx = l.ax + ux * (at + long / 2) - uz * lane;
        const cz = l.az + uz * (at + long / 2) + ux * lane;
        if (nearBend(cx, cz, h + 12)) break;
        const under = alongX ? underVehicle(cx, cz, long, 2.5) : underVehicle(cx, cz, 2.5, long);
        if (!under) break;
        const { lo, hi } = under;
        const piece = lorry
          ? alongX
            ? [box(cx - (2.55 * Math.sign(ux)), cz, 2.3, 2.5, hi + 3.0, "prop", PROP.cab, lo), box(cx + (1.15 * Math.sign(ux)), cz, 5, 2.5, hi + 2.3, "prop", PROP.bed, lo)]
            : [box(cx, cz - (2.55 * Math.sign(uz)), 2.5, 2.3, hi + 3.0, "prop", PROP.cab, lo), box(cx, cz + (1.15 * Math.sign(uz)), 2.5, 5, hi + 2.3, "prop", PROP.bed, lo)]
          : [alongX ? box(cx, cz, 4.5, 1.9, hi + 1.5, "prop", PROP.car, lo) : box(cx, cz, 1.9, 4.5, hi + 1.5, "prop", PROP.car, lo)];
        if (!piece.every((b) => free(b, 1.5))) break;
        queue.push(...piece);
        at += long + 1.5 + rnd() * 3;
      }
      if (queue.length >= 2) out.push(...queue);
    }
  }
  // A signpost at the start of each street, on its right.
  for (const st of STREETS) {
    const [[x0, z0], [x1, z1]] = st.line;
    const len = Math.hypot(x1 - x0, z1 - z0);
    const ux = (x1 - x0) / len;
    const uz = (z1 - z0) / len;
    const x = x0 + ux * (st.half + 8) - uz * (st.half + 1.6);
    const z = z0 + uz * (st.half + 8) + ux * (st.half + 1.6);
    const g = terrainHeight(x, z);
    const sign = [box(x, z, 0.16, 0.16, g + 3.2, "steel", 2, g - 0.3), Math.abs(ux) > Math.abs(uz) ? box(x, z, 0.1, 1.8, g + 3.3, "steel", 3, g + 2.3) : box(x, z, 1.8, 0.1, g + 3.3, "steel", 3, g + 2.3)];
    if (offStreet(x, z) > 0.3 && sign.every((b) => free(b, 0.5))) out.push(...sign);
  }
  return out;
})();

/** Everything placed by hand or laid by rule, before the scattered cover fills the ground round it. */
export const BUILT: Box[] = [...PLACED, ...STREET_SIDE];

/** The nodes of the front (docs/ringfall/island-v2.md): the six POIs the player can take; the titan's pad is the enemy's for good. */
export type NodeId = Exclude<PoiId, "pad">;

/**
 * A node of the front: a freeable POI, where it stands (its middle), and its core (`FRONT`): the
 * pillar whose capture takes it, on the ground near the middle.
 */
export interface FrontNode {
  id: NodeId;
  name: string;
  region: RegionId;
  x: number;
  z: number;
  core: { x: number; y: number; z: number };
}

/**
 * Which nodes are next to which, along the roads between them: the camp to the supply depot,
 * the supply depot to the quarry and the relay, the pass road from the quarry to the yard and the
 * railway from the relay to the smelter, and the harbor's two roads to the wreck. Kept as data,
 * so routing the streets afresh does not move the front; the sim gate walks each link.
 */
export const FRONT_LINKS: readonly (readonly ["camp" | NodeId, NodeId])[] = [
  ["camp", "supply"],
  ["supply", "quarry"],
  ["supply", "relay"],
  ["supply", "station"],
  ["station", "quarry"],
  ["supply", "waterworks"],
  ["waterworks", "relay"],
  ["quarry", "lodge"],
  ["lodge", "yard"],
  ["lodge", "smelter"],
  ["relay", "smelter"],
  ["yard", "cannery"],
  ["cannery", "wreck"],
  ["smelter", "coldstore"],
  ["coldstore", "wreck"],
];

/**
 * Each node's tier (docs/ringfall/island-v2.md, 拠点の段): how deep it lies from the camp, 0 by
 * the camp's gate to 3 at the far end of the harbor.
 */
export const TIER: Record<NodeId, number> = { supply: 0, quarry: 1, relay: 1, station: 1, waterworks: 1, lodge: 2, yard: 2, smelter: 2, cannery: 2, coldstore: 2, wreck: 3 };

/**
 * What holding each node opens (docs/ringfall/island-v2.md, 拠点の段), for as long as it is held:
 * `shop`, the best rarity of weapon (and tier of armour) the trader sells; `depart`, starts from
 * its depot; `squad`, more squads the factory keeps out at once in the battle; `scout`, the
 * direction reinforcements beam in from shown in the raid; `shore`, no enemy boats land on the
 * harbor's north shore.
 */
export interface NodeUnlock {
  shop?: Rarity;
  depart?: true;
  squad?: number;
  scout?: true;
  shore?: true;
}
export const UNLOCKS: Record<NodeId, NodeUnlock> = {
  supply: { shop: 1, depart: true },
  quarry: { shop: 2, squad: 1 },
  relay: { shop: 2, scout: true },
  yard: { shop: 3, depart: true },
  smelter: { shop: 3, squad: 1 },
  wreck: { shore: true },
  station: {},
  waterworks: {},
  lodge: { depart: true },
  cannery: {},
  coldstore: {},
};

/**
 * The nodes next to ground the enemy never gives up, where its squads land in the battle however
 * much round them the player holds: the titan's pad (no node) by the quarry's road and the mesa's,
 * and the harbor's north shore, where the enemy's boats come in.
 */
export const NET_EDGE: readonly NodeId[] = ["quarry", "relay", "wreck"];

/**
 * The core's spot of the node standing at (x, z): the open, level ground nearest its middle with
 * room round it and nothing overhead, clear of the authored points, the patrol legs, the kept
 * roads and the depots, so it closes no way a walker takes. Looked for on rings out from the middle.
 */
function coreSpot(x: number, z: number, near: Box[]): { x: number; y: number; z: number } {
  const ROOM = 3;
  const depots = POIS.map(depotSpot);
  const toSeg = (sg: Keep["segments"][number], px: number, pz: number) => {
    const dx = sg.bx - sg.ax;
    const dz = sg.bz - sg.az;
    const t = Math.max(0, Math.min(1, ((px - sg.ax) * dx + (pz - sg.az) * dz) / (dx * dx + dz * dz || 1)));
    return Math.hypot(px - sg.ax - dx * t, pz - sg.az - dz * t);
  };
  for (let r = 0; r <= 60; r += 3)
    for (let k = 0, n = r ? Math.max(8, Math.round((2 * Math.PI * r) / 3)) : 1; k < n; k++) {
      const a = (k / n) * 2 * Math.PI;
      const px = +(x + Math.sin(a) * r).toFixed(1);
      const pz = +(z - Math.cos(a) * r).toFixed(1);
      const g = terrainHeight(px, pz);
      if (offshore(px, pz) > -6 || highGround(px, pz)) continue;
      if ([[0, 0], [ROOM, 0], [-ROOM, 0], [0, ROOM], [0, -ROOM]].some(([dx, dz]) => steepAt(px + dx, pz + dz) || Math.abs(terrainHeight(px + dx, pz + dz) - g) > 0.6)) continue;
      if (near.some((b) => b.x1 > px - ROOM && b.x0 < px + ROOM && b.z1 > pz - ROOM && b.z0 < pz + ROOM && b.h > g + 0.15 && b.y0 < g + 8)) continue;
      if (KEEP.points.some((q) => Math.hypot(q.x - px, q.z - pz) < q.r + ROOM)) continue;
      if (KEEP.segments.some((sg) => toSeg(sg, px, pz) < ROOM + 1)) continue;
      if (depots.some((d) => Math.hypot(d.x - px, d.z - pz) < 8)) continue;
      if (deckAt(px, pz) !== null) continue;
      return { x: px, y: g, z: pz };
    }
  throw new Error(`no spot for a core near ${x},${z}`);
}

/** The front's nodes: the freeable POIs in `POIS` order. */
export const NODES: FrontNode[] = POIS.filter((p) => !p.boss).map((p): FrontNode => ({
  id: p.id as NodeId,
  name: p.name,
  region: poiRegion(p.id).id,
  x: p.x,
  z: p.z,
  core: coreSpot(p.x, p.z, [...BUILT, ...CAMP_BOXES].filter((b) => b.x1 > p.x - 70 && b.x0 < p.x + 70 && b.z1 > p.z - 70 && b.z0 < p.z + 70)),
}));

/** A node's place in `NODES` (and in the run's per-node state), from its id; -1 for none. */
export const nodeIndex = (id: string) => NODES.findIndex((n) => n.id === id);

/** The cores, as boxes: standing pillars the player walks round and shoots past. */
const CORE_BOXES: Box[] = NODES.map((n) => box(n.core.x, n.core.z, 2 * FRONT.half, 2 * FRONT.half, n.core.y + FRONT.height, "steel", 2, n.core.y - 0.3));

/**
 * The spots a zipline mast may stand on near (x, z), at most `n`, each `apart` from the others:
 * open, level ground at least `ZIP.fromCore` from a core and out to `reach`, clear of the authored
 * points, the kept roads and patrol legs, the depots and anything built, looked for on rings out
 * from there as `coreSpot()` looks for a core's.
 */
function mastSpots(x: number, z: number, near: Box[], reach = 70, n = 12, apart = 12): { x: number; z: number; r: number }[] {
  const ROOM = 2;
  const depots = POIS.map(depotSpot);
  const toSeg = (sg: Keep["segments"][number], px: number, pz: number) => {
    const dx = sg.bx - sg.ax;
    const dz = sg.bz - sg.az;
    const t = Math.max(0, Math.min(1, ((px - sg.ax) * dx + (pz - sg.az) * dz) / (dx * dx + dz * dz || 1)));
    return Math.hypot(px - sg.ax - dx * t, pz - sg.az - dz * t);
  };
  const out: { x: number; z: number; r: number }[] = [];
  for (let r = ZIP.fromCore; r <= reach && out.length < n; r += 3)
    for (let k = 0, m = Math.max(8, Math.round((2 * Math.PI * r) / 3)); k < m && out.length < n; k++) {
      const a = (k / m) * 2 * Math.PI;
      const px = +(x + Math.sin(a) * r).toFixed(1);
      const pz = +(z - Math.cos(a) * r).toFixed(1);
      if (out.some((o) => Math.hypot(o.x - px, o.z - pz) < apart)) continue;
      const g = terrainHeight(px, pz);
      if (offshore(px, pz) > -6 || highGround(px, pz) || inCamp({ x: px, z: pz }, 2)) continue;
      if ([[0, 0], [ROOM, 0], [-ROOM, 0], [0, ROOM], [0, -ROOM]].some(([dx, dz]) => steepAt(px + dx, pz + dz) || Math.abs(terrainHeight(px + dx, pz + dz) - g) > 0.6)) continue;
      if (near.some((b) => b.x1 > px - ROOM - 1 && b.x0 < px + ROOM + 1 && b.z1 > pz - ROOM - 1 && b.z0 < pz + ROOM + 1 && b.h > g + 0.15 && b.y0 < g + 8)) continue;
      if (KEEP.points.some((q) => Math.hypot(q.x - px, q.z - pz) < q.r + ROOM)) continue;
      if (KEEP.segments.some((sg) => toSeg(sg, px, pz) < ROOM + 1)) continue;
      if (depots.some((d) => Math.hypot(d.x - px, d.z - pz) < 8)) continue;
      if (NODES.some((c) => Math.hypot(c.core.x - px, c.core.z - pz) < ZIP.fromCore)) continue;
      if (deckAt(px, pz) !== null) continue;
      out.push({ x: px, z: pz, r });
    }
  return out;
}

/** Where the ziplines' masts may stand: round each node's core, and outside the camp's gate. */
const ZIP_SPOTS: Record<string, { x: number; z: number; r: number }[]> = (() => {
  const built = [...BUILT, ...CAMP_BOXES, ...CORE_BOXES];
  const around = (x: number, z: number) => built.filter((b) => b.x1 > x - 90 && b.x0 < x + 90 && b.z1 > z - 90 && b.z0 < z + 90);
  const gx = (CAMP.gate.x0 + CAMP.gate.x1) / 2;
  const gz = CAMP.gate.z - 6;
  return { camp: mastSpots(gx, gz, around(gx, gz), 30, 6), ...Object.fromEntries(NODES.map((c) => [c.id, mastSpots(c.core.x, c.core.z, around(c.core.x, c.core.z))])) };
})();
const ZIP_LAYOUT = layZips(ZIP_SPOTS, FRONT_LINKS, [...BUILT, ...CAMP_BOXES, ...CORE_BOXES], QUARRY_LIFTS);
/** The ziplines, one for each link of `FRONT_LINKS` that could carry one; up while both ends are the player's (zips.ts). */
export const ZIPS: readonly ZipLine[] = ZIP_LAYOUT.lines;
/** The links that carry no zipline, and why. */
export const ZIP_MISSING = ZIP_LAYOUT.missing;
/** The ziplines' masts, arms and pylons (in `BOXES`, last). */
export const ZIP_BOXES: readonly Box[] = ZIP_LAYOUT.boxes;
/** Under a cable the scattered cover keeps clear, so the hanging body passes over all of it. */
const ZIP_KEEP: Keep["segments"] = ZIPS.flatMap((l) => l.pts.slice(1).map((q, i) => ({ ax: l.pts[i].x, az: l.pts[i].z, bx: q.x, bz: q.z })));

// The camp comes last: what was laid before it keeps its place in the list (the cover spots, the walkers' grids).
// The cores keep the scattered cover off the ground they are taken from, and come after the camp; the ziplines' masts and pylons after them.
export const BOXES: Box[] = [
  ...BUILT,
  ...scatterCover([...BUILT, ...CAMP_BOXES, ...CORE_BOXES, ...ZIP_LAYOUT.boxes], { points: [...KEEP.points, ...NODES.map((n) => ({ x: n.core.x, z: n.core.z, r: 6 }))], segments: [...KEEP.segments, ...ZIP_KEEP] }),
  ...CAMP_BOXES,
  ...CORE_BOXES,
  ...ZIP_LAYOUT.boxes,
];

/** The bridge deck's height at (x, z) when it lies on a deck that path finding walks (DECKS), else null. */
export function deckAt(x: number, z: number): number | null {
  for (const d of DECKS) if (x >= d.x0 && x <= d.x1 && z >= d.z0 && z <= d.z1) return d.y;
  return null;
}

export type RouteId = "tunnel" | "dam" | "gangway";

/**
 * A way through the world that an obstacle blocks until its tool (`TOOLS`) reaches the stash;
 * from then on the obstacle is gone in every raid. A route through rock is a trench carved into
 * the ground (`carve`) only while it is open, roofed where it runs under high ground: closed,
 * the ground is the one every raid had before, so nothing walks, hunts or scatters over it, and
 * its obstacles (`closed`) stand set into the cliff where the way will open. `open` holds what
 * stands only once it is open (a roof, a gangway). Neither list is among `BOXES`.
 */
export interface Route {
  id: RouteId;
  name: string;
  tool: ToolKind;
  /** What opening it gives, in a line for the base. */
  note: string;
  /** Its way on foot from end to end: drawn on the world map, walked by the sim gate. */
  path: { x: number; z: number }[];
  /** On the ground in front of each obstacle, where the prompt naming the tool shows. */
  at: { x: number; y: number; z: number }[];
  carve?: Carve;
  closed: Box[];
  open: Box[];
}

/** Metres from an obstacle's `at` within which the HUD names the tool that opens it. */
export const ROUTE_PROMPT = 4.5;

/** Headroom under a route's roof, and the least rock left over it. */
const ROUTE_CEIL = 3.6;
const ROUTE_ROCK = 0.8;

/**
 * The first point, walking along z from `z` at `x` by `dir`, where the ground turns to cliff:
 * the foot of the rock a route cuts into.
 */
function cliffFoot(x: number, z: number, dir: 1 | -1): { z: number; y: number } {
  for (let d = 0; d < 80; d += 0.25) if (steepAt(x, z + dir * d)) return { z: z + dir * d, y: terrainHeight(x, z + dir * (d - 0.5)) };
  throw new Error(`no cliff from ${x},${z}`);
}

/**
 * The roof over a carved route that runs straight along z, in two-metre lengths: from
 * `ROUTE_CEIL` over the floor up to the lowest of the ground it was cut from, wide enough to
 * close the trench's walls below that. A length with less rock than `ROUTE_ROCK` over its
 * headroom stays open to the sky (a cutting at either end).
 */
function roofOver(c: Carve, kind: BoxKind, tint: number): Box[] {
  const [[x, za], [, zb]] = c.line;
  const dir = Math.sign(zb - za);
  const level = (z: number) => c.levels[0] + ((c.levels[1] - c.levels[0]) * (z - za)) / (zb - za);
  const out: Box[] = [];
  for (let k = 0; k < Math.round(Math.abs(zb - za) / 2); k++) {
    const z0 = za + dir * k * 2;
    const z1 = z0 + dir * 2;
    let top = Infinity;
    for (let t = 0; t <= 2; t += 0.5) for (let dx = -c.floor; dx <= c.floor; dx += 0.5) top = Math.min(top, terrainHeight(x + dx, z0 + dir * t));
    const lo = Math.min(level(z0), level(z1));
    const y0 = Math.max(level(z0), level(z1)) + ROUTE_CEIL;
    if (top < y0 + ROUTE_ROCK) continue;
    const half = c.floor + (top - lo) / c.slope + 0.4;
    out.push(rect(x - half, Math.min(z0, z1), x + half, Math.max(z0, z1), y0, top, kind, tint));
  }
  return out;
}

/**
 * How far into a cliff, past its foot, an obstacle's front stands: further than a body pressed
 * against the foot reaches (PLAYER.radius), so nothing that walks there ever touches it, and sight
 * between bodies on the ground in front never passes through it.
 */
const SET_IN = 0.45;

/**
 * A concrete frame set into a cliff at its foot (`foot`, the cliff rising toward `dir`),
 * `half` metres either side of x, filled with `fill`. It stands within the cliff's slope, off
 * the ground in front, which keeps that ground as it was for everything that walks it.
 */
function portal(x: number, foot: { z: number; y: number }, dir: 1 | -1, half: number, fill: Box[]): Box[] {
  const za = foot.z + dir * SET_IN;
  const zb = foot.z + dir * (SET_IN + 1);
  const [z0, z1] = [Math.min(za, zb), Math.max(za, zb)];
  const y = foot.y - 0.6;
  return [
    rect(x - half - 0.8, z0, x - half, z1, y, foot.y + 4.6, "wall", 0),
    rect(x + half, z0, x + half + 0.8, z1, y, foot.y + 4.6, "wall", 0),
    rect(x - half - 0.8, z0, x + half + 0.8, z1, foot.y + 3.8, foot.y + 4.9, "wall", 1),
    // The fill sits a little back in the frame.
    ...fill.map((b) => ({ ...b, z0: Math.min(za + dir * 0.3, zb), z1: Math.max(za + dir * 0.3, zb) })),
  ];
}

/** The rock fallen into a tunnel's mouth: blocks filling the frame up to its lintel, and some heaped in front. */
function rubble(x: number, foot: { z: number; y: number }, dir: 1 | -1, half: number): Box[] {
  const y = foot.y - 0.6;
  const fill = [rect(x - half, 0, x - 0.4, 0, y, foot.y + 3.8, "rock", 1), rect(x - 0.4, 0, x + half, 0, y, foot.y + 3.3, "rock", 0), rect(x + 0.6, 0, x + half, 0, foot.y + 3.3, foot.y + 3.8, "rock", 1)];
  const [h0, h1] = [foot.z + dir * SET_IN, foot.z + dir * (SET_IN + 0.3)];
  const heap = [-1.6, 1.1].map((dx, i) => rect(x + dx - 0.7, Math.min(h0, h1), x + dx + 0.7, Math.max(h0, h1), y, foot.y + 1.6 + i * 0.4, "rock", i));
  return [...portal(x, foot, dir, half, fill), ...heap];
}

/** A doorway closed by a chained gate of steel bars over a dark steel door. */
function chainedGate(x: number, foot: { z: number; y: number }, dir: 1 | -1, half: number): Box[] {
  const y = foot.y - 0.6;
  const door = [rect(x - half, 0, x + half, 0, y, foot.y + 3.8, "steel", 1)];
  // From the frame's front inward: the chain and padlock, the gate of bars, then the door.
  const front = foot.z + dir * SET_IN;
  const span = (a: number, b: number) => [Math.min(front + dir * a, front + dir * b), Math.max(front + dir * a, front + dir * b)] as const;
  const [c0, c1] = span(0, 0.12);
  const [f0, f1] = span(0.12, 0.26);
  return [
    ...portal(x, foot, dir, half, door),
    rect(x - half, f0, x + half, f1, foot.y - 0.1, foot.y + 3.4, "fence", 0),
    rect(x - half, c0, x + half, c1, foot.y + 1.15, foot.y + 1.3, "steel", 2),
    rect(x - 0.2, c0, x + 0.2, c1, foot.y + 0.85, foot.y + 1.3, "steel", 0),
  ];
}

/** The routes, in the order a tool opens them when more than one of its routes is closed. */
export const ROUTES: Route[] = (() => {
  const tunnel = TUNNEL;
  const tx = tunnel.line[0][0];
  const tSouth = cliffFoot(tx, tunnel.line[0][1], -1);
  const tNorth = cliffFoot(tx, tunnel.line[1][1], 1);
  const dam = GALLERY;
  const [hx, hz] = AREA.heart;
  const dx = dam.line[0][0];
  const dFoot = cliffFoot(dx, -100 + hz, -1);
  // The wreck's gangway: up the hull's north side to its main deck, forward of the middle,
  // written in the wreck's frame (from its hull's north face, `n`) so it moves with the wreck.
  const deck = LEVEL.seabed + SHIP_DECK;
  const [wx, wz] = AT[poiIndex("wreck")];
  const n = wz + SHIP.z - SHIP.beam / 2;
  const gx = wx + SHIP.x - 32.4;
  const gz = n - 1.3;
  // The deck's rail along the hull's north side: the gangway is chained against it, and lands over it.
  const rail = n + 0.25;
  const gangway = paint(lift(LEVEL.seabed, stairs(gx, gz, "w", 2.0, deck + 0.7 - LEVEL.seabed)), "step", "steel", () => 2);
  return [
    {
      id: "tunnel",
      name: "山の坑道",
      tool: "charge",
      note: "発着場の北の野から山地を抜けて港湾地帯の南の野へ。峠の登り降りがない",
      path: [{ x: tx, z: -266 }, { x: tx, z: -434 }],
      at: [{ x: tx, y: tSouth.y, z: tSouth.z + 2 }, { x: tx, y: tNorth.y, z: tNorth.z - 2 }],
      carve: tunnel,
      closed: [...rubble(tx, tSouth, -1, 3), ...rubble(tx, tNorth, 1, 3)],
      open: roofOver(tunnel, "rock", 1),
    },
    {
      id: "dam",
      name: "ダムの点検通路",
      tool: "cutter",
      note: "湖底からダムの中を登って堤と発着場へ。放水路や西の坂を回らずに済む",
      path: [{ x: dx, z: -100 + hz }, { x: dx, z: -178 + hz }],
      at: [{ x: dx, y: dFoot.y, z: dFoot.z + 2 }],
      carve: dam,
      closed: chainedGate(dx, dFoot, -1, 2.5),
      open: roofOver(dam, "wall", 0),
    },
    {
      id: "gangway",
      name: "難破船の舷梯",
      tool: "cutter",
      note: "難破船の北側から甲板へ直に上がる。船内の階段を通らない",
      path: [{ x: gx - 21, z: gz }, { x: gx + 1.2, z: n + 3 }],
      at: [{ x: gx, y: LEVEL.seabed, z: gz - 1.4 }],
      // Hauled aboard and stood up against the deck's rail, over the place it lands, chained there.
      closed: [
        rect(gx - 1.0, rail, gx + 1.0, n + 0.55, deck, deck + 2.8, "steel", 2),
        rect(gx - 1.15, n + 0.55, gx + 1.15, n + 0.7, deck + 1.0, deck + 1.15, "steel", 2),
        rect(gx - 0.18, n + 0.7, gx + 0.18, n + 0.9, deck + 0.75, deck + 1.2, "steel", 0),
      ],
      // Its flight, and a landing over the deck's rail that steps down onto the deck.
      open: [...gangway, rect(gx, gz - 1.0, gx + 2.4, n + 0.55, deck + 0.4, deck + 0.7, "steel", 2)],
    },
  ];
})();

export const routeOf = (id: RouteId): Route => ROUTES.find((r) => r.id === id) ?? ROUTES[0];
