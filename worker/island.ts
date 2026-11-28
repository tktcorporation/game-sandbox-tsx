import { parseHold, rivalHold, rivalOf, type PoiHold } from "../src/ringfall/sim/holds";
import { ISLAND_TABLE } from "../src/ringfall/meta/island-table";
import type { ApiError } from "../src/ringfall/meta/island-errors";
import { CONTESTED_SHORES as CLIENT_CONTESTED, isContestedShore as clientContested } from "../src/ringfall/meta/neighbours";
import { DAY_MS, OUTER_GUARD, utcDay, utcDayEnd } from "../src/ringfall/meta/outer-guard";
import type { Replay } from "../src/ringfall/sim/replay-data";

/*
 * One island on the server (docs/ringfall/multiplayer.md): its owner, the nodes' holds as the owner
 * last reported them and as other players' sorties (攻め) changed them, and the log the owner reads.
 * Plain data and pure transitions, so that IslandDO (worker/island-do.ts) only loads, applies and
 * stores, and scripts/ringfall-island-server.ts drives the same code without workerd.
 *
 * Nothing happens on an island between requests, and nothing draws on chance: the same state and
 * the same op at the same time give the same island.
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
  // Expeditions (遠征) removed 2026-11-28: a node one held goes back to the robots, and what the
  // island kept for them (the squads, the fights in numbers, the lease, its clock) is dropped.
  const old = s as IslandState & { expeditions?: { target: number; holding: boolean; by: Attacker }[] };
  for (const e of old.expeditions ?? []) if (e.holding && rivalOf(s.holds[e.target]) === e.by?.code) s.holds[e.target] = "foe";
  for (const k of ["expeditions", "defenders", "guards", "meter", "made", "lease", "clock", "taken"]) if (k in s) delete (s as unknown as Record<string, unknown>)[k];
  if (Array.isArray(s.log) && s.log.some((e) => !LOG_KINDS.includes(e.t))) s.log = s.log.filter((e) => LOG_KINDS.includes(e.t));
  return s;
}

/** Outer-edge hubs contested with neighbours (作り順②; derived in sim/contested-outer.ts). */
export const CONTESTED_SHORES: readonly string[] = CLIENT_CONTESTED;

export const isContestedShore = (id: string): boolean => clientContested(id);

/** The island's limits on the server. */
export const ISLAND_RULES = {
  /** Days an island's holdings are shielded from sorties after it was claimed (新しいプレイヤーの保護). */
  protectDays: 2,
  /**
   * Seconds an async look-mark the owner leaves stays on the island (ux-design M6).
   * Long on purpose: CoC-style async presence, not a live ping sync.
   */
  pingTtl: 24 * 3600,
  /** Look-marks kept at once; the oldest drop first. */
  pingMax: 8,
  /** Aid parcels at depots (ux-design C2, 援軍の寄付); oldest drop first. */
  parcelMax: 12,
  /** Entries the log keeps, the oldest dropped first. */
  logMax: 200,
  /** The latest sorties whose record (攻めの記録) the log keeps; older lines keep their words alone. */
  replayMax: 8,
};

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

/** How long an attack may be answered (仕返し) by any way, the sea route shut or not. */
export const ANSWER_MS = 7 * 24 * 3600 * 1000;

/** An attacker as others see them: their island's code and name, never their id. */
export interface Attacker {
  code: string;
  name: string;
}

/** A change the owner reads: a holding taken, an attack on one held off, or a node taken back. */
const LOG_KINDS: readonly string[] = ["taken", "wiped", "retaken"];

export interface LogEntry {
  seq: number;
  at: number;
  t: "taken" | "wiped" | "retaken";
  node: string;
  by: Attacker;
  /** A sortie's stars (0–3, `raid`): what the attacker won, and so what the owner loses. Left out elsewhere. */
  stars?: number;
  /** The trophies the sortie's attacker won (`raid`), as their settle counted them: what the owner loses. */
  won?: number;
  /** A sortie's record (攻めの記録, sim/replay.ts): kept on the latest `ISLAND_RULES.replayMax` lines only. */
  replay?: Replay;
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
  nextId: number;
  log: LogEntry[];
  seq: number;
  /**
   * Holdings lost this UTC day (作り順③ loss cap): to a sortie, or a contested outer hub to its
   * neighbour. Optional on older islands (missing → 0).
   */
  outerTaken?: { day: number; n: number };
  /**
   * Contested hubs taken on UTC day `day` (方向 A / TKT-195): those node indices cannot change hands
   * again until the next UTC day. Optional on older islands (migrate fills empty).
   * `island` (作り順③): after a loss, remaining own outer hubs are shielded for the rest of that UTC day.
   */
  shielded?: { day: number; nodes: number[]; island?: boolean };
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

/** What one request asks of an island. */
export type IslandOp =
  | { t: "claim"; player: { id: string; name: string }; code: string }
  | { t: "report"; player: { id: string; name: string }; holds: PoiHold[]; retaken: string[]; factory: number; day: number; parcels?: IslandParcel[]; takenParcels?: number[] }
  | { t: "view" }
  | { t: "log"; player: string; after: number }
  | { t: "whois"; player: string }
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
  | { t: "raid"; from: Attacker; target: string; captured: boolean; stars?: number; won?: number; replay?: Replay };

/** The answer to an op: the HTTP status and body, and the island as it is after it (null while nobody has claimed it). */
export interface OpResult {
  status: number;
  body: unknown;
  state: IslandState | null;
  /** Whether the island must be stored: the op changed it. Reads store nothing. */
  changed: boolean;
}

const fail = (error: ApiError) => ({ ok: false, error });

/** Holdings lost on the UTC day of `t` (作り順③). */
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
 * Loss-cap for taking a holding at `t` (作り順③): the losses counted in `outerTaken`.
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

function appendLog(s: IslandState, at: number, t: LogEntry["t"], node: number, by: Attacker, stars?: number, won?: number, replay?: Replay) {
  // Hold still shows the pre-flip owner here (caller updates holds after / separately).
  if (t === "taken" && isContestedShore(NODE_IDS[node]) && s.holds[node] === "own") recordOuterTaken(s, at);
  if (t === "taken" || t === "retaken") shieldNode(s, node, at);
  s.log.push({ seq: ++s.seq, at, t, node: NODE_IDS[node], by: { ...by }, ...(stars !== undefined ? { stars } : {}), ...(won !== undefined ? { won } : {}), ...(replay ? { replay } : {}) });
  if (s.log.length > ISLAND_RULES.logMax) s.log.splice(0, s.log.length - ISLAND_RULES.logMax);
  // Records weigh more than words: only the latest few keep theirs, so the island's state stays small.
  if (replay) {
    let kept = 0;
    for (let k = s.log.length - 1; k >= 0; k--) if (s.log[k].replay && ++kept > ISLAND_RULES.replayMax) delete s.log[k].replay;
  }
}

/** Whether a sortie could take node `i` at `now`: a holding, past the island's protection, with no shield or loss cap over it. */
const attackable = (s: IslandState, i: number, now: number) =>
  s.holds[i] === "own" && now - s.since >= ISLAND_RULES.protectDays * DAY_MS && !isShielded(s, i, now) && !isIslandShielded(s, now) && !outerLossCapReached(s, now);

/** Drop expired look-pings; keeps the list small. */
function prunePings(s: IslandState, now: number) {
  if (!s.pings?.length) return;
  s.pings = s.pings.filter((p) => p.until > now);
  if (s.pings.length > ISLAND_RULES.pingMax) s.pings = s.pings.slice(s.pings.length - ISLAND_RULES.pingMax);
}

/** The island's state as anyone may see it: no player's id. */
export function publicView(s: IslandState, now: number) {
  prunePings(s, now);
  const newPlayerUntil = s.since + ISLAND_RULES.protectDays * DAY_MS;
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
    // `shielded`: no sortie takes it today (its own day's shield, `raid`'s check).
    nodes: NODE_IDS.map((id, i) => ({ id, hold: s.holds[i], open: attackable(s, i, now), ...(isShielded(s, i, now) ? { shielded: true } : {}) })),
    // Holdings sorties took that the owner's reports have not shown lost yet, outliving the bounded log.
    raided: (s.raided ?? []).map((i) => NODE_IDS[i]),
    pings: (s.pings ?? []).map((p) => ({ id: p.id, x: p.x, z: p.z, by: p.by, until: p.until })),
    parcels: (s.parcels ?? []).map((p) => ({ id: p.id, poi: p.poi, kind: p.kind, from: { ...p.from }, at: p.at })),
  };
}

/** A new island claimed at `now` for the player of `op`: every node the enemy's until the owner's first report. */
function claim(op: Extract<IslandOp, { t: "claim" }>, now: number): IslandState {
  return {
    owner: { id: op.player.id, name: op.player.name, code: op.code },
    holds: NODE_IDS.map(() => "foe"),
    factory: 0,
    day: 0,
    since: now,
    nextId: 1,
    log: [],
    seq: 0,
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
      appendLog(s, now, "retaken", i, { code: from, name: "" });
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
  // A node the owner reports lost (an AI player's attack while away) holds no 島の守り: the owner's copy sent them back to the stash.
  if (s.parcels?.length) s.parcels = s.parcels.filter((p) => { const k = NODE_IDS.indexOf(p.poi); return k < 0 || s.holds[k] === "own"; });
  if (s.parcels && s.parcels.length > ISLAND_RULES.parcelMax) s.parcels = s.parcels.slice(s.parcels.length - ISLAND_RULES.parcelMax);
  return { contestedTaken, contestedRetaken, shielded };
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
  if (takingFromOwner) recordOuterTaken(s, at);
  shieldNode(s, i, at);
  s.log.push({ seq: ++s.seq, at, t: owner === s.owner.code ? "retaken" : "taken", node: shore, by: who });
  if (s.log.length > ISLAND_RULES.logMax) s.log.splice(0, s.log.length - ISLAND_RULES.logMax);
  return { status: 200, body: { ok: true, hold: s.holds[i] } };
}

/** Applies `op` to the island at `now`. The state passed in is changed in place. */
export function islandOp(state: IslandState | null, op: IslandOp, now: number): OpResult {
  const s = state ? migrateIslandState(state) : null;
  if (s) prunePings(s, now);
  const done = (status: number, body: unknown, wrote = false): OpResult => ({ status, body, state: s, changed: wrote });
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
  if (op.t === "view") return done(200, publicView(s, now));
  // Who the sender is, their factory, the nodes they hold (a neighbour's sea route opens from one of
  // them), and the islands that have attacked theirs in the last week, which they may answer by any way.
  if (op.t === "whois") {
    if (s.owner.id !== op.player) return done(403, fail("not-owner"));
    const since = now - ANSWER_MS;
    const attackers = [...new Set(s.log.filter((e) => e.at >= since && e.t === "taken").map((e) => e.by.code))];
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
    s.pings.push({ id: s.nextId++, x: op.x, z: op.z, by: op.name, until: now + ISLAND_RULES.pingTtl * 1000 });
    prunePings(s, now);
    return done(200, { ok: true, pings: s.pings }, true);
  }
  // Aid donation to this island (ux-design C2): a neighbour leaves a parcel at a depot.
  if (op.t === "aid") {
    if (op.from.code === s.owner.code) return done(403, fail("own-island"));
    if (!DEPOT_POIS.includes(op.poi) || typeof op.kind !== "string" || !op.kind) return done(400, fail("bad-request"));
    s.parcels ??= [];
    s.parcels.push({ id: s.nextId++, poi: op.poi, kind: op.kind, from: { ...op.from }, at: now });
    if (s.parcels.length > ISLAND_RULES.parcelMax) s.parcels = s.parcels.slice(s.parcels.length - ISLAND_RULES.parcelMax);
    return done(200, { ok: true }, true);
  }
  if (op.t === "raid") {
    if (op.from.code === s.owner.code) return done(403, fail("own-island"));
    const i = NODE_IDS.indexOf(op.target);
    if (i < 0) return done(400, fail("bad-request"));
    // Only a holding is attacked; one already gone is no news for its owner.
    if (s.holds[i] !== "own") return done(409, fail("node-not-open"));
    // A new island is protected for its first days.
    if (now - s.since < ISLAND_RULES.protectDays * DAY_MS) return done(403, fail("protected"));
    const guarded = isShielded(s, i, now) || isIslandShielded(s, now) || outerLossCapReached(s, now);
    // The stars the attacker won (a report before stars were sent: ★★★ for a capture, none otherwise).
    const stars = Math.max(0, Math.min(3, Math.round(Number.isFinite(op.stars) ? op.stars! : op.captured ? 3 : 0)));
    // What the attacker's settle counted as won, capped as one sortie can win (TROPHY.base + its gap bonus).
    const won = Number.isFinite(op.won) && op.won! > 0 ? Math.min(60, Math.round(op.won!)) : undefined;
    if (!op.captured || guarded) {
      const star = guarded && op.captured ? 0 : Math.min(stars, 1);
      appendLog(s, now, "wiped", i, op.from, star, star ? won : undefined, op.replay);
      return done(200, { ok: true, taken: false }, true);
    }
    // The holding's 島の守り leave it: its owner's copy sends them back to their stash (決定 B: things are never taken).
    const poi = NODE_IDS[i];
    s.parcels = (s.parcels ?? []).filter((q) => q.poi !== poi);
    // Back to the robots first, so the log counts the day's loss once (here, not as a contested shore's).
    s.holds[i] = "foe";
    s.raided = [...(s.raided ?? []).filter((k) => k !== i), i];
    appendLog(s, now, "taken", i, op.from, Math.max(2, stars), won, op.replay);
    recordOuterTaken(s, now);
    return done(200, { ok: true, taken: true }, true);
  }
  return done(400, fail("bad-request"));
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

/** Aid parcels left in a raid report, or null when unreadable. Left out, none. Depot POIs, not only front nodes. */
export function parseParcels(raw: unknown): IslandParcel[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > ISLAND_RULES.parcelMax) return null;
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
  if (!Array.isArray(raw) || raw.length > ISLAND_RULES.parcelMax) return null;
  if (!raw.every((id, k) => Number.isInteger(id) && (id as number) > 0 && raw.indexOf(id) === k)) return null;
  return raw as number[];
}
