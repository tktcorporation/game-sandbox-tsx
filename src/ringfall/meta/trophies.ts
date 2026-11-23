/*
 * Trophy ranking T1 (docs/ringfall/game-design-review.md §5.5): take a rival / neighbour-front
 * node → gain; lose a node to another player → lose. Width follows the trophy gap (Boom Beach /
 * classic CoC). Defence kill bonuses are out of scope for now.
 */
import { rivalOf, type PoiHold } from "../sim/holds";
import { NODES, type NodeId } from "../sim/map";

/** Numbers for T1. Soft season reset is left to a later pass. */
export const TROPHY = {
  /** New / migrated profiles. */
  start: 1000,
  /** Base swap per node taken or lost. */
  base: 30,
  /** Extra (or less) from the gap, capped. */
  maxBonus: 20,
  /** Gap (defender − attacker) at which the bonus saturates. */
  band: 400,
  min: 0,
  max: 5000,
} as const;

/** Clamp to the live range. */
export const clampTrophies = (n: number): number => Math.max(TROPHY.min, Math.min(TROPHY.max, Math.round(n)));

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
 * Net trophy change for one settle: nodes taken from rivals at raid start, and nodes lost to
 * rivals by day's end. `rivalTrophiesOf` supplies the other side's standing (neighbours / default).
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
  for (let i = 0; i < NODES.length; i++) {
    const id = NODES[i].id;
    const was = before[i] ?? "held";
    const now = after[i] ?? "held";
    const wasRival = rivalOf(was);
    const nowRival = rivalOf(now);
    // Took a rival (or any non-freed that ends freed from a rival start).
    if (wasRival !== null && now === "freed") {
      const { gain } = trophySwap(self + gained - lost, rivalTrophiesOf(wasRival));
      gained += gain;
      taken.push(id);
    }
    // Lost a freed node to a rival.
    if (was === "freed" && nowRival !== null) {
      const { loss } = trophySwap(rivalTrophiesOf(nowRival), self + gained - lost);
      lost += loss;
      dropped.push(id);
    }
  }
  return { next: clampTrophies(self + gained - lost), gained, lost, taken, dropped };
}
