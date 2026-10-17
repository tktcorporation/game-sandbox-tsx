/**
 * The hideout's pacing for RINGFALL's sim gate: the meta played with the raids the bots
 * really played. Each playthrough draws raids of one skill from the recorded pool, settles
 * them in order, and spends with a greedy policy: deliver what the trader asks, build the
 * cheapest level that can be built (buying what it lacks, if the trader sells it), and
 * sell all gear (the bots play the lent kit) and every valuable nothing still needs, and keep
 * room in the stash for a full bag. It drops into the region whose recorded raids bring
 * home the most worth, above all what the hideout wants and cannot buy.
 */
import { BAG, HIDEOUT, META, VALUABLES, type ModuleId, type ValuableKind } from "../src/ringfall/sim/config";
import { POIS, REGIONS, type RegionId } from "../src/ringfall/sim/map";
import type { State } from "../src/ringfall/sim/state";
import { craftDone, MODULES, maxLevel, nextLevel, onSale, pouchSlots, stashCap } from "../src/ringfall/meta/hideout";
import { build, buy, canBuild, deliver, deliverable, newProfile, pouch, sell, settle, shortfall, wanted, type Profile } from "../src/ringfall/meta/profile";
import { offered } from "../src/ringfall/meta/quests";

/** What settle() reads of a raid, kept from each bot run. */
export type RaidRecord = Pick<State, "outcome" | "extractedAt" | "region" | "time" | "stats" | "sent" | "sentVia" | "depots" | "seen"> & {
  player: Pick<State["player"], "weapons" | "armor" | "heals" | "lentHeals" | "haul" | "keys">;
};

export const recordOf = (s: State): RaidRecord => ({
  outcome: s.outcome,
  extractedAt: s.extractedAt,
  region: s.region,
  time: s.time,
  stats: structuredClone(s.stats),
  sent: [...s.sent],
  sentVia: [...s.sentVia],
  depots: [...s.depots],
  seen: [...s.seen],
  player: structuredClone({ weapons: s.player.weapons, armor: s.player.armor, heals: s.player.heals, lentHeals: s.player.lentHeals, haul: s.player.haul, keys: s.player.keys }),
});

/** Raids played per skill and region. */
export type Pool = Record<string, Partial<Record<RegionId, RaidRecord[]>>>;

const CAP = 200;

/** Valuables a recorded raid brings home with a pouch of `slots`. */
const brought = (r: RaidRecord, slots: number): ValuableKind[] => [...r.sent, ...(r.outcome === "extracted" ? r.player.haul : pouch(r.player.haul, slots))];

/**
 * The region whose raids bring home the most credits' worth, counting twice what the hideout
 * still wants and cannot buy, and an offered quest to clear a POI there as worth its reward.
 */
function pickRegion(p: Profile, pool: Partial<Record<RegionId, RaidRecord[]>>): RegionId {
  const want = wanted(p);
  const clears = offered(p.quests).filter((q) => q.goal.t === "clear");
  let best: RegionId = REGIONS[0].id;
  let bestScore = -1;
  for (const r of REGIONS) {
    const raids = pool[r.id] ?? [];
    if (!raids.length) continue;
    const mean: Partial<Record<ValuableKind, number>> = {};
    for (const raid of raids) for (const k of brought(raid, pouchSlots(p.hideout))) mean[k] = (mean[k] ?? 0) + 1 / raids.length;
    // Everything brought home is worth its price (built in or sold); what the hideout wants and
    // the trader does not sell counts once more, since credits cannot stand in for it.
    const sold = onSale(p.hideout);
    let score = (Object.keys(mean) as ValuableKind[]).reduce((n, k) => n + ((mean[k] ?? 0) + (sold.includes(k) ? 0 : Math.min(Math.max(0, want[k]), mean[k] ?? 0))) * VALUABLES[k].value, 0);
    for (const q of clears) {
      const poi = POIS.findIndex((o) => q.goal.t === "clear" && o.id === q.goal.poi);
      const worth = q.reward.cash + q.reward.items.reduce((n, i) => n + (i.t === "valuable" ? VALUABLES[i.kind].value : 0), 0);
      score += (worth * raids.filter((raid) => raid.stats.cleared.includes(poi)).length) / raids.length;
    }
    if (score > bestScore) [best, bestScore] = [r.id, score];
  }
  return best;
}

/** What a level costs, counting its items at their selling price. */
const cost = (p: Profile, m: ModuleId) => {
  const l = nextLevel(p.hideout, m)!;
  return l.cash + l.items.reduce((n, [k, c]) => n + VALUABLES[k].value * c, 0);
};

/** The greedy spending after each raid. */
function spend(p: Profile): Profile {
  for (let q = offered(p.quests).find((o) => deliverable(p, o)); q; q = offered(p.quests).find((o) => deliverable(p, o))) p = deliver(p, q.id);
  for (let built = true; built; ) {
    built = false;
    const open = MODULES.filter((m) => !shortfall(p, m)?.needs.length && nextLevel(p.hideout, m)).sort((a, b) => cost(p, a) - cost(p, b));
    for (const m of open) {
      const short = shortfall(p, m)!;
      if (short.items.some(([k]) => !onSale(p.hideout).includes(k))) continue;
      let q: Profile | null = p;
      for (const [k, have, n] of short.items) for (let c = have; c < n && q; c++) q = buy(q, { t: "valuable", kind: k });
      if (q && canBuild(q, m)) {
        p = build(q, m)!;
        built = true;
        break;
      }
    }
  }
  // Sell gear and every valuable no level nor delivery still wants, last entries first so indices hold.
  const want = wanted(p);
  for (const q of offered(p.quests)) if (q.goal.t === "deliver") want[q.goal.valuable] += q.goal.n;
  for (let n = p.stash.length - 1; n >= 0; n--) {
    const i = p.stash[n];
    if (i.t !== "valuable") p = sell(p, n);
    else if (want[i.kind] < 0) {
      want[i.kind]++;
      p = sell(p, n);
    }
  }
  // Leave room for a full bag: what the next levels need comes home to a stash full of what
  // only later levels need, and is sold at the door. Sell the kinds no next level asks for,
  // the most plentiful first, until a bag fits.
  const next: Partial<Record<ValuableKind, number>> = {};
  for (const m of MODULES) for (const [k, c] of nextLevel(p.hideout, m)?.items ?? []) next[k] = Math.max(next[k] ?? 0, c);
  while (p.stash.length > stashCap(p.hideout) - BAG.slots) {
    const count: Partial<Record<ValuableKind, number>> = {};
    for (const i of p.stash) if (i.t === "valuable") count[i.kind] = (count[i.kind] ?? 0) + 1;
    const spare = (Object.keys(count) as ValuableKind[]).map((k) => [k, count[k]! - (next[k] ?? 0)] as const).filter(([, x]) => x > 0);
    if (!spare.length) break;
    const [kind] = spare.reduce((a, b) => (b[1] > a[1] ? b : a));
    p = sell(p, p.stash.findLastIndex((i) => i.t === "valuable" && i.kind === kind));
  }
  return p;
}

/** A small seeded random source for drawing raids. */
const rng = (seed: number) => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);

/** Raids each playthrough took to reach every module level, `CAP + 1` when it never did. */
export function playthrough(pool: Partial<Record<RegionId, RaidRecord[]>>, seed: number): Record<string, number> {
  const draw = rng(seed);
  let p = newProfile(seed);
  const reached: Record<string, number> = {};
  for (let raid = 1; raid <= CAP && !craftDone(p.hideout); raid++) {
    const raids = pool[pickRegion(p, pool)]!;
    const r = raids[Math.floor(draw() * raids.length)];
    p = spend(settle(p, r as unknown as State).profile);
    for (const m of MODULES) for (let l = 1; l <= p.hideout[m]; l++) reached[`${m}${l}`] ??= raid;
  }
  for (const m of MODULES) for (let l = 1; l <= maxLevel(m); l++) reached[`${m}${l}`] ??= CAP + 1;
  return reached;
}

/** The pacing table: per skill, the median raid at which each level was built. Fails when a level is never built. */
export function pacing(pool: Pool, trials = 25): { lines: string[]; unreached: string[] } {
  const skills = Object.keys(pool);
  const results = Object.fromEntries(skills.map((s) => [s, Array.from({ length: trials }, (_, t) => playthrough(pool[s], 101 + t * 37))]));
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const lines = [`${trials} playthroughs per skill. Median raid (and 10th-90th percentile) at which each level was built; ${CAP + 1} means never within ${CAP}`];
  lines.push(["level".padEnd(14), ...skills.map((s) => s.padEnd(14))].join(" "));
  const unreached: string[] = [];
  for (const m of MODULES)
    for (let l = 1; l <= maxLevel(m); l++) {
      const key = `${m}${l}`;
      const cells = skills.map((s) => {
        const xs = results[s].map((r) => r[key]).sort((a, b) => a - b);
        if (median(xs) > CAP && s !== "beginner") unreached.push(`${s} ${key}`);
        return `${median(xs)} (${xs[Math.floor(trials * 0.1)]}-${xs[Math.floor(trials * 0.9)]})`.padEnd(14);
      });
      lines.push([`${HIDEOUT[m].name} Lv${l}`.padEnd(14 - [...`${HIDEOUT[m].name}`].length), ...cells].join(" "));
    }
  return { lines, unreached };
}
