import { ALLY, ASSIST, DEG, DROP, HEALS, type HealKind, MANTLE, NOISE, PLAYER, RARITY, REVEAL, SEMI_HOLD, TACTICAL, TICK, ULT, WEAPONS, WORLD } from "./config";
import { makeNoise } from "./awareness";
import { allyUp, placeAlly } from "./ally";
import { POIS } from "./map";
import { applyPull, assistTarget, bodyCenter, damageEnemy, eyePos, magSize, shoot } from "./combat";
import { ceilingAt, collide, groundAt, los } from "./geom";
import { offLowGround, terrainGrad, terrainHeight, towardLowGround } from "./terrain";
import type { Input, State } from "./state";

/*
 * The player: drop, movement (sprint, slide, jump), weapons, abilities, and taking damage.
 */

/** Returns true on the tick the player touches the ground. */
export function stepDrop(s: State, input: Input): boolean {
  const p = s.player;
  p.yaw += input.lookX;
  p.pitch = Math.max(-1.45, Math.min(1.2, p.pitch + input.lookY));
  const fx = Math.sin(p.yaw);
  const fz = -Math.cos(p.yaw);
  p.pos.y -= DROP.fallSpeed * TICK;
  // High ground can only be left by dropping off it, so over it the wind takes the
  // jumper on to the nearest walkable ground instead of their steering.
  if (offLowGround(p.pos.x, p.pos.z)) {
    const to = towardLowGround(p.pos.x, p.pos.z);
    p.pos.x += to.x * DROP.drift * TICK;
    p.pos.z += to.z * DROP.drift * TICK;
  } else {
    p.pos.x += (fx * input.moveZ + Math.cos(p.yaw) * input.moveX) * DROP.steer * TICK;
    p.pos.z += (fz * input.moveZ + Math.sin(p.yaw) * input.moveX) * DROP.steer * TICK;
  }
  collide(p.pos, PLAYER.radius);
  const g = groundAt(p.pos.x, p.pos.z, PLAYER.radius, p.pos.y);
  if (p.pos.y <= g) {
    p.pos.y = g;
    p.onGround = true;
    s.phase = "play";
    s.landedAt = s.time;
    s.events.push({ t: "landed" }, { t: "land", speed: DROP.fallSpeed });
    return true;
  }
  return false;
}

export function stepPlayer(s: State, input: Input, prevCrouch: boolean) {
  const p = s.player;
  p.iframes = Math.max(0, p.iframes - TICK);
  p.sinceHurt += TICK;

  // Look, with slowdown near enemies and pull while moving and shooting.
  const near = p.downed > 0 ? null : assistTarget(s, ASSIST.slowCone);
  const sens = near ? ASSIST.slowdown : 1;
  p.yaw += input.lookX * sens;
  p.pitch = Math.max(-1.45, Math.min(1.45, p.pitch + input.lookY * sens));
  const moving = Math.abs(input.moveX) + Math.abs(input.moveZ) > 0.1;
  if (p.downed <= 0) applyPull(s, moving, input.fire, input.touch);
  p.recoil *= Math.exp(-TICK / 0.12);

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
    p.hp = Math.min(PLAYER.regenCap, p.hp + PLAYER.regenPerSec * TICK);
  }

  move(s, input, prevCrouch);
  if (p.downed <= 0 && !p.mantle) {
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
  p.mantle = { t: 0, dur: MANTLE.time * (0.4 + (0.6 * rise) / MANTLE.reach), from: { ...p.pos }, to };
  p.vel.x = p.vel.y = p.vel.z = 0;
  p.sliding = false;
  p.crouch = false;
  p.sprinting = false;
  s.events.push({ t: "mantle" });
  return true;
}

/** Rise straight up for most of the climb, then over the edge onto the top. */
function stepMantle(s: State) {
  const p = s.player;
  const m = p.mantle;
  if (!m) return;
  m.t += TICK;
  const k = Math.min(1, m.t / m.dur);
  const up = Math.min(1, k / 0.65);
  const over = Math.max(0, (k - 0.65) / 0.35);
  p.pos.y = m.from.y + (m.to.y + 0.02 - m.from.y) * (1 - (1 - up) * (1 - up));
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
  if (tryMantle(s, input)) return;
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
  const speed = Math.hypot(p.vel.x, p.vel.z);

  if (input.moveZ > 0.5 && !input.fire && p.ads < 0.1 && !p.healing) p.forwardHeld += TICK;
  else p.forwardHeld = 0;
  p.sprinting = p.onGround && !p.sliding && !input.crouch && p.downed <= 0 && p.forwardHeld > PLAYER.autoSprintAfter;
  // Running footsteps carry a little way; walking and crouching are silent.
  p.stepNoise -= TICK;
  if (p.sprinting && p.stepNoise <= 0) {
    p.stepNoise = 0.35;
    makeNoise(s, p.pos.x, p.pos.z, NOISE.sprintStep);
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
    let top = p.downed > 0 ? 1.4 : p.crouch ? PLAYER.crouch : p.sprinting ? PLAYER.sprint : PLAYER.walk;
    if (p.ads > 0.5) top *= 0.75;
    if (p.healing) top *= 0.5;
    if (p.ultTime > 0) top *= ULT.speed;
    if (p.onGround) {
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
      const cap = Math.max(speed, top);
      p.vel.x += wx * PLAYER.airAccel * TICK;
      p.vel.z += wz * PLAYER.airAccel * TICK;
      const ns = Math.hypot(p.vel.x, p.vel.z);
      if (ns > cap) {
        p.vel.x *= cap / ns;
        p.vel.z *= cap / ns;
      }
    }
  }

  if (input.jump && p.onGround && p.downed <= 0) {
    p.vel.y = PLAYER.jump;
    p.onGround = false;
    p.sliding = false;
    s.events.push({ t: "jump" });
  }

  const wasOnGround = p.onGround;
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
  p.cooldown = Math.max(0, p.cooldown - TICK);
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
    p.reload = spec.reload * RARITY.reload[w.rarity];
    s.events.push({ t: "reload", time: p.reload });
  };
  if (input.reload) startReload();

  if (input.fire && p.healing) {
    p.healing = null; // shooting cancels the item without using it
  }
  // Semi-auto weapons also repeat while held, a little slower than clicking.
  const canFire = input.fire && p.cooldown <= 0 && p.reload <= 0 && !p.healing;
  if (canFire) {
    if (w.mag <= 0 && p.ultTime <= 0) {
      if (!p.triggerHeld) s.events.push({ t: "dry" });
      startReload();
    } else {
      // Spend the round first: a kill with a gold weapon refills the magazine inside shoot().
      if (p.ultTime <= 0) w.mag--;
      shoot(s, w);
      const held = !spec.auto && p.triggerHeld ? SEMI_HOLD : 1;
      p.cooldown = (spec.interval * held) / (p.ultTime > 0 ? ULT.fireRate : 1);
      if (w.mag <= 0 && p.ultTime <= 0) startReload();
    }
  }
  p.triggerHeld = input.fire;
}

function abilities(s: State, input: Input) {
  const p = s.player;
  p.tactical = Math.max(0, p.tactical - TICK);
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
      p.tactical = TACTICAL.cooldown * 0.5;
      s.events.push({ t: "tacticalMiss" });
    } else {
      p.tactical = TACTICAL.cooldown;
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

  if (p.ultTime > 0) {
    p.ultTime -= TICK;
    if (p.ultTime <= 0) {
      p.ultTime = 0;
      s.events.push({ t: "ultEnd" });
    }
  } else if (input.ult && p.ult >= 1) {
    p.ult = 0;
    p.ultTime = ULT.duration;
    p.reload = 0;
    const w = p.weapons[p.slot];
    if (w) w.mag = magSize(w);
    s.events.push({ t: "ultStart" });
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
      s.events.push({ t: "healDone", kind: h.kind });
    }
  } else if (input.heal) {
    const kind = pickHeal(s);
    if (kind) {
      p.healing = { kind, t: HEALS[kind].time };
      p.reload = 0;
      s.events.push({ t: "healStart", kind });
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
