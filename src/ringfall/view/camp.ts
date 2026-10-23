import { CAMP, type CampSpot, type StationId } from "../sim/map";
import { crossIcon } from "./icons";
import type { State } from "../sim/state";
import type { World } from "./world";

/*
 * The camp's overlay (DOM): each station's name floating over it with its mark when it has
 * something to act on, the use key's prompt for the station or the truck in reach, and the
 * credits in a corner. It reads the camp's state and never changes it.
 */

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** Metres past which a station's name is no longer shown. */
const LABEL_FAR = 40;
/** Pixels kept between two stations' names. */
const LABEL_GAP = 4;

export class CampView {
  private labels = new Map<CampSpot["id"], HTMLElement>();

  constructor() {
    const root = $("camp-labels");
    for (const c of CAMP.spots) {
      const el = document.createElement("div");
      el.className = `camp-label${c.id === "vehicle" ? " vehicle" : ""}`;
      el.innerHTML = `<b>${esc(c.name)}</b><span></span>`;
      root.appendChild(el);
      this.labels.set(c.id, el);
    }
  }

  /** The use button's own label in a raid, given back when the camp is left. */
  private useLabel = $("t-use").querySelector("b")!.textContent ?? "";

  show(on: boolean) {
    $("camp").hidden = !on;
    if (!on) {
      $("t-use").querySelector("b")!.textContent = this.useLabel;
      $("t-use").hidden = true;
    }
  }

  /**
   * `near`: the spot in reach; `marks`: each station's mark ("" for none); `ride`: where the truck
   * drives and why it cannot ("" when it can); `touch`: the prompt names the use button, not the key.
   */
  /**
   * `today`: the day's line and the 今日の作戦 card (`Hub.today()`); `panel`: a panel or the
   * departure's check is up, so the card steps aside.
   */
  frame(s: State, world: World, w: number, h: number, o: { near: CampSpot | null; marks: Record<StationId, string>; ride: { to: string; refused: string }; cash: string; touch: boolean; today: { head: string; row: string; plan: [string, string][] }; panel: boolean }) {
    const eye = { x: s.player.pos.x, z: s.player.pos.z };
    const shown: { el: HTMLElement; x: number; y: number; d: number }[] = [];
    for (const c of CAMP.spots) {
      const el = this.labels.get(c.id)!;
      const d = Math.hypot(c.x - eye.x, c.z - eye.z);
      const at = world.project({ x: c.x, y: c.y + c.top, z: c.z }, w, h);
      if (at.behind || d > LABEL_FAR || at.x < -60 || at.x > w + 60 || at.y < -30 || at.y > h + 30) {
        el.style.display = "none";
        continue;
      }
      el.style.display = "flex";
      const mark = c.id === "vehicle" ? "" : o.marks[c.id];
      const sub = el.querySelector("span")!;
      if (sub.textContent !== mark) sub.textContent = mark;
      el.classList.toggle("marked", !!mark);
      el.classList.toggle("near", o.near?.id === c.id);
      shown.push({ el, x: at.x, y: at.y, d });
    }
    // Names that would cover one another: the nearer station keeps its place, a farther one is lifted clear above it.
    shown.sort((a, b) => a.d - b.d);
    $("camp-plan").hidden = o.panel;
    const covers = [$("camp-head"), $("camp-plan")].filter((e) => !e.hidden).map((e) => e.getBoundingClientRect());
    const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
    for (const q of shown) {
      const lw = q.el.offsetWidth;
      const lh = q.el.offsetHeight;
      let y = q.y;
      for (let moved = true, n = 0; moved && n < 8; n++) {
        moved = false;
        for (const r of placed)
          if (q.x - lw / 2 < r.x1 + LABEL_GAP && q.x + lw / 2 > r.x0 - LABEL_GAP && y - lh < r.y1 + LABEL_GAP && y > r.y0 - LABEL_GAP) {
            y = r.y0 - LABEL_GAP;
            moved = true;
          }
      }
      placed.push({ x0: q.x - lw / 2, x1: q.x + lw / 2, y0: y - lh, y1: y });
      q.el.style.left = `${q.x.toFixed(0)}px`;
      q.el.style.top = `${y.toFixed(0)}px`;
      // A name that would sit under the day's line or the card is not shown: it would show through them.
      const under = covers.some((r) => q.x - lw / 2 < r.right && q.x + lw / 2 > r.left && y - lh < r.bottom && y > r.top);
      if (under) q.el.style.display = "none";
    }
    $("camp-cash").textContent = o.cash;
    $("camp-hint").textContent = o.today.head;
    const row = $("camp-row");
    if (row.dataset.html !== o.today.row) {
      row.dataset.html = o.today.row;
      row.innerHTML = o.today.row;
    }
    const plan = o.today.plan.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
    const list = $("camp-plan-list");
    if (list.dataset.html !== plan) {
      list.dataset.html = plan;
      list.innerHTML = plan;
    }
    const key = o.touch ? "" : "<kbd>E</kbd>";
    let prompt = "";
    // The truck: where it drives, or, over the depot's allowance, a cross and the allowance in red.
    if (o.near?.id === "vehicle") prompt = o.ride.refused ? `<span class="warn">${crossIcon()}${esc(o.ride.to)}　${esc(o.ride.refused)}</span>` : `${key}車両　${esc(o.ride.to)}`;
    else if (o.near) prompt = `${key}${esc(o.near.name)}`;
    $("camp-prompt").innerHTML = prompt;
    const use = $("t-use");
    use.hidden = !o.near;
    if (o.near) use.querySelector("b")!.textContent = o.near.id === "vehicle" ? "車両で出る" : o.near.name;
  }
}
