/**
 * The island over a month for RINGFALL's sim gate: for each skill, a bot plays `DAYS`
 * consecutive days on one profile, so the POIs' standings and the network carry from raid to
 * raid. Each day the bot starts in the region with the most nodes on the front (then the most POIs
 * the robots still hold, the reservoir on a tie), at one of its ways in in turn, plays its normal
 * raid on the lent kit, and the raid is settled as a player's would be: the nodes whose cores it
 * captured and got off alive with are freed,
 * the masts it shot down count, and the network moves. The day's island event (a debris fall, a
 * retake, a storm, a crews' visit) comes as announced, and the salvage crews that get off raise the
 * network. It takes no contract and spends nothing.
 *
 *   npx tsx scripts/ringfall-campaign.ts [days]
 *
 * The skills are played in one worker process each, side by side; the gate starts them beside
 * its tables and prints the table after the hideout's pacing (scripts/ringfall-sim.ts).
 */
import { NETWORK } from "../src/ringfall/sim/config";
import { ENTRIES, POIS, REGIONS, regionOf, type RegionId } from "../src/ringfall/sim/map";
import { SKILLS } from "../src/ringfall/sim/bot";
import { freeKit, newRun } from "../src/ringfall/sim/state";
import { holds, islandHolds, unfreeable } from "../src/ringfall/meta/island";
import { frontNodes } from "../src/ringfall/sim/front";
import { NODES } from "../src/ringfall/sim/map";
import { newProfile, settle, type Profile } from "../src/ringfall/meta/profile";
import { playState } from "./ringfall-table";
import { fork } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DAYS = 30;
/** The days the table reports the island on. */
const MARKS = [5, 10, 20, 30];

/** One skill's month: the island at the end of each day, and how each raid ended. */
export interface Campaign {
  skill: string;
  days: { network: number; freed: number; thin: number; nodes: number; harbor: number; front: string[]; alive: boolean; region: RegionId; relays: number; event: string | null; crewsIn: number; crewsOut: number; overrun: number }[];
  errors: string[];
}

/** Nodes on the front in a region, then POIs the robots hold there (thin ones half): where the bot has most to do. */
const work = (p: Profile, r: RegionId) => {
  const front = frontNodes(islandHolds(p));
  return 100 * NODES.filter((n, i) => front[i] && n.region === r).length + regionOf(r).pois.filter((id) => !unfreeable(id)).reduce((n, id) => n + (p.poiState[id].state === "held" ? 1 : p.poiState[id].state === "thin" ? 0.5 : 0), 0);
};

/** A month of one skill on a fresh profile that knows every way in, as a player some raids in does. */
export function playCampaign(skill: string, days = DAYS): Campaign {
  let p: Profile = { ...newProfile(17), entries: ENTRIES.map((e) => e.id) };
  const out: Campaign = { skill, days: [], errors: [] };
  for (let d = 1; d <= days; d++) {
    const region = REGIONS.map((r) => r.id).reduce((a, b) => (work(p, b) > work(p, a) ? b : a));
    const ways = regionOf(region).entries;
    const s = newRun(p.seed, freeKit(), region, { depots: p.depots, seen: p.seen, routes: p.routes, island: holds(p), outposts: p.outposts, entry: ways[d % ways.length], network: p.network, event: p.events[0] });
    const res = playState(s, skill, 500 + d);
    if (res.error) out.errors.push(`campaign ${skill} day ${d}: ${res.error}`);
    const settled = settle(p, s);
    p = settled.profile;
    const count = (h: "freed" | "thin") => POIS.filter((o) => p.poiState[o.id].state === h).length;
    const h = islandHolds(p);
    out.days.push({ network: p.network, freed: count("freed"), thin: count("thin"), nodes: h.filter((x) => x === "freed").length, harbor: NODES.filter((n, i) => n.region === "harbor" && h[i] === "freed").length, front: NODES.filter((_, i) => frontNodes(h)[i]).map((n) => n.id), alive: s.outcome === "extracted", region, relays: s.stats.relays.length, event: s.event?.t ?? null, crewsIn: s.stats.crewsIn, crewsOut: s.stats.crewsOut, overrun: settled.overrun.length });
  }
  return out;
}

/** The table's lines, from each skill's month. */
export function campaignLines(runs: Campaign[]): string[] {
  const lines = [
    `${runs[0]?.days.length ?? 0} consecutive days per skill on one profile (scripts/ringfall-campaign.ts). net: the network at the end of the day (starts at ${NETWORK.start}); freed / thin: POIs of the 6 that can be freed; n: nodes of the ${NODES.length} the player holds (POIs and outposts)`,
    ["skill    ", ...MARKS.map((m) => `day ${m}`.padEnd(18)), "alive".padEnd(6), "net(mean)".padEnd(10), "days in".padEnd(22), "masts", "events d/r/s/c".padEnd(14), "crews in/out", "lost"].join(" "),
  ];
  for (const c of runs) {
    const at = (m: number) => c.days[m - 1];
    const cells = MARKS.map((m) => (at(m) ? `${at(m).network} ${at(m).freed}/${at(m).thin} n${at(m).nodes}` : "-").padEnd(18));
    const alive = c.days.filter((d) => d.alive).length / Math.max(1, c.days.length);
    const mean = c.days.reduce((n, d) => n + d.network, 0) / Math.max(1, c.days.length);
    const regions = REGIONS.map((r) => `${r.id} ${c.days.filter((d) => d.region === r.id).length}`).join(" ");
    const ev = (k: string) => c.days.filter((d) => d.event === k).length;
    const sum = (f: (d: Campaign["days"][number]) => number) => c.days.reduce((n, d) => n + f(d), 0);
    lines.push(
      [c.skill.padEnd(9), ...cells, `${Math.round(alive * 100)}%`.padEnd(6), mean.toFixed(1).padEnd(10), regions.padEnd(22), String(sum((d) => d.relays)).padEnd(5), `${ev("debris")}/${ev("retake")}/${ev("storm")}/${ev("crews")}`.padEnd(14), `${sum((d) => d.crewsIn)}/${sum((d) => d.crewsOut)}`.padEnd(12), String(sum((d) => d.overrun))].join(" "),
    );
  }
  lines.push(`network by day: ${runs.map((c) => `${c.skill} ${c.days.map((d) => d.network).join("")}`).join(" / ")}`);
  // The nodes held each day (in base 36: a is 10), and the harbor's among them.
  lines.push(`nodes by day: ${runs.map((c) => `${c.skill} ${c.days.map((d) => d.nodes.toString(36)).join("")}`).join(" / ")}`);
  lines.push(`harbor nodes by day: ${runs.map((c) => `${c.skill} ${c.days.map((d) => d.harbor.toString(36)).join("")}`).join(" / ")}`);
  // Where the front stands at the end of the month: the nodes the player could take next.
  for (const c of runs) lines.push(`front on day ${c.days.length} (${c.skill}): ${c.days.at(-1)?.front.join(" ") || "-"}`);
  lines.push("events: days with a debris fall / retake / storm / crews' visit; crews in/out: salvage crews that came and got off; lost: freed POIs a retake left alive turned thin");
  return lines;
}

/** Each skill's month in a worker of its own (one process when `jobs` is 1), in skill order. */
export async function campaigns(days = DAYS, jobs = SKILLS.length): Promise<Campaign[]> {
  if (jobs <= 1) return SKILLS.map((k) => playCampaign(k.name, days));
  const worker = fileURLToPath(new URL("./ringfall-campaign-worker.ts", import.meta.url));
  return Promise.all(
    SKILLS.map(
      (k) =>
        new Promise<Campaign>((done, fail) => {
          const w = fork(worker, { serialization: "advanced" });
          // A month runs for minutes without looking up: a gate that exits early stops it now.
          const stop = () => w.kill();
          process.on("exit", stop);
          w.once("exit", () => process.off("exit", stop));
          w.once("message", (c: Campaign) => {
            done(c);
            w.disconnect();
          });
          w.once("error", fail);
          w.once("exit", (code) => code && fail(new Error(`campaign worker for ${k.name} exited with ${code}`)));
          w.send({ skill: k.name, days });
        }),
    ),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const runs = await campaigns(Number(process.argv[2] ?? DAYS));
  for (const l of campaignLines(runs)) console.log(l);
  const errors = runs.flatMap((c) => c.errors);
  if (errors.length) {
    for (const e of errors) console.error(e);
    process.exit(1);
  }
}
