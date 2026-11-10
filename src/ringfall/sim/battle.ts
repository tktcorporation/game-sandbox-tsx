import { CONQUEST, COUNTER, ENEMIES, FACTORY, FACTORY_TOP, MOMENTUM, PLATE, TICK, type EnemyKind, type Rarity } from "./config";
import { reckonCaptures, reckonFights, sideOf, standing, type CorePresence, type Guard, type NodeMeter, type ReckonSquad, type Side, type Task, type Unit } from "./reckon";
import { parseHold, rivalHold, rivalOf } from "./holds";
import { dist2d } from "./geom";
import { CAMP, DEPOTS, depotIndex, FRONT_LINKS, LANDING_NODES, NET_EDGE, NODES, nodeIndex, POIS, UNLOCKS, type NodeId, type NodeUnlock } from "./map";
import { fieldUses, forgetFields, onMainGround, walkLine } from "./hunt";
import { inArea } from "./areas";
import { worldKey } from "./routes";
import { spawnEnemy } from "./enemies";
import { dueCounter, frontNodes, garrisonLeaves, garrisonOf, momentum, NEIGHBOURS, CAMP_NEXT, useZones, type NodeHold } from "./front";
import { allyUp } from "./ally";
import type { Enemy, GameEvent, Point, State } from "./state";
import { hypot2 } from "./hypot";

export { sideOf, type NodeMeter, type Side, type Unit } from "./reckon";

/*
 * 陣取り戦 (docs/ringfall/island-v2.md, `CONQUEST`): a raid of the island is one battle over every
 * node at once. The player's and the enemy's squads walk the links between the nodes and take
 * them, the rogues' fight all, and another player's expeditions (side 3, docs/ringfall/multiplayer.md)
 * land to take the node they were sent to and hold it. A squad near the player or the teammate is robots in the
 * world (`State.friends` for the player's, `State.enemies` for the others), and the robots fight
 * as any robots do; a squad away from both is numbers (`BattleSquad`), and its fights and
 * captures are reckoned every `CONQUEST.tick` seconds (sim/reckon.ts, plain data a server can run too). When the raid ends before the battle
 * does, the rest of it is reckoned in numbers alone (`finishBattle()`); whoever holds each node
 * at the battle's end holds it the next day.
 */

/** The side of a robot in the world. */
export const robotSide = (e: Pick<Enemy, "friend" | "rogue" | "rival">): Side => (e.friend ? 0 : e.rival !== undefined ? 3 : e.rogue ? 2 : 1);

/**
 * A squad of the battle: its side, members, the link it walks (from a node, or -1 for the camp,
 * to a node; the same node twice for a squad standing at it), how far along it is, what it is
 * about (taking `to`, defending it, holding it once there, or standing at its core for good as a
 * turret), and its squad in `State.squads` while it is robots in the world (-1 while numbers).
 */
export interface BattleSquad {
  id: number;
  side: Side;
  /** Another player's squad (side 3): that player's id. */
  owner?: string;
  units: Unit[];
  from: number;
  to: number;
  d: number;
  task: Task;
  squad: number;
  x: number;
  z: number;
  /** The nodes it walks on to after `to`, in order: an enemy's squad landed at the pad or the shore crosses its side's nodes to the one it attacks. */
  via: number[];
  /** Seconds before it steps off the dropship or the boat that lands it; 0 once it is ashore. */
  ashore: number;
  /** Landed to take back a node the player had just taken (`COUNTER`): it comes on whatever the enemy's limit. */
  counter?: true;
}

/** The day's battle (`State.battle`). */
export interface Battle {
  /** The raid time at which the battle ends. */
  end: number;
  /** The battle's own clock, reckoned to here. */
  now: number;
  /** Seconds to the next reckoning. */
  t: number;
  squads: BattleSquad[];
  nextId: number;
  /** Seconds of work toward each side's next squad. */
  made: [number, number, number];
  /** Each node's capture by a side's squads under way, or null. */
  meter: (NodeMeter | null)[];
  /** The factory's level the battle was fought with. */
  factory: number;
  /** The rarity the factory's robots' guns count as against plates (`factoryRarity()`), as the battle began. */
  rarity: Rarity;
  /** Each node's standing as the battle began. */
  start: NodeHold[];
  /** The nodes that changed hands in the battle, in order: which, to whom, when. */
  taken: { node: NodeId; side: Side; t: number }[];
  /** Reckoned to its end. */
  done: boolean;
  /** The enemy's dropships and boats: where each comes down, whether a boat, and the battle's clock at its touchdown. The last few. */
  landings: { boat: boolean; x: number; z: number; down: number }[];
  /** The factory's squads come out: from the camp's gate (-1) or a node's depot (its place in `NODES`), at the battle's clock. The last few. */
  departs: { from: number; at: number }[];
  /** Each node of the player's whose core the enemy's robots have come to. */
  threat: boolean[];
  /** The node the player attacks, the player's squads near it coming to fight beside them; -1 for none. */
  rally: number;
  /** The counter-attacks due on nodes the player has just taken (`COUNTER`): which node, and the battle's clock at which its squad sets off. */
  counters: { node: number; at: number }[];
  /** The enemy's targets for the coming night (places in `NODES`, `NIGHT`), and those of them the player has fortified (`FORTIFY`). */
  targets: number[];
  fortified: number[];
  /** The battle's clock when the raid ended before the battle did, and each node's standing then; null while the raid is on. */
  left: { at: number; nodes: NodeHold[] } | null;
  /** Other players' expeditions still to come, soonest first. */
  rivals: RivalExpedition[];
  /** The factory's squads out on expeditions to other players' islands: each keeps one fewer squad out here (`homeMax()`). */
  away: number;
}

/**
 * Another player's expedition on its way to this island (docs/ringfall/multiplayer.md): whose, the
 * node it is sent to take, its squad, and the battle's clock at which its dropship or boat sets
 * off. One sent to a node its owner holds already, at 0, stands there from the start, holding it.
 */
export interface RivalExpedition {
  owner: string;
  target: NodeId;
  kinds: readonly EnemyKind[];
  at: number;
}

/** What a raid of the island brings to its battle: the factory's level, and the other players' expeditions coming. */
export interface BattleStart {
  factory: number;
  /** The enemy's targets for the coming night (meta/island.ts `nightTargets()`), announced all day; left out, none. */
  targets?: readonly NodeId[];
  rivals?: readonly RivalExpedition[];
  /** The factory's squads out on expeditions (meta/expeditions.ts `squadsAway()`); left out, none. */
  away?: number;
}

/** Where the enemy's squads come ashore: the titan's pad, where its dropships land, and the harbor's north shore, where its boats do. */
export const PAD = -2;
export const SHORE = -3;
/** A squad of the factory's that comes out of node `k`'s depot starts from `DEPOT + k`. */
export const DEPOT = 100;

/** The nodes each landing is next to (`LANDING_NODES`). */
const LAND_NEXT: Record<number, number[]> = {
  [PAD]: LANDING_NODES.pad.map(nodeIndex),
  [SHORE]: LANDING_NODES.shore.map(nodeIndex),
};

/**
 * Where a squad stands at node `i` and starts its walk from: beside the core on the open ground;
 * the camp's is in front of its gate, a depot's (`DEPOT + k`) on the open ground by node `k`'s
 * depot, and the landings' (`PAD`, `SHORE`) where the dropships and the boats put the enemy ashore.
 */
export const nodePoint = (() => {
  const camp = { x: (CAMP.gate.x0 + CAMP.gate.x1) / 2, z: CAMP.gate.z - 4 };
  // Found on first use: the walkers' grid it reads is built then, never when a page loads the module.
  let at: Point[] | null = null;
  let depots: Point[] | null = null;
  let lands: Record<number, Point> | null = null;
  /** The open ground nearest (x, z), looked for on rings out from it. */
  const ground = (x: number, z: number): Point => {
    for (let r = 0; r <= 30; r += 2)
      for (let k = 0, n = r ? Math.round((2 * Math.PI * r) / 2) : 1; k < n; k++) {
        const px = Math.round(x + Math.sin((k / n) * 2 * Math.PI) * r);
        const pz = Math.round(z - Math.cos((k / n) * 2 * Math.PI) * r);
        if (onMainGround(px, pz)) return { x: px, z: pz };
      }
    return { x, z };
  };
  const find = () =>
    NODES.map((n) => {
      const c = n.core;
      for (const [dx, dz] of [[3, 0], [-3, 0], [0, 3], [0, -3]]) if (onMainGround(c.x + dx, c.z + dz)) return { x: c.x + dx, z: c.z + dz };
      return { x: c.x + 3, z: c.z };
    });
  const pad = POIS.find((p) => p.boss)!;
  return (i: number): Point => {
    if (i >= DEPOT) {
      depots ??= NODES.map((n, k) => {
        const d = DEPOTS[depotIndex(n.id)];
        if (!d) return (at ??= find())[k];
        // A step off the depot toward the node, so the squad comes out in front of it.
        const dx = n.core.x - d.x;
        const dz = n.core.z - d.z;
        const l = hypot2(dx, dz) || 1;
        return ground(d.x + (dx / l) * 4, d.z + (dz / l) * 4);
      });
      return depots[i - DEPOT];
    }
    if (i <= PAD) {
      // The pad's open apron south of its middle, and the north bank of the harbor's channel, where the boats come up.
      lands ??= { [PAD]: ground(pad.x + 30, pad.z + 50), [SHORE]: ground(...inArea("bay", 132, -577)) };
      return lands[i];
    }
    return i < 0 ? camp : (at ??= find())[i];
  };
})();

/** A walk between two nodes: its points and the metres along it to each. */
interface Path {
  pts: Point[];
  cum: number[];
  len: number;
}

const pathOfPoints = (pts: Point[]): Path => {
  const cum = [0];
  for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + dist2d(pts[k - 1], pts[k]));
  return { pts, cum, len: cum[cum.length - 1] };
};

/** The walks along every link, both ways, as traced in each world (`walkLine()`). */
const walks = new Map<string, Path>();

/**
 * The walks traced: the links as places in `NODES` (the camp -1), each landing to the nodes next
 * to it, and each node's depot to the node and to its neighbours.
 */
const links = (): [number, number][] => [
  ...FRONT_LINKS.map(([a, b]): [number, number] => [a === "camp" ? -1 : nodeIndex(a), nodeIndex(b)]),
  ...[PAD, SHORE].flatMap((l) => LAND_NEXT[l].map((i): [number, number] => [l, i])),
  ...NODES.flatMap((_, k) => [k, ...NEIGHBOURS[k]].map((i): [number, number] => [DEPOT + k, i])),
];

/**
 * Traces every link's walk in the current world, once per world. It builds fields: the battle
 * does this as the raid starts and forgets them after, so a raid plays the same in any process.
 */
function traceLinks() {
  dropWarm();
  for (const [a, b] of links()) traceLink(a, b);
}

/** Traces one link's walk, both ways, unless it is traced already in the current world. */
function traceLink(a: number, b: number) {
  const key = `${worldKey()}|${a}|${b}`;
  if (walks.has(key)) return;
  const from = nodePoint(a);
  const to = nodePoint(b);
  const line = walkLine(from, to, 3);
  const pts = line.length > 1 ? [from, ...line] : [from, to];
  walks.set(key, pathOfPoints(pts));
  walks.set(`${worldKey()}|${b}|${a}`, pathOfPoints([...pts].reverse()));
}

/**
 * A trace of the links spread over several `warmLinks()` calls: its world, the next link, the
 * walks it traced so far, and `fieldUses` as it left the cache.
 */
let warm: { key: string; next: number; traced: string[]; uses: number } | null = null;

/**
 * Lets a trace spread over several calls go, with the walks it traced. A walk depends on the
 * fields in the cache as it is traced (`fieldTo()` serves a near target from a kept field), so
 * the walks of a trace cut short are those of a whole one only when it goes on with the same cache.
 */
function dropWarm() {
  if (!warm) return;
  for (const k of warm.traced) walks.delete(k);
  warm = null;
}

/**
 * Traces the links' walks in the current world ahead of the raid that would trace them in
 * `initBattle()`, a link or more per call for about `budgetMs`, so the raid's start does not pay
 * for them. It starts from the empty cache `initBattle()` traces with and forgets its fields when
 * done, so the walks are those a raid traces. Anything else using the cache between two calls
 * starts the trace over, as does a raid starting before it is done. True once every link is traced.
 */
export function warmLinks(budgetMs: number): boolean {
  const key = worldKey();
  const all = links();
  if (warm && (warm.key !== key || warm.uses !== fieldUses)) dropWarm();
  if (!warm) {
    if (all.every(([a, b]) => walks.has(`${key}|${a}|${b}`))) return true;
    forgetFields();
    warm = { key, next: 0, traced: [], uses: fieldUses };
  }
  const t0 = performance.now();
  while (warm.next < all.length) {
    const [a, b] = all[warm.next++];
    if (!walks.has(`${key}|${a}|${b}`)) {
      traceLink(a, b);
      warm.traced.push(`${key}|${a}|${b}`, `${key}|${b}|${a}`);
    }
    if (performance.now() - t0 >= budgetMs) break;
  }
  if (warm.next < all.length) {
    warm.uses = fieldUses;
    return false;
  }
  forgetFields();
  warm = null;
  return true;
}

/** The walk of a squad from `from` to `to` (a squad standing at a node walks nowhere). */
function pathOf(from: number, to: number): Path {
  if (from === to) return pathOfPoints([nodePoint(to)]);
  return walks.get(`${worldKey()}|${from}|${to}`) ?? pathOfPoints([nodePoint(from), nodePoint(to)]);
}

/** The point `d` metres along `p`. */
function along(p: Path, d: number): Point {
  if (d <= 0 || p.pts.length === 1) return p.pts[0];
  if (d >= p.len) return p.pts[p.pts.length - 1];
  let k = 1;
  while (k < p.cum.length - 1 && p.cum[k] < d) k++;
  const t = (d - p.cum[k - 1]) / (p.cum[k] - p.cum[k - 1] || 1);
  return { x: p.pts[k - 1].x + (p.pts[k].x - p.pts[k - 1].x) * t, z: p.pts[k - 1].z + (p.pts[k].z - p.pts[k - 1].z) * t };
}

/** A full member of `kind`. */
const unit = (kind: EnemyKind): Unit => ({ kind, hp: ENEMIES[kind].hp, shield: ENEMIES[kind].shield });

/** A squad's pace while it walks a link: `CONQUEST.pace` of its slowest member's. */
const paceOf = (b: BattleSquad) => CONQUEST.pace * Math.min(...b.units.map((u) => ENEMIES[u.kind].speed));

/** The battle a raid of the island starts with: the factory's turrets at the nodes the player holds, nothing else out yet. */
export function initBattle(s: State, start: BattleStart): Battle {
  traceLinks();
  forgetFields();
  const factory = Math.max(0, Math.min(FACTORY_TOP, Math.round(start.factory)));
  const b: Battle = {
    end: CONQUEST.time,
    now: 0,
    t: CONQUEST.tick,
    squads: [],
    nextId: 1,
    made: [0, 0, 0],
    meter: NODES.map(() => null),
    factory,
    rarity: factoryRarity(s.nodes),
    start: [...s.nodes],
    taken: [],
    done: false,
    landings: [],
    departs: [],
    threat: NODES.map(() => false),
    rally: -1,
    counters: [],
    targets: (start.targets ?? []).map((id) => nodeIndex(id)).filter((i) => i >= 0),
    fortified: [],
    left: null,
    rivals: [],
    away: Math.max(0, Math.round(start.away ?? 0)),
  };
  NODES.forEach((_, i) => {
    if (s.nodes[i] !== "freed") return;
    for (let k = 0; k < FACTORY.levels[factory].turrets; k++) addSquad(b, 0, ["heavy"], i, i, "post");
  });
  for (const x of [...(start.rivals ?? [])].sort((p, q) => p.at - q.at)) {
    const i = nodeIndex(x.target);
    // An owner whose standing a save could not read back (`parseHold()`) never lands: the node it took would be lost on reload.
    if (i < 0 || !x.kinds.length || !parseHold(rivalHold(x.owner))) continue;
    if (x.at <= 0 && rivalOf(s.nodes[i]) === x.owner) Object.assign(addSquad(b, 3, x.kinds, i, i, "hold"), { owner: x.owner });
    else b.rivals.push({ ...x, kinds: [...x.kinds] });
  }
  return b;
}

function addSquad(b: Battle, side: Side, kinds: readonly EnemyKind[], from: number, to: number, task: BattleSquad["task"]): BattleSquad {
  const at = nodePoint(from);
  const q: BattleSquad = { id: b.nextId++, side, units: kinds.map(unit), from, to, d: 0, task, squad: -1, x: at.x, z: at.z, via: [], ashore: 0 };
  b.squads.push(q);
  return q;
}

/** Whether node `i` (the camp for -1) lies within `r` of the player or the teammate; never once the raid is over. */
function nearPlayer(s: State, at: Point, r: number): boolean {
  if (s.phase !== "play") return false;
  return dist2d(at, s.player.pos) < r || (s.ally.active && dist2d(at, s.ally.pos) < r);
}

/** The robots in the world of battle squad `q`, while it is there. */
function membersOf(s: State, q: BattleSquad): Enemy[] {
  if (q.squad < 0) return [];
  return (q.side === 0 ? s.friends : s.enemies).filter((e) => e.squad === q.squad);
}

/** Whether a squad stands at its node: walked its link to the end, or come round the core it rallies to. */
const arrived = (q: BattleSquad) => (q.task === "rally" ? dist2d(q, NODES[q.to].core) < CONQUEST.rally.ring[1] + 8 : q.from === q.to || q.d >= pathOf(q.from, q.to).len - 0.5);

/** Squads counted against a side's limit: those walking to take or defend a node. */
const walking = (b: Battle, side: Side) => b.squads.filter((q) => q.side === side && (q.task === "attack" || q.task === "defend")).length;

/**
 * Every tick: the battle's clock runs to its end (the raid's time limit, which ends a raid still
 * on the island as a wipe), and every `CONQUEST.tick` seconds it is reckoned.
 */
export function stepBattle(s: State) {
  const b = s.battle;
  if (!b || b.done || s.phase !== "play") return;
  if (s.time >= b.end) {
    // Time is up with the player still out: the enemy has what they carried.
    s.orbs = [];
    s.waves = [];
    s.phase = "done";
    s.outcome = "dead";
    s.events.push({ t: "timeUp" }, { t: "done" });
    return;
  }
  b.t -= TICK;
  if (b.t > 0) return;
  b.t += CONQUEST.tick;
  reckon(s, b);
}

/**
 * One reckoning of the battle at its clock: squads come and go from the world by the player's
 * nearness, walk, fight in numbers where nobody watches, and take nodes.
 */
function reckon(s: State, b: Battle) {
  const dt = CONQUEST.tick;
  b.now += dt;
  rally(s, b);
  lod(s, b);
  produce(s, b, dt);
  counterAttack(s, b);
  rivalsLand(s, b);
  march(s, b, dt);
  fightAndTake(s, b, dt);
}

/**
 * The battle's rest, once the raid has ended before it: the robots of its squads become numbers
 * where they stand, and it is reckoned in numbers alone to its end, with nobody near. Pushes no
 * event: the raid is over.
 */
export function finishBattle(s: State) {
  const b = s.battle;
  if (!b || b.done) return;
  b.left = { at: b.now, nodes: [...s.nodes] };
  for (const q of b.squads) if (q.squad >= 0) toNumbers(s, q);
  b.squads = b.squads.filter((q) => q.units.length);
  while (b.now + CONQUEST.tick <= b.end + 1e-6) reckon(s, b);
  b.done = true;
}

/** An event of the battle, while the raid is on: once it is over, the rest of the battle is reckoned in silence. */
const tell = (s: State, ev: GameEvent) => s.phase === "play" && s.events.push(ev);

/* ---------- the squads in the world and as numbers ---------- */

/** Squads come into the world near the player or the teammate, and go back to numbers far from both. */
function lod(s: State, b: Battle) {
  for (const q of [...b.squads]) {
    if (q.squad >= 0) {
      const members = membersOf(s, q);
      if (!members.length) {
        // Destroyed in the world.
        b.squads.splice(b.squads.indexOf(q), 1);
        continue;
      }
      const lead = members[0];
      q.x = lead.pos.x;
      q.z = lead.pos.z;
      if (q.task === "rally") {
        rallyAt(s, q);
        const far = members.every((e) => !nearPlayer(s, e.pos, CONQUEST.far));
        if (far && !members.some((e) => e.aware === "engaged")) toNumbers(s, q);
        continue;
      }
      if (q.task !== "post" && q.from !== q.to) {
        const p = pathOf(q.from, q.to);
        const sq = s.squads[q.squad];
        // Walked as far as its squad's leg along the way (the leg's points are the path's from where it came in).
        q.d = Math.max(q.d, p.len - (sq ? remaining(sq.patrol, sq.leg) : 0));
        if (dist2d(lead.pos, p.pts[p.pts.length - 1]) < 12) q.d = p.len;
      }
      const far = members.every((e) => !nearPlayer(s, e.pos, CONQUEST.far));
      const fighting = members.some((e) => e.aware === "engaged");
      if (far && !fighting) toNumbers(s, q);
      else if (arrived(q) && q.via.length && walkOn(s, q)) {
        const sq = s.squads[q.squad];
        if (sq) {
          sq.patrol = pathOf(q.from, q.to).pts.slice();
          sq.leg = 1;
        }
      } else if (arrived(q)) settleAt(s, q);
    } else if (q.ashore <= 0 && nearPlayer(s, q, CONQUEST.near)) toWorld(s, q, false);
  }
}

/**
 * A squad come to a node on its way to another walks on to the next while its side still holds
 * the node; one its foes have taken in the meantime is where it fights. Whether it walks on.
 */
function walkOn(s: State, q: BattleSquad): boolean {
  // Another player's squad walks on whoever holds the nodes on its way: it comes for one node only.
  if (q.side !== 3 && sideOf(s.nodes[q.to]) !== q.side) {
    q.via = [];
    return false;
  }
  q.from = q.to;
  q.to = q.via.shift()!;
  q.d = 0;
  return true;
}

/* ---------- pushing together ---------- */

/** The node the player attacks: the core of the capture under way, else a node on the front whose core the player is near; -1 for none. */
function rallyNode(s: State): number {
  if (s.phase !== "play") return -1;
  if (s.capture && s.nodes[s.capture.node] !== "freed") return s.capture.node;
  const front = frontNodes(s.nodes);
  let best = -1;
  let bestD: number = CONQUEST.rally.near;
  NODES.forEach((n, i) => {
    if (!front[i]) return;
    const d = dist2d(n.core, s.player.pos);
    if (d < bestD) {
      best = i;
      bestD = d;
    }
  });
  return best;
}

/**
 * The player's squads near the node the player attacks come to fight beside them, round its core
 * (`CONQUEST.rally`): those on their way to attack anywhere, and those holding a node another of
 * the player's squads also holds. Once the player has gone, those come to the core go on taking
 * the node, or hold it if it has become the player's.
 */
function rally(s: State, b: Battle) {
  b.rally = rallyNode(s);
  if (b.rally >= 0) {
    const c = NODES[b.rally].core;
    for (const q of b.squads) {
      if (q.side !== 0 || q.ashore > 0 || (q.task !== "attack" && q.task !== "hold") || dist2d(q, c) > CONQUEST.rally.reach) continue;
      if (q.task === "hold" && (b.threat[q.to] || !b.squads.some((o) => o !== q && o.side === 0 && o.to === q.to && o.task === "hold"))) continue;
      q.task = "rally";
      q.from = q.to = b.rally;
      q.via = [];
      q.d = 0;
    }
  }
  for (const q of b.squads) {
    if (q.task !== "rally" || q.to === b.rally) continue;
    const mine = sideOf(s.nodes[q.to]) === 0;
    // Still on its way in to a node the enemy holds, it comes on, and takes up the attack there.
    if (!mine && !arrived(q)) continue;
    q.task = mine ? "hold" : "attack";
    q.from = q.to;
    q.d = 0;
  }
}

/** Where squad `q` stands round the core it rallies to: close in while the player takes the core, a little out while they fight for it. On the open ground. */
function rallySpot(s: State, q: BattleSquad): Point {
  const c = NODES[q.to].core;
  const r = s.capture?.node === q.to ? CONQUEST.rally.ring[0] : CONQUEST.rally.ring[1];
  for (let k = 0; k < 12; k++) {
    const a = q.id * 2.39996 + k * 0.52;
    const x = Math.round(c.x + Math.sin(a) * r);
    const z = Math.round(c.z - Math.cos(a) * r);
    if (onMainGround(x, z)) return { x, z };
  }
  return nodePoint(q.to);
}

/** A squad in the world rallying to a core walks to its place round it. */
function rallyAt(s: State, q: BattleSquad) {
  const sq = s.squads[q.squad];
  const at = rallySpot(s, q);
  if (sq && (sq.patrol.length !== 2 || sq.patrol[1].x !== at.x || sq.patrol[1].z !== at.z)) {
    sq.patrol = [{ x: q.x, z: q.z }, at];
    sq.leg = 1;
    sq.rush = true;
  }
}

/** Metres of `patrol` left from its leg `leg` to its end. */
function remaining(patrol: Point[], leg: number): number {
  let n = 0;
  for (let k = Math.max(1, leg); k < patrol.length; k++) n += dist2d(patrol[k - 1], patrol[k]);
  return n;
}

/** A squad in the world that has come to its node stands at its core. */
function settleAt(s: State, q: BattleSquad) {
  const sq = s.squads[q.squad];
  const at = nodePoint(q.to);
  if (sq && (sq.patrol.length !== 1 || sq.patrol[0].x !== at.x || sq.patrol[0].z !== at.z)) {
    sq.patrol = [at];
    sq.leg = 0;
    sq.rush = undefined;
  }
}

/** The name of a battle squad's squad in the world. */
const squadName = (q: BattleSquad) => (q.task === "post" ? "自軍の砲台" : q.side === 0 ? "自軍の部隊" : q.side === 1 ? "敵の攻撃部隊" : q.side === 3 ? "他のプレイヤーの部隊" : "野良機の部隊");

/**
 * Battle squad `q` comes into the world where its numbers say it is, its members spread round
 * it with the health they had. A squad made where the player can see beams in.
 */
function toWorld(s: State, q: BattleSquad, appear: boolean) {
  const p = pathOf(q.from, q.to);
  const here = arrived(q) || q.task === "post" ? [nodePoint(q.to)] : [{ x: q.x, z: q.z }, ...p.pts.filter((_, k) => p.cum[k] > q.d + 1)];
  const index = s.squads.length;
  const friend = q.side === 0;
  const rival = q.side === 3 ? (q.owner ?? "") : undefined;
  s.squads.push({ name: squadName(q), poi: -1, patrol: here, leg: 0, engaged: false, roam: !friend, sinceSeen: 0, last: { x: q.x, z: q.z }, rogue: q.side === 2 || undefined, friend: friend || undefined, battle: q.id, ...(rival !== undefined && { rival }) });
  const next = here[Math.min(1, here.length - 1)];
  const face = Math.atan2(next.x - q.x, -(next.z - q.z)) || 0;
  // Walking, the members come in one behind another along the way; standing, round where the squad stands.
  const walk = q.task !== "post" && q.task !== "rally" && !arrived(q) ? p : null;
  q.units.forEach((u, m) => {
    const back = walk && m > 0 ? along(walk, q.d - m * CONQUEST.column) : null;
    const x = back ? back.x : q.x + (m % 2 ? 1.6 : -1.6) * Math.min(m, 1);
    const z = back ? back.z : q.z + m * 1.4;
    // Another player's robots wear no plate, as the player's own: their factory arms them.
    const e = spawnEnemy(s, u.kind, x, z, -1, index, { face, hashed: true, rogue: q.side === 2, appear, plate: friend || rival !== undefined ? 0 : undefined, rival });
    e.hp = u.hp;
    e.shield = u.shield;
    e.battle = q.id;
    if (friend) {
      e.friend = true;
      if (q.task === "post") e.post = true;
      s.enemies.pop();
      s.friends.push(e);
    }
  });
  q.squad = index;
}

/** Battle squad `q` leaves the world: its members' kinds, health and shield, where its leader stood. */
function toNumbers(s: State, q: BattleSquad) {
  const members = membersOf(s, q);
  // The roster is the survivors, none if all of them fell since the last reckoning.
  q.units = members.map((e) => ({ kind: e.kind, hp: e.hp, shield: e.shield }));
  if (members.length) {
    q.x = members[0].pos.x;
    q.z = members[0].pos.z;
  }
  const sq = s.squads[q.squad];
  if (sq) {
    sq.patrol = [];
    sq.foe = undefined;
  }
  if (q.side === 0) s.friends = s.friends.filter((e) => e.squad !== q.squad);
  else s.enemies = s.enemies.filter((e) => e.squad !== q.squad);
  q.squad = -1;
}

/* ---------- making squads ---------- */

/** The player's nodes and the camp: where the factory's squads come out. */
const playerGround = (s: State) => [-1, ...NODES.map((_, i) => i).filter((i) => s.nodes[i] === "freed")];

/** The nodes next to node `i`, the camp -1 included for the supply depot. */
const nextTo = (i: number): number[] => (i < 0 ? CAMP_NEXT : [...NEIGHBOURS[i], ...(CAMP_NEXT.includes(i) ? [-1] : [])]);

/** Members of `side`'s squads at node `i`: those in numbers that have come to it, and those in the world bound for it. */
function unitsAt(s: State, b: Battle, i: number, side: Side): number {
  return b.squads.filter((q) => q.side === side && q.to === i && (arrived(q) || q.squad >= 0)).reduce((n, q) => n + (q.squad >= 0 ? membersOf(s, q).length : q.units.length), 0);
}

/** The robots of node `i`'s garrison still standing (its POI's squads): they hold it for the enemy wherever they are. */
function garrisonAt(s: State, i: number): Enemy[] {
  return s.enemies.filter((e) => !e.battle && garrisonOf(s, i, e.squad));
}

/** How strongly node `i` is held: its holder's squads' members there, and its garrison still standing. */
function heldBy(s: State, b: Battle, i: number): number {
  const owner = sideOf(s.nodes[i]);
  return unitsAt(s, b, i, owner) + (owner === 0 ? 0 : garrisonAt(s, i).length);
}

/** Squads of `side` already on their way to node `i`, or at it to take it. */
const goingTo = (b: Battle, side: Side, i: number) => b.squads.filter((q) => q.side === side && attacking(q, i)).length;

/** Where the player's next squad goes: to a node of theirs under attack, else to take a node on the front. */
function playerPlan(s: State, b: Battle): { from: number; to: number; task: BattleSquad["task"] } | null {
  const ground = playerGround(s);
  // Under attack: hostile squads on their way to one of the player's nodes, or taking it.
  let worst = -1;
  let worstN = 0;
  NODES.forEach((_, i) => {
    if (s.nodes[i] !== "freed") return;
    // The units coming at it, against those holding it: defended only while outmatched.
    const n = b.squads.filter((q) => q.side !== 0 && attacking(q, i)).reduce((k, q) => k + q.units.length, 0) - unitsAt(s, b, i, 0);
    if (n > worstN) {
      worst = i;
      worstN = n;
    }
  });
  if (worst >= 0) return { from: worst, to: worst, task: "defend" };
  // A node of the player's where the enemy comes ashore or next to the enemy's, with none of the player's squads there or going: one goes to hold it.
  const bare = NODES.map((_, i) => i).filter((i) => s.nodes[i] === "freed" && !b.squads.some((q) => q.side === 0 && q.to === i && q.task !== "rally") && (NET_EDGE.includes(NODES[i].id) || NEIGHBOURS[i].some((k) => s.nodes[k] !== "freed")));
  if (bare.length) {
    // The night's targets first: a squad standing there as the battle ends halves the night's chance (`NIGHT.guarded`).
    const want = (k: number) => +(b.targets.includes(k) && !b.fortified.includes(k)) * 2 + +NET_EDGE.includes(NODES[k].id);
    const i = bare.sort((a, c) => want(c) - want(a))[0];
    return { from: i, to: i, task: "defend" };
  }
  return attackFrom(s, b, 0, ground);
}

/**
 * The best node for `side` to take (or, for the rogues, to fall on) from one of `from` (nodes it
 * holds, the camp -1 for the player, where a rogue squad stands): one next to them held by
 * another side, the most weakly held, joining an attack of its own already under way, the
 * player's nodes first for the enemy; walked to from the nearest of `from`. Null for none.
 */
function attackFrom(s: State, b: Battle, side: Side, from: number[]): { from: number; to: number; task: BattleSquad["task"] } | null {
  let best = -1;
  let bestV = -Infinity;
  NODES.forEach((_, i) => {
    const owner = sideOf(s.nodes[i]);
    if (owner === side || !nextTo(i).some((k) => from.includes(k))) return;
    const v = 6 * goingTo(b, side, i) - 2 * heldBy(s, b, i) + (side === 1 && owner === 0 ? 10 : 0) + (side === 0 && i === b.rally ? 8 : 0);
    if (v > bestV) {
      best = i;
      bestV = v;
    }
  });
  if (best < 0) return null;
  const start = nextTo(best)
    .filter((k) => from.includes(k))
    .sort((a, c) => dist2d(nodePoint(a), nodePoint(best)) - dist2d(nodePoint(c), nodePoint(best)))[0];
  return { from: start, to: best, task: "attack" };
}

/**
 * Where the next squad of `side` goes: the enemy's lands (`landingPlan()`); the rogues' come out
 * of the wild by any node the player is not near and fall on the most weakly held. Null for none.
 */
function enemyPlan(s: State, b: Battle, side: Side): { from: number; to: number; via: number[] } | null {
  if (side === 1) return landingPlan(s, b);
  let best: { from: number; to: number; via: number[]; v: number } | null = null;
  NODES.forEach((_, i) => {
    const from = NEIGHBOURS[i].filter((k) => !nearPlayer(s, nodePoint(k), CONQUEST.near)).sort((a, c) => dist2d(nodePoint(a), nodePoint(i)) - dist2d(nodePoint(c), nodePoint(i)))[0];
    if (from === undefined) return;
    const v = -2 * heldBy(s, b, i) - 3 * goingTo(b, side, i);
    if (!best || v > best.v) best = { from, to: i, via: [], v };
  });
  return best;
}

/** Whether the enemy's boats land on the north shore: not while the player holds the node that watches it (`UNLOCKS.shore`). */
const shoreOpen = (s: Pick<State, "nodes">) => !heldUnlocks(s.nodes, "shore").length;

/**
 * Where the enemy's next squad lands and goes: put ashore at the titan's pad or the north shore,
 * it walks across the enemy's nodes to a node of the player's next to them, the most weakly
 * held and the one its squads already go for first, the nearer of equals. Null when it can reach
 * none of the player's nodes.
 */
function landingPlan(s: State, b: Battle, target = -1): { from: number; to: number; via: number[] } | null {
  let best: { from: number; to: number; via: number[]; v: number } | null = null;
  for (const land of shoreOpen(s) ? [PAD, SHORE] : [PAD]) {
    // Across the enemy's own nodes, breadth first, each node by the fewest links from the landing.
    const prev = new Map<number, number>();
    const queue = [...LAND_NEXT[land]];
    for (const i of queue) prev.set(i, land);
    for (let k = 0; k < queue.length; k++) {
      const i = queue[k];
      if (sideOf(s.nodes[i]) !== 1) continue;
      for (const j of NEIGHBOURS[i])
        if (!prev.has(j)) {
          prev.set(j, i);
          queue.push(j);
        }
    }
    for (const i of queue) {
      if (sideOf(s.nodes[i]) !== 0 || (target >= 0 && i !== target)) continue;
      const route = [i];
      while (prev.get(route[0]) !== land) route.unshift(prev.get(route[0])!);
      let len = dist2d(nodePoint(land), nodePoint(route[0]));
      for (let k = 1; k < route.length; k++) len += dist2d(nodePoint(route[k - 1]), nodePoint(route[k]));
      const v = 10 - 2 * heldBy(s, b, i) - 3 * goingTo(b, 1, i) - len / 400;
      if (!best || v > best.v) best = { from: land, to: route[0], via: route.slice(1), v };
    }
  }
  return best;
}

/** The nodes the player holds now that open `key` (`UNLOCKS`): it lasts while they are held. */
export const heldUnlocks = (nodes: State["nodes"], key: keyof NodeUnlock): NodeId[] => NODES.filter((n, i) => nodes[i] === "freed" && UNLOCKS[n.id][key]).map((n) => n.id);

/**
 * The rarity the factory's robots' guns count as against plates: the best the trader sells for the
 * nodes held (`UNLOCKS`), and never below the other robots' (`PLATE.robots`). The factory arms its
 * robots as the player can arm themselves, so its squads break into a tier no sooner than the player.
 */
export const factoryRarity = (nodes: State["nodes"]): Rarity => Math.max(PLATE.robots, ...heldUnlocks(nodes, "shop").map((id) => UNLOCKS[id].shop ?? 0)) as Rarity;

/** The squads the factory keeps out at once: its level's, and one more for each node held that opens one. */
export const factoryMax = (s: Pick<State, "nodes">, f: number) => FACTORY.levels[f].max + heldUnlocks(s.nodes, "squad").reduce((n, id) => n + (UNLOCKS[id].squad ?? 0), 0);

/** The squads the factory keeps out on this island: `factoryMax()` less one for each out on an expedition (遠征の費用), never below 0. */
const homeMax = (s: Pick<State, "nodes">, b: Battle) => (b.away > 0 ? Math.max(0, factoryMax(s, b.factory) - b.away) : factoryMax(s, b.factory));

/**
 * The factory's next squad sets off on `plan`: out of the camp's gate when it sets off from the
 * camp or the node by it (walking through that node to one beyond), else out of the depot of the
 * node it sets off from.
 */
function sendOut(s: State, b: Battle, plan: { from: number; to: number; task: BattleSquad["task"] }) {
  const f = b.factory;
  const gate = plan.from < 0 || CAMP_NEXT.includes(plan.from);
  const from = gate ? -1 : DEPOT + plan.from;
  const first = gate && plan.from >= 0 ? plan.from : plan.to;
  const q = addSquad(b, 0, FACTORY.levels[f].kinds, from, first, plan.task);
  if (first !== plan.to) q.via = [plan.to];
  b.made[0] = 0;
  b.departs.push({ from: gate ? -1 : plan.from, at: b.now });
  if (b.departs.length > 6) b.departs.shift();
  if (nearPlayer(s, q, CONQUEST.near)) toWorld(s, q, false);
  tell(s, { t: "squadOut", side: 0, node: plan.to, x: q.x, z: q.z, gate });
}

/** Each side's work toward its next squad, and the squad once it is due and the side has room. */
function produce(s: State, b: Battle, dt: number) {
  // The player's factory.
  const f = b.factory;
  // A raid with momentum brings the factory's squads out sooner (`MOMENTUM`).
  const every = FACTORY.levels[f].every * MOMENTUM.factory ** momentum(s);
  b.made[0] = Math.min(every, b.made[0] + dt);
  if (b.made[0] >= every && walking(b, 0) < homeMax(s, b)) {
    const plan = playerPlan(s, b);
    if (plan) sendOut(s, b, plan);
  }
  // The enemy's nodes work for it, the more it holds the sooner; the rogues come at their own pace.
  for (const side of [1, 2] as const) {
    // The enemy works from the ground it never gives up too (the titan's pad, the north shore, `NET_EDGE`).
    const theirs = NODES.reduce((n, _, i) => n + (sideOf(s.nodes[i]) === 1 ? 1 : 0), 0);
    // The enemy answers the player's ground: each node of theirs works for it as one of its own would. Another player's nodes count for neither.
    const mine = NODES.reduce((n, _, i) => n + (s.nodes[i] === "freed" ? 1 : 0), 0);
    const shore = heldUnlocks(s.nodes, "shore").length ? CONQUEST.net.shore : 0;
    const node = CONQUEST.net.work / NODES.length;
    const work = side === 1 ? (theirs + CONQUEST.net.answer * mine) * node + CONQUEST.net.edge - shore : 1;
    const every = side === 1 ? CONQUEST.net.every[s.strength] : CONQUEST.rogue.every;
    const max = side === 1 ? CONQUEST.net.max[s.strength] + Math.floor((mine * node) / 3) : CONQUEST.rogue.max;
    b.made[side] = Math.min(every, b.made[side] + work * dt);
    if (b.made[side] < every || walking(b, side) >= max) continue;
    const plan = enemyPlan(s, b, side);
    if (!plan) continue;
    const q = addSquad(b, side, side === 1 ? CONQUEST.net.kinds[s.strength] : CONQUEST.rogue.kinds, plan.from, plan.to, "attack");
    q.via = plan.via;
    b.made[side] = 0;
    if (plan.from <= PAD) {
      // A dropship comes down on the pad, or a boat runs up the beach, and puts the squad ashore.
      const boat = plan.from === SHORE;
      q.ashore = boat ? CONQUEST.land.boat : CONQUEST.land.ship;
      b.landings.push({ boat, x: q.x, z: q.z, down: b.now + q.ashore });
      if (b.landings.length > 6) b.landings.shift();
      tell(s, { t: "landing", boat, x: q.x, z: q.z });
    }
  }
}

/**
 * The counter-attacks come due (`COUNTER`): a node the player took a while ago that is still theirs
 * gets a squad landed at the pad or the north shore, bound across the enemy's nodes for it, on top
 * of the enemy's usual squads. A node the enemy's ground no longer reaches is let be.
 */
function counterAttack(s: State, b: Battle) {
  for (const c of b.counters.filter((k) => k.at <= b.now)) {
    b.counters.splice(b.counters.indexOf(c), 1);
    if (s.nodes[c.node] !== "freed") continue;
    const plan = landingPlan(s, b, c.node);
    if (!plan) continue;
    const q = addSquad(b, 1, [...COUNTER.kinds[s.strength], ...Array<EnemyKind>(momentum(s)).fill("grunt")], plan.from, plan.to, "attack");
    q.via = plan.via;
    q.counter = true;
    const boat = plan.from === SHORE;
    q.ashore = boat ? CONQUEST.land.boat : CONQUEST.land.ship;
    b.landings.push({ boat, x: q.x, z: q.z, down: b.now + q.ashore });
    if (b.landings.length > 6) b.landings.shift();
    tell(s, { t: "landing", boat, x: q.x, z: q.z });
    tell(s, { t: "counter", node: c.node });
  }
}

/**
 * Other players' expeditions come due: each sets off on a dropship to the pad or a boat to the
 * north shore (the enemy's own ways in, `landingPlan()`), whichever lands it the shorter walk from
 * its target, and walks there across whoever's nodes lie between. Its squad takes that node and holds it.
 */
function rivalsLand(s: State, b: Battle) {
  while (b.rivals.length && b.rivals[0].at <= b.now) {
    const x = b.rivals.shift()!;
    const plan = rivalRoute(s, nodeIndex(x.target));
    if (!plan) continue;
    const q = addSquad(b, 3, x.kinds, plan.from, plan.to, "attack");
    q.owner = x.owner;
    q.via = plan.via;
    const boat = plan.from === SHORE;
    q.ashore = boat ? CONQUEST.land.boat : CONQUEST.land.ship;
    b.landings.push({ boat, x: q.x, z: q.z, down: b.now + q.ashore });
    if (b.landings.length > 6) b.landings.shift();
    tell(s, { t: "landing", boat, x: q.x, z: q.z });
  }
}

/**
 * The way of another player's squad to node `target`: from the landing (the pad, or the north
 * shore while it is open) with the shortest walk along the links to it, across any node. Null for
 * a node no landing reaches.
 */
export function rivalRoute(s: Pick<State, "nodes">, target: number): { from: number; to: number; via: number[] } | null {
  let best: { from: number; to: number; via: number[]; len: number } | null = null;
  for (const land of shoreOpen(s) ? [PAD, SHORE] : [PAD]) {
    // Breadth first along the links, each node by the fewest links from the landing.
    const prev = new Map<number, number>();
    const queue = [...LAND_NEXT[land]];
    for (const i of queue) prev.set(i, land);
    for (let k = 0; k < queue.length && !prev.has(target); k++)
      for (const j of NEIGHBOURS[queue[k]])
        if (!prev.has(j)) {
          prev.set(j, queue[k]);
          queue.push(j);
        }
    if (!prev.has(target)) continue;
    const route = [target];
    while (prev.get(route[0]) !== land) route.unshift(prev.get(route[0])!);
    let len = dist2d(nodePoint(land), nodePoint(route[0]));
    for (let k = 1; k < route.length; k++) len += dist2d(nodePoint(route[k - 1]), nodePoint(route[k]));
    if (!best || len < best.len) best = { from: land, to: route[0], via: route.slice(1), len };
  }
  return best && { from: best.from, to: best.to, via: best.via };
}

/** Where battle squad `q` is bound in the end: the last node of its way, or the node it walks to. */
const boundFor = (q: BattleSquad) => (q.via.length ? q.via[q.via.length - 1] : q.to);

/**
 * The player's nodes the enemy or another player is about to take (the view pulses them): one whose
 * core their robots have come to, one whose capture by them is under way, and one a squad of theirs
 * is bound for, from the moment its dropship or boat sets off.
 */
export function atRisk(s: { battle: Battle | null | undefined; nodes: readonly NodeHold[] }): boolean[] {
  const b = s.battle;
  const foe = (side: Side | undefined) => side === 1 || side === 3;
  return NODES.map((_, i) => !!b && s.nodes[i] === "freed" && (b.threat[i] || foe(b.meter[i]?.side) || b.squads.some((q) => foe(q.side) && q.task === "attack" && boundFor(q) === i)));
}

/** The node an enemy's counter-attack squad is bound for, for each node of the player's (the view's defend arrow). */
export function countered(s: { battle: Battle | null | undefined; nodes: readonly NodeHold[] }): boolean[] {
  const b = s.battle;
  return NODES.map((_, i) => !!b && s.nodes[i] === "freed" && b.squads.some((q) => q.counter && q.ashore <= 0 && boundFor(q) === i));
}

/** The nodes the player's squads stand at, holding them, as the battle stands: those the night finds guarded. */
export const guardedNodes = (b: Battle): number[] => NODES.map((_, i) => i).filter((i) => b.squads.some((q) => q.side === 0 && q.to === i && q.units.length > 0 && (q.task === "post" || q.task === "hold" || q.task === "defend") && arrived(q)));

/* ---------- walking, fighting and taking, in numbers ---------- */

/** Squads in numbers walk their links, unless a hostile squad in numbers stands within `CONQUEST.meet`. */
function march(s: State, b: Battle, dt: number) {
  for (const q of b.squads) {
    if (q.ashore > 0) {
      q.ashore = Math.max(0, q.ashore - dt);
      continue;
    }
    if (q.squad >= 0 || q.task === "post") continue;
    if (arrived(q)) {
      // Come to a node on the way, it walks on to the next.
      if (!q.via.length || !walkOn(s, q)) continue;
    }
    if (b.squads.some((o) => o.squad < 0 && o.ashore <= 0 && o.side !== q.side && dist2d(o, q) < CONQUEST.meet)) continue;
    if (q.task === "rally") {
      // Straight for its place round the core it rallies to.
      const to = rallySpot(s, q);
      const d = dist2d(q, to);
      const k = Math.min(1, (paceOf(q) * dt) / (d || 1));
      q.x += (to.x - q.x) * k;
      q.z += (to.z - q.z) * k;
      continue;
    }
    const p = pathOf(q.from, q.to);
    q.d = Math.min(p.len, q.d + paceOf(q) * dt);
    const at = along(p, q.d);
    q.x = at.x;
    q.z = at.z;
  }
  // A squad come to a node its side holds holds it, in the world or not, so it no longer counts against its side's limit.
  for (const q of b.squads) if (q.task !== "post" && q.task !== "rally" && !q.via.length && arrived(q) && sideOf(s.nodes[q.to]) === q.side) q.task = "hold";
  // A rogue squad at a node with nobody left to fight there, the holder's or anyone come to take it, goes on to the next.
  for (const q of b.squads) {
    if (q.side !== 2 || q.squad >= 0 || !arrived(q) || heldBy(s, b, q.to) + unitsAt(s, b, q.to, sideOf(s.nodes[q.to]) === 0 ? 1 : 0) > 0) continue;
    const plan = attackFrom(s, b, 2, [q.to]);
    if (plan) Object.assign(q, { from: q.to, to: plan.to, d: 0, task: "attack" });
  }
  // One squad holds a node nobody comes at; the others there go on to take the next.
  NODES.forEach((_, i) => {
    const side = sideOf(s.nodes[i]);
    // Another player's squads came for this node only: they all stay.
    if (side === 3 || b.squads.some((q) => q.side !== side && attacking(q, i))) return;
    const spare = b.squads.filter((q) => q.squad < 0 && q.side === side && q.to === i && q.task === "hold").slice(1);
    for (const q of spare) {
      const plan = attackFrom(s, b, side, [i]);
      if (!plan) break;
      Object.assign(q, { from: i, to: plan.to, d: 0, task: "attack" });
    }
  });
}

/** Battle squad `q` as the reckoning sees it (sim/reckon.ts). */
const reckonSquad = (q: BattleSquad): ReckonSquad => ({ id: q.id, side: q.side, owner: q.owner, units: q.units, to: q.to, task: q.task, x: q.x, z: q.z, arrived: arrived(q), live: q.squad >= 0, ashore: q.ashore, passing: passing(q) || undefined });

/** Another player's squad come to a node on its way to the one it was sent to (only side 3: the enemy's squads stop to fight where they come). */
const passing = (q: BattleSquad) => q.side === 3 && q.via.length > 0;

/** Squad `q` comes to take node `i`: sent to attack it, and not only passing it on its way to another. */
export const attacking = (q: BattleSquad, i: number) => q.to === i && q.task === "attack" && !passing(q);

/** A garrison's robot as the reckoning sees it. */
const guardOf = (e: Enemy): Guard => ({ side: robotSide(e), kind: e.kind, hp: e.hp, shield: e.shield, plate: e.plate });

/**
 * One reckoning's fights and captures (sim/reckon.ts), with the world's share between them: the
 * nodes the player or the teammate watch fight in the world, and the robots by a core count where
 * someone watches it or a squad of the battle walks to it in the world. What the reckoning did is
 * put back: members and garrison robots down, tasks, meters, and the nodes taken.
 */
function fightAndTake(s: State, b: Battle, dt: number) {
  // The whole garrison of each node not the player's: it holds it wherever it stands.
  const garrisons = NODES.map((_, i) => (s.nodes[i] === "freed" ? [] : garrisonAt(s, i)));
  const fought = reckonFights({ holds: s.nodes, squads: b.squads.map(reckonSquad), guards: garrisons.map((g) => g.map(guardOf)), watched: NODES.map((n) => nearPlayer(s, n.core, CONQUEST.near)), rarity: b.rarity }, dt);
  const gone = new Set<Enemy>();
  garrisons.forEach((g, i) =>
    g.forEach((e, k) => {
      e.hp = fought.guards[i][k].hp;
      e.shield = fought.guards[i][k].shield;
      if (fought.fell[i].includes(k)) gone.add(e);
    }),
  );
  if (gone.size) s.enemies = s.enemies.filter((e) => !gone.has(e));
  settleSquads(b, fought.squads);
  const left = garrisons.map((g, i) => g.filter((_, k) => !fought.fell[i].includes(k)));
  const taken = reckonCaptures({ holds: s.nodes, squads: b.squads.map(reckonSquad), guards: standing(fought), present: NODES.map((n, i) => presence(s, b, i)), meter: b.meter, threat: b.threat }, dt);
  settleSquads(b, taken.squads);
  b.meter = taken.meter;
  b.threat = taken.threat;
  for (const ef of taken.effects) {
    if (ef.t === "call") for (const e of left[ef.node]) callToCore(e, NODES[ef.node].core);
    else if (ef.t === "threat") tell(s, { t: "nodeThreat", node: ef.node });
    else seize(s, b, ef.node, ef.side, taken.holds[ef.node]);
  }
}

/** The battle's squads as a reckoning left them: those gone dropped, the rest with their members and tasks as reckoned. */
function settleSquads(b: Battle, after: readonly ReckonSquad[]) {
  const by = new Map(after.map((r) => [r.id, r]));
  b.squads = b.squads.filter((q) => {
    const r = by.get(q.id);
    if (!r) return false;
    q.units = r.units;
    q.task = r.task;
    return true;
  });
}

/**
 * The world by node `i`'s core as a capture counts it (`CorePresence`), where someone watches it
 * or a squad of the battle walks to it in the world: the robots within `CONQUEST.zone` (the titan
 * and robots still beaming in left out), and the player and the teammate, up, in the raid. Null elsewhere.
 */
function presence(s: State, b: Battle, i: number): CorePresence | null {
  const c = NODES[i].core;
  if (!nearPlayer(s, c, CONQUEST.near) && !b.squads.some((q) => q.squad >= 0 && q.to === i)) return null;
  const zone = CONQUEST.zone;
  const within = (e: Enemy) => Math.abs(e.pos.x - c.x) < zone && Math.abs(e.pos.z - c.z) < zone && dist2d(e.pos, c) < zone && e.mode !== "spawning";
  const robots: CorePresence["robots"] = [];
  // Another player's robots attack only the node their squad is bound for: not one they pass through,
  // nor the last stop on their way, which they have left behind once their way runs on to the target.
  const through = new Set(b.squads.filter((q) => q.side === 3 && (q.to !== i || passing(q))).map((q) => q.id));
  for (const e of s.friends) if (within(e)) robots.push({ side: 0, battle: true });
  for (const e of s.enemies) if (within(e) && e.kind !== "titan") robots.push({ side: robotSide(e), owner: e.rival, battle: !!e.battle && !through.has(e.battle) });
  let people = 0;
  if (s.player.downed <= 0 && dist2d(s.player.pos, c) < zone && s.phase === "play") people++;
  if (allyUp(s) && dist2d(s.ally.pos, c) < zone && s.phase === "play") people++;
  return { robots, people };
}

/** A garrison's robot not fighting anyone goes to its node's core, as at the alarm of a capture (`useCore()`). */
function callToCore(e: Enemy, c: Point) {
  if (e.aware === "engaged" || e.kind === "titan") return;
  e.aware = "alert";
  e.goal = { x: c.x, z: c.z };
  e.searchT = Math.max(e.searchT, 40);
  e.detect = Math.max(e.detect, 0.5);
}

/**
 * Node `i` is `side`'s, standing `hold`, as the reckoning took it (its meter and its squads' tasks
 * are the reckoning's). Taken from the enemy, its garrison walks
 * off; taken for the player, its depot comes on too, as when the player takes it (`takeNode()`),
 * though the player gets nothing for it.
 */
function seize(s: State, b: Battle, i: number, side: Side, hold: NodeHold) {
  const n = NODES[i];
  const was = sideOf(s.nodes[i]);
  s.nodes[i] = hold;
  b.taken.push({ node: n.id, side, t: Math.round(b.now) });
  if (side === 0) {
    dueCounter(b, i);
    garrisonLeaves(s, i);
    const d = depotIndex(n.id);
    if (d >= 0 && !s.depots[d]) {
      s.depots[d] = true;
      tell(s, { t: "depotOn", poi: n.id });
    }
  } else if (side === 3 && was === 1) garrisonLeaves(s, i);
  // A capture the player had under way at a node the player now holds is done with.
  if (s.capture?.node === i && side === 0) s.capture = null;
  useZones(s);
  tell(s, { t: "nodeTaken", node: i, side });
}

/**
 * Automation only: a battle squad of `side` and `kinds` set down in the world at (x, z), holding
 * the node nearest it, its robots there at once. Its squad's index in `State.squads`.
 */
export function placeBattleSquad(s: State, side: Side, kinds: readonly EnemyKind[], x: number, z: number, task: BattleSquad["task"] = "hold"): number {
  const b = s.battle;
  if (!b) return -1;
  const to = NODES.map((n, i) => ({ i, d: dist2d(n.core, { x, z }) })).sort((a, c) => a.d - c.d)[0].i;
  const q: BattleSquad = { id: b.nextId++, side, units: kinds.map(unit), from: to, to, d: 0, task, squad: -1, x, z, via: [], ashore: 0 };
  b.squads.push(q);
  toWorld(s, q, false);
  const sq = s.squads[q.squad];
  // It stands where it was set down.
  sq.patrol = [{ x, z }];
  return q.squad;
}

/**
 * Automation only: the enemy lands a squad now, by dropship on the pad or by boat on the north
 * shore, bound for the node of the player's it would go for from there (or the node next to the
 * landing when it can reach none). Where it comes ashore, or null in a raid with no battle.
 */
export function landNow(s: State, boat: boolean): Point | null {
  const b = s.battle;
  if (!b) return null;
  const land = boat ? SHORE : PAD;
  const plan = landingPlan(s, b);
  const route = plan && plan.from === land ? plan : { from: land, to: LAND_NEXT[land][0], via: [] };
  const q = addSquad(b, 1, CONQUEST.net.kinds[s.strength], route.from, route.to, "attack");
  q.via = route.via;
  q.ashore = boat ? CONQUEST.land.boat : CONQUEST.land.ship;
  b.landings.push({ boat, x: q.x, z: q.z, down: b.now + q.ashore });
  tell(s, { t: "landing", boat, x: q.x, z: q.z });
  return { x: q.x, z: q.z };
}

/**
 * Automation only: a squad of `side` and `kinds` `d` metres along the walk from `from` to `to`
 * (places as `nodePoint()` takes them), on its way, its robots in the world at once. Its squad's
 * index in `State.squads`, or -1 in a raid with no battle.
 */
export function marchSquad(s: State, side: Side, kinds: readonly EnemyKind[], from: number, to: number, d: number): number {
  const b = s.battle;
  if (!b) return -1;
  const q = addSquad(b, side, kinds, from, to, "attack");
  const p = pathOf(from, to);
  q.d = Math.min(d, p.len - 1);
  const at = along(p, q.d);
  q.x = at.x;
  q.z = at.z;
  toWorld(s, q, false);
  return q.squad;
}

/** Automation only: the factory sends its next squad now, out of the camp's gate to the node by the camp. */
export function departNow(s: State) {
  const b = s.battle;
  if (!b) return;
  sendOut(s, b, { from: -1, to: CAMP_NEXT[0], task: s.nodes[CAMP_NEXT[0]] === "freed" ? "defend" : "attack" });
}

/** The squads of the battle as the maps show them: each squad's side, where it is, whether it is robots in the world, and its members. */
export function battleMarks(s: Pick<State, "battle" | "friends" | "enemies">): { side: Side; x: number; z: number; live: boolean; n: number; to: number }[] {
  const b = s.battle;
  if (!b) return [];
  return b.squads.filter((q) => q.ashore <= 0).map((q) => {
    const members = q.squad < 0 ? [] : (q.side === 0 ? s.friends : s.enemies).filter((e) => e.squad === q.squad);
    const lead = members[0];
    return { side: q.side, x: lead ? lead.pos.x : q.x, z: lead ? lead.pos.z : q.z, live: q.squad >= 0, n: q.squad >= 0 ? members.length : q.units.length, to: q.to };
  });
}

/**
 * Where each member of battle squad `q` stands while it is numbers, its first `d` metres along its
 * walk (or at `at` when it is not walking a link): on its way one behind another along the walk,
 * `CONQUEST.column` apart; standing, round where it stands. For the view, which eases `d` and `at`.
 */
export function columnPoints(q: BattleSquad, d = q.d, at: Point = q): Point[] {
  const walk = q.task !== "post" && q.task !== "rally" && q.from !== q.to ? pathOf(q.from, q.to) : null;
  const going = walk && d < walk.len - 0.5;
  return q.units.map((_, m) => (going ? along(walk, d - m * CONQUEST.column) : { x: at.x + (m % 2 ? 1.6 : -1.6) * Math.min(m, 1), z: at.z + m * 1.4 }));
}

/** The node the battle most wants the player at: one of theirs being taken, else one their squads are taking; -1 for none. */
export function battleFocus(s: State): { node: number; kind: "defend" | "attack" } | null {
  const b = s.battle;
  if (!b) return null;
  const p = s.player.pos;
  let defend = -1;
  let defendD = Infinity;
  NODES.forEach((n, i) => {
    if (s.nodes[i] !== "freed") return;
    const m = b.meter[i];
    // Another player's squad passing through on its way to another node comes at nothing here.
    const coming = b.squads.some((q) => q.side !== 0 && attacking(q, i) && (arrived(q) || dist2d(q, n.core) < 120));
    if ((m && m.side !== 0) || coming) {
      const d = dist2d(n.core, p);
      if (d < defendD) {
        defend = i;
        defendD = d;
      }
    }
  });
  if (defend >= 0) return { node: defend, kind: "defend" };
  let attack = -1;
  let attackD = Infinity;
  NODES.forEach((n, i) => {
    if (s.nodes[i] === "freed" || !b.squads.some((q) => q.side === 0 && attacking(q, i))) return;
    const d = dist2d(n.core, p);
    if (d < attackD) {
      attack = i;
      attackD = d;
    }
  });
  return attack >= 0 ? { node: attack, kind: "attack" } : null;
}

/** The meter of node `i` under capture by a side's squads, as a share of `CONQUEST.capture`, or null. */
export const meterOf = (b: Battle, i: number) => (b.meter[i] ? { side: b.meter[i]!.side, share: Math.min(1, b.meter[i]!.t / CONQUEST.capture) } : null);
