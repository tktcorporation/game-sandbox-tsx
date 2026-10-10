/**
 * Every tuning number of RINGFALL. Units are metres, seconds and degrees unless noted.
 * Change a number here only together with a re-run of `npm run sim:ringfall` and an
 * update to docs/ringfall/balance.md.
 */

export const TICK = 1 / 60;
export const DEG = Math.PI / 180;

export const WORLD = {
  half: 150, // playable square is [-half, half] on x and z
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
  autoSprintAfter: 0.2, // forward input without firing for this long turns into a sprint
  regenDelay: 5,
  regenPerSec: 6,
  shieldByTier: [50, 75, 100, 125],
  batteryTime: 2.0,
  batteryMax: 4,
  downedTime: 3,
  reviveHp: 60,
  reviveIframes: 1.5,
  shardShield: 8,
  shardMagnet: 7,
  pickupRange: 2.6,
  interactRange: 2.4,
};

export const DROP = {
  startY: 140,
  fallSpeed: 26,
  steer: 20,
};

export const ASSIST = {
  /** Half-angle of the cone in which a shot that misses the hitbox still hits the enemy. */
  hipCone: 2.6,
  adsCone: 3.6,
  ultCone: 10,
  /** Extra metres of tolerance far away, so distant enemies are not impossible. */
  farPadding: 0.3,
  /** Look sensitivity multiplier while the crosshair is near an enemy. */
  slowdown: 0.55,
  slowCone: 9,
  /** Fraction of the angle to the target closed per second while moving and firing or ADS. */
  pull: 1.6,
  ultPull: 9,
  /**
   * Touch aiming: pull also works while standing still, and this much faster.
   * A thumb cannot track and strafe at once the way a mouse hand and WASD can.
   */
  touchPull: 1.6,
  pullCone: 12,
  range: 70,
};

export type WeaponKind = "pike" | "hornet" | "maul" | "lance";
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
}

export const WEAPONS: Record<WeaponKind, WeaponSpec> = {
  pike: { name: "PIKE", label: "アサルトライフル", dmg: 14, pellets: 1, interval: 0.1, auto: true, mag: 24, reload: 1.6, hipSpread: 1.3, adsSpread: 0.3, falloffStart: 40, falloffEnd: 70, falloffMin: 0.7, crit: 1.75, recoil: 0.32, adsFov: 52 },
  hornet: { name: "HORNET", label: "サブマシンガン", dmg: 10, pellets: 1, interval: 0.066, auto: true, mag: 26, reload: 1.3, hipSpread: 2.0, adsSpread: 0.9, falloffStart: 18, falloffEnd: 40, falloffMin: 0.55, crit: 1.6, recoil: 0.22, adsFov: 60 },
  maul: { name: "MAUL", label: "ショットガン", dmg: 11, pellets: 8, interval: 0.8, auto: false, mag: 6, reload: 2.2, hipSpread: 5.0, adsSpread: 3.6, falloffStart: 9, falloffEnd: 22, falloffMin: 0.3, crit: 1.5, recoil: 2.2, adsFov: 62 },
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

export const ULT = {
  dmgPerCharge: 1100, // damage dealt for a full charge
  duration: 8,
  fireRate: 1.4,
  speed: 1.15,
  startCharge: 0.35,
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
  drone: { hp: 55, shield: 0, shieldTier: 0, radius: 0.55, bodyY: 0, weakY: 0, weakR: 0.24, weakFwd: 0.42, speed: 4.2, fly: 3.4, range: 14, telegraph: 0.55, cooldown: 1.6, shots: 1, shotGap: 0, spread: 0, orbSpeed: 19, orbDmg: 13, orbR: 0.32, ult: 1 },
  grunt: { hp: 100, shield: 50, shieldTier: 1, radius: 0.6, bodyY: 1.1, weakY: 1.86, weakR: 0.27, weakFwd: 0.08, speed: 3.2, fly: 0, range: 15, telegraph: 0.6, cooldown: 1.8, shots: 3, shotGap: 0.16, spread: 0, orbSpeed: 23, orbDmg: 11, orbR: 0.3, ult: 1 },
  charger: { hp: 90, shield: 40, shieldTier: 0, radius: 0.72, bodyY: 0.75, weakY: 0.95, weakR: 0.3, weakFwd: 0.62, speed: 6.4, fly: 0, range: 0, telegraph: 0.6, cooldown: 1.2, shots: 0, shotGap: 0, spread: 0, orbSpeed: 0, orbDmg: 28, orbR: 0, ult: 1 },
  heavy: { hp: 220, shield: 125, shieldTier: 2, radius: 0.95, bodyY: 1.4, weakY: 2.35, weakR: 0.36, weakFwd: 0.1, speed: 2.0, fly: 0, range: 18, telegraph: 0.85, cooldown: 3.2, shots: 5, shotGap: 0, spread: 9, orbSpeed: 17, orbDmg: 11, orbR: 0.42, ult: 1 },
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

export const RING = {
  dmgPerSec: 4,
  shrinkTime: 45,
};

export const RANK = {
  parSeconds: 240, // total run time that earns full time score
  steps: ["S", "A", "B", "C"] as const,
};

/**
 * How robots notice the player. Each robot has a view cone; while it sees the
 * player its detection fills (faster up close), and at full the whole squad
 * engages. Crouching shrinks the range and slows the fill.
 */
export const SIGHT: Record<EnemyKind, { range: number; fov: number }> = {
  drone: { range: 30, fov: 150 },
  grunt: { range: 36, fov: 110 },
  charger: { range: 22, fov: 120 },
  heavy: { range: 32, fov: 100 },
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
  fireCone: 25,
};

/**
 * Turning speed in radians per second while fighting. A robot cannot snap round,
 * so circling to its side or back while it faces the last known position works.
 */
export const TURN: Record<EnemyKind, number> = {
  drone: 3.0,
  grunt: 2.4,
  charger: 3.2,
  heavy: 1.3,
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
  mult: { front: 0.75, side: 1, back: 2, ambush: 2.5, none: 1 } satisfies Record<Flank, number>,
};

/** How far a sound carries, in metres. Robots inside it come to look. */
export const NOISE = {
  pike: 26,
  hornet: 22,
  maul: 24,
  lance: 34,
  arc: 16,
  sprintStep: 8,
  slide: 10,
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

/** Seconds the arc shows every robot within range through walls. */
export const REVEAL = { time: 5, range: 40 };
