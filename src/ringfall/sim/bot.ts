import { DEG, TICK } from "./config";
import { bodyCenter, eyePos, magSize, weakPoint } from "./combat";
import { dist2d, los, lookAngles, wrapAngle } from "./geom";
import { EXTRACT, POIS } from "./map";
import { idleInput, type Enemy, type Input, type State } from "./state";

/**
 * A scripted player for the headless balance run (`npm run sim:ringfall`) and the
 * browser run (`npm run shots:ringfall`). It only produces Input, exactly like a
 * human: mouse deltas with a skill-dependent wandering aim error, reactions,
 * dodges. Everything that helps it (assist, pull, slowdown) is the game's own.
 */

export interface Skill {
  name: string;
  aimErr: number; // degrees, std of the wandering aim error
  turn: number; // fraction of the remaining angle turned per tick
  react: number; // seconds before tracking a new target
  dodge: number; // chance to sidestep a telegraphed attack / jump a stomp
  heads: boolean; // aims at the weak point instead of the body
  abilities: number; // chance per second to use tactical when it would help
}

export const SKILLS: Skill[] = [
  { name: "beginner", aimErr: 6.5, turn: 0.1, react: 0.45, dodge: 0.25, heads: false, abilities: 0.25 },
  { name: "casual", aimErr: 3.2, turn: 0.18, react: 0.28, dodge: 0.55, heads: false, abilities: 0.8 },
  { name: "good", aimErr: 1.1, turn: 0.32, react: 0.15, dodge: 0.9, heads: true, abilities: 3 },
];

const PREF: Record<string, number> = { pike: 14, hornet: 9, maul: 5, lance: 20 };

export class Bot {
  private nx = 0;
  private ny = 0;
  private seed: number;
  private target = -1;
  private tracking = 0;
  private side = 1;
  private sideT = 0;
  private stuckT = 0;
  private lastPos = { x: 0, z: 0 };
  private unstick = 0;
  private stuckCount = 0;
  private unstickSide = 1;
  private dodgeT = 0;
  private dodged = new Set<number>();
  private interactT = 0;
  private swapT = 0;
  crouch = false;

  constructor(
    private skill: Skill,
    seed = 7,
  ) {
    this.seed = seed;
  }

  private rnd() {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  private gauss() {
    return Math.sqrt(-2 * Math.log(this.rnd() + 1e-9)) * Math.cos(2 * Math.PI * this.rnd());
  }

  input(s: State): Input {
    const sk = this.skill;
    const p = s.player;
    const inp = idleInput();
    // Ornstein-Uhlenbeck aim error: wanders, stationary std = aimErr.
    const theta = 2.5;
    const sigma = sk.aimErr * DEG * Math.sqrt(2 * theta);
    this.nx += -this.nx * theta * TICK + sigma * Math.sqrt(TICK) * this.gauss();
    this.ny += -this.ny * theta * TICK + sigma * Math.sqrt(TICK) * this.gauss() * 0.6;

    const eye = eyePos(s);
    const live = s.enemies.filter((e) => e.mode !== "spawning");
    const visible = live.filter((e) => dist2d(e.pos, p.pos) < 60 && los(eye, bodyCenter(e)));
    const pool = visible.length ? visible : live;
    const tgt = pool.sort((a, b) => dist2d(a.pos, p.pos) - dist2d(b.pos, p.pos))[0] as Enemy | undefined;
    if (!tgt || tgt.id !== this.target) {
      this.target = tgt?.id ?? -1;
      this.tracking = 0;
    } else this.tracking += TICK;

    // Where to go.
    let goal: { x: number; z: number } | null = null;
    let fight = false;
    if (s.phase === "drop") {
      const poi = POIS[0];
      goal = { x: poi.x, z: poi.z + 14 };
    } else if (s.phase === "extract") {
      goal = EXTRACT;
    } else if (tgt && dist2d(tgt.pos, p.pos) < 70) {
      fight = true;
    } else {
      const lg = this.lootGoal(s);
      goal = lg ?? (s.poi < POIS.length ? POIS[s.poi] : EXTRACT);
      // Swap a better weapon in for the worse one, never for the one in hand.
      if (lg?.weapon) {
        const r = p.weapons.map((w) => (w ? w.rarity : -1));
        inp.slot = r[0] <= r[1] ? 0 : 1;
      }
    }

    // Look.
    let want: { yaw: number; pitch: number };
    if (fight && tgt) {
      const aimAt = sk.heads ? weakPoint(tgt) : bodyCenter(tgt);
      want = lookAngles(eye, aimAt);
    } else if (goal) {
      want = { yaw: lookAngles(p.pos, { x: goal.x, y: 0, z: goal.z }).yaw, pitch: s.phase === "drop" ? -0.6 : 0 };
    } else want = { yaw: p.yaw, pitch: 0 };
    const reacting = fight && this.tracking < sk.react;
    const turn = reacting ? sk.turn * 0.3 : sk.turn;
    inp.lookX = wrapAngle(want.yaw + this.nx - p.yaw) * turn;
    inp.lookY = (want.pitch + this.ny - p.pitch) * turn;

    // Move.
    if (s.phase === "drop") {
      const d = goal ? dist2d(goal, p.pos) : 0;
      inp.moveZ = d > 4 ? 1 : 0;
      return inp;
    }
    const w = p.weapons[p.slot];
    if (fight && tgt) {
      const d = dist2d(tgt.pos, p.pos);
      const pref = w ? PREF[w.kind] : 12;
      this.sideT -= TICK;
      if (this.sideT <= 0) {
        this.side = this.rnd() < 0.5 ? -1 : 1;
        this.sideT = 0.8 + this.rnd() * 1.2;
      }
      // Dodge a wind-up that is about to release.
      for (const e of live) {
        if (this.dodged.has(e.id * 1000 + Math.floor(s.time / 2))) continue;
        const windup = (e.mode === "telegraph" && e.timer < 0.3) || (e.mode === "stomp" && e.timer < 0.2);
        if (windup && dist2d(e.pos, p.pos) < 40) {
          this.dodged.add(e.id * 1000 + Math.floor(s.time / 2));
          if (this.rnd() < sk.dodge) {
            this.dodgeT = 0.45;
            this.side = this.rnd() < 0.5 ? -1 : 1;
          }
        }
      }
      const sees = los(eye, bodyCenter(tgt));
      inp.moveZ = !sees ? 1 : d > pref + 3 ? 1 : d < pref - 3 ? -0.8 : 0;
      inp.moveX = this.dodgeT > 0 ? this.side : this.side * (sk.dodge > 0.5 ? 0.9 : 0.5);
      this.dodgeT -= TICK;

      const aimDir = Math.hypot(wrapAngle(want.yaw - p.yaw), want.pitch - p.pitch);
      const tol = (sk.name === "beginner" ? 12 : 8) * DEG + Math.atan(1 / Math.max(d, 1));
      inp.fire = sees && aimDir < tol && d < 60 && p.battery <= 0;
      inp.ads = sees && d > 12 && w?.kind !== "maul" && w?.kind !== "hornet";

      // Shockwave: jump when the ring is about to arrive.
      for (const wv of s.waves) {
        const dd = Math.hypot(p.pos.x - wv.x, p.pos.z - wv.z) - wv.r;
        if (dd > 0.3 && dd < 1.6 && this.rnd() < sk.dodge * 0.25) inp.jump = true;
      }
      if (live.length >= 2 || tgt.mode === "telegraph") {
        if (p.tactical <= 0 && this.rnd() < sk.abilities * TICK) inp.tactical = true;
      }
      if (p.ult >= 1 && (live.length >= 3 || tgt.kind === "titan")) inp.ult = true;
      // Pick the weapon that suits the distance (when it has two).
      const other = p.weapons[1 - p.slot];
      this.swapT -= TICK;
      if (other && w && sk.name !== "beginner" && this.swapT <= 0 && p.reload <= 0) {
        if (Math.abs(PREF[other.kind] - d) + 6 < Math.abs(PREF[w.kind] - d)) {
          inp.swap = true;
          this.swapT = 3;
        }
      }
      const threat = live.some((e) => dist2d(e.pos, p.pos) < 14 || e.mode === "telegraph");
      if (p.shield < 25 && p.batteries > 0 && !threat && p.battery <= 0) inp.battery = true;
      if (p.battery > 0) inp.fire = false;
    } else if (goal) {
      const d = dist2d(goal, p.pos);
      inp.moveZ = d > 1.2 ? 1 : 0;
      if (Math.abs(wrapAngle(want.yaw - p.yaw)) > 0.5) inp.moveZ = 0.4;
      if (w && w.mag < magSize(w) * 0.6 && p.reload <= 0) inp.reload = true;
      const max = [50, 75, 100, 125][p.armor];
      if (p.shield < max * 0.6 && p.batteries > 0 && p.battery <= 0) inp.battery = true;
      if (p.battery > 0) inp.moveZ = Math.min(inp.moveZ, 0.6);
      // Slide now and then on long runs, like people do.
      if (p.sprinting && d > 12 && this.rnd() < TICK * 0.4) this.crouch = true;
      this.interactT -= TICK;
      if (d < 1.8 && this.interactT <= 0) {
        inp.interact = true;
        this.interactT = 0.5;
      }
    }
    // Never back out of the ring: near its edge, walk toward its centre.
    const ring = s.ring;
    const out = dist2d(p.pos, ring) - (ring.r - 4);
    if (out > 0 && this.unstick <= 0) {
      const toward = lookAngles(p.pos, { x: ring.x, y: 0, z: ring.z }).yaw - p.yaw;
      inp.moveZ = Math.cos(toward);
      inp.moveX = Math.sin(toward);
    }
    if (this.crouch) {
      inp.crouch = true;
      if (!p.sliding && Math.hypot(p.vel.x, p.vel.z) < 5) this.crouch = false;
    }

    // Unstick: little progress for a second -> jump and step sideways.
    this.stuckT += TICK;
    if (this.stuckT > 1) {
      const moved = Math.hypot(p.pos.x - this.lastPos.x, p.pos.z - this.lastPos.z);
      if (moved < 0.8 && (inp.moveZ !== 0 || inp.moveX !== 0) && p.battery <= 0) {
        // Each repeated stall tries the other side, for longer.
        this.stuckCount++;
        this.unstickSide = this.stuckCount % 2 ? 1 : -1;
        this.unstick = Math.min(3, 0.8 + this.stuckCount * 0.5);
      } else if (moved > 3) this.stuckCount = 0;
      this.lastPos = { x: p.pos.x, z: p.pos.z };
      this.stuckT = 0;
    }
    if (this.unstick > 0) {
      this.unstick -= TICK;
      inp.jump = this.unstick % 1 > 0.9;
      inp.moveX = this.unstickSide;
      inp.moveZ = 0.25;
    }
    return inp;
  }

  /** Unopened bins and better weapons nearby, when nothing is shooting. */
  private lootGoal(s: State): { x: number; z: number; weapon?: true } | null {
    const p = s.player;
    const worst = Math.min(...p.weapons.map((w) => (w ? w.rarity : -1)));
    const cands: { x: number; z: number; d: number; weapon?: true }[] = [];
    for (const b of s.bins) if (!b.open && dist2d(b, p.pos) < 26) cands.push({ x: b.x, z: b.z, d: dist2d(b, p.pos) });
    if (s.care && s.care.landed && !s.care.open) cands.push({ x: s.care.x, z: s.care.z, d: dist2d(s.care, p.pos) });
    for (const l of s.loot) {
      if (l.age < 0.6 || dist2d(l.pos, p.pos) > 22) continue;
      if (l.kind === "weapon" && l.weapon && l.rarity > worst) cands.push({ x: l.pos.x, z: l.pos.z, d: dist2d(l.pos, p.pos), weapon: true });
      if (l.kind === "armor" && l.rarity > p.armor) cands.push({ x: l.pos.x, z: l.pos.z, d: dist2d(l.pos, p.pos) });
      if (l.kind === "battery" && p.batteries < 4) cands.push({ x: l.pos.x, z: l.pos.z, d: dist2d(l.pos, p.pos) });
    }
    const inRing = (c: { x: number; z: number }) => dist2d(c, s.ring) < s.ring.r - 5 && dist2d(c, s.ring) < s.ring.toR + dist2d(s.ring, { x: s.ring.toX, z: s.ring.toZ }) - 5;
    return cands.filter(inRing).sort((a, b) => a.d - b.d)[0] ?? null;
  }
}
