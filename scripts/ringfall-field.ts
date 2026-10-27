/**
 * Measures how a place of the RINGFALL world plays as ground to fight over, from the sim's own
 * data: the cover spots robots use (`COVERS`) and the sight rays robots and shots use (`rayWorld`).
 * No browser, a few seconds a place, so a change to a place can be measured before it is looked at.
 *
 *   npx tsx scripts/ringfall-field.ts <place> [--r 120]     one place, its maps in shots/ringfall/field/
 *   npx tsx scripts/ringfall-field.ts --all [--r 120]       every POI, one line each
 *
 * Each walkable point of a 4 m grid within `r` of the place (on the ground, not in the sea, not on
 * high ground or a cliff, not inside a box) is measured for:
 * - cover: metres to the nearest cover spot on its own level, the spot a robot would hide at, which a
 *   player can use the same way. `NEAR` (8 m) is about a second's sprint.
 * - sight: from standing eye height, how far a level look goes in 16 directions before a box or the
 *   ground stops it, out to `FAR`. A look past `LANE` (a grunt's engaged sight) is a lane a robot can
 *   shoot down before the player can see it well.
 * - exposed: no cover within `NEAR` and at least half of the 16 looks past `LANE`: open ground seen
 *   from far with nowhere to go.
 * `ringfall-look.ts` runs the same measure for the place it looks at and compares it with its baseline.
 */
import { mkdirSync } from "node:fs";
import { AWARE, COVER, PLAYER, SIGHT } from "../src/ringfall/sim/config";
import { coversNear } from "../src/ringfall/sim/cover";
import { collide, groundLevel, inWorld, rayWorld } from "../src/ringfall/sim/geom";
import { BOXES, deckAt, FRAMES, POIS } from "../src/ringfall/sim/map";
import { highGround, offshore, steepAt } from "../src/ringfall/sim/terrain";
import { writePng } from "./png";

/** Grid of the points measured, metres. */
const STEP = 4;
/** Cover this near is a second's sprint (`PLAYER.sprint` 7.6 m/s). */
export const NEAR = 8;
/** A grunt's engaged sight: a look further than this is open to a robot that sees the player first. */
export const LANE = SIGHT.grunt.range * AWARE.engagedRange;
/** Looks are cast out to this far; past it the fog has the player anyway. */
const FAR = 120;
/** Cover searched out to this far; a point with none nearer counts as this. */
const COVER_FAR = 40;
const DIRS = 16;

export interface FieldPoint {
  x: number;
  z: number;
  /** Metres to the nearest cover spot on the point's own level, at most COVER_FAR. */
  cover: number;
  /** How many of the DIRS looks go past LANE. */
  lanes: number;
  /** Median look, metres, at most FAR. */
  sight: number;
}

export interface Field {
  points: FieldPoint[];
  /** Share of the points with cover within NEAR. */
  covered: number;
  /** Median metres to cover. */
  coverMedian: number;
  /** The point furthest from cover and its distance (COVER_FAR means none within it). */
  coverWorst: { x: number; z: number; m: number };
  /** Median of the points' median looks. */
  sightMedian: number;
  /** Share of all looks that go past LANE. */
  laneShare: number;
  /** Share of the points that are exposed. */
  exposed: number;
}

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : 0;
};

/**
 * Whether a player could stand at (x, z) on the ground: no sea, high ground, cliff or box. A deck
 * (`DECKS`) is ground as path finding walks it, whatever the terrain under it is.
 */
function walkable(x: number, z: number): number | null {
  if (!inWorld(x, z, 1)) return null;
  if (deckAt(x, z) === null && (offshore(x, z) > 0 || highGround(x, z) || steepAt(x, z))) return null;
  const g = groundLevel(x, z);
  const p = { x, y: g, z };
  if (collide(p, PLAYER.radius)) return null;
  return g;
}

export function measureField(centre: { x: number; z: number }, r: number): Field {
  const points: FieldPoint[] = [];
  const eye = { x: 0, y: 0, z: 0 };
  for (let x = Math.ceil((centre.x - r) / STEP) * STEP; x <= centre.x + r; x += STEP)
    for (let z = Math.ceil((centre.z - r) / STEP) * STEP; z <= centre.z + r; z += STEP) {
      if (Math.hypot(x - centre.x, z - centre.z) > r) continue;
      const g = walkable(x, z);
      if (g === null) continue;
      let cover = COVER_FAR;
      for (const c of coversNear(x, z, COVER_FAR)) {
        if (Math.abs(c.y - g) > COVER.level) continue;
        const d = Math.hypot(c.x - x, c.z - z);
        if (d < cover) cover = d;
      }
      eye.x = x;
      eye.y = g + PLAYER.eye;
      eye.z = z;
      const looks: number[] = [];
      for (let k = 0; k < DIRS; k++) {
        const a = (k / DIRS) * Math.PI * 2;
        looks.push(rayWorld(eye, { x: Math.sin(a), y: 0, z: -Math.cos(a) }, FAR));
      }
      points.push({ x, z, cover, lanes: looks.filter((d) => d > LANE).length, sight: median(looks) });
    }
  const n = Math.max(1, points.length);
  const worst = points.reduce((w, p) => (p.cover > w.m ? { x: p.x, z: p.z, m: p.cover } : w), { x: centre.x, z: centre.z, m: 0 });
  return {
    points,
    covered: points.filter((p) => p.cover <= NEAR).length / n,
    coverMedian: median(points.map((p) => p.cover)),
    coverWorst: worst,
    sightMedian: median(points.map((p) => p.sight)),
    laneShare: points.reduce((s, p) => s + p.lanes, 0) / (n * DIRS),
    exposed: points.filter((p) => p.cover > NEAR && p.lanes >= DIRS / 2).length / n,
  };
}

/** The numbers a baseline keeps and a later look compares, rounded as they are printed. */
export const fieldNumbers = (f: Field) => ({
  points: f.points.length,
  covered: +f.covered.toFixed(3),
  coverMedian: +f.coverMedian.toFixed(1),
  sightMedian: +f.sightMedian.toFixed(1),
  laneShare: +f.laneShare.toFixed(3),
  exposed: +f.exposed.toFixed(3),
});

export const fieldLine = (f: Field) => {
  const pc = (v: number) => `${Math.round(v * 100)}%`;
  const w = f.coverWorst;
  return (
    `${f.points.length} points: cover within ${NEAR} m ${pc(f.covered)} (median ${f.coverMedian.toFixed(1)} m, worst ${w.m >= COVER_FAR ? `none within ${COVER_FAR}` : w.m.toFixed(0)} m at (${w.x}, ${w.z})), ` +
    `sight median ${f.sightMedian.toFixed(0)} m, looks past ${LANE.toFixed(0)} m ${pc(f.laneShare)}, exposed ${pc(f.exposed)}`
  );
};

/**
 * Two maps of the place side by side, a pixel block per point, boxes standing there drawn dark:
 * cover (green within NEAR, through yellow to red at COVER_FAR) and sight (dark blue short to
 * white past LANE); exposed points are ringed red on both.
 */
export function drawField(path: string, centre: { x: number; z: number }, r: number, f: Field) {
  const S = 4; // pixels per grid step
  const side = Math.floor((2 * r) / STEP) + 1;
  const W = side * S * 2 + S;
  const H = side * S;
  const img = new Uint8Array(W * H * 3).fill(40);
  const x0 = Math.ceil((centre.x - r) / STEP) * STEP;
  const z0 = Math.ceil((centre.z - r) / STEP) * STEP;
  const block = (i: number, j: number, ox: number, c: number[], ring = false) => {
    for (let dy = 0; dy < S; dy++)
      for (let dx = 0; dx < S; dx++) {
        const edge = dx === 0 || dy === 0 || dx === S - 1 || dy === S - 1;
        const px = ox + i * S + dx;
        const py = j * S + dy;
        if (px < W && py < H) img.set(ring && edge ? [230, 30, 30] : c, (py * W + px) * 3);
      }
  };
  // Boxes in the place, dark, so the maps read against the layout.
  for (const b of BOXES) {
    if (b.x1 < x0 || b.x0 > x0 + side * STEP || b.z1 < z0 || b.z0 > z0 + side * STEP) continue;
    for (let i = Math.max(0, Math.floor((b.x0 - x0) / STEP)); i <= Math.min(side - 1, Math.floor((b.x1 - x0) / STEP)); i++)
      for (let j = Math.max(0, Math.floor((b.z0 - z0) / STEP)); j <= Math.min(side - 1, Math.floor((b.z1 - z0) / STEP)); j++) {
        block(i, j, 0, [70, 70, 80]);
        block(i, j, side * S + S, [70, 70, 80]);
      }
  }
  const lerp = (a: number[], b: number[], t: number) => a.map((v, k) => Math.round(v + (b[k] - v) * Math.max(0, Math.min(1, t))));
  for (const p of f.points) {
    const i = Math.round((p.x - x0) / STEP);
    const j = Math.round((p.z - z0) / STEP);
    const t = p.cover <= NEAR ? 0 : (p.cover - NEAR) / (COVER_FAR - NEAR);
    const coverC = p.cover <= NEAR ? [60, 170, 80] : t < 0.5 ? lerp([220, 200, 60], [230, 120, 40], t * 2) : lerp([230, 120, 40], [200, 40, 40], (t - 0.5) * 2);
    const sightC = lerp([30, 50, 110], [240, 240, 240], p.sight / LANE);
    const exposed = p.cover > NEAR && p.lanes >= DIRS / 2;
    block(i, j, 0, coverC, exposed);
    block(i, j, side * S + S, sightC, exposed);
  }
  writePng(path, W, H, img);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const R = Number(args[args.indexOf("--r") + 1]) || 120;
  const OUT = "shots/ringfall/field";
  mkdirSync(OUT, { recursive: true });
  const target = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--r");
  const frames = FRAMES as Record<string, { x: number; z: number }>;
  if (args.includes("--all")) {
    for (const p of POIS) {
      const c = frames[p.id];
      if (!c) continue;
      console.log(`${p.id.padEnd(12)} ${fieldLine(measureField(c, R))}`);
    }
  } else {
    const xz = target?.match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
    const centre = xz ? { x: +xz[1], z: +xz[2] } : target ? frames[target] : undefined;
    if (!target || !centre) {
      console.error(`usage: npx tsx scripts/ringfall-field.ts <place>|--all [--r 120]\nplaces: ${Object.keys(FRAMES).join(", ")}, or x,z`);
      process.exit(2);
    }
    const f = measureField(centre, R);
    const slug = xz ? `xz_${+xz[1]}_${+xz[2]}` : target.replaceAll(":", "_");
    drawField(`${OUT}/${slug}.png`, centre, R, f);
    console.log(fieldLine(f));
    console.log(`map: ${OUT}/${slug}.png (left: cover, green within ${NEAR} m to red at ${COVER_FAR}; right: sight, dark short to white past ${LANE.toFixed(0)} m; red rings: exposed)`);
  }
}
