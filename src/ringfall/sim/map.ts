import { VAULT, WORLD, type EnemyKind, type HealKind, type Rarity, type ToolKind, type ValuableKind, type WeaponKind } from "./config";
import { buildTerrain, type Carve, type FlatShape, floorLevel, highGround, LEVEL, offshore, roadLine, steepAt, surfaceAt, terrainHeight } from "./terrain";

/**
 * The world: two regions, a dried-up reservoir in the south and a dry harbor in the
 * north, joined by a pass road and a railway (see terrain.ts for their levels).
 * Everything solid is an axis-aligned box, so collision, line of sight and standing on
 * top are all the same cheap test. North is -z. The player chooses the region to drop
 * into; every POI, district and way off in both regions is open from the start.
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
    out.push(...slabWithHole(x0, z0, x1, z1, top - 0.3, top, sx0, za, sx1, zb));
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

/** The harbor's lighthouse on its headland: the highest view over the harbor. */
const LIGHTHOUSE = { x: -116, z: -553, floors: 7 } as const;

/** Tall buildings: where they stand, their size and storeys. Their top-floor bins are in EXTRA_BINS. */
const HIGH_RISES = [
  { x: 0, z: -14, w: 10, d: 10, floors: 6, level: LEVEL.lakebed }, // the drowned town's office block
  { x: 125, z: 0, w: 10, d: 10, floors: 5, level: LEVEL.mesa }, // flats beyond the housing street
  { x: -34, z: -128, w: 8, d: 8, floors: 5, level: LEVEL.dam }, // the pad's control tower
  { x: -182, z: 10, w: 8, d: 8, floors: 4, level: LEVEL.pit }, // a lookout at the quarry's far end
  { x: -129, z: 28, w: 8, d: 8, floors: 4, level: LEVEL.pit }, // the quarry office
] as const;

/** A walkway slab whose top is at height y. */
const bridge = (x0: number, z0: number, x1: number, z1: number, y: number): Box => rect(x0, z0, x1, z1, y - 0.3, y, "slab", 1);

/** Moves boxes authored in a district's own frame into place. */
const place = (dx: number, dz: number, boxes: Box[]): Box[] => boxes.map((b) => ({ ...b, x0: b.x0 + dx, x1: b.x1 + dx, z0: b.z0 + dz, z1: b.z1 + dz }));

/** Raises boxes by `dy`: a building stood on a deck or a roof. */
const lift = (dy: number, boxes: Box[]): Box[] => boxes.map((b) => ({ ...b, y0: b.y0 + dy, h: b.h + dy }));

/** Repaints the boxes of one kind that `which` picks (a ship's walls as steel plate, a lighthouse's bands). */
const paint = (boxes: Box[], from: BoxKind, kind: BoxKind, tint: (b: Box) => number, which: (b: Box) => boolean = () => true): Box[] =>
  boxes.map((b) => (b.kind === from && which(b) ? { ...b, kind, tint: tint(b) } : b));

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
 * into place by this offset.
 */
const AT = [
  [0, 90],
  [-99, 8],
  [48, -7],
  [0, -52],
  // The harbor's POIs are written round their own middle.
  [10, -562],
  [-100, -400],
  [120, -415],
] as const;

const POI_FRAMES: Poi[] = [
  {
    id: "supply",
    name: "補給所",
    x: 0,
    z: 50,
    trigger: 24,
    entry: { x: 0, z: 74, yaw: 0 },
    squads: [
      // Two squads, one each side of the yard: a fight with one leaves the other a flank to come round.
      { name: "倉庫", members: [{ kind: "grunt", plate: VAULT.guardPlate, x: 25, z: 52, face: W }, { kind: "grunt", x: 18, z: 63, y: 3, face: S }] },
      { name: "管理棟", members: [{ kind: "grunt", x: -23, z: 50, face: E }, { kind: "charger", x: -16, z: 56, face: E }] },
    ],
    bins: [
      { x: -2, z: 54 },
      { x: 7, z: 61 },
      { x: -11, z: 41 },
      { x: -23, z: 47 },
      { x: 22, z: 52, y: STOREY, vault: true },
    ],
    keyFrom: "pad",
    loot: { weapon: [["hornet", 1], ["maul", 0], ["lance", 0], ["pike", 1]], armor: [1], heals: 1, valuable: [["fuse", 3], ["parts", 4], ["wire", 2], ["drive", 1]] },
    floor: [
      { x: 3, z: 66, weapon: ["hornet", 0] },
      { x: -4, z: 66, heal: "syringe" },
      { x: -24, z: 49, y: 3.6, armor: 1 },
      { x: 25, z: 50, y: STOREY * 2, heal: "battery" },
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
    x: 42,
    z: -28,
    trigger: 27,
    entry: { x: 16, z: -23, yaw: 1.4 },
    squads: [
      { name: "中継塔", members: [{ kind: "grunt", x: 41.5, z: -29, y: 5, face: SW }, { kind: "heavy", x: 36, z: -36, face: SW }] },
      { name: "3 階建て", members: [{ kind: "grunt", plate: VAULT.guardPlate, x: 49, z: -10, face: W }, { kind: "grunt", x: 57, z: -20, face: W }, { kind: "charger", x: 34, z: -26, face: SW }] },
    ],
    bins: [
      { x: 33, z: -22 },
      { x: 50, z: -36 },
      { x: 44, z: -16 },
      { x: 48, z: -10, y: STOREY * 2, vault: true },
    ],
    keyFrom: "quarry",
    loot: { weapon: [["pike", 3], ["hornet", 2], ["maul", 2], ["lance", 2], ["talon", 2]], armor: [2, 3], heals: 2, valuable: [["board", 4], ["drive", 2], ["wire", 1], ["gyro", 1]] },
    floor: [
      { x: 41.5, z: -29, y: 5, weapon: ["lance", 2] },
      { x: 50, z: -12, y: STOREY * 3, armor: 2 },
    ],
  },
  {
    id: "pad",
    name: "発着場",
    x: 0,
    z: -68,
    trigger: 28,
    entry: { x: 0, z: -36, yaw: 0 },
    squads: [{ name: "タイタン", members: [{ kind: "titan", x: 0, z: -76, face: S }, { kind: "drone", x: -8, z: -70 }, { kind: "drone", x: 8, z: -70 }] }],
    bins: [
      { x: -16, z: -56 },
      { x: 16, z: -56 },
      { x: -32, z: -60, y: STOREY },
      { x: 32, z: -60, y: STOREY, vault: true },
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
    trigger: 34,
    entry: { x: 0, z: 24, yaw: 0 },
    squads: [
      // Up high, robots stand at the parapet: seen from the ground below, and seeing it.
      { name: "甲板", members: [{ kind: "grunt", plate: VAULT.guardPlate, x: 30, z: 7.1, y: SHIP_DECK, face: S }, { kind: "heavy", x: 6, z: 6.75, y: SHIP_DECK, face: S }] },
      {
        name: "浜",
        members: [{ kind: "grunt", x: -12, z: 16, face: S }, { kind: "grunt", x: -9.5, z: 17, face: S }, { kind: "drone", x: -50, z: 18 }],
        patrol: [{ x: -50, z: 18 }, { x: 56, z: 18 }, { x: 56, z: -16 }, { x: -50, z: -16 }],
      },
    ],
    bins: [
      { x: -32, z: 3 },
      { x: 26, z: -3 },
      { x: -10, z: 4, y: STOREY },
      { x: -36, z: -3, y: SHIP_DECK },
      { x: 26.5, z: 2, y: SHIP_DECK + STOREY * 2, vault: true },
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
    trigger: 30,
    entry: { x: 8, z: 27, yaw: 0 },
    squads: [
      { name: "クレーン", members: [{ kind: "grunt", plate: VAULT.guardPlate, x: 0.35, z: -6, y: CRANE, face: E }, { kind: "heavy", x: -24, z: -13.5, face: E }] },
      { name: "通路", members: [{ kind: "grunt", x: 20, z: 13.5, face: W }, { kind: "grunt", x: 23, z: 13.5, face: W }] },
    ],
    bins: [
      { x: -28, z: -13.5 },
      { x: 10, z: 13.5 },
      { x: -41, z: 2 },
      { x: -7.8, z: -9, y: 2.6 },
      { x: 1.4, z: 6.5, y: CRANE, vault: true },
    ],
    keyFrom: "wreck",
    loot: { weapon: [["hornet", 2], ["maul", 2], ["pike", 2], ["lance", 1]], armor: [2], heals: 2, valuable: [["wire", 3], ["board", 3], ["drive", 2], ["gyro", 1]] },
    floor: [
      { x: 12, z: -13.5, heal: "battery" },
      { x: -42, z: 3, y: 3.4, armor: 2 },
    ],
  },
  {
    id: "smelter",
    name: "製錬所",
    x: 0,
    z: 0,
    trigger: 32,
    entry: { x: 2, z: 26, yaw: 0 },
    squads: [
      { name: "制御棟", members: [{ kind: "grunt", plate: VAULT.guardPlate, x: 37, z: -2.9, y: STOREY * 3, face: S }, { kind: "grunt", x: 16, z: -2, face: S }] },
      { name: "炉", members: [{ kind: "heavy", x: -15, z: -1, face: S }, { kind: "charger", x: -26, z: 12, face: E }] },
    ],
    bins: [
      { x: -24, z: -3 },
      { x: 21, z: -3 },
      { x: -20, z: -11.65, y: 5.1 },
      { x: -38, z: 20 },
      { x: 34, z: -4, y: STOREY * 2, vault: true },
    ],
    keyFrom: "yard",
    loot: { weapon: [["pike", 3], ["lance", 2], ["maul", 2], ["talon", 1], ["hornet", 3]], armor: [2, 3], heals: 2, valuable: [["wire", 2], ["gyro", 3], ["drive", 2], ["board", 2], ["reactor", 1]] },
    floor: [{ x: 34, z: -3, y: STOREY * 3, weapon: ["talon", 2] }],
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
const DEPOT_OUT: Record<PoiId, number> = { supply: 18, quarry: 6, relay: 40, pad: 24, wreck: 22, yard: 18, smelter: 25 };

/**
 * One depot per POI, on the road out from its entry: in reach on the way in or out, yet
 * outside the fight round the POI. They are not boxes and keep no ground clear, so the
 * island's cover is laid out the same with or without them.
 */
export const DEPOTS: Depot[] = POIS.map((p) => {
  const ax = p.entry.x - p.x;
  const az = p.entry.z - p.z;
  const len = Math.hypot(ax, az);
  const at = onFloor({ x: +(p.entry.x + (ax / len) * DEPOT_OUT[p.id]).toFixed(1), z: +(p.entry.z + (az / len) * DEPOT_OUT[p.id]).toFixed(1) });
  return { poi: p.id, x: at.x, y: at.y, z: at.z, yaw: Math.atan2(p.x - at.x, -(p.z - at.z)) };
});

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
  { id: "flare", name: "台地の回収地点", short: "台地", x: -58, z: -53, radius: 5, hold: 4, needsFlare: true, note: "発煙筒を焚けば 4 秒" },
  { id: "village", name: "廃村の回収地点", short: "廃村", x: -91, z: -63, radius: 5, hold: 15, note: "遠いが静か。15 秒待つ" },
  // The harbor's way off: a boat comes up the channel to the quay.
  { id: "boat", name: "埠頭のボート", short: "ボート", x: 105, z: -580, radius: 5, hold: 1.5, call: 25, waves: { x: 100, z: -563 }, note: "呼んで 25 秒守る。増援が降りてくる" },
];
export const EXTRACT = EXTRACTS[0];

/**
 * Squads between the POIs. Beating them is optional. Most of the ground between the POIs is
 * quiet: one squad holds the drowned town, and a few walk the roads and the open ground
 * between the areas, met on the way rather than found at a post.
 */
export const ROAMERS: Squad[] = (
  [
    // The lookout stays on the clock tower: a patrol is led by its first member, and one posted up high cannot leave its floor.
    { name: "時計塔", members: [{ kind: "grunt", x: 0, z: 13, y: STOREY * 3, face: S }] },
    {
      name: "旧市街の見回り",
      members: [{ kind: "grunt", x: -7, z: 20, face: E }],
      patrol: [{ x: 7, z: 20 }, { x: 7, z: 2 }, { x: -7, z: 2 }, { x: -7, z: 20 }],
    },
    {
      name: "尾根道の巡回",
      roam: true,
      members: [{ kind: "grunt", x: -40, z: 78 }, { kind: "drone", x: -38, z: 80 }],
      patrol: [{ x: -40, z: 78 }, { x: -62, z: 64 }, { x: -90, z: 68 }, { x: -62, z: 64 }, { x: -40, z: 78 }, { x: -33, z: 86 }],
    },
    {
      name: "東の坂の巡回",
      roam: true,
      members: [{ kind: "grunt", x: 44, z: -8 }, { kind: "charger", x: 42.4, z: -6.6 }],
      patrol: [{ x: 44, z: -8 }, { x: 58, z: -24 }, { x: 44, z: -8 }, { x: 22, z: 0 }],
    },
  ] satisfies Squad[]
)
  .map((sq) => placeSquad(sq, 0, 0))
  .concat(
    (
      [
        // Between the regions.
        {
          name: "峠道の巡回",
          roam: true,
          members: [{ kind: "grunt", x: -48, z: -185 }, { kind: "drone", x: -46, z: -183 }],
          patrol: [{ x: -48, z: -185 }, { x: -60, z: -222 }, { x: -64, z: -262 }, { x: -60, z: -222 }],
        },
        // The harbor.
        {
          name: "高架下の巡回",
          roam: true,
          members: [{ kind: "grunt", x: 118, z: -276 }, { kind: "charger", x: 116.6, z: -274.6 }],
          patrol: [{ x: 118, z: -276 }, { x: 118, z: -343 }, { x: 30, z: -345 }, { x: 118, z: -343 }],
        },
        {
          name: "塩田の巡回",
          roam: true,
          members: [{ kind: "grunt", x: -40, z: -480 }, { kind: "drone", x: -36, z: -482 }],
          patrol: [{ x: -40, z: -480 }, { x: 60, z: -480 }, { x: 60, z: -518 }, { x: -40, z: -518 }],
        },
      ] satisfies Squad[]
    ).map((sq) => placeSquad(sq, 0, 0)),
  );
export const SPAWN = { x: 0, z: 180, yaw: 0 };

export type RegionId = "reservoir" | "harbor";

/**
 * The regions a raid can drop into. Each holds its own POIs and ways off; the pass road
 * and the railway join them, so a raid may cross from one to the other on foot.
 */
export interface Region {
  id: RegionId;
  name: string;
  /** A line for the base's landing choice. */
  note: string;
  /** Where the drop starts, high over the region. */
  drop: { x: number; z: number; yaw: number };
  /** Open ground near the drop that the bot steers its fall to. */
  land: { x: number; z: number };
  pois: PoiId[];
  exits: ExtractId[];
}

export const REGIONS: Region[] = [
  { id: "reservoir", name: "ダム湖", note: "干上がったダム湖の島。拠点 4 つ、発着場にタイタン", drop: SPAWN, land: { x: 0, z: 106 }, pois: ["supply", "quarry", "relay", "pad"], exits: ["ship", "flare", "village"] },
  { id: "harbor", name: "港湾地帯", note: "干上がった湾の港。拠点 3 つ、どこにもヘビーがいる", drop: { x: 20, z: -296, yaw: 0 }, land: { x: 22, z: -306 }, pois: ["wreck", "yard", "smelter"], exits: ["boat"] },
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
    x: -170,
    z: 92,
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
    x: -185,
    z: -45,
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
    x: -70,
    z: 180,
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
    x: 95,
    z: 150,
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
    x: 180,
    z: 70,
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
    x: 170,
    z: -85,
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
    x: -170,
    z: -480,
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
    x: -175,
    z: -320,
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
    x: 190,
    z: -500,
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
    x: -30,
    z: -420,
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
    x: 175,
    z: -340,
    boxes: [
      ...building(-6, 0, 7, 6, 3.4, { doors: ["e", "n"], windows: ["s"], roof: "w" }),
      ...building(8, 4, 6, 6, 3.4, { doors: ["w"], windows: ["e"] }),
      box(0, -10, 8, 0.5, 1.15, "wall", 1),
    ],
    bins: [{ x: -6, z: 0, table: "smelter" }],
  },
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
    { x: -12, z: 172, table: "supply" },
    { x: -45, z: 70, y: 3.5, table: "supply" },
    { x: -2, z: 10, y: STOREY * 2, table: "quarry" },
    { x: 14, z: 11, y: STOREY * 2, table: "quarry" },
    { x: -2, z: 30, table: "quarry" },
    { x: 64, z: 49, table: "relay" },
    { x: 48, z: 39.3, y: 3.3, table: "relay" },
    { x: -56, z: -52, y: 7.2, table: "relay" },
    { x: 113, z: 14, y: STOREY, table: "relay" },
    { x: -114, z: -71, y: STOREY, table: "quarry" },
    // Top floor of each tall building, on the side away from its stairs. These hold the
    // flares that call the plateau pickup (EXTRACTS).
    ...HIGH_RISES.map((h) => ({ x: h.x - h.w / 2 + 1.5, z: h.z, y: (h.floors - 1) * STOREY, table: "relay" as const, flare: true as const })),
    // The harbor: the landing hut, the town's warehouse, the viaduct and the road under it,
    // a lone bin out on the salt flats, the saddle of the pass.
    { x: 14, z: -288, table: "yard" },
    { x: 56, z: -290, y: STOREY, table: "yard" },
    { x: 92, z: -350, y: LEVEL.rail, table: "smelter" },
    { x: 60, z: -355, table: "smelter" },
    { x: -20, z: -505, table: "wreck" },
    { x: -62, z: -220, table: "yard" },
    // The lighthouse's top floor, like the high-rises', holds a flare.
    { x: LIGHTHOUSE.x - 2.5, z: LIGHTHOUSE.z + 0.5, y: (LIGHTHOUSE.floors - 1) * STOREY, table: "wreck", flare: true },
  ] satisfies ExtraBin[]
)
  .map((b): ExtraBin => onFloor(b))
  .concat(HAMLETS.flatMap((h) => h.bins));


/**
 * The beached cargo ship, in its own frame: a three-storey hull lying east to west on the
 * old bay floor, holed on both sides of its hold, with stairs inside at its stern (east)
 * end up to the main deck, a three-storey bridge house on the deck with its own stairs,
 * a funnel and two masts. The pointed bow is solid.
 */
function wreck(): Box[] {
  const hull = paint(
    tower(0, 0, 84, 16, 3, { doors: [["s", "n"], [], []], windows: [["e"], ["n", "s"], ["n", "s"]] }),
    "wall",
    "steel",
    (b) => (b.y0 < STOREY ? 1 : 0),
  );
  const out: Box[] = [...hull];
  // Bulkheads across the hold and the decks above, each with a door in the middle.
  for (const x of [-21, 14])
    for (let k = 0; k < 3; k++) {
      const y0 = k * STOREY;
      out.push(box(x, -4.5, 0.35, 6.3, y0 + STOREY - 0.3, "steel", 2, y0), box(x, 4.5, 0.35, 6.3, y0 + STOREY - 0.3, "steel", 2, y0));
      out.push(box(x, 0, 0.35, 2.7, y0 + STOREY - 0.3, "steel", 2, y0 + 2.5));
    }
  // The bow, narrowing in steps to a point, and a blunt stern.
  out.push(box(-44.5, 0, 5, 13, SHIP_DECK + 0.7, "steel", 1), box(-49, 0, 4, 9, SHIP_DECK + 1, "steel", 1), box(-52.5, 0, 3, 4.6, SHIP_DECK + 1.3, "steel", 1));
  out.push(box(43.5, 0, 3, 14, SHIP_DECK, "steel", 1));
  // The bridge house and the funnel behind it.
  const house = tower(30, 0, 12, 12, 3, { doors: [["w", "s"]], windows: [["n"], ["n", "s", "w"], ["n", "s", "w", "e"]] });
  out.push(...lift(SHIP_DECK, house));
  out.push(box(39, 0, 3, 4, SHIP_DECK + 14, "steel", 3, SHIP_DECK), box(39, 0, 3.2, 4.2, SHIP_DECK + 15, "steel", 1, SHIP_DECK + 14));
  // Cargo hatches on the deck (cover up there), two masts with their cross-trees.
  out.push(box(-28, 0, 7, 8, SHIP_DECK + 0.9, "steel", 2, SHIP_DECK), box(-12, 0, 7, 8, SHIP_DECK + 0.9, "steel", 2, SHIP_DECK));
  for (const x of [-20, -2]) out.push(box(x, 0, 0.6, 0.6, SHIP_DECK + 12, "steel", 2, SHIP_DECK), box(x, 0, 0.4, 7, SHIP_DECK + 10.4, "steel", 2, SHIP_DECK + 10));
  // In the hold: a container and crates that came loose.
  out.push(box(-31, -3, 6.2, 2.5, 2.6, "container", 0), box(21.5, -3.5, 2.5, 6.2, 2.6, "container", 1), box(-14, 3, 1.2, 1.2, 0.9, "crate"), box(-15.2, 3, 1.2, 1.2, 1.8, "crate"), box(5, -5, 1.2, 1.2, 0.9, "crate"));
  // A container fallen onto the deck, and the plates torn out round the breach.
  out.push(box(-38, 4.5, 6.2, 2.5, SHIP_DECK + 2.6, "container", 2, SHIP_DECK));
  out.push(box(3.8, 10, 2, 1.4, 1.0, "rock", 1), box(-4.2, 10.6, 1.6, 1.2, 0.7, "rock"));
  return out;
}

/** Container stacks in the yard: per row, the heights of the stacks along it (0 = an alley). */
const YARD_X = [-36.2, -29.8, -23.4, -14.2, -7.8, 7.8, 14.2, 23.4, 29.8, 36.2];
const YARD_ROWS: [number, number[]][] = [
  [-18, [2, 3, 2, 1, 2, 2, 3, 1, 2, 3]],
  [-9, [1, 2, 3, 2, 1, 1, 2, 3, 2, 1]],
  [9, [3, 2, 1, 2, 2, 1, 2, 2, 3, 2]],
  [18, [2, 1, 2, 3, 2, 2, 1, 2, 2, 3]],
];

/**
 * The container yard, in its own frame: four rows of stacked containers with an aisle
 * down the middle and alleys across, and a gantry crane over the aisle. One leg of the
 * crane is a stair tower to the catwalk along its top; the driver's cab sits on the
 * catwalk, and a boom runs over all of it.
 */
function yard(): Box[] {
  const out: Box[] = [];
  YARD_ROWS.forEach(([z, heights], r) =>
    heights.forEach((n, i) => {
      for (let k = 0; k < n; k++) out.push(box(YARD_X[i], z, 6.2, 2.5, 2.6 * (k + 1), "container", (r + i + k) % 3, 2.6 * k));
    }),
  );
  out.push(...paint(tower(0, -22, 8, 8, 4, { doors: [["e", "w"]], windows: [[], ["e"], ["w"], ["e", "w"]], open: ["s"] }), "wall", "steel", () => 0, (b) => b.tint === 0));
  // The catwalk from the tower's roof to the far leg, railed both sides, round the cab.
  out.push(rect(-1.2, -18, 1.2, 22, CRANE - 0.3, CRANE, "slab", 1));
  // Railings knee-high, so the catwalk's guard is seen from the yard below.
  for (const [z0, z1] of [[-18, 4], [9, 22]] as const) out.push(rect(-1.25, z0, -1.0, z1, CRANE, CRANE + 0.5, "steel", 0), rect(1.0, z0, 1.25, z1, CRANE, CRANE + 0.5, "steel", 0));
  out.push(rect(-2.5, 4, 2.5, 9, CRANE - 0.3, CRANE, "slab", 1));
  out.push(...walls(0, 6.5, 5, 5, CRANE, CRANE + 2.5, ["n", "s"], ["e", "w"]).map((b) => ({ ...b, kind: "steel" as const, tint: 3 })));
  out.push(rect(-2.5, 4, 2.5, 9, CRANE + 2.5, CRANE + 2.8, "slab", 1));
  out.push(box(0, 23.5, 3, 3, CRANE, "steel", 0));
  out.push(box(0, 6, 1.4, 70, CRANE + 4.4, "steel", 0, CRANE + 3.6));
  // The yard office, with stairs up to its roof.
  out.push(...building(-42, 2, 7, 6, 3.4, { doors: ["e", "s"], windows: ["n"], roof: "w" }));
  out.push(box(-30, 24, 1.2, 1.2, 0.9, "crate"), box(30, -25, 1.2, 1.2, 1.8, "crate"));
  return out;
}

/**
 * The smelter, in its own frame: two tall halls joined at roof height by a bridge, a
 * three-storey control block bridged to the second hall, and a chimney that can be
 * seen from anywhere in the harbor. The first hall has a catwalk inside and outside
 * stairs up to its roof, so the roofs make one high way across the works.
 */
function smelter(): Box[] {
  const H = STOREY * 3;
  const out: Box[] = [];
  out.push(...building(-18, -6, 20, 14, H, { doors: ["s", "w"], windows: ["n", "e"], roof: "s", open: ["e"] }));
  out.push(rect(-27.65, -12.65, -8.35, -10.65, 4.8, 5.1, "slab"), ...stairs(-12, -10.65, "s", 1.4, 5.1));
  out.push(box(-20, -4, 5, 5, 4.2, "steel", 2));
  out.push(...building(16, -6, 18, 14, H, { doors: ["s", "e"], windows: ["n", "w"], open: ["w", "e"] }));
  out.push(box(12, -9, 3, 3, 2.4, "steel", 2), box(20, -9, 3, 3, 2.4, "steel", 2));
  out.push(...tower(36, -6, 8, 8, 3, { doors: [["w", "s"]], windows: [["e"], ["n", "w", "s"], ["n", "w", "s"]], open: ["w"] }));
  // Roof bridges, railed.
  for (const [x0, x1] of [[-8, 7], [25, 32]] as const) out.push(bridge(x0, -7, x1, -5, H), rect(x0, -7, x1, -6.8, H, H + 0.8, "wall", 1), rect(x0, -5.2, x1, -5, H, H + 0.8, "wall", 1));
  // The chimney with its rusted top, and a pipe across to the first hall.
  out.push(box(-2, 12, 4, 4, 26, "tower"), box(-2, 12, 4.2, 4.2, 32, "steel", 0, 26));
  out.push(box(-2, 5.5, 1, 9, 8, "steel", 2, 7));
  // Slag heaps.
  out.push(box(-32, 16, 7, 5, 2.6, "rock", 1), box(-22, 22, 5, 4, 1.8, "rock"), box(26, 18, 6, 4, 2.2, "rock", 1));
  return out;
}

/** Everything built in the harbor and on the way there, outside the POIs. */
const HARBOR: Box[] = [
  ...onLevel(LEVEL.seabed, place(AT[4][0], AT[4][1], wreck())),
  ...onLevel(LEVEL.shore, place(AT[5][0], AT[5][1], yard())),
  ...onLevel(LEVEL.terrace, place(AT[6][0], AT[6][1], smelter())),
  // --- 港町: the landing hut, a warehouse with a roof to watch from, cottages, crates
  ...onLevel(LEVEL.shore, [
    ...building(14, -288, 6, 5, 3.4, { doors: ["s"], windows: ["e"], roof: "e" }),
    ...tower(60, -293, 16, 10, 2, { doors: [["s", "w"]], windows: [["e"], ["n", "e", "w"]] }),
    ...tower(-22, -308, 8, 8, 2, { doors: [["s", "e"]], windows: [["w"], ["n", "e", "w"]] }),
    ...building(30, -314, 8, 6, 3.4, { doors: ["n", "w"], windows: ["s"], roof: "e" }),
    ...building(92, -311, 7, 6, 3.4, { doors: ["n", "w"], windows: ["e"] }),
    box(-2, -315, 6.2, 2.5, 2.6, "container", 1),
    box(42, -290, 1.2, 1.2, 0.9, "crate"),
    box(43.2, -290, 1.2, 1.2, 1.8, "crate"),
    box(76, -306, 2.5, 6.2, 2.6, "container", 2),
  ]),
  // --- 岬: the lighthouse, banded red every other storey, its lantern on top, and the keeper's cottage
  ...onLevel(LEVEL.headland, [
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
  ]),
  // --- 峠: a ruined wall and a signpost on the saddle
  ...onLevel(LEVEL.pass, [box(-52.5, -219.5, 3.2, 0.6, 1.2, "wall", 1), box(-51, -221, 0.6, 2.4, 1.6, "wall", 1), box(-55, -216.5, 0.3, 0.3, 3.2, "steel", 2)]),
  // --- the station on the railway's north embankment: a canopy over the platform
  ...onLevel(LEVEL.rail, [
    box(125.6, -222, 0.3, 0.3, 3.2, "steel", 2),
    box(125.6, -234, 0.3, 0.3, 3.2, "steel", 2),
    rect(124, -236, 127, -220, 3.0, 3.25, "slab", 1),
    box(118.6, -228, 1.2, 1.2, 0.9, "crate"),
  ]),
  // --- the viaduct's pillars, standing on the road under it, and its stairs
  ...onLevel(LEVEL.shore, [
    ...Array.from({ length: 8 }, (_, i) => box(122, -262 - i * 12, 2.4, 1.6, LEVEL.rail - 0.3, "tower")),
    ...Array.from({ length: 15 }, (_, i) => box(-56 + i * 12, -350, 1.6, 2.4, LEVEL.rail - 0.3, "tower")),
    ...stairs(-62, -350, "w", 2.4, LEVEL.rail),
    ...stairs(125.5, -299.6, "s", 1.8, LEVEL.rail),
    // A carriage fallen from the line onto the road below.
    box(-30, -353.8, 12, 2.8, 3, "steel", 3),
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
export const DECKS: Deck[] = [{ x0: 120.2, z0: -201.5, x1: 123.8, z1: -178.5, y: LEVEL.rail }];

/**
 * The railway's decks: the bridge over the gorge on two piers, and the viaduct from the
 * north embankment out over the harbor (pillars and stairs in HARBOR), railed along its
 * length, with an abandoned carriage on it. They are not pressed flat: the gorge and the
 * road run under them, and their ends rest on the embankments.
 */
/**
 * A kerb along the quay's edge, knee high: walkers fighting round the boat's pickup point
 * cannot step off into the channel, where they could not climb out. The slipway east of it
 * stays open.
 */
const QUAY: Box[] = [rect(89, -583.2, 146, -582.6, -6.2, -2.3, "wall", 1)];

const RAILWAY: Box[] = [
  bridge(119.5, -208, 124.5, -172, LEVEL.rail),
  rect(119.5, -202, 119.8, -178, LEVEL.rail, LEVEL.rail + 1.2, "steel", 2),
  rect(124.2, -202, 124.5, -178, LEVEL.rail, LEVEL.rail + 1.2, "steel", 2),
  box(122, -185, 3, 2, LEVEL.rail - 0.3, "tower", 0, -9),
  box(122, -195, 3, 2, LEVEL.rail - 0.3, "tower", 0, -9),
  // The viaduct: north from the embankment, then west over the road to its end by the yard.
  bridge(119.5, -352.5, 124.5, -246, LEVEL.rail),
  bridge(-62, -352.5, 119.5, -347.5, LEVEL.rail),
  rect(124.5, -302, 126.6, -299.6, LEVEL.rail - 0.3, LEVEL.rail, "slab", 1),
  rect(119.5, -347.5, 119.75, -258, LEVEL.rail, LEVEL.rail + 0.9, "wall", 1),
  rect(124.25, -352.5, 124.5, -302, LEVEL.rail, LEVEL.rail + 0.9, "wall", 1),
  rect(124.25, -299.6, 124.5, -258, LEVEL.rail, LEVEL.rail + 0.9, "wall", 1),
  rect(-59, -352.5, 124.5, -352.25, LEVEL.rail, LEVEL.rail + 0.9, "wall", 1),
  rect(-59, -347.75, 119.5, -347.5, LEVEL.rail, LEVEL.rail + 0.9, "wall", 1),
  // Rails along the decks.
  ...[121.2, 122.8].flatMap((x) => [rect(x - 0.08, -205, x + 0.08, -175, LEVEL.rail, LEVEL.rail + 0.12, "steel", 2), rect(x - 0.08, -350, x + 0.08, -250, LEVEL.rail, LEVEL.rail + 0.12, "steel", 2)]),
  ...[-350.8, -349.2].map((z) => rect(-60, z - 0.08, 121, z + 0.08, LEVEL.rail, LEVEL.rail + 0.12, "steel", 2)),
  box(48, -350, 12, 2.6, LEVEL.rail + 3, "steel", 3, LEVEL.rail),
];

/** Everything placed by hand: POIs, districts, landmarks. */
const AUTHORED: Box[] = [
  ...HARBOR,
  ...HAMLETS.flatMap((h) => h.boxes),
  // --- 補給所: containers, an office with a roof, a two-storey warehouse, a lookout platform, a loading deck
  ...onLevel(LEVEL.shore, place(AT[0][0], AT[0][1], [
    box(-9, 46, 6.2, 2.5, 2.6, "container", 0),
    box(10, 55, 2.5, 6.2, 2.6, "container", 1),
    box(-3, 60, 1.2, 1.2, 0.9, "crate"),
    box(4.5, 44, 1.2, 1.2, 0.9, "crate"),
    box(5.7, 44, 1.2, 1.2, 1.8, "crate"),
    box(13, 41, 8, 0.6, 3.2, "wall"),
    box(16.7, 44.5, 0.6, 7.6, 3.2, "wall"),
    box(-14, 56, 0.6, 6, 2.2, "wall"),
    box(-6, 38, 4, 1.2, 1.1, "rock"),
    box(2, 52, 1.2, 1.2, 0.9, "crate"),
    ...building(-23, 48, 8, 10, 3.6, { doors: ["e", "s"], windows: ["n", "w"], roof: "s" }),
    ...tower(24, 50, 8, 8, 2, { doors: [["w", "s"]], windows: [["e"], ["n", "e", "w"]] }),
    box(18, 63, 3, 3, 3.0, "tower"),
    ...stairs(18, 64.5, "s", 1.4, 3.0),
    box(6, 30, 12, 5, 1.2, "tower"),
    ...stairs(2, 32.5, "s", 3, 1.2),
    ...stairs(10, 27.5, "n", 3, 1.2),
    // the landing zone: a hut with the first bin
    ...building(-12, 82, 6, 5, 3.4, { doors: ["n"], windows: ["e"], roof: "e" }),
    box(14, 76, 4, 3, 1.4, "rock"),
  ])),
  // --- 採掘場: rock shelves, terraces, a catwalk between two scaffold towers, a shed
  ...onLevel(LEVEL.pit, place(AT[1][0], AT[1][1], [
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
  ])),
  // --- 中継塔: a two-tier tower, a three-storey block, huts with roofs, containers around
  ...onLevel(LEVEL.mesa, place(AT[2][0], AT[2][1], [
    box(42, -28, 5, 5, 3.4, "tower", 1),
    box(41.5, -29, 3, 3, 5.0, "tower"),
    box(41.5, -25.8, 3, 0.6, 3.8, "step"),
    box(41.5, -26.4, 3, 0.6, 4.2, "step"),
    box(41.5, -27.0, 3, 0.6, 4.6, "step"),
    box(42, -24.9, 1.2, 1.2, 2.6, "crate"),
    box(43.2, -24.9, 1.2, 1.2, 1.8, "crate"),
    box(44.4, -24.9, 1.2, 1.2, 0.9, "crate"),
    box(31, -32, 2.5, 6.2, 2.6, "container", 1),
    box(53, -24, 2.5, 6.2, 2.6, "container", 2),
    box(40, -41, 6.2, 2.5, 2.6, "container", 0),
    box(36, -18, 1.2, 1.2, 0.9, "crate"),
    box(49, -33, 4, 0.6, 2.4, "wall"),
    ...building(30, -18, 6, 5, 3.4, { doors: ["e"], windows: ["s"], roof: "w" }),
    ...building(57, -37, 5, 6, 3.4, { doors: ["w"], roof: "n" }),
    ...tower(50, -12, 8, 8, 3, { doors: [["w", "s"]], windows: [["e"], ["n", "e", "w"], ["s", "e", "w"]] }),
  ])),
  // --- 発着場: open pad ringed by pillars, raised gantries, two control rooms
  ...onLevel(LEVEL.dam, place(AT[3][0], AT[3][1], [
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
    ...tower(-32, -60, 8, 8, 2, { doors: [["e", "s"]], windows: [["w"], ["n", "e", "w"]] }),
    ...tower(32, -60, 8, 8, 2, { doors: [["w", "s"]], windows: [["e"], ["n", "e", "w"]] }),
  ])),

  // --- 旧市街: a clock tower joined to two houses by bridges at 6.8 m, shops around two streets
  ...onLevel(LEVEL.lakebed, [
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
  ]),

  // --- tall buildings, seen from anywhere on the island
  ...HIGH_RISES.flatMap((h) => onLevel(h.level, highRise(h.x, h.z, h.w, h.d, h.floors))),

  // --- 尾根: a long ridge with stairs at both ends, cover on top
  ...onLevel(LEVEL.ridge, [
    box(-50, 70, 30, 6, 3.5, "rock"),
    ...stairs(-35, 70, "e", 2.4, 3.5, 1),
    ...stairs(-65, 70, "w", 2.4, 3.5, 1),
    box(-50, 67.4, 6, 0.4, 4.4, "wall", 1, 3.5),
    box(-42, 82, 5, 4, 2, "rock"),
    box(-58, 56, 4, 6, 1.6, "rock"),
  ]),

  // --- 台地: three terraces climbing to a lookout over the lakebed
  ...onLevel(LEVEL.shore, place(-6, 0, [
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
  ...onLevel(LEVEL.shore, [
    ...building(55, 45, 24, 14, 6, { doors: ["w", "s"], windows: ["n", "e"] }),
    rect(45, 38.35, 65, 40.35, 3.0, 3.3, "slab"),
    ...stairs(46, 40.35, "s", 1.4, 3.3),
    box(72, 38, 4, 4, 9, "tower", 1),
    box(72, 45, 4, 4, 9, "tower"),
    box(50, 58, 6.2, 2.5, 2.6, "container", 2),
    box(58, 60, 2.5, 6.2, 2.6, "container", 0),
    box(46, 64, 6.2, 2.5, 2.6, "container", 1),
    box(53, 63, 1.2, 1.2, 0.9, "crate"),
  ]),

  // --- 住宅地: two houses joined by a roof bridge, two cottages
  ...onLevel(LEVEL.mesa, [
    ...tower(100, 15, 8, 8, 2, { doors: [["s", "w"]], windows: [["e"], ["n", "w"]], open: ["e"] }),
    ...tower(114, 15, 8, 8, 2, { doors: [["s", "e"]], windows: [["w"], ["n", "e"]], open: ["w"] }),
    bridge(104, 14, 110, 16, STOREY * 2),
    ...building(98, 30, 6, 6, 3.4, { doors: ["n", "e"], windows: ["s"] }),
    ...building(112, 31, 7, 6, 3.4, { doors: ["w"], windows: ["e"], roof: "s" }),
    box(106, 40, 0.6, 6, 1.4, "wall"),
  ]),

  // --- 廃村: a two-storey house, two cottages and broken walls
  ...onLevel(LEVEL.shore, [
    ...tower(-112, -70, 8, 8, 2, { doors: [["e", "s"]], windows: [["w"], ["n", "e", "w"]] }),
    ...building(-105, -55, 7, 6, 3.4, { doors: ["e", "n"], roof: "s" }),
    ...building(-95, -68, 6, 6, 3.4, { doors: ["n", "w"], windows: ["e"] }),
    box(-100, -80, 7, 0.6, 1.6, "wall"),
    box(-118, -58, 0.6, 6, 1.2, "wall"),
  ]),
];

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
  for (const r of REGIONS) points.push({ x: r.drop.x, z: r.drop.z, r: 6 }, { x: r.land.x, z: r.land.z, r: 6 });
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
  { x0: WORLD.x0, x1: WORLD.x1, z0: -215, z1: WORLD.z1, seed: 7_331 },
  { x0: WORLD.x0, x1: WORLD.x1, z0: WORLD.z0, z1: -216, seed: 4_517 },
];
const SPARSE = "塩田";
/** The harbor's channel, which holds water: nothing is scattered in it. */
const WATER = "水路";
/** The ground between the basins and roads (terrain.ts). */
const BETWEEN = "野";
/** Where on the ground between the cover clumps: above 0.55 in blobs about a hundred metres across. */
const clump = (x: number, z: number) => 0.5 + 0.25 * Math.sin(x / 37 + 1.3) * Math.sin(z / 41 + 0.7) + 0.25 * Math.sin((x + z) / 53);

function scatterCover(authored: Box[], keep: Keep): Box[] {
  const placed: Box[] = [];
  for (const area of SCATTER) placed.push(...scatterArea(authored, keep, area, placed));
  return placed;
}

function scatterArea(authored: Box[], { points, segments }: Keep, area: (typeof SCATTER)[number], before: Box[]): Box[] {
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
          authored.every(clear(b, 3)) &&
          placed.every(clear(b, 2.5)) &&
          before.every(clear(b, 2.5)) &&
          points.every((q) => distToBox(b, q.x, q.z) > q.r) &&
          segments.every((sg) => {
            const n = Math.max(1, Math.ceil(Math.hypot(sg.bx - sg.ax, sg.bz - sg.az)));
            for (let k = 0; k <= n; k++) if (distToBox(b, sg.ax + ((sg.bx - sg.ax) * k) / n, sg.az + ((sg.bz - sg.az) * k) / n) < 2.5) return false;
            return true;
          }),
      );
      if (ok) placed.push(...piece);
    }
  return placed;
}

/**
 * The canyon bridge: two rock pillars standing on the spillway floor and a deck at
 * the mesa's level between the two bridge roads. They are not pressed flat: the
 * spillway runs under them.
 */
const BRIDGE: Box[] = [
  box(42, -95, 6, 6, LEVEL.mesa, "rock", 0, LEVEL.pit - 2),
  box(62, -95, 6, 6, LEVEL.mesa, "rock", 1, LEVEL.pit - 2),
  bridge(45, -96.2, 59, -93.8, LEVEL.mesa),
];

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

// The canyon floors pay for the detour: a bin under each bridge.
for (const [x, z, table] of [[55, -112, "relay"], [127, -192, "smelter"]] as const)
  EXTRA_BINS.push({ x, z, y: terrainHeight(x, z), table });

export const BOXES: Box[] = [...AUTHORED, ...BRIDGE, ...RAILWAY, ...QUAY, ...scatterCover([...AUTHORED, ...BRIDGE, ...RAILWAY, ...QUAY], KEEP)];

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
  // The tunnel under the mountains, straight from the landing pad's north side to the harbor town.
  const tx = 48;
  const tunnel: Carve = { name: "坑道", line: [[tx, -150], [tx, -268]], floor: 3, levels: [7.2, 1.2], slope: 2.4 };
  const tSouth = cliffFoot(tx, -150, -1);
  const tNorth = cliffFoot(tx, -268, 1);
  // The dam's inspection gallery: from the lakebed under the crest, up onto the crest and the pad behind it.
  const dx = 14;
  const dam: Carve = { name: "点検通路", line: [[dx, -62], [dx, -91]], floor: 2.5, levels: [LEVEL.lakebed, LEVEL.dam], slope: 2.4 };
  const dFoot = cliffFoot(dx, -54, -1);
  // The wreck's gangway: up the hull's north side to its main deck, near the bow.
  const deck = LEVEL.seabed + STOREY * 3;
  const gx = -22.4;
  const gz = -571.3;
  const gangway = paint(lift(LEVEL.seabed, stairs(gx, gz, "w", 2.0, deck + 0.7 - LEVEL.seabed)), "step", "steel", () => 2);
  return [
    {
      id: "tunnel",
      name: "山の坑道",
      tool: "charge",
      note: "発着場の東から山地を抜けて港町へ。峠道より短く、峠の登り降りもない",
      path: [{ x: tx, z: -146 }, { x: tx, z: -266 }],
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
      path: [{ x: dx, z: -54 }, { x: dx, z: -96 }],
      at: [{ x: dx, y: dFoot.y, z: dFoot.z + 2 }],
      carve: dam,
      closed: chainedGate(dx, dFoot, -1, 2.5),
      open: roofOver(dam, "wall", 0),
    },
    {
      id: "gangway",
      name: "難破船の舷梯",
      tool: "cutter",
      note: "難破船の北側から甲板へ直に上がる。船尾の階段を通らない",
      path: [{ x: gx - 15.5, z: gz }, { x: gx + 1.2, z: -567 }],
      at: [{ x: gx, y: LEVEL.seabed, z: gz - 1.4 }],
      // Hauled aboard and stood up against the deck's rail, over the place it lands, chained there.
      closed: [
        rect(gx - 1.0, -569.75, gx + 1.0, -569.45, deck, deck + 2.8, "steel", 2),
        rect(gx - 1.15, -569.45, gx + 1.15, -569.3, deck + 1.0, deck + 1.15, "steel", 2),
        rect(gx - 0.18, -569.3, gx + 0.18, -569.1, deck + 0.75, deck + 1.2, "steel", 0),
      ],
      // Its flight, and a landing over the deck's rail that steps down onto the deck.
      open: [...gangway, rect(gx, gz - 1.0, gx + 2.4, -569.45, deck + 0.4, deck + 0.7, "steel", 2)],
    },
  ];
})();

export const routeOf = (id: RouteId): Route => ROUTES.find((r) => r.id === id) ?? ROUTES[0];
