export const GRID_W = 40;
export const GRID_H = 30;
export const TICKS_PER_SEC = 10;
export const TICK_MS = 1000 / TICKS_PER_SEC;
export const TRAIL_TICKS = 3;
export const EXPORT_FLASH_TICKS = 12;
export const THROUGHPUT_WINDOW_TICKS = 100;
export const BELT_COST = 2;
export const STARTING_MONEY = 50;
export const MAX_BUFFER = 5;

export type Direction = "up" | "down" | "left" | "right";

export const DIRECTIONS: Direction[] = ["up", "down", "left", "right"];

export function dirDelta(dir: Direction): [number, number] {
  switch (dir) {
    case "up":
      return [0, -1];
    case "down":
      return [0, 1];
    case "left":
      return [-1, 0];
    case "right":
      return [1, 0];
  }
}

export function dirOpposite(dir: Direction): Direction {
  switch (dir) {
    case "up":
      return "down";
    case "down":
      return "up";
    case "left":
      return "right";
    case "right":
      return "left";
  }
}

export function dirFromTo(fromX: number, fromY: number, toX: number, toY: number): Direction {
  if (toX > fromX) return "right";
  if (toX < fromX) return "left";
  if (toY > fromY) return "down";
  return "up";
}

export type ItemKind =
  | "ironOre"
  | "ironPlate"
  | "gear"
  | "copperOre"
  | "copperPlate"
  | "circuit";

export const ITEM_ORDER: ItemKind[] = [
  "ironOre",
  "ironPlate",
  "gear",
  "copperOre",
  "copperPlate",
  "circuit",
];

export function itemIndex(item: ItemKind): number {
  return ITEM_ORDER.indexOf(item);
}

export type MachineKind = "miner" | "smelter" | "assembler" | "exporter" | "fabricator";

export type MinerMode = "iron" | "copper";

export type PlacementTool = "none" | MachineKind | "belt" | "delete";

export interface Machine {
  kind: MachineKind;
  inputBuffer: ItemKind[];
  outputBuffer: ItemKind[];
  progress: number;
  maxBuffer: number;
  mode: MinerMode;
  statProduced: number;
  statRevenue: number;
  statActiveTicks: number;
  statTotalTicks: number;
}

export interface Belt {
  item: ItemKind | null;
  itemFrom: Direction | null;
  trailItem: ItemKind | null;
  trailTicks: number;
  facing: Direction;
}

export type Cell =
  | { t: "empty" }
  | { t: "machine"; machine: Machine }
  | { t: "part"; ax: number; ay: number }
  | { t: "belt"; belt: Belt };

export function emptyGrid(): Cell[][] {
  return Array.from({ length: GRID_H }, () =>
    Array.from({ length: GRID_W }, (): Cell => ({ t: "empty" })),
  );
}

export function newMachine(kind: MachineKind): Machine {
  return {
    kind,
    inputBuffer: [],
    outputBuffer: [],
    progress: 0,
    maxBuffer: MAX_BUFFER,
    mode: "iron",
    statProduced: 0,
    statRevenue: 0,
    statActiveTicks: 0,
    statTotalTicks: 0,
  };
}

export function newBelt(facing: Direction = "right"): Belt {
  return { item: null, itemFrom: null, trailItem: null, trailTicks: 0, facing };
}

export function machineCost(kind: MachineKind): number {
  switch (kind) {
    case "miner":
      return 10;
    case "smelter":
      return 25;
    case "assembler":
      return 50;
    case "exporter":
      return 15;
    case "fabricator":
      return 75;
  }
}

export function recipeTime(kind: MachineKind): number {
  switch (kind) {
    case "miner":
      return 10;
    case "smelter":
      return 15;
    case "assembler":
      return 20;
    case "exporter":
      return 5;
    case "fabricator":
      return 25;
  }
}

export function exportValue(item: ItemKind): number {
  switch (item) {
    case "ironOre":
      return 1;
    case "ironPlate":
      return 5;
    case "gear":
      return 20;
    case "copperOre":
      return 2;
    case "copperPlate":
      return 8;
    case "circuit":
      return 50;
  }
}

export function machineName(kind: MachineKind): string {
  switch (kind) {
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
  }
}

export function itemLabel(item: ItemKind): string {
  switch (item) {
    case "ironOre":
      return "Iron ore";
    case "ironPlate":
      return "Iron plate";
    case "gear":
      return "Gear";
    case "copperOre":
      return "Copper ore";
    case "copperPlate":
      return "Copper plate";
    case "circuit":
      return "Circuit";
  }
}

export interface FactoryState {
  grid: Cell[][];
  money: number;
  totalExported: number;
  producedCount: number[];
  log: string[];
  exportFlash: number;
  lastExportValue: number;
  totalMoneyEarned: number;
  totalTicks: number;
  recentExportTicks: number[];
  animFrame: number;
  unlocked: MachineKind[];
  copperUnlocked: boolean;
  contractsCompleted: number;
  contractProgress: number;
  honorFlash: number;
  lastHonor: string;
}

export function initialFactoryState(): FactoryState {
  return {
    grid: emptyGrid(),
    money: STARTING_MONEY,
    totalExported: 0,
    producedCount: [0, 0, 0, 0, 0, 0],
    log: ["Ticket on the board. Plant a miner, belt, dock."],
    exportFlash: 0,
    lastExportValue: 0,
    totalMoneyEarned: 0,
    totalTicks: 0,
    recentExportTicks: [],
    animFrame: 0,
    unlocked: [],
    copperUnlocked: false,
    contractsCompleted: 0,
    contractProgress: 0,
    honorFlash: 0,
    lastHonor: "",
  };
}

export function cloneCell(cell: Cell): Cell {
  switch (cell.t) {
    case "empty":
      return { t: "empty" };
    case "part":
      return { t: "part", ax: cell.ax, ay: cell.ay };
    case "belt":
      return {
        t: "belt",
        belt: { ...cell.belt, facing: cell.belt.facing ?? "right" },
      };
    case "machine":
      return {
        t: "machine",
        machine: {
          ...cell.machine,
          inputBuffer: [...cell.machine.inputBuffer],
          outputBuffer: [...cell.machine.outputBuffer],
        },
      };
  }
}

export function inBounds(x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < GRID_W && y < GRID_H;
}

export function anchorOf(grid: Cell[][], x: number, y: number): [number, number] | null {
  const cell = grid[y]?.[x];
  if (!cell) return null;
  if (cell.t === "machine") return [x, y];
  if (cell.t === "part") return [cell.ax, cell.ay];
  return null;
}

export function machineAt(grid: Cell[][], ax: number, ay: number): Machine | null {
  const cell = grid[ay]?.[ax];
  return cell?.t === "machine" ? cell.machine : null;
}

export function machineAtCell(grid: Cell[][], x: number, y: number): Machine | null {
  const a = anchorOf(grid, x, y);
  return a ? machineAt(grid, a[0], a[1]) : null;
}
