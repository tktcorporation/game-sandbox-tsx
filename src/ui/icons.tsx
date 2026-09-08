import type { ReactNode } from "react";
import type { IconType } from "react-icons";
import {
  GiAnvil,
  GiAxeSword,
  GiBarrel,
  GiBroadsword,
  GiCampingTent,
  GiCannon,
  GiCastle,
  GiCheckeredFlag,
  GiClosedBarbute,
  GiCog,
  GiCrossedSwords,
  GiCrossMark,
  GiCrystalGrowth,
  GiCutDiamond,
  GiExplosionRays,
  GiGiant,
  GiGoldBar,
  GiGoldMine,
  GiGoldStack,
  GiHammerDrop,
  GiHammerNails,
  GiHeartPlus,
  GiHighShot,
  GiHourglass,
  GiHouse,
  GiPadlock,
  GiPlainArrow,
  GiRecycle,
  GiStandingPotion,
  GiStoneWall,
  GiStopwatch,
  GiTrophyCup,
  GiTwoCoins,
  GiUpgrade,
  GiWatchtower,
} from "react-icons/gi";
import type { BuildingType, Resource, TroopType } from "../games/clash/game/types";

/**
 * Game-icons.net via react-icons — the Font Awesome of game UI.
 * 4,000+ CC BY 3.0 icons; we import only the ones this HUD uses.
 * Browse the rest at https://react-icons.github.io/react-icons/icons/gi/
 * or https://game-icons.net/
 */
const ICONS = {
  gold: GiGoldBar,
  elixir: GiStandingPotion,
  gems: GiCutDiamond,
  trophies: GiTrophyCup,
  townhall: GiCastle,
  goldmine: GiGoldMine,
  elixircollector: GiCrystalGrowth,
  goldstorage: GiGoldStack,
  elixirstorage: GiBarrel,
  barracks: GiAnvil,
  armycamp: GiCampingTent,
  cannon: GiCannon,
  archertower: GiWatchtower,
  wall: GiStoneWall,
  barbarian: GiClosedBarbute,
  archer: GiHighShot,
  giant: GiGiant,
  build: GiHammerNails,
  collect: GiTwoCoins,
  army: GiCrossedSwords,
  attack: GiBroadsword,
  more: GiCog,
  wait: GiHourglass,
  close: GiCrossMark,
  lock: GiPadlock,
  hp: GiHeartPlus,
  housing: GiHouse,
  constructing: GiHammerDrop,
  reset: GiRecycle,
  end: GiCheckeredFlag,
  timer: GiStopwatch,
  destruction: GiExplosionRays,
  dps: GiAxeSword,
  upgrade: GiUpgrade,
  north: GiPlainArrow,
} as const;

export type IconName = keyof typeof ICONS;

export type IconTone = "gold" | "elixir" | "gem" | "trophy" | "ink" | "cream" | "ember" | "leaf";

export const BUILDING_ICON: Record<BuildingType, IconName> = {
  townhall: "townhall",
  goldmine: "goldmine",
  elixircollector: "elixircollector",
  goldstorage: "goldstorage",
  elixirstorage: "elixirstorage",
  barracks: "barracks",
  armycamp: "armycamp",
  cannon: "cannon",
  archertower: "archertower",
  wall: "wall",
};

export const TROOP_ICON: Record<TroopType, IconName> = {
  barbarian: "barbarian",
  archer: "archer",
  giant: "giant",
};

export const RESOURCE_ICON: Record<Resource, IconName> = {
  gold: "gold",
  elixir: "elixir",
};

export const BUILDING_TONE: Record<BuildingType, IconTone> = {
  townhall: "gold",
  goldmine: "gold",
  elixircollector: "elixir",
  goldstorage: "gold",
  elixirstorage: "elixir",
  barracks: "ember",
  armycamp: "ember",
  cannon: "ink",
  archertower: "ink",
  wall: "ink",
};

export const TROOP_TONE: Record<TroopType, IconTone> = {
  barbarian: "ember",
  archer: "leaf",
  giant: "ember",
};

export function GameIcon({
  name,
  size = 18,
  tone,
  className,
  title,
}: {
  name: IconName;
  size?: number;
  tone?: IconTone;
  className?: string;
  title?: string;
}) {
  const Glyph = ICONS[name] as IconType;
  const cls = ["gicon", tone ? `tone-${tone}` : null, className].filter(Boolean).join(" ");
  return <Glyph size={size} className={cls} aria-hidden={title ? undefined : true} title={title} focusable="false" />;
}

export function IconText({
  icon,
  tone,
  size = 14,
  children,
  className,
}: {
  icon: IconName;
  tone?: IconTone;
  size?: number;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <span className={["icon-text", className].filter(Boolean).join(" ")}>
      <GameIcon name={icon} size={size} tone={tone} />
      {children}
    </span>
  );
}
