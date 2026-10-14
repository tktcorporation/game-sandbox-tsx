import { ALLY, DROP, ELITE, ENEMIES, META, RAIDERS, REINFORCE, type ValuableKind, PLAYER, ULT, type EnemyKind, type Flank, type HealKind, type Rarity, type WeaponKind } from "./config";
import { EXTRA_BINS, POIS, poiIndex, SPAWN, type ExtractId } from "./map";
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
  /** Lent for a free raid: it goes back to the trader and never reaches the stash. */
  loan?: boolean;
}

/** What the player takes into a raid. */
export interface Kit {
  weapons: { kind: WeaponKind; rarity: Rarity; loan?: boolean }[];
  armor: Rarity;
  heals: Record<HealKind, number>;
  /** Of `heals`, how many are lent (used first, never brought home). */
  lentHeals: Record<HealKind, number>;
  /** Vault keys taken along, as POI indices. */
  keys: number[];
}

/** The lent kit of a free raid, which is also the default for the gates. */
export const freeKit = (): Kit => ({
  weapons: META.free.weapons.map((w) => ({ ...w, loan: true })),
  armor: 0,
  heals: { ...META.free.heals },
  lentHeals: { ...META.free.heals },
  keys: [],
});

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
  /** Climbing a ledge: rises at the start point, then moves onto the top. */
  mantle: { t: number; dur: number; from: Vec3; to: Vec3 } | null;
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
  /** In the air on the ult's leap, going up and then gliding down; `carry` takes the teammate along. */
  leap: { carry: boolean } | null;
  reveal: number; // seconds left of seeing robots through walls
  stepNoise: number; // seconds until the next sprint footstep sound
  heals: Record<HealKind, number>;
  /** Of `heals`, how many are still lent: used first, and never brought home. */
  lentHeals: Record<HealKind, number>;
  /** Flares carried (0 or 1): they call the plateau pickup. */
  flares: number;
  /** Valuables carried; their worth is the raid's score if the player gets off the island. */
  haul: ValuableKind[];
  /** Keys on the ring, as the POIs whose vaults they open (copies included). They take no bag space. */
  keys: number[];
  /** The bin being searched and for how long, or null. */
  search: { bin: number; t: number } | null;
  /** The item being used and the seconds left; shooting cancels it without using it. */
  healing: { kind: HealKind; t: number } | null;
  sinceHurt: number;
  downed: number; // seconds left while downed
  /** Out of self-revives and down: waiting for the teammate, wiped when `downed` runs out. */
  awaitAlly: boolean;
  selfRevive: number;
  iframes: number;
}

/** The teammate (see ALLY). */
export interface Ally {
  /** False during the drop: it lands with the player. */
  active: boolean;
  pos: Vec3;
  vel: Vec3;
  yaw: number;
  pitch: number;
  hp: number;
  shield: number;
  /** Seconds until it stands up on its own; 0 = up. */
  down: number;
  /** Seconds of the player's revive done on it. */
  helped: number;
  /** Seconds into picking the player up. */
  rescue: number;
  /** The robot it shoots (id), 0 for none. */
  target: number;
  pickT: number;
  cooldown: number;
  shots: number;
  sinceHurt: number;
  /** Index into State.trail of the next footstep to walk to. */
  crumb: number;
  /** Climbing a ledge the player climbed: seconds left with gravity off. */
  climb: number;
  stuckT: number;
  last: Point;
  shortcutT: number;
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
  /** Whom it fights: the player, or the teammate when that one is nearer or shooting it. */
  target: "player" | "ally";
  targetT: number;
  /** Seconds since the teammate last hit it. */
  allyHit: number;
  /** A raider: tougher, deadlier, quicker to turn, and it goes round the player's side. */
  elite: boolean;
}

export interface SquadState {
  name: string;
  poi: number; // -1 for optional squads between POIs
  patrol: Point[];
  leg: number; // next patrol waypoint
  engaged: boolean;
  /** Walks the roads: hears gunfire from further away. */
  roam: boolean;
  /** A reinforcement squad that keeps heading for the player until it first finds them. */
  hunt?: boolean;
  /**
   * Beamed in from afar (reinforcements, raiders): its walkers find their way by the
   * ground's field (hunt.ts) whenever they cannot see whom they are after, fight or not,
   * so one member's sighting does not strand the rest behind a cliff.
   */
  routed?: boolean;
  /** Raiders: elite members, and a closer hunt. */
  elite?: boolean;
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
  allyHit?: boolean;
}

export type LootKind = "weapon" | "armor" | "heal" | "shard" | "flare" | "valuable" | "key";

export interface Loot {
  id: number;
  kind: LootKind;
  weapon?: Weapon;
  heal?: HealKind;
  valuable?: ValuableKind;
  /** For a key: the POI whose vault it opens. */
  key?: number;
  /** Armour the player took off: it can be put back on with the use key, and its shield is not refilled. */
  worn?: boolean;
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
  /** One of the high-rises' top-floor bins, which also hold a flare. */
  flare: boolean;
  /** Locked: opened only with the key of its POI. */
  vault: boolean;
  /** Out on the island between the POIs: `poi` only picks its loot table, and it never holds a key. */
  outside: boolean;
}

export interface CarePackage {
  x: number;
  z: number;
  y: number;
  landed: boolean;
  open: boolean;
  weapon: Weapon;
}

export type Phase = "drop" | "play" | "done";

/** How a raid ended: off the island with what was carried, or wiped out. */
export type Outcome = "extracted" | "dead";

export type GameEvent =
  | { t: "shot"; weapon: WeaponKind; rarity: Rarity }
  | { t: "tracer"; from: Vec3; to: Vec3; hit: boolean }
  | { t: "impact"; pos: Vec3 }
  | { t: "hit"; id: number; pos: Vec3; dmg: number; crit: boolean; shield: boolean; tier: Rarity; flank: Flank; ally: boolean }
  | { t: "shieldBreak"; id: number; pos: Vec3; tier: Rarity }
  | { t: "kill"; id: number; kind: EnemyKind; pos: Vec3; crit: boolean; last: boolean; ally: boolean }
  | { t: "allyShot"; from: Vec3; to: Vec3; hit: boolean }
  | { t: "allyHurt"; dmg: number }
  | { t: "allyDown" }
  | { t: "allyUp"; by: "player" | "self" }
  | { t: "allyRescue" }
  | { t: "awaitAlly" }
  | { t: "hurt"; dmg: number; fromX: number; fromZ: number; shieldBroke: boolean; shield: boolean }
  | { t: "down" }
  | { t: "revive" }
  | { t: "wipe" }
  | { t: "reload"; time: number }
  | { t: "reloaded" }
  | { t: "dry" }
  | { t: "slide" }
  | { t: "jump" }
  | { t: "mantle" }
  | { t: "land"; speed: number }
  | { t: "pickup"; kind: LootKind; rarity: Rarity; label: string }
  | { t: "locked"; poi: number }
  | { t: "binOpen"; id: number }
  | { t: "tactical"; targets: Vec3[] }
  | { t: "tacticalMiss" }
  | { t: "ultReady" }
  | { t: "leap" }
  /** The ult was pressed under a roof: nothing happens and the charge is kept. */
  | { t: "leapBlocked" }
  | { t: "leapLand" }
  | { t: "healStart"; kind: HealKind }
  | { t: "healDone"; kind: HealKind }
  | { t: "telegraph"; id: number }
  | { t: "enemyFire"; id: number; pos: Vec3 }
  | { t: "lunge"; id: number }
  | { t: "spawn"; id: number; pos: Vec3 }
  | { t: "suspect"; id: number }
  | { t: "engage"; squad: number; id: number }
  | { t: "calm"; squad: number }
  | { t: "poiStart"; poi: number }
  | { t: "poiClear"; poi: number }
  | { t: "reinforce"; x: number; z: number }
  | { t: "careDrop"; x: number; z: number }
  | { t: "careLand"; x: number; z: number }
  | { t: "stomp"; x: number; z: number }
  | { t: "stompTelegraph"; id: number }
  | { t: "bossPhase" }
  | { t: "landed" }
  | { t: "titanDown" }
  | { t: "searchStart"; id: number }
  | { t: "raiders"; x: number; z: number }
  | { t: "shipCalled" }
  | { t: "shipLanded" }
  | { t: "flareLit" }
  | { t: "shipWave" }
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
  /** The POIs cleared, in the order they fell. */
  cleared: number[];
  allyDamage: number;
  allyKills: number;
  allyDowns: number;
  /** Times the teammate picked the player up, and the player picked the teammate up. */
  allyRescues: number;
  allyHelped: number;
  /** Robots the player (not the teammate) brought down, by kind. */
  killsBy: Record<EnemyKind, number>;
  /** POIs whose vault the player opened. */
  vaults: number[];
}

export interface State {
  time: number;
  phase: Phase;
  rng: number;
  nextId: number;
  player: Player;
  ally: Ally;
  /** The player's footsteps on the ground, about a metre apart; the teammate walks them. */
  trail: Vec3[];
  enemies: Enemy[];
  squads: SquadState[];
  orbs: Orb[];
  waves: Shockwave[];
  loot: Loot[];
  bins: Bin[];
  care: CarePackage | null;
  /** POIs the player has come into (for the arrival banner), and those cleared of robots. */
  visited: boolean[];
  cleared: boolean[];
  /** Seconds until the next reinforcement squad beams in, and how many have come. */
  reinforceT: number;
  /** When the player touched down: the raid clock starts here. */
  landedAt: number;
  reinforceN: number;
  /** Seconds until the raiders beam in (Infinity once they have). */
  raiderT: number;
  outcome: Outcome | null;
  /** Seconds the player has stood ready in an extraction point. */
  extractTime: number;
  /** Seconds until the dropship lands: -1 not called yet, 0 landed. */
  shipCall: number;
  shipWave: number;
  shipWaveT: number;
  /** The way the player left the island. */
  extractedAt: ExtractId | null;
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
  /** Use the item that fits best: shield first when it is lower, big items for big gaps. */
  heal: boolean;
  /** The input comes from a touch screen (stronger aim assist, see ASSIST.touchPull). */
  touch: boolean;
  /** The use key never swaps back into armour taken off (the bot keeps the better one). */
  keepArmor?: boolean;
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
  heal: false,
  touch: false,
});

export function newRun(seed = 1, kit: Kit = freeKit()): State {
  const bins: Bin[] = [];
  let id = 1;
  POIS.forEach((p, poi) => p.bins.forEach((b) => bins.push({ id: id++, x: b.x, y: b.y ?? 0, z: b.z, poi, open: false, flare: false, vault: !!b.vault, outside: false })));
  for (const b of EXTRA_BINS) bins.push({ id: id++, x: b.x, y: b.y ?? 0, z: b.z, poi: poiIndex(b.table), open: false, flare: !!b.flare, vault: false, outside: true });
  const loot: Loot[] = [];
  POIS.forEach((p) =>
    p.floor.forEach((f) => {
      const pos = { x: f.x, y: f.y ?? 0, z: f.z };
      const vel = { x: 0, y: 0, z: 0 };
      if (f.weapon) loot.push({ id: id++, kind: "weapon", rarity: f.weapon[1], weapon: { kind: f.weapon[0], rarity: f.weapon[1], mag: -1 }, pos, vel, age: 99 });
      if (f.armor !== undefined) loot.push({ id: id++, kind: "armor", rarity: f.armor, pos, vel, age: 99 });
      if (f.heal) loot.push({ id: id++, kind: "heal", heal: f.heal, rarity: 1, pos, vel, age: 99 });
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
      shield: PLAYER.shieldByTier[kit.armor],
      armor: kit.armor,
      onGround: false,
      crouch: false,
      sliding: false,
      mantle: null,
      sprinting: false,
      forwardHeld: 0,
      weapons: [0, 1].map((i) => (kit.weapons[i] ? { ...kit.weapons[i], mag: -1 } : null)),
      slot: 0,
      cooldown: 0,
      reload: 0,
      triggerHeld: false,
      ads: 0,
      recoil: 0,
      tactical: 0,
      ult: ULT.startCharge,
      leap: null,
      reveal: 0,
      stepNoise: 0,
      heals: { ...kit.heals },
      lentHeals: { ...kit.lentHeals },
      flares: 0,
      haul: [],
      keys: [...kit.keys],
      search: null,
      healing: null,
      sinceHurt: 99,
      downed: 0,
      awaitAlly: false,
      selfRevive: 1,
      iframes: 0,
    },
    ally: newAlly(),
    trail: [],
    enemies: [],
    squads: [],
    orbs: [],
    waves: [],
    loot,
    bins,
    care: null,
    visited: POIS.map(() => false),
    cleared: POIS.map(() => false),
    reinforceT: REINFORCE.first,
    landedAt: 0,
    reinforceN: 0,
    raiderT: RAIDERS.at,
    outcome: null,
    extractTime: 0,
    shipCall: -1,
    shipWave: 0,
    shipWaveT: 0,
    extractedAt: null,
    events: [],
    stats: { kills: 0, damage: 0, shots: 0, hits: 0, crits: 0, flankHits: 0, downs: 0, wipes: 0, cleared: [], allyDamage: 0, allyKills: 0, allyDowns: 0, allyRescues: 0, allyHelped: 0, killsBy: { drone: 0, grunt: 0, charger: 0, heavy: 0, titan: 0 }, vaults: [] },
  };
  populate(s);
  return s;
}

export function newAlly(): Ally {
  return {
    active: false,
    pos: { x: SPAWN.x, y: DROP.startY, z: SPAWN.z },
    vel: { x: 0, y: 0, z: 0 },
    yaw: SPAWN.yaw,
    pitch: 0,
    hp: ALLY.hp,
    shield: ALLY.shield,
    down: 0,
    helped: 0,
    rescue: 0,
    target: 0,
    pickT: 0,
    cooldown: 0,
    shots: 0,
    sinceHurt: 99,
    crumb: 0,
    climb: 0,
    stuckT: 0,
    last: { x: SPAWN.x, z: SPAWN.z },
    shortcutT: 0,
  };
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

/** Full health and shield of a robot; raiders have more. */
export const enemyHp = (e: Enemy) => ENEMIES[e.kind].hp * (e.elite ? ELITE.hp : 1);
export const enemyShield = (e: Enemy) => ENEMIES[e.kind].shield * (e.elite ? ELITE.hp : 1);
export const enemyMax = (e: Enemy) => enemyHp(e) + enemyShield(e);

/** Unit vector the player looks along. yaw 0 = -z, yaw +π/2 = +x. */
export function forward(yaw: number, pitch: number): Vec3 {
  const c = Math.cos(pitch);
  return { x: Math.sin(yaw) * c, y: Math.sin(pitch), z: -Math.cos(yaw) * c };
}
