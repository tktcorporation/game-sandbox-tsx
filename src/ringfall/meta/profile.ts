import { DEPOT, FACTORY, FACTORY_TOP, HEAL_KINDS, HEALS as HEAL_SPECS, HIDEOUT, META, MOD_KINDS, MOMENTUM, FINALE, MOD_START, THREAT, TOOLS, VALUABLES, type ModKind, type HealKind, type ModuleId, type Rarity, type ToolKind, type ValuableKind, type WeaponKind, type FactoryCost } from "../sim/config";
import { depotIndex, DEPOTS, ENTRIES, HOME_REGION, NODES, nodeIndex, POIS, poiIndex, REGIONS, regionOf, ROUTES, type EntryId, type NodeId, type PoiId, type RegionId, type RouteId } from "../sim/map";
import { openRoutes } from "../sim/routes";
import { encodeSeen, type Kit, type State } from "../sim/state";
import { emptyHideout, infirmaryHeals, MODULES, nextLevel, onSale, pouchSlots, stashCap, stillNeeded, type Hideout } from "./hideout";
import { advanceDay, dayChange, departDepots, holdsOf, unlocked, type DayChange, type FrontChange, heldIncome, newIsland, parseIsland, raidDay, shopRarity, type Island } from "./island";
import { rivalOf } from "../sim/holds";
import { addRetaken, awayIncome, parseIncoming, parseOutgoing, parseRetaken, recallAll, retakenNodes, type Incoming, type Outgoing } from "./expeditions";
import { LOCAL_AID, parseParcels, type Parcel } from "./parcels";
import { capturedIds, momentum } from "../sim/front";
import { TROPHY, trophyDelta } from "./trophies";

/**
 * One thing in the stash. Heals are one entry per unit, so the stash cap counts them. A weapon
 * marked `starter` is one of the starter weapons (`META.starter`), which the stash always holds
 * (`withStarters()`): it cannot be sold, no raid loses it, and it takes no room.
 */
export type Item =
  | { t: "weapon"; kind: WeaponKind; rarity: Rarity; starter?: true }
  | { t: "armor"; tier: Rarity }
  | { t: "heal"; kind: HealKind }
  | { t: "valuable"; kind: ValuableKind }
  | { t: "key"; poi: PoiId }
  | { t: "tool"; kind: ToolKind };

/** What persists between raids. */
export interface Profile {
  v: 42;
  cash: number;
  stash: Item[];
  raids: number;
  extracted: number;
  /** Seconds spent in raids, all told. */
  time: number;
  /** The region the last raid started in. */
  region: RegionId;
  /** The way in the last raid that did not start at a depot took: the base offers it first next time. */
  entry: EntryId;
  /** The ways in the base offers (`ENTRIES` order): the reservoir's first, and those walked to in raids the player got off alive. */
  entries: EntryId[];
  hideout: Hideout;
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
  /** The island's day: the next raid is played on it, and each settled raid ends it. */
  day: number;
  /** Who holds each POI (meta/island.ts). */
  poiState: Island;
  /** The mod kinds known (`MODS`), in `MOD_KINDS` order: the bins hold these; more are learned by analysis. */
  known: ModKind[];
  /**
   * Kept for save compat / map (`freedAt`); round 強度 comes from `cycle` via `raidThreat()`.
   * Not chosen on a contract board (removed).
   */
  threat: number;
  /** The highest 強度 each POI was freed at. */
  freedAt: Partial<Record<PoiId, number>>;
  /** The camp's factory's level (`FACTORY`): 0 is the factory the camp starts with. */
  factory: number;
  /** The rounds of the island behind the player (`FINALE`): 0 on the first; each raises every raid's 強度. */
  cycle: number;
  /** The day the round under way began. */
  cycleDay: number;
  /** The days each round behind the player took, oldest first. */
  liberations: number[];
  /** What the last raid took out of the stash, so the shelves pick it again while the stash still holds it (`recallLoadout()`). */
  lastKit: KitPicks | null;
  /** The expeditions this island's factory sent to other players' islands, as they last stood (meta/expeditions.ts). */
  expeditions: Outgoing[];
  /** The last entry of this island's log on the server taken in: the next sync reads the ones after it. */
  logSeq: number;
  /**
   * Nodes the raids took back from other players whose report the server has not yet answered:
   * every report names them (`retaken`), and they leave this list only when one is answered 200.
   */
  retaken: NodeId[];
  /** Other players' expeditions on this island that hold nothing yet, as the server last showed them (予告): the camp's maps mark their nodes, and the next raid takes them in. */
  incoming: Incoming[];
  /**
   * Parcels at this island's depots (ux-design C2): from the server when one answers, else those
   * left in raids while offline / on AI islands. v29 and older saves hold none.
   */
  parcels: Parcel[];
  /** Legacy short-raid seize list; dropped on load (v41 stack). */
  incursionTaken: { code: string; ids: number[] }[];
  /**
   * Trophy ranking T1 (game-design-review §5.5): rises when a rival / AI node is taken in a raid,
   * falls when a node is lost to another player. v31 and older saves start at `TROPHY.start`.
   */
  trophies: number;
  /**
   * 島の知らせの控え（リザルトと同じ文、最新 10 件・newest first）。
   * v39 以前のセーブは無し。ページを読み直しても信号所に残る。
   */
  news: string[];
  /**
   * Items that did not fit the stash after settle / load (倉庫の整理待ち).
   * v41 and older saves hold none; excess on load goes here instead of being dropped.
   */
  pending: Item[];
  /**
   * Manual hunt target (a valuable kind). Null means auto: chase what the next hand's module needs.
   * v41 and older saves have none (auto).
   */
  goal: ValuableKind | null;
}

/** A loadout by what it holds rather than by stash index: what `Profile.lastKit` keeps. */
export interface KitPicks {
  weapons: { kind: WeaponKind; rarity: Rarity; starter?: true }[];
  /** The armour's tier, 0 for none. */
  armor: Rarity;
  keys: PoiId[];
  heals: Record<HealKind, number>;
}

/** The way in a new player knows: the reservoir's first. */
export const FIRST_ENTRY: EntryId = HOME_REGION.entries[0];

/** Ways in as a known list: real ones only, once each, in `ENTRIES` order, always with `FIRST_ENTRY`. */
export const knownEntries = (ids: readonly string[]): EntryId[] => ENTRIES.filter((e) => e.id === FIRST_ENTRY || ids.includes(e.id)).map((e) => e.id);

/** Where a raid may start in a region: its known ways in, and the depots on there that the nodes held open a start from (`departDepots()`). */
export const startsIn = (p: Pick<Profile, "entries" | "depots" | "poiState">, region: RegionId) => ({
  entries: regionOf(region).entries.filter((e) => p.entries.includes(e)),
  depots: departDepots(p).filter((d) => regionOf(region).pois.includes(d)),
});

/** Whether a raid may start in a region at all: it needs a way in known there or a depot on. */
export const canStartIn = (p: Pick<Profile, "entries" | "depots" | "poiState">, region: RegionId) => {
  const s = startsIn(p, region);
  return s.entries.length > 0 || s.depots.length > 0;
};

/** Whether a stash entry is one of the starter weapons. */
export const isStarter = (i: Item | undefined): boolean => i?.t === "weapon" && i.starter === true;

/** The starter weapons as stash entries, in `META.starter` order. */
const starterItems = (): Item[] => META.starter.weapons.map((w) => ({ t: "weapon", kind: w.kind, rarity: w.rarity, starter: true }));

/**
 * The stash with the starter weapons in it: each one kept where it stands, one missing put at the
 * head, and a second copy of one dropped. Every profile goes through it (`newProfile()`,
 * `parseProfile()`, `settle()`), so the stash never lacks them.
 */
export function withStarters(stash: Item[]): Item[] {
  const want = starterItems();
  const out = stash.filter((i) => {
    if (!isStarter(i)) return true;
    const n = want.findIndex((w) => sameItem(w, i));
    if (n < 0) return false;
    want.splice(n, 1);
    return true;
  });
  return [...want, ...out];
}

/** The stash entries that take room (`stashCap()`): all but the starter weapons. */
export const stashUsed = (p: Pick<Profile, "stash">) => p.stash.filter((i) => !isStarter(i)).length;

export function newProfile(seed = 1): Profile {
  const stash: Item[] = [...starterItems(), ...META.start.weapons.map((w): Item => ({ t: "weapon", ...w }))];
  for (const k of HEAL_KINDS) for (let i = 0; i < META.start.heals[k]; i++) stash.push({ t: "heal", kind: k });
  return {
    v: 42,
    cash: META.start.cash,
    stash,
    raids: 0,
    extracted: 0,
    time: 0,
    region: HOME_REGION.id,
    entry: FIRST_ENTRY,
    entries: [FIRST_ENTRY],
    hideout: emptyHideout(),
    seed: seed & 0xffff,
    depots: [],
    depotSent: {},
    seen: "",
    routes: [],
    day: 1,
    poiState: newIsland(),
    known: [...MOD_START],
    threat: 0,
    freedAt: {},
    factory: 0,
    cycle: 0,
    cycleDay: 1,
    liberations: [],
    lastKit: null,
    expeditions: [],
    logSeq: 0,
    retaken: [],
    incoming: [],
    parcels: [],
    incursionTaken: [],
    trophies: TROPHY.start,
    news: [],
    pending: [],
    goal: null,
  };
}

/** The 強度 every raid of the profile's round plays at: `FINALE.threat` a round freed. */
export const roundThreat = (p: Partial<Pick<Profile, "cycle">>) => Math.min(THREAT.max, (p.cycle ?? 0) * FINALE.threat);

/** The 強度 the next raid plays at: the round's alone. */
export const raidThreat = (p: Partial<Pick<Profile, "cycle">>) => roundThreat(p);

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

/** Everything the trader sells: gear up to the rarity the nodes held open (`shopRarity()`), materials by the workbench. */
export function wares(p: Profile): Item[] {
  const best = shopRarity(p);
  const out: Item[] = [];
  for (const kind of Object.keys(META.weapon) as WeaponKind[])
    for (let r = 0; r <= best; r++) out.push({ t: "weapon", kind, rarity: r as Rarity });
  for (let tier = 1; tier <= best; tier++) out.push({ t: "armor", tier: tier as Rarity });
  for (const kind of HEAL_KINDS) out.push({ t: "heal", kind });
  for (const kind of onSale(p.hideout)) out.push({ t: "valuable", kind });
  return out;
}

export const sameItem = (a: Item, b: Item) => JSON.stringify(a) === JSON.stringify(b);

/** Buys one item into the stash; null when it cannot be afforded or the stash is full. */
export function buy(p: Profile, i: Item): Profile | null {
  if (p.cash < buyPrice(i) || stashUsed(p) >= stashCap(p.hideout)) return null;
  return { ...p, cash: p.cash - buyPrice(i), stash: [...p.stash, { ...i }] };
}

/** Sells the stash entry at `index`. A starter weapon is not for sale: the profile stays as it is. */
export function sell(p: Profile, index: number): Profile {
  const i = p.stash[index];
  if (!i || isStarter(i)) return p;
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

/** Heals issued to every raid, whatever it carries: `META.starter.heals` and the infirmary's. */
export function issuedHeals(p: Pick<Profile, "hideout"> & Partial<Pick<Profile, "poiState">>): Record<HealKind, number> {
  const sick = infirmaryHeals(p.hideout);
  // The nodes held that issue a heal (`UNLOCKS[].heal`) add theirs.
  const nodes = p.poiState ? unlocked({ poiState: p.poiState }).heals : [];
  return Object.fromEntries(HEAL_KINDS.map((k) => [k, Math.min(HEAL_SPECS[k].max, META.starter.heals[k] + sick[k] + nodes.filter((h) => h === k).length)])) as Record<HealKind, number>;
}

/** How many heals of a kind a loadout can take from the stash: what it holds, up to what the issued ones leave room for. */
export function healRoom(p: Profile, k: HealKind): number {
  return Math.max(0, Math.min(healCount(p, k), HEAL_SPECS[k].max - issuedHeals(p)[k]));
}

/** The stash indices of the starter weapons, in stash order. */
export const starterPicks = (p: Pick<Profile, "stash">): number[] => p.stash.flatMap((i, n) => (isStarter(i) ? [n] : []));

/** A loadout that picks no weapon picks the starter weapons: no raid goes out unarmed. */
export const armed = (p: Pick<Profile, "stash">, l: Loadout): Loadout => (l.weapons.some((n) => p.stash[n]?.t === "weapon") ? l : { ...l, weapons: starterPicks(p).slice(0, 2) });

/** What a loadout takes, by what it holds: `Profile.lastKit` after a raid starts with it. */
export function kitPicks(p: Profile, l: Loadout): KitPicks {
  const k = picks(p, l);
  const a = k.armor === null ? undefined : p.stash[k.armor];
  return {
    weapons: k.weapons.flatMap((n) => {
      const i = p.stash[n];
      return i?.t === "weapon" ? [{ kind: i.kind, rarity: i.rarity, ...(i.starter ? { starter: true as const } : {}) }] : [];
    }),
    armor: a?.t === "armor" ? a.tier : 0,
    keys: k.keys.flatMap((n) => {
      const i = p.stash[n];
      return i?.t === "key" ? [i.poi] : [];
    }),
    heals: Object.fromEntries(HEAL_KINDS.map((h) => [h, Math.max(0, Math.min(l.heals[h], healRoom(p, h)))])) as Record<HealKind, number>,
  };
}

/**
 * The last raid's loadout picked again from the stash as it stands: each weapon, the armour and
 * each key while the stash still holds one like it, and the heals up to what it holds now. A
 * weapon of it no longer in the stash leaves its slot to a starter weapon not picked yet, so the
 * shelves always pick two weapons (with no last raid, the two starters).
 */
export function recallLoadout(p: Profile): Loadout {
  const l = emptyLoadout();
  const last = p.lastKit;
  if (!last) return armed(p, l);
  const used = new Set<number>();
  const find = (match: (i: Item) => boolean) => {
    const n = p.stash.findIndex((i, at) => !used.has(at) && match(i));
    if (n >= 0) used.add(n);
    return n;
  };
  for (const w of last.weapons.slice(0, 2)) {
    const n = find((i) => i.t === "weapon" && i.kind === w.kind && i.rarity === w.rarity && isStarter(i) === !!w.starter);
    if (n >= 0) l.weapons.push(n);
  }
  if (last.armor > 0) {
    const n = find((i) => i.t === "armor" && i.tier === last.armor);
    if (n >= 0) l.armor = n;
  }
  for (const poi of last.keys) {
    const n = find((i) => i.t === "key" && i.poi === poi);
    if (n >= 0) l.keys.push(n);
  }
  for (const h of HEAL_KINDS) l.heals[h] = Math.max(0, Math.min(last.heals[h] ?? 0, healRoom(p, h)));
  for (const n of starterPicks(p)) if (l.weapons.length < 2 && !l.weapons.includes(n)) l.weapons.push(n);
  return armed(p, l);
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

/** What one stash entry costs of a depot start's allowance (`DEPOT`): the starter weapons, heals and valuables nothing. */
export function itemCost(i: Item): number {
  if (i.t === "weapon") return i.starter ? 0 : DEPOT.weaponCost[i.rarity];
  if (i.t === "armor") return DEPOT.armorCost[i.tier];
  if (i.t === "key") return DEPOT.keyCost;
  return 0;
}

/** What a loadout costs of a depot start's allowance. The starter weapons and all heals cost nothing. */
export function loadoutCost(p: Profile, l: Loadout): number {
  const k = picks(p, armed(p, l));
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
 * only from a depot on that a node held opens a start from (`departDepots()`), and within its allowance.
 */
export function fitsStart(p: Profile, l: Loadout, from: PoiId | null): boolean {
  if (from === null) return true;
  return departDepots(p).includes(from) && loadoutCost(p, l) <= depotBudget(p, from);
}

/**
 * Takes a loadout out of the stash. Picking no weapon picks the starter weapons (`armed()`), which
 * go along but stay in the stash: they are never lost. The heals issued to every raid
 * (`issuedHeals()`) come on top of any picked from the stash. A start from a depot is held to its
 * allowance. The profile remembers the loadout (`Profile.lastKit`) for the next raid.
 */
export function takeKit(p: Profile, l: Loadout): { profile: Profile; kit: Kit };
/** For a start from a depot (`from`), null when the loadout does not fit its allowance (`fitsStart()`). */
export function takeKit(p: Profile, l: Loadout, from: PoiId | null): { profile: Profile; kit: Kit } | null;
export function takeKit(p: Profile, given: Loadout, from: PoiId | null = null): { profile: Profile; kit: Kit } | null {
  const l = armed(p, given);
  if (!fitsStart(p, l, from)) return null;
  const take = new Set<number>();
  const weapons: Kit["weapons"] = [];
  const out = new Set<number>();
  for (const n of l.weapons.slice(0, 2)) {
    const i = p.stash[n];
    if (i?.t === "weapon" && !out.has(n)) {
      out.add(n);
      // A starter weapon goes along but its stash entry stays.
      if (i.starter) weapons.push({ kind: i.kind, rarity: i.rarity, starter: true });
      else {
        take.add(n);
        weapons.push({ kind: i.kind, rarity: i.rarity });
      }
    }
  }
  let armor: Rarity = 0;
  const a = l.armor === null ? undefined : p.stash[l.armor];
  if (a?.t === "armor" && l.armor !== null) {
    take.add(l.armor);
    armor = a.tier;
  }
  const issued = issuedHeals(p);
  const heals = { cell: 0, battery: 0, syringe: 0, medkit: 0 } as Record<HealKind, number>;
  for (const k of HEAL_KINDS) {
    // A kind holds at most HEAL_SPECS[k].max, issued ones included.
    let want = Math.min(l.heals[k], HEAL_SPECS[k].max - issued[k]);
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
    weapons,
    armor,
    heals: Object.fromEntries(HEAL_KINDS.map((k) => [k, heals[k] + issued[k]])) as Record<HealKind, number>,
  };
  return { profile: { ...p, stash: p.stash.filter((_, n) => !take.has(n)), lastKit: kitPicks(p, l) }, kit };
}

/**
 * What comes home through the pouch on a wipe: the tools, in the order taken, while they fit
 * (they are what opens a route), then the most valuable valuables in the slots left (`at`: their
 * places in `haul`). This is the wipe path; `bestFitValuables` is only the valuables knapsack
 * used by pacing.
 */
export function pouchKeep(haul: ValuableKind[], tools: ToolKind[], slots: number = META.pouch): { haul: ValuableKind[]; tools: ToolKind[]; at: number[] } {
  const kept: ToolKind[] = [];
  let left = slots;
  for (const k of tools)
    if (TOOLS[k].size <= left) {
      kept.push(k);
      left -= TOOLS[k].size;
    }
  const at = bestFitValuableSlots(haul, left);
  return { haul: at.map((n) => haul[n]), tools: kept, at };
}

/** The most valuable valuables that fit in `slots` bag slots (valuables only; wipe uses `pouchKeep`). */
export const bestFitValuables = (haul: ValuableKind[], slots: number = META.pouch): ValuableKind[] => bestFitValuableSlots(haul, slots).map((n) => haul[n]);

/** The places in `haul` of the most valuable valuables that fit in `slots` bag slots. */
function bestFitValuableSlots(haul: ValuableKind[], slots: number): number[] {
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
  return best[Math.max(0, slots)]?.pick ?? [];
}

/**
 * What a raid brings home, the routes its tools opened (the tools spent on them are in `home`
 * but not in the stash), the ways in it taught, and what the stash had no room for (倉庫の整理待ち).
 */
export interface Settlement {
  profile: Profile;
  home: Item[];
  opened: RouteId[];
  /** Ways in the raid walked to that the base did not offer before (only when the player got off alive). */
  learned: EntryId[];
  /**
   * Overflow this settle (also on `profile.pending`). Kept as `sold` for older results lines until
   * 倉庫の整理 sells chosen items; `soldFor` is 0 from settle (nothing is sold on the spot).
   */
  sold: Item[];
  soldFor: number;
  /** Same items as `sold` after settle: the haul that waits for 倉庫の整理. */
  pending: Item[];
  /** The island's day the raid was played on (the profile is on the next). */
  day: number;
  /** Nodes that became the player's overnight (`DayChange.gained`). */
  gained: NodeId[];
  /** The nodes that turned the player's overnight, and those the enemy took, all told and in turn (`DayChange`). */
  front: FrontChange;
  /** Other players' nodes beat by beat (`DayChange.rivals`); left out, none. */
  rivals?: DayChange["rivals"];
  raid: FrontChange;
  after: FrontChange;
  /**
   * Credits the nodes the player holds paid at this settle (`heldIncome()`), plus any still held
   * away on other islands (`awayIncome()` folded in — 方向 A: 拠点の収入に一本化).
   */
  income: number;
  /** The raid won the decisive battle (`FINALE`): the days the round took, and the rounds now behind the player; left out, it did not. */
  liberated?: { days: number; cycle: number };
  /** Credits for the nodes the raid took after its first, got off alive (`MOMENTUM.spoils`); left out, none. */
  spoils?: number;
  /** The 強度 the raid was played at. */
  threat: number;
  /** The mod parts worn when the raid ended, which may be analysed (`analyse()`): none unless the player got off alive. */
  analysable: ModKind[];
  /** Trophy T1 change this settle (`gained` / `lost` counts); left out when none moved. */
  trophies?: { before: number; after: number; gained: number; lost: number };
  /**
   * Rival / contested hubs taken this settle (home raid): owner id at raid start, for 島の知らせ
   * 「{誰}の{拠点}を取った · トロフィー +n · 倉庫へ届く」. Left out when none.
   */
  takenRival?: { id: NodeId; owner: string }[];
  /**
   * CoC-style raid loot from 制圧 that actually entered the stash this settle (not left pending).
   * View-only: 「倉庫へ届いた」 must not claim overflow that 「倉庫に入らなかった」 already lists.
   */
  seized?: { poi: PoiId; kinds: ValuableKind[] }[];
}

/** Whether the profile still has items waiting for 倉庫の整理 (blocks departure from the gate). */
export const needsOrganize = (p: Pick<Profile, "pending">) => (p.pending?.length ?? 0) > 0;

/** Free stash slots (starter weapons take none). */
export const stashRoom = (p: Pick<Profile, "stash" | "hideout">) => Math.max(0, stashCap(p.hideout) - stashUsed(p));

/**
 * Sells one pending item during 倉庫の整理. Returns null when the index is out of range.
 * Credits go to the profile; the item leaves pending.
 */
export function sellPending(p: Profile, index: number): { profile: Profile; sold: Item; soldFor: number } | null {
  const i = p.pending[index];
  if (!i) return null;
  const soldFor = sellPrice(i);
  return {
    profile: { ...p, cash: p.cash + soldFor, pending: p.pending.filter((_, n) => n !== index) },
    sold: i,
    soldFor,
  };
}

/**
 * Sells one stash entry during 倉庫の整理 to free a slot. A starter weapon is not for sale.
 */
export function sellForOrganize(p: Profile, index: number): { profile: Profile; sold: Item; soldFor: number } | null {
  const i = p.stash[index];
  if (!i || isStarter(i)) return null;
  const soldFor = sellPrice(i);
  return {
    profile: { ...p, cash: p.cash + soldFor, stash: p.stash.filter((_, n) => n !== index) },
    sold: i,
    soldFor,
  };
}

/**
 * Moves one pending item into the stash when there is room. Null when full or the index is bad.
 */
export function keepPending(p: Profile, index: number): Profile | null {
  const i = p.pending[index];
  if (!i || stashRoom(p) <= 0) return null;
  return {
    ...p,
    stash: [...p.stash, i],
    pending: p.pending.filter((_, n) => n !== index),
  };
}

/** Mod kinds as a known list: real ones only, once each, in `MOD_KINDS` order, always with `MOD_START`. */
export const knownMods = (ids: readonly unknown[]): ModKind[] => MOD_KINDS.filter((k) => MOD_START.includes(k) || ids.includes(k));

/**
 * Analyses one mod part the settled raid brought out (`Settlement.analysable`): its kind joins the
 * known ones, so the bins hold it from the next raid on. Null for a kind the raid did not bring
 * out alive, or one already known.
 */
export function analyse(p: Profile, settled: Pick<Settlement, "analysable">, kind: ModKind): Profile | null {
  if (!settled.analysable.includes(kind) || p.known.includes(kind)) return null;
  return { ...p, known: knownMods([...p.known, kind]) };
}

/** Valuables the factory's levels not yet built still ask for, by kind. */
export function factoryNeeded(p: Pick<Profile, "factory">): Record<ValuableKind, number> {
  const out = Object.fromEntries(Object.keys(VALUABLES).map((k) => [k, 0])) as Record<ValuableKind, number>;
  for (const l of FACTORY.levels.slice(p.factory + 1)) for (const [k, n] of l.cost?.items ?? []) out[k] += n;
  return out;
}

/** Valuables the hideout still asks for beyond what the stash holds, by kind. */
export function hideoutWanted(p: Profile): Record<ValuableKind, number> {
  const out = stillNeeded(p.hideout);
  for (const i of p.stash) if (i.t === "valuable") out[i.kind]--;
  return out;
}

/** Valuables the hideout and the factory still ask for beyond what the stash holds, by kind. */
export function wanted(p: Profile): Record<ValuableKind, number> {
  const out = stillNeeded(p.hideout);
  const fac = factoryNeeded(p);
  for (const k of Object.keys(out) as ValuableKind[]) out[k] += fac[k];
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

/**
 * Puts items into the stash in `keepOrder()`; what does not fit joins `pending` (倉庫の整理待ち).
 * Nothing is sold here — the player chooses in 倉庫の整理.
 */
function store(p: Profile, items: Item[]): { profile: Profile; pending: Item[] } {
  const room = stashRoom(p);
  const keep = keepOrder(items, wanted(p));
  const pending = keep.slice(room);
  return {
    profile: {
      ...p,
      stash: [...p.stash, ...keep.slice(0, room)],
      pending: [...(p.pending ?? []), ...pending],
    },
    pending,
  };
}

/**
 * Puts what came off the island into the stash.
 * What was sent home from a depot arrives however the raid ended; the depots switched on
 * and the map explored are kept too. The ways in walked to are learned only when the player got
 * off alive: a wipe forgets them.
 */
export function settle(p: Profile, s: State): Settlement {
  const pl = s.player;
  // A record of a raid kept from before tools were carried has none.
  const tools = pl.tools ?? [];
  const home: Item[] = [...s.sent.map((v): Item => ({ t: "valuable", kind: v })), ...(s.sentTools ?? []).map((k): Item => ({ t: "tool", kind: k }))];
  if (s.outcome === "extracted") {
    // The starter weapons never left the stash.
    for (const w of pl.weapons) if (w && !w.starter) home.push({ t: "weapon", kind: w.kind, rarity: w.rarity });
    if (pl.armor > 0) home.push({ t: "armor", tier: pl.armor });
    // Every heal left comes home, the issued ones too.
    for (const k of HEAL_KINDS) for (let i = pl.heals[k]; i > 0; i--) home.push({ t: "heal", kind: k });
    for (const v of pl.haul) home.push({ t: "valuable", kind: v });
    for (const poi of pl.keys) home.push({ t: "key", poi: POIS[poi].id });
    for (const k of tools) home.push({ t: "tool", kind: k });
  } else {
    const kept = pouchKeep(pl.haul, tools, pouchSlots(p.hideout));
    for (const v of kept.haul) home.push({ t: "valuable", kind: v });
    for (const k of kept.tools) home.push({ t: "tool", kind: k });
  }
  // CoC-style: 制圧 of another player's node seizes that 中継ボックス's 島の守り into the haul.
  // Only when the raid started with island holds (gate / no-island raids never hit this).
  const seized = seizeRivalLoot(p, s);
  if (seized.ids.length) s.takenParcels = [...(s.takenParcels ?? []), ...seized.ids];
  for (const it of seized.items) home.push(it);
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
  const day = raidDay(s);
  // Overnight change first (freedAt) while today's island still holds the stash packing.
  const change = dayChange(p, day);
  const threat = s.threat ?? 0;
  const { profile, pending } = store({ ...p, routes: openRoutes([...p.routes, ...opened]) }, home.filter((i) => !spent.has(i)));
  // 倉庫へ届いた must list only what store kept — overflow stays in pending / 「倉庫に入らなかった」 alone.
  const seizedKept = keptSeized(seized.at, p, profile);
  const depots = DEPOTS.map((d) => d.poi).filter((id, i) => p.depots.includes(id) || s.depots[i]);
  const depotSent = Object.fromEntries(depots.map((id) => [id, (p.depotSent[id] ?? 0) + (s.sentVia[depotIndex(id)] ?? 0)]));
  // A record of a raid kept from before ways in were learned has walked to none.
  const learned = s.outcome === "extracted" ? knownEntries(s.found ?? []).filter((e) => !p.entries.includes(e)) : [];
  const entries = knownEntries([...p.entries, ...learned]);
  const freedAt = { ...p.freedAt };
  for (const id of change.gained) freedAt[id] = Math.max(freedAt[id] ?? 0, threat);
  // Aid parcels left / taken this raid (ux-design C2): keep local until the island server answers.
  // `LOCAL_AID` survives parseProfile when sync never ran (Codex: empty code was dropped).
  const takenIds = new Set(s.takenParcels ?? []);
  let parcels = (p.parcels ?? []).filter((q) => !takenIds.has(q.id));
  const nextParcelId = () => 1 + parcels.reduce((n, q) => Math.max(n, q.id), 0);
  for (const left of s.leftParcels ?? []) {
    parcels = [
      ...parcels.filter((q) => q.poi !== left.poi || q.kind !== left.kind),
      { id: nextParcelId(), poi: left.poi, kind: left.kind, from: { code: LOCAL_AID, name: "" }, at: Date.now() },
    ];
  }
  const settled = { ...profile, freedAt, entries, raids: p.raids + 1, extracted: p.extracted + (s.outcome === "extracted" ? 1 : 0), time: p.time + s.time, seed: nextSeed(p.seed), depots, depotSent, seen: encodeSeen(s.seen), parcels, incursionTaken: [] };
  // Apply the same overnight pass once the raid's haul is on today's island.
  const { profile: night } = advanceDay(settled, day);
  // Trophy T1: rival nodes taken in the raid / lost overnight to another player.
  const beforeHolds = holdsOf(p.poiState);
  const afterHolds = holdsOf(night.poiState);
  const trop = trophyDelta(p.trophies ?? TROPHY.start, beforeHolds, afterHolds);
  if (trop.next !== (p.trophies ?? TROPHY.start)) Object.assign(night, { trophies: trop.next });
  // Defender partial loss: a node that left the player's overnight drops its 中継ボックス stock
  // (same line as 「取られた · 島の守りが{誰}の倉庫へ」).
  let nightParcels = night.parcels ?? parcels;
  for (const n of NODES) {
    const before = p.poiState[n.id]?.state;
    const after = night.poiState[n.id]?.state;
    if (before === "own" && after !== "own") nightParcels = nightParcels.filter((q) => q.poi !== n.id);
  }
  if (nightParcels !== (night.parcels ?? parcels)) Object.assign(night, { parcels: nightParcels });
  // The nodes the player holds once the night is over pay their day's credits.
  const homePay = heldIncome(night);
  // The decisive battle won (`FINALE`): the titan fell with its pad open. The round's days are kept, and the
  // island and the factory start over for the next round; the income above is the freed island's last.
  const liberated = !!s.finale && day.titan ? { days: p.day - p.cycleDay + 1, cycle: p.cycle + 1 } : null;
  // Other players' nodes stay theirs into the next round (the titan was the enemy's; nobody else's holding is undone unseen), and
  // the expeditions out are called home: the factory that kept them starts over.
  if (liberated) Object.assign(night, { poiState: { ...newIsland(), ...Object.fromEntries(Object.entries(night.poiState).filter(([, v]) => rivalOf(v.state) !== null)) }, factory: 0, cycle: liberated.cycle, cycleDay: night.day, liberations: [...p.liberations, liberated.days].slice(-50), expeditions: recallAll(night.expeditions) });
  // A raid that took more than one node and got off alive is paid for each after the first (`MOMENTUM.spoils`).
  const spoils = s.outcome === "extracted" ? MOMENTUM.spoils.slice(0, momentum(s)).reduce((a, c) => a + c, 0) : 0;
  // 方向 A: 遠征で持つ拠点の収入も拠点の収入に合算（リザルトの別行は出さない）。
  const away = awayIncome(night);
  const income = homePay + away;
  const dropGone = (list: typeof night.expeditions) => list.filter((e) => e.state !== "gone");
  const next = away > 0 || night.expeditions.some((e) => e.state === "gone") ? { ...night, cash: night.cash + income + spoils, expeditions: dropGone(night.expeditions) } : { ...night, cash: night.cash + income + spoils };
  // The nodes this raid took back from other players, by the island it started with (`State.hold`), wait to be reported.
  const started = { poiState: Object.fromEntries(POIS.map((o, i) => [o.id, { state: s.hold?.[i] ?? "foe" }])) as Island };
  const fresh = { ...next, stash: withStarters(next.stash) };
  fresh.retaken = addRetaken(p.retaken, retakenNodes(started, fresh, capturedIds(s)));
  const takenRival = trop.taken.flatMap((id) => {
    const owner = rivalOf(beforeHolds[nodeIndex(id)] ?? "foe");
    return owner ? [{ id, owner }] : [];
  });
  return {
    profile: fresh,
    home,
    opened,
    learned,
    // Until 倉庫の整理: overflow listed under the old results line (soldFor 0 — not sold).
    sold: pending,
    soldFor: 0,
    pending,
    day: p.day,
    ...change,
    income,
    ...(liberated && { liberated }),
    ...(spoils > 0 && { spoils }),
    threat,
    analysable: s.outcome === "extracted" ? [...(pl.mods ?? [])] : [],
    ...(trop.gained || trop.lost
      ? { trophies: { before: p.trophies ?? TROPHY.start, after: trop.next, gained: trop.gained, lost: trop.lost } }
      : {}),
    ...(takenRival.length ? { takenRival } : {}),
    ...(seizedKept.length ? { seized: seizedKept } : {}),
  };
}

/**
 * Of the valuables seized this raid, those that actually entered the stash after `store()`
 * (stash after − before budget). Pending overflow is dropped so the results' 「倉庫へ届いた」 and
 * 「倉庫に入らなかった」 never claim the same item.
 */
export function keptSeized(
  seized: readonly { poi: PoiId; kinds: ValuableKind[] }[],
  before: Pick<Profile, "stash">,
  afterStore: Pick<Profile, "stash">,
): { poi: PoiId; kinds: ValuableKind[] }[] {
  const count = (stash: readonly Item[]) => {
    const m = new Map<ValuableKind, number>();
    for (const i of stash) if (i.t === "valuable") m.set(i.kind, (m.get(i.kind) ?? 0) + 1);
    return m;
  };
  const beforeN = count(before.stash);
  const afterN = count(afterStore.stash);
  const budget = new Map<ValuableKind, number>();
  for (const [k, n] of afterN) {
    const d = n - (beforeN.get(k) ?? 0);
    if (d > 0) budget.set(k, d);
  }
  const out: { poi: PoiId; kinds: ValuableKind[] }[] = [];
  for (const q of seized) {
    const kinds: ValuableKind[] = [];
    for (const k of q.kinds) {
      const left = budget.get(k) ?? 0;
      if (left <= 0) continue;
      budget.set(k, left - 1);
      kinds.push(k);
    }
    if (kinds.length) out.push({ poi: q.poi, kinds });
  }
  return out;
}

/**
 * Raid loot from 制圧 of rival-held nodes (CoC-style): the 島の守り stock at that node's
 * 中継ボックス comes into the warehouse. With none stacked, a small reserve from the node's
 * seed still arrives so the capture feeds 拠点が育つ. No new verb — same 核 as enemy nodes.
 * Empty when the raid had no island / no rivals (sim gate path unchanged).
 */
export function seizeRivalLoot(
  p: Pick<Profile, "parcels" | "seed">,
  s: Pick<State, "hold" | "stats" | "seed">,
): { items: Item[]; ids: number[]; at: { poi: PoiId; kinds: ValuableKind[] }[] } {
  const items: Item[] = [];
  const ids: number[] = [];
  const at: { poi: PoiId; kinds: ValuableKind[] }[] = [];
  const hold = s.hold;
  if (!hold) return { items, ids, at };
  const stock = p.parcels ?? [];
  const taken = new Set<number>();
  for (const id of capturedIds(s)) {
    const i = poiIndex(id);
    if (i < 0 || rivalOf(hold[i] ?? "foe") === null) continue;
    const kinds: ValuableKind[] = [];
    for (const q of stock) {
      if (q.poi !== id || taken.has(q.id)) continue;
      taken.add(q.id);
      ids.push(q.id);
      items.push({ t: "valuable", kind: q.kind });
      kinds.push(q.kind);
    }
    // Empty depot: a single common material so 制圧 still grows the base (deterministic).
    if (!kinds.length) {
      const kind = raidReserveKind(s.seed ?? p.seed, id);
      items.push({ t: "valuable", kind });
      kinds.push(kind);
    }
    at.push({ poi: id, kinds });
  }
  return { items, ids, at };
}

/** A common material for an empty rival 中継ボックス, hashed from the raid seed and the POI. */
function raidReserveKind(seed: number, poi: PoiId): ValuableKind {
  const pool: ValuableKind[] = ["parts", "fuse", "board"];
  const h = (Math.imul(seed ^ 0x9e3779b9, poiIndex(poi) + 1) >>> 0) % pool.length;
  return pool[h]!;
}

/** What stands between a module and its next level: items short (kind, have, need) and credits short. */
export function shortfall(p: Profile, m: ModuleId): { items: [ValuableKind, number, number][]; cash: number } | null {
  const l = nextLevel(p.hideout, m);
  if (!l) return null;
  const have = (k: ValuableKind) => p.stash.filter((i) => i.t === "valuable" && i.kind === k).length;
  return {
    items: l.items.filter(([k, n]) => have(k) < n).map(([k, n]) => [k, have(k), n]),
    cash: Math.max(0, l.cash - p.cash),
  };
}

/**
 * What the module card says about its next level: done, buildable, or the first thing in the
 * way (the parts still missing, then only the credits).
 */
export function buildState(p: Profile, m: ModuleId): string {
  const s = shortfall(p, m);
  if (!s) return "完成";
  const missing = s.items.reduce((n, [, have, need]) => n + need - have, 0);
  if (missing) return `あと ${missing} 個`;
  if (s.cash) return `あと ${s.cash.toLocaleString()} クレジット`;
  return "作れる";
}

export const canBuild = (p: Profile, m: ModuleId) => {
  const s = shortfall(p, m);
  return !!s && !s.items.length && !s.cash;
};

/**
 * Builds a module's next level, taking its items and credits from the stash; null when it
 * cannot be built.
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
  return { ...p, cash: p.cash - l.cash, stash: p.stash.filter((_, at) => !take.has(at)), hideout };
}

/**
 * The POI ids in the order v1 and v2 saves numbered them: those saves kept a key's POI
 * as its place in this list.
 */
const V2_POIS: PoiId[] = ["supply", "quarry", "relay", "pad"];

/**
 * Accepts a stored profile only if it has the right shape. Older versions migrate forward;
 * v1–v33 fields `quests` / `board` / `taken` / `records` are ignored and dropped (v34).
 * v1–v34 field `events` is ignored and dropped (v35).
 * v1–v36 has nothing map-table-related on Profile to drop (the station was UI-only); emit as current.
 * v1–v37 has nothing vehicle-related on Profile to drop (camp vehicle was UI-only).
 * v1–v38 has nothing fortify-related on Profile to drop (fortify was raid/server only); accept saves and emit current.
 * v1–v39 has no island-news archive on Profile; v40 adds `news` (最新 10 件).
 * v1–v40 has nothing contested-hub-specific on Profile (ownership lives in poiState rival holds);
 * v41 marks 方向 A 取り合う拠点 (TKT-195) for stack consistency.
 * v41 and older have no `pending` / `goal`; v42 adds 倉庫の整理待ち and the hunt target.
 * Before v33 no "own" | "foe": legacy "freed" | "held" are normalized via parseIsland.
 */
export function parseProfile(raw: unknown, seed = 1): Profile | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42].includes(o.v as number) || typeof o.cash !== "number" || !Array.isArray(o.stash)) return null;
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
    if (x.t === "heal") return HEAL_KINDS.includes(x.kind as HealKind);
    if (x.t === "valuable") return typeof x.kind === "string" && x.kind in VALUABLES;
    if (x.t === "key") return typeof x.poi === "string" && poiIndex(x.poi as PoiId) >= 0;
    if (x.t === "tool") return typeof x.kind === "string" && x.kind in TOOLS;
    return false;
  };
  const h = (o.hideout ?? {}) as Record<string, unknown>;
  const hideout = emptyHideout();
  for (const m of MODULES) if (Number.isInteger(h[m])) hideout[m] = Math.max(0, Math.min(HIDEOUT[m].levels.length, h[m] as number));
  const num = (x: unknown) => (typeof x === "number" && x >= 0 ? x : 0);
  const depots = Array.isArray(o.depots) ? [...new Set(o.depots.filter((d): d is PoiId => typeof d === "string" && poiIndex(d as PoiId) >= 0))] : [];
  const ds = (typeof o.v === "number" && o.v >= 8 && o.depotSent && typeof o.depotSent === "object" ? o.depotSent : {}) as Record<string, unknown>;
  const depotSent = Object.fromEntries(depots.map((d) => [d, num(ds[d])]));
  const entries = typeof o.v === "number" && o.v < 11 ? ENTRIES.map((e) => e.id) : knownEntries(Array.isArray(o.entries) ? o.entries.filter((e): e is string => typeof e === "string") : []);
  const poiState = typeof o.v === "number" && o.v >= 13 ? parseIsland(o.poiState, o.v >= 26) : newIsland();
  const { region, entry } = allowedStart({ entries, depots, poiState }, REGIONS.find((r) => r.id === o.region)?.id ?? HOME_REGION.id, o.entry);
  const raids = num(o.raids);
  const day = (typeof o.v === "number" && o.v >= 13) && Number.isInteger(o.day) && (o.day as number) >= 1 ? (o.day as number) : raids + 1;
  const v17 = typeof o.v === "number" && o.v >= 17;
  const v19 = typeof o.v === "number" && o.v >= 19;
  const v20 = typeof o.v === "number" && o.v >= 20;
  const fa = (v17 && o.freedAt && typeof o.freedAt === "object" ? o.freedAt : {}) as Record<string, unknown>;
  const freedAt: Partial<Record<PoiId, number>> = {};
  for (const { id } of POIS) if (Number.isInteger(fa[id])) freedAt[id] = Math.max(0, Math.min(THREAT.max, fa[id] as number));
  // A weapon keeps its starter mark only as one of the starter weapons; the others' marks are dropped.
  const asItem = (i: Item): Item => (i.t === "weapon" ? { t: "weapon", kind: i.kind, rarity: i.rarity, ...(i.starter === true ? { starter: true as const } : {}) } : i);
  const items = o.stash.map(migrate).filter(ok).map(asItem);
  const cap = stashCap(hideout);
  // Cap excess goes to pending (倉庫の整理待ち) instead of being dropped silently.
  let room = cap;
  const kept: Item[] = [];
  const overflow: Item[] = [];
  for (const i of items) {
    if (isStarter(i) || room-- > 0) kept.push(i);
    else overflow.push(i);
  }
  const stash = withStarters(kept);
  const savedPending =
    typeof o.v === "number" && o.v >= 42 && Array.isArray(o.pending)
      ? o.pending.map(migrate).filter(ok).map(asItem).filter((i) => !isStarter(i))
      : [];
  const pending = [...overflow, ...savedPending];
  const goal =
    typeof o.v === "number" && o.v >= 42 && typeof o.goal === "string" && o.goal in VALUABLES ? (o.goal as ValuableKind) : null;
  const v27 = typeof o.v === "number" && o.v >= 27;
  const v28 = typeof o.v === "number" && o.v >= 28;
  const v32 = typeof o.v === "number" && o.v >= 32;
  const trophies = v32 && Number.isFinite(o.trophies) ? Math.max(TROPHY.min, Math.min(TROPHY.max, Math.floor(o.trophies as number))) : TROPHY.start;
  // Old quests / board / taken / records / events are dropped without reading (save compat).
  // v37: map table removed (no Profile fields to drop; stack consistency).
  // v38: camp vehicle removed (no Profile fields to drop; stack consistency).
  // v39: fortify (核 · 固める) removed (raid/server only; no Profile fields to drop; stack consistency).
  // v40: 島の知らせの控え（`news`）。v39 以前は無し。
  // v41: 取り合う海岸拠点（方向 A）。専用フィールドは無し（poiState の rival が持ち主）。
  // v42: 倉庫の整理待ち（`pending`）と入手先の目標（`goal`）。
  const news =
    typeof o.v === "number" && o.v >= 40 && Array.isArray(o.news)
      ? o.news.filter((s): s is string => typeof s === "string" && s.trim().length > 0).map((s) => s.trim()).slice(0, 10)
      : [];
  return {
    v: 42,
    cash: Math.max(0, Math.floor(o.cash)),
    stash,
    raids,
    extracted: num(o.extracted),
    time: num(o.time),
    region,
    entry,
    entries,
    hideout,
    seed: Number.isInteger(o.seed) ? (o.seed as number) & 0xffff : seed & 0xffff,
    depots,
    depotSent,
    seen: (typeof o.v === "number" && o.v >= 25) && typeof o.seen === "string" && /^[0-9a-f]*$/.test(o.seen) ? o.seen : "",
    routes: typeof o.v === "number" && o.v >= 9 && Array.isArray(o.routes) ? openRoutes(o.routes.filter((r): r is string => typeof r === "string")) : [],
    day,
    poiState,
    factory: v19 && Number.isInteger(o.factory) ? Math.max(0, Math.min(FACTORY_TOP, o.factory as number)) : 0,
    lastKit: v20 ? parseKitPicks(o.lastKit) : null,
    // PR6 / Codex: 出ている遠征 UI を消したあと、セーブに残った遠征はすべて引き上げ（工場スロットを空け、flushRecalls が DELETE）。
    // `sending` や id 未採番は島に届いていないので落とす（短いレイドの未完了含む）。
    expeditions: recallAll((v27 ? parseOutgoing(o.expeditions) : []).filter((e) => e.state !== "sending" && e.id > 0)),
    logSeq: v27 && Number.isInteger(o.logSeq) && (o.logSeq as number) >= 0 ? (o.logSeq as number) : 0,
    retaken: v27 ? parseRetaken(o.retaken) : [],
    incoming: typeof o.v === "number" && o.v >= 29 ? parseIncoming(o.incoming) : [],
    parcels: typeof o.v === "number" && o.v >= 30 ? parseParcels(o.parcels) : [],
    incursionTaken: [],
    trophies,
    news,
    pending,
    goal,
    // A save from before the island had an ending is on its first round, begun on day 1.
    cycle: v28 && Number.isInteger(o.cycle) && (o.cycle as number) >= 0 ? (o.cycle as number) : 0,
    cycleDay: v28 && Number.isInteger(o.cycleDay) && (o.cycleDay as number) >= 1 ? Math.min(day, o.cycleDay as number) : 1,
    liberations: v28 && Array.isArray(o.liberations) ? o.liberations.filter((n): n is number => Number.isInteger(n) && n > 0).slice(-50) : [],
    known: knownMods(v17 && Array.isArray(o.known) ? o.known : []),
    threat: v17 && Number.isInteger(o.threat) ? Math.max(0, Math.min(THREAT.max, o.threat as number)) : 0,
    freedAt,
  };
}

/** A saved `lastKit`: well-formed picks only, at most two weapons and a key per POI; anything unreadable, none. */
function parseKitPicks(raw: unknown): KitPicks | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const weapons = (Array.isArray(r.weapons) ? r.weapons : [])
    .filter((w): w is { kind: WeaponKind; rarity: Rarity; starter?: unknown } => !!w && typeof w === "object" && typeof (w as Record<string, unknown>).kind === "string" && ((w as Record<string, unknown>).kind as string) in META.weapon && [0, 1, 2, 3].includes((w as Record<string, unknown>).rarity as number))
    .slice(0, 2)
    .map((w) => ({ kind: w.kind, rarity: w.rarity, ...(w.starter === true ? { starter: true as const } : {}) }));
  const armor = ([0, 1, 2, 3].includes(r.armor as number) ? r.armor : 0) as Rarity;
  const keys = [...new Set((Array.isArray(r.keys) ? r.keys : []).filter((k): k is PoiId => typeof k === "string" && poiIndex(k as PoiId) >= 0))];
  const h = (r.heals && typeof r.heals === "object" ? r.heals : {}) as Record<string, unknown>;
  const heals = Object.fromEntries(HEAL_KINDS.map((k) => [k, Number.isInteger(h[k]) ? Math.max(0, Math.min(HEAL_SPECS[k].max, h[k] as number)) : 0])) as Record<HealKind, number>;
  return { weapons, armor, keys, heals };
}

/** What building the factory's next level takes, or null once it is at its top. */
export const nextFactory = (p: Pick<Profile, "factory">): FactoryCost | null => FACTORY.levels[p.factory + 1]?.cost ?? null;

/** What stands between the factory and its next level: items short (kind, have, need) and credits short; null at the top. */
export function factoryShortfall(p: Profile): { items: [ValuableKind, number, number][]; cash: number } | null {
  const l = nextFactory(p);
  if (!l) return null;
  const have = (k: ValuableKind) => p.stash.filter((i) => i.t === "valuable" && i.kind === k).length;
  return { items: l.items.filter(([k, n]) => have(k) < n).map(([k, n]) => [k, have(k), n]), cash: Math.max(0, l.cash - p.cash) };
}

export const canBuildFactory = (p: Profile) => {
  const s = factoryShortfall(p);
  return !!s && !s.items.length && !s.cash;
};

/** Raises the factory a level, taking its items and credits from the stash; null when it cannot. */
export function buildFactory(p: Profile): Profile | null {
  const l = nextFactory(p);
  if (!l || !canBuildFactory(p)) return null;
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
  return { ...p, cash: p.cash - l.cash, stash: p.stash.filter((_, at) => !take.has(at)), factory: p.factory + 1 };
}

/**
 * The start the base offers first: `region` and `entry` when they may be chosen, else the
 * region's first known way in; a region with neither a known way in nor a depot on gives way
 * to the reservoir, where `FIRST_ENTRY` is always known.
 */
export function allowedStart(p: Pick<Profile, "entries" | "depots" | "poiState">, region: RegionId, entry: unknown): { region: RegionId; entry: EntryId } {
  const known = (r: RegionId) => regionOf(r).entries.filter((e) => p.entries.includes(e));
  const reg = canStartIn(p, region) ? region : HOME_REGION.id;
  const ways = known(reg);
  const want = ENTRIES.find((e) => e.id === entry && e.region === reg && ways.includes(e.id));
  // A region open only through a depot keeps a known way in elsewhere as the record of the last walk in.
  const kept = p.entries.find((e) => e === entry);
  return { region: reg, entry: want?.id ?? ways[0] ?? kept ?? FIRST_ENTRY };
}
