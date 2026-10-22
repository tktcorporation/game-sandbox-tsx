import { NODES, nodeIndex, type NodeId } from "../sim/map";
import type { NodeHold } from "../sim/front";

/*
 * The island's six nodes as a row of marks (docs/ringfall/island-v2.md, 見せ方): the HUD's top,
 * the camp's line of the day and the results show it. A node the player holds is filled blue;
 * the rest stay hollow in the enemy's red, so the row fills as the island is taken. The
 * reservoir's three come first, then the harbor's, in the order the front runs.
 */

/** The nodes in the row's order: the reservoir's from the camp out, then the harbor's to the wreck. */
export const ROW: readonly NodeId[] = ["supply", "quarry", "relay", "yard", "smelter", "wreck"];

/** The row's HTML for `holds` (`NODES` order); `gained` and `lost` mark the nodes that changed hands. */
export function nodeRow(holds: readonly NodeHold[], change?: { gained?: readonly NodeId[]; lost?: readonly NodeId[] }): string {
  const marks = ROW.map((id, k) => {
    const i = nodeIndex(id);
    const own = holds[i] === "freed";
    const cls = ["node", own ? "own" : "", change?.gained?.includes(id) ? "gained" : "", change?.lost?.includes(id) ? "lost" : "", k === 3 ? "gap" : ""].filter(Boolean).join(" ");
    return `<i class="${cls}" title="${NODES[i].name}"></i>`;
  }).join("");
  return `<span class="node-row" role="img" aria-label="${holds.filter((h) => h === "freed").length} / ${NODES.length}">${marks}</span>`;
}
