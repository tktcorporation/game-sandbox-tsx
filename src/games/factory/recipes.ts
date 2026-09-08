import {
  type ItemKind,
  type Machine,
  type MachineKind,
  type MinerMode,
} from "./types";

export const ITEM_LOOK: Record<
  ItemKind,
  { fill: string; ink: string; rim: string; short: string }
> = {
  ironOre: { fill: "#5d6a78", ink: "#f4f1ea", rim: "#9aa8b8", short: "Iron ore" },
  ironPlate: { fill: "#8ea0b4", ink: "#1a1c18", rim: "#d5e2ee", short: "Iron plate" },
  gear: { fill: "#e8c15a", ink: "#1a1c18", rim: "#3a3832", short: "Gear" },
  copperOre: { fill: "#8a3a18", ink: "#f4f1ea", rim: "#e07a3a", short: "Copper ore" },
  copperPlate: { fill: "#c47832", ink: "#1a1c18", rim: "#f0c090", short: "Cu plate" },
  circuit: { fill: "#1f6a44", ink: "#f4f1ea", rim: "#e6c200", short: "Circuit" },
};

export type Takes = readonly ItemKind[] | "any" | null;

export interface MachineSpec {
  takes: Takes;
  products: readonly ItemKind[] | "sell";
  inPorts: boolean;
  outPorts: boolean;
  verb: string;
}

export const MACHINE_SPEC: Record<MachineKind, MachineSpec> = {
  miner: {
    takes: null,
    products: ["ironOre", "copperOre"],
    inPorts: false,
    outPorts: true,
    verb: "drill",
  },
  smelter: {
    takes: ["ironOre", "copperOre"],
    products: ["ironPlate", "copperPlate"],
    inPorts: true,
    outPorts: true,
    verb: "melt",
  },
  assembler: {
    takes: ["ironPlate"],
    products: ["gear"],
    inPorts: true,
    outPorts: true,
    verb: "press",
  },
  fabricator: {
    takes: ["ironPlate", "copperPlate"],
    products: ["circuit"],
    inPorts: true,
    outPorts: true,
    verb: "solder",
  },
  exporter: {
    takes: "any",
    products: "sell",
    inPorts: true,
    outPorts: false,
    verb: "ship",
  },
};

export function minerProduct(mode: MinerMode): ItemKind {
  return mode === "iron" ? "ironOre" : "copperOre";
}

export function smeltProduct(item: ItemKind): ItemKind | null {
  if (item === "ironOre") return "ironPlate";
  if (item === "copperOre") return "copperPlate";
  return null;
}

export function recipeLine(kind: MachineKind, mode: MinerMode = "iron"): string {
  switch (kind) {
    case "miner":
      return `OUT ${mode === "iron" ? "iron ore" : "copper ore"}`;
    case "smelter":
      return "IN ore → OUT plate";
    case "assembler":
      return "IN iron plate → OUT gear";
    case "fabricator":
      return "IN iron + copper plate → OUT circuit";
    case "exporter":
      return "IN anything → coin";
  }
}

export function takesItem(kind: MachineKind, item: ItemKind): boolean {
  const takes = MACHINE_SPEC[kind].takes;
  if (takes === null) return false;
  if (takes === "any") return true;
  return takes.includes(item);
}

export function makesItem(kind: MachineKind, item: ItemKind, mode: MinerMode): boolean {
  if (kind === "miner") return minerProduct(mode) === item;
  if (kind === "smelter") return item === "ironPlate" || item === "copperPlate";
  const products = MACHINE_SPEC[kind].products;
  if (products === "sell") return false;
  return products.includes(item);
}

export function machineTouchesItem(kind: MachineKind, item: ItemKind, mode: MinerMode): boolean {
  return takesItem(kind, item) || makesItem(kind, item, mode);
}

export type MachineStatusId = "working" | "starved" | "jammed" | "idle" | "need";

export function machineStatus(m: Machine): { id: MachineStatusId; label: string } {
  const full = m.outputBuffer.length >= m.maxBuffer;
  switch (m.kind) {
    case "miner":
      if (full) return { id: "jammed", label: "JAM · paint a belt" };
      if (m.progress > 0) return { id: "working", label: "DRILLING" };
      return { id: "idle", label: "READY" };
    case "exporter":
      if (m.inputBuffer.length === 0) return { id: "starved", label: "FEED THE DOCK" };
      return { id: "working", label: "SHIPPING" };
    case "smelter": {
      if (full) return { id: "jammed", label: "JAM · belt out" };
      const ore = m.inputBuffer[0];
      if (!ore) return { id: "starved", label: "FEED ORE" };
      if (!smeltProduct(ore)) return { id: "need", label: "WRONG ITEM" };
      return { id: "working", label: "MELTING" };
    }
    case "assembler":
      if (full) return { id: "jammed", label: "JAM · belt out" };
      if (!m.inputBuffer.includes("ironPlate")) return { id: "starved", label: "FEED IRON PLATE" };
      return { id: "working", label: "PRESSING" };
    case "fabricator": {
      if (full) return { id: "jammed", label: "JAM · belt out" };
      const hasIron = m.inputBuffer.includes("ironPlate");
      const hasCopper = m.inputBuffer.includes("copperPlate");
      if (!hasIron && !hasCopper) return { id: "starved", label: "NEED BOTH PLATES" };
      if (!hasIron) return { id: "need", label: "NEED IRON PLATE" };
      if (!hasCopper) return { id: "need", label: "NEED COPPER PLATE" };
      return { id: "working", label: "SOLDERING" };
    }
  }
  return { id: "idle", label: "READY" };
}