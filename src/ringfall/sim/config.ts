/**
 * Every tuning number of RINGFALL. Units are metres, seconds and degrees unless noted.
 * Change a number here only together with a re-run of `npm run sim:ringfall` and an
 * update to docs/ringfall/balance.md.
 */

export const TICK = 1 / 60;
export const DEG = Math.PI / 180;

export const WORLD = {
  /** The world's bounds on each axis. The coast's cliffs (terrain.ts) stop bodies well inside them. */
  x0: -215,
  x1: 215,
  z0: -215,
  z1: 215,
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
 * slow and unable to shoot for longer, so when to heal is a choice. `amount` 0 fills.
 */
export const HEALS: Record<HealKind, { label: string; short: string; shield: boolean; amount: number; time: number; max: number }> = {
  cell: { label: "シールドセル", short: "セル", shield: true, amount: 25, time: 1.2, max: 6 },
  battery: { label: "シールドバッテリー", short: "バッテリー", shield: true, amount: 0, time: 2.4, max: 3 },
  syringe: { label: "注射器", short: "注射器", shield: false, amount: 25, time: 1.4, max: 4 },
  medkit: { label: "医療キット", short: "医療キット", shield: false, amount: 0, time: 3.0, max: 2 },
};
export const HEAL_KINDS = Object.keys(HEALS) as HealKind[];

export const DROP = {
  startY: 140,
  fallSpeed: 26,
  steer: 20,
  /** Speed the wind carries a jumper falling over high ground toward walkable ground. */
  drift: 26,
};

export const ASSIST = {
  /** Half-angle of the cone in which a shot that misses the hitbox still hits the enemy. */
  hipCone: 2.1,
  adsCone: 2.9,
  /** Extra metres of tolerance far away, so distant enemies are not impossible. */
  farPadding: 0.3,
  /** Look sensitivity multiplier while the crosshair is near an enemy. */
  slowdown: 0.55,
  slowCone: 9,
  /** Fraction of the angle to the target closed per second while moving and firing or ADS. */
  pull: 1.6,
  /**
   * Touch aiming: pull also works while standing still, and this much faster.
   * A thumb cannot track and strafe at once the way a mouse hand and WASD can.
   */
  touchPull: 1.6,
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
  adsFov: number;
  /** Aiming looks through a scope: the view zooms to adsFov behind a round sight, with no gun in view. */
  scope?: true;
}

export const WEAPONS: Record<WeaponKind, WeaponSpec> = {
  pike: { name: "PIKE", label: "アサルトライフル", dmg: 14, pellets: 1, interval: 0.1, auto: true, mag: 24, reload: 1.6, hipSpread: 1.3, adsSpread: 0.3, falloffStart: 40, falloffEnd: 70, falloffMin: 0.7, crit: 1.75, recoil: 0.32, adsFov: 52 },
  hornet: { name: "HORNET", label: "サブマシンガン", dmg: 10, pellets: 1, interval: 0.066, auto: true, mag: 26, reload: 1.3, hipSpread: 2.0, adsSpread: 0.9, falloffStart: 18, falloffEnd: 40, falloffMin: 0.55, crit: 1.6, recoil: 0.22, adsFov: 60 },
  maul: { name: "MAUL", label: "ショットガン", dmg: 11, pellets: 8, interval: 0.8, auto: false, mag: 6, reload: 2.2, hipSpread: 5.0, adsSpread: 3.6, falloffStart: 9, falloffEnd: 22, falloffMin: 0.3, crit: 1.5, recoil: 2.2, adsFov: 62 },
  // A bolt-action sniper: one hit drops most robots that have not noticed the player.
  talon: { name: "TALON", label: "スナイパー", dmg: 90, pellets: 1, interval: 1.2, auto: false, mag: 5, reload: 2.6, hipSpread: 4.5, adsSpread: 0, falloffStart: 999, falloffEnd: 1000, falloffMin: 1, crit: 2.0, recoil: 3.2, adsFov: 18, scope: true },
  lance: { name: "LANCE", label: "マークスマン", dmg: 48, pellets: 1, interval: 0.36, auto: false, mag: 10, reload: 2.0, hipSpread: 1.6, adsSpread: 0, falloffStart: 999, falloffEnd: 1000, falloffMin: 1, crit: 2.0, recoil: 1.6, adsFov: 38 },
};

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
 * and comes down only on low ground (like the drop). The launch is loud, and in the air
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
  drone: { hp: 70, shield: 0, shieldTier: 0, radius: 0.55, bodyY: 0, weakY: 0, weakR: 0.24, weakFwd: 0.42, speed: 4.2, fly: 3.4, range: 14, telegraph: 0.55, cooldown: 1.6, shots: 1, shotGap: 0, spread: 0, orbSpeed: 23, orbDmg: 21, orbR: 0.32, ult: 1 },
  grunt: { hp: 140, shield: 70, shieldTier: 1, radius: 0.6, bodyY: 1.1, weakY: 1.86, weakR: 0.27, weakFwd: 0.08, speed: 3.2, fly: 0, range: 15, telegraph: 0.6, cooldown: 1.5, shots: 3, shotGap: 0.16, spread: 0, orbSpeed: 28, orbDmg: 20, orbR: 0.3, ult: 1 },
  charger: { hp: 120, shield: 50, shieldTier: 0, radius: 0.72, bodyY: 0.75, weakY: 0.95, weakR: 0.3, weakFwd: 0.62, speed: 6.4, fly: 0, range: 0, telegraph: 0.6, cooldown: 1.2, shots: 0, shotGap: 0, spread: 0, orbSpeed: 0, orbDmg: 40, orbR: 0, ult: 1 },
  heavy: { hp: 300, shield: 150, shieldTier: 2, radius: 0.95, bodyY: 1.4, weakY: 2.35, weakR: 0.36, weakFwd: 0.1, speed: 2.0, fly: 0, range: 18, telegraph: 0.85, cooldown: 3.2, shots: 5, shotGap: 0, spread: 9, orbSpeed: 20, orbDmg: 18, orbR: 0.42, ult: 1 },
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

/**
 * What a raid scores when the player gets off the island: the value carried out,
 * plus a bonus for each POI cleared and for the titan. A raid that ends in a wipe
 * scores nothing.
 */
export const SCORE = {
  poi: 400,
  titan: 1500,
  /** Lowest score for each rank, best first. */
  ranks: [
    ["S", 4500],
    ["A", 3000],
    ["B", 1500],
    ["C", 0],
  ] as const,
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

/** The bag the valuables go in: what does not fit stays on the ground unless something cheaper makes way. */
export const BAG = { slots: 10 };

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
  valuables: [["reactor"], ["core", "drive"], ["gyro", "drive", "drive"]] as ValuableKind[][],
  heals: 2,
};

/**
 * Reinforcements: a squad beams in somewhere `dist` metres from the player, out of
 * sight, every `every` seconds after the first `first`, and comes looking for them.
 * Later waves are bigger. The longer a raid lasts, the more is hunting the player.
 */
export const REINFORCE = {
  first: 180,
  every: 120,
  /** Seconds between fresh guesses of where the player is while a reinforcement squad hunts. */
  huntEvery: 8,
  dist: [55, 110] as const,
  waves: [
    ["grunt", "drone"],
    ["grunt", "drone", "charger"],
    ["grunt", "grunt", "drone", "charger"],
    ["heavy", "grunt", "drone", "drone"],
  ] as EnemyKind[][],
};

/**
 * The raiders: one elite squad that beams in once the raid has gone on a while and hunts
 * the player down, closer on their heels than reinforcements. In a fight one member holds
 * the player's attention while the others go wide to the sides.
 */
export const RAIDERS = {
  at: 240,
  name: "レイダー",
  kinds: ["grunt", "grunt", "grunt"] as EnemyKind[],
  huntEvery: 4,
};

/** How much tougher, deadlier and quicker an elite robot (a raider) is than a plain one. */
export const ELITE = {
  hp: 1.6,
  dmg: 1.3,
  cooldown: 0.75,
  turn: 1.5,
  /** Degrees either side of facing it can fire into (`AWARE.fireCone` for plain robots). */
  fireCone: 70,
  /** How far to the side of the player a flanking raider goes. */
  flankDist: 11,
};

/**
 * How robots notice the player. Each robot has a view cone; while it sees the
 * player its detection fills (faster up close), and at full the whole squad
 * engages. Crouching shrinks the range and slows the fill.
 */
export const SIGHT: Record<EnemyKind, { range: number; fov: number }> = {
  drone: { range: 26, fov: 150 },
  grunt: { range: 30, fov: 110 },
  charger: { range: 20, fov: 120 },
  heavy: { range: 28, fov: 100 },
  titan: { range: 34, fov: 160 },
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
  /** An engaged squad that has not seen the player this long goes back to searching. */
  loseTime: 8,
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
 * first hit on a robot that has not noticed the player is an ambush. The titan
 * takes plain damage from every side.
 */
export const FLANK = {
  frontArc: 55, // degrees either side of facing
  backArc: 115, // beyond this many degrees from facing
  mult: { front: 0.85, side: 1, back: 2, ambush: 2.5, none: 1 } satisfies Record<Flank, number>,
};

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
  /** The ult's launch: everyone round about hears where the player went up. */
  leap: 30,
  /** Squads that roam the roads (and reinforcements) hear gunfire this many times further and come to look. */
  roamMult: 2.5,
  /** Within this fraction of a sound's radius, a robot that can see the spot engages at once. */
  engageInside: 0.35,
};

export const COVER = {
  /** Gap between a cover point and the box face. */
  offset: 0.9,
  spacing: 1.6,
  /** How far sideways a robot steps out of cover to shoot. */
  peek: 1.4,
  search: 14,
  minFromPlayer: 6,
  maxFromPlayer: 34,
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
};

/**
 * Robots that beam in around the dropship while it is on its way: a wave every
 * `every` seconds, at most `maxAlive` of them up at once.
 */
export const SHIP_WAVES = {
  every: 4.5,
  first: 2,
  radius: 18,
  maxAlive: 5,
  waves: [["drone", "grunt"], ["drone", "drone"], ["grunt", "charger"], ["drone", "grunt"]] as EnemyKind[][],
};

/** Seconds the arc shows every robot within range through walls. */
export const REVEAL = { time: 5, range: 40 };
