import { ALLY, HEALS as HEAL_SPECS, HIDEOUT, RAIDERS, RARITY, VALUABLES, WEAPONS, type ModuleId, type ValuableKind } from "../sim/config";
import { boostFor, type Kit } from "../sim/state";
import { POIS, poiIndex, poiRegion, REGIONS, regionOf, type PoiId, type RegionId } from "../sim/map";
import { build, buildState, buy, buyPrice, canBuild, deliver, deliverable, emptyLoadout, HEALS, healCount, healRoom, keyName, lentHeals, price, sell, sellPrice, shortfall, takeKit, wanted, wares, type Item, type Loadout, type Profile } from "../meta/profile";
import { craftDone, maxLevel, MODULES, nextLevel, pouchSlots, sources, stashCap, stillNeeded, type Source } from "../meta/hideout";
import { need, offered, type Quest, type RewardItem } from "../meta/quests";
import { saveProfile } from "../meta/storage";
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
    case "heal":
      return HEAL_SPECS[i.kind].shield ? "シールド回復" : "体力回復";
  }
}

const color = (i: Item | RewardItem) =>
  i.t === "weapon" ? RARITY_CSS[i.rarity] : i.t === "armor" ? RARITY_CSS[i.tier] : i.t === "valuable" ? RARITY_CSS[VALUABLES[i.kind].rarity] : i.t === "key" ? RARITY_CSS[3] : "var(--white)";

/** Weapons, armour and keys are listed one by one; heals and valuables are counted. */
function rows(stash: Item[]): { item: Item; index: number[] }[] {
  const out: { item: Item; index: number[] }[] = [];
  stash.forEach((item, n) => {
    if (item.t === "heal" || item.t === "valuable") {
      const row = out.find((r) => r.item.t === item.t && (r.item as { kind: string }).kind === item.kind);
      if (row) return void row.index.push(n);
    }
    out.push({ item, index: [n] });
  });
  const order = { weapon: 0, armor: 1, key: 2, heal: 3, valuable: 4 };
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

type Tab = "kit" | "shop" | "quests" | "hideout";

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
 * The base between raids: the stash, the loadout for the next raid, where it starts (a
 * region to drop into, or a depot already on), the trader and their quests. It changes only
 * the profile; the raid itself starts from the kit, the region and the depot it hands over.
 */
export class Hub {
  private tab: Tab = "kit";
  private load: Loadout = emptyLoadout();
  private region: RegionId;
  /** A depot to start from on the ground instead of dropping into `region`; null for the drop. */
  private from: PoiId | null = null;
  /** The hideout module opened to show what its next level takes. */
  private module: ModuleId | null = null;
  /** A stash row a module still needs, pressed once to sell: the next press sells it. */
  private armed = "";

  constructor(
    public profile: Profile,
    private deploy: (kit: Kit, region: RegionId, seed: number, from?: PoiId) => void,
  ) {
    this.region = profile.region;
    $("hub").addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
      if (el && !(el as HTMLButtonElement).disabled) this.act(el.dataset.act!, el.dataset.arg ?? "");
    });
    $("ending-back").addEventListener("click", () => {
      sfx.click();
      $("ending").hidden = true;
      this.open();
    });
  }

  /** The ending: the escape craft's last stage is built. The game goes on after it. */
  showEnding() {
    const e = this.profile.escaped;
    if (!e) return;
    $("hub").hidden = true;
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

  open() {
    this.load = this.fit(this.load);
    $("hub").hidden = false;
    this.render();
  }

  close() {
    $("hub").hidden = true;
  }

  private set(p: Profile) {
    this.profile = p;
    saveProfile(p);
    this.load = this.fit(this.load);
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
    if (act === "tab") {
      this.tab = arg as Tab;
      $("hub-side").scrollTop = 0;
      sfx.tab();
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
    } else if (act === "region") {
      this.region = regionOf(arg as RegionId).id;
      this.from = null;
      sfx.click();
    } else if (act === "from" && this.profile.depots.includes(arg as PoiId)) {
      this.from = arg as PoiId;
      this.region = poiRegion(this.from).id;
      sfx.click();
    }
    else if (act === "pick") {
      sfx.click();
      const n = pick[0];
      const it = this.profile.stash[n];
      const toggle = (ns: number[]) => (ns.includes(n) ? ns.filter((x) => x !== n) : [...ns, n]);
      if (it?.t === "weapon") {
        const w = this.load.weapons;
        this.load.weapons = w.includes(n) ? w.filter((x) => x !== n) : w.length < 2 ? [...w, n] : [w[1], n];
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
    } else if (act === "go" || act === "free") {
      const l = act === "free" ? { ...emptyLoadout(), heals: this.load.heals, keys: this.load.keys } : this.load;
      const { profile, kit } = takeKit(this.profile, l);
      this.set({ ...profile, region: this.region });
      this.load = emptyLoadout();
      this.close();
      sfx.deploy();
      const from = this.from ?? undefined;
      this.from = null;
      this.deploy(kit, this.region, this.profile.seed, from);
      return;
    } else if (act === "back") {
      sfx.click();
      this.close();
      $("title").hidden = false;
      return;
    }
    this.render();
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
    return `${where}の箱に${esc(VALUABLES[b.kind].label)}が多い。レイダーは着地のおよそ ${Math.round(RAIDERS.at / 60)} 分後に降りる`;
  }

  /** A hideout module: its level, its next level's effect, and when opened, what it takes and where that is found. */
  private moduleCard(m: ModuleId) {
    const p = this.profile;
    const spec = HIDEOUT[m];
    const lv = p.hideout[m];
    const next = nextLevel(p.hideout, m);
    const pips = Array.from({ length: maxLevel(m) }, (_, n) => `<i class="${n < lv ? "on" : ""}"></i>`).join("");
    const short = shortfall(p, m);
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

  render() {
    const p = this.profile;
    $("hub-cash").textContent = yen(p.cash);
    $("hub-record").textContent = `出撃 ${p.raids} ・ 生還 ${p.extracted} ・ ${craftDone(p.hideout) ? "脱出艇 完成" : `脱出艇 ${p.hideout.craft} / ${maxLevel("craft")}`}`;
    $("hub-stash-count").textContent = `${p.stash.length} / ${stashCap(p.hideout)}`;
    const want = wanted(p);
    const need = stillNeeded(p.hideout);
    document.querySelectorAll<HTMLElement>("#hub [data-act=tab]").forEach((b) => b.classList.toggle("on", b.dataset.arg === this.tab));
    const shop = this.tab === "shop";
    const used = new Set([...this.load.weapons, ...this.load.keys, ...(this.load.armor === null ? [] : [this.load.armor])]);
    $("hub-stash").innerHTML =
      rows(p.stash)
        .map(({ item, index }) => {
          const on = this.tab === "kit" && used.has(index[0]);
          const right = shop ? `<b>売る ${yen(sellPrice(item))}</b>` : on ? "<b>持っていく</b>" : item.t === "valuable" ? `<b>${yen(price(item))}</b>` : "";
          const act = shop ? "sell" : this.tab === "kit" && (item.t === "weapon" || item.t === "armor" || item.t === "key") ? "pick" : undefined;
          return this.item(item, { act, arg: index.join(","), on, right, count: index.length, need, warn: shop && this.armed === index.join(",") });
        })
        .join("") || `<p class="empty">倉庫は空。商人で買うか、貸出装備で降りて持ち帰る。</p>`;
    $("hub-side-title").textContent = shop ? "商人" : this.tab === "quests" ? "商人の依頼" : this.tab === "hideout" ? "隠れ家" : "持っていく物";
    if (this.tab === "hideout") {
      const done = p.escaped ? `<div class="escaped"><span>脱出艇は直った。いつでも島を出られる</span><button type="button" data-act="ending">エンディング</button></div>` : "";
      $("hub-side").innerHTML =
        done + MODULES.map((m) => this.moduleCard(m)).join("") + `<p class="hint">回収品とクレジットで設備を作る。足りない物は、押すと出やすい場所が出る。脱出艇を直せば島を出られる。</p>`;
      $("hub-side").querySelector(".mod.open .mod-body")?.parentElement?.scrollIntoView({ block: "nearest" });
    } else if (shop) {
      const full = p.stash.length >= stashCap(p.hideout);
      $("hub-side").innerHTML = wares(p)
        .map((item, n) => `<button type="button" class="item" data-act="buy" data-arg="${n}" ${p.cash < buyPrice(item) || full ? "disabled" : ""}><span style="color:${color(item)}">${esc(itemName(item))}</span><small>${item.t === "valuable" ? (want[item.kind] > 0 ? `隠れ家の材料・あと ${want[item.kind]} 個要る` : "隠れ家の材料") : itemNote(item)}</small><b>${yen(buyPrice(item))}</b></button>`)
        .join("");
    } else if (this.tab === "quests") {
      const open = offered(p.quests);
      $("hub-side").innerHTML =
        (open.map((q) => this.quest(q)).join("") || `<p class="empty">いまある依頼はすべて片付けた。</p>`) +
        `<p class="hint">倒した数・制圧・保管庫は倒れても数える。脱出の依頼は生還したときだけ。済んだ依頼の報酬は倉庫に届く。</p>`;
    } else {
      const slot = (label: string, n: number | null | undefined) => `<div class="slot"><small>${label}</small><span${n == null ? ' class="none"' : ` style="color:${color(p.stash[n])}"`}>${n == null ? "なし" : esc(itemName(p.stash[n]))}</span></div>`;
      const lent = lentHeals(p, !this.load.weapons.length);
      const heal = (k: (typeof HEALS)[number]) =>
        `<div class="slot count"><small>${HEAL_SPECS[k].label}</small><button type="button" data-act="heal-" data-arg="${k}">−</button><b>${this.load.heals[k]}</b><button type="button" data-act="heal+" data-arg="${k}">+</button><small>倉庫 ${healCount(p, k)}${lent[k] ? `・貸出 ${lent[k]}` : ""}</small></div>`;
      const keys = this.load.keys.map((n) => esc(itemName(p.stash[n]))).join("・");
      const intel = this.intel();
      $("hub-side").innerHTML =
        (intel ? `<div class="slot intel"><small>無線</small><span>${intel}</span></div>` : "") +
        slot("武器 1", this.load.weapons[0]) + slot("武器 2", this.load.weapons[1]) + slot("アーマー", this.load.armor) +
        `<div class="slot"><small>鍵</small><span${keys ? ` style="color:${RARITY_CSS[3]}"` : ' class="none"'}>${keys || "なし"}</span></div>` +
        HEALS.map(heal).join("") +
        `<p class="hint">倒れると、持ち込んだ物と回収品は失う。ポーチ（${pouchSlots(p.hideout)} 枠）に入る分の回収品だけは残る。${p.hideout.infirmary ? "医務室の回復は、どちらの装備にも貸し出される。" : ""}</p>`;
    }
    // A depot chosen in an earlier visit may no longer be on in a profile loaded since.
    if (this.from && !p.depots.includes(this.from)) this.from = null;
    const on = (yes: boolean) => (yes ? ' class="on"' : "");
    $("hub-region").innerHTML =
      `<small>出撃地点</small>` +
      REGIONS.map((r) => `<button type="button" data-act="region" data-arg="${r.id}"${on(!this.from && r.id === this.region)}>${esc(r.name)}に降下</button>`).join("") +
      p.depots.map((d) => `<button type="button" class="depot${this.from === d ? " on" : ""}" data-act="from" data-arg="${d}">中継ボックス：${esc(POIS[poiIndex(d)].name)}（${esc(poiRegion(d).name)}）</button>`).join("") +
      `<span>${this.from ? `${esc(POIS[poiIndex(this.from)].name)}の中継ボックスの前から、${ALLY.name}と歩いて始める` : esc(regionOf(this.region).note)}</span>`;
    $("hub-go").textContent = this.from ? "この装備で出撃" : "この装備で降下";
    $("hub-free").textContent = this.from ? "貸出装備で出撃" : "貸出装備で降下";
    ($("hub-go") as HTMLButtonElement).disabled = this.load.weapons.length === 0;
    const ready = offered(p.quests).filter((q) => deliverable(p, q)).length;
    $("hub-quest-badge").textContent = ready ? String(ready) : "";
    const buildable = MODULES.filter((m) => canBuild(p, m)).length;
    $("hub-build-badge").textContent = buildable ? String(buildable) : "";
  }
}
