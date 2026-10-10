/**
 * Gate 2 for RINGFALL: bots of three skills play the whole run headless.
 * Fails if any run does not finish, or if an invariant breaks (NaN, a body inside
 * a box, an enemy outside the island). Prints the table kept in docs/ringfall/balance.md.
 *
 *   npm run sim:ringfall -- [runsPerSkill]
 */
import { TICK, WORLD } from "../src/ringfall/sim/config";
import { BOXES, EXTRA_BINS, EXTRACT, POIS } from "../src/ringfall/sim/map";
import { collide, groundAt, solidAt } from "../src/ringfall/sim/geom";
import { Bot, SKILLS } from "../src/ringfall/sim/bot";
import { newRun, type State } from "../src/ringfall/sim/state";
import { step } from "../src/ringfall/sim/step";
import { rank } from "../src/ringfall/sim/results";

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
  POIS.forEach((p, i) => {
    point(`POI ${i} entry`, p.entry.x, p.entry.z);
    p.bins.forEach((b) => point(`POI ${i} bin`, b.x, b.z, b.y ?? 0));
    p.floor.forEach((f) => point(`POI ${i} floor loot`, f.x, f.z, f.y ?? 0));
    // Spawns are pushed out of walls the same way spawnEnemy does, then checked.
    p.waves.forEach((w, wi) =>
      w.forEach((sp) => {
        if (sp.kind === "drone" || sp.kind === "titan") return;
        const pos = { x: p.x + sp.dx, y: sp.y ?? 0, z: p.z + sp.dz };
        collide(pos, 0.7, 2);
        point(`POI ${i} wave ${wi} ${sp.kind}`, +pos.x.toFixed(1), +pos.z.toFixed(1), sp.y ?? groundAt(pos.x, pos.z, 0.3, 0.3));
      }),
    );
    if (p.carePackage) point(`POI ${i} care package`, p.carePackage.x, p.carePackage.z);
  });
  EXTRA_BINS.forEach((b) => point("extra bin", b.x, b.z));
  point("extract", EXTRACT.x, EXTRACT.z, 0.25);
  return bad;
}

const layout = checkLayout();
if (layout.length) {
  console.error(layout.join("\n"));
  process.exit(1);
}
console.log(`layout ok: ${BOXES.length} boxes`);

const median = (xs: number[]) => {
  const a = [...xs].sort((x, y) => x - y);
  return a.length ? a[Math.floor(a.length / 2)] : NaN;
};

let failed = false;
const head = ["skill    ", ...POIS.map((p, i) => `P${i + 1} ${p.name}`.padEnd(14)), "extract", "finish", "total(med)", "downs", "wipes", "acc", "crit", "ult", "rank"];
console.log(`${runs} runs per skill. per POI: median seconds from the previous objective, downs+wipes per run`);
console.log(head.join(" "));
for (const skill of SKILLS) {
  const per: number[][] = POIS.map(() => []);
  const perDowns = POIS.map(() => 0);
  const ext: number[] = [];
  const totals: number[] = [];
  let finished = 0;
  let downs = 0;
  let wipes = 0;
  let shots = 0;
  let hits = 0;
  let crits = 0;
  let ults = 0;
  const ranks: Record<string, number> = { S: 0, A: 0, B: 0, C: 0 };
  for (let r = 0; r < runs; r++) {
    const s = newRun(1000 + r * 7919);
    const bot = new Bot(skill, 31 + r);
    let prevCrouch = false;
    try {
      while (s.phase !== "done" && s.time < LIMIT) {
        const inp = bot.input(s);
        step(s, inp, prevCrouch);
        prevCrouch = inp.crouch;
        for (const e of s.events) {
          if (e.t === "ultStart") ults++;
          if (e.t === "down" || e.t === "wipe") perDowns[Math.min(s.poi, POIS.length - 1)] += e.t === "wipe" ? 1 : 1;
        }
        if (Math.round(s.time / TICK) % 30 === 0) check(s, `${skill.name}#${r} t=${s.time.toFixed(1)} poi=${s.poi}`);
      }
    } catch (err) {
      failed = true;
      console.error(String(err));
      continue;
    }
    if (s.phase !== "done") {
      failed = true;
      const p = s.player.pos;
      console.error(`${skill.name}#${r}: stuck at poi ${s.poi} wave ${s.wave} enemies ${s.enemies.map((e) => `${e.kind}@${e.pos.x.toFixed(0)},${e.pos.z.toFixed(0)}:${e.mode}`).join(" ")} player ${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}`);
      continue;
    }
    finished++;
    s.stats.poiTimes.slice(0, POIS.length).forEach((t, i) => per[i].push(t));
    ext.push(s.stats.poiTimes[POIS.length] ?? NaN);
    const rk = rank(s);
    totals.push(rk.total);
    ranks[rk.rank]++;
    downs += s.stats.downs;
    wipes += s.stats.wipes;
    shots += s.stats.shots;
    hits += s.stats.hits;
    crits += s.stats.crits;
  }
  const n = Math.max(finished, 1);
  console.log(
    [
      skill.name.padEnd(9),
      ...per.map((xs, i) => `${median(xs).toFixed(0)}s ${(perDowns[i] / n).toFixed(1)}d`.padEnd(14)),
      `${median(ext).toFixed(0)}s`.padEnd(7),
      `${Math.round((finished / runs) * 100)}%`.padEnd(6),
      `${median(totals).toFixed(0)}s`.padEnd(10),
      (downs / n).toFixed(1).padEnd(5),
      (wipes / n).toFixed(1).padEnd(5),
      `${Math.round((hits / Math.max(shots, 1)) * 100)}%`.padEnd(3),
      `${Math.round((crits / Math.max(hits, 1)) * 100)}%`.padEnd(4),
      (ults / n).toFixed(1).padEnd(3),
      `S${ranks.S} A${ranks.A} B${ranks.B} C${ranks.C}`,
    ].join(" "),
  );
}
if (failed) {
  console.error("FAILED");
  process.exit(1);
}
