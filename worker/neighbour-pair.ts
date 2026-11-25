/*
 * Weekly mutual neighbour pairing (docs/ringfall/design-direction.md 「本物のお隣との取り合い」／TKT-201).
 * If A lists B this week, B lists A (same slot when free). Pure: the Worker draw and its tests share it.
 */

/** One island that could be offered as a neighbour. */
export interface PairCandidate {
  code: string;
  playerId: string;
  trophies: number;
}

/** A kept pick: sea slot → neighbour island code. */
export interface PairPick {
  slot: number;
  code: string;
}

/** What to write after a draw: the owner's picks and reciprocal rows for each neighbour. */
export interface MutualDraw {
  self: PairPick[];
  /** Rows to INSERT OR IGNORE for the other player (their player_id, slot, this owner's island code). */
  reciprocal: { playerId: string; slot: number; code: string }[];
}

const mix32 = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

/**
 * Sort key: trophy distance first, then a stable week hash so near islands shuffle a little.
 */
export function neighbourSortKey(selfCode: string, selfTrop: number, other: PairCandidate, week: number): number {
  return Math.abs(other.trophies - selfTrop) / 50 + ((mix32(`${selfCode}:${other.code}:${week}`) % 1000) / 1000) * 2;
}

/**
 * First free sea slot in `0..count-1` not used by `used`, preferring `prefer` when free.
 */
export function freeSlot(used: ReadonlySet<number>, count: number, prefer?: number): number | null {
  if (prefer !== undefined && prefer >= 0 && prefer < count && !used.has(prefer)) return prefer;
  for (let s = 0; s < count; s++) if (!used.has(s)) return s;
  return null;
}

/**
 * Plan a mutual weekly draw for `self` from `pool`.
 *
 * - Prefers candidates who already list `selfCode` this week (already mutual).
 * - Skips candidates whose week is full and does not yet list self.
 * - For each new pick, reserves the same slot on the neighbour when free; otherwise their first free slot.
 * - `existingByPlayer` maps neighbour player_id → their picks already kept this week.
 */
export function planMutualPicks(
  self: { code: string; trophies: number },
  pool: readonly PairCandidate[],
  week: number,
  existingByPlayer: ReadonlyMap<string, readonly PairPick[]>,
  count: number,
): MutualDraw {
  const ranked = [...pool].sort((a, b) => neighbourSortKey(self.code, self.trophies, a, week) - neighbourSortKey(self.code, self.trophies, b, week));
  const selfPicks: PairPick[] = [];
  const reciprocal: MutualDraw["reciprocal"] = [];
  const takenCodes = new Set<string>();

  // Pass 1: candidates who already list us — keep their slot if possible.
  for (const c of ranked) {
    if (selfPicks.length >= count) break;
    if (takenCodes.has(c.code)) continue;
    const theirs = existingByPlayer.get(c.playerId) ?? [];
    const haveUs = theirs.find((p) => p.code === self.code);
    if (!haveUs) continue;
    const slot = freeSlot(new Set(selfPicks.map((p) => p.slot)), count, haveUs.slot);
    if (slot === null) continue;
    selfPicks.push({ slot, code: c.code });
    takenCodes.add(c.code);
  }

  // Pass 2: fill remaining with candidates who still have room for a reciprocal.
  for (const c of ranked) {
    if (selfPicks.length >= count) break;
    if (takenCodes.has(c.code)) continue;
    const theirs = [...(existingByPlayer.get(c.playerId) ?? [])];
    if (theirs.some((p) => p.code === self.code)) continue; // already handled
    if (theirs.length >= count) continue; // no room to list us back
    const slot = freeSlot(new Set(selfPicks.map((p) => p.slot)), count);
    if (slot === null) break;
    const theirSlot = freeSlot(new Set(theirs.map((p) => p.slot)), count, slot);
    if (theirSlot === null) continue;
    selfPicks.push({ slot, code: c.code });
    takenCodes.add(c.code);
    reciprocal.push({ playerId: c.playerId, slot: theirSlot, code: self.code });
  }

  selfPicks.sort((a, b) => a.slot - b.slot);
  return { self: selfPicks, reciprocal };
}

/**
 * Whether every pick of `a` has `aCode` among that neighbour's picks (symmetry check for tests).
 */
export function picksAreMutual(
  aCode: string,
  aPicks: readonly PairPick[],
  byCode: ReadonlyMap<string, readonly PairPick[]>,
): boolean {
  return aPicks.every((p) => (byCode.get(p.code) ?? []).some((q) => q.code === aCode));
}
