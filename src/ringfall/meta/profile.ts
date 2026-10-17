import { DEPOT, HEALS as HEAL_SPECS, HIDEOUT, META, TOOLS, VALUABLES, type HealKind, type ModuleId, type Rarity, type ToolKind, type ValuableKind, type WeaponKind } from "../sim/config";
import { depotIndex, DEPOTS, ENTRIES, POIS, poiIndex, REGIONS, regionOf, ROUTES, type EntryId, type PoiId, type RegionId, type RouteId } from "../sim/map";
import { openRoutes } from "../sim/routes";
import { encodeSeen, type Kit, type State } from "../sim/state";
import { craftDone, emptyHideout, infirmaryHeals, MODULES, nextLevel, onSale, pouchSlots, shopRarity, stashCap, stillNeeded, unmet, type Hideout } from "./hideout";
import { built, creditRaid, emptyLog, need, offered, type Quest, type QuestLog } from "./quests";

/** One thing in the stash. Heals are one entry per unit, so the stash cap counts them. */
export type Item =
  | { t: "weapon"; kind: WeaponKind; rarity: Rarity }
  | { t: "armor"; tier: Rarity }
  | { t: "heal"; kind: HealKind }
  | { t: "valuable"; kind: ValuableKind }
  | { t: "key"; poi: PoiId }
  | { t: "tool"; kind: ToolKind };

/** The playthrough's record when the escape craft was finished, for the ending. */
export interface Escape {
  raids: number;
  extracted: number;
  /** Seconds spent in raids. */
  time: number;
}

/** What persists between raids. */
export interface Profile {
  v: 10;
  cash: number;
  stash: Item[];
  raids: number;
  extracted: number;
  /** Seconds spent in raids, all told. */
  time: number;
  quests: QuestLog;
  /** The region the last raid started in. */
  region: RegionId;
  /** The way in the last raid that did not start at a depot took: the base offers it first next time. */
  entry: EntryId;
  hideout: Hideout;
  /** Set once, when the escape craft is finished. */
  escaped: Escape | null;
  /** The next raid's seed: fixed before the raid, so the radio can tell what that raid holds. */
  seed: number;
  /** The depots switched on in any raid: they stay on, and a raid may start from one. */
  depots: PoiId[];
  /** Credits' worth sent home through each depot on, over all raids: it sets the depot's level (`depotAllowance()`). */
  depotSent: Partial<Record<PoiId, number>>;
  /** The explored map (`encodeSeen()`), grown by every raid. */
  seen: string;
  /** The routes opened for good (`ROUTES` order): every raid's world has them open. */
  routes: RouteId[];
}

export const HEALS: HealKind[] = ["cell", "battery", "syringe", "medkit"];

export function newProfile(seed = 1): Profile {
  const stash: Item[] = META.start.weapons.map((w) => ({ t: "weapon", ...w }));
  for (const k of HEALS) for (let i = 0; i < META.start.heals[k]; i++) stash.push({ t: "heal", kind: k });
  return { v: 10, cash: META.start.cash, stash, raids: 0, extracted: 0, time: 0, quests: emptyLog(), region: "reservoir", entry: regionOf("reservoir").entries[0], hideout: emptyHideout(), escaped: null, seed: seed & 0xffff, depots: [], depotSent: {}, seen: "", routes: [] };
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
    case "tool":
      return TOOLS[i.kind].value;
  }
}

/** What the trader charges for an item: common valuables cost more than they sell for. */
export const buyPrice = (i: Item) => (i.t === "valuable" ? Math.round(price(i) * META.materials.markup) : price(i));

/** What the trader pays for an item: valuables and spare tools at full value, gear at a share of its price. */
export const sellPrice = (i: Item) => (i.t === "valuable" || i.t === "tool" ? price(i) : Math.round(price(i) * META.sellShare));

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
  for (const kind of onSale(p.hideout)) out.push({ t: "valuable", kind });
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

/** Heals a raid is lent: the free kit's when it carries no weapon of the stash, and the infirmary's. */
export function lentHeals(p: Profile, free: boolean): Record<HealKind, number> {
  const sick = infirmaryHeals(p.hideout);
  return Object.fromEntries(HEALS.map((k) => [k, Math.min(HEAL_SPECS[k].max, (free ? META.free.heals[k] : 0) + sick[k])])) as Record<HealKind, number>;
}

/** How many heals of a kind a loadout can take from the stash: what it holds, up to what the lent ones leave room for. */
export function healRoom(p: Profile, l: Loadout, k: HealKind): number {
  const free = !l.weapons.some((n) => p.stash[n]?.t === "weapon");
  return Math.max(0, Math.min(healCount(p, k), HEAL_SPECS[k].max - lentHeals(p, free)[k]));
}

/**
 * The stash entries a loadout really takes, resolved as `takeKit()` does: up to two weapons,
 * one armour, one key per POI. Picks that are not of their kind are dropped.
 */
function picks(p: Profile, l: Loadout): { weapons: number[]; armor: number | null; keys: number[] } {
  const weapons = [...new Set(l.weapons.slice(0, 2))].filter((n) => p.stash[n]?.t === "weapon");
  const armor = l.armor !== null && p.stash[l.armor]?.t === "armor" ? l.armor : null;
  const keys: number[] = [];
  const pois = new Set<PoiId>();
  for (const n of l.keys) {
    const i = p.stash[n];
    if (i?.t === "key" && !keys.includes(n) && !pois.has(i.poi)) {
      keys.push(n);
      pois.add(i.poi);
    }
  }
  return { weapons, armor, keys };
}

/** What one stash entry costs of a depot start's allowance (`DEPOT`): heals and valuables nothing. */
export function itemCost(i: Item): number {
  if (i.t === "weapon") return DEPOT.weaponCost[i.rarity];
  if (i.t === "armor") return DEPOT.armorCost[i.tier];
  if (i.t === "key") return DEPOT.keyCost;
  return 0;
}

/** What a loadout costs of a depot start's allowance. The lent free kit and all heals cost nothing. */
export function loadoutCost(p: Profile, l: Loadout): number {
  const k = picks(p, l);
  return [...k.weapons, ...(k.armor === null ? [] : [k.armor]), ...k.keys].reduce((n, at) => n + itemCost(p.stash[at]), 0);
}

/** A depot's standing: its level, the allowance it gives, what has gone through it, and what the next level still needs (null at the top). */
export interface DepotAllowance {
  level: number;
  budget: number;
  sent: number;
  next: number | null;
}

export function depotAllowance(p: Profile, poi: PoiId): DepotAllowance {
  const sent = p.depotSent[poi] ?? 0;
  let level = 0;
  while (level + 1 < DEPOT.levels.length && sent >= DEPOT.levels[level + 1]) level++;
  const next = level + 1 < DEPOT.levels.length ? DEPOT.levels[level + 1] - sent : null;
  return { level, budget: DEPOT.budget[level], sent, next };
}

/** The loadout points a raid started from `poi`'s depot may carry. */
export const depotBudget = (p: Profile, poi: PoiId) => depotAllowance(p, poi).budget;

/**
 * Whether a raid may start with this loadout: a start at a way in (`from` null) always may; a depot start
 * only from a depot on, and within its allowance.
 */
export function fitsStart(p: Profile, l: Loadout, from: PoiId | null): boolean {
  if (from === null) return true;
  return p.depots.includes(from) && loadoutCost(p, l) <= depotBudget(p, from);
}

/**
 * Takes a loadout out of the stash. Picking no weapon means the free kit: its weapons and
 * heals are lent, and any heals picked from the stash come on top of them. The hideout's
 * infirmary lends its heals to either kit. A start from a depot is held to its allowance.
 */
export function takeKit(p: Profile, l: Loadout): { profile: Profile; kit: Kit };
/** For a start from a depot (`from`), null when the loadout does not fit its allowance (`fitsStart()`). */
export function takeKit(p: Profile, l: Loadout, from: PoiId | null): { profile: Profile; kit: Kit } | null;
export function takeKit(p: Profile, l: Loadout, from: PoiId | null = null): { profile: Profile; kit: Kit } | null {
  if (!fitsStart(p, l, from)) return null;
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
  const lent = lentHeals(p, free);
  const heals = { cell: 0, battery: 0, syringe: 0, medkit: 0 } as Record<HealKind, number>;
  for (const k of HEALS) {
    // A kind holds at most HEAL_SPECS[k].max, lent ones included.
    let want = Math.min(l.heals[k], HEAL_SPECS[k].max - lent[k]);
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
    heals: Object.fromEntries(HEALS.map((k) => [k, heals[k] + lent[k]])) as Record<HealKind, number>,
    lentHeals: lent,
  };
  return { profile: { ...p, stash: p.stash.filter((_, n) => !take.has(n)) }, kit };
}

/**
 * What the pouch keeps on a wipe: the tools first, in the order taken, while they fit (they are
 * what opens a route), then the most valuable valuables in the slots left.
 */
export function pouchKeep(haul: ValuableKind[], tools: ToolKind[], slots: number = META.pouch): { haul: ValuableKind[]; tools: ToolKind[] } {
  const kept: ToolKind[] = [];
  let left = slots;
  for (const k of tools)
    if (TOOLS[k].size <= left) {
      kept.push(k);
      left -= TOOLS[k].size;
    }
  return { haul: pouch(haul, left), tools: kept };
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

/**
 * What a raid brings home, the quests it finished, the routes its tools opened (the tools spent
 * on them are in `home` but not in the stash), and what the stash had no room for (sold on the spot).
 */
export interface Settlement {
  profile: Profile;
  home: Item[];
  opened: RouteId[];
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
 * island), then the other valuables and spare tools, which are worth the same sold now
 * or later (a tool that opens a route is spent before anything is stored).
 */
export function keepOrder(items: Item[], want: Record<ValuableKind, number>): Item[] {
  const left = { ...want };
  const rankOf = (i: Item) => (i.t === "key" ? 0 : i.t === "tool" ? 3 : i.t !== "valuable" ? 2 : left[i.kind]-- > 0 ? 1 : 3);
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

/**
 * Puts what came off the island into the stash, and pays the quests the raid finished.
 * What was sent home from a depot arrives however the raid ended; the depots switched on
 * and the map explored are kept too.
 */
export function settle(p: Profile, s: State): Settlement {
  const pl = s.player;
  // A record of a raid kept from before tools were carried has none.
  const tools = pl.tools ?? [];
  const home: Item[] = [...s.sent.map((v): Item => ({ t: "valuable", kind: v })), ...(s.sentTools ?? []).map((k): Item => ({ t: "tool", kind: k }))];
  if (s.outcome === "extracted") {
    for (const w of pl.weapons) if (w && !w.loan) home.push({ t: "weapon", kind: w.kind, rarity: w.rarity });
    if (pl.armor > 0) home.push({ t: "armor", tier: pl.armor });
    for (const k of HEALS) for (let i = Math.max(0, pl.heals[k] - pl.lentHeals[k]); i > 0; i--) home.push({ t: "heal", kind: k });
    for (const v of pl.haul) home.push({ t: "valuable", kind: v });
    for (const poi of pl.keys) home.push({ t: "key", poi: POIS[poi].id });
    for (const k of tools) home.push({ t: "tool", kind: k });
  } else {
    const kept = pouchKeep(pl.haul, tools, pouchSlots(p.hideout));
    for (const v of kept.haul) home.push({ t: "valuable", kind: v });
    for (const k of kept.tools) home.push({ t: "tool", kind: k });
  }
  // Each tool home opens the first of its routes still closed, and is spent on it.
  const opened: RouteId[] = [];
  const spent = new Set<Item>();
  for (const i of home) {
    if (i.t !== "tool") continue;
    const r = ROUTES.find((o) => o.tool === i.kind && !p.routes.includes(o.id) && !opened.includes(o.id));
    if (!r) continue;
    opened.push(r.id);
    spent.add(i);
  }
  // What came home and what the quests pay claim stash room together, in one `keepOrder()`.
  const { log, finished } = creditRaid(p.quests, s);
  const rewards = finished.flatMap((q) => q.reward.items.map((i): Item => ({ ...i })));
  const cash = finished.reduce((n, q) => n + q.reward.cash, 0);
  const { profile, sold, soldFor } = store({ ...p, cash: p.cash + cash, routes: openRoutes([...p.routes, ...opened]) }, [...home.filter((i) => !spent.has(i)), ...rewards]);
  const depots = DEPOTS.map((d) => d.poi).filter((id, i) => p.depots.includes(id) || s.depots[i]);
  const depotSent = Object.fromEntries(depots.map((id) => [id, (p.depotSent[id] ?? 0) + (s.sentVia[depotIndex(id)] ?? 0)]));
  const next = { ...profile, quests: log, raids: p.raids + 1, extracted: p.extracted + (s.outcome === "extracted" ? 1 : 0), time: p.time + s.time, seed: nextSeed(p.seed), depots, depotSent, seen: encodeSeen(s.seen) };
  // Quests the raid opened may ask for a hideout level already built.
  const claimed = claimBuilt(next);
  return { profile: claimed.profile, home, opened, quests: [...finished, ...claimed.quests], sold: [...sold, ...claimed.sold], soldFor: soldFor + claimed.soldFor };
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

/**
 * What the module card says about its next level: done, buildable, or the first thing in the
 * way (a module it needs, then the parts still missing, then only the credits).
 */
export function buildState(p: Profile, m: ModuleId): string {
  const s = shortfall(p, m);
  if (!s) return "完成";
  if (s.needs.length) return "設備が足りない";
  const missing = s.items.reduce((n, [, have, need]) => n + need - have, 0);
  if (missing) return `あと ${missing} 個`;
  if (s.cash) return `あと ${s.cash.toLocaleString()} クレジット`;
  return "作れる";
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
 * v4 drop into the reservoir; profiles before v5 start with an empty hideout; profiles before
 * v6 have no depot on and nothing explored. A v6 profile's explored map was drawn over the
 * world before its open ground and wider bounds, so it is dropped (its depots stay). Profiles
 * before v8 have sent nothing through their depots: each one on starts at level 0. Profiles
 * before v9 have every route closed. Before v10 a raid dropped from the air: such a profile
 * starts at its last region's first way in, and its explored map, drawn over the smaller
 * world, is dropped.
 */
export function parseProfile(raw: unknown, seed = 1): Profile | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (![1, 2, 3, 4, 5, 6, 7, 8, 9, 10].includes(o.v as number) || typeof o.cash !== "number" || !Array.isArray(o.stash)) return null;
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
    if (x.t === "tool") return typeof x.kind === "string" && x.kind in TOOLS;
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
  const depots = Array.isArray(o.depots) ? [...new Set(o.depots.filter((d): d is PoiId => typeof d === "string" && poiIndex(d as PoiId) >= 0))] : [];
  const ds = ((o.v === 8 || o.v === 9 || o.v === 10) && o.depotSent && typeof o.depotSent === "object" ? o.depotSent : {}) as Record<string, unknown>;
  const depotSent = Object.fromEntries(depots.map((d) => [d, num(ds[d])]));
  const region = REGIONS.find((r) => r.id === o.region)?.id ?? "reservoir";
  const entry = ENTRIES.find((e) => e.id === o.entry && e.region === region)?.id ?? regionOf(region).entries[0];
  return {
    v: 10,
    cash: Math.max(0, Math.floor(o.cash)),
    stash: o.stash.map(migrate).filter(ok).slice(0, stashCap(hideout)),
    raids: num(o.raids),
    extracted: num(o.extracted),
    time: num(o.time),
    quests: { progress, done: Array.isArray(q.done) ? q.done.filter((d): d is string => typeof d === "string") : [] },
    region,
    entry,
    hideout,
    escaped,
    seed: Number.isInteger(o.seed) ? (o.seed as number) & 0xffff : seed & 0xffff,
    depots,
    depotSent,
    seen: o.v === 10 && typeof o.seen === "string" && /^[0-9a-f]*$/.test(o.seen) ? o.seen : "",
    routes: (o.v === 9 || o.v === 10) && Array.isArray(o.routes) ? openRoutes(o.routes.filter((r): r is string => typeof r === "string")) : [],
  };
}
