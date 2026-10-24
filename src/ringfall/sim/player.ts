import { ALLY, ASSIST, CLIMB, DEG, HEALS, type HealKind, MANTLE, NOISE, PLAYER, RARITY, REVEAL, SEMI_HOLD, TACTICAL, TICK, ULT, WEAPONS, WORLD } from "./config";
import { makeNoise } from "./awareness";
import { modScale } from "./mods";
import { allyChest, allyUp, besidePlayer, placeAlly } from "./ally";
import { POIS } from "./map";
import { applyPull, assistTarget, bodyCenter, damageEnemy, eyePos, magSize, shoot } from "./combat";
import { boxTopAt, ceilingAt, collide, groundAt, los } from "./geom";
import { floorLevel, highGround, offLowGround, offshore, steepAt, terrainGrad, terrainHeight, towardLowGround } from "./terrain";
import { grabInAir, ride } from "./zips";
import type { Input, Player, State, Vec3 } from "./state";

/*
 * The player: movement (sprint, slide, jump, the ult's leap), weapons, abilities, and taking damage.
 */

export function stepPlayer(s: State, input: Input, prevCrouch: boolean) {
  const p = s.player;
  p.iframes = Math.max(0, p.iframes - TICK);
  p.sinceHurt += TICK;

  // Look, with slowdown near enemies and pull while aiming down sights.
  const near = p.downed > 0 ? null : assistTarget(s, ASSIST.slowCone);
  const sens = near ? ASSIST.slowdown : 1;
  p.yaw += input.lookX * sens;
  p.pitch = Math.max(-1.45, Math.min(1.45, p.pitch + input.lookY * sens));
  if (p.downed <= 0) applyPull(s, input.fire, input.touch);
  p.recoil *= Math.exp(-TICK / 0.12);
  p.recoilYaw *= Math.exp(-TICK / 0.12);

  if (p.downed > 0) {
    p.downed -= TICK;
    // Waiting for the teammate, who did not make it in time.
    if (p.downed <= 0 && p.awaitAlly) {
      // The raid is over: no move, shot or jump may follow in this tick.
      wipe(s);
      return;
    } else if (p.downed <= 0) {
      p.hp = PLAYER.reviveHp;
      p.iframes = PLAYER.reviveIframes;
      s.events.push({ t: "revive" });
    }
  } else if (p.sinceHurt > PLAYER.regenDelay && p.hp < PLAYER.regenCap) {
    p.hp = Math.min(PLAYER.regenCap, p.hp + PLAYER.regenPerSec * modScale(p, "mender") * TICK);
  }

  move(s, input, prevCrouch);
  clocks(s);
  // In the air on the leap the hands are on the glider: no shooting, items or abilities.
  if (p.downed <= 0 && !p.mantle && !p.leap) {
    weapons(s, input);
    abilities(s, input);
  }
}

/**
 * Starts a climb when the player is in the air, pushing forward, and facing a ledge
 * within reach whose top has room to stand. Over a thin wall the landing point is
 * past it, so the climb becomes a vault and the player drops down the far side.
 */
function tryMantle(s: State, input: Input): boolean {
  const p = s.player;
  if (p.onGround || p.downed > 0 || input.moveZ < 0.5 || p.vel.y > 3) return false;
  const fx = Math.sin(p.yaw);
  const fz = -Math.cos(p.yaw);
  const hx = p.pos.x + fx * (PLAYER.radius + MANTLE.probe);
  const hz = p.pos.z + fz * (PLAYER.radius + MANTLE.probe);
  const top = groundAt(hx, hz, 0.05, p.pos.y + MANTLE.reach - WORLD.stepUp);
  const rise = top - p.pos.y;
  if (rise <= WORLD.stepUp + 0.05) return false;
  // Room above the climber's head all the way up, and a body's room on top.
  if (ceilingAt(p.pos.x, p.pos.z, PLAYER.radius, top + 1.8, p.pos.y) < top + 1.8) return false;
  const to = { x: p.pos.x + fx * (PLAYER.radius + MANTLE.land), y: top, z: p.pos.z + fz * (PLAYER.radius + MANTLE.land) };
  const probe = { ...to };
  if (collide(probe, PLAYER.radius * 0.9) || Math.hypot(probe.x - to.x, probe.z - to.z) > 0.01) return false;
  p.mantle = { t: 0, dur: MANTLE.time * (0.4 + (0.6 * rise) / MANTLE.reach), from: { ...p.pos }, to, up: 0.65, climb: false };
  p.vel.x = p.vel.y = p.vel.z = 0;
  p.sliding = false;
  p.crouch = false;
  p.sprinting = false;
  s.events.push({ t: "mantle" });
  return true;
}

/**
 * Where a climb straight ahead of `pos` along (fx, fz) would come out: the first point past the
 * wall or cliff in front, within `CLIMB.look` metres, with room to stand on its top. Null when
 * nothing is in front within `CLIMB.touch`, when the face rises past `reach` above the feet, when
 * it is a fence (bars stop a body, and give no hold), or when its top is the crags' high ground or
 * past the coast, which no climb leaves the island by.
 */
export function ledgeAhead(pos: Vec3, fx: number, fz: number, reach = CLIMB.reach): Vec3 | null {
  const feet = pos.y;
  const limit = feet + reach;
  const r = PLAYER.radius;
  let face = -1;
  for (let d = r + 0.05; d <= r + CLIMB.look; d += 0.2) {
    const x = pos.x + fx * d;
    const z = pos.z + fz * d;
    if (terrainHeight(x, z) > limit + 0.05) return null;
    const g = groundAt(x, z, 0.05, limit - WORLD.stepUp);
    const wall = boxTopAt(x, z, feet + WORLD.stepUp, g + 1.75);
    if (wall.fence || wall.top > limit) return null;
    if (face < 0) {
      if (g <= feet + WORLD.stepUp + 0.05) {
        if (d > r + CLIMB.touch) return null;
        continue;
      }
      face = d;
    }
    if (g <= feet + WORLD.stepUp + 0.05) return null;
    if (standable(x, g, z) && clearOver(pos, x, g, z)) return { x, y: g, z };
  }
  return null;
}

/** Room for a body to stand at (x, y, z) on top of a climb: no wall, no roof, no cliff it would slide off, and not high ground. */
function standable(x: number, y: number, z: number): boolean {
  const onTerrain = Math.abs(terrainHeight(x, z) - y) < 0.05;
  if (onTerrain && (steepAt(x, z) || highGround(x, z) || offshore(x, z) > 0)) return false;
  const probe = { x, y, z };
  if (collide(probe, PLAYER.radius * 0.9) || Math.hypot(probe.x - x, probe.z - z) > 0.01) return false;
  return ceilingAt(x, z, PLAYER.radius, y + 1.8, y) >= y + 1.8;
}

/** Open air for the body to rise at `from` to `y`, and to go over onto (x, z). */
function clearOver(from: Vec3, x: number, y: number, z: number): boolean {
  if (ceilingAt(from.x, from.z, PLAYER.radius, y + 1.8, from.y) < y + 1.8) return false;
  return los({ x: from.x, y: y + 0.4, z: from.z }, { x, y: y + 0.4, z }) && los({ x: from.x, y: y + 1.5, z: from.z }, { x, y: y + 1.5, z });
}

/**
 * A climb: in the air pushing into a wall, or sprinting into one, whose top is within reach.
 * The body goes up the face hand over hand and over the top, faster the lower it is.
 */
function tryClimb(s: State, input: Input): boolean {
  const p = s.player;
  if (p.downed > 0 || input.noClimb || input.moveZ < 0.5) return false;
  if (p.onGround && !p.sprinting) return false;
  const fx = Math.sin(p.yaw);
  const fz = -Math.cos(p.yaw);
  const to = ledgeAhead(p.pos, fx, fz);
  if (!to) return false;
  const rise = to.y - p.pos.y;
  const upT = CLIMB.grip + Math.max(0, rise) / CLIMB.speed;
  p.mantle = { t: 0, dur: upT + CLIMB.over, from: { ...p.pos }, to, up: upT / (upT + CLIMB.over), climb: rise > MANTLE.reach };
  p.vel.x = p.vel.y = p.vel.z = 0;
  p.sliding = false;
  p.crouch = false;
  p.sprinting = false;
  s.events.push(p.mantle.climb ? { t: "climb", rise } : { t: "mantle" });
  return true;
}

/** Rise straight up for most of the climb, then over the edge onto the top. */
function stepMantle(s: State) {
  const p = s.player;
  const m = p.mantle;
  if (!m) return;
  m.t += TICK;
  const k = Math.min(1, m.t / m.dur);
  const wasUp = (m.t - TICK) / m.dur < m.up;
  const up = Math.min(1, k / m.up);
  const over = Math.max(0, (k - m.up) / (1 - m.up));
  if (m.climb && wasUp && k >= m.up) s.events.push({ t: "climbTop" });
  // A plain mantle is a heave that slows near the top; a climb goes hand over hand at one pace.
  const rise = m.climb ? up : 1 - (1 - up) * (1 - up);
  p.pos.y = m.from.y + (m.to.y + 0.02 - m.from.y) * rise;
  p.pos.x = m.from.x + (m.to.x - m.from.x) * over;
  p.pos.z = m.from.z + (m.to.z - m.from.z) * over;
  if (k >= 1) {
    p.mantle = null;
    p.pos.y = m.to.y;
    p.onGround = groundAt(p.pos.x, p.pos.z, PLAYER.radius, p.pos.y) >= p.pos.y - 0.02;
    const dx = m.to.x - m.from.x;
    const dz = m.to.z - m.from.z;
    const d = Math.hypot(dx, dz) || 1;
    p.vel.x = (dx / d) * MANTLE.exitSpeed;
    p.vel.z = (dz / d) * MANTLE.exitSpeed;
    p.vel.y = 0;
  }
}

function move(s: State, input: Input, prevCrouch: boolean) {
  const p = s.player;
  if (p.mantle) return stepMantle(s);
  const fx = Math.sin(p.yaw);
  const fz = -Math.cos(p.yaw);
  const rx = Math.cos(p.yaw);
  const rz = Math.sin(p.yaw);
  let wx = fx * input.moveZ + rx * input.moveX;
  let wz = fz * input.moveZ + rz * input.moveX;
  const wl = Math.hypot(wx, wz);
  if (wl > 1) {
    wx /= wl;
    wz /= wl;
  }
  if (p.leap) return glide(s, wx, wz);
  if (p.zip) return ride(s, input);
  grabInAir(s, input);
  if (p.zip || tryMantle(s, input) || tryClimb(s, input)) return;
  const speed = Math.hypot(p.vel.x, p.vel.z);
  p.jumpBuf = input.jump ? PLAYER.jumpBuffer : Math.max(0, p.jumpBuf - TICK);

  if (input.moveZ > 0.5 && !input.fire && p.ads < 0.1 && !p.healing) p.forwardHeld += TICK;
  else p.forwardHeld = 0;
  p.sprinting = p.onGround && !p.sliding && !input.crouch && p.downed <= 0 && p.forwardHeld > PLAYER.autoSprintAfter;
  // Running footsteps carry a little way; walking and crouching are silent.
  p.stepNoise -= TICK;
  if (p.sprinting && p.stepNoise <= 0) {
    p.stepNoise = 0.35;
    makeNoise(s, p.pos.x, p.pos.z, NOISE.sprintStep * modScale(p, "damper"));
  }

  if (input.crouch && !prevCrouch && p.onGround && !p.sliding && speed > PLAYER.walk + 0.3 && p.downed <= 0) {
    p.sliding = true;
    const k = Math.max(speed, PLAYER.slideStart) / Math.max(speed, 0.01);
    p.vel.x *= k;
    p.vel.z *= k;
    s.events.push({ t: "slide" });
    makeNoise(s, p.pos.x, p.pos.z, NOISE.slide);
  }
  p.crouch = input.crouch && !p.sliding;

  if (p.sliding) {
    // Sliding down a slope gathers speed; up one loses it.
    if (p.onGround && p.pos.y < terrainHeight(p.pos.x, p.pos.z) + 0.05) {
      const g = terrainGrad(p.pos.x, p.pos.z);
      p.vel.x -= g.x * WORLD.gravity * PLAYER.slideSlope * TICK;
      p.vel.z -= g.z * WORLD.gravity * PLAYER.slideSlope * TICK;
    }
    const sp = Math.hypot(p.vel.x, p.vel.z);
    const ns = Math.min(PLAYER.slideMax, Math.max(0, sp - PLAYER.slideFriction * TICK));
    if (sp > 0) {
      p.vel.x = (p.vel.x / sp) * ns + wx * 3 * TICK;
      p.vel.z = (p.vel.z / sp) * ns + wz * 3 * TICK;
    }
    if (ns < PLAYER.slideMin || !input.crouch || !p.onGround) {
      p.sliding = false;
      p.crouch = input.crouch && p.onGround;
    }
  } else {
    let top = p.downed > 0 ? 1.4 : (p.crouch ? PLAYER.crouch : p.sprinting ? PLAYER.sprint : PLAYER.walk) * modScale(p, "stride");
    if (p.ads > 0.5) top *= 0.75;
    if (p.healing) top *= 0.5;
    if (p.onGround) {
      // Faster than the top speed (out of a slide-jump or off a zipline) and still pushing that
      // way: the speed bleeds off over a moment rather than at once, so a jump or a slide on
      // landing keeps it. Pushing anywhere else turns it to the walk at once, as ever.
      const wl2 = Math.hypot(wx, wz);
      const along = speed > 0.01 && wl2 > 0.01 ? (p.vel.x * wx + p.vel.z * wz) / (speed * wl2) : 0;
      if (speed > Math.max(top, PLAYER.sprint) * wl2 + 0.05 && along > 0.7) top = Math.max(top * wl2, speed - PLAYER.overspeedDecel * TICK) / wl2;
      const tx = wx * top - p.vel.x;
      const tz = wz * top - p.vel.z;
      const tl = Math.hypot(tx, tz);
      const step = PLAYER.accel * TICK;
      if (tl <= step) {
        p.vel.x += tx;
        p.vel.z += tz;
      } else {
        p.vel.x += (tx / tl) * step;
        p.vel.z += (tz / tl) * step;
      }
    } else {
      // Air: steer, but never gain speed beyond the take-off speed (keeps slide-jump momentum).
      // A downed body (knocked out of the leap) just falls where it was going.
      const steer = p.downed > 0 ? 0 : PLAYER.airAccel;
      const cap = Math.max(speed, top);
      p.vel.x += wx * steer * TICK;
      p.vel.z += wz * steer * TICK;
      const ns = Math.hypot(p.vel.x, p.vel.z);
      if (ns > cap) {
        p.vel.x *= cap / ns;
        p.vel.z *= cap / ns;
      }
    }
  }

  if (p.onGround) p.airFrom = p.pos.y;
  if (p.jumpBuf > 0 && p.onGround && p.downed <= 0) {
    p.jumpBuf = 0;
    p.vel.y = PLAYER.jump;
    p.onGround = false;
    // Out of a slide the jump carries the slide on, a little faster (`slideJumpBoost`).
    if (p.sliding) {
      const sp = Math.hypot(p.vel.x, p.vel.z);
      const ns = Math.max(sp, Math.min(PLAYER.slideJumpMax, sp + PLAYER.slideJumpBoost));
      if (sp > 0.01) {
        p.vel.x *= ns / sp;
        p.vel.z *= ns / sp;
      }
      s.events.push({ t: "slideJump", speed: ns });
    }
    p.sliding = false;
    s.events.push({ t: "jump" });
  }

  const wasOnGround = p.onGround;
  const from = { x: p.pos.x, y: p.pos.y, z: p.pos.z };
  p.vel.y -= WORLD.gravity * TICK;
  p.pos.x += p.vel.x * TICK;
  p.pos.z += p.vel.z * TICK;
  // Robots are solid too. Walls go last so a robot cannot shove the player into one.
  for (const e of s.enemies) {
    if (e.pos.y > p.pos.y + 1.6 || e.pos.y + 2 < p.pos.y) continue;
    const r = PLAYER.radius + Math.min(1.2, e.kind === "titan" ? 2 : 0.5);
    const dx = p.pos.x - e.pos.x;
    const dz = p.pos.z - e.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < r && d > 1e-4) {
      p.pos.x = e.pos.x + (dx / d) * r;
      p.pos.z = e.pos.z + (dz / d) * r;
    }
  }
  collide(p.pos, PLAYER.radius);
  // A cliff's face above the feet is a wall: on foot the body never rises onto it (`collide()`
  // lets it stand a hair over its feet, and running along a face that rises would gain that hair
  // every step), so it stays where it stood.
  // A step blocked so slides along the face on one axis when that one is clear.
  const ontoFace = (x: number, z: number) => terrainHeight(x, z) > from.y + 0.005 && steepAt(x, z) && boxTopAt(x, z, from.y - 0.5, from.y + WORLD.stepUp).top < terrainHeight(x, z) - 0.05;
  if (wasOnGround && ontoFace(p.pos.x, p.pos.z)) {
    const [x, z] = !ontoFace(p.pos.x, from.z) ? [p.pos.x, from.z] : !ontoFace(from.x, p.pos.z) ? [from.x, p.pos.z] : [from.x, from.z];
    p.pos.x = x;
    p.pos.z = z;
  }
  // In the air a cliff's face above the ground jumped from is a wall, as it is on foot: hop after
  // hop would otherwise land a little higher up the face each time, up the crags too.
  if (!p.onGround) offFace(p.pos, p.airFrom + 0.05);
  p.pos.y += p.vel.y * TICK;
  // Bump the head on floors and roofs above.
  if (p.vel.y > 0) {
    const c = ceilingAt(p.pos.x, p.pos.z, PLAYER.radius, p.pos.y + 1.75, p.pos.y - p.vel.y * TICK);
    if (p.pos.y + 1.75 > c) {
      p.pos.y = c - 1.75;
      p.vel.y = 0;
    }
  }
  const g = groundAt(p.pos.x, p.pos.z, PLAYER.radius, Math.max(p.pos.y, p.pos.y - p.vel.y * TICK));
  if (p.pos.y <= g) {
    if (!p.onGround && p.vel.y < -5) s.events.push({ t: "land", speed: -p.vel.y });
    // Landing with the crouch held at speed slides on, keeping the air's speed.
    if (!p.onGround && input.crouch && p.downed <= 0 && Math.hypot(p.vel.x, p.vel.z) > PLAYER.walk + 0.3) {
      p.sliding = true;
      p.crouch = false;
      s.events.push({ t: "slide", chain: true });
    }
    if (!p.onGround && p.zipFall) {
      p.zipFall = false;
      besidePlayer(s);
    }
    p.pos.y = g;
    p.vel.y = 0;
    p.onGround = true;
  } else if (wasOnGround && p.vel.y <= 0 && p.pos.y - g < 0.45) {
    // Keep the feet on the ground walking down a slope or a step.
    p.pos.y = g;
    p.vel.y = 0;
  } else if (p.pos.y > g + 0.02) {
    p.onGround = false;
  }
}

/**
 * Moves a body in the air back down a cliff's face until the ground under it is no higher than
 * `top`. Over something built (stairs bolted to the face) the face is not what it lands on.
 */
function offFace(q: Vec3, top: number) {
  for (let k = 0; k < 16; k++) {
    if (terrainHeight(q.x, q.z) <= top || !steepAt(q.x, q.z)) return;
    if (boxTopAt(q.x, q.z, q.y - 3, q.y + 0.5).top > terrainHeight(q.x, q.z) - 0.5) return;
    const g = terrainGrad(q.x, q.z);
    const l = Math.hypot(g.x, g.z) || 1;
    q.x -= (g.x / l) * 0.12;
    q.z -= (g.z / l) * 0.12;
  }
}

function weapons(s: State, input: Input) {
  const p = s.player;
  const other = 1 - p.slot;
  const want = input.slot >= 0 ? input.slot : input.swap ? other : p.slot;
  if (want !== p.slot && p.weapons[want]) {
    p.slot = want;
    p.reload = 0;
    p.cooldown = 0.28;
  }
  const w = p.weapons[p.slot];
  if (!w) return;
  const spec = WEAPONS[w.kind];
  const size = magSize(w);
  if (w.mag < 0) w.mag = size;
  p.ads += ((input.ads && !p.healing ? 1 : 0) - p.ads) * Math.min(1, TICK / 0.08);

  if (p.reload > 0) {
    p.reload -= TICK;
    if (p.reload <= 0) {
      p.reload = 0;
      w.mag = size;
      s.events.push({ t: "reloaded" });
    }
  }
  const startReload = () => {
    if (p.reload > 0 || w.mag >= size) return;
    p.reload = spec.reload * RARITY.reload[w.rarity] * modScale(p, "grip");
    s.events.push({ t: "reload", time: p.reload });
  };
  if (input.reload) startReload();

  if (input.fire && p.healing) {
    p.healing = null; // shooting cancels the item without using it
  }
  // Semi-auto weapons also repeat while held, a little slower than clicking.
  const canFire = input.fire && p.cooldown <= 0 && p.reload <= 0 && !p.healing;
  if (canFire) {
    if (w.mag <= 0) {
      if (!p.triggerHeld) s.events.push({ t: "dry" });
      startReload();
    } else {
      // Spend the round first: a kill with a gold weapon refills the magazine inside shoot().
      w.mag--;
      shoot(s, w, input.touch);
      const held = !spec.auto && p.triggerHeld ? SEMI_HOLD : 1;
      p.cooldown = spec.interval * held;
      if (w.mag <= 0) startReload();
    }
  }
  p.triggerHeld = input.fire;
}

/** The ult: straight up into the sky, if there is open sky above. */
function leap(s: State) {
  const p = s.player;
  const top = p.pos.y + ULT.headroom;
  if (ceilingAt(p.pos.x, p.pos.z, PLAYER.radius, top, p.pos.y) < top) {
    s.events.push({ t: "leapBlocked" });
    return;
  }
  p.ult = 0;
  // Only a teammate on the same floor and in sight comes along: never one through a floor or a wall.
  const a = s.ally;
  const carry = allyUp(s) && Math.hypot(a.pos.x - p.pos.x, a.pos.z - p.pos.z) < ULT.carry && Math.abs(a.pos.y - p.pos.y) < 1.5 && los(eyePos(s), allyChest(a));
  p.leap = { carry };
  p.vel.y = ULT.rise;
  p.onGround = false;
  p.sliding = false;
  p.crouch = false;
  p.sprinting = false;
  p.healing = null;
  p.search = null;
  p.reload = 0; // the hands let go of the magazine for the glider
  p.ads = 0;
  makeNoise(s, p.pos.x, p.pos.z, NOISE.leap);
  s.events.push({ t: "leap" });
}

/**
 * High ground at (x, z) that a glider at height y is about to touch: above the level
 * round it, and less than 3 m under the glider. Ground falling away below it, like the
 * dam's face, does not count: dropping down is always allowed.
 */
function risesInto(x: number, z: number, y: number): boolean {
  if (!offLowGround(x, z)) return false;
  const t = terrainHeight(x, z);
  return t > floorLevel(x, z) + 1.5 && t > y - 3;
}

/**
 * The flight after the leap: up on the launch speed, then a slow glide down, steered
 * at glide speed and keeping its way with no input. Over high ground the wind holds
 * the glider up and takes it on toward walkable ground, so the leap never lands where
 * no road leads.
 */
function glide(s: State, wx: number, wz: number) {
  const p = s.player;
  const over = offLowGround(p.pos.x, p.pos.z);
  if (over) {
    const to = towardLowGround(p.pos.x, p.pos.z);
    wx = to.x;
    wz = to.z;
  } else {
    // High ground just ahead: the wind takes away the way into it, steering and speed both,
    // so the glider slides along its edge instead of in and back out again.
    const ax = p.pos.x + p.vel.x * ULT.edgeLook;
    const az = p.pos.z + p.vel.z * ULT.edgeLook;
    if (risesInto(ax, az, p.pos.y)) {
      const to = towardLowGround(ax, az);
      const w = wx * to.x + wz * to.z;
      if (w < 0) {
        wx -= w * to.x;
        wz -= w * to.z;
      }
      const v = p.vel.x * to.x + p.vel.z * to.z;
      if (v < 0) {
        p.vel.x -= v * to.x;
        p.vel.z -= v * to.z;
      }
    }
  }
  if (Math.hypot(wx, wz) > 0.1) {
    const tx = wx * ULT.glide - p.vel.x;
    const tz = wz * ULT.glide - p.vel.z;
    const tl = Math.hypot(tx, tz);
    const step = Math.min(tl, ULT.glideAccel * TICK);
    if (tl > 1e-6) {
      p.vel.x += (tx / tl) * step;
      p.vel.z += (tz / tl) * step;
    }
  }
  p.vel.y = Math.max(-ULT.fall, p.vel.y - WORLD.gravity * TICK);
  // Over high ground the wind also holds the glider up.
  if (risesInto(p.pos.x, p.pos.z, p.pos.y)) p.vel.y = Math.max(0, p.vel.y);
  const was = { x: p.pos.x, z: p.pos.z };
  p.pos.x += p.vel.x * TICK;
  p.pos.z += p.vel.z * TICK;
  collide(p.pos, PLAYER.radius);
  // It comes down only under open sky, as it went up: never in through a window or under a
  // balcony, onto a floor with no way down but the stairs. It slides down outside instead.
  const roof = p.pos.y + ULT.headroom;
  if (ceilingAt(p.pos.x, p.pos.z, PLAYER.radius, roof, p.pos.y) < roof) {
    p.pos.x = was.x;
    p.pos.z = was.z;
    p.vel.x = p.vel.z = 0;
  }
  const from = p.pos.y;
  p.pos.y += p.vel.y * TICK;
  if (p.vel.y > 0) {
    const c = ceilingAt(p.pos.x, p.pos.z, PLAYER.radius, p.pos.y + 1.75, from);
    if (p.pos.y + 1.75 > c) {
      p.pos.y = c - 1.75;
      p.vel.y = 0;
    }
  }
  const g = groundAt(p.pos.x, p.pos.z, PLAYER.radius, Math.max(p.pos.y, from));
  if (p.pos.y > g) return;
  p.pos.y = g;
  p.vel.y = 0;
  p.onGround = true;
  const carry = p.leap?.carry;
  p.leap = null;
  if (carry) besidePlayer(s);
  s.events.push({ t: "leapLand" }, { t: "land", speed: ULT.fall });
}

/**
 * Cooldowns and the ult's charge run on time, whatever the hands are doing: they
 * count down through a glide, a climb or being downed just as they do on foot.
 */
function clocks(s: State) {
  const p = s.player;
  p.cooldown = Math.max(0, p.cooldown - TICK);
  p.zipRegrip = Math.max(0, p.zipRegrip - TICK);
  p.tactical = Math.max(0, p.tactical - TICK);
  if (p.ult < 1 && !p.leap) {
    p.ult = Math.min(1, p.ult + ULT.perSec * modScale(p, "surge") * TICK);
    if (p.ult >= 1) s.events.push({ t: "ultReady" });
  }
}

/** Seconds the arc takes to come back: sooner with the capacitor worn. */
export const tacticalCooldown = (p: Pick<Player, "mods">) => TACTICAL.cooldown * modScale(p, "capacitor");

/** Seconds a heal of `kind` takes: shorter with the patch worn. */
export const healTime = (p: Pick<Player, "mods">, kind: HealKind) => HEALS[kind].time * modScale(p, "medic");

function abilities(s: State, input: Input) {
  const p = s.player;
  if (input.tactical && p.tactical <= 0) {
    const eye = eyePos(s);
    const fx = Math.sin(p.yaw);
    const fz = -Math.cos(p.yaw);
    const targets = s.enemies
      .filter((e) => e.mode !== "spawning")
      .map((e) => ({ e, c: bodyCenter(e) }))
      .filter(({ c }) => {
        const dx = c.x - eye.x;
        const dz = c.z - eye.z;
        const d = Math.hypot(dx, dz);
        return d < TACTICAL.range && (dx * fx + dz * fz) / Math.max(d, 1e-3) > Math.cos((TACTICAL.cone / 2) * DEG);
      })
      .filter(({ c }) => los(eye, c))
      .sort((a, b) => Math.hypot(a.c.x - eye.x, a.c.z - eye.z) - Math.hypot(b.c.x - eye.x, b.c.z - eye.z))
      .slice(0, TACTICAL.maxTargets);
    // The arc also shows every robot nearby through walls for a few seconds.
    p.reveal = REVEAL.time;
    makeNoise(s, p.pos.x, p.pos.z, NOISE.arc);
    if (!targets.length) {
      p.tactical = tacticalCooldown(p) * 0.5;
      s.events.push({ t: "tacticalMiss" });
    } else {
      p.tactical = tacticalCooldown(p);
      s.events.push({ t: "tactical", targets: targets.map((t) => t.c) });
      for (const { e, c } of targets) {
        if (e.kind !== "titan") {
          e.mode = "stunned";
          e.timer = TACTICAL.stun;
        }
        damageEnemy(s, e, TACTICAL.dmg, false, c);
      }
    }
  }

  if (input.ult && p.ult >= 1) {
    leap(s);
    // The hands are on the glider from this tick: no item starts with the leap.
    if (p.leap) return;
  }

  const h = p.healing;
  if (h) {
    h.t -= TICK;
    if (h.t <= 0) {
      p.healing = null;
      const spec = HEALS[h.kind];
      if (spec.shield) p.shield = spec.amount ? Math.min(maxShieldOf(s), p.shield + spec.amount) : maxShieldOf(s);
      else p.hp = spec.amount ? Math.min(PLAYER.hp, p.hp + spec.amount) : PLAYER.hp;
      p.heals[h.kind]--;
      if (p.lentHeals[h.kind] > 0) p.lentHeals[h.kind]--;
      s.events.push({ t: "healDone", kind: h.kind });
    }
  } else if (input.heal) {
    const kind = pickHeal(s);
    if (kind) {
      p.healing = { kind, t: healTime(p, kind) };
      p.reload = 0;
      s.events.push({ t: "healStart", kind });
      makeNoise(s, p.pos.x, p.pos.z, NOISE.heal);
    }
  }
}

const maxShieldOf = (s: State) => PLAYER.shieldByTier[s.player.armor];

/**
 * The item one press of the heal key uses. Whichever of shield and health is
 * missing more goes first (shield on a tie, since it breaks first); a big gap
 * takes the big item, a small one the small item, and either stands in for the
 * other when it has run out. Null when nothing is missing or nothing fits.
 */
export function pickHeal(s: State): HealKind | null {
  const p = s.player;
  const shieldGap = maxShieldOf(s) - p.shield;
  const hpGap = PLAYER.hp - p.hp;
  const order: [number, HealKind, HealKind][] = [
    [shieldGap, "battery", "cell"],
    [hpGap, "medkit", "syringe"],
  ];
  if (hpGap > shieldGap) order.reverse();
  for (const [gap, big, small] of order) {
    if (gap < 1) continue;
    const prefer: HealKind[] = gap > HEALS[small].amount * 1.6 ? [big, small] : [small, big];
    for (const k of prefer) if (p.heals[k] > 0) return k;
  }
  return null;
}

export function tickReveal(s: State) {
  s.player.reveal = Math.max(0, s.player.reveal - TICK);
}

export function hurtPlayer(s: State, dmg: number, fromX: number, fromZ: number) {
  const p = s.player;
  if (s.phase !== "play") return;
  if (p.downed > 0 || p.iframes > 0) return;
  p.sinceHurt = 0;
  const hadShield = p.shield > 0;
  const toShield = Math.min(p.shield, dmg);
  p.shield -= toShield;
  p.hp -= dmg - toShield;
  s.events.push({ t: "hurt", dmg, fromX, fromZ, shieldBroke: hadShield && p.shield <= 0, shield: toShield > 0 });
  if (p.hp > 0) return;
  p.hp = 0;
  p.healing = null;
  p.mantle = null; // a downed player lets go of the ledge
  p.zip = null; // and of a cable, and falls
  p.zipFall = false;
  p.leap = null; // and of the glider: it falls, and a carried teammate falls free beside it
  p.reload = 0;
  s.stats.downs++;
  if (p.selfRevive > 0) {
    p.selfRevive--;
    p.downed = PLAYER.downedTime;
    s.events.push({ t: "down" });
  } else if (allyUp(s)) {
    // No self-revive left, but the teammate can come and pick the player up.
    p.downed = ALLY.bleedout;
    p.awaitAlly = true;
    s.events.push({ t: "down" }, { t: "awaitAlly" });
  } else wipe(s);
}

/**
 * Everyone down: the raid is lost, and everything carried with it. The air is
 * cleared so nothing still in flight lands after the end.
 */
export function wipe(s: State) {
  s.stats.wipes++;
  s.orbs = [];
  s.waves = [];
  s.phase = "done";
  s.outcome = "dead";
  s.events.push({ t: "wipe" }, { t: "done" });
}
