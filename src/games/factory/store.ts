import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  addLog,
  canPlaceTool,
  nextBuildGoal,
  placeAt,
  tickN,
  throughputPerSec,
  toggleMinerMode,
} from "./logic";
import {
  type Cell,
  type FactoryState,
  type PlacementTool,
  cloneCell,
  initialFactoryState,
} from "./types";

interface FactoryStore extends FactoryState {
  tool: PlacementTool;
  selected: { x: number; y: number } | null;
  hover: { x: number; y: number } | null;
  clock: number;
  setTool: (tool: PlacementTool) => void;
  setHover: (cell: { x: number; y: number } | null) => void;
  selectCell: (x: number, y: number) => void;
  place: (x: number, y: number) => boolean;
  toggleMiner: (x: number, y: number) => void;
  tick: (n?: number) => void;
  reset: () => void;
}

function snapshotGrid(grid: Cell[][]): Cell[][] {
  return grid.map((row) => row.map(cloneCell));
}

export const useFactory = create<FactoryStore>()(
  persist(
    (set, get) => ({
      ...initialFactoryState(),
      tool: "miner",
      selected: null,
      hover: null,
      clock: 0,
      setTool: (tool) => {
        const state = get();
        if (state.tool === tool) return;
        const next = { ...state, tool, grid: snapshotGrid(state.grid) };
        if (tool !== "none") addLog(next, `${labelFor(tool)} in hand.`);
        set({ tool: next.tool, log: next.log });
      },
      setHover: (hover) => set({ hover }),
      selectCell: (x, y) => set({ selected: { x, y } }),
      place: (x, y) => {
        const state = get();
        const draft: FactoryState = {
          ...state,
          grid: snapshotGrid(state.grid),
          producedCount: [...state.producedCount],
          log: [...state.log],
          recentExportTicks: [...state.recentExportTicks],
        };
        const result = placeAt(draft, state.tool, x, y);
        if (!result.ok) {
          set({ log: draft.log, money: draft.money });
          return false;
        }
        set({
          grid: draft.grid,
          money: draft.money,
          log: draft.log,
          selected: { x, y },
        });
        return true;
      },
      toggleMiner: (x, y) => {
        const state = get();
        const draft: FactoryState = {
          ...state,
          grid: snapshotGrid(state.grid),
          log: [...state.log],
        };
        if (toggleMinerMode(draft, x, y)) {
          set({ grid: draft.grid, log: draft.log });
        }
      },
      tick: (n = 1) => {
        const state = get();
        const draft: FactoryState = {
          ...state,
          grid: snapshotGrid(state.grid),
          producedCount: [...state.producedCount],
          log: [...state.log],
          recentExportTicks: [...state.recentExportTicks],
        };
        tickN(draft, n);
        set({
          grid: draft.grid,
          money: draft.money,
          totalExported: draft.totalExported,
          producedCount: draft.producedCount,
          log: draft.log,
          exportFlash: draft.exportFlash,
          lastExportValue: draft.lastExportValue,
          totalMoneyEarned: draft.totalMoneyEarned,
          totalTicks: draft.totalTicks,
          recentExportTicks: draft.recentExportTicks,
          animFrame: draft.animFrame,
          clock: state.clock + 1,
        });
      },
      reset: () =>
        set({
          ...initialFactoryState(),
          tool: "miner",
          selected: null,
          hover: null,
          clock: 0,
        }),
    }),
    {
      name: "tiny-foundry-v1",
      partialize: (s) => ({
        grid: s.grid,
        money: s.money,
        totalExported: s.totalExported,
        producedCount: s.producedCount,
        totalMoneyEarned: s.totalMoneyEarned,
        totalTicks: s.totalTicks,
        recentExportTicks: s.recentExportTicks,
        log: s.log.slice(-12),
      }),
    },
  ),
);

function labelFor(tool: PlacementTool): string {
  switch (tool) {
    case "miner":
      return "Miner";
    case "smelter":
      return "Smelter";
    case "assembler":
      return "Press";
    case "exporter":
      return "Dock";
    case "fabricator":
      return "Bench";
    case "belt":
      return "Belt";
    case "delete":
      return "Scrap";
    case "none":
      return "Look";
  }
}

export function factoryThroughput(): number {
  const s = useFactory.getState();
  return throughputPerSec(s.recentExportTicks, s.totalTicks);
}

export function factoryGoal(): string {
  return nextBuildGoal(useFactory.getState());
}

export function factoryCanPlace(x: number, y: number): boolean {
  const s = useFactory.getState();
  return canPlaceTool(s, s.tool, x, y);
}
