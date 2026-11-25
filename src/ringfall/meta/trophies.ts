/*
 * Trophy ranking (docs/ringfall/design-direction.md, CoC 型):
 * take a contested rival hub → gain; defend (守りきった) → small gain; lose a hub → lose.
 * Width of the attack swap follows the trophy gap (Boom Beach / classic CoC).
 * Materials from 核 · 制圧 are separate (`SEIZE`); trophies are not paid for capturing a core alone.
 */
import { rivalOf, type PoiHold } from "../sim/holds";
import type { NodeId } from "../sim/map";
import { ISLAND_TABLE } from "./island-table";
import { isContestedShore } from "./neighbours";

/**
 * Numbers for the ranking layer. Soft season reset is left to a later pass.
 *
 * Rationale (CoC-shaped, RINGFALL scale — see design-direction 「トロフィーと物資」):
 * - Attack win ≈ CoC ~30 at even trophies → `base` 30 ± `maxBonus` 20 from the gap.
 * - Defence win is smaller than attack (CoC defence ≈ half or less) → `defend` 10 (~1/3 of base).
 * - Failed attack does **not** deduct trophies: RINGFALL's attack is a normal raid's 核 · 制圧,
 *   not a short dedicated raid; "no take → no gain" is the loss. Defender still gets `defend`.
 */
export const TROPHY = {
  /** New / migrated profiles. */
  start: 1000,
  /** Base swap per contested hub taken or lost. */
  base: 30,
  /** Extra (or less) from the gap, capped. */
  maxBonus: 20,
  /** Gap (defender − attacker) at which the bonus saturates. */
  band: 400,
  /** Per successful defence (守りきった), smaller than an attack win. */
  defend: 10,
  min: 0,
  max: 5000,
} as const;

/**
 * Materials from 核 · 制圧 of a rival-held hub (including AI). Separate from trophies:
 * trophies move when ownership of a contested hub changes; these feed 倉庫へ届いた.
 *
 * Rationale: was 1 common on an empty 中継ボックス — too thin next to a +30 trophy line.
 * Empty stock → `emptyReserve` commons; every 制圧 also adds `bonus` on top of parcels so
 * the core capture feels like CoC resource loot even when the defender spent their stock.
 */
export const SEIZE = {
  /** Common materials when that hub's 島の守り stock is empty (was 1). */
  emptyReserve: 3,
  /** Extra materials on every rival 制圧, on top of parcels taken. */
  bonus: 2,
} as const;

/** Clamp to the live range. */
export const clampTrophies = (n: number): number => Math.max(TROPHY.min, Math.min(TROPHY.max, Math.round(n)));

/** Trophies for `wipes` successful defences (守りきった), each `TROPHY.defend`. */
export function defendGain(wipes: number): number {
  return Math.max(0, Math.round(wipes)) * TROPHY.defend;
}

/**
 * How many trophies move when `attacker` takes a node from `defender` (or the reverse for loss).
 * Higher defender → more gain for the attacker; lower → less. Zero-sum locally.
 */
export function trophySwap(attacker: number, defender: number): { gain: number; loss: number } {
  const diff = defender - attacker;
  const bonus = Math.round((Math.max(-TROPHY.band, Math.min(TROPHY.band, diff)) / TROPHY.band) * TROPHY.maxBonus);
  const gain = Math.max(1, TROPHY.base + bonus);
  return { gain, loss: gain };
}

/** Unknown rival → treat as even with the player (band mid). */
export const rivalTrophies = (_owner: string, self: number): number => self;

/**
 * Net trophy change for one settle: contested coastal hubs taken from rivals / lost to rivals.
 * Non-contested rival nodes (legacy) do not move trophies — ownership change of 取り合う拠点 only
 * (design-direction 「トロフィーと物資」). `rivalTrophiesOf` supplies the other side's standing.
 */
export function trophyDelta(
  self: number,
  before: readonly PoiHold[],
  after: readonly PoiHold[],
  rivalTrophiesOf: (owner: string) => number = (o) => rivalTrophies(o, self),
): { next: number; gained: number; lost: number; taken: NodeId[]; dropped: NodeId[] } {
  let gained = 0;
  let lost = 0;
  const taken: NodeId[] = [];
  const dropped: NodeId[] = [];
  // ISLAND_TABLE.nodes is NODES order (server-safe; importing map.ts would build the world in the Worker).
  for (let i = 0; i < ISLAND_TABLE.nodes.length; i++) {
    const id = ISLAND_TABLE.nodes[i].id as NodeId;
    if (!isContestedShore(id)) continue;
    const was = before[i] ?? "foe";
    const now = after[i] ?? "foe";
    const wasRival = rivalOf(was);
    const nowRival = rivalOf(now);
    // Took a contested rival hub.
    if (wasRival !== null && now === "own") {
      const { gain } = trophySwap(self + gained - lost, rivalTrophiesOf(wasRival));
      gained += gain;
      taken.push(id);
    }
    // Lost a contested hub to a rival.
    if (was === "own" && nowRival !== null) {
      const { loss } = trophySwap(rivalTrophiesOf(nowRival), self + gained - lost);
      lost += loss;
      dropped.push(id);
    }
  }
  return { next: clampTrophies(self + gained - lost), gained, lost, taken, dropped };
}
