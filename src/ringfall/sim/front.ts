import { ALLY, ENEMIES, FRONT, PLAYER, TICK } from "./config";
import { dist2d } from "./geom";
import { depotIndex, FRONT_LINKS, NODES, nodeIndex, POIS, poiIndex, type NodeId, type PoiId } from "./map";
import { cellsAround, fieldTo } from "./hunt";
import { spawnEnemy } from "./enemies";
import { hiddenPosts } from "./world";
import { raiseAlly } from "./ally";
import type { PoiHold } from "./island";
import type { State } from "./state";

/*
 * The front (docs/ringfall/island-v2.md): the six freeable POIs are nodes joined along the roads
 * (`FRONT_LINKS`). The player holds the camp and the nodes taken; a node next to that ground is
 * on the front, and only a node on the front can be taken, by capturing its core (`FRONT`). The
 * pure rules here serve the raid, the island's nights (meta/island.ts) and the maps alike.
 */

/** Who holds a node: the enemy or the player. */
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

/** How many nodes the enemy holds. */
export const enemyNodes = (holds: readonly NodeHold[]) => holds.filter((h) => h !== "freed").length;

/** The node of POI `poi` (a place in `POIS`), or -1 for the titan's pad. */
export const poiNode = (poi: number) => nodeIndex(POIS[poi].id);

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
  for (const q of zones) if (Math.hypot(x - q.x, z - q.z) < FRONT.zone + r) return true;
  return false;
}

/** The core within reach of the use key, as a place in `NODES`, or -1. A freed node's core does nothing. */
export function coreInReach(s: State): number {
  const p = s.player;
  return NODES.findIndex((n, i) => s.nodes[i] !== "freed" && dist2d(n.core, p.pos) < PLAYER.interactRange + FRONT.half + 0.5 && p.pos.y > n.core.y - 1.5 && p.pos.y < n.core.y + 2);
}

/** Whether node `i` can be taken in the raid as it stands: on the front, and not the player's already. */
export const capturable = (s: Pick<State, "nodes">, i: number) => frontNodes(s.nodes)[i];

/**
 * The use key at core `i`: a core off the front is shielded by the enemy and refuses; one on it
 * starts its capture (a capture of this core already under way goes on as it was). The alarm
 * sends the node's garrison to the core.
 */
export function useCore(s: State, i: number) {
  if (!capturable(s, i)) {
    s.events.push({ t: "coreShielded", node: i });
    return;
  }
  if (s.capture?.node === i) return;
  s.capture = { node: i, t: 0, held: false, pushT: FRONT.pushAt, waves: 0 };
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

/**
 * Every tick: retreating squads walk off and are gone once their time is up; a capture under way
 * fills while the player holds the core's ground with no robot on it, sends the push from the
 * neighbouring nodes while the player is near, and takes the node when full.
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
  const c = s.capture;
  if (!c || s.phase !== "play") return;
  if (s.nodes[c.node] === "freed") {
    s.capture = null;
    return;
  }
  c.held = onCore(s, c.node) && !contesting(s, c.node);
  if (c.held) c.t += TICK;
  const near = dist2d(s.player.pos, NODES[c.node].core) < FRONT.radius * 5;
  if (near && c.waves < FRONT.pushWaves[s.strength]) {
    c.pushT -= TICK;
    if (c.pushT <= 0) {
      c.pushT = sendPush(s, c.node) ? FRONT.pushEvery : 5;
      if (c.pushT === FRONT.pushEvery) c.waves++;
    }
  }
  if (c.t >= FRONT.capture) takeNode(s, c.node);
}

/**
 * The push on a capture: a squad from each neighbouring node the player does not hold (the
 * nearest `FRONT.pushMax`), beamed in out of sight a walk of `FRONT.pushDist` from the core on its
 * node's side, and walking in by the ground's way. True when one came, or when none has anywhere
 * to come from.
 */
function sendPush(s: State, i: number): boolean {
  const n = NODES[i];
  const from = NEIGHBOURS[i]
    .filter((k) => s.nodes[k] !== "freed")
    .sort((a, b) => dist2d(NODES[a], n.core) - dist2d(NODES[b], n.core))
    .slice(0, FRONT.pushMax[s.strength]);
  if (!from.length) return true;
  const field = fieldTo(n.core.x, n.core.z);
  const cells = field ? cellsAround(field, FRONT.pushDist[0], FRONT.pushDist[1]) : [];
  const kinds = FRONT.push[s.strength];
  let sent = false;
  for (const k of from) {
    const src = NODES[k];
    const order = cells.map((q) => ({ q, d: dist2d(q, src) })).sort((a, b) => a.d - b.d).slice(0, 60);
    for (const { q } of order) {
      if (dist2d(q, s.player.pos) < FRONT.pushDist[0] * 0.6 || inZone(q.x, q.z, 4)) continue;
      const spots = hiddenPosts(s, kinds, q.x, q.z);
      if (!spots) continue;
      const squad = s.squads.length;
      s.squads.push({ name: `${src.name}からの増援`, poi: -1, patrol: [], leg: 0, engaged: false, roam: true, hunt: true, routed: true, sinceSeen: 0, last: { x: n.core.x, z: n.core.z } });
      kinds.forEach((kind, m) => {
        const e = spawnEnemy(s, kind, spots[m].mx, spots[m].mz, -1, squad, { appear: true });
        e.aware = "alert";
        e.goal = { x: n.core.x, z: n.core.z };
        e.searchT = 60;
        e.detect = 0.3;
      });
      s.events.push({ t: "reinforce", x: q.x, z: q.z });
      sent = true;
      break;
    }
  }
  return sent;
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
  s.events.push({ t: "coreTaken", node: i });
}

/**
 * What is left of node `i`'s garrison walks off toward the nearest node the robots still hold, to
 * be gone after `FRONT.retreat` seconds: the node is the player's.
 */
export function garrisonLeaves(s: State, i: number) {
  const n = NODES[i];
  const away = NEIGHBOURS[i].filter((k) => s.nodes[k] !== "freed").sort((a, b) => dist2d(NODES[a], n.core) - dist2d(NODES[b], n.core))[0];
  s.squads.forEach((sq, k) => {
    if (!garrisonOf(s, i, k)) return;
    const members = s.enemies.filter((e) => e.squad === k);
    if (!members.length) return;
    const lead = members[0].pos;
    // Off the node's ground, toward the nearest node still the robots', or straight out from the core.
    const to = away !== undefined ? NODES[away] : lead;
    const dx = to.x - n.core.x;
    const dz = to.z - n.core.z;
    const l = Math.hypot(dx, dz) || 1;
    sq.walk = { x: n.core.x + (dx / l) * (FRONT.zone + 25), z: n.core.z + (dz / l) * (FRONT.zone + 25) };
    sq.retreat = FRONT.retreat;
    sq.poi = -1;
    sq.engaged = false;
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
