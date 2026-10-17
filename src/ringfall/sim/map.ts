import { VAULT, WORLD, type EnemyKind, type HealKind, type Rarity, type ToolKind, type ValuableKind, type WeaponKind } from "./config";
import { AREA, inArea, POI_AT, type AreaId } from "./areas";
import { buildTerrain, type Carve, type FlatShape, floorLevel, highGround, LEVEL, offshore, roadLine, steepAt, surfaceAt, terrainHeight } from "./terrain";

/**
 * The world: two regions, a dried-up reservoir in the south and a dry harbor in the
 * north, joined by a pass road and a railway (see terrain.ts for their levels).
 * Everything solid is an axis-aligned box, so collision, line of sight and standing on
 * top are all the same cheap test. North is -z. The player chooses the region to start
 * in; every POI, district and way off in both regions is open from the start.
 *
 * Boxes and points are written relative to the ground of their area and lifted to
 * its level here, so a building reads the same on the lakebed as on the mesa.
 */

/**
 * `steel` is painted plate: ship hulls, cranes, girders, carriages (its tint picks the paint).
 * `fence` is a gate of steel bars, solid as any box.
 */
export type BoxKind = "crate" | "container" | "wall" | "rock" | "pad" | "tower" | "slab" | "step" | "steel" | "fence";

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
 * The four walls of one storey between heights y0 and y1, with 2.2 m doors (2.5 m
 * tall) and pairs of windows (sill 1.1 m, head 2.1 m) cut into the named sides.
 */
function walls(cx: number, cz: number, w: number, d: number, y0: number, y1: number, doors: Side[] = [], windows: Side[] = []): Box[] {
  const out: Box[] = [];
  for (const side of SIDES) {
    const alongX = side === "n" || side === "s";
    const len = alongX ? w : d;
    const holes: { a: number; b: number; door: boolean }[] = [];
    if (doors.includes(side)) holes.push({ a: -1.1, b: 1.1, door: true });
    if (windows.includes(side)) {
      const off = doors.includes(side) ? len * 0.32 : len * 0.25;
      for (const sg of [-1, 1]) holes.push({ a: sg * off - 0.7, b: sg * off + 0.7, door: false });
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
      if (hole.door) piece(hole.a, hole.b, y0 + 2.5, y1);
      else {
        piece(hole.a, hole.b, y0, y0 + 1.1);
        piece(hole.a, hole.b, y0 + 2.1, y1);
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
}

/**
 * A one-room building of height H: walls with door and window openings, a flat roof
 * slab, a low parapet around the roof, and optional outside stairs up to it.
 */
function building(cx: number, cz: number, w: number, d: number, H: number, o: BuildingOpts = {}): Box[] {
  const out = walls(cx, cz, w, d, 0, H - 0.3, o.doors, o.windows);
  out.push(box(cx, cz, w, d, H, "slab", 0, H - 0.3));
  out.push(...parapet(cx, cz, w, d, H, [...(o.roof ? [o.roof] : []), ...(o.open ?? [])]));
  if (o.roof) {
    const r = o.roof;
    if (r === "n" || r === "s") out.push(...stairs(cx + w / 2 - 1.0, r === "n" ? cz - d / 2 : cz + d / 2, r, 1.4, H));
    else out.push(...stairs(r === "e" ? cx + w / 2 : cx - w / 2, cz + d / 2 - 1.0, r, 1.4, H));
  }
  return out;
}

interface TowerOpts {
  /** Doors per storey, from the ground floor up. */
  doors?: Side[][];
  windows?: Side[][];
  /** Roof parapet sides left open, where a bridge lands. */
  open?: Side[];
  /** A second stair core at the west end, its flights climbing east: a long building climbed from either end. */
  twin?: true;
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
    out.push(...walls(cx, cz, w, d, base, top - 0.3, o.doors?.[k], o.windows?.[k]));
    const [za, zb] = k % 2 === 0 ? [z0 + WALL, z0 + WALL + 1.4] : [z1 - WALL - 1.4, z1 - WALL];
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
function highRise(cx: number, cz: number, w: number, d: number, floors: number): Box[] {
  const windows: Side[][] = [["w"]];
  for (let k = 1; k < floors; k++) windows.push(["n", "s", "e", "w"]);
  return tower(cx, cz, w, d, floors, { doors: [["s", "e"]], windows });
}

/** The harbor's lighthouse on its headland, in the bay's frame: the highest view over the harbor. */
const LIGHTHOUSE = { x: -116, z: -553, floors: 7 } as const;

/** The landing pad's control tower, in the pad's frame (52 m north of the heart's). */
const PAD_TOWER = { x: -34, z: -76, floors: 5 } as const;

/** Tall buildings: where they stand in their area's frame, their size and storeys. Their top-floor bins are in EXTRA_BINS. */
const HIGH_RISES = (
  [
    { x: 0, z: -14, w: 10, d: 10, floors: 6, level: LEVEL.lakebed, area: "heart" }, // the drowned town's office block
    { x: 125, z: 0, w: 10, d: 10, floors: 5, level: LEVEL.mesa, area: "relay" }, // flats beyond the housing street
    { x: PAD_TOWER.x, z: PAD_TOWER.z - 52, w: 10, d: 10, floors: 5, level: LEVEL.dam, area: "heart" }, // the pad's control tower (pad() puts its cab on top)
    { x: -182, z: 10, w: 8, d: 8, floors: 4, level: LEVEL.pit, area: "quarry" }, // a lookout at the quarry's far end
    { x: -129, z: 28, w: 8, d: 8, floors: 4, level: LEVEL.pit, area: "quarry" }, // the quarry office
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
function shell(cx: number, cz: number, w: number, d: number, y0: number, y1: number, holes: Hole[], kind: BoxKind = "wall", tint = 0): Box[] {
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

/** Height of a roller door's opening: tall enough for a truck, and for anything tall to see in. */
const ROLLER = 4.4;

interface HallOpts {
  /** Roller doors, `w` wide (default 5 m), at `at` metres along their side from its middle. */
  doors?: { side: Side; at?: number; w?: number }[];
  /** Plain 2.2 m doors. */
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
}

/**
 * A large single-volume shed (a warehouse, a hangar, a works hall) of height H: thin walls with
 * wide roller doors, a flat roof, mezzanines inside along its walls with stairs up to them, and
 * columns holding the roof. The roof is reached from outside (a stair tower set against it).
 */
function hall(cx: number, cz: number, w: number, d: number, H: number, o: HallOpts = {}): Box[] {
  const holes: Hole[] = [
    ...(o.doors ?? []).map((q) => ({ side: q.side, at: q.at, w: q.w ?? 5, head: ROLLER })),
    ...(o.hatches ?? []).map((q) => ({ side: q.side, at: q.at, w: 2.2, head: 2.5 })),
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
  const out = shell(cx, cz, w, d, 0, H - 0.3, holes, kind, o.steel ?? 0);
  out.push(box(cx, cz, w, d, H, "slab", 0, H - 0.3));
  out.push(...parapet(cx, cz, w, d, H, [...(o.open ?? []), ...(o.roof ? [o.roof] : [])]));
  if (o.roof) {
    const r = o.roof;
    if (r === "n" || r === "s") out.push(...stairs(cx + w / 2 - 1.0, r === "n" ? cz - d / 2 : cz + d / 2, r, 1.4, H));
    else out.push(...stairs(r === "e" ? cx + w / 2 : cx - w / 2, cz + d / 2 - 1.0, r, 1.4, H));
  }
  const x0 = cx - w / 2 + WALL;
  const x1 = cx + w / 2 - WALL;
  const z0 = cz - d / 2 + WALL;
  const z1 = cz + d / 2 - WALL;
  for (const m of o.mezz ?? []) {
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
    const sw = 1.4;
    const railTo = (p: number, q: number) =>
      alongX ? rect(p, edge - (inner > 0 ? 0.15 : 0), q, edge + (inner > 0 ? 0 : 0.15), m.y, m.y + 1.0, "steel", 2) : rect(edge - (inner > 0 ? 0.15 : 0), p, edge + (inner > 0 ? 0 : 0.15), q, m.y, m.y + 1.0, "steel", 2);
    const sc = (alongX ? cx : cz) + s;
    out.push(railTo(a0, sc - sw / 2), railTo(sc + sw / 2, a1));
    const away: Side = m.side === "n" ? "s" : m.side === "s" ? "n" : m.side === "w" ? "e" : "w";
    out.push(...(alongX ? stairs(sc, edge, away, sw, m.y) : stairs(edge, sc, away, sw, m.y)));
  }
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
export type PoiId = "supply" | "quarry" | "relay" | "pad" | "wreck" | "yard" | "smelter";

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
const SHIP_DECK = STOREY * 3;
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
 * Each POI is written in its own frame (its data and its boxes below) and moved
 * into place by this offset (`POI_AT` in areas.ts, which sets each in its area's frame).
 * The harbor's POIs are written round their own middle.
 */
const AT = (["supply", "quarry", "relay", "pad", "wreck", "yard", "smelter"] as const).map((id) => POI_AT[id]);

const POI_FRAMES: Poi[] = [
  {
    id: "supply",
    name: "補給所",
    x: 10,
    z: 50,
    trigger: 36,
    entry: { x: 4, z: 92, yaw: 0 },
    squads: [
      // Two squads, one each side of the depot's yard: a fight with one leaves the other a flank to come round.
      { name: "倉庫", members: [{ kind: "grunt", plate: VAULT.guardPlate, x: 22, z: 45, face: W }, { kind: "grunt", x: 28, z: 66.8, y: STOREY * 2, face: S }] },
      { name: "管理棟", members: [{ kind: "grunt", x: -20, z: 47, face: E }, { kind: "charger", x: -8, z: 58, face: E }] },
    ],
    bins: [
      { x: -2, z: 54 },
      { x: 8, z: 66 },
      { x: -11, z: 38 },
      { x: -22, z: 49 },
      { x: 20, z: 36.4, y: STOREY, vault: true },
    ],
    keyFrom: "pad",
    loot: { weapon: [["hornet", 1], ["maul", 0], ["lance", 0], ["pike", 1]], armor: [1], heals: 1, valuable: [["fuse", 3], ["parts", 4], ["wire", 2], ["drive", 1]] },
    floor: [
      { x: 3, z: 76, weapon: ["hornet", 0] },
      { x: -4, z: 76, heal: "syringe" },
      { x: -21, z: 48, y: STOREY, armor: 1 },
      { x: 28, z: 44.5, y: STOREY * 2, heal: "battery" },
    ],
  },
  {
    id: "quarry",
    name: "採掘場",
    x: -46,
    z: 2,
    trigger: 26,
    entry: { x: -18, z: 30, yaw: -0.8 },
    squads: [
      { name: "西の段丘", members: [{ kind: "grunt", plate: VAULT.guardPlate, x: -72, z: 3, y: 3, face: E }, { kind: "grunt", x: -63, z: -8, y: 2.4, face: E }] },
      { name: "採掘穴", members: [{ kind: "charger", x: -46, z: 4, face: SE }, { kind: "grunt", x: -52, z: -15, y: 4, face: SE }] },
    ],
    bins: [
      { x: -37, z: 8 },
      { x: -54, z: -4 },
      { x: -46, z: 14 },
      { x: -73, z: -4, y: 5.5, vault: true },
    ],
    keyFrom: "supply",
    loot: { weapon: [["pike", 2], ["maul", 1], ["lance", 1], ["hornet", 2], ["talon", 1]], armor: [2], heals: 2, valuable: [["parts", 3], ["wire", 4], ["fuse", 1], ["gyro", 1]] },
    floor: [{ x: -45, z: -15, y: 4, heal: "medkit" }],
    carePackage: { x: -46, z: 0, weapon: ["lance", 3] },
  },
  {
    id: "relay",
    name: "中継塔",
    x: 40,
    z: -24,
    trigger: 36,
    entry: { x: 4, z: -23, yaw: 1.4 },
    squads: [
      { name: "中継塔", members: [{ kind: "grunt", x: 40, z: -29.8, y: STOREY * 2, face: SW }, { kind: "heavy", x: 36, z: -36, face: SW }] },
      { name: "4 階建て", members: [{ kind: "grunt", plate: VAULT.guardPlate, x: 49, z: -10, face: W }, { kind: "grunt", x: 57, z: -20, face: W }, { kind: "charger", x: 34, z: -26, face: SW }] },
    ],
    bins: [
      { x: 31, z: -22 },
      { x: 50, z: -36 },
      { x: 44, z: -16 },
      { x: 48, z: -10, y: STOREY * 2, vault: true },
    ],
    keyFrom: "quarry",
    loot: { weapon: [["pike", 3], ["hornet", 2], ["maul", 2], ["lance", 2], ["talon", 2]], armor: [2, 3], heals: 2, valuable: [["board", 4], ["drive", 2], ["wire", 1], ["gyro", 1]] },
    floor: [
      { x: 39.8, z: -30, y: STOREY, weapon: ["lance", 2] },
      { x: 50, z: -12, y: STOREY * 3, armor: 2 },
    ],
  },
  {
    id: "pad",
    name: "発着場",
    x: 0,
    z: -72,
    trigger: 40,
    entry: { x: 0, z: -36, yaw: 0 },
    squads: [{ name: "タイタン", members: [{ kind: "titan", x: 0, z: -76, face: S }, { kind: "drone", x: -8, z: -70 }, { kind: "drone", x: 8, z: -70 }] }],
    bins: [
      { x: -16, z: -56 },
      { x: 16, z: -56 },
      { x: -27, z: -106.5, y: STOREY },
      { x: 27, z: -106.5, y: STOREY, vault: true },
    ],
    keyFrom: "relay",
    loot: { weapon: [], armor: [3], heals: 2, valuable: [["board", 3], ["drive", 2], ["core", 1]] },
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
      // Up high, robots stand at the parapet: seen from the ground below, and seeing it.
      { name: "甲板", members: [{ kind: "grunt", plate: VAULT.guardPlate, x: 34, z: 7.1, y: SHIP_DECK, face: S }, { kind: "heavy", x: 6, z: 6.75, y: SHIP_DECK, face: S }] },
      {
        name: "浜",
        members: [{ kind: "grunt", x: -12, z: 16, face: S }, { kind: "grunt", x: -9.5, z: 17, face: S }, { kind: "drone", x: -78, z: 18 }],
        patrol: [{ x: -78, z: 18 }, { x: 70, z: 18 }, { x: 70, z: -16 }, { x: -78, z: -16 }],
      },
    ],
    bins: [
      { x: -32, z: 3 },
      { x: 26, z: -3 },
      { x: -10, z: 4, y: STOREY },
      { x: -36, z: -3, y: SHIP_DECK },
      { x: 40.5, z: 2, y: SHIP_DECK + STOREY * 2, vault: true },
    ],
    keyFrom: "smelter",
    loot: { weapon: [["talon", 2], ["lance", 2], ["maul", 2], ["pike", 2]], armor: [2, 3], heals: 2, valuable: [["board", 3], ["drive", 3], ["gyro", 2], ["core", 1]] },
    floor: [
      { x: -4, z: 4, y: STOREY, heal: "medkit" },
      { x: 12, z: -5, y: SHIP_DECK, weapon: ["lance", 2] },
    ],
  },
  {
    id: "yard",
    name: "コンテナヤード",
    x: 0,
    z: 0,
    trigger: 46,
    entry: { x: 0, z: 46, yaw: 0 },
    squads: [
      { name: "クレーン", members: [{ kind: "grunt", plate: VAULT.guardPlate, x: 24.35, z: -2, y: CRANE, face: E }, { kind: "heavy", x: 2, z: -13.5, face: E }] },
      { name: "通路", members: [{ kind: "grunt", x: -20, z: 13.5, face: W }, { kind: "grunt", x: -23, z: 22.5, face: W }] },
    ],
    bins: [
      { x: -30, z: -13.5 },
      { x: 10, z: 13.5 },
      { x: -70, z: 2 },
      { x: -6.6, z: -9, y: 2.6 },
      { x: 25.4, z: 6.5, y: CRANE, vault: true },
    ],
    keyFrom: "wreck",
    loot: { weapon: [["hornet", 2], ["maul", 2], ["pike", 2], ["lance", 1]], armor: [2], heals: 2, valuable: [["wire", 3], ["board", 3], ["drive", 2], ["gyro", 1]] },
    floor: [
      { x: 12, z: -13.5, heal: "battery" },
      { x: -70, z: 3, y: 3.4, armor: 2 },
    ],
  },
  {
    id: "smelter",
    name: "製錬所",
    x: 4,
    z: 0,
    trigger: 46,
    entry: { x: 8, z: 40, yaw: 0 },
    squads: [
      { name: "制御棟", members: [{ kind: "grunt", plate: VAULT.guardPlate, x: 41, z: -1.8, y: STOREY * 4, face: S }, { kind: "grunt", x: 16, z: -2, face: S }] },
      { name: "炉", members: [{ kind: "heavy", x: -18, z: -1, face: S }, { kind: "charger", x: -26, z: 12, face: E }] },
    ],
    bins: [
      { x: -24, z: -3 },
      { x: 21, z: -3 },
      { x: -24, z: -12.5, y: STOREY * 2 },
      { x: -38, z: 20 },
      { x: 41, z: -4, y: STOREY * 2, vault: true },
    ],
    keyFrom: "yard",
    loot: { weapon: [["pike", 3], ["lance", 2], ["maul", 2], ["talon", 1], ["hornet", 3]], armor: [2, 3], heals: 2, valuable: [["wire", 2], ["gyro", 3], ["drive", 2], ["board", 2], ["reactor", 1]] },
    floor: [{ x: 41, z: -6, y: STOREY * 3, weapon: ["talon", 2] }],
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
const DEPOT_OUT: Record<PoiId, number> = { supply: 18, quarry: 6, relay: 85, pad: 24, wreck: 22, yard: 18, smelter: 25 };

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
  { id: "ship", name: "発着場のドロップシップ", short: "ドロップシップ", x: AT[3][0], z: -84 + AT[3][1], radius: 5, hold: 1.5, call: 20, waves: { x: POIS[poiIndex("pad")].x, z: POIS[poiIndex("pad")].z }, note: "呼んで 20 秒守る。増援が降りてくる" },
  { id: "flare", name: "台地の回収地点", short: "台地", ...at("heart", { x: -58, z: -53 }), radius: 5, hold: 4, needsFlare: true, note: "発煙筒を焚けば 4 秒" },
  { id: "village", name: "廃村の回収地点", short: "廃村", ...at("village", { x: -91, z: -63 }), radius: 5, hold: 15, note: "遠いが静か。15 秒待つ" },
  // The harbor's way off: a boat comes up the channel to the quay.
  { id: "boat", name: "埠頭のボート", short: "ボート", ...at("bay", { x: 105, z: -580 }), radius: 5, hold: 1.5, call: 25, waves: at("bay", { x: 100, z: -563 }), note: "呼んで 25 秒守る。増援が降りてくる" },
];
export const EXTRACT = EXTRACTS[0];

/**
 * Squads between the POIs. Beating them is optional. Most of the ground between the POIs is
 * quiet: one squad holds the drowned town, and a few walk the roads and the open ground
 * between the areas, met on the way rather than found at a post.
 */
export const ROAMERS: Squad[] = (
  [
    // The drowned town, in the heart's frame. The lookout stays on the clock tower: a patrol is
    // led by its first member, and one posted up high cannot leave its floor.
    ["heart", { name: "時計塔", members: [{ kind: "grunt", x: 0, z: 13, y: STOREY * 3, face: S }] }],
    [
      "heart",
      {
        name: "旧市街の見回り",
        members: [{ kind: "grunt", x: -7, z: 20, face: E }],
        patrol: [{ x: 7, z: 20 }, { x: 7, z: 2 }, { x: -7, z: 2 }, { x: -7, z: 20 }],
      },
    ],
    // Along the roads between the areas, in the world's coordinates.
    [
      null,
      {
        name: "尾根道の巡回",
        roam: true,
        members: [{ kind: "grunt", x: -65, z: 183 }, { kind: "drone", x: -63, z: 185 }],
        patrol: [{ x: -65, z: 183 }, { x: -87, z: 169 }, { x: -123, z: 168 }, { x: -87, z: 169 }, { x: -65, z: 183 }, { x: -50, z: 202.5 }],
      },
    ],
    [
      null,
      {
        name: "東の坂の巡回",
        roam: true,
        members: [{ kind: "grunt", x: 67.5, z: 37 }, { kind: "charger", x: 65.9, z: 38.4 }],
        patrol: [{ x: 67.5, z: 37 }, { x: 103, z: 28 }, { x: 67.5, z: 37 }, { x: 22, z: 37 }],
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
).map(([a, sq]) => (a ? placeSquad(sq, AREA[a][0], AREA[a][1]) : placeSquad(sq, 0, 0)));

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
  { id: "beach", region: "reservoir", name: "南の浜", x: 10, z: 405, yaw: 0 },
  { id: "checkpoint", region: "reservoir", name: "東の検問道", x: 325, z: -40, yaw: -Math.PI / 2 },
  { id: "jetty", region: "reservoir", name: "西の釣り桟橋", x: -345, z: 130, yaw: Math.PI / 2 },
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
  pois: PoiId[];
  exits: ExtractId[];
  /** Where the world map writes the region's name, large and faint under everything. */
  label: { x: number; z: number };
  /** The part of the world the map frames when it shows this region: its land, its ways in and the ends of the ways out of it. */
  bounds: { x0: number; z0: number; x1: number; z1: number };
}

export const REGIONS: Region[] = [
  { id: "reservoir", name: "ダム湖", note: "干上がったダム湖の島。拠点 4 つ、発着場にタイタン", entries: ["beach", "checkpoint", "jetty"], pois: ["supply", "quarry", "relay", "pad"], exits: ["ship", "flare", "village"], label: { x: -225, z: 250 }, bounds: { x0: WORLD.x0, z0: -340, x1: WORLD.x1, z1: WORLD.z1 } },
  { id: "harbor", name: "港湾地帯", note: "干上がった湾の港。拠点 3 つ、どこにもヘビーがいる", entries: ["outskirts", "quay", "shore"], pois: ["wreck", "yard", "smelter"], exits: ["boat"], label: { x: -250, z: -520 }, bounds: { x0: WORLD.x0, z0: WORLD.z0, x1: WORLD.x1, z1: -380 } },
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
 * and fight round, and a bin or two. No robots post there; the roads' patrols and the
 * reinforcements pass by.
 */
interface Hamlet {
  name: string;
  x: number;
  z: number;
  /** Its boxes, written round (0, 0) on ground at 0. */
  boxes: Box[];
  /** Its bins in the same frame, with the POI whose loot table each uses. */
  bins: { x: number; z: number; y?: number; table: PoiId }[];
}

const HAMLET_FRAMES: Hamlet[] = [
  // --- the reservoir
  {
    name: "西の農場",
    x: -255,
    z: 208,
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
    x: -277,
    z: 2,
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
    x: -105,
    z: 340,
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
    x: 142,
    z: 295,
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
    x: 255,
    z: -57,
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
];

/**
 * The frames areas are written in, by name: each POI's (`AT`, by its id) and each hamlet's. Data
 * outside the map that points into one of them (the shots gate's cameras) is written in its frame,
 * so moving an area moves it too.
 */
export const FRAMES: Record<string, { x: number; z: number }> = Object.fromEntries([
  ...POI_FRAMES.map((p, i): [string, { x: number; z: number }] => [p.id, { x: AT[i][0], z: AT[i][1] }]),
  ...HAMLET_FRAMES.map((h): [string, { x: number; z: number }] => [h.name, { x: h.x, z: h.z }]),
  // The areas' frames (areas.ts), as "area:" and the area's id.
  ...Object.entries(AREA).map(([id, [x, z]]): [string, { x: number; z: number }] => [`area:${id}`, { x, z }]),
]);

/** Names on the world map for the districts and landmarks between the POIs, where each is written. */
export const LANDMARKS: readonly { name: string; x: number; z: number }[] = [
  at("heart", { name: "湖底の旧市街", x: 0, z: -22 }),
  at("heart", { name: "堤", x: 0, z: -79 }),
  at("heart", { name: "放水路", x: 50, z: -72 }),
  at("ridge", { name: "尾根", x: -50, z: 62 }),
  at("factory", { name: "工場", x: 57, z: 60 }),
  at("relay", { name: "住宅地", x: 112, z: 24 }),
  at("pass", { name: "峠", x: -60, z: -236 }),
  at("railway", { name: "鉄橋", x: 140, z: -190 }),
  at("railway", { name: "駅", x: 108, z: -228 }),
  at("town", { name: "港町", x: 20, z: -312 }),
  { name: "高架", x: 30, z: -627 },
  at("bay", { name: "塩田", x: -10, z: -480 }),
  at("bay", { name: "灯台", x: -116, z: -538 }),
  at("bay", { name: "水路", x: 140, z: -604 }),
];

/**
 * Open ground off the POIs where a raid may stop, one or more per district and on the ways
 * between: the sim gate checks that each is reached on foot and that reinforcements find a
 * hidden spot a walk away from each.
 */
export const STOPS: readonly { name: string; x: number; z: number }[] = [
  at("factory", { name: "工場", x: 50, z: 50 }),
  at("heart", { name: "台地", x: -60, z: -40 }),
  at("village", { name: "廃村", x: -100, z: -62 }),
  at("heart", { name: "放水路", x: 50, z: -80 }),
  at("relay", { name: "住宅地", x: 112, z: 20 }),
  at("quarry", { name: "採掘場の奥", x: -150, z: 12 }),
  at("ridge", { name: "尾根", x: -50, z: 76 }),
  at("pass", { name: "峠", x: -60, z: -222 }),
  at("railway", { name: "駅", x: 122, z: -230 }),
  at("town", { name: "港町", x: 20, z: -306 }),
  { name: "高架下", x: 55, z: -609 },
  at("bay", { name: "塩田", x: 10, z: -500 }),
  at("bay", { name: "岬", x: -122, z: -545 }),
];

/** The hamlets placed, each flat at the level of the ground under its middle. */
const HAMLETS = HAMLET_FRAMES.map((h) => {
  const level = floorLevel(h.x, h.z);
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
    at("supply", { x: -12, z: 172, table: "supply" }),
    at("ridge", { x: -45, z: 70, y: 3.5, table: "supply" }),
    at("heart", { x: -2, z: 10, y: STOREY * 2, table: "quarry" }),
    at("heart", { x: 14, z: 11, y: STOREY * 2, table: "quarry" }),
    at("heart", { x: -2, z: 30, table: "quarry" }),
    at("factory", { x: 64, z: 49, table: "relay" }),
    at("factory", { x: 48, z: 39.3, y: 3.3, table: "relay" }),
    at("heart", { x: -56, z: -52, y: 7.2, table: "relay" }),
    at("relay", { x: 113, z: 14, y: STOREY, table: "relay" }),
    at("village", { x: -114, z: -71, y: STOREY, table: "quarry" }),
    // Top floor of each tall building, on the side away from its stairs. These hold the
    // flares that call the plateau pickup (EXTRACTS).
    ...HIGH_RISES.map((h) => ({ x: h.x - h.w / 2 + 1.5, z: h.z, y: (h.floors - 1) * STOREY, table: "relay" as const, flare: true as const })),
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
  .concat(HAMLETS.flatMap((h) => h.bins));


/** Where the quarry's plant stands in the quarry's frame, and its conveyor's walkway over the pit's west wall. */
const PLANT = { x: -64, z: -18, floors: 4, belt: STOREY * 2, rim: -95 } as const;

/**
 * The quarry, in its own frame: the processing plant at the pit's north-west corner, four
 * storeys with stairs inside and a stack over its roof, its conveyor run out at its third floor
 * over the pit's west wall to the rim (the walkway itself is `CONVEYOR`, laid after the ground);
 * rock shelves and terraces, a catwalk between two scaffold towers, a shed.
 */
function quarry(): Box[] {
  return [
    ...tower(PLANT.x, PLANT.z, 14, 8, PLANT.floors, { doors: [["s", "e"], [], ["w"], []], windows: [["w"], ["s", "e"], ["s", "e"], ["n", "e", "s", "w"]] }),
    box(PLANT.x - 4, PLANT.z, 2, 2, PLANT.floors * STOREY + 9, "steel", 0, PLANT.floors * STOREY),
    // The hopper over the plant's east end, on its legs.
    ...tank(PLANT.x + 11, PLANT.z - 1, 3, 9, "e", 0, 4),
    ...[-1, 1].flatMap((sx) => [-1, 1].map((sz) => box(PLANT.x + 11 + sx * 2, PLANT.z - 1 + sz * 2, 0.4, 0.4, 4, "steel", 2))),
    box(-58, 6, 6, 9, 4.5, "rock"),
    box(-36, -6, 7, 5, 3.6, "rock"),
    box(-41, 11, 2.5, 6.2, 2.6, "container", 0),
    box(-49, 9, 1.2, 1.2, 0.9, "crate"),
    box(-50.2, 9, 1.2, 1.2, 1.8, "crate"),
    box(-44, -2, 1.2, 1.2, 0.9, "crate"),
    box(-55, 18, 10, 0.8, 1.2, "wall"),
    box(-33, 6, 1.2, 1.2, 0.9, "crate"),
    box(-63, -8, 8, 8, 2.4, "rock"),
    ...stairs(-59, -8, "e", 2.4, 2.4, 1),
    box(-52, -15, 3, 3, 4.0, "tower"),
    box(-38, -15, 3, 3, 4.0, "tower"),
    box(-45, -15, 11, 1.2, 4.0, "slab", 0, 3.7),
    ...stairs(-52, -13.5, "s", 1.6, 4.0),
    ...stairs(-38, -16.5, "n", 1.6, 4.0),
    ...building(-62, 24, 6, 6, 3.4, { doors: ["e", "s"], windows: ["n"] }),
    // the west terraces: two shelves above the pit
    box(-72, 0, 8, 14, 3, "rock"),
    box(-73, -4, 4, 6, 5.5, "rock", 1),
    ...stairs(-68, 3, "e", 2, 3, 1),
    ...stairs(-71, -3, "e", 1.6, 5.5, 1, 3),
  ];
}

/**
 * The relay station, in its own frame: a walled compound on the mesa round a steel lattice
 * mast with four railed platforms (its dish hut at the top, seen across the reservoir), the
 * four-storey equipment block, a generator shed and a fuel tank.
 */
function relay(): Box[] {
  const out: Box[] = [];
  out.push(...lattice(42, -30, 6, 6, 4, 32), box(42, -30, 2, 2, 33.4, "tower", 1, 32));
  out.push(...tower(52, -12, 10, 10, 4, { doors: [["w", "s"]], windows: [["e"], ["n", "e", "w"], ["s", "e", "w"], ["n", "e", "s", "w"]] }));
  out.push(...hall(24, -35, 14, 10, 5.1, { doors: [{ side: "e" }], hatches: [{ side: "s", at: 3 }], steel: 3 }));
  out.push(...tank(60, -36, 3.5, 7, "w"));
  out.push(
    ...compound(38, -22, 52, 40, 2.4, [
      { side: "w", at: -1, w: 8 },
      { side: "s", at: -4, w: 8 },
      { side: "e", at: 2, w: 6 },
      { side: "n", at: 12, w: 6 },
    ]),
  );
  out.push(...building(28, -12, 7, 6, 3.4, { doors: ["e"], windows: ["s"], roof: "w" }));
  out.push(
    box(36, -20, 2.5, 6.2, 2.6, "container", 1),
    box(60, -26, 2.5, 6.2, 2.6, "container", 2),
    box(46, -40, 6.2, 2.5, 2.6, "container", 0),
    box(36, -16, 1.2, 1.2, 0.9, "crate"),
    box(47.5, -26, 1.2, 1.2, 1.8, "crate"),
    box(48.7, -26, 1.2, 1.2, 0.9, "crate"),
    box(55, -31, 4, 0.6, 2.4, "wall"),
  );
  // Outside the south side, a hut by the road.
  out.push(...building(56, 8, 5, 6, 3.4, { doors: ["w"], roof: "n" }));
  return out;
}

/**
 * The landing pad, in its own frame: the open pad ringed by pillars and two raised gantries
 * for the titan's arena, two hangars behind it to the north with mezzanines and stairs up their
 * sides to their roofs, and the glazed cab on the control tower (`HIGH_RISES`) west of it.
 */
function pad(): Box[] {
  const out: Box[] = [
    box(0, -82, 12, 10, 0.25, "pad"),
    box(-12, -60, 2, 2, 3.8, "wall"),
    box(12, -60, 2, 2, 3.8, "wall"),
    box(-17, -74, 2, 2, 3.8, "wall"),
    box(17, -74, 2, 2, 3.8, "wall"),
    box(-6, -54, 1.2, 1.2, 0.9, "crate"),
    box(6, -54, 1.2, 1.2, 0.9, "crate"),
    box(-21, -64, 1.2, 1.2, 0.9, "crate"),
    box(21, -64, 1.2, 1.2, 0.9, "crate"),
    box(22, -71, 4, 8, 2.4, "tower"),
    ...stairs(20, -71, "w", 2, 2.4),
    box(-22, -71, 4, 8, 2.4, "tower"),
    ...stairs(-20, -71, "e", 2, 2.4),
  ];
  for (const sx of [-1, 1] as const)
    out.push(
      ...hall(sx * 26, -100, 22, 18, 8.5, {
        doors: [{ side: "s", w: 10 }],
        hatches: [{ side: sx < 0 ? "e" : "w", at: -4 }],
        windows: ["n"],
        mezz: [{ side: "n", depth: 4, y: STOREY, stair: sx * 6 }],
        columns: 7,
        roof: sx < 0 ? "w" : "e",
        steel: 2,
      }),
      box(sx * 26, -88, 6.2, 2.5, 2.6, "container", sx < 0 ? 0 : 1),
    );
  // The control tower's cab: glass all round on its roof, an aerial over it.
  const top = PAD_TOWER.floors * STOREY;
  const holes: Hole[] = SIDES.flatMap((side) => [-2.5, 2.5].map((at) => ({ side, at, w: 3.2, sill: 0.9, head: 2.4 })));
  out.push(...shell(PAD_TOWER.x, PAD_TOWER.z, 10, 10, top, top + 2.7, holes));
  out.push(box(PAD_TOWER.x, PAD_TOWER.z, 10.6, 10.6, top + 3.0, "slab", 1, top + 2.7));
  out.push(box(PAD_TOWER.x + 3, PAD_TOWER.z - 3, 0.3, 0.3, top + 9, "steel", 2, top + 3.0));
  return out;
}

/**
 * The supply depot, in its own frame: a walled yard round a warehouse three storeys high,
 * one hall inside with mezzanines along two walls, its office block beside it (stairs inside up
 * to both roofs, which join), a loading dock along its south side with trailers at it, a steel
 * watchtower in the yard's corner, the admin block outside the west gate, and two feed silos
 * north of it all that stand over the shore.
 */
function supply(): Box[] {
  const H = STOREY * 3;
  const out: Box[] = [];
  out.push(
    ...hall(16, 44, 28, 20, H, {
      doors: [{ side: "w", at: -2 }, { side: "s", at: -4, w: 6 }],
      hatches: [{ side: "n", at: 8 }],
      windows: ["n", "s"],
      mezz: [
        { side: "n", depth: 5, y: STOREY, stair: -6 },
        { side: "e", depth: 4, y: STOREY * 2, stair: 5, from: -2 },
      ],
      columns: 7,
      open: ["e"],
    }),
  );
  out.push(...tower(34, 44, 8, 10, 3, { doors: [["s", "e"]], windows: [["e"], ["n", "e", "s"], ["n", "e", "s"]], open: ["w"] }));
  // The loading dock and two trailers backed up to it.
  out.push(box(14, 56, 22, 4, 1.2, "tower"), ...stairs(3, 56, "w", 3, 1.2), ...stairs(25, 56, "e", 3, 1.2));
  out.push(box(8, 61.5, 2.5, 6.2, 2.6, "container", 1), box(18, 61.5, 2.5, 6.2, 2.6, "container", 0));
  // The yard's wall, with a gate on every side.
  out.push(
    ...compound(16, 50, 52, 44, 2.4, [
      { side: "w", at: -4, w: 8 },
      { side: "s", at: -12, w: 10 },
      { side: "e", at: 8, w: 6 },
      { side: "n", at: 10, w: 6 },
    ]),
  );
  out.push(...lattice(28, 68, 5, 5, 2, 12));
  // In the yard: crates and a stack of containers, and a rock left from clearing it.
  out.push(box(-2, 46, 6.2, 2.5, 2.6, "container", 0), box(-2, 46, 6.2, 2.5, 5.2, "container", 2, 2.6), box(2, 52, 1.2, 1.2, 0.9, "crate"), box(-6, 62, 1.2, 1.2, 0.9, "crate"), box(-4.8, 62, 1.2, 1.2, 1.8, "crate"));
  out.push(box(36, 62, 4, 1.2, 1.1, "rock"));
  // Outside the west gate, the admin block; to the north, the silos; to the south, a hut.
  out.push(...tower(-18, 46, 12, 10, 2, { doors: [["e", "s"]], windows: [["n", "w"], ["n", "e", "w"]] }));
  out.push(...tank(-6, 20, 4.5, 20, "s"), ...tank(5, 20, 4.5, 20, "s"));
  out.push(box(-0.5, 20, 2, 2, 22, "steel", 0, 17));
  out.push(...building(-12, 82, 6, 5, 3.4, { doors: ["n"], windows: ["e"], roof: "e" }), ...building(-20, 75, 6, 6, 3.4, { doors: ["e"], windows: ["s"] }));
  out.push(box(14, 86, 4, 3, 1.4, "rock"));
  return out;
}

/**
 * The beached cargo ship, in its own frame: a three-storey hull 112 m long lying east to west on
 * the old bay floor, holed on both sides of its hold, with stairs inside at both ends up to the
 * main deck, bulkheads cutting each deck into holds, a three-storey bridge house on the deck
 * with its own stairs, a funnel and three masts. The pointed bow is solid.
 */
function wreck(): Box[] {
  const hull = paint(
    tower(0, 0, 112, 16, 3, { doors: [["s", "n"], [], []], windows: [["e", "w"], ["n", "s"], ["n", "s"]], twin: true }),
    "wall",
    "steel",
    (b) => (b.y0 < STOREY ? 1 : 0),
  );
  const out: Box[] = [...hull];
  // Bulkheads across the holds and the decks above, each with a door in the middle.
  for (const x of [-35, -14, 14, 35])
    for (let k = 0; k < 3; k++) {
      const y0 = k * STOREY;
      out.push(box(x, -4.5, 0.35, 6.3, y0 + STOREY - 0.3, "steel", 2, y0), box(x, 4.5, 0.35, 6.3, y0 + STOREY - 0.3, "steel", 2, y0));
      out.push(box(x, 0, 0.35, 2.7, y0 + STOREY - 0.3, "steel", 2, y0 + 2.5));
    }
  // The bow, narrowing in steps to a point, and a blunt stern.
  out.push(box(-58.5, 0, 5, 13, SHIP_DECK + 0.7, "steel", 1), box(-63, 0, 4, 9, SHIP_DECK + 1, "steel", 1), box(-66.5, 0, 3, 4.6, SHIP_DECK + 1.3, "steel", 1));
  out.push(box(57.5, 0, 3, 14, SHIP_DECK, "steel", 1));
  // The bridge house and the funnel behind it.
  const house = tower(44, 0, 12, 12, 3, { doors: [["w", "s"]], windows: [["n"], ["n", "s", "w"], ["n", "s", "w", "e"]] });
  out.push(...lift(SHIP_DECK, house));
  out.push(box(53, 0, 3, 4, SHIP_DECK + 14, "steel", 3, SHIP_DECK), box(53, 0, 3.2, 4.2, SHIP_DECK + 15, "steel", 1, SHIP_DECK + 14));
  // Cargo hatches on the deck (cover up there), three masts with their cross-trees.
  for (const x of [-44, -24, -6]) out.push(box(x, 0, 7, 8, SHIP_DECK + 0.9, "steel", 2, SHIP_DECK));
  for (const x of [-34, -15, 4]) out.push(box(x, 0, 0.6, 0.6, SHIP_DECK + 12, "steel", 2, SHIP_DECK), box(x, 0, 0.4, 7, SHIP_DECK + 10.4, "steel", 2, SHIP_DECK + 10));
  // In the holds: containers and crates that came loose.
  out.push(box(-31, -3, 6.2, 2.5, 2.6, "container", 0), box(21.5, -3.5, 2.5, 6.2, 2.6, "container", 1), box(-19, 3, 1.2, 1.2, 0.9, "crate"), box(-20.2, 3, 1.2, 1.2, 1.8, "crate"), box(5, -5, 1.2, 1.2, 0.9, "crate"));
  out.push(box(-45, 3.5, 6.2, 2.5, 2.6, "container", 2), box(44, -4, 2.5, 6.2, 2.6, "container", 2));
  // A container fallen onto the deck, and the plates torn out round the breach.
  out.push(box(-36, 4.6, 6.2, 2.5, SHIP_DECK + 2.6, "container", 2, SHIP_DECK));
  out.push(box(3.8, 10, 2, 1.4, 1.0, "rock", 1), box(-4.2, 10.6, 1.6, 1.2, 0.7, "rock"));
  return out;
}

/**
 * Container stacks in the yard: per row (its z), the heights of the stacks at each of `YARD_X`
 * (0 = an alley across). Three blocks of columns, split by the two lanes the gantries straddle.
 */
const YARD_X = [-57.2, -50.8, -44.4, -38, -31.6, -13, -6.6, 6.6, 13, 31.6, 38, 44.4, 50.8, 57.2];
const YARD_ROWS: [number, number[]][] = [
  [-27, [1, 2, 0, 2, 1, 2, 0, 0, 0, 2, 0, 3, 2, 1]],
  [-18, [2, 3, 2, 1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2]],
  [-9, [1, 2, 3, 0, 1, 2, 1, 2, 2, 3, 0, 2, 1, 2]],
  [9, [3, 2, 1, 2, 2, 1, 2, 2, 1, 2, 3, 1, 2, 3]],
  [18, [2, 1, 0, 3, 2, 2, 3, 1, 2, 2, 1, 0, 2, 1]],
  [27, [1, 2, 3, 1, 0, 1, 2, 0, 0, 0, 2, 3, 1, 2]],
];
/** The two gantries: the lanes' middles, and where each cab sits along its catwalk. */
const GANTRIES = [
  { x: -24, cab: -6 },
  { x: 24, cab: 6.5 },
] as const;

/**
 * The container yard, in its own frame: six rows of stacked containers in three blocks with a
 * lane down between each pair of blocks and alleys across, a gantry crane over each lane (one
 * leg a stair tower up to the catwalk along its top, the driver's cab on the catwalk), and the
 * yard office at its west end.
 */
function yard(): Box[] {
  const out: Box[] = [];
  YARD_ROWS.forEach(([z, heights], r) =>
    heights.forEach((n, i) => {
      for (let k = 0; k < n; k++) out.push(box(YARD_X[i], z, 6.2, 2.5, 2.6 * (k + 1), "container", (r + i + k) % 3, 2.6 * k));
    }),
  );
  for (const g of GANTRIES) out.push(...gantry(g.x, -32, 32, CRANE, g.cab));
  // The yard office, with stairs up to its roof, and a reefer stack by it.
  out.push(...building(-70, 2, 8, 7, 3.4, { doors: ["e", "s"], windows: ["n"], roof: "w" }));
  out.push(box(-70, 14, 2.5, 6.2, 2.6, "container", 1), box(-70, 14, 2.5, 6.2, 5.2, "container", 2, 2.6));
  out.push(box(-4, 38, 1.2, 1.2, 0.9, "crate"), box(64, -36, 1.2, 1.2, 1.8, "crate"));
  return out;
}

/**
 * The smelter, in its own frame: a furnace hall and a casting hall four storeys high, joined at
 * roof height by a railed bridge, the four-storey control block bridged to the casting hall,
 * and an open stair tower up the furnace hall's west end, so the roofs make one high way across
 * the works. Two chimneys stand over it all, seen from anywhere in the harbor.
 */
function smelter(): Box[] {
  const H = STOREY * 4;
  const out: Box[] = [];
  out.push(
    ...hall(-28, -6, 28, 18, H, {
      doors: [{ side: "s", at: -4, w: 6 }],
      hatches: [{ side: "e", at: 4 }, { side: "w", at: 4 }],
      windows: ["n", "s"],
      mezz: [{ side: "n", depth: 4, y: STOREY * 2, stair: 8 }],
      columns: 7,
      open: ["w", "e"],
    }),
  );
  out.push(box(-34, -8, 6, 6, 5.1, "steel", 2), box(-34, -8, 3, 3, H - 0.3, "steel", 3, 5.1));
  out.push(...lattice(-44.5, -6, 5, 5, 4, H + 2, ["e"]));
  out.push(
    ...hall(14, -6, 26, 18, H, {
      doors: [{ side: "s", w: 6 }],
      hatches: [{ side: "e", at: 5 }],
      windows: ["n", "s"],
      columns: 6.5,
      open: ["w", "e"],
    }),
  );
  out.push(box(10, -9, 3, 3, 2.4, "steel", 2), box(18, -9, 3, 3, 2.4, "steel", 2));
  out.push(...tower(44, -6, 10, 10, 4, { doors: [["w", "s"]], windows: [["e"], ["n", "w", "s"], ["n", "w", "s"], ["n", "e", "s"]], open: ["w"] }));
  // Roof bridges, railed.
  for (const [x0, x1] of [[-14, 1], [27, 39]] as const) out.push(bridge(x0, -7, x1, -5, H), rect(x0, -7, x1, -6.8, H, H + 0.8, "wall", 1), rect(x0, -5.2, x1, -5, H, H + 0.8, "wall", 1));
  // The chimneys with their rusted tops, and a pipe from each across to the halls.
  out.push(box(-6, 14, 4, 4, 34, "tower"), box(-6, 14, 4.2, 4.2, 40, "steel", 0, 34));
  out.push(box(6, 17, 3.4, 3.4, 28, "tower"), box(6, 17, 3.6, 3.6, 33, "steel", 0, 28));
  out.push(box(-6, 7.5, 1, 9, 9, "steel", 2, 8), box(6, 9, 1, 12, 10, "steel", 2, 9));
  // A fuel tank, and slag heaps.
  out.push(...tank(58, 14, 4, 9, "w", 0));
  out.push(box(-50, 16, 7, 5, 2.6, "rock", 1), box(-30, 24, 5, 4, 1.8, "rock"), box(34, 20, 6, 4, 2.2, "rock", 1));
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
const AUTHORED: Box[] = [
  ...HARBOR,
  ...HAMLETS.flatMap((h) => h.boxes),
  ...onLevel(LEVEL.shore, place(AT[0][0], AT[0][1], supply())),
  ...onLevel(LEVEL.pit, place(AT[1][0], AT[1][1], quarry())),
  ...onLevel(LEVEL.mesa, place(AT[2][0], AT[2][1], relay())),
  ...onLevel(LEVEL.dam, place(AT[3][0], AT[3][1], pad())),

  // --- 旧市街: a clock tower joined to two houses by bridges at 6.8 m, shops around two streets
  ...onLevel(LEVEL.lakebed, placeIn("heart", [
    ...tower(0, 12, 8, 9, 3, { doors: [["s", "e"], [], ["w", "e"]], windows: [["w"], ["n", "e", "w"], ["s"]] }),
    ...tower(-14, 12, 10, 8, 2, { doors: [["s", "w"]], windows: [["e"], ["n", "w"]], open: ["e"] }),
    ...tower(14, 12, 8, 8, 2, { doors: [["s", "e"]], windows: [["w"], ["n", "e"]], open: ["w"] }),
    bridge(-9, 11, -4, 13, STOREY * 2),
    bridge(4, 11, 10, 13, STOREY * 2),
    ...building(-16, 26, 7, 6, 3.4, { doors: ["n", "e"], windows: ["s"] }),
    ...building(16, 27, 6, 7, 3.4, { doors: ["w"], windows: ["n"], roof: "s" }),
    ...building(-2, 30, 8, 5, 3.4, { doors: ["s", "n"], windows: ["e", "w"] }),
    ...building(-15, -4, 7, 6, 3.4, { doors: ["n", "e"], roof: "w" }),
    ...building(12, -5, 8, 6, 3.4, { doors: ["n", "w"], windows: ["s"] }),
    box(-4, 23, 1.2, 1.2, 0.9, "crate"),
    box(2, 5, 1.2, 1.2, 1.8, "crate"),
    box(-24, 6, 0.6, 8, 1.4, "wall"),
    box(24, 20, 0.6, 8, 1.4, "wall"),
    box(0, 38, 3, 1.2, 1.2, "rock"),
  ])),

  // --- tall buildings, seen from anywhere on the island
  ...HIGH_RISES.flatMap((h) => onLevel(h.level, highRise(h.x, h.z, h.w, h.d, h.floors))),

  // --- 尾根: a long ridge with stairs at both ends, cover on top
  ...onLevel(LEVEL.ridge, placeIn("ridge", [
    box(-50, 70, 30, 6, 3.5, "rock"),
    ...stairs(-35, 70, "e", 2.4, 3.5, 1),
    ...stairs(-65, 70, "w", 2.4, 3.5, 1),
    box(-50, 67.4, 6, 0.4, 4.4, "wall", 1, 3.5),
    box(-42, 82, 5, 4, 2, "rock"),
    box(-58, 56, 4, 6, 1.6, "rock"),
  ])),

  // --- 台地: three terraces climbing to a lookout over the lakebed
  ...onLevel(LEVEL.shore, place(AREA.heart[0] - 6, AREA.heart[1], [
    box(-45, -50, 34, 26, 2.4, "rock"),
    box(-48, -52, 20, 14, 4.8, "rock", 1),
    box(-52, -54, 8, 8, 7.2, "rock"),
    ...stairs(-28, -45, "e", 3, 2.4, 1),
    ...stairs(-40, -63, "n", 3, 2.4, 1),
    ...stairs(-38, -49, "e", 2, 4.8, 1, 2.4),
    ...stairs(-48, -52, "e", 1.6, 7.2, 1, 4.8),
    box(-52, -57.6, 8, 0.4, 8.2, "wall", 1, 7.2),
  ])),

  // --- 工場: a hall with a catwalk inside, two silos, a container yard
  ...onLevel(LEVEL.shore, placeIn("factory", [
    ...building(55, 45, 24, 14, 6, { doors: ["w", "s"], windows: ["n", "e"] }),
    rect(45, 38.35, 65, 40.35, 3.0, 3.3, "slab"),
    ...stairs(46, 40.35, "s", 1.4, 3.3),
    box(72, 38, 4, 4, 9, "tower", 1),
    box(72, 45, 4, 4, 9, "tower"),
    box(50, 58, 6.2, 2.5, 2.6, "container", 2),
    box(58, 60, 2.5, 6.2, 2.6, "container", 0),
    box(46, 64, 6.2, 2.5, 2.6, "container", 1),
    box(53, 63, 1.2, 1.2, 0.9, "crate"),
  ])),

  // --- 住宅地: a terrace of three houses under one roof, two cottages
  ...onLevel(LEVEL.mesa, placeIn("relay", [
    ...rowHouses(96, 15, 3, 8, 8, 2),
    ...building(98, 30, 6, 6, 3.4, { doors: ["n", "e"], windows: ["s"] }),
    ...building(112, 31, 7, 6, 3.4, { doors: ["w"], windows: ["e"], roof: "s" }),
    box(106, 40, 0.6, 6, 1.4, "wall"),
  ])),

  // --- 廃村: a two-storey house, two cottages and broken walls
  ...onLevel(LEVEL.shore, placeIn("village", [
    ...tower(-112, -70, 8, 8, 2, { doors: [["e", "s"]], windows: [["w"], ["n", "e", "w"]] }),
    ...building(-105, -55, 7, 6, 3.4, { doors: ["e", "n"], roof: "s" }),
    ...building(-95, -68, 6, 6, 3.4, { doors: ["n", "w"], windows: ["e"] }),
    box(-100, -80, 7, 0.6, 1.6, "wall"),
    box(-118, -58, 0.6, 6, 1.2, "wall"),
  ])),
];

/**
 * The routes' trenches (`ROUTES`), carved only while a route is open. Cover is kept off the
 * ground they lower (`scatterCover`), which is otherwise left as it is: pressing it flat would
 * change the closed world.
 */
// The tunnel under the mountains, straight through them north of the landing pad, its floor at
// the open ground's level at either mouth.
const TUNNEL: Carve = { name: "坑道", line: [[40, -270], [40, -430]], floor: 3, levels: [10, 4], slope: 2.4 };
// The dam's inspection gallery, in the heart's frame: from the lakebed under the crest, up onto
// the crest and the pad behind it.
const GALLERY: Carve = { name: "点検通路", line: [[14 + AREA.heart[0], -62 + AREA.heart[1]], [14 + AREA.heart[0], -91 + AREA.heart[1]]], floor: 2.5, levels: [LEVEL.lakebed, LEVEL.dam], slope: 2.4 };
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
 * Roads that are the only ways between areas: the way between the regions and the harbor's
 * ramps. Cover is kept off them, and they are pressed to their own floor along their middle,
 * so no rock or building nearby can close them.
 */
const KEPT_ROADS = ["峠道", "鉄道の土手（南）", "鉄道の土手（北）", "駅の坂", "高架下", "西の道", "製錬所の坂", "塩田への坂", "ヤードの北道", "製錬所の北道", "岬の坂", "斜路"];

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
    if (p.boss) points.push({ x: p.x, z: p.z, r: 26 }); // the titan's arena stays open
  }
  ROAMERS.forEach(squadArea);
  for (const b of EXTRA_BINS) points.push({ x: b.x, z: b.z, r: 2.5 });
  // The boat's point keeps less flat ground round it: the channel's water starts a few metres off.
  for (const x of EXTRACTS) points.push({ x: x.x, z: x.z, r: x.id === "boat" ? 6 : 10 });
  for (const e of ENTRIES) points.push({ x: e.x, z: e.z, r: 6 });
  return { points, segments };
}

/**
 * The ground scattered with cover, each with its own grid and seed so that adding to one
 * region leaves the other's cover as it was. On the salt flats only one candidate in two
 * stands, and only a container or a rock: the most open ground, yet with a wreck to get behind
 * a few steps away, since in the open a robot's burst lands. The
 * channel, under water, gets none.
 */
const SCATTER = [
  { x0: WORLD.x0, x1: WORLD.x1, z0: -350, z1: WORLD.z1, seed: 7_331 },
  { x0: WORLD.x0, x1: WORLD.x1, z0: WORLD.z0, z1: -351, seed: 4_517 },
];
const SPARSE = "塩田";
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

function scatterCover(authored: Box[], { points, segments }: Keep): Box[] {
  const near: Clearance = { authored: new Near(), laid: new Near(), points: new Near(), along: new Near() };
  for (const b of authored) near.authored.add(b.x0, b.z0, b.x1, b.z1, b);
  for (const q of points) near.points.add(q.x - q.r, q.z - q.r, q.x + q.r, q.z + q.r, q);
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
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)];

  const pieceAt = (x: number, z: number): Box[] => {
    const alongX = rnd() < 0.5;
    const len = (a: number, b: number) => a + rnd() * (b - a);
    const kind = rnd();
    if (kind < 0.24) {
      // A low wall: hides a crouching player, a standing one shoots over it.
      const l = len(4, 6.5);
      return [alongX ? box(x, z, l, 0.5, 1.15, "wall", 1) : box(x, z, 0.5, l, 1.15, "wall", 1)];
    }
    if (kind < 0.42) {
      // An L of full-height wall.
      const a = len(3, 5);
      const b = len(2.5, 4);
      const sx = rnd() < 0.5 ? 1 : -1;
      const sz = rnd() < 0.5 ? 1 : -1;
      return [box(x + (sx * a) / 2, z, a, 0.4, 2.4, "wall"), box(x, z + (sz * b) / 2, 0.4, b, 2.4, "wall")];
    }
    if (kind < 0.58) {
      // A stack of crates.
      const n = 2 + Math.floor(rnd() * 2);
      const out: Box[] = [];
      for (let i = 0; i < n; i++) {
        const ox = alongX ? i * 1.25 : (rnd() - 0.5) * 0.4;
        const oz = alongX ? (rnd() - 0.5) * 0.4 : i * 1.25;
        out.push(box(x + ox, z + oz, 1.2, 1.2, pick([0.9, 1.8, 1.8]), "crate"));
      }
      return out;
    }
    if (kind < 0.67) return [alongX ? box(x, z, 6.2, 2.5, 2.6, "container", Math.floor(rnd() * 3)) : box(x, z, 2.5, 6.2, 2.6, "container", Math.floor(rnd() * 3))];
    if (kind < 0.8) return [box(x, z, len(2.5, 5), len(2.5, 5), len(1.4, 3.2), "rock", Math.floor(rnd() * 2))];
    if (kind < 0.9) {
      // A sandbag ring, open on one side.
      const open = pick(SIDES);
      return SIDES.filter((s) => s !== open).map((s) =>
        s === "n" ? box(x, z - 1.5, 3.4, 0.5, 1.15, "wall", 1) : s === "s" ? box(x, z + 1.5, 3.4, 0.5, 1.15, "wall", 1) : s === "e" ? box(x + 1.5, z, 0.5, 3.4, 1.15, "wall", 1) : box(x - 1.5, z, 0.5, 3.4, 1.15, "wall", 1),
      );
    }
    // A roofless ruin with two ways in.
    const doors: Side[] = rnd() < 0.5 ? ["n", "s"] : ["e", "w"];
    return walls(x, z, 6, 6, 0, 2.4, doors, doors[0] === "n" ? ["e"] : ["n"]);
  };

  const clear = (b: Box, gap: number) => (o: Box) => b.x1 + gap <= o.x0 || o.x1 + gap <= b.x0 || b.z1 + gap <= o.z0 || o.z1 + gap <= b.z0;
  const distToBox = (b: Box, x: number, z: number) => Math.hypot(Math.max(b.x0 - x, 0, x - b.x1), Math.max(b.z0 - z, 0, z - b.z1));
  // A piece goes only on low ground that is not a cliff. It starts at the lowest ground
  // under it and keeps its full height above the highest, so it never floats or sinks.
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
  // Wrecks out on the salt flats: a rusted container or a rock.
  const wreckAt = (x: number, z: number): Box[] =>
    rnd() < 0.6 ? [rnd() < 0.5 ? box(x, z, 6.2, 2.5, 2.6, "container", 0) : box(x, z, 2.5, 6.2, 2.6, "container", 0)] : [box(x, z, 2.5 + rnd() * 2.5, 2.5 + rnd() * 2.5, 1.4 + rnd() * 1.4, "rock", Math.floor(rnd() * 2))];
  const placed: Box[] = [];
  // Candidates on a 12 m grid from 11 m inside the area's bounds, each nudged at random.
  const edge = 11;
  for (let gx = area.x0 + edge; gx <= area.x1 - edge; gx += 12)
    for (let gz = area.z0 + edge; gz <= area.z1 - edge; gz += 12) {
      const x = gx + (rnd() - 0.5) * 7;
      const z = gz + (rnd() - 0.5) * 7;
      const at = surfaceAt(x, z);
      const sparse = at === SPARSE;
      if ((sparse && rnd() > 0.5) || at === WATER) continue;
      // The ground between the areas is bare but for clumps of cover a hundred metres or so
      // across, some way apart: open stretches to cross, and somewhere to break the sightline.
      if (at === BETWEEN && (rnd() > 0.6 || clump(x, z) < 0.55)) continue;
      const piece = sparse ? wreckAt(x, z) : pieceAt(x, z);
      const base = groundUnder(piece);
      if (base === null) continue;
      for (const b of piece) {
        b.y0 += base.lo;
        b.h += base.hi;
      }
      const ok = piece.every(
        (b) =>
          near.authored.every(b.x0 - 3, b.z0 - 3, b.x1 + 3, b.z1 + 3, clear(b, 3)) &&
          near.laid.every(b.x0 - 2.5, b.z0 - 2.5, b.x1 + 2.5, b.z1 + 2.5, clear(b, 2.5)) &&
          near.points.every(b.x0, b.z0, b.x1, b.z1, (q) => distToBox(b, q.x, q.z) > q.r) &&
          near.along.every(b.x0, b.z0, b.x1, b.z1, (q) => distToBox(b, q.x, q.z) >= 2.5),
      );
      if (ok) {
        placed.push(...piece);
        for (const b of piece) near.laid.add(b.x0, b.z0, b.x1, b.z1, b);
      }
    }
  return placed;
}

/**
 * The canyon bridge: two rock pillars standing on the spillway floor and a deck at
 * the mesa's level between the two bridge roads. They are not pressed flat: the
 * spillway runs under them.
 */
const BRIDGE: Box[] = placeIn("heart", [
  box(42, -95, 6, 6, LEVEL.mesa, "rock", 0, LEVEL.pit - 2),
  box(62, -95, 6, 6, LEVEL.mesa, "rock", 1, LEVEL.pit - 2),
  bridge(45, -96.2, 59, -93.8, LEVEL.mesa),
]);

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
 * The quarry plant's conveyor walkway: from the plant's third floor west over the pit's wall to
 * the rim, with steps down to the ground there. It is not pressed flat (the pit's wall runs under
 * it), so it is laid once the ground is, and its steps reach the rim's height.
 */
const CONVEYOR: Box[] = (() => {
  const [qx, qz] = AT[1];
  const y = LEVEL.pit + PLANT.belt;
  const x0 = qx + PLANT.rim;
  const x1 = qx + PLANT.x - 7;
  const z = qz + PLANT.z;
  const ground = terrainHeight(x0 - 0.5, z);
  // The belt itself runs beside the walkway, on its north side, from the plant's floor out over the wall.
  return [...catwalk(x0, z, x1, z, y, 1.8), rect(x0 + 3, z - 2.1, x1, z - 0.95, y - 0.6, y + 0.2, "steel", 2), ...(y - ground > 0.4 ? stairs(x0, z, "w", 1.8, y, 0, ground) : [])];
})();

// The canyon floors pay for the detour: a bin under each bridge.
for (const { x, z, table } of [at("heart", { x: 55, z: -112, table: "relay" as const }), at("railway", { x: 127, z: -192, table: "smelter" as const })])
  EXTRA_BINS.push({ x, z, y: terrainHeight(x, z), table });

/**
 * One depot per POI, on the road out from its entry: in reach on the way in or out, yet
 * outside the fight round the POI. They are not boxes and keep no ground clear, so the
 * island's cover is laid out the same with or without them. They are placed on the built
 * ground, so each stands at the floor level the walkers find there.
 */
export const DEPOTS: Depot[] = POIS.map((p) => {
  const ax = p.entry.x - p.x;
  const az = p.entry.z - p.z;
  const len = Math.hypot(ax, az);
  const at = onFloor({ x: +(p.entry.x + (ax / len) * DEPOT_OUT[p.id]).toFixed(1), z: +(p.entry.z + (az / len) * DEPOT_OUT[p.id]).toFixed(1) });
  return { poi: p.id, x: at.x, y: at.y, z: at.z, yaw: Math.atan2(p.x - at.x, -(p.z - at.z)) };
});

export const BOXES: Box[] = [...AUTHORED, ...BRIDGE, ...RAILWAY, ...QUAY, ...CONVEYOR, ...scatterCover([...AUTHORED, ...BRIDGE, ...RAILWAY, ...QUAY, ...CONVEYOR], KEEP)];

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
  const dFoot = cliffFoot(dx, -54 + hz, -1);
  // The wreck's gangway: up the hull's north side to its main deck, near the bow, written in the
  // wreck's frame (its hull's north face is 8 m north of its middle) so it moves with the wreck.
  const deck = LEVEL.seabed + STOREY * 3;
  const [wx, wz] = AT[poiIndex("wreck")];
  const gx = wx - 32.4;
  const gz = wz - 9.3;
  // The deck's rail along the hull's north side: the gangway is chained against it, and lands over it.
  const rail = wz - 7.75;
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
      path: [{ x: dx, z: -54 + hz }, { x: dx, z: -96 + hz }],
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
      path: [{ x: gx - 15.5, z: gz }, { x: gx + 1.2, z: wz - 5 }],
      at: [{ x: gx, y: LEVEL.seabed, z: gz - 1.4 }],
      // Hauled aboard and stood up against the deck's rail, over the place it lands, chained there.
      closed: [
        rect(gx - 1.0, rail, gx + 1.0, wz - 7.45, deck, deck + 2.8, "steel", 2),
        rect(gx - 1.15, wz - 7.45, gx + 1.15, wz - 7.3, deck + 1.0, deck + 1.15, "steel", 2),
        rect(gx - 0.18, wz - 7.3, gx + 0.18, wz - 7.1, deck + 0.75, deck + 1.2, "steel", 0),
      ],
      // Its flight, and a landing over the deck's rail that steps down onto the deck.
      open: [...gangway, rect(gx, gz - 1.0, gx + 2.4, wz - 7.45, deck + 0.4, deck + 0.7, "steel", 2)],
    },
  ];
})();

export const routeOf = (id: RouteId): Route => ROUTES.find((r) => r.id === id) ?? ROUTES[0];
