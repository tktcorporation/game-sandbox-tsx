/*
 * Contested outer-hub defence for a home-island raid (作り順② / 方向 A mechanics):
 * owner's 工場の部隊 + 島の守り → Start.defence / Start.parcels for newRun().
 */
import { FACTORY_TOP } from "../sim/config";
import { rivalOf } from "../sim/holds";
import type { PoiId } from "../sim/map";
import { CONTESTED_SHORES, type Neighbour } from "./neighbours";
import type { Parcel } from "./parcels";
import type { Island } from "./island";
import { aiByOwner, aiFactory } from "./ai-islands";

/** One rival owner's factory level for contested defence this raid. */
export type DefenceEntry = { owner: string; factory: number };

/**
 * Factory levels of rivals who hold a contested outer hub on this island.
 * AI owners use `aiFactory(day)`; real neighbours use `Neighbour.factory` when known,
 * else the same day-based curve as AI (judgment: summaries without factory yet).
 */
export function contestedDefence(
  poiState: Island,
  day: number,
  neighbours: readonly Neighbour[],
  salt: number,
): DefenceEntry[] {
  const byCode = new Map(neighbours.map((n) => [n.code, n]));
  const out = new Map<string, number>();
  for (const id of CONTESTED_SHORES) {
    const who = rivalOf(poiState[id]?.state ?? "foe");
    if (!who || out.has(who)) continue;
    const ai = aiByOwner(salt, who);
    if (ai) {
      out.set(who, aiFactory(day));
      continue;
    }
    const code = who.startsWith("ai-") ? who.slice(3) : who;
    const n = byCode.get(code) ?? byCode.get(who);
    const factory =
      n && Number.isFinite(n.factory) ? Math.max(0, Math.min(FACTORY_TOP, Math.round(n.factory!))) : aiFactory(n?.day ?? day);
    out.set(who, factory);
  }
  return [...out].map(([owner, factory]) => ({ owner, factory }));
}

/** Parcels at contested hubs (島の守り stock that becomes defence grunts / seize loot). */
export const contestedParcels = (parcels: readonly Parcel[]): Parcel[] =>
  (parcels ?? []).filter((q) => (CONTESTED_SHORES as readonly string[]).includes(q.poi));

/** Whether POI `id` is a contested coastal hub. */
export const isContestedShoreId = (id: PoiId | string): boolean => (CONTESTED_SHORES as readonly string[]).includes(id);
