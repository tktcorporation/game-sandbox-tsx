import { ALLY, AWARE, CHARGER, COVER, DEG, ENEMIES, PLAYER, TICK, TITAN, TURN, WORLD, type EnemyKind } from "./config";
import { collide, dist2d, groundAt, los, lookAngles, onTerrain, solidAt, wrapAngle } from "./geom";
import { terrainHeight } from "./terrain";
import { engageSquad, knownSpot, sense, stepSquads } from "./awareness";
import { COVERS } from "./cover";

/** Walkers refuse to step off a ledge higher than this, so rooftop robots stay on their roof. */
const LEDGE = 1.0;
/** Walkers posted on the ground climb no higher than this above the terrain (stairs onto a roof). */
const CLIMB = 1.2;
const bodyHeight = (k: { bodyY: number; radius: number }) => k.bodyY + k.radius;
import { POIS, ROAMERS, type Squad } from "./map";
import { bodyCenter, weakPoint } from "./combat";
import { hurtPlayer } from "./player";
import { allyChest, allyUp, hurtAlly } from "./ally";
import { rand, type Enemy, type Point, type State, type Vec3 } from "./state";

/*
 * Robot behaviour. Out of combat a robot holds its post or walks its squad's
 * patrol, and searches where it heard or glimpsed something. In combat every
 * attack follows the same readable rhythm: move -> telegraph (eye glows, aim
 * locks near the end) -> fire -> move. Grunts on the ground hide behind cover
 * between shots and step out sideways to fire.
 */

interface SpawnOpts {
  floor?: number;
  face?: number;
  /** Beam in with the spawn animation (titan summons) instead of standing there from the start. */
  appear?: boolean;
}

export function spawnEnemy(s: State, kind: EnemyKind, x: number, z: number, poi: number, squad: number, o: SpawnOpts = {}): Enemy {
  const k = ENEMIES[kind];
  const floor = o.floor ?? 0;
  const pos = { x, y: floor, z };
  collide(pos, k.radius, bodyHeight(k));
  pos.y = k.fly > 0 ? flyHeight(pos.x, pos.z) : groundAt(pos.x, pos.z, k.radius, floor + 0.3);
  const face = o.face ?? rand(s) * Math.PI * 2;
  const e: Enemy = {
    id: s.nextId++,
    kind,
    pos,
    vel: { x: 0, y: 0, z: 0 },
    yaw: face,
    hp: k.hp,
    shield: k.shield,
    mode: o.appear ? "spawning" : "move",
    timer: o.appear ? 0.9 : 0,
    cooldown: 0,
    shotsLeft: 0,
    strafe: rand(s) < 0.5 ? -1 : 1,
    poi,
    lastHit: 99,
    aimYaw: 0,
    aimPitch: 0,
    summoned: 0,
    squad,
    aware: "idle",
    detect: 0,
    home: { ...pos },
    face,
    lookT: rand(s) * 10,
    goal: null,
    searchT: 0,
    cover: null,
    peek: null,
    coverT: 0,
    target: "player",
    targetT: 0,
    allyHit: 99,
  };
  s.enemies.push(e);
  if (o.appear) s.events.push({ t: "spawn", id: e.id, pos: { ...pos } });
  return e;
}

/** Put every squad on the island at the start of a run. */
export function populate(s: State) {
  const add = (sq: Squad, poi: number) => {
    const index = s.squads.length;
    s.squads.push({ name: sq.name, poi, patrol: sq.patrol ?? [], leg: 0, engaged: false, roam: !!sq.roam, sinceSeen: 0, last: { x: 0, z: 0 } });
    for (const m of sq.members) spawnEnemy(s, m.kind, m.x, m.z, poi, index, { floor: m.y ?? 0, face: m.face });
  };
  POIS.forEach((p, i) => p.squads.forEach((sq) => add(sq, i)));
  ROAMERS.forEach((sq) => add(sq, -1));
}

const chest = (s: State): Vec3 => ({ x: s.player.pos.x, y: s.player.pos.y + 1.1, z: s.player.pos.z });

function muzzle(e: Enemy): Vec3 {
  return e.kind === "drone" ? weakPoint(e) : { ...bodyCenter(e), y: e.pos.y + ENEMIES[e.kind].weakY - 0.1 };
}

function fireOrb(s: State, e: Enemy, yawOff = 0, homing = false) {
  const k = ENEMIES[e.kind];
  const from = muzzle(e);
  const yaw = e.aimYaw + yawOff;
  const c = Math.cos(e.aimPitch);
  s.orbs.push({
    id: s.nextId++,
    pos: from,
    vel: { x: Math.sin(yaw) * c * k.orbSpeed, y: Math.sin(e.aimPitch) * k.orbSpeed, z: -Math.cos(yaw) * c * k.orbSpeed },
    r: k.orbR,
    dmg: k.orbDmg,
    life: 5,
    homing,
  });
  s.events.push({ t: "enemyFire", id: e.id, pos: from });
}

function lockAim(e: Enemy, at: Vec3) {
  const a = lookAngles(muzzle(e), at);
  e.aimYaw = a.yaw;
  e.aimPitch = a.pitch;
}

/** Drones keep their hover height above whatever is under them. */
function flyHeight(x: number, z: number): number {
  return Math.max(ENEMIES.drone.fly, groundAt(x, z, 1.2, 99) + 2.4);
}

function moveBody(e: Enemy, vx: number, vz: number) {
  const k = ENEMIES[e.kind];
  e.vel.x += (vx - e.vel.x) * Math.min(1, TICK * 8);
  e.vel.z += (vz - e.vel.z) * Math.min(1, TICK * 8);
  const bx = e.pos.x;
  const bz = e.pos.z;
  e.pos.x += e.vel.x * TICK;
  e.pos.z += e.vel.z * TICK;
  if (k.fly > 0) {
    e.pos.y += (flyHeight(e.pos.x, e.pos.z) - e.pos.y) * Math.min(1, TICK * 2.5);
    const lim = WORLD.half - 1;
    e.pos.x = Math.max(-lim, Math.min(lim, e.pos.x));
    e.pos.z = Math.max(-lim, Math.min(lim, e.pos.z));
    return false;
  }
  const blocked = collide(e.pos, k.radius, bodyHeight(k));
  const here = groundAt(bx, bz, k.radius, e.pos.y);
  const there = groundAt(e.pos.x, e.pos.z, k.radius, e.pos.y);
  // A drop ahead stays on this floor. A robot posted up high (a roof, a tower tier)
  // never leaves its floor at all: it could not find the way back up. A robot posted
  // on the ground does not climb stairs onto roofs or upper floors either.
  const homeHigh = e.home.y > terrainHeight(e.home.x, e.home.z) + 0.6;
  const climbsUp = !homeHigh && there > terrainHeight(e.pos.x, e.pos.z) + CLIMB;
  if (there < here - LEDGE || (homeHigh && Math.abs(there - e.home.y) > 0.3) || climbsUp) {
    e.pos.x = bx;
    e.pos.z = bz;
    e.vel.x = e.vel.z = 0;
    return true;
  }
  // Walk up steps at once; fall down with gravity.
  if (there >= e.pos.y) {
    e.pos.y = there;
    e.vel.y = 0;
  } else {
    e.vel.y -= WORLD.gravity * TICK;
    e.pos.y = Math.max(there, e.pos.y + e.vel.y * TICK);
    if (e.pos.y === there) e.vel.y = 0;
  }
  // Moved much less than asked: the way is blocked.
  return blocked && Math.hypot(e.pos.x - bx, e.pos.z - bz) < Math.hypot(vx, vz) * TICK * 0.4;
}

export function stepEnemies(s: State) {
  const p = s.player;
  stepSquads(s);
  for (const e of [...s.enemies]) {
    const k = ENEMIES[e.kind];
    e.lastHit += TICK;
    e.allyHit += TICK;
    if (e.mode === "spawning") {
      e.timer -= TICK;
      if (e.timer <= 0) {
        e.mode = "move";
        e.cooldown = k.cooldown * (0.4 + rand(s) * 0.5);
      }
      continue;
    }
    sense(s, e);
    if (e.mode === "stunned") {
      e.timer -= TICK;
      moveBody(e, 0, 0);
      if (e.timer <= 0) {
        e.mode = "move";
        e.cooldown = Math.max(e.cooldown, 0.6);
      }
      continue;
    }
    if (e.aware !== "engaged") {
      // The titan wakes when the player walks into its arena.
      if (e.kind === "titan" && dist2d(e.pos, p.pos) < 24 && p.downed <= 0 && s.phase === "play") engageSquad(s, e.squad, e);
      else {
        calm(s, e);
        continue;
      }
    }
    if (e.kind === "titan") {
      const d = dist2d(e.pos, p.pos);
      e.yaw += wrapAngle(lookAngles(e.pos, p.pos).yaw - e.yaw) * Math.min(1, TICK * 1.5);
      titan(s, e, d);
      continue;
    }
    // Whom it fights. At the teammate it knows where it is (the teammate shoots and
    // calls out); at the player it acts on what its squad knows: the player while
    // seen, else the last sighting.
    chooseTarget(s, e);
    const atAlly = e.target === "ally";
    const tPos = atAlly ? s.ally.pos : p.pos;
    const tChest = atAlly ? allyChest(s.ally) : chest(s);
    const tUp = atAlly ? allyUp(s) : p.downed <= 0;
    const known = atAlly ? { x: tPos.x, z: tPos.z, live: true } : knownSpot(s, e);
    const dx = known.x - e.pos.x;
    const dz = known.z - e.pos.z;
    const d = Math.hypot(dx, dz) || 1e-3;
    if (e.mode !== "lunge" && d > 0.5) turnAt(e, Math.atan2(dx, -dz), TURN[e.kind]);
    if (e.kind === "grunt" && onTerrain(e.pos) && fromCover(s, e, known, tChest, tUp)) continue;
    switch (e.mode) {
      case "move": {
        const sees = known.live && facing(e, tPos) && los(muzzle(e), tChest);
        const ux = dx / d;
        const uz = dz / d;
        let along = 0;
        // At the last sighting with nobody in view, it stands and turns: the squad's search begins.
        if (!sees && !known.live && d < 2) along = 0;
        else if (!sees || d > k.range + 4) along = 1;
        else if (d < k.range - 4) along = -0.7;
        const side = sees || e.kind === "charger" ? 0.55 : 0.8;
        const vx = (ux * along - uz * e.strafe * side) * k.speed;
        const vz = (uz * along + ux * e.strafe * side) * k.speed;
        if (moveBody(e, vx, vz)) e.strafe = -e.strafe;
        else if (rand(s) < TICK * 0.35) e.strafe = -e.strafe;
        e.cooldown -= TICK;
        const ready = e.cooldown <= 0 && sees && tUp;
        if (ready && (e.kind === "charger" ? d < CHARGER.lungeRange : d < 48)) {
          e.mode = "telegraph";
          e.timer = k.telegraph;
          lockAim(e, tChest);
          s.events.push({ t: "telegraph", id: e.id });
        }
        break;
      }
      case "telegraph": {
        moveBody(e, 0, 0);
        e.timer -= TICK;
        // Aim follows the player until the last 35% of the wind-up, then locks: moving dodges.
        // It can only aim where it faces: a player who slips out of its cone is shot at where they were.
        if (e.timer > k.telegraph * 0.35 && facing(e, tPos)) lockAim(e, tChest);
        if (e.timer <= 0) {
          if (e.kind === "charger") {
            e.mode = "lunge";
            e.timer = CHARGER.lungeTime;
            e.shotsLeft = 1;
            e.yaw = e.aimYaw;
            s.events.push({ t: "lunge", id: e.id });
          } else {
            e.mode = "fire";
            e.timer = 0;
            e.shotsLeft = k.shots;
          }
        }
        break;
      }
      case "fire": {
        moveBody(e, 0, 0);
        e.timer -= TICK;
        if (e.timer <= 0 && e.shotsLeft > 0) {
          if (k.spread > 0) {
            for (let i = 0; i < k.shots; i++) fireOrb(s, e, ((i - (k.shots - 1) / 2) * k.spread * Math.PI) / 180);
            e.shotsLeft = 0;
          } else {
            fireOrb(s, e);
            e.shotsLeft--;
            e.timer = k.shotGap;
          }
        }
        if (e.shotsLeft <= 0) {
          e.mode = "move";
          e.cooldown = k.cooldown * (0.8 + rand(s) * 0.4);
        }
        break;
      }
      case "lunge": {
        const vx = Math.sin(e.yaw) * CHARGER.lungeSpeed;
        const vz = -Math.cos(e.yaw) * CHARGER.lungeSpeed;
        e.vel.x = vx;
        e.vel.z = vz;
        const hitWall = moveBody(e, vx, vz);
        if (e.shotsLeft > 0 && Math.hypot(p.pos.x - e.pos.x, p.pos.z - e.pos.z) < CHARGER.hitRadius + PLAYER.radius && Math.abs(p.pos.y - e.pos.y) < 1.4) {
          e.shotsLeft = 0;
          hurtPlayer(s, k.orbDmg, e.pos.x, e.pos.z);
        }
        const a = s.ally;
        if (e.shotsLeft > 0 && allyUp(s) && Math.hypot(a.pos.x - e.pos.x, a.pos.z - e.pos.z) < CHARGER.hitRadius + ALLY.radius && Math.abs(a.pos.y - e.pos.y) < 1.4) {
          e.shotsLeft = 0;
          hurtAlly(s, k.orbDmg);
        }
        e.timer -= TICK;
        if (e.timer <= 0 || hitWall) {
          e.mode = "recover";
          e.timer = 1.0;
        }
        break;
      }
      case "recover": {
        moveBody(e, 0, 0);
        e.timer -= TICK;
        if (e.timer <= 0) {
          e.mode = "move";
          e.cooldown = k.cooldown * (0.8 + rand(s) * 0.4);
        }
        break;
      }
      default:
        break;
    }
  }
  separate(s);
}

/**
 * Whom an engaged robot fights, re-thought every 1.5 s: the nearer of the player and
 * the teammate, a target out of sight counting as far away. The teammate counts as
 * `aggroBias` metres further unless it has just shot this robot, so the player stays
 * the main target and the teammate draws the robots it hurts. The titan only fights the player.
 */
function chooseTarget(s: State, e: Enemy) {
  if (!allyUp(s)) {
    e.target = "player";
    return;
  }
  if (s.player.downed > 0) {
    e.target = "ally";
    return;
  }
  e.targetT -= TICK;
  if (e.targetT > 0) return;
  e.targetT = 1.5;
  const from = muzzle(e);
  const a = s.ally;
  const toPlayer = dist2d(e.pos, s.player.pos) + (los(from, chest(s)) ? 0 : 30) - (e.target === "player" ? 3 : 0);
  const toAlly = dist2d(e.pos, a.pos) + (los(from, allyChest(a)) ? 0 : 30) - (e.target === "ally" ? 3 : 0) + (e.allyHit < 2 ? -4 : ALLY.aggroBias);
  e.target = toAlly < toPlayer ? "ally" : "player";
}

/** Turn toward a yaw at no more than `rate` radians per second. */
function turnAt(e: Enemy, yaw: number, rate: number) {
  const diff = wrapAngle(yaw - e.yaw);
  const max = rate * TICK;
  e.yaw += Math.max(-max, Math.min(max, diff));
}

/** Whether the point is inside the cone a robot can fire into. */
function facing(e: Enemy, at: { x: number; z: number }): boolean {
  return Math.abs(wrapAngle(lookAngles(e.pos, { x: at.x, y: 0, z: at.z }).yaw - e.yaw)) < AWARE.fireCone * DEG;
}

/** Turn toward a yaw at a robot's turning speed. */
function turnTo(e: Enemy, yaw: number, rate = 3) {
  e.yaw += wrapAngle(yaw - e.yaw) * Math.min(1, TICK * rate);
}

/** Walk toward a point; returns true once there. */
function walkTo(e: Enemy, to: Point, speed: number, face = true): boolean {
  const dx = to.x - e.pos.x;
  const dz = to.z - e.pos.z;
  const d = Math.hypot(dx, dz);
  if (d < 0.35) {
    moveBody(e, 0, 0);
    return true;
  }
  if (face) turnTo(e, Math.atan2(dx, -dz), 4);
  if (moveBody(e, (dx / d) * speed, (dz / d) * speed)) e.strafe = -e.strafe;
  return false;
}

/** Out of combat: hold the post or walk the patrol; when alerted, go and look. */
function calm(s: State, e: Enemy) {
  const k = ENEMIES[e.kind];
  const slow = k.speed * AWARE.idleSpeed;
  e.lookT += TICK;
  if (e.aware === "alert" && e.poi === POIS.length - 1) {
    // The boss arena holds its ground: it looks, but does not leave.
    e.searchT -= TICK;
    if (e.goal) turnTo(e, Math.atan2(e.goal.x - e.pos.x, -(e.goal.z - e.pos.z)), 2);
    if (dist2d(e.pos, e.home) > 0.8) walkTo(e, e.home, slow, false);
    else moveBody(e, 0, 0);
    if (e.searchT <= 0) e.aware = "idle";
    return;
  }
  if (e.aware === "alert") {
    e.searchT -= TICK;
    if (e.goal && dist2d(e.pos, e.goal) > 2.5) walkTo(e, e.goal, slow * 1.4);
    else {
      moveBody(e, 0, 0);
      e.yaw += Math.sin(e.lookT * 1.3) * TICK * 1.6; // looking around
    }
    if (e.searchT <= 0) {
      e.aware = "idle";
      e.goal = null;
    }
    return;
  }
  const sq = s.squads[e.squad];
  if (sq && sq.patrol.length && e.kind !== "titan") {
    // The first living member leads; the others follow at an offset.
    const members = s.enemies.filter((o) => o.squad === e.squad);
    const slot = members.indexOf(e);
    const wp = sq.patrol[sq.leg % sq.patrol.length];
    const to = { x: wp.x + (slot % 2 ? 1.6 : -1.6) * Math.min(slot, 1), z: wp.z + slot * 1.4 };
    if (walkTo(e, to, slow) && slot === 0) sq.leg++;
    return;
  }
  if (dist2d(e.pos, e.home) > 0.8) walkTo(e, e.home, slow);
  else {
    moveBody(e, 0, 0);
    turnTo(e, e.face + Math.sin(e.lookT * 0.45) * 0.7, 1.5);
  }
}

/** Find a spot near this grunt that hides it from the player, with a spot beside it to shoot from. */
function findCover(s: State, e: Enemy, threat: Point, threatY: number): { cover: Point; peek: Point } | null {
  const p = { pos: { x: threat.x, y: threatY, z: threat.z } };
  const head = { x: p.pos.x, y: p.pos.y + 1.5, z: p.pos.z };
  const chestP = { x: p.pos.x, y: p.pos.y + 1.1, z: p.pos.z };
  const taken = s.enemies.filter((o) => o !== e && o.cover).map((o) => o.cover!);
  const cands = COVERS.map((c) => ({ c, d: dist2d(c, e.pos), dp: dist2d(c, p.pos) }))
    .filter(({ c, d, dp }) => d < COVER.search && dp > COVER.minFromPlayer && dp < COVER.maxFromPlayer && !taken.some((t) => dist2d(t, c) < 1.5))
    .sort((a, b) => a.d + Math.abs(a.dp - 16) * 0.3 - (b.d + Math.abs(b.dp - 16) * 0.3))
    .slice(0, 14);
  for (const { c } of cands) {
    if (los({ x: c.x, y: 1.3, z: c.z }, head)) continue;
    for (const sign of [1, -1]) {
      const peek = { x: c.x + c.tx * sign * COVER.peek, z: c.z + c.tz * sign * COVER.peek };
      if (solidAt(peek.x, 1.0, peek.z)) continue;
      if (los({ x: peek.x, y: 1.6, z: peek.z }, chestP)) return { cover: { x: c.x, z: c.z }, peek };
    }
  }
  return null;
}

/**
 * An engaged grunt on the ground: hide behind cover, step out to shoot, step
 * back. Returns false when it has no cover and should fight in the open.
 */
function fromCover(s: State, e: Enemy, known: { x: number; z: number; live: boolean }, tChest: Vec3, tUp: boolean): boolean {
  const k = ENEMIES.grunt;
  if (e.mode !== "move") return false; // telegraph and fire run as usual
  e.coverT -= TICK;
  // Re-think the spot every few seconds, and at once when hit (flanked).
  if (e.coverT <= 0 || e.lastHit < TICK * 1.5) {
    const found = findCover(s, e, known, tChest.y - 1.1);
    e.cover = found?.cover ?? null;
    e.peek = found?.peek ?? null;
    e.coverT = 2.5;
  }
  if (!e.cover || !e.peek) return false;
  e.cooldown -= TICK;
  const out = e.cooldown <= 0;
  const there = walkTo(e, out ? e.peek : e.cover, k.speed, false);
  if (out && there) {
    if (known.live && facing(e, tChest) && los({ ...e.pos, y: e.pos.y + k.weakY }, tChest) && tUp) {
      e.mode = "telegraph";
      e.timer = k.telegraph;
      e.aimYaw = e.yaw;
      s.events.push({ t: "telegraph", id: e.id });
    } else {
      // The player moved out of that angle: find another spot.
      e.coverT = 0;
      e.cooldown = 0.4;
    }
  }
  return true;
}

/** Keep walkers from stacking into one blob. */
function separate(s: State) {
  const list = s.enemies.filter((e) => ENEMIES[e.kind].fly === 0 && e.mode !== "spawning");
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      const r = ENEMIES[a.kind].radius + ENEMIES[b.kind].radius;
      const dx = b.pos.x - a.pos.x;
      const dz = b.pos.z - a.pos.z;
      const d = Math.hypot(dx, dz);
      // Robots on different floors (a tower's tiers) do not touch.
      if (d >= r || d < 1e-4 || Math.abs(a.pos.y - b.pos.y) > 1) continue;
      const push = (r - d) / 2;
      nudge(a, (-dx / d) * push, (-dz / d) * push);
      nudge(b, (dx / d) * push, (dz / d) * push);
    }
}

/** Shift a walker sideways, but never into a wall or off the floor it stands on. */
function nudge(e: Enemy, dx: number, dz: number) {
  const k = ENEMIES[e.kind];
  const bx = e.pos.x;
  const bz = e.pos.z;
  e.pos.x += dx;
  e.pos.z += dz;
  collide(e.pos, k.radius, bodyHeight(k));
  if (Math.abs(groundAt(e.pos.x, e.pos.z, k.radius, e.pos.y) - e.pos.y) > 0.3) {
    e.pos.x = bx;
    e.pos.z = bz;
  }
}

function titan(s: State, e: Enemy, d: number) {
  const k = ENEMIES.titan;
  const total = (e.hp + e.shield) / (k.hp + k.shield);
  const enraged = total < TITAN.enrageAt;
  if (enraged && !(e.summoned & 4)) {
    e.summoned |= 4;
    s.events.push({ t: "bossPhase" });
  }
  TITAN.summonAt.forEach((at, i) => {
    const bit = 1 << i;
    if (total < at && !(e.summoned & bit)) {
      e.summoned |= bit;
      for (let j = 0; j < 3; j++) {
        const a = e.yaw + (j - 1) * 1.1;
        const d = spawnEnemy(s, "drone", e.pos.x + Math.sin(a) * 9, e.pos.z - Math.cos(a) * 9, e.poi, e.squad, { appear: true });
        d.aware = "engaged";
        d.detect = 1;
      }
    }
  });
  const pace = enraged ? 0.7 : 1;
  const p = s.player;
  switch (e.mode) {
    case "move": {
      const ux = (p.pos.x - e.pos.x) / d;
      const uz = (p.pos.z - e.pos.z) / d;
      const along = d > k.range + 3 ? 1 : d < k.range - 6 ? -0.5 : 0;
      moveBody(e, (ux * along - uz * e.strafe * 0.4) * k.speed, (uz * along + ux * e.strafe * 0.4) * k.speed);
      e.cooldown -= TICK;
      if (e.cooldown <= 0 && p.downed <= 0) {
        // Alternate: stomp when close enough, otherwise rockets.
        const stomp = d < TITAN.stompRange - 4 && e.shotsLeft !== -1;
        if (stomp) {
          e.mode = "stomp";
          e.timer = TITAN.stompTelegraph * pace;
          s.events.push({ t: "stompTelegraph", id: e.id });
        } else {
          e.mode = "telegraph";
          e.timer = k.telegraph * pace;
          lockAim(e, chest(s));
          s.events.push({ t: "telegraph", id: e.id });
        }
      }
      break;
    }
    case "stomp": {
      moveBody(e, 0, 0);
      e.timer -= TICK;
      if (e.timer <= 0) {
        s.waves.push({ x: e.pos.x, z: e.pos.z, y: 0, r: k.radius, hit: false });
        s.events.push({ t: "stomp", x: e.pos.x, z: e.pos.z });
        e.shotsLeft = -1; // next attack is rockets
        e.mode = "move";
        e.cooldown = k.cooldown * pace;
      }
      break;
    }
    case "telegraph": {
      moveBody(e, 0, 0);
      e.timer -= TICK;
      lockAim(e, chest(s));
      if (e.timer <= 0) {
        e.mode = "fire";
        e.timer = 0;
        e.shotsLeft = enraged ? k.shots + 4 : k.shots;
      }
      break;
    }
    case "fire": {
      moveBody(e, 0, 0);
      e.timer -= TICK;
      if (e.timer <= 0 && e.shotsLeft > 0) {
        lockAim(e, chest(s));
        const n = e.shotsLeft;
        fireOrb(s, e, (n % 2 ? 1 : -1) * (0.25 + (n % 3) * 0.12), true);
        e.shotsLeft--;
        e.timer = k.shotGap;
      }
      if (e.shotsLeft <= 0) {
        e.shotsLeft = 0;
        e.mode = "move";
        e.cooldown = k.cooldown * pace;
      }
      break;
    }
    default:
      e.mode = "move";
  }
}

export function stepOrbs(s: State) {
  const p = s.player;
  const c = chest(s);
  // A hit can wipe the squad, and wipe() clears the air; do not write the old list back over it.
  const wipes = s.stats.wipes;
  const kept = s.orbs.filter((o) => {
    // Once a hit has wiped the squad, the rest of the air is gone: nothing may hit the team at the entry.
    if (s.stats.wipes !== wipes) return false;
    if (o.homing) {
      // Turn the velocity toward the player a little each tick.
      const sp = Math.hypot(o.vel.x, o.vel.y, o.vel.z);
      const tx = c.x - o.pos.x;
      const ty = c.y - o.pos.y;
      const tz = c.z - o.pos.z;
      const tl = Math.hypot(tx, ty, tz) || 1;
      const k = TITAN.homing * TICK;
      o.vel.x += ((tx / tl) * sp - o.vel.x) * k;
      o.vel.y += ((ty / tl) * sp - o.vel.y) * k;
      o.vel.z += ((tz / tl) * sp - o.vel.z) * k;
    }
    o.pos.x += o.vel.x * TICK;
    o.pos.y += o.vel.y * TICK;
    o.pos.z += o.vel.z * TICK;
    o.life -= TICK;
    if (o.life <= 0 || o.pos.y < terrainHeight(o.pos.x, o.pos.z)) return false;
    if (!los({ x: o.pos.x - o.vel.x * TICK, y: o.pos.y - o.vel.y * TICK, z: o.pos.z - o.vel.z * TICK }, o.pos)) return false;
    // Player as a vertical capsule from knee to head.
    const py = Math.max(p.pos.y + 0.4, Math.min(p.pos.y + (p.crouch || p.sliding ? 1.1 : 1.7), o.pos.y));
    if (Math.hypot(o.pos.x - p.pos.x, o.pos.y - py, o.pos.z - p.pos.z) < o.r + PLAYER.radius) {
      hurtPlayer(s, o.dmg, o.pos.x - o.vel.x, o.pos.z - o.vel.z);
      return false;
    }
    const a = s.ally;
    if (allyUp(s)) {
      const ay = Math.max(a.pos.y + 0.4, Math.min(a.pos.y + 1.7, o.pos.y));
      if (Math.hypot(o.pos.x - a.pos.x, o.pos.y - ay, o.pos.z - a.pos.z) < o.r + ALLY.radius) {
        hurtAlly(s, o.dmg);
        return false;
      }
    }
    return true;
  });
  if (s.stats.wipes === wipes) s.orbs = kept;
}

export function stepWaves(s: State) {
  const p = s.player;
  const wipes = s.stats.wipes;
  const kept = s.waves.filter((w) => {
    if (s.stats.wipes !== wipes) return false;
    w.r += TITAN.stompSpeed * TICK;
    const d = Math.hypot(p.pos.x - w.x, p.pos.z - w.z);
    if (!w.hit && Math.abs(d - w.r) < 0.9 && p.pos.y < w.y + TITAN.stompHeight) {
      w.hit = true;
      hurtPlayer(s, TITAN.stompDmg, w.x, w.z);
    }
    const a = s.ally;
    const da = Math.hypot(a.pos.x - w.x, a.pos.z - w.z);
    // The wave passes the teammate once. It never jumps, but standing up high clears the wave like the player.
    if (allyUp(s) && Math.abs(da - w.r) < 0.9 && a.pos.y < w.y + TITAN.stompHeight && !w.allyHit) {
      w.allyHit = true;
      hurtAlly(s, TITAN.stompDmg);
    }
    return w.r < TITAN.stompRange;
  });
  if (s.stats.wipes === wipes) s.waves = kept;
}

