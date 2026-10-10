import { CHARGER, ENEMIES, PLAYER, TICK, TITAN, WORLD, type EnemyKind } from "./config";
import { collide, groundAt, los, lookAngles, wrapAngle } from "./geom";

/** Walkers refuse to step off a ledge higher than this, so rooftop robots stay on their roof. */
const LEDGE = 1.0;
const bodyHeight = (k: { bodyY: number; radius: number }) => k.bodyY + k.radius;
import { POIS } from "./map";
import { bodyCenter, weakPoint } from "./combat";
import { hurtPlayer } from "./player";
import { rand, type Enemy, type State, type Vec3 } from "./state";

/*
 * Robot behaviour. Every attack follows the same readable rhythm:
 * move -> telegraph (eye glows, aim locks near the end) -> fire -> move.
 */

export function spawnEnemy(s: State, kind: EnemyKind, x: number, z: number, poi: number, floor = 0) {
  const k = ENEMIES[kind];
  const pos = { x, y: floor, z };
  collide(pos, k.radius, bodyHeight(k));
  pos.y = k.fly > 0 ? flyHeight(pos.x, pos.z) : groundAt(pos.x, pos.z, k.radius, floor + 0.3);
  const p = s.player;
  const e: Enemy = {
    id: s.nextId++,
    kind,
    pos,
    vel: { x: 0, y: 0, z: 0 },
    yaw: lookAngles(pos, p.pos).yaw,
    hp: k.hp,
    shield: k.shield,
    mode: "spawning",
    timer: kind === "titan" ? 2.2 : 0.9,
    cooldown: 0,
    shotsLeft: 0,
    strafe: rand(s) < 0.5 ? -1 : 1,
    poi,
    lastHit: 99,
    aimYaw: 0,
    aimPitch: 0,
    summoned: 0,
  };
  s.enemies.push(e);
  s.events.push({ t: "spawn", id: e.id, pos: { ...pos } });
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

function lockAim(s: State, e: Enemy) {
  const a = lookAngles(muzzle(e), chest(s));
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
  if (there < here - LEDGE) {
    // A drop ahead: stay on this floor.
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
  for (const e of [...s.enemies]) {
    const k = ENEMIES[e.kind];
    e.lastHit += TICK;
    if (e.mode === "spawning") {
      e.timer -= TICK;
      if (e.timer <= 0) {
        e.mode = "move";
        e.cooldown = k.cooldown * (0.4 + rand(s) * 0.5);
      }
      continue;
    }
    if (e.mode === "stunned") {
      e.timer -= TICK;
      moveBody(e, 0, 0);
      if (e.timer <= 0) {
        e.mode = "move";
        e.cooldown = Math.max(e.cooldown, 0.6);
      }
      continue;
    }
    const dx = p.pos.x - e.pos.x;
    const dz = p.pos.z - e.pos.z;
    const d = Math.hypot(dx, dz) || 1e-3;
    const toward = lookAngles(e.pos, p.pos).yaw;
    if (e.mode !== "lunge") e.yaw += wrapAngle(toward - e.yaw) * Math.min(1, TICK * (e.kind === "titan" ? 1.5 : 5));
    if (e.kind === "titan") {
      titan(s, e, d);
      continue;
    }
    switch (e.mode) {
      case "move": {
        const sees = los(muzzle(e), chest(s));
        const ux = dx / d;
        const uz = dz / d;
        let along = 0;
        if (!sees || d > k.range + 4) along = 1;
        else if (d < k.range - 4) along = -0.7;
        const side = sees || e.kind === "charger" ? 0.55 : 0.8;
        const vx = (ux * along - uz * e.strafe * side) * k.speed;
        const vz = (uz * along + ux * e.strafe * side) * k.speed;
        if (moveBody(e, vx, vz)) e.strafe = -e.strafe;
        else if (rand(s) < TICK * 0.35) e.strafe = -e.strafe;
        e.cooldown -= TICK;
        const ready = e.cooldown <= 0 && sees && p.downed <= 0;
        if (ready && (e.kind === "charger" ? d < CHARGER.lungeRange : d < 48)) {
          e.mode = "telegraph";
          e.timer = k.telegraph;
          lockAim(s, e);
          s.events.push({ t: "telegraph", id: e.id });
        }
        break;
      }
      case "telegraph": {
        moveBody(e, 0, 0);
        e.timer -= TICK;
        // Aim follows the player until the last 35% of the wind-up, then locks: moving dodges.
        if (e.timer > k.telegraph * 0.35) lockAim(s, e);
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
      if (d >= r || d < 1e-4) continue;
      const push = (r - d) / 2;
      a.pos.x -= (dx / d) * push;
      a.pos.z -= (dz / d) * push;
      b.pos.x += (dx / d) * push;
      b.pos.z += (dz / d) * push;
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
        spawnEnemy(s, "drone", e.pos.x + Math.sin(a) * 9, e.pos.z - Math.cos(a) * 9, e.poi);
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
          lockAim(s, e);
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
      lockAim(s, e);
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
        lockAim(s, e);
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
  s.orbs = s.orbs.filter((o) => {
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
    if (o.life <= 0 || o.pos.y < 0) return false;
    if (!los({ x: o.pos.x - o.vel.x * TICK, y: o.pos.y - o.vel.y * TICK, z: o.pos.z - o.vel.z * TICK }, o.pos)) return false;
    // Player as a vertical capsule from knee to head.
    const py = Math.max(p.pos.y + 0.4, Math.min(p.pos.y + (p.crouch || p.sliding ? 1.1 : 1.7), o.pos.y));
    if (Math.hypot(o.pos.x - p.pos.x, o.pos.y - py, o.pos.z - p.pos.z) < o.r + PLAYER.radius) {
      hurtPlayer(s, o.dmg, o.pos.x - o.vel.x, o.pos.z - o.vel.z);
      return false;
    }
    return true;
  });
}

export function stepWaves(s: State) {
  const p = s.player;
  s.waves = s.waves.filter((w) => {
    w.r += TITAN.stompSpeed * TICK;
    const d = Math.hypot(p.pos.x - w.x, p.pos.z - w.z);
    if (!w.hit && Math.abs(d - w.r) < 0.9 && p.pos.y < w.y + TITAN.stompHeight) {
      w.hit = true;
      hurtPlayer(s, TITAN.stompDmg, w.x, w.z);
    }
    return w.r < TITAN.stompRange;
  });
}

export function spawnWave(s: State) {
  const poi = POIS[s.poi];
  for (const sp of poi.waves[s.wave]) spawnEnemy(s, sp.kind, poi.x + sp.dx, poi.z + sp.dz, s.poi, sp.y ?? 0);
  s.wave++;
}
