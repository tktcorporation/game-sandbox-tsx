/*
 * Depot parcels left for other players (ux-design C2): plain data the profile and the island
 * server share. Pure: the browser posts them; the sim only carries what `Start.parcels` names.
 */
import { VALUABLES, type ValuableKind } from "../sim/config";
import { DEPOTS, type PoiId } from "../sim/map";
import { isIslandCode } from "./island-code";

/** One parcel at a depot POI. */
export interface Parcel {
  id: number;
  poi: PoiId;
  kind: ValuableKind;
  from: { code: string; name: string };
  at: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const KINDS = Object.keys(VALUABLES) as ValuableKind[];
const POI_OK = new Set(DEPOTS.map((d) => d.poi));

/** Readable parcels from a save or a server view; unreadable ones are dropped. */
export function parseParcels(raw: unknown): Parcel[] {
  if (!Array.isArray(raw)) return [];
  const out: Parcel[] = [];
  for (const r of raw) {
    if (!isObj(r) || !Number.isInteger(r.id) || (r.id as number) <= 0) continue;
    if (typeof r.poi !== "string" || !POI_OK.has(r.poi as PoiId)) continue;
    if (typeof r.kind !== "string" || !KINDS.includes(r.kind as ValuableKind)) continue;
    const from = isObj(r.from) && typeof r.from.code === "string" && typeof r.from.name === "string" && isIslandCode(r.from.code) ? { code: r.from.code, name: r.from.name } : null;
    if (!from) continue;
    out.push({ id: r.id as number, poi: r.poi as PoiId, kind: r.kind as ValuableKind, from, at: typeof r.at === "number" && Number.isFinite(r.at) ? r.at : 0 });
  }
  return out;
}

/** Look-pings from a public island view. */
export function parsePings(raw: unknown): { id: number; x: number; z: number; by: string; until: number }[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r) => {
    if (!isObj(r) || !Number.isInteger(r.id) || !Number.isFinite(r.x) || !Number.isFinite(r.z)) return [];
    if (typeof r.by !== "string" || typeof r.until !== "number") return [];
    return [{ id: r.id as number, x: r.x as number, z: r.z as number, by: r.by, until: r.until }];
  });
}
