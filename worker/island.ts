import { CONQUEST, ENEMIES, FACTORY, FACTORY_TOP, PLATE, type EnemyKind } from "../src/ringfall/sim/config";
import { reckonApart, standing, type Guard, type NodeMeter, type ReckonSquad, type Task, type Unit } from "../src/ringfall/sim/reckon";
import { parseHold, rivalHold, rivalOf, type PoiHold } from "../src/ringfall/sim/holds";
import { ISLAND_TABLE } from "../src/ringfall/meta/island-table";
import type { ApiError } from "../src/ringfall/meta/island-errors";
import { CONTESTED_SHORES as CLIENT_CONTESTED, isContestedShore as clientContested } from "../src/ringfall/meta/neighbours";
import { DAY_MS, OUTER_GUARD, utcDay, utcDayEnd } from "../src/ringfall/meta/outer-guard";

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

/** Normalizes a hold string to "own" | "foe" | RivalHold, accepting legacy "freed" / "held". */
export function normalizeHold(raw: unknown): PoiHold {
  return parseHold(raw) ?? "foe";
}

/** Migrates an IslandState loaded from storage/network, ensuring holds are normalized to "own" | "foe" | RivalHold. */
export function migrateIslandState(s: IslandState): IslandState {
  if (Array.isArray(s.holds)) {
    s.holds = s.holds.map((h) => normalizeHold(h));
  }
  // Fortify (核 · 固める) removed 2026-11-24: drop any leftover shut times from older islands.
  if ("fort" in s) delete (s as { fort?: number[] }).fort;
  // Contested same-day shield (方向 A): older islands have none.
  if (!s.shielded) s.shielded = { day: 0, nodes: [] };
  return s;
}

/** Outer-edge hubs contested with neighbours (作り順②; derived in sim/contested-outer.ts). */
export const CONTESTED_SHORES: readonly string[] = CLIENT_CONTESTED;

export const isContestedShore = (id: string): boolean => clientContested(id);

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
   * at once. Defence is automatic (factory / parcels); a raid the owner starts before then takes the
   * expedition in (`lease`).
   */
  notice: 12 * 3600,
  /** Seconds a lease lasts: a raid's battle and time to settle it. Unreported by then, the island goes on in numbers from where the lease found it. */
  lease: CONQUEST.time + 1800,
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
  /**
   * X2 player-led short raid (docs/ringfall/game-design-review.md §5.8): same 来る遠征 notice,
   * no numeric fight; the sender's `assault` op settles win/loss after the notice.
   */
  x2?: true;
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
   * Own contested outer hubs lost this UTC day (作り順③ loss cap). Separate from `taken`
   * (EXPEDITION.perDay), so a take of an enemy-held or inner node does not burn the outer cap.
   * Optional on older islands (migrate / missing → 0).
   */
  outerTaken?: { day: number; n: number };
  /**
   * Contested hubs taken on UTC day `day` (方向 A / TKT-195): those node indices cannot change hands
   * again until the next UTC day. Optional on older islands (migrate fills empty).
   * `island` (作り順③): after a loss, remaining own outer hubs are shielded for the rest of that UTC day.
   */
  shielded?: { day: number; nodes: number[]; island?: boolean };
  /**
   * The owner's raid has the expeditions `ids` until `until`: the island leaves them as they are
   * meanwhile, and the raid's report says what became of them. Left out or null, none. (Optional:
   * islands stored before leases have none.)
   */
  lease?: { until: number; ids: number[] } | null;
  /** Async look-marks the owner left (ux-design M6); pruned past `until`. Optional on older islands. */
  pings?: IslandPing[];
  /** Aid parcels at depots (ux-design C2, CoC-style donation). Optional on older islands. */
  parcels?: IslandParcel[];
  /**
   * Holdings another player's sortie took (`raid`) that the owner's reports have not yet shown as lost:
   * a report still calling one the owner's, from a copy of the island older than the loss, leaves it
   * the robots'. It leaves this list once a report shows it lost or names it among `retaken`.
   * Optional on older islands.
   */
  raided?: number[];
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
  | { t: "report"; player: { id: string; name: string }; holds: PoiHold[]; retaken: string[]; factory: number; day: number; lent?: LentResult[]; parcels?: IslandParcel[]; takenParcels?: number[] }
  | { t: "lease"; player: string }
  | { t: "releaseLease"; player: string }
  | { t: "recall"; from: string; id: number }
  | { t: "view" }
  | { t: "log"; player: string; after: number }
  | { t: "whois"; player: string }
  | { t: "expedition"; from: Attacker; target: string; kinds: EnemyKind[]; x2?: true }
  | { t: "assault"; from: string; id: number; won: boolean }
  /** Mirror contested ownership onto this island's shore (方向 A): set hold to rival:owner or own. `name` is the owner's player-facing name for the log. */
  | { t: "contestedMirror"; shore: string; owner: string; name?: string; at: number }
  /** Failed contested attack on this island's shore (TKT-201): log 守りきった for the defender. */
  | { t: "contestedDefend"; shore: string; from: Attacker; at: number }
  | { t: "ping"; player: string; name: string; x: number; z: number }
  | { t: "aid"; from: Attacker; poi: string; kind: string }
  /**
   * Another player's sortie on a holding of this island (docs/ringfall/glossary.md 攻め): reported by
   * the attacker when it ends. Captured, the holding goes back to the robots with its 島の守り;
   * else the owner is told it held (守りきった). The island's day shield and loss cap still hold.
   */
  | { t: "raid"; from: Attacker; target: string; captured: boolean };

/** The answer to an op: the HTTP status and body, and the island as it is after it (null while nobody has claimed it). */
export interface OpResult {
  status: number;
  body: unknown;
  state: IslandState | null;
  /** Whether the island must be stored: a tick was reckoned or the op changed it. Reads of an island where nothing happened store nothing (the clock's jump over idle time comes out the same when worked out again). */
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

/** Nodes taken from the island by expeditions on the UTC day of `t`. */
const takenOn = (s: IslandState, t: number) => (s.taken.day === utcDay(t) ? s.taken.n : 0);

/** Own contested outer hubs lost on the UTC day of `t` (作り順③). */
export const outerTakenOn = (s: IslandState, t: number) => (s.outerTaken?.day === utcDay(t) ? s.outerTaken.n : 0);

/** Whether the island's remaining own outer hubs are shielded at `t` (作り順③). */
export function isIslandShielded(s: IslandState, t: number): boolean {
  const sh = s.shielded;
  return !!sh?.island && sh.day === utcDay(t);
}

/**
 * Whether contested node `i` cannot change hands at `t`:
 * per-hub same-day shield, or island-wide shield on a still-owned outer hub (作り順③).
 */
export function isShielded(s: IslandState, i: number, t: number): boolean {
  const sh = s.shielded;
  if (!sh || sh.day !== utcDay(t)) return false;
  if (sh.nodes.includes(i)) return true;
  return !!sh.island && isContestedShore(NODE_IDS[i]) && s.holds[i] === "own";
}

/** Mark contested node `i` shielded for the UTC day of `at`. */
export function shieldNode(s: IslandState, i: number, at: number) {
  if (!isContestedShore(NODE_IDS[i])) return;
  const day = utcDay(at);
  if (!s.shielded || s.shielded.day !== day) s.shielded = { day, nodes: [i], island: false };
  else if (!s.shielded.nodes.includes(i)) s.shielded.nodes.push(i);
}

/** Raise the island-wide shield for the rest of the UTC day of `at` (作り順③). */
export function markIslandShield(s: IslandState, at: number) {
  const day = utcDay(at);
  if (!s.shielded || s.shielded.day !== day) s.shielded = { day, nodes: [], island: true };
  else s.shielded.island = true;
}

/**
 * Loss-cap for taking an own contested outer hub at `t` (作り順③).
 * Counts only outer-owner losses (`outerTaken`), not every expedition capture.
 */
export function outerLossCapReached(s: IslandState, t: number): boolean {
  return outerTakenOn(s, t) >= OUTER_GUARD.lossCap;
}

/** Record one own contested outer hub lost at `at` (loss cap + island shield). */
export function recordOuterTaken(s: IslandState, at: number) {
  const day = utcDay(at);
  s.outerTaken = { day, n: outerTakenOn(s, at) + 1 };
  markIslandShield(s, at);
}

function appendLog(s: IslandState, at: number, t: LogEntry["t"], node: number, by: Attacker) {
  if (t === "taken") {
    s.taken = { day: utcDay(at), n: takenOn(s, at) + 1 };
    // Hold still shows the pre-flip owner here (caller updates holds after / separately).
    if (isContestedShore(NODE_IDS[node]) && s.holds[node] === "own") recordOuterTaken(s, at);
  }
  if (t === "taken" || t === "retaken") shieldNode(s, node, at);
  s.log.push({ seq: ++s.seq, at, t, node: NODE_IDS[node], by: { ...by } });
  if (s.log.length > EXPEDITION.logMax) s.log.splice(0, s.log.length - EXPEDITION.logMax);
}

/**
 * Why node `i` cannot accept an expedition at `now`, or null when it is available.
 * Returns the HTTP status and ApiError if refused (closed node, protection, limits, etc.).
 */
function expeditionRefusal(s: IslandState, i: number, now: number): { status: number; error: ApiError } | null {
  if (ISLAND_TABLE.campNext.includes(NODE_IDS[i])) return { status: 403, error: "closed-node" };
  if (s.holds[i] !== "foe" && s.holds[i] !== "own") return { status: 409, error: "node-not-open" };
  if (now - s.since < EXPEDITION.protectDays * DAY_MS) return { status: 403, error: "protected" };
  // 作り順③: island shield / outer loss cap block further takes of own contested hubs.
  if (s.holds[i] === "own" && isContestedShore(NODE_IDS[i])) {
    if (isShielded(s, i, now)) return { status: 409, error: "shielded" };
    if (outerLossCapReached(s, now)) return { status: 409, error: "day-limit" };
  }
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
  const newPlayerUntil = s.since + EXPEDITION.protectDays * DAY_MS;
  const raidShieldUntil = isIslandShielded(s, now) ? utcDayEnd(now) : 0;
  return {
    ok: true,
    code: s.owner.code,
    owner: s.owner.name,
    day: s.day,
    factory: s.factory,
    // New-player protect or post-loss island shield (作り順③), whichever ends later.
    protectedUntil: Math.max(newPlayerUntil, raidShieldUntil),
    /** Island shield end (UTC day end) while 作り順③ shield is up; 0 when none. */
    shieldUntil: raidShieldUntil,
    /** Own outer hubs lost this UTC day / loss cap (作り順③). */
    outerLost: outerTakenOn(s, now),
    outerLossCap: OUTER_GUARD.lossCap,
    nodes: NODE_IDS.map((id, i) => ({ id, hold: s.holds[i], open: expeditionRefusal(s, i, now) === null })),
    expeditions: s.expeditions.map((e) => ({
      id: e.id,
      by: { ...e.by },
      target: NODE_IDS[e.target],
      units: e.units.length,
      // X2 after notice stands as waiting (no numeric fight) until the sender's assault report.
      state: e.holding ? "holding" : !e.arrived ? "coming" : e.x2 || heldBack(s, e, now) ? "waiting" : "attacking",
      arriveAt: e.arriveAt,
      ...(e.x2 ? { x2: true as const } : {}),
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
  if (s.holds[i] === "foe") s.guards[i] ??= garrisonGuards(s.owner.code, i);
  if (s.holds[i] === "own" && !s.defenders.some((d) => d.to === i && d.task === "post")) {
    for (let k = 0; k < FACTORY.levels[s.factory].turrets; k++) s.defenders.push({ id: s.nextId++, to: i, units: [unit("heavy")], task: "post" });
    // Aid left at depots (own leave-aid use, or a neighbour's donation) joins this defence.
    spendAid(s, i);
  }
}

/**
 * Whether expedition `e` is held back at `t`: at its node, not holding it, while the island has lost
 * its day's nodes (`EXPEDITION.perDay`). It stays out of its node's fight altogether until the next
 * UTC day: nobody fights it and the factory sends nothing at it.
 */
function heldBack(s: IslandState, e: Expedition, t: number): boolean {
  return e.arrived && !e.holding && takenOn(s, t) >= EXPEDITION.perDay;
}

/** Whether the owner's raid currently holds expedition `e` under a lease at `t`. */
const isLeased = (s: IslandState, e: Expedition, t: number) => !!s.lease && t < s.lease.until && s.lease.ids.includes(e.id);

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
    if (!e.arrived && e.arriveAt <= t && !isLeased(s, e, t)) {
      e.arrived = true;
      appendLog(s, t, "landed", e.target, e.by);
      // X2 waits for the sender's short-raid report; no factory fight in numbers.
      if (!e.x2) startFight(s, e.target);
      else e.waiting = true;
    }
  // Those the owner's raid has stand out of the island's reckoning as those held back do.
  // X2 not yet settled never joins the numeric fight.
  const withheld = new Set(s.expeditions.filter((e) => (e.x2 && !e.holding) || heldBack(s, e, t) || (e.arrived && !e.holding && isLeased(s, e, t))));
  // One held back until now may attack: its node's fight starts as at its arrival (the turrets go back to their posts).
  for (const e of s.expeditions) {
    if (e.x2 && !e.holding) {
      e.waiting = true;
      continue;
    }
    if (e.waiting && !withheld.has(e)) startFight(s, e.target);
    if (withheld.has(e)) e.waiting = true;
    else delete e.waiting;
  }
  const fightingExpeditions = s.expeditions.filter((e) => e.arrived && !withheld.has(e));
  // The factory sends a squad to the first of the owner's nodes under attack, as in a raid, while it has room.
  const lv = FACTORY.levels[s.factory];
  const attacked = fightingExpeditions.find((e) => !e.holding && s.holds[e.target] === "own");
  s.made = Math.min(lv.every, s.made + CONQUEST.tick);
  if (attacked && s.made >= lv.every && s.defenders.filter((d) => d.task !== "post").length < lv.max) {
    s.defenders.push({ id: s.nextId++, to: attacked.target, units: lv.kinds.map(unit), task: "defend" });
    s.made = 0;
  }
  const squads = [...fightingExpeditions.map(expeditionSquad), ...s.defenders.map(defenderSquad)];
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
      // was and the meter starts over. Contested outer hubs use OUTER_GUARD.lossCap + island shield
      // (作り順③); other expedition takes still use EXPEDITION.perDay.
      const contested = isContestedShore(NODE_IDS[ef.node]);
      const capHit = contested ? outerLossCapReached(s, t) : takenOn(s, t) >= EXPEDITION.perDay;
      if (capHit || isShielded(s, ef.node, t)) {
        holds[ef.node] = s.holds[ef.node];
        meter[ef.node] = null;
        continue;
      }
      const e = fightingExpeditions.find((x) => x.target === ef.node && x.by.code === ef.owner);
      if (e) {
        e.holding = true;
        appendLog(s, t, "taken", ef.node, e.by);
      }
    } else if (ef.side === 0) {
      if (isShielded(s, ef.node, t)) {
        holds[ef.node] = s.holds[ef.node];
        meter[ef.node] = null;
        continue;
      }
      for (const e of fightingExpeditions.filter((x) => x.target === ef.node)) e.holding = false;
      appendLog(s, t, "retaken", ef.node, { code: s.owner.code, name: s.owner.name });
    }
  }
  s.holds = holds;
  s.meter = meter;
  s.expeditions = s.expeditions.filter((e) => {
    if (!e.arrived || withheld.has(e)) return true;
    const q = by.get(e.id);
    if (q) {
      e.units = q.units;
      return true;
    }
    appendLog(s, t, "wiped", e.target, e.by);
    // Holders lost: the node goes back to the enemy (取った拠点の維持).
    if (rivalOf(s.holds[e.target]) === e.by.code) {
      s.holds[e.target] = "foe";
      appendLog(s, t, "released", e.target, e.by);
    }
    return false;
  });
  // The owner's squads stay while an expedition not held back is at their node; the rest go home.
  s.defenders = s.defenders.flatMap((d) => {
    const q = by.get(d.id);
    return q && s.expeditions.some((e) => e.arrived && !withheld.has(e) && e.target === d.to) ? [{ ...d, units: q.units, task: q.task }] : [];
  });
}

/**
 * Whether a tick at `t` would change nothing but the factory's work: no squad of the owner's out, no
 * meter filling, and every expedition at its node holding it or held back. Expeditions still coming
 * and held back ones wait for a time of their own (`idleUntil()`).
 */
function isIdle(s: IslandState, t: number): boolean {
  return !s.defenders.length && !s.meter.some((m) => m) && s.expeditions.every((e) => !e.arrived || e.holding || e.x2 || heldBack(s, e, t) || isLeased(s, e, t));
}

/** The first time something happens on an idle island after `t`: an expedition arriving, a lease running out, or the next UTC day or the node's opening for one held back; Infinity for none. */
function idleUntil(s: IslandState, t: number): number {
  let at = Infinity;
  for (const e of s.expeditions) {
    if (e.holding) continue;
    // X2 after notice waits on the sender's assault report, not a tick.
    if (e.x2 && e.arrived) continue;
    if (isLeased(s, e, t)) at = Math.min(at, s.lease!.until);
    else if (!e.arrived) at = Math.min(at, e.arriveAt);
    else if (heldBack(s, e, t)) {
      if (takenOn(s, t) >= EXPEDITION.perDay) at = Math.min(at, (utcDay(t) + 1) * DAY_MS);
    }
  }
  return at;
}

/**
 * The island reckoned to `now` in whole ticks, `EXPEDITION.maxTicks` at most: whether it is still
 * behind, and whether a tick was reckoned (`moved`). Over idle time (`isIdle()`) the clock jumps to
 * the tick before the next thing that happens, which comes out as ticking through it would.
 */
export function advance(s: IslandState, now: number, maxTicks = EXPEDITION.maxTicks): { behind: boolean; moved: boolean } {
  migrateIslandState(s);
  prunePings(s, now);
  const every = FACTORY.levels[s.factory].every;
  let n = 0;
  for (;;) {
    const due = Math.floor((now - s.clock) / TICK_MS);
    if (due <= 0) return { behind: false, moved: n > 0 };
    if (isIdle(s, s.clock + TICK_MS)) {
      // The tick that sees the next event is the first at or after it; jump to the one before.
      const until = idleUntil(s, s.clock + TICK_MS);
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
  if (!isIdle(s, now)) return now + EXPEDITION.alarmMs;
  const until = idleUntil(s, now);
  if (until === Infinity) return null;
  // The tick that reckons the event: the first on the island's grid (clock + k ticks) at or after it.
  return Math.max(now + 1, s.clock + Math.ceil((until - s.clock) / TICK_MS) * TICK_MS);
}

/** A new island claimed at `now` for the player of `op`: every node the enemy's until the owner's first report. */
function claim(op: Extract<IslandOp, { t: "claim" }>, now: number): IslandState {
  return {
    owner: { id: op.player.id, name: op.player.name, code: op.code },
    holds: NODE_IDS.map(() => "foe"),
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
    shielded: { day: 0, nodes: [] },
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
/**
 * Owner's report. Returns contested shores that became the owner's this report (for neighbour mirror
 * sync: foe→own and rival→own alike, TKT-201) and any refused for same-day shield.
 * `contestedRetaken` is kept as the rival→own subset for older API callers.
 */
function report(
  s: IslandState,
  op: Extract<IslandOp, { t: "report" }>,
  now: number,
): {
  contestedTaken: { shore: string; from: string | null }[];
  contestedRetaken: { shore: string; from: string }[];
  shielded: string[];
} {
  s.owner.name = op.player.name;
  s.factory = op.factory;
  s.day = op.day;
  const contestedTaken: { shore: string; from: string | null }[] = [];
  const contestedRetaken: { shore: string; from: string }[] = [];
  const shielded: string[] = [];
  op.holds.forEach((h, i) => {
    const cur = s.holds[i];
    if (rivalOf(cur) !== null) {
      if (h !== "own" || !op.retaken.includes(NODE_IDS[i])) return;
      if (isShielded(s, i, now)) {
        shielded.push(NODE_IDS[i]);
        return;
      }
      const from = rivalOf(cur)!;
      s.holds[i] = "own";
      const gone = s.expeditions.filter((e) => e.target === i);
      s.expeditions = s.expeditions.filter((e) => e.target !== i);
      appendLog(s, now, "retaken", i, gone[0]?.by ?? { code: from, name: "" });
      if (isContestedShore(NODE_IDS[i])) {
        contestedTaken.push({ shore: NODE_IDS[i], from });
        contestedRetaken.push({ shore: NODE_IDS[i], from });
      }
    } else if (h === "foe" || h === "own") {
      // A holding a sortie took stays lost until the owner's copy shows it, or their raid takes it back.
      if (s.raided?.includes(i)) {
        if (h === "own" && !op.retaken.includes(NODE_IDS[i])) return;
        s.raided = s.raided.filter((k) => k !== i);
      }
      const was = cur;
      s.holds[i] = h;
      // Contested shore claimed from the enemy (方向 A / TKT-201): mirror onto this week's neighbour.
      if (h === "own" && was !== "own" && isContestedShore(NODE_IDS[i]) && op.retaken.includes(NODE_IDS[i])) {
        contestedTaken.push({ shore: NODE_IDS[i], from: null });
      }
    }
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
      appendLog(s, now, "landed", i, e.by);
    }
    if (r.left <= 0) {
      s.expeditions = s.expeditions.filter((x) => x !== e);
      appendLog(s, now, "wiped", i, e.by);
      // Same-day shield (方向 A): do not flip ownership via the leased wipe path either.
      if (theirs && !isShielded(s, i, now)) {
        s.holds[i] = op.holds[i] === "own" ? "own" : "foe";
        appendLog(s, now, "released", i, e.by);
      }
      continue;
    }
    e.units = e.units.slice(0, r.left);
    const told = op.holds[i];
    if (e.holding && theirs && told === "foe" && !isShielded(s, i, now)) {
      // The enemy took the node from its holders, who are at it again.
      s.holds[i] = "foe";
      e.holding = false;
      appendLog(s, now, "released", i, e.by);
    } else if (
      !e.holding &&
      rivalOf(told) === e.by.code &&
      !isShielded(s, i, now) &&
      (isContestedShore(NODE_IDS[i]) ? !outerLossCapReached(s, now) : takenOn(s, now) < EXPEDITION.perDay)
    ) {
      s.holds[i] = told;
      e.holding = true;
      appendLog(s, now, "taken", i, e.by);
      // CoC-style: the fallen node's 中継ボックス stock is lost (partial defence was already spent in startFight).
      const poi = NODE_IDS[i];
      if (s.parcels?.length) s.parcels = s.parcels.filter((p) => p.poi !== poi);
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
  s.guards = NODE_IDS.map(() => null);
  s.meter = NODE_IDS.map(() => null);
  s.defenders = [];
  s.made = FACTORY.levels[s.factory].every;
  for (const e of s.expeditions) {
    if (e.arrived && !e.holding && !heldBack(s, e, now)) startFight(s, e.target);
    // One held back as the report lands starts its node's fight when it may attack (`tick()`).
    else if (e.arrived && !e.holding) e.waiting = true;
  }
  return { contestedTaken, contestedRetaken, shielded };
}

/**
 * The owner's raid takes the expeditions on the island in (レイド中の遠征隊): every one of them, as it
 * stands. Until the raid's report, or `EXPEDITION.lease` seconds, the island leaves them as they are.
 * A lease still standing is answered again as it is and not made longer, so asking again and again
 * holds nobody off. X2 notices are not lent as robots — the sender plays the short raid.
 */
function lease(s: IslandState, now: number): { until: number; expeditions: Lent[]; wrote: boolean } {
  const standing = s.lease && now < s.lease.until ? s.lease : null;
  const ids = standing ? standing.ids : s.expeditions.filter((e) => !e.x2).map((e) => e.id);
  const until = standing ? standing.until : now + EXPEDITION.lease * 1000;
  if (!standing) s.lease = ids.length ? { until, ids } : null;
  const expeditions = s.expeditions
    .filter((e) => ids.includes(e.id))
    .map((e): Lent => ({ id: e.id, by: { ...e.by }, target: NODE_IDS[e.target], kinds: e.units.map((u) => u.kind), state: e.holding ? "holding" : e.arrived ? "attacking" : "coming" }));
  return { until, expeditions, wrote: !standing && ids.length > 0 };
}

/**
 * X2 short-raid result from the attacker: after the 来る遠征 notice, a win takes the node for
 * them; a loss wipes the notice. Minimal checks — notice elapsed, still x2, node still the owner's
 * when winning. Idempotent when already holding the same node.
 */
function assault(s: IslandState, from: string, id: number, won: boolean, now: number): { status: number; body: unknown } {
  const e = s.expeditions.find((x) => x.id === id && x.by.code === from);
  if (!e) return { status: 404, body: fail("no-expedition") };
  if (!e.x2) return { status: 400, body: fail("not-assault") };
  if (e.holding) {
    if (won && rivalOf(s.holds[e.target]) === from) return { status: 200, body: { ok: true, id: e.id, hold: s.holds[e.target] } };
    return { status: 409, body: fail("already-resolved") };
  }
  if (now < e.arriveAt) return { status: 409, body: fail("assault-not-ready") };
  if (!e.arrived) {
    e.arrived = true;
    appendLog(s, now, "landed", e.target, e.by);
  }
  if (!won) {
    s.expeditions = s.expeditions.filter((x) => x !== e);
    appendLog(s, now, "wiped", e.target, e.by);
    return { status: 200, body: { ok: true, id, won: false } };
  }
  if (s.holds[e.target] !== "own") return { status: 409, body: fail("node-not-open") };
  const assaultContested = isContestedShore(NODE_IDS[e.target]);
  if (assaultContested ? outerLossCapReached(s, now) : takenOn(s, now) >= EXPEDITION.perDay) {
    return { status: 409, body: fail("day-limit") };
  }
  if (isShielded(s, e.target, now)) return { status: 409, body: fail("shielded") };
  e.holding = true;
  delete e.waiting;
  s.holds[e.target] = rivalHold(from);
  const poi = NODE_IDS[e.target];
  if (s.parcels?.length) s.parcels = s.parcels.filter((p) => p.poi !== poi);
  appendLog(s, now, "taken", e.target, e.by);
  return {
    status: 200,
    body: {
      ok: true,
      id,
      won: true,
      hold: s.holds[e.target],
      ...(isContestedShore(poi) ? { contested: { shore: poi, owner: from } } : {}),
    },
  };
}

/**
 * Mirror a contested hub onto this island: if `owner` is this island's code, shore becomes own;
 * otherwise rival:owner. Applies same-day shield. Refuses when already shielded today.
 */
/**
 * Defender notice for a failed contested attack (TKT-201): appends `wiped` so the owner's sync
 * shows 「{誰}が{拠点}を攻めた · 守りきった」 and awards the attacker's M (`defenceWin`). Holds unchanged.
 */
function contestedDefend(s: IslandState, shore: string, from: Attacker, at: number): { status: number; body: unknown } {
  const i = NODE_IDS.indexOf(shore);
  if (i < 0 || !isContestedShore(shore)) return { status: 400, body: fail("bad-request") };
  if (!from?.code || typeof from.name !== "string") return { status: 400, body: fail("bad-request") };
  appendLog(s, at, "wiped", i, { code: from.code, name: from.name.trim().slice(0, 24) });
  return { status: 200, body: { ok: true } };
}

function contestedMirror(s: IslandState, shore: string, owner: string, at: number, name = ""): { status: number; body: unknown } {
  const i = NODE_IDS.indexOf(shore);
  if (i < 0 || !isContestedShore(shore)) return { status: 400, body: fail("bad-request") };
  const next: PoiHold = owner === s.owner.code ? "own" : rivalHold(owner);
  const who = { code: owner, name: name.trim().slice(0, 24) };
  if (s.holds[i] === next) {
    shieldNode(s, i, at);
    return { status: 200, body: { ok: true, hold: s.holds[i], idempotent: true } };
  }
  if (isShielded(s, i, at)) return { status: 409, body: fail("shielded") };
  const takingFromOwner = s.holds[i] === "own" && owner !== s.owner.code;
  // 作り順③: loss cap + island shield block further outer losses the same UTC day.
  if (takingFromOwner && outerLossCapReached(s, at)) return { status: 409, body: fail("day-limit") };
  s.holds[i] = next;
  // Drop expeditions aiming at this shore when ownership flips.
  s.expeditions = s.expeditions.filter((e) => e.target !== i);
  if (takingFromOwner) recordOuterTaken(s, at);
  shieldNode(s, i, at);
  s.log.push({ seq: ++s.seq, at, t: owner === s.owner.code ? "retaken" : "taken", node: shore, by: who });
  if (s.log.length > EXPEDITION.logMax) s.log.splice(0, s.log.length - EXPEDITION.logMax);
  return { status: 200, body: { ok: true, hold: s.holds[i] } };
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
    s.holds[e.target] = "foe";
    appendLog(s, now, "released", e.target, e.by);
  } else appendLog(s, now, "recalled", e.target, e.by);
  return true;
}

/** Applies `op` to the island at `now` (reckoned to `now` first). The state passed in is changed in place. */
export function islandOp(state: IslandState | null, op: IslandOp, now: number): OpResult {
  const s = state ? migrateIslandState(state) : null;
  const moved = s ? advance(s, now).moved : false;
  const done = (status: number, body: unknown, wrote = false): OpResult => ({ status, body, state: s, changed: moved || wrote });
  // The server draws the code (worker/api.ts): one already claimed answers 409 and it draws again.
  if (op.t === "claim") return s ? done(409, fail("code-taken")) : { status: 201, body: { ok: true, code: op.code }, state: claim(op, now), changed: true };
  if (!s) return done(404, fail("no-island"));
  if (op.t === "report") {
    if (s.owner.id !== op.player.id) return done(403, fail("not-owner"));
    op.holds = op.holds.map(normalizeHold);
    const r = report(s, op, now);
    return done(
      200,
      { ok: true, holds: s.holds, contestedTaken: r.contestedTaken, contestedRetaken: r.contestedRetaken, shielded: r.shielded },
      true,
    );
  }
  if (op.t === "contestedMirror") {
    const r = contestedMirror(s, op.shore, op.owner, op.at, op.name);
    return done(r.status, r.body, r.status === 200);
  }
  if (op.t === "contestedDefend") {
    const r = contestedDefend(s, op.shore, op.from, op.at);
    return done(r.status, r.body, r.status === 200);
  }
  if (op.t === "lease") {
    if (s.owner.id !== op.player) return done(403, fail("not-owner"));
    const l = lease(s, now);
    return done(200, { ok: true, until: l.until, expeditions: l.expeditions }, l.wrote);
  }
  if (op.t === "releaseLease") {
    // The raid the lease was for is not taking the expeditions in: the island reckons them again from now.
    if (s.owner.id !== op.player) return done(403, fail("not-owner"));
    const had = !!s.lease;
    s.lease = null;
    return done(200, { ok: true }, had);
  }
  if (op.t === "recall") return recall(s, op.from, op.id, now) ? done(200, { ok: true }, true) : done(404, fail("no-expedition"));
  if (op.t === "assault") {
    const r = assault(s, op.from, op.id, op.won, now);
    return done(r.status, r.body, r.status === 200);
  }
  if (op.t === "view") return done(200, publicView(s, now));
  // Who the sender is, their factory, the nodes they hold (a neighbour's sea route opens from one of
  // them), and the islands that have attacked theirs in the last week, which they may answer by any way.
  if (op.t === "whois") {
    if (s.owner.id !== op.player) return done(403, fail("not-owner"));
    const since = now - ANSWER_MS;
    const attackers = [...new Set([...s.expeditions.map((e) => e.by.code), ...s.log.filter((e) => e.at >= since && (e.t === "noticed" || e.t === "landed" || e.t === "taken")).map((e) => e.by.code)])];
    return done(200, { ok: true, factory: s.factory, name: s.owner.name, held: NODE_IDS.filter((_, i) => s.holds[i] === "own"), attackers });
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
  if (op.t === "raid") {
    if (op.from.code === s.owner.code) return done(403, fail("own-island"));
    const i = NODE_IDS.indexOf(op.target);
    if (i < 0) return done(400, fail("bad-request"));
    // Only a holding is attacked; one already gone is no news for its owner.
    if (s.holds[i] !== "own") return done(409, fail("node-not-open"));
    const guarded = isShielded(s, i, now) || isIslandShielded(s, now) || outerLossCapReached(s, now);
    if (!op.captured || guarded) {
      appendLog(s, now, "wiped", i, op.from);
      return done(200, { ok: true, taken: false }, true);
    }
    const poi = NODE_IDS[i];
    const seized = (s.parcels ?? []).filter((q) => q.poi === poi);
    s.parcels = (s.parcels ?? []).filter((q) => q.poi !== poi);
    // Back to the robots first, so the log counts the day's loss once (here, not as a contested shore's).
    s.holds[i] = "foe";
    s.raided = [...(s.raided ?? []).filter((k) => k !== i), i];
    appendLog(s, now, "taken", i, op.from);
    recordOuterTaken(s, now);
    return done(200, { ok: true, taken: true, parcels: seized.map((q) => q.kind) }, true);
  }
  // An expedition (optional `x2`: short-raid notice, settled later by `assault`).
  if (op.from.code === s.owner.code) return done(403, fail("own-island"));
  if (ISLAND_TABLE.closed.includes(op.target)) return done(403, fail("closed-node"));
  const i = NODE_IDS.indexOf(op.target);
  if (i < 0 || !op.kinds.length) return done(400, fail("bad-request"));
  // X2 only takes a node the owner holds (own) — the short raid's 核 · 制圧 target.
  if (op.x2 && s.holds[i] !== "own") return done(409, fail("node-not-open"));
  const why = expeditionRefusal(s, i, now);
  if (why) return done(why.status, fail(why.error));
  const e: Expedition = {
    id: s.nextId++,
    by: { ...op.from },
    target: i,
    units: op.kinds.map(unit),
    sentAt: now,
    arriveAt: now + EXPEDITION.notice * 1000,
    arrived: false,
    holding: false,
    ...(op.x2 ? { x2: true as const } : {}),
  };
  s.expeditions.push(e);
  appendLog(s, now, "noticed", i, e.by);
  return done(201, { ok: true, id: e.id, arriveAt: e.arriveAt, ...(op.x2 ? { x2: true } : {}) }, true);
}

/** Failed contested attacks in a report (TKT-201), or null when unreadable. Left out, none. */
export function parseContestedFailed(raw: unknown): { shore: string; owner: string }[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > CONTESTED_SHORES.length) return null;
  const out: { shore: string; owner: string }[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (!r || typeof r !== "object") return null;
    const o = r as Record<string, unknown>;
    if (typeof o.shore !== "string" || !isContestedShore(o.shore) || typeof o.owner !== "string" || !o.owner) return null;
    if (seen.has(o.shore)) continue;
    seen.add(o.shore);
    out.push({ shore: o.shore, owner: o.owner.slice(0, 16) });
  }
  return out;
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
