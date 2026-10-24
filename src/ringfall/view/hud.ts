import { pouchKeep, type Settlement } from "../meta/profile";
import type { ModKind } from "../sim/config";
import { itemName, rewardList } from "./hub";
import { ALLY, AWARE, BAG, META, DEPOT, ENEMIES, HEAL_KINDS, HEALS, PLAYER, RARITY, REVEAL, TACTICAL, TOOL_KINDS, TOOLS, VALUABLES, WEAPONS, type Flank } from "../sim/config";
import { eyePos, magSize } from "../sim/combat";
import { atRisk, countered, heldUnlocks } from "../sim/battle";
import { dist2d, los } from "../sim/geom";
import { DEPOTS, entryOf, EXTRACTS, nodeIndex, NODES, POIS, poiIndex, regionHere, regionOf, routeOf, ZIPS, type EntryId } from "../sim/map";
import { routeBefore } from "../sim/routes";
import { islandHolds } from "../meta/island";
import { bagLoad, canOpen, crewsInSight, depotBlocked, depotInReach, extractHere, extractReady, homeReady, makeRoom, poiAt, roomForTool, searchFor, useTarget } from "../sim/world";
import { healTime, tacticalCooldown } from "../sim/player";
import { helpTime, reviveTime } from "../sim/ally";
import { callLeft, debrisBin, enemyHp, enemyShield, weakY, type GameEvent, type State, type Vec3 } from "../sim/state";
import { haulValue } from "../sim/results";
import { pickHeal } from "../sim/player";
import { RARITY_CSS, SCOPE_IN } from "./models";
import { IslandMap, islandScene } from "./map";
import { nodeRow } from "./row";
import { CONTRACT_NAME, contractMark, contractTask, contractText, type Contract } from "../meta/contracts";
import { currentStep, objectiveSteps, type Objective, type Step, type Task } from "../sim/objective";
import { storyOf } from "../meta/story";
import { recordSpot, type RecordId } from "../sim/map";
import type { World } from "./world";
import { eventRow, raidEventLine } from "./events";
import { CREW, FRONT, MOD, MODS } from "../sim/config";
import { binPicture, modIcon, pouchIcon, routeIcon, zipIcon } from "./icons";
import { zipPoint } from "../sim/zips";
import { bagIcon, callIcon, checkIcon, clockIcon, coreIcon, crossIcon, depotIcon, entryIcon, exitIcon, eyeIcon, fightIcon, flareIcon, keyIcon, lockIcon, noiseIcon, reinforceIcon, reviveIcon, SIDE, upIcon, nightIcon } from "./icons";
import { capturable } from "../sim/front";

/*
 * The DOM layer: everything the player reads. The screen always answers two
 * questions: what to do next (objective card, and the map for where things are) and how am I doing
 * (shield cells, health, ammo, ability charge).
 */

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
/** Replaces an element's markup only when it changes: the objective card is redrawn every frame. */
const setHtml = (el: HTMLElement, html: string) => {
  if (el.dataset.html === html) return;
  el.dataset.html = html;
  el.innerHTML = html;
};
const clock = (t: number) => `${Math.floor(Math.max(0, t) / 60)}:${String(Math.floor(Math.max(0, t) % 60)).padStart(2, "0")}`;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
/** Wording follows the controls in use: keys on a PC, on-screen buttons on a phone. */
const isTouch = () => document.body.classList.contains("touch");
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
  private awareLayer = $("aware-layer");
  private awEls = new Map<number, HTMLElement>();
  /** A red mark per node of the player's the enemy's robots have come to, by its place in `NODES`. */
  private threatEls = new Map<number, HTMLElement>();
  private spotted = new Map<number, number>(); // robot id -> seconds left to show "!"

  private map = new IslandMap($<HTMLCanvasElement>("map-canvas"));
  private mapOpen = false;
  /** The ways in the profile knew when the raid began: one walked to that is not among them is news. */
  private known: EntryId[] = [];

  /** Open or close the island map; it is redrawn every frame while open, and opens on the region the player is in. */
  toggleMap(force?: boolean) {
    this.mapOpen = force ?? !this.mapOpen;
    $("map").hidden = !this.mapOpen;
    if (this.mapOpen) this.showWhole(false);
  }

  /** Switch the open map between the region the player is in and the whole world. */
  toggleMapView() {
    if (this.mapOpen) this.showWhole(!this.map.whole);
  }

  private showWhole(whole: boolean) {
    this.map.whole = whole;
    const to = whole ? "地域" : "全体";
    $("map-zoom").textContent = to;
    $("map-view-key").textContent = to;
  }

  constructor() {
    $("map-close").addEventListener("click", () => this.toggleMap(false));
    $("map-zoom").addEventListener("click", () => this.toggleMapView());
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
  }

  show(on: boolean) {
    this.root.hidden = !on;
  }

  /** The contract taken for this raid (null for none) and the story record lying on the island (null for none). */
  private contract: Contract | null = null;
  private record: RecordId | null = null;
  /** What the raid is out to do (the contract, or the story record when it was taken from the board), for the objective's steps; and those steps as last drawn. */
  private task: Task | null = null;
  private obj: Objective | null = null;
  /** The objective and step last shown, so moving to the next step is told with a toast. */
  private lastStep = "";

  /**
   * `story`: the story record was taken from the board as the raid's objective. Without it and
   * without a contract, the objective is the day's front (`objectiveSteps()`), and the record has
   * a line of its own.
   */
  setContract(c: Contract | null, record: RecordId | null, story = false) {
    this.contract = c;
    this.record = record;
    this.task = c ? contractTask(c) : record && story ? { t: "record", id: record } : null;
    this.lastStep = "";
    this.map.contract = c && contractMark(c);
    // A new raid restarts `s.time`, so a landing marked in the last raid would show again.
    this.scout = null;
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
    const kept = pouchKeep(p.haul, p.tools, this.pouch, p.records);
    const keptAt = new Set(kept.at);
    const keptTools = [...kept.tools];
    const fill: string[] = [];
    const rest: string[] = [];
    for (let n = 0; n < kept.records.length; n++) fill.push("k");
    for (const k of kept.tools) for (let n = 0; n < TOOLS[k].size; n++) fill.push("k");
    p.haul.forEach((k, i) => {
      for (let n = 0; n < VALUABLES[k].size; n++) (keptAt.has(i) ? fill : rest).push(keptAt.has(i) ? "k" : RARITY_CSS[VALUABLES[k].rarity]);
    });
    for (const k of p.tools) {
      const at = keptTools.indexOf(k);
      if (at >= 0) keptTools.splice(at, 1);
      else for (let n = 0; n < TOOLS[k].size; n++) rest.push(RARITY_CSS[3]);
    }
    for (let n = kept.records.length; n < p.records.length; n++) rest.push(RARITY_CSS[3]);
    // The rest starts past the pouch's slots while it fits there, so the pouch's slots show what it keeps.
    const start = Math.max(fill.length, this.pouch + rest.length <= BAG.slots ? this.pouch : fill.length);
    const cells: string[] = Array.from({ length: BAG.slots }, () => "");
    fill.forEach((c, n) => (cells[n] = c));
    rest.forEach((c, n) => (cells[Math.min(BAG.slots - 1, start + n)] = c));
    return `<span class="bag-cells">${cells.map((c, n) => `<i class="${n < this.pouch ? "p" : ""}${c === "k" ? " k" : ""}"${c && c !== "k" ? ` style="--c:${c}"` : ""}></i>`).join("")}</span>`;
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
        cur.el.style.color = cur.crit ? "" : e.shield ? RARITY_CSS[e.tier] : "#ffffff";
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
      case "awaitAlly":
        this.banner("ダウン");
        break;
      case "hurt": {
        this.hurtT = 0.5;
        const el = document.createElement("i");
        $("dmgdir").appendChild(el);
        this.dirs.push({ el, x: e.fromX, z: e.fromZ, t: 0.9 });
        break;
      }
      case "locked":
        this.toast(`${keyIcon()}${POIS[e.poi].name}`, 0);
        break;
      case "pickup":
        if (e.kind !== "shard") this.toast(`${e.label}${e.kind === "weapon" ? `（${RARITY.names[e.rarity]}）` : e.kind === "armor" ? `（${RARITY.names[e.rarity]}）` : ""}`, e.rarity);
        break;
      case "poiStart":
        {
          // What the POI's standing on the island means on arrival.
          const h = s.hold?.[e.poi] ?? "held";
          const name = POIS[e.poi].name;
          if (POIS[e.poi].boss) this.banner(name);
          else this.banner(name, "", h === "freed");
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
        if (!s.player.awaitAlly) this.banner("ダウン");
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
        if (s.squads[e.squad].name !== "タイタン") this.toast(`${eyeIcon("#ff6b5a")}${s.squads[e.squad].name}`, 0);
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
        // A way in found: the ring the map draws for it, dashed until a raid home makes it a start.
        if (!this.known.includes(e.id)) this.toast(`${entryIcon(false)}${entryOf(e.id).name}`, 1, 4000);
        break;
      case "depotOn":
        this.toast(`${depotIcon()}${POIS[poiIndex(e.poi)].name}`, 1);
        break;
      case "deposit":
        this.toast(`${depotIcon()}${upIcon()}${e.n} 点・${e.value}`, 3);
        break;
      case "leaveCancel":
        this.toast(`${depotIcon()}${crossIcon()}`, 0);
        break;
      case "coreStart":
        this.toast(`${coreIcon(SIDE.enemy)}${NODES[e.node].name}`, 0, 3000);
        break;
      case "coreShielded":
        this.toast(`${coreIcon(SIDE.enemy, true)}${NODES[e.node].name}`, 0, 3000);
        break;
      case "coreTaken":
        this.toast(`${coreIcon(SIDE.own)}${NODES[e.node].name}`, 1, 5000);
        break;
      case "counter":
        // The enemy sets off to take back a node: its landing's mark and the node's blue core.
        this.toast(`${reinforceIcon()}${coreIcon(SIDE.own)}${NODES[e.node].name}`, 0, 4000);
        break;
      case "nodeTaken": {
        const name = NODES[e.node].name;
        this.toast(`${coreIcon(e.side === 0 ? SIDE.own : SIDE.enemy)}${name}`, e.side === 0 ? 1 : 0, 4000);
        break;
      }
      case "timeUp":
        this.banner("時間切れ");
        break;
      case "crewOut":
        // Heard over the radio wherever the player is: the crew has the bag now.
        this.toast(`${CREW.name}${crossIcon()}${bagIcon()}${e.n}`, 0, 4000);
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
    const own = s.nodes.filter((h) => h === "freed").length;
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
    const row = nodeRow(s.nodes, undefined, { from, risk, contested });
    const el = $("island-row");
    if (el.dataset.html !== row) {
      el.dataset.html = row;
      el.innerHTML = row;
    }
  }

  frame(s: State, view: World, dt: number, w: number, h: number) {
    const p = s.player;
    if (this.mapOpen) {
      if (s.phase === "done") this.toggleMap(false);
      // The debris crate is marked; a salvage crew only while the player can see one of it.
      else {
        const crate = debrisBin(s);
        this.map.draw({ ...s, debris: crate && { x: crate.x, z: crate.z, open: crate.open }, crews: crewsInSight(s) });
      }
    }

    // Objective card: the objective's current step, large, what finishes it and how far it has
    // gone under it, and the step's place in the list (sim/objective.ts).
    const here = poiAt(s);
    const poi = POIS[here];
    const active = here >= 0;
    const obj = objectiveSteps(s, this.task);
    this.obj = obj;
    const step = currentStep(obj);
    let text = "";
    if (p.leap) text = isTouch() ? "滑空中：スティックで着地点を選ぶ" : "滑空中：WASD で着地点を選ぶ";
    else if (s.phase === "done") text = s.home ? "帰った" : s.outcome === "extracted" ? "生還" : "行方不明";
    else text = step?.label ?? "探索して脱出せよ";
    $("obj-text").textContent = text;
    $("obj-title").textContent = obj.title;
    $("obj-n").textContent = `${Math.min(obj.current + 1, obj.steps.length)}/${obj.steps.length}`;
    // Under the step only how far it has gone, as a number; what the step asks is its label and the beacon.
    setHtml($("obj-until"), s.phase === "play" && step ? this.stepProgress(s, step) : "");
    // A step done moves the card on to the next, told with a short toast.
    const key = `${obj.title}|${obj.current}`;
    if (this.lastStep && key !== this.lastStep && s.phase === "play" && step && this.lastStep.split("|")[0] === obj.title) this.toast(`次：${step.label}`, 3, 2600);
    this.lastStep = key;
    view.setBeacon(s.phase === "play" ? (step?.at ?? null) : null);
    this.compassMark(s, step?.at ?? null);
    // The POI the player is in, after its core's mark: the side that holds it, padlocked while it is
    // not on the front; a tick once its garrison is cleared, and the capture's seconds while it runs.
    const oc = $("obj-contract");
    oc.hidden = !poi || s.phase !== "play";
    if (poi) {
      const node = nodeIndex(poi.id);
      const own = node >= 0 && s.nodes[node] === "freed";
      const taking = node >= 0 && s.capture?.node === node;
      const mark = node < 0 ? "" : own ? coreIcon(SIDE.own) : coreIcon(SIDE.enemy, !taking && !capturable(s, node));
      const cleared = s.cleared[here] && !own ? checkIcon() : "";
      setHtml(oc, `${mark}${esc(poi.name)}${cleared}${taking && s.capture ? `<b>${Math.floor(s.capture.t)}/${FRONT.capture}</b>` : ""}`);
      oc.classList.toggle("met", own);
    }
    // The story record has a line of its own unless it is the objective.
    const os = $("obj-story");
    const recordLine = !!this.record && this.task?.t !== "record";
    os.hidden = !recordLine;
    if (this.record && recordLine) {
      const r = recordSpot(this.record);
      const held = p.records.includes(this.record) || s.sentRecords.includes(this.record);
      setHtml(os, `<span class="lead">記録</span>${esc(r.name)}${held ? checkIcon() : `<span class="at">${esc(r.place)}</span>`}`);
      os.classList.toggle("met", held);
    }
    const oe = $("obj-event");
    oe.hidden = !s.event;
    if (s.event) setHtml(oe, raidEventLine(s));
    setHtml($("obj-bag"), `バッグ ${this.bagCells(p)}${bagLoad(p)}/${BAG.slots}<span class="worth">・回収 ${haulValue(s)}</span>`);
    // The raid's deadline is the battle's end (past it the raid ends as a wipe), as a clock; the next
    // reinforcements as their mark and seconds; a raid above 強度 0 says so first.
    const left = s.battle ? Math.max(0, s.battle.end - s.time) : null;
    const raid = (s.threat ? `<span>強度 <b>${s.threat}</b></span>` : "") + (s.phase === "play" && left !== null ? `<span class="deadline">${clockIcon()}<b>${clock(left)}</b></span>` : "");
    const next = s.phase !== "play" || s.reinforceT >= 60 ? "" : `<span class="reinforce${s.reinforceT > 0 ? "" : " now"}">${reinforceIcon()}${s.reinforceT > 0 ? `<b>${Math.ceil(s.reinforceT)}</b>` : ""}</span>`;
    setHtml($("obj-raid"), raid + next);
    $("obj-raid").classList.toggle("late", left !== null && left < 120);
    this.islandRow(s);


    // Compass: 2 px per degree, centred on the current heading.
    const heading = ((((p.yaw * 180) / Math.PI) % 360) + 360) % 360;
    const half = $("compass").clientWidth / 2;
    $("compass-strip").style.transform = `translateX(${half - (heading + 360) * 2}px)`;
    this.placeMark(heading, half);
    this.placeScout(s, heading, half);
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
    for (const k of HEAL_KINDS) $(`n-${k}`).textContent = String(p.heals[k]);
    // The mod parts worn, oldest first (the one a full set swaps out), with an empty frame per free slot.
    setHtml($("mods"), Array.from({ length: MOD.slots }, (_, i) => (p.mods[i] ? `<i title="${esc(MODS[p.mods[i]].note)}">${esc(MODS[p.mods[i]].short)}</i>` : `<i class="free"></i>`)).join(""));

    // Abilities.
    const tac = $("ab-tac");
    tac.style.setProperty("--p", String(1 - p.tactical / tacticalCooldown(p)));
    tac.className = p.tactical <= 0 ? "ab ready" : "ab cool";
    const ult = $("ab-ult");
    ult.style.setProperty("--p", String(p.ult));
    ult.className = p.ult >= 1 ? "ab ult ready" : "ab ult";
    $("ult-pct").textContent = p.ult >= 1 ? "離脱" : `${Math.floor(p.ult * 100)}%`;
    $("fx-ult").style.opacity = p.leap ? "1" : "0";
    // The same charge on the touch buttons.
    const tTac = $("t-tac");
    tTac.style.setProperty("--p", String(1 - p.tactical / tacticalCooldown(p)));
    tTac.classList.toggle("ready", p.tactical <= 0);
    const tUlt = $("t-ult");
    tUlt.style.setProperty("--p", String(p.ult));
    tUlt.classList.toggle("ready", p.ult >= 1);
    $("t-ult-pct").textContent = $("ult-pct").textContent;
    $("t-cells").textContent = pickHeal(s) ? String(HEAL_KINDS.reduce((n, k) => n + p.heals[k], 0)) : "-";

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
      (el.querySelector(".name") as HTMLElement).textContent = `${i + 1}  ${WEAPONS[wpn.kind].name}`;
      const ammo = el.querySelector(".ammo b") as HTMLElement;
      ammo.textContent = p.reload > 0 && i === p.slot ? "…" : String(mag);
      (el.querySelector(".ammo small") as HTMLElement).textContent = `/${size}`;
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
    $("prompt").innerHTML = prompt;
    $("t-use").hidden = prompt === "";

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
    // A counter-attack's squad ashore and walking to a node of the player's: the arrow, fainter, before it gets there.
    const coming = countered(s);
    NODES.forEach((n, i) => {
      const at = !!b && b.threat[i];
      const on = (at || coming[i]) && s.phase === "play";
      let el = this.threatEls.get(i);
      if (!on) {
        if (el) el.style.display = "none";
        return;
      }
      if (!el) {
        el = document.createElement("div");
        this.awareLayer.appendChild(el);
        this.threatEls.set(i, el);
      }
      el.className = at ? "threat-mark" : "threat-mark coming";
      const sp = view.project({ x: n.core.x, y: n.core.y + FRONT.height + 2.5, z: n.core.z }, w, h);
      let x = sp.x;
      let y = sp.y;
      let angle = 180;
      const cy = (TOP + h - BOTTOM) / 2;
      if (sp.behind || x < M || x > w - M || y < TOP || y > h - BOTTOM) {
        // Off screen: on the edge, the way to the core from the middle of the screen.
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
    });
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

    // One line under the objective: how hidden the player is right now, by the eye's colour and a word.
    const st = $("obj-stealth");
    const word = s.phase !== "play" || !near ? "" : worst === 3 && !tracked && anyLost ? "見失わせた" : worst === 3 ? "交戦" : worst === 2 ? "警戒" : worst === 1 ? "見られている" : "未発見";
    setHtml(st, word ? `${eyeIcon("currentColor", worst === 0 || (worst === 3 && !tracked && anyLost))}${word}` : "");
    st.className = worst === 3 && !tracked && anyLost ? "lost" : worst === 3 ? "engaged" : worst === 2 ? "alert" : "";
  }

  /**
   * Extraction points of the region the player is in: a line each on the objective card with
   * its condition, and no distance or marker; where they are is on the map (M).
   */
  private exits(s: State) {
    const p = s.player;
    if (s.phase !== "play") {
      $("obj-exits").innerHTML = "";
      return;
    }
    const lines: string[] = [];
    const exits = regionHere(p.pos).exits.map((id) => EXTRACTS.find((x) => x.id === id)!);
    // The phone layout keeps only a live exit's line (style.css), so the card stays above the vitals; `near` marks the nearest for the desktop.
    const nearest = exits.reduce((best, x, i) => (dist2d(p.pos, x) < dist2d(p.pos, exits[best]) ? i : best), 0);
    // Each way off by how it works, in a mark and seconds: a craft to call (the seconds it takes,
    // counting down once called, a tick once landed), a flare (lit when carried) and the seconds to
    // wait, or only the wait.
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
      // A called ship or a flare in hand is news worth a line even on the phone.
      const live = (x.call && left >= 0) || (x.needsFlare && ready);
      const cls = [locked && "locked", i === nearest && "near", live && "live"].filter(Boolean).join(" ");
      lines.push(`<div class="${cls}">${exitIcon()}<b>${x.short}</b><span>${state}</span></div>`);
    });
    $("obj-exits").innerHTML = lines.join("");
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

  /** Where the objective's compass marker points: the bearing (degrees from north) and metres to the current step's place. */
  private mark: { bearing: number; d: number } | null = null;

  private compassMark(s: State, at: { x: number; z: number } | null) {
    const p = s.player.pos;
    // Standing at the place already, the marker would only point at the player's feet.
    this.mark = at && s.phase === "play" && dist2d(p, at) > 8 ? { bearing: (((Math.atan2(at.x - p.x, -(at.z - p.z)) * 180) / Math.PI) % 360 + 360) % 360, d: dist2d(p, at) } : null;
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
   * The compass's one marker: the current objective step's bearing, held at the strip's edge when
   * it is behind, with its distance. It is the only marker or distance the HUD shows.
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
    const label = `${Math.round(this.mark.d)}m`;
    if (el.firstElementChild!.textContent !== label) el.firstElementChild!.textContent = label;
  }

  /**
   * How far the objective's current step has gone, as a number: a capture's seconds (orange while
   * it stands still), or the step's own count (`Step.progress`). A step with nothing to count shows
   * nothing; its label and the beacon say what it asks.
   */
  private stepProgress(s: State, step: Step): string {
    if (step.kind === "hold") {
      const c = s.capture;
      return `<b class="${c && !c.held ? "paused" : ""}">${Math.floor(c?.t ?? 0)}/${FRONT.capture}</b>`;
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
    if (s.leaving) return `${depotIcon()}<b>${Math.max(0, s.leaving.t).toFixed(1)}</b>`;
    // The use key comes first: picking the teammate up or opening a bin works inside an extraction point too.
    const t = useTarget(s);
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
      if (depotBlocked(s) && depotInReach(s) >= 0) return `${depotIcon()}${crossIcon()}${fightIcon("#ff6b5a")}`;
      // Back in the camp's yard with a fight close by: it takes the player home once that is over.
      if (homeReady(s) && depotBlocked(s)) return `野営地${crossIcon()}${fightIcon("#ff6b5a")}`;
      // Standing on something that will not go in: a mod part already worn, or a full bag.
      const left = s.loot.find((l) => (l.kind === "valuable" || l.kind === "tool" || l.kind === "record" || l.kind === "mod") && l.age >= 0.4 && dist2d(l.pos, p.pos) < PLAYER.pickupRange && Math.abs(l.pos.y - p.pos.y) < 2);
      if (left?.mod) return `${esc(MODS[left.mod].name)} ${checkIcon()}`;
      const full = `${bagIcon()}<b>${bagLoad(p)}/${BAG.slots}</b>`;
      if (left?.valuable) return `${esc(VALUABLES[left.valuable].label)} ${full}`;
      if (left?.tool) return `${esc(TOOLS[left.tool].label)} ${full}`;
      if (left?.record) return `${esc(recordSpot(left.record).name)} ${full}`;
      // Before a closed route's obstacle: its name, a padlock and the tool that opens it (ticked when carried).
      const r = routeBefore(p.pos, s.routes);
      if (!r) return "";
      const tool = esc(TOOLS[r.tool].label);
      return `${esc(r.name)} ${lockIcon()}<span class="r" style="color:${RARITY_CSS[3]}">${tool}</span>${p.tools.includes(r.tool) ? checkIcon() : ""}`;
    }
    if (t.kind === "tool") {
      const k = t.loot.tool!;
      const out = (roomForTool(p, k) ?? []).map((i) => VALUABLES[p.haul[i]].label);
      return `${key("E")}<span class="r" style="color:${RARITY_CSS[3]}">${TOOLS[k].label}</span> ${bagIcon()}${TOOLS[k].size}${struck(out)}`;
    }
    if (t.kind === "mod") {
      const k = t.loot.mod!;
      const off = p.mods.length >= MOD.slots ? p.mods[0] : null;
      return `${key("E")}<span class="r" style="color:${RARITY_CSS[2]}">${MODS[k].name}</span>${off ? struck([MODS[off].name]) : ""}`;
    }
    if (t.kind === "ally") return s.ally.helped > 0 ? `${reviveIcon()}${ALLY.name} <b>${Math.floor((s.ally.helped / helpTime(p)) * 100)}%</b>` : `${key("E")}${reviveIcon()}${ALLY.name}`;
    if (t.kind === "bin") {
      const q = p.search;
      const b = s.bins[t.index];
      const what = b.vault ? "保管庫" : "補給箱";
      if (q?.bin === t.index) return `${what} <b>${Math.floor((q.t / searchFor(p, b)) * 100)}%</b>`;
      if (!canOpen(s, b)) return `${what} ${lockIcon()}${keyIcon(RARITY_CSS[3])}${esc(POIS[b.poi].name)}`;
      return `${key("E")}${what} ${noiseIcon()}`;
    }
    if (t.kind === "swap") {
      const v = t.loot.valuable!;
      const out = (makeRoom(p.haul, v, p.tools, p.records.length) ?? []).map((i) => VALUABLES[p.haul[i]].label);
      return `${key("E")}${esc(VALUABLES[v].label)}${struck(out)}`;
    }
    if (t.kind === "care") return `${key("E")}補給ポッド`;
    if (t.kind === "depot") {
      if (!p.haul.length && !p.tools.length && !p.records.length) return `${key("E")}${depotIcon()}切り上げる ${clockIcon()}${DEPOT.leave} 秒`;
      const value = p.haul.reduce((n, k) => n + VALUABLES[k].value, 0);
      return `${key("E")}${depotIcon()}${upIcon()}${p.haul.length + p.tools.length + p.records.length} 点・${value}`;
    }
    if (t.kind === "armor") return `${key("E")}<span class="r" style="color:${RARITY_CSS[t.loot.rarity]}">アーマー Lv${t.loot.rarity}</span>${struck([`Lv${p.armor}`])}`;
    if (t.kind === "core") {
      const n = NODES[t.node];
      if (!capturable(s, t.node)) return `${coreIcon(SIDE.enemy, true)}${esc(n.name)}`;
      if (s.capture?.node === t.node) return `${coreIcon(SIDE.enemy)}${esc(n.name)} <b>${Math.floor((s.capture.t / FRONT.capture) * 100)}%</b>`;
      return `${key("E")}${coreIcon(SIDE.enemy)}${esc(n.name)} ${noiseIcon()}`;
    }
    if (t.kind === "zip") {
      // The way the rider would go: the end the player faces, and how far along the cable it is.
      const l = ZIPS[t.line];
      const at = zipPoint(l, t.at);
      const toB = Math.sin(p.yaw) * at.dx - Math.cos(p.yaw) * at.dz >= 0;
      const end = toB ? l.b : l.a;
      const name = end === "camp" ? "野営地" : (NODES.find((n) => n.id === end)?.name ?? "");
      return `${key("E")}${zipIcon()}${esc(name)} <b>${Math.round(toB ? l.length - t.at : t.at)}</b> m`;
    }
    const wl = t.loot;
    const swap = p.weapons.includes(null) ? "" : struck([WEAPONS[p.weapons[p.slot]!.kind].name]);
    return `${key("E")}<span class="r" style="color:${RARITY_CSS[wl.rarity]}">${WEAPONS[wl.weapon!.kind].name}</span> ${RARITY.names[wl.rarity]}${swap}`;
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
      return `<button type="button" class="mod${k === done ? " done" : ""}" data-analyse="${k}"${done || old ? " disabled" : ""}>${bin}<b>${esc(MODS[k].name)}${state}</b><small>${esc(MODS[k].note)}</small></button>`;
    };
    return `<h3>改造パーツの解析<b>${done ? 1 : 0}/1</b></h3><div class="analyse">${settled.analysable.map(row).join("")}</div>`;
  }

  /**
   * The results' day: the island's map and its tug of war, played in beats. The map is drawn as
   * the day began; then the nodes that changed hands while the player was out turn to the colour
   * they went to (a ring on the map, the bar's boundary sliding); then, under the depot's mark,
   * those the battle went on to take after the player left; then, under the moon, those the enemy
   * took overnight (`drawDay()`).
   */
  private dayResult(s: State, settled?: Settlement): string {
    const holds = settled ? islandHolds(settled.profile) : s.nodes;
    return `<canvas id="day-map"></canvas><div class="day-row"><small>${settled ? `${settled.day} 日目` : "今日"}</small><span id="day-bar">${nodeRow(holds)}</span><span id="day-beat"></span></div>`;
  }

  /** Seconds after the results open at which the map turns to the day's end. */
  private dayTimers: number[] = [];
  private dayFrame = 0;

  /** Draws the results' map and bar beat by beat: as the day began, after the raid, after the battle the player left, after the night. */
  private drawDay(settled?: Settlement) {
    const canvas = document.getElementById("day-map") as HTMLCanvasElement | null;
    for (const t of this.dayTimers) clearTimeout(t);
    this.dayTimers = [];
    cancelAnimationFrame(this.dayFrame);
    if (!canvas || !settled) {
      if (canvas) canvas.hidden = true;
      return;
    }
    const map = new IslandMap(canvas);
    map.whole = true;
    // Ways in the raid learned are dashed as the day began, and turn solid with a ring at its end.
    const learned = settled.learned;
    map.known = settled.profile.entries.filter((e) => !learned.includes(e));
    const end = islandScene(settled.profile);
    // The player's nodes after each beat, from the day's end back.
    const after = (ids: Set<string>, c: { gained: readonly string[]; lost: readonly string[] }, back: boolean) => {
      const out = new Set(ids);
      for (const id of back ? c.gained : c.lost) out.delete(id);
      for (const id of back ? c.lost : c.gained) out.add(id);
      return out;
    };
    const night = new Set<string>(NODES.filter((n) => settled.profile.poiState[n.id].state === "freed").map((n) => n.id));
    const battle = after(night, settled.night, true);
    const left = after(battle, settled.after, true);
    const start = after(left, settled.raid, true);
    const holdsOf = (ids: Set<string>) => NODES.map((n) => (ids.has(n.id) ? "freed" : "held") as "freed" | "held");
    const scene = (ids: Set<string>, changed?: Settlement["raid"]) => ({
      ...end,
      hold: end.hold.map((h, i) => (nodeIndex(POIS[i].id) < 0 ? h : ids.has(POIS[i].id) ? "freed" : "held")),
      nodes: holdsOf(ids),
      changed,
    });
    const bar = (ids: Set<string>, from: Set<string>) => {
      const el = document.getElementById("day-bar");
      if (el) el.innerHTML = nodeRow(holdsOf(ids), undefined, { from: from.size, delay: 0 });
    };
    // The beat on show, for automation (`data-beat`), and its mark.
    const mark = (beat: string, html: string) => {
      const el = document.getElementById("day-beat");
      if (!el) return;
      el.innerHTML = html;
      el.dataset.beat = beat;
    };
    const beats: { beat: string; ids: Set<string>; prev: Set<string>; c: Settlement["raid"]; icon: string }[] = [
      { beat: "raid", ids: left, prev: start, c: settled.raid, icon: "" },
      { beat: "after", ids: battle, prev: left, c: settled.after, icon: depotIcon() },
      { beat: "night", ids: night, prev: battle, c: settled.night, icon: nightIcon() },
    ].filter((b) => b.c.gained.length || b.c.lost.length);
    // Milliseconds between the beats; automation may slow them (`window.ringfallBeatGap`) to shoot each.
    const gap = (window as { ringfallBeatGap?: number }).ringfallBeatGap ?? 1600;
    // Drawn once the results are shown, so the map is drawn at the canvas's size on screen.
    this.dayFrame = requestAnimationFrame(() => {
      map.draw(scene(start));
      bar(start, start);
      mark("start", "");
      // The ways in the raid learned turn solid with the first beat (or alone, when nothing changed hands).
      const learn = () => {
        map.known = settled.profile.entries;
      };
      beats.forEach((b, k) =>
        this.dayTimers.push(
          window.setTimeout(() => {
            if (k === 0) learn();
            // A beat names only the nodes that changed hands in it: the results' map is small.
            map.draw({ ...scene(b.ids, b.c), learned, names: [...b.c.gained, ...b.c.lost] });
            bar(b.ids, b.prev);
            mark(b.beat, b.icon);
          }, 900 + k * gap),
        ),
      );
      if (!beats.length && learned.length)
        this.dayTimers.push(
          window.setTimeout(() => {
            learn();
            map.draw({ ...scene(night), learned });
          }, 900),
        );
      this.dayTimers.push(
        window.setTimeout(() => {
          const el = document.getElementById("day-beat");
          if (el) el.dataset.beat = "done";
        }, 900 + beats.length * gap),
      );
    });
  }

  results(s: State, settled?: Settlement, known: readonly ModKind[] = [], analysed: ModKind | null = null) {
    $("result-title").textContent = s.home ? "帰った" : s.outcome === "extracted" ? "生還" : "行方不明";
    $("day-result").innerHTML = this.dayResult(s, settled);
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
      ["脱出", s.home ? "野営地" : s.leftAt ? `${POIS[poiIndex(s.leftAt)].name}の中継ボックス` : (EXTRACTS.find((x) => x.id === s.extractedAt)?.short ?? "-")],
      [`${ALLY.name}の撃破`, st.allyKills],
      [`${ALLY.name}に救助`, st.allyRescues],
    ]
      .map(([k, v]) => `<span>${k}<b>${v}</b></span>`)
      .join("");
    const lost = s.outcome !== "extracted";
    const sentValue = s.sent.reduce((n, k) => n + VALUABLES[k].value, 0);
    const value = haulValue(s);
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
      const counted = new Map<string, number>();
      for (const i of items) counted.set(itemName(i), (counted.get(itemName(i)) ?? 0) + 1);
      return [...counted].map(([n, c]) => `<span>${n}${c > 1 ? ` × ${c}` : ""}</span>`).join("");
    };
    const quests = settled?.quests ?? [];
    // A record of a raid kept from before ways in were learned has walked to none.
    const forgot = (s.found ?? []).filter((id) => !this.known.includes(id));
    // The day's income from the nodes the player holds.
    const island = settled?.income ? `<h3 class="day-end">${settled.day} 日目</h3><p><span>拠点の収入<b>${settled.income.toLocaleString()} クレジット</b></span></p>` : "";
    // The contract taken for the raid: done and paid, or not done (it goes with the day).
    const c = settled?.contract;
    const contract = c
      ? `<h3>依頼${settled?.threat ? `（強度 ${settled.threat}）` : ""}</h3><p><span class="contract ${c.done ? "done" : "failed"}">${CONTRACT_NAME[c.c.t]}：${contractText(c.c)}<b>${c.done ? `${checkIcon()}${c.cash ?? c.c.reward.cash} クレジット${rewardList(c.c).map(([i, n]) => `・${itemName(i)}${n > 1 ? ` × ${n}` : ""}`).join("")}` : crossIcon()}</b></span></p>`
      : "";
    // The day's event and how it went: the salvage crews met.
    const ev = settled?.event ?? s.event;
    const outcome: string[] = [];
    if (st.crewsIn)
      outcome.push(
        `<span class="contract${st.crewsOut ? " failed" : " done"}">${CREW.name} ${st.crewsIn}・箱 ${st.crewBins}<b>${[st.crewsDown ? `撃破 ${st.crewsDown}` : "", st.crewsOut ? `逃走 ${st.crewsOut}` : ""].filter(Boolean).join("・") || "—"}</b></span>`,
      );
    const events = ev || outcome.length ? `<h3>島の出来事</h3><p>${ev ? eventRow(ev) : ""}${outcome.join("")}</p>` : "";
    const story = settled?.story ? `<h3>記録を持ち帰った</h3><p><span class="contract done">${storyOf(settled.story.id).title}：${recordSpot(settled.story.id).name}<b>${settled.story.cash} クレジット</b></span></p>` : "";
    // The day's outcome is in the headline; the right column holds what comes of it, then the parts to analyse.
    $("home").innerHTML =
      island +
      events +
      contract +
      story +
      (quests.length ? `<h3>済んだ依頼</h3><p>${quests.map((q) => `<span>${q.title}（${q.reward.cash} クレジット${rewardList(q).map(([i, n]) => `・${itemName(i)}${n > 1 ? ` × ${n}` : ""}`).join("")}）</span>`).join("")}</p>` : "") +
      (settled
        ? (sent.length ? `<h3>中継ボックスから倉庫へ送った物</h3><p>${count(sent)}</p>` : "") +
          // A wipe's pouch is on the haul's line above, beside what was lost.
          (lost ? "" : `<h3>持ち帰った物</h3><p>${home.length ? count(home) : "<span>なし</span>"}</p>`) +
          // Ways in: learned ones as the map's ring, ones found on a raid that did not come home struck through.
          (settled.learned.length || (lost && forgot.length)
            ? `<h3>入口</h3><p>${settled.learned.map((id) => `<span class="learned"><span class="turn">${entryIcon(false)}${entryIcon()}</span>${entryOf(id).name}（${regionOf(entryOf(id).region).name}）</span>`).join("")}${lost ? forgot.map((id) => `<span class="lost">${entryOf(id).name}</span>`).join("") : ""}</p>`
            : "") +
          (settled.opened.length ? `<h3>開いた道</h3><p>${settled.opened.map((id) => `<span>${routeIcon(true)}${routeOf(id).name}</span>`).join("")}</p>` : "") +
          (settled.sold.length ? `<h3>売却</h3><p><span>${settled.sold.length} 点<b>${settled.soldFor} クレジット</b></span></p>` : "")
        : "") +
      this.analysis(s, settled, known, analysed);
  }
}
