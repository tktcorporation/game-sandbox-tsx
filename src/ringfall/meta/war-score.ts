/*
 * 作り順⑥ / design-direction.md「島は終わりなく育てる」:
 * war power (outer hubs → field thickness), raid targeting, leader bounty,
 * held-time + team-battle scoring. No season reset.
 *
 * Tunables live here so 攻め先 / 懸賞金 / 得点 can change later without reshaping Profile.
 */
import type { Hideout } from "./hideout";
import { pouchSlots } from "./hideout";
import type { Team, TeamMember } from "./team";
import { TROPHY } from "./trophies";

/**
 * War power from outer contested hubs (作り順⑥ #4 / #7).
 * Thickness applies on the 部隊戦 field only — never on home-island sorties.
 */
export const WAR_POWER = {
  /**
   * How many of our outer hubs equal one "step" of overnight field defence.
   * Judgment: with ~10 outer hubs max, 1 hub = 1 power keeps the scale readable;
   * defence compares raw sums (see `autoDefendField`).
   */
  perOuter: 1,
  /**
   * Minimum power gap (ours − foe) that holds the field overnight without a hub loss.
   * Judgment: 0 = equal or better keeps; weaker side loses one hub (⑤'s rule).
   */
  defendGap: 0,
} as const;

/**
 * Who may appear on the 攻める list (作り順⑥ #6 — provisional).
 * Prefer the current 相手チーム; anyone within the trophy band is also eligible.
 */
export const RAID_TARGET = {
  /** Prefer owners whose island code matches a foe-team seat. */
  preferFoeTeam: true as const,
  /**
   * Trophy gap (|self − rival|) at or below this still allows a raid even off the foe team.
   * Judgment: reuse TROPHY.band (400) so matching feels like the ranking band.
   */
  trophyBand: TROPHY.band,
  /**
   * When true, drop owners who are neither on the foe team nor within trophyBand.
   * Judgment: provisional default **false** — sort prefers foe team / near trophies, but
   * every neighbour-held outer hub stays attackable (empty 攻める list would break やり返す).
   * Flip on later to harden matching.
   */
  requireNearOrFoe: false as const,
} as const;

/**
 * Leader bounty (作り順⑥ #9): extra materials when taking an outer hub from the strongest foe.
 */
export const BOUNTY = {
  /** Extra common materials on 核 · 制圧 of the leader's hub (on top of SEIZE). */
  extraMaterials: 3,
  /** Rank leaders by outer-hub count (fallback: trophies when outer unknown). */
  by: "outer" as const,
} as const;

/**
 * Rolling score (作り順⑥ #10): recent outer-hold window + team-battle period settle.
 * No season end; ownership is never mass-reset.
 */
export const WAR_SCORE = {
  /** Profile days of outer-hold history that still count. */
  windowDays: 7,
  /** Points per outer hub held for one profile day inside the window. */
  perOuterDay: 1,
  /** Points added when a 部隊戦 period settles (by result). */
  battle: { win: 30, draw: 10, loss: 0 } as const,
} as const;

/** One day's outer-hub snapshot for the scoring window. */
export type OuterDay = { day: number; outer: number };

/** Profile blob for rolling war score (v48). */
export type WarScore = {
  /** Sum of hold-time points in the window + settled battle points (trimmed each day). */
  total: number;
  /** Recent outer counts by profile day (oldest → newest, trimmed to windowDays). */
  outerByDay: OuterDay[];
  /** Points from the last settled 部隊戦 (0 if none yet). */
  lastBattle: number;
};

export const emptyWarScore = (): WarScore => ({ total: 0, outerByDay: [], lastBattle: 0 });

/** War power of a team = sum of members' outer hubs × perOuter. */
export function warPowerOf(team: Pick<Team, "members"> | null | undefined): number {
  if (!team?.members?.length) return 0;
  return team.members.reduce((n, m) => n + Math.max(0, Math.floor(m.outer)) * WAR_POWER.perOuter, 0);
}

/** Whether our side holds the field overnight (no auto-loss) given both sides' power. */
export function fieldHoldsOvernight(ours: number, foe: number): boolean {
  return ours - foe >= WAR_POWER.defendGap;
}

/**
 * Leader among candidates: most outer hubs, then trophies, then stable id.
 * `outer` / `trophies` may be missing — missing sorts last.
 */
export function pickLeader(
  members: readonly { id: string; outer?: number; trophies?: number }[],
): string | null {
  if (!members.length) return null;
  const ranked = [...members].sort((a, b) => {
    const ao = a.outer ?? -1;
    const bo = b.outer ?? -1;
    if (ao !== bo) return bo - ao;
    const at = a.trophies ?? -1;
    const bt = b.trophies ?? -1;
    if (at !== bt) return bt - at;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return ranked[0]?.id ?? null;
}

/** Foe-team seat ids / island codes for raid-target matching. */
export function foeOwnerKeys(foe: Pick<Team, "members"> | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!foe?.members) return out;
  for (const m of foe.members) {
    if (m.id) out.add(m.id);
    if (m.code) {
      out.add(m.code);
      out.add(`ai-${m.code}`);
    }
  }
  return out;
}

/** Whether this owner is on the current foe team. */
export const isFoeTeamOwner = (owner: string, foeKeys: ReadonlySet<string>): boolean =>
  foeKeys.has(owner) || (owner.startsWith("ai-") && foeKeys.has(owner.slice(3)));

/** Trophy gap small enough to raid under RAID_TARGET.trophyBand. */
export const trophiesNear = (self: number, rival: number, band = RAID_TARGET.trophyBand): boolean =>
  Math.abs(self - rival) <= band;

/**
 * May this owner appear on the 攻める list?
 * Provisional: foe-team seat OR within trophy band (see RAID_TARGET.requireNearOrFoe).
 */
export function canRaidOwner(
  owner: string,
  selfTrop: number,
  rivalTrop: number,
  foeKeys: ReadonlySet<string>,
): boolean {
  if (!RAID_TARGET.requireNearOrFoe) return true;
  if (RAID_TARGET.preferFoeTeam && isFoeTeamOwner(owner, foeKeys)) return true;
  return trophiesNear(selfTrop, rivalTrop);
}

/**
 * Sort key for 攻める rows: foe team first, then closer trophies, then nearer ground.
 * Lower is better.
 */
export function raidTargetRank(
  owner: string,
  selfTrop: number,
  rivalTrop: number,
  foeKeys: ReadonlySet<string>,
  dist2: number,
): number {
  const foe = RAID_TARGET.preferFoeTeam && isFoeTeamOwner(owner, foeKeys) ? 0 : 1;
  const gap = Math.abs(selfTrop - rivalTrop);
  return foe * 1e12 + gap * 1e6 + dist2;
}

/** Hold-time points for one day's outer count. */
export const holdPointsFor = (outer: number): number => Math.max(0, Math.floor(outer)) * WAR_SCORE.perOuterDay;

/** Battle settle points. */
export const battlePointsFor = (result: "win" | "loss" | "draw"): number => WAR_SCORE.battle[result];

/** Hold-time points currently in the window (no battle points). */
export const holdPointsOf = (score: WarScore | null | undefined): number => {
  if (!score) return 0;
  return score.outerByDay.reduce((n, x) => n + holdPointsFor(x.outer), 0);
};

/** Battle points already in `total` (total − current hold window). */
const battlePointsOf = (cur: WarScore): number => Math.max(0, cur.total - holdPointsOf(cur));

/**
 * Record today's outer count, trim the window, recompute hold-time into total.
 * Prior battle points stay. Call once per profile day advance (settle).
 */
export function recordOuterDay(score: WarScore | null | undefined, day: number, outer: number): WarScore {
  const cur = score ?? emptyWarScore();
  const battles = battlePointsOf(cur);
  const d = Math.max(1, Math.floor(day));
  const o = Math.max(0, Math.floor(outer));
  const without = cur.outerByDay.filter((x) => x.day !== d);
  const outerByDay = [...without, { day: d, outer: o }]
    .sort((a, b) => a.day - b.day)
    .filter((x) => x.day > d - WAR_SCORE.windowDays);
  const hold = outerByDay.reduce((n, x) => n + holdPointsFor(x.outer), 0);
  return { total: hold + battles, outerByDay, lastBattle: cur.lastBattle };
}

/** Fold a settled 部隊戦 into the score. */
export function addBattleScore(score: WarScore | null | undefined, result: "win" | "loss" | "draw"): WarScore {
  const cur = score ?? emptyWarScore();
  const pts = battlePointsFor(result);
  return { ...cur, total: cur.total + pts, lastBattle: pts };
}

/**
 * Hold-time score over the recent window (team-battle hook name `scoreHeldMs`).
 * Units are score points from outer-day holdings, not wall-clock ms.
 */
export const scoreHeldPoints = (score: WarScore | null | undefined): number => holdPointsOf(score);

/**
 * Take-home slots: pouch module only (作り順⑥ #7).
 * War power must never feed this — keep the hook so a later outer→pouch link is obvious and rejected.
 */
export function takeHomeSlots(h: Hideout, _warPower = 0): number {
  void _warPower;
  return pouchSlots(h);
}

/** Saved war-score blob, or empty when missing / unreadable (v47 and older). */
export function parseWarScore(raw: unknown): WarScore {
  if (!raw || typeof raw !== "object") return emptyWarScore();
  const o = raw as Record<string, unknown>;
  const total = typeof o.total === "number" && Number.isFinite(o.total) ? Math.max(0, Math.floor(o.total)) : 0;
  const lastBattle =
    typeof o.lastBattle === "number" && Number.isFinite(o.lastBattle) ? Math.max(0, Math.floor(o.lastBattle)) : 0;
  const outerByDay: OuterDay[] = [];
  if (Array.isArray(o.outerByDay)) {
    for (const x of o.outerByDay) {
      if (!x || typeof x !== "object") continue;
      const r = x as Record<string, unknown>;
      if (typeof r.day !== "number" || !Number.isFinite(r.day)) continue;
      if (typeof r.outer !== "number" || !Number.isFinite(r.outer)) continue;
      outerByDay.push({ day: Math.max(1, Math.floor(r.day)), outer: Math.max(0, Math.floor(r.outer)) });
    }
  }
  return { total, outerByDay, lastBattle };
}

/** Bounty target id from a foe team (max outer). */
export const bountyTargetOf = (foe: Pick<Team, "members"> | null | undefined): string | null =>
  pickLeader((foe?.members ?? []).map((m: TeamMember) => ({ id: m.id, outer: m.outer })));
