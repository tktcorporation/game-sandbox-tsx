/**
 * Every tuning number of RINGFALL. Units are metres, seconds and degrees unless noted.
 * Change a number here only together with a re-run of `npm run sim:ringfall` and an
 * update to docs/ringfall/balance.md.
 */

export const TICK = 1 / 60;
export const DEG = Math.PI / 180;

export const WORLD = {
  half: 96, // playable square is [-half, half] on x and z
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
  shardShield: 12,
  shardMagnet: 7,
  pickupRange: 2.6,
  interactRange: 2.4,
};

export const DROP = {
  startY: 110,
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
  drone: { hp: 55, shield: 0, shieldTier: 0, radius: 0.55, bodyY: 0, weakY: 0, weakR: 0.24, weakFwd: 0.42, speed: 4.2, fly: 3.4, range: 14, telegraph: 0.55, cooldown: 1.6, shots: 1, shotGap: 0, spread: 0, orbSpeed: 19, orbDmg: 11, orbR: 0.32, ult: 1 },
  grunt: { hp: 100, shield: 50, shieldTier: 1, radius: 0.6, bodyY: 1.1, weakY: 1.86, weakR: 0.27, weakFwd: 0.08, speed: 3.2, fly: 0, range: 15, telegraph: 0.6, cooldown: 1.8, shots: 3, shotGap: 0.16, spread: 0, orbSpeed: 23, orbDmg: 9, orbR: 0.3, ult: 1 },
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
  shrinkTime: 30,
};

export const RANK = {
  parSeconds: 240, // total run time that earns full time score
  steps: ["S", "A", "B", "C"] as const,
};
