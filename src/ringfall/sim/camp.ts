import { PLAYER } from "./config";
import { stepAlly, placeAlly } from "./ally";
import { groundAt } from "./geom";
import { CAMP, inCamp, type CampSpot, type RouteId } from "./map";
import { stepPlayer } from "./player";
import { useRoutes } from "./routes";
import { starterKit, idleInput, newRun, type Input, type Kit, type State } from "./state";

/*
 * The camp between raids: the player and the teammate walk the yard (map.ts `CAMP`) with no
 * robots on the island, weapons lowered. Its state is a raid's (`newRun()`) emptied of robots,
 * loot and timers, so the view draws it as any other; it is never settled, and its clock stands.
 * A raid starts from it by walking out of the gate (`walkOut()`) or from the truck (a new raid).
 */

/** The camp's state: the player waking in front of the tent with `kit` in hand, the teammate beside them. */
export function newCamp(seed: number, routes: readonly RouteId[] = [], kit: Kit = starterKit()): State {
  const s = newRun(seed, kit, "reservoir", { routes: [...routes] });
  s.enemies = [];
  s.squads = [];
  s.parties = [];
  s.loot = [];
  s.orbs = [];
  s.waves = [];
  s.care = null;
  s.reinforceT = s.raiderT = Infinity;
  s.crewsDue = [];
  const p = s.player;
  const w = CAMP.wake;
  p.pos = { x: w.x, y: groundAt(w.x, w.z, PLAYER.radius, CAMP.y + 1), z: w.z };
  p.vel = { x: 0, y: 0, z: 0 };
  p.yaw = w.yaw;
  p.pitch = 0;
  placeAlly(s);
  return s;
}

/** Only walking, looking, jumping and crouching reach the player in the camp: no shot, item or ability. */
function campInput(input: Input): Input {
  return { ...idleInput(), moveX: input.moveX, moveZ: input.moveZ, lookX: input.lookX, lookY: input.lookY, jump: input.jump, crouch: input.crouch, touch: input.touch };
}

/** One 1/60 s tick of the camp: the player walks, the teammate keeps beside them. The raid's clock does not run. */
export function stepCamp(s: State, input: Input, prevCrouch: boolean) {
  useRoutes(s.routes);
  s.events = [];
  stepPlayer(s, campInput(input), prevCrouch);
  stepAlly(s);
}

/** Whether the player has left the camp's yard: through the gate, or over the fence. */
export const outOfCamp = (s: State) => !inCamp(s.player.pos);

/** The station or truck the use key acts on where the player stands: the nearest within its reach, else null. */
export function campSpotAt(at: { x: number; z: number }): CampSpot | null {
  let best: CampSpot | null = null;
  let bestD = Infinity;
  for (const c of CAMP.spots) {
    const d = Math.hypot(c.x - at.x, c.z - at.z);
    if (d < c.reach && d < bestD) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

/**
 * Carries the camp's player over into raid `s` (started at the reservoir's first way in) where
 * they stand, moving and facing as they were, the teammate beside them: walking out of the gate
 * is the start, with no cut.
 */
export function walkOut(s: State, camp: State) {
  const p = s.player;
  const c = camp.player;
  p.pos = { ...c.pos };
  p.vel = { ...c.vel };
  p.yaw = c.yaw;
  p.pitch = c.pitch;
  p.onGround = c.onGround;
  p.crouch = c.crouch;
  p.forwardHeld = c.forwardHeld;
  placeAlly(s);
  const a = s.ally;
  a.pos = { ...camp.ally.pos };
  a.vel = { ...camp.ally.vel };
  a.yaw = camp.ally.yaw;
  a.last = { x: a.pos.x, z: a.pos.z };
  s.trail = camp.trail.map((q) => ({ ...q }));
}
