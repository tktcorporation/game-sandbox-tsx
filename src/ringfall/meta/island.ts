import { EVENTS, FRONT, ISLAND, NETWORK, THREAT, type EventKind } from "../sim/config";
import { crewsFor, type IslandEvent, type PoiHold } from "../sim/island";
import { DEBRIS_SPOTS, debrisIndex, DEPOTS, NODES, nodeIndex, OUTPOST_SITES, POIS, poiIndex, RELAYS, relayIndex, territory, type DebrisId, type NodeId, type OutpostId, type PoiId, type RelayId } from "../sim/map";
import { CAMP_NEXT, capturedIds, interiorNodes, NEIGHBOURS, newOutposts, nodeHolds, type NodeHold, type OutpostHold } from "../sim/front";
import type { Battle } from "../sim/battle";
import { mix, retakeKey, type State } from "../sim/state";

/*
 * The island between raids: one raid is one day, and every POI is held (支配), thin (手薄) or
 * freed (解放); every outpost is the network's, the rogues' or freed. These are the pure rules
 * that move the island from one day to the next; the raid reads the result as each POI's
 * garrison (sim/island.ts) and each node's standing on the front (sim/front.ts).
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
 * What one raid did to the island: whether the player got off alive, the POIs cleared of robots,
 * the nodes taken by their cores, those come into, whether the titan fell, and the relay masts destroyed.
 */
export interface RaidDay {
  alive: boolean;
  cleared: PoiId[];
  /** Nodes whose core the raid captured (`NODES` ids): freed if the player got off alive, left thin if not. */
  captured?: NodeId[];
  /** Outposts the raid came near (`FRONT.visit`). */
  outposts?: OutpostId[];
  visited: PoiId[];
  titan: boolean;
  relays: RelayId[];
  /** Salvage crews that got off with their bags. */
  crews?: number;
  /** The freed POI whose retake squad the raid left alive, or null. */
  retake?: PoiId | null;
  /** The threat the raid was played at (`THREAT`); left out, 0. */
  threat?: number;
  /** The day's battle (sim/battle.ts), reckoned to its end; left out, the raid had none. */
  battle?: BattleDay;
}

/**
 * What the day's battle did to the island: whether the player won it and the points, the nodes
 * the player's own robots took and held to the end (`gained`), and the nodes of the player's the
 * other sides took and held (`lost`). The nodes the player took by their cores are in `captured`.
 */
export interface BattleDay {
  won: boolean;
  score: [number, number, number];
  gained: NodeId[];
  lost: NodeId[];
}

/**
 * A raid's day as the island counts it. A record of a raid kept from before visits were counted
 * has visited none, and one from before the masts destroyed none. The titan fell when its pad
 * was cleared: its fall takes the pad's other robots with it.
 */
export const raidDay = (s: Pick<State, "outcome" | "stats"> & { visited?: boolean[]; nodeVisited?: boolean[]; event?: IslandEvent | null; threat?: number; battle?: Battle | null; nodes?: NodeHold[] }): RaidDay => ({
  alive: s.outcome === "extracted",
  cleared: s.stats.cleared.map((i) => POIS[i].id),
  // In a battle, a node the player took counts only if it was still the player's at the battle's end.
  captured: capturedIds(s).filter((id) => !s.battle || !s.nodes || s.nodes[nodeIndex(id)] === "freed"),
  battle: s.battle && s.nodes ? battleDay(s.battle, s.nodes, capturedIds(s)) : undefined,
  outposts: OUTPOST_SITES.filter((o) => s.nodeVisited?.[NODES.findIndex((n) => n.id === o.id)]).map((o) => o.id),
  visited: POIS.filter((_, i) => s.visited?.[i]).map((p) => p.id),
  titan: s.stats.cleared.some((i) => !!POIS[i].boss),
  relays: (s.stats.relays ?? []).filter((id, n, all) => relayIndex(id) >= 0 && all.indexOf(id) === n),
  crews: s.stats.crewsOut ?? 0,
  // A retake squad that never beamed in (the raid was over first) was not destroyed either.
  retake: s.event?.t === "retake" && !(s.stats.wiped ?? []).includes(retakeKey(s.event.poi)) ? s.event.poi : null,
  threat: s.threat ?? 0,
});

/** What a battle reckoned to its end did, from the nodes as it began and as it ended. */
export function battleDay(b: Battle, end: readonly NodeHold[], captured: NodeId[]): BattleDay {
  return {
    won: b.won,
    score: [Math.round(b.score[0]), Math.round(b.score[1]), Math.round(b.score[2])],
    gained: NODES.filter((n, i) => end[i] === "freed" && b.start[i] !== "freed" && !captured.includes(n.id)).map((n) => n.id),
    lost: NODES.filter((_, i) => b.start[i] === "freed" && end[i] !== "freed").map((n) => n.id),
  };
}

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
  /** Who holds each outpost; left out, each stands as `territory()` gives it at `network` (none freed). */
  outposts?: Record<OutpostId, OutpostHold>;
  /** The last day the player came to each freed outpost (or freed it). */
  outpostVisit?: Partial<Record<OutpostId, number>>;
}

/** What the forecasts and the maps read of an island day. */
export type IslandView = Pick<IslandDay, "day" | "network" | "pressure" | "poiState"> & Partial<Pick<IslandDay, "outposts" | "outpostVisit">>;

/** Each node's standing on an island day (sim/front.ts). */
export const islandHolds = (p: Pick<IslandDay, "poiState" | "network"> & Partial<Pick<IslandDay, "outposts">>): NodeHold[] => nodeHolds((id) => p.poiState[id].state, p.outposts, p.network);

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
  /** Steps down on top of `freed` for POIs freed at a high threat (`THREAT.freeAt`). */
  threat?: number;
}

/** The day's battle as the night counts it: won or lost, the points, and the node of the player's the network took for a lost battle (null for none). */
export interface BattleChange {
  won: boolean;
  score: [number, number, number];
  gained: NodeId[];
  lost: NodeId[];
  forfeit: NodeId | null;
}

/** What moved overnight: POIs freed by the raid, freed ones gone thin for want of visits, thin ones taken back, and the network. */
export interface DayChange {
  freed: PoiId[];
  /** Outposts freed by the raid. */
  outposts: OutpostId[];
  /** POIs whose core the raid captured before it was wiped: they are thin. */
  dropped: PoiId[];
  /** The front's move overnight: the nodes that turned the player's, and those that stopped being so. */
  front: { gained: NodeId[]; lost: NodeId[] };
  thinned: PoiId[];
  retaken: PoiId[];
  /** Freed POIs gone thin because the day's retake squad was left alive. */
  overrun: PoiId[];
  network: NetChange;
  /** The day's battle, or null for a raid that had none. */
  battle: BattleChange | null;
}

/** The pressure a day adds to the network: more the more POIs the robots hold (the titan's pad aside, always theirs). */
export function netGain(poiState: Record<PoiId, { state: PoiHold }>): number {
  const weight = POIS.filter((o) => !unfreeable(o.id)).reduce((n, o) => n + (poiState[o.id].state === "held" ? 1 : poiState[o.id].state === "thin" ? NETWORK.thinWeight : 0), 0);
  return NETWORK.base + NETWORK.perHeld * weight;
}

const clampNet = (n: number) => Math.max(0, Math.min(NETWORK.max, n));

/**
 * Ends the day `p.day` with the raid `r` and starts the next. A visit marks the POI visited
 * today. A node not freed whose core the raid captured (sim/front.ts) is freed if the player got
 * off alive (a POI's depot switched on with it); a POI captured by a raid that was wiped stays
 * thin. Clearing a POI of its robots frees nothing. A freed POI on the front's edge, that is with
 * a neighbour the player does not hold (`interiorNodes()`), goes thin when not visited for
 * `ISLAND.thinAfter` days or when the day's retake squad was left alive; one deep in the
 * player's ground does neither. A freed outpost on the edge not come near (`FRONT.visit`) for
 * `ISLAND.thinAfter` days is lost (it has no thin standing); the outposts the player does not
 * hold stand overnight as `territory()` gives them at the network's new level.
 *
 * Then the network: down a step for each POI freed, held or thin (the relay two)
 * and one more for each when the raid was played at `THREAT.freeAt` or higher, a step for the
 * titan's fall, and a step for each relay mast destroyed (`NETWORK.relayHigh.steps` on a day that
 * started at `NETWORK.relayHigh.at` or higher), then up a step for each `NETWORK.riseEvery` of pressure the
 * day adds (`netGain()`, counted on the POIs as they stand once freed). An outpost freed takes
 * the network down no step. The pressure is carried
 * from day to day, so a step down never wipes what the network has gathered. A day that starts
 * with the network at the top adds no pressure, even when the raid takes it down, and the
 * pressure is empty whenever the network ends the day at the top: a step taken off the top holds
 * for a while instead of springing back the next night.
 *
 * Last, a thin POI thin for `NETWORK.retakeAfter` days goes back to held while the network
 * stands at `NETWORK.retakeAt` or higher; otherwise it stays thin until it is captured again.
 */
export function advanceDay<P extends IslandDay>(p: P, r: RaidDay): { profile: P; change: DayChange } {
  const today = p.day;
  const freed: PoiId[] = [];
  const thinned: PoiId[] = [];
  const retaken: PoiId[] = [];
  const overrun: PoiId[] = [];
  const dropped: PoiId[] = [];
  const bt = r.battle;
  // The player's own robots' captures stand however the raid ended; the player's, only if they got off alive.
  const captured = r.captured ?? [];
  const gained = bt?.gained ?? [];
  const lostInBattle = bt?.lost ?? [];
  const before = islandHolds(p);
  const poiState = { ...p.poiState };
  const outposts = { ...(p.outposts ?? newOutposts(p.network)) };
  for (const { id } of POIS) {
    const was = p.poiState[id];
    const lastVisit = r.visited.includes(id) || r.cleared.includes(id) || captured.includes(id as NodeId) ? today : was.lastVisit;
    let state = was.state;
    let since = was.since;
    if (unfreeable(id)) state = "held";
    else if (state === "freed" && lostInBattle.includes(id as NodeId)) {
      // Taken by the network's or the rogues' squads in the battle, and held to its end.
      state = "thin";
      since = today + 1;
    } else if (state !== "freed" && gained.includes(id as NodeId)) {
      state = "freed";
      freed.push(id);
    } else if (state !== "freed" && captured.includes(id as NodeId)) {
      if (r.alive) {
        state = "freed";
        freed.push(id);
      } else {
        // Taken, then lost with the raid: the network holds it only thinly.
        state = "thin";
        since = today + 1;
        dropped.push(id);
      }
    }
    poiState[id] = { state, lastVisit, since: state === "thin" ? since : 0 };
  }
  const freedOutposts: OutpostId[] = [];
  const outpostVisit: Partial<Record<OutpostId, number>> = {};
  for (const o of OUTPOST_SITES) {
    if (outposts[o.id] === "freed" && lostInBattle.includes(o.id)) outposts[o.id] = "held";
    if (outposts[o.id] !== "freed" && ((r.alive && captured.includes(o.id)) || gained.includes(o.id))) {
      outposts[o.id] = "freed";
      freedOutposts.push(o.id);
    }
    if (outposts[o.id] === "freed") outpostVisit[o.id] = r.outposts?.includes(o.id) || captured.includes(o.id) ? today : (p.outpostVisit?.[o.id] ?? today);
  }
  // A battle lost: the network takes one node on the edge of the player's ground.
  const forfeit = bt && !bt.won ? forfeitNode(nodeHolds((id) => poiState[id].state, outposts, p.network)) : null;
  if (forfeit) {
    const fi = NODES.findIndex((n) => n.id === forfeit);
    if (NODES[fi].kind === "poi") poiState[forfeit as PoiId] = { ...poiState[forfeit as PoiId], state: "thin", since: today + 1 };
    else outposts[forfeit as OutpostId] = "held";
  }
  // Going thin happens only on the front's edge: a freed POI with every neighbour the player's is safe.
  const deep = interiorNodes(nodeHolds((id) => poiState[id].state, outposts, p.network));
  for (const { id } of POIS) {
    const st = poiState[id];
    if (st.state !== "freed" || freed.includes(id) || deep[NODES.findIndex((n) => n.id === id)]) continue;
    if (r.retake === id) {
      // The retake squad stood at its way in when the day ended: the network has half of it back.
      poiState[id] = { ...st, state: "thin", since: today + 1 };
      overrun.push(id);
    } else if (today - st.lastVisit >= ISLAND.thinAfter) {
      poiState[id] = { ...st, state: "thin", since: today + 1 };
      thinned.push(id);
    }
  }
  // A freed outpost on the edge left unvisited as long lapses to whoever the territory gives it (below).
  for (const o of OUTPOST_SITES) {
    if (outposts[o.id] !== "freed" || freedOutposts.includes(o.id) || deep[NODES.findIndex((n) => n.id === o.id)]) continue;
    if (today - (outpostVisit[o.id] ?? today) >= ISLAND.thinAfter) {
      outposts[o.id] = "held";
      delete outpostVisit[o.id];
    }
  }
  const steps = {
    // A POI is freed only by capturing its core, a fight each time: thin or held, it costs the network a step.
    freed: freed.reduce((n, id) => n + (id === "relay" ? NETWORK.relayPoi : 1), 0),
    titan: r.titan ? 1 : 0,
    relays: r.relays.length * (p.network >= NETWORK.relayHigh.at ? NETWORK.relayHigh.steps : 1),
    threat: (r.threat ?? 0) >= THREAT.freeAt ? freed.length : 0,
  };
  const down = clampNet(p.network - steps.freed - steps.threat - steps.titan - steps.relays);
  let pressure = p.pressure + (p.network < NETWORK.max ? netGain(poiState) : 0);
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
  // The outposts the player does not hold change hands with the network's level, as the territory says.
  const t = territory(network);
  for (const o of OUTPOST_SITES) if (outposts[o.id] !== "freed") outposts[o.id] = t[o.id] === "rogue" ? "rogue" : "held";
  const depots = DEPOTS.map((d) => d.poi).filter((id) => p.depots.includes(id) || freed.includes(id));
  const after = nodeHolds((id) => poiState[id].state, outposts, network);
  const front = {
    gained: NODES.filter((_, i) => before[i] !== "freed" && after[i] === "freed").map((n) => n.id),
    lost: NODES.filter((_, i) => before[i] === "freed" && after[i] !== "freed").map((n) => n.id),
  };
  // Yesterday's forecast becomes today's event, and tomorrow's is drawn on the island as it now stands.
  const events: DayEvents = [settleEvent(p.events?.[1] ?? null, p.seed ?? 0, today + 1, poiState, outposts), eventFor(p.seed ?? 0, today + 2, poiState, outposts)];
  return {
    profile: { ...p, day: today + 1, poiState, outposts, outpostVisit, depots, network, pressure, events },
    change: { freed, outposts: freedOutposts, dropped, front, thinned, retaken, overrun, network: { from: p.network, to: network, ...steps, rise, crews }, battle: bt ? { won: bt.won, score: bt.score, gained: bt.gained, lost: bt.lost, forfeit } : null },
  };
}

/**
 * The node of the player's a lost battle hands the network: one on the edge of the player's
 * ground (a neighbour not theirs), the one with the most such neighbours, an outpost before a POI,
 * the first in `NODES` on a tie; null when the player holds none. The nodes at the camp's gate
 * (`CAMP_NEXT`) are the camp's to keep: a lost battle does not hand them over.
 */
export function forfeitNode(holds: NodeHold[]): NodeId | null {
  const front = NODES.map((n, i) => ({ n, i, out: NEIGHBOURS[i].filter((k) => holds[k] !== "freed").length })).filter(({ i, out }) => holds[i] === "freed" && out > 0 && !CAMP_NEXT.includes(i));
  front.sort((a, b) => b.out - a.out || (a.n.kind === "outpost" ? 0 : 1) - (b.n.kind === "outpost" ? 0 : 1) || a.i - b.i);
  return front[0]?.n.id ?? null;
}

/** The credits the island pays at the settle for the nodes the player holds: `FRONT.income` a POI, `FRONT.outpost` of it an outpost. */
export function frontIncome(p: Pick<IslandDay, "poiState" | "network"> & Partial<Pick<IslandDay, "outposts">>): number {
  const holds = islandHolds(p);
  return NODES.reduce((n, node, i) => n + (holds[i] === "freed" ? Math.round(FRONT.income * (node.kind === "outpost" ? FRONT.outpost : 1)) : 0), 0);
}

/** A hash of the seed, the day and a salt: the event schedule draws on nothing else. */
const dayHash = (seed: number, day: number, k: number) => mix(Math.imul(seed + 1, 0x9e3779b1) ^ Math.imul(day + 11, 0x85ebca6b) ^ Math.imul(k + 1, 0xc2b2ae35));

/** The POIs a retake may be sent to: those freed on the front's edge (`interiorNodes()`), not deep in the player's ground. */
export function retakable(poiState: Record<PoiId, { state: PoiHold }>, outposts?: Partial<Record<OutpostId, OutpostHold>>): PoiId[] {
  const deep = interiorNodes(nodeHolds((id) => poiState[id].state, outposts, 0));
  return POIS.filter((o) => poiState[o.id].state === "freed" && !deep[NODES.findIndex((n) => n.id === o.id)]).map((o) => o.id);
}

/**
 * The event of day `day`, drawn from `seed` and the day: one day in `1 / EVENTS.chance` or so has
 * one, picked by `EVENTS.weights` among those the island allows. A retake needs a freed POI, and
 * comes more often the more are freed on the front's edge (its weight grows with them up to three); it names one of them.
 */
export function eventFor(seed: number, day: number, poiState: Record<PoiId, { state: PoiHold }>, outposts?: Partial<Record<OutpostId, OutpostHold>>): IslandEvent | null {
  if ((dayHash(seed, day, 0) % 10_000) / 10_000 >= EVENTS.chance) return null;
  const freed = retakable(poiState, outposts);
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
 * The forecast event as it comes on its day: a retake whose POI is no longer freed on the front's
 * edge goes to another such one (drawn as the forecast was), and with none it does not come.
 */
function settleEvent(ev: IslandEvent | null, seed: number, day: number, poiState: Record<PoiId, { state: PoiHold }>, outposts?: Partial<Record<OutpostId, OutpostHold>>): IslandEvent | null {
  const freed = retakable(poiState, outposts);
  if (ev?.t !== "retake" || freed.includes(ev.poi)) return ev;
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

/** How far ahead the forecasts look: an event further off than this is told as not coming. */
export const FORECAST_DAYS = 30;

/** The day the forecasts assume for every coming raid: nothing visited, cleared or destroyed. */
const IDLE: RaidDay = { alive: true, cleared: [], visited: [], titan: false, relays: [] };

/**
 * The first of the coming idle days (1 being the coming raid's) after which `done` holds of the
 * island, stepping `advanceDay()` itself so that a forecast follows every nightly rule; null if
 * none within `FORECAST_DAYS`.
 */
function idleDaysUntil(p: IslandView, done: (q: IslandDay) => boolean): number | null {
  let q: IslandDay = { day: p.day, poiState: p.poiState, depots: [], network: p.network, pressure: p.pressure, outposts: p.outposts, outpostVisit: p.outpostVisit };
  for (let d = 1; d <= FORECAST_DAYS; d++) {
    q = advanceDay(q, IDLE).profile;
    if (done(q)) return d;
  }
  return null;
}

/** Days until the network rises above its level if the player frees nothing (counting the coming raid), or null when it does not in `FORECAST_DAYS`, as at the top. */
export function riseIn(p: IslandView): number | null {
  return idleDaysUntil(p, (q) => q.network > p.network);
}

/**
 * Days until the network takes a thin POI back to held if the player frees nothing (counting
 * the coming raid), or null for a POI that is not thin or is not taken back in `FORECAST_DAYS`.
 */
export function retakeIn(p: IslandView, id: PoiId): number | null {
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
  const why = [n.freed ? `解放 −${n.freed}` : "", n.threat ? `強度 −${n.threat}` : "", n.titan ? `タイタン −${n.titan}` : "", n.relays ? `中継器 −${n.relays}` : "", n.rise ? `日の経過 +${n.rise}` : "", n.crews ? `回収部隊 +${n.crews}` : ""].filter(Boolean);
  return `網 ${n.from} → ${n.to}${why.length ? `（${why.join("・")}）` : "（変わらず）"}`;
}

/** The relay masts' names, for contracts and the map. */
export const relayName = (id: RelayId) => RELAYS[relayIndex(id)].name;

/**
 * Days a freed POI has left before it goes thin, counting the coming raid: 1 means it goes thin
 * unless the next raid comes into it. Null for a POI that is not freed.
 */
export function daysLeft(p: IslandView, id: PoiId): number | null {
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
  | { t: "top" }
  | { t: "overrun"; poi: PoiId }
  | { t: "crews"; n: number };

/**
 * The island's coming changes, for the map table and the results' 明日の島: POIs just freed or
 * gone thin overnight (when `change` is given), every freed POI's days left before it goes thin,
 * soonest first, and the thin POIs waiting to be freed again.
 */
export function islandNotes(p: IslandView, change?: Pick<DayChange, "thinned" | "retaken"> & Partial<Pick<DayChange, "overrun" | "network">>): IslandNote[] {
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
      return n.days <= 1 ? `${name}は手薄。放っておくと、次のレイドの後に支配に戻る` : `${name}は手薄。放っておくと、あと ${n.days} 日で支配に戻る`;
    case "retaken":
      return `${name}は網に取り戻され、支配に戻った`;
    case "fading":
      return n.days <= 1 ? `${name}は次のレイドで訪れないと手薄になる` : `${name}はあと ${n.days} 日訪れないと手薄になる`;
    case "overrun":
      return `${name}は奪還部隊に取られ、手薄になった。核を制圧して生きて帰れば解放に戻る`;
    case "thinned":
      return `${name}は訪れないうちに手薄になった。核を制圧して生きて帰れば解放に戻る`;
    case "thin":
      return `${name}は手薄。核を制圧して生きて帰れば解放に戻る`;
  }
}

/** POIs that go thin unless the next raid comes into them. */
export const thinTomorrow = (p: IslandView) => POIS.map((o) => o.id).filter((id) => daysLeft(p, id) === 1);

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
