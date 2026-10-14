import { HEALS as HEAL_SPECS, META, RARITY, VALUABLES, WEAPONS } from "../sim/config";
import type { Kit } from "../sim/state";
import { REGIONS, regionOf, type RegionId } from "../sim/map";
import { buy, deliver, deliverable, emptyLoadout, HEALS, healCount, keyName, price, sell, sellPrice, takeKit, wares, type Item, type Loadout, type Profile } from "../meta/profile";
import { need, offered, type Quest, type RewardItem } from "../meta/quests";
import { saveProfile } from "../meta/storage";

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

function itemNote(i: Item): string {
  switch (i.t) {
    case "weapon":
      return WEAPONS[i.kind].label;
    case "valuable":
      return "売却用";
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

type Tab = "kit" | "shop" | "quests";

/**
 * The base between raids: the stash, the loadout for the next raid, the region to drop
 * into, the trader and their quests. It changes only the profile; the raid itself starts
 * from the kit and the region it hands over.
 */
export class Hub {
  private tab: Tab = "kit";
  private load: Loadout = emptyLoadout();
  private region: RegionId;

  constructor(
    public profile: Profile,
    private deploy: (kit: Kit, region: RegionId) => void,
  ) {
    this.region = profile.region;
    $("hub").addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
      if (el && !(el as HTMLButtonElement).disabled) this.act(el.dataset.act!, el.dataset.arg ?? "");
    });
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
    for (const k of HEALS) heals[k] = Math.min(heals[k], healCount(this.profile, k), HEAL_SPECS[k].max);
    return {
      weapons: l.weapons.filter((n) => st[n]?.t === "weapon"),
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
    if (act === "tab") this.tab = arg as Tab;
    else if (act === "region") this.region = regionOf(arg as RegionId).id;
    else if (act === "pick") {
      const n = pick[0];
      const it = this.profile.stash[n];
      const toggle = (ns: number[]) => (ns.includes(n) ? ns.filter((x) => x !== n) : [...ns, n]);
      if (it?.t === "weapon") {
        const w = this.load.weapons;
        this.load.weapons = w.includes(n) ? w.filter((x) => x !== n) : w.length < 2 ? [...w, n] : [w[1], n];
      } else if (it?.t === "armor") this.load.armor = this.load.armor === n ? null : n;
      else if (it?.t === "key") this.load.keys = toggle(this.load.keys);
    } else if (act === "heal+" || act === "heal-") {
      const k = arg as keyof Loadout["heals"];
      const max = Math.min(healCount(this.profile, k), HEAL_SPECS[k].max);
      this.load.heals[k] = Math.max(0, Math.min(max, this.load.heals[k] + (act === "heal+" ? 1 : -1)));
    } else if (act === "sell") {
      // Sell the last of a group, so the loadout's picks before it keep their indices.
      const n = pick[pick.length - 1];
      this.reindex([n]);
      this.set(sell(this.profile, n));
    } else if (act === "buy") {
      const next = buy(this.profile, wares()[pick[0]]);
      if (next) this.set(next);
    } else if (act === "deliver") {
      const q = offered(this.profile.quests).find((o) => o.id === arg);
      const take = q && deliverable(this.profile, q);
      if (take) {
        this.reindex(take);
        this.set(deliver(this.profile, arg));
      }
    } else if (act === "go" || act === "free") {
      const l = act === "free" ? { ...emptyLoadout(), heals: this.load.heals, keys: this.load.keys } : this.load;
      const { profile, kit } = takeKit(this.profile, l);
      this.set({ ...profile, region: this.region });
      this.load = emptyLoadout();
      this.close();
      this.deploy(kit, this.region);
      return;
    } else if (act === "back") {
      this.close();
      $("title").hidden = false;
      return;
    }
    this.render();
  }

  private item(item: Item, body: { act?: string; arg?: string; on?: boolean; right?: string; count?: number }) {
    const n = body.count && body.count > 1 ? ` <i>× ${body.count}</i>` : "";
    const inner = `<span style="color:${color(item)}">${esc(itemName(item))}${n}</span><small>${itemNote(item)}</small>${body.right ?? ""}`;
    return body.act ? `<button type="button" class="item${body.on ? " on" : ""}" data-act="${body.act}" data-arg="${body.arg}">${inner}</button>` : `<div class="item">${inner}</div>`;
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
    $("hub-record").textContent = `出撃 ${p.raids} ・ 生還 ${p.extracted}`;
    $("hub-stash-count").textContent = `${p.stash.length} / ${META.stash}`;
    document.querySelectorAll<HTMLElement>("#hub [data-act=tab]").forEach((b) => b.classList.toggle("on", b.dataset.arg === this.tab));
    const shop = this.tab === "shop";
    const used = new Set([...this.load.weapons, ...this.load.keys, ...(this.load.armor === null ? [] : [this.load.armor])]);
    $("hub-stash").innerHTML =
      rows(p.stash)
        .map(({ item, index }) => {
          const on = this.tab === "kit" && used.has(index[0]);
          const right = shop ? `<b>売る ${yen(sellPrice(item))}</b>` : on ? "<b>持っていく</b>" : item.t === "valuable" ? `<b>${yen(price(item))}</b>` : "";
          const act = shop ? "sell" : this.tab === "kit" && (item.t === "weapon" || item.t === "armor" || item.t === "key") ? "pick" : undefined;
          return this.item(item, { act, arg: index.join(","), on, right, count: index.length });
        })
        .join("") || `<p class="empty">倉庫は空。商人で買うか、貸出装備で降りて持ち帰る。</p>`;
    $("hub-side-title").textContent = shop ? "商人" : this.tab === "quests" ? "商人の依頼" : "持っていく物";
    if (shop) {
      const full = p.stash.length >= META.stash;
      $("hub-side").innerHTML = wares()
        .map((item, n) => `<button type="button" class="item" data-act="buy" data-arg="${n}" ${p.cash < price(item) || full ? "disabled" : ""}><span style="color:${color(item)}">${esc(itemName(item))}</span><small>${itemNote(item)}</small><b>${yen(price(item))}</b></button>`)
        .join("");
    } else if (this.tab === "quests") {
      const open = offered(p.quests);
      $("hub-side").innerHTML =
        (open.map((q) => this.quest(q)).join("") || `<p class="empty">いまある依頼はすべて片付けた。</p>`) +
        `<p class="hint">倒した数・制圧・保管庫は倒れても数える。脱出の依頼は生還したときだけ。済んだ依頼の報酬は倉庫に届く。</p>`;
    } else {
      const slot = (label: string, n: number | null | undefined) => `<div class="slot"><small>${label}</small><span${n == null ? ' class="none"' : ` style="color:${color(p.stash[n])}"`}>${n == null ? "なし" : esc(itemName(p.stash[n]))}</span></div>`;
      const heal = (k: (typeof HEALS)[number]) =>
        `<div class="slot count"><small>${HEAL_SPECS[k].label}</small><button type="button" data-act="heal-" data-arg="${k}">−</button><b>${this.load.heals[k]}</b><button type="button" data-act="heal+" data-arg="${k}">+</button><small>倉庫 ${healCount(p, k)}</small></div>`;
      const keys = this.load.keys.map((n) => esc(itemName(p.stash[n]))).join("・");
      $("hub-side").innerHTML =
        slot("武器 1", this.load.weapons[0]) + slot("武器 2", this.load.weapons[1]) + slot("アーマー", this.load.armor) +
        `<div class="slot"><small>鍵</small><span${keys ? ` style="color:${RARITY_CSS[3]}"` : ' class="none"'}>${keys || "なし"}</span></div>` +
        HEALS.map(heal).join("") +
        `<p class="hint">倒れると、持ち込んだ物と回収品は失う。ポーチ（${META.pouch} 枠）に入る分の回収品だけは残る。</p>`;
    }
    $("hub-region").innerHTML =
      `<small>降下地点</small>` +
      REGIONS.map((r) => `<button type="button" data-act="region" data-arg="${r.id}"${r.id === this.region ? ' class="on"' : ""}>${esc(r.name)}</button>`).join("") +
      `<span>${esc(regionOf(this.region).note)}</span>`;
    ($("hub-go") as HTMLButtonElement).disabled = this.load.weapons.length === 0;
    const ready = offered(p.quests).filter((q) => deliverable(p, q)).length;
    $("hub-quest-badge").textContent = ready ? String(ready) : "";
  }
}
