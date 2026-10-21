import { ISLAND, NETWORK } from "../sim/config";
import type { PoiHold } from "../sim/island";
import { DEPOTS, POIS, poiIndex, RELAYS, relayIndex, type PoiId, type RelayId } from "../sim/map";
import type { State } from "../sim/state";

/*
 * The island between raids: one raid is one day, and every POI is held (支配), thin (手薄) or
 * freed (解放). These are the pure rules that move the island from one day to the next; the
 * raid reads the result as each POI's garrison (sim/island.ts).
 */

/** A POI's standing: who holds it, the last day the player came into it (0 for never), and the day it went thin (0 unless thin). */
export interface PoiStanding {
  state: PoiHold;
  lastVisit: number;
  since: number;
}

export type Island = Record<PoiId, PoiStanding>;

/** The POI the titan holds: it is never freed, and killing the titan does not change it. */
export const unfreeable = (id: PoiId) => !!POIS[poiIndex(id)].boss;

/** The island before the first raid: every POI held. */
export const newIsland = (): Island => Object.fromEntries(POIS.map((p) => [p.id, { state: "held", lastVisit: 0, since: 0 }])) as Island;

/**
 * What one raid did to the island: whether the player got off alive, the POIs cleared, those
 * come into, whether the titan fell, and the relay masts destroyed.
 */
export interface RaidDay {
  alive: boolean;
  cleared: PoiId[];
  visited: PoiId[];
  titan: boolean;
  relays: RelayId[];
}

/**
 * A raid's day as the island counts it. A record of a raid kept from before visits were counted
 * has visited none, and one from before the masts destroyed none. The titan fell when its pad
 * was cleared: its fall takes the pad's other robots with it.
 */
export const raidDay = (s: Pick<State, "outcome" | "stats"> & { visited?: boolean[] }): RaidDay => ({
  alive: s.outcome === "extracted",
  cleared: s.stats.cleared.map((i) => POIS[i].id),
  visited: POIS.filter((_, i) => s.visited?.[i]).map((p) => p.id),
  titan: s.stats.cleared.some((i) => !!POIS[i].boss),
  relays: (s.stats.relays ?? []).filter((id, n, all) => relayIndex(id) >= 0 && all.indexOf(id) === n),
});

/** The island part of a profile that a day moves. */
export interface IslandDay {
  day: number;
  poiState: Island;
  depots: PoiId[];
  /** The robots' network level, 0 to `NETWORK.max`. */
  network: number;
  /** What the network has gathered toward its next step (`NETWORK.riseEvery` makes one). */
  pressure: number;
}

/** How the network moved overnight, and why: the steps each cause took it down, and the steps it rose. */
export interface NetChange {
  from: number;
  to: number;
  freed: number;
  titan: number;
  relays: number;
  rise: number;
}

/** What moved overnight: POIs freed by the raid, freed ones gone thin for want of visits, thin ones taken back, and the network. */
export interface DayChange {
  freed: PoiId[];
  thinned: PoiId[];
  retaken: PoiId[];
  network: NetChange;
}

/** The pressure a day adds to the network: more the more POIs the robots hold (the titan's pad aside, always theirs). */
export function netGain(poiState: Record<PoiId, { state: PoiHold }>): number {
  const weight = POIS.filter((o) => !unfreeable(o.id)).reduce((n, o) => n + (poiState[o.id].state === "held" ? 1 : poiState[o.id].state === "thin" ? NETWORK.thinWeight : 0), 0);
  return NETWORK.base + NETWORK.perHeld * weight;
}

const clampNet = (n: number) => Math.max(0, Math.min(NETWORK.max, n));

/**
 * Ends the day `p.day` with the raid `r` and starts the next. A visit marks the POI visited
 * today; a POI held or thin that the raid cleared is freed if the player got off alive (its
 * depot switched on with it); a freed POI not visited for `ISLAND.thinAfter` days goes thin.
 *
 * Then the network: down a step for each POI freed from held (the relay two; one less from thin), for the titan's fall and
 * for each relay mast destroyed, then up a step for each `NETWORK.riseEvery` of pressure the
 * day adds (`netGain()`, counted on the POIs as they stand once freed). The pressure is carried
 * from day to day, so a step down never wipes what the network has gathered. A day that starts
 * with the network at the top adds no pressure, even when the raid takes it down, and the
 * pressure is empty whenever the network ends the day at the top: a step taken off the top holds
 * for a while instead of springing back the next night.
 *
 * Last, a thin POI thin for `NETWORK.retakeAfter` days goes back to held while the network
 * stands at `NETWORK.retakeAt` or higher; otherwise it stays thin until it is cleared again.
 */
export function advanceDay<P extends IslandDay>(p: P, r: RaidDay): { profile: P; change: DayChange } {
  const today = p.day;
  const freed: PoiId[] = [];
  const thinned: PoiId[] = [];
  const retaken: PoiId[] = [];
  const poiState = { ...p.poiState };
  for (const { id } of POIS) {
    const was = p.poiState[id];
    const lastVisit = r.visited.includes(id) || r.cleared.includes(id) ? today : was.lastVisit;
    let state = was.state;
    let since = was.since;
    if (unfreeable(id)) state = "held";
    else if (state !== "freed" && r.alive && r.cleared.includes(id)) {
      state = "freed";
      freed.push(id);
    } else if (state === "freed" && today - lastVisit >= ISLAND.thinAfter) {
      state = "thin";
      since = today + 1;
      thinned.push(id);
    }
    poiState[id] = { state, lastVisit, since: state === "thin" ? since : 0 };
  }
  const steps = {
    // A thin POI was half lost to the network already: freeing it again costs the network a step less.
    freed: freed.reduce((n, id) => n + (id === "relay" ? NETWORK.relayPoi : 1) - (p.poiState[id].state === "thin" ? 1 : 0), 0),
    titan: r.titan ? 1 : 0,
    relays: r.relays.length,
  };
  const down = clampNet(p.network - steps.freed - steps.titan - steps.relays);
  let pressure = p.pressure + (p.network < NETWORK.max ? netGain(poiState) : 0);
  let rise = 0;
  while (pressure >= NETWORK.riseEvery && down + rise < NETWORK.max) {
    pressure -= NETWORK.riseEvery;
    rise++;
  }
  const network = down + rise;
  if (network >= NETWORK.max) pressure = 0;
  if (network >= NETWORK.retakeAt)
    for (const { id } of POIS) {
      const st = poiState[id];
      if (st.state === "thin" && today + 1 - st.since >= NETWORK.retakeAfter) {
        poiState[id] = { ...st, state: "held", since: 0 };
        retaken.push(id);
      }
    }
  const depots = DEPOTS.map((d) => d.poi).filter((id) => p.depots.includes(id) || freed.includes(id));
  return {
    profile: { ...p, day: today + 1, poiState, depots, network, pressure },
    change: { freed, thinned, retaken, network: { from: p.network, to: network, ...steps, rise } },
  };
}

/** How far ahead the forecasts look: an event further off than this is told as not coming. */
export const FORECAST_DAYS = 30;

/** The day the forecasts assume for every coming raid: nothing visited, cleared or destroyed. */
const IDLE: RaidDay = { alive: true, cleared: [], visited: [], titan: false, relays: [] };

/**
 * The first of the coming idle days (1 being the coming raid's) after which `done` holds of the
 * island, stepping `advanceDay()` itself so that a forecast follows every nightly rule; null if
 * none within `FORECAST_DAYS`.
 */
function idleDaysUntil(p: Pick<IslandDay, "day" | "network" | "pressure" | "poiState">, done: (q: IslandDay) => boolean): number | null {
  let q: IslandDay = { day: p.day, poiState: p.poiState, depots: [], network: p.network, pressure: p.pressure };
  for (let d = 1; d <= FORECAST_DAYS; d++) {
    q = advanceDay(q, IDLE).profile;
    if (done(q)) return d;
  }
  return null;
}

/** Days until the network rises above its level if the player frees nothing (counting the coming raid), or null when it does not in `FORECAST_DAYS`, as at the top. */
export function riseIn(p: Pick<IslandDay, "day" | "network" | "pressure" | "poiState">): number | null {
  return idleDaysUntil(p, (q) => q.network > p.network);
}

/**
 * Days until the network takes a thin POI back to held if the player frees nothing (counting
 * the coming raid), or null for a POI that is not thin or is not taken back in `FORECAST_DAYS`.
 */
export function retakeIn(p: Pick<IslandDay, "day" | "network" | "pressure" | "poiState">, id: PoiId): number | null {
  if (p.poiState[id].state !== "thin") return null;
  return idleDaysUntil(p, (q) => q.poiState[id].state === "held");
}

/** Whether the relay masts stand in a raid at network `level`. */
export const relaysUp = (level: number) => level >= NETWORK.relayAt;

/** The network level as the map table words it: 「網 3：増援が早い・レイダーが 10 分」. */
export function networkText(level: number): string {
  const l = NETWORK.levels[level];
  return `網 ${level}：${l.note}・レイダーが ${Math.round(l.raiders / 60)} 分`;
}

/** The overnight change of the network, with its causes: 「網 2 → 3（解放 −1・日の経過 +1）」. */
export function netChangeText(n: NetChange): string {
  const why = [n.freed ? `解放 −${n.freed}` : "", n.titan ? `タイタン −${n.titan}` : "", n.relays ? `中継器 −${n.relays}` : "", n.rise ? `日の経過 +${n.rise}` : ""].filter(Boolean);
  return `網 ${n.from} → ${n.to}${why.length ? `（${why.join("・")}）` : "（変わらず）"}`;
}

/** The relay masts' names, for contracts and the map. */
export const relayName = (id: RelayId) => RELAYS[relayIndex(id)].name;

/**
 * Days a freed POI has left before it goes thin, counting the coming raid: 1 means it goes thin
 * unless the next raid comes into it. Null for a POI that is not freed.
 */
export function daysLeft(p: Pick<IslandDay, "day" | "network" | "pressure" | "poiState">, id: PoiId): number | null {
  if (p.poiState[id].state !== "freed") return null;
  return idleDaysUntil(p, (q) => q.poiState[id].state !== "freed");
}

/** One line of 明日の島: what the island does next unless the player acts. */
export type IslandNote =
  | { t: "fading"; poi: PoiId; days: number }
  | { t: "thin"; poi: PoiId }
  | { t: "thinned"; poi: PoiId }
  | { t: "retake"; poi: PoiId; days: number }
  | { t: "retaken"; poi: PoiId }
  | { t: "rise"; days: number; to: number }
  | { t: "top" };

/**
 * The island's coming changes, for the map table and the results' 明日の島: POIs just freed or
 * gone thin overnight (when `change` is given), every freed POI's days left before it goes thin,
 * soonest first, and the thin POIs waiting to be freed again.
 */
export function islandNotes(p: Pick<IslandDay, "day" | "poiState" | "network" | "pressure">, change?: Pick<DayChange, "thinned" | "retaken">): IslandNote[] {
  const out: IslandNote[] = [];
  const rise = riseIn(p);
  out.push(rise === null ? { t: "top" } : { t: "rise", days: rise, to: p.network + 1 });
  for (const poi of change?.retaken ?? []) out.push({ t: "retaken", poi });
  for (const poi of change?.thinned ?? []) out.push({ t: "thinned", poi });
  const fading = POIS.map((o) => ({ poi: o.id, days: daysLeft(p, o.id) })).filter((x): x is { poi: PoiId; days: number } => x.days !== null);
  for (const f of fading.sort((a, b) => a.days - b.days)) out.push({ t: "fading", ...f });
  for (const o of POIS) {
    if (p.poiState[o.id].state !== "thin" || change?.thinned.includes(o.id)) continue;
    const days = retakeIn(p, o.id);
    out.push(days === null ? { t: "thin", poi: o.id } : { t: "retake", poi: o.id, days });
  }
  return out;
}

/** A 明日の島 line in words. */
export function noteText(n: IslandNote): string {
  if (n.t === "rise") return n.days <= 1 ? `網は次のレイドの後に ${n.to} に上がる` : `網はあと ${n.days} 日で ${n.to} に上がる`;
  if (n.t === "top") return "網は最大。拠点を解放するか中継器を壊すと下がる";
  const name = POIS[poiIndex(n.poi)].name;
  switch (n.t) {
    case "retake":
      return n.days <= 1 ? `${name}は手薄。放っておくと、次のレイドの後に支配に戻る` : `${name}は手薄。放っておくと、あと ${n.days} 日で支配に戻る`;
    case "retaken":
      return `${name}は網に取り戻され、支配に戻った`;
    case "fading":
      return n.days <= 1 ? `${name}は次のレイドで訪れないと手薄になる` : `${name}はあと ${n.days} 日訪れないと手薄になる`;
    case "thinned":
      return `${name}は訪れないうちに手薄になった。片付けて生きて帰れば解放に戻る`;
    case "thin":
      return `${name}は手薄。守備隊を片付けて生きて帰れば解放に戻る`;
  }
}

/** POIs that go thin unless the next raid comes into them. */
export const thinTomorrow = (p: Pick<IslandDay, "day" | "network" | "pressure" | "poiState">) => POIS.map((o) => o.id).filter((id) => daysLeft(p, id) === 1);

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
    const st = unfreeable(id) ? "held" : state;
    // A thin POI saved before thin ones were dated counts as thin since the save's day.
    const since = st === "thin" ? (Number.isInteger(x.since) && (x.since as number) >= 1 ? Math.min(day, x.since as number) : day) : 0;
    out[id] = { state: st, lastVisit, since };
  }
  return out;
}
