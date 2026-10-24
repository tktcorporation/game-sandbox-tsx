import { NODES, type NodeId } from "../sim/map";
import type { NodeHold } from "../sim/front";

/*
 * The island's tug of war as one bar (docs/ringfall/island-v2.md, 見せ方): the player's blue grows
 * from the left and the enemy's red from the right, one segment a node, the two counts at its
 * ends. The title, the camp's line of the day, the HUD and the results show it. When the count
 * changes the boundary slides from where it was; while a node is fought over it flickers; the
 * player's nodes the enemy is about to take pulse red at the boundary's blue side.
 */

export interface BarOpts {
  /** The player's count the boundary slides from (left out: from the change's start, or none). */
  from?: number;
  /** The player's nodes the enemy is about to take (`atRisk()`): that many segments pulse red. */
  risk?: number;
  /** A node is being taken by either side: the boundary flickers. */
  contested?: boolean;
  /** Seconds before the slide starts. */
  delay?: number;
}

/** The bar's HTML for `holds` (`NODES` order); `change` makes the boundary slide from before it. */
export function nodeRow(holds: readonly NodeHold[], change?: { gained?: readonly NodeId[]; lost?: readonly NodeId[] }, o: BarOpts = {}): string {
  const n = NODES.length;
  const own = holds.filter((h) => h === "freed").length;
  const from = Math.max(0, Math.min(n, o.from ?? own - (change?.gained?.length ?? 0) + (change?.lost?.length ?? 0)));
  const risk = Math.min(own, o.risk ?? 0);
  const style = `--n:${n};--own:${own};--from:${from};--risk:${risk};--delay:${o.delay ?? (change ? 0.5 : 0)}s`;
  const cls = ["tug", from !== own ? "moved" : "", o.contested ? "contested" : "", risk ? "at-risk" : ""].filter(Boolean).join(" ");
  return `<span class="${cls}" role="img" aria-label="${own} / ${n}" style="${style}"><b class="tug-n own">${own}</b><span class="tug-bar"><span class="tug-fill"></span><span class="tug-risk"></span><span class="tug-ticks"></span><span class="tug-edge"></span></span><b class="tug-n foe">${n - own}</b></span>`;
}
