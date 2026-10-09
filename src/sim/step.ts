import { DASH, ENEMY, ENEMY_BULLET, GUN, PLAYER, ROOM, RUSH, TICK, WORLD } from "./config";
import {
  angleTo, blockingCover, circleRect, clampToRoom, enterRoom, lineOfSight, pushOut, rand, ROOMS, spawnWave, wrapAngle,
  type Bullet, type Enemy, type Input, type State,
} from "./state";

const DEG = Math.PI / 180;

/**
 * Advance the game by one fixed tick. Mutates and returns `s`; callers that need
 * history clone first. `s.events` holds only what happened during this tick.
 */
export function step(s: State, input: Input): State {
  s.events = [];
  s.tick++;
  if (s.phase === "done") return s;
  if (s.phase === "dead") {
    s.phaseTimer += TICK;
    if (s.phaseTimer > 0.9) enterRoom(s, s.room);
    return s;
  }
  if (s.phase === "clear") {
    s.phaseTimer += TICK;
    movePlayer(s, input);
    moveBullets(s);
    if (s.phaseTimer > ROOM.clearBeat) {
      if (s.room + 1 >= ROOMS.length) {
        s.phase = "done";
        s.events.push({ type: "done" });
      } else enterRoom(s, s.room + 1);
    }
    return s;
  }

  s.roomTicks++;
  if (s.streakTimer > 0 && (s.streakTimer -= TICK) <= 0) s.streak = 0;
  movePlayer(s, input);
  shoot(s, input);
  for (const e of s.enemies) thinkEnemy(s, e);
  separateEnemies(s);
  moveBullets(s);

  if (s.player.hp <= 0) {
    s.phase = "dead";
    s.phaseTimer = 0;
    s.deaths++;
    s.events.push({ type: "dead" });
    return s;
  }
  if (s.enemies.length === 0) {
    const next = s.waves.shift();
    if (next) spawnWave(s, next);
    else {
      s.phase = "clear";
      s.phaseTimer = 0;
      const time = s.roomTicks * TICK;
      s.roomTimes[s.room] = time;
      s.bullets = s.bullets.filter((b) => b.from === "player");
      s.events.push({ type: "roomClear", room: s.room, time });
    }
  }
  return s;
}

// ------------------------------------------------------------------ player

function movePlayer(s: State, input: Input) {
  const p = s.player;
  p.invuln = Math.max(0, p.invuln - TICK);
  p.dashCooldown = Math.max(0, p.dashCooldown - TICK);
  p.aim = angleTo(p.pos, input.aim);

  const len = Math.hypot(input.move.x, input.move.y);
  const dir = len > 0 ? { x: input.move.x / len, y: input.move.y / len } : { x: 0, y: 0 };

  if (input.dash && p.dashCooldown <= 0 && p.dashTime <= 0) {
    p.dashDir = len > 0 ? dir : { x: Math.cos(p.aim), y: Math.sin(p.aim) };
    p.dashTime = DASH.time;
    p.dashCooldown = DASH.cooldown;
    p.invuln = Math.max(p.invuln, DASH.time + DASH.invulnTail);
    s.events.push({ type: "dash", pos: { ...p.pos } });
  }

  if (p.dashTime > 0) {
    p.dashTime -= TICK;
    p.vel = { x: p.dashDir.x * DASH.speed, y: p.dashDir.y * DASH.speed };
  } else {
    // Exponential approach: reaches ~95% of the target velocity in `accel` seconds.
    const k = 1 - Math.exp((-3 * TICK) / PLAYER.accel);
    p.vel.x += (dir.x * PLAYER.speed - p.vel.x) * k;
    p.vel.y += (dir.y * PLAYER.speed - p.vel.y) * k;
  }
  p.pos.x += p.vel.x * TICK;
  p.pos.y += p.vel.y * TICK;
  for (const k of s.cover) pushOut(p.pos, PLAYER.radius, k);
  clampToRoom(p.pos, PLAYER.radius);
}

function shoot(s: State, input: Input) {
  const p = s.player;
  p.fireCooldown = Math.max(0, p.fireCooldown - TICK);
  if (p.reload > 0) {
    p.reload -= TICK;
    if (p.reload <= 0) {
      p.mag = GUN.mag;
      s.events.push({ type: "reloaded" });
    }
    return;
  }
  if ((input.reload && p.mag < GUN.mag) || p.mag === 0) {
    p.reload = GUN.reload;
    s.events.push({ type: "reload" });
    return;
  }
  if (!input.fire || p.fireCooldown > 0) return;

  p.fireCooldown = 1 / GUN.rate;
  p.mag--;
  s.shots++;
  const precise = preciseTarget(s, p.aim);
  let angle = assistAngle(s, p.aim);
  angle += (rand(s) - 0.5) * 2 * GUN.spreadDeg * DEG;
  const muzzle = { x: p.pos.x + Math.cos(angle) * 20, y: p.pos.y + Math.sin(angle) * 20 };
  s.bullets.push({
    id: s.nextId++,
    from: "player",
    pos: muzzle,
    vel: { x: Math.cos(angle) * GUN.bulletSpeed, y: Math.sin(angle) * GUN.bulletSpeed },
    radius: GUN.bulletRadius,
    life: 0.8,
    precise,
  });
  s.events.push({ type: "shot", pos: muzzle, angle });
}

/** The enemy whose crit core the raw aim ray (before any assist) passes through, or 0. */
function preciseTarget(s: State, aim: number): number {
  let best = { id: 0, dist: Infinity };
  for (const e of s.enemies) {
    if (e.mode === "spawning") continue;
    const dist = Math.hypot(e.pos.x - s.player.pos.x, e.pos.y - s.player.pos.y);
    const err = Math.abs(wrapAngle(angleTo(s.player.pos, e.pos) - aim));
    if (err < Math.atan2(ENEMY[e.kind].radius * GUN.critCore, dist) && dist < best.dist) best = { id: e.id, dist };
  }
  return best.id;
}

/** Aim assist: an aim within a few degrees of a visible enemy is pulled most of the way onto it. */
function assistAngle(s: State, aim: number): number {
  let best: { err: number; to: number } | null = null;
  for (const e of s.enemies) {
    if (e.mode === "spawning") continue;
    const to = angleTo(s.player.pos, e.pos);
    const dist = Math.hypot(e.pos.x - s.player.pos.x, e.pos.y - s.player.pos.y);
    const allowance = GUN.assistDeg * DEG + Math.atan2(ENEMY[e.kind].radius, dist);
    const err = Math.abs(wrapAngle(to - aim));
    if (err < allowance && (!best || err < best.err) && lineOfSight(s, s.player.pos, e.pos)) best = { err, to };
  }
  return best ? aim + wrapAngle(best.to - aim) * GUN.assistPull : aim;
}

// ------------------------------------------------------------------ enemies

function thinkEnemy(s: State, e: Enemy) {
  const spec = ENEMY[e.kind];
  const p = s.player;
  const toPlayer = angleTo(e.pos, p.pos);
  const dist = Math.hypot(p.pos.x - e.pos.x, p.pos.y - e.pos.y);
  e.timer -= TICK;

  if (e.mode === "spawning") {
    if (e.timer <= 0) {
      e.mode = "moving";
      e.timer = spec.cooldown * (0.5 + rand(s) * 0.5);
    }
    return;
  }

  if (e.kind === "rusher") return thinkRusher(s, e, toPlayer);

  e.facing = toPlayer;
  if (e.mode === "moving") {
    const want = e.kind === "drone" ? 260 : 330;
    const sees = lineOfSight(s, e.pos, p.pos);
    let vx: number;
    let vy: number;
    if (!sees) {
      // Route around the cover in the way: head for its corner on the shorter path to the player.
      const k = blockingCover(s, e.pos, p.pos);
      const pad = spec.radius + 10;
      const corners = k
        ? [{ x: k.x - pad, y: k.y - pad }, { x: k.x + k.w + pad, y: k.y - pad }, { x: k.x - pad, y: k.y + k.h + pad }, { x: k.x + k.w + pad, y: k.y + k.h + pad }]
        : [p.pos];
      const via = corners.reduce((best, c) =>
        Math.hypot(c.x - e.pos.x, c.y - e.pos.y) + Math.hypot(p.pos.x - c.x, p.pos.y - c.y) <
        Math.hypot(best.x - e.pos.x, best.y - e.pos.y) + Math.hypot(p.pos.x - best.x, p.pos.y - best.y) ? c : best);
      const a = angleTo(e.pos, via);
      vx = Math.cos(a);
      vy = Math.sin(a);
    } else {
      const sign = dist > want + 30 ? 1 : dist < want - 30 ? -1 : 0;
      const strafe = Math.sin(s.tick / 50 + e.id) * 0.6;
      vx = Math.cos(toPlayer) * sign + Math.cos(toPlayer + Math.PI / 2) * strafe;
      vy = Math.sin(toPlayer) * sign + Math.sin(toPlayer + Math.PI / 2) * strafe;
    }
    e.pos.x += vx * spec.speed * TICK;
    e.pos.y += vy * spec.speed * TICK;
    if (e.timer <= 0 && sees) {
      e.mode = "telegraph";
      e.timer = spec.telegraph;
      s.events.push({ type: "telegraph", enemy: e.id, kind: e.kind });
    }
  } else if (e.mode === "telegraph" && e.timer <= 0) {
    const angles = e.kind === "gunner" ? [-0.32, -0.16, 0, 0.16, 0.32] : [0];
    for (const da of angles) {
      const a = toPlayer + da;
      s.bullets.push({
        id: s.nextId++,
        from: "enemy",
        pos: { x: e.pos.x + Math.cos(a) * spec.radius, y: e.pos.y + Math.sin(a) * spec.radius },
        vel: { x: Math.cos(a) * ENEMY_BULLET.speed, y: Math.sin(a) * ENEMY_BULLET.speed },
        radius: ENEMY_BULLET.radius,
        life: 5,
        precise: 0,
      });
    }
    s.events.push({ type: "enemyShot", pos: { ...e.pos } });
    e.mode = "moving";
    e.timer = spec.cooldown * (0.8 + rand(s) * 0.4);
  }
  settle(s, e);
}

/** Rushers wind up facing a fixed direction, then charge in a straight line, then stand stunned. */
function thinkRusher(s: State, e: Enemy, toPlayer: number) {
  const spec = ENEMY.rusher;
  if (e.mode === "moving") {
    e.facing = toPlayer;
    e.pos.x += Math.cos(toPlayer) * spec.speed * TICK;
    e.pos.y += Math.sin(toPlayer) * spec.speed * TICK;
    if (e.timer <= 0) {
      e.mode = "telegraph";
      e.timer = spec.telegraph;
      e.aimLock = toPlayer;
      e.facing = toPlayer;
      s.events.push({ type: "telegraph", enemy: e.id, kind: e.kind });
    }
  } else if (e.mode === "telegraph" && e.timer <= 0) {
    e.mode = "attacking";
    e.timer = RUSH.time;
    s.events.push({ type: "rush", pos: { ...e.pos } });
  } else if (e.mode === "attacking") {
    e.pos.x += Math.cos(e.aimLock) * RUSH.speed * TICK;
    e.pos.y += Math.sin(e.aimLock) * RUSH.speed * TICK;
    const bumped = s.cover.some((k) => circleRect(e.pos, spec.radius, k));
    if (Math.hypot(s.player.pos.x - e.pos.x, s.player.pos.y - e.pos.y) < spec.radius + PLAYER.radius) hurtPlayer(s, e.aimLock);
    if (e.timer <= 0 || bumped) {
      e.mode = "recover";
      e.timer = RUSH.recover + (bumped ? 0.5 : 0);
    }
  } else if (e.mode === "recover" && e.timer <= 0) {
    e.mode = "moving";
    e.timer = spec.cooldown * (0.8 + rand(s) * 0.5);
  }
  settle(s, e);
}

function settle(s: State, e: Enemy) {
  const r = ENEMY[e.kind].radius;
  for (const k of s.cover) pushOut(e.pos, r, k);
  clampToRoom(e.pos, r);
}

function separateEnemies(s: State) {
  for (let i = 0; i < s.enemies.length; i++)
    for (let j = i + 1; j < s.enemies.length; j++) {
      const a = s.enemies[i];
      const b = s.enemies[j];
      const min = ENEMY[a.kind].radius + ENEMY[b.kind].radius;
      const dx = b.pos.x - a.pos.x;
      const dy = b.pos.y - a.pos.y;
      const d = Math.hypot(dx, dy) || 1;
      if (d < min) {
        const push = (min - d) / 2;
        a.pos.x -= (dx / d) * push;
        a.pos.y -= (dy / d) * push;
        b.pos.x += (dx / d) * push;
        b.pos.y += (dy / d) * push;
      }
    }
}

// ------------------------------------------------------------------ bullets

function hurtPlayer(s: State, fromAngle: number) {
  const p = s.player;
  if (p.invuln > 0 || s.phase !== "fight") return;
  p.hp--;
  p.invuln = PLAYER.hurtInvuln;
  p.vel = { x: Math.cos(fromAngle) * PLAYER.knockback, y: Math.sin(fromAngle) * PLAYER.knockback };
  s.hitsTaken++;
  s.events.push({ type: "hurt", pos: { ...p.pos }, hp: p.hp });
}

function moveBullets(s: State) {
  const keep: Bullet[] = [];
  for (const b of s.bullets) {
    if (b.from === "player") home(s, b);
    b.pos.x += b.vel.x * TICK;
    b.pos.y += b.vel.y * TICK;
    b.life -= TICK;
    if (b.life <= 0) continue;
    const out = b.pos.x < WORLD.wall || b.pos.y < WORLD.wall || b.pos.x > WORLD.w - WORLD.wall || b.pos.y > WORLD.h - WORLD.wall;
    if (out || s.cover.some((k) => circleRect(b.pos, b.radius, k))) {
      s.events.push({ type: "wallHit", pos: { ...b.pos }, from: b.from });
      continue;
    }
    if (b.from === "enemy") {
      const p = s.player;
      if (Math.hypot(p.pos.x - b.pos.x, p.pos.y - b.pos.y) < PLAYER.radius + b.radius && p.invuln <= 0 && s.phase === "fight") {
        hurtPlayer(s, Math.atan2(b.vel.y, b.vel.x));
        continue;
      }
      keep.push(b);
      continue;
    }
    const target = s.enemies.find((e) => e.mode !== "spawning" && Math.hypot(e.pos.x - b.pos.x, e.pos.y - b.pos.y) < ENEMY[e.kind].radius + b.radius);
    if (!target) {
      keep.push(b);
      continue;
    }
    hitEnemy(s, target, b);
  }
  s.bullets = keep;
}

/** Bullets bend slightly toward a nearby enemy so near-misses still land. */
function home(s: State, b: Bullet) {
  let best: { d: number; a: number } | null = null;
  for (const e of s.enemies) {
    if (e.mode === "spawning") continue;
    const d = Math.hypot(e.pos.x - b.pos.x, e.pos.y - b.pos.y);
    if (d > GUN.homingRange) continue;
    const a = angleTo(b.pos, e.pos);
    const heading = Math.atan2(b.vel.y, b.vel.x);
    if (Math.abs(wrapAngle(a - heading)) > Math.PI / 2) continue;
    if (!best || d < best.d) best = { d, a };
  }
  if (!best) return;
  const heading = Math.atan2(b.vel.y, b.vel.x);
  const turn = Math.max(-GUN.homingDegPerTick * DEG, Math.min(GUN.homingDegPerTick * DEG, wrapAngle(best.a - heading)));
  const speed = Math.hypot(b.vel.x, b.vel.y);
  b.vel = { x: Math.cos(heading + turn) * speed, y: Math.sin(heading + turn) * speed };
}

function hitEnemy(s: State, e: Enemy, b: Bullet) {
  const spec = ENEMY[e.kind];
  // Assist decides whether a shot lands; only the player's own aim decides a crit.
  const crit = b.precise === e.id;
  const stunned = e.kind === "rusher" && e.mode === "recover";
  e.hp -= GUN.damage * (crit || stunned ? GUN.critMultiplier : 1);
  s.hits++;
  if (crit) s.crits++;
  s.events.push({ type: "hit", pos: { ...b.pos }, crit, enemy: e.id });
  if (e.hp > 0) return;

  s.enemies = s.enemies.filter((o) => o !== e);
  s.streak = s.streakTimer > 0 ? s.streak + 1 : 1;
  s.streakTimer = ROOM.streakWindow;
  const last = s.enemies.length === 0 && s.waves.length === 0;
  s.events.push({ type: "kill", pos: { ...e.pos }, kind: e.kind, crit, streak: s.streak, last });
}

// ------------------------------------------------------------------ scoring

export function totalTime(s: State): number {
  return s.roomTimes.reduce((a, b) => a + (b ?? 0), 0);
}

/** Rank from time against the summed par, one grade off per four hits taken. */
export function rank(s: State): "S" | "A" | "B" | "C" {
  const par = ROOMS.reduce((a, r) => a + r.par, 0);
  const ratio = totalTime(s) / par;
  let grade = ratio <= 1 ? 0 : ratio <= 1.4 ? 1 : ratio <= 2 ? 2 : 3;
  grade = Math.min(3, grade + Math.floor(s.hitsTaken / 4));
  return (["S", "A", "B", "C"] as const)[grade];
}
