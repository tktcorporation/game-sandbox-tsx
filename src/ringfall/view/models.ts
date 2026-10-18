import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { ENEMIES, type EnemyKind, type HealKind, type Rarity, type ToolKind, type ValuableKind, type WeaponKind } from "../sim/config";
import type { LootKind } from "../sim/state";
import type { Box } from "../sim/map";

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
  concrete: 0xcfc8b8,
  concreteDark: 0x9c9586,
  rust: 0xb5482b,
  teal: 0x2f7f86,
  ochre: 0x8a6a3a,
  crate: 0xd99a3e,
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

export function glow(color: number, opacity = 1): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity, depthWrite: opacity >= 1 });
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
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: halo(), color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending }));
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
      // tint 0: rust-red plate, 1: the dark hull, 2: grey girders and posts, 3: teal paint, 4: white paint.
      const color = [PAL.rust, PAL.hull, PAL.steel, PAL.teal, PAL.paint][b.tint % 5];
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

/** The one material a chunk's merged statics share: each vertex carries its own colour. */
const chunkMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });

/**
 * Merge every mesh under `root` into as few meshes as possible: all flat-shaded ones into
 * one, their colours moved into the vertices, and the rest one per material. A chunk of
 * the world so costs one or two draw calls, and is culled as a whole.
 */
export function mergeChunk(root: THREE.Object3D): THREE.Group {
  root.updateMatrixWorld(true);
  const lit: THREE.BufferGeometry[] = [];
  const other = new Map<THREE.Material, THREE.BufferGeometry[]>();
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const geo = (o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone()).applyMatrix4(o.matrixWorld);
    for (const name of Object.keys(geo.attributes)) if (!["position", "normal"].includes(name)) geo.deleteAttribute(name);
    const mat = o.material as THREE.Material;
    if (mat instanceof THREE.MeshLambertMaterial && !mat.vertexColors && !mat.transparent) {
      const c = mat.color;
      const n = geo.attributes.position.count;
      const col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
      geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
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

export interface EnemyModel {
  root: THREE.Group;
  body: THREE.Group; // rotated to the robot's yaw
  eye: THREE.Mesh;
  eyeHalo: THREE.Sprite;
  shield: THREE.Mesh;
  legs: THREE.Object3D[];
  mats: THREE.MeshLambertMaterial[]; // flashed white on hits
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
      body.add(mesh(new THREE.BoxGeometry(0.95, 0.85, 0.6), armor, 0, 1.25, 0));
      body.add(mesh(new THREE.BoxGeometry(0.7, 0.35, 0.5), light, 0, 0.72, 0));
      const head = mesh(new THREE.BoxGeometry(0.5, 0.4, 0.5), armor, 0, k.weakY, 0);
      body.add(head);
      for (const s of [-1, 1]) {
        const leg = new THREE.Group();
        leg.position.set(s * 0.25, 0.62, 0);
        leg.add(mesh(new THREE.BoxGeometry(0.22, 0.62, 0.26), joint, 0, -0.31, 0));
        body.add(leg);
        legs.push(leg);
        body.add(mesh(new THREE.BoxGeometry(0.2, 0.7, 0.22), light, s * 0.62, 1.15, -0.05));
      }
      body.add(mesh(new THREE.BoxGeometry(0.14, 0.14, 0.7), joint, 0.62, 1.0, -0.4));
      eye.position.copy(front(k.weakY));
      eye.position.z -= 0.2;
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
      body.add(mesh(new THREE.BoxGeometry(1.6, 1.3, 1.0), armor, 0, 1.55, 0));
      body.add(mesh(new THREE.BoxGeometry(1.1, 0.4, 0.8), light, 0, 0.8, 0));
      body.add(mesh(new THREE.BoxGeometry(0.62, 0.48, 0.62), armor, 0, k.weakY, 0));
      for (const s of [-1, 1]) {
        const leg = new THREE.Group();
        leg.position.set(s * 0.4, 0.75, 0);
        leg.add(mesh(new THREE.BoxGeometry(0.36, 0.75, 0.42), joint, 0, -0.37, 0));
        body.add(leg);
        legs.push(leg);
        const pod = mesh(new THREE.BoxGeometry(0.5, 0.5, 0.9), light, s * 1.05, 1.9, 0);
        body.add(pod);
      }
      eye.position.copy(front(k.weakY));
      eye.position.z -= 0.3;
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
  const shield = new THREE.Mesh(
    new THREE.IcosahedronGeometry(k.radius * (kind === "titan" ? 1.6 : 1.5), 1),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, wireframe: true, depthWrite: false }),
  );
  shield.position.y = k.bodyY;
  root.add(shield);
  const mats: THREE.MeshLambertMaterial[] = [armor, light];
  return { root, body, eye, eyeHalo, shield, legs, mats };
}

/** The front of each kind's body that a plate covers: width, height, centre height, and the face's z. */
const CHEST: Record<EnemyKind, { w: number; h: number; y: number; z: number }> = {
  drone: { w: 0.5, h: 0.32, y: 0.12, z: -0.42 },
  grunt: { w: 0.85, h: 0.75, y: 1.25, z: -0.3 },
  charger: { w: 0.7, h: 0.32, y: 1.0, z: -0.42 },
  heavy: { w: 1.4, h: 1.15, y: 1.55, z: -0.5 },
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
  /** Arms and rifle, pitched toward what it aims at. */
  arms: THREE.Group;
}

/**
 * The teammate: a person in a teal suit and sand vest, so it reads as one of
 * ours at a glance against the navy robots. Nothing on it glows.
 */
export function buildAlly(): AllyModel {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const suit = flat(PAL.teal);
  const vest = flat(PAL.sand);
  const dark = flat(PAL.joint);
  const legs: THREE.Object3D[] = [];
  for (const s of [-1, 1]) {
    const leg = new THREE.Group();
    leg.position.set(s * 0.13, 0.86, 0);
    leg.add(mesh(new THREE.BoxGeometry(0.2, 0.84, 0.24), suit, 0, -0.42, 0));
    leg.add(mesh(new THREE.BoxGeometry(0.22, 0.14, 0.32), dark, 0, -0.8, -0.04));
    body.add(leg);
    legs.push(leg);
  }
  body.add(mesh(new THREE.BoxGeometry(0.5, 0.62, 0.3), suit, 0, 1.18, 0));
  body.add(mesh(new THREE.BoxGeometry(0.54, 0.42, 0.34), vest, 0, 1.24, 0));
  body.add(mesh(new THREE.BoxGeometry(0.36, 0.44, 0.2), flat(PAL.ochre), 0, 1.22, 0.26));
  body.add(mesh(new THREE.BoxGeometry(0.28, 0.28, 0.3), flat(PAL.concrete), 0, 1.66, 0));
  body.add(mesh(new THREE.BoxGeometry(0.32, 0.14, 0.34), suit, 0, 1.78, 0.01));
  body.add(mesh(new THREE.BoxGeometry(0.24, 0.09, 0.04), dark, 0, 1.67, -0.16));
  const arms = new THREE.Group();
  arms.position.set(0, 1.38, 0);
  for (const s of [-1, 1]) arms.add(mesh(new THREE.BoxGeometry(0.14, 0.14, 0.5), suit, s * 0.22, -0.06, -0.22));
  arms.add(mesh(new THREE.BoxGeometry(0.08, 0.12, 0.75), flat(PAL.gun), 0.08, -0.02, -0.5));
  arms.add(mesh(new THREE.BoxGeometry(0.06, 0.16, 0.1), flat(PAL.gunLight), 0.08, -0.12, -0.36));
  body.add(arms);
  return { root, body, legs, arms };
}

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
  const len = { pike: 0.75, hornet: 0.5, maul: 0.8, lance: 1.0, talon: 1.25 }[kind];
  add(new THREE.BoxGeometry(0.09, 0.13, len * 0.6), dark, 0, 0, 0);
  add(new THREE.BoxGeometry(0.05, 0.05, len * 0.5), mid, 0, 0.03, -len * 0.5);
  add(new THREE.BoxGeometry(0.07, 0.16, 0.08), dark, 0, -0.12, 0.1);
  add(new THREE.BoxGeometry(0.06, 0.1, 0.24), mid, 0, -0.02, len * 0.38);
  add(new THREE.BoxGeometry(0.094, 0.018, len * 0.3), stripe, 0, 0.035, -0.02);
  add(new THREE.BoxGeometry(0.03, 0.03, len * 0.3), mid, 0, 0.085, 0.02);
  if (kind === "pike" || kind === "hornet") add(new THREE.BoxGeometry(0.06, 0.18, 0.08), dark, 0, -0.13, -0.12);
  if (kind === "maul") add(new THREE.BoxGeometry(0.11, 0.08, len * 0.4), mid, 0, -0.08, -len * 0.3);
  if (kind === "talon") {
    // A long scope with its two lenses, and a bolt handle.
    add(new THREE.CylinderGeometry(0.05, 0.05, 0.42, 10).rotateX(Math.PI / 2), dark, 0, 0.13, -0.05);
    add(new THREE.CylinderGeometry(0.062, 0.062, 0.06, 10).rotateX(Math.PI / 2), mid, 0, 0.13, -0.27);
    add(new THREE.CylinderGeometry(0.058, 0.058, 0.05, 10).rotateX(Math.PI / 2), mid, 0, 0.13, 0.17);
    add(new THREE.BoxGeometry(0.1, 0.025, 0.025), mid, 0.07, 0.04, 0.12);
  }
  if (kind === "lance") add(new THREE.CylinderGeometry(0.045, 0.045, 0.32, 8).rotateX(Math.PI / 2), mid, 0, 0.12, -0.05);
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
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: rarity === 3 ? 0.55 : 0.35, depthWrite: false, blending: THREE.AdditiveBlending }),
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
