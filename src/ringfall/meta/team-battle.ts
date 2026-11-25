/*
 * Team-battle lifecycle (作り順⑤ / design-direction.md「部隊戦は普段の地図とは別の場」).
 *
 * One battle: our 4-person team vs one opposing team (AI fill allowed on both sides), on the
 * field map (`sim/team-field.ts`), for `TEAM_BATTLE.days` profile days. Matchmaking pairs one
 * foe team (all AI until a server matches real teams). Sortie enters the field; hub capture and
 * overnight auto-defence reuse island mechanics on field holds. End of period → simple win /
 * loss / draw by hubs held; the next battle can start. No seasons.
 *
 * Not yet (作り順⑥): war power from island holdings, raid targeting, leader bounty, held-time
 * scoring — hooks below (`TeamBattle.hooks` / `warPowerOf` / `scoreHeldMs`).
 */
import { TEAM, aiMateIsland, aiMateOuter, formTeam, teamIdFor, type Team, type TeamMember, type TeamSelf } from "./team";
import {
  FIELD_HUBS,
  FIELD_NAME,
  TEAM_BATTLE,
  fieldHubByNode,
  fieldHubOf,
  type FieldHubId,
} from "../sim/team-field";
import type { NodeId } from "../sim/map";
import type { PoiHold } from "../sim/holds";

export { TEAM_BATTLE, FIELD_NAME, FIELD_HUBS, fieldHubByNode, fieldHubOf };
export type { FieldHubId };

/** Who holds a field hub during a battle. */
export type FieldHold = "ours" | "theirs";

/**
 * Step-6 hooks stored on the battle (unused in step 5 — leave shape stable for saves).
 * war power / held-time / bounty read these without reshaping `TeamBattle`.
 */
export type TeamBattleHooks = {
  /** Reserved: war power derived from island outer holdings (作り順⑥). */
  warPower?: number;
  /** Reserved: ms each hub was held in the scoring window (作り順⑥). */
  heldMs?: Partial<Record<FieldHubId, number>>;
  /** Reserved: leader bounty target member id (作り順⑥). */
  bountyTarget?: string;
};

/** One 部隊戦 match on the field. */
export type TeamBattle = {
  /** Stable match id (local until a server issues one). */
  id: string;
  /** `Profile.day` when this battle opened. */
  started: number;
  /** Length in profile days (copied from `TEAM_BATTLE.days` at start). */
  days: number;
  /** Opposing team (AI fill for now). */
  foe: Team;
  /** Field hub holds. */
  holds: Record<FieldHubId, FieldHold>;
  /** Profile days on which the player sortied into the field (auto-defence skips those). */
  sortied: number[];
  /**
   * Settled outcome; null while the period is open.
   * After settle the profile keeps this until `ensureBattle` opens the next match.
   */
  result: "win" | "loss" | "draw" | null;
  /** Step-6 plugs — never required in step 5. */
  hooks: TeamBattleHooks;
};

/** Empty / pre-v47 blob. */
export const emptyTeamBattle = (): TeamBattle | null => null;

function hash(...xs: number[]): number {
  let h = 0x811c9dc5;
  for (const x of xs) {
    h = Math.imul(h ^ (x >>> 0), 0x01000193) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
    h ^= h >>> 12;
  }
  return h >>> 0;
}

/** Opposing-team name pools — do not overlap team.ts MATE_NAMES or neighbour AI. */
const FOE_NAMES: readonly (readonly string[])[] = [
  ["クロガネ", "アカツキ", "ミドリハ"],
  ["サカシマ", "ホタルビ", "ツルギヤ"],
  ["オボロヨ", "カスミガ", "ヤマビコ"],
  ["シノノメ", "アラシヤ", "コガネム"],
];

/** Build an all-AI opposing team for local matchmaking. */
export function formFoeTeam(salt: number, day: number, match: number): Team {
  const mix = salt ^ 0xb7a7 ^ match;
  const members: TeamMember[] = [];
  for (let slot = 0; slot < TEAM.size; slot++) {
    const a = aiMateIsland(mix, slot + 17);
    const names = FOE_NAMES[slot % FOE_NAMES.length]!;
    const name = names[hash(mix, slot, 23) % names.length]!;
    members.push({
      id: `ai-${a.code}`,
      name,
      code: a.code,
      ai: true,
      outer: aiMateOuter(mix, slot, day),
    });
  }
  return { id: `foe-${(hash(mix, 0x7ead) >>> 0).toString(16).padStart(8, "0")}`, salt: mix >>> 0, members };
}

/** Opening holds: first `startOurs` hubs ours, the rest theirs. */
export function openingHolds(): Record<FieldHubId, FieldHold> {
  const holds = {} as Record<FieldHubId, FieldHold>;
  FIELD_HUBS.forEach((h, i) => {
    holds[h.id] = i < TEAM_BATTLE.startOurs ? "ours" : "theirs";
  });
  return holds;
}

/** Match id from our team id + start day. */
export const battleIdFor = (teamId: string, started: number): string => {
  const h = hash(...[...teamId].map((c) => c.charCodeAt(0)), started, 0x71e1d);
  return `tb-${(h >>> 0).toString(16).padStart(8, "0")}`;
};

/**
 * Open a fresh battle: pair with one foe team (AI), split field hubs.
 * Real-team matchmaking is not in this step — always AI foe fill.
 */
export function startBattle(ours: Team, salt: number, day: number): TeamBattle {
  // Prefer the team's fixed salt (作り順④) so foe AI seats stay stable across reloads.
  const s = (ours.salt || salt) >>> 0;
  const match = hash(...[...ours.id].map((c) => c.charCodeAt(0)), day, s) >>> 0;
  return {
    id: battleIdFor(ours.id || teamIdFor("local"), day),
    started: day,
    days: TEAM_BATTLE.days,
    foe: formFoeTeam(s, day, match),
    holds: openingHolds(),
    sortied: [],
    result: null,
    // Step-6 hooks left empty for now.
    hooks: {},
  };
}

/** Hub counts for our side / theirs. */
export function hubCounts(holds: Record<FieldHubId, FieldHold>): { ours: number; theirs: number } {
  let ours = 0;
  let theirs = 0;
  for (const h of FIELD_HUBS) {
    if (holds[h.id] === "ours") ours++;
    else theirs++;
  }
  return { ours, theirs };
}

/** Win / loss / draw from current holds (period end). */
export function outcomeOf(holds: Record<FieldHubId, FieldHold>): "win" | "loss" | "draw" {
  const { ours, theirs } = hubCounts(holds);
  if (ours > theirs) return "win";
  if (theirs > ours) return "loss";
  return "draw";
}

/** Days left in the open battle at profile `day`, or 0 when settled / absent. */
export function daysLeft(b: TeamBattle | null | undefined, day: number): number {
  if (!b || b.result) return 0;
  return Math.max(0, b.started + b.days - day);
}

/** Whether the battle period is still open on profile `day`. */
export const battleOpen = (b: TeamBattle | null | undefined, day: number): boolean => !!b && !b.result && day < b.started + b.days;

/** Whether the period has ended and needs settle (or already settled). */
export const battleDue = (b: TeamBattle | null | undefined, day: number): boolean => !!b && !b.result && day >= b.started + b.days;

/**
 * Mark that the player sortied into the field on `day` (skips that day's auto-defence loss).
 */
export function markSortie(b: TeamBattle, day: number): TeamBattle {
  if (b.result || b.sortied.includes(day)) return b;
  return { ...b, sortied: [...b.sortied, day] };
}

/**
 * Apply field captures from a field raid: island `NodeId`s that map to field hubs become ours.
 * Home-island `poiState` is not touched here.
 */
export function applyFieldCaptures(b: TeamBattle, captured: readonly NodeId[]): TeamBattle {
  if (b.result || !captured.length) return b;
  let changed = false;
  const holds = { ...b.holds };
  for (const id of captured) {
    const hub = fieldHubByNode(id);
    if (!hub) continue;
    if (holds[hub.id] !== "ours") {
      holds[hub.id] = "ours";
      changed = true;
    }
  }
  return changed ? { ...b, holds } : b;
}

/**
 * Overnight auto-defence on the field (作り順⑤ minimal):
 * if the player did not sortie on the day that just ended, the foe takes one of our hubs
 * (first in FIELD_HUBS order). Hook for step 6: replace with war-power-weighted targeting.
 */
export function autoDefendField(b: TeamBattle, endedDay: number): TeamBattle {
  if (b.result) return b;
  if (b.sortied.includes(endedDay)) return b;
  const ours = FIELD_HUBS.find((h) => b.holds[h.id] === "ours");
  if (!ours) return b;
  return { ...b, holds: { ...b.holds, [ours.id]: "theirs" } };
}

/** Close the battle with a simple hub-count result. */
export function settleBattle(b: TeamBattle): TeamBattle {
  if (b.result) return b;
  return { ...b, result: outcomeOf(b.holds) };
}

/**
 * Ensure the profile has an open battle, or settle a due one and open the next.
 * Call on signal open / after settle when the day advances.
 */
export function ensureBattle(
  battle: TeamBattle | null | undefined,
  ours: Team,
  salt: number,
  day: number,
): TeamBattle {
  let b = battle && battle.holds ? battle : null;
  if (b && battleDue(b, day)) b = settleBattle(b);
  // After a settled result, open the next match on a later day (or immediately if none).
  if (!b || b.result) {
    // Same-day re-open only when there was no battle yet (fresh profile).
    if (b?.result && b.started + b.days > day) return b;
    return startBattle(ours, salt, day);
  }
  return b;
}

/**
 * Build `Start.island` holds for a field sortie: every freeable POI is the player's (cleared)
 * except field hubs, which follow battle holds. Titan pad stays foe (`newRun` forces it).
 * So the raid's front is the field alone.
 */
export function fieldIslandHolds(b: TeamBattle): Partial<Record<string, PoiHold>> {
  const out: Partial<Record<string, PoiHold>> = {};
  for (const h of FIELD_HUBS) {
    out[h.node] = b.holds[h.id] === "ours" ? "own" : "foe";
  }
  return out;
}

/**
 * Full island snapshot for a field raid: all freeable POIs own, field hubs from battle, pad foe.
 * Import POI list at the call site to avoid pulling map.ts into every meta consumer.
 */
export function mergeFieldHolds(
  allIds: readonly string[],
  bosses: ReadonlySet<string>,
  b: TeamBattle,
): Partial<Record<string, PoiHold>> {
  const field = fieldIslandHolds(b);
  const out: Partial<Record<string, PoiHold>> = {};
  for (const id of allIds) {
    if (bosses.has(id)) out[id] = "foe";
    else if (field[id] !== undefined) out[id] = field[id];
    else out[id] = "own";
  }
  return out;
}

/**
 * Step-6 hook: war power from outer holdings (not applied in step 5).
 * Returns 0 until 作り順⑥ fills it in.
 */
export const warPowerOf = (_ours: Team, _hooks?: TeamBattleHooks): number => 0;

/**
 * Step-6 hook: held-time score over a recent window (not applied in step 5).
 */
export const scoreHeldMs = (_hooks?: TeamBattleHooks): number => 0;

/** Saved battle blob, or null when missing / unreadable (v46 and older). */
export function parseTeamBattle(raw: unknown): TeamBattle | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id.trim()) return null;
  if (typeof o.started !== "number" || !Number.isFinite(o.started)) return null;
  if (typeof o.days !== "number" || !Number.isFinite(o.days) || o.days < 1) return null;
  if (!o.foe || typeof o.foe !== "object") return null;
  const foe = o.foe as Team;
  if (!Array.isArray(foe.members) || foe.members.length !== TEAM.size) return null;
  if (!o.holds || typeof o.holds !== "object") return null;
  const holds = {} as Record<FieldHubId, FieldHold>;
  for (const h of FIELD_HUBS) {
    const v = (o.holds as Record<string, unknown>)[h.id];
    holds[h.id] = v === "ours" ? "ours" : "theirs";
  }
  const sortied = Array.isArray(o.sortied)
    ? o.sortied.filter((d): d is number => typeof d === "number" && Number.isFinite(d)).map((d) => Math.floor(d))
    : [];
  const result = o.result === "win" || o.result === "loss" || o.result === "draw" ? o.result : null;
  const hooks: TeamBattleHooks =
    o.hooks && typeof o.hooks === "object" ? { ...(o.hooks as TeamBattleHooks) } : {};
  return {
    id: o.id.trim(),
    started: Math.max(1, Math.floor(o.started)),
    days: Math.max(1, Math.floor(o.days)),
    foe: {
      id: typeof foe.id === "string" ? foe.id : "foe",
      salt: typeof foe.salt === "number" && Number.isFinite(foe.salt) ? (foe.salt >>> 0) : 0,
      members: foe.members,
    },
    holds,
    sortied,
    result,
    hooks,
  };
}

/** Seed helper for tests: a self team + open battle. */
export function demoBattle(self: TeamSelf, salt: number, day: number, outer = 0): TeamBattle {
  return startBattle(formTeam(self, salt, day, outer), salt, day);
}
