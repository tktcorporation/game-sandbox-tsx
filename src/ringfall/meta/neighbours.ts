/*
 * The neighbours (docs/ringfall/multiplayer.md, お隣の島): other players' islands the server offers
 * this one, nearest in nodes held, the same all week. The camp's maps draw each one out at sea at a
 * slot of its own, and the factory's expeditions start from them, so sending one needs no code typed.
 * Pure: the answer read here, the requests in island-net.ts.
 */
import { isAiOwner } from "../sim/holds";
import { isIslandCode } from "./island-code";
import type { NodeId } from "../sim/map";

/** A neighbour as the server tells it: whose island, its code, how far its owner has come. */
export interface Neighbour {
  code: string;
  name: string;
  held: number;
  total: number;
  day: number;
  /** The slot at sea it stands in (`NEIGHBOUR_SLOTS`), which sets the sea route to it. */
  slot: number;
  /** Factory level last reported (島の守り／守備隊). Optional on older answers. */
  factory?: number;
  /**
   * Ranking trophies last reported (お隣の組み合わせの基準). Optional on older answers / caches;
   * map and signal station show it beside the name when present.
   */
  trophies?: number;
  /** What its owner did last, for a sign of life: when they last played, and that raid's cores taken and whether they got home. */
  last?: { at: number; captured: number; home: boolean };
  /** An island the game runs itself (meta/ai-islands.ts), filling a slot the server left free: marked AI wherever it is shown. */
  ai?: true;
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

/**
 * Coastal hubs contested with a neighbour (方向 A / TKT-195): 観測所・浄水場・ロボット工場・追跡レーダー.
 * Holding one counts toward 「島の解放まで · 拠点 あと N」; 16 is still reachable without them.
 */
export const CONTESTED_SHORES: readonly NodeId[] = NEIGHBOUR_SLOTS.map((s) => s.shore);

export const isContestedShore = (id: NodeId | string): boolean => (CONTESTED_SHORES as readonly string[]).includes(id);

/** Whether the sea route to neighbour slot `k` is open: the player holds the node facing it. */
export const routeOpen = (k: number, holds: (id: NodeId) => boolean): boolean => !!NEIGHBOUR_SLOTS[k] && holds(NEIGHBOUR_SLOTS[k].shore);

/**
 * Whether the player has opened PvP at sea (CoC-style: neighbours stay hidden until then).
 * True once any coastal route is open.
 */
export const pvpSeaOpen = (holds: (id: NodeId) => boolean): boolean => NEIGHBOUR_SLOTS.some((_, k) => routeOpen(k, holds));

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const count = (v: unknown, hi: number): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= hi;

/** The server's answer (`{ neighbours: [...] }`) as a list, or null when it is not one. */
export function parseNeighbours(raw: unknown): Neighbour[] | null {
  if (!isObj(raw) || !Array.isArray(raw.neighbours)) return null;
  const out: Neighbour[] = [];
  for (const [k, n] of raw.neighbours.slice(0, NEIGHBOUR_MAX).entries()) {
    if (!isObj(n) || !isIslandCode(n.code) || typeof n.name !== "string" || !count(n.total, 64) || !count(n.held, n.total as number) || !count(n.day, 100000)) continue;
    const name = n.name.trim().slice(0, 24);
    if (!name) continue;
    // The server names the last raid by its fields (seen, captured, outcome); the browser's kept copy as `last`.
    const kept = isObj(n.last) && Number.isFinite(n.last.at) && count(n.last.captured, 64) && typeof n.last.home === "boolean" ? { at: n.last.at as number, captured: n.last.captured, home: n.last.home } : undefined;
    const last = kept ?? (Number.isFinite(n.seen) && (n.seen as number) > 0 && count(n.captured, 64) ? { at: n.seen as number, captured: n.captured, home: n.outcome === "extracted" } : undefined);
    // An answer from before slots were kept places each in the slot of its place in the list.
    const slot = Number.isInteger(n.slot) && (n.slot as number) >= 0 && (n.slot as number) < NEIGHBOUR_MAX ? (n.slot as number) : k;
    if (out.some((o) => o.slot === slot)) continue;
    const factory = Number.isInteger(n.factory) && (n.factory as number) >= 0 && (n.factory as number) <= 64 ? (n.factory as number) : undefined;
    const trophies =
      Number.isInteger(n.trophies) && (n.trophies as number) >= 0 && (n.trophies as number) <= 10000 ? (n.trophies as number) : undefined;
    out.push({
      code: n.code,
      name,
      held: n.held,
      total: n.total,
      day: n.day,
      slot,
      ...(factory !== undefined ? { factory } : {}),
      ...(trophies !== undefined ? { trophies } : {}),
      ...(last ? { last } : {}),
    });
  }
  return out;
}

/**
 * Display name for a rival hold's owner code among known neighbours.
 * Resolves by code only (never by the current neighbour slot): a rival may keep a coastal hub
 * across a weekly redraw while a different player sits that slot (Codex / TKT-195).
 */
export function neighbourNameByCode(who: string, neighbours: readonly Pick<Neighbour, "code" | "name">[]): string | null {
  const n = neighbours.find((x) => x.code === who || (isAiOwner(who) && x.code === who.slice(3)));
  return n?.name ?? null;
}

/** How long ago, in its largest unit and a letter: 5m, 3h, 2d (the marks beside a neighbour). */
export function ago(at: number, now: number): string {
  const m = Math.max(0, Math.floor((now - at) / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}
