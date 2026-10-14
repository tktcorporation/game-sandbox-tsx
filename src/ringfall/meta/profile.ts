import { HEALS as HEAL_SPECS, HIDEOUT, META, VALUABLES, type HealKind, type ModuleId, type Rarity, type ValuableKind, type WeaponKind } from "../sim/config";
import { POIS, poiIndex, REGIONS, type PoiId, type RegionId } from "../sim/map";
import type { Kit, State } from "../sim/state";
import { craftDone, emptyHideout, infirmaryHeals, MODULES, nextLevel, pouchSlots, shopRarity, stashCap, stillNeeded, unmet, type Hideout } from "./hideout";
import { built, creditRaid, emptyLog, need, offered, type Quest, type QuestLog } from "./quests";

/** One thing in the stash. Heals are one entry per unit, so the stash cap counts them. */
export type Item =
  | { t: "weapon"; kind: WeaponKind; rarity: Rarity }
  | { t: "armor"; tier: Rarity }
  | { t: "heal"; kind: HealKind }
  | { t: "valuable"; kind: ValuableKind }
  | { t: "key"; poi: PoiId };

/** The playthrough's record when the escape craft was finished, for the ending. */
export interface Escape {
  raids: number;
  extracted: number;
  /** Seconds spent in raids. */
  time: number;
}

/** What persists between raids. */
export interface Profile {
  v: 5;
  cash: number;
  stash: Item[];
  raids: number;
  extracted: number;
  /** Seconds spent in raids, all told. */
  time: number;
  quests: QuestLog;
  /** The region the last raid dropped into: the base offers it first next time. */
  region: RegionId;
  hideout: Hideout;
  /** Set once, when the escape craft is finished. */
  escaped: Escape | null;
  /** The next raid's seed: fixed before the drop, so the radio can tell what that raid holds. */
  seed: number;
}

export const HEALS: HealKind[] = ["cell", "battery", "syringe", "medkit"];

export function newProfile(seed = 1): Profile {
  const stash: Item[] = META.start.weapons.map((w) => ({ t: "weapon", ...w }));
  for (const k of HEALS) for (let i = 0; i < META.start.heals[k]; i++) stash.push({ t: "heal", kind: k });
  return { v: 5, cash: META.start.cash, stash, raids: 0, extracted: 0, time: 0, quests: emptyLog(), region: "reservoir", hideout: emptyHideout(), escaped: null, seed: seed & 0xffff };
}

/** The seed of the raid after one started from `seed`. */
export const nextSeed = (seed: number) => ((Math.imul(seed + 1, 1103515245) + 12345) >>> 8) & 0xffff;

/** What the trader asks for an item. */
export function price(i: Item): number {
  switch (i.t) {
    case "weapon":
      return Math.round(META.weapon[i.kind] * META.rarityFactor[i.rarity]);
    case "armor":
      return META.armor[i.tier];
    case "heal":
      return META.heal[i.kind];
    case "valuable":
      return VALUABLES[i.kind].value;
    case "key":
      return META.key;
  }
}

/** What the trader charges for an item: common valuables cost more than they sell for. */
export const buyPrice = (i: Item) => (i.t === "valuable" ? Math.round(price(i) * META.materials.markup) : price(i));

/** What the trader pays for an item: valuables at full value, gear at a share of its price. */
export const sellPrice = (i: Item) => (i.t === "valuable" ? price(i) : Math.round(price(i) * META.sellShare));

/** Key names, for lists and the HUD. */
export const keyName = (poi: PoiId) => `${POIS[poiIndex(poi)].name}の鍵`;

/** Everything the trader sells: better with each level of the hideout's workbench. */
export function wares(p: Profile): Item[] {
  const best = shopRarity(p.hideout);
  const out: Item[] = [];
  for (const kind of Object.keys(META.weapon) as WeaponKind[])
    for (let r = 0; r <= best; r++) out.push({ t: "weapon", kind, rarity: r as Rarity });
  for (let tier = 1; tier <= best; tier++) out.push({ t: "armor", tier: tier as Rarity });
  for (const kind of HEALS) out.push({ t: "heal", kind });
  for (const kind of META.materials.kinds) out.push({ t: "valuable", kind });
  return out;
}

export const sameItem = (a: Item, b: Item) => JSON.stringify(a) === JSON.stringify(b);

/** Buys one item into the stash; null when it cannot be afforded or the stash is full. */
export function buy(p: Profile, i: Item): Profile | null {
  if (p.cash < buyPrice(i) || p.stash.length >= stashCap(p.hideout)) return null;
  return { ...p, cash: p.cash - buyPrice(i), stash: [...p.stash, { ...i }] };
}

/** Sells the stash entry at `index`. */
export function sell(p: Profile, index: number): Profile {
  const i = p.stash[index];
  if (!i) return p;
  return { ...p, cash: p.cash + sellPrice(i), stash: p.stash.filter((_, n) => n !== index) };
}

/** A raid's loadout, as stash indices. */
export interface Loadout {
  weapons: number[];
  armor: number | null;
  heals: Record<HealKind, number>;
  keys: number[];
}

export const emptyLoadout = (): Loadout => ({ weapons: [], armor: null, heals: { cell: 0, battery: 0, syringe: 0, medkit: 0 }, keys: [] });

/** How many of a heal the stash holds. */
export const healCount = (p: Profile, k: HealKind) => p.stash.filter((i) => i.t === "heal" && i.kind === k).length;

/**
 * Takes a loadout out of the stash. Picking no weapon means the free kit: its weapons and
 * heals are lent, and any heals picked from the stash come on top of them. The hideout's
 * infirmary lends its heals to either kit.
 */
export function takeKit(p: Profile, l: Loadout): { profile: Profile; kit: Kit } {
  const take = new Set<number>();
  const weapons: Kit["weapons"] = [];
  for (const n of l.weapons.slice(0, 2)) {
    const i = p.stash[n];
    if (i?.t === "weapon" && !take.has(n)) {
      take.add(n);
      weapons.push({ kind: i.kind, rarity: i.rarity });
    }
  }
  let armor: Rarity = 0;
  const a = l.armor === null ? undefined : p.stash[l.armor];
  if (a?.t === "armor" && l.armor !== null) {
    take.add(l.armor);
    armor = a.tier;
  }
  const free = weapons.length === 0;
  const sick = infirmaryHeals(p.hideout);
  const lentHeals = Object.fromEntries(HEALS.map((k) => [k, Math.min(HEAL_SPECS[k].max, (free ? META.free.heals[k] : 0) + sick[k])])) as Record<HealKind, number>;
  const heals = { cell: 0, battery: 0, syringe: 0, medkit: 0 } as Record<HealKind, number>;
  for (const k of HEALS) {
    // A kind holds at most HEAL_SPECS[k].max, lent ones included.
    let want = Math.min(l.heals[k], HEAL_SPECS[k].max - lentHeals[k]);
    p.stash.forEach((i, n) => {
      if (want > 0 && i.t === "heal" && i.kind === k && !take.has(n)) {
        take.add(n);
        heals[k]++;
        want--;
      }
    });
  }
  const keys: number[] = [];
  for (const n of l.keys) {
    const i = p.stash[n];
    if (i?.t === "key" && !take.has(n) && !keys.includes(poiIndex(i.poi))) {
      take.add(n);
      keys.push(poiIndex(i.poi));
    }
  }
  const kit: Kit = {
    keys,
    weapons: free ? META.free.weapons.map((w) => ({ ...w, loan: true })) : weapons,
    armor,
    heals: Object.fromEntries(HEALS.map((k) => [k, heals[k] + lentHeals[k]])) as Record<HealKind, number>,
    lentHeals,
  };
  return { profile: { ...p, stash: p.stash.filter((_, n) => !take.has(n)) }, kit };
}

/** The most valuable valuables that fit in `slots` bag slots. */
export function pouch(haul: ValuableKind[], slots: number = META.pouch): ValuableKind[] {
  // Knapsack over the few slots: best[c] is the best pick using at most c slots.
  let best: { value: number; pick: number[] }[] = Array.from({ length: slots + 1 }, () => ({ value: 0, pick: [] }));
  haul.forEach((k, n) => {
    const size = VALUABLES[k].size;
    const next = best.map((b) => ({ value: b.value, pick: b.pick }));
    for (let c = size; c <= slots; c++) {
      const v = best[c - size].value + VALUABLES[k].value;
      if (v > next[c].value) next[c] = { value: v, pick: [...best[c - size].pick, n] };
    }
    best = next;
  });
  return best[slots].pick.map((n) => haul[n]);
}

/** What a raid brings home, the quests it finished, and what the stash had no room for (sold on the spot). */
export interface Settlement {
  profile: Profile;
  home: Item[];
  quests: Quest[];
  sold: Item[];
  soldFor: number;
}

/** Valuables the hideout still asks for beyond what the stash holds, by kind. */
export function wanted(p: Profile): Record<ValuableKind, number> {
  const out = stillNeeded(p.hideout);
  for (const i of p.stash) if (i.t === "valuable") out[i.kind]--;
  return out;
}

/**
 * The order in which things claim stash room: keys, then valuables the hideout still
 * wants, then gear (the dearest first, since the better of it is found only on the
 * island), then the other valuables, which are worth the same sold now or later.
 */
export function keepOrder(items: Item[], want: Record<ValuableKind, number>): Item[] {
  const left = { ...want };
  const rankOf = (i: Item) => (i.t === "key" ? 0 : i.t !== "valuable" ? 2 : left[i.kind]-- > 0 ? 1 : 3);
  // Dearer valuables claim what the hideout wants first.
  const ranked = [...items].sort((a, b) => price(b) - price(a)).map((i) => ({ i, r: rankOf(i) }));
  return ranked.sort((a, b) => a.r - b.r || price(b.i) - price(a.i)).map((x) => x.i);
}

/** Puts items into the stash in `keepOrder()`; what does not fit is sold at once. */
function store(p: Profile, items: Item[]): { profile: Profile; sold: Item[]; soldFor: number } {
  const room = Math.max(0, stashCap(p.hideout) - p.stash.length);
  const keep = keepOrder(items, wanted(p));
  const sold = keep.slice(room);
  const soldFor = sold.reduce((n, i) => n + sellPrice(i), 0);
  return { profile: { ...p, cash: p.cash + soldFor, stash: [...p.stash, ...keep.slice(0, room)] }, sold, soldFor };
}

/** Pays a finished quest's reward. */
function pay(p: Profile, q: Quest): { profile: Profile; sold: Item[]; soldFor: number } {
  return store({ ...p, cash: p.cash + q.reward.cash }, q.reward.items.map((i) => ({ ...i })));
}

/** Puts what came off the island into the stash, and pays the quests the raid finished. */
export function settle(p: Profile, s: State): Settlement {
  const pl = s.player;
  const home: Item[] = [];
  if (s.outcome === "extracted") {
    for (const w of pl.weapons) if (w && !w.loan) home.push({ t: "weapon", kind: w.kind, rarity: w.rarity });
    if (pl.armor > 0) home.push({ t: "armor", tier: pl.armor });
    for (const k of HEALS) for (let i = Math.max(0, pl.heals[k] - pl.lentHeals[k]); i > 0; i--) home.push({ t: "heal", kind: k });
    for (const v of pl.haul) home.push({ t: "valuable", kind: v });
    for (const poi of pl.keys) home.push({ t: "key", poi: POIS[poi].id });
  } else {
    for (const v of pouch(pl.haul, pouchSlots(p.hideout))) home.push({ t: "valuable", kind: v });
  }
  // What came home and what the quests pay claim stash room together, in one `keepOrder()`.
  const { log, finished } = creditRaid(p.quests, s);
  const rewards = finished.flatMap((q) => q.reward.items.map((i): Item => ({ ...i })));
  const cash = finished.reduce((n, q) => n + q.reward.cash, 0);
  const { profile, sold, soldFor } = store({ ...p, cash: p.cash + cash }, [...home, ...rewards]);
  const next = { ...profile, quests: log, raids: p.raids + 1, extracted: p.extracted + (s.outcome === "extracted" ? 1 : 0), time: p.time + s.time, seed: nextSeed(p.seed) };
  // Quests the raid opened may ask for a hideout level already built.
  const claimed = claimBuilt(next);
  return { profile: claimed.profile, home, quests: [...finished, ...claimed.quests], sold: [...sold, ...claimed.sold], soldFor: soldFor + claimed.soldFor };
}

/** Finishes and pays every offered build quest the hideout already meets, and those they open. */
export function claimBuilt(p: Profile): { profile: Profile; quests: Quest[]; sold: Item[]; soldFor: number } {
  const quests: Quest[] = [];
  const sold: Item[] = [];
  let soldFor = 0;
  for (let q = offered(p.quests).find((o) => built(o.goal, p.hideout)); q; q = offered(p.quests).find((o) => built(o.goal, p.hideout))) {
    const paid = pay({ ...p, quests: { ...p.quests, done: [...p.quests.done, q.id] } }, q);
    p = paid.profile;
    quests.push(q);
    sold.push(...paid.sold);
    soldFor += paid.soldFor;
  }
  return { profile: p, quests, sold, soldFor };
}

/** What stands between a module and its next level: items short (kind, have, need), credits short, levels unbuilt. */
export function shortfall(p: Profile, m: ModuleId): { items: [ValuableKind, number, number][]; cash: number; needs: [ModuleId, number][] } | null {
  const l = nextLevel(p.hideout, m);
  if (!l) return null;
  const have = (k: ValuableKind) => p.stash.filter((i) => i.t === "valuable" && i.kind === k).length;
  return {
    items: l.items.filter(([k, n]) => have(k) < n).map(([k, n]) => [k, have(k), n]),
    cash: Math.max(0, l.cash - p.cash),
    needs: unmet(p.hideout, l),
  };
}

export const canBuild = (p: Profile, m: ModuleId) => {
  const s = shortfall(p, m);
  return !!s && !s.items.length && !s.cash && !s.needs.length;
};

/**
 * Builds a module's next level, taking its items and credits from the stash; null when it
 * cannot be built. Finishing the escape craft records the playthrough for the ending.
 */
export function build(p: Profile, m: ModuleId): Profile | null {
  const l = nextLevel(p.hideout, m);
  if (!l || !canBuild(p, m)) return null;
  const take = new Set<number>();
  for (const [k, n] of l.items) {
    let left = n;
    p.stash.forEach((i, at) => {
      if (left > 0 && i.t === "valuable" && i.kind === k && !take.has(at)) {
        take.add(at);
        left--;
      }
    });
  }
  const hideout = { ...p.hideout, [m]: p.hideout[m] + 1 };
  let next: Profile = { ...p, cash: p.cash - l.cash, stash: p.stash.filter((_, at) => !take.has(at)), hideout };
  if (craftDone(hideout) && !p.escaped) next = { ...next, escaped: { raids: p.raids, extracted: p.extracted, time: p.time } };
  return claimBuilt(next).profile;
}

/** Stash entries (indices) a delivery quest would take, or null when the stash lacks them. */
export function deliverable(p: Profile, q: Quest): number[] | null {
  const g = q.goal;
  if (g.t !== "deliver") return null;
  const have: number[] = [];
  p.stash.forEach((i, n) => i.t === "valuable" && i.kind === g.valuable && have.length < need(g) && have.push(n));
  return have.length >= need(g) ? have : null;
}

/** Hands a delivery quest's items to the trader and pays its reward. */
export function deliver(p: Profile, id: string): Profile {
  const q = offered(p.quests).find((o) => o.id === id);
  const take = q && deliverable(p, q);
  if (!q || !take) return p;
  const left = { ...p, stash: p.stash.filter((_, n) => !take.includes(n)), quests: { ...p.quests, done: [...p.quests.done, q.id] } };
  return claimBuilt(pay(left, q).profile).profile;
}

/**
 * The POI ids in the order v1 and v2 saves numbered them: those saves kept a key's POI
 * as its place in this list.
 */
const V2_POIS: PoiId[] = ["supply", "quarry", "relay", "pad"];

/**
 * Accepts a stored profile only if it has the right shape. A v1 profile gains an empty
 * quest log; v1 and v2 keys name their POI by number and are moved to ids; profiles before
 * v4 drop into the reservoir; profiles before v5 start with an empty hideout.
 */
export function parseProfile(raw: unknown, seed = 1): Profile | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (![1, 2, 3, 4, 5].includes(o.v as number) || typeof o.cash !== "number" || !Array.isArray(o.stash)) return null;
  const old = o.v === 1 || o.v === 2;
  const migrate = (i: unknown): unknown => {
    if (!old || !i || typeof i !== "object" || (i as Record<string, unknown>).t !== "key") return i;
    const n = (i as Record<string, unknown>).poi;
    return Number.isInteger(n) && V2_POIS[n as number] ? { t: "key", poi: V2_POIS[n as number] } : null;
  };
  const ok = (i: unknown): i is Item => {
    if (!i || typeof i !== "object") return false;
    const x = i as Record<string, unknown>;
    if (x.t === "weapon") return typeof x.kind === "string" && x.kind in META.weapon && [0, 1, 2, 3].includes(x.rarity as number);
    if (x.t === "armor") return [1, 2, 3].includes(x.tier as number);
    if (x.t === "heal") return HEALS.includes(x.kind as HealKind);
    if (x.t === "valuable") return typeof x.kind === "string" && x.kind in VALUABLES;
    if (x.t === "key") return typeof x.poi === "string" && poiIndex(x.poi as PoiId) >= 0;
    return false;
  };
  const q = (o.quests ?? {}) as Record<string, unknown>;
  const progress: Record<string, number> = {};
  if (q.progress && typeof q.progress === "object") for (const [k, n] of Object.entries(q.progress)) if (typeof n === "number") progress[k] = n;
  const h = (o.hideout ?? {}) as Record<string, unknown>;
  const hideout = emptyHideout();
  for (const m of MODULES) if (Number.isInteger(h[m])) hideout[m] = Math.max(0, Math.min(HIDEOUT[m].levels.length, h[m] as number));
  const e = o.escaped as Record<string, unknown> | null | undefined;
  const escaped = craftDone(hideout) ? { raids: Number(e?.raids) || 0, extracted: Number(e?.extracted) || 0, time: Number(e?.time) || 0 } : null;
  const num = (x: unknown) => (typeof x === "number" && x >= 0 ? x : 0);
  return {
    v: 5,
    cash: Math.max(0, Math.floor(o.cash)),
    stash: o.stash.map(migrate).filter(ok).slice(0, stashCap(hideout)),
    raids: num(o.raids),
    extracted: num(o.extracted),
    time: num(o.time),
    quests: { progress, done: Array.isArray(q.done) ? q.done.filter((d): d is string => typeof d === "string") : [] },
    region: REGIONS.find((r) => r.id === o.region)?.id ?? "reservoir",
    hideout,
    escaped,
    seed: Number.isInteger(o.seed) ? (o.seed as number) & 0xffff : seed & 0xffff,
  };
}
