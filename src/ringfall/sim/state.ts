import { DROP, ENEMIES, PLAYER, ULT, type EnemyKind, type Flank, type Rarity, type WeaponKind } from "./config";
import { EXTRA_BINS, POIS, SPAWN } from "./map";
import { populate } from "./enemies";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Weapon {
  kind: WeaponKind;
  rarity: Rarity;
  mag: number;
}

export interface Player {
  pos: Vec3;
  vel: Vec3;
  yaw: number; // 0 looks toward -z (north), positive turns toward +x... see forward()
  pitch: number;
  hp: number;
  shield: number;
  armor: Rarity;
  onGround: boolean;
  crouch: boolean;
  sliding: boolean;
  sprinting: boolean;
  forwardHeld: number;
  weapons: (Weapon | null)[];
  slot: number;
  cooldown: number;
  reload: number; // seconds left, 0 = not reloading
  triggerHeld: boolean;
  ads: number; // 0..1
  recoil: number; // degrees currently kicked up, recovers
  tactical: number; // cooldown left
  ult: number; // charge 0..1
  ultTime: number; // seconds of overdrive left
  reveal: number; // seconds left of seeing robots through walls
  stepNoise: number; // seconds until the next sprint footstep sound
  batteries: number;
  battery: number; // channel time left, 0 = not using
  sinceHurt: number;
  downed: number; // seconds left while downed
  selfRevive: number;
  iframes: number;
}

export type EnemyMode = "spawning" | "move" | "telegraph" | "fire" | "lunge" | "recover" | "stomp" | "stunned";

/**
 * What a robot knows. idle: at its post or on patrol. alert: heard or glimpsed
 * something and is looking ("?"). engaged: fighting, with its whole squad ("!").
 */
export type Awareness = "idle" | "alert" | "engaged";

export interface Point {
  x: number;
  z: number;
}

export interface Enemy {
  id: number;
  kind: EnemyKind;
  pos: Vec3;
  vel: Vec3;
  yaw: number;
  hp: number;
  shield: number;
  mode: EnemyMode;
  timer: number;
  cooldown: number;
  shotsLeft: number;
  strafe: number; // +1 / -1
  poi: number;
  lastHit: number; // seconds since the player last hit it (for the HUD bar)
  aimYaw: number;
  aimPitch: number;
  summoned: number; // titan: how many summons used
  squad: number; // index into State.squads
  aware: Awareness;
  detect: number; // 0..1, full = engage
  home: Vec3; // post to return to
  face: number; // yaw watched at the post
  lookT: number; // idle head-turn phase
  goal: Point | null; // alert: where to search
  searchT: number;
  cover: Point | null; // engaged grunt: where it hides
  peek: Point | null; // and where it steps out to shoot
  coverT: number; // seconds until it re-checks its cover
}

export interface SquadState {
  name: string;
  poi: number; // -1 for optional squads between POIs
  patrol: Point[];
  leg: number; // next patrol waypoint
  engaged: boolean;
  sinceSeen: number; // seconds since any member saw the player while engaged
  last: Point; // where the squad last saw the player
}

export interface Orb {
  id: number;
  pos: Vec3;
  vel: Vec3;
  r: number;
  dmg: number;
  life: number;
  homing: boolean;
}

export interface Shockwave {
  x: number;
  z: number;
  y: number;
  r: number;
  hit: boolean;
}

export type LootKind = "weapon" | "armor" | "battery" | "shard";

export interface Loot {
  id: number;
  kind: LootKind;
  weapon?: Weapon;
  rarity: Rarity;
  pos: Vec3;
  vel: Vec3;
  age: number;
}

export interface Bin {
  id: number;
  x: number;
  y: number;
  z: number;
  poi: number;
  open: boolean;
}

export interface CarePackage {
  x: number;
  z: number;
  y: number;
  landed: boolean;
  open: boolean;
  weapon: Weapon;
}

export interface Ring {
  x: number;
  z: number;
  r: number;
  fromX: number;
  fromZ: number;
  fromR: number;
  toX: number;
  toZ: number;
  toR: number;
  t: number; // 0..1 progress of the current shrink
  shrinking: boolean;
}

export type Phase = "drop" | "play" | "extract" | "done";

export type GameEvent =
  | { t: "shot"; weapon: WeaponKind; rarity: Rarity }
  | { t: "tracer"; from: Vec3; to: Vec3; hit: boolean }
  | { t: "impact"; pos: Vec3 }
  | { t: "hit"; id: number; pos: Vec3; dmg: number; crit: boolean; shield: boolean; tier: Rarity; flank: Flank }
  | { t: "shieldBreak"; id: number; pos: Vec3; tier: Rarity }
  | { t: "kill"; id: number; kind: EnemyKind; pos: Vec3; crit: boolean; last: boolean }
  | { t: "hurt"; dmg: number; fromX: number; fromZ: number; shieldBroke: boolean; shield: boolean }
  | { t: "down" }
  | { t: "revive" }
  | { t: "wipe" }
  | { t: "reload"; time: number }
  | { t: "reloaded" }
  | { t: "dry" }
  | { t: "slide" }
  | { t: "jump" }
  | { t: "land"; speed: number }
  | { t: "pickup"; kind: LootKind; rarity: Rarity; label: string }
  | { t: "binOpen"; id: number }
  | { t: "tactical"; targets: Vec3[] }
  | { t: "tacticalMiss" }
  | { t: "ultReady" }
  | { t: "ultStart" }
  | { t: "ultEnd" }
  | { t: "batteryStart" }
  | { t: "batteryDone" }
  | { t: "telegraph"; id: number }
  | { t: "enemyFire"; id: number; pos: Vec3 }
  | { t: "lunge"; id: number }
  | { t: "spawn"; id: number; pos: Vec3 }
  | { t: "suspect"; id: number }
  | { t: "engage"; squad: number; id: number }
  | { t: "calm"; squad: number }
  | { t: "poiStart"; poi: number }
  | { t: "poiClear"; poi: number }
  | { t: "ringClose"; poi: number }
  | { t: "ringHurt" }
  | { t: "careDrop"; x: number; z: number }
  | { t: "careLand"; x: number; z: number }
  | { t: "stomp"; x: number; z: number }
  | { t: "stompTelegraph"; id: number }
  | { t: "bossPhase" }
  | { t: "landed" }
  | { t: "extractReady" }
  | { t: "done" };

export interface Stats {
  kills: number;
  damage: number;
  shots: number;
  hits: number;
  crits: number;
  /** Hits from behind a robot or before it noticed the player. */
  flankHits: number;
  downs: number;
  wipes: number;
  poiTimes: number[];
}

export interface State {
  time: number;
  phase: Phase;
  rng: number;
  nextId: number;
  player: Player;
  enemies: Enemy[];
  squads: SquadState[];
  orbs: Orb[];
  waves: Shockwave[];
  loot: Loot[];
  bins: Bin[];
  care: CarePackage | null;
  ring: Ring;
  poi: number; // index of the current objective POI
  poiActive: boolean; // the player is inside the current POI's area
  poiStart: number;
  extractTime: number;
  events: GameEvent[];
  stats: Stats;
}

export interface Input {
  moveX: number; // -1 left .. 1 right
  moveZ: number; // -1 back .. 1 forward
  lookX: number; // radians, positive turns right
  lookY: number; // radians, positive looks up
  fire: boolean;
  ads: boolean;
  jump: boolean;
  crouch: boolean;
  reload: boolean;
  tactical: boolean;
  ult: boolean;
  interact: boolean;
  swap: boolean;
  slot: number; // -1 none, 0 / 1 select
  battery: boolean;
  /** The input comes from a touch screen (stronger aim assist, see ASSIST.touchPull). */
  touch: boolean;
}

export const idleInput = (): Input => ({
  moveX: 0,
  moveZ: 0,
  lookX: 0,
  lookY: 0,
  fire: false,
  ads: false,
  jump: false,
  crouch: false,
  reload: false,
  tactical: false,
  ult: false,
  interact: false,
  swap: false,
  slot: -1,
  battery: false,
  touch: false,
});

export function newRun(seed = 1): State {
  const bins: Bin[] = [];
  let id = 1;
  POIS.forEach((p, poi) => p.bins.forEach((b) => bins.push({ id: id++, x: b.x, y: b.y ?? 0, z: b.z, poi, open: false })));
  for (const b of EXTRA_BINS) bins.push({ id: id++, x: b.x, y: b.y ?? 0, z: b.z, poi: b.table, open: false });
  const loot: Loot[] = [];
  POIS.forEach((p) =>
    p.floor.forEach((f) => {
      const pos = { x: f.x, y: f.y ?? 0, z: f.z };
      const vel = { x: 0, y: 0, z: 0 };
      if (f.weapon) loot.push({ id: id++, kind: "weapon", rarity: f.weapon[1], weapon: { kind: f.weapon[0], rarity: f.weapon[1], mag: -1 }, pos, vel, age: 99 });
      if (f.armor !== undefined) loot.push({ id: id++, kind: "armor", rarity: f.armor, pos, vel, age: 99 });
      if (f.battery) loot.push({ id: id++, kind: "battery", rarity: 1, pos, vel, age: 99 });
    }),
  );
  const s: State = {
    time: 0,
    phase: "drop",
    rng: seed >>> 0 || 1,
    nextId: id,
    player: {
      pos: { x: SPAWN.x, y: DROP.startY, z: SPAWN.z },
      vel: { x: 0, y: 0, z: 0 },
      yaw: SPAWN.yaw,
      pitch: -0.5,
      hp: PLAYER.hp,
      shield: PLAYER.shieldByTier[0],
      armor: 0,
      onGround: false,
      crouch: false,
      sliding: false,
      sprinting: false,
      forwardHeld: 0,
      weapons: [{ kind: "pike", rarity: 0, mag: -1 }, null],
      slot: 0,
      cooldown: 0,
      reload: 0,
      triggerHeld: false,
      ads: 0,
      recoil: 0,
      tactical: 0,
      ult: ULT.startCharge,
      ultTime: 0,
      reveal: 0,
      stepNoise: 0,
      batteries: 1,
      battery: 0,
      sinceHurt: 99,
      downed: 0,
      selfRevive: 1,
      iframes: 0,
    },
    enemies: [],
    squads: [],
    orbs: [],
    waves: [],
    loot,
    bins,
    care: null,
    ring: { x: 0, z: 0, r: 230, fromX: 0, fromZ: 0, fromR: 230, toX: 0, toZ: 0, toR: 230, t: 1, shrinking: false },
    poi: 0,
    poiActive: false,
    poiStart: 0,
    extractTime: 0,
    events: [],
    stats: { kills: 0, damage: 0, shots: 0, hits: 0, crits: 0, flankHits: 0, downs: 0, wipes: 0, poiTimes: [] },
  };
  populate(s);
  return s;
}

/** Deterministic xorshift; the state is the seed so runs replay exactly. */
export function rand(s: State): number {
  let x = s.rng;
  x ^= x << 13;
  x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5;
  x >>>= 0;
  s.rng = x || 1;
  return (s.rng % 1_000_000) / 1_000_000;
}

export const enemyMax = (k: EnemyKind) => ENEMIES[k].hp + ENEMIES[k].shield;

/** Unit vector the player looks along. yaw 0 = -z, yaw +π/2 = +x. */
export function forward(yaw: number, pitch: number): Vec3 {
  const c = Math.cos(pitch);
  return { x: Math.sin(yaw) * c, y: Math.sin(pitch), z: -Math.cos(yaw) * c };
}
