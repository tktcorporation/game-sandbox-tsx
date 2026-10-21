/**
 * Gate 2 for RINGFALL: bots of three skills play the whole run headless, starting in
 * each region in turn. Fails if any run does not finish, or if an invariant breaks (NaN,
 * a body inside a box, an enemy outside the world). Prints the tables kept in
 * docs/ringfall/balance.md, one per region.
 *
 *   npm run sim:ringfall -- [runsPerSkillAndRegion] [region]
 *
 * After the tables, the hideout's pacing replays them through the meta, and the island campaign
 * plays a month per skill on one profile with the network carried (scripts/ringfall-campaign.ts).
 *
 * With a region id after the count, only that region's table is played. The tables' raids
 * are played in one worker process per core; RINGFALL_SIM_JOBS sets how many (1 plays them
 * in this process, in turn).
 */
import { NETWORK, RELAY as MAST, ALLY, BAG, DEPOT, ELITE, HOME, ENEMIES, HEALS, NOISE, PACK, PARTY, PLATE, PLAYER, RAIDERS, REINFORCE, SEARCH, SHIP_WAVES, SIGHT, STAGGER, TACTICAL, TICK, VALUABLES, VAULT, WEAPONS, WORLD } from "../src/ringfall/sim/config";
import { engageSquad, makeNoise } from "../src/ringfall/sim/awareness";
import { spawnEnemy } from "../src/ringfall/sim/enemies";
import { COVERS } from "../src/ringfall/sim/cover";
import { ENEMIES as KINDS, type EnemyKind, type Rarity } from "../src/ringfall/sim/config";
import { RELAYS, relayIndex, type RelayId, BOXES, CAMP, DECKS, DEPOTS, depotIndex, ENTRIES, entryOf, EXTRA_BINS, EXTRACTS, inCamp, PACKS, PARTY_STOPS, POIS, poiIndex, poiRegion, REGIONS, regionHere, regionOf, ROAMERS, ROUTES, STOPS, type PoiId, type RegionId, type RouteId, type Squad } from "../src/ringfall/sim/map";
import { campSpotAt, newCamp, outOfCamp, stepCamp, walkOut } from "../src/ringfall/sim/camp";
import { inArea } from "../src/ringfall/sim/areas";
import { routeBefore, useRoutes, worldKey } from "../src/ringfall/sim/routes";
import { findPath } from "../src/ringfall/sim/nav";
import { fieldTo, fieldsBuilt, onMainGround, routeLength } from "../src/ringfall/sim/hunt";
import { collide, dist2d, groundAt, inWorld, los, solidAt } from "../src/ringfall/sim/geom";
import { checkTerrainIndex, floorLevel, highGround, landAt, LEVEL, offLowGround, offshore, steepAt, surfaceAt, terrainHeight } from "../src/ringfall/sim/terrain";
import { SKILLS } from "../src/ringfall/sim/bot";
import { callLeft, cellOf, decodeSeen, encodeSeen, freeKit, idleInput, newRun, type Enemy, type GameEvent, type State } from "../src/ringfall/sim/state";
import { step } from "../src/ringfall/sim/step";
import { hurtPlayer } from "../src/ringfall/sim/player";
import { hurtAlly, placeAlly } from "../src/ringfall/sim/ally";
import { haulValue, rank } from "../src/ringfall/sim/results";
import { SHIP_SQUAD, bagLoad, bagUsed, canOpen, makeRoom, toolIn, useTarget } from "../src/ringfall/sim/world";
import { bodyCenter, damageEnemy, eyePos, fireRay, magSize, weakPoint } from "../src/ringfall/sim/combat";
import { lookAngles } from "../src/ringfall/sim/geom";
import { forward } from "../src/ringfall/sim/state";
import { build, buildState, buy, canBuild, deliver, depotAllowance, depotBudget, emptyLoadout, fitsStart, healRoom, itemCost, FIRST_ENTRY, loadoutCost, newProfile, parseProfile, pouch, price, sell, sellPrice, settle, takeKit, wares, type Item, type Profile } from "../src/ringfall/meta/profile";
import { emptyHideout, maxLevel, MODULES, poisWith, sources, stashCap } from "../src/ringfall/meta/hideout";
import { boostFor, boosted } from "../src/ringfall/sim/state";
import { HIDEOUT, ISLAND, TOOL_KINDS, TOOLS, VAULT } from "../src/ringfall/sim/config";
import { advanceDay, daysLeft, FORECAST_DAYS, holds, islandNotes, netGain, newIsland, noteText, retakeIn, riseIn, thinTomorrow, type RaidDay } from "../src/ringfall/meta/island";
import { activePacks } from "../src/ringfall/sim/island";
import { garrison, isVaultGuard } from "../src/ringfall/sim/island";
import { QUESTS, offered, raidCredit } from "../src/ringfall/meta/quests";
import { contractDone, makeBoard, targetKey, type Contract } from "../src/ringfall/meta/contracts";
import { currentStory, STORIES } from "../src/ringfall/meta/story";
import { RECORD_SPOTS } from "../src/ringfall/sim/map";
import { kill } from "../src/ringfall/sim/combat";
import { squadKey } from "../src/ringfall/sim/state";
import { nextLevel, unmet } from "../src/ringfall/meta/hideout";
import { take, takenContract } from "../src/ringfall/meta/profile";
import { META } from "../src/ringfall/sim/config";
import { fireRange, sense } from "../src/ringfall/sim/awareness";
import { AWARE, CREW, DEBRIS, RETAKE, STORM } from "../src/ringfall/sim/config";
import { DEBRIS_SPOTS } from "../src/ringfall/sim/map";
import { crewKey, debrisBin } from "../src/ringfall/sim/state";
import { nextSeed } from "../src/ringfall/meta/profile";
import { raidDay, unfreeable } from "../src/ringfall/meta/island";
import { pacing, type Pool } from "./ringfall-pacing";
import { campaignLines, campaigns, DAYS } from "./ringfall-campaign";
import { playTable, summarize, type RaidResult, type TableResult } from "./ringfall-table";
import type { RaidJob } from "./ringfall-table-worker";
import { fork, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";

const runs = Number(process.argv[2] ?? 12);
const only = process.argv[3];
/**
 * The tables (region × skill) are independent and each raid is fixed by its seed, so with
 * more than one job their raids are played in worker processes, started here so they run
 * while the checks below do. Raids rather than whole tables go to the workers: a table of
 * long raids would otherwise keep one worker busy long after the others ran out of work.
 * The results are printed in table order, the same as when played in turn.
 */
const jobs = Math.max(1, Number(process.env.RINGFALL_SIM_JOBS ?? availableParallelism()) || 1);
const TABLES = REGIONS.filter((r) => !only || r.id === only).flatMap((r) => SKILLS.map((k) => ({ region: r.id, skill: k.name })));
const tableIndex = (region: RegionId, skill: string) => TABLES.findIndex((t) => t.region === region && t.skill === skill);
const tables: (() => Promise<TableResult>)[] = jobs === 1 ? TABLES.map((t) => async () => playTable(t.region, t.skill, runs)) : playInWorkers(Math.min(jobs, TABLES.length * runs));

function playInWorkers(n: number): (() => Promise<TableResult>)[] {
  const raids = TABLES.map(() => Array.from({ length: runs }, () => Promise.withResolvers<RaidResult>()));
  // The longest raids first, so the last to finish are short ones and no worker is left
  // playing alone at the end: the reservoir's raids (the first region's) before the harbor's,
  // raid by raid across each region's tables.
  const queue: RaidJob[] = [];
  for (const region of new Set(TABLES.map((t) => t.region)))
    for (let r = 0; r < runs; r++) TABLES.forEach((t, i) => t.region === region && queue.push({ i, r, region: t.region, skill: t.skill }));
  let next = 0;
  const workers: ChildProcess[] = [];
  // A worker only notices the gate has gone once its raid is played, which takes a minute;
  // a gate that exits early (a failed check) stops them now.
  process.on("exit", () => {
    for (const w of workers) w.kill();
  });
  // A worker that dies with raids unplayed fails the gate at once: its raids would never come.
  const crash = (why: string) => {
    console.error(`sim worker failed: ${why}`);
    process.exit(1);
  };
  for (let k = 0; k < n; k++) {
    const w = fork(fileURLToPath(new URL("./ringfall-table-worker.ts", import.meta.url)), { serialization: "advanced" });
    workers.push(w);
    let playing: RaidJob | null = null;
    const give = () => {
      if (next < queue.length) w.send((playing = queue[next++]) satisfies RaidJob);
      else w.disconnect();
    };
    w.on("message", (m: { i: number; r: number; result: RaidResult }) => {
      raids[m.i][m.r].resolve(m.result);
      playing = null;
      give();
    });
    w.on("error", (err) => crash(String(err)));
    w.on("exit", (code, signal) => {
      if (playing) crash(`it exited (${signal ?? `code ${code}`}) while playing ${playing.region} ${playing.skill}#${playing.r}`);
    });
    give();
  }
  return TABLES.map((t, i) => async () => summarize(t.region, t.skill, await Promise.all(raids[i].map((d) => d.promise))));
}

/** The POIs' places in `POIS`, for scenarios that set up a run's state by hand. */
const SUPPLY = poiIndex("supply");
const QUARRY = poiIndex("quarry");
const RELAY = poiIndex("relay");
const PAD = poiIndex("pad");

/** Static layout check: every authored point must be standable, not inside a wall. */
function checkLayout(): string[] {
  const bad: string[] = [];
  // Without a height a point stands on the walkable floor of its area.
  const point = (what: string, x: number, z: number, y = floorLevel(x, z)) => {
    const g = groundAt(x, z, 0.3, y + 0.3);
    if (Math.abs(g - y) > 0.3) bad.push(`${what} at ${x},${z} expects floor ${y}, finds ${g.toFixed(2)}`);
    for (const h of [0.3, 1.0, 1.6]) if (solidAt(x, g + h, z)) bad.push(`${what} at ${x},${z} is inside a box (height ${h})`);
  };
  // Robots stand exactly where they are placed (walkers), and patrols run over open ground.
  const squad = (what: string, sq: Squad) => {
    for (const m of sq.members) if (m.kind !== "drone") point(`${what} ${m.kind}`, m.x, m.z, m.y);
    for (const w of sq.patrol ?? []) if (sq.members.some((m) => m.kind !== "drone")) point(`${what} patrol`, w.x, w.z);
  };
  POIS.forEach((p, i) => {
    point(`POI ${i} entry`, p.entry.x, p.entry.z);
    p.bins.forEach((b) => point(`POI ${i} bin`, b.x, b.z, b.y));
    p.floor.forEach((f) => point(`POI ${i} floor loot`, f.x, f.z, f.y));
    p.squads.forEach((sq) => squad(`POI ${i} ${sq.name}`, sq));
    if (p.carePackage) point(`POI ${i} care package`, p.carePackage.x, p.carePackage.z);
  });
  EXTRA_BINS.forEach((b) => point("extra bin", b.x, b.z, b.y));
  for (const r of RECORD_SPOTS) {
    point(`record ${r.id} (${r.place})`, r.x, r.z, r.y);
    if (regionHere(r).id !== r.region) bad.push(`record ${r.id} stands in ${regionHere(r).id}, not ${r.region}`);
  }
  for (const e of ENTRIES) point(`entry ${e.id}`, e.x, e.z);
  for (const d of DEPOTS) {
    point(`depot ${d.poi}`, d.x, d.z, d.y);
    // A raid started there begins `DEPOT.back` behind it.
    point(`depot ${d.poi} start`, +(d.x - Math.sin(d.yaw) * DEPOT.back).toFixed(2), +(d.z + Math.cos(d.yaw) * DEPOT.back).toFixed(2), d.y);
  }
  ROAMERS.forEach((sq) => squad(`roamer ${sq.name}`, sq));
  // A relay mast stands on open ground of its region, clear of every box and every POI, with its guards at its foot.
  for (const r of RELAYS) {
    point(`relay mast ${r.id}`, r.x, r.z);
    squad(`relay ${r.id}`, r.guards);
    if (!onMainGround(r.x, r.z) || steepAt(r.x, r.z)) bad.push(`relay mast ${r.id} is off the walkable ground`);
    for (const poi of POIS) if (Math.hypot(poi.x - r.x, poi.z - r.z) < poi.trigger + 20) bad.push(`relay mast ${r.id} stands on ${poi.name}'s ground`);
    for (let dx = -MAST.radius - 1; dx <= MAST.radius + 1; dx += 0.5)
      for (let dz = -MAST.radius - 1; dz <= MAST.radius + 1; dz += 0.5)
        for (const h of [0.3, 2, 6, 12]) if (solidAt(r.x + dx, terrainHeight(r.x + dx, r.z + dz) + h, r.z + dz)) bad.push(`relay mast ${r.id} meets a box at ${dx},${dz} height ${h}`);
  }
  // Hunting parties stand at their stops on the ground their field covers; drone packs fly their
  // loops over the land, never across a POI's own ground.
  for (const r of REGIONS)
    for (const q of PARTY_STOPS[r.id]) {
      point(`party stop ${q.name}`, q.x, q.z);
      if (!onMainGround(q.x, q.z) || regionHere(q).id !== r.id) bad.push(`party stop ${q.name} is off the walkable ground or nearer another region's POIs`);
    }
  for (const sq of PACKS) {
    const loop = sq.patrol ?? [];
    if (loop.length < 2 || sq.members.some((m) => m.kind !== "drone")) bad.push(`pack ${sq.name}: not a loop of drones`);
    loop.forEach((a, i) => {
      const b = loop[(i + 1) % loop.length];
      if (!inWorld(a.x, a.z, 5) || offshore(a.x, a.z) > -5) bad.push(`pack ${sq.name} waypoint ${a.x},${a.z} is off the land`);
      for (const poi of POIS) {
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const t = Math.max(0, Math.min(1, ((poi.x - a.x) * dx + (poi.z - a.z) * dz) / (dx * dx + dz * dz || 1)));
        if (Math.hypot(a.x + dx * t - poi.x, a.z + dz * t - poi.z) < poi.trigger) bad.push(`pack ${sq.name} flies over ${poi.name} between ${a.x},${a.z} and ${b.x},${b.z}`);
      }
    });
  }
  // An extract is used standing on whatever is highest there (the pad, a rock top), as the game checks it.
  for (const x of EXTRACTS) point(`extract ${x.id}`, x.x, x.z, groundAt(x.x, x.z, 0.4, 99));
  // The camp: where the player wakes, the gate from both sides, and somewhere to stand in reach of each station and the truck.
  point("camp wake", CAMP.wake.x, CAMP.wake.z, CAMP.y);
  const gx = (CAMP.gate.x0 + CAMP.gate.x1) / 2;
  point("camp gate inside", gx, CAMP.gate.z + 2, CAMP.y);
  point("camp gate outside", gx, CAMP.gate.z - 3, terrainHeight(gx, CAMP.gate.z - 3));
  for (const c of CAMP.spots) {
    let found = false;
    for (let a = 0; a < Math.PI * 2 && !found; a += Math.PI / 16)
      for (const d of [c.reach - 0.3, c.reach - 0.8]) {
        const x = c.x + Math.sin(a) * d;
        const z = c.z + Math.cos(a) * d;
        const g = groundAt(x, z, 0.4, CAMP.y + 0.3);
        if (Math.abs(g - CAMP.y) < 0.05 && !collide({ x, y: g, z }, 0.45) && campSpotAt({ x, z })?.id === c.id) found = true;
      }
    if (!found) bad.push(`camp ${c.id}: no place to stand in its reach`);
  }
  return bad;
}

const layout = checkLayout();
if (layout.length) {
  console.error(layout.join("\n"));
  process.exit(1);
}
console.log(`layout ok: ${BOXES.length} boxes`);

/** A wipe clears everything in the air; a projectile still in flight must not follow the player to the entry. */
function checkWipeClearsAir(): string | null {
  const s = newRun(5);
  s.enemies = [];
  // No teammate to pick the player up.
  s.ally.active = false;
  const p = s.player;
  // The landing pad, kept open for the titan, with nothing between the player and the projectiles.
  const x = POIS[PAD].x;
  const z = POIS[PAD].z;
  const g = terrainHeight(x, z);
  p.pos = { x, y: g, z };
  p.onGround = true;
  p.hp = 1;
  p.shield = 0;
  p.selfRevive = 0;
  s.orbs.push({ id: 900, pos: { x, y: g + 1.1, z: z + 0.3 }, vel: { x: 0, y: 0, z: -1 }, r: 0.4, dmg: 10, life: 5, homing: false });
  s.orbs.push({ id: 901, pos: { x, y: g + 3, z: z + 20 }, vel: { x: 0, y: 0, z: -5 }, r: 0.4, dmg: 10, life: 5, homing: true });
  s.waves.push({ x, z: z + 30, y: g, r: 3, hit: false });
  step(s, idleInput(), false);
  if (s.stats.wipes !== 1) return `wipe scenario: expected a wipe, got ${s.stats.wipes}`;
  if (s.orbs.length || s.waves.length) return `wipe scenario: ${s.orbs.length} orbs and ${s.waves.length} shockwaves survived the wipe`;
  return null;
}
/** The arc finishing the titan also takes its squad's drones; none of them may be killed twice. */
function checkArcOnTitan(): string | null {
  const s = newRun(5);
  s.phase = "play";
  const boss = s.enemies.filter((e) => e.poi === PAD);
  s.enemies = boss;
  const p = s.player;
  const pad = POIS[PAD];
  const g = terrainHeight(pad.x, pad.z);
  p.pos = { x: pad.x, y: g, z: pad.z + 6 };
  p.onGround = true;
  p.yaw = 0; // facing north, at the titan
  const titan = boss.find((e) => e.kind === "titan")!;
  titan.hp = 1;
  titan.shield = 0;
  // Its drones stand behind it, so the arc reaches the titan first.
  boss.filter((e) => e.kind === "drone").forEach((d, i) => {
    d.pos = { x: pad.x + (i ? 3 : -3), y: g + 3.4, z: pad.z - 18 };
    d.hp = 10; // low enough that a second hit from the arc would kill it again
    d.shield = 0;
  });
  const inp = idleInput();
  inp.tactical = true;
  step(s, inp, false);
  const kills = s.events.filter((e): e is Extract<GameEvent, { t: "kill" }> => e.t === "kill").map((e) => e.id);
  if (new Set(kills).size !== kills.length || s.stats.kills !== boss.length) return `arc scenario: kills ${JSON.stringify(kills)}, stats ${s.stats.kills} of ${boss.length}`;
  return null;
}
/** A kill with a gold weapon leaves its magazine full, the round that killed included. */
function checkGoldReload(): string | null {
  const s = newRun(5);
  s.phase = "play";
  const p = s.player;
  const pad = POIS[PAD];
  const g = terrainHeight(pad.x, pad.z);
  p.pos = { x: pad.x, y: g, z: pad.z + 6 };
  p.onGround = true;
  p.yaw = 0;
  p.pitch = 0;
  const target = s.enemies.find((e) => e.kind === "drone" && e.poi === PAD)!;
  s.enemies = [target];
  target.pos = { x: pad.x, y: g + 1.6, z: pad.z - 4 };
  target.hp = 1;
  target.shield = 0;
  const w = { kind: "lance" as const, rarity: 3 as const, mag: 4 };
  p.weapons = [w, null];
  p.slot = 0;
  const inp = idleInput();
  inp.fire = true;
  step(s, inp, false);
  if (s.stats.kills !== 1) return `gold reload scenario: expected a kill, got ${s.stats.kills}`;
  if (w.mag !== magSize(w)) return `gold reload scenario: magazine ${w.mag} of ${magSize(w)} after a kill`;
  return null;
}
/** The arc deals its damage as it is: facing bonuses (ambush, back) belong to weapon hits. */
function checkArcIgnoresFacing(): string | null {
  const s = newRun(5);
  s.phase = "play";
  const p = s.player;
  const pad = POIS[PAD];
  const g = terrainHeight(pad.x, pad.z);
  p.pos = { x: pad.x, y: g, z: pad.z + 6 };
  p.onGround = true;
  p.yaw = 0;
  const grunt = s.enemies.find((e) => e.kind === "grunt")!;
  s.enemies = [grunt];
  grunt.pos = { x: pad.x, y: g, z: pad.z - 4 };
  grunt.aware = "idle";
  const before = grunt.hp + grunt.shield;
  const inp = idleInput();
  inp.tactical = true;
  step(s, inp, false);
  const dealt = before - (grunt.hp + grunt.shield);
  if (Math.abs(dealt - TACTICAL.dmg) > 1e-6) return `arc facing scenario: an arc on an unaware grunt dealt ${dealt}, expected ${TACTICAL.dmg}`;
  return null;
}
/** A wipe ends the raid: nothing is carried out and it scores nothing. */
function checkDeathEndsRaid(): string | null {
  const s = padRun();
  const p = s.player;
  p.haul = ["core", "board"];
  p.hp = 1;
  p.shield = 0;
  p.selfRevive = 0;
  hurtAlly(s, 999);
  hurtPlayer(s, 10, p.pos.x, p.pos.z);
  const r = rank(s);
  if (s.phase !== "done" || s.outcome !== "dead" || r.score !== 0) return `death scenario: phase ${s.phase}, outcome ${s.outcome}, score ${r.score}`;
  return null;
}
/** Bleeding out while holding fire and jump ends the raid with nothing after "done" in that tick. */
function checkBleedoutWipe(): string | null {
  const s = padRun();
  const p = s.player;
  hurtAlly(s, 999);
  p.downed = TICK;
  p.awaitAlly = true;
  const press = idleInput();
  press.fire = true;
  press.jump = true;
  step(s, press, false);
  const end = s.events.findIndex((e) => e.t === "done");
  if (end < 0 || end !== s.events.length - 1 || s.outcome !== "dead") return `bleedout scenario: events ${s.events.map((e) => e.t).join(",")}`;
  return null;
}
/** Reinforcements beam in out of sight, at a distance, and come looking for the player. */
function checkReinforce(): string | null {
  const s = newRun(5);
  s.phase = "play";
  const p = s.player;
  const at = POIS[QUARRY].entry;
  p.pos = { x: at.x, y: groundAt(at.x, at.z, 0.4, 20), z: at.z };
  p.onGround = true;
  s.reinforceT = TICK;
  const before = s.enemies.length;
  step(s, idleInput(), false);
  const fresh = s.enemies.slice(before);
  const ev = s.events.find((e) => e.t === "reinforce");
  if (!ev || !fresh.length) return `reinforce scenario: ${fresh.length} robots, event ${!!ev}`;
  const eye = { x: p.pos.x, y: p.pos.y + 1.5, z: p.pos.z };
  const seen = fresh.filter((e) => los(eye, { x: e.pos.x, y: e.pos.y + ENEMIES[e.kind].bodyY, z: e.pos.z }));
  if (seen.length) return `reinforce scenario: ${seen.map((e) => e.kind).join(",")} beamed in where the player can see`;
  // Distances are walks along the ground (round cliffs, up ramps), as the squad goes.
  const walk = (e: { pos: { x: number; z: number } }) => routeLength(fieldTo(p.pos.x, p.pos.z)!, e.pos.x, e.pos.z);
  const d = walk(fresh[0]);
  if (d < REINFORCE.dist[0] - 5 || d > REINFORCE.dist[1] + 5 || fresh.some((e) => e.aware !== "alert" || !e.goal)) return `reinforce scenario: ${d.toFixed(0)} m away, not hunting`;
  // They keep closing in while the player moves on, instead of giving up at the first guess.
  p.iframes = 999;
  p.pos.x += 8;
  ticks(s, 30);
  const left = s.enemies.filter((e) => fresh.includes(e));
  const closest = Math.min(...left.map(walk));
  if (!(closest < d - 20)) return `reinforce scenario: still ${closest.toFixed(0)} m away after 30 s (spawned ${d.toFixed(0)} m away)`;
  return null;
}
/** Hunting two targets at once (the player and the teammate) builds each field once, not every tick. */
function checkFieldsReused(): string | null {
  const before = fieldsBuilt;
  for (let t = 0; t < 120; t++) {
    fieldTo(...inArea("supply", 0, -170));
    fieldTo(...inArea("supply", -12, -148));
  }
  const built = fieldsBuilt - before;
  return built > 2 ? `field cache scenario: ${built} fields built for 2 targets` : null;
}
/** A target running across the lakebed costs a field every few metres, not one per 2 m cell it enters. */
function checkFieldsFollowRunner(): string | null {
  const before = fieldsBuilt;
  for (let t = 0; t <= 40 * 60; t++) fieldTo(...inArea("heart", -20 + t * (40 / (40 * 60)), -15));
  const built = fieldsBuilt - before;
  return built > 8 ? `field cache scenario: ${built} fields built for a target running 40 m` : null;
}
/**
 * Hunting parties: a raid starts with `PARTY.count` in each region, each out of the player's sight
 * (or past `PARTY.seen`) and `PARTY.away` from them, at stops no other party has; every stop of a region is a walk from
 * every other; left alone, each walks from stop to stop and lingers at each, never held up on the
 * way; and one wiped out is replaced after `PARTY.respawn` seconds, beamed in by the same rule.
 */
function checkParties(): string | null {
  const hidden = (s: State, members: Enemy[]) => {
    const p = s.player.pos;
    const eye = { x: p.x, y: p.y + 1.5, z: p.z };
    return members.every((e) => dist2d(e.pos, p) >= PARTY.away - 4 && (dist2d(e.pos, p) > PARTY.seen || !los(eye, { x: e.pos.x, y: e.pos.y + KINDS[e.kind].bodyY, z: e.pos.z })));
  };
  const members = (s: State, squad: number) => s.enemies.filter((e) => e.squad === squad);
  for (const e of ENTRIES)
    for (const seed of [11, 222]) {
      const s = newRun(seed, freeKit(), e.region, { entry: e.id });
      for (const r of REGIONS) {
        const mine = s.parties.filter((q) => q.region === r.id);
        if (mine.length !== PARTY.count[r.id] || mine.some((q) => q.squad < 0)) return `party scenario: a raid at ${e.id} (seed ${seed}) started with ${mine.filter((q) => q.squad >= 0).length} parties in ${r.id}`;
        if (new Set(mine.map((q) => s.squads[q.squad].party!.stop)).size !== mine.length) return `party scenario: two parties of ${r.id} start at the same stop (seed ${seed})`;
        if (!mine.every((q) => hidden(s, members(s, q.squad)))) return `party scenario: a raid at ${e.id} (seed ${seed}) placed a party in sight or within ${PARTY.away} m`;
      }
    }
  for (const r of REGIONS)
    for (const to of PARTY_STOPS[r.id]) {
      const f = fieldTo(to.x, to.z);
      const cut = PARTY_STOPS[r.id].find((q) => !f || !Number.isFinite(routeLength(f, q.x, q.z)));
      if (cut) return `party scenario: no way on foot from ${cut.name} to ${to.name}`;
    }
  // Left alone (the player in the other region), each party goes round its stops.
  for (const seed of [3, 17])
    for (const r of REGIONS) {
      const s = newRun(seed, freeKit(), REGIONS.find((q) => q.id !== r.id)!.id);
      s.player.iframes = 1e9;
      s.reinforceT = s.raiderT = 1e9;
      s.parties = s.parties.filter((q) => q.region === r.id);
      s.enemies = s.enemies.filter((e) => s.parties.some((q) => q.squad === e.squad));
      const arrivals = new Map<number, number>();
      const at = new Map<number, number>();
      const going = new Map(s.parties.map((q) => [q.squad, s.squads[q.squad].party!.stop]));
      for (let i = 0; i < 600 / TICK; i++) {
        step(s, idleInput(), false);
        for (const q of s.parties) {
          const trip = s.squads[q.squad].party!;
          if (trip.linger > 0 && at.get(q.squad) !== trip.stop) {
            at.set(q.squad, trip.stop);
            arrivals.set(q.squad, (arrivals.get(q.squad) ?? 0) + 1);
          }
          // Making for another stop before it lingered at the one it was going to: held up on the way.
          if (trip.stop !== going.get(q.squad) && at.get(q.squad) !== going.get(q.squad)) {
            const lead = s.enemies.find((e) => e.squad === q.squad)!;
            return `party scenario: a party of ${r.id} (seed ${seed}) was held up at ${lead.pos.x.toFixed(0)},${lead.pos.z.toFixed(0)} on its way to ${PARTY_STOPS[r.id][going.get(q.squad)!].name}`;
          }
          going.set(q.squad, trip.stop);
        }
      }
      for (const q of s.parties) if ((arrivals.get(q.squad) ?? 0) < 2) return `party scenario: a party of ${r.id} (seed ${seed}) reached ${arrivals.get(q.squad) ?? 0} stops in 600 s`;
    }
  // Wiped out, a party comes back after a while, out of sight and away from the player.
  const s = newRun(5);
  s.reinforceT = s.raiderT = 1e9;
  s.player.iframes = 1e9;
  const slot = s.parties[0];
  const gone = slot.squad;
  s.enemies = s.enemies.filter((e) => e.squad !== gone);
  step(s, idleInput(), false);
  if (slot.squad !== -1 || slot.wait < PARTY.respawn[0] - 1 || slot.wait > PARTY.respawn[1]) return `party scenario: a wiped-out party left its slot at squad ${slot.squad}, ${slot.wait.toFixed(0)} s to wait`;
  ticks(s, slot.wait + 0.5);
  if (slot.squad < 0 || slot.squad === gone) return "party scenario: a wiped-out party was not replaced";
  const fresh = members(s, slot.squad);
  if (!fresh.length || !hidden(s, fresh) || !fresh.every((e) => e.mode === "spawning" || e.aware === "idle")) return "party scenario: a party's replacement beamed in where the player can see, or close by";
  return null;
}

/**
 * A drone pack notices the player from further than other drones: a pack drone `PACK.sight` - 5 m
 * off, facing the player across open ground, fights within a few seconds; a plain drone there
 * does not notice them.
 */
function checkPacks(): string | null {
  const notices = (pack: boolean) => {
    const s = padRun();
    s.ally.active = false;
    const p = s.player;
    const d = PACK.sight - 5;
    // Somewhere on the reservoir's open ground with a clear view to a drone hovering `d` m off.
    for (const [cx, cz] of [[-180, 190], [150, 170], [-60, 300], [200, 300]])
      for (let a = 0; a < 2 * Math.PI; a += Math.PI / 8) {
        const x = cx + Math.cos(a) * d;
        const z = cz + Math.sin(a) * d;
        const g = groundAt(cx, cz, 0.4, 99);
        if (steepAt(cx, cz) || g > terrainHeight(cx, cz) + 0.3) continue;
        const squad = s.squads.length;
        s.squads.push({ name: "test", poi: -1, patrol: [], leg: 0, engaged: false, roam: false, sinceSeen: 0, last: { x: 0, z: 0 }, pack, sight: pack ? PACK.sight : undefined });
        const yaw = Math.atan2(cx - x, -(cz - z));
        const e = spawnEnemy(s, "drone", x, z, -1, squad, { face: yaw });
        if (!los({ x: cx, y: g + 1.5, z: cz }, { x: e.pos.x, y: e.pos.y, z: e.pos.z }) || dist2d(e.pos, { x: cx, z: cz }) < d - 1) {
          s.enemies = [];
          s.squads.pop();
          continue;
        }
        p.pos = { x: cx, y: g, z: cz };
        p.onGround = true;
        p.iframes = 1e9;
        for (let i = 0; i < 6 / TICK; i++) {
          step(s, idleInput(), false);
          s.player.pos = { x: cx, y: g, z: cz };
          e.pos.x = x;
          e.pos.z = z;
          e.yaw = yaw;
        }
        return s.squads[squad].engaged;
      }
    return null;
  };
  const pack = notices(true);
  if (pack === null) return "pack scenario: no open ground with a view to test from";
  if (!pack) return `pack scenario: a pack drone ${PACK.sight - 5} m off did not notice the player in 6 s`;
  if (notices(false)) return `pack scenario: a plain drone noticed the player ${PACK.sight - 5} m off`;
  return null;
}

/** Places on the island a player waits in: the POI entries and the districts between them. */
const WAIT_SPOTS: [string, number, number][] = [
  ...POIS.map((p): [string, number, number] => [p.name, p.entry.x, p.entry.z]),
  ...STOPS.map((q): [string, number, number] => [q.name, q.x, q.z]),
];

/** Walking into the lakebed's walls for 10 s gets the player nowhere: a cliff is climbed by no one. */
function checkCliffsStop(): string | null {
  for (const [hx, hz, yaw] of [[-20, -20, -Math.PI / 2], [20, -30, Math.PI / 2], [0, -60, 0], [-10, 30, -Math.PI * 0.75]]) {
    const [x, z] = inArea("heart", hx, hz);
    const s = newRun(1);
    s.phase = "play";
    s.enemies = [];
    s.parties = [];
    s.reinforceT = s.raiderT = 1e9;
    const p = s.player;
    p.pos = { x, y: groundAt(x, z, 0.4, 0), z };
    p.onGround = true;
    p.yaw = yaw;
    for (let t = 0; t < 600; t++) step(s, { ...idleInput(), moveZ: 1, sprint: true }, false);
    // The lakebed's mud banks rise over its floor: what counts is that it never left the lakebed.
    if (surfaceAt(p.pos.x, p.pos.z) !== "湖底" || p.pos.y > terrainHeight(p.pos.x, p.pos.z) + 1.5) return `cliff scenario: walking from ${x},${z} climbed to ${p.pos.y.toFixed(1)} m at ${p.pos.x.toFixed(0)},${p.pos.z.toFixed(0)} (${surfaceAt(p.pos.x, p.pos.z)})`;
  }
  return null;
}
/**
 * No pit on the high ground next to walkable ground: a hollow with steep ground rising on
 * every side, which a body that drops off an edge into it can never leave.
 */
function checkNoPits(): string | null {
  const R = 1.5;
  const pits: string[] = [];
  for (let x = WORLD.x0 + 4; x < WORLD.x1 - 4; x += 1)
    for (let z = WORLD.z0 + 4; z < WORLD.z1 - 4; z += 1) {
      if (!offLowGround(x, z) || offshore(x, z) > 0) continue;
      const h = terrainHeight(x, z);
      // Higher on every side by more than a step: no way out on foot.
      let walled = true;
      for (let a = 0; a < 8 && walled; a++) {
        const n = terrainHeight(x + Math.cos((a * Math.PI) / 4) * R, z + Math.sin((a * Math.PI) / 4) * R);
        walled = n > h + WORLD.stepUp;
      }
      if (!walled) continue;
      // Only a pit something can fall into: walkable ground above it within a few metres.
      let above = false;
      for (let a = 0; a < 16 && !above; a++)
        for (const r of [3, 5, 7]) {
          const nx = x + Math.cos((a * Math.PI) / 8) * r;
          const nz = z + Math.sin((a * Math.PI) / 8) * r;
          if (!offLowGround(nx, nz) && terrainHeight(nx, nz) > h + 1) above = true;
        }
      if (above) pits.push(`${x.toFixed(0)},${z.toFixed(0)} at ${h.toFixed(1)} m`);
    }
  return pits.length ? `pit scenario: ${pits.length} pits a fall can trap a body in, e.g. ${pits.slice(0, 5).join("; ")}` : null;
}
/** Every POI, way in, way off and patrol route can be walked to from the reservoir's first way in, robots' way: no climbing, no drops. */
function checkWalkableIsland(): string | null {
  const from = entryOf(regionOf("reservoir").entries[0]);
  const f = fieldTo(from.x, from.z);
  if (!f) return "walk scenario: the first way in is not on open ground";
  const places: [string, number, number][] = [
    ...WAIT_SPOTS,
    ...ENTRIES.map((e): [string, number, number] => [e.name, e.x, e.z]),
    ...EXTRACTS.map((x): [string, number, number] => [x.id, x.x, x.z]),
    ...ROAMERS.flatMap((sq) => (sq.patrol ?? []).map((w): [string, number, number] => [sq.name, w.x, w.z])),
  ];
  const cut = places.filter(([, x, z]) => !Number.isFinite(routeLength(f, x, z)));
  return cut.length ? `walk scenario: no way on foot to ${cut.map(([n, x, z]) => `${n} (${x},${z})`).join(", ")}` : null;
}

/**
 * Wherever the player waits, reinforcements find a hidden spot a walk away, and every one of
 * their walkers reaches the fight: within a grunt's sight (`SIGHT`), in sight (its body or, over low cover, its head), or behind cover it took to fight from,
 * even after a drone found the player first.
 */
function checkReinforceEverywhere(): string | null {
  for (const [name, x, z] of WAIT_SPOTS)
    for (let seed = 1; seed <= 3; seed++) {
      const s = newRun(seed);
      s.phase = "play";
      s.raiderT = 1e9;
      // Only the reinforcements: the island's own robots would fight and shove the player off the spot.
      s.enemies = [];
      s.parties = [];
      // Where the wave lands is drawn afresh from the seed, not from what placing the island's robots left of it.
      s.rng = seed;
      const p = s.player;
      p.pos = { x, y: groundAt(x, z, 0.4, terrainHeight(x, z) + 2), z };
      p.onGround = true;
      s.reinforceT = TICK;
      const before = s.enemies.length;
      step(s, idleInput(), false);
      const walkers = s.enemies.slice(before).filter((e) => e.kind !== "drone");
      if (!walkers.length) return `reinforce everywhere: none beamed in at ${name} (seed ${seed})`;
      for (let t = 0; t < 60 * 60 && s.phase === "play"; t++) {
        p.iframes = 99;
        p.hp = PLAYER.hp;
        step(s, idleInput(), false);
      }
      const eye = { x: p.pos.x, y: p.pos.y + 1.5, z: p.pos.z };
      const out = s.enemies.filter((e) => walkers.includes(e) && !(e.aware === "engaged" && e.cover) && Math.hypot(e.pos.x - p.pos.x, e.pos.z - p.pos.z) > SIGHT.grunt.range && !los(eye, bodyCenter(e)) && !los(eye, weakPoint(e)));
      if (out.length) return `reinforce everywhere: at ${name} (seed ${seed}) ${out.map((e) => `${e.kind} ${Math.hypot(e.pos.x - p.pos.x, e.pos.z - p.pos.z).toFixed(0)} m`).join(", ")} still out of the fight after 60 s`;
    }
  return null;
}
/** Reinforcements beam in where the player cannot see any of them, a hovering drone included. */
function checkReinforceHidden(): string | null {
  for (let seed = 1; seed <= 10; seed++)
    for (const poi of POIS) {
      const s = newRun(seed);
      s.phase = "play";
      const p = s.player;
      p.pos = { x: poi.entry.x, y: groundAt(poi.entry.x, poi.entry.z, 0.4, 20), z: poi.entry.z };
      p.onGround = true;
      s.reinforceT = TICK;
      const before = s.enemies.length;
      step(s, idleInput(), false);
      const eye = { x: p.pos.x, y: p.pos.y + 1.5, z: p.pos.z };
      const seen = s.enemies.slice(before).find((e) => los(eye, { x: e.pos.x, y: e.pos.y + ENEMIES[e.kind].bodyY, z: e.pos.z }));
      if (seen) return `reinforce scenario: a ${seen.kind} beamed in in sight of ${poi.name} (seed ${seed})`;
    }
  return null;
}
/** Every bin holds a valuable, and walking over it adds its worth to the haul. */
function checkValuableBin(): string | null {
  const s = padRun();
  const p = s.player;
  s.bins = [{ id: 9001, x: p.pos.x + 1, y: p.pos.y, z: p.pos.z, poi: RELAY, open: false, flare: false, vault: false, outside: false }];
  const press = idleInput();
  press.interact = true;
  step(s, press, false);
  // Searching takes its time: not open just short of it, open (and bagged) after.
  ticks(s, SEARCH.time - 0.2);
  if (s.bins[0].open) return "search scenario: the bin opened before the search time";
  ticks(s, 3);
  if (p.haul.length !== 1 || !POIS[RELAY].loot.valuable.some(([k]) => k === p.haul[0])) return `valuable scenario: haul ${p.haul.join()}, bin open ${s.bins[0].open}`;
  return null;
}
/** Walking away from a bin breaks the search off; it starts over on the next press. */
function checkSearchBreaks(): string | null {
  const s = padRun();
  const p = s.player;
  s.bins = [{ id: 9001, x: p.pos.x + 1, y: p.pos.y, z: p.pos.z, poi: RELAY, open: false, flare: false, vault: false, outside: false }];
  const press = idleInput();
  press.interact = true;
  step(s, press, false);
  ticks(s, 1);
  p.pos.x += 6;
  ticks(s, SEARCH.time + 1);
  if (s.bins[0].open || p.search) return `search scenario: open ${s.bins[0].open}, still searching ${!!p.search} after walking away`;
  return null;
}
/** A full bag takes nothing more; with the use key, cheaper items make way for a better one. */
function checkBagSwap(): string | null {
  const s = padRun();
  const p = s.player;
  p.haul = Array.from({ length: BAG.slots }, () => "parts" as const);
  s.loot.push({ id: 9002, kind: "valuable", valuable: "core", rarity: 3, pos: { ...p.pos }, vel: { x: 0, y: 0, z: 0 }, age: 1 });
  ticks(s, 0.5);
  if (bagUsed(p.haul) > BAG.slots || p.haul.includes("core")) return `bag scenario: a full bag took the core (${p.haul.join(",")})`;
  const press = idleInput();
  press.interact = true;
  step(s, press, false);
  if (!p.haul.includes("core") || bagUsed(p.haul) > BAG.slots || haulValue(s) !== 1000 + (BAG.slots - 3) * 100) return `bag scenario: after the swap ${p.haul.join(",")}`;
  return null;
}
/** A swap throws out the cheapest set that makes room, not just the cheapest items for their size. */
function checkBagSwapCheapest(): string | null {
  const out = makeRoom(["parts", "board", "core", "core"], "core", [], 0);
  if (out?.join() !== "1") return `bag scenario: to fit a core into parts+board+core+core it drops ${out?.join() ?? "nothing"}, not the board alone`;
  return null;
}
/** The raiders beam in once the raid has gone on long enough, as a tougher elite squad. */
function checkRaiders(): string | null {
  const s = padRun();
  s.raiderT = TICK;
  const before = s.enemies.length;
  step(s, idleInput(), false);
  const fresh = s.enemies.slice(before);
  if (!s.events.some((e) => e.t === "raiders") || fresh.length !== RAIDERS.kinds.length || fresh.some((e) => !e.elite || e.hp + e.shield <= enemyMaxPlain(e.kind))) return `raider scenario: ${fresh.length} robots, elite ${fresh.map((e) => e.elite).join(",")}`;
  if (Number.isFinite(s.raiderT)) return "raider scenario: they would come again";
  return null;
}
const enemyMaxPlain = (k: keyof typeof ENEMIES) => ENEMIES[k].hp + ENEMIES[k].shield;
/** Reads the phase afresh, past the narrowing of an earlier check. */
const phaseOf = (s: State): State["phase"] => s.phase;
/** Standing in the plateau pickup leaves with a flare, and does nothing without one. */
function checkFlareExtract(): string | null {
  const s = padRun();
  const at = EXTRACTS.find((x) => x.id === "flare")!;
  const p = s.player;
  p.pos = { x: at.x, y: groundAt(at.x, at.z, 0.4, 20), z: at.z };
  ticks(s, at.hold + 2);
  if (s.phase === "done") return "flare scenario: left the island without a flare";
  p.flares = 1;
  ticks(s, at.hold + 0.2);
  if (phaseOf(s) !== "done" || s.extractedAt !== "flare" || p.flares !== 0) return `flare scenario: phase ${s.phase}, exit ${s.extractedAt}, flares ${p.flares}`;
  return null;
}
/** Standing at the dropship calls it; robots beam in while it comes, and it lands after its call time. */
function checkShipCall(): string | null {
  const s = padRun();
  const ship = EXTRACTS.find((x) => x.id === "ship")!;
  const p = s.player;
  p.pos = { x: ship.x, y: groundAt(ship.x, ship.z, 0.4, 20), z: ship.z };
  p.iframes = 999; // the waves must not end the scenario
  holdSpot(s, ship.call! - 1);
  const waves = s.enemies.filter((e) => s.squads[e.squad]?.name === SHIP_SQUAD).length;
  if (callLeft(s, "ship") <= 0 || s.phase === "done" || waves < 2) return `ship scenario: ${callLeft(s, "ship").toFixed(1)} s left, phase ${s.phase}, ${waves} robots beamed in`;
  holdSpot(s, 1 + ship.hold + 0.2);
  if (phaseOf(s) !== "done" || s.extractedAt !== "ship") return `ship scenario: did not leave after landing (${callLeft(s, "ship").toFixed(1)}, ${s.phase})`;
  return null;
}
/**
 * Standing on the harbor's quay calls the boat; robots beam in round the quay, on ground a
 * walker stands on, while it comes up the channel; it is there after its call time, and the
 * raid ends by it. Calling it calls nothing else.
 */
function checkBoatCall(): string | null {
  const s = padRun();
  // The teammate stays out of it: the robots counted are the ones the waves brought, not the ones it left standing.
  s.ally.active = false;
  const boat = EXTRACTS.find((x) => x.id === "boat")!;
  const p = s.player;
  // No teammate: it would shoot the waves down before they can be counted.
  s.ally.active = false;
  p.pos = { x: boat.x, y: groundAt(boat.x, boat.z, 0.4, 20), z: boat.z };
  p.iframes = 999;
  holdSpot(s, boat.call! - 1);
  const waves = s.enemies.filter((e) => s.squads[e.squad]?.name === SHIP_SQUAD);
  if (callLeft(s, "boat") <= 0 || callLeft(s, "ship") >= 0 || s.phase === "done" || waves.length < 2) return `boat scenario: ${callLeft(s, "boat").toFixed(1)} s left, ship ${callLeft(s, "ship")}, phase ${s.phase}, ${waves.length} robots beamed in`;
  const stranded = waves.filter((e) => ENEMIES[e.kind].fly === 0 && (highGround(e.pos.x, e.pos.z) || Math.hypot(e.pos.x - boat.x, e.pos.z - boat.z) > 40));
  if (stranded.length) return `boat scenario: robots beamed in off the quay at ${stranded.map((e) => `${e.pos.x.toFixed(0)},${e.pos.z.toFixed(0)}`).join(" ")}`;
  holdSpot(s, 1 + boat.hold + 0.2);
  if (phaseOf(s) !== "done" || s.extractedAt !== "boat") return `boat scenario: did not leave by boat (${callLeft(s, "boat").toFixed(1)}, ${s.phase})`;
  return null;
}
/**
 * Two pickups called in one raid each get their own waves: robots left at the quay from the
 * boat's call do not use up the dropship's.
 */
function checkSecondPickup(): string | null {
  const s = padRun();
  // The teammate stays out of it, as in checkBoatCall: the count is of what the waves brought.
  s.ally.active = false;
  const boat = EXTRACTS.find((x) => x.id === "boat")!;
  const ship = EXTRACTS.find((x) => x.id === "ship")!;
  const p = s.player;
  p.iframes = 999;
  // No teammate: it would shoot the waves down before they can be counted.
  s.ally.active = false;
  p.pos = { x: boat.x, y: groundAt(boat.x, boat.z, 0.4, 20), z: boat.z };
  ticks(s, boat.call! - 1);
  const left = s.enemies.filter((e) => s.squads[e.squad]?.name === SHIP_SQUAD).length;
  p.pos = { x: ship.x, y: groundAt(ship.x, ship.z, 0.4, 20), z: ship.z };
  ticks(s, ship.call! - 1);
  const at = ship.waves ?? ship;
  const there = s.enemies.filter((e) => s.squads[e.squad]?.name === SHIP_SQUAD && Math.hypot(e.pos.x - at.x, e.pos.z - at.z) < 40).length;
  if (left < 2 || there < 2) return `second pickup: ${left} robots left at the quay, ${there} beamed in at the pad`;
  return null;
}
/**
 * The ways in: a raid starts on the ground at the way in it was given, in that way's region
 * (the reservoir's first when none is given, or when the way named is another region's), with
 * the teammate beside the player; and standing still there for 15 s, no squad fights it.
 */
/**
 * The camp: walking from where the player wakes to the gate leaves it there, with no shot fired
 * whatever is pressed; a raid begun where the player walked out has no fight in its first
 * seconds, and stepping straight back in does not end it. Back in the yard after time away,
 * the raid ends alive with the bag, settled as an extraction, but not while a robot fights the
 * player within `DEPOT.safe`. A robot set on a player in the yard from outside never walks in.
 */
function checkCamp(): string | null {
  const camp = newCamp(5);
  const p = camp.player;
  if (!inCamp(p.pos) || !camp.ally.active || camp.enemies.length || dist2d(camp.ally.pos, p.pos) > 4) return `camp: wakes at ${p.pos.x.toFixed(1)},${p.pos.z.toFixed(1)} with ${camp.enemies.length} robots, teammate ${camp.ally.active}`;
  const gate = { x: (CAMP.gate.x0 + CAMP.gate.x1) / 2, z: CAMP.gate.z - 6 };
  let left = -1;
  for (let i = 0; i < 40 / TICK && left < 0; i++) {
    const inp = { ...idleInput(), moveZ: 1, fire: true, ads: true, tactical: true, ult: true };
    // Turn toward the middle of the yard first, then out through the gate.
    const to = p.pos.z > CAMP.gate.z + 4 && Math.abs(p.pos.x - gate.x) > 1 ? { x: gate.x, z: CAMP.gate.z + 3 } : gate;
    p.yaw = Math.atan2(to.x - p.pos.x, -(to.z - p.pos.z));
    stepCamp(camp, inp, false);
    if (outOfCamp(camp)) left = i;
  }
  if (left < 0) return `camp: walking to the gate never left the yard (stuck at ${p.pos.x.toFixed(1)},${p.pos.z.toFixed(1)})`;
  if (p.pos.x < CAMP.gate.x0 || p.pos.x > CAMP.gate.x1) return `camp: left the yard at ${p.pos.x.toFixed(1)},${p.pos.z.toFixed(1)}, not through the gate`;
  if (camp.stats.shots > 0 || camp.time !== 0) return `camp: ${camp.stats.shots} shots fired, the clock at ${camp.time}`;
  const inside = { x: gate.x, y: CAMP.y, z: CAMP.gate.z + 5 };
  const stand = (s: State) => {
    s.player.pos = { ...inside };
    s.player.vel = { x: 0, y: 0, z: 0 };
    s.player.onGround = true;
  };
  for (const seed of [11, 777]) {
    const s = newRun(seed, freeKit(), "reservoir", { entry: FIRST_ENTRY });
    walkOut(s, camp);
    if (dist2d(s.player.pos, p.pos) > 0.01 || dist2d(s.ally.pos, camp.ally.pos) > 0.01 || !s.ally.active) return "camp: walking out did not carry the player and the teammate over where they stood";
    // A step back through the gate at once is not a return.
    const back = structuredClone(s);
    ticks(back, 1);
    stand(back);
    ticks(back, 2);
    if (back.phase !== "play") return `camp: stepping back into the yard a second after walking out ended the raid (${back.outcome})`;
    ticks(s, 15);
    if (s.squads.some((sq) => sq.engaged) || s.player.hp < PLAYER.hp) return `camp: a raid walked out of the gate (seed ${seed}) was in a fight within 15 s`;
    // Back in with a full bag and no fight: home alive, the bag kept.
    s.player.haul = ["board", "parts"];
    stand(s);
    ticks(s, 0.5);
    if (s.phase !== "done" || s.outcome !== "extracted" || !s.home || s.player.haul.length !== 2) return `camp: walking back into the yard left phase ${s.phase}, outcome ${s.outcome}, home ${s.home}`;
    const settled = settle(newProfile(), s);
    if (settled.profile.extracted !== 1 || settled.home.filter((i) => i.t === "valuable").length !== 2) return `camp: a raid ended in the yard settled ${settled.profile.extracted} extractions and ${settled.home.length} items home`;
  }
  // Back in the yard with a grunt fighting the player close by: the raid goes on until it is gone.
  const f = newRun(3, freeKit(), "reservoir", { entry: FIRST_ENTRY });
  f.ally.active = false;
  f.away = HOME.away;
  stand(f);
  const squad = f.squads.length;
  f.squads.push({ name: "test", poi: -1, patrol: [], leg: 0, engaged: false, roam: false, sinceSeen: 0, last: { x: inside.x, z: inside.z } });
  const g = spawnEnemy(f, "grunt", inside.x, CAMP.gate.z - 25, -1, squad, { face: Math.PI });
  engageSquad(f, squad, g);
  for (let i = 0; i < 6 / TICK && f.phase === "play"; i++) {
    step(f, idleInput(), false);
    stand(f);
    f.player.hp = PLAYER.hp;
    if (inCamp(g.pos)) return `camp: a grunt walked into the yard (${g.pos.x.toFixed(1)},${g.pos.z.toFixed(1)})`;
  }
  if (f.phase !== "play" || f.home) return `camp: back in the yard with a grunt fighting ${dist2d(g.pos, inside).toFixed(0)} m off, the raid ended (${f.outcome})`;
  f.enemies = [];
  ticks(f, 0.5);
  if (f.phase !== "done" || !f.home) return "camp: back in the yard with the fight over, the raid did not end";
  return null;
}

function checkEntries(): string | null {
  const dflt = newRun(3);
  const first = entryOf(regionOf("reservoir").entries[0]);
  if (dflt.region !== "reservoir" || dist2d(dflt.player.pos, first) > 1) return "entry scenario: a raid with no region given did not start at the reservoir's first way in";
  const other = newRun(3, freeKit(), "reservoir", { entry: regionOf("harbor").entries[1] });
  if (other.region !== "reservoir" || dist2d(other.player.pos, first) > 1) return "entry scenario: a reservoir raid given a harbor way in did not start at the reservoir's first";
  for (const e of ENTRIES) {
    if (!regionOf(e.region).entries.includes(e.id) || regionHere(e).id !== e.region) return `entry scenario: ${e.id} is not in its region's list or lies nearer another region's POIs`;
    for (const seed of [11, 222, 777, 4242]) {
      const s = newRun(seed, freeKit(), e.region, { entry: e.id });
      const p = s.player;
      if (s.region !== e.region || s.phase !== "play" || !p.onGround || dist2d(p.pos, e) > 1 || Math.abs(p.pos.y - terrainHeight(e.x, e.z)) > 0.5 || !s.ally.active || dist2d(s.ally.pos, p.pos) > 4)
        return `entry scenario: a raid at ${e.id} starts at ${p.pos.x.toFixed(1)},${p.pos.y.toFixed(1)},${p.pos.z.toFixed(1)}, teammate ${s.ally.active ? dist2d(s.ally.pos, p.pos).toFixed(1) : "inactive"}`;
      ticks(s, 15);
      if (s.squads.some((sq) => sq.engaged) || s.player.hp < PLAYER.hp) return `entry scenario: a raid started at ${e.id} (seed ${seed}) was in a fight within 15 s`;
    }
  }
  return null;
}
/**
 * The ways in are learned by walking to them: a fresh profile knows only the reservoir's first;
 * a raid marks the start's own way in and each one walked to on its ground (once, with an event),
 * but not one passed high above it; a raid that gets off alive teaches what it walked to, a wipe
 * forgets it; a start at a depot has walked to none; and a save from before ways in were learned
 * knows them all, while a save's start is moved to one it may choose.
 */
function checkKnownEntries(): string | null {
  const fresh = newProfile();
  if (FIRST_ENTRY !== "beach" || fresh.v !== 16 || fresh.entries.join() !== "beach") return `known entries: a fresh profile knows ${fresh.entries.join()}`;
  const far = entryOf("checkpoint");
  const at = (s: State, dx: number, lift: number) => {
    const x = far.x + dx;
    s.player.pos = { x, y: groundAt(x, far.z, PLAYER.radius, 99) + lift, z: far.z };
    s.player.vel = { x: 0, y: 0, z: 0 };
  };
  const s = newRun(5, freeKit(), "reservoir", { entry: "beach" });
  if (s.found.join() !== "beach") return `known entries: a raid from the beach starts having walked to ${s.found.join()}`;
  const high = newRun(5, freeKit(), "reservoir", { entry: "beach" });
  at(high, 4, 20);
  step(high, idleInput(), false);
  if (high.found.includes("checkpoint")) return "known entries: passing 20 m above a way in found it";
  at(s, 12, 0);
  step(s, idleInput(), false);
  if (s.found.includes("checkpoint")) return "known entries: a way in 12 m off was found";
  at(s, 6, 0);
  step(s, idleInput(), false);
  if (s.found.join() !== "beach,checkpoint" || !s.events.some((e) => e.t === "entryFound" && e.id === "checkpoint")) return `known entries: walking to the checkpoint left found ${s.found.join()}`;
  step(s, idleInput(), false);
  if (s.events.some((e) => e.t === "entryFound")) return "known entries: a way in already found was found again";
  s.outcome = "extracted";
  const won = settle(fresh, s);
  if (won.profile.entries.join() !== "beach,checkpoint" || won.learned.join() !== "checkpoint") return `known entries: getting off alive left ${won.profile.entries.join()}, learned ${won.learned.join()}`;
  if (settle(won.profile, s).learned.length) return "known entries: a way in already known was learned again";
  s.outcome = "dead";
  const lost = settle(fresh, s);
  if (lost.profile.entries.join() !== "beach" || lost.learned.length) return `known entries: a wipe kept ${lost.profile.entries.join()}`;
  const fromDepot = newRun(5, freeKit(), "reservoir", { depots: ["supply"], from: "supply" });
  if (fromDepot.found.length) return `known entries: a start at a depot had walked to ${fromDepot.found.join()}`;
  const save = (p: object) => parseProfile(JSON.parse(JSON.stringify(p)));
  if (save(won.profile)?.entries.join() !== "beach,checkpoint") return "known entries: the known ways in do not survive a save";
  const v10 = save({ ...fresh, v: 10, entries: undefined, region: "harbor", entry: "quay" });
  if (v10?.v !== 16 || v10.entries.length !== ENTRIES.length || v10.region !== "harbor" || v10.entry !== "quay") return `known entries: a v10 save loaded as ${JSON.stringify(v10 && { v: v10.v, entries: v10.entries, region: v10.region, entry: v10.entry })}`;
  // A harbor start with no harbor way in known moves to the reservoir; with a harbor depot on it stays.
  const shut = save({ ...fresh, region: "harbor", entry: "quay", entries: ["beach", "nowhere"] });
  if (shut?.region !== "reservoir" || shut.entry !== "beach" || shut.entries.join() !== "beach") return `known entries: a harbor start with no harbor way in loaded as ${shut?.region} / ${shut?.entry}`;
  const depot = save({ ...fresh, region: "harbor", entry: "jetty", entries: ["jetty"], depots: ["wreck"] });
  if (depot?.region !== "harbor" || depot.entry !== "jetty" || depot.entries.join() !== "beach,jetty") return `known entries: a harbor start through a depot loaded as ${depot?.region} / ${depot?.entry} / ${depot?.entries.join()}`;
  return null;
}
/** Length of a bot path on foot (nav.ts) from a to b, or Infinity when there is none. */
function navLength(ax: number, az: number, bx: number, bz: number): number {
  const pts = findPath(ax, az, bx, bz);
  if (!pts) return Infinity;
  let len = 0;
  let prev = { x: ax, z: az };
  for (const q of pts) {
    len += Math.hypot(q.x - prev.x, q.z - prev.z);
    prev = q;
  }
  return len;
}
/**
 * The two ways between the regions are walked end to end: the bot's paths and the routed
 * robots' field cross the gorge on the railway bridge (a short way; round by the pass would be
 * hundreds of metres) and climb over the pass; and a player walking the bridge stays on its deck.
 */
function checkConnections(): string | null {
  const deck = DECKS[0];
  const mid = (deck.x0 + deck.x1) / 2;
  const [south, north] = [deck.z1 + 14, deck.z0 - 14];
  const span = south - north;
  const bridgeNav = navLength(mid, south, mid, north);
  if (!(bridgeNav < span * 1.3)) return `connection scenario: the bot's way over the railway bridge is ${bridgeNav.toFixed(0)} m for ${span.toFixed(0)} m`;
  const bridgeField = routeLength(fieldTo(mid, north)!, mid, south);
  if (!(bridgeField < span * 1.3)) return `connection scenario: robots' way over the railway bridge is ${bridgeField.toFixed(0)} m for ${span.toFixed(0)} m`;
  // The pass: from the landing pad over the saddle to the harbor town, on foot both ways.
  const pad = POIS[PAD];
  const [tx, tz] = inArea("town", 20, -306);
  const town = { x: tx, z: tz };
  const passNav = navLength(pad.x, pad.z, town.x, town.z);
  const passField = routeLength(fieldTo(town.x, town.z)!, pad.x, pad.z);
  if (!Number.isFinite(passNav) || !Number.isFinite(passField)) return `connection scenario: no way on foot from the landing pad to the harbor (bot ${passNav}, robots ${passField})`;
  // Walking the bridge: north along its middle, the deck under the feet the whole way.
  const s = padRun();
  const p = s.player;
  p.pos = { x: mid, y: groundAt(mid, south, 0.4, deck.y + 1), z: south };
  p.yaw = 0;
  let low = Infinity;
  for (let t = 0; t < 12 * 60 && p.pos.z > north; t++) {
    step(s, { ...idleInput(), moveZ: 1 }, false);
    if (p.pos.z < deck.z1 && p.pos.z > deck.z0) low = Math.min(low, p.pos.y);
  }
  if (p.pos.z > north || low < deck.y - 0.5) return `connection scenario: walking the bridge ended at ${p.pos.x.toFixed(1)},${p.pos.y.toFixed(1)},${p.pos.z.toFixed(1)}, lowest ${low.toFixed(1)} m over the gorge`;
  return null;
}
/** A run on the open landing pad with no robots, the player and the teammate standing there. */
function padRun(): State {
  const s = newRun(5);
  s.enemies = [];
  s.phase = "play";
  // Marked cleared already, so the empty island does not clear them now (which stands the teammate up).
  s.cleared = POIS.map(() => true);
  s.visited = POIS.map(() => true);
  s.reinforceT = 1e9;
  s.raiderT = 1e9;
  s.parties = [];
  s.crewsDue = [];
  const p = s.player;
  p.pos = { x: POIS[PAD].x, y: 0, z: POIS[PAD].z };
  p.pos.y = groundAt(p.pos.x, p.pos.z, 0.4, terrainHeight(p.pos.x, p.pos.z) + 2);
  p.onGround = true;
  placeAlly(s);
  return s;
}
const ticks = (s: State, seconds: number, inp = idleInput()) => {
  for (let i = 0; i < seconds / TICK; i++) step(s, inp, false);
};
/** Ticks with the player holding where it stands: a lunging charger's shove does not carry it out of a pickup. */
const holdSpot = (s: State, seconds: number) => {
  const spot = { ...s.player.pos };
  for (let i = 0; i < seconds / TICK && s.phase !== "done"; i++) {
    step(s, idleInput(), false);
    s.player.pos = { ...spot };
  }
};
/** Out of self-revives, the player waits downed and the teammate walks over and picks them up. */
function checkAllyRescue(): string | null {
  const s = padRun();
  const p = s.player;
  s.ally.pos.x += 10;
  p.selfRevive = 0;
  p.hp = 1;
  p.shield = 0;
  hurtPlayer(s, 10, p.pos.x, p.pos.z);
  if (!p.awaitAlly || p.downed <= 0) return "ally rescue scenario: the player did not wait for the teammate";
  ticks(s, 10);
  if (s.stats.wipes || p.downed > 0 || s.stats.allyRescues !== 1) return `ally rescue scenario: wipes ${s.stats.wipes}, downed ${p.downed.toFixed(1)}, rescues ${s.stats.allyRescues}`;
  return null;
}
/** The teammate going down while the player waits for it ends in a wipe. */
function checkAllyDownWipes(): string | null {
  const s = padRun();
  const p = s.player;
  p.selfRevive = 0;
  p.hp = 1;
  p.shield = 0;
  hurtPlayer(s, 10, p.pos.x, p.pos.z);
  hurtAlly(s, 999);
  if (s.stats.wipes !== 1 || s.outcome !== "dead") return `ally down scenario: wipes ${s.stats.wipes}, outcome ${s.outcome}`;
  return null;
}
/** One press of the use key beside a downed teammate, then standing still, picks it up. */
function checkHelpAlly(): string | null {
  const s = padRun();
  hurtAlly(s, 999);
  const press = idleInput();
  press.interact = true;
  step(s, press, false);
  ticks(s, ALLY.helpTime + 0.2);
  if (s.ally.down > 0 || s.stats.allyHelped !== 1) return `help scenario: teammate still down (${s.ally.down.toFixed(1)} s left)`;
  return null;
}
/** A downed teammate left alone stands up by itself, with health, after ALLY.selfUp seconds. */
function checkAllySelfUp(): string | null {
  const s = padRun();
  hurtAlly(s, 999);
  let up = 0;
  for (let i = 0; i < (ALLY.selfUp + 0.5) / TICK; i++) {
    step(s, idleInput(), false);
    up += s.events.filter((e) => e.t === "allyUp").length;
  }
  if (s.ally.down > 0 || s.ally.hp <= 0 || up !== 1) return `self-up scenario: down ${s.ally.down.toFixed(1)}, hp ${s.ally.hp}, ${up} allyUp events`;
  return null;
}
/** A road patrol hears gunfire from 2.5 times further, but a bin search only from its own radius. */
function checkRoamersHearOnlyGunfire(): string | null {
  const heard = (gunfire: boolean, radius: number) => {
    const s = newRun(5);
    s.phase = "play";
    const sq = s.squads.findIndex((q) => q.roam);
    const e = s.enemies.find((m) => m.squad === sq)!;
    const x = e.pos.x + 15;
    makeNoise(s, x, e.pos.z, radius, gunfire);
    return e.aware !== "idle";
  };
  if (heard(false, SEARCH.noise)) return `roam noise scenario: a search ${SEARCH.noise} m loud alerted a patrol 15 m away`;
  if (!heard(true, NOISE.pike)) return `roam noise scenario: a PIKE shot did not alert a patrol 15 m away`;
  return null;
}
/** A reinforcement due during the titan fight waits at 0 (the HUD never counts below it) and comes when the fight ends. */
function checkReinforceWaitsForTitan(): string | null {
  const s = newRun(5);
  s.phase = "play";
  s.raiderT = 1e9;
  s.reinforceT = 0.5;
  const titan = s.enemies.find((e) => e.kind === "titan")!;
  titan.aware = "engaged";
  for (let t = 0; t < 120; t++) {
    step(s, idleInput(), false);
    titan.aware = "engaged";
    if (s.reinforceT < 0) return `titan reinforce scenario: countdown at ${s.reinforceT.toFixed(2)}`;
    if (s.events.some((ev) => ev.t === "reinforce")) return "titan reinforce scenario: a wave beamed in during the titan fight";
  }
  return null;
}
/** A stomp's wave passes under a teammate standing above it, and hits one on the ground. */
function checkStompHeight(): string | null {
  const hit = (y: number) => {
    const s = padRun();
    const a = s.ally;
    const g = s.player.pos.y;
    a.pos = { x: s.player.pos.x + 20, y: g + y, z: s.player.pos.z };
    s.waves.push({ x: a.pos.x - 6, z: a.pos.z, y: g, r: 5.9, hit: true });
    const hp = a.hp + a.shield;
    step(s, idleInput(), false);
    return hp - (a.hp + a.shield);
  };
  const high = hit(2.4);
  const low = hit(0);
  if (high > 0 || low <= 0) return `stomp scenario: ${high} damage up high, ${low} on the ground`;
  return null;
}
/** A shot from behind meets the body before the weak point on its far side: no critical hit. */
function checkWeakPointBehindBody(): string | null {
  const s = newRun(5);
  s.phase = "play";
  const drone = s.enemies.find((e) => e.kind === "drone")!;
  s.enemies = [drone];
  const p = s.player;
  p.onGround = true;
  const eye = eyePos(s);
  drone.pos = { x: eye.x, y: eye.y, z: eye.z - 10 };
  drone.yaw = 0; // faces away from the player, toward -z
  drone.aware = "engaged";
  const a = lookAngles(eye, weakPoint(drone));
  fireRay(s, { kind: "pike", rarity: 0, mag: -1 }, forward(a.yaw, a.pitch));
  if (s.stats.hits !== 1 || s.stats.crits !== 0) return `weak point scenario: ${s.stats.hits} hits, ${s.stats.crits} crits through the body`;
  return null;
}
/** With a bin at the player's feet and the teammate down 3 m away, the use key picks the teammate up and leaves the bin shut. */
function checkHelpBeforeLoot(): string | null {
  const s = padRun();
  const p = s.player;
  s.bins.push({ id: 9999, x: p.pos.x + 0.3, y: p.pos.y, z: p.pos.z, poi: SUPPLY, open: false, flare: false, vault: false, outside: false });
  hurtAlly(s, 999);
  s.ally.pos = { x: p.pos.x + 3, y: p.pos.y, z: p.pos.z };
  const press = idleInput();
  press.interact = true;
  step(s, press, false);
  const bin = s.bins.find((b) => b.id === 9999)!;
  if (bin.open || s.ally.helped <= 0) return `help-before-loot scenario: bin open ${bin.open}, help ${s.ally.helped.toFixed(2)}`;
  return null;
}
/** The teammate's finishing hit on the titan credits it with the drones that fall with the titan, too. */
function checkAllyTitanKill(): string | null {
  const s = newRun(5);
  s.phase = "play";
  s.enemies = s.enemies.filter((e) => e.poi === PAD);
  const titan = s.enemies.find((e) => e.kind === "titan")!;
  const count = s.enemies.length;
  titan.hp = 1;
  titan.shield = 0;
  damageEnemy(s, titan, 10, false, bodyCenter(titan), "none", "ally");
  const kills = s.events.filter((e): e is Extract<GameEvent, { t: "kill" }> => e.t === "kill");
  if (s.stats.allyKills !== count || kills.some((k) => !k.ally)) return `ally titan scenario: ${s.stats.allyKills} of ${count} kills credited to the teammate`;
  return null;
}
/** The teammate never opens fire on robots that have not noticed anyone. */
/**
 * The ult's leap goes well up, glides a long way on held input, lands on low ground with
 * the teammate beside the player, and spends the charge.
 */
function checkLeap(): string | null {
  const s = padRun();
  const p = s.player;
  p.yaw = Math.PI; // off the dam's crest, out over the lakebed
  const from = { ...p.pos };
  p.ult = 1;
  step(s, { ...idleInput(), ult: true }, false);
  if (!p.leap?.carry) return `leap scenario: no leap with the teammate (leap ${JSON.stringify(p.leap)})`;
  if (p.ult !== 0) return "leap scenario: the charge was not spent";
  let top = p.pos.y;
  let t = 0;
  for (; t < 20 * 60 && p.leap; t++) {
    step(s, { ...idleInput(), moveZ: 1 }, false);
    top = Math.max(top, p.pos.y);
  }
  if (p.leap) return "leap scenario: still in the air after 20 s";
  const went = Math.hypot(p.pos.x - from.x, p.pos.z - from.z);
  if (top - from.y < 20) return `leap scenario: rose only ${(top - from.y).toFixed(1)} m`;
  if (went < 40) return `leap scenario: glided only ${went.toFixed(1)} m`;
  if (highGround(p.pos.x, p.pos.z)) return `leap scenario: landed on high ground at ${p.pos.x.toFixed(0)},${p.pos.z.toFixed(0)}`;
  const mate = Math.hypot(s.ally.pos.x - p.pos.x, s.ally.pos.z - p.pos.z);
  if (mate > 4 || Math.abs(s.ally.pos.y - p.pos.y) > 1) return `leap scenario: the teammate landed ${mate.toFixed(1)} m away`;
  return null;
}
/** A teammate on the ground below a roof the player leaps from stays behind: no carrying through floors. */
function checkLeapLeavesAllyBelow(): string | null {
  const [wx, wz] = inArea("supply", 38, -36);
  const roof = BOXES.find((b) => {
    const x = (b.x0 + b.x1) / 2;
    const z = (b.z0 + b.z1) / 2;
    const t = terrainHeight(x, z);
    return Math.hypot(x - wx, z - wz) < 15 && b.h - t > 4 && b.x1 - b.x0 > 4 && b.z1 - b.z0 > 4;
  });
  if (!roof) return `leap scenario: no warehouse roof near ${wx},${wz}`;
  const s = padRun();
  const p = s.player;
  const x = (roof.x0 + roof.x1) / 2;
  const z = (roof.z0 + roof.z1) / 2;
  p.pos = { x, y: roof.h, z };
  p.onGround = true;
  const ax = roof.x1 + 2;
  s.ally.pos = { x: ax, y: groundAt(ax, z, 0.4, terrainHeight(ax, z) + 1), z };
  p.ult = 1;
  step(s, { ...idleInput(), ult: true }, false);
  if (!p.leap) return `leap scenario: no leap from the roof at ${x.toFixed(0)},${z.toFixed(0)} (${s.events.map((e) => e.t).join(",")})`;
  if (p.leap.carry) return "leap scenario: the teammate on the ground was carried from the roof";
  return null;
}
/** Downed in the air, the player stops gliding and falls; a carried teammate falls free and lands too. */
function checkLeapDowned(): string | null {
  const s = padRun();
  const p = s.player;
  p.yaw = Math.PI;
  p.ult = 1;
  step(s, { ...idleInput(), ult: true }, false);
  ticks(s, 1.5, { ...idleInput(), moveZ: 1 });
  if (!p.leap?.carry) return "leap downed scenario: not leaping with the teammate";
  p.hp = 1;
  p.shield = 0;
  hurtPlayer(s, 10, p.pos.x, p.pos.z);
  if (p.downed <= 0 || p.leap) return `leap downed scenario: downed ${p.downed.toFixed(1)}, still leaping ${!!p.leap}`;
  // The same fall with and without a held direction: a downed body cannot steer.
  // (Compared where it lands: on the ground a downed player may crawl.)
  const free = structuredClone(s);
  for (let t = 0; t < 8 * 60 && !p.onGround; t++) step(s, { ...idleInput(), moveX: 1, moveZ: -1 }, false);
  for (let t = 0; t < 8 * 60 && !free.player.onGround; t++) step(free, idleInput(), false);
  const drift = Math.hypot(p.pos.x - free.player.pos.x, p.pos.z - free.player.pos.z);
  if (drift > 0.5) return `leap downed scenario: holding a direction moved the downed player ${drift.toFixed(1)} m`;
  if (!p.onGround) return `leap downed scenario: still in the air at ${p.pos.y.toFixed(1)}`;
  const g = groundAt(s.ally.pos.x, s.ally.pos.z, 0.4, s.ally.pos.y);
  if (s.ally.pos.y - g > 0.1) return `leap downed scenario: the teammate hangs ${(s.ally.pos.y - g).toFixed(1)} m in the air`;
  return null;
}
/** A carried teammate downed in the air lets go: it falls, and its stand-up timer runs. */
function checkLeapAllyDowned(): string | null {
  const s = padRun();
  const p = s.player;
  p.yaw = Math.PI;
  p.ult = 1;
  step(s, { ...idleInput(), ult: true }, false);
  ticks(s, 1.5, { ...idleInput(), moveZ: 1 });
  if (!p.leap?.carry) return "leap ally-downed scenario: not leaping with the teammate";
  hurtAlly(s, 9999);
  const down0 = s.ally.down;
  ticks(s, 1, { ...idleInput(), moveZ: 1 });
  if (p.leap?.carry) return "leap ally-downed scenario: the downed teammate is still carried";
  if (!(s.ally.down < down0 - 0.5)) return `leap ally-downed scenario: its stand-up timer did not run (${down0.toFixed(1)} -> ${s.ally.down.toFixed(1)})`;
  if (Math.hypot(s.ally.pos.x - p.pos.x, s.ally.pos.z - p.pos.z) < 5) return "leap ally-downed scenario: the downed teammate still flies along";
  return null;
}
/** The ult and an item pressed together: the leap goes and no item starts with it. */
function checkLeapWithItem(): string | null {
  const s = padRun();
  const p = s.player;
  p.shield = 0;
  p.heals.cell = 2;
  p.ult = 1;
  step(s, { ...idleInput(), ult: true, heal: true }, false);
  if (!p.leap) return "leap-with-item scenario: no leap";
  if (p.healing || s.events.some((e) => e.t === "healStart")) return "leap-with-item scenario: an item started with the leap";
  return null;
}
/** The clocks run on through the glide: the gun's and the arc's cooldowns are spent on landing, and a reload under way is called off at launch. */
function checkLeapClocks(): string | null {
  const s = padRun();
  const p = s.player;
  p.yaw = Math.PI;
  const w = p.weapons[p.slot];
  if (!w) return "leap clocks scenario: no weapon in hand";
  w.mag = 0;
  p.cooldown = 1.2;
  p.tactical = 4;
  p.reload = 1;
  p.ult = 1;
  step(s, { ...idleInput(), ult: true }, false);
  if (!p.leap) return "leap clocks scenario: no leap";
  if (p.reload > 0) return "leap clocks scenario: the reload went on into the leap";
  let flew = 0;
  for (; flew < 20 * 60 && p.leap; flew++) step(s, { ...idleInput(), moveZ: 1 }, false);
  if (flew * TICK < 4.2) return `leap clocks scenario: the glide lasted only ${(flew * TICK).toFixed(1)} s`;
  if (p.cooldown > 0 || p.tactical > 0) return `leap clocks scenario: cooldowns left on landing: gun ${p.cooldown.toFixed(2)} s, arc ${p.tactical.toFixed(2)} s`;
  if (w.mag !== 0) return "leap clocks scenario: the called-off reload still filled the magazine";
  return null;
}
/** A teammate left behind by the leap catches up with the player after the landing. */
function checkLeapAllyCatchesUp(): string | null {
  const s = padRun();
  const p = s.player;
  p.yaw = Math.PI;
  // Too far to be carried: walk the player 25 m south first, leaving the teammate posted.
  s.ally.pos = { ...s.ally.pos, x: s.ally.pos.x + 22 };
  s.ally.pos.y = groundAt(s.ally.pos.x, s.ally.pos.z, 0.4, s.ally.pos.y + 1);
  p.ult = 1;
  step(s, { ...idleInput(), ult: true }, false);
  if (!p.leap || p.leap.carry) return `leap catch-up scenario: leap ${JSON.stringify(p.leap)}`;
  for (let t = 0; t < 20 * 60 && p.leap; t++) step(s, { ...idleInput(), moveZ: 1 }, false);
  ticks(s, 20);
  const gap = Math.hypot(s.ally.pos.x - p.pos.x, s.ally.pos.z - p.pos.z);
  if (gap > 12) return `leap catch-up scenario: the teammate is still ${gap.toFixed(0)} m away 20 s after the landing`;
  return null;
}
/** Gliding toward high ground from below its cliffs still comes down on low ground. */
function checkLeapOffHighGround(): string | null {
  for (const [hx, hz, yaw] of [[-20, -20, -Math.PI / 2], [20, -30, Math.PI / 2], [0, -60, 0], [-10, 30, Math.PI * 0.75]]) {
    const [x, z] = inArea("heart", hx, hz);
    const s = padRun();
    const p = s.player;
    p.pos = { x, y: groundAt(x, z, 0.4, terrainHeight(x, z) + 2), z };
    p.yaw = yaw;
    p.ult = 1;
    step(s, { ...idleInput(), ult: true }, false);
    for (let t = 0; t < 20 * 60 && p.leap; t++) step(s, { ...idleInput(), moveZ: 1 }, false);
    if (p.leap) return `leap scenario: from ${x},${z} still in the air`;
    if (highGround(p.pos.x, p.pos.z)) return `leap scenario: from ${x},${z} landed on high ground at ${p.pos.x.toFixed(0)},${p.pos.z.toFixed(0)}`;
  }
  return null;
}
/** Under a roof the ult does nothing and keeps its charge. */
function checkLeapUnderRoof(): string | null {
  const roof = BOXES.find((b) => {
    const x = (b.x0 + b.x1) / 2;
    const z = (b.z0 + b.z1) / 2;
    const t = terrainHeight(x, z);
    return b.x1 - b.x0 > 4 && b.z1 - b.z0 > 4 && b.y0 - t > 2.5 && b.y0 - t < 6 && !solidAt(x, t + 1, z) && groundAt(x, z, 0.4, t + 0.2) < t + 0.5;
  });
  if (!roof) return "leap scenario: no roof to stand under";
  const s = padRun();
  const p = s.player;
  const x = (roof.x0 + roof.x1) / 2;
  const z = (roof.z0 + roof.z1) / 2;
  p.pos = { x, y: groundAt(x, z, 0.4, terrainHeight(x, z) + 0.2), z };
  p.ult = 1;
  step(s, { ...idleInput(), ult: true }, false);
  if (p.leap || p.ult < 1 || !s.events.some((e) => e.t === "leapBlocked")) return `leap scenario: under the roof at ${x.toFixed(0)},${z.toFixed(0)} leap ${!!p.leap}, charge ${p.ult}`;
  return null;
}
function checkAllyHoldsFire(): string | null {
  const s = newRun(5);
  s.phase = "play";
  const grunt = s.enemies.find((e) => e.kind === "grunt" && e.pos.y < terrainHeight(e.pos.x, e.pos.z) + 0.5)!;
  s.enemies = [grunt];
  const p = s.player;
  // Behind the grunt, out of its sight cone, with the teammate beside.
  p.pos = { x: grunt.pos.x - Math.sin(grunt.face) * 25, y: 0, z: grunt.pos.z + Math.cos(grunt.face) * 25 };
  p.pos.y = groundAt(p.pos.x, p.pos.z, 0.4, 20);
  p.onGround = true;
  placeAlly(s);
  let shots = 0;
  for (let i = 0; i < 180; i++) {
    step(s, idleInput(), false);
    shots += s.events.filter((e) => e.t === "allyShot").length;
  }
  if (shots) return `hold fire scenario: the teammate fired ${shots} shots at an idle robot`;
  return null;
}
/** The stash: a raid takes its kit out, getting off brings it and the haul home, a wipe keeps only the pouch. */
function checkSettle(): string | null {
  let p = newProfile();
  const start = p.stash.length;
  // Two stash weapons and a cell in; the cell is used up, a rare PIKE is picked up instead of the HORNET.
  const taken = takeKit(p, { weapons: [0, 1], armor: null, heals: { cell: 1, battery: 0, syringe: 0, medkit: 0 }, keys: [] });
  if (taken.kit.weapons.some((w) => w.loan) || taken.kit.heals.cell !== 1) return `settle scenario: the stash kit came out wrong (${JSON.stringify(taken.kit)})`;
  if (taken.profile.stash.length !== start - 3) return `settle scenario: taking the kit left ${taken.profile.stash.length} things in the stash, not ${start - 3}`;
  const s = newRun(5, taken.kit);
  if (s.player.weapons.map((w) => w?.kind).join() !== "pike,hornet") return `settle scenario: the raid started with ${s.player.weapons.map((w) => w?.kind).join()}`;
  s.player.heals.cell = 0;
  s.player.weapons[1] = { kind: "pike", rarity: 1, mag: -1 };
  s.player.armor = 2;
  s.player.haul = ["core", "board", "parts", "parts"];
  s.outcome = "extracted";
  const won = settle(taken.profile, s);
  const kinds = won.home.map((i) => i.t).sort().join();
  if (kinds !== "armor,valuable,valuable,valuable,valuable,weapon,weapon") return `settle scenario: getting off brought home ${kinds}`;
  if (won.profile.stash.length !== taken.profile.stash.length + 7 || won.profile.extracted !== 1 || won.profile.raids !== 1) return "settle scenario: the stash or record did not take what came home";
  // A wipe: the kit is gone, and of the haul only the best that fits the pouch comes back.
  s.outcome = "dead";
  const lost = settle(taken.profile, s);
  if (lost.home.map((i) => (i.t === "valuable" ? i.kind : i.t)).join() !== "board") return `settle scenario: a wipe kept ${JSON.stringify(lost.home)}, not the board`;
  if (pouch(["parts", "parts", "board"]).join() !== "board" || pouch(["parts", "core", "parts"]).join() !== "parts,parts") return "pouch scenario: the pouch did not keep the most valuable fit";
  // The free kit is lent: getting off with it brings home only what was found, and its spare heals stay lent.
  const free = takeKit(p, { weapons: [], armor: null, heals: { cell: 0, battery: 0, syringe: 0, medkit: 0 }, keys: [] });
  if (!free.kit.weapons.every((w) => w.loan) || free.profile.stash.length !== start) return "free kit scenario: the free kit was not lent, or it took from the stash";
  const f = newRun(6, free.kit);
  f.outcome = "extracted";
  f.player.heals.syringe = 3;
  const back = settle(free.profile, f);
  // A lent syringe used up and one found: the found one is the player's.
  const g = newRun(6, free.kit);
  g.outcome = "extracted";
  g.player.heals.syringe = 1;
  g.player.heals.cell = 2;
  g.player.lentHeals.syringe = 1;
  const g2 = settle(free.profile, g);
  g.player.heals.syringe = 2; // ...then a syringe picked up
  const g3 = settle(free.profile, g);
  if (g2.home.length !== 0 || g3.home.map((i) => (i.t === "heal" ? i.kind : i.t)).join() !== "syringe") return `free kit scenario: after using a lent syringe and finding one, home is ${JSON.stringify(g3.home)}`;
  if (back.home.map((i) => (i.t === "heal" ? i.kind : i.t)).join() !== "syringe") return `free kit scenario: getting off brought home ${JSON.stringify(back.home)}, not one found syringe`;
  // Trading and a full stash.
  const cash = p.cash;
  const bought = buy(p, wares(p)[0]);
  if (!bought || bought.cash !== cash - price(wares(p)[0]) || bought.stash.length !== start + 1) return "trader scenario: buying did not take the price and add the item";
  if (sell(bought, bought.stash.length - 1).cash >= cash) return "trader scenario: selling paid back at least the price";
  p = { ...p, stash: Array.from({ length: META.stash }, () => ({ t: "heal" as const, kind: "cell" as const })) };
  if (buy(p, wares(p)[0])) return "trader scenario: bought into a full stash";
  const full = settle(p, f);
  if (full.profile.stash.length !== META.stash || full.sold.length !== 1 || full.profile.cash <= p.cash) return "full stash scenario: what did not fit was not sold";
  // Armour from the stash, swapped on the island for a better one, is left on the ground, not lost.
  const worn = padRun();
  worn.player.armor = 1;
  worn.loot = [];
  worn.loot.push({ id: 9100, kind: "armor", rarity: 2, pos: { ...worn.player.pos }, vel: { x: 0, y: 0, z: 0 }, age: 1 });
  step(worn, idleInput(), false);
  if (worn.player.armor !== 2 || !worn.loot.some((l) => l.kind === "armor" && l.rarity === 1 && dist2d(l.pos, worn.player.pos) < 2)) return `armor scenario: after the upgrade the player wears ${worn.player.armor} and the old armour ${worn.loot.some((l) => l.kind === "armor") ? "lies there" : "is gone"}`;
  // ...and it can be put back on with the use key, leaving the better one there, without a fresh shield.
  ticks(worn, 1);
  worn.player.shield = 10;
  const press = idleInput();
  press.interact = true;
  step(worn, press, false);
  step(worn, idleInput(), false);
  if (worn.player.armor !== 1 || worn.player.shield > 10 || !worn.loot.some((l) => l.kind === "armor" && l.rarity === 2 && l.worn)) return `armor scenario: putting the old armour back on left the player in ${worn.player.armor} with shield ${worn.player.shield}`;
  worn.outcome = "extracted";
  if (!settle(newProfile(), worn).home.some((i) => i.t === "armor" && i.tier === 1)) return "armor scenario: the armour put back on did not come home";
  // One slot left, and a common and an epic weapon come home: the epic is kept.
  const one = { ...p, stash: p.stash.slice(1) };
  f.player.heals.syringe = 2;
  f.player.weapons = [{ kind: "pike", rarity: 0, mag: -1 }, { kind: "lance", rarity: 2, mag: -1 }];
  const kept = settle(one, f).profile.stash.at(-1);
  if (kept?.t !== "weapon" || kept.rarity !== 2) return `full stash scenario: the last slot went to ${JSON.stringify(kept)}, not the epic LANCE`;
  if (parseProfile(JSON.parse(JSON.stringify(won.profile)))?.stash.length !== won.profile.stash.length || parseProfile({ v: 2 }) !== null) return "storage scenario: a saved profile does not load back";
  return null;
}

/**
 * The depots: walking up switches one on; its use key sends a full bag home or, with the bag
 * empty and no fight on, leaves the raid there after a wait that a fight or a step away breaks
 * off; it never takes a press meant for loot. What was sent home survives a wipe, the depots
 * and the explored map are kept, and a later raid starts on the ground at a depot already on.
 */
function checkDepots(): string | null {
  const PADD = depotIndex("pad");
  const d = DEPOTS[PADD];
  const press = idleInput();
  press.interact = true;
  const stand = (s: State, x = d.x, z = d.z) => {
    s.player.pos = { x, y: groundAt(x, z, PLAYER.radius, d.y + 0.3), z };
    s.player.onGround = true;
  };
  if (newRun(5).depots.some(Boolean) || newRun(5).sent.length) return "depot scenario: a raid started the usual way has a depot on or something sent";
  if (DEPOTS.length !== POIS.length || POIS.some((p) => depotIndex(p.id) < 0)) return "depot scenario: not one depot per POI";

  // Walking up the road to the supply depot's switches it on, once, and not from further off.
  const SUP = depotIndex("supply");
  const sup = DEPOTS[SUP];
  const walk = padRun();
  const back = { x: sup.x - Math.sin(sup.yaw) * 12, z: sup.z + Math.cos(sup.yaw) * 12 };
  stand(walk, back.x, back.z);
  walk.player.yaw = sup.yaw;
  walk.player.pitch = 0;
  let on = 0;
  let early = false;
  const fwd = idleInput();
  fwd.moveZ = 1;
  for (let i = 0; i < 4 / TICK && dist2d(walk.player.pos, sup) > 1; i++) {
    step(walk, fwd, false);
    on += walk.events.filter((e) => e.t === "depotOn" && e.poi === "supply").length;
    if (walk.depots[SUP] && dist2d(walk.player.pos, sup) > DEPOT.radius + 0.5) early = true;
  }
  if (!walk.depots[SUP] || on !== 1 || early || walk.depots.filter(Boolean).length !== 1) return `depot scenario: walking up left it ${walk.depots[SUP] ? "on" : "off"} after ${on} depotOn events (early ${early}), ${walk.depots.filter(Boolean).length} on`;
  if (cellOf(walk.player.pos.x, walk.player.pos.z) < 0 || !walk.seen[cellOf(walk.player.pos.x, walk.player.pos.z)] || !walk.seen[cellOf(back.x, back.z)]) return "depot scenario: the cells walked through were not marked explored";
  if (walk.seen.filter(Boolean).length > (2 * DEPOT.sight + 1) ** 2 * 3) return `depot scenario: a short walk explored ${walk.seen.filter(Boolean).length} cells`;
  if (decodeSeen(encodeSeen(walk.seen)).join() !== walk.seen.join() || decodeSeen("zz").some(Boolean)) return "depot scenario: the explored map does not survive saving";

  // With a bag, the use key sends it home: the bag is empty and the raid's worth unchanged.
  const s = padRun();
  s.depots[PADD] = true;
  stand(s);
  s.player.haul = ["core", "board", "parts"];
  const worth = haulValue(s);
  step(s, press, false);
  const sentEv = s.events.find((e): e is Extract<GameEvent, { t: "deposit" }> => e.t === "deposit");
  if (s.player.haul.length || s.sent.join() !== "core,board,parts" || haulValue(s) !== worth || sentEv?.n !== 3 || sentEv.value !== worth || s.leaving) return `depot scenario: sending the bag left haul ${s.player.haul.join()}, sent ${s.sent.join()}, worth ${haulValue(s)} of ${worth}`;
  // ...and it comes home after a wipe, with the depot and the explored map kept for later raids.
  s.outcome = "dead";
  const old = { ...newProfile(), depots: ["supply" as const] };
  const after = settle(old, s);
  const home = after.home.filter((i) => i.t === "valuable").map((i) => (i.t === "valuable" ? i.kind : "")).sort().join();
  if (home !== "board,core,parts") return `depot scenario: a wipe brought home ${home}, not what was sent`;
  if (after.profile.depots.join() !== "supply,pad" || after.profile.seen !== encodeSeen(s.seen) || !decodeSeen(after.profile.seen).some(Boolean)) return `depot scenario: the profile kept depots ${after.profile.depots.join()} and ${decodeSeen(after.profile.seen).filter(Boolean).length} explored cells`;

  // With the bag empty, the use key leaves the raid there, after DEPOT.leave seconds standing still.
  const go = padRun();
  go.depots[PADD] = true;
  stand(go);
  step(go, press, false);
  if (!go.leaving || !go.events.some((e) => e.t === "leaveStart")) return "depot scenario: an empty bag at a depot did not start leaving";
  ticks(go, DEPOT.leave - 0.5);
  if (phaseOf(go) !== "play") return "depot scenario: left before the wait was over";
  ticks(go, 1);
  if (phaseOf(go) !== "done" || go.outcome !== "extracted" || go.leftAt !== "pad" || go.extractedAt !== null) return `depot scenario: after the wait phase ${go.phase}, outcome ${go.outcome}, left at ${go.leftAt}`;

  // A squad engaging breaks the wait off, and while one fights the depot takes no press.
  const fight = padRun();
  fight.depots[PADD] = true;
  stand(fight);
  fight.player.iframes = 999;
  step(fight, press, false);
  ticks(fight, 1);
  const squad = fight.squads.length;
  fight.squads.push({ name: "test", poi: -1, patrol: [], leg: 0, engaged: false, roam: false, sinceSeen: 0, last: { x: d.x, z: d.z } });
  const near = spawnEnemy(fight, "grunt", d.x + DEPOT.safe - 15, d.z, -1, squad);
  engageSquad(fight, squad, near);
  step(fight, idleInput(), false);
  if (fight.leaving || !fight.events.some((e) => e.t === "leaveCancel")) return "depot scenario: a robot fighting nearby did not break off leaving";
  if (useTarget(fight)) return `depot scenario: the depot was offered with a robot fighting nearby (${useTarget(fight)?.kind})`;
  // A fight left behind (the titan never stands down) does not shut the depots once it is outrun.
  near.pos = { x: d.x + DEPOT.safe + 15, y: near.pos.y, z: d.z };
  if (useTarget(fight)?.kind !== "depot") return "depot scenario: the depot was not offered with the only fighting robot far off";
  // So does picking up a valuable: leaving takes an empty bag.
  const fill = padRun();
  fill.depots[PADD] = true;
  stand(fill);
  step(fill, press, false);
  ticks(fill, 1);
  fill.player.haul.push("parts");
  step(fill, idleInput(), false);
  if (fill.leaving || !fill.events.some((e) => e.t === "leaveCancel")) return "depot scenario: filling the bag did not break off leaving";
  // ...even when what was picked up is sent home in the same tick.
  const send = padRun();
  send.depots[PADD] = true;
  stand(send);
  step(send, press, false);
  ticks(send, 1);
  send.player.haul.push("parts");
  step(send, press, false);
  if (send.leaving || send.sent.join() !== "parts") return "depot scenario: sending what was picked up while leaving did not break off leaving";
  // Walking away breaks it off too.
  const away = padRun();
  away.depots[PADD] = true;
  stand(away);
  step(away, press, false);
  ticks(away, 1);
  stand(away, d.x + Math.cos(d.yaw) * (PLAYER.interactRange + 2.5), d.z + Math.sin(d.yaw) * (PLAYER.interactRange + 2.5));
  step(away, idleInput(), false);
  if (away.leaving || !away.events.some((e) => e.t === "leaveCancel")) return "depot scenario: walking away did not break off leaving";

  // A bin or a weapon within reach takes the press before the depot does.
  const loot = padRun();
  loot.depots[PADD] = true;
  stand(loot);
  const p = loot.player;
  loot.bins.push({ id: 9300, x: p.pos.x + 1, y: p.pos.y, z: p.pos.z, poi: PAD, open: false, flare: false, vault: false, outside: false });
  if (useTarget(loot)?.kind !== "bin") return `depot scenario: with a bin in reach the press went to ${useTarget(loot)?.kind}`;
  loot.bins.pop();
  loot.loot.push({ id: 9301, kind: "weapon", rarity: 1, weapon: { kind: "pike", rarity: 1, mag: -1 }, pos: { ...p.pos }, vel: { x: 0, y: 0, z: 0 }, age: 1 });
  if (useTarget(loot)?.kind !== "weapon") return `depot scenario: with a weapon in reach the press went to ${useTarget(loot)?.kind}`;

  // A raid started from a depot already on begins at it, on the ground, in its region, with the teammate.
  const wreck = DEPOTS[depotIndex("wreck")];
  const from = newRun(5, freeKit(), "reservoir", { depots: ["pad", "wreck"], from: "wreck" });
  ticks(from, 1);
  const fp = from.player;
  if (from.region !== "harbor" || phaseOf(from) !== "play" || dist2d(fp.pos, wreck) > PLAYER.interactRange + 1 || useTarget(from)?.kind !== "depot" || Math.abs(fp.pos.y - wreck.y) > 0.5 || !from.ally.active || dist2d(from.ally.pos, fp.pos) > 4 || !from.depots[depotIndex("pad")] || !from.depots[depotIndex("wreck")])
    return `depot scenario: starting from the wreck's depot gave region ${from.region}, phase ${from.phase}, player at ${fp.pos.x.toFixed(1)},${fp.pos.y.toFixed(1)},${fp.pos.z.toFixed(1)}, teammate ${from.ally.active ? dist2d(from.ally.pos, fp.pos).toFixed(1) : "inactive"}`;
  // ...but not from one that is not on: that raid starts at its region's way in as usual.
  const off = newRun(5, freeKit(), "reservoir", { depots: ["pad"], from: "wreck" });
  if (off.region !== "reservoir" || dist2d(off.player.pos, entryOf(regionOf("reservoir").entries[0])) > 1) return `depot scenario: starting from a depot that is off began in ${off.region} at ${off.player.pos.x.toFixed(0)},${off.player.pos.z.toFixed(0)}`;

  // A raid started from any depot is not seen at once: standing still there for 15 s, no squad fights.
  const every = DEPOTS.map((x) => x.poi);
  for (const x of DEPOTS)
    for (const seed of [11, 222, 777, 4242]) {
      const q = newRun(seed, freeKit(), "reservoir", { depots: every, from: x.poi });
      ticks(q, 15);
      if (q.squads.some((sq) => sq.engaged) || q.player.hp < PLAYER.hp) return `depot scenario: a raid started from the ${x.poi} depot (seed ${seed}) was in a fight within 15 s`;
    }

  // Saves from before the depots load with none on and nothing explored; unknown depots are dropped.
  const { depots: _d, seen: _s, ...v5 } = newProfile();
  const loaded = parseProfile(JSON.parse(JSON.stringify({ ...v5, v: 5 })));
  if (loaded?.v !== 16 || loaded.depots.length || loaded.seen !== "") return `depot scenario: a v5 save loaded as ${JSON.stringify(loaded && { v: loaded.v, depots: loaded.depots, seen: loaded.seen })}`;
  const kept = parseProfile(JSON.parse(JSON.stringify({ ...after.profile, depots: ["pad", "nowhere", "pad"] })));
  if (kept?.depots.join() !== "pad" || kept.seen !== after.profile.seen) return `depot scenario: a v7 save loaded depots ${kept?.depots.join()}`;
  // A v6 save's explored map was drawn over the world before it widened: it is dropped, the depots stay.
  const v6 = parseProfile(JSON.parse(JSON.stringify({ ...after.profile, v: 6 })));
  if (v6?.v !== 16 || v6.seen !== "" || v6.depots.join() !== after.profile.depots.join()) return `depot scenario: a v6 save loaded as ${JSON.stringify(v6 && { v: v6.v, depots: v6.depots, seen: v6.seen.length })}`;
  // A v9 save dropped from the air over a smaller world: it starts at its region's first way in, its explored map dropped.
  if (!after.profile.seen) return "depot scenario: the raid explored nothing to save";
  // A v11 save's explored map was drawn over the narrower world: it is dropped, the rest stays.
  const v11 = parseProfile(JSON.parse(JSON.stringify({ ...after.profile, v: 11 })));
  if (v11?.v !== 16 || v11.seen !== "" || v11.depots.join() !== after.profile.depots.join() || v11.entries.join() !== after.profile.entries.join()) return `depot scenario: a v11 save loaded as ${JSON.stringify(v11 && { v: v11.v, seen: v11.seen.length, entries: v11.entries })}`;
  const v9 = parseProfile(JSON.parse(JSON.stringify({ ...after.profile, v: 9, entry: undefined, region: "harbor" })));
  if (v9?.v !== 16 || v9.seen !== "" || v9.entry !== regionOf("harbor").entries[0] || v9.depots.join() !== after.profile.depots.join()) return `depot scenario: a v9 save loaded as ${JSON.stringify(v9 && { v: v9.v, entry: v9.entry, seen: v9.seen.length })}`;
  return null;
}

/**
 * A start from a depot carries a limited loadout: stash weapons, armour and keys cost points
 * (`DEPOT`), the lent kit and heals cost nothing, and a depot's allowance grows with the
 * credits' worth sent home through that depot alone. A start at a way in has no limit.
 */
function checkDepotBudget(): string | null {
  // What each pick costs.
  for (const r of [0, 1, 2, 3] as const) if (itemCost({ t: "weapon", kind: "pike", rarity: r }) !== DEPOT.weaponCost[r]) return `depot budget: a rarity ${r} weapon costs ${itemCost({ t: "weapon", kind: "pike", rarity: r })}`;
  if (DEPOT.weaponCost.join() !== "1,2,3,4" || DEPOT.armorCost.join() !== "0,1,2,3" || DEPOT.keyCost !== 1 || DEPOT.budget.join() !== "2,4,6,9" || DEPOT.levels.join() !== "0,1500,5000,12000") return "depot budget: the numbers in DEPOT are not the agreed ones";
  if (itemCost({ t: "armor", tier: 3 }) !== 3 || itemCost({ t: "key", poi: "pad" }) !== 1 || itemCost({ t: "heal", kind: "medkit" }) !== 0) return "depot budget: armour, keys or heals cost the wrong points";
  const base: Profile = {
    ...newProfile(3),
    depots: ["pad", "supply"],
    depotSent: { pad: 0, supply: 0 },
    stash: [
      { t: "weapon", kind: "pike", rarity: 2 },
      { t: "weapon", kind: "hornet", rarity: 0 },
      { t: "armor", tier: 2 },
      { t: "key", poi: "relay" },
      { t: "key", poi: "relay" },
      { t: "key", poi: "quarry" },
      { t: "heal", kind: "cell" },
      { t: "heal", kind: "medkit" },
    ],
  };
  const heals = { cell: 1, battery: 0, syringe: 0, medkit: 1 };
  const free = { ...emptyLoadout(), heals };
  if (loadoutCost(base, free) !== 0) return `depot budget: the lent kit with heals costs ${loadoutCost(base, free)}`;
  // The same weapon picked twice counts once; a second key to the same POI is not taken, so it costs nothing.
  const full = { weapons: [0, 1, 0], armor: 2, heals, keys: [3, 4, 5] };
  if (loadoutCost(base, full) !== 3 + 1 + 2 + 1 + 1) return `depot budget: an epic, a common, tier 2 armour and two keys cost ${loadoutCost(base, full)}, not 8`;

  // The level, the allowance and what the next level still needs, from the credits sent through the depot.
  const at = (sent: number) => depotAllowance({ ...base, depotSent: { pad: sent } }, "pad");
  for (const [sent, level, budget, next] of [[0, 0, 2, 1500], [1499, 0, 2, 1], [1500, 1, 4, 3500], [4999, 1, 4, 1], [5000, 2, 6, 7000], [12000, 3, 9, null], [99999, 3, 9, null]] as const) {
    const a = at(sent);
    if (a.level !== level || a.budget !== budget || a.next !== next || a.sent !== sent) return `depot budget: ${sent} credits sent gave ${JSON.stringify(a)}`;
  }
  if (depotAllowance(base, "wreck").level !== 0) return "depot budget: a depot with nothing recorded is not level 0";

  // Sending through the pad's depot raises the pad's level, across raids, and never the supply depot's.
  const PADD = depotIndex("pad");
  const d = DEPOTS[PADD];
  const press = idleInput();
  press.interact = true;
  const raidSending = (haul: State["player"]["haul"]) => {
    const s = padRun();
    s.depots[PADD] = true;
    s.depots[depotIndex("supply")] = true;
    s.player.pos = { x: d.x, y: groundAt(d.x, d.z, PLAYER.radius, d.y + 0.3), z: d.z };
    s.player.onGround = true;
    s.player.haul = [...haul];
    step(s, press, false);
    s.outcome = "dead";
    return s;
  };
  const r1 = raidSending(["core", "board"]);
  if (r1.sentVia[PADD] !== 1300 || r1.sentVia.some((v, i) => i !== PADD && v !== 0)) return `depot budget: sending a core and a board through the pad recorded ${r1.sentVia.join()}`;
  const p1 = settle(base, r1).profile;
  if (p1.depotSent.pad !== 1300 || p1.depotSent.supply !== 0 || depotAllowance(p1, "pad").level !== 0) return `depot budget: after one raid the profile holds ${JSON.stringify(p1.depotSent)}`;
  const p2 = settle(p1, raidSending(["board"])).profile;
  if (p2.depotSent.pad !== 1600 || depotAllowance(p2, "pad").level !== 1 || depotBudget(p2, "pad") !== 4 || depotAllowance(p2, "supply").level !== 0 || depotBudget(p2, "supply") !== 2) return `depot budget: after two raids the profile holds ${JSON.stringify(p2.depotSent)}`;
  // A raid that sends nothing keeps the record, and a depot switched on in it starts at 0.
  const quiet = padRun();
  quiet.depots[depotIndex("wreck")] = true;
  quiet.outcome = "dead";
  const p3 = settle(p2, quiet).profile;
  if (p3.depotSent.pad !== 1600 || p3.depotSent.wreck !== 0) return `depot budget: a raid sending nothing left ${JSON.stringify(p3.depotSent)}`;
  if (JSON.stringify(parseProfile(JSON.parse(JSON.stringify(p3)))?.depotSent) !== JSON.stringify(p3.depotSent)) return "depot budget: the sent record does not survive a save";

  // A v7 save loads with nothing sent through each depot on (and its explored map, over the smaller world, dropped); a current save keeps only its depots' records.
  const { depotSent: _ds, ...v7 } = { ...p3, v: 7 };
  const m7 = parseProfile(JSON.parse(JSON.stringify(v7)));
  if (m7?.v !== 16 || JSON.stringify(m7.depotSent) !== JSON.stringify(Object.fromEntries(p3.depots.map((x) => [x, 0]))) || m7.seen !== "") return `depot budget: a v7 save loaded as ${JSON.stringify(m7 && { v: m7.v, depotSent: m7.depotSent })}`;
  const odd = parseProfile(JSON.parse(JSON.stringify({ ...p3, depotSent: { pad: 2000, supply: -5, nowhere: 9, quarry: 7000 } })));
  if (JSON.stringify(odd?.depotSent) !== JSON.stringify({ supply: 0, pad: 2000, wreck: 0 })) return `depot budget: a save's odd records loaded as ${JSON.stringify(odd?.depotSent)}`;

  // takeKit refuses a depot start over its allowance, and takes the same loadout as a drop.
  const epic = { ...emptyLoadout(), weapons: [0] };
  if (takeKit(base, epic, "pad") !== null || fitsStart(base, epic, "pad")) return "depot budget: an epic weapon (3) started from a level 0 depot (2)";
  const dropped = takeKit(base, epic, null);
  if (!dropped || dropped.kit.weapons[0]?.kind !== "pike" || dropped.profile.stash.length !== base.stash.length - 1) return "depot budget: the same loadout was not taken for a start at a way in";
  if (takeKit(base, epic).kit.weapons[0]?.kind !== "pike") return "depot budget: takeKit without a start no longer takes the loadout";
  if (!takeKit(base, free, "pad") || !takeKit(base, { ...emptyLoadout(), weapons: [1], keys: [5] }, "pad")) return "depot budget: a loadout within the allowance (the lent kit; a common and a key) was refused";
  if (takeKit(base, { ...emptyLoadout(), weapons: [1], armor: 2 }, "pad") !== null) return "depot budget: a common and tier 2 armour (3) started from a level 0 depot (2)";
  if (takeKit(base, epic, "wreck") !== null) return "depot budget: a start from a depot that is not on was allowed";
  const levelled = takeKit(p2, { ...emptyLoadout(), weapons: [0, 1] }, "pad");
  if (!levelled || levelled.kit.weapons.length !== 2) return "depot budget: a level 1 depot (4) refused an epic and a common (4)";
  if (takeKit(p2, { ...emptyLoadout(), weapons: [0, 1] }, "supply") !== null) return "depot budget: the supply depot was levelled by sends through the pad";
  return null;
}

/** The hideout: building takes exactly its items and credits, each module's benefit is real, the craft ends the game once. */
function checkHideout(): string | null {
  const count = (p: Profile, k: string) => p.stash.filter((i) => i.t === "valuable" && i.kind === k).length;
  const give = (p: Profile, list: [string, number][]): Profile => ({ ...p, stash: [...p.stash, ...list.flatMap(([k, n]) => Array.from({ length: n }, (): Item => ({ t: "valuable", kind: k as "fuse" }))) ] });
  // Every level asks only for kinds that bins or vaults hold, and only for modules that exist.
  for (const m of MODULES)
    for (const l of HIDEOUT[m].levels) {
      for (const [k] of l.items) if (!poisWith(k).length && !VAULT.valuables.some((set) => set.includes(k))) return `hideout scenario: ${m} needs ${k}, which no bin or vault holds`;
      for (const [o, n] of l.needs) if (!(o in HIDEOUT) || n > maxLevel(o) || o === m) return `hideout scenario: ${m} needs ${o} Lv${n}`;
    }
  // The trader sells the common parts from the start, and rarer valuables with each workbench level.
  const sells = (workbench: number, k: string) => wares({ ...newProfile(1), hideout: { ...emptyHideout(), workbench } }).some((i) => i.t === "valuable" && i.kind === k);
  if (!sells(0, "fuse") || sells(0, "board")) return "hideout scenario: the trader's valuables without a workbench are not just the common parts";
  if (!sells(1, "board") || !sells(1, "drive") || sells(1, "reactor")) return "hideout scenario: the workbench Lv1 trader does not sell boards and drives (and only them)";
  if (!sells(2, "core") || !sells(2, "reactor")) return "hideout scenario: the workbench Lv2 trader does not sell cores and reactors";
  if (sources("reactor")[0]?.share === undefined) return "hideout scenario: the reactor has no source";
  // The generator's first level: one fuse short it cannot be built; with them it takes exactly its items and credits.
  const gen = HIDEOUT.generator.levels[0];
  let p = { ...newProfile(), cash: 5000 };
  p = give(p, gen.items.map(([k, n]) => [k, k === "fuse" ? n - 1 : n]));
  if (canBuild(p, "generator") || build(p, "generator")) return "hideout scenario: the generator was built a fuse short";
  p = give(p, [["fuse", 1], ["board", 2]]);
  const before = p.stash.length;
  const built = build(p, "generator");
  if (!built || built.hideout.generator !== 1 || built.cash !== p.cash - gen.cash || built.stash.length !== before - gen.items.reduce((n, [, c]) => n + c, 0) || count(built, "fuse") !== 0 || count(built, "board") !== 2)
    return `hideout scenario: building the generator took ${p.cash - (built?.cash ?? p.cash)} credits and left ${built?.stash.length} things`;
  // The card names what is in the way: the parts still missing, or only the credits once they are all there.
  const fuseShort = give({ ...newProfile(), cash: 5000 }, gen.items.map(([k, n]) => [k, k === "fuse" ? n - 1 : n]));
  const broke = give({ ...newProfile(), cash: gen.cash - 50 }, gen.items);
  if (buildState(fuseShort, "generator") !== "あと 1 個" || buildState(broke, "generator") !== "あと 50 クレジット")
    return `hideout scenario: the generator's card said "${buildState(fuseShort, "generator")}" one fuse short and "${buildState(broke, "generator")}" 50 credits short`;
  // A level that needs another module's level waits for it.
  const inf = give({ ...newProfile(), cash: 9000 }, HIDEOUT.infirmary.levels[0].items);
  if (canBuild(inf, "infirmary") || !canBuild({ ...inf, hideout: { ...inf.hideout, generator: 1 } }, "infirmary")) return "hideout scenario: the infirmary did not wait for the generator";
  // The infirmary lends its heals to both kits; they never come home.
  const sick = { ...newProfile(), hideout: { ...emptyHideout(), infirmary: 2 } };
  const freeKit2 = takeKit(sick, { weapons: [], armor: null, heals: { cell: 0, battery: 0, syringe: 0, medkit: 0 }, keys: [] }).kit;
  const ownKit = takeKit(sick, { weapons: [0], armor: null, heals: { cell: 0, battery: 0, syringe: 0, medkit: 0 }, keys: [] }).kit;
  if (freeKit2.heals.syringe !== META.free.heals.syringe + 1 || freeKit2.heals.cell !== META.free.heals.cell + 2 || ownKit.heals.syringe !== 1 || ownKit.lentHeals.cell !== 2)
    return `hideout scenario: the infirmary's heals came out as ${JSON.stringify(freeKit2.heals)} (free) and ${JSON.stringify(ownKit.heals)} (own)`;
  // The loadout's heal picks stop where the lent heals leave no room: every pick is taken from the stash.
  const stocked: Profile = { ...sick, stash: [{ t: "weapon", kind: "pike", rarity: 0 }, ...Array.from({ length: HEALS.cell.max }, (): Item => ({ t: "heal", kind: "cell" }))] };
  for (const weapons of [[], [0]]) {
    const load = { weapons, armor: null, heals: { cell: 0, battery: 0, syringe: 0, medkit: 0 }, keys: [] };
    const room = healRoom(stocked, load, "cell");
    const kit = takeKit(stocked, { ...load, heals: { ...load.heals, cell: room } }).kit;
    if (kit.heals.cell - kit.lentHeals.cell !== room || kit.heals.cell > HEALS.cell.max || room !== HEALS.cell.max - kit.lentHeals.cell)
      return `hideout scenario: the loadout let ${room} cells be picked, the kit took ${kit.heals.cell - kit.lentHeals.cell} and lent ${kit.lentHeals.cell}`;
  }
  const healed = newRun(13, ownKit);
  healed.outcome = "extracted";
  if (settle(sick, healed).home.some((i) => i.t === "heal")) return "hideout scenario: the infirmary's lent heals came home";
  // The workbench raises the best rarity the trader sells.
  const best = (lv: number) => Math.max(...wares({ ...newProfile(), hideout: { ...emptyHideout(), workbench: lv } }).map((i) => (i.t === "weapon" ? i.rarity : i.t === "armor" ? i.tier : 0)));
  if (best(0) !== META.shopRarity || best(1) !== META.shopRarity + 1 || best(2) !== 3) return `hideout scenario: the trader sells up to ${best(0)}, ${best(1)}, ${best(2)} by workbench level`;
  // The storage holds more, and buying fills it.
  const roomy = { ...newProfile(), cash: 9999, hideout: { ...emptyHideout(), storage: 1 }, stash: Array.from({ length: META.stash }, (): Item => ({ t: "heal", kind: "cell" })) };
  if (stashCap(roomy.hideout) !== META.stash + 10 || !buy(roomy, wares(roomy)[0])) return "hideout scenario: the storage did not make room";
  // The pouch keeps more through a wipe.
  const wipe = newRun(14);
  wipe.outcome = "dead";
  wipe.player.haul = ["drive", "drive", "drive", "drive", "fuse"];
  const keptN = (lv: number) => settle({ ...newProfile(), hideout: { ...emptyHideout(), pouch: lv } }, wipe).home.length;
  if (keptN(0) !== META.pouch || keptN(1) !== META.pouch + 1 || keptN(2) !== META.pouch + 2) return `hideout scenario: a wipe kept ${keptN(0)}, ${keptN(1)}, ${keptN(2)} drives by pouch level`;
  // The radio tells of the raid the profile's seed starts: the same POI and kind, and its bins really lean that way.
  const radio = { ...newProfile(4321), hideout: { ...emptyHideout(), radio: 2 } };
  for (const region of REGIONS) {
    const told = boostFor(radio.seed, region.id);
    const raid = newRun(radio.seed, freeKit(), region.id);
    if (raid.boost.poi !== told.poi || raid.boost.kind !== told.kind || !region.pois.includes(POIS[told.poi].id)) return `hideout scenario: the radio told of ${JSON.stringify(told)}, the raid has ${JSON.stringify(raid.boost)}`;
    // Its bins opened on an empty island, with the raid's boost.
    const open = padRun();
    open.boost = raid.boost;
    const binsThere = open.bins.filter((b) => b.poi === told.poi && !b.vault && !b.outside);
    let got = 0;
    for (let i = 0; i < 60; i++) {
      const b = binsThere[i % binsThere.length];
      b.open = false;
      open.loot = [];
      open.player.search = { bin: open.bins.indexOf(b), t: 99 };
      open.player.pos = { x: b.x, y: b.y, z: b.z };
      step(open, idleInput(), false);
      if (open.loot.some((l) => l.kind === "valuable" && l.valuable === told.kind)) got++;
    }
    const plain = POIS[told.poi].loot.valuable;
    const plainShare = (plain.find(([k]) => k === told.kind)?.[1] ?? 0) / plain.reduce((n, [, w]) => n + w, 0);
    if (got / 60 < plainShare + 0.2) return `hideout scenario: the boosted ${POIS[told.poi].id} gave ${told.kind} from ${got} of 60 bins (${Math.round(plainShare * 100)}% unboosted)`;
  }
  if (boosted([["fuse", 3], ["drive", 1]], "drive").find(([k]) => k === "drive")?.[1] !== 5) return "hideout scenario: the boosted weights are off";
  const after = settle(radio, newRun(radio.seed)).profile;
  if (after.seed === radio.seed) return "hideout scenario: the next raid's seed did not move on";
  // The craft's last stage ends the playthrough once; the record is kept and the game goes on.
  const last = HIDEOUT.craft.levels.at(-1)!;
  const full = Object.fromEntries(MODULES.map((m) => [m, maxLevel(m)])) as Profile["hideout"];
  let end = give({ ...newProfile(), cash: last.cash, raids: 31, extracted: 25, time: 3600, hideout: { ...full, craft: maxLevel("craft") - 1 } }, last.items);
  end = build(end, "craft")!;
  if (!end?.escaped || end.escaped.raids !== 31 || end.escaped.extracted !== 25 || end.cash !== 0 || end.stash.some((i) => i.t === "valuable")) return `hideout scenario: finishing the craft left ${JSON.stringify(end?.escaped)} with ${end?.cash} credits`;
  if (build(give({ ...end, cash: 99999 }, last.items), "craft")) return "hideout scenario: the craft was built past its last stage";
  const later = settle(end, newRun(15));
  if (later.profile.escaped?.raids !== 31 || later.profile.raids !== 32) return "hideout scenario: the ending's record changed after another raid";
  // The trader's last quest is finished by the craft.
  const late = { ...end, escaped: null, hideout: { ...full, craft: maxLevel("craft") - 1 }, quests: { progress: {}, done: QUESTS.filter((q) => q.id !== "escape").map((q) => q.id) } };
  const fin = build(give({ ...late, cash: last.cash }, last.items), "craft");
  if (!fin?.quests.done.includes("escape") || !fin.escaped) return "hideout scenario: finishing the craft did not finish the last quest";
  // Saves: a v4 profile keeps its stash and starts with an empty hideout; a v5 one keeps its hideout.
  const v4 = { v: 4, cash: 900, stash: [{ t: "valuable", kind: "gyro" }, { t: "weapon", kind: "pike", rarity: 2 }, { t: "key", poi: "yard" }], raids: 9, extracted: 7, quests: { progress: {}, done: ["grunts"] }, region: "harbor" };
  const m4 = parseProfile(JSON.parse(JSON.stringify(v4)));
  if (!m4 || m4.v !== 16 || m4.stash.length !== 3 || m4.raids !== 9 || MODULES.some((m) => m4.hideout[m] !== 0) || m4.escaped || m4.region !== "harbor") return `storage scenario: a v4 save loaded as ${JSON.stringify(m4)}`;
  const m5 = parseProfile(JSON.parse(JSON.stringify(end)));
  if (!m5 || m5.hideout.craft !== maxLevel("craft") || m5.escaped?.raids !== 31 || m5.seed !== end.seed) return "storage scenario: a v5 save lost its hideout";
  // With one slot left, a valuable the hideout wants takes it ahead of gear; one it does not want is sold first.
  const tight = { ...newProfile(), stash: Array.from({ length: META.stash - 1 }, (): Item => ({ t: "heal", kind: "cell" })) };
  const back = newRun(16);
  back.outcome = "extracted";
  back.player.weapons = [{ kind: "lance", rarity: 2, mag: -1 }, null];
  back.player.haul = ["gyro"];
  const kept = settle(tight, back).profile.stash.at(-1);
  if (kept?.t !== "valuable" || kept.kind !== "gyro") return `full stash scenario: the last slot went to ${JSON.stringify(kept)}, not the gyro the hideout needs`;
  return null;
}

/** A vault stays shut without its POI's key, opens with it, and counts for the vault quest. */
function checkVault(): string | null {
  const s = padRun();
  const p = s.player;
  s.bins = [{ id: 9001, x: p.pos.x + 1, y: p.pos.y, z: p.pos.z, poi: QUARRY, open: false, flare: false, vault: true, outside: false }];
  const press = idleInput();
  press.interact = true;
  step(s, press, false);
  ticks(s, SEARCH.vaultTime + 1);
  if (s.bins[0].open || p.search) return "vault scenario: a vault opened without its key";
  p.keys = [QUARRY];
  step(s, press, false);
  ticks(s, SEARCH.vaultTime - 0.3);
  if (s.bins[0].open) return "vault scenario: the vault opened before its search time";
  ticks(s, 1);
  if (!s.bins[0].open || !s.stats.vaults.includes(QUARRY)) return "vault scenario: the key did not open the vault";
  const rare = s.loot.some((l) => l.kind === "weapon" && l.rarity >= 2) && s.loot.some((l) => l.kind === "armor" && l.rarity === 3);
  if (!rare && !p.haul.length) return "vault scenario: the vault held no better loot than a bin";
  // Every POI's vault has a key somewhere else on the island.
  const keyed = POIS.map((poi) => poi.keyFrom);
  if (new Set(keyed).size !== POIS.length || keyed.some((k, i) => k === POIS[i].id || poiIndex(k) < 0)) return `vault scenario: keys are found in ${keyed.join()}`;
  if (POIS.some((poi) => poi.bins.filter((b) => b.vault).length !== 1)) return "vault scenario: a POI does not have exactly one vault";
  // Bins out between the POIs never hold a key, whatever loot table they use.
  const out = padRun();
  const extra = out.bins.filter((b) => b.outside && !b.flare);
  let opened = 0;
  for (let i = 0; i < 60 && extra.length; i++) {
    const b = extra[i % extra.length];
    b.open = false;
    out.loot = [];
    out.player.search = { bin: out.bins.indexOf(b), t: 99 };
    out.player.pos = { x: b.x, y: b.y, z: b.z };
    step(out, idleInput(), false);
    if (b.open) opened++;
    if (out.loot.some((l) => l.kind === "key")) return "vault scenario: a bin outside the POIs dropped a key";
  }
  if (opened < 30) return `vault scenario: only ${opened} of 60 bins outside the POIs were opened to check for keys`;
  return null;
}

/**
 * The island's state: one settled raid is one day; a POI cleared in a raid the player gets off
 * alive is freed (its depot on), a freed one unvisited for `ISLAND.thinAfter` days goes thin, a
 * thin one cleared again is freed, and the titan's pad is never freed. A raid's garrison follows:
 * full while held, the vault guard and half the squads while thin, nobody once freed.
 */
function checkIsland(): string | null {
  const PADD = poiIndex("pad");
  const raid = (seed: number, o: { alive: boolean; cleared?: number[]; visited?: number[] }, island?: Profile["poiState"]) => {
    const s = newRun(seed, freeKit(), "reservoir", island ? { island: holds({ poiState: island }) } : {});
    s.outcome = o.alive ? "extracted" : "dead";
    s.stats.cleared = [...(o.cleared ?? [])];
    for (const i of o.visited ?? []) s.visited[i] = true;
    return s;
  };
  let p = newProfile();
  if (p.day !== 1 || POIS.some((o) => p.poiState[o.id].state !== "held")) return `island scenario: a new profile is on day ${p.day} with ${JSON.stringify(p.poiState)}`;
  // A wipe after clearing frees nothing, but it is a day.
  const wiped = settle(p, raid(11, { alive: false, cleared: [SUPPLY], visited: [SUPPLY] }));
  if (wiped.profile.day !== 2 || wiped.day !== 1 || wiped.freed.length || wiped.profile.poiState.supply.state !== "held") return `island scenario: a wipe after clearing the supply depot left ${JSON.stringify({ day: wiped.profile.day, freed: wiped.freed, supply: wiped.profile.poiState.supply })}`;
  // Getting off after clearing the supply depot and the titan's pad frees the depot only.
  const won = settle(p, raid(11, { alive: true, cleared: [SUPPLY, PADD], visited: [SUPPLY, PADD] }));
  p = won.profile;
  if (won.freed.join() !== "supply" || p.poiState.supply.state !== "freed" || p.poiState.pad.state !== "held" || !p.depots.includes("supply")) return `island scenario: clearing the supply depot and the pad and getting off freed ${won.freed.join()} with depots ${p.depots.join()}`;
  if (daysLeft(p, "supply") !== ISLAND.thinAfter) return `island scenario: a POI freed today has ${daysLeft(p, "supply")} days before it goes thin, not ${ISLAND.thinAfter}`;
  // Days pass without a visit: the last of them is announced, then the depot goes thin.
  const quiet = (q: Profile, seed: number) => settle(q, raid(seed, { alive: true, visited: [QUARRY] }, q.poiState));
  let q = p;
  for (let d = 1; d < ISLAND.thinAfter; d++) q = quiet(q, 20 + d).profile;
  if (q.poiState.supply.state !== "freed" || thinTomorrow(q).join() !== "supply" || !islandNotes(q).some((n) => n.t === "fading" && n.poi === "supply" && n.days === 1)) return `island scenario: a day before it goes thin, the supply depot is ${q.poiState.supply.state} and tomorrow says ${JSON.stringify(islandNotes(q))}`;
  const thinned = quiet(q, 30);
  if (thinned.thinned.join() !== "supply" || thinned.profile.poiState.supply.state !== "thin" || thinned.profile.day !== p.day + ISLAND.thinAfter) return `island scenario: ${ISLAND.thinAfter} days unvisited left the supply depot ${thinned.profile.poiState.supply.state} on day ${thinned.profile.day}`;
  // A visit puts it off: the depot freed on day 1 and visited on day 3 is still freed on day 5.
  let v = settle(p, raid(40, { alive: true, visited: [QUARRY] }, p.poiState)).profile;
  v = settle(v, raid(41, { alive: true, visited: [SUPPLY] }, v.poiState)).profile;
  v = settle(v, raid(42, { alive: true }, v.poiState)).profile;
  if (v.poiState.supply.state !== "freed" || daysLeft(v, "supply") !== ISLAND.thinAfter - 1) return `island scenario: a visit did not put off going thin (${JSON.stringify(v.poiState.supply)} on day ${v.day})`;
  // Thin stays thin while left alone with the network weak (checkNetwork() has it taken back when strong), and clearing it again frees it.
  let t = thinned.profile;
  for (let d = 0; d < 4; d++) t = quiet({ ...t, network: 0, pressure: 0 }, 50 + d).profile;
  if (t.poiState.supply.state !== "thin") return `island scenario: a thin POI left alone became ${t.poiState.supply.state}`;
  const again = settle(t, raid(60, { alive: true, cleared: [SUPPLY], visited: [SUPPLY] }, t.poiState));
  if (again.freed.join() !== "supply" || again.profile.poiState.supply.state !== "freed") return "island scenario: clearing a thin POI and getting off did not free it";
  // The garrisons: held in full and as with no island given, thin with half the squads and the vault guard, freed empty.
  const count = (s: State, i: number) => s.enemies.filter((e) => e.poi === i).length;
  const plain = newRun(77);
  const allHeld = newRun(77, freeKit(), "reservoir", { island: holds({ poiState: newIsland() }) });
  if (JSON.stringify(plain.enemies) !== JSON.stringify(allHeld.enemies) || plain.rng !== allHeld.rng) return "island scenario: a raid with every POI held is not the raid with no island given";
  const mixed = { ...newIsland(), supply: { state: "thin" as const, lastVisit: 1 }, quarry: { state: "freed" as const, lastVisit: 1 }, pad: { state: "freed" as const, lastVisit: 1 } };
  const m = newRun(77, freeKit(), "reservoir", { island: holds({ poiState: mixed }) });
  const full = (i: number) => POIS[i].squads.reduce((n, sq) => n + sq.members.length, 0);
  const thinSquads = garrison(SUPPLY, "thin", 77);
  const want = thinSquads.reduce((n, sq) => n + sq.members.length, 0);
  if (thinSquads.length !== Math.ceil(POIS[SUPPLY].squads.length * ISLAND.thinKeep) || !thinSquads.some(isVaultGuard)) return `island scenario: a thin supply depot keeps ${thinSquads.map((sq) => sq.name).join()}`;
  if (count(m, SUPPLY) !== want || want >= full(SUPPLY) || !m.enemies.some((e) => e.poi === SUPPLY && e.plate > 0)) return `island scenario: a thin supply depot stands ${count(m, SUPPLY)} robots (want ${want} of ${full(SUPPLY)}, the vault guard among them)`;
  if (garrison(SUPPLY, "thin", 77).map((sq) => sq.name).join() !== thinSquads.map((sq) => sq.name).join()) return "island scenario: a thin garrison is not fixed by the seed";
  if (count(m, QUARRY) !== 0 || !m.cleared[QUARRY] || !m.depots[depotIndex("quarry")]) return `island scenario: a freed quarry stands ${count(m, QUARRY)} robots, cleared ${m.cleared[QUARRY]}, depot ${m.depots[depotIndex("quarry")]}`;
  if (count(m, PADD) !== full(PADD) || m.hold[PADD] !== "held") return "island scenario: the titan's pad was freed";
  for (const i of [poiIndex("relay"), poiIndex("wreck"), poiIndex("yard"), poiIndex("smelter")]) if (count(m, i) !== full(i)) return `island scenario: a held ${POIS[i].id} stands ${count(m, i)} robots, not ${full(i)}`;
  // A freed POI is not cleared again in the raid, and its vault opens without the key.
  m.reinforceT = m.raiderT = 1e9;
  ticks(m, 1);
  if (m.stats.cleared.includes(QUARRY)) return "island scenario: a freed POI counted as cleared in the raid";
  const vault = m.bins.find((b) => b.poi === QUARRY && b.vault)!;
  const locked = m.bins.find((b) => b.poi === SUPPLY && b.vault)!;
  if (!canOpen(m, vault) || canOpen(m, locked)) return "island scenario: a freed POI's vault took its key, or a thin one's did not";
  // A quest to clear a POI freed before it was offered is done by coming into it.
  m.visited[QUARRY] = false;
  if (raidCredit({ t: "clear", poi: "quarry" }, m)) return "island scenario: a freed POI not come into counted for a quest to clear it";
  m.visited[QUARRY] = true;
  if (raidCredit({ t: "clear", poi: "quarry" }, m) !== 1) return "island scenario: coming into a freed POI did not count for a quest to clear it";
  // Saves: a v12 one is on the day after its raids with every POI held; a v13 one keeps its island, the pad held.
  const v12 = parseProfile(JSON.parse(JSON.stringify({ ...newProfile(), v: 12, raids: 6, day: undefined, poiState: undefined })));
  if (!v12 || v12.v !== 16 || v12.day !== 7 || POIS.some((o) => v12.poiState[o.id].state !== "held")) return `island scenario: a v12 save loaded on day ${v12?.day} with ${JSON.stringify(v12?.poiState)}`;
  const back = parseProfile(JSON.parse(JSON.stringify({ ...thinned.profile, poiState: { ...thinned.profile.poiState, pad: { state: "freed", lastVisit: 2 } } })));
  if (!back || back.day !== thinned.profile.day || back.poiState.supply.state !== "thin" || back.poiState.pad.state !== "held") return `island scenario: a v13 save loaded as ${JSON.stringify(back && { day: back.day, poiState: back.poiState })}`;
  return null;
}

/**
 * The network level (網の段階): the sim gate's level is today's island exactly; each level's
 * times and numbers apply in `newRun()`; the relay masts stand only from `NETWORK.relayAt`, and
 * one shot down counts; over scripted days the network falls a step for each POI freed (the
 * relay two), the titan and each mast, rises with the days, faster the more POIs are held, and
 * a thin POI goes back to held while it is strong; the board offers a mast to destroy only then,
 * and settling a raid that destroyed it pays and counts it.
 */
function checkNetwork(): string | null {
  // The level the gate plays is the island before the network had levels.
  const play = NETWORK.levels[NETWORK.play];
  const regionPacks = (r: RegionId) => PACKS.filter((q) => regionHere(q.patrol![0]).id === r).length;
  if (play.reinforce.first !== REINFORCE.first || play.reinforce.every !== REINFORCE.every || play.raiders !== RAIDERS.at || play.plate !== 0 || REGIONS.some((r) => play.parties[r.id] !== PARTY.count[r.id] || play.packs[r.id] !== regionPacks(r.id)))
    return `network scenario: level ${NETWORK.play}, which the gate plays, is not the island's own numbers`;
  const plainRun = newRun(321);
  const atPlay = newRun(321, freeKit(), "reservoir", { network: NETWORK.play });
  const sameAs = (a: State, b: State) => JSON.stringify([a.enemies, a.squads, a.rng, a.roamRng, a.nextId, a.parties]) === JSON.stringify([b.enemies, b.squads, b.rng, b.roamRng, b.nextId, b.parties]);
  if (!sameAs(plainRun, atPlay) || plainRun.network !== NETWORK.play || plainRun.relays.length) return "network scenario: a raid with no network given is not the raid at the gate's level";
  // Each level's numbers, at the start of a raid in each region.
  for (let n = 0; n <= NETWORK.max; n++) {
    const l = NETWORK.levels[n];
    if (n > 0 && (l.reinforce.first > NETWORK.levels[n - 1].reinforce.first || l.reinforce.every > NETWORK.levels[n - 1].reinforce.every || l.raiders > NETWORK.levels[n - 1].raiders || l.plate < NETWORK.levels[n - 1].plate)) return `network scenario: level ${n} is easier than level ${n - 1}`;
    for (const seed of [5, 91]) {
      const s = newRun(seed, freeKit(), "reservoir", { network: n });
      if (s.reinforceT !== l.reinforce.first || s.raiderT !== l.raiders) return `network scenario: a raid at level ${n} waits ${s.reinforceT} s and ${s.raiderT} s, not ${l.reinforce.first} and ${l.raiders}`;
      for (const r of REGIONS) if (s.parties.filter((q) => q.region === r.id).length !== l.parties[r.id]) return `network scenario: a raid at level ${n} has ${s.parties.filter((q) => q.region === r.id).length} parties in ${r.id}, not ${l.parties[r.id]}`;
      const packs = s.squads.filter((q) => q.pack);
      for (const r of REGIONS) {
        const mine = packs.filter((q) => regionHere(q.patrol[0]).id === r.id).length;
        if (mine !== Math.min(l.packs[r.id], regionPacks(r.id))) return `network scenario: a raid at level ${n} flies ${mine} packs in ${r.id}, not ${l.packs[r.id]}`;
      }
      if (JSON.stringify(activePacks(seed, n).map((q) => q.name)) !== JSON.stringify(activePacks(seed, n).map((q) => q.name))) return "network scenario: the packs flying are not fixed by the seed";
      // Plates: none added at or under the gate's level; about the level's share of the plain grunts and heavies above it.
      const plain = s.enemies.filter((e) => (e.kind === "grunt" || e.kind === "heavy") && !e.elite && !POIS.some((o) => o.squads.some((sq) => sq.members.some((m) => m.plate !== undefined && Math.hypot(m.x - e.home.x, m.z - e.home.z) < 1.5))));
      const plated = plain.filter((e) => e.plate > 0).length / Math.max(1, plain.length);
      if (l.plate === 0 ? plated > 0 : Math.abs(plated - l.plate) > 0.2) return `network scenario: ${(plated * 100).toFixed(0)}% of the plain grunts and heavies wear a plate at level ${n} (seed ${seed}), not about ${l.plate * 100}%`;
      // The masts and their guards stand only from relayAt.
      const want = n >= NETWORK.relayAt ? RELAYS.length : 0;
      const guards = s.squads.filter((q) => RELAYS.some((r) => r.guards.name === q.name)).length;
      if (s.relays.length !== want || guards !== want || s.relays.some((m) => m.hp !== MAST.hp)) return `network scenario: a raid at level ${n} stands ${s.relays.length} masts and ${guards} guard squads, not ${want}`;
    }
  }
  // A mast shot down: the post and the eye take hits, the eye more, and it counts once fallen.
  const s = newRun(8, freeKit(), "reservoir", { network: NETWORK.relayAt });
  s.enemies = [];
  s.reinforceT = s.raiderT = 1e9;
  const mast = s.relays[0];
  const shootAt = (y: number) => {
    s.player.pos = { x: mast.x, y: mast.y, z: mast.z + 14 };
    s.player.yaw = 0;
    const eye = eyePos(s);
    const d = { x: mast.x - eye.x, y: mast.y + y - eye.y, z: mast.z - eye.z };
    const len = Math.hypot(d.x, d.y, d.z);
    const before = mast.hp;
    s.events = [];
    fireRay(s, { kind: "pike", rarity: 0, mag: 24 }, { x: d.x / len, y: d.y / len, z: d.z / len });
    return before - mast.hp;
  };
  const post = shootAt(4);
  const eyeHit = shootAt(MAST.height + MAST.eyeR * 0.6);
  if (!(post > 0) || !(eyeHit > post * 1.5) || !s.events.some((e) => e.t === "relayHit" && e.eye)) return `network scenario: a shot at the mast's post took ${post} and at its eye ${eyeHit}`;
  for (let i = 0; i < 200 && mast.hp > 0; i++) shootAt(5);
  if (mast.hp > 0 || s.stats.relays.join() !== mast.id || !s.events.some((e) => e.t === "relayDown")) return `network scenario: shooting the mast ${mast.id} down left ${mast.hp} hp and counted ${s.stats.relays.join()}`;
  shootAt(5);
  if (s.stats.relays.length !== 1) return "network scenario: a fallen mast counted twice";
  // A body walking into a standing mast is pushed round it.
  s.player.pos = { x: s.relays[1].x + 0.2, y: s.relays[1].y, z: s.relays[1].z };
  ticks(s, 0.1);
  if (Math.hypot(s.player.pos.x - s.relays[1].x, s.player.pos.z - s.relays[1].z) < MAST.radius) return "network scenario: the player stands inside a standing mast";
  // Over scripted days: nothing freed from a new profile takes the network to the top in about nine days.
  const day = (o: Partial<RaidDay> = {}): RaidDay => ({ alive: true, cleared: [], visited: [], titan: false, relays: [], ...o });
  let p: Profile = newProfile(3);
  if (p.network !== NETWORK.start || p.pressure !== 0) return `network scenario: a new profile starts at ${p.network}`;
  let top = 0;
  for (let d = 1; d <= 20 && !top; d++) {
    p = advanceDay(p, day()).profile;
    if (p.network === NETWORK.max) top = d;
  }
  if (top < 8 || top > 10) return `network scenario: with nothing freed the network reached ${NETWORK.max} after ${top} days, not 8 to 10`;
  if (p.pressure !== 0) return "network scenario: the network at the top kept gathering";
  // The steps down, each in its own night, and the order: down first, then the day's rise.
  const at = (network: number, pressure = 0): Profile => ({ ...newProfile(3), network, pressure });
  const idle = (from: Profile, days: number): Profile => Array.from({ length: days }).reduce<Profile>((q) => advanceDay(q, day()).profile, from);
  const freedOne = advanceDay(at(4), day({ cleared: ["supply"] })).change.network;
  const freedRelay = advanceDay(at(4), day({ cleared: ["relay"] })).change.network;
  const titan = advanceDay(at(4), day({ titan: true })).change.network;
  const masts = advanceDay(at(4), day({ relays: ["west", "east"] })).change.network;
  const all = advanceDay(at(2), day({ cleared: ["relay", "quarry"], titan: true, relays: ["west"] })).change.network;
  const wipe = advanceDay(at(4), day({ alive: false, cleared: ["supply"], titan: true, relays: ["west"] })).change.network;
  if (freedOne.to !== 3 || freedOne.freed !== 1 || freedRelay.to !== 2 || freedRelay.freed !== 2 || titan.to !== 3 || masts.to !== 2 || masts.relays !== 2) return `network scenario: steps down ${JSON.stringify({ freedOne, freedRelay, titan, masts })}`;
  if (all.to !== 0 || all.from !== 2) return `network scenario: steps below 0 left ${JSON.stringify(all)}`;
  if (wipe.freed !== 0 || wipe.titan !== 1 || wipe.relays !== 1 || wipe.to !== 2) return `network scenario: a wipe counted ${JSON.stringify(wipe)} (the titan and the mast count, the POI is not freed)`;
  // The pressure is carried: a night that frees a POI keeps what was gathered, and the step comes when it fills.
  const kept = advanceDay(at(3, 1.5), day({ cleared: ["supply"] }));
  if (kept.change.network.rise !== 1 || kept.profile.network !== 3 || Math.abs(kept.profile.pressure - (1.5 + netGain(kept.profile.poiState) - NETWORK.riseEvery)) > 1e-9) return `network scenario: freeing with pressure 1.5 left ${JSON.stringify({ net: kept.change.network, pressure: kept.profile.pressure })}`;
  // The more POIs held, the faster it rises.
  const freedAll = Object.fromEntries(POIS.map((o) => [o.id, { state: o.boss ? "held" : "freed", lastVisit: 1, since: 0 }])) as Profile["poiState"];
  if (!(netGain(newIsland()) > netGain(freedAll))) return "network scenario: a held island does not raise the network faster than a freed one";
  if (riseIn(at(2, 0)) !== Math.ceil(NETWORK.riseEvery / netGain(newIsland())) || riseIn(at(NETWORK.max)) !== null) return `network scenario: the rise is told in ${riseIn(at(2, 0))} days`;
  const notes = islandNotes(at(3, 1.9)).map(noteText);
  if (!notes.some((t) => t.includes("網は次のレイドの後に 4 に上がる"))) return `network scenario: 明日の島 says ${notes.join(" / ")}`;
  // Thin back to held: thin two days while the network is strong, not while it is weak.
  const thinIsland = (since: number) => ({ ...newIsland(), quarry: { state: "thin" as const, lastVisit: 1, since } });
  const strong: Profile = { ...at(NETWORK.retakeAt), day: 6, poiState: thinIsland(6) };
  const told = islandNotes(strong).map(noteText);
  if (retakeIn(strong, "quarry") !== NETWORK.retakeAfter || !told.some((t) => t === `採掘場は手薄。放っておくと、あと ${NETWORK.retakeAfter} 日で支配に戻る`)) return `network scenario: a thin quarry at a strong network is told as ${told.join(" / ")}`;
  const one = advanceDay(strong, day());
  const two = advanceDay(one.profile, day());
  if (one.profile.poiState.quarry.state !== "thin" || two.profile.poiState.quarry.state !== "held" || two.change.retaken.join() !== "quarry") return `network scenario: a thin quarry at network ${NETWORK.retakeAt} is ${one.profile.poiState.quarry.state} then ${two.profile.poiState.quarry.state}`;
  let weak: Profile = { ...at(NETWORK.retakeAt - 1), day: 6, poiState: thinIsland(6) };
  for (let d = 0; d < 4; d++) weak = { ...advanceDay(weak, day()).profile, network: NETWORK.retakeAt - 1, pressure: 0 };
  if (weak.poiState.quarry.state !== "thin") return "network scenario: a thin POI went back to held at a weak network";
  // One step short, the night the network rises to `retakeAt` is the night it takes the POI back;
  // two steps short, the night of the second rise.
  if (retakeIn(weak, "quarry") !== riseIn(weak)) return `network scenario: a thin quarry one step short of a retake is told ${retakeIn(weak, "quarry")} days, the rise ${riseIn(weak)}`;
  const weaker: Profile = { ...weak, network: NETWORK.retakeAt - 2 };
  const firstRise = riseIn(weaker);
  const afterFirst = firstRise === null ? null : idle(weaker, firstRise);
  const secondRise = afterFirst && riseIn(afterFirst);
  if (firstRise === null || !secondRise || retakeIn(weaker, "quarry") !== firstRise + secondRise) return `network scenario: a thin quarry two steps short of a retake is told ${retakeIn(weaker, "quarry")} days, the rises ${firstRise} and ${secondRise}`;
  // A day that starts at the top gathers no pressure, whatever takes the network down in the raid.
  for (const cut of [day({ relays: ["west", "east"] }), day({ titan: true }), day({ cleared: ["supply"] })]) {
    const off = advanceDay(at(NETWORK.max), cut);
    if (off.profile.pressure !== 0 || off.change.network.rise !== 0 || off.profile.network >= NETWORK.max) return `network scenario: a day starting at the top that took the network down ended with ${JSON.stringify({ net: off.change.network, pressure: off.profile.pressure })}`;
  }
  // Every forecast is what stepping idle days through advanceDay() shows.
  const mixed = (freed: PoiId[], thin: PoiId[]): Profile["poiState"] => ({ ...newIsland(), ...Object.fromEntries(freed.map((id) => [id, { state: "freed" as const, lastVisit: 7, since: 0 }])), ...Object.fromEntries(thin.map((id) => [id, { state: "thin" as const, lastVisit: 2, since: 6 }])) });
  const islands = [newIsland(), mixed(["supply"], ["quarry"]), mixed(["supply", "yard"], []), mixed([], ["quarry", "wreck"]), mixed(["relay", "smelter"], ["supply"])];
  for (const poiState of islands)
    for (const network of [0, 1, NETWORK.retakeAt - 1, NETWORK.retakeAt, NETWORK.max])
      for (const pressure of network >= NETWORK.max ? [0] : [0, 0.9, 1.95]) {
        const f: Profile = { ...at(network, pressure), day: 8, poiState };
        let g: Profile = f;
        let rose: number | null = null;
        const back = new Map<PoiId, number>();
        const fades = new Map<PoiId, number>();
        for (let d = 1; d <= FORECAST_DAYS; d++) {
          const prev = g;
          g = advanceDay(g, day()).profile;
          if (rose === null && g.network > f.network) rose = d;
          for (const o of POIS) {
            if (f.poiState[o.id].state === "thin" && !back.has(o.id) && g.poiState[o.id].state === "held") back.set(o.id, d);
            if (f.poiState[o.id].state === "freed" && !fades.has(o.id) && prev.poiState[o.id].state === "freed" && g.poiState[o.id].state !== "freed") fades.set(o.id, d);
          }
        }
        if (riseIn(f) !== rose) return `network scenario: at network ${network}, pressure ${pressure}, the rise is told in ${riseIn(f)} days but comes after ${rose}`;
        for (const o of POIS) {
          const thin = f.poiState[o.id].state === "thin" ? (back.get(o.id) ?? null) : null;
          const freed = f.poiState[o.id].state === "freed" ? (fades.get(o.id) ?? null) : null;
          if (retakeIn(f, o.id) !== thin || daysLeft(f, o.id) !== freed) return `network scenario: at network ${network}, pressure ${pressure}, ${o.id} is told ${retakeIn(f, o.id)} / ${daysLeft(f, o.id)} days but stepping shows ${thin} / ${freed}`;
        }
      }
  // A POI gone thin overnight is not taken back the same night.
  const fade: Profile = { ...at(5), day: 9, poiState: { ...newIsland(), supply: { state: "freed", lastVisit: 2, since: 0 } } };
  const faded = advanceDay(fade, day());
  if (faded.profile.poiState.supply.state !== "thin" || faded.change.retaken.length) return "network scenario: a POI gone thin was taken back the same night";
  // The board: a mast to destroy only while the masts stand, paid when it falls.
  for (const seed of [1, 77, 4242])
    for (let n = 0; n <= NETWORK.max; n++) {
      const b = makeBoard({ ...newProfile(seed), seed, network: n, entries: ENTRIES.map((e) => e.id) });
      const destroy = b.contracts.filter((c) => c.t === "destroy");
      if (destroy.length !== (n >= NETWORK.relayAt ? 1 : 0) || b.contracts.length < 3 || b.contracts.length > 4) return `network scenario: the board at network ${n} (seed ${seed}) has ${b.contracts.map((c) => c.t).join()}`;
      for (const c of b.contracts) if (c.t === "intercept" && c.target.t === "pack" && !activePacks(seed, n).some((q) => q.name === (c.target as { name: string }).name)) return `network scenario: the board at network ${n} names a pack that does not fly: ${c.target.name}`;
    }
  let q: Profile = { ...newProfile(5), network: NETWORK.relayAt, entries: ENTRIES.map((e) => e.id) };
  q = { ...q, board: makeBoard(q) };
  const job = q.board.contracts.find((c) => c.t === "destroy")!;
  q = take(q, job.id);
  const r = newRun(q.seed, freeKit(), "reservoir", { network: q.network });
  r.outcome = "dead";
  r.stats.relays = [(job as { relay: RelayId }).relay];
  const paid = settle(q, r);
  if (!paid.contract?.done || paid.profile.cash !== q.cash + job.reward.cash || paid.network.relays !== 1 || paid.network.to !== NETWORK.relayAt - 1 + paid.network.rise) return `network scenario: destroying the named mast settled as ${JSON.stringify({ contract: paid.contract?.done, cash: paid.profile.cash - q.cash, net: paid.network })}`;
  const missed = settle(q, newRun(q.seed, freeKit(), "reservoir", { network: q.network }));
  if (missed.contract?.done) return "network scenario: a raid that destroyed no mast did the contract";
  // Saves: before v15 a profile starts at NETWORK.start; a v15 one keeps its level and pressure.
  const v14 = parseProfile(JSON.parse(JSON.stringify({ ...newProfile(), v: 14, network: undefined, pressure: undefined })));
  if (!v14 || v14.network !== NETWORK.start || v14.pressure !== 0) return `network scenario: a v14 save loaded at network ${v14?.network}`;
  // Its board was made before the network chose the packs that fly: it is made anew at the migrated level.
  if (JSON.stringify(v14.board) !== JSON.stringify(makeBoard({ ...v14, board: undefined } as unknown as Profile))) return "network scenario: a v14 save kept a board made before the network";
  const v15 = parseProfile(JSON.parse(JSON.stringify({ ...newProfile(), network: 4, pressure: 1.25 })));
  if (!v15 || v15.network !== 4 || v15.pressure !== 1.25) return `network scenario: a v15 save loaded at network ${v15?.network} with pressure ${v15?.pressure}`;
  return null;
}

/**
 * The contract board: boards built for a few days and island states hold valid contracts and stay
 * fixed for their day; one contract of each type taken and done in a scripted raid pays its
 * reward, and not done pays nothing; the story's record lies on the island only while its story
 * is the one under way, and coming home with it moves the story on.
 */
function checkContracts(): string | null {
  const poisOf = (c: Contract) => (c.t === "intercept" ? -1 : poiIndex(c.poi));
  const islands = [
    newIsland(),
    { ...newIsland(), supply: { state: "freed" as const, lastVisit: 1 }, quarry: { state: "thin" as const, lastVisit: 1 } },
    Object.fromEntries(POIS.map((o) => [o.id, { state: o.boss ? ("held" as const) : ("freed" as const), lastVisit: 1 }])) as Profile["poiState"],
  ];
  const hideouts = [emptyHideout(), { ...emptyHideout(), generator: 1, infirmary: 1, workbench: 1 }];
  for (const seed of [1, 77, 4242])
    for (let day = 1; day <= 6; day++)
      for (const poiState of islands)
        for (const hideout of hideouts) {
          const basis = { ...newProfile(seed), seed, day, poiState, hideout, entries: ENTRIES.map((e) => e.id) };
          const b = makeBoard(basis);
          const where = `seed ${seed} day ${day}`;
          if (JSON.stringify(b) !== JSON.stringify(makeBoard(basis))) return `contract scenario: the board for ${where} is not fixed by the seed and the day`;
          if (b.day !== day || b.contracts.length < 3 || b.contracts.length > 4 || new Set(b.contracts.map((c) => c.id)).size !== b.contracts.length) return `contract scenario: the board for ${where} has ${b.contracts.length} contracts (${b.contracts.map((c) => c.id).join()})`;
          if (!b.contracts.some((c) => c.t === "fetch") || !b.contracts.some((c) => c.t === "intercept")) return `contract scenario: the board for ${where} lacks a fetch or an intercept`;
          const freeable = POIS.filter((o) => !o.boss && poiState[o.id].state !== "freed");
          if (freeable.length && !b.contracts.some((c) => c.t === "free")) return `contract scenario: the board for ${where} offers no POI to free though ${freeable.map((o) => o.id).join()} are held`;
          for (const c of b.contracts) {
            if (c.reward.cash <= 0) return `contract scenario: ${c.id} pays nothing`;
            if (c.t === "free" && (poisOf(c) < 0 || POIS[poisOf(c)].boss || poiState[c.poi].state === "freed")) return `contract scenario: ${where} asks to free ${c.poi}, which is ${poiState[c.poi]?.state}`;
            if (c.t === "fetch") {
              const poi = POIS[poisOf(c)];
              if (!poi || !poi.loot.valuable.some(([k]) => k === c.kind) || c.n < 1 || c.n > poi.bins.filter((x) => !x.vault).length) return `contract scenario: ${where} asks for ${c.n} ${c.kind} from ${c.poi}, whose bins do not hold that many`;
              // What the next buildable level lacks comes first.
              const lacking = MODULES.flatMap((m) => {
                const l = nextLevel(hideout, m);
                return l && !unmet(hideout, l).length ? l.items.map(([k]) => k) : [];
              }).filter((k) => POIS.some((o) => o.loot.valuable.some(([v]) => v === k)));
              if (lacking.length && !lacking.includes(c.kind)) return `contract scenario: ${where} asks for ${c.kind}, which no buildable level lacks (${lacking.join()})`;
              // The raid the contract is taken into holds that many in the POI's own bins, whatever they roll.
              const raid = newRun(seed, freeKit(), poiRegion(c.poi).id, { fetch: { poi: c.poi, kind: c.kind, n: c.n } });
              const held = raid.fetch?.bins.filter((id) => raid.bins.some((x) => x.id === id && x.poi === poisOf(c) && !x.vault && !x.outside)).length ?? 0;
              if (held !== c.n || raid.fetch?.kind !== c.kind) return `contract scenario: ${where}'s raid holds ${held} of the ${c.n} ${c.kind} its fetch contract asks of ${c.poi}`;
            }
            if (c.t === "intercept" && !(c.target.t === "pack" ? PACKS.some((q) => q.name === (c.target as { name: string }).name) : PARTY.count[c.target.region] > 0)) return `contract scenario: ${where} names a target that does not exist: ${JSON.stringify(c.target)}`;
          }
        }
  // The board stands for the day; settling the day rerolls it and drops the contract taken.
  let p = { ...newProfile(9), entries: ENTRIES.map((e) => e.id) };
  p = { ...p, board: makeBoard(p) };
  const firstBoard = JSON.stringify(p.board);
  const bought = buy({ ...p, cash: 99999 }, { t: "valuable", kind: "fuse" })!;
  if (JSON.stringify(parseProfile(JSON.parse(JSON.stringify(bought)))!.board) !== firstBoard) return "contract scenario: a saved board changed with the stash";
  const withTaken = take(p, p.board.contracts[1].id);
  if (takenContract(withTaken)?.id !== p.board.contracts[1].id || take(withTaken, null).taken !== null || take(p, "nowhere").taken !== null) return "contract scenario: taking and letting go of a contract";
  const nextDay = settle(withTaken, newRun(3));
  if (nextDay.profile.taken !== null || nextDay.profile.board.day !== p.day + 1 || JSON.stringify(nextDay.profile.board) === firstBoard) return `contract scenario: the next day kept ${nextDay.profile.taken} on a board for day ${nextDay.profile.board.day}`;
  if (nextDay.contract?.done !== false) return "contract scenario: a contract not done was not reported as such";

  /** A profile on `p`'s day that took `c`, its board holding only it. */
  const taking = (c: Contract): Profile => ({ ...p, board: { day: p.day, contracts: [c] }, taken: c.id });
  const paid = (before: Profile, r: ReturnType<typeof settle>, c: Contract) => r.contract?.done && r.profile.cash >= before.cash + c.reward.cash;
  // Free: the supply depot cleared, and the player got off alive; a wipe after clearing it does not.
  const free: Contract = { t: "free", id: "t-free", poi: "supply", reward: { cash: 1200, items: [] } };
  const fr = newRun(21);
  fr.stats.cleared = [SUPPLY];
  fr.visited[SUPPLY] = true;
  fr.outcome = "extracted";
  const frDone = settle(taking(free), fr);
  if (!paid(taking(free), frDone, free) || frDone.profile.poiState.supply.state !== "freed") return `contract scenario: freeing the supply depot left ${JSON.stringify(frDone.contract)}`;
  fr.outcome = "dead";
  const frLost = settle(taking(free), fr);
  if (frLost.contract?.done || frLost.profile.cash !== taking(free).cash) return "contract scenario: a wipe after clearing paid the contract to free it";
  // Fetch: a bin of the POI tags what it spills; only those come home for the contract, from the bag or a depot.
  const bin = padRun();
  const bp = bin.player;
  bin.bins = [{ id: 9101, x: bp.pos.x + 1, y: bp.pos.y, z: bp.pos.z, poi: RELAY, open: false, flare: false, vault: false, outside: false }];
  const press = idleInput();
  press.interact = true;
  step(bin, press, false);
  ticks(bin, SEARCH.time + 2);
  if (bp.haul.length < 1 || bp.haulAt.length !== bp.haul.length || bp.haulAt[0] !== RELAY) return `contract scenario: a valuable from a relay bin is tagged ${bp.haulAt.join()} (haul ${bp.haul.join()})`;
  const outside = padRun();
  outside.bins = [{ id: 9103, x: outside.player.pos.x + 1, y: outside.player.pos.y, z: outside.player.pos.z, poi: RELAY, open: false, flare: false, vault: false, outside: true }];
  step(outside, press, false);
  ticks(outside, SEARCH.time + 2);
  if (outside.player.haulAt[0] !== -1) return `contract scenario: a valuable from a bin outside the POIs is tagged ${outside.player.haulAt.join()}`;
  const fetch: Contract = { t: "fetch", id: "t-fetch", poi: "relay", kind: "drive", n: 2, reward: { cash: 550, items: [{ t: "valuable", kind: "drive" }] } };
  const fetchRun = (froms: number[], outcome: "extracted" | "dead", send = false) => {
    const f = padRun();
    for (const from of froms) f.loot.push({ id: 9200 + froms.length + f.loot.length, kind: "valuable", valuable: "drive", rarity: 2, from, pos: { ...f.player.pos }, vel: { x: 0, y: 0, z: 0 }, age: 1 });
    ticks(f, 0.3);
    if (send) {
      f.depots[depotIndex("pad")] = true;
      const d = DEPOTS[depotIndex("pad")];
      f.player.pos = { x: d.x, y: d.y, z: d.z + 1 };
      step(f, press, false);
    }
    f.outcome = outcome;
    return f;
  };
  const got = fetchRun([RELAY, RELAY], "extracted");
  if (got.player.haulAt.join() !== `${RELAY},${RELAY}`) return `contract scenario: picked-up drives are tagged ${got.player.haulAt.join()}`;
  const fDone = settle(taking(fetch), got);
  const drives = (q: Profile) => q.stash.filter((i) => i.t === "valuable" && i.kind === "drive").length;
  if (!paid(taking(fetch), fDone, fetch) || drives(fDone.profile) !== 3) return `contract scenario: bringing home 2 relay drives left ${JSON.stringify(fDone.contract)} with ${drives(fDone.profile)} drives`;
  if (settle(taking(fetch), fetchRun([RELAY, SUPPLY], "extracted")).contract?.done) return "contract scenario: a drive from another POI counted for the relay's";
  // On a wipe the pouch's slots come home: two drives do, a third is lost.
  if (!settle(taking(fetch), fetchRun([RELAY, RELAY], "dead")).contract?.done) return `contract scenario: two drives the pouch (${META.pouch} slots) kept through a wipe did not count`;
  if (settle(taking({ ...fetch, n: 3 }), fetchRun([RELAY, RELAY, RELAY], "dead")).contract?.done) return "contract scenario: a drive lost in a wipe counted";
  const sent = fetchRun([RELAY, RELAY], "dead", true);
  if (sent.sentAt.join() !== `${RELAY},${RELAY}` || !settle(taking(fetch), sent).contract?.done) return `contract scenario: relay drives sent from a depot before a wipe did not count (sent from ${sent.sentAt.join()})`;
  // Intercept: every member of the named pack destroyed, which counts on a wipe as well; a party by its region.
  const pack: Contract = { t: "intercept", id: "t-pack", target: { t: "pack", name: PACKS[0].name }, reward: { cash: 500, items: [{ t: "heal", kind: "medkit" }] } };
  const ir = newRun(31);
  const foes = ir.enemies.filter((e) => squadKey(ir.squads[e.squad]) === targetKey(pack.target));
  if (foes.length !== PACKS[0].members.length) return `contract scenario: the ${PACKS[0].name} has ${foes.length} robots in a raid`;
  kill(ir, foes[0], false);
  ir.outcome = "dead";
  if (settle(taking(pack), ir).contract?.done) return "contract scenario: half a pack destroyed counted";
  kill(ir, foes[1], false, "ally");
  const iDone = settle(taking(pack), ir);
  if (!ir.stats.wiped.includes(PACKS[0].name) || !paid(taking(pack), iDone, pack) || !iDone.profile.stash.some((i) => i.t === "heal" && i.kind === "medkit")) return `contract scenario: destroying the ${PACKS[0].name} left ${JSON.stringify(iDone.contract)}`;
  const party: Contract = { t: "intercept", id: "t-party", target: { t: "party", region: "reservoir" }, reward: { cash: 800, items: [] } };
  const pr = newRun(32);
  const slot = pr.parties.find((q) => q.region === "reservoir" && q.squad >= 0)!;
  for (const e of pr.enemies.filter((o) => o.squad === slot.squad)) kill(pr, e, false);
  pr.outcome = "extracted";
  if (!settle(taking(party), pr).contract?.done) return "contract scenario: destroying one of the reservoir's hunting parties did not count";
  if (contractDone(party, { freed: [], home: [], wiped: ["party:harbor"] })) return "contract scenario: the harbor's party counted for the reservoir's";

  // Story: only the record under way lies on the island, on its spot; home, it moves the story on.
  if (newRun(41).loot.some((l) => l.kind === "record")) return "story scenario: a raid with no record given has one";
  let q = newProfile(5);
  for (const [n, story] of STORIES.entries()) {
    const now = currentStory(q.records);
    if (now?.id !== story.id) return `story scenario: after ${n} records the story under way is ${now?.id}, not ${story.id}`;
    const r = newRun(50 + n, freeKit(), "reservoir", { record: now.id });
    const recs = r.loot.filter((l) => l.kind === "record");
    const spot = RECORD_SPOTS.find((o) => o.id === now.id)!;
    if (recs.length !== 1 || recs[0].record !== now.id) return `story scenario: the ${now.id} raid lays ${recs.map((l) => l.record).join()}`;
    // It stays where it lies: on the floor of its building.
    r.enemies = [];
    ticks(r, 0.5);
    const lying = r.loot.find((l) => l.kind === "record")!;
    if (Math.hypot(lying.pos.x - spot.x, lying.pos.z - spot.z) > 0.05 || Math.abs(lying.pos.y - spot.y) > 0.35) return `story scenario: the ${now.id} record fell to ${lying.pos.x.toFixed(1)},${lying.pos.y.toFixed(1)},${lying.pos.z.toFixed(1)} from its spot`;
    r.player.pos = { x: spot.x, y: spot.y, z: spot.z };
    r.player.vel = { x: 0, y: 0, z: 0 };
    ticks(r, 0.3);
    if (r.player.records.join() !== now.id || bagLoad(r.player) !== 1) return `story scenario: walking onto the ${now.id} record carries ${r.player.records.join()} in ${bagLoad(r.player)} slots`;
    // A wipe keeps it in the pouch, before anything else.
    r.outcome = n === 0 ? "dead" : "extracted";
    if (n === 0) r.player.haul = ["drive", "drive", "drive"];
    const cash = q.cash;
    const done = settle(q, r);
    if (done.story?.id !== now.id || !done.profile.records.includes(now.id) || done.profile.cash < cash + now.cash) return `story scenario: bringing the ${now.id} record home left ${JSON.stringify(done.story)}, records ${done.profile.records.join()}`;
    q = done.profile;
  }
  if (currentStory(q.records) !== null) return "story scenario: a story is under way after the last record";
  const saved = parseProfile(JSON.parse(JSON.stringify(q)));
  if (saved?.records.join() !== STORIES.map((t) => t.id).join()) return `story scenario: a save kept the records ${saved?.records.join()}`;
  return null;
}

/** Quests open in order, count raids (kills even on a wipe), pay on finishing, and take deliveries. */
function checkQuests(): string | null {
  let p = newProfile();
  const first = offered(p.quests).map((q) => q.id).join();
  if (first !== "grunts,village") return `quest scenario: the first quests offered are ${first}`;
  if (QUESTS.some((q) => q.after.some((a) => !QUESTS.find((o) => o.id === a)))) return "quest scenario: a quest comes after one that does not exist";
  const { profile, kit } = takeKit(p, { weapons: [], armor: null, heals: { cell: 0, battery: 0, syringe: 0, medkit: 0 }, keys: [] });
  const s = newRun(7, kit);
  s.outcome = "dead";
  s.stats.killsBy.grunt = 5;
  let r = settle(profile, s);
  if (r.profile.quests.progress.grunts !== 5 || r.quests.length) return `quest scenario: 5 grunt kills on a wipe left ${JSON.stringify(r.profile.quests)}`;
  s.stats.killsBy.grunt = 3;
  s.outcome = "extracted";
  s.extractedAt = "village";
  const cash = r.profile.cash;
  r = settle(r.profile, s);
  if (r.quests.map((q) => q.id).sort().join() !== "grunts,village") return `quest scenario: the raid finished ${r.quests.map((q) => q.id).join()}`;
  if (r.profile.cash !== cash + 600 + 500 || r.profile.quests.progress.grunts !== undefined) return "quest scenario: rewards were not paid";
  if (!offered(r.profile.quests).some((q) => q.id === "parts")) return "quest scenario: finishing the first quest did not open the next";
  p = { ...r.profile, stash: [...r.profile.stash, { t: "valuable", kind: "parts" }, { t: "valuable", kind: "parts" }] };
  if (deliver(p, "parts") !== p) return "quest scenario: delivered with too few parts";
  p = { ...p, stash: [...p.stash, { t: "valuable", kind: "parts" }] };
  const d = deliver(p, "parts");
  if (d.stash.some((i) => i.t === "valuable" && i.kind === "parts") || !d.quests.done.includes("parts") || !d.stash.some((i) => i.t === "weapon" && i.kind === "pike" && i.rarity === 1)) return "quest scenario: the delivery did not take the parts and pay the PIKE";
  // Keys go along and come home; a v1 save loads with an empty quest log.
  const withKey = { ...newProfile(), stash: [...newProfile().stash, { t: "key" as const, poi: "relay" as const }] };
  const k = takeKit(withKey, { weapons: [0], armor: null, heals: { cell: 0, battery: 0, syringe: 0, medkit: 0 }, keys: [withKey.stash.length - 1] });
  const ks = newRun(8, k.kit);
  if (ks.player.keys.join() !== `${RELAY}` || k.profile.stash.some((i) => i.t === "key")) return "key scenario: the key did not go into the raid";
  ks.outcome = "extracted";
  // A second copy found on the island comes home as well.
  ks.loot = [{ id: 9200, kind: "key", key: RELAY, rarity: 3, pos: { ...ks.player.pos }, vel: { x: 0, y: 0, z: 0 }, age: 1 }];
  ks.phase = "play";
  step(ks, idleInput(), false);
  ks.outcome = "extracted";
  const copies = settle(k.profile, ks).profile.stash.filter((i) => i.t === "key" && i.poi === "relay").length;
  if (copies !== 2) return `key scenario: carrying a key and finding another brought home ${copies}, not 2`;
  // One slot left: a quest's reactor, dearer than a fuse from the same raid and wanted as much, takes it.
  const tight = { ...newProfile(), stash: Array.from({ length: META.stash - 1 }, () => ({ t: "heal" as const, kind: "cell" as const })), quests: { progress: {}, done: ["grunts", "parts", "power", "craft", "navigator", "control"] } };
  const tk = takeKit(tight, { weapons: [], armor: null, heals: { cell: 0, battery: 0, syringe: 0, medkit: 0 }, keys: [] });
  const ts = newRun(10, tk.kit, "harbor");
  ts.outcome = "extracted";
  ts.player.haul = ["fuse"];
  ts.stats.cleared = [poiIndex("smelter")];
  const tr = settle(tk.profile, ts);
  const last = tr.profile.stash.at(-1);
  if (tr.quests[0]?.id !== "furnace" || last?.t !== "valuable" || last.kind !== "reactor" || !tr.sold.some((i) => i.t === "valuable" && i.kind === "fuse")) return `quest scenario: with one slot left the stash kept ${JSON.stringify(last)} and sold ${JSON.stringify(tr.sold)}`;
  const v1 = parseProfile({ v: 1, cash: 10, stash: [], raids: 2, extracted: 1 });
  if (!v1 || v1.v !== 16 || v1.quests.done.length || v1.region !== "reservoir") return "storage scenario: a v1 save does not load";
  // v2 saves named a key's POI by its place in the list; it loads as that POI's id.
  const v2 = parseProfile({ v: 2, cash: 10, stash: [{ t: "key", poi: 2 }, { t: "key", poi: 9 }], raids: 1, extracted: 1, quests: { progress: {}, done: [] } });
  const v2Key = v2?.stash[0];
  if (!v2 || v2.v !== 16 || v2.stash.length !== 1 || v2Key?.t !== "key" || v2Key.poi !== "relay") return `storage scenario: a v2 save's key 2 loaded as ${JSON.stringify(v2?.stash)}, not the relay key`;
  // A v3 save keeps its keys by id and drops into the reservoir; the landing choice is kept.
  const v3 = parseProfile({ v: 3, cash: 10, stash: [{ t: "key", poi: "wreck" }], raids: 1, extracted: 1, quests: { progress: {}, done: [] } });
  if (!v3 || v3.v !== 16 || v3.stash.length !== 1 || v3.region !== "reservoir") return `storage scenario: a v3 save loaded as ${JSON.stringify(v3)}`;
  if (parseProfile(JSON.parse(JSON.stringify({ ...newProfile(), region: "harbor", entries: ["beach", "outskirts"] })))?.region !== "harbor") return "storage scenario: the landing choice did not survive a save";
  // The intro quests come first, the craft's line after the generator; a quest chain from before the board loads with the quests there still are.
  if (QUESTS.filter((q) => q.intro).map((q) => q.id).join() !== "grunts,village,power,parts") return `quest scenario: the intro quests are ${QUESTS.filter((q) => q.intro).map((q) => q.id).join()}`;
  const v13 = parseProfile(JSON.parse(JSON.stringify({ ...newProfile(), v: 13, board: undefined, taken: undefined, records: undefined, stash: [{ t: "weapon", kind: "talon", rarity: 3 }, { t: "key", poi: "yard" }], quests: { progress: { drones: 2, heavies: 1, parts: 0 }, done: ["grunts", "drones", "quarry", "relay", "power"] } })));
  if (!v13 || v13.v !== 16 || v13.quests.done.join() !== "grunts,power" || Object.keys(v13.quests.progress).join() !== "parts" || v13.stash.length !== 2 || v13.records.length || v13.taken !== null || v13.board.day !== v13.day || !v13.board.contracts.length)
    return `quest scenario: a v13 save with the old quests loaded as ${JSON.stringify(v13 && { v: v13.v, quests: v13.quests, stash: v13.stash.length, board: v13.board.contracts.length })}`;
  if (offered(v13.quests).map((q) => q.id).join() !== "village,parts,craft") return `quest scenario: the migrated save is offered ${offered(v13.quests).map((q) => q.id).join()}`;
  return null;
}

/**
 * Open level ground in the reservoir: from `left` metres to the -x side of (x, z) to `right`
 * metres to the +x side, and `dist` metres toward -z, clear of boxes, for a fight in the open.
 */
function openSpot(dist: number, left: number, right: number): { x: number; z: number } | null {
  const [lx, lz] = inArea("supply", 0, -174);
  const land = { x: lx, z: lz };
  for (let ring = 0; ring < 400; ring += 4)
    for (let a = 0; a < 2 * Math.PI; a += 4 / Math.max(ring, 8)) {
      const x = land.x + Math.cos(a) * ring;
      const z = land.z + Math.sin(a) * ring;
      if (!inWorld(x, z, 5) || offLowGround(x, z)) continue;
      const g = terrainHeight(x, z);
      let ok = !BOXES.some((b) => b.x1 > x - left && b.x0 < x + right && b.z1 > z - dist - 2 && b.z0 < z + 2 && b.y0 < g + 3);
      for (let dx = -left; dx <= right && ok; dx += 1)
        for (let dz = -2; dz <= dist + 2 && ok; dz += 1) if (Math.abs(terrainHeight(x + dx, z - dz) - g) > 0.5) ok = false;
      if (ok) return { x, z };
    }
  return null;
}

/**
 * The player alone at (x, z), facing -z, and an engaged squad of `kinds` standing `dist`
 * metres away toward -z, facing the player. No teammate.
 */
function standoff(at: { x: number; z: number }, dist: number, kinds: EnemyKind[]) {
  const s = padRun();
  const p = s.player;
  s.ally.active = false;
  p.pos = { x: at.x, y: 0, z: at.z };
  p.pos.y = groundAt(at.x, at.z, 0.4, terrainHeight(at.x, at.z) + 2);
  p.vel = { x: 0, y: 0, z: 0 };
  p.yaw = 0;
  p.pitch = 0;
  p.onGround = true;
  const squad = s.squads.length;
  s.squads.push({ name: "test", poi: -1, patrol: [], leg: 0, engaged: false, roam: false, sinceSeen: 0, last: { x: at.x, z: at.z } });
  const foes = kinds.map((k, i) => spawnEnemy(s, k, at.x + (i - (kinds.length - 1) / 2) * 2.5, at.z - dist, -1, squad, { face: Math.PI }));
  engageSquad(s, squad, foes[0]);
  // Every foe faces the player and has seen them: the usual fight, not an ambush.
  for (const e of foes) {
    e.blind = 0;
    e.sawAt = { x: p.pos.x, z: p.pos.z };
  }
  return { s, foes, squad };
}

/**
 * A fast bolt aimed through the player hits even when its positions before and after a
 * tick fall on either side of the player.
 */
function checkBoltNoTunnel(): string | null {
  const at = openSpot(16, 2, 9);
  if (!at) return "bolt scenario: no open ground for the test";
  const speed = ENEMIES.grunt.orbSpeed;
  const perTick = speed * TICK;
  // Start so that after 5 ticks the bolt is half a tick short of the player, and after 6 half a tick past.
  const back = perTick * 5.5;
  // Straight through the middle, and grazing: 0.55 m to the side, inside the 0.58 m reach of bolt and body.
  for (const side of [0, 0.55]) {
    const t = standoff(at, 15, ["grunt"]).s;
    t.enemies = [];
    const q = t.player;
    t.orbs.push({ id: t.nextId++, pos: { x: q.pos.x + side, y: q.pos.y + 1.2, z: q.pos.z - back }, vel: { x: 0, y: 0, z: speed }, r: ENEMIES.grunt.orbR, dmg: 10, life: 5, homing: false });
    let hit = false;
    for (let i = 0; i < 10; i++) {
      step(t, idleInput(), false);
      if (t.events.some((e) => e.t === "hurt")) hit = true;
    }
    if (!hit) return `bolt scenario: a grunt bolt ${side ? "grazing" : "straight through"} the player passed without hitting`;
  }
  // The teammate just in front of the player, both within one tick of the bolt's travel: the bolt
  // reaches the teammate first and stops there, whatever order the bodies are tested in.
  const t = standoff(at, 15, ["grunt"]).s;
  t.enemies = [];
  const q = t.player;
  t.ally.active = true;
  t.ally.down = 0;
  t.ally.pos = { x: q.pos.x, y: q.pos.y, z: q.pos.z - 0.6 };
  t.orbs.push({ id: t.nextId++, pos: { x: q.pos.x, y: q.pos.y + 1.2, z: q.pos.z - perTick + 0.05 }, vel: { x: 0, y: 0, z: speed }, r: ENEMIES.grunt.orbR, dmg: 10, life: 5, homing: false });
  step(t, idleInput(), false);
  const playerHit = t.events.some((e) => e.t === "hurt");
  const allyHit = t.events.some((e) => e.t === "allyHurt");
  if (playerHit || !allyHit) return `bolt scenario: a bolt went past the teammate in front and ${playerHit ? "hit" : "missed"} the player behind`;
  // Overlapping bodies: the bolt passes through the teammate's middle and grazes the player's edge.
  // It enters the teammate first even though it comes closest to the player's axis first.
  const u = standoff(at, 15, ["grunt"]).s;
  u.enemies = [];
  const w = u.player;
  u.ally.active = true;
  u.ally.down = 0;
  const allyAt = () => ({ x: w.pos.x - 0.5, y: w.pos.y, z: w.pos.z + 0.1 });
  u.ally.pos = allyAt();
  u.orbs.push({ id: u.nextId++, pos: { x: w.pos.x - 0.5, y: w.pos.y + 1.2, z: w.pos.z - 0.75 }, vel: { x: 0, y: 0, z: speed }, r: ENEMIES.grunt.orbR, dmg: 10, life: 5, homing: false });
  step(u, idleInput(), false);
  if (u.events.some((e) => e.t === "hurt") || !u.events.some((e) => e.t === "allyHurt")) return "bolt scenario: a bolt hit the player it only grazed instead of the teammate it entered first";
  // A steep bolt that goes through the player and into the ground within one tick still hits.
  const v = standoff(at, 15, ["grunt"]).s;
  v.enemies = [];
  const g = v.player;
  const down = { x: 0, y: -96, z: 36 };
  v.orbs.push({ id: v.nextId++, pos: { x: g.pos.x, y: g.pos.y + 1.3, z: g.pos.z - 0.65 }, vel: down, r: ENEMIES.grunt.orbR, dmg: 10, life: 5, homing: false });
  step(v, idleInput(), false);
  if (!v.events.some((e) => e.t === "hurt")) return "bolt scenario: a bolt that went through the player into the ground in one tick did no damage";
  return null;
}

/** A pickup's waves find their way like reinforcements: they beam in behind cover and must get round it. */
function checkPickupWavesRouted(): string | null {
  const s = padRun();
  const ship = EXTRACTS.find((x) => x.id === "ship")!;
  const p = s.player;
  p.pos = { x: ship.x, y: groundAt(ship.x, ship.z, 0.4, 20), z: ship.z };
  p.iframes = 999;
  holdSpot(s, SHIP_WAVES.first + 0.2);
  const wave = s.enemies.find((e) => s.squads[e.squad]?.name === SHIP_SQUAD);
  if (!wave) return "pickup-wave scenario: no wave came";
  return s.squads[wave.squad].routed ? null : "pickup-wave scenario: a pickup's wave squad walks straight at the pickup instead of finding its way";
}

/** A pickup's later waves fight once its squad is fighting: they do not stand by as "alert" robots. */
function checkLaterWaveFights(): string | null {
  const s = padRun();
  const ship = EXTRACTS.find((x) => x.id === "ship")!;
  const p = s.player;
  p.pos = { x: ship.x, y: groundAt(ship.x, ship.z, 0.4, 20), z: ship.z };
  p.iframes = 999;
  holdSpot(s, SHIP_WAVES.first + 0.2);
  const first = s.enemies.find((e) => s.squads[e.squad]?.name === SHIP_SQUAD);
  if (!first) return "later-wave scenario: no first wave";
  // No teammate: its fire could bring the first wave down before the next one joins it.
  s.ally.active = false;
  engageSquad(s, first.squad, first);
  holdSpot(s, SHIP_WAVES.every + 0.2);
  const idle = s.enemies.filter((e) => e.squad === first.squad && e.aware !== "engaged");
  if (s.enemies.filter((e) => e.squad === first.squad).length < 3) return "later-wave scenario: the second wave did not come";
  return idle.length ? `later-wave scenario: ${idle.length} robots of a later wave joined a fighting squad without fighting` : null;
}

/**
 * A clear line of `dist` metres over the walkable ground: the player's spot and a squad's spot
 * that far away, both on open level ground with nothing between the player's chest and a grunt's eye.
 */
function longLine(dist: number): { p: { x: number; z: number }; g: { x: number; z: number } } | null {
  const ok = (x: number, z: number) => inWorld(x, z, 5) && onMainGround(x, z) && !offLowGround(x, z) && !steepAt(x, z) && !solidAt(x, terrainHeight(x, z) + 0.4, z) && !solidAt(x, terrainHeight(x, z) + 1.2, z);
  for (let x = WORLD.x0 + 20; x < WORLD.x1 - 20; x += 23)
    for (let z = WORLD.z0 + 20; z < WORLD.z1 - 20; z += 23) {
      if (!ok(x, z)) continue;
      for (let a = 0; a < 2 * Math.PI; a += Math.PI / 6) {
        const gx = x + Math.sin(a) * dist;
        const gz = z - Math.cos(a) * dist;
        // A second grunt stands 2.5 m to the side of the first, where checkReturnFire() puts it
        // (its bearing to the player is a + π).
        const sx = -Math.cos(a) * 2.5;
        const sz = -Math.sin(a) * 2.5;
        if (!ok(gx, gz) || !ok(gx + sx, gz + sz) || Math.abs(terrainHeight(gx, gz) - terrainHeight(x, z)) > 3) continue;
        // Clear from the player's knees to their head to each grunt's legs and eyes: open ground
        // between, not a line that only grazes over a crest at one height.
        const seen = [0.5, 1.1, 1.6].every((py) =>
          [[gx, gz], [gx + sx, gz + sz]].every(([qx, qz]) =>
            [1.0, KINDS.grunt.weakY].every((qy) => los({ x, y: terrainHeight(x, z) + py, z }, { x: qx, y: terrainHeight(qx, qz) + qy, z: qz })),
          ),
        );
        if (!seen) continue;
        return { p: { x, z }, g: { x: gx, z: gz } };
      }
    }
  return null;
}

/**
 * Shots from beyond a robot's sight are answered (see RETURN): a squad of two grunts minding
 * their posts 90 m or 130 m off, side-on to the player, with a clear line between, is hit once
 * and fires back within 4 s. At 130 m a squad that is not shot does not notice the player at all.
 */
function checkReturnFire(): string | null {
  for (const dist of [90, 130]) {
    const line = longLine(dist);
    if (!line) return `return-fire scenario: no clear line of ${dist} m for the test`;
    for (const hit of [true, false]) {
      if (!hit && dist < 130) continue;
      const s = padRun();
      s.ally.active = false;
      const p = s.player;
      p.pos = { x: line.p.x, y: groundAt(line.p.x, line.p.z, 0.4, terrainHeight(line.p.x, line.p.z) + 2), z: line.p.z };
      p.vel = { x: 0, y: 0, z: 0 };
      p.onGround = true;
      const squad = s.squads.length;
      s.squads.push({ name: "test", poi: -1, patrol: [], leg: 0, engaged: false, roam: false, sinceSeen: 0, last: { ...line.g } });
      const toPlayer = Math.atan2(line.p.x - line.g.x, -(line.p.z - line.g.z));
      const sx = Math.cos(toPlayer) * 2.5;
      const sz = Math.sin(toPlayer) * 2.5;
      const foes = [spawnEnemy(s, "grunt", line.g.x, line.g.z, -1, squad, { face: toPlayer + Math.PI / 2 }), spawnEnemy(s, "grunt", line.g.x + sx, line.g.z + sz, -1, squad, { face: toPlayer + Math.PI / 2 })];
      if (hit) damageEnemy(s, foes[0], 30, false, bodyCenter(foes[0]), "ambush", "player", 0);
      let fired = 0;
      for (let i = 0; i < (hit ? 4 : 8) / TICK && s.phase === "play"; i++) {
        p.iframes = 1;
        step(s, idleInput(), false);
        fired += s.events.filter((e) => e.t === "enemyFire" && foes.some((f) => f.id === e.id)).length;
      }
      if (hit && !fired) return `return-fire scenario: a grunt squad shot from ${dist} m did not fire back within 4 s (${foes.map((f) => `${f.aware} ${f.mode} ${dist2d(f.pos, p.pos).toFixed(0)} m`).join(", ")})`;
      if (!hit && foes.some((f) => f.aware !== "idle")) return `return-fire scenario: a grunt squad ${dist} m off noticed a player who did not shoot it (${foes.map((f) => f.aware).join(", ")})`;
    }
  }
  return null;
}

/**
 * A grunt's burst at 15 m in the open finds a player who sidesteps through the glow and the
 * shots: two of its three shots on average over bursts with different draws of its spread, so
 * the check holds whatever the rest of the world spent of the random stream first.
 */
function checkSidestepHit(): string | null {
  const at = openSpot(16, 2, 9);
  if (!at) return "sidestep scenario: no open ground for the test";
  const BURSTS = 12;
  let hits = 0;
  for (let k = 0; k < BURSTS; k++) {
    const { s, foes } = standoff(at, 15, ["grunt"]);
    s.rng = 1000 + k * 7919;
    const g = foes[0];
    g.mode = "telegraph";
    g.timer = KINDS.grunt.telegraph;
    g.cooldown = 99;
    const strafe = idleInput();
    strafe.moveX = 1;
    for (let i = 0; i < 1.6 / TICK; i++) {
      step(s, strafe, false);
      hits += s.events.filter((e) => e.t === "hurt").length;
      s.player.iframes = 0;
    }
  }
  if (hits < 2 * BURSTS) return `sidestep scenario: a player strafing in the open at 15 m took ${(hits / BURSTS).toFixed(2)} of a grunt's 3 shots on average`;
  return null;
}

/** The same burst stops on a wall: a player crouched behind cover takes nothing. */
function checkWallStops(): string | null {
  for (const c of COVERS) {
    // The box is on the far side of the cover point: its face's normal is the tangent turned a quarter.
    for (const sgn of [1, -1]) {
      const nx = -c.tz * sgn;
      const nz = c.tx * sgn;
      const gx = c.x - nx * 15;
      const gz = c.z - nz * 15;
      const g0 = terrainHeight(c.x, c.z);
      // The player stands where the spot is: not on the ground beneath an upper floor's spot, nor up on a crate beside it.
      if (Math.abs(c.y - g0) > 0.5 || Math.abs(groundAt(c.x, c.z, 0.4, g0 + 2) - g0) > 0.3 || offLowGround(c.x, c.z) || offLowGround(gx, gz) || Math.abs(terrainHeight(gx, gz) - g0) > 0.8 || solidAt(gx, terrainHeight(gx, gz) + 1, gz)) continue;
      const s = padRun();
      s.ally.active = false;
      const p = s.player;
      p.pos = { x: c.x, y: groundAt(c.x, c.z, 0.4, g0 + 2), z: c.z };
      p.onGround = true;
      p.crouch = true;
      const squad = s.squads.length;
      s.squads.push({ name: "test", poi: -1, patrol: [], leg: 0, engaged: false, roam: false, sinceSeen: 0, last: { x: c.x, z: c.z } });
      const g = spawnEnemy(s, "grunt", gx, gz, -1, squad, { face: Math.atan2(c.x - gx, -(c.z - gz)) });
      if (los({ x: g.pos.x, y: g.pos.y + 1.8, z: g.pos.z }, { x: p.pos.x, y: p.pos.y + 0.9, z: p.pos.z })) continue;
      // A step out along the face would put the player in the grunt's sight: only the cover is in the way.
      const out = (k: number) => los({ x: g.pos.x, y: g.pos.y + 1.8, z: g.pos.z }, { x: p.pos.x + c.tx * k, y: p.pos.y + 1.1, z: p.pos.z + c.tz * k });
      if (!out(4) && !out(-4)) continue;
      engageSquad(s, squad, g);
      // It saw the player stand up a moment ago and aims where it saw them.
      const aim = lookAngles({ x: g.pos.x, y: g.pos.y + KINDS.grunt.weakY - 0.1, z: g.pos.z }, { x: p.pos.x, y: p.pos.y + 1.1, z: p.pos.z });
      g.aimYaw = aim.yaw;
      g.aimPitch = aim.pitch;
      g.mode = "fire";
      g.timer = 0;
      g.shotsLeft = 3;
      const hold = idleInput();
      hold.crouch = true;
      let hurt = 0;
      // Held where it stands: grunts strafe through a burst, and a step out round the cover is a fair shot, not one through the wall.
      const at = { ...g.pos };
      for (let i = 0; i < 1.2 / TICK; i++) {
        step(s, hold, true);
        g.pos = { ...at };
        hurt += s.events.filter((e) => e.t === "hurt").length;
      }
      if (hurt) return `wall scenario: a player crouched behind cover took ${hurt} shots through it`;
      return null;
    }
  }
  return "wall scenario: no cover to test with";
}

/** A player standing still in front of an engaged 3-grunt squad ends up with a grunt at their side. */
function checkPinch(): string | null {
  const at = openSpot(19, 4, 4);
  if (!at) return "pinch scenario: no open ground for the test";
  const { s, foes } = standoff(at, 18, ["grunt", "grunt", "grunt"]);
  const p = s.player;
  const lead = foes[0];
  let widest = 0;
  for (let i = 0; i < 14 / TICK; i++) {
    p.iframes = 1; // stands there whatever comes
    step(s, idleInput(), false);
    const la = Math.atan2(lead.pos.x - p.pos.x, lead.pos.z - p.pos.z);
    for (const e of foes.slice(1)) {
      if (!s.enemies.includes(e)) continue;
      const off = Math.abs(Math.atan2(Math.sin(Math.atan2(e.pos.x - p.pos.x, e.pos.z - p.pos.z) - la), Math.cos(Math.atan2(e.pos.x - p.pos.x, e.pos.z - p.pos.z) - la)));
      widest = Math.max(widest, off);
    }
  }
  if (widest < 60 * (Math.PI / 180)) return `pinch scenario: after 14 s standing still, the widest grunt was ${(widest * 180 / Math.PI).toFixed(0)} deg off the front grunt`;
  return null;
}

/**
 * Hit and run does not shake a squad off: three grunts trade fire with the player for 2 s, the
 * player sprints by a real path to a spot 20-30 m away that breaks every grunt's sight within
 * its first 6 m, waits 3 s and does it again from there. In most of the first scenarios found
 * round the POIs the squad is still fighting 12 s later and has found the player again.
 */
function checkPursuit(): string | null {
  const flat = (x: number, z: number) => inWorld(x, z, 5) && !offLowGround(x, z) && !steepAt(x, z) && !solidAt(x, terrainHeight(x, z) + 1, z) && !solidAt(x, terrainHeight(x, z) + 0.3, z);
  const chestAt = (x: number, z: number) => ({ x, y: terrainHeight(x, z) + 1.2, z });
  // A spot 20-30 m away by a path of at most 50 m, out of every robot's sight after the path's first 6 m.
  const hideSpot = (s: State) => {
    const p = s.player;
    const eyes = s.enemies.map((f) => ({ x: f.pos.x, y: f.pos.y + KINDS.grunt.weakY, z: f.pos.z }));
    const seen = (x: number, z: number) => eyes.some((e) => los(e, chestAt(x, z)));
    let best: { pts: { x: number; z: number }[]; len: number } | null = null;
    for (let r = 20; r <= 30; r += 2)
      for (let b = 0; b < 2 * Math.PI; b += Math.PI / 12) {
        const x = p.pos.x + Math.cos(b) * r;
        const z = p.pos.z + Math.sin(b) * r;
        if (!flat(x, z) || Math.abs(terrainHeight(x, z) - p.pos.y) > 4 || seen(x, z) || s.enemies.some((f) => dist2d(f.pos, { x, z }) < 20)) continue;
        const path = findPath(p.pos.x, p.pos.z, x, z);
        if (!path) continue;
        const pts = [{ x: p.pos.x, z: p.pos.z }, ...path, { x, z }];
        let len = 0;
        let late = false;
        for (let i = 1; i < pts.length && !late; i++) {
          const d = dist2d(pts[i - 1], pts[i]);
          for (let u = 0; u < d && !late; u++) late = len + u > 6 && seen(pts[i - 1].x + ((pts[i].x - pts[i - 1].x) * u) / d, pts[i - 1].z + ((pts[i].z - pts[i - 1].z) * u) / d);
          len += d;
        }
        if (!late && len <= 50 && (!best || len < best.len)) best = { pts, len };
      }
    return best;
  };
  let tried = 0;
  let caught = 0;
  const log: string[] = [];
  for (let pi = 0; pi < POIS.length && tried < 4; pi++) {
    if (POIS[pi].boss) continue;
    for (const r0 of [20, 28, 38, 48])
      for (let a = 0; a < 2 * Math.PI && tried < 4; a += Math.PI / 9) {
        const p0 = { x: POIS[pi].x + Math.cos(a) * r0, z: POIS[pi].z + Math.sin(a) * r0 };
        if (!flat(p0.x, p0.z)) continue;
        const ux = Math.cos(a);
        const uz = Math.sin(a);
        const at = [-1, 0, 1].map((k) => ({ x: p0.x + ux * 18 - uz * k * 2.5, z: p0.z + uz * 18 + ux * k * 2.5 }));
        if (!at.every((f) => flat(f.x, f.z) && los({ x: f.x, y: terrainHeight(f.x, f.z) + KINDS.grunt.weakY, z: f.z }, chestAt(p0.x, p0.z)))) continue;
        const s = padRun();
        const p = s.player;
        s.ally.active = false;
        const hold = (q: { x: number; z: number }) => {
          p.pos = { x: q.x, y: groundAt(q.x, q.z, 0.4, terrainHeight(q.x, q.z) + 2), z: q.z };
          p.vel = { x: 0, y: 0, z: 0 };
        };
        hold(p0);
        const squad = s.squads.length;
        s.squads.push({ name: "test", poi: -1, patrol: [], leg: 0, engaged: false, roam: false, sinceSeen: 0, last: { ...p0 } });
        const foes = at.map((f) => spawnEnemy(s, "grunt", f.x, f.z, -1, squad, { face: Math.atan2(-ux, uz) }));
        engageSquad(s, squad, foes[0]);
        for (const e of foes) {
          e.blind = 0;
          e.sawAt = { ...p0 };
        }
        // The player does not go down: it is the squad's moves being measured.
        const tick = (q?: { x: number; z: number }) => {
          p.hp = 1e4;
          p.shield = 0;
          step(s, idleInput(), false);
          if (q) hold(q);
        };
        const run = (pts: { x: number; z: number }[]) => {
          for (let i = 1; i < pts.length; i++) {
            const d = dist2d(pts[i - 1], pts[i]);
            if (d < 1e-3) continue;
            const n = Math.ceil(d / (PLAYER.sprint * TICK));
            for (let k = 1; k <= n; k++) {
              tick({ x: pts[i - 1].x + ((pts[i].x - pts[i - 1].x) * k) / n, z: pts[i - 1].z + ((pts[i].z - pts[i - 1].z) * k) / n });
              p.vel = { x: ((pts[i].x - pts[i - 1].x) / d) * PLAYER.sprint, y: 0, z: ((pts[i].z - pts[i - 1].z) / d) * PLAYER.sprint };
            }
          }
        };
        for (let i = 0; i < 2 / TICK; i++) tick(p0);
        const first = hideSpot(s);
        if (!first) continue;
        run(first.pts);
        const mid = { x: p.pos.x, z: p.pos.z };
        for (let i = 0; i < 3 / TICK; i++) tick(mid);
        const again = hideSpot(s);
        if (!again) continue;
        run(again.pts);
        if (s.squads[squad].sinceSeen < 0.5) continue; // still in sight on arrival: not hidden
        tried++;
        const hide = { x: p.pos.x, z: p.pos.z };
        let found = false;
        for (let i = 0; i < 12 / TICK; i++) {
          tick(hide);
          found ||= s.squads[squad].sinceSeen === 0;
        }
        if (found && s.squads[squad].engaged) caught++;
        log.push(`${POIS[pi].id} at ${r0} m, ${Math.round((a * 180) / Math.PI)} deg: ${found ? "found" : "not found"}`);
      }
  }
  if (tried < 4) return `pursuit scenario: only ${tried} scenarios with a way to hide`;
  if (caught < 3) return `pursuit scenario: a squad hit and run from twice found the player again in ${caught} of ${tried} (${log.join("; ")})`;
  return null;
}

/** Healing is heard: a robot 7 m away looking the other way comes to look. */
function checkHealHeard(): string | null {
  const s = padRun();
  const p = s.player;
  s.ally.active = false;
  p.shield = 0;
  const squad = s.squads.length;
  s.squads.push({ name: "test", poi: -1, patrol: [], leg: 0, engaged: false, roam: false, sinceSeen: 0, last: { x: 0, z: 0 } });
  const g = spawnEnemy(s, "grunt", p.pos.x, p.pos.z + 7, -1, squad, { face: Math.PI });
  if (los({ x: g.pos.x, y: g.pos.y + 1.8, z: g.pos.z }, { x: p.pos.x, y: p.pos.y + 1.2, z: p.pos.z }) === false) return "heal scenario: a wall between the robot and the player";
  const press = idleInput();
  press.heal = true;
  step(s, press, false);
  ticks(s, 0.2);
  if (!p.healing && s.events.every((e) => e.t !== "healDone")) return "heal scenario: no heal started";
  if (g.aware === "idle") return "heal scenario: a robot 7 m away did not hear the player heal";
  return null;
}

/** Position decides: the same TALON weak-point shot drops an unaware grunt or one shot from behind, and only dents one facing the player. */
function checkPositionMatters(): string | null {
  const shot = (aware: boolean, behind: boolean) => {
    const s = newRun(5);
    s.phase = "play";
    s.enemies = [];
    const squad = s.squads.length;
    s.squads.push({ name: "test", poi: -1, patrol: [], leg: 0, engaged: false, roam: false, sinceSeen: 0, last: { x: 0, z: 0 } });
    const p = s.player;
    p.onGround = true;
    const eye = eyePos(s);
    const g = spawnEnemy(s, "grunt", eye.x, eye.z - 25, -1, squad, { face: behind ? 0 : Math.PI });
    g.pos.y = eye.y - KINDS.grunt.weakY;
    if (aware) {
      g.aware = "engaged";
      s.squads[squad].engaged = true;
      // It has seen the player itself: an engaged robot that has not is an ambush too.
      g.blind = 0;
      g.sawAt = { x: p.pos.x, z: p.pos.z };
    }
    const a = lookAngles(eye, weakPoint(g));
    fireRay(s, { kind: "talon", rarity: 0, mag: -1 }, forward(a.yaw, a.pitch));
    return s.enemies.includes(g) ? (g.hp + g.shield) / enemyMaxPlain("grunt") : 0;
  };
  const ambush = shot(false, false);
  const front = shot(true, false);
  const back = shot(true, true);
  if (ambush > 0 || back > 0 || front < 0.3) return `position scenario: a TALON weak-point shot leaves a grunt at ${Math.round(ambush * 100)}% unaware, ${Math.round(back * 100)}% from behind, ${Math.round(front * 100)}% from the front`;
  return null;
}

/**
 * Time to kill with the free kit's PIKE, every round on the body of a robot that faces the
 * player (the usual fight): a grunt falls in 1.5-2.5 s of fire, a heavy and a vault guard
 * in 3-4 s, a raider in 5-6.5 s, at 12 m and at 30 m. The kill says where the shot came from.
 */
function checkTimeToKill(): string | null {
  const at = openSpot(31, 3, 3);
  if (!at) return "ttk scenario: no open ground for the test";
  const cases: [string, EnemyKind, (e: Enemy) => void, number, number][] = [
    ["grunt", "grunt", () => {}, 1.5, 2.5],
    ["heavy", "heavy", () => {}, 3, 4],
    ["vault guard", "grunt", (e) => (e.plate = VAULT.guardPlate), 3, 4],
    ["raider", "grunt", (e) => { e.elite = true; e.plate = RAIDERS.plate; e.hp *= ELITE.hp; e.shield *= ELITE.hp; }, 5, 6.5],
  ];
  for (const dist of [12, 30])
    for (const [name, kind, dress, lo, hi] of cases) {
      const { s, foes } = standoff(at, dist, [kind]);
      const e = foes[0];
      dress(e);
      const gun = { kind: "pike" as const, rarity: 0 as Rarity, mag: -1 };
      let n = 0;
      while (s.enemies.includes(e) && n < 400) {
        s.events = [];
        const a = lookAngles(eyePos(s), bodyCenter(e));
        fireRay(s, gun, forward(a.yaw, a.pitch));
        n++;
      }
      const t = (n - 1) * WEAPONS.pike.interval;
      if (t < lo || t > hi) return `ttk scenario: a common PIKE took ${n} body rounds (${t.toFixed(1)} s of fire) to kill a ${name} facing the player at ${dist} m (want ${lo}-${hi} s)`;
      const k = s.events.find((x) => x.t === "kill");
      if (!k || k.t !== "kill" || Math.hypot(k.fromX - s.player.pos.x, k.fromZ - s.player.pos.z) > 0.01) return "ttk scenario: the kill does not say where the shot came from";
    }
  // A sniper's opener on the weak point drops a grunt or a drone that has not noticed, and only opens a fight with a heavy or a raider.
  for (const [kind, elite, dies] of [["grunt", false, true], ["drone", false, true], ["heavy", false, false], ["grunt", true, false]] as [EnemyKind, boolean, boolean][]) {
    const s = newRun(5);
    s.phase = "play";
    s.enemies = [];
    const squad = s.squads.length;
    s.squads.push({ name: "test", poi: -1, patrol: [], leg: 0, engaged: false, roam: false, sinceSeen: 0, last: { x: 0, z: 0 } });
    s.player.onGround = true;
    const eye = eyePos(s);
    const e = spawnEnemy(s, kind, eye.x, eye.z - 25, -1, squad, { face: Math.PI, elite, plate: elite ? RAIDERS.plate : 0 });
    e.pos.y = eye.y - KINDS[kind].weakY; // level with the eye: a fresh run's player is still up in the drop
    const a = lookAngles(eye, weakPoint(e));
    fireRay(s, { kind: "talon", rarity: 0, mag: -1 }, forward(a.yaw, a.pitch));
    if (s.enemies.includes(e) === dies) return `ttk scenario: a TALON weak-point shot on an unaware ${elite ? "raider" : kind} ${dies ? "left it standing" : "killed it outright"}`;
  }
  return null;
}

/**
 * Hits rock a robot, and enough of them in a short time stagger it: a grunt in its wind-up
 * that takes a burst reels back, its burst is lost, and it cannot be staggered again at once.
 * One hit alone does not stagger it.
 */
function checkStagger(): string | null {
  const at = openSpot(16, 2, 2);
  if (!at) return "stagger scenario: no open ground for the test";
  const { s, foes } = standoff(at, 15, ["grunt"]);
  const g = foes[0];
  s.player.iframes = 99;
  // No shield, so the stagger can only come from the damage adding up (a shield breaking staggers too, checked below).
  g.shield = 0;
  g.mode = "telegraph";
  g.timer = KINDS.grunt.telegraph;
  g.cooldown = 99;
  const gun = { kind: "pike" as const, rarity: 0 as Rarity, mag: -1 };
  const fire = (n: number) => {
    for (let i = 0; i < n; i++) {
      const a = lookAngles(eyePos(s), bodyCenter(g));
      fireRay(s, gun, forward(a.yaw, a.pitch));
    }
  };
  s.events = [];
  fire(1);
  if (g.mode !== "telegraph") return `stagger scenario: one round put a grunt in ${g.mode}`;
  // A burst's worth within the window: enough to pass its share.
  const need = Math.ceil((STAGGER.share.grunt * enemyMaxPlain("grunt")) / (WEAPONS.pike.dmg * 0.75)) + 1;
  fire(need);
  const st = s.events.find((e) => e.t === "stagger");
  if (g.mode !== "staggered" || !st || st.t !== "stagger" || !st.interrupted) return `stagger scenario: ${need + 1} quick rounds left a winding-up grunt in ${g.mode}${st ? "" : " with no stagger event"}`;
  for (let i = 0; i < (KINDS.grunt.telegraph + 0.3) / TICK; i++) {
    step(s, idleInput(), false);
    if (s.events.some((e) => e.t === "enemyFire")) return "stagger scenario: a grunt staggered out of its wind-up still fired its burst";
  }
  // Back on its feet, it shrugs off another stagger's worth of rounds for a while.
  if (g.mode === "staggered") return "stagger scenario: a grunt was still staggered after its wind-up's time";
  s.events = [];
  g.hp = KINDS.grunt.hp; // alive through another stagger's worth of rounds
  fire(need);
  if (!s.enemies.includes(g)) return "stagger scenario: the grunt died before the repeat could be checked";
  if (s.events.some((e) => e.t === "stagger")) return "stagger scenario: a grunt was staggered again straight after a stagger";
  // A shield breaking staggers it briefly, even on a hit too light to stagger it otherwise.
  {
    const { s, foes } = standoff(at, 15, ["grunt"]);
    const h = foes[0];
    s.player.iframes = 99;
    h.shield = 1;
    s.events = [];
    const a = lookAngles(eyePos(s), bodyCenter(h));
    fireRay(s, gun, forward(a.yaw, a.pitch));
    if (h.mode !== "staggered" || Math.abs(h.timer - STAGGER.shieldBreak) > 1e-6) return `stagger scenario: breaking a grunt's shield left it in ${h.mode}`;
  }
  // A shield breaking under a wind-up or a burst does not cost that attack.
  for (const mode of ["telegraph", "fire"] as const) {
    const { s, foes } = standoff(at, 15, ["grunt"]);
    const h = foes[0];
    s.player.iframes = 99;
    h.mode = mode;
    h.timer = 1;
    h.shield = 1;
    const a = lookAngles(eyePos(s), bodyCenter(h));
    fireRay(s, gun, forward(a.yaw, a.pitch));
    if (h.mode !== mode) return `stagger scenario: breaking a grunt's shield in its ${mode} left it in ${h.mode}`;
  }
  // A stagger out of a wind-up or a burst never brings the next one sooner: the attack's cooldown is still owed.
  for (const mode of ["telegraph", "fire"] as const) {
    const { s, foes } = standoff(at, 15, ["grunt"]);
    const h = foes[0];
    s.player.iframes = 99;
    h.mode = mode;
    h.cooldown = 0;
    h.shield = 0;
    // Damage already adding up to its share: the next round staggers it.
    h.stagger = STAGGER.share.grunt * enemyMaxPlain("grunt");
    const a = lookAngles(eyePos(s), bodyCenter(h));
    fireRay(s, gun, forward(a.yaw, a.pitch));
    if (h.mode !== "staggered" || h.cooldown < KINDS.grunt.cooldown * 0.8 - 1e-6) return `stagger scenario: a grunt staggered out of its ${mode} owes ${h.cooldown.toFixed(2)} s of cooldown`;
  }
  return null;
}

/** Robots keep moving through their wind-up: a grunt sidesteps across the player's view; a heavy plants its feet. */
function checkWindupMoves(): string | null {
  const at = openSpot(16, 5, 5);
  if (!at) return "wind-up scenario: no open ground for the test";
  for (const kind of ["grunt", "heavy"] as EnemyKind[]) {
    const { s, foes } = standoff(at, 15, [kind]);
    const e = foes[0];
    s.player.iframes = 99;
    e.mode = "telegraph";
    e.timer = KINDS[kind].telegraph;
    e.cooldown = 99;
    const x0 = e.pos.x;
    let telegraphT = 0;
    while (e.mode === "telegraph" && telegraphT < 2) {
      s.player.iframes = 99;
      step(s, idleInput(), false);
      telegraphT += TICK;
    }
    const moved = Math.abs(e.pos.x - x0);
    // Half a metre: about a body width, enough to carry it off a crosshair left where it stood.
    if (kind === "heavy" ? moved > 0.05 : moved < 0.5) return `wind-up scenario: a ${kind} moved ${moved.toFixed(2)} m sideways through its ${KINDS[kind].telegraph} s wind-up`;
  }
  return null;
}

/** Aim pull helps an aimed shot standing still, and not hip fire on the move. */
function checkPullWhenAiming(): string | null {
  const at = openSpot(21, 2, 2);
  if (!at) return "pull scenario: no open ground for the test";
  const turned = (ads: boolean, move: boolean) => {
    const { s, foes } = standoff(at, 20, ["grunt"]);
    foes[0].mode = "stunned";
    foes[0].timer = 99;
    const p = s.player;
    p.yaw = 0.12; // a little off the robot
    const inp = idleInput();
    inp.ads = ads;
    inp.fire = !ads;
    inp.moveX = move ? 1 : 0;
    const before = p.yaw;
    for (let i = 0; i < 0.5 / TICK; i++) {
      p.cooldown = 1; // the trigger is held, but no shot needs to land for the test
      step(s, inp, false);
    }
    return Math.abs(before) - Math.abs(p.yaw);
  };
  const aimed = turned(true, false);
  const hip = turned(false, true);
  if (aimed < 0.03 || hip > 0.01) return `pull scenario: aiming down sights still pulled ${aimed.toFixed(3)} rad, hip fire on the move ${hip.toFixed(3)} rad`;
  return null;
}

/**
 * Armour plates: a body hit from a weapon below the plate's tier is cut to
 * `PLATE.mult[plate - rarity]`; weak-point hits, weapons that pierce the plate and the
 * arc pass in full, and the hit event says `blocked` exactly when a plate took part.
 * Raiders wear tier-2 plates, and each POI's vault guard a VAULT.guardPlate one.
 */
function checkPlates(): string | null {
  const at = openSpot(10, 3, 3);
  if (!at) return "plate scenario: no open ground for the test";
  const { s, foes } = standoff(at, 8, ["grunt", "grunt"]);
  const [plated, bare] = foes;
  plated.plate = 2;
  const hit = (e: Enemy, raw: number, crit: boolean, rarity?: Rarity) => {
    e.hp = ENEMIES[e.kind].hp;
    e.shield = ENEMIES[e.kind].shield;
    s.events = [];
    damageEnemy(s, e, raw, crit, bodyCenter(e), "none", "player", rarity);
    const ev = s.events.find((x): x is Extract<GameEvent, { t: "hit" }> => x.t === "hit" && x.id === e.id);
    return { dealt: ENEMIES[e.kind].hp + ENEMIES[e.kind].shield - (e.hp + e.shield), blocked: ev?.blocked };
  };
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  const raw = 20;
  const cases: [string, ReturnType<typeof hit>, number, boolean][] = [
    ["common body hit on plate 2", hit(plated, raw, false, 0), raw * PLATE.mult[2], true],
    ["rare body hit on plate 2", hit(plated, raw, false, 1), raw * PLATE.mult[1], true],
    ["common body hit on no plate", hit(bare, raw, false, 0), raw, false],
    ["common weak-point hit on plate 2", hit(plated, raw, true, 0), raw, false],
    ["epic body hit on plate 2", hit(plated, raw, false, 2), raw, false],
    ["legend body hit on plate 2", hit(plated, raw, false, 3), raw, false],
    ["damage with no weapon on plate 2", hit(plated, raw, false), raw, false],
  ];
  for (const [what, got, want, blocked] of cases)
    if (!near(got.dealt, want) || got.blocked !== blocked) return `plate scenario: ${what} dealt ${got.dealt} (blocked ${got.blocked}), expected ${want} (blocked ${blocked})`;

  // A real shot carries its weapon's rarity, and the teammate's counts as ALLY.rarity.
  const shoot = (rarity: Rarity) => {
    plated.hp = ENEMIES.grunt.hp;
    plated.shield = ENEMIES.grunt.shield;
    s.events = [];
    const eye = eyePos(s);
    const c = bodyCenter(plated);
    const d = Math.hypot(c.x - eye.x, c.y - eye.y, c.z - eye.z);
    fireRay(s, { kind: "pike", rarity, mag: 1 }, { x: (c.x - eye.x) / d, y: (c.y - eye.y) / d, z: (c.z - eye.z) / d });
    return s.events.find((x): x is Extract<GameEvent, { t: "hit" }> => x.t === "hit" && x.id === plated.id);
  };
  const common = shoot(0);
  const epic = shoot(2);
  if (!common || common.crit || !common.blocked) return `plate scenario: a common rifle's body shot on plate 2 ${common ? `was ${common.crit ? "a crit" : "not blocked"}` : "missed"}`;
  if (!epic || epic.blocked) return `plate scenario: an epic rifle's body shot on plate 2 ${epic ? "was blocked" : "missed"}`;
  const ally = hit(plated, raw, false, ALLY.rarity);
  if (!near(ally.dealt, raw * PLATE.mult[2 - ALLY.rarity]) || !ally.blocked) return `plate scenario: the teammate's body hit on plate 2 dealt ${ally.dealt}`;

  // The arc tactical is not a weapon: a plated grunt takes its damage in full.
  const r = newRun(5);
  r.phase = "play";
  const pad = POIS[PAD];
  const g = terrainHeight(pad.x, pad.z);
  r.player.pos = { x: pad.x, y: g, z: pad.z + 6 };
  r.player.onGround = true;
  r.player.yaw = 0;
  const grunt = r.enemies.find((e) => e.kind === "grunt")!;
  r.enemies = [grunt];
  grunt.pos = { x: pad.x, y: g, z: pad.z - 4 };
  grunt.aware = "engaged";
  grunt.plate = 3;
  const before = grunt.hp + grunt.shield;
  const inp = idleInput();
  inp.tactical = true;
  step(r, inp, false);
  const arc = before - (grunt.hp + grunt.shield);
  if (!near(arc, TACTICAL.dmg)) return `plate scenario: an arc on a plate-3 grunt dealt ${arc}, expected ${TACTICAL.dmg}`;

  // Who wears plates: the raiders, and the grunt nearest each POI's vault bin (the pad's is the titan's).
  const raid = padRun();
  raid.raiderT = TICK;
  const was = raid.enemies.length;
  step(raid, idleInput(), false);
  const raiders = raid.enemies.slice(was);
  if (raiders.length === 0 || raiders.some((e) => e.plate !== RAIDERS.plate)) return `plate scenario: raiders wear plates ${raiders.map((e) => e.plate).join(",")}, expected ${RAIDERS.plate}`;
  const run = newRun(5);
  for (const [i, poi] of POIS.entries()) {
    const vault = poi.bins.find((b) => b.vault);
    if (!vault || poi.id === "pad") continue;
    const guards = poi.squads.flatMap((sq) => sq.members).filter((m) => m.kind === "grunt");
    const guard = guards.reduce((a, b) => (Math.hypot(b.x - vault.x, b.z - vault.z) < Math.hypot(a.x - vault.x, a.z - vault.z) ? b : a));
    if (guard.plate !== VAULT.guardPlate) return `plate scenario: ${poi.id}'s vault guard wears plate ${guard.plate ?? 0}, expected ${VAULT.guardPlate}`;
    const live = run.enemies.filter((e) => e.poi === i && e.plate > 0);
    if (live.length !== 1 || live[0].plate !== VAULT.guardPlate) return `plate scenario: ${poi.id} spawns ${live.length} plated robots, expected its vault guard alone`;
  }
  return null;
}


/** The two ends of a route's walk. */
const ends = (id: RouteId) => {
  const r = ROUTES.find((o) => o.id === id)!;
  return [r.path[0], r.path[r.path.length - 1]] as const;
};

/**
 * Walks the player up the wreck's gangway: east along the hull's north side to the top of the
 * flight, then south onto the deck. Returns the height the walk ends at.
 */
function walkGangway(open: boolean): number {
  const s = padRun();
  s.routes = open ? ["gangway"] : [];
  const [foot, top] = ends("gangway");
  const p = s.player;
  p.pos = { x: foot.x - 1, y: LEVEL.seabed, z: foot.z };
  p.yaw = Math.PI / 2;
  s.ally.pos = { x: foot.x - 8, y: LEVEL.seabed, z: foot.z - 4 };
  const walk = { ...idleInput(), moveZ: 1 };
  for (let t = 0; t < 10 * 60 && p.pos.x < top.x; t++) step(s, walk, false);
  p.yaw = Math.PI;
  for (let t = 0; t < 3 * 60 && p.pos.z < top.z; t++) step(s, walk, false);
  return p.pos.y;
}

/**
 * The routes (`ROUTES`): closed, the bot's way and the robots' field between a route's ends go
 * the long way round; open, they go straight through, and the wreck's gangway is climbed to the
 * deck on foot. The authored points stand in both worlds; a trench lowers no ground under any of
 * the map's boxes and keeps clear of the cover spots; and the world with every route closed is
 * put back cell for cell.
 */
function checkRoutes(): string | null {
  useRoutes([]);
  const carved = ROUTES.filter((r) => r.carve);
  const sample = carved.flatMap((r) => {
    const [[x, za], [, zb]] = r.carve!.line;
    return Array.from({ length: 41 }, (_, k) => ({ x: x - 8 + (k % 9) * 2, z: za + ((zb - za) * Math.floor(k / 9)) / 4 }));
  });
  const before = sample.map((q) => `${terrainHeight(q.x, q.z)},${steepAt(q.x, q.z)},${floorLevel(q.x, q.z)}`).join();
  const way = (r: (typeof ROUTES)[number]) => {
    const [a, b] = ends(r.id);
    return { nav: navLength(a.x, a.z, b.x, b.z), field: routeLength(fieldTo(b.x, b.z)!, a.x, a.z), straight: Math.hypot(a.x - b.x, a.z - b.z) };
  };
  const closed = carved.map(way);
  const closedLayout = checkLayout();
  if (closedLayout.length) return `route scenario: with every route closed, ${closedLayout[0]}`;
  if (walkGangway(false) > LEVEL.seabed + 1) return "route scenario: the wreck's deck was climbed with its gangway hauled up";
  useRoutes(ROUTES.map((r) => r.id));
  const opened = carved.map(way);
  const openLayout = checkLayout();
  if (openLayout.length) return `route scenario: with every route open, ${openLayout[0]}`;
  for (const [n, r] of carved.entries()) {
    const c = closed[n];
    const o = opened[n];
    if (!(o.nav < o.straight * 1.15) || !(o.field < o.straight * 1.2)) return `route scenario: ${r.id} open is walked in ${o.nav.toFixed(0)} m by the bot and ${o.field.toFixed(0)} m by robots, for ${o.straight.toFixed(0)} m`;
    if (!(c.nav > o.nav * 1.5) || !(c.field > o.field * 1.5)) return `route scenario: ${r.id} closed is still walked in ${c.nav.toFixed(0)} m by the bot and ${c.field.toFixed(0)} m by robots (open: ${o.nav.toFixed(0)} m)`;
  }
  const deck = walkGangway(true);
  if (Math.abs(deck - (LEVEL.seabed + 10.2)) > 0.3) return `route scenario: walking up the open gangway ended at height ${deck.toFixed(2)}, not on the deck`;
  // No box of the map hangs over ground a trench lowered, and no cover spot lies in a trench.
  for (const r of carved) {
    const [[x, za], [, zb]] = r.carve!.line;
    const reach = r.carve!.floor + 30 / r.carve!.slope;
    const z0 = Math.min(za, zb) - reach;
    const z1 = Math.max(za, zb) + reach;
    for (const b of BOXES) {
      if (b.x1 < x - reach || b.x0 > x + reach || b.z1 < z0 || b.z0 > z1) continue;
      for (const [qx, qz] of [[b.x0, b.z0], [b.x1, b.z0], [b.x0, b.z1], [b.x1, b.z1], [(b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2]]) {
        const now = terrainHeight(qx, qz);
        if (now < b.y0 - 0.3 && b.y0 - now < 6) {
          useRoutes([]);
          if (terrainHeight(qx, qz) >= b.y0 - 0.3) return `route scenario: ${r.id}'s trench leaves a ${b.kind} hanging at ${qx.toFixed(1)},${qz.toFixed(1)}`;
          useRoutes(ROUTES.map((o) => o.id));
        }
      }
    }
  }
  const cut = COVERS.map((c) => terrainHeight(c.x, c.z));
  useRoutes([]);
  const bad = COVERS.find((c, n) => Math.abs(cut[n] - terrainHeight(c.x, c.z)) > 0.05);
  if (bad) return `route scenario: a cover spot at ${bad.x.toFixed(1)},${bad.z.toFixed(1)} lies in a route's trench`;
  const after = sample.map((q) => `${terrainHeight(q.x, q.z)},${steepAt(q.x, q.z)},${floorLevel(q.x, q.z)}`).join();
  if (after !== before || worldKey() !== "") return "route scenario: closing every route again did not put the ground back as it was";
  return null;
}

/**
 * A raid started with a route open has no obstacle there, for bodies and for sight: the tunnel
 * is seen through and walked through from mouth to mouth. Started with it closed, the obstacle
 * stops a body and the view, and the HUD names the tool before it.
 */
function checkRouteObstacles(): string | null {
  const r = ROUTES.find((o) => o.id === "tunnel")!;
  const [south, north] = ends("tunnel");
  const eyeAt = (q: { x: number; z: number }) => ({ x: q.x, y: groundAt(q.x, q.z, 0.4, 99) + 1.6, z: q.z });
  const centre = (b: (typeof r.closed)[number]) => ({ x: (b.x0 + b.x1) / 2, y: (b.y0 + b.h) / 2, z: (b.z0 + b.z1) / 2 });
  const rock = r.closed.find((b) => b.kind === "rock")!;
  const open = newRun(9, freeKit(), "reservoir", { routes: ["tunnel"] });
  if (open.routes.join() !== "tunnel" || worldKey() !== "tunnel") return `obstacle scenario: a raid started with the tunnel open runs in world "${worldKey()}"`;
  const c = centre(rock);
  if (solidAt(c.x, c.y, c.z)) return "obstacle scenario: the tunnel's rubble is still solid with the tunnel open";
  if (!los(eyeAt(south), eyeAt(north))) return "obstacle scenario: the open tunnel cannot be seen through from mouth to mouth";
  const body = { x: c.x, y: terrainHeight(c.x, c.z), z: c.z };
  collide(body, PLAYER.radius);
  if (dist2d(body, c) > 0.01) return "obstacle scenario: a body in the open tunnel's mouth is pushed out of something";
  if (routeBefore({ ...r.at[0] }, open.routes)) return "obstacle scenario: an open route still shows its prompt";
  const shut = newRun(9);
  if (shut.routes.length || worldKey() !== "") return "obstacle scenario: a raid started with no routes did not put the closed world back";
  if (!solidAt(c.x, c.y, c.z) || los(eyeAt(south), eyeAt(north))) return "obstacle scenario: the closed tunnel's rubble does not stop a body or the view";
  const front = { x: c.x, y: rock.y0 + 0.6, z: c.z };
  collide(front, PLAYER.radius);
  if (dist2d(front, c) < 0.3) return "obstacle scenario: a body in the closed tunnel's rubble is not pushed out";
  for (const o of ROUTES) for (const a of o.at) if (routeBefore({ ...a }, [])?.id !== o.id) return `obstacle scenario: before ${o.id}'s obstacle the HUD does not name it`;
  // A raid steps in its own world, whatever ran in between.
  newRun(9, freeKit(), "reservoir", { routes: ["tunnel", "dam"] });
  step(shut, idleInput(), false);
  if (worldKey() !== "") return `obstacle scenario: stepping a raid with no routes open left world "${worldKey()}" in place`;
  return null;
}

/**
 * Tools: each lies only in the bins of its POI (no vault, no bin outside a POI) about as often as
 * `TOOLS` says, without changing anything else a bin holds or the raid's random numbers. The use
 * key takes one into the bag, throwing cheaper things out to make room; the bot leaves them.
 * Home by a way off or a depot, a tool opens the first of its routes still closed and is spent;
 * lost on a wipe it opens nothing, unless the pouch kept it; one whose routes are all open sells.
 * A v8 save has every route closed.
 */
function checkTools(): string | null {
  const any = newRun(1);
  for (const k of TOOL_KINDS) {
    let n = 0;
    let found = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const s = { ...any, seed };
      for (const b of s.bins) {
        const has = toolIn(s, b, k);
        if (has && (b.vault || b.outside || POIS[b.poi].id !== TOOLS[k].from)) return `tool scenario: a ${k} lies in bin ${b.id} of ${POIS[b.poi].id}`;
        if (!b.vault && !b.outside && POIS[b.poi].id === TOOLS[k].from) {
          n++;
          if (has) found++;
        }
      }
    }
    if (Math.abs(found / n - TOOLS[k].chance) > 0.03) return `tool scenario: ${k} lies in ${((found / n) * 100).toFixed(1)}% of its bins, not ${TOOLS[k].chance * 100}%`;
  }
  // A bin with a charge in it spills the same loot and leaves the same random state as with no tools.
  let seed = 1;
  let binAt = -1;
  for (; seed < 999 && binAt < 0; seed++) binAt = any.bins.findIndex((b) => toolIn({ ...any, seed }, b, "charge"));
  seed--;
  const open = (chance: number) => {
    const was = TOOLS.charge.chance;
    TOOLS.charge.chance = chance;
    const s = padRun();
    s.rng = 77;
    s.seed = seed;
    const b = s.bins[binAt];
    s.player.pos = { x: b.x, y: b.y, z: b.z + 1 };
    s.player.search = { bin: binAt, t: 99 };
    step(s, idleInput(), false);
    TOOLS.charge.chance = was;
    return s;
  };
  const withTool = open(TOOLS.charge.chance);
  const without = open(0);
  const strip = (s: State) => JSON.stringify(s.loot.filter((l) => l.kind !== "tool").map((l) => [l.id, l.kind, l.valuable, l.heal, l.weapon?.kind, l.key]));
  if (!withTool.loot.some((l) => l.kind === "tool" && l.tool === "charge")) return `tool scenario: bin ${binAt} of seed ${seed} spilled no charge`;
  if (strip(withTool) !== strip(without) || withTool.rng !== without.rng || withTool.nextId !== without.nextId) return "tool scenario: a tool in a bin changed the rest of its loot or the raid's random numbers";
  // The use key takes it, throwing out the cheapest valuables for room; the bot leaves it.
  const take = (leave: boolean) => {
    const s = padRun();
    s.player.haul = ["parts", "fuse", "board", "core", "drive", "parts"];
    s.loot = [{ id: -1, kind: "tool", tool: "charge", rarity: 3, pos: { ...s.player.pos }, vel: { x: 0, y: 0, z: 0 }, age: 1 }];
    step(s, { ...idleInput(), interact: true, leaveTools: leave }, false);
    return s;
  };
  const took = take(false);
  if (took.player.tools.join() !== "charge" || bagLoad(took.player) > BAG.slots || took.player.haul.includes("core") === false) return `tool scenario: taking a charge into a full bag left tools ${took.player.tools.join()} and haul ${took.player.haul.join()}`;
  if (take(true).player.tools.length) return "tool scenario: the bot's input took a tool";
  // Home: carried out, sent from a depot, kept by the pouch, or lost.
  const raid = (tools: ("cutter" | "charge")[], outcome: "extracted" | "dead", sent: ("cutter" | "charge")[] = []) => {
    const s = newRun(3);
    s.player.tools = [...tools];
    s.sentTools = [...sent];
    s.outcome = outcome;
    return s;
  };
  let p = newProfile();
  const out = settle(p, raid(["charge"], "extracted"));
  if (out.opened.join() !== "tunnel" || out.profile.routes.join() !== "tunnel" || out.profile.stash.some((i) => i.t === "tool")) return `tool scenario: a charge carried out opened ${out.opened.join()} and left ${JSON.stringify(out.profile.stash.filter((i) => i.t === "tool"))}`;
  const sent = settle(p, raid([], "dead", ["cutter"]));
  if (sent.opened.join() !== "dam") return `tool scenario: a cutter sent from a depot before a wipe opened ${sent.opened.join() || "nothing"}`;
  const lost = settle(p, raid(["charge"], "dead"));
  if (lost.opened.length || lost.profile.routes.length) return `tool scenario: a charge lost in a wipe opened ${lost.opened.join()}`;
  const pouched = settle(p, raid(["cutter"], "dead"));
  if (pouched.opened.join() !== "dam") return `tool scenario: a cutter the pouch (${META.pouch} slots) kept through a wipe opened ${pouched.opened.join() || "nothing"}`;
  p = settle(p, raid(["cutter", "cutter"], "extracted")).profile;
  if (p.routes.join() !== "dam,gangway") return `tool scenario: two cutters opened ${p.routes.join()}, not the dam and the gangway`;
  const spare = settle(p, raid(["cutter"], "extracted"));
  const kept = spare.profile.stash.find((i) => i.t === "tool");
  if (spare.opened.length || !kept || sellPrice(kept) !== TOOLS.cutter.value) return "tool scenario: a cutter with its routes all open was not kept to sell at its value";
  // Saves: a v8 one has every route closed; a v9 one keeps its routes, unknown ones dropped.
  const v8 = parseProfile(JSON.parse(JSON.stringify({ ...p, v: 8 })));
  if (!v8 || v8.v !== 16 || v8.routes.length) return `tool scenario: a v8 save loaded with routes ${JSON.stringify(v8?.routes)}`;
  const v9 = parseProfile(JSON.parse(JSON.stringify({ ...p, routes: ["gangway", "nowhere", "dam"] })));
  if (v9?.routes.join() !== "dam,gangway") return `tool scenario: a v9 save loaded with routes ${JSON.stringify(v9?.routes)}`;
  return null;
}
/**
 * The island's events and the salvage crews: the schedule is drawn from the seed and the day and
 * announced a day ahead; a debris fall puts its crate and guards at its spot; the retake squad
 * comes to the freed POI and, left alive, thins it overnight, and the defend contract is done when
 * it falls; a storm cuts the robots' sight to `STORM.sight`; a crew takes a bin's valuable into
 * its bag, drops the bag when destroyed, and raises the network a step when it gets off.
 */
function checkEvents(): string | null {
  // The schedule: tomorrow's event becomes today's, the same profile gives the same days, and about one day in two has one.
  const quiet: RaidDay = { alive: true, cleared: [], visited: [], titan: false, relays: [] };
  let p: Profile = newProfile(23);
  if (p.events[0] !== null) return "event scenario: the first day has an event";
  const freedAll = { ...p, poiState: Object.fromEntries(POIS.map((o) => [o.id, { state: unfreeable(o.id) ? "held" : "freed", lastVisit: 0, since: 0 }])) as Profile["poiState"] };
  let q: Profile = freedAll;
  let count = 0;
  const kinds = new Set<string>();
  for (let d = 0; d < 80; d++) {
    const ahead = q.events[1];
    const next = advanceDay({ ...q, seed: nextSeed(q.seed) }, { ...quiet, visited: POIS.map((o) => o.id) }).profile;
    const again = advanceDay({ ...q, seed: nextSeed(q.seed) }, { ...quiet, visited: POIS.map((o) => o.id) }).profile;
    if (JSON.stringify(next.events) !== JSON.stringify(again.events)) return "event scenario: the same day drew two schedules";
    if (JSON.stringify(next.events[0]) !== JSON.stringify(ahead)) return `event scenario: day ${next.day} has ${JSON.stringify(next.events[0])}, announced as ${JSON.stringify(ahead)}`;
    if (next.events[0]) {
      count++;
      kinds.add(next.events[0].t);
    }
    q = next;
  }
  if (count < 25 || count > 55 || kinds.size !== 4) return `event scenario: 80 days had ${count} events of kinds ${[...kinds].join()}`;
  // A retake needs a freed POI: none is forecast while every POI is held.
  for (let d = 0; d < 60; d++) {
    p = advanceDay({ ...p, seed: nextSeed(p.seed) }, quiet).profile;
    if (p.events.some((e) => e?.t === "retake")) return "event scenario: a retake was forecast with no POI freed";
  }
  // Debris: each spot has its crate (from no POI) and its guards, and the rest of the raid is drawn as on a quiet day.
  for (const d of DEBRIS_SPOTS) {
    const calm = newRun(41, freeKit(), d.region);
    const s = newRun(41, freeKit(), d.region, { event: { t: "debris", spot: d.id } });
    const crate = debrisBin(s);
    if (!crate || dist2d(crate, d) > 0.1 || !crate.outside) return `event scenario: debris at ${d.id} has crate ${JSON.stringify(crate)}`;
    const guards = s.squads.findIndex((sq) => sq.name === d.guards.name);
    const kindsAt = s.enemies.filter((e) => e.squad === guards).map((e) => e.kind).sort().join();
    if (kindsAt !== [...DEBRIS.guards].sort().join()) return `event scenario: debris at ${d.id} is guarded by ${kindsAt}`;
    if (s.rng !== calm.rng || s.bins.length !== calm.bins.length + 1) return `event scenario: debris at ${d.id} changed the raid's random numbers or bins`;
    if (regionHere(d).id !== d.region) return `event scenario: debris ${d.id} lies in ${regionHere(d).id}`;
    s.player.pos = { x: crate.x, y: crate.y, z: crate.z + 1 };
    s.enemies = [];
    s.player.search = { bin: s.bins.indexOf(crate), t: 99 };
    step(s, idleInput(), false);
    const vals = s.loot.filter((l) => l.kind === "valuable");
    if (vals.length !== DEBRIS.count || vals.some((l) => l.from !== -1 || !DEBRIS.valuables.some(([k]) => k === l.valuable))) return `event scenario: the debris crate at ${d.id} held ${JSON.stringify(vals.map((l) => [l.valuable, l.from]))}`;
  }
  // Retake: the squad beams in out of sight and walks to the freed POI's way in.
  const poi = "supply" as const;
  const island = { supply: "freed" as const };
  const run = () => newRun(77, freeKit(), "reservoir", { island, event: { t: "retake", poi }, entry: "jetty" });
  const s = run();
  s.crewsDue = [];
  s.player.hp = 1e9;
  let seen = false;
  for (let t = 0; t < (RETAKE.at + 150) / TICK && s.phase === "play"; t++) {
    step(s, idleInput(), false);
    s.player.hp = 1e9;
    if (s.events.some((e) => e.t === "retakeIn")) seen = true;
  }
  const sq = s.squads.findIndex((o) => o.retake === poiIndex(poi));
  const members = s.enemies.filter((e) => e.squad === sq);
  const way = POIS[poiIndex(poi)].entry;
  if (!seen || sq < 0 || members.length < 3) return `event scenario: the retake squad beamed in ${seen}, squad ${sq}, ${members.length} members`;
  if (!members.some((e) => dist2d(e.pos, way) < 15)) return `event scenario: the retake squad stands ${Math.min(...members.map((e) => dist2d(e.pos, way))).toFixed(0)} m from ${poi}'s way in after ${RETAKE.at + 150} s`;
  const left = { ...newProfile(9), poiState: { ...newProfile(9).poiState, supply: { state: "freed" as const, lastVisit: 0, since: 0 } } };
  const lost = advanceDay(left, raidDay(s));
  if (lost.profile.poiState.supply.state !== "thin" || lost.change.overrun.join() !== "supply") return `event scenario: a retake left alive left supply ${lost.profile.poiState.supply.state}`;
  for (const e of members) kill(s, e, false);
  const kept = advanceDay(left, raidDay(s));
  if (kept.profile.poiState.supply.state !== "freed" || kept.change.overrun.length) return "event scenario: a retake squad destroyed still thinned supply";
  const board = makeBoard({ ...left, events: [{ t: "retake", poi }, null] });
  const defend = board.contracts.find((c) => c.t === "defend");
  if (!defend || board.contracts[0] !== defend) return `event scenario: a retake's board has ${board.contracts.map((c) => c.t).join()}`;
  if (!contractDone(defend, { freed: [], home: [], wiped: s.stats.wiped, relays: [] }) || contractDone(defend, { freed: [], home: [], wiped: [], relays: [] })) return "event scenario: the defend contract does not follow the retake squad's fall";
  // A crews' visit brings a second crew and a crew intercept on the board.
  const visit = makeBoard({ ...left, events: [{ t: "crews" }, null] });
  if (!visit.contracts.some((c) => c.t === "intercept" && c.target.t === "crew")) return "event scenario: a crews' visit has no intercept of the crew";
  for (const network of [NETWORK.play, 3, NETWORK.max]) {
    const due = (event: { t: "crews" } | null) => newRun(77, freeKit(), "reservoir", { network, event }).crewsDue.length;
    if (due(null) !== NETWORK.levels[network].crews || due({ t: "crews" }) !== NETWORK.levels[network].crews + 1) return `event scenario: at network ${network} ${due(null)} crews come, ${due({ t: "crews" })} on a crews' visit`;
  }
  if (NETWORK.levels[NETWORK.play].crews !== 0) return "event scenario: crews come at the gate's network level without a crews' visit";
  // Storm: a grunt sees the player at 0.8 of its range on a clear day, not in a storm.
  const spot = openSpot(40, 4, 4);
  if (!spot) return "event scenario: no open ground for the storm";
  for (const storm of [false, true]) {
    const { s: t, foes } = standoff(spot, SIGHT.grunt.range * 0.8, ["grunt"]);
    const e = foes[0];
    t.squads[e.squad].engaged = false;
    e.aware = "idle";
    t.storm = storm;
    if (sense(t, e) === storm) return `event scenario: a grunt at ${(SIGHT.grunt.range * 0.8).toFixed(0)} m ${storm ? "saw the player in a storm" : "did not see the player on a clear day"}`;
    const want = SIGHT.grunt.range * AWARE.engagedRange * (storm ? STORM.sight : 1);
    if (Math.abs(fireRange(t, e) - want) > 1e-6) return `event scenario: a grunt fires out to ${fireRange(t, e)} m, not ${want}, ${storm ? "in a storm" : "on a clear day"}`;
  }
  // A crew that never meets the player draws nothing from the raid's numbers: they stand as on a raid without crews.
  // The crew of seed 1000 beams in about 200 m of walking from its first bin, and has searched it by 330 s.
  {
    const quietRun = (crews: boolean) => {
      const t = newRun(1000, freeKit(), "reservoir", { event: { t: "crews" } });
      if (!crews) t.crewsDue = [];
      for (let k = 0; k < 330 / TICK; k++) step(t, idleInput(), false);
      return t;
    };
    const a = quietRun(true);
    const b = quietRun(false);
    if (!a.stats.crewBins) return "event scenario: the quiet crew took no bin in 330 s";
    if (a.rng !== b.rng || a.roamRng !== b.roamRng) return `event scenario: a crew out of the player's way left the raid's numbers ${a.rng}/${a.roamRng}, not ${b.rng}/${b.roamRng} (${a.stats.crewBins} bins taken)`;
  }
  // Crews: one comes, takes a bin's valuable into its bag (nothing spills), and drops the bag when destroyed.
  // At the gate's network level crews come only on a crews' visit.
  const c = newRun(1000, freeKit(), "reservoir", { event: { t: "crews" } });
  c.player.hp = 1e9;
  let looted = -1;
  for (let t = 0; t < 400 / TICK && looted < 0; t++) {
    step(c, idleInput(), false);
    c.player.hp = 1e9;
    c.player.downed = 0;
    for (const e of c.events) if (e.t === "crewLoot") looted = c.bins.findIndex((b) => b.id === e.id);
  }
  const crew = c.squads.findIndex((o) => o.crew);
  if (looted < 0 || crew < 0) return "event scenario: no crew looted a bin in 400 s";
  const bin = c.bins[looted];
  const cq = c.squads[crew];
  if (!bin.open || cq.bag?.length !== 1 || cq.bagAt?.[0] !== bin.poi || c.loot.some((l) => dist2d(l.pos, bin) < 3 && l.kind === "valuable")) return `event scenario: a crew's search left bin open ${bin.open}, bag ${JSON.stringify(cq.bag)}`;
  const before = c.loot.length;
  for (const e of c.enemies.filter((o) => o.squad === crew)) kill(c, e, false);
  const dropped = c.loot.slice(before).filter((l) => l.kind === "valuable" && l.from === bin.poi && l.valuable === cq.bag?.[0]);
  if (!dropped.length && !c.loot.slice(before).some((l) => l.kind === "valuable" && l.from === bin.poi)) return "event scenario: a destroyed crew dropped no bag";
  if (c.stats.crewsDown !== 1 || !c.stats.wiped.includes(crewKey("reservoir"))) return "event scenario: a destroyed crew was not counted";
  // A crew that gets off is counted, and raises the network a step overnight on top of the day's rise.
  const o = newRun(1000, freeKit(), "reservoir", { event: { t: "crews" } });
  for (let t = 0; t < 80 / TICK; t++) step(o, idleInput(), false);
  const oq = o.squads.findIndex((x) => x.crew);
  if (oq < 0) return "event scenario: no crew came in 80 s";
  o.squads[oq].crew!.t = CREW.leaveAfter;
  for (let t = 0; t < 2 / TICK; t++) step(o, idleInput(), false);
  const exit = EXTRACTS.find((x) => x.id === o.squads[oq].crew!.leaving);
  if (!exit) return "event scenario: a crew past its time did not make for a way off";
  for (const e of o.enemies.filter((x) => x.squad === oq)) e.pos = { x: exit.x, y: groundAt(exit.x, exit.z, 0.4, 99), z: exit.z };
  for (let t = 0; t < 1 / TICK; t++) step(o, idleInput(), false);
  if (o.stats.crewsOut !== 1 || o.enemies.some((x) => x.squad === oq)) return `event scenario: a crew at its way off did not beam out (${o.stats.crewsOut})`;
  const base = newProfile(9);
  const without = advanceDay(base, { ...quiet, crews: 0 });
  const withCrew = advanceDay(base, raidDay(o));
  if (raidDay(o).crews !== 1 || withCrew.profile.network !== without.profile.network + 1 || withCrew.change.network.crews !== 1) return `event scenario: a crew that got off left the network at ${withCrew.profile.network}, not ${without.profile.network + 1}`;
  return null;
}
for (const err of [checkEvents(), checkTerrainIndex(20_000), checkParties(), checkPacks(), checkRoutes(), checkRouteObstacles(), checkTools(), checkTimeToKill(), checkStagger(), checkWindupMoves(), checkDepots(), checkDepotBudget(), checkPlates(), checkHideout(), checkBoltNoTunnel(), checkPickupWavesRouted(), checkLaterWaveFights(), checkSidestepHit(), checkReturnFire(), checkWallStops(), checkPinch(), checkPursuit(), checkHealHeard(), checkPositionMatters(), checkPullWhenAiming(), checkVault(), checkIsland(), checkNetwork(), checkContracts(), checkQuests(), checkSettle(), checkWipeClearsAir(), checkArcOnTitan(), checkGoldReload(), checkArcIgnoresFacing(), checkDeathEndsRaid(), checkBleedoutWipe(), checkReinforce(), checkReinforceHidden(), checkSearchBreaks(), checkBagSwap(), checkBagSwapCheapest(), checkRaiders(), checkValuableBin(), checkAllyRescue(), checkAllyDownWipes(), checkHelpAlly(), checkAllyHoldsFire(), checkFlareExtract(), checkShipCall(), checkBoatCall(), checkSecondPickup(), checkEntries(), checkCamp(), checkKnownEntries(), checkConnections(), checkAllySelfUp(), checkStompHeight(), checkFieldsReused(), checkFieldsFollowRunner(), checkCliffsStop(), checkNoPits(), checkWalkableIsland(), checkReinforceEverywhere(), checkRoamersHearOnlyGunfire(), checkReinforceWaitsForTitan(), checkWeakPointBehindBody(), checkHelpBeforeLoot(), checkAllyTitanKill(), checkLeap(), checkLeapLeavesAllyBelow(), checkLeapDowned(), checkLeapAllyCatchesUp(), checkLeapAllyDowned(), checkLeapWithItem(), checkLeapClocks(), checkLeapOffHighGround(), checkLeapUnderRoof()]) {
  if (err) {
    console.error(err);
    process.exit(1);
  }
}

let failed = false;
const head = ["skill    ", "alive", "time(med)", "cleared", "haul(med)", "score(med)", "downs", "acc", "crit", "leap", "crowd", "flank", "waves", "meet".padEnd(18), "ally".padEnd(18), "rank".padEnd(18), "exit"];
console.log(`${runs} runs per skill and region. alive: share of raids that got off (the rest were wiped out)`);
console.log("time: minutes from the start to leaving; cleared: median POIs cleared; haul and score: medians over raids that got off");
console.log("flank: share of hits from behind a robot or before it noticed or located the player (the titan, hit alike from every side, not counted)");
console.log("waves: median reinforcement squads that beamed in during a raid");
console.log("meet: medians of the seconds to the first squad engaging the player and of the longest stretch with no robot fighting them; squads that engaged per run / of them belonging to no POI");
console.log("ally: teammate's share of the damage, its downs, times it picked the player up (r) and was picked up (h), per run");
console.log("exit: raids that left by each extraction point of the region (the bot's choice depends on skill)");
console.log("crowd: median over runs of the most squads / robots fighting the player at once outside the titan fight");
const pool: Pool = {};
for (const region of REGIONS.filter((r) => !only || r.id === only)) {
  console.log("");
  console.log(`region: ${region.id} (${region.name})`);
  console.log(head.join(" "));
  for (const skill of SKILLS) {
    const t = await tables[tableIndex(region.id, skill.name)]();
    for (const l of t.lines) (l.err ? console.error : console.log)(l.text);
    for (const rec of t.records) ((pool[skill.name] ??= {})[region.id] ??= []).push(rec);
    if (t.failed) failed = true;
  }
}

if (process.env.RINGFALL_POOL) writeFileSync(process.env.RINGFALL_POOL, JSON.stringify(pool));
// The hideout's pacing, from the raids above (both regions are needed to plan the drops).
if (runs > 0 && !only) {
  console.log("");
  console.log("hideout pacing: the meta played with these raids, greedy spending (scripts/ringfall-pacing.ts)");
  const { lines, unreached } = pacing(pool);
  for (const l of lines) console.log(l);
  if (unreached.length) {
    failed = true;
    console.error(`hideout pacing: never built within the cap: ${unreached.join(", ")}`);
  }
}
// The island over a month: the network and the POIs carried from raid to raid, one profile per skill.
if (runs > 0 && !only) {
  console.log("");
  console.log("island campaign: a month on one profile per skill, the network carried (scripts/ringfall-campaign.ts)");
  const months = await campaigns(DAYS, jobs === 1 ? 1 : SKILLS.length);
  for (const l of campaignLines(months)) console.log(l);
  for (const e of months.flatMap((c) => c.errors)) {
    failed = true;
    console.error(e);
  }
}
if (failed) {
  console.error("FAILED");
  process.exit(1);
}
