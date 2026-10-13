import type { Settlement } from "../meta/profile";
import { itemName } from "./hub";
import { ALLY, AWARE, BAG, ENEMIES, HEAL_KINDS, HEALS, PLAYER, RARITY, REVEAL, SCORE, TACTICAL, VALUABLES, WEAPONS, type Flank } from "../sim/config";
import { magSize } from "../sim/combat";
import { dist2d } from "../sim/geom";
import { EXTRACTS, POIS } from "../sim/map";
import { bagUsed, extractHere, extractReady, makeRoom, poiAt, searchTime, useTarget } from "../sim/world";
import { enemyHp, enemyShield, type GameEvent, type State, type Vec3 } from "../sim/state";
import { haulValue, rank } from "../sim/results";
import { pickHeal } from "../sim/player";
import { RARITY_CSS, SCOPE_IN } from "./models";
import { IslandMap } from "./map";
import type { World } from "./world";

/*
 * The DOM layer: everything the player reads. The screen always answers two
 * questions: what to do next (objective card, and the map for where things are) and how am I doing
 * (shield cells, health, ammo, ability charge).
 */

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
}

/** Tag shown with a damage number, by how the shot met the robot. */

const FLANK_TAG: Partial<Record<Flank, string>> = { back: "背後", ambush: "奇襲" };
const FLANK_RANK: Record<Flank, number> = { front: 0, none: 1, side: 1, back: 2, ambush: 3 };

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

  /** Open or close the island map; it is redrawn every frame while open. */
  toggleMap(force?: boolean) {
    this.mapOpen = force ?? !this.mapOpen;
    $("map").hidden = !this.mapOpen;
  }

  constructor() {
    $("map-close").addEventListener("click", () => this.toggleMap(false));
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

  banner(head: string, sub = "", good = false, time = 2.4) {
    $("banner-head").textContent = head;
    $("banner-sub").textContent = sub;
    $("banner").className = good ? "on good" : "on";
    this.bannerT = time;
  }

  toast(text: string, rarity: number) {
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = text;
    el.style.setProperty("--rc", RARITY_CSS[rarity]);
    $("toasts").appendChild(el);
    setTimeout(() => el.remove(), 2400);
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
        } else {
          const el = document.createElement("div");
          el.className = "dmg";
          this.dmgLayer.appendChild(el);
          this.nums.push({ el, id: e.id, pos: e.pos, value: e.dmg, age: 0, life: 0, crit: e.crit, flank: e.flank });
        }
        const cur = this.nums.find((x) => x.id === e.id && x.age === 0)!;
        const tag = FLANK_TAG[cur.flank];
        cur.el.innerHTML = `${tag ? `<small>${tag}</small>` : ""}${Math.round(cur.value)}`;
        cur.el.className = `dmg${cur.crit ? " crit" : ""}${tag ? " flank" : ""}${cur.flank === "front" ? " front" : ""}`;
        cur.el.style.color = cur.crit ? "" : e.shield ? RARITY_CSS[e.tier] : "#ffffff";
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
      case "pickup":
        if (e.kind !== "shard") this.toast(`${e.label}${e.kind === "weapon" ? `（${RARITY.names[e.rarity]}）` : e.kind === "armor" ? `（${RARITY.names[e.rarity]}）` : ""}`, e.rarity);
        break;
      case "landed":
        this.banner("探索して脱出せよ", "拠点の補給箱とロボットから価値のある物を集め、脱出地点から島を出る");
        break;
      case "poiStart":
        this.banner(POIS[e.poi].boss ? "タイタンの縄張り" : `${POIS[e.poi].name}`, POIS[e.poi].boss ? "足元の衝撃波はジャンプでかわせる" : "部隊を全滅させると制圧になる");
        break;
      case "poiClear":
        this.banner(`${POIS[e.poi].name} 制圧`, POIS[e.poi].boss ? "タイタン撃破。データコアを拾って脱出せよ" : `生還すれば +${SCORE.poi} 点。自己蘇生が戻った`, true, POIS[e.poi].boss ? 3.2 : 2.4);
        break;
      case "reinforce":
        this.banner("増援が降下した", "ロボット部隊がこちらを探している");
        break;
      case "raiders":
        this.banner("レイダーが降下した", "精鋭部隊がこちらを狩りに来る。横から回り込んでくる");
        break;
      case "shipCalled":
        this.banner("ドロップシップを呼んだ", `到着まで ${EXTRACTS[0].call} 秒。増援が降りてくる`);
        break;
      case "shipLanded":
        this.banner("ドロップシップ着陸", "乗り込め", true);
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
      case "ultReady":
        this.toast(isTouch() ? "離脱ジャンプ 準備完了" : "離脱ジャンプ 準備完了（Z）", 3);
        break;
    }
  }

  frame(s: State, view: World, dt: number, w: number, h: number) {
    const p = s.player;
    if (this.mapOpen) {
      if (s.phase === "done") this.toggleMap(false);
      else this.map.draw(s);
    }

    // Objective card.
    const here = poiAt(s);
    const poi = POIS[here];
    const active = here >= 0;
    const remaining = s.enemies.filter((e) => e.poi === here).length;
    let text = "";
    if (s.phase === "drop") text = isTouch() ? "降下中：スティックで着地点を選ぶ" : "降下中：WASD で着地点を選ぶ";
    else if (p.leap) text = isTouch() ? "滑空中：スティックで着地点を選ぶ" : "滑空中：WASD で着地点を選ぶ";
    else if (s.phase === "done") text = s.outcome === "extracted" ? "生還" : "行方不明";
    else if (poi) text = poi.boss ? "タイタンの縄張り" : `${poi.name}：部隊 残り ${remaining}`;
    else text = "探索して脱出せよ";
    $("obj-text").textContent = text;
    $("obj-count").textContent = s.phase === "drop" ? "" : `回収 ${haulValue(s)}`;
    $("obj-bag").textContent = s.phase === "drop" ? "" : `バッグ ${bagUsed(p.haul)}/${BAG.slots}`;
    const raid = s.phase === "play" ? `${clock(s.time - s.landedAt)}` : "";
    const next = s.phase !== "play" || s.reinforceT >= 60 ? "" : s.reinforceT > 0 ? `　増援まで ${Math.ceil(s.reinforceT)} 秒` : "　増援が来る";
    $("obj-raid").textContent = raid + next;


    // Compass: 2 px per degree, centred on the current heading.
    const heading = ((((p.yaw * 180) / Math.PI) % 360) + 360) % 360;
    const half = $("compass").clientWidth / 2;
    $("compass-strip").style.transform = `translateX(${half - (heading + 360) * 2}px)`;
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

    // Abilities.
    const tac = $("ab-tac");
    tac.style.setProperty("--p", String(1 - p.tactical / TACTICAL.cooldown));
    tac.className = p.tactical <= 0 ? "ab ready" : "ab cool";
    const ult = $("ab-ult");
    ult.style.setProperty("--p", String(p.ult));
    ult.className = p.ult >= 1 ? "ab ult ready" : "ab ult";
    $("ult-pct").textContent = p.ult >= 1 ? "離脱" : `${Math.floor(p.ult * 100)}%`;
    $("fx-ult").style.opacity = p.leap ? "1" : "0";
    // The same charge on the touch buttons.
    const tTac = $("t-tac");
    tTac.style.setProperty("--p", String(1 - p.tactical / TACTICAL.cooldown));
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
      const sp = view.project({ x: e.pos.x, y: e.pos.y + k.weakY + 0.7, z: e.pos.z }, w, h);
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
      $("downed-bar").style.width = `${(a.rescue / ALLY.reviveTime) * 100}%`;
    } else {
      $("downed-sub").textContent = "自己蘇生中";
      $("downed-bar").style.width = `${(1 - p.downed / PLAYER.downedTime) * 100}%`;
    }
    this.mate(s, view, w, h);
    $("battery").className = p.healing ? "on" : "";
    if (p.healing) {
      $("heal-label").textContent = `${HEALS[p.healing.kind].label}を使用中`;
      $("battery-bar").style.width = `${(1 - p.healing.t / HEALS[p.healing.kind].time) * 100}%`;
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
        if (!cls || e.kind === "titan" || d > 80) continue;
        seen.add(e.id);
        let el = this.awEls.get(e.id);
        if (!el) {
          el = document.createElement("div");
          this.awareLayer.appendChild(el);
          this.awEls.set(e.id, el);
        }
        const top = cls === "reveal" ? ENEMIES[e.kind].weakY : ENEMIES[e.kind].weakY + 1.4;
        const sp = view.project({ x: e.pos.x, y: e.pos.y + top, z: e.pos.z }, w, h);
        let x = sp.x;
        let y = sp.y;
        // Off screen: noticing and searching marks stick to the edge; the rest hide.
        const off = sp.behind || x < 0 || x > w || y < 0 || y > h;
        if (off && cls === "reveal") {
          el.style.display = "none";
          continue;
        }
        if (sp.behind) {
          x = w - x;
          y = h - 60;
        }
        x = Math.max(30, Math.min(w - 30, x));
        y = Math.max(off ? 150 : 40, Math.min(h - 150, y));
        el.className = `aw ${cls}${off ? " edge" : ""}`;
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
   * Extraction points: a line each on the objective card with its condition, and no distance or
   * marker; where they are is on the map (M).
   */
  private exits(s: State) {
    const p = s.player;
    if (s.phase !== "play") {
      $("obj-exits").innerHTML = "";
      return;
    }
    const lines: string[] = [];
    // The phone layout keeps only the nearest exit's line, so the card stays above the vitals.
    const nearest = EXTRACTS.reduce((best, x, i) => (dist2d(p.pos, x) < dist2d(p.pos, EXTRACTS[best]) ? i : best), 0);
    EXTRACTS.forEach((x, i) => {
      const ready = extractReady(s, x);
      const state = x.call
        ? s.shipCall < 0
          ? x.note
          : s.shipCall > 0
            ? `到着まで ${Math.ceil(s.shipCall)} 秒：持ちこたえろ`
            : "着陸：乗り込め"
        : x.needsFlare
          ? p.flares > 0
            ? "発煙筒あり：4 秒で回収"
            : "発煙筒が要る（高い建物の最上階）"
          : x.note;
      const locked = x.needsFlare && !ready;
      // A called ship or a flare in hand is news worth a line even on the phone.
      const live = (x.call && s.shipCall >= 0) || (x.needsFlare && ready);
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
        ? `起こしている ${Math.floor((a.helped / ALLY.helpTime) * 100)}%`
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
      $("mate-tag-sub").textContent = down ? (a.helped > 0 ? `${Math.floor((a.helped / ALLY.helpTime) * 100)}%` : `ダウン ${Math.round(d)}m`) : `${Math.round(d)}m`;
    }
  }

  private prompt(s: State): string {
    const p = s.player;
    if (p.downed > 0 || s.phase !== "play") return "";
    // The use key comes first: picking the teammate up or opening a bin works inside an extraction point too.
    const t = useTarget(s);
    const x = t ? null : extractHere(s);
    if (x) {
      if (x.call && s.shipCall > 0) return `ドロップシップ到着まで ${Math.ceil(s.shipCall)} 秒`;
      if (x.needsFlare && p.flares <= 0) return "発煙筒がない：高い建物の最上階の補給箱にある";
      return `脱出中 ${Math.floor((s.extractTime / x.hold) * 100)}%`;
    }
    // The same choice the use key acts on (sim/world.ts useTarget), so the prompt never promises something else.
    if (!t) {
      // Standing on a valuable that will not go in, and nothing in the bag is worth less.
      const left = s.loot.find((l) => l.kind === "valuable" && l.valuable && l.age >= 0.4 && dist2d(l.pos, p.pos) < PLAYER.pickupRange && Math.abs(l.pos.y - p.pos.y) < 2);
      return left?.valuable ? `バッグがいっぱい：${VALUABLES[left.valuable].label}は入らない` : "";
    }
    if (t.kind === "ally") return s.ally.helped > 0 ? `${ALLY.name}を起こしている…（撃つ・離れると中断）` : `${key("E")}${ALLY.name}を起こす`;
    if (t.kind === "bin") {
      const q = p.search;
      if (q?.bin === t.index) return `補給箱を調べている… ${Math.floor((q.t / searchTime(s.bins[t.index])) * 100)}%（撃つ・離れると中断）`;
      return `${key("E")}補給箱を調べる（音が出る）`;
    }
    if (t.kind === "swap") {
      const v = t.loot.valuable!;
      const out = (makeRoom(p.haul, v) ?? []).map((i) => VALUABLES[p.haul[i]].label);
      return `${key("E")}${VALUABLES[v].label}と入れ替える（${out.join("・")}を捨てる）`;
    }
    if (t.kind === "care") return `${key("E")}補給ポッドを開ける`;
    const wl = t.loot;
    const swap = p.weapons.includes(null) ? "" : `（${WEAPONS[p.weapons[p.slot]!.kind].name} と交換）`;
    return `${key("E")}<span class="r" style="color:${RARITY_CSS[wl.rarity]}">${WEAPONS[wl.weapon!.kind].name}</span> ${RARITY.names[wl.rarity]}を拾う${swap}`;
  }

  results(s: State, settled?: Settlement) {
    const r = rank(s);
    $("rank").textContent = r.rank;
    $("result-title").textContent = s.outcome === "extracted" ? "生還" : "行方不明";
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
      ["レイド時間", clock(s.time - s.landedAt)],
      ["脱出", EXTRACTS.find((x) => x.id === s.extractedAt)?.short ?? "-"],
      [`${ALLY.name}の撃破`, st.allyKills],
      [`${ALLY.name}に救助`, st.allyRescues],
    ]
      .map(([k, v]) => `<span>${k}<b>${v}</b></span>`)
      .join("");
    const lost = s.outcome !== "extracted";
    const haul = (Object.keys(VALUABLES) as (keyof typeof VALUABLES)[]).map((k) => [VALUABLES[k].label, s.player.haul.filter((h) => h === k).length] as const).filter(([, n]) => n > 0);
    $("pois").innerHTML = [
      ...POIS.map((p, i) => `<span>${p.name}<b>${s.cleared[i] ? "制圧" : s.visited[i] ? "立ち寄り" : "-"}</b></span>`),
      ...haul.map(([label, n]) => `<span${lost ? ' class="lost"' : ""}>${label}<b>× ${n}</b></span>`),
      `<span>回収の価値<b>${lost ? `${r.haul}（失った）` : r.haul}</b></span>`,
    ].join("");
    const home = settled?.home ?? [];
    const counted = new Map<string, number>();
    for (const i of home) counted.set(itemName(i), (counted.get(itemName(i)) ?? 0) + 1);
    $("home").innerHTML = settled
      ? `<h3>${lost ? "ポーチに残った物" : "持ち帰った物"}</h3><p>${home.length ? [...counted].map(([n, c]) => `<span>${n}${c > 1 ? ` × ${c}` : ""}</span>`).join("") : "<span>なし</span>"}</p>` +
        (settled.sold.length ? `<p class="sold">倉庫に入りきらない ${settled.sold.length} 点は ${settled.soldFor} クレジットで売った</p>` : "")
      : "";
  }
}
