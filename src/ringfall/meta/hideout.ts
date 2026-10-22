import { HEALS, HIDEOUT, HIDEOUT_EFFECT, META, ROBOT_DROPS, TOP_BINS, VALUABLES, VAULT, type HealKind, type ModuleId, type ModuleLevel, type Rarity, type ValuableKind } from "../sim/config";
import { POIS, poiRegion, type PoiId } from "../sim/map";

/** Each module's built level (0 is unbuilt). */
export type Hideout = Record<ModuleId, number>;

/** The modules in the order the base lists them. */
export const MODULES = Object.keys(HIDEOUT) as ModuleId[];

export const emptyHideout = (): Hideout => Object.fromEntries(MODULES.map((m) => [m, 0])) as Hideout;

export const maxLevel = (m: ModuleId) => HIDEOUT[m].levels.length;

/** The level a module would build next, or null once it is complete. */
export const nextLevel = (h: Hideout, m: ModuleId): ModuleLevel | null => HIDEOUT[m].levels[h[m]] ?? null;

/** Every module is at its top level. */
export const hideoutDone = (h: Hideout) => MODULES.every((m) => h[m] >= maxLevel(m));

/** Valuables every level not yet built still asks for, by kind. */
export function stillNeeded(h: Hideout): Record<ValuableKind, number> {
  const out = Object.fromEntries(Object.keys(VALUABLES).map((k) => [k, 0])) as Record<ValuableKind, number>;
  for (const m of MODULES) for (const l of HIDEOUT[m].levels.slice(h[m])) for (const [k, n] of l.items) out[k] += n;
  return out;
}

export const stashCap = (h: Hideout) => META.stash + HIDEOUT_EFFECT.storage[h.storage];
export const pouchSlots = (h: Hideout) => META.pouch + HIDEOUT_EFFECT.pouch[h.pouch];
export const shopRarity = (h: Hideout) => Math.min(3, META.shopRarity + HIDEOUT_EFFECT.workbench[h.workbench]) as Rarity;
/** The valuables the trader sells: those no rarer than its gear. */
export const onSale = (h: Hideout) => (Object.keys(VALUABLES) as ValuableKind[]).filter((k) => VALUABLES[k].rarity <= shopRarity(h));

/** Heals the infirmary lends to every raid. */
export function infirmaryHeals(h: Hideout): Record<HealKind, number> {
  const add = HIDEOUT_EFFECT.infirmary[h.infirmary];
  return Object.fromEntries((Object.keys(HEALS) as HealKind[]).map((k) => [k, add[k] ?? 0])) as Record<HealKind, number>;
}

/**
 * Where a valuable is found: a POI's bins, the high-rises' top floors, the vaults (`share` is
 * its chance from one bin or vault), or a robot that drops it (`share` is the chance per kill).
 */
export interface Source {
  from: "bin" | "top" | "vault" | "robot";
  where: string;
  region: string;
  share: number;
}

/**
 * The places a valuable comes from, likeliest first, read from the loot data: the POIs'
 * bin tables, the top floors of the high-rises, the vaults and the robots that drop it.
 */
export function sources(kind: ValuableKind): Source[] {
  const share = (list: [ValuableKind, number][]) => (list.find(([k]) => k === kind)?.[1] ?? 0) / list.reduce((n, [, w]) => n + w, 0);
  const out: Source[] = [];
  for (const p of POIS) {
    const s = share(p.loot.valuable);
    if (s > 0) out.push({ from: "bin", where: p.name, region: poiRegion(p.id).name, share: s });
  }
  if (share(TOP_BINS) > 0) out.push({ from: "top", where: "高い建物の最上階", region: "", share: share(TOP_BINS) });
  const vault = VAULT.valuables.filter((set) => set.includes(kind)).length / VAULT.valuables.length;
  if (vault > 0) out.push({ from: "vault", where: "保管庫", region: "", share: vault });
  if (ROBOT_DROPS.titan.includes(kind)) out.push({ from: "robot", where: "タイタン", region: poiRegion("pad").name, share: 1 });
  if (ROBOT_DROPS.heavy.includes(kind)) out.push({ from: "robot", where: "ヘビー", region: "", share: 1 });
  const scrap = ROBOT_DROPS.scrap.find(([k]) => k === kind);
  if (scrap) out.push({ from: "robot", where: "ロボット", region: "", share: scrap[1] });
  return out.sort((a, b) => b.share - a.share);
}

/** POIs whose bins may hold a kind (for checks: every kind a level needs must come from somewhere). */
export const poisWith = (kind: ValuableKind): PoiId[] => POIS.filter((p) => p.loot.valuable.some(([k]) => k === kind)).map((p) => p.id);
