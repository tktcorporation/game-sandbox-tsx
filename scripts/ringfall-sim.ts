/**
 * Gate 2 for RINGFALL: bots of three skills play the whole run headless, starting in
 * each region in turn. Fails if any run does not finish, or if an invariant breaks (NaN,
 * a body inside a box, an enemy outside the world). Prints the tables kept in
 * docs/ringfall/balance.md, one per region.
 *
 *   npm run sim:ringfall -- [runsPerSkillAndRegion] [region]
 *
 * After the tables, the hideout's pacing replays them through the meta, and the island campaign
 * plays a month per skill on one profile with the island carried (scripts/ringfall-campaign.ts).
 *
 * With a region id after the count, only that region's table is played. The tables' raids
 * are played in one worker process per core, and the campaign's months in a worker each beside
 * them; RINGFALL_SIM_JOBS sets how many workers play the tables (1 plays everything in this
 * process, in turn).
 */
import { CONTRACT, FRONT, STRENGTH, ALLY, BAG, DEPOT, ELITE, HOME, ENEMIES, HEALS, NOISE, PACK, PARTY, PLATE, PLAYER, RAIDERS, REINFORCE, SEARCH, SHIP_WAVES, SIGHT, STAGGER, TACTICAL, TICK, VALUABLES, VAULT, WEAPONS, WORLD } from "../src/ringfall/sim/config";
import { engageSquad, makeNoise } from "../src/ringfall/sim/awareness";
import { spawnEnemy } from "../src/ringfall/sim/enemies";
import { COVERS } from "../src/ringfall/sim/cover";
import { ENEMIES as KINDS, type EnemyKind, type Rarity } from "../src/ringfall/sim/config";
import { NET_EDGE, NODES, FRONT_LINKS, nodeIndex, TIER, type NodeId, BOXES, CAMP, DECKS, DEPOTS, depotIndex, ENTRIES, entryOf, EXTRA_BINS, EXTRACTS, inCamp, PACKS, PARTY_STOPS, POIS, poiIndex, poiRegion, REGIONS, regionHere, regionOf, ROAMERS, ROUTES, STOPS, type PoiId, type RegionId, type RouteId, type Squad } from "../src/ringfall/sim/map";
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
import { haulValue } from "../src/ringfall/sim/results";
import { SHIP_SQUAD, bagLoad, bagUsed, canOpen, makeRoom, toolIn, useTarget } from "../src/ringfall/sim/world";
import { bodyCenter, damageEnemy, eyePos, fireRay, magSize, robotGear, weakPoint } from "../src/ringfall/sim/combat";
import { lookAngles } from "../src/ringfall/sim/geom";
import { forward } from "../src/ringfall/sim/state";
import { build, buildFactory, buildState, buy, canBuild, deliver, depotAllowance, depotBudget, emptyLoadout, fitsStart, healRoom, itemCost, FIRST_ENTRY, loadoutCost, newProfile, parseProfile, pouch, price, sell, sellPrice, settle, takeKit, wares, type Item, type Profile } from "../src/ringfall/meta/profile";
import { emptyHideout, hideoutDone, maxLevel, MODULES, poisWith, sources, stashCap } from "../src/ringfall/meta/hideout";
import { boostFor, boosted } from "../src/ringfall/sim/state";
import { CONQUEST, COUNTER, FACTORY, HIDEOUT, TOOL_KINDS, TOOLS, VAULT } from "../src/ringfall/sim/config";
import { frontIncome, islandHolds, advanceDay, holds, newIsland, nightRaids, playerNodes, type RaidDay } from "../src/ringfall/meta/island";
import { activePacks } from "../src/ringfall/sim/island";
import { garrison, isVaultGuard } from "../src/ringfall/sim/island";
import { QUESTS, offered, raidCredit } from "../src/ringfall/meta/quests";
import { contractDone, makeBoard, targetKey, type Contract } from "../src/ringfall/meta/contracts";
import { currentStory, STORIES } from "../src/ringfall/meta/story";
import { RECORD_SPOTS } from "../src/ringfall/sim/map";
import { kill } from "../src/ringfall/sim/combat";
import { squadKey } from "../src/ringfall/sim/state";
import { nextLevel } from "../src/ringfall/meta/hideout";
import { take, takenContract } from "../src/ringfall/meta/profile";
import { META } from "../src/ringfall/sim/config";
import { fireRange, sense } from "../src/ringfall/sim/awareness";
import { AWARE, CREW, DEBRIS, RARITY, STORM } from "../src/ringfall/sim/config";
import { DEBRIS_SPOTS } from "../src/ringfall/sim/map";
import { crewKey, debrisBin } from "../src/ringfall/sim/state";
import { nextSeed } from "../src/ringfall/meta/profile";
import { raidDay, unfreeable } from "../src/ringfall/meta/island";
import { MOD_KINDS, MOD_START, MODS, RETURN, THREAT, type ModKind } from "../src/ringfall/sim/config";
import { binMod, robotMod } from "../src/ringfall/sim/mods";
import { Bot } from "../src/ringfall/sim/bot";
import { searchFor } from "../src/ringfall/sim/world";
import { healTime, tacticalCooldown } from "../src/ringfall/sim/player";
import { helpTime, reviveTime } from "../src/ringfall/sim/ally";
import { shoot } from "../src/ringfall/sim/combat";
import { analyse, factoryNeeded, raidThreat, recallLoadout, setThreat, wanted } from "../src/ringfall/meta/profile";
import { raidClock, strengthFor } from "../src/ringfall/sim/state";
import { pacing, type Pool } from "./ringfall-pacing";
import { MOBILES, OUTPOST_SITES } from "../src/ringfall/sim/map";
import { enemyNodes, frontNodes, garrisonOf, useCore, type NodeHold } from "../src/ringfall/sim/front";
import { factoryMax, factoryRarity, finishBattle, heldUnlocks, nodePoint } from "../src/ringfall/sim/battle";
import { departDepots, shopRarity } from "../src/ringfall/meta/island";
import { BIN_GEAR } from "../src/ringfall/sim/config";
import { currentStep, objectiveSteps } from "../src/ringfall/sim/objective";
import { beatOf, mobileWalk, placeMobile } from "../src/ringfall/sim/factions";
import { interceptSpot } from "../src/ringfall/sim/awareness";
import { campaignLines, campaigns, DAYS } from "./ringfall-campaign";
import { playTable, summarize, type RaidResult, type TableResult } from "./ringfall-table";
import type { RaidJob } from "./ringfall-table-worker";
import { fork, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { availableParallelism, setPriority } from "node:os";
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
/*
 * The island campaign does not use the tables' raids, and each skill's month is a chain of raids
 * played one after another, the longest single piece of the gate. With workers, its months start
 * now, beside the tables, and the tables' workers run at a lower priority: the months get the
 * cores they need and the tables' raids, short pieces, fill the rest. The campaign table is
 * still printed last.
 */
const months = jobs > 1 && runs > 0 && !only ? campaigns(DAYS, SKILLS.length) : null;
// A month that fails is reported where its table is printed, not when it fails.
months?.catch(() => {});
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
    if (months && w.pid !== undefined) {
      try {
        setPriority(w.pid, 10);
      } catch {
        // Without the lower priority the tables only share the cores evenly with the months.
      }
    }
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
  // Each walk (`MOBILES`) runs from node to node over the main ground of its region: its nodes stand
  // on the floor, every point of its walk is on the ground a walker's field covers, and no step of it
  // is longer than a few cells (each leg found a way). A beat's squad stands in its POI's garrison.
  for (const m of MOBILES) {
    for (const [x, z] of m.nodes) {
      // A node lies on the open ground between the areas, not on an area's pressed floor: on the ground as it lies.
      point(`walk ${m.name} node`, x, z, terrainHeight(x, z));
      if (regionHere({ x, z }).id !== m.region) bad.push(`walk ${m.name}: node ${x},${z} lies in ${regionHere({ x, z }).id}, not ${m.region}`);
    }
    const walk = mobileWalk(m);
    walk.forEach((q, i) => {
      if (!onMainGround(q.x, q.z)) bad.push(`walk ${m.name}: point ${q.x.toFixed(0)},${q.z.toFixed(0)} is off the main ground`);
      const next = walk[(i + 1) % walk.length];
      if (dist2d(q, next) > 14) bad.push(`walk ${m.name}: a step of ${dist2d(q, next).toFixed(0)} m from ${q.x.toFixed(0)},${q.z.toFixed(0)} (no way between its nodes)`);
    });
    if (m.from && !POIS[poiIndex(m.from.poi)].squads.some((sq) => sq.name === m.from!.squad && !isVaultGuard(sq))) bad.push(`walk ${m.name}: ${m.from.poi} has no squad ${m.from.squad} to walk it (or it is the vault guard)`);
    if (!m.from && !m.members?.length) bad.push(`walk ${m.name}: no members`);
  }
  // Every outpost's guards stand on its floor (they are among ROAMERS).
  for (const o of OUTPOST_SITES) if (!ROAMERS.some((sq) => sq.name === o.guard)) bad.push(`outpost ${o.id}: no guard squad ${o.guard}`);
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
/** A wipe ends the raid at once. */
function checkDeathEndsRaid(): string | null {
  const s = padRun();
  const p = s.player;
  p.haul = ["core", "board"];
  p.hp = 1;
  p.shield = 0;
  p.selfRevive = 0;
  hurtAlly(s, 999);
  hurtPlayer(s, 10, p.pos.x, p.pos.z);
  if (s.phase !== "done" || s.outcome !== "dead") return `death scenario: phase ${s.phase}, outcome ${s.outcome}`;
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
  if (FIRST_ENTRY !== "beach" || fresh.v !== 22 || fresh.entries.join() !== "beach") return `known entries: a fresh profile knows ${fresh.entries.join()}`;
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
  if (v10?.v !== 22 || v10.entries.length !== ENTRIES.length || v10.region !== "harbor" || v10.entry !== "quay") return `known entries: a v10 save loaded as ${JSON.stringify(v10 && { v: v10.v, entries: v10.entries, region: v10.region, entry: v10.entry })}`;
  // A harbor start with no harbor way in known moves to the reservoir; with a harbor depot on that the node held opens a start from (the yard's) it stays.
  const shut = save({ ...fresh, region: "harbor", entry: "quay", entries: ["beach", "nowhere"] });
  if (shut?.region !== "reservoir" || shut.entry !== "beach" || shut.entries.join() !== "beach") return `known entries: a harbor start with no harbor way in loaded as ${shut?.region} / ${shut?.entry}`;
  const depot = save({ ...fresh, region: "harbor", entry: "jetty", entries: ["jetty"], depots: ["yard"], poiState: { ...fresh.poiState, yard: { state: "freed" } } });
  const shutDepot = save({ ...fresh, region: "harbor", entry: "jetty", entries: ["jetty"], depots: ["wreck"], poiState: { ...fresh.poiState, wreck: { state: "freed" } } });
  if (shutDepot?.region !== "reservoir") return "known entries: a harbor start through a depot that opens no start loaded in the harbor";
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
/**
 * The shelves remember the last loadout (`Profile.lastKit`): a raid's kit is picked again while the
 * stash holds things like it, armour goes with the lent kit's weapons, and a save before v20 has
 * none while a v20 one keeps it (well-formed parts only).
 */
function checkLoadout(): string | null {
  const p: Profile = { ...newProfile(), stash: [{ t: "weapon", kind: "pike", rarity: 2 }, { t: "weapon", kind: "lance", rarity: 1 }, { t: "armor", tier: 2 }, { t: "key", poi: "quarry" }, { t: "heal", kind: "cell" }, { t: "heal", kind: "cell" }, { t: "weapon", kind: "pike", rarity: 0 }, { t: "armor", tier: 2 }] };
  const taken = takeKit(p, { weapons: [0, 1], armor: 2, heals: { cell: 2, battery: 0, syringe: 0, medkit: 0 }, keys: [3] });
  const last = taken.profile.lastKit;
  if (JSON.stringify(last) !== JSON.stringify({ weapons: [{ kind: "pike", rarity: 2 }, { kind: "lance", rarity: 1 }], armor: 2, keys: ["quarry"], heals: { cell: 2, battery: 0, syringe: 0, medkit: 0 } })) return `loadout scenario: the kit remembered is ${JSON.stringify(last)}`;
  // The stash after the raid holds the common PIKE and the spare armour: those are picked, the epic PIKE and the LANCE are gone.
  const again = recallLoadout(taken.profile);
  const st = taken.profile.stash;
  if (again.weapons.length !== 0 || st[again.armor ?? -1]?.t !== "armor" || again.keys.length || again.heals.cell !== 0) return `loadout scenario: after the raid the shelves picked ${JSON.stringify(again)} from ${JSON.stringify(st)}`;
  // Brought home: all picked again.
  const home: Profile = { ...taken.profile, stash: [...st, { t: "weapon", kind: "lance", rarity: 1 }, { t: "weapon", kind: "pike", rarity: 2 }, { t: "key", poi: "quarry" }, { t: "heal", kind: "cell" }] };
  const back = recallLoadout(home);
  const names = back.weapons.map((n) => { const i = home.stash[n]; return i.t === "weapon" ? `${i.kind}${i.rarity}` : "?"; }).join();
  if (names !== "pike2,lance1" || home.stash[back.keys[0]]?.t !== "key" || back.heals.cell !== 1) return `loadout scenario: with the kit home the shelves picked ${names}, keys ${back.keys}, ${back.heals.cell} cells`;
  // Armour goes with the lent kit's weapons.
  const lentArmor = takeKit(p, { ...emptyLoadout(), armor: 2 });
  if (!lentArmor.kit.weapons.every((w) => w.loan) || lentArmor.kit.armor !== 2) return `loadout scenario: the lent kit with armour came out as ${JSON.stringify(lentArmor.kit)}`;
  // Saves: before v20 none; v20 keeps it, cleaned.
  const v19 = parseProfile(JSON.parse(JSON.stringify({ ...taken.profile, v: 19 })));
  if (!v19 || v19.v !== 22 || v19.lastKit !== null) return `loadout scenario: a v19 save loaded with ${JSON.stringify(v19?.lastKit)}`;
  const v20 = parseProfile(JSON.parse(JSON.stringify(taken.profile)));
  if (JSON.stringify(v20?.lastKit) !== JSON.stringify(last)) return `loadout scenario: a v20 save loaded with ${JSON.stringify(v20?.lastKit)}`;
  const junk = parseProfile(JSON.parse(JSON.stringify({ ...taken.profile, lastKit: { weapons: [{ kind: "nope", rarity: 0 }, { kind: "pike", rarity: 9 }, { kind: "talon", rarity: 3 }], armor: 7, keys: ["quarry", "nowhere", "quarry"], heals: { cell: 99, medkit: -1 } } })));
  if (JSON.stringify(junk?.lastKit) !== JSON.stringify({ weapons: [{ kind: "talon", rarity: 3 }], armor: 0, keys: ["quarry"], heals: { cell: HEALS.cell.max, battery: 0, syringe: 0, medkit: 0 } })) return `loadout scenario: a save with bad picks loaded as ${JSON.stringify(junk?.lastKit)}`;
  // The factory's materials count among the valuables still wanted, and claim stash room before what nothing needs.
  const fac = factoryNeeded(newProfile());
  if (fac.fuse !== FACTORY.levels.reduce((n, l) => n + (l.items.find(([k]) => k === "fuse")?.[1] ?? 0), 0) || !(wanted(newProfile()).board >= fac.board)) return `loadout scenario: the factory wants ${JSON.stringify(fac)}`;
  return null;
}

/** The stash: a raid takes its kit out, getting off brings it and the haul home, a wipe keeps only the pouch. */
function checkSettle(): string | null {
  let p = newProfile();
  const start = p.stash.length;
  // Two stash weapons and a cell in; the cell is used up, a rare PIKE is picked up instead of the HORNET.
  const taken = takeKit(p, { weapons: [0, 1], armor: null, heals: { cell: 1, battery: 0, syringe: 0, medkit: 0 }, keys: [] });
  if (taken.kit.weapons.some((w) => w.loan) || taken.kit.heals.cell - taken.kit.lentHeals.cell !== 1) return `settle scenario: the stash kit came out wrong (${JSON.stringify(taken.kit)})`;
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
  if (loaded?.v !== 22 || loaded.depots.length || loaded.seen !== "") return `depot scenario: a v5 save loaded as ${JSON.stringify(loaded && { v: loaded.v, depots: loaded.depots, seen: loaded.seen })}`;
  const kept = parseProfile(JSON.parse(JSON.stringify({ ...after.profile, depots: ["pad", "nowhere", "pad"] })));
  if (kept?.depots.join() !== "pad" || kept.seen !== after.profile.seen) return `depot scenario: a v7 save loaded depots ${kept?.depots.join()}`;
  // A v6 save's explored map was drawn over the world before it widened: it is dropped, the depots stay.
  const v6 = parseProfile(JSON.parse(JSON.stringify({ ...after.profile, v: 6 })));
  if (v6?.v !== 22 || v6.seen !== "" || v6.depots.join() !== after.profile.depots.join()) return `depot scenario: a v6 save loaded as ${JSON.stringify(v6 && { v: v6.v, depots: v6.depots, seen: v6.seen.length })}`;
  // A v9 save dropped from the air over a smaller world: it starts at its region's first way in, its explored map dropped.
  if (!after.profile.seen) return "depot scenario: the raid explored nothing to save";
  // A v11 save's explored map was drawn over the narrower world: it is dropped, the rest stays.
  const v11 = parseProfile(JSON.parse(JSON.stringify({ ...after.profile, v: 11 })));
  if (v11?.v !== 22 || v11.seen !== "" || v11.depots.join() !== after.profile.depots.join() || v11.entries.join() !== after.profile.entries.join()) return `depot scenario: a v11 save loaded as ${JSON.stringify(v11 && { v: v11.v, seen: v11.seen.length, entries: v11.entries })}`;
  const v9 = parseProfile(JSON.parse(JSON.stringify({ ...after.profile, v: 9, entry: undefined, region: "harbor" })));
  if (v9?.v !== 22 || v9.seen !== "" || v9.entry !== regionOf("harbor").entries[0] || v9.depots.join() !== after.profile.depots.join()) return `depot scenario: a v9 save loaded as ${JSON.stringify(v9 && { v: v9.v, entry: v9.entry, seen: v9.seen.length })}`;
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
    // Starts from a depot need the node that opens them held (`UNLOCKS`): the yard and the supply depot.
    poiState: { ...newProfile(3).poiState, yard: { state: "freed" }, supply: { state: "freed" } },
    depots: ["yard", "supply"],
    depotSent: { yard: 0, supply: 0 },
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
  const at = (sent: number) => depotAllowance({ ...base, depotSent: { yard: sent } }, "yard");
  for (const [sent, level, budget, next] of [[0, 0, 2, 1500], [1499, 0, 2, 1], [1500, 1, 4, 3500], [4999, 1, 4, 1], [5000, 2, 6, 7000], [12000, 3, 9, null], [99999, 3, 9, null]] as const) {
    const a = at(sent);
    if (a.level !== level || a.budget !== budget || a.next !== next || a.sent !== sent) return `depot budget: ${sent} credits sent gave ${JSON.stringify(a)}`;
  }
  if (depotAllowance(base, "wreck").level !== 0) return "depot budget: a depot with nothing recorded is not level 0";

  // Sending through the yard's depot raises the yard's level, across raids, and never the supply depot's.
  const YARDD = depotIndex("yard");
  const d = DEPOTS[YARDD];
  const press = idleInput();
  press.interact = true;
  const raidSending = (haul: State["player"]["haul"]) => {
    const s = padRun();
    s.depots[YARDD] = true;
    s.depots[depotIndex("supply")] = true;
    s.player.pos = { x: d.x, y: groundAt(d.x, d.z, PLAYER.radius, d.y + 0.3), z: d.z };
    s.player.onGround = true;
    s.player.haul = [...haul];
    step(s, press, false);
    s.outcome = "dead";
    return s;
  };
  const r1 = raidSending(["core", "board"]);
  if (r1.sentVia[YARDD] !== 1300 || r1.sentVia.some((v, i) => i !== YARDD && v !== 0)) return `depot budget: sending a core and a board through the yard recorded ${r1.sentVia.join()}`;
  const p1 = settle(base, r1).profile;
  if (p1.depotSent.yard !== 1300 || p1.depotSent.supply !== 0 || depotAllowance(p1, "yard").level !== 0) return `depot budget: after one raid the profile holds ${JSON.stringify(p1.depotSent)}`;
  const p2 = settle(p1, raidSending(["board"])).profile;
  if (p2.depotSent.yard !== 1600 || depotAllowance(p2, "yard").level !== 1 || depotBudget(p2, "yard") !== 4 || depotAllowance(p2, "supply").level !== 0 || depotBudget(p2, "supply") !== 2) return `depot budget: after two raids the profile holds ${JSON.stringify(p2.depotSent)}`;
  // A raid that sends nothing keeps the record, and a depot switched on in it starts at 0.
  const quiet = padRun();
  quiet.depots[depotIndex("wreck")] = true;
  quiet.outcome = "dead";
  const p3 = settle(p2, quiet).profile;
  if (p3.depotSent.yard !== 1600 || p3.depotSent.wreck !== 0) return `depot budget: a raid sending nothing left ${JSON.stringify(p3.depotSent)}`;
  if (JSON.stringify(parseProfile(JSON.parse(JSON.stringify(p3)))?.depotSent) !== JSON.stringify(p3.depotSent)) return "depot budget: the sent record does not survive a save";

  // A v7 save loads with nothing sent through each depot on (and its explored map, over the smaller world, dropped); a current save keeps only its depots' records.
  const { depotSent: _ds, ...v7 } = { ...p3, v: 7 };
  const m7 = parseProfile(JSON.parse(JSON.stringify(v7)));
  if (m7?.v !== 22 || JSON.stringify(m7.depotSent) !== JSON.stringify(Object.fromEntries(p3.depots.map((x) => [x, 0]))) || m7.seen !== "") return `depot budget: a v7 save loaded as ${JSON.stringify(m7 && { v: m7.v, depotSent: m7.depotSent })}`;
  const odd = parseProfile(JSON.parse(JSON.stringify({ ...p3, depotSent: { yard: 2000, supply: -5, nowhere: 9, quarry: 7000 } })));
  if (JSON.stringify(odd?.depotSent) !== JSON.stringify({ supply: 0, wreck: 0, yard: 2000 })) return `depot budget: a save's odd records loaded as ${JSON.stringify(odd?.depotSent)}`;

  // takeKit refuses a depot start over its allowance, and takes the same loadout as a drop.
  const epic = { ...emptyLoadout(), weapons: [0] };
  if (takeKit(base, epic, "yard") !== null || fitsStart(base, epic, "yard")) return "depot budget: an epic weapon (3) started from a level 0 depot (2)";
  const dropped = takeKit(base, epic, null);
  if (!dropped || dropped.kit.weapons[0]?.kind !== "pike" || dropped.profile.stash.length !== base.stash.length - 1) return "depot budget: the same loadout was not taken for a start at a way in";
  if (takeKit(base, epic).kit.weapons[0]?.kind !== "pike") return "depot budget: takeKit without a start no longer takes the loadout";
  if (!takeKit(base, free, "yard") || !takeKit(base, { ...emptyLoadout(), weapons: [1], keys: [5] }, "yard")) return "depot budget: a loadout within the allowance (the lent kit; a common and a key) was refused";
  if (takeKit(base, { ...emptyLoadout(), weapons: [1], armor: 2 }, "yard") !== null) return "depot budget: a common and tier 2 armour (3) started from a level 0 depot (2)";
  if (takeKit(base, epic, "wreck") !== null) return "depot budget: a start from a depot that is not on was allowed";
  const levelled = takeKit(p2, { ...emptyLoadout(), weapons: [0, 1] }, "yard");
  if (!levelled || levelled.kit.weapons.length !== 2) return "depot budget: a level 1 depot (4) refused an epic and a common (4)";
  if (takeKit(p2, { ...emptyLoadout(), weapons: [0, 1] }, "supply") !== null) return "depot budget: the supply depot was levelled by sends through the yard";
  return null;
}

/** The hideout: building takes exactly its items and credits, each module's benefit is real, the top levels are the last. */
function checkHideout(): string | null {
  const count = (p: Profile, k: string) => p.stash.filter((i) => i.t === "valuable" && i.kind === k).length;
  const give = (p: Profile, list: [string, number][]): Profile => ({ ...p, stash: [...p.stash, ...list.flatMap(([k, n]) => Array.from({ length: n }, (): Item => ({ t: "valuable", kind: k as "fuse" }))) ] });
  // Every level asks only for kinds that bins or vaults hold, and only for modules that exist.
  for (const m of MODULES)
    for (const l of HIDEOUT[m].levels) {
      for (const [k] of l.items) if (!poisWith(k).length && !VAULT.valuables.some((set) => set.includes(k))) return `hideout scenario: ${m} needs ${k}, which no bin or vault holds`;
    }
  // The trader sells the common parts from the start, and rarer valuables with each workbench level.
  const sells = (workbench: number, k: string) => wares({ ...newProfile(1), hideout: { ...emptyHideout(), workbench } }).some((i) => i.t === "valuable" && i.kind === k);
  if (!sells(0, "fuse") || sells(0, "board")) return "hideout scenario: the trader's valuables without a workbench are not just the common parts";
  if (!sells(1, "board") || !sells(1, "drive") || sells(1, "reactor")) return "hideout scenario: the workbench Lv1 trader does not sell boards and drives (and only them)";
  if (!sells(2, "core") || !sells(2, "reactor")) return "hideout scenario: the workbench Lv2 trader does not sell cores and reactors";
  if (sources("reactor")[0]?.share === undefined) return "hideout scenario: the reactor has no source";
  // The infirmary's first level: one fuse short it cannot be built; with them it takes exactly its items and credits.
  const first = HIDEOUT.infirmary.levels[0];
  let p = { ...newProfile(), cash: 5000 };
  p = give(p, first.items.map(([k, n]) => [k, k === "fuse" ? n - 1 : n]));
  if (canBuild(p, "infirmary") || build(p, "infirmary")) return "hideout scenario: the infirmary was built a fuse short";
  p = give(p, [["fuse", 1], ["board", 2]]);
  const before = p.stash.length;
  const built = build(p, "infirmary");
  if (!built || built.hideout.infirmary !== 1 || built.cash !== p.cash - first.cash || built.stash.length !== before - first.items.reduce((n, [, c]) => n + c, 0) || count(built, "fuse") !== 0 || count(built, "board") !== 2)
    return `hideout scenario: building the infirmary took ${p.cash - (built?.cash ?? p.cash)} credits and left ${built?.stash.length} things`;
  // The card names what is in the way: the parts still missing, or only the credits once they are all there.
  const fuseShort = give({ ...newProfile(), cash: 5000 }, first.items.map(([k, n]) => [k, k === "fuse" ? n - 1 : n]));
  const broke = give({ ...newProfile(), cash: first.cash - 50 }, first.items);
  if (buildState(fuseShort, "infirmary") !== "あと 1 個" || buildState(broke, "infirmary") !== "あと 50 クレジット")
    return `hideout scenario: the infirmary's card said "${buildState(fuseShort, "infirmary")}" one fuse short and "${buildState(broke, "infirmary")}" 50 credits short`;
  // A module's level waits only for its own level before it: the second level is built on the first alone.
  const second = HIDEOUT.storage.levels[1];
  const up = build(give({ ...newProfile(), cash: second.cash, hideout: { ...emptyHideout(), storage: 1 } }, second.items), "storage");
  if (up?.hideout.storage !== 2 || MODULES.some((m) => m !== "storage" && up.hideout[m] !== 0)) return `hideout scenario: the storage's second level on the first alone left ${JSON.stringify(up?.hideout)}`;
  // Every module's top level asks for a data core or a small reactor, so the rarest valuables keep a use.
  for (const m of MODULES) if (!HIDEOUT[m].levels.at(-1)!.items.some(([k]) => k === "core" || k === "reactor") && m !== "workbench") return `hideout scenario: ${m}'s top level asks for no core nor reactor`;
  // The free kit's heals and the infirmary's are lent to every kit, own weapons or not; they never come home.
  const sick = { ...newProfile(), hideout: { ...emptyHideout(), infirmary: 2 } };
  const freeKit2 = takeKit(sick, { weapons: [], armor: null, heals: { cell: 0, battery: 0, syringe: 0, medkit: 0 }, keys: [] }).kit;
  const ownKit = takeKit(sick, { weapons: [0], armor: null, heals: { cell: 0, battery: 0, syringe: 0, medkit: 0 }, keys: [] }).kit;
  if (freeKit2.heals.syringe !== META.free.heals.syringe + 1 || freeKit2.heals.cell !== META.free.heals.cell + 2 || JSON.stringify(ownKit.heals) !== JSON.stringify(freeKit2.heals) || ownKit.lentHeals.cell !== META.free.heals.cell + 2)
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
  // The nodes held open the trader's gear (`UNLOCKS`): none common, the supply depot rare, a tier-1
  // node epic, a tier-2 legendary; the workbench does not change it, and losing the node takes it away.
  const shelf = (held: NodeId[], workbench = 0) => {
    const p = { ...newProfile(), hideout: { ...emptyHideout(), workbench }, poiState: Object.fromEntries(POIS.map((o) => [o.id, { state: held.includes(o.id as NodeId) ? "freed" : "held" }])) as Profile["poiState"] };
    return Math.max(...wares(p).map((i) => (i.t === "weapon" ? i.rarity : i.t === "armor" ? i.tier : 0)));
  };
  for (const [held, want] of [[[], 0], [["supply"], 1], [["supply", "quarry"], 2], [["supply", "relay"], 2], [["supply", "relay", "smelter"], 3], [["supply", "quarry", "yard"], 3], [["wreck"], 0], [[], 0]] as [NodeId[], number][])
    if (shelf(held) !== want || shelf(held, 2) !== want) return `hideout scenario: holding ${held.join(",") || "nothing"} the trader sells gear up to ${shelf(held)} (${shelf(held, 2)} with the workbench), expected ${want}`;
  if (META.shopRarity !== 0) return "hideout scenario: the trader sells better than common holding no node";
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
  // Every module at its top level is the hideout done; nothing is built past it.
  const full = Object.fromEntries(MODULES.map((m) => [m, maxLevel(m)])) as Profile["hideout"];
  const top = { ...newProfile(), cash: 99999, hideout: full };
  if (!hideoutDone(full) || hideoutDone({ ...full, pouch: maxLevel("pouch") - 1 }) || MODULES.some((m) => build(give(top, HIDEOUT[m].levels.at(-1)!.items), m))) return "hideout scenario: a module was built past its top level";
  // A v20 save loses the generator and the escape craft and keeps the other modules' levels; its intro quest to build the generator counts as the infirmary's.
  const v20 = parseProfile(JSON.parse(JSON.stringify({ ...newProfile(), v: 20, hideout: { generator: 3, infirmary: 2, workbench: 1, storage: 3, radio: 0, pouch: 1, craft: 4 }, escaped: { raids: 31, extracted: 25, time: 3600 }, quests: { progress: {}, done: ["grunts", "power", "craft", "navigator"] } })));
  if (!v20 || v20.v !== 22 || JSON.stringify(v20.hideout) !== JSON.stringify({ infirmary: 2, workbench: 1, storage: 3, radio: 0, pouch: 1 }) || "escaped" in v20 || v20.quests.done.join() !== "grunts,medbay")
    return `storage scenario: a v20 save loaded as ${JSON.stringify(v20 && { v: v20.v, hideout: v20.hideout, quests: v20.quests })}`;
  // Saves: a v4 profile keeps its stash and starts with an empty hideout; a v5 one keeps its hideout.
  const v4 = { v: 4, cash: 900, stash: [{ t: "valuable", kind: "gyro" }, { t: "weapon", kind: "pike", rarity: 2 }, { t: "key", poi: "yard" }], raids: 9, extracted: 7, quests: { progress: {}, done: ["grunts"] }, region: "harbor" };
  const m4 = parseProfile(JSON.parse(JSON.stringify(v4)));
  if (!m4 || m4.v !== 22 || m4.stash.length !== 3 || m4.raids !== 9 || MODULES.some((m) => m4.hideout[m] !== 0) || m4.region !== "harbor") return `storage scenario: a v4 save loaded as ${JSON.stringify(m4)}`;
  const m5 = parseProfile(JSON.parse(JSON.stringify(top)));
  if (!m5 || !hideoutDone(m5.hideout) || m5.seed !== top.seed) return "storage scenario: a saved hideout did not load";
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
 * The island's state (docs/ringfall/island-v2.md): one settled raid is one day; a node whose core
 * the raid captured is the player's (its depot on) however the raid ended, clearing alone takes
 * nothing, the titan's pad is never the player's, and a node stays the player's however long it
 * goes unvisited. With a battle, each node is as the battle ended: one the enemy took back is
 * the enemy's. A raid's garrison follows: full while the enemy holds a POI, nobody once it is the player's.
 */
function checkIsland(): string | null {
  const PADD = poiIndex("pad");
  const raid = (seed: number, o: { alive: boolean; cleared?: number[]; visited?: number[] }, island?: Profile["poiState"]) => {
    const s = newRun(seed, freeKit(), "reservoir", island ? { island: holds({ poiState: island }) } : {});
    s.outcome = o.alive ? "extracted" : "dead";
    s.stats.cleared = [...(o.cleared ?? [])];
    // A POI cleared in these days is one whose core was captured too: clearing alone takes nothing.
    s.stats.captured = (o.cleared ?? []).filter((i) => !POIS[i].boss).map((i) => POIS[i].id as NodeId);
    for (const i of o.visited ?? []) s.visited[i] = true;
    return s;
  };
  let p = newProfile();
  if (p.day !== 1 || POIS.some((o) => p.poiState[o.id].state !== "held")) return `island scenario: a new profile is on day ${p.day} with ${JSON.stringify(p.poiState)}`;
  // A wipe after capturing is a day too, and the node it took stays the player's.
  const wiped = settle(p, raid(11, { alive: false, cleared: [SUPPLY], visited: [SUPPLY] }));
  if (wiped.profile.day !== 2 || wiped.day !== 1 || wiped.freed.join() !== "supply" || wiped.front.gained.join() !== "supply" || wiped.profile.poiState.supply.state !== "freed") return `island scenario: a wipe after capturing the supply depot left ${JSON.stringify({ day: wiped.profile.day, freed: wiped.freed, supply: wiped.profile.poiState.supply })}`;
  // Clearing a POI of its robots without capturing its core takes nothing.
  const unclaimed = raid(11, { alive: true, visited: [SUPPLY] });
  unclaimed.stats.cleared = [SUPPLY];
  if (settle(p, unclaimed).profile.poiState.supply.state !== "held") return "island scenario: clearing the supply depot without its core took it";
  // Getting off after clearing the supply depot and the titan's pad takes the depot only.
  const won = settle(p, raid(11, { alive: true, cleared: [SUPPLY, PADD], visited: [SUPPLY, PADD] }));
  p = won.profile;
  if (won.freed.join() !== "supply" || p.poiState.supply.state !== "freed" || p.poiState.pad.state !== "held" || !p.depots.includes("supply")) return `island scenario: clearing the supply depot and the pad and getting off took ${won.freed.join()} with depots ${p.depots.join()}`;
  // Days pass without a visit: the depot stays the player's.
  let q = p;
  for (let d = 1; d <= 6; d++) q = settle(q, raid(20 + d, { alive: true, visited: [QUARRY] }, q.poiState)).profile;
  if (q.poiState.supply.state !== "freed" || q.day !== p.day + 6) return `island scenario: six days unvisited left the supply depot ${q.poiState.supply.state} on day ${q.day}`;
  // With a battle, the nodes are as it ended: the enemy took the supply depot back, the player's squads took the quarry.
  const fought = raid(70, { alive: true }, p.poiState);
  fought.battle = { end: 0, now: 0, t: 0, squads: [], nextId: 1, made: [0, 0, 0], meter: NODES.map(() => null), factory: 0, rarity: 1, start: [...fought.nodes], taken: [], done: true, landings: [], departs: [], threat: NODES.map(() => false), rally: -1, counters: [], left: null };
  fought.nodes[nodeIndex("supply")] = "held";
  fought.nodes[nodeIndex("quarry")] = "freed";
  const night = settle(p, fought);
  // The battle's end, before the night's attacks (which may take the quarry back, `nightRaids()`).
  const fell = night.night.lost;
  if (night.profile.poiState.supply.state !== "held" || night.profile.poiState.quarry.state !== (fell.includes("quarry") ? "held" : "freed") || night.raid.lost.join() !== "supply" || night.raid.gained.join() !== "quarry" || night.after.gained.length || night.after.lost.length) return `island scenario: a battle that ended with the supply depot the enemy's and the quarry the player's left ${JSON.stringify({ front: night.front, supply: night.profile.poiState.supply, quarry: night.profile.poiState.quarry })}`;
  // The enemy's strength follows the nodes it holds.
  if (newRun(77).strength !== STRENGTH.play || STRENGTH.byHeld[NODES.length] !== STRENGTH.play) return `island scenario: a raid with every node the enemy's plays at strength ${newRun(77).strength}, not ${STRENGTH.play}`;
  for (let k = 1; k < STRENGTH.byHeld.length; k++) if (STRENGTH.byHeld[k] < STRENGTH.byHeld[k - 1]) return "island scenario: the enemy's strength falls as it holds more nodes";
  // The garrisons: held in full and as with no island given, freed empty.
  const count = (s: State, i: number) => s.enemies.filter((e) => e.poi === i).length;
  const plain = newRun(77);
  const allHeld = newRun(77, freeKit(), "reservoir", { island: holds({ poiState: newIsland() }) });
  if (JSON.stringify(plain.enemies) !== JSON.stringify(allHeld.enemies) || plain.rng !== allHeld.rng) return "island scenario: a raid with every POI held is not the raid with no island given";
  const mixed = { ...newIsland(), quarry: { state: "freed" as const }, pad: { state: "freed" as const } };
  const m = newRun(77, freeKit(), "reservoir", { island: holds({ poiState: mixed }) });
  if (m.strength !== strengthFor(NODES.length - 1)) return `island scenario: a raid with one node the player's plays at strength ${m.strength}`;
  // A POI's squads that walk a beat (`MOBILES`) are out on it, not counted among the POI's own.
  const posted = (i: number, list: Squad[]) => list.filter((sq) => !beatOf(POIS[i].id, sq.name)).reduce((n, sq) => n + sq.members.length, 0);
  const full = (i: number) => posted(i, POIS[i].squads);
  if (count(m, QUARRY) !== 0 || !m.cleared[QUARRY] || !m.depots[depotIndex("quarry")]) return `island scenario: a freed quarry stands ${count(m, QUARRY)} robots, cleared ${m.cleared[QUARRY]}, depot ${m.depots[depotIndex("quarry")]}`;
  if (count(m, PADD) !== full(PADD) || m.hold[PADD] !== "held") return "island scenario: the titan's pad was freed";
  for (const i of POIS.map((_, k) => k).filter((k) => k !== QUARRY && k !== PADD)) if (count(m, i) !== full(i)) return `island scenario: a held ${POIS[i].id} stands ${count(m, i)} robots, not ${full(i)}`;
  // A freed POI is not cleared again in the raid, and its vault opens without the key.
  m.reinforceT = m.raiderT = 1e9;
  ticks(m, 1);
  if (m.stats.cleared.includes(QUARRY)) return "island scenario: a freed POI counted as cleared in the raid";
  const vault = m.bins.find((b) => b.poi === QUARRY && b.vault)!;
  const locked = m.bins.find((b) => b.poi === SUPPLY && b.vault)!;
  if (!canOpen(m, vault) || canOpen(m, locked)) return "island scenario: a freed POI's vault took its key, or a held one's did not";
  // A quest to clear a POI freed before it was offered is done by coming into it.
  m.visited[QUARRY] = false;
  if (raidCredit({ t: "clear", poi: "quarry" }, m)) return "island scenario: a freed POI not come into counted for a quest to clear it";
  m.visited[QUARRY] = true;
  if (raidCredit({ t: "clear", poi: "quarry" }, m) !== 1) return "island scenario: coming into a freed POI did not count for a quest to clear it";
  // Saves: a v12 one is on the day after its raids with every POI held; one before v22 moves its
  // POIs freed and thin to the player and the rest to the enemy, the pad the enemy's, and drops the network and the outposts.
  const v12 = parseProfile(JSON.parse(JSON.stringify({ ...newProfile(), v: 12, raids: 6, day: undefined, poiState: undefined })));
  if (!v12 || v12.v !== 22 || v12.day !== 7 || POIS.some((o) => v12.poiState[o.id].state !== "held")) return `island scenario: a v12 save loaded on day ${v12?.day} with ${JSON.stringify(v12?.poiState)}`;
  const v21 = { ...p, v: 21, network: 4, pressure: 1.2, outposts: { pumps: "rogue", substation: "freed" }, scores: [{ day: 1, score: [1, 2, 0], won: false }], poiState: { ...newIsland(), supply: { state: "freed", lastVisit: 1, since: 0 }, quarry: { state: "thin", lastVisit: 1, since: 2 }, relay: { state: "held", lastVisit: 0, since: 0 }, pad: { state: "freed", lastVisit: 2, since: 0 } } };
  const back = parseProfile(JSON.parse(JSON.stringify(v21)));
  if (!back || back.v !== 22 || back.day !== p.day || playerNodes(back).join() !== "supply,quarry" || back.poiState.pad.state !== "held" || "network" in back || "pressure" in back || "outposts" in back || "scores" in back) return `island scenario: a v21 save loaded as ${JSON.stringify(back && { v: back.v, day: back.day, poiState: back.poiState, extra: ["network", "pressure", "outposts", "scores"].filter((k) => k in back) })}`;
  return null;
}

/**
 * The enemy's strength (docs/ringfall/island-v2.md): the gate's level is today's island exactly,
 * with every node the enemy's; a raid's level follows the nodes the enemy holds
 * (`STRENGTH.byHeld`), and each level's times and numbers apply in `newRun()`; the board names
 * only packs that fly at the island's level.
 */
function checkStrength(): string | null {
  const play = STRENGTH.levels[STRENGTH.play];
  const regionPacks = (r: RegionId) => PACKS.filter((q) => regionHere(q.patrol![0]).id === r).length;
  if (play.reinforce.first !== REINFORCE.first || play.reinforce.every !== REINFORCE.every || play.raiders !== RAIDERS.at || REGIONS.some((r) => play.parties[r.id] !== PARTY.count[r.id] || play.packs[r.id] !== regionPacks(r.id)))
    return `strength scenario: level ${STRENGTH.play}, which the gate plays, is not the island's own numbers`;
  for (let n = 1; n < STRENGTH.levels.length; n++) {
    const l = STRENGTH.levels[n];
    const was = STRENGTH.levels[n - 1];
    if (l.reinforce.first > was.reinforce.first || l.reinforce.every > was.reinforce.every || l.raiders > was.raiders || REGIONS.some((r) => l.parties[r.id] < was.parties[r.id] || l.packs[r.id] < was.packs[r.id])) return `strength scenario: level ${n} is easier than level ${n - 1}`;
  }
  // The island with the player holding the first `k` nodes of the row out from the camp.
  const ROW_OUT: NodeId[] = ["supply", "quarry", "relay", "station", "waterworks", "lodge", "yard", "smelter", "cannery", "coldstore", "wreck"];
  const island = (k: number) => holds({ poiState: { ...newIsland(), ...Object.fromEntries(ROW_OUT.slice(0, k).map((id) => [id, { state: "freed" as const }])) } });
  for (let k = 0; k <= NODES.length; k++) {
    const n = strengthFor(NODES.length - k);
    const l = STRENGTH.levels[n];
    for (const seed of [5, 91]) {
      const s = newRun(seed, freeKit(), "reservoir", { island: island(k) });
      if (s.strength !== n || enemyNodes(s.nodes) !== NODES.length - k) return `strength scenario: with ${k} nodes the player's, a raid plays at ${s.strength}, not ${n}`;
      if (s.reinforceT !== l.reinforce.first || s.raiderT !== l.raiders) return `strength scenario: a raid at level ${n} waits ${s.reinforceT} s and ${s.raiderT} s, not ${l.reinforce.first} and ${l.raiders}`;
      for (const r of REGIONS) if (s.parties.filter((q) => q.region === r.id).length !== l.parties[r.id]) return `strength scenario: a raid at level ${n} has ${s.parties.filter((q) => q.region === r.id).length} parties in ${r.id}, not ${l.parties[r.id]}`;
      const packs = s.squads.filter((q) => q.pack);
      for (const r of REGIONS) {
        const mine = packs.filter((q) => regionHere(q.patrol[0]).id === r.id).length;
        if (mine !== Math.min(l.packs[r.id], regionPacks(r.id))) return `strength scenario: a raid at level ${n} flies ${mine} packs in ${r.id}, not ${l.packs[r.id]}`;
      }
      // At threat 0 plates are the garrisons' (by their node's tier) and the raiders': a roaming squad or a pack wears none.
      const plain = s.enemies.filter((e) => e.poi < 0 && !e.elite && (s.squads[e.squad]?.roam || s.squads[e.squad]?.pack));
      if (plain.some((e) => e.plate > 0)) return `strength scenario: a roaming robot wears a plate at level ${n} (seed ${seed})`;
      if (s.enemies.some((e) => e.poi >= 0 && e.plate > 0 && e.plate !== Math.max(TIER[POIS[e.poi].id as NodeId] ?? 0, 1))) return `strength scenario: a garrison's robot wears a plate not of its node's tier at level ${n} (seed ${seed})`;
    }
  }
  const plainRun = newRun(321);
  const atPlay = newRun(321, freeKit(), "reservoir", { island: island(0) });
  const sameAs = (a: State, b: State) => JSON.stringify([a.enemies, a.squads, a.rng, a.roamRng, a.nextId, a.parties]) === JSON.stringify([b.enemies, b.squads, b.rng, b.roamRng, b.nextId, b.parties]);
  if (!sameAs(plainRun, atPlay) || plainRun.strength !== STRENGTH.play) return "strength scenario: a raid with no island given is not the raid with every node the enemy's";
  // The board names only packs that fly at the island's level.
  for (const seed of [1, 77, 4242])
    for (let k = 0; k <= NODES.length; k++) {
      const poiState = { ...newIsland(), ...Object.fromEntries(ROW_OUT.slice(0, k).map((id) => [id, { state: "freed" as const }])) };
      const b = makeBoard({ ...newProfile(seed), seed, poiState, entries: ENTRIES.map((e) => e.id) });
      if (b.contracts.length < 2 || b.contracts.length > 4) return `strength scenario: the board with ${k} nodes the player's (seed ${seed}) has ${b.contracts.map((c) => c.t).join()}`;
      for (const c of b.contracts) if (c.t === "intercept" && c.target.t === "pack" && !activePacks(seed, strengthFor(NODES.length - k)).some((q) => q.name === (c.target as { name: string }).name)) return `strength scenario: the board with ${k} nodes the player's names a pack that does not fly: ${c.target.name}`;
    }
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
    { ...newIsland(), supply: { state: "freed" as const }, quarry: { state: "freed" as const } },
    Object.fromEntries(POIS.map((o) => [o.id, { state: o.boss ? ("held" as const) : ("freed" as const) }])) as Profile["poiState"],
  ];
  const hideouts = [emptyHideout(), { ...emptyHideout(), infirmary: 1, workbench: 1 }];
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
                return l ? l.items.map(([k]) => k) : [];
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
  // Free: the supply depot's core captured, which counts on a wipe as well (the node is the player's).
  const free: Contract = { t: "free", id: "t-free", poi: "supply", reward: { cash: 1200, items: [] } };
  const fr = newRun(21);
  fr.stats.cleared = [SUPPLY];
  fr.stats.captured = ["supply"];
  fr.visited[SUPPLY] = true;
  fr.outcome = "extracted";
  const frDone = settle(taking(free), fr);
  if (!paid(taking(free), frDone, free) || frDone.profile.poiState.supply.state !== "freed") return `contract scenario: freeing the supply depot left ${JSON.stringify(frDone.contract)}`;
  fr.outcome = "dead";
  const frLost = settle(taking(free), fr);
  if (!paid(taking(free), frLost, free) || frLost.profile.poiState.supply.state !== "freed") return "contract scenario: a wipe after capturing the supply depot's core did not pay the contract to take it";
  const frNone = newRun(21);
  frNone.stats.cleared = [SUPPLY];
  frNone.outcome = "extracted";
  if (settle(taking(free), frNone).contract?.done) return "contract scenario: clearing the supply depot without its core paid the contract to take it";
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
  // One slot left: a reactor, dearer than a fuse from the same raid and wanted by the hideout as much, takes it.
  const tight = { ...newProfile(), stash: Array.from({ length: META.stash - 1 }, () => ({ t: "heal" as const, kind: "cell" as const })), quests: { progress: {}, done: QUESTS.map((q) => q.id) } };
  const tk = takeKit(tight, { weapons: [], armor: null, heals: { cell: 0, battery: 0, syringe: 0, medkit: 0 }, keys: [] });
  const ts = newRun(10, tk.kit, "harbor");
  ts.outcome = "extracted";
  ts.player.haul = ["fuse", "reactor"];
  const tr = settle(tk.profile, ts);
  const last = tr.profile.stash.at(-1);
  if (last?.t !== "valuable" || last.kind !== "reactor" || !tr.sold.some((i) => i.t === "valuable" && i.kind === "fuse")) return `quest scenario: with one slot left the stash kept ${JSON.stringify(last)} and sold ${JSON.stringify(tr.sold)}`;
  const v1 = parseProfile({ v: 1, cash: 10, stash: [], raids: 2, extracted: 1 });
  if (!v1 || v1.v !== 22 || v1.quests.done.length || v1.region !== "reservoir") return "storage scenario: a v1 save does not load";
  // v2 saves named a key's POI by its place in the list; it loads as that POI's id.
  const v2 = parseProfile({ v: 2, cash: 10, stash: [{ t: "key", poi: 2 }, { t: "key", poi: 9 }], raids: 1, extracted: 1, quests: { progress: {}, done: [] } });
  const v2Key = v2?.stash[0];
  if (!v2 || v2.v !== 22 || v2.stash.length !== 1 || v2Key?.t !== "key" || v2Key.poi !== "relay") return `storage scenario: a v2 save's key 2 loaded as ${JSON.stringify(v2?.stash)}, not the relay key`;
  // A v3 save keeps its keys by id and drops into the reservoir; the landing choice is kept.
  const v3 = parseProfile({ v: 3, cash: 10, stash: [{ t: "key", poi: "wreck" }], raids: 1, extracted: 1, quests: { progress: {}, done: [] } });
  if (!v3 || v3.v !== 22 || v3.stash.length !== 1 || v3.region !== "reservoir") return `storage scenario: a v3 save loaded as ${JSON.stringify(v3)}`;
  if (parseProfile(JSON.parse(JSON.stringify({ ...newProfile(), region: "harbor", entries: ["beach", "outskirts"] })))?.region !== "harbor") return "storage scenario: the landing choice did not survive a save";
  // The trader's quests are the intro quests; a quest chain from before the board loads with the quests there still are.
  if (QUESTS.map((q) => q.id).join() !== "grunts,village,medbay,parts" || QUESTS.some((q) => !q.intro)) return `quest scenario: the intro quests are ${QUESTS.filter((q) => q.intro).map((q) => q.id).join()}`;
  const v13 = parseProfile(JSON.parse(JSON.stringify({ ...newProfile(), v: 13, board: undefined, taken: undefined, records: undefined, stash: [{ t: "weapon", kind: "talon", rarity: 3 }, { t: "key", poi: "yard" }], quests: { progress: { drones: 2, heavies: 1, parts: 0 }, done: ["grunts", "drones", "quarry", "relay", "power"] } })));
  if (!v13 || v13.v !== 22 || v13.quests.done.join() !== "grunts,medbay" || Object.keys(v13.quests.progress).join() !== "parts" || v13.stash.length !== 2 || v13.records.length || v13.taken !== null || v13.board.day !== v13.day || !v13.board.contracts.length)
    return `quest scenario: a v13 save with the old quests loaded as ${JSON.stringify(v13 && { v: v13.v, quests: v13.quests, stash: v13.stash.length, board: v13.board.contracts.length })}`;
  if (offered(v13.quests).map((q) => q.id).join() !== "village,parts") return `quest scenario: the migrated save is offered ${offered(v13.quests).map((q) => q.id).join()}`;
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
 * The walks (`MOBILES`): each region's, walked alone and all of one faction for 240 s with the
 * player away in the other region, keep going along their loops (each leader passes 20 points of
 * its walk or more), and none is held up for good.
 */
function checkPatrols(): string | null {
  for (const region of REGIONS) {
    const s = padRun();
    s.ally.active = false;
    s.squads = [];
    const away = REGIONS.find((r) => r.id !== region.id)!;
    const far = POIS[poiIndex(away.pois[0])];
    s.player.pos = { x: far.entry.x, y: groundAt(far.entry.x, far.entry.z, 0.4, terrainHeight(far.entry.x, far.entry.z) + 2), z: far.entry.z };
    const kindsOf = (m: (typeof MOBILES)[number]): EnemyKind[] => m.members ?? POIS[poiIndex(m.from!.poi)].squads.find((sq) => sq.name === m.from!.squad)!.members.map((q) => q.kind);
    const mine = MOBILES.filter((m) => m.region === region.id);
    for (const m of mine) placeMobile(s, { ...m, faction: "net" }, kindsOf(m), (st, kind, x, z, squad, face) => void spawnEnemy(st, kind, x, z, -1, squad, { face }));
    const legs = s.squads.map(() => 0);
    const last = s.squads.map((q) => q.leg);
    for (let i = 0; i < 240 / TICK; i++) {
      s.player.iframes = 1;
      step(s, idleInput(), false);
      s.squads.forEach((q, n) => {
        if (q.leg !== last[n]) legs[n]++;
        last[n] = q.leg;
      });
    }
    const slow = s.squads.map((q, n) => ({ q, n })).filter(({ n }) => legs[n] < 20);
    if (slow.length) return `patrols: in ${region.id}, ${slow.map(({ q, n }) => `${q.name} passed ${legs[n]} points (leader at ${s.enemies.find((e) => e.squad === n)?.pos.x.toFixed(0)},${s.enemies.find((e) => e.squad === n)?.pos.z.toFixed(0)}, ${s.enemies.find((e) => e.squad === n)?.aware})`).join("; ")} in 240 s`;
  }
  return null;
}

/**
 * The factions (see FACTION and TERRITORY):
 * - a network squad and a rogue squad 30 m apart on open ground, the player far off, find each
 *   other, both take damage, at least one robot falls within 40 s, and the player hears it (a
 *   fight marked among the contacts);
 * - a POI's garrison takes no part: a rogue squad set down beside one does not fight it;
 * - the rogues grow as the network weakens: more rogue robots at network 0 than at 2, and at 2
 *   than at 5, in each region; a rogue-held outpost's guards are rogues.
 */
function checkFactions(): string | null {
  const at = openSpot(24, 18, 18);
  if (!at) return "factions: no open ground for the test";
  const s = padRun();
  s.ally.active = false;
  const sides = [false, true].map((rogue) => {
    const squad = s.squads.length;
    s.squads.push({ name: "test", poi: -1, patrol: [], leg: 0, engaged: false, roam: false, sinceSeen: 0, last: { x: 0, z: 0 }, rogue: rogue || undefined });
    const x = at.x + (rogue ? 15 : -15);
    return ["grunt", "grunt"].map((k, i) => spawnEnemy(s, k as EnemyKind, x, at.z - 14 + i * 3, -1, squad, { face: rogue ? -Math.PI / 2 : Math.PI / 2, rogue }));
  });
  const full = sides.map((side) => side.reduce((n, e) => n + e.hp + e.shield, 0));
  let fell = 0;
  let found = -1;
  for (let i = 0; i < 40 / TICK && s.phase === "play"; i++) {
    step(s, idleInput(), false);
    fell += s.events.filter((e) => e.t === "fall").length;
    if (found < 0 && s.squads.some((q) => q.name === "test" && q.foe !== undefined)) found = s.time;
  }
  const left = sides.map((side) => side.filter((e) => s.enemies.includes(e)).reduce((n, e) => n + e.hp + e.shield, 0));
  if (found < 0) return `factions: a network and a rogue squad 30 m apart in the open never found each other`;
  if (left.some((l, k) => l >= full[k])) return `factions: one side took no damage (left ${left.map(Math.round).join(" / ")} of ${full.join(" / ")})`;
  if (!fell) return `factions: no robot fell in 40 s of a fight between the factions (left ${left.map(Math.round).join(" / ")})`;
  if (!s.contacts.some((c) => c.fight)) return `factions: the player ${dist2d(s.player.pos, at).toFixed(0)} m off did not hear the fight`;
  // A POI's garrison holds its post: a rogue squad beside it, in plain view, is not fought.
  const g = padRun();
  g.ally.active = false;
  const poi = POIS[SUPPLY];
  g.enemies = [];
  const sq = poi.squads[0];
  const gi = g.squads.length;
  g.squads.push({ name: sq.name, poi: SUPPLY, patrol: [], leg: 0, engaged: false, roam: false, sinceSeen: 0, last: { x: 0, z: 0 } });
  const posted = sq.members.map((m) => spawnEnemy(g, m.kind, m.x, m.z, SUPPLY, gi, { floor: m.y, face: m.face }));
  const ri = g.squads.length;
  g.squads.push({ name: "test", poi: -1, patrol: [], leg: 0, engaged: false, roam: false, sinceSeen: 0, last: { x: 0, z: 0 }, rogue: true });
  spawnEnemy(g, "grunt", posted[0].pos.x + 8, posted[0].pos.z, -1, ri, { rogue: true, face: -Math.PI / 2 });
  ticks(g, 8);
  if (g.squads[gi].foe !== undefined || g.squads[ri].foe !== undefined || g.events.some((e) => e.t === "fall")) return "factions: a POI's garrison fought a rogue squad beside it";
  // Fewer rogues walk as the enemy grows stronger (the player holding none, three, or all of the nodes).
  const weakened = (k: number) => holds({ poiState: { ...newIsland(), ...Object.fromEntries(NODES.slice(0, k).map((n) => [n.id, { state: "freed" as const }])) } });
  for (const region of REGIONS) {
    const rogues = [NODES.length, 3, 0].map((k) => newRun(9, freeKit(), region.id, { island: weakened(k) }).enemies.filter((e) => e.rogue && regionHere(e.pos).id === region.id).length);
    if (!(rogues[0] >= rogues[1] && rogues[1] >= rogues[2] && rogues[0] > rogues[2])) return `factions: rogues in ${region.id} with the enemy at its weakest / middling / strongest are ${rogues.join(" / ")}, not fewer as it strengthens`;
  }
  // The rogues hold no ground: every outpost's guards are the enemy's.
  const r2 = newRun(9);
  for (const o of OUTPOST_SITES) if (r2.enemies.some((e) => r2.squads[e.squad]?.name === o.guard && e.rogue)) return `factions: ${o.name}'s guards are rogues`;
  return null;
}

/**
 * A squad out on the roads that hears the player running makes for where they are heading, not
 * for the sound: the player runs along open ground and fires once, a roaming pair of grunts 40 m
 * to the side (facing away) hears it, and its goal and, 8 s on, its leader lie ahead of the spot
 * the shot came from along the player's way (by 12 m and 6 m or more).
 */
function checkIntercept(): string | null {
  const at = openSpot(60, 4, 4);
  if (!at) return "intercept: no open ground for the test";
  const side = [40, -40].find((dx) => onMainGround(at.x + dx, at.z - 4) && !steepAt(at.x + dx, at.z - 4));
  if (side === undefined) return "intercept: no ground beside the open strip for the pair";
  const s = padRun();
  s.ally.active = false;
  const p = s.player;
  p.pos = { x: at.x, y: groundAt(at.x, at.z, 0.4, terrainHeight(at.x, at.z) + 2), z: at.z };
  p.yaw = 0;
  p.onGround = true;
  const squad = s.squads.length;
  s.squads.push({ name: "test", poi: -1, patrol: [], leg: 0, engaged: false, roam: true, sinceSeen: 0, last: { x: 0, z: 0 } });
  const away = side > 0 ? Math.PI / 2 : -Math.PI / 2;
  const pair = [spawnEnemy(s, "grunt", at.x + side, at.z - 4, -1, squad, { face: away }), spawnEnemy(s, "grunt", at.x + side, at.z - 1, -1, squad, { face: away })];
  const run = { ...idleInput(), moveZ: 1 };
  ticks(s, 1.5, run);
  const heard = { x: p.pos.x, z: p.pos.z };
  makeNoise(s, heard.x, heard.z, NOISE.talon, true);
  const goal = pair[0].goal;
  const ahead = (q: { x: number; z: number }) => -(q.z - heard.z);
  if (!goal || pair[0].aware !== "alert") return `intercept: the roaming pair did not hear the shot 40 m off (${pair[0].aware})`;
  if (ahead(goal) < 12) return `intercept: the pair heard a running player and made for ${ahead(goal).toFixed(1)} m ahead of the shot, not where they were heading`;
  ticks(s, 8, run);
  if (ahead(pair[0].pos) < 6) return `intercept: 8 s on, the pair's leader stands ${ahead(pair[0].pos).toFixed(1)} m ahead of the shot along the player's way`;
  // A squad posted at a POI looks at the sound itself.
  const posted = { ...s.squads[squad], roam: false };
  s.squads.push(posted);
  const still = interceptSpot(s, s.squads.length - 1, heard.x, heard.z);
  if (dist2d(still, heard) > 0.01) return "intercept: a squad without a walk made for somewhere other than the sound";
  return null;
}

/**
 * A squad of three or more splits at once (see SPLIT): three grunts 18 m off a player standing in
 * the open have members on both sides of the line from their front member to the player, each
 * 30 degrees or more off it, within 5 s, before a pinch would start.
 */
function checkSplit(): string | null {
  const at = openSpot(19, 8, 8);
  if (!at) return "split: no open ground for the test";
  // Over ten draws of the raid's random numbers (the island's garrisons draw on them first), a squad goes round
  // both sides within 8 s in about half: the gate holds it to three at least.
  const both: number[] = [];
  for (const rng of [101, 202, 303, 404, 505, 606, 707, 808, 909, 1010]) {
    const { s, foes } = standoff(at, 18, ["grunt", "grunt", "grunt"]);
    s.rng = rng;
    const p = s.player;
    const lead = foes[0];
    const sides = new Set<number>();
    for (let i = 0; i < 8 / TICK; i++) {
      p.iframes = 1;
      step(s, idleInput(), false);
      const la = Math.atan2(lead.pos.x - p.pos.x, lead.pos.z - p.pos.z);
      for (const e of foes.slice(1)) {
        if (!s.enemies.includes(e)) continue;
        const a = Math.atan2(e.pos.x - p.pos.x, e.pos.z - p.pos.z) - la;
        const off = Math.atan2(Math.sin(a), Math.cos(a));
        if (Math.abs(off) >= 30 * (Math.PI / 180)) sides.add(Math.sign(off));
      }
    }
    both.push(sides.size);
  }
  if (both.filter((n) => n >= 2).length < 3) return `split: within 8 s three grunts went round on ${both.join("/")} side(s) of the player`;
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
 * Time to kill with a PIKE, every round on the body of a robot that faces the player (the usual
 * fight), at 12 m and at 30 m: with the free kit's common one a grunt falls in 1.5-2.5 s of fire
 * and a heavy in 3-4 s; a plate one step past the gun stretches a grunt to 5.5-8 s, and a gun that
 * pierces it brings that back (a raider with an epic one in 2.3-3.5 s). The kill says where the shot came from.
 */
function checkTimeToKill(): string | null {
  const at = openSpot(31, 3, 3);
  if (!at) return "ttk scenario: no open ground for the test";
  const cases: [string, EnemyKind, (e: Enemy) => void, number, number, Rarity][] = [
    ["grunt", "grunt", () => {}, 1.5, 2.5, 0],
    ["heavy", "heavy", () => {}, 3, 4, 0],
    ["plate-1 grunt", "grunt", (e) => (e.plate = 1), 5.5, 8, 0],
    ["plate-1 grunt", "grunt", (e) => (e.plate = 1), 1.5, 2.5, 1],
    ["plate-2 grunt", "grunt", (e) => (e.plate = 2), 5.5, 8, 1],
    ["plate-3 heavy", "heavy", (e) => (e.plate = 3), 3, 4, 3],
    ["raider", "grunt", (e) => { e.elite = true; e.plate = RAIDERS.plate; e.hp *= ELITE.hp; e.shield *= ELITE.hp; }, 2.3, 3.5, 2],
  ];
  for (const dist of [12, 30])
    for (const [name, kind, dress, lo, hi, rarity] of cases) {
      const { s, foes } = standoff(at, dist, [kind]);
      const e = foes[0];
      dress(e);
      const gun = { kind: "pike" as const, rarity, mag: -1 };
      let n = 0;
      while (s.enemies.includes(e) && n < 400) {
        s.events = [];
        const a = lookAngles(eyePos(s), bodyCenter(e));
        fireRay(s, gun, forward(a.yaw, a.pitch));
        n++;
      }
      const t = (n - 1) * WEAPONS.pike.interval;
      if (t < lo || t > hi) return `ttk scenario: a ${RARITY.names[rarity]} PIKE took ${n} body rounds (${t.toFixed(1)} s of fire) to kill a ${name} facing the player at ${dist} m (want ${lo}-${hi} s)`;
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
  // A garrison wears its node's tier of plate: every plated robot of it at that tier (the vault
  // guard at least `VAULT.guardPlate`), only grunts and heavies, the supply depot's guard alone.
  const run = newRun(5);
  const share: number[] = [0, 0, 0, 0];
  const count: number[] = [0, 0, 0, 0];
  for (const [i, poi] of POIS.entries()) {
    const vault = poi.bins.find((b) => b.vault);
    if (!vault || poi.id === "pad") continue;
    const guards = poi.squads.flatMap((sq) => sq.members).filter((m) => m.kind === "grunt");
    const guard = guards.reduce((a, b) => (Math.hypot(b.x - vault.x, b.z - vault.z) < Math.hypot(a.x - vault.x, a.z - vault.z) ? b : a));
    if (guard.plate !== VAULT.guardPlate) return `plate scenario: ${poi.id}'s vault guard wears plate ${guard.plate ?? 0}, expected ${VAULT.guardPlate}`;
    const tier = TIER[poi.id as NodeId];
    const want = Math.max(tier, VAULT.guardPlate);
    const live = run.enemies.filter((e) => e.poi === i && e.plate > 0);
    if (live.some((e) => e.plate !== (tier || want) || (e.kind !== "grunt" && e.kind !== "heavy"))) return `plate scenario: ${poi.id} (tier ${tier}) spawns plates ${live.map((e) => `${e.kind}${e.plate}`).join(",")}`;
    if (tier === 0 && live.length !== 1) return `plate scenario: the tier-0 ${poi.id} spawns ${live.length} plated robots, expected its vault guard alone`;
    const plain = run.enemies.filter((e) => e.poi === i && (e.kind === "grunt" || e.kind === "heavy"));
    share[tier] += live.length;
    count[tier] += plain.length;
  }
  for (const t of [1, 2, 3]) if (count[t] && share[t] / count[t] < PLATE.garrison[t] * 0.6) return `plate scenario: ${share[t]} of the ${count[t]} grunts and heavies of tier-${t} garrisons wear plates`;
  // Which robots wear one is the seed's and the robot's, never the raid's random numbers: the same raid twice plates alike.
  if (JSON.stringify(newRun(5).enemies.map((e) => e.plate)) !== JSON.stringify(run.enemies.map((e) => e.plate))) return "plate scenario: the same raid plated its robots differently";

  // A piercing hit that takes a plated robot's shield breaks the plate off; a blocked one never does.
  const pl = foes[0];
  pl.plate = pl.wore = 2;
  pl.hp = ENEMIES.grunt.hp;
  pl.shield = 1;
  s.events = [];
  damageEnemy(s, pl, 5, false, bodyCenter(pl), "none", "player", 1);
  if (pl.plate !== 2) return "plate scenario: a blocked hit broke a plate";
  pl.shield = 1;
  s.events = [];
  damageEnemy(s, pl, 5, false, bodyCenter(pl), "none", "player", 2);
  if (pl.plate !== 0 || pl.wore !== 2 || !s.events.some((e) => e.t === "plateBreak")) return `plate scenario: an epic hit through the shield of a plate-2 grunt left plate ${pl.plate}`;

  // Guns from robots: a plated robot or a raider drops one of its plate's rarity by the raid's seed
  // and the robot alone; a plain robot none; about `PLATE.drop` of plated robots.
  const gs = newRun(9);
  let platedN = 0;
  let dropped = 0;
  for (const e of gs.enemies) {
    const g = robotGear(gs, e);
    if (JSON.stringify(g) !== JSON.stringify(robotGear(gs, e))) return "plate scenario: a robot's gun is not the same when asked twice";
    if (e.kind === "titan") {
      if (g?.rarity !== 3) return "plate scenario: the titan does not drop a legendary gun";
      continue;
    }
    if (e.wore === 0 && !e.elite && g) return `plate scenario: an unplated ${e.kind} drops a gun`;
    if (e.wore > 0) {
      platedN++;
      if (g) {
        dropped++;
        if (g.rarity !== e.wore) return `plate scenario: a plate-${e.wore} ${e.kind} drops a rarity-${g.rarity} gun`;
      }
    }
  }
  if (platedN < 20 || dropped / platedN > PLATE.drop * 2.5 || dropped === 0) return `plate scenario: ${dropped} of ${platedN} plated robots drop a gun`;
  return null;
}


/**
 * What holding a node opens (`UNLOCKS`, docs/ringfall/island-v2.md): starts only from the depots
 * of the nodes that open them while held, the factory's extra squads, the north shore, the
 * factory's arms; and plain bins hold gear seldom, common or rare only, by their own hash.
 */
function checkUnlocks(): string | null {
  const holding = (ids: NodeId[]): Profile => ({ ...newProfile(2), depots: ["supply", "quarry", "yard"], poiState: Object.fromEntries(POIS.map((o) => [o.id, { state: ids.includes(o.id as NodeId) ? "freed" : "held" }])) as Profile["poiState"] });
  if (departDepots(holding(["supply", "quarry"])).join() !== "supply") return `unlocks: holding the supply depot and the quarry, starts from ${departDepots(holding(["supply", "quarry"])).join()}`;
  if (departDepots(holding(["supply", "quarry", "yard"])).join() !== "supply,yard") return "unlocks: holding the yard does not open a start from its depot";
  if (departDepots(holding(["quarry"])).length) return "unlocks: a depot on at a node lost still opens a start";
  if (takeKit(holding(["supply", "quarry"]), emptyLoadout(), "quarry") !== null || !takeKit(holding(["supply", "quarry"]), emptyLoadout(), "supply")) return "unlocks: a start from the quarry's depot was allowed, or the supply depot's refused";
  if (shopRarity(holding(["supply", "quarry", "yard"])) !== 3) return "unlocks: holding the yard does not put legendary gear on the shelf";
  const nodes = (ids: NodeId[]) => NODES.map((n) => (ids.includes(n.id) ? "freed" : "held")) as State["nodes"];
  for (const [ids, extra] of [[[], 0], [["quarry"], 1], [["quarry", "smelter"], 2], [["supply", "relay", "yard", "wreck"], 0]] as [NodeId[], number][])
    if (factoryMax({ nodes: nodes(ids) }, 2) !== FACTORY.max[2] + extra) return `unlocks: holding ${ids.join(",")} the factory keeps ${factoryMax({ nodes: nodes(ids) }, 2)} squads out`;
  if (heldUnlocks(nodes(["wreck"]), "shore").join() !== "wreck" || heldUnlocks(nodes(["relay"]), "scout").join() !== "relay") return "unlocks: the wreck does not watch the shore or the relay the sky";
  if (factoryRarity(nodes([])) !== PLATE.robots || factoryRarity(nodes(["supply", "quarry"])) !== 2 || factoryRarity(nodes(["supply", "yard"])) !== 3) return "unlocks: the factory's robots are not armed as the trader's shelf";
  // Plain bins: gear only now and then, never past rare, the same for the same raid.
  const open = (seed: number) => {
    const r = padRun();
    r.seed = seed;
    const out: string[] = [];
    for (const b of r.bins.filter((x) => !x.vault && !x.debris)) {
      r.loot = [];
      r.player.search = { bin: r.bins.indexOf(b), t: 99 };
      r.player.pos = { x: b.x, y: b.y, z: b.z };
      step(r, idleInput(), false);
      for (const l of r.loot) if (l.kind === "weapon" || l.kind === "armor") out.push(`${b.id}:${l.kind}${l.rarity}`);
    }
    return { out, bins: r.bins.filter((x) => !x.vault && !x.debris).length };
  };
  const a = open(77);
  if (a.out.join() !== open(77).out.join()) return "unlocks: the same raid's bins held different gear";
  if (a.out.some((x) => !/(weapon|armor)[01]$/.test(x))) return `unlocks: plain bins held ${a.out.filter((x) => !/(weapon|armor)[01]$/.test(x)).join(",")}`;
  const guns = a.out.filter((x) => x.includes("weapon")).length;
  if (guns === 0 || guns / a.bins > BIN_GEAR.weapon * 2.5) return `unlocks: ${guns} guns from ${a.bins} plain bins`;
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
  if (Math.abs(deck - (LEVEL.seabed + 13.5)) > 0.3) return `route scenario: walking up the open gangway ended at height ${deck.toFixed(2)}, not on the deck`;
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
  if (!v8 || v8.v !== 22 || v8.routes.length) return `tool scenario: a v8 save loaded with routes ${JSON.stringify(v8?.routes)}`;
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
  const quiet: RaidDay = { alive: true, cleared: [], visited: [], titan: false };
  const p: Profile = newProfile(23);
  if (p.events[0] !== null) return "event scenario: the first day has an event";
  let q: Profile = p;
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
  if (count < 25 || count > 55 || kinds.size !== 3) return `event scenario: 80 days had ${count} events of kinds ${[...kinds].join()}`;
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
  // A crews' visit brings a crew and a crew intercept on the board; no crew comes on another day.
  const visit = makeBoard({ ...newProfile(9), events: [{ t: "crews" }, null] });
  if (!visit.contracts.some((c) => c.t === "intercept" && c.target.t === "crew")) return "event scenario: a crews' visit has no intercept of the crew";
  const due = (event: { t: "crews" } | null) => newRun(77, freeKit(), "reservoir", { event }).crewsDue.length;
  if (due(null) !== 0 || due({ t: "crews" }) !== 1) return `event scenario: ${due(null)} crews come, ${due({ t: "crews" })} on a crews' visit`;
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
  // The crews are the rogues', and the network's squads out between the POIs would fight them (see
  // FACTION, checked by checkFactions()): these scenarios are played without those squads.
  {
    const quietRun = (crews: boolean) => {
      const t = withoutWalkers(newRun(1000, freeKit(), "reservoir", { event: { t: "crews" } }));
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
  const c = withoutWalkers(newRun(1000, freeKit(), "reservoir", { event: { t: "crews" } }));
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
  // A crew that gets off is counted.
  const o = withoutWalkers(newRun(1000, freeKit(), "reservoir", { event: { t: "crews" } }));
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
  return null;
}
/** The raid `s` without the robots out between the POIs (on walks, on the roads, at the outposts, the packs and the parties): its POIs' garrisons only. */
function withoutWalkers(s: State): State {
  s.enemies = s.enemies.filter((e) => e.poi >= 0);
  s.parties = [];
  return s;
}

/**
 * Mod parts: which bin or robot holds one is a hash of the seed, so a bot raid that picks none
 * up plays out as a raid without them; each part changes the number it claims; parts go on by
 * walking over them or by the use key; only a raid got off alive may analyse one.
 */
function checkMods(): string | null {
  if (MOD_START.length !== 6 || MOD_KINDS.length < 18) return `mod scenario: ${MOD_START.length} kinds known from the start of ${MOD_KINDS.length}`;
  // The same raid with parts and without: the bot leaves the parts lying, and every random number and id is drawn alike.
  let dropped = 0;
  // Played one after the other: each raid starts with the hunters' fields empty, as a raid of the tables does.
  const play = (seed: number, region: RegionId, noMods: boolean) => {
    const s = newRun(seed, freeKit(), region, { threat: THREAT.max, noMods });
    const bot = new Bot(SKILLS[2], 7);
    let prev = false;
    while (s.time < 420 && s.phase !== "done") {
      const inp = bot.input(s);
      step(s, inp, prev);
      prev = inp.crouch;
      dropped = Math.max(dropped, s.loot.filter((l) => l.kind === "mod").length);
    }
    return s;
  };
  for (const [seed, region] of [[71, "reservoir"], [233, "harbor"]] as const) {
    const a = play(seed, region, false);
    const b = play(seed, region, true);
    const look = (s: State) => JSON.stringify([s.time, s.rng, s.roamRng, s.crewRng, s.nextId, s.player.pos, s.player.hp, s.player.haul, s.stats, s.enemies.map((e) => [e.id, e.pos, e.hp]), s.loot.filter((l) => l.kind !== "mod")]);
    if (look(a) !== look(b)) return `mod scenario: a ${region} raid (seed ${seed}) with mod parts lying about played out unlike the same raid without them`;
    if (a.player.mods.length) return "mod scenario: the bot put a mod part on";
  }
  if (!dropped) return "mod scenario: no mod part turned up in two bot raids at the top threat";
  // Bins hold only known kinds, robots any; more of them at a higher threat; the same for the same seed.
  let low = 0;
  let high = 0;
  const robotKinds = new Set<string>();
  for (let seed = 1; seed <= 40; seed++) {
    const s0 = newRun(seed, freeKit(), "reservoir", { known: ["leech", "hush"] });
    const s5 = newRun(seed, freeKit(), "reservoir", { threat: 5, known: ["leech", "hush"] });
    for (const b of s0.bins) {
      const m = binMod(s0, b);
      if (m) low++;
      if (m && !["leech", "hush"].includes(m)) return `mod scenario: a bin holds ${m}, which the profile does not know`;
      if (b.vault && m) return "mod scenario: a vault holds a mod part";
      if (m !== binMod(newRun(seed, freeKit(), "reservoir", { known: ["leech", "hush"] }), b)) return "mod scenario: a bin's part is not fixed by the seed";
    }
    for (const b of s5.bins) if (binMod(s5, b)) high++;
    for (const e of s5.enemies) {
      const m = robotMod(s5, e);
      if (m) robotKinds.add(m);
    }
  }
  if (!(low > 0) || !(high > low * 1.8)) return `mod scenario: ${low} bins hold a part at threat 0 and ${high} at threat 5`;
  if (![...robotKinds].some((k) => !MOD_START.includes(k as ModKind))) return "mod scenario: robots never drop a kind the profile does not know";
  // Robots drop theirs where they fall, under an id of their own.
  {
    const s = newRun(9, freeKit(), "reservoir", { threat: 5 });
    const e = s.enemies.find((o) => robotMod(s, o));
    if (!e) return "mod scenario: no robot of a threat-5 raid carries a part";
    kill(s, e, false);
    const l = s.loot.find((o) => o.kind === "mod");
    if (!l || l.mod !== robotMod(s, e) || l.id >= 0) return "mod scenario: a robot carrying a part fell without dropping it";
    const plain = newRun(9, freeKit(), "reservoir", { threat: 5, noMods: true });
    kill(plain, plain.enemies.find((o) => o.id === e.id)!, false);
    if (plain.rng !== s.rng || plain.nextId !== s.nextId) return "mod scenario: a robot's part drew on the raid's numbers";
  }
  // Putting parts on: walking over one with a slot free, the use key swapping the oldest out, never two of a kind, never for the bot.
  {
    const s = padRun();
    s.ally.active = false;
    const p = s.player;
    const lay = (mod: ModKind, id: number) => s.loot.push({ id, kind: "mod", mod, rarity: 2, pos: { ...p.pos }, vel: { x: 0, y: 0, z: 0 }, age: 1 });
    lay("leech", -1);
    ticks(s, 0.1, { ...idleInput(), leaveMods: true });
    if (p.mods.length) return "mod scenario: an input that leaves parts put one on";
    ticks(s, 0.1);
    if (p.mods.join() !== "leech") return `mod scenario: walking over a part with slots free left ${p.mods.join()}`;
    lay("leech", -2);
    ticks(s, 0.1);
    if (p.mods.length !== 1 || !s.loot.some((l) => l.id === -2)) return "mod scenario: a second part of a kind worn went on";
    s.loot = s.loot.filter((l) => l.id !== -2);
    lay("grip", -3);
    lay("medic", -4);
    ticks(s, 0.1);
    if (p.mods.join() !== "leech,grip,medic") return `mod scenario: three parts went on as ${p.mods.join()}`;
    lay("probe", -5);
    ticks(s, 0.1);
    if (p.mods.length !== 3 || !s.loot.some((l) => l.id === -5)) return "mod scenario: a fourth part went on without the use key";
    const t = useTarget(s);
    if (t?.kind !== "mod") return `mod scenario: the use key at a part with every slot worn points at ${t?.kind}`;
    step(s, { ...idleInput(), interact: true }, false);
    if (p.mods.join() !== "grip,medic,probe" || !s.loot.some((l) => l.kind === "mod" && l.mod === "leech")) return `mod scenario: the use key swapped a part in as ${p.mods.join()}`;
  }
  // Each part changes the number it names.
  {
    const bare = { mods: [] as ModKind[] };
    const one = (k: ModKind) => ({ mods: [k] });
    if (searchFor(one("probe"), { flare: false, vault: false }) >= searchFor(bare, { flare: false, vault: false })) return "mod scenario: the probe does not shorten a search";
    if (healTime(one("medic"), "cell") >= healTime(bare, "cell")) return "mod scenario: the patch does not shorten a heal";
    if (tacticalCooldown(one("capacitor")) >= tacticalCooldown(bare)) return "mod scenario: the capacitor does not shorten the arc's wait";
    if (reviveTime(one("medlink")) >= reviveTime(bare) || helpTime(one("carrier")) >= helpTime(bare)) return "mod scenario: the link or the belt does not shorten a revive";
    // Reloading, regaining health and charging the ult, run in a raid.
    const timed = (mods: ModKind[], what: "reload" | "regen" | "ult" | "walk" | "recoil") => {
      const s = padRun();
      s.ally.active = false;
      const p = s.player;
      p.mods = mods;
      if (what === "reload") {
        p.weapons[0] = { kind: "pike", rarity: 0, mag: 0 };
        step(s, { ...idleInput(), reload: true }, false);
        return p.reload;
      }
      if (what === "regen") {
        p.hp = 10;
        p.sinceHurt = 99;
        ticks(s, 1);
        return p.hp;
      }
      if (what === "ult") {
        p.ult = 0;
        ticks(s, 2);
        return p.ult;
      }
      if (what === "recoil") {
        p.weapons[0] = { kind: "pike", rarity: 0, mag: -1 };
        shoot(s, p.weapons[0]!);
        return p.recoil;
      }
      ticks(s, 1.5, { ...idleInput(), moveX: 1 });
      return Math.hypot(p.vel.x, p.vel.z);
    };
    if (timed(["grip"], "reload") >= timed([], "reload")) return "mod scenario: the grip does not quicken a reload";
    if (timed(["mender"], "regen") <= timed([], "regen")) return "mod scenario: the mender does not quicken health coming back";
    if (timed(["surge"], "ult") <= timed([], "ult")) return "mod scenario: the surge does not quicken the ult's charge";
    if (timed(["stride"], "walk") <= timed([], "walk") + 0.1) return "mod scenario: the frame does not quicken walking";
    if (timed(["stock"], "recoil") >= timed([], "recoil")) return "mod scenario: the stock does not lessen the recoil";
    // Shots on a robot: the leech's shield, the piercer through a plate, the jolt's stagger, the back's damage.
    const at = openSpot(16, 2, 2);
    const far = openSpot(24, 2, 2);
    if (!at || !far) return "mod scenario: no open ground for the shots";
    const shot = (mods: ModKind[], how: "weak" | "plate" | "jolt" | "back" | "ambush-back" | "ambush-front") => {
      const { s, foes } = standoff(at, 12, ["grunt"]);
      const g = foes[0];
      const p = s.player;
      p.mods = mods;
      p.iframes = 99;
      p.shield = 0;
      g.shield = 0;
      g.hp = 1e6;
      if (how === "weak") {
        const a = lookAngles(eyePos(s), weakPoint(g));
        fireRay(s, { kind: "pike", rarity: 0, mag: -1 }, forward(a.yaw, a.pitch));
        return p.shield;
      }
      if (how === "plate") {
        g.plate = 2;
        damageEnemy(s, g, 100, false, bodyCenter(g), "front", "player", 0);
        return 1e6 - g.hp;
      }
      if (how === "jolt") {
        damageEnemy(s, g, 10, false, bodyCenter(g), "front", "player", 0);
        return g.stagger;
      }
      if (how === "ambush-back" || how === "ambush-front") {
        // An unaware robot, its back to the player or facing them.
        g.aware = "idle";
        g.yaw = lookAngles(g.pos, s.player.pos).yaw + (how === "ambush-back" ? Math.PI : 0);
        damageEnemy(s, g, 100, false, bodyCenter(g), "ambush", "player", 0);
        return 1e6 - g.hp;
      }
      damageEnemy(s, g, 100, false, bodyCenter(g), "back", "player", 0);
      return 1e6 - g.hp;
    };
    if (!(shot(["leech"], "weak") >= MODS.leech.value - 1e-9) || shot([], "weak") !== 0) return `mod scenario: a weak-point hit gave ${shot(["leech"], "weak")} shield with the coil and ${shot([], "weak")} without`;
    if (shot(["piercer"], "plate") <= shot([], "plate")) return "mod scenario: the piercer does not get more through a plate";
    if (shot(["jolt"], "jolt") <= shot([], "jolt")) return "mod scenario: the jolt does not build a stagger faster";
    if (shot(["stalker"], "back") <= shot([], "back")) return "mod scenario: the stalker does not add to a hit from behind";
    if (shot(["stalker"], "ambush-back") <= shot([], "ambush-back")) return "mod scenario: the stalker does not add to an ambush from behind";
    if (shot(["stalker"], "ambush-front") !== shot([], "ambush-front")) return "mod scenario: the stalker adds to an ambush from the front";
    // A drone watching the player fills its detection slower with the scrambler worn.
    const watched = (mods: ModKind[]) => {
      const { s, foes } = standoff(at, 14, ["drone"]);
      const d = foes[0];
      s.player.mods = mods;
      s.squads[d.squad].engaged = false;
      d.aware = "idle";
      d.detect = 0;
      ticks(s, 0.2);
      return d.detect;
    };
    if (!(watched([]) > 0) || watched(["scrambler"]) >= watched([])) return `mod scenario: a drone's detection filled ${watched(["scrambler"])} with the scrambler and ${watched([])} without`;
    // Crouched, the player is noticed from less far with the soles worn.
    const crouched = (mods: ModKind[]) => {
      // Further than the soles let it see, nearer than a crouch alone: 0.55 × 45 = 24.75 m; with the soles 19.8 m.
      const { s, foes } = standoff(far, 22, ["grunt"]);
      const g = foes[0];
      s.player.mods = mods;
      s.squads[g.squad].engaged = false;
      g.aware = "idle";
      g.detect = 0;
      ticks(s, 0.3, { ...idleInput(), crouch: true });
      return g.detect;
    };
    if (!(crouched([]) > 0) || crouched(["hush"]) !== 0) return `mod scenario: a crouched player at 22 m filled ${crouched([])} without the soles and ${crouched(["hush"])} with them`;
  }
  // Analysis: only a part worn out of a raid got off alive, only a kind not yet known, and its kind then turns up in bins.
  {
    const p = newProfile(4);
    const out = newRun(p.seed);
    out.player.mods = ["scrambler", "leech"];
    out.outcome = "extracted";
    const settled = settle(p, out);
    if (settled.analysable.join() !== "scrambler,leech") return `mod scenario: a raid got off alive may analyse ${settled.analysable.join()}`;
    if (analyse(settled.profile, settled, "leech")) return "mod scenario: a known kind was analysed again";
    const learnt = analyse(settled.profile, settled, "scrambler");
    if (!learnt?.known.includes("scrambler") || learnt.known.length !== MOD_START.length + 1) return `mod scenario: analysing the scrambler left ${learnt?.known.join()}`;
    if (analyse(settled.profile, settled, "stock")) return "mod scenario: a part not worn was analysed";
    const lost = newRun(p.seed);
    lost.player.mods = ["scrambler"];
    lost.outcome = "dead";
    const dead = settle(p, lost);
    if (dead.analysable.length || analyse(dead.profile, dead, "scrambler")) return "mod scenario: a wiped raid analysed a part";
    if (settle(p, out).profile.known.length !== MOD_START.length) return "mod scenario: settling learned a kind without analysis";
    const next = newRun(learnt.seed, freeKit(), "reservoir", { known: learnt.known });
    if (!next.known.includes("scrambler")) return "mod scenario: an analysed kind is not in the next raid's bins";
  }
  return null;
}

/**
 * The threat: 0 is the network's own raid; 5 changes every number it names; it pays the contract
 * more and turns up more parts; a POI freed at `THREAT.freeAt` or higher takes the network a step
 * further down, and is recorded at that threat. A mast destroyed on a day that started at
 * `NETWORK.relayHigh.at` takes it `relayHigh.steps` down. Saves before v17 load at threat 0.
 */
function checkThreat(): string | null {
  // The island at each of the enemy's strengths: the player holding none, three or all of the nodes.
  for (const k of [0, 3, NODES.length]) {
    const island = holds({ poiState: { ...newIsland(), ...Object.fromEntries(NODES.slice(0, k).map((o) => [o.id, { state: "freed" as const }])) } });
    const n = strengthFor(NODES.length - k);
    const l = STRENGTH.levels[n];
    for (const seed of [5, 91]) {
      const plain = newRun(seed, freeKit(), "reservoir", { island });
      const zero = newRun(seed, freeKit(), "reservoir", { island, threat: 0 });
      if (zero.reinforceT !== l.reinforce.first || zero.raiderT !== l.raiders || raidClock(n, 0).every !== l.reinforce.every) return `threat scenario: threat 0 at strength ${n} waits ${zero.reinforceT} s and ${zero.raiderT} s`;
      if (JSON.stringify([plain.enemies, plain.squads, plain.rng, plain.nextId]) !== JSON.stringify([zero.enemies, zero.squads, zero.rng, zero.nextId])) return `threat scenario: threat 0 at strength ${n} is not the island's raid`;
      const top = newRun(seed, freeKit(), "reservoir", { island, threat: THREAT.max });
      const clock = raidClock(n, THREAT.max);
      if (!(top.reinforceT < l.reinforce.first) || !(clock.every < l.reinforce.every) || !(top.raiderT < l.raiders) || top.reinforceT !== clock.first || top.raiderT !== clock.raiders) return `threat scenario: threat ${THREAT.max} at strength ${n} waits ${top.reinforceT} s and ${top.raiderT} s`;
      const plated = (s: State) => s.enemies.filter((e) => (e.kind === "grunt" || e.kind === "heavy") && !e.elite && e.plate > 0).length;
      if (!(plated(top) > plated(zero))) return `threat scenario: threat ${THREAT.max} at strength ${n} plates ${plated(top)} robots, threat 0 ${plated(zero)}`;
    }
  }
  // Robots answer shots from afar from further at a higher threat.
  const answer = (threat: number) => {
    const s = newRun(5, freeKit(), "reservoir", { threat });
    const g = s.enemies.find((e) => e.kind === "grunt")!;
    s.squads[g.squad].shotT = 5;
    return fireRange(s, g);
  };
  if (answer(0) !== RETURN.range.grunt || !(answer(THREAT.max) > answer(0))) return `threat scenario: a grunt answers from ${answer(0)} m at threat 0 and ${answer(THREAT.max)} m at threat ${THREAT.max}`;
  // A contract done at a high threat pays more.
  {
    const job: Contract = { t: "intercept", id: "t-threat", target: { t: "pack", name: PACKS[0].name }, reward: { cash: 500, items: [] } };
    const q: Profile = { ...newProfile(5), board: { day: 1, contracts: [job] }, taken: job.id };
    for (const threat of [0, 3]) {
      const r = newRun(q.seed, freeKit(), "reservoir", { threat });
      r.outcome = "dead";
      r.stats.wiped = [PACKS[0].name];
      const paid = settle({ ...q, threat }, r);
      const want = threat ? Math.round(job.reward.cash * THREAT.levels[threat].reward) : job.reward.cash;
      if (!paid.contract?.done || paid.profile.cash !== q.cash + want || paid.contract.cash !== want) return `threat scenario: the contract at threat ${threat} paid ${paid.profile.cash - q.cash}, not ${want}`;
    }
  }
  // The best threat each POI was freed at, kept through a later freeing at a lower one.
  {
    let p = newProfile(6);
    const freeSupply = (threat: number) => {
      const s = newRun(p.seed, freeKit(), "reservoir", { threat, island: holds(p) });
      s.outcome = "extracted";
      s.stats.cleared = [SUPPLY];
      s.stats.captured = ["supply"];
      return settle({ ...p, threat }, s);
    };
    p = freeSupply(4).profile;
    if (p.freedAt.supply !== 4) return `threat scenario: freeing the supply depot at threat 4 recorded ${p.freedAt.supply}`;
    p = { ...p, poiState: { ...p.poiState, supply: { state: "held" } } };
    p = freeSupply(1).profile;
    if (p.freedAt.supply !== 4 || p.freedAt.quarry !== undefined) return `threat scenario: a later freeing at threat 1 left the record ${JSON.stringify(p.freedAt)}`;
  }
  // The 強度 belongs to the contract taken: none taken plays at 0, whatever was set; taking another contract starts it at 0.
  {
    const p0 = newProfile();
    const set = setThreat(p0, 4);
    const c0 = p0.board.contracts[0];
    const on = setThreat(take(p0, c0.id), 4);
    if (raidThreat(set) !== 0 || raidThreat(on) !== 4 || take(on, c0.id).threat !== 4 || (p0.board.contracts[1] && take(on, p0.board.contracts[1].id).threat !== 0) || raidThreat(take(on, null)) !== 0) return `threat scenario: the 強度 without a contract is ${raidThreat(set)}, with one ${raidThreat(on)}`;
  }
  // Saves: before v17 a profile knows the starting kinds, plays at threat 0 and has freed nothing at a threat; a v17 one keeps them.
  const v16 = parseProfile(JSON.parse(JSON.stringify({ ...newProfile(), v: 16, known: undefined, threat: undefined, freedAt: undefined })));
  if (!v16 || v16.v !== 22 || v16.known.join() !== MOD_START.join() || v16.threat !== 0 || Object.keys(v16.freedAt).length) return `threat scenario: a v16 save loaded as ${JSON.stringify(v16 && { v: v16.v, known: v16.known, threat: v16.threat, freedAt: v16.freedAt })}`;
  const v16junk = parseProfile(JSON.parse(JSON.stringify({ ...newProfile(), v: 16, known: ["stock"], threat: 4, freedAt: { supply: 5 } })));
  if (!v16junk || v16junk.known.includes("stock") || v16junk.threat !== 0 || v16junk.freedAt.supply !== undefined) return "threat scenario: a v16 save took fields it could not have had";
  const v17 = parseProfile(JSON.parse(JSON.stringify(setThreat({ ...newProfile(), known: [...MOD_START, "stock"], freedAt: { supply: 3, pad: 9 as number } }, 4))));
  if (!v17 || v17.threat !== 4 || !v17.known.includes("stock") || v17.freedAt.supply !== 3 || v17.freedAt.pad !== THREAT.max) return `threat scenario: a v17 save loaded as ${JSON.stringify(v17 && { known: v17.known, threat: v17.threat, freedAt: v17.freedAt })}`;
  const weird = parseProfile(JSON.parse(JSON.stringify({ ...newProfile(), known: ["nope", "stock", "stock"], threat: 99 })));
  if (!weird || weird.threat !== THREAT.max || weird.known.filter((k) => k === "stock").length !== 1 || weird.known.includes("nope" as ModKind)) return "threat scenario: a v17 save with bad fields was not cleaned";
  return null;
}
/**
 * The front (docs/ringfall/island-v2.md): the six nodes and their seven links form one connected
 * graph from the camp, and each link is walkable from core to core; every core stands on open
 * ground the walkers reach. Only a node next to the player's ground can be captured; a capture
 * fills while the player holds the core's ground with no robot on it, takes the node (its depot
 * on, its garrison gone), and keeps robots off it; the objective's steps follow it step by step.
 * Overnight a captured node is the player's however the raid ended, and each node pays its income.
 */
function checkFront(): string | null {
  // The graph: every node reached from the camp, every link walkable on the ground.
  const camp = { x: CAMP.wake.x, z: CAMP.wake.z };
  const seen = new Set<string>(["camp"]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [a, b] of FRONT_LINKS)
      for (const [x, y] of [[a, b], [b, a]])
        if (seen.has(x) && !seen.has(y)) {
          seen.add(y);
          grew = true;
        }
  }
  const lost = NODES.filter((n) => !seen.has(n.id));
  if (lost.length) return `front: ${lost.map((n) => n.id).join()} not linked to the camp`;
  if (NODES.length !== POIS.length - 1 || NODES.some((n) => (n.id as string) === "pad") || FRONT_LINKS.length !== 15 || NODES.length !== 11 || NODES.some((n) => TIER[n.id] === undefined)) return "front: the nodes are not the eleven freeable POIs on fifteen links";
  for (const n of NODES) {
    const c = n.core;
    // The core's own cell is closed to the walkers' grid; the ground round it is the main ground.
    if (Math.abs(groundAt(c.x + 1.4, c.z, PLAYER.radius, c.y + 1) - c.y) > 0.4 || [[3, 0], [-3, 0], [0, 3], [0, -3]].filter(([dx, dz]) => onMainGround(c.x + dx, c.z + dz)).length < 3 || solidAt(c.x + 1.4, c.y + 1, c.z)) return `front: ${n.id}'s core at ${c.x},${c.z} has no open ground beside it`;
    if (!solidAt(c.x, c.y + 2, c.z)) return `front: ${n.id}'s core is not a pillar`;
    if (regionHere(c).id !== n.region) return `front: ${n.id}'s core stands in the other region`;
  }
  for (const [a, b] of FRONT_LINKS) {
    const to = NODES[nodeIndex(b)].core;
    const from = a === "camp" ? camp : NODES[nodeIndex(a)].core;
    const f = fieldTo(to.x + 3, to.z);
    const d = f ? routeLength(f, from.x + (a === "camp" ? 0 : 3), from.z) : Infinity;
    if (!Number.isFinite(d)) return `front: no walk from ${a} to ${b}`;
    if (d > 3.5 * dist2d(from, to) + 150) return `front: the walk from ${a} to ${b} is ${Math.round(d)} m, far round for ${Math.round(dist2d(from, to))} m apart`;
  }
  // The front of a new island: the supply depot only; freeing it opens its neighbours.
  const fresh = newProfile(4);
  const holdsOf = (q: Profile) => islandHolds(q);
  const frontIds = (h: NodeHold[]) => NODES.filter((_, i) => frontNodes(h)[i]).map((n) => n.id).join();
  if (frontIds(holdsOf(fresh)) !== "supply") return `front: a new island's front is ${frontIds(holdsOf(fresh))}`;
  if (fresh.v !== 22) return `front: a new profile is v${fresh.v}`;
  // A capture in a raid, step by step.
  const SUP = nodeIndex("supply");
  const s = newRun(31);
  s.reinforceT = s.raiderT = 1e9;
  s.parties = [];
  s.crewsDue = [];
  const ob = () => {
    const o = objectiveSteps(s);
    return { kind: currentStep(o)?.kind ?? "done", o };
  };
  if (ob().kind !== "go" || ob().o.steps.length !== 4 || ob().o.steps[0].at?.x !== NODES[SUP].core.x) return `front: a raid's first objective is ${JSON.stringify(ob().o)}`;
  // Not on the front: the relay tower's core refuses the use key.
  const RL = nodeIndex("relay");
  const core = NODES[SUP].core;
  const stand = (n: number) => (s.player.pos = { x: NODES[n].core.x + 1.4, y: NODES[n].core.y, z: NODES[n].core.z });
  const press = idleInput();
  press.interact = true;
  s.enemies = s.enemies.filter((e) => dist2d(e.pos, NODES[RL].core) > 60 && dist2d(e.pos, core) > 60);
  stand(RL);
  step(s, press, false);
  if (s.capture || !s.events.some((e) => e.t === "coreShielded")) return "front: a core off the front could be captured";
  stand(SUP);
  ticks(s, 0.2);
  if (ob().kind !== "start") return `front: by the supply depot's core the step is ${ob().kind}`;
  step(s, press, false);
  if (s.capture?.node !== SUP || !s.events.some((e) => e.t === "coreStart") || ob().kind !== "hold") return `front: the use key at the supply depot's core started ${JSON.stringify(s.capture)}, step ${ob().kind}`;
  // The supply depot's garrison makes for the core.
  const garrisonLeft = s.enemies.filter((e) => e.poi === SUPPLY);
  if (garrisonLeft.length && !garrisonLeft.every((e) => e.aware !== "idle")) return "front: the alarm did not send the garrison to the core";
  // A robot on the core's ground stops the meter.
  s.enemies = s.enemies.filter((e) => dist2d(e.pos, core) > 80);
  const g = spawnEnemy(s, "grunt", core.x - 5, core.z, -1, 0);
  g.mode = "stunned";
  g.timer = 99;
  holdSpot(s, 2);
  if (!s.capture || s.capture.t > 0.05 || s.capture.held) return `front: the meter ran with a robot on the core's ground (${s.capture?.t})`;
  s.enemies = s.enemies.filter((e) => e !== g);
  // Held: nothing else may come near meanwhile (the push is kept off for this scenario).
  s.capture.waves = FRONT.pushWaves[s.strength];
  s.enemies = [];
  for (let i = 0; i < (FRONT.capture + 1) / TICK && s.nodes[SUP] !== "freed"; i++) {
    step(s, idleInput(), false);
    stand(SUP);
  }
  if (s.nodes[SUP] !== "freed" || s.stats.captured.join() !== "supply" || !s.depots[depotIndex("supply")] || !s.cleared[SUPPLY] || ob().kind !== "extract") return `front: holding the core left ${JSON.stringify({ node: s.nodes[SUP], captured: s.stats.captured, step: ob().kind })}`;
  if (!frontNodes(s.nodes)[nodeIndex("quarry")] || frontNodes(s.nodes)[SUP]) return "front: taking the supply depot did not move the front";
  // No robot walks onto it: one sent at the core stops at the zone's edge.
  const w = spawnEnemy(s, "grunt", core.x, core.z + FRONT.zone + 6, -1, 0);
  w.aware = "alert";
  w.goal = { x: core.x, z: core.z };
  w.searchT = 60;
  ticks(s, 6);
  if (s.enemies.includes(w) && dist2d(w.pos, core) < FRONT.zone - 1) return `front: a robot walked onto a node the player took (${dist2d(w.pos, core).toFixed(1)} m from its core)`;
  s.outcome = "extracted";
  if (ob().kind !== "done") return "front: getting off did not finish the objective";
  // Overnight: the node is the player's whether the raid got off or was wiped; each node pays its income.
  const alive = settle(fresh, s);
  if (alive.freed.join() !== "supply" || alive.front.gained.join() !== "supply" || alive.income !== FRONT.income || alive.profile.cash !== fresh.cash + FRONT.income) return `front: the night after the capture ${JSON.stringify({ freed: alive.freed, front: alive.front, income: alive.income })}`;
  s.outcome = "dead";
  const dead = settle(fresh, s);
  if (dead.freed.join() !== "supply" || dead.profile.poiState.supply.state !== "freed" || dead.income !== FRONT.income) return `front: a wiped capture left ${dead.profile.poiState.supply.state}`;
  const three: Profile = { ...fresh, poiState: { ...fresh.poiState, ...Object.fromEntries((["supply", "quarry", "relay"] as const).map((id) => [id, { state: "freed" as const }])) } };
  if (frontIncome(three) !== 3 * FRONT.income) return `front: the income of three nodes is ${frontIncome(three)}`;
  if (frontIds(holdsOf(three)) !== "smelter,station,waterworks,lodge".split(",").sort((a, b) => nodeIndex(a) - nodeIndex(b)).join()) return `front: with the reservoir's three nodes the front is ${frontIds(holdsOf(three))}`;
  // An outpost is no node: its guards stand and it takes no core.
  const r = newRun(9, freeKit(), "reservoir", { island: holds(three) });
  for (const o of OUTPOST_SITES) if (nodeIndex(o.id) >= 0 || (ROAMERS.some((sq) => sq.name === o.guard) && !r.squads.some((q) => q.name === o.guard))) return `front: the outpost ${o.id} is a node or stands no guards`;
  // The board offers to take a POI on the front only.
  for (let seed = 1; seed < 40; seed++) {
    const b = makeBoard({ ...three, seed, entries: ENTRIES.map((e) => e.id) });
    const front = frontNodes(islandHolds(three));
    for (const c of b.contracts) if (c.t === "free" && !front[nodeIndex(c.poi)]) return `front: the board offers to take ${c.poi}, off the front`;
  }
  // The push: a capture with neighbours the robots hold brings their squads in.
  const ps = newRun(44);
  ps.reinforceT = ps.raiderT = 1e9;
  ps.player.pos = { x: core.x + 1.4, y: core.y, z: core.z };
  ps.enemies = ps.enemies.filter((e) => dist2d(e.pos, core) > 150);
  useCore(ps, SUP);
  for (let i = 0; i < (FRONT.pushAt + 2) / TICK; i++) {
    step(ps, idleInput(), false);
    ps.player.pos = { x: core.x + 1.4, y: core.y, z: core.z };
  }
  const pushed = ps.squads.filter((q) => q.name.endsWith("からの増援"));
  if (!pushed.length || pushed.length > FRONT.pushMax[ps.strength] || !pushed.every((q) => q.routed)) return `front: the push sent ${pushed.map((q) => q.name).join()}`;
  return null;
}

/**
 * The push and pull (docs/ringfall/island-v2.md, 押し合い): the nodes built on the open ground are
 * walked to from the camp; a node the player takes in the battle draws the enemy's counter-attack,
 * landed and bound for it, which takes it back when nobody holds it; and the night's attacks are
 * a function of the seed, the day and the island alone, falling more on bare nodes than guarded ones.
 */
function checkPushPull(): string | null {
  const NEW: NodeId[] = ["station", "waterworks", "lodge", "cannery", "coldstore"];
  // Every new node's ground, from the camp's gate on foot.
  const camp = { x: CAMP.wake.x, z: CAMP.wake.z };
  for (const id of NEW) {
    const n = NODES[nodeIndex(id)];
    if (!n || TIER[id] < 1 || TIER[id] > 2) return `push-pull: ${id} is no node of tier 1 or 2`;
    const f = fieldTo(n.core.x + 3, n.core.z);
    if (!f || !Number.isFinite(routeLength(f, camp.x, camp.z))) return `push-pull: no walk from the camp to ${id}`;
    const p = POIS[poiIndex(id)];
    if (p.squads.length !== 2 || !p.bins.some((b) => b.vault) || depotIndex(id) < 0) return `push-pull: ${id} has ${p.squads.length} squads, a vault ${p.bins.some((b) => b.vault)}, a depot ${depotIndex(id) >= 0}`;
  }
  // The graph has a loop in each region: two ways from the supply depot to the quarry, and from the yard to the wreck.
  const ways = (a: NodeId, b: NodeId) => FRONT_LINKS.filter(([x, y]) => x === a || y === a).map(([x, y]) => (x === a ? y : x)).filter((k) => k !== b && FRONT_LINKS.some(([x, y]) => (x === k && y === b) || (y === k && x === b))).length;
  if (ways("supply", "quarry") < 1 || ways("yard", "wreck") < 1 || ways("smelter", "wreck") < 1) return "push-pull: the front has no loops";
  // A capture in the battle draws a counter-attack, landed and bound for the node.
  const p = newProfile(8);
  const SUP = nodeIndex("supply");
  const r = newRun(21, freeKit(), "reservoir", { island: holds(p), battle: { factory: 0 } });
  r.reinforceT = r.raiderT = 1e9;
  r.parties = [];
  r.crewsDue = [];
  r.enemies = r.enemies.filter((e) => dist2d(e.pos, NODES[SUP].core) > 150);
  r.player.pos = { x: NODES[SUP].core.x + 1.4, y: NODES[SUP].core.y, z: NODES[SUP].core.z };
  useCore(r, SUP);
  r.capture!.waves = FRONT.pushWaves[r.strength];
  r.capture!.t = FRONT.capture;
  ticks(r, 0.1);
  if (r.nodes[SUP] !== "freed") return "push-pull: the supply depot was not taken";
  if (!r.battle!.counters.some((c) => c.node === SUP)) return "push-pull: taking the supply depot set no counter-attack";
  // The player walks off far away (to the camp's beach), so the counter-attack comes in numbers.
  r.player.pos = { x: 20, y: terrainHeight(20, 600), z: 600 };
  r.ally.pos = { ...r.player.pos };
  let landed = false;
  for (let k = 0; k < (COUNTER.delay + 4) / TICK && !landed; k++) {
    step(r, idleInput(), false);
    landed = r.events.some((e) => e.t === "counter" && e.node === SUP);
  }
  const q = r.battle!.squads.find((x) => x.counter);
  if (!landed || !q || (q.via.length ? q.via[q.via.length - 1] : q.to) !== SUP) return `push-pull: no counter-attack landed for the supply depot (${JSON.stringify(q && { to: q.to, via: q.via })})`;
  // Left bare, the node falls back; `finishBattle()` carries it on after the player leaves. Only
  // the counter-attack is out, and nothing more is made, so it alone decides the node.
  r.battle!.squads = r.battle!.squads.filter((x) => x.counter);
  r.battle!.made = [-1e9, -1e9, -1e9];
  r.battle!.end = r.battle!.now + CONQUEST.time;
  r.outcome = "extracted";
  r.phase = "done";
  finishBattle(r);
  const back = r.battle!.taken.find((t) => t.node === "supply" && t.side === 1);
  if (!back || r.nodes[SUP] === "freed") return "push-pull: the counter-attack on a bare supply depot did not take it back";
  const day = raidDay(r);
  if (!day.battle?.turns || day.battle.turns.after < 1 || day.battle.left?.join() !== "supply" || day.battle.held.includes("supply")) return `push-pull: the battle day reads ${JSON.stringify(day.battle)}`;
  // The night: the same seed and day fall the same; bare nodes fall more often than guarded ones.
  const mine: NodeId[] = ["supply", "quarry", "relay", "station"];
  const a = nightRaids(mine, [], 0, 77, 5).join();
  if (a !== nightRaids(mine, [], 0, 77, 5).join()) return "push-pull: the same night fell differently";
  let bare = 0;
  let guarded = 0;
  let deep = 0;
  for (let d = 1; d <= 400; d++) {
    bare += nightRaids(["quarry"], [], 0, 9, d).length;
    guarded += nightRaids(["quarry"], ["quarry"], 0, 9, d).length;
    deep += nightRaids(["supply", "quarry", "relay", "station", "waterworks"], [], 0, 9, d).filter((id) => id === "supply").length;
  }
  if (!bare || guarded >= bare || deep) return `push-pull: over 400 nights a bare quarry fell ${bare} times, a guarded one ${guarded}, a supply depot with no enemy beside it ${deep}`;
  const prof = { ...p, poiState: { ...p.poiState, quarry: { state: "freed" as const } } };
  const quiet: RaidDay = { alive: true, cleared: [], captured: [], visited: [], titan: false, battle: { held: ["quarry"], start: ["quarry"], left: ["quarry"], guarded: [], factory: 0, seed: 5 } };
  const x = advanceDay(prof, quiet);
  const y = advanceDay(prof, quiet);
  if (JSON.stringify(x) !== JSON.stringify(y)) return "push-pull: the same day advanced twice came out differently";
  return null;
}


/**
 * The day's battle (sim/battle.ts): the player's own robots take a node whose garrison is gone
 * and never hit the player; the rogues' fight but take nothing; a squad goes into the world near
 * the player and back to numbers away from them with every member's health as it was; the enemy
 * makes squads; whoever holds each node as the battle ends holds it overnight; a raid without
 * one has none; and the same battle plays the same twice.
 */
function checkBattle(): string | null {
  if (newRun(5).battle) return "battle: a raid of the sim gate's tables has a battle";
  const p = newProfile(8);
  const SUP = nodeIndex("supply");
  const isl = { ...holds(p), supply: "freed" as const };
  const mk = (seed = 21, factory = 0) => {
    const r = newRun(seed, freeKit(), "reservoir", { island: isl, battle: { factory } });
    r.reinforceT = r.raiderT = 1e9;
    r.parties = [];
    r.crewsDue = [];
    return r;
  };
  // The battle's clock runs with the raid's.
  const s = mk();
  ticks(s, 10);
  if (Math.round(s.battle!.now) !== 10) return `battle: after 10 s the battle's clock reads ${s.battle!.now}`;
  // Far from the player, the player's squad at a node whose garrison is gone takes it; one at a node with its garrison does not.
  const far = NODES.map((n, i) => ({ i, d: dist2d(n.core, s.player.pos) })).filter(({ i }) => s.nodes[i] !== "freed" && NODES[i].region === "reservoir").sort((x, y) => y.d - x.d)[0].i;
  const sendSquad = (r: State, side: 0 | 1 | 2, to: number, units: { kind: EnemyKind; hp: number; shield: number }[], from = to, task: "attack" | "hold" = "attack") => {
    const at = nodePoint(to);
    const q = { id: r.battle!.nextId++, side, units, from, to, d: 1e9, task, squad: -1, x: at.x, z: at.z, via: [] as number[], ashore: 0 };
    r.battle!.squads.push(q);
    return q;
  };
  const grunt = () => ({ kind: "grunt" as EnemyKind, hp: KINDS.grunt.hp, shield: KINDS.grunt.shield });
  const free = mk();
  free.enemies = free.enemies.filter((e) => !garrisonOf(free, far, e.squad));
  sendSquad(free, 0, far, [grunt(), grunt()]);
  ticks(free, CONQUEST.capture + 3);
  if (free.nodes[far] !== "freed" || !free.battle!.taken.some((t) => t.node === NODES[far].id && t.side === 0)) return `battle: the player's squad at ${NODES[far].id} with its garrison gone left it ${free.nodes[far]}`;
  const held = mk();
  if (!held.enemies.some((e) => garrisonOf(held, far, e.squad))) return `battle: ${NODES[far].id} stands no garrison`;
  sendSquad(held, 0, far, [{ kind: "grunt", hp: 1, shield: 0 }]);
  ticks(held, CONQUEST.capture + 3);
  if (held.nodes[far] === "freed") return `battle: a squad took ${NODES[far].id} with its garrison standing`;
  // A rogue squad at a node whose garrison is gone fights there but takes nothing.
  const rog = mk();
  rog.enemies = rog.enemies.filter((e) => !garrisonOf(rog, far, e.squad));
  sendSquad(rog, 2, far, [grunt(), grunt()]);
  ticks(rog, CONQUEST.capture + 3);
  if (rog.nodes[far] !== "held" || rog.battle!.taken.some((t) => t.side === 2)) return `battle: a rogue squad took ${NODES[far].id}`;
  // Nor does the player's squad take a node while a rogue squad stands there with it.
  const shared = mk();
  shared.enemies = shared.enemies.filter((e) => !garrisonOf(shared, far, e.squad));
  const tough = () => ({ kind: "heavy" as EnemyKind, hp: 1e6, shield: 0 });
  sendSquad(shared, 0, far, [tough()]);
  sendSquad(shared, 2, far, [tough()]);
  ticks(shared, CONQUEST.capture + 3);
  if (shared.nodes[far] === "freed") return `battle: the player's squad took ${NODES[far].id} with a rogue squad standing there`;
  // Plates far from the player: a squad whose guns the plates turn still wears the garrison down to nothing.
  const plated = mk();
  plated.battle!.rarity = 0;
  for (const e of plated.enemies) if (garrisonOf(plated, far, e.squad)) e.plate = 3;
  sendSquad(plated, 0, far, [tough(), tough(), tough()]);
  ticks(plated, 900);
  if (plated.enemies.some((e) => garrisonOf(plated, far, e.squad))) return `battle: under-tier squads far from the player never brought down ${NODES[far].id}'s plated garrison`;
  // And the rogues' fire is the rogues' rarity, whatever the trader sells the player.
  const rogueHit = (rarity: Rarity) => {
    const r = mk();
    r.battle!.rarity = rarity;
    for (const e of r.enemies) if (garrisonOf(r, far, e.squad)) e.plate = 3;
    sendSquad(r, 2, far, [tough()]);
    ticks(r, 3);
    return r.enemies.filter((e) => garrisonOf(r, far, e.squad)).reduce((n, e) => n + e.hp + e.shield, 0);
  };
  if (rogueHit(0) !== rogueHit(3)) return "battle: a rogue squad's fire on plates went with the player's trader";
  // In the world and back: every member's health as it was.
  const lod = mk();
  lod.ally.active = false;
  const start = { ...lod.player.pos };
  const units = [{ kind: "grunt" as EnemyKind, hp: 77, shield: 12 }, { kind: "heavy" as EnemyKind, hp: 150, shield: 0 }];
  const q = sendSquad(lod, 0, far, units.map((u) => ({ ...u })), far, "hold");
  lod.enemies = lod.enemies.filter((e) => dist2d(e.pos, NODES[far].core) > 200);
  lod.player.pos = { x: q.x + 30, y: groundAt(q.x + 30, q.z, PLAYER.radius, 99), z: q.z };
  ticks(lod, 2);
  const inWorld = lod.friends.filter((e) => e.battle === q.id);
  if (q.squad < 0 || inWorld.length !== 2 || inWorld.some((e, k) => e.kind !== units[k].kind || e.hp !== units[k].hp || e.shield !== units[k].shield || !e.friend)) return `battle: the player's squad near the player is ${JSON.stringify(inWorld.map((e) => [e.kind, e.hp, e.shield]))}`;
  lod.player.pos = { ...start };
  ticks(lod, 2);
  if (q.squad >= 0 || lod.friends.length || JSON.stringify(q.units) !== JSON.stringify(units)) return `battle: back to numbers the squad is ${JSON.stringify(q.units)} (squad ${q.squad})`;
  // The network's squads too, among the robots.
  const net = sendSquad(lod, 1, far, units.map((u) => ({ ...u })), far, "hold");
  lod.player.pos = { x: net.x + 30, y: groundAt(net.x + 30, net.z, PLAYER.radius, 99), z: net.z };
  ticks(lod, 2);
  const theirs = lod.enemies.filter((e) => e.battle === net.id);
  if (net.squad < 0 || theirs.length !== 2 || theirs.some((e) => e.friend || e.rogue)) return "battle: the network's squad near the player is not among the robots";
  lod.player.pos = { ...start };
  ticks(lod, 2);
  if (net.squad >= 0 || lod.enemies.some((e) => e.battle === net.id)) return "battle: the network's squad stayed in the world away from the player";
  // A squad in the world come to its side's node holds it, and so no longer counts against the factory's limit.
  const live = mk();
  live.ally.active = false;
  const come = sendSquad(live, 0, SUP, [grunt()], SUP, "attack");
  live.player.pos = { x: come.x + 20, y: groundAt(come.x + 20, come.z, PLAYER.radius, 99), z: come.z };
  ticks(live, 2);
  if (come.squad < 0 || come.task !== "hold") return `battle: the player's squad in the world at its own node is ${come.task} (squad ${come.squad})`;
  // A squad whose robots all fell in the world fights no more once the raid ends.
  const gone = mk();
  gone.ally.active = false;
  const lost = sendSquad(gone, 0, far, [grunt()], far, "hold");
  gone.player.pos = { x: lost.x + 30, y: groundAt(lost.x + 30, lost.z, PLAYER.radius, 99), z: lost.z };
  ticks(gone, 2);
  if (lost.squad < 0) return "battle: the squad near the player stayed numbers";
  gone.friends = gone.friends.filter((e) => e.battle !== lost.id);
  finishBattle(gone);
  if (gone.battle!.squads.some((x) => x.id === lost.id)) return "battle: a squad whose robots all fell went on fighting after the raid";
  // The player's own robots' shots pass the player and the teammate.
  const shot = mk();
  const pl = shot.player;
  const chest = { x: pl.pos.x, y: pl.pos.y + 1.1, z: pl.pos.z };
  const before = pl.hp + pl.shield;
  shot.orbs.push({ id: 999_999, pos: { x: chest.x, y: chest.y, z: chest.z - 4 }, vel: { x: 0, y: 0, z: 120 }, r: 0.2, dmg: 60, life: 5, homing: false, by: -5, friend: true });
  shot.orbs.push({ id: 999_998, pos: { x: shot.ally.pos.x, y: shot.ally.pos.y + 1.1, z: shot.ally.pos.z - 4 }, vel: { x: 0, y: 0, z: 120 }, r: 0.2, dmg: 60, life: 5, homing: false, by: -5, friend: true });
  const allyBefore = shot.ally.hp + shot.ally.shield;
  ticks(shot, 0.2);
  if (pl.hp + pl.shield !== before || shot.ally.hp + shot.ally.shield !== allyBefore) return "battle: the player's own robots' shot hurt the player or the teammate";
  // The enemy makes squads at its nodes and sends them at the player's.
  const prod = mk();
  ticks(prod, CONQUEST.net.every[prod.strength] / 4);
  if (!prod.battle!.squads.some((x) => x.side === 1 && x.task === "attack")) return "battle: the enemy made no squad";
  // Overnight, each node is as the battle ended: the supply depot the enemy took back is the enemy's, the quarry the player's squads took is the player's.
  const both = { ...p, poiState: { ...p.poiState, supply: { state: "freed" as const }, relay: { state: "freed" as const } } };
  const r = newRun(both.seed, freeKit(), "reservoir", { island: holds(both), battle: { factory: 0 } });
  r.outcome = "extracted";
  r.nodes[SUP] = "held";
  r.nodes[nodeIndex("quarry")] = "freed";
  r.battle!.done = true;
  const night = settle(both, r);
  // The battle's end is the night's start: the nodes held then are those held after it, with the night's losses back.
  const ended = [...playerNodes(night.profile), ...night.night.lost].filter((id) => !night.night.gained.includes(id)).sort((a, b) => nodeIndex(a) - nodeIndex(b));
  if (ended.join() !== "quarry,relay" || night.raid.lost.join() !== "supply" || night.raid.gained.join() !== "quarry") return `battle: the night after a battle that ended with the quarry and the relay the player's left ${JSON.stringify({ nodes: playerNodes(night.profile), raid: night.raid, night: night.night })}`;
  if (night.income !== playerNodes(night.profile).length * FRONT.income) return `battle: ${playerNodes(night.profile).length} nodes paid ${night.income}`;
  // Saves: v19 keeps the factory; before, the factory the camp starts with.
  const kept = parseProfile(JSON.parse(JSON.stringify({ ...night.profile, factory: 3 })));
  if (!kept || kept.v !== 22 || kept.factory !== 3) return `battle: a v22 save loaded as ${JSON.stringify(kept && { v: kept.v, factory: kept.factory })}`;
  const old = parseProfile(JSON.parse(JSON.stringify({ ...night.profile, v: 18, factory: 3 })));
  if (!old || old.factory !== 0) return "battle: a v18 save took a factory";
  // The factory: built from the stash and the credits, its turrets at the nodes the player holds.
  const rich = { ...p, cash: 1e6, stash: FACTORY.levels.flatMap((l) => l.items.flatMap(([k, n]) => Array.from({ length: n }, (): Item => ({ t: "valuable", kind: k })))) };
  let built: Profile | null = rich;
  for (let k = 0; k < FACTORY.levels.length; k++) built = built && buildFactory(built);
  if (!built || built.factory !== FACTORY.levels.length || built.stash.length || buildFactory(built)) return `battle: building the factory to its top left ${built?.factory}`;
  const top = mk(21, FACTORY.levels.length);
  if (top.battle!.squads.filter((x) => x.task === "post" && x.to === SUP).length !== FACTORY.turrets[FACTORY.levels.length]) return "battle: the factory's top level stood no turret at the supply depot";
  // The same battle twice: the same nodes taken.
  const play = () => {
    const r = mk(33, 2);
    r.battle!.end = 300;
    const bot = new Bot(SKILLS[2], 5);
    let pc = false;
    while (r.phase !== "done") {
      const inp = bot.input(r);
      step(r, inp, pc);
      pc = inp.crouch;
    }
    return JSON.stringify({ taken: r.battle!.taken, nodes: r.nodes, done: r.battle!.done, outcome: r.outcome, squads: r.battle!.squads.length });
  };
  const a = play();
  if (a !== play()) return "battle: the same battle played twice came out differently";
  return null;
}

for (const err of [checkFront(), checkPushPull(), checkBattle(), checkFactions(), checkIntercept(), checkSplit(), checkPatrols(), checkMods(), checkThreat(), checkEvents(), checkTerrainIndex(20_000), checkParties(), checkPacks(), checkRoutes(), checkRouteObstacles(), checkTools(), checkTimeToKill(), checkStagger(), checkWindupMoves(), checkDepots(), checkDepotBudget(), checkPlates(), checkUnlocks(), checkHideout(), checkBoltNoTunnel(), checkPickupWavesRouted(), checkLaterWaveFights(), checkSidestepHit(), checkReturnFire(), checkWallStops(), checkPinch(), checkPursuit(), checkHealHeard(), checkPositionMatters(), checkPullWhenAiming(), checkVault(), checkIsland(), checkStrength(), checkContracts(), checkQuests(), checkLoadout(), checkSettle(), checkWipeClearsAir(), checkArcOnTitan(), checkGoldReload(), checkArcIgnoresFacing(), checkDeathEndsRaid(), checkBleedoutWipe(), checkReinforce(), checkReinforceHidden(), checkSearchBreaks(), checkBagSwap(), checkBagSwapCheapest(), checkRaiders(), checkValuableBin(), checkAllyRescue(), checkAllyDownWipes(), checkHelpAlly(), checkAllyHoldsFire(), checkFlareExtract(), checkShipCall(), checkBoatCall(), checkSecondPickup(), checkEntries(), checkCamp(), checkKnownEntries(), checkConnections(), checkAllySelfUp(), checkStompHeight(), checkFieldsReused(), checkFieldsFollowRunner(), checkCliffsStop(), checkNoPits(), checkWalkableIsland(), checkReinforceEverywhere(), checkRoamersHearOnlyGunfire(), checkReinforceWaitsForTitan(), checkWeakPointBehindBody(), checkHelpBeforeLoot(), checkAllyTitanKill(), checkLeap(), checkLeapLeavesAllyBelow(), checkLeapDowned(), checkLeapAllyCatchesUp(), checkLeapAllyDowned(), checkLeapWithItem(), checkLeapClocks(), checkLeapOffHighGround(), checkLeapUnderRoof()]) {
  if (err) {
    console.error(err);
    process.exit(1);
  }
}

let failed = false;
const head = ["skill    ", "alive", "time(med)", "cleared", "haul(med)", "downs", "acc", "crit", "leap", "crowd", "flank", "waves", "meet".padEnd(18), "c/min", "ally".padEnd(18), "exit"];
console.log(`${runs} runs per skill and region. alive: share of raids that got off (the rest were wiped out)`);
console.log("time: minutes from the start to leaving; cleared: median POIs whose garrison was wiped out; haul: median over raids that got off");
console.log("flank: share of hits from behind a robot or before it noticed or located the player (the titan, hit alike from every side, not counted)");
console.log("waves: median reinforcement squads that beamed in during a raid");
console.log("meet: medians of the seconds to the first squad engaging the player and of the longest stretch with no robot fighting them; squads that engaged per run / of them belonging to no POI");
console.log("c/min: contacts per minute, squads that engaged the player over the minutes of every raid");
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
  const month = await (months ?? campaigns(DAYS, 1));
  for (const l of campaignLines(month)) console.log(l);
  for (const e of month.flatMap((c) => c.errors)) {
    failed = true;
    console.error(e);
  }
}
if (failed) {
  console.error("FAILED");
  process.exit(1);
}
