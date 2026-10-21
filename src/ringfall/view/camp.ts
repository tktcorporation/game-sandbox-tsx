import { CAMP, entryOf, regionOf, type CampSpot, type StationId } from "../sim/map";
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
  frame(s: State, world: World, w: number, h: number, o: { near: CampSpot | null; marks: Record<StationId, string>; ride: { to: string; refused: string }; cash: string; touch: boolean }) {
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
    }
    $("camp-cash").textContent = o.cash;
    $("camp-hint").textContent = `門を出ると${entryOf(regionOf("reservoir").entries[0]).name}からレイドが始まる`;
    const key = o.touch ? "" : "<kbd>E</kbd>";
    let prompt = "";
    if (o.near?.id === "vehicle") prompt = o.ride.refused ? `<span class="warn">車両で${esc(o.ride.to)}へ：${esc(o.ride.refused)}</span>` : `${key}車両で${esc(o.ride.to)}へ出る`;
    else if (o.near) prompt = `${key}${esc(o.near.name)}を使う`;
    $("camp-prompt").innerHTML = prompt;
    const use = $("t-use");
    use.hidden = !o.near;
    if (o.near) use.querySelector("b")!.textContent = o.near.id === "vehicle" ? "車両で出る" : o.near.name;
  }
}
