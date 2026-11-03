import type { EnemyKind, Rarity } from "../sim/config";

/*
 * The island as the server needs it (docs/ringfall/multiplayer.md): each node in `NODES` order
 * with its tier and its garrison (its POI's squads' members, each with its own plate), the nodes
 * next to the camp, and the POIs that are no node (the titan's pad). Written from map.ts by
 * scripts/ringfall-island-table.ts, whose text scripts/ringfall-expeditions.ts compares with this
 * file (`--write` rewrites it): the Worker reads this table instead of building the world.
 */

export interface TableNode {
  id: string;
  tier: number;
  guards: readonly (readonly [EnemyKind, Rarity])[];
}

export const ISLAND_TABLE: { nodes: readonly TableNode[]; campNext: readonly string[]; closed: readonly string[] } = {
  nodes: [
    { id: "supply", tier: 0, guards: [["grunt", 1], ["grunt", 0], ["grunt", 0], ["drone", 0], ["grunt", 0], ["charger", 0], ["grunt", 0], ["drone", 0]] },
    { id: "quarry", tier: 1, guards: [["grunt", 1], ["grunt", 0], ["grunt", 0], ["drone", 0], ["charger", 0], ["grunt", 0], ["grunt", 0], ["drone", 0]] },
    { id: "relay", tier: 1, guards: [["grunt", 0], ["heavy", 0], ["grunt", 0], ["drone", 0], ["drone", 0], ["drone", 0], ["grunt", 1], ["grunt", 0], ["charger", 0]] },
    { id: "wreck", tier: 3, guards: [["grunt", 1], ["heavy", 0], ["grunt", 0], ["grunt", 0], ["drone", 0], ["grunt", 0], ["drone", 0], ["charger", 0], ["drone", 0]] },
    { id: "yard", tier: 2, guards: [["grunt", 1], ["heavy", 0], ["grunt", 0], ["grunt", 0], ["grunt", 0], ["drone", 0], ["grunt", 0], ["drone", 0]] },
    { id: "smelter", tier: 2, guards: [["grunt", 1], ["grunt", 0], ["heavy", 0], ["charger", 0], ["grunt", 0], ["drone", 0], ["grunt", 0], ["drone", 0]] },
    { id: "station", tier: 1, guards: [["grunt", 0], ["grunt", 1], ["grunt", 0], ["drone", 0]] },
    { id: "waterworks", tier: 1, guards: [["grunt", 0], ["grunt", 0], ["grunt", 1], ["drone", 0]] },
    { id: "lodge", tier: 2, guards: [["grunt", 0], ["heavy", 0], ["grunt", 1], ["drone", 0]] },
    { id: "cannery", tier: 2, guards: [["grunt", 0], ["heavy", 0], ["grunt", 1], ["drone", 0]] },
    { id: "coldstore", tier: 2, guards: [["grunt", 0], ["heavy", 0], ["grunt", 1], ["drone", 0]] },
    { id: "terminal", tier: 2, guards: [["grunt", 0], ["drone", 0], ["grunt", 0], ["grunt", 1], ["grunt", 0], ["charger", 0]] },
    { id: "carpark", tier: 1, guards: [["grunt", 0], ["grunt", 0], ["grunt", 1], ["drone", 0]] },
    { id: "robotworks", tier: 3, guards: [["heavy", 0], ["grunt", 0], ["grunt", 0], ["charger", 0], ["drone", 0], ["grunt", 1], ["heavy", 0], ["grunt", 0], ["heavy", 0], ["drone", 0]] },
    { id: "highrise", tier: 2, guards: [["grunt", 0], ["grunt", 0], ["grunt", 0], ["drone", 0], ["grunt", 1], ["grunt", 0], ["grunt", 0], ["charger", 0]] },
    { id: "powerplant", tier: 2, guards: [["grunt", 0], ["grunt", 0], ["grunt", 1], ["drone", 0], ["grunt", 0], ["charger", 0], ["grunt", 0], ["drone", 0]] },
    { id: "control", tier: 1, guards: [["grunt", 1], ["grunt", 0], ["grunt", 0], ["drone", 0], ["grunt", 0], ["charger", 0], ["grunt", 0], ["drone", 0]] },
    { id: "assembly", tier: 2, guards: [["grunt", 0], ["grunt", 0], ["grunt", 0], ["charger", 0], ["grunt", 0], ["drone", 0], ["grunt", 1], ["drone", 0]] },
    { id: "launchpad", tier: 3, guards: [["heavy", 0], ["grunt", 0], ["grunt", 0], ["drone", 0], ["grunt", 0], ["charger", 0], ["grunt", 1], ["grunt", 0]] },
    { id: "fuel", tier: 1, guards: [["grunt", 0], ["grunt", 0], ["grunt", 0], ["drone", 0], ["grunt", 1], ["charger", 0], ["heavy", 0], ["grunt", 0]] },
    { id: "radar", tier: 2, guards: [["grunt", 0], ["charger", 0], ["grunt", 0], ["drone", 0], ["grunt", 0], ["grunt", 0], ["grunt", 1], ["drone", 0]] },
  ],
  campNext: ["supply"],
  closed: ["pad"],
};
