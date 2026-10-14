import { HEALS as HEAL_SPECS, META, RARITY, VALUABLES, WEAPONS } from "../sim/config";
import type { Kit } from "../sim/state";
import { buy, emptyLoadout, HEALS, healCount, price, sell, sellPrice, takeKit, wares, type Item, type Loadout, type Profile } from "../meta/profile";
import { saveProfile } from "../meta/storage";

const RARITY_CSS = ["var(--r0)", "var(--r1)", "var(--r2)", "var(--r3)"];

export function itemName(i: Item): string {
  switch (i.t) {
    case "weapon":
      return `${WEAPONS[i.kind].name} ${RARITY.names[i.rarity]}`;
    case "armor":
      return `アーマー Lv${i.tier}`;
    case "heal":
      return HEAL_SPECS[i.kind].label;
    case "valuable":
      return VALUABLES[i.kind].label;
  }
}

export function itemNote(i: Item): string {
  if (i.t === "weapon") return WEAPONS[i.kind].label;
  if (i.t === "valuable") return "売却用";
  if (i.t === "armor") return "シールド強化";
  return HEAL_SPECS[i.kind].shield ? "シールド回復" : "体力回復";
}

const color = (i: Item) => (i.t === "weapon" ? RARITY_CSS[i.rarity] : i.t === "armor" ? RARITY_CSS[i.tier] : "var(--white)");

/** Weapons and armour are listed one by one; heals and valuables are counted. */
function rows(stash: Item[]): { item: Item; index: number[] }[] {
  const out: { item: Item; index: number[] }[] = [];
  stash.forEach((item, n) => {
    if (item.t === "heal" || item.t === "valuable") {
      const row = out.find((r) => r.item.t === item.t && (r.item as { kind: string }).kind === item.kind);
      if (row) return void row.index.push(n);
    }
    out.push({ item, index: [n] });
  });
  const order = { weapon: 0, armor: 1, heal: 2, valuable: 3 };
  return out.sort((a, b) => order[a.item.t] - order[b.item.t]);
}

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The base between raids: the stash, the loadout for the next raid, and the trader.
 * It changes only the profile; the raid itself starts from the kit it hands over.
 */
export class Hub {
  private tab: "kit" | "shop" = "kit";
  private load: Loadout = emptyLoadout();

  constructor(
    public profile: Profile,
    private deploy: (kit: Kit) => void,
  ) {
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
  }

  /** Drops loadout picks the stash no longer has. */
  private fit(l: Loadout): Loadout {
    const st = this.profile.stash;
    const weapons = l.weapons.filter((n) => st[n]?.t === "weapon");
    const armor = l.armor !== null && st[l.armor]?.t === "armor" ? l.armor : null;
    const heals = { ...l.heals };
    for (const k of HEALS) heals[k] = Math.min(heals[k], healCount(this.profile, k), HEAL_SPECS[k].max);
    return { weapons, armor, heals };
  }

  private act(act: string, arg: string) {
    const pick = arg.split(",").map(Number);
    if (act === "tab") this.tab = arg as "kit" | "shop";
    else if (act === "pick") {
      const n = pick[0];
      const it = this.profile.stash[n];
      if (it?.t === "weapon") {
        const w = this.load.weapons;
        this.load.weapons = w.includes(n) ? w.filter((x) => x !== n) : w.length < 2 ? [...w, n] : [w[1], n];
      } else if (it?.t === "armor") this.load.armor = this.load.armor === n ? null : n;
    } else if (act === "heal+" || act === "heal-") {
      const k = arg as keyof Loadout["heals"];
      const max = Math.min(healCount(this.profile, k), HEAL_SPECS[k].max);
      this.load.heals[k] = Math.max(0, Math.min(max, this.load.heals[k] + (act === "heal+" ? 1 : -1)));
    } else if (act === "sell") {
      // Sell the last of the group, so loadout indices before it stay put.
      const n = pick[pick.length - 1];
      const shift = (x: number) => (x > n ? x - 1 : x);
      this.load = { weapons: this.load.weapons.filter((x) => x !== n).map(shift), armor: this.load.armor === n || this.load.armor === null ? null : shift(this.load.armor), heals: this.load.heals };
      this.set(sell(this.profile, n));
      this.load = this.fit(this.load);
    } else if (act === "buy") {
      const next = buy(this.profile, wares()[pick[0]]);
      if (next) this.set(next);
    } else if (act === "go" || act === "free") {
      const { profile, kit } = takeKit(this.profile, act === "free" ? { ...emptyLoadout(), heals: this.load.heals } : this.load);
      this.set(profile);
      this.load = emptyLoadout();
      this.close();
      this.deploy(kit);
      return;
    } else if (act === "back") {
      this.close();
      $("title").hidden = false;
      return;
    }
    this.render();
  }

  render() {
    const p = this.profile;
    $("hub-cash").textContent = p.cash.toLocaleString("ja-JP");
    $("hub-record").textContent = `出撃 ${p.raids} ・ 生還 ${p.extracted}`;
    $("hub-stash-count").textContent = `${p.stash.length} / ${META.stash}`;
    document.querySelectorAll<HTMLElement>("#hub [data-act=tab]").forEach((b) => b.classList.toggle("on", b.dataset.arg === this.tab));
    const shop = this.tab === "shop";
    const used = new Set([...this.load.weapons, ...(this.load.armor === null ? [] : [this.load.armor])]);
    $("hub-stash").innerHTML =
      rows(p.stash)
        .map(({ item, index }) => {
          const n = index.length > 1 ? ` <i>× ${index.length}</i>` : "";
          const on = !shop && used.has(index[0]);
          const right = shop ? `<b>売る ${sellPrice(item).toLocaleString("ja-JP")}</b>` : on ? "<b>持っていく</b>" : item.t === "valuable" ? `<b>${price(item).toLocaleString("ja-JP")}</b>` : "";
          const act = shop ? "sell" : item.t === "weapon" || item.t === "armor" ? "pick" : "";
          const body = `<span style="color:${color(item)}">${esc(itemName(item))}${n}</span><small>${itemNote(item)}</small>${right}`;
          // Heals are packed with the counters on the right; valuables only sell.
          return act ? `<button type="button" class="item${on ? " on" : ""}" data-act="${act}" data-arg="${index.join(",")}">${body}</button>` : `<div class="item">${body}</div>`;
        })
        .join("") || `<p class="empty">倉庫は空。商人で買うか、手ぶらで降りて持ち帰る。</p>`;
    $("hub-side-title").textContent = shop ? "商人" : "持っていく物";
    if (shop) {
      const full = p.stash.length >= META.stash;
      $("hub-side").innerHTML = wares()
        .map((item, n) => `<button type="button" class="item" data-act="buy" data-arg="${n}" ${p.cash < price(item) || full ? "disabled" : ""}><span style="color:${color(item)}">${esc(itemName(item))}</span><small>${itemNote(item)}</small><b>${price(item).toLocaleString("ja-JP")}</b></button>`)
        .join("");
    } else {
      const slot = (label: string, n: number | null | undefined) => `<div class="slot"><small>${label}</small><span${n == null ? ' class="none"' : ` style="color:${color(p.stash[n])}"`}>${n == null ? "なし" : esc(itemName(p.stash[n]))}</span></div>`;
      const heal = (k: (typeof HEALS)[number]) =>
        `<div class="slot count"><small>${HEAL_SPECS[k].label}</small><button type="button" data-act="heal-" data-arg="${k}">−</button><b>${this.load.heals[k]}</b><button type="button" data-act="heal+" data-arg="${k}">+</button><small>倉庫 ${healCount(p, k)}</small></div>`;
      $("hub-side").innerHTML =
        slot("武器 1", this.load.weapons[0]) + slot("武器 2", this.load.weapons[1]) + slot("アーマー", this.load.armor) + HEALS.map(heal).join("") +
        `<p class="hint">倒れると、持ち込んだ物と回収品は失う。ポーチ（${META.pouch} 枠）に入る分の回収品だけは残る。</p>`;
    }
    ($("hub-go") as HTMLButtonElement).disabled = this.load.weapons.length === 0;
  }
}
