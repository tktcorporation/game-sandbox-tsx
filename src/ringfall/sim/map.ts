import type { EnemyKind, Rarity, WeaponKind } from "./config";

/**
 * The island. Everything solid is an axis-aligned box standing on the ground, so
 * collision, line of sight and standing on top are all the same cheap test.
 * North is -z. The player drops in from the south and fights northward.
 */

export type BoxKind = "crate" | "container" | "wall" | "rock" | "pad" | "tower";

export interface Box {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  h: number;
  kind: BoxKind;
  tint: number; // index into the renderer's palette for this kind
}

const box = (cx: number, cz: number, w: number, d: number, h: number, kind: BoxKind, tint = 0): Box => ({
  x0: cx - w / 2,
  z0: cz - d / 2,
  x1: cx + w / 2,
  z1: cz + d / 2,
  h,
  kind,
  tint,
});

export interface WaveSpawn {
  kind: EnemyKind;
  /** Offset from the POI centre. */
  dx: number;
  dz: number;
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
  bins: { x: number; z: number }[];
  loot: LootTable;
  floor: { x: number; z: number; weapon?: [WeaponKind, Rarity]; armor?: Rarity; battery?: true }[];
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
      ring(5, 14, 0.9, ["grunt", "grunt", "drone", "charger", "drone"]),
    ],
    bins: [
      { x: -2, z: 54 },
      { x: 7, z: 61 },
      { x: -11, z: 41 },
    ],
    loot: { weapon: [["hornet", 1], ["maul", 0], ["lance", 0], ["pike", 1]], armor: [1], batteries: 1 },
    floor: [
      { x: 3, z: 66, weapon: ["hornet", 0] },
      { x: -4, z: 66, battery: true },
    ],
  },
  {
    name: "採掘場",
    x: -46,
    z: 2,
    trigger: 26,
    ring: 42,
    entry: { x: -30, z: 24, yaw: 0.9 },
    waves: [
      ring(5, 14, -1.2, ["grunt", "drone", "grunt", "grunt", "drone"]),
      ring(6, 15, 0.3, ["charger", "grunt", "charger", "drone", "charger", "drone"]),
      ring(6, 13, 1.5, ["grunt", "drone", "grunt", "charger", "grunt", "drone"]),
    ],
    bins: [
      { x: -37, z: 8 },
      { x: -54, z: -4 },
      { x: -46, z: 14 },
    ],
    loot: { weapon: [["pike", 2], ["maul", 1], ["lance", 1], ["hornet", 2]], armor: [2], batteries: 2 },
    floor: [],
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
      ring(7, 14, 0.2, ["heavy", "drone", "grunt", "grunt", "drone", "charger", "grunt"]),
    ],
    bins: [
      { x: 33, z: -22 },
      { x: 50, z: -36 },
      { x: 44, z: -16 },
    ],
    loot: { weapon: [["pike", 3], ["hornet", 2], ["maul", 2], ["lance", 2]], armor: [2, 3], batteries: 2 },
    floor: [],
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

export const BOXES: Box[] = [
  // --- 補給所: containers and a broken concrete hut
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
  // route south -> mine
  box(-20, 66, 5, 4, 2.4, "rock"),
  box(-26, 34, 3, 6, 1.6, "rock"),
  box(14, 76, 4, 3, 1.4, "rock"),
  // --- 採掘場: rock shelves, containers, a conveyor wall
  box(-58, 6, 6, 9, 4.5, "rock"),
  box(-36, -6, 7, 5, 3.6, "rock"),
  box(-51, -10, 6.2, 2.5, 2.6, "container", 2),
  box(-41, 11, 2.5, 6.2, 2.6, "container", 0),
  box(-49, 9, 1.2, 1.2, 0.9, "crate"),
  box(-50.2, 9, 1.2, 1.2, 1.8, "crate"),
  box(-44, -2, 1.2, 1.2, 0.9, "crate"),
  box(-55, 18, 10, 0.8, 1.2, "wall"),
  box(-33, 6, 1.2, 1.2, 0.9, "crate"),
  // route mine -> relay
  box(-20, -14, 6, 4, 2.2, "rock"),
  box(6, -6, 5, 5, 3.0, "rock"),
  box(18, 14, 4, 6, 1.8, "rock"),
  // --- 中継塔: a platform with crate steps, containers around
  box(42, -28, 5, 5, 3.4, "tower"),
  box(42, -24.9, 1.2, 1.2, 2.6, "crate"),
  box(43.2, -24.9, 1.2, 1.2, 1.8, "crate"),
  box(44.4, -24.9, 1.2, 1.2, 0.9, "crate"),
  box(31, -32, 2.5, 6.2, 2.6, "container", 1),
  box(53, -24, 2.5, 6.2, 2.6, "container", 2),
  box(40, -41, 6.2, 2.5, 2.6, "container", 0),
  box(36, -18, 1.2, 1.2, 0.9, "crate"),
  box(49, -33, 4, 0.6, 2.4, "wall"),
  // route relay -> pad
  box(24, -48, 5, 4, 2.6, "rock"),
  box(-24, -40, 6, 5, 3.2, "rock"),
  // --- 発着場: open pad ringed by pillars
  box(0, -82, 12, 10, 0.25, "pad"),
  box(-12, -60, 2, 2, 3.8, "wall"),
  box(12, -60, 2, 2, 3.8, "wall"),
  box(-17, -74, 2, 2, 3.8, "wall"),
  box(17, -74, 2, 2, 3.8, "wall"),
  box(-6, -54, 1.2, 1.2, 0.9, "crate"),
  box(6, -54, 1.2, 1.2, 0.9, "crate"),
  box(-21, -64, 1.2, 1.2, 0.9, "crate"),
  box(21, -64, 1.2, 1.2, 0.9, "crate"),
];
