/**
 * Several months of RINGFALL's island campaign, outside the sim gate: for each skill, `months`
 * fresh profiles (each from its own seed) play `days` consecutive days as the gate's campaign
 * does (`playCampaign()` in scripts/ringfall-campaign.ts): raids that are the day's battle, the
 * factory raised from what they bring home, the nodes carried from day to day. One month is one
 * job, and the jobs share the machine's cores.
 *
 *   npx tsx scripts/ringfall-months.ts [months] [days]      (npm run months:ringfall -- 4 30)
 *
 * The gate plays one month per skill, so a skill's numbers there rest on one string of seeds;
 * here several strings show how far a month's outcome swings, and the factory's climb to its top.
 */
import "./ringfall-terrain-store";
import { fork } from "node:child_process";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { SKILLS } from "../src/ringfall/sim/bot";
import { NODES } from "../src/ringfall/sim/map";
import { FACTORY_TOP } from "../src/ringfall/sim/config";
import { DAYS, type Campaign } from "./ringfall-campaign";

const months = Math.max(1, Number(process.argv[2] ?? 4) || 1);
const days = Math.max(1, Number(process.argv[3] ?? DAYS) || DAYS);
/** A month's profile seed: the gate's month is seed 17, the first here. */
const seedOf = (m: number) => 17 + 7919 * m;

interface Job { skill: string; month: number; seed: number }
const jobs: Job[] = SKILLS.flatMap((k) => Array.from({ length: months }, (_, m) => ({ skill: k.name, month: m, seed: seedOf(m) })));
const results = new Map<string, Campaign>();
const key = (j: Job) => `${j.skill}/${j.month}`;

/**
 * The jobs on one worker per core, each worker playing month after month, so a process builds
 * the map, the terrain and the walkers' grids once rather than once a month.
 */
async function runAll(): Promise<void> {
  const worker = fileURLToPath(new URL("./ringfall-campaign-worker.ts", import.meta.url));
  let next = 0;
  const lanes = Array.from({ length: Math.min(jobs.length, availableParallelism()) }, () =>
    new Promise<void>((done, fail) => {
      const w = fork(worker, { serialization: "advanced" });
      const stop = () => w.kill();
      process.on("exit", stop);
      let job: Job | undefined;
      const give = () => {
        job = jobs[next++];
        if (job) w.send({ skill: job.skill, days, seed: job.seed });
        else w.disconnect();
      };
      w.on("message", (m: Campaign) => {
        results.set(key(job!), m);
        console.error(`done ${key(job!)}`);
        give();
      });
      w.once("error", fail);
      w.once("exit", (code) => {
        process.off("exit", stop);
        if (code) fail(new Error(`worker exited with ${code}${job ? ` during ${key(job)}` : ""}`));
        else done();
      });
      give();
    }),
  );
  await Promise.all(lanes);
}

const med = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};

const t0 = performance.now();
await runAll();
console.log(`${months} months of ${days} days per skill (scripts/ringfall-months.ts), ${((performance.now() - t0) / 1000).toFixed(0)} s on ${Math.min(jobs.length, availableParallelism())} processes`);
console.log(`n: nodes of the ${NODES.length} the player holds at the month's end; f: the factory's level at its end (of ${FACTORY_TOP}); alive: raids got off alive`);
console.log(["skill    ", "n min/med/max".padEnd(14), "f min/med/max".padEnd(14), "alive".padEnd(6), `first day at factory level 1-${FACTORY_TOP} (median, - never)`].join(" "));
const errors: string[] = [];
for (const k of SKILLS) {
  const runs = Array.from({ length: months }, (_, m) => results.get(`${k.name}/${m}`)!);
  errors.push(...runs.flatMap((c) => c.errors));
  const end = runs.map((c) => c.days[c.days.length - 1]);
  const n = end.map((d) => d.nodes);
  const f = end.map((d) => d.factory);
  const alive = runs.flatMap((c) => c.days).filter((d) => d.alive).length / Math.max(1, runs.reduce((s, c) => s + c.days.length, 0));
  const firsts = Array.from({ length: FACTORY_TOP }, (_, l) => {
    const at = runs.map((c) => c.days.findIndex((d) => d.factory >= l + 1)).filter((i) => i >= 0).map((i) => i + 1);
    return at.length * 2 > runs.length ? String(med(at)) : "-";
  });
  console.log([k.name.padEnd(9), `${Math.min(...n)}/${med(n)}/${Math.max(...n)}`.padEnd(14), `${Math.min(...f)}/${med(f)}/${Math.max(...f)}`.padEnd(14), `${(alive * 100).toFixed(0)}%`.padEnd(6), firsts.join(" ")].join(" "));
}
console.log("by month, nodes held each day (a 10, b 11...) | factory level each day:");
for (const k of SKILLS)
  for (let m = 0; m < months; m++) {
    const c = results.get(`${k.name}/${m}`)!;
    console.log(`${k.name.padEnd(9)} ${String(m + 1).padStart(2)}  ${c.days.map((d) => d.nodes.toString(36)).join("")} | ${c.days.map((d) => d.factory).join("")}`);
  }
if (errors.length) {
  for (const e of errors) console.error(e);
  process.exit(1);
}
