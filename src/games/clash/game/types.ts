export type Resource = "gold" | "elixir";

export type BuildingType =
  | "townhall"
  | "goldmine"
  | "elixircollector"
  | "goldstorage"
  | "elixirstorage"
  | "barracks"
  | "armycamp"
  | "cannon"
  | "archertower"
  | "wall";

export type BuildingCategory = "core" | "resource" | "storage" | "army" | "defense" | "wall";

export interface Cost {
  gold?: number;
  elixir?: number;
}

export interface BuildingDef {
  type: BuildingType;
  name: string;
  emoji: string;
  category: BuildingCategory;
  /** footprint in grid cells (size x size) */
  size: number;
  maxLevel: number;
  /** town hall level required to build / unlock at given count */
  requiredTh: number;
  /** how many of this building you may own at each town hall level (index = th level) */
  limitByTh: number[];
  cost: (level: number) => Cost;
  /** seconds to build / upgrade to `level` */
  buildTime: (level: number) => number;
  production?: {
    resource: Resource;
    /** resources produced per minute at `level` */
    perMin: (level: number) => number;
    /** max the building can hold before it must be collected */
    cap: (level: number) => number;
  };
  storage?: {
    resource: Resource;
    capacity: (level: number) => number;
  };
  defense?: {
    hp: (level: number) => number;
    dps: (level: number) => number;
    range: number;
  };
  /** army camp housing space contributed */
  housing?: (level: number) => number;
  /** base hitpoints for non-defensive buildings (used as battle targets) */
  hp?: (level: number) => number;
}

export interface PlacedBuilding {
  id: string;
  type: BuildingType;
  level: number;
  x: number;
  y: number;
  /** epoch ms when an in-progress build/upgrade finishes; undefined = idle */
  upgradeDoneAt?: number;
  /** level the building becomes once the current construction completes */
  pendingLevel?: number;
  /** for resource buildings: epoch ms of last production accounting */
  lastCollect?: number;
  /** for resource buildings: uncollected resources waiting in the building */
  stored?: number;
}

export type TroopType = "barbarian" | "archer" | "giant";

export interface TroopDef {
  type: TroopType;
  name: string;
  emoji: string;
  cost: Cost;
  housing: number;
  trainTime: number;
  hp: number;
  dps: number;
  /** tiles per second */
  speed: number;
  range: number;
  /** prefers defenses (giant) vs nearest (others) */
  prefersDefense: boolean;
}

export interface GameState {
  gold: number;
  elixir: number;
  gems: number;
  trophies: number;
  buildings: PlacedBuilding[];
  /** trained troops ready in the army camp, keyed by type */
  army: Record<TroopType, number>;
  lastSaved: number;
}
