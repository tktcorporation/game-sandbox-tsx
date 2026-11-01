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
  | "village"
  | "anchor"
  | "pass"
  | "railway"
  | "town"
  | "yard"
  | "smelter"
  | "bay"
  | "station"
  | "waterworks"
  | "lodge"
  | "cannery"
  | "coldstore"
  | "city"
  | "powerplant"
  | "launch";

export type Offset = readonly [number, number];

export const AREA: Record<AreaId, Offset> = {
  // The reservoir, laid out with its neighbours 250 to 400 m apart. The heart is everything joined
  // edge to edge round the drowned town: the lakebed, the dam and the landing pad on top of it, the
  // plateau over the lakebed's west side and the spillway round the dam's east end.
  heart: [0, 80],
  // The south dune coast: the supply depot's works in one piece with the dunes, the beached
  // tanker and the bluff over its west side.
  supply: [0, 420],
  // The red quarry dug in terraces into the west of the island.
  quarry: [-320, 110],
  // The sandstone mesa in the east, the relay mast on its top.
  relay: [300, 30],
  // The works and the housing district in the south-east.
  factory: [270, 320],
  // The terraced fields and their abandoned village on the hill in the north-west.
  village: [-300, -150],
  // The tether's anchor on the ground north of the landing pad, its plinth flush with the pad's
  // north edge, and the fallen tether lying east and west through it.
  anchor: [0, -210],
  // Between the regions: the saddle of the pass road, and the railway's gorge bridge and station.
  pass: [-30, -128],
  railway: [46, -160],
  // The harbor. The bay is the old bay floor in one piece: the salt flats, the beached wreck,
  // the quay and its channel, and the headland with the lighthouse.
  town: [-5, -265],
  yard: [-72, -315],
  smelter: [38, -322],
  bay: [-18, -396],
  // The nodes built on the open ground between the areas, each a small walled works of its own:
  // the weather station on the west coast between the supply depot and the quarry, the waterworks
  // on the south coast east of the supply depot, the workers' lodge at the harbor's foot of the
  // pass, and in the harbor's north the cannery on the salt flats' south shore between the yard and
  // the wreck, and the cold store between the smelter and the wreck.
  station: [-240, 350],
  waterworks: [160, 465],
  lodge: [-150, -485],
  cannery: [-45, -830],
  coldstore: [150, -850],
  // The machine city east of the dried strait: its paved basin, its streets and its POIs, written
  // round the basin's middle.
  city: [870, -330],
  // The power plant on the open ground between the city's paved basin and the east coast.
  powerplant: [1032, -330],
  // The launch site's plateau west of the island across the dry canyon, written round its middle.
  launch: [-930, 20],
};

/** The area each POI stands in, and where the POI's own frame lies within that area's frame. */
const POI_IN: Record<PoiId, [AreaId, Offset]> = {
  supply: ["supply", [0, 0]],
  quarry: ["quarry", [0, 0]],
  relay: ["relay", [0, 0]],
  pad: ["heart", [0, -190]],
  wreck: ["bay", [10, -562]],
  yard: ["yard", [-100, -400]],
  smelter: ["smelter", [120, -415]],
  station: ["station", [0, 0]],
  waterworks: ["waterworks", [0, 0]],
  lodge: ["lodge", [0, 0]],
  cannery: ["cannery", [0, 0]],
  coldstore: ["coldstore", [0, 0]],
  terminal: ["city", [0, -120]],
  carpark: ["city", [-94, 58]],
  robotworks: ["city", [-25, -315]],
  highrise: ["city", [64, 178]],
  powerplant: ["powerplant", [0, 0]],
  control: ["launch", [100, -250]],
  assembly: ["launch", [40, 210]],
  launchpad: ["launch", [-270, 242]],
};

/** A point written in an area's frame, in the world. */
export const inArea = (a: AreaId, x: number, z: number): [number, number] => [x + AREA[a][0], z + AREA[a][1]];

/** Where each POI's own frame lies in the world. */
export const POI_AT = Object.fromEntries(Object.entries(POI_IN).map(([id, [a, [x, z]]]) => [id, inArea(a, x, z)])) as Record<PoiId, [number, number]>;
