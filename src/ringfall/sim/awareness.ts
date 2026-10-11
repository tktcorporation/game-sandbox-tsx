import { AWARE, DEG, ENEMIES, NOISE, SIGHT, TICK } from "./config";
import { dist2d, los, lookAngles, wrapAngle } from "./geom";
import type { Enemy, State, Vec3 } from "./state";

/*
 * What robots know about the player: sight that fills slowly, sounds that make
 * them come and look, and squads that start fighting together.
 */

export const headOf = (e: Enemy): Vec3 => ({ x: e.pos.x, y: e.pos.y + Math.max(ENEMIES[e.kind].weakY, 0.2), z: e.pos.z });

/** The player is a valid target for robots: on the ground and not knocked down. */
const visibleNow = (s: State) => (s.phase === "play" || s.phase === "extract") && s.player.downed <= 0;

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

export function engageSquad(s: State, squad: number, by: Enemy) {
  const sq = s.squads[squad];
  if (!sq || sq.engaged) return;
  sq.engaged = true;
  sq.sinceSeen = 0;
  sq.last = { x: s.player.pos.x, z: s.player.pos.z };
  for (const e of s.enemies) {
    if (e.squad !== squad) continue;
    e.aware = "engaged";
    e.detect = 1;
    e.goal = null;
    e.cooldown = Math.max(e.cooldown, 0.5);
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
 * close ones that can see the spot engage at once.
 */
export function makeNoise(s: State, x: number, z: number, radius: number) {
  const spot = { x, y: s.player.pos.y + 1.2, z };
  const alerted = new Set<number>();
  for (const e of s.enemies) {
    if (e.aware === "engaged" || e.mode === "spawning") continue;
    const d = dist2d(e.pos, spot);
    if (d > radius) continue;
    if (d < radius * NOISE.engageInside && los(headOf(e), spot) && mayEngage(s, e)) engageSquad(s, e.squad, e);
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
      sq.last = { x: p.pos.x, z: p.pos.z };
    }
  }
  if (!seen && e.aware !== "engaged") e.detect = Math.max(0, e.detect - AWARE.decay * TICK);
  return seen;
}

/**
 * Where a fighting robot believes the player is: the true position while its squad
 * has eyes on them, else the last place they were seen.
 */
export function knownSpot(s: State, e: Enemy): { x: number; z: number; live: boolean } {
  const sq = s.squads[e.squad];
  if (!sq || sq.sinceSeen < AWARE.trackTime) return { x: s.player.pos.x, z: s.player.pos.z, live: true };
  return { x: sq.last.x, z: sq.last.z, live: false };
}

/** A squad that lost the player for long enough goes back to searching where it was last seen. */
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
    sq.sinceSeen += TICK;
    if (sq.sinceSeen < AWARE.loseTime) return;
    sq.engaged = false;
    for (const e of members) {
      e.aware = "alert";
      e.detect = AWARE.suspicious;
      e.goal = { ...sq.last };
      e.searchT = AWARE.searchTime;
      e.cover = e.peek = null;
    }
    s.events.push({ t: "calm", squad: i });
  });
}
