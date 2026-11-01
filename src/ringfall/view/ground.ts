import * as THREE from "three";
import { cliffGround, DAM_FACE, floorLevel, groundOf, highGround, LEVEL, steepAt, surfaceAt, type Ground } from "../sim/terrain";
import { CITY_LANES } from "../sim/map";
import { PAL } from "./models";

/*
 * How the ground is painted, by the kind of ground under each point: the chunks' terrain mesh
 * colours its triangles with it, and the scatter of stones, stains and tufts near the camera
 * (scatter.ts) takes its colours from the same place, so what lies on the ground belongs to it.
 */

export const hash = (x: number, z: number) => {
  const v = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return v - Math.floor(v);
};
/** Smooth value noise in 0..1 for colouring the ground. */
export function noise(x: number, z: number): number {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const u = (x - xi) * (x - xi) * (3 - 2 * (x - xi));
  const v = (z - zi) * (z - zi) * (3 - 2 * (z - zi));
  const a = hash(xi, zi);
  const b = hash(xi + 1, zi);
  const c = hash(xi, zi + 1);
  const d = hash(xi + 1, zi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

export const COL = {
  sand: new THREE.Color(PAL.sand),
  dark: new THREE.Color(PAL.sandDark),
  rock: new THREE.Color(PAL.rock),
  rockDark: new THREE.Color(PAL.rockDark),
  mud: new THREE.Color(PAL.mud),
  mudDark: new THREE.Color(PAL.mudDark),
  tide: new THREE.Color(PAL.tide),
  concrete: new THREE.Color(PAL.concrete),
  concreteDark: new THREE.Color(PAL.concreteDark),
};
export const groundMat = new THREE.MeshLambertMaterial({ vertexColors: true });

/**
 * How each kind of ground (`Ground`, given to the shapes in terrain.ts) is painted: its colour, a
 * darker one, and how much of the darker shows where, from the noise `k` at (x, z).
 */
export const GROUND: Record<Ground, { base: THREE.Color; dark: THREE.Color; mix: (x: number, z: number, k: number) => number }> = {
  // Salt crust split by darker cracks.
  salt: { base: new THREE.Color(PAL.salt), dark: new THREE.Color(PAL.saltDark), mix: (x, z, k) => (noise(x * 0.35, z * 0.35) > 0.62 ? 0.8 : k * 0.25) },
  // Pale blown sand, ripples running across it.
  dune: { base: new THREE.Color(PAL.dune), dark: new THREE.Color(PAL.duneDark), mix: (x, z, k) => (Math.sin(x * 0.9 + z * 0.35 + noise(x * 0.05, z * 0.05) * 6) > 0.7 ? 0.45 : k * 0.3) },
  paved: { base: new THREE.Color(PAL.paved), dark: new THREE.Color(PAL.pavedDark), mix: (x, z, k) => (noise(x * 0.5, z * 0.5) > 0.66 ? 0.6 : k * 0.25) },
  // Cracked grey clay.
  mud: { base: new THREE.Color(PAL.mud), dark: new THREE.Color(PAL.mudDark), mix: (x, z, k) => (noise(x * 0.4, z * 0.4) > 0.6 ? 0.6 : k * 0.3) },
  // Red bedrock, in bands along the benches it was cut in.
  quarry: { base: new THREE.Color(PAL.quarry), dark: new THREE.Color(PAL.quarryDark), mix: (x, z, k) => (noise(x * 0.25, z * 0.6) > 0.64 ? 0.7 : k * 0.35) },
  sandstone: { base: new THREE.Color(PAL.sandstone), dark: new THREE.Color(PAL.sandstoneDark), mix: (x, z, k) => (noise(x * 0.12, z * 0.3) > 0.6 ? 0.55 : k * 0.3) },
  // Sage-green scrub in clumps over dry soil.
  scrub: { base: new THREE.Color(PAL.scrub), dark: new THREE.Color(PAL.scrubDark), mix: (x, z) => (noise(x * 0.45, z * 0.45) > 0.55 ? 0.75 : 0.15) },
  // Concrete with black oil stains.
  oiled: { base: new THREE.Color(PAL.oiled), dark: new THREE.Color(PAL.oiledDark), mix: (x, z, k) => (noise(x * 0.2, z * 0.2) > 0.68 ? 0.85 : k * 0.2) },
  concrete: { base: new THREE.Color(PAL.concrete), dark: new THREE.Color(PAL.concreteDark), mix: (x, z, k) => (noise(x * 0.3, z * 0.3) > 0.7 ? 0.4 : k * 0.2) },
  // The launch site's pale caliche crust, in wide blotches of the darker under it.
  caliche: { base: new THREE.Color(PAL.caliche), dark: new THREE.Color(PAL.calicheDark), mix: (x, z, k) => (noise(x * 0.08, z * 0.08) > 0.64 ? 0.55 : k * 0.25) },
  // The crawlerway's river gravel, a fine speckle of darker stones.
  gravel: { base: new THREE.Color(PAL.gravel), dark: new THREE.Color(PAL.gravelDark), mix: (x, z, k) => (noise(x * 0.9, z * 0.9) > 0.6 ? 0.6 : k * 0.25) },
  // The machine city's charcoal asphalt, patched darker; its lane paint is laid by `laneMark()`.
  asphalt: { base: new THREE.Color(PAL.cityAsphalt), dark: new THREE.Color(PAL.cityAsphaltDark), mix: (x, z, k) => (noise(x * 0.18, z * 0.18) > 0.66 ? 0.7 : k * 0.3) },
};

const LANE = new THREE.Color(PAL.laneMark);
/**
 * The city's lane paint over its asphalt (`CITY_LANES`): a dashed line along each street's middle
 * and a solid one 9 m out either side, faded, so the grid reads from a tower without glaring. Each
 * line fills one row of the ground mesh's 2 m cells, so its edges run straight.
 */
function laneMark(c: THREE.Color, x: number, z: number) {
  for (const l of CITY_LANES) {
    const alongX = l.az === l.bz;
    const [u, v, u0, u1, v0] = alongX ? [x, z, Math.min(l.ax, l.bx), Math.max(l.ax, l.bx), l.az] : [z, x, Math.min(l.az, l.bz), Math.max(l.az, l.bz), l.ax];
    if (u < u0 || u > u1) continue;
    const off = v - v0;
    if (Math.abs(off - 1) < 0.5 && Math.floor(u / 4) % 2 === 0) c.lerp(LANE, 0.55);
    else if (Math.abs(Math.abs(off) - 9) < 0.5) c.lerp(LANE, 0.35);
  }
}

/** East of the dried strait (the city's region), the open ground is the city's broken grey paving, not soil. */
const CITY_WEST = 620;
const LOT = new THREE.Color(PAL.cityLot);
const LOT_DARK = new THREE.Color(PAL.cityLotDark);
/** West of the dry canyon's line (the launch site's plateau), the open ground is its pale caliche, not soil. */
const PLATEAU_EAST = -605;

/** The colour of a ground triangle centred on (x, z), spanning heights lo..hi. */
export function groundColour(c: THREE.Color, x: number, z: number, lo: number, hi: number) {
  const h = (lo + hi) / 2;
  const cliff = steepAt(x, z) || hi - lo > 2.2;
  const k = noise(x * 0.08, z * 0.08);
  const rock = cliff ? cliffGround(x, z) : undefined;
  if (cliff && DAM_FACE(x, z)) c.copy(COL.concrete).lerp(COL.concreteDark, noise(x * 0.5, h * 0.3) * 0.35);
  // The quarry's and the mesa's cliffs show their own rock, in bands along the height.
  else if (rock) c.copy(GROUND[rock].base).lerp(GROUND[rock].dark, 0.35 + noise(x * 0.3, h * 0.5) * 0.5);
  // Below the old waterline the walls are bleached in bands; above it, bare red rock.
  else if (cliff && h < LEVEL.shore) c.copy(COL.tide).lerp(COL.rock, Math.max(0, Math.min(1, (h - LEVEL.shore) / 3 + 1)) * 0.5 + noise(x * 0.3, h * 0.6) * 0.2);
  else if (cliff) c.copy(COL.rock).lerp(COL.rockDark, noise(x * 0.3, z * 0.1 + h * 0.2));
  // The unclimbable high ground: weathered rock, darker than anything walked on.
  else if (highGround(x, z)) c.copy(COL.rockDark).lerp(COL.rock, k * 0.6);
  else {
    const at = surfaceAt(x, z);
    const ground = groundOf(at) ?? (at === "水路" || floorLevel(x, z) <= LEVEL.lakebed + 0.5 ? "mud" : undefined);
    if (ground) {
      c.copy(GROUND[ground].base).lerp(GROUND[ground].dark, GROUND[ground].mix(x, z, k));
      if (ground === "asphalt") laneMark(c, x, z);
    } else if (x > CITY_WEST) c.copy(LOT).lerp(LOT_DARK, noise(x * 0.25, z * 0.25) > 0.6 ? 0.75 : k * 0.4);
    else if (x < PLATEAU_EAST) c.copy(GROUND.caliche.base).lerp(GROUND.caliche.dark, GROUND.caliche.mix(x, z, k));
    else {
      c.copy(COL.sand).lerp(COL.dark, k > 0.62 ? 0.7 : k * 0.3);
      // The ground between the areas in broad patches of redder soil, so the basins read as clearings.
      if (at === "野") c.lerp(COL.rock, Math.max(0, noise(x * 0.015 + 3, z * 0.015) - 0.4) * 0.45);
      // Higher levels a touch lighter, so the steps read from afar.
      c.offsetHSL(0, 0, Math.max(-0.05, Math.min(0.05, h * 0.006)));
    }
  }
}
