import type { PoiId, RegionId } from "./map";
/**
 * Every tuning number of RINGFALL. Units are metres, seconds and degrees unless noted.
 * Change a number here only together with a re-run of `npm run sim:ringfall` and an
 * update to docs/ringfall/balance.md.
 */

export const TICK = 1 / 60;
export const DEG = Math.PI / 180;

export const WORLD = {
  /**
   * The world's bounds on each axis: the reservoir in the south (+z), the harbor in the
   * north. The coast's cliffs (terrain.ts) stop bodies well inside them.
   */
  x0: -600,
  x1: 600,
  z0: -1220,
  z1: 660,
  gravity: 15,
  stepUp: 0.45,
};

export const PLAYER = {
  radius: 0.4,
  eye: 1.6,
  eyeCrouch: 1.0,
  hp: 100,
  walk: 4.6,
  sprint: 7.2,
  crouch: 2.6,
  accel: 70, // reaches top speed in ~0.1 s
  airAccel: 14,
  jump: 5.4,
  slideStart: 9.6, // speed set at slide start when slower
  slideFriction: 4.2,
  slideMin: 4.0,
  /** Share of gravity along the ground that pulls a slide down a slope, and its top speed. */
  slideSlope: 0.7,
  slideMax: 15,
  autoSprintAfter: 0.2, // forward input without firing for this long turns into a sprint
  regenDelay: 5,
  regenPerSec: 6,
  /** Health comes back on its own only this far; above it takes a syringe or a med kit. */
  regenCap: 30,
  shieldByTier: [25, 50, 75, 100],
  downedTime: 3,
  reviveHp: 60,
  reviveIframes: 1.5,
  shardShield: 8,
  shardMagnet: 7,
  pickupRange: 2.6,
  interactRange: 2.4,
};

/**
 * Climbing over a ledge in the air while pushing toward it. Hands reach `reach`
 * above the feet, so a jump clears about 2.9 m: crates, containers, low walls and
 * rock shelves, but not a storey (3.4 m).
 */
export const MANTLE = {
  reach: 1.9,
  /** Seconds to climb the full reach; a lower ledge is quicker. */
  time: 0.5,
  /** How far past the body the hands look for the edge, and where the feet land. */
  probe: 0.2,
  land: 0.5,
  /** Speed kept after climbing, along the way the player faced. */
  exitSpeed: 4,
};

export type HealKind = "cell" | "battery" | "syringe" | "medkit";

/**
 * Healing items. Small ones are quick and top up; big ones fill but leave the player
 * slow and unable to shoot for longer, and every one is heard nearby (`NOISE.heal`), so
 * healing belongs after breaking contact, not in the middle of a fight. `amount` 0 fills.
 */
export const HEALS: Record<HealKind, { label: string; short: string; shield: boolean; amount: number; time: number; max: number }> = {
  cell: { label: "シールドセル", short: "セル", shield: true, amount: 25, time: 1.8, max: 6 },
  battery: { label: "シールドバッテリー", short: "バッテリー", shield: true, amount: 0, time: 3.6, max: 3 },
  syringe: { label: "注射器", short: "注射器", shield: false, amount: 25, time: 2.1, max: 4 },
  medkit: { label: "医療キット", short: "医療キット", shield: false, amount: 0, time: 4.5, max: 2 },
};
export const HEAL_KINDS = Object.keys(HEALS) as HealKind[];

export const ASSIST = {
  /**
   * Half-angle of the cone in which a shot that misses the hitbox still hits the enemy.
   * Narrow enough that a strafing robot has to be tracked: a crosshair left where the
   * robot was misses once it has moved a body width.
   */
  hipCone: 1.5,
  adsCone: 2.1,
  /** Touch input: the cone is this much wider, since a thumb tracks a jinking target less closely than a mouse. */
  touchCone: 1.35,
  /** Extra metres of tolerance far away, so distant enemies are not impossible. */
  farPadding: 0.2,
  /** Look sensitivity multiplier while the crosshair is near an enemy. */
  slowdown: 0.55,
  slowCone: 9,
  /**
   * Fraction of the angle to the target closed per second while aiming down sights, moving
   * or not. Hip fire gets no pull: the help goes to the deliberate aimed shot, not to
   * strafing and spraying.
   */
  pull: 1.6,
  /**
   * Touch aiming: pull also works while firing from the hip, and this much faster.
   * A thumb cannot hold aim and track at once the way a mouse hand can.
   */
  touchPull: 1.8,
  pullCone: 12,
  range: 70,
};

export type WeaponKind = "pike" | "hornet" | "maul" | "lance" | "talon";
export type Rarity = 0 | 1 | 2 | 3; // white, blue, purple, gold

export interface WeaponSpec {
  name: string;
  label: string;
  dmg: number;
  pellets: number;
  interval: number; // seconds between shots
  auto: boolean;
  mag: number;
  reload: number;
  hipSpread: number;
  adsSpread: number;
  falloffStart: number;
  falloffEnd: number;
  falloffMin: number;
  crit: number;
  recoil: number; // degrees of pitch kick per shot
  /** Degrees of sideways kick per shot, scaled by `KICK_PATTERN` along a spray (0: none). */
  kick: number;
  /**
   * The vertical view while aiming, in degrees, written against a 74° vertical hip view: the view
   * (view/world.ts) narrows by the same ratio of half-angle tangents from whatever hip view the screen has.
   */
  adsFov: number;
  /** Aiming looks through a scope: the view zooms to adsFov behind a round sight, with no gun in view. */
  scope?: true;
}

export const WEAPONS: Record<WeaponKind, WeaponSpec> = {
  pike: { name: "PIKE", label: "アサルトライフル", dmg: 14, pellets: 1, interval: 0.1, auto: true, mag: 24, reload: 1.6, hipSpread: 1.3, adsSpread: 0.3, falloffStart: 40, falloffEnd: 70, falloffMin: 0.7, crit: 1.75, recoil: 0.32, kick: 0.32, adsFov: 52 },
  hornet: { name: "HORNET", label: "サブマシンガン", dmg: 10, pellets: 1, interval: 0.066, auto: true, mag: 26, reload: 1.3, hipSpread: 2.0, adsSpread: 0.9, falloffStart: 18, falloffEnd: 40, falloffMin: 0.55, crit: 1.6, recoil: 0.22, kick: 0.28, adsFov: 60 },
  maul: { name: "MAUL", label: "ショットガン", dmg: 11, pellets: 8, interval: 0.8, auto: false, mag: 6, reload: 2.2, hipSpread: 5.0, adsSpread: 3.6, falloffStart: 9, falloffEnd: 22, falloffMin: 0.3, crit: 1.5, recoil: 2.2, kick: 0.9, adsFov: 62 },
  // A bolt-action sniper: one hit drops most robots that have not noticed the player.
  talon: { name: "TALON", label: "スナイパー", dmg: 90, pellets: 1, interval: 1.2, auto: false, mag: 5, reload: 2.6, hipSpread: 4.5, adsSpread: 0, falloffStart: 999, falloffEnd: 1000, falloffMin: 1, crit: 2.0, recoil: 3.2, kick: 0, adsFov: 18, scope: true },
  lance: { name: "LANCE", label: "マークスマン", dmg: 48, pellets: 1, interval: 0.36, auto: false, mag: 10, reload: 2.0, hipSpread: 1.6, adsSpread: 0, falloffStart: 999, falloffEnd: 1000, falloffMin: 1, crit: 2.0, recoil: 1.6, kick: 0.5, adsFov: 38 },
};

/**
 * The sideways kick along a spray, shot by shot: a drift right, a swing left, back
 * right, repeating. Fixed rather than random, so holding the trigger is a pattern the
 * player learns to pull against. The spray restarts after `KICK_RESET` s without a shot.
 */
export const KICK_PATTERN = [0.3, 0.6, 0.9, 1, 0.7, 0.2, -0.4, -0.9, -1, -0.8, -0.3, 0.3, 0.8, 1, 0.6, 0, -0.6, -1, -0.9, -0.4];
export const KICK_RESET = 0.35;

/** Interval multiplier when a semi-auto weapon repeats because the trigger is held. */
export const SEMI_HOLD = 1.3;

/** Per-rarity multipliers. Gold also reloads the magazine on every kill. */
export const RARITY = {
  names: ["コモン", "レア", "エピック", "レジェンド"],
  mag: [1, 1.25, 1.5, 1.5],
  dmg: [1, 1, 1.1, 1.15],
  reload: [1, 0.95, 0.9, 0.85],
};

export const TACTICAL = {
  cooldown: 12,
  range: 32,
  cone: 75,
  maxTargets: 4,
  dmg: 40,
  stun: 1.3,
};

/**
 * The ult: a leap straight up into the sky and a glide away, to break off a fight that
 * is going wrong. It goes up only under open sky, carries a teammate standing close,
 * and comes down only on low ground. The launch is loud, and in the air
 * the robots can still see and shoot: where to glide to decides whether it works.
 */
export const ULT = {
  dmgPerCharge: 1100, // damage dealt for a full charge
  /** Charge gained per second on top of the damage: a full gauge in 150 s of doing nothing. */
  perSec: 1 / 150,
  startCharge: 0.5,
  /** Upward speed at launch (m/s): about 26 m up under the island's gravity. */
  rise: 28,
  /** Fastest the glide sinks (m/s) once past the top. */
  fall: 8,
  /** Horizontal speed steered in the air (m/s) and how quickly it is reached. */
  glide: 15,
  glideAccel: 20,
  /** Seconds of glide ahead checked for high ground, which the glider keeps out of. */
  edgeLook: 0.4,
  /** Open sky needed above the head to go up at all. */
  headroom: 8,
  /** A standing teammate within this many metres comes along. */
  carry: 20,
};

export type EnemyKind = "drone" | "grunt" | "charger" | "heavy" | "titan";

export interface EnemySpec {
  hp: number;
  shield: number;
  shieldTier: Rarity;
  radius: number; // body sphere radius
  bodyY: number; // body sphere centre above feet
  weakY: number;
  weakR: number;
  weakFwd: number; // weak point offset toward facing
  speed: number;
  fly: number; // hover height, 0 = walks
  range: number; // preferred distance to the player
  telegraph: number;
  cooldown: number;
  shots: number;
  shotGap: number;
  spread: number; // degrees between pellets of one volley (fan)
  orbSpeed: number;
  orbDmg: number;
  orbR: number;
  ult: number; // ult charge multiplier for damage to this kind
}

export const ENEMIES: Record<EnemyKind, EnemySpec> = {
  drone: { hp: 70, shield: 0, shieldTier: 0, radius: 0.55, bodyY: 0, weakY: 0, weakR: 0.24, weakFwd: 0.42, speed: 4.2, fly: 3.4, range: 14, telegraph: 0.55, cooldown: 1.6, shots: 1, shotGap: 0, spread: 0, orbSpeed: 120, orbDmg: 21, orbR: 0.2, ult: 1 },
  grunt: { hp: 140, shield: 70, shieldTier: 1, radius: 0.65, bodyY: 1.2, weakY: 2.0, weakR: 0.27, weakFwd: 0.08, speed: 3.2, fly: 0, range: 15, telegraph: 0.6, cooldown: 1.5, shots: 3, shotGap: 0.16, spread: 0, orbSpeed: 140, orbDmg: 20, orbR: 0.18, ult: 1 },
  charger: { hp: 120, shield: 50, shieldTier: 0, radius: 0.72, bodyY: 0.75, weakY: 0.95, weakR: 0.3, weakFwd: 0.62, speed: 6.4, fly: 0, range: 0, telegraph: 0.6, cooldown: 1.2, shots: 0, shotGap: 0, spread: 0, orbSpeed: 0, orbDmg: 40, orbR: 0, ult: 1 },
  heavy: { hp: 270, shield: 130, shieldTier: 2, radius: 1.1, bodyY: 1.8, weakY: 3.0, weakR: 0.4, weakFwd: 0.1, speed: 2.0, fly: 0, range: 18, telegraph: 0.85, cooldown: 3.2, shots: 5, shotGap: 0, spread: 5, orbSpeed: 110, orbDmg: 18, orbR: 0.26, ult: 1 },
  titan: { hp: 3200, shield: 1000, shieldTier: 3, radius: 2.3, bodyY: 3.2, weakY: 3.4, weakR: 0.75, weakFwd: 2.1, speed: 1.6, fly: 0, range: 20, telegraph: 1.0, cooldown: 3.0, shots: 6, shotGap: 0.16, spread: 0, orbSpeed: 13, orbDmg: 9, orbR: 0.48, ult: 0.5 },
};

export const CHARGER = { lungeSpeed: 19, lungeTime: 0.38, lungeRange: 8, hitRadius: 1.3 };

export const TITAN = {
  stompRange: 26,
  stompSpeed: 15,
  stompDmg: 24,
  stompHeight: 0.7, // feet above ground needed to jump over the wave
  stompTelegraph: 1.1,
  homing: 0.55, // radians per second the rockets turn
  summonAt: [0.66, 0.33],
  enrageAt: 0.5,
};

export type ValuableKind = "fuse" | "parts" | "wire" | "board" | "drive" | "gyro" | "core" | "reactor";

/**
 * Things worth carrying out. Every bin holds one (which kinds is the POI's `loot.valuable`);
 * robots drop some; the best sit up high, in the vaults or with the titan. Small and dear
 * (the drive) is what a pouch wants; big and dear (the reactor) has to be carried home.
 */
export const VALUABLES: Record<ValuableKind, { label: string; value: number; size: number; rarity: Rarity }> = {
  fuse: { label: "ヒューズ", value: 60, size: 1, rarity: 1 },
  parts: { label: "部品", value: 100, size: 1, rarity: 1 },
  wire: { label: "銅線の束", value: 180, size: 2, rarity: 1 },
  board: { label: "回路基板", value: 300, size: 2, rarity: 2 },
  drive: { label: "記憶装置", value: 450, size: 1, rarity: 2 },
  gyro: { label: "ジャイロ", value: 650, size: 2, rarity: 3 },
  core: { label: "データコア", value: 1000, size: 3, rarity: 3 },
  reactor: { label: "小型炉心", value: 2200, size: 4, rarity: 3 },
};

/** What the top-floor bins of the high-rises hold instead of their table's valuable, with weights. */
export const TOP_BINS: [ValuableKind, number][] = [["core", 2], ["gyro", 1], ["board", 2]];

/**
 * Valuables robots drop: the titan and heavies always theirs, the others one of `scrap`
 * with its chance (one roll for the lot).
 */
export const ROBOT_DROPS = {
  titan: ["core", "core"] as ValuableKind[],
  heavy: ["board"] as ValuableKind[],
  scrap: [["fuse", 0.15], ["parts", 0.15]] as [ValuableKind, number][],
};

/**
 * Each raid, one POI of the region dropped into has bins that lean rare: they hold `kind`
 * (one of the rarer kinds of its own table) as often as `share` times everything else
 * together. Which POI and kind follow from the raid's seed (`boostFor()` in state.ts), so
 * the base's radio can tell them before the raid.
 */
export const BOOST = { share: 1 };

/** The bag the valuables go in: what does not fit stays on the ground unless something cheaper makes way. */
export const BAG = { slots: 10 };

/**
 * The depots outside the POIs (`DEPOTS`): walked up to once, one stays on for good. Its use
 * key sends the bag home, or, with the bag empty, leaves the raid there; a later raid may
 * start from any depot already on. The map is uncovered cell by cell where the player walks.
 */
export const DEPOT = {
  /** Metres: walking this close switches a depot on. */
  radius: 6,
  /** Seconds standing at it after choosing to leave. */
  leave: 5,
  /** Metres behind a depot a raid started there begins: inside its reach (PLAYER.interactRange + 1). */
  back: 2.5,
  /**
   * Metres: a robot fighting the player this close shuts the depots (about twice a robot's
   * sight). One further off is outrun: the titan, which never stands down, shuts only depots
   * near its arena.
   */
  safe: 60,
  /** Metres: a side of one cell of the explored map. */
  cell: 20,
  /** Cells uncovered round the player's own, each way. */
  sight: 1,
  /**
   * Credits' worth sent home through one depot, over all raids, that each level of it needs.
   * A start at a depot skips the walk in from the region's edge and begins beside a POI with the teammate, so the gear it
   * may carry is earned at that depot: the more it has been trusted with, the more it lets in.
   */
  levels: [0, 1500, 5000, 12000],
  /** Loadout points a raid started from a depot may carry, by that depot's level. A start at a way in has no limit. */
  budget: [2, 4, 6, 9],
  /**
   * Points a stash weapon costs, by rarity. The lent free kit and every heal cost nothing: a
   * start with them alone is always allowed, so a depot never locks the player out.
   */
  weaponCost: [1, 2, 3, 4],
  /** Points armour costs, by tier (tier 0 is no armour). */
  armorCost: [0, 1, 2, 3],
  /** Points a vault key costs: it opens a POI's best bin, worth a step of rarity in a weapon. */
  keyCost: 1,
};

/**
 * Walking back into the camp's yard during a raid ends it alive with the bag, as an extraction
 * does, once no robot fighting the player is within `DEPOT.safe`. Only a return counts: the yard
 * takes the player home after `away` seconds outside it, so walking out of the gate starts a raid
 * and a step back through it does not end one.
 */
export const HOME = { away: 10 };

/**
 * The island's state between raids (meta/island.ts): each raid is one day, and each POI is
 * held, thin or freed. A POI cleared in a raid the player gets off alive is freed; one freed and
 * left unvisited for `thinAfter` days goes thin. A thin POI's garrison keeps `thinKeep` of its
 * squads (the vault guard's among them), so going back to it is a smaller fight than the first.
 */
export const ISLAND = {
  /** Days a freed POI stays freed without a visit. */
  thinAfter: 3,
  /** Share of a thin POI's squads that stand, rounded up. */
  thinKeep: 0.5,
};

/**
 * The front (解放戦線, docs/ringfall/liberation-front.md): the freeable POIs and the outposts are
 * the island's nodes (`NODES`, `FRONT_LINKS` in map.ts), and only a node next to the player's
 * ground (the camp and the nodes freed) can be taken, by its core (`core`): a pillar `height`
 * metres tall near the node's middle. The use key starts the capture; the meter fills over
 * `capture` seconds while the player stands within `radius` of the core (and within `rise` of
 * its foot's height) with no robot within the same radius. The node's garrison makes for the
 * core, and `push` squads come from each neighbouring node the player does not hold (at most
 * `pushMax`), beamed in a walk of `pushDist` from the core on the side of their node, `pushAt`
 * seconds after the start and again every `pushEvery` seconds while the capture lasts and the
 * player stays near (at most `pushWaves` times). Once
 * taken, what is left of the garrison walks off for `retreat` seconds and is gone, and no robot
 * comes within `zone` metres of the core again (the node is the player's, as the camp is). Each
 * node the player holds pays `income` credits a day at the settle (an outpost `outpost` of it).
 */
export const FRONT = {
  capture: 45,
  radius: 12,
  rise: 4,
  height: 4,
  /** Half the core's footprint, in metres. */
  half: 0.45,
  zone: 30,
  /** Metres from a core within which the player counts as having come to the node (an outpost freed lapses unvisited, as a POI). */
  visit: 60,
  retreat: 8,
  /** The waves of the push, by network level: the members of each squad. */
  push: [["grunt"], ["grunt"], ["grunt", "drone"], ["grunt", "drone"], ["grunt", "grunt"], ["grunt", "grunt", "drone"]] as EnemyKind[][],
  /** Neighbouring nodes that send a squad, at most, by network level. */
  pushMax: [1, 1, 1, 2, 2, 2],
  /** Waves of the push at most, per capture, by network level. */
  pushWaves: [1, 1, 1, 1, 2, 2],
  pushAt: 6,
  pushEvery: 30,
  pushDist: [70, 130] as const,
  income: 150,
  outpost: 0.5,
};

/**
 * 陣取り戦 (docs/ringfall/liberation-front.md): a raid of the island (`Start.battle`) is one battle
 * of `time` seconds, the raid's time limit, over every node at once. Each node held scores its
 * holder `points` a second (the player, the network, the rogues), and the camp scores the player
 * `camp`; the battle is won when the player's score beats the network's, which pays `win` credits.
 * A battle lost hands the network one node on the edge of the player's ground overnight.
 *
 * Squads come out of the nodes (the player's from the factory, `FACTORY`; the network's and the
 * rogues' below) and walk the links between them (`FRONT_LINKS`) at `pace` of their slowest
 * member's speed (a patrol's walk, `AWARE.idleSpeed` times `PATROL.pace`). A squad within `near` metres of the player or the teammate is robots in the
 * world; one further than `far` from both, and not fighting the player, is numbers again: its
 * members' kinds, health and shield, and where it is on its link. Away from the player the
 * battle is reckoned every `tick` seconds: squads within `meet` metres of a hostile one fight it,
 * and a squad at a node fights its holders there (abstract squads, and the node's garrison,
 * which comes to its core); each member deals `dps` of its kind times `hit` a second to
 * the first of the other side's. A node is taken by a side whose squads stand within `zone` of its
 * core (robots in the world) or at it (numbers) for `capture` seconds with none of its holder's
 * there: the player and the teammate hold their own nodes too.
 *
 * The network makes a squad each time its nodes have worked `net.every[level]` seconds (a POI 1,
 * an outpost `net.outpost`, and the ground it never gives up, the titan's pad and the north
 * shore, `net.edge`), more the more nodes it holds; it answers the player's ground too, working
 * `net.answer` for each node the player holds as for one of its own, and keeps at most
 * `net.max[level]` squads out at once, one more for each three nodes the player holds; the rogues likewise by `rogue`. A node makes nothing while the player is within `near`
 * of it, and the network lands a squad on a node of `NET_EDGE` it does not hold from beyond it.
 */
export const CONQUEST = {
  time: 1500,
  points: { poi: 3, outpost: 1 },
  camp: 10,
  win: 400,
  tick: 1,
  near: 250,
  far: 300,
  meet: 35,
  zone: 20,
  capture: 30,
  hit: 0.4,
  pace: 0.6,
  /** Damage a second of each kind at full accuracy: its burst over its cooldown, wind-up and burst. */
  dps: { drone: 10, grunt: 25, charger: 30, heavy: 22, titan: 0 } as Record<EnemyKind, number>,
  net: {
    every: [1500, 1350, 1200, 1050, 900, 750],
    edge: 3,
    answer: 1,
    max: [2, 2, 3, 3, 4, 4],
    outpost: 0.5,
    kinds: [["grunt", "grunt"], ["grunt", "grunt"], ["grunt", "drone"], ["grunt", "grunt", "drone"], ["grunt", "heavy"], ["grunt", "grunt", "heavy"]] as EnemyKind[][],
  },
  rogue: { every: 1500, max: 1, kinds: ["grunt", "grunt"] as EnemyKind[] },
  /** Seconds the bot gives to coming back to a node of its own under attack, all told in a raid. */
  botDefend: 150,
};

/** One level of the factory: what it takes from the stash, as a hideout module's level does (`ModuleLevel`). */
export interface FactoryLevel {
  items: [ValuableKind, number][];
  cash: number;
  does: string;
}

/**
 * The camp's factory (工場): the player's own robots. At each level (index 0 is the factory the
 * camp starts with) it makes a squad of `kinds` every `every` seconds of the battle, keeps at most
 * `max` out walking at once (squads that hold a node they took or defended do not count), and
 * stands `turrets` turrets (a robot that never leaves the core) at each node the player holds at
 * the raid's start: a POI's, and from `turretOutposts` an outpost's too. `levels[n]` is what
 * building level n + 1 takes.
 */
export const FACTORY = {
  name: "工場",
  every: [240, 210, 180, 150, 120],
  max: [1, 1, 2, 2, 3],
  kinds: [["grunt", "grunt"], ["grunt", "grunt"], ["grunt", "heavy"], ["grunt", "heavy", "drone"], ["grunt", "grunt", "heavy", "drone"]] as EnemyKind[][],
  turrets: [0, 0, 0, 1, 1],
  turretOutposts: 4,
  levels: [
    { items: [["parts", 3], ["fuse", 2]], cash: 2500, does: "作る間隔が 210 秒" },
    { items: [["parts", 4], ["wire", 2]], cash: 7000, does: "ヘビーを作る・作る間隔が 180 秒・同時に 2 部隊" },
    { items: [["wire", 3], ["board", 2]], cash: 14000, does: "ドローンを作る・作る間隔が 150 秒・解放した拠点に砲台" },
    { items: [["board", 3], ["drive", 2]], cash: 24000, does: "4 体の部隊・作る間隔が 120 秒・同時に 3 部隊・小拠点にも砲台" },
  ] as FactoryLevel[],
};

/** What one network level sets in a raid (`NETWORK.levels`). */
export interface NetworkLevel {
  /** A short word for the level, for the map table's meter. */
  name: string;
  /** What the level does, in a few words, beside the meter. */
  note: string;
  /** Seconds to the first reinforcement squad and between the next (`REINFORCE.first`, `REINFORCE.every`). */
  reinforce: { first: number; every: number };
  /** Seconds to the raiders (`RAIDERS.at`). */
  raiders: number;
  /** Hunting parties in each region (`PARTY.count`). */
  parties: Record<RegionId, number>;
  /** Drone packs flying in each region, of the region's `PACKS`. */
  packs: Record<RegionId, number>;
  /** Share of the grunts and heavies, raiders aside, that wear a tier-1 plate (see PLATE). */
  plate: number;
  /** Salvage crews (`CREW`) that come into the region the raid starts in. */
  crews: number;
}

/**
 * The robots' network (網の段階), 0 to 5, kept on the profile: how hard the whole island is.
 * Each day adds `base + perHeld` for each POI held (`thinWeight` for one thin) to a pressure,
 * and the network rises a step each time the pressure reaches `riseEvery`, so a player who
 * frees nothing sees it climb from `start` to the top in about nine days, and one who holds
 * the ground sees it climb a step every three days or so. A day that starts at the top gathers
 * nothing, so a step taken off the top holds for a while. Freeing a held POI takes it down a
 * step (`relayPoi` two; from thin as from held, since each takes a capture of its core),
 * killing the titan a step, and destroying a relay mast a step (`relayHigh.steps` on a day that
 * started at `relayHigh.at` or higher). A thin POI goes back to held
 * once it has been thin `retakeAfter` days while the network stands at `retakeAt` or higher;
 * relay masts (`RELAYS`) stand in the raid from `relayAt`.
 *
 * `levels[2]` is the island the bots' balance tables are played on: its numbers are the
 * reinforcement times, raider time, parties and packs of `REINFORCE`, `RAIDERS`, `PARTY` and
 * `PACKS`, with no plates added. Lower levels give more time and fewer hunters; higher ones
 * bring every wave sooner, more parties, and plates on the plain robots. A salvage crew (`CREW`)
 * comes into the starting region from level 3, two from level 4; below level 3 crews come only
 * on a crews' visit, which adds one at every level, so `levels[2]` plays as the island without crews.
 */
export const NETWORK = {
  start: 1,
  max: 5,
  riseEvery: 2,
  base: 0.55,
  perHeld: 0.05,
  thinWeight: 0.5,
  relayPoi: 2,
  retakeAt: 3,
  retakeAfter: 2,
  relayAt: 3,
  /** A relay mast destroyed on a day that started at network `at` or higher takes it `steps` down. */
  relayHigh: { at: 4, steps: 2 },
  levels: [
    { name: "途切れ", note: "増援は遅く、群れと遊撃隊は少ない", reinforce: { first: 480, every: 360 }, raiders: 1020, parties: { reservoir: 1, harbor: 1 }, packs: { reservoir: 1, harbor: 1 }, plate: 0, crews: 0 },
    { name: "弱い", note: "増援は遅く、群れは少ない", reinforce: { first: 435, every: 300 }, raiders: 900, parties: { reservoir: 1, harbor: 1 }, packs: { reservoir: 2, harbor: 1 }, plate: 0, crews: 0 },
    { name: "並", note: "いつもの島", reinforce: { first: 390, every: 270 }, raiders: 780, parties: { reservoir: 2, harbor: 2 }, packs: { reservoir: 3, harbor: 2 }, plate: 0, crews: 0 },
    { name: "強い", note: "増援が早い・中継器が立つ", reinforce: { first: 240, every: 195 }, raiders: 600, parties: { reservoir: 2, harbor: 2 }, packs: { reservoir: 3, harbor: 2 }, plate: 0.15, crews: 1 },
    { name: "厳しい", note: "増援が早い・遊撃隊が増える・装甲板が増える", reinforce: { first: 210, every: 170 }, raiders: 540, parties: { reservoir: 3, harbor: 3 }, packs: { reservoir: 3, harbor: 2 }, plate: 0.3, crews: 2 },
    { name: "最大", note: "増援が次々来る・遊撃隊が増える・装甲板が多い", reinforce: { first: 180, every: 140 }, raiders: 480, parties: { reservoir: 3, harbor: 3 }, packs: { reservoir: 3, harbor: 2 }, plate: 0.45, crews: 2 },
  ] satisfies NetworkLevel[],
  /** The level the sim gate's raids are played at, and a raid's when the start names none. */
  play: 2,
};

/**
 * A relay mast (網の中継器, `RELAYS` in map.ts): a lattice mast `height` metres tall with a red
 * eye at the top, hit as a post of `radius` (up to `top` metres under the eye, where the lattice
 * narrows) and the eye as a weak point of `eyeR`, taking
 * `hp` of weapon damage (the eye `eyeMult` times). It stands only at networks of
 * `NETWORK.relayAt` and up, guarded by a squad of two.
 */
export const RELAY = { hp: 900, height: 13, radius: 0.85, top: 1.5, eyeR: 0.7, eyeMult: 2 };

/**
 * The camp's contract board (meta/contracts.ts): `count` contracts a day, built from the island
 * and the profile, of which the player takes one or none. Rewards, in credits:
 * - free a POI: `freePerRobot` for each robot of its garrison that day;
 * - bring home valuables from a POI's bins: `fetchShare` of their worth, at least `fetchMin`,
 *   asking for as many as its bins hold on average, up to `fetchMax`, and one more of them on top;
 * - destroy a drone pack or a hunting party: `intercept` by target, and on some days a heal or a
 *   weapon, one step rarer every `rarityEvery` days;
 * - destroy a named relay mast: `destroy`;
 * - destroy the squad the network sends to retake a freed POI: `defend`.
 * Each is multiplied by the region's `region` factor: the harbor is the harder ground.
 */
export const CONTRACT = {
  count: [3, 4] as const,
  freePerRobot: 150,
  fetchShare: 0.6,
  fetchMin: 300,
  fetchMax: 3,
  intercept: { pack: 500, party: 800, crew: 900 },
  /** Destroying a named relay mast: credits, and the network a step lower overnight. */
  destroy: 1000,
  /** Destroying the retake squad sent to a freed POI: credits, and the POI stays freed. */
  defend: 1000,
  rarityEvery: 6,
  region: { reservoir: 1, harbor: 1.4 } satisfies Record<RegionId, number>,
};

/** The island's events (島の出来事): at most one a day, announced the day before (meta/island.ts). */
export type EventKind = "debris" | "retake" | "storm" | "crews";

/**
 * How often each event comes: a day has one with `chance`, picked by `weights` among those the
 * island allows (a retake only while some POI is freed). Drawn from the profile's seed and the
 * day alone, so the schedule is fixed as soon as it is announced.
 */
export const EVENTS = {
  chance: 0.5,
  weights: { debris: 3, retake: 3, storm: 2, crews: 2 } satisfies Record<EventKind, number>,
  names: { debris: "破片の落下", retake: "奪還", storm: "嵐", crews: "回収部隊の来訪" } satisfies Record<EventKind, string>,
};

/**
 * A debris fall (破片の落下): a piece of the ring lies at one of `DEBRIS_SPOTS` (map.ts) for the
 * day, with a crate (a bin out on the island, so it counts for no fetch contract) that holds
 * `count` valuables drawn from `valuables` and `heals` heals, guarded by `guards` at its foot.
 */
export const DEBRIS = {
  valuables: [["drive", 4], ["gyro", 3], ["core", 2]] as [ValuableKind, number][],
  count: 3,
  heals: 1,
  guards: ["heavy", "drone", "drone"] as EnemyKind[],
};

/**
 * A retake (奪還): `at` seconds into the raid the network beams a squad of `kinds` in out of the
 * player's sight, `dist` metres' walk from a freed POI, and it walks to the POI's way in and holds
 * it there. Its plain grunts and heavies wear plates of `plate[level]` (none at 0). Left alive by
 * the end of the day's raid, it turns the POI thin overnight.
 */
export const RETAKE = {
  at: 90,
  name: "奪還部隊",
  kinds: [
    ["grunt", "grunt", "charger"],
    ["grunt", "grunt", "heavy"],
    ["grunt", "grunt", "charger", "drone"],
    ["heavy", "grunt", "grunt", "drone"],
  ] as EnemyKind[][],
  plate: [0, 0, 1, 1, 2, 2] as Rarity[],
  dist: [110, 200] as const,
  away: 90,
};

/**
 * A storm (嵐): robots see `sight` as far (their kind's `SIGHT`, a pack's sight, and the range
 * they answer from afar, `RETURN`), and the view draws the fog `fog` times as near.
 */
export const STORM = { sight: 0.6, fog: 0.6 };

/**
 * Salvage crews (回収部隊), as many as `NETWORK.levels[].crews` plus one on a crews' visit: squads
 * drawn from `squads` that beam in out of the player's sight,
 * `away` metres from them or more, `arrive` seconds into the raid (each crew its own draw), at a
 * stop of the starting region (`PARTY_STOPS`). Most are pairs: a crew met in the open is a
 * fight on top of whatever the player is in, and three of them more often turns it. They walk by
 * the ground's way, at `pace` of their slowest member's speed, to the unopened bin of the region's
 * POIs nearest by that walk that stands on the open ground (not a vault) and lies beyond `wary` of the
 * player, stand `SEARCH.time` within `reach` of it, and take its valuable into their bag (the
 * rest of what it holds is lost). With `bag` valuables, or `leaveAfter` seconds after
 * arriving, or no bin left, they walk to the region's nearest way off and beam out there (or where
 * they stand, held up `stuck.tries` times on the way). A crew that gets out raises the network a
 * step overnight; the last one of a crew to fall drops the bag. Like a hunting party, it fights
 * what it meets and does not come to distant gunfire. Its choices come from a stream of its own.
 */
export const CREW = {
  name: "回収部隊",
  squads: [
    ["grunt", "grunt"],
    ["grunt", "charger"],
    ["grunt", "grunt"],
    ["grunt", "grunt", "charger"],
  ] as EnemyKind[][],
  arrive: [20, 70] as const,
  away: 100,
  /** Metres from the player inside which a crew picking its next bin passes a bin over. */
  wary: 80,
  pace: 0.7,
  reach: 2.2,
  bag: 4,
  leaveAfter: 300,
  /** Metres from its way off at which a leaving crew beams out. */
  out: 6,
  stuck: { time: 15, moved: 3, tries: 3 },
};

/**
 * The ways in on foot (`ENTRIES`) a player has walked to: one reached in a raid that ends with
 * the player off alive can be chosen at the base from then on. A player starts knowing only
 * the reservoir's first.
 */
export const ENTRY = {
  /** Metres: walking this close to a way in, on its ground, finds it. */
  radius: 10,
  /** Metres above or below the ground there that still counts as on it (not a bridge or roof overhead). */
  rise: 3,
};

/**
 * Between raids: what the player keeps, what things cost, and what is lost. Whatever is
 * taken into a raid is lost with it on a wipe, except what fits in the pouch: the most
 * valuable things in the bag, up to its slots. A raid with the free kit risks nothing:
 * its gear is lent and goes back at the end, whatever happens.
 */
export const META = {
  /** Things the stash holds (each weapon, armour, item or valuable is one). */
  stash: 40,
  /** Bag slots (as `VALUABLES[].size`) whose contents come home even from a wipe. */
  pouch: 2,
  start: {
    cash: 1500,
    weapons: [{ kind: "pike", rarity: 0 }, { kind: "hornet", rarity: 0 }] as { kind: WeaponKind; rarity: Rarity }[],
    heals: { cell: 2, battery: 0, syringe: 2, medkit: 0 } as Record<HealKind, number>,
  },
  /** The lent kit of a free raid. */
  free: {
    weapons: [{ kind: "pike", rarity: 0 }, { kind: "talon", rarity: 0 }] as { kind: WeaponKind; rarity: Rarity }[],
    heals: { cell: 2, battery: 0, syringe: 2, medkit: 0 } as Record<HealKind, number>,
  },
  /** Trader prices. A weapon's price is its base times its rarity's factor. */
  weapon: { pike: 600, hornet: 500, maul: 700, lance: 900, talon: 1200 } as Record<WeaponKind, number>,
  rarityFactor: [1, 2.5, 5, 9],
  /** Armour by tier (1 to 3); tier 0 is none. */
  armor: [0, 400, 1200, 3000],
  heal: { cell: 60, battery: 250, syringe: 60, medkit: 250 } as Record<HealKind, number>,
  /** What a key counts as for selling (the trader never sells keys). */
  key: 800,
  /** Share of the price the trader pays for gear (valuables sell at their full value). */
  sellShare: 0.4,
  /** The best rarity of weapon and tier of armour the trader sells; better is found in raids. */
  shopRarity: 1 as Rarity,
  /**
   * The trader also sells valuables, at `markup` times their value: those no rarer than
   * the gear it sells (`shopRarity`, raised by the workbench), so the common parts never
   * hold the hideout up and credits buy the rarer ones once the workbench is built.
   */
  materials: { markup: 2 },
};

export type ModuleId = "infirmary" | "workbench" | "storage" | "radio" | "pouch";

/** One level of a hideout module: what it takes from the stash. Level N is built only on level N - 1. */
export interface ModuleLevel {
  items: [ValuableKind, number][];
  cash: number;
  /** What this level does, in a line, for the base. */
  does: string;
}

/**
 * The hideout at the base: modules built level by level from specific valuables and some
 * credits, all taken from the stash. The top levels ask for the rarest valuables (the data core,
 * the small reactor). Each level's effect is the number at its place in the module's own list
 * below (index 0 is the module unbuilt).
 */
export const HIDEOUT: Record<ModuleId, { name: string; note: string; levels: ModuleLevel[] }> = {
  infirmary: {
    name: "医務室",
    note: "毎回のレイドに回復を持たせる（貸出装備でも）",
    levels: [
      { items: [["parts", 3], ["fuse", 3]], cash: 500, does: "注射器 +1" },
      { items: [["parts", 3], ["board", 3], ["fuse", 2]], cash: 2000, does: "注射器 +1、シールドセル +2" },
      { items: [["board", 3], ["drive", 2], ["gyro", 2], ["reactor", 1]], cash: 4000, does: "注射器 +2、シールドセル +2、医療キット +1" },
    ],
  },
  workbench: {
    name: "作業台",
    note: "商人が売る武器とアーマー、材料の質が上がる",
    levels: [
      { items: [["parts", 4], ["wire", 2], ["fuse", 2]], cash: 800, does: "商人がエピックまで売る。回路基板と記憶装置も売る" },
      { items: [["board", 5], ["drive", 3], ["gyro", 3]], cash: 5000, does: "商人がレジェンドまで売る。ジャイロ、データコア、小型炉心も売る" },
    ],
  },
  storage: {
    name: "倉庫",
    note: "倉庫に置ける数が増える",
    levels: [
      { items: [["parts", 3], ["wire", 2]], cash: 600, does: "倉庫 +10" },
      { items: [["wire", 3], ["board", 3], ["fuse", 2]], cash: 2000, does: "倉庫 +10" },
      { items: [["board", 3], ["drive", 2], ["gyro", 2], ["core", 1]], cash: 4000, does: "倉庫 +10" },
    ],
  },
  radio: {
    name: "無線機",
    note: "出撃前に島の様子が分かる",
    levels: [
      { items: [["wire", 2], ["board", 2], ["drive", 1]], cash: 1200, does: "珍しい物が多い拠点が分かる" },
      { items: [["board", 3], ["drive", 2], ["gyro", 2], ["core", 1]], cash: 4000, does: "その拠点で出やすい物と、レイダーの降りる時刻も分かる" },
    ],
  },
  pouch: {
    name: "ポーチ",
    note: "倒れても残る枠が増える",
    levels: [
      { items: [["wire", 2], ["board", 2]], cash: 1000, does: "ポーチ 3 枠" },
      { items: [["drive", 3], ["gyro", 2], ["core", 1]], cash: 3500, does: "ポーチ 4 枠" },
    ],
  },
};

/** The hideout's effects, by module level (index 0 is unbuilt), on top of `META`'s base numbers. */
export const HIDEOUT_EFFECT = {
  /** Heals the infirmary adds to every raid's kit, lent like the free kit's. */
  infirmary: [{}, { syringe: 1 }, { syringe: 1, cell: 2 }, { syringe: 2, cell: 2, medkit: 1 }] as Partial<Record<HealKind, number>>[],
  /** Steps of rarity the trader sells above `META.shopRarity`. */
  workbench: [0, 1, 2],
  /** Room in the stash above `META.stash`. */
  storage: [0, 10, 20, 30],
  /** Pouch slots above `META.pouch`. */
  pouch: [0, 1, 2],
};

/**
 * Searching a bin takes time with the hands busy and makes a noise; a top-floor bin
 * of a high-rise takes longer. Moving away, shooting or healing breaks it off.
 */
export const SEARCH = { time: 2.2, flareTime: 3.5, vaultTime: 5, noise: 9 };

/**
 * Vaults: one locked bin per POI, opened only with that POI's key. A key turns up in the
 * bins of the POI before it (`(poi + 3) % 4`, so the supply depot's key is at the landing
 * pad), comes home like any other find and opens its vault on every later raid.
 */
export const VAULT = {
  keyChance: 0.15,
  weapon: [["talon", 3], ["lance", 3], ["pike", 3], ["hornet", 3], ["maul", 2]] as [WeaponKind, Rarity][],
  armor: 3 as Rarity,
  /**
   * The plate (see PLATE) of the guard posted nearest each vault. The guard stands in a POI
   * the raid clears on its way, so its plate stays light: a rare gun pierces it and the free
   * kit's common one still does half.
   */
  guardPlate: 1 as Rarity,
  valuables: [["reactor"], ["core", "drive"], ["gyro", "drive", "drive"]] as ValuableKind[][],
  heals: 2,
};

export type ModKind =
  | "leech"
  | "hush"
  | "grip"
  | "medic"
  | "probe"
  | "damper"
  | "scrambler"
  | "deflector"
  | "medlink"
  | "carrier"
  | "piercer"
  | "jolt"
  | "lock"
  | "stalker"
  | "capacitor"
  | "surge"
  | "sponge"
  | "mender"
  | "stride"
  | "stock";

/**
 * Mod parts (改造パーツ): the raid's own build. Each one sets a single number of a system the
 * sim already has, read where that system is (`modScale()` in sim/mods.ts), so the bot and the
 * player meet the same rules. `value` is that number: a factor on what the system does (or,
 * for `leech`, the shield it gives back). `start` marks the kinds a new profile knows; the others
 * are learned by analysing one the player brought out alive (`analyse()` in meta/profile.ts).
 */
export const MODS: Record<ModKind, { name: string; short: string; note: string; value: number; start?: true }> = {
  leech: { name: "吸電コイル", short: "コイル", note: "弱点に当てるとシールドが 4 戻る", value: 4, start: true },
  hush: { name: "消音ソール", short: "ソール", note: "しゃがんでいると、ロボットに気づかれる距離が 2 割縮む", value: 0.8, start: true },
  grip: { name: "速装グリップ", short: "グリップ", note: "リロードが 2 割速い", value: 0.8, start: true },
  medic: { name: "応急パッチ", short: "パッチ", note: "回復にかかる時間が 3 割短い", value: 0.7, start: true },
  probe: { name: "探査ピック", short: "ピック", note: "箱を漁る時間が 3 割短い", value: 0.7, start: true },
  damper: { name: "静歩ダンパー", short: "ダンパー", note: "走る足音の届く距離が半分になる", value: 0.5, start: true },
  scrambler: { name: "電波撹乱器", short: "撹乱器", note: "ドローンの視界に入っても、検知が 4 割遅くたまる", value: 0.6 },
  deflector: { name: "偏向膜", short: "偏向膜", note: "自分を狙うロボットの弾が 1.6 倍それる", value: 1.6 },
  medlink: { name: "救命リンク", short: "リンク", note: "リオが自分を起こす時間が 4 割短い", value: 0.6 },
  carrier: { name: "搬送ベルト", short: "ベルト", note: "リオを起こす時間が 4 割短い", value: 0.6 },
  piercer: { name: "貫通弾芯", short: "弾芯", note: "装甲板に止められる威力が半分になる", value: 0.5 },
  jolt: { name: "衝撃弾", short: "衝撃弾", note: "ロボットのよろめきが 3 割たまりやすい", value: 1.3 },
  lock: { name: "照準補正器", short: "補正器", note: "覗き込んだときの照準の吸い付きが 1.5 倍", value: 1.5 },
  stalker: { name: "背撃モジュール", short: "背撃", note: "背後から撃ったときの威力が 15% 上がる", value: 1.15 },
  capacitor: { name: "放電コンデンサ", short: "アーク", note: "アークの再使用が 3 割早い", value: 0.7 },
  surge: { name: "加速炉", short: "加速炉", note: "離脱ジャンプのたまりが 3 割速い", value: 1.3 },
  sponge: { name: "欠片吸収体", short: "吸収体", note: "欠片で戻るシールドが 1.5 倍", value: 1.5 },
  mender: { name: "自己修復材", short: "修復材", note: "体力の自然回復が 2 倍速い", value: 2 },
  stride: { name: "軽量フレーム", short: "フレーム", note: "動きが 8% 速い", value: 1.08 },
  stock: { name: "安定ストック", short: "ストック", note: "反動が 3 割小さい", value: 0.7 },
};
export const MOD_KINDS = Object.keys(MODS) as ModKind[];
/** The kinds a new profile knows. */
export const MOD_START = MOD_KINDS.filter((k) => MODS[k].start);

/**
 * Where mod parts come from and how many a body holds. A body wears `slots` of them; they take no
 * bag slots. A bin other than a vault holds one with `bin`, of a kind the profile knows; a robot
 * drops one as it falls with `robot`, a salvage crew's member or a raider with `elite` and the
 * titan always, of any kind, so new kinds are found on robots. Each chance is multiplied by the
 * raid's threat (`THREAT.levels[].mods`). Which bin or robot holds one, and of which kind, is
 * decided from the raid's seed and the bin or robot, never from the raid's random numbers, so a
 * raid in which nothing is picked up plays out as one without mods.
 */
export const MOD = { slots: 3, bin: 0.08, robot: 0.03, elite: 0.3 };

/**
 * The threat (脅威度) the player chooses for a raid at the map table, 0 to `max`: on top of the
 * network's numbers (`NETWORK.levels`), the reinforcements come `reinforce` times as soon and as
 * often, the raiders `raiders` times as soon, `plate` more of the plain grunts and heavies wear a
 * tier-1 plate, and robots answer shots from afar `range` times as far (`RETURN`). In return the
 * taken contract pays `reward` times its credits, mod parts turn up `mods` times as often, and a
 * POI freed at `freeAt` or higher takes the network a step further down. Threat 0 is the raid as
 * the network alone sets it.
 */
export interface ThreatLevel {
  reinforce: number;
  raiders: number;
  plate: number;
  range: number;
  reward: number;
  mods: number;
}
export const THREAT = {
  max: 5,
  freeAt: 3,
  levels: [
    { reinforce: 1, raiders: 1, plate: 0, range: 1, reward: 1, mods: 1 },
    { reinforce: 0.9, raiders: 0.92, plate: 0.05, range: 1.1, reward: 1.15, mods: 1.25 },
    { reinforce: 0.8, raiders: 0.84, plate: 0.1, range: 1.2, reward: 1.3, mods: 1.5 },
    { reinforce: 0.72, raiders: 0.76, plate: 0.15, range: 1.3, reward: 1.5, mods: 1.75 },
    { reinforce: 0.64, raiders: 0.68, plate: 0.22, range: 1.4, reward: 1.75, mods: 2 },
    { reinforce: 0.56, raiders: 0.6, plate: 0.3, range: 1.5, reward: 2, mods: 2.5 },
  ] satisfies ThreatLevel[],
};

export type ToolKind = "cutter" | "charge";

/**
 * Tools open the blocked routes (`ROUTES` in map.ts) for good once one reaches the stash.
 * Each lies in the bins of one POI (`from`): every bin there but the vault holds it with
 * `chance`, decided from the raid's seed and the bin rather than the raid's random numbers, so
 * the rest of every bin's loot is the same with tools as without. A tool fills `size` bag
 * slots, and one whose routes are all open sells for `value`.
 */
export const TOOLS: Record<ToolKind, { label: string; size: number; value: number; from: PoiId; chance: number }> = {
  cutter: { label: "ボルトカッター", size: 2, value: 700, from: "yard", chance: 0.1 },
  charge: { label: "発破キット", size: 3, value: 900, from: "quarry", chance: 0.1 },
};
export const TOOL_KINDS = Object.keys(TOOLS) as ToolKind[];

/**
 * Reinforcements: a squad beams in somewhere `dist` metres from the player, out of
 * sight, every `every` seconds after the first `first`, and comes looking for them.
 * Later waves are bigger. The longer a raid lasts, the more is hunting the player. The gap
 * between waves leaves a quiet walk between the fights a wave brings.
 */
export const REINFORCE = {
  first: 390,
  every: 270,
  /** Seconds between fresh guesses of where the player is while a reinforcement squad hunts. */
  huntEvery: 8,
  dist: [80, 165] as const,
  waves: [
    ["grunt", "drone"],
    ["grunt", "drone", "charger"],
    ["grunt", "grunt", "drone", "charger"],
    ["heavy", "grunt", "drone", "drone"],
  ] as EnemyKind[][],
};

/**
 * Drone packs (`PACKS` in map.ts): a few drones flying long loops over the open ground between
 * the POIs, quicker than a patrol walks (`pace`, a share of their combat speed) and noticing the
 * player from further than other drones (`sight` metres, in place of `SIGHT.drone`'s range; they
 * still fire only as far as a drone sees), so crossing the ground between POIs brings one into
 * view. A raid starts each pack at a waypoint of its loop at least `away` metres from the player,
 * drawn from the packs' and parties' own random numbers (`roamRand()`): one sighting `sight`
 * metres off takes more than the first seconds of a raid to fly into.
 */
export const PACK = { sight: 75, pace: 0.9, away: 140 };

/**
 * Hunting parties: `count` ground squads in each region that walk from stop to stop of their
 * region (`PARTY_STOPS` in map.ts) by the ground's way (hunt.ts's field), at `pace` of their
 * slowest member's combat speed, and stay `linger` seconds at each stop before going on to
 * another. They fight what they meet as any squad does. A party wiped out is replaced `respawn`
 * seconds later by one that beams in within `scatter` metres of a stop of its region, out of the
 * player's sight and at least `away` metres from them; the raid's first parties are placed by the
 * same rule. Past `seen` metres, as far as the view draws a robot, one counts as out of sight
 * whatever lies between. Each is drawn from `squads`. A party whose leader has moved less than
 * `stuck.moved` metres in `stuck.time` seconds of walking makes for another stop. Line-ups,
 * stops, spawns and waits are drawn from their own random numbers (`roamRand()`).
 */
export const PARTY = {
  count: { reservoir: 2, harbor: 2 } satisfies Record<RegionId, number>,
  name: "遊撃隊",
  pace: 0.7,
  linger: [20, 40] as const,
  respawn: [60, 120] as const,
  away: 100,
  seen: 220,
  scatter: 10,
  /** Metres from its stop at which a party's leader has arrived there. */
  arrive: 4,
  stuck: { time: 15, moved: 3 },
  squads: [
    ["grunt", "grunt"],
    ["grunt", "charger"],
    ["grunt", "drone"],
    ["heavy", "grunt"],
  ] as EnemyKind[][],
};

/**
 * The raiders: one elite squad that beams in once the raid has gone on a while and hunts
 * the player down, closer on their heels than reinforcements. In a fight one member holds
 * the player's attention while the others go wide to the sides.
 */
export const RAIDERS = {
  at: 780,
  name: "レイダー",
  kinds: ["grunt", "grunt", "grunt"] as EnemyKind[],
  huntEvery: 4,
  /** The elite squad wears plates (see PLATE): a common gun does half its damage to their bodies. */
  plate: 2 as Rarity,
};

/** How much tougher, deadlier and quicker an elite robot (a raider) is than a plain one. */
export const ELITE = {
  hp: 1.5,
  dmg: 1.3,
  cooldown: 0.75,
  turn: 1.2,
  /** Degrees either side of facing it can fire into (`AWARE.fireCone` for plain robots). */
  fireCone: 50,
  /** How far to the side of the player a flanking raider goes. */
  flankDist: 11,
};

/**
 * A squad of two or more that has had the player pinned to one spot for `after` seconds
 * (the spot it last saw them at has moved less than `radius` metres) goes round it: one
 * member keeps facing and shooting at the spot, the others walk to points `dist` metres
 * to either side of it, across the line from that member. Staying put in front of a squad
 * gets the player caught between two; moving or breaking line of sight is the answer.
 *
 * Backing away does not shake it either: once the squad has seen the player moving away
 * from its front member faster than `backSpeed` m/s for `retreat` seconds (the time
 * decays twice as fast while they do not), it goes round the spot `lead` seconds ahead
 * along the player's way instead, the first of the others on the side the player is
 * heading for: one presses in, another cuts off the retreat.
 */
export const PINCH = { after: 4, radius: 4, dist: 10, retreat: 1.5, backSpeed: 1.5, lead: 1.2 };

/**
 * A fighting squad that loses sight of the player goes after them rather than standing at
 * the last sighting. It carries that spot on along the player's last seen motion (`lead`
 * seconds of it, at most `leadMax` metres), and its walkers make for it by the ground's
 * way round cliffs and buildings (hunt.ts, `reach` metres of walking at most): the first
 * member straight at it, the others at points `spread` metres to either side, across the
 * squad's line of approach, so the corner the player hides behind is come round from more
 * than one side. After `approach` seconds each sweeps the ground round the spot, a new
 * point up to `sweep` metres from it every `sweepEvery` seconds. Any sound the player makes
 * within `hear` times its radius of a member (a shot, a heal, a sprint) tells the squad
 * where they are now, and so does a hit by them (not the teammate's sounds or hits): breaking
 * sight buys a few seconds and a new angle to shoot from, not a reset. A squad that has gone `AWARE.chaseTime` without seeing,
 * hearing or being hit by the player gives up and searches.
 */
export const PURSUE = { lead: 1.5, leadMax: 9, reach: 90, spread: 7, approach: 5, sweep: 10, sweepEvery: 3.5, hear: 2 };

/**
 * Robot fire: shots are fast enough that a sidestep in the open does not get out of the
 * way at fighting ranges, so the glow before a burst means "get behind something". Getting a
 * body's width (about 0.6 m) off the aim point takes a person some 0.2 s to react to the bolt
 * and 0.15 s to step; `orbSpeed` of 110-140 m/s brings a shot across 40 m in about 0.3 s. Each
 * shot aims at the target's chest led by `lead` of its motion over the flight time, and is
 * aimed afresh for every shot of a burst while the robot sees its target. Every shot also
 * strays by a random angle (`spread` degrees, standard deviation), which matters only far
 * off: up close a burst lands, from beyond 30 m a good part of it misses. A squad out on a walk
 * between the POIs (`MOBILES`) strays `walker` times as far at the player and the teammate, and
 * its shots land `walkerDmg` of their damage: the ground between is crossed under many eyes, so
 * meeting a walker is a short fight that costs a little, not one of the POIs' hard fights.
 */
export const SHOT = { lead: 0.85, spread: 1.5, walker: 2, walkerDmg: 0.6 };

/**
 * Being shot from beyond a robot's sight is answered. For `time` seconds after each of the
 * player's hits on a squad from beyond the hit robot's fighting sight (`SIGHT` times
 * `AWARE.engagedRange`), its members notice the player and fire at them out to `range` metres
 * (eye to chest, as sight is measured) in place of their fighting sight, while they face the
 * player and have a clear line: the hit already told the squad where the shot came from, and it
 * turns there. The kinds with no range here (the drone, the charger) close in instead, and a
 * member with no line walks toward the shooter by the ground's way until it has one. Bolts that
 * far off land as SHOT's stray decides: a burst at 130 m mostly flies past and now and then
 * hits, enough to send a sniper behind something.
 */
export const RETURN = {
  time: 7,
  range: { drone: 0, grunt: 140, charger: 0, heavy: 140, titan: 0 } satisfies Record<EnemyKind, number>,
};

/**
 * How robots notice the player. Each robot has a view cone; while it sees the
 * player its detection fills (faster up close), and at full the whole squad
 * engages. Crouching shrinks the range and slows the fill.
 */
export const SIGHT: Record<EnemyKind, { range: number; fov: number }> = {
  drone: { range: 39, fov: 150 },
  grunt: { range: 45, fov: 110 },
  charger: { range: 30, fov: 120 },
  heavy: { range: 42, fov: 100 },
  titan: { range: 51, fov: 160 },
};

export const AWARE = {
  /** Within this distance a robot senses the player in any direction. */
  closeSense: 4.5,
  crouchRange: 0.55,
  crouchRate: 0.6,
  /** Seconds to fill detection at point-blank, plus this much more at the edge of sight. */
  fillNear: 0.35,
  fillFar: 1.5,
  /** Detection at which a robot turns to look (the "?" state). */
  suspicious: 0.3,
  decay: 0.25,
  /** An alerted robot searches this long before going back to its post. */
  searchTime: 9,
  /**
   * A fighting robot that has not seen the player this long has lost them, even if they
   * did not move (see `located()`).
   */
  loseTime: 8,
  /**
   * An engaged squad that has gone this long without seeing, hearing or being hit by the
   * player goes back to searching (see PURSUE).
   */
  chaseTime: 18,
  idleSpeed: 0.45, // fraction of combat speed while patrolling or searching
  /**
   * At most this many squads fight at once. Another squad that spots the player
   * keeps searching ("?") until one of them is down, unless the player comes within
   * `joinClose` metres or shoots it. This keeps a POI a series of fights, not a crowd.
   */
  maxSquads: 2,
  joinClose: 5,
  /** A fighting robot looks wider and further than a calm one, but never behind itself. */
  engagedFov: 1.2,
  engagedRange: 1.25,
  /** A squad tracks the player's true position only this long after a member last saw them. */
  trackTime: 0.4,
  /** A robot fires only when the player is within this many degrees of where it faces. */
  fireCone: 40,
  /**
   * A fighting robot that has not located the player (see FLANK.blindTime) finds them in
   * this share of the time a calm one takes to notice them at that distance.
   */
  locate: 0.5,
  /** Seconds out of sight over which a fighting robot's progress toward finding the player drains away. */
  findKeep: 1,
  /**
   * Seconds from a squad engaging to each member's first chance to fire: `react[0]` for the
   * first member, `react[1]` more for each after it, so a squad's opening bursts come one
   * after another rather than on the same tick, and the glow of each can be read.
   */
  react: [0.35, 0.45] as const,
  /**
   * A squad whose members have ducked behind cover keeps hold of a player it was just seeing
   * for up to this many seconds, as long as the player stays within `FLANK.moved` of where it
   * last saw them: a member at cover knows where they stood, as a peek would show. Standing in
   * the open does not make the player lost; moving off, or staying hidden longer, does.
   */
  coverHold: 3,
};

/**
 * Turning speed in radians per second while fighting. A robot cannot snap round,
 * so circling to its side or back while it faces the last known position works.
 */
export const TURN: Record<EnemyKind, number> = {
  drone: 3.6,
  grunt: 3.0,
  charger: 3.8,
  heavy: 1.6,
  titan: 1.2,
};

export type Flank = "front" | "side" | "back" | "ambush" | "none";

/**
 * Damage by where the shot comes from, measured from the way the robot faces. The
 * first hit on a robot that has not noticed the player is an ambush, and so is a hit
 * on a fighting robot that has not located the player itself. The titan
 * takes plain damage from every side.
 */
export const FLANK = {
  frontArc: 55, // degrees either side of facing
  backArc: 115, // beyond this many degrees from facing
  mult: { front: 0.75, side: 1, back: 2.2, ambush: 3, none: 1 } satisfies Record<Flank, number>,
  /**
   * Heavies and raiders brace for the first shot: an ambush on them counts this much
   * instead of `mult.ambush`, so a sniper's opener drops a grunt or a drone outright but
   * only opens a fight with the big ones.
   */
  ambushTough: 1.5,
  /**
   * A fighting robot that has gone this many seconds without seeing the player, or being
   * hit by them, while the player moved away from where it saw them (`moved`), has lost
   * them (and so has one that has not seen them for `AWARE.loseTime`, wherever they are):
   * it must find them again before it fires (`AWARE.locate`), and the player's hits
   * on it until then are an ambush. One hit wakes the whole squad, but the members that
   * never saw the player are still there for the taking, and so is a squad that lost the
   * player behind cover and is shot from somewhere new.
   */
  blindTime: 2.5,
  /** Metres the player must move from where a robot last saw them for it to lose them. */
  moved: 6,
};

/**
 * Armour plates. Some robots wear a plate of tier 1-3 (0 is none). A weapon pierces a
 * plate of tier up to its own rarity; a body hit from a weapon of lower rarity deals
 * `mult[plate - rarity]` of its damage. Weak-point hits always pass in full, and damage
 * that does not come from a weapon (the arc) is never reduced, so a plated robot is
 * an aim check or a reason to bring better gear, never a wall.
 */
export const PLATE = {
  mult: [1, 0.6, 0.5, 0.35] as number[],
};

/**
 * How a fighting robot moves. It strafes across the player's view while it sees them,
 * changes direction every so often, and keeps sidestepping through its wind-up and burst
 * (`windup`, a fraction of its speed: the heavy plants its feet to fire, the charger
 * holds its lane). The first hit after a quiet spell makes it jink the other way, faster,
 * for `jinkTime` s.
 */
export const DODGE = {
  /** Fraction of its speed a robot strafes at between attacks while it sees its target. */
  strafe: 1,
  windup: { drone: 0.7, grunt: 0.6, charger: 0, heavy: 0, titan: 0 } satisfies Record<EnemyKind, number>,
  /** Seconds between chances to change direction, and the chance it does. */
  every: [0.4, 1.1] as const,
  flip: 0.65,
  jinkTime: 0.35,
  jinkSpeed: 1.5,
  /** Seconds without being hit before the next hit makes it jink. */
  jinkQuiet: 1.2,
};

/**
 * Robots react to being shot. Every hit flinches the model (drawn only). Damage landed
 * within a short window adds up, and once it passes `share` of the robot's full health
 * and shield it staggers: it reels back for `time` s, and a wind-up or burst it was in
 * is lost. Weak-point damage counts `weak` times. A shield breaking staggers it briefly
 * too, unless it is winding up or firing: that attack goes on. After a stagger it shrugs
 * hits off for `steady` s, so steady fire is rewarded with one interrupt per robot rather
 * than a robot that never shoots back.
 */
export const STAGGER = {
  /** Seconds over which damage counts toward a stagger (an exponential window). */
  window: 0.7,
  /**
   * The grunt's share is above what steady body fire from the starting weapon builds up in
   * the window (about a third of its total), so a player standing in front of one does not
   * keep it from shooting back; weak-point fire, or the teammate's fire on top, still staggers it.
   */
  share: { drone: 0.35, grunt: 0.45, charger: 0.3, heavy: 0.22, titan: 99 } satisfies Record<EnemyKind, number>,
  weak: 1.6,
  time: { drone: 0.45, grunt: 0.6, charger: 0.7, heavy: 0.5, titan: 0 } satisfies Record<EnemyKind, number>,
  shieldBreak: 0.3,
  steady: 1.8,
  /** Speed (m/s) it is knocked back from the shot that staggers it. */
  knock: 2.5,
};

/** A grunt left alone below this share of its health and shield falls back to cover and hides longer. */
export const FALLBACK = { below: 0.4, hide: [2.2, 3.2] as const };

/** How far a sound carries, in metres. Robots inside it come to look. */
export const NOISE = {
  pike: 16,
  hornet: 13,
  maul: 15,
  lance: 22,
  talon: 30,
  arc: 10,
  sprintStep: 8,
  slide: 10,
  /** Using a healing item: the click of a cell or the hiss of a syringe. */
  heal: 9,
  /** The ult's launch: everyone round about hears where the player went up. */
  leap: 30,
  /** Squads that roam the roads (and reinforcements) hear gunfire this many times further and come to look. */
  roamMult: 2.5,
  /** Within this fraction of a sound's radius, a robot that can see the spot engages at once. */
  engageInside: 0.35,
};

/**
 * The robots' two factions. The network (網) is the island's own; rogues (野良機) are robots that
 * broke off it: they hold some outposts (`TERRITORY` in map.ts) and walk patrols of their own
 * (`MOBILES`), and the salvage crews are theirs. Each is hostile to the other and to the player
 * and the teammate.
 *
 * A squad out between the POIs that is not fighting the player looks for the other faction's
 * robots every `scan` seconds, out to `sight` of its members' sight range: a member that sees one
 * (in its view cone, or within `close` metres whatever way it faces) sets the squad on it, and the
 * squad fights it with the shots it fires at the player until it is down or has gone `forget`
 * seconds unseen. A robot hit by the other faction turns on whoever shot it. The garrisons of the
 * POIs hold their posts and take no part, so a POI is only ever cleared by the player. Firing at
 * the other faction lands `dmg` of its damage, so a fight between squads goes on for a while, long
 * enough to be heard and come to, and leaves its winner worn. Firing at
 * the other faction carries `noise` metres (`NOISE.roamMult` further to squads out on the roads,
 * which come to look) and is heard by the player out to `hear` metres, where it marks the map
 * (`State.contacts`) for `keep` seconds.
 */
export const FACTION = { scan: 0.25, sight: 1, close: 12, forget: 8, noise: 40, hear: 380, keep: 60, every: 1.5, dmg: 0.8, apart: 90 };

/**
 * Rogue patrols (`MOBILES` with `rank`) walk while their rank is below `patrols[level]` for the
 * network's level: a weaker network loses more robots to them. A rogue-held outpost's own patrol
 * walks while the outpost is theirs (`TERRITORY`).
 */
export const ROGUE = { patrols: [3, 3, 2, 1, 1, 0] as const };

/**
 * Squads that go out from their posts (`MOBILES`): each walks its nodes out and back by the
 * ground's way (`walkLine()` in hunt.ts), at the patrol pace (`AWARE.idleSpeed`). A raid starts
 * each at a point of its walk at least `away` metres from the player, picked from the seed. A
 * patrol whose leader has gone `stuck.time` seconds without moving `stuck.moved` metres makes for
 * its next point. On the move a squad watches the way ahead more than its flanks: until it fights,
 * it notices the player at `sight` of its kind's range, so a player who sees it first has the shot;
 * a squad sent after the player (see SWEEP) looks out at its kind's full range.
 * It walks at `pace` of the patrol pace, a brisk walk that crosses the player's way more often.
 */
export const PATROL = { away: 150, stuck: { time: 10, moved: 2.5 }, sight: 0.6, pace: 1.35 };

/**
 * A squad with no member within `dist` metres of the player or the teammate thinks less often:
 * its calm robots (holding a post, walking a patrol, going to look) take one step of `every`
 * ticks' worth of time on their squad's turn, so they walk as fast as when they step each tick.
 * `dist` is beyond every robot's sight (`SIGHT`, `PACK.sight`), and a squad near either is judged
 * whole each tick, so whatever can see or reach the player steps every tick. A robot fighting
 * the player or the other faction always does.
 */
export const FAR_THINK = { dist: 120, every: 4 };

/**
 * A squad out between the POIs, a hunting party or a reinforcement squad that hears the player
 * (or is told where they are) makes for where they are heading rather than for the sound: along
 * the player's motion when they move faster than `minSpeed`, else toward the nearest way off of
 * their region once their bag is half full or the raiders are due; a player standing for any other
 * reason (fighting or looting at a POI) is where they are. It looks ahead the time it takes to walk there, between `lead[0]` and
 * `lead[1]` seconds, at the player's pace or `pace`, no more than `max` metres.
 */
export const INTERCEPT = { minSpeed: 1.2, lead: [4, 16] as const, pace: 3.5, max: 45 };

/**
 * A fighting squad of `min` or more out between the POIs (not a POI's garrison, which keeps to
 * the ground round its posts and pinches as `PINCH` says) splits at once (`after` seconds into the fight): the first
 * member, and the second of four or more, hold the front and shoot from cover; the others go round
 * to the player's side and back, `dist` metres out, `back` of that past the player from the front.
 */
export const SPLIT = { min: 3, after: 2, dist: 12, back: 0.6 };

/**
 * When the player comes within `near` metres of a way off of their region with their bag at least
 * `bag` full, up to `squads` calm squads out between the POIs (`MOBILES`) leave their walk for the choke points within `reach`
 * of it (gates in the fences, gaps in the ring's wreckage, the approaches to the way off) and wait
 * there facing the player's side, for `hold` seconds or until the player is twice `near` off.
 */
export const AMBUSH = { near: 150, reach: 230, squads: 1, hold: 120, every: 2, bag: 0.3 };

/**
 * The network keeps the player found: once no robot has fought them for `quiet` seconds, it sends
 * the nearest calm squad of its own out between the POIs (on a walk, or a hunting party) within
 * `reach` metres after them at `pace` of its fighting speed, told every `every` seconds where they
 * are heading (see INTERCEPT), for `time` seconds or until it fights them. One is sent at a time.
 * The walk in counts `start` seconds more before the first, so the first is sent no sooner than
 * `start` + `quiet` seconds into a raid with no fight.
 */
export const SWEEP = { start: 60, quiet: 15, reach: 220, pace: 1.2, every: 6, time: 60 };

/**
 * A grunt behind its cover squats: its body and its head drop by these many metres, `rate` of
 * the way a second, so its head (2 m standing, its lens 0.27 m round) sinks under the top of
 * cover `COVER.tall` high. It stands to step out and shoot. Its sight drops with its head:
 * squatting, it cannot see over its cover either.
 */
export const DUCK = { body: 0.8, head: 0.8, rate: 5 };

export const COVER = {
  /** Height of the cover a robot hides behind: a squatting grunt's head is under it (DUCK). */
  tall: 1.5,
  /** Gap between a cover point and the box face. */
  offset: 0.9,
  spacing: 1.6,
  /** How far sideways a robot steps out of cover to shoot. */
  peek: 1.4,
  search: 14,
  /** Metres between a cover spot's surface and a robot's feet for it to take that cover: its own level only. */
  level: 1.2,
  minFromPlayer: 6,
  maxFromPlayer: 34,
  /**
   * A grunt walking to its cover or peek spot that gets closer by less than `progress` of its
   * speed for `time` seconds counts the spot as reached: its body is caught on a corner. The
   * time is well past the few ticks it takes to speed up from standing, so a normal step out
   * of cover is never cut short.
   */
  stuck: { progress: 0.2, time: 0.4 },
  /** Seconds a robot stays behind cover between shots. */
  hide: [1.4, 2.4] as const,
};

/**
 * The teammate. It walks the player's footsteps a few metres behind, shoots only
 * robots that are already fighting (so it never gives a sneaking player away), and
 * draws some of the fire. It picks the player up once the self-revive is spent;
 * the player picks it up by standing over it and pressing the use key.
 */
export const ALLY = {
  name: "リオ",
  hp: 100,
  shield: 75,
  radius: 0.4,
  walk: 4.6,
  run: 7.0,
  /** It keeps about this far behind the player, measured along the footsteps. */
  follow: 5,
  /** Further than this, or stuck for `stuckTime` s, it moves up to a point just behind the player. */
  catchUp: 38,
  stuckTime: 2.5,
  range: 48,
  dmg: 11,
  interval: 0.11,
  burst: 6,
  pause: [0.6, 1.1] as const,
  /** Chance a shot lands: `hitNear` up close, falling to `hitFar` at `range`. */
  hitNear: 0.8,
  hitFar: 0.3,
  crit: 0.15,
  critMult: 1.5,
  /** Radians per second it turns toward a target. */
  turn: 6,
  /** Share of the ult charge its damage gives the player. */
  ultShare: 0.5,
  regenDelay: 4,
  shieldRegen: 15,
  hpRegen: 8,
  /** Seconds for it to pick the player up, and for the player to pick it up. */
  reviveTime: 4,
  helpTime: 3,
  reviveHp: 60,
  /** A downed teammate stands up on its own after this long, or when the objective is cleared. */
  selfUp: 30,
  /** How long a player out of self-revives waits for the teammate before the wipe. */
  bleedout: 30,
  /** Metres a robot adds to the teammate's distance when choosing whom to shoot: the player is the main target. */
  aggroBias: 1,
  noise: 16,
  /** The rarity its gun counts as against plates (see PLATE): it pierces tier 1 only. */
  rarity: 1 as Rarity,
};

/**
 * Robots that beam in around a called pickup while it is on its way: a wave every `every`
 * seconds, at most `maxAlive` of them up at once. Waiting at a pickup is a fight from cover
 * against a few robots at a time, not a hold against a crowd: with fire that finds anyone
 * in the open, a crowd would decide the raid at its very end.
 */
export const SHIP_WAVES = {
  every: 7,
  first: 3,
  radius: 18,
  maxAlive: 3,
  waves: [["grunt"], ["drone", "grunt"], ["charger"], ["drone"]] as EnemyKind[][],
};

/** Seconds the arc shows every robot within range through walls. */
export const REVEAL = { time: 5, range: 40 };
