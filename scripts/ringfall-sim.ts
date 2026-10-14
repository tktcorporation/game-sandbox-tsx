/**
 * Gate 2 for RINGFALL: bots of three skills play the whole run headless, dropping into
 * each region in turn. Fails if any run does not finish, or if an invariant breaks (NaN,
 * a body inside a box, an enemy outside the world). Prints the tables kept in
 * docs/ringfall/balance.md, one per region.
 *
 *   npm run sim:ringfall -- [runsPerSkillAndRegion] [region]
 *
 * With a region id after the count, only that region's table is played.
 */
import { ALLY, BAG, ENEMIES, NOISE, PLAYER, RAIDERS, REINFORCE, SEARCH, TACTICAL, TICK, VALUABLES, WORLD } from "../src/ringfall/sim/config";
import { engageSquad, makeNoise } from "../src/ringfall/sim/awareness";
import { spawnEnemy } from "../src/ringfall/sim/enemies";
import { COVERS } from "../src/ringfall/sim/cover";
import { ENEMIES as KINDS, type EnemyKind } from "../src/ringfall/sim/config";
import { BOXES, DECKS, EXTRA_BINS, EXTRACTS, POIS, poiIndex, REGIONS, regionHere, regionOf, ROAMERS, SPAWN, type RegionId, type Squad } from "../src/ringfall/sim/map";
import { findPath } from "../src/ringfall/sim/nav";
import { fieldTo, fieldsBuilt, routeLength } from "../src/ringfall/sim/hunt";
import { dist2d, groundAt, inWorld, los, solidAt } from "../src/ringfall/sim/geom";
import { floorLevel, highGround, landAt, LEVEL, offLowGround, offshore, terrainHeight } from "../src/ringfall/sim/terrain";
import { Bot, SKILLS } from "../src/ringfall/sim/bot";
import { callLeft, freeKit, idleInput, newRun, type GameEvent, type State } from "../src/ringfall/sim/state";
import { step } from "../src/ringfall/sim/step";
import { hurtPlayer } from "../src/ringfall/sim/player";
import { hurtAlly, placeAlly } from "../src/ringfall/sim/ally";
import { haulValue, rank } from "../src/ringfall/sim/results";
import { SHIP_SQUAD, bagUsed, makeRoom } from "../src/ringfall/sim/world";
import { bodyCenter, damageEnemy, eyePos, fireRay, magSize, weakPoint } from "../src/ringfall/sim/combat";
import { lookAngles } from "../src/ringfall/sim/geom";
import { forward } from "../src/ringfall/sim/state";
import { buy, deliver, newProfile, parseProfile, pouch, price, sell, settle, takeKit, wares } from "../src/ringfall/meta/profile";
import { QUESTS, offered } from "../src/ringfall/meta/quests";
import { META } from "../src/ringfall/sim/config";

const runs = Number(process.argv[2] ?? 12);
const only = process.argv[3];
/** The POIs' places in `POIS`, for scenarios that set up a run's state by hand. */
const SUPPLY = poiIndex("supply");
const QUARRY = poiIndex("quarry");
const RELAY = poiIndex("relay");
const PAD = poiIndex("pad");
const LIMIT = 30 * 60; // seconds of game time before a run counts as stuck

function check(s: State, where: string) {
  const p = s.player.pos;
  if (![p.x, p.y, p.z, s.player.hp, s.player.shield].every(Number.isFinite)) throw new Error(`${where}: player NaN`);
  for (const b of BOXES) {
    const body = p.y + 0.9;
    const inside = p.x > b.x0 + 0.05 && p.x < b.x1 - 0.05 && p.z > b.z0 + 0.05 && p.z < b.z1 - 0.05 && body > b.y0 && body < b.h;
    if (inside) throw new Error(`${where}: player inside a ${b.kind} at ${p.x.toFixed(1)},${p.z.toFixed(1)}`);
  }
  for (const e of s.enemies) {
    if (![e.pos.x, e.pos.y, e.pos.z, e.hp].every(Number.isFinite)) throw new Error(`${where}: enemy NaN`);
    if (!inWorld(e.pos.x, e.pos.z, -1)) throw new Error(`${where}: enemy off the island`);
  }
}

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
  for (const r of REGIONS) point(`${r.id} landing`, r.land.x, r.land.z);
  ROAMERS.forEach((sq) => squad(`roamer ${sq.name}`, sq));
  // An extract is used standing on whatever is highest there (the pad, a rock top), as the game checks it.
  for (const x of EXTRACTS) point(`extract ${x.id}`, x.x, x.z, groundAt(x.x, x.z, 0.4, 99));
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
  s.phase = "play";
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
    fieldTo(0, 110);
    fieldTo(-12, 132);
  }
  const built = fieldsBuilt - before;
  return built > 2 ? `field cache scenario: ${built} fields built for 2 targets` : null;
}
/** A target running across the lakebed costs a field every few metres, not one per 2 m cell it enters. */
function checkFieldsFollowRunner(): string | null {
  const before = fieldsBuilt;
  for (let t = 0; t <= 40 * 60; t++) fieldTo(-20 + t * (40 / (40 * 60)), -15);
  const built = fieldsBuilt - before;
  return built > 8 ? `field cache scenario: ${built} fields built for a target running 40 m` : null;
}
/** Places on the island a player waits in: the POI entries and the districts between them. */
const WAIT_SPOTS: [string, number, number][] = [
  ...POIS.map((p): [string, number, number] => [p.name, p.entry.x, p.entry.z]),
  ["工場", 50, 50],
  ["台地", -60, -40],
  ["廃村", -100, -62],
  ["放水路", 50, -80],
  ["住宅地", 112, 20],
  ["採掘場の奥", -100, 12],
  ["尾根", -50, 76],
  ["峠", -60, -222],
  ["駅", 122, -230],
  ["港町", 20, -306],
  ["高架下", 60, -344],
  ["塩田", 10, -500],
  ["岬", -122, -545],
];

/** Walking into the lakebed's walls for 10 s gets the player nowhere: a cliff is climbed by no one. */
function checkCliffsStop(): string | null {
  for (const [x, z, yaw] of [[-20, -20, -Math.PI / 2], [20, -30, Math.PI / 2], [0, -60, 0], [-10, 30, Math.PI * 0.75]]) {
    const s = newRun(1);
    s.phase = "play";
    s.enemies = [];
    s.reinforceT = s.raiderT = 1e9;
    const p = s.player;
    p.pos = { x, y: groundAt(x, z, 0.4, 0), z };
    p.onGround = true;
    p.yaw = yaw;
    for (let t = 0; t < 600; t++) step(s, { ...idleInput(), moveZ: 1, sprint: true }, false);
    if (p.pos.y > LEVEL.lakebed + 1.5) return `cliff scenario: walking from ${x},${z} climbed to ${p.pos.y.toFixed(1)} m at ${p.pos.x.toFixed(0)},${p.pos.z.toFixed(0)}`;
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
/** Every POI, way off and patrol route can be walked to from the landing, robots' way: no climbing, no drops. */
function checkWalkableIsland(): string | null {
  const f = fieldTo(SPAWN.x, SPAWN.z);
  if (!f) return "walk scenario: the landing is not on open ground";
  const places: [string, number, number][] = [
    ...WAIT_SPOTS,
    ...EXTRACTS.map((x): [string, number, number] => [x.id, x.x, x.z]),
    ...ROAMERS.flatMap((sq) => (sq.patrol ?? []).map((w): [string, number, number] => [sq.name, w.x, w.z])),
  ];
  const cut = places.filter(([, x, z]) => !Number.isFinite(routeLength(f, x, z)));
  return cut.length ? `walk scenario: no way on foot to ${cut.map(([n, x, z]) => `${n} (${x},${z})`).join(", ")}` : null;
}

/**
 * Wherever the player waits, reinforcements find a hidden spot a walk away, and every one of
 * their walkers reaches the fight: within 30 m, in sight, or behind cover it took to fight from,
 * even after a drone found the player first.
 */
function checkReinforceEverywhere(): string | null {
  for (const [name, x, z] of WAIT_SPOTS)
    for (let seed = 1; seed <= 3; seed++) {
      const s = newRun(seed);
      s.phase = "play";
      s.raiderT = 1e9;
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
      const out = s.enemies.filter((e) => walkers.includes(e) && !(e.aware === "engaged" && e.cover) && Math.hypot(e.pos.x - p.pos.x, e.pos.z - p.pos.z) > 30 && !los(eye, bodyCenter(e)));
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
  const out = makeRoom(["parts", "board", "core", "core"], "core");
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
  ticks(s, ship.call! - 1);
  const waves = s.enemies.filter((e) => s.squads[e.squad]?.name === SHIP_SQUAD).length;
  if (callLeft(s, "ship") <= 0 || s.phase === "done" || waves < 2) return `ship scenario: ${callLeft(s, "ship").toFixed(1)} s left, phase ${s.phase}, ${waves} robots beamed in`;
  ticks(s, 1 + ship.hold + 0.2);
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
  const boat = EXTRACTS.find((x) => x.id === "boat")!;
  const p = s.player;
  p.pos = { x: boat.x, y: groundAt(boat.x, boat.z, 0.4, 20), z: boat.z };
  p.iframes = 999;
  ticks(s, boat.call! - 1);
  const waves = s.enemies.filter((e) => s.squads[e.squad]?.name === SHIP_SQUAD);
  if (callLeft(s, "boat") <= 0 || callLeft(s, "ship") >= 0 || s.phase === "done" || waves.length < 2) return `boat scenario: ${callLeft(s, "boat").toFixed(1)} s left, ship ${callLeft(s, "ship")}, phase ${s.phase}, ${waves.length} robots beamed in`;
  const stranded = waves.filter((e) => ENEMIES[e.kind].fly === 0 && (highGround(e.pos.x, e.pos.z) || Math.hypot(e.pos.x - boat.x, e.pos.z - boat.z) > 40));
  if (stranded.length) return `boat scenario: robots beamed in off the quay at ${stranded.map((e) => `${e.pos.x.toFixed(0)},${e.pos.z.toFixed(0)}`).join(" ")}`;
  ticks(s, 1 + boat.hold + 0.2);
  if (phaseOf(s) !== "done" || s.extractedAt !== "boat") return `boat scenario: did not leave by boat (${callLeft(s, "boat").toFixed(1)}, ${s.phase})`;
  return null;
}
/**
 * Two pickups called in one raid each get their own waves: robots left at the quay from the
 * boat's call do not use up the dropship's.
 */
function checkSecondPickup(): string | null {
  const s = padRun();
  const boat = EXTRACTS.find((x) => x.id === "boat")!;
  const ship = EXTRACTS.find((x) => x.id === "ship")!;
  const p = s.player;
  p.iframes = 999;
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
 * The landing choice: a raid starts over the region it was given (the reservoir when none
 * is), and a fall with no input comes down in that region, with the teammate.
 */
function checkRegionDrop(): string | null {
  if (newRun(3).region !== "reservoir") return "region scenario: a raid with no region given did not drop into the reservoir";
  for (const r of REGIONS) {
    const s = newRun(3, freeKit(), r.id);
    const p = s.player;
    if (s.region !== r.id || Math.hypot(p.pos.x - r.drop.x, p.pos.z - r.drop.z) > 1 || Math.hypot(s.ally.pos.x - r.drop.x, s.ally.pos.z - r.drop.z) > 1) return `region scenario: a ${r.id} raid starts at ${p.pos.x.toFixed(0)},${p.pos.z.toFixed(0)}`;
    for (let t = 0; t < 20 * 60 && s.phase === "drop"; t++) step(s, idleInput(), false);
    if (s.phase !== "play" || regionHere(p.pos).id !== r.id) return `region scenario: a ${r.id} raid landed at ${p.pos.x.toFixed(0)},${p.pos.z.toFixed(0)} (${regionHere(p.pos).id})`;
  }
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
  const town = regionOf("harbor").land;
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
/** A jumper over the high ground, even one steering deeper in, lands on walkable ground. */
function checkDropOffHighGround(): string | null {
  for (const [x, z] of [[40, 22], [-40, 40], [70, 10], [-80, -30], [30, 140], [-150, 0], [150, 60], [0, -420], [60, -240], [-55, -440]]) {
    if (!highGround(x, z)) return `drop scenario: ${x},${z} is not high ground`;
    const s = newRun(5);
    const p = s.player;
    p.pos = { x, y: 140, z };
    const land = landAt(x, z);
    p.yaw = Math.atan2(x - land.x, -(z - land.z)); // facing away from the land's middle, deeper into the high ground
    const input = { ...idleInput(), moveZ: 1 };
    for (let t = 0; t < 20 * 60 && s.phase === "drop"; t++) step(s, input, false);
    if (s.phase === "drop") return `drop scenario: from ${x},${z} still falling`;
    if (highGround(p.pos.x, p.pos.z)) return `drop scenario: from ${x},${z} landed on high ground at ${p.pos.x.toFixed(1)},${p.pos.z.toFixed(1)}`;
  }
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
  const roof = BOXES.find((b) => {
    const x = (b.x0 + b.x1) / 2;
    const z = (b.z0 + b.z1) / 2;
    const t = terrainHeight(x, z);
    return Math.hypot(x - 25, z - 99) < 15 && b.h - t > 4 && b.x1 - b.x0 > 4 && b.z1 - b.z0 > 4;
  });
  if (!roof) return "leap scenario: no warehouse roof near 25,99";
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
  for (const [x, z, yaw] of [[-20, -20, -Math.PI / 2], [20, -30, Math.PI / 2], [0, -60, 0], [-10, 30, Math.PI * 0.75]]) {
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
  const bought = buy(p, wares()[0]);
  if (!bought || bought.cash !== cash - price(wares()[0]) || bought.stash.length !== start + 1) return "trader scenario: buying did not take the price and add the item";
  if (sell(bought, bought.stash.length - 1).cash >= cash) return "trader scenario: selling paid back at least the price";
  p = { ...p, stash: Array.from({ length: META.stash }, () => ({ t: "heal" as const, kind: "cell" as const })) };
  if (buy(p, wares()[0])) return "trader scenario: bought into a full stash";
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
  // One slot left: a quest's key reward takes it ahead of a fuse from the same raid.
  const tight = { ...newProfile(), stash: Array.from({ length: META.stash - 1 }, () => ({ t: "heal" as const, kind: "cell" as const })), quests: { progress: {}, done: ["grunts", "parts", "quarry"] } };
  const tk = takeKit(tight, { weapons: [], armor: null, heals: { cell: 0, battery: 0, syringe: 0, medkit: 0 }, keys: [] });
  const ts = newRun(10, tk.kit);
  ts.outcome = "extracted";
  ts.player.haul = ["fuse"];
  ts.stats.cleared = [RELAY];
  const tr = settle(tk.profile, ts);
  const last = tr.profile.stash.at(-1);
  if (tr.quests[0]?.id !== "relay" || last?.t !== "key" || !tr.sold.some((i) => i.t === "valuable")) return `quest scenario: with one slot left the stash kept ${JSON.stringify(last)} and sold ${JSON.stringify(tr.sold)}`;
  const v1 = parseProfile({ v: 1, cash: 10, stash: [], raids: 2, extracted: 1 });
  if (!v1 || v1.v !== 4 || v1.quests.done.length || v1.region !== "reservoir") return "storage scenario: a v1 save does not load";
  // v2 saves named a key's POI by its place in the list; it loads as that POI's id.
  const v2 = parseProfile({ v: 2, cash: 10, stash: [{ t: "key", poi: 2 }, { t: "key", poi: 9 }], raids: 1, extracted: 1, quests: { progress: {}, done: [] } });
  const v2Key = v2?.stash[0];
  if (!v2 || v2.v !== 4 || v2.stash.length !== 1 || v2Key?.t !== "key" || v2Key.poi !== "relay") return `storage scenario: a v2 save's key 2 loaded as ${JSON.stringify(v2?.stash)}, not the relay key`;
  // A v3 save keeps its keys by id and drops into the reservoir; the landing choice is kept.
  const v3 = parseProfile({ v: 3, cash: 10, stash: [{ t: "key", poi: "wreck" }], raids: 1, extracted: 1, quests: { progress: {}, done: [] } });
  if (!v3 || v3.v !== 4 || v3.stash.length !== 1 || v3.region !== "reservoir") return `storage scenario: a v3 save loaded as ${JSON.stringify(v3)}`;
  if (parseProfile(JSON.parse(JSON.stringify({ ...newProfile(), region: "harbor" })))?.region !== "harbor") return "storage scenario: the landing choice did not survive a save";
  // The harbor quests: the yard's vault counts only that vault, the harbor haul only a raid dropped into the harbor.
  const late = { ...newProfile(), quests: { progress: {}, done: QUESTS.filter((q) => !["yardVault", "harborHaul"].includes(q.id)).map((q) => q.id) } };
  if (offered(late.quests).map((q) => q.id).join() !== "yardVault") return `quest scenario: after the harbor's first quests the trader offers ${offered(late.quests).map((q) => q.id).join()}`;
  const hv = newRun(11, freeKit(), "harbor");
  hv.outcome = "dead";
  hv.stats.vaults = [QUARRY];
  if (settle(late, hv).quests.length) return "quest scenario: the quarry's vault counted for the yard's";
  hv.stats.vaults = [poiIndex("yard")];
  const afterVault = settle(late, hv).profile;
  if (!afterVault.quests.done.includes("yardVault")) return "quest scenario: opening the yard's vault did not finish its quest";
  const haulRun = (region: RegionId) => {
    const r = newRun(12, freeKit(), region);
    r.outcome = "extracted";
    r.extractedAt = region === "harbor" ? "boat" : "ship";
    r.player.haul = ["reactor", "core", "gyro", "drive"];
    return r;
  };
  if (settle(afterVault, haulRun("reservoir")).quests.some((q) => q.id === "harborHaul")) return "quest scenario: a haul out of the reservoir counted for the harbor's";
  if (!settle(afterVault, haulRun("harbor")).quests.some((q) => q.id === "harborHaul")) return "quest scenario: a haul out of the harbor did not count";
  return null;
}

/**
 * Open level ground in the reservoir: from `left` metres to the -x side of (x, z) to `right`
 * metres to the +x side, and `dist` metres toward -z, clear of boxes, for a fight in the open.
 */
function openSpot(dist: number, left: number, right: number): { x: number; z: number } | null {
  const land = regionOf("reservoir").land;
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
  return { s, foes, squad };
}

/** A grunt's burst at 15 m in the open finds a player who sidesteps through the glow and the shots. */
function checkSidestepHit(): string | null {
  const at = openSpot(16, 2, 9);
  if (!at) return "sidestep scenario: no open ground for the test";
  const { s, foes } = standoff(at, 15, ["grunt"]);
  const g = foes[0];
  g.mode = "telegraph";
  g.timer = KINDS.grunt.telegraph;
  g.cooldown = 99;
  const strafe = idleInput();
  strafe.moveX = 1;
  let hits = 0;
  for (let i = 0; i < 1.6 / TICK; i++) {
    step(s, strafe, false);
    hits += s.events.filter((e) => e.t === "hurt").length;
    s.player.iframes = 0;
  }
  if (hits < 2) return `sidestep scenario: a player strafing in the open at 15 m took ${hits} of a grunt's 3 shots`;
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
      if (offLowGround(c.x, c.z) || offLowGround(gx, gz) || Math.abs(terrainHeight(gx, gz) - g0) > 0.8 || solidAt(gx, terrainHeight(gx, gz) + 1, gz)) continue;
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
      if (!los({ x: g.pos.x, y: g.pos.y + 1.8, z: g.pos.z }, { x: p.pos.x + nx * 3, y: p.pos.y + 1.1, z: p.pos.z + nz * 3 })) continue;
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
      for (let i = 0; i < 1.2 / TICK; i++) {
        step(s, hold, true);
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
    }
    const a = lookAngles(eye, weakPoint(g));
    fireRay(s, { kind: "talon", rarity: 0, mag: -1 }, forward(a.yaw, a.pitch));
    return s.enemies.includes(g) ? (g.hp + g.shield) / enemyMaxPlain("grunt") : 0;
  };
  const ambush = shot(false, false);
  const front = shot(true, false);
  const back = shot(true, true);
  if (ambush > 0 || back > 0 || front < 0.4) return `position scenario: a TALON weak-point shot leaves a grunt at ${Math.round(ambush * 100)}% unaware, ${Math.round(back * 100)}% from behind, ${Math.round(front * 100)}% from the front`;
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

for (const err of [checkSidestepHit(), checkWallStops(), checkPinch(), checkHealHeard(), checkPositionMatters(), checkPullWhenAiming(), checkVault(), checkQuests(), checkSettle(), checkWipeClearsAir(), checkArcOnTitan(), checkGoldReload(), checkArcIgnoresFacing(), checkDeathEndsRaid(), checkBleedoutWipe(), checkReinforce(), checkReinforceHidden(), checkSearchBreaks(), checkBagSwap(), checkBagSwapCheapest(), checkRaiders(), checkValuableBin(), checkAllyRescue(), checkAllyDownWipes(), checkHelpAlly(), checkAllyHoldsFire(), checkFlareExtract(), checkShipCall(), checkBoatCall(), checkSecondPickup(), checkRegionDrop(), checkConnections(), checkAllySelfUp(), checkStompHeight(), checkDropOffHighGround(), checkFieldsReused(), checkFieldsFollowRunner(), checkCliffsStop(), checkNoPits(), checkWalkableIsland(), checkReinforceEverywhere(), checkRoamersHearOnlyGunfire(), checkReinforceWaitsForTitan(), checkWeakPointBehindBody(), checkHelpBeforeLoot(), checkAllyTitanKill(), checkLeap(), checkLeapLeavesAllyBelow(), checkLeapDowned(), checkLeapAllyCatchesUp(), checkLeapAllyDowned(), checkLeapWithItem(), checkLeapClocks(), checkLeapOffHighGround(), checkLeapUnderRoof()]) {
  if (err) {
    console.error(err);
    process.exit(1);
  }
}

const median = (xs: number[]) => {
  const a = [...xs].sort((x, y) => x - y);
  return a.length ? a[Math.floor(a.length / 2)] : NaN;
};

let failed = false;
const head = ["skill    ", "alive", "time(med)", "cleared", "haul(med)", "score(med)", "downs", "acc", "crit", "leap", "crowd", "flank", "waves", "ally".padEnd(18), "rank".padEnd(18), "exit"];
console.log(`${runs} runs per skill and region. alive: share of raids that got off (the rest were wiped out)`);
console.log("time: minutes from landing to leaving; cleared: median POIs cleared; haul and score: medians over raids that got off");
console.log("flank: share of hits from behind a robot or before it noticed the player");
console.log("waves: median reinforcement squads that beamed in during a raid");
console.log("ally: teammate's share of the damage, its downs, times it picked the player up (r) and was picked up (h), per run");
console.log("exit: raids that left by each extraction point of the region (the bot's choice depends on skill)");
console.log("crowd: median over runs of the most squads / robots fighting the player at once outside the titan fight");
for (const region of REGIONS.filter((r) => !only || r.id === only)) {
  console.log("");
  console.log(`region: ${region.id} (${region.name})`);
  console.log(head.join(" "));
  for (const skill of SKILLS) table(region.id, skill);
}

function table(region: RegionId, skill: (typeof SKILLS)[number]) {
  const times: number[] = [];
  const clearedN: number[] = [];
  const hauls: number[] = [];
  const scores: number[] = [];
  const waves: number[] = [];
  let ended = 0;
  let alive = 0;
  let downs = 0;
  let shots = 0;
  let hits = 0;
  let crits = 0;
  let flanks = 0;
  let ults = 0;
  let allyDmg = 0;
  let allyDowns = 0;
  let rescues = 0;
  let helped = 0;
  const exits: Record<string, number> = Object.fromEntries(EXTRACTS.map((x) => [x.id, 0]));
  const crowdSq: number[] = [];
  const crowdBots: number[] = [];
  const ranks: Record<string, number> = { S: 0, A: 0, B: 0, C: 0, "-": 0 };
  for (let r = 0; r < runs; r++) {
    const s = newRun(1000 + r * 7919, freeKit(), region);
    const bot = new Bot(skill, 31 + r);
    let prevCrouch = false;
    let peakSq = 0;
    let peakBots = 0;
    let landed = 0;
    try {
      while (s.phase !== "done" && s.time < LIMIT) {
        const inp = bot.input(s);
        step(s, inp, prevCrouch);
        prevCrouch = inp.crouch;
        const end = s.events.findIndex((e) => e.t === "done");
        if (end >= 0 && end < s.events.length - 1) throw new Error(`${region} ${skill.name}#${r}: events after the raid ended: ${s.events.slice(end + 1).map((e) => e.t).join(",")}`);
        for (const e of s.events) {
          if (e.t === "leap") ults++;
          if (e.t === "landed") landed = s.time;
        }
        if (!s.enemies.some((e) => e.kind === "titan" && e.aware === "engaged")) {
          const fighting = s.enemies.filter((e) => e.aware === "engaged" && e.mode !== "spawning");
          peakBots = Math.max(peakBots, fighting.length);
          peakSq = Math.max(peakSq, new Set(fighting.map((e) => e.squad)).size);
        }
        if (Math.round(s.time / TICK) % 30 === 0) check(s, `${region} ${skill.name}#${r} t=${s.time.toFixed(1)}`);
      }
    } catch (err) {
      failed = true;
      console.error(String(err));
      continue;
    }
    if (s.phase !== "done") {
      failed = true;
      const p = s.player.pos;
      console.error(`${region} ${skill.name}#${r}: still on the island after ${LIMIT} s, cleared ${s.stats.cleared.join(",")} player ${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)} enemies near: ${s.enemies.filter((e) => Math.hypot(e.pos.x - p.x, e.pos.z - p.z) < 60).map((e) => `${e.kind}@${e.pos.x.toFixed(0)},${e.pos.z.toFixed(0)}:${e.mode}:${e.aware}`).join(" ")}`);
      continue;
    }
    ended++;
    crowdSq.push(peakSq);
    crowdBots.push(peakBots);
    clearedN.push(s.stats.cleared.length);
    waves.push(s.reinforceN);
    const rk = rank(s);
    ranks[rk.rank]++;
    if (s.outcome === "extracted") {
      alive++;
      times.push((s.time - landed) / 60);
      hauls.push(rk.haul);
      scores.push(rk.score);
    }
    downs += s.stats.downs;
    shots += s.stats.shots;
    hits += s.stats.hits;
    crits += s.stats.crits;
    flanks += s.stats.flankHits;
    allyDmg += s.stats.allyDamage / Math.max(1, s.stats.allyDamage + s.stats.damage);
    allyDowns += s.stats.allyDowns;
    rescues += s.stats.allyRescues;
    helped += s.stats.allyHelped;
    if (s.extractedAt) exits[s.extractedAt]++;
  }
  const n = Math.max(ended, 1);
  console.log(
    [
      skill.name.padEnd(9),
      `${Math.round((alive / runs) * 100)}%`.padEnd(5),
      `${median(times).toFixed(1)}m`.padEnd(9),
      String(median(clearedN)).padEnd(7),
      String(median(hauls)).padEnd(9),
      String(median(scores)).padEnd(10),
      (downs / n).toFixed(1).padEnd(5),
      `${Math.round((hits / Math.max(shots, 1)) * 100)}%`.padEnd(3),
      `${Math.round((crits / Math.max(hits, 1)) * 100)}%`.padEnd(4),
      (ults / n).toFixed(1).padEnd(3),
      `${median(crowdSq)}/${median(crowdBots)}`.padEnd(5),
      `${Math.round((flanks / Math.max(hits, 1)) * 100)}%`.padEnd(5),
      String(median(waves)).padEnd(5),
      `${Math.round((allyDmg / n) * 100)}% ${(allyDowns / n).toFixed(1)}d ${(rescues / n).toFixed(1)}r ${(helped / n).toFixed(1)}h`.padEnd(18),
      `S${ranks.S} A${ranks.A} B${ranks.B} C${ranks.C} -${ranks["-"]}`.padEnd(18),
      regionOf(region).exits.map((id) => `${id} ${exits[id]}`).join(" "),
    ].join(" "),
  );
}
if (failed) {
  console.error("FAILED");
  process.exit(1);
}
