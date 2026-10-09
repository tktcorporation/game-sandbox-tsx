/**
 * Seeded RNG whose whole state is one integer, so game states that carry it
 * stay plain data: they can be cloned for undo/preview and replayed by sims.
 */
export interface Seeded {
  rng: number;
}

export function rand(s: Seeded): number {
  let a = (s.rng + 0x6d2b79f5) | 0;
  s.rng = a;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function randInt(s: Seeded, n: number): number {
  return Math.floor(rand(s) * n);
}

export function pick<T>(s: Seeded, xs: readonly T[]): T {
  return xs[randInt(s, xs.length)];
}

export function shuffle<T>(s: Seeded, xs: T[]): T[] {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = randInt(s, i + 1);
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
  return xs;
}

/** Same seed for everyone on the same UTC day. */
export function dailySeed(date = new Date()): number {
  const d = date.getUTCFullYear() * 10000 + (date.getUTCMonth() + 1) * 100 + date.getUTCDate();
  return Math.imul(d, 2654435761) >>> 0;
}
