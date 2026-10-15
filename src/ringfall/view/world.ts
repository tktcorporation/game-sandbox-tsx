import * as THREE from "three";
import { ENEMIES, PLAYER, TITAN, WEAPONS, WORLD, type EnemyKind } from "../sim/config";
import { BOXES, EXTRACTS } from "../sim/map";
import { groundAt } from "../sim/geom";
import { DAM_FACE, floorLevel, highGround, LANDS, LEVEL, offshore, steepAt, surfaceAt, terrainHeight } from "../sim/terrain";
import { callLeft, type GameEvent, type State, type Vec3 } from "../sim/state";
import { PAL, RARITY_COLOR, SCOPE_IN, buildAlly, buildBin, buildBoat, buildBox, mergeChunk, buildCare, buildDropship, buildEnemy, buildGun, buildLootItem, flat, glow, haloSprite, type EnemyModel } from "./models";

/*
 * Renders a State in first person. It reads the state and the tick's events and
 * turns them into feel (particles, flashes, recoil, FOV, shake). It never
 * changes the state.
 */

const EYE_LERP = 12;
/** How far past the world's bounds the terrain mesh reaches: far enough to fill the horizon. */
const HORIZON = 235;
/** Side of the square chunks the world's ground and buildings are drawn and culled in. */
const CHUNK = 64;
/**
 * Where the fog ends: a chunk wholly beyond it is skipped, since it would be drawn in the
 * fog's colour, which is the sky's at the horizon.
 */
const FOG_FAR = 420;
/** Robots, bins and loot further than this are not drawn: they are specks even through a scope. */
const THINGS_FAR = 220;

/** Ground the harbor paints apart: the old bay floor white with salt, and the paved town and quays. */
const SALT = new Set(["塩田", "難破船"]);
const PAVED = new Set(["港町", "埠頭", "高架下", "西の道", "コンテナヤード", "製錬所", "製錬所の坂", "駅の坂"]);
/** The harbor's tidal channel: its floor and the water over it. */
/** The water channel the boat comes up, at the harbor's quay. */
export const CHANNEL = { x0: 88, x1: 170, z0: -600, z1: -583, y: -5.55 };
/**
 * Where the boat is on the channel, `t` from 1 (waiting at the far end, mid-channel) to 0
 * (docked against the quay beside the pickup point, so the player boards it from there).
 */
export function boatSpot(quayX: number, t: number) {
  const mid = (CHANNEL.z0 + CHANNEL.z1) / 2 + 1;
  const docked = CHANNEL.z1 - 2;
  return { x: quayX + (CHANNEL.x1 - 6 - quayX) * t, z: docked + (mid - docked) * t };
}

/** A chunk of the world: its ground and everything built on it, drawn or skipped together. */
interface Chunk {
  group: THREE.Group;
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

const hash = (x: number, z: number) => {
  const v = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return v - Math.floor(v);
};
/** Smooth value noise in 0..1 for colouring the ground. */
function noise(x: number, z: number): number {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const u = (x - xi) * (x - xi) * (3 - 2 * (x - xi));
  const v = (z - zi) * (z - zi) * (3 - 2 * (z - zi));
  const a = hash(xi, zi);
  const b = hash(xi + 1, zi);
  const c = hash(xi, zi + 1);
  const d = hash(xi + 1, zi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

const COL = {
  sand: new THREE.Color(PAL.sand),
  dark: new THREE.Color(PAL.sandDark),
  rock: new THREE.Color(PAL.rock),
  rockDark: new THREE.Color(PAL.rockDark),
  mud: new THREE.Color(PAL.mud),
  mudDark: new THREE.Color(PAL.mudDark),
  tide: new THREE.Color(PAL.tide),
  concrete: new THREE.Color(PAL.concrete),
  concreteDark: new THREE.Color(PAL.concreteDark),
  salt: new THREE.Color(PAL.salt),
  saltDark: new THREE.Color(PAL.saltDark),
  paved: new THREE.Color(PAL.paved),
  pavedDark: new THREE.Color(PAL.pavedDark),
};
const groundMat = new THREE.MeshLambertMaterial({ vertexColors: true });

/** The colour of a ground triangle centred on (x, z), spanning heights lo..hi. */
function groundColour(c: THREE.Color, x: number, z: number, lo: number, hi: number) {
  const h = (lo + hi) / 2;
  const cliff = steepAt(x, z) || hi - lo > 2.2;
  const k = noise(x * 0.08, z * 0.08);
  if (cliff && DAM_FACE(x, z)) c.copy(COL.concrete).lerp(COL.concreteDark, noise(x * 0.5, h * 0.3) * 0.35);
  // Below the old waterline the walls are bleached in bands; above it, bare red rock.
  else if (cliff && h < LEVEL.shore) c.copy(COL.tide).lerp(COL.rock, Math.max(0, Math.min(1, (h - LEVEL.shore) / 3 + 1)) * 0.5 + noise(x * 0.3, h * 0.6) * 0.2);
  else if (cliff) c.copy(COL.rock).lerp(COL.rockDark, noise(x * 0.3, z * 0.1 + h * 0.2));
  // The unclimbable high ground: weathered rock, darker than anything walked on.
  else if (highGround(x, z)) c.copy(COL.rockDark).lerp(COL.rock, k * 0.6);
  else {
    const at = surfaceAt(x, z);
    // Salt crust split by darker cracks.
    if (SALT.has(at)) c.copy(COL.salt).lerp(COL.saltDark, noise(x * 0.35, z * 0.35) > 0.62 ? 0.8 : k * 0.25);
    else if (PAVED.has(at)) c.copy(COL.paved).lerp(COL.pavedDark, noise(x * 0.5, z * 0.5) > 0.66 ? 0.6 : k * 0.25);
    else if (at === "水路" || floorLevel(x, z) <= LEVEL.lakebed + 0.5) c.copy(COL.mud).lerp(COL.mudDark, noise(x * 0.4, z * 0.4) > 0.6 ? 0.6 : k * 0.3);
    else {
      c.copy(COL.sand).lerp(COL.dark, k > 0.62 ? 0.7 : k * 0.3);
      // Higher levels a touch lighter, so the steps read from afar.
      c.offsetHSL(0, 0, Math.max(-0.05, Math.min(0.05, h * 0.006)));
    }
  }
}

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
  private ally = buildAlly();
  private allyWalk = 0;
  private loot = new Map<number, THREE.Group>();
  private bins = new Map<number, ReturnType<typeof buildBin>>();
  private orbPool: THREE.Group[] = [];
  private wavePool: THREE.Mesh[] = [];
  private tracers: Tracer[] = [];
  private particles: Particle[] = [];
  private partMesh: THREE.InstancedMesh;
  private care: THREE.Group | null = null;
  private careBeam: THREE.Mesh;
  private dropship: THREE.Group | null = null;
  private extractRings: THREE.Mesh[] = [];
  private stompRing: THREE.Mesh;
  private gun = new THREE.Group();
  private gunKey = "";
  private flash: THREE.Sprite;
  private muzzleLight = new THREE.PointLight(0xffd27a, 0, 8, 2);
  private clouds: THREE.Sprite[] = [];
  private chunks: Chunk[] = [];
  private boat: THREE.Group | null = null;
  private readonly skyDome = this.sky();
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
    // Counted over the whole frame (both passes and the shadows), not just the last call.
    this.renderer.info.autoReset = false;
    container.appendChild(this.renderer.domElement);

    this.scene.fog = new THREE.Fog(PAL.skyHorizon, 110, 420);
    this.scene.add(this.skyDome);
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
    this.buildChunks();
    this.scene.add(this.ally.root);
    this.addClouds();


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

    for (const x of EXTRACTS) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(x.radius - 0.4, x.radius, 48), glow(PAL.hot, 0.8));
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(x.x, groundAt(x.x, x.z, 0.4, 99) + 0.3, x.z);
      ring.visible = false;
      this.scene.add(ring);
      this.extractRings.push(ring);
    }

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

  /**
   * The ground and everything built on it, cut into CHUNK-metre squares: each square's
   * terrain, boxes and boulders are merged into a mesh or two, so that a chunk is a couple
   * of draw calls, is culled by the camera's view as a whole, and is skipped beyond the fog
   * (render). The cliffs past the world's bounds, out to the horizon, are one coarse mesh.
   */
  private buildChunks() {
    // Fine spacing inside the world's bounds, coarse out on the cliffs to the horizon.
    const ticks = (lo: number, hi: number) => {
      const out: number[] = [];
      for (let v = lo - HORIZON; v < lo; v += 9) out.push(v);
      for (let v = lo; v < hi; v += 2) out.push(v);
      for (let v = hi; v <= hi + HORIZON; v += 9) out.push(v);
      return out;
    };
    const xs = ticks(WORLD.x0, WORLD.x1);
    const zs = ticks(WORLD.z0, WORLD.z1);
    const nx = Math.ceil((WORLD.x1 - WORLD.x0) / CHUNK);
    const nz = Math.ceil((WORLD.z1 - WORLD.z0) / CHUNK);
    const roots: THREE.Group[] = [];
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) {
        const x0 = WORLD.x0 + i * CHUNK;
        const z0 = WORLD.z0 + j * CHUNK;
        const x1 = Math.min(WORLD.x1, x0 + CHUNK);
        const z1 = Math.min(WORLD.z1, z0 + CHUNK);
        const ground = this.groundMesh(
          xs.filter((v) => v >= x0 && v <= x1),
          zs.filter((v) => v >= z0 && v <= z1),
          () => true,
        );
        const group = new THREE.Group();
        group.add(ground);
        this.chunks.push({ group, x0, z0, x1, z1 });
        roots.push(new THREE.Group());
      }
    const chunkOf = (x: number, z: number) => {
      const i = Math.max(0, Math.min(nx - 1, Math.floor((x - WORLD.x0) / CHUNK)));
      const j = Math.max(0, Math.min(nz - 1, Math.floor((z - WORLD.z0) / CHUNK)));
      return j * nx + i;
    };
    BOXES.forEach((b, n) => roots[chunkOf((b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2)].add(buildBox(b, n)));
    // Boulders along the foot of the coast's cliffs, where a land's coast is the world's.
    let r = 11;
    const rnd = () => ((r = (r * 16807) % 2147483647) / 2147483647);
    const geo = new THREE.DodecahedronGeometry(1, 0);
    for (const land of LANDS)
      for (let k = 0; k < 220; k++) {
        const a = rnd() * Math.PI * 2;
        const dx = Math.cos(a);
        const dz = Math.sin(a);
        const rr = land.radius(Math.atan2(dz, dx)) + rnd() * 5;
        const x = land.x + dx * rr;
        const z = land.z + dz * rr;
        const color = rnd() < 0.5 ? PAL.rock : PAL.rockDark;
        const sc = 1.5 + rnd() * 3.5;
        const sy = sc * (0.6 + rnd() * 0.9);
        const rot = [rnd(), rnd() * 6, rnd()] as const;
        if (offshore(x, z) < -3) continue; // inside another land: not the coast
        const m = new THREE.Mesh(geo, flat(color));
        m.scale.set(sc, sy, sc);
        m.rotation.set(rot[0], rot[1], rot[2]);
        m.position.set(x, terrainHeight(x, z) - sc * 0.3, z);
        roots[chunkOf(x, z)].add(m);
      }
    this.chunks.forEach((c, n) => {
      if (roots[n].children.length) c.group.add(mergeChunk(roots[n]));
      this.scene.add(c.group);
    });
    // Out past the bounds: the coarse ring of cliffs.
    const inside = (x: number, z: number) => x > WORLD.x0 && x < WORLD.x1 && z > WORLD.z0 && z < WORLD.z1;
    this.scene.add(this.groundMesh(xs, zs, (cx, cz) => !inside(cx, cz)));
    // The last water in the harbor, over the floor of its channel.
    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(CHANNEL.x1 - CHANNEL.x0, CHANNEL.z1 - CHANNEL.z0).rotateX(-Math.PI / 2),
      new THREE.MeshLambertMaterial({ color: PAL.water, transparent: true, opacity: 0.82 }),
    );
    water.position.set((CHANNEL.x0 + CHANNEL.x1) / 2, CHANNEL.y, (CHANNEL.z0 + CHANNEL.z1) / 2);
    water.receiveShadow = true;
    this.chunks[chunkOf(water.position.x, water.position.z)].group.add(water);
  }

  /** The ground over the grid of `xs` by `zs`, keeping the quads whose middle `keep` accepts. */
  private groundMesh(xs: number[], zs: number[], keep: (x: number, z: number) => boolean): THREE.Mesh {
    const n = xs.length;
    const pos = new Float32Array(n * zs.length * 3);
    for (let j = 0; j < zs.length; j++)
      for (let i = 0; i < n; i++) pos.set([xs[i], terrainHeight(xs[i], zs[j]), zs[j]], (j * n + i) * 3);
    const idx: number[] = [];
    for (let j = 0; j < zs.length - 1; j++)
      for (let i = 0; i < n - 1; i++) {
        if (!keep((xs[i] + xs[i + 1]) / 2, (zs[j] + zs[j + 1]) / 2)) continue;
        const a = j * n + i;
        idx.push(a, a + n, a + 1, a + 1, a + n, a + n + 1);
      }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setIndex(idx);
    const flatGeo = geo.toNonIndexed();
    const p = flatGeo.attributes.position;
    const colors = new Float32Array(p.count * 3);
    const c = new THREE.Color();
    // Colour each triangle as a whole: rock where it is a cliff, the ground's own colour elsewhere.
    for (let t = 0; t < p.count; t += 3) {
      let x = 0;
      let z = 0;
      let lo = Infinity;
      let hi = -Infinity;
      for (let k = 0; k < 3; k++) {
        x += p.getX(t + k) / 3;
        z += p.getZ(t + k) / 3;
        lo = Math.min(lo, p.getY(t + k));
        hi = Math.max(hi, p.getY(t + k));
      }
      groundColour(c, x, z, lo, hi);
      for (let k = 0; k < 3; k++) colors.set([c.r, c.g, c.b], (t + k) * 3);
    }
    flatGeo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    flatGeo.computeVertexNormals();
    const m = new THREE.Mesh(flatGeo, groundMat);
    m.receiveShadow = true;
    return m;
  }

  private addClouds() {
    // Spread over the world, short of its bounds.
    const cx = (WORLD.x0 + WORLD.x1) / 2;
    const cz = (WORLD.z0 + WORLD.z1) / 2;
    const rx = (WORLD.x1 - WORLD.x0) / 2 - 35;
    const rz = (WORLD.z1 - WORLD.z0) / 2 - 35;
    for (let i = 0; i < 26; i++) {
      const s = haloSprite(0xffffff, 30 + (i % 5) * 9, 0.55);
      s.material.blending = THREE.NormalBlending;
      s.position.set(cx + Math.sin(i * 2.4) * rx, 60 + (i % 7) * 9, cz + Math.cos(i * 1.7) * rz);
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
    for (const e of events) {
      switch (e.t) {
        case "shot": {
          const spec = WEAPONS[e.weapon];
          this.gunKick = Math.min(1, this.gunKick + (e.weapon === "maul" || e.weapon === "lance" || e.weapon === "talon" ? 1 : 0.45));
          this.recoilView += spec.recoil;
          this.flash.material.opacity = 1;
          this.flash.scale.setScalar(e.weapon === "maul" ? 0.6 : 0.35 + Math.random() * 0.1);
          this.muzzleLight.intensity = 6;
          this.shake = Math.max(this.shake, e.weapon === "maul" ? 0.35 : e.weapon === "lance" || e.weapon === "talon" ? 0.3 : 0.08);
          break;
        }
        case "tracer":
          this.tracer(this.muzzleWorld(), e.to, e.hit ? 0xfff3c4 : 0xffffff, 0.025);
          break;
        case "allyShot":
          this.tracer(e.from, e.to, e.hit ? 0xfff3c4 : 0xffffff, 0.018);
          this.burst(e.from, 0xffd27a, 2, 1.5, 0.04, 0, 0.08);
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
          this.burst({ x: s.player.pos.x, y: s.player.pos.y + 0.1, z: s.player.pos.z }, PAL.sandDark, 8, 2, 0.08, 6, 0.5);
          break;
        case "land":
          this.landDip = Math.min(0.35, e.speed * 0.02);
          if (e.speed > 10) this.burst({ x: s.player.pos.x, y: s.player.pos.y + 0.1, z: s.player.pos.z }, PAL.sand, 30, 6, 0.12, 8, 0.9);
          break;
        case "tactical":
          for (const t of e.targets) {
            this.tracer(this.muzzleWorld(), t, 0x9fe8ff, 0.08);
            this.burst(t, 0x9fe8ff, 14, 6, 0.07, 3, 0.5);
          }
          this.fovKick = Math.max(this.fovKick, 3);
          break;
        case "leap":
          this.fovKick = Math.max(this.fovKick, 10);
          this.shake = Math.max(this.shake, 0.5);
          break;
        case "enemyFire":
          this.burst(e.pos, PAL.orb, 3, 2, 0.06, 0, 0.25);
          break;
        case "stomp":
          this.shake = Math.max(this.shake, 0.9);
          this.burst({ x: e.x, y: terrainHeight(e.x, e.z) + 0.2, z: e.z }, PAL.sand, 60, 10, 0.18, 10, 1.0);
          break;
        case "careLand":
          this.shake = Math.max(this.shake, 0.5);
          this.burst({ x: e.x, y: (s.care?.y ?? terrainHeight(e.x, e.z)) + 0.2, z: e.z }, PAL.sand, 40, 7, 0.14, 8, 1.0);
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
    const baseFov = 74 + (p.sprinting ? 4 : 0) + (drop || p.leap ? 10 : 0);
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

    // The sky stays centred on the camera; shadows follow it.
    this.skyDome.position.copy(this.camera.position);
    const fx = this.camera.position.x;
    const fz = this.camera.position.z;
    this.sun.position.set(fx - 40, 80, fz + 30);
    this.sun.target.position.set(fx, 0, fz);

    for (const c of this.clouds) c.visible = drop || p.pos.y > 30;

    // Chunks wholly past the fog are skipped (the camera's view culls the rest), and so are
    // robots, bins and loot far off.
    for (const c of this.chunks) c.group.visible = Math.hypot(Math.max(c.x0 - fx, 0, fx - c.x1), Math.max(c.z0 - fz, 0, fz - c.z1)) < FOG_FAR;
    const near = (o: THREE.Object3D) => (o.visible = Math.hypot(o.position.x - fx, o.position.z - fz) < THINGS_FAR);

    // --- teammate
    const a = s.ally;
    const am = this.ally;
    am.root.visible = a.active;
    if (a.active) {
      am.root.position.set(a.pos.x, a.pos.y, a.pos.z);
      am.body.rotation.set(0, -a.yaw, 0);
      const sp = Math.hypot(a.vel.x, a.vel.z);
      this.allyWalk += dt * sp * 2.2;
      const swing = Math.sin(this.allyWalk) * Math.min(1, sp / 3) * 0.6;
      am.legs.forEach((l, i) => (l.rotation.x = i ? swing : -swing));
      am.arms.rotation.x = a.target ? a.pitch : -0.25;
      if (a.down > 0) {
        // Down: kneeling over, rifle lowered.
        am.body.rotation.set(-1.1, -a.yaw, 0, "YXZ");
        am.root.position.y = a.pos.y + 0.25;
        am.arms.rotation.x = -0.9;
      }
    }

    // --- enemies
    for (const e of s.enemies) {
      let v = this.enemies.get(e.id);
      if (!v) {
        const m = buildEnemy(e.kind);
        if (e.elite)
          m.root.traverse((o) => {
            if (o instanceof THREE.Mesh && o.material instanceof THREE.MeshLambertMaterial && o.material.color.getHex() === PAL.armor) {
              o.material = o.material.clone();
              o.material.color.setHex(PAL.eliteArmor);
            }
          });
        this.scene.add(m.root);
        const beam = new THREE.Mesh(
          new THREE.CylinderGeometry(0.06, ENEMIES[e.kind].radius * 0.45, 40, 8, 1, true),
          new THREE.MeshBasicMaterial({ color: PAL.eye, transparent: true, opacity: 0.3, depthWrite: false, blending: THREE.AdditiveBlending }),
        );
        beam.position.set(e.pos.x, e.pos.y + 20, e.pos.z);
        this.scene.add(beam);
        v = { m, kind: e.kind, flash: 0, shieldFlash: 0, walk: 0, spawnBeam: beam, lane: null };
        this.enemies.set(e.id, v);
      }
      const k = ENEMIES[e.kind];
      const m = v.m;
      m.root.position.set(e.pos.x, e.pos.y + (k.fly > 0 ? Math.sin(this.time * 3 + e.id) * 0.12 : 0), e.pos.z);
      // The arrival beam goes once the robot is down, near or far; a far one's is not drawn.
      const close = near(m.root);
      if (v.spawnBeam && e.mode !== "spawning") {
        this.scene.remove(v.spawnBeam);
        v.spawnBeam = null;
      }
      if (v.spawnBeam) v.spawnBeam.visible = close;
      if (!close) continue;
      m.body.rotation.y = -e.yaw;
      if (e.mode === "spawning") {
        const t = Math.max(0, 1 - e.timer / (e.kind === "titan" ? 2.2 : 0.9));
        m.root.scale.setScalar(0.2 + 0.8 * t);
        if (k.fly > 0) m.root.position.y = e.pos.y + (1 - t) * 10;
      } else {
        m.root.scale.setScalar(1);
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
          this.stompRing.position.set(e.pos.x, e.pos.y + 0.06, e.pos.z);
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
      // A fast shot reads as a bolt: stretched along its flight, short and round when slow (the titan's rockets).
      const r = o.r * (1 + Math.sin(this.time * 30 + o.id) * 0.08);
      const speed = Math.hypot(o.vel.x, o.vel.y, o.vel.z);
      g.lookAt(o.pos.x + o.vel.x, o.pos.y + o.vel.y, o.pos.z + o.vel.z);
      g.scale.set(r, r, r * Math.max(1, speed / 18));
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
        g = buildLootItem(l.kind, l.rarity, l.weapon?.kind, l.heal, l.valuable);
        this.loot.set(l.id, g);
        this.scene.add(g);
      }
      g.position.set(l.pos.x, l.pos.y + (l.kind === "shard" ? 0.5 : 0), l.pos.z);
      if (!near(g)) continue;
      g.rotation.y = this.time * (l.kind === "shard" ? 5 : 1.2) + l.id;
    }
    const present = new Set(s.loot.map((l) => l.id));
    for (const [id, g] of this.loot) {
      if (!present.has(id)) {
        this.scene.remove(g);
        this.loot.delete(id);
      }
    }
    for (const b of s.bins) {
      let v = this.bins.get(b.id);
      if (!v) {
        v = buildBin(b.vault);
        v.root.position.set(b.x, b.y, b.z);
        this.bins.set(b.id, v);
        this.scene.add(v.root);
      }
      if (!near(v.root)) continue;
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
      this.careBeam.position.set(s.care.x, terrainHeight(s.care.x, s.care.z) + 60, s.care.z);
    }

    // --- extraction
    this.extractRings.forEach((r) => (r.visible = s.phase === "play"));
    // The dropship comes once called, and is low over the pad when it lands.
    const ship = EXTRACTS.find((x) => x.id === "ship")!;
    const shipLeft = callLeft(s, "ship");
    if (s.phase !== "drop" && shipLeft >= 0) {
      if (!this.dropship) {
        this.dropship = buildDropship();
        this.dropship.position.set(ship.x, terrainHeight(ship.x, ship.z) + 90, ship.z - 2);
        this.scene.add(this.dropship);
      }
      const want = terrainHeight(ship.x, ship.z) + 4.5 + 70 * Math.min(1, shipLeft / (ship.call ?? 1));
      this.dropship.position.y += (want - this.dropship.position.y) * Math.min(1, dt * 0.8);
      this.dropship.rotation.z = Math.sin(this.time * 1.3) * 0.03;
    }
    // The boat waits at the channel's far end; once called it comes up to the quay, and lies there when it is there.
    const quay = EXTRACTS.find((x) => x.id === "boat")!;
    const boatLeft = callLeft(s, "boat");
    {
      if (!this.boat) {
        this.boat = buildBoat();
        this.scene.add(this.boat);
      }
      const t = boatLeft < 0 ? 1 : Math.min(1, boatLeft / (quay.call ?? 1));
      const want = boatSpot(quay.x, t);
      const k = Math.min(1, this.boat.position.x === 0 ? 1 : dt * 2);
      this.boat.position.x += (want.x - this.boat.position.x) * k;
      this.boat.position.z += (want.z - this.boat.position.z) * k;
      this.boat.position.y = CHANNEL.y + Math.sin(this.time * 1.7) * 0.06;
      this.boat.rotation.z = Math.sin(this.time * 1.1) * 0.02;
    }
    // A lit flare at the plateau pickup sends up red smoke.
    const here = EXTRACTS.find((x) => x.needsFlare);
    if (here && s.phase === "play" && s.extractTime > 0 && Math.hypot(s.player.pos.x - here.x, s.player.pos.z - here.z) < here.radius) {
      if (Math.random() < dt * 30) this.burst({ x: here.x, y: groundAt(here.x, here.z, 0.4, 99) + 0.4, z: here.z }, PAL.ring, 2, 1.2, 0.25, -2.5, 2.2);
    }

    // --- particles and tracers
    let n = 0;
    this.particles = this.particles.filter((q) => (q.life -= dt) > 0);
    for (const q of this.particles) {
      q.vel.y -= q.gravity * dt;
      q.pos.addScaledVector(q.vel, dt);
      const floor = terrainHeight(q.pos.x, q.pos.z) + 0.03;
      if (q.pos.y < floor) {
        q.pos.y = floor;
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
    const lowered = !!p.healing || !!p.mantle || !!p.leap || p.downed > 0 || drop || s.phase === "done";
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
    // Looking through a scope hides the gun; the round sight is drawn by the HUD.
    this.gun.visible = !(w0 && WEAPONS[w0.kind].scope && ads > SCOPE_IN);
    this.gunCam.fov = 55 - ads * 8;
    this.gunCam.updateProjectionMatrix();

    this.renderer.info.reset();
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.renderer.clearDepth();
    this.renderer.render(this.gunScene, this.gunCam);
  }

  /** What the last frame cost: draw calls and triangles, and how many chunks were drawn. */
  stats() {
    const r = this.renderer.info.render;
    return { calls: r.calls, triangles: r.triangles, chunks: this.chunks.filter((c) => c.group.visible).length, of: this.chunks.length };
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
    if (this.boat) this.scene.remove(this.boat);
    this.boat = null;
    this.particles = [];
  }
}
