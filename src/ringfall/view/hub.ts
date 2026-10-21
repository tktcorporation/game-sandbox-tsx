import { ALLY, HEALS as HEAL_SPECS, HIDEOUT, RAIDERS, RARITY, TOOLS, VALUABLES, WEAPONS, type ModuleId, type ValuableKind } from "../sim/config";
import { boostFor, freeKit, type Kit } from "../sim/state";
import { entryOf, POIS, poiIndex, poiRegion, REGIONS, regionOf, ROUTES, type EntryId, type PoiId, type RegionId, type StationId } from "../sim/map";
import { build, buildState, buy, buyPrice, canBuild, canStartIn, deliver, deliverable, depotAllowance, emptyLoadout, FIRST_ENTRY, fitsStart, itemCost, HEALS, healCount, healRoom, keyName, lentHeals, loadoutCost, price, sell, sellPrice, startsIn, takeKit, wanted, wares, type Item, type Loadout, type Profile } from "../meta/profile";
import { craftDone, maxLevel, MODULES, nextLevel, pouchSlots, sources, stashCap, stillNeeded, type Source } from "../meta/hideout";
import { need, offered, type Quest, type RewardItem } from "../meta/quests";
import { saveProfile } from "../meta/storage";
import { islandNotes, noteText, thinTomorrow, unfreeable } from "../meta/island";
import { HOLD_NAME } from "../sim/island";
import { HOLD_CSS, IslandMap, islandScene, TITAN_CSS } from "./map";
import { sfx } from "./sfx";

const RARITY_CSS = ["var(--r0)", "var(--r1)", "var(--r2)", "var(--r3)"];

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

/** `need`: valuables the hideout's unbuilt levels still ask for; `have`: how many of this one the stash holds. */
function itemNote(i: Item, need?: Record<ValuableKind, number>, have = 1): string {
  switch (i.t) {
    case "weapon":
      return WEAPONS[i.kind].label;
    case "valuable":
      if (!need || !need[i.kind]) return "売却用";
      if (have > need[i.kind]) return `隠れ家で ${need[i.kind]} 個使う・残りは売れる`;
      return have < need[i.kind] ? `隠れ家で使う・あと ${need[i.kind] - have} 個要る` : "隠れ家で使う";
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

/** A quest's reward items, alike ones counted together. */
export function rewardList(q: Quest): [RewardItem, number][] {
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
};

/** A raid the camp hands over to start: the kit taken, where, and from which start. */
export interface Launch {
  kit: Kit;
  region: RegionId;
  seed: number;
  from?: PoiId;
  entry: EntryId;
}

/** Seconds as hours and minutes. */
const clock = (sec: number) => {
  const m = Math.round(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)} 時間 ${m % 60} 分` : `${m} 分`;
};

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
  private load: Loadout = emptyLoadout();
  /** Whether the next raid goes out with the lent kit, whatever the loadout holds. */
  lent = false;
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
    private ended: () => void,
  ) {
    this.region = profile.region;
    this.entry = this.entryIn(profile.region);
    this.fixStart();
    $("hub").addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
      if (el && !(el as HTMLButtonElement).disabled) this.act(el.dataset.act!, el.dataset.arg ?? "");
    });
    $("ending-back").addEventListener("click", () => {
      sfx.click();
      $("ending").hidden = true;
      this.ended();
    });
  }

  /** The ending: the escape craft's last stage is built. The game goes on after it. */
  showEnding() {
    const e = this.profile.escaped;
    if (!e) return;
    this.close(false);
    $("ending-stats").innerHTML = [
      ["出撃", `${e.raids} 回`],
      ["生還", `${e.extracted} 回`],
      ["行方不明", `${e.raids - e.extracted} 回`],
      ["島で過ごした時間", clock(e.time)],
    ]
      .map(([k, v]) => `<div><small>${k}</small><b>${v}</b></div>`)
      .join("");
    $("ending").hidden = false;
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

  /** Takes a profile settled after a raid: the loadout's picks are dropped, the start kept where the profile allows it. */
  reload(p: Profile) {
    this.profile = p;
    this.load = emptyLoadout();
    this.fixStart();
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
        const before = this.profile;
        // Building takes stash entries: drop the loadout's picks rather than chase their indices.
        this.load = emptyLoadout();
        if (!nextLevel(next.hideout, m)) this.module = null;
        this.set(next);
        sfx.deliver();
        if (next.escaped && !before.escaped) return this.showEnding();
      }
    } else if (act === "ending") {
      sfx.click();
      return this.showEnding();
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
    } else if (act === "from" && this.profile.depots.includes(arg as PoiId)) {
      this.from = arg as PoiId;
      this.region = poiRegion(this.from).id;
      // The entry follows the depot's region, so a later start from an entry is one of its own.
      this.entry = this.entryIn(this.region);
      sfx.click();
    } else if (act === "lent") {
      this.lent = !this.lent;
      sfx.click();
    } else if (act === "pick") {
      sfx.click();
      const n = pick[0];
      const it = this.profile.stash[n];
      const toggle = (ns: number[]) => (ns.includes(n) ? ns.filter((x) => x !== n) : [...ns, n]);
      if (it?.t === "weapon") {
        const w = this.load.weapons;
        this.load.weapons = w.includes(n) ? w.filter((x) => x !== n) : w.length < 2 ? [...w, n] : [w[1], n];
        // Picking a weapon means going out with it.
        if (this.load.weapons.length) this.lent = false;
      } else if (it?.t === "armor") this.load.armor = this.load.armor === n ? null : n;
      else if (it?.t === "key") this.load.keys = toggle(this.load.keys);
      // Taking or leaving a weapon decides whether the free kit's heals are lent.
      this.load = this.fit(this.load);
    } else if (act === "heal+" || act === "heal-") {
      sfx.click();
      const k = arg as keyof Loadout["heals"];
      this.load.heals[k] = Math.max(0, Math.min(healRoom(this.profile, this.load, k), this.load.heals[k] + (act === "heal+" ? 1 : -1)));
    } else if (act === "sell") {
      // Sell the last of a group, so the loadout's picks before it keep their indices.
      const n = pick[pick.length - 1];
      const it = this.profile.stash[n];
      // A valuable the hideout still needs is sold only on a second press.
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
    if (this.from && !p.depots.includes(this.from)) this.from = null;
    if (!canStartIn(p, this.region)) {
      this.region = "reservoir";
      this.from = null;
    }
    if (!this.entry || !startsIn(p, this.region).entries.includes(this.entry)) this.entry = this.entryIn(this.region);
    if (!this.entry && !this.from) this.from = startsIn(p, this.region).depots[0] ?? null;
  }

  /** The loadout the next raid takes: with the lent kit, or with no weapon picked, only the heals and keys picked. */
  private startLoad(): Loadout {
    return this.lent || !this.load.weapons.length ? { ...emptyLoadout(), heals: this.load.heals, keys: this.load.keys } : this.load;
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
    this.lent = false;
    return { kit, region, seed: this.profile.seed, from: from ?? undefined, entry };
  }

  /** What each station has to act on, as its mark's text ("" for none): quests to hand in, modules to build, the radio's report. */
  marks(): Record<StationId, string> {
    const p = this.profile;
    const ready = offered(p.quests).filter((q) => deliverable(p, q)).length;
    const buildable = MODULES.filter((m) => canBuild(p, m)).length;
    // A POI that goes thin unless the next raid comes into it is the map table's most pressing news.
    const fading = thinTomorrow(p).map((id) => POIS[poiIndex(id)].name);
    const map = [fading.length ? `あす手薄：${fading.join("・")}` : "", p.hideout.radio ? "知らせ" : ""].filter(Boolean).join("・");
    return { map, quests: ready ? `納品 ${ready}` : "", stash: "", shop: "", workshop: buildable ? `作れる ${buildable}` : "" };
  }

  private item(item: Item, body: { act?: string; arg?: string; on?: boolean; right?: string; count?: number; need?: Record<ValuableKind, number>; warn?: boolean }) {
    const n = body.count && body.count > 1 ? ` <i>× ${body.count}</i>` : "";
    const note = body.warn ? `<small class="warn">隠れ家でまだ使う。もう一度押すと売る</small>` : `<small${body.need && item.t === "valuable" && body.need[item.kind] ? ' class="need"' : ""}>${itemNote(item, body.need, body.count)}</small>`;
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
    return `${where}の箱に${esc(VALUABLES[b.kind].label)}が多い。レイダーはレイドの始めからおよそ ${Math.round(RAIDERS.at / 60)} 分後に降りる`;
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
      const needs = next.needs.map(([o, n]) => `<div class="req${p.hideout[o] >= n ? " ok" : ""}"><span>${esc(HIDEOUT[o].name)} Lv${n}</span><b>${p.hideout[o] >= n ? "済" : `いま Lv${p.hideout[o]}`}</b></div>`).join("");
      body = `<div class="mod-body">${rows}${cash}${needs}<button type="button" data-act="build" data-arg="${m}" ${canBuild(p, m) ? "" : "disabled"}>${lv ? `Lv${lv + 1} にする` : "作る"}</button></div>`;
    }
    return (
      `<div class="mod${open ? " open" : ""}${m === "craft" ? " craft" : ""}"><button type="button" class="mod-head" data-act="mod" data-arg="${m}">` +
      `<strong>${esc(spec.name)}</strong><span class="pips">${pips}</span><b class="${state === "作れる" ? "go" : ""}">${state}</b>` +
      `<small>${esc(next ? `Lv${lv + 1}：${next.does}` : spec.note)}</small></button>${body}</div>`
    );
  }

  private quest(q: Quest) {
    const p = this.profile;
    const got = p.quests.progress[q.id] ?? 0;
    const g = q.goal;
    const reward = [`${yen(q.reward.cash)} クレジット`, ...rewardList(q).map(([i, n]) => `<span style="color:${color(i)}">${esc(itemName(i))}${n > 1 ? ` × ${n}` : ""}</span>`)].join("・");
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
   * The map table's island: the map with each POI coloured by who holds it, the day, the key to
   * the colours and 明日の島, what the island does next unless the player acts.
   */
  private islandPanel(): string {
    const p = this.profile;
    const notes = islandNotes(p);
    const count = (h: "held" | "thin" | "freed") => POIS.filter((o) => !unfreeable(o.id) && p.poiState[o.id].state === h).length;
    const key = (["held", "thin", "freed"] as const).map((h) => `<li><i style="background:${HOLD_CSS[h]}"></i>${HOLD_NAME[h]}<b>${count(h)}</b></li>`).join("") + `<li><i class="titan" style="background:${TITAN_CSS}"></i>タイタン</li>`;
    const lines = notes.length ? notes.map((n) => `<li class="${n.t}${n.t === "fading" && n.days <= 1 ? " soon" : ""}">${esc(noteText(n))}</li>`).join("") : `<li>島は変わらない。支配の拠点の守備隊を片付けて生きて帰ると、その拠点は解放になる</li>`;
    return (
      `<div class="hub-island"><canvas id="hub-island-map"></canvas><div class="hub-island-side">` +
      `<div class="hub-day"><small>島の日</small><b>${p.day}</b><small>日目</small></div>` +
      `<ul class="hold-key">${key}</ul>` +
      `<small>明日の島</small><ul class="tomorrow">${lines}</ul>` +
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
      (p.depots.length ? `<small>中継ボックス</small><div class="row">${p.depots.map((d) => `<button type="button" class="depot${this.from === d ? " on" : ""}" data-act="from" data-arg="${d}">${esc(POIS[poiIndex(d)].name)}（${esc(poiRegion(d).name)}）</button>`).join("")}</div>` : "") +
      `</div>` +
      `<p class="hub-lock" id="hub-lock"${locked.length ? "" : " hidden"}>${esc(locked.map((r) => `${r.name}：${r.locked ?? ""}`).join("　"))}</p>` +
      `<div class="slot ride"><small>車両の行き先</small><span>${line}</span></div>` +
      this.depotSlot() +
      `<p class="hint">門から歩いて出ると、${esc(entryOf(FIRST_ENTRY).name)}からレイドが始まる。ここで選んだ出撃地点へは、門の脇の車両で送ってもらう。</p>`
    );
  }

  /** The shelves: the loadout's slots, the heals to take, the truck's allowance when it drives to a depot. */
  private kitPanel(): string {
    const p = this.profile;
    const slot = (label: string, n: number | null | undefined) => `<div class="slot"><small>${label}</small><span${n == null ? ' class="none"' : ` style="color:${color(p.stash[n])}"`}>${n == null ? "なし" : esc(itemName(p.stash[n]))}</span></div>`;
    const lentKit = this.lent || !this.load.weapons.length;
    const lent = lentHeals(p, lentKit);
    const heal = (k: (typeof HEALS)[number]) =>
      `<div class="slot count"><small>${HEAL_SPECS[k].label}</small><button type="button" data-act="heal-" data-arg="${k}">−</button><b>${this.load.heals[k]}</b><button type="button" data-act="heal+" data-arg="${k}">+</button><small>倉庫 ${healCount(p, k)}${lent[k] ? `・貸出 ${lent[k]}` : ""}</small></div>`;
    const keys = this.load.keys.map((n) => esc(itemName(p.stash[n]))).join("・");
    const weapons = lentKit ? `<div class="slot lent"><small>武器</small><span>貸出装備（${freeKit().weapons.map((w) => WEAPONS[w.kind].name).join(" と ")}）</span></div>` : slot("武器 1", this.load.weapons[0]) + slot("武器 2", this.load.weapons[1]);
    return (
      this.depotSlot() +
      weapons +
      (lentKit ? "" : slot("アーマー", this.load.armor)) +
      `<div class="slot"><small>鍵</small><span${keys ? ` style="color:${RARITY_CSS[3]}"` : ' class="none"'}>${keys || "なし"}</span></div>` +
      HEALS.map(heal).join("") +
      `<p class="hint">倒れると、持ち込んだ物と回収品は失う。ポーチ（${pouchSlots(p.hideout)} 枠）に入る分の回収品だけは残る。${p.hideout.infirmary ? "医務室の回復は、どちらの装備にも貸し出される。" : ""}${
        this.from ? "車両で中継ボックスへ出るときは、武器・アーマー・鍵が持ち込み枠を使う。貸出装備と回復は枠を使わない。門から歩いて出るなら枠はない。" : ""
      }</p>`
    );
  }

  render() {
    const p = this.profile;
    const st = this.station;
    if (!st) return;
    const panel = PANELS[st];
    $("hub-title").textContent = panel.title;
    $("hub-cash").textContent = yen(p.cash);
    $("hub-record").textContent = `出撃 ${p.raids} ・ 生還 ${p.extracted} ・ ${craftDone(p.hideout) ? "脱出艇 完成" : `脱出艇 ${p.hideout.craft} / ${maxLevel("craft")}`}`;
    $("hub-stash-count").textContent = `${p.stash.length} / ${stashCap(p.hideout)}`;
    $("hub").dataset.station = st;
    $("hub-stash-col").hidden = !panel.stash;
    $("hub-cols").classList.toggle("one", !panel.stash);
    const want = wanted(p);
    const need = stillNeeded(p.hideout);
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
    $("hub-side-title").textContent = shop ? "売り物" : st === "quests" ? "商人の依頼" : st === "workshop" ? "隠れ家" : st === "map" ? "島と出撃地点" : "持っていく物";
    if (st === "workshop") {
      const done = p.escaped ? `<div class="escaped"><span>脱出艇は直った。いつでも島を出られる</span><button type="button" data-act="ending">エンディング</button></div>` : "";
      $("hub-side").innerHTML =
        done + MODULES.map((m) => this.moduleCard(m)).join("") + `<p class="hint">回収品とクレジットで設備を作る。足りない物は、押すと出やすい場所が出る。脱出艇を直せば島を出られる。</p>` + this.routes();
      $("hub-side").querySelector(".mod.open .mod-body")?.parentElement?.scrollIntoView({ block: "nearest" });
    } else if (shop) {
      const full = p.stash.length >= stashCap(p.hideout);
      $("hub-side").innerHTML = wares(p)
        .map((item, n) => `<button type="button" class="item" data-act="buy" data-arg="${n}" ${p.cash < buyPrice(item) || full ? "disabled" : ""}><span style="color:${color(item)}">${esc(itemName(item))}</span><small>${item.t === "valuable" ? (want[item.kind] > 0 ? `隠れ家の材料・あと ${want[item.kind]} 個要る` : "隠れ家の材料") : itemNote(item)}</small><b>${yen(buyPrice(item))}</b></button>`)
        .join("");
    } else if (st === "quests") {
      const open = offered(p.quests);
      $("hub-side").innerHTML =
        (open.map((q) => this.quest(q)).join("") || `<p class="empty">いまある依頼はすべて片付けた。</p>`) +
        `<p class="hint">倒した数・制圧・保管庫は倒れても数える。脱出の依頼は生還したときだけ。済んだ依頼の報酬は倉庫に届く。</p>`;
    } else if (st === "map") {
      // The island goes under the region and start buttons, which stay in sight on a phone's short screen.
      const starts = this.startsPanel();
      const at = starts.indexOf('<p class="hub-lock"');
      $("hub-side").innerHTML = starts.slice(0, at) + this.islandPanel() + starts.slice(at);
      this.drawIsland();
    }
    else $("hub-side").innerHTML = this.kitPanel();
    // The shelves' footer: whether the next raid goes out with the lent kit.
    $("hub-foot").hidden = !kit;
    const lentBtn = $("hub-free");
    lentBtn.classList.toggle("on", this.lent);
    lentBtn.setAttribute("aria-pressed", String(this.lent));
    $("hub-free-state").textContent = this.lent ? "オン" : "オフ";
    $("hub-foot-note").textContent = this.lent || !this.load.weapons.length ? "貸出装備で出る。武器を選ぶと、その装備で出る" : `選んだ装備で出る${this.from ? `。車両で${this.rideTo()}へ出るときは持ち込み枠を使う` : ""}`;
  }
}
