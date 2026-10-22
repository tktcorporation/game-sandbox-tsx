import { AMBUSH, AWARE, BAG, DEG, FACTION, NOISE, PATROL, ROGUE, SIGHT, SWEEP, TICK, VALUABLES, type EnemyKind } from "./config";
import { dist2d, los, lookAngles, wrapAngle } from "./geom";
import { EXTRACTS, GATES, MOBILES, RING_GAPS, regionHere, type Mobile, type RegionId } from "./map";
import { onMainGround, walkLine } from "./hunt";
import { worldKey } from "./routes";
import { mix, sightScale, type Enemy, type Point, type State } from "./state";
import { alertSquad, headOf, standable } from "./awareness";
import { bodyCenter, fall } from "./combat";
import { robotSide } from "./battle";
import { terrainHeight } from "./terrain";

/*
 * The robots between the POIs: the squads that walk out (`MOBILES`), the two factions that fight
 * each other there (see FACTION), the choke points they wait at for a player on the way out (see
 * AMBUSH), and what the player has seen and heard of them (`State.contacts`).
 */

/**
 * Whether robots `a` and `b` fight each other: of different sides (the network, the rogues, the
 * player's own robots), neither the titan, neither still beaming in, and neither a garrison's
 * (which hold their posts) unless the other is one of a battle's squads (sim/battle.ts), which
 * come to take the node the garrison stands for.
 */
export const hostile = (a: Enemy, b: Enemy) =>
  robotSide(a) !== robotSide(b) && (a.poi < 0 || !!b.battle) && (b.poi < 0 || !!a.battle) && a.kind !== "titan" && b.kind !== "titan" && a.mode !== "spawning" && b.mode !== "spawning";

/** Whether robot `e` is still in the raid: among the robots, or among the player's own. */
const present = (s: State, e: Enemy) => (e.friend ? s.friends : s.enemies).includes(e);

/** Whether a robot with id `id` is in the raid. */
const anyWithId = (s: State, id: number) => s.enemies.some((e) => e.id === id) || s.friends.some((e) => e.id === id);

/** A short hash of a name, so each walk starts from its own point of a raid's seed. */
const nameHash = (name: string) => {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193) >>> 0;
  return h;
};

/** Each walk's points as walked in the current world, out and back (`walkLine()` between its nodes). */
const walks = new Map<string, Point[]>();

/**
 * The points a squad on `m` walks in a loop: its nodes out by the ground's way, and back the same
 * way. Built once per world; it builds fields, so a raid that builds it forgets them after.
 */
export function mobileWalk(m: Mobile): Point[] {
  const key = `${worldKey()}|${m.name}`;
  const kept = walks.get(key);
  if (kept) return kept;
  const out: Point[] = [{ x: m.nodes[0][0], z: m.nodes[0][1] }];
  for (let i = 0; i + 1 < m.nodes.length; i++) out.push(...walkLine({ x: m.nodes[i][0], z: m.nodes[i][1] }, { x: m.nodes[i + 1][0], z: m.nodes[i + 1][1] }));
  const walk = [...out, ...out.slice(1, -1).reverse()];
  walks.set(key, walk);
  return walk;
}

/** Whether a patrol or convoy of `MOBILES` walks in this raid (a beat walks whenever its garrison squad stands). */
export function mobileWalks(s: Pick<State, "strength">, m: Mobile): boolean {
  if (m.from) return false;
  if (m.rank !== undefined) return m.rank < ROGUE.patrols[s.strength];
  return true;
}

/** The beat a POI's garrison squad named `squad` walks, or null if it holds its post. */
export const beatOf = (poi: string, squad: string) => MOBILES.find((m) => m.from?.poi === poi && m.from.squad === squad) ?? null;

/**
 * A squad of `kinds` on its walk `m`, out at a point of it at least `PATROL.away` from the player (or
 * near the far end of a walk that does not go that far) and `FACTION.apart` from the other
 * faction's robots out already, picked from the seed without drawing on the raid's random numbers,
 * facing on along it.
 */
export function placeMobile(s: State, m: Mobile, kinds: readonly EnemyKind[], spawn: (s: State, kind: EnemyKind, x: number, z: number, squad: number, face: number, rogue: boolean) => void) {
  const walk = mobileWalk(m);
  const p0 = s.player.pos;
  const rogue = m.faction === "rogue";
  // Away from the player, and from the other faction's robots already out, so no fight starts with the raid.
  const foes = s.enemies.filter((e) => e.poi < 0 && !!e.rogue !== rogue);
  const clear = walk.map((_, i) => i).filter((i) => !foes.some((e) => dist2d(e.pos, walk[i]) < FACTION.apart));
  const from = clear.length ? clear : walk.map((_, i) => i);
  // A walk that never gets that far from the player starts at its far end.
  const reach = Math.min(PATROL.away, 0.8 * Math.max(...from.map((i) => dist2d(walk[i], p0))));
  const pick = from.filter((i) => dist2d(walk[i], p0) >= reach);
  const leg = pick[mix(Math.imul(s.seed + 1, 0x9e3779b1) ^ nameHash(m.name)) % pick.length];
  const index = s.squads.length;
  // The network's patrols and convoys come to distant gunfire as the squads on the roads do; a POI's
  // beat and a round through the POIs come to fights only as close as a post would, and the rogues keep to their own.
  const roam = m.kind !== "beat" && m.kind !== "round" && !rogue;
  s.squads.push({ name: m.name, poi: -1, patrol: walk, leg: (leg + 1) % walk.length, engaged: false, roam, mobile: m.name, rogue: rogue || undefined, sinceSeen: 0, last: { x: 0, z: 0 } });
  const at = walk[leg];
  const next = walk[(leg + 1) % walk.length];
  const face = Math.atan2(next.x - at.x, -(next.z - at.z));
  kinds.forEach((kind, i) => spawn(s, kind, at.x + (i % 2 ? 1.6 : -1.6) * Math.min(i, 1), at.z + i * 1.4, index, face, rogue));
}

/**
 * The squads on their walks, every tick: one held up on its way (see PATROL.stuck) makes for its
 * next point, and one waiting at a choke point (see AMBUSH) goes back to its walk once its wait is
 * up or the player has gone.
 */
export function stepMobiles(s: State) {
  const p = s.player.pos;
  s.squads.forEach((sq, i) => {
    if (!sq.mobile) return;
    const lead = s.enemies.find((e) => e.squad === i);
    if (!lead) {
      sq.ambush = undefined;
      return;
    }
    if (sq.ambush) {
      sq.ambush.t -= TICK;
      if (sq.ambush.t <= 0 || dist2d(p, sq.ambush.at) > AMBUSH.near * 2 || sq.engaged) sq.ambush = undefined;
    }
    const calm = !sq.engaged && sq.foe === undefined && !sq.ambush && !s.enemies.some((e) => e.squad === i && e.aware !== "idle");
    if (!calm || !sq.mark) {
      sq.mark = { x: lead.pos.x, z: lead.pos.z };
      sq.markT = 0;
      return;
    }
    sq.markT = (sq.markT ?? 0) + TICK;
    if (sq.markT < PATROL.stuck.time) return;
    if (dist2d(lead.pos, sq.mark) < PATROL.stuck.moved) sq.leg = (sq.leg + 1) % Math.max(1, sq.patrol.length);
    sq.mark = { x: lead.pos.x, z: lead.pos.z };
    sq.markT = 0;
  });
}

/** Where a robot `e` of a squad fighting the other faction is fighting: its foe, while there is one (see FACTION). */
export function foeOf(s: State, e: Enemy, byId: Map<number, Enemy>): Enemy | null {
  const sq = s.squads[e.squad];
  if (!sq || sq.foe === undefined || sq.engaged || e.kind === "titan") return null;
  const foe = byId.get(sq.foe) ?? null;
  // A garrison leaves its post only for a battle's squad come to take its node.
  return foe && e.poi >= 0 && !foe.battle ? null : foe;
}

/** The robots that may fight the other faction, by `CELL`-metre square. */
const CELL = 48;
const cellKey = (x: number, z: number) => (Math.floor(x / CELL) + 512) * 4096 + (Math.floor(z / CELL) + 512);
function buckets(list: Enemy[]): Map<number, Enemy[]> {
  const out = new Map<number, Enemy[]>();
  for (const e of list) {
    const k = cellKey(e.pos.x, e.pos.z);
    const l = out.get(k);
    if (l) l.push(e);
    else out.set(k, [e]);
  }
  return out;
}

/** The robots in `b` within `r` metres of (x, z) by square (r no more than `CELL`), nearest first. */
function near(b: Map<number, Enemy[]>, x: number, z: number, r: number, keep: (o: Enemy) => boolean): { o: Enemy; d: number }[] {
  const out: { o: Enemy; d: number }[] = [];
  for (let dx = -1; dx <= 1; dx++)
    for (let dz = -1; dz <= 1; dz++)
      for (const o of b.get(cellKey(x + dx * CELL, z + dz * CELL)) ?? []) {
        const d = Math.hypot(o.pos.x - x, o.pos.z - z);
        if (d < r && keep(o)) out.push({ o, d });
      }
  return out.sort((a, c) => a.d - c.d);
}

/**
 * The factions finding each other, every tick: a squad drops a foe that is down, that it has not
 * seen for `FACTION.forget` seconds, or once it fights the player; every `FACTION.scan` seconds
 * each squad out between the POIs that is not fighting the player looks for the other faction's
 * robots (see FACTION). Robots are looked up by square, so the cost follows the robots near each
 * other, not the square of all of them.
 */
export function stepFactions(s: State) {
  for (const sq of s.squads) {
    if (sq.foe === undefined) continue;
    sq.foeT = (sq.foeT ?? 0) + TICK;
    sq.heardT = Math.max(0, (sq.heardT ?? 0) - TICK);
    if (sq.engaged || sq.foeT > FACTION.forget || !anyWithId(s, sq.foe)) sq.foe = sq.foeAt = undefined;
  }
  s.factionT -= TICK;
  if (s.factionT > 0) return;
  s.factionT = FACTION.scan;
  // While a battle's squads are in the world, the garrisons look for them too, and the player's own robots look for everyone else.
  const battling = s.friends.length > 0 || (!!s.battle && s.enemies.some((e) => e.battle));
  const list = (s.friends.length ? [...s.enemies, ...s.friends] : s.enemies).filter((e) => (e.poi < 0 || battling) && e.kind !== "titan" && e.mode !== "spawning");
  if (new Set(list.map(robotSide)).size < 2) return;
  const b = buckets(list);
  const scale = sightScale(s) * FACTION.sight;
  const bySquad = new Map<number, Enemy[]>();
  for (const e of list) {
    const l = bySquad.get(e.squad);
    if (l) l.push(e);
    else bySquad.set(e.squad, [e]);
  }
  for (const [i, members] of bySquad) {
    const sq = s.squads[i];
    if (!sq || sq.engaged) continue;
    const fighting = sq.foe !== undefined;
    let seen: Enemy | null = null;
    for (const m of members.slice(0, 4)) {
      const range = Math.min(CELL, SIGHT[m.kind].range * scale * (fighting ? AWARE.engagedRange : 1));
      const eye = headOf(m);
      for (const { o, d } of near(b, m.pos.x, m.pos.z, range, (o) => hostile(m, o)).slice(0, 2)) {
        const inView = fighting || d < FACTION.close || Math.abs(wrapAngle(lookAngles(m.pos, o.pos).yaw - m.yaw)) < (SIGHT[m.kind].fov / 2) * DEG;
        if (inView && los(eye, bodyCenter(o))) {
          seen = o;
          break;
        }
      }
      if (seen) break;
    }
    if (!seen) continue;
    if (!fighting || seen.id === sq.foe || !anyWithId(s, sq.foe!)) sq.foe = seen.id;
    if (sq.foe === seen.id) {
      sq.foeT = 0;
      sq.foeAt = { x: seen.pos.x, z: seen.pos.z };
    }
  }
}

/**
 * A robot hit by the other faction's fire (see FACTION): it takes `FACTION.dmg` of the damage, with
 * no flank or plate, and its squad, if it is not fighting the player or another foe
 * already, turns on whoever shot it. At no health left it falls (`fall()`).
 */
export function damageRobot(s: State, v: Enemy, dmg: number, by: Enemy | null) {
  if (!present(s, v)) return;
  dmg *= FACTION.dmg;
  const toShield = Math.min(v.shield, dmg);
  v.shield -= toShield;
  v.hp -= dmg - toShield;
  s.events.push({ t: "robotHit", id: v.id, pos: bodyCenter(v) });
  const sq = s.squads[v.squad];
  if (sq && by && !sq.engaged && present(s, by) && hostile(v, by) && (sq.foe === undefined || !anyWithId(s, sq.foe))) {
    sq.foe = by.id;
    sq.foeT = 0;
    sq.foeAt = { x: by.pos.x, z: by.pos.z };
  }
  if (v.hp > 0) return;
  if (!v.friend) return fall(s, v, by);
  // One of the player's own goes down: a wreck, and nothing to pick up.
  s.friends = s.friends.filter((o) => o !== v);
  const from = by?.pos ?? v.pos;
  s.events.push({ t: "fall", id: v.id, kind: v.kind, pos: bodyCenter(v), rogue: false, friend: true, fromX: from.x, fromZ: from.z });
}

/**
 * Robot `e` fired at the other faction: the squads out on the roads within `FACTION.noise` times
 * `NOISE.roamMult` come to look, and the player, within `FACTION.hear`, hears where (their map
 * marks it, see `State.contacts`); at most every `FACTION.every` seconds per squad.
 */
export function fightHeard(s: State, e: Enemy) {
  const sq = s.squads[e.squad];
  if (!sq || (sq.heardT ?? 0) > 0) return;
  sq.heardT = FACTION.every;
  const reach = FACTION.noise * NOISE.roamMult;
  const told = new Set<number>([e.squad]);
  for (const o of s.enemies) {
    if (told.has(o.squad) || o.aware !== "idle" || o.poi >= 0 || o.mode === "spawning") continue;
    const q = s.squads[o.squad];
    if (!q?.roam || q.foe !== undefined || q.engaged || dist2d(o.pos, e.pos) > reach) continue;
    told.add(o.squad);
    alertSquad(s, o.squad, e.pos.x, e.pos.z, e);
  }
  // The map marks the others' fights; the player's own robots are on it as the battle's squads.
  if (!e.friend && dist2d(e.pos, s.player.pos) < FACTION.hear) note(s, e.squad, e.pos, !!e.rogue, true);
}

/** Marks squad `squad` on the player's map at `at` (see `State.contacts`). */
function note(s: State, squad: number, at: Point, rogue: boolean, fight: boolean) {
  const c = s.contacts.find((q) => q.squad === squad);
  const x = Math.round(at.x);
  const z = Math.round(at.z);
  const fightT = fight ? s.time : (c?.fightT ?? -Infinity);
  const fighting = s.time - fightT < FACTION.every * 2;
  if (c) Object.assign(c, { x, z, t: s.time, rogue, fight: fighting, fightT });
  else s.contacts.push({ squad, x, z, t: s.time, rogue, fight: fighting, fightT });
}

/** How far the player sees the robots out between the POIs for the map: as far as the view draws them. */
const SEEN = 220;
/** The field of view, either side of the way the player faces, within which they see a squad. */
const SEEN_FOV = 70;

/**
 * What the player sees of the squads out between the POIs, every half second: each in their view
 * and in line of sight within `SEEN` metres, the nearest first and no more than a dozen looked at,
 * goes on the map where it stands; marks older than `FACTION.keep` seconds go.
 */
export function stepContacts(s: State) {
  s.contactT -= TICK;
  if (s.contactT > 0) return;
  s.contactT = 0.5;
  s.contacts = s.contacts.filter((c) => s.time - c.t < FACTION.keep && s.enemies.some((e) => e.squad === c.squad));
  const p = s.player;
  const eye = { x: p.pos.x, y: p.pos.y + 1.5, z: p.pos.z };
  const cand = s.enemies
    .filter((e) => e.poi < 0 && e.mode !== "spawning" && dist2d(e.pos, p.pos) < SEEN && Math.abs(wrapAngle(lookAngles(p.pos, e.pos).yaw - p.yaw)) < SEEN_FOV * DEG)
    .sort((a, b) => dist2d(a.pos, p.pos) - dist2d(b.pos, p.pos))
    .slice(0, 12);
  const done = new Set<number>();
  for (const e of cand) {
    if (done.has(e.squad) || !los(eye, bodyCenter(e))) continue;
    done.add(e.squad);
    note(s, e.squad, e.pos, !!e.rogue, s.squads[e.squad]?.foe !== undefined);
  }
}

/** The points close round a way off that a walker comes in by: 30 m out each way, on the main ground. */
const approaches = new Map<string, Point[]>();
function approachesOf(x: { id: string; x: number; z: number }): Point[] {
  const kept = approaches.get(x.id);
  if (kept) return kept;
  const out: Point[] = [];
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    const q = { x: x.x + Math.sin(a) * 30, z: x.z - Math.cos(a) * 30 };
    if (standable(q.x, q.z) && onMainGround(q.x, q.z) && Math.abs(terrainHeight(q.x, q.z) - terrainHeight(x.x, x.z)) < 6) out.push(q);
  }
  approaches.set(x.id, out);
  return out;
}

/** The choke points of `region` within `AMBUSH.reach` of the way off `x`: fence gates, gaps in the ring's wreckage, and its approaches. */
export function chokesNear(region: RegionId, x: { id: string; x: number; z: number }): Point[] {
  const far = (q: Point) => dist2d(q, x) < AMBUSH.reach && regionHere(q).id === region && standable(q.x, q.z) && onMainGround(q.x, q.z);
  return [...GATES.filter(far), ...RING_GAPS.filter(far), ...approachesOf(x)].map((q) => ({ x: q.x, z: q.z }));
}

/**
 * Sweeps (see SWEEP): the seconds since a robot last fought the player run on; at `SWEEP.quiet`,
 * with no squad sent already, the nearest calm network squad on a walk or a hunting party within
 * `SWEEP.reach` is sent after the player, and told every `SWEEP.every` seconds where they are heading.
 */
export function stepSweep(s: State) {
  if (s.phase !== "play") return;
  const fighting = s.enemies.some((e) => e.aware === "engaged" && e.mode !== "spawning");
  s.quietT = fighting ? 0 : s.quietT + TICK;
  const p = s.player.pos;
  const tick = Math.round(s.time / TICK);
  let sent = false;
  s.squads.forEach((sq, i) => {
    if (sq.sweep === undefined) return;
    sq.sweep -= TICK;
    const members = s.enemies.filter((e) => e.squad === i);
    if (!members.length || sq.engaged || sq.sweep <= 0) {
      // Back to its walk (or into its fight) on its own feet.
      sq.sweep = undefined;
      sq.routed = undefined;
      return;
    }
    sent = true;
    if (tick % Math.round(SWEEP.every / TICK) === 0) alertSquad(s, i, p.x, p.z, members[0], true);
  });
  if (sent || s.quietT < SWEEP.quiet) return;
  let best = -1;
  let bestD = SWEEP.reach;
  s.squads.forEach((sq, i) => {
    if (sq.rogue || sq.engaged || sq.foe !== undefined || !(sq.mobile || sq.party)) return;
    const members = s.enemies.filter((e) => e.squad === i && e.mode !== "spawning");
    if (!members.length || members.some((e) => e.aware !== "idle")) return;
    const d = dist2d(members[0].pos, p);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  if (best < 0) return;
  const sq = s.squads[best];
  sq.sweep = SWEEP.time;
  // It finds its way across the island by the ground's field while sent (see `huntStep()`).
  sq.routed = true;
  sq.ambush = undefined;
  s.quietT = 0;
  alertSquad(s, best, p.x, p.z, s.enemies.find((e) => e.squad === best)!, true);
}

/**
 * Ambushes (see AMBUSH), every `AMBUSH.every` seconds: with the player within `AMBUSH.near` of a
 * way off of their region and their bag `AMBUSH.bag` full, calm squads on their walks in that region are sent, up to
 * `AMBUSH.squads` at a time, to the choke points on the player's way to it (the least out of their
 * way), each the squad nearest its point that is not in the player's face (60 m off at least).
 */
export function stepAmbush(s: State) {
  s.ambushT -= TICK;
  if (s.ambushT > 0 || s.phase !== "play") return;
  s.ambushT = AMBUSH.every;
  const p = s.player.pos;
  const region = regionHere(p);
  const exit = EXTRACTS.filter((x) => region.exits.includes(x.id)).sort((a, b) => dist2d(a, p) - dist2d(b, p))[0];
  if (!exit || dist2d(exit, p) > AMBUSH.near) return;
  // The network waits for the one carrying something out.
  if (s.player.haul.reduce((n, k) => n + VALUABLES[k].size, 0) < BAG.slots * AMBUSH.bag) return;
  const waiting = s.squads.filter((sq) => sq.ambush);
  if (waiting.length >= AMBUSH.squads) return;
  const taken = waiting.map((sq) => sq.ambush!.at);
  const chokes = chokesNear(region.id, exit)
    .filter((q) => !taken.some((t) => dist2d(t, q) < 15))
    .sort((a, b) => dist2d(p, a) + dist2d(a, exit) - (dist2d(p, b) + dist2d(b, exit)));
  for (const at of chokes) {
    let best = -1;
    let bestD = Infinity;
    s.squads.forEach((sq, i) => {
      if (!sq.mobile || sq.engaged || sq.foe !== undefined || sq.ambush) return;
      const members = s.enemies.filter((e) => e.squad === i);
      if (!members.length || regionHere(members[0].pos).id !== region.id || members.some((e) => e.aware !== "idle" || dist2d(e.pos, p) < 60)) return;
      const d = dist2d(members[0].pos, at);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best < 0) return;
    s.squads[best].ambush = { at, face: Math.atan2(p.x - at.x, -(p.z - at.z)), t: AMBUSH.hold };
    return;
  }
}
