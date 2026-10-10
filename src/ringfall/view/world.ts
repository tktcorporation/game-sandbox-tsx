import * as THREE from "three";
import { ENEMIES, PLAYER, TITAN, WEAPONS, WORLD, type EnemyKind } from "../sim/config";
import { BOXES, EXTRACT, POIS } from "../sim/map";
import type { GameEvent, State, Vec3 } from "../sim/state";
import { PAL, RARITY_COLOR, buildBin, buildBox, mergeStatic, buildCare, buildDropship, buildEnemy, buildGun, buildLootItem, flat, glow, haloSprite, type EnemyModel } from "./models";

/*
 * Renders a State in first person. It reads the state and the tick's events and
 * turns them into feel (particles, flashes, recoil, FOV, shake). It never
 * changes the state.
 */

const EYE_LERP = 12;

interface Particle {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  max: number;
  size: number;
  color: THREE.Color;
  gravity: number;
}

interface EnemyView {
  m: EnemyModel;
  kind: EnemyKind;
  flash: number;
  shieldFlash: number;
  walk: number;
  spawnBeam: THREE.Mesh | null;
  lane: THREE.Mesh | null;
}

interface Tracer {
  mesh: THREE.Mesh;
  life: number;
}

export class World {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(72, 16 / 9, 0.05, 900);
  private gunScene = new THREE.Scene();
  private gunCam = new THREE.PerspectiveCamera(55, 16 / 9, 0.01, 10);
  private sun = new THREE.DirectionalLight(0xfff1d6, 2.2);
  private enemies = new Map<number, EnemyView>();
  private loot = new Map<number, THREE.Group>();
  private bins = new Map<number, ReturnType<typeof buildBin>>();
  private orbPool: THREE.Group[] = [];
  private wavePool: THREE.Mesh[] = [];
  private tracers: Tracer[] = [];
  private particles: Particle[] = [];
  private partMesh: THREE.InstancedMesh;
  private ringMesh: THREE.Mesh;
  private ringMat: THREE.ShaderMaterial;
  private care: THREE.Group | null = null;
  private careBeam: THREE.Mesh;
  private dropship: THREE.Group | null = null;
  private extractRing: THREE.Mesh;
  private stompRing: THREE.Mesh;
  private gun = new THREE.Group();
  private gunKey = "";
  private flash: THREE.Sprite;
  private muzzleLight = new THREE.PointLight(0xffd27a, 0, 8, 2);
  private clouds: THREE.Sprite[] = [];
  private dummy = new THREE.Object3D();

  /** Automation only: a fixed camera that replaces the player's view. */
  cameraOverride: { x: number; y: number; z: number; yaw: number; pitch: number } | null = null;

  // Feel state.
  private eyeY = PLAYER.eye;
  private shake = 0;
  private fovKick = 0;
  private gunKick = 0;
  private bob = 0;
  private landDip = 0;
  private time = 0;
  private recoilView = 0;

  constructor(container: HTMLElement, opts: { lowPower?: boolean } = {}) {
    this.renderer = new THREE.WebGLRenderer({ antialias: !opts.lowPower, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, opts.lowPower ? 1.5 : 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.autoClear = false;
    container.appendChild(this.renderer.domElement);

    this.scene.fog = new THREE.Fog(PAL.skyHorizon, 110, 420);
    this.scene.add(this.sky());
    this.scene.add(new THREE.HemisphereLight(0xcfe9ff, 0xb98a55, 1.15));
    this.sun.position.set(-40, 80, 30);
    this.sun.castShadow = true;
    const shadowSize = opts.lowPower ? 1024 : 2048;
    this.sun.shadow.mapSize.set(shadowSize, shadowSize);
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -55;
    sc.right = sc.top = 55;
    sc.near = 1;
    sc.far = 220;
    this.sun.shadow.bias = -0.0006;
    this.scene.add(this.sun, this.sun.target);
    this.scene.add(this.terrain());
    const statics = new THREE.Group();
    BOXES.forEach((b, i) => statics.add(buildBox(b, i)));
    this.scene.add(mergeStatic(statics));
    this.scatterRocks();
    this.addClouds();

    this.ringMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: { time: { value: 0 }, color: { value: new THREE.Color(PAL.ring) } },
      vertexShader: `varying vec2 vUv; varying vec3 vWorld;
        void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position,1.0); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: `uniform float time; uniform vec3 color; varying vec2 vUv; varying vec3 vWorld;
        void main(){
          float d = distance(cameraPosition.xz, vWorld.xz);
          float near = 1.0 - smoothstep(6.0, 45.0, d);
          float band = step(0.82, fract(vUv.x * 220.0 + time * 0.25));
          float height = 1.0 - smoothstep(0.0, 0.35, vUv.y);
          float a = (0.05 + band * 0.05) * (0.35 + 0.65 * height) + near * (0.28 + band * 0.12);
          gl_FragColor = vec4(color, a);
        }`,
    });
    this.ringMesh = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 128, 1, true), this.ringMat);
    this.ringMesh.renderOrder = 2;
    this.scene.add(this.ringMesh);

    this.partMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff }), 700);
    this.partMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.partMesh.count = 0;
    this.partMesh.frustumCulled = false;
    this.scene.add(this.partMesh);

    this.careBeam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.6, 0.6, 120, 10, 1, true),
      new THREE.MeshBasicMaterial({ color: RARITY_COLOR[3], transparent: true, opacity: 0.22, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    this.careBeam.visible = false;
    this.scene.add(this.careBeam);

    this.extractRing = new THREE.Mesh(new THREE.RingGeometry(EXTRACT.radius - 0.4, EXTRACT.radius, 48), glow(PAL.hot, 0.8));
    this.extractRing.rotation.x = -Math.PI / 2;
    this.extractRing.position.set(EXTRACT.x, 0.3, EXTRACT.z);
    this.extractRing.visible = false;
    this.scene.add(this.extractRing);

    this.stompRing = new THREE.Mesh(new THREE.RingGeometry(0.96, 1, 64), glow(PAL.orb, 0.5));
    this.stompRing.rotation.x = -Math.PI / 2;
    this.stompRing.visible = false;
    this.scene.add(this.stompRing);

    // First-person gun, drawn in its own pass so it never clips into walls.
    this.gunScene.add(new THREE.HemisphereLight(0xdff2ff, 0x8a6a3a, 1.6));
    const gl = new THREE.DirectionalLight(0xfff1d6, 1.6);
    gl.position.set(-1, 2, 1);
    this.gunScene.add(gl);
    this.gunScene.add(this.gun);
    this.flash = haloSprite(0xffd27a, 0.35, 0);
    this.gunScene.add(this.flash);
    this.scene.add(this.muzzleLight);
  }

  private sky(): THREE.Mesh {
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: { top: { value: new THREE.Color(PAL.skyTop) }, horizon: { value: new THREE.Color(PAL.skyHorizon) } },
      vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 top; uniform vec3 horizon; varying vec3 vDir;
        void main(){
          float h = clamp(vDir.y, 0.0, 1.0);
          vec3 c = mix(horizon, top, pow(h, 0.55));
          vec3 sunDir = normalize(vec3(-0.45, 0.6, 0.35));
          float s = max(dot(vDir, sunDir), 0.0);
          c += vec3(1.0, 0.92, 0.75) * (pow(s, 600.0) * 1.2 + pow(s, 12.0) * 0.18);
          if (vDir.y < 0.0) c = horizon;
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    const m = new THREE.Mesh(new THREE.SphereGeometry(800, 32, 16), mat);
    m.renderOrder = -1;
    return m;
  }

  /** Terrain height: flat inside the island, rising into canyon walls outside it. */
  private height = (_x: number, _z: number) => 0;

  private terrain(): THREE.Mesh {
    const size = 900;
    const seg = 150;
    const geo = new THREE.PlaneGeometry(size, size, seg, seg).rotateX(-Math.PI / 2).toNonIndexed();
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const sand = new THREE.Color(PAL.sand);
    const dark = new THREE.Color(PAL.sandDark);
    const rock = new THREE.Color(PAL.rock);
    const rockDark = new THREE.Color(PAL.rockDark);
    const hash = (x: number, z: number) => {
      const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
      return s - Math.floor(s);
    };
    const vnoise = (x: number, z: number) => {
      const xi = Math.floor(x);
      const zi = Math.floor(z);
      const xf = x - xi;
      const zf = z - zi;
      const u = xf * xf * (3 - 2 * xf);
      const v = zf * zf * (3 - 2 * zf);
      const a = hash(xi, zi);
      const b = hash(xi + 1, zi);
      const c = hash(xi, zi + 1);
      const d = hash(xi + 1, zi + 1);
      return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
    };
    const height = (x: number, z: number) => {
      const m = Math.max(Math.abs(x), Math.abs(z));
      const edge = WORLD.half + 6;
      if (m < edge) return 0;
      const t = m - edge;
      return Math.min(46, Math.pow(t, 1.15) * 0.9) * (0.75 + vnoise(x * 0.05, z * 0.05) * 0.5) + vnoise(x * 0.2, z * 0.2) * Math.min(t, 6);
    };
    this.height = height;
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const h = height(x, z);
      pos.setY(i, h);
      const n = vnoise(x * 0.08, z * 0.08);
      if (h > 1.5) c.copy(rock).lerp(rockDark, vnoise(x * 0.3, z * 0.1 + h * 0.2));
      else c.copy(sand).lerp(dark, n > 0.62 ? 0.7 : n * 0.3);
      colors.set([c.r, c.g, c.b], i * 3);
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
    m.receiveShadow = true;
    return m;
  }

  private scatterRocks() {
    let r = 11;
    const rnd = () => ((r = (r * 16807) % 2147483647) / 2147483647);
    const geo = new THREE.DodecahedronGeometry(1, 0);
    // Boulders along the foot of the canyon walls, just outside the playable square.
    for (let i = 0; i < 90; i++) {
      const side = Math.floor(rnd() * 4);
      const along = (rnd() - 0.5) * 210;
      const out = WORLD.half + 2 + rnd() * 6;
      const x = side === 0 ? out : side === 1 ? -out : along;
      const z = side === 2 ? out : side === 3 ? -out : along;
      const m = new THREE.Mesh(geo, flat(rnd() < 0.5 ? PAL.rock : PAL.rockDark));
      const s = 1.5 + rnd() * 3.5;
      m.scale.set(s, s * (0.6 + rnd() * 0.9), s);
      m.rotation.set(rnd(), rnd() * 6, rnd());
      m.position.set(x, this.height(x, z) - s * 0.3, z);
      m.castShadow = true;
      this.scene.add(m);
    }
  }

  private addClouds() {
    for (let i = 0; i < 26; i++) {
      const s = haloSprite(0xffffff, 30 + (i % 5) * 9, 0.55);
      s.material.blending = THREE.NormalBlending;
      s.position.set(Math.sin(i * 2.4) * 120, 55 + (i % 7) * 9, 40 + Math.cos(i * 1.7) * 110);
      this.clouds.push(s);
      this.scene.add(s);
    }
  }

  resize(w: number, h: number) {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.gunCam.aspect = w / h;
    this.gunCam.updateProjectionMatrix();
  }

  /** Screen position (CSS px) of a world point, or null when behind the camera. */
  project(p: Vec3, w: number, h: number): { x: number; y: number; behind: boolean } {
    const v = new THREE.Vector3(p.x, p.y, p.z).project(this.camera);
    const behind = v.z > 1;
    return { x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h, behind };
  }

  private burst(at: Vec3, color: number, n: number, speed: number, size = 0.08, gravity = 9, life = 0.5) {
    for (let i = 0; i < n && this.particles.length < 700; i++) {
      const a = Math.random() * Math.PI * 2;
      const b = (Math.random() - 0.3) * Math.PI;
      const sp = speed * (0.4 + Math.random() * 0.8);
      this.particles.push({
        pos: new THREE.Vector3(at.x, at.y, at.z),
        vel: new THREE.Vector3(Math.cos(a) * Math.cos(b) * sp, Math.sin(b) * sp + speed * 0.3, Math.sin(a) * Math.cos(b) * sp),
        life: life * (0.6 + Math.random() * 0.6),
        max: life,
        size: size * (0.6 + Math.random() * 0.8),
        color: new THREE.Color(color),
        gravity,
      });
    }
  }

  private tracer(from: Vec3, to: Vec3, color: number, width: number) {
    let t = this.tracers.find((x) => x.life <= 0);
    if (!t) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      t = { mesh, life: 0 };
      this.tracers.push(t);
      this.scene.add(mesh);
    }
    const a = new THREE.Vector3(from.x, from.y, from.z);
    const b = new THREE.Vector3(to.x, to.y, to.z);
    const len = a.distanceTo(b);
    t.mesh.position.copy(a).lerp(b, 0.5);
    t.mesh.lookAt(b);
    t.mesh.scale.set(width, width, len);
    (t.mesh.material as THREE.MeshBasicMaterial).color.setHex(color);
    (t.mesh.material as THREE.MeshBasicMaterial).opacity = 0.9;
    t.mesh.visible = true;
    t.life = 0.07;
  }

  /** Where the gun's muzzle is in the world, for tracers. */
  private muzzleWorld(): THREE.Vector3 {
    const v = new THREE.Vector3(0.22, -0.2, -0.7);
    return v.applyMatrix4(this.camera.matrixWorld);
  }

  /** Turn this tick's events into visual feel. Returns hit-stop seconds and slow-motion request. */
  handle(s: State, events: GameEvent[]): { hitstop: number; slowmo: number } {
    let hitstop = 0;
    let slowmo = 0;
    const ult = s.player.ultTime > 0;
    for (const e of events) {
      switch (e.t) {
        case "shot": {
          const spec = WEAPONS[e.weapon];
          this.gunKick = Math.min(1, this.gunKick + (e.weapon === "maul" || e.weapon === "lance" ? 1 : 0.45));
          this.recoilView += spec.recoil;
          this.flash.material.opacity = 1;
          this.flash.scale.setScalar(e.weapon === "maul" ? 0.6 : 0.35 + Math.random() * 0.1);
          this.muzzleLight.intensity = 6;
          this.shake = Math.max(this.shake, e.weapon === "maul" ? 0.35 : e.weapon === "lance" ? 0.3 : 0.08);
          break;
        }
        case "tracer":
          this.tracer(this.muzzleWorld(), e.to, ult ? RARITY_COLOR[3] : e.hit ? 0xfff3c4 : 0xffffff, ult ? 0.05 : 0.025);
          break;
        case "impact":
          this.burst(e.pos, PAL.sandDark, 4, 3, 0.06, 12, 0.35);
          break;
        case "hit": {
          const v = this.enemies.get(e.id);
          if (v) {
            v.flash = 0.07;
            if (e.shield) v.shieldFlash = 0.18;
          }
          this.burst(e.pos, e.crit ? PAL.hot : e.shield ? RARITY_COLOR[e.tier] : 0xffffff, e.crit ? 7 : 4, 4, 0.06, 6, 0.3);
          break;
        }
        case "shieldBreak":
          this.burst(e.pos, RARITY_COLOR[e.tier], 26, 7, 0.1, 5, 0.7);
          hitstop = Math.max(hitstop, 0.05);
          break;
        case "kill": {
          const v = this.enemies.get(e.id);
          const big = e.kind === "titan" ? 4 : e.kind === "heavy" ? 2 : 1;
          this.burst(e.pos, PAL.armorLight, 18 * big, 7 * Math.sqrt(big), 0.16 * Math.sqrt(big), 14, 1.1);
          this.burst(e.pos, PAL.eye, 6 * big, 5, 0.08, 4, 0.5);
          this.burst(e.pos, 0xffc070, 10 * big, 9, 0.06, 2, 0.35);
          if (v) {
            this.scene.remove(v.m.root);
            if (v.lane) this.scene.remove(v.lane);
            if (v.spawnBeam) this.scene.remove(v.spawnBeam);
            this.enemies.delete(e.id);
          }
          hitstop = Math.max(hitstop, e.kind === "titan" ? 0.2 : 0.04);
          this.shake = Math.max(this.shake, e.kind === "titan" ? 1.4 : 0.25);
          if (e.last || e.kind === "titan") slowmo = e.kind === "titan" ? 1.2 : 0.4;
          break;
        }
        case "hurt":
          this.shake = Math.max(this.shake, 0.25 + e.dmg * 0.012);
          break;
        case "slide":
          this.fovKick = Math.max(this.fovKick, 8);
          this.burst({ x: s.player.pos.x, y: 0.1, z: s.player.pos.z }, PAL.sandDark, 8, 2, 0.08, 6, 0.5);
          break;
        case "land":
          this.landDip = Math.min(0.35, e.speed * 0.02);
          if (e.speed > 10) this.burst({ x: s.player.pos.x, y: 0.1, z: s.player.pos.z }, PAL.sand, 30, 6, 0.12, 8, 0.9);
          break;
        case "tactical":
          for (const t of e.targets) {
            this.tracer(this.muzzleWorld(), t, 0x9fe8ff, 0.08);
            this.burst(t, 0x9fe8ff, 14, 6, 0.07, 3, 0.5);
          }
          this.fovKick = Math.max(this.fovKick, 3);
          break;
        case "ultStart":
          this.fovKick = Math.max(this.fovKick, 10);
          break;
        case "enemyFire":
          this.burst(e.pos, PAL.orb, 3, 2, 0.06, 0, 0.25);
          break;
        case "stomp":
          this.shake = Math.max(this.shake, 0.9);
          this.burst({ x: e.x, y: 0.2, z: e.z }, PAL.sand, 60, 10, 0.18, 10, 1.0);
          break;
        case "careLand":
          this.shake = Math.max(this.shake, 0.5);
          this.burst({ x: e.x, y: 0.2, z: e.z }, PAL.sand, 40, 7, 0.14, 8, 1.0);
          break;
        case "binOpen":
          break;
        case "spawn":
          break;
      }
    }
    return { hitstop, slowmo };
  }

  /** Per-frame sync. `dt` is real seconds since the last frame. */
  render(s: State, dt: number) {
    this.time += dt;
    const p = s.player;
    const w0 = p.weapons[p.slot];

    // --- camera
    const crouched = p.crouch || p.sliding || p.downed > 0;
    const targetEye = p.downed > 0 ? 0.6 : crouched ? PLAYER.eyeCrouch : PLAYER.eye;
    this.eyeY += (targetEye - this.eyeY) * Math.min(1, dt * EYE_LERP);
    const speed = Math.hypot(p.vel.x, p.vel.z);
    if (p.onGround && speed > 0.5 && !p.sliding) this.bob += dt * speed * 1.6;
    this.landDip *= Math.exp(-dt * 8);
    this.shake *= Math.exp(-dt * 7);
    this.recoilView *= Math.exp(-dt / 0.12);
    const shakeX = (Math.random() - 0.5) * this.shake * 0.05;
    const shakeY = (Math.random() - 0.5) * this.shake * 0.05;
    const bobY = Math.sin(this.bob * 2) * 0.035 * (p.ads > 0.5 ? 0.2 : 1);
    const drop = s.phase === "drop";
    this.camera.position.set(p.pos.x, p.pos.y + (drop ? 1.6 : this.eyeY) + bobY - this.landDip, p.pos.z);
    this.camera.rotation.set(p.pitch + (p.recoil * Math.PI) / 180 + shakeY, -p.yaw + shakeX, p.sliding ? -0.04 : 0, "YXZ");
    const spec = w0 ? WEAPONS[w0.kind] : WEAPONS.pike;
    const baseFov = 74 + (p.sprinting ? 4 : 0) + (p.ultTime > 0 ? 4 : 0) + (drop ? 10 : 0);
    const fovTarget = baseFov + (spec.adsFov - 74) * p.ads;
    this.fovKick *= Math.exp(-dt * 2.2);
    const fov = fovTarget + this.fovKick;
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov += (fov - this.camera.fov) * Math.min(1, dt * 14);
      this.camera.updateProjectionMatrix();
    }
    const cam = this.cameraOverride;
    if (cam) {
      this.camera.position.set(cam.x, cam.y, cam.z);
      this.camera.rotation.set(cam.pitch, -cam.yaw, 0, "YXZ");
    }
    this.camera.updateMatrixWorld();

    // Shadows follow the camera.
    const fx = this.camera.position.x;
    const fz = this.camera.position.z;
    this.sun.position.set(fx - 40, 80, fz + 30);
    this.sun.target.position.set(fx, 0, fz);

    // --- ring
    const r = s.ring;
    this.ringMesh.scale.set(r.r, 140, r.r);
    this.ringMesh.position.set(r.x, 70, r.z);
    this.ringMat.uniforms.time.value = this.time;

    for (const c of this.clouds) c.visible = drop || p.pos.y > 30;

    // --- enemies
    for (const e of s.enemies) {
      let v = this.enemies.get(e.id);
      if (!v) {
        const m = buildEnemy(e.kind);
        this.scene.add(m.root);
        const beam = new THREE.Mesh(
          new THREE.CylinderGeometry(0.06, ENEMIES[e.kind].radius * 0.45, 40, 8, 1, true),
          new THREE.MeshBasicMaterial({ color: PAL.eye, transparent: true, opacity: 0.3, depthWrite: false, blending: THREE.AdditiveBlending }),
        );
        beam.position.set(e.pos.x, 20, e.pos.z);
        this.scene.add(beam);
        v = { m, kind: e.kind, flash: 0, shieldFlash: 0, walk: 0, spawnBeam: beam, lane: null };
        this.enemies.set(e.id, v);
      }
      const k = ENEMIES[e.kind];
      const m = v.m;
      m.root.position.set(e.pos.x, e.pos.y + (k.fly > 0 ? Math.sin(this.time * 3 + e.id) * 0.12 : 0), e.pos.z);
      m.body.rotation.y = -e.yaw;
      if (e.mode === "spawning") {
        const t = Math.max(0, 1 - e.timer / (e.kind === "titan" ? 2.2 : 0.9));
        m.root.scale.setScalar(0.2 + 0.8 * t);
        if (k.fly > 0) m.root.position.y = k.fly + (1 - t) * 10;
      } else {
        m.root.scale.setScalar(1);
        if (v.spawnBeam) {
          this.scene.remove(v.spawnBeam);
          v.spawnBeam = null;
        }
      }
      if (v.spawnBeam) (v.spawnBeam.material as THREE.MeshBasicMaterial).opacity = 0.15 + Math.random() * 0.1;
      const sp = Math.hypot(e.vel.x, e.vel.z);
      v.walk += dt * sp * (e.kind === "titan" ? 0.9 : 2.6);
      m.legs.forEach((leg, i) => (leg.rotation.x = Math.sin(v!.walk + i * Math.PI) * Math.min(0.6, sp * 0.15)));
      if (k.fly > 0) m.body.rotation.z = Math.sin(this.time * 2 + e.id) * 0.15;
      const winding = e.mode === "telegraph" || e.mode === "stomp";
      const tele = winding ? 1 + Math.sin(this.time * 40) * 0.25 + 0.6 : e.mode === "stunned" ? 0.4 : 1;
      m.eye.scale.setScalar(tele);
      m.eyeHalo.scale.setScalar(k.weakR * (winding ? 9 : 4));
      (m.eyeHalo.material as THREE.SpriteMaterial).opacity = winding ? 0.95 : 0.55;
      (m.eye.material as THREE.MeshBasicMaterial).color.setHex(e.mode === "stunned" ? 0x9fe8ff : PAL.eye);
      v.flash = Math.max(0, v.flash - dt);
      for (const mat of m.mats) mat.emissive.setHex(v.flash > 0 ? 0xffffff : e.mode === "stunned" ? 0x1f4b5c : 0x000000);
      v.shieldFlash = Math.max(0, v.shieldFlash - dt);
      const sm = m.shield.material as THREE.MeshBasicMaterial;
      sm.opacity = v.shieldFlash * 3;
      sm.color.setHex(RARITY_COLOR[k.shieldTier]);
      m.shield.rotation.y += dt * 2;
      // Charger: a lane on the ground shows where the lunge will go.
      if (e.kind === "charger") {
        if (e.mode === "telegraph") {
          if (!v.lane) {
            v.lane = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 8).rotateX(-Math.PI / 2).translate(0, 0, -4), glow(PAL.orb, 0.35));
            this.scene.add(v.lane);
          }
          v.lane.position.set(e.pos.x, e.pos.y + 0.05, e.pos.z);
          v.lane.rotation.y = -e.aimYaw;
        } else if (v.lane) {
          this.scene.remove(v.lane);
          v.lane = null;
        }
      }
      if (e.kind === "titan") {
        this.stompRing.visible = e.mode === "stomp";
        if (e.mode === "stomp") {
          const t = 1 - e.timer / TITAN.stompTelegraph;
          const rr = TITAN.stompRange * Math.min(1, t * 1.2);
          this.stompRing.scale.setScalar(rr);
          this.stompRing.position.set(e.pos.x, 0.06, e.pos.z);
        }
      }
    }
    for (const [id, v] of this.enemies) {
      if (!s.enemies.some((e) => e.id === id)) {
        this.scene.remove(v.m.root);
        if (v.lane) this.scene.remove(v.lane);
        if (v.spawnBeam) this.scene.remove(v.spawnBeam);
        this.enemies.delete(id);
      }
    }
    if (!s.enemies.some((e) => e.kind === "titan" && e.mode === "stomp")) this.stompRing.visible = false;

    // --- enemy fire
    s.orbs.forEach((o, i) => {
      let g = this.orbPool[i];
      if (!g) {
        g = new THREE.Group();
        g.add(new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), glow(PAL.orb)));
        g.add(new THREE.Mesh(new THREE.SphereGeometry(0.55, 10, 6), glow(0xffffff)));
        g.add(haloSprite(PAL.orb, 4.2, 0.85));
        this.orbPool.push(g);
        this.scene.add(g);
      }
      g.visible = true;
      g.position.set(o.pos.x, o.pos.y, o.pos.z);
      g.scale.setScalar(o.r * (1 + Math.sin(this.time * 30 + o.id) * 0.08));
    });
    for (let i = s.orbs.length; i < this.orbPool.length; i++) this.orbPool[i].visible = false;
    s.waves.forEach((wv, i) => {
      let m = this.wavePool[i];
      if (!m) {
        m = new THREE.Mesh(
          new THREE.CylinderGeometry(1, 1, 1, 72, 1, true),
          new THREE.MeshBasicMaterial({ color: PAL.orb, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }),
        );
        this.wavePool.push(m);
        this.scene.add(m);
      }
      m.visible = true;
      m.scale.set(wv.r, TITAN.stompHeight, wv.r);
      m.position.set(wv.x, wv.y + TITAN.stompHeight / 2, wv.z);
    });
    for (let i = s.waves.length; i < this.wavePool.length; i++) this.wavePool[i].visible = false;

    // --- loot
    for (const l of s.loot) {
      let g = this.loot.get(l.id);
      if (!g) {
        g = buildLootItem(l.kind, l.rarity, l.weapon?.kind);
        this.loot.set(l.id, g);
        this.scene.add(g);
      }
      g.position.set(l.pos.x, l.pos.y + (l.kind === "shard" ? 0.5 : 0), l.pos.z);
      g.rotation.y = this.time * (l.kind === "shard" ? 5 : 1.2) + l.id;
    }
    for (const [id, g] of this.loot) {
      if (!s.loot.some((l) => l.id === id)) {
        this.scene.remove(g);
        this.loot.delete(id);
      }
    }
    for (const b of s.bins) {
      let v = this.bins.get(b.id);
      if (!v) {
        v = buildBin();
        v.root.position.set(b.x, b.y, b.z);
        this.bins.set(b.id, v);
        this.scene.add(v.root);
      }
      v.lid.rotation.x += ((b.open ? -1.9 : 0) - v.lid.rotation.x) * Math.min(1, dt * 10);
      (v.seam.material as THREE.MeshBasicMaterial).color.setHex(b.open ? 0x3a3f4a : 0xffffff);
    }
    if (s.care) {
      if (!this.care) {
        this.care = buildCare();
        this.scene.add(this.care);
      }
      this.care.position.set(s.care.x, s.care.y, s.care.z);
      this.careBeam.visible = !s.care.open;
      this.careBeam.position.set(s.care.x, 60, s.care.z);
    }

    // --- extraction
    this.extractRing.visible = s.phase === "extract";
    if (s.phase === "extract" || s.phase === "done") {
      if (!this.dropship) {
        this.dropship = buildDropship();
        this.dropship.position.set(EXTRACT.x, 40, EXTRACT.z - 2);
        this.scene.add(this.dropship);
      }
      this.dropship.position.y += (4.5 - this.dropship.position.y) * Math.min(1, dt * 0.8);
      this.dropship.rotation.z = Math.sin(this.time * 1.3) * 0.03;
    }

    // --- particles and tracers
    let n = 0;
    this.particles = this.particles.filter((q) => (q.life -= dt) > 0);
    for (const q of this.particles) {
      q.vel.y -= q.gravity * dt;
      q.pos.addScaledVector(q.vel, dt);
      if (q.pos.y < 0.03) {
        q.pos.y = 0.03;
        q.vel.multiplyScalar(0.4);
      }
      this.dummy.position.copy(q.pos);
      this.dummy.rotation.set(q.life * 9, q.life * 7, 0);
      this.dummy.scale.setScalar(q.size * Math.min(1, (q.life / q.max) * 2));
      this.dummy.updateMatrix();
      this.partMesh.setMatrixAt(n, this.dummy.matrix);
      this.partMesh.setColorAt(n, q.color);
      n++;
    }
    this.partMesh.count = n;
    this.partMesh.instanceMatrix.needsUpdate = true;
    if (this.partMesh.instanceColor) this.partMesh.instanceColor.needsUpdate = true;
    for (const t of this.tracers) {
      if (t.life <= 0) continue;
      t.life -= dt;
      const mat = t.mesh.material as THREE.MeshBasicMaterial;
      mat.opacity = Math.max(0, t.life / 0.07) * 0.9;
      if (t.life <= 0) t.mesh.visible = false;
    }

    // --- gun
    const key = w0 ? `${w0.kind}-${w0.rarity}` : "";
    if (key !== this.gunKey) {
      this.gun.clear();
      if (w0) {
        const g = buildGun(w0.kind, w0.rarity);
        g.scale.setScalar(0.55);
        g.rotation.y = -0.06;
        this.gun.add(g);
      }
      this.gunKey = key;
      this.gunKick = -0.6; // raise-in from below on swap
    }
    this.gunKick += (0 - this.gunKick) * Math.min(1, dt * 14);
    const reloading = p.reload > 0;
    const lowered = p.battery > 0 || p.downed > 0 || drop || s.phase === "done";
    const ads = p.ads;
    const gx = 0.2 * (1 - ads);
    const gy = -0.2 + 0.07 * ads - (lowered ? 0.4 : 0) - (reloading ? 0.08 : 0) + Math.sin(this.bob * 2) * 0.01 * (1 - ads);
    const gz = -0.42 + Math.max(0, this.gunKick) * 0.05;
    this.gun.position.set(gx + Math.cos(this.bob) * 0.01 * (1 - ads), gy, gz);
    this.gun.rotation.set(Math.max(0, this.gunKick) * 0.12 + (reloading ? 0.5 : 0) - (p.sliding ? 0.05 : 0), 0, (reloading ? 0.35 : 0) + (p.sliding ? 0.25 : 0));
    this.flash.position.set(this.gun.position.x - 0.02, this.gun.position.y + 0.03, this.gun.position.z - 0.4);
    this.flash.material.opacity = Math.max(0, this.flash.material.opacity - dt * 22);
    this.muzzleLight.intensity = Math.max(0, this.muzzleLight.intensity - dt * 120);
    this.muzzleLight.position.copy(this.muzzleWorld());
    this.gunCam.fov = 55 - ads * 8;
    this.gunCam.updateProjectionMatrix();

    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.renderer.clearDepth();
    this.renderer.render(this.gunScene, this.gunCam);
  }

  /** Drop everything that belongs to a run, before starting another. */
  reset() {
    for (const v of this.enemies.values()) {
      this.scene.remove(v.m.root);
      if (v.lane) this.scene.remove(v.lane);
      if (v.spawnBeam) this.scene.remove(v.spawnBeam);
    }
    this.enemies.clear();
    for (const g of this.loot.values()) this.scene.remove(g);
    this.loot.clear();
    for (const b of this.bins.values()) this.scene.remove(b.root);
    this.bins.clear();
    if (this.care) this.scene.remove(this.care);
    this.care = null;
    this.careBeam.visible = false;
    if (this.dropship) this.scene.remove(this.dropship);
    this.dropship = null;
    this.particles = [];
  }

  /** The POI the HUD should mark next, in world coordinates. */
  objective(s: State): Vec3 | null {
    if (s.phase === "extract") return { x: EXTRACT.x, y: 2, z: EXTRACT.z };
    const poi = POIS[s.poi];
    if (!poi) return null;
    return { x: poi.x, y: 2, z: poi.z };
  }
}
