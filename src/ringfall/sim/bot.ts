import { AWARE, DEG, ENEMIES, HEALS, PLAYER, TICK, ULT } from "./config";
import { bodyCenter, eyePos, flankOf, magSize, weakPoint } from "./combat";
import { ceilingAt, dist2d, inWorld, groundAt, groundLevel, los, onTerrain, lookAngles, solidAt, wrapAngle } from "./geom";
import { EXTRACTS, POIS, regionOf, type ExtractPoint } from "./map";
import { clearLine, findPath } from "./nav";
import { callLeft, enemyMax, idleInput, type Enemy, type Input, type State } from "./state";
import { pickHeal } from "./player";
import { makeRoom } from "./world";
import { offLowGround, offshore, terrainHeight } from "./terrain";

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
  dodge: number; // chance to duck behind cover from a telegraphed attack / jump a stomp
  heads: boolean; // aims at the weak point instead of the body
  abilities: number; // chance per second to use tactical when it would help
  flank: number; // chance to leave a robot that faces it and come back from its side or back
  retreat: number; // chance to break line of sight and back off when two robots see it or its shield is gone
  raid: number; // POIs it clears before heading for a way out
}

export const SKILLS: Skill[] = [
  { name: "beginner", aimErr: 6.5, turn: 0.1, react: 0.45, dodge: 0.4, heads: false, abilities: 0.25, flank: 0.2, retreat: 0.5, raid: 2 },
  { name: "casual", aimErr: 3.2, turn: 0.18, react: 0.28, dodge: 0.6, heads: false, abilities: 0.8, flank: 0.5, retreat: 0.8, raid: 4 },
  { name: "good", aimErr: 1.1, turn: 0.32, react: 0.15, dodge: 0.9, heads: true, abilities: 3, flank: 0.85, retreat: 0.95, raid: 4 },
];

/** Where a robot's shots leave from, near its head. */
const muzzleOf = (e: Enemy) => ({ x: e.pos.x, y: e.pos.y + Math.max(ENEMIES[e.kind].weakY - 0.1, 0.2), z: e.pos.z });

/** Distance it likes to fight at with each weapon: off at the edge of a robot's reach, where its fire strays. */
const PREF: Record<string, number> = { pike: 22, hornet: 11, maul: 6, lance: 26, talon: 32 };

/** Seconds a fighting robot may stay out of sight before the bot stops waiting for it. */
const GIVE_UP = 25;

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
  private trailStuckT = 0;
  private trailFrom = { x: 0, z: 0 };
  private lastGround: { x: number; z: number } | null = null;
  private stuckCount = 0;
  private unstickSide = 1;
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
  private flankedAt = -99;
  /** The raiders have been announced: time to stop taking POIs and get out. */
  private raidersIn = false;
  /** Where it backs off to out of every fighting robot's sight, to let them lose it and to heal. */
  private retreat: { x: number; z: number; until: number } | null = null;
  private retreatCool = 0;
  /** A spot a step or two away behind cover from a robot winding up, and how long to keep down there. */
  private duck: { x: number; z: number } | null = null;
  private duckT = 0;
  /** Where it fights a robot from: low cover it can shoot over standing and hide behind crouched. */
  private post: { x: number; z: number; id: number; until: number } | null = null;
  /** Where it glides to on the leap: away from the robots fighting it. */
  private escape: { x: number; z: number } | null = null;
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

  /** Seconds each fighting robot has been out of the bot's sight. */
  private unseen = new Map<number, number>();

  input(s: State): Input {
    const sk = this.skill;
    const p = s.player;
    const inp = idleInput();
    inp.keepArmor = true;
    inp.leaveTools = true;
    // Ornstein-Uhlenbeck aim error: wanders, stationary std = aimErr.
    const theta = 2.5;
    const sigma = sk.aimErr * DEG * Math.sqrt(2 * theta);
    this.nx += -this.nx * theta * TICK + sigma * Math.sqrt(TICK) * this.gauss();
    this.ny += -this.ny * theta * TICK + sigma * Math.sqrt(TICK) * this.gauss() * 0.6;

    const eye = eyePos(s);
    this.from = { x: p.pos.x, z: p.pos.z };
    if (s.events.some((e) => e.t === "raiders")) this.raidersIn = true;
    const live = s.enemies.filter((e) => e.mode !== "spawning");
    // Only fight robots that are after us or stand at the POI we are taking; leave the rest alone.
    const aim = this.nextPoi(s);
    const sees = (e: Enemy) => dist2d(e.pos, p.pos) < 60 && los(eye, bodyCenter(e));
    // Robots coming to look ("?") in plain sight are worth the first shot before they find it.
    const coming = (e: Enemy) => e.aware === "alert" && dist2d(e.pos, p.pos) < 45 && sees(e);
    // A fighting robot out of sight for long is one that will not come (the titan on its pad
    // above the lakebed): stop waiting for it, as a player would, until it shows itself again.
    for (const e of live)
      if (e.aware !== "engaged" || sees(e)) this.unseen.delete(e.id);
      else this.unseen.set(e.id, (this.unseen.get(e.id) ?? 0) + TICK);
    const given = (e: Enemy) => (this.unseen.get(e.id) ?? 0) > GIVE_UP;
    const relevant = live.filter((e) => !given(e) && (e.aware === "engaged" || (aim >= 0 && e.poi === aim) || coming(e)));
    // Finish the squads already fighting before opening on a new one, as a careful player would.
    const engaged = relevant.filter((e) => e.aware === "engaged");
    const objective = relevant.filter((e) => (aim >= 0 && e.poi === aim) || coming(e));
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
      goal = regionOf(s.region).land;
    } else if (aim < 0 && (callLeft(s, this.exit(s).id) === 0 || !tgt || dist2d(tgt.pos, p.pos) > 70 || this.slipAway(s, live))) {
      goal = this.waitSpot(s) ?? this.exit(s);
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
        inp.slot = this.spareSlot(s);
      }
    }

    // In the air on the leap: glide on toward the spot it chose at take-off.
    if (p.leap) {
      const to = this.escape ?? p.pos;
      inp.lookX = wrapAngle(lookAngles(p.pos, { x: to.x, y: 0, z: to.z }).yaw - p.yaw) * sk.turn;
      inp.lookY = -p.pitch * sk.turn;
      // Ease off near it: the glide keeps its speed without input, and would carry on past.
      inp.moveZ = Math.max(0.15, Math.min(1, dist2d(to, p.pos) / ULT.glide));
      return inp;
    }

    // Look.
    let want: { yaw: number; pitch: number };
    if (fight && tgt) {
      // A plate the gun cannot pierce turns body shots to scratches: go for the weak point.
      const w = p.weapons[p.slot];
      const plated = !!w && tgt.plate > w.rarity;
      const aimAt = sk.heads || plated ? weakPoint(tgt) : bodyCenter(tgt);
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
      // The robots fighting it that it can see, and so can see it.
      const watching = live.filter((e) => e.aware === "engaged" && e.kind !== "titan" && dist2d(e.pos, p.pos) < 50 && los(eye, bodyCenter(e)));
      // A wind-up in sight: get down behind something before it fires (a sidestep in the open does not help).
      for (const e of watching) {
        const key = e.id * 1000 + Math.floor(s.time / 2);
        if (e.mode !== "telegraph" || this.dodged.has(key) || this.retreat) continue;
        this.dodged.add(key);
        if (this.rnd() >= sk.dodge) continue;
        const winding = watching.filter((o) => o.mode === "telegraph" || o.mode === "fire");
        if (winding.every((o) => !los(muzzleOf(o), { x: p.pos.x, y: p.pos.y + 0.75, z: p.pos.z }))) this.duck = { x: p.pos.x, z: p.pos.z };
        else this.duck = this.coverSpot(winding, [1.5, 2.5, 3.5], 5, true);
        if (this.duck) this.duckT = 1.3;
      }
      // Two robots on it, or its shield gone: break their line of sight and back off, let them
      // lose it, heal there, and come again from somewhere else.
      this.retreatCool -= TICK;
      const broken = p.shield <= 0 && p.hp < PLAYER.hp * 0.8;
      const fighting = live.filter((e) => e.aware === "engaged" && e.kind !== "titan" && dist2d(e.pos, p.pos) < 60);
      // While its call is running the robots come to the pickup whatever it does: it holds and fights.
      const calling = aim < 0 && !!this.exit(s).call && callLeft(s, this.exit(s).id) > 0;
      const pressed = !calling && (watching.length >= 2 || (broken && watching.length >= 1));
      if (!this.retreat && pressed && tgt.kind !== "titan" && onTerrain(p.pos) && this.retreatCool <= 0) {
        this.retreatCool = 1.5;
        if (this.rnd() < sk.retreat) {
          const spot = this.coverSpot(fighting, [3, 5, 8, 12, 16], 22, false);
          if (spot) {
            this.retreat = { ...spot, until: s.time + 14 };
            this.flank = null;
            this.duckT = 0;
          }
        }
      }
      if (this.retreat && dist2d(this.retreat, p.pos) > 26) this.retreat = null;
      const hiding = !!this.retreat && dist2d(this.retreat, p.pos) < 1.5;
      if (this.retreat && hiding && watching.length && this.retreatCool <= 0) {
        // Found in hiding (one came round): somewhere else, at once.
        this.retreatCool = 1;
        const spot = this.coverSpot(fighting, [3, 5, 8, 12, 16], 22, false);
        this.retreat = spot ? { ...spot, until: this.retreat.until } : null;
      }
      const tracked = fighting.some((e) => (s.squads[e.squad]?.sinceSeen ?? 99) < AWARE.trackTime);
      const max = PLAYER.shieldByTier[p.armor];
      const needHeal = (p.shield < max * 0.7 || p.hp < 70) && !!pickHeal(s);
      if (this.retreat && (s.time > this.retreat.until || (hiding && !tracked && !needHeal && !p.healing))) {
        this.retreat = null;
        // They lost it: come again from their side or back rather than where they look.
        const spot = tgt.aware === "engaged" && onTerrain(tgt.pos) && this.rnd() < sk.flank ? this.flankSpot(s, tgt) : null;
        if (spot) {
          this.flank = { ...spot, id: tgt.id, step: "go" };
          this.flankT = 7;
          this.lastFlanked = tgt.id;
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
      if (!this.flank && !this.retreat && this.flankCheck <= 0 && tgt.kind !== "titan" && tgt.aware === "engaged" && onTerrain(p.pos) && onTerrain(tgt.pos)) {
        this.flankCheck = 1.5;
        // Worth it only on a robot with plenty of fight left, and not twice in a row.
        // Worth it on a robot with fight left; the same robot again only after a while.
        const healthy = tgt.hp + tgt.shield > enemyMax(tgt) * 0.3;
        const again = tgt.id !== this.lastFlanked || s.time - this.flankedAt > 5;
        // Going round pays against one squad, not when another can see the way round.
        const alone = new Set(fighting.map((e) => e.squad)).size <= 1 && watching.length <= 1;
        if (healthy && again && alone && flankOf(s, tgt) === "front" && this.rnd() < sk.flank) {
          const hide = this.hideSpot(s, tgt);
          if (hide) {
            this.lastFlanked = tgt.id;
            this.flankedAt = s.time;
            this.flank = { ...hide, id: tgt.id, step: "hide" };
            this.flankT = 6;
          }
        }
      }
      const opening = tgt.aware !== "engaged";
      if (this.retreat) {
        // Run for it, facing the way: no shooting on the way, then down low out of sight.
        if (!hiding) {
          const step = this.via(s, this.retreat);
          const yaw = lookAngles(p.pos, { x: step.x, y: 0, z: step.z }).yaw;
          inp.lookX = wrapAngle(yaw - p.yaw) * sk.turn;
          inp.lookY = -p.pitch * sk.turn;
          const rel = yaw - p.yaw;
          inp.moveZ = Math.cos(rel);
          inp.moveX = Math.sin(rel);
        } else {
          // Low, watching the way they will come: one that walks into view side-on gets shot.
          inp.crouch = !(sees && flankOf(s, tgt) !== "front");
          if (needHeal && !p.healing && !watching.length) inp.heal = true;
        }
      } else if (this.duckT > 0 && this.duck) {
        this.duckT -= TICK;
        const there = dist2d(this.duck, p.pos) < 0.6;
        if (!there) {
          const step = this.via(s, this.duck);
          const rel = lookAngles(p.pos, { x: step.x, y: 0, z: step.z }).yaw - p.yaw;
          inp.moveZ = Math.cos(rel);
          inp.moveX = Math.sin(rel);
        } else inp.crouch = true;
      } else if (this.flank) {
        const step = this.via(s, this.flank);
        const rel = lookAngles(p.pos, { x: step.x, y: 0, z: step.z }).yaw - p.yaw;
        inp.moveZ = Math.cos(rel);
        inp.moveX = Math.sin(rel);
      } else if (!sees && onTerrain(p.pos)) {
        // Walk a ground path toward it. A robot up high is hidden by its own roof edge or
        // tower walls from close below, so walk to the nearest ground spot that sees it instead.
        // On its way out it does not go looking for robots it cannot see: it makes for the pickup.
        let to = aim < 0 ? (this.waitSpot(s) ?? { x: this.exit(s).x, z: this.exit(s).z }) : { x: tgt.pos.x, z: tgt.pos.z };
        if (aim >= 0 && tgt.pos.y > p.pos.y + 1.5) {
          if (!this.angle || this.angle.id !== tgt.id || s.time > this.angle.until) {
            // With no spot that sees it, back off into the open rather than stand under it: a
            // robot that heard the bot comes to its roof's edge to look, and shows itself there.
            const spot = this.angleSpot(tgt) ?? this.backOff(tgt) ?? to;
            this.angle = { id: tgt.id, until: s.time + 4, x: spot.x, z: spot.z };
          }
          to = { x: this.angle.x, z: this.angle.z };
        }
        const step = this.via(s, to);
        const rel = lookAngles(p.pos, { x: step.x, y: 0, z: step.z }).yaw - p.yaw;
        inp.moveZ = Math.cos(rel);
        inp.moveX = Math.sin(rel);
      } else if (opening) {
        // A robot that has not seen it yet: stop, get low and take the first shot from range.
        inp.moveZ = d > pref + 3 ? 1 : 0;
        inp.crouch = inp.moveZ === 0;
      } else {
        // Fight from behind low cover near by when there is some; otherwise keep moving.
        if (!this.post || this.post.id !== tgt.id || s.time > this.post.until) {
          const spot = sees && onTerrain(p.pos) && onTerrain(tgt.pos) && this.rnd() < sk.dodge ? this.postSpot(tgt, pref) : null;
          this.post = spot ? { ...spot, id: tgt.id, until: s.time + 3 } : { x: NaN, z: NaN, id: tgt.id, until: s.time + 1.5 };
        }
        if (Number.isFinite(this.post.x)) {
          const there = dist2d(this.post, p.pos) < 0.7;
          if (!there) {
            const step = this.via(s, this.post);
            const rel = lookAngles(p.pos, { x: step.x, y: 0, z: step.z }).yaw - p.yaw;
            inp.moveZ = Math.cos(rel);
            inp.moveX = Math.sin(rel);
          }
        } else {
          inp.moveZ = !sees ? 1 : d > pref + 3 ? 1 : d < pref - 3 ? -0.8 : 0;
          inp.moveX = this.side * (sk.dodge > 0.5 ? 0.9 : 0.5);
        }
      }

      const aimDir = Math.hypot(wrapAngle(want.yaw - p.yaw), want.pitch - p.pitch);
      const tol = (sk.name === "beginner" ? 12 : 8) * DEG + Math.atan(1 / Math.max(d, 1));
      const ambushing = hiding && flankOf(s, tgt) !== "front";
      const busy = (!!this.retreat && !ambushing) || (this.duckT > 0 && !!this.duck);
      inp.fire = sees && aimDir < tol && d < 60 && !p.healing && !busy && !(this.flank && flankOf(s, tgt) === "front");
      // Aimed down sights past arm's length, where the aim pull helps; the shotgun from the hip.
      inp.ads = sees && !busy && d > (w?.kind === "hornet" ? 8 : 12) && w?.kind !== "maul";

      // Shockwave: jump when the ring is about to arrive.
      for (const wv of s.waves) {
        const dd = Math.hypot(p.pos.x - wv.x, p.pos.z - wv.z) - wv.r;
        if (dd > 0.3 && dd < 1.6 && this.rnd() < sk.dodge * 0.25) inp.jump = true;
      }
      if (engaged.length >= 2 || tgt.mode === "telegraph") {
        if (p.tactical <= 0 && this.rnd() < sk.abilities * TICK) inp.tactical = true;
      }
      // Losing a fight against a squad or more: leap away and start over somewhere else.
      const left = (p.hp + p.shield) / (PLAYER.hp + PLAYER.shieldByTier[p.armor]);
      if (p.ult >= 1 && left < 0.4 && engaged.length >= 2 && tgt.kind !== "titan" && !calling) {
        this.escape = this.escapeSpot(s, engaged);
        if (this.escape) {
          inp.ult = true;
          // Plans made down here do not hold where it lands.
          this.retreat = this.flank = this.post = null;
        }
      }
      // Pick the weapon that suits the distance (when it has two).
      const other = p.weapons[1 - p.slot];
      this.swapT -= TICK;
      if (other && w && this.swapT <= 0 && p.reload <= 0) {
        // The scoped rifle for an opening shot from range (every skill does that much);
        // otherwise, past a beginner, what suits the distance.
        const scope = opening && d > 16 && other.kind === "talon";
        const suits = sk.name !== "beginner" && !(opening && w.kind === "talon") && Math.abs(PREF[other.kind] - d) + 6 < Math.abs(PREF[w.kind] - d);
        // A beginner puts the rifle away once the fight is on.
        const back = sk.name === "beginner" && !opening && w.kind === "talon";
        if (scope || suits || back) {
          inp.swap = true;
          this.swapT = 3;
        }
      }
      // Out of every fighting robot's sight and with none close, top up between exchanges.
      const close = live.some((e) => dist2d(e.pos, p.pos) < 8);
      if (needHeal && !close && !watching.length && !p.healing && !inp.fire) inp.heal = true;
      if (p.healing) inp.fire = false;
    } else if (goal) {
      const d = dist2d(goal, p.pos);
      inp.moveZ = d > 1.2 ? 1 : 0;
      // Not into a pickup that has to be called while hurt with something to heal with: top up first.
      const x = this.exit(s);
      const hurt = (p.hp + p.shield) / (PLAYER.hp + PLAYER.shieldByTier[p.armor]) < 0.75;
      if (aim < 0 && x.call && !s.calls[x.id] && dist2d(x, p.pos) < x.radius + 6 && (hurt || p.healing) && pickHeal(s)) inp.moveZ = 0;
      if (Math.abs(wrapAngle(want.yaw - p.yaw)) > 0.5) inp.moveZ = 0.4;
      if (w && w.mag < magSize(w) * 0.6 && p.reload <= 0) inp.reload = true;
      const max = PLAYER.shieldByTier[p.armor];
      // Not in sight of a robot that is fighting it: healing is slow and heard.
      const watched = live.some((e) => e.aware === "engaged" && dist2d(e.pos, p.pos) < 50 && los(eye, bodyCenter(e)));
      if ((p.shield < max * 0.6 || p.hp < 75) && !p.healing && !watched && pickHeal(s)) inp.heal = true;
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
    if (p.pos.y - groundLevel(p.pos.x, p.pos.z) > 0.5) inp.jump = false;
    if (onTerrain(p.pos)) {
      this.trail = [];
      this.upT = 0;
      this.trailStuckT = 0;
      this.lastGround = { x: p.pos.x, z: p.pos.z };
    } else {
      // The trail starts where it last stood on the terrain, so walking it back ends on the
      // ground (where the grid plans again), not on the bottom step of a stair.
      if (!this.trail.length && this.lastGround && dist2d(this.lastGround, p.pos) < 3) this.trail.push(this.lastGround);
      const last = this.trail[this.trail.length - 1];
      if (this.upT <= 2 && (!last || dist2d(last, p.pos) > 0.4)) this.trail.push({ x: p.pos.x, z: p.pos.z });
      if (p.onGround && p.pos.y - groundLevel(p.pos.x, p.pos.z) > 0.8) this.upT += TICK;
      if (this.upT > 2) {
        while (this.trail.length > 1 && dist2d(this.trail[this.trail.length - 1], p.pos) < 0.35) this.trail.pop();
        // A point taken while brushing a wall or a floor's edge can lie a hand's width
        // out of reach: when the walk back makes no headway, skip to the point before it,
        // and past the first one hand the way down back to the unstick step.
        this.trailStuckT += TICK;
        if (dist2d(this.trailFrom, p.pos) > 0.3) {
          this.trailFrom = { x: p.pos.x, z: p.pos.z };
          this.trailStuckT = 0;
        } else if (this.trailStuckT > 0.5) {
          this.trailStuckT = 0;
          if (this.trail.length > 1) this.trail.pop();
          else {
            this.trail = [];
            this.upT = 0;
          }
        }
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
   * The POI to take next: the nearest one not yet cleared in the region it dropped into,
   * until the bot has cleared as many as its skill dares (`Skill.raid`). The titan's
   * landing pad comes only last, and only for a bot that takes on every POI. -1 means it
   * is time to leave.
   */
  private nextPoi(s: State): number {
    if (s.stats.cleared.length >= this.skill.raid) return -1;
    // The raiders are down: cut the raid short, as soon as the POIs it promised itself are halved.
    if (this.raidersIn && s.stats.cleared.length >= Math.ceil(this.skill.raid / 2)) return -1;
    // Hurt with nothing left to heal with: one more fight is one too many.
    const p0 = s.player;
    const left = (p0.hp + p0.shield) / (PLAYER.hp + PLAYER.shieldByTier[p0.armor]);
    if (left < 0.6 && !pickHeal(s) && s.stats.cleared.length > 0) return -1;
    // Its self-revive is spent: the next down may be the last, so no more POIs.
    if (p0.selfRevive <= 0 && s.stats.cleared.length > 0) return -1;
    const p = s.player;
    const mine = regionOf(s.region).pois;
    const others = POIS.filter((poi) => !poi.boss && mine.includes(poi.id)).length;
    const open = POIS.map((poi, i) => ({ poi, i })).filter(({ poi, i }) => mine.includes(poi.id) && !s.cleared[i] && (!poi.boss || s.stats.cleared.length >= others));
    open.sort((a, b) => dist2d(a.poi, p.pos) - dist2d(b.poi, p.pos));
    return open[0]?.i ?? -1;
  }

  private wait: { id: string; x: number; z: number } | null = null;

  /**
   * While a pickup it called is on its way: a spot near it, out of sight of where the robots
   * beam in, to wait at instead of standing in the open. Null once the pickup is there (it
   * goes in then), for a pickup that is not called, or when there is no such spot.
   */
  private waitSpot(s: State): { x: number; z: number } | null {
    const x = this.exit(s);
    if (!x.call || !s.calls[x.id] || callLeft(s, x.id) <= 1.5) return null;
    // A pickup with no hidden spot near it is remembered as NaN: wait in the open then.
    if (this.wait?.id === x.id) return Number.isFinite(this.wait.x) ? this.wait : null;
    const at = x.waves ?? x;
    const from = { x: at.x, y: terrainHeight(at.x, at.z) + 1.8, z: at.z };
    let best: { x: number; z: number; d: number } | null = null;
    for (const r of [4, 7, 10, 13])
      for (let a = 0; a < 2 * Math.PI; a += Math.PI / 8) {
        const px = x.x + Math.sin(a) * r;
        const pz = x.z - Math.cos(a) * r;
        if (!inWorld(px, pz, 3)) continue;
        const g = terrainHeight(px, pz);
        if (groundAt(px, pz, 0.4, g + 0.3) > g + 0.3 || [0.3, 1.0, 1.6].some((h) => solidAt(px, g + h, pz))) continue;
        if (los(from, { x: px, y: g + 1.1, z: pz })) continue;
        const route = findPath(x.x, x.z, px, pz);
        if (!route) continue;
        if (!best || r < best.d) best = { x: px, z: pz, d: r };
      }
    this.wait = best ? { id: x.id, x: best.x, z: best.z } : { id: x.id, x: NaN, z: NaN };
    return Number.isFinite(this.wait.x) ? this.wait : null;
  }

  /**
   * On its way out, with no robot that is fighting it in sight (so none sees it either) and
   * no robot it has not dealt with standing in the way: slip off toward the exit rather than
   * go back into the fight.
   */
  private slipAway(s: State, live: Enemy[]): boolean {
    const p = s.player;
    const eye = eyePos(s);
    if (this.retreat && dist2d(this.retreat, p.pos) > 1.5) return false;
    return !live.some((e) => e.aware === "engaged" && dist2d(e.pos, p.pos) < 50 && los(eye, bodyCenter(e)));
  }

  /**
   * Open low ground a glide's length away, as far as can be from the robots fighting it:
   * the way a player would pick where to leap to. Open means no building within a couple
   * of metres of it or tall under the way, so it comes down on the ground it plans on, not on
   * a roof or into a stairwell (it does not take stairs).
   */
  private escapeSpot(s: State, from: Enemy[]): { x: number; z: number } | null {
    const p = s.player;
    const reach = ULT.glide * 3;
    let best: { x: number; z: number } | null = null;
    let bestScore = -Infinity;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const x = p.pos.x + Math.cos(a) * reach;
      const z = p.pos.z + Math.sin(a) * reach;
      if (offLowGround(x, z) || offshore(x, z) > -12) continue;
      const t = terrainHeight(x, z);
      if (ceilingAt(x, z, 2, t + 40, t) < Infinity || groundAt(x, z, 2, t + 40) > t + 0.5) continue;
      // Nothing tall under the way there either: the glide may run out of height over it.
      let clear = true;
      for (let k = 2; k < reach && clear; k += 2) {
        const cx = p.pos.x + Math.cos(a) * k;
        const cz = p.pos.z + Math.sin(a) * k;
        const ct = terrainHeight(cx, cz);
        clear = groundAt(cx, cz, 1.5, ct + 40) <= ct + 3;
      }
      if (!clear) continue;
      const score = Math.min(...from.map((e) => Math.hypot(e.pos.x - x, e.pos.z - z)));
      if (score > bestScore) {
        bestScore = score;
        best = { x, z };
      }
    }
    return best;
  }

  /**
   * The way off, in the region it dropped into. In the reservoir: a flare's quick pickup
   * when it has one, else beginners take the long quiet walk and the others call the
   * dropship and hold. In the harbor: the boat, called and held for.
   */
  private exit(s: State): ExtractPoint {
    const exits = regionOf(s.region).exits;
    const pick = (id: string) => (exits.includes(id as ExtractPoint["id"]) ? EXTRACTS.find((x) => x.id === id) : undefined);
    // The dropship lands by the titan: only a bot that has beaten it goes there.
    const titanUp = s.enemies.some((e) => e.kind === "titan");
    const quiet = this.skill.name === "beginner" || titanUp || this.raidersIn;
    return (s.player.flares > 0 ? pick("flare") : undefined) ?? (quiet ? pick("village") : pick("ship")) ?? pick("village") ?? EXTRACTS.find((x) => x.id === exits[0])!;
  }

  /**
   * A standable spot 9-13 m from the robot, behind it or to its side, that sees
   * its body and is reachable on foot by a route mostly out of its squad's sight.
   * The shortest and least exposed route wins.
   */
  private flankSpot(s: State, tgt: Enemy): { x: number; z: number } | null {
    // Everyone fighting it: the spot sees the target and no one else, and the way there stays out of their sight.
    const watchers = s.enemies.filter((e) => e.squad === tgt.squad || (e.aware === "engaged" && dist2d(e.pos, this.from) < 60));
    const others = watchers.filter((e) => e !== tgt);
    let best: { x: number; z: number; cost: number } | null = null;
    for (let off = 1.6; off <= 2 * Math.PI - 1.6 + 1e-6; off += 0.3)
      for (const r of [7, 10, 14]) {
        const a = tgt.yaw + off;
        const x = tgt.pos.x + Math.sin(a) * r;
        const z = tgt.pos.z - Math.cos(a) * r;
        if (!inWorld(x, z, 3)) continue;
        const g = terrainHeight(x, z);
        if (groundAt(x, z, 0.4, g + 0.3) > g + 0.3 || [0.3, 1.0, 1.6].some((h) => solidAt(x, g + h, z))) continue;
        if (!los({ x, y: g + 1.6, z }, bodyCenter(tgt))) continue;
        if (others.some((w) => los(muzzleOf(w), { x, y: g + 1.1, z }))) continue;
        const route = this.route(x, z);
        if (!route || route.len > 45) continue;
        // Walking the route in their sight would only turn them round: prefer hidden routes.
        const exposed = route.samples.filter((q) => watchers.some((w) => los({ x: q.x, y: terrainHeight(q.x, q.z) + 1.4, z: q.z }, bodyCenter(w)))).length / Math.max(1, route.samples.length);
        const cost = route.len * (1 + exposed * 4);
        if (exposed < 0.3 && (!best || cost < best.cost)) best = { x, z, cost };
      }
    return best ? { x: best.x, z: best.z } : null;
  }

  private angle: { id: number; until: number; x: number; z: number } | null = null;

  /**
   * The nearest ground spot (by route) within 55 m of a robot up high that sees its body:
   * a tall deck's guard is seen only from well back.
   */
  private angleSpot(tgt: Enemy): { x: number; z: number } | null {
    let best: { x: number; z: number; len: number } | null = null;
    for (let r = 10; r <= 55; r += 5)
      for (let a = 0; a < 2 * Math.PI; a += Math.PI / 12) {
        const x = tgt.pos.x + Math.sin(a) * r;
        const z = tgt.pos.z - Math.cos(a) * r;
        if (!inWorld(x, z, 3)) continue;
        const g = terrainHeight(x, z);
        if (groundAt(x, z, 0.4, g + 0.3) > g + 0.3 || [0.3, 1.0, 1.6].some((h) => solidAt(x, g + h, z))) continue;
        if (!los({ x, y: g + 1.6, z }, bodyCenter(tgt))) continue;
        const route = this.route(x, z);
        if (route && route.len < 90 && (!best || route.len < best.len)) best = { x, z, len: route.len };
      }
    return best && { x: best.x, z: best.z };
  }

  /** Open ground under open sky 25-40 m from a robot up high, on the bot's side of it, that it can walk to. */
  private backOff(tgt: Enemy): { x: number; z: number } | null {
    const away = Math.atan2(this.from.x - tgt.pos.x, -(this.from.z - tgt.pos.z));
    for (const r of [32, 25, 40])
      for (const da of [0, 0.5, -0.5, 1, -1, 1.6, -1.6]) {
        const a = away + da;
        const x = tgt.pos.x + Math.sin(a) * r;
        const z = tgt.pos.z - Math.cos(a) * r;
        if (!inWorld(x, z, 3)) continue;
        const g = terrainHeight(x, z);
        if (groundAt(x, z, 0.4, g + 0.3) > g + 0.3 || [0.3, 1.0, 1.6].some((h) => solidAt(x, g + h, z))) continue;
        if (ceilingAt(x, z, 0.4, g + 60, g) < Infinity) continue; // indoors: the robot would never see it
        const route = this.route(x, z);
        if (route && route.len < 90) return { x, z };
      }
    return null;
  }

  /**
   * A standable spot at one of `radii` metres that none of `watchers` can see (crouched when
   * `low`), reachable on foot within `maxRoute` metres. A quick duck takes the nearest; backing
   * off favours a way there that stays out of their sight, and spots further from them.
   */
  private coverSpot(watchers: Enemy[], radii: number[], maxRoute: number, low: boolean): { x: number; z: number } | null {
    let best: { x: number; z: number; score: number } | null = null;
    for (const r of radii)
      for (let a = 0; a < 2 * Math.PI; a += Math.PI / 6) {
        const x = this.from.x + Math.sin(a) * r;
        const z = this.from.z - Math.cos(a) * r;
        if (!inWorld(x, z, 3)) continue;
        const g = terrainHeight(x, z);
        if (groundAt(x, z, 0.4, g + 0.3) > g + 0.3 || [0.3, 1.0, 1.6].some((h) => solidAt(x, g + h, z))) continue;
        const at = { x, y: g + (low ? 0.75 : 1.5), z };
        if (watchers.some((w) => los(muzzleOf(w), at))) continue;
        const route = this.route(x, z);
        if (!route || route.len > maxRoute) continue;
        let score = route.len;
        if (!low) {
          const seen = route.samples.filter((q) => watchers.some((w) => los(muzzleOf(w), { x: q.x, y: terrainHeight(q.x, q.z) + 1.1, z: q.z }))).length;
          score = route.len * (1 + (4 * seen) / Math.max(1, route.samples.length)) - 0.5 * Math.min(...watchers.map((w) => dist2d(w.pos, at)));
        }
        if (!best || score < best.score) best = { x, z, score };
      }
    return best && { x: best.x, z: best.z };
  }

  /**
   * A spot within a few metres from which the bot, standing, sees the robot's body, and which
   * hides its chest from the robot when it crouches: low cover to shoot over and duck behind.
   */
  private postSpot(tgt: Enemy, pref: number): { x: number; z: number } | null {
    let best: { x: number; z: number; score: number } | null = null;
    for (const r of [0, 1.5, 3, 4.5, 6])
      for (let a = 0; a < 2 * Math.PI; a += r ? Math.PI / 6 : 7) {
        const x = this.from.x + Math.sin(a) * r;
        const z = this.from.z - Math.cos(a) * r;
        if (!inWorld(x, z, 3)) continue;
        const g = terrainHeight(x, z);
        if (groundAt(x, z, 0.4, g + 0.3) > g + 0.3 || [0.3, 1.0, 1.6].some((h) => solidAt(x, g + h, z))) continue;
        if (!los({ x, y: g + PLAYER.eye, z }, bodyCenter(tgt))) continue;
        if (los(muzzleOf(tgt), { x, y: g + 0.75, z })) continue;
        const route = r ? this.route(x, z) : { len: 0, samples: [] };
        if (!route || route.len > 8) continue;
        const score = route.len + Math.abs(dist2d({ x, z }, tgt.pos) - pref) * 0.3;
        if (!best || score < best.score) best = { x, z, score };
      }
    return best && { x: best.x, z: best.z };
  }

  /** The nearest standable spot within 10 m that no member of the robot's squad can see. */
  private hideSpot(s: State, tgt: Enemy): { x: number; z: number } | null {
    const watchers = s.enemies.filter((e) => e.squad === tgt.squad || (e.aware === "engaged" && dist2d(e.pos, this.from) < 60));
    let best: { x: number; z: number; len: number } | null = null;
    for (const r of [3, 5, 7, 10])
      for (let a = 0; a < 2 * Math.PI; a += Math.PI / 6) {
        const x = this.from.x + Math.sin(a) * r;
        const z = this.from.z - Math.cos(a) * r;
        if (!inWorld(x, z, 3)) continue;
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

  /**
   * The slot a found weapon goes into: the worse of the two, but never the scoped rifle,
   * which the bot keeps for its opening shots.
   */
  private spareSlot(s: State): number {
    const [a, b] = s.player.weapons;
    if (a?.kind === "talon" && b) return 1;
    if (b?.kind === "talon" && a) return 0;
    return (a ? a.rarity : -1) <= (b ? b.rarity : -1) ? 0 : 1;
  }

  /** Unopened bins and better weapons nearby, when nothing is shooting. */
  private lootGoal(s: State): { x: number; z: number; weapon?: true } | null {
    const p = s.player;
    const spare = p.weapons[this.spareSlot(s)];
    const worst = spare ? spare.rarity : -1;
    // Skip anything above our floor (roofs, platforms) and anything we failed to reach for 10 s.
    // Only things on the terrain: the bot plans on the ground and does not climb to floors or roofs.
    const reachable = (c: { x: number; z: number; y?: number }) => (c.y ?? 0) < terrainHeight(c.x, c.z) + 0.6 && !this.skip.has(`${Math.round(c.x)},${Math.round(c.z)}`);

    const cands: { x: number; z: number; d: number; weapon?: true }[] = [];
    for (const b of s.bins) if (!b.open && (!b.vault || p.keys.includes(b.poi)) && dist2d(b, p.pos) < 26 && reachable(b)) cands.push({ x: b.x, z: b.z, d: dist2d(b, p.pos) });
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
