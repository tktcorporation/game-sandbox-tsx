/*
 * Team-battle field map (作り順⑤ / design-direction.md「部隊戦は普段の地図とは別の場」).
 *
 * The field is a separate contested ground from the player's own island: its hubs, links and
 * entry are defined here. Step 5 reuses the world's playable geometry by mapping each field hub
 * onto a compact connected subgraph of existing nodes (港湾の作業帯) so sortie / 核 · 制圧 /
 * overnight defence keep working without a second terrain build. HUD and departure use the
 * field's own names; home-island `poiState` is not written from field captures.
 *
 * Step 6 plugs: war power, raid targeting, leader bounty, held-time scoring — see hooks on
 * `TEAM_BATTLE` / `TeamBattle` in meta/team-battle.ts.
 */
import type { EntryId, NodeId } from "./map";

/** Tunable field + match numbers (作り順⑤). */
export const TEAM_BATTLE = {
  /**
   * How many profile days one 部隊戦 lasts.
   * Judgment: 3 days ≈ 「数日で終わり、長く引きずらない」 without season reset.
   */
  days: 3,
  /**
   * Hubs on the field. Odd count so a start split can leave a centre contested.
   * Judgment: 5 keeps the board readable on a minimal UI.
   */
  hubs: 5,
  /**
   * Hubs our side starts with (rest go to the foe; centre may be foe).
   * Judgment: 2 / 3 so the opening asks the player to push, not only defend.
   */
  startOurs: 2,
} as const;

/**
 * Stable field-hub id (not an island `PoiId` / `NodeId`).
 * Player-facing names live in `FIELD_HUBS[].name` and `view/copy.ts`.
 */
export type FieldHubId = "outpost" | "plaza" | "depot" | "watch" | "bridgehead";

/** One hub on the 部隊戦 field. */
export type FieldHub = {
  id: FieldHubId;
  /** On-screen name (field's own — not the mapped island POI's). */
  name: string;
  /**
   * Island node whose core / garrison / depot geometry this hub reuses in a field raid.
   * Capture reads this node; results write `FieldHubId` holds, not home `poiState`.
   */
  node: NodeId;
};

/**
 * The field's hubs in front order (west → east along the harbor works belt).
 * Geometry: lodge — yard — cannery — smelter — coldstore (FRONT_LINKS connected).
 */
export const FIELD_HUBS: readonly FieldHub[] = [
  { id: "outpost", name: "前哨塔", node: "lodge" },
  { id: "plaza", name: "中央広場", node: "yard" },
  { id: "depot", name: "補給庫", node: "cannery" },
  { id: "watch", name: "監視塔", node: "smelter" },
  { id: "bridgehead", name: "橋頭堡", node: "coldstore" },
];

/** Links between field hubs (same order as playable FRONT_LINKS among mapped nodes). */
export const FIELD_LINKS: readonly (readonly [FieldHubId, FieldHubId])[] = [
  ["outpost", "plaza"],
  ["plaza", "depot"],
  ["outpost", "watch"],
  ["watch", "bridgehead"],
  ["depot", "bridgehead"],
];

/** Way in for a field sortie (港町の外れ — near the mapped belt). */
export const FIELD_ENTRY: EntryId = "outskirts";

/** Region the field geometry sits in (for departure / banners). */
export const FIELD_REGION = "harbor" as const;

/** On-screen name of the field itself. */
export const FIELD_NAME = "荒地の戦場";

/** Field hub by id, or undefined. */
export const fieldHubOf = (id: string): FieldHub | undefined => FIELD_HUBS.find((h) => h.id === id);

/** Field hub that maps onto this island node during a field raid, or undefined. */
export const fieldHubByNode = (node: NodeId): FieldHub | undefined => FIELD_HUBS.find((h) => h.node === node);

/** Island nodes that stand in for field hubs. */
export const FIELD_NODES: readonly NodeId[] = FIELD_HUBS.map((h) => h.node);

export const isFieldNode = (id: NodeId): boolean => FIELD_NODES.includes(id);

/** Assert hub count matches the tunable (catches a hand edit that drifts). */
if (FIELD_HUBS.length !== TEAM_BATTLE.hubs) {
  throw new Error(`FIELD_HUBS (${FIELD_HUBS.length}) must equal TEAM_BATTLE.hubs (${TEAM_BATTLE.hubs})`);
}
