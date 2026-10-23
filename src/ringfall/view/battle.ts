import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { CONQUEST, ENEMIES, type EnemyKind } from "../sim/config";
import { CAMP, DEPOTS, depotIndex, NODES } from "../sim/map";
import { columnPoints, nodePoint, type Battle, type Side } from "../sim/battle";
import { terrainHeight } from "../sim/terrain";
import { AREA } from "../sim/areas";
import type { State } from "../sim/state";
import { PAL, buildBoat, buildDropship, haloSprite } from "./models";

/*
 * The day's battle seen from afar (sim/battle.ts): the enemy's dropships coming down on the pad
 * and its boats running up the north shore, the squads walking the roads in columns out to the
 * fog (robots past the range they are drawn in full, and squads that are numbers, as simple
 * figures in their side's colours), and the camp's gate and the nodes' depots lighting up as the
 * factory's squads come out. It only reads the state.
 */

/** Figures drawn at once at most. */
const FIGURES = 240;
/** Seconds a dropship stands on the pad after touching down, then the seconds it climbs away. */
const SHIP_STAY = 8;
const SHIP_LEAVE = 10;
/** The same for a boat: on the beach, then backing off to sea. */
const BOAT_STAY = 8;
const BOAT_LEAVE = 12;
/** Metres a dropship comes down from. */
const SHIP_DROP = 160;
/** Seconds the gate's light stays after a squad comes out, and a depot's beam. */
const GATE_LIGHT = 7;
const DEPOT_BEAM = 5;

/** The water channel the boats come up, at the harbor's quay on the north shore (written in the bay's frame, `AREA.bay`). */
export const CHANNEL = { x0: 88 + AREA.bay[0], x1: 170 + AREA.bay[0], z0: -600 + AREA.bay[1], z1: -583 + AREA.bay[1], y: -5.55 };

/** The battle's clock between its reckonings, so what moves on it moves smoothly. */
export const battleClock = (b: Battle) => b.now + (CONQUEST.tick - b.t);

/** A landing's craft: where it is at the battle's clock `t`, its heading, and whether its engines burn; null once it has gone. */
export function landerSpot(l: Battle["landings"][number], t: number): { x: number; y: number; z: number; yaw: number; burn: number } | null {
  const ground = terrainHeight(l.x, l.z);
  if (l.boat) {
    const run = l.down - CONQUEST.land.boat;
    if (t < run || t > l.down + BOAT_STAY + BOAT_LEAVE) return null;
    // Up the channel from its far end along the north bank to beside where the squad goes ashore; it backs off the way it came.
    const k = t < l.down ? 1 - (t - run) / CONQUEST.land.boat : t < l.down + BOAT_STAY ? 0 : (t - l.down - BOAT_STAY) / BOAT_LEAVE;
    const ease = k * (2 - k);
    const from = CHANNEL.x1 - 3;
    return { x: l.x + (from - l.x) * ease, y: CHANNEL.y + 0.1 + Math.sin(t * 1.7) * 0.06, z: CHANNEL.z1 - 3.2, yaw: Math.PI, burn: k > 0 ? 1 : 0.2 };
  }
  const drop = l.down - CONQUEST.land.ship;
  if (t < drop || t > l.down + SHIP_STAY + SHIP_LEAVE) return null;
  const k = t < l.down ? 1 - (t - drop) / CONQUEST.land.ship : t < l.down + SHIP_STAY ? 0 : ((t - l.down - SHIP_STAY) / SHIP_LEAVE) ** 2;
  // Down fast from high, slowing as it comes in over the pad.
  const ease = t < l.down ? k * k * (3 - 2 * k) : k;
  return { x: l.x - 6, y: ground + 3.2 + SHIP_DROP * ease, z: l.z, yaw: 0, burn: t < l.down ? 1 : t < l.down + SHIP_STAY ? 0.35 : 1 };
}

/** A figure for a robot far off: legs, a body and a head, its visor a separate glowing box. */
function figureGeometry(): { body: THREE.BufferGeometry; visor: THREE.BufferGeometry } {
  const box = (w: number, h: number, d: number, y: number) => new THREE.BoxGeometry(w, h, d).translate(0, y, 0);
  return {
    body: mergeGeometries([box(0.8, 1.0, 0.5, 0.5), box(1.2, 1.1, 0.8, 1.5), box(0.6, 0.45, 0.6, 2.25)], false),
    visor: box(0.7, 0.22, 0.2, 2.25).translate(0, 0, -0.32),
  };
}

const SIDE_BODY: Record<Side, number> = { 0: PAL.friendArmor, 1: PAL.armor, 2: PAL.rogueArmor };
const SIDE_EYE: Record<Side, number> = { 0: PAL.friendEye, 1: PAL.eye, 2: PAL.rogueEye };

interface Lander {
  root: THREE.Group;
  /** The beam of light down to where it comes ashore, seen through the haze from anywhere on the island. */
  beam: THREE.Mesh;
  lights: THREE.Sprite[];
}

export class BattleView {
  readonly group = new THREE.Group();
  private bodies: THREE.InstancedMesh;
  private visors: THREE.InstancedMesh;
  private dummy = new THREE.Object3D();
  private colour = new THREE.Color();
  /** Each squad in numbers as drawn: how far along its walk and where, eased toward the battle's reckoning. */
  private eased = new Map<number, { d: number; x: number; z: number; seen: boolean }>();
  private landers = new Map<string, Lander>();
  /** The light at the camp's gate as a squad comes out: two leaves of light swinging open. */
  private gate: THREE.Group;
  private leaves: THREE.Mesh[] = [];
  private gateLamps: THREE.Sprite[] = [];
  /** A beam over a depot a squad has just come out of, one per node. */
  private depotBeams: THREE.Mesh[] = [];
  private time = 0;

  constructor() {
    const g = figureGeometry();
    this.bodies = new THREE.InstancedMesh(g.body, new THREE.MeshLambertMaterial({ flatShading: true }), FIGURES);
    this.visors = new THREE.InstancedMesh(g.visor, new THREE.MeshBasicMaterial({ toneMapped: false }), FIGURES);
    for (const m of [this.bodies, this.visors]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.count = 0;
      m.frustumCulled = false;
      // Seeded so the colour buffer exists before the first figure is drawn.
      m.setColorAt(0, this.colour.setHex(0xffffff));
      this.group.add(m);
    }
    // The gate: two panels of blue light hinged on the gate's posts, closed across the opening.
    this.gate = new THREE.Group();
    const half = (CAMP.gate.x1 - CAMP.gate.x0) / 2;
    this.gate.position.set((CAMP.gate.x0 + CAMP.gate.x1) / 2, CAMP.y, CAMP.gate.z);
    for (const side of [-1, 1]) {
      const hinge = new THREE.Group();
      hinge.position.x = side * half;
      const leaf = new THREE.Mesh(
        new THREE.PlaneGeometry(half, 3.2).translate((-side * half) / 2, 1.6, 0),
        new THREE.MeshBasicMaterial({ toneMapped: false, color: PAL.friendEye, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }),
      );
      hinge.add(leaf);
      this.leaves.push(leaf);
      this.gate.add(hinge);
      const lamp = haloSprite(PAL.friendEye, 3.2, 0);
      lamp.position.set(side * (half + 0.15), 3.9, 0);
      this.gateLamps.push(lamp);
      this.gate.add(lamp);
    }
    this.group.add(this.gate);
    for (const n of NODES) {
      const d = DEPOTS[depotIndex(n.id)];
      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(0.5, 1.4, 60, 10, 1, true),
        new THREE.MeshBasicMaterial({ toneMapped: false, color: PAL.friendEye, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }),
      );
      beam.position.set(d.x, d.y + 30, d.z);
      beam.visible = false;
      this.depotBeams.push(beam);
      this.group.add(beam);
    }
  }

  /** Drops what a raid left (a new raid starts). */
  reset() {
    this.eased.clear();
    for (const l of this.landers.values()) this.group.remove(l.root, l.beam);
    this.landers.clear();
    this.bodies.count = this.visors.count = 0;
  }

  update(s: State, dt: number, fx: number, fz: number, near: number, far: number) {
    this.time += dt;
    const b = s.battle;
    this.group.visible = !!b;
    if (!b) return;
    const t = battleClock(b);
    this.craft(b, t);
    this.departures(b, t);
    this.figures(s, b, dt, fx, fz, near, far);
  }

  /** The enemy's dropships and boats: down the beam, ashore, and away again. */
  private craft(b: Battle, t: number) {
    const live = new Set<string>();
    for (const l of b.landings) {
      const key = `${l.down}|${l.x}|${l.z}`;
      const at = landerSpot(l, t);
      if (!at) continue;
      live.add(key);
      let v = this.landers.get(key);
      if (!v) {
        const root = l.boat ? buildBoat() : buildDropship();
        // The enemy's craft are larger than the player's, so they read from across the island.
        root.scale.setScalar(l.boat ? 1.3 : 2.2);
        const lights: THREE.Sprite[] = [];
        for (const [x, y, z] of l.boat ? [[-4.6, 3.2, 0], [4.6, 1.6, 0]] : [[-5.5, 1.2, 0.5], [5.5, 1.2, 0.5], [0, 1.6, -4.5]]) {
          const sp = haloSprite(PAL.eye, l.boat ? 3.2 : 4, 0.9);
          (sp.material as THREE.SpriteMaterial).fog = false;
          sp.position.set(x, y, z);
          root.add(sp);
          lights.push(sp);
        }
        const beam = new THREE.Mesh(
          new THREE.CylinderGeometry(0.8, 3.5, 200, 12, 1, true),
          new THREE.MeshBasicMaterial({ toneMapped: false, color: PAL.eye, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }),
        );
        beam.position.set(l.x, terrainHeight(l.x, l.z) + 100, l.z);
        v = { root, beam, lights };
        this.landers.set(key, v);
        this.group.add(root, beam);
      }
      v.root.position.set(at.x, at.y, at.z);
      v.root.rotation.set(0, at.yaw, l.boat ? Math.sin(t * 1.1) * 0.03 : Math.sin(t * 1.3) * 0.04);
      // The beam marks where it comes ashore while it comes in, and fades once it is down.
      const coming = Math.max(0, Math.min(1, (l.down - t) / 4));
      (v.beam.material as THREE.MeshBasicMaterial).opacity = 0.32 * coming * (0.8 + 0.2 * Math.sin(this.time * 6));
      v.beam.visible = coming > 0;
      v.lights.forEach((sp, i) => ((sp.material as THREE.SpriteMaterial).opacity = Math.sin(this.time * 5 + i * 2) > -0.2 ? 0.95 : 0.25));
    }
    for (const [key, v] of this.landers)
      if (!live.has(key)) {
        this.group.remove(v.root, v.beam);
        this.landers.delete(key);
      }
  }

  /** The gate's leaves of light swing open as a squad of the factory's comes out; a depot it comes out of sends up a beam. */
  private departures(b: Battle, t: number) {
    const gate = b.departs.filter((d) => d.from < 0).at(-1);
    const since = gate ? t - gate.at : Infinity;
    const lit = since < GATE_LIGHT;
    const open = Math.min(1, Math.max(0, since / 1.4));
    this.leaves.forEach((leaf, i) => {
      leaf.parent!.rotation.y = (i ? -1 : 1) * open * (Math.PI / 2) * 0.95;
      (leaf.material as THREE.MeshBasicMaterial).opacity = lit ? 0.85 * Math.min(1, (GATE_LIGHT - since) / 2) : 0;
      leaf.visible = lit;
    });
    this.gateLamps.forEach((lamp) => ((lamp.material as THREE.SpriteMaterial).opacity = lit ? (Math.sin(this.time * 10) > 0 ? 1 : 0.3) : 0));
    this.depotBeams.forEach((beam, i) => {
      const last = b.departs.filter((d) => d.from === i).at(-1);
      const age = last ? t - last.at : Infinity;
      beam.visible = age < DEPOT_BEAM;
      if (beam.visible) (beam.material as THREE.MeshBasicMaterial).opacity = 0.35 * (1 - age / DEPOT_BEAM);
    });
  }

  /**
   * The battle's robots past the range robots are drawn in full (`near`), out to the fog (`far`),
   * as figures: those in the world where they stand, and the members of squads that are numbers
   * where their reckoning puts them, eased between reckonings, in a column on the way.
   */
  private figures(s: State, b: Battle, dt: number, fx: number, fz: number, near: number, far: number) {
    let n = 0;
    const put = (x: number, z: number, yaw: number, kind: EnemyKind, side: Side, step: number) => {
      if (n >= FIGURES) return;
      const d = Math.hypot(x - fx, z - fz);
      if (d < near || d > far) return;
      const k = ENEMIES[kind];
      const scale = kind === "heavy" ? 1.45 : kind === "drone" ? 0.7 : 1;
      const y = terrainHeight(x, z) + (k.fly > 0 ? k.fly - 1 : 0) + Math.abs(Math.sin(step)) * 0.12;
      this.dummy.position.set(x, y, z);
      this.dummy.rotation.set(0, -yaw, 0);
      this.dummy.scale.setScalar(scale);
      this.dummy.updateMatrix();
      this.bodies.setMatrixAt(n, this.dummy.matrix);
      this.visors.setMatrixAt(n, this.dummy.matrix);
      this.bodies.setColorAt(n, this.colour.setHex(SIDE_BODY[side]));
      this.visors.setColorAt(n, this.colour.setHex(SIDE_EYE[side]));
      n++;
    };
    // The battle's robots in the world.
    for (const e of s.friends) put(e.pos.x, e.pos.z, e.yaw, e.kind, 0, this.time * 6 + e.id);
    for (const e of s.enemies) if (e.battle && e.mode !== "spawning") put(e.pos.x, e.pos.z, e.yaw, e.kind, e.rogue ? 2 : 1, this.time * 6 + e.id);
    // The squads that are numbers.
    const seen = new Set<number>();
    for (const q of b.squads) {
      if (q.squad >= 0 || q.ashore > 0 || !q.units.length) continue;
      seen.add(q.id);
      let v = this.eased.get(q.id);
      if (!v || Math.abs(v.d - q.d) > 30 || Math.hypot(v.x - q.x, v.z - q.z) > 30) v = { d: q.d, x: q.x, z: q.z, seen: true };
      const k = Math.min(1, dt * 1.5);
      v.d += (q.d - v.d) * k;
      v.x += (q.x - v.x) * k;
      v.z += (q.z - v.z) * k;
      this.eased.set(q.id, v);
      const pts = columnPoints(q, v.d, v);
      const head = pts.length > 1 ? Math.atan2(pts[0].x - pts[1].x, -(pts[0].z - pts[1].z)) : Math.atan2(nodePoint(q.to).x - v.x, -(nodePoint(q.to).z - v.z));
      q.units.forEach((u, m) => put(pts[m].x, pts[m].z, head, u.kind, q.side, this.time * 6 + q.id * 3 + m));
    }
    for (const id of this.eased.keys()) if (!seen.has(id)) this.eased.delete(id);
    this.bodies.count = this.visors.count = n;
    this.bodies.instanceMatrix.needsUpdate = this.visors.instanceMatrix.needsUpdate = true;
    if (this.bodies.instanceColor) this.bodies.instanceColor.needsUpdate = true;
    if (this.visors.instanceColor) this.visors.instanceColor.needsUpdate = true;
  }
}
