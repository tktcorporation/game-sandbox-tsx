import { HEALS as HEAL_SPECS, META, VALUABLES, type HealKind, type Rarity, type ValuableKind, type WeaponKind } from "../sim/config";
import type { Kit, State } from "../sim/state";

/** One thing in the stash. Heals are one entry per unit, so the stash cap counts them. */
export type Item =
  | { t: "weapon"; kind: WeaponKind; rarity: Rarity }
  | { t: "armor"; tier: Rarity }
  | { t: "heal"; kind: HealKind }
  | { t: "valuable"; kind: ValuableKind };

/** What persists between raids. */
export interface Profile {
  v: 1;
  cash: number;
  stash: Item[];
  raids: number;
  extracted: number;
}

export const HEALS: HealKind[] = ["cell", "battery", "syringe", "medkit"];

export function newProfile(): Profile {
  const stash: Item[] = META.start.weapons.map((w) => ({ t: "weapon", ...w }));
  for (const k of HEALS) for (let i = 0; i < META.start.heals[k]; i++) stash.push({ t: "heal", kind: k });
  return { v: 1, cash: META.start.cash, stash, raids: 0, extracted: 0 };
}

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
  }
}

/** What the trader pays for an item: valuables at full value, gear at a share of its price. */
export const sellPrice = (i: Item) => (i.t === "valuable" ? price(i) : Math.round(price(i) * META.sellShare));

/** Everything the trader sells. */
export function wares(): Item[] {
  const out: Item[] = [];
  for (const kind of Object.keys(META.weapon) as WeaponKind[])
    for (let r = 0; r <= META.shopRarity; r++) out.push({ t: "weapon", kind, rarity: r as Rarity });
  for (let tier = 1; tier <= META.shopRarity; tier++) out.push({ t: "armor", tier: tier as Rarity });
  for (const kind of HEALS) out.push({ t: "heal", kind });
  return out;
}

export const sameItem = (a: Item, b: Item) => JSON.stringify(a) === JSON.stringify(b);

/** Buys one item into the stash; null when it cannot be afforded or the stash is full. */
export function buy(p: Profile, i: Item): Profile | null {
  if (p.cash < price(i) || p.stash.length >= META.stash) return null;
  return { ...p, cash: p.cash - price(i), stash: [...p.stash, { ...i }] };
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
}

export const emptyLoadout = (): Loadout => ({ weapons: [], armor: null, heals: { cell: 0, battery: 0, syringe: 0, medkit: 0 } });

/** How many of a heal the stash holds. */
export const healCount = (p: Profile, k: HealKind) => p.stash.filter((i) => i.t === "heal" && i.kind === k).length;

/**
 * Takes a loadout out of the stash. Picking no weapon means the free kit: its weapons and
 * heals are lent, and any heals picked from the stash come on top of them.
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
  const lentHeals = free ? { ...META.free.heals } : { cell: 0, battery: 0, syringe: 0, medkit: 0 };
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
  const kit: Kit = {
    weapons: free ? META.free.weapons.map((w) => ({ ...w, loan: true })) : weapons,
    armor,
    heals: Object.fromEntries(HEALS.map((k) => [k, heals[k] + lentHeals[k]])) as Record<HealKind, number>,
    lentHeals,
  };
  return { profile: { ...p, stash: p.stash.filter((_, n) => !take.has(n)) }, kit };
}

/** The most valuable valuables that fit in `slots` bag slots. */
export function pouch(haul: ValuableKind[], slots = META.pouch): ValuableKind[] {
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

/** What a raid brings home, and what the stash had no room for (sold on the spot). */
export interface Settlement {
  profile: Profile;
  home: Item[];
  sold: Item[];
  soldFor: number;
}

/** Puts what came off the island into the stash. */
export function settle(p: Profile, kit: Kit, s: State): Settlement {
  const pl = s.player;
  const home: Item[] = [];
  if (s.outcome === "extracted") {
    for (const w of pl.weapons) if (w && !w.loan) home.push({ t: "weapon", kind: w.kind, rarity: w.rarity });
    if (pl.armor > 0) home.push({ t: "armor", tier: pl.armor });
    for (const k of HEALS) for (let i = Math.max(0, pl.heals[k] - kit.lentHeals[k]); i > 0; i--) home.push({ t: "heal", kind: k });
    for (const v of pl.haul) home.push({ t: "valuable", kind: v });
  } else {
    for (const v of pouch(pl.haul)) home.push({ t: "valuable", kind: v });
  }
  const room = Math.max(0, META.stash - p.stash.length);
  // Valuables are worth the same sold now or later, so they are the first to go when room runs out.
  const keep = [...home].sort((a, b) => Number(a.t === "valuable") - Number(b.t === "valuable"));
  const kept = keep.slice(0, room);
  const sold = keep.slice(room);
  const soldFor = sold.reduce((n, i) => n + sellPrice(i), 0);
  return {
    profile: {
      ...p,
      cash: p.cash + soldFor,
      stash: [...p.stash, ...kept],
      raids: p.raids + 1,
      extracted: p.extracted + (s.outcome === "extracted" ? 1 : 0),
    },
    home,
    sold,
    soldFor,
  };
}

/** Accepts a stored profile only if it has the right shape. */
export function parseProfile(raw: unknown): Profile | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.v !== 1 || typeof o.cash !== "number" || !Array.isArray(o.stash)) return null;
  const ok = (i: unknown): i is Item => {
    if (!i || typeof i !== "object") return false;
    const x = i as Record<string, unknown>;
    if (x.t === "weapon") return typeof x.kind === "string" && x.kind in META.weapon && [0, 1, 2, 3].includes(x.rarity as number);
    if (x.t === "armor") return [1, 2, 3].includes(x.tier as number);
    if (x.t === "heal") return HEALS.includes(x.kind as HealKind);
    if (x.t === "valuable") return typeof x.kind === "string" && x.kind in VALUABLES;
    return false;
  };
  return {
    v: 1,
    cash: Math.max(0, Math.floor(o.cash)),
    stash: o.stash.filter(ok).slice(0, META.stash),
    raids: typeof o.raids === "number" ? o.raids : 0,
    extracted: typeof o.extracted === "number" ? o.extracted : 0,
  };
}
