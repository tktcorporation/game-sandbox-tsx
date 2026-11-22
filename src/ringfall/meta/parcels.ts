/*
 * Aid parcels (ux-design C2, CoC-style 援軍の寄付): valuables left at depots that help the next
 * defence or sortie while the owner is offline. Pure data the profile and the island server share.
 * The sim only carries what `Start.parcels` names; the gate never starts with any.
 */
import { VALUABLES, type ValuableKind } from "../sim/config";
import { DEPOTS, type PoiId } from "../sim/map";
import { isIslandCode } from "./island-code";

/** One aid parcel at a depot POI. */
export interface Parcel {
  id: number;
  poi: PoiId;
  kind: ValuableKind;
  from: { code: string; name: string };
  at: number;
}

/**
 * Offline / not-yet-claimed origin: survives `parseProfile` when the island server never answered.
 * Real island codes stay Crockford; this sentinel is never posted as a server `from`.
 */
export const LOCAL_AID = "local";

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const KINDS = Object.keys(VALUABLES) as ValuableKind[];
const POI_OK = new Set(DEPOTS.map((d) => d.poi));

/** Whether `code` may name who left a parcel (an island code, or the local sentinel / empty). */
export const isParcelFromCode = (code: unknown): code is string =>
  typeof code === "string" && (code === "" || code === LOCAL_AID || isIslandCode(code));

/** Readable parcels from a save or a server view; unreadable ones are dropped. */
export function parseParcels(raw: unknown): Parcel[] {
  if (!Array.isArray(raw)) return [];
  const out: Parcel[] = [];
  for (const r of raw) {
    if (!isObj(r) || !Number.isInteger(r.id) || (r.id as number) <= 0) continue;
    if (typeof r.poi !== "string" || !POI_OK.has(r.poi as PoiId)) continue;
    if (typeof r.kind !== "string" || !KINDS.includes(r.kind as ValuableKind)) continue;
    const from =
      isObj(r.from) && isParcelFromCode(r.from.code) && typeof r.from.name === "string"
        ? { code: (r.from.code as string) || LOCAL_AID, name: r.from.name }
        : null;
    if (!from) continue;
    out.push({ id: r.id as number, poi: r.poi as PoiId, kind: r.kind as ValuableKind, from, at: typeof r.at === "number" && Number.isFinite(r.at) ? r.at : 0 });
  }
  return out;
}

/** Look-marks left on an island (ux-design M6, async 目印); short live sync is not the goal. */
export function parsePings(raw: unknown): { id: number; x: number; z: number; by: string; until: number }[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r) => {
    if (!isObj(r) || !Number.isInteger(r.id) || !Number.isFinite(r.x) || !Number.isFinite(r.z)) return [];
    if (typeof r.by !== "string" || typeof r.until !== "number") return [];
    return [{ id: r.id as number, x: r.x as number, z: r.z as number, by: r.by, until: r.until }];
  });
}
