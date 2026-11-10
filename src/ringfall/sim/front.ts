import { ALLY, COUNTER, ENEMIES, FORTIFY, FRONT, MOMENTUM, PLAYER, TICK, type EnemyKind, type Rarity, type SiegeWave } from "./config";
import { dist2d } from "./geom";
import { depotIndex, FRONT_LINKS, NODES, nodeIndex, POIS, poiIndex, TIER, type NodeId, type PoiId } from "./map";
import { cellsAround, fieldTo } from "./hunt";
import { spawnEnemy } from "./enemies";
import { hiddenPosts } from "./world";
import { raiseAlly } from "./ally";
import { coreReward } from "./mods";
import type { Battle } from "./battle";
import type { PoiHold } from "./island";
import type { State } from "./state";
import { hypot2 } from "./hypot";

/*
 * The front (docs/ringfall/island-v2.md): the six freeable POIs are nodes joined along the roads
 * (`FRONT_LINKS`). The player holds the camp and the nodes taken; a node next to that ground is
 * on the front, and only a node on the front can be taken, by capturing its core (`FRONT`). The
 * pure rules here serve the raid, the island's nights (meta/island.ts) and the maps alike.
 */

/** Who holds a node: the enemy, the player, or another player (sim/holds.ts). Another player's node is not the player's: on the front it is taken by its core as the enemy's is. */
export type NodeHold = PoiHold;

/** Each node's neighbours, as places in `NODES`. */
export const NEIGHBOURS: number[][] = NODES.map((_, i) =>
  FRONT_LINKS.flatMap(([a, b]) => {
    const ia = a === "camp" ? -1 : nodeIndex(a);
    const ib = nodeIndex(b);
    return ia === i ? [ib] : ib === i && ia >= 0 ? [ia] : [];
  }),
);

/** The nodes linked to the camp, which is the player's from the start. */
export const CAMP_NEXT: number[] = FRONT_LINKS.filter(([a]) => a === "camp").map(([, b]) => nodeIndex(b));

/** Whether node `i` touches the player's ground: the camp, or a node freed. */
const touchesPlayer = (holds: readonly NodeHold[], i: number) => CAMP_NEXT.includes(i) || NEIGHBOURS[i].some((k) => holds[k] === "freed");

/** The nodes on the front: not the player's, and next to the player's ground. Only these can be taken. */
export const frontNodes = (holds: readonly NodeHold[]): boolean[] => NODES.map((_, i) => holds[i] !== "freed" && touchesPlayer(holds, i));

/** Each node's standing, from the POIs'. */
export const nodeHolds = (poi: (id: PoiId) => PoiHold): NodeHold[] => NODES.map((n) => poi(n.id));

/** How many nodes the enemy holds: another player's are neither the enemy's nor the player's, and count for neither (the enemy's strength, `strengthFor()`). */
export const enemyNodes = (holds: readonly NodeHold[]) => holds.filter((h) => h === "held").length;

/** The node of POI `poi` (a place in `POIS`), or -1 for the titan's pad. */
export const poiNode = (poi: number) => nodeIndex(POIS[poi].id);

/** The raid's momentum (`MOMENTUM`): the nodes the player took by their cores after the first, to its top. */
export const momentum = (s: { stats: { captured?: NodeId[] } }) => Math.max(0, Math.min(MOMENTUM.max, capturedIds(s).length - 1));

/** Whether squad `squad` stands for node `i`: one of its POI's garrison. */
export function garrisonOf(s: State, i: number, squad: number): boolean {
  const sq = s.squads[squad];
  return !!sq && sq.retreat === undefined && sq.poi === poiIndex(NODES[i].id);
}

/*
 * The middles of the nodes the player holds in the world in place: no robot walks into one
 * (`inZone()`). Set from the raid's nodes by `useZones()`, as `useRoutes()` sets the world's routes.
 */
let zones: { x: number; z: number }[] = [];
let zoneKey = "";

/** Puts the raid's freed nodes in place as the zones robots keep out of. */
export function useZones(s: Pick<State, "nodes">) {
  const key = s.nodes.map((h) => (h === "freed" ? 1 : 0)).join("");
  if (key === zoneKey) return;
  zoneKey = key;
  zones = NODES.filter((_, i) => s.nodes[i] === "freed").map((n) => ({ x: n.core.x, z: n.core.z }));
}

/** Whether (x, z) lies within `FRONT.zone` (plus `r`) of a node the player holds. */
export function inZone(x: number, z: number, r = 0): boolean {
  for (const q of zones) if (hypot2(x - q.x, z - q.z) < FRONT.zone + r) return true;
  return false;
}

/** Whether node `i` is the player's, marked by the enemy for the night and not fortified yet: its core takes the use key (`FORTIFY`). */
export const fortifiable = (s: Pick<State, "nodes" | "battle">, i: number) => s.nodes[i] === "freed" && !!s.battle && s.battle.targets.includes(i) && !s.battle.fortified.includes(i);

/** The core within reach of the use key, as a place in `NODES`, or -1. A freed node's core does nothing, but for one to fortify. */
export function coreInReach(s: State): number {
  const p = s.player;
  return NODES.findIndex((n, i) => (s.nodes[i] !== "freed" || fortifiable(s, i)) && dist2d(n.core, p.pos) < PLAYER.interactRange + FRONT.half + 0.5 && p.pos.y > n.core.y - 1.5 && p.pos.y < n.core.y + 2);
}

/** Whether node `i` can be taken in the raid as it stands: on the front, and not the player's already. */
export const capturable = (s: Pick<State, "nodes">, i: number) => frontNodes(s.nodes)[i];

/**
 * The use key at core `i`: a core off the front is shielded by the enemy and refuses; one on it
 * starts its capture (a capture of this core already under way goes on as it was). The alarm
 * sends the node's garrison to the core.
 */
export function useCore(s: State, i: number) {
  if (s.nodes[i] === "freed") {
    if (fortifiable(s, i) && s.fortify?.node !== i) {
      s.fortify = { node: i, t: 0, held: false };
      s.events.push({ t: "fortifyStart", node: i });
    }
    return;
  }
  if (!capturable(s, i)) {
    s.events.push({ t: "coreShielded", node: i });
    return;
  }
  if (s.capture?.node === i) return;
  s.capture = { node: i, t: 0, held: false, waves: 0, wait: 0, coming: null };
  s.events.push({ t: "coreStart", node: i });
  const c = NODES[i].core;
  s.squads.forEach((sq, k) => {
    if (!garrisonOf(s, i, k)) return;
    for (const e of s.enemies) {
      if (e.squad !== k || e.aware === "engaged" || e.kind === "titan") continue;
      e.aware = "alert";
      e.goal = { x: c.x, z: c.z };
      e.searchT = FRONT.capture + 30;
      e.detect = Math.max(e.detect, 0.5);
    }
  });
}

/** Whether a robot stands on the ground the core is taken from (`FRONT.radius`): the meter waits while one does. */
const contesting = (s: State, i: number) => {
  const c = NODES[i].core;
  return s.enemies.some((e) => e.mode !== "spawning" && dist2d(e.pos, c) < FRONT.radius && Math.abs(e.pos.y - c.y) < FRONT.rise + ENEMIES.drone.fly);
};

/** Whether the player stands where the core is taken from, up. */
export const onCore = (s: State, i: number) => {
  const p = s.player;
  const c = NODES[i].core;
  return p.downed <= 0 && dist2d(p.pos, c) < FRONT.radius && Math.abs(p.pos.y - c.y) < FRONT.rise;
};

/** The fortifying under way fills while the player holds the core's ground with no robot on it; full, the node is safe from the night. Lost or left, it is dropped. */
function stepFortify(s: State) {
  const f = s.fortify;
  if (!f || s.phase !== "play") return;
  if (!fortifiable(s, f.node) || dist2d(s.player.pos, NODES[f.node].core) > FRONT.siege.near) {
    s.fortify = null;
    return;
  }
  f.held = onCore(s, f.node) && !contesting(s, f.node);
  if (f.held) f.t += TICK;
  if (f.t < FORTIFY.time) return;
  s.battle!.fortified.push(f.node);
  s.fortify = null;
  s.events.push({ t: "fortified", node: f.node });
}

/** The waves of node `i`'s siege (`FRONT.siege`): its tier's, the first with what the enemy's strength adds. */
export function siegeWaves(s: Pick<State, "strength">, i: number): SiegeWave[] {
  const waves = FRONT.siege.waves[Math.min(TIER[NODES[i].id], FRONT.siege.waves.length - 1)];
  return waves.map((w, k) => (k ? w : { ...w, kinds: [...w.kinds, ...FRONT.siege.extra[s.strength]] }));
}

/**
 * Every tick: retreating squads walk off and are gone once their time is up; a capture under way
 * fills while the player holds the core's ground with no robot on it, calls the waves of its
 * siege as the meter passes their marks, and takes the node when full.
 */
export function stepFront(s: State) {
  s.squads.forEach((sq, k) => {
    if (sq.retreat === undefined) return;
    sq.retreat -= TICK;
    if (sq.retreat > 0) return;
    sq.retreat = undefined;
    sq.walk = undefined;
    s.enemies = s.enemies.filter((e) => e.squad !== k);
  });
  stepFortify(s);
  const c = s.capture;
  if (!c || s.phase !== "play") return;
  if (s.nodes[c.node] === "freed") {
    s.capture = null;
    return;
  }
  c.held = onCore(s, c.node) && !contesting(s, c.node);
  if (c.held) c.t += TICK;
  if (c.t >= FRONT.capture) {
    takeNode(s, c.node);
    return;
  }
  if (c.coming) {
    if (s.time >= c.coming.at) landWave(s, c.node);
    return;
  }
  const waves = siegeWaves(s, c.node);
  const next = waves[c.waves];
  c.wait = Math.max(0, c.wait - TICK);
  if (!next || c.wait > 0 || c.t < next.at * FRONT.capture) return;
  if (dist2d(s.player.pos, NODES[c.node].core) >= FRONT.siege.near) return;
  if (callWave(s, c.node, next, c.waves, waves.length)) c.waves++;
  else c.wait = FRONT.siege.retry;
}

/**
 * Wave `k` of node `i`'s siege is announced: a beam on open ground a walk of `FRONT.siege.dist`
 * from the core, on the side of a neighbouring node the enemy holds (the waves take the
 * neighbours in turn, nearest first), where its squad steps out `FRONT.siege.warn` seconds on.
 * The ground may be in the player's sight: the beam is the warning. True when the wave was
 * called, or when the enemy has no neighbouring node to send one from; false when no ground
 * turned up.
 */
function callWave(s: State, i: number, wave: SiegeWave, k: number, of: number): boolean {
  const n = NODES[i];
  const c = s.capture!;
  const from = NEIGHBOURS[i].filter((j) => s.nodes[j] === "held").sort((a, b) => dist2d(NODES[a], n.core) - dist2d(NODES[b], n.core));
  if (!from.length) return true;
  const src = NODES[from[k % from.length]];
  const field = fieldTo(n.core.x, n.core.z);
  const cells = field ? cellsAround(field, FRONT.siege.dist[0], FRONT.siege.dist[1]) : [];
  const order = cells.map((q) => ({ q, d: dist2d(q, src) })).sort((a, b) => a.d - b.d).slice(0, 60);
  for (const { q } of order) {
    if (dist2d(q, s.player.pos) < FRONT.siege.dist[0] * 0.6 || inZone(q.x, q.z, 4)) continue;
    const spots = hiddenPosts(s, wave.kinds, q.x, q.z, 0);
    if (!spots) continue;
    c.coming = { x: q.x, z: q.z, at: s.time + FRONT.siege.warn, kinds: wave.kinds, spots: spots.map((p) => ({ mx: p.mx, mz: p.mz })), from: src.name, wave: k + 1, of, guard: !!wave.guard };
    s.events.push({ t: "siegeWarn", node: i, x: q.x, z: q.z, wave: k + 1, of });
    return true;
  }
  return false;
}

/** The wave announced steps out of its beam and makes for the core by the ground's way, hunting the player. */
function landWave(s: State, i: number) {
  const n = NODES[i];
  const w = s.capture!.coming!;
  s.capture!.coming = null;
  const squad = s.squads.length;
  s.squads.push({ name: `${w.from}からの増援`, poi: -1, patrol: [], leg: 0, engaged: false, roam: true, hunt: true, routed: true, sinceSeen: 0, last: { x: n.core.x, z: n.core.z }, siege: i });
  const plate = w.guard ? (Math.min(3, TIER[n.id]) as Rarity) : undefined;
  w.kinds.forEach((kind: EnemyKind, m) => {
    const e = spawnEnemy(s, kind, w.spots[m].mx, w.spots[m].mz, -1, squad, { appear: true, ...(plate && (kind === "grunt" || kind === "heavy") ? { plate } : {}) });
    e.aware = "alert";
    e.goal = { x: n.core.x, z: n.core.z };
    e.searchT = 60;
    e.detect = 0.3;
  });
  s.events.push({ t: "siegeLand", x: w.x, z: w.z });
}

/**
 * Node `i` is the player's: its depot comes on, the self-revive comes back and the teammate gets
 * up (as when a POI is cleared), and what is left of its garrison walks off toward the nearest
 * node the robots still hold, to be gone after `FRONT.retreat` seconds. No robot comes onto its
 * ground again this raid; the island keeps it the player's unless the enemy takes it back in the battle.
 */
export function takeNode(s: State, i: number) {
  const n = NODES[i];
  s.nodes[i] = "freed";
  s.capture = null;
  s.stats.captured.push(n.id);
  // A second node and on in one raid: the enemy's clocks run down faster (`MOMENTUM`).
  if (momentum(s) > 0) {
    if (Number.isFinite(s.reinforceT)) s.reinforceT *= MOMENTUM.clock;
    if (Number.isFinite(s.raiderT)) s.raiderT *= MOMENTUM.clock;
    s.events.push({ t: "momentum", level: momentum(s) });
  }
  useZones(s);
  s.cleared[poiIndex(n.id)] = true;
  const d = depotIndex(n.id);
  if (d >= 0 && !s.depots[d]) {
    s.depots[d] = true;
    s.events.push({ t: "depotOn", poi: n.id });
  }
  s.player.selfRevive = 1;
  raiseAlly(s, "self", ALLY.reviveHp);
  garrisonLeaves(s, i);
  if (s.battle) {
    // The battle counts the player's own captures among the nodes that changed hands.
    s.battle.taken.push({ node: n.id, side: 0, t: Math.round(s.battle.now) });
    dueCounter(s.battle, i);
  }
  coreReward(s, i, n.core);
  s.events.push({ t: "coreTaken", node: i });
}

/**
 * What is left of node `i`'s garrison, and of the waves of its siege, walks off toward the nearest
 * node the robots still hold, to be gone after `FRONT.retreat` seconds: the node is the player's.
 */
export function garrisonLeaves(s: State, i: number) {
  const n = NODES[i];
  const away = NEIGHBOURS[i].filter((k) => s.nodes[k] !== "freed").sort((a, b) => dist2d(NODES[a], n.core) - dist2d(NODES[b], n.core))[0];
  s.squads.forEach((sq, k) => {
    // The siege's waves give the node up with its garrison: a squad left hunting would stand at the edge of ground it may not enter.
    if (!garrisonOf(s, i, k) && sq.siege !== i) return;
    const members = s.enemies.filter((e) => e.squad === k);
    if (!members.length) return;
    const lead = members[0].pos;
    // Off the node's ground, toward the nearest node still the robots', or straight out from the core.
    const to = away !== undefined ? NODES[away] : lead;
    const dx = to.x - n.core.x;
    const dz = to.z - n.core.z;
    const l = hypot2(dx, dz) || 1;
    sq.walk = { x: n.core.x + (dx / l) * (FRONT.zone + 25), z: n.core.z + (dz / l) * (FRONT.zone + 25) };
    sq.retreat = FRONT.retreat;
    sq.poi = -1;
    sq.engaged = false;
    sq.hunt = false;
    sq.routed = false;
    sq.patrol = [];
    for (const e of members) {
      e.poi = -1;
      e.aware = "idle";
      e.detect = 0;
      e.goal = null;
      e.cover = e.peek = null;
    }
  });
}

/** The node ids the raid took, as the island counts them (a record from before the front took none). */
export const capturedIds = (s: { stats: { captured?: NodeId[] } }): NodeId[] => (s.stats.captured ?? []).filter((id, k, all) => nodeIndex(id) >= 0 && all.indexOf(id) === k);

/** A node has just turned the player's: the enemy's counter-attack on it is due `COUNTER.delay` seconds on (sim/battle.ts). */
export function dueCounter(b: Battle, i: number) {
  if (!b.counters.some((c) => c.node === i)) b.counters.push({ node: i, at: b.now + COUNTER.delay });
}
