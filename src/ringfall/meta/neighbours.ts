/*
 * The neighbours (docs/ringfall/multiplayer.md, お隣の島): other players' islands the server offers
 * this one, nearest in nodes held, the same all week. The camp's maps draw each one out at sea at a
 * slot of its own, and the factory's expeditions start from them, so sending one needs no code typed.
 * Pure: the answer read here, the requests in island-net.ts.
 */
import { isIslandCode } from "./island-code";
import type { NodeId } from "../sim/map";

/** A neighbour as the server tells it: whose island, its code, how far its owner has come. */
export interface Neighbour {
  code: string;
  name: string;
  held: number;
  total: number;
  day: number;
  /** What its owner did last, for a sign of life: when they last played, and that raid's cores taken and whether they got home. */
  last?: { at: number; captured: number; home: boolean };
}

/** The most the server offers, and so the slots out at sea. */
export const NEIGHBOUR_MAX = 4;

/**
 * Where on the camp's maps each neighbour's island lies, in world metres, out on the open sea, and
 * the node on the coast facing it: holding that node opens the sea route there, so an expedition
 * goes only to the neighbours the player's ground reaches. In the order a raid usually takes them:
 * the observatory by the camp faces the south, the waterworks the south-east, the robot works the
 * north-east beyond the city, the tracking radar the north-west beyond the plateau.
 */
export const NEIGHBOUR_SLOTS: readonly { x: number; z: number; shore: NodeId }[] = [
  { x: -420, z: 590, shore: "station" },
  { x: 860, z: 540, shore: "waterworks" },
  { x: 860, z: -1150, shore: "robotworks" },
  { x: -980, z: -940, shore: "radar" },
];

/** Whether the sea route to neighbour slot `k` is open: the player holds the node facing it. */
export const routeOpen = (k: number, holds: (id: NodeId) => boolean): boolean => !!NEIGHBOUR_SLOTS[k] && holds(NEIGHBOUR_SLOTS[k].shore);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const count = (v: unknown, hi: number): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= hi;

/** The server's answer (`{ neighbours: [...] }`) as a list, or null when it is not one. */
export function parseNeighbours(raw: unknown): Neighbour[] | null {
  if (!isObj(raw) || !Array.isArray(raw.neighbours)) return null;
  const out: Neighbour[] = [];
  for (const n of raw.neighbours.slice(0, NEIGHBOUR_MAX)) {
    if (!isObj(n) || !isIslandCode(n.code) || typeof n.name !== "string" || !count(n.total, 64) || !count(n.held, n.total as number) || !count(n.day, 100000)) continue;
    const name = n.name.trim().slice(0, 24);
    if (!name) continue;
    const last = Number.isFinite(n.seen) && (n.seen as number) > 0 && count(n.captured, 64) ? { at: n.seen as number, captured: n.captured, home: n.outcome === "extracted" } : undefined;
    out.push({ code: n.code, name, held: n.held, total: n.total, day: n.day, ...(last ? { last } : {}) });
  }
  return out;
}
