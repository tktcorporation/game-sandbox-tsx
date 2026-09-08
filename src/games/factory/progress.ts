import { recipeLine } from "./recipes";
import {
  type FactoryState,
  type ItemKind,
  type MachineKind,
  type PlacementTool,
  itemLabel,
  machineName,
} from "./types";

export interface Order {
  id: string;
  title: string;
  brief: string;
  item: ItemKind;
  need: number;
  reward: number;
  unlock?: MachineKind[];
  copper?: boolean;
  stamp: string;
  then: string;
}

const STORY: Order[] = [
  {
    id: "scrap-iron",
    title: "Scrap iron",
    brief: "Five chunks on the dock. Prove the line lives.",
    item: "ironOre",
    need: 5,
    reward: 20,
    unlock: ["smelter"],
    stamp: "Furnace is on the ticket. Ore in, plate out.",
    then: "Furnace",
  },
  {
    id: "hot-roll",
    title: "Hot roll",
    brief: "The buyer wants plate, not rock. Melt it.",
    item: "ironPlate",
    need: 8,
    reward: 45,
    unlock: ["assembler"],
    stamp: "Press is on the ticket. Iron plate becomes gear.",
    then: "Press",
  },
  {
    id: "gear-run",
    title: "Gear run",
    brief: "Teeth sell. Keep the press biting.",
    item: "gear",
    need: 6,
    reward: 90,
    copper: true,
    stamp: "Copper vein is open. Tap a miner to switch.",
    then: "Copper vein",
  },
  {
    id: "red-metal",
    title: "Red metal",
    brief: "Switch a miner to copper. Melt a second line.",
    item: "copperPlate",
    need: 8,
    reward: 70,
    unlock: ["fabricator"],
    stamp: "Bench is on the ticket. Both plates in, circuit out.",
    then: "Bench",
  },
  {
    id: "brain-box",
    title: "Brain box",
    brief: "Iron plate and copper plate on the same bench.",
    item: "circuit",
    need: 4,
    reward: 220,
    stamp: "The floor is yours. Stretch the flow.",
    then: "Bigger shifts",
  },
];

const REPEAT: { item: ItemKind; need: number; reward: number; title: string; brief: string }[] = [
  { item: "gear", need: 10, reward: 140, title: "Tooth run", brief: "Keep the press biting." },
  { item: "circuit", need: 8, reward: 360, title: "Brain box", brief: "More boards. Same bench." },
  { item: "copperPlate", need: 16, reward: 130, title: "Red sheet", brief: "Copper still sells if the bench is full." },
  { item: "ironPlate", need: 24, reward: 110, title: "Hot roll", brief: "Fill the dock with plate." },
];

export function isMachineUnlocked(state: FactoryState, kind: MachineKind): boolean {
  if (kind === "miner" || kind === "exporter") return true;
  return state.unlocked.includes(kind);
}

export function isToolUnlocked(state: FactoryState, tool: PlacementTool): boolean {
  if (tool === "none" || tool === "belt" || tool === "delete") return true;
  return isMachineUnlocked(state, tool);
}

export function currentOrder(state: { contractsCompleted: number }): Order {
  const n = state.contractsCompleted;
  if (n < STORY.length) return STORY[n]!;
  const extra = n - STORY.length;
  const gen = Math.floor(extra / REPEAT.length);
  const base = REPEAT[extra % REPEAT.length]!;
  const scale = 1 + gen * 0.5;
  return {
    id: `shift-${n}`,
    title: base.title,
    brief: base.brief,
    item: base.item,
    need: Math.round(base.need * scale),
    reward: Math.round(base.reward * (1 + gen * 0.35)),
    stamp: "Shift paid. Stretch the line.",
    then: "Next ticket",
  };
}

export function unlockHint(tool: PlacementTool): string {
  switch (tool) {
    case "smelter":
      return "Fill the scrap-iron order to get the furnace.";
    case "assembler":
      return "Ship plates. The press is on the next ticket.";
    case "fabricator":
      return "Bring copper plate to the dock first.";
    default:
      return "Still locked.";
  }
}

export function floorHint(state: FactoryState): string {
  let miners = 0;
  let belts = 0;
  let exporters = 0;
  for (const row of state.grid) {
    for (const cell of row) {
      if (cell.t === "machine") {
        if (cell.machine.kind === "miner") miners += 1;
        if (cell.machine.kind === "exporter") exporters += 1;
      } else if (cell.t === "belt") {
        belts += 1;
      }
    }
  }
  if (miners === 0) return "Plant a miner — ore starts there";
  if (belts === 0) return "Paint a belt off the miner, arrows pointing out";
  if (exporters === 0) return "Dock a bay on the end of the belt";
  if (state.totalExported === 0) return "Wait. Ore rides the belt to the dock";
  const order = currentOrder(state);
  const left = Math.max(0, order.need - state.contractProgress);
  return `${order.title}: ${left} ${itemLabel(order.item)} to go`;
}

export function creditOrder(state: FactoryState, item: ItemKind): void {
  const order = currentOrder(state);
  if (order.item !== item) return;
  state.contractProgress += 1;
  if (state.contractProgress < order.need) return;
  completeOrder(state, order);
}

function completeOrder(state: FactoryState, order: Order): void {
  state.money += order.reward;
  state.totalMoneyEarned += order.reward;
  state.contractsCompleted += 1;
  state.contractProgress = 0;
  if (order.unlock) {
    for (const kind of order.unlock) {
      if (!state.unlocked.includes(kind)) state.unlocked.push(kind);
    }
  }
  if (order.copper) state.copperUnlocked = true;
  state.honorFlash = 28;
  state.lastHonor = order.stamp;
  pushLog(state, `ORDER PAID +$${order.reward}`);
  pushLog(state, order.stamp);
  if (order.unlock) {
    for (const kind of order.unlock) {
      pushLog(state, `${machineName(kind)}: ${recipeLine(kind)}`);
    }
  }
}

function pushLog(state: FactoryState, text: string): void {
  state.log.push(text);
  if (state.log.length > 30) state.log.shift();
}

export function floorIsEmpty(state: FactoryState): boolean {
  for (const row of state.grid) {
    for (const cell of row) {
      if (cell.t !== "empty") return false;
    }
  }
  return true;
}
