import * as THREE from "three";
import { NEIGHBOUR_SLOTS } from "../meta/neighbours";
import { PAL } from "./models";

/*
 * The neighbours' islands seen from this one (docs/ringfall/multiplayer.md, お隣の島): a low hazy
 * island on the horizon toward each neighbour's slot at sea, a few towers on it and a green light
 * blinking on the tallest, so other players' islands are there to be seen from the coast. Scenery
 * only, far past the fog and drawn without it, kept at a fixed distance in the direction of its slot
 * (as the sky is kept round the camera), so it neither grows nor is reached.
 */

/** How far out the islands stand, in metres: past every tier's fog, inside the camera's far plane. */
const AWAY = 700;

interface Isle {
  root: THREE.Group;
  light: THREE.Sprite;
  slot: { x: number; z: number };
}

export class NeighbourIslands {
  readonly group = new THREE.Group();
  private isles: Isle[] = [];
  private readonly land: THREE.MeshBasicMaterial;
  private readonly tower: THREE.MeshBasicMaterial;

  constructor(
    haze: THREE.ColorRepresentation,
    private halo: (color: number, size: number, opacity: number) => THREE.Sprite,
  ) {
    // Far land reads as the haze with a little of the rock in it; the towers a shade darker.
    const h = new THREE.Color(haze);
    this.land = new THREE.MeshBasicMaterial({ color: h.clone().lerp(new THREE.Color(PAL.rock), 0.28), fog: false });
    this.tower = new THREE.MeshBasicMaterial({ color: h.clone().lerp(new THREE.Color(PAL.steel), 0.4), fog: false });
    this.group.visible = false;
  }

  /** Shows the first `count` neighbours' islands (none hides them). */
  set(count: number) {
    const n = Math.min(count, NEIGHBOUR_SLOTS.length);
    if (n === this.isles.length) return;
    for (const i of this.isles) this.group.remove(i.root);
    this.isles = NEIGHBOUR_SLOTS.slice(0, n).map((slot, k) => this.build(slot, k));
    this.group.visible = n > 0;
  }

  private build(slot: { x: number; z: number }, k: number): Isle {
    const root = new THREE.Group();
    // A low dome of land, longer than it is deep, a little different for each slot.
    const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2), this.land);
    dome.scale.set(46 + k * 6, 9 + (k % 2) * 4, 22);
    root.add(dome);
    // A few towers on it: whatever its owner has built there, as seen across the water.
    const heights = [16, 26, 12, 20].map((h, i) => h + ((k * 7 + i * 5) % 9));
    let top = { y: 0, x: 0 };
    heights.forEach((h, i) => {
      const x = (i - 1.5) * (9 + k);
      const t = new THREE.Mesh(new THREE.BoxGeometry(3 + (i % 2) * 2, h, 3), this.tower);
      t.position.set(x, h / 2 + 4, (i % 2) * 4 - 2);
      root.add(t);
      if (h + 4 > top.y) top = { y: h + 4, x };
    });
    const light = this.halo(PAL.rivalHeld, 9, 0.9);
    light.position.set(top.x, top.y + 2, 0);
    root.add(light);
    this.group.add(root);
    return { root, light, slot };
  }

  /** Keeps each island at its distance toward its slot from the camera, its light blinking. */
  frame(camera: THREE.Camera, time: number) {
    if (!this.group.visible) return;
    const c = camera.position;
    this.isles.forEach((isle, k) => {
      const dx = isle.slot.x - c.x;
      const dz = isle.slot.z - c.z;
      const d = Math.hypot(dx, dz) || 1;
      isle.root.position.set(c.x + (dx / d) * AWAY, c.y - 14, c.z + (dz / d) * AWAY);
      isle.root.rotation.y = Math.atan2(dx, dz);
      // A slow blink, each light at its own phase, so the islands read as lived in.
      (isle.light.material as THREE.SpriteMaterial).opacity = 0.35 + 0.6 * Math.max(0, Math.sin(time * 1.4 + k * 1.7));
    });
  }
}
