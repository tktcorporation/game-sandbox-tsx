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
import { isToolUnlocked, unlockHint } from "./progress";
import {
  type Cell,
  type FactoryState,
  type ItemKind,
  type PlacementTool,
  cloneCell,
  initialFactoryState,
} from "./types";

interface FactoryStore extends FactoryState {
  tool: PlacementTool;
  selected: { x: number; y: number } | null;
  hover: { x: number; y: number } | null;
  focusItem: ItemKind | null;
  clock: number;
  setTool: (tool: PlacementTool) => void;
  tryTool: (tool: PlacementTool) => boolean;
  setHover: (cell: { x: number; y: number } | null) => void;
  setFocusItem: (item: ItemKind | null) => void;
  selectCell: (x: number, y: number) => void;
  place: (x: number, y: number, from?: { x: number; y: number }) => boolean;
  toggleMiner: (x: number, y: number) => void;
  tick: (n?: number) => void;
  reset: () => void;
  note: (text: string) => void;
}

function snapshotGrid(grid: Cell[][]): Cell[][] {
  return grid.map((row) => row.map(cloneCell));
}

function draftOf(state: FactoryState): FactoryState {
  return {
    ...state,
    grid: snapshotGrid(state.grid),
    producedCount: [...state.producedCount],
    log: [...state.log],
    recentExportTicks: [...state.recentExportTicks],
    unlocked: [...state.unlocked],
  };
}

export const useFactory = create<FactoryStore>()(
  persist(
    (set, get) => ({
      ...initialFactoryState(),
      tool: "miner",
      selected: null,
      hover: null,
      focusItem: null,
      clock: 0,
      setTool: (tool) => {
        const state = get();
        if (state.tool === tool) return;
        const next = { ...state, tool, grid: snapshotGrid(state.grid) };
        if (tool !== "none") addLog(next, `${labelFor(tool)} in hand.`);
        set({ tool: next.tool, log: next.log });
      },
      tryTool: (tool) => {
        const state = get();
        if (!isToolUnlocked(state, tool)) {
          const log = [...state.log, unlockHint(tool)];
          if (log.length > 30) log.shift();
          set({ log });
          return false;
        }
        if (state.tool === tool) return true;
        const next = { ...state, tool, grid: snapshotGrid(state.grid) };
        if (tool !== "none") addLog(next, `${labelFor(tool)} in hand.`);
        set({ tool: next.tool, log: next.log });
        return true;
      },
      setHover: (hover) => set({ hover }),
      setFocusItem: (focusItem) => set({ focusItem }),
      selectCell: (x, y) => set({ selected: { x, y } }),
      note: (text) => {
        const log = [...get().log, text];
        if (log.length > 30) log.shift();
        set({ log });
      },
      place: (x, y, from) => {
        const state = get();
        const draft = draftOf(state);
        const result = placeAt(draft, state.tool, x, y, from);
        if (!result.ok) {
          set({ log: draft.log, money: draft.money });
          return false;
        }
        const next: {
          grid: Cell[][];
          money: number;
          log: string[];
          selected: { x: number; y: number };
          tool?: PlacementTool;
        } = {
          grid: draft.grid,
          money: draft.money,
          log: draft.log,
          selected: { x, y },
        };
        if (state.tool === "miner") {
          const hasBelt = draft.grid.some((row) => row.some((c) => c.t === "belt"));
          if (!hasBelt) {
            addLog(draft, "Belt in hand. Paint the yellow cells on the rim.");
            next.tool = "belt";
            next.log = draft.log;
          }
        }
        set(next);
        return true;
      },
      toggleMiner: (x, y) => {
        const state = get();
        const draft = draftOf(state);
        if (toggleMinerMode(draft, x, y)) {
          set({ grid: draft.grid, log: draft.log });
        } else {
          set({ log: draft.log });
        }
      },
      tick: (n = 1) => {
        const state = get();
        const draft = draftOf(state);
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
          unlocked: draft.unlocked,
          copperUnlocked: draft.copperUnlocked,
          contractsCompleted: draft.contractsCompleted,
          contractProgress: draft.contractProgress,
          honorFlash: draft.honorFlash,
          lastHonor: draft.lastHonor,
          clock: state.clock + 1,
        });
      },
      reset: () =>
        set({
          ...initialFactoryState(),
          tool: "miner",
          selected: null,
          hover: null,
          focusItem: null,
          clock: 0,
        }),
    }),
    {
      name: "tiny-foundry-v2",
      partialize: (s) => ({
        grid: s.grid,
        money: s.money,
        totalExported: s.totalExported,
        producedCount: s.producedCount,
        totalMoneyEarned: s.totalMoneyEarned,
        totalTicks: s.totalTicks,
        recentExportTicks: s.recentExportTicks,
        log: s.log.slice(-12),
        unlocked: s.unlocked,
        copperUnlocked: s.copperUnlocked,
        contractsCompleted: s.contractsCompleted,
        contractProgress: s.contractProgress,
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<FactoryState>;
        return {
          ...current,
          ...p,
          unlocked: p.unlocked ?? [],
          copperUnlocked: p.copperUnlocked ?? false,
          contractsCompleted: p.contractsCompleted ?? 0,
          contractProgress: p.contractProgress ?? 0,
        };
      },
    },
  ),
);

function labelFor(tool: PlacementTool): string {
  switch (tool) {
    case "miner":
      return "Miner";
    case "smelter":
      return "Furnace";
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
