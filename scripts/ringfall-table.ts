/**
 * One table of RINGFALL's sim gate: a bot of one skill plays `runs` raids in one region.
 * Pure data in and out, so the gate can play tables in worker processes and still print
 * them exactly as if it had played them in turn.
 */
import { TICK } from "../src/ringfall/sim/config";
import { BOXES, EXTRACTS, regionOf, type RegionId } from "../src/ringfall/sim/map";
import { inWorld } from "../src/ringfall/sim/geom";
import { Bot, SKILLS } from "../src/ringfall/sim/bot";
import { freeKit, newRun, type State } from "../src/ringfall/sim/state";
import { step } from "../src/ringfall/sim/step";
import { rank } from "../src/ringfall/sim/results";
import { recordOf, type RaidRecord } from "./ringfall-pacing";

/** A table's printed lines in order (errors go to stderr), and the raids that ended. */
export type TableResult = { lines: { err: boolean; text: string }[]; records: RaidRecord[]; failed: boolean };

const LIMIT = 30 * 60; // seconds of game time before a run counts as stuck

const median = (xs: number[]) => {
  const a = [...xs].sort((x, y) => x - y);
  return a.length ? a[Math.floor(a.length / 2)] : NaN;
};

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
    if (!inWorld(e.pos.x, e.pos.z, -1)) throw new Error(`${where}: enemy off the island`);
  }
}

export function playTable(region: RegionId, skillName: string, runs: number): TableResult {
  const skill = SKILLS.find((k) => k.name === skillName);
  if (!skill) throw new Error(`unknown skill ${skillName}`);
  const out: TableResult = { lines: [], records: [], failed: false };
  const times: number[] = [];
  const clearedN: number[] = [];
  const hauls: number[] = [];
  const scores: number[] = [];
  const waves: number[] = [];
  let ended = 0;
  let alive = 0;
  let downs = 0;
  let shots = 0;
  let hits = 0;
  let crits = 0;
  let flanks = 0;
  let titanHits = 0;
  let ults = 0;
  let allyDmg = 0;
  let allyDowns = 0;
  let rescues = 0;
  let helped = 0;
  const exits: Record<string, number> = Object.fromEntries(EXTRACTS.map((x) => [x.id, 0]));
  const crowdSq: number[] = [];
  const crowdBots: number[] = [];
  const ranks: Record<string, number> = { S: 0, A: 0, B: 0, C: 0, "-": 0 };
  for (let r = 0; r < runs; r++) {
    // Each raid starts at one of the region's ways in, in turn.
    const ways = regionOf(region).entries;
    const s = newRun(1000 + r * 7919, freeKit(), region, { entry: ways[r % ways.length] });
    const bot = new Bot(skill, 31 + r);
    let prevCrouch = false;
    let peakSq = 0;
    let peakBots = 0;
    try {
      while (s.phase !== "done" && s.time < LIMIT) {
        const inp = bot.input(s);
        step(s, inp, prevCrouch);
        prevCrouch = inp.crouch;
        const end = s.events.findIndex((e) => e.t === "done");
        if (end >= 0 && end < s.events.length - 1) throw new Error(`${region} ${skill.name}#${r}: events after the raid ended: ${s.events.slice(end + 1).map((e) => e.t).join(",")}`);
        for (const e of s.events) {
          if (e.t === "leap") ults++;
        }
        if (!s.enemies.some((e) => e.kind === "titan" && e.aware === "engaged")) {
          const fighting = s.enemies.filter((e) => e.aware === "engaged" && e.mode !== "spawning");
          peakBots = Math.max(peakBots, fighting.length);
          peakSq = Math.max(peakSq, new Set(fighting.map((e) => e.squad)).size);
        }
        if (Math.round(s.time / TICK) % 30 === 0) check(s, `${region} ${skill.name}#${r} t=${s.time.toFixed(1)}`);
      }
    } catch (err) {
      out.failed = true;
      out.lines.push({ err: true, text: String(err) });
      continue;
    }
    if (s.phase !== "done") {
      out.failed = true;
      const p = s.player.pos;
      out.lines.push({ err: true, text: `${region} ${skill.name}#${r}: still on the island after ${LIMIT} s, cleared ${s.stats.cleared.join(",")} player ${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)} enemies near: ${s.enemies.filter((e) => Math.hypot(e.pos.x - p.x, e.pos.z - p.z) < 60).map((e) => `${e.kind}@${e.pos.x.toFixed(0)},${e.pos.z.toFixed(0)}:${e.mode}:${e.aware}`).join(" ")}` });
      continue;
    }
    ended++;
    out.records.push(recordOf(s));
    crowdSq.push(peakSq);
    crowdBots.push(peakBots);
    clearedN.push(s.stats.cleared.length);
    waves.push(s.reinforceN);
    const rk = rank(s);
    ranks[rk.rank]++;
    if (s.outcome === "extracted") {
      alive++;
      times.push(s.time / 60);
      hauls.push(rk.haul);
      scores.push(rk.score);
    }
    downs += s.stats.downs;
    shots += s.stats.shots;
    hits += s.stats.hits;
    crits += s.stats.crits;
    flanks += s.stats.flankHits;
    titanHits += s.stats.titanHits;
    allyDmg += s.stats.allyDamage / Math.max(1, s.stats.allyDamage + s.stats.damage);
    allyDowns += s.stats.allyDowns;
    rescues += s.stats.allyRescues;
    helped += s.stats.allyHelped;
    if (s.extractedAt) exits[s.extractedAt]++;
  }
  const n = Math.max(ended, 1);
  out.lines.push({
    err: false,
    text: [
      skill.name.padEnd(9),
      `${Math.round((alive / runs) * 100)}%`.padEnd(5),
      `${median(times).toFixed(1)}m`.padEnd(9),
      String(median(clearedN)).padEnd(7),
      String(median(hauls)).padEnd(9),
      String(median(scores)).padEnd(10),
      (downs / n).toFixed(1).padEnd(5),
      `${Math.round((hits / Math.max(shots, 1)) * 100)}%`.padEnd(3),
      `${Math.round((crits / Math.max(hits, 1)) * 100)}%`.padEnd(4),
      (ults / n).toFixed(1).padEnd(3),
      `${median(crowdSq)}/${median(crowdBots)}`.padEnd(5),
      `${Math.round((flanks / Math.max(hits - titanHits, 1)) * 100)}%`.padEnd(5),
      String(median(waves)).padEnd(5),
      `${Math.round((allyDmg / n) * 100)}% ${(allyDowns / n).toFixed(1)}d ${(rescues / n).toFixed(1)}r ${(helped / n).toFixed(1)}h`.padEnd(18),
      `S${ranks.S} A${ranks.A} B${ranks.B} C${ranks.C} -${ranks["-"]}`.padEnd(18),
      regionOf(region).exits.map((id) => `${id} ${exits[id]}`).join(" "),
    ].join(" "),
  });
  return out;
}
