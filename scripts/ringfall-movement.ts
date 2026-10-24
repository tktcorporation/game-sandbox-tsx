/**
 * The sim gate's checks of how the player moves (scripts/ringfall-sim.ts runs them): the
 * quarry's ways up are each walked or ridden, a slide-jump chain outruns a sprint over a fixed
 * course, a climb reaches the top of a box of each height class and fails on a wall too high and
 * on the crags, and a zipline is up exactly while both its ends are held, clear, and ridden in
 * the time its length takes. `movementLines()` prints the course times kept in balance.md.
 */
import { CLIMB, PLAYER, TICK, ZIP } from "../src/ringfall/sim/config";
import { BOXES, FRONT_LINKS, NODES, POIS, QUARRY_EXITS, QUARRY_LIFTS, ZIP_BOXES, ZIPS, ZIP_MISSING, type Box } from "../src/ringfall/sim/map";
import { POI_AT, inArea } from "../src/ringfall/sim/areas";
import { groundAt, los } from "../src/ringfall/sim/geom";
import { floorLevel, highGround, LEVEL, offLowGround, offshore, steepAt, terrainHeight } from "../src/ringfall/sim/terrain";
import { idleInput, newRun, type Input, type State } from "../src/ringfall/sim/state";
import { step } from "../src/ringfall/sim/step";
import { placeAlly } from "../src/ringfall/sim/ally";
import { grabZip, zipNodes, zipPoint, zipUp } from "../src/ringfall/sim/zips";

/** A run with nobody about, the player standing at (x, z) facing `yaw`. */
function emptyRun(x: number, z: number, yaw: number): State {
  const s = newRun(7);
  s.enemies = [];
  s.phase = "play";
  s.cleared = POIS.map(() => true);
  s.visited = POIS.map(() => true);
  s.reinforceT = 1e9;
  s.raiderT = 1e9;
  s.parties = [];
  s.crewsDue = [];
  const p = s.player;
  p.pos = { x, y: groundAt(x, z, PLAYER.radius, terrainHeight(x, z) + 1), z };
  p.yaw = yaw;
  p.onGround = true;
  placeAlly(s);
  return s;
}

/** Steps `s` for at most `seconds`, `input` deciding each tick's keys, until `done`; the crouch's last state is passed on as the game's loop does. */
function play(s: State, seconds: number, input: (s: State, t: number) => Input, done: (s: State) => boolean = () => false): number {
  let prev = false;
  for (let k = 0; k < seconds / TICK; k++) {
    const inp = input(s, k * TICK);
    step(s, inp, prev);
    prev = inp.crouch;
    if (done(s)) return (k + 1) * TICK;
  }
  return Infinity;
}

const yawOf = (dx: number, dz: number) => Math.atan2(dx, -dz);
const SIDE_YAW = { n: 0, e: Math.PI / 2, s: Math.PI, w: -Math.PI / 2 } as const;
const forward = (extra: Partial<Input> = {}) => () => ({ ...idleInput(), moveZ: 1, noClimb: true, ...extra });

/**
 * Each of the quarry's wide stairs is walked up from its floor, and each lift ridden from the
 * floor to the ground round the quarry. Returns the number of ways up found, or an error.
 */
export function checkQuarryExits(): string | number {
  const [qx, qz] = POI_AT.quarry;
  for (const q of QUARRY_EXITS) {
    const s = emptyRun(qx + q.x, qz + q.z, SIDE_YAW[q.toward]);
    const want = q.top ?? LEVEL.quarryTop + 6;
    play(s, 12, forward(), (o) => o.player.pos.y > want - 0.4 && o.player.onGround);
    if (s.player.pos.y < want - 0.4) return `quarry scenario: the stairs ${q.name} ended at ${s.player.pos.y.toFixed(1)} m, not up at ${want.toFixed(1)}`;
  }
  for (const l of QUARRY_LIFTS) {
    const i = ZIPS.findIndex((z) => z.a === l.a && z.b === l.b);
    if (i < 0) return `quarry scenario: the lift to ${l.b} was laid no cable`;
    const err = rideOnce(i, 1);
    if (err) return `quarry scenario: ${err}`;
    const top = ZIPS[i].pts[ZIPS[i].pts.length - 1];
    if (terrainHeight(top.x, top.z) < LEVEL.quarryTop + 5) return `quarry scenario: the lift to ${l.b} ends at ${terrainHeight(top.x, top.z).toFixed(1)} m, down in the quarry`;
  }
  return QUARRY_EXITS.length + QUARRY_LIFTS.length;
}

/** A level lane on the salt flats `len` metres long, clear at the knee and the chest, for racing over. */
function course(len: number): { x: number; z: number; yaw: number } | null {
  const [bx, bz] = inArea("bay", -55, -500);
  for (let dz = 0; dz <= 40; dz += 2)
    for (const zz of [bz + dz, bz - dz]) {
      const y = terrainHeight(bx, zz);
      let flat = true;
      for (let t = 0; t <= len + 15 && flat; t += 2) flat = Math.abs(terrainHeight(bx + t, zz) - y) < 0.3 && !steepAt(bx + t, zz) && groundAt(bx + t, zz, PLAYER.radius, y + 0.3) < y + 0.3;
      if (!flat) continue;
      const a = { x: bx, y: y + 0.5, z: zz };
      const b = { x: bx + len + 15, y: y + 0.5, z: zz };
      if (los(a, b) && los({ ...a, y: y + 1.4 }, { ...b, y: y + 1.4 }) && los({ ...a, z: zz + 1 }, { ...b, z: zz + 1 }) && los({ ...a, z: zz - 1 }, { ...b, z: zz - 1 })) return { x: bx, z: zz, yaw: Math.PI / 2 };
    }
  return null;
}

/** The chain: sprint, crouch to slide, jump a quarter second into each slide, keep the crouch held through the air so the landing slides on. */
function chain() {
  let slideT = 0;
  return (s: State): Input => {
    const p = s.player;
    const inp = { ...idleInput(), moveZ: 1, noClimb: true };
    slideT = p.sliding ? slideT + TICK : 0;
    if (p.onGround && !p.sliding) inp.crouch = Math.hypot(p.vel.x, p.vel.z) > PLAYER.walk + 0.5 && s.time % 0.1 < 0.05;
    else inp.crouch = true;
    if (p.sliding && slideT >= 0.25) inp.jump = true;
    return inp;
  };
}

/** Seconds to cover `len` metres east from `at`, by `input`; Infinity when the lane is left. */
function race(at: { x: number; z: number; yaw: number }, len: number, input: (s: State) => Input): number {
  const s = emptyRun(at.x, at.z, at.yaw);
  s.ally.active = false;
  return play(s, 60, (o) => input(o), (o) => o.player.pos.x >= at.x + len);
}

/** Rides cable `i` from one end (`dir` 1 from `a`); an error when the ride stops short or takes longer than its length allows. */
function rideOnce(i: number, dir: 1 | -1): string | null {
  const l = ZIPS[i];
  const from = dir > 0 ? l.pts[0] : l.pts[l.pts.length - 1];
  const s = emptyRun(from.x, from.z, 0);
  s.nodes = s.nodes.map(() => "freed");
  const p = s.player;
  const to = zipPoint(l, dir > 0 ? 1 : l.length - 1);
  p.yaw = yawOf(to.dx * dir, to.dz * dir);
  grabZip(s, i, dir > 0 ? 0.5 : l.length - 0.5);
  if (!p.zip) return `${l.a}–${l.b} was not taken hold of at its end`;
  const t = play(s, 120, () => idleInput(), (o) => !o.player.zip);
  const most = l.length / ZIP.speed + (ZIP.speed - ZIP.start) / ZIP.accel + (2 * ZIP.brake) / (ZIP.speed + ZIP.arrive) + 0.5;
  const least = l.length / ZIP.speed;
  if (!(t <= most && t >= least)) return `riding ${l.a}–${l.b} (${l.length.toFixed(0)} m) took ${t.toFixed(1)} s, not ${least.toFixed(1)}–${most.toFixed(1)}`;
  const end = dir > 0 ? l.pts[l.pts.length - 1] : l.pts[0];
  if (Math.hypot(p.pos.x - end.x, p.pos.z - end.z) > 3) return `riding ${l.a}–${l.b} let go ${Math.hypot(p.pos.x - end.x, p.pos.z - end.z).toFixed(1)} m short of its end`;
  return null;
}

/** The measured times over the course: sprinting, the slide-jump chain, and the first stretch of a zipline. */
export function courseTimes(): { len: number; sprint: number; chain: number; zip: number } | string {
  const len = 120;
  const at = course(len);
  if (!at) return "course scenario: no level lane on the salt flats to race over";
  const sprint = race(at, len, forward());
  const ch = race(at, len, chain());
  // A zipline's first `len` metres along the ground from its end, the longest cable with no pylon in them.
  const l = ZIPS.filter((z) => !z.fixed).sort((a, b) => b.length - a.length)[0];
  const s = emptyRun(l.pts[0].x, l.pts[0].z, 0);
  s.nodes = s.nodes.map(() => "freed");
  grabZip(s, ZIPS.indexOf(l), 0.5);
  const x0 = s.player.pos.x;
  const z0 = s.player.pos.z;
  const zip = play(s, 60, () => idleInput(), (o) => Math.hypot(o.player.pos.x - x0, o.player.pos.z - z0) >= len);
  return { len, sprint, chain: ch, zip };
}

/** The course's line for balance.md. */
export function courseLine(c: { len: number; sprint: number; chain: number; zip: number }): string {
  const v = (t: number) => (c.len / t).toFixed(1);
  return `course: ${c.len} m on the flat, sprint ${c.sprint.toFixed(1)} s (${v(c.sprint)} m/s), slide-jump chain ${c.chain.toFixed(1)} s (${v(c.chain)} m/s, +${Math.round((c.sprint / c.chain - 1) * 100)}%), zipline ${c.zip.toFixed(1)} s (${v(c.zip)} m/s)`;
}

/** A slide-jump chain beats a sprint over the course by 30 to 50%. */
export function checkChain(c: { len: number; sprint: number; chain: number }): string | null {
  const gain = c.sprint / c.chain - 1;
  if (!(gain >= 0.3 && gain <= 0.5)) return `course scenario: the slide-jump chain ran ${c.len} m in ${c.chain.toFixed(1)} s against a sprint's ${c.sprint.toFixed(1)} s (${Math.round(gain * 100)}% faster, not 30–50%)`;
  return null;
}

/**
 * A box standing alone on level ground whose top is `h` (±0.3) over the ground, with open ground
 * before its west, east, north or south face to run up from, and room on its top: where the climb is tried.
 */
export function climbSpot(lo: number, hi: number, onTop = true): { x: number; z: number; yaw: number; top: number } | null {
  for (const b of BOXES) {
    if (b.kind === "fence" || b.x1 - b.x0 < 2 || b.z1 - b.z0 < 2) continue;
    const cx = (b.x0 + b.x1) / 2;
    const cz = (b.z0 + b.z1) / 2;
    const g = terrainHeight(cx, cz);
    if (Math.abs(b.y0 - g) > 0.3 || b.h - g < lo || b.h - g > hi) continue;
    for (const [fx, fz, yaw] of [[b.x0 - 4, cz, Math.PI / 2], [b.x1 + 4, cz, -Math.PI / 2], [cx, b.z0 - 4, Math.PI], [cx, b.z1 + 4, 0]] as const) {
      const fg = terrainHeight(fx, fz);
      if (Math.abs(fg - g) > 0.2 || steepAt(fx, fz) || groundAt(fx, fz, PLAYER.radius, fg + 0.3) > fg + 0.3 || offLowGround(fx, fz)) continue;
      // The run up is open, and nothing stands over the start.
      if (!los({ x: fx, y: fg + 0.3, z: fz }, { x: fx + Math.sin(yaw) * 3.2, y: fg + 0.3, z: fz - Math.cos(yaw) * 3.2 })) continue;
      if (!los({ x: fx, y: fg + 1.7, z: fz }, { x: fx, y: Math.min(b.h, fg + CLIMB.reach) + 2.5, z: fz })) continue;
      if (!onTop) return { x: fx, z: fz, yaw, top: b.h };
      // Room on top: nothing over the top for a body's height, and the top a floor of this box alone.
      if (!los({ x: cx, y: b.h + 0.2, z: cz }, { x: cx, y: b.h + 2.2, z: cz }) || groundAt(cx, cz, PLAYER.radius, b.h + 0.3) > b.h + 0.05) continue;
      return { x: fx, z: fz, yaw, top: b.h };
    }
  }
  return null;
}

/** Sprints (or jumps, `air`) at a spot's wall; the height the player stands at once the climb is over (or after 4 s). */
function climbAt(spot: { x: number; z: number; yaw: number }, air: boolean, top = Infinity): number {
  const s = emptyRun(spot.x, spot.z, spot.yaw);
  s.ally.active = false;
  let climbed = false;
  play(
    s,
    4,
    (o, t) => ({ ...idleInput(), moveZ: 1, jump: air && t > 0.35 && t < 0.4 }),
    (o) => (climbed ||= !!o.player.mantle) && !o.player.mantle && o.player.onGround && o.player.pos.y > top - 0.3,
  );
  return s.player.pos.y;
}

/** The heights of box climbed in the gate: a crate's, a container's, a storey's and near the reach. */
const CLIMB_CLASSES: [string, number, number][] = [
  ["crate", 1.0, 1.8],
  ["container", 2.4, 3.2],
  ["storey", 3.6, 4.7],
  ["tall", 4.9, CLIMB.reach - 0.2],
];

/**
 * A climb reaches the top of a box of each height class, running and jumping; a wall past the
 * reach is not climbed; the crags' high ground and the coast are not climbed onto; and a terrace
 * of the fields (a 4 m terrain step) is climbed. Returns the climbs made, or an error.
 */
export function checkClimbs(): string | string[] {
  const made: string[] = [];
  for (const [name, lo, hi] of CLIMB_CLASSES) {
    const spot = climbSpot(lo, hi);
    if (!spot) return `climb scenario: no ${name} box to climb`;
    for (const air of [false, true]) {
      const y = climbAt(spot, air, spot.top);
      if (Math.abs(y - spot.top) > 0.15) return `climb scenario: ${air ? "jumping" : "running"} at a ${name} box ${(spot.top - terrainHeight(spot.x, spot.z)).toFixed(1)} m high at ${spot.x.toFixed(0)},${spot.z.toFixed(0)} ended at ${y.toFixed(1)} m, not on its top at ${spot.top.toFixed(1)}`;
    }
    made.push(`${name} ${(spot.top - terrainHeight(spot.x, spot.z)).toFixed(1)} m`);
  }
  const high = climbSpot(CLIMB.reach + 1.5, CLIMB.reach + 20, false);
  if (!high) return "climb scenario: no box past the reach to fail on";
  for (const air of [false, true]) {
    const y = climbAt(high, air);
    if (y > terrainHeight(high.x, high.z) + 2.5) return `climb scenario: a wall ${(high.top - terrainHeight(high.x, high.z)).toFixed(1)} m high was climbed to ${y.toFixed(1)} m`;
  }
  // A terrace of the fields: 4 m of terrain, climbed onto the field above.
  const [vx, vz] = inArea("village", 10, 40);
  const field = climbAt({ x: vx, z: vz, yaw: 0 }, false, LEVEL.fieldMid);
  if (Math.abs(field - LEVEL.fieldMid) > 0.4) return `climb scenario: running at the fields' terrace at ${vx.toFixed(0)},${vz.toFixed(0)} ended at ${field.toFixed(1)} m, not on the field at ${LEVEL.fieldMid}`;
  made.push(`terrace ${LEVEL.fieldMid - LEVEL.field} m`);
  // The crags and the coast: from low ground at their foot, running, climbing and hopping at them
  // for 20 s never stands up on their high ground (4 m over the walkable ground there) or past the coast.
  let tried = 0;
  for (const [x, z, yaw, what] of footSpots()) {
    tried++;
    for (const air of [false, true]) {
      const s = emptyRun(x, z, yaw);
      s.ally.active = false;
      let up: string | null = null;
      play(
        s,
        20,
        (o, t) => ({ ...idleInput(), moveZ: 1, jump: air && t % 0.8 < 0.05 }),
        (o) => {
          const p = o.player.pos;
          if (o.player.onGround && (p.y > floorLevel(p.x, p.z) + 4 || offshore(p.x, p.z) > 0)) up = `${p.x.toFixed(0)},${p.z.toFixed(0)} at ${p.y.toFixed(1)} m`;
          return !!up;
        },
      );
      if (up) return `climb scenario: ${air ? "hopping" : "running"} at the ${what} from ${x.toFixed(0)},${z.toFixed(0)} stood on its high ground at ${up}`;
    }
  }
  if (tried < 4) return `climb scenario: only ${tried} feet of crags and coast found to try`;
  return made;
}

/**
 * Low ground at the foot of the crags (between the regions, at z about -350) and of the coast's
 * cliffs, facing them: where a body must not climb.
 */
export function footSpots(): [number, number, number, string][] {
  const out: [number, number, number, string][] = [];
  for (let x = -300; x <= 300 && out.length < 4; x += 7)
    for (let z = -420; z <= -280; z += 1.5) {
      if (offLowGround(x, z) || steepAt(x, z) || highGround(x, z)) continue;
      const g = terrainHeight(x, z);
      const dir = [[0, 1.5], [0, -1.5], [1.5, 0], [-1.5, 0]].find(([dx, dz]) => highGround(x + dx * 2, z + dz * 2) && terrainHeight(x + dx * 3, z + dz * 3) > g + CLIMB.reach * 0.6);
      if (!dir || groundAt(x, z, PLAYER.radius, g + 0.3) > g + 0.3) continue;
      out.push([x, z, yawOf(dir[0], dir[1]), "crags"]);
      break;
    }
  let coast = 0;
  for (let a = 0; a < 64 && coast < 2; a++) {
    const ang = (a / 64) * 2 * Math.PI;
    for (let r = 0; r < 1200; r += 2) {
      const x = 0 + Math.cos(ang) * r;
      const z = -200 + Math.sin(ang) * r;
      if (offshore(x, z) < -4 || offLowGround(x, z) || steepAt(x, z) || highGround(x, z)) continue;
      const ox = Math.cos(ang);
      const oz = Math.sin(ang);
      if (!(terrainHeight(x + ox * 4, z + oz * 4) > terrainHeight(x, z) + 3 && offshore(x + ox * 12, z + oz * 12) > 0)) continue;
      if (groundAt(x, z, PLAYER.radius, terrainHeight(x, z) + 0.3) > terrainHeight(x, z) + 0.3) continue;
      out.push([x, z, yawOf(ox, oz), "coast"]);
      coast++;
      break;
    }
  }
  return out;
}

/**
 * Each link of the front has a cable or a reason it has none; a cable is up exactly while both
 * its ends are held; it keeps the hanging body clear of the ground and of everything built but
 * its own masts and pylons; and it is ridden end to end, both ways, in the time its length takes.
 */
export function checkZips(): string | { up: number; missing: string[] } {
  for (const [a, b] of FRONT_LINKS) {
    const has = ZIPS.some((l) => l.a === a && l.b === b);
    const why = ZIP_MISSING.find((m) => m.a === a && m.b === b);
    if (has === !!why) return `zip scenario: the link ${a}–${b} has ${has ? "a cable and a reason for none" : "neither a cable nor a reason"}`;
  }
  const s = newRun(3);
  for (let k = 0; k < 64; k++) {
    // Who holds each node, from a hash of k: every cable checked against both, either and neither end held.
    s.nodes = NODES.map((_, n) => (((k * 2654435761 + n * 40503) >>> 7) % 3 === 0 ? "freed" : "held"));
    for (let i = 0; i < ZIPS.length; i++) {
      if (ZIPS[i].fixed) {
        if (!zipUp(s, i)) return `zip scenario: the lift ${ZIPS[i].b} was down`;
        continue;
      }
      const held = zipNodes(i).every((n) => n < 0 || s.nodes[n] === "freed");
      if (zipUp(s, i) !== held) return `zip scenario: ${ZIPS[i].a}–${ZIPS[i].b} was ${held ? "down" : "up"} with its ends ${held ? "" : "not "}both held`;
    }
  }
  // The world's boxes but the ziplines' own: the last boxes laid.
  const own = new Set<Box>(ZIP_BOXES);
  for (const l of ZIPS)
    for (let t = 2; t < l.length - 2; t += 1) {
      const { p } = zipPoint(l, t);
      const feet = p.y - ZIP.hang;
      if (terrainHeight(p.x, p.z) > feet - 0.2) return `zip scenario: ${l.a}–${l.b} drags the rider over the ground at ${p.x.toFixed(0)},${p.z.toFixed(0)}`;
      const hit = BOXES.find((b) => !own.has(b) && p.x > b.x0 - 0.4 && p.x < b.x1 + 0.4 && p.z > b.z0 - 0.4 && p.z < b.z1 + 0.4 && b.h > feet && b.y0 < p.y + 0.2);
      if (hit) return `zip scenario: ${l.a}–${l.b} runs the rider into a ${hit.kind} at ${p.x.toFixed(0)},${p.z.toFixed(0)}`;
    }
  for (let i = 0; i < ZIPS.length; i++)
    for (const dir of [1, -1] as const) {
      if (ZIPS[i].fixed && dir < 0) continue;
      const err = rideOnce(i, dir);
      if (err) return `zip scenario: ${err}`;
    }
  return { up: ZIPS.filter((l) => !l.fixed).length, missing: ZIP_MISSING.map((m) => `${m.a}–${m.b} (${m.why})`) };
}

/** The lines the movement checks print, kept in balance.md. */
export function movementLines(): { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  const q = checkQuarryExits();
  if (typeof q === "string") errors.push(q);
  else lines.push(`quarry: ${q} new ways up walked or ridden (${QUARRY_EXITS.length} stairs, ${QUARRY_LIFTS.length} lifts)`);
  const c = courseTimes();
  if (typeof c === "string") errors.push(c);
  else {
    lines.push(courseLine(c));
    const e = checkChain(c);
    if (e) errors.push(e);
  }
  const k = checkClimbs();
  if (typeof k === "string") errors.push(k);
  else lines.push(`climbs: ${k.join(", ")}; none past ${CLIMB.reach} m, none onto the crags or past the coast`);
  const z = checkZips();
  if (typeof z === "string") errors.push(z);
  else lines.push(`ziplines: ${z.up} of ${FRONT_LINKS.length} links carry a cable${z.missing.length ? `; none on ${z.missing.join(", ")}` : ""}`);
  return { lines, errors };
}
