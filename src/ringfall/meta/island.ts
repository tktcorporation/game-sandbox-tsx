import { EVENTS, ISLAND, NETWORK, type EventKind } from "../sim/config";
import { crewsFor, type IslandEvent, type PoiHold } from "../sim/island";
import { DEBRIS_SPOTS, debrisIndex, DEPOTS, POIS, poiIndex, RELAYS, relayIndex, type DebrisId, type PoiId, type RelayId } from "../sim/map";
import { mix, retakeKey, type State } from "../sim/state";

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
  /** Salvage crews that got off with their bags. */
  crews?: number;
  /** The freed POI whose retake squad the raid left alive, or null. */
  retake?: PoiId | null;
}

/**
 * A raid's day as the island counts it. A record of a raid kept from before visits were counted
 * has visited none, and one from before the masts destroyed none. The titan fell when its pad
 * was cleared: its fall takes the pad's other robots with it.
 */
export const raidDay = (s: Pick<State, "outcome" | "stats"> & { visited?: boolean[]; event?: IslandEvent | null }): RaidDay => ({
  alive: s.outcome === "extracted",
  cleared: s.stats.cleared.map((i) => POIS[i].id),
  visited: POIS.filter((_, i) => s.visited?.[i]).map((p) => p.id),
  titan: s.stats.cleared.some((i) => !!POIS[i].boss),
  relays: (s.stats.relays ?? []).filter((id, n, all) => relayIndex(id) >= 0 && all.indexOf(id) === n),
  crews: s.stats.crewsOut ?? 0,
  // A retake squad that never beamed in (the raid was over first) was not destroyed either.
  retake: s.event?.t === "retake" && !(s.stats.wiped ?? []).includes(retakeKey(s.event.poi)) ? s.event.poi : null,
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
  /** The next raid's seed: the day after tomorrow's event is drawn from it and the day. */
  seed?: number;
  /** The island's events: today's (the next raid's) and tomorrow's, announced a day ahead. */
  events?: DayEvents;
}

/** Today's event and tomorrow's: each null on a quiet day. */
export type DayEvents = [IslandEvent | null, IslandEvent | null];

/** How the network moved overnight, and why: the steps each cause took it down, and the steps it rose. */
export interface NetChange {
  from: number;
  to: number;
  freed: number;
  titan: number;
  relays: number;
  rise: number;
  /** Steps up for the salvage crews that got off. */
  crews?: number;
}

/** What moved overnight: POIs freed by the raid, freed ones gone thin for want of visits, thin ones taken back, and the network. */
export interface DayChange {
  freed: PoiId[];
  thinned: PoiId[];
  retaken: PoiId[];
  /** Freed POIs gone thin because the day's retake squad was left alive. */
  overrun: PoiId[];
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
 * from day to day, so a step down never wipes what the network has gathered; while the network
 * stands at the top it gathers none, so a step taken off it holds for a while.
 *
 * Last, a thin POI thin for `NETWORK.retakeAfter` days goes back to held while the network
 * stands at `NETWORK.retakeAt` or higher; otherwise it stays thin until it is cleared again.
 */
export function advanceDay<P extends IslandDay>(p: P, r: RaidDay): { profile: P; change: DayChange } {
  const today = p.day;
  const freed: PoiId[] = [];
  const thinned: PoiId[] = [];
  const retaken: PoiId[] = [];
  const overrun: PoiId[] = [];
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
    } else if (state === "freed" && r.retake === id) {
      // The retake squad stood at its way in when the day ended: the network has half of it back.
      state = "thin";
      since = today + 1;
      overrun.push(id);
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
  let pressure = p.pressure + netGain(poiState);
  let rise = 0;
  while (pressure >= NETWORK.riseEvery && down + rise < NETWORK.max) {
    pressure -= NETWORK.riseEvery;
    rise++;
  }
  // Each salvage crew that got off with its bag fed the network: a step on top of the day's rise.
  const crews = Math.min(r.crews ?? 0, NETWORK.max - down - rise);
  const network = down + rise + crews;
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
  // Yesterday's forecast becomes today's event, and tomorrow's is drawn on the island as it now stands.
  const events: DayEvents = [settleEvent(p.events?.[1] ?? null, p.seed ?? 0, today + 1, poiState), eventFor(p.seed ?? 0, today + 2, poiState)];
  return {
    profile: { ...p, day: today + 1, poiState, depots, network, pressure, events },
    change: { freed, thinned, retaken, overrun, network: { from: p.network, to: network, ...steps, rise, crews } },
  };
}

/** A hash of the seed, the day and a salt: the event schedule draws on nothing else. */
const dayHash = (seed: number, day: number, k: number) => mix(Math.imul(seed + 1, 0x9e3779b1) ^ Math.imul(day + 11, 0x85ebca6b) ^ Math.imul(k + 1, 0xc2b2ae35));

/** The POIs a retake may be sent to: those freed. */
const retakable = (poiState: Record<PoiId, { state: PoiHold }>) => POIS.filter((o) => poiState[o.id].state === "freed").map((o) => o.id);

/**
 * The event of day `day`, drawn from `seed` and the day: one day in `1 / EVENTS.chance` or so has
 * one, picked by `EVENTS.weights` among those the island allows. A retake needs a freed POI, and
 * comes more often the more are freed (its weight grows with them up to three); it names one of them.
 */
export function eventFor(seed: number, day: number, poiState: Record<PoiId, { state: PoiHold }>): IslandEvent | null {
  if ((dayHash(seed, day, 0) % 10_000) / 10_000 >= EVENTS.chance) return null;
  const freed = retakable(poiState);
  const weights = (Object.keys(EVENTS.weights) as EventKind[]).map((k): [EventKind, number] => [k, k === "retake" ? (EVENTS.weights.retake * Math.min(freed.length, 3)) / 2 : EVENTS.weights[k]]).filter(([, w]) => w > 0);
  let r = ((dayHash(seed, day, 1) % 10_000) / 10_000) * weights.reduce((n, [, w]) => n + w, 0);
  const kind = weights.find(([, w]) => (r -= w) < 0)?.[0] ?? weights[weights.length - 1][0];
  switch (kind) {
    case "debris":
      return { t: "debris", spot: DEBRIS_SPOTS[dayHash(seed, day, 2) % DEBRIS_SPOTS.length].id };
    case "retake":
      return { t: "retake", poi: freed[dayHash(seed, day, 3) % freed.length] };
    case "storm":
      return { t: "storm" };
    case "crews":
      return { t: "crews" };
  }
}

/**
 * The forecast event as it comes on its day: a retake whose POI is no longer freed goes to
 * another freed one (drawn as the forecast was), and with none freed it does not come.
 */
function settleEvent(ev: IslandEvent | null, seed: number, day: number, poiState: Record<PoiId, { state: PoiHold }>): IslandEvent | null {
  if (ev?.t !== "retake" || poiState[ev.poi].state === "freed") return ev;
  const freed = retakable(poiState);
  return freed.length ? { t: "retake", poi: freed[dayHash(seed, day, 3) % freed.length] } : null;
}

/** The schedule of a profile before the first raid: a quiet first day, and the second's drawn. */
export const firstEvents = (seed: number, poiState: Record<PoiId, { state: PoiHold }>): DayEvents => [null, eventFor(seed, 2, poiState)];

/** A saved event; null for anything unreadable. */
export function parseEvent(raw: unknown): IslandEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const x = raw as Record<string, unknown>;
  if (x.t === "storm" || x.t === "crews") return { t: x.t };
  if (x.t === "debris" && typeof x.spot === "string" && debrisIndex(x.spot as DebrisId) >= 0) return { t: "debris", spot: x.spot as DebrisId };
  if (x.t === "retake" && typeof x.poi === "string" && poiIndex(x.poi as PoiId) >= 0 && !unfreeable(x.poi as PoiId)) return { t: "retake", poi: x.poi as PoiId };
  return null;
}

/** An event's name. */
export const eventName = (ev: IslandEvent) => EVENTS.names[ev.t];

/** What an event does, in a line, for a raid at network `level`. */
export function eventText(ev: IslandEvent, level: number): string {
  switch (ev.t) {
    case "debris": {
      const d = DEBRIS_SPOTS[debrisIndex(ev.spot)];
      return `${d.place}に輪の破片が落ちる。珍しい回収品の箱を、ヘビーとドローン 2 機が守る`;
    }
    case "retake": {
      const name = POIS[poiIndex(ev.poi)].name;
      return `網が${name}へ奪還部隊を送る。倒さないと、その夜に${name}が手薄になる`;
    }
    case "storm":
      return "自分の視界も、ロボットの見える距離も 6 割になる。近づいてから撃つ日";
    case "crews":
      return `回収部隊が ${crewsFor(level, ev)} 組来て、箱を先に漁る。迎撃の依頼が出る`;
  }
}

/** Days until the network rises a step at today's pace (counting the coming raid), or null at the top. */
export function riseIn(p: Pick<IslandDay, "network" | "pressure" | "poiState">): number | null {
  if (p.network >= NETWORK.max) return null;
  return Math.max(1, Math.ceil((NETWORK.riseEvery - p.pressure) / netGain(p.poiState) - 1e-9));
}

/**
 * Days a thin POI has left before the network takes it back (counting the coming raid), or null
 * when it will not unless the player lets the network rise further. The night's rise comes before
 * its retakes (`advanceDay()`), so a network one step short takes the POI back on the night it rises.
 */
export function retakeIn(p: Pick<IslandDay, "day" | "network" | "pressure" | "poiState">, id: PoiId): number | null {
  const st = p.poiState[id];
  if (st.state !== "thin") return null;
  const old = Math.max(1, st.since + NETWORK.retakeAfter - p.day);
  if (p.network >= NETWORK.retakeAt) return old;
  const rise = p.network + 1 >= NETWORK.retakeAt ? riseIn(p) : null;
  return rise === null ? null : Math.max(old, rise);
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
  const why = [n.freed ? `解放 −${n.freed}` : "", n.titan ? `タイタン −${n.titan}` : "", n.relays ? `中継器 −${n.relays}` : "", n.rise ? `日の経過 +${n.rise}` : "", n.crews ? `回収部隊 +${n.crews}` : ""].filter(Boolean);
  return `網 ${n.from} → ${n.to}${why.length ? `（${why.join("・")}）` : "（変わらず）"}`;
}

/** The relay masts' names, for contracts and the map. */
export const relayName = (id: RelayId) => RELAYS[relayIndex(id)].name;

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
export type IslandNote =
  | { t: "fading"; poi: PoiId; days: number }
  | { t: "thin"; poi: PoiId }
  | { t: "thinned"; poi: PoiId }
  | { t: "retake"; poi: PoiId; days: number }
  | { t: "retaken"; poi: PoiId }
  | { t: "rise"; days: number; to: number }
  | { t: "top" }
  | { t: "overrun"; poi: PoiId }
  | { t: "crews"; n: number };

/**
 * The island's coming changes, for the map table and the results' 明日の島: POIs just freed or
 * gone thin overnight (when `change` is given), every freed POI's days left before it goes thin,
 * soonest first, and the thin POIs waiting to be freed again.
 */
export function islandNotes(p: Pick<IslandDay, "day" | "poiState" | "network" | "pressure">, change?: Pick<DayChange, "thinned" | "retaken"> & Partial<Pick<DayChange, "overrun" | "network">>): IslandNote[] {
  const out: IslandNote[] = [];
  const rise = riseIn(p);
  out.push(rise === null ? { t: "top" } : { t: "rise", days: rise, to: p.network + 1 });
  if (change?.network?.crews) out.push({ t: "crews", n: change.network.crews });
  for (const poi of change?.overrun ?? []) out.push({ t: "overrun", poi });
  for (const poi of change?.retaken ?? []) out.push({ t: "retaken", poi });
  for (const poi of change?.thinned ?? []) out.push({ t: "thinned", poi });
  const overrun = change?.overrun ?? [];
  const fading = POIS.map((o) => ({ poi: o.id, days: daysLeft(p, o.id) })).filter((x): x is { poi: PoiId; days: number } => x.days !== null);
  for (const f of fading.sort((a, b) => a.days - b.days)) out.push({ t: "fading", ...f });
  for (const o of POIS) {
    if (p.poiState[o.id].state !== "thin" || change?.thinned.includes(o.id) || overrun.includes(o.id)) continue;
    const days = retakeIn(p, o.id);
    out.push(days === null ? { t: "thin", poi: o.id } : { t: "retake", poi: o.id, days });
  }
  return out;
}

/** A 明日の島 line in words. */
export function noteText(n: IslandNote): string {
  if (n.t === "rise") return n.days <= 1 ? `網は次のレイドの後に ${n.to} に上がる` : `網はあと ${n.days} 日で ${n.to} に上がる`;
  if (n.t === "top") return "網は最大。拠点を解放するか中継器を壊すと下がる";
  if (n.t === "crews") return `回収部隊が ${n.n} 組、カバンを持って逃げた。網が ${n.n} 段多く上がった`;
  const name = POIS[poiIndex(n.poi)].name;
  switch (n.t) {
    case "retake":
      return n.days <= 1 ? `${name}は手薄。網が強く、次のレイドの後に支配に戻る` : `${name}は手薄。網が強く、あと ${n.days} 日で支配に戻る`;
    case "retaken":
      return `${name}は網に取り戻され、支配に戻った`;
    case "fading":
      return n.days <= 1 ? `${name}は次のレイドで訪れないと手薄になる` : `${name}はあと ${n.days} 日訪れないと手薄になる`;
    case "overrun":
      return `${name}は奪還部隊に取られ、手薄になった。片付けて生きて帰れば解放に戻る`;
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
    const st = unfreeable(id) ? "held" : state;
    // A thin POI saved before thin ones were dated counts as thin since the save's day.
    const since = st === "thin" ? (Number.isInteger(x.since) && (x.since as number) >= 1 ? Math.min(day, x.since as number) : day) : 0;
    out[id] = { state: st, lastVisit, since };
  }
  return out;
}
