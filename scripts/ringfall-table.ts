/**
 * One table of RINGFALL's sim gate: a bot of one skill plays `runs` raids in one region.
 * Each raid is played on its own (`playRaid()`, pure data out) and the table is summed up
 * from them in raid order (`summarize()`), so the gate can play the raids of every table in
 * worker processes, in any order, and still print the tables exactly as if it had played
 * them in turn.
 */
import { TICK } from "../src/ringfall/sim/config";
import { BOXES, EXTRACTS, regionOf, type RegionId } from "../src/ringfall/sim/map";
import { inWorld } from "../src/ringfall/sim/geom";
import { Bot, SKILLS, type Skill } from "../src/ringfall/sim/bot";
import { freeKit, newRun, type State } from "../src/ringfall/sim/state";
import { step } from "../src/ringfall/sim/step";
import { rank } from "../src/ringfall/sim/results";
import { recordOf, type RaidRecord } from "./ringfall-pacing";

/** A table's printed lines in order (errors go to stderr), and the raids that ended. */
export type TableResult = { lines: { err: boolean; text: string }[]; records: RaidRecord[]; failed: boolean };

/** What one raid adds to its table: an error, or what the table counts of a raid that ended. */
export type RaidResult = {
  /** Leaps made, counted whether the raid ended or not. */
  ults: number;
  error?: string;
  ended?: {
    record: RaidRecord;
    peakSq: number;
    peakBots: number;
    cleared: number;
    waves: number;
    rank: string;
    /** Minutes, haul and score of a raid that got off. */
    got?: { time: number; haul: number; score: number };
    downs: number;
    shots: number;
    hits: number;
    crits: number;
    flanks: number;
    titanHits: number;
    allyShare: number;
    allyDowns: number;
    rescues: number;
    helped: number;
    exit?: string;
    /** Seconds from the start to the first squad engaging the player (the raid's length if none did). */
    firstMeet: number;
    /** Distinct squads that engaged the player, and how many of them belong to no POI. */
    met: number;
    metAway: number;
    /** The longest stretch of seconds in which no robot was fighting the player. */
    quiet: number;
  };
};

const LIMIT = 30 * 60; // seconds of game time before a run counts as stuck

const median = (xs: number[]) => {
  const a = [...xs].sort((x, y) => x - y);
  return a.length ? a[Math.floor(a.length / 2)] : NaN;
};

/** The boxes by 8 m square, so the check below reads only the square the player stands in. */
const SQUARE = 8;
const squares = new Map<number, typeof BOXES>();
const squareKey = (x: number, z: number) => (Math.floor(x / SQUARE) + 4096) * 8192 + (Math.floor(z / SQUARE) + 4096);
for (const b of BOXES)
  for (let x = Math.floor(b.x0 / SQUARE); x <= Math.floor(b.x1 / SQUARE); x++)
    for (let z = Math.floor(b.z0 / SQUARE); z <= Math.floor(b.z1 / SQUARE); z++) {
      const k = squareKey(x * SQUARE, z * SQUARE);
      const list = squares.get(k);
      if (list) list.push(b);
      else squares.set(k, [b]);
    }

function check(s: State, where: string) {
  const p = s.player.pos;
  if (![p.x, p.y, p.z, s.player.hp, s.player.shield].every(Number.isFinite)) throw new Error(`${where}: player NaN`);
  for (const b of squares.get(squareKey(p.x, p.z)) ?? []) {
    const body = p.y + 0.9;
    const inside = p.x > b.x0 + 0.05 && p.x < b.x1 - 0.05 && p.z > b.z0 + 0.05 && p.z < b.z1 - 0.05 && body > b.y0 && body < b.h;
    if (inside) throw new Error(`${where}: player inside a ${b.kind} at ${p.x.toFixed(1)},${p.z.toFixed(1)}`);
  }
  for (const e of s.enemies) {
    if (![e.pos.x, e.pos.y, e.pos.z, e.hp].every(Number.isFinite)) throw new Error(`${where}: enemy NaN`);
    if (!inWorld(e.pos.x, e.pos.z, -1)) throw new Error(`${where}: enemy off the island`);
  }
}

const skillNamed = (name: string): Skill => {
  const skill = SKILLS.find((k) => k.name === name);
  if (!skill) throw new Error(`unknown skill ${name}`);
  return skill;
};

/** Raid `r` of a table: fixed by its seed, the same wherever and after whatever it is played. */
export function playRaid(region: RegionId, skillName: string, r: number): RaidResult {
  const skill = skillNamed(skillName);
  // Each raid starts at one of the region's ways in, in turn.
  const ways = regionOf(region).entries;
  const s = newRun(1000 + r * 7919, freeKit(), region, { entry: ways[r % ways.length] });
  const bot = new Bot(skill, 31 + r);
  let prevCrouch = false;
  let peakSq = 0;
  let peakBots = 0;
  let ults = 0;
  let firstMeet = -1;
  const met = new Set<number>();
  let fightAt = 0;
  let quiet = 0;
  try {
    while (s.phase !== "done" && s.time < LIMIT) {
      const inp = bot.input(s);
      step(s, inp, prevCrouch);
      prevCrouch = inp.crouch;
      const end = s.events.findIndex((e) => e.t === "done");
      if (end >= 0 && end < s.events.length - 1) throw new Error(`${region} ${skill.name}#${r}: events after the raid ended: ${s.events.slice(end + 1).map((e) => e.t).join(",")}`);
      for (const e of s.events) {
        if (e.t === "leap") ults++;
        if (e.t === "engage") {
          if (firstMeet < 0) firstMeet = s.time;
          met.add(e.squad);
        }
      }
      if (s.enemies.some((e) => e.aware === "engaged" && e.mode !== "spawning")) {
        quiet = Math.max(quiet, s.time - fightAt);
        fightAt = s.time;
      }
      if (!s.enemies.some((e) => e.kind === "titan" && e.aware === "engaged")) {
        const fighting = s.enemies.filter((e) => e.aware === "engaged" && e.mode !== "spawning");
        peakBots = Math.max(peakBots, fighting.length);
        peakSq = Math.max(peakSq, new Set(fighting.map((e) => e.squad)).size);
      }
      if (Math.round(s.time / TICK) % 30 === 0) check(s, `${region} ${skill.name}#${r} t=${s.time.toFixed(1)}`);
    }
  } catch (err) {
    return { ults, error: String(err) };
  }
  if (s.phase !== "done") {
    const p = s.player.pos;
    return {
      ults,
      error: `${region} ${skill.name}#${r}: still on the island after ${LIMIT} s, cleared ${s.stats.cleared.join(",")} player ${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)} enemies near: ${s.enemies.filter((e) => Math.hypot(e.pos.x - p.x, e.pos.z - p.z) < 60).map((e) => `${e.kind}@${e.pos.x.toFixed(0)},${e.pos.z.toFixed(0)}:${e.mode}:${e.aware}`).join(" ")}`,
    };
  }
  const rk = rank(s);
  return {
    ults,
    ended: {
      record: recordOf(s),
      peakSq,
      peakBots,
      cleared: s.stats.cleared.length,
      waves: s.reinforceN,
      rank: rk.rank,
      got: s.outcome === "extracted" ? { time: s.time / 60, haul: rk.haul, score: rk.score } : undefined,
      downs: s.stats.downs,
      shots: s.stats.shots,
      hits: s.stats.hits,
      crits: s.stats.crits,
      flanks: s.stats.flankHits,
      titanHits: s.stats.titanHits,
      allyShare: s.stats.allyDamage / Math.max(1, s.stats.allyDamage + s.stats.damage),
      allyDowns: s.stats.allyDowns,
      rescues: s.stats.allyRescues,
      helped: s.stats.allyHelped,
      exit: s.extractedAt ?? undefined,
      firstMeet: firstMeet < 0 ? s.time : firstMeet,
      met: met.size,
      metAway: [...met].filter((i) => s.squads[i]?.poi === -1).length,
      quiet: Math.max(quiet, s.time - fightAt),
    },
  };
}

/** The table from its raids' results, in raid order. */
export function summarize(region: RegionId, skillName: string, raids: RaidResult[]): TableResult {
  const skill = skillNamed(skillName);
  const runs = raids.length;
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
  const firstMeets: number[] = [];
  const quiets: number[] = [];
  let met = 0;
  let metAway = 0;
  const ranks: Record<string, number> = { S: 0, A: 0, B: 0, C: 0, "-": 0 };
  for (const raid of raids) {
    ults += raid.ults;
    const e = raid.ended;
    if (!e) {
      out.failed = true;
      out.lines.push({ err: true, text: raid.error ?? "" });
      continue;
    }
    ended++;
    out.records.push(e.record);
    crowdSq.push(e.peakSq);
    crowdBots.push(e.peakBots);
    clearedN.push(e.cleared);
    waves.push(e.waves);
    ranks[e.rank]++;
    if (e.got) {
      alive++;
      times.push(e.got.time);
      hauls.push(e.got.haul);
      scores.push(e.got.score);
    }
    downs += e.downs;
    shots += e.shots;
    hits += e.hits;
    crits += e.crits;
    flanks += e.flanks;
    titanHits += e.titanHits;
    allyDmg += e.allyShare;
    allyDowns += e.allyDowns;
    rescues += e.rescues;
    helped += e.helped;
    if (e.exit) exits[e.exit]++;
    firstMeets.push(e.firstMeet);
    quiets.push(e.quiet);
    met += e.met;
    metAway += e.metAway;
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
      `${Math.round(median(firstMeets))}s ${Math.round(median(quiets))}s ${(met / n).toFixed(1)}/${(metAway / n).toFixed(1)}`.padEnd(18),
      `${Math.round((allyDmg / n) * 100)}% ${(allyDowns / n).toFixed(1)}d ${(rescues / n).toFixed(1)}r ${(helped / n).toFixed(1)}h`.padEnd(18),
      `S${ranks.S} A${ranks.A} B${ranks.B} C${ranks.C} -${ranks["-"]}`.padEnd(18),
      regionOf(region).exits.map((id) => `${id} ${exits[id]}`).join(" "),
    ].join(" "),
  });
  return out;
}

/** A whole table played in turn, in this process. */
export const playTable = (region: RegionId, skillName: string, runs: number): TableResult =>
  summarize(
    region,
    skillName,
    Array.from({ length: runs }, (_, r) => playRaid(region, skillName, r)),
  );
