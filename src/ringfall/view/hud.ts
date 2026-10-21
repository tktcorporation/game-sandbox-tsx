import type { Settlement } from "../meta/profile";
import type { ModKind } from "../sim/config";
import { itemName, rewardList } from "./hub";
import { ALLY, AWARE, BAG, DEPOT, ENEMIES, HEAL_KINDS, HEALS, PLAYER, RARITY, REVEAL, SCORE, TACTICAL, TOOL_KINDS, TOOLS, VALUABLES, WEAPONS, type Flank } from "../sim/config";
import { eyePos, magSize } from "../sim/combat";
import { dist2d, los } from "../sim/geom";
import { DEPOTS, entryOf, EXTRACTS, NODES, POIS, poiIndex, regionHere, regionOf, routeOf, type EntryId } from "../sim/map";
import { routeBefore } from "../sim/routes";
import { islandHolds, islandNotes, netChangeText, noteText, relayName } from "../meta/island";
import { bagLoad, canOpen, crewsInSight, depotBlocked, depotInReach, extractHere, extractReady, homeReady, makeRoom, poiAt, roomForTool, searchFor, useTarget } from "../sim/world";
import { healTime, tacticalCooldown } from "../sim/player";
import { helpTime, reviveTime } from "../sim/ally";
import { callLeft, debrisBin, enemyHp, retakeKey, enemyShield, weakY, type GameEvent, type State, type Vec3 } from "../sim/state";
import { haulValue, rank } from "../sim/results";
import { pickHeal } from "../sim/player";
import { RARITY_CSS, SCOPE_IN } from "./models";
import { IslandMap } from "./map";
import { CONTRACT_NAME, contractMark, contractTask, contractText, type Contract } from "../meta/contracts";
import { currentStep, objectiveSteps, type Objective, type Task } from "../sim/objective";
import { storyOf } from "../meta/story";
import { recordSpot, type RecordId } from "../sim/map";
import type { World } from "./world";
import { eventRow, raidEventLine } from "./events";
import { CREW, FRONT, MOD, MODS, NETWORK, RETAKE } from "../sim/config";
import { capturable, frontNodes } from "../sim/front";

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
    $("map-view-key").textContent = `で${to}を見る`;
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
  /** What the raid is out to do (the contract, else the story record), for the objective's steps; and those steps as last drawn. */
  private task: Task | null = null;
  private obj: Objective | null = null;
  /** The objective and step last shown, so moving to the next step is told with a toast. */
  private lastStep = "";

  setContract(c: Contract | null, record: RecordId | null) {
    this.contract = c;
    this.record = record;
    this.task = c ? contractTask(c) : record ? { t: "record", id: record } : null;
    this.lastStep = "";
    this.map.contract = c && contractMark(c);
  }

  /** The ways in the base offers, for the raid about to start: the HUD and the map tell the others apart. */
  setKnown(known: EntryId[]) {
    this.known = [...known];
    this.map.known = this.known;
  }

  banner(head: string, sub = "", good = false, time = 2.4) {
    $("banner-head").textContent = head;
    $("banner-sub").textContent = sub;
    $("banner").className = good ? "on good" : "on";
    this.bannerT = time;
  }

  toast(text: string, rarity: number, ms = 2400) {
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = text;
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
      case "relayHit":
        this.hitT = 0.08;
        $("hitmark").className = e.eye ? "crit" : "";
        break;
      case "relayDown":
        this.hitT = 0.4;
        $("hitmark").className = "kill";
        this.banner(`${relayName(e.id)}を壊した`, `網は今夜 ${s.network >= NETWORK.relayHigh.at ? NETWORK.relayHigh.steps : 1} 段下がる`);
        break;
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
        this.banner(`${ALLY.name}がダウン`, isTouch() ? `近くで「使う」を押して起こす（${ALLY.selfUp} 秒で自力で起きる）` : `近くで E を押して起こす（${ALLY.selfUp} 秒で自力で起きる）`);
        break;
      case "allyUp":
        this.toast(e.by === "player" ? `${ALLY.name}を起こした` : `${ALLY.name}が起き上がった`, 1);
        break;
      case "allyRescue":
        this.banner(`${ALLY.name}に起こされた`, "", true, 1.8);
        break;
      case "awaitAlly":
        this.banner("ダウン", `${ALLY.name}が起こしに来る。${ALLY.name}もやられるとレイドは終わる`);
        break;
      case "hurt": {
        this.hurtT = 0.5;
        const el = document.createElement("i");
        $("dmgdir").appendChild(el);
        this.dirs.push({ el, x: e.fromX, z: e.fromZ, t: 0.9 });
        break;
      }
      case "locked":
        this.toast(`${POIS[e.poi].name}の鍵が要る`, 0);
        break;
      case "pickup":
        if (e.kind !== "shard") this.toast(`${e.label}${e.kind === "weapon" ? `（${RARITY.names[e.rarity]}）` : e.kind === "armor" ? `（${RARITY.names[e.rarity]}）` : ""}`, e.rarity);
        break;
      case "poiStart":
        {
          // What the POI's standing on the island means on arrival.
          const h = s.hold?.[e.poi] ?? "held";
          const name = POIS[e.poi].name;
          if (POIS[e.poi].boss) this.banner("タイタンの縄張り", "足元の衝撃波はジャンプでかわせる");
          else if (h === "freed") this.banner(`${name}（解放）`, "守備隊はいない。保管庫は鍵なしで開く");
          else this.banner(h === "thin" ? `${name}（手薄）` : name, h === "thin" ? "守備隊は半分。全滅させて生還すると解放に戻る" : "部隊を全滅させて生還すると解放になる");
        }
        break;
      case "poiClear":
        this.banner(`${POIS[e.poi].name} 制圧`, POIS[e.poi].boss ? "タイタン撃破。データコアを拾って脱出せよ" : `生還すれば解放になり +${SCORE.poi} 点。自己蘇生が戻った`, true, POIS[e.poi].boss ? 3.2 : 2.4);
        break;
      case "reinforce":
        this.banner("増援が降下した", "ロボット部隊がこちらを探している");
        break;
      case "raiders":
        this.banner("レイダーが降下した", "精鋭部隊がこちらを狩りに来る。横から回り込んでくる");
        break;
      case "shipCalled": {
        const x = EXTRACTS.find((o) => o.id === e.id)!;
        this.banner(`${x.short}を呼んだ`, `到着まで ${x.call} 秒。増援が降りてくる`);
        break;
      }
      case "shipLanded":
        this.banner(e.id === "ship" ? "ドロップシップ着陸" : `${EXTRACTS.find((o) => o.id === e.id)!.short}到着`, "乗り込め", true);
        break;
      case "flareLit":
        this.toast("発煙筒を焚いた：回収を待て", 3);
        break;
      case "careDrop":
        this.banner("補給ポッド投下", "金色の光の下にレジェンド武器", true);
        break;
      case "down":
        if (!s.player.awaitAlly) this.banner("ダウン", "3 秒で自己蘇生する");
        break;
      case "wipe":
        this.banner("行方不明", "集めた物は持ち帰れなかった");
        break;
      case "bossPhase":
        this.banner("タイタン 怒り状態", "攻撃が速くなる");
        break;
      case "engage":
        if (!s.squads[e.squad]?.engaged) break;
        for (const r of s.enemies) if (r.squad === e.squad) this.spotted.set(r.id, 2.5);
        if (s.squads[e.squad].name !== "タイタン") this.toast(`発見された：${s.squads[e.squad].name}`, 0);
        break;
      case "calm":
        this.toast("見失わせた：部隊が捜索に移った", 1);
        break;
      case "tacticalMiss":
        this.toast("前方に敵がいない", 0);
        break;
      case "leapBlocked":
        this.toast("屋根の下では跳べない", 0);
        break;
      case "entryFound":
        // Longer than other toasts: it says what to do for the find to count.
        if (!this.known.includes(e.id)) this.toast(`この場所を覚えた：${entryOf(e.id).name}（生きて帰れば次からここから入れる）`, 1, 5000);
        break;
      case "depotOn":
        this.toast(`中継ボックスを起動した：${POIS[poiIndex(e.poi)].name}`, 1);
        break;
      case "deposit":
        this.toast(`倉庫へ送った ${e.n} 点（${e.value}）`, 3);
        break;
      case "leaveCancel":
        this.toast("切り上げを取り消した", 0);
        break;
      case "coreStart":
        this.toast(`警報：${NODES[e.node].name}の制圧を始めた。核の ${FRONT.radius} m 以内を守り抜け`, 0, 4000);
        break;
      case "coreShielded":
        this.toast(`${NODES[e.node].name}の核は網に守られている：陣地に隣り合う前線の節だけ制圧できる`, 0, 4000);
        break;
      case "coreTaken":
        this.toast(`${NODES[e.node].name}を制圧した。生きて帰れば解放のまま残る`, 1, 5000);
        break;
      case "retakeIn":
        this.toast(`${RETAKE.name}が${POIS[e.poi].name}へ向かっている`, 0, 4000);
        break;
      case "crewOut":
        // Heard over the radio wherever the player is: the network has the bag now.
        this.toast(`${CREW.name}が回収品 ${e.n} 個を持って島を出た`, 0, 4000);
        break;
      case "ultReady":
        this.toast(isTouch() ? "離脱ジャンプ 準備完了" : "離脱ジャンプ 準備完了（Z）", 3);
        break;
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
      // The masts' key only on the days they stand.
      $("map-mast-key").hidden = !s.relays.length;
    }

    // Objective card: the objective's current step, large, what finishes it and how far it has
    // gone under it, and the step's place in the list (sim/objective.ts).
    const here = poiAt(s);
    const poi = POIS[here];
    const active = here >= 0;
    const remaining = s.enemies.filter((e) => e.poi === here).length;
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
    setHtml($("obj-until"), s.phase === "play" && step ? `${esc(step.until)}${step.progress ? `<b>${esc(step.progress)}</b>` : ""}` : "");
    // A step done moves the card on to the next, told with a short toast.
    const key = `${obj.title}|${obj.current}`;
    if (this.lastStep && key !== this.lastStep && s.phase === "play" && step && this.lastStep.split("|")[0] === obj.title) this.toast(`次：${step.label}`, 3, 2600);
    this.lastStep = key;
    view.setBeacon(s.phase === "play" ? (step?.at ?? null) : null);
    this.compassMark(s, step?.at ?? null);
    // The POI the player is in and its garrison left, under the step.
    const oc = $("obj-contract");
    oc.hidden = !poi || s.phase !== "play";
    if (poi) setHtml(oc, esc(poi.boss ? "タイタンの縄張り" : `${poi.name}：部隊 残り ${remaining}`));
    oc.classList.remove("met");
    // The story record has a line of its own while a contract is the objective.
    const os = $("obj-story");
    os.hidden = !this.record || !this.contract;
    if (this.record && this.contract) {
      const r = recordSpot(this.record);
      const held = p.records.includes(this.record) || s.sentRecords.includes(this.record);
      setHtml(os, `<span class="lead">記録：</span>${esc(held ? `${r.name}を持っている。持ち帰る` : `${r.place}の${r.name}`)}`);
      os.classList.toggle("met", held);
    }
    const oe = $("obj-event");
    oe.hidden = !s.event;
    if (s.event) setHtml(oe, raidEventLine(s));
    $("obj-count").textContent = `回収 ${haulValue(s)}`;
    $("obj-bag").textContent = `バッグ ${bagLoad(p)}/${BAG.slots}`;
    // A raid above threat 0 says so before its clock.
    const raid = (s.threat ? `脅威度 ${s.threat}　` : "") + (s.phase === "play" ? `${clock(s.time)}` : "");
    const next = s.phase !== "play" || s.reinforceT >= 60 ? "" : s.reinforceT > 0 ? `　増援まで ${Math.ceil(s.reinforceT)} 秒` : "　増援が来る";
    $("obj-raid").textContent = raid + next;


    // Compass: 2 px per degree, centred on the current heading.
    const heading = ((((p.yaw * 180) / Math.PI) % 360) + 360) % 360;
    const half = $("compass").clientWidth / 2;
    $("compass-strip").style.transform = `translateX(${half - (heading + 360) * 2}px)`;
    this.placeMark(heading, half);
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
      $("downed-sub").textContent = a.rescue > 0 ? `${ALLY.name}が起こしている` : `${ALLY.name}を待っている（${Math.ceil(p.downed)} 秒）`;
      $("downed-bar").style.width = `${(a.rescue / reviveTime(p)) * 100}%`;
    } else {
      $("downed-sub").textContent = "自己蘇生中";
      $("downed-bar").style.width = `${(1 - p.downed / PLAYER.downedTime) * 100}%`;
    }
    this.mate(s, view, w, h);
    $("battery").className = p.healing ? "on" : "";
    if (p.healing) {
      $("heal-label").textContent = `${HEALS[p.healing.kind].label}を使用中`;
      $("battery-bar").style.width = `${(1 - p.healing.t / healTime(p, p.healing.kind)) * 100}%`;
      $("battery-bar").style.background = HEALS[p.healing.kind].shield ? "" : "var(--hp-heal)";
    }

    this.bannerT -= dt;
    if (this.bannerT <= 0) $("banner").className = "";
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

    // One line under the objective: how hidden the player is right now.
    const st = $("obj-stealth");
    const text =
      s.phase !== "play" || !near
        ? ""
        : worst === 3 && !tracked && anyLost
          ? "見失わせた：回り込め"
          : worst === 3
          ? "交戦中：遮蔽物を使え"
          : worst === 2
            ? "警戒中：先手を取れ"
            : worst === 1
              ? "見られている：視線を切れ"
              : p.crouch
                ? "未発見・しゃがみ中"
                : "未発見";
    st.textContent = text;
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
    // The phone layout keeps only the nearest exit's line, so the card stays above the vitals.
    const nearest = exits.reduce((best, x, i) => (dist2d(p.pos, x) < dist2d(p.pos, exits[best]) ? i : best), 0);
    exits.forEach((x, i) => {
      const ready = extractReady(s, x);
      const left = callLeft(s, x.id);
      const state = x.call
        ? left < 0
          ? x.note
          : left > 0
            ? `到着まで ${Math.ceil(left)} 秒：持ちこたえろ`
            : "着いた：乗り込め"
        : x.needsFlare
          ? p.flares > 0
            ? "発煙筒あり：4 秒で回収"
            : "発煙筒が要る（高い建物の最上階）"
          : x.note;
      const locked = x.needsFlare && !ready;
      // A called ship or a flare in hand is news worth a line even on the phone.
      const live = (x.call && left >= 0) || (x.needsFlare && ready);
      const cls = [locked && "locked", i === nearest && "near", live && "live"].filter(Boolean).join(" ");
      lines.push(`<div class="${cls}"><b>${x.short}</b><span>${state}</span></div>`);
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
    const state = down
      ? a.helped > 0
        ? `起こしている ${Math.floor((a.helped / helpTime(s.player)) * 100)}%`
        : `ダウン ${Math.ceil(a.down)}秒`
      : a.rescue > 0
        ? "あなたを起こしている"
        : p.downed > 0 && p.awaitAlly
          ? "救助に向かっている"
          : a.target
            ? "交戦中"
            : "ついてくる";
    $("mate-state").textContent = state;
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
    this.mark = at && s.phase === "play" ? { bearing: (((Math.atan2(at.x - p.x, -(at.z - p.z)) * 180) / Math.PI) % 360 + 360) % 360, d: dist2d(p, at) } : null;
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

  private prompt(s: State): string {
    const p = s.player;
    if (p.downed > 0 || s.phase !== "play") return "";
    if (s.leaving) return `切り上げ中 ${Math.max(0, s.leaving.t).toFixed(1)} 秒（離れる・戦闘になると中断）`;
    // The use key comes first: picking the teammate up or opening a bin works inside an extraction point too.
    const t = useTarget(s);
    const x = t ? null : extractHere(s);
    if (x) {
      if (x.call && callLeft(s, x.id) > 0) return `${x.short}到着まで ${Math.ceil(callLeft(s, x.id))} 秒`;
      if (x.needsFlare && p.flares <= 0) return "発煙筒がない：高い建物の最上階の補給箱にある";
      return `脱出中 ${Math.floor((s.extractTime / x.hold) * 100)}%`;
    }
    // The same choice the use key acts on (sim/world.ts useTarget), so the prompt never promises something else.
    if (!t) {
      // At a depot that is on, which useTarget passes over while a squad is fighting: say why.
      if (depotBlocked(s) && depotInReach(s) >= 0) return "中継ボックス：戦闘中は使えない";
      // Back in the camp's yard with a fight close by: it takes the player home once that is over.
      if (homeReady(s) && depotBlocked(s)) return "戦っているロボットが近くにいる間は帰れない";
      // Standing on a valuable that will not go in, and nothing in the bag is worth less.
      const left = s.loot.find((l) => (l.kind === "valuable" || l.kind === "tool" || l.kind === "record" || l.kind === "mod") && l.age >= 0.4 && dist2d(l.pos, p.pos) < PLAYER.pickupRange && Math.abs(l.pos.y - p.pos.y) < 2);
      if (left?.mod) return `改造パーツ：${MODS[left.mod].name}はもう付けている`;
      if (left?.valuable) return `バッグがいっぱい：${VALUABLES[left.valuable].label}は入らない`;
      if (left?.tool) return `バッグがいっぱい：${TOOLS[left.tool].label}は入らない`;
      if (left?.record) return `バッグがいっぱい：${recordSpot(left.record).name}は 1 枠空けると拾える`;
      // At the objective step's place: what to do there.
      const st = this.obj && currentStep(this.obj);
      if (st?.near && st.at && dist2d(st.at, p.pos) < 8 && Math.abs(st.at.y - p.pos.y) < 4) return st.near;
      // Before a closed route's obstacle: which tool opens it.
      const r = routeBefore(p.pos, s.routes);
      if (!r) return "";
      const tool = TOOLS[r.tool].label;
      return p.tools.includes(r.tool) ? `${r.name}：${tool}を持ち帰れば、次のレイドから通れる` : `${r.name}：${tool}があれば開く`;
    }
    if (t.kind === "tool") {
      const k = t.loot.tool!;
      const out = (roomForTool(p, k) ?? []).map((i) => VALUABLES[p.haul[i]].label);
      return `${key("E")}<span class="r" style="color:${RARITY_CSS[3]}">${TOOLS[k].label}</span>を持つ（${TOOLS[k].size} 枠${out.length ? `・${out.join("・")}を捨てる` : ""}）`;
    }
    if (t.kind === "mod") {
      const k = t.loot.mod!;
      const off = p.mods.length >= MOD.slots ? p.mods[0] : null;
      return `${key("E")}<span class="r" style="color:${RARITY_CSS[2]}">改造パーツ：${MODS[k].name}</span>を付ける（${esc(MODS[k].note)}${off ? `・${MODS[off].name}を外す` : ""}）`;
    }
    if (t.kind === "ally") return s.ally.helped > 0 ? `${ALLY.name}を起こしている…（撃つ・離れると中断）` : `${key("E")}${ALLY.name}を起こす`;
    if (t.kind === "bin") {
      const q = p.search;
      const b = s.bins[t.index];
      const what = b.vault ? "保管庫" : "補給箱";
      if (q?.bin === t.index) return `${what}を調べている… ${Math.floor((q.t / searchFor(p, b)) * 100)}%（撃つ・離れると中断）`;
      if (!canOpen(s, b)) return `保管庫：${POIS[b.poi].name}の鍵が要る`;
      return `${key("E")}${what}を${b.vault ? "開ける" : "調べる"}（音が出る）`;
    }
    if (t.kind === "swap") {
      const v = t.loot.valuable!;
      const out = (makeRoom(p.haul, v, p.tools, p.records.length) ?? []).map((i) => VALUABLES[p.haul[i]].label);
      return `${key("E")}${VALUABLES[v].label}と入れ替える（${out.join("・")}を捨てる）`;
    }
    if (t.kind === "care") return `${key("E")}補給ポッドを開ける`;
    if (t.kind === "depot") {
      if (!p.haul.length && !p.tools.length && !p.records.length) return `${key("E")}ここで切り上げる（${DEPOT.leave} 秒そばに立つ）`;
      const value = p.haul.reduce((n, k) => n + VALUABLES[k].value, 0);
      return `${key("E")}倉庫へ送る（${p.haul.length + p.tools.length + p.records.length} 点・${value}）`;
    }
    if (t.kind === "armor") return `${key("E")}<span class="r" style="color:${RARITY_CSS[t.loot.rarity]}">アーマー Lv${t.loot.rarity}</span>に着替える（Lv${p.armor} を置く）`;
    if (t.kind === "core") {
      const n = NODES[t.node];
      if (!capturable(s, t.node)) return `${n.name}の核：網に守られている。陣地に隣り合う前線の節だけ制圧できる`;
      if (s.capture?.node === t.node) return `${n.name}を制圧中 ${Math.floor((s.capture.t / FRONT.capture) * 100)}%（半径 ${FRONT.radius} m にとどまる）`;
      return `${key("E")}${n.name}の核を起動して制圧を始める（警報が鳴る）`;
    }
    const wl = t.loot;
    const swap = p.weapons.includes(null) ? "" : `（${WEAPONS[p.weapons[p.slot]!.kind].name} と交換）`;
    return `${key("E")}<span class="r" style="color:${RARITY_CSS[wl.rarity]}">${WEAPONS[wl.weapon!.kind].name}</span> ${RARITY.names[wl.rarity]}を拾う${swap}`;
  }

  /**
   * The results' 戦況: the nodes that turned the player's overnight and those lost, the POIs a wipe
   * left thin after their core was taken, the front as it now stands, and the day's income.
   */
  private frontChange(settled: Settlement): string {
    const name = (id: string) => esc(NODES.find((n) => n.id === id)?.name ?? id);
    const holds = islandHolds(settled.profile);
    const front = NODES.filter((_, i) => frontNodes(holds)[i]).map((n) => n.name);
    const rows = [
      ...(settled.front?.gained ?? []).map((id) => `<span class="freed">＋${name(id)}</span>`),
      ...(settled.front?.lost ?? []).map((id) => `<span class="lost">−${name(id)}</span>`),
      ...(settled.dropped ?? []).map((id) => `<span class="lost">${name(id)}（制圧したが倒れた：手薄）</span>`),
    ];
    return (
      `<h3>戦況</h3><p class="front-change">${rows.join("") || "<span>前線は動かなかった</span>"}</p>` +
      `<p class="sold">前線：${esc(front.join("・") || "なし")}${settled.income ? `　陣地の収入 ${settled.income.toLocaleString()} クレジット` : ""}</p>`
    );
  }

  /**
   * The results' analysis: the mod parts brought out alive, one of which the player may analyse
   * (its kind then turns up in bins), `known` the kinds known before, `done` the one analysed.
   */
  private analysis(s: State, settled: Settlement | undefined, known: readonly ModKind[], done: ModKind | null): string {
    const worn = s.player.mods ?? [];
    if (!settled || !worn.length) return "";
    if (!settled.analysable.length) return `<p class="sold">生きて帰れなかったので、付けていた改造パーツ（${worn.map((k) => MODS[k].name).join("・")}）は解析できない</p>`;
    const row = (k: ModKind) => {
      const old = known.includes(k);
      const state = k === done ? "解析した。次のレイドから補給箱に出る" : old ? "解析済みの種類" : done ? "" : "新しい種類。解析すると補給箱に出るようになる";
      return `<button type="button" class="mod${k === done ? " done" : ""}" data-analyse="${k}"${done || old ? " disabled" : ""}><b>${esc(MODS[k].name)}</b><small>${esc(MODS[k].note)}</small>${state ? `<em>${state}</em>` : ""}</button>`;
    };
    const head = done ? "改造パーツを解析した" : settled.analysable.some((k) => !known.includes(k)) ? "改造パーツを 1 つ解析する" : "改造パーツ（どれも解析済み）";
    return `<h3>${head}</h3><div class="analyse">${settled.analysable.map(row).join("")}</div><p class="sold">改造パーツはレイドが終わると消える。解析は生きて帰ったときに 1 つだけ</p>`;
  }

  results(s: State, settled?: Settlement, known: readonly ModKind[] = [], analysed: ModKind | null = null) {
    const r = rank(s);
    $("rank").textContent = r.rank;
    $("result-title").textContent = s.home ? "帰った" : s.outcome === "extracted" ? "生還" : "行方不明";
    $("total").textContent = String(r.score);
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
    const haul = [
      ...(Object.keys(VALUABLES) as (keyof typeof VALUABLES)[]).map((k) => [VALUABLES[k].label, s.player.haul.filter((h) => h === k).length] as const),
      ...TOOL_KINDS.map((k) => [TOOLS[k].label, s.player.tools.filter((t) => t === k).length] as const),
    ].filter(([, n]) => n > 0);
    $("pois").innerHTML = [
      // The POIs of the region dropped into, and any visited in the other.
      ...POIS.map((p, i) => ({ p, i }))
        .filter(({ p, i }) => regionOf(s.region).pois.includes(p.id) || s.visited[i])
        .map(({ p, i }) => `<span>${p.name}<b>${settled?.freed.includes(p.id) ? "制圧・解放" : s.hold?.[i] === "freed" ? (s.visited[i] ? "解放済み・立ち寄り" : "解放済み") : s.cleared[i] ? "制圧" : s.visited[i] ? "立ち寄り" : "-"}</b></span>`),
      // What came home is listed beside the results; what was lost is struck through here.
      ...(lost ? haul.map(([label, n]) => `<span class="lost">${label}<b>× ${n}</b></span>`) : []),
      // What went home from a depot is kept on a wipe too, so a lost raid shows the two apart.
      ...(lost && sentValue ? [`<span>倉庫へ送った価値<b>${sentValue}</b></span>`] : []),
      `<span>回収の価値<b>${lost ? `${r.haul - sentValue}（失った）` : r.haul}</b></span>`,
    ].join("");
    // settle() lists what was sent from a depot first in `home`; it is shown on a line of its own.
    const all = settled?.home ?? [];
    const sent = all.slice(0, s.sent.length + s.sentTools.length);
    const home = all.slice(s.sent.length + s.sentTools.length);
    const count = (items: typeof all) => {
      const counted = new Map<string, number>();
      for (const i of items) counted.set(itemName(i), (counted.get(itemName(i)) ?? 0) + 1);
      return [...counted].map(([n, c]) => `<span>${n}${c > 1 ? ` × ${c}` : ""}</span>`).join("");
    };
    const quests = settled?.quests ?? [];
    // A record of a raid kept from before ways in were learned has walked to none.
    const forgot = (s.found ?? []).filter((id) => !this.known.includes(id));
    // The island's day the raid was, what it freed, and what the island does next unless the player acts.
    const island = settled
      ? `<h3 class="day-end">${settled.day} 日目の終わり</h3>` +
        this.frontChange(settled) +
        `<h3>網の段階</h3><p class="net-change"><span class="net${settled.network.to > settled.network.from ? " up" : settled.network.to < settled.network.from ? " down" : ""}">${netChangeText(settled.network)}</span></p>` +
        `<h3>明日の島</h3><ul class="tomorrow">${(islandNotes(settled.profile, settled).map((n) => `<li class="${n.t}${n.t === "fading" && n.days <= 1 ? " soon" : ""}">${noteText(n)}</li>`).join("")) || "<li>島は変わらない。前線の節の核を制圧して生きて帰ると、その節は解放になる</li>"}</ul>`
      : "";
    // The contract taken for the raid: done and paid, or not done (it goes with the day).
    const c = settled?.contract;
    const contract = c
      ? `<h3>依頼</h3><p><span class="contract ${c.done ? "done" : "failed"}">${CONTRACT_NAME[c.c.t]}：${contractText(c.c)}<b>${c.done ? `達成・${c.cash ?? c.c.reward.cash} クレジット${rewardList(c.c).map(([i, n]) => `・${itemName(i)}${n > 1 ? ` × ${n}` : ""}`).join("")}` : "未達成（依頼は今日で消える）"}</b></span></p>`
      : "";
    // The day's event and how it went: the retake squad stopped or not, the salvage crews met.
    const ev = settled?.event ?? s.event;
    const outcome: string[] = [];
    if (ev?.t === "retake" && s.retakePoi >= 0) {
      const name = POIS[s.retakePoi].name;
      outcome.push(s.stats.wiped.includes(retakeKey(ev.poi)) ? `<span class="contract done">${RETAKE.name}を倒した<b>${name}は解放のまま</b></span>` : `<span class="contract failed">${RETAKE.name}を倒せなかった<b>${name}は手薄になった</b></span>`);
    }
    const st2 = s.stats;
    if (st2.crewsIn)
      outcome.push(
        `<span class="contract${st2.crewsOut ? " failed" : " done"}">${CREW.name}：${st2.crewsIn} 組が来て、箱を ${st2.crewBins} 個漁った<b>${[st2.crewsDown ? `${st2.crewsDown} 組を倒した` : "", st2.crewsOut ? `${st2.crewsOut} 組に逃げられた（網 +${st2.crewsOut}）` : ""].filter(Boolean).join("・") || "まだ島にいた"}</b></span>`,
      );
    const events = ev || outcome.length ? `<h3>島の出来事</h3><p>${ev ? eventRow(ev, s.network) : ""}${outcome.join("")}</p>` : "";
    const story = settled?.story ? `<h3>記録を持ち帰った</h3><p><span class="contract done">${storyOf(settled.story.id).title}：${recordSpot(settled.story.id).name}<b>${settled.story.cash} クレジット・依頼板で読める</b></span></p>` : "";
    $("home").innerHTML = this.analysis(s, settled, known, analysed) + island + events + contract + story + (quests.length ? `<h3>済んだ依頼</h3><p>${quests.map((q) => `<span>${q.title}（${q.reward.cash} クレジット${rewardList(q).map(([i, n]) => `・${itemName(i)}${n > 1 ? ` × ${n}` : ""}`).join("")}）</span>`).join("")}</p>` : "") + (settled
      ? (sent.length ? `<h3>中継ボックスから倉庫へ送った物</h3><p>${count(sent)}</p>` : "") +
        `<h3>${lost ? "ポーチに残った物" : "持ち帰った物"}</h3><p>${home.length ? count(home) : "<span>なし</span>"}</p>` +
        (settled.learned.length ? `<h3>次から選べる入口</h3><p>${settled.learned.map((id) => `<span>${entryOf(id).name}（${regionOf(entryOf(id).region).name}）</span>`).join("")}</p>` : "") +
        (lost && forgot.length ? `<p class="sold">生きて帰れなかったので、見つけた入口（${forgot.map((id) => entryOf(id).name).join("・")}）は覚えられなかった</p>` : "") +
        (settled.opened.length ? `<h3>開いた道</h3><p>${settled.opened.map((id) => `<span>${routeOf(id).name}（${TOOLS[routeOf(id).tool].label}を使った）</span>`).join("")}</p>` : "") +
        (settled.sold.length ? `<p class="sold">倉庫に入りきらない ${settled.sold.length} 点は ${settled.soldFor} クレジットで売った</p>` : "")
      : "");
  }
}
