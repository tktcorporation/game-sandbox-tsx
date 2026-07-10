import { create } from "zustand";
import { persist } from "zustand/middleware";
import { BUILDINGS, TROOPS } from "./buildings";
import {
  accruedFor,
  armyHousing,
  canAfford,
  canPlace,
  capacityOf,
  countOfType,
  findFreeCell,
  limitForType,
  newId,
  now,
  payCost,
  townHallLevel,
} from "./logic";
import type { BuildingType, GameState, PlacedBuilding, TroopType } from "./types";

export interface BattleResult {
  loot: { gold: number; elixir: number };
  trophies: number;
  armyUsed: Record<TroopType, number>;
}

interface Store extends GameState {
  /** drives UI re-renders for timers/production; bumped by the game loop */
  clock: number;

  placeBuilding: (type: BuildingType) => { ok: boolean; reason?: string };
  moveBuilding: (id: string, x: number, y: number) => boolean;
  upgradeBuilding: (id: string) => { ok: boolean; reason?: string };
  collect: (id: string) => void;
  /** collect every producer; returns how much was actually banked */
  collectAll: () => { gold: number; elixir: number };
  trainTroop: (type: TroopType) => { ok: boolean; reason?: string };
  /** spend gems to complete a running construction instantly */
  finishNow: (id: string) => { ok: boolean; reason?: string };
  applyBattleResult: (r: BattleResult) => void;
  finishConstructions: () => void;
  tick: () => void;
  reset: () => void;
  grantGems: (n: number) => void;
}

function createInitialState(): GameState {
  const buildings: PlacedBuilding[] = [];
  // hand-placed starter village: town hall centred, storages behind it,
  // producers on the flanks, cannon guarding the front approach.
  const place = (type: BuildingType, x: number, y: number) => {
    const def = BUILDINGS[type];
    const cell = canPlace(buildings, x, y, def.size) ? { x, y } : findFreeCell(buildings, def.size);
    if (!cell) return;
    buildings.push({
      id: newId(),
      type,
      level: 1,
      x: cell.x,
      y: cell.y,
      lastCollect: now(),
      stored: 0,
    });
  };
  place("townhall", 3, 6);
  place("goldstorage", 2, 3);
  place("elixirstorage", 6, 3);
  place("goldmine", 0, 7);
  place("elixircollector", 8, 7);
  place("cannon", 4, 10);
  place("barracks", 1, 11);
  place("armycamp", 7, 11);

  return {
    gold: 600,
    elixir: 600,
    gems: 250,
    trophies: 0,
    buildings,
    army: { barbarian: 0, archer: 0, giant: 0 },
    lastSaved: now(),
  };
}

export const useGame = create<Store>()(
  persist(
    (set, get) => ({
      ...createInitialState(),
      clock: now(),

      placeBuilding: (type) => {
        const state = get();
        const def = BUILDINGS[type];
        const th = townHallLevel(state.buildings);
        if (def.requiredTh > th) return { ok: false, reason: `Requires Town Hall ${def.requiredTh}` };
        if (countOfType(state.buildings, type) >= limitForType(state.buildings, type)) {
          return { ok: false, reason: "Build limit reached for this Town Hall level" };
        }
        const cost = def.cost(1);
        if (!canAfford(state, cost)) return { ok: false, reason: "Not enough resources" };
        const cell = findFreeCell(state.buildings, def.size);
        if (!cell) return { ok: false, reason: "No room left in the village" };

        const b: PlacedBuilding = {
          id: newId(),
          type,
          level: 1,
          pendingLevel: 1,
          x: cell.x,
          y: cell.y,
          lastCollect: now(),
          stored: 0,
          upgradeDoneAt: now() + def.buildTime(1) * 1000,
        };
        set({ ...payCost(state, cost), buildings: [...state.buildings, b] });
        return { ok: true };
      },

      moveBuilding: (id, x, y) => {
        const state = get();
        const b = state.buildings.find((bb) => bb.id === id);
        if (!b) return false;
        const def = BUILDINGS[b.type];
        if (!canPlace(state.buildings, x, y, def.size, id)) return false;
        set({
          buildings: state.buildings.map((bb) => (bb.id === id ? { ...bb, x, y } : bb)),
        });
        return true;
      },

      upgradeBuilding: (id) => {
        const state = get();
        const b = state.buildings.find((bb) => bb.id === id);
        if (!b) return { ok: false, reason: "Not found" };
        if (b.upgradeDoneAt) return { ok: false, reason: "Already under construction" };
        const def = BUILDINGS[b.type];
        if (b.level >= def.maxLevel) return { ok: false, reason: "Max level reached" };
        const next = b.level + 1;
        // every building except the town hall is gated by town hall level
        if (b.type !== "townhall") {
          const th = townHallLevel(state.buildings);
          if (next > th) return { ok: false, reason: `Upgrade Town Hall first` };
        }
        const cost = def.cost(next);
        if (!canAfford(state, cost)) return { ok: false, reason: "Not enough resources" };

        // collect pending production before upgrading so it isn't lost
        const collected = collectInto(state, b).state;
        set({
          ...payCost(collected, cost),
          buildings: collected.buildings.map((bb) =>
            bb.id === id
              ? {
                  ...bb,
                  pendingLevel: next,
                  upgradeDoneAt: now() + def.buildTime(next) * 1000,
                  stored: 0,
                  lastCollect: now(),
                }
              : bb,
          ),
        });
        return { ok: true };
      },

      collect: (id) => {
        const state = get();
        const b = state.buildings.find((bb) => bb.id === id);
        if (!b) return;
        set(collectInto(state, b).state);
      },

      collectAll: () => {
        let state = get();
        const total = { gold: 0, elixir: 0 };
        for (const b of state.buildings) {
          const production = BUILDINGS[b.type].production;
          if (production) {
            const cur = state.buildings.find((x) => x.id === b.id)!;
            const r = collectInto(state, cur);
            state = r.state;
            total[production.resource] += r.amount;
          }
        }
        set(state);
        return total;
      },

      trainTroop: (type) => {
        const state = get();
        const troop = TROOPS[type];
        if (!canAfford(state, troop.cost)) return { ok: false, reason: "Not enough elixir" };
        const housing = armyHousing(state);
        if (housing.used + troop.housing > housing.total) {
          return { ok: false, reason: "Army camps are full" };
        }
        set({
          ...payCost(state, troop.cost),
          army: { ...state.army, [type]: state.army[type] + 1 },
        });
        return { ok: true };
      },

      finishNow: (id) => {
        const state = get();
        const b = state.buildings.find((bb) => bb.id === id);
        if (!b || !b.upgradeDoneAt) return { ok: false, reason: "Nothing to finish" };
        const cost = gemCostForFinish(b.upgradeDoneAt);
        if (state.gems < cost) return { ok: false, reason: "Not enough gems" };
        set({
          gems: state.gems - cost,
          buildings: state.buildings.map((bb) =>
            bb.id === id
              ? {
                  ...bb,
                  level: bb.pendingLevel ?? bb.level,
                  pendingLevel: undefined,
                  upgradeDoneAt: undefined,
                  lastCollect: now(),
                }
              : bb,
          ),
        });
        return { ok: true };
      },

      applyBattleResult: (r) => {
        const state = get();
        const goldCap = capacityOf(state.buildings, "gold");
        const elixirCap = capacityOf(state.buildings, "elixir");
        const army = { ...state.army };
        for (const t of Object.keys(r.armyUsed) as TroopType[]) {
          army[t] = Math.max(0, army[t] - r.armyUsed[t]);
        }
        set({
          gold: Math.min(goldCap, state.gold + r.loot.gold),
          elixir: Math.min(elixirCap, state.elixir + r.loot.elixir),
          trophies: Math.max(0, state.trophies + r.trophies),
          army,
        });
      },

      finishConstructions: () => {
        const state = get();
        const t = now();
        let changed = false;
        const buildings = state.buildings.map((b) => {
          if (b.upgradeDoneAt && b.upgradeDoneAt <= t) {
            changed = true;
            return {
              ...b,
              level: b.pendingLevel ?? b.level,
              pendingLevel: undefined,
              upgradeDoneAt: undefined,
              lastCollect: t,
            };
          }
          return b;
        });
        if (changed) set({ buildings });
      },

      tick: () => {
        get().finishConstructions();
        set({ clock: now() });
      },

      grantGems: (n) => set({ gems: get().gems + n }),

      reset: () => set({ ...createInitialState(), clock: now() }),
    }),
    {
      name: "clash-of-sandboxes-v1",
      partialize: (s) => ({
        gold: s.gold,
        elixir: s.elixir,
        gems: s.gems,
        trophies: s.trophies,
        buildings: s.buildings,
        army: s.army,
        lastSaved: s.lastSaved,
      }),
    },
  ),
);

/** gem price to skip the remainder of a construction: 1 gem per started minute */
export function gemCostForFinish(doneAt: number): number {
  return Math.max(1, Math.ceil((doneAt - now()) / 60000));
}

function collectInto<T extends GameState>(state: T, b: PlacedBuilding): { state: T; amount: number } {
  const def = BUILDINGS[b.type];
  if (!def.production || b.upgradeDoneAt) return { state, amount: 0 };
  const amount = accruedFor(b, now());
  const resource = def.production.resource;
  const cap = capacityOf(state.buildings, resource);
  const current = state[resource];
  const added = Math.min(amount, Math.max(0, cap - current));
  const newState: T = {
    ...state,
    [resource]: current + added,
    buildings: state.buildings.map((bb) =>
      bb.id === b.id ? { ...bb, stored: 0, lastCollect: now() } : bb,
    ),
  };
  return { state: newState, amount: added };
}
