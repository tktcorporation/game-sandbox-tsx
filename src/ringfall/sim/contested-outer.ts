/*
 * Which freeable hubs are on the island's outer edge and may be contested with neighbours
 * (design-direction.md「島は終わりなく育てる」作り順②).
 *
 * Outer = touching the sea or the world rectangle, derived from map data:
 *   (a) a vertex of the convex hull of all freeable node centres, or
 *   (b) the hub centre is within OUTER_SEA_NEAR of the coast (`offshore` > −OUTER_SEA_NEAR), or
 *   (c) the hub centre is within OUTER_BOUND_NEAR of `WORLD`.
 *
 * Inner hubs (and the camp's 野営・倉庫・作業場・工場, which are not nodes) stay untakeable.
 * Tuned so the original four shore hubs (観測所・浄水場・ロボット工場・追跡レーダー) stay included.
 */
import { WORLD } from "./config";
import { NODES, type NodeId } from "./map";
import { offshore } from "./terrain";

/** Metres: hub centre counts as touching the coast when `offshore(centre) > -this`. */
export const OUTER_SEA_NEAR = 110;

/** Metres: hub centre counts as touching the world edge when within this of `WORLD`. */
export const OUTER_BOUND_NEAR = 150;

type Pt = { id: NodeId; x: number; z: number };

/** Convex hull of freeable node centres (Andrew's monotone chain), CCW, no collinear shrink. */
function hullIds(pts: readonly Pt[]): Set<NodeId> {
  const s = [...pts].sort((a, b) => a.x - b.x || a.z - b.z);
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
  const lower: Pt[] = [];
  for (const p of s) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (const p of [...s].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return new Set([...lower, ...upper].map((p) => p.id));
}

/**
 * Freeable hubs on the outer edge (海または地図境界に面する), in `NODES` order.
 * Pure from `NODES` / `offshore` / `WORLD` — not a hand-maintained id list.
 */
export function outerFacingHubs(): NodeId[] {
  const pts: Pt[] = NODES.map((n) => ({ id: n.id, x: n.x, z: n.z }));
  const onHull = hullIds(pts);
  return NODES.filter((n) => {
    if (onHull.has(n.id)) return true;
    if (offshore(n.x, n.z) > -OUTER_SEA_NEAR) return true;
    const bound = Math.min(n.x - WORLD.x0, WORLD.x1 - n.x, n.z - WORLD.z0, WORLD.z1 - n.z);
    return bound < OUTER_BOUND_NEAR;
  }).map((n) => n.id);
}

/**
 * Contested outer hubs (取り合う拠点). Built once from the map in the browser / sim.
 * The Worker reads the frozen copy in `meta/contested-outer-table.ts` instead (no world build).
 */
export const CONTESTED_OUTER: readonly NodeId[] = outerFacingHubs();

export const isContestedOuter = (id: NodeId | string): boolean => (CONTESTED_OUTER as readonly string[]).includes(id);
