/** Every tuning number lives here, so feel and balance changes are one-file diffs. Units: px and seconds. */
export const TICK = 1 / 60;

export const WORLD = { w: 960, h: 540, wall: 24 } as const;

export const PLAYER = {
  radius: 17,
  speed: 330,
  /** Seconds to reach full speed or to stop. Short = snappy. */
  accel: 0.08,
  hp: 3,
  hurtInvuln: 1.0,
  knockback: 260,
} as const;

export const DASH = { speed: 920, time: 0.13, cooldown: 0.55, invulnTail: 0.06 } as const;

export const GUN = {
  rate: 11,
  mag: 30,
  reload: 0.85,
  bulletSpeed: 1500,
  bulletRadius: 5,
  damage: 1,
  spreadDeg: 1.6,
  /** Shots aimed within this angle of an enemy snap most of the way onto it. */
  assistDeg: 9,
  assistPull: 0.7,
  /** In flight, bullets bend toward an enemy this close, at most this many degrees per tick. */
  homingRange: 110,
  homingDegPerTick: 2.5,
  /** A shot whose raw aim passes this close to an enemy centre (fraction of its radius) crits on that enemy. */
  critCore: 0.55,
  critMultiplier: 2,
} as const;

export type EnemyKind = "drone" | "rusher" | "gunner";

export const ENEMY: Record<EnemyKind, {
  radius: number;
  hp: number;
  speed: number;
  /** Seconds the enemy glows before it acts, so every attack is readable. */
  telegraph: number;
  cooldown: number;
}> = {
  drone: { radius: 20, hp: 4, speed: 130, telegraph: 0.4, cooldown: 1.15 },
  rusher: { radius: 22, hp: 6, speed: 110, telegraph: 0.55, cooldown: 1.0 },
  gunner: { radius: 29, hp: 14, speed: 70, telegraph: 0.6, cooldown: 1.7 },
};

export const ENEMY_BULLET = { speed: 300, radius: 11 } as const;
export const RUSH = { speed: 640, time: 0.6, recover: 0.7 } as const;

export const ROOM = {
  spawnTelegraph: 0.7,
  /** Seconds of the clear celebration before the next room starts. */
  clearBeat: 1.6,
  /** Kills within this window extend the streak. */
  streakWindow: 1.8,
} as const;
