import { CONQUEST, ENEMIES, FACTORY, FACTORY_TOP, PLATE, type EnemyKind } from "../src/ringfall/sim/config";
import { reckonApart, standing, type Guard, type NodeMeter, type ReckonSquad, type Task, type Unit } from "../src/ringfall/sim/reckon";
import { parseHold, rivalOf, type PoiHold } from "../src/ringfall/sim/holds";
import { ISLAND_TABLE } from "../src/ringfall/meta/island-table";
import type { ApiError } from "../src/ringfall/meta/island-errors";

/*
 * One island on the server (docs/ringfall/multiplayer.md, 戦いの解き方): its owner, the nodes' holds
 * as the owner last reported them and as expeditions changed them, the expeditions on it, and the
 * log the owner reads. Plain data and pure transitions, so that IslandDO (worker/island-do.ts) only
 * loads, applies and stores, and scripts/ringfall-expeditions.ts drives the same code without workerd.
 *
 * While the owner is away the fights at the nodes expeditions came to are reckoned in numbers with
 * the battle's own reckoning (sim/reckon.ts) every `CONQUEST.tick` seconds of the island's clock.
 * Nothing draws on chance: the same state and the same time give the same island.
 */

/** The rules of expeditions and the server's pace. */
export const EXPEDITION = {
  /** Days an island is shielded from expeditions after it was claimed (新しいプレイヤーの保護). */
  protectDays: 2,
  /** Expeditions on one island at once, those holding a node they took among them. */
  perIsland: 3,
  /** Nodes an island loses to expeditions in one UTC day; past it, the expeditions there stand off until the next. */
  perDay: 2,
  /**
   * Seconds from an expedition's acceptance to its standing at its node (予告): the owner reads of it
   * at once and has this long to answer, by fortifying the node in a raid or by leaving the factory's
   * squads at home. A raid the owner starts before then takes the expedition in (`lease`).
   */
  notice: 12 * 3600,
  /** Seconds a lease lasts: a raid's battle and time to settle it. Unreported by then, the island goes on in numbers from where the lease found it. */
  lease: CONQUEST.time + 1800,
  /** Seconds a node the owner fortified in a raid is shut to expeditions: one at it stands off (固め). */
  fortify: 24 * 3600,
  /**
   * Seconds an async look-mark the owner leaves stays on the island (ux-design M6).
   * Long on purpose: CoC-style async presence, not a live ping sync.
   */
  pingTtl: 24 * 3600,
  /** Look-marks kept at once; the oldest drop first. */
  pingMax: 8,
  /** Aid parcels at depots (ux-design C2, 援軍の寄付); oldest drop first. */
  parcelMax: 12,
  /** Aid parcels spent as extra defenders when a freed node is attacked (async). */
  aidPerFight: 2,
  /** Milliseconds between the reckonings of an island with expeditions on it. */
  alarmMs: 60_000,
  /** Ticks one reckoning runs at most; an island further behind is reckoned again at once. */
  maxTicks: 3600,
  /** Entries the log keeps, the oldest dropped first. */
  logMax: 200,
};

const DAY_MS = 86_400_000;
const TICK_MS = CONQUEST.tick * 1000;
/** Where the squads at node `i` stand for the reckoning: far enough apart that the fights at two nodes never meet (`CONQUEST.meet`). */
const SPREAD = 10_000;

/** The node ids in `NODES` order. */
export const NODE_IDS: readonly string[] = ISLAND_TABLE.nodes.map((n) => n.id);

/** Depot POIs a parcel may sit at: every front node, plus closed POIs that still have a depot (e.g. pad). */
export const DEPOT_POIS: readonly string[] = [...NODE_IDS, ...ISLAND_TABLE.closed];

/** Who owns an island: the player's secret id, the name others see and the island's code. */
export interface Owner {
  id: string;
  name: string;
  code: string;
}

/** An attacker as others see them: their island's code and name, never their id. */
/** How long an attack may be answered (仕返し) by any way, the sea route shut or not. */
export const ANSWER_MS = 7 * 24 * 3600 * 1000;

export interface Attacker {
  code: string;
  name: string;
}

/** An expedition on this island: whose, the node it was sent to, its members, when it was accepted and when it stands at its node, and whether it holds that node now. */
export interface Expedition {
  id: number;
  by: Attacker;
  target: number;
  units: Unit[];
  sentAt: number;
  arriveAt: number;
  arrived: boolean;
  holding: boolean;
  /** Held back by the day's limit at the last tick (`heldBack()`): its node's fight starts again, as at its arrival, when it may attack. */
  waiting?: true;
}

/** One of the owner's factory squads defending a node an expedition came to: a turret (`post`) or a squad the factory sent. */
export interface Defender {
  id: number;
  to: number;
  units: Unit[];
  task: Task;
}

/** A change the owner reads: an expedition sent at a node (its notice), come to it, a node taken, an expedition wiped out, a node taken back, one whose holders were lost going back to the enemy, or an expedition called home before it took anything. */
export interface LogEntry {
  seq: number;
  at: number;
  t: "noticed" | "landed" | "taken" | "wiped" | "retaken" | "released" | "recalled";
  node: string;
  by: Attacker;
}

/** An expedition as the owner's raid takes it in (`lease`): the island's number for it, whose, its node, its members' kinds, and how it stood. */
export interface Lent {
  id: number;
  by: Attacker;
  target: string;
  kinds: EnemyKind[];
  state: "coming" | "attacking" | "holding";
}

export interface IslandState {
  owner: Owner;
  /** Each node's hold, in `NODE_IDS` order. Another player's is `rival:` and their island's code. */
  holds: PoiHold[];
  factory: number;
  /** The owner's day, as last reported. */
  day: number;
  /** When the island was claimed: when its protection began. */
  since: number;
  /** The island's clock: the time of the last tick reckoned. */
  clock: number;
  expeditions: Expedition[];
  defenders: Defender[];
  /** Each node's garrison as it stands in a fight, or null where it has not fought since the owner's last report (whole). */
  guards: (Guard[] | null)[];
  meter: (NodeMeter | null)[];
  /** Seconds of the factory's work toward its next defending squad. */
  made: number;
  nextId: number;
  log: LogEntry[];
  seq: number;
  /** Nodes taken from the island by expeditions on UTC day `day`: the day's limit counts these, not the log, which drops old entries. */
  taken: { day: number; n: number };
  /**
   * The owner's raid has the expeditions `ids` until `until`: the island leaves them as they are
   * meanwhile, and the raid's report says what became of them. Left out or null, none. (Optional:
   * islands stored before leases have none.)
   */
  lease?: { until: number; ids: number[] } | null;
  /** Until when each node is shut to expeditions, fortified by the owner in a raid; 0 or left out, open. */
  fort?: number[];
  /** Async look-marks the owner left (ux-design M6); pruned past `until`. Optional on older islands. */
  pings?: IslandPing[];
  /** Aid parcels at depots (ux-design C2, CoC-style donation). Optional on older islands. */
  parcels?: IslandParcel[];
}

/** A look-ping on the island map: where, whose name, and when it expires. */
export interface IslandPing {
  id: number;
  x: number;
  z: number;
  by: string;
  until: number;
}

/** A parcel at a depot POI: one valuable, who left it, and when. */
export interface IslandParcel {
  id: number;
  poi: string;
  kind: string;
  from: Attacker;
  at: number;
}

/** What a report says of an expedition its raid took in: the island's number for it and the members it has left (0: wiped out). */
export interface LentResult {
  id: number;
  left: number;
  /** The raid's battle ended before this one set off: it never came, and the island keeps it as it was, on its own schedule. */
  waiting?: true;
}

/** What one request asks of an island. */
export type IslandOp =
  | { t: "claim"; player: { id: string; name: string }; code: string }
  | { t: "report"; player: { id: string; name: string }; holds: PoiHold[]; retaken: string[]; factory: number; day: number; lent?: LentResult[]; fortified?: string[]; parcels?: IslandParcel[]; takenParcels?: number[] }
  | { t: "lease"; player: string }
  | { t: "unlease"; player: string }
  | { t: "recall"; from: string; id: number }
  | { t: "view" }
  | { t: "log"; player: string; after: number }
  | { t: "whois"; player: string }
  | { t: "expedition"; from: Attacker; target: string; kinds: EnemyKind[] }
  | { t: "ping"; player: string; name: string; x: number; z: number }
  | { t: "aid"; from: Attacker; poi: string; kind: string };

/** The answer to an op: the HTTP status and body, and the island as it is after it (null while nobody has claimed it). */
export interface OpResult {
  status: number;
  body: unknown;
  state: IslandState | null;
  /** Whether the island must be stored: a tick was reckoned or the op changed it. Reads of an island where nothing happened store nothing (the clock's jump over quiet time comes out the same when worked out again). */
  changed: boolean;
}

const fail = (error: ApiError) => ({ ok: false, error });

/** A full member of `kind`. */
const unit = (kind: EnemyKind): Unit => ({ kind, hp: ENEMIES[kind].hp, shield: ENEMIES[kind].shield });

/** A 32-bit mix of `a` and `b` (a murmur3 finaliser): the server's only source of variety, from the island's code and the robot. */
function hash(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x6b43a9b5, 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

const codeSeed = (code: string) => [...code].reduce((h, c) => hash(h, c.charCodeAt(0)), 0);

/**
 * Node `i`'s whole garrison: its POI's squads' members, each grunt and heavy wearing the node's
 * tier of plate with the chance `PLATE.garrison` gives it (as a raid's garrison does), picked from
 * the island's code and the robot, and the vault guard at least its own plate.
 */
export function garrisonGuards(code: string, i: number): Guard[] {
  const node = ISLAND_TABLE.nodes[i];
  const seed = codeSeed(code);
  return node.guards.map(([kind, own], k) => {
    const plain = kind === "grunt" || kind === "heavy";
    const tier = plain && node.tier > 0 && hash(hash(seed, i), k) / 4294967296 < PLATE.garrison[node.tier] ? node.tier : 0;
    return { side: 1, kind, hp: ENEMIES[kind].hp, shield: ENEMIES[kind].shield, plate: Math.max(own, tier) as Guard["plate"] };
  });
}

const utcDay = (t: number) => Math.floor(t / DAY_MS);

/** Nodes taken from the island by expeditions on the UTC day of `t`. */
const takenOn = (s: IslandState, t: number) => (s.taken.day === utcDay(t) ? s.taken.n : 0);

function note(s: IslandState, at: number, t: LogEntry["t"], node: number, by: Attacker) {
  if (t === "taken") s.taken = { day: utcDay(at), n: takenOn(s, at) + 1 };
  s.log.push({ seq: ++s.seq, at, t, node: NODE_IDS[node], by: { ...by } });
  if (s.log.length > EXPEDITION.logMax) s.log.splice(0, s.log.length - EXPEDITION.logMax);
}

/** Why node `i` takes no expedition now, or null when it does. */
function closedWhy(s: IslandState, i: number, now: number): { status: number; error: ApiError } | null {
  if (ISLAND_TABLE.campNext.includes(NODE_IDS[i])) return { status: 403, error: "closed-node" };
  if (s.holds[i] !== "held" && s.holds[i] !== "freed") return { status: 409, error: "node-not-open" };
  if (now - s.since < EXPEDITION.protectDays * DAY_MS) return { status: 403, error: "protected" };
  if (s.expeditions.some((e) => e.target === i)) return { status: 409, error: "node-busy" };
  if (s.expeditions.length >= EXPEDITION.perIsland) return { status: 409, error: "island-full" };
  if (takenOn(s, now) + s.expeditions.filter((e) => !e.holding).length >= EXPEDITION.perDay) return { status: 409, error: "day-limit" };
  return null;
}

/** Drop expired look-pings; keeps the list small. */
function prunePings(s: IslandState, now: number) {
  if (!s.pings?.length) return;
  s.pings = s.pings.filter((p) => p.until > now);
  if (s.pings.length > EXPEDITION.pingMax) s.pings = s.pings.slice(s.pings.length - EXPEDITION.pingMax);
}

/** The island's state as anyone may see it: no player's id. */
export function publicView(s: IslandState, now: number) {
  prunePings(s, now);
  return {
    ok: true,
    code: s.owner.code,
    owner: s.owner.name,
    day: s.day,
    factory: s.factory,
    protectedUntil: s.since + EXPEDITION.protectDays * DAY_MS,
    nodes: NODE_IDS.map((id, i) => ({ id, hold: s.holds[i], open: closedWhy(s, i, now) === null })),
    expeditions: s.expeditions.map((e) => ({
      id: e.id,
      by: { ...e.by },
      target: NODE_IDS[e.target],
      units: e.units.length,
      state: e.holding ? "holding" : !e.arrived ? "coming" : heldBack(s, e, now) ? "waiting" : "attacking",
      arriveAt: e.arriveAt,
    })),
    pings: (s.pings ?? []).map((p) => ({ id: p.id, x: p.x, z: p.z, by: p.by, until: p.until })),
    parcels: (s.parcels ?? []).map((p) => ({ id: p.id, poi: p.poi, kind: p.kind, from: { ...p.from }, at: p.at })),
  };
}

/**
 * Spends up to `n` aid parcels as extra defenders at node `i` (CoC clan-castle style): each parcel
 * becomes one grunt on defend, then is gone. Offline help for the next attack.
 */
function spendAid(s: IslandState, i: number, n = EXPEDITION.aidPerFight) {
  if (!s.parcels?.length || n <= 0) return;
  const take = Math.min(n, s.parcels.length);
  for (let k = 0; k < take; k++) {
    s.parcels.shift();
    s.defenders.push({ id: s.nextId++, to: i, units: [unit("grunt")], task: "defend" });
  }
}

/** A fight begins at node `i`: a node of the enemy's stands its whole garrison (as it stands since the last report), one of the owner's its turrets. */
function startFight(s: IslandState, i: number) {
  if (s.holds[i] === "held") s.guards[i] ??= garrisonGuards(s.owner.code, i);
  if (s.holds[i] === "freed" && !s.defenders.some((d) => d.to === i && d.task === "post")) {
    for (let k = 0; k < FACTORY.levels[s.factory].turrets; k++) s.defenders.push({ id: s.nextId++, to: i, units: [unit("heavy")], task: "post" });
    // Aid left at depots (own leave-aid use, or a neighbour's donation) joins this defence.
    spendAid(s, i);
  }
}

/**
 * Whether expedition `e` is held back at `t`: at its node, not holding it, while the island has lost
 * its day's nodes (`EXPEDITION.perDay`) or the owner has fortified the node (`EXPEDITION.fortify`).
 * It stays out of its node's fight altogether until the next UTC day or until the node opens:
 * nobody fights it and the factory sends nothing at it.
 */
function heldBack(s: IslandState, e: Expedition, t: number): boolean {
  return e.arrived && !e.holding && (takenOn(s, t) >= EXPEDITION.perDay || fortUntil(s, e.target) > t);
}

/** Until when node `i` is shut to expeditions (`EXPEDITION.fortify`), or 0. */
const fortUntil = (s: IslandState, i: number) => s.fort?.[i] ?? 0;

/** Whether the owner's raid has expedition `e` at `t` (`IslandState.lease`): the island leaves it as it is. */
const leased = (s: IslandState, e: Expedition, t: number) => !!s.lease && t < s.lease.until && s.lease.ids.includes(e.id);

/** An expedition at its node, as the reckoning sees it. */
const expeditionSquad = (e: Expedition): ReckonSquad => ({
  id: e.id,
  side: 3,
  owner: e.by.code,
  units: e.units,
  to: e.target,
  task: e.holding ? "hold" : "attack",
  x: e.target * SPREAD,
  z: 0,
  arrived: true,
  live: false,
  ashore: 0,
});

const defenderSquad = (d: Defender): ReckonSquad => ({ id: d.id, side: 0, units: d.units, to: d.to, task: d.task, x: d.to * SPREAD, z: 0, arrived: true, live: false, ashore: 0 });

/** One tick of the island at its clock `t`: arrivals, the factory's defence, then the battle's fights and captures. */
function tick(s: IslandState, t: number) {
  for (const e of s.expeditions)
    if (!e.arrived && e.arriveAt <= t && !leased(s, e, t)) {
      e.arrived = true;
      startFight(s, e.target);
      note(s, t, "landed", e.target, e.by);
    }
  // Those the owner's raid has stand out of the island's reckoning as those held back do.
  const back = new Set(s.expeditions.filter((e) => heldBack(s, e, t) || (e.arrived && !e.holding && leased(s, e, t))));
  // One held back until now may attack: its node's fight starts as at its arrival (the turrets go back to their posts).
  for (const e of s.expeditions) {
    if (e.waiting && !back.has(e)) startFight(s, e.target);
    if (back.has(e)) e.waiting = true;
    else delete e.waiting;
  }
  const here = s.expeditions.filter((e) => e.arrived && !back.has(e));
  // The factory sends a squad to the first of the owner's nodes under attack, as in a raid, while it has room.
  const lv = FACTORY.levels[s.factory];
  const attacked = here.find((e) => !e.holding && s.holds[e.target] === "freed");
  s.made = Math.min(lv.every, s.made + CONQUEST.tick);
  if (attacked && s.made >= lv.every && s.defenders.filter((d) => d.task !== "post").length < lv.max) {
    s.defenders.push({ id: s.nextId++, to: attacked.target, units: lv.kinds.map(unit), task: "defend" });
    s.made = 0;
  }
  const squads = [...here.map(expeditionSquad), ...s.defenders.map(defenderSquad)];
  const r = reckonApart(
    {
      holds: s.holds,
      squads,
      guards: s.guards.map((g) => g ?? []),
      watched: NODE_IDS.map(() => false),
      rarity: PLATE.robots,
      meter: s.meter,
      threat: NODE_IDS.map(() => false),
    },
    CONQUEST.tick,
  );
  const left = standing(r);
  s.guards = s.guards.map((g, i) => (g ? left[i] : null));
  const by = new Map(r.squads.map((q) => [q.id, q]));
  const holds = [...r.holds];
  const meter = [...r.meter];
  for (const ef of r.effects) {
    if (ef.t !== "seize") continue;
    if (ef.side === 3) {
      // Captures landing on one tick are counted one by one: past the day's limit the node stays as it
      // was and the meter starts over, so the island never loses more than `perDay` nodes in a day.
      if (takenOn(s, t) >= EXPEDITION.perDay) {
        holds[ef.node] = s.holds[ef.node];
        meter[ef.node] = null;
        continue;
      }
      const e = here.find((x) => x.target === ef.node && x.by.code === ef.owner);
      if (e) {
        e.holding = true;
        note(s, t, "taken", ef.node, e.by);
      }
    } else if (ef.side === 0) {
      for (const e of here.filter((x) => x.target === ef.node)) e.holding = false;
      note(s, t, "retaken", ef.node, { code: s.owner.code, name: s.owner.name });
    }
  }
  s.holds = holds;
  s.meter = meter;
  s.expeditions = s.expeditions.filter((e) => {
    if (!e.arrived || back.has(e)) return true;
    const q = by.get(e.id);
    if (q) {
      e.units = q.units;
      return true;
    }
    note(s, t, "wiped", e.target, e.by);
    // Holders lost: the node goes back to the enemy (取った拠点の維持).
    if (rivalOf(s.holds[e.target]) === e.by.code) {
      s.holds[e.target] = "held";
      note(s, t, "released", e.target, e.by);
    }
    return false;
  });
  // The owner's squads stay while an expedition not held back is at their node; the rest go home.
  s.defenders = s.defenders.flatMap((d) => {
    const q = by.get(d.id);
    return q && s.expeditions.some((e) => e.arrived && !back.has(e) && e.target === d.to) ? [{ ...d, units: q.units, task: q.task }] : [];
  });
}

/**
 * Whether a tick at `t` would change nothing but the factory's work: no squad of the owner's out, no
 * meter filling, and every expedition at its node holding it or held back. Expeditions still coming
 * and held back ones wait for a time of their own (`quietUntil()`).
 */
function quiet(s: IslandState, t: number): boolean {
  return !s.defenders.length && !s.meter.some((m) => m) && s.expeditions.every((e) => !e.arrived || e.holding || heldBack(s, e, t) || leased(s, e, t));
}

/** The first time something happens on a quiet island after `t`: an expedition arriving, a lease running out, or the next UTC day or the node's opening for one held back; Infinity for none. */
function quietUntil(s: IslandState, t: number): number {
  let at = Infinity;
  for (const e of s.expeditions) {
    if (e.holding) continue;
    if (leased(s, e, t)) at = Math.min(at, s.lease!.until);
    else if (!e.arrived) at = Math.min(at, e.arriveAt);
    else if (heldBack(s, e, t)) {
      if (takenOn(s, t) >= EXPEDITION.perDay) at = Math.min(at, (utcDay(t) + 1) * DAY_MS);
      if (fortUntil(s, e.target) > t) at = Math.min(at, fortUntil(s, e.target));
    }
  }
  return at;
}

/**
 * The island reckoned to `now` in whole ticks, `EXPEDITION.maxTicks` at most: whether it is still
 * behind, and whether a tick was reckoned (`moved`). Over quiet time (`quiet()`) the clock jumps to
 * the tick before the next thing that happens, which comes out as ticking through it would.
 */
export function advance(s: IslandState, now: number, maxTicks = EXPEDITION.maxTicks): { behind: boolean; moved: boolean } {
  prunePings(s, now);
  const every = FACTORY.levels[s.factory].every;
  let n = 0;
  for (;;) {
    const due = Math.floor((now - s.clock) / TICK_MS);
    if (due <= 0) return { behind: false, moved: n > 0 };
    if (quiet(s, s.clock + TICK_MS)) {
      // The tick that sees the next event is the first at or after it; jump to the one before.
      const until = quietUntil(s, s.clock + TICK_MS);
      const skip = Math.min(due, until === Infinity ? due : Math.ceil((until - s.clock) / TICK_MS) - 1);
      if (skip > 0) {
        s.clock += skip * TICK_MS;
        s.made = Math.min(every, s.made + skip * CONQUEST.tick);
        continue;
      }
    }
    if (n >= maxTicks) return { behind: true, moved: true };
    s.clock += TICK_MS;
    tick(s, s.clock);
    n++;
  }
}

/**
 * When the island's alarm should next ring after `now`, or null for none: in `EXPEDITION.alarmMs`
 * while something can change (an expedition attacking, a meter filling, the owner's squads out),
 * when the next expedition arrives or the next UTC day begins for those held back while that is all
 * that waits, and never for an island
 * whose expeditions all just hold their nodes. The next request arms it again when it is needed.
 */
export function nextAlarm(s: IslandState | null, now: number): number | null {
  if (!s) return null;
  if (!quiet(s, now)) return now + EXPEDITION.alarmMs;
  const until = quietUntil(s, now);
  if (until === Infinity) return null;
  // The tick that reckons the event: the first on the island's grid (clock + k ticks) at or after it.
  return Math.max(now + 1, s.clock + Math.ceil((until - s.clock) / TICK_MS) * TICK_MS);
}

/** A new island claimed at `now` for the player of `op`: every node the enemy's until the owner's first report. */
function claim(op: Extract<IslandOp, { t: "claim" }>, now: number): IslandState {
  return {
    owner: { id: op.player.id, name: op.player.name, code: op.code },
    holds: NODE_IDS.map(() => "held"),
    factory: 0,
    day: 0,
    since: now,
    clock: now,
    expeditions: [],
    defenders: [],
    guards: NODE_IDS.map(() => null),
    meter: NODE_IDS.map(() => null),
    made: FACTORY.levels[0].every,
    nextId: 1,
    log: [],
    seq: 0,
    taken: { day: utcDay(now), n: 0 },
  };
}

/**
 * The owner's report after a raid. Nodes the server gave to other players stay theirs, except one
 * the report names among `retaken` (taken back in the raid) and reports as the owner's: that one is
 * the owner's, its holders go, and the log says so. A node the report calls the owner's without
 * naming it among `retaken` stays the other player's: the owner's copy of the island may predate
 * the capture. The owner cannot give a node to another player. The fights start
 * again from the island as reported: a raid stands every garrison whole.
 */
function report(s: IslandState, op: Extract<IslandOp, { t: "report" }>, now: number) {
  s.owner.name = op.player.name;
  s.factory = op.factory;
  s.day = op.day;
  op.holds.forEach((h, i) => {
    const cur = s.holds[i];
    if (rivalOf(cur) !== null) {
      if (h !== "freed" || !op.retaken.includes(NODE_IDS[i])) return;
      s.holds[i] = "freed";
      const gone = s.expeditions.filter((e) => e.target === i);
      s.expeditions = s.expeditions.filter((e) => e.target !== i);
      note(s, now, "retaken", i, gone[0]?.by ?? { code: rivalOf(cur)!, name: "" });
    } else if (h === "held" || h === "freed") s.holds[i] = h;
  });
  // What the raid made of the expeditions it took in, while its lease stands; a report after it ran out says nothing of them.
  const live = s.lease && now < s.lease.until ? s.lease.ids : [];
  for (const r of op.lent ?? []) {
    const e = s.expeditions.find((x) => x.id === r.id);
    if (!e || !live.includes(r.id) || r.waiting) continue;
    const i = e.target;
    const theirs = rivalOf(s.holds[i]) === e.by.code;
    if (!e.arrived) {
      // It landed in the raid.
      e.arrived = true;
      note(s, now, "landed", i, e.by);
    }
    if (r.left <= 0) {
      s.expeditions = s.expeditions.filter((x) => x !== e);
      note(s, now, "wiped", i, e.by);
      if (theirs) {
        s.holds[i] = op.holds[i] === "freed" ? "freed" : "held";
        note(s, now, "released", i, e.by);
      }
      continue;
    }
    e.units = e.units.slice(0, r.left);
    const told = op.holds[i];
    if (e.holding && theirs && told === "held") {
      // The enemy took the node from its holders, who are at it again.
      s.holds[i] = "held";
      e.holding = false;
      note(s, now, "released", i, e.by);
    } else if (!e.holding && rivalOf(told) === e.by.code && takenOn(s, now) < EXPEDITION.perDay && fortUntil(s, i) <= now) {
      s.holds[i] = told;
      e.holding = true;
      note(s, now, "taken", i, e.by);
    }
  }
  s.lease = null;
  // Parcels left or taken in the raid (ux-design C2): take before add so a round-trip is one report.
  if (op.takenParcels?.length) {
    const gone = new Set(op.takenParcels);
    s.parcels = (s.parcels ?? []).filter((p) => !gone.has(p.id));
  }
  for (const p of op.parcels ?? []) {
    if (!DEPOT_POIS.includes(p.poi) || typeof p.kind !== "string" || !p.from?.code) continue;
    s.parcels ??= [];
    s.parcels.push({ id: s.nextId++, poi: p.poi, kind: p.kind, from: { ...p.from }, at: now });
  }
  if (s.parcels && s.parcels.length > EXPEDITION.parcelMax) s.parcels = s.parcels.slice(s.parcels.length - EXPEDITION.parcelMax);
  // The nodes fortified in the raid are shut to expeditions for a day: only the owner's, and only one an expedition is at or coming to.
  for (const id of op.fortified ?? []) {
    const i = NODE_IDS.indexOf(id);
    if (i < 0 || s.holds[i] !== "freed" || !s.expeditions.some((e) => e.target === i && !e.holding)) continue;
    s.fort ??= NODE_IDS.map(() => 0);
    s.fort[i] = now + EXPEDITION.fortify * 1000;
  }
  s.guards = NODE_IDS.map(() => null);
  s.meter = NODE_IDS.map(() => null);
  s.defenders = [];
  s.made = FACTORY.levels[s.factory].every;
  for (const e of s.expeditions) {
    if (e.arrived && !e.holding && !heldBack(s, e, now)) startFight(s, e.target);
    // One held back as the report lands starts its node's fight when it may attack (`tick()`).
    else if (e.arrived && !e.holding) e.waiting = true;
  }
}

/**
 * The owner's raid takes the expeditions on the island in (レイド中の遠征隊): every one of them, as it
 * stands. Until the raid's report, or `EXPEDITION.lease` seconds, the island leaves them as they are.
 * A lease still standing is answered again as it is and not made longer, so asking again and again
 * holds nobody off. A node fortified in an earlier raid and still shut is named, so the raid keeps
 * it shut, and its report cannot say it fell.
 */
function lease(s: IslandState, now: number): { until: number; expeditions: Lent[]; shut: string[]; wrote: boolean } {
  const standing = s.lease && now < s.lease.until ? s.lease : null;
  const ids = standing ? standing.ids : s.expeditions.map((e) => e.id);
  const until = standing ? standing.until : now + EXPEDITION.lease * 1000;
  if (!standing) s.lease = ids.length ? { until, ids } : null;
  const expeditions = s.expeditions
    .filter((e) => ids.includes(e.id))
    .map((e): Lent => ({ id: e.id, by: { ...e.by }, target: NODE_IDS[e.target], kinds: e.units.map((u) => u.kind), state: e.holding ? "holding" : e.arrived ? "attacking" : "coming" }));
  // The nodes still shut from an earlier raid stay shut in this one.
  const shut = NODE_IDS.filter((_, i) => fortUntil(s, i) > now);
  return { until, expeditions, shut, wrote: !standing && ids.length > 0 };
}

/**
 * The sender calls expedition `id` home (引き上げ): it leaves the island, and a node it held goes back
 * to the enemy. False when the island has no such expedition of that sender's.
 */
function recall(s: IslandState, from: string, id: number, now: number): boolean {
  const e = s.expeditions.find((x) => x.id === id && x.by.code === from);
  if (!e) return false;
  s.expeditions = s.expeditions.filter((x) => x !== e);
  if (rivalOf(s.holds[e.target]) === from) {
    s.holds[e.target] = "held";
    note(s, now, "released", e.target, e.by);
  } else note(s, now, "recalled", e.target, e.by);
  return true;
}

/** Applies `op` to the island at `now` (reckoned to `now` first). The state passed in is changed in place. */
export function islandOp(state: IslandState | null, op: IslandOp, now: number): OpResult {
  const s = state;
  const moved = s ? advance(s, now).moved : false;
  const done = (status: number, body: unknown, wrote = false): OpResult => ({ status, body, state: s, changed: moved || wrote });
  // The server draws the code (worker/api.ts): one already claimed answers 409 and it draws again.
  if (op.t === "claim") return s ? done(409, fail("code-taken")) : { status: 201, body: { ok: true, code: op.code }, state: claim(op, now), changed: true };
  if (!s) return done(404, fail("no-island"));
  if (op.t === "report") {
    if (s.owner.id !== op.player.id) return done(403, fail("not-owner"));
    report(s, op, now);
    return done(200, { ok: true, holds: s.holds }, true);
  }
  if (op.t === "lease") {
    if (s.owner.id !== op.player) return done(403, fail("not-owner"));
    const l = lease(s, now);
    return done(200, { ok: true, until: l.until, expeditions: l.expeditions, shut: l.shut }, l.wrote);
  }
  if (op.t === "unlease") {
    // The raid the lease was for is not taking the expeditions in: the island reckons them again from now.
    if (s.owner.id !== op.player) return done(403, fail("not-owner"));
    const had = !!s.lease;
    s.lease = null;
    return done(200, { ok: true }, had);
  }
  if (op.t === "recall") return recall(s, op.from, op.id, now) ? done(200, { ok: true }, true) : done(404, fail("no-expedition"));
  if (op.t === "view") return done(200, publicView(s, now));
  // Who the sender is, their factory, and the nodes they hold (a neighbour's sea route opens from one of them).
  // Who the sender is, their factory, the nodes they hold (a neighbour's sea route opens from one of
  // them), and the islands that have attacked theirs in the last week, which they may answer by any way.
  if (op.t === "whois") {
    if (s.owner.id !== op.player) return done(403, fail("not-owner"));
    const since = now - ANSWER_MS;
    const attackers = [...new Set([...s.expeditions.map((e) => e.by.code), ...s.log.filter((e) => e.at >= since && (e.t === "noticed" || e.t === "landed" || e.t === "taken")).map((e) => e.by.code)])];
    return done(200, { ok: true, factory: s.factory, name: s.owner.name, held: NODE_IDS.filter((_, i) => s.holds[i] === "freed"), attackers });
  }
  if (op.t === "log") {
    if (s.owner.id !== op.player) return done(403, fail("not-owner"));
    const entries = s.log.filter((e) => e.seq > op.after);
    return done(200, { ok: true, entries, next: s.seq });
  }
  // An async look-mark on the island map (ux-design M6): the owner only; left after a raid, not live.
  if (op.t === "ping") {
    if (s.owner.id !== op.player) return done(403, fail("not-owner"));
    if (!Number.isFinite(op.x) || !Number.isFinite(op.z)) return done(400, fail("bad-request"));
    prunePings(s, now);
    s.pings ??= [];
    s.pings.push({ id: s.nextId++, x: op.x, z: op.z, by: op.name, until: now + EXPEDITION.pingTtl * 1000 });
    prunePings(s, now);
    return done(200, { ok: true, pings: s.pings }, true);
  }
  // Aid donation to this island (ux-design C2): a neighbour leaves a parcel at a depot.
  if (op.t === "aid") {
    if (op.from.code === s.owner.code) return done(403, fail("own-island"));
    if (!DEPOT_POIS.includes(op.poi) || typeof op.kind !== "string" || !op.kind) return done(400, fail("bad-request"));
    s.parcels ??= [];
    s.parcels.push({ id: s.nextId++, poi: op.poi, kind: op.kind, from: { ...op.from }, at: now });
    if (s.parcels.length > EXPEDITION.parcelMax) s.parcels = s.parcels.slice(s.parcels.length - EXPEDITION.parcelMax);
    return done(200, { ok: true }, true);
  }
  // An expedition.
  if (op.from.code === s.owner.code) return done(403, fail("own-island"));
  if (ISLAND_TABLE.closed.includes(op.target)) return done(403, fail("closed-node"));
  const i = NODE_IDS.indexOf(op.target);
  if (i < 0 || !op.kinds.length) return done(400, fail("bad-request"));
  const why = closedWhy(s, i, now);
  if (why) return done(why.status, fail(why.error));
  const e: Expedition = { id: s.nextId++, by: { ...op.from }, target: i, units: op.kinds.map(unit), sentAt: now, arriveAt: now + EXPEDITION.notice * 1000, arrived: false, holding: false };
  s.expeditions.push(e);
  note(s, now, "noticed", i, e.by);
  return done(201, { ok: true, id: e.id, arriveAt: e.arriveAt }, true);
}

/** The nodes a report names as taken back in the raid, or null: node ids, each once, at most one per node. Left out, none. */
export function parseRetaken(raw: unknown): string[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > NODE_IDS.length) return null;
  if (!raw.every((id, k) => typeof id === "string" && NODE_IDS.includes(id) && raw.indexOf(id) === k)) return null;
  return raw as string[];
}

/** The holds of a report, or null: one readable hold for each node. */
export function parseHolds(raw: unknown): PoiHold[] | null {
  if (!Array.isArray(raw) || raw.length !== NODE_IDS.length) return null;
  const out = raw.map(parseHold);
  return out.every((h) => h !== null) ? (out as PoiHold[]) : null;
}

/** The units an attacker at factory level `factory` may send: its factory's squad (`FACTORY.levels[].kinds`). */
export const squadKinds = (factory: number): readonly EnemyKind[] => FACTORY.levels[Math.max(0, Math.min(FACTORY_TOP, factory))].kinds;

/** Aid parcels left in a raid report, or null when unreadable. Left out, none. Depot POIs, not only front nodes. */
export function parseParcels(raw: unknown): IslandParcel[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > EXPEDITION.parcelMax) return null;
  const out: IslandParcel[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") return null;
    const o = r as Record<string, unknown>;
    const from = o.from && typeof o.from === "object" ? (o.from as Attacker) : null;
    if (!from || typeof from.code !== "string" || typeof from.name !== "string" || typeof o.poi !== "string" || typeof o.kind !== "string") return null;
    if (!DEPOT_POIS.includes(o.poi)) return null;
    out.push({ id: 0, poi: o.poi, kind: o.kind, from: { code: from.code, name: from.name }, at: 0 });
  }
  return out;
}

/** Parcel ids taken in a raid report, or null. Left out, none. */
export function parseTakenParcels(raw: unknown): number[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > EXPEDITION.parcelMax) return null;
  if (!raw.every((id, k) => Number.isInteger(id) && (id as number) > 0 && raw.indexOf(id) === k)) return null;
  return raw as number[];
}

/** What a report says became of the expeditions its raid took in, or null: each the island's number and the members left, each number once. Left out, none. */
export function parseLent(raw: unknown): LentResult[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > EXPEDITION.perIsland) return null;
  const ok = (r: unknown): r is LentResult => !!r && typeof r === "object" && Number.isInteger((r as LentResult).id) && (r as LentResult).id > 0 && Number.isInteger((r as LentResult).left) && (r as LentResult).left >= 0 && (r as LentResult).left <= 64;
  if (!raw.every(ok) || new Set(raw.map((r) => r.id)).size !== raw.length) return null;
  return raw.map((r) => ({ id: r.id, left: r.left, ...((r as { waiting?: unknown }).waiting === true ? { waiting: true as const } : {}) }));
}
