import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { ENEMIES, type EnemyKind, type HealKind, type Rarity, type ValuableKind, type WeaponKind } from "../sim/config";
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
  /** The streets' worn asphalt, and the paint of their edge and centre lines. */
  asphalt: 0x6b6862,
  roadPaint: 0xe8e2d2,
  /** The machine city's streets: fresh charcoal asphalt, cooler and darker than the island's worn roads, and its faded lane paint. */
  cityAsphalt: 0x3b3f44,
  cityAsphaltDark: 0x2c3034,
  laneMark: 0x8f969c,
  /** The city's curtain walls: blue-grey glass, and the white concrete of its podiums, bands and pavements. */
  glass: 0x6a879b,
  cityWhite: 0xe2e5e4,
  pavement: 0xaeb3b5,
  /** The launch site's plateau: pale caliche, a dry crust whiter than the island's sand. */
  caliche: 0xddd7c6,
  calicheDark: 0xc2baa4,
  /** The crawlerway's river gravel: a warm grey, darker than the caliche round it so the road reads from afar. */
  gravel: 0x958a80,
  gravelDark: 0x6e645c,
  /** The open ground round the city: broken grey paving and patches of cinder. */
  cityLot: 0x8a8f93,
  cityLotDark: 0x6c7176,
  /** The last water, left in the harbor's tidal channel. */
  water: 0x5fa8a6,
  /** Painted steel: a ship's hull below the old waterline, girders and posts. */
  hull: 0x6e3a2a,
  steel: 0x707780,
  /** The orbital tether's composite skin: a cool pale grey that reads apart from the warm concrete, its ribs darker, its broken ends scorched. */
  tether: 0xd6dcdd,
  tetherDark: 0x98a2a8,
  scorch: 0x4a3e36,
  /** The light still in the ring's machinery (the node's power column): a cold cyan, unlike any robot's or the front's colours. */
  nodeGlow: 0x8fe6ff,
  /** The harbor master's lamp: warm, the town's own light against the node's cold one. */
  lamp: 0xffc46a,
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
  /**
   * The rogues (野良機): the same robots off the network, their navy weathered to a dull amber and
   * their eyes and bolts burning yellow-orange in place of the network's red and magenta, so a
   * rogue reads apart at any distance its eye or its fire is seen.
   */
  rogueArmor: 0x8a6526,
  rogueArmorLight: 0xb38a3e,
  rogueEye: 0xffb21f,
  rogueOrb: 0xffc23a,
  /**
   * The player's own robots (the factory's, sim/battle.ts): the same robots in a pale sky-blue coat with white panels,
   * their eyes and bolts cyan, the colour the maps give the player's ground.
   */
  friendArmor: 0x5d9fe6,
  friendArmorLight: 0xd8ecff,
  friendEye: 0x52d6ff,
  friendOrb: 0x6be0ff,
  /** Another player's robots (a holding's defence in a sortie; side 3): the same robots in purple, their eyes and bolts a light violet. */
  rivalArmor: 0x5b3d8f,
  rivalArmorLight: 0x8e6fc4,
  rivalEye: 0xd08bff,
  rivalOrb: 0xc58cff,
  hot: 0xffe23d,
  white: 0xffffff,
  gun: 0x2b2f38,
  gunLight: 0x4a505c,
  /** Bare, worn steel on a gun: its barrel, its bolt, its sight posts, the rods of a wire stock. */
  gunSteel: 0x8a9099,
  /** The ejection port on a gun's right side, vent slots and the glass of a scope: the darkest thing on it. */
  gunPort: 0x16181d,
  /** The cuffs of the player's sleeves, a darker shade of the teal sleeve. */
  cuff: 0x1f5a5f,
  /** Medical white: the medkit's case, the syringe and the pill bottle. */
  medical: 0xf2f0ea,
  /** The band on health items, apart from the enemy red and the ring orange. */
  healRed: 0xe0475a,
  /** A node's core in the colour of who holds it: the enemy's red, the player's blue, another player's green (view/map.ts `RIVAL_CSS`). */
  foe: 0xff3b30,
  own: 0x3d8cff,
  rivalHeld: 0x3fae6e,
  /** The flag the player raises by a core they hold. */
  flag: 0x2f7fe0,
  /** The hex shield the network keeps round a core off the front. */
  coreShield: 0xff6a5a,
  /** A circuit board's solder-mask green. */
  board: 0x2f7a4a,
  /** Safety orange: the breaching charge's case. */
  hazard: 0xd8742c,
  /** The glow in the vents of a fallen piece of the ring. */
  ember: 0xff7a2a,
  /** The objective's beacon: a pale warm light, apart from every faction's colour. */
  beacon: 0xfff2b0,
  /** The flame under a dropship's engines. */
  thrust: 0xffb050,
  /** Bare copper: the coil on a spool of wire, apart from the rust of old steel. */
  copper: 0xc8763a,
} as const;

/** Aim amount past which a scoped weapon shows its sight instead of the gun. */
export const SCOPE_IN = 0.85;

export const RARITY_COLOR = [0xeeeeee, 0x45a6ff, 0xb65cff, 0xffc93a] as const;
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

/**
 * Fixes `o` and everything under it where they stand: their matrices are worked out once, here,
 * and not again each frame. `moving` are the parts the view still turns, moves or scales; those
 * keep updating, and so does what hangs from them. Call it once `o` is placed, and never move a
 * fixed part after.
 */
export function still<T extends THREE.Object3D>(o: T, moving: readonly THREE.Object3D[] = []): T {
  o.traverse((c) => {
    if (moving.includes(c)) return;
    c.matrixAutoUpdate = false;
    c.updateMatrix();
  });
  return o;
}

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0, shadow = true): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = shadow;
  m.receiveShadow = shadow;
  return m;
}

/**
 * The parts a figure is read by from the distance it is mostly seen at (docs/ringfall/models.md):
 * the eye, the head, the shoulders, the weapon's outline. `npm run models:ringfall` checks that
 * each is two pixels or more there.
 */
export type ReadPart = "eye" | "head" | "shoulder" | "weapon";
/** One part a model is read by, as `compact()` leaves it on the merged mesh's `userData.reads`: its name and its own three sizes. */
export interface ReadSize {
  part: ReadPart;
  size: [number, number, number];
}
/** Names `m` as a part its model is read by; the name outlives `compact()`. */
function reads<T extends THREE.Mesh>(m: T, part: ReadPart): T {
  m.userData.reads = part;
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

/** A `steel` box's paint, by its tint. */
export const STEEL_TINTS = [PAL.rust, PAL.hull, PAL.steel, PAL.teal, PAL.paint, PAL.tether, PAL.tetherDark, PAL.scorch, PAL.glass, PAL.cityWhite] as const;
/** A `wall` box's colour, by its tint. */
export const wallColour = (tint: number) => [PAL.concrete, PAL.concreteDark, PAL.rust, PAL.stone, PAL.cityWhite][tint] ?? PAL.concrete;

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
      // tint 1: the low parapet around a roof; tint 2: red bands and roof tiles; tint 3: dry stone; tint 4: the city's white concrete.
      g.add(mesh(new THREE.BoxGeometry(w, h, d), flat(wallColour(b.tint)), 0, mid, 0));
      if (b.y0 === 0) g.add(mesh(new THREE.BoxGeometry(w + 0.04, Math.min(0.5, h), d + 0.04), flat(PAL.concreteDark), 0, Math.min(0.5, h) / 2, 0, false));
      break;
    }
    case "slab": {
      // tint 2: the city's pale pavements and floor plates, with no rust under their edge.
      if (b.tint === 2) {
        g.add(mesh(new THREE.BoxGeometry(w, h, d), flat(PAL.pavement), 0, mid, 0));
        break;
      }
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
      // 5: the tether's composite skin, 6: its ribs, 7: scorch where it broke, 8: the city's glass, 9: its white panels.
      const color = STEEL_TINTS[b.tint % STEEL_TINTS.length];
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
export const PROP_PAL = {
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
  /** The camp's khaki tarps, the yellow notice among the white on its board, a bedroll. */
  canvas: 0xb9a37a,
  note: 0xeedc8a,
  mat: 0x6f7e5c,
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
    case PROP.bench: {
      // A timber top on four legs: the workshop's bench, a vice and its tools.
      const top = 0.08;
      g.add(part(L, W, h - top, h, PROP_PAL.wood));
      for (const t of [-L / 2 + 0.12, L / 2 - 0.12]) for (const v of [-W / 2 + 0.1, W / 2 - 0.1]) g.add(mesh(new THREE.BoxGeometry(0.09, h - top, 0.09), flat(PROP_PAL.chassis), long ? t : v, b.y0 + (h - top) / 2, long ? v : t));
      g.add(part(0.3, 0.22, h, h + 0.22, PAL.gun, -L / 2 + 0.35));
      g.add(part(0.7, 0.3, h, h + 0.12, PAL.rust, 0.2));
      g.add(part(0.5, 0.08, h, h + 0.05, PAL.gunLight, L / 2 - 0.5, false));
      g.add(part(L * 0.9, 0.06, 0.25, 0.32, PROP_PAL.wood, 0, false));
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
  const groups = new Map<THREE.Material, { shadow: boolean; geos: THREE.BufferGeometry[]; reads: ReadSize[] }>();
  for (const o of [...g.children]) {
    if (!(o instanceof THREE.Mesh) || keep.includes(o)) continue;
    o.updateMatrix();
    const part = o.userData.reads as ReadPart | undefined;
    o.geometry.computeBoundingBox();
    const box = o.geometry.boundingBox!.getSize(new THREE.Vector3()).multiply(o.scale);
    const geo = (o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone()).applyMatrix4(o.matrix);
    for (const name of Object.keys(geo.attributes)) if (!["position", "normal"].includes(name)) geo.deleteAttribute(name);
    const mat = o.material as THREE.Material;
    const entry = groups.get(mat) ?? { shadow: false, geos: [], reads: [] };
    if (part) entry.reads.push({ part, size: [box.x, box.y, box.z] });
    entry.shadow ||= o.castShadow;
    entry.geos.push(geo);
    groups.set(mat, entry);
    g.remove(o);
    o.geometry.dispose();
  }
  for (const [mat, { shadow, geos, reads }] of groups) {
    const merged = mergeGeometries(geos, false);
    if (!merged) continue;
    const m = new THREE.Mesh(merged, mat);
    if (reads.length) m.userData.reads = reads;
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
  const eye = reads(new THREE.Mesh(new THREE.SphereGeometry(k.weakR * 0.75, 10, 8), glow(PAL.eye)), "eye");
  const eyeHalo = haloSprite(PAL.eye, k.weakR * 4, 0.6);
  // Forward is -z in the body's frame (yaw 0 looks toward -z).
  const front = (y: number) => new THREE.Vector3(0, y, -k.weakFwd);
  switch (kind) {
    case "drone": {
      body.add(mesh(new THREE.OctahedronGeometry(k.radius, 0), armor));
      const ring = mesh(new THREE.TorusGeometry(k.radius * 1.2, 0.07, 4, 12), light);
      ring.rotation.x = Math.PI / 2;
      body.add(ring);
      for (const s of [-1, 1]) {
        // An arm out to each side, a rotor in its guard at the end, a skid under the body.
        body.add(mesh(new THREE.BoxGeometry(0.9, 0.06, 0.25), joint, s * 0.85, 0.05, 0));
        body.add(mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), armor, s * 1.18, 0.08, 0));
        body.add(mesh(new THREE.CylinderGeometry(0.29, 0.29, 0.05, 8), light, s * 1.18, 0.2, 0));
        body.add(mesh(new THREE.CylinderGeometry(0.23, 0.23, 0.06, 8), joint, s * 1.18, 0.2, 0, false));
        body.add(mesh(new THREE.BoxGeometry(0.06, 0.06, 0.6), joint, s * 0.22, -0.5, 0.02));
        body.add(mesh(new THREE.BoxGeometry(0.05, 0.2, 0.05), joint, s * 0.22, -0.4, 0.02, false));
      }
      // A hood over the lens, the gun slung under the nose, a fin at the tail.
      body.add(mesh(new THREE.BoxGeometry(0.5, 0.07, 0.24), light, 0, 0.27, -0.36));
      body.add(reads(mesh(new THREE.BoxGeometry(0.11, 0.11, 0.5), joint, 0, -0.3, -0.34), "weapon"));
      body.add(mesh(new THREE.BoxGeometry(0.16, 0.14, 0.16), armor, 0, -0.3, -0.12));
      body.add(mesh(new THREE.BoxGeometry(0.06, 0.34, 0.3), light, 0, 0.34, 0.42));
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
        const pad = reads(mesh(new THREE.BoxGeometry(0.26, 0.15, 0.36), light, s * 0.48, 1.92, 0), "shoulder");
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
      body.add(reads(mesh(new THREE.BoxGeometry(0.1, 0.15, 0.74), joint, 0.13, 1.47, -0.5), "weapon"));
      body.add(mesh(new THREE.BoxGeometry(0.05, 0.05, 0.3), joint, 0.13, 1.5, -1.01));
      body.add(mesh(new THREE.BoxGeometry(0.08, 0.16, 0.1), joint, 0.13, 1.34, -0.44));
      body.add(mesh(new THREE.BoxGeometry(0.15, 0.14, 0.15), joint, 0, 1.92, 0));
      // The head: a squat sensor block, a brow over the lens, and a short sensor mast on top.
      body.add(reads(mesh(new THREE.BoxGeometry(0.42, 0.3, 0.38), armor, 0, k.weakY + 0.02, 0), "head"));
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
      // A low four-legged ram: a wedge of armour narrowing to the lens at its nose (the weak
      // point, weakY), plates down its spine, a hood and jaw round the lens, two tusks and a
      // bumper to hit with, an engine block at the back, and legs that bend at the knee.
      const torso = mesh(new THREE.ConeGeometry(0.75, 1.5, 4), armor, 0, 0.8, 0);
      torso.rotation.x = -Math.PI / 2;
      torso.rotation.y = Math.PI / 4;
      body.add(torso);
      body.add(mesh(new THREE.BoxGeometry(1.1, 0.25, 0.9), light, 0, 0.55, 0.25));
      for (const [z, y, w] of [[0.5, 1.26, 0.52], [0.1, 1.12, 0.38], [-0.28, 0.99, 0.24]]) {
        const plate = mesh(new THREE.BoxGeometry(w, 0.09, 0.32), light, 0, y, z);
        plate.rotation.x = -0.34;
        body.add(plate);
      }
      body.add(mesh(new THREE.BoxGeometry(0.84, 0.72, 0.2), joint, 0, 0.84, 0.8));
      for (const s of [-1, 1]) {
        body.add(mesh(new THREE.BoxGeometry(0.24, 0.24, 0.16), light, s * 0.22, 0.98, 0.94));
        body.add(mesh(new THREE.BoxGeometry(0.14, 0.14, 0.04), joint, s * 0.22, 0.98, 1.03, false));
        // The hood's cheeks beside the lens, and the tusks under them.
        body.add(mesh(new THREE.BoxGeometry(0.1, 0.4, 0.34), light, s * 0.31, 0.95, -0.56));
        const tusk = mesh(new THREE.BoxGeometry(0.1, 0.12, 0.56), joint, s * 0.42, 0.6, -0.68);
        tusk.rotation.y = s * 0.12;
        body.add(tusk);
      }
      body.add(reads(mesh(new THREE.BoxGeometry(0.72, 0.1, 0.4), armor, 0, 1.2, -0.56), "head"));
      body.add(mesh(new THREE.BoxGeometry(0.56, 0.1, 0.3), joint, 0, 0.7, -0.6));
      body.add(reads(mesh(new THREE.BoxGeometry(1.0, 0.13, 0.13), light, 0, 0.5, -0.92), "weapon"));
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        body.add(mesh(new THREE.BoxGeometry(0.26, 0.3, 0.46), light, sx * 0.57, 0.74, sz * 0.4));
        body.add(mesh(new THREE.BoxGeometry(0.2, 0.2, 0.22), joint, sx * 0.55, 0.6, sz * 0.4));
        const leg = new THREE.Group();
        leg.position.set(sx * 0.55, 0.62, sz * 0.4);
        // One material a segment (the thigh and its knee cap in armour, the shin and foot dark),
        // so four jointed legs cost eight draw calls, not twenty.
        leg.add(mesh(new THREE.BoxGeometry(0.17, 0.3, 0.2), armor, 0, -0.17, 0));
        leg.add(mesh(new THREE.BoxGeometry(0.19, 0.12, 0.08), armor, 0, -0.32, -0.1));
        const knee = new THREE.Group();
        knee.position.y = -0.32;
        knee.add(mesh(new THREE.BoxGeometry(0.13, 0.26, 0.15), joint, 0, -0.13, 0));
        knee.add(mesh(new THREE.BoxGeometry(0.2, 0.07, 0.3), joint, 0, -0.265, -0.05));
        leg.add(knee);
        body.add(leg);
        legs.push(leg);
        knees.push(knee);
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
        body.add(reads(mesh(new THREE.BoxGeometry(0.53, 0.28, 0.7), light, s * 0.95, 2.9, 0), "shoulder"));
        body.add(reads(mesh(new THREE.BoxGeometry(0.42, 0.44, 0.77), light, s * 1.14, 3.02, 0.26), "weapon"));
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
      body.add(reads(mesh(new THREE.BoxGeometry(0.63, 0.42, 0.58), armor, 0, k.weakY + 0.05, 0), "head"));
      body.add(mesh(new THREE.BoxGeometry(0.65, 0.08, 0.19), light, 0, k.weakY + 0.25, -0.24));
      eye.geometry.dispose();
      eye.geometry = new THREE.SphereGeometry(k.weakR * 0.55, 10, 8).scale(1.15, 0.7, 0.55);
      eye.position.copy(front(k.weakY));
      eye.position.z -= 0.19;
      break;
    }
    case "titan": {
      // The boss, about 6 m: legs with knees under a pelvis and a narrow waist, a chest 4.2 m
      // across that fills the body sphere (bodyY, radius), the lens (the weak point, weakY) in a
      // hooded housing on its front, a head on a neck, a reactor pack with two stacks on its
      // back, and on each shoulder a rocket pod of six tubes under an armour plate.
      robotLegs(body, { hipX: 1.3, hipY: 2.3, thigh: 1.05, shin: 1.25, w: 0.85, d: 1.0, foot: [1.75, 0.32, 1.25] }, armor, light, legs, knees);
      body.add(mesh(new THREE.BoxGeometry(3.0, 0.7, 2.2), joint, 0, 2.35, 0));
      body.add(mesh(new THREE.BoxGeometry(1.0, 0.8, 0.3), armor, 0, 2.3, -1.15));
      body.add(mesh(new THREE.BoxGeometry(2.4, 0.4, 2.0), joint, 0, 2.85, 0));
      body.add(mesh(new THREE.BoxGeometry(3.2, 0.5, 2.8), light, 0, 3.2, 0));
      body.add(mesh(new THREE.BoxGeometry(4.2, 1.7, 3.4), armor, 0, 4.2, 0));
      body.add(mesh(new THREE.BoxGeometry(3.0, 0.3, 2.4), armor, 0, 5.1, 0.1));
      // The lens's housing: a dark well in the chest, hooded above and below, a cheek each side.
      body.add(mesh(new THREE.BoxGeometry(1.5, 1.3, 0.3), joint, 0, k.weakY, -1.72));
      for (const s of [-1, 1]) {
        body.add(mesh(new THREE.BoxGeometry(1.9, 0.24, 0.75), light, 0, k.weakY + s * 0.76, -1.95));
        body.add(mesh(new THREE.BoxGeometry(0.24, 1.28, 0.6), light, s * 0.84, k.weakY, -1.9));
        // A plate on each side of the chest, and vents down its flanks.
        body.add(mesh(new THREE.BoxGeometry(1.2, 0.8, 0.14), light, s * 1.4, 4.55, -1.76));
        for (let j = 0; j < 3; j++) body.add(mesh(new THREE.BoxGeometry(0.1, 0.18, 1.7), joint, s * 2.11, 3.75 + j * 0.34, 0.1, false));
        // The stacks on the pack.
        body.add(mesh(new THREE.BoxGeometry(0.5, 1.1, 0.5), armor, s * 0.9, 5.3, 1.9));
        body.add(mesh(new THREE.BoxGeometry(0.6, 0.14, 0.6), light, s * 0.9, 5.8, 1.9));
        // The head's ear housings.
        body.add(mesh(new THREE.BoxGeometry(0.16, 0.45, 0.6), joint, s * 0.83, 5.55, -0.5));
      }
      body.add(mesh(new THREE.BoxGeometry(2.8, 1.6, 0.7), joint, 0, 4.2, 2.0));
      body.add(mesh(new THREE.BoxGeometry(1.0, 0.3, 1.0), joint, 0, 5.15, -0.5));
      body.add(reads(mesh(new THREE.BoxGeometry(1.5, 0.7, 1.3), armor, 0, 5.55, -0.6), "head"));
      body.add(mesh(new THREE.BoxGeometry(1.56, 0.14, 0.5), light, 0, 5.8, -1.05));
      body.add(mesh(new THREE.BoxGeometry(1.2, 0.18, 0.08), joint, 0, 5.5, -1.27, false));
      body.add(mesh(new THREE.BoxGeometry(1.0, 0.2, 0.3), light, 0, 5.28, -1.12));
      // One material for all twelve tubes, so they are drawn together.
      const tubes = glow(PAL.orb);
      for (const s of [-1, 1]) {
        body.add(mesh(new THREE.BoxGeometry(0.7, 0.7, 1.0), joint, s * 2.2, 4.5, 0.1));
        body.add(reads(mesh(new THREE.BoxGeometry(1.2, 1.1, 2.0), light, s * 2.75, 4.6, 0.2), "weapon"));
        body.add(mesh(new THREE.BoxGeometry(1.04, 0.94, 0.1), joint, s * 2.75, 4.6, -0.81, false));
        for (let j = 0; j < 6; j++) body.add(mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.1, 8).rotateX(Math.PI / 2), tubes, s * 2.75 + ((j % 3) - 1) * 0.33, 4.82 - Math.floor(j / 3) * 0.44, -0.87, false));
        body.add(mesh(new THREE.BoxGeometry(0.9, 0.8, 0.2), joint, s * 2.75, 4.6, 1.28));
        body.add(mesh(new THREE.BoxGeometry(0.4, 0.5, 1.2), armor, s * 2.75, 3.85, 0.2));
        const plate = reads(mesh(new THREE.BoxGeometry(1.36, 0.3, 1.8), armor, s * 2.6, 5.32, 0.15), "shoulder");
        plate.rotation.z = -s * 0.2;
        body.add(plate);
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
  titan: { w: 3.8, h: 1.1, y: 4.6, z: -1.84 },
};

/**
 * Armour plates bolted over the chest and the shoulders of a robot, in the colour of the rarity
 * that pierces them: the player tells at a glance which robots their gun cannot pierce. Returns
 * the plates, so they can be knocked off when the plate breaks.
 */
export function addPlates(m: EnemyModel, kind: EnemyKind, tier: Rarity): THREE.Mesh[] {
  const c = CHEST[kind];
  const mat = flat(RARITY_COLOR[tier]);
  const t = c.w * 0.07;
  const out = [
    mesh(new THREE.BoxGeometry(c.w, c.h * 0.48, t), mat, 0, c.y + c.h * 0.22, c.z - t / 2),
    mesh(new THREE.BoxGeometry(c.w * 0.75, c.h * 0.32, t), mat, 0, c.y - c.h * 0.22, c.z - t / 2),
  ];
  // Pauldrons on the shoulders, so the colour shows from the side and from behind too.
  if (kind === "grunt" || kind === "heavy")
    for (const side of [-1, 1]) {
      const pad = mesh(new THREE.BoxGeometry(c.w * 0.3, c.h * 0.16, c.w * 0.5), mat, side * c.w * 0.62, c.y + c.h * 0.5, c.z + c.w * 0.28);
      pad.rotation.z = side * -0.35;
      out.push(pad);
    }
  for (const o of out) m.body.add(o);
  return out;
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
 * ours at a glance against the navy robots. A neck and a helmet with ear flaps and a visor, knees
 * with pads over laced boots, a belt with pouches, a pack with a bedroll, and arms in two parts
 * with elbow pads and gloves that hold a rifle (stock, magazine, sight, barrel) at the shoulder.
 * Nothing on it glows.
 */
export function buildAlly(): AllyModel {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const suit = flat(PAL.teal);
  const vest = flat(PAL.sand);
  const dark = flat(PAL.joint);
  const skin = flat(PAL.concrete);
  const pack = flat(PAL.ochre);
  const gun = flat(PAL.gun);
  const gunLight = flat(PAL.gunLight);
  const legs: THREE.Object3D[] = [];
  const knees: THREE.Object3D[] = [];
  for (const s of [-1, 1]) {
    const leg = new THREE.Group();
    leg.position.set(s * 0.12, 0.92, 0);
    leg.add(mesh(new THREE.BoxGeometry(0.17, 0.44, 0.2), suit, 0, -0.22, 0));
    // A cargo pocket on the outside of each thigh.
    leg.add(mesh(new THREE.BoxGeometry(0.04, 0.15, 0.13), vest, s * 0.1, -0.22, 0));
    const knee = new THREE.Group();
    knee.position.y = -0.45;
    knee.add(mesh(new THREE.BoxGeometry(0.15, 0.12, 0.06), dark, 0, 0, -0.1));
    knee.add(mesh(new THREE.BoxGeometry(0.15, 0.3, 0.17), suit, 0, -0.16, 0));
    // The boot: its shaft, the foot, and a paler sole under it.
    knee.add(mesh(new THREE.BoxGeometry(0.165, 0.13, 0.19), dark, 0, -0.33, 0));
    knee.add(mesh(new THREE.BoxGeometry(0.17, 0.07, 0.29), dark, 0, -0.405, -0.045));
    knee.add(mesh(new THREE.BoxGeometry(0.18, 0.03, 0.31), gunLight, 0, -0.455, -0.045));
    leg.add(knee);
    body.add(leg);
    legs.push(leg);
    knees.push(knee);
  }
  // Hips and belt, a pouch on each hip and one behind.
  body.add(mesh(new THREE.BoxGeometry(0.38, 0.14, 0.24), suit, 0, 0.93, 0));
  body.add(mesh(new THREE.BoxGeometry(0.4, 0.07, 0.26), dark, 0, 1.0, 0));
  for (const s of [-1, 1]) body.add(mesh(new THREE.BoxGeometry(0.07, 0.13, 0.12), dark, s * 0.215, 0.96, 0.0));
  // The torso, the vest over it, three magazine pouches across its front, straps over the shoulders.
  body.add(mesh(new THREE.BoxGeometry(0.42, 0.52, 0.26), suit, 0, 1.22, 0));
  body.add(mesh(new THREE.BoxGeometry(0.46, 0.36, 0.3), vest, 0, 1.27, 0));
  for (const x of [-0.14, 0, 0.14]) body.add(mesh(new THREE.BoxGeometry(0.1, 0.14, 0.05), pack, x, 1.19, -0.17));
  for (const s of [-1, 1]) {
    body.add(mesh(new THREE.BoxGeometry(0.09, 0.05, 0.31), vest, s * 0.14, 1.475, 0));
    body.add(mesh(new THREE.BoxGeometry(0.15, 0.1, 0.18), suit, s * 0.27, 1.44, 0));
  }
  // The pack, a pocket each side, the bedroll across its top.
  body.add(mesh(new THREE.BoxGeometry(0.32, 0.42, 0.18), pack, 0, 1.24, 0.23));
  for (const s of [-1, 1]) body.add(mesh(new THREE.BoxGeometry(0.06, 0.2, 0.13), pack, s * 0.19, 1.15, 0.23));
  body.add(mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.36, 6).rotateZ(Math.PI / 2), suit, 0, 1.5, 0.24));
  body.add(mesh(new THREE.BoxGeometry(0.11, 0.1, 0.11), skin, 0, 1.53, 0));
  // The head: the face under a teal helmet with a brim and ear flaps, a dark visor band across
  // the eyes, goggles pushed up on the helmet's front.
  body.add(mesh(new THREE.BoxGeometry(0.2, 0.22, 0.22), skin, 0, 1.66, 0));
  body.add(reads(mesh(new THREE.BoxGeometry(0.25, 0.13, 0.27), suit, 0, 1.77, 0.01), "head"));
  body.add(mesh(new THREE.BoxGeometry(0.27, 0.03, 0.31), suit, 0, 1.715, -0.01));
  body.add(mesh(new THREE.BoxGeometry(0.15, 0.03, 0.2), suit, 0, 1.85, 0.01));
  body.add(mesh(new THREE.BoxGeometry(0.21, 0.06, 0.03), dark, 0, 1.67, -0.115));
  for (const s of [-1, 1]) body.add(mesh(new THREE.BoxGeometry(0.03, 0.07, 0.09), suit, s * 0.115, 1.69, 0.03));
  body.add(mesh(new THREE.BoxGeometry(0.2, 0.05, 0.03), gunLight, 0, 1.785, -0.135));
  const arms = new THREE.Group();
  arms.position.set(0, 1.42, 0);
  for (const s of [-1, 1]) {
    const shoulder = v3(s * 0.25, 0, 0);
    const elbow = v3(s * 0.24, -0.25, -0.12);
    const hand = s > 0 ? v3(0.09, -0.12, -0.36) : v3(0.03, -0.08, -0.58);
    arms.add(limb(shoulder, elbow, 0.11, 0.12, suit));
    arms.add(mesh(new THREE.BoxGeometry(0.125, 0.09, 0.13), dark, elbow.x, elbow.y, elbow.z));
    arms.add(limb(elbow, hand, 0.1, 0.11, suit));
    arms.add(mesh(new THREE.BoxGeometry(0.08, 0.09, 0.09), dark, hand.x, hand.y, hand.z));
  }
  // The rifle: receiver, fore end, barrel and muzzle, a stock to the shoulder, magazine, grip, sight.
  arms.add(reads(mesh(new THREE.BoxGeometry(0.07, 0.11, 0.36), gun, 0.06, -0.04, -0.36), "weapon"));
  arms.add(mesh(new THREE.BoxGeometry(0.062, 0.085, 0.24), gunLight, 0.06, -0.045, -0.64));
  arms.add(mesh(new THREE.BoxGeometry(0.03, 0.03, 0.18), gun, 0.06, -0.03, -0.84));
  arms.add(mesh(new THREE.BoxGeometry(0.045, 0.045, 0.06), gunLight, 0.06, -0.03, -0.95));
  arms.add(mesh(new THREE.BoxGeometry(0.05, 0.09, 0.2), gunLight, 0.06, -0.05, -0.09));
  arms.add(mesh(new THREE.BoxGeometry(0.056, 0.13, 0.03), gun, 0.06, -0.06, 0.02));
  const mag = mesh(new THREE.BoxGeometry(0.045, 0.17, 0.07), gun, 0.06, -0.17, -0.44);
  mag.rotation.x = 0.2;
  arms.add(mag);
  arms.add(mesh(new THREE.BoxGeometry(0.05, 0.1, 0.05), gunLight, 0.06, -0.13, -0.3));
  arms.add(mesh(new THREE.BoxGeometry(0.03, 0.045, 0.12), gun, 0.06, 0.035, -0.38));
  body.add(arms);
  for (const part of [body, arms, ...legs, ...knees]) compact(part);
  return { root, body, legs, knees, arms };
}

/** Each gun's length from muzzle to stock, metres before the first-person scale. */
const GUN_LEN: Record<WeaponKind, number> = { pike: 0.75, hornet: 0.5, maul: 0.8, lance: 1.0, talon: 1.25 };

/**
 * A gun, its muzzle toward -z, the grip under the origin: built of separate volumes so each reads
 * in the hand (an upper and a lower receiver, a fore end, a barrel and what is on its muzzle, the
 * sights or a scope, a magazine, a grip in its guard, a stock), with a stripe in its rarity colour
 * along both sides. Three greys carry it: the dark of the frame, a lighter one for covers and
 * furniture, bare steel for barrels, bolts and sight posts. Each kind has an outline of its own
 * (`GUNS_APART` in scripts/ringfall-models.ts): the rifle's curved magazine and post sights, the
 * submachine gun's magazine through its grip and fat suppressor, the shotgun's two tubes and pump,
 * the marksman rifle's bipod and scope, the sniper's heavy barrel, brake and tall scope. The grip
 * and the fore end stay where `buildHands()` holds them.
 */
export function buildGun(kind: WeaponKind, rarity: Rarity): THREE.Group {
  const g = new THREE.Group();
  const dark = flat(PAL.gun);
  const mid = flat(PAL.gunLight);
  const steel = flat(PAL.gunSteel);
  const port = flat(PAL.gunPort);
  const stripe = glow(RARITY_COLOR[rarity]);
  /** A box `w` across, `h` high and `l` long at (x, y, z), pitched `rx` about its middle. */
  const box = (m: THREE.Material, w: number, h: number, l: number, x: number, y: number, z: number, rx = 0) => {
    const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, l), m);
    o.position.set(x, y, z);
    o.rotation.x = rx;
    g.add(o);
    return o;
  };
  /** A tube along the barrel's line: radius `r`, from `z0` forward to `z1`, at height `y`. */
  const tube = (m: THREE.Material, r: number, z0: number, z1: number, y: number, seg = 8) => {
    const o = new THREE.Mesh(new THREE.CylinderGeometry(r, r, Math.abs(z1 - z0), seg).rotateX(Math.PI / 2), m);
    o.position.set(0, y, (z0 + z1) / 2);
    g.add(o);
    return o;
  };
  const len = GUN_LEN[kind];
  // What every kind has, where the right hand holds it: the grip raked back, the trigger in its
  // guard, the port the cases leave by on the right with the bolt showing in it.
  box(dark, 0.05, 0.15, 0.062, 0, -0.125, 0.11, -0.24);
  box(mid, 0.052, 0.02, 0.066, 0, -0.2, 0.128, -0.24);
  box(dark, 0.014, 0.01, 0.085, 0, -0.098, 0.04);
  box(dark, 0.014, 0.04, 0.01, 0, -0.08, -0.002);
  box(steel, 0.008, 0.03, 0.01, 0, -0.078, 0.05, 0.3);
  const ejection = (y: number, z: number) => {
    box(port, 0.006, 0.036, 0.1, 0.036, y, z);
    box(steel, 0.006, 0.02, 0.045, 0.038, y, z - 0.02);
  };
  /** A rail along the top from `z0` to `z1`, notched. */
  const rail = (y: number, z0: number, z1: number) => {
    box(mid, 0.026, 0.012, z1 - z0, 0, y, (z0 + z1) / 2);
    for (let z = z0 + 0.012; z < z1 - 0.008; z += 0.036) box(dark, 0.032, 0.007, 0.014, 0, y + 0.008, z);
  };
  /** Vent slots through a fore end: dark bars showing on both sides. */
  const vents = (y: number, z0: number, n: number, w: number) => {
    for (let i = 0; i < n; i++) box(port, w, 0.014, 0.04, 0, y, z0 - i * 0.062);
  };
  /** A scope on two mounts: a tube with a wider bell at each end, dark glass in both, turrets on top and on the right. */
  const scope = (y: number, z0: number, z1: number, r: number, bell: number) => {
    tube(dark, r, z0, z1, y, 10);
    tube(dark, bell, z1 + 0.02, z1 - bell * 2.2, y, 10);
    tube(mid, r * 1.3, z0 + 0.07, z0 - 0.02, y, 10);
    tube(steel, r * 1.36, z0 + 0.078, z0 + 0.066, y, 10);
    tube(port, r * 1.1, z0 + 0.082, z0 + 0.076, y, 10);
    tube(port, bell * 0.86, z1 - bell * 2.2 + 0.004, z1 - bell * 2.2 - 0.004, y, 10);
    const mid0 = (z0 + z1) / 2;
    box(mid, r * 1.5, r * 1.3, r * 1.5, 0, y + r * 1.2, mid0);
    box(mid, r * 1.3, r * 1.5, r * 1.5, r * 1.2, y, mid0);
    for (const z of [z0 - 0.05, z1 + 0.06]) {
      box(mid, r * 2.5, r * 0.9, 0.03, 0, y, z);
      box(mid, 0.03, y - r - 0.066, 0.03, 0, (y - r + 0.066) / 2, z);
    }
  };
  switch (kind) {
    case "pike": {
      // The rifle: a carbine with a vented fore end, a post front sight on its gas block, a notch
      // rear sight, a curved magazine and a stock on a buffer tube.
      box(dark, 0.07, 0.075, 0.36, 0, 0.022, -0.01);
      box(mid, 0.062, 0.05, 0.24, 0, -0.038, 0.03);
      box(dark, 0.058, 0.05, 0.09, 0, -0.07, -0.105);
      rail(0.066, -0.18, 0.08);
      box(stripe, 0.074, 0.014, 0.2, 0, 0.03, 0.02);
      ejection(0.03, -0.04);
      box(steel, 0.006, 0.016, 0.022, -0.036, -0.03, -0.02);
      box(steel, 0.05, 0.014, 0.03, 0, 0.05, 0.185);
      // The rear sight: a block with two ears, the notch between them.
      box(dark, 0.05, 0.022, 0.05, 0, 0.083, 0.125);
      for (const s of [-1, 1]) box(dark, 0.012, 0.03, 0.03, s * 0.019, 0.108, 0.125);
      // The fore end, the gas block with the front sight between its guards, the barrel and its brake.
      box(mid, 0.074, 0.084, 0.27, 0, -0.012, -0.325);
      box(dark, 0.03, 0.012, 0.27, 0, 0.036, -0.325);
      vents(-0.002, -0.24, 3, 0.078);
      box(dark, 0.04, 0.056, 0.03, 0, 0.012, -0.482);
      box(steel, 0.008, 0.05, 0.012, 0, 0.066, -0.482);
      for (const s of [-1, 1]) box(dark, 0.008, 0.036, 0.024, s * 0.018, 0.058, -0.482);
      tube(steel, 0.015, -0.46, -0.6, 0.0);
      tube(dark, 0.024, -0.6, -0.67, 0.0);
      // The magazine, curving forward in two lengths.
      box(dark, 0.046, 0.13, 0.07, 0, -0.14, -0.112, 0.12);
      box(dark, 0.046, 0.1, 0.068, 0, -0.238, -0.136, 0.32);
      box(mid, 0.05, 0.014, 0.076, 0, -0.288, -0.155, 0.32);
      // The stock: a buffer tube, a body on it, a strut under it and the butt plate.
      tube(mid, 0.02, 0.36, 0.17, 0.014);
      box(dark, 0.05, 0.075, 0.13, 0, 0.0, 0.305);
      box(dark, 0.036, 0.03, 0.15, 0, -0.058, 0.29, -0.2);
      box(mid, 0.054, 0.14, 0.03, 0, -0.022, 0.385);
      break;
    }
    case "hornet": {
      // The submachine gun: a tall boxy receiver, its magazine up through the grip, a fat
      // suppressor, a cocking knob on the left and a wire stock pushed in along its sides.
      box(dark, 0.072, 0.105, 0.3, 0, 0.008, -0.02);
      box(mid, 0.052, 0.012, 0.28, 0, 0.066, -0.02);
      rail(0.078, -0.14, 0.06);
      box(stripe, 0.076, 0.014, 0.18, 0, 0.034, 0.0);
      ejection(0.012, -0.04);
      box(steel, 0.02, 0.02, 0.024, -0.044, 0.03, -0.1);
      box(port, 0.076, 0.012, 0.12, 0, 0.03, -0.1);
      // The magazine below the grip, and its floor plate.
      box(mid, 0.04, 0.17, 0.05, 0, -0.275, 0.148, -0.24);
      box(steel, 0.044, 0.012, 0.056, 0, -0.358, 0.168, -0.24);
      // The fore end under a short shroud, and the suppressor.
      box(dark, 0.066, 0.034, 0.15, 0, -0.038, -0.2);
      box(mid, 0.058, 0.058, 0.1, 0, 0.004, -0.215);
      vents(0.006, -0.19, 2, 0.062);
      tube(dark, 0.034, -0.26, -0.44, 0.004, 10);
      tube(mid, 0.036, -0.27, -0.285, 0.004, 10);
      tube(port, 0.014, -0.438, -0.444, 0.004);
      // A hooded front sight and a low notch at the back.
      box(dark, 0.034, 0.008, 0.02, 0, 0.118, -0.15);
      for (const s of [-1, 1]) box(dark, 0.008, 0.036, 0.02, s * 0.013, 0.1, -0.15);
      box(steel, 0.006, 0.026, 0.008, 0, 0.097, -0.15);
      box(dark, 0.04, 0.02, 0.03, 0, 0.094, 0.1);
      // The stock: two rods along the receiver's sides to a plate just behind it.
      for (const s of [-1, 1]) box(steel, 0.008, 0.012, 0.2, s * 0.04, -0.012, 0.19);
      box(dark, 0.092, 0.1, 0.02, 0, -0.012, 0.29);
      box(mid, 0.06, 0.03, 0.03, 0, -0.012, 0.145);
      break;
    }
    case "maul": {
      // The shotgun: a thick barrel over a magazine tube, a ribbed pump round the tube, a heat
      // shield, shells in a carrier on the left, and a solid stock that drops to the shoulder.
      box(dark, 0.07, 0.1, 0.3, 0, 0.0, 0.0);
      box(mid, 0.052, 0.012, 0.28, 0, 0.056, 0.0);
      box(stripe, 0.074, 0.014, 0.16, 0, 0.03, 0.04);
      ejection(0.006, -0.05);
      tube(steel, 0.025, -0.15, -0.68, 0.022, 10);
      tube(port, 0.019, -0.678, -0.684, 0.022, 10);
      tube(mid, 0.021, -0.15, -0.6, -0.03);
      tube(steel, 0.024, -0.6, -0.622, -0.03);
      box(dark, 0.046, 0.094, 0.022, 0, -0.004, -0.575);
      // The heat shield over the barrel, slotted, and the bead on the muzzle.
      box(mid, 0.058, 0.02, 0.3, 0, 0.052, -0.34);
      for (let i = 0; i < 5; i++) box(port, 0.03, 0.022, 0.026, 0, 0.052, -0.22 - i * 0.06);
      box(steel, 0.01, 0.016, 0.012, 0, 0.054, -0.665);
      // The pump, ribbed.
      box(dark, 0.076, 0.062, 0.2, 0, -0.034, -0.3);
      for (let i = 0; i < 5; i++) box(mid, 0.082, 0.05, 0.012, 0, -0.034, -0.22 - i * 0.04);
      // Four shells in the carrier on the left side: rust-red cases, steel heads.
      box(mid, 0.008, 0.03, 0.13, -0.039, 0.0, 0.0);
      for (let i = 0; i < 4; i++) {
        box(flat(PAL.rust), 0.018, 0.05, 0.022, -0.046, 0.006, -0.048 + i * 0.032);
        box(steel, 0.019, 0.012, 0.023, -0.046, -0.024, -0.048 + i * 0.032);
      }
      // The stock and its pad.
      box(mid, 0.054, 0.08, 0.22, 0, -0.022, 0.26, 0.2);
      box(mid, 0.054, 0.05, 0.1, 0, -0.065, 0.31, 0.2);
      box(dark, 0.058, 0.13, 0.026, 0, -0.058, 0.375, 0.1);
      break;
    }
    case "lance": {
      // The marksman rifle: a long slotted fore end with a bipod folded under it, a slim barrel
      // and brake, a straight box magazine, a scope, and a skeleton stock with a cheek rest.
      box(dark, 0.068, 0.07, 0.4, 0, 0.022, -0.02);
      box(mid, 0.06, 0.05, 0.24, 0, -0.036, 0.03);
      box(dark, 0.056, 0.04, 0.1, 0, -0.07, -0.1);
      rail(0.063, -0.2, 0.14);
      box(stripe, 0.072, 0.014, 0.22, 0, 0.028, 0.02);
      ejection(0.03, -0.05);
      box(steel, 0.05, 0.014, 0.03, 0, 0.048, 0.2);
      box(mid, 0.068, 0.078, 0.4, 0, -0.014, -0.42);
      box(dark, 0.028, 0.012, 0.4, 0, 0.03, -0.42);
      vents(-0.004, -0.3, 5, 0.072);
      tube(steel, 0.014, -0.62, -0.9, 0.0);
      box(dark, 0.038, 0.034, 0.08, 0, 0.0, -0.94);
      for (const z of [-0.925, -0.955]) box(port, 0.042, 0.012, 0.014, 0, 0.0, z);
      // The bipod, folded forward under the fore end.
      box(dark, 0.074, 0.024, 0.03, 0, -0.062, -0.6);
      for (const s of [-1, 1]) {
        box(steel, 0.012, 0.012, 0.2, s * 0.03, -0.07, -0.5);
        box(dark, 0.016, 0.016, 0.03, s * 0.03, -0.07, -0.395);
      }
      box(dark, 0.05, 0.17, 0.085, 0, -0.165, -0.1, 0.06);
      box(mid, 0.054, 0.014, 0.09, 0, -0.255, -0.106, 0.06);
      scope(0.128, 0.11, -0.16, 0.024, 0.034);
      // The stock: a tube back to the butt plate, a rail under it, the cheek rest on top.
      box(dark, 0.04, 0.04, 0.24, 0, 0.012, 0.3);
      box(mid, 0.05, 0.15, 0.03, 0, -0.022, 0.425);
      box(dark, 0.03, 0.024, 0.2, 0, -0.085, 0.32);
      box(mid, 0.046, 0.022, 0.13, 0, 0.044, 0.31);
      break;
    }
    case "talon": {
      // The sniper rifle: a chassis with a deep fore end, a heavy barrel to a wide ported brake,
      // a tall scope with a big objective, a bolt handle on the right, a short magazine, and a
      // stock with a raised cheek piece and a spike under the butt.
      box(dark, 0.075, 0.085, 0.36, 0, 0.012, 0.0);
      box(mid, 0.055, 0.012, 0.34, 0, 0.06, 0.0);
      box(stripe, 0.079, 0.014, 0.22, 0, 0.026, 0.02);
      ejection(0.03, -0.04);
      box(steel, 0.07, 0.018, 0.018, 0.068, 0.03, 0.1);
      box(steel, 0.032, 0.032, 0.032, 0.11, 0.022, 0.1);
      box(mid, 0.08, 0.07, 0.42, 0, -0.02, -0.38);
      box(mid, 0.062, 0.05, 0.08, 0, -0.026, -0.62);
      vents(-0.02, -0.3, 4, 0.084);
      tube(steel, 0.023, -0.18, -0.99, 0.03, 10);
      tube(mid, 0.03, -0.18, -0.3, 0.03, 10);
      box(dark, 0.09, 0.05, 0.1, 0, 0.03, -1.03);
      for (const z of [-1.01, -1.05]) box(port, 0.094, 0.022, 0.018, 0, 0.03, z);
      box(dark, 0.05, 0.06, 0.1, 0, -0.085, -0.085);
      box(mid, 0.054, 0.012, 0.106, 0, -0.118, -0.085);
      scope(0.15, 0.2, -0.22, 0.03, 0.05);
      // The stock.
      box(dark, 0.06, 0.1, 0.3, 0, -0.012, 0.31);
      box(mid, 0.05, 0.034, 0.17, 0, 0.056, 0.29);
      box(mid, 0.064, 0.16, 0.03, 0, -0.022, 0.475);
      box(dark, 0.04, 0.04, 0.1, 0, -0.08, 0.4);
      box(steel, 0.016, 0.07, 0.016, 0, -0.13, 0.41);
      break;
    }
  }
  compact(g);
  return g;
}

/**
 * The player's own hands on a gun from buildGun, in its frame: gloved hands on the grip and under
 * the fore end, and the teal sleeves of the forearms reaching back and down out of the view. They
 * show the player's own size against the world, which a floating gun alone does not. Each hand is
 * a palm, fingers that wrap what it holds and a thumb, a dark pad over the knuckles, a strap at
 * the wrist; the sleeve ends in a cuff.
 */
export function buildHands(kind: WeaponKind): THREE.Group {
  const g = new THREE.Group();
  const len = GUN_LEN[kind];
  // Leather gloves, lighter than the gun so the hands read against it; the cuffs a darker teal.
  const glove = flat(PAL.ochre);
  const pad = flat(PAL.joint);
  const sleeve = flat(PAL.teal);
  const cuff = flat(PAL.cuff);
  const add = (m: THREE.Material, w: number, h: number, l: number, x: number, y: number, z: number, rx = 0, rz = 0) => {
    const o = mesh(new THREE.BoxGeometry(w, h, l), m, x, y, z, false);
    o.rotation.set(rx, 0, rz);
    g.add(o);
  };
  /** A forearm from the wrist back to the elbow: the glove's strap, the cuff, then the sleeve, a fold across it. */
  const forearm = (wrist: THREE.Vector3, elbow: THREE.Vector3) => {
    const at = (t: number) => wrist.clone().lerp(elbow, t);
    g.add(limb(at(0), at(0.07), 0.086, 0.08, glove, false));
    g.add(limb(at(0.045), at(0.075), 0.094, 0.088, pad, false));
    g.add(limb(at(0.07), at(0.17), 0.1, 0.1, cuff, false));
    g.add(limb(at(0.17), at(1), 0.11, 0.12, sleeve, false));
    g.add(limb(at(0.4), at(0.43), 0.118, 0.128, cuff, false));
  };
  // Right: the palm behind the grip, three fingers wrapped round its front, the trigger finger
  // along the frame, the thumb over the left side (the side the eye sees), the wrist behind.
  add(glove, 0.07, 0.11, 0.06, 0.004, -0.13, 0.152, -0.24);
  for (let i = 0; i < 3; i++) add(glove, 0.076, 0.03, 0.05, 0.0, -0.118 - i * 0.034, 0.072 + i * 0.009, -0.24);
  add(glove, 0.02, 0.024, 0.085, 0.034, -0.07, 0.04);
  add(glove, 0.026, 0.03, 0.09, -0.04, -0.07, 0.085, 0.25);
  add(pad, 0.06, 0.07, 0.012, 0.004, -0.115, 0.188, -0.24);
  forearm(v3(0.02, -0.15, 0.2), v3(0.2, -0.5, 0.75));
  // Left: the palm cupping the fore end from below, the thumb up its left side, four fingers
  // curled up its right, the forearm reaching back and down across the view.
  const fz = -len * 0.38;
  add(glove, 0.092, 0.036, 0.12, 0, -0.078, fz);
  add(glove, 0.024, 0.07, 0.036, -0.05, -0.04, fz - 0.03, 0, 0.12);
  add(glove, 0.024, 0.03, 0.07, -0.052, -0.02, fz - 0.04);
  for (let i = 0; i < 4; i++) add(glove, 0.022, 0.07, 0.026, 0.05, -0.036, fz - 0.045 + i * 0.03, 0, -0.12);
  add(pad, 0.07, 0.012, 0.08, 0, -0.1, fz);
  forearm(v3(-0.03, -0.1, fz + 0.07), v3(-0.6, -0.55, 0.2));
  compact(g);
  return g;
}

/**
 * Builds small things out of boxes and cylinders into `g`, each at (x, y, z) turned by (rx, ry, rz)
 * about its own middle: the loot, the bins, the depot and the craft are written with these. A
 * cylinder stands along y; `r2` makes it a cone's frustum.
 */
function parts(g: THREE.Object3D, shadow = false) {
  const put = <T extends THREE.BufferGeometry>(geo: T, m: THREE.Material, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => {
    const o = mesh(geo, m, x, y, z, shadow);
    o.rotation.set(rx, ry, rz);
    g.add(o);
    return o;
  };
  return {
    put,
    box: (m: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => put(new THREE.BoxGeometry(w, h, d), m, x, y, z, rx, ry, rz),
    cyl: (m: THREE.Material, r: number, h: number, x: number, y: number, z: number, seg = 8, rx = 0, ry = 0, rz = 0, r2 = r) => put(new THREE.CylinderGeometry(r2, r, h, seg), m, x, y, z, rx, ry, rz),
  };
}

/** Moves `t`'s children into `g` with `t`'s own turn and place baked into each: a piece built level, then leant as a whole. */
function lean(t: THREE.Group, g: THREE.Object3D): void {
  t.updateMatrix();
  for (const c of [...t.children]) {
    c.applyMatrix4(t.matrix);
    g.add(c);
  }
}

/**
 * A thing on the ground to pick up, turning slowly over its rarity's beam. Each kind is told by its
 * outline and colours, not by a label (docs/ringfall/models.md, 拾える物): a dropped gun is its own
 * model; armour a plate carrier in its rarity's colour, its neck scooped out between the shoulder
 * straps, pouches on its front; the shield cell a caged canister lit blue and the shield battery a
 * square pack with three lit windows; the syringe a long barrel with a plunger and needle; the
 * medkit a white case with a red cross and a handle; each valuable its own object (a cartridge
 * fuse with blades, a gear on its block, a spool of copper, a board leant over, an upright drive,
 * a gimbal round a lit core, a lit column between two plates, a lit drum in a cage); the vault's key
 * a real key in its rarity's gold; the mod part and the flares their own shapes. The
 * valuables, the armour, the key and the mod part carry a part in their rarity's colour, so the
 * item itself says what the beam says. Parts of one material are merged.
 */
export function buildLootItem(kind: LootKind, rarity: Rarity, weapon?: WeaponKind, heal?: HealKind, valuable?: ValuableKind): THREE.Group {
  const g = new THREE.Group();
  const color = RARITY_COLOR[rarity];
  const { box, cyl, put } = parts(g);
  const dark = flat(PAL.gun);
  const mid = flat(PAL.gunLight);
  const steel = flat(PAL.gunSteel);
  const lit = glow(color);
  const X = Math.PI / 2;
  if (kind === "weapon" && weapon) {
    const gun = buildGun(weapon, rarity);
    gun.scale.setScalar(1.1);
    gun.rotation.y = Math.PI / 2;
    gun.position.y = 0.45;
    g.add(gun);
  } else if (kind === "armor") {
    // A plate carrier facing -z: front and back plates in the rarity's colour, the neck scooped out
    // between the shoulders, straps over them, the side bands, three magazine pouches and a patch.
    const plate = flat(color);
    for (const z of [-0.09, 0.09]) {
      box(plate, 0.44, 0.34, 0.06, 0, 0.36, z);
      for (const x of [-0.15, 0.15]) box(plate, 0.13, 0.15, 0.06, x, 0.605, z);
    }
    for (const x of [-0.15, 0.15]) box(dark, 0.1, 0.045, 0.25, x, 0.7, 0);
    for (const x of [-0.235, 0.235]) box(dark, 0.06, 0.2, 0.2, x, 0.3, 0);
    for (const x of [-0.14, 0, 0.14]) {
      box(mid, 0.115, 0.15, 0.06, x, 0.29, -0.15);
      box(dark, 0.12, 0.035, 0.065, x, 0.375, -0.152);
    }
    box(mid, 0.2, 0.08, 0.04, 0, 0.47, -0.135);
  } else if (kind === "heal") {
    // Shield items are dark cases lit blue; health items are medical white with red.
    const blue = glow(RARITY_COLOR[1]);
    const white = flat(PAL.medical);
    const red = flat(PAL.healRed);
    if (heal === "cell") {
      // A small canister standing up: a lit cell in a cage of four bars between two caps, a contact on top.
      cyl(dark, 0.09, 0.05, 0, 0.2, 0);
      cyl(blue, 0.065, 0.15, 0, 0.3, 0);
      for (let i = 0; i < 4; i++) box(mid, 0.03, 0.15, 0.03, Math.cos(i * X + X / 2) * 0.075, 0.3, Math.sin(i * X + X / 2) * 0.075);
      cyl(dark, 0.09, 0.05, 0, 0.4, 0);
      cyl(steel, 0.03, 0.05, 0, 0.45, 0, 6);
    } else if (heal === "battery") {
      // A tall square pack, the cell's big brother: two lit windows through it, a base, a lid with a carrying handle.
      box(mid, 0.26, 0.36, 0.2, 0, 0.41, 0);
      for (const x of [-0.065, 0.065]) box(blue, 0.07, 0.28, 0.21, x, 0.41, 0);
      box(dark, 0.28, 0.06, 0.22, 0, 0.2, 0);
      box(dark, 0.28, 0.06, 0.22, 0, 0.62, 0);
      for (const x of [-0.08, 0.08]) box(steel, 0.04, 0.08, 0.04, x, 0.69, 0);
      box(steel, 0.2, 0.04, 0.05, 0, 0.74, 0);
    } else if (heal === "syringe") {
      // A syringe lying along x and leant up: the white barrel with its red dose, the flange, the plunger, the hub and needle.
      const t = new THREE.Group();
      const s = parts(t);
      s.cyl(white, 0.045, 0.28, 0, 0, 0, 8, 0, 0, X);
      s.cyl(red, 0.048, 0.13, -0.03, 0, 0, 8, 0, 0, X);
      s.box(dark, 0.03, 0.05, 0.17, 0.155, 0, 0);
      s.box(steel, 0.11, 0.025, 0.025, 0.22, 0, 0);
      s.cyl(dark, 0.05, 0.025, 0.285, 0, 0, 8, 0, 0, X);
      s.cyl(dark, 0.028, 0.05, -0.165, 0, 0, 6, 0, 0, X);
      s.box(steel, 0.1, 0.01, 0.01, -0.24, 0, 0);
      t.position.y = 0.34;
      t.rotation.z = 0.35;
      lean(t, g);
    } else {
      // The medkit: an upright white case with a red cross on both faces, a dark seam, a handle and two latches.
      box(white, 0.46, 0.32, 0.15, 0, 0.34, 0);
      for (const z of [-0.078, 0.078]) {
        box(red, 0.17, 0.055, 0.012, 0, 0.33, z);
        box(red, 0.055, 0.17, 0.012, 0, 0.33, z);
      }
      box(dark, 0.47, 0.03, 0.16, 0, 0.45, 0);
      for (const x of [-0.08, 0.08]) box(dark, 0.035, 0.07, 0.04, x, 0.53, 0);
      box(dark, 0.2, 0.035, 0.05, 0, 0.575, 0);
      for (const x of [-0.17, 0.17]) box(steel, 0.05, 0.06, 0.17, x, 0.45, 0);
    }
  } else if (kind === "valuable") {
    const tint = flat(color);
    if (valuable === "fuse") {
      // A cartridge fuse lying along x: the ceramic body, a lit window round its middle, steel caps and knife blades.
      cyl(flat(PAL.medical), 0.06, 0.24, 0, 0.3, 0, 8, 0, 0, X);
      cyl(lit, 0.064, 0.06, 0, 0.3, 0, 8, 0, 0, X);
      for (const s of [-1, 1]) {
        cyl(steel, 0.07, 0.05, s * 0.135, 0.3, 0, 8, 0, 0, X);
        box(steel, 0.09, 0.06, 0.018, s * 0.2, 0.3, 0);
      }
    } else if (valuable === "parts") {
      // A gear stood on its axle in a block: a toothed wheel in the rarity's colour, a dark hub and the bracket.
      box(dark, 0.28, 0.1, 0.18, 0, 0.17, 0);
      for (const z of [-0.06, 0.06]) box(mid, 0.06, 0.2, 0.03, 0, 0.3, z);
      cyl(tint, 0.13, 0.05, 0, 0.42, 0, 10, X);
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        box(tint, 0.055, 0.05, 0.05, Math.cos(a) * 0.155, 0.42 + Math.sin(a) * 0.155, 0, 0, 0, a);
      }
      cyl(dark, 0.045, 0.16, 0, 0.42, 0, 6, X);
    } else if (valuable === "wire") {
      // A spool stood on edge, round from one side: the copper coil wound nearly to the rims of its two
      // grey flanges, the hub through them, its loose end, a tag in the rarity's colour.
      for (const z of [-0.12, 0.12]) cyl(mid, 0.19, 0.03, 0, 0.36, z, 10, X);
      cyl(flat(PAL.copper), 0.165, 0.21, 0, 0.36, 0, 10, X);
      box(flat(PAL.copper), 0.025, 0.025, 0.2, 0.17, 0.22, 0.02, 0, 0.5, 0.6);
      cyl(dark, 0.05, 0.3, 0, 0.36, 0, 6, X);
      box(lit, 0.1, 0.07, 0.012, 0, 0.6, -0.14, 0.3, 0, 0.2);
    } else if (valuable === "board") {
      // A circuit board leant over: chips, a finned heat sink, two capacitors, its edge connector in the rarity's colour.
      const t = new THREE.Group();
      const s = parts(t);
      s.box(flat(PAL.board), 0.46, 0.03, 0.32, 0, 0, 0);
      s.box(lit, 0.05, 0.035, 0.28, -0.24, 0, 0);
      for (const [x, z] of [[-0.12, -0.08], [-0.12, 0.08], [0.03, 0.09]]) s.box(dark, 0.09, 0.03, 0.08, x, 0.03, z);
      for (let i = 0; i < 4; i++) s.box(steel, 0.12, 0.07, 0.02, 0.13, 0.05, -0.12 + i * 0.045);
      for (const z of [-0.02, 0.06]) s.cyl(mid, 0.025, 0.07, 0.03, 0.05, z, 6);
      t.position.y = 0.36;
      t.rotation.set(0.5, 0, 0.25);
      lean(t, g);
    } else if (valuable === "drive") {
      // A rugged drive stood on end: its grey case, rubber corners, a lit strip, a label and the connector on top.
      box(mid, 0.2, 0.28, 0.07, 0, 0.34, 0);
      for (const x of [-0.1, 0.1]) for (const y of [0.2, 0.48]) box(dark, 0.05, 0.05, 0.085, x, y, 0);
      box(lit, 0.03, 0.18, 0.08, -0.05, 0.34, 0);
      box(flat(PAL.paint), 0.08, 0.1, 0.075, 0.04, 0.36, 0);
      box(steel, 0.09, 0.035, 0.045, 0, 0.5, 0);
    } else if (valuable === "gyro") {
      // A gimbal on a stand: an outer steel ring, an inner one turned across it, the lit rotor at the middle.
      cyl(dark, 0.14, 0.04, 0, 0.14, 0, 8);
      box(dark, 0.05, 0.12, 0.05, 0, 0.22, 0);
      put(new THREE.TorusGeometry(0.2, 0.026, 4, 12), steel, 0, 0.48, 0);
      put(new THREE.TorusGeometry(0.14, 0.024, 4, 10), mid, 0, 0.48, 0, 0, X, 0);
      put(new THREE.IcosahedronGeometry(0.085, 0), lit, 0, 0.48, 0);
    } else if (valuable === "core") {
      // A data core: a lit column between a dark base and top, four posts at the corners, the socket on top.
      box(dark, 0.3, 0.05, 0.3, 0, 0.17, 0);
      box(dark, 0.3, 0.05, 0.3, 0, 0.53, 0);
      for (const x of [-0.12, 0.12]) for (const z of [-0.12, 0.12]) box(mid, 0.05, 0.31, 0.05, x, 0.35, z);
      cyl(lit, 0.09, 0.31, 0, 0.35, 0, 6);
      box(steel, 0.12, 0.05, 0.12, 0, 0.58, 0);
    } else if (valuable === "reactor") {
      // A small reactor: a lit drum in a cage of six bars between dark rings, a hazard band, a cap and two handles.
      cyl(dark, 0.27, 0.07, 0, 0.16, 0, 10);
      cyl(dark, 0.27, 0.07, 0, 0.6, 0, 10);
      cyl(flat(PAL.hazard), 0.275, 0.03, 0, 0.53, 0, 10);
      cyl(lit, 0.16, 0.38, 0, 0.38, 0, 10);
      for (let i = 0; i < 6; i++) box(steel, 0.04, 0.37, 0.04, Math.cos((i * Math.PI) / 3) * 0.23, 0.38, Math.sin((i * Math.PI) / 3) * 0.23);
      cyl(dark, 0.12, 0.07, 0, 0.67, 0, 8);
      for (const x of [-0.2, 0.2]) box(steel, 0.04, 0.09, 0.14, x, 0.68, 0);
    }
  } else if (kind === "key") {
    // The vault's key standing on its tip: the bow a ring, the collar, the shank, two bits, and a dark tag on the ring.
    const metal = flat(color);
    put(new THREE.TorusGeometry(0.08, 0.032, 4, 10), metal, 0, 0.62, 0);
    box(metal, 0.09, 0.045, 0.05, 0, 0.51, 0);
    box(metal, 0.05, 0.3, 0.045, 0, 0.34, 0);
    box(metal, 0.09, 0.055, 0.045, 0.065, 0.24, 0);
    box(metal, 0.06, 0.045, 0.045, 0.05, 0.32, 0);
    box(dark, 0.1, 0.13, 0.018, -0.13, 0.55, 0, 0, 0, 0.5);
  } else if (kind === "mod") {
    // A mod part: a hexagonal chip in a dark frame, its core lit in the rarity's colour, three steel clips,
    // stood up on edge so its face is seen from eye height, not only its rim.
    const t = new THREE.Group();
    const s = parts(t);
    s.cyl(dark, 0.22, 0.06, 0, 0, 0, 6);
    s.cyl(lit, 0.15, 0.08, 0, 0, 0, 6);
    for (const a of [0, (Math.PI * 2) / 3, (Math.PI * 4) / 3]) s.box(steel, 0.06, 0.03, 0.12, Math.cos(a) * 0.25, 0, Math.sin(a) * 0.25, 0, -a, 0);
    t.position.y = 0.4;
    t.rotation.x = 1.1;
    lean(t, g);
  } else if (kind === "flare") {
    // Two road flares taped together: red tubes, dark striker caps, white end plugs, a band of tape.
    for (const z of [-0.05, 0.05]) {
      cyl(flat(PAL.healRed), 0.045, 0.4, 0, 0.3, z, 8, 0, 0, X);
      cyl(dark, 0.05, 0.07, 0.235, 0.3, z, 8, 0, 0, X);
      cyl(flat(PAL.paint), 0.047, 0.03, -0.215, 0.3, z, 8, 0, 0, X);
    }
    box(dark, 0.06, 0.105, 0.2, -0.05, 0.3, 0);
  } else {
    put(new THREE.OctahedronGeometry(0.16, 0), glow(RARITY_COLOR[1]), 0, 0, 0);
  }
  compact(g);
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

/**
 * A supply bin: a teal crate on two skids, steel at its corners, a band round it, handles at its
 * ends and a stencilled panel on its face, under a concrete lid with a raised panel, hinges at the
 * back and two latches at the front. A vault is the same crate in dark steel with bright bands, a
 * gold lock plate and a dial. The lid swings about its back edge (`lid`); the seam under it is lit
 * while the bin is shut (`seam`).
 */
export function buildBin(vault = false): { root: THREE.Group; lid: THREE.Object3D; seam: THREE.Mesh } {
  const root = new THREE.Group();
  const { box, cyl } = parts(root, true);
  const body = flat(vault ? PAL.gun : PAL.teal);
  const trim = flat(vault ? PAL.gunSteel : PAL.concreteDark);
  const dark = flat(PAL.gun);
  box(body, 1.3, 0.62, 0.72, 0, 0.39, 0);
  for (const z of [-0.28, 0.28]) box(dark, 1.36, 0.08, 0.12, 0, 0.04, z);
  for (const x of [-0.66, 0.66]) for (const z of [-0.37, 0.37]) box(trim, 0.08, 0.64, 0.08, x, 0.39, z);
  box(trim, 1.34, 0.06, 0.76, 0, 0.36, 0);
  for (const x of [-0.69, 0.69]) box(dark, 0.05, 0.06, 0.3, x, 0.55, 0);
  if (vault) {
    for (const x of [-0.42, 0.42]) box(trim, 0.1, 0.64, 0.76, x, 0.39, 0);
    box(glow(RARITY_COLOR[3]), 0.24, 0.26, 0.06, 0, 0.46, -0.37);
    cyl(dark, 0.07, 0.04, 0, 0.47, -0.41, 8, Math.PI / 2);
  } else {
    box(flat(PAL.paint), 0.34, 0.14, 0.02, -0.34, 0.52, -0.365);
  }
  compact(root);
  const lid = new THREE.Group();
  lid.position.set(0, 0.72, 0.4);
  const l = parts(lid, true);
  l.box(flat(PAL.concrete), 1.44, 0.1, 0.84, 0, 0.05, -0.42);
  l.box(flat(PAL.concreteDark), 1.1, 0.05, 0.56, 0, 0.12, -0.42);
  for (const x of [-0.45, 0.45]) l.box(dark, 0.16, 0.06, 0.06, x, 0.02, 0.01);
  for (const x of [-0.45, 0.45]) l.box(dark, 0.1, 0.12, 0.04, x, -0.02, -0.86);
  compact(lid);
  root.add(lid);
  const seam = new THREE.Mesh(new THREE.BoxGeometry(1.46, 0.05, 0.86), glow(0xffffff));
  seam.position.y = 0.71;
  root.add(seam);
  return { root, lid, seam };
}

/**
 * A depot by a POI's road: a squat steel locker on a plinth, a teal cap and a teal band round it,
 * vents along its sides, a door with a handle under the slot the bag goes into, a cable run down
 * its back, a short aerial, and a lamp in a hood on a mast. The lamp and slot are dark until the
 * depot is switched on, then lit in the teammate's teal, the colour that means "ours" on the HUD;
 * nothing else on it glows.
 */
export function buildDepot(): { root: THREE.Group; lamp: THREE.Mesh; slot: THREE.Mesh } {
  const root = new THREE.Group();
  const { box, cyl } = parts(root, true);
  const dark = flat(PAL.gun);
  const teal = flat(PAL.teal);
  box(flat(PAL.concreteDark), 1.3, 0.16, 1.0, 0, 0.08, 0);
  box(flat(PAL.steel), 1.1, 0.95, 0.8, 0, 0.635, 0);
  box(teal, 1.16, 0.12, 0.86, 0, 1.17, 0);
  box(teal, 1.12, 0.1, 0.82, 0, 0.3, 0);
  // The front (-z, turned away from the POI, along the road) carries the slot the bag goes into, and the door under it.
  box(dark, 0.7, 0.3, 0.06, 0, 0.8, -0.42);
  box(flat(PAL.gunLight), 0.7, 0.34, 0.03, 0, 0.53, -0.41);
  box(dark, 0.16, 0.05, 0.05, 0.22, 0.55, -0.44);
  for (const s of [-1, 1]) for (let i = 0; i < 3; i++) box(dark, 0.03, 0.05, 0.5, s * 0.56, 0.72 + i * 0.1, 0);
  box(dark, 0.08, 0.95, 0.06, -0.35, 0.68, 0.42);
  cyl(flat(PAL.steel), 0.012, 0.7, -0.4, 1.58, 0.25, 4);
  cyl(dark, 0.04, 0.5, 0.38, 1.46, 0.2, 6);
  box(dark, 0.26, 0.05, 0.26, 0.38, 1.87, 0.2);
  compact(root);
  const slot = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.06, 0.04), glow(PAL.gunLight));
  slot.position.set(0, 0.8, -0.46);
  root.add(slot);
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

/** A hull's plan, pointed at -x, `len` long and `beam` wide, as a prism from `y0` up to `y1`. */
function hullPrism(len: number, beam: number, bow: number, y0: number, y1: number): THREE.BufferGeometry {
  const h = len / 2;
  const b = beam / 2;
  const s = new THREE.Shape();
  s.moveTo(-h, 0);
  s.lineTo(-h + bow, b);
  s.lineTo(h - 0.3, b);
  s.lineTo(h, b - 0.3);
  s.lineTo(h, -b + 0.3);
  s.lineTo(h - 0.3, -b);
  s.lineTo(-h + bow, -b);
  s.closePath();
  // Extruded along z, then stood up: the plan's y becomes the world's z, the extrusion its height.
  return new THREE.ExtrudeGeometry(s, { depth: y1 - y0, bevelEnabled: false }).rotateX(-Math.PI / 2).translate(0, y0, 0);
}

/**
 * The boat that comes up the harbor's channel to the quay, its bow at -x (the way it comes in): a
 * work boat 10 m long, its hull dark red under the waterline and white above it with a rust boot
 * stripe, a raised bow, rails along its deck and tyres hung over its sides; the wheelhouse with a
 * band of windows, a teal roof, a mast and radar, the exhaust behind it; on the open after deck two
 * crates and the A-frame over the stern.
 */
export function buildBoat(): THREE.Group {
  const g = new THREE.Group();
  const { box, cyl, put } = parts(g, true);
  const white = flat(PAL.concrete);
  const dark = flat(PAL.gun);
  const steel = flat(PAL.steel);
  put(hullPrism(10, 3.2, 2.4, -0.5, 0.1), flat(PAL.hull), 0, 0, 0);
  put(hullPrism(10.06, 3.26, 2.4, 0.05, 0.3), flat(PAL.rust), 0, 0, 0);
  put(hullPrism(10, 3.4, 2.4, 0.3, 1.0), white, 0, 0, 0);
  put(hullPrism(3.2, 3.0, 2.0, 1.0, 1.45), white, -3.4, 0, 0);
  // Rails along both sides of the after deck: a top rail on posts.
  for (const z of [-1.55, 1.55]) {
    box(steel, 6.2, 0.08, 0.08, 1.7, 1.9, z);
    for (let x = -1.2; x <= 4.6; x += 1.45) box(steel, 0.08, 0.9, 0.08, x, 1.45, z);
    for (const x of [-2.2, -0.2, 1.8, 3.6]) cyl(flat(PROP_PAL.tyre), 0.28, 0.22, x, 0.7, z * 1.17, 8, Math.PI / 2);
  }
  // The wheelhouse, its windows all round, its roof, the mast with its radar bar, the exhaust behind.
  box(white, 2.4, 1.7, 2.6, -0.8, 1.85, 0);
  box(flat(PAL.glass), 2.46, 0.5, 2.66, -0.8, 2.3, 0);
  box(flat(PAL.teal), 2.8, 0.16, 3.0, -0.8, 2.78, 0);
  cyl(steel, 0.07, 1.6, -0.6, 3.6, 0, 6);
  box(dark, 1.3, 0.12, 0.2, -0.6, 4.0, 0);
  cyl(dark, 0.2, 1.4, 0.7, 2.6, 0.7, 8);
  put(new THREE.TorusGeometry(0.32, 0.07, 4, 10), flat(PAL.healRed), -0.8, 1.6, -1.34);
  // The after deck: two crates and the A-frame over the stern.
  box(flat(PAL.crate), 1.2, 0.9, 1.2, 2.2, 1.45, -0.6);
  box(flat(PAL.crate), 0.9, 0.7, 0.9, 2.4, 1.35, 0.7);
  for (const z of [-1.3, 1.3]) box(flat(PAL.rust), 0.18, 2.4, 0.18, 4.5, 2.1, z, 0, 0, -0.25);
  box(flat(PAL.rust), 0.2, 0.2, 2.8, 4.2, 3.25, 0);
  compact(g);
  return g;
}

/**
 * The dropship called down onto a pad or a runway, its nose at -z: a pale fuselage with a rust band,
 * a tapered nose under a slanted windscreen, a tail boom with two canted fins and a tailplane, a dark
 * stub wing across it with an engine pod at each tip (intake rim on top, nozzle under, the flame
 * below as a sprite), skids on struts, the rear ramp and a side door. Mostly seen from below as it
 * comes down, so the wing, the pods and the skids carry its outline.
 */
export function buildDropship(): THREE.Group {
  const g = new THREE.Group();
  const { box, cyl, put } = parts(g, true);
  const hull = flat(PAL.concrete);
  const dark = flat(PAL.gun);
  const mid = flat(PAL.gunLight);
  const steel = flat(PAL.steel);
  box(hull, 3.2, 2.2, 6.2, 0, 0, 0);
  box(flat(PAL.rust), 3.26, 0.35, 6.26, 0, 0.35, 0);
  // The nose: a frustum of the fuselage's section, flattened to its height, the windscreen leant over it.
  put(new THREE.CylinderGeometry(0.9, 2.26, 2.2, 4, 1).rotateY(Math.PI / 4).rotateX(-Math.PI / 2).scale(1, 0.69, 1), hull, 0, -0.1, -4.2);
  box(flat(PAL.glass), 1.9, 0.08, 1.5, 0, 0.72, -3.9, -0.42);
  // The tail boom, two canted fins and the tailplane.
  box(hull, 1.3, 1.1, 4.4, 0, 0.45, 5.2);
  for (const s of [-1, 1]) box(dark, 0.16, 1.8, 1.5, s * 0.75, 1.6, 6.7, 0, 0, s * 0.3);
  box(dark, 3.6, 0.14, 1.1, 0, 1.0, 6.8);
  // The rear ramp's outline under the boom and the side doors.
  box(dark, 2.7, 1.5, 0.08, 0, -0.3, 3.12);
  for (const s of [-1, 1]) box(dark, 0.06, 1.3, 1.5, s * 1.61, -0.15, -0.9);
  // The stub wing and its engine pods.
  box(dark, 10.4, 0.28, 2.4, 0, 0.75, 0.3);
  for (const s of [-1, 1]) {
    cyl(mid, 1.0, 2.0, s * 5.8, 0.5, 0.3, 10);
    cyl(dark, 1.08, 0.25, s * 5.8, 1.55, 0.3, 10);
    cyl(dark, 0.75, 0.5, s * 5.8, -0.75, 0.3, 10, 0, 0, 0, 0.9);
    const flame = haloSprite(PAL.thrust, 2.2, 0.9);
    flame.position.set(s * 5.8, -1.3, 0.3);
    g.add(flame);
    // Skids on two struts.
    box(steel, 0.18, 0.18, 5.2, s * 1.25, -1.75, -0.2);
    for (const z of [-1.8, 1.4]) box(steel, 0.14, 0.6, 0.14, s * 1.25, -1.35, z);
  }
  compact(g);
  return g;
}

/**
 * A node's core (`FRONT`): the steel pillar itself is a box of the map, so this is what lights it.
 * A glowing band round its top and a halo above, in the colour of who holds the node; a flag on a
 * pole beside it once the node is the player's; and a pale hex shield round it while the network
 * keeps it off the front.
 */
export function buildCore(height: number, half: number): { root: THREE.Group; band: THREE.Mesh; halo: THREE.Sprite; flag: THREE.Group; cloth: THREE.Mesh; shield: THREE.Mesh } {
  const root = new THREE.Group();
  const lit = glow(PAL.foe);
  const band = mesh(new THREE.BoxGeometry(half * 2 + 0.12, 0.5, half * 2 + 0.12), lit, 0, height - 0.6, 0, false);
  root.add(band);
  // The low ring shares the band's material, so it turns with the band to the holder's colour.
  root.add(mesh(new THREE.BoxGeometry(half * 2 + 0.12, 0.18, half * 2 + 0.12), lit, 0, 1.0, 0, false));
  // Dark steel collars frame the band above and below, so it reads as a lit ring set in the pillar.
  const { box } = parts(root);
  for (const y of [height - 0.92, height - 0.28]) box(flat(PAL.gun), half * 2 + 0.3, 0.14, half * 2 + 0.3, 0, y, 0);
  const halo = haloSprite(PAL.foe, 7, 0.75);
  halo.position.y = height + 0.6;
  root.add(halo);
  const flag = new THREE.Group();
  const f = parts(flag, true);
  f.cyl(flat(PAL.steel), 0.07, 7, 0, 3.5, 0, 6, 0, 0, 0, 0.06);
  f.box(flat(PAL.concreteDark), 0.6, 0.3, 0.6, 0, 0.15, 0);
  f.put(new THREE.IcosahedronGeometry(0.13, 0), flat(PAL.steel), 0, 7.05, 0);
  f.box(flat(PAL.steel), 1.9, 0.06, 0.06, 0.95, 6.85, 0);
  compact(flag);
  const cloth = mesh(new THREE.BoxGeometry(1.8, 1.1, 0.05), flat(PAL.flag), 0.95, 6.3, 0, false);
  flag.add(cloth);
  flag.position.set(-2, 0, 0.6);
  root.add(flag);
  const shield = new THREE.Mesh(
    new THREE.CylinderGeometry(half + 1.1, half + 1.1, height + 1.2, 6, 1, true),
    new THREE.MeshBasicMaterial({ toneMapped: false, color: PAL.coreShield, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide, wireframe: true }),
  );
  shield.position.y = (height + 1.2) / 2 - 0.2;
  root.add(shield);
  return { root, band, halo, flag, cloth, shield };
}

/** The objective's beacon: a tall pale shaft of light, seen from across the island (the fog does not hide it). */
export function buildBeacon(): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.CylinderGeometry(0.9, 0.9, 260, 12, 1, true),
    new THREE.MeshBasicMaterial({ toneMapped: false, color: PAL.beacon, transparent: true, opacity: 0.32, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }),
  );
  m.frustumCulled = false;
  return m;
}

/**
 * The thread of flare smoke over a bin that holds a flare (the top floors of the tall buildings):
 * a thin column in the flare's red-orange (smoke, not light: it is not added to the sky), widening as
 * it rises, seen from across the region so a
 * roof with a flare on it can be picked out from the ground. The fog does not hide it.
 */
export function buildFlareSmoke(): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.CylinderGeometry(1.8, 0.3, 70, 8, 1, true),
    new THREE.MeshBasicMaterial({ toneMapped: false, color: PAL.ring, transparent: true, opacity: 0.6, depthWrite: false, side: THREE.DoubleSide, fog: false }),
  );
  m.frustumCulled = false;
  return m;
}
