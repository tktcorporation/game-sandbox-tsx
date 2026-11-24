/*
 * お隣の前線（○○の前線 / Neighbour Front）:
 * 自島にまだライバル拠点がなく、航路が開通しているお隣の島がある場合、
 * 海岸付近に攻められる印として「○○の前線」を表示する。
 * 出撃するとそのお隣への短いレイド（Short Raid）が行われる。
 *
 * 関連仕様: docs/ringfall/glossary.md, docs/ringfall/pvp-clarity.md
 */
import { aiOwner, rivalOf, type PoiHold } from "../sim/holds";
import { NODES, nodeIndex, type NodeId } from "../sim/map";
import { type Island } from "./island";
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
export const holdsOf = (poiState: Island): PoiHold[] => NODES.map((n) => poiState[n.id]?.state ?? "foe");

/** Whether `v` is a holds array (NODES order), not an Island record. */
const isHolds = (v: readonly PoiHold[] | Island): v is readonly PoiHold[] => Array.isArray(v);

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
 * 表示対象のお隣の前線（航路開通済みかつ自島に陣地なし）を算出する。
 * `from` が指定された場合は距離が近い順にソートする。
 */
export function neighbourFronts(
  holdsOrIsland: readonly PoiHold[] | Island,
  neighbours: readonly Neighbour[],
  from?: { x: number; z: number },
): NeighbourFront[] {
  const holds: readonly PoiHold[] = isHolds(holdsOrIsland) ? holdsOrIsland : holdsOf(holdsOrIsland);
  const mine = (id: NodeId) => holds[nodeIndex(id)] === "own";
  const owners = footholdOwners(holds);
  const out: NeighbourFront[] = [];
  for (const n of neighbours) {
    const k = n.slot;
    if (!routeOpen(k, mine)) continue;
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

/** 最も近いお隣の前線、または null。 */
export function neighbourFrontPick(
  holdsOrIsland: readonly PoiHold[] | Island,
  neighbours: readonly Neighbour[],
  from: { x: number; z: number },
): NeighbourFront | null {
  return neighbourFronts(holdsOrIsland, neighbours, from)[0] ?? null;
}
