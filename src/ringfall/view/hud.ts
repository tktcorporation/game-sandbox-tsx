import { canBuild, canBuildFactory, factoryNeeded, nextFactory, pouchKeep, stashUsed, wanted, type Profile, type Settlement } from "../meta/profile";
import { MODULES, nextLevel, stashCap, stillNeeded } from "../meta/hideout";
import { neighboursNowOnMap } from "../island-net";
import type { ModKind, ValuableKind } from "../sim/config";
import { modGist } from "./modgist";
import type { Island } from "../meta/island";
import { aiLabel, attackCapturing, attackCapturePrompt, attackSeized, goalCompass, leagueChangeLine, PHRASE, TERM, moduleRaiseReady, newsIncursion, raidStarsLine, relayOf, trophyHead, trophyLine, winBonusMark } from "./copy";
import { raidTrophyDelta } from "../meta/trophies";
import { isContestedShore, neighbourNameByCode } from "../meta/neighbours";
import { capturedIds } from "../sim/front";
import { itemColor, itemName, nextHandFor } from "./hub";
import { ALLY, AWARE, BAG, HIDEOUT, META, DEPOT, ENEMIES, HEAL_KINDS, HEALS, PLAYER, RARITY, REVEAL, TACTICAL, TOOL_KINDS, TOOLS, VALUABLES, WEAPONS, type Flank } from "../sim/config";
import { eyePos, magSize } from "../sim/combat";
import { atRisk, countered, heldUnlocks } from "../sim/battle";
import { dist2d, los } from "../sim/geom";
import { DEPOTS, entryOf, EXTRACTS, nodeIndex, NODES, POIS, poiIndex, regionHere, regionOf, routeOf, ZIPS, type EntryId } from "../sim/map";
import { routeBefore } from "../sim/routes";
import { islandHolds } from "../meta/island";
import { isAiOwner, rivalHold, rivalOf, type PoiHold } from "../sim/holds";
import { bagLoad, canOpen, depotBlocked, depotInReach, extractHere, extractReady, homeReady, makeRoom, roomForTool, searchFor, useCandCount, useFocusMark, useTarget } from "../sim/world";
import { healTime, tacticalCooldown } from "../sim/player";
import { helpTime, reviveTime } from "../sim/ally";
import { callLeft, enemyHp, enemyShield, weakY, type GameEvent, type State, type Vec3 } from "../sim/state";
import { haulAndSentWorth } from "../sim/results";
import { pickHeal } from "../sim/player";
import { RARITY_CSS, SCOPE_IN } from "./models";
import { IslandMap, islandScene, shieldedBy } from "./map";
import { sfx } from "./sfx";
import { nodeRow } from "./row";
import { compassUrgent, currentStep, huntSpot, objectiveSteps, type Objective, type Step, type Task } from "../sim/objective";
import type { World } from "./world";
import { FRONT, MOD, MODS, MOMENTUM } from "../sim/config";
import { binPicture, modIcon, pouchIcon, routeIcon, zipIcon } from "./icons";
import { zipPoint } from "../sim/zips";
import { bagIcon, callIcon, checkIcon, clockIcon, coreIcon, crossIcon, depotIcon, entryIcon, exitIcon, eyeIcon, factoryIcon, fightIcon, flagIcon, flareIcon, hideoutIcon, keyIcon, lockIcon, noiseIcon, reinforceIcon, reviveIcon, SIDE, stashIcon, upIcon } from "./icons";
import { capturable, momentum, siegeWaves } from "../sim/front";
import { terrainHeight } from "../sim/terrain";

/** The POI whose bins drop the key to POI `poi`'s vault (its `keyFrom`), by name. */
const keySource = (poi: number) => POIS[poiIndex(POIS[poi].keyFrom)].name;

import { BagView } from "./bag";
import { UI } from "./palette";

/*
 * The DOM layer: everything the player reads. The screen always answers two
 * questions: what to do next (objective card, and the map for where things are) and how am I doing
 * (shield cells, health, ammo, ability charge).
 */

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The island's news as the results / 起動時の一枚 show it.
 * 「取られた」行に やり返す (TKT-204 案 F) when the one who took it has a holding to attack (`setRevenge()`).
 */
let revengeOf: (line: string) => { owner: string; id: string } | null = () => null;
/** How a 島の知らせ line names the holding to attack back (the hub's `revengeFor()`). */
export const setRevenge = (f: typeof revengeOf) => (revengeOf = f);
const newsBlock = (news: readonly string[], revenge = false) => {
  if (!news.length) return "";
  const rows = news.map((n) => {
    const t = revenge ? revengeOf(n) : null;
    const btn = t
      ? `<button type="button" class="revenge" data-act="revenge" data-arg="${esc(`${t.owner}|${t.id}`)}">${TERM.revenge}</button>`
      : "";
    return `<span class="news-line">${esc(n)}${btn}</span>`;
  });
  return `<h3>${TERM.islandNews}</h3><p class="island-news">${rows.join("")}</p>`;
};
/** Replaces an element's markup only when it changes: the objective card is redrawn every frame. */
const setHtml = (el: HTMLElement, html: string) => {
  if (el.dataset.html === html) return;
  el.dataset.html = html;
  el.innerHTML = html;
};
/** Same for plain text: assigning textContent every frame still dirties layout when nothing changed. */
const setText = (el: HTMLElement, text: string) => {
  if (el.dataset.text === text) return;
  el.dataset.text = text;
  el.textContent = text;
};
const clock = (t: number) => `${Math.floor(Math.max(0, t) / 60)}:${String(Math.floor(Math.max(0, t) % 60)).padStart(2, "0")}`;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
/** Wording follows the controls in use: keys on a PC, on-screen buttons on a phone. */
const isTouch = () => document.body.classList.contains("touch");
/** A cable's end by name: a node's, the camp's, or for a lift the quarry's floor or rim. */
const zipEndName = (id: string) => (id === "camp" ? TERM.camp : id === "lift:quarry" ? "採掘場の底" : id.startsWith("lift:") ? "採掘場の縁" : (NODES.find((n) => n.id === id)?.name ?? ""));
const key = (k: string) => (isTouch() ? "" : `<kbd>${k}</kbd> `);

interface DmgNum {
  el: HTMLElement;
  id: number;
  pos: Vec3;
  value: number;
  age: number;
  life: number; // total seconds since the first hit merged into this number
  crit: boolean;
  /** The best angle among the hits merged into this number. */
  flank: Flank;
  /** A plate took part of one of the hits merged into this number. */
  blocked: boolean;
  /** The hits behind this number staggered the robot out of its wind-up. */
  cut?: boolean;
}

/** Tag shown with a damage number, by how the shot met the robot. */

const FLANK_TAG: Partial<Record<Flank, string>> = { back: "背後", ambush: "奇襲" };
const FLANK_RANK: Record<Flank, number> = { front: 0, none: 1, side: 1, back: 2, ambush: 3 };

/** Metres within which a seen robot shows how aware it is. */
const MARK_RANGE = 40;
/** Seconds the compass shows where reinforcements beamed in (`UNLOCKS.scout`). */
const SCOUT_SHOW = 25;


/** The colour of the core of a node not the player's: another player's green, else the enemy's red. */
const foeSide = (h: PoiHold) => (rivalOf(h) !== null ? SIDE.rival : SIDE.enemy);

/**
 * 「ツバキの浄水場」 for a rival-held node (TKT-204 案 E). Null when the enemy (not a player) holds it.
 * `names` is the raid's rival id → display name map when neighbours are not yet on the map.
 */
function rivalWhoHub(hold: PoiHold, hubName: string, names?: ReadonlyMap<string, string>): string | null {
  const who = rivalOf(hold);
  if (!who) return null;
  const neigh = neighboursNowOnMap().find((x) => x.code === who || (isAiOwner(who) && x.code === who.slice(3)));
  let owner: string;
  if (neigh) owner = neigh.ai ? aiLabel(neigh.name) : neigh.name;
  else if (names?.get(who)) owner = names.get(who)!;
  else {
    const bare = neighbourNameByCode(who, neighboursNowOnMap());
    owner = bare ? (isAiOwner(who) ? aiLabel(bare) : bare) : "他のプレイヤー";
  }
  return `${owner}の${hubName}`;
}

export class Hud {
  private root = $("hud");
  private dmgLayer = $("dmg-layer");
  private bars = $("enemy-bars");
  private barEls = new Map<number, HTMLElement>();
  private nums: DmgNum[] = [];
  private hitT = 0;
  private bannerT = 0;
  private hurtT = 0;
  private dirs: { el: HTMLElement; x: number; z: number; t: number }[] = [];
  private shieldCells: HTMLElement[] = [];
  private lastCells = -1;
  /**
   * Lines kept at the head of 島の知らせ on results (outgoing expeditions).
   * Late server news via setNews() must not drop these (Option A unified list).
   */
  private newsKeep: string[] = [];
  private awareLayer = $("aware-layer");
  private awEls = new Map<number, HTMLElement>();
  /** A red mark per node of the player's the enemy's robots have come to, by its place in `NODES`. */
  private threatEls = new Map<number, HTMLElement>();
  private spotted = new Map<number, number>(); // robot id -> seconds left to show "!"
  /**
   * Half the compass's width, measured once and again only when its size changes: read in the
   * frame, after the frame's writes to the page, it would make the browser lay the page out anew.
   */
  private compassHalf = 0;

  private map = Object.assign(new IslandMap($<HTMLCanvasElement>("map-canvas")), { unlocks: false });
  /** The minimap in the corner, where the screen has room for it (style.css): the ground round the player, drawn a few times a second; a click opens the map. */
  private minimap = Object.assign(new IslandMap($<HTMLCanvasElement>("minimap")), { mini: 180, unlocks: false });
  private miniT = 0;
  /** The bag peek and the pickups' cards (view/bag.ts). */
  readonly bag = new BagView();
  private mapOpen = false;
  /** The ways in the profile knew when the raid began: one walked to that is not among them is news. */
  private known: EntryId[] = [];

  /**
   * Called when the raid map closes, so the page can take the look lock again (main.ts).
   * Opening releases the lock first so wheel/drag reach the canvas under desktop pointer lock.
   */
  onMapClosed: (() => void) | null = null;

  /** Open or close the island map; it is redrawn every frame while open, and opens on the region the player is in. */
  /** Marks POIs that drop the hunt target on the raid map / minimap (and optional source tags). */
  setGoalPois(ids: readonly string[], tags: readonly { poi: string; tag: string }[] = []) {
    this.map.goalPois = ids;
    this.map.goalTags = tags;
    this.minimap.goalPois = ids;
    this.minimap.goalTags = tags;
  }

  toggleMap(force?: boolean) {
    this.mapOpen = force ?? !this.mapOpen;
    $("map").hidden = !this.mapOpen;
    $("hud").classList.toggle("map-open", this.mapOpen);
    if (this.mapOpen) {
      // The neighbours out at sea show on the whole world's view (N), as on the camp's maps.
      this.map.neighbours = neighboursNowOnMap();
      this.map.resetCam();
      this.map.bindNav();
      this.showWhole(false);
      // Mark map-open before unlocking so pointerlockchange does not open the pause screen.
      if (document.pointerLockElement) document.exitPointerLock();
    } else {
      this.onMapClosed?.();
    }
    this.map.picked = -1;
  }

  /** Switch the open map between the region the player is in and the whole world. */
  toggleMapView() {
    if (this.mapOpen) this.showWhole(!this.map.whole);
  }

  private showWhole(whole: boolean) {
    this.map.whole = whole;
    this.map.resetCam();
    const to = whole ? "地域" : "全体";
    $("map-zoom").textContent = to;
    $("map-view-key").textContent = to;
  }

  constructor() {
    $("map-close").addEventListener("click", () => this.toggleMap(false));
    $("minimap").addEventListener("click", () => this.toggleMap(true));
    $("map-zoom").addEventListener("click", () => this.toggleMapView());
    // Padlock pick on capture; pan/zoom bind on the canvas itself (pointer-events on #map-canvas).
    addEventListener(
      "pointerdown",
      (e) => {
        if (this.mapOpen && !document.pointerLockElement && this.map.pick(e.clientX, e.clientY)) sfx.locked();
      },
      true,
    );
    new ResizeObserver(() => (this.compassHalf = 0)).observe($("compass"));
    const strip = $("compass-strip");
    const labels: Record<number, string> = { 0: "N", 45: "NE", 90: "E", 135: "SE", 180: "S", 225: "SW", 270: "W", 315: "NW" };
    // Three turns of the strip so it can scroll seamlessly.
    for (let d = -360; d <= 720; d += 15) {
      const deg = ((d % 360) + 360) % 360;
      const el = document.createElement("span");
      el.style.left = `${(d + 360) * 2}px`;
      if (labels[deg] !== undefined) el.textContent = labels[deg];
      else el.className = "tick";
      strip.appendChild(el);
    }
    // CoC left stack: trophies + league always readable without opening the signal station.
    const trop = $("hud-trophy");
    trop.querySelector("small")!.textContent = TERM.trophy;
    trop.setAttribute("aria-label", TERM.trophy);
  }

  show(on: boolean) {
    this.root.hidden = !on;
    if (!on) this.bag.reset();
  }

  /** Ranking count for the raid HUD's top-left (profile at raid start; unchanged until settle). */
  setTrophies(n: number) {
    const el = $("hud-trophy");
    el.querySelector("small")!.textContent = trophyHead(n);
    el.querySelector("b")!.textContent = Math.max(0, Math.round(n)).toLocaleString("ja-JP");
    el.setAttribute("aria-label", trophyHead(n));
    el.hidden = false;
  }

  /** What the raid is out to do (a capture task, or null for the day's front), for the objective's steps; and those steps as last drawn. */
  private task: Task | null = null;
  private obj: Objective | null = null;
  /** The objective and step last shown, so moving to the next step is told with a toast. */
  private lastStep = "";

  /**
   * Clears any raid task so the objective follows the day's front (`objectiveSteps()`).
   * Capture objectives use `setCaptureTask`. Kept for callers that once passed a contract.
   */
  setContract() {
    this.task = null;
    this.lastStep = "";
    this.map.contract = null;
    // A new raid restarts `s.time`, so a landing marked in the last raid would show again.
    this.scout = null;
  }

  /** 短いレイド（Short Raid）の目標: この拠点を「核 · 制圧」する。 */
  setCaptureTask(node: number) {
    this.task = { t: "capture", node };
    this.lastStep = "";
    this.map.contract = null;
    this.scout = null;
  }

  /** Settled raids before this one (callers that once gated the story line still set it). */
  setRaidsDone(_n: number) {}

  /**
   * A short local ping where the player looks (P): view-only mark on the compass and map for a
   * few seconds. Does not touch the sim (docs/ringfall/ux-design.md, M4). Optional `sync` posts
   * it to the island DO (M6) from `main.ts`.
   */
  private ping: { x: number; z: number; until: number } | null = null;
  dropPing(at: { x: number; z: number }) {
    this.ping = { x: at.x, z: at.z, until: performance.now() + 8000 };
    this.map.ping = { x: at.x, z: at.z };
    this.toast(`${flagIcon(SIDE.own)}印`, 1, 1600);
  }

  /** Async look-marks from the island (M6); expired ones are dropped by the caller. */
  setRemotePings(list: readonly { x: number; z: number }[]) {
    this.map.remotePings = list;
  }

  /** Async attack/defence traces on bins/roads (M5), set once as the raid starts. */
  setTraces(list: readonly { x: number; z: number; t: "bin" | "road"; mode: "raid" | "hold" }[]) {
    this.map.traces = list;
  }

  /** The ways in the base offers, for the raid about to start: the HUD and the map tell the others apart. */
  /** Bag slots the pouch keeps through a wipe (the hideout's pouch). */
  private pouch: number = META.pouch;
  setPouch(n: number) {
    this.pouch = n;
  }

  /**
   * The bag as its slots: what the pouch would keep through a wipe first, filled in the pouch's
   * colour inside the pouch's outlined slots, then the rest in their rarities' colours.
   */
  private bagCells(p: State["player"]): string {
    const kept = pouchKeep(p.haul, p.tools, this.pouch);
    const keptAt = new Set(kept.at);
    const keptTools = [...kept.tools];
    const fill: string[] = [];
    const rest: string[] = [];
    for (const k of kept.tools) for (let n = 0; n < TOOLS[k].size; n++) fill.push("k");
    p.haul.forEach((k, i) => {
      for (let n = 0; n < VALUABLES[k].size; n++) (keptAt.has(i) ? fill : rest).push(keptAt.has(i) ? "k" : RARITY_CSS[VALUABLES[k].rarity]);
    });
    for (const k of p.tools) {
      const at = keptTools.indexOf(k);
      if (at >= 0) keptTools.splice(at, 1);
      else for (let n = 0; n < TOOLS[k].size; n++) rest.push(RARITY_CSS[3]);
    }
    // The rest starts past the pouch's slots while it fits there, so the pouch's slots show what it keeps.
    const start = Math.max(fill.length, this.pouch + rest.length <= BAG.slots ? this.pouch : fill.length);
    const cells: string[] = Array.from({ length: BAG.slots }, () => "");
    fill.forEach((c, n) => (cells[n] = c));
    rest.forEach((c, n) => (cells[Math.min(BAG.slots - 1, start + n)] = c));
    return `<span class="bag-cells">${cells.map((c, n) => `<i class="${n < this.pouch ? "p" : ""}${c === "k" ? " k" : ""}"${c && c !== "k" ? ` style="--c:${c}"` : ""}></i>`).join("")}</span>`;
  }

  /** Other islands' owners by the id their squads and holds carry (a player's island code, or `ai-` and a game island's): their names in the raid's banners. */
  private rivalNames = new Map<string, string>();
  setRivalNames(names: Iterable<[string, string]>) {
    this.rivalNames = new Map(names);
  }
  addRivalNames(names: Iterable<[string, string]>) {
    for (const [k, v] of names) this.rivalNames.set(k, v);
  }

  /** Own outer hubs are island-shielded (作り順③) — map skips the dashed exposed ring. */
  setIslandShielded(on: boolean) {
    this.map.islandShielded = on;
    this.minimap.islandShielded = on;
  }

  setKnown(known: EntryId[]) {
    this.known = [...known];
    this.map.known = this.known;
  }

  /** `sub` is markup: an icon and a number at most, never a sentence. */
  banner(head: string, sub = "", good = false, time = 2.4) {
    $("banner-head").textContent = head;
    $("banner-sub").innerHTML = sub;
    $("banner").className = good ? "on good" : "on";
    this.bannerT = time;
  }

  /** `html`: a name or a number with its icon (icons.ts). */
  toast(html: string, rarity: number, ms = 2400) {
    const el = document.createElement("div");
    el.className = "toast";
    // A toast held longer than the default comes in as fast and fades at its own end.
    if (ms !== 2400) {
      el.classList.add("long");
      el.style.animationDuration = `${ms}ms`;
    }
    el.innerHTML = html;
    el.style.setProperty("--rc", RARITY_CSS[rarity]);
    $("toasts").appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  event(e: GameEvent, s: State) {
    switch (e.t) {
      case "hit": {
        // The teammate's hits are not the player's: no marker, no number.
        if (e.ally) break;
        this.hitT = 0.08;
        // A plate that turns the round aside shows no number: the sparks and the ping say it.
        if (e.blocked && !e.crit) {
          $("hitmark").className = "plate";
          break;
        }
        $("hitmark").className = e.crit ? "crit" : "";
        // Hits on the same robot in quick succession add up, for at most 1.2 s per number.
        const n = this.nums.find((x) => x.id === e.id && x.age < 0.4 && x.life < 1.2);
        if (n) {
          n.value += e.dmg;
          n.age = 0;
          n.pos = e.pos;
          n.crit = n.crit || e.crit;
          if (FLANK_RANK[e.flank] > FLANK_RANK[n.flank]) n.flank = e.flank;
          n.blocked = n.blocked || e.blocked;
        } else {
          const el = document.createElement("div");
          el.className = "dmg";
          this.dmgLayer.appendChild(el);
          this.nums.push({ el, id: e.id, pos: e.pos, value: e.dmg, age: 0, life: 0, crit: e.crit, flank: e.flank, blocked: e.blocked });
        }
        const cur = this.nums.find((x) => x.id === e.id && x.age === 0)!;
        const tag = FLANK_TAG[cur.flank];
        // A weak-point hit passes a plate in full, so a number with one is not shown as blocked.
        const plate = cur.blocked && !cur.crit;
        const tags = [cur.cut ? "阻止" : undefined, tag, plate ? "装甲" : undefined].filter(Boolean).join(" ");
        cur.el.innerHTML = `${tags ? `<small>${tags}</small>` : ""}${Math.round(cur.value)}`;
        cur.el.className = `dmg${cur.crit ? " crit" : ""}${tag ? " flank" : ""}${cur.flank === "front" ? " front" : ""}${plate ? " plate" : ""}`;
        cur.el.style.color = cur.crit ? "" : e.shield ? RARITY_CSS[e.tier] : UI.white;
        break;
      }
      case "stagger": {
        // Fire that knocks a robot out of its wind-up says so on its number.
        const n = e.interrupted ? this.nums.find((x) => x.id === e.id && x.age === 0) : undefined;
        if (n && !n.cut) {
          n.cut = true;
          n.el.insertAdjacentHTML("afterbegin", "<small>阻止</small>");
        }
        break;
      }
      case "kill":
        if (e.ally) {
          this.toast(`${ALLY.name}が撃破`, 0);
          break;
        }
        this.hitT = 0.4;
        $("hitmark").className = "kill";
        break;
      case "allyDown":
        this.banner(`${ALLY.name}がダウン`);
        break;
      case "allyUp":
        this.toast(e.by === "player" ? `${ALLY.name}を起こした` : `${ALLY.name}が起き上がった`, 1);
        break;
      case "allyRescue":
        this.banner(`${ALLY.name}に起こされた`, "", true, 1.8);
        break;
      // Down: the downed card under the crosshair says it, with its bar; no banner over it.
      case "awaitAlly":
        break;
      case "hurt": {
        this.hurtT = 0.5;
        const el = document.createElement("i");
        $("dmgdir").appendChild(el);
        this.dirs.push({ el, x: e.fromX, z: e.fromZ, t: 0.9 });
        break;
      }
      case "locked":
        this.toast(`${keyIcon()}${POIS[e.poi].name}<span class="toast-sub">${keyIcon()}▸${esc(keySource(e.poi))}の補給箱</span>`, 0, 3600);
        break;
      case "pickup":
        // Bag card (view/bag.ts) carries the detail; a short toast confirms the grab (Round 4 juice).
        if (e.kind === "shard") break;
        if (e.kind === "valuable" && e.valuable && s.goal === e.valuable && s.goalNeed > 0) {
          const inBag = s.player.haul.filter((k) => k === s.goal).length;
          const sent = s.sent.filter((k) => k === s.goal).length;
          const have = s.goalHave + inBag + sent;
          this.toast(`${TERM.goal} · ${esc(VALUABLES[e.valuable].label)} ${have} / ${s.goalNeed}`, e.rarity ?? 0, 2200);
          break;
        }
        if (["valuable", "tool", "key", "mod"].includes(e.kind)) {
          this.toast(esc(e.label), e.rarity ?? 0, 1600);
          break;
        }
        this.toast(`${e.label}${e.kind === "weapon" ? `（${RARITY.names[e.rarity]}）` : e.kind === "armor" ? `（${RARITY.names[e.rarity]}）` : ""}`, e.rarity);
        break;
      case "poiStart":
        {
          // What the POI's standing on the island means on arrival.
          const h = s.hold?.[e.poi] ?? "foe";
          const name = POIS[e.poi].name;
          if (POIS[e.poi].boss) this.banner(name);
          else this.banner(name, "", h === "own");
        }
        break;
      case "poiClear":
        this.banner(POIS[e.poi].boss ? `${POIS[e.poi].name} タイタン撃破` : `${POIS[e.poi].name} 掃討`, "", true, POIS[e.poi].boss ? 3.2 : 2.4);
        break;
      case "reinforce":
        this.banner("増援");
        // A node held that watches the sky shows where they came down (`UNLOCKS.scout`).
        if (heldUnlocks(s.nodes, "scout").length) this.scout = { x: e.x, z: e.z, until: s.time + SCOUT_SHOW };
        break;
      case "siegeWarn":
        // A wave of the siege is announced: its mark and which wave of how many; the beam and the arrow show where.
        this.toast(`${reinforceIcon()}<b>${e.wave}/${e.of}</b>`, 0, 3000);
        break;
      case "siegeLand":
        if (heldUnlocks(s.nodes, "scout").length) this.scout = { x: e.x, z: e.z, until: s.time + SCOUT_SHOW };
        break;
      case "raiders":
        this.banner("レイダー");
        break;
      case "shipCalled": {
        const x = EXTRACTS.find((o) => o.id === e.id)!;
        this.banner(x.short, `${clockIcon()}${x.call} 秒`);
        break;
      }
      case "shipLanded":
        this.banner(EXTRACTS.find((o) => o.id === e.id)!.short, checkIcon(), true);
        break;
      case "flareLit":
        this.toast(`${flareIcon(true)}発煙筒`, 3);
        break;
      case "careDrop":
        this.banner("補給ポッド", "", true);
        break;
      case "down":
        break;
      case "wipe":
        this.banner("行方不明");
        break;
      case "bossPhase":
        this.banner("タイタン 怒り状態");
        break;
      case "engage":
        if (!s.squads[e.squad]?.engaged) break;
        for (const r of s.enemies) if (r.squad === e.squad) this.spotted.set(r.id, 2.5);
        if (s.squads[e.squad].name !== "タイタン") this.toast(`${eyeIcon(UI.foeBright)}${s.squads[e.squad].name}`, 0);
        break;
      case "calm":
        this.toast(`${eyeIcon("currentColor", true)}見失わせた`, 1);
        break;
      case "tacticalMiss":
        this.toast(`${crossIcon()}アーク`, 0);
        break;
      case "leapBlocked":
        this.toast(`${crossIcon()}離脱ジャンプ`, 0);
        break;
      case "entryFound":
        // A way in found: the ring the map draws for it, dashed until a raid home makes it a start,
        // which the second line says: dashed ring, then solid ring, once the player gets off alive.
        if (!this.known.includes(e.id))
          this.toast(`${entryIcon(false)}${entryOf(e.id).name}<span class="toast-sub">${entryIcon(false)}▸${entryIcon(true)}生還で出撃地点に</span>`, 1, 6500);
        break;
      case "depotOn":
        this.toast(`${depotIcon()}${TERM.relayBox} · 起動した<span class="toast-sub">${esc(POIS[poiIndex(e.poi)].name)}</span>`, 1);
        break;
      case "deposit": {
        // Same use as 倉庫へ送る: island defence stock is automatic — show the result on the line.
        if (e.full && e.n === 0) {
          this.toast(`${depotIcon()}${PHRASE.relayWarehouseFull}`, 0, 3200);
          break;
        }
        const i = depotInReach(s);
        const place = i >= 0 ? POIS[poiIndex(DEPOTS[i].poi)].name : "";
        const left = e.left ? ` · ${e.left}${PHRASE.bagKept}` : "";
        const room = e.room != null ? ` · ${TERM.warehouse} あと ${e.room}` : "";
        this.toast(
          `${depotIcon()}${TERM.relayBox} · ${TERM.sendToWarehouse} ${e.n}点・${e.value}${room}${left}${place ? `<span class="toast-sub">${esc(place)}${PHRASE.islandGuardVia}</span>` : ""}`,
          3,
        );
        break;
      }
      case "leaveStart":
        this.toast(`${depotIcon()}${TERM.relayBox} · ${TERM.returningAlive}`, 1, 2500);
        break;
      case "leaveCancel":
        this.toast(`${depotIcon()}${TERM.relayBox}${crossIcon()}`, 0);
        break;
      case "coreStart": {
        const hub = NODES[e.node].name;
        const whoHub = rivalWhoHub(s.nodes[e.node], hub, this.rivalNames);
        this.toast(
          `${coreIcon(foeSide(s.nodes[e.node]))}${whoHub ? esc(attackCapturePrompt(whoHub)) : `${TERM.captureCore} ${esc(hub)}`}`,
          0,
          3000,
        );
        break;
      }
      case "coreShielded":
        this.toast(`${coreIcon(foeSide(s.nodes[e.node]), true)}${NODES[e.node].name}<span class="toast-sub">先に${esc(shieldedBy(s.nodes, e.node))}を制圧</span>`, 0, 4000);
        break;
      case "momentum":
        // The raid's momentum rose: that many marks, and what the next node pays.
        this.toast(`${upIcon().repeat(e.level)}<b>${MOMENTUM.spoils[Math.min(e.level, MOMENTUM.spoils.length) - 1].toLocaleString()}</b>`, 3, 4000);
        break;
      case "coreTaken": {
        // e.node is a NODES index; s.hold is per POI (who held it when the raid began).
        const hub = NODES[e.node];
        const startHold = s.hold?.[poiIndex(hub.id)] ?? "foe";
        const whoHub = rivalWhoHub(startHold, hub.name, this.rivalNames);
        if (whoHub) {
          this.toast(`${coreIcon(SIDE.own)}${esc(attackSeized(whoHub))}<span class="toast-sub">倉庫へ届く</span>`, 1, 5000);
          break;
        }
        this.toast(`${coreIcon(SIDE.own)}${esc(`制圧した · ${hub.name}`)}`, 1, 5000);
        break;
      }
      case "counter":
        // The enemy sets off to take back a node: its landing's mark and the node's blue core.
        this.toast(`${reinforceIcon()}${coreIcon(SIDE.own)}${NODES[e.node].name}`, 0, 4000);
        break;
      case "landing": {
        // Another island's expedition coming down: whose, and the node it is sent at.
        const q = s.battle?.squads.find((x) => x.side === 3 && Math.abs(x.x - e.x) < 0.5 && Math.abs(x.z - e.z) < 0.5);
        if (!q) break;
        const who = this.rivalNames.get(q.owner ?? "") ?? "他のプレイヤー";
        const to = NODES[q.via.length ? q.via[q.via.length - 1] : q.to]?.name ?? "";
        this.banner(`${who}の遠征隊`, `${coreIcon(SIDE.rival)}${esc(to)}へ${e.boat ? "上陸" : "降下"}`);
        break;
      }
      case "nodeTaken": {
        const name = NODES[e.node].name;
        const owner = rivalOf(s.nodes[e.node] ?? "foe");
        // A holding of the player's the enemy took goes by an AI player's name (決定 B: only other players take holdings).
        if (e.by !== undefined) this.toast(`${coreIcon(SIDE.rival)}${name}<span class="toast-sub">${esc(this.rivalNames.get(e.by) ?? "他のプレイヤー")}が制圧</span>`, 0, 4000);
        else if (e.side === 3) this.toast(`${coreIcon(SIDE.rival)}${name}<span class="toast-sub">${esc(owner !== null ? (this.rivalNames.get(owner) ?? "他のプレイヤー") : "他のプレイヤー")}が制圧</span>`, 0, 4000);
        else this.toast(`${coreIcon(e.side === 0 ? SIDE.own : SIDE.enemy)}${name}`, e.side === 0 ? 1 : 0, 4000);
        break;
      }
      case "timeUp":
        this.banner("時間切れ");
        break;
      case "ultReady":
        this.toast(isTouch() ? "離脱ジャンプ" : "<kbd>Z</kbd> 離脱ジャンプ", 3);
        break;
    }
  }

  /** The player's count the HUD's bar shows, the count it slides from, and the raid time the slide began. */
  private rowOwn = -1;
  private rowFrom = 0;
  private rowAt = -9;

  /** The island's tug of war under the compass: blue as the player takes nodes, pulsing where the enemy is about to take one. */
  private islandRow(s: State) {
    const own = s.nodes.filter((h) => h === "own").length;
    const b = s.battle;
    const risk = s.phase === "play" ? atRisk(s).filter(Boolean).length : 0;
    const contested = s.phase === "play" && (!!s.capture || !!b?.meter.some((m) => m));
    if (own !== this.rowOwn) {
      // A changed count slides from where it was for a moment, then rests (a new raid starts at rest).
      this.rowFrom = this.rowOwn < 0 || s.time < 1 ? own : this.rowOwn;
      this.rowOwn = own;
      this.rowAt = s.time;
    }
    const from = s.time - this.rowAt < 2 && s.time >= this.rowAt ? this.rowFrom : own;
    // The raid's momentum beside the bar: a mark for each node taken after the first.
    const row = nodeRow(s.nodes, undefined, { from, risk, contested }) + (momentum(s) ? `<span class="momentum">${upIcon().repeat(momentum(s))}</span>` : "");
    const el = $("island-row");
    if (el.dataset.html !== row) {
      el.dataset.html = row;
      el.innerHTML = row;
    }
    // Calm days: the bar stays readable but does not compete with the objective (ux-design I4).
    el.classList.toggle("calm", !risk && !contested);
  }

  frame(s: State, view: World, dt: number, w: number, h: number) {
    const p = s.player;
    // The minimap, while the map is shut and the corner shows it (offsetParent is null while display: none).
    // About 3 Hz is enough to track the player; redrawing the 2D island more often only costs the main thread.
    if (!this.mapOpen && (this.miniT -= dt) <= 0 && $("minimap").offsetParent) {
      this.miniT = 0.35;
      this.minimap.draw({ ...s, names: [] });
    }
    if (this.mapOpen) {
      if (s.phase === "done") this.toggleMap(false);
      else {
        this.map.draw({ ...s });
        // The key names another player only while one holds a node or has a squad on the island.
        const rivals = s.nodes.some((h) => rivalOf(h) !== null) || !!s.battle?.squads.some((q) => q.side === 3);
        document.querySelectorAll<HTMLElement>("#map .map-rival").forEach((el) => {
          if (el.hidden === rivals) el.hidden = !rivals;
        });
      }
    }

    // Objective card: the objective's current step, large, what finishes it and how far it has
    // gone under it, and the step's place in the list (sim/objective.ts).
    const obj = objectiveSteps(s, this.task);
    this.obj = obj;
    const step = currentStep(obj);
    let text = "";
    if (p.leap) text = isTouch() ? "滑空中：スティックで着地点を選ぶ" : "滑空中：WASD で着地点を選ぶ";
    else if (s.phase === "done") text = s.home ? "帰った" : s.outcome === "extracted" ? "生還" : "行方不明";
    else text = step?.label ?? "探索して脱出せよ";
    setText($("obj-text"), text);
    setText($("obj-title"), obj.title);
    setText($("obj-n"), `${Math.min(obj.current + 1, obj.steps.length)}/${obj.steps.length}`);
    // Under the step only how far it has gone, as a number; what the step asks is its label and the beacon.
    setHtml($("obj-until"), s.phase === "play" && step ? this.stepProgress(s, step) : "");
    // A step done moves the card on to the next, told with a short toast.
    const key = `${obj.title}|${obj.current}`;
    if (this.lastStep && key !== this.lastStep && s.phase === "play" && step && this.lastStep.split("|")[0] === obj.title) this.toast(`${TERM.nextHand}${step.label}`, 3, 2600);
    this.lastStep = key;
    view.setBeacon(s.phase === "play" ? (step?.at ?? null) : null);
    // The use key's focused target: one ring in the world, matching the prompt.
    view.setUseMark(s.phase === "play" ? useFocusMark(s) : null);
    // Compass: hunt goal when set (タイタン 474 m), else the objective step. Capture / defend /
    // keep the objective's spot (design-direction 目標への案内).
    const hunt = s.phase === "play" && !compassUrgent(s) ? huntSpot(s) : null;
    this.compassMark(s, hunt ?? step?.at ?? null, hunt?.label ?? null);
    const bagCells = this.bagCells(p);
    this.bag.frame(s, dt, bagCells);
    // Worth only once something is carried: an empty "回収 0" is noise on a fresh spawn.
    const worth = haulAndSentWorth(s);
    setHtml($("obj-bag"), `バッグ ${bagCells}${bagLoad(p)}/${BAG.slots}${worth ? `<span class="worth">・回収 ${worth}</span>` : ""}`);
    // The raid's deadline is the battle's end (past it the raid ends as a wipe), as a clock; the next
    // reinforcements as their mark and seconds; a raid above 強度 0 says so first.
    const left = s.battle ? Math.max(0, s.battle.end - s.time) : s.sortie ? Math.max(0, s.sortie.end - s.time) : null;
    const raid = (s.threat ? `<span>強度 <b>${s.threat}</b></span>` : "") + (s.phase === "play" && left !== null ? `<span class="deadline">${clockIcon()}<b>${clock(left)}</b></span>` : "");
    const next = s.phase !== "play" || s.reinforceT >= 60 ? "" : `<span class="reinforce${s.reinforceT > 0 ? "" : " now"}">${reinforceIcon()}${s.reinforceT > 0 ? `<b>${Math.ceil(s.reinforceT)}</b>` : ""}</span>`;
    setHtml($("obj-raid"), raid + next);
    $("obj-raid").classList.toggle("late", left !== null && left < 120);
    this.islandRow(s);


    // Compass: 2 px per degree, centred on the current heading.
    const heading = ((((p.yaw * 180) / Math.PI) % 360) + 360) % 360;
    // Hidden, the compass measures 0: measured again each frame until it is shown.
    if (!this.compassHalf) this.compassHalf = $("compass").clientWidth / 2;
    const half = this.compassHalf;
    $("compass-strip").style.transform = `translateX(${half - (heading + 360) * 2}px)`;
    this.placeMark(heading, half);
    this.placeScout(s, heading, half);
    this.placePing(s, heading, half);
    this.exits(s);

    // Vitals.
    const maxShield = PLAYER.shieldByTier[p.armor];
    const cellsN = maxShield / 25;
    const cellsEl = $("shield-cells");
    if (cellsN !== this.lastCells) {
      cellsEl.innerHTML = "";
      this.shieldCells = [];
      for (let i = 0; i < cellsN; i++) {
        const c = document.createElement("i");
        const f = document.createElement("span");
        c.appendChild(f);
        cellsEl.appendChild(c);
        this.shieldCells.push(f);
      }
      this.lastCells = cellsN;
    }
    cellsEl.style.setProperty("--sc", RARITY_CSS[p.armor]);
    this.shieldCells.forEach((f, i) => (f.style.width = `${Math.max(0, Math.min(1, (p.shield - i * 25) / 25)) * 100}%`));
    $("hp-fill").style.width = `${(p.hp / PLAYER.hp) * 100}%`;
    $("hp").className = p.hp < 35 ? "low" : "";
    for (const k of HEAL_KINDS) setText($(`n-${k}`), String(p.heals[k]));
    // The mod parts worn, oldest first (the one a full set swaps out), with an empty frame per free slot.
    setHtml($("mods"), Array.from({ length: MOD.slots }, (_, i) => (p.mods[i] ? `<i title="${esc(MODS[p.mods[i]].note)}">${esc(MODS[p.mods[i]].short)}</i>` : `<i class="free"></i>`)).join(""));

    // Abilities.
    const tac = $("ab-tac");
    tac.style.setProperty("--p", String(1 - p.tactical / tacticalCooldown(p)));
    tac.className = p.tactical <= 0 ? "ab ready" : "ab cool";
    const ult = $("ab-ult");
    ult.style.setProperty("--p", String(p.ult));
    ult.className = p.ult >= 1 ? "ab ult ready" : "ab ult";
    const ultPct = p.ult >= 1 ? "離脱" : `${Math.floor(p.ult * 100)}%`;
    setText($("ult-pct"), ultPct);
    $("fx-ult").style.opacity = p.leap ? "1" : "0";
    // Streaks at the edges past a sprint's speed: a slide-jump faintly, a zipline fully; calmer on a phone.
    const fast = Math.max(0, Math.min(1, (Math.hypot(p.vel.x, p.vel.y * (p.zip ? 1 : 0), p.vel.z) - PLAYER.sprint - 1) / 9));
    $("fx-speed").style.opacity = (fast * (isTouch() ? 0.35 : 0.7)).toFixed(2);
    // The same charge on the touch buttons.
    const tTac = $("t-tac");
    tTac.style.setProperty("--p", String(1 - p.tactical / tacticalCooldown(p)));
    tTac.classList.toggle("ready", p.tactical <= 0);
    const tUlt = $("t-ult");
    tUlt.style.setProperty("--p", String(p.ult));
    tUlt.classList.toggle("ready", p.ult >= 1);
    setText($("t-ult-pct"), ultPct);
    setText($("t-cells"), pickHeal(s) ? String(HEAL_KINDS.reduce((n, k) => n + p.heals[k], 0)) : "-");

    // Weapons.
    p.weapons.forEach((wpn, i) => {
      const el = $(`slot-${i}`);
      if (!wpn) {
        el.className = "slot empty";
        return;
      }
      const size = magSize(wpn);
      const mag = wpn.mag < 0 ? size : wpn.mag;
      el.className = `slot${i === p.slot ? " active" : ""}${mag <= size * 0.25 ? " low" : ""}`;
      el.style.setProperty("--rc", RARITY_CSS[wpn.rarity]);
      setText(el.querySelector(".name") as HTMLElement, `${i + 1}  ${WEAPONS[wpn.kind].name}`);
      setText(el.querySelector(".ammo b") as HTMLElement, p.reload > 0 && i === p.slot ? "…" : String(mag));
      setText(el.querySelector(".ammo small") as HTMLElement, `/${size}`);
    });

    // Crosshair spreads with movement and hip fire.
    const wpn = p.weapons[p.slot];
    const spec = wpn ? WEAPONS[wpn.kind] : WEAPONS.pike;
    const spread = 6 + (spec.hipSpread * (1 - p.ads) + Math.hypot(p.vel.x, p.vel.z) * 0.25) * 4 + p.recoil * 6;
    const xh = $("xhair");
    const xs = xh.children as HTMLCollectionOf<HTMLElement>;
    xs[0].style.top = `${-spread - 8}px`;
    xs[1].style.top = `${spread}px`;
    xs[2].style.left = `${-spread - 8}px`;
    xs[3].style.left = `${spread}px`;
    xh.style.display = p.ads > 0.6 && spec.adsSpread === 0 ? "none" : "";
    $("scope").classList.toggle("on", !!spec.scope && p.ads > SCOPE_IN && p.downed <= 0);
    this.hitT = Math.max(0, this.hitT - dt);
    $("hitmark").style.opacity = this.hitT > 0 ? "1" : "0";

    // Interaction prompt.
    const prompt = this.prompt(s);
    setHtml($("prompt"), prompt);
    // On a cable the prompt only tells where it goes: the jump button lets go, the use button has nothing to do.
    const useBtn = $("t-use");
    useBtn.hidden = prompt === "" || !!s.player.zip;
    const cycleBtn = $("t-cycle");
    if (cycleBtn) {
      const many = !!useTarget(s) && useCandCount(s) > 1 && !s.player.zip && s.phase === "play" && s.player.downed <= 0;
      cycleBtn.hidden = !many || useBtn.hidden;
    }

    // Damage numbers.
    this.nums = this.nums.filter((n) => {
      n.age += dt;
      n.life += dt;
      if (n.age > 0.9) {
        n.el.remove();
        return false;
      }
      const sp = view.project(n.pos, w, h);
      n.el.style.display = sp.behind ? "none" : "";
      n.el.style.left = `${sp.x + 18}px`;
      n.el.style.top = `${sp.y - 20 - n.age * 50}px`;
      n.el.style.opacity = String(Math.min(1, (0.9 - n.age) * 4));
      return true;
    });

    // Bars over recently hit robots.
    const seen = new Set<number>();
    for (const e of s.enemies) {
      if (e.lastHit > 3 || e.kind === "titan") continue;
      seen.add(e.id);
      let el = this.barEls.get(e.id);
      if (!el) {
        el = document.createElement("div");
        el.className = "ebar";
        el.innerHTML = `<i class="sh"><span></span></i><i class="hpb"><span></span></i>`;
        this.bars.appendChild(el);
        this.barEls.set(e.id, el);
      }
      const k = ENEMIES[e.kind];
      const sp = view.project({ x: e.pos.x, y: e.pos.y + weakY(e) + 0.7, z: e.pos.z }, w, h);
      el.style.display = sp.behind ? "none" : "";
      el.style.left = `${sp.x}px`;
      el.style.top = `${sp.y}px`;
      const spans = el.querySelectorAll<HTMLElement>("span");
      const sh = spans[0];
      const hp = spans[1];
      sh.style.width = `${(e.shield / Math.max(1, enemyShield(e))) * 100}%`;
      sh.style.background = RARITY_CSS[k.shieldTier];
      (sh.parentElement as HTMLElement).style.display = k.shield > 0 ? "" : "none";
      hp.style.width = `${(Math.max(0, e.hp) / enemyHp(e)) * 100}%`;
    }
    // The titan's bar sits at the top of the screen like a boss bar, once it wakes.
    const titan = s.enemies.find((e) => e.kind === "titan" && e.mode !== "spawning" && e.aware === "engaged");
    let boss = this.barEls.get(-1);
    if (titan) {
      if (!boss) {
        boss = document.createElement("div");
        boss.className = "ebar";
        boss.style.cssText = "left:50%;top:70px;width:min(520px,60vw);transform:translateX(-50%)";
        boss.innerHTML = `<i class="sh" style="height:8px"><span></span></i><i class="hpb" style="height:10px"><span></span></i>`;
        this.bars.appendChild(boss);
        this.barEls.set(-1, boss);
      }
      const spans = boss.querySelectorAll<HTMLElement>("span");
      const sh = spans[0];
      const hp = spans[1];
      sh.style.width = `${(titan.shield / ENEMIES.titan.shield) * 100}%`;
      sh.style.background = RARITY_CSS[3];
      hp.style.width = `${(Math.max(0, titan.hp) / ENEMIES.titan.hp) * 100}%`;
      seen.add(-1);
    }
    for (const [id, el] of this.barEls)
      if (!seen.has(id)) {
        el.remove();
        this.barEls.delete(id);
      }

    this.awareness(s, view, dt, w, h);
    this.threatMarks(s, view, w, h);

    // Damage direction arcs.
    this.dirs = this.dirs.filter((d) => {
      d.t -= dt;
      if (d.t <= 0) {
        d.el.remove();
        return false;
      }
      const bearing = Math.atan2(d.x - p.pos.x, -(d.z - p.pos.z));
      const rel = bearing - p.yaw;
      d.el.style.transform = `rotate(${rel}rad) translateY(-150px)`;
      d.el.style.opacity = String(Math.min(1, d.t * 2));
      return true;
    });
    this.hurtT = Math.max(0, this.hurtT - dt);
    $("fx-hurt").style.opacity = String(Math.max(this.hurtT * 1.6, p.hp < 35 ? 0.5 : 0, p.downed > 0 ? 0.9 : 0));

    // Downed / healing progress.
    $("downed").className = p.downed > 0 ? "on" : "";
    if (p.awaitAlly) {
      const a = s.ally;
      $("downed-sub").innerHTML = a.rescue > 0 ? `${reviveIcon()}${ALLY.name}` : `${ALLY.name} ${clockIcon()}${Math.ceil(p.downed)}`;
      $("downed-bar").style.width = `${(a.rescue / reviveTime(p)) * 100}%`;
    } else {
      $("downed-sub").textContent = "";
      $("downed-bar").style.width = `${(1 - p.downed / PLAYER.downedTime) * 100}%`;
    }
    this.mate(s, view, w, h);
    $("battery").className = p.healing ? "on" : "";
    if (p.healing) {
      $("heal-label").textContent = HEALS[p.healing.kind].label;
      $("battery-bar").style.width = `${(1 - p.healing.t / healTime(p, p.healing.kind)) * 100}%`;
      $("battery-bar").style.background = HEALS[p.healing.kind].shield ? "" : "var(--hp-heal)";
    }

    this.bannerT -= dt;
    if (this.bannerT <= 0) $("banner").className = "";
  }


  /**
   * A pulsing red arrow for each node of the player's the enemy's robots have come to: over its
   * core when the core is on screen, otherwise at the screen's edge, pointing the way to it.
   */
  private threatMarks(s: State, view: World, w: number, h: number) {
    const b = s.battle;
    // Kept clear of the compass at the top and the buttons along the bottom.
    const M = 46;
    const TOP = 110;
    const BOTTOM = 140;
    const mark = (key: number, on: boolean, strong: boolean, at: { x: number; y: number; z: number }) => {
      let el = this.threatEls.get(key);
      if (!on) {
        if (el) el.style.display = "none";
        return;
      }
      if (!el) {
        el = document.createElement("div");
        this.awareLayer.appendChild(el);
        this.threatEls.set(key, el);
      }
      el.className = strong ? "threat-mark" : "threat-mark coming";
      const sp = view.project(at, w, h);
      let x = sp.x;
      let y = sp.y;
      let angle = 180;
      const cy = (TOP + h - BOTTOM) / 2;
      if (sp.behind || x < M || x > w - M || y < TOP || y > h - BOTTOM) {
        // Off screen: on the edge, the way to it from the middle of the screen.
        let dx = x - w / 2;
        let dy = y - cy;
        if (sp.behind) {
          dx = -dx;
          dy = Math.abs(dy) + h;
        }
        const k = Math.min((w / 2 - M) / (Math.abs(dx) || 1e-6), ((h - BOTTOM - TOP) / 2) / (Math.abs(dy) || 1e-6));
        x = w / 2 + dx * k;
        y = cy + dy * k;
        angle = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
      }
      el.style.display = "";
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      el.style.setProperty("--a", `${angle.toFixed(0)}deg`);
    };
    // A counter-attack's squad ashore and walking to a node of the player's: the arrow, fainter, before it gets there.
    const coming = countered(s);
    NODES.forEach((n, i) => {
      const at = !!b && b.threat[i];
      mark(i, (at || coming[i]) && s.phase === "play", at, { x: n.core.x, y: n.core.y + FRONT.height + 2.5, z: n.core.z });
    });
    // A wave of the siege announced: the same arrow, fainter, over the beam its squad will step out of.
    const wave = s.phase === "play" ? s.capture?.coming : null;
    mark(-1, !!wave, false, wave ? { x: wave.x, y: terrainHeight(wave.x, wave.z) + 6, z: wave.z } : { x: 0, y: 0, z: 0 });
  }

  /**
   * A mark over each robot that knows something, pinned to the screen edge when it
   * is off screen, so the player always sees who is about to spot them. While the
   * arc reveal runs, every robot in range gets a red diamond, walls or not.
   */
  private awareness(s: State, view: World, dt: number, w: number, h: number) {
    const p = s.player;
    const seen = new Set<number>();
    let worst = 0; // 0 none, 1 noticing, 2 alert, 3 engaged
    let near = false;
    let tracked = false; // some fighting squad sees the player right now
    let anyLost = false; // some fighting squad has lost them
    for (const [id, t] of this.spotted) if (t - dt <= 0) this.spotted.delete(id);
    else this.spotted.set(id, t - dt);
    if (s.phase === "play") {
      for (const e of s.enemies) {
        if (e.mode === "spawning") continue;
        const d = dist2d(e.pos, p.pos);
        if (d < 50) near = true;
        // An engaged robot whose squad has lost sight of the player is looking at the wrong place.
        const lost = e.aware === "engaged" && (s.squads[e.squad]?.sinceSeen ?? 0) >= AWARE.trackTime;
        if (e.aware === "engaged" && !lost) tracked = true;
        if (lost) anyLost = true;
        const level = e.aware === "engaged" ? 3 : e.aware === "alert" ? 2 : e.detect > 0.02 ? 1 : 0;
        worst = Math.max(worst, level);
        const revealed = p.reveal > 0 && d < REVEAL.range;
        const bang = this.spotted.has(e.id);
        let cls = "";
        if (bang) cls = "engaged";
        else if (lost) cls = "lost";
        else if (level === 2) cls = "alert";
        else if (level === 1) cls = "sense";
        else if (revealed) cls = "reveal";
        // A mark sits only over a robot the player can see, and near: it tells how aware that
        // robot is, never where an unseen one stands. The reveal is the exception: while it lasts,
        // every robot in its range shows through walls, with the reveal's mark when out of sight.
        if (!cls || e.kind === "titan") continue;
        if (cls !== "reveal") {
          const head = { x: e.pos.x, y: e.pos.y + weakY(e), z: e.pos.z };
          const inSight = d <= MARK_RANGE && los(eyePos(s), head);
          if (!inSight && revealed) cls = "reveal";
          else if (!inSight) continue;
        }
        const top = cls === "reveal" ? weakY(e) : weakY(e) + 1.4;
        const sp = view.project({ x: e.pos.x, y: e.pos.y + top, z: e.pos.z }, w, h);
        if (sp.behind || sp.x < 0 || sp.x > w || sp.y < 0 || sp.y > h) continue;
        seen.add(e.id);
        let el = this.awEls.get(e.id);
        if (!el) {
          el = document.createElement("div");
          this.awareLayer.appendChild(el);
          this.awEls.set(e.id, el);
        }
        const x = sp.x;
        const y = sp.y;
        el.className = `aw ${cls}`;
        el.textContent = cls === "engaged" ? "!" : cls === "alert" || cls === "lost" ? "?" : "";
        el.style.setProperty("--p", e.detect.toFixed(2));
        el.style.display = "";
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
      }
    }
    for (const [id, el] of this.awEls)
      if (!seen.has(id)) {
        el.remove();
        this.awEls.delete(id);
      }

    // One line under the objective: how hidden the player is, only once a robot has noticed them.
    // "未発見" while calm is noise; empty means calm (docs/ringfall/ux-design.md).
    const st = $("obj-stealth");
    const word =
      s.phase !== "play" || !near || worst === 0
        ? ""
        : worst === 3 && !tracked && anyLost
          ? "見失わせた"
          : worst === 3
            ? "交戦"
            : worst === 2
              ? "警戒"
              : "見られている";
    setHtml(st, word ? `${eyeIcon("currentColor", worst === 3 && !tracked && anyLost)}${word}` : "");
    st.className = worst === 3 && !tracked && anyLost ? "lost" : worst === 3 ? "engaged" : worst === 2 ? "alert" : "";
    // Calm fold (ux-design Round 8): primary step stays; exits / stealth already empty when quiet.
    const late = s.battle ? s.battle.end - s.time < 120 : false;
    $("objective").classList.toggle("calm", s.phase === "play" && !word && !$("obj-exits").innerHTML && !late);
  }

  /**
   * Extraction points of the region the player is in: a line each on the objective card with
   * its condition, and no distance or marker; where they are is on the map (M).
   */
  private exits(s: State) {
    const p = s.player;
    if (s.phase !== "play") {
      setHtml($("obj-exits"), "");
      return;
    }
    const lines: string[] = [];
    const exits = regionHere(p.pos).exits.map((id) => EXTRACTS.find((x) => x.id === id)!);
    // The phone layout keeps only a live exit's line (style.css), so the card stays above the vitals; `near` marks the nearest for the desktop.
    const nearest = exits.reduce((best, x, i) => (dist2d(p.pos, x) < dist2d(p.pos, exits[best]) ? i : best), 0);
    // Each way off by how it works, in a mark and seconds: a craft to call (the seconds it takes,
    // counting down once called, a tick once landed), a flare (lit when carried) and the seconds to
    // wait, or only the wait.
    let anyLive = false;
    exits.forEach((x, i) => {
      const ready = extractReady(s, x);
      const left = callLeft(s, x.id);
      const state = x.call
        ? left < 0
          ? `${callIcon()}${x.call} 秒`
          : left > 0
            ? `${clockIcon()}<em>${Math.ceil(left)}</em>`
            : checkIcon()
        : x.needsFlare
          ? `${flareIcon(p.flares > 0)}${x.hold} 秒`
          : `${clockIcon()}${x.hold} 秒`;
      const locked = x.needsFlare && !ready;
      // A called ship or a flare in hand is news (ui.md): calm days hide the rest (Round 8 fold).
      const live = (x.call && left >= 0) || (x.needsFlare && ready);
      if (live) anyLive = true;
      const cls = [locked && "locked", i === nearest && "near", live && "live"].filter(Boolean).join(" ");
      lines.push(`<div class="${cls}">${exitIcon()}<b>${x.short}</b><span>${state}</span></div>`);
    });
    // Fold: only live exits stay on the card; the map (M) holds the rest.
    setHtml($("obj-exits"), anyLive ? lines.join("") : "");
  }

  /** The teammate's row on the vitals plate and the tag over its head. */
  private mate(s: State, view: World, w: number, h: number) {
    const a = s.ally;
    const p = s.player;
    const row = $("mate");
    row.hidden = !a.active;
    const tag = $("mate-tag");
    if (!a.active || s.phase === "done") {
      tag.style.display = "none";
      return;
    }
    const down = a.down > 0;
    // What the teammate is doing, as a mark: a red cross and its seconds while down (a percentage
    // while being picked up), the first-aid cross while it comes for the player, the crosshair while
    // it fights, nothing while it follows.
    const state = down
      ? a.helped > 0
        ? `${reviveIcon()}${Math.floor((a.helped / helpTime(s.player)) * 100)}%`
        : `${crossIcon()}${Math.ceil(a.down)}`
      : a.rescue > 0 || (p.downed > 0 && p.awaitAlly)
        ? reviveIcon()
        : a.target
          ? fightIcon()
          : "";
    setHtml($("mate-state"), state);
    row.className = down ? "down" : "";
    $("mate-sh").style.width = `${(a.shield / ALLY.shield) * 100}%`;
    $("mate-hp").style.width = `${(a.hp / ALLY.hp) * 100}%`;
    // Over its head: always when down (through walls), otherwise only when it is a few metres off.
    const d = dist2d(a.pos, p.pos);
    const sp = view.project({ x: a.pos.x, y: a.pos.y + (down ? 1.3 : 2.15), z: a.pos.z }, w, h);
    // Down, it is pinned to the screen edge when out of view.
    let x = sp.x;
    let y = sp.y;
    if (down && sp.behind) {
      x = w - x;
      y = h - 160;
    }
    if (down) {
      x = Math.max(50, Math.min(w - 50, x));
      y = Math.max(110, Math.min(h - 160, y));
    }
    const show = (down || (!sp.behind && d > 7)) && p.ads < 0.5;
    tag.style.display = show ? "flex" : "none";
    if (show) {
      tag.style.left = `${x}px`;
      tag.style.top = `${y}px`;
      tag.className = down ? "down" : "";
      $("mate-tag-sub").textContent = down ? (a.helped > 0 ? `${Math.floor((a.helped / helpTime(s.player)) * 100)}%` : `ダウン ${Math.round(d)}m`) : `${Math.round(d)}m`;
    }
  }

  /** The objective as last drawn: its title, the step it is on, and each step's words, spot and state (for automation). */
  objective() {
    const o = this.obj;
    return o && { title: o.title, current: o.current, steps: o.steps.map((st) => ({ label: st.label, until: st.until, progress: st.progress ?? null, at: st.at && { x: +st.at.x.toFixed(1), y: +st.at.y.toFixed(1), z: +st.at.z.toFixed(1) }, done: st.done })) };
  }

  /** Where the compass marker points: bearing, metres, and an optional hunt label (タイタン). */
  private mark: { bearing: number; d: number; label: string | null } | null = null;

  private compassMark(s: State, at: { x: number; z: number } | null, label: string | null = null) {
    const p = s.player.pos;
    // Standing at the place already, the marker would only point at the player's feet.
    this.mark =
      at && s.phase === "play" && dist2d(p, at) > 8
        ? { bearing: (((Math.atan2(at.x - p.x, -(at.z - p.z)) * 180) / Math.PI) % 360 + 360) % 360, d: dist2d(p, at), label }
        : null;
  }

  /** Where the last reinforcements beamed in, and until when the compass shows it; null for none. */
  private scout: { x: number; z: number; until: number } | null = null;

  /** The red chevron on the compass toward the last reinforcements' landing, held at the strip's edge when behind. */
  private placeScout(s: State, heading: number, half: number) {
    const el = $("compass-scout");
    const at = this.scout && s.phase === "play" && s.time < this.scout.until ? this.scout : null;
    el.hidden = !at;
    if (!at) return;
    const p = s.player.pos;
    const bearing = ((((Math.atan2(at.x - p.x, -(at.z - p.z)) * 180) / Math.PI) % 360) + 360) % 360;
    const rel = ((bearing - heading + 540) % 360) - 180;
    const max = (half * 0.62) / 2;
    const off = Math.max(-max, Math.min(max, rel));
    el.style.left = `${half + off * 2}px`;
    el.classList.toggle("edge", off !== rel);
  }

  /**
   * The compass marker: hunt goal (タイタン 474 m) or the objective step's distance, held at the
   * strip's edge when behind. A local ping (P) is a separate faint mark (`placePing`).
   */
  private placeMark(heading: number, half: number) {
    const el = $("compass-mark");
    el.hidden = !this.mark;
    if (!this.mark) return;
    const rel = ((this.mark.bearing - heading + 540) % 360) - 180;
    const max = (half * 0.62) / 2;
    const off = Math.max(-max, Math.min(max, rel));
    el.style.left = `${half + off * 2}px`;
    el.classList.toggle("edge", off !== rel);
    el.classList.toggle("hunt", !!this.mark.label);
    const metres = Math.round(this.mark.d);
    const label = this.mark.label ? goalCompass(this.mark.label, metres) : `${metres}m`;
    if (el.firstElementChild!.textContent !== label) el.firstElementChild!.textContent = label;
  }

  /** The local look-ping on the compass strip; cleared when its timer ends. */
  private placePing(s: State, heading: number, half: number) {
    const el = $("compass-ping");
    const live = this.ping && performance.now() < this.ping.until ? this.ping : null;
    if (!live) {
      this.ping = null;
      this.map.ping = null;
      el.hidden = true;
      return;
    }
    if (s.phase !== "play") {
      el.hidden = true;
      return;
    }
    const p = s.player.pos;
    const bearing = ((((Math.atan2(live.x - p.x, -(live.z - p.z)) * 180) / Math.PI) % 360) + 360) % 360;
    const rel = ((bearing - heading + 540) % 360) - 180;
    const max = (half * 0.62) / 2;
    const off = Math.max(-max, Math.min(max, rel));
    el.hidden = false;
    el.style.left = `${half + off * 2}px`;
    el.classList.toggle("edge", off !== rel);
  }

  /**
   * How far the objective's current step has gone, as a number: a capture's seconds (orange while
   * it stands still), or the step's own count (`Step.progress`). A step with nothing to count shows
   * nothing; its label and the beacon say what it asks.
   */
  private stepProgress(s: State, step: Step): string {
    if (step.kind === "hold") {
      const c = s.capture;
      // The meter, and the waves of the siege called so far of the node's.
      const waves = c ? `${reinforceIcon()}${c.waves}/${siegeWaves(s, c.node).length}` : "";
      return `<b class="${c && !c.held ? "paused" : ""}">${Math.floor(c?.t ?? 0)}/${FRONT.capture}</b>${waves}`;
    }
    return step.progress ? `<b>${esc(step.progress)}</b>` : "";
  }

  /**
   * The use key's prompt: what pressing it does, with a name and a number, or why it does nothing,
   * as a mark. Never a sentence on how a mechanic works.
   */
  private prompt(s: State): string {
    const p = s.player;
    if (p.downed > 0 || s.phase !== "play") return "";
    if (s.leaving) return `${depotIcon()}${TERM.relayBox} · 生還まで <b>${Math.max(0, s.leaving.t).toFixed(1)}</b>`;
    // On a cable: where it goes and the metres left.
    if (p.zip) {
      const l = ZIPS[p.zip.line];
      return `${zipIcon(l.fixed ? UI.mist : undefined)}${esc(zipEndName(p.zip.dir > 0 ? l.b : l.a))} <b>${Math.round(p.zip.dir > 0 ? l.length - p.zip.at : p.zip.at)}</b> m`;
    }
    // The use key comes first: picking the teammate up or opening a bin works inside an extraction point too.
    const t = useTarget(s);
    // When several overlap, T (or the touch cycle button) cycles the sticky focus.
    const many = !!t && useCandCount(s) > 1;
    const tip = (html: string) => (many ? `${html}<i class="cycle">${isTouch() ? "切替" : "<kbd>T</kbd>"}</i>` : html);
    const x = t ? null : extractHere(s);
    if (x) {
      if (x.call && callLeft(s, x.id) > 0) return `${exitIcon()}${x.short} ${clockIcon()}<b>${Math.ceil(callLeft(s, x.id))}</b>`;
      if (x.needsFlare && p.flares <= 0) return `${exitIcon()}${x.short} ${flareIcon(false)}${crossIcon()}`;
      return `${exitIcon()}${x.short} <b>${Math.floor((s.extractTime / x.hold) * 100)}%</b>`;
    }
    const struck = (names: string[]) => names.map((n) => `<s>${esc(n)}</s>`).join("");
    // The same choice the use key acts on (sim/world.ts useTarget), so the prompt never promises something else.
    if (!t) {
      // At a depot that is on, which useTarget passes over while a squad is fighting: the depot, crossed, and the fight.
      if (depotBlocked(s) && depotInReach(s) >= 0) return `${depotIcon()}${TERM.relayBox}${crossIcon()}${fightIcon(UI.foeBright)}`;
      // Back in the camp's yard with a fight close by: it takes the player home once that is over.
      if (homeReady(s) && depotBlocked(s)) return `${TERM.camp}${crossIcon()}${fightIcon(UI.foeBright)}`;
      // Standing on something that will not go in: a mod part already worn, or a full bag.
      const left = s.loot.find((l) => (l.kind === "valuable" || l.kind === "tool" || l.kind === "mod") && l.age >= 0.4 && dist2d(l.pos, p.pos) < PLAYER.pickupRange && Math.abs(l.pos.y - p.pos.y) < 2);
      if (left?.mod) return `${esc(MODS[left.mod].name)} ${checkIcon()}`;
      const full = `${bagIcon()}<b>${bagLoad(p)}/${BAG.slots}</b>`;
      if (left?.valuable) return `${esc(VALUABLES[left.valuable].label)} ${full}`;
      if (left?.tool) return `${esc(TOOLS[left.tool].label)} ${full}`;
      // Before a closed route's obstacle: its name, a padlock and the tool that opens it (ticked when carried).
      const r = routeBefore(p.pos, s.routes);
      if (!r) return "";
      const tool = esc(TOOLS[r.tool].label);
      // The tool not carried: the POI whose bins hold it; carried, it opens the route once home.
      const where = p.tools.includes(r.tool) ? checkIcon() : ` <small>▸ ${esc(POIS[poiIndex(TOOLS[r.tool].from)].name)}の補給箱</small>`;
      return `${esc(r.name)} ${lockIcon()}<span class="r" style="color:${RARITY_CSS[3]}">${tool}</span>${where}`;
    }
    if (t.kind === "tool") {
      const k = t.loot.tool!;
      const out = (roomForTool(p, k) ?? []).map((i) => VALUABLES[p.haul[i]].label);
      return tip(`${key("E")}<span class="r" style="color:${RARITY_CSS[3]}">${TOOLS[k].label}</span> ${bagIcon()}${TOOLS[k].size}${struck(out)}`);
    }
    if (t.kind === "mod") {
      const k = t.loot.mod!;
      const off = p.mods.length >= MOD.slots ? p.mods[0] : null;
      // One of a core's parts: what it does is on the prompt, since taking it gives up the others.
      const note = t.loot.choice !== undefined ? ` <small>${modGist(k)}</small>` : "";
      return tip(`${key("E")}<span class="r" style="color:${UI.r2Text}">${MODS[k].name}</span>${note}${off ? struck([MODS[off].name]) : ""}`);
    }
    if (t.kind === "ally") {
      return tip(s.ally.helped > 0 ? `${reviveIcon()}${ALLY.name} <b>${Math.floor((s.ally.helped / helpTime(p)) * 100)}%</b>` : `${key("E")}${reviveIcon()}${ALLY.name}`);
    }
    if (t.kind === "bin") {
      const q = p.search;
      const b = s.bins[t.index];
      const what = b.vault ? "保管庫" : "補給箱";
      if (q?.bin === t.index) return tip(`${what} <b>${Math.floor((q.t / searchFor(p, b)) * 100)}%</b>`);
      // Shut: whose key opens it, and the POI whose bins hold that key.
      if (!canOpen(s, b)) return tip(`${what} ${lockIcon()}${keyIcon(RARITY_CSS[3])}${esc(POIS[b.poi].name)} <small>▸ ${esc(keySource(b.poi))}の補給箱</small>`);
      return tip(`${key("E")}${what} ${noiseIcon()}`);
    }
    if (t.kind === "swap") {
      const v = t.loot.valuable!;
      const out = (makeRoom(p.haul, v, p.tools) ?? []).map((i) => VALUABLES[p.haul[i]].label);
      return tip(`${key("E")}${esc(VALUABLES[v].label)}${struck(out)}`);
    }
    if (t.kind === "care") return tip(`${key("E")}補給ポッド`);
    if (t.kind === "depot") {
      // One place, one line: what it is + what happens (brief: 中継ボックス). No internal jargon.
      if (!p.haul.length && !p.tools.length) {
        return tip(`${key("E")}${depotIcon()}${TERM.relayBox} · ${TERM.cutAndExtract} ${clockIcon()}${DEPOT.leave} 秒`);
      }
      const n = p.haul.length + p.tools.length;
      const value = p.haul.reduce((v, k) => v + VALUABLES[k].value, 0);
      const room = Number.isFinite(s.stashRoom) ? Math.max(0, Math.floor(s.stashRoom)) : null;
      if (room === 0) {
        return tip(`${key("E")}${depotIcon()}${PHRASE.relayWarehouseFull} · ${TERM.cutAndExtract} ${clockIcon()}${DEPOT.leave} 秒`);
      }
      const roomBit = room != null ? ` · ${TERM.warehouse} あと ${room}` : "";
      return tip(`${key("E")}${depotIcon()}${TERM.relayBox} · ${TERM.sendToWarehouse} ${n}点・${value}${roomBit}`);
    }
    if (t.kind === "armor") return tip(`${key("E")}<span class="r" style="color:${RARITY_CSS[t.loot.rarity]}">アーマー Lv${t.loot.rarity}</span>${struck([`Lv${p.armor}`])}`);
    if (t.kind === "core") {
      const n = NODES[t.node];
      const c = foeSide(s.nodes[t.node]);
      const whoHub = rivalWhoHub(s.nodes[t.node], n.name, this.rivalNames);
      if (!capturable(s, t.node)) return tip(`${coreIcon(c, true)}${esc(n.name)} <small>▸ 先に${esc(shieldedBy(s.nodes, t.node))}</small>`);
      if (s.capture?.node === t.node) {
        const label = whoHub ? attackCapturing(whoHub) : `${TERM.captureCore} ${n.name}`;
        return tip(`${coreIcon(c)}${esc(label)} <b>${Math.floor((s.capture.t / FRONT.capture) * 100)}%</b>`);
      }
      // TKT-204 案 E: rival hub → 「ツバキの浄水場を攻める」; foe → 核 · 制圧を始める.
      if (whoHub) return tip(`${key("E")}${coreIcon(c)}${esc(attackCapturePrompt(whoHub))} ${noiseIcon()}`);
      return tip(`${key("E")}${coreIcon(c)}${PHRASE.captureStart} ${esc(n.name)} ${noiseIcon()}`);
    }
    if (t.kind === "zip") {
      // The way the rider would go: the end the player faces, and how far along the cable it is.
      const l = ZIPS[t.line];
      const at = zipPoint(l, t.at);
      const toB = Math.sin(p.yaw) * at.dx - Math.cos(p.yaw) * at.dz >= 0;
      return tip(`${key("E")}${zipIcon(l.fixed ? UI.mist : undefined)}${esc(zipEndName(toB ? l.b : l.a))} <b>${Math.round(toB ? l.length - t.at : t.at)}</b> m`);
    }
    const wl = t.loot;
    const swap = p.weapons.includes(null) ? "" : struck([WEAPONS[p.weapons[p.slot]!.kind].name]);
    return tip(`${key("E")}<span class="r" style="color:${RARITY_CSS[wl.rarity]}">${WEAPONS[wl.weapon!.kind].name}</span> ${RARITY.names[wl.rarity]}${swap}`);
  }

  /**
   * The results' analysis: the mod parts brought out alive, one of which the player may analyse
   * (its kind then turns up in bins), `known` the kinds known before, `done` the one analysed.
   */
  private analysis(s: State, settled: Settlement | undefined, known: readonly ModKind[], done: ModKind | null): string {
    const worn = s.player.mods ?? [];
    if (!settled || !worn.length) return "";
    // Not home alive: the parts worn, struck through.
    if (!settled.analysable.length) return `<h3>改造パーツの解析</h3><p>${worn.map((k) => `<span class="lost">${esc(MODS[k].name)}</span>`).join("")}</p>`;
    // One part a raid: a new kind is marked NEW, its hexagon over a supply bin; the one analysed drops
    // into the bin (it turns up in bins from now on), as do kinds known before.
    const row = (k: ModKind) => {
      const old = known.includes(k);
      const state = k === done || old ? checkIcon() : done ? "" : `<em class="new">NEW</em>`;
      const bin = binPicture(modIcon(), k === done ? "in drop" : old ? "in" : "out");
      return `<button type="button" class="mod${k === done ? " done" : ""}" data-analyse="${k}"${done || old ? " disabled" : ""}>${bin}<b>${esc(MODS[k].name)}${state}</b><small title="${esc(MODS[k].note)}">${modGist(k)}</small></button>`;
    };
    return `<h3>改造パーツの解析<b>${done ? 1 : 0}/1</b></h3><div class="analyse">${settled.analysable.map(row).join("")}</div>`;
  }

  /**
   * The results' day: the island's map and its tug of war, played in beats. The map is drawn as
   * the day began; then the nodes that changed hands while the player was out turn to the colour
   * they went to (a ring on the map, the bar's boundary sliding); then, under the depot's mark,
   * those the battle went on to take after the player left (`drawDay()`).
   */
  private dayResult(s: State, settled?: Settlement): string {
    const holds = settled ? islandHolds(settled.profile) : s.nodes;
    return `<canvas id="day-map"></canvas><div class="day-row"><small>${TERM.today}</small><span id="day-bar">${nodeRow(holds)}</span><span id="day-beat"></span></div>`;
  }

  /** Seconds after the results open at which the map turns to the day's end. */
  private dayTimers: number[] = [];
  private dayFrame = 0;
  /** Jump the island beat to its end (tap the day map); null once done or cleared. */
  private daySkip: (() => void) | null = null;

  /** Stops the day's beat timers (leaving the results, or skipping to the end). */
  private clearDayTimers() {
    for (const t of this.dayTimers) clearTimeout(t);
    this.dayTimers = [];
    cancelAnimationFrame(this.dayFrame);
  }

  /** Leaves the results: drop beat timers so they do not fire over the camp. */
  endResults() {
    this.clearDayTimers();
    this.daySkip = null;
    const day = document.getElementById("day-result");
    if (day) day.classList.remove("skippable");
  }

  /** Tap the day map / row: jump to the day's end without waiting out the beats (Round 10). */
  skipDayBeat() {
    this.daySkip?.();
  }

  /** Draws the results' map and bar beat by beat: as the day began, after the raid, after the battle the player left. */
  private drawDay(settled?: Settlement) {
    const canvas = document.getElementById("day-map") as HTMLCanvasElement | null;
    this.clearDayTimers();
    this.daySkip = null;
    if (!canvas || !settled) {
      if (canvas) canvas.hidden = true;
      return;
    }
    const map = new IslandMap(canvas);
    map.whole = true;
    map.locks = false;
    map.plain = true;
    // Ways in the raid learned are dashed as the day began, and turn solid with a ring at its end.
    const learned = settled.learned;
    map.known = settled.profile.entries.filter((e) => !learned.includes(e));
    // 来る遠征の予告 UI は削除済み: Profile.incoming を地図に載せない
    const end = islandScene(settled.profile);
    // The player's nodes after each beat, from the day's end back.
    const after = (ids: Set<string>, c: { gained: readonly string[]; lost: readonly string[] }, back: boolean) => {
      const out = new Set(ids);
      for (const id of back ? c.gained : c.lost) out.delete(id);
      for (const id of back ? c.lost : c.gained) out.add(id);
      return out;
    };
    const battle = new Set<string>(NODES.filter((n) => settled.profile.poiState[n.id].state === "own").map((n) => n.id));
    const left = after(battle, settled.after, true);
    const start = after(left, settled.raid, true);
    // Other players' nodes at each beat (`Settlement.rivals`): as the day began, when the player left, and from the battle's end on.
    type Rivals = Partial<Record<string, string>>;
    const rv = settled.rivals;
    const atStart: Rivals = rv?.start ?? {};
    const atLeft: Rivals = rv?.left ?? {};
    const atEnd: Rivals = rv?.end ?? {};
    // A node not the player's in a beat is another player's where it was theirs then, else the enemy's.
    const other = (id: string, rivals: Rivals): PoiHold => {
      const who = rivals[id];
      return who !== undefined ? rivalHold(who) : "foe";
    };
    const holdsOf = (ids: Set<string>, rivals: Rivals) => NODES.map((n): PoiHold => (ids.has(n.id) ? "own" : other(n.id, rivals)));
    const scene = (ids: Set<string>, rivals: Rivals, changed?: Settlement["raid"] & { moved?: (typeof NODES)[number]["id"][] }) => ({
      ...end,
      hold: end.hold.map((h, i) => (nodeIndex(POIS[i].id) < 0 ? h : ids.has(POIS[i].id) ? "own" : other(POIS[i].id, rivals))),
      nodes: holdsOf(ids, rivals),
      changed,
    });
    const bar = (ids: Set<string>, rivals: Rivals, from: Set<string>) => {
      const el = document.getElementById("day-bar");
      if (el) el.innerHTML = nodeRow(holdsOf(ids, rivals), undefined, { from: from.size, delay: 0 });
    };
    // The beat on show, for automation (`data-beat`), and its mark.
    const mark = (beat: string, html: string) => {
      const el = document.getElementById("day-beat");
      if (!el) return;
      el.innerHTML = html;
      el.dataset.beat = beat;
    };
    // The nodes whose other player changed between two beats (none with no other player's node all day).
    const rivalMoved = (from: Rivals, to: Rivals) => NODES.filter((n) => from[n.id] !== to[n.id]).map((n) => n.id);
    // A beat shows when the player's nodes changed in it, or other players' did.
    const beats: { beat: string; ids: Set<string>; rivals: Rivals; moved: ReturnType<typeof rivalMoved>; prev: Set<string>; c: Settlement["raid"]; icon: string }[] = [
      { beat: "raid", ids: left, rivals: atLeft, moved: rivalMoved(atStart, atLeft), prev: start, c: settled.raid, icon: "" },
      { beat: "after", ids: battle, rivals: atEnd, moved: rivalMoved(atLeft, atEnd), prev: left, c: settled.after, icon: depotIcon() },
    ].filter((b) => b.c.gained.length || b.c.lost.length || b.moved.length);
    // Milliseconds between the beats. Automation may set the gap to 0 and step them itself with
    // `window.ringfallBeat()`, so a slow screenshot never misses one.
    const auto = window as { ringfallBeatGap?: number; ringfallBeat?: () => string };
    const gap = auto.ringfallBeatGap ?? 1600;
    const manual = gap === 0;
    // Drawn once the results are shown, so the map is drawn at the canvas's size on screen.
    this.dayFrame = requestAnimationFrame(() => {
      map.draw({ ...scene(start, atStart), names: [] });
      bar(start, atStart, start);
      mark("start", "");
      // The ways in the raid learned turn solid with the first beat (or alone, when nothing changed hands).
      const learn = () => {
        map.known = settled.profile.entries;
      };
      const show = (k: number) => {
        const b = beats[k];
        if (k === 0) learn();
        // A beat names only the nodes that changed hands in it: the results' map is small.
        map.draw({ ...scene(b.ids, b.rivals, b.moved.length ? { ...b.c, moved: b.moved } : b.c), learned, names: [...b.c.gained, ...b.c.lost, ...b.moved] });
        bar(b.ids, b.rivals, b.prev);
        mark(b.beat, b.icon);
      };
      const dayEl = document.getElementById("day-result");
      const finish = () => {
        this.clearDayTimers();
        this.daySkip = null;
        learn();
        if (beats.length) {
          const last = beats[beats.length - 1];
          map.draw({
            ...scene(battle, atEnd, last.moved.length ? { ...last.c, moved: last.moved } : last.c),
            learned,
            names: [...last.c.gained, ...last.c.lost, ...last.moved],
          });
          bar(battle, atEnd, last.prev);
          mark("done", last.icon);
        } else {
          map.draw({ ...scene(battle, atEnd), learned, names: [] });
          bar(battle, atEnd, battle);
          mark("done", "");
        }
        dayEl?.classList.remove("skippable");
      };
      // Tap the day map to skip the wait (same gesture as reading the results — no new key).
      this.daySkip = () => {
        if (document.getElementById("day-beat")?.dataset.beat === "done") return;
        finish();
      };
      dayEl?.classList.add("skippable");
      if (manual && beats.length) {
        let k = 0;
        auto.ringfallBeat = () => {
          if (k < beats.length) show(k++);
          else {
            mark("done", document.getElementById("day-beat")?.innerHTML ?? "");
            dayEl?.classList.remove("skippable");
            this.daySkip = null;
          }
          return document.getElementById("day-beat")?.dataset.beat ?? "";
        };
        return;
      }
      beats.forEach((_, k) => this.dayTimers.push(window.setTimeout(() => show(k), 900 + k * gap)));
      if (!beats.length && learned.length)
        this.dayTimers.push(
          window.setTimeout(() => {
            learn();
            map.draw({ ...scene(battle, atEnd), learned, names: [] });
          }, 900),
        );
      this.dayTimers.push(
        window.setTimeout(() => {
          mark("done", document.getElementById("day-beat")?.innerHTML ?? "");
          dayEl?.classList.remove("skippable");
          this.daySkip = null;
        }, 900 + beats.length * gap),
      );
    });
  }

  /**
   * The island's news from the server, come in while the results are up: put in their place there,
   * keeping overnight / outgoing expedition lines already on the unified list.
   */
  setNews(news: readonly string[]) {
    const el = document.getElementById("island-news");
    if (el) el.innerHTML = newsBlock([...this.newsKeep, ...news]);
  }

  /**
   * 起動時の一枚: 留守中の対人結果（リザルトと同じ文・並び）。
   * 回収・戦闘の記録は出さない。見たら信号所の控えに残っている。
   */
  awayResults(before: Profile, after: Profile, lines: readonly string[], trop: string | null, next = "") {
    this.newsKeep = [];
    this.clearDayTimers();
    this.daySkip = null;
    $("result-title").textContent = TERM.islandNews;
    $("day-result").innerHTML = "";
    $("day-result").onclick = null;
    const canvas = document.getElementById("day-map") as HTMLCanvasElement | null;
    if (canvas) canvas.hidden = true;
    $("haul-line").innerHTML = "";
    const statsBox = document.getElementById("stats-box");
    if (statsBox) (statsBox as HTMLElement).hidden = true;
    $("stats").innerHTML = "";
    const tropLine = trop ? `<p class="trop-line">${trop}</p>` : "";
    $("home").innerHTML = `<div id="island-news">${newsBlock(lines, true)}</div>` + tropLine;
    const tip = next || nextHandFor(after);
    const nextEl = $("next-hand");
    if (nextEl) {
      nextEl.hidden = !tip;
      nextEl.textContent = tip;
      nextEl.classList.remove("defence-beat");
    }
  }

  /**
   * Results after a raid. `before` is the profile just before settle — used only to show how the
   * haul fed the base (wanted / buildable). `next` is the one-line hand into the next sortie.
   */
  results(s: State, settled?: Settlement, known: readonly ModKind[] = [], analysed: ModKind | null = null, news: readonly string[] = [], before: Profile | null = null, next = "", expNews: readonly string[] = []) {
    $("result-title").textContent = s.home ? "帰った" : s.outcome === "extracted" ? "生還" : "行方不明";
    const statsBox = document.getElementById("stats-box");
    if (statsBox) (statsBox as HTMLElement).hidden = false;
    $("day-result").innerHTML = this.dayResult(s, settled);
    // Tap the day's map to skip the beat wait (Round 10); 野営地に戻る still leaves as before.
    $("day-result").onclick = () => this.skipDayBeat();
    this.drawDay(settled);
    const st = s.stats;
    const acc = st.shots ? Math.round((st.hits / st.shots) * 100) : 0;
    const crit = st.hits ? Math.round((st.crits / st.hits) * 100) : 0;
    $("stats").innerHTML = [
      ["撃破", st.kills],
      ["与ダメージ", Math.round(st.damage)],
      ["命中率", `${acc}%`],
      ["弱点命中", `${crit}%`],
      ["ダウン", st.downs],
      ["レイド時間", clock(s.time)],
      ["脱出", s.home ? TERM.camp : s.leftAt ? relayOf(POIS[poiIndex(s.leftAt)].name) : (EXTRACTS.find((x) => x.id === s.extractedAt)?.short ?? "-")],
      [`${ALLY.name}の撃破`, st.allyKills],
      [`${ALLY.name}に救助`, st.allyRescues],
    ]
      .map(([k, v]) => `<span>${k}<b>${v}</b></span>`)
      .join("");
    const lost = s.outcome !== "extracted";
    const sentValue = s.sent.reduce((n, k) => n + VALUABLES[k].value, 0);
    const value = haulAndSentWorth(s);
    const carried = [
      ...(Object.keys(VALUABLES) as (keyof typeof VALUABLES)[]).map((k) => [VALUABLES[k].label, s.player.haul.filter((h) => h === k).length] as const),
      ...TOOL_KINDS.map((k) => [TOOLS[k].label, s.player.tools.filter((t) => t === k).length] as const),
    ].filter(([, n]) => n > 0);
    // settle() lists what was sent from a depot first in `home`; it is shown on a line of its own.
    const all = settled?.home ?? [];
    const sent = all.slice(0, s.sent.length + s.sentTools.length);
    const home = all.slice(s.sent.length + s.sentTools.length);
    // On a wipe, what the bag held splits in two: what the pouch kept, in the pouch's colour, and the rest struck through.
    const pouched = new Map<string, number>();
    if (lost) for (const i of home) pouched.set(itemName(i), (pouched.get(itemName(i)) ?? 0) + 1);
    const kept = (label: string, n: number) => Math.min(n, pouched.get(label) ?? 0);
    const split = [
      ...carried.filter(([label, n]) => kept(label, n)).map(([label, n]) => `<span class="pouch-kept">${pouchIcon()}${label}${kept(label, n) > 1 ? ` × ${kept(label, n)}` : ""}</span>`),
      ...carried.filter(([label, n]) => n > kept(label, n)).map(([label, n]) => `<span class="lost">${label}${n - kept(label, n) > 1 ? ` × ${n - kept(label, n)}` : ""}</span>`),
    ];
    // The haul's worth under the day's result; what a wipe lost is struck through, what went home from a depot is kept.
    $("haul-line").innerHTML =
      `<span${lost ? ' class="lost"' : ""}>回収の価値<b>${lost ? value - sentValue : value}</b></span>` +
      (lost && sentValue ? `<span>倉庫へ送った<b>${sentValue}</b></span>` : "") +
      (lost ? split.join("") : "");
    const count = (items: typeof all) => {
      // A chip a kind, in its rarity's colour, counted.
      const counted = new Map<string, { n: number; c: string }>();
      for (const i of items) counted.set(itemName(i), { n: (counted.get(itemName(i))?.n ?? 0) + 1, c: itemColor(i) });
      return [...counted].map(([n, { n: c, c: col }]) => `<span class="chip" style="--c:${col}">${n}${c > 1 ? `<b>${c}</b>` : ""}</span>`).join("");
    };
    // A record of a raid kept from before ways in were learned has walked to none.
    const forgot = (s.found ?? []).filter((id) => !this.known.includes(id));
    // 答え合わせの並び: 島の知らせ → トロフィー →（次の一手は #next-hand）→ その他.
    const tip = next || (settled ? nextHandFor(settled.profile) : "");
    const nextEl = $("next-hand");
    if (nextEl) {
      nextEl.hidden = !tip;
      nextEl.textContent = tip;
      nextEl.classList.remove("defence-beat");
    }
    // Outgoing expeditions + お隣を攻めた勝ち負け + 同期の知らせ.
    // incursion / 取り合う拠点の制圧行も newsKeep に入れ、後から setNews されても消えないようにする。
    const nameOf = (owner: string) => {
      const n = neighboursNowOnMap().find((x) => x.code === owner || (owner.startsWith("ai-") && x.code === owner.slice(3)));
      if (!n) return owner;
      return n.ai ? aiLabel(n.name) : n.name;
    };
    const tropPer = settled?.takenRival?.length && settled.trophies?.gained
      ? Math.max(1, Math.round(settled.trophies.gained / settled.takenRival.length))
      : settled?.trophies?.gained;
    const takeLines = settled?.takenRival?.length
      ? settled.takenRival.map((t) => newsIncursion(nameOf(t.owner), NODES[nodeIndex(t.id)]?.name ?? t.id, true, tropPer))
      : [];
    this.newsKeep = [...expNews, ...takeLines];
    const allNews = [...this.newsKeep, ...news];
    const trop = settled?.trophies;
    const tropMoved =
      !!trop &&
      (trop.before !== trop.after || trop.gained > 0 || trop.lost > 0 || (trop.defended ?? 0) > 0 || trop.stars !== undefined);
    const starDelta =
      s.attack && trop?.stars !== undefined ? raidTrophyDelta(s.attack.N, s.attack.M, trop.stars) : trop ? trop.gained - trop.lost : 0;
    const starLine =
      trop?.stars !== undefined
        ? `<p class="trop-line">${esc(raidStarsLine(trop.stars, starDelta))}</p>`
        : "";
    const tropBreakdown = tropMoved
      ? `<p class="trop-line">${trophyLine(trop!.before, trop!.after, trop!.gained, trop!.lost, trop!.defended ?? 0, trop!.failed ?? 0)}</p>`
      : "";
    const leagueLine = settled?.league
      ? `<p class="trop-line">${esc(leagueChangeLine(settled.league.from, settled.league.to))}</p>`
      : "";
    const bonusLine =
      settled?.winBonus && settled.winBonus > 0
        ? `<p class="trop-line">${esc(winBonusMark(settled.winBonus))}</p>`
        : "";
    const tropLine = `${starLine}${tropBreakdown}${leagueLine}${bonusLine}`;
    const growth = settled && before ? this.baseGrowth(before, settled) : "";
    const defence = this.defenceLines(s);
    const dayHead = settled
      ? `<div id="island-news">${newsBlock(allNews, true)}</div>${tropLine}`
      : "";
    // 方向 A: 遠征の拠点の収入は拠点の収入に一本化（Settlement.income に合算済み）。
    const islandExtra =
      settled?.income || settled?.spoils
        ? `<p>${settled.income ? `<span>拠点の収入<b>${settled.income.toLocaleString()} クレジット</b></span>` : ""}${settled.spoils ? `<span>戦果<b>${settled.spoils.toLocaleString()} クレジット</b></span>` : ""}</p>`
        : "";
    // The day's outcome is in the headline; the right column holds what comes of it, then the parts to analyse.
    $("home").innerHTML =
      dayHead +
      islandExtra +
      growth +
      defence +
      (settled
        ? (sent.length ? `<h3 class="mark">${depotIcon()}${TERM.relayBox}</h3><p>${count(sent)}</p>` : "") +
          // A wipe's pouch is on the haul's line above, beside what was lost.
          (lost || !home.length ? "" : `<h3 class="mark">${bagIcon()}持ち帰った</h3><p>${count(home)}</p>`) +
          // Ways in: learned ones as the map's ring, ones found on a raid that did not come home struck through.
          (settled.learned.length || (lost && forgot.length)
            ? `<h3>入口</h3><p>${settled.learned.map((id) => `<span class="learned"><span class="turn">${entryIcon(false)}${entryIcon()}</span>${entryOf(id).name}（${regionOf(entryOf(id).region).name}）</span>`).join("")}${lost ? forgot.map((id) => `<span class="lost">${entryOf(id).name}</span>`).join("") : ""}</p>`
            : "") +
          (settled.opened.length ? `<h3>開いた道</h3><p>${settled.opened.map((id) => `<span>${routeIcon(true)}${routeOf(id).name}</span>`).join("")}</p>` : "") +
          (settled.pending?.length || settled.sold.length
            ? settled.soldFor > 0 && !(settled.pending?.length)
              ? `<h3>${PHRASE.organizeSold}</h3><p><span>${settled.sold.length} 点<b>${settled.soldFor} クレジット</b></span>${before ? `<span>${stashIcon()}${stashUsed(settled.profile)} / ${stashCap(settled.profile.hideout)}</span>` : ""}</p>`
              : `<h3>${PHRASE.stashOverflowOrganize}</h3><p><span>${(settled.pending?.length ?? settled.sold.length)} 点 · ${TERM.organize}</span>${before ? `<span>${stashIcon()}${stashUsed(settled.profile)} / ${stashCap(settled.profile.hideout)}</span>` : ""}</p>`
            : "")
        : "") +
      this.analysis(s, settled, known, analysed);
  }

  /**
   * Multiplayer motivation on the return screen: what this raid put into 島の守り at a 中継ボックス.
   * Named delivery lines are not listed — toast + 「〜に回った」 are enough (design-direction).
   */
  private defenceLines(s: State): string {
    const left = s.leftParcels ?? [];
    const mine = left
      .map((q) => `<span>${depotIcon()}${esc(POIS[poiIndex(q.poi)].name)}${PHRASE.islandGuardWent}</span>`)
      .join("");
    if (!mine) return "";
    return `<h3>${TERM.islandGuard}</h3><p>${mine}</p>`;
  }


  /**
   * How the haul fed the base: valuables that still matter for 工房／工場, and anything newly buildable.
   * Names the player already sees in camp — no new nouns.
   */
  private baseGrowth(before: Profile, settled: Settlement): string {
    const after = settled.profile;
    const wantB = wanted(before);
    const bits: string[] = [];
    // Only what actually entered the stash (Codex P2): stash after − before, not Settlement.home (which still lists sold overflow).
    const countVal = (p: Profile) => {
      const m = new Map<ValuableKind, number>();
      for (const i of p.stash) if (i.t === "valuable") m.set(i.kind, (m.get(i.kind) ?? 0) + 1);
      return m;
    };
    const beforeN = countVal(before);
    const afterN = countVal(after);
    const kinds = new Map<ValuableKind, number>();
    for (const [k, n] of afterN) {
      const d = n - (beforeN.get(k) ?? 0);
      if (d > 0) kinds.set(k, d);
    }
    const goal = before.goal && before.goal in VALUABLES ? before.goal : null;
    for (const [k, kept] of kinds) {
      if (wantB[k] <= 0 && k !== goal) continue;
      const uses: string[] = [];
      for (const m of MODULES) {
        const need = nextLevel(before.hideout, m)?.items.find(([x]) => x === k)?.[1] ?? 0;
        if (need > 0) uses.push(`${hideoutIcon()}${esc(HIDEOUT[m].name)}<b>${need}</b>`);
      }
      if (!uses.length && stillNeeded(before.hideout)[k] > 0) uses.push(`${hideoutIcon()}<b>${stillNeeded(before.hideout)[k]}</b>`);
      const fac = nextFactory(before)?.items.find(([x]) => x === k)?.[1] ?? 0;
      if (fac) uses.push(`${factoryIcon()}工場 Lv${before.factory + 1}<b>${fac}</b>`);
      else if (factoryNeeded(before)[k] > 0) uses.push(`${factoryIcon()}工場<b>${factoryNeeded(before)[k]}</b>`);
      if (!uses.length && k !== goal) continue;
      const done = wanted(after)[k] <= 0;
      const goalMark = k === goal ? `<small>${TERM.goal}</small>` : "";
      bits.push(`<span class="growth-item${done ? " done" : ""}"><span class="chip" style="--c:${itemColor({ t: "valuable", kind: k })}">${goalMark}${esc(VALUABLES[k].label)}${kept > 1 ? `<b>${kept}</b>` : ""}</span>${uses.join("")}${done ? checkIcon() : ""}</span>`);
    }
    const ready: string[] = [];
    if (canBuildFactory(after) && !canBuildFactory(before)) ready.push(`${factoryIcon()}${PHRASE.factoryRaiseReady}`);
    for (const m of MODULES) {
      if (canBuild(after, m) && !canBuild(before, m)) ready.push(`${hideoutIcon()}${moduleRaiseReady(HIDEOUT[m].name)}`);
    }
    // Settlement.seized is already stash-kept only (keptSeized); sold overflow stays under 倉庫に入らなかった.
    const seized = (settled.seized ?? [])
      .map((q) => `<span class="growth-ready">${coreIcon(SIDE.own)}制圧した · ${esc(POIS[poiIndex(q.poi)].name)}から${q.kinds.map((k) => esc(VALUABLES[k].label)).join("・")}</span>`)
      .join("");
    if (!bits.length && !ready.length && !seized && !kinds.size) return "";
    const stash = `<span>${stashIcon()}倉庫 ${stashUsed(after)} / ${stashCap(after.hideout)}</span>`;
    return (
      `<h3>${TERM.arrivedAtWarehouse}</h3><p class="growth">${bits.join("") || (seized || kinds.size ? "" : "<span>拠点の材料ではない</span>")}${seized}${stash}${ready.map((r) => `<span class="growth-ready">${r}</span>`).join("")}</p>`
    );
  }
}
