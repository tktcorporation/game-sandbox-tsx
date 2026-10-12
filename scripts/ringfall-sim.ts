/**
 * Gate 2 for RINGFALL: bots of three skills play the whole run headless.
 * Fails if any run does not finish, or if an invariant breaks (NaN, a body inside
 * a box, an enemy outside the island). Prints the table kept in docs/ringfall/balance.md.
 *
 *   npm run sim:ringfall -- [runsPerSkill]
 */
import { ALLY, BAG, ENEMIES, RAIDERS, REINFORCE, SEARCH, TACTICAL, TICK, VALUABLES, WORLD } from "../src/ringfall/sim/config";
import { BOXES, EXTRA_BINS, EXTRACTS, POIS, ROAMERS, type Squad } from "../src/ringfall/sim/map";
import { groundAt, los, solidAt } from "../src/ringfall/sim/geom";
import { Bot, SKILLS } from "../src/ringfall/sim/bot";
import { idleInput, newRun, type GameEvent, type State } from "../src/ringfall/sim/state";
import { step } from "../src/ringfall/sim/step";
import { hurtPlayer } from "../src/ringfall/sim/player";
import { hurtAlly, placeAlly } from "../src/ringfall/sim/ally";
import { haulValue, rank } from "../src/ringfall/sim/results";
import { SHIP_SQUAD, bagUsed } from "../src/ringfall/sim/world";
import { bodyCenter, damageEnemy, eyePos, fireRay, magSize, weakPoint } from "../src/ringfall/sim/combat";
import { lookAngles } from "../src/ringfall/sim/geom";
import { forward } from "../src/ringfall/sim/state";

const runs = Number(process.argv[2] ?? 12);
const LIMIT = 20 * 60; // seconds of game time before a run counts as stuck

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
    if (Math.abs(e.pos.x) > WORLD.half + 1 || Math.abs(e.pos.z) > WORLD.half + 1) throw new Error(`${where}: enemy off the island`);
  }
}

/** Static layout check: every authored point must be standable, not inside a wall. */
function checkLayout(): string[] {
  const bad: string[] = [];
  const point = (what: string, x: number, z: number, y = 0) => {
    const g = groundAt(x, z, 0.3, y + 0.3);
    if (Math.abs(g - y) > 0.3) bad.push(`${what} at ${x},${z} expects floor ${y}, finds ${g.toFixed(2)}`);
    for (const h of [0.3, 1.0, 1.6]) if (solidAt(x, g + h, z)) bad.push(`${what} at ${x},${z} is inside a box (height ${h})`);
  };
  // Robots stand exactly where they are placed (walkers), and patrols run over open ground.
  const squad = (what: string, sq: Squad) => {
    for (const m of sq.members) if (m.kind !== "drone") point(`${what} ${m.kind}`, m.x, m.z, m.y ?? 0);
    for (const w of sq.patrol ?? []) if (sq.members.some((m) => m.kind !== "drone")) point(`${what} patrol`, w.x, w.z);
  };
  POIS.forEach((p, i) => {
    point(`POI ${i} entry`, p.entry.x, p.entry.z);
    p.bins.forEach((b) => point(`POI ${i} bin`, b.x, b.z, b.y ?? 0));
    p.floor.forEach((f) => point(`POI ${i} floor loot`, f.x, f.z, f.y ?? 0));
    p.squads.forEach((sq) => squad(`POI ${i} ${sq.name}`, sq));
    if (p.carePackage) point(`POI ${i} care package`, p.carePackage.x, p.carePackage.z);
  });
  EXTRA_BINS.forEach((b) => point("extra bin", b.x, b.z, b.y ?? 0));
  ROAMERS.forEach((sq) => squad(`roamer ${sq.name}`, sq));
  for (const x of EXTRACTS) point(`extract ${x.id}`, x.x, x.z, x.id === "ship" ? 0.25 : 0);
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
  const x = POIS[3].x;
  const z = POIS[3].z;
  p.pos = { x, y: 0, z };
  p.onGround = true;
  p.hp = 1;
  p.shield = 0;
  p.selfRevive = 0;
  s.orbs.push({ id: 900, pos: { x, y: 1.1, z: z + 0.3 }, vel: { x: 0, y: 0, z: -1 }, r: 0.4, dmg: 10, life: 5, homing: false });
  s.orbs.push({ id: 901, pos: { x, y: 3, z: z + 20 }, vel: { x: 0, y: 0, z: -5 }, r: 0.4, dmg: 10, life: 5, homing: true });
  s.waves.push({ x, z: z + 30, y: 0, r: 3, hit: false });
  step(s, idleInput(), false);
  if (s.stats.wipes !== 1) return `wipe scenario: expected a wipe, got ${s.stats.wipes}`;
  if (s.orbs.length || s.waves.length) return `wipe scenario: ${s.orbs.length} orbs and ${s.waves.length} shockwaves survived the wipe`;
  return null;
}
/** The arc finishing the titan also takes its squad's drones; none of them may be killed twice. */
function checkArcOnTitan(): string | null {
  const s = newRun(5);
  s.phase = "play";
  const boss = s.enemies.filter((e) => e.poi === 3);
  s.enemies = boss;
  const p = s.player;
  const pad = POIS[3];
  p.pos = { x: pad.x, y: 0, z: pad.z + 6 };
  p.onGround = true;
  p.yaw = 0; // facing north, at the titan
  const titan = boss.find((e) => e.kind === "titan")!;
  titan.hp = 1;
  titan.shield = 0;
  // Its drones stand behind it, so the arc reaches the titan first.
  boss.filter((e) => e.kind === "drone").forEach((d, i) => {
    d.pos = { x: pad.x + (i ? 3 : -3), y: 3.4, z: pad.z - 18 };
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
  const pad = POIS[3];
  p.pos = { x: pad.x, y: 0, z: pad.z + 6 };
  p.onGround = true;
  p.yaw = 0;
  p.pitch = 0;
  const target = s.enemies.find((e) => e.kind === "drone" && e.poi === 3)!;
  s.enemies = [target];
  target.pos = { x: pad.x, y: 1.6, z: pad.z - 4 };
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
  const pad = POIS[3];
  p.pos = { x: pad.x, y: 0, z: pad.z + 6 };
  p.onGround = true;
  p.yaw = 0;
  const grunt = s.enemies.find((e) => e.kind === "grunt")!;
  s.enemies = [grunt];
  grunt.pos = { x: pad.x, y: 0, z: pad.z - 4 };
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
  const at = POIS[1].entry;
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
  const d = Math.hypot(fresh[0].pos.x - p.pos.x, fresh[0].pos.z - p.pos.z);
  if (d < REINFORCE.dist[0] - 5 || d > REINFORCE.dist[1] + 5 || fresh.some((e) => e.aware !== "alert" || !e.goal)) return `reinforce scenario: ${d.toFixed(0)} m away, not hunting`;
  // They keep closing in while the player moves on, instead of giving up at the first guess.
  p.iframes = 999;
  p.pos.x += 8;
  ticks(s, 30);
  const left = s.enemies.filter((e) => fresh.includes(e));
  const closest = Math.min(...left.map((e) => Math.hypot(e.pos.x - p.pos.x, e.pos.z - p.pos.z)));
  if (!(closest < d - 20)) return `reinforce scenario: still ${closest.toFixed(0)} m away after 30 s (spawned ${d.toFixed(0)} m away)`;
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
  s.bins = [{ id: 9001, x: p.pos.x + 1, y: p.pos.y, z: p.pos.z, poi: 2, open: false, flare: false }];
  const press = idleInput();
  press.interact = true;
  step(s, press, false);
  // Searching takes its time: not open just short of it, open (and bagged) after.
  ticks(s, SEARCH.time - 0.2);
  if (s.bins[0].open) return "search scenario: the bin opened before the search time";
  ticks(s, 3);
  if (haulValue(s) !== VALUABLES[POIS[2].loot.valuable].value) return `valuable scenario: haul ${haulValue(s)}, bin open ${s.bins[0].open}`;
  return null;
}
/** Walking away from a bin breaks the search off; it starts over on the next press. */
function checkSearchBreaks(): string | null {
  const s = padRun();
  const p = s.player;
  s.bins = [{ id: 9001, x: p.pos.x + 1, y: p.pos.y, z: p.pos.z, poi: 2, open: false, flare: false }];
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
  if (s.shipCall <= 0 || s.phase === "done" || waves < 2) return `ship scenario: ${s.shipCall.toFixed(1)} s left, phase ${s.phase}, ${waves} robots beamed in`;
  ticks(s, 1 + ship.hold + 0.2);
  if (phaseOf(s) !== "done" || s.extractedAt !== "ship") return `ship scenario: did not leave after landing (${s.shipCall.toFixed(1)}, ${s.phase})`;
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
  p.pos = { x: POIS[3].x, y: 0, z: POIS[3].z };
  p.pos.y = groundAt(p.pos.x, p.pos.z, 0.4, 2);
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
/** A stomp's wave passes under a teammate standing above it, and hits one on the ground. */
function checkStompHeight(): string | null {
  const hit = (y: number) => {
    const s = padRun();
    const a = s.ally;
    a.pos = { x: s.player.pos.x + 20, y, z: s.player.pos.z };
    s.waves.push({ x: a.pos.x - 6, z: a.pos.z, y: 0, r: 5.9, hit: true });
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
  s.bins.push({ id: 9999, x: p.pos.x + 0.3, y: p.pos.y, z: p.pos.z, poi: 0, open: false, flare: false });
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
  s.enemies = s.enemies.filter((e) => e.poi === 3);
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
function checkAllyHoldsFire(): string | null {
  const s = newRun(5);
  s.phase = "play";
  const grunt = s.enemies.find((e) => e.kind === "grunt" && e.pos.y < 0.5)!;
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
for (const err of [checkWipeClearsAir(), checkArcOnTitan(), checkGoldReload(), checkArcIgnoresFacing(), checkDeathEndsRaid(), checkBleedoutWipe(), checkReinforce(), checkReinforceHidden(), checkSearchBreaks(), checkBagSwap(), checkRaiders(), checkValuableBin(), checkAllyRescue(), checkAllyDownWipes(), checkHelpAlly(), checkAllyHoldsFire(), checkFlareExtract(), checkShipCall(), checkAllySelfUp(), checkStompHeight(), checkWeakPointBehindBody(), checkHelpBeforeLoot(), checkAllyTitanKill()]) {
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
const head = ["skill    ", "alive", "time(med)", "cleared", "haul(med)", "score(med)", "downs", "acc", "crit", "ult", "crowd", "flank", "waves", "ally".padEnd(18), "rank".padEnd(18), "exit"];
console.log(`${runs} runs per skill. alive: share of raids that got off the island (the rest were wiped out)`);
console.log("time: minutes from landing to leaving; cleared: median POIs cleared; haul and score: medians over raids that got off the island");
console.log("flank: share of hits from behind a robot or before it noticed the player");
console.log("waves: median reinforcement squads that beamed in during a raid");
console.log("ally: teammate's share of the damage, its downs, times it picked the player up (r) and was picked up (h), per run");
console.log("exit: raids that left by each extraction point (the bot's choice depends on skill)");
console.log("crowd: median over runs of the most squads / robots fighting the player at once outside the titan fight");
console.log(head.join(" "));
for (const skill of SKILLS) {
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
  const exits: Record<string, number> = { ship: 0, flare: 0, village: 0 };
  const crowdSq: number[] = [];
  const crowdBots: number[] = [];
  const ranks: Record<string, number> = { S: 0, A: 0, B: 0, C: 0, "-": 0 };
  for (let r = 0; r < runs; r++) {
    const s = newRun(1000 + r * 7919);
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
        if (end >= 0 && end < s.events.length - 1) throw new Error(`${skill.name}#${r}: events after the raid ended: ${s.events.slice(end + 1).map((e) => e.t).join(",")}`);
        for (const e of s.events) {
          if (e.t === "ultStart") ults++;
          if (e.t === "landed") landed = s.time;
        }
        if (!s.enemies.some((e) => e.kind === "titan" && e.aware === "engaged")) {
          const fighting = s.enemies.filter((e) => e.aware === "engaged" && e.mode !== "spawning");
          peakBots = Math.max(peakBots, fighting.length);
          peakSq = Math.max(peakSq, new Set(fighting.map((e) => e.squad)).size);
        }
        if (Math.round(s.time / TICK) % 30 === 0) check(s, `${skill.name}#${r} t=${s.time.toFixed(1)}`);
      }
    } catch (err) {
      failed = true;
      console.error(String(err));
      continue;
    }
    if (s.phase !== "done") {
      failed = true;
      const p = s.player.pos;
      console.error(`${skill.name}#${r}: still on the island after ${LIMIT} s, cleared ${s.stats.cleared.join(",")} player ${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)} enemies near: ${s.enemies.filter((e) => Math.hypot(e.pos.x - p.x, e.pos.z - p.z) < 60).map((e) => `${e.kind}@${e.pos.x.toFixed(0)},${e.pos.z.toFixed(0)}:${e.mode}:${e.aware}`).join(" ")}`);
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
      `ship ${exits.ship} flare ${exits.flare} village ${exits.village}`,
    ].join(" "),
  );
}
if (failed) {
  console.error("FAILED");
  process.exit(1);
}
