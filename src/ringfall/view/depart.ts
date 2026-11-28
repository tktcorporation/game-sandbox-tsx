import { sfx } from "./sfx";
import { neighboursOnMap } from "../island-net";
import { WORLD } from "../sim/config";
import { NODES, POIS, REGIONS, nodeIndex, regionOf, type NodeId, type RegionId } from "../sim/map";
import { rivalHold } from "../sim/holds";
import { PHRASE, TERM, attackScoutDef, attackScoutTrop, winBonusMark } from "./copy";
import { frontPickFor, type Hub, type LockedPick, type StartPoint } from "./hub";
import { depotIcon, entryIcon, flagIcon, lockIcon, SIDE, startIcon } from "./icons";
import { IslandMap, islandScene, VIEW_PAD } from "./map";
import { isIslandProtected } from "../meta/outer-guard";

/*
 * The departure (DOM, `#depart`): the island drawn whole, every place a raid may start set on it,
 * and beside it the kit, the objective and the confirm. A way in known is a solid ring, one not
 * known yet a dashed ring; a depot switched on is a teal square with its allowance as small boxes,
 * red when the loadout is past it; a region no raid may start in yet carries a padlock. Clicking a
 * point chooses it (`Hub.choose()`); clicking the chosen one, the confirm or Enter departs. Clicking
 * a shut one or a padlock shows it beside the map with why it is shut and how to open it
 * (`Hub.peek()`), and the confirm then says the reason and does not go. It changes only the hub's
 * chosen start and the shut one it shows.
 *
 * The departure goes one of two ways, chosen by the tabs over its side (`Hub.attackMode`): 漁る, the
 * island's raid described above, or 攻める, a sortie to another player's holding. Set to 攻める the
 * side is the list of holdings and the board shows the holding chosen (the ground round its core,
 * its owner's name over it) in place of the island and its starts.
 */

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** At most this many allowance boxes under a depot's mark; a larger allowance shows its number instead. */
const MINI_BOXES = 6;
/** How far, in CSS pixels, a shut region's padlock keeps from every POI's mark and name (across counts 0.6). */
const LOCK_CLEAR = 34;
/** Metres round a holding's core the board shows while the departure is set to 攻める. */
const HOLDING_REACH = 170;

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
    // 攻める list: choosing a holding makes it the sortie's; the one chosen again departs, as a start does.
    $("depart-attack-list").addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-owner]");
      if (!el) return;
      if (el.classList.contains("on")) {
        this.go();
        return;
      }
      if (!this.hub.selectSortie(el.dataset.owner!, el.dataset.attack as NodeId)) return;
      sfx.click();
      this.render();
    });
    // The two ways out of the gate.
    const tabs = $("depart-mode");
    tabs.querySelector<HTMLElement>("[data-mode=forage]")!.textContent = TERM.forage;
    tabs.querySelector<HTMLElement>("[data-mode=attack]")!.textContent = TERM.attack;
    tabs.addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-mode]");
      if (!el || (el.dataset.mode === "attack") === this.hub.attackMode) return;
      this.toggleMode();
    });
    addEventListener("resize", () => this.shown && requestAnimationFrame(() => this.render()));
  }

  show(on: boolean) {
    this.shown = on;
    $("depart").hidden = !on;
    // The last opening's points go at once, so none stands at a place the loadout or the profile has since changed.
    $("depart-points").innerHTML = "";
    this.hub.unpeek();
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
  /** The other way out of the gate (漁る / 攻める): the tabs' click and the Tab key. */
  toggleMode() {
    this.hub.setAttackMode(!this.hub.attackMode);
    sfx.click();
    this.render();
  }

  cycle(d: 1 | -1) {
    if (this.hub.attackMode) {
      const targets = this.hub.sortieTargets();
      if (!targets.length) return;
      const pick = this.hub.sortiePick();
      const at = targets.findIndex((t) => t.owner === pick?.owner && t.id === pick.id);
      const next = targets[(at + d + targets.length) % targets.length];
      if (this.hub.selectSortie(next.owner, next.id)) {
        sfx.click();
        this.render();
      }
      return;
    }
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
    const attack = hub.attackMode;
    const target = attack ? hub.sortiePick() : null;
    $("depart").classList.toggle("attack", attack);
    for (const b of $("depart-mode").querySelectorAll<HTMLElement>("button[data-mode]")) {
      const on = (b.dataset.mode === "attack") === attack;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", String(on));
    }
    this.map.known = attack ? [] : p.entries;
    this.map.contract = null;
    this.map.neighbours = attack ? [] : neighboursOnMap(p);
    this.map.islandShielded = !attack && isIslandProtected(p.outerGuard, Date.now());
    // 攻める: the holding chosen, as the sortie plays it (theirs, every other place the robots'), the ground round its core.
    const core = target ? NODES[nodeIndex(target.id)]?.core : null;
    this.map.frame = core ? { x0: core.x - HOLDING_REACH, z0: core.z - HOLDING_REACH, x1: core.x + HOLDING_REACH, z1: core.z + HOLDING_REACH } : null;
    this.map.locks = !attack;
    this.map.unlocks = !attack;
    const scene = islandScene(
      target
        ? { ...p, depots: [target.id], poiState: Object.fromEntries(POIS.map((o) => [o.id, { state: o.id === target.id ? rivalHold(target.owner) : ("foe" as const) }])) as typeof p.poiState }
        : p,
    );
    // The holding is another player's ground: the player's own explored map says nothing of it, so none of it lies under fog.
    this.map.draw(target ? { ...scene, seen: scene.seen.map(() => 1) } : scene);
    const over = $("depart-target");
    over.hidden = !target;
    over.innerHTML = target ? `${flagIcon(SIDE.rival)}<b>${esc(target.ownerName)}</b><b>の${esc(target.hubName)}</b>` : "";
    const pts = attack ? [] : hub.startPoints();
    const hint = attack ? null : hub.departHint();
    const peek = hint && pts.every((q) => !(q.on && q.kind === hint.at.kind && q.id === hint.at.id)) ? hint.at : null;
    this.placePoints(pts, attack ? [] : hub.lockedRegions(), peek);
    const on = pts.find((q) => q.on);
    const d = hub.departure();
    // A shut start shown in place of the chosen one: its name under a padlock.
    $("depart-start").innerHTML = peek
      ? `${lockIcon()}<b>${esc(hint!.name)}</b>`
      : on
        ? `${on.kind === "depot" ? depotIcon() : entryIcon()}<b>${esc(on.name)}</b>${on.kind === "depot" ? `<small>Lv${on.level}</small>` : ""}`
        : "";
    const how = $("depart-hint");
    how.hidden = !hint;
    how.innerHTML = hint ? hint.how.join("") : "";
    $("depart-start").hidden = attack;
    this.renderAttack(attack);
    // 攻める: the board and the list already name the holding, so only the kit is listed.
    $("depart-list").innerHTML = (attack ? d.rows.slice(0, 1) : d.rows).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("");
    // A depot start's allowance as its boxes: what fills them, and what goes free beside them.
    $("depart-carry").innerHTML = attack ? "" : hub.departBoxes();
    const w = $("depart-warn");
    w.hidden = !d.warn.length;
    w.textContent = d.warn.join("・");
    // A refused confirm says why in its own words, a padlock before them.
    const refused = hub.rideRefused();
    const go = $("depart-go") as HTMLButtonElement;
    go.disabled = !!refused;
    go.innerHTML = refused ? `${lockIcon()}${esc(refused)}` : `${attack ? TERM.attack : PHRASE.sortieDo}<kbd>Enter</kbd>`;
  }

  /** The 攻める list, while the departure is set to it: other players' holdings, each with its defence, trophies and bonus. */
  private renderAttack(on: boolean) {
    const box = $("depart-attack");
    const list = $("depart-attack-list");
    box.hidden = !on;
    if (!on) {
      list.innerHTML = "";
      return;
    }
    const targets = this.hub.sortieTargets();
    if (!targets.length) {
      list.innerHTML = `<p class="attack-empty lock-note">${esc("攻められる別プレイヤーの陣地はまだない")}</p>`;
      return;
    }
    const pick = this.hub.sortiePick();
    list.innerHTML = targets
      .map((t) => {
        const cls = ["attack-row", pick?.owner === t.owner && pick.id === t.id ? "on" : ""].filter(Boolean).join(" ");
        const bonus = t.winBonus > 0 ? `<small class="scout-bonus">${esc(winBonusMark(t.winBonus))}</small>` : "";
        const scout = `<small class="scout-def">${esc(attackScoutDef(t.factory, t.guard))}</small><small class="scout-trop">${esc(attackScoutTrop(t.win, t.lose))}</small>${bonus}`;
        // Split owner / hub so wordy counts each ≤18 (AI names stay short alone).
        return `<button type="button" class="${cls}" data-owner="${esc(t.owner)}" data-attack="${t.id}" aria-label="${esc(t.title)}">${flagIcon(SIDE.rival)}<span class="attack-body"><span class="attack-title"><b>${esc(t.ownerName)}</b><b>の${esc(t.hubName)}</b></span>${scout}</span></button>`;
      })
      .join("");
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
      // A sortie is played on the neighbour's island: no line from the island's start.
      if (this.hub.sortiePick()) return "";
      const toward = frontPickFor(p, at);
      if (!toward) return "";
      const end = this.map.screenAt(toward.x, toward.z);
      if (!end) return "";
      return `<line class="front-pull" x1="${chosen.x0.toFixed(1)}" y1="${chosen.y0.toFixed(1)}" x2="${end.x.toFixed(1)}" y2="${end.y.toFixed(1)}"/>`;
    })();
    const buttons = marks.map(({ q, x, y }) => {
      // While a shut start is shown, it is ringed and the chosen one stands unlit.
      const shown = peek?.kind === q.kind && peek.id === q.id;
      const cls = ["pick", q.kind, q.on && !peek ? "on" : "", q.open ? "" : "shut", shown ? "peek" : "", q.over ? "over" : ""].filter(Boolean).join(" ");
      const icon = q.kind === "depot" ? depotIcon() : entryIcon(q.open);
      const lock = q.kind === "depot" && !q.open ? `<span class="pick-lock">${lockIcon()}</span>` : "";
      const pin = q.on && !peek ? `<span class="pin">${startIcon()}</span>` : "";
      return `<button type="button" class="${cls}" data-kind="${q.kind}" data-id="${q.id}" style="left:${x.toFixed(1)}px;top:${y.toFixed(1)}px" aria-label="${esc(q.name)}">${icon}${lock}${pin}${q.kind === "depot" && q.open ? this.mini(q) : ""}</button>`;
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
