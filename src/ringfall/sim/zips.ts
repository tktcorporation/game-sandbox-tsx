import { PLAYER, TICK, ULT, ZIP } from "./config";
import { NODES, nodeIndex, ZIPS } from "./map";
import { allyChest, allyUp } from "./ally";
import { eyePos } from "./combat";
import { los } from "./geom";
import type { ZipLine, ZipPoint } from "./ziplayout";
import type { Input, State } from "./state";

/*
 * Riding the ziplines (`ZIPS`, laid in map.ts). A cable is up while the player holds both of its
 * ends (the camp always counts as held): it goes up as a node turns the player's and is cut when
 * one turns the enemy's. The use key near a cable, or a jump into it, takes hold; the rider goes
 * the way they face along it at `ZIP.speed`, slows near the end and lets go there, and a jump lets
 * go anywhere, keeping the speed. Robots never ride, and shoot a rider as anyone else.
 */

/** Whether the player holds end `id` of a link: the camp always, a node while it is theirs. */
const holdsEnd = (s: Pick<State, "nodes">, id: string) => id === "camp" || s.nodes[nodeIndex(id)] === "freed";

/** Whether cable `i` is up: both its ends held. */
export const zipUp = (s: Pick<State, "nodes">, i: number) => holdsEnd(s, ZIPS[i].a) && holdsEnd(s, ZIPS[i].b);

/** The cables up, as their places in `ZIPS`. */
export const zipsUp = (s: Pick<State, "nodes">): number[] => ZIPS.map((_, i) => i).filter((i) => zipUp(s, i));

/** The point `at` metres along a cable, and its direction there (toward `b`). */
export function zipPoint(l: ZipLine, at: number): { p: ZipPoint; dx: number; dy: number; dz: number } {
  const t = Math.max(0, Math.min(l.length, at));
  let i = 0;
  while (i < l.pts.length - 2 && l.cum[i + 1] < t) i++;
  const a = l.pts[i];
  const b = l.pts[i + 1];
  const seg = l.cum[i + 1] - l.cum[i] || 1;
  const k = (t - l.cum[i]) / seg;
  return { p: { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k }, dx: (b.x - a.x) / seg, dy: (b.y - a.y) / seg, dz: (b.z - a.z) / seg };
}

/** The nearest point of a cable to `q`: the distance along it and how far off it is. */
function nearestOn(l: ZipLine, q: ZipPoint): { at: number; d: number } {
  let best = { at: 0, d: Infinity };
  for (let i = 0; i + 1 < l.pts.length; i++) {
    const a = l.pts[i];
    const b = l.pts[i + 1];
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const vz = b.z - a.z;
    const len2 = vx * vx + vy * vy + vz * vz || 1;
    const k = Math.max(0, Math.min(1, ((q.x - a.x) * vx + (q.y - a.y) * vy + (q.z - a.z) * vz) / len2));
    const d = Math.hypot(a.x + vx * k - q.x, a.y + vy * k - q.y, a.z + vz * k - q.z);
    if (d < best.d) best = { at: l.cum[i] + k * (l.cum[i + 1] - l.cum[i]), d };
  }
  return best;
}

/** A cable that is up within `reach` of `q`: its place in `ZIPS` and the distance along it, or null. */
export function zipNear(s: State, q: ZipPoint, reach: number): { line: number; at: number } | null {
  let best: { line: number; at: number; d: number } | null = null;
  for (let i = 0; i < ZIPS.length; i++) {
    const l = ZIPS[i];
    // Every point of a cable lies inside the box round its points.
    if (!l.pts.some((p, k) => k > 0 && Math.min(p.x, l.pts[k - 1].x) - reach < q.x && Math.max(p.x, l.pts[k - 1].x) + reach > q.x && Math.min(p.z, l.pts[k - 1].z) - reach < q.z && Math.max(p.z, l.pts[k - 1].z) + reach > q.z)) continue;
    if (!zipUp(s, i)) continue;
    const n = nearestOn(l, q);
    if (n.d < reach && (!best || n.d < best.d)) best = { line: i, at: n.at, d: n.d };
  }
  return best && { line: best.line, at: best.at };
}

/** The cable the use key would take hold of: within `ZIP.use` of the eyes. */
export const zipInReach = (s: State) => (s.player.downed > 0 || s.player.zip ? null : zipNear(s, eyePos(s), ZIP.use));

/** Takes hold of cable `line` at `at`, going the way the player faces along it. */
export function grabZip(s: State, line: number, at: number) {
  const p = s.player;
  const l = ZIPS[line];
  const here = zipPoint(l, at);
  const fx = Math.sin(p.yaw);
  const fz = -Math.cos(p.yaw);
  let dir: 1 | -1 = fx * here.dx + fz * here.dz >= 0 ? 1 : -1;
  // At an end there is only one way to go.
  if (at < 1) dir = 1;
  else if (at > l.length - 1) dir = -1;
  const a = s.ally;
  // A teammate beside the player and in sight comes along, as on the leap.
  const carry = allyUp(s) && Math.hypot(a.pos.x - p.pos.x, a.pos.z - p.pos.z) < ULT.carry && Math.abs(a.pos.y - p.pos.y) < 2.5 && los(eyePos(s), allyChest(a));
  p.zip = { line, at: Math.max(0.5, Math.min(l.length - 0.5, at)), dir, speed: Math.max(ZIP.start, Math.hypot(p.vel.x, p.vel.z)), carry };
  p.onGround = false;
  p.sliding = false;
  p.crouch = false;
  p.sprinting = false;
  p.mantle = null;
  p.search = null;
  p.zipFall = false;
  s.events.push({ t: "zipOn", line });
}

/** Lets go of the cable, carrying the ride's speed on, `up` m/s upward on top. */
export function letGo(s: State, up: number, cut = false) {
  const p = s.player;
  const z = p.zip;
  if (!z) return;
  const here = zipPoint(ZIPS[z.line], z.at);
  p.vel.x = here.dx * z.dir * z.speed;
  p.vel.z = here.dz * z.dir * z.speed;
  p.vel.y = Math.max(-4, here.dy * z.dir * z.speed) + up;
  p.zipFall = z.carry && allyUp(s);
  p.zip = null;
  p.jumpBuf = 0;
  p.zipRegrip = ZIP.regrip;
  s.events.push({ t: "zipOff", line: z.line, cut });
}

/**
 * One tick on the cable: speeding up to `ZIP.speed`, slowing to `ZIP.arrive` over the last
 * `ZIP.brake` metres, and letting go at the end, on a jump or when the cable is cut.
 */
export function ride(s: State, input: Input) {
  const p = s.player;
  const z = p.zip!;
  const l = ZIPS[z.line];
  if (!zipUp(s, z.line)) return letGo(s, 0, true);
  if (input.jump) return letGo(s, ZIP.hop);
  const left = z.dir > 0 ? l.length - z.at : z.at;
  const cap = left < ZIP.brake ? ZIP.arrive + ((ZIP.speed - ZIP.arrive) * left) / ZIP.brake : ZIP.speed;
  z.speed = z.speed < cap ? Math.min(cap, z.speed + ZIP.accel * TICK) : Math.max(cap, z.speed - ZIP.accel * 1.5 * TICK);
  z.at += z.dir * z.speed * TICK;
  const here = zipPoint(l, z.at);
  p.pos = { x: here.p.x, y: here.p.y - ZIP.hang, z: here.p.z };
  p.vel = { x: here.dx * z.dir * z.speed, y: here.dy * z.dir * z.speed, z: here.dz * z.dir * z.speed };
  if (z.at <= 0 || z.at >= l.length) letGo(s, 1);
}

/** Before the ground step: a jump into a cable that is up, hands first, takes hold of it. */
export function grabInAir(s: State, input: Input) {
  const p = s.player;
  if (p.zip || p.onGround || p.downed > 0 || p.mantle || p.leap || input.noClimb || p.zipRegrip > 0) return;
  const hit = zipNear(s, { x: p.pos.x, y: p.pos.y + PLAYER.eye + 0.4, z: p.pos.z }, ZIP.grab);
  if (hit) grabZip(s, hit.line, hit.at);
}

/** Which nodes' cables are up, as pairs of ends for the map (the camp as its own end). */
export const zipEnds = (s: Pick<State, "nodes">) => zipsUp(s).map((i) => [ZIPS[i].a, ZIPS[i].b] as const);

/** The cable's ends' nodes, for a check that both are held: indices in `NODES`, -1 for the camp. */
export const zipNodes = (i: number) => [ZIPS[i].a, ZIPS[i].b].map((id) => (id === "camp" ? -1 : NODES.findIndex((n) => n.id === id)));
