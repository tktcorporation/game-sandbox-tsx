import { ALLY, AWARE, CHARGER, COVER, CREW, DEG, DODGE, DUCK, ELITE, ENEMIES, FALLBACK, PACK, PARTY, PINCH, SPLIT, SWEEP, PLAYER, PURSUE, SHOT, SIGHT, STAGGER, TICK, TITAN, TURN, WORLD, type EnemyKind, type Rarity } from "./config";
import { clampToWorld, collide, dist2d, fenceBetween, groundAt, groundLevel, los, lookAngles, onTerrain, solidAt, worldVersion, wrapAngle } from "./geom";
import { steepAt, terrainHeight } from "./terrain";
import { engageSquad, fireRange, headOf, knownSpot, located, pursuitSpot, sense, stepSquads } from "./awareness";
import { coversNear, type CoverPoint } from "./cover";
import { fieldTo, forgetFields, nextStep, onMainGround, routeLength } from "./hunt";

/** Walkers refuse to step off a ledge higher than this, so rooftop robots stay on their roof. */
const LEDGE = 1.0;
/** Walkers posted on the ground climb no higher than this above the terrain (stairs onto a roof). */
const CLIMB = 1.2;
const bodyHeight = (k: { bodyY: number; radius: number }) => k.bodyY + k.radius;
import { inCamp, MOBILES, OUTPOST_SITES, PARTY_STOPS, POIS, RELAYS, relayIndex, ROAMERS, type Mobile, type Squad } from "./map";
import { beatOf, damageRobot, fightHeard, foeOf, mobileWalks, placeMobile } from "./factions";
import { bodyCenter, weakPoint } from "./combat";
import { hurtPlayer } from "./player";
import { allyChest, allyUp, hurtAlly } from "./ally";
import { activePacks, garrison, netPlated } from "./island";
import { modScale } from "./mods";
import { crewRand, mix, rand, roamRand, sightScale, weakY, type Enemy, type Point, type State, type Vec3 } from "./state";

/*
 * Robot behaviour. Out of combat a robot holds its post or walks its squad's
 * patrol, and searches where it heard or glimpsed something. In combat every
 * attack follows the same readable rhythm: move -> telegraph (eye glows, aim
 * locks near the end) -> fire -> move. Grunts on the ground hide behind cover
 * between shots and step out sideways to fire.
 */

interface SpawnOpts {
  floor?: number;
  face?: number;
  /** Beam in with the spawn animation (titan summons) instead of standing there from the start. */
  appear?: boolean;
  /** A raider. */
  elite?: boolean;
  /** Its armour plate's tier (see PLATE); none when omitted. */
  plate?: Rarity;
  /** A drone pack's or a hunting party's: drawn from their own random numbers (`roamRand()`). */
  roam?: boolean;
  /** A salvage crew's, the retake squad's or the debris guards': drawn from theirs (`crewRand()`). */
  crew?: boolean;
  /** One of the rogues (see FACTION). */
  rogue?: boolean;
  /** A squad on a walk (`MOBILES`): its own draws are a hash of the seed and its id, so it shifts none of the raid's streams. */
  hashed?: boolean;
}

/** The random numbers robot `e` draws on: the crews' stream for a crew's, the retake squad's or the debris guards' (`Enemy.own`), else the raid's. */
const draw = (s: State, e: Enemy) => (e.own ? crewRand(s) : rand(s));

/** Where a robot asked to appear at (x, z) on `floor` (the ground when omitted) ends up: pushed out of solids, on its floor or at hover height. */
export function spawnSpot(kind: EnemyKind, x: number, z: number, floor = terrainHeight(x, z)): Vec3 {
  const k = ENEMIES[kind];
  const pos = { x, y: floor, z };
  collide(pos, k.radius, bodyHeight(k));
  pos.y = k.fly > 0 ? flyHeight(pos.x, pos.z) : groundAt(pos.x, pos.z, k.radius, floor + 0.3);
  return pos;
}

export function spawnEnemy(s: State, kind: EnemyKind, x: number, z: number, poi: number, squad: number, o: SpawnOpts = {}): Enemy {
  const k = ENEMIES[kind];
  const id = s.nextId++;
  let k0 = 0;
  const hashed = () => mix(Math.imul(s.seed + 1, 0x85ebca6b) ^ Math.imul(id, 0x9e3779b1) ^ Math.imul(++k0, 0xc2b2ae35)) / 4294967296;
  const pick = o.hashed ? hashed : o.crew ? crewRand : o.roam ? roamRand : rand;
  const pos = spawnSpot(kind, x, z, o.floor);
  const face = o.face ?? pick(s) * Math.PI * 2;
  // A strong network plates some of the plain grunts and heavies, picked without drawing on the raid's numbers.
  const plate = o.plate ?? ((kind === "grunt" || kind === "heavy") && !o.elite && netPlated(s.seed, s.network, id, s.threat ?? 0) ? 1 : 0);
  const e: Enemy = {
    id,
    kind,
    pos,
    vel: { x: 0, y: 0, z: 0 },
    yaw: face,
    hp: k.hp * (o.elite ? ELITE.hp : 1),
    shield: k.shield * (o.elite ? ELITE.hp : 1),
    mode: o.appear ? "spawning" : "move",
    timer: o.appear ? 0.9 : 0,
    cooldown: 0,
    shotsLeft: 0,
    strafe: pick(s) < 0.5 ? -1 : 1,
    poi,
    lastHit: 99,
    aimYaw: 0,
    aimPitch: 0,
    summoned: 0,
    squad,
    aware: "idle",
    detect: 0,
    home: { ...pos },
    face,
    lookT: pick(s) * 10,
    goal: null,
    searchT: 0,
    cover: null,
    peek: null,
    coverT: 0,
    target: "player",
    targetT: 0,
    allyHit: 99,
    elite: !!o.elite,
    plate: plate as Rarity,
    strafeT: pick(s),
    jink: 0,
    stagger: 0,
    steady: 0,
    peekSide: pick(s) < 0.5 ? -1 : 1,
    opener: true,
    stuckT: 0,
    stuckTo: null,
    // Not located: a robot that appears mid-fight must find the player with its own eyes too.
    blind: AWARE.loseTime,
    sawAt: null,
    finding: 0,
    duck: 0,
    own: !!o.crew,
    rogue: o.rogue || undefined,
  };
  s.enemies.push(e);
  if (o.appear) s.events.push({ t: "spawn", id: e.id, pos: { ...pos } });
  return e;
}

/** Put every squad on the island at the start of a run (the hunting parties come after, see `placeParties()`). */
export function populate(s: State) {
  const add = (sq: Squad, poi: number, rogue = false) => {
    const index = s.squads.length;
    s.squads.push({ name: sq.name, poi, patrol: sq.patrol ?? [], leg: 0, engaged: false, roam: !!sq.roam, sinceSeen: 0, last: { x: 0, z: 0 }, rogue: rogue || undefined });
    for (const m of sq.members) spawnEnemy(s, m.kind, m.x, m.z, poi, index, { floor: m.y, face: m.face, plate: m.plate, rogue });
  };
  const walker = (st: State, kind: EnemyKind, x: number, z: number, squad: number, face: number, rogue: boolean) => void spawnEnemy(st, kind, x, z, -1, squad, { face, hashed: true, rogue });
  // A POI stands with the garrison its standing on the island gives it (`garrison()`); the squads
  // of it that walk a beat (`MOBILES`) are out on it, no longer the POI's.
  const beats: { m: Mobile; kinds: EnemyKind[] }[] = [];
  POIS.forEach((p, i) =>
    garrison(i, s.hold[i], s.seed).forEach((sq) => {
      const beat = beatOf(p.id, sq.name);
      if (beat) beats.push({ m: beat, kinds: sq.members.map((m) => m.kind) });
      else add(sq, i);
    }),
  );
  // An outpost the rogues hold has rogue guards (`TERRITORY`).
  const rogueGuards = new Set(OUTPOST_SITES.filter((o) => s.territory[o.id] === "rogue").map((o) => o.guard));
  ROAMERS.forEach((sq) => add(sq, -1, rogueGuards.has(sq.name)));
  for (const b of beats) placeMobile(s, b.m, b.kinds, walker);
  for (const m of MOBILES) if (mobileWalks(s, m)) placeMobile(s, m, m.members ?? [], walker);
  // The walks are built by fields (`mobileWalk()`): the raid starts with none, whichever walks
  // this process built before, so it plays the same wherever it is played.
  forgetFields();
  // Each relay mast standing this raid has its two guards at its foot.
  for (const m of s.relays) add(RELAYS[relayIndex(m.id)].guards, -1);
  // Each drone pack starts at a waypoint of its loop well away from the player, and flies on from there.
  const p0 = s.player.pos;
  // As many packs fly as the network gives (`activePacks()`): all of them at the sim gate's level.
  for (const sq of activePacks(s.seed, s.network)) {
    const loop = sq.patrol ?? [];
    const far = loop.map((_, i) => i).filter((i) => dist2d(loop[i], p0) >= PACK.away);
    const leg = far[Math.floor(roamRand(s) * far.length)] ?? 0;
    const index = s.squads.length;
    s.squads.push({ name: sq.name, poi: -1, patrol: loop, leg, engaged: false, roam: !!sq.roam, pack: true, sight: PACK.sight, sinceSeen: 0, last: { x: 0, z: 0 } });
    const at = loop[leg];
    sq.members.forEach((m, i) => spawnEnemy(s, m.kind, at.x + (i % 2 ? 1.6 : -1.6) * Math.min(i, 1), at.z + i * 1.4, -1, index, { roam: true }));
  }
}

/** Where robots aim at the player: the chest, lower while crouched or sliding, so a low wall covers. */
const chest = (s: State): Vec3 => {
  const p = s.player;
  return { x: p.pos.x, y: p.pos.y + (p.crouch || p.sliding ? 0.75 : 1.1), z: p.pos.z };
};

function muzzle(e: Enemy): Vec3 {
  return e.kind === "drone" ? weakPoint(e) : { ...bodyCenter(e), y: e.pos.y + weakY(e) - 0.1 };
}

function fireOrb(s: State, e: Enemy, yawOff = 0, homing = false, foe?: Enemy) {
  const k = ENEMIES[e.kind];
  const from = muzzle(e);
  // A random stray (see SHOT.spread); the titan's homing rockets find their own way.
  const stray = homing ? 0 : SHOT.spread * DEG * (!foe && e.target === "player" ? modScale(s.player, "deflector") : 1);
  const r = Math.sqrt(-2 * Math.log(draw(s, e) + 1e-9));
  const a = draw(s, e) * Math.PI * 2;
  const yaw = e.aimYaw + yawOff + r * Math.cos(a) * stray;
  const pitch = e.aimPitch + r * Math.sin(a) * stray;
  const c = Math.cos(pitch);
  s.orbs.push({
    id: s.nextId++,
    pos: from,
    vel: { x: Math.sin(yaw) * c * k.orbSpeed, y: Math.sin(pitch) * k.orbSpeed, z: -Math.cos(yaw) * c * k.orbSpeed },
    r: k.orbR,
    dmg: k.orbDmg * (e.elite ? ELITE.dmg : 1),
    life: 5,
    homing,
    by: foe ? e.id : undefined,
    rogue: e.rogue || undefined,
  });
  s.events.push(foe ? { t: "enemyFire", id: e.id, pos: from, foe: bodyCenter(foe), rogue: !!e.rogue } : { t: "enemyFire", id: e.id, pos: from, rogue: e.rogue || undefined });
}

function lockAim(e: Enemy, at: Vec3) {
  const a = lookAngles(muzzle(e), at);
  e.aimYaw = a.yaw;
  e.aimPitch = a.pitch;
}

/** Aim at a moving target's chest, led by its ground motion over the shot's flight (see SHOT). */
function leadAim(e: Enemy, at: Vec3, vel: Vec3) {
  const k = ENEMIES[e.kind];
  const from = muzzle(e);
  const t = (Math.hypot(at.x - from.x, at.y - from.y, at.z - from.z) / Math.max(k.orbSpeed, 1)) * SHOT.lead;
  lockAim(e, { x: at.x + vel.x * t, y: at.y, z: at.z + vel.z * t });
}

/** Drones keep their hover height above the ground, and clear whatever is built under them. */
function flyHeight(x: number, z: number): number {
  return Math.max(terrainHeight(x, z) + ENEMIES.drone.fly, groundAt(x, z, 1.2, 99) + 2.4);
}

/*
 * Each walker's last `groundAt()` question and answer. `moveBody()` asks for the ground where the
 * walker stood and where it steps to: a walker standing still asks the same twice, and where it
 * stood is mostly where it stepped to the tick before. The same question in the same world has
 * the same answer.
 */
type GroundAsked = { x: number; z: number; r: number; feet: number; world: number; g: number };
const groundAsked = new WeakMap<Enemy, GroundAsked>();
function groundUnder(e: Enemy, x: number, z: number, r: number, feet: number): number {
  const a = groundAsked.get(e);
  if (a && a.world === worldVersion && Object.is(a.x, x) && Object.is(a.z, z) && Object.is(a.feet, feet) && a.r === r) return a.g;
  const g = groundAt(x, z, r, feet);
  if (a) {
    a.x = x;
    a.z = z;
    a.r = r;
    a.feet = feet;
    a.world = worldVersion;
    a.g = g;
  } else groundAsked.set(e, { x, z, r, feet, world: worldVersion, g });
  return g;
}

function moveBody(e: Enemy, vx: number, vz: number) {
  const k = ENEMIES[e.kind];
  e.vel.x += (vx - e.vel.x) * Math.min(1, TICK * 8);
  e.vel.z += (vz - e.vel.z) * Math.min(1, TICK * 8);
  const bx = e.pos.x;
  const bz = e.pos.z;
  e.pos.x += e.vel.x * TICK;
  e.pos.z += e.vel.z * TICK;
  // No robot comes into the camp, over its fence or through its gate.
  if (inCamp(e.pos, k.radius + 0.5) && !inCamp({ x: bx, z: bz }, k.radius + 0.5)) {
    e.pos.x = bx;
    e.pos.z = bz;
    e.vel.x = e.vel.z = 0;
    return true;
  }
  if (k.fly > 0) {
    e.pos.y += (flyHeight(e.pos.x, e.pos.z) - e.pos.y) * Math.min(1, TICK * 2.5);
    clampToWorld(e.pos, 1);
    return false;
  }
  const blocked = collide(e.pos, k.radius, bodyHeight(k));
  const here = groundUnder(e, bx, bz, k.radius, e.pos.y);
  const there = groundUnder(e, e.pos.x, e.pos.z, k.radius, e.pos.y);
  // A drop ahead stays on this floor. A robot posted up high (a roof, a tower tier)
  // never leaves its floor at all: it could not find the way back up. A robot posted
  // on the ground does not climb stairs onto roofs or upper floors either.
  const homeHigh = e.home.y > groundLevel(e.home.x, e.home.z) + 0.6;
  const climbsUp = !homeHigh && there > groundLevel(e.pos.x, e.pos.z) + CLIMB;
  if (there < here - LEDGE || (homeHigh && Math.abs(there - e.home.y) > 0.3) || climbsUp) {
    e.pos.x = bx;
    e.pos.z = bz;
    e.vel.x = e.vel.z = 0;
    return true;
  }
  // Walk up steps at once; fall down with gravity.
  if (there >= e.pos.y) {
    e.pos.y = there;
    e.vel.y = 0;
  } else {
    e.vel.y -= WORLD.gravity * TICK;
    e.pos.y = Math.max(there, e.pos.y + e.vel.y * TICK);
    if (e.pos.y === there) e.vel.y = 0;
  }
  // Moved much less than asked: the way is blocked.
  return blocked && Math.hypot(e.pos.x - bx, e.pos.z - bz) < Math.hypot(vx, vz) * TICK * 0.4;
}

export function stepEnemies(s: State) {
  const p = s.player;
  stepSquads(s);
  const byId = new Map(s.enemies.map((e) => [e.id, e]));
  // A robot destroyed takes a new list (`kill()`, `fall()`): only then are the rest looked up in it.
  const start = s.enemies;
  const gone = (e: Enemy) => s.enemies !== start && !s.enemies.includes(e);
  for (const e of [...s.enemies]) {
    // Destroyed earlier this tick (by the other faction's fire, or the titan's fall).
    if (gone(e)) continue;
    if (s.phase === "done") return; // a robot ahead in the list ended the raid
    const k = ENEMIES[e.kind];
    e.lastHit += TICK;
    e.allyHit += TICK;
    e.blind += TICK;
    e.jink = Math.max(0, e.jink - TICK);
    e.steady = Math.max(0, e.steady - TICK);
    e.stagger *= Math.exp(-TICK / STAGGER.window);
    // A robot stands up unless it is hiding at its cover this tick (fromCover() keeps it down).
    e.duck = Math.max(0, e.duck - DUCK.rate * TICK);
    if (e.mode === "spawning") {
      e.timer -= TICK;
      if (e.timer <= 0) {
        e.mode = "move";
        e.cooldown = k.cooldown * (0.4 + draw(s, e) * 0.5);
      }
      continue;
    }
    sense(s, e);
    if (e.mode === "stunned" || e.mode === "staggered") {
      // Reeling: the knock-back it was given dies away; then it fights on, a beat before its next attack.
      e.timer -= TICK;
      moveBody(e, 0, 0);
      if (e.timer <= 0) {
        e.cooldown = Math.max(e.cooldown, e.mode === "staggered" ? 0.4 : 0.6);
        e.mode = "move";
      }
      continue;
    }
    if (e.aware !== "engaged") {
      // The titan wakes when the player walks into its arena.
      if (e.kind === "titan" && dist2d(e.pos, p.pos) < 24 && p.downed <= 0 && s.phase === "play") engageSquad(s, e.squad, e);
      else {
        // Not fighting the player: it fights the other faction's robot its squad is on, if any (see FACTION).
        const foe = foeOf(s, e, byId);
        if (foe && !gone(foe)) fightFoe(s, e, foe);
        else calm(s, e);
        continue;
      }
    }
    if (e.kind === "titan") {
      const d = dist2d(e.pos, p.pos);
      e.yaw += wrapAngle(lookAngles(e.pos, p.pos).yaw - e.yaw) * Math.min(1, TICK * 1.5);
      titan(s, e, d);
      continue;
    }
    // Whom it fights. At the teammate it knows where it is (the teammate shoots and
    // calls out); at the player it acts on what its squad knows: the player while
    // seen, else the last sighting.
    chooseTarget(s, e);
    const atAlly = e.target === "ally";
    const tPos = atAlly ? s.ally.pos : p.pos;
    const tChest = atAlly ? allyChest(s.ally) : chest(s);
    const tUp = atAlly ? allyUp(s) : p.downed <= 0;
    const tVel = atAlly ? s.ally.vel : p.vel;
    const known = atAlly ? { x: tPos.x, z: tPos.z, live: true } : knownSpot(s, e);
    // Its squad has the player pinned to one spot, or backing away: this member goes round (see PINCH).
    const round = atAlly ? null : pinchSpot(s, e, known);
    const dx = known.x - e.pos.x;
    const dz = known.z - e.pos.z;
    const d = Math.hypot(dx, dz) || 1e-3;
    // The squad has lost the player: this member goes after them, to its own side of the spot (see PURSUE).
    const after = known.live || round ? null : pursuitSpot(s, e, known);
    const afterVia = after && dist2d(e.pos, after) > 1.5 ? sideStep(s, e, after, known, PURSUE.spread) : null;
    // Out on the way there it looks where it walks, round the corner ahead; at the spot, at the spot.
    const look = afterVia && dist2d(e.pos, known) > 6 ? afterVia : known;
    const lx = look.x - e.pos.x;
    const lz = look.z - e.pos.z;
    if (e.mode !== "lunge" && Math.hypot(lx, lz) > 0.5) turnAt(e, Math.atan2(lx, -lz), TURN[e.kind] * (e.elite ? ELITE.turn : 1));
    // Raiders do not hide: they press in and go round. Nor does a grunt on its way round a pinned player.
    if (e.kind === "grunt" && !e.elite && !round && fromCover(s, e, known, tChest, tUp, tVel)) continue;
    switch (e.mode) {
      case "move": {
        const sees = known.live && facing(e, tPos) && los(muzzle(e), tChest);
        // Out of sight, or seen through a fence, it closes in by the ground's way, round the cliff, the house or the fence between.
        const via = sees && !fenceBetween(e.pos, tPos) ? known : (afterVia ?? (after ? after : huntStep(s, e, known)));
        const vd = Math.hypot(via.x - e.pos.x, via.z - e.pos.z) || 1e-3;
        const ux = (via.x - e.pos.x) / vd;
        const uz = (via.z - e.pos.z) / vd;
        let along = 0;
        // At its point of the search with nobody in view, it stands and looks until the next.
        if (after && !afterVia) along = 0;
        else if (sees && hurtAlone(s, e) && d < k.range + 8) along = -1; // hurt and alone: it gives ground
        else if (!sees || d > k.range + 4) along = 1;
        // In line with the player it has not found, and not making them out from here: it closes in to look.
        else if (!atAlly && !located(s, e) && e.finding <= 0) along = 1;
        else if (d < k.range - 4) along = -0.7;
        // In sight it strafes across the target's view; a jink after a hit is a quicker step the other way.
        const side = (e.kind === "charger" ? 0.55 : sees ? DODGE.strafe : 0.8) * (e.jink > 0 ? DODGE.jinkSpeed : 1);
        // Sideways it keeps to its own level: ground falling away to that side (a ramp down off a
        // quarry's tier) turns the strafe round, so it does not drift off where the fight is.
        if (onTerrain(e.pos) && terrainHeight(e.pos.x - uz * e.strafe * 1.5, e.pos.z + ux * e.strafe * 1.5) < terrainHeight(e.pos.x, e.pos.z) - 0.5) e.strafe = -e.strafe;
        let vx = (ux * along - uz * e.strafe * side) * k.speed;
        let vz = (uz * along + ux * e.strafe * side) * k.speed;
        // A flanking raider, or a member going round a pinned player, runs wide to its spot
        // at the player's side, shooting when it can.
        const wide = round ?? (e.elite && !atAlly ? flankSpot(s, e, known) : null);
        if (wide && dist2d(e.pos, wide) > 3) {
          // Out of sight it gets there by the ground's way, round the cliff or the house between.
          const to = sees ? wide : sideStep(s, e, wide, known, PINCH.dist);
          const fd = dist2d(e.pos, to) || 1e-3;
          let ux2 = (to.x - e.pos.x) / fd;
          let uz2 = (to.z - e.pos.z) / fd;
          // Round the spot, not through it: closer than 6 m it bends away from where the player is believed to be.
          const kd = dist2d(e.pos, known) || 1e-3;
          if (kd < 6) {
            const w = (6 - kd) / 6;
            ux2 += ((e.pos.x - known.x) / kd) * w * 1.5;
            uz2 += ((e.pos.z - known.z) / kd) * w * 1.5;
            const ul = Math.hypot(ux2, uz2) || 1;
            ux2 /= ul;
            uz2 /= ul;
          }
          vx = ux2 * k.speed;
          vz = uz2 * k.speed;
        }
        if (moveBody(e, vx, vz)) e.strafe = -e.strafe;
        else if (e.jink <= 0 && (e.strafeT -= TICK) <= 0) {
          e.strafeT = DODGE.every[0] + draw(s, e) * (DODGE.every[1] - DODGE.every[0]);
          if (draw(s, e) < DODGE.flip) e.strafe = -e.strafe;
        }
        e.cooldown -= TICK;
        const ready = e.cooldown <= 0 && sees && tUp && (atAlly || located(s, e));
        // It fires as far as it can see while fighting (further when answering the player's shots
        // from afar, see RETURN), measured eye to chest as sight is; its preferred distance only
        // steers where it walks. The teammate is fought within its fighting sight alone.
        const eye = headOf(e);
        const reach = Math.hypot(tChest.x - eye.x, tChest.y - eye.y, tChest.z - eye.z);
        const far = atAlly ? SIGHT[e.kind].range * sightScale(s) * AWARE.engagedRange : fireRange(s, e);
        if (ready && (e.kind === "charger" ? d < CHARGER.lungeRange : reach < far)) {
          e.mode = "telegraph";
          e.timer = k.telegraph;
          leadAim(e, tChest, tVel);
          s.events.push({ t: "telegraph", id: e.id });
        }
        break;
      }
      case "telegraph": {
        windupStep(e, dx / d, dz / d);
        e.timer -= TICK;
        // Aim follows the target through the wind-up while it is in sight and in the robot's
        // cone: the glow is the time to get behind something, not to step aside. A target that
        // breaks the line of sight or slips out of the cone is shot at where it was.
        if (sightOn(e, tPos, tChest)) leadAim(e, tChest, tVel);
        if (e.timer <= 0) {
          if (e.kind === "charger") {
            e.mode = "lunge";
            e.timer = CHARGER.lungeTime;
            e.shotsLeft = 1;
            e.yaw = e.aimYaw;
            s.events.push({ t: "lunge", id: e.id });
          } else if (sightOn(e, tPos, tChest)) {
            e.mode = "fire";
            e.timer = 0;
            e.shotsLeft = k.shots;
          } else {
            // The target got behind something or out of its cone during the glow: no burst.
            e.mode = "move";
            e.cooldown = 0.5;
          }
        }
        break;
      }
      case "fire": {
        windupStep(e, dx / d, dz / d);
        e.timer -= TICK;
        if (e.timer <= 0 && e.shotsLeft > 0) {
          // Every shot of a burst is aimed afresh while the target is in sight.
          if (sightOn(e, tPos, tChest)) leadAim(e, tChest, tVel);
          if (k.spread > 0) {
            for (let i = 0; i < k.shots; i++) fireOrb(s, e, ((i - (k.shots - 1) / 2) * k.spread * Math.PI) / 180);
            e.shotsLeft = 0;
          } else {
            fireOrb(s, e);
            e.shotsLeft--;
            e.timer = k.shotGap;
          }
        }
        if (e.shotsLeft <= 0) {
          e.mode = "move";
          e.opener = false;
          e.cooldown = k.cooldown * (0.8 + draw(s, e) * 0.4) * (e.elite ? ELITE.cooldown : 1);
          // A grunt in cover shows itself next from the other side of it; hurt and alone, it stays hidden longer.
          e.peekSide = -e.peekSide;
          e.coverT = 0;
          if (e.kind === "grunt" && hurtAlone(s, e)) e.cooldown = Math.max(e.cooldown, FALLBACK.hide[0] + draw(s, e) * (FALLBACK.hide[1] - FALLBACK.hide[0]));
        }
        break;
      }
      case "lunge": {
        const vx = Math.sin(e.yaw) * CHARGER.lungeSpeed;
        const vz = -Math.cos(e.yaw) * CHARGER.lungeSpeed;
        e.vel.x = vx;
        e.vel.z = vz;
        const hitWall = moveBody(e, vx, vz);
        if (e.shotsLeft > 0 && Math.hypot(p.pos.x - e.pos.x, p.pos.z - e.pos.z) < CHARGER.hitRadius + PLAYER.radius && Math.abs(p.pos.y - e.pos.y) < 1.4) {
          e.shotsLeft = 0;
          hurtPlayer(s, k.orbDmg, e.pos.x, e.pos.z);
        }
        const a = s.ally;
        if (e.shotsLeft > 0 && allyUp(s) && Math.hypot(a.pos.x - e.pos.x, a.pos.z - e.pos.z) < CHARGER.hitRadius + ALLY.radius && Math.abs(a.pos.y - e.pos.y) < 1.4) {
          e.shotsLeft = 0;
          hurtAlly(s, k.orbDmg);
        }
        e.timer -= TICK;
        if (e.timer <= 0 || hitWall) {
          e.mode = "recover";
          e.timer = 1.0;
        }
        break;
      }
      case "recover": {
        moveBody(e, 0, 0);
        e.timer -= TICK;
        if (e.timer <= 0) {
          e.mode = "move";
          e.cooldown = k.cooldown * (0.8 + draw(s, e) * 0.4);
        }
        break;
      }
      default:
        break;
    }
  }
  separate(s);
}

/**
 * Whom an engaged robot fights, re-thought every 1.5 s: the nearer of the player and
 * the teammate, a target out of sight counting as far away. The teammate counts as
 * `aggroBias` metres further unless it has just shot this robot, so the player stays
 * the main target and the teammate draws the robots it hurts. The titan only fights the player.
 */
function chooseTarget(s: State, e: Enemy) {
  if (!allyUp(s)) {
    e.target = "player";
    return;
  }
  if (s.player.downed > 0) {
    e.target = "ally";
    return;
  }
  e.targetT -= TICK;
  if (e.targetT > 0) return;
  e.targetT = 1.5;
  const from = muzzle(e);
  const a = s.ally;
  const toPlayer = dist2d(e.pos, s.player.pos) + (los(from, chest(s)) ? 0 : 30) - (e.target === "player" ? 3 : 0);
  const toAlly = dist2d(e.pos, a.pos) + (los(from, allyChest(a)) ? 0 : 30) - (e.target === "ally" ? 3 : 0) + (e.allyHit < 2 ? -4 : ALLY.aggroBias);
  e.target = toAlly < toPlayer ? "ally" : "player";
}

/**
 * A robot whose squad is fighting `foe`, a robot of the other faction (see FACTION), and not the
 * player: the same rhythm as at the player (move, wind up, fire) with plain aim. It keeps its own
 * distance strafing while it sees the foe, closes in by the ground's way while it does not, and
 * fires as far as it sees while fighting. A charger runs in and strikes. Its squad's fire is heard
 * (`fightHeard()`).
 */
function fightFoe(s: State, e: Enemy, foe: Enemy) {
  const k = ENEMIES[e.kind];
  const at = bodyCenter(foe);
  const dx = foe.pos.x - e.pos.x;
  const dz = foe.pos.z - e.pos.z;
  const d = Math.hypot(dx, dz) || 1e-3;
  const ux = dx / d;
  const uz = dz / d;
  if (e.mode !== "telegraph" && e.mode !== "fire") e.mode = "move";
  turnAt(e, Math.atan2(dx, -dz), TURN[e.kind]);
  const sees = sightOn(e, foe.pos, at);
  switch (e.mode) {
    case "move": {
      let vx: number;
      let vz: number;
      if (!sees) {
        // Out of sight: in by the ground's way, round what stands between.
        const sq = s.squads[e.squad];
        const goal = sq?.foeAt ?? foe.pos;
        const to = dist2d(e.pos, goal) > 3 ? homeStep(s, e, goal) : goal;
        const td = dist2d(e.pos, to) || 1e-3;
        vx = ((to.x - e.pos.x) / td) * k.speed;
        vz = ((to.z - e.pos.z) / td) * k.speed;
      } else {
        const along = e.kind === "charger" || d > k.range + 4 ? 1 : d < k.range - 4 ? -0.7 : 0;
        const side = e.kind === "charger" ? 0.3 : DODGE.strafe;
        vx = (ux * along - uz * e.strafe * side) * k.speed;
        vz = (uz * along + ux * e.strafe * side) * k.speed;
      }
      if (moveBody(e, vx, vz)) e.strafe = -e.strafe;
      else if ((e.strafeT -= TICK) <= 0) {
        e.strafeT = DODGE.every[0] + draw(s, e) * (DODGE.every[1] - DODGE.every[0]);
        if (draw(s, e) < DODGE.flip) e.strafe = -e.strafe;
      }
      e.cooldown -= TICK;
      if (e.kind === "charger") {
        if (e.cooldown <= 0 && d < CHARGER.hitRadius + ENEMIES[foe.kind].radius + 0.4 && Math.abs(foe.pos.y - e.pos.y) < 1.6) {
          e.cooldown = k.cooldown;
          fightHeard(s, e);
          damageRobot(s, foe, k.orbDmg, e);
        }
        break;
      }
      const eye = headOf(e);
      const reach = Math.hypot(at.x - eye.x, at.y - eye.y, at.z - eye.z);
      if (e.cooldown <= 0 && sees && reach < SIGHT[e.kind].range * sightScale(s) * AWARE.engagedRange) {
        e.mode = "telegraph";
        e.timer = k.telegraph;
        leadAim(e, at, foe.vel);
      }
      break;
    }
    case "telegraph": {
      windupStep(e, ux, uz);
      e.timer -= TICK;
      if (sees) leadAim(e, at, foe.vel);
      if (e.timer <= 0) {
        if (sees) {
          e.mode = "fire";
          e.timer = 0;
          e.shotsLeft = k.shots;
        } else {
          e.mode = "move";
          e.cooldown = 0.5;
        }
      }
      break;
    }
    case "fire": {
      windupStep(e, ux, uz);
      e.timer -= TICK;
      if (e.timer <= 0 && e.shotsLeft > 0) {
        if (sees) leadAim(e, at, foe.vel);
        fightHeard(s, e);
        if (k.spread > 0) {
          for (let i = 0; i < k.shots; i++) fireOrb(s, e, ((i - (k.shots - 1) / 2) * k.spread * Math.PI) / 180, false, foe);
          e.shotsLeft = 0;
        } else {
          fireOrb(s, e, 0, false, foe);
          e.shotsLeft--;
          e.timer = k.shotGap;
        }
      }
      if (e.shotsLeft <= 0) {
        e.mode = "move";
        e.cooldown = k.cooldown * (0.8 + draw(s, e) * 0.4);
      }
      break;
    }
  }
}

/**
 * A step through a wind-up or burst: sideways across the line to the target at
 * `DODGE.windup` of its speed (none for the kinds that plant their feet to fire).
 * `ux, uz` is the unit direction to the target.
 */
function windupStep(e: Enemy, ux: number, uz: number) {
  const w = DODGE.windup[e.kind] * ENEMIES[e.kind].speed;
  if (w <= 0) {
    moveBody(e, 0, 0);
    return;
  }
  if (moveBody(e, -uz * e.strafe * w, ux * e.strafe * w)) e.strafe = -e.strafe;
}

/** A plain grunt that is badly hurt and the last of its squad still fighting. */
function hurtAlone(s: State, e: Enemy): boolean {
  if (e.kind !== "grunt" || e.elite) return false;
  const k = ENEMIES.grunt;
  if (e.hp + e.shield > (k.hp + k.shield) * FALLBACK.below) return false;
  return !s.enemies.some((o) => o !== e && o.squad === e.squad && o.aware === "engaged");
}

/** Turn toward a yaw at no more than `rate` radians per second. */
function turnAt(e: Enemy, yaw: number, rate: number) {
  const diff = wrapAngle(yaw - e.yaw);
  const max = rate * TICK;
  e.yaw += Math.max(-max, Math.min(max, diff));
}

/**
 * Where a raider goes round to: the squad's first member holds the front, the others take a
 * spot `ELITE.flankDist` to either side of the player, across the line from that member.
 * Null for the front member, or when the spot is on high ground or a cliff.
 */
function flankSpot(s: State, e: Enemy, known: { x: number; z: number }): Point | null {
  const mates = s.enemies.filter((o) => o.squad === e.squad).sort((a, b) => a.id - b.id);
  const n = mates.indexOf(e);
  if (n <= 0) return null;
  const lead = mates[0];
  const lx = known.x - lead.pos.x;
  const lz = known.z - lead.pos.z;
  const ll = Math.hypot(lx, lz) || 1;
  const side = n % 2 ? 1 : -1;
  const x = known.x + (-lz / ll) * ELITE.flankDist * side;
  const z = known.z + (lx / ll) * ELITE.flankDist * side;
  return steepAt(x, z) || terrainHeight(x, z) > terrainHeight(known.x, known.z) + 1.5 ? null : { x, z };
}

/** Whether the point is inside the cone a robot can fire into. */
function facing(e: Enemy, at: { x: number; z: number }): boolean {
  return Math.abs(wrapAngle(lookAngles(e.pos, { x: at.x, y: 0, z: at.z }).yaw - e.yaw)) < (e.elite ? ELITE.fireCone : AWARE.fireCone) * DEG;
}

/** The target is in the robot's fire cone and in its line of sight. */
function sightOn(e: Enemy, at: { x: number; z: number }, chestAt: Vec3): boolean {
  return facing(e, at) && los(muzzle(e), chestAt);
}

/**
 * Where a member of an engaged squad goes while its squad has the player pinned (see PINCH):
 * a point `PINCH.dist` metres to one side of the spot the squad believes the player is at,
 * across the line from the member that holds the front. Null for that member, for a squad not
 * pinning, and for robots that cannot walk round (posted up high, the titan, heavies). Raiders
 * have their own way round (`flankSpot`).
 */
function pinchSpot(s: State, e: Enemy, known: { x: number; z: number; live: boolean }): Point | null {
  const sq = s.squads[e.squad];
  if (!sq || !sq.engaged || e.elite) return null;
  const mates = s.enemies.filter((o) => o.squad === e.squad && o.mode !== "spawning");
  // A pinch holds only while the squad sees the player: once they are lost, every member chases and sweeps.
  const pinned = known.live && (sq.pinT ?? 0) >= PINCH.after;
  // Backing away in sight: the squad goes round where the player is heading, not where they stand.
  const backing = !pinned && known.live && (sq.backT ?? 0) >= PINCH.retreat;
  // A squad of three or more out between the POIs splits from the start of the fight (see SPLIT).
  const split = known.live && sq.poi < 0 && mates.length >= SPLIT.min && (sq.fightT ?? 0) >= SPLIT.after;
  if (!pinned && !backing && !split) return null;
  if (mates.length < 2) return null;
  const walks = (o: Enemy) => (o.kind === "grunt" || o.kind === "charger" || o.kind === "drone") && (ENEMIES[o.kind].fly > 0 || (onTerrain(o.pos) && o.home.y <= groundLevel(o.home.x, o.home.z) + 0.6));
  if (!walks(e)) return null;
  // The front: a member that cannot go round if there is one, else the first of the squad.
  const lead = mates.find((o) => !walks(o)) ?? [...mates].sort((a, b) => a.id - b.id)[0];
  if (lead === e) return null;
  if (split && !pinned && !backing) return splitSpot(e, lead, mates.filter((o) => o !== lead && walks(o)).sort((a, b) => a.id - b.id), known);
  const n = mates.filter((o) => o !== lead).sort((a, b) => a.id - b.id).indexOf(e);
  const v = sq.vel ?? { x: 0, z: 0 };
  const at = backing ? { x: known.x + v.x * PINCH.lead, z: known.z + v.z * PINCH.lead } : known;
  const lx = at.x - lead.pos.x;
  const lz = at.z - lead.pos.z;
  const ll = Math.hypot(lx, lz) || 1;
  // The first goes round on the side the player is heading for, cutting the retreat off.
  const toward = backing && -lz * v.x + lx * v.z < 0 ? -1 : 1;
  const side = (n % 2 ? -1 : 1) * toward;
  for (const d of [PINCH.dist, PINCH.dist * 0.6]) {
    const x = at.x + (-lz / ll) * d * side;
    const z = at.z + (lx / ll) * d * side;
    if (!steepAt(x, z) && terrainHeight(x, z) <= terrainHeight(known.x, known.z) + 1.5 && !solidAt(x, terrainHeight(x, z) + 1, z)) return { x, z };
  }
  return null;
}

/**
 * Where member `e` of a squad that has split (see SPLIT) goes: none for the second front member of
 * a squad of four or more, which holds the front with `lead`; for the others, in turn on either
 * side, a point `SPLIT.dist` to the side of the spot the player is believed at and `SPLIT.back` of
 * that beyond it, seen from the front. Nearer in, or none, where that is a cliff, high ground or
 * inside something built.
 */
function splitSpot(e: Enemy, lead: Enemy, others: Enemy[], known: Point): Point | null {
  const front = others.length >= 3 ? others.slice(0, 1) : [];
  if (front.includes(e)) return null;
  const n = others.filter((o) => !front.includes(o)).indexOf(e);
  if (n < 0) return null;
  const lx = known.x - lead.pos.x;
  const lz = known.z - lead.pos.z;
  const ll = Math.hypot(lx, lz) || 1;
  const side = n % 2 ? -1 : 1;
  for (const d of [SPLIT.dist, SPLIT.dist * 0.6]) {
    const x = known.x + (-lz / ll) * d * side + (lx / ll) * d * SPLIT.back;
    const z = known.z + (lx / ll) * d * side + (lz / ll) * d * SPLIT.back;
    if (!steepAt(x, z) && terrainHeight(x, z) <= terrainHeight(known.x, known.z) + 1.5 && !solidAt(x, terrainHeight(x, z) + 1, z)) return { x, z };
  }
  return null;
}

/** Turn toward a yaw at a robot's turning speed. */
function turnTo(e: Enemy, yaw: number, rate = 3) {
  e.yaw += wrapAngle(yaw - e.yaw) * Math.min(1, TICK * rate);
}

/** Walk toward a point; returns true once there. */
function walkTo(e: Enemy, to: Point, speed: number, face = true): boolean {
  const dx = to.x - e.pos.x;
  const dz = to.z - e.pos.z;
  const d = Math.hypot(dx, dz);
  if (d < 0.35) {
    moveBody(e, 0, 0);
    return true;
  }
  if (face) turnTo(e, Math.atan2(dx, -dz), 4);
  if (moveBody(e, (dx / d) * speed, (dz / d) * speed)) e.strafe = -e.strafe;
  return false;
}

/** A walker on the island's main walkable ground, which the ground's distance fields cover (hunt.ts). */
const onWalkable = (e: Enemy) => ENEMIES[e.kind].fly === 0 && onTerrain(e.pos) && onMainGround(e.pos.x, e.pos.z);

/**
 * Where a robot heads next on its way to `goal`: straight at it, except that walkers follow
 * the ground's distance field round cliffs, up ramps and round houses: those of a squad beamed
 * in from afar always, and the others of a fighting squad within `PURSUE.reach` of walking
 * (further, or off the open ground, as on a roof or inside a building, they walk straight).
 */
function huntStep(s: State, e: Enemy, goal: Point): Point {
  const routed = !!s.squads[e.squad]?.routed;
  if (ENEMIES[e.kind].fly > 0 || (!routed && (e.aware !== "engaged" || !onWalkable(e)))) return goal;
  const f = fieldTo(goal.x, goal.z, routed ? Infinity : PURSUE.reach);
  return f ? nextStep(f, e.pos.x, e.pos.z, goal) : goal;
}

/**
 * Where a walker of a hunting party on its way to its stop heads next: by the whole world's field
 * toward the stop while on the open ground, straight otherwise. Its fights it fights as any
 * squad does, not as a squad beamed in from afar.
 */
function tripStep(e: Enemy, to: Point): Point {
  if (!onWalkable(e)) return to;
  const f = fieldTo(to.x, to.z);
  return f ? nextStep(f, e.pos.x, e.pos.z, to) : to;
}

/**
 * Where a member of a fighting squad heads on its way to its own point `to` beside the spot
 * `centre` the squad is after (a pursuit or a pinch, `off` metres from the spot at most): far
 * off, by the squad's one field toward the spot, so the squad builds a single field, not one
 * per member; within `off` + 6 m of its point, straight at it. A squad beamed in from afar
 * follows a field to the point itself.
 */
function sideStep(s: State, e: Enemy, to: Point, centre: Point, off: number): Point {
  if (s.squads[e.squad]?.routed) return huntStep(s, e, to);
  return to === centre || dist2d(e.pos, to) > off + 6 ? huntStep(s, e, centre) : to;
}

/** A robot this far from its post, or from the leg of its patrol it walks, has strayed (a chase took it off). */
const STRAY = 12;

/**
 * Where a robot that has strayed from its post or its patrol heads on its way back: by the
 * ground's way once it is on the open ground, straight otherwise. A squad beamed in from afar
 * has no post to go back to and walks straight. One drawn further than a short field reaches
 * finds its way by the whole world's.
 */
function homeStep(s: State, e: Enemy, to: Point): Point {
  if (s.squads[e.squad]?.routed || !onWalkable(e)) return to;
  let f = fieldTo(to.x, to.z, PURSUE.reach);
  if (f && !Number.isFinite(routeLength(f, e.pos.x, e.pos.z))) f = fieldTo(to.x, to.z);
  return f ? nextStep(f, e.pos.x, e.pos.z, to) : to;
}

/** Distance from (x, z) to the segment from a to b. */
function toSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const l2 = dx * dx + dz * dz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2)) : 0;
  return Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t);
}

/*
 * Each squad's robots, in the order of `s.enemies`, for `calm()`, which asks for them once per
 * member every tick. `s.enemies` changes only by a push (a robot spawned) or by a new list (one
 * destroyed), and a robot never changes squad, so the lists hold until its length or identity
 * changes.
 */
let membersFrom: Enemy[] | null = null;
let membersLength = -1;
const bySquad = new Map<number, Enemy[]>();
const NO_MEMBERS: Enemy[] = [];
/** The robots of squad `squad`, as `s.enemies.filter((o) => o.squad === squad)` gives them. Read only. */
function squadMembers(s: State, squad: number): readonly Enemy[] {
  if (membersFrom !== s.enemies || membersLength !== s.enemies.length) {
    membersFrom = s.enemies;
    membersLength = s.enemies.length;
    bySquad.clear();
    for (const o of s.enemies) {
      const list = bySquad.get(o.squad);
      if (list) list.push(o);
      else bySquad.set(o.squad, [o]);
    }
  }
  return bySquad.get(squad) ?? NO_MEMBERS;
}

/** Out of combat: hold the post or walk the patrol; when alerted, go and look. */
function calm(s: State, e: Enemy) {
  const k = ENEMIES[e.kind];
  const slow = k.speed * AWARE.idleSpeed;
  e.lookT += TICK;
  // A wind-up or burst at a foe that is gone ends here.
  if (e.mode !== "move" && e.mode !== "spawning") e.mode = "move";
  if (e.aware === "alert" && e.poi >= 0 && POIS[e.poi].boss) {
    // The boss arena holds its ground: it looks, but does not leave.
    e.searchT -= TICK;
    if (e.goal) turnTo(e, Math.atan2(e.goal.x - e.pos.x, -(e.goal.z - e.pos.z)), 2);
    if (dist2d(e.pos, e.home) > 0.8) walkTo(e, e.home, slow, false);
    else moveBody(e, 0, 0);
    if (e.searchT <= 0) e.aware = "idle";
    return;
  }
  if (e.aware === "alert") {
    e.searchT -= TICK;
    // A squad sent after the player (see SWEEP) goes at nearly its fighting speed.
    if (e.goal && dist2d(e.pos, e.goal) > 2.5) walkTo(e, huntStep(s, e, e.goal), s.squads[e.squad]?.sweep ? k.speed * SWEEP.pace : slow * 1.4);
    else {
      moveBody(e, 0, 0);
      e.yaw += Math.sin(e.lookT * 1.3) * TICK * 1.6; // looking around
    }
    if (e.searchT <= 0) {
      e.aware = "idle";
      e.goal = null;
    }
    return;
  }
  const sq = s.squads[e.squad];
  if (sq?.walk) {
    // A salvage crew or the retake squad walks to its point as a party walks to its stop, and
    // stands there looking round until the raid gives it another (world.ts).
    const members = squadMembers(s, e.squad);
    const slot = members.indexOf(e);
    const to = { x: sq.walk.x + (slot % 2 ? 1.6 : -1.6) * Math.min(slot, 1), z: sq.walk.z + slot * 1.4 };
    const pace = Math.min(...members.map((o) => ENEMIES[o.kind].speed)) * (sq.crew ? CREW.pace : PARTY.pace);
    if (dist2d(e.pos, to) > 0.8) walkTo(e, tripStep(e, to), pace);
    else {
      moveBody(e, 0, 0);
      e.yaw += Math.sin(e.lookT * 0.7) * TICK * 0.9;
    }
    return;
  }
  if (sq?.party) {
    // A hunting party walks to its stop by the ground's way, the first living member leading and
    // the others beside it, all at the pace of the slowest; there it stands and looks round
    // until stepParties() sends it on.
    const members = squadMembers(s, e.squad);
    const slot = members.indexOf(e);
    const stop = PARTY_STOPS[sq.party.region][sq.party.stop];
    const to = { x: stop.x + (slot % 2 ? 1.6 : -1.6) * Math.min(slot, 1), z: stop.z + slot * 1.4 };
    const pace = Math.min(...members.map((o) => ENEMIES[o.kind].speed)) * PARTY.pace;
    if (dist2d(e.pos, to) > 0.8) walkTo(e, tripStep(e, to), pace);
    else {
      moveBody(e, 0, 0);
      e.yaw += Math.sin(e.lookT * 0.7) * TICK * 0.9;
    }
    return;
  }
  if (sq?.ambush) {
    // Waiting at a choke point for the player (see AMBUSH): there by the ground's way, then still, facing their side.
    const members = squadMembers(s, e.squad);
    const slot = members.indexOf(e);
    const to = { x: sq.ambush.at.x + (slot % 2 ? 2.2 : -2.2) * Math.min(slot, 1), z: sq.ambush.at.z + slot * 1.8 };
    if (dist2d(e.pos, to) > 1) walkTo(e, dist2d(e.pos, to) > STRAY ? homeStep(s, e, to) : to, slow * 1.6);
    else {
      moveBody(e, 0, 0);
      turnTo(e, sq.ambush.face + Math.sin(e.lookT * 0.5) * 0.4, 2);
    }
    return;
  }
  if (sq && sq.patrol.length && e.kind !== "titan") {
    // The first living member leads; the others follow at an offset.
    const members = squadMembers(s, e.squad);
    const slot = members.indexOf(e);
    const wp = sq.patrol[sq.leg % sq.patrol.length];
    const to = { x: wp.x + (slot % 2 ? 1.6 : -1.6) * Math.min(slot, 1), z: wp.z + slot * 1.4 };
    // The authored legs are walked straight; a robot a chase took off its leg finds its way back.
    const prev = sq.patrol[(sq.leg + sq.patrol.length - 1) % sq.patrol.length];
    const via = toSegment(e.pos, prev, to) > STRAY ? homeStep(s, e, to) : to;
    if (walkTo(e, via, sq.pack ? k.speed * PACK.pace : slow) && via === to && slot === 0) sq.leg++;
    return;
  }
  if (dist2d(e.pos, e.home) > 0.8) walkTo(e, dist2d(e.pos, e.home) > STRAY ? homeStep(s, e, e.home) : e.home, slow);
  else {
    moveBody(e, 0, 0);
    turnTo(e, e.face + Math.sin(e.lookT * 0.45) * 0.7, 1.5);
  }
}

/**
 * Whether a straight walk from `from` to the cover spot stays on the spot's floor: a robot
 * up on a deck or a roof stops at an edge rather than step off it, and would never get there.
 */
function sameFloor(from: Vec3, c: CoverPoint): boolean {
  // On the ground both ends, the walk follows the ground, slopes included.
  if (onTerrain(from) && Math.abs(c.y - groundLevel(c.x, c.z)) < 0.3) return true;
  const d = Math.hypot(c.x - from.x, c.z - from.z);
  const n = Math.ceil(d / 0.5);
  for (let i = 1; i < n; i++) {
    const x = from.x + ((c.x - from.x) * i) / n;
    const z = from.z + ((c.z - from.z) * i) / n;
    if (Math.abs(groundAt(x, z, 0.3, c.y + 0.3) - c.y) > COVER.level) return false;
  }
  return true;
}

/** Find a spot near this grunt that hides it from the player, with a spot beside it to shoot from. */
function findCover(s: State, e: Enemy, threat: Point, threatY: number): { cover: Point; peek: Point } | null {
  // Hurt and alone it looks further for a place to hide.
  const search = hurtAlone(s, e) ? COVER.search * 1.5 : COVER.search;
  const p = { pos: { x: threat.x, y: threatY, z: threat.z } };
  const head = { x: p.pos.x, y: p.pos.y + 1.5, z: p.pos.z };
  const chestP = { x: p.pos.x, y: p.pos.y + 1.1, z: p.pos.z };
  const taken = s.enemies.filter((o) => o !== e && o.cover).map((o) => o.cover!);
  const cands = coversNear(e.pos.x, e.pos.z, search)
    .map((c) => ({ c, d: dist2d(c, e.pos), dp: dist2d(c, p.pos) }))
    .filter(({ c, d, dp }) => d < search && Math.abs(c.y - e.pos.y) < COVER.level && dp > COVER.minFromPlayer && dp < COVER.maxFromPlayer && !taken.some((t) => dist2d(t, c) < 1.5))
    .sort((a, b) => a.d + Math.abs(a.dp - 16) * 0.3 - (b.d + Math.abs(b.dp - 16) * 0.3))
    .slice(0, 14);
  for (const { c } of cands) {
    if (los({ x: c.x, y: c.y + COVER.tall, z: c.z }, head)) continue;
    if (!sameFloor(e.pos, c)) continue;
    // The side it did not show itself at last time first, so it is not where the player's sights wait.
    for (const sign of [e.peekSide, -e.peekSide]) {
      const peek = { x: c.x + c.tx * sign * COVER.peek, z: c.z + c.tz * sign * COVER.peek };
      const pg = c.y;
      // Stepping out stays on the same floor: not off a deck's or a roof's edge, not into a box.
      if (Math.abs(groundAt(peek.x, peek.z, 0.3, pg + 0.3) - pg) > 0.3) continue;
      if (solidAt(peek.x, pg + 1.0, peek.z)) continue;
      if (los({ x: peek.x, y: pg + 1.6, z: peek.z }, chestP)) return { cover: { x: c.x, z: c.z }, peek };
    }
  }
  return null;
}

/**
 * An engaged grunt on the ground: hide behind cover, step out to shoot, step
 * back. Returns false when it has no cover and should fight in the open.
 */
function fromCover(s: State, e: Enemy, known: { x: number; z: number; live: boolean }, tChest: Vec3, tUp: boolean, tVel: Vec3): boolean {
  const k = ENEMIES.grunt;
  if (e.mode !== "move") return false; // telegraph and fire run as usual
  // It hides from a player it has found; one it has not found (see located()) it comes out to look for.
  if (e.target === "player" && !located(s, e)) return false;
  // Its first burst it fires from where it stands, strafing, if it sees its target: a squad that
  // ran for cover before shooting would give a player standing in the open seconds for free.
  if (e.opener && known.live && tUp && facing(e, tChest) && los(muzzle(e), tChest)) return false;
  e.coverT -= TICK;
  // Re-think the spot every few seconds, and at once when hit (flanked).
  if (e.coverT <= 0 || e.lastHit < TICK * 1.5) {
    const found = findCover(s, e, known, tChest.y - 1.1);
    e.cover = found?.cover ?? null;
    e.peek = found?.peek ?? null;
    e.coverT = 2.5;
  }
  if (!e.cover || !e.peek) return false;
  e.cooldown -= TICK;
  const out = e.cooldown <= 0;
  const to = out ? e.peek : e.cover;
  if (!e.stuckTo || dist2d(e.stuckTo, to) > 0.01) {
    e.stuckTo = { ...to };
    e.stuckT = 0;
  }
  const before = dist2d(e.pos, to);
  const arrived = walkTo(e, to, k.speed, false);
  // Getting no closer for a while (not just the first steps, while it speeds up from standing):
  // a spot it is pressed against but cannot reach, a corner its body does not fit past, counts as reached.
  e.stuckT = before - dist2d(e.pos, to) < k.speed * TICK * COVER.stuck.progress ? e.stuckT + TICK : 0;
  const there = arrived || e.stuckT >= COVER.stuck.time;
  // Behind its cover it crouches, so cover lower than itself hides all of it (DUCK); stepping out it stands.
  if (!out && there) e.duck = Math.min(1, e.duck + 2 * DUCK.rate * TICK);
  const shows = out && known.live && tUp && facing(e, tChest) && los({ ...e.pos, y: e.pos.y + weakY(e) }, tChest);
  // Stepping out, it winds up as soon as it has the target in sight, before it reaches the spot.
  if (out && (there || shows)) {
    if (shows) {
      e.mode = "telegraph";
      e.timer = k.telegraph;
      // Through the wind-up it keeps stepping out, away from its cover, not back behind it.
      const ox = e.peek.x - e.cover.x;
      const oz = e.peek.z - e.cover.z;
      e.strafe = -(tChest.z - e.pos.z) * ox + (tChest.x - e.pos.x) * oz >= 0 ? 1 : -1;
      leadAim(e, tChest, tVel);
      s.events.push({ t: "telegraph", id: e.id });
    } else {
      // The player moved out of that angle, or this side shows nothing: find another spot, trying the other side first.
      e.peekSide = -e.peekSide;
      e.coverT = 0;
      e.cooldown = 0.4;
    }
  }
  return true;
}

/** Keep walkers from stacking into one blob. */
/** Coarse cells for `separate()`: robots more than a cell apart cannot touch. */
const SEP_CELL = 8;
/** Each walker's cell for `separate()`, kept between ticks so a tick allocates none. */
let sepX = new Int32Array(256);
let sepZ = new Int32Array(256);
function separate(s: State) {
  const list = s.enemies.filter((e) => ENEMIES[e.kind].fly === 0 && e.mode !== "spawning");
  const pair = (a: Enemy, b: Enemy) => {
    const r = ENEMIES[a.kind].radius + ENEMIES[b.kind].radius;
    const dx = b.pos.x - a.pos.x;
    const dz = b.pos.z - a.pos.z;
    const d = Math.hypot(dx, dz);
    // Robots on different floors (a tower's tiers) do not touch.
    if (d >= r || d < 1e-4 || Math.abs(a.pos.y - b.pos.y) > 1) return;
    const push = (r - d) / 2;
    nudge(a, (-dx / d) * push, (-dz / d) * push);
    nudge(b, (dx / d) * push, (dz / d) * push);
  };
  // The cells are fixed before any robot is nudged.
  const n = list.length;
  if (sepX.length < n) {
    sepX = new Int32Array(n * 2);
    sepZ = new Int32Array(n * 2);
  }
  let whole = true;
  for (let i = 0; i < n; i++) {
    const x = Math.floor(list[i].pos.x / SEP_CELL);
    const z = Math.floor(list[i].pos.z / SEP_CELL);
    // A cell that is not a small whole number (a robot off the world, or not a number) is not kept as one.
    if (!(Math.abs(x) < 1e9 && Math.abs(z) < 1e9)) whole = false;
    sepX[i] = x;
    sepZ[i] = z;
  }
  if (!whole) {
    const cx = list.map((e) => Math.floor(e.pos.x / SEP_CELL));
    const cz = list.map((e) => Math.floor(e.pos.z / SEP_CELL));
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        if (Math.abs(cx[i] - cx[j]) > 1 || Math.abs(cz[i] - cz[j]) > 1) continue;
        pair(list[i], list[j]);
      }
    return;
  }
  for (let i = 0; i < n; i++) {
    const xi = sepX[i];
    const zi = sepZ[i];
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(xi - sepX[j]) > 1 || Math.abs(zi - sepZ[j]) > 1) continue;
      pair(list[i], list[j]);
    }
  }
}

/** Shift a walker sideways, but never into a wall or off the floor it stands on. */
function nudge(e: Enemy, dx: number, dz: number) {
  const k = ENEMIES[e.kind];
  const bx = e.pos.x;
  const bz = e.pos.z;
  e.pos.x += dx;
  e.pos.z += dz;
  collide(e.pos, k.radius, bodyHeight(k));
  // A crowd at the camp's gate does not shove its front robot in (the same line as `moveBody()`).
  const intoCamp = inCamp(e.pos, k.radius + 0.5) && !inCamp({ x: bx, z: bz }, k.radius + 0.5);
  if (intoCamp || Math.abs(groundAt(e.pos.x, e.pos.z, k.radius, e.pos.y) - e.pos.y) > 0.3) {
    e.pos.x = bx;
    e.pos.z = bz;
  }
}

function titan(s: State, e: Enemy, d: number) {
  const k = ENEMIES.titan;
  const total = (e.hp + e.shield) / (k.hp + k.shield);
  const enraged = total < TITAN.enrageAt;
  if (enraged && !(e.summoned & 4)) {
    e.summoned |= 4;
    s.events.push({ t: "bossPhase" });
  }
  TITAN.summonAt.forEach((at, i) => {
    const bit = 1 << i;
    if (total < at && !(e.summoned & bit)) {
      e.summoned |= bit;
      for (let j = 0; j < 3; j++) {
        const a = e.yaw + (j - 1) * 1.1;
        const d = spawnEnemy(s, "drone", e.pos.x + Math.sin(a) * 9, e.pos.z - Math.cos(a) * 9, e.poi, e.squad, { appear: true });
        d.aware = "engaged";
        d.detect = 1;
      }
    }
  });
  const pace = enraged ? 0.7 : 1;
  const p = s.player;
  switch (e.mode) {
    case "move": {
      const ux = (p.pos.x - e.pos.x) / d;
      const uz = (p.pos.z - e.pos.z) / d;
      const along = d > k.range + 3 ? 1 : d < k.range - 6 ? -0.5 : 0;
      moveBody(e, (ux * along - uz * e.strafe * 0.4) * k.speed, (uz * along + ux * e.strafe * 0.4) * k.speed);
      e.cooldown -= TICK;
      if (e.cooldown <= 0 && p.downed <= 0) {
        // Alternate: stomp when close enough, otherwise rockets.
        const stomp = d < TITAN.stompRange - 4 && e.shotsLeft !== -1;
        if (stomp) {
          e.mode = "stomp";
          e.timer = TITAN.stompTelegraph * pace;
          s.events.push({ t: "stompTelegraph", id: e.id });
        } else {
          e.mode = "telegraph";
          e.timer = k.telegraph * pace;
          lockAim(e, chest(s));
          s.events.push({ t: "telegraph", id: e.id });
        }
      }
      break;
    }
    case "stomp": {
      moveBody(e, 0, 0);
      e.timer -= TICK;
      if (e.timer <= 0) {
        s.waves.push({ x: e.pos.x, z: e.pos.z, y: e.pos.y, r: k.radius, hit: false });
        s.events.push({ t: "stomp", x: e.pos.x, z: e.pos.z });
        e.shotsLeft = -1; // next attack is rockets
        e.mode = "move";
        e.cooldown = k.cooldown * pace;
      }
      break;
    }
    case "telegraph": {
      moveBody(e, 0, 0);
      e.timer -= TICK;
      lockAim(e, chest(s));
      if (e.timer <= 0) {
        e.mode = "fire";
        e.timer = 0;
        e.shotsLeft = enraged ? k.shots + 4 : k.shots;
      }
      break;
    }
    case "fire": {
      moveBody(e, 0, 0);
      e.timer -= TICK;
      if (e.timer <= 0 && e.shotsLeft > 0) {
        lockAim(e, chest(s));
        const n = e.shotsLeft;
        fireOrb(s, e, (n % 2 ? 1 : -1) * (0.25 + (n % 3) * 0.12), true);
        e.shotsLeft--;
        e.timer = k.shotGap;
      }
      if (e.shotsLeft <= 0) {
        e.shotsLeft = 0;
        e.mode = "move";
        e.cooldown = k.cooldown * pace;
      }
      break;
    }
    default:
      e.mode = "move";
  }
}

/** Distance from `pt` to a body's axis: the vertical segment from `y0` to `y0 + h` at (x, z). */
function axisDist(pt: Vec3, x: number, z: number, y0: number, h: number): number {
  const cy = Math.max(y0, Math.min(y0 + h, pt.y));
  return Math.hypot(pt.x - x, pt.y - cy, pt.z - z);
}

/**
 * Where the segment a→b first comes within `r` of a body standing at `at` (its axis the vertical
 * segment from knee, 0.4 m, to `top` above its feet), or null if it never does. `s` is how far
 * along a→b (0 to 1) that is, so of two bodies the one the orb enters first can take the hit. The
 * distance to the axis is convex along the segment: the closest approach is found exactly, and
 * the entry before it by halving, so a fast bolt that only grazes a body still hits.
 */
function sweptHit(a: Vec3, b: Vec3, r: number, at: Vec3, top: number): { at: Vec3; s: number } | null {
  // Bolt: a + d·s, s in [0, 1]. Body axis: q + (0, h, 0)·t, t in [0, 1].
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const qy = at.y + 0.4;
  const h = Math.max(0, top - 0.4);
  const wx = a.x - at.x;
  const wy = a.y - qy;
  const wz = a.z - at.z;
  const dd = dx * dx + dy * dy + dz * dz;
  const de = dy * h; // d·e with e = (0, h, 0)
  const ee = h * h;
  const dw = dx * wx + dy * wy + dz * wz;
  const ew = h * wy;
  const den = dd * ee - de * de;
  let sP = den > 1e-9 ? (de * ew - ee * dw) / den : 0;
  sP = Math.max(0, Math.min(1, sP));
  let tP = ee > 1e-9 ? (de * sP + ew) / ee : 0;
  if (tP < 0 || tP > 1) {
    tP = Math.max(0, Math.min(1, tP));
    sP = dd > 1e-9 ? Math.max(0, Math.min(1, (de * tP - dw) / dd)) : 0;
  }
  const point = (k: number): Vec3 => ({ x: a.x + dx * k, y: a.y + dy * k, z: a.z + dz * k });
  const dist = (k: number) => axisDist(point(k), at.x, at.z, qy, h);
  if (dist(sP) >= r) return null;
  if (dist(0) < r) return { at: point(0), s: 0 };
  // Outside at 0, inside at sP: halve to the surface (2^-20 of a tick's travel is far below a millimetre).
  let lo = 0;
  let hi = sP;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (dist(mid) < r) hi = mid;
    else lo = mid;
  }
  return { at: point(hi), s: hi };
}

export function stepOrbs(s: State) {
  const p = s.player;
  const c = chest(s);
  // A hit can wipe the squad, and wipe() clears the air; do not write the old list back over it.
  const wipes = s.stats.wipes;
  // The robots a shot at the other faction may hit, by 8 m square, gathered once there is such a shot (see FACTION).
  let targets: Map<number, Enemy[]> | null = null;
  const square = (x: number, z: number) => (Math.floor(x / 8) + 4096) * 8192 + (Math.floor(z / 8) + 4096);
  const robotsNear = (x: number, z: number): Enemy[] => {
    if (!targets) {
      targets = new Map();
      for (const v of s.enemies) {
        if (v.poi >= 0 || v.kind === "titan" || v.mode === "spawning") continue;
        const k = square(v.pos.x, v.pos.z);
        const l = targets.get(k);
        if (l) l.push(v);
        else targets.set(k, [v]);
      }
    }
    const out: Enemy[] = [];
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) out.push(...(targets.get(square(x + dx * 8, z + dz * 8)) ?? []));
    return out;
  };
  const kept = s.orbs.filter((o) => {
    // Once a hit has wiped the squad, the rest of the air is gone: nothing may hit the team at the entry.
    if (s.stats.wipes !== wipes) return false;
    if (o.homing) {
      // Turn the velocity toward the player a little each tick.
      const sp = Math.hypot(o.vel.x, o.vel.y, o.vel.z);
      const tx = c.x - o.pos.x;
      const ty = c.y - o.pos.y;
      const tz = c.z - o.pos.z;
      const tl = Math.hypot(tx, ty, tz) || 1;
      const k = TITAN.homing * TICK;
      o.vel.x += ((tx / tl) * sp - o.vel.x) * k;
      o.vel.y += ((ty / tl) * sp - o.vel.y) * k;
      o.vel.z += ((tz / tl) * sp - o.vel.z) * k;
    }
    o.pos.x += o.vel.x * TICK;
    o.pos.y += o.vel.y * TICK;
    o.pos.z += o.vel.z * TICK;
    o.life -= TICK;
    // The player and the teammate as vertical capsules from knee to head, tested along the whole
    // stretch the orb covered this tick (a fast bolt moves further than a body is wide), before
    // the ground or a wall ends it: a body is hit only if neither stands between where the orb was
    // and where it enters the body, so a bolt that meets a body and then the ground in one tick hits.
    const from = { x: o.pos.x - o.vel.x * TICK, y: o.pos.y - o.vel.y * TICK, z: o.pos.z - o.vel.z * TICK };
    const clear = (to: Vec3) => los(from, to) && los({ ...from, y: from.y - o.r }, { ...to, y: to.y - o.r });
    // Whichever body the orb enters first along its way this tick takes the hit.
    const onPlayer = sweptHit(from, o.pos, o.r + PLAYER.radius, p.pos, p.crouch || p.sliding ? 1.1 : 1.7);
    const onAlly = allyUp(s) ? sweptHit(from, o.pos, o.r + ALLY.radius, s.ally.pos, 1.7) : null;
    const playerHit = onPlayer && clear(onPlayer.at) ? onPlayer : null;
    const allyHit = onAlly && clear(onAlly.at) ? onAlly : null;
    // A shot at the other faction hits its robots too: the first body along the way takes it.
    let robot: { v: Enemy; s: number } | null = null;
    if (o.by !== undefined)
      for (const v of robotsNear(o.pos.x, o.pos.z)) {
        if (!!v.rogue === !!o.rogue || !s.enemies.includes(v)) continue;
        const k = ENEMIES[v.kind];
        const h = sweptHit(from, o.pos, o.r + k.radius, v.pos, bodyHeight(k));
        if (h && (!robot || h.s < robot.s) && clear(h.at)) robot = { v, s: h.s };
      }
    if (robot && (!playerHit || robot.s < playerHit.s) && (!allyHit || robot.s < allyHit.s)) {
      damageRobot(s, robot.v, o.dmg, s.enemies.find((e) => e.id === o.by) ?? null);
      return false;
    }
    if (allyHit && (!playerHit || allyHit.s < playerHit.s)) {
      hurtAlly(s, o.dmg);
      return false;
    }
    if (playerHit) {
      hurtPlayer(s, o.dmg, o.pos.x - o.vel.x, o.pos.z - o.vel.z);
      return false;
    }
    if (o.life <= 0 || o.pos.y < terrainHeight(o.pos.x, o.pos.z)) return false;
    // A wall stops an orb that meets it with its centre or its lower edge, so one that would only graze the top of a low wall does not pass over it.
    if (!clear(o.pos)) return false;
    return true;
  });
  if (s.stats.wipes === wipes) s.orbs = kept;
}

export function stepWaves(s: State) {
  const p = s.player;
  const wipes = s.stats.wipes;
  const kept = s.waves.filter((w) => {
    if (s.stats.wipes !== wipes) return false;
    w.r += TITAN.stompSpeed * TICK;
    const d = Math.hypot(p.pos.x - w.x, p.pos.z - w.z);
    if (!w.hit && Math.abs(d - w.r) < 0.9 && p.pos.y < w.y + TITAN.stompHeight) {
      w.hit = true;
      hurtPlayer(s, TITAN.stompDmg, w.x, w.z);
    }
    const a = s.ally;
    const da = Math.hypot(a.pos.x - w.x, a.pos.z - w.z);
    // The wave passes the teammate once. It never jumps, but standing up high clears the wave like the player.
    if (allyUp(s) && Math.abs(da - w.r) < 0.9 && a.pos.y < w.y + TITAN.stompHeight && !w.allyHit) {
      w.allyHit = true;
      hurtAlly(s, TITAN.stompDmg);
    }
    return w.r < TITAN.stompRange;
  });
  if (s.stats.wipes === wipes) s.waves = kept;
}

