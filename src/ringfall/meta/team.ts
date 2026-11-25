/*
 * 4-person teams (作り順④ / design-direction.md「島は終わりなく育てる」):
 * every player sits on a team of `TEAM.size`; empty seats are AI の仲間 with their own
 * islands (outer-hub holdings simulated like meta/ai-islands.ts).
 *
 * Scope of this step: data model, auto-assign + AI fill, Profile persistence, readout.
 * 作り順⑤ reads `Team` for the field match (meta/team-battle.ts). Still not yet:
 * war power, leader bounty, scoring (⑥) — they plug into `Team.id` / `TeamMember.outer`
 * / member slots without reshaping this type.
 */
import { CODE_ALPHABET, CODE_LENGTH } from "./island-code";
import { CONTESTED_OUTER_IDS } from "./contested-outer-table";
import { contestedOwned } from "./island";
import type { Island } from "./island";
import { aiLabel } from "./neighbours";

/** Tunable team size (部隊戦 4 対 4 の片側). */
export const TEAM = {
  size: 4,
  /**
   * AI teammate outer-hub growth: first holdings, climb rate per seat, spare left untaken.
   * Same shape as AI.held in ai-islands — outer hubs only (取り合う拠点).
   */
  aiOuter: { first: 1, rate: [0.28, 0.34, 0.24, 0.4] as const, spare: 1 },
} as const;

/**
 * One seat on a team.
 *
 * Future plugs: war power reads `outer`; leader bounty picks among non-ai / by trophies;
 * scoring tallies team `outer` over a window; battle field swaps AI seats for real players.
 */
export type TeamMember = {
  /** Stable id: player UUID, or `ai-<islandCode>` for AI の仲間 (same shape as aiOwner). */
  id: string;
  /** Display name without 「 · AI」 (view uses `memberLabel()`). */
  name: string;
  /** Island code (AI always; real player when claimed). */
  code: string;
  /** AI fill seat. */
  ai: boolean;
  /** Outer contested hubs this member holds on their island. */
  outer: number;
};

/** A team of exactly `TEAM.size` members. */
export type Team = {
  /** Stable team id (local auto-assign until a server issues one). */
  id: string;
  /**
   * Salt for AI の仲間 islands / outer counts. Fixed at form time so settle / reload /
   * signal open all draw the same holdings (not the evolving raid seed).
   */
  salt: number;
  members: TeamMember[];
};

/** Who the local player is when forming / refreshing a team. */
export type TeamSelf = {
  id: string;
  name: string;
  code?: string;
};

type IslandDay = { day: number; poiState: Island };

/** AI の仲間 name pools — do not overlap neighbour AI names in ai-islands.ts. */
const MATE_NAMES: readonly (readonly string[])[] = [
  ["ツキカゲ", "アオバネ", "シロナミ"],
  ["モミジガ", "カスミワ", "トキワヤ"],
  ["フジシロ", "マツカゼ", "ススキノ"],
];

function hash(...xs: number[]): number {
  let h = 0x811c9dc5;
  for (const x of xs) {
    h = Math.imul(h ^ (x >>> 0), 0x01000193) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
    h ^= h >>> 12;
  }
  return h >>> 0;
}

/** Outer hubs the local player holds (作り順② の取り合う拠点). */
export const selfOuterCount = (p: Pick<IslandDay, "poiState">): number => contestedOwned(p).length;

/** Max outer hubs on one island (table shared with Worker — no map build). */
export const outerCap = (): number => CONTESTED_OUTER_IDS.length;

/**
 * How many outer hubs an AI teammate in seat `slot` holds on day `day`.
 * Pure from salt + slot + day — same island every time for one salt.
 */
export function aiMateOuter(salt: number, slot: number, day: number): number {
  const max = Math.max(1, outerCap() - TEAM.aiOuter.spare);
  const d = Math.max(1, day);
  const climb = TEAM.aiOuter.first + (d - 1) * TEAM.aiOuter.rate[slot % TEAM.aiOuter.rate.length]!;
  const wobble = (hash(salt, slot, d, 19) % 3) - 1;
  return Math.max(0, Math.min(max, Math.round(climb) + wobble));
}

/** AI teammate island code + bare name for seat `slot`. */
export function aiMateIsland(salt: number, slot: number): { code: string; name: string } {
  // Mix with 0x7ea7 so codes never collide with neighbour AI islands for the same salt.
  const mix = salt ^ 0x7ea7;
  const code = Array.from({ length: CODE_LENGTH }, (_, i) => CODE_ALPHABET[hash(mix, slot, 61 + i) % CODE_ALPHABET.length]!).join("");
  const names = MATE_NAMES[slot % MATE_NAMES.length]!;
  return { code, name: names[hash(mix, slot, 11) % names.length]! };
}

/** Display label: AI seats always show 「 · AI」. */
export const memberLabel = (m: Pick<TeamMember, "name" | "ai">): string => (m.ai ? aiLabel(m.name) : m.name);

/** Empty / unreadable team blob. */
export const emptyTeam = (): Team => ({ id: "", salt: 0, members: [] });

/** Stable salt from a player id (same shape as island-net `aiSalt` without the browser). */
export function teamSalt(playerId: string): number {
  let h = 0;
  for (const c of playerId) h = (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0;
  return h;
}

/** Well-formed team of TEAM.size, or null. */
export function parseTeam(raw: unknown): Team | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id.trim()) return null;
  if (!Array.isArray(o.members) || o.members.length !== TEAM.size) return null;
  const members: TeamMember[] = [];
  for (const m of o.members) {
    if (!m || typeof m !== "object") return null;
    const x = m as Record<string, unknown>;
    if (typeof x.id !== "string" || !x.id.trim()) return null;
    if (typeof x.name !== "string" || !x.name.trim()) return null;
    if (typeof x.code !== "string") return null;
    if (typeof x.ai !== "boolean") return null;
    const outer = typeof x.outer === "number" && Number.isFinite(x.outer) ? Math.max(0, Math.floor(x.outer)) : 0;
    members.push({ id: x.id, name: x.name.trim(), code: x.code, ai: x.ai, outer });
  }
  // Exactly one non-ai seat expected when auto-assigned; allow more for future real fills.
  const self = members.find((m) => !m.ai);
  if (!self) return null;
  const salt =
    typeof o.salt === "number" && Number.isFinite(o.salt) ? (o.salt >>> 0) : teamSalt(self.id);
  return { id: o.id.trim(), salt, members };
}

/** Local team id from the player's id (stable across days until a server reassigns). */
export const teamIdFor = (playerId: string): string => {
  const h = hash(...[...playerId].map((c) => c.charCodeAt(0)), 0x7ead);
  return `t-${(h >>> 0).toString(16).padStart(8, "0")}`;
};

/**
 * Build a fresh 4-seat team: self + AI fill.
 * Real-player matching is not in this step — auto-assign always fills with AI の仲間.
 */
export function formTeam(self: TeamSelf, salt: number, day: number, outer: number): Team {
  const members: TeamMember[] = [
    {
      id: self.id,
      name: self.name.trim() || "プレイヤー",
      code: self.code ?? "",
      ai: false,
      outer: Math.max(0, Math.floor(outer)),
    },
  ];
  for (let slot = 0; members.length < TEAM.size; slot++) {
    const a = aiMateIsland(salt, slot);
    members.push({
      id: `ai-${a.code}`,
      name: a.name,
      code: a.code,
      ai: true,
      outer: aiMateOuter(salt, slot, day),
    });
  }
  return { id: teamIdFor(self.id), salt: salt >>> 0, members };
}

/**
 * Ensure the profile has a full team and refresh outer counts (self from island, AI from day).
 * Idempotent: keeps existing team id / salt / AI seats when already well-formed.
 * `salt` is used only when forming a new team; afterwards `team.salt` wins.
 */
export function ensureTeam(
  team: Team | null | undefined,
  self: TeamSelf,
  salt: number,
  day: number,
  outer: number,
): Team {
  const parsed = team && team.members.length === TEAM.size ? team : null;
  const base = parsed && parsed.members.some((m) => !m.ai && m.id === self.id) ? parsed : formTeam(self, salt, day, outer);
  const useSalt = (base.salt ?? salt) >>> 0;
  let aiSlot = 0;
  const members = base.members.map((m) => {
    if (!m.ai) {
      return {
        ...m,
        id: self.id,
        name: self.name.trim() || m.name,
        code: self.code ?? m.code,
        outer: Math.max(0, Math.floor(outer)),
      };
    }
    const slot = aiSlot++;
    // Keep saved code/name when present so the seat stays the same person across days.
    const a = m.code ? { code: m.code, name: m.name } : aiMateIsland(useSalt, slot);
    const id = m.id.startsWith("ai-") ? m.id : `ai-${a.code}`;
    return {
      id,
      name: a.name,
      code: a.code,
      ai: true as const,
      outer: aiMateOuter(useSalt, slot, day),
    };
  });
  // Pad if a corrupt save had too few seats.
  while (members.length < TEAM.size) {
    const slot = aiSlot++;
    const a = aiMateIsland(useSalt, slot);
    members.push({ id: `ai-${a.code}`, name: a.name, code: a.code, ai: true, outer: aiMateOuter(useSalt, slot, day) });
  }
  return { id: base.id || teamIdFor(self.id), salt: useSalt, members: members.slice(0, TEAM.size) };
}

/** Refresh team outer counts for a profile day (call after settle / on signal open). */
export function refreshTeam(p: IslandDay & { team: Team }, self: TeamSelf, salt?: number): Team {
  return ensureTeam(p.team, self, salt ?? p.team.salt ?? teamSalt(self.id), p.day, selfOuterCount(p));
}
