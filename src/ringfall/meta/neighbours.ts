/*
 * The neighbours (docs/ringfall/multiplayer.md, お隣の島): other players' islands the server offers
 * this one, nearest in nodes held, the same all week. The camp's maps draw each one out at sea at a
 * slot of its own, and the factory's expeditions start from them, so sending one needs no code typed.
 * Pure: the answer read here, the requests in island-net.ts.
 */
import { isIslandCode } from "./island-code";

/** A neighbour as the server tells it: whose island, its code, how far its owner has come. */
export interface Neighbour {
  code: string;
  name: string;
  held: number;
  total: number;
  day: number;
}

/** The most the server offers, and so the slots out at sea. */
export const NEIGHBOUR_MAX = 4;

/**
 * Where on the camp's maps each neighbour's island lies, in world metres: out on the open sea round
 * the island (north-west beyond the harbor and the plateau, north-east beyond the city, south-east
 * past the city's coast, south between the plateau and the dune coast).
 */
export const NEIGHBOUR_SLOTS: readonly { x: number; z: number }[] = [
  { x: -980, z: -940 },
  { x: 860, z: -1150 },
  { x: 860, z: 540 },
  { x: -420, z: 590 },
];

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const count = (v: unknown, hi: number): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= hi;

/** The server's answer (`{ neighbours: [...] }`) as a list, or null when it is not one. */
export function parseNeighbours(raw: unknown): Neighbour[] | null {
  if (!isObj(raw) || !Array.isArray(raw.neighbours)) return null;
  const out: Neighbour[] = [];
  for (const n of raw.neighbours.slice(0, NEIGHBOUR_MAX)) {
    if (!isObj(n) || !isIslandCode(n.code) || typeof n.name !== "string" || !count(n.total, 64) || !count(n.held, n.total as number) || !count(n.day, 100000)) continue;
    const name = n.name.trim().slice(0, 24);
    if (name) out.push({ code: n.code, name, held: n.held, total: n.total, day: n.day });
  }
  return out;
}
