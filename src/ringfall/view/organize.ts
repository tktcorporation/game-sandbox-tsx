/**
 * 倉庫の整理: after a raid (or a load over cap), choose sell / put-in-stash one item at a time
 * until pending is empty. No "sell all remaining".
 */
import { VALUABLES } from "../sim/config";
import {
  isStarter,
  keepPending,
  needsOrganize,
  sellForOrganize,
  sellPending,
  sellPrice,
  stashRoom,
  stashUsed,
  type Item,
  type Profile,
} from "../meta/profile";
import { stashCap } from "../meta/hideout";
import { PHRASE, TERM } from "./copy";
import { capMeter, itemColor, itemName, rows, withSectionHeaders } from "./hub";
import { UI } from "./palette";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** One stacked row (× n) — sells / puts away a single item at `index[0]`. */
function row(i: Item, side: "pending" | "stash", index: number[], room: number): string {
  const name = esc(itemName(i));
  const price = sellPrice(i);
  const tint = itemColor(i);
  const n = index.length > 1 ? ` <i>× ${index.length}</i>` : "";
  const at = index[0]!;
  const acts =
    side === "pending"
      ? `<button type="button" data-org="sell-pending" data-i="${at}">売る ${price}</button>` +
        (room > 0
          ? `<button type="button" data-org="keep-pending" data-i="${at}">${TERM.putInWarehouse}</button>`
          : `<button type="button" disabled>${TERM.putInWarehouse}</button>`)
      : `<button type="button" data-org="sell-stash" data-i="${at}">売る ${price}</button>`;
  return `<div class="org-row" style="--c:${tint}"><span class="chip" style="color:${tint}">${name}${n}</span><span class="org-acts">${acts}</span></div>`;
}

export class Organize {
  open = false;
  /** Credits from items sold in this organize session (for the results line). */
  sold: Item[] = [];
  soldFor = 0;
  private onChange: ((p: Profile) => void) | null = null;

  /** Binds the profile mutator (hub.reload + save). */
  bind(onChange: (p: Profile) => void) {
    this.onChange = onChange;
  }

  show(p: Profile) {
    if (!needsOrganize(p)) {
      this.hide();
      return;
    }
    this.open = true;
    $("organize").hidden = false;
    $("org-title").textContent = TERM.organize;
    $("org-pending-title").textContent = TERM.broughtHome;
    $("org-stash-title").textContent = TERM.warehouse;
    this.render(p);
  }

  hide() {
    this.open = false;
    $("organize").hidden = true;
  }

  /** Opens again when pending remains (after closing results / at the gate). */
  ensure(p: Profile) {
    if (needsOrganize(p)) this.show(p);
    else this.hide();
  }

  render(p: Profile) {
    const room = stashRoom(p);
    const used = stashUsed(p);
    const cap = stashCap(p.hideout);
    // Same capacity bar as the shelves; pending remainder stays on the count line.
    $("org-count").innerHTML = `${capMeter(used, cap)}<small class="org-left">あと ${p.pending.length} 点</small>`;
    const pending = rows(p.pending);
    $("org-pending").innerHTML =
      withSectionHeaders(pending, ({ item, index }) => row(item, "pending", index, room)) ||
      `<p class="empty">入りきらない物はない</p>`;
    const stash = rows(p.stash).filter(({ item }) => !(item.t === "weapon" && isStarter(item)));
    $("org-stash").innerHTML =
      withSectionHeaders(stash, ({ item, index }) => row(item, "stash", index, room)) ||
      `<p class="empty">0 / ${stashCap(p.hideout)}</p>`;
    const ready = !needsOrganize(p);
    const btn = $("org-confirm") as HTMLButtonElement;
    btn.disabled = !ready;
    btn.textContent = TERM.confirmOrganize;
    $("org-hint").textContent = ready ? "" : `あと ${p.pending.length} 点`;
  }

  /** Handles a click inside #organize. Returns true when it handled one. */
  click(el: HTMLElement, p: Profile): { profile: Profile; done?: boolean } | null {
    const act = el.closest<HTMLElement>("[data-org]")?.dataset.org;
    const raw = el.closest<HTMLElement>("[data-i]")?.dataset.i;
    if (act === "confirm") {
      if (needsOrganize(p)) return null;
      this.hide();
      return { profile: p, done: true };
    }
    if (act === "close") {
      // Closing mid-way is allowed; the screen reopens until confirm.
      this.hide();
      return { profile: p };
    }
    if (raw == null || !act) return null;
    const index = Number(raw);
    if (!Number.isInteger(index)) return null;
    if (act === "sell-pending") {
      const r = sellPending(p, index);
      if (!r) return null;
      this.sold.push(r.sold);
      this.soldFor += r.soldFor;
      this.onChange?.(r.profile);
      this.render(r.profile);
      return { profile: r.profile };
    }
    if (act === "sell-stash") {
      const r = sellForOrganize(p, index);
      if (!r) return null;
      this.sold.push(r.sold);
      this.soldFor += r.soldFor;
      this.onChange?.(r.profile);
      this.render(r.profile);
      return { profile: r.profile };
    }
    if (act === "keep-pending") {
      const next = keepPending(p, index);
      if (!next) return null;
      this.onChange?.(next);
      this.render(next);
      return { profile: next };
    }
    return null;
  }

  /** Resets the session's sold tally (new raid settle). */
  resetSession() {
    this.sold = [];
    this.soldFor = 0;
  }

  /** One results line after organize sold something. */
  soldLine(): string {
    if (!this.sold.length) return "";
    return `${PHRASE.organizeSold} ${this.sold.length} 点 ${this.soldFor} クレジット`;
  }
}

/** Valuable label helper for tests / toasts. */
export const valuableLabel = (kind: keyof typeof VALUABLES) => VALUABLES[kind].label;

/** Accent for the organize screen chrome (palette only). */
export const ORGANIZE_ACCENT = UI.own;
