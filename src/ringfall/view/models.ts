import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { ENEMIES, type EnemyKind, type HealKind, type Rarity, type ToolKind, type ValuableKind, type WeaponKind } from "../sim/config";
import type { LootKind } from "../sim/state";
import { PROP, type Box } from "../sim/map";
import type { TrimPiece } from "./trim";

/*
 * Low-poly, flat-shaded models built from primitives. Colours come only from the
 * palette in docs/ringfall/brief.md: sand and rock outdoors, concrete and rust for
 * structures, navy armour with a red eye for robots, magenta for enemy fire.
 */

export const PAL = {
  skyTop: 0x7ec8e3,
  skyHorizon: 0xf4dcb0,
  sand: 0xd9a868,
  sandDark: 0xc4914f,
  /** The south coast's dunes: wind-blown sand, paler than the island's soil. */
  dune: 0xecd5a6,
  duneDark: 0xd9bd86,
  rock: 0xb0623c,
  rockDark: 0x8d4a2c,
  /** The quarry's rust-red bedrock, its floors and its cut walls. */
  quarry: 0xa9532f,
  quarryDark: 0x86402a,
  /** The mesa's orange sandstone, its top and its sheer cliffs. */
  sandstone: 0xdc8e4c,
  sandstoneDark: 0xbf6f38,
  /** The terraced fields: dry soil under a dull sage-green scrub. */
  scrub: 0xaaa678,
  scrubDark: 0x878a5e,
  /** The works and the housing: concrete stained with oil. */
  oiled: 0xb2ada2,
  oiledDark: 0x76726b,
  /** Dry-stone walls in the fields. */
  stone: 0xbcae92,
  /** White paint: the mast's bands, a runway's markings. */
  paint: 0xece8df,
  /** The dried lakebed: cracked clay, greyer than the sand. */
  mud: 0xb9a385,
  mudDark: 0x9c8669,
  /** The bleached band on the lakebed's walls, up to where the water stood. */
  tide: 0xe3d5ba,
  /** The harbor's salt flats (the dry bay floor) and its paved quays and streets. */
  salt: 0xece3cf,
  saltDark: 0xd6c9ad,
  paved: 0xc9b896,
  pavedDark: 0xb3a27f,
  /** The last water, left in the harbor's tidal channel. */
  water: 0x5fa8a6,
  /** Painted steel: a ship's hull below the old waterline, girders and posts. */
  hull: 0x6e3a2a,
  steel: 0x707780,
  /** The orbital tether's composite skin: a cool pale grey that reads apart from the warm concrete, its ribs darker, its broken ends scorched. */
  tether: 0xd6dcdd,
  tetherDark: 0x98a2a8,
  scorch: 0x4a3e36,
  concrete: 0xcfc8b8,
  concreteDark: 0x9c9586,
  rust: 0xb5482b,
  teal: 0x2f7f86,
  ochre: 0x8a6a3a,
  /** Crates: weathered timber, a warm brown under the sun rather than a toy orange. */
  crate: 0xb08a58,
  armor: 0x34407a,
  armorLight: 0x5563a0,
  joint: 0x151935,
  eye: 0xff2d4d,
  orb: 0xff3fb0,
  ring: 0xff5a2a,
  /** Raiders' armour: the plain robots' navy turned a dark red, so the elite squad reads at a glance. */
  eliteArmor: 0x6a1f2a,
  hot: 0xffe23d,
  white: 0xffffff,
  gun: 0x2b2f38,
  gunLight: 0x4a505c,
} as const;

/** Aim amount past which a scoped weapon shows its sight instead of the gun. */
export const SCOPE_IN = 0.85;

export const RARITY_COLOR = [0xeeeeee, 0x45a6ff, 0xb65cff, 0xffc93a] as const;
/** The band on health items, apart from the enemy red and the ring orange. */
const HEAL_RED = 0xe0475a;
export const RARITY_CSS = ["#eeeeee", "#45a6ff", "#b65cff", "#ffc93a"] as const;

const matCache = new Map<number, THREE.MeshLambertMaterial>();
/** Shared flat-shaded material per colour. */
export function flat(color: number): THREE.MeshLambertMaterial {
  let m = matCache.get(color);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color, flatShading: true });
    matCache.set(color, m);
  }
  return m;
}

/**
 * Unlit, and kept out of the tone mapping like every unlit material here: what glows (an eye, a
 * shot, a loot beam) shows the palette's colour exactly, brighter than anything the sun lights.
 */
export function glow(color: number, opacity = 1): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ toneMapped: false, color, transparent: opacity < 1, opacity, depthWrite: opacity >= 1 });
}

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0, shadow = true): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = shadow;
  m.receiveShadow = shadow;
  return m;
}

/** A soft round sprite texture for halos and particles. */
let haloTex: THREE.Texture | null = null;
export function halo(): THREE.Texture {
  if (haloTex) return haloTex;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.35, "rgba(255,255,255,0.55)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  haloTex = new THREE.CanvasTexture(c);
  return haloTex;
}

export function haloSprite(color: number, size: number, opacity = 0.9): THREE.Sprite {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ toneMapped: false, map: halo(), color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending }));
  s.scale.setScalar(size);
  return s;
}

/**
 * Deterministic jitter so rocks look chipped but never poke outside their collision
 * box. The offset depends only on the vertex position, so corners shared by several
 * faces move together and the surface stays closed.
 */
function chip(geo: THREE.BufferGeometry, seed: number, amount: number, w: number, h: number, d: number) {
  const pos = geo.attributes.position;
  const hash = (x: number, y: number, z: number) => {
    const v = Math.sin(Math.round(x * 100) * 12.9898 + Math.round(y * 100) * 78.233 + Math.round(z * 100) * 37.719 + seed * 4.1) * 43758.5453;
    return v - Math.floor(v);
  };
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const k = amount * hash(x, y, z);
    pos.setXYZ(i, x - Math.sign(x) * k * w * 0.5, y > 0 ? y - k * h * 0.4 : y, z - Math.sign(z) * k * d * 0.5);
  }
  geo.computeVertexNormals();
}

export function buildBox(b: Box, i: number): THREE.Object3D {
  const w = b.x1 - b.x0;
  const d = b.z1 - b.z0;
  const h = b.h - b.y0;
  const mid = b.y0 + h / 2;
  const g = new THREE.Group();
  g.position.set((b.x0 + b.x1) / 2, 0, (b.z0 + b.z1) / 2);
  switch (b.kind) {
    case "crate": {
      g.add(mesh(new THREE.BoxGeometry(w, h, d), flat(PAL.crate), 0, mid, 0));
      // Dark bands read as a crate, not a block.
      for (let y = 0.45; y < b.h; y += 0.9) g.add(mesh(new THREE.BoxGeometry(w + 0.03, 0.1, d + 0.03), flat(PAL.ochre), 0, y, 0, false));
      break;
    }
    case "container": {
      const color = [PAL.rust, PAL.teal, PAL.ochre][b.tint % 3];
      g.add(mesh(new THREE.BoxGeometry(w, h, d), flat(color), 0, mid, 0));
      const long = w > d;
      const len = long ? w : d;
      const ribMat = flat(new THREE.Color(color).multiplyScalar(0.78).getHex());
      for (let t = -len / 2 + 0.4; t < len / 2; t += 0.55) {
        const rib = new THREE.BoxGeometry(long ? 0.12 : w + 0.08, h - 0.2, long ? d + 0.08 : 0.12);
        g.add(mesh(rib, ribMat, long ? t : 0, mid, long ? 0 : t, false));
      }
      g.add(mesh(new THREE.BoxGeometry(w + 0.1, 0.12, d + 0.1), flat(PAL.concreteDark), 0, b.h, 0, false));
      break;
    }
    case "wall": {
      // tint 1: the low parapet around a roof; tint 2: red bands and roof tiles; tint 3: dry stone.
      g.add(mesh(new THREE.BoxGeometry(w, h, d), flat(b.tint === 1 ? PAL.concreteDark : b.tint === 2 ? PAL.rust : b.tint === 3 ? PAL.stone : PAL.concrete), 0, mid, 0));
      if (b.y0 === 0) g.add(mesh(new THREE.BoxGeometry(w + 0.04, Math.min(0.5, h), d + 0.04), flat(PAL.concreteDark), 0, Math.min(0.5, h) / 2, 0, false));
      break;
    }
    case "slab": {
      g.add(mesh(new THREE.BoxGeometry(w, h, d), flat(PAL.concreteDark), 0, mid, 0));
      g.add(mesh(new THREE.BoxGeometry(w + 0.06, 0.08, d + 0.06), flat(PAL.rust), 0, b.y0 + 0.04, 0, false));
      break;
    }
    case "step": {
      g.add(mesh(new THREE.BoxGeometry(w, h, d), flat(b.tint === 1 ? PAL.rockDark : PAL.concreteDark), 0, mid, 0));
      break;
    }
    case "steel": {
      // tint 0: rust-red plate, 1: the dark hull, 2: grey girders and posts, 3: teal paint, 4: white paint,
      // 5: the tether's composite skin, 6: its ribs, 7: scorch where it broke.
      const color = [PAL.rust, PAL.hull, PAL.steel, PAL.teal, PAL.paint, PAL.tether, PAL.tetherDark, PAL.scorch][b.tint % 8];
      g.add(mesh(new THREE.BoxGeometry(w, h, d), flat(color), 0, mid, 0));
      // Big plates carry a darker seam along their top, so a hull reads as riveted plate.
      if (h > 2 && Math.max(w, d) > 4) g.add(mesh(new THREE.BoxGeometry(w + 0.04, 0.14, d + 0.04), flat(new THREE.Color(color).multiplyScalar(0.72).getHex()), 0, b.h - 0.25, 0, false));
      break;
    }
    case "fence": {
      // A gate of steel bars in a frame: bars across the thin side, a rail top, middle and foot.
      const along = w >= d;
      const len = along ? w : d;
      const thick = Math.min(w, d);
      const bar = flat(PAL.steel);
      for (let t = -len / 2 + 0.06; t <= len / 2 - 0.06; t += 0.16) g.add(mesh(new THREE.BoxGeometry(along ? 0.04 : thick, h, along ? thick : 0.04), bar, along ? t : 0, mid, along ? 0 : t, false));
      for (const y of [b.y0 + 0.08, mid, b.h - 0.08]) g.add(mesh(new THREE.BoxGeometry(along ? w : thick + 0.02, 0.12, along ? thick + 0.02 : d), flat(PAL.hull), 0, y, 0, false));
      break;
    }
    case "rock": {
      const geo = new THREE.BoxGeometry(w, h, d, 3, 2, 3).toNonIndexed();
      chip(geo, i + 3, 0.18, w, h, d);
      g.add(mesh(geo, flat(PAL.rock), 0, mid, 0));
      break;
    }
    case "pad": {
      g.add(mesh(new THREE.BoxGeometry(w, h, d), flat(0x5b5f66), 0, mid, 0));
      const ring = new THREE.Mesh(new THREE.RingGeometry(3.2, 3.6, 40), glow(PAL.hot));
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = b.h + 0.02;
      g.add(ring);
      break;
    }
    case "tower": {
      g.add(mesh(new THREE.BoxGeometry(w, h, d), flat(PAL.concrete), 0, mid, 0));
      g.add(mesh(new THREE.BoxGeometry(w + 0.2, 0.2, d + 0.2), flat(PAL.rust), 0, b.h, 0, false));
      if (b.tint === 1) {
        // The relay mast.
        g.add(mesh(new THREE.CylinderGeometry(0.08, 0.14, 9, 6), flat(PAL.gunLight), w / 2 - 0.4, b.h + 4.5, -d / 2 + 0.4));
        const dish = mesh(new THREE.CylinderGeometry(0.9, 0.2, 0.4, 10, 1, true), flat(PAL.concrete), w / 2 - 0.4, b.h + 6.5, -d / 2 + 0.4);
        dish.rotation.x = 0.8;
        g.add(dish);
        const light = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), glow(PAL.eye));
        light.position.set(w / 2 - 0.4, b.h + 9.1, -d / 2 + 0.4);
        g.add(light);
      }
      break;
    }
  }
  return g;
}

/** The scattered cover's own colours (`prop` boxes): muted, so the set pieces read as worn things, not toys. */
const PROP_PAL = {
  wood: 0x9c7d52,
  wraps: [0xa8a28e, 0x9a9476, 0xb39a70] as const,
  bag: 0xb3a07a,
  bagSeam: 0x958360,
  barrier: 0xc8c1b0,
  barrierFoot: 0xa39c8b,
  cab: 0x98a48e,
  tarp: 0xab9d72,
  car: 0xa89f8f,
  glass: 0x67757a,
  /** The frame rail under a truck and the slats under a pallet: sun-dried grey, not black. */
  chassis: 0x6a6660,
  tyre: 0x3e3f42,
  /** The camp's khaki tarps, the yellow notice among the white on its board, a bedroll, the land on the map table's map. */
  canvas: 0xb9a37a,
  note: 0xeedc8a,
  mat: 0x6f7e5c,
  mapLand: 0xd9a868,
} as const;

/** A wheel for a vehicle prop: a dark disc standing at (x, z) on the ground, its axle across the vehicle, which runs along x when `alongX`. */
function wheel(g: THREE.Group, x: number, z: number, r: number, alongX: boolean, ground: number) {
  const m = mesh(new THREE.CylinderGeometry(r, r, 0.32, 10), flat(PROP_PAL.tyre), x, ground + r, z);
  m.rotation[alongX ? "x" : "z"] = Math.PI / 2;
  g.add(m);
}

/**
 * A piece of the cover scattered over the open ground (`prop` boxes, map.ts), drawn inside its
 * box as the thing it is: stacked pallets, a sandbag line, a road barrier, a truck's cab or bed,
 * a car, a heap of rubble.
 */
function buildProp(b: Box, i: number): THREE.Object3D {
  const w = b.x1 - b.x0;
  const d = b.z1 - b.z0;
  const h = b.h - b.y0;
  const mid = b.y0 + h / 2;
  const long = w >= d;
  const L = long ? w : d;
  const W = long ? d : w;
  // A box `l` long and `wd` across the piece, from height y0 to y1, at `t` along it.
  const part = (l: number, wd: number, y0: number, y1: number, color: number, t = 0, shadow = true) =>
    mesh(new THREE.BoxGeometry(long ? l : wd, y1 - y0, long ? wd : l), flat(color), long ? t : 0, b.y0 + (y0 + y1) / 2, long ? 0 : t, shadow);
  const g = new THREE.Group();
  g.position.set((b.x0 + b.x1) / 2, 0, (b.z0 + b.z1) / 2);
  switch (b.tint) {
    case PROP.pallets: {
      // A pallet under every metre of goods, the goods shrink-wrapped in one of three colours.
      const wrap = PROP_PAL.wraps[i % 3];
      for (let y = 0; y < h - 0.05; y += 1.0) {
        const top = Math.min(h, y + 1.0);
        g.add(part(L, W, y, y + 0.14, PROP_PAL.wood));
        for (const t of [-L / 2 + 0.1, 0, L / 2 - 0.1]) g.add(part(0.12, W + 0.02, y + 0.02, y + 0.1, PROP_PAL.chassis, t, false));
        g.add(part(L - 0.08, W - 0.08, y + 0.14, top, wrap));
      }
      break;
    }
    case PROP.sandbags: {
      // Lumpy bags in courses, a seam between each course.
      const geo = new THREE.BoxGeometry(w, h, d, Math.max(2, Math.round(L / 0.5)), 4, 2).toNonIndexed();
      chip(geo, i + 7, 0.08, w, h, d);
      g.add(mesh(geo, flat(PROP_PAL.bag), 0, mid, 0));
      for (let y = 0.27; y < h - 0.1; y += 0.27) g.add(part(L - 0.06, W + 0.01, y - 0.025, y + 0.025, PROP_PAL.bagSeam, 0, false));
      break;
    }
    case PROP.barrier: {
      // A concrete road barrier: a wide foot, a sloped waist, a narrow top, scuffed dark at the foot.
      g.add(part(L, W, 0, 0.32, PROP_PAL.barrierFoot));
      g.add(part(L, W * 0.72, 0.32, 0.55, PROP_PAL.barrier));
      g.add(part(L, W * 0.42, 0.55, h, PROP_PAL.barrier));
      break;
    }
    case PROP.cab:
    case PROP.bed: {
      const cab = b.tint === PROP.cab;
      // Wheels and chassis below, a grey frame rail between them.
      const r = 0.5;
      // The cab is wider (2.5 m) than it is long, so the truck runs across its longer side.
      const run = cab ? d > w : long;
      for (const t of cab ? [0] : [-L / 2 + 1.0, L / 2 - 1.2]) for (const s of [-1, 1]) wheel(g, run ? t : s * ((run ? d : w) / 2 - 0.17), run ? s * ((run ? d : w) / 2 - 0.17) : t, r, run, b.y0);
      g.add(part(L, W * 0.6, 0.35, 0.95, PROP_PAL.chassis));
      if (cab) {
        // The cab: a faded body, a band of dusty glass all round, a bumper.
        g.add(part(L, W, 0.95, h - 0.95, PROP_PAL.cab));
        g.add(part(L - 0.1, W - 0.1, h - 0.95, h - 0.12, PROP_PAL.glass));
        g.add(part(L, W, h - 0.12, h, PROP_PAL.cab));
      } else {
        // The bed: a steel deck and its load under a tarp, the tarp's ribs showing.
        g.add(part(L, W, 0.95, 1.2, PAL.steel));
        g.add(part(L - 0.1, W - 0.06, 1.2, h, PROP_PAL.tarp));
        for (let t = -L / 2 + 0.6; t < L / 2 - 0.3; t += 1.2) g.add(part(0.1, W, 1.2, h, new THREE.Color(PROP_PAL.tarp).multiplyScalar(0.88).getHex(), t, false));
      }
      break;
    }
    case PROP.car: {
      // A car left on its rims: a faded body to the waist, a glass house on top, set in from its sides.
      for (const t of [-L / 2 + 0.85, L / 2 - 0.85]) for (const s of [-1, 1]) wheel(g, long ? t : s * (W / 2 - 0.16), long ? s * (W / 2 - 0.16) : t, 0.34, long, b.y0);
      g.add(part(L, W, 0.3, 0.92, PROP_PAL.car));
      g.add(part(L * 0.55, W - 0.2, 0.92, h, PROP_PAL.glass, -L * 0.05));
      g.add(part(L * 0.55 - 0.1, W - 0.1, h - 0.06, h, PROP_PAL.car, -L * 0.05));
      break;
    }
    case PROP.tarp: {
      // A canvas sheet stretched flat over a camp's station, its hem a shade darker; teal or khaki by turns.
      const cloth = i % 2 ? PROP_PAL.canvas : PAL.teal;
      g.add(part(L, W, 0, h, cloth));
      g.add(part(L + 0.04, W + 0.04, -0.12, 0.02, new THREE.Color(cloth).multiplyScalar(0.8).getHex(), 0, false));
      break;
    }
    case PROP.table:
    case PROP.bench: {
      // A timber top on four legs. The map table carries the island's map, the bench a vice and its tools.
      const top = 0.08;
      g.add(part(L, W, h - top, h, PROP_PAL.wood));
      for (const t of [-L / 2 + 0.12, L / 2 - 0.12]) for (const v of [-W / 2 + 0.1, W / 2 - 0.1]) g.add(mesh(new THREE.BoxGeometry(0.09, h - top, 0.09), flat(PROP_PAL.chassis), long ? t : v, b.y0 + (h - top) / 2, long ? v : t));
      if (b.tint === PROP.table) {
        g.add(part(L * 0.8, W * 0.75, h, h + 0.01, PAL.paint, 0, false));
        g.add(part(L * 0.3, W * 0.4, h + 0.01, h + 0.02, PROP_PAL.mapLand, -L * 0.12, false));
        g.add(part(L * 0.22, W * 0.3, h + 0.01, h + 0.02, PROP_PAL.mapLand, L * 0.22, false));
        g.add(part(0.06, W * 0.6, h + 0.02, h + 0.025, PAL.ring, L * 0.05, false));
      } else {
        g.add(part(0.3, 0.22, h, h + 0.22, PAL.gun, -L / 2 + 0.35));
        g.add(part(0.7, 0.3, h, h + 0.12, PAL.rust, 0.2));
        g.add(part(0.5, 0.08, h, h + 0.05, PAL.gunLight, L / 2 - 0.5, false));
        g.add(part(L * 0.9, 0.06, 0.25, 0.32, PROP_PAL.wood, 0, false));
      }
      break;
    }
    case PROP.board: {
      // A board of timber with notices pinned to it, white and one pale yellow, a teal band across the top.
      g.add(part(L, W, 0, h, PROP_PAL.wood));
      g.add(part(L, W + 0.02, h - 0.14, h - 0.04, PAL.teal, 0, false));
      const notes: [number, number, number][] = [[-0.95, 0.55, 0.42], [-0.3, 0.75, 0.36], [0.35, 0.5, 0.44], [0.95, 0.7, 0.34], [-0.6, 0.15, 0.3], [0.6, 0.12, 0.3]];
      notes.forEach(([t, y, sz], n) => {
        const paper = mesh(new THREE.BoxGeometry(long ? sz : W + 0.03, sz * 1.25, long ? W + 0.03 : sz), flat(n === 2 ? PROP_PAL.note : PAL.paint), long ? t * (L / 3) : 0, b.y0 + y + 0.15, long ? 0 : t * (L / 3), false);
        g.add(paper);
      });
      break;
    }
    case PROP.shelf: {
      // Grey steel shelving, three boards high, with crates and wrapped goods on them.
      const posts = flat(PAL.steel);
      for (const t of [-L / 2 + 0.04, L / 2 - 0.04]) for (const v of [-W / 2 + 0.04, W / 2 - 0.04]) g.add(mesh(new THREE.BoxGeometry(0.06, h, 0.06), posts, long ? t : v, mid, long ? v : t, false));
      [0.15, 0.85, 1.55].forEach((y, k) => {
        g.add(part(L, W, y, y + 0.04, PAL.steel));
        for (let n = 0; n < 3; n++) {
          if ((n + k) % 4 === 3) continue;
          const t = -L / 2 + (n + 0.5) * (L / 3);
          const hgt = 0.3 + ((n * 7 + k * 3) % 4) * 0.08;
          g.add(part(L / 3 - 0.12, W - 0.1, y + 0.04, y + 0.04 + hgt, (n + k) % 2 ? PAL.crate : PROP_PAL.wraps[(n + k) % 3], t));
        }
      });
      break;
    }
    case PROP.counter: {
      // The stall's counter: crates of timber for a front, a plank on top, goods laid out on it.
      g.add(part(L, W, 0, h - 0.06, PAL.crate));
      for (let t = -L / 2 + 0.6; t < L / 2 - 0.3; t += 0.9) g.add(part(0.06, W + 0.02, 0.1, h - 0.1, PAL.ochre, t, false));
      g.add(part(L + 0.1, W + 0.15, h - 0.06, h, PROP_PAL.wood));
      g.add(part(0.4, 0.3, h, h + 0.18, PAL.teal, -L / 4, false));
      g.add(part(0.3, 0.3, h, h + 0.12, PROP_PAL.wraps[1], L / 6, false));
      break;
    }
    case PROP.bedroll: {
      // A sleeping mat rolled out on the sand, its rolled head a little higher.
      g.add(part(L, W, 0, h * 0.55, PROP_PAL.mat));
      g.add(part(0.45, W, 0, h, new THREE.Color(PROP_PAL.mat).multiplyScalar(0.85).getHex(), -L / 2 + 0.25));
      break;
    }
    default: {
      // Rubble: a broken heap of concrete.
      const geo = new THREE.BoxGeometry(w, h, d, 3, 2, 3).toNonIndexed();
      chip(geo, i + 11, 0.3, w, h, d);
      g.add(mesh(geo, flat(PAL.concreteDark), 0, mid, 0));
    }
  }
  return g;
}

/** A static box of the world as drawn: the scattered cover by `buildProp()`, the rest by `buildBox()`. */
export function buildStatic(b: Box, i: number): THREE.Object3D {
  return b.kind === "prop" ? buildProp(b, i) : buildBox(b, i);
}

/**
 * Merge every mesh under `root` into one mesh per material. The island is a few
 * hundred static boxes; drawn one by one they cost a draw call each.
 */
export function mergeStatic(root: THREE.Object3D): THREE.Group {
  root.updateMatrixWorld(true);
  const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const geo = (o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone()).applyMatrix4(o.matrixWorld);
    for (const name of Object.keys(geo.attributes)) if (!["position", "normal"].includes(name)) geo.deleteAttribute(name);
    const list = byMat.get(o.material as THREE.Material);
    if (list) list.push(geo);
    else byMat.set(o.material as THREE.Material, [geo]);
  });
  const out = new THREE.Group();
  for (const [mat, geos] of byMat) {
    const merged = mergeGeometries(geos, false);
    if (!merged) continue;
    const m = new THREE.Mesh(merged, mat);
    m.castShadow = m.receiveShadow = !(mat instanceof THREE.MeshBasicMaterial);
    out.add(m);
  }
  return out;
}

/**
 * Baked shade for a chunk's merged statics, from the world's boxes (shade.ts): the light a point
 * keeps under what covers it, and the floor a face standing at `bottom` rests on.
 */
export interface ChunkShade {
  cover(x: number, y: number, z: number): number;
  floor(x: number, z: number, bottom: number): number;
  /** Light left at the very foot of a wall, and how far up it the darkening reaches. */
  base: number;
  baseUp: number;
}

/** A height above any floor: no darkening at the foot of the face. */
const NO_FLOOR = 99;

/**
 * The one material a chunk's merged statics share: each vertex carries its own colour, and its
 * height above the floor its face stands on (`contact`), which darkens the foot of a wall per
 * pixel. A wall's faces have vertices only at their top and bottom; the height between them is
 * linear, so it is exact across the face without splitting it.
 */
const chunkMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
let chunkBase = { base: 1, baseUp: 1 };
chunkMat.onBeforeCompile = (sh) => {
  sh.uniforms.contactBase = { value: chunkBase.base };
  sh.uniforms.contactUp = { value: chunkBase.baseUp };
  sh.vertexShader = sh.vertexShader
    .replace("#include <common>", "#include <common>\nattribute float contact;\nvarying float vContact;")
    .replace("#include <begin_vertex>", "#include <begin_vertex>\nvContact = contact;");
  sh.fragmentShader = sh.fragmentShader
    .replace("#include <common>", "#include <common>\nvarying float vContact;\nuniform float contactBase;\nuniform float contactUp;")
    .replace("#include <color_fragment>", "#include <color_fragment>\ndiffuseColor.rgb *= mix(contactBase, 1.0, smoothstep(0.0, contactUp, vContact));");
};

/**
 * Merge every mesh under `root` into as few meshes as possible: all flat-shaded ones into
 * one, their colours moved into the vertices, and the rest one per material. A chunk of
 * the world so costs one or two draw calls, and is culled as a whole. With `shade`, the
 * colours carry the shade of what covers each face and each wall's foot is darkened.
 */
export function mergeChunk(root: THREE.Object3D, shade?: ChunkShade): THREE.Group {
  if (shade && (shade.base !== chunkBase.base || shade.baseUp !== chunkBase.baseUp)) {
    chunkBase = { base: shade.base, baseUp: shade.baseUp };
    chunkMat.needsUpdate = true;
  }
  root.updateMatrixWorld(true);
  const lit: THREE.BufferGeometry[] = [];
  const other = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();
  const e = new THREE.Vector3();
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const geo = (o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone()).applyMatrix4(o.matrixWorld);
    for (const name of Object.keys(geo.attributes)) if (!["position", "normal"].includes(name)) geo.deleteAttribute(name);
    const mat = o.material as THREE.Material;
    if (mat instanceof THREE.MeshLambertMaterial && !mat.vertexColors && !mat.transparent) {
      const m = mat.color;
      const pos = geo.attributes.position;
      const count = pos.count;
      const col = new Float32Array(count * 3);
      const contact = new Float32Array(count).fill(NO_FLOOR);
      // A box's face is two triangles sharing an edge: the previous triangle's vertices and floor
      // are kept, and reused where the next one has the same normal, so each lookup is made once.
      const prev = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
      const prevLight = [1, 1, 1];
      const prevN = new THREE.Vector3(NaN, NaN, NaN);
      let prevBottom = NaN;
      let prevFloor = NaN;
      for (let t = 0; t + 2 < count; t += 3) {
        a.fromBufferAttribute(pos, t);
        b.fromBufferAttribute(pos, t + 1);
        c.fromBufferAttribute(pos, t + 2);
        n.subVectors(c, b).cross(e.subVectors(a, b)).normalize();
        const same = n.distanceToSquared(prevN) < 1e-6;
        const lights = [1, 1, 1];
        for (let k = 0; k < 3; k++) {
          const v = k === 0 ? a : k === 1 ? b : c;
          let light = 1;
          if (shade) {
            const hit = same ? prev.findIndex((q) => q.distanceToSquared(v) < 1e-8) : -1;
            light = hit >= 0 ? prevLight[hit] : shade.cover(v.x + n.x * 0.2, v.y + n.y * 0.2, v.z + n.z * 0.2);
          }
          lights[k] = light;
          col.set([m.r * light, m.g * light, m.b * light], (t + k) * 3);
        }
        // A wall-like face whose bottom edge rests on a floor: its height above that floor.
        if (shade && Math.abs(n.y) < 0.5) {
          const bottom = Math.min(a.y, b.y, c.y);
          const floor =
            same && bottom === prevBottom ? prevFloor : shade.floor((a.x + b.x + c.x) / 3 + n.x * 0.15, (a.z + b.z + c.z) / 3 + n.z * 0.15, bottom);
          prevBottom = bottom;
          prevFloor = floor;
          if (bottom - floor < 0.35) for (let k = 0; k < 3; k++) contact[t + k] = pos.getY(t + k) - floor;
        }
        prev[0].copy(a);
        prev[1].copy(b);
        prev[2].copy(c);
        for (let k = 0; k < 3; k++) prevLight[k] = lights[k];
        prevN.copy(n);
      }
      geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
      geo.setAttribute("contact", new THREE.BufferAttribute(contact, 1));
      lit.push(geo);
    } else {
      const list = other.get(mat);
      if (list) list.push(geo);
      else other.set(mat, [geo]);
    }
  });
  const out = new THREE.Group();
  const merged = lit.length ? mergeGeometries(lit, false) : null;
  if (merged) {
    const m = new THREE.Mesh(merged, chunkMat);
    m.castShadow = m.receiveShadow = true;
    out.add(m);
  }
  for (const [mat, geos] of other) {
    const g = mergeGeometries(geos, false);
    if (!g) continue;
    const m = new THREE.Mesh(g, mat);
    m.castShadow = m.receiveShadow = !(mat instanceof THREE.MeshBasicMaterial);
    out.add(m);
  }
  return out;
}

/** A unit box's faces, two triangles each, six vertices in a row: positions and normals. */
const UNIT_BOX = (() => {
  const g = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
  return { pos: g.attributes.position.array as Float32Array, nor: g.attributes.normal.array as Float32Array };
})();

/**
 * Merges a chunk's trim (trim.ts) into one mesh on the chunks' material that casts no shadow.
 * Trim is many small boxes, so each face is lit by one lookup at its middle (`cover`, the light
 * left by what covers it) rather than one per corner, and no foot of it is darkened.
 */
export function mergeTrim(pieces: readonly TrimPiece[], cover: (x: number, y: number, z: number) => number): THREE.Mesh | null {
  if (!pieces.length) return null;
  const n = UNIT_BOX.pos.length;
  const pos = new Float32Array(pieces.length * n);
  const nor = new Float32Array(pieces.length * n);
  const col = new Float32Array(pieces.length * n);
  const c = new THREE.Color();
  let o = 0;
  for (const p of pieces) {
    c.setHex(p.color);
    for (let f = 0; f < n; f += 18) {
      // The face's middle is its unit normal times half the box, from the box's middle.
      const nx = UNIT_BOX.nor[f];
      const ny = UNIT_BOX.nor[f + 1];
      const nz = UNIT_BOX.nor[f + 2];
      const light = cover(p.x + nx * (p.sx / 2 + 0.1), p.y + ny * (p.sy / 2 + 0.1), p.z + nz * (p.sz / 2 + 0.1));
      for (let v = f; v < f + 18; v += 3) {
        pos[o + v] = p.x + UNIT_BOX.pos[v] * p.sx;
        pos[o + v + 1] = p.y + UNIT_BOX.pos[v + 1] * p.sy;
        pos[o + v + 2] = p.z + UNIT_BOX.pos[v + 2] * p.sz;
        nor[o + v] = nx;
        nor[o + v + 1] = ny;
        nor[o + v + 2] = nz;
        col[o + v] = c.r * light;
        col[o + v + 1] = c.g * light;
        col[o + v + 2] = c.b * light;
      }
    }
    o += n;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geo.setAttribute("contact", new THREE.BufferAttribute(new Float32Array(pos.length / 3).fill(NO_FLOOR), 1));
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, chunkMat);
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * Merges the meshes directly under `g` into one mesh per material, leaving its sub-groups and
 * the meshes in `keep` as they are; the merged mesh casts a shadow if any of its parts did. A
 * figure is built from dozens of boxes for its shape; drawn one by one each costs a draw call,
 * twice with shadows.
 */
function compact(g: THREE.Object3D, keep: readonly THREE.Object3D[] = []): void {
  const groups = new Map<THREE.Material, { shadow: boolean; geos: THREE.BufferGeometry[] }>();
  for (const o of [...g.children]) {
    if (!(o instanceof THREE.Mesh) || keep.includes(o)) continue;
    o.updateMatrix();
    const geo = (o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone()).applyMatrix4(o.matrix);
    for (const name of Object.keys(geo.attributes)) if (!["position", "normal"].includes(name)) geo.deleteAttribute(name);
    const mat = o.material as THREE.Material;
    const entry = groups.get(mat) ?? { shadow: false, geos: [] };
    entry.shadow ||= o.castShadow;
    entry.geos.push(geo);
    groups.set(mat, entry);
    g.remove(o);
    o.geometry.dispose();
  }
  for (const [mat, { shadow, geos }] of groups) {
    const merged = mergeGeometries(geos, false);
    if (!merged) continue;
    const m = new THREE.Mesh(merged, mat);
    m.castShadow = m.receiveShadow = shadow;
    g.add(m);
  }
}

export interface EnemyModel {
  root: THREE.Group;
  body: THREE.Group; // rotated to the robot's yaw
  eye: THREE.Mesh;
  eyeHalo: THREE.Sprite;
  shield: THREE.Mesh;
  legs: THREE.Object3D[];
  /** The lower leg of each of `legs` (same order), bent at the knee as it walks; empty when the legs are one piece. */
  knees: THREE.Object3D[];
  mats: THREE.MeshLambertMaterial[]; // flashed white on hits
}

/**
 * A box spanning from `a` to `b` (its length) with a cross-section `w` by `d`: a limb's segment
 * between two joints, so arms and legs are posed by where their joints are.
 */
function limb(a: THREE.Vector3Like, b: THREE.Vector3Like, w: number, d: number, mat: THREE.Material, shadow = true): THREE.Mesh {
  const from = new THREE.Vector3(a.x, a.y, a.z);
  const dir = new THREE.Vector3(b.x, b.y, b.z).sub(from);
  const m = mesh(new THREE.BoxGeometry(w, dir.length(), d), mat, 0, 0, 0, shadow);
  m.position.copy(from).addScaledVector(dir, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  return m;
}

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** The parts of a walking machine's leg, from hip to sole, in metres. */
interface LegSpec {
  hipX: number;
  hipY: number;
  thigh: number;
  shin: number;
  /** Thigh and shin width (x) and depth (z). */
  w: number;
  d: number;
  /** The foot's length (z), height and width. */
  foot: [number, number, number];
}

/**
 * Two legs of a walking robot: a thigh hung from the hip and a shin hung from the knee, each a
 * group turned about its joint, so the walk swings the thigh and bends the knee. The sole lands
 * at y 0 when the legs are straight.
 */
function robotLegs(body: THREE.Group, spec: LegSpec, armor: THREE.Material, light: THREE.Material, legs: THREE.Object3D[], knees: THREE.Object3D[]) {
  const [fl, fh, fw] = spec.foot;
  for (const s of [-1, 1]) {
    const leg = new THREE.Group();
    leg.position.set(s * spec.hipX, spec.hipY, 0);
    leg.add(mesh(new THREE.BoxGeometry(spec.w, spec.thigh * 0.86, spec.d), armor, 0, -spec.thigh / 2, 0));
    const knee = new THREE.Group();
    knee.position.y = -spec.thigh;
    // The knee joint, the knee cap and the shin's front plate in the lighter armour, the rest in
    // the armour: two materials a segment, so a leg costs few draw calls.
    knee.add(mesh(new THREE.BoxGeometry(spec.w * 0.86, spec.w * 0.7, spec.d * 0.9), light, 0, 0, 0));
    knee.add(mesh(new THREE.BoxGeometry(spec.w * 0.8, spec.w * 0.55, 0.06), light, 0, 0.02, -spec.d * 0.52));
    knee.add(mesh(new THREE.BoxGeometry(spec.w * 0.9, spec.shin * 0.82, spec.d * 0.92), armor, 0, -spec.shin * 0.48, 0));
    knee.add(mesh(new THREE.BoxGeometry(spec.w * 0.7, spec.shin * 0.5, 0.05), light, 0, -spec.shin * 0.42, -spec.d * 0.48));
    knee.add(mesh(new THREE.BoxGeometry(spec.w * 0.6, 0.08, spec.d * 0.6), light, 0, -spec.shin + fh + 0.02, 0));
    knee.add(mesh(new THREE.BoxGeometry(fw, fh, fl), armor, 0, -spec.shin + fh / 2, -fl * 0.18));
    leg.add(knee);
    body.add(leg);
    legs.push(leg);
    knees.push(knee);
  }
}


export function buildEnemy(kind: EnemyKind): EnemyModel {
  const k = ENEMIES[kind];
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const armor = new THREE.MeshLambertMaterial({ color: PAL.armor, flatShading: true });
  const light = new THREE.MeshLambertMaterial({ color: PAL.armorLight, flatShading: true });
  const joint = flat(PAL.joint);
  const legs: THREE.Object3D[] = [];
  const knees: THREE.Object3D[] = [];
  const eye = new THREE.Mesh(new THREE.SphereGeometry(k.weakR * 0.75, 10, 8), glow(PAL.eye));
  const eyeHalo = haloSprite(PAL.eye, k.weakR * 4, 0.6);
  // Forward is -z in the body's frame (yaw 0 looks toward -z).
  const front = (y: number) => new THREE.Vector3(0, y, -k.weakFwd);
  switch (kind) {
    case "drone": {
      body.add(mesh(new THREE.OctahedronGeometry(k.radius, 0), armor));
      const ring = mesh(new THREE.TorusGeometry(k.radius * 1.2, 0.07, 4, 12), light);
      ring.rotation.x = Math.PI / 2;
      body.add(ring);
      for (const s of [-1, 1]) body.add(mesh(new THREE.BoxGeometry(0.9, 0.06, 0.25), joint, s * 0.85, 0.05, 0));
      eye.position.copy(front(0));
      break;
    }
    case "grunt": {
      // About 2.3 m: legs of 1.1 m (thigh, knee, shin, foot), a narrow waist, a chest 0.75 m
      // across with pads on the shoulders, two-part arms holding a rifle, and a sensor head on a
      // neck whose lens is the weak point (weakY). The chest fills the body sphere (bodyY, radius).
      robotLegs(body, { hipX: 0.17, hipY: 1.08, thigh: 0.52, shin: 0.56, w: 0.21, d: 0.25, foot: [0.38, 0.09, 0.21] }, armor, light, legs, knees);
      body.add(mesh(new THREE.BoxGeometry(0.48, 0.2, 0.3), joint, 0, 1.12, 0));
      body.add(mesh(new THREE.BoxGeometry(0.28, 0.2, 0.22), joint, 0, 1.29, 0));
      body.add(mesh(new THREE.BoxGeometry(0.54, 0.22, 0.38), light, 0, 1.42, 0));
      body.add(mesh(new THREE.BoxGeometry(0.8, 0.46, 0.5), armor, 0, 1.68, 0));
      body.add(mesh(new THREE.BoxGeometry(0.58, 0.24, 0.05), light, 0, 1.74, -0.26));
      // A pack on the back, with a whip antenna (thin: it may stand out of the hit volume).
      body.add(mesh(new THREE.BoxGeometry(0.48, 0.44, 0.22), joint, 0, 1.66, 0.34));
      body.add(mesh(new THREE.CylinderGeometry(0.012, 0.018, 0.6, 4), joint, 0.16, 2.12, 0.38, false));
      for (const s of [-1, 1]) {
        const pad = mesh(new THREE.BoxGeometry(0.26, 0.15, 0.36), light, s * 0.48, 1.92, 0);
        pad.rotation.z = -s * 0.25;
        body.add(pad);
        const shoulder = v3(s * 0.48, 1.8, 0);
        const elbow = v3(s * 0.5, 1.46, -0.08);
        // Both hands meet the rifle: the right on the grip, the left under the barrel.
        const hand = s > 0 ? v3(0.17, 1.4, -0.38) : v3(0.08, 1.43, -0.6);
        body.add(mesh(new THREE.BoxGeometry(0.16, 0.16, 0.16), joint, shoulder.x, shoulder.y, 0));
        body.add(limb(shoulder, elbow, 0.15, 0.16, armor));
        body.add(mesh(new THREE.BoxGeometry(0.13, 0.13, 0.13), joint, elbow.x, elbow.y, elbow.z));
        body.add(limb(elbow, hand, 0.14, 0.15, light));
        body.add(mesh(new THREE.BoxGeometry(0.12, 0.12, 0.13), joint, hand.x, hand.y, hand.z));
      }
      body.add(mesh(new THREE.BoxGeometry(0.1, 0.15, 0.74), joint, 0.13, 1.47, -0.5));
      body.add(mesh(new THREE.BoxGeometry(0.05, 0.05, 0.3), joint, 0.13, 1.5, -1.01));
      body.add(mesh(new THREE.BoxGeometry(0.08, 0.16, 0.1), joint, 0.13, 1.34, -0.44));
      body.add(mesh(new THREE.BoxGeometry(0.15, 0.14, 0.15), joint, 0, 1.92, 0));
      // The head: a squat sensor block, a brow over the lens, and a short sensor mast on top.
      body.add(mesh(new THREE.BoxGeometry(0.42, 0.3, 0.38), armor, 0, k.weakY + 0.02, 0));
      body.add(mesh(new THREE.BoxGeometry(0.44, 0.06, 0.14), light, 0, k.weakY + 0.15, -0.14));
      for (const s of [-1, 1]) body.add(mesh(new THREE.BoxGeometry(0.06, 0.14, 0.16), joint, s * 0.24, k.weakY, -0.02));
      body.add(mesh(new THREE.BoxGeometry(0.05, 0.12, 0.05), joint, -0.1, k.weakY + 0.23, 0.08, false));
      eye.geometry.dispose();
      eye.geometry = new THREE.SphereGeometry(k.weakR * 0.55, 10, 8).scale(1.15, 0.7, 0.55);
      eye.position.copy(front(k.weakY));
      eye.position.z -= 0.12;
      break;
    }
    case "charger": {
      const torso = mesh(new THREE.ConeGeometry(0.75, 1.5, 4), armor, 0, 0.8, 0);
      torso.rotation.x = -Math.PI / 2;
      torso.rotation.y = Math.PI / 4;
      body.add(torso);
      body.add(mesh(new THREE.BoxGeometry(1.1, 0.25, 0.9), light, 0, 0.55, 0.25));
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const leg = new THREE.Group();
        leg.position.set(sx * 0.55, 0.55, sz * 0.4);
        leg.add(mesh(new THREE.BoxGeometry(0.16, 0.55, 0.16), joint, 0, -0.27, 0));
        body.add(leg);
        legs.push(leg);
      }
      eye.position.copy(front(k.weakY));
      break;
    }
    case "heavy": {
      // About 3.3 m: a long-legged walker with a chest 1.5 m across and shoulders that carry its
      // rocket pods; its arms hang heavy at its sides. The lens on its head is the weak point
      // (weakY); the chest and shoulders fill the body sphere (bodyY, radius).
      robotLegs(body, { hipX: 0.35, hipY: 1.47, thigh: 0.72, shin: 0.75, w: 0.35, d: 0.42, foot: [0.6, 0.14, 0.37] }, armor, light, legs, knees);
      body.add(mesh(new THREE.BoxGeometry(0.84, 0.33, 0.53), joint, 0, 1.54, 0));
      body.add(mesh(new THREE.BoxGeometry(0.58, 0.26, 0.46), joint, 0, 1.77, 0));
      body.add(mesh(new THREE.BoxGeometry(1.1, 0.38, 0.81), light, 0, 1.95, 0));
      body.add(mesh(new THREE.BoxGeometry(1.5, 0.8, 1.0), armor, 0, 2.48, 0));
      body.add(mesh(new THREE.BoxGeometry(1.05, 0.38, 0.07), light, 0, 2.56, -0.52));
      body.add(mesh(new THREE.BoxGeometry(0.93, 0.64, 0.35), joint, 0, 2.43, 0.64));
      for (const s of [-1, 1]) {
        // Shoulder pads, and the rocket pods slung behind them, their tubes' mouths facing forward.
        body.add(mesh(new THREE.BoxGeometry(0.53, 0.28, 0.7), light, s * 0.95, 2.9, 0));
        body.add(mesh(new THREE.BoxGeometry(0.42, 0.44, 0.77), light, s * 1.14, 3.02, 0.26));
        for (let j = 0; j < 2; j++) body.add(mesh(new THREE.BoxGeometry(0.13, 0.13, 0.05), joint, s * 1.14 + (j - 0.5) * 0.17, 3.04, -0.14, false));
        const shoulder = v3(s * 0.93, 2.69, 0);
        const elbow = v3(s * 1.0, 2.07, 0.02);
        const hand = v3(s * 0.93, 1.54, -0.26);
        body.add(limb(shoulder, elbow, 0.3, 0.32, armor));
        body.add(mesh(new THREE.BoxGeometry(0.26, 0.26, 0.26), joint, elbow.x, elbow.y, elbow.z));
        body.add(limb(elbow, hand, 0.35, 0.35, light));
        body.add(mesh(new THREE.BoxGeometry(0.28, 0.24, 0.28), joint, hand.x, hand.y - 0.06, hand.z));
      }
      body.add(mesh(new THREE.BoxGeometry(0.3, 0.18, 0.3), joint, 0, 2.92, 0));
      body.add(mesh(new THREE.BoxGeometry(0.63, 0.42, 0.58), armor, 0, k.weakY + 0.05, 0));
      body.add(mesh(new THREE.BoxGeometry(0.65, 0.08, 0.19), light, 0, k.weakY + 0.25, -0.24));
      eye.geometry.dispose();
      eye.geometry = new THREE.SphereGeometry(k.weakR * 0.55, 10, 8).scale(1.15, 0.7, 0.55);
      eye.position.copy(front(k.weakY));
      eye.position.z -= 0.19;
      break;
    }
    case "titan": {
      body.add(mesh(new THREE.BoxGeometry(4.2, 2.6, 3.4), armor, 0, 3.6, 0));
      body.add(mesh(new THREE.BoxGeometry(3.0, 0.9, 2.6), light, 0, 2.0, 0));
      body.add(mesh(new THREE.BoxGeometry(1.6, 1.0, 1.4), armor, 0, 5.3, -0.6));
      for (const s of [-1, 1]) {
        const leg = new THREE.Group();
        leg.position.set(s * 1.4, 2.2, 0);
        leg.add(mesh(new THREE.BoxGeometry(0.9, 2.2, 1.1), joint, 0, -1.1, 0));
        leg.add(mesh(new THREE.BoxGeometry(1.3, 0.35, 1.8), light, 0, -2.05, -0.2));
        body.add(leg);
        legs.push(leg);
        const pod = mesh(new THREE.BoxGeometry(1.2, 1.1, 2.0), light, s * 2.7, 4.6, 0.2);
        body.add(pod);
        for (let j = 0; j < 3; j++) body.add(mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.1, 8), glow(PAL.orb), s * 2.7 + (j - 1) * 0.35, 4.75, -0.85));
      }
      eye.position.copy(front(k.weakY));
      break;
    }
  }
  eyeHalo.position.copy(eye.position);
  body.add(eye, eyeHalo);
  compact(body, [eye]);
  for (const part of [...legs, ...knees]) compact(part);
  const shield = new THREE.Mesh(
    new THREE.IcosahedronGeometry(k.radius * (kind === "titan" ? 1.6 : 1.5), 1),
    new THREE.MeshBasicMaterial({ toneMapped: false, color: 0xffffff, transparent: true, opacity: 0, wireframe: true, depthWrite: false }),
  );
  shield.position.y = k.bodyY;
  root.add(shield);
  const mats: THREE.MeshLambertMaterial[] = [armor, light];
  return { root, body, eye, eyeHalo, shield, legs, knees, mats };
}

/** The front of each kind's body that a plate covers: width, height, centre height, and the face's z. */
const CHEST: Record<EnemyKind, { w: number; h: number; y: number; z: number }> = {
  drone: { w: 0.5, h: 0.32, y: 0.12, z: -0.42 },
  grunt: { w: 0.7, h: 0.54, y: 1.64, z: -0.26 },
  charger: { w: 0.7, h: 0.32, y: 1.0, z: -0.42 },
  heavy: { w: 1.33, h: 0.9, y: 2.38, z: -0.51 },
  titan: { w: 3.4, h: 2.2, y: 3.6, z: -1.7 },
};

/**
 * Armour plates bolted over the front of a robot's body, in its plate's rarity colour:
 * the player tells at a glance which robots their gun cannot pierce.
 */
export function addPlates(m: EnemyModel, kind: EnemyKind, tier: Rarity) {
  const c = CHEST[kind];
  const mat = flat(RARITY_COLOR[tier]);
  const t = c.w * 0.07;
  m.body.add(mesh(new THREE.BoxGeometry(c.w, c.h * 0.48, t), mat, 0, c.y + c.h * 0.22, c.z - t / 2));
  m.body.add(mesh(new THREE.BoxGeometry(c.w * 0.75, c.h * 0.32, t), mat, 0, c.y - c.h * 0.22, c.z - t / 2));
}

export interface AllyModel {
  root: THREE.Group;
  /** Turns with the teammate's yaw; tipped over when it is down. */
  body: THREE.Group;
  legs: THREE.Object3D[];
  /** The lower leg of each of `legs`, bent at the knee as it walks. */
  knees: THREE.Object3D[];
  /** Arms and rifle, pitched toward what it aims at. */
  arms: THREE.Group;
}

/**
 * The teammate: a person about 1.8 m tall in a teal suit and sand vest, so it reads as one of
 * ours at a glance against the navy robots. A neck and a helmet, knees, and arms in two parts
 * that hold the rifle at the shoulder. Nothing on it glows.
 */
export function buildAlly(): AllyModel {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const suit = flat(PAL.teal);
  const vest = flat(PAL.sand);
  const dark = flat(PAL.joint);
  const skin = flat(PAL.concrete);
  const legs: THREE.Object3D[] = [];
  const knees: THREE.Object3D[] = [];
  for (const s of [-1, 1]) {
    const leg = new THREE.Group();
    leg.position.set(s * 0.12, 0.92, 0);
    leg.add(mesh(new THREE.BoxGeometry(0.17, 0.44, 0.2), suit, 0, -0.22, 0));
    const knee = new THREE.Group();
    knee.position.y = -0.45;
    knee.add(mesh(new THREE.BoxGeometry(0.15, 0.12, 0.06), dark, 0, 0, -0.1));
    knee.add(mesh(new THREE.BoxGeometry(0.15, 0.4, 0.17), suit, 0, -0.21, 0));
    knee.add(mesh(new THREE.BoxGeometry(0.17, 0.11, 0.29), dark, 0, -0.415, -0.04));
    leg.add(knee);
    body.add(leg);
    legs.push(leg);
    knees.push(knee);
  }
  body.add(mesh(new THREE.BoxGeometry(0.38, 0.14, 0.24), dark, 0, 0.95, 0));
  body.add(mesh(new THREE.BoxGeometry(0.42, 0.52, 0.26), suit, 0, 1.22, 0));
  body.add(mesh(new THREE.BoxGeometry(0.46, 0.36, 0.3), vest, 0, 1.27, 0));
  body.add(mesh(new THREE.BoxGeometry(0.32, 0.42, 0.18), flat(PAL.ochre), 0, 1.24, 0.23));
  body.add(mesh(new THREE.BoxGeometry(0.11, 0.1, 0.11), skin, 0, 1.53, 0));
  // The head: the face under a teal helmet with a brim, a dark visor band across the eyes.
  body.add(mesh(new THREE.BoxGeometry(0.2, 0.22, 0.22), skin, 0, 1.66, 0));
  body.add(mesh(new THREE.BoxGeometry(0.25, 0.13, 0.27), suit, 0, 1.77, 0.01));
  body.add(mesh(new THREE.BoxGeometry(0.27, 0.03, 0.31), suit, 0, 1.715, -0.01));
  body.add(mesh(new THREE.BoxGeometry(0.21, 0.06, 0.03), dark, 0, 1.67, -0.115));
  const arms = new THREE.Group();
  arms.position.set(0, 1.42, 0);
  for (const s of [-1, 1]) {
    const shoulder = v3(s * 0.25, 0, 0);
    const elbow = v3(s * 0.24, -0.25, -0.12);
    const hand = s > 0 ? v3(0.09, -0.12, -0.36) : v3(0.03, -0.08, -0.58);
    arms.add(limb(shoulder, elbow, 0.11, 0.12, suit));
    arms.add(limb(elbow, hand, 0.1, 0.11, suit));
    arms.add(mesh(new THREE.BoxGeometry(0.08, 0.09, 0.09), dark, hand.x, hand.y, hand.z));
  }
  arms.add(mesh(new THREE.BoxGeometry(0.07, 0.11, 0.75), flat(PAL.gun), 0.06, -0.04, -0.48));
  arms.add(mesh(new THREE.BoxGeometry(0.06, 0.15, 0.08), flat(PAL.gunLight), 0.06, -0.15, -0.42));
  body.add(arms);
  for (const part of [body, arms, ...legs, ...knees]) compact(part);
  return { root, body, legs, knees, arms };
}

/** Each gun's length from muzzle to stock, metres before the first-person scale. */
const GUN_LEN: Record<WeaponKind, number> = { pike: 0.75, hornet: 0.5, maul: 0.8, lance: 1.0, talon: 1.25 };

/**
 * A gun, its muzzle toward -z: a slim receiver with an ejection port on its right, a rail along
 * its top, a barrel, a grip, a magazine and a stock, with a stripe in its rarity colour.
 */
export function buildGun(kind: WeaponKind, rarity: Rarity): THREE.Group {
  const g = new THREE.Group();
  const dark = flat(PAL.gun);
  const mid = flat(PAL.gunLight);
  const stripe = glow(RARITY_COLOR[rarity]);
  const add = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number) => {
    const o = new THREE.Mesh(geo, m);
    o.position.set(x, y, z);
    g.add(o);
    return o;
  };
  const len = GUN_LEN[kind];
  add(new THREE.BoxGeometry(0.075, 0.12, len * 0.6), dark, 0, 0, 0);
  add(new THREE.BoxGeometry(0.06, 0.08, len * 0.26), mid, 0, -0.01, -len * 0.42);
  add(new THREE.BoxGeometry(0.04, 0.04, len * 0.5), mid, 0, 0.03, -len * 0.5);
  add(new THREE.BoxGeometry(0.06, 0.15, 0.075), dark, 0, -0.12, 0.1);
  add(new THREE.BoxGeometry(0.05, 0.09, 0.24), mid, 0, -0.02, len * 0.38);
  add(new THREE.BoxGeometry(0.078, 0.016, len * 0.3), stripe, 0, 0.035, -0.02);
  // The rail along the top, notched, and the port the cases leave by on the right.
  add(new THREE.BoxGeometry(0.024, 0.014, len * 0.42), mid, 0, 0.067, -0.02);
  for (let t = -len * 0.19; t <= len * 0.17; t += 0.035) add(new THREE.BoxGeometry(0.03, 0.006, 0.012), dark, 0, 0.077, t - 0.02);
  add(new THREE.BoxGeometry(0.006, 0.04, 0.11), flat(0x16181d), 0.04, 0.02, -0.03);
  add(new THREE.BoxGeometry(0.004, 0.012, 0.07), mid, 0.044, 0.045, -0.03);
  // The magazine: a long curved box for the rifles, a short one for the long guns, a tube for the shotgun.
  if (kind === "pike" || kind === "hornet") {
    const mag = add(new THREE.BoxGeometry(0.05, 0.2, 0.08), dark, 0, -0.15, -0.12);
    mag.rotation.x = -0.18;
  } else if (kind === "maul") add(new THREE.BoxGeometry(0.09, 0.07, len * 0.4), mid, 0, -0.08, -len * 0.3);
  else add(new THREE.BoxGeometry(0.05, 0.11, 0.09), dark, 0, -0.11, -0.1);
  if (kind === "talon") {
    // A long scope with its two lenses, and a bolt handle.
    add(new THREE.CylinderGeometry(0.05, 0.05, 0.42, 10).rotateX(Math.PI / 2), dark, 0, 0.13, -0.05);
    add(new THREE.CylinderGeometry(0.062, 0.062, 0.06, 10).rotateX(Math.PI / 2), mid, 0, 0.13, -0.27);
    add(new THREE.CylinderGeometry(0.058, 0.058, 0.05, 10).rotateX(Math.PI / 2), mid, 0, 0.13, 0.17);
    add(new THREE.BoxGeometry(0.1, 0.025, 0.025), mid, 0.07, 0.04, 0.12);
  }
  if (kind === "lance") add(new THREE.CylinderGeometry(0.045, 0.045, 0.32, 8).rotateX(Math.PI / 2), mid, 0, 0.12, -0.05);
  compact(g);
  return g;
}

/**
 * The player's own hands on a gun from buildGun, in its frame: gloved hands on the grip and under
 * the fore end, and the teal sleeves of the forearms reaching back and down out of the view. They
 * show the player's own size against the world, which a floating gun alone does not.
 */
export function buildHands(kind: WeaponKind): THREE.Group {
  const g = new THREE.Group();
  const len = GUN_LEN[kind];
  // Leather gloves, lighter than the gun so the hands read against it; the cuffs a darker teal.
  const glove = flat(PAL.ochre);
  const sleeve = flat(PAL.teal);
  const cuff = flat(0x1f5a5f);
  // Right: the hand round the grip, the wrist behind it, the forearm back to the elbow below the view.
  const grip = v3(0.0, -0.11, 0.1);
  g.add(mesh(new THREE.BoxGeometry(0.1, 0.1, 0.12), glove, 0.012, grip.y, grip.z, false));
  g.add(mesh(new THREE.BoxGeometry(0.03, 0.04, 0.1), glove, -0.045, -0.06, 0.06, false));
  const rw = v3(0.03, -0.15, 0.19);
  g.add(limb(rw, v3(0.05, -0.18, 0.24), 0.09, 0.09, cuff, false));
  g.add(limb(v3(0.05, -0.18, 0.24), v3(0.2, -0.5, 0.75), 0.11, 0.12, sleeve, false));
  // Left: the hand cupping the fore end from below and its left side (the side the eye sees), the
  // forearm reaching back and down across the view.
  const fore = v3(0, -0.06, -len * 0.38);
  g.add(mesh(new THREE.BoxGeometry(0.1, 0.05, 0.13), glove, fore.x, fore.y - 0.035, fore.z, false));
  g.add(mesh(new THREE.BoxGeometry(0.025, 0.09, 0.12), glove, -0.042, fore.y + 0.0, fore.z, false));
  g.add(mesh(new THREE.BoxGeometry(0.02, 0.05, 0.1), glove, 0.04, fore.y - 0.01, fore.z, false));
  const lw = v3(-0.05, -0.12, -len * 0.38 + 0.08);
  g.add(limb(fore, lw, 0.08, 0.08, glove, false));
  g.add(limb(lw, v3(-0.1, -0.16, -len * 0.38 + 0.15), 0.09, 0.09, cuff, false));
  g.add(limb(v3(-0.1, -0.16, -len * 0.38 + 0.15), v3(-0.6, -0.55, 0.2), 0.11, 0.12, sleeve, false));
  compact(g);
  return g;
}

export function buildLootItem(kind: LootKind, rarity: Rarity, weapon?: WeaponKind, heal?: HealKind, valuable?: ValuableKind, tool?: ToolKind): THREE.Group {
  const g = new THREE.Group();
  const color = RARITY_COLOR[rarity];
  if (kind === "weapon" && weapon) {
    const gun = buildGun(weapon, rarity);
    gun.scale.setScalar(1.1);
    gun.rotation.y = Math.PI / 2;
    gun.position.y = 0.45;
    g.add(gun);
  } else if (kind === "armor") {
    g.add(mesh(new THREE.BoxGeometry(0.55, 0.6, 0.25), flat(color), 0, 0.45, 0, false));
    g.add(mesh(new THREE.BoxGeometry(0.35, 0.18, 0.27), flat(PAL.gun), 0, 0.68, 0, false));
  } else if (kind === "heal") {
    // Shield items glow blue, health items are white with a red band; big ones are bigger.
    const big = heal === "battery" || heal === "medkit";
    const band = heal === "cell" || heal === "battery" ? RARITY_COLOR[1] : HEAL_RED;
    if (heal === "medkit") {
      g.add(mesh(new THREE.BoxGeometry(0.5, 0.3, 0.36), flat(0xf2f0ea), 0, 0.3, 0, false));
      g.add(mesh(new THREE.BoxGeometry(0.52, 0.08, 0.38), flat(band), 0, 0.3, 0, false));
    } else {
      const r = big ? 0.16 : 0.1;
      const h = big ? 0.42 : 0.3;
      g.add(mesh(new THREE.CylinderGeometry(r, r, h, 8), flat(heal === "syringe" ? 0xf2f0ea : PAL.gunLight), 0, 0.35, 0, false));
      g.add(mesh(new THREE.CylinderGeometry(r + 0.01, r + 0.01, h * 0.45, 8), heal === "syringe" ? flat(band) : glow(band), 0, 0.35, 0, false));
    }
  } else if (kind === "valuable") {
    // Parts: a gear on a scrap block. Circuit board: a flat green card with chips. Data core: a glowing cube in a frame.
    if (valuable === "reactor") {
      // A reactor: a fat glowing cylinder in a cage.
      g.add(mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.5, 10), flat(PAL.gun), 0, 0.42, 0, false));
      g.add(mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.54, 10), glow(color), 0, 0.42, 0, false));
    } else if (valuable === "drive") {
      g.add(mesh(new THREE.BoxGeometry(0.3, 0.06, 0.2), flat(PAL.gunLight), 0, 0.25, 0, false));
      g.add(mesh(new THREE.BoxGeometry(0.08, 0.065, 0.08), glow(color), 0.08, 0.26, 0, false));
    } else if (valuable === "gyro") {
      const ring = mesh(new THREE.TorusGeometry(0.2, 0.04, 6, 14), flat(PAL.gunLight), 0, 0.42, 0, false);
      g.add(ring);
      g.add(mesh(new THREE.SphereGeometry(0.1, 10, 8), glow(color), 0, 0.42, 0, false));
    } else if (valuable === "wire") {
      g.add(mesh(new THREE.TorusGeometry(0.18, 0.07, 6, 12).rotateX(Math.PI / 2), flat(PAL.rust), 0, 0.25, 0, false));
    } else if (valuable === "fuse") {
      g.add(mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.3, 8).rotateZ(Math.PI / 2), flat(0xf2f0ea), 0, 0.22, 0, false));
      for (const x of [-0.16, 0.16]) g.add(mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.05, 8).rotateZ(Math.PI / 2), flat(PAL.gun), x, 0.22, 0, false));
    } else if (valuable === "core") {
      g.add(mesh(new THREE.BoxGeometry(0.34, 0.34, 0.34), flat(PAL.gun), 0, 0.4, 0, false));
      g.add(mesh(new THREE.BoxGeometry(0.24, 0.36, 0.24), glow(color), 0, 0.4, 0, false));
    } else if (valuable === "board") {
      g.add(mesh(new THREE.BoxGeometry(0.5, 0.04, 0.34), flat(0x2f7a4a), 0, 0.3, 0, false));
      for (const [x, z] of [[-0.12, 0.05], [0.1, -0.06], [0.14, 0.09]]) g.add(mesh(new THREE.BoxGeometry(0.1, 0.05, 0.08), flat(PAL.gun), x, 0.34, z, false));
    } else {
      g.add(mesh(new THREE.BoxGeometry(0.3, 0.16, 0.26), flat(PAL.gunLight), 0, 0.24, 0, false));
      const gear = mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.06, 8), flat(PAL.gun), 0, 0.36, 0, false);
      g.add(gear);
    }
  } else if (kind === "key") {
    // A key card: a gold card with a dark stripe.
    g.add(mesh(new THREE.BoxGeometry(0.34, 0.03, 0.22), glow(color), 0, 0.3, 0, false));
    g.add(mesh(new THREE.BoxGeometry(0.34, 0.035, 0.05), flat(PAL.gun), 0, 0.3, 0.05, false));
  } else if (kind === "tool" && tool === "cutter") {
    // Bolt cutters: two long red-gripped handles meeting at short steel jaws.
    for (const z of [-0.05, 0.05]) {
      g.add(mesh(new THREE.BoxGeometry(0.62, 0.035, 0.035), flat(PAL.steel), -0.05, 0.12, z, false));
      g.add(mesh(new THREE.BoxGeometry(0.26, 0.05, 0.05), flat(HEAL_RED), -0.27, 0.12, z * 1.4, false));
    }
    g.add(mesh(new THREE.BoxGeometry(0.16, 0.06, 0.14), flat(PAL.gun), 0.3, 0.12, 0, false));
  } else if (kind === "tool") {
    // A breaching charge: a squat orange case with a black detonator on top.
    g.add(mesh(new THREE.BoxGeometry(0.44, 0.26, 0.3), flat(0xd8742c), 0, 0.2, 0, false));
    g.add(mesh(new THREE.BoxGeometry(0.46, 0.05, 0.32), flat(PAL.gun), 0, 0.26, 0, false));
    g.add(mesh(new THREE.BoxGeometry(0.12, 0.1, 0.1), flat(PAL.gun), 0.1, 0.38, 0, false));
    g.add(mesh(new THREE.SphereGeometry(0.03, 6, 4), glow(HEAL_RED), 0.1, 0.45, 0, false));
  } else if (kind === "flare") {
    // A road flare: a red tube with a cap.
    const tube = mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.42, 8), flat(HEAL_RED), 0, 0.3, 0, false);
    tube.rotation.z = Math.PI / 2;
    g.add(tube);
    const cap = mesh(new THREE.CylinderGeometry(0.065, 0.065, 0.08, 8), flat(PAL.gun), 0.22, 0.3, 0, false);
    cap.rotation.z = Math.PI / 2;
    g.add(cap);
  } else {
    g.add(new THREE.Mesh(new THREE.OctahedronGeometry(0.16, 0), glow(RARITY_COLOR[1])));
  }
  if (kind !== "shard") {
    // The loot beam: visible from across the map, coloured by rarity.
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.12, 7, 6, 1, true),
      new THREE.MeshBasicMaterial({ toneMapped: false, color, transparent: true, opacity: rarity === 3 ? 0.55 : 0.35, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    beam.position.y = 3.6;
    g.add(beam);
    const h = haloSprite(color, 1.2, 0.5);
    h.position.y = 0.45;
    g.add(h);
  }
  return g;
}

/** A supply bin; a vault is a darker, banded crate with a gold lock. */
export function buildBin(vault = false): { root: THREE.Group; lid: THREE.Object3D; seam: THREE.Mesh } {
  const root = new THREE.Group();
  root.add(mesh(new THREE.BoxGeometry(1.4, 0.7, 0.8), flat(vault ? PAL.gun : PAL.teal), 0, 0.35, 0));
  if (vault) {
    for (const x of [-0.45, 0.45]) root.add(mesh(new THREE.BoxGeometry(0.12, 0.72, 0.82), flat(PAL.gunLight), x, 0.36, 0, false));
    root.add(mesh(new THREE.BoxGeometry(0.22, 0.24, 0.06), glow(RARITY_COLOR[3]), 0, 0.42, 0.42, false));
  }
  root.add(mesh(new THREE.BoxGeometry(1.42, 0.14, 0.82), flat(PAL.concrete), 0, 0.1, 0, false));
  const lid = new THREE.Group();
  lid.position.set(0, 0.72, 0.4);
  lid.add(mesh(new THREE.BoxGeometry(1.44, 0.16, 0.84), flat(PAL.concrete), 0, 0.08, -0.42));
  root.add(lid);
  const seam = new THREE.Mesh(new THREE.BoxGeometry(1.46, 0.05, 0.86), glow(0xffffff));
  seam.position.y = 0.71;
  root.add(seam);
  return { root, lid, seam };
}

/**
 * A depot by a POI's road: a squat steel locker with a slot facing the road and a lamp on a short
 * mast. The lamp and slot are dark until the depot is switched on, then lit in the teammate's
 * teal, the colour that means "ours" on the HUD; nothing else on it glows.
 */
export function buildDepot(): { root: THREE.Group; lamp: THREE.Mesh; slot: THREE.Mesh } {
  const root = new THREE.Group();
  root.add(mesh(new THREE.BoxGeometry(1.3, 0.16, 1.0), flat(PAL.concreteDark), 0, 0.08, 0));
  root.add(mesh(new THREE.BoxGeometry(1.1, 0.95, 0.8), flat(PAL.steel), 0, 0.62, 0));
  root.add(mesh(new THREE.BoxGeometry(1.16, 0.12, 0.86), flat(PAL.teal), 0, 1.15, 0, false));
  // The front (-z, turned away from the POI, along the road) carries the slot the bag goes into.
  root.add(mesh(new THREE.BoxGeometry(0.7, 0.36, 0.06), flat(PAL.gun), 0, 0.72, -0.42, false));
  const slot = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.06, 0.04), glow(PAL.gunLight));
  slot.position.set(0, 0.8, -0.46);
  root.add(slot);
  root.add(mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.5, 6), flat(PAL.gun), 0.38, 1.46, 0.2, false));
  const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.16), glow(PAL.gunLight));
  lamp.position.set(0.38, 1.76, 0.2);
  root.add(lamp);
  return { root, lamp, slot };
}

/**
 * The mark of a way in on foot: a cold campfire ring with a signboard behind it, the camp the
 * player and the teammate set out from. It is only scenery: nothing in it is solid, and it does
 * not glow, so it is found by walking the open ground, not seen from afar. The board faces +z.
 */
export function buildEntryMark(): { fire: THREE.Group; sign: THREE.Group } {
  const fire = new THREE.Group();
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    const stone = mesh(new THREE.BoxGeometry(0.34, 0.2, 0.26), flat(i % 2 ? PAL.concreteDark : PAL.concrete), Math.cos(a) * 0.62, 0.1, Math.sin(a) * 0.62, false);
    stone.rotation.y = -a;
    fire.add(stone);
  }
  fire.add(mesh(new THREE.BoxGeometry(0.9, 0.04, 0.9), flat(PAL.gun), 0, 0.02, 0, false));
  for (const [r, y] of [[0.5, 0.1], [-0.6, 0.16]]) {
    const log = mesh(new THREE.BoxGeometry(0.9, 0.12, 0.12), flat(PAL.rockDark), 0, y, 0, false);
    log.rotation.y = r;
    fire.add(log);
  }
  const sign = new THREE.Group();
  for (const x of [-0.55, 0.55]) sign.add(mesh(new THREE.BoxGeometry(0.1, 1.5, 0.1), flat(PAL.ochre), x, 0.75, 0));
  sign.add(mesh(new THREE.BoxGeometry(1.4, 0.6, 0.06), flat(PAL.crate), 0, 1.25, 0.06));
  // A painted band across the board: the island's camps are marked in the teammate's teal.
  sign.add(mesh(new THREE.BoxGeometry(1.0, 0.12, 0.02), flat(PAL.teal), 0, 1.3, 0.1, false));
  return { fire, sign };
}

export function buildCare(): THREE.Group {
  const g = new THREE.Group();
  g.add(mesh(new THREE.CylinderGeometry(0.9, 1.1, 2.0, 8), flat(PAL.gun), 0, 1.0, 0));
  g.add(mesh(new THREE.CylinderGeometry(0.95, 0.95, 0.25, 8), glow(RARITY_COLOR[3]), 0, 1.4, 0));
  g.add(mesh(new THREE.ConeGeometry(0.95, 0.6, 8), flat(PAL.gunLight), 0, 2.3, 0));
  return g;
}

/** The boat that comes up the harbor's channel to the quay: a low hull, a wheelhouse, a rust stripe. */
export function buildBoat(): THREE.Group {
  const g = new THREE.Group();
  g.add(mesh(new THREE.BoxGeometry(9, 1.4, 3.4), flat(PAL.concrete), 0, 0.5, 0));
  g.add(mesh(new THREE.BoxGeometry(9.1, 0.3, 3.5), flat(PAL.rust), 0, 0.05, 0, false));
  g.add(mesh(new THREE.BoxGeometry(2, 1.4, 2.4), flat(PAL.concrete), -1.8, 1.9, 0));
  g.add(mesh(new THREE.BoxGeometry(2.1, 0.5, 2.5), flat(PAL.teal), -1.8, 2.3, 0, false));
  g.add(mesh(new THREE.BoxGeometry(1.4, 0.8, 3.4), flat(PAL.gun), 4.6, 0.9, 0));
  return g;
}

export function buildDropship(): THREE.Group {
  const g = new THREE.Group();
  g.add(mesh(new THREE.BoxGeometry(3.4, 2.2, 9), flat(PAL.concrete), 0, 0, 0));
  g.add(mesh(new THREE.BoxGeometry(3.0, 1.0, 3), flat(PAL.gun), 0, 0.9, -4.6));
  for (const s of [-1, 1]) {
    g.add(mesh(new THREE.BoxGeometry(5, 0.3, 2.6), flat(PAL.rust), s * 3.8, 0.4, 0.5));
    g.add(mesh(new THREE.CylinderGeometry(0.9, 0.9, 1.6, 10), flat(PAL.gunLight), s * 6.2, 0.4, 0.5));
    const flame = haloSprite(0xffb050, 2.2, 0.9);
    flame.position.set(s * 6.2, -0.9, 0.5);
    g.add(flame);
  }
  return g;
}
