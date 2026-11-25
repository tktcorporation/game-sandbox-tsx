/*
 * Anti-snowball for own-island outer hubs (作り順③ / design-direction.md):
 * after one outer hub is taken, the rest are island-shielded until end of that UTC day;
 * at most `lossCap` outer hubs may be lost per UTC day.
 *
 * Extends the existing same-day 盾 (`IslandState.shielded`), not a parallel system.
 * Pure helpers — worker/island.ts and the client Profile share these numbers.
 */

/** One UTC day in ms (same as worker/island.ts). */
export const DAY_MS = 86_400_000;

/**
 * Tunable anti-snowball numbers (作り順③).
 *
 * Judgment: lossCap 1 + island shield for the rest of the UTC day ≈ CoC
 * 「取られたら盾が張り、その日はもう取られない」. Duration is end of UTC day
 * (concrete; matches the existing per-hub same-day shield's day boundary).
 */
export const OUTER_GUARD = {
  /** Max outer contested hubs lost to others in one UTC day. */
  lossCap: 1,
  /**
   * After a loss, remaining own outer hubs are shielded until the end of that UTC day.
   * Concrete remaining time = ms until next UTC midnight (`utcDayEnd`).
   */
  untilUtcDayEnd: true as const,
} as const;

/** Profile / island copy of the day's outer-hub guard (v45). */
export type OuterGuard = {
  /** `utcDay(now)` when this record applies. */
  utcDay: number;
  /** Outer hubs lost this UTC day. */
  lost: number;
  /** Island-wide shield: remaining own outer hubs cannot be taken. */
  island: boolean;
};

export const utcDay = (t: number) => Math.floor(t / DAY_MS);

/** Exclusive end of the UTC day that contains `t` (next UTC midnight). */
export const utcDayEnd = (t: number) => (utcDay(t) + 1) * DAY_MS;

export const emptyOuterGuard = (): OuterGuard => ({ utcDay: 0, lost: 0, island: false });

/** Guard for `now`'s UTC day (resets when the day rolls). */
export function guardOn(g: OuterGuard | null | undefined, now: number): OuterGuard {
  const day = utcDay(now);
  if (!g || g.utcDay !== day) return { utcDay: day, lost: 0, island: false };
  return g;
}

/** Whether the island's remaining outer hubs are shielded at `now`. */
export const isIslandProtected = (g: OuterGuard | null | undefined, now: number): boolean => guardOn(g, now).island;

/** Whether another outer hub may still be lost at `now` (cap + island shield). */
export function canLoseOuter(g: OuterGuard | null | undefined, now: number): boolean {
  const cur = guardOn(g, now);
  if (cur.island) return false;
  return cur.lost < OUTER_GUARD.lossCap;
}

/** After an outer hub is taken from the owner: bump lost, raise island shield. */
export function recordOuterLoss(g: OuterGuard | null | undefined, now: number): OuterGuard {
  const cur = guardOn(g, now);
  return { utcDay: cur.utcDay, lost: cur.lost + 1, island: true };
}

/**
 * Merge local and server guards for the current UTC day (作り順③).
 * AI takes are browser-only (`reportHolds` sends them as foe), so the server never
 * records them — keep the stronger of local and server (max lost, OR island).
 */
export function mergeOuterGuard(
  local: OuterGuard | null | undefined,
  server: OuterGuard | null | undefined,
  now: number,
): OuterGuard {
  const a = guardOn(local, now);
  const b = guardOn(server, now);
  return {
    utcDay: utcDay(now),
    lost: Math.max(a.lost, b.lost),
    island: a.island || b.island,
  };
}

/** Ms left on the island shield, or 0 when none. */
export function shieldRemainingMs(g: OuterGuard | null | undefined, now: number): number {
  if (!isIslandProtected(g, now)) return 0;
  return Math.max(0, utcDayEnd(now) - now);
}

/** Saved outer-guard blob, or empty when missing / unreadable (v44 and older). */
export function parseOuterGuard(raw: unknown): OuterGuard {
  if (!raw || typeof raw !== "object") return emptyOuterGuard();
  const o = raw as Record<string, unknown>;
  const utc = typeof o.utcDay === "number" && Number.isFinite(o.utcDay) ? Math.max(0, Math.floor(o.utcDay)) : 0;
  const lost = typeof o.lost === "number" && Number.isFinite(o.lost) ? Math.max(0, Math.floor(o.lost)) : 0;
  return { utcDay: utc, lost, island: o.island === true };
}
