/*
 * 作り順⑥ / design-direction.md「島は終わりなく育てる」+ 2026-11-26 CoC 型トロフィー:
 * war power (outer hubs → field thickness), raid targeting by trophy band,
 * leader bounty (materials), team score on the current 部隊戦 only.
 *
 * トロフィー = personal permanent rank (meta/trophies.ts). 得点 = team score inside
 * one 荒地の戦場 match (`TeamBattle.score`) — never a personal Profile field.
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
  /** Outer hubs that equal one step of overnight field defence. */
  perOuter: 1,
  /**
   * Minimum power gap (ours − foe) that holds the field overnight without a hub loss.
   * 0 = equal or better keeps; weaker side loses one hub.
   */
  defendGap: 0,
} as const;

/**
 * Who may appear on the 攻める list (2026-11-26: CoC trophy band).
 * Order by trophy closeness; no opponent-team preference.
 */
export const RAID_TARGET = {
  /**
   * Trophy gap (|self − rival|) at or below this allows a raid.
   * Judgment: TROPHY.band (400) — CoC-style matching band.
   */
  trophyBand: TROPHY.band,
  /**
   * When true, drop owners outside trophyBand from the 攻める list.
   * 2026-11-26: enabled (trophy closeness is the gate).
   */
  requireBand: true as const,
} as const;

/**
 * Leader bounty (作り順⑥): extra materials when taking an outer hub from the strongest foe.
 * Not trophies — materials only.
 */
export const BOUNTY = {
  /** Extra common materials on 核 · 制圧 of the leader's hub (on top of SEIZE). */
  extraMaterials: 3,
  /** Rank leaders by outer-hub count (fallback: trophies when outer unknown). */
  by: "outer" as const,
} as const;

/**
 * Team score for one 部隊戦 match only (2026-11-26).
 * Lives on `TeamBattle.score`; resets when a new battle starts. Never personal / never trophies.
 */
export const TEAM_SCORE = {
  /** Points per battlefield hub held for one profile day of the open match. */
  perHubDay: 1,
  /** Points added when the period settles (by hub-count result). */
  battle: { win: 30, draw: 10, loss: 0 } as const,
} as const;

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

/** Foe-team seat ids / island codes (optional badge; not used for raid gating). */
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

/** May this owner appear on the 攻める list? (trophy band when requireBand). */
export function canRaidOwner(_owner: string, selfTrop: number, rivalTrop: number): boolean {
  if (!RAID_TARGET.requireBand) return true;
  return trophiesNear(selfTrop, rivalTrop);
}

/**
 * Sort key for 攻める rows: closer trophies first, then nearer ground.
 * Lower is better. No opponent-team priority (2026-11-26).
 */
export function raidTargetRank(selfTrop: number, rivalTrop: number, dist2: number): number {
  const gap = Math.abs(selfTrop - rivalTrop);
  return gap * 1e6 + dist2;
}

/** Points for holding `hubs` battlefield hubs for one day of the open match. */
export const hubDayPoints = (hubs: number): number => Math.max(0, Math.floor(hubs)) * TEAM_SCORE.perHubDay;

/** Battle settle points for the team score. */
export const battlePointsFor = (result: "win" | "loss" | "draw"): number => TEAM_SCORE.battle[result];

/**
 * Take-home slots: pouch module only (作り順⑥ #7).
 * War power must never feed this.
 */
export function takeHomeSlots(h: Hideout, _warPower = 0): number {
  void _warPower;
  return pouchSlots(h);
}

/** Bounty target id from a foe team (max outer). */
export const bountyTargetOf = (foe: Pick<Team, "members"> | null | undefined): string | null =>
  pickLeader((foe?.members ?? []).map((m: TeamMember) => ({ id: m.id, outer: m.outer })));

/** Whether `owner` matches a bounty target id (bare code / `ai-` prefix either way). */
export function ownerMatches(owner: string, target: string): boolean {
  if (owner === target) return true;
  if (owner.startsWith("ai-") && owner.slice(3) === target) return true;
  if (target.startsWith("ai-") && target.slice(3) === owner) return true;
  return false;
}

/**
 * Owners who pay the leader bounty for a raid.
 * `heldBy` = rival id → contested hubs they hold at raid start.
 * Pays only when that leader is among `captured` owners.
 */
export function bountyOwnersFrom(
  heldBy: ReadonlyMap<string, number>,
  captured: readonly string[],
  hookTarget?: string | null,
): Set<string> {
  const out = new Set<string>();
  if (!captured.length) return out;
  const leader = pickLeader([...heldBy].map(([id, outer]) => ({ id, outer })));
  const add = (id: string) => {
    out.add(id);
    if (!id.startsWith("ai-")) out.add(`ai-${id}`);
    else out.add(id.slice(3));
  };
  if (leader && captured.some((c) => ownerMatches(c, leader))) add(leader);
  if (hookTarget && captured.some((c) => ownerMatches(c, hookTarget))) add(hookTarget);
  return out;
}
