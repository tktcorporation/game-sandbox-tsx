/**
 * The island's table for the server (src/ringfall/meta/island-table.ts), as map.ts gives it: the
 * nodes in `NODES` order with their tiers and garrisons, the nodes next to the camp and the POIs
 * that are no node. `islandTableSource()` is the file's text; scripts/ringfall-expeditions.ts fails
 * when the file differs from it and rewrites it with `--write`.
 */
import { FRONT_LINKS, NODES, POIS, TIER } from "../src/ringfall/sim/map";

export function islandTableSource(): string {
  const nodes = NODES.map((n) => {
    const poi = POIS.find((p) => p.id === n.id)!;
    const guards = poi.squads.flatMap((sq) => sq.members.map((m) => `["${m.kind}", ${m.plate ?? 0}]`));
    return `    { id: "${n.id}", tier: ${TIER[n.id]}, guards: [${guards.join(", ")}] },`;
  });
  const campNext = FRONT_LINKS.filter(([a]) => a === "camp").map(([, b]) => `"${b}"`);
  const closed = POIS.filter((p) => p.boss).map((p) => `"${p.id}"`);
  return `import type { EnemyKind, Rarity } from "../sim/config";

/*
 * The island as the server needs it (docs/ringfall/multiplayer.md): each node in \`NODES\` order
 * with its tier and its garrison (its POI's squads' members, each with its own plate), the nodes
 * next to the camp, and the POIs that are no node (the titan's pad). Written from map.ts by
 * scripts/ringfall-island-table.ts, whose text scripts/ringfall-expeditions.ts compares with this
 * file (\`--write\` rewrites it): the Worker reads this table instead of building the world.
 */

export interface TableNode {
  id: string;
  tier: number;
  guards: readonly (readonly [EnemyKind, Rarity])[];
}

export const ISLAND_TABLE: { nodes: readonly TableNode[]; campNext: readonly string[]; closed: readonly string[] } = {
  nodes: [
${nodes.join("\n")}
  ],
  campNext: [${campNext.join(", ")}],
  closed: [${closed.join(", ")}],
};
`;
}
