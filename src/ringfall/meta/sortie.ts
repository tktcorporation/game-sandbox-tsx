/*
 * Sorties to neighbours' holdings (docs/ringfall/holdings-raid.md): which holdings of the islands
 * next door may be attacked, what a sortie to one starts with, and the record of those taken.
 *
 * A holding is a node its owner holds on their own island. A sortie plays at that node alone
 * (`Start.sortie` in sim/state.ts); taking its core gives the stars, trophies and 島の守り that a
 * rival hub's 核 · 制圧 gives (`raidOdds()`, `seizeRivalLoot()`), and leaves the player's own island
 * as it was. The holding goes back to the robots on its owner's island: for the game's own islands
 * (AI の島) it is no target for `SORTIE_META.regrow` days (`Profile.raided`).
 *
 * The islands of real players come with their holdings from the island server in a later step.
 */
import { DEFENCE_AID } from "../sim/island";
import { aiOwner } from "../sim/holds";
import { NODES, nodeIndex, type NodeId } from "../sim/map";
import type { Start } from "../sim/state";
import { aiDefenceParcels, aiFactory, aiIslands, aiNodes } from "./ai-islands";
import { aiLabel, type Neighbour } from "./neighbours";
import { SEIZE, canRaidOwner, raidOdds, rivalTrophies, trophiesTable, winBonusBase } from "./trophies";

/** The numbers of sorties outside the raid itself (that is `SORTIE` in sim/config.ts). */
export const SORTIE_META = {
  /** Days a holding taken stays the robots' on its owner's island, the day it was taken included. */
  regrow: 2,
  /**
   * The most records kept (`Profile.raided`): every holding the islands next door could hold (four
   * islands of twenty-one nodes), so none still regrowing is ever dropped by the cap.
   */
  keep: 84,
};

/** A holding a sortie took: its owner (a `RivalHold`'s id), the node and the profile's day. */
export interface Raided {
  owner: string;
  id: NodeId;
  day: number;
}

/** A saved list of holdings taken; anything unreadable is dropped. */
export function parseRaided(raw: unknown): Raided[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is Raided => !!r && typeof r === "object" && typeof (r as Raided).owner === "string" && /^[A-Za-z0-9_-]{1,64}$/.test((r as Raided).owner) && nodeIndex((r as Raided).id) >= 0 && Number.isInteger((r as Raided).day))
    .map((r) => ({ owner: r.owner, id: r.id, day: r.day }))
    .slice(-SORTIE_META.keep);
}

/** `list` with holding `id` of `owner` taken on `day`. */
export const recordRaid = (list: readonly Raided[], owner: string, id: NodeId, day: number): Raided[] =>
  [...list.filter((r) => !(r.owner === owner && r.id === id) && day - r.day < SORTIE_META.regrow), { owner, id, day }].slice(-SORTIE_META.keep);

/** Whether holding `id` of `owner` is still the robots' on `day` after a sortie took it. */
export const regrowing = (list: readonly Raided[], owner: string, id: NodeId, day: number): boolean =>
  list.some((r) => r.owner === owner && r.id === id && day - r.day < SORTIE_META.regrow);

/** One holding the departure lists to attack. */
export interface SortieTarget {
  id: NodeId;
  /** 「カゲウツ · AIの浄水場」 */
  title: string;
  /** The owner as a `RivalHold`'s id (`ai-` and the code for the game's islands). */
  owner: string;
  ownerName: string;
  hubName: string;
  /** The owner's island code. */
  code: string;
  ai: boolean;
  /** Their factory's level: the defence's kinds. */
  factory: number;
  /** 島の守り grunts with the defence (capped at `DEFENCE_AID`). */
  guard: number;
  /** Trophies for ★★★ / lost at 0★ (`raidOdds()`). */
  win: number;
  lose: number;
  /** Materials 核 · 制圧 brings home at least (`SEIZE`). */
  loot: number;
  /** League win-bonus materials at ★★★ (0 in 見習い). */
  winBonus: number;
}

/**
 * The holdings the player may attack on `day`: every node each of the game's islands next door
 * (`neighbours` marked `ai`) holds on its own island, but those taken lately (`raided`), within the
 * trophy band, nearest trophies first, then by island and the front's order.
 */
export function sortieTargets(
  neighbours: readonly Neighbour[],
  salt: number,
  day: number,
  selfTrop: number,
  raided: readonly Raided[] = [],
  real: Readonly<Record<string, { held: readonly string[]; guard: Readonly<Record<string, number>> }>> = {},
): SortieTarget[] {
  const table = trophiesTable(neighbours);
  const taken = neighbours.filter((n) => !n.ai && n.slot !== undefined).map((n) => n.slot!);
  const rows: (SortieTarget & { gap: number; slot: number; order: number })[] = [];
  for (const a of aiIslands(salt, taken)) {
    const hit = neighbours.find((n) => n.ai && n.code === a.code);
    if (!hit) continue;
    const owner = aiOwner(a.code);
    const d = hit.day ?? day;
    const rivalTrop = hit.trophies ?? rivalTrophies(owner, selfTrop, table);
    if (!canRaidOwner(owner, selfTrop, rivalTrop)) continue;
    const held = aiNodes(a, salt, d);
    const guards = aiDefenceParcels(a, salt, d, held);
    const { N, M } = raidOdds(selfTrop, rivalTrop);
    const ownerName = aiLabel(a.name);
    for (const id of held) {
      if (regrowing(raided, owner, id, day)) continue;
      const n = NODES[nodeIndex(id)];
      rows.push({
        id,
        title: `${ownerName}の${n.name}`,
        owner,
        ownerName,
        hubName: n.name,
        code: a.code,
        ai: true,
        factory: Number.isFinite(hit.factory) ? Math.max(0, Math.round(hit.factory!)) : aiFactory(d),
        guard: Math.min(DEFENCE_AID, guards.filter((q) => q.poi === id).length),
        win: N,
        lose: M,
        loot: SEIZE.emptyReserve + SEIZE.bonus,
        winBonus: winBonusBase(selfTrop),
        gap: Math.abs(rivalTrop - selfTrop),
        slot: a.slot,
        order: nodeIndex(id),
      });
    }
  }
  // Other players: the holdings their islands last showed (island-net.ts `cachedHoldings()`), their owner id their code.
  for (const n of neighbours) {
    const h = real[n.code];
    if (n.ai || !h) continue;
    const owner = n.code;
    const rivalTrop = n.trophies ?? rivalTrophies(owner, selfTrop, table);
    if (!canRaidOwner(owner, selfTrop, rivalTrop)) continue;
    const { N, M } = raidOdds(selfTrop, rivalTrop);
    for (const id of h.held) {
      const i = nodeIndex(id as NodeId);
      if (i < 0 || regrowing(raided, owner, id as NodeId, day)) continue;
      const node = NODES[i];
      rows.push({
        id: node.id,
        title: `${n.name}の${node.name}`,
        owner,
        ownerName: n.name,
        hubName: node.name,
        code: n.code,
        ai: false,
        factory: Math.max(0, Math.round(n.factory ?? 0)),
        guard: Math.min(DEFENCE_AID, h.guard[id] ?? 0),
        win: N,
        lose: M,
        loot: SEIZE.emptyReserve + SEIZE.bonus,
        winBonus: winBonusBase(selfTrop),
        gap: Math.abs(rivalTrop - selfTrop),
        slot: n.slot ?? 9,
        order: i,
      });
    }
  }
  return rows
    .sort((x, y) => x.gap - y.gap || x.slot - y.slot || x.order - y.order)
    .map(({ gap: _g, slot: _s, order: _o, ...r }) => r);
}

/** How many other players a core offers to set out against (`jumpTargets()`). */
export const JUMP = { choices: 3 };

/**
 * The other players a sortie from the core of node `id` may go to: those of `targets` (already
 * within the trophy band, nearest trophies first) who hold the same node, a few at most. `first`
 * is an owner the player set out for (やり返す): while they hold the node they lead the choices.
 */
export function jumpTargets(targets: readonly SortieTarget[], id: NodeId, first?: string): SortieTarget[] {
  const at = targets.filter((t) => t.id === id);
  const lead = first ? at.filter((t) => t.owner === first) : [];
  return [...lead, ...at.filter((t) => !lead.includes(t))].slice(0, JUMP.choices);
}

/** The nodes some player of `targets` holds: the cores of the player's a sortie may set out from. */
export const jumpNodes = (targets: readonly SortieTarget[]): NodeId[] => [...new Set(targets.map((t) => t.id))];

/** What a sortie to `t` starts the raid with (`Start.sortie`). */
export const sortieStart = (t: SortieTarget): NonNullable<Start["sortie"]> => ({ id: t.id, owner: t.owner, factory: t.factory, aid: t.guard, N: t.win, M: t.lose });
