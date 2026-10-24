import { atRisk } from "../sim/battle";
import * as THREE from "three";
import { DUCK, ENEMIES, FRONT, PLAYER, STORM, TITAN, WEAPONS, WORLD, type EnemyKind } from "../sim/config";
import { BOXES, CAMP, DEPOTS, ENTRIES, EXTRACTS, NODES, ROUTES, type Box } from "../sim/map";
import { frontNodes } from "../sim/front";
import { worldKey } from "../sim/routes";
import { groundAt } from "../sim/geom";
import { LANDS, offshore, terrainHeight } from "../sim/terrain";
import { groundColour, groundMat } from "./ground";
import { bodyY, callLeft, debrisBin, type GameEvent, type State, type Vec3 } from "../sim/state";
import { QUALITY, type Quality, type Tier } from "./quality";
import { SHADE, contactAt, coverAt, floorUnder } from "./shade";
import { GroundScatter } from "./scatter";
import { trimBox, type TrimPiece, type TrimSite } from "./trim";
import { PAL, RARITY_COLOR, SCOPE_IN, buildAlly, buildBeacon, buildBin, buildCore, buildBoat, buildStatic, buildDepot, buildEntryMark, buildRingDebris, mergeChunk, mergeTrim, type ChunkShade, buildCare, buildDropship, buildEnemy, buildGun, buildHands, buildLootItem, addPlates, flat, glow, haloSprite, type EnemyModel } from "./models";
import { streetMeshes } from "./streets";
import { BattleView, CHANNEL } from "./battle";

/*
 * Renders a State in first person. It reads the state and the tick's events and
 * turns them into feel (particles, flashes, recoil, FOV, shake). It never
 * changes the state.
 */

const EYE_LERP = 12;

/**
 * The light of a clear midday, tone mapped (ACES filmic) so the sun can be strong without the
 * sunlit sand clipping. The sky's fill is kept low against the sun, about 1 to 4, so that a
 * shaded face, a doorway or a room under a roof reads darker than the open ground, as it does
 * at full scale; with the fill near the sun's strength everything reads lit alike, like a model
 * on a table. `haze` is the fog: the horizon's peach greyed, as air far off looks.
 */
const LIGHT = { exposure: 1.05, sun: 3.2, sky: 0.72, haze: 0xdcd2c0, gunSun: 2.8, gunSky: 1.3 } as const;

/**
 * The view is set by its horizontal angle, as shooters' settings are: about 90° across, so the
 * world reads at a human scale rather than pulled back. A wide phone gets a little more across
 * (up to 95°) instead of a slot; a tall window is held to 70° up and down, narrowing it across.
 */
const VIEW = { across: 90, wideAcross: 95, wideAspect: 2.2, maxUp: 70 } as const;
/**
 * The vertical hip view the weapons' `adsFov` and the sprint, leap and kick widenings are
 * written against: aiming zooms by the ratio of their half-angles' tangents to it, whatever
 * the screen's own hip view.
 */
const FOV_REF = 74;
const tanHalf = (deg: number) => Math.tan((deg * Math.PI) / 360);
const atanDeg = (t: number) => (Math.atan(t) * 360) / Math.PI;

/** Vertical hip view (degrees) for a screen of this aspect (width / height). */
export function hipFov(aspect: number): number {
  const wide = Math.max(0, Math.min(1, (aspect - 16 / 9) / (VIEW.wideAspect - 16 / 9)));
  const across = VIEW.across + (VIEW.wideAcross - VIEW.across) * wide;
  return Math.min(VIEW.maxUp, atanDeg(tanHalf(across) / aspect));
}

/** How much a sight written as `adsFov` (against FOV_REF) narrows the view: under 1, the share of it left. */
export const sightZoom = (adsFov: number) => tanHalf(adsFov) / tanHalf(FOV_REF);
/** The view `fov` narrowed by aiming through a sight written as `adsFov`. */
const zoomedFov = (fov: number, adsFov: number) => atanDeg(tanHalf(fov) * sightZoom(adsFov));
/** How far past the world's bounds the terrain mesh reaches: far enough to fill the horizon. */
const HORIZON = 235;
/** Side of the square chunks the world's ground and buildings are drawn and culled in. */
const CHUNK = 64;
/**
 * Chunks are built while within a chunk past the fog's end (the tier's `fogFar`), nearest first
 * for up to the tier's `streamMs` a frame, so one is ready before it comes out of the fog; one
 * inside the fog that is not yet built is built at once. Past `DROP_AT` times that distance a
 * chunk is let go: the memory held follows the ground round the camera, not the world's size.
 */
const DROP_AT = 1.3;
/** Metres the camera may travel before a shadow map redrawn at the tier's rate is redrawn at once. */
const SHADOW_MOVE = 4;
/** The teammate's HUD teal: a depot that is on is lit in the colour that means "ours". */
const MATE_LIGHT = 0x6fd0cf;
/** Sparks off a plate that took part of a hit: grey like its damage number. */
const PLATE_SPARK = 0xffc56a;
/** Smoke from a robot below half its health and shield, and from a wreck. */
const SMOKE = 0x3b3a3c;
/** The ring's piece smokes paler than a wreck, so its column reads against the red rock from afar. */
const DEBRIS_SMOKE = 0x77736e;
const PUFF_LIFE = 5;
const PUFF_GEO = new THREE.IcosahedronGeometry(1, 0);
/** The shade baked into a chunk's merged statics (shade.ts). */
const CHUNK_SHADE: ChunkShade = { cover: coverAt, floor: floorUnder, base: SHADE.wallBase, baseUp: SHADE.wallBaseUp };
/** Where trim finds the floors, the cover and the ground its boxes stand on (trim.ts). */
const TRIM_SITE: TrimSite = { floor: floorUnder, cover: coverAt, ground: terrainHeight };
/** Seconds a wreck lies where it fell, then sinks away over `WRECK_SINK`. At most `WRECK_MAX` lie at once. */
const WRECK_TIME = 7;
const WRECK_SINK = 1.2;
const WRECK_MAX = 6;
/** Seconds of the collapse after a kill. */
const WRECK_FALL = 0.55;

export { CHANNEL };
/**
 * Where the boat is on the channel, `t` from 1 (waiting at the far end, mid-channel) to 0
 * (docked against the quay beside the pickup point, so the player boards it from there).
 */
export function boatSpot(quayX: number, t: number) {
  const mid = (CHANNEL.z0 + CHANNEL.z1) / 2 + 1;
  const docked = CHANNEL.z1 - 2;
  return { x: quayX + (CHANNEL.x1 - 6 - quayX) * t, z: docked + (mid - docked) * t };
}

/** Each route's reach: its boxes, and its trench out to where its walls have risen past the high ground. */
const ROUTE_REACH = ROUTES.map((r) => {
  const xs = [...r.closed, ...r.open].flatMap((b) => [b.x0, b.x1]).concat(r.carve ? r.carve.line.map((q) => q[0]) : []);
  const zs = [...r.closed, ...r.open].flatMap((b) => [b.z0, b.z1]).concat(r.carve ? r.carve.line.map((q) => q[1]) : []);
  const pad = r.carve ? r.carve.floor + 32 / r.carve.slope : 1;
  return { x0: Math.min(...xs) - pad, x1: Math.max(...xs) + pad, z0: Math.min(...zs) - pad, z1: Math.max(...zs) + pad };
});

/** Whether any route reaches into the square [x0, x1] x [z0, z1]. */
const reached = (c: { x0: number; z0: number; x1: number; z1: number }) => ROUTE_REACH.some((a) => a.x0 < c.x1 + 2 && a.x1 > c.x0 - 2 && a.z0 < c.z1 + 2 && a.z1 > c.z0 - 2);

/** A boulder at the foot of the coast's cliffs, as placed; its mesh is made when its chunk is built. */
interface Boulder {
  x: number;
  y: number;
  z: number;
  color: number;
  sc: number;
  sy: number;
  rot: readonly [number, number, number];
}

/**
 * A chunk of the world: its ground and everything built on it, drawn or skipped together. What
 * stands in it is kept as data (`boxes`, `boulders`); its meshes exist only while it is built.
 */
interface Chunk {
  group: THREE.Group;
  /** Its ground and its merged statics, as built for the world in place (`built`); null while not built. */
  ground: THREE.Mesh | null;
  merged: THREE.Group | null;
  /** Its architectural trim, built only while the chunk is within the tier's `trimFar` (trim.ts). */
  trim: THREE.Mesh | null;
  /** Built and found to have no trim at all: not tried again until the chunk is built again. */
  trimless: boolean;
  built: boolean;
  /** Indices into BOXES of the map's boxes whose middle lies in it, in BOXES order. */
  boxes: number[];
  boulders: Boulder[];
  x0: number;
  z0: number;
  x1: number;
  z1: number;
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
  /** 0..1: how hard the last hits rocked it; the lean falls away in a fraction of a second. */
  flinch: number;
  /** Which way the hits push it, as a yaw in the world (away from the shooter). */
  pushYaw: number;
  /** Seconds until its next puff of smoke when badly hurt. */
  smoke: number;
  shieldFlash: number;
  walk: number;
  spawnBeam: THREE.Mesh | null;
  lane: THREE.Mesh | null;
  /** The plates it wears (`addPlates()`), knocked off when the plate breaks. */
  plates: THREE.Mesh[];
}

/** A robot's model left lying where it was destroyed. */
interface Wreck {
  m: EnemyModel;
  kind: EnemyKind;
  t: number;
  /** World yaw it falls toward (away from the killing shot). */
  fallYaw: number;
  yaw: number;
  x: number;
  y: number;
  z: number;
  /** Height it fell from (drones drop out of the air) and the ground it lies on. */
  y0: number;
  ground: number;
  smoke: number;
}

/** Tip a robot's body toward a world yaw by `amount` radians, its own yaw `yaw` (the body's euler order is YXZ). */
function lean(body: THREE.Object3D, yaw: number, towardYaw: number, amount: number) {
  const rel = towardYaw - yaw;
  body.rotation.set(-Math.cos(rel) * amount, -yaw, -Math.sin(rel) * amount);
}

interface Tracer {
  mesh: THREE.Mesh;
  life: number;
}

export class World {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(hipFov(16 / 9), 16 / 9, 0.05, 900);
  private gunScene = new THREE.Scene();
  private gunCam = new THREE.PerspectiveCamera(55, 16 / 9, 0.01, 10);
  private sun = new THREE.DirectionalLight(0xfff1d6, LIGHT.sun);
  private enemies = new Map<number, EnemyView>();
  private wrecks: Wreck[] = [];
  private ally = buildAlly();
  private allyWalk = 0;
  private loot = new Map<number, THREE.Group>();
  private bins = new Map<number, ReturnType<typeof buildBin>>();
  /** The ring's piece on a debris fall's day, beside its crate, and the seconds to its next puff of smoke. */
  private debris: (ReturnType<typeof buildRingDebris> & { smoke: number; puffs: { m: THREE.Mesh; t: number }[] }) | null = null;
  /** The weather drawn: a storm brings the fog in and greys the light (`STORM`). */
  private storm = false;
  private hemi = new THREE.HemisphereLight(0xcfe9ff, 0xb98a55, LIGHT.sky);
  private orbPool: THREE.Group[] = [];
  private wavePool: THREE.Mesh[] = [];
  private tracers: Tracer[] = [];
  /** Far muzzle flashes and blasts (`flashAt()`): sprites reused as they fade. */
  private flashes: { sprite: THREE.Sprite; life: number; max: number }[] = [];
  private particles: Particle[] = [];
  private partMesh: THREE.InstancedMesh;
  private care: THREE.Group | null = null;
  private careBeam: THREE.Mesh;
  /** The ground a capture is held from (`FRONT.radius` round the core): blue while it counts, orange while it stands still. */
  private captureRing: THREE.Mesh;
  /** The cores of the front's nodes (`NODES`), built once, lit as who holds each; and the colour each was last lit in. */
  private cores: (ReturnType<typeof buildCore> & { key: string })[] = [];
  /** The objective's beacon (`setBeacon()`), and where it stands; null for none. */
  private beacon: THREE.Mesh;
  private beaconAt: { x: number; y: number; z: number } | null = null;
  private dropship: THREE.Group | null = null;
  private extractRings: THREE.Mesh[] = [];
  /** The campfire and signboard at each way in (`ENTRIES`), built once: scenery only. */
  private entryMarks: THREE.Group[] = [];
  /** One per `DEPOTS` entry, built once: they stand in every run, only lit or not. */
  private depots: (ReturnType<typeof buildDepot> & { /** Last lit state drawn; null until the first frame sets it. */ on: boolean | null })[] = [];
  private stompRing: THREE.Mesh;
  private gun = new THREE.Group();
  private gunKey = "";
  private flash: THREE.Sprite;
  private muzzleLight = new THREE.PointLight(0xffd27a, 0, 8, 2);
  private clouds: THREE.Sprite[] = [];
  private chunks: Chunk[] = [];
  /** The grid ticks the ground is drawn on, inside the world's bounds and out to the horizon. */
  private ticks: { xs: number[]; zs: number[] } = { xs: [], zs: [] };
  /** The world (`worldKey()`) the chunks were built for. */
  private built = "";
  private boat: THREE.Group | null = null;
  private readonly skyDome = this.sky();
  private dummy = new THREE.Object3D();
  private boulderGeo = new THREE.DodecahedronGeometry(1, 0);
  /** The day's battle seen from afar: the enemy's landings, the squads out to the fog, the gate and depots the factory's squads leave by. */
  private battleView = new BattleView();

  /** The camp between raids is drawn: the weapons are down. */
  campMode = false;
  /** The robot standing by the camp's factory, shown while the camp is drawn. */
  private factoryBot: THREE.Object3D | null = null;

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

  /** The quality tier drawn (quality.ts) and its settings. */
  private tierNow: Tier = "high";
  private q: Quality = QUALITY.high;
  /** When (`time`) and from where the shadow map was last redrawn, on the tiers that do not redraw it every frame. */
  private shadowAt = -Infinity;
  private shadowFrom = new THREE.Vector3();
  /** Chunks built so far and the milliseconds they took, for `stats()`. */
  private filled = { n: 0, ms: 0 };
  /** The same for the chunks' trim. */
  private trimmed = { n: 0, ms: 0 };
  /** Stones, stains, cracks and tufts on the ground near the camera. */
  private scatter = new GroundScatter();

  /** `tier` and `ratio`: what the page starts drawing at; the tier's antialiasing is fixed from then on. */
  constructor(container: HTMLElement, opts: { tier: Tier; ratio: number }) {
    this.renderer = new THREE.WebGLRenderer({ antialias: QUALITY[opts.tier].antialias, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(opts.ratio);
    this.renderer.shadowMap.enabled = true;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = LIGHT.exposure;
    this.renderer.autoClear = false;
    // Counted over the whole frame (both passes and the shadows), not just the last call.
    this.renderer.info.autoReset = false;
    container.appendChild(this.renderer.domElement);

    this.scene.fog = new THREE.Fog(LIGHT.haze, QUALITY.high.fogNear, QUALITY.high.fogFar);
    this.scene.add(this.skyDome);
    this.scene.add(this.hemi);
    this.sun.position.set(-40, 80, 30);
    this.sun.castShadow = true;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 220;
    this.sun.shadow.bias = -0.0006;
    this.setTier(opts.tier);
    this.scene.add(this.sun, this.sun.target);
    this.buildChunks();
    this.scene.add(this.scatter.group);
    this.scene.add(this.ally.root);
    this.addClouds();


    this.partMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ toneMapped: false, color: 0xffffff }), 700);
    this.partMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.partMesh.count = 0;
    this.partMesh.frustumCulled = false;
    this.scene.add(this.partMesh);

    this.careBeam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.6, 0.6, 120, 10, 1, true),
      new THREE.MeshBasicMaterial({ toneMapped: false, color: RARITY_COLOR[3], transparent: true, opacity: 0.22, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    this.careBeam.visible = false;
    this.scene.add(this.careBeam);

    for (const n of NODES) {
      const v = { ...buildCore(FRONT.height, FRONT.half), key: "" };
      v.root.position.set(n.core.x, n.core.y, n.core.z);
      this.scene.add(v.root);
      this.cores.push(v);
    }
    this.captureRing = new THREE.Mesh(new THREE.RingGeometry(FRONT.radius - 0.6, FRONT.radius, 96), glow(0x3f86c8, 0.7));
    this.captureRing.rotation.x = -Math.PI / 2;
    this.captureRing.visible = false;
    this.scene.add(this.captureRing);
    this.beacon = buildBeacon();
    this.beacon.visible = false;
    this.scene.add(this.beacon);
    this.scene.add(this.battleView.group);

    for (const x of EXTRACTS) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(x.radius - 0.4, x.radius, 48), glow(PAL.hot, 0.8));
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(x.x, groundAt(x.x, x.z, 0.4, 99) + 0.3, x.z);
      ring.visible = false;
      this.scene.add(ring);
      this.extractRings.push(ring);
    }

    for (const d of DEPOTS) {
      // A raid started from a depot begins behind its point, facing the POI: the locker's slot
      // (its -z side) is turned back along the road, towards that start.
      const v = { ...buildDepot(), on: null };
      v.root.position.set(d.x, groundAt(d.x, d.z, 0.4, d.y + 1), d.z);
      v.root.rotation.y = Math.PI - d.yaw;
      this.scene.add(v.root);
      this.depots.push(v);
    }

    for (const e of ENTRIES) {
      // Behind where a raid there starts, so the start's own view is of the region ahead; the
      // board faces in, towards a player who walks out to it. Both stay inside the clearing the
      // scattered cover leaves round a way in.
      const { fire, sign } = buildEntryMark();
      const fx = Math.sin(e.yaw);
      const fz = -Math.cos(e.yaw);
      const put = (o: THREE.Group, back: number, side: number) => {
        const x = e.x - fx * back - fz * side;
        const z = e.z - fz * back + fx * side;
        o.position.set(x, groundAt(x, z, 0.4, 99), z);
        o.rotation.y = Math.PI - e.yaw;
        this.scene.add(o);
        this.entryMarks.push(o);
      };
      put(fire, 2.5, 1.6);
      put(sign, 4.5, -0.8);
    }
    {
      // The camp's fire, in the open yard between the map table and the tent.
      const { fire } = buildEntryMark();
      const x = (CAMP.x0 + CAMP.x1) / 2 - 3;
      const z = (CAMP.z0 + CAMP.z1) / 2 + 4;
      fire.position.set(x, groundAt(x, z, 0.4, 99), z);
      this.scene.add(fire);
      this.entryMarks.push(fire);
    }

    this.stompRing = new THREE.Mesh(new THREE.RingGeometry(0.96, 1, 64), glow(PAL.orb, 0.5));
    this.stompRing.rotation.x = -Math.PI / 2;
    this.stompRing.visible = false;
    this.scene.add(this.stompRing);

    // First-person gun, drawn in its own pass so it never clips into walls.
    this.gunScene.add(new THREE.HemisphereLight(0xdff2ff, 0x8a6a3a, LIGHT.gunSky));
    const gl = new THREE.DirectionalLight(0xfff1d6, LIGHT.gunSun);
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
      // The sky is drawn in the palette's own colours (not tone mapped), and meets the fog's haze
      // at the horizon, where the fogged ground far off ends.
      uniforms: { top: { value: new THREE.Color(PAL.skyTop) }, horizon: { value: new THREE.Color(PAL.skyHorizon) }, haze: { value: new THREE.Color(LIGHT.haze) } },
      vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 haze; varying vec3 vDir;
        void main(){
          float h = clamp(vDir.y, 0.0, 1.0);
          vec3 c = mix(horizon, top, pow(h, 0.55));
          c = mix(haze, c, smoothstep(0.0, 0.12, h));
          vec3 sunDir = normalize(vec3(-0.45, 0.6, 0.35));
          float s = max(dot(vDir, sunDir), 0.0);
          c += vec3(1.0, 0.92, 0.75) * (pow(s, 600.0) * 1.2 + pow(s, 12.0) * 0.18);
          if (vDir.y < 0.0) c = haze;
          gl_FragColor = vec4(c, 1.0);
          #include <colorspace_fragment>
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
    // A carved route runs along z and is a few metres wide: its column is drawn every metre, so
    // its floor shows as wide as it is walked.
    const fine = ROUTES.flatMap((r) => {
      if (!r.carve) return [];
      const x = r.carve.line[0][0];
      return Array.from({ length: 2 * Math.ceil(r.carve.floor + 3) + 1 }, (_, k) => Math.round(x) - Math.ceil(r.carve!.floor + 3) + k);
    });
    const xs = [...new Set([...ticks(WORLD.x0, WORLD.x1), ...fine])].sort((a, b) => a - b);
    const zs = ticks(WORLD.z0, WORLD.z1);
    this.ticks = { xs, zs };
    const nx = Math.ceil((WORLD.x1 - WORLD.x0) / CHUNK);
    const nz = Math.ceil((WORLD.z1 - WORLD.z0) / CHUNK);
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) {
        const x0 = WORLD.x0 + i * CHUNK;
        const z0 = WORLD.z0 + j * CHUNK;
        const x1 = Math.min(WORLD.x1, x0 + CHUNK);
        const z1 = Math.min(WORLD.z1, z0 + CHUNK);
        this.chunks.push({ group: new THREE.Group(), x0, z0, x1, z1, ground: null, merged: null, trim: null, trimless: false, built: false, boxes: [], boulders: [] });
      }
    BOXES.forEach((b, n) => this.chunkOf(b).boxes.push(n));
    // Boulders along the foot of the coast's cliffs, where a land's coast is the world's.
    let r = 11;
    const rnd = () => ((r = (r * 16807) % 2147483647) / 2147483647);
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
        this.chunkOf({ x0: x, x1: x, z0: z, z1: z }).boulders.push({ x, y: terrainHeight(x, z) - sc * 0.3, z, color, sc, sy, rot });
      }
    this.built = worldKey();
    // Built as the camera comes near them (streamChunks).
    for (const c of this.chunks) this.scene.add(c.group);
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
    this.chunkOf({ x0: water.position.x, x1: water.position.x, z0: water.position.z, z1: water.position.z }).group.add(water);
  }

  /** The chunk holding the middle of a box. */
  private chunkOf(b: Pick<Box, "x0" | "x1" | "z0" | "z1">): Chunk {
    const nx = Math.ceil((WORLD.x1 - WORLD.x0) / CHUNK);
    const nz = Math.ceil((WORLD.z1 - WORLD.z0) / CHUNK);
    const i = Math.max(0, Math.min(nx - 1, Math.floor(((b.x0 + b.x1) / 2 - WORLD.x0) / CHUNK)));
    const j = Math.max(0, Math.min(nz - 1, Math.floor(((b.z0 + b.z1) / 2 - WORLD.z0) / CHUNK)));
    return this.chunks[j * nx + i];
  }

  /** The routes' boxes standing in the world now in place: closed routes' obstacles, open routes' roofs and gangways. */
  private routeBoxes(): Box[] {
    const open = this.built.split(",");
    return ROUTES.flatMap((r) => (open.includes(r.id) ? r.open : r.closed));
  }

  /** Lets a chunk's meshes go: it holds only its data until it is built again. */
  private emptyChunk(c: Chunk) {
    this.emptyTrim(c);
    for (const o of [c.ground, c.merged])
      if (o) {
        c.group.remove(o);
        o.traverse((m) => m instanceof THREE.Mesh && m.geometry.dispose());
      }
    c.ground = c.merged = null;
    c.built = false;
    c.trimless = false;
  }

  /** (Re)builds a chunk's ground and merged statics for the world now in place, with the routes' boxes in it. */
  private fillChunk(c: Chunk) {
    const t0 = performance.now();
    this.emptyChunk(c);
    c.built = true;
    const routes = this.routeBoxes();
    c.ground = this.groundMesh(
      this.ticks.xs.filter((v) => v >= c.x0 && v <= c.x1),
      this.ticks.zs.filter((v) => v >= c.z0 && v <= c.z1),
      () => true,
      (x, y, z) => coverAt(x, y + 0.2, z) * contactAt(x, y, z, routes),
    );
    c.group.add(c.ground);
    // The map's boxes and the boulders first, then the routes', merged in that order.
    const statics = new THREE.Group();
    for (const n of c.boxes) statics.add(buildStatic(BOXES[n], n));
    for (const m of streetMeshes(c)) statics.add(m);
    for (const b of c.boulders) {
      const m = new THREE.Mesh(this.boulderGeo, flat(b.color));
      m.scale.set(b.sc, b.sy, b.sc);
      m.rotation.set(b.rot[0], b.rot[1], b.rot[2]);
      m.position.set(b.x, b.y, b.z);
      statics.add(m);
    }
    const root = new THREE.Group();
    root.add(statics);
    routes.forEach((b, n) => {
      if (this.chunkOf(b) === c) root.add(buildStatic(b, BOXES.length + n));
    });
    c.merged = statics.children.length || root.children.length > 1 ? mergeChunk(root, CHUNK_SHADE) : null;
    // The meshes built for the merge are let go; only their geometry's copies in the merge stay.
    root.traverse((m) => m instanceof THREE.Mesh && m.geometry !== this.boulderGeo && m.geometry.dispose());
    if (c.merged) c.group.add(c.merged);
    this.filled.n++;
    this.filled.ms += performance.now() - t0;
  }

  /** Lets a chunk's trim go. */
  private emptyTrim(c: Chunk) {
    if (!c.trim) return;
    c.group.remove(c.trim);
    c.trim.geometry.dispose();
    c.trim = null;
  }

  /** Builds a built chunk's trim, for the boxes its statics were built from. */
  private fillTrim(c: Chunk) {
    const t0 = performance.now();
    const pieces: TrimPiece[] = [];
    for (const n of c.boxes) trimBox(BOXES[n], pieces, TRIM_SITE);
    for (const b of this.routeBoxes()) if (this.chunkOf(b) === c) trimBox(b, pieces, TRIM_SITE);
    c.trim = mergeTrim(pieces, coverAt);
    if (c.trim) c.group.add(c.trim);
    this.trimmed.n++;
    this.trimmed.ms += performance.now() - t0;
    return c.trim;
  }

  /** Distance on the ground from (x, z) to a chunk's square. */
  private static away(c: Chunk, x: number, z: number) {
    return Math.hypot(Math.max(c.x0 - x, 0, x - c.x1), Math.max(c.z0 - z, 0, z - c.z1));
  }

  /**
   * Builds the chunks round (x, z) that are not built yet: those inside the fog at once, so
   * nothing drawn is ever missing, and those out to `streamFar()` within the tier's time; lets go those past
   * DROP_AT times that.
   */
  private streamChunks(x: number, z: number) {
    const fogFar = this.q.fogFar;
    const far = this.streamFar();
    const waiting: { c: Chunk; d: number }[] = [];
    for (const c of this.chunks) {
      const d = World.away(c, x, z);
      if (c.built) {
        if (d > far * DROP_AT) this.emptyChunk(c);
      } else if (d < fogFar) this.fillChunk(c);
      else if (d < far) waiting.push({ c, d });
    }
    waiting.sort((a, b) => a.d - b.d);
    const t0 = performance.now();
    for (const { c } of waiting) {
      this.fillChunk(c);
      if (performance.now() - t0 >= this.q.streamMs) break;
    }
    // Trim follows within `trimFar`, nearest first, in what is left of the frame's time (one at least).
    const trimFar = this.q.trimFar;
    const trims: { c: Chunk; d: number }[] = [];
    for (const c of this.chunks) {
      if (!c.built) continue;
      const d = World.away(c, x, z);
      // A tier with no trim drops it everywhere, the camera's own chunk too (d is 0 there).
      if (c.trim && (trimFar <= 0 || d > trimFar * DROP_AT)) this.emptyTrim(c);
      else if (!c.trim && !c.trimless && d < trimFar) trims.push({ c, d });
    }
    trims.sort((a, b) => a.d - b.d);
    const t1 = performance.now();
    for (const { c } of trims) {
      c.trimless = !this.fillTrim(c);
      if (performance.now() - t1 >= this.q.streamMs) break;
    }
  }

  /**
   * Builds now every chunk within `streamFar()` of the given points, for the world in place: where a
   * raid's camera starts, so its first seconds draw what was built before them.
   */
  prebuild(points: readonly { x: number; z: number }[]) {
    this.syncRoutes();
    const far = this.streamFar();
    for (const c of this.chunks) if (!c.built && points.some((q) => World.away(c, q.x, q.z) < far)) this.fillChunk(c);
    for (const c of this.chunks) if (c.built && !c.trim && !c.trimless && points.some((q) => World.away(c, q.x, q.z) < this.q.trimFar)) c.trimless = !this.fillTrim(c);
  }

  /** How far round the camera chunks are built: one chunk past the fog. */
  private streamFar() {
    return this.q.fogFar + CHUNK;
  }

  /**
   * Rebuilds the chunks a route touches when the world in place has other routes open (a new
   * raid's): their ground is carved or not, their obstacles or roofs stand or not.
   */
  private syncRoutes() {
    if (worldKey() === this.built) return;
    this.built = worldKey();
    this.shadowAt = -Infinity;
    this.scatter.invalidate();
    for (const c of this.chunks) if (c.built && reached(c)) this.fillChunk(c);
  }

  /**
   * The ground over the grid of `xs` by `zs`, keeping the quads whose middle `keep` accepts. With
   * `shade`, each grid point's colour is scaled by the light it keeps (under a roof, at a wall's foot).
   */
  private groundMesh(xs: number[], zs: number[], keep: (x: number, z: number) => boolean, shade?: (x: number, y: number, z: number) => number): THREE.Mesh {
    const n = xs.length;
    const pos = new Float32Array(n * zs.length * 3);
    const light = new Float32Array(n * zs.length).fill(1);
    for (let j = 0; j < zs.length; j++)
      for (let i = 0; i < n; i++) {
        const y = terrainHeight(xs[i], zs[j]);
        pos.set([xs[i], y, zs[j]], (j * n + i) * 3);
        if (shade) light[j * n + i] = shade(xs[i], y, zs[j]);
      }
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
      // toNonIndexed lays the vertices out in the index's order, so idx[t + k] is the grid point.
      for (let k = 0; k < 3; k++) {
        const l = light[idx[t + k]];
        colors.set([c.r * l, c.g * l, c.b * l], (t + k) * 3);
      }
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

  get tier(): Tier {
    return this.tierNow;
  }

  /**
   * Draws at `tier` from the next frame: its fog and view distances, and its shadows (map size,
   * reach, redraw rate). The shadow map is let go and made again at the new size.
   */
  setTier(tier: Tier) {
    const q = QUALITY[tier];
    this.tierNow = tier;
    this.q = q;
    this.applyWeather();
    const shadow = this.sun.shadow;
    if (shadow.mapSize.x !== q.shadowSize) {
      shadow.map?.dispose();
      shadow.map = null;
      shadow.mapSize.set(q.shadowSize, q.shadowSize);
    }
    const sc = shadow.camera;
    sc.left = sc.bottom = -q.shadowSpan;
    sc.right = sc.top = q.shadowSpan;
    sc.updateProjectionMatrix();
    this.renderer.shadowMap.autoUpdate = !Number.isFinite(q.shadowHz);
    this.shadowAt = -Infinity;
  }

  /**
   * The fog and the light for the weather drawn: the tier's on a clear day; in a storm the fog
   * comes `STORM.fog` as near, greyed, and the sun is dimmed under the cloud while the sky's fill
   * holds, so the day reads flat and grey. The view only: the robots' sight is the sim's.
   */
  private applyWeather() {
    const fog = this.scene.fog as THREE.Fog;
    const f = this.storm ? STORM.fog : 1;
    // The storm's haze starts close: a fog far `STORM.fog` as near would leave mid-range ground clear.
    fog.near = this.q.fogNear * (this.storm ? 0.15 : 1);
    fog.far = this.q.fogFar * f;
    fog.color.setHex(this.storm ? 0x9ea4a6 : LIGHT.haze);
    this.sun.intensity = this.storm ? LIGHT.sun * 0.45 : LIGHT.sun;
    this.hemi.color.setHex(this.storm ? 0xc3c8cc : 0xcfe9ff);
    this.hemi.intensity = this.storm ? LIGHT.sky * 1.15 : LIGHT.sky;
    // The clear sky gives way to the storm's cloud: the dome is hidden and the frame cleared to the fog's grey.
    this.skyDome.visible = !this.storm;
    this.scene.background = this.storm ? fog.color.clone() : null;
    this.renderer.toneMappingExposure = this.storm ? LIGHT.exposure * 0.85 : LIGHT.exposure;
  }

  /** Device pixels per CSS pixel the canvas is drawn at; the canvas keeps its size on the page. */
  setRatio(ratio: number) {
    if (ratio !== this.renderer.getPixelRatio()) this.renderer.setPixelRatio(ratio);
  }

  resize(w: number, h: number) {
    this.renderer.setSize(w, h, false);
    // Keep the zoom the view is at (aiming, a sight, a kick) and carry it to the new hip fov.
    const rad = Math.PI / 360;
    const zoom = Math.tan(this.camera.fov * rad) / Math.tan(hipFov(this.camera.aspect) * rad);
    this.camera.aspect = w / h;
    this.camera.fov = Math.atan(zoom * Math.tan(hipFov(w / h) * rad)) / rad;
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

  /**
   * Lay a destroyed robot's model down as a wreck: its eye goes dark, its armour scorches,
   * and it topples toward `fallYaw`. The model's own meshes are reused, and the oldest
   * wreck goes once more than `WRECK_MAX` lie about, so wrecks never add up.
   */
  private wreck(v: EnemyView, fallYaw: number) {
    const m = v.m;
    m.eye.visible = false;
    m.eyeHalo.visible = false;
    m.shield.visible = false;
    // A robot destroyed while squatting goes over from its feet like any other.
    m.body.position.y = 0;
    for (const mat of m.mats) {
      mat.emissive.setHex(0x000000);
      mat.color.lerp(new THREE.Color(0x1a1a1e), 0.55);
    }
    const p = m.root.position;
    const yaw = -m.body.rotation.y;
    const fly = ENEMIES[v.kind].fly > 0;
    this.wrecks.push({ m, kind: v.kind, t: 0, fallYaw, yaw, x: p.x, y: p.y, z: p.z, y0: p.y, ground: fly ? groundAt(p.x, p.z, 0.4, p.y) : p.y, smoke: 0 });
    while (this.wrecks.length > WRECK_MAX) this.scene.remove(this.wrecks.shift()!.m.root);
  }

  private stepWrecks(dt: number, fx: number, fz: number) {
    this.wrecks = this.wrecks.filter((w) => {
      w.t += dt;
      if (w.t > WRECK_TIME + WRECK_SINK) {
        this.scene.remove(w.m.root);
        return false;
      }
      const m = w.m;
      m.root.visible = Math.hypot(w.x - fx, w.z - fz) < this.q.thingsFar;
      if (!m.root.visible) return true;
      // Collapse: knees give, the body tips over and lands with a small bounce; a drone drops out of the air.
      const f = Math.min(1, w.t / WRECK_FALL);
      const ease = f * f;
      const bounce = f >= 1 ? Math.max(0, Math.sin((w.t - WRECK_FALL) * 14) * Math.exp(-(w.t - WRECK_FALL) * 9)) * 0.06 : 0;
      // It goes over stiffly about its feet, knees buckling only on the way down, and comes to rest on its side.
      const tipMax = w.kind === "drone" ? 0.9 : w.kind === "titan" ? 0.55 : 1.42;
      lean(m.body, w.yaw, w.fallYaw, tipMax * ease - bounce);
      m.legs.forEach((leg) => (leg.rotation.x = -0.5 * Math.sin(Math.PI * f)));
      m.knees.forEach((knee) => (knee.rotation.x = -0.9 * Math.sin(Math.PI * f)));
      const sink = w.t > WRECK_TIME ? ((w.t - WRECK_TIME) / WRECK_SINK) * (ENEMIES[w.kind].bodyY + ENEMIES[w.kind].radius + 0.5) : 0;
      const settle = w.kind === "drone" ? 0 : ENEMIES[w.kind].radius * 0.35 * ease;
      m.root.position.set(w.x, w.ground + (w.y0 - w.ground) * (1 - ease) + settle - sink, w.z);
      if ((w.smoke -= dt) <= 0 && w.t < WRECK_TIME) {
        w.smoke = 0.25 + Math.random() * 0.25;
        const k = ENEMIES[w.kind];
        this.burst({ x: w.x, y: w.ground + k.radius, z: w.z }, SMOKE, 1, 0.5, 0.3, -1.4, 1.4);
      }
      return true;
    });
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

  private tracer(from: Vec3, to: Vec3, color: number, width: number, life = 0.07) {
    let t = this.tracers.find((x) => x.life <= 0);
    if (!t) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ toneMapped: false, color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
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
    t.life = life;
  }

  /** A brief glow of `size` metres at `at`: a muzzle or a blast seen from far off, where particles are too small to see. */
  private flashAt(at: Vec3, color: number, size: number) {
    let f = this.flashes.find((x) => x.life <= 0);
    if (!f) {
      f = { sprite: haloSprite(color, 1, 0), life: 0, max: 0.1 };
      this.flashes.push(f);
      this.scene.add(f.sprite);
    }
    f.sprite.position.set(at.x, at.y, at.z);
    f.sprite.scale.setScalar(size);
    (f.sprite.material as THREE.SpriteMaterial).color.setHex(color);
    f.life = f.max = 0.1;
    f.sprite.visible = true;
  }

  /** Where the gun's muzzle is in the world, for tracers. */
  private muzzleWorld(): THREE.Vector3 {
    const v = new THREE.Vector3(0.22, -0.2, -0.78);
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
            // The robot rocks away from the shot: harder on the weak point, softer when a plate takes it.
            v.flinch = Math.min(1, v.flinch + (e.crit ? 0.8 : e.blocked ? 0.2 : 0.45));
            const from = e.ally ? s.ally.pos : s.player.pos;
            v.pushYaw = Math.atan2(e.pos.x - from.x, -(e.pos.z - from.z));
          }
          // A plate turning a hit aside throws a spray of hot sparks off it, so the player sees the gun is too weak.
          if (e.blocked && !e.crit) {
            this.burst(e.pos, PLATE_SPARK, 16, 10, 0.06, 14, 0.3);
            this.burst(e.pos, 0xffffff, 3, 4, 0.06, 0, 0.06);
          }
          else this.burst(e.pos, e.crit ? PAL.hot : e.shield ? RARITY_COLOR[e.tier] : 0xffffff, e.crit ? 7 : 4, 4, 0.06, 6, 0.3);
          break;
        }
        case "plateBreak": {
          // The plate cracks and its pieces fall off in its colour.
          const v = this.enemies.get(e.id);
          if (v) {
            for (const o of v.plates) o.removeFromParent();
            v.plates = [];
          }
          this.burst(e.pos, RARITY_COLOR[e.tier], 14, 3.5, 0.16, 12, 0.9);
          break;
        }
        case "shieldBreak":
          this.burst(e.pos, RARITY_COLOR[e.tier], 26, 7, 0.1, 5, 0.7);
          hitstop = Math.max(hitstop, 0.05);
          break;
        case "stagger": {
          const v = this.enemies.get(e.id);
          if (v) {
            v.flinch = 1;
            v.pushYaw = Math.atan2(e.pos.x - e.fromX, -(e.pos.z - e.fromZ));
          }
          // Sparks off the joints; a lost wind-up also snuffs the eye's glow in a hot spray.
          this.burst(e.pos, 0xffc070, e.interrupted ? 16 : 9, 6, 0.06, 9, 0.4);
          if (e.interrupted) this.burst({ ...e.pos, y: e.pos.y + 0.6 }, PAL.eye, 8, 4, 0.05, 6, 0.3);
          break;
        }
        case "kill": {
          const v = this.enemies.get(e.id);
          const big = e.kind === "titan" ? 4 : e.kind === "heavy" ? 2 : 1;
          this.burst(e.pos, PAL.armorLight, 18 * big, 7 * Math.sqrt(big), 0.16 * Math.sqrt(big), 14, 1.1);
          this.burst(e.pos, PAL.eye, 6 * big, 5, 0.08, 4, 0.5);
          this.burst(e.pos, 0xffc070, 10 * big, 9, 0.06, 2, 0.35);
          if (v) {
            if (v.lane) this.scene.remove(v.lane);
            if (v.spawnBeam) this.scene.remove(v.spawnBeam);
            this.enemies.delete(e.id);
            this.wreck(v, Math.atan2(e.pos.x - e.fromX, -(e.pos.z - e.fromZ)));
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
        case "enemyFire": {
          const hue = e.friend ? PAL.friendOrb : e.rogue ? PAL.rogueOrb : PAL.orb;
          this.burst(e.pos, hue, 3, 2, 0.06, 0, 0.25);
          if (e.foe) {
            // Fire between the factions: a tracer and a flash that read from far off, thicker with distance (see FACTION).
            const far = Math.hypot(e.pos.x - s.player.pos.x, e.pos.z - s.player.pos.z);
            this.tracer(e.pos, e.foe, hue, 0.04 + far * 0.0016, 0.12);
            this.flashAt(e.pos, hue, 1.2 + far * 0.012);
          }
          break;
        }
        case "robotHit":
          this.burst(e.pos, 0xffc070, 4, 4, 0.05, 8, 0.3);
          break;
        case "fall": {
          // Destroyed by the other faction: it goes down as a wreck, with no feel of the player's own kill.
          const v = this.enemies.get(e.id);
          const big = e.kind === "heavy" ? 2 : 1;
          this.burst(e.pos, e.friend ? PAL.friendArmorLight : e.rogue ? PAL.rogueArmorLight : PAL.armorLight, 14 * big, 7, 0.16, 14, 1.1);
          this.burst(e.pos, 0xffc070, 8 * big, 9, 0.06, 2, 0.35);
          this.flashAt(e.pos, 0xffc070, 3 + Math.hypot(e.pos.x - s.player.pos.x, e.pos.z - s.player.pos.z) * 0.02);
          if (v) {
            if (v.lane) this.scene.remove(v.lane);
            if (v.spawnBeam) this.scene.remove(v.spawnBeam);
            this.enemies.delete(e.id);
            this.wreck(v, Math.atan2(e.pos.x - e.fromX, -(e.pos.z - e.fromZ)));
          }
          break;
        }
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

  /** Per-frame sync and draw. `dt` is real seconds since the last frame. */
  render(s: State, dt: number) {
    this.sync(s, dt);
    this.draw();
  }

  /**
   * Moves the scene to `s` and runs every fade by `dt`, without drawing. Automation calls it
   * on its own for steps nobody looks at: drawing in software is most of a step's cost.
   */
  sync(s: State, dt: number) {
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
    this.camera.position.set(p.pos.x, p.pos.y + this.eyeY + bobY - this.landDip, p.pos.z);
    this.camera.rotation.set(p.pitch + (p.recoil * Math.PI) / 180 + shakeY, -(p.yaw + (p.recoilYaw * Math.PI) / 180) + shakeX, p.sliding ? -0.04 : 0, "YXZ");
    const spec = w0 ? WEAPONS[w0.kind] : WEAPONS.pike;
    // Widenings are written in degrees of the reference view and scaled to this screen's.
    const hip = hipFov(this.camera.aspect);
    const per = hip / FOV_REF;
    const baseFov = hip + ((p.sprinting ? 4 : 0) + (p.leap ? 10 : 0)) * per;
    const fovTarget = baseFov + (zoomedFov(baseFov, spec.adsFov) - baseFov) * p.ads;
    this.fovKick *= Math.exp(-dt * 2.2);
    const fov = fovTarget + this.fovKick * per;
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

    for (const c of this.clouds) c.visible = p.pos.y > 30;
    if (s.storm !== this.storm) {
      this.storm = s.storm;
      this.applyWeather();
    }

    this.syncRoutes();
    this.streamChunks(fx, fz);
    this.scatter.update(fx, fz, this.q.scatterFar);
    // Chunks wholly past the fog are skipped (the camera's view culls the rest), and so are
    // robots, bins and loot far off.
    const fogFar = this.q.fogFar;
    const thingsFar = this.q.thingsFar;
    for (const c of this.chunks) c.group.visible = World.away(c, fx, fz) < fogFar;
    const near = (o: THREE.Object3D) => (o.visible = Math.hypot(o.position.x - fx, o.position.z - fz) < thingsFar);

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
      const reach = Math.min(1, sp / 3) * 0.9;
      am.knees.forEach((k, i) => (k.rotation.x = -Math.max(0, Math.cos(this.allyWalk) * (i ? 1 : -1)) * reach));
      am.arms.rotation.x = a.target ? a.pitch : -0.25;
      if (a.down > 0) {
        // Down: kneeling over, rifle lowered.
        am.body.rotation.set(-1.1, -a.yaw, 0, "YXZ");
        am.root.position.y = a.pos.y + 0.25;
        am.arms.rotation.x = -0.9;
      }
    }

    // --- the camp's factory: one of the player's own robots stands by the parts container (scenery, no box)
    if (this.campMode && !this.factoryBot) {
      const spot = CAMP.spots.find((c) => c.id === "factory");
      if (spot) {
        const m = buildEnemy("grunt");
        m.mats[0].color.setHex(PAL.friendArmor);
        m.mats[1]?.color.setHex(PAL.friendArmorLight);
        (m.eyeHalo.material as THREE.SpriteMaterial).color.setHex(PAL.friendEye);
        (m.eye.material as THREE.MeshBasicMaterial).color.setHex(PAL.friendEye);
        m.root.position.set(spot.x + 2.7, spot.y, spot.z + 0.4);
        m.body.rotation.y = 0.3;
        this.scene.add(m.root);
        this.factoryBot = m.root;
      }
    }
    if (this.factoryBot) this.factoryBot.visible = this.campMode;

    // --- enemies, and the player's own robots among them
    const robots = s.friends.length ? [...s.enemies, ...s.friends] : s.enemies;
    for (const e of robots) {
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
        // A rogue: the same robot in weathered amber, its eye yellow (see FACTION).
        if (e.rogue) {
          // The model's armour materials are its own (`mats`: the armour and its lighter panels).
          m.mats[0].color.setHex(PAL.rogueArmor);
          m.mats[1]?.color.setHex(PAL.rogueArmorLight);
          (m.eyeHalo.material as THREE.SpriteMaterial).color.setHex(PAL.rogueEye);
        }
        // One of the player's own: the same robot in blue, its eye cyan (sim/battle.ts).
        if (e.friend) {
          m.mats[0].color.setHex(PAL.friendArmor);
          m.mats[1]?.color.setHex(PAL.friendArmorLight);
          (m.eyeHalo.material as THREE.SpriteMaterial).color.setHex(PAL.friendEye);
        }
        const plates = e.plate > 0 ? addPlates(m, e.kind, e.plate) : [];
        this.scene.add(m.root);
        const beam = new THREE.Mesh(
          new THREE.CylinderGeometry(0.06, ENEMIES[e.kind].radius * 0.45, 40, 8, 1, true),
          new THREE.MeshBasicMaterial({ toneMapped: false, color: e.friend ? PAL.friendEye : PAL.eye, transparent: true, opacity: 0.3, depthWrite: false, blending: THREE.AdditiveBlending }),
        );
        beam.position.set(e.pos.x, e.pos.y + 20, e.pos.z);
        this.scene.add(beam);
        m.body.rotation.order = "YXZ";
        v = { m, kind: e.kind, flash: 0, flinch: 0, pushYaw: 0, smoke: 0, shieldFlash: 0, walk: 0, spawnBeam: beam, lane: null, plates };
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
      // Flinch: a lean away from the last hits that springs back. Staggered: reeling, rocking on its feet.
      v.flinch *= Math.exp(-dt * 12);
      const staggered = e.mode === "staggered";
      const tip = staggered ? 0.32 + Math.sin(this.time * 26) * 0.06 : v.flinch * (e.kind === "heavy" ? 0.1 : 0.2);
      lean(m.body, e.yaw, v.pushYaw, tip);
      if (staggered) m.root.position.y -= 0.08;
      // Below half its health and shield it smokes, and now and then spits sparks.
      const k0 = ENEMIES[e.kind];
      if (e.kind !== "titan" && e.hp + e.shield < (k0.hp + k0.shield) * 0.5 && (v.smoke -= dt) <= 0) {
        v.smoke = 0.12 + Math.random() * 0.1;
        const top = { x: e.pos.x, y: e.pos.y + k0.bodyY + k0.radius * 0.6, z: e.pos.z };
        this.burst(top, SMOKE, 1, 0.6, 0.22, -1.6, 1.1);
        if (Math.random() < 0.25) this.burst(top, 0xffc070, 3, 3, 0.04, 9, 0.25);
      }
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
      // The thigh swings; the knee bends while its leg comes forward, and straightens to land.
      const stride = Math.min(0.6, sp * 0.15);
      m.legs.forEach((leg, i) => (leg.rotation.x = Math.sin(v!.walk + i * Math.PI) * stride));
      m.knees.forEach((knee, i) => (knee.rotation.x = -Math.max(0, Math.cos(v!.walk + i * Math.PI)) * stride * 1.6));
      // Squatting behind its cover (DUCK), the body sinks by as much as its hit volumes do and the
      // legs fold, thigh forward and shin back, so the feet stay where they stood.
      const drop = e.duck * DUCK.body;
      m.body.position.y = -drop;
      m.shield.position.y = bodyY(e);
      if (drop > 0 && m.knees.length) {
        const hip = m.legs[0].position.y;
        const fold = Math.acos(Math.max(0.05, (hip - drop) / hip));
        m.legs.forEach((leg) => (leg.rotation.x = fold));
        m.knees.forEach((knee) => (knee.rotation.x = -2 * fold));
      }
      if (k.fly > 0) m.body.rotation.z = Math.sin(this.time * 2 + e.id) * 0.15;
      const winding = e.mode === "telegraph" || e.mode === "stomp";
      const tele = winding ? 1 + Math.sin(this.time * 40) * 0.25 + 0.6 : e.mode === "stunned" ? 0.4 : staggered ? 0.5 + Math.random() * 0.5 : 1;
      m.eye.scale.setScalar(tele);
      m.eyeHalo.scale.setScalar(k.weakR * (winding ? 9 : 4));
      (m.eyeHalo.material as THREE.SpriteMaterial).opacity = winding ? 0.95 : 0.55;
      (m.eye.material as THREE.MeshBasicMaterial).color.setHex(e.mode === "stunned" ? 0x9fe8ff : e.friend ? PAL.friendEye : e.rogue ? PAL.rogueEye : PAL.eye);
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
      if (!robots.some((e) => e.id === id)) {
        this.scene.remove(v.m.root);
        if (v.lane) this.scene.remove(v.lane);
        if (v.spawnBeam) this.scene.remove(v.spawnBeam);
        this.enemies.delete(id);
      }
    }
    if (!s.enemies.some((e) => e.kind === "titan" && e.mode === "stomp")) this.stompRing.visible = false;
    this.stepWrecks(dt, fx, fz);
    this.battleView.update(s, dt, fx, fz, thingsFar, fogFar);

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
      // The rogues' bolts burn yellow, the network's magenta.
      const hue = o.friend ? PAL.friendOrb : o.rogue ? PAL.rogueOrb : PAL.orb;
      ((g.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial).color.setHex(hue);
      ((g.children[2] as THREE.Sprite).material as THREE.SpriteMaterial).color.setHex(hue);
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
          new THREE.MeshBasicMaterial({ toneMapped: false, color: PAL.orb, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }),
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
        g = buildLootItem(l.kind, l.rarity, l.weapon?.kind, l.heal, l.valuable, l.tool);
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
    for (const m of this.entryMarks) near(m);
    // The ring's piece lies beside the debris crate, smoking.
    const crate = debrisBin(s);
    if (crate && !this.debris) {
      // A column of grey puffs over the wreck, each rising, swelling and thinning over `PUFF_LIFE` seconds.
      const puffs = Array.from({ length: 14 }, () => {
        const m = new THREE.Mesh(PUFF_GEO, new THREE.MeshLambertMaterial({ color: DEBRIS_SMOKE, transparent: true, opacity: 0, depthWrite: false, flatShading: true }));
        m.visible = false;
        return { m, t: PUFF_LIFE };
      });
      this.debris = { ...buildRingDebris(), smoke: 0, puffs };
      for (const q of puffs) this.scene.add(q.m);
      this.debris.root.position.set(crate.x - 9, crate.y, crate.z + 10);
      this.debris.root.rotation.y = 0.4;
      this.debris.root.updateMatrixWorld(true);
      // Each scar patch lies on the ground under it, which slopes a little across the wreck.
      for (const c of this.debris.root.children)
        if (c.name === "scar") {
          const w = c.getWorldPosition(new THREE.Vector3());
          c.position.y = terrainHeight(w.x, w.z) - crate.y + 0.06;
        }
      this.scene.add(this.debris.root);
    }
    if (this.debris) {
      const d = this.debris;
      const seen = near(d.root);
      if (seen && (d.smoke -= dt) <= 0) {
        const q = d.puffs.find((o) => o.t >= PUFF_LIFE);
        if (q) {
          d.smoke = PUFF_LIFE / d.puffs.length;
          q.t = 0;
          q.m.position.copy(d.vents[Math.floor(Math.random() * d.vents.length)].clone().applyMatrix4(d.root.matrixWorld));
          q.m.rotation.set(Math.random() * 3, Math.random() * 3, 0);
        }
      }
      for (const q of d.puffs) {
        q.t = Math.min(PUFF_LIFE, q.t + dt);
        const f = q.t / PUFF_LIFE;
        q.m.visible = seen && f < 1;
        q.m.position.y += dt * 1.6;
        q.m.position.x += dt * 0.5;
        q.m.scale.setScalar(0.8 + f * 2.6);
        (q.m.material as THREE.MeshLambertMaterial).opacity = 0.55 * Math.min(1, f * 6) * (1 - f);
      }
    }
    this.depots.forEach((v, i) => {
      if (!near(v.root)) return;
      const on = !!s.depots[i];
      if (on !== v.on) {
        v.on = on;
        v.lamp.visible = true;
        (v.lamp.material as THREE.MeshBasicMaterial).color.setHex(on ? MATE_LIGHT : PAL.gun);
        (v.slot.material as THREE.MeshBasicMaterial).color.setHex(on ? MATE_LIGHT : PAL.gun);
      }
      // A lit lamp blinks slowly, so an on depot reads as working from down the road.
      if (on) v.lamp.visible = Math.sin(this.time * 3 + i) > -0.6;
    });
    // --- the front's cores: red while the enemy holds the node, blue the player's (with a flag
    // up); a node off the front wears the enemy's shield. Lit from far off, past the things' range.
    const front = frontNodes(s.nodes);
    const risk = s.phase === "play" ? atRisk(s) : [];
    this.cores.forEach((v, i) => {
      const h = s.nodes[i];
      // A core of the player's the enemy's robots have come to pulses red, seen from across the island.
      const threat = !!s.battle?.threat[i] && s.phase === "play";
      const key = `${h}${front[i] ? "f" : ""}${s.capture?.node === i ? "c" : ""}${threat ? "t" : ""}`;
      v.root.visible = Math.hypot(v.root.position.x - fx, v.root.position.z - fz) < thingsFar * 4;
      if (key !== v.key) {
        v.key = key;
        const col = h === "freed" ? 0x3d8cff : 0xff3b30;
        (v.band.material as THREE.MeshBasicMaterial).color.setHex(col);
        v.halo.material.color.setHex(col);
        v.flag.visible = h === "freed";
        v.shield.visible = h !== "freed" && !front[i];
      }
      if (threat) {
        v.root.visible = true;
        const beat = Math.max(0, Math.sin(this.time * 7));
        const col = beat > 0.5 ? 0xff3b30 : 0x3d8cff;
        (v.band.material as THREE.MeshBasicMaterial).color.setHex(col);
        v.halo.material.color.setHex(0xff3b30);
        v.halo.material.opacity = 0.35 + 0.65 * beat;
        v.halo.scale.setScalar(7 + 9 * beat);
        return;
      }
      if (risk[i]) {
        // The enemy is on its way to take it: a slower red beat in the halo, the band still blue.
        v.root.visible = true;
        const beat = Math.max(0, Math.sin(this.time * 3.5));
        v.halo.material.color.setHex(beat > 0.3 ? 0xff3b30 : 0x3d8cff);
        v.halo.material.opacity = 0.3 + 0.5 * beat;
        v.halo.scale.setScalar(7 + 5 * beat);
        v.key = "";
        return;
      }
      v.halo.scale.setScalar(7);
      if (!v.root.visible) return;
      // A core under capture pulses fast; the others breathe slowly.
      const pulse = s.capture?.node === i ? 0.55 + 0.4 * Math.sin(this.time * 9) : 0.6 + 0.15 * Math.sin(this.time * 1.7 + i);
      v.halo.material.opacity = pulse;
      if (v.flag.visible) v.cloth.rotation.y = 0.15 * Math.sin(this.time * 2.3 + i);
    });
    // --- the ring a capture is held inside
    const cap = s.phase === "play" ? s.capture : null;
    this.captureRing.visible = !!cap;
    if (cap) {
      const core = NODES[cap.node].core;
      this.captureRing.position.set(core.x, core.y + 0.3, core.z);
      const m = this.captureRing.material as THREE.MeshBasicMaterial;
      m.color.setHex(cap.held ? 0x3f86c8 : 0xff8a3c);
      m.opacity = 0.55 + 0.25 * Math.sin(this.time * (cap.held ? 3 : 9));
    }
    // --- the objective's beacon
    this.beacon.visible = !!this.beaconAt && s.phase === "play";
    if (this.beaconAt) {
      this.beacon.position.set(this.beaconAt.x, this.beaconAt.y + 128, this.beaconAt.z);
      // Fades out as the player walks up to it, so it never fills the screen.
      const d = Math.hypot(this.beaconAt.x - fx, this.beaconAt.z - fz);
      (this.beacon.material as THREE.MeshBasicMaterial).opacity = Math.min(0.32, Math.max(0.06, (d - 6) / 120)) * (0.85 + 0.15 * Math.sin(this.time * 2));
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
    if (shipLeft >= 0) {
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
      mat.opacity = Math.min(1, Math.max(0, t.life / 0.07)) * 0.9;
      if (t.life <= 0) t.mesh.visible = false;
    }
    for (const f of this.flashes) {
      if (f.life <= 0) continue;
      f.life -= dt;
      (f.sprite.material as THREE.SpriteMaterial).opacity = Math.max(0, f.life / f.max);
      if (f.life <= 0) f.sprite.visible = false;
    }

    // --- gun
    const key = w0 ? `${w0.kind}-${w0.rarity}` : "";
    if (key !== this.gunKey) {
      this.gun.clear();
      if (w0) {
        const g = buildGun(w0.kind, w0.rarity);
        g.add(buildHands(w0.kind));
        g.scale.setScalar(0.55);
        g.rotation.y = -0.06;
        this.gun.add(g);
      }
      this.gunKey = key;
      this.gunKick = -0.6; // raise-in from below on swap
    }
    this.gunKick += (0 - this.gunKick) * Math.min(1, dt * 14);
    const reloading = p.reload > 0;
    const lowered = !!p.healing || !!p.mantle || !!p.leap || p.downed > 0 || s.phase === "done" || this.campMode;
    const ads = p.ads;
    const gx = 0.2 * (1 - ads);
    const gy = -0.2 + 0.07 * ads - (lowered ? 0.4 : 0) - (reloading ? 0.08 : 0) + Math.sin(this.bob * 2) * 0.01 * (1 - ads);
    const gz = -0.5 + Math.max(0, this.gunKick) * 0.05;
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
  }

  /** Draws the scene as the last `sync()` left it. */
  draw() {
    // On tiers that redraw shadows at their own rate: when that time has passed (in the scene's
    // time, so automation's undrawn steps count) or the camera has gone far enough that the map
    // no longer covers round it.
    const sm = this.renderer.shadowMap;
    if (!sm.autoUpdate && (this.time - this.shadowAt >= 1 / this.q.shadowHz - 1e-4 || this.shadowFrom.distanceToSquared(this.camera.position) > SHADOW_MOVE ** 2)) {
      sm.needsUpdate = true;
      this.shadowAt = this.time;
      this.shadowFrom.copy(this.camera.position);
    }
    this.renderer.info.reset();
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.renderer.clearDepth();
    this.renderer.render(this.gunScene, this.gunCam);
  }

  /** What the last frame cost: draw calls and triangles, and how many chunks were drawn. */
  stats() {
    const r = this.renderer.info.render;
    return {
      calls: r.calls,
      triangles: r.triangles,
      chunks: this.chunks.filter((c) => c.group.visible).length,
      built: this.chunks.filter((c) => c.built).length,
      of: this.chunks.length,
      tier: this.tierNow,
      ratio: this.renderer.getPixelRatio(),
      /** Average milliseconds a chunk took to build, over every build so far. */
      fillMs: this.filled.n ? +(this.filled.ms / this.filled.n).toFixed(1) : 0,
      /** The same for a chunk's trim, and how many chunks carry trim now. */
      trimMs: this.trimmed.n ? +(this.trimmed.ms / this.trimmed.n).toFixed(1) : 0,
      trims: this.chunks.filter((c) => c.trim).length,
      /** Milliseconds the ground scatter last took to lay. */
      layMs: +this.scatter.layMs.toFixed(1),
    };
  }

  /** Stands the objective's beacon at `at` (the current step's place, sim/objective.ts), or takes it down. */
  setBeacon(at: { x: number; y: number; z: number } | null) {
    this.beaconAt = at;
  }

  /** Drop everything that belongs to a run, before starting another. */
  reset() {
    this.beaconAt = null;
    for (const v of this.enemies.values()) {
      this.scene.remove(v.m.root);
      if (v.lane) this.scene.remove(v.lane);
      if (v.spawnBeam) this.scene.remove(v.spawnBeam);
    }
    this.enemies.clear();
    for (const w of this.wrecks) this.scene.remove(w.m.root);
    this.wrecks = [];
    for (const g of this.loot.values()) this.scene.remove(g);
    this.loot.clear();
    for (const b of this.bins.values()) this.scene.remove(b.root);
    this.bins.clear();
    if (this.debris) {
      this.scene.remove(this.debris.root);
      for (const q of this.debris.puffs) this.scene.remove(q.m);
    }
    this.debris = null;
    if (this.care) this.scene.remove(this.care);
    this.care = null;
    this.careBeam.visible = false;
    if (this.dropship) this.scene.remove(this.dropship);
    this.dropship = null;
    if (this.boat) this.scene.remove(this.boat);
    this.boat = null;
    this.particles = [];
    this.shadowAt = -Infinity;
    this.battleView.reset();
  }
}
