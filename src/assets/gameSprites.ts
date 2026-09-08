/**
 * Game-facing Kenney picks. This module is what actually gets bundled:
 * only the named imports below survive tree-shaking.
 */
import type { Resource, TroopType } from "../games/clash/game/types";
import { barbarian, coin, giant, potionBlue, ranger } from "./kenney";

export const TROOP_PIXEL: Record<TroopType, string> = {
  barbarian,
  archer: ranger,
  giant,
};

export const RESOURCE_PIXEL: Record<Resource, string> = {
  gold: coin,
  elixir: potionBlue,
};
