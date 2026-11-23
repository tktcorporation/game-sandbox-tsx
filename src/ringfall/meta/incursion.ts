/*
 * Lead-incursion (docs/ringfall/raid-loot.md stage 6, multiplayer.md 率いる遠征): the player
 * raids a copy of another island, takes a node by its 核 · 制圧, and the node's 中継ボックス
 * 島の守り arrives as 倉庫へ届いた — same vocabulary as a home-island retake. Pure helpers;
 * the sim gate never starts an incursion, so its hash stays put.
 */
import type { ValuableKind } from "../sim/config";
import { rivalHold, type PoiHold } from "../sim/holds";
import { DEPOTS, ENTRIES, NODES, POIS, poiRegion, regionOf, type EntryId, type NodeId, type PoiId, type RegionId } from "../sim/map";
import type { IslandView } from "./expeditions";
import type { Parcel } from "./parcels";
import { LOCAL_AID } from "./parcels";
import type { AiIsland } from "./ai-islands";

/** What a lead-incursion raid needs to start: the copy's holds, the target, and defence stock. */
export interface IncursionPlan {
  code: string;
  owner: string;
  target: NodeId;
  region: RegionId;
  entry: EntryId;
  /** Who holds each POI on the copy: the owner's nodes as `rival:…`, the rest the enemy's. */
  island: Partial<Record<PoiId, PoiHold>>;
  /** Defence stock on the copy (at least the target's); seized on 制圧 into 倉庫へ届いた. */
  parcels: Parcel[];
}

/** Whether the island still blocks expeditions / lead-incursions (新規島の保護). */
export const islandProtected = (v: Pick<IslandView, "protectedUntil">, now = Date.now()): boolean =>
  !!v.protectedUntil && v.protectedUntil > now;

/** The owner's code as a battle / rival id: AI islands use `ai-` + code, others the island code. */
export const incursionOwnerId = (code: string, ai: boolean): string => (ai ? `ai-${code}` : code);

/**
 * An island view as a raid's `Start.island`: every node the owner holds becomes another player's
 * (`rival:owner`), so 核 · 制圧 and seizeRivalLoot work as on the home front; the rest stay held.
 */
export function viewToRaidIsland(view: Pick<IslandView, "code" | "nodes">, ownerId: string): Partial<Record<PoiId, PoiHold>> {
  const out: Partial<Record<PoiId, PoiHold>> = {};
  for (const p of POIS) {
    if (p.boss) {
      out[p.id] = "held";
      continue;
    }
    const n = view.nodes.find((x) => x.id === p.id);
    out[p.id] = n?.hold === "freed" ? rivalHold(ownerId) : "held";
  }
  return out;
}

/** A way in of the target's region (the copy's geography is the same world). */
export function entryForTarget(target: NodeId, known: readonly EntryId[] = []): EntryId {
  const region = poiRegion(target);
  const prefer = region.entries.find((e) => known.includes(e));
  return prefer ?? region.entries[0] ?? ENTRIES[0].id;
}

/** Parcels on the view at `poi` (and, when empty, none — the settle still lays a reserve). */
export function parcelsAt(view: Pick<IslandView, "parcels">, poi: PoiId): Parcel[] {
  return (view.parcels ?? []).filter((q) => q.poi === poi);
}

/**
 * Defence stock the game's islands show at their held nodes: one common material per held node,
 * hashed so a day is stable. `taken` drops ids already seized in a lead-incursion.
 */
export function aiDefenceParcels(a: AiIsland, salt: number, day: number, held: readonly NodeId[], taken: readonly number[] = []): Parcel[] {
  const gone = new Set(taken);
  // Same common pool as an empty rival 中継ボックス reserve (seizeRivalLoot).
  const pool: ValuableKind[] = ["parts", "fuse", "board"];
  const out: Parcel[] = [];
  held.forEach((id, n) => {
    if (!DEPOTS.some((d) => d.poi === id)) return;
    const pid = 1 + ((Math.imul(salt ^ 0x85ebca6b, a.slot + 1) >>> 0) % 90_000) + n;
    if (gone.has(pid)) return;
    const kind = pool[(Math.imul(salt + day, nodeSalt(id) + 1) >>> 0) % pool.length]!;
    out.push({ id: pid, poi: id, kind, from: { code: LOCAL_AID, name: a.name }, at: 0 });
  });
  return out;
}

const nodeSalt = (id: string) => {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0;
  return h >>> 0;
};

/**
 * A lead-incursion from an island view onto `target`: null when the node is shut, the island is
 * protected, or the target is not a node.
 */
export function planIncursion(
  view: IslandView,
  target: string,
  opts: { ai: boolean; salt?: number; day?: number; taken?: readonly number[]; known?: readonly EntryId[] } = { ai: false },
): IncursionPlan | null {
  if (islandProtected(view)) return null;
  const node = NODES.find((n) => n.id === target);
  if (!node) return null;
  const slot = view.nodes.find((n) => n.id === target);
  if (!slot?.open) return null;
  const ownerId = incursionOwnerId(view.code, opts.ai);
  const island = viewToRaidIsland(view, ownerId);
  let parcels = parcelsAt(view, node.id);
  if (!parcels.length && opts.ai && opts.salt != null && opts.day != null) {
    const held = view.nodes.filter((n) => n.hold === "freed").map((n) => n.id as NodeId);
    parcels = aiDefenceParcels({ slot: 0, code: view.code, name: view.owner }, opts.salt, opts.day, held, opts.taken).filter((q) => q.poi === node.id);
  }
  return {
    code: view.code,
    owner: view.owner,
    target: node.id,
    region: regionOf(node.region).id,
    entry: entryForTarget(node.id, opts.known),
    island,
    parcels,
  };
}

/** Ids already seized from island `code` in earlier lead-incursions (profile bookkeeping). */
export function takenOn(list: readonly { code: string; ids: number[] }[] | undefined, code: string): number[] {
  return list?.filter((e) => e.code === code).flatMap((e) => e.ids) ?? [];
}

/** Merges newly seized parcel ids for island `code` into the profile's lead-incursion book. */
export function withTaken(
  list: readonly { code: string; ids: number[] }[] | undefined,
  code: string,
  ids: readonly number[],
): { code: string; ids: number[] }[] {
  if (!ids.length) return list ? [...list] : [];
  const out = [...(list ?? [])];
  const i = out.findIndex((e) => e.code === code);
  if (i < 0) return [...out, { code, ids: [...ids] }];
  const set = new Set([...out[i]!.ids, ...ids]);
  out[i] = { code, ids: [...set] };
  return out;
}
