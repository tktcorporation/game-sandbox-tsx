import type { EnemyKind, Rarity, WeaponKind } from "./config";

/**
 * The island. Everything solid is an axis-aligned box standing on the ground, so
 * collision, line of sight and standing on top are all the same cheap test.
 * North is -z. The player drops in from the south and fights northward.
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

/** n = -z, s = +z, e = +x, w = -x. */
type Side = "n" | "s" | "e" | "w";
const DIR: Record<Side, [number, number]> = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] };

/**
 * Steps from the ground up to a platform edge at height `top`. (ex, ez) is the centre
 * of the edge; the stairs run away from it toward `away`. Each riser is at most 0.42 m,
 * under the step-up height, so they are walked, not jumped.
 */
function stairs(ex: number, ez: number, away: Side, width: number, top: number, tint = 0): Box[] {
  const n = Math.ceil(top / 0.42) - 1;
  const depth = 0.55;
  const [dx, dz] = DIR[away];
  const out: Box[] = [];
  for (let k = 0; k < n; k++) {
    const h = (top * (n - k)) / (n + 1);
    const c = (k + 0.5) * depth;
    if (dz !== 0) out.push(box(ex, ez + dz * c, width, depth, h, "step", tint));
    else out.push(box(ex + dx * c, ez, depth, width, h, "step", tint));
  }
  return out;
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
  const t = 0.35;
  const top = H - 0.3;
  const out: Box[] = [];
  const sides: Side[] = ["n", "s", "e", "w"];
  for (const side of sides) {
    const alongX = side === "n" || side === "s";
    const len = alongX ? w : d;
    const holes: { a: number; b: number; door: boolean }[] = [];
    if (o.doors?.includes(side)) holes.push({ a: -1.1, b: 1.1, door: true });
    if (o.windows?.includes(side)) {
      const off = o.doors?.includes(side) ? len * 0.32 : len * 0.25;
      for (const sg of [-1, 1]) holes.push({ a: sg * off - 0.7, b: sg * off + 0.7, door: false });
    }
    holes.sort((p, q) => p.a - q.a);
    // Wall piece spanning [a, b] along the side, from y0 to y1.
    const piece = (a: number, b: number, y0: number, y1: number) => {
      const mid = (a + b) / 2;
      const span = b - a;
      if (span <= 0.01 || y1 - y0 <= 0.01) return;
      const [x, z] = alongX ? [cx + mid, side === "n" ? cz - d / 2 + t / 2 : cz + d / 2 - t / 2] : [side === "w" ? cx - w / 2 + t / 2 : cx + w / 2 - t / 2, cz + mid];
      out.push(alongX ? box(x, z, span, t, y1, "wall", 0, y0) : box(x, z, t, span, y1, "wall", 0, y0));
    };
    let cur = -len / 2;
    for (const hole of holes) {
      piece(cur, hole.a, 0, top);
      if (hole.door) piece(hole.a, hole.b, 2.5, top);
      else {
        piece(hole.a, hole.b, 0, 1.1);
        piece(hole.a, hole.b, 2.1, top);
      }
      cur = hole.b;
    }
    piece(cur, len / 2, 0, top);
  }
  out.push(box(cx, cz, w, d, H, "slab", 0, top));
  for (const side of sides) {
    if (side === o.roof) continue;
    if (side === "n") out.push(box(cx, cz - d / 2 + 0.12, w, 0.25, H + 0.7, "wall", 1, H));
    if (side === "s") out.push(box(cx, cz + d / 2 - 0.12, w, 0.25, H + 0.7, "wall", 1, H));
    if (side === "e") out.push(box(cx + w / 2 - 0.12, cz, 0.25, d, H + 0.7, "wall", 1, H));
    if (side === "w") out.push(box(cx - w / 2 + 0.12, cz, 0.25, d, H + 0.7, "wall", 1, H));
  }
  if (o.roof) {
    const r = o.roof;
    if (r === "n" || r === "s") out.push(...stairs(cx + w / 2 - 1.0, r === "n" ? cz - d / 2 : cz + d / 2, r, 1.4, H));
    else out.push(...stairs(r === "e" ? cx + w / 2 : cx - w / 2, cz + d / 2 - 1.0, r, 1.4, H));
  }
  return out;
}

export interface WaveSpawn {
  kind: EnemyKind;
  /** Offset from the POI centre. */
  dx: number;
  dz: number;
  /** Height of the floor it spawns on (a roof, a platform); 0 = ground. */
  y?: number;
}

export type LootTable = { weapon: [WeaponKind, Rarity][]; armor: Rarity[]; batteries: number };

export interface Poi {
  name: string;
  x: number;
  z: number;
  /** The fight starts when the player comes this close. */
  trigger: number;
  /** The ring closes to this radius around the POI. */
  ring: number;
  /** Where the player restarts after a wipe here. */
  entry: { x: number; z: number; yaw: number };
  waves: WaveSpawn[][];
  bins: { x: number; z: number; y?: number }[];
  loot: LootTable;
  floor: { x: number; z: number; y?: number; weapon?: [WeaponKind, Rarity]; armor?: Rarity; battery?: true }[];
  carePackage?: { x: number; z: number; weapon: [WeaponKind, Rarity] };
  boss?: true;
}

const ring = (n: number, r: number, start: number, kinds: EnemyKind[]): WaveSpawn[] =>
  kinds.slice(0, n).map((kind, i) => {
    const a = start + (i / n) * Math.PI * 2;
    return { kind, dx: Math.cos(a) * r, dz: Math.sin(a) * r };
  });

export const POIS: Poi[] = [
  {
    name: "補給所",
    x: 0,
    z: 50,
    trigger: 24,
    ring: 60,
    entry: { x: 0, z: 74, yaw: 0 },
    waves: [
      ring(4, 13, -2.4, ["grunt", "drone", "grunt", "drone"]),
      ring(5, 15, -0.6, ["charger", "drone", "grunt", "charger", "drone"]),
      [...ring(4, 14, 0.9, ["grunt", "drone", "charger", "drone"]), { kind: "grunt", dx: 18, dz: 13, y: 3 }],
    ],
    bins: [
      { x: -2, z: 54 },
      { x: 7, z: 61 },
      { x: -11, z: 41 },
      { x: -23, z: 47 },
    ],
    loot: { weapon: [["hornet", 1], ["maul", 0], ["lance", 0], ["pike", 1]], armor: [1], batteries: 1 },
    floor: [
      { x: 3, z: 66, weapon: ["hornet", 0] },
      { x: -4, z: 66, battery: true },
      { x: -24, z: 49, y: 3.6, armor: 1 },
    ],
  },
  {
    name: "採掘場",
    x: -46,
    z: 2,
    trigger: 26,
    ring: 42,
    entry: { x: -18, z: 30, yaw: -0.8 },
    waves: [
      ring(5, 14, -1.2, ["grunt", "drone", "grunt", "grunt", "drone"]),
      [...ring(5, 15, 0.3, ["charger", "grunt", "charger", "drone", "charger"]), { kind: "grunt", dx: 8, dz: -17, y: 4 }],
      [...ring(5, 13, 1.5, ["grunt", "drone", "charger", "grunt", "drone"]), { kind: "grunt", dx: -17, dz: -10, y: 2.4 }],
    ],
    bins: [
      { x: -37, z: 8 },
      { x: -54, z: -4 },
      { x: -46, z: 14 },
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
    ring: 40,
    entry: { x: 22, z: -6, yaw: -0.85 },
    waves: [
      ring(6, 15, 2.4, ["grunt", "drone", "heavy", "grunt", "drone", "grunt"]),
      ring(7, 15, 1.2, ["charger", "drone", "heavy", "charger", "drone", "grunt", "charger"]),
      [...ring(6, 14, 0.2, ["heavy", "drone", "grunt", "drone", "charger", "grunt"]), { kind: "grunt", dx: -0.5, dz: -1, y: 5 }, { kind: "grunt", dx: -12, dz: 10, y: 3.4 }],
    ],
    bins: [
      { x: 33, z: -22 },
      { x: 50, z: -36 },
      { x: 44, z: -16 },
    ],
    loot: { weapon: [["pike", 3], ["hornet", 2], ["maul", 2], ["lance", 2]], armor: [2, 3], batteries: 2 },
    floor: [{ x: 41.5, z: -29, y: 5, weapon: ["lance", 2] }],
  },
  {
    name: "発着場",
    x: 0,
    z: -68,
    trigger: 28,
    ring: 42,
    entry: { x: 12, z: -40, yaw: 0.35 },
    waves: [[{ kind: "titan", dx: 0, dz: -8 }]],
    bins: [
      { x: -16, z: -56 },
      { x: 16, z: -56 },
    ],
    loot: { weapon: [], armor: [3], batteries: 2 },
    floor: [],
    boss: true,
  },
];


export const EXTRACT = { x: 0, z: -84, radius: 5 };
export const SPAWN = { x: 0, z: 100, yaw: 0 };

/** Bins in buildings off the main route. `table` is the POI whose loot table they use. */
export const EXTRA_BINS: { x: number; z: number; table: number }[] = [
  { x: -12, z: 82, table: 0 },
  { x: 20, z: 24, table: 1 },
  { x: -4, z: -24, table: 2 },
  { x: 3, z: -36, table: 2 },
];

export const BOXES: Box[] = [
  // --- 補給所: containers, an office with a roof, a lookout platform, a loading deck
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
  box(18, 63, 3, 3, 3.0, "tower"),
  ...stairs(18, 64.5, "s", 1.4, 3.0),
  box(6, 30, 12, 5, 1.2, "tower"),
  ...stairs(2, 32.5, "s", 3, 1.2),
  ...stairs(10, 27.5, "n", 3, 1.2),
  // near the landing zone: a hut with the first bin
  ...building(-12, 82, 6, 5, 3.4, { doors: ["n"], windows: ["e"], roof: "e" }),
  box(14, 76, 4, 3, 1.4, "rock"),
  // route south -> mine: a mesa to climb over
  box(-20, 66, 5, 4, 2.4, "rock"),
  box(-26, 34, 3, 6, 1.6, "rock"),
  box(-27, 22, 10, 8, 3.6, "rock"),
  ...stairs(-29, 26, "s", 2.4, 3.6, 1),
  ...building(20, 24, 6, 6, 3.4, { doors: ["w", "n"], windows: ["e"], roof: "s" }),
  // --- 採掘場: rock shelves, a terrace, a catwalk between two scaffold towers, a shed
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
  // route mine -> relay, past a small village
  box(-20, -14, 6, 4, 2.2, "rock"),
  box(6, -6, 5, 5, 3.0, "rock"),
  box(18, 14, 4, 6, 1.8, "rock"),
  ...building(-4, -24, 7, 6, 3.6, { doors: ["n", "e"], windows: ["s", "w"] }),
  ...building(8, -26, 6, 7, 3.6, { doors: ["n"], windows: ["e"], roof: "w" }),
  ...building(3, -36, 10, 6, 3.6, { doors: ["n", "s"], windows: ["e", "w"] }),
  // --- 中継塔: a two-tier tower, huts with roofs, containers around
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
  // route relay -> pad
  box(24, -48, 5, 4, 2.6, "rock"),
  box(-24, -40, 6, 5, 3.2, "rock"),
  // --- 発着場: open pad ringed by pillars, raised gantries on both sides
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
