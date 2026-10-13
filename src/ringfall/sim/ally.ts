import { ALLY, ENEMIES, PLAYER, TICK, WORLD } from "./config";
import { makeNoise } from "./awareness";
import { bodyCenter, damageEnemy, weakPoint } from "./combat";
import { collide, dist2d, groundAt, los, lookAngles, wrapAngle } from "./geom";
import { wipe } from "./player";
import { rand, type Ally, type Enemy, type State, type Vec3 } from "./state";

/*
 * The teammate. It has no map knowledge of its own: it walks the footsteps the
 * player left (State.trail), so it goes wherever the player went, stairs and
 * climbs included, and moves up behind the player when it falls too far back.
 * It fights only robots that are already fighting, picks the player up when the
 * player has no self-revive left, and goes down like the player does.
 */

const EYE = 1.5;
const HEIGHT = 1.75;

export const allyUp = (s: State) => s.ally.active && s.ally.down <= 0;
export const allyChest = (a: Ally): Vec3 => ({ x: a.pos.x, y: a.pos.y + (a.down > 0 ? 0.4 : 1.1), z: a.pos.z });
const allyEye = (a: Ally): Vec3 => ({ x: a.pos.x, y: a.pos.y + EYE, z: a.pos.z });

/** Put the teammate on the ground beside the player (on landing). */
export function placeAlly(s: State) {
  const a = s.ally;
  a.active = true;
  besidePlayer(s);
  a.hp = ALLY.hp;
  a.shield = ALLY.shield;
  a.down = 0;
  a.helped = 0;
  a.rescue = 0;
  a.target = 0;
}

/**
 * Stand the teammate on the ground beside the player and start its footsteps afresh:
 * after the drop, and after the ult's leap when it came along. Its health stays as it is.
 */
export function besidePlayer(s: State) {
  const a = s.ally;
  const p = s.player;
  a.pos = { ...p.pos };
  for (const side of [1, -1]) {
    const x = p.pos.x + Math.cos(p.yaw) * 1.8 * side - Math.sin(p.yaw) * 1.2;
    const z = p.pos.z + Math.sin(p.yaw) * 1.8 * side + Math.cos(p.yaw) * 1.2;
    const g = groundAt(x, z, ALLY.radius, p.pos.y + 0.3);
    const probe = { x, y: g, z };
    if (Math.abs(g - p.pos.y) < 0.5 && !collide(probe, ALLY.radius, HEIGHT) && los(allyEye({ ...a, pos: probe }), { ...p.pos, y: p.pos.y + EYE })) {
      a.pos = probe;
      break;
    }
  }
  a.vel = { x: 0, y: 0, z: 0 };
  a.yaw = p.yaw;
  a.climb = 0;
  a.stuckT = 0;
  a.last = { x: a.pos.x, z: a.pos.z };
  s.trail = [{ ...p.pos }];
  a.crumb = 0;
}

/** Drop a footstep where the player stands on the ground. */
function recordTrail(s: State) {
  const p = s.player;
  if (!p.onGround || p.downed > 0 || p.mantle) return;
  const last = s.trail[s.trail.length - 1];
  if (last && Math.hypot(last.x - p.pos.x, last.y - p.pos.y, last.z - p.pos.z) < 1) return;
  s.trail.push({ ...p.pos });
  if (s.trail.length > 240) {
    s.trail.shift();
    s.ally.crumb = Math.max(0, s.ally.crumb - 1);
  }
}

export function hurtAlly(s: State, dmg: number) {
  const a = s.ally;
  if (!allyUp(s) || s.phase !== "play") return;
  a.sinceHurt = 0;
  const toShield = Math.min(a.shield, dmg);
  a.shield -= toShield;
  a.hp -= dmg - toShield;
  s.events.push({ t: "allyHurt", dmg });
  if (a.hp > 0) return;
  a.hp = 0;
  a.down = ALLY.selfUp;
  a.helped = 0;
  a.rescue = 0;
  a.target = 0;
  a.climb = 0;
  s.stats.allyDowns++;
  s.events.push({ t: "allyDown" });
  // The player was waiting for this teammate: nobody is left to help.
  if (s.player.awaitAlly && s.player.downed > 0) wipe(s);
}

/** The teammate stands up (revived by the player, on its own, or when the objective falls). */
export function raiseAlly(s: State, by: "player" | "self", hp: number) {
  const a = s.ally;
  // Down means a running timer or, on the tick it runs out, a body still at 0 health.
  if (a.down <= 0 && a.hp > 0) return;
  a.down = 0;
  a.helped = 0;
  a.hp = hp;
  a.shield = 0;
  a.sinceHurt = 0;
  if (by === "player") s.stats.allyHelped++;
  s.events.push({ t: "allyUp", by });
}

/** The player starts picking the teammate up (the use key next to it). */
export function startHelp(s: State) {
  if (s.ally.down > 0 && s.ally.helped <= 0) s.ally.helped = TICK;
}

export function stepAlly(s: State) {
  const a = s.ally;
  if (!a.active) return;
  const p = s.player;
  // Carried on the player's leap: it flies alongside and lands with them (see besidePlayer).
  if (p.leap?.carry) {
    a.pos = { x: p.pos.x - Math.cos(p.yaw) * 1.6, y: p.pos.y, z: p.pos.z - Math.sin(p.yaw) * 1.6 };
    a.vel = { x: 0, y: 0, z: 0 };
    return;
  }
  recordTrail(s);
  a.sinceHurt += TICK;
  if (a.down > 0) {
    a.vel.x = a.vel.z = 0;
    fall(a);
    a.down -= TICK;
    // The player's help continues while they stay beside it and keep their hands free.
    if (a.helped > 0) {
      const beside = dist2d(a.pos, p.pos) < PLAYER.interactRange + 0.6 && Math.abs(a.pos.y - p.pos.y) < 1.5;
      if (beside && p.downed <= 0 && !p.triggerHeld && !p.healing) a.helped += TICK;
      else a.helped = 0;
      if (a.helped >= ALLY.helpTime) raiseAlly(s, "player", ALLY.reviveHp);
    }
    if (a.down <= 0) raiseAlly(s, "self", 40);
    return;
  }
  if (a.sinceHurt > ALLY.regenDelay) {
    a.shield = Math.min(ALLY.shield, a.shield + ALLY.shieldRegen * TICK);
    if (a.shield >= ALLY.shield) a.hp = Math.min(ALLY.hp, a.hp + ALLY.hpRegen * TICK);
  }
  // Picking the player up comes before everything else.
  if (p.downed > 0 && p.awaitAlly) {
    a.target = 0;
    const d = dist2d(a.pos, p.pos);
    if (d < 1.6 && Math.abs(a.pos.y - p.pos.y) < 1.2) {
      move(a, 0, 0);
      turn(a, lookAngles(a.pos, p.pos).yaw);
      a.rescue += TICK;
      if (a.rescue >= ALLY.reviveTime) {
        a.rescue = 0;
        p.downed = 0;
        p.awaitAlly = false;
        p.hp = PLAYER.reviveHp;
        p.iframes = PLAYER.reviveIframes;
        s.stats.allyRescues++;
        s.events.push({ t: "allyRescue" }, { t: "revive" });
      }
      return;
    }
    a.rescue = 0;
    follow(s, 0.5, true);
    return;
  }
  a.rescue = 0;
  fight(s);
  follow(s, ALLY.follow, false);
}

/** Choose a robot and shoot it in bursts. */
function fight(s: State) {
  const a = s.ally;
  a.pickT -= TICK;
  a.cooldown -= TICK;
  let tgt = a.target ? s.enemies.find((e) => e.id === a.target) : undefined;
  if (a.pickT <= 0 || !tgt) {
    a.pickT = 0.4;
    tgt = pick(s, tgt);
    a.target = tgt?.id ?? 0;
  }
  if (!tgt) {
    a.shots = 0;
    return;
  }
  const eye = allyEye(a);
  const aim = lookAngles(eye, bodyCenter(tgt));
  turn(a, aim.yaw);
  a.pitch = aim.pitch;
  if (a.cooldown > 0 || Math.abs(wrapAngle(aim.yaw - a.yaw)) > 0.2) return;
  if (!los(eye, bodyCenter(tgt))) {
    a.pickT = 0;
    return;
  }
  if (a.shots <= 0) a.shots = ALLY.burst;
  shootAt(s, tgt);
  a.shots--;
  a.cooldown = a.shots > 0 ? ALLY.interval : ALLY.pause[0] + rand(s) * (ALLY.pause[1] - ALLY.pause[0]);
}

/**
 * Robots already fighting, in sight and range. Those shooting at the teammate come
 * first, then the one the player is shooting, then the nearest; the current target
 * keeps a small edge so it does not flick between two.
 */
function pick(s: State, current: Enemy | undefined): Enemy | undefined {
  const a = s.ally;
  const eye = allyEye(a);
  let best: Enemy | undefined;
  let bestScore = Infinity;
  for (const e of s.enemies) {
    if (e.mode === "spawning" || e.aware !== "engaged") continue;
    const d = dist2d(e.pos, a.pos);
    if (d > ALLY.range) continue;
    const score = d - (e.target === "ally" ? 10 : 0) - (e.lastHit < 1.5 ? 8 : 0) - (e === current ? 4 : 0);
    if (score >= bestScore || !los(eye, bodyCenter(e))) continue;
    best = e;
    bestScore = score;
  }
  return best;
}

function shootAt(s: State, e: Enemy) {
  const a = s.ally;
  const from = { x: a.pos.x + Math.sin(a.yaw) * 0.4, y: a.pos.y + 1.35, z: a.pos.z - Math.cos(a.yaw) * 0.4 };
  const d = dist2d(e.pos, a.pos);
  const chance = ALLY.hitNear + (ALLY.hitFar - ALLY.hitNear) * Math.min(1, d / ALLY.range);
  if (rand(s) < chance) {
    const crit = rand(s) < ALLY.crit;
    const at = crit ? weakPoint(e) : bodyCenter(e);
    s.events.push({ t: "allyShot", from, to: at, hit: true });
    damageEnemy(s, e, ALLY.dmg * (crit ? ALLY.critMult : 1), crit, at, "none", "ally");
  } else {
    const c = bodyCenter(e);
    const r = ENEMIES[e.kind].radius + 0.6;
    const off = (rand(s) - 0.5) * 2 * r;
    s.events.push({ t: "allyShot", from, to: { x: c.x + Math.cos(a.yaw) * off, y: c.y + (rand(s) - 0.4) * r, z: c.z + Math.sin(a.yaw) * off }, hit: false });
  }
  makeNoise(s, a.pos.x, a.pos.z, ALLY.noise, true);
}

/**
 * Walk the player's footsteps until `keep` metres from the player (with them in
 * sight). Cut corners when a later footstep is in plain view, and move up behind
 * the player when far behind or stuck.
 */
function follow(s: State, keep: number, rush: boolean) {
  const a = s.ally;
  const p = s.player;
  const trail = s.trail;
  const toPlayer = dist2d(a.pos, p.pos);
  const level = Math.abs(a.pos.y - p.pos.y) < 1.2;
  const close = toPlayer < keep && level && los(allyEye(a), { ...p.pos, y: p.pos.y + EYE });
  if (toPlayer > ALLY.catchUp || a.stuckT > ALLY.stuckTime) return catchUp(s);
  a.shortcutT -= TICK;
  if (a.shortcutT <= 0) {
    a.shortcutT = 0.3;
    // The furthest footstep ahead that is in plain view on the same level.
    for (let j = trail.length - 1; j > a.crumb && j >= trail.length - 30; j--) {
      const c = trail[j];
      if (dist2d(c, a.pos) > 14 || Math.abs(c.y - a.pos.y) > 0.6) continue;
      if (los({ ...a.pos, y: a.pos.y + 0.5 }, { ...c, y: c.y + 0.5 }) && los({ ...a.pos, y: a.pos.y + 1.2 }, { ...c, y: c.y + 1.2 })) {
        a.crumb = j;
        break;
      }
    }
  }
  while (a.crumb < trail.length - 1 && dist2d(trail[a.crumb], a.pos) < 0.7 && Math.abs(trail[a.crumb].y - a.pos.y) < 1.2) a.crumb++;
  const c = trail[Math.min(a.crumb, trail.length - 1)];
  if (close || !c) {
    move(a, 0, 0);
    if (!a.target) turn(a, p.yaw);
    a.stuckT = 0;
    a.last = { x: a.pos.x, z: a.pos.z };
    return;
  }
  // The last footstep is where the player stands: walk to them directly from there.
  const to = a.crumb >= trail.length - 1 && level ? p.pos : c;
  const dx = to.x - a.pos.x;
  const dz = to.z - a.pos.z;
  const d = Math.hypot(dx, dz) || 1;
  const speed = rush || toPlayer > 10 ? ALLY.run : ALLY.walk;
  if (!a.target) turn(a, Math.atan2(dx, -dz));
  // A footstep up a ledge the player climbed: climb it.
  if (to.y > a.pos.y + WORLD.stepUp && d < 1.6) a.climb = Math.max(a.climb, 0.15);
  if (a.climb > 0) {
    a.climb -= TICK;
    a.pos.y = Math.min(to.y + 0.02, a.pos.y + 6 * TICK);
  }
  move(a, (dx / d) * speed, (dz / d) * speed);
  // Stuck: hardly moved in a while though it is trying to.
  if (dist2d(a.pos, a.last) > 1) {
    a.last = { x: a.pos.x, z: a.pos.z };
    a.stuckT = 0;
  } else a.stuckT += TICK;
}

/** Move up to a footstep a few metres behind the player. */
function catchUp(s: State) {
  const a = s.ally;
  const trail = s.trail;
  let j = trail.length - 1;
  let len = 0;
  while (j > 0 && len < 4) {
    len += Math.hypot(trail[j].x - trail[j - 1].x, trail[j].z - trail[j - 1].z);
    j--;
  }
  const c = trail[j] ?? s.player.pos;
  a.pos = { ...c };
  a.vel = { x: 0, y: 0, z: 0 };
  a.crumb = Math.min(trail.length - 1, j + 1);
  a.stuckT = 0;
  a.climb = 0;
  a.last = { x: a.pos.x, z: a.pos.z };
}

function turn(a: Ally, yaw: number) {
  const diff = wrapAngle(yaw - a.yaw);
  const max = ALLY.turn * TICK;
  a.yaw += Math.max(-max, Math.min(max, diff));
}

function move(a: Ally, vx: number, vz: number) {
  a.vel.x += (vx - a.vel.x) * Math.min(1, TICK * 10);
  a.vel.z += (vz - a.vel.z) * Math.min(1, TICK * 10);
  a.pos.x += a.vel.x * TICK;
  a.pos.z += a.vel.z * TICK;
  collide(a.pos, ALLY.radius, HEIGHT);
  if (a.climb <= 0) fall(a);
}

/** Step up at once, fall with gravity. */
function fall(a: Ally) {
  const g = groundAt(a.pos.x, a.pos.z, ALLY.radius, a.pos.y);
  if (g >= a.pos.y) {
    a.pos.y = g;
    a.vel.y = 0;
    return;
  }
  a.vel.y -= WORLD.gravity * TICK;
  a.pos.y = Math.max(g, a.pos.y + a.vel.y * TICK);
  if (a.pos.y === g) a.vel.y = 0;
}
