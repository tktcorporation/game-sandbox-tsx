export const ELEMENTS = ["fire", "water", "grass", "earth", "light", "dark"] as const;
export type Element = (typeof ELEMENTS)[number];

export const SHAPES = [
  "frog",
  "stone",
  "cat",
  "bird",
  "blob",
  "bug",
  "fish",
  "shroom",
  "star",
  "drake",
  "ghost",
  "sweet",
] as const;
export type Shape = (typeof SHAPES)[number];

export const GENERA = [
  "frog",
  "stone",
  "cat",
  "bird",
  "blob",
  "bug",
  "fish",
  "shroom",
  "star",
  "drake",
  "ghost",
  "sweet",
] as const;
export type Genus = (typeof GENERA)[number];

export type Rarity = 1 | 2 | 3 | 4;
export type Role = "tank" | "dps" | "support";
export type Stage = 0 | 1 | 2 | 3;
export type PartySlot = 0 | 1 | 2;

export interface Species {
  id: string;
  name: string;
  genus: Genus;
  element: Element;
  rarity: Rarity;
  shape: Shape;
  hue: number;
  sat: number;
  lit: number;
  role: Role;
  baseHp: number;
  baseAtk: number;
  blurb: string;
  evoNames: [string, string, string, string];
}

export interface OwnedTata {
  uid: string;
  speciesId: string;
  stage: Stage;
  shiny: boolean;
  xp: number;
  bond: number;
  power: number;
  lastPetAt: number;
  partySlot: PartySlot | null;
}

export const FURNITURE_IDS = ["nest", "pool", "snack", "lantern", "garden", "bounce"] as const;
export type FurnitureId = (typeof FURNITURE_IDS)[number];

export interface FurnitureDef {
  id: FurnitureId;
  name: string;
  w: number;
  h: number;
  scrap: number;
  blurb: string;
}

export interface PlacedFurniture {
  id: string;
  type: FurnitureId;
  x: number;
  y: number;
}

export interface TataGameState {
  berries: number;
  shards: number;
  scrap: number;
  stamina: number;
  staminaAt: number;
  started: boolean;
  tatas: OwnedTata[];
  furniture: PlacedFurniture[];
  seen: string[];
  waveBest: number;
  nestAt: number;
}

export const YARD_W = 8;
export const YARD_H = 5;

export const STAMINA_MAX = 8;
export const STAMINA_MS = 9000;
export const PARTY_SIZE = 3;
export const POWER_MAX = 8;
export const STAGE_XP: Record<Stage, number> = { 0: 12, 1: 28, 2: 56, 3: 0 };
export const FEED_COST = 3;
export const FEED_XP = 5;
export const POWER_COST = 4;
export const PET_COOLDOWN_MS = 16000;
export const BERRY_CAP = 999;
export const SHARD_CAP = 999;
export const SCRAP_CAP = 99;
