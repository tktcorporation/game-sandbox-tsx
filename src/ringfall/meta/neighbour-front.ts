/*
 * Gap A (docs/ringfall/game-design-review.md §5.4): when the map has no rival hold to
 * attack, an open sea route to a neighbour that still has no foothold on this island shows
 * that neighbour's 「前線」 as an attackable mark on the coast.
 */
import { aiOwner, rivalOf, type PoiHold } from "../sim/holds";
import { NODES, nodeIndex, type NodeId } from "../sim/map";
import { playerNodes, type Island } from "./island";
import { NEIGHBOUR_SLOTS, routeOpen, type Neighbour } from "./neighbours";

/** A neighbour-front mark: whose, where to draw it, and the shore node that opened the route. */
export type NeighbourFront = {
  name: string;
  /** Midway between the shore node and the sea slot — the mark on the map. */
  x: number;
  z: number;
  shore: NodeId;
  code: string;
  ai?: true;
};

/** Node holds in NODES order from an island save. */
export const holdsOf = (poiState: Island): PoiHold[] => NODES.map((n) => poiState[n.id]?.state ?? "held");

/** Owners who already hold a node on this island (`rival:` ids). */
function footholdOwners(holds: readonly PoiHold[]): Set<string> {
  const out = new Set<string>();
  for (const h of holds) {
    const o = rivalOf(h);
    if (o) out.add(o);
  }
  return out;
}

/** Whether neighbour `n` already has a foothold (any of its owner ids) on the island. */
function hasFoothold(n: Neighbour, owners: Set<string>): boolean {
  if (owners.has(n.code)) return true;
  if (n.ai && owners.has(aiOwner(n.code))) return true;
  return false;
}

/**
 * Neighbour fronts to show (Gap A): route open, no foothold yet.
 * Ordered nearest to `from` when given. `holds` is NODES order (or built from `poiState`).
 */
export function neighbourFronts(
  holdsOrIsland: readonly PoiHold[] | Island,
  neighbours: readonly Neighbour[],
  from?: { x: number; z: number },
): NeighbourFront[] {
  const holds = Array.isArray(holdsOrIsland) ? holdsOrIsland : holdsOf(holdsOrIsland);
  const mine = (id: NodeId) => holds[nodeIndex(id)] === "freed";
  // When given an Island, prefer playerNodes (depots / unlocks stay consistent with the camp).
  const routeOk = Array.isArray(holdsOrIsland)
    ? (k: number) => routeOpen(k, mine)
    : (k: number) => routeOpen(k, (id) => playerNodes({ poiState: holdsOrIsland }).includes(id));
  const owners = footholdOwners(holds);
  const out: NeighbourFront[] = [];
  for (const n of neighbours) {
    const k = n.slot;
    if (!routeOk(k)) continue;
    if (hasFoothold(n, owners)) continue;
    const slot = NEIGHBOUR_SLOTS[k];
    if (!slot) continue;
    const shore = NODES[nodeIndex(slot.shore)];
    if (!shore) continue;
    out.push({
      name: `${n.name}の前線`,
      x: (shore.x + slot.x) / 2,
      z: (shore.z + slot.z) / 2,
      shore: slot.shore,
      code: n.code,
      ...(n.ai ? { ai: true as const } : {}),
    });
  }
  if (from) out.sort((a, b) => Math.hypot(a.x - from.x, a.z - from.z) - Math.hypot(b.x - from.x, b.z - from.z));
  return out;
}

/** The nearest Gap A front, or null. */
export function neighbourFrontPick(
  holdsOrIsland: readonly PoiHold[] | Island,
  neighbours: readonly Neighbour[],
  from: { x: number; z: number },
): NeighbourFront | null {
  return neighbourFronts(holdsOrIsland, neighbours, from)[0] ?? null;
}
