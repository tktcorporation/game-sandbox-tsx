import type { PoiId } from "./map";

/**
 * The world is laid out area by area. Each area (a POI with the ground round it, a district, the
 * bay of the harbor) is written in a frame of its own, shared by its ground (terrain.ts) and
 * everything built on it (map.ts); `AREA` says where that frame lies in the world. Moving an area
 * moves its basins, buildings, robots, bins and the shots gate's cameras together. The roads,
 * cuts and crags between the areas, and the railway, are written in the world's own coordinates.
 */
export type AreaId =
  | "heart"
  | "supply"
  | "quarry"
  | "relay"
  | "factory"
  | "ridge"
  | "village"
  | "pass"
  | "railway"
  | "town"
  | "yard"
  | "smelter"
  | "bay";

export type Offset = readonly [number, number];

export const AREA: Record<AreaId, Offset> = {
  // The reservoir. The heart is everything joined edge to edge round the drowned town: the
  // lakebed, the dam and its crest, the landing pad behind it, the plateau over the lakebed's
  // west side, the spillway and its canyon bridge.
  heart: [0, 37],
  // The south dune coast: the supply depot's works in one piece with the dunes, the beached
  // tanker and the bluff over its west side.
  supply: [0, 420],
  quarry: [-72, 75],
  // The relay tower's mesa with the housing street and the flats beside it.
  relay: [45, 52],
  factory: [28, 96],
  ridge: [-25, 105],
  village: [-52, 38],
  // Between the regions: the saddle of the pass road, and the railway's gorge bridge and station.
  pass: [-30, -128],
  railway: [46, -160],
  // The harbor. The bay is the old bay floor in one piece: the salt flats, the beached wreck,
  // the quay and its channel, and the headland with the lighthouse.
  town: [-5, -265],
  yard: [-72, -315],
  smelter: [38, -322],
  bay: [-18, -396],
};

/** The area each POI stands in, and where the POI's own frame lies within that area's frame. */
const POI_IN: Record<PoiId, [AreaId, Offset]> = {
  supply: ["supply", [0, 0]],
  quarry: ["quarry", [-99, 8]],
  relay: ["relay", [48, -7]],
  pad: ["heart", [0, -52]],
  wreck: ["bay", [10, -562]],
  yard: ["yard", [-100, -400]],
  smelter: ["smelter", [120, -415]],
};

/** A point written in an area's frame, in the world. */
export const inArea = (a: AreaId, x: number, z: number): [number, number] => [x + AREA[a][0], z + AREA[a][1]];

/** Where each POI's own frame lies in the world. */
export const POI_AT = Object.fromEntries(Object.entries(POI_IN).map(([id, [a, [x, z]]]) => [id, inArea(a, x, z)])) as Record<PoiId, [number, number]>;
