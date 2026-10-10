import * as THREE from "three";
import { ENEMIES, type EnemyKind, type Rarity, type WeaponKind } from "../sim/config";
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
  rock: 0xb0623c,
  rockDark: 0x8d4a2c,
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
  hot: 0xffe23d,
  white: 0xffffff,
  gun: 0x2b2f38,
  gunLight: 0x4a505c,
} as const;

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

/** Deterministic jitter so rocks look chipped but never poke outside their collision box. */
function chip(geo: THREE.BufferGeometry, seed: number, amount: number, w: number, h: number, d: number) {
  const pos = geo.attributes.position;
  let r = seed * 9301 + 49297;
  const rnd = () => ((r = (r * 9301 + 49297) % 233280) / 233280);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const k = amount * rnd();
    pos.setXYZ(i, x - Math.sign(x) * k * w * 0.5, y > 0 ? y - k * h * 0.4 : y, z - Math.sign(z) * k * d * 0.5);
  }
  geo.computeVertexNormals();
}

export function buildBox(b: Box, i: number): THREE.Object3D {
  const w = b.x1 - b.x0;
  const d = b.z1 - b.z0;
  const g = new THREE.Group();
  g.position.set((b.x0 + b.x1) / 2, 0, (b.z0 + b.z1) / 2);
  switch (b.kind) {
    case "crate": {
      g.add(mesh(new THREE.BoxGeometry(w, b.h, d), flat(PAL.crate), 0, b.h / 2, 0));
      // Dark bands read as a crate, not a block.
      for (let y = 0.45; y < b.h; y += 0.9) g.add(mesh(new THREE.BoxGeometry(w + 0.03, 0.1, d + 0.03), flat(PAL.ochre), 0, y, 0, false));
      break;
    }
    case "container": {
      const color = [PAL.rust, PAL.teal, PAL.ochre][b.tint % 3];
      g.add(mesh(new THREE.BoxGeometry(w, b.h, d), flat(color), 0, b.h / 2, 0));
      const long = w > d;
      const len = long ? w : d;
      const ribMat = flat(new THREE.Color(color).multiplyScalar(0.78).getHex());
      for (let t = -len / 2 + 0.4; t < len / 2; t += 0.55) {
        const rib = new THREE.BoxGeometry(long ? 0.12 : w + 0.08, b.h - 0.2, long ? d + 0.08 : 0.12);
        g.add(mesh(rib, ribMat, long ? t : 0, b.h / 2, long ? 0 : t, false));
      }
      g.add(mesh(new THREE.BoxGeometry(w + 0.1, 0.12, d + 0.1), flat(PAL.concreteDark), 0, b.h, 0, false));
      break;
    }
    case "wall": {
      g.add(mesh(new THREE.BoxGeometry(w, b.h, d), flat(PAL.concrete), 0, b.h / 2, 0));
      g.add(mesh(new THREE.BoxGeometry(w + 0.04, 0.5, d + 0.04), flat(PAL.concreteDark), 0, 0.25, 0, false));
      break;
    }
    case "rock": {
      const geo = new THREE.BoxGeometry(w, b.h, d, 3, 2, 3).toNonIndexed();
      chip(geo, i + 3, 0.18, w, b.h, d);
      g.add(mesh(geo, flat(PAL.rock), 0, b.h / 2, 0));
      break;
    }
    case "pad": {
      g.add(mesh(new THREE.BoxGeometry(w, b.h, d), flat(0x5b5f66), 0, b.h / 2, 0));
      const ring = new THREE.Mesh(new THREE.RingGeometry(3.2, 3.6, 40), glow(PAL.hot));
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = b.h + 0.02;
      g.add(ring);
      break;
    }
    case "tower": {
      g.add(mesh(new THREE.BoxGeometry(w, b.h, d), flat(PAL.concrete), 0, b.h / 2, 0));
      g.add(mesh(new THREE.BoxGeometry(w + 0.2, 0.2, d + 0.2), flat(PAL.rust), 0, b.h, 0, false));
      const mast = mesh(new THREE.CylinderGeometry(0.08, 0.14, 9, 6), flat(PAL.gunLight), w / 2 - 0.4, b.h + 4.5, -d / 2 + 0.4);
      g.add(mast);
      const dish = mesh(new THREE.CylinderGeometry(0.9, 0.2, 0.4, 10, 1, true), flat(PAL.concrete), w / 2 - 0.4, b.h + 6.5, -d / 2 + 0.4);
      dish.rotation.x = 0.8;
      g.add(dish);
      const light = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), glow(PAL.eye));
      light.position.set(w / 2 - 0.4, b.h + 9.1, -d / 2 + 0.4);
      g.add(light);
      break;
    }
  }
  return g;
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
  const len = { pike: 0.75, hornet: 0.5, maul: 0.8, lance: 1.0 }[kind];
  add(new THREE.BoxGeometry(0.09, 0.13, len * 0.6), dark, 0, 0, 0);
  add(new THREE.BoxGeometry(0.05, 0.05, len * 0.5), mid, 0, 0.03, -len * 0.5);
  add(new THREE.BoxGeometry(0.07, 0.16, 0.08), dark, 0, -0.12, 0.1);
  add(new THREE.BoxGeometry(0.06, 0.1, 0.24), mid, 0, -0.02, len * 0.38);
  add(new THREE.BoxGeometry(0.094, 0.018, len * 0.3), stripe, 0, 0.035, -0.02);
  add(new THREE.BoxGeometry(0.03, 0.03, len * 0.3), mid, 0, 0.085, 0.02);
  if (kind === "pike" || kind === "hornet") add(new THREE.BoxGeometry(0.06, 0.18, 0.08), dark, 0, -0.13, -0.12);
  if (kind === "maul") add(new THREE.BoxGeometry(0.11, 0.08, len * 0.4), mid, 0, -0.08, -len * 0.3);
  if (kind === "lance") add(new THREE.CylinderGeometry(0.045, 0.045, 0.32, 8).rotateX(Math.PI / 2), mid, 0, 0.12, -0.05);
  return g;
}

export function buildLootItem(kind: "weapon" | "armor" | "battery" | "shard", rarity: Rarity, weapon?: WeaponKind): THREE.Group {
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
  } else if (kind === "battery") {
    g.add(mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.42, 8), flat(PAL.gunLight), 0, 0.35, 0, false));
    g.add(mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.2, 8), glow(RARITY_COLOR[1]), 0, 0.35, 0, false));
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

export function buildBin(): { root: THREE.Group; lid: THREE.Object3D; seam: THREE.Mesh } {
  const root = new THREE.Group();
  root.add(mesh(new THREE.BoxGeometry(1.4, 0.7, 0.8), flat(PAL.teal), 0, 0.35, 0));
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

export function buildCare(): THREE.Group {
  const g = new THREE.Group();
  g.add(mesh(new THREE.CylinderGeometry(0.9, 1.1, 2.0, 8), flat(PAL.gun), 0, 1.0, 0));
  g.add(mesh(new THREE.CylinderGeometry(0.95, 0.95, 0.25, 8), glow(RARITY_COLOR[3]), 0, 1.4, 0));
  g.add(mesh(new THREE.ConeGeometry(0.95, 0.6, 8), flat(PAL.gunLight), 0, 2.3, 0));
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
