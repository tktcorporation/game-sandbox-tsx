import * as THREE from "three";
import { ceilingAt, solidAt } from "../sim/geom";
import { offStreet } from "../sim/streets";
import { groundOf, highGround, roadLine, steepAt, surfaceAt, terrainGrad, terrainHeight, type Ground } from "../sim/terrain";
import { GROUND, groundColour } from "./ground";
import { PAL } from "./models";
import { coverAt } from "./shade";

/*
 * What lies on the ground near the camera: stones, darker stains, cracks and tufts of dry grass.
 * The ground's colour patches are metres across; these are a hand's breadth to a metre and a
 * half, which is what tells the eye the ground at its feet is full size. Each grid cell holds at
 * most one, chosen and placed from a hash of the cell, so the scatter is the same whenever the
 * camera comes back, and needs no state but the cell the camera is in. It is two instanced
 * meshes (stones and flat marks share one, tufts the other), cast no shadow, and is laid again
 * only when the camera moves into another cell of `SCATTER.move` metres.
 */

export const SCATTER = {
  /** Side of the grid cells, each holding at most one thing. */
  cell: 1.6,
  /** The scatter is laid again when the camera moves into another square of this side. */
  move: 4,
  /** Over the last this many metres of the reach things shrink away, so the edge does not pop. */
  fade: 6,
  /** Grass grows only where nothing is overhead within about this radius (an open roof's beams included). */
  shelter: 8,
  /** The most of each mesh drawn at once. */
  max: 2600,
} as const;

/** One thing laid on the ground: where, turned and sized how, and its colour. */
interface Item {
  tuft: boolean;
  /** A stain or a crack: shrinks across but keeps its thickness. */
  flat: boolean;
  pos: THREE.Vector3;
  q: THREE.Quaternion;
  size: THREE.Vector3;
  r: number;
  g: number;
  b: number;
}

/** What a cell may hold. */
type Thing = "stone" | "stain" | "crack" | "tuft";

/**
 * How likely each thing is in a cell, by the ground it lies on (`Ground`, or the soil of the
 * ground between and the plain sand roads). The salt and the clay crack, the quarry is strewn
 * with rubble, the terraces' scrub grows in tufts, and concrete is stained and chipped.
 */
const MIX: Record<Ground | "soil", Partial<Record<Thing, number>>> = {
  soil: { stone: 0.12, stain: 0.06, tuft: 0.1 },
  dune: { stone: 0.02, tuft: 0.05 },
  salt: { crack: 0.14, stain: 0.04, stone: 0.02 },
  mud: { crack: 0.16, stain: 0.05, stone: 0.04 },
  quarry: { stone: 0.26, stain: 0.04 },
  sandstone: { stone: 0.15, stain: 0.05, tuft: 0.04 },
  scrub: { tuft: 0.36, stone: 0.06 },
  paved: { crack: 0.07, stain: 0.06, stone: 0.04 },
  oiled: { crack: 0.06, stain: 0.1, stone: 0.04 },
  concrete: { crack: 0.07, stain: 0.05, stone: 0.03 },
};
const THINGS: readonly Thing[] = ["stone", "stain", "crack", "tuft"];
const ROCK_DARK = new THREE.Color(PAL.rockDark);
const SAND_DARK = new THREE.Color(PAL.sandDark);
const SCRUB_DARK = new THREE.Color(PAL.scrubDark);

const h = (x: number, z: number, salt: number) => {
  const v = Math.sin(x * 127.1 + z * 311.7 + salt * 74.7) * 43758.5453;
  return v - Math.floor(v);
};

/** A low six-sided stone, wider at its foot; flattened it is a stain, drawn out a crack. */
function stoneGeometry() {
  return new THREE.CylinderGeometry(0.32, 0.5, 1, 6, 1).translate(0, 0.5, 0).toNonIndexed();
}

/** A tuft: five thin blades leaning out from a point, a unit tall. */
function tuftGeometry() {
  const pos: number[] = [];
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2 + 0.4;
    const lean = 0.25 + (k % 2) * 0.15;
    const cx = Math.cos(a);
    const cz = Math.sin(a);
    // Across the blade's foot, perpendicular to its lean.
    const px = -cz * 0.06;
    const pz = cx * 0.06;
    pos.push(cx * 0.05 + px, 0, cz * 0.05 + pz, cx * 0.05 - px, 0, cz * 0.05 - pz, cx * lean, 1 - (k % 2) * 0.25, cz * lean);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

export class GroundScatter {
  readonly group = new THREE.Group();
  private stones: THREE.InstancedMesh;
  private tufts: THREE.InstancedMesh;
  private at = "";
  /** What each cell near the camera holds (null: nothing), by `i * 65536 + j`. */
  private cells = new Map<number, Item | null>();
  private m = new THREE.Matrix4();
  private s = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);
  private n = new THREE.Vector3();
  private c = new THREE.Color();
  private tilt = new THREE.Quaternion();
  /** Milliseconds the last laying took, for the frame cost. */
  layMs = 0;

  constructor() {
    const stoneMat = new THREE.MeshLambertMaterial({ flatShading: true });
    const tuftMat = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide });
    this.stones = new THREE.InstancedMesh(stoneGeometry(), stoneMat, SCATTER.max);
    this.tufts = new THREE.InstancedMesh(tuftGeometry(), tuftMat, SCATTER.max);
    for (const im of [this.stones, this.tufts]) {
      im.castShadow = false;
      im.receiveShadow = true;
      im.count = 0;
      im.setColorAt(0, this.c.set(0xffffff));
      this.group.add(im);
    }
  }

  /** Lays the scatter round (x, z) out to `reach` metres, if the camera has moved into another square since. */
  update(x: number, z: number, reach: number) {
    this.group.visible = reach > 0;
    if (reach <= 0) return;
    const sx = Math.floor(x / SCATTER.move);
    const sz = Math.floor(z / SCATTER.move);
    const key = `${sx},${sz},${reach}`;
    if (key === this.at) return;
    this.at = key;
    const t0 = performance.now();
    this.lay((sx + 0.5) * SCATTER.move, (sz + 0.5) * SCATTER.move, reach);
    this.layMs = performance.now() - t0;
  }

  /** Forgets where it was laid, so the next update lays it again (the world's routes changed). */
  invalidate() {
    this.at = "";
    this.cells.clear();
  }

  /**
   * What cell (i, j) holds, worked out once and kept while the cell stays near: a re-laying after
   * the camera moves a square only works out the cells newly in reach.
   */
  private thing(i: number, j: number): Item | null {
    const key = i * 65536 + j;
    const known = this.cells.get(key);
    if (known !== undefined) return known;
    const item = this.work(i, j);
    this.cells.set(key, item);
    return item;
  }

  private work(i: number, j: number): Item | null {
    const cell = SCATTER.cell;
    const roll = h(i, j, 1);
    // Cheap rejection first: most cells hold nothing on any ground.
    if (roll > 0.36) return null;
    const x = (i + 0.15 + 0.7 * h(i, j, 2)) * cell;
    const z = (j + 0.15 + 0.7 * h(i, j, 3)) * cell;
    if (steepAt(x, z) || highGround(x, z)) return null;
    // Nothing grows or lies on a street's asphalt (streets.ts).
    if (offStreet(x, z) < 0.3) return null;
    const at = surfaceAt(x, z);
    const road = roadLine(at).length > 0;
    const ground = groundOf(at) ?? (at === "水路" ? "mud" : "soil");
    const mix = MIX[ground];
    let thing: Thing | null = null;
    let acc = 0;
    for (const t of THINGS) {
      acc += mix[t] ?? 0;
      if (roll < acc) {
        thing = t;
        break;
      }
    }
    if (!thing) return null;
    // No grass on a road; nothing on a road made of soil but the odd stone.
    if (road && (thing === "tuft" || (ground === "soil" && thing !== "stone"))) return null;
    const y = terrainHeight(x, z);
    if (solidAt(x, y + 0.15, z)) return null;
    const roofed = ceilingAt(x, z, 0, y + 30, y + 0.1) < Infinity;
    // No grass under a roof or a deck, nor between the beams of an open roof: anything overhead within a few metres.
    if (thing === "tuft" && (roofed || ceilingAt(x, z, SCATTER.shelter, y + 30, y + 0.1) < Infinity)) return null;
    const k1 = h(i, j, 4);
    const k2 = h(i, j, 5);
    const yaw = h(i, j, 6) * Math.PI * 2;
    const c = this.c;
    groundColour(c, x, z, y, y);
    const light = roofed ? coverAt(x, y + 0.2, z) : 1;
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3(x, y, z);
    const size = new THREE.Vector3();
    if (thing === "tuft") {
      const high = 0.22 + 0.25 * k1;
      size.set(high * (0.9 + k2 * 0.5), high, high * (0.9 + k2 * 0.5));
      q.setFromAxisAngle(this.up, yaw);
      pos.y -= 0.02;
      // Sage on the terraces, straw elsewhere.
      c.set(ground === "scrub" ? PAL.scrub : PAL.sand).lerp(SCRUB_DARK, ground === "scrub" ? k2 * 0.45 : 0.15 + k2 * 0.25);
      // Thin blades stand on edge to the sun and the sky: painted a step lighter than flat ground, so they read as dry grass, not as dark sticks.
      c.multiplyScalar(1.15);
    } else {
      // Flat marks lie along the slope; stones stand up.
      const g = terrainGrad(x, z);
      this.n.set(-g.x, 1, -g.z).normalize();
      this.tilt.setFromUnitVectors(this.up, this.n);
      q.setFromAxisAngle(this.up, yaw).premultiply(this.tilt);
      const dark = GROUND[ground === "soil" ? "dune" : ground].dark;
      if (thing === "stone") {
        const sz = 0.12 + 0.3 * k1 * k1;
        size.set(sz * (0.8 + 0.5 * k2), sz * (0.45 + 0.35 * k2), sz * (1.1 - 0.3 * k2));
        pos.y -= sz * 0.12;
        c.lerp(ROCK_DARK, 0.15).multiplyScalar(0.78 + 0.12 * k2);
      } else if (thing === "stain") {
        const sz = 0.6 + 1.1 * k1;
        size.set(sz, 0.03, sz * (0.6 + 0.4 * k2));
        pos.y -= 0.01;
        c.lerp(ground === "soil" ? SAND_DARK : dark, 0.6).multiplyScalar(0.94);
      } else {
        size.set(0.07, 0.025, 0.8 + 1.4 * k1);
        pos.y -= 0.008;
        c.lerp(dark, 0.7).multiplyScalar(0.72);
      }
    }
    c.multiplyScalar(light);
    return { tuft: thing === "tuft", flat: thing === "stain" || thing === "crack", pos, q, size, r: c.r, g: c.g, b: c.b };
  }

  private lay(ox: number, oz: number, reach: number) {
    const cell = SCATTER.cell;
    const r = Math.ceil(reach / cell);
    const ci = Math.floor(ox / cell);
    const cj = Math.floor(oz / cell);
    // Cells well out of reach are forgotten, so what is kept follows the camera.
    const keep = r + Math.ceil(SCATTER.move / cell) * 3;
    for (const key of this.cells.keys()) {
      const i = Math.round(key / 65536);
      const j = key - i * 65536;
      if (Math.abs(i - ci) > keep || Math.abs(j - cj) > keep) this.cells.delete(key);
    }
    let ns = 0;
    let nt = 0;
    for (let j = cj - r; j <= cj + r; j++)
      for (let i = ci - r; i <= ci + r; i++) {
        const it = this.thing(i, j);
        if (!it) continue;
        const dist = Math.hypot(it.pos.x - ox, it.pos.z - oz);
        if (dist > reach) continue;
        const im = it.tuft ? this.tufts : this.stones;
        const n = it.tuft ? nt++ : ns++;
        if (n >= SCATTER.max) continue;
        // Toward the edge of the reach things shrink away; a flat mark keeps its thickness.
        const shrink = Math.min(1, (reach - dist) / SCATTER.fade);
        this.s.set(it.size.x * shrink, it.flat ? it.size.y : it.size.y * shrink, it.size.z * shrink);
        im.setMatrixAt(n, this.m.compose(it.pos, it.q, this.s));
        im.setColorAt(n, this.c.setRGB(it.r, it.g, it.b));
      }
    for (const [im, n] of [
      [this.stones, Math.min(ns, SCATTER.max)],
      [this.tufts, Math.min(nt, SCATTER.max)],
    ] as const) {
      im.count = n;
      im.instanceMatrix.clearUpdateRanges();
      im.instanceMatrix.addUpdateRange(0, n * 16);
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) {
        im.instanceColor.clearUpdateRanges();
        im.instanceColor.addUpdateRange(0, n * 3);
        im.instanceColor.needsUpdate = true;
      }
      im.computeBoundingSphere();
    }
  }
}
