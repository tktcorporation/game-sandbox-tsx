import Phaser from "phaser";
import { ENEMY, GUN, PLAYER, RUSH, TICK, WORLD } from "../sim/config";
import { newRun, ROOMS, type Enemy, type GameEvent, type Input, type State, type Vec } from "../sim/state";
import { step } from "../sim/step";
import { sfx, unlock } from "./audio";
import type { Hud } from "./hud";

/*
 * The scene owns presentation only. Game rules live in src/sim; this file turns
 * state.events into feel: hit-stop, slow motion, recoil, particles, sound.
 * Hit-stop and slow motion change how many fixed sim ticks run per frame, so
 * the simulation itself stays deterministic.
 */

const C = {
  floor: 0x2034d6,
  ground: 0x2034d6,
  floorMark: 0x1b2dc0,
  wall: 0x0e176a,
  wallEdge: 0x3e55ff,
  cover: 0x101b78,
  coverTop: 0x4a62ff,
  shadow: 0x0a1255,
  player: 0xffffff,
  ink: 0x0b1240,
  enemy: 0xff5a1f,
  enemyDark: 0xc23b0a,
  enemyFlash: 0xffc9b0,
  hot: 0xffe23d,
  white: 0xffffff,
} as const;

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  color: number;
  kind: "shard" | "spark" | "shell" | "puff" | "ring" | "ghost";
  rot: number;
  vr: number;
}

export class GameScene extends Phaser.Scene {
  state!: State;
  private hud!: Hud;
  private floor!: Phaser.GameObjects.Graphics;
  private world!: Phaser.GameObjects.Graphics;
  private fx!: Phaser.GameObjects.Graphics;
  private ui!: Phaser.GameObjects.Graphics;
  private keys!: Record<"W" | "A" | "S" | "D" | "UP" | "LEFT" | "DOWN" | "RIGHT" | "SPACE" | "SHIFT" | "R", Phaser.Input.Keyboard.Key>;
  private particles: Particle[] = [];
  private acc = 0;
  private hitStop = 0;
  private slow = 0;
  private recoil = { x: 0, y: 0 };
  private hitmarker = { t: 0, crit: false };
  private bloom = 0;
  private flashes = new Map<number, number>();
  private hurtFlash = 0;
  private started = false;
  private manual = false;
  private dashQueued = false;
  private touch = { move: null as null | { id: number; ox: number; oy: number; x: number; y: number }, aim: null as null | { id: number; ox: number; oy: number; x: number; y: number } };
  private lastAim: Vec = { x: WORLD.w / 2, y: 0 };

  constructor() {
    super("game");
  }

  init(data: { hud: Hud }) {
    this.hud = data.hud;
  }

  create() {
    this.state = newRun((Date.now() & 0xffff) + 1);
    this.floor = this.add.graphics();
    this.world = this.add.graphics();
    this.fx = this.add.graphics();
    this.ui = this.add.graphics();
    this.keys = this.input.keyboard!.addKeys("W,A,S,D,UP,LEFT,DOWN,RIGHT,SPACE,SHIFT,R") as typeof this.keys;
    this.input.addPointer(2);
    this.input.mouse?.disableContextMenu();
    this.input.on("pointerdown", (p: Phaser.Input.Pointer) => {
      unlock();
      if (!this.started) return this.begin();
      if (p.wasTouch) this.touchDown(p);
      else if (p.rightButtonDown()) this.dashQueued = true;
    });
    this.input.on("pointerup", (p: Phaser.Input.Pointer) => this.touchUp(p));
    this.input.keyboard!.on("keydown-SPACE", () => (this.dashQueued = true));
    this.input.keyboard!.on("keydown-SHIFT", () => (this.dashQueued = true));
    this.input.keyboard!.on("keydown-ENTER", () => {
      unlock();
      if (!this.started) this.begin();
      else if (this.state.phase === "done") this.restart();
    });
    this.hud.onRestart = () => this.restart();
    this.hud.onDash = () => (this.dashQueued = true);
    this.hud.onStart = () => {
      unlock();
      this.begin();
    };
    this.drawFloor();
    this.hud.title(true);
  }

  // ---------------------------------------------------------------- flow

  begin() {
    if (this.started) return;
    this.started = true;
    this.hud.title(false);
    this.consume(this.state.events);
  }

  restart() {
    this.state = newRun((Date.now() & 0xffff) + 1);
    this.particles = [];
    this.hud.results(null);
    this.drawFloor();
    this.consume(this.state.events);
  }

  /** Automation: stop the real-time loop and advance the sim by exactly `ms`. */
  advance(ms: number) {
    this.manual = true;
    this.started = true;
    this.hud.title(false);
    const n = Math.round(ms / (TICK * 1000));
    for (let i = 0; i < n; i++) this.tickOnce();
    this.renderAll(n * TICK);
  }

  update(_t: number, dms: number) {
    if (this.manual) return;
    const dt = Math.min(0.05, dms / 1000);
    if (this.started) {
      if (this.hitStop > 0) this.hitStop -= dt;
      else {
        const scale = this.slow > 0 ? 0.25 : 1;
        this.acc += dt * scale;
        while (this.acc >= TICK) {
          this.acc -= TICK;
          this.tickOnce();
          if (this.hitStop > 0) {
            this.acc = 0;
            break;
          }
        }
      }
      this.slow = Math.max(0, this.slow - dt);
    }
    this.renderAll(dt);
  }

  private tickOnce() {
    const before = this.state.room;
    step(this.state, this.readInput());
    this.dashQueued = false;
    if (this.state.room !== before) this.drawFloor();
    this.consume(this.state.events);
  }

  private readInput(): Input {
    const k = this.keys;
    let mx = (k.D.isDown || k.RIGHT.isDown ? 1 : 0) - (k.A.isDown || k.LEFT.isDown ? 1 : 0);
    let my = (k.S.isDown || k.DOWN.isDown ? 1 : 0) - (k.W.isDown || k.UP.isDown ? 1 : 0);
    const ptr = this.input.activePointer;
    let aim: Vec = { x: ptr.worldX, y: ptr.worldY };
    let fire = ptr.isDown && !ptr.wasTouch && ptr.leftButtonDown();

    const t = this.touch;
    if (t.move) {
      const dx = t.move.x - t.move.ox;
      const dy = t.move.y - t.move.oy;
      const d = Math.hypot(dx, dy);
      if (d > 8) {
        mx = dx / Math.max(d, 50);
        my = dy / Math.max(d, 50);
      }
    }
    if (t.aim) {
      const dx = t.aim.x - t.aim.ox;
      const dy = t.aim.y - t.aim.oy;
      const p = this.state.player.pos;
      const nearest = this.nearestEnemy();
      if (Math.hypot(dx, dy) > 12) aim = { x: p.x + dx * 8, y: p.y + dy * 8 };
      else if (nearest) aim = { ...nearest.pos };
      fire = true;
    } else if (this.touch.move && !t.aim) {
      const nearest = this.nearestEnemy();
      if (nearest) aim = { ...nearest.pos };
    }
    for (const p of [this.input.pointer1, this.input.pointer2]) {
      if (t.move?.id === p.id) Object.assign(t.move, { x: p.x, y: p.y });
      if (t.aim?.id === p.id) Object.assign(t.aim, { x: p.x, y: p.y });
    }
    this.lastAim = aim;
    return { move: { x: mx, y: my }, aim, fire, dash: this.dashQueued, reload: k.R.isDown };
  }

  private touchDown(p: Phaser.Input.Pointer) {
    const side = p.x < WORLD.w / 2 ? "move" : "aim";
    this.touch[side] = { id: p.id, ox: p.x, oy: p.y, x: p.x, y: p.y };
    this.hud.touchMode();
  }

  private touchUp(p: Phaser.Input.Pointer) {
    if (this.touch.move?.id === p.id) this.touch.move = null;
    if (this.touch.aim?.id === p.id) this.touch.aim = null;
  }

  private nearestEnemy(): Enemy | undefined {
    const p = this.state.player.pos;
    return this.state.enemies
      .filter((e) => e.mode !== "spawning")
      .sort((a, b) => Math.hypot(a.pos.x - p.x, a.pos.y - p.y) - Math.hypot(b.pos.x - p.x, b.pos.y - p.y))[0];
  }

  // ---------------------------------------------------------------- feel

  private consume(events: GameEvent[]) {
    const cam = this.cameras.main;
    for (const e of events) {
      switch (e.type) {
        case "shot": {
          sfx.shot();
          this.recoil.x -= Math.cos(e.angle) * 3;
          this.recoil.y -= Math.sin(e.angle) * 3;
          this.bloom = Math.min(1, this.bloom + 0.18);
          const side = e.angle + Math.PI / 2;
          this.spawn({ x: e.pos.x - Math.cos(e.angle) * 14, y: e.pos.y - Math.sin(e.angle) * 14, vx: Math.cos(side) * (140 + Math.random() * 80), vy: Math.sin(side) * (140 + Math.random() * 80) - 60, life: 0.7, size: 3, color: C.hot, kind: "shell", vr: 18 });
          this.spawn({ x: e.pos.x, y: e.pos.y, vx: 0, vy: 0, life: 0.05, size: 16, color: C.white, kind: "spark", rot: e.angle });
          break;
        }
        case "hit":
          this.hitmarker = { t: 0.09, crit: e.crit };
          this.flashes.set(e.enemy, 0.06);
          e.crit ? sfx.crit() : sfx.hit();
          for (let i = 0; i < (e.crit ? 6 : 3); i++) {
            const a = Math.random() * Math.PI * 2;
            this.spawn({ x: e.pos.x, y: e.pos.y, vx: Math.cos(a) * 260, vy: Math.sin(a) * 260, life: 0.15, size: e.crit ? 9 : 6, color: e.crit ? C.hot : C.white, kind: "spark", rot: a });
          }
          if (e.crit) this.floatText(e.pos, "CRIT", "#ffe23d", 15);
          break;
        case "kill": {
          sfx.kill(e.streak);
          this.hitStop = e.last ? 0.08 : 0.045;
          cam.shake(e.last ? 260 : 110, 0.004 + Math.min(e.streak, 6) * 0.0018);
          for (let i = 0; i < 14; i++) {
            const a = Math.random() * Math.PI * 2;
            const sp = 180 + Math.random() * 380;
            this.spawn({ x: e.pos.x, y: e.pos.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.45 + Math.random() * 0.3, size: 5 + Math.random() * 7, color: i % 4 === 0 ? C.white : C.enemy, kind: "shard", vr: (Math.random() - 0.5) * 20 });
          }
          this.spawn({ x: e.pos.x, y: e.pos.y, vx: 0, vy: 0, life: 0.3, size: ENEMY[e.kind].radius, color: C.white, kind: "ring" });
          if (e.streak >= 2) this.floatText(e.pos, `×${e.streak}`, "#ffffff", 22 + Math.min(e.streak, 6) * 3);
          if (e.last) {
            sfx.last();
            this.slow = 0.35;
            this.spawn({ x: e.pos.x, y: e.pos.y, vx: 0, vy: 0, life: 0.6, size: 40, color: C.hot, kind: "ring" });
          }
          break;
        }
        case "wallHit":
          if (e.from === "player") {
            sfx.wall();
            this.spawn({ x: e.pos.x, y: e.pos.y, vx: 0, vy: 0, life: 0.18, size: 7, color: 0x8fa0ff, kind: "puff" });
          }
          break;
        case "hurt":
          sfx.hurt();
          this.hurtFlash = 0.35;
          cam.shake(220, 0.012);
          this.hitStop = 0.06;
          break;
        case "dash":
          sfx.dash();
          break;
        case "reload":
          sfx.reload();
          break;
        case "reloaded":
          sfx.reloaded();
          break;
        case "telegraph":
          sfx.telegraph();
          break;
        case "enemyShot":
          sfx.enemyShot();
          break;
        case "rush":
          sfx.rush();
          break;
        case "spawn":
          sfx.spawn();
          break;
        case "roomClear":
          sfx.clear();
          this.hud.banner(`CLEAR`, `${e.time.toFixed(1)} 秒 · 目標 ${ROOMS[e.room].par} 秒`);
          break;
        case "roomStart":
          this.hud.banner(`ROOM ${e.room + 1}`, "", true);
          break;
        case "dead":
          sfx.dead();
          this.hud.banner("DOWN", "この部屋の最初から");
          break;
        case "done":
          this.hud.results(this.state);
          break;
      }
    }
  }

  private spawn(p: Partial<Particle> & Pick<Particle, "x" | "y" | "life" | "size" | "color" | "kind">) {
    this.particles.push({ vx: 0, vy: 0, rot: Math.random() * 6, vr: 0, max: p.life, ...p });
    if (this.particles.length > 600) this.particles.splice(0, this.particles.length - 600);
  }

  private floatText(pos: Vec, text: string, color: string, size: number) {
    const t = this.add
      .text(pos.x, pos.y - 24, text, { fontFamily: "Big Shoulders Display, Impact, sans-serif", fontSize: `${size}px`, fontStyle: "900", color, stroke: "#0b1240", strokeThickness: 5 })
      .setOrigin(0.5);
    this.tweens.add({ targets: t, y: pos.y - 64, scale: 1.25, duration: 650, ease: "Cubic.easeOut", onComplete: () => t.destroy() });
    this.tweens.add({ targets: t, alpha: 0, delay: 420, duration: 230 });
  }

  // ---------------------------------------------------------------- render

  private drawFloor() {
    const g = this.floor;
    g.clear();
    g.fillStyle(C.floor).fillRect(0, 0, WORLD.w, WORLD.h);
    // Scuffs instead of a grid: a printed texture, deterministic per room.
    let seed = this.state.room * 977 + 13;
    const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    g.fillStyle(C.floorMark);
    for (let i = 0; i < 26; i++) g.fillRect(r() * WORLD.w, r() * WORLD.h, 10 + r() * 60, 3);
    g.fillStyle(C.wall);
    const w = WORLD.wall;
    g.fillRect(0, 0, WORLD.w, w).fillRect(0, WORLD.h - w, WORLD.w, w).fillRect(0, 0, w, WORLD.h).fillRect(WORLD.w - w, 0, w, WORLD.h);
    g.lineStyle(2, C.wallEdge).strokeRect(w, w, WORLD.w - w * 2, WORLD.h - w * 2);
    for (const k of this.state.cover) {
      g.fillStyle(C.shadow).fillRect(k.x + 7, k.y + 9, k.w, k.h);
      g.fillStyle(C.cover).fillRect(k.x, k.y, k.w, k.h);
      g.fillStyle(C.coverTop).fillRect(k.x, k.y, k.w, 4);
    }
  }

  private renderAll(dt: number) {
    const s = this.state;
    const g = this.world;
    g.clear();
    this.recoil.x *= 0.7;
    this.recoil.y *= 0.7;
    this.bloom = Math.max(0, this.bloom - dt * 2.5);
    this.cameras.main.setScroll(this.recoil.x, this.recoil.y);

    for (const e of s.enemies) this.drawEnemyBack(g, e);

    // enemy bullets: thick, bright, readable
    for (const b of s.bullets) {
      if (b.from !== "enemy") continue;
      g.fillStyle(C.shadow).fillCircle(b.pos.x + 4, b.pos.y + 6, b.radius);
      g.fillStyle(C.enemy).fillCircle(b.pos.x, b.pos.y, b.radius);
      g.fillStyle(C.white).fillCircle(b.pos.x, b.pos.y, b.radius * 0.45);
    }

    this.drawPlayer(g);
    for (const e of s.enemies) this.drawEnemy(g, e, dt);

    // player bullets: white streaks
    g.lineStyle(4, C.white);
    for (const b of s.bullets) {
      if (b.from !== "player") continue;
      g.lineBetween(b.pos.x, b.pos.y, b.pos.x - b.vel.x * 0.014, b.pos.y - b.vel.y * 0.014);
    }

    this.drawParticles(dt);
    this.drawCrosshair(dt);
    this.hud.update(s, this.bloom);
    this.hurtFlash = Math.max(0, this.hurtFlash - dt);
    this.hud.hurt(this.hurtFlash / 0.35);
  }

  private drawPlayer(g: Phaser.GameObjects.Graphics) {
    const p = this.state.player;
    if (this.state.phase === "dead") return;
    const blink = p.invuln > 0 && p.dashTime <= 0 && Math.floor(this.time.now / 60) % 2 === 0;
    if (p.dashTime > 0) this.spawn({ x: p.pos.x, y: p.pos.y, life: 0.16, size: PLAYER.radius, color: C.white, kind: "ghost" });
    g.fillStyle(C.shadow).fillCircle(p.pos.x + 5, p.pos.y + 7, PLAYER.radius);
    if (blink) return;
    const a = p.aim;
    // Aim line: a faint guide from the barrel toward the crosshair.
    const reach = Math.min(160, Math.hypot(this.lastAim.x - p.pos.x, this.lastAim.y - p.pos.y) - 16);
    if (reach > 30) g.lineStyle(2, C.hot, 0.35).lineBetween(p.pos.x + Math.cos(a) * 28, p.pos.y + Math.sin(a) * 28, p.pos.x + Math.cos(a) * reach, p.pos.y + Math.sin(a) * reach);
    g.lineStyle(10, C.ink).lineBetween(p.pos.x, p.pos.y, p.pos.x + Math.cos(a) * 30, p.pos.y + Math.sin(a) * 30);
    g.lineStyle(6, C.white).lineBetween(p.pos.x, p.pos.y, p.pos.x + Math.cos(a) * 29, p.pos.y + Math.sin(a) * 29);
    g.fillStyle(C.ink).fillCircle(p.pos.x, p.pos.y, PLAYER.radius + 2.5);
    g.fillStyle(C.player).fillCircle(p.pos.x, p.pos.y, PLAYER.radius);
    g.fillStyle(C.ground).fillCircle(p.pos.x, p.pos.y, PLAYER.radius * 0.35);
  }

  /** Telegraph layer drawn under bodies: spawn rings and the rusher's charge lane. */
  private drawEnemyBack(g: Phaser.GameObjects.Graphics, e: Enemy) {
    const r = ENEMY[e.kind].radius;
    if (e.mode === "spawning") {
      const k = Math.max(0, e.timer) / 0.9;
      g.lineStyle(3, C.enemy, 0.9).strokeCircle(e.pos.x, e.pos.y, r + 40 * k);
      return;
    }
    if (e.kind === "rusher" && e.mode === "telegraph") {
      const len = RUSH.speed * RUSH.time;
      const ex = e.pos.x + Math.cos(e.aimLock) * len;
      const ey = e.pos.y + Math.sin(e.aimLock) * len;
      const k = 1 - e.timer / ENEMY.rusher.telegraph;
      g.lineStyle(r * 2, C.enemy, 0.12 + 0.18 * k).lineBetween(e.pos.x, e.pos.y, ex, ey);
      g.lineStyle(2, C.enemy, 0.9).lineBetween(e.pos.x, e.pos.y, e.pos.x + (ex - e.pos.x) * k, e.pos.y + (ey - e.pos.y) * k);
    }
  }

  private drawEnemy(g: Phaser.GameObjects.Graphics, e: Enemy, dt: number) {
    const spec = ENEMY[e.kind];
    const r = spec.radius;
    const flash = (this.flashes.get(e.id) ?? 0) > 0;
    if (flash) this.flashes.set(e.id, (this.flashes.get(e.id) ?? 0) - dt);
    if (e.mode === "spawning") {
      g.fillStyle(C.enemy, 0.35).fillCircle(e.pos.x, e.pos.y, r * 0.6);
      return;
    }
    const tele = e.mode === "telegraph";
    const pulse = tele ? 0.5 + 0.5 * Math.sin(this.time.now / 40) : 0;
    const body = flash ? C.enemyFlash : e.mode === "recover" ? C.enemyDark : C.enemy;
    const x = e.pos.x;
    const y = e.pos.y;
    const f = e.facing;

    g.fillStyle(C.shadow);
    if (e.kind === "gunner") g.fillRect(x - r + 6, y - r + 8, r * 2, r * 2);
    else g.fillCircle(x + 6, y + 8, r);

    g.fillStyle(C.ink);
    if (e.kind === "drone") g.fillCircle(x, y, r + 3);
    else if (e.kind === "gunner") g.fillRect(x - r - 3, y - r - 3, r * 2 + 6, r * 2 + 6);
    g.fillStyle(body);
    if (e.kind === "drone") {
      g.fillCircle(x, y, r);
    } else if (e.kind === "rusher") {
      const pts = [0, 2.4, -2.4].map((da) => ({ x: x + Math.cos(f + da) * (da === 0 ? r * 1.35 : r), y: y + Math.sin(f + da) * (da === 0 ? r * 1.35 : r) }));
      g.fillStyle(C.ink).fillTriangle(pts[0].x + Math.cos(f) * 3, pts[0].y + Math.sin(f) * 3, pts[1].x, pts[1].y, pts[2].x, pts[2].y);
      g.fillStyle(body).fillTriangle(pts[0].x, pts[0].y, pts[1].x, pts[1].y, pts[2].x, pts[2].y);
    } else {
      g.fillRect(x - r, y - r, r * 2, r * 2);
      g.fillStyle(C.ink).fillRect(x + Math.cos(f) * r * 0.6 - 4, y + Math.sin(f) * r * 0.6 - 4, 8, 8);
    }
    // Core: the precise centre is the crit zone, so it is drawn as a target.
    const core = r * GUN.critCore;
    g.fillStyle(tele ? C.white : C.ink, tele ? 0.6 + 0.4 * pulse : 1).fillCircle(x, y, core + (tele ? pulse * 3 : 0));
    if (!tele) g.fillStyle(C.hot).fillCircle(x, y, core * 0.45);
    if (e.hp < spec.hp) {
      const w = r * 1.6;
      g.fillStyle(C.ink).fillRect(x - w / 2, y + r + 7, w, 4);
      g.fillStyle(C.white).fillRect(x - w / 2, y + r + 7, (w * e.hp) / spec.hp, 4);
    }
  }

  private drawParticles(dt: number) {
    const g = this.fx;
    g.clear();
    const keep: Particle[] = [];
    for (const p of this.particles) {
      p.life -= dt;
      if (p.life <= 0) continue;
      const k = p.life / p.max;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      if (p.kind === "shell") {
        p.vx *= 0.9;
        p.vy *= 0.9;
      } else {
        p.vx *= 0.88;
        p.vy *= 0.88;
      }
      switch (p.kind) {
        case "shard": {
          const s = p.size * (0.4 + 0.6 * k);
          g.fillStyle(p.color);
          g.fillTriangle(p.x + Math.cos(p.rot) * s, p.y + Math.sin(p.rot) * s, p.x + Math.cos(p.rot + 2.3) * s * 0.6, p.y + Math.sin(p.rot + 2.3) * s * 0.6, p.x + Math.cos(p.rot - 2.3) * s * 0.6, p.y + Math.sin(p.rot - 2.3) * s * 0.6);
          break;
        }
        case "spark":
          g.lineStyle(3, p.color, k).lineBetween(p.x, p.y, p.x - Math.cos(p.rot) * p.size * k, p.y - Math.sin(p.rot) * p.size * k);
          break;
        case "shell":
          g.fillStyle(p.color, Math.min(1, k * 2)).fillRect(p.x - p.size, p.y - p.size / 2, p.size * 2, p.size);
          break;
        case "puff":
          g.fillStyle(p.color, k * 0.8).fillCircle(p.x, p.y, p.size * (1.5 - k));
          break;
        case "ring":
          g.lineStyle(4 * k + 1, p.color, k).strokeCircle(p.x, p.y, p.size + (1 - k) * 46);
          break;
        case "ghost":
          g.fillStyle(p.color, 0.35 * k).fillCircle(p.x, p.y, p.size);
          break;
      }
      keep.push(p);
    }
    this.particles = keep;
  }

  private drawCrosshair(dt: number) {
    const g = this.ui;
    g.clear();
    if (!this.started || this.touch.aim || this.touch.move) return;
    const a = this.lastAim;
    const gap = 7 + this.bloom * 9 + (this.state.player.reload > 0 ? 6 : 0);
    const len = 8;
    for (const w of [5, 2]) {
      g.lineStyle(w, w === 5 ? C.ink : C.white);
      g.lineBetween(a.x - gap - len, a.y, a.x - gap, a.y).lineBetween(a.x + gap, a.y, a.x + gap + len, a.y);
      g.lineBetween(a.x, a.y - gap - len, a.x, a.y - gap).lineBetween(a.x, a.y + gap, a.x, a.y + gap + len);
    }
    if (this.hitmarker.t > 0) {
      this.hitmarker.t -= dt;
      const c = this.hitmarker.crit ? C.hot : C.white;
      const s = this.hitmarker.crit ? 13 : 9;
      for (const w of [6, 3]) {
        g.lineStyle(w, w === 6 ? C.ink : c);
        g.lineBetween(a.x - s, a.y - s, a.x - 4, a.y - 4).lineBetween(a.x + s, a.y - s, a.x + 4, a.y - 4);
        g.lineBetween(a.x - s, a.y + s, a.x - 4, a.y + 4).lineBetween(a.x + s, a.y + s, a.x + 4, a.y + 4);
      }
    }
  }
}
