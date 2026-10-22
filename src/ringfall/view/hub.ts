import { ALLY, FACTORY, HEALS as HEAL_SPECS, HIDEOUT, MOD_KINDS, RARITY, THREAT, TOOLS, VALUABLES, WEAPONS, type EnemyKind, type ModuleId, type Rarity, type ValuableKind, type WeaponKind } from "../sim/config";
import { boostFor, freeKit, raidClock, strengthFor, type Kit } from "../sim/state";
import { CAMP, entryOf, NODES, POIS, poiIndex, poiRegion, REGIONS, regionOf, ROUTES, type EntryId, type PoiId, type RegionId, type StationId } from "../sim/map";
import { build, buildFactory, buildState, buy, buyPrice, canBuild, canBuildFactory, factoryNeeded, nextFactory, canStartIn, deliver, deliverable, depotAllowance, emptyLoadout, FIRST_ENTRY, fitsStart, itemCost, HEALS, healCount, healRoom, keyName, kitPicks, lentHeals, loadoutCost, price, raidThreat, recallLoadout, sell, sellPrice, setThreat, startsIn, STORY_TAKEN, takenStory, threatPay, take, takeKit, takenContract, wanted, wares, type Item, type Loadout, type Profile } from "../meta/profile";
import { CONTRACT_NAME, contractMark, contractRegion, contractText, type Contract, type Reward } from "../meta/contracts";
import { currentStory, STORIES, storyOf, storyWhere } from "../meta/story";
import { maxLevel, MODULES, nextLevel, pouchSlots, sources, stashCap, stillNeeded, type Source } from "../meta/hideout";
import { need, offered, type Quest, type RewardItem } from "../meta/quests";
import { saveProfile } from "../meta/storage";
import { departDepots, eventName, frontIncome, islandHolds, unfreeable } from "../meta/island";
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

/** `need`: valuables the hideout and the factory still ask for; `have`: how many of this one the stash holds. */
function itemNote(i: Item, need?: Needs, have = 1): string {
  switch (i.t) {
    case "weapon":
      return `${WEAPONS[i.kind].label}・${weaponStats(i.kind, i.rarity)}`;
    case "valuable": {
      const h = need?.hideout[i.kind] ?? 0;
      const f = need?.factory[i.kind] ?? 0;
      if (!h && !f) return "売却用";
      const where = h && f ? "隠れ家と工場" : h ? "隠れ家" : "工場";
      const n = h + f;
      if (have > n) return `${where}で ${n} 個使う・残りは売れる`;
      return have < n ? `${where}で使う・あと ${n - have} 個要る` : `${where}で使う`;
    }
    case "armor":
      return "シールド強化";
    case "key":
      return "保管庫を開ける";
    case "tool":
      // One that reaches the stash is spent on a closed route, so one kept there has none left to open.
      return "道はもう開いている・売れる";
    case "heal":
      return HEAL_SPECS[i.kind].shield ? "シールド回復" : "体力回復";
  }
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
  return out.sort((a, b) => order[a.item.t] - order[b.item.t]);
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

const $ = (id: string) => document.getElementById(id)!;
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
  const say = (s: Source) =>
    s.from === "robot" ? (s.share >= 1 ? `${s.where}${s.region ? `（${s.region}）` : ""}が落とす` : `${s.where}が ${Math.round(s.share * 100)}% で落とす`) : `${s.where}${s.region ? `（${s.region}）` : ""} ${Math.round(s.share * 100)}%`;
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
  /** The loadout for the next raid: the last one picked again while the stash holds it (`recallLoadout()`). With no weapon, the lent kit's. */
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

  constructor(
    public profile: Profile,
    private closed: () => void,
  ) {
    this.region = profile.region;
    this.entry = this.entryIn(profile.region);
    this.load = recallLoadout(profile);
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

  /** Whether the next raid goes out with the lent kit's weapons: no stash weapon picked. */
  get lent(): boolean {
    return !this.load.weapons.length;
  }

  /** Sets a profile whose stash changed under the loadout, keeping the loadout's picks by what they are. */
  private keepPicks(next: Profile) {
    const picks = kitPicks(this.profile, this.load);
    this.set(next);
    this.load = recallLoadout({ ...next, lastKit: picks });
  }

  /** Drops loadout picks the stash no longer has at those indices. */
  private fit(l: Loadout): Loadout {
    const st = this.profile.stash;
    const heals = { ...l.heals };
    const weapons = l.weapons.filter((n) => st[n]?.t === "weapon");
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
    } else if (act === "region" && canStartIn(this.profile, regionOf(arg as RegionId).id)) {
      this.region = regionOf(arg as RegionId).id;
      this.entry = this.entryIn(this.region);
      this.from = null;
      // A region open only through a depot starts at its first depot on.
      if (!this.entry) this.from = startsIn(this.profile, this.region).depots[0] ?? null;
      sfx.click();
    } else if (act === "entry" && startsIn(this.profile, this.region).entries.includes(arg as EntryId)) {
      this.entry = arg as EntryId;
      this.from = null;
      sfx.click();
    } else if (act === "from" && departDepots(this.profile).includes(arg as PoiId)) {
      this.from = arg as PoiId;
      this.region = poiRegion(this.from).id;
      // The entry follows the depot's region, so a later start from an entry is one of its own.
      this.entry = this.entryIn(this.region);
      sfx.click();
    } else if (act === "strength") {
      // A 強度 is chosen for one contract: choosing it takes that contract.
      const [id, n] = arg.split(":");
      const taken = takenContract(this.profile)?.id === id ? this.profile : take(this.profile, id);
      this.set(setThreat(taken, Number(n)));
      sfx.click();
    } else if (act === "lent") {
      // The lent kit's weapons: no stash weapon. Armour, keys and heals picked still go.
      this.load = { ...this.load, weapons: [] };
      sfx.click();
    } else if (act === "own") {
      // The stash's best two weapons, the rarest first.
      const best = this.profile.stash
        .map((i, n) => ({ i, n }))
        .filter((x) => x.i.t === "weapon")
        .sort((a, b) => (b.i.t === "weapon" ? b.i.rarity : 0) - (a.i.t === "weapon" ? a.i.rarity : 0) || price(b.i) - price(a.i))
        .slice(0, 2)
        .map((x) => x.n);
      this.load = this.fit({ ...this.load, weapons: best });
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
      this.region = "reservoir";
      this.from = null;
    }
    if (!this.entry || !startsIn(p, this.region).entries.includes(this.entry)) this.entry = this.entryIn(this.region);
    if (!this.entry && !this.from) this.from = startsIn(p, this.region).depots[0] ?? null;
  }

  /** The loadout the next raid takes: with no weapon picked, the lent kit's weapons with the armour, keys and heals picked. */
  private startLoad(): Loadout {
    return this.load;
  }

  /** The truck's depot's allowance and what the loadout costs of it, or null when it drives to a way in. */
  private allowance() {
    if (!this.from) return null;
    const a = depotAllowance(this.profile, this.from);
    return { ...a, cost: loadoutCost(this.profile, this.startLoad()) };
  }

  /** Where the truck drives to, as a name. */
  rideTo(): string {
    this.fixStart();
    return this.from ? `${POIS[poiIndex(this.from)].name}の中継ボックス` : entryOf(this.entry ?? this.profile.entry).name;
  }

  /** Why the truck cannot start now (the loadout over the depot's allowance), or "" when it can. */
  rideRefused(): string {
    this.fixStart();
    const a = this.allowance();
    return a && !fitsStart(this.profile, this.startLoad(), this.from) ? `持ち込み枠を超えている（${a.cost} / ${a.budget}）` : "";
  }

  /**
   * Takes the loadout out of the stash for a raid. `walk`: out of the gate, which is the
   * reservoir's first way in, with no allowance to keep to; else by truck to the start the map
   * table chose. Null when the truck cannot start (`rideRefused()`).
   */
  launch(walk: boolean): Launch | null {
    this.fixStart();
    const from = walk ? null : this.from;
    const region = walk ? "reservoir" : this.region;
    const entry = walk ? FIRST_ENTRY : (this.entry ?? this.profile.entry);
    const taken = takeKit(this.profile, this.startLoad(), from);
    if (!taken) return null;
    const { profile, kit } = taken;
    // The start the profile remembers is the truck's, kept for the next visit to the map table.
    this.set({ ...profile, region: this.region, entry: this.entry ?? profile.entry });
    this.load = emptyLoadout();
    return { kit, region, seed: this.profile.seed, from: from ?? undefined, entry };
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
    const map = [coming ? `明日：${eventName(coming)}` : "", p.hideout.radio ? "知らせ" : ""].filter(Boolean).join("・");
    // The board wants looking at while it has contracts and none is taken.
    const open = !takenContract(p) && !takenStory(p) && p.board.contracts.length ? `依頼 ${p.board.contracts.length}` : "";
    // The shelves say when the next raid would go out with the lent kit's weapons though the stash holds some.
    const kit = this.lent && p.stash.some((i) => i.t === "weapon") ? "装備：貸出" : "";
    return { map, quests: [ready ? `納品 ${ready}` : "", open].filter(Boolean).join("・"), stash: kit, shop: "", workshop: buildable ? `作れる ${buildable}` : "", factory: canBuildFactory(p) ? `Lv${p.factory + 1} にできる` : "" };
  }

  private item(item: Item, body: { act?: string; arg?: string; on?: boolean; right?: string; count?: number; need?: Needs; warn?: boolean }) {
    const n = body.count && body.count > 1 ? ` <i>× ${body.count}</i>` : "";
    const needed = !!body.need && item.t === "valuable" && body.need.hideout[item.kind] + body.need.factory[item.kind] > 0;
    const note = body.warn ? `<small class="warn">隠れ家か工場でまだ使う。もう一度押すと売る</small>` : `<small${needed ? ' class="need"' : ""}>${itemNote(item, body.need, body.count)}</small>`;
    const inner = `<span style="color:${color(item)}">${esc(itemName(item))}${n}</span>${note}${body.right ?? ""}`;
    return body.act ? `<button type="button" class="item${body.on ? " on" : ""}" data-act="${body.act}" data-arg="${body.arg}">${inner}</button>` : `<div class="item">${inner}</div>`;
  }

  /** The radio's report on the next raid into the chosen region, or null without a radio. */
  private intel(): string | null {
    const lv = this.profile.hideout.radio;
    if (!lv) return null;
    const b = boostFor(this.profile.seed, this.region);
    const where = esc(POIS[b.poi].name);
    if (lv === 1) return `${where}の箱に珍しい物が多い`;
    return `${where}の箱に${esc(VALUABLES[b.kind].label)}が多い。レイダーはレイドの始めからおよそ ${Math.round(raidClock(strengthFor(enemyNodes(islandHolds(this.profile))), raidThreat(this.profile)).raiders / 60)} 分後に降りる`;
  }

  /** What the factory at level `lv` makes, in a line: how often, how many at once, of what, and its turrets. */
  private factoryLine(lv: number): string {
    const kinds = FACTORY.kinds[lv].map((k) => ENEMY_NAME[k]).join("・");
    const turrets = FACTORY.turrets[lv] ? `。自分の拠点に砲台 ${FACTORY.turrets[lv]} 基` : "";
    return `${FACTORY.every[lv]} 秒ごとに 1 部隊（${kinds}）。同時に ${FACTORY.max[lv]} 部隊まで出す${turrets}`;
  }

  /**
   * The factory's panel: its level and what it makes, its next level (what it takes and does,
   * and the button that builds it), and how its squads fight the day's battle.
   */
  private factoryPanel(): string {
    const p = this.profile;
    const lv = p.factory;
    const next = nextFactory(p);
    const pips = Array.from({ length: FACTORY.levels.length }, (_, n) => `<i class="${n < lv ? "on" : ""}"></i>`).join("");
    let card = `<p class="factory-top">工場は最大まで強くなった。</p>`;
    if (next) {
      const have = (k: ValuableKind) => p.stash.filter((i) => i.t === "valuable" && i.kind === k).length;
      const rows = next.items
        .map(([k, n]) => `<div class="req${have(k) >= n ? " ok" : ""}"><span style="color:${RARITY_CSS[VALUABLES[k].rarity]}">${esc(VALUABLES[k].label)}</span><b>${Math.min(have(k), n)} / ${n}</b><small>${esc(whereLine(k))}</small></div>`)
        .join("");
      const cash = `<div class="req${p.cash >= next.cash ? " ok" : ""}"><span>クレジット</span><b>${yen(Math.min(p.cash, next.cash))} / ${yen(next.cash)}</b></div>`;
      card = `<div class="mod open factory-next"><div class="mod-head"><strong>Lv${lv + 1}</strong><small>${esc(next.does)}</small></div><div class="mod-body">${rows}${cash}<button type="button" data-act="factory" ${canBuildFactory(p) ? "" : "disabled"}>Lv${lv + 1} にする</button></div></div>`;
    }
    return (
      `<div class="factory-head"><small>工場</small><span class="pips">${pips}</span><b>Lv${lv}</b><p>${esc(this.factoryLine(lv))}</p></div>` +
      card +
      `<p class="hint">工場の部隊は、自分の拠点と野営地から出て道を歩き、前線の拠点の核を取りに行く。自分の拠点に敵の部隊が来ると、その守りに出る。青いロボットが自軍で、プレイヤーとリオは撃たない。</p>`
    );
  }

  /** The routes a tool opens: open or closed, and for a closed one, the tool and where it lies. */
  private routes(): string {
    const p = this.profile;
    const rows = ROUTES.map((r) => {
      const open = p.routes.includes(r.id);
      const tool = TOOLS[r.tool];
      const how = open ? r.note : `${tool.label}で開く。${tool.label}は${POIS[poiIndex(tool.from)].name}の補給箱にある。持ち帰るか中継ボックスから送れば開く`;
      return `<div class="quest route${open ? " open" : ""}"><div><strong>${esc(r.name)}</strong><span>${esc(how)}</span>${open ? "" : `<small>${esc(r.note)}</small>`}</div><b>${open ? "開通" : "閉鎖"}</b></div>`;
    });
    return `<h3 class="hub-sub">道</h3>${rows.join("")}`;
  }

  /** A hideout module: its level, its next level's effect, and when opened, what it takes and where that is found. */
  private moduleCard(m: ModuleId) {
    const p = this.profile;
    const spec = HIDEOUT[m];
    const lv = p.hideout[m];
    const next = nextLevel(p.hideout, m);
    const pips = Array.from({ length: maxLevel(m) }, (_, n) => `<i class="${n < lv ? "on" : ""}"></i>`).join("");
    const state = buildState(p, m);
    const open = this.module === m;
    let body = "";
    if (open && next) {
      const have = (k: ValuableKind) => p.stash.filter((i) => i.t === "valuable" && i.kind === k).length;
      const rows = next.items
        .map(([k, n]) => {
          const ok = have(k) >= n;
          return `<div class="req${ok ? " ok" : ""}"><span style="color:${RARITY_CSS[VALUABLES[k].rarity]}">${esc(VALUABLES[k].label)}</span><b>${Math.min(have(k), n)} / ${n}</b><small>${esc(whereLine(k))}</small></div>`;
        })
        .join("");
      const cash = `<div class="req${p.cash >= next.cash ? " ok" : ""}"><span>クレジット</span><b>${yen(Math.min(p.cash, next.cash))} / ${yen(next.cash)}</b></div>`;
      body = `<div class="mod-body">${rows}${cash}<button type="button" data-act="build" data-arg="${m}" ${canBuild(p, m) ? "" : "disabled"}>${lv ? `Lv${lv + 1} にする` : "作る"}</button></div>`;
    }
    return (
      `<div class="mod${open ? " open" : ""}"><button type="button" class="mod-head" data-act="mod" data-arg="${m}">` +
      `<strong>${esc(spec.name)}</strong><span class="pips">${pips}</span><b class="${state === "作れる" ? "go" : ""}">${state}</b>` +
      `<small>${esc(next ? `Lv${lv + 1}：${next.does}` : spec.note)}</small></button>${body}</div>`
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
    const btn = on ? `<button type="button" class="untake" data-act="take" data-arg="">取り消す</button>` : `<button type="button" data-act="take" data-arg="${c.id}">${taken || takenStory(this.profile) ? "こちらに替える" : "受ける"}</button>`;
    const where = esc(regionOf(contractRegion(c)).name);
    const n = on ? this.profile.threat : 0;
    const pay = this.reward({ ...c.reward, cash: threatPay(c.reward.cash, n) });
    return (
      `<div class="quest contract${on ? " taken" : ""}" data-type="${c.t}"><div><strong><em>${CONTRACT_NAME[c.t]}</em>${on ? `<i class="taken-tag">受けている${n ? `・強度 ${n}` : ""}</i>` : ""}</strong><span>${esc(contractText(c))}</span>` +
      `<small>${where}・報酬：${pay}${on ? "" : `（強度を上げると最大 ${THREAT.levels[THREAT.max].reward} 倍）`}</small>${on ? this.strengthRow(c) : ""}</div>${btn}</div>`
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
    const gives = n ? `得るもの：報酬 ${t.reward} 倍・改造パーツが ${t.mods} 倍出る` : "強度を上げるほど報酬と改造パーツが増える";
    const asks = n ? `払うもの：増援が ${pct(t.reinforce)}・レイダーが ${pct(t.raiders)} 早い・装甲板 +${Math.round(t.plate * 100)}%・撃ち返しが ${t.range} 倍遠くまで届く` : "通常は敵の持つ拠点の数のとおりの島";
    const best = POIS.filter((o) => (p.freedAt[o.id] ?? 0) > 0).map((o) => `${o.name} ${p.freedAt[o.id]}`);
    return (
      `<div class="strength"><small>強度</small><div class="row">${buttons}</div><p class="gives">${esc(gives)}</p><p class="asks">${esc(asks)}</p>` +
      `<p class="sub">${best.length ? `取った最高の強度：${esc(best.join("・"))}・` : ""}改造パーツは ${p.known.length} / ${MOD_KINDS.length} 種類を知っている</p></div>`
    );
  }

  /** The story section: the record under way, then what the records home have told, the latest first. */
  private storyPanel(): string {
    const p = this.profile;
    const now = currentStory(p.records);
    const on = takenStory(p);
    const btn = on ? `<button type="button" class="untake" data-act="take" data-arg="">取り消す</button>` : `<button type="button" data-act="take" data-arg="${STORY_TAKEN}">${takenContract(p) ? "こちらに替える" : "目的にする"}</button>`;
    const cur = now
      ? `<div class="quest story${on ? " taken" : ""}"><div><strong>${esc(now.title)}<small class="story-n">${STORIES.indexOf(now) + 1} / ${STORIES.length}</small>${on ? `<i class="taken-tag">目的にしている</i>` : ""}</strong><span>${esc(now.ask)}</span><small>${esc(storyWhere(now))}（バッグ 1 枠・売れない）・報酬：${yen(now.cash)} クレジット。記録はいつでも島にあり、目的にすると行き先の光が記録を指す</small></div>${btn}</div>`
      : `<p class="story-done">記録はすべて集まった。島は変わらず動いている。</p>`;
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
    } else state = `<b>${need(g) > 1 ? `${got} / ${need(g)}` : "未達成"}</b>`;
    return `<div class="quest"><div><strong>${esc(q.title)}</strong><span>${esc(q.text)}</span><small>報酬：${reward}</small></div>${state}</div>`;
  }

  /** The truck's depot allowance, as a slot: the depot's level, what the loadout uses of it, and the way to the next level. */
  private depotSlot(): string {
    const allow = this.allowance();
    if (!allow) return "";
    return `<div class="slot depot${allow.cost > allow.budget ? " over" : ""}"><small>持ち込み枠</small><span>中継ボックス Lv${allow.level}<b>${allow.cost} / ${allow.budget}</b></span><small>${
      allow.cost > allow.budget ? `枠を ${allow.cost - allow.budget} 超えている。この装備では車両でこの中継ボックスへ出られない` : allow.next === null ? "最大レベル" : `Lv${allow.level + 1} まで、あと ${yen(allow.next)} クレジット分を送る`
    }</small></div>`;
  }

  /**
   * The map table's island: the map with each POI coloured by who holds it, the day, the row of
   * the six nodes, the key to the colours, the front and the day's income.
   */
  private islandPanel(): string {
    const p = this.profile;
    const taken = takenContract(p);
    const count = (h: "held" | "freed") => POIS.filter((o) => !unfreeable(o.id) && p.poiState[o.id].state === h).length;
    const holds = islandHolds(p);
    const front = frontNodes(holds);
    const key =
      (["freed", "held"] as const).map((h) => `<li><i style="background:${HOLD_CSS[h]}"></i>${h === "freed" ? "自分" : "敵"}<b>${count(h)}</b></li>`).join("") +
      `<li><i class="titan" style="background:${TITAN_CSS}"></i>タイタン</li>` +
      `<li class="front"><i></i>前線<b>${NODES.filter((_, i) => front[i]).map((n) => esc(n.name)).join("・") || "なし"}</b></li>` +
      `<li class="income">毎日の収入<b>${frontIncome(p).toLocaleString()} クレジット</b></li>`;
    return (
      `<div class="hub-island"><canvas id="hub-island-map"></canvas><div class="hub-island-side">` +
      `<div class="hub-day"><small>島の日</small><b>${p.day}</b><small>日目</small></div>` +
      `<div class="hub-row">${nodeRow(holds)}</div>` +
      `<small>島の出来事</small><ul class="events"><li><small>今日</small>${eventRow(p.events[0], "今日は何も起きない")}</li><li><small>明日</small>${eventRow(p.events[1], "明日は何も起きない")}</li></ul>` +
      `<ul class="hold-key">${key}</ul>` +
      (taken ? `<small>受けた依頼（${esc(regionOf(contractRegion(taken)).name)}・地図の金の破線）</small><p class="hub-taken">${CONTRACT_NAME[taken.t]}：${esc(contractText(taken))}</p>` : "") +
      `</div></div>`
    );
  }

  /** Draws the map table's island into its canvas, framed on the region the truck is set for. */
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

  /** The map table: the truck's start (the regions, the chosen region's ways in, the depots on), its allowance, the radio's report. */
  private startsPanel(): string {
    const p = this.profile;
    const allow = this.allowance();
    const on = (yes: boolean) => (yes ? ' class="on"' : "");
    const known = startsIn(p, this.region).entries;
    const unseen = regionOf(this.region).entries.length - known.length;
    const locked = REGIONS.filter((r) => !canStartIn(p, r.id));
    const intel = this.intel();
    const line = this.from && allow
      ? `${esc(POIS[poiIndex(this.from)].name)}の中継ボックス（Lv${allow.level}・持ち込み枠 ${allow.budget}）の前から、${ALLY.name}と歩いて始める`
      : `${esc(entryOf(this.entry ?? p.entry).name)}から${ALLY.name}と歩いて始める。${esc(regionOf(this.region).note)}${unseen ? `。ほかの入口 ${unseen} つは、歩いて見つけて生きて帰ると選べる` : ""}`;
    return (
      (intel ? `<div class="slot intel"><small>無線</small><span>${intel}</span></div>` : "") +
      `<div class="hub-region" id="hub-region"><small>地域</small><div class="row">` +
      REGIONS.map((r) =>
        canStartIn(p, r.id)
          ? `<button type="button" data-act="region" data-arg="${r.id}"${on(!this.from && r.id === this.region)}>${esc(r.name)}</button>`
          : `<button type="button" class="locked" disabled title="${esc(r.locked ?? "")}">${esc(r.name)}（未踏）</button>`,
      ).join("") +
      `</div>` +
      (this.from ? "" : `<small>入口</small><div class="row entries">${known.map((e) => `<button type="button" class="entry${e === this.entry ? " on" : ""}" data-act="entry" data-arg="${e}">${esc(entryOf(e).name)}</button>`).join("")}</div>`) +
      (departDepots(p).length ? `<small>中継ボックス</small><div class="row">${departDepots(p).map((d) => `<button type="button" class="depot${this.from === d ? " on" : ""}" data-act="from" data-arg="${d}">${esc(POIS[poiIndex(d)].name)}（${esc(poiRegion(d).name)}）</button>`).join("")}</div>` : "") +
      `</div>` +
      `<p class="hub-lock" id="hub-lock"${locked.length ? "" : " hidden"}>${esc(locked.map((r) => `${r.name}：${r.locked ?? ""}`).join("　"))}</p>` +
      `<div class="slot ride"><small>車両の行き先</small><span>${line}</span></div>` +
      this.depotSlot() +
      `<p class="hint">門から歩いて出ると、${esc(entryOf(FIRST_ENTRY).name)}からレイドが始まる。ここで選んだ出撃地点へは、門の脇の車両で送ってもらう。</p>`
    );
  }

  /**
   * The shelves: the weapons (the lent kit's or the stash's, chosen by two buttons, with their
   * numbers), the armour, keys and heals to take (the lent heals always come too), and the truck's
   * allowance when it drives to a depot.
   */
  private kitPanel(): string {
    const p = this.profile;
    const lent = lentHeals(p);
    const slot = (label: string, n: number | null | undefined, extra = "") => `<div class="slot"><small>${label}</small><span${n == null ? ' class="none"' : ` style="color:${color(p.stash[n])}"`}>${n == null ? "なし" : esc(itemName(p.stash[n]))}</span>${extra}</div>`;
    const stat = (n: number | undefined) => {
      const i = n === undefined ? undefined : p.stash[n];
      return i?.t === "weapon" ? `<small class="stat">${esc(weaponStats(i.kind, i.rarity))}</small>` : "";
    };
    const heal = (k: (typeof HEALS)[number]) =>
      `<div class="slot count"><small>${HEAL_SPECS[k].label}</small><button type="button" data-act="heal-" data-arg="${k}">−</button><b>${this.load.heals[k] + lent[k]}</b><button type="button" data-act="heal+" data-arg="${k}">+</button><small>倉庫 ${this.load.heals[k]}/${healCount(p, k)}${lent[k] ? `・貸出 ${lent[k]}` : ""}</small></div>`;
    const keys = this.load.keys.map((n) => esc(itemName(p.stash[n]))).join("・");
    const owns = p.stash.some((i) => i.t === "weapon");
    const choice =
      `<div class="slot choice"><small>武器</small><div class="row"><button type="button" data-act="lent"${this.lent ? ' class="on"' : ""}>貸出装備</button><button type="button" data-act="own"${this.lent ? "" : ' class="on"'}${owns ? "" : " disabled"}>倉庫の武器</button></div></div>`;
    const weapons = this.lent
      ? `<div class="slot lent"><small>武器</small><span>${freeKit()
          .weapons.map((w) => `${WEAPONS[w.kind].name} ${RARITY.names[w.rarity]}`)
          .join("・")}（貸出）</span><small class="stat">${esc(owns ? "左の倉庫で武器を押すと、その武器で出る" : "倉庫に武器がない")}</small></div>`
      : slot("武器 1", this.load.weapons[0], stat(this.load.weapons[0])) + slot("武器 2", this.load.weapons[1], stat(this.load.weapons[1]));
    return (
      this.depotSlot() +
      choice +
      weapons +
      slot("アーマー", this.load.armor) +
      `<div class="slot"><small>鍵</small><span${keys ? ` style="color:${RARITY_CSS[3]}"` : ' class="none"'}>${keys || "なし"}</span></div>` +
      HEALS.map(heal).join("") +
      `<p class="hint">倒れると、持ち込んだ物と回収品は失う。ポーチ（${pouchSlots(p.hideout)} 枠）に入る分の回収品だけは残る。貸出の回復${p.hideout.infirmary ? "（医務室の分を含む）" : ""}は、どの装備でも付く。選んだ装備は次のレイドでも、倉庫にある限り選ばれたまま。${
        this.from ? "車両で中継ボックスへ出るときは、武器・アーマー・鍵が持ち込み枠を使う。貸出装備と回復は枠を使わない。門から歩いて出るなら枠はない。" : ""
      }</p>`
    );
  }

  /** The next raid's kit in words, for the departure's check and the camp's card: weapons, armour, heals, keys. */
  kitLines(): { weapons: string; armor: string; heals: string; keys: string } {
    const p = this.profile;
    const l = this.load;
    const lent = lentHeals(p);
    const weapons = this.lent ? `${freeKit().weapons.map((w) => WEAPONS[w.kind].name).join("・")}（貸出）` : l.weapons.map((n) => itemName(p.stash[n])).join("・");
    const armor = l.armor === null ? "なし" : itemName(p.stash[l.armor]);
    const heals = HEALS.filter((k) => l.heals[k] + lent[k] > 0)
      .map((k) => `${HEAL_SPECS[k].label} ${l.heals[k] + lent[k]}`)
      .join("・");
    const keys = l.keys.map((n) => itemName(p.stash[n])).join("・") || "なし";
    return { weapons, armor, heals: heals || "なし", keys };
  }

  /**
   * What the departure's check lists for a raid out of the gate (`walk`) or by truck: where it
   * starts, the kit taken out of the stash, the objective, and warnings worth a second look.
   */
  departure(walk: boolean): { rows: [string, string][]; warn: string[] } {
    this.fixStart();
    const p = this.profile;
    const k = this.kitLines();
    const c = takenContract(p);
    const story = takenStory(p) ? currentStory(p.records) : null;
    const front = this.frontPick();
    const goal = c ? `${CONTRACT_NAME[c.t]}：${contractText(c)}${p.threat ? `（強度 ${p.threat}）` : ""}` : story ? `記録：${story.title}` : `前線：${front?.name ?? "島を探索する"}（依頼なし・強度 通常）`;
    const rows: [string, string][] = [
      ["出撃地点", walk ? `${entryOf(FIRST_ENTRY).name}（門から歩いて）` : this.rideTo()],
      ["武器", k.weapons],
      ["アーマー", k.armor],
      ["回復", k.heals],
      ["鍵", k.keys],
      ["目的", goal],
    ];
    const warn: string[] = [];
    if (this.lent && p.stash.some((i) => i.t === "weapon")) warn.push("倉庫に武器があるが、貸出装備で出る");
    if (!walk && this.rideRefused()) warn.push(this.rideRefused());
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
      ["依頼", c ? `${CONTRACT_NAME[c.t]}：${contractText(c)}${p.threat ? `（強度 ${p.threat}）` : ""}` : story ? `記録：${story.title}` : "なし（依頼板で受ける。受けないと前線の拠点が目的になる）"],
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
    $("hub-stash-count").textContent = `${p.stash.length} / ${stashCap(p.hideout)}`;
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
            const cost = kit && this.from && (item.t === "weapon" || item.t === "armor" || item.t === "key") ? `枠 ${itemCost(item)}` : "";
            const right = shop ? `<b>売る ${yen(sellPrice(item))}</b>` : on ? `<b>持っていく${cost ? `・${cost}` : ""}</b>` : cost ? `<b class="cost">${cost}</b>` : item.t === "valuable" ? `<b>${yen(price(item))}</b>` : "";
            const act = shop ? "sell" : kit && (item.t === "weapon" || item.t === "armor" || item.t === "key") ? "pick" : undefined;
            return this.item(item, { act, arg: index.join(","), on, right, count: index.length, need, warn: shop && this.armed === index.join(",") });
          })
          .join("") || `<p class="empty">倉庫は空。商人で買うか、貸出装備で出て持ち帰る。</p>`;
    }
    $("hub-side-title").textContent = shop ? "売り物" : st === "quests" ? "依頼と記録" : st === "workshop" ? "隠れ家" : st === "factory" ? "自軍のロボット" : st === "map" ? "島と出撃地点" : "持っていく物";
    if (st === "factory") $("hub-side").innerHTML = this.factoryPanel();
    else if (st === "workshop") {
      $("hub-side").innerHTML =
        MODULES.map((m) => this.moduleCard(m)).join("") + `<p class="hint">回収品とクレジットで設備を作る。足りない物は、押すと出やすい場所が出る。上の段にはデータコアや小型炉心が要る。</p>` + this.routes();
      $("hub-side").querySelector(".mod.open .mod-body")?.parentElement?.scrollIntoView({ block: "nearest" });
    } else if (shop) {
      const full = p.stash.length >= stashCap(p.hideout);
      $("hub-side").innerHTML = wares(p)
        .map((item, n) => `<button type="button" class="item" data-act="buy" data-arg="${n}" ${p.cash < buyPrice(item) || full ? "disabled" : ""}><span style="color:${color(item)}">${esc(itemName(item))}</span><small>${item.t === "valuable" ? (want[item.kind] > 0 ? `隠れ家と工場の材料・あと ${want[item.kind]} 個要る` : need.hideout[item.kind] + need.factory[item.kind] > 0 ? "隠れ家と工場の材料・足りている" : "売却用") : itemNote(item)}</small><b>${yen(buyPrice(item))}</b></button>`)
        .join("");
    } else if (st === "quests") {
      const open = offered(p.quests);
      const intro = open.filter((q) => q.intro);
      const craft = open.filter((q) => !q.intro);
      const taken = takenContract(p);
      $("hub-side").innerHTML =
        (intro.length ? `<h3 class="hub-sub first">入門の依頼</h3>${intro.map((q) => this.quest(q)).join("")}` : "") +
        `<h3 class="hub-sub${intro.length ? "" : " first"}">今日の依頼<small>${p.day} 日目</small></h3>` +
        p.board.contracts.map((c) => this.contractCard(c, taken)).join("") +
        `<p class="hint">次のレイドに依頼か記録を 1 つだけ受けて出られる。受けた依頼には強度を選べ、強度を上げるほど敵が強く、報酬と改造パーツが増える。受けなければ強度は通常で、目的は前線の拠点になる。済ませなかった依頼は、その日が終わると板から消え、翌日は新しい依頼が並ぶ。迎撃は倒れても数える。報酬は倉庫に届く。</p>` +
        (craft.length ? `<h3 class="hub-sub">商人の依頼</h3>${craft.map((q) => this.quest(q)).join("")}` : "") +
        this.storyPanel();
    } else if (st === "map") {
      // The island goes under the region and start buttons, which stay in sight on a phone's short screen.
      const starts = this.startsPanel();
      const at = starts.indexOf('<p class="hub-lock"');
      $("hub-side").innerHTML = starts.slice(0, at) + this.islandPanel() + starts.slice(at);
      this.drawIsland();
    }
    else $("hub-side").innerHTML = this.kitPanel();
    // The shelves' footer: what the next raid takes out, in a line.
    $("hub-foot").hidden = !kit;
    if (kit) {
      const k = this.kitLines();
      $("hub-foot-note").textContent = `出撃する装備：${k.weapons}・アーマー ${k.armor}・回復 ${k.heals}${this.from ? `。車両で${this.rideTo()}へ出るときは持ち込み枠を使う` : ""}`;
    }
  }
}
