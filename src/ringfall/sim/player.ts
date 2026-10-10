import { ASSIST, DEG, DROP, NOISE, PLAYER, RARITY, REVEAL, SEMI_HOLD, TACTICAL, TICK, ULT, WEAPONS, WORLD } from "./config";
import { makeNoise } from "./awareness";
import { POIS } from "./map";
import { applyPull, assistTarget, bodyCenter, damageEnemy, eyePos, magSize, shoot } from "./combat";
import { ceilingAt, collide, groundAt, los } from "./geom";
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
  p.pos.x += (fx * input.moveZ + Math.cos(p.yaw) * input.moveX) * DROP.steer * TICK;
  p.pos.z += (fz * input.moveZ + Math.sin(p.yaw) * input.moveX) * DROP.steer * TICK;
  p.pos.y -= DROP.fallSpeed * TICK;
  collide(p.pos, PLAYER.radius);
  const g = groundAt(p.pos.x, p.pos.z, PLAYER.radius, p.pos.y);
  if (p.pos.y <= g) {
    p.pos.y = g;
    p.onGround = true;
    s.phase = "play";
    s.poiStart = s.time;
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
    if (p.downed <= 0) {
      p.hp = PLAYER.reviveHp;
      p.iframes = PLAYER.reviveIframes;
      s.events.push({ t: "revive" });
    }
  } else if (p.sinceHurt > PLAYER.regenDelay && p.hp < PLAYER.hp) {
    p.hp = Math.min(PLAYER.hp, p.hp + PLAYER.regenPerSec * TICK);
  }

  move(s, input, prevCrouch);
  if (p.downed <= 0) {
    weapons(s, input);
    abilities(s, input);
  }
}

function move(s: State, input: Input, prevCrouch: boolean) {
  const p = s.player;
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

  if (input.moveZ > 0.5 && !input.fire && p.ads < 0.1 && p.battery <= 0) p.forwardHeld += TICK;
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
    const sp = Math.hypot(p.vel.x, p.vel.z);
    const ns = Math.max(0, sp - PLAYER.slideFriction * TICK);
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
    if (p.battery > 0) top *= 0.5;
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

  p.vel.y -= WORLD.gravity * TICK;
  p.pos.x += p.vel.x * TICK;
  p.pos.z += p.vel.z * TICK;
  collide(p.pos, PLAYER.radius);
  // Robots are solid too.
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
  p.ads += ((input.ads && p.battery <= 0 ? 1 : 0) - p.ads) * Math.min(1, TICK / 0.08);

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

  if (input.fire && p.battery > 0) {
    p.battery = 0; // shooting cancels the battery without using it
  }
  // Semi-auto weapons also repeat while held, a little slower than clicking.
  const canFire = input.fire && p.cooldown <= 0 && p.reload <= 0 && p.battery <= 0;
  if (canFire) {
    if (w.mag <= 0 && p.ultTime <= 0) {
      if (!p.triggerHeld) s.events.push({ t: "dry" });
      startReload();
    } else {
      shoot(s, w);
      if (p.ultTime <= 0) w.mag--;
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

  const maxShield = PLAYER.shieldByTier[p.armor];
  if (p.battery > 0) {
    p.battery -= TICK;
    if (p.battery <= 0) {
      p.battery = 0;
      p.shield = maxShield;
      p.batteries--;
      s.events.push({ t: "batteryDone" });
    }
  } else if (input.battery && p.batteries > 0 && p.shield < maxShield) {
    p.battery = PLAYER.batteryTime;
    p.reload = 0;
    s.events.push({ t: "batteryStart" });
  }
}

export function tickReveal(s: State) {
  s.player.reveal = Math.max(0, s.player.reveal - TICK);
}

export function hurtPlayer(s: State, dmg: number, fromX: number, fromZ: number, ring = false) {
  const p = s.player;
  if (s.phase !== "play" && s.phase !== "extract") return;
  if (p.downed > 0 || (p.iframes > 0 && !ring)) return;
  p.sinceHurt = 0;
  const hadShield = p.shield > 0;
  const toShield = Math.min(p.shield, dmg);
  p.shield -= toShield;
  p.hp -= dmg - toShield;
  s.events.push({ t: "hurt", dmg, fromX, fromZ, shieldBroke: hadShield && p.shield <= 0, shield: toShield > 0 });
  if (p.hp > 0) return;
  p.hp = 0;
  p.battery = 0;
  p.reload = 0;
  s.stats.downs++;
  if (p.selfRevive > 0) {
    p.selfRevive--;
    p.downed = PLAYER.downedTime;
    s.events.push({ t: "down" });
  } else wipe(s);
}

/** Everyone down: back to this POI's entry with full health; robots keep their damage. */
export function wipe(s: State) {
  const p = s.player;
  const poi = POIS[Math.min(s.poi, POIS.length - 1)];
  s.stats.wipes++;
  p.pos = { x: poi.entry.x, y: 0, z: poi.entry.z };
  p.vel = { x: 0, y: 0, z: 0 };
  p.yaw = poi.entry.yaw;
  p.pitch = 0;
  p.hp = PLAYER.hp;
  p.shield = PLAYER.shieldByTier[p.armor];
  p.downed = 0;
  p.selfRevive = 1;
  p.iframes = 2.5;
  s.orbs = [];
  s.waves = [];
  // Robots lose track of the player and go back to their posts; damage stays. The
  // titan's squad, once woken, keeps fighting.
  const boss = new Set(s.enemies.filter((e) => e.kind === "titan").map((e) => e.squad));
  for (const e of s.enemies) {
    if (e.mode !== "spawning") e.mode = "move";
    e.cooldown = 2.5;
    if (boss.has(e.squad)) continue;
    e.aware = "idle";
    e.detect = 0;
    e.goal = e.cover = e.peek = null;
  }
  s.squads.forEach((sq, i) => {
    if (!boss.has(i)) sq.engaged = false;
  });
  s.events.push({ t: "wipe" });
}
