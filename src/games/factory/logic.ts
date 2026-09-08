import { creditOrder, isToolUnlocked, unlockHint } from "./progress";
import { smeltProduct } from "./recipes";
import {
  BELT_COST,
  DIRECTIONS,
  EXPORT_FLASH_TICKS,
  GRID_H,
  GRID_W,
  THROUGHPUT_WINDOW_TICKS,
  TRAIL_TICKS,
  type Cell,
  type Direction,
  type FactoryState,
  type ItemKind,
  type MachineKind,
  type PlacementTool,
  anchorOf,
  dirDelta,
  dirFromTo,
  dirOpposite,
  exportValue,
  inBounds,
  itemIndex,
  machineAtCell,
  machineCost,
  machineName,
  newBelt,
  newMachine,
  recipeTime,
} from "./types";

export function tick(state: FactoryState): void {
  state.totalTicks += 1;
  decayTrails(state);
  pruneExportHistory(state);
  tickMachines(state);
  tickBelts(state);
  pushMachineOutput(state);
}

export function tickN(state: FactoryState, n: number): void {
  for (let i = 0; i < n; i++) tick(state);
  state.animFrame = (state.animFrame + n) >>> 0;
  if (state.exportFlash > 0) state.exportFlash = Math.max(0, state.exportFlash - n);
  if (state.honorFlash > 0) state.honorFlash = Math.max(0, state.honorFlash - n);
}

export { floorHint as nextBuildGoal } from "./progress";

export function addLog(state: FactoryState, text: string): void {
  state.log.push(text);
  if (state.log.length > 30) state.log.shift();
}

export function throughputPerSec(exportTicks: number[], currentTick: number): number {
  if (currentTick === 0) return 0;
  const window = Math.min(THROUGHPUT_WINDOW_TICKS, currentTick);
  const windowStart = currentTick - window;
  const count = exportTicks.filter((t) => t > windowStart && t <= currentTick).length;
  return count / (window / 10);
}

function decayTrails(state: FactoryState): void {
  for (const row of state.grid) {
    for (const cell of row) {
      if (cell.t !== "belt") continue;
      if (cell.belt.trailTicks > 0) {
        cell.belt.trailTicks -= 1;
        if (cell.belt.trailTicks === 0) cell.belt.trailItem = null;
      }
    }
  }
}

function pruneExportHistory(state: FactoryState): void {
  const now = state.totalTicks;
  state.recentExportTicks = state.recentExportTicks.filter((t) => t + THROUGHPUT_WINDOW_TICKS > now);
}

function tickMachines(state: FactoryState): void {
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      const cell = state.grid[y][x];
      if (cell.t !== "machine") continue;
      const m = cell.machine;
      const kind = m.kind;
      const wasActive = m.progress > 0;
      const outputFull = m.outputBuffer.length >= m.maxBuffer;
      const inputEmpty = m.inputBuffer.length === 0;

      switch (kind) {
        case "miner": {
          if (outputFull) {
            m.statTotalTicks += 1;
            continue;
          }
          const next = m.progress + 1;
          if (next >= recipeTime(kind)) {
            m.progress = 0;
            const item: ItemKind = m.mode === "iron" ? "ironOre" : "copperOre";
            m.outputBuffer.push(item);
            m.statProduced += 1;
            bumpProduced(state, item);
          } else {
            m.progress = next;
          }
          break;
        }
        case "smelter": {
          if (inputEmpty || outputFull) {
            if (inputEmpty) m.progress = 0;
            m.statTotalTicks += 1;
            continue;
          }
          const inputItem = m.inputBuffer[0];
          const outputItem = smeltProduct(inputItem);
          if (!outputItem) continue;
          const next = m.progress + 1;
          if (next >= recipeTime(kind)) {
            m.progress = 0;
            m.inputBuffer.shift();
            m.outputBuffer.push(outputItem);
            m.statProduced += 1;
            bumpProduced(state, outputItem);
          } else {
            m.progress = next;
          }
          break;
        }
        case "assembler": {
          if (inputEmpty || outputFull) {
            if (inputEmpty) m.progress = 0;
            m.statTotalTicks += 1;
            continue;
          }
          if (m.inputBuffer[0] !== "ironPlate") {
            m.progress = 0;
            m.statTotalTicks += 1;
            continue;
          }
          const next = m.progress + 1;
          if (next >= recipeTime(kind)) {
            m.progress = 0;
            m.inputBuffer.shift();
            m.outputBuffer.push("gear");
            m.statProduced += 1;
            bumpProduced(state, "gear");
          } else {
            m.progress = next;
          }
          break;
        }
        case "fabricator": {
          if (outputFull) {
            m.statTotalTicks += 1;
            continue;
          }
          const hasIron = m.inputBuffer.includes("ironPlate");
          const hasCopper = m.inputBuffer.includes("copperPlate");
          if (!hasIron || !hasCopper) {
            m.progress = 0;
            m.statTotalTicks += 1;
            continue;
          }
          const next = m.progress + 1;
          if (next >= recipeTime(kind)) {
            m.progress = 0;
            const iPos = m.inputBuffer.indexOf("ironPlate");
            if (iPos >= 0) m.inputBuffer.splice(iPos, 1);
            const cPos = m.inputBuffer.indexOf("copperPlate");
            if (cPos >= 0) m.inputBuffer.splice(cPos, 1);
            m.outputBuffer.push("circuit");
            m.statProduced += 1;
            bumpProduced(state, "circuit");
          } else {
            m.progress = next;
          }
          break;
        }
        case "exporter": {
          if (inputEmpty) {
            m.statTotalTicks += 1;
            continue;
          }
          const next = m.progress + 1;
          if (next >= recipeTime(kind)) {
            m.progress = 0;
            const item = m.inputBuffer.shift()!;
            const value = exportValue(item);
            state.money += value;
            state.totalExported += 1;
            state.totalMoneyEarned += value;
            state.exportFlash = EXPORT_FLASH_TICKS;
            state.lastExportValue = value;
            state.recentExportTicks.push(state.totalTicks);
            m.statProduced += 1;
            m.statRevenue += value;
            creditOrder(state, item);
          } else {
            m.progress = next;
          }
          break;
        }
      }

      m.statTotalTicks += 1;
      if (m.progress > 0 || wasActive) m.statActiveTicks += 1;
    }
  }
}

function bumpProduced(state: FactoryState, item: ItemKind): void {
  state.producedCount[itemIndex(item)] += 1;
}

function preferredDirections(itemFrom: Direction | null, facing: Direction): Direction[] {
  const [p1, p2]: [Direction, Direction] =
    facing === "up" || facing === "down" ? ["right", "left"] : ["down", "up"];
  const dirs = [facing, p1, p2];
  if (!itemFrom) return dirs;
  const filtered = dirs.filter((d) => d !== itemFrom);
  return filtered.length > 0 ? filtered : [facing];
}

function machineAccepts(grid: Cell[][], ax: number, ay: number, item: ItemKind): boolean {
  const cell = grid[ay]?.[ax];
  if (cell?.t !== "machine") return false;
  const m = cell.machine;
  if (m.inputBuffer.length >= m.maxBuffer) return false;
  switch (m.kind) {
    case "miner":
      return false;
    case "exporter":
      return true;
    case "smelter":
      return item === "ironOre" || item === "copperOre";
    case "assembler":
      return item === "ironPlate";
    case "fabricator": {
      if (item !== "ironPlate" && item !== "copperPlate") return false;
      const perType = Math.floor(m.maxBuffer / 2);
      const same = m.inputBuffer.filter((i: ItemKind) => i === item).length;
      return same < perType;
    }
  }
  return false;
}

function sourceDirFromMachine(ax: number, ay: number, bx: number, by: number): Direction | null {
  const isRight = bx >= ax + 2;
  const isLeft = bx < ax;
  const isBelow = by >= ay + 2;
  const isAbove = by < ay;
  if (isRight && !isAbove && !isBelow) return "left";
  if (isLeft && !isAbove && !isBelow) return "right";
  if (isBelow && !isLeft && !isRight) return "up";
  if (isAbove && !isLeft && !isRight) return "down";
  return null;
}

function sourceDirBetween(fromX: number, fromY: number, toX: number, toY: number): Direction {
  if (fromX < toX) return "left";
  if (fromX > toX) return "right";
  if (fromY < toY) return "up";
  return "down";
}

function tickBelts(state: FactoryState): void {
  const machineFeeds: [number, number, number, number][] = [];
  const beltMoves: [number, number, number, number][] = [];

  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      const cell = state.grid[y][x];
      if (cell.t !== "belt" || !cell.belt.item) continue;
      const item = cell.belt.item;
      const directions = preferredDirections(cell.belt.itemFrom, cell.belt.facing ?? "right");
      let fed = false;
      for (const dir of directions) {
        const [dx, dy] = dirDelta(dir);
        const nx = x + dx;
        const ny = y + dy;
        if (!inBounds(nx, ny)) continue;
        const anchor = anchorOf(state.grid, nx, ny);
        if (anchor && machineAccepts(state.grid, anchor[0], anchor[1], item)) {
          machineFeeds.push([x, y, anchor[0], anchor[1]]);
          fed = true;
          break;
        }
      }
      if (fed) continue;
      for (const dir of directions) {
        const [dx, dy] = dirDelta(dir);
        const nx = x + dx;
        const ny = y + dy;
        if (!inBounds(nx, ny)) continue;
        const next = state.grid[ny][nx];
        if (next.t === "belt" && next.belt.item === null) {
          beltMoves.push([x, y, nx, ny]);
          break;
        }
      }
    }
  }

  for (const [bx, by, ax, ay] of machineFeeds) {
    const beltCell = state.grid[by][bx];
    if (beltCell.t !== "belt" || !beltCell.belt.item) continue;
    if (!machineAccepts(state.grid, ax, ay, beltCell.belt.item)) continue;
    const taken = beltCell.belt.item;
    beltCell.belt.item = null;
    beltCell.belt.trailItem = taken;
    beltCell.belt.trailTicks = TRAIL_TICKS;
    const dest = state.grid[ay][ax];
    if (dest.t === "machine") dest.machine.inputBuffer.push(taken);
  }

  const occupied: [number, number][] = [];
  const consumed = new Set(
    machineFeeds
      .filter(([bx, by]) => {
        const c = state.grid[by][bx];
        return c.t === "belt" && c.belt.item === null;
      })
      .map(([bx, by]) => `${bx},${by}`),
  );

  for (const [fx, fy, tx, ty] of beltMoves) {
    if (consumed.has(`${fx},${fy}`)) continue;
    if (occupied.some(([ox, oy]) => ox === tx && oy === ty)) continue;
    const from = state.grid[fy][fx];
    if (from.t !== "belt" || !from.belt.item) continue;
    const item = from.belt.item;
    from.belt.item = null;
    from.belt.trailItem = item;
    from.belt.trailTicks = TRAIL_TICKS;
    const dest = state.grid[ty][tx];
    if (dest.t === "belt") {
      dest.belt.item = item;
      dest.belt.itemFrom = sourceDirBetween(fx, fy, tx, ty);
      occupied.push([tx, ty]);
    }
  }
}

function pushMachineOutput(state: FactoryState): void {
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      const cell = state.grid[y][x];
      if (cell.t !== "machine") continue;
      if (cell.machine.outputBuffer.length > 0 && cell.machine.kind !== "exporter") {
        tryPushToBelt(state, x, y);
      }
    }
  }
}

function tryPushToBelt(state: FactoryState, ax: number, ay: number): void {
  for (const [px, py] of perimeter2x2(ax, ay)) {
    const cell = state.grid[py][px];
    if (cell.t !== "belt" || cell.belt.item !== null) continue;
    if (pointsIntoMachine(px, py, cell.belt.facing, ax, ay)) continue;
    const machineCell = state.grid[ay][ax];
    if (machineCell.t !== "machine" || machineCell.machine.outputBuffer.length === 0) continue;
    const item = machineCell.machine.outputBuffer.shift()!;
    cell.belt.item = item;
    cell.belt.itemFrom = sourceDirFromMachine(ax, ay, px, py);
    return;
  }
}

function pointsIntoMachine(px: number, py: number, facing: Direction, ax: number, ay: number): boolean {
  const [dx, dy] = dirDelta(facing);
  const tx = px + dx;
  const ty = py + dy;
  return tx >= ax && tx < ax + 2 && ty >= ay && ty < ay + 2;
}

function canPlace2x2(state: FactoryState, x: number, y: number): boolean {
  if (x + 1 >= GRID_W || y + 1 >= GRID_H) return false;
  for (let dy = 0; dy < 2; dy++) {
    for (let dx = 0; dx < 2; dx++) {
      if (state.grid[y + dy][x + dx].t !== "empty") return false;
    }
  }
  return true;
}

function place2x2(state: FactoryState, x: number, y: number, kind: MachineKind): void {
  state.grid[y][x] = { t: "machine", machine: newMachine(kind) };
  state.grid[y][x + 1] = { t: "part", ax: x, ay: y };
  state.grid[y + 1][x] = { t: "part", ax: x, ay: y };
  state.grid[y + 1][x + 1] = { t: "part", ax: x, ay: y };
}

function remove2x2(state: FactoryState, ax: number, ay: number): MachineKind | null {
  const cell = state.grid[ay][ax];
  if (cell.t !== "machine") return null;
  const kind = cell.machine.kind;
  for (let dy = 0; dy < 2; dy++) {
    for (let dx = 0; dx < 2; dx++) {
      state.grid[ay + dy][ax + dx] = { t: "empty" };
    }
  }
  return kind;
}

export function canPlaceTool(state: FactoryState, tool: PlacementTool, x: number, y: number): boolean {
  if (!inBounds(x, y)) return false;
  if (tool === "none") return false;
  if (!isToolUnlocked(state, tool)) return false;
  if (tool === "delete") return state.grid[y][x].t !== "empty";
  if (tool === "belt") return state.grid[y][x].t === "empty" && state.money >= BELT_COST;
  return canPlace2x2(state, x, y) && state.money >= machineCost(tool);
}

export function placeAt(
  state: FactoryState,
  tool: PlacementTool,
  x: number,
  y: number,
  from?: { x: number; y: number },
): { ok: boolean; beltAdvance?: Direction } {
  if (!inBounds(x, y)) return { ok: false };
  if (tool === "none") return { ok: false };
  if (tool !== "delete" && !isToolUnlocked(state, tool)) {
    addLog(state, unlockHint(tool));
    return { ok: false };
  }

  if (tool === "delete") {
    const cell = state.grid[y][x];
    if (cell.t === "empty") return { ok: false };
    if (cell.t === "machine" || cell.t === "part") {
      const anchor = anchorOf(state.grid, x, y);
      if (!anchor) return { ok: false };
      const kind = remove2x2(state, anchor[0], anchor[1]);
      if (!kind) return { ok: false };
      const refund = Math.floor(machineCost(kind) / 2);
      state.money += refund;
      addLog(state, `Scrapped ${machineName(kind)} (+$${refund})`);
      return { ok: true };
    }
    if (cell.t === "belt") {
      state.grid[y][x] = { t: "empty" };
      state.money += 1;
      addLog(state, "Pulled a belt (+$1)");
      return { ok: true };
    }
    return { ok: false };
  }

  if (state.grid[y][x].t !== "empty") return { ok: false };

  if (tool === "belt") {
    if (state.money < BELT_COST) {
      addLog(state, "Not enough coin.");
      return { ok: false };
    }
    state.money -= BELT_COST;
    const facing = inferBeltFacing(state, x, y, from);
    if (from && isCardinalNeighbor(from.x, from.y, x, y)) {
      const prev = state.grid[from.y]?.[from.x];
      if (prev?.t === "belt") prev.belt.facing = dirFromTo(from.x, from.y, x, y);
    }
    state.grid[y][x] = { t: "belt", belt: newBelt(facing) };
    return { ok: true, beltAdvance: facing };
  }

  const kind = tool;
  const cost = machineCost(kind);
  if (state.money < cost) {
    addLog(state, "Not enough coin.");
    return { ok: false };
  }
  if (!canPlace2x2(state, x, y)) {
    addLog(state, "Need a clear 2×2 bay.");
    return { ok: false };
  }
  state.money -= cost;
  place2x2(state, x, y, kind);
  addLog(state, `Set ${machineName(kind)} (−$${cost})`);
  if (!hasAdjacentBelt(state, x, y)) {
    addLog(state, "Tip: paint a belt on the rim. Yellow arrows are the flow.");
  }
  return { ok: true };
}

function isCardinalNeighbor(ax: number, ay: number, bx: number, by: number): boolean {
  return Math.abs(ax - bx) + Math.abs(ay - by) === 1;
}

function inferBeltFacing(
  state: FactoryState,
  x: number,
  y: number,
  from?: { x: number; y: number },
): Direction {
  if (from && isCardinalNeighbor(from.x, from.y, x, y)) {
    return dirFromTo(from.x, from.y, x, y);
  }
  for (const dir of DIRECTIONS) {
    const [dx, dy] = dirDelta(dir);
    const neighbor = state.grid[y + dy]?.[x + dx];
    if (neighbor?.t === "belt" && neighbor.belt.facing === dirOpposite(dir)) {
      return neighbor.belt.facing;
    }
  }
  let towardDock: Direction | null = null;
  let awayFromMachine: Direction | null = null;
  for (const dir of DIRECTIONS) {
    const [dx, dy] = dirDelta(dir);
    const machine = machineAtCell(state.grid, x + dx, y + dy);
    if (!machine) continue;
    if (machine.kind === "exporter") towardDock = dir;
    else awayFromMachine = dirOpposite(dir);
  }
  return towardDock ?? awayFromMachine ?? "right";
}

function hasAdjacentBelt(state: FactoryState, x: number, y: number): boolean {
  return perimeter2x2(x, y).some(([px, py]) => state.grid[py][px].t === "belt");
}

export function machineRimCells(ax: number, ay: number): [number, number][] {
  return perimeter2x2(ax, ay);
}

function perimeter2x2(ax: number, ay: number): [number, number][] {
  const cells: [number, number][] = [];
  if (ay > 0) {
    cells.push([ax, ay - 1], [ax + 1, ay - 1]);
  }
  if (ay + 2 < GRID_H) {
    cells.push([ax, ay + 2], [ax + 1, ay + 2]);
  }
  if (ax > 0) {
    cells.push([ax - 1, ay], [ax - 1, ay + 1]);
  }
  if (ax + 2 < GRID_W) {
    cells.push([ax + 2, ay], [ax + 2, ay + 1]);
  }
  if (ay > 0 && ax > 0) cells.push([ax - 1, ay - 1]);
  if (ay > 0 && ax + 2 < GRID_W) cells.push([ax + 2, ay - 1]);
  if (ay + 2 < GRID_H && ax > 0) cells.push([ax - 1, ay + 2]);
  if (ay + 2 < GRID_H && ax + 2 < GRID_W) cells.push([ax + 2, ay + 2]);
  return cells;
}

export function toggleMinerMode(state: FactoryState, x: number, y: number): boolean {
  const anchor = anchorOf(state.grid, x, y);
  if (!anchor) return false;
  const cell = state.grid[anchor[1]][anchor[0]];
  if (cell.t !== "machine" || cell.machine.kind !== "miner") return false;
  if (!state.copperUnlocked) {
    addLog(state, "Copper vein is still on the next ticket.");
    return false;
  }
  cell.machine.mode = cell.machine.mode === "iron" ? "copper" : "iron";
  addLog(state, `Miner now pulls ${cell.machine.mode === "iron" ? "iron" : "copper"}.`);
  return true;
}

export const TOOL_ORDER: PlacementTool[] = [
  "miner",
  "belt",
  "exporter",
  "smelter",
  "assembler",
  "fabricator",
  "delete",
];

export function toolLabel(tool: PlacementTool): string {
  switch (tool) {
    case "none":
      return "Look";
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
  }
}

export function toolHint(tool: PlacementTool): string {
  switch (tool) {
    case "none":
      return "Tap a machine to inspect. Drag the floor to pan.";
    case "miner":
      return "OUT ore. Place it, then paint a belt off the rim.";
    case "smelter":
      return "IN ore → OUT plate. Belt must kiss the rim.";
    case "assembler":
      return "IN iron plate → OUT gear. Copper plate will not go in.";
    case "exporter":
      return "IN anything. Sells at the price on the spec plate.";
    case "fabricator":
      return "IN iron plate + copper plate → OUT circuit.";
    case "belt":
      return "Drag toward the next machine. Arrows are the flow.";
    case "delete":
      return "Drag to scrap. Half the coin comes back.";
  }
}
