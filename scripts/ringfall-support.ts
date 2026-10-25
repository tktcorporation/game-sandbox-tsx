/**
 * The player's own robots help the player (see SUPPORT in config.ts): the player stands on open
 * ground with a pair of the network's grunts 25 m ahead fighting them, and a pair of the
 * player's robots stands 40 m to the side, looking away. Within `LIMIT` seconds the player's
 * pair takes one of the grunts as its foe and hurts them, in every seed; and the grunts, shot
 * by them, turn on them and hit them in some seeds at least. The player does nothing and
 * cannot fall.
 *
 * `checkSupport()` gives the sim gate's error, or null; run this file alone
 * (`npx tsx scripts/ringfall-support.ts [seeds]`) for each seed's numbers.
 */
import { BOXES } from "../src/ringfall/sim/map";
import { inArea } from "../src/ringfall/sim/areas";
import { groundAt, inWorld } from "../src/ringfall/sim/geom";
import { offLowGround, terrainHeight } from "../src/ringfall/sim/terrain";
import { idleInput, newRun, type Enemy, type State } from "../src/ringfall/sim/state";
import { step } from "../src/ringfall/sim/step";
import { spawnEnemy } from "../src/ringfall/sim/enemies";
import { engageSquad } from "../src/ringfall/sim/awareness";
import { POIS } from "../src/ringfall/sim/map";
import { TICK } from "../src/ringfall/sim/config";

const LIMIT = 16;
const SEEDS = 8;

/** Open level ground on the harbor's salt flats: `back` metres toward -z and `side` toward +x clear of boxes. */
function openGround(back: number, side: number): { x: number; z: number } | null {
  const [lx, lz] = inArea("bay", -55, -500);
  for (let ring = 0; ring < 800; ring += 4)
    for (let a = 0; a < 2 * Math.PI; a += 4 / Math.max(ring, 8)) {
      const x = lx + Math.cos(a) * ring;
      const z = lz + Math.sin(a) * ring;
      if (!inWorld(x, z, 5) || offLowGround(x, z)) continue;
      const g = terrainHeight(x, z);
      let ok = !BOXES.some((b) => b.x1 > x - 6 && b.x0 < x + side && b.z1 > z - back && b.z0 < z + 4 && b.y0 < g + 3);
      for (let dx = -6; dx <= side && ok; dx += 2) for (let dz = -4; dz <= back && ok; dz += 2) if (Math.abs(terrainHeight(x + dx, z - dz) - g) > 0.6) ok = false;
      if (ok) return { x, z };
    }
  return null;
}

export interface Support {
  /** Seconds to the player's pair setting on a grunt, or -1. */
  found: number;
  /** Damage the grunts took (all of it the player's robots'). */
  dealt: number;
  /** Whether a grunt turned on the player's robots, and the damage those took. */
  turned: boolean;
  taken: number;
}

/** One seed of the scene. */
export function supportRun(seed: number, at: { x: number; z: number }): Support {
  const s: State = newRun(seed);
  s.enemies = [];
  s.phase = "play";
  s.cleared = POIS.map(() => true);
  s.visited = POIS.map(() => true);
  s.reinforceT = s.raiderT = 1e9;
  s.parties = [];
  s.crewsDue = [];
  s.ally.active = false;
  const p = s.player;
  p.pos = { x: at.x, y: groundAt(at.x, at.z, 0.4, terrainHeight(at.x, at.z) + 2), z: at.z };
  p.vel = { x: 0, y: 0, z: 0 };
  p.yaw = 0;
  p.onGround = true;
  p.hp = 1e7;
  const foeSquad = s.squads.length;
  s.squads.push({ name: "test", poi: -1, patrol: [], leg: 0, engaged: false, roam: false, sinceSeen: 0, last: { x: at.x, z: at.z } });
  const foes = [-1.5, 1.5].map((dx) => spawnEnemy(s, "grunt", at.x + dx, at.z - 25, -1, foeSquad, { face: Math.PI }));
  engageSquad(s, foeSquad, foes[0]);
  for (const e of foes) {
    e.blind = 0;
    e.sawAt = { x: p.pos.x, z: p.pos.z };
  }
  const own = s.squads.length;
  s.squads.push({ name: "own", poi: -1, patrol: [], leg: 0, engaged: false, roam: false, sinceSeen: 0, last: { x: at.x, z: at.z }, friend: true });
  const friends: Enemy[] = [-1.5, 1.5].map((dz) => {
    const e = spawnEnemy(s, "grunt", at.x + 40, at.z + dz, -1, own, { face: Math.PI / 2, plate: 0 });
    e.friend = true;
    s.enemies.pop();
    s.friends.push(e);
    return e;
  });
  const health = (l: Enemy[]) => l.reduce((n, e) => n + e.hp + e.shield, 0);
  const foesFull = health(foes);
  const friendsFull = health(friends);
  let found = -1;
  let turned = false;
  for (let i = 0; i < LIMIT / TICK && s.phase === "play"; i++) {
    step(s, idleInput(), false);
    const f = s.squads[own].foe;
    if (found < 0 && f !== undefined && foes.some((e) => e.id === f)) found = s.time;
    if (foes.some((e) => s.enemies.includes(e) && (e.target as string) === "friend")) turned = true;
  }
  return {
    found,
    dealt: foesFull - health(foes.filter((e) => s.enemies.includes(e))),
    turned,
    taken: friendsFull - health(friends.filter((e) => s.friends.includes(e))),
  };
}

/** The sim gate's check: null, or what went wrong. */
export function checkSupport(seeds = SEEDS): string | null {
  const at = openGround(32, 46);
  if (!at) return "support: no open ground for the test";
  const runs = Array.from({ length: seeds }, (_, k) => supportRun(k + 1, at));
  const idle = runs.findIndex((r) => r.found < 0 || r.dealt <= 0);
  if (idle >= 0) return `support: seed ${idle + 1}: the player's robots 40 m off ${runs[idle].found < 0 ? "never set on the robots fighting the player" : "never hurt the robots fighting the player"} in ${LIMIT} s`;
  const turned = runs.filter((r) => r.turned && r.taken > 0).length;
  if (turned < 2) return `support: the robots fighting the player turned on the player's robots shooting them in ${turned} of ${seeds} seeds`;
  return null;
}

if (process.argv[1]?.endsWith("ringfall-support.ts")) {
  const n = Number(process.argv[2] ?? SEEDS);
  const at = openGround(32, 46);
  if (!at) throw new Error("no open ground");
  for (let k = 1; k <= n; k++) {
    const r = supportRun(k, at);
    console.log(`seed ${k}: found ${r.found.toFixed(2)} s, dealt ${Math.round(r.dealt)}, turned ${r.turned}, taken ${Math.round(r.taken)}`);
  }
  console.log(checkSupport(n) ?? "support ok");
}
