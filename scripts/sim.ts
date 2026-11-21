/**
 * Gate 2: bots of three skill levels play the whole run headlessly.
 * Fails (exit 1) when an invariant breaks: NaN positions, entities outside the room,
 * a room that cannot be cleared in 120 s, or a run that never finishes.
 * Prints per-room deaths and clear times so balance changes can be compared.
 */
import { ENEMY, ENEMY_BULLET, PLAYER, TICK, WORLD } from "../src/sim/config";
import { angleTo, lineOfSight, newRun, rand, ROOMS, type Input, type State } from "../src/sim/state";
import { rank, step, totalTime } from "../src/sim/step";

interface Skill { name: string; aimNoiseDeg: number; reactTicks: number; dodge: number }
const SKILLS: Skill[] = [
  { name: "beginner", aimNoiseDeg: 14, reactTicks: 18, dodge: 0.25 },
  { name: "casual", aimNoiseDeg: 7, reactTicks: 10, dodge: 0.55 },
  { name: "good", aimNoiseDeg: 2.5, reactTicks: 5, dodge: 0.85 },
];

function bot(s: State, k: Skill, mem: { aim: { x: number; y: number }; t: number; noise: number }): Input {
  const p = s.player;
  const live = s.enemies.filter((e) => e.mode !== "spawning");
  const target = live.sort((a, b) => Math.hypot(a.pos.x - p.pos.x, a.pos.y - p.pos.y) - Math.hypot(b.pos.x - p.pos.x, b.pos.y - p.pos.y))[0];
  if (--mem.t <= 0) {
    mem.t = k.reactTicks;
    mem.noise = (rand(s as never) - 0.5) * 2 * k.aimNoiseDeg * (Math.PI / 180);
    if (target) {
      const a = angleTo(p.pos, target.pos) + mem.noise;
      mem.aim = { x: p.pos.x + Math.cos(a) * 300, y: p.pos.y + Math.sin(a) * 300 };
    }
  }
  // Move: keep ~220 px from the target, strafe, and sidestep the nearest incoming bullet.
  let mx = 0;
  let my = 0;
  if (target) {
    const d = Math.hypot(target.pos.x - p.pos.x, target.pos.y - p.pos.y);
    const a = angleTo(p.pos, target.pos);
    const sign = d > 260 ? 1 : d < 180 ? -1 : 0;
    mx = Math.cos(a) * sign + Math.cos(a + Math.PI / 2) * 0.7;
    my = Math.sin(a) * sign + Math.sin(a + Math.PI / 2) * 0.7;
  }
  let dash = false;
  const threat = s.bullets.find((b) => b.from === "enemy" && Math.hypot(b.pos.x - p.pos.x, b.pos.y - p.pos.y) < 70);
  const charging = s.enemies.find((e) => e.kind === "rusher" && e.mode === "attacking" && Math.hypot(e.pos.x - p.pos.x, e.pos.y - p.pos.y) < 90);
  const danger = threat ?? charging;
  if (danger && rand(s as never) < k.dodge * 0.25) {
    const v = "vel" in danger ? danger.vel : { x: 0, y: 0 };
    mx = -v.y;
    my = v.x;
    dash = p.dashCooldown <= 0;
  }
  const canSee = !!target && lineOfSight(s, p.pos, target.pos);
  return { move: { x: mx, y: my }, aim: mem.aim, fire: canSee, dash, reload: false };
}

function check(s: State, where: string) {
  const all = [s.player.pos, ...s.enemies.map((e) => e.pos), ...s.bullets.map((b) => b.pos)];
  for (const v of all) {
    if (!Number.isFinite(v.x) || !Number.isFinite(v.y)) throw new Error(`NaN position at ${where}`);
    if (v.x < -1 || v.y < -1 || v.x > WORLD.w + 1 || v.y > WORLD.h + 1) throw new Error(`out of room at ${where}`);
  }
}

const runs = Number(process.argv[2] ?? 40);
let failed = false;
console.log(`${runs} runs per skill. per room: deaths per run / median clear seconds (par)`);
console.log("skill      " + ROOMS.map((r, i) => `R${i + 1}(${r.par}s)`.padEnd(13)).join("") + "finish  hits/run  slowest  crit  rank");
for (const k of SKILLS) {
  const deaths = ROOMS.map(() => 0);
  const times: number[][] = ROOMS.map(() => []);
  let finished = 0;
  let hits = 0;
  let worst = 0;
  let shotsHit = 0;
  let crits = 0;
  const ranks: Record<string, number> = {};
  for (let r = 0; r < runs; r++) {
    let s = newRun(1000 + r);
    const mem = { aim: { x: 480, y: 0 }, t: 0, noise: 0 };
    let roomStartTick = s.tick;
    try {
      while (s.phase !== "done" && s.tick < 60 * 60 * 15) {
        const room = s.room;
        s = step(s, bot(s, k, mem));
        check(s, `${k.name} run ${r} room ${room + 1}`);
        for (const e of s.events) {
          if (e.type === "dead") deaths[room]++;
          if (e.type === "roomClear") {
            times[room].push(e.time);
            worst = Math.max(worst, e.time);
          }
          if (e.type === "roomStart") roomStartTick = s.tick;
        }
        if ((s.tick - roomStartTick) * TICK > 600) throw new Error(`stuck in room ${room + 1} for 600 s (${k.name}, run ${r})`);
      }
      if (s.phase !== "done") throw new Error(`run never finished within 15 min (${k.name}, run ${r}, room ${s.room + 1})`);
      {
        finished++;
        hits += s.hitsTaken;
        shotsHit += s.hits;
        crits += s.crits;
        ranks[rank(s)] = (ranks[rank(s)] ?? 0) + 1;
        if (!Number.isFinite(totalTime(s))) throw new Error("total time is NaN");
      }
    } catch (err) {
      failed = true;
      console.error("INVARIANT:", (err as Error).message);
      break;
    }
  }
  const med = (xs: number[]) => (xs.length ? xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)] : NaN);
  const cells = ROOMS.map((_, i) => `${(deaths[i] / runs).toFixed(1)} / ${med(times[i]).toFixed(1)}`.padEnd(13)).join("");
  const rk = ["S", "A", "B", "C"].map((g) => `${g}${ranks[g] ?? 0}`).join(" ");
  console.log(`${k.name.padEnd(10)} ${cells}${String(Math.round((finished / runs) * 100)).padStart(4)}%   ${(hits / Math.max(1, finished)).toFixed(1).padStart(5)}    ${worst.toFixed(0).padStart(5)}s  ${String(Math.round((crits / Math.max(1, shotsHit)) * 100)).padStart(3)}%  ${rk}`);
}
void ENEMY; void ENEMY_BULLET; void PLAYER;
process.exit(failed ? 1 : 0);
