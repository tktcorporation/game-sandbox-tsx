/**
 * Head-on duels: the player alone against one robot on open ground, no teammate, no cover
 * unless the variant brings it. The player either stands and trades shots (`stand`), strafes
 * from side to side while shooting (`strafe`), shoots the robot from behind while it looks the
 * other way (`flank`), or fights from behind a low wall, ducking under the glow of each wind-up
 * and standing up to shoot between bursts (`cover`). The player aims as a person does: a
 * wandering aim error, a moment to react, turning toward the target a share of the way each tick
 * (the bot's model in bot.ts, `SKILLS`), aiming down sights with the aim assist people get.
 *
 * `duelLines()` gives the line the sim gate prints and balance.md keeps; run this file alone
 * (`npx tsx scripts/ringfall-duel.ts [seeds]`) for the whole table by kind, distance and kit.
 */
import { DEG, PLAYER, TICK, type EnemyKind, type Rarity, type WeaponKind } from "../src/ringfall/sim/config";
import { BOXES, POIS } from "../src/ringfall/sim/map";
import { inArea } from "../src/ringfall/sim/areas";
import { groundAt, inWorld, lookAngles, los, wrapAngle } from "../src/ringfall/sim/geom";
import { offLowGround, terrainHeight } from "../src/ringfall/sim/terrain";
import { idleInput, newRun, type Enemy, type Input, type State } from "../src/ringfall/sim/state";
import { step } from "../src/ringfall/sim/step";
import { spawnEnemy } from "../src/ringfall/sim/enemies";
import { engageSquad } from "../src/ringfall/sim/awareness";
import { bodyCenter, eyePos } from "../src/ringfall/sim/combat";
import { SKILLS } from "../src/ringfall/sim/bot";

export type Way = "stand" | "strafe" | "flank" | "cover";
export interface Kit {
  name: string;
  gun: WeaponKind;
  rarity: Rarity;
  armor: Rarity;
}
export const STARTER: Kit = { name: "start", gun: "pike", rarity: 0, armor: 0 };
export const RARE: Kit = { name: "rare", gun: "pike", rarity: 1, armor: 1 };

export interface Duel {
  win: boolean;
  /** Neither fell within the time limit. */
  draw: boolean;
  time: number;
  /** Damage the player took (shield and health). */
  taken: number;
  shots: number;
  hits: number;
  /** Seconds the robot was fighting and could have fired (cooldown run out) but was not winding up or firing. */
  idle: number;
  /** Seconds to the robot's first shot. */
  first: number;
  /** Seconds it spent in each mode. */
  modes: Record<string, number>;
}

const LIMIT = 30;

/** A run with nobody about: no robots, no teammate, no timers. */
function emptyRun(seed: number, kit: Kit): State {
  const s = newRun(seed, { weapons: [{ kind: kit.gun, rarity: kit.rarity }], armor: kit.armor, heals: { cell: 0, battery: 0, syringe: 0, medkit: 0 }, keys: [] });
  s.enemies = [];
  s.phase = "play";
  s.cleared = POIS.map(() => true);
  s.visited = POIS.map(() => true);
  s.reinforceT = 1e9;
  s.raiderT = 1e9;
  s.parties = [];
  s.crewsDue = [];
  s.ally.active = false;
  return s;
}

let openAt: { x: number; z: number } | null | undefined;
/**
 * Open level ground on the harbor's salt flats, 46 m toward -z and 12 m to either side, with no
 * box within 30 m of it: no cover a robot could run to, so the duel is fought in the open.
 */
function openSpot(): { x: number; z: number } | null {
  if (openAt !== undefined) return openAt;
  const [lx, lz] = inArea("bay", -55, -500);
  const W = 12;
  const D = 46;
  /** How far round the ground no box stands. */
  const C = 30;
  for (let ring = 0; ring < 700; ring += 4)
    for (let a = 0; a < 2 * Math.PI; a += 4 / Math.max(ring, 8)) {
      const x = lx + Math.cos(a) * ring;
      const z = lz + Math.sin(a) * ring;
      if (!inWorld(x, z, 5) || offLowGround(x, z)) continue;
      const g = terrainHeight(x, z);
      let ok = !BOXES.some((b) => b.x1 > x - C && b.x0 < x + C && b.z1 > z - D - C && b.z0 < z + C && b.y0 < g + 4);
      for (let dx = -W; dx <= W && ok; dx += 2)
        for (let dz = -4; dz <= D + 4 && ok; dz += 2) if (Math.abs(terrainHeight(x + dx, z - dz) - g) > 0.6) ok = false;
      if (ok) return (openAt = { x, z });
    }
  return (openAt = null);
}

interface CoverLane {
  /** Where the player stands behind the wall, and the unit direction from it to the robot. */
  x: number;
  z: number;
  ux: number;
  uz: number;
}
const lanes = new Map<number, CoverLane | null>();
/**
 * A low wall (1.1 to 1.45 m over the ground: over it standing, under it crouched) with open
 * level ground `dist` metres beyond it: the player stands at its middle, the robot out there.
 */
function coverLane(dist: number): CoverLane | null {
  if (lanes.has(dist)) return lanes.get(dist)!;
  for (const b of BOXES) {
    if (b.kind === "fence") continue;
    const cx = (b.x0 + b.x1) / 2;
    const cz = (b.z0 + b.z1) / 2;
    const g = terrainHeight(cx, cz);
    const tall = b.h - g;
    if (b.y0 > g + 0.2 || tall < 1.1 || tall > 1.45) continue;
    const w = b.x1 - b.x0;
    const d = b.z1 - b.z0;
    if (Math.max(w, d) < 2.4 || Math.min(w, d) > 1.5) continue;
    // Across the wall's thin side: the player on one face, the robot out beyond the other.
    const sides: [number, number][] = w < d ? [[1, 0], [-1, 0]] : [[0, 1], [0, -1]];
    for (const [ux, uz] of sides) {
      const half = (ux ? w : d) / 2;
      const px = cx - ux * (half + 0.55);
      const pz = cz - uz * (half + 0.55);
      if (!inWorld(px, pz, 5) || offLowGround(px, pz)) continue;
      const pg = groundAt(px, pz, PLAYER.radius, g + 1);
      if (Math.abs(pg - g) > 0.2) continue;
      const rx = px + ux * dist;
      const rz = pz + uz * dist;
      if (!inWorld(rx, rz, 5) || offLowGround(rx, rz)) continue;
      // The lane out to the robot and a few metres either side of it: level and open.
      let ok = true;
      for (let k = half * 2 + 1.5; k <= dist + 4 && ok; k += 1.5)
        for (const side of [-6, -3, 0, 3, 6]) {
          const x = px + ux * k - uz * side;
          const z = pz + uz * k + ux * side;
          if (Math.abs(terrainHeight(x, z) - g) > 0.6) ok = false;
        }
      if (!ok) continue;
      const lo = Math.min(px, rx) - 7;
      const hi = Math.max(px, rx) + 7;
      const lz = Math.min(pz, rz) - 7;
      const hz = Math.max(pz, rz) + 7;
      if (BOXES.some((o) => o !== b && o.x1 > lo && o.x0 < hi && o.z1 > lz && o.z0 < hz && o.y0 < g + 3)) continue;
      const eye = { x: rx, y: g + 2, z: rz };
      if (!los(eye, { x: px, y: pg + 1.5, z: pz }) || los(eye, { x: px, y: pg + 0.95, z: pz })) continue;
      const lane = { x: px, z: pz, ux, uz };
      lanes.set(dist, lane);
      return lane;
    }
  }
  lanes.set(dist, null);
  return null;
}

/** One duel. `skill` is the player's aim (0 beginner, 1 casual, 2 good, as bot.ts's SKILLS). */
export function duel(kind: EnemyKind, dist: number, way: Way, kit: Kit, seed: number, skill = 1): Duel | null {
  const lane = way === "cover" ? coverLane(dist) : null;
  const open = way === "cover" ? null : openSpot();
  if (way === "cover" ? !lane : !open) return null;
  const s = emptyRun(seed, kit);
  s.rng = (seed * 2654435761) >>> 0 || 1;
  const p = s.player;
  const px = lane ? lane.x : open!.x;
  const pz = lane ? lane.z : open!.z;
  const ux = lane ? lane.ux : 0;
  const uz = lane ? lane.uz : -1;
  p.pos = { x: px, y: groundAt(px, pz, PLAYER.radius, terrainHeight(px, pz) + 2), z: pz };
  p.vel = { x: 0, y: 0, z: 0 };
  p.onGround = true;
  p.yaw = Math.atan2(ux, -uz);
  p.pitch = 0;
  // Out on the lane: straight ahead, or (flank) the robot stands there facing away, after a player it believes is further on.
  const rx = px + ux * dist;
  const rz = pz + uz * dist;
  const squad = s.squads.length;
  s.squads.push({ name: "duel", poi: -1, patrol: [], leg: 0, engaged: false, roam: false, sinceSeen: 0, last: { x: px, z: pz } });
  const face = way === "flank" ? Math.atan2(ux, -uz) : Math.atan2(-ux, uz);
  const e = spawnEnemy(s, kind, rx, rz, -1, squad, { face });
  if (way === "flank") {
    // It is fighting, after a player it last saw 20 m beyond it, and has not seen where they are now.
    const ahead = { x: rx + ux * 20, z: rz + uz * 20 };
    engageSquad(s, squad, e, ahead);
    e.blind = 99;
    e.sawAt = ahead;
  } else {
    engageSquad(s, squad, e);
    e.blind = 0;
    e.sawAt = { x: p.pos.x, z: p.pos.z };
  }
  // The player's aim: the bot's model (an Ornstein-Uhlenbeck error, a reaction, a share of the way a tick).
  const sk = SKILLS[skill];
  let seedR = (seed * 747796405 + 2891336453) >>> 0 || 1;
  const rnd = () => {
    seedR ^= seedR << 13;
    seedR >>>= 0;
    seedR ^= seedR >>> 17;
    seedR ^= seedR << 5;
    seedR >>>= 0;
    return seedR / 4294967296;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(2 * Math.PI * rnd());
  let nx = 0;
  let ny = 0;
  let side = rnd() < 0.5 ? 1 : -1;
  let sideT = 0;
  // Ducking under a wind-up: from a moment after the glow starts until the burst is over.
  let glowSeen = 0;
  const r: Duel = { win: false, draw: false, time: 0, taken: 0, shots: 0, hits: 0, idle: 0, first: -1, modes: {} };
  let prev = false;
  for (let k = 0; k < LIMIT / TICK; k++) {
    const inp: Input = idleInput();
    const theta = 2.5;
    const sigma = sk.aimErr * DEG * Math.sqrt(2 * theta);
    nx += -nx * theta * TICK + sigma * Math.sqrt(TICK) * gauss();
    ny += -ny * theta * TICK + sigma * Math.sqrt(TICK) * gauss() * 0.6;
    const t = k * TICK;
    const eye = eyePos(s);
    const at = bodyCenter(e);
    const want = lookAngles(eye, at);
    const turn = t < sk.react ? sk.turn * 0.3 : sk.turn;
    inp.lookX = wrapAngle(want.yaw + nx - p.yaw) * turn;
    inp.lookY = (want.pitch + ny - p.pitch) * turn;
    const sees = los(eye, at);
    const aimDir = Math.hypot(wrapAngle(want.yaw - p.yaw), want.pitch - p.pitch);
    const tol = (sk.name === "beginner" ? 12 : 8) * DEG + Math.atan(1 / Math.max(dist, 1));
    inp.fire = sees && aimDir < tol && t >= sk.react;
    inp.ads = sees && t >= sk.react * 0.5;
    if (way === "strafe") {
      sideT -= TICK;
      if (sideT <= 0) {
        side = rnd() < 0.5 ? -1 : 1;
        sideT = 0.8 + rnd() * 1.2;
      }
      inp.moveX = side * 0.9;
    }
    if (way === "cover") {
      const winding = e.mode === "telegraph" || e.mode === "fire";
      glowSeen = winding ? glowSeen + TICK : 0;
      // Down from a reaction's time into the glow, up once the burst is over.
      inp.crouch = glowSeen > sk.react;
      if (inp.crouch) inp.fire = false;
    }
    step(s, inp, prev);
    prev = inp.crouch;
    for (const ev of s.events) {
      if (ev.t === "enemyFire" && ev.id === e.id) {
        r.shots++;
        if (r.first < 0) r.first = t;
      }
      if (ev.t === "hurt") {
        r.hits++;
        r.taken += ev.dmg;
      }
    }
    r.modes[e.mode] = (r.modes[e.mode] ?? 0) + TICK;
    if (e.mode === "move" && e.cooldown <= 0) r.idle += TICK;
    r.time = t + TICK;
    if (!s.enemies.includes(e)) {
      r.win = true;
      break;
    }
    if (p.downed > 0 || p.hp <= 0 || s.phase === "done") break;
  }
  if (r.time >= LIMIT - TICK / 2 && s.enemies.includes(e) && p.downed <= 0) r.draw = true;
  return r;
}

export interface Cell {
  n: number;
  win: number;
  ttk: number;
  ttd: number;
  taken: number;
  shots: number;
  acc: number;
  idle: number;
  first: number;
}

const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
};

/** `n` duels with seeds 1..n, summed up. */
export function cell(kind: EnemyKind, dist: number, way: Way, kit: Kit, n: number, skill = 1): Cell | null {
  const rs: Duel[] = [];
  for (let i = 1; i <= n; i++) {
    const r = duel(kind, dist, way, kit, i, skill);
    if (!r) return null;
    rs.push(r);
  }
  const wins = rs.filter((r) => r.win);
  const losses = rs.filter((r) => !r.win && !r.draw);
  const shots = rs.reduce((a, r) => a + r.shots, 0);
  const hits = rs.reduce((a, r) => a + r.hits, 0);
  return {
    n,
    win: wins.length / n,
    ttk: median(wins.map((r) => r.time)),
    ttd: median(losses.map((r) => r.time)),
    taken: median(rs.map((r) => r.taken)),
    shots: shots / n,
    acc: shots ? hits / shots : 0,
    idle: rs.reduce((a, r) => a + r.idle / r.time, 0) / n,
    first: median(rs.filter((r) => r.first >= 0).map((r) => r.first)),
  };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/**
 * The gate's check: a casual aim with the starter PIKE against one grunt at 20 and 25 m and one heavy
 * at 25 m, standing, strafing, flanking and from cover. Standing in the open trades about evenly
 * with a grunt over those distances and loses more often to a heavy; strafing, going round and
 * cover each win clearly more often than standing.
 */
export function duelLines(n = 40): { lines: string[]; errors: string[] } {
  const errors: string[] = [];
  const lines: string[] = [];
  const row = (kind: EnemyKind, dist: number) => {
    const c: Partial<Record<Way, Cell>> = {};
    for (const way of ["stand", "strafe", "flank", "cover"] as Way[]) {
      const x = cell(kind, dist, way, STARTER, n);
      if (!x) {
        errors.push(`duel scenario: no ground for a ${way} duel at ${dist} m`);
        return null;
      }
      c[way] = x;
    }
    lines.push(`duel: ${kind} ${dist} m, player win standing ${pct(c.stand!.win)}, strafing ${pct(c.strafe!.win)}, flank ${pct(c.flank!.win)}, cover ${pct(c.cover!.win)}`);
    return c as Record<Way, Cell>;
  };
  const g20 = row("grunt", 20);
  const g25 = row("grunt", 25);
  const h25 = row("heavy", 25);
  if (g20 && g25 && h25) {
    const stand = (g20.stand.win + g25.stand.win) / 2;
    if (stand < 0.3 || stand > 0.7) errors.push(`duel scenario: a player standing in the open beat a grunt at 20-25 m in ${pct(stand)} of duels (want 30-70%)`);
    if (h25.stand.win > g25.stand.win) errors.push(`duel scenario: a standing player beat a heavy at 25 m (${pct(h25.stand.win)}) more often than a grunt (${pct(g25.stand.win)})`);
    for (const way of ["strafe", "flank", "cover"] as Way[]) {
      const w = (g20[way].win + g25[way].win) / 2;
      if (w < stand + 0.15) errors.push(`duel scenario: ${way} beat a grunt at 20-25 m in ${pct(w)} of duels, not clearly more than standing (${pct(stand)})`);
    }
  }
  return { lines, errors };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("ringfall-duel.ts")) {
  const n = Number(process.argv[2] ?? 40);
  const only = process.argv[3];
  const t0 = performance.now();
  console.log(`duels: ${n} seeds each, the player alone with a ${SKILLS[1].name} aim unless noted`);
  console.log("win: player won; ttk / ttd: median seconds to the robot's / the player's fall; taken: median damage the player took");
  console.log("shots: robot shots per duel; acc: share of them that hit; idle: share of the duel the robot could fire but did not; first: median seconds to its first shot");
  console.log(["kit  ", "skill   ", "kind   ", "dist", "way   ", "win ", "ttk ", "ttd ", "taken", "shots", "acc ", "idle", "first"].join(" "));
  const kinds: EnemyKind[] = only ? [only as EnemyKind] : ["grunt", "heavy", "charger", "drone"];
  for (const kit of [STARTER, RARE])
    for (const skill of kit === STARTER ? [0, 1, 2] : [1])
      for (const kind of kinds)
        for (const dist of [15, 20, 25, 40])
          for (const way of ["stand", "strafe", "flank", "cover"] as Way[]) {
            if (skill !== 1 && way !== "stand") continue;
            const c = cell(kind, dist, way, kit, n, skill);
            if (!c) {
              console.log(`${kit.name} ${kind} ${dist} ${way}: no ground`);
              continue;
            }
            const f = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "-");
            console.log([kit.name.padEnd(5), SKILLS[skill].name.padEnd(8), kind.padEnd(7), String(dist).padEnd(4), way.padEnd(6), pct(c.win).padEnd(4), f(c.ttk).padEnd(4), f(c.ttd).padEnd(4), String(Math.round(c.taken)).padEnd(5), c.shots.toFixed(1).padEnd(5), pct(c.acc).padEnd(4), pct(c.idle).padEnd(4), f(c.first)].join(" "));
          }
  const gate = duelLines();
  for (const l of gate.lines) console.log(l);
  for (const e of gate.errors) console.log(`! ${e}`);
  console.log(`(${((performance.now() - t0) / 1000).toFixed(1)} s)`);
}
