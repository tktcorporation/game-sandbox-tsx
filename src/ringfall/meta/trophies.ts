/*
 * Trophy ranking (docs/ringfall/design-direction.md, CoC 型 / TKT-218–219):
 * 「攻める」raid scores ★0–3; win +N×★/3, 0★ −M. Defender loses what the attacker gained;
 * 守りきった → +M. League win-bonus materials +0..+6 ×★/3. Field battle shows stars
 * without moving trophies. Materials from 核 · 制圧 stay separate (`SEIZE`).
 */
import { rivalOf, type PoiHold } from "../sim/holds";
import type { NodeId } from "../sim/map";
import { ISLAND_TABLE } from "./island-table";
import { isContestedShore } from "./neighbours";

/**
 * Numbers for the ranking layer (CoC-shaped — design-direction 「トロフィーは CoC 型」).
 * N = base + gapBonus (±maxBonus); M = base − gapBonus (min failMin).
 */
export const TROPHY = {
  /** New / migrated profiles. */
  start: 1000,
  /** Base for N / M at even trophies. */
  base: 30,
  /** Extra (or less) from the gap, capped. */
  maxBonus: 20,
  /** Gap (defender − attacker) at which the bonus saturates. */
  band: 400,
  /** Floor for M (失敗ペナルティ). */
  failMin: 5,
  /**
   * @deprecated Prefer `raidOdds` / `defenceWin` (TKT-218). Kept as alias of failMin-era flat
   * only for older comments; defence awards now use the attacker's M.
   */
  defend: 10,
  min: 0,
  max: 5000,
} as const;

/**
 * League bands from design-direction (CoC-shaped / TKT-219).
 * Inclusive min; the next band's min is exclusive upper for this one.
 */
export const LEAGUE: readonly { name: string; min: number }[] = [
  { name: "見習い", min: 0 },
  { name: "銅", min: 800 },
  { name: "銀", min: 1200 },
  { name: "金", min: 1600 },
  { name: "水晶", min: 2000 },
  { name: "王者", min: 2600 },
  { name: "伝説", min: 3400 },
];

/**
 * Win-bonus materials by league index (見習い…伝説 → 0…6).
 * Awarded as base ×★/3 on a 「攻める」raid (robot hubs / field excluded).
 */
export const WIN_BONUS: readonly number[] = [0, 1, 2, 3, 4, 5, 6];

/** League name for a trophy count (start 1000 → 銅). */
export function leagueOf(trophies: number): { name: string; min: number } {
  const n = Math.max(0, Math.round(trophies));
  let hit = LEAGUE[0]!;
  for (const band of LEAGUE) {
    if (n >= band.min) hit = band;
    else break;
  }
  return hit;
}

/** 0 = 見習い … 6 = 伝説. */
export function leagueIndex(trophies: number): number {
  const name = leagueOf(trophies).name;
  const i = LEAGUE.findIndex((b) => b.name === name);
  return i < 0 ? 0 : i;
}

/** Full ★★★ win-bonus materials for the attacker's current league. */
export function winBonusBase(trophies: number): number {
  return WIN_BONUS[leagueIndex(trophies)] ?? 0;
}

/**
 * League win-bonus materials for a raid star count (TKT-219).
 * base ×★/3 (見習い 0; 伝説 ★★★ → 6). ★0 → 0.
 */
export function winBonusMaterials(trophies: number, stars: number): number {
  const base = winBonusBase(trophies);
  const s = Math.max(0, Math.min(3, Math.round(stars)));
  if (base <= 0 || s <= 0) return 0;
  return Math.max(1, Math.round((base * s) / 3));
}

/** Whether trophies crossed a league band (results). */
export function leagueChanged(before: number, after: number): { from: string; to: string } | null {
  const from = leagueOf(before).name;
  const to = leagueOf(after).name;
  return from === to ? null : { from, to };
}

/**
 * 部隊戦 result stars (clan-war shaped; trophies do not move).
 * From hubs held at settle: 0 → ☆☆☆; all → ★★★; otherwise proportional.
 */
export function fieldStars(ours: number, total: number): 0 | 1 | 2 | 3 {
  const t = Math.max(1, Math.round(total));
  const o = Math.max(0, Math.min(t, Math.round(ours)));
  if (o <= 0) return 0;
  if (o >= t) return 3;
  return Math.min(3, Math.max(1, Math.round((o * 3) / t))) as 1 | 2 | 3;
}

/**
 * Materials from 核 · 制圧 of a rival-held hub (including AI). Separate from trophies.
 */
export const SEIZE = {
  /** Common materials when that hub's 島の守り stock is empty (was 1). */
  emptyReserve: 3,
  /** Extra materials on every rival 制圧, on top of parcels taken. */
  bonus: 2,
} as const;

/** AI / remote expedition star counts (design-direction: 制圧=★★、失敗=0★). */
export const AI_RAID_STARS = { win: 2, lose: 0 } as const;

/** Clamp to the live range. */
export const clampTrophies = (n: number): number => Math.max(TROPHY.min, Math.min(TROPHY.max, Math.round(n)));

/**
 * Gap bonus in −maxBonus…+maxBonus from (defender − attacker) over `band`.
 * Higher defender → positive (attacker gains more / risks more).
 */
export function gapBonus(attacker: number, defender: number): number {
  const diff = defender - attacker;
  return Math.round((Math.max(-TROPHY.band, Math.min(TROPHY.band, diff)) / TROPHY.band) * TROPHY.maxBonus);
}

/**
 * Pre-raid odds (出撃前の +N / −M).
 * N = 30 + 差補正(±20); M = 30 − 差補正(最低 5).
 */
export function raidOdds(attacker: number, defender: number): { N: number; M: number } {
  const bonus = gapBonus(attacker, defender);
  const N = Math.max(1, TROPHY.base + bonus);
  const M = Math.max(TROPHY.failMin, TROPHY.base - bonus);
  return { N, M };
}

/**
 * How many trophies move on a full take (legacy / overnight ★★ default).
 * `gain` = N; `loss` (what the loser drops) = same N for a full ★★★; `fail` = M.
 */
export function trophySwap(attacker: number, defender: number): { gain: number; loss: number; fail: number } {
  const { N, M } = raidOdds(attacker, defender);
  return { gain: N, loss: N, fail: M };
}

/** ★1–3 → floor of N×★/3 (at least 1). ★0 → 0. */
export function starGain(N: number, stars: number): number {
  const s = Math.max(0, Math.min(3, Math.round(stars)));
  if (s <= 0) return 0;
  return Math.max(1, Math.round((N * s) / 3));
}

/**
 * Net trophy change for one 「攻める」raid outcome.
 * ★1–3 → +N×★/3; ★0 → −M.
 */
export function raidTrophyDelta(N: number, M: number, stars: number): number {
  const s = Math.max(0, Math.min(3, Math.round(stars)));
  if (s <= 0) return -Math.max(TROPHY.failMin, Math.round(M));
  return starGain(N, s);
}

/**
 * Star count from raid facts (TKT-218).
 * ★1 守備の半分 / ★2 核 · 制圧 / ★3 制圧して生還.
 */
export function starsForRaid(o: { halfDefence: boolean; captured: boolean; extracted: boolean }): 0 | 1 | 2 | 3 {
  if (o.captured && o.extracted) return 3;
  if (o.captured) return 2;
  if (o.halfDefence) return 1;
  return 0;
}

/**
 * Defender gain when the attack is wiped (守りきった): the attacker's M.
 * `attacker` / `defender` are trophy standings from the defender's view of the foe / self.
 */
export function defenceWin(attackerTrop: number, defenderTrop: number): number {
  return raidOdds(attackerTrop, defenderTrop).M;
}

/**
 * @deprecated Use `defenceWin` (TKT-218). Flat `TROPHY.defend` × wipes kept for one release of
 * scripts that still call it; prefer M per wipe.
 */
export function defendGain(wipes: number): number {
  return Math.max(0, Math.round(wipes)) * TROPHY.defend;
}

/**
 * A rival's trophies from a known table (お隣 / AI). Unknown → treat as even with `self`.
 */
export function rivalTrophies(owner: string, self: number, table?: ReadonlyMap<string, number>): number {
  if (!table?.size) return self;
  const direct = table.get(owner);
  if (direct !== undefined) return direct;
  if (owner.startsWith("ai-")) {
    const bare = table.get(owner.slice(3));
    if (bare !== undefined) return bare;
  }
  return self;
}

/** Build a code → trophies map from the neighbours list (server + AI). */
export function trophiesTable(
  neighbours: readonly { code: string; trophies?: number; ai?: true }[],
): Map<string, number> {
  const map = new Map<string, number>();
  for (const n of neighbours) {
    if (n.trophies === undefined) continue;
    map.set(n.code, n.trophies);
    if (n.ai) map.set(`ai-${n.code}`, n.trophies);
  }
  return map;
}

/** Lookup bound to `self` and an optional neighbours table. */
export const rivalTrophiesLookup =
  (self: number, table?: ReadonlyMap<string, number>) =>
  (owner: string): number =>
    rivalTrophies(owner, self, table);

/**
 * Overnight / sync ownership changes of 取り合う拠点 (no star meter on this island).
 * Takes: award ★★ worth (AI_RAID_STARS.win) of N — remote / AI default.
 * Losses: drop the same amount the attacker would have gained at ★★.
 * Raid-local star scoring is `raidTrophyDelta` in settle, not here.
 */
export function trophyDelta(
  self: number,
  before: readonly PoiHold[],
  after: readonly PoiHold[],
  rivalTrophiesOf: (owner: string) => number = (o) => rivalTrophies(o, self),
  /** Hubs already scored by raid star math (`raidTrophyDelta`) — skip here. */
  skip: ReadonlySet<NodeId> = new Set(),
): { next: number; gained: number; lost: number; taken: NodeId[]; dropped: NodeId[] } {
  let gained = 0;
  let lost = 0;
  const taken: NodeId[] = [];
  const dropped: NodeId[] = [];
  const remoteStars = AI_RAID_STARS.win;
  for (let i = 0; i < ISLAND_TABLE.nodes.length; i++) {
    const id = ISLAND_TABLE.nodes[i].id as NodeId;
    if (!isContestedShore(id) || skip.has(id)) continue;
    const was = before[i] ?? "foe";
    const now = after[i] ?? "foe";
    const wasRival = rivalOf(was);
    const nowRival = rivalOf(now);
    // Took a contested rival hub (sync / overnight / remote ★★).
    if (wasRival !== null && now === "own") {
      const { N } = raidOdds(self + gained - lost, rivalTrophiesOf(wasRival));
      gained += starGain(N, remoteStars);
      taken.push(id);
    }
    // Lost a contested hub to a rival (their ★★ take).
    if (was === "own" && nowRival !== null) {
      const foe = rivalTrophiesOf(nowRival);
      const { N } = raidOdds(foe, self + gained - lost);
      lost += starGain(N, remoteStars);
      dropped.push(id);
    }
  }
  return { next: clampTrophies(self + gained - lost), gained, lost, taken, dropped };
}
