import { sfx } from "./sfx";
import { neighboursOnMap } from "../island-net";
import { WORLD } from "../sim/config";
import { NODES, POIS, REGIONS, nodeIndex, regionOf, type RegionId } from "../sim/map";
import { PHRASE, reachAfter, reachFrom } from "./copy";
import { frontPickFor, type Hub, type LockedPick, type StartPoint } from "./hub";
import { depotIcon, entryIcon, flagIcon, lockIcon, SIDE, startIcon } from "./icons";
import { IslandMap, islandScene, VIEW_PAD } from "./map";
import { isIslandProtected } from "../meta/outer-guard";

/*
 * The departure (DOM, `#depart`): the island drawn whole, every place a raid may start set on it,
 * and beside it the kit, the objective and the confirm. A way in known is a solid ring, one not
 * known yet a dashed ring; a depot switched on is a teal square;
 * a region no raid may start in yet carries a padlock. Clicking a
 * point chooses it (`Hub.choose()`); clicking the chosen one, the confirm or Enter departs. Clicking
 * a shut one or a padlock shows it beside the map with why it is shut and how to open it
 * (`Hub.peek()`), and the confirm then says the reason and does not go. It changes only the hub's
 * chosen start and the shut one it shows.
 *
 * There is one way out of the gate, a raid of the island. Another player's holding is attacked
 * from the same node's core on the player's own island (sim/jump.ts): the map rings the nodes of
 * the player's whose core reaches one (`IslandMap.jumps`), and when the signal station pointed at
 * a holding (`Hub.reach`) the side names the core to walk to, or the node to take first.
 */

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** How far, in CSS pixels, a shut region's padlock keeps from every POI's mark and name (across counts 0.6). */
const LOCK_CLEAR = 34;

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
    // The departure chooses a start: the map shows who holds what and the nodes' names; the starts are the buttons laid over it.
    // No pan/zoom here: the starts' layer covers the map; fit-to-content padding keeps edge marks whole.
    this.map.plain = true;
    this.map.whole = true;
    // Same pad as IslandMap.fitView so the board's box matches what is drawn (edge names stay inside).
    $("depart-board").style.setProperty("--world-aspect", `${(WORLD.x1 - WORLD.x0 + VIEW_PAD * 2) / (WORLD.z1 - WORLD.z0 + VIEW_PAD * 2)}`);
    $("depart-points").addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-kind]");
      // The starts' layer covers the map, so a click between the starts goes to the map's padlocks.
      if (!el) {
        if (this.map.pick(e.clientX, e.clientY)) sfx.locked();
        return;
      }
      // A shut start or a locked region is shown, not chosen: the player sees why, and how to open it.
      if (el.classList.contains("shut")) {
        if (!this.hub.peek({ kind: el.dataset.kind as LockedPick["kind"], id: el.dataset.id! })) return;
        sfx.locked();
        this.render();
        return;
      }
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
    this.hub.unpeek();
    // What the signal station pointed at is named for this opening alone.
    if (!on) this.hub.reach = null;
    this.map.picked = -1;
    this.map.resetCam();
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
    this.map.neighbours = neighboursOnMap(p);
    this.map.islandShielded = isIslandProtected(p.outerGuard, Date.now());
    this.map.jumps = hub.jumpNodes();
    this.map.draw(islandScene(p));
    const pts = hub.startPoints();
    const hint = hub.departHint();
    const peek = hint && pts.every((q) => !(q.on && q.kind === hint.at.kind && q.id === hint.at.id)) ? hint.at : null;
    this.placePoints(pts, hub.lockedRegions(), peek);
    const on = pts.find((q) => q.on);
    const d = hub.departure();
    // A shut start shown in place of the chosen one: its name under a padlock.
    $("depart-start").innerHTML = peek
      ? `${lockIcon()}<b>${esc(hint!.name)}</b>`
      : on
        ? `${on.kind === "depot" ? depotIcon() : entryIcon()}<b>${esc(on.name)}</b>`
        : "";
    const how = $("depart-hint");
    how.hidden = !hint;
    how.innerHTML = hint ? hint.how.join("") : "";
    // The holding the signal station pointed at: the core of the player's island a sortie to it sets out from, or the node to take first.
    const reach = hub.reach;
    const at = reach ? NODES[nodeIndex(reach.id)] : null;
    const line = $("depart-reach");
    line.hidden = !at;
    line.innerHTML = at
      ? p.poiState[at.id]?.state === "own"
        ? `${flagIcon(SIDE.rival)}<b>${esc(reach!.ownerName)}</b>${esc(reachFrom(at.name))}`
        : `${lockIcon()}<b>${esc(reach!.ownerName)}</b>${esc(reachAfter(at.name))}`
      : "";
    $("depart-list").innerHTML = d.rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("");
    const w = $("depart-warn");
    w.hidden = !d.warn.length;
    w.textContent = d.warn.join("・");
    // A refused confirm says why in its own words, a padlock before them.
    const refused = hub.rideRefused();
    const go = $("depart-go") as HTMLButtonElement;
    go.disabled = !!refused;
    go.innerHTML = refused ? `${lockIcon()}${esc(refused)}` : `${PHRASE.sortieDo}<kbd>Enter</kbd>`;
  }

  /**
   * Sets each start's button over the map where it lies. Marks closer than a finger's width are
   * pushed apart, each tied by a thin line to its true place.
   */
  private placePoints(pts: StartPoint[], locked: string[], peek: LockedPick | null) {
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
    // Thin pull from the chosen start toward today's front (ux-design Round 9).
    const chosen = marks.find((m) => m.q.on);
    const frontPull = (() => {
      if (!chosen) return "";
      const p = this.hub.profile;
      const at = { x: chosen.q.x, z: chosen.q.z };
      const toward = frontPickFor(p, at);
      if (!toward) return "";
      const end = this.map.screenAt(toward.x, toward.z);
      if (!end) return "";
      return `<line class="front-pull" x1="${chosen.x0.toFixed(1)}" y1="${chosen.y0.toFixed(1)}" x2="${end.x.toFixed(1)}" y2="${end.y.toFixed(1)}"/>`;
    })();
    const buttons = marks.map(({ q, x, y }) => {
      // While a shut start is shown, it is ringed and the chosen one stands unlit.
      const shown = peek?.kind === q.kind && peek.id === q.id;
      const cls = ["pick", q.kind, q.on && !peek ? "on" : "", q.open ? "" : "shut", shown ? "peek" : ""].filter(Boolean).join(" ");
      const icon = q.kind === "depot" ? depotIcon() : entryIcon(q.open);
      const lock = q.kind === "depot" && !q.open ? `<span class="pick-lock">${lockIcon()}</span>` : "";
      const pin = q.on && !peek ? `<span class="pin">${startIcon()}</span>` : "";
      return `<button type="button" class="${cls}" data-kind="${q.kind}" data-id="${q.id}" style="left:${x.toFixed(1)}px;top:${y.toFixed(1)}px" aria-label="${esc(q.name)}">${icon}${lock}${pin}</button>`;
    });
    // A region no raid may start in yet: a padlock in it, clear of its POIs' names.
    const locks = REGIONS.filter((r) => locked.includes(r.id)).map((r) => {
      const at = this.lockSpot(r.id);
      const cls = `region-lock shut${peek?.kind === "region" && peek.id === r.id ? " peek" : ""}`;
      return `<button type="button" class="${cls}" data-kind="region" data-id="${r.id}" style="left:${(at.x - size / 2 - 3).toFixed(1)}px;top:${at.y.toFixed(1)}px" aria-label="${esc(r.name)}">${lockIcon()}</button>`;
    });
    root.innerHTML = `<svg class="tethers" width="${box.width}" height="${box.height}" aria-hidden="true">${tethers}${frontPull}</svg>${locks.join("")}${buttons.join("")}`;
  }

  /**
   * Where a shut region's padlock stands: its label's point, or the nearest point in the region
   * clear of every POI's mark and the name over it, so the padlock covers no name.
   */
  private lockSpot(id: RegionId): { x: number; y: number } {
    const r = regionOf(id);
    const marks = POIS.flatMap((o) => this.map.screenAt(o.x, o.z) ?? []);
    const clear = (p: { x: number; y: number }) => Math.min(...marks.map((m) => Math.hypot((p.x - m.x) * 0.6, p.y - (m.y - 8))));
    const home = this.map.screenAt(r.label.x, r.label.z) ?? { x: 0, y: 0 };
    if (clear(home) >= LOCK_CLEAR) return home;
    let best = home;
    let score = Infinity;
    const b = r.bounds;
    for (let dx = -240; dx <= 240; dx += 30)
      for (let dz = -240; dz <= 240; dz += 30) {
        const x = r.label.x + dx;
        const z = r.label.z + dz;
        if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) continue;
        const p = this.map.screenAt(x, z);
        if (!p || clear(p) < LOCK_CLEAR) continue;
        const d = Math.hypot(dx, dz);
        if (d < score) [best, score] = [p, d];
      }
    return best;
  }
}
