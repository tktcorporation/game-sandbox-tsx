/**
 * Other players' expeditions on the island (docs/ringfall/multiplayer.md, side 3 of the battle),
 * driven by made-up expeditions: there is no server yet.
 *
 * - **take**: an expedition lands at the pad and takes a node of the player's nobody defends; the
 *   next day the node is that player's, and the night does not come at it.
 * - **transit**: an expedition sent two links on walks through a node of the player's without
 *   coming at it (no threat, no capture there) and takes the node it was sent to.
 * - **retake**: a node another player holds, next to the player's ground, held by one robot of
 *   theirs: the factory's squads take it back.
 * - **front**: another player's node next to the player's ground is on the front, its core starts a
 *   capture, and it counts as neither the enemy's nor the player's for the enemy's strength.
 * - **night**: a node of the player's whose only foes are other players' nodes never falls in the night.
 * - **world**: near the player an expedition's squad is robots among the enemy's, another player's,
 *   hostile to the network's robots.
 * - **pure**: the reckoning in numbers alone (`reckonApart()`) takes a node on plain data and leaves its input as it was.
 * - **saves**: a v26 save keeps another player's node; a v25 save cannot hold one.
 * - **none**: a battle whose only expedition sets off after the battle has ended plays as one given none.
 *
 * `checkRivals()` gives the sim gate's error, or null; run this file alone
 * (`npx tsx scripts/ringfall-rivals.ts`) for each part's numbers.
 */
import { CONQUEST, FACTORY_TOP, STRENGTH, TICK, type EnemyKind } from "../src/ringfall/sim/config";
import { NODES, nodeIndex, POIS, type NodeId } from "../src/ringfall/sim/map";
import { CAMP_NEXT, enemyNodes, frontNodes, NEIGHBOURS, useCore } from "../src/ringfall/sim/front";
import { finishBattle, robotSide, type Battle, type BattleStart, type BattleSquad } from "../src/ringfall/sim/battle";
import { reckonApart, type ReckonSquad } from "../src/ringfall/sim/reckon";
import { rivalHold } from "../src/ringfall/sim/holds";
import { hostile } from "../src/ringfall/sim/factions";
import { spawnEnemy } from "../src/ringfall/sim/enemies";
import { idleInput, newRun, starterKit, strengthFor, type State } from "../src/ringfall/sim/state";
import { step } from "../src/ringfall/sim/step";
import { groundAt } from "../src/ringfall/sim/geom";
import { holds, nightRaids } from "../src/ringfall/meta/island";
import { newProfile, parseProfile, settle, type Profile } from "../src/ringfall/meta/profile";

const OWNER = "rival-1";
const SUP = nodeIndex("supply");
const RELAY = nodeIndex("relay");
const STATION = nodeIndex("station");

/** The island of a new profile with `freed` the player's and `rival` another player's. */
function island(freed: NodeId[], rival: NodeId[] = []): Profile {
  const p = newProfile(8);
  const poiState = { ...p.poiState };
  for (const id of freed) poiState[id] = { state: "freed" };
  for (const id of rival) poiState[id] = { state: rivalHold(OWNER) };
  return { ...p, poiState };
}

/** A battle raid of `p` with nothing but the battle in it: no reinforcements, raiders, parties or crews, the teammate away, the player standing tough where it starts. */
function raid(p: Profile, battle: BattleStart, seed = 21): State {
  const s = newRun(seed, starterKit(), "reservoir", { island: holds(p), battle });
  s.reinforceT = s.raiderT = 1e9;
  s.parties = [];
  s.crewsDue = [];
  s.ally.active = false;
  s.player.hp = 1e7;
  return s;
}

/** Steps `s` with the player standing still until `done` holds or `limit` seconds pass, handing each step's events to `seen`; the seconds it took, or -1. */
function until(s: State, limit: number, done: () => boolean, seen?: (events: State["events"]) => void): number {
  const t0 = s.time;
  const spot = { ...s.player.pos };
  for (let i = 0; i < limit / TICK && s.phase === "play"; i++) {
    step(s, idleInput(), false);
    seen?.(s.events);
    s.player.pos = { ...spot };
    s.player.hp = 1e7;
    if (done()) return Math.round(s.time - t0);
  }
  return -1;
}

/** No side makes squads: the enemy's, the rogues' and (unless `factory`) the player's work never comes due. */
const quiet = (b: Battle, factory = false) => {
  b.made = [factory ? 0 : -1e12, -1e12, -1e12];
};

export interface Rivals {
  /** The battle's seconds at which the relay fell to the expedition (which set off at 5 s), or -1. */
  take: number;
  /** The battle's seconds at which the supply depot fell to the expedition that walked through the player's node next to the pad, and the threats at the nodes on its way. */
  transit: { t: number; threats: number };
  /** Seconds to the factory's squads taking the relay back, or -1. */
  retake: number;
  /** The enemy's strength with `at` nodes its own (the fewest for its next level), and with one of them another player's instead. */
  strength: { at: number; level: [number, number] };
  /** Of 400 nights, those in which a node of the player's fell whose only foe was another player's node, and with the same foes the enemy's. */
  nights: [number, number];
  /** Calls of the reckoning in numbers that took a node of the player's for another player. */
  pure: number;
}

export function rivalsRun(): { err: string | null; r: Rivals } {
  const r: Rivals = { take: -1, transit: { t: -1, threats: 0 }, retake: -1, strength: { at: 0, level: [0, 0] }, nights: [0, 0], pure: -1 };
  const fail = (err: string) => ({ err: `rivals: ${err}`, r });

  // take: the relay (next to the pad) is the player's, defended by nobody, and an expedition lands for it.
  const tp = island(["supply", "relay", "waterworks"]);
  const ts = raid(tp, { factory: 0, rivals: [{ owner: OWNER, target: "relay", kinds: ["grunt", "grunt", "grunt"], at: 5 }] });
  quiet(ts.battle!);
  r.take = until(ts, 900, () => ts.nodes[RELAY] !== "freed");
  if (ts.nodes[RELAY] !== rivalHold(OWNER)) return fail(`an expedition sent to the undefended relay left it ${ts.nodes[RELAY]} after 900 s`);
  if (!ts.battle!.taken.some((t) => t.node === "relay" && t.side === 3)) return fail("the relay taken by another player is not among the nodes that changed hands");
  if (!ts.battle!.squads.some((q) => q.side === 3 && q.owner === OWNER && q.to === RELAY && q.task === "hold")) return fail("the expedition does not hold the relay it took");
  ts.outcome = "extracted";
  finishBattle(ts);
  const after = settle(tp, ts);
  if (after.profile.poiState.relay.state !== rivalHold(OWNER)) return fail(`the next day the relay is ${after.profile.poiState.relay.state}`);
  if (after.night.lost.includes("relay") || after.raid.lost.join() !== "relay") return fail(`the day's changes read ${JSON.stringify({ raid: after.raid, night: after.night })}`);
  if (!frontNodes(NODES.map((n) => after.profile.poiState[n.id].state))[RELAY]) return fail("the relay another player took is not on the front the next day");

  // transit: the supply depot, two links from the pad, through the player's quarry or relay (both undefended); the expedition walks through and takes the depot only.
  const xp = island(["supply", "quarry", "relay"]);
  const xs = raid(xp, { factory: 0, rivals: [{ owner: OWNER, target: "supply", kinds: ["grunt", "grunt", "grunt"], at: 5 }] });
  quiet(xs.battle!);
  const QUARRY = nodeIndex("quarry");
  const threats = new Map<number, number>();
  r.transit.t = until(
    xs,
    1200,
    () => xs.nodes[SUP] !== "freed",
    (evs) => evs.forEach((e) => e.t === "nodeThreat" && threats.set(e.node, (threats.get(e.node) ?? 0) + 1)),
  );
  r.transit.threats = (threats.get(QUARRY) ?? 0) + (threats.get(RELAY) ?? 0);
  if (xs.nodes[SUP] !== rivalHold(OWNER)) return fail(`an expedition sent through the player's ground to the supply depot left it ${xs.nodes[SUP]} after 1200 s`);
  if (xs.nodes[QUARRY] !== "freed" || xs.nodes[RELAY] !== "freed" || r.transit.threats) return fail(`the expedition came at the nodes on its way: quarry ${xs.nodes[QUARRY]}, relay ${xs.nodes[RELAY]}, ${r.transit.threats} threats there`);
  if (xs.battle!.taken.some((t) => t.node !== "supply") || xs.battle!.meter.some((m, i) => m && i !== SUP)) return fail(`the expedition began taking a node it was not sent to: ${JSON.stringify(xs.battle!.taken)}`);

  // retake: another player's relay next to the player's supply depot, one robot of theirs holding it; the factory at its top.
  const rp = island(["supply"], ["relay"]);
  const rs = raid(rp, { factory: FACTORY_TOP, rivals: [{ owner: OWNER, target: "relay", kinds: ["grunt"], at: 0 }] });
  quiet(rs.battle!, true);
  if (!rs.battle!.squads.some((q) => q.side === 3 && q.to === RELAY && q.task === "hold")) return fail("an expedition at the relay its owner holds does not stand there from the start");
  r.retake = until(rs, 1200, () => rs.nodes[RELAY] === "freed");
  if (r.retake < 0) return fail(`the factory's squads never took back another player's relay (${rs.nodes[RELAY]}) in 1200 s`);
  if (!rs.battle!.taken.some((t) => t.node === "relay" && t.side === 0)) return fail("the relay taken back is not among the nodes that changed hands");

  // front: another player's station, next to the player's supply depot.
  const fp = island(["supply"], ["station"]);
  const fs = raid(fp, { factory: 0 });
  if (!frontNodes(fs.nodes)[STATION]) return fail("another player's node next to the player's ground is not on the front");
  if (frontNodes(fs.nodes).some((on, i) => on !== (fs.nodes[i] !== "freed" && (CAMP_NEXT.includes(i) || NEIGHBOURS[i].some((k) => fs.nodes[k] === "freed"))))) return fail("another player's node changed the rest of the front");
  useCore(fs, STATION);
  if (fs.capture?.node !== STATION || fs.events.some((e) => e.t === "coreShielded")) return fail("the core of another player's node on the front refused the player");
  if (enemyNodes(fs.nodes) !== NODES.length - 2) return fail(`with one node the player's and one another player's the enemy holds ${enemyNodes(fs.nodes)}`);
  // At the fewest nodes that make the enemy a level stronger, one of them another player's instead brings it back down.
  const lift = STRENGTH.byShare.map(([share]) => Math.ceil(share * NODES.length - 1e-9)).filter((k) => k > 0 && strengthFor(k) > strengthFor(k - 1))[0];
  const enemyAt = NODES.map((_, i) => (i < lift ? "held" : "freed"));
  const rivalAt = enemyAt.map((h, i) => (i === 0 ? rivalHold(OWNER) : h));
  r.strength = { at: lift, level: [strengthFor(enemyNodes(enemyAt)), strengthFor(enemyNodes(rivalAt))] };
  if (lift === undefined || r.strength.level[1] !== strengthFor(lift - 1) || r.strength.level[0] <= r.strength.level[1]) return fail(`with ${lift} nodes the enemy's the strength is ${r.strength.level[0]}, with one of them another player's ${r.strength.level[1]}`);
  if (fs.strength !== strengthFor(NODES.length - 2)) return fail(`the raid plays at strength ${fs.strength}`);
  if (fs.cleared[POIS.findIndex((p) => p.id === "station")] !== true || fs.enemies.some((e) => e.poi === POIS.findIndex((p) => p.id === "station"))) return fail("another player's node stands a garrison of the enemy's");

  // night: the waterworks (next to the supply depot and the relay only) with both another player's never falls; with both the enemy's it does.
  const WW = "waterworks" as NodeId;
  const only = NEIGHBOURS[nodeIndex(WW)].map((k) => NODES[k].id).filter((id) => id !== "supply");
  for (let seed = 1; seed <= 400; seed++) {
    if (nightRaids(["supply", WW], [], 0, seed, 3, only).includes(WW)) r.nights[0]++;
    if (nightRaids(["supply", WW], [], 0, seed, 3).includes(WW)) r.nights[1]++;
  }
  if (r.nights[0] || !r.nights[1]) return fail(`the waterworks fell in ${r.nights[0]} of 400 nights with another player's nodes as its foes and in ${r.nights[1]} with the enemy's`);

  // world: near the player an expedition's squad is robots, hostile to the network's.
  const ws = raid(island(["supply"]), { factory: 0 });
  quiet(ws.battle!);
  const b = ws.battle!;
  const at = { x: ws.player.pos.x + 30, z: ws.player.pos.z };
  const q: BattleSquad = { id: b.nextId++, side: 3, owner: OWNER, units: [{ kind: "grunt", hp: 99, shield: 0 }], from: SUP, to: SUP, d: 0, task: "attack", squad: -1, x: at.x, z: at.z, via: [], ashore: 0 };
  b.squads.push(q);
  until(ws, 2, () => q.squad >= 0);
  const theirs = ws.enemies.filter((e) => e.battle === q.id);
  if (q.squad < 0 || theirs.length !== 1 || theirs[0].rival !== OWNER || robotSide(theirs[0]) !== 3 || ws.friends.some((e) => e.battle === q.id)) return fail(`another player's squad near the player is ${JSON.stringify(theirs.map((e) => ({ rival: e.rival, friend: e.friend })))}`);
  const net = spawnEnemy(ws, "grunt", at.x + 5, at.z, -1, 0, { hashed: true });
  net.mode = "move";
  if (!hostile(theirs[0], net)) return fail("another player's robot is not hostile to the network's");
  ws.player.pos = { x: at.x + 600, y: groundAt(at.x + 600, at.z, 0.4, 99), z: at.z };
  until(ws, 3, () => q.squad < 0);
  if (q.squad >= 0 || ws.enemies.some((e) => e.battle === q.id)) return fail("another player's squad stayed robots away from the player");

  // pure: a squad of another player's at a node of the player's nobody holds takes it in numbers.
  const plain: ReckonSquad = { id: 1, side: 3, owner: OWNER, units: [{ kind: "grunt" as EnemyKind, hp: 100, shield: 0 }], to: 0, task: "attack", x: 0, z: 0, arrived: true, live: false, ashore: 0 };
  let f = { holds: ["freed", "held"] as State["nodes"], squads: [plain], guards: [[], []], watched: [false, false], rarity: 1 as const, meter: [null, null] as Battle["meter"], threat: [false, false] };
  const frozen = JSON.stringify(f);
  for (let k = 1; k <= 60 && f.holds[0] === "freed"; k++) {
    const out = reckonApart(f, CONQUEST.tick);
    if (k === 1 && JSON.stringify(f) !== frozen) return fail("the reckoning in numbers changed its input");
    f = { ...f, holds: out.holds, squads: out.squads, meter: out.meter, threat: out.threat };
    if (out.holds[0] !== "freed") r.pure = k;
  }
  if (f.holds[0] !== rivalHold(OWNER) || r.pure !== Math.ceil(CONQUEST.capture / CONQUEST.tick) || f.squads[0].task !== "hold") return fail(`the reckoning in numbers left the node ${f.holds[0]} after ${r.pure} calls, its squad ${f.squads[0]?.task}`);

  // saves: a v26 save keeps another player's node; a v25 one reads it as the enemy's.
  const kept = parseProfile(JSON.parse(JSON.stringify(after.profile)));
  if (!kept || kept.v !== 26 || kept.poiState.relay.state !== rivalHold(OWNER)) return fail(`a v26 save loaded the relay as ${kept?.poiState.relay.state}`);
  const old = parseProfile(JSON.parse(JSON.stringify({ ...after.profile, v: 25 })));
  if (!old || old.poiState.relay.state !== "held") return fail(`a v25 save loaded the relay as ${old?.poiState.relay.state}`);
  const bad = parseProfile(JSON.parse(JSON.stringify({ ...after.profile, poiState: { ...after.profile.poiState, relay: { state: "rival:" } } })));
  if (!bad || bad.poiState.relay.state !== "held") return fail(`a save with an empty owner loaded the relay as ${bad?.poiState.relay.state}`);

  // none: a battle whose only expedition sets off after the battle has ended plays as one given none.
  const np = island(["supply", "relay"]);
  // One raid at a time: a raid's caches (the hunters' fields) serve the raid last started.
  const look = (s: State) => JSON.stringify({ nodes: s.nodes, squads: s.battle!.squads, meter: s.battle!.meter, enemies: s.enemies.map((e) => [e.id, e.pos, e.hp]), friends: s.friends.map((e) => [e.id, e.pos, e.hp]) });
  const played = (battle: BattleStart) => {
    const x = raid(np, battle, 33);
    until(x, 240, () => false);
    return look(x);
  };
  if (played({ factory: 2 }) !== played({ factory: 2, rivals: [{ owner: OWNER, target: "relay", kinds: ["grunt"], at: CONQUEST.time + 100 }] })) return fail("a battle whose expedition never sets off played otherwise than one given none");
  return { err: null, r };
}

/** The sim gate's check: null, or what went wrong. */
export function checkRivals(): string | null {
  return rivalsRun().err;
}

if (process.argv[1]?.endsWith("ringfall-rivals.ts")) {
  const { err, r } = rivalsRun();
  console.log(`take: the undefended relay fell to the expedition (set off at 5 s) ${r.take} s into the battle`);
  console.log(`transit: the supply depot fell to the expedition ${r.transit.t} s into the battle; ${r.transit.threats} threats and no capture at the player's quarry and relay on its way`);
  console.log(`retake: the factory's squads took the relay back in ${r.retake} s`);
  console.log(`front: strength ${r.strength.level[0]} with ${r.strength.at} nodes the enemy's, ${r.strength.level[1]} with one of them another player's`);
  console.log(`night: the waterworks fell in ${r.nights[0]} of 400 nights with another player's nodes its foes, ${r.nights[1]} with the enemy's`);
  console.log(`pure: the reckoning in numbers took the node on call ${r.pure}`);
  console.log(err ?? "rivals ok");
}
