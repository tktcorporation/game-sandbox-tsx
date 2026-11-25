/*
 * Outer-edge contested hubs (作り順②) as a light table for the Worker and meta code that must
 * not build the world. Written from map data by scripts/ringfall-contested-outer.ts (`--write`);
 * that script fails when this file differs from `outerFacingHubs()` in sim/contested-outer.ts.
 * Thresholds: OUTER_SEA_NEAR 110, OUTER_BOUND_NEAR 150 (see contested-outer.ts).
 */

export interface ContestedOuterHub {
  id: string;
  x: number;
  z: number;
}

export const CONTESTED_OUTER_TABLE: readonly ContestedOuterHub[] = [
  { id: "wreck", x: -8, z: -958 },
  { id: "station", x: -240, z: 350 },
  { id: "waterworks", x: 160, z: 465 },
  { id: "lodge", x: -150, z: -485 },
  { id: "robotworks", x: 850, z: -627 },
  { id: "highrise", x: 934, z: -152 },
  { id: "powerplant", x: 1032, z: -330 },
  { id: "launchpad", x: -1200, z: 262 },
  { id: "fuel", x: -1040, z: 370 },
  { id: "radar", x: -1050, z: -370 },
];

/** Outer contested hub ids in `NODES` order (same as CONTESTED_OUTER_TABLE). */
export const CONTESTED_OUTER_IDS: readonly string[] = CONTESTED_OUTER_TABLE.map((h) => h.id);
