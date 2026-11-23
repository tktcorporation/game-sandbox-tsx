import { PLAYER } from "../sim/config";
import { incomingFor, neighboursFor } from "../island-net";
import { LOCAL_AID, type Parcel } from "../meta/parcels";
import { armorIcon, binPicture, fightIcon, entryIcon, coinIcon, dmgIcon, magIcon, rateIcon, checkIcon, coreIcon, factoryIcon, flagIcon, hideoutIcon, clockIcon, crossIcon, depotIcon, gunIcon, healIcon, issueIcon, keyIcon, lockIcon, modIcon, pinIcon, pouchIcon, radioIcon, robotIcon, routeIcon, SIDE, stashIcon, turretIcon, upIcon, workbenchIcon } from "./icons";
import { ALLY, FACTORY, FACTORY_TOP, HEALS as HEAL_SPECS, HIDEOUT, MOD_KINDS, PLATE, RARITY, THREAT, TOOLS, VALUABLES, WEAPONS, type EnemyKind, type ModuleId, type Rarity, type ValuableKind, type WeaponKind } from "../sim/config";
import { boostFor, raidClock, strengthFor, type Kit } from "../sim/state";
import { CAMP, DEPOTS, ENTRIES, entryOf, HOME_REGION, NODES, nodeIndex, POIS, UNLOCKS, poiIndex, poiRegion, REGIONS, regionOf, ROUTES, type EntryId, type NodeId, type PoiId, type RegionId, type StationId } from "../sim/map";
import { armed, build, buildFactory, buildState, buy, buyPrice, canBuild, canBuildFactory, factoryNeeded, nextFactory, canStartIn, deliver, deliverable, depotAllowance, emptyLoadout, FIRST_ENTRY, fitsStart, isStarter, issuedHeals, itemCost, HEALS, healCount, healRoom, keyName, kitPicks, loadoutCost, stashUsed, price, raidThreat, recallLoadout, roundThreat, sell, sellPrice, setThreat, startsIn, STORY_TAKEN, takenStory, threatPay, take, takeKit, takenContract, wanted, wares, type Item, type Loadout, type Profile } from "../meta/profile";
import { CONTRACT_NAME, contractMark, contractRegion, targetName, type Contract, type Reward } from "../meta/contracts";
import { currentStory, STORIES, storyOf, storyWhere } from "../meta/story";
import { materialRarity, maxLevel, MODULES, nextLevel, pouchSlots, sources, stashCap, stillNeeded, type Hideout, type Source } from "../meta/hideout";
import { need, offered, type Quest, type RewardItem } from "../meta/quests";
import { saveProfile } from "../meta/storage";
import { departDepots, eventName, finaleOpen, frontIncome, islandHolds, playerNodes, shopRarity, unfreeable, unlocked } from "../meta/island";
import { eventRow } from "./events";
import { rivalOf } from "../sim/holds";
import { HOLD_CSS, IslandMap, islandScene, RIVAL_CSS, TITAN_CSS } from "./map";
import { ExpeditionPanel } from "./expeditions";
import type { IncursionPlan } from "../meta/incursion";
import { answerable, homeSquads, incomingLine, LOG_WORD, logLine, squadsAway, type Incoming, type IslandLogEntry, type Outgoing } from "../meta/expeditions";
import { enemyNodes, frontNodes, ownNodes } from "../sim/front";
import { nodeRow } from "./row";
import { sfx } from "./sfx";
import { UI, rarityText } from "./palette";

const RARITY_CSS = ["var(--r0)", "var(--r1)", "var(--r2)", "var(--r3)"];

/** The robots' kinds by name, for the factory. */
const ENEMY_NAME: Record<EnemyKind, string> = { grunt: "グラント", heavy: "ヘビー", drone: "ドローン", charger: "チャージャー", titan: "タイタン" };

/** Aid left at a 中継ボックス by someone the player can name (other islands / neighbours). */
export function namedAid(p: Pick<Profile, "parcels">): Parcel[] {
  return (p.parcels ?? []).filter((q) => q.from.name.trim() && q.from.code !== LOCAL_AID && q.from.code !== "");
}

/** The front node nearest the camp (same pick as the objective with no contract). */
export function frontPickFor(p: Profile): { name: string } | null {
  const front = frontNodes(islandHolds(p));
  const near = NODES.map((n, i) => ({ n, i }))
    .filter(({ i }) => front[i])
    .sort((a, b) => Math.hypot(a.n.x - CAMP.wake.x, a.n.z - CAMP.wake.z) - Math.hypot(b.n.x - CAMP.wake.x, b.n.z - CAMP.wake.z))[0];
  return near ? { name: near.n.name } : null;
}

/** A front node held by another player — the reason to sortie and take it back. */
export function rivalFrontPick(p: Profile): { name: string } | null {
  const holds = islandHolds(p);
  const front = frontNodes(holds);
  const near = NODES.map((n, i) => ({ n, i }))
    .filter(({ i }) => front[i] && rivalOf(holds[i]) !== null)
    .sort((a, b) => Math.hypot(a.n.x - CAMP.wake.x, a.n.z - CAMP.wake.z) - Math.hypot(b.n.x - CAMP.wake.x, b.n.z - CAMP.wake.z))[0];
  return near ? { name: near.n.name } : null;
}

/**
 * The one next action after a raid or while idle in camp: grow the base if something can be
 * built or delivered, else go out again. Player-facing station names only. Incoming expeditions
 * and rival holds sit on the same line (defend / take back) — no separate multiplayer mode.
 */
export function nextHandFor(p: Profile): string {
  if (incomingFor(p).length) return "次：地図の机 · 来る遠征を固める";
  const rival = rivalFrontPick(p);
  if (rival) return `次：車両から出撃 · ${rival.name}を取り返す`;
  if (canBuildFactory(p)) return "次：工場 · 次の段を上げる";
  if (MODULES.some((m) => canBuild(p, m))) return "次：工房 · 次の段を上げる";
  if (offered(p.quests).some((q) => deliverable(p, q))) return "次：依頼板 · 納品する";
  if (!takenContract(p) && !takenStory(p) && p.board.contracts.length) return "次：依頼板 · 依頼を選ぶ";
  const pick = frontPickFor(p);
  return pick ? `次：車両から出撃 · 前線：${pick.name}` : "次：車両か門から出撃";
}

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

/** The gauges' full lengths: a shot's damage, shots a minute, the magazine. */
const STAT_FULL = { dmg: 100, rate: 900, mag: 30 };

/**
 * A weapon's numbers at a rarity, from its spec, as three gauges with their marks: damage a shot
 * (pellets together), shots a minute, the magazine. The number stands beside each bar, so two
 * weapons compare by length and read exactly.
 */
export function weaponStats(kind: WeaponKind, rarity: Rarity): string {
  const w = WEAPONS[kind];
  const dmg = Math.round(w.dmg * RARITY.dmg[rarity]);
  const rate = Math.round(60 / w.interval);
  const mag = Math.round(w.mag * RARITY.mag[rarity]);
  const g = (mark: string, v: number, full: number, text: string, label: string) => `<span class="g" title="${label}" style="--v:${Math.min(1, v / full).toFixed(2)}">${mark}<span class="bar"></span><span class="n">${text}</span></span>`;
  return `<span class="wstats">${g(dmgIcon(), dmg * w.pellets, STAT_FULL.dmg, `${dmg}${w.pellets > 1 ? `×${w.pellets}` : ""}`, "威力")}${g(rateIcon(), rate, STAT_FULL.rate, `${rate}`, "毎分")}${g(magIcon(), mag, STAT_FULL.mag, `${mag}`, "弾倉")}</span>`;
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
      return `<span class="wclass">${WEAPONS[i.kind].label}</span>${weaponStats(i.kind, i.rarity)}`;
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
    const by = NODES.filter((n) => UNLOCKS[n.id].shop === r).map((n) => `<em${mine.includes(n.id) ? ' class="mine"' : ""}>${esc(n.name)}</em>`);
    return `<div class="tier${r <= best ? " on" : ""}" style="--c:${RARITY_CSS[r]}"><i></i><span>${by.join("")}</span></div>`;
  });
  // The materials beside them, under the workbench's wrench: the rarities it lets the trader sell.
  const mats = materialRarity(p.hideout);
  const row = ([0, 1, 2, 3] as Rarity[]).map((r) => `<div class="${r <= mats ? "on" : ""}" style="--c:${RARITY_CSS[r]}">${workbenchIcon(r <= mats ? RARITY_CSS[r] : undefined)}<i></i></div>`);
  return `<div class="shelf-tiers">${cells.join("")}</div><div class="shelf-mats">${row.join("")}</div>`;
}

/** An item's colour: its rarity's, gold for a key or a tool, white for a heal. */
export const itemColor = (i: Item | RewardItem) =>
  rarityText(itemShade(i));

/** An item's rarity colour as it stands (the epic's own purple); `itemColor()` is it for a name in text. */
const itemShade = (i: Item | RewardItem) =>
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
/**
 * A contract's ask as marks, not a sentence: the enemy's core and the node to take; the POI and the
 * valuable to bring from its bins, as a chip with the count; a robot and the squad to destroy.
 */
export function contractMarks(c: Contract): string {
  const poi = (id: PoiId) => `<b>${esc(POIS[poiIndex(id)].name)}</b>`;
  switch (c.t) {
    case "free":
      return `<span class="ask">${coreIcon(SIDE.enemy)}${poi(c.poi)}</span>`;
    case "fetch":
      return `<span class="ask">${poi(c.poi)}<span class="chip" style="--c:${RARITY_CSS[VALUABLES[c.kind].rarity]}">${VALUABLES[c.kind].label}<b>${c.n}</b></span></span>`;
    case "intercept":
      return `<span class="ask">${robotIcon(SIDE.enemy)}<b>${esc(targetName(c.target))}</b></span>`;
  }
}

/** What became of one of this island's expeditions out: it holds its node (held), was wiped out attacking it (wiped), or lost the node it held (lost). */
interface ExpNews {
  t: "held" | "wiped" | "lost";
  code: string;
  name: string;
  node: NodeId;
}

/** That as a sentence, for its title. */
export function expLine(n: ExpNews): string {
  const at = NODES[nodeIndex(n.node)]?.name ?? n.node;
  return n.t === "held" ? `${n.name}の島の${at}を遠征隊が取った` : n.t === "wiped" ? `${n.name}の島の${at}で遠征隊が全滅した` : `${n.name}の島の${at}を取り返された`;
}

const itemMark = (i: Item) => `<span style="color:${itemColor(i)}">${i.t === "weapon" ? gunIcon() : i.t === "armor" ? armorIcon() : keyIcon()}</span>`;
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
  signal: { title: "信号所", stash: false },
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

/**
 * A place on the departure's map a raid may not start from, shown in the column beside the map
 * when tapped, without becoming the start: a way in not known, a depot whose node is not held, or
 * a region with neither.
 */
export interface LockedPick {
  kind: StartPoint["kind"] | "region";
  id: string;
}

/** Why a start is shut and how to open it: its name, the reason in a few words (the confirm says it), and a line for each way to open it. */
export interface LockHint {
  name: string;
  why: string;
  /** Each line as HTML: marks, and names escaped. */
  how: string[];
}

/** The nodes of a region whose depot, once the node is held and the depot switched on, opens a start there (`UNLOCKS[].depart`). */
const departNodesIn = (region: RegionId): PoiId[] => regionOf(region).pois.filter((p) => p in UNLOCKS && UNLOCKS[p as keyof typeof UNLOCKS].depart);

/**
 * How a region with no start opens, a line each: walking in a raid over each of its crossings
 * (`Region.reach`) to one of its ways in and getting off alive, or a depot opened by a node held.
 */
/** The way to a way in, as marks: a region, the crossing, the way in dashed (not known yet). */
const ARROW = `<i class="to">›</i>`;
/** Reaching a way in and coming home alive: the dashed ring turns solid. */
const LEARN = `<span class="how">${entryIcon(false)}到着${ARROW}生還${ARROW}${entryIcon()}</span>`;

/**
 * Another player's expedition coming at a node of the player's, as marks: whose flag and name, the
 * node, and the hours left (or that it waits or attacks there). The sentence is `incomingLine()`.
 */
function incomingMarks(e: Incoming, now: number): string {
  const head = `${flagIcon(SIDE.rival)}${esc(e.by.name || e.by.code)}${ARROW}${coreIcon(SIDE.own)}${esc(NODES[nodeIndex(e.node)]?.name ?? e.node)}`;
  // One with no clock (the game's own islands: it waits for the raid) says only that it comes in the next.
  const tail = e.state === "waiting" ? "足止め" : e.state === "attacking" ? fightIcon(UI.alert) : e.arriveAt > 0 ? `${clockIcon()}<b>${Math.max(1, Math.ceil((e.arriveAt - now) / 3_600_000))}h</b>` : `<b>次のレイド</b>`;
  return `<span class="how">${head}${tail}</span>`;
}

/** How a region with no start opens, as HTML lines of marks: each crossing walked, then the depots that open a start there. */
function regionHow(region: RegionId): string[] {
  const r = regionOf(region);
  const walks = (r.reach ?? []).map((c) => `<span class="how">${esc(regionOf(c.from).name)}${ARROW}${esc(c.by)}${ARROW}${entryIcon(false)}${esc(entryOf(c.to).name)}</span>`);
  const depots = departNodesIn(region).map((d) => esc(POIS[poiIndex(d)].name));
  return [...walks, ...(walks.length ? [LEARN] : []), ...(depots.length ? [`<span class="how">${coreIcon(SIDE.own)}${depots.join("・")}${ARROW}${depotIcon()}</span>`] : [])];
}
/** A raid the camp hands over to start: the kit taken, where, and from which start. */
export interface Launch {
  kit: Kit;
  region: RegionId;
  seed: number;
  from?: PoiId;
  entry: EntryId;
  /**
   * Lead-incursion onto another island's copy (raid-loot stage 6). Left out, a normal home raid.
   */
  incursion?: IncursionPlan;
}

/**
 * Where a valuable is found, as a line: the POIs whose bins hold it most often (with the
 * chance per bin), then the likeliest other place.
 */
export function whereLine(kind: ValuableKind): string {
  const all = sources(kind);
  const bins = all.filter((s) => s.from === "bin").slice(0, 3);
  const other = all.find((s) => s.from !== "bin");
  // A place and its share each, as HTML: a place's name tells where it is.
  const say = (s: Source) => `<span class="src">${esc(s.where)}<b>${Math.round(Math.min(1, s.share) * 100)}%</b></span>`;
  return [...bins, ...(other ? [other] : [])].map(say).join("");
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
  /** The shut start the departure shows beside its map (`peek()`), or null; never the start itself. */
  private peeked: LockedPick | null = null;
  /** The hideout module opened to show what its next level takes. */
  private module: ModuleId | null = null;
  /** A stash row a module still needs, pressed once to sell: the next press sells it. */
  private armed = "";
  /** The contract board last put up on the board panel; a new day's board slides its papers in once. */
  private boardSeen: string;
  /** What became of this island's expeditions out (each that took its node, or was wiped out or lost it), newest first, for the signal station. */
  private expNews: ExpNews[] = [];
  /** Whether the factory's ladder of every level is unfolded. */
  private factoryLadder = false;
  /** The factory's expeditions section, which draws itself (`#hub-exped`). */
  private exped: ExpeditionPanel;
  /** The island's news from the server (its log), as lines for the map table, and whether the map table has shown them. */
  private news: IslandLogEntry[] = [];
  private newsSeen = true;

  /** Starts a lead-incursion Launch from the signal station (main wires this). */
  private startIncursion: ((go: Launch) => void) | null = null;

  constructor(
    public profile: Profile,
    private closed: () => void,
  ) {
    this.region = profile.region;
    this.entry = this.entryIn(profile.region);
    this.load = recallLoadout(profile);
    this.boardSeen = boardKey(profile);
    this.fixStart();
    this.exped = new ExpeditionPanel(
      () => this.profile,
      (p) => this.set(p),
      (n) => this.takeNews(n),
      (plan) => this.launchIncursion(plan),
    );
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
    if (station === "signal") this.newsSeen = true;
    this.render();
    if (station === "signal") this.exped.open();
  }

  /**
   * A log entry as marks: whose, what happened in a word, where; someone's attack also offers to
   * answer it (仕返し), which opens the factory's expeditions on their island.
   */
  private newsMarks(n: IslandLogEntry): string {
    const who = n.by.name || n.by.code;
    const node = NODES[nodeIndex(n.node)]?.name ?? n.node;
    const mine = n.t === "wiped" || n.t === "retaken";
    const back = answerable(n) ? `<button type="button" class="revenge" data-act="exp-revenge" data-arg="${esc(n.by.code)}">${flagIcon()}仕返し</button>` : "";
    return `<li title="${esc(logLine(n))}"><b class="who">${esc(who)}</b><em class="${mine ? "own" : "foe"}">${LOG_WORD[n.t]}</em>${esc(node)}${back}</li>`;
  }

  /** Takes the island's news from the server (its log's new entries): the map table lists them and its mark tells of them until it is opened. */
  takeNews(entries: readonly IslandLogEntry[]) {
    if (!entries.length) return;
    this.news = [...entries, ...this.news].slice(0, 8);
    this.newsSeen = this.station === "signal";
    // News that comes while the signal station is open is drawn at once, apart from the expeditions' section (and the code being typed there).
    const el = this.station === "signal" ? document.getElementById("hub-signal-news") : null;
    if (el) el.innerHTML = this.signalNews();
  }

  /**
   * Notes what became of the expeditions out between profile `prev` and `next`: one that came to
   * hold its node, and one that was gone after attacking (wiped out) or after holding (its node
   * taken back). One called home, or one never sent, says nothing. The signal station's mark tells
   * of them until it is opened.
   */
  private noteOutgoing(prev: readonly Outgoing[], next: readonly Outgoing[]) {
    const names = new Map(neighboursFor(this.profile).map((n) => [n.code, n.name]));
    const fresh: ExpNews[] = [];
    for (const o of next) {
      const was = o.id > 0 ? prev.find((x) => x.code === o.code && x.id === o.id) : undefined;
      if (!was || was.state === o.state) continue;
      const t = o.state === "holding" ? "held" : o.state === "gone" && was.state === "holding" ? "lost" : o.state === "gone" && (was.state === "attacking" || was.state === "coming" || was.state === "waiting") ? "wiped" : null;
      if (t) fresh.push({ t, code: o.code, name: names.get(o.code) ?? o.code, node: o.node });
    }
    if (!fresh.length) return;
    this.expNews = [...fresh, ...this.expNews].slice(0, 6);
    this.newsSeen = this.station === "signal";
    const el = this.station === "signal" ? document.getElementById("hub-signal-news") : null;
    if (el) el.innerHTML = this.signalNews();
  }

  /** Takes a profile the server's answer changed (the holds, the log read, the expeditions), keeping the loadout. */
  update(p: Profile) {
    this.set(p);
    // The signal station open shows the expeditions out as they now stand.
    if (this.station === "signal") this.exped.redraw();
  }

  /** `tell`: let the camp know, so it takes the controls back. */
  close(tell = true) {
    if (this.station === null) return;
    this.station = null;
    this.module = null;
    this.factoryLadder = false;
    this.armed = "";
    this.exped.cancel();
    // A field typed in (the factory's island code) gives up the keys with the panel.
    if (document.activeElement instanceof HTMLElement && $("hub").contains(document.activeElement)) document.activeElement.blur();
    $("hub").hidden = true;
    if (tell) this.closed();
  }

  private set(p: Profile) {
    this.noteOutgoing(this.profile.expeditions, p.expeditions);
    this.profile = p;
    saveProfile(p);
    this.load = this.fit(this.load);
  }

  /** Takes a profile settled after a raid: the last loadout picked again from the stash, the start kept where the profile allows it. */
  reload(p: Profile) {
    this.noteOutgoing(this.profile.expeditions, p.expeditions);
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
    if (act === "open-signal") {
      sfx.click();
      return this.open("signal");
    }
    if (act === "exp-revenge") {
      // Answering an attack: the signal station opens on the island it came from.
      this.exped.revenge(arg);
      return this.open("signal");
    }
    if (act.startsWith("exp-")) {
      sfx.click();
      return this.exped.act(act, arg);
    }
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
    } else if (act === "factory-ladder") {
      this.factoryLadder = !this.factoryLadder;
      sfx.click();
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
    if (this.peeked) return this.lockHint(this.peeked)?.why ?? "";
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
    // Only depots a held node could open a start from: one that never opens one is no start to show.
    const depots: StartPoint[] = DEPOTS.filter((d) => p.depots.includes(d.poi) && departNodesIn(poiRegion(d.poi).id).includes(d.poi)).map((d) => {
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

  /**
   * Why a start on the departure's map is shut and how to open it, from the data: a region with no
   * start (its crossings and its depots), a way in not found yet, a depot whose node is not held.
   * Null for one that is open.
   */
  lockHint(at: LockedPick): LockHint | null {
    const p = this.profile;
    if (at.kind === "region") {
      const id = at.id as RegionId;
      return canStartIn(p, id) ? null : { name: regionOf(id).name, why: "道を知らない", how: regionHow(id) };
    }
    if (at.kind === "entry") {
      const e = ENTRIES.find((w) => w.id === at.id);
      if (!e || (p.entries.includes(e.id) && canStartIn(p, e.region))) return null;
      if (!canStartIn(p, e.region)) return { name: e.name, why: "道を知らない", how: [`<span class="how">${entryIcon(false)}${esc(regionOf(e.region).name)}</span>`, ...regionHow(e.region)] };
      return { name: e.name, why: "まだ見つけていない", how: [LEARN] };
    }
    const d = at.id as PoiId;
    if (departDepots(p).includes(d)) return null;
    const node = POIS[poiIndex(d)].name;
    return { name: `${node}の中継ボックス`, why: "未制圧", how: [`<span class="how">${coreIcon(SIDE.enemy)}${esc(node)}${ARROW}${coreIcon(SIDE.own)}</span>`] };
  }

  /** Shows a shut start beside the departure's map without choosing it; false (and nothing shown) for one that is open. */
  peek(at: LockedPick): boolean {
    if (!this.lockHint(at)) return false;
    this.peeked = at;
    return true;
  }

  /** Drops the shut start shown beside the map, so the chosen start shows again. */
  unpeek() {
    this.peeked = null;
  }

  /**
   * What the column beside the departure's map tells of why it will not go: the shut start shown
   * (`peek()`), or a depot chosen whose allowance the loadout is past, with how the allowance grows.
   */
  departHint(): (LockHint & { at: LockedPick }) | null {
    this.fixStart();
    if (this.peeked) {
      const h = this.lockHint(this.peeked);
      return h && { ...h, at: this.peeked };
    }
    const a = this.allowance();
    if (!a || !this.from || fitsStart(this.profile, this.startLoad(), this.from)) return null;
    // Take less, or send more home through this depot to raise its level: a coin and the credits still to send.
    const grow = a.next === null ? "" : `<span class="how">${depotIcon()}${ARROW}<b class="cash">${coinIcon()}${yen(a.next)}</b>${ARROW}${upIcon()}Lv</span>`;
    return { name: `${POIS[poiIndex(this.from)].name}の中継ボックス`, why: `持ち込み枠 ${a.cost} / ${a.budget}`, how: [`<span class="how">${stashIcon()}−</span>`, ...(grow ? [grow] : [])], at: { kind: "depot", id: this.from } };
  }

  /** Chooses where the next raid starts: a way in known, or a depot that opens a start. False when it may not start there. */
  choose(kind: StartPoint["kind"], id: string): boolean {
    const p = this.profile;
    this.peeked = null;
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

  /**
   * Lead-incursion from the signal station: take the shelves' kit and hand the Launch to main.
   * Same 出撃 verb as the gate — no departure map (the target is already picked).
   */
  private launchIncursion(plan: IncursionPlan) {
    if (!this.startIncursion) return;
    const taken = takeKit(this.profile, this.startLoad(), null);
    if (!taken) return;
    const { profile, kit } = taken;
    this.set({ ...profile, region: plan.region, entry: plan.entry });
    this.load = emptyLoadout();
    this.close(false);
    this.startIncursion({
      kit,
      region: plan.region,
      seed: this.profile.seed,
      entry: plan.entry,
      incursion: plan,
    });
  }

  /** Wires main's raid start for a lead-incursion from the signal station. */
  setIncursionStart(fn: (go: Launch) => void) {
    this.startIncursion = fn;
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
    // 来る遠征 sits on the map table's mark — same place the tip sends the player to fortify.
    const incoming = incomingFor(p).length;
    const map = [incoming ? `来る遠征 ${incoming}` : "", coming ? `明日 ${eventName(coming)}` : "", p.hideout.radio ? "無線" : ""].filter(Boolean).join("・");
    // The signal station wants looking at while news of the other islands is unread, or while
    // someone else's delivery still sits at a 中継ボックス.
    const aid = namedAid(p).length;
    const unread = this.news.length + this.expNews.length + aid;
    const signal = !this.newsSeen && unread ? `知らせ ${unread}` : aid ? `届け ${aid}` : "";
    // The board wants looking at while it has contracts and none is taken.
    const open = !takenContract(p) && !takenStory(p) && p.board.contracts.length ? `依頼 ${p.board.contracts.length}` : "";
    return { map, quests: [ready ? `納品 ${ready}` : "", open].filter(Boolean).join("・"), stash: "", shop: "", workshop: buildable ? `▲ ${buildable}` : "", factory: canBuildFactory(p) ? `▲ Lv${p.factory + 1}` : "", signal };
  }

  private item(item: Item, body: { act?: string; arg?: string; on?: boolean; right?: string; count?: number; need?: Needs; warn?: boolean }) {
    const n = body.count && body.count > 1 ? ` <i>× ${body.count}</i>` : "";
    const needed = !!body.need && item.t === "valuable" && body.need.hideout[item.kind] + body.need.factory[item.kind] > 0;
    // A valuable still needed, pressed once to sell, turns red: the second press sells it.
    const text = itemNote(item, body.need);
    const note = text ? `<small class="${body.warn ? "warn" : needed ? "need" : ""}">${text}</small>` : "";
    const inner = `<span style="color:${itemColor(item)}">${starterMark(item)}${esc(itemName(item))}${n}</span>${note}${body.right ?? ""}`;
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
    return `${where} <b style="color:${RARITY_CSS[kind.rarity]}">${esc(kind.label)}</b>　レイダー ${clockIcon()}${Math.round(raidClock(strengthFor(ownNodes(islandHolds(this.profile))), raidThreat(this.profile)).raiders / 60)} 分`;
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
      { key: "every", mark: clockIcon(), label: "間隔", n: FACTORY.levels[lv].every, show: (n: number, was?: number) => `${num(n, was)}<small>秒</small>` },
      { key: "max", mark: flagIcon(), label: "部隊", n: FACTORY.levels[lv].max + extra, show: num },
      { key: "turrets", mark: turretIcon(SIDE.own), label: "砲台", n: FACTORY.levels[lv].turrets, show: num, hideZero: true },
    ];
  }

  /** What a level takes from the stash: each valuable (have / need, and where it is found) and the credits, set apart from its effect. */
  private cost(items: [ValuableKind, number][], cash: number, button: string): string {
    const p = this.profile;
    const have = (k: ValuableKind) => p.stash.filter((i) => i.t === "valuable" && i.kind === k).length;
    const rows = items
      .map(([k, n]) => `<div class="req${have(k) >= n ? " ok" : ""}"><span style="color:${RARITY_CSS[VALUABLES[k].rarity]}">${esc(VALUABLES[k].label)}</span><b>${Math.min(have(k), n)} / ${n}</b>${have(k) >= n ? "" : `<small class="srcs">${whereLine(k)}</small>`}</div>`)
      .join("");
    const credits = `<div class="req${p.cash >= cash ? " ok" : ""}"><span>クレジット</span><b>${yen(Math.min(p.cash, cash))} / ${yen(cash)}</b></div>`;
    return `<div class="mod-cost"><small>必要</small>${rows}${credits}${button}</div>`;
  }

  /**
   * The factory's panel, in three parts read top to bottom: what it makes now (the squad, how often,
   * how many squads at once, the turrets, and what the nodes held add), the next level (what grows,
   * lit, then what it takes and the button that builds it), and the ladder of every level, folded
   * away until asked for.
   */
  private factoryPanel(): string {
    const p = this.profile;
    const lv = p.factory;
    const next = nextFactory(p);
    const levels = FACTORY.levels.map((_, n) => this.factoryGauges(n));
    const pips = Array.from({ length: FACTORY_TOP }, (_, n) => `<i class="${n < lv ? "on" : ""}"></i>`).join("");
    const u = unlocked(p);
    const arms = Math.max(PLATE.robots, u.shop);
    // What it makes now, each with its word.
    const now = `<div class="fac-now">${levels[lv].map((g) => gaugeHtml(g)).join("")}</div>`;
    // What the nodes held add: their squads' flags and the gun's colour (the trader's shelf), under the node's core.
    const nodes = `<div class="from-nodes"><small>拠点から</small>${coreIcon(SIDE.own)}${u.squad ? `<span>${flagIcon()}<b>+${u.squad}</b></span>` : ""}<span style="color:${RARITY_CSS[arms]}">${gunIcon()}<small>${RARITY.names[arms]}</small></span></div>`;
    const gain = next ? `<div class="gain-row">${upIcon()}<b>Lv${lv + 1}</b>${deltaHtml(levels[lv], levels[lv + 1])}</div>` : `<div class="gain-row max"><b>MAX</b></div>`;
    const cost = next ? this.cost(next.items, next.cash, `<button type="button" data-act="factory" ${canBuildFactory(p) ? "" : "disabled"}>Lv${lv + 1} を建てる</button>`) : "";
    const fold = `<button type="button" class="fac-fold${this.factoryLadder ? " open" : ""}" data-act="factory-ladder">${this.factoryLadder ? "段の一覧を閉じる" : "全部の段を見る"}</button>`;
    return (
      `<div class="mod open up-card factory-card"><div class="mod-head"><strong>${factoryIcon()}工場</strong><span class="pips">${pips}</span><b>Lv${lv}${next ? "" : " MAX"}</b></div>` +
      `<div class="mod-body"><h4 class="fac-sub">今の工場</h4>${now}${nodes}` +
      `<h4 class="fac-sub">${next ? "次の段" : "最後の段"}</h4>${gain}${cost}` +
      `${fold}${this.factoryLadder ? ladder(levels, lv) : ""}</div></div>` +
      // Always a path to the signal station: expeditions live there, not on this panel.
      `<p class="factory-away"><button type="button" class="factory-signal" data-act="open-signal">${flagIcon()}遠征・島の番号へ` +
      (squadsAway(p) ? `<span>守り <b>${homeSquads(p)}</b>　遠征 <b>${squadsAway(p)}</b></span>` : `<span>信号所</span>`) +
      `</button></p>`
    );
  }

  /**
   * The signal station's panel (信号所): everything to do with the other islands, apart from the
   * factory. The expeditions' section (the neighbours, sending, the expeditions out, this island's
   * code) draws itself (`#hub-exped`); under it the island's news, each attack with its 仕返し.
   */
  private signalPanel(): string {
    return `<div id="hub-exped">${this.exped.html()}</div><div id="hub-signal-news">${this.signalNews()}</div>`;
  }

  /** The island's news on the signal station, each attack with its 仕返し; nothing with none. */
  private signalNews(): string {
    const word = { held: "保持", wiped: "全滅", lost: "奪還された" } as const;
    const exp = this.expNews.length
      ? `<h3 class="hub-sub">遠征の知らせ</h3><ul class="island-news signal-news exp-news">${this.expNews.map((n) => `<li title="${esc(expLine(n))}"><b class="who">${esc(n.name)}</b><em class="${n.t === "held" ? "own" : "foe"}">${word[n.t]}</em>${esc(NODES[nodeIndex(n.node)]?.name ?? n.node)}</li>`).join("")}</ul>`
      : "";
    // Who left stock at a 中継ボックス (CoC-style help): names the player already sees, no new noun.
    const aid = namedAid(this.profile);
    const help = aid.length
      ? `<h3 class="hub-sub">島の守り</h3><ul class="island-news signal-news">${aid
          .slice(0, 4)
          .map((q) => `<li><b class="who">${esc(q.from.name)}</b>が${esc(POIS[poiIndex(q.poi)].name)}の中継ボックスへ届けた</li>`)
          .join("")}</ul>`
      : "";
    return exp + help + (this.news.length ? `<h3 class="hub-sub">島の知らせ</h3><ul class="island-news signal-news">${this.news.map((n) => this.newsMarks(n)).join("")}</ul>` : "");
  }

  /** Lines of 遠征の知らせ for the results screen (same words as the signal station). */
  expeditionNews(): string[] {
    const word = { held: "保持", wiped: "全滅", lost: "奪還された" } as const;
    return this.expNews.map((n) => `${n.name} ${word[n.t]} ${NODES[nodeIndex(n.node)]?.name ?? n.node}`);
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
    return [...(r.cash ? [`<b class="cash">${coinIcon()}${yen(r.cash)}</b>`] : []), ...rewardList({ reward: r }).map(([i, n]) => `<span class="chip" style="--c:${itemColor(i)}">${esc(itemName(i))}${n > 1 ? `<b>${n}</b>` : ""}</span>`)].join("");
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
    // What the raid would play at and pay: the round's 強度, and the taken contract's on top of it.
    const n = on ? raidThreat(this.profile) : roundThreat(this.profile);
    const pay = this.reward({ ...c.reward, cash: threatPay(c.reward.cash, n) });
    return (
      `<div class="quest contract${on ? " taken" : ""}${dim ? " dim" : ""}" data-type="${c.t}"><i class="pin"></i><div><strong><em>${CONTRACT_NAME[c.t]}</em>${on ? `<i class="taken-tag">${checkIcon()}${n ? `強度 ${n}` : ""}</i>` : ""}</strong><span>${contractMarks(c)}</span>` +
      `<small class="pay"><span>${where}</span>${pay}</small>${on ? this.strengthRow(c) : ""}</div>${btn}</div>`
    );
  }

  /**
   * The 強度 of the taken contract: a button for each the raid can play at, from the round's own
   * (`roundThreat()`) to `THREAT.max`, then what the chosen one gives (the reward, mod parts) and
   * what it asks (the robots' numbers). With no contract taken, a raid plays at the round's.
   */
  private strengthRow(c: Contract): string {
    const p = this.profile;
    // The buttons name the 強度 the raid plays at, from the round's own up; the profile keeps what is chosen over it.
    const base = roundThreat(p);
    const n = raidThreat(p);
    const t = THREAT.levels[n];
    const pct = (k: number) => `${Math.round((1 - k) * 100)}%`;
    const buttons = Array.from({ length: THREAT.max + 1 - base }, (_, k) => k + base).map((i) => `<button type="button" data-act="strength" data-arg="${c.id}:${i - base}"${i === n ? ' class="on"' : ""}>${i ? i : "通常"}</button>`).join("");
    // What the chosen 強度 gives (gold) and asks (red), each a name and a number; nothing at 通常.
    const each = (items: [string, string][]) => items.map(([k, v]) => `<span>${k}<b>${v}</b></span>`).join("");
    const gives = n ? `${upIcon()}${each([["報酬", `×${t.reward}`], ["改造パーツ", `×${t.mods}`]])}` : "";
    const asks = n ? each([["増援", `−${pct(t.reinforce)}`], ["レイダー", `−${pct(t.raiders)}`], ["装甲板", `+${Math.round(t.plate * 100)}%`], ["射程", `×${t.range}`]]) : "";
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
        return `<details class="told prose"${id === p.records.at(-1) ? " open" : ""}><summary>${esc(t.title)}<small>${esc(storyWhere(t))}</small></summary>${t.told.map((l) => `<p>${esc(l)}</p>`).join("")}</details>`;
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
    const incoming = incomingFor(p);
    const taken = takenContract(p);
    const holds = islandHolds(p);
    const front = frontNodes(holds);
    // The map says who holds what (blue and red, as the row above) and where the front is (its rings):
    // beside it stand only what the map cannot say, the nodes to strike next by name and the day's income.
    const key =
      // Another player only once one holds a node of the island: a colour the row above does not explain.
      (holds.some((h) => rivalOf(h) !== null) ? `<li><i style="background:${RIVAL_CSS}"></i>他のプレイヤー</li>` : "") +
      `<li class="front"><i></i><b class="names">${NODES.filter((_, i) => front[i]).map((n) => `<span>${esc(n.name)}</span>`).join("") || "—"}</b></li>` +
      (frontIncome(p) ? `<li class="income"><b class="cash">${coinIcon()}${frontIncome(p).toLocaleString()}</b></li>` : "");
    return (
      `<div class="hub-island"><canvas id="hub-island-map"></canvas><div class="hub-island-side">` +
      `<div class="hub-day"><small>島の日</small><b>${p.day}</b><small>日目</small></div>` +
      `<div class="hub-row">${nodeRow(holds)}</div>` +
      // A quiet day and a quiet tomorrow say nothing.
      (p.events[0] || p.events[1] ? `<ul class="events"><li><small>今日</small>${eventRow(p.events[0])}</li><li><small>明日</small>${eventRow(p.events[1])}</li></ul>` : "") +
      `<ul class="hold-key">${key}</ul>` +
      (incoming.length ? `<small>来る遠征</small><ul class="island-news incoming">${incoming.map((e) => `<li title="${esc(incomingLine(e, Date.now()))}">${incomingMarks(e, Date.now())}</li>`).join("")}</ul>` : "") +
      (taken ? `<small>依頼　${esc(regionOf(contractRegion(taken)).name)}<i class="taken-line"></i></small><p class="hub-taken"><em>${CONTRACT_NAME[taken.t]}</em>${contractMarks(taken)}</p>` : "") +
      `</div></div>`
    );
  }

  /** Draws the map table's island into its canvas, framed on the region the last start was in. */
  private drawIsland() {
    const canvas = document.getElementById("hub-island-map") as HTMLCanvasElement | null;
    if (!canvas) return;
    const map = new IslandMap(canvas);
    canvas.addEventListener("click", (e) => map.pick(e.clientX, e.clientY) && sfx.locked());
    map.known = this.profile.entries;
    map.region = this.from ? poiRegion(this.from).id : this.region;
    const c = takenContract(this.profile);
    map.contract = c && contractMark(c);
    map.neighbours = neighboursFor(this.profile);
    map.draw(islandScene({ ...this.profile, incoming: incomingFor(this.profile) }));
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
    const slot = (label: string, n: number | null | undefined, extra = "") => `<div class="slot"><small>${label}</small><span${n == null ? ' class="none"' : ` style="color:${itemColor(p.stash[n])}"`}>${n == null ? "なし" : starterMark(p.stash[n]) + esc(itemName(p.stash[n]))}</span>${extra}</div>`;
    const stat = (n: number | undefined) => {
      const i = n === undefined ? undefined : p.stash[n];
      return i?.t === "weapon" ? `<small class="stat">${weaponStats(i.kind, i.rarity)}</small>` : "";
    };
    const heal = (k: (typeof HEALS)[number]) =>
      `<div class="slot count"><small>${HEAL_SPECS[k].label}</small><button type="button" data-act="heal-" data-arg="${k}">−</button><b>${this.load.heals[k] + issued[k]}</b><button type="button" data-act="heal+" data-arg="${k}">+</button><small>倉庫 ${this.load.heals[k]}/${healCount(p, k)}${issued[k] ? `<span class="issued">${issueIcon()}${issued[k]}</span>` : ""}</small></div>`;
    const keys = this.load.keys.map((n) => esc(itemName(p.stash[n]))).join("・");
    const weapons = slot("武器 1", this.load.weapons[0], stat(this.load.weapons[0])) + slot("武器 2", this.load.weapons[1], stat(this.load.weapons[1]));
    // A row stands only for what the stash can fill: no armour, no key and no heal of a kind means no row for it.
    const has = (t: Item["t"]) => p.stash.some((i) => i.t === t);
    return (
      this.depotSlot() +
      weapons +
      (has("armor") ? slot("アーマー", this.load.armor) : "") +
      (has("key") ? `<div class="slot"><small>鍵</small><span${keys ? ` style="color:${RARITY_CSS[3]}"` : ' class="none"'}>${keys || "なし"}</span></div>` : "") +
      HEALS.filter((k) => healCount(p, k) + issued[k] > 0)
        .map(heal)
        .join("") +
      // The pouch: the slots of valuables a wipe leaves the player.
      `<div class="slot pouch"><small>${pouchIcon()}ポーチ</small><span class="boxes">${Array.from({ length: pouchSlots(p.hideout) }, () => `<i class="seg pouch" style="--n:1"></i>`).join("")}</span><b>${pouchSlots(p.hideout)}</b></div>`
    );
  }

  /** The contract taken, in a line of marks: its kind, its ask, and its 強度 when raised. */
  private askLine(c: Contract): string {
    const n = raidThreat(this.profile);
    return `<em class="ask-kind">${CONTRACT_NAME[c.t]}</em>${contractMarks(c)}${n ? `<em class="ask-threat">強度 ${n}</em>` : ""}`;
  }

  /**
   * The next raid's kit as marks, for the departure, the camp's card and the shelves' foot: each
   * weapon's name in its rarity's colour, armour's mark with its level (dim with none), each heal's
   * mark with its count, the keys' mark with theirs.
   */
  kitMarks(): string {
    const p = this.profile;
    const l = this.load;
    const issued = issuedHeals(p);
    const weapons = l.weapons.map((n) => p.stash[n]).map((i) => (i.t === "weapon" ? `<b style="color:${itemColor(i)}">${WEAPONS[i.kind].name}</b>` : ""));
    const worn = l.armor === null ? null : p.stash[l.armor];
    const armor = worn?.t === "armor" ? `<span style="color:${itemColor(worn)}">${armorIcon()}<b>${worn.tier}</b></span>` : `<span class="none">${armorIcon()}</span>`;
    const heals = HEALS.filter((k) => l.heals[k] + issued[k] > 0).map((k) => `<span>${healIcon(HEAL_SPECS[k].shield)}<b>${l.heals[k] + issued[k]}</b></span>`);
    const keys = l.keys.length ? `<span style="color:${RARITY_CSS[3]}">${keyIcon()}<b>${l.keys.length}</b></span>` : "";
    return `<span class="kit">${[...weapons, armor, ...heals, keys].join("")}</span>`;
  }

  /**
   * What the departure lists beside its map: the kit taken out of the stash, the objective, and
   * warnings worth a second look. The start is the map's (`startPoints()`).
   */
  departure(): { rows: [string, string][]; warn: string[] } {
    this.fixStart();
    const p = this.profile;
    const c = takenContract(p);
    const story = takenStory(p) ? currentStory(p.records) : null;
    const front = this.frontPick();
    const goal = c ? this.askLine(c) : esc(story ? `記録：${story.title}` : front ? `前線：${front.name}` : "探索");
    // Each row's value is HTML: marks, and names escaped here.
    const rows: [string, string][] = [
      ["装備", this.kitMarks()],
      ["目的", goal],
    ];
    // Other players' expeditions sent at this island land in this raid: where, whose, and what to do about it.
    const incoming = incomingFor(p);
    if (incoming.length) rows.push(["来る遠征", `${incoming.map((e) => incomingMarks(e, Date.now())).join("")}<em class="ask-kind">核で固める</em>`]);
    const warn: string[] = [];

    return { rows, warn };
  }

  /**
   * The front node the camp recommends today: the front node nearest the camp, which is where the
   * objective card points a raid with no contract out of the gate (`objectiveSteps()`). Null with
   * no node on the front.
   */
  frontPick(): { name: string } | null {
    return frontPickFor(this.profile);
  }

  /**
   * One line for the camp tip and the results: the next place on the experience line
   * (出撃 → … → 拠点が育つ → 次の出撃). Existing station names only.
   */
  nextHand(): string {
    return nextHandFor(this.profile);
  }

  /**
   * The camp's 今日の作戦 card and its line of the day: the day and the row of the six nodes;
   * then the node to go for, the contract or story taken, and the kit.
   */
  today(): { head: string; row: string; plan: [string, string][] } {
    const p = this.profile;
    // From the second round on, the round is named beside the day.
    const head = `${p.day} 日目${p.cycle ? `・${p.cycle + 1} 周目` : ""}`;
    const final = finaleOpen(p);
    const pick = this.frontPick();
    const c = takenContract(p);
    const story = takenStory(p) ? currentStory(p.records) : null;
    // Each value is HTML: marks, and names escaped here.
    const rival = rivalFrontPick(p);
    const plan: [string, string][] = [
      // The pad open to the decisive battle comes before any node. A rival on the front is why to sortie.
      final ? ["決戦", esc(POIS.find((o) => o.boss)!.name)] : ["攻める拠点", rival ? `${flagIcon(SIDE.rival)}${esc(rival.name)}を取り返す` : pick ? esc(pick.name) : "—"],
      ["依頼", c ? this.askLine(c) : esc(story ? `記録：${story.title}` : "—")],
      ["装備", this.kitMarks()],
    ];
    // Other players' expeditions land in the next raid: same marks as the departure / map table.
    const incoming = incomingFor(p);
    if (incoming.length) plan.push(["来る遠征", `${incoming.map((e) => incomingMarks(e, Date.now())).join("")}<em class="ask-kind">核で固める</em>`]);
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
    $("hub-side-title").textContent = shop ? "売り物" : st === "quests" ? "依頼と記録" : st === "workshop" ? "隠れ家" : st === "factory" ? "自軍のロボット" : st === "signal" ? "海の向こうの島" : st === "map" ? "島" : "持っていく物";
    if (st === "factory") $("hub-side").innerHTML = this.factoryPanel();
    else if (st === "signal") $("hub-side").innerHTML = this.signalPanel();
    else if (st === "workshop") {
      $("hub-side").innerHTML =
        MODULES.map((m) => this.moduleCard(m)).join("") + this.routes();
      $("hub-side").querySelector(".mod.open .mod-body")?.parentElement?.scrollIntoView({ block: "nearest" });
    } else if (shop) {
      const full = stashUsed(p) >= stashCap(p.hideout);
      // Every buy is shut while the stash is full: the shelf says so, and what makes room.
      const room = full ? `<p class="lock-note">${lockIcon()}倉庫が満杯：売るか、作業場で${esc(HIDEOUT.storage.name)}を上げる</p>` : "";
      $("hub-side").innerHTML = room + shelfTiers(p) + wares(p)
        .map((item, n) => `<button type="button" class="item" data-act="buy" data-arg="${n}" ${p.cash < buyPrice(item) || full ? "disabled" : ""}><span style="color:${itemColor(item)}">${esc(itemName(item))}</span><small${item.t === "valuable" && want[item.kind] > 0 ? ' class="need"' : ""}>${item.t === "valuable" ? (want[item.kind] > 0 ? `${upIcon()}${want[item.kind]}` : need.hideout[item.kind] + need.factory[item.kind] > 0 ? checkIcon() : "") : itemNote(item)}</small><b>${yen(buyPrice(item))}</b></button>`)
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
      $("hub-foot-note").innerHTML = this.kitMarks();
    }
  }
}
