/**
 * The island over a month for RINGFALL's sim gate: for each skill, a bot plays `DAYS`
 * consecutive days on one profile, so the six nodes' holders carry from raid to raid. Each day
 * the bot starts in the region with the most nodes on the front (then the most POIs the enemy
 * still holds, the reservoir on a tie), at one of its ways in in turn, plays its normal raid with
 * the best guns and armour of its stash, and the raid is settled as a player's would be. The day's island event (a debris
 * fall, a storm, a crews' visit) comes as announced. Each raid is the day's battle (陣取り戦,
 * sim/battle.ts) with the factory the profile has built: whoever holds each node when the battle
 * ends holds it the next day. It takes no contract. Before the first day and after each it buys
 * gear (`gearUp()`), sells everything in the stash but that kit, the starter weapons (not for
 * sale) and the valuables the factory's next levels ask for, and raises the factory whenever the stash and the credits allow, buying from the
 * trader the materials the stash lacks; it spends on nothing else.
 *
 *   npx tsx scripts/ringfall-campaign.ts [days]
 *
 * The skills are played in one worker process each, side by side; the gate starts them beside
 * its tables and prints the table after the hideout's pacing (scripts/ringfall-sim.ts).
 */
import "./ringfall-terrain-store";
import { ENTRIES, NODES, POIS, REGIONS, regionOf, TIER, type NodeId, type RegionId } from "../src/ringfall/sim/map";
import { SKILLS } from "../src/ringfall/sim/bot";
import { newRun, strengthFor } from "../src/ringfall/sim/state";
import { holds, islandHolds, unfreeable } from "../src/ringfall/meta/island";
import { enemyNodes, frontNodes } from "../src/ringfall/sim/front";
import { buildFactory, buy, buyPrice, emptyLoadout, factoryShortfall, newProfile, nextFactory, sell, settle, takeKit, wares, type Item, type Profile } from "../src/ringfall/meta/profile";
import { shopRarity } from "../src/ringfall/meta/island";
import { FACTORY, FACTORY_TOP, VALUABLES, type Rarity, type ValuableKind, type WeaponKind } from "../src/ringfall/sim/config";
import { playState } from "./ringfall-table";
import { fork } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DAYS = 30;
/** The days the table reports the island on. */
const MARKS = [5, 10, 20, 30];

/** One skill's month: the island at the end of each day, and how each raid ended. */
export interface Campaign {
  skill: string;
  days: { cash: number; haul: number; gun: number; cleared: string[]; captured: string[]; nodes: number; harbor: number; city: number; tier: number; strength: number; front: string[]; alive: boolean; region: RegionId; event: string | null; crewsIn: number; crewsOut: number; factory: number; gained: number; lost: number; minutes: number; turns: { raid: number; after: number; night: number } }[];
  errors: string[];
}

/**
 * Nodes on the front in a region that its gun pierces (`gun`, the best rarity carried), the deeper
 * the better, then POIs the enemy holds there whose plates it pierces: where the bot has most to do.
 */
const work = (p: Profile, r: RegionId, gun: number) => {
  const front = frontNodes(islandHolds(p));
  const tierOf = (id: string) => TIER[id as NodeId] ?? 0;
  return NODES.reduce((sum, n, i) => sum + (front[i] && n.region === r && TIER[n.id] <= gun ? 100 + 50 * TIER[n.id] : 0), 0) + regionOf(r).pois.filter((id) => !unfreeable(id) && p.poiState[id].state === "held" && tierOf(id) <= gun).length;
};

/** The guns the bot carries, in this order: a rifle for the fight and the scoped rifle for its opening shots. */
const KIT: WeaponKind[] = ["pike", "talon"];

/** The stash's best weapon of `kind` and its best armour, as stash indices (-1 for none). */
function bestGear(p: Profile): { weapons: number[]; armor: number } {
  const best = (ok: (i: Item) => boolean, rank: (i: Item) => number) => p.stash.reduce((b, i, n) => (ok(i) && (b < 0 || rank(i) > rank(p.stash[b])) ? n : b), -1);
  return {
    weapons: KIT.map((kind) => best((i) => i.t === "weapon" && i.kind === kind, (i) => (i.t === "weapon" ? i.rarity : -1))),
    armor: best((i) => i.t === "armor", (i) => (i.t === "armor" ? i.tier : -1)),
  };
}

/**
 * Gear from the trader as the nodes held open it (`shopRarity()`), saving for the factory's next
 * level: a rifle that pierces the deepest node on the front the shelf can arm it for, bought
 * whenever the credits cover it; a common scoped rifle and better armour only from what is left
 * over the factory's next level.
 */
function gearUp(p: Profile): Profile {
  const top = shopRarity(p);
  const front = frontNodes(islandHolds(p));
  const need = Math.max(0, ...NODES.filter((n, i) => front[i] && TIER[n.id] <= top).map((n) => TIER[n.id]));
  const reserve = nextFactory(p)?.cash ?? 0;
  const have = bestGear(p);
  const rarityAt = (n: number) => {
    const i = p.stash[n];
    return i?.t === "weapon" ? i.rarity : i?.t === "armor" ? i.tier : -1;
  };
  const sold = (i: Item) => wares(p).some((w) => JSON.stringify(w) === JSON.stringify(i));
  const rifle: Item = { t: "weapon", kind: "pike", rarity: need as Rarity };
  if (rarityAt(have.weapons[0]) < need && sold(rifle) && p.cash >= buyPrice(rifle)) p = buy(p, rifle) ?? p;
  const scope: Item = { t: "weapon", kind: "talon", rarity: 0 };
  if (rarityAt(have.weapons[1]) < 0 && p.cash >= buyPrice(scope) + reserve) p = buy(p, scope) ?? p;
  for (let t = top; t > rarityAt(have.armor) && t >= 1; t--) {
    const armor: Item = { t: "armor", tier: t as Rarity };
    if (sold(armor) && p.cash >= buyPrice(armor) + reserve) {
      p = buy(p, armor) ?? p;
      break;
    }
  }
  return p;
}

/**
 * The campaign's spending: better gear first (`gearUp()`), then everything in the stash that is not
 * the kit and that the factory's levels still to build do not ask for is sold, then the factory is
 * raised as far as the stash and the credits allow.
 */
function spend(p: Profile): Profile {
  const want = new Map<ValuableKind, number>();
  for (const l of FACTORY.levels.slice(p.factory + 1)) for (const [k, n] of l.cost?.items ?? []) want.set(k, (want.get(k) ?? 0) + n);
  const kit = bestGear(p);
  const keep = new Set([...kit.weapons, kit.armor].filter((n) => n >= 0).map((n) => p.stash[n]));
  for (let i = p.stash.length - 1; i >= 0; i--) {
    const it = p.stash[i];
    if (keep.has(it)) continue;
    const left = it.t === "valuable" ? (want.get(it.kind) ?? 0) : 0;
    const kept = it.t === "valuable" ? p.stash.filter((o, k) => k < i && o.t === "valuable" && o.kind === it.kind).length : 0;
    if (kept >= left) p = sell(p, i);
  }
  // The trader's materials make up what the stash lacks, while the credits cover them and the level.
  for (;;) {
    const l = nextFactory(p);
    if (!l) break;
    const short = factoryShortfall(p);
    for (const [kind, have, need] of short?.items ?? []) {
      const item = { t: "valuable" as const, kind };
      if (!wares(p).some((w) => w.t === "valuable" && w.kind === kind)) continue;
      for (let n = have; n < need && p.cash >= buyPrice(item) + l.cash; n++) p = buy(p, item) ?? p;
    }
    const next = buildFactory(p);
    if (!next) break;
    p = next;
  }
  return gearUp(p);
}

/**
 * A month of one skill on a fresh profile that knows every way in, as a player some raids in does.
 * `seed` is the profile's, from which every raid's seed follows; the gate's month is 17.
 */
export function playCampaign(skill: string, days = DAYS, seed = 17): Campaign {
  let p: Profile = spend({ ...newProfile(seed), entries: ENTRIES.map((e) => e.id) });
  const out: Campaign = { skill, days: [], errors: [] };
  for (let d = 1; d <= days; d++) {
    // The kit: the stash's best guns and armour; the starter PIKE and TALON while it holds none better.
    const gear = bestGear(p);
    const gun = Math.max(0, ...gear.weapons.map((n) => { const i = p.stash[n]; return i?.t === "weapon" ? i.rarity : 0; }));
    const region = REGIONS.map((r) => r.id).reduce((a, b) => (work(p, b, gun) > work(p, a, gun) ? b : a));
    const ways = regionOf(region).entries;
    const taken = takeKit(p, { ...emptyLoadout(), weapons: gear.weapons.filter((n) => n >= 0), armor: gear.armor >= 0 ? gear.armor : null });
    p = taken.profile;
    const s = newRun(p.seed, taken.kit, region, { depots: p.depots, seen: p.seen, routes: p.routes, island: holds(p), entry: ways[d % ways.length], event: p.events[0], battle: { factory: p.factory } });
    const res = playState(s, skill, 500 + d);
    if (res.error) out.errors.push(`campaign ${skill} day ${d}: ${res.error}`);
    const before = p.cash + p.stash.reduce((n, i) => n + (i.t === "valuable" ? VALUABLES[i.kind].value : 0), 0);
    const settled = settle(p, s);
    p = spend(settled.profile);
    const h = islandHolds(p);
    const mine = NODES.filter((_, i) => h[i] === "freed");
    out.days.push({
      gun: Math.max(-1, ...taken.kit.weapons.map((w) => w.rarity)),
      cash: p.cash,
      haul: settled.profile.stash.reduce((n, i) => n + (i.t === "valuable" ? VALUABLES[i.kind].value : 0), 0) + settled.profile.cash - before,
      cleared: s.stats.cleared.map((i) => POIS[i].id),
      captured: [...s.stats.captured],
      nodes: mine.length,
      harbor: mine.filter((n) => n.region === "harbor").length,
      city: mine.filter((n) => n.region === "city").length,
      tier: Math.max(-1, ...mine.map((n) => TIER[n.id])),
      strength: strengthFor(enemyNodes(h)),
      front: NODES.filter((_, i) => frontNodes(h)[i]).map((n) => n.id),
      alive: s.outcome === "extracted",
      region,
      event: s.event?.t ?? null,
      crewsIn: s.stats.crewsIn,
      crewsOut: s.stats.crewsOut,
      factory: p.factory,
      gained: settled.front.gained.length,
      lost: settled.front.lost.length,
      minutes: s.time / 60,
      turns: {
        raid: s.battle ? s.battle.taken.filter((t) => t.t < (s.battle!.left?.at ?? Infinity)).length : 0,
        after: s.battle ? s.battle.taken.filter((t) => t.t >= (s.battle!.left?.at ?? Infinity)).length : 0,
        night: settled.night.lost.length + settled.night.gained.length,
      },
    });
  }
  return out;
}

/** The table's lines, from each skill's month. */
export function campaignLines(runs: Campaign[]): string[] {
  const deepest = Math.max(...Object.values(TIER));
  const lines = [
    `${runs[0]?.days.length ?? 0} consecutive days per skill on one profile (scripts/ringfall-campaign.ts). n: nodes of the ${NODES.length} the player holds at the end of the day; s: the enemy's strength the next raid plays at (0 to 2, from the nodes it holds); f: the factory's level (of ${FACTORY_TOP})`,
    ["skill    ", ...MARKS.map((m) => `day ${m}`.padEnd(10)), "alive".padEnd(6), "n(mean)".padEnd(8), "n(max)".padEnd(7), `tier 0-${deepest}: first day held`.padEnd(24), "days in".padEnd(30), "events d/s/c".padEnd(13), "crews in/out"].join(" "),
  ];
  for (const c of runs) {
    const at = (m: number) => c.days[m - 1];
    const cells = MARKS.map((m) => (at(m) ? `n${at(m).nodes} s${at(m).strength} f${at(m).factory}` : "-").padEnd(10));
    const alive = c.days.filter((d) => d.alive).length / Math.max(1, c.days.length);
    const mean = c.days.reduce((n, d) => n + d.nodes, 0) / Math.max(1, c.days.length);
    const most = Math.max(0, ...c.days.map((d) => d.nodes));
    // The first day each tier was held at the day's end, "-" for one never reached.
    const tiers = Array.from({ length: deepest + 1 }, (_, t) => {
      const k = c.days.findIndex((d) => d.tier >= t);
      return k < 0 ? "-" : String(k + 1);
    }).join("/");
    const regions = REGIONS.map((r) => `${r.id} ${c.days.filter((d) => d.region === r.id).length}`).join(" ");
    const ev = (k: string) => c.days.filter((d) => d.event === k).length;
    const sum = (f: (d: Campaign["days"][number]) => number) => c.days.reduce((n, d) => n + f(d), 0);
    lines.push([c.skill.padEnd(9), ...cells, `${Math.round(alive * 100)}%`.padEnd(6), mean.toFixed(1).padEnd(8), String(most).padEnd(7), tiers.padEnd(24), regions.padEnd(30), `${ev("debris")}/${ev("storm")}/${ev("crews")}`.padEnd(13), `${sum((d) => d.crewsIn)}/${sum((d) => d.crewsOut)}`].join(" "));
  }
  // The nodes that changed hands overnight, all told, and how long the raids were.
  lines.push(["front    ", "nodes gained / lost overnight".padEnd(30), "raid min (med)"].join(" "));
  const med = (xs: number[]) => {
    const v = [...xs].sort((a, b) => a - b);
    return v.length ? v[Math.floor((v.length - 1) / 2)] : 0;
  };
  for (const c of runs) {
    const sum = (f: (d: Campaign["days"][number]) => number) => c.days.reduce((n, d) => n + f(d), 0);
    lines.push([c.skill.padEnd(9), `${sum((d) => d.gained)} / ${sum((d) => d.lost)}`.padEnd(30), med(c.days.map((d) => d.minutes)).toFixed(1)].join(" "));
  }
  // The push and pull: nodes that changed hands in the raids, in the battles after the player left,
  // and overnight; the days the player gained a node and lost one; the longest run of days holding every node.
  lines.push(["push-pull", "changed hands raid / after leaving / night".padEnd(42), "days gained / lost".padEnd(19), "all held (longest run)"].join(" "));
  for (const c of runs) {
    const sum = (f: (d: Campaign["days"][number]) => number) => c.days.reduce((n, d) => n + f(d), 0);
    let run = 0;
    let longest = 0;
    let prev = 0;
    let up = 0;
    let down = 0;
    for (const d of c.days) {
      run = d.nodes === NODES.length ? run + 1 : 0;
      longest = Math.max(longest, run);
      if (d.nodes > prev) up++;
      if (d.nodes < prev) down++;
      prev = d.nodes;
    }
    lines.push([c.skill.padEnd(9), `${sum((d) => d.turns.raid)} / ${sum((d) => d.turns.after)} / ${sum((d) => d.turns.night)}`.padEnd(42), `${up} / ${down}`.padEnd(19), String(longest)].join(" "));
  }
  // The nodes held each day, the harbor's and the city's among them, the deepest tier held (- for none), the strength and the factory.
  lines.push(`nodes by day (base 36: a 10, b 11...): ${runs.map((c) => `${c.skill} ${c.days.map((d) => d.nodes.toString(36)).join("")}`).join(" / ")}`);
  lines.push(`harbor nodes by day: ${runs.map((c) => `${c.skill} ${c.days.map((d) => d.harbor).join("")}`).join(" / ")}`);
  lines.push(`city nodes by day: ${runs.map((c) => `${c.skill} ${c.days.map((d) => d.city).join("")}`).join(" / ")}`);
  lines.push(`deepest tier by day: ${runs.map((c) => `${c.skill} ${c.days.map((d) => (d.tier < 0 ? "-" : d.tier)).join("")}`).join(" / ")}`);
  lines.push(`best gun carried by day (0 common to 3 legendary): ${runs.map((c) => `${c.skill} ${c.days.map((d) => d.gun).join("")}`).join(" / ")}`);
  lines.push(`strength by day: ${runs.map((c) => `${c.skill} ${c.days.map((d) => d.strength).join("")}`).join(" / ")}`);
  lines.push(`factory by day: ${runs.map((c) => `${c.skill} ${c.days.map((d) => d.factory).join("")}`).join(" / ")}`);
  // Where the front stands at the end of the month: the nodes the player could take next.
  for (const c of runs) lines.push(`front on day ${c.days.length} (${c.skill}): ${c.days.at(-1)?.front.join(" ") || "-"}`);
  lines.push("events: days with a debris fall / storm / crews' visit; crews in/out: salvage crews that came and got off");
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
