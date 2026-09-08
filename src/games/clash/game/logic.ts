import { BUILDINGS, GRID_H, GRID_W, TROOPS } from "./buildings";
import type {
  BuildingType,
  Cost,
  GameState,
  PlacedBuilding,
  Resource,
  TroopType,
} from "./types";

export const now = () => Date.now();

export function townHallLevel(buildings: PlacedBuilding[]): number {
  const th = buildings.find((b) => b.type === "townhall");
  return th ? th.level : 1;
}

/** total storage capacity for a resource (town hall provides a base too) */
export function capacityOf(buildings: PlacedBuilding[], resource: Resource): number {
  const base = 1000;
  return buildings.reduce((sum, b) => {
    const def = BUILDINGS[b.type];
    if (def.storage && def.storage.resource === resource && !b.upgradeDoneAt) {
      return sum + def.storage.capacity(b.level);
    }
    return sum;
  }, base);
}

/** total army housing space and how much is occupied by the trained army */
export function armyHousing(state: GameState): { used: number; total: number } {
  const total = state.buildings.reduce((sum, b) => {
    const def = BUILDINGS[b.type];
    if (def.housing && !b.upgradeDoneAt) return sum + def.housing(b.level);
    return sum;
  }, 0);
  const used = (Object.keys(state.army) as TroopType[]).reduce(
    (sum, t) => sum + state.army[t] * TROOPS[t].housing,
    0,
  );
  return { used, total };
}

export function countOfType(buildings: PlacedBuilding[], type: BuildingType): number {
  return buildings.filter((b) => b.type === type).length;
}

/** how many of a building type the player is allowed at the current town hall level */
export function limitForType(buildings: PlacedBuilding[], type: BuildingType): number {
  const th = townHallLevel(buildings);
  const def = BUILDINGS[type];
  return def.limitByTh[Math.min(th, def.limitByTh.length - 1)] ?? 0;
}

export function canAfford(state: GameState, cost: Cost): boolean {
  return (
    state.gold >= (cost.gold ?? 0) &&
    state.elixir >= (cost.elixir ?? 0) &&
    state.gems >= 0
  );
}

export function payCost<T extends GameState>(state: T, cost: Cost): T {
  return {
    ...state,
    gold: state.gold - (cost.gold ?? 0),
    elixir: state.elixir - (cost.elixir ?? 0),
  };
}

/** does a `size`x`size` footprint at (x,y) fit on the grid without overlapping anything? */
export function canPlace(
  buildings: PlacedBuilding[],
  x: number,
  y: number,
  size: number,
  ignoreId?: string,
): boolean {
  if (x < 0 || y < 0 || x + size > GRID_W || y + size > GRID_H) return false;
  for (const b of buildings) {
    if (b.id === ignoreId) continue;
    const bs = BUILDINGS[b.type].size;
    const overlap =
      x < b.x + bs && x + size > b.x && y < b.y + bs && y + size > b.y;
    if (overlap) return false;
  }
  return true;
}

/** find the first free cell that fits a footprint of `size`, scanning row by row */
export function findFreeCell(
  buildings: PlacedBuilding[],
  size: number,
): { x: number; y: number } | null {
  for (let y = 0; y <= GRID_H - size; y++) {
    for (let x = 0; x <= GRID_W - size; x++) {
      if (canPlace(buildings, x, y, size)) return { x, y };
    }
  }
  return null;
}

/** accrued (uncollected) resources for a producing building, capped */
export function accruedFor(b: PlacedBuilding, atMs: number): number {
  const def = BUILDINGS[b.type];
  if (!def.production || b.upgradeDoneAt) return b.stored ?? 0;
  const since = (atMs - (b.lastCollect ?? atMs)) / 60000; // minutes
  const produced = since * def.production.perMin(b.level);
  const cap = def.production.cap(b.level);
  return Math.min(cap, (b.stored ?? 0) + produced);
}

export function formatNumber(n: number): string {
  const v = Math.floor(n);
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (v >= 1000) return (v / 1000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(v);
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${s}s`;
}

let idCounter = 0;
export function newId(): string {
  idCounter += 1;
  return `b${now().toString(36)}_${idCounter}`;
}
