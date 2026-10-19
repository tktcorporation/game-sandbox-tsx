import { AWARE, DEG, ENEMIES, FLANK, NOISE, PINCH, PURSUE, SIGHT, TICK } from "./config";
import { dist2d, los, lookAngles, solidAt, wrapAngle } from "./geom";
import { steepAt, terrainHeight } from "./terrain";
import type { Enemy, Point, State, Vec3 } from "./state";

/*
 * What robots know about the player: sight that fills slowly, sounds that make
 * them come and look, and squads that start fighting together.
 */

export const headOf = (e: Enemy): Vec3 => ({ x: e.pos.x, y: e.pos.y + Math.max(ENEMIES[e.kind].weakY, 0.2), z: e.pos.z });

/** The player is a valid target for robots: on the ground and not knocked down. */
const visibleNow = (s: State) => s.phase === "play" && s.player.downed <= 0;

/**
 * Whether another squad may start fighting (see AWARE.maxSquads). The boss
 * squad is never held back, and a robot the player walks up to always joins.
 */
export function mayEngage(s: State, e: Enemy): boolean {
  if (s.squads[e.squad]?.engaged || e.kind === "titan") return true;
  if (dist2d(e.pos, s.player.pos) < AWARE.joinClose) return true;
  let fighting = 0;
  for (let i = 0; i < s.squads.length; i++) if (s.squads[i].engaged && s.enemies.some((o) => o.squad === i)) fighting++;
  return fighting < AWARE.maxSquads;
}

/**
 * `from` is where a fight the player did not start came from (the teammate's shot or sound):
 * the squad turns there and has not seen the player until a member does.
 */
export function engageSquad(s: State, squad: number, by: Enemy, from?: { x: number; z: number }) {
  const sq = s.squads[squad];
  if (!sq || sq.engaged) return;
  sq.engaged = true;
  sq.sinceSeen = from ? AWARE.trackTime : 0;
  sq.chaseT = 0;
  sq.last = from ? { x: from.x, z: from.z } : { x: s.player.pos.x, z: s.player.pos.z };
  // The player's motion from an earlier fight says nothing about where they go now.
  sq.vel = undefined;
  sq.pin = { ...sq.last };
  sq.pinT = 0;
  sq.backT = 0;
  sq.chase = sq.chaseDir = undefined;
  sq.hold = 0;
  // Each member gets a moment to react, the nearest to the player first (AWARE.react), and opens fire from where it stands.
  const byNear = chasers(s, squad).sort((a, b) => dist2d(a.pos, s.player.pos) - dist2d(b.pos, s.player.pos));
  byNear.forEach((e, n) => {
    e.aware = "engaged";
    e.detect = 1;
    e.goal = null;
    e.opener = true;
    e.cooldown = Math.max(e.cooldown, AWARE.react[0] + AWARE.react[1] * n);
  });
  for (const e of s.enemies) {
    if (e.squad !== squad || e.mode !== "spawning") continue;
    e.aware = "engaged";
    e.detect = 1;
    e.goal = null;
  }
  s.events.push({ t: "engage", squad, id: by.id });
}

/** Send a squad to look at a spot (the "?" state). */
export function alertSquad(s: State, squad: number, x: number, z: number, by: Enemy) {
  if (by.aware === "idle") s.events.push({ t: "suspect", id: by.id });
  for (const e of s.enemies) {
    if (e.squad !== squad || e.aware === "engaged") continue;
    e.aware = "alert";
    e.goal = { x, z };
    e.searchT = AWARE.searchTime;
    e.detect = Math.max(e.detect, AWARE.suspicious);
  }
}

/**
 * A sound at (x, z) carrying `radius` metres. Robots inside it come to look;
 * close ones that can see the spot engage at once. Gunfire carries further to the
 * squads out on the roads (NOISE.roamMult); footsteps and searching do not.
 * `player` is false for the teammate's sounds: they do not tell where the player is. `y` is the
 * height of whoever made the sound, which sight to it is tested against.
 */
export function makeNoise(s: State, x: number, z: number, radius: number, gunfire = false, player = true, y = s.player.pos.y) {
  const spot = { x, y: y + 1.2, z };
  // A squad fighting the player that has lost them hears where they are now (see PURSUE).
  if (player)
    s.squads.forEach((sq, i) => {
      if (sq.engaged && sq.sinceSeen >= AWARE.trackTime && s.enemies.some((e) => e.squad === i && dist2d(e.pos, spot) < radius * PURSUE.hear)) learnSpot(s, i, x, z);
    });
  const alerted = new Set<number>();
  for (const e of s.enemies) {
    if (e.aware === "engaged" || e.mode === "spawning") continue;
    const d = dist2d(e.pos, spot);
    if (d > radius * (gunfire && s.squads[e.squad]?.roam ? NOISE.roamMult : 1)) continue;
    if (d < radius * NOISE.engageInside && los(headOf(e), spot) && mayEngage(s, e)) engageSquad(s, e.squad, e, player ? undefined : { x, z });
    else if (!alerted.has(e.squad)) {
      alerted.add(e.squad);
      alertSquad(s, e.squad, x, z, e);
    }
  }
}

/**
 * Update one robot's view of the player. Returns true if it sees the player now.
 * Idle and alert robots fill their detection; at full the squad engages.
 */
export function sense(s: State, e: Enemy): boolean {
  const p = s.player;
  const sq = s.squads[e.squad];
  let seen = false;
  if (visibleNow(s)) {
    const low = p.crouch && !p.sliding;
    const target = { x: p.pos.x, y: p.pos.y + (low ? 1.0 : 1.5), z: p.pos.z };
    const eye = headOf(e);
    const d = Math.hypot(target.x - eye.x, target.y - eye.y, target.z - eye.z);
    const sight = SIGHT[e.kind];
    const engaged = e.aware === "engaged";
    const range = sight.range * (engaged ? AWARE.engagedRange : low ? AWARE.crouchRange : 1);
    let inView = d < AWARE.closeSense;
    if (!inView && d < range) {
      const fov = sight.fov * (engaged ? AWARE.engagedFov : 1);
      inView = Math.abs(wrapAngle(lookAngles(e.pos, target).yaw - e.yaw)) < (fov / 2) * DEG;
    }
    seen = inView && los(eye, target);
    // A fighting robot that has lost the player, or never had them itself, takes a moment
    // to find them again; one that is not fighting yet is filling its detection instead.
    if (!seen) e.finding = 0;
    else {
      if (engaged && !located(s, e) && d >= AWARE.closeSense) e.finding += (TICK / ((AWARE.fillNear + AWARE.fillFar * (d / range)) * AWARE.locate)) * (low ? AWARE.crouchRate : 1);
      else e.finding = 1;
      if (e.finding >= 1) {
        e.blind = 0;
        e.sawAt = { x: p.pos.x, z: p.pos.z };
        e.finding = 0;
      }
    }
    if (seen && !engaged) {
      const rate = (1 / (AWARE.fillNear + AWARE.fillFar * (d / range))) * (low ? AWARE.crouchRate : 1) * (e.aware === "alert" ? 1.6 : 1);
      e.detect = Math.min(1, e.detect + rate * TICK);
      if (e.detect >= 1 && !mayEngage(s, e)) e.detect = 0.95;
      if (e.detect >= 1) engageSquad(s, e.squad, e);
      else if (e.detect >= AWARE.suspicious) {
        if (e.aware === "idle") alertSquad(s, e.squad, p.pos.x, p.pos.z, e);
        e.goal = { x: p.pos.x, z: p.pos.z };
        e.searchT = AWARE.searchTime;
      }
    }
    if (seen && engaged && sq) {
      sq.sinceSeen = 0;
      sq.hold = 0;
      sq.chaseT = 0;
      sq.last = { x: p.pos.x, z: p.pos.z };
      sq.vel = { x: p.vel.x, z: p.vel.z };
      sq.chase = sq.chaseDir = undefined;
    }
  }
  if (!seen && e.aware !== "engaged") e.detect = Math.max(0, e.detect - AWARE.decay * TICK);
  return seen;
}

/**
 * Whether this robot itself knows where the player is: it saw them or was hit by them
 * within `FLANK.blindTime`, or since then the player has stayed within `FLANK.moved` of
 * where it saw them (it ducked behind cover; they did not go anywhere) for no longer than
 * `AWARE.loseTime`, after which what it saw is too old to act on. A fighting robot
 * that has not located the player moves on what its squad knows but holds its fire, and
 * the player's shots on it are an ambush.
 */
export const located = (s: State, e: Enemy) =>
  e.blind < FLANK.blindTime ||
  (!!e.sawAt && e.blind < AWARE.loseTime && dist2d(e.sawAt, s.player.pos) < FLANK.moved) ||
  // A charger runs at whom its squad points it at: it has no time to find them itself before it lunges.
  (e.kind === "charger" && e.aware === "engaged" && (s.squads[e.squad]?.sinceSeen ?? 99) < AWARE.trackTime);

/**
 * Where a fighting robot believes the player is: the true position while its squad
 * has eyes on them, else where the squad is going after them (see PURSUE).
 */
export function knownSpot(s: State, e: Enemy): { x: number; z: number; live: boolean } {
  const sq = s.squads[e.squad];
  if (!sq || sq.sinceSeen < AWARE.trackTime) return { x: s.player.pos.x, z: s.player.pos.z, live: true };
  const at = sq.chase ?? sq.last;
  return { x: at.x, z: at.z, live: false };
}

/** Whether a robot could stand at (x, z) on the ground: not a cliff, not inside something built. */
export function standable(x: number, z: number): boolean {
  const g = terrainHeight(x, z);
  return !steepAt(x, z) && !solidAt(x, g + 0.4, z) && !solidAt(x, g + 1.2, z);
}

/** The squad's members walking after the player, in a fixed order: the first goes straight at the spot. */
const chasers = (s: State, squad: number) => s.enemies.filter((e) => e.squad === squad && e.mode !== "spawning").sort((a, b) => a.id - b.id);

/**
 * The squad has lost the player and now goes after them at `to` (see PURSUE): each member
 * picks its way there afresh, coming at it along the line from where the squad stands.
 */
function chaseTo(s: State, squad: number, to: Point) {
  const sq = s.squads[squad];
  const mates = chasers(s, squad);
  let cx = 0;
  let cz = 0;
  for (const e of mates) {
    cx += e.pos.x / mates.length;
    cz += e.pos.z / mates.length;
  }
  const dx = to.x - cx;
  const dz = to.z - cz;
  const d = Math.hypot(dx, dz);
  sq.chase = { ...to };
  sq.chaseDir = d > 1e-3 ? { x: dx / d, z: dz / d } : { x: 0, z: 1 };
  for (const e of mates) e.goal = null;
}

/**
 * A fighting squad that has lost the player learns where they are now (it heard them, or
 * one of it was hit): it goes after that spot, though nobody has seen them there.
 */
export function learnSpot(s: State, squad: number, x: number, z: number) {
  const sq = s.squads[squad];
  if (!sq?.engaged) return;
  sq.last = { x, z };
  sq.chaseT = 0;
  if (sq.sinceSeen >= AWARE.trackTime) chaseTo(s, squad, { x, z });
}

/**
 * Where a squad that just lost the player goes after them: the last sighting carried on
 * along their motion then, pulled back toward the sighting until it is on open ground
 * and within a storey of it.
 */
function aheadOfSighting(sq: { last: Point; vel?: Point }): Point {
  const v = sq.vel ?? { x: 0, z: 0 };
  let ox = v.x * PURSUE.lead;
  let oz = v.z * PURSUE.lead;
  const len = Math.hypot(ox, oz);
  if (len > PURSUE.leadMax) {
    ox *= PURSUE.leadMax / len;
    oz *= PURSUE.leadMax / len;
  }
  const g = terrainHeight(sq.last.x, sq.last.z);
  for (const f of [1, 0.66, 0.33]) {
    const x = sq.last.x + ox * f;
    const z = sq.last.z + oz * f;
    if (standable(x, z) && Math.abs(terrainHeight(x, z) - g) < 2.5) return { x, z };
  }
  return { ...sq.last };
}

/**
 * Where a member of a squad that has lost the player walks (see PURSUE): the first straight
 * at the spot it is going after, the others at points to either side of it across the squad's
 * line of approach; after `PURSUE.approach` seconds, a new point round the spot every
 * `PURSUE.sweepEvery` seconds, a different one for each member.
 */
export function pursuitSpot(s: State, e: Enemy, known: Point): Point {
  const sq = s.squads[e.squad];
  const dir = sq?.chaseDir ?? { x: 0, z: 1 };
  const n = Math.max(0, chasers(s, e.squad).indexOf(e));
  const t = sq?.chaseT ?? 0;
  let ox = 0;
  let oz = 0;
  if (t < PURSUE.approach) {
    if (n > 0) {
      const side = n % 2 ? 1 : -1;
      ox = -dir.z * side * PURSUE.spread;
      oz = dir.x * side * PURSUE.spread;
    }
  } else {
    // Sweep: each member walks a different round of points about the spot, near and far in turn.
    const k = 1 + Math.floor((t - PURSUE.approach) / PURSUE.sweepEvery);
    const a = Math.atan2(dir.x, dir.z) + n * 2.1 + k * 2.4;
    const r = PURSUE.sweep * ((k + n) % 2 ? 1 : 0.55);
    ox = Math.sin(a) * r;
    oz = Math.cos(a) * r;
  }
  if (ox === 0 && oz === 0) return known;
  const g = terrainHeight(known.x, known.z);
  for (const f of [1, 0.5]) {
    const x = known.x + ox * f;
    const z = known.z + oz * f;
    if (standable(x, z) && Math.abs(terrainHeight(x, z) - g) < 2.5) return { x, z };
  }
  return known;
}

/**
 * Each engaged squad's bookkeeping, every tick: how long the player has stayed on one spot or
 * been seen backing away (see PINCH), where it goes after them once it loses sight (see PURSUE),
 * and giving up to search after `AWARE.chaseTime` without news of them.
 */
export function stepSquads(s: State) {
  s.squads.forEach((sq, i) => {
    if (!sq.engaged) return;
    const members = s.enemies.filter((e) => e.squad === i);
    // A squad with no one left is simply over, not searching.
    if (!members.length) {
      sq.engaged = false;
      return;
    }
    // The titan's squad never stands down once woken.
    if (members.some((e) => e.kind === "titan")) {
      sq.sinceSeen = 0;
      return;
    }
    // How long the player has been seen staying put (see PINCH). A squad that has lost them
    // does not count the time: its chase and sweep stand in for the pinch.
    if (!sq.pin || dist2d(sq.pin, sq.last) > PINCH.radius) {
      sq.pin = { ...sq.last };
      sq.pinT = 0;
    } else if (sq.sinceSeen < AWARE.trackTime) sq.pinT = (sq.pinT ?? 0) + TICK;
    // Seen backing away from the squad's front member (see PINCH): the time builds while they
    // do and wears off twice as fast while they do not.
    const lead = chasers(s, i)[0];
    const live = sq.sinceSeen < AWARE.trackTime;
    let away = 0;
    if (live && lead && sq.vel) {
      const lx = sq.last.x - lead.pos.x;
      const lz = sq.last.z - lead.pos.z;
      const ll = Math.hypot(lx, lz) || 1;
      away = (sq.vel.x * lx + sq.vel.z * lz) / ll;
    }
    sq.backT = away > PINCH.backSpeed ? (sq.backT ?? 0) + TICK : Math.max(0, (sq.backT ?? 0) - 2 * TICK);
    // Members that ducked behind cover still know where a player who has not moved off stands
    // (AWARE.coverHold): the squad keeps tracking them rather than losing them to its own hiding.
    const holds =
      sq.sinceSeen + TICK >= AWARE.trackTime &&
      sq.sinceSeen < AWARE.trackTime &&
      (sq.hold ?? 0) < AWARE.coverHold &&
      dist2d(sq.last, s.player.pos) < FLANK.moved &&
      members.some((e) => e.cover && e.aware === "engaged" && located(s, e));
    if (holds) sq.hold = (sq.hold ?? 0) + TICK;
    else sq.sinceSeen += TICK;
    sq.chaseT = (sq.chaseT ?? 0) + TICK;
    // Sight lost this tick: go after where the player was heading.
    if (sq.sinceSeen >= AWARE.trackTime && !sq.chase) chaseTo(s, i, aheadOfSighting(sq));
    if (sq.chaseT < AWARE.chaseTime) return;
    sq.pinT = 0;
    sq.backT = 0;
    sq.engaged = false;
    for (const e of members) {
      e.aware = "alert";
      e.detect = AWARE.suspicious;
      e.goal = { ...(sq.chase ?? sq.last) };
      e.searchT = AWARE.searchTime;
      e.cover = e.peek = null;
    }
    sq.chase = sq.chaseDir = undefined;
    s.events.push({ t: "calm", squad: i });
  });
}
