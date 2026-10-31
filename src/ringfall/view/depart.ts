import { sfx } from "./sfx";
import { WORLD } from "../sim/config";
import { REGIONS, regionOf } from "../sim/map";
import type { Hub, StartPoint } from "./hub";
import { depotIcon, entryIcon, lockIcon, startIcon } from "./icons";
import { IslandMap, islandScene } from "./map";

/*
 * The departure (DOM, `#depart`): the island drawn whole, every place a raid may start set on it,
 * and beside it the kit, the objective and the confirm. A way in known is a solid ring, one not
 * known yet a dashed ring; a depot switched on is a teal square with its allowance as small boxes,
 * red when the loadout is past it; a region no raid may start in yet carries a padlock. Clicking a
 * point chooses it (`Hub.choose()`); clicking the chosen one, the confirm or Enter departs. It
 * changes only the hub's chosen start.
 */

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** At most this many allowance boxes under a depot's mark; a larger allowance shows its number instead. */
const MINI_BOXES = 6;

export class DepartPicker {
  private map: IslandMap;
  /** Whether the departure is up. */
  private shown = false;

  /** `go`: depart from the chosen start (the hub has checked it can). */
  constructor(
    private hub: Hub,
    private go: () => void,
  ) {
    const canvas = $("depart-map") as HTMLCanvasElement;
    this.map = new IslandMap(canvas);
    this.map.whole = true;
    $("depart-board").style.setProperty("--world-aspect", `${(WORLD.x1 - WORLD.x0) / (WORLD.z1 - WORLD.z0)}`);
    $("depart-points").addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-kind]");
      if (!el || el.disabled) return;
      if (el.classList.contains("on")) {
        if (this.hub.rideRefused()) return;
        this.go();
        return;
      }
      this.pick(el.dataset.kind as StartPoint["kind"], el.dataset.id!);
    });
    addEventListener("resize", () => this.shown && requestAnimationFrame(() => this.render()));
  }

  show(on: boolean) {
    this.shown = on;
    $("depart").hidden = !on;
    // The last opening's points go at once, so none stands at a place the loadout or the profile has since changed.
    $("depart-points").innerHTML = "";
    if (on) requestAnimationFrame(() => this.render());
  }

  /** Chooses a start and redraws. */
  private pick(kind: StartPoint["kind"], id: string) {
    if (!this.hub.choose(kind, id)) return;
    sfx.click();
    this.render();
  }

  /** Steps the choice to the next (`d` 1) or previous (-1) start that may be chosen, in the map's order. */
  cycle(d: 1 | -1) {
    const open = this.hub.startPoints().filter((q) => q.open);
    if (!open.length) return;
    const at = open.findIndex((q) => q.on);
    const next = open[(at + d + open.length) % open.length];
    this.pick(next.kind, next.id);
  }

  /** Draws the map and its points, then the kit and the confirm beside it. */
  render() {
    const hub = this.hub;
    const p = hub.profile;
    this.map.known = p.entries;
    this.map.contract = null;
    this.map.draw(islandScene(p));
    const pts = hub.startPoints();
    this.placePoints(pts, hub.lockedRegions());
    const on = pts.find((q) => q.on);
    const d = hub.departure();
    $("depart-start").innerHTML = on ? `${on.kind === "depot" ? depotIcon() : entryIcon()}<b>${esc(on.name)}</b>${on.kind === "depot" ? `<small>Lv${on.level}</small>` : ""}` : "";
    $("depart-list").innerHTML = d.rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
    // A depot start's allowance as its boxes: what fills them, and what goes free beside them.
    $("depart-carry").innerHTML = hub.departBoxes();
    const w = $("depart-warn");
    w.hidden = !d.warn.length;
    w.textContent = d.warn.join("・");
    ($("depart-go") as HTMLButtonElement).disabled = !!hub.rideRefused();
  }

  /**
   * Sets each start's button over the map where it lies. Marks closer than a finger's width are
   * pushed apart, each tied by a thin line to its true place.
   */
  private placePoints(pts: StartPoint[], locked: string[]) {
    const root = $("depart-points");
    const box = root.getBoundingClientRect();
    const size = matchMedia("(max-height: 500px)").matches || document.body.classList.contains("touch") ? 38 : 30;
    const marks = pts.map((q) => {
      const at = this.map.screenAt(q.x, q.z) ?? { x: 0, y: 0 };
      return { q, x0: at.x, y0: at.y, x: at.x, y: at.y };
    });
    // A few rounds of pushing each close pair apart along the line between them.
    for (let round = 0; round < 40; round++) {
      let moved = false;
      for (let i = 0; i < marks.length; i++)
        for (let j = i + 1; j < marks.length; j++) {
          const a = marks[i];
          const b = marks[j];
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let dd = Math.hypot(dx, dy);
          if (dd >= size) continue;
          if (dd < 0.01) [dx, dy, dd] = [0, 1, 1];
          const push = (size - dd) / 2 + 0.5;
          a.x -= (dx / dd) * push;
          a.y -= (dy / dd) * push;
          b.x += (dx / dd) * push;
          b.y += (dy / dd) * push;
          moved = true;
        }
      for (const m of marks) {
        m.x = Math.max(size / 2, Math.min(box.width - size / 2, m.x));
        m.y = Math.max(size / 2, Math.min(box.height - size / 2, m.y));
      }
      if (!moved) break;
    }
    const tethers = marks
      .filter((m) => Math.hypot(m.x - m.x0, m.y - m.y0) > 4)
      .map((m) => `<line x1="${m.x0.toFixed(1)}" y1="${m.y0.toFixed(1)}" x2="${m.x.toFixed(1)}" y2="${m.y.toFixed(1)}"/><circle cx="${m.x0.toFixed(1)}" cy="${m.y0.toFixed(1)}" r="2"/>`)
      .join("");
    const buttons = marks.map(({ q, x, y }) => {
      const cls = ["pick", q.kind, q.on ? "on" : "", q.open ? "" : "shut", q.over ? "over" : ""].filter(Boolean).join(" ");
      const icon = q.kind === "depot" ? depotIcon() : entryIcon(q.open);
      const lock = q.kind === "depot" && !q.open ? `<span class="pick-lock">${lockIcon()}</span>` : "";
      const pin = q.on ? `<span class="pin">${startIcon()}</span>` : "";
      return `<button type="button" class="${cls}" data-kind="${q.kind}" data-id="${q.id}" style="left:${x.toFixed(1)}px;top:${y.toFixed(1)}px"${q.open ? "" : " disabled"} aria-label="${esc(q.name)}">${icon}${lock}${pin}${q.kind === "depot" && q.open ? this.mini(q) : ""}</button>`;
    });
    // A region no raid may start in yet: a padlock just before its name (which the map writes from its label's point on).
    const locks = REGIONS.filter((r) => locked.includes(r.id)).map((r) => {
      const at = this.map.screenAt(regionOf(r.id).label.x, regionOf(r.id).label.z) ?? { x: 0, y: 0 };
      return `<span class="region-lock" data-region="${r.id}" style="left:${(at.x - size / 2 - 3).toFixed(1)}px;top:${at.y.toFixed(1)}px">${lockIcon()}</span>`;
    });
    root.innerHTML = `<svg class="tethers" width="${box.width}" height="${box.height}" aria-hidden="true">${tethers}</svg>${locks.join("")}${buttons.join("")}`;
  }

  /** A depot's allowance under its mark: a box a point, filled by what the loadout costs, red past it. */
  private mini(q: StartPoint): string {
    const budget = q.budget ?? 0;
    const cost = q.cost ?? 0;
    if (budget > MINI_BOXES) return `<span class="mini${q.over ? " over" : ""}"><b>${cost}/${budget}</b></span>`;
    const n = Math.max(budget, cost);
    const boxes = Array.from({ length: n }, (_, i) => `<i class="${i >= budget ? "over" : i < cost ? "full" : ""}"></i>`).join("");
    return `<span class="mini${q.over ? " over" : ""}">${boxes || "<i class=\"none\"></i>"}</span>`;
  }
}
