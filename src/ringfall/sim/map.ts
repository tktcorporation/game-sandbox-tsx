import type { EnemyKind, Rarity, WeaponKind } from "./config";

/**
 * The island. Everything solid is an axis-aligned box, so collision, line of sight
 * and standing on top are all the same cheap test. North is -z. The player drops
 * in from the south, clears the four POIs counter-clockwise, and extracts in the
 * north. The districts between them are optional: high ground, loot and squads.
 */

export type BoxKind = "crate" | "container" | "wall" | "rock" | "pad" | "tower" | "slab" | "step";

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
}

/**
 * A one-room building of height H: walls with door and window openings, a flat roof
 * slab, a low parapet around the roof, and optional outside stairs up to it.
 */
function building(cx: number, cz: number, w: number, d: number, H: number, o: BuildingOpts = {}): Box[] {
  const out = walls(cx, cz, w, d, 0, H - 0.3, o.doors, o.windows);
  out.push(box(cx, cz, w, d, H, "slab", 0, H - 0.3));
  out.push(...parapet(cx, cz, w, d, H, o.roof ? [o.roof] : []));
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

/** Tall buildings: where they stand, their size and storeys. Their top-floor bins are in EXTRA_BINS. */
const HIGH_RISES = [
  { x: 0, z: -14, w: 10, d: 10, floors: 6 }, // the old town's office block
  { x: 125, z: 0, w: 10, d: 10, floors: 5 }, // flats beyond the housing street
  { x: 40, z: -130, w: 8, d: 8, floors: 5 }, // the pad's control tower
  { x: -130, z: 40, w: 8, d: 8, floors: 4 }, // a lookout west of the quarry
  { x: -79, z: 28, w: 8, d: 8, floors: 4 }, // the quarry office
] as const;

/** A walkway slab whose top is at height y. */
const bridge = (x0: number, z0: number, x1: number, z1: number, y: number): Box => rect(x0, z0, x1, z1, y - 0.3, y, "slab", 1);

/** Moves boxes authored in a district's own frame into place. */
const place = (dx: number, dz: number, boxes: Box[]): Box[] => boxes.map((b) => ({ ...b, x0: b.x0 + dx, x1: b.x1 + dx, z0: b.z0 + dz, z1: b.z1 + dz }));

/** One robot of a squad, placed on the island from the start. */
export interface Member {
  kind: EnemyKind;
  x: number;
  z: number;
  /** Floor height it stands on (a roof, a platform); 0 = ground. */
  y?: number;
  /** Direction it watches while idle (yaw, 0 = north / -z). */
  face?: number;
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
}

export type LootTable = { weapon: [WeaponKind, Rarity][]; armor: Rarity[]; batteries: number };

export interface Poi {
  name: string;
  x: number;
  z: number;
  /** The objective banner shows when the player comes this close. */
  trigger: number;
  /** The ring closes to this radius around the POI. */
  ring: number;
  /** Where the player restarts after a wipe here. */
  entry: { x: number; z: number; yaw: number };
  /** Clearing the POI means beating every one of these squads. */
  squads: Squad[];
  bins: { x: number; z: number; y?: number }[];
  loot: LootTable;
  floor: { x: number; z: number; y?: number; weapon?: [WeaponKind, Rarity]; armor?: Rarity; battery?: true }[];
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


/** Moves a squad authored in a district's own frame into place. */
function placeSquad(sq: Squad, dx: number, dz: number): Squad {
  return { ...sq, members: sq.members.map((m) => ({ ...m, x: m.x + dx, z: m.z + dz })), patrol: sq.patrol?.map((p) => ({ x: p.x + dx, z: p.z + dz })) };
}

function placePoi(p: Poi, [dx, dz]: readonly [number, number]): Poi {
  const at = <T extends { x: number; z: number }>(q: T): T => ({ ...q, x: q.x + dx, z: q.z + dz });
  return {
    ...p,
    x: p.x + dx,
    z: p.z + dz,
    entry: at(p.entry),
    squads: p.squads.map((sq) => placeSquad(sq, dx, dz)),
    bins: p.bins.map(at),
    floor: p.floor.map(at),
    carePackage: p.carePackage && at(p.carePackage),
  };
}

/**
 * Each POI is written in its own frame (its data and its boxes below) and moved
 * into place by this offset.
 */
const AT = [
  [0, 50],
  [-49, 8],
  [48, -7],
  [0, -52],
] as const;

const POI_FRAMES: Poi[] = [
  {
    name: "補給所",
    x: 0,
    z: 50,
    trigger: 24,
    ring: 70,
    entry: { x: 0, z: 74, yaw: 0 },
    squads: [
      { name: "見張り台", members: [{ kind: "grunt", x: 18, z: 63, y: 3, face: S }] },
      { name: "倉庫の中", members: [{ kind: "grunt", x: 25, z: 52, face: W }] },
      { name: "管理棟", members: [{ kind: "grunt", x: -23, z: 50, face: E }] },
      { name: "荷台", members: [{ kind: "grunt", x: 6, z: 30, y: 1.2, face: S }] },
      { name: "塀の裏", members: [{ kind: "charger", x: -16, z: 56, face: E }] },
      { name: "巡回ドローン", members: [{ kind: "drone", x: -6, z: 36 }], patrol: [{ x: -6, z: 36 }, { x: 14, z: 36 }, { x: 22, z: 44 }, { x: 0, z: 42 }] },
    ],
    bins: [
      { x: -2, z: 54 },
      { x: 7, z: 61 },
      { x: -11, z: 41 },
      { x: -23, z: 47 },
      { x: 22, z: 52, y: STOREY },
    ],
    loot: { weapon: [["hornet", 1], ["maul", 0], ["lance", 0], ["pike", 1]], armor: [1], batteries: 1 },
    floor: [
      { x: 3, z: 66, weapon: ["hornet", 0] },
      { x: -4, z: 66, battery: true },
      { x: -24, z: 49, y: 3.6, armor: 1 },
      { x: 25, z: 50, y: STOREY * 2, battery: true },
    ],
  },
  {
    name: "採掘場",
    x: -46,
    z: 2,
    trigger: 26,
    ring: 55,
    entry: { x: -18, z: 30, yaw: -0.8 },
    squads: [
      { name: "鉄骨の足場", members: [{ kind: "grunt", x: -52, z: -15, y: 4, face: SE }] },
      { name: "採掘穴", members: [{ kind: "charger", x: -46, z: 4, face: SE }] },
      { name: "段丘", members: [{ kind: "grunt", x: -63, z: -8, y: 2.4, face: E }] },
      { name: "作業小屋", members: [{ kind: "grunt", x: -62, z: 25, face: E }] },
      { name: "西の段丘", members: [{ kind: "grunt", x: -72, z: 3, y: 3, face: E }] },
      { name: "巡回ドローン", members: [{ kind: "drone", x: -48, z: 12 }], patrol: [{ x: -48, z: 12 }, { x: -34, z: 12 }, { x: -30, z: 0 }, { x: -44, z: -6 }] },
    ],
    bins: [
      { x: -37, z: 8 },
      { x: -54, z: -4 },
      { x: -46, z: 14 },
      { x: -73, z: -4, y: 5.5 },
    ],
    loot: { weapon: [["pike", 2], ["maul", 1], ["lance", 1], ["hornet", 2]], armor: [2], batteries: 2 },
    floor: [{ x: -45, z: -15, y: 4, battery: true }],
    carePackage: { x: -46, z: 0, weapon: ["lance", 3] },
  },
  {
    name: "中継塔",
    x: 42,
    z: -28,
    trigger: 27,
    ring: 55,
    entry: { x: 22, z: -6, yaw: -0.85 },
    squads: [
      { name: "中継塔", members: [{ kind: "grunt", x: 41.5, z: -29, y: 5, face: SW }] },
      { name: "コンテナ置き場", members: [{ kind: "heavy", x: 36, z: -36, face: SW }] },
      { name: "西の小屋", members: [{ kind: "grunt", x: 30, z: -18, y: 3.4, face: SW }] },
      { name: "東の小屋", members: [{ kind: "grunt", x: 57, z: -36, face: W }] },
      { name: "3 階建ての 1 階", members: [{ kind: "grunt", x: 49, z: -10, face: W }] },
      { name: "通路の番", members: [{ kind: "charger", x: 34, z: -26, face: SW }] },
    ],
    bins: [
      { x: 33, z: -22 },
      { x: 50, z: -36 },
      { x: 44, z: -16 },
      { x: 48, z: -10, y: STOREY * 2 },
    ],
    loot: { weapon: [["pike", 3], ["hornet", 2], ["maul", 2], ["lance", 2]], armor: [2, 3], batteries: 2 },
    floor: [
      { x: 41.5, z: -29, y: 5, weapon: ["lance", 2] },
      { x: 50, z: -12, y: STOREY * 3, armor: 2 },
    ],
  },
  {
    name: "発着場",
    x: 0,
    z: -68,
    trigger: 28,
    ring: 46,
    entry: { x: 12, z: -40, yaw: 0.35 },
    squads: [{ name: "タイタン", members: [{ kind: "titan", x: 0, z: -76, face: S }, { kind: "drone", x: -8, z: -70 }, { kind: "drone", x: 8, z: -70 }] }],
    bins: [
      { x: -16, z: -56 },
      { x: 16, z: -56 },
      { x: -32, z: -60, y: STOREY },
      { x: 32, z: -60, y: STOREY },
    ],
    loot: { weapon: [], armor: [3], batteries: 2 },
    floor: [],
    boss: true,
  },
];

export const POIS: Poi[] = POI_FRAMES.map((p, i) => placePoi(p, AT[i]));

export const EXTRACT = { x: AT[3][0], z: -84 + AT[3][1], radius: 5 };

/** Squads between the POIs. Beating them is optional; they guard loot and high ground. */
export const ROAMERS: Squad[] = [
  { name: "時計塔", members: [{ kind: "grunt", x: 0, z: 13, y: STOREY * 3, face: S }] },
  { name: "旧市街の見回り", members: [{ kind: "grunt", x: -7, z: 20, face: E }], patrol: [{ x: 7, z: 20 }, { x: 7, z: 2 }, { x: -7, z: 2 }, { x: -7, z: 20 }] },
  { name: "商店", members: [{ kind: "charger", x: -14, z: 25, face: E }] },
  { name: "尾根の狙撃手", members: [{ kind: "grunt", x: -50, z: 70.5, y: 3.5, face: E }] },
  { name: "台地の見張り", members: [{ kind: "grunt", x: -52, z: -54, y: 7.2, face: E }] },
  { name: "工場の警備", members: [{ kind: "heavy", x: 55, z: 46, face: S }] },
  { name: "住宅地", members: [{ kind: "grunt", x: 99, z: 16, y: STOREY * 2, face: W }] },
  { name: "廃村", members: [{ kind: "grunt", x: -112, z: -69, y: STOREY * 2, face: E }] },
  { name: "橋の上", members: [{ kind: "grunt", x: 52, z: -95, y: 6, face: N }] },
];
export const SPAWN = { x: 0, z: 140, yaw: 0 };

/** Bins outside the POIs, mostly up high. `table` is the POI whose loot table they use. */
export const EXTRA_BINS: { x: number; z: number; y?: number; table: number }[] = [
  { x: -12, z: 132, table: 0 },
  { x: -45, z: 70, y: 3.5, table: 0 },
  { x: -2, z: 10, y: STOREY * 2, table: 1 },
  { x: 14, z: 11, y: STOREY * 2, table: 1 },
  { x: -2, z: 30, table: 1 },
  { x: 64, z: 49, table: 2 },
  { x: 48, z: 39.3, y: 3.3, table: 2 },
  { x: -50, z: -52, y: 7.2, table: 2 },
  { x: 113, z: 14, y: STOREY, table: 2 },
  { x: -114, z: -71, y: STOREY, table: 1 },
  // Top floor of each tall building, on the side away from its stairs.
  ...HIGH_RISES.map((h) => ({ x: h.x - h.w / 2 + 1.5, z: h.z, y: (h.floors - 1) * STOREY, table: 2 })),
];

/** Everything placed by hand: POIs, districts, landmarks. */
const AUTHORED: Box[] = [
  // --- 補給所: containers, an office with a roof, a two-storey warehouse, a lookout platform, a loading deck
  ...place(AT[0][0], AT[0][1], [
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
  ]),
  // --- 採掘場: rock shelves, terraces, a catwalk between two scaffold towers, a shed
  ...place(AT[1][0], AT[1][1], [
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
  ]),
  // --- 中継塔: a two-tier tower, a three-storey block, huts with roofs, containers around
  ...place(AT[2][0], AT[2][1], [
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
  ]),
  // --- 発着場: open pad ringed by pillars, raised gantries, two control rooms
  ...place(AT[3][0], AT[3][1], [
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
  ]),

  // --- 旧市街: a clock tower joined to two houses by bridges at 6.8 m, shops around two streets
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

  // --- tall buildings, seen from anywhere on the island
  ...HIGH_RISES.flatMap((h) => highRise(h.x, h.z, h.w, h.d, h.floors)),

  // --- 尾根: a long ridge with stairs at both ends, cover on top
  box(-50, 70, 30, 6, 3.5, "rock"),
  ...stairs(-35, 70, "e", 2.4, 3.5, 1),
  ...stairs(-65, 70, "w", 2.4, 3.5, 1),
  box(-50, 67.4, 6, 0.4, 4.4, "wall", 1, 3.5),
  box(-42, 82, 5, 4, 2, "rock"),
  box(-58, 56, 4, 6, 1.6, "rock"),

  // --- 台地: three terraces climbing to a lookout over the south-west
  box(-45, -50, 34, 26, 2.4, "rock"),
  box(-48, -52, 20, 14, 4.8, "rock", 1),
  box(-52, -54, 8, 8, 7.2, "rock"),
  ...stairs(-28, -45, "e", 3, 2.4, 1),
  ...stairs(-40, -63, "n", 3, 2.4, 1),
  ...stairs(-38, -49, "e", 2, 4.8, 1, 2.4),
  ...stairs(-48, -52, "e", 1.6, 7.2, 1, 4.8),
  box(-52, -57.6, 8, 0.4, 8.2, "wall", 1, 7.2),

  // --- 工場: a hall with a catwalk inside, two silos, a container yard
  ...building(55, 45, 24, 14, 6, { doors: ["w", "s"], windows: ["n", "e"] }),
  rect(45, 38.35, 65, 40.35, 3.0, 3.3, "slab"),
  ...stairs(46, 40.35, "s", 1.4, 3.3),
  box(72, 38, 4, 4, 9, "tower", 1),
  box(72, 45, 4, 4, 9, "tower"),
  box(50, 58, 6.2, 2.5, 2.6, "container", 2),
  box(58, 60, 2.5, 6.2, 2.6, "container", 0),
  box(46, 64, 6.2, 2.5, 2.6, "container", 1),
  box(53, 63, 1.2, 1.2, 0.9, "crate"),

  // --- 峡谷の橋: two rock pillars joined by a bridge at 6 m
  box(42, -95, 6, 6, 6, "rock"),
  box(62, -95, 6, 6, 6, "rock", 1),
  bridge(45, -96.2, 59, -93.8, 6),
  ...stairs(42, -92, "s", 2, 6, 1),
  ...stairs(62, -98, "n", 2, 6, 1),

  // --- 住宅地: two houses joined by a roof bridge, two cottages
  ...tower(100, 15, 8, 8, 2, { doors: [["s", "w"]], windows: [["e"], ["n", "w"]], open: ["e"] }),
  ...tower(114, 15, 8, 8, 2, { doors: [["s", "e"]], windows: [["w"], ["n", "e"]], open: ["w"] }),
  bridge(104, 14, 110, 16, STOREY * 2),
  ...building(98, 30, 6, 6, 3.4, { doors: ["n", "e"], windows: ["s"] }),
  ...building(112, 31, 7, 6, 3.4, { doors: ["w"], windows: ["e"], roof: "s" }),
  box(106, 40, 0.6, 6, 1.4, "wall"),

  // --- 廃村: a two-storey house, two cottages and broken walls
  ...tower(-112, -70, 8, 8, 2, { doors: [["e", "s"]], windows: [["w"], ["n", "e", "w"]] }),
  ...building(-105, -55, 7, 6, 3.4, { doors: ["e", "n"], roof: "s" }),
  ...building(-95, -68, 6, 6, 3.4, { doors: ["n", "w"], windows: ["e"] }),
  box(-100, -80, 7, 0.6, 1.6, "wall"),
  box(-118, -58, 0.6, 6, 1.2, "wall"),

  // --- open ground: rocks for cover on the long walks
  box(-60, -10, 6, 4, 2.2, "rock"),
  box(-35, 5, 5, 5, 3, "rock"),
  box(35, -10, 4, 6, 1.8, "rock"),
  box(30, 15, 5, 3, 2.4, "rock"),
  box(-25, 45, 3, 6, 1.6, "rock"),
  box(25, 70, 4, 3, 1.4, "rock"),
  box(-20, -30, 6, 5, 3.2, "rock"),
  box(20, -60, 5, 4, 2.6, "rock"),
  box(-30, -90, 6, 5, 3, "rock"),
  box(80, 5, 5, 5, 3, "rock"),
  box(-100, 60, 5, 4, 2.4, "rock"),
  box(-110, -40, 6, 4, 2.6, "rock"),
  box(110, -90, 5, 5, 3, "rock"),
  box(-90, -100, 6, 6, 3, "rock"),
];

/**
 * Cover scattered over the open ground so that a fight is mostly about breaking
 * line of sight and coming back from another side. Pieces are placed on a jittered
 * grid from a fixed seed, and a candidate is dropped when it would crowd a building,
 * another piece, or any authored point (robot posts, patrol routes, bins, entries).
 */
function scatterCover(authored: Box[]): Box[] {
  let seed = 7_331;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)];

  const points: { x: number; z: number; r: number }[] = [];
  const segments: { ax: number; az: number; bx: number; bz: number }[] = [];
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
  points.push({ x: EXTRACT.x, z: EXTRACT.z, r: 10 });

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
  const placed: Box[] = [];
  const edge = 140;
  for (let gx = -edge; gx <= edge; gx += 12)
    for (let gz = -edge; gz <= edge; gz += 12) {
      const x = gx + (rnd() - 0.5) * 7;
      const z = gz + (rnd() - 0.5) * 7;
      const piece = pieceAt(x, z);
      const ok = piece.every(
        (b) =>
          authored.every(clear(b, 3)) &&
          placed.every(clear(b, 2.5)) &&
          points.every((q) => distToBox(b, q.x, q.z) > q.r) &&
          segments.every((sg) => {
            const n = Math.max(1, Math.ceil(Math.hypot(sg.bx - sg.ax, sg.bz - sg.az)));
            for (let k = 0; k <= n; k++) if (distToBox(b, sg.ax + ((sg.bx - sg.ax) * k) / n, sg.az + ((sg.bz - sg.az) * k) / n) < 2.5) return false;
            return true;
          }) &&
          Math.max(Math.abs(b.x0), Math.abs(b.x1), Math.abs(b.z0), Math.abs(b.z1)) < WORLD_EDGE,
      );
      if (ok) placed.push(...piece);
    }
  return placed;
}

/** Scattered cover stays this far inside the playable square. */
const WORLD_EDGE = 146;

export const BOXES: Box[] = [...AUTHORED, ...scatterCover(AUTHORED)];
