import { Vector3, type Camera } from "three";
import { ENEMIES } from "../sim/config";
import { ceilingAt, los } from "../sim/geom";
import { EXTRACTS, type ExtractId } from "../sim/map";
import { callLeft, type GameEvent, type State } from "../sim/state";
import { terrainHeight } from "../sim/terrain";
import { getMixer, loop, placeLoop, type Loop, type P3 } from "./audio";
import { sfx } from "./sfx";
import { boatSpot, CHANNEL } from "./world";

/*
 * The game side of the sound: puts the listener at the camera, decides which
 * sources are behind walls (a few rays a frame), plays the steps of robots that
 * walk nearby, keeps the wind, the dropship's engines and the sparse distant
 * ambience going, and turns the sim's events into cues. It only reads the sim.
 */

/** Rays cast per frame to test whether a source is walled off; the rest reuse the last answer. */
const RAYS_PER_FRAME = 4;
/** How long a wall test stays good for a source, in seconds. */
const RAY_TTL = 0.35;

const lift = (p: P3, dy: number): P3 => ({ x: p.x, y: p.y + dy, z: p.z });
const ground = (x: number, z: number, dy = 1): P3 => ({ x, y: terrainHeight(x, z) + dy, z });

class Occlusion {
  private budget = RAYS_PER_FRAME;
  private cache = new Map<string, { blocked: boolean; t: number }>();
  private clock = 0;

  frame(dt: number) {
    this.clock += dt;
    this.budget = RAYS_PER_FRAME;
    if (this.cache.size > 200) for (const [k, v] of this.cache) if (this.clock - v.t > RAY_TTL) this.cache.delete(k);
  }

  blocked = (ear: P3, src: P3): boolean => {
    const key = `${Math.round(src.x / 2)},${Math.round(src.y / 2)},${Math.round(src.z / 2)}`;
    const hit = this.cache.get(key);
    if (hit && this.clock - hit.t < RAY_TTL) return hit.blocked;
    if (this.budget <= 0) return hit?.blocked ?? false;
    this.budget--;
    const blocked = !los(ear, src);
    this.cache.set(key, { blocked, t: this.clock });
    return blocked;
  };
}

export class Soundscape {
  private occ = new Occlusion();
  private breeze: Loop | null = null;
  private gust: Loop | null = null;
  private rush: Loop | null = null;
  /** Engines of the extraction craft that have been called: the dropship, the boat. */
  private crafts = new Map<ExtractId, { loop: Loop; y: number }>();
  private steps = new Map<number, { x: number; z: number; t: number; n: number }>();
  /** Robot step sounds allowed in the current window (rate limit). */
  private stepTokens = 4;
  private ambT = 6;
  private time = 0;
  private readonly fwd = { x: 0, y: 0, z: -1 } as P3;
  private readonly up = { x: 0, y: 1, z: 0 } as P3;
  private readonly v = new Vector3();

  /** Per frame: the listener, the space round it, and the continuous sounds. */
  frame(s: State, camera: Camera, dt: number, running: boolean) {
    const m = getMixer();
    if (!m) return;
    this.time += dt;
    this.occ.frame(dt);
    m.occluder = this.occ.blocked;

    camera.getWorldPosition(this.v);
    const ear = { x: this.v.x, y: this.v.y, z: this.v.z };
    camera.getWorldDirection(this.v);
    Object.assign(this.fwd, { x: this.v.x, y: this.v.y, z: this.v.z });
    this.v.set(0, 1, 0).applyQuaternion(camera.quaternion);
    Object.assign(this.up, { x: this.v.x, y: this.v.y, z: this.v.z });
    m.setListener(ear, this.fwd, this.up);

    const roof = ceilingAt(ear.x, ear.z, 0.4, ear.y + 7, ear.y - 1.6) < Infinity;
    m.setRoom(m.room + ((roof ? 1 : 0) - m.room) * Math.min(1, dt * 6));

    const play = running && s.phase !== "done";
    this.wind(s, ear, play);
    this.craft(s, play, ear);
    if (play && s.phase === "play") {
      this.robotSteps(s, ear, dt);
      this.ambience(ear, dt);
    }
  }

  /** A breeze that grows with height and openness; a rush of air in the fall and the leap. */
  private wind(s: State, ear: P3, play: boolean) {
    const m = getMixer()!;
    this.breeze ??= loop({ bus: "amb", brown: true, freq: 420, q: 0.5 });
    this.gust ??= loop({ bus: "amb", type: "bandpass", freq: 900, q: 1.4 });
    this.rush ??= loop({ bus: "world", type: "lowpass", freq: 700, q: 0.6 });
    const t = m.ctx.currentTime;
    const above = Math.max(0, ear.y - terrainHeight(ear.x, ear.z));
    const height = Math.min(1, Math.max(0, (ear.y + 8) / 32));
    const open = 1 - m.room * 0.85;
    const falling = play && (s.phase === "drop" || !!s.player.leap);
    const base = play ? (0.07 + 0.12 * height + Math.min(0.08, above * 0.004)) * open : 0;
    const swell = 0.6 + 0.4 * Math.sin(this.time * 0.37) * Math.sin(this.time * 0.11 + 1);
    this.breeze?.gain.gain.setTargetAtTime(base * (0.8 + 0.4 * swell), t, 0.4);
    this.gust?.gain.gain.setTargetAtTime(base * 0.35 * Math.max(0, swell - 0.5) * 2, t, 0.5);
    this.gust?.filter.frequency.setTargetAtTime(700 + 900 * swell, t, 0.6);
    const fall = falling ? Math.min(1, Math.hypot(s.player.vel.x, s.player.vel.y, s.player.vel.z) / 30) : 0;
    this.rush?.gain.gain.setTargetAtTime(falling ? 0.16 + 0.12 * fall : 0, t, 0.12);
    this.rush?.filter.frequency.setTargetAtTime(500 + 1600 * fall, t, 0.15);
  }

  /** Where a called craft is: the dropship drops onto its pad, the boat comes up the channel to the quay. */
  private craftAt(id: ExtractId, s: State, y: number): P3 {
    const x = EXTRACTS.find((e) => e.id === id)!;
    const k = Math.min(1, Math.max(0, callLeft(s, id)) / (x.call ?? 1));
    if (id === "boat") return { ...boatSpot(x.x, k), y: CHANNEL.y + 0.6 };
    return { x: x.x, y, z: x.z - 2 };
  }

  /** The engines of each extraction craft, from where it is, once called. */
  private craft(s: State, play: boolean, ear: P3) {
    for (const x of EXTRACTS) {
      if (!x.call) continue;
      const left = callLeft(s, x.id);
      let c = this.crafts.get(x.id);
      if (!play || s.phase !== "play" || left < 0) {
        c?.loop.stop();
        this.crafts.delete(x.id);
        continue;
      }
      const boat = x.id === "boat";
      const want = terrainHeight(x.x, x.z) + 4.5 + 70 * Math.min(1, left / x.call);
      if (!c) {
        const y = want + 20;
        const l = boat
          ? loop({ bus: "world", brown: true, type: "lowpass", freq: 260, q: 1.6, hum: 38, pos: this.craftAt(x.id, s, y), ref: 14, send: 0.25 })
          : loop({ bus: "world", brown: true, type: "lowpass", freq: 380, q: 1.2, hum: 55, pos: this.craftAt(x.id, s, y), ref: 18, send: 0.3 });
        if (!l) continue;
        c = { loop: l, y };
        this.crafts.set(x.id, c);
      }
      c.y += (want - c.y) * 0.013;
      const t = getMixer()!.ctx.currentTime;
      c.loop.gain.gain.setTargetAtTime(left === 0 ? 0.5 : 0.4, t, 0.5);
      const at = this.craftAt(x.id, s, c.y);
      placeLoop(c.loop, at, this.occ.blocked(ear, at));
    }
  }

  /** Footfalls and servo whine of robots walking near the listener. */
  private robotSteps(s: State, ear: P3, dt: number) {
    this.stepTokens = Math.min(4, this.stepTokens + dt * 12);
    const seen = new Set<number>();
    for (const e of s.enemies) {
      seen.add(e.id);
      const d = Math.hypot(e.pos.x - ear.x, e.pos.z - ear.z);
      const heavy = e.kind === "heavy" || e.kind === "titan";
      const last = this.steps.get(e.id);
      if (!last) {
        this.steps.set(e.id, { x: e.pos.x, z: e.pos.z, t: Math.random() * 0.3, n: 0 });
        continue;
      }
      const speed = dt > 0 ? Math.hypot(e.pos.x - last.x, e.pos.z - last.z) / dt : 0;
      last.x = e.pos.x;
      last.z = e.pos.z;
      if (d > (heavy ? 38 : 20) || e.mode === "spawning") continue;
      const flies = ENEMIES[e.kind].fly > 0;
      if (!flies && speed < 0.6) continue;
      last.t -= dt;
      if (last.t > 0) continue;
      const gap = flies ? 0.8 : e.kind === "titan" ? 0.75 : e.kind === "heavy" ? 0.55 : e.kind === "charger" ? 0.24 : 0.36;
      last.t = gap * (speed > 5 ? 0.75 : 1) * (0.9 + Math.random() * 0.2);
      if (this.stepTokens < 1) continue;
      this.stepTokens--;
      last.n++;
      sfx.step(lift(e.pos, flies ? 0.2 : 0.1), e.kind, last.n % 3 === 0);
    }
    if (this.steps.size > seen.size) for (const id of this.steps.keys()) if (!seen.has(id)) this.steps.delete(id);
  }

  /** Now and then, far off: a metal creak, machinery, gulls by the cliffs. */
  private ambience(ear: P3, dt: number) {
    this.ambT -= dt;
    if (this.ambT > 0) return;
    this.ambT = 7 + Math.random() * 9;
    const a = Math.random() * Math.PI * 2;
    const far = (d: number, dy: number) => ({ x: ear.x + Math.cos(a) * d, y: ear.y + dy, z: ear.z + Math.sin(a) * d });
    // Gulls wheel over the coastal cliffs: the highest ground in sight 60 m out.
    let cliff: P3 | null = null;
    let top = ear.y + 28;
    for (let i = 0; i < 8; i++) {
      const b = (i / 8) * Math.PI * 2;
      const x = ear.x + Math.cos(b) * 60;
      const z = ear.z + Math.sin(b) * 60;
      const h = terrainHeight(x, z);
      if (h > top) {
        top = h;
        cliff = { x, y: h + 12, z };
      }
    }
    const r = Math.random();
    if (cliff && r < 0.45) sfx.gull(cliff);
    else if (r < 0.75) sfx.creak(far(35 + Math.random() * 30, 2));
    else sfx.machinery(far(80 + Math.random() * 40, 0));
  }

  /** Drops the continuous sounds (a raid ended). */
  reset() {
    for (const c of this.crafts.values()) c.loop.stop();
    this.crafts.clear();
    this.steps.clear();
  }

  event(e: GameEvent, s: State) {
    const p = s.player;
    const enemyAt = (id: number, dy = 1.2) => {
      const en = s.enemies.find((x) => x.id === id);
      return en ? lift(en.pos, dy) : undefined;
    };
    switch (e.t) {
      case "shot":
        sfx.shot(e.weapon);
        break;
      case "hit":
        if (!e.ally) sfx.hit(e.crit, e.shield, e.flank === "back" || e.flank === "ambush", e.blocked);
        break;
      case "allyShot":
        sfx.allyShot(e.from);
        break;
      case "shipCalled":
      case "shipLanded":
        sfx.banner();
        break;
      case "shipWave": {
        const w = EXTRACTS.find((x) => x.id === e.id)?.waves;
        if (w) sfx.spawn({ x: w.x, y: terrainHeight(w.x, w.z) + 1.5, z: w.z });
        break;
      }
      case "flareLit":
        sfx.careDrop();
        break;
      case "allyDown":
        sfx.allyDown();
        break;
      case "allyUp":
        sfx.allyUp();
        break;
      case "shieldBreak":
        sfx.shieldBreak(e.tier);
        break;
      case "kill":
        if (!e.ally) sfx.kill(e.crit);
        else sfx.wreck(lift(e.pos, 0.8));
        sfx.collapse(lift(e.pos, -0.5), e.kind === "heavy" || e.kind === "titan");
        break;
      case "stagger":
        sfx.stagger(enemyAt(e.id), e.interrupted);
        break;
      case "hurt":
        if (e.shieldBroke) sfx.myShieldBreak();
        else sfx.hurt(e.shield);
        break;
      case "dry":
        sfx.dry(p.weapons[p.slot]?.kind);
        break;
      case "reload":
        sfx.reload(e.time, p.weapons[p.slot]?.kind);
        break;
      case "reloaded":
        sfx.reloaded(p.weapons[p.slot]?.kind);
        break;
      case "slide":
        sfx.slide();
        break;
      case "jump":
        sfx.jump();
        break;
      case "mantle":
        sfx.mantle();
        break;
      case "land":
        sfx.land(e.speed);
        break;
      case "pickup":
        if (e.kind === "shard") sfx.shard();
        else sfx.pickup(e.rarity);
        break;
      case "binOpen":
        sfx.bin();
        break;
      case "locked":
        sfx.locked();
        break;
      case "tactical":
        sfx.tactical();
        break;
      case "tacticalMiss":
      case "leapBlocked":
        sfx.tacticalMiss();
        break;
      case "ultReady":
        sfx.ultReady();
        break;
      case "leap":
        sfx.leap();
        break;
      case "leapLand":
        sfx.leapLand();
        break;
      case "healStart":
        sfx.heal(e.kind);
        break;
      case "healDone":
        sfx.healDone();
        break;
      case "telegraph": {
        const en = s.enemies.find((x) => x.id === e.id);
        if (en && Math.hypot(en.pos.x - p.pos.x, en.pos.z - p.pos.z) < 45) sfx.telegraph(en.kind === "titan" || en.kind === "heavy", lift(en.pos, 1.2));
        break;
      }
      case "stompTelegraph":
        sfx.telegraph(true, enemyAt(e.id, 2));
        break;
      case "enemyFire": {
        const en = s.enemies.find((x) => x.id === e.id);
        sfx.enemyFire(e.pos, en?.kind);
        break;
      }
      case "lunge":
        sfx.lunge(enemyAt(e.id));
        break;
      case "spawn":
        sfx.spawn(lift(e.pos, 1));
        break;
      case "stomp":
        sfx.stomp(ground(e.x, e.z));
        break;
      case "suspect":
        sfx.suspect();
        break;
      case "engage":
        sfx.engage();
        break;
      case "poiStart":
      case "poiClear":
      case "landed":
        sfx.banner();
        break;
      case "reinforce":
        sfx.reinforce();
        sfx.arrive(ground(e.x, e.z, 2), false);
        break;
      case "raiders":
        sfx.raiders();
        sfx.arrive(ground(e.x, e.z, 2), true);
        break;
      case "depotOn":
        sfx.depotOn();
        break;
      case "deposit":
        sfx.deposit();
        break;
      case "leaveStart":
        sfx.click();
        break;
      case "leaveCancel":
        sfx.tacticalMiss();
        break;
      case "searchStart":
        sfx.search();
        break;
      case "careDrop":
        sfx.careDrop(ground(e.x, e.z, 40));
        break;
      case "careLand":
        sfx.careLand(ground(e.x, e.z));
        break;
      case "down":
        sfx.down();
        break;
      case "revive":
        sfx.revive();
        break;
      case "titanDown":
        sfx.victory();
        break;
      case "done":
        if (s.outcome === "extracted") sfx.victory();
        break;
    }
  }
}
