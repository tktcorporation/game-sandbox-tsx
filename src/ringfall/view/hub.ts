import { PLAYER } from "../sim/config";
import { armorIcon, binPicture, checkIcon, coreIcon, factoryIcon, flagIcon, hideoutIcon, clockIcon, crossIcon, depotIcon, gunIcon, healIcon, issueIcon, keyIcon, lockIcon, modIcon, pinIcon, pouchIcon, radioIcon, robotIcon, routeIcon, SIDE, stashIcon, turretIcon, upIcon, workbenchIcon } from "./icons";
import { ALLY, FACTORY, FACTORY_TOP, HEALS as HEAL_SPECS, HIDEOUT, MOD_KINDS, PLATE, RARITY, THREAT, TOOLS, VALUABLES, WEAPONS, type EnemyKind, type ModuleId, type Rarity, type ValuableKind, type WeaponKind } from "../sim/config";
import { boostFor, raidClock, strengthFor, type Kit } from "../sim/state";
import { CAMP, DEPOTS, ENTRIES, entryOf, HOME_REGION, NODES, POIS, UNLOCKS, poiIndex, poiRegion, REGIONS, regionOf, ROUTES, type EntryId, type PoiId, type RegionId, type StationId } from "../sim/map";
import { armed, build, buildFactory, buildState, buy, buyPrice, canBuild, canBuildFactory, factoryNeeded, nextFactory, canStartIn, deliver, deliverable, depotAllowance, emptyLoadout, FIRST_ENTRY, fitsStart, isStarter, issuedHeals, itemCost, HEALS, healCount, healRoom, keyName, kitPicks, loadoutCost, stashUsed, price, raidThreat, recallLoadout, sell, sellPrice, setThreat, startsIn, STORY_TAKEN, takenStory, threatPay, take, takeKit, takenContract, wanted, wares, type Item, type Loadout, type Profile } from "../meta/profile";
import { CONTRACT_NAME, contractMark, contractRegion, contractText, type Contract, type Reward } from "../meta/contracts";
import { currentStory, STORIES, storyOf, storyWhere } from "../meta/story";
import { materialRarity, maxLevel, MODULES, nextLevel, pouchSlots, sources, stashCap, stillNeeded, type Hideout, type Source } from "../meta/hideout";
import { need, offered, type Quest, type RewardItem } from "../meta/quests";
import { saveProfile } from "../meta/storage";
import { departDepots, eventName, frontIncome, islandHolds, playerNodes, shopRarity, unfreeable, unlocked } from "../meta/island";
import { eventRow } from "./events";
import { HOLD_CSS, IslandMap, islandScene, TITAN_CSS } from "./map";
import { enemyNodes, frontNodes } from "../sim/front";
import { nodeRow } from "./row";
import { sfx } from "./sfx";

const RARITY_CSS = ["var(--r0)", "var(--r1)", "var(--r2)", "var(--r3)"];

/** The robots' kinds by name, for the factory. */
const ENEMY_NAME: Record<EnemyKind, string> = { grunt: "グラント", heavy: "ヘビー", drone: "ドローン", charger: "チャージャー", titan: "タイタン" };

export function itemName(i: Item | RewardItem): string {
  switch (i.t) {
    case "weapon":
      return `${WEAPONS[i.kind].name} ${RARITY.names[i.rarity]}`;
    case "armor":
      return `アーマー Lv${i.tier}`;
    case "heal":
      return HEAL_SPECS[i.kind].label;
    case "valuable":
      return VALUABLES[i.kind].label;
    case "key":
      return keyName(i.poi);
    case "tool":
      return TOOLS[i.kind].label;
  }
}

/** A weapon's numbers at a rarity, from its spec: damage a hit (pellets a shot), shots a minute, the magazine. */
export function weaponStats(kind: WeaponKind, rarity: Rarity): string {
  const w = WEAPONS[kind];
  const dmg = Math.round(w.dmg * RARITY.dmg[rarity]);
  return `威力 ${dmg}${w.pellets > 1 ? `×${w.pellets}` : ""}・毎分 ${Math.round(60 / w.interval)} 発・弾倉 ${Math.round(w.mag * RARITY.mag[rarity])}`;
}

/** What the hideout's unbuilt levels and the factory's still ask for, by kind. */
interface Needs {
  hideout: Record<ValuableKind, number>;
  factory: Record<ValuableKind, number>;
}

/**
 * An item's line under its name, in names and numbers: a weapon's class and numbers, armour's
 * shield, a heal's mark (blue shield, green health) and amount, and for a valuable the hideout's and
 * the factory's count of it still to use (`need`). Keys and tools have none: the name says it.
 */
function itemNote(i: Item, need?: Needs): string {
  switch (i.t) {
    case "weapon":
      return `${WEAPONS[i.kind].label}・${weaponStats(i.kind, i.rarity)}`;
    case "valuable": {
      const h = need?.hideout[i.kind] ?? 0;
      const f = need?.factory[i.kind] ?? 0;
      return [h ? `${hideoutIcon()}隠れ家 ${h}` : "", f ? `${factoryIcon()}工場 ${f}` : ""].filter(Boolean).join("・");
    }
    case "armor":
      return `シールド ${PLAYER.shieldByTier[i.tier]}`;
    case "key":
    case "tool":
      return "";
    case "heal": {
      const h = HEAL_SPECS[i.kind];
      return `${healIcon(h.shield)}${h.amount ? `+${h.amount}` : "MAX"}`;
    }
  }
}

/**
 * The trader's shelf by rarity: four swatches in the rarities' colours, lit up to the best the
 * nodes held open, each with the nodes that open it (blue held, red the enemy's).
 */
function shelfTiers(p: Profile): string {
  const best = shopRarity(p);
  const mine = playerNodes(p);
  const cells = ([0, 1, 2, 3] as Rarity[]).map((r) => {
    const by = NODES.filter((n) => UNLOCKS[n.id].shop === r).map((n) => `<em style="color:${mine.includes(n.id) ? HOLD_CSS.freed : HOLD_CSS.held}">${esc(n.name)}</em>`);
    return `<div class="tier${r <= best ? " on" : ""}" style="--c:${RARITY_CSS[r]}"><i></i><span>${by.join("")}</span></div>`;
  });
  // The materials beside them, under the workbench's wrench: the rarities it lets the trader sell.
  const mats = materialRarity(p.hideout);
  const row = ([0, 1, 2, 3] as Rarity[]).map((r) => `<div class="${r <= mats ? "on" : ""}" style="--c:${RARITY_CSS[r]}">${workbenchIcon(r <= mats ? RARITY_CSS[r] : undefined)}<i></i></div>`);
  return `<div class="shelf-tiers">${cells.join("")}</div><div class="shelf-mats">${row.join("")}</div>`;
}

const color = (i: Item | RewardItem) =>
  i.t === "weapon" ? RARITY_CSS[i.rarity] : i.t === "armor" ? RARITY_CSS[i.tier] : i.t === "valuable" ? RARITY_CSS[VALUABLES[i.kind].rarity] : i.t === "key" || i.t === "tool" ? RARITY_CSS[3] : "var(--white)";

/** Weapons, armour and keys are listed one by one; heals and valuables are counted. */
function rows(stash: Item[]): { item: Item; index: number[] }[] {
  const out: { item: Item; index: number[] }[] = [];
  stash.forEach((item, n) => {
    if (item.t === "heal" || item.t === "valuable" || item.t === "tool") {
      const row = out.find((r) => r.item.t === item.t && (r.item as { kind: string }).kind === item.kind);
      if (row) return void row.index.push(n);
    }
    out.push({ item, index: [n] });
  });
  const order = { weapon: 0, armor: 1, key: 2, tool: 3, heal: 4, valuable: 5 };
  // The starter weapons head the weapons.
  return out.sort((a, b) => order[a.item.t] - order[b.item.t] || Number(isStarter(b.item)) - Number(isStarter(a.item)));
}

/** A quest's or a contract's reward items, alike ones counted together. */
export function rewardList(q: { reward: Reward }): [RewardItem, number][] {
  const out: [RewardItem, number][] = [];
  for (const i of q.reward.items) {
    const same = out.find(([o]) => itemName(o) === itemName(i));
    if (same) same[1]++;
    else out.push([i, 1]);
  }
  return out;
}

/**
 * Each hideout module's mark. The same mark stands where the module's effect shows elsewhere (the
 * shelves' issued heals, the stash's count, the trader's materials, the map table's report, the
 * pouch's slots), so the card says where an upgrade grows.
 */
const MODULE_ICON: Record<ModuleId, () => string> = { infirmary: () => issueIcon(), workbench: () => workbenchIcon(), storage: () => stashIcon(), radio: () => radioIcon(), pouch: () => pouchIcon() };

/**
 * One number an upgrade's level sets, as its mark (and a short name where several share a mark) and
 * its value drawn by `show`, which picks out what grew since `was` (the level before).
 */
interface Gauge {
  key: string;
  mark: string;
  label?: string;
  n: number;
  show: (n: number, was?: number) => string;
  /** Left out where it is 0 and was 0 (a robot kind or a heal not given yet). */
  hideZero?: boolean;
}

const num = (n: number, was?: number) => `<b class="n${was !== undefined && n !== was ? " gain" : ""}">${n}</b>`;
/** Slots as boxes in the pouch's colour, the ones added since `was` lit. */
const slotBoxes = (n: number, was = n) => `<span class="boxes">${Array.from({ length: n }, (_, i) => `<i class="seg pouch${i >= was ? " gain" : ""}" style="--n:1"></i>`).join("")}</span>`;
/** The four rarities as swatches, lit up to `r`, those lit since `was` glowing. */
const rarityBar = (r: number, was = r) => `<span class="rbar">${[0, 1, 2, 3].map((k) => `<i class="${k <= r ? "on" : ""}${k <= r && k > was ? " gain" : ""}" style="--c:${RARITY_CSS[k]}"></i>`).join("")}</span>`;

/** A gauge's value and what grew since `was`. */
const gaugeHtml = (g: Gauge, was?: Gauge) =>
  g.hideZero && !g.n && !was?.n
    ? ""
    : `<span class="gauge${was && was.n !== g.n ? " up" : ""}">${g.mark}${g.label ? `<small>${esc(g.label)}</small>` : ""}${g.show(g.n, was?.n)}</span>`;

/** The gauges that change from `a` to `b`, each as was → now with the gain lit; null where nothing changes. */
function deltaHtml(a: Gauge[], b: Gauge[]): string {
  return b
    .map((g) => {
      const was = a.find((x) => x.key === g.key);
      if (was && was.n === g.n) return "";
      return `<span class="delta">${g.mark}${g.label ? `<small>${esc(g.label)}</small>` : ""}<span class="was">${was ? was.show(was.n) : num(0)}</span><i class="to"></i><span class="now">${g.show(g.n, was?.n ?? 0)}</span></span>`;
    })
    .join("");
}

/**
 * The ladder of an upgrade's levels: each level's gauges with what that level added lit, the levels
 * built ticked and dimmed, the current one marked, the next one lit.
 */
function ladder(levels: Gauge[][], lv: number): string {
  return `<ol class="ladder">${levels
    .map((g, n) => {
      const cls = n < lv ? "done" : n === lv ? "cur" : n === lv + 1 ? "next" : "later";
      const mark = n <= lv ? checkIcon() : n === lv + 1 ? upIcon() : "";
      return `<li class="${cls}"><b>Lv${n}</b><span>${g.map((x, i) => gaugeHtml(x, n ? levels[n - 1][i] : undefined)).join("")}</span><i>${mark}</i></li>`;
    })
    .join("")}</ol>`;
}

const $ = (id: string) => document.getElementById(id)!;

/** Which day's papers the board holds. */
const boardKey = (p: Profile) => `${p.board.day}:${p.board.contracts.map((c) => c.id).join(",")}`;

/** An item as its mark in its colour: a gun, armour or a key. */
/** A starter weapon's mark before its name: a pin, since it stays in the stash. "" for anything else. */
const starterMark = (i: Item | undefined) => (isStarter(i) ? `<i class="starter">${pinIcon()}</i>` : "");
const itemMark = (i: Item) => `<span style="color:${color(i)}">${i.t === "weapon" ? gunIcon() : i.t === "armor" ? armorIcon() : keyIcon()}</span>`;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const yen = (n: number) => n.toLocaleString("ja-JP");

/** The panel each camp station opens: the panel's title and whether the stash's column stands beside its own. */
const PANELS: Record<StationId, { title: string; stash: boolean }> = {
  map: { title: "地図の机", stash: false },
  quests: { title: "依頼板", stash: false },
  stash: { title: "倉庫の棚", stash: true },
  shop: { title: "商人の屋台", stash: true },
  workshop: { title: "作業場", stash: false },
  factory: { title: "工場", stash: false },
};

/**
 * A place the departure's map offers: a way in or a depot switched on. `open`: it may be chosen
 * (a way in known, a depot a node held opens a start from); `on`: it is chosen. A depot has its
 * level, allowance (`budget`) and what the loadout costs of it; `over` when that is past it.
 */
export interface StartPoint {
  kind: "entry" | "depot";
  id: string;
  name: string;
  x: number;
  z: number;
  region: RegionId;
  open: boolean;
  on: boolean;
  over: boolean;
  budget?: number;
  cost?: number;
  level?: number;
}

/** A raid the camp hands over to start: the kit taken, where, and from which start. */
export interface Launch {
  kit: Kit;
  region: RegionId;
  seed: number;
  from?: PoiId;
  entry: EntryId;
}

/**
 * Where a valuable is found, as a line: the POIs whose bins hold it most often (with the
 * chance per bin), then the likeliest other place.
 */
export function whereLine(kind: ValuableKind): string {
  const all = sources(kind);
  const bins = all.filter((s) => s.from === "bin").slice(0, 3);
  const other = all.find((s) => s.from !== "bin");
  const say = (s: Source) => `${s.where}${s.region ? `（${s.region}）` : ""} ${Math.round(Math.min(1, s.share) * 100)}%`;
  return [...bins, ...(other ? [other] : [])].map(say).join("・");
}

/**
 * The camp's station panels between raids: the stash and the loadout for the next raid (the
 * shelves), where the truck drives to (a way in of a region, or a depot already on; the map
 * table), the trader, their quests (the board) and the hideout (the workshop). One panel is open
 * at a time. It changes only the profile; a raid starts from the kit, the region and the way in or
 * depot `launch()` hands over.
 */
export class Hub {
  /** The station whose panel is open, or null with none open. */
  station: StationId | null = null;
  /** The loadout for the next raid: the last one picked again while the stash holds it (`recallLoadout()`), always with a weapon (`armed()`). */
  private load: Loadout = emptyLoadout();
  private region: RegionId;
  /** The way in of `region` the truck drives to, when not to a depot; null when the region is open only through a depot. */
  private entry: EntryId | null;
  /** A depot the truck drives to instead of a way in; null for a way in. */
  private from: PoiId | null = null;
  /** The hideout module opened to show what its next level takes. */
  private module: ModuleId | null = null;
  /** A stash row a module still needs, pressed once to sell: the next press sells it. */
  private armed = "";
  /** The contract board last put up on the board panel; a new day's board slides its papers in once. */
  private boardSeen: string;

  constructor(
    public profile: Profile,
    private closed: () => void,
  ) {
    this.region = profile.region;
    this.entry = this.entryIn(profile.region);
    this.load = recallLoadout(profile);
    this.boardSeen = boardKey(profile);
    this.fixStart();
    $("hub").addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
      if (el && !(el as HTMLButtonElement).disabled) this.act(el.dataset.act!, el.dataset.arg ?? "");
    });
  }

  open(station: StationId) {
    this.station = station;
    this.load = this.fit(this.load);
    $("hub").hidden = false;
    $("hub-side").scrollTop = 0;
    $("hub-stash").scrollTop = 0;
    sfx.tab();
    this.render();
  }

  /** `tell`: let the camp know, so it takes the controls back. */
  close(tell = true) {
    if (this.station === null) return;
    this.station = null;
    this.module = null;
    this.armed = "";
    $("hub").hidden = true;
    if (tell) this.closed();
  }

  private set(p: Profile) {
    this.profile = p;
    saveProfile(p);
    this.load = this.fit(this.load);
  }

  /** Takes a profile settled after a raid: the last loadout picked again from the stash, the start kept where the profile allows it. */
  reload(p: Profile) {
    this.profile = p;
    this.load = recallLoadout(p);
    this.fixStart();
  }

  /** The next raid's weapons, by name, each marked when it is a starter weapon. */
  pickedWeapons(): { name: string; starter: boolean }[] {
    const p = this.profile;
    return this.startLoad().weapons.map((n) => ({ name: itemName(p.stash[n]), starter: isStarter(p.stash[n]) }));
  }

  /** Sets a profile whose stash changed under the loadout, keeping the loadout's picks by what they are. */
  private keepPicks(next: Profile) {
    const picks = kitPicks(this.profile, this.load);
    this.set(next);
    this.load = recallLoadout({ ...next, lastKit: picks });
  }

  /** Drops loadout picks the stash no longer has at those indices; with no weapon left, the starter weapons are picked. */
  private fit(l: Loadout): Loadout {
    const st = this.profile.stash;
    const heals = { ...l.heals };
    const weapons = armed(this.profile, { ...l, weapons: l.weapons.filter((n) => st[n]?.t === "weapon") }).weapons;
    for (const k of HEALS) heals[k] = Math.min(heals[k], healRoom(this.profile, { ...l, weapons }, k));
    return {
      weapons,
      armor: l.armor !== null && st[l.armor]?.t === "armor" ? l.armor : null,
      heals,
      keys: l.keys.filter((n) => st[n]?.t === "key"),
    };
  }

  /** Stash indices after the entries in `gone` are removed. */
  private reindex(gone: number[]) {
    const map = (n: number) => (gone.includes(n) ? -1 : n - gone.filter((g) => g < n).length);
    const keep = (ns: number[]) => ns.map(map).filter((n) => n >= 0);
    const armor = this.load.armor === null ? -1 : map(this.load.armor);
    this.load = { weapons: keep(this.load.weapons), armor: armor < 0 ? null : armor, heals: this.load.heals, keys: keep(this.load.keys) };
  }

  private act(act: string, arg: string) {
    const pick = arg.split(",").map(Number);
    if (act !== "sell") this.armed = "";
    if (act === "close") {
      sfx.click();
      return this.close();
    } else if (act === "mod") {
      this.module = this.module === arg ? null : (arg as ModuleId);
      sfx.click();
    } else if (act === "build") {
      const m = arg as ModuleId;
      const next = build(this.profile, m);
      if (next) {
        if (!nextLevel(next.hideout, m)) this.module = null;
        // Building takes stash entries: the loadout's picks are found again by what they are.
        this.keepPicks(next);
        sfx.deliver();
      }
    } else if (act === "factory") {
      const next = buildFactory(this.profile);
      if (next) {
        this.keepPicks(next);
        sfx.deliver();
      }
    } else if (act === "strength") {
      // A 強度 is chosen for one contract: choosing it takes that contract.
      const [id, n] = arg.split(":");
      const taken = takenContract(this.profile)?.id === id ? this.profile : take(this.profile, id);
      this.set(setThreat(taken, Number(n)));
      sfx.click();
    } else if (act === "pick") {
      sfx.click();
      const n = pick[0];
      const it = this.profile.stash[n];
      const toggle = (ns: number[]) => (ns.includes(n) ? ns.filter((x) => x !== n) : [...ns, n]);
      if (it?.t === "weapon") {
        const w = this.load.weapons;
        this.load.weapons = w.includes(n) ? w.filter((x) => x !== n) : w.length < 2 ? [...w, n] : [w[1], n];
      } else if (it?.t === "armor") this.load.armor = this.load.armor === n ? null : n;
      else if (it?.t === "key") this.load.keys = toggle(this.load.keys);
      this.load = this.fit(this.load);
    } else if (act === "heal+" || act === "heal-") {
      sfx.click();
      const k = arg as keyof Loadout["heals"];
      this.load.heals[k] = Math.max(0, Math.min(healRoom(this.profile, this.load, k), this.load.heals[k] + (act === "heal+" ? 1 : -1)));
    } else if (act === "sell") {
      // Sell the last of a group, so the loadout's picks before it keep their indices.
      const n = pick[pick.length - 1];
      const it = this.profile.stash[n];
      if (isStarter(it)) return this.render();
      // A valuable the hideout or the factory still needs is sold only on a second press.
      if (it?.t === "valuable" && wanted(this.profile)[it.kind] >= 0 && this.armed !== arg) {
        this.armed = arg;
        sfx.click();
      } else {
        this.armed = "";
        this.reindex([n]);
        this.set(sell(this.profile, n));
        sfx.sell();
      }
    } else if (act === "buy") {
      const next = buy(this.profile, wares(this.profile)[pick[0]]);
      if (next) {
        this.set(next);
        sfx.buy();
      }
    } else if (act === "take") {
      this.set(take(this.profile, arg || null));
      sfx.click();
    } else if (act === "deliver") {
      const q = offered(this.profile.quests).find((o) => o.id === arg);
      const take = q && deliverable(this.profile, q);
      if (take) {
        this.reindex(take);
        this.set(deliver(this.profile, arg));
        sfx.deliver();
      }
    }
    this.render();
  }

  /** The way in offered first in `region`: the one the profile remembers when it is that region's, else its first known; null when none is known. */
  private entryIn(region: RegionId): EntryId | null {
    const ways = startsIn(this.profile, region).entries;
    return ways.includes(this.profile.entry) ? this.profile.entry : (ways[0] ?? null);
  }

  /**
   * Keeps the chosen start one the profile allows: a depot still on, a region with a known way in
   * or a depot on (else the reservoir, whose first way in is always known), a known way in of it,
   * and a depot when the region has no known way in.
   */
  private fixStart() {
    const p = this.profile;
    if (this.from && !departDepots(p).includes(this.from)) this.from = null;
    if (!canStartIn(p, this.region)) {
      this.region = HOME_REGION.id;
      this.from = null;
    }
    if (!this.entry || !startsIn(p, this.region).entries.includes(this.entry)) this.entry = this.entryIn(this.region);
    if (!this.entry && !this.from) this.from = startsIn(p, this.region).depots[0] ?? null;
  }

  /** The loadout the next raid takes: with no weapon picked, the starter weapons (`armed()`). */
  private startLoad(): Loadout {
    return armed(this.profile, this.load);
  }

  /** The truck's depot's allowance and what the loadout costs of it, or null when it drives to a way in. */
  private allowance() {
    if (!this.from) return null;
    const a = depotAllowance(this.profile, this.from);
    return { ...a, cost: loadoutCost(this.profile, this.startLoad()) };
  }

  /** Where the raid starts, as a name. */
  rideTo(): string {
    this.fixStart();
    return this.from ? `${POIS[poiIndex(this.from)].name}の中継ボックス` : entryOf(this.entry ?? this.profile.entry).name;
  }

  /** Why the chosen start cannot be departed from now (the loadout over the depot's allowance), or "" when it can. */
  rideRefused(): string {
    this.fixStart();
    const a = this.allowance();
    return a && !fitsStart(this.profile, this.startLoad(), this.from) ? `持ち込み枠 ${a.cost} / ${a.budget}` : "";
  }

  /** Whether the chosen start is the gate's own way in: walking out of the gate then starts the raid where the player stands. */
  walksOut(): boolean {
    this.fixStart();
    return !this.from && this.region === HOME_REGION.id && (this.entry ?? FIRST_ENTRY) === FIRST_ENTRY;
  }

  /**
   * Every place a raid may start, for the departure's map: each way in (`open` once known, in a
   * region a raid may start in) and each depot switched on (`open` while a node held opens a start
   * from it), with the chosen one `on`. A depot carries its allowance and what the loadout costs of
   * it (`over` past it, when it cannot be departed from).
   */
  startPoints(): StartPoint[] {
    this.fixStart();
    const p = this.profile;
    const may = departDepots(p);
    const cost = loadoutCost(p, this.startLoad());
    const ways: StartPoint[] = ENTRIES.map((e) => ({ kind: "entry", id: e.id, name: e.name, x: e.x, z: e.z, region: e.region, open: p.entries.includes(e.id) && canStartIn(p, e.region), on: !this.from && this.region === e.region && this.entry === e.id, over: false }));
    const depots: StartPoint[] = DEPOTS.filter((d) => p.depots.includes(d.poi)).map((d) => {
      const open = may.includes(d.poi);
      const a = depotAllowance(p, d.poi);
      return { kind: "depot", id: d.poi, name: POIS[poiIndex(d.poi)].name, x: d.x, z: d.z, region: poiRegion(d.poi).id, open, on: this.from === d.poi, over: open && !fitsStart(p, this.startLoad(), d.poi), budget: a.budget, cost, level: a.level };
    });
    return [...ways, ...depots];
  }

  /** The regions no raid may start in yet (no way in known, no depot open there), for the departure map's padlocks. */
  lockedRegions(): RegionId[] {
    return REGIONS.filter((r) => !canStartIn(this.profile, r.id)).map((r) => r.id);
  }

  /** Chooses where the next raid starts: a way in known, or a depot that opens a start. False when it may not start there. */
  choose(kind: StartPoint["kind"], id: string): boolean {
    const p = this.profile;
    if (kind === "depot") {
      if (!departDepots(p).includes(id as PoiId)) return false;
      this.from = id as PoiId;
      this.region = poiRegion(this.from).id;
      // The entry follows the depot's region, so a later start from a way in is one of its own.
      this.entry = this.entryIn(this.region);
      return true;
    }
    const e = ENTRIES.find((w) => w.id === id);
    if (!e || !p.entries.includes(e.id) || !canStartIn(p, e.region)) return false;
    this.region = e.region;
    this.entry = e.id;
    this.from = null;
    return true;
  }

  /**
   * Takes the loadout out of the stash for a raid from the start chosen on the departure's map.
   * Null when the loadout does not fit a depot's allowance (`rideRefused()`).
   */
  launch(): Launch | null {
    this.fixStart();
    const from = this.from;
    const entry = this.entry ?? this.profile.entry;
    const taken = takeKit(this.profile, this.startLoad(), from);
    if (!taken) return null;
    const { profile, kit } = taken;
    // The start is remembered for the next departure, which opens on it.
    this.set({ ...profile, region: this.region, entry });
    this.load = emptyLoadout();
    return { kit, region: this.region, seed: this.profile.seed, from: from ?? undefined, entry };
  }

  /** The contract taken for the next raid, or null. */
  contract(): Contract | null {
    return takenContract(this.profile);
  }

  /** What each station has to act on, as its mark's text ("" for none): quests to hand in, modules to build, the radio's report. */
  marks(): Record<StationId, string> {
    const p = this.profile;
    const ready = offered(p.quests).filter((q) => deliverable(p, q)).length;
    const buildable = MODULES.filter((m) => canBuild(p, m)).length;
    // Tomorrow's event is announced here a day ahead.
    const coming = p.events[1];
    const map = [coming ? `明日 ${eventName(coming)}` : "", p.hideout.radio ? "無線" : ""].filter(Boolean).join("・");
    // The board wants looking at while it has contracts and none is taken.
    const open = !takenContract(p) && !takenStory(p) && p.board.contracts.length ? `依頼 ${p.board.contracts.length}` : "";
    return { map, quests: [ready ? `納品 ${ready}` : "", open].filter(Boolean).join("・"), stash: "", shop: "", workshop: buildable ? `▲ ${buildable}` : "", factory: canBuildFactory(p) ? `▲ Lv${p.factory + 1}` : "" };
  }

  private item(item: Item, body: { act?: string; arg?: string; on?: boolean; right?: string; count?: number; need?: Needs; warn?: boolean }) {
    const n = body.count && body.count > 1 ? ` <i>× ${body.count}</i>` : "";
    const needed = !!body.need && item.t === "valuable" && body.need.hideout[item.kind] + body.need.factory[item.kind] > 0;
    // A valuable still needed, pressed once to sell, turns red: the second press sells it.
    const text = itemNote(item, body.need);
    const note = text ? `<small class="${body.warn ? "warn" : needed ? "need" : ""}">${text}</small>` : "";
    const inner = `<span style="color:${color(item)}">${starterMark(item)}${esc(itemName(item))}${n}</span>${note}${body.right ?? ""}`;
    return body.act ? `<button type="button" class="item${body.on ? " on" : ""}${body.warn ? " armed" : ""}" data-act="${body.act}" data-arg="${body.arg}">${inner}</button>` : `<div class="item">${inner}</div>`;
  }

  /** The radio's report on the next raid into the chosen region, or null without a radio. */
  private intel(): string | null {
    const lv = this.profile.hideout.radio;
    if (!lv) return null;
    const b = boostFor(this.profile.seed, this.region);
    const where = esc(POIS[b.poi].name);
    if (lv === 1) return `${where} <b style="color:${RARITY_CSS[3]}">★</b>`;
    const kind = VALUABLES[b.kind];
    return `${where} <b style="color:${RARITY_CSS[kind.rarity]}">${esc(kind.label)}</b>　レイダー ${clockIcon()}${Math.round(raidClock(strengthFor(enemyNodes(islandHolds(this.profile))), raidThreat(this.profile)).raiders / 60)} 分`;
  }

  /**
   * The factory's gauges at level `lv`: the squad it makes (a blue robot a member, by kind), the
   * seconds between squads (fewer is better), the squads out at once (the map's flag; the nodes held
   * add theirs, `unlocked().squad`), and the turrets at each node held.
   */
  private factoryGauges(lv: number): Gauge[] {
    const kinds = [...new Set(FACTORY.levels.flatMap((l) => l.kinds))];
    const squad = (k: EnemyKind) => (lv2: number) => FACTORY.levels[lv2].kinds.filter((x) => x === k).length;
    const extra = unlocked(this.profile).squad;
    return [
      ...kinds.map((k) => ({
        key: k,
        mark: "",
        label: ENEMY_NAME[k],
        hideZero: true,
        n: squad(k)(lv),
        show: (n: number, was = n) => `<span class="bots">${Array.from({ length: n }, (_, i) => `<i class="${i >= was ? "gain" : ""}">${robotIcon(SIDE.own)}</i>`).join("") || `<b class="n none">0</b>`}</span>`,
      })),
      { key: "every", mark: clockIcon(), n: FACTORY.levels[lv].every, show: (n: number, was?: number) => `${num(n, was)}<small>秒</small>` },
      { key: "max", mark: flagIcon(), n: FACTORY.levels[lv].max + extra, show: num },
      { key: "turrets", mark: turretIcon(SIDE.own), n: FACTORY.levels[lv].turrets, show: num, hideZero: true },
    ];
  }

  /** What a level takes from the stash: each valuable (have / need, and where it is found) and the credits, set apart from its effect. */
  private cost(items: [ValuableKind, number][], cash: number, button: string): string {
    const p = this.profile;
    const have = (k: ValuableKind) => p.stash.filter((i) => i.t === "valuable" && i.kind === k).length;
    const rows = items
      .map(([k, n]) => `<div class="req${have(k) >= n ? " ok" : ""}"><span style="color:${RARITY_CSS[VALUABLES[k].rarity]}">${esc(VALUABLES[k].label)}</span><b>${Math.min(have(k), n)} / ${n}</b><small>${esc(whereLine(k))}</small></div>`)
      .join("");
    const credits = `<div class="req${p.cash >= cash ? " ok" : ""}"><span>クレジット</span><b>${yen(Math.min(p.cash, cash))} / ${yen(cash)}</b></div>`;
    return `<div class="mod-cost"><small>必要</small>${rows}${credits}${button}</div>`;
  }

  /**
   * The factory's panel: its level with what it makes now, the next level's gain (was → now, lit),
   * the ladder of its levels, then what the next one takes and the button that builds it. The nodes
   * held add squads (their flag) and arm its robots as the trader's shelf (the gun's colour).
   */
  private factoryPanel(): string {
    const p = this.profile;
    const lv = p.factory;
    const next = nextFactory(p);
    const levels = FACTORY.levels.map((_, n) => this.factoryGauges(n));
    const pips = Array.from({ length: FACTORY_TOP }, (_, n) => `<i class="${n < lv ? "on" : ""}"></i>`).join("");
    const u = unlocked(p);
    const arms = Math.max(PLATE.robots, u.shop);
    // What the nodes held add: a node's core in the player's blue, then their squads' flags and the gun's colour (the trader's shelf).
    const nodes = `<div class="from-nodes">${coreIcon(SIDE.own)}${u.squad ? `<span>${flagIcon()}<b>+${u.squad}</b></span>` : ""}<span style="color:${RARITY_CSS[arms]}">${gunIcon()}<small>${RARITY.names[arms]}</small></span></div>`;
    const gain = next ? `<div class="gain-row">${upIcon()}<b>Lv${lv + 1}</b>${deltaHtml(levels[lv], levels[lv + 1])}</div>` : `<div class="gain-row max">MAX</div>`;
    const cost = next ? this.cost(next.items, next.cash, `<button type="button" data-act="factory" ${canBuildFactory(p) ? "" : "disabled"}>Lv${lv + 1}</button>`) : "";
    return (
      `<div class="mod open up-card factory-card"><div class="mod-head"><strong>${factoryIcon()}工場</strong><span class="pips">${pips}</span><b>Lv${lv}${next ? "" : " MAX"}</b>${gain}</div>` +
      `<div class="mod-body">${nodes}${ladder(levels, lv)}${cost}</div></div>`
    );
  }

  /** The routes a tool opens: open or closed, and for a closed one, the tool and where it lies. */
  private routes(): string {
    const p = this.profile;
    // Each route as the map draws it (solid teal open, dashed orange shut); a shut one with the tool that opens it and the POI whose bins hold it.
    const rows = ROUTES.map((r) => {
      const open = p.routes.includes(r.id);
      const tool = TOOLS[r.tool];
      const how = open ? "" : `<span>${lockIcon()}<em style="color:${RARITY_CSS[3]}">${esc(tool.label)}</em>　${esc(POIS[poiIndex(tool.from)].name)}</span>`;
      return `<div class="quest route${open ? " open" : ""}"><div><strong>${routeIcon(open)}${esc(r.name)}</strong>${how}</div></div>`;
    });
    return `<h3 class="hub-sub">道</h3>${rows.join("")}`;
  }

  /**
   * What a module's level `lv` sets, as gauges: the heals issued to every raid, the trader's
   * materials up to a rarity, the stash's room, the radio's report, the pouch's slots.
   */
  private moduleGauges(m: ModuleId, lv: number): Gauge[] {
    const h: Hideout = { ...this.profile.hideout, [m]: lv };
    switch (m) {
      case "infirmary": {
        const at = issuedHeals({ hideout: h });
        const top = issuedHeals({ hideout: { ...h, infirmary: maxLevel("infirmary") } });
        return HEALS.filter((k) => top[k] > 0).map((k) => ({ key: k, mark: healIcon(HEAL_SPECS[k].shield), label: HEAL_SPECS[k].short, n: at[k], show: num, hideZero: true }));
      }
      case "workbench": {
        // The rarities lit, then the materials each step adds, in their rarity's colour.
        return [
          {
            key: "rarity",
            mark: "",
            n: materialRarity(h),
            show: (r: number, was = r) => {
              const added = (Object.keys(VALUABLES) as ValuableKind[]).filter((k) => VALUABLES[k].rarity > was && VALUABLES[k].rarity <= r);
              return `${rarityBar(r, was)}${added.length ? `<span class="mats">${added.map((k) => `<em style="color:${RARITY_CSS[VALUABLES[k].rarity]}">${esc(VALUABLES[k].label)}</em>`).join("")}</span>` : ""}`;
            },
          },
        ];
      }
      case "storage":
        return [{ key: "stash", mark: "", n: stashCap(h), show: num }];
      case "pouch":
        return [{ key: "pouch", mark: "", n: pouchSlots(h), show: (n: number, was?: number) => `${slotBoxes(n, was)}${num(n, was)}` }];
      case "radio":
        // What the report tells: the POI whose bins lean rare, then the valuable and the raiders' time. The only module told in words.
        return [
          {
            key: "radio",
            mark: "",
            n: lv,
            show: (n: number, was = n) =>
              n
                ? [`<em class="star">★</em>拠点`, `回収品`, `${clockIcon()}レイダー`]
                    .slice(0, n === 1 ? 1 : 3)
                    .map((t, i) => `<span class="tell${(i === 0 ? 1 : 2) > was ? " gain" : ""}">${t}</span>`)
                    .join("")
                : `<b class="n none">—</b>`,
          },
        ];
    }
  }

  /**
   * A hideout module: its mark, name, level and the next level's gain (was → now, lit). Opened, the
   * ladder of its levels and, set apart, what the next level takes and the button that builds it.
   */
  private moduleCard(m: ModuleId) {
    const p = this.profile;
    const spec = HIDEOUT[m];
    const lv = p.hideout[m];
    const next = nextLevel(p.hideout, m);
    const pips = Array.from({ length: maxLevel(m) }, (_, n) => `<i class="${n < lv ? "on" : ""}"></i>`).join("");
    const state = buildState(p, m);
    const open = this.module === m;
    const levels = Array.from({ length: maxLevel(m) + 1 }, (_, n) => this.moduleGauges(m, n));
    const gain = next ? `<div class="gain-row">${upIcon()}<b>Lv${lv + 1}</b>${deltaHtml(levels[lv], levels[lv + 1])}</div>` : `<div class="gain-row max">${levels[lv].map((g) => gaugeHtml(g)).join("")}<b>MAX</b></div>`;
    const body = open ? `<div class="mod-body">${ladder(levels, lv)}${next ? this.cost(next.items, next.cash, `<button type="button" data-act="build" data-arg="${m}" ${canBuild(p, m) ? "" : "disabled"}>Lv${lv + 1}</button>`) : ""}</div>` : "";
    return (
      `<div class="mod up-card${open ? " open" : ""}" data-mod="${m}"><button type="button" class="mod-head" data-act="mod" data-arg="${m}">` +
      `<strong>${MODULE_ICON[m]()}${esc(spec.name)}</strong><span class="pips">${pips}</span><b class="${state === "作れる" ? "go" : ""}">${state}</b>` +
      `${gain}</button>${body}</div>`
    );
  }

  /** A reward, in a line: the credits, then the items counted. */
  private reward(r: Reward): string {
    return [...(r.cash ? [`${yen(r.cash)} クレジット`] : []), ...rewardList({ reward: r }).map(([i, n]) => `<span style="color:${color(i)}">${esc(itemName(i))}${n > 1 ? ` × ${n}` : ""}</span>`)].join("・");
  }

  /**
   * One of the day's contracts: its type, its ask and reward, and the button that takes it or lets
   * it go. The taken one also offers its 強度: what a higher one pays first, then what it asks.
   */
  private contractCard(c: Contract, taken: Contract | null): string {
    const on = taken?.id === c.id;
    // One paper a raid: once one is taken (or the story's record), the others pale behind it.
    const dim = !on && (!!taken || !!takenStory(this.profile));
    const btn = on ? `<button type="button" class="untake" data-act="take" data-arg="">取り消す</button>` : `<button type="button" data-act="take" data-arg="${c.id}">${taken || takenStory(this.profile) ? "こちらに替える" : "受ける"}</button>`;
    const where = esc(regionOf(contractRegion(c)).name);
    const n = on ? this.profile.threat : 0;
    const pay = this.reward({ ...c.reward, cash: threatPay(c.reward.cash, n) });
    return (
      `<div class="quest contract${on ? " taken" : ""}${dim ? " dim" : ""}" data-type="${c.t}"><i class="pin"></i><div><strong><em>${CONTRACT_NAME[c.t]}</em>${on ? `<i class="taken-tag">${checkIcon()}${n ? `強度 ${n}` : ""}</i>` : ""}</strong><span>${esc(contractText(c))}</span>` +
      `<small>${where}・報酬 ${pay}</small>${on ? this.strengthRow(c) : ""}</div>${btn}</div>`
    );
  }

  /**
   * The 強度 of the taken contract: a button for each, 0 to `THREAT.max`, then what the chosen one
   * gives (the reward, mod parts) and what it asks (the
   * robots' numbers). The raid plays at it; with no contract taken, a raid plays at 0.
   */
  private strengthRow(c: Contract): string {
    const p = this.profile;
    const n = p.threat;
    const t = THREAT.levels[n];
    const pct = (k: number) => `${Math.round((1 - k) * 100)}%`;
    const buttons = Array.from({ length: THREAT.max + 1 }, (_, i) => `<button type="button" data-act="strength" data-arg="${c.id}:${i}"${i === n ? ' class="on"' : ""}>${i ? i : "通常"}</button>`).join("");
    // What the chosen 強度 gives (gold) and asks (red), each a name and a number; nothing at 通常.
    const gives = n ? `${upIcon()}報酬 ×${t.reward}・改造パーツ ×${t.mods}` : "";
    const asks = n ? `増援 −${pct(t.reinforce)}・レイダー −${pct(t.raiders)}・装甲板 +${Math.round(t.plate * 100)}%・射程 ×${t.range}` : "";
    const best = POIS.filter((o) => (p.freedAt[o.id] ?? 0) > 0).map((o) => `${o.name} ${p.freedAt[o.id]}`);
    return (
      `<div class="strength"><small>強度</small><div class="row">${buttons}</div>${gives ? `<p class="gives">${gives}</p>` : ""}${asks ? `<p class="asks">${asks}</p>` : ""}` +
      `<p class="sub">${best.length ? `最高 ${esc(best.join("・"))}・` : ""}</p><p class="bins">${binPicture(modIcon())}<b>${p.known.length} / ${MOD_KINDS.length}</b></p></div>`
    );
  }

  /** The story section: the record under way, then what the records home have told, the latest first. */
  private storyPanel(): string {
    const p = this.profile;
    const now = currentStory(p.records);
    const on = takenStory(p);
    const btn = on ? `<button type="button" class="untake" data-act="take" data-arg="">取り消す</button>` : `<button type="button" data-act="take" data-arg="${STORY_TAKEN}">${takenContract(p) ? "こちらに替える" : "受ける"}</button>`;
    const cur = now
      ? `<div class="quest story${on ? " taken" : ""}"><div><strong>${esc(now.title)}<small class="story-n">${STORIES.indexOf(now) + 1} / ${STORIES.length}</small>${on ? `<i class="taken-tag">${checkIcon()}</i>` : ""}</strong><span>${esc(storyWhere(now))}</span><small>報酬 ${yen(now.cash)} クレジット</small></div>${btn}</div>`
      : `<p class="story-done">${STORIES.length} / ${STORIES.length} ${checkIcon()}</p>`;
    const told = [...p.records]
      .reverse()
      .map((id) => {
        const t = storyOf(id);
        return `<details class="told"${id === p.records.at(-1) ? " open" : ""}><summary>${esc(t.title)}<small>${esc(storyWhere(t))}</small></summary>${t.told.map((l) => `<p>${esc(l)}</p>`).join("")}</details>`;
      })
      .join("");
    return `<h3 class="hub-sub">物語の依頼</h3>${cur}${told}`;
  }

  private quest(q: Quest) {
    const p = this.profile;
    const got = p.quests.progress[q.id] ?? 0;
    const g = q.goal;
    const reward = this.reward(q.reward);
    let state: string;
    if (g.t === "deliver") {
      const have = p.stash.filter((i) => i.t === "valuable" && i.kind === g.valuable).length;
      state = deliverable(p, q) ? `<button type="button" data-act="deliver" data-arg="${q.id}">納品する</button>` : `<b>倉庫 ${have} / ${g.n}</b>`;
    } else state = `<b>${got} / ${need(g)}</b>`;
    return `<div class="quest"><div><strong>${esc(q.title)}</strong><span>${esc(q.text)}</span><small>報酬 ${reward}</small></div>${state}</div>`;
  }

  /** The truck's depot allowance, as a slot: the depot's level, what the loadout uses of it, and the way to the next level. */
  private depotSlot(): string {
    const allow = this.allowance();
    if (!allow) return "";
    // Over the allowance it turns red with what it is over by; under it, the credits' worth still to send through this depot for its next level.
    return `<div class="slot depot${allow.cost > allow.budget ? " over" : ""}"><small>持ち込み枠</small><span>${depotIcon()}Lv${allow.level}<b>${allow.cost} / ${allow.budget}</b></span>${this.carryBoxes(allow.budget)}<small>${
      allow.cost > allow.budget ? `${crossIcon()}+${allow.cost - allow.budget}` : allow.next === null ? "MAX" : `${upIcon()}Lv${allow.level + 1}　${yen(allow.next)}`
    }</small></div>`;
  }

  /**
   * A depot start's allowance as boxes, one a point: each weapon, armour and key the loadout takes
   * fills as many boxes as it costs, in its rarity's colour, and one past the allowance stands out
   * in red. What costs nothing (the starter weapons, every heal) sits beside the boxes, outside.
   */
  carryBoxes(budget: number): string {
    const p = this.profile;
    const l = this.startLoad();
    const all = [...new Set(l.weapons)].slice(0, 2).concat(l.armor === null ? [] : [l.armor], l.keys).map((n) => p.stash[n]).filter((i): i is Item => !!i);
    const taken = all.filter((i) => itemCost(i) > 0);
    let used = 0;
    const segs = taken.map((i) => {
      const n = itemCost(i);
      used += n;
      return `<i class="seg${used > budget ? " over" : ""}" style="--n:${n}">${itemMark(i)}</i>`;
    });
    const empty = Array.from({ length: Math.max(0, budget - used) }, () => `<i class="seg empty" style="--n:1"></i>`);
    const issued = issuedHeals(p);
    const free = [
      ...all.filter((i) => itemCost(i) === 0).map((i) => itemMark(i)),
      ...HEALS.filter((k) => l.heals[k] + issued[k] > 0).map((k) => `<span>${healIcon(HEAL_SPECS[k].shield)}${l.heals[k] + issued[k]}</span>`),
    ];
    return `<span class="carry"><span class="boxes">${segs.join("")}${empty.join("")}</span>${free.length ? `<span class="free">${free.join("")}</span>` : ""}</span>`;
  }

  /** The departure's carry-in boxes when the raid starts at a depot, else "". */
  departBoxes(): string {
    this.fixStart();
    const a = this.allowance();
    return a ? `<div class="depart-carry${a.cost > a.budget ? " over" : ""}"><small>${depotIcon()}持ち込み枠</small><b>${a.cost} / ${a.budget}</b>${this.carryBoxes(a.budget)}</div>` : "";
  }

  /**
   * The map table's island: the map with each POI coloured by who holds it, the day, the row of
   * the six nodes, the key to the colours, the front and the day's income.
   */
  private islandPanel(): string {
    const p = this.profile;
    const taken = takenContract(p);
    const holds = islandHolds(p);
    const front = frontNodes(holds);
    // How much of the island is the player's is the row of six marks above; the key only names the colours.
    const key =
      (["freed", "held"] as const).map((h) => `<li><i style="background:${HOLD_CSS[h]}"></i>${h === "freed" ? "自分" : "敵"}</li>`).join("") +
      `<li><i class="titan" style="background:${TITAN_CSS}"></i>タイタン</li>` +
      `<li class="front"><i></i>前線<b>${NODES.filter((_, i) => front[i]).map((n) => esc(n.name)).join("・") || "—"}</b></li>` +
      `<li class="income">収入<b>${frontIncome(p).toLocaleString()} クレジット</b></li>`;
    return (
      `<div class="hub-island"><canvas id="hub-island-map"></canvas><div class="hub-island-side">` +
      `<div class="hub-day"><small>島の日</small><b>${p.day}</b><small>日目</small></div>` +
      `<div class="hub-row">${nodeRow(holds)}</div>` +
      `<small>島の出来事</small><ul class="events"><li><small>今日</small>${eventRow(p.events[0])}</li><li><small>明日</small>${eventRow(p.events[1])}</li></ul>` +
      `<ul class="hold-key">${key}</ul>` +
      (taken ? `<small>依頼　${esc(regionOf(contractRegion(taken)).name)}<i class="taken-line"></i></small><p class="hub-taken">${CONTRACT_NAME[taken.t]}：${esc(contractText(taken))}</p>` : "") +
      `</div></div>`
    );
  }

  /** Draws the map table's island into its canvas, framed on the region the last start was in. */
  private drawIsland() {
    const canvas = document.getElementById("hub-island-map") as HTMLCanvasElement | null;
    if (!canvas) return;
    const map = new IslandMap(canvas);
    map.known = this.profile.entries;
    map.region = this.from ? poiRegion(this.from).id : this.region;
    const c = takenContract(this.profile);
    map.contract = c && contractMark(c);
    map.draw(islandScene(this.profile));
  }

  /** The map table's radio report on the next raid, as a slot, or "" without a radio. */
  private intelSlot(): string {
    const intel = this.intel();
    return intel ? `<div class="slot intel"><small>${radioIcon()}無線</small><span>${intel}</span></div>` : "";
  }

  /**
   * The shelves: the two weapons picked from the stash (the starter weapons with nothing else
   * picked) with their numbers, the armour, keys and heals to take (the issued heals always come
   * too), and the truck's allowance when it drives to a depot.
   */
  private kitPanel(): string {
    const p = this.profile;
    const issued = issuedHeals(p);
    const slot = (label: string, n: number | null | undefined, extra = "") => `<div class="slot"><small>${label}</small><span${n == null ? ' class="none"' : ` style="color:${color(p.stash[n])}"`}>${n == null ? "なし" : starterMark(p.stash[n]) + esc(itemName(p.stash[n]))}</span>${extra}</div>`;
    const stat = (n: number | undefined) => {
      const i = n === undefined ? undefined : p.stash[n];
      return i?.t === "weapon" ? `<small class="stat">${esc(weaponStats(i.kind, i.rarity))}</small>` : "";
    };
    const heal = (k: (typeof HEALS)[number]) =>
      `<div class="slot count"><small>${HEAL_SPECS[k].label}</small><button type="button" data-act="heal-" data-arg="${k}">−</button><b>${this.load.heals[k] + issued[k]}</b><button type="button" data-act="heal+" data-arg="${k}">+</button><small>倉庫 ${this.load.heals[k]}/${healCount(p, k)}${issued[k] ? `<span class="issued">${issueIcon()}${issued[k]}</span>` : ""}</small></div>`;
    const keys = this.load.keys.map((n) => esc(itemName(p.stash[n]))).join("・");
    const weapons = slot("武器 1", this.load.weapons[0], stat(this.load.weapons[0])) + slot("武器 2", this.load.weapons[1], stat(this.load.weapons[1]));
    return (
      this.depotSlot() +
      weapons +
      slot("アーマー", this.load.armor) +
      `<div class="slot"><small>鍵</small><span${keys ? ` style="color:${RARITY_CSS[3]}"` : ' class="none"'}>${keys || "なし"}</span></div>` +
      HEALS.map(heal).join("") +
      // The pouch: the slots of valuables a wipe leaves the player.
      `<div class="slot pouch"><small>${pouchIcon()}ポーチ</small><span class="boxes">${Array.from({ length: pouchSlots(p.hideout) }, () => `<i class="seg pouch" style="--n:1"></i>`).join("")}</span><b>${pouchSlots(p.hideout)}</b></div>`
    );
  }

  /** The next raid's kit in words, for the departure's check and the camp's card: weapons, armour, heals, keys. */
  kitLines(): { weapons: string; armor: string; heals: string; keys: string } {
    const p = this.profile;
    const l = this.load;
    const issued = issuedHeals(p);
    const weapons = l.weapons.map((n) => itemName(p.stash[n])).join("・");
    const armor = l.armor === null ? "なし" : itemName(p.stash[l.armor]);
    const heals = HEALS.filter((k) => l.heals[k] + issued[k] > 0)
      .map((k) => `${HEAL_SPECS[k].label} ${l.heals[k] + issued[k]}`)
      .join("・");
    const keys = l.keys.map((n) => itemName(p.stash[n])).join("・") || "なし";
    return { weapons, armor, heals: heals || "なし", keys };
  }

  /**
   * What the departure lists beside its map: the kit taken out of the stash, the objective, and
   * warnings worth a second look. The start is the map's (`startPoints()`).
   */
  departure(): { rows: [string, string][]; warn: string[] } {
    this.fixStart();
    const p = this.profile;
    const k = this.kitLines();
    const c = takenContract(p);
    const story = takenStory(p) ? currentStory(p.records) : null;
    const front = this.frontPick();
    const goal = c ? `${CONTRACT_NAME[c.t]}：${contractText(c)}${p.threat ? `（強度 ${p.threat}）` : ""}` : story ? `記録：${story.title}` : front ? `前線：${front.name}` : "探索";
    const rows: [string, string][] = [
      ["武器", k.weapons],
      ["アーマー", k.armor],
      ["回復", k.heals],
      ["鍵", k.keys],
      ["目的", goal],
    ];
    const warn: string[] = [];

    return { rows, warn };
  }

  /**
   * The front node the camp recommends today: the front node nearest the camp, which is where the
   * objective card points a raid with no contract out of the gate (`objectiveSteps()`). Null with
   * no node on the front.
   */
  frontPick(): { name: string } | null {
    const p = this.profile;
    const front = frontNodes(islandHolds(p));
    const near = NODES.map((n, i) => ({ n, i }))
      .filter(({ i }) => front[i])
      .sort((a, b) => Math.hypot(a.n.x - CAMP.wake.x, a.n.z - CAMP.wake.z) - Math.hypot(b.n.x - CAMP.wake.x, b.n.z - CAMP.wake.z))[0];
    return near ? { name: near.n.name } : null;
  }

  /**
   * The camp's 今日の作戦 card and its line of the day: the day and the row of the six nodes;
   * then the node to go for, the contract or story taken, and the kit.
   */
  today(): { head: string; row: string; plan: [string, string][] } {
    const p = this.profile;
    const head = `${p.day} 日目`;
    const pick = this.frontPick();
    const c = takenContract(p);
    const story = takenStory(p) ? currentStory(p.records) : null;
    const k = this.kitLines();
    const plan: [string, string][] = [
      ["攻める拠点", pick ? pick.name : "なし"],
      ["依頼", c ? `${CONTRACT_NAME[c.t]}：${contractText(c)}${p.threat ? `（強度 ${p.threat}）` : ""}` : story ? `記録：${story.title}` : "なし"],
      ["装備", `${k.weapons}・アーマー ${k.armor}`],
    ];
    return { head, row: nodeRow(islandHolds(p)), plan };
  }

  render() {
    const p = this.profile;
    const st = this.station;
    if (!st) return;
    const panel = PANELS[st];
    $("hub-title").textContent = panel.title;
    $("hub-cash").textContent = yen(p.cash);
    $("hub-record").textContent = `出撃 ${p.raids} ・ 生還 ${p.extracted}`;
    // The storage's crate: the room it gives is the count's right side.
    $("hub-stash-count").innerHTML = `${stashIcon()}${stashUsed(p)} / ${stashCap(p.hideout)}`;
    $("hub").dataset.station = st;
    $("hub-stash-col").hidden = !panel.stash;
    $("hub-cols").classList.toggle("one", !panel.stash);
    const want = wanted(p);
    const need: Needs = { hideout: stillNeeded(p.hideout), factory: factoryNeeded(p) };
    const shop = st === "shop";
    const kit = st === "stash";
    // A start chosen in an earlier visit may not be allowed by a profile loaded since.
    this.fixStart();
    if (panel.stash) {
      const used = new Set([...this.load.weapons, ...this.load.keys, ...(this.load.armor === null ? [] : [this.load.armor])]);
      $("hub-stash").innerHTML =
        rows(p.stash)
          .map(({ item, index }) => {
            const on = kit && used.has(index[0]);
            // When the truck drives to a depot, each pick shows what it costs of the depot's allowance.
            const cost = kit && this.from && itemCost(item) > 0 ? `枠 ${itemCost(item)}` : "";
            // A starter weapon is not for sale: on the trader's side it is a plain line, with no price.
            const fixed = isStarter(item);
            const right = shop ? (fixed ? "" : `<b>売る ${yen(sellPrice(item))}</b>`) : on ? `<b>持っていく${cost ? `・${cost}` : ""}</b>` : cost ? `<b class="cost">${cost}</b>` : item.t === "valuable" ? `<b>${yen(price(item))}</b>` : "";
            const act = shop ? (fixed ? undefined : "sell") : kit && (item.t === "weapon" || item.t === "armor" || item.t === "key") ? "pick" : undefined;
            return this.item(item, { act, arg: index.join(","), on, right, count: index.length, need, warn: shop && this.armed === index.join(",") });
          })
          .join("") || `<p class="empty">0 / ${stashCap(p.hideout)}</p>`;
    }
    $("hub-side-title").textContent = shop ? "売り物" : st === "quests" ? "依頼と記録" : st === "workshop" ? "隠れ家" : st === "factory" ? "自軍のロボット" : st === "map" ? "島" : "持っていく物";
    if (st === "factory") $("hub-side").innerHTML = this.factoryPanel();
    else if (st === "workshop") {
      $("hub-side").innerHTML =
        MODULES.map((m) => this.moduleCard(m)).join("") + this.routes();
      $("hub-side").querySelector(".mod.open .mod-body")?.parentElement?.scrollIntoView({ block: "nearest" });
    } else if (shop) {
      const full = stashUsed(p) >= stashCap(p.hideout);
      $("hub-side").innerHTML = shelfTiers(p) + wares(p)
        .map((item, n) => `<button type="button" class="item" data-act="buy" data-arg="${n}" ${p.cash < buyPrice(item) || full ? "disabled" : ""}><span style="color:${color(item)}">${esc(itemName(item))}</span><small${item.t === "valuable" && want[item.kind] > 0 ? ' class="need"' : ""}>${item.t === "valuable" ? (want[item.kind] > 0 ? `${upIcon()}${want[item.kind]}` : need.hideout[item.kind] + need.factory[item.kind] > 0 ? checkIcon() : "") : itemNote(item)}</small><b>${yen(buyPrice(item))}</b></button>`)
        .join("");
    } else if (st === "quests") {
      const open = offered(p.quests);
      const intro = open.filter((q) => q.intro);
      const craft = open.filter((q) => !q.intro);
      const taken = takenContract(p);
      // A new day's papers slide onto the board the first time it is opened that day.
      const fresh = boardKey(p) !== this.boardSeen;
      this.boardSeen = boardKey(p);
      $("hub-side").innerHTML =
        (intro.length ? `<h3 class="hub-sub first">入門の依頼</h3>${intro.map((q) => this.quest(q)).join("")}` : "") +
        `<h3 class="hub-sub${intro.length ? "" : " first"}">今日の依頼<small>${p.day} 日目</small></h3>` +
        `<div class="board${fresh ? " fresh" : ""}">${p.board.contracts.map((c) => this.contractCard(c, taken)).join("")}</div>` +
        (craft.length ? `<h3 class="hub-sub">商人の依頼</h3>${craft.map((q) => this.quest(q)).join("")}` : "") +
        this.storyPanel();
    } else if (st === "map") {
      $("hub-side").innerHTML = this.intelSlot() + this.islandPanel();
      this.drawIsland();
    }
    else $("hub-side").innerHTML = this.kitPanel();
    // The shelves' footer: what the next raid takes out, in a line.
    $("hub-foot").hidden = !kit;
    if (kit) {
      const k = this.kitLines();
      $("hub-foot-note").textContent = `${k.weapons}・アーマー ${k.armor}・${k.heals}`;
    }
  }
}
