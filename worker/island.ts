import { CONQUEST, ENEMIES, FACTORY, FACTORY_TOP, PLATE, type EnemyKind } from "../src/ringfall/sim/config";
import { reckonApart, standing, type Guard, type NodeMeter, type ReckonSquad, type Task, type Unit } from "../src/ringfall/sim/reckon";
import { parseHold, rivalOf, type PoiHold } from "../src/ringfall/sim/holds";
import { ISLAND_TABLE } from "../src/ringfall/meta/island-table";

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
  /** Days an island is shielded from expeditions after its owner's first report (新しいプレイヤーの保護). */
  protectDays: 2,
  /** Expeditions on one island at once, those holding a node they took among them. */
  perIsland: 3,
  /** Nodes an island loses to expeditions in one UTC day; past it, the expeditions there stand off until the next. */
  perDay: 2,
  /** Seconds from an expedition's acceptance to its standing at its node: the landing and the walk, which the server does not trace. */
  arrive: CONQUEST.land.ship + 120,
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

/** Who owns an island: the player's secret id, the name others see and the island's code. */
export interface Owner {
  id: string;
  name: string;
  code: string;
}

/** An attacker as others see them: their island's code and name, never their id. */
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
}

/** One of the owner's factory squads defending a node an expedition came to: a turret (`post`) or a squad the factory sent. */
export interface Defender {
  id: number;
  to: number;
  units: Unit[];
  task: Task;
}

/** A change the owner reads: an expedition come to a node, a node taken, an expedition wiped out, a node taken back, or one whose holders were lost going back to the enemy. */
export interface LogEntry {
  seq: number;
  at: number;
  t: "landed" | "taken" | "wiped" | "retaken" | "released";
  node: string;
  by: Attacker;
}

export interface IslandState {
  owner: Owner;
  /** Each node's hold, in `NODE_IDS` order. Another player's is `rival:` and their island's code. */
  holds: PoiHold[];
  factory: number;
  /** The owner's day, as last reported. */
  day: number;
  /** The owner's first report: when the island's protection began. */
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
}

/** What one request asks of an island. */
export type IslandOp =
  | { t: "report"; player: { id: string; name: string }; code: string; holds: PoiHold[]; factory: number; day: number }
  | { t: "view" }
  | { t: "log"; player: string; after: number }
  | { t: "whois"; player: string }
  | { t: "expedition"; from: Attacker; target: string; kinds: EnemyKind[] };

/** The answer to an op: the HTTP status and body, and the island as it is after it (null while nobody has claimed it). */
export interface OpResult {
  status: number;
  body: unknown;
  state: IslandState | null;
}

const fail = (error: string) => ({ ok: false, error });

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
const takenOn = (s: IslandState, t: number) => s.log.filter((e) => e.t === "taken" && utcDay(e.at) === utcDay(t)).length;

function note(s: IslandState, at: number, t: LogEntry["t"], node: number, by: Attacker) {
  s.log.push({ seq: ++s.seq, at, t, node: NODE_IDS[node], by: { ...by } });
  if (s.log.length > EXPEDITION.logMax) s.log.splice(0, s.log.length - EXPEDITION.logMax);
}

/** Why node `i` takes no expedition now, or null when it does. */
function closedWhy(s: IslandState, i: number, now: number): { status: number; error: string } | null {
  if (ISLAND_TABLE.campNext.includes(NODE_IDS[i])) return { status: 403, error: "closed-node" };
  if (s.holds[i] !== "held" && s.holds[i] !== "freed") return { status: 409, error: "node-not-open" };
  if (now - s.since < EXPEDITION.protectDays * DAY_MS) return { status: 403, error: "protected" };
  if (s.expeditions.some((e) => e.target === i)) return { status: 409, error: "node-busy" };
  if (s.expeditions.length >= EXPEDITION.perIsland) return { status: 409, error: "island-full" };
  if (takenOn(s, now) + s.expeditions.filter((e) => !e.holding).length >= EXPEDITION.perDay) return { status: 409, error: "day-limit" };
  return null;
}

/** The island's state as anyone may see it: no player's id. */
export function publicView(s: IslandState, now: number) {
  return {
    ok: true,
    code: s.owner.code,
    owner: s.owner.name,
    day: s.day,
    factory: s.factory,
    protectedUntil: s.since + EXPEDITION.protectDays * DAY_MS,
    nodes: NODE_IDS.map((id, i) => ({ id, hold: s.holds[i], open: closedWhy(s, i, now) === null })),
    expeditions: s.expeditions.map((e) => ({
      by: { ...e.by },
      target: NODE_IDS[e.target],
      units: e.units.length,
      state: e.holding ? "holding" : e.arrived ? "attacking" : "coming",
    })),
  };
}

/** A fight begins at node `i`: a node of the enemy's stands its whole garrison (as it stands since the last report), one of the owner's its turrets. */
function startFight(s: IslandState, i: number) {
  if (s.holds[i] === "held") s.guards[i] ??= garrisonGuards(s.owner.code, i);
  if (s.holds[i] === "freed" && !s.defenders.some((d) => d.to === i && d.task === "post"))
    for (let k = 0; k < FACTORY.levels[s.factory].turrets; k++) s.defenders.push({ id: s.nextId++, to: i, units: [unit("heavy")], task: "post" });
}

/** An expedition at its node, as the reckoning sees it; standing off (passing) while the day's limit of nodes lost is reached. */
const expeditionSquad = (e: Expedition, off: boolean): ReckonSquad => ({
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
  ...(off && !e.holding && { passing: true }),
});

const defenderSquad = (d: Defender): ReckonSquad => ({ id: d.id, side: 0, units: d.units, to: d.to, task: d.task, x: d.to * SPREAD, z: 0, arrived: true, live: false, ashore: 0 });

/** One tick of the island at its clock `t`: arrivals, the factory's defence, then the battle's fights and captures. */
function tick(s: IslandState, t: number) {
  for (const e of s.expeditions)
    if (!e.arrived && e.arriveAt <= t) {
      e.arrived = true;
      startFight(s, e.target);
      note(s, t, "landed", e.target, e.by);
    }
  const here = s.expeditions.filter((e) => e.arrived);
  if (!here.length) return;
  // The factory sends a squad to the first of the owner's nodes under attack, as in a raid, while it has room.
  const lv = FACTORY.levels[s.factory];
  const attacked = here.find((e) => !e.holding && s.holds[e.target] === "freed");
  s.made = Math.min(lv.every, s.made + CONQUEST.tick);
  if (attacked && s.made >= lv.every && s.defenders.filter((d) => d.task !== "post").length < lv.max) {
    s.defenders.push({ id: s.nextId++, to: attacked.target, units: lv.kinds.map(unit), task: "defend" });
    s.made = 0;
  }
  const off = takenOn(s, t) >= EXPEDITION.perDay;
  const squads = [...here.map((e) => expeditionSquad(e, off)), ...s.defenders.map(defenderSquad)];
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
  s.meter = r.meter;
  const by = new Map(r.squads.map((q) => [q.id, q]));
  for (const ef of r.effects) {
    if (ef.t !== "seize") continue;
    if (ef.side === 3) {
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
  s.holds = r.holds;
  s.expeditions = s.expeditions.filter((e) => {
    if (!e.arrived) return true;
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
  // The owner's squads stay while an expedition is at their node; the rest go home.
  s.defenders = s.defenders.flatMap((d) => {
    const q = by.get(d.id);
    return q && s.expeditions.some((e) => e.arrived && e.target === d.to) ? [{ ...d, units: q.units, task: q.task }] : [];
  });
}

/**
 * The island reckoned to `now` in whole ticks, `EXPEDITION.maxTicks` at most; whether it is still
 * behind. With no expedition on it the clock jumps: nothing moves on an island nobody came to.
 */
export function advance(s: IslandState, now: number, maxTicks = EXPEDITION.maxTicks): boolean {
  const due = Math.floor((now - s.clock) / TICK_MS);
  if (due <= 0) return false;
  if (!s.expeditions.length) {
    s.clock += due * TICK_MS;
    s.made = FACTORY.levels[s.factory].every;
    return false;
  }
  const n = Math.min(due, maxTicks);
  for (let k = 0; k < n; k++) {
    s.clock += TICK_MS;
    tick(s, s.clock);
  }
  return due > n;
}

/** Whether the island needs its alarm: an expedition is on it. */
export const busy = (s: IslandState | null) => !!s && s.expeditions.length > 0;

/** A new island claimed by its owner's first report at `now`. */
function claim(op: Extract<IslandOp, { t: "report" }>, now: number): IslandState {
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
  };
}

/**
 * The owner's report after a raid. Nodes the server gave to other players stay theirs, except one
 * the owner reports as their own (taken back by its core in the raid): that one is the owner's, its
 * holders go, and the log says so. The owner cannot give a node to another player. The fights start
 * again from the island as reported: a raid stands every garrison whole.
 */
function report(s: IslandState, op: Extract<IslandOp, { t: "report" }>, now: number) {
  s.owner.name = op.player.name;
  s.factory = op.factory;
  s.day = op.day;
  op.holds.forEach((h, i) => {
    const cur = s.holds[i];
    if (rivalOf(cur) !== null) {
      if (h !== "freed") return;
      s.holds[i] = "freed";
      const gone = s.expeditions.filter((e) => e.target === i);
      s.expeditions = s.expeditions.filter((e) => e.target !== i);
      note(s, now, "retaken", i, gone[0]?.by ?? { code: rivalOf(cur)!, name: "" });
    } else if (h === "held" || h === "freed") s.holds[i] = h;
  });
  s.guards = NODE_IDS.map(() => null);
  s.meter = NODE_IDS.map(() => null);
  s.defenders = [];
  s.made = FACTORY.levels[s.factory].every;
  for (const e of s.expeditions) if (e.arrived && !e.holding) startFight(s, e.target);
}

/** Applies `op` to the island at `now` (reckoned to `now` first). The state passed in is changed in place. */
export function islandOp(state: IslandState | null, op: IslandOp, now: number): OpResult {
  const s = state;
  if (s) advance(s, now);
  const done = (status: number, body: unknown): OpResult => ({ status, body, state: s });
  if (op.t === "report") {
    if (!s) {
      const fresh = claim(op, now);
      report(fresh, op, now);
      return { status: 201, body: { ok: true, holds: fresh.holds }, state: fresh };
    }
    if (s.owner.id !== op.player.id) return done(403, fail("not-owner"));
    report(s, op, now);
    return done(200, { ok: true, holds: s.holds });
  }
  if (!s) return done(404, fail("no-island"));
  if (op.t === "view") return done(200, publicView(s, now));
  if (op.t === "whois") return s.owner.id === op.player ? done(200, { ok: true, factory: s.factory }) : done(403, fail("not-owner"));
  if (op.t === "log") {
    if (s.owner.id !== op.player) return done(403, fail("not-owner"));
    const entries = s.log.filter((e) => e.seq > op.after);
    return done(200, { ok: true, entries, next: s.seq });
  }
  // An expedition.
  if (op.from.code === s.owner.code) return done(403, fail("own-island"));
  if (ISLAND_TABLE.closed.includes(op.target)) return done(403, fail("closed-node"));
  const i = NODE_IDS.indexOf(op.target);
  if (i < 0 || !op.kinds.length) return done(400, fail("bad-request"));
  const why = closedWhy(s, i, now);
  if (why) return done(why.status, fail(why.error));
  const e: Expedition = { id: s.nextId++, by: { ...op.from }, target: i, units: op.kinds.map(unit), sentAt: now, arriveAt: now + EXPEDITION.arrive * 1000, arrived: false, holding: false };
  s.expeditions.push(e);
  return done(201, { ok: true, id: e.id, arriveAt: e.arriveAt });
}

/** The holds of a report, or null: one readable hold for each node. */
export function parseHolds(raw: unknown): PoiHold[] | null {
  if (!Array.isArray(raw) || raw.length !== NODE_IDS.length) return null;
  const out = raw.map(parseHold);
  return out.every((h) => h !== null) ? (out as PoiHold[]) : null;
}

/** The units an attacker at factory level `factory` may send: its factory's squad (`FACTORY.levels[].kinds`). */
export const squadKinds = (factory: number): readonly EnemyKind[] => FACTORY.levels[Math.max(0, Math.min(FACTORY_TOP, factory))].kinds;
