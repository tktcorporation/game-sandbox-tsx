import * as THREE from "three";
import { ENEMY, GUN, PLAYER, RUSH, TICK, WORLD } from "../sim/config";
import { newRun, ROOMS, type Enemy, type GameEvent, type Input, type State } from "../sim/state";
import { step } from "../sim/step";
import { sfx, unlock } from "../game/audio";
import type { Hud } from "../game/hud";

/*
 * First-person view of the same simulation the 2D view plays. The sim is a flat
 * plane, so the camera's yaw is the player's aim angle and everything stands on
 * the floor at fixed heights. Like the 2D scene, this file only presents: it
 * turns state.events into feel (hit-stop, slow motion, recoil, FOV punch,
 * shards, sound) and never changes rules.
 */

/** Sim pixels per metre. */
const M = 40;
const EYE = 1.55;
const BODY_Y = 1.35;

const C = {
  ground: 0x2034d6,
  scuff: 0x1b2dc0,
  wall: 0x3a52f5,
  wallTrim: 0x0e176a,
  cover: 0xc9d1ff,
  coverTop: 0xffffff,
  fog: 0x0b1240,
  enemy: 0xff5a1f,
  enemyRecover: 0x9a2c06,
  enemyFlash: 0xffc9b0,
  hot: 0xffe23d,
  white: 0xffffff,
  ink: 0x0b1240,
} as const;

const toWorld = (x: number, y: number, h = 0) => new THREE.Vector3(x / M, h, y / M);

const inkMat = new THREE.LineBasicMaterial({ color: 0x0b1240 });
/** Ink outlines on every solid: the screen-print look of the 2D view, and depth cues in 3D. */
function inked(mesh: THREE.Mesh): THREE.Mesh {
  mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 20), inkMat));
  return mesh;
}

interface Shard {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  rot: THREE.Euler;
  spin: THREE.Vector3;
  life: number;
  size: number;
  color: THREE.Color;
}

interface EnemyView {
  group: THREE.Group;
  body: THREE.Mesh;
  core: THREE.Mesh;
  ring: THREE.Mesh;
  lane: THREE.Mesh;
  bar: THREE.Mesh;
  flash: number;
}

export class World3D {
  state: State;
  private hud: Hud;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(78, 16 / 9, 0.05, 80);
  private roomGroup = new THREE.Group();
  private enemyViews = new Map<number, EnemyView>();
  private bulletPool: THREE.Mesh[] = [];
  private tracerPool: THREE.Mesh[] = [];
  private shards: Shard[] = [];
  private shardMesh: THREE.InstancedMesh;
  private gun = new THREE.Group();
  private muzzle: THREE.Mesh;
  private muzzleLight = new THREE.PointLight(C.hot, 0, 6);
  private yaw = -Math.PI / 2;
  private keys = new Set<string>();
  private firing = false;
  private dashQueued = false;
  private acc = 0;
  private hitStop = 0;
  private slow = 0;
  private shake = 0;
  private fovKick = 0;
  private recoil = 0;
  private bob = 0;
  private hitmarker = 0;
  private hurtFlash = 0;
  private hitCrit = false;
  private dmgFlash = new Map<number, number>();
  private manual = false;
  private last = performance.now();
  private touchLook: { id: number; x: number } | null = null;
  private touchMove: { id: number; ox: number; oy: number; x: number; y: number } | null = null;
  private el: HTMLElement;

  constructor(hud: Hud, container: HTMLElement) {
    this.hud = hud;
    this.el = container;
    this.state = newRun((Date.now() & 0xffff) + 1);
    document.body.classList.add("fps");

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(2, devicePixelRatio));
    this.renderer.setClearColor(C.fog);
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.cssText = "position:fixed;inset:0;width:100%;height:100%;cursor:none;touch-action:none";

    this.scene.fog = new THREE.Fog(C.fog, 9, 30);
    this.scene.add(new THREE.HemisphereLight(0xdfe6ff, 0x1a2a9a, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(6, 12, 4);
    this.scene.add(sun, this.roomGroup, this.camera);
    this.camera.rotation.order = "YXZ";

    // Viewmodel: a blunt, two-tone rifle that kicks back on every shot.
    const navy = new THREE.MeshLambertMaterial({ color: 0x141f8a });
    const white = new THREE.MeshLambertMaterial({ color: C.white });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.075, 0.32), navy);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.062, 0.016, 0.24), white);
    stripe.position.set(0, 0.024, -0.02);
    const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.028, 0.16), navy);
    barrel.position.set(0, 0.008, -0.23);
    const mag = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.1, 0.05), white);
    mag.position.set(0, -0.07, -0.03);
    this.muzzle = new THREE.Mesh(new THREE.PlaneGeometry(0.18, 0.18), new THREE.MeshBasicMaterial({ color: C.hot, transparent: true, depthWrite: false }));
    this.muzzle.position.set(0, 0.008, -0.33);
    this.muzzleLight.position.set(0, 0.05, -0.4);
    this.gun.add(body, stripe, barrel, mag, this.muzzle, this.muzzleLight);
    this.gun.position.set(0.15, -0.14, -0.46);
    this.gun.scale.setScalar(0.8);
    this.camera.add(this.gun);

    this.shardMesh = new THREE.InstancedMesh(new THREE.TetrahedronGeometry(1), new THREE.MeshLambertMaterial({ color: 0xffffff }), 400);
    this.shardMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.shardMesh.count = 0;
    this.scene.add(this.shardMesh);

    this.bindInput();
    hud.onRestart = () => this.restart();
    hud.onDash = () => (this.dashQueued = true);
    this.buildRoom();
    this.consume(this.state.events);
    this.resize();
    addEventListener("resize", () => this.resize());
    this.renderer.setAnimationLoop(() => this.frame());
  }

  // ---------------------------------------------------------------- input

  private bindInput() {
    const canvas = this.renderer.domElement;
    addEventListener("keydown", (e) => {
      this.keys.add(e.code);
      if (e.code === "Space" || e.code === "ShiftLeft") this.dashQueued = true;
      if (e.code === "Enter" && this.state.phase === "done") this.restart();
    });
    addEventListener("keyup", (e) => this.keys.delete(e.code));
    canvas.addEventListener("mousedown", (e) => {
      unlock();
      if (document.pointerLockElement !== canvas) canvas.requestPointerLock?.()?.catch?.(() => {});
      if (e.button === 0) this.firing = true;
      if (e.button === 2) this.dashQueued = true;
    });
    addEventListener("mouseup", (e) => e.button === 0 && (this.firing = false));
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    addEventListener("mousemove", (e) => {
      if (document.pointerLockElement === canvas) this.yaw += e.movementX * 0.0024;
    });
    canvas.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "touch") return;
      this.hud.touchMode();
      if (e.clientX < innerWidth / 2) this.touchMove = { id: e.pointerId, ox: e.clientX, oy: e.clientY, x: e.clientX, y: e.clientY };
      else {
        this.touchLook = { id: e.pointerId, x: e.clientX };
        this.firing = true;
      }
    });
    canvas.addEventListener("pointermove", (e) => {
      if (this.touchLook?.id === e.pointerId) {
        this.yaw += (e.clientX - this.touchLook.x) * 0.006;
        this.touchLook.x = e.clientX;
      }
      if (this.touchMove?.id === e.pointerId) Object.assign(this.touchMove, { x: e.clientX, y: e.clientY });
    });
    const end = (e: PointerEvent) => {
      if (this.touchLook?.id === e.pointerId) {
        this.touchLook = null;
        this.firing = false;
      }
      if (this.touchMove?.id === e.pointerId) this.touchMove = null;
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
  }

  /** Movement is relative to where the camera faces: W walks toward the crosshair. */
  private readInput(): Input {
    const k = this.keys;
    let f = (k.has("KeyW") || k.has("ArrowUp") ? 1 : 0) - (k.has("KeyS") || k.has("ArrowDown") ? 1 : 0);
    let r = (k.has("KeyD") || k.has("ArrowRight") ? 1 : 0) - (k.has("KeyA") || k.has("ArrowLeft") ? 1 : 0);
    if (this.touchMove) {
      const dx = this.touchMove.x - this.touchMove.ox;
      const dy = this.touchMove.y - this.touchMove.oy;
      if (Math.hypot(dx, dy) > 8) {
        r = Math.max(-1, Math.min(1, dx / 50));
        f = Math.max(-1, Math.min(1, -dy / 50));
      }
    }
    const a = this.yaw;
    const p = this.state.player.pos;
    return {
      move: { x: Math.cos(a) * f + Math.cos(a + Math.PI / 2) * r, y: Math.sin(a) * f + Math.sin(a + Math.PI / 2) * r },
      aim: { x: p.x + Math.cos(a) * 400, y: p.y + Math.sin(a) * 400 },
      fire: this.firing,
      dash: this.dashQueued,
      reload: k.has("KeyR"),
    };
  }

  /** Automation: face a point in sim coordinates. */
  aimAt(x: number, y: number) {
    const p = this.state.player.pos;
    this.yaw = Math.atan2(y - p.y, x - p.x);
  }

  // ---------------------------------------------------------------- loop

  advance(ms: number) {
    this.manual = true;
    const n = Math.round(ms / (TICK * 1000));
    for (let i = 0; i < n; i++) this.tickOnce();
    this.present(n * TICK);
  }

  private frame() {
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    if (this.manual) return;
    if (this.hitStop > 0) this.hitStop -= dt;
    else {
      this.acc += dt * (this.slow > 0 ? 0.25 : 1);
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
    this.present(dt);
  }

  private tickOnce() {
    const room = this.state.room;
    const phase = this.state.phase;
    step(this.state, this.readInput());
    this.dashQueued = false;
    if (this.state.room !== room || (phase === "dead" && this.state.phase === "fight")) {
      this.yaw = -Math.PI / 2;
      this.buildRoom();
    }
    this.consume(this.state.events);
  }

  private restart() {
    this.state = newRun((Date.now() & 0xffff) + 1);
    this.yaw = -Math.PI / 2;
    this.hud.results(null);
    this.buildRoom();
    this.consume(this.state.events);
  }

  private resize() {
    this.renderer.setSize(innerWidth, innerHeight, false);
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
  }

  // ---------------------------------------------------------------- feel

  private consume(events: GameEvent[]) {
    for (const e of events) {
      switch (e.type) {
        case "shot":
          sfx.shot();
          this.recoil = Math.min(1, this.recoil + 0.55);
          this.muzzleLight.intensity = 18;
          this.tracer(e.pos.x, e.pos.y, e.angle);
          break;
        case "hit": {
          this.hitmarker = 0.09;
          this.hitCrit = e.crit;
          this.dmgFlash.set(e.enemy, 0.07);
          e.crit ? sfx.crit() : sfx.hit();
          this.burst(e.pos.x, e.pos.y, e.crit ? 5 : 2, e.crit ? C.hot : C.white, 3, 0.05);
          break;
        }
        case "kill":
          sfx.kill(e.streak);
          this.hitStop = e.last ? 0.09 : 0.05;
          this.shake = Math.max(this.shake, 0.05 + Math.min(e.streak, 6) * 0.015);
          this.fovKick = Math.max(this.fovKick, 4 + Math.min(e.streak, 5));
          this.burst(e.pos.x, e.pos.y, 26, C.enemy, 7, 0.14);
          this.burst(e.pos.x, e.pos.y, 6, C.white, 6, 0.1);
          if (e.last) {
            sfx.last();
            this.slow = 0.35;
          }
          break;
        case "wallHit":
          if (e.from === "player") {
            sfx.wall();
            this.burst(e.pos.x, e.pos.y, 2, 0x9fb0ff, 2.5, 0.04);
          }
          break;
        case "hurt":
          sfx.hurt();
          this.shake = 0.16;
          this.hitStop = 0.06;
          this.hurtFlash = 0.35;
          this.showDamageDirection();
          break;
        case "dash":
          sfx.dash();
          this.fovKick = Math.max(this.fovKick, 12);
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
          this.hud.banner("CLEAR", `${e.time.toFixed(1)} 秒 · 目標 ${ROOMS[e.room].par} 秒`);
          break;
        case "roomStart":
          this.hud.banner(`ROOM ${e.room + 1}`, "", true);
          break;
        case "dead":
          sfx.dead();
          this.hud.banner("DOWN", "この部屋の最初から");
          break;
        case "done":
          document.exitPointerLock?.();
          this.hud.results(this.state);
          break;
      }
    }
  }

  private burst(x: number, y: number, n: number, color: number, speed: number, size: number) {
    const c = new THREE.Color(color);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const up = Math.random() * speed * 0.8;
      this.shards.push({
        pos: toWorld(x, y, BODY_Y),
        vel: new THREE.Vector3(Math.cos(a) * speed * (0.3 + Math.random()), up, Math.sin(a) * speed * (0.3 + Math.random())),
        rot: new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6),
        spin: new THREE.Vector3(Math.random() * 20, Math.random() * 20, Math.random() * 20),
        life: 0.6 + Math.random() * 0.6,
        size: size * (0.6 + Math.random() * 0.8),
        color: c,
      });
    }
    if (this.shards.length > 400) this.shards.splice(0, this.shards.length - 400);
  }

  private tracer(x: number, y: number, angle: number) {
    const t = this.tracerPool.find((m) => !m.visible) ?? this.newTracer();
    t.visible = true;
    t.position.copy(toWorld(x, y, BODY_Y + 0.05));
    t.rotation.set(0, -angle, 0);
    t.userData.life = 0.05;
  }

  private newTracer() {
    const m = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.03, 0.03).translate(1.2, 0, 0), new THREE.MeshBasicMaterial({ color: C.white }));
    this.scene.add(m);
    this.tracerPool.push(m);
    return m;
  }

  private showDamageDirection() {
    const box = document.getElementById("dmgdir")!;
    const p = this.state.player;
    // Knockback points away from the source, so the source is the opposite of the velocity.
    const from = Math.atan2(-p.vel.y, -p.vel.x);
    const rel = from - this.yaw;
    const i = document.createElement("i");
    i.style.transform = `rotate(${rel}rad)`;
    box.appendChild(i);
    requestAnimationFrame(() => i.classList.add("on"));
    setTimeout(() => i.classList.remove("on"), 60);
    setTimeout(() => i.remove(), 700);
  }

  // ---------------------------------------------------------------- scene

  private buildRoom() {
    for (const c of [...this.roomGroup.children]) this.roomGroup.remove(c);
    for (const v of this.enemyViews.values()) this.scene.remove(v.group);
    this.enemyViews.clear();
    const s = this.state;
    const W = WORLD.w / M;
    const H = WORLD.h / M;

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshLambertMaterial({ color: C.ground }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(W / 2, 0, H / 2);
    this.roomGroup.add(floor);
    let seed = s.room * 977 + 13;
    const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const scuffMat = new THREE.MeshBasicMaterial({ color: C.scuff });
    for (let i = 0; i < 26; i++) {
      const sc = new THREE.Mesh(new THREE.PlaneGeometry(0.3 + r() * 1.5, 0.08), scuffMat);
      sc.rotation.x = -Math.PI / 2;
      sc.position.set(r() * W, 0.005, r() * H);
      this.roomGroup.add(sc);
    }

    const wallMat = new THREE.MeshLambertMaterial({ color: C.wall });
    const trimMat = new THREE.MeshBasicMaterial({ color: C.wallTrim });
    const t = WORLD.wall / M;
    const walls: [number, number, number, number][] = [
      [W / 2, t / 2, W, t],
      [W / 2, H - t / 2, W, t],
      [t / 2, H / 2, t, H],
      [W - t / 2, H / 2, t, H],
    ];
    for (const [x, z, w, d] of walls) {
      const wall = inked(new THREE.Mesh(new THREE.BoxGeometry(w, 2.6, d), wallMat));
      wall.position.set(x, 1.3, z);
      const trim = new THREE.Mesh(new THREE.BoxGeometry(w + 0.01, 0.18, d + 0.01), trimMat);
      trim.position.set(x, 0.09, z);
      this.roomGroup.add(wall, trim);
    }

    const coverMat = new THREE.MeshLambertMaterial({ color: C.cover });
    const topMat = new THREE.MeshBasicMaterial({ color: C.coverTop });
    for (const k of s.cover) {
      const w = k.w / M;
      const d = k.h / M;
      const block = inked(new THREE.Mesh(new THREE.BoxGeometry(w, 2.0, d), coverMat));
      block.position.set((k.x + k.w / 2) / M, 1.0, (k.y + k.h / 2) / M);
      const top = new THREE.Mesh(new THREE.BoxGeometry(w + 0.02, 0.06, d + 0.02), topMat);
      top.position.set(block.position.x, 2.0, block.position.z);
      this.roomGroup.add(block, top);
    }
  }

  private viewFor(e: Enemy): EnemyView {
    let v = this.enemyViews.get(e.id);
    if (v) return v;
    const r = ENEMY[e.kind].radius / M;
    const mat = new THREE.MeshLambertMaterial({ color: C.enemy, emissive: 0x3a0e00 });
    const geo =
      e.kind === "drone" ? new THREE.IcosahedronGeometry(r, 0)
      : e.kind === "rusher" ? new THREE.ConeGeometry(r * 0.9, r * 2.6, 4).rotateX(-Math.PI / 2)
      : new THREE.BoxGeometry(r * 1.8, r * 2.2, r * 1.8);
    const body = inked(new THREE.Mesh(geo, mat));
    // The core is the crit zone: a yellow eye on the side facing the player.
    const core = new THREE.Mesh(new THREE.SphereGeometry(r * GUN.critCore * 0.55, 12, 8), new THREE.MeshBasicMaterial({ color: C.hot }));
    const coreBack = new THREE.Mesh(new THREE.CircleGeometry(r * GUN.critCore * 0.95, 20), new THREE.MeshBasicMaterial({ color: C.ink, side: THREE.DoubleSide }));
    const eye = new THREE.Group();
    eye.add(coreBack, core);
    core.position.z = 0.01;
    eye.position.set(0, 0, -(e.kind === "rusher" ? r * 0.5 : r * 0.92));
    eye.rotation.y = Math.PI;
    body.add(eye);
    const ring = new THREE.Mesh(new THREE.RingGeometry(r * 1.1, r * 1.3, 32), new THREE.MeshBasicMaterial({ color: C.enemy, transparent: true, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.02;
    const lane = new THREE.Mesh(new THREE.PlaneGeometry(1, r * 2).translate(0.5, 0, 0), new THREE.MeshBasicMaterial({ color: C.enemy, transparent: true, opacity: 0.25, depthWrite: false }));
    lane.rotation.x = -Math.PI / 2;
    lane.position.y = 0.015;
    lane.visible = false;
    const bar = new THREE.Mesh(new THREE.PlaneGeometry(r * 1.8, 0.07).translate(r * 0.9, 0, 0), new THREE.MeshBasicMaterial({ color: C.white }));
    bar.visible = false;
    const group = new THREE.Group();
    group.add(body, ring, bar);
    this.scene.add(group, lane);
    group.userData.lane = lane;
    v = { group, body, core, ring, lane, bar, flash: 0 };
    this.enemyViews.set(e.id, v);
    return v;
  }

  private present(dt: number) {
    const s = this.state;
    const p = s.player;
    const t = performance.now() / 1000;

    // camera
    const moving = Math.hypot(p.vel.x, p.vel.y) / PLAYER.speed;
    this.bob += dt * 9 * moving;
    this.recoil = Math.max(0, this.recoil - dt * 6);
    this.shake = Math.max(0, this.shake - dt * 0.6);
    this.fovKick = Math.max(0, this.fovKick - dt * 40);
    const sh = this.shake;
    this.camera.position.set(p.pos.x / M + (Math.random() - 0.5) * sh, EYE + Math.sin(this.bob) * 0.035 * moving + (Math.random() - 0.5) * sh, p.pos.y / M + (Math.random() - 0.5) * sh);
    this.camera.rotation.y = Math.atan2(-Math.cos(this.yaw), -Math.sin(this.yaw));
    this.camera.rotation.x = -0.035 + this.recoil * 0.03;
    this.camera.fov = 78 + this.fovKick;
    this.camera.updateProjectionMatrix();
    this.gun.position.set(0.15 + Math.cos(this.bob * 0.5) * 0.01 * moving, -0.14 + Math.abs(Math.sin(this.bob * 0.5)) * 0.01 * moving, -0.46 + this.recoil * 0.05);
    this.gun.rotation.x = this.recoil * 0.14;
    this.gun.visible = s.phase !== "dead";
    this.muzzleLight.intensity = Math.max(0, this.muzzleLight.intensity - dt * 220);
    (this.muzzle.material as THREE.MeshBasicMaterial).opacity = Math.min(1, this.muzzleLight.intensity / 10);
    this.muzzle.rotation.z = Math.random() * 3;

    // enemies
    const alive = new Set(s.enemies.map((e) => e.id));
    for (const [id, v] of this.enemyViews)
      if (!alive.has(id)) {
        this.scene.remove(v.group, v.lane);
        this.enemyViews.delete(id);
      }
    for (const e of s.enemies) {
      const v = this.viewFor(e);
      const r = ENEMY[e.kind].radius / M;
      const spawning = e.mode === "spawning";
      const hover = e.kind === "drone" ? Math.sin(t * 3 + e.id) * 0.12 : 0;
      v.group.position.set(e.pos.x / M, 0, e.pos.y / M);
      v.body.position.y = spawning ? -r * 2 * Math.min(1, e.timer) + BODY_Y * 0.4 : e.kind === "gunner" ? r * 1.1 + 0.25 : BODY_Y + hover;
      v.body.rotation.set(0, Math.atan2(-Math.cos(e.facing), -Math.sin(e.facing)), 0);
      if (e.kind === "drone") v.body.rotation.z = t * 2 + e.id;
      const flash = (this.dmgFlash.get(e.id) ?? 0) > 0;
      if (flash) this.dmgFlash.set(e.id, (this.dmgFlash.get(e.id) ?? 0) - dt);
      const tele = e.mode === "telegraph";
      const mat = v.body.material as THREE.MeshLambertMaterial;
      mat.color.setHex(flash ? C.enemyFlash : e.mode === "recover" ? C.enemyRecover : C.enemy);
      mat.emissive.setHex(tele && Math.sin(t * 40) > 0 ? 0xffffff : 0x3a0e00);
      v.body.scale.setScalar(tele ? 1.08 : 1);
      v.ring.visible = spawning || tele;
      v.ring.scale.setScalar(spawning ? 1 + Math.max(0, e.timer) * 2 : 1.2);
      (v.ring.material as THREE.MeshBasicMaterial).color.setHex(tele ? C.white : C.enemy);
      v.lane.visible = e.kind === "rusher" && tele;
      if (v.lane.visible) {
        const k = 1 - e.timer / ENEMY.rusher.telegraph;
        v.lane.position.set(e.pos.x / M, 0.015, e.pos.y / M);
        v.lane.rotation.set(-Math.PI / 2, 0, -e.aimLock);
        v.lane.scale.set(((RUSH.speed * RUSH.time) / M) * (0.3 + 0.7 * k), 1, 1);
      }
      v.bar.visible = e.hp < ENEMY[e.kind].hp && !spawning;
      if (v.bar.visible) {
        v.bar.position.set(-r * 0.9 * Math.cos(this.yaw + Math.PI / 2), v.body.position.y + r * 1.6, 0);
        v.bar.scale.x = e.hp / ENEMY[e.kind].hp;
        v.bar.lookAt(this.camera.position);
      }
    }

    // bullets
    let bi = 0;
    for (const b of s.bullets) {
      if (b.from !== "enemy") continue;
      const m = this.bulletPool[bi] ?? this.newBullet();
      m.visible = true;
      m.position.copy(toWorld(b.pos.x, b.pos.y, BODY_Y));
      bi++;
    }
    for (let i = bi; i < this.bulletPool.length; i++) this.bulletPool[i].visible = false;
    for (const tr of this.tracerPool) {
      if (!tr.visible) continue;
      tr.userData.life -= dt;
      if (tr.userData.life <= 0) tr.visible = false;
    }

    this.hurtFlash = Math.max(0, this.hurtFlash - dt);
    this.hud.hurt(this.hurtFlash / 0.35);
    this.updateShards(dt);
    this.updateOverlay(dt);
    this.hud.update(s, 0);
    this.renderer.render(this.scene, this.camera);
  }

  private newBullet() {
    const r = 11 / M;
    const m = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10), new THREE.MeshBasicMaterial({ color: C.enemy }));
    const inner = new THREE.Mesh(new THREE.SphereGeometry(r * 0.5, 10, 8), new THREE.MeshBasicMaterial({ color: C.white }));
    m.add(inner);
    this.scene.add(m);
    this.bulletPool.push(m);
    return m;
  }

  private updateShards(dt: number) {
    const dummy = new THREE.Object3D();
    const keep: Shard[] = [];
    let i = 0;
    for (const sh of this.shards) {
      sh.life -= dt;
      if (sh.life <= 0) continue;
      sh.vel.y -= 14 * dt;
      sh.pos.addScaledVector(sh.vel, dt);
      if (sh.pos.y < 0.03) {
        sh.pos.y = 0.03;
        sh.vel.y *= -0.35;
        sh.vel.x *= 0.6;
        sh.vel.z *= 0.6;
      }
      sh.rot.x += sh.spin.x * dt;
      sh.rot.y += sh.spin.y * dt;
      dummy.position.copy(sh.pos);
      dummy.rotation.copy(sh.rot);
      dummy.scale.setScalar(sh.size * Math.min(1, sh.life * 3));
      dummy.updateMatrix();
      this.shardMesh.setMatrixAt(i, dummy.matrix);
      this.shardMesh.setColorAt(i, sh.color);
      i++;
      keep.push(sh);
    }
    this.shards = keep;
    this.shardMesh.count = i;
    this.shardMesh.instanceMatrix.needsUpdate = true;
    if (this.shardMesh.instanceColor) this.shardMesh.instanceColor.needsUpdate = true;
  }

  /** Crosshair state, and edge arrows for enemies outside the field of view. */
  private updateOverlay(dt: number) {
    const x = document.getElementById("xhair")!;
    this.hitmarker = Math.max(0, this.hitmarker - dt);
    x.classList.toggle("hit", this.hitmarker > 0 && !this.hitCrit);
    x.classList.toggle("crit", this.hitmarker > 0 && this.hitCrit);
    const p = this.state.player;
    x.style.setProperty("--gap", `${8 + this.recoil * 10 + (p.reload > 0 ? 6 : 0)}px`);
    const onTarget = this.state.enemies.some((e) => {
      if (e.mode === "spawning") return false;
      const d = Math.hypot(e.pos.x - p.pos.x, e.pos.y - p.pos.y);
      const err = Math.abs(Math.atan2(Math.sin(Math.atan2(e.pos.y - p.pos.y, e.pos.x - p.pos.x) - this.yaw), Math.cos(Math.atan2(e.pos.y - p.pos.y, e.pos.x - p.pos.x) - this.yaw)));
      return err < Math.atan2(ENEMY[e.kind].radius, d);
    });
    x.classList.toggle("on-target", onTarget);

    const box = document.getElementById("arrows")!;
    const half = ((this.camera.fov / 2) * Math.PI) / 180 * this.camera.aspect * 0.62;
    const marks: string[] = [];
    for (const e of this.state.enemies) {
      if (e.mode === "spawning") continue;
      const a = Math.atan2(e.pos.y - p.pos.y, e.pos.x - p.pos.x) - this.yaw;
      const rel = Math.atan2(Math.sin(a), Math.cos(a));
      if (Math.abs(rel) < half) continue;
      // Project the direction onto the screen border so the arrow sits at the edge it points to.
      const dx = Math.sin(rel);
      const dy = -Math.cos(rel);
      const k = Math.min((innerWidth / 2 - 34) / Math.max(1e-3, Math.abs(dx)), (innerHeight / 2 - 34) / Math.max(1e-3, Math.abs(dy)));
      const cx = innerWidth / 2 + dx * k;
      const cy = innerHeight / 2 + dy * k;
      marks.push(`<i class="${e.mode === "telegraph" ? "tele" : ""}" style="left:${cx - 11}px;top:${cy - 9}px;transform:rotate(${rel}rad)"></i>`);
    }
    box.innerHTML = marks.join("");
  }
}
