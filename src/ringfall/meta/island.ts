import { ISLAND } from "../sim/config";
import type { PoiHold } from "../sim/island";
import { DEPOTS, POIS, poiIndex, type PoiId } from "../sim/map";
import type { State } from "../sim/state";

/*
 * The island between raids: one raid is one day, and every POI is held (支配), thin (手薄) or
 * freed (解放). These are the pure rules that move the island from one day to the next; the
 * raid reads the result as each POI's garrison (sim/island.ts).
 */

/** A POI's standing: who holds it, and the last day the player came into it (0 for never). */
export interface PoiStanding {
  state: PoiHold;
  lastVisit: number;
}

export type Island = Record<PoiId, PoiStanding>;

/** The POI the titan holds: it is never freed, and killing the titan does not change it. */
export const unfreeable = (id: PoiId) => !!POIS[poiIndex(id)].boss;

/** The island before the first raid: every POI held. */
export const newIsland = (): Island => Object.fromEntries(POIS.map((p) => [p.id, { state: "held", lastVisit: 0 }])) as Island;

/** What one raid did to the island: whether the player got off alive, the POIs cleared, and those come into. */
export interface RaidDay {
  alive: boolean;
  cleared: PoiId[];
  visited: PoiId[];
}

/** A raid's day as the island counts it. A record of a raid kept from before visits were counted has visited none. */
export const raidDay = (s: Pick<State, "outcome" | "stats"> & { visited?: boolean[] }): RaidDay => ({
  alive: s.outcome === "extracted",
  cleared: s.stats.cleared.map((i) => POIS[i].id),
  visited: POIS.filter((_, i) => s.visited?.[i]).map((p) => p.id),
});

/** The island part of a profile that a day moves. */
export interface IslandDay {
  day: number;
  poiState: Island;
  depots: PoiId[];
}

/** What moved overnight: POIs freed by the raid, and freed ones gone thin for want of visits. */
export interface DayChange {
  freed: PoiId[];
  thinned: PoiId[];
}

/**
 * Ends the day `p.day` with the raid `r` and starts the next. A visit marks the POI visited
 * today; a POI held or thin that the raid cleared is freed if the player got off alive (its
 * depot switched on with it); a freed POI not visited for `ISLAND.thinAfter` days goes thin.
 * A thin POI stays thin until it is cleared again.
 */
export function advanceDay<P extends IslandDay>(p: P, r: RaidDay): { profile: P; change: DayChange } {
  const today = p.day;
  const freed: PoiId[] = [];
  const thinned: PoiId[] = [];
  const poiState = { ...p.poiState };
  for (const { id } of POIS) {
    const was = p.poiState[id];
    const lastVisit = r.visited.includes(id) || r.cleared.includes(id) ? today : was.lastVisit;
    let state = was.state;
    if (unfreeable(id)) state = "held";
    else if (state !== "freed" && r.alive && r.cleared.includes(id)) {
      state = "freed";
      freed.push(id);
    } else if (state === "freed" && today - lastVisit >= ISLAND.thinAfter) {
      state = "thin";
      thinned.push(id);
    }
    poiState[id] = { state, lastVisit };
  }
  const depots = DEPOTS.map((d) => d.poi).filter((id) => p.depots.includes(id) || freed.includes(id));
  return { profile: { ...p, day: today + 1, poiState, depots }, change: { freed, thinned } };
}

/**
 * Days a freed POI has left before it goes thin, counting the coming raid: 1 means it goes thin
 * unless the next raid comes into it. Null for a POI that is not freed.
 */
export function daysLeft(p: Pick<IslandDay, "day" | "poiState">, id: PoiId): number | null {
  const st = p.poiState[id];
  if (st.state !== "freed") return null;
  return Math.max(1, ISLAND.thinAfter - (p.day - 1 - st.lastVisit));
}

/** One line of 明日の島: what the island does next unless the player acts. */
export type IslandNote = { t: "fading"; poi: PoiId; days: number } | { t: "thin"; poi: PoiId } | { t: "thinned"; poi: PoiId };

/**
 * The island's coming changes, for the map table and the results' 明日の島: POIs just freed or
 * gone thin overnight (when `change` is given), every freed POI's days left before it goes thin,
 * soonest first, and the thin POIs waiting to be freed again.
 */
export function islandNotes(p: Pick<IslandDay, "day" | "poiState">, change?: DayChange): IslandNote[] {
  const out: IslandNote[] = [];
  for (const poi of change?.thinned ?? []) out.push({ t: "thinned", poi });
  const fading = POIS.map((o) => ({ poi: o.id, days: daysLeft(p, o.id) })).filter((x): x is { poi: PoiId; days: number } => x.days !== null);
  for (const f of fading.sort((a, b) => a.days - b.days)) out.push({ t: "fading", ...f });
  for (const o of POIS) if (p.poiState[o.id].state === "thin" && !change?.thinned.includes(o.id)) out.push({ t: "thin", poi: o.id });
  return out;
}

/** A 明日の島 line in words. */
export function noteText(n: IslandNote): string {
  const name = POIS[poiIndex(n.poi)].name;
  switch (n.t) {
    case "fading":
      return n.days <= 1 ? `${name}は次のレイドで訪れないと手薄になる` : `${name}はあと ${n.days} 日訪れないと手薄になる`;
    case "thinned":
      return `${name}は訪れないうちに手薄になった。片付けて生きて帰れば解放に戻る`;
    case "thin":
      return `${name}は手薄。守備隊を片付けて生きて帰れば解放に戻る`;
  }
}

/** POIs that go thin unless the next raid comes into them. */
export const thinTomorrow = (p: Pick<IslandDay, "day" | "poiState">) => POIS.map((o) => o.id).filter((id) => daysLeft(p, id) === 1);

/** Each POI's standing for a raid's start (`Start.island`). */
export const holds = (p: Pick<IslandDay, "poiState">): Partial<Record<PoiId, PoiHold>> => Object.fromEntries(POIS.map((o) => [o.id, p.poiState[o.id].state]));

/** A saved island; anything unreadable is held and unvisited. The titan's pad is always held. */
export function parseIsland(raw: unknown, day: number): Island {
  const out = newIsland();
  if (!raw || typeof raw !== "object") return out;
  const o = raw as Record<string, unknown>;
  for (const { id } of POIS) {
    const x = o[id] as Record<string, unknown> | undefined;
    if (!x || typeof x !== "object") continue;
    const state = (["held", "thin", "freed"] as const).find((h) => h === x.state) ?? "held";
    const lastVisit = Number.isInteger(x.lastVisit) ? Math.max(0, Math.min(day, x.lastVisit as number)) : 0;
    out[id] = { state: unfreeable(id) ? "held" : state, lastVisit };
  }
  return out;
}
