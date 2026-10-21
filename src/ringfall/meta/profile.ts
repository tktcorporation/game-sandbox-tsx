import { DEPOT, HEALS as HEAL_SPECS, HIDEOUT, META, MOD_KINDS, MOD_START, NETWORK, THREAT, TOOLS, VALUABLES, type ModKind, type HealKind, type ModuleId, type Rarity, type ToolKind, type ValuableKind, type WeaponKind } from "../sim/config";
import { depotIndex, DEPOTS, ENTRIES, OUTPOST_SITES, POIS, poiIndex, REGIONS, regionOf, ROUTES, type EntryId, type NodeId, type OutpostId, type PoiId, type RecordId, type RegionId, type RouteId } from "../sim/map";
import { openRoutes } from "../sim/routes";
import { encodeSeen, type Kit, type State } from "../sim/state";
import { haulOrigins } from "../sim/world";
import { contractDone, makeBoard, parseBoard, sentOrigins, type Board, type Contract, type Fetched } from "./contracts";
import { craftDone, emptyHideout, infirmaryHeals, MODULES, nextLevel, onSale, pouchSlots, shopRarity, stashCap, stillNeeded, unmet, type Hideout } from "./hideout";
import { advanceDay, eventFor, firstEvents, frontIncome, newIsland, parseEvent, parseIsland, raidDay, retakable, type DayEvents, type Island, type NetChange } from "./island";
import { newOutposts, type OutpostHold } from "../sim/front";
import type { IslandEvent } from "../sim/island";
import { built, creditRaid, emptyLog, need, offered, QUEST_IDS, type Quest, type QuestLog } from "./quests";
import { currentStory, STORIES, type Story } from "./story";

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
  v: 18;
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
  /** The ways in the base offers (`ENTRIES` order): the reservoir's first, and those walked to in raids the player got off alive. */
  entries: EntryId[];
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
  /** The island's day: the next raid is played on it, and each settled raid ends it. */
  day: number;
  /** Who holds each POI, and the last day the player came into it (meta/island.ts). */
  poiState: Island;
  /** Who holds each outpost: the network, the rogues, or the player (sim/front.ts). */
  outposts: Record<OutpostId, OutpostHold>;
  /** The day's contract board (meta/contracts.ts), built when the day began. */
  board: Board;
  /** The id of the board's contract taken for the next raid, or null for none. */
  taken: string | null;
  /** The story records brought home (meta/story.ts): the story contract under way is the first not among them. */
  records: RecordId[];
  /** The robots' network level, 0 to `NETWORK.max` (meta/island.ts): the next raid is played at it. */
  network: number;
  /** What the network has gathered toward its next step, carried from day to day. */
  pressure: number;
  /** The island's events: today's (the next raid's) and tomorrow's, announced a day ahead (meta/island.ts). */
  events: DayEvents;
  /** The mod kinds known (`MODS`), in `MOD_KINDS` order: the bins hold these; more are learned by analysis. */
  known: ModKind[];
  /** The threat chosen at the map table for the next raid, 0 to `THREAT.max`. */
  threat: number;
  /** The highest threat each POI was freed at. */
  freedAt: Partial<Record<PoiId, number>>;
}

export const HEALS: HealKind[] = ["cell", "battery", "syringe", "medkit"];

/** The way in a new player knows: the reservoir's first. */
export const FIRST_ENTRY: EntryId = regionOf("reservoir").entries[0];

/** Ways in as a known list: real ones only, once each, in `ENTRIES` order, always with `FIRST_ENTRY`. */
export const knownEntries = (ids: readonly string[]): EntryId[] => ENTRIES.filter((e) => e.id === FIRST_ENTRY || ids.includes(e.id)).map((e) => e.id);

/** Where a raid may start in a region: its known ways in, and its depots on. */
export const startsIn = (p: Profile, region: RegionId) => ({
  entries: regionOf(region).entries.filter((e) => p.entries.includes(e)),
  depots: p.depots.filter((d) => regionOf(region).pois.includes(d)),
});

/** Whether a raid may start in a region at all: it needs a way in known there or a depot on. */
export const canStartIn = (p: Profile, region: RegionId) => {
  const s = startsIn(p, region);
  return s.entries.length > 0 || s.depots.length > 0;
};

export function newProfile(seed = 1): Profile {
  const stash: Item[] = META.start.weapons.map((w) => ({ t: "weapon", ...w }));
  for (const k of HEALS) for (let i = 0; i < META.start.heals[k]; i++) stash.push({ t: "heal", kind: k });
  const p: Omit<Profile, "board"> = { v: 18, cash: META.start.cash, stash, raids: 0, extracted: 0, time: 0, quests: emptyLog(), region: "reservoir", entry: FIRST_ENTRY, entries: [FIRST_ENTRY], hideout: emptyHideout(), escaped: null, seed: seed & 0xffff, depots: [], depotSent: {}, seen: "", routes: [], day: 1, poiState: newIsland(), outposts: newOutposts(NETWORK.start), taken: null, records: [], network: NETWORK.start, pressure: 0, events: firstEvents(seed & 0xffff, newIsland()), known: [...MOD_START], threat: 0, freedAt: {} };
  return { ...p, board: makeBoard(p) };
}

/** The board's contract taken for the next raid, or null. */
export const takenContract = (p: Pick<Profile, "board" | "taken" | "day">): Contract | null => (p.board.day === p.day ? (p.board.contracts.find((c) => c.id === p.taken) ?? null) : null);

/** Takes a contract of the day's board for the next raid (null takes none); one not on the board takes none. */
export const take = (p: Profile, id: string | null): Profile => ({ ...p, taken: p.board.contracts.some((c) => c.id === id) ? id : null });

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
 * What the pouch keeps on a wipe: the story records first (a slot each; nothing else tells their
 * story), then the tools, in the order taken, while they fit (they are what opens a route), then
 * the most valuable valuables in the slots left (`at`: their places in `haul`).
 */
export function pouchKeep(haul: ValuableKind[], tools: ToolKind[], slots: number = META.pouch, records: RecordId[] = []): { haul: ValuableKind[]; tools: ToolKind[]; records: RecordId[]; at: number[] } {
  const keptRecords = records.slice(0, slots);
  const kept: ToolKind[] = [];
  let left = slots - keptRecords.length;
  for (const k of tools)
    if (TOOLS[k].size <= left) {
      kept.push(k);
      left -= TOOLS[k].size;
    }
  const at = pouchPick(haul, left);
  return { haul: at.map((n) => haul[n]), tools: kept, records: keptRecords, at };
}

/** The most valuable valuables that fit in `slots` bag slots. */
export const pouch = (haul: ValuableKind[], slots: number = META.pouch): ValuableKind[] => pouchPick(haul, slots).map((n) => haul[n]);

/** The places in `haul` of the most valuable valuables that fit in `slots` bag slots. */
function pouchPick(haul: ValuableKind[], slots: number): number[] {
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
 * What a raid brings home, the quests it finished, the routes its tools opened (the tools spent
 * on them are in `home` but not in the stash), the ways in it taught, and what the stash had no
 * room for (sold on the spot).
 */
export interface Settlement {
  profile: Profile;
  home: Item[];
  opened: RouteId[];
  /** Ways in the raid walked to that the base did not offer before (only when the player got off alive). */
  learned: EntryId[];
  quests: Quest[];
  sold: Item[];
  soldFor: number;
  /** The island's day the raid was played on (the profile is on the next). */
  day: number;
  /** POIs the raid freed, freed ones that went thin overnight, and thin ones the network took back. */
  freed: PoiId[];
  /** Outposts the raid freed. */
  outposts: OutpostId[];
  /** POIs whose core the raid captured before it was wiped: left thin. */
  dropped: PoiId[];
  /** The nodes that turned the player's overnight, and those that stopped being so. */
  front: { gained: NodeId[]; lost: NodeId[] };
  /** Credits the nodes the player holds paid at this settle (`frontIncome()`). */
  income: number;
  thinned: PoiId[];
  retaken: PoiId[];
  /** Freed POIs the day's retake squad, left alive, turned thin. */
  overrun: PoiId[];
  /** The day's island event the raid was played on, or null. */
  event: IslandEvent | null;
  /** How the network moved overnight, and why. */
  network: NetChange;
  /** The contract taken for the raid, the credits it pays at the raid's threat, and whether the raid did it (its reward paid when it did). */
  contract: { c: Contract; cash: number; done: boolean } | null;
  /** The story contract whose record the raid brought home (its credits paid). */
  story: Story | null;
  /** The threat the raid was played at. */
  threat: number;
  /** The mod parts worn when the raid ended, which may be analysed (`analyse()`): none unless the player got off alive. */
  analysable: ModKind[];
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

/** A contract's credits `cash` as paid at threat `threat`: `THREAT.levels[].reward` times, to the credit. */
export const threatPay = (cash: number, threat: number) => (threat > 0 ? Math.round(cash * THREAT.levels[threat].reward) : cash);

/** Sets the threat of the next raid, kept within 0 and `THREAT.max`. */
export const setThreat = (p: Profile, threat: number): Profile => ({ ...p, threat: Math.max(0, Math.min(THREAT.max, Math.round(threat) || 0)) });

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
 * and the map explored are kept too. The ways in walked to are learned only when the player got
 * off alive: a wipe forgets them.
 */
export function settle(p: Profile, s: State): Settlement {
  const pl = s.player;
  // A record of a raid kept from before tools were carried has none, nor records from before the story.
  const tools = pl.tools ?? [];
  const carried = pl.records ?? [];
  const home: Item[] = [...s.sent.map((v): Item => ({ t: "valuable", kind: v })), ...(s.sentTools ?? []).map((k): Item => ({ t: "tool", kind: k }))];
  // The valuables that came home with where each came from (for a fetch contract), and the story records.
  const origins = haulOrigins(pl);
  const fetched: Fetched[] = sentOrigins(s);
  const records: RecordId[] = [...(s.sentRecords ?? [])];
  if (s.outcome === "extracted") {
    for (const w of pl.weapons) if (w && !w.loan) home.push({ t: "weapon", kind: w.kind, rarity: w.rarity });
    if (pl.armor > 0) home.push({ t: "armor", tier: pl.armor });
    for (const k of HEALS) for (let i = Math.max(0, pl.heals[k] - pl.lentHeals[k]); i > 0; i--) home.push({ t: "heal", kind: k });
    for (const v of pl.haul) home.push({ t: "valuable", kind: v });
    for (const poi of pl.keys) home.push({ t: "key", poi: POIS[poi].id });
    for (const k of tools) home.push({ t: "tool", kind: k });
    pl.haul.forEach((kind, n) => fetched.push({ kind, from: origins[n] }));
    records.push(...carried);
  } else {
    const kept = pouchKeep(pl.haul, tools, pouchSlots(p.hideout), carried);
    for (const v of kept.haul) home.push({ t: "valuable", kind: v });
    for (const k of kept.tools) home.push({ t: "tool", kind: k });
    for (const n of kept.at) fetched.push({ kind: pl.haul[n], from: origins[n] });
    records.push(...kept.records);
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
  // However the raid ended, it was a day on the island: what it freed decides a contract to free a POI.
  const day = raidDay(s);
  const { change } = advanceDay(p, day);
  const taken = takenContract(p);
  const contract = taken && { c: taken, cash: threatPay(taken.reward.cash, s.threat ?? 0), done: contractDone(taken, { freed: change.freed, home: fetched, wiped: s.stats.wiped ?? [], relays: day.relays }) };
  const story = currentStory(p.records);
  const told = story && records.includes(story.id) ? story : null;
  // What came home and what the quests and the contract pay claim stash room together, in one `keepOrder()`.
  const { log, finished } = creditRaid(p.quests, s);
  // A contract done at a higher threat pays its credits `THREAT.levels[].reward` times.
  const threat = s.threat ?? 0;
  const paid = contract?.done ? [{ ...contract.c.reward, cash: threatPay(contract.c.reward.cash, threat) }] : [];
  const rewards = [...finished.map((q) => q.reward), ...paid].flatMap((r) => r.items.map((i): Item => ({ ...i })));
  const cash = [...finished.map((q) => q.reward), ...paid].reduce((n, r) => n + r.cash, 0) + (told?.cash ?? 0);
  const { profile, sold, soldFor } = store({ ...p, cash: p.cash + cash, routes: openRoutes([...p.routes, ...opened]) }, [...home.filter((i) => !spent.has(i)), ...rewards]);
  const depots = DEPOTS.map((d) => d.poi).filter((id, i) => p.depots.includes(id) || s.depots[i]);
  const depotSent = Object.fromEntries(depots.map((id) => [id, (p.depotSent[id] ?? 0) + (s.sentVia[depotIndex(id)] ?? 0)]));
  // A record of a raid kept from before ways in were learned has walked to none.
  const learned = s.outcome === "extracted" ? knownEntries(s.found ?? []).filter((e) => !p.entries.includes(e)) : [];
  const entries = knownEntries([...p.entries, ...learned]);
  const kept = STORIES.map((t) => t.id).filter((id) => p.records.includes(id) || told?.id === id);
  const freedAt = { ...p.freedAt };
  for (const id of change.freed) freedAt[id] = Math.max(freedAt[id] ?? 0, threat);
  const settled = { ...profile, freedAt, entries, quests: log, raids: p.raids + 1, extracted: p.extracted + (s.outcome === "extracted" ? 1 : 0), time: p.time + s.time, seed: nextSeed(p.seed), depots, depotSent, seen: encodeSeen(s.seen), records: kept };
  const { profile: night } = advanceDay(settled, day);
  // The nodes the player holds once the night is over pay their day's credits.
  const income = frontIncome(night);
  const next = { ...night, cash: night.cash + income };
  // Quests the raid opened may ask for a hideout level already built.
  const claimed = claimBuilt(next);
  // The new day's board, for the next raid's seed; yesterday's contract goes with yesterday's board.
  const fresh = { ...claimed.profile, taken: null, board: makeBoard(claimed.profile) };
  return { profile: fresh, home, opened, learned, quests: [...finished, ...claimed.quests], sold: [...sold, ...claimed.sold], soldFor: soldFor + claimed.soldFor, day: p.day, ...change, income, event: s.event ?? null, contract, story: told, threat, analysable: s.outcome === "extracted" ? [...(pl.mods ?? [])] : [] };
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
 * world, is dropped. Before v11 every way in was open from the start: such a profile knows
 * them all. Before v12 the world was narrower east to west, so its explored map, drawn row by
 * row over the old bounds, is dropped. Before v13 the island had no days: such a profile is on
 * the day after its raids so far, with every POI held. Before v14 the trader had a chain of 21
 * quests, most of them now done by the board: such a profile keeps the quests there still are
 * (credited nothing for the others, its stash as it was), no record of the story, and a fresh board.
 * Before v15 the island had no network: such a profile starts at `NETWORK.start`, with nothing gathered.
 * Before v16 the island had no events: such a profile's day is quiet, and tomorrow's is drawn as it now stands.
 * Before v17 there were no mod parts and no threat: such a profile knows the starting kinds
 * (`MOD_START`), plays at threat 0, and has freed no POI at any threat.
 * Before v18 there was no front: such a profile's outposts stand as `territory()` gives them at
 * its network (the rogues' rogue, the others held), none freed.
 */
export function parseProfile(raw: unknown, seed = 1): Profile | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18].includes(o.v as number) || typeof o.cash !== "number" || !Array.isArray(o.stash)) return null;
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
  if (q.progress && typeof q.progress === "object") for (const [k, n] of Object.entries(q.progress)) if (typeof n === "number" && QUEST_IDS.has(k)) progress[k] = n;
  const h = (o.hideout ?? {}) as Record<string, unknown>;
  const hideout = emptyHideout();
  for (const m of MODULES) if (Number.isInteger(h[m])) hideout[m] = Math.max(0, Math.min(HIDEOUT[m].levels.length, h[m] as number));
  const e = o.escaped as Record<string, unknown> | null | undefined;
  const escaped = craftDone(hideout) ? { raids: Number(e?.raids) || 0, extracted: Number(e?.extracted) || 0, time: Number(e?.time) || 0 } : null;
  const num = (x: unknown) => (typeof x === "number" && x >= 0 ? x : 0);
  const depots = Array.isArray(o.depots) ? [...new Set(o.depots.filter((d): d is PoiId => typeof d === "string" && poiIndex(d as PoiId) >= 0))] : [];
  const ds = (typeof o.v === "number" && o.v >= 8 && o.depotSent && typeof o.depotSent === "object" ? o.depotSent : {}) as Record<string, unknown>;
  const depotSent = Object.fromEntries(depots.map((d) => [d, num(ds[d])]));
  const entries = typeof o.v === "number" && o.v < 11 ? ENTRIES.map((e) => e.id) : knownEntries(Array.isArray(o.entries) ? o.entries.filter((e): e is string => typeof e === "string") : []);
  const { region, entry } = allowedStart({ entries, depots } as Profile, REGIONS.find((r) => r.id === o.region)?.id ?? "reservoir", o.entry);
  const raids = num(o.raids);
  const day = (typeof o.v === "number" && o.v >= 13) && Number.isInteger(o.day) && (o.day as number) >= 1 ? (o.day as number) : raids + 1;
  const recordIds = STORIES.map((t) => t.id);
  const records = (typeof o.v === "number" && o.v >= 14) && Array.isArray(o.records) ? recordIds.filter((id) => (o.records as unknown[]).includes(id)) : [];
  const network = (typeof o.v === "number" && o.v >= 15) && Number.isInteger(o.network) ? Math.max(0, Math.min(NETWORK.max, o.network as number)) : NETWORK.start;
  const v17 = o.v === 17 || o.v === 18;
  const fa = (v17 && o.freedAt && typeof o.freedAt === "object" ? o.freedAt : {}) as Record<string, unknown>;
  const freedAt: Partial<Record<PoiId, number>> = {};
  for (const { id } of POIS) if (Number.isInteger(fa[id])) freedAt[id] = Math.max(0, Math.min(THREAT.max, fa[id] as number));
  const out: Omit<Profile, "board" | "taken" | "events"> = {
    v: 18,
    cash: Math.max(0, Math.floor(o.cash)),
    stash: o.stash.map(migrate).filter(ok).slice(0, stashCap(hideout)),
    raids,
    extracted: num(o.extracted),
    time: num(o.time),
    quests: { progress, done: Array.isArray(q.done) ? q.done.filter((d): d is string => typeof d === "string" && QUEST_IDS.has(d)) : [] },
    region,
    entry,
    entries,
    hideout,
    escaped,
    seed: Number.isInteger(o.seed) ? (o.seed as number) & 0xffff : seed & 0xffff,
    depots,
    depotSent,
    seen: (typeof o.v === "number" && o.v >= 12) && typeof o.seen === "string" && /^[0-9a-f]*$/.test(o.seen) ? o.seen : "",
    routes: typeof o.v === "number" && o.v >= 9 && Array.isArray(o.routes) ? openRoutes(o.routes.filter((r): r is string => typeof r === "string")) : [],
    day,
    poiState: typeof o.v === "number" && o.v >= 13 ? parseIsland(o.poiState, day) : newIsland(),
    outposts: parseOutposts(o.v === 18 ? o.outposts : undefined, network),
    records,
    network,
    known: knownMods(v17 && Array.isArray(o.known) ? o.known : []),
    threat: v17 && Number.isInteger(o.threat) ? Math.max(0, Math.min(THREAT.max, o.threat as number)) : 0,
    freedAt,
    pressure: (typeof o.v === "number" && o.v >= 15) && typeof o.pressure === "number" && o.pressure >= 0 && o.pressure < NETWORK.riseEvery ? o.pressure : 0,
  };
  const events: DayEvents = (o.v === 16 || o.v === 17 || o.v === 18) && Array.isArray(o.events) && o.events.length === 2 ? [validEvent(parseEvent(o.events[0]), out), validEvent(parseEvent(o.events[1]), out)] : [null, null];
  if (o.v !== 16 && o.v !== 17 && o.v !== 18) events[1] = eventFor(out.seed, day + 1, out.poiState, out.outposts);
  const withEvents = { ...out, events };
  // The day's board as saved, so it stands however the stash changed since; else the day's from now.
  // A board saved before the network may name a pack the migrated level does not fly: made anew.
  const board = (typeof o.v === "number" && o.v >= 15 ? parseBoard(o.board, day) : null) ?? makeBoard(withEvents);
  const taken = typeof o.taken === "string" && board.contracts.some((c) => c.id === o.taken) ? o.taken : null;
  return { ...withEvents, board, taken };
}

/** A saved event kept only while it can come: a retake needs its POI freed on the front's edge. */
const validEvent = (ev: IslandEvent | null, p: { poiState: Island; outposts: Record<OutpostId, OutpostHold> }): IslandEvent | null => (ev?.t === "retake" && !retakable(p.poiState, p.outposts).includes(ev.poi) ? null : ev);

/** Saved outposts; any unreadable stands as `territory()` gives it at `network`, a freed one stays freed. */
function parseOutposts(raw: unknown, network: number): Record<OutpostId, OutpostHold> {
  const out = newOutposts(network);
  if (!raw || typeof raw !== "object") return out;
  const o = raw as Record<string, unknown>;
  for (const { id } of OUTPOST_SITES) if (o[id] === "freed") out[id] = "freed";
  return out;
}

/**
 * The start the base offers first: `region` and `entry` when they may be chosen, else the
 * region's first known way in; a region with neither a known way in nor a depot on gives way
 * to the reservoir, where `FIRST_ENTRY` is always known.
 */
export function allowedStart(p: Pick<Profile, "entries" | "depots">, region: RegionId, entry: unknown): { region: RegionId; entry: EntryId } {
  const known = (r: RegionId) => regionOf(r).entries.filter((e) => p.entries.includes(e));
  const reg = canStartIn(p as Profile, region) ? region : "reservoir";
  const ways = known(reg);
  const want = ENTRIES.find((e) => e.id === entry && e.region === reg && ways.includes(e.id));
  // A region open only through a depot keeps a known way in elsewhere as the record of the last walk in.
  const kept = p.entries.find((e) => e === entry);
  return { region: reg, entry: want?.id ?? ways[0] ?? kept ?? FIRST_ENTRY };
}
