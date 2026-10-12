import { AWARE, DEG, HEALS, PLAYER, TICK, WORLD } from "./config";
import { bodyCenter, eyePos, flankOf, magSize, weakPoint } from "./combat";
import { dist2d, groundAt, los, onTerrain, lookAngles, solidAt, wrapAngle } from "./geom";
import { EXTRACTS, POIS } from "./map";
import { clearLine, findPath } from "./nav";
import { enemyMax, idleInput, type Enemy, type Input, type State } from "./state";
import { pickHeal } from "./player";
import { makeRoom } from "./world";
import { terrainHeight } from "./terrain";

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
  flank: number; // chance to leave a robot that faces it and come back from its side or back
  raid: number; // POIs it clears before heading for a way out
}

export const SKILLS: Skill[] = [
  { name: "beginner", aimErr: 6.5, turn: 0.1, react: 0.45, dodge: 0.25, heads: false, abilities: 0.25, flank: 0.2, raid: 2 },
  { name: "casual", aimErr: 3.2, turn: 0.18, react: 0.28, dodge: 0.55, heads: false, abilities: 0.8, flank: 0.5, raid: 4 },
  { name: "good", aimErr: 1.1, turn: 0.32, react: 0.15, dodge: 0.9, heads: true, abilities: 3, flank: 0.85, raid: 4 },
];

const PREF: Record<string, number> = { pike: 14, hornet: 9, maul: 5, lance: 20, talon: 30 };

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
  private trail: { x: number; z: number }[] = [];
  private upT = 0;
  private stuckCount = 0;
  private unstickSide = 1;
  private dodgeT = 0;
  private dodged = new Set<number>();
  private interactT = 0;
  private swapT = 0;
  private lootKey = "";
  private lootT = 0;
  private skip = new Set<string>();
  private path: { x: number; z: number }[] = [];
  private pathGoal = { x: 1e9, z: 1e9 };
  private pathT = 0;
  private flank: { x: number; z: number; id: number; step: "hide" | "go" } | null = null;
  private flankT = 0;
  private flankCheck = 0;
  private lastFlanked = -1;
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
    this.from = { x: p.pos.x, z: p.pos.z };
    const live = s.enemies.filter((e) => e.mode !== "spawning");
    // Only fight robots that are after us or stand at the POI we are taking; leave the rest alone.
    const aim = this.nextPoi(s);
    const relevant = live.filter((e) => e.aware === "engaged" || (aim >= 0 && e.poi === aim));
    const sees = (e: Enemy) => dist2d(e.pos, p.pos) < 60 && los(eye, bodyCenter(e));
    // Finish the squads already fighting before opening on a new one, as a careful player would.
    const engaged = relevant.filter((e) => e.aware === "engaged");
    const objective = relevant.filter((e) => aim >= 0 && e.poi === aim);
    const engagedSeen = engaged.filter(sees);
    const pool = engagedSeen.length ? engagedSeen : engaged.length ? engaged : objective.filter(sees).length ? objective.filter(sees) : objective;
    // A flank in progress keeps its robot; otherwise the nearest one.
    const flanked = this.flank && live.find((e) => e.id === this.flank?.id);
    const tgt = flanked || (pool.sort((a, b) => dist2d(a.pos, p.pos) - dist2d(b.pos, p.pos))[0] as Enemy | undefined);
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
    } else if (aim < 0 && (s.shipCall === 0 || !tgt || dist2d(tgt.pos, p.pos) > 70)) {
      goal = this.exit(s);
    } else if (tgt && dist2d(tgt.pos, p.pos) < 70) {
      fight = true;
    } else if (s.ally.down > 0 && dist2d(s.ally.pos, p.pos) < 45) {
      // Pick the teammate up before looting or moving on.
      goal = { x: s.ally.pos.x, z: s.ally.pos.z };
    } else {
      const lg = this.lootGoal(s);
      goal = lg ?? (aim >= 0 ? POIS[aim] : this.exit(s));
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
      const step = s.phase === "drop" ? goal : this.via(s, goal);
      want = { yaw: lookAngles(p.pos, { x: step.x, y: 0, z: step.z }).yaw, pitch: s.phase === "drop" ? -0.6 : 0 };
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
      // Flank: a robot that faces us is not worth trading shots with. First break its
      // squad's line of sight, wait until they lose track, then come round to a spot
      // at its side or back and shoot from there.
      this.flankT -= TICK;
      this.flankCheck -= TICK;
      if (this.flank && (this.flank.id !== tgt.id || this.flankT <= 0 || tgt.aware !== "engaged")) this.flank = null;
      if (this.flank?.step === "go" && dist2d(this.flank, p.pos) < 1.2) this.flank = null;
      if (this.flank?.step === "hide" && dist2d(this.flank, p.pos) < 1.2 && s.squads[tgt.squad].sinceSeen >= AWARE.trackTime) {
        const spot = this.flankSpot(s, tgt);
        this.flank = spot ? { ...spot, id: tgt.id, step: "go" } : null;
        this.flankT = 7;
      }
      if (!this.flank && this.flankCheck <= 0 && tgt.kind !== "titan" && tgt.aware === "engaged" && onTerrain(p.pos) && onTerrain(tgt.pos)) {
        this.flankCheck = 1.5;
        // Worth it only on a robot with plenty of fight left, and not twice in a row.
        const healthy = tgt.hp + tgt.shield > enemyMax(tgt) * 0.5;
        if (healthy && tgt.id !== this.lastFlanked && flankOf(s, tgt) === "front" && this.rnd() < sk.flank) {
          const hide = this.hideSpot(s, tgt);
          if (hide) {
            this.lastFlanked = tgt.id;
            this.flank = { ...hide, id: tgt.id, step: "hide" };
            this.flankT = 6;
          }
        }
      }
      if (this.flank) {
        const step = this.via(s, this.flank);
        const rel = lookAngles(p.pos, { x: step.x, y: 0, z: step.z }).yaw - p.yaw;
        inp.moveZ = Math.cos(rel);
        inp.moveX = Math.sin(rel);
      } else if (!sees && onTerrain(p.pos)) {
        // Walk a ground path toward it. A robot up high is hidden by its own roof edge or
        // tower walls from close below, so walk to the nearest ground spot that sees it instead.
        let to = { x: tgt.pos.x, z: tgt.pos.z };
        if (tgt.pos.y > p.pos.y + 1.5) {
          if (!this.angle || this.angle.id !== tgt.id || s.time > this.angle.until) {
            const spot = this.angleSpot(tgt);
            this.angle = { id: tgt.id, until: s.time + 4, x: spot?.x ?? to.x, z: spot?.z ?? to.z };
          }
          to = { x: this.angle.x, z: this.angle.z };
        }
        const step = this.via(s, to);
        const rel = lookAngles(p.pos, { x: step.x, y: 0, z: step.z }).yaw - p.yaw;
        inp.moveZ = Math.cos(rel);
        inp.moveX = Math.sin(rel);
      } else {
        inp.moveZ = !sees ? 1 : d > pref + 3 ? 1 : d < pref - 3 ? -0.8 : 0;
        inp.moveX = this.dodgeT > 0 ? this.side : this.side * (sk.dodge > 0.5 ? 0.9 : 0.5);
      }
      this.dodgeT -= TICK;

      const aimDir = Math.hypot(wrapAngle(want.yaw - p.yaw), want.pitch - p.pitch);
      const tol = (sk.name === "beginner" ? 12 : 8) * DEG + Math.atan(1 / Math.max(d, 1));
      inp.fire = sees && aimDir < tol && d < 60 && !p.healing && !(this.flank && flankOf(s, tgt) === "front");
      inp.ads = sees && d > 12 && w?.kind !== "maul" && w?.kind !== "hornet";

      // Shockwave: jump when the ring is about to arrive.
      for (const wv of s.waves) {
        const dd = Math.hypot(p.pos.x - wv.x, p.pos.z - wv.z) - wv.r;
        if (dd > 0.3 && dd < 1.6 && this.rnd() < sk.dodge * 0.25) inp.jump = true;
      }
      if (engaged.length >= 2 || tgt.mode === "telegraph") {
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
      if ((p.shield < 25 || p.hp < 45) && !threat && !p.healing && pickHeal(s)) inp.heal = true;
      if (p.healing) inp.fire = false;
    } else if (goal) {
      const d = dist2d(goal, p.pos);
      inp.moveZ = d > 1.2 ? 1 : 0;
      if (Math.abs(wrapAngle(want.yaw - p.yaw)) > 0.5) inp.moveZ = 0.4;
      if (w && w.mag < magSize(w) * 0.6 && p.reload <= 0) inp.reload = true;
      const max = PLAYER.shieldByTier[p.armor];
      if ((p.shield < max * 0.6 || p.hp < 75) && !p.healing && pickHeal(s)) inp.heal = true;
      if (p.healing) inp.moveZ = Math.min(inp.moveZ, 0.6);
      // Slide now and then on long runs, like people do.
      if (p.sprinting && d > 12 && this.rnd() < TICK * 0.4) this.crouch = true;
      this.interactT -= TICK;
      if (d < 1.8 && this.interactT <= 0) {
        inp.interact = true;
        this.interactT = 0.5;
      }
    }
    if (this.crouch) {
      inp.crouch = true;
      if (!p.sliding && Math.hypot(p.vel.x, p.vel.z) < 5) this.crouch = false;
    }

    // Unstick: little progress for a second -> jump and step sideways.
    this.stuckT += TICK;
    if (this.stuckT > 1) {
      const moved = Math.hypot(p.pos.x - this.lastPos.x, p.pos.z - this.lastPos.z);
      if (moved < 0.8 && (inp.moveZ !== 0 || inp.moveX !== 0) && !p.healing) {
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
    // The bot finds its way on the ground only, so it never climbs a ledge: in the air
    // it keeps its take-off speed but does not push forward, which a climb needs.
    if (!p.onGround) inp.moveZ = Math.min(inp.moveZ, 0.4);
    // Up on a floor it reached by stairs, it cannot plan a way down. It keeps the
    // trail it walked since leaving the terrain, and after a while up there walks
    // that trail back.
    if (p.pos.y - terrainHeight(p.pos.x, p.pos.z) > 0.5) inp.jump = false;
    if (onTerrain(p.pos)) {
      this.trail = [];
      this.upT = 0;
    } else {
      const last = this.trail[this.trail.length - 1];
      if (this.upT <= 2 && (!last || dist2d(last, p.pos) > 0.4)) this.trail.push({ x: p.pos.x, z: p.pos.z });
      if (p.onGround && p.pos.y - terrainHeight(p.pos.x, p.pos.z) > 0.8) this.upT += TICK;
      if (this.upT > 2) {
        while (this.trail.length > 1 && dist2d(this.trail[this.trail.length - 1], p.pos) < 0.35) this.trail.pop();
        const to = this.trail[this.trail.length - 1] ?? p.pos;
        const dx = to.x - p.pos.x;
        const dz = to.z - p.pos.z;
        const l = Math.hypot(dx, dz) || 1;
        inp.moveZ = (dx * Math.sin(p.yaw) - dz * Math.cos(p.yaw)) / l;
        inp.moveX = (dx * Math.cos(p.yaw) + dz * Math.sin(p.yaw)) / l;
        inp.fire = false;
        inp.crouch = false;
      }
    }
    return inp;
  }

  /**
   * The POI to take next: the nearest one not yet cleared, until the bot has cleared
   * as many as its skill dares (`Skill.raid`). The titan's landing pad comes only last,
   * and only for a bot that takes on every POI. -1 means it is time to leave.
   */
  private nextPoi(s: State): number {
    if (s.stats.cleared.length >= this.skill.raid) return -1;
    const p = s.player;
    const open = POIS.map((poi, i) => ({ poi, i })).filter(({ poi, i }) => !s.cleared[i] && (!poi.boss || s.stats.cleared.length >= POIS.length - 1));
    open.sort((a, b) => dist2d(a.poi, p.pos) - dist2d(b.poi, p.pos));
    return open[0]?.i ?? -1;
  }

  /**
   * The way off the island: a flare's quick pickup when it has one, else beginners
   * take the long quiet walk and the others call the dropship and hold.
   */
  private exit(s: State): { x: number; z: number } {
    // The dropship lands by the titan: only a bot that has beaten it goes there.
    const titanUp = s.enemies.some((e) => e.kind === "titan");
    const id = s.player.flares > 0 ? "flare" : this.skill.name === "beginner" || titanUp ? "village" : "ship";
    return EXTRACTS.find((x) => x.id === id)!;
  }

  /**
   * A standable spot 9-13 m from the robot, behind it or to its side, that sees
   * its body and is reachable on foot by a route mostly out of its squad's sight.
   * The shortest and least exposed route wins.
   */
  private flankSpot(s: State, tgt: Enemy): { x: number; z: number } | null {
    const watchers = s.enemies.filter((e) => e.squad === tgt.squad);
    let best: { x: number; z: number; cost: number } | null = null;
    for (let off = 1.6; off <= 2 * Math.PI - 1.6 + 1e-6; off += 0.3)
      for (const r of [7, 10, 14]) {
        const a = tgt.yaw + off;
        const x = tgt.pos.x + Math.sin(a) * r;
        const z = tgt.pos.z - Math.cos(a) * r;
        if (Math.max(Math.abs(x), Math.abs(z)) > WORLD.half - 3) continue;
        const g = terrainHeight(x, z);
        if (groundAt(x, z, 0.4, g + 0.3) > g + 0.3 || [0.3, 1.0, 1.6].some((h) => solidAt(x, g + h, z))) continue;
        if (!los({ x, y: g + 1.6, z }, bodyCenter(tgt))) continue;
        const route = this.route(x, z);
        if (!route || route.len > 45) continue;
        // Walking the route in the squad's sight would only turn it round: prefer hidden routes.
        const exposed = route.samples.filter((q) => watchers.some((w) => los({ x: q.x, y: terrainHeight(q.x, q.z) + 1.4, z: q.z }, bodyCenter(w)))).length / Math.max(1, route.samples.length);
        const cost = route.len * (1 + exposed * 3);
        if (exposed < 0.6 && (!best || cost < best.cost)) best = { x, z, cost };
      }
    return best ? { x: best.x, z: best.z } : null;
  }

  private angle: { id: number; until: number; x: number; z: number } | null = null;

  /** The nearest ground spot (by route) within 40 m of a robot up high that sees its body. */
  private angleSpot(tgt: Enemy): { x: number; z: number } | null {
    let best: { x: number; z: number; len: number } | null = null;
    for (let r = 10; r <= 40; r += 5)
      for (let a = 0; a < 2 * Math.PI; a += Math.PI / 12) {
        const x = tgt.pos.x + Math.sin(a) * r;
        const z = tgt.pos.z - Math.cos(a) * r;
        if (Math.max(Math.abs(x), Math.abs(z)) > WORLD.half - 3) continue;
        const g = terrainHeight(x, z);
        if (groundAt(x, z, 0.4, g + 0.3) > g + 0.3 || [0.3, 1.0, 1.6].some((h) => solidAt(x, g + h, z))) continue;
        if (!los({ x, y: g + 1.6, z }, bodyCenter(tgt))) continue;
        const route = this.route(x, z);
        if (route && route.len < 70 && (!best || route.len < best.len)) best = { x, z, len: route.len };
      }
    return best && { x: best.x, z: best.z };
  }

  /** The nearest standable spot within 10 m that no member of the robot's squad can see. */
  private hideSpot(s: State, tgt: Enemy): { x: number; z: number } | null {
    const watchers = s.enemies.filter((e) => e.squad === tgt.squad);
    let best: { x: number; z: number; len: number } | null = null;
    for (const r of [3, 5, 7, 10])
      for (let a = 0; a < 2 * Math.PI; a += Math.PI / 6) {
        const x = this.from.x + Math.sin(a) * r;
        const z = this.from.z - Math.cos(a) * r;
        if (Math.max(Math.abs(x), Math.abs(z)) > WORLD.half - 3) continue;
        const g = terrainHeight(x, z);
        if (groundAt(x, z, 0.4, g + 0.3) > g + 0.3 || [0.3, 1.0, 1.6].some((h) => solidAt(x, g + h, z))) continue;
        if (watchers.some((w) => los(bodyCenter(w), { x, y: g + 1.5, z }))) continue;
        const route = this.route(x, z);
        if (!route || route.len > 16) continue;
        if (!best || route.len < best.len) best = { x, z, len: route.len };
      }
    return best && { x: best.x, z: best.z };
  }

  private from = { x: 0, z: 0 };

  /** Path on foot from where the bot stands to (x, z): its length and points every 2 m along it. */
  private route(x: number, z: number): { len: number; samples: { x: number; z: number }[] } | null {
    const pts = findPath(this.from.x, this.from.z, x, z);
    if (!pts) return null;
    let len = 0;
    let prev = this.from;
    const samples: { x: number; z: number }[] = [];
    for (const q of pts) {
      const seg = Math.hypot(q.x - prev.x, q.z - prev.z);
      for (let d = 2; d < seg; d += 2) samples.push({ x: prev.x + ((q.x - prev.x) * d) / seg, z: prev.z + ((q.z - prev.z) * d) / seg });
      len += seg;
      prev = q;
    }
    return { len, samples };
  }

  /**
   * The point to walk toward on the way to `goal`: the goal itself when the way is
   * clear, otherwise the next waypoint of a ground path around walls.
   */
  private via(s: State, goal: { x: number; z: number }): { x: number; z: number } {
    const p = s.player;
    // Up on a roof or platform the ground grid does not apply: walk straight (and drop off).
    if ((p.onGround && !onTerrain(p.pos)) || clearLine(p.pos.x, p.pos.z, goal.x, goal.z)) {
      this.path = [];
      return goal;
    }
    this.pathT -= TICK;
    // Re-plan when the goal moved or every 2 s; an unreachable goal is not retried every tick.
    if (dist2d(goal, this.pathGoal) > 3 || this.pathT <= 0) {
      this.path = findPath(p.pos.x, p.pos.z, goal.x, goal.z) ?? [];
      this.pathGoal = { ...goal };
      this.pathT = 2;
    }
    while (this.path.length > 1 && dist2d(this.path[0], p.pos) < 0.8) this.path.shift();
    return this.path[0] ?? goal;
  }

  /** Unopened bins and better weapons nearby, when nothing is shooting. */
  private lootGoal(s: State): { x: number; z: number; weapon?: true } | null {
    const p = s.player;
    const worst = Math.min(...p.weapons.map((w) => (w ? w.rarity : -1)));
    // Skip anything above our floor (roofs, platforms) and anything we failed to reach for 10 s.
    // Only things on the terrain: the bot plans on the ground and does not climb to floors or roofs.
    const reachable = (c: { x: number; z: number; y?: number }) => (c.y ?? 0) < terrainHeight(c.x, c.z) + 0.6 && !this.skip.has(`${Math.round(c.x)},${Math.round(c.z)}`);

    const cands: { x: number; z: number; d: number; weapon?: true }[] = [];
    for (const b of s.bins) if (!b.open && dist2d(b, p.pos) < 26 && reachable(b)) cands.push({ x: b.x, z: b.z, d: dist2d(b, p.pos) });
    if (s.care && s.care.landed && !s.care.open) cands.push({ x: s.care.x, z: s.care.z, d: dist2d(s.care, p.pos) });
    for (const l of s.loot) {
      if (l.age < 0.6 || dist2d(l.pos, p.pos) > 22 || !reachable(l.pos)) continue;
      if (l.kind === "weapon" && l.weapon && l.rarity > worst) cands.push({ x: l.pos.x, z: l.pos.z, d: dist2d(l.pos, p.pos), weapon: true });
      if (l.kind === "armor" && l.rarity > p.armor) cands.push({ x: l.pos.x, z: l.pos.z, d: dist2d(l.pos, p.pos) });
      if (l.kind === "heal" && l.heal && p.heals[l.heal] < HEALS[l.heal].max) cands.push({ x: l.pos.x, z: l.pos.z, d: dist2d(l.pos, p.pos) });
      // A valuable the bag can take, or one worth throwing cheaper things out for.
      if (l.kind === "valuable" && l.valuable && makeRoom(p.haul, l.valuable)) cands.push({ x: l.pos.x, z: l.pos.z, d: dist2d(l.pos, p.pos) });
    }
    const best = cands.sort((a, b) => a.d - b.d)[0] ?? null;
    const k = best ? `${Math.round(best.x)},${Math.round(best.z)}` : "";
    if (k !== this.lootKey) {
      this.lootKey = k;
      this.lootT = 0;
    } else if (best && (this.lootT += TICK) > 10) this.skip.add(k);
    return best;
  }
}
