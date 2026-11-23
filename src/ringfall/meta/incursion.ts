/*
 * Other-island short raid X2 (docs/ringfall/game-design-review.md §5.8): the player raids a
 * *subset* of another island's nodes (not the full mirror of abolished stage 6), takes the
 * target by 核 · 制圧, and 島の守り arrives as 倉庫へ届いた. Helpers stay pure; the sim gate's
 * home-island tables never set Start.incursion, so their hash stays put.
 */
import type { ValuableKind } from "../sim/config";
import { rivalHold, type PoiHold } from "../sim/holds";
import { DEPOTS, ENTRIES, FRONT_LINKS, NODES, POIS, nodeIndex, poiRegion, regionOf, type EntryId, type NodeId, type PoiId, type RegionId } from "../sim/map";
import type { IslandView } from "./expeditions";
import type { Parcel } from "./parcels";
import { LOCAL_AID } from "./parcels";
import type { AiIsland } from "./ai-islands";

/** How many nodes beside the target may stay on the short-raid stage (X2). */
export const SHORT_RAID_EXTRA = 2;

/**
 * Node to aim an X2 notice at: prefer `prefer` when the owner holds it open, else the nearest
 * open freed node (real islands may not hold the coastal id that opened the attacker's route).
 */
export function assaultTarget(view: Pick<IslandView, "nodes" | "protectedUntil">, prefer: NodeId, now = Date.now()): NodeId | null {
  if (islandProtected(view, now)) return null;
  const open = view.nodes.filter((n) => n.hold === "freed" && n.open && nodeIndex(n.id) >= 0);
  if (!open.length) return null;
  if (open.some((n) => n.id === prefer)) return prefer;
  const t = NODES[nodeIndex(prefer)];
  open.sort((a, b) => {
    const na = NODES[nodeIndex(a.id)];
    const nb = NODES[nodeIndex(b.id)];
    return Math.hypot(na.x - t.x, na.z - t.z) - Math.hypot(nb.x - t.x, nb.z - t.z);
  });
  return open[0]!.id as NodeId;
}

/** What a short / lead-incursion raid needs to start: the copy's holds, the target, and defence stock. */
export interface IncursionPlan {
  code: string;
  owner: string;
  target: NodeId;
  region: RegionId;
  entry: EntryId;
  /** Who holds each POI on the copy: stage nodes as `rival:…`, the rest cleared (X2) or enemy-held (legacy full). */
  island: Partial<Record<PoiId, PoiHold>>;
  /** Defence stock on the copy (at least the target's); seized on 制圧 into 倉庫へ届いた. */
  parcels: Parcel[];
  /** Nodes on the short stage (target first). Empty when the plan is a legacy full mirror. */
  stage: NodeId[];
}

/** Whether the island still blocks expeditions / short raids (新規島の保護). */
export const islandProtected = (v: Pick<IslandView, "protectedUntil">, now = Date.now()): boolean =>
  !!v.protectedUntil && v.protectedUntil > now;

/** The owner's code as a battle / rival id: AI islands use `ai-` + code, others the island code. */
export const incursionOwnerId = (code: string, ai: boolean): string => (ai ? `ai-${code}` : code);

/**
 * An island view as a raid's `Start.island`: every node the owner holds becomes another player's
 * (`rival:owner`), so 核 · 制圧 and seizeRivalLoot work as on the home front; the rest stay held.
 * Legacy full-mirror helper — X2 uses `viewToShortRaidIsland` instead.
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

/**
 * X2 stage: the target plus up to `SHORT_RAID_EXTRA` FRONT_LINKS neighbours the owner still holds,
 * nearest first. Only these stay rival-held on the copy.
 */
export function stageNodes(view: Pick<IslandView, "nodes">, target: NodeId, extra = SHORT_RAID_EXTRA, forceOpen?: NodeId): NodeId[] {
  const ownerHeld = new Set(
    view.nodes.filter((n) => n.hold === "freed" && (n.open || n.id === forceOpen)).map((n) => n.id),
  );
  if (!ownerHeld.has(target)) return [];
  const t = NODES[nodeIndex(target)];
  const linked = FRONT_LINKS.flatMap(([a, b]) => {
    if (a === target && typeof b === "string" && ownerHeld.has(b as NodeId)) return [b as NodeId];
    if (b === target && a !== "camp" && ownerHeld.has(a as NodeId)) return [a as NodeId];
    return [];
  });
  linked.sort((a, b) => {
    const na = NODES[nodeIndex(a)];
    const nb = NODES[nodeIndex(b)];
    return Math.hypot(na.x - t.x, na.z - t.z) - Math.hypot(nb.x - t.x, nb.z - t.z);
  });
  return [target, ...linked.slice(0, Math.max(0, extra))];
}

/**
 * X2 copy: only `stage` nodes are rival-held; every other freeable POI is freed (no garrison), so
 * the raid stays on a few nodes. The titan pad stays held.
 */
export function viewToShortRaidIsland(ownerId: string, stage: readonly NodeId[]): Partial<Record<PoiId, PoiHold>> {
  const on = new Set(stage);
  const out: Partial<Record<PoiId, PoiHold>> = {};
  for (const p of POIS) {
    if (p.boss) {
      out[p.id] = "held";
      continue;
    }
    out[p.id] = on.has(p.id as NodeId) ? rivalHold(ownerId) : "freed";
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
 * hashed so a day is stable. `taken` drops ids already seized in a short raid.
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
 * Legacy full-mirror plan (stage 6 shape). Prefer `planShortRaid` for X2.
 */
export function planIncursion(
  view: IslandView,
  target: string,
  opts: { ai: boolean; known?: readonly EntryId[] } = { ai: false },
): IncursionPlan | null {
  if (islandProtected(view)) return null;
  const node = NODES.find((n) => n.id === target);
  if (!node) return null;
  const slot = view.nodes.find((n) => n.id === target);
  if (!slot?.open) return null;
  const ownerId = incursionOwnerId(view.code, opts.ai);
  const island = viewToRaidIsland(view, ownerId);
  const parcels = parcelsAt(view, node.id);
  return {
    code: view.code,
    owner: view.owner,
    target: node.id,
    region: regionOf(node.region).id,
    entry: entryForTarget(node.id, opts.known),
    island,
    parcels,
    stage: [],
  };
}

/**
 * X2 short raid: only a few of the owner's open nodes stay on the stage. Null when protected,
 * the target is shut, or the owner does not hold it.
 */
export function planShortRaid(
  view: IslandView,
  target: string,
  opts: { ai: boolean; known?: readonly EntryId[]; extra?: number; /** Own X2 notice already occupies the target — still plan. */ ignoreBusy?: boolean } = { ai: false },
): IncursionPlan | null {
  if (islandProtected(view)) return null;
  const node = NODES.find((n) => n.id === target);
  if (!node) return null;
  const slot = view.nodes.find((n) => n.id === target);
  if (!slot || slot.hold !== "freed") return null;
  // Real islands mark a node closed while any expedition (including our own X2) is on it.
  if (!slot.open && !opts.ignoreBusy) return null;
  const stage = stageNodes(view, node.id, opts.extra ?? SHORT_RAID_EXTRA, opts.ignoreBusy ? node.id : undefined);
  if (!stage.length) return null;
  const ownerId = incursionOwnerId(view.code, opts.ai);
  const island = viewToShortRaidIsland(ownerId, stage);
  const parcels = stage.flatMap((id) => parcelsAt(view, id));
  return {
    code: view.code,
    owner: view.owner,
    target: node.id,
    region: regionOf(node.region).id,
    entry: entryForTarget(node.id, opts.known),
    island,
    parcels,
    stage,
  };
}

/** Ids already seized from island `code` in earlier short raids (profile bookkeeping). */
export function takenOn(list: readonly { code: string; ids: number[] }[] | undefined, code: string): number[] {
  return list?.filter((e) => e.code === code).flatMap((e) => e.ids) ?? [];
}

/** Merges newly seized parcel ids for island `code` into the profile's short-raid book. */
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
