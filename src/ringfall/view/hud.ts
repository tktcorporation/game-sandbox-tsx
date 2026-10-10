import { ENEMIES, PLAYER, RARITY, RING, TACTICAL, ULT, WEAPONS } from "../sim/config";
import { magSize } from "../sim/combat";
import { dist2d } from "../sim/geom";
import { POIS } from "../sim/map";
import type { GameEvent, State, Vec3 } from "../sim/state";
import { rank } from "../sim/results";
import { RARITY_CSS } from "./models";
import type { World } from "./world";

/*
 * The DOM layer: everything the player reads. The screen always answers two
 * questions: what to do next (objective card + marker) and how am I doing
 * (shield cells, health, ammo, ability charge).
 */

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

  constructor() {
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
        this.hitT = 0.08;
        $("hitmark").className = e.crit ? "crit" : "";
        // Hits on the same robot in quick succession add up, for at most 1.2 s per number.
        const n = this.nums.find((x) => x.id === e.id && x.age < 0.4 && x.life < 1.2);
        if (n) {
          n.value += e.dmg;
          n.age = 0;
          n.pos = e.pos;
          n.crit = n.crit || e.crit;
        } else {
          const el = document.createElement("div");
          el.className = "dmg";
          this.dmgLayer.appendChild(el);
          this.nums.push({ el, id: e.id, pos: e.pos, value: e.dmg, age: 0, life: 0, crit: e.crit });
        }
        const cur = this.nums.find((x) => x.id === e.id && x.age === 0)!;
        cur.el.textContent = String(Math.round(cur.value));
        cur.el.className = cur.crit ? "dmg crit" : "dmg";
        cur.el.style.color = cur.crit ? "" : e.shield ? RARITY_CSS[e.tier] : "#ffffff";
        break;
      }
      case "kill":
        this.hitT = 0.4;
        $("hitmark").className = "kill";
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
        this.banner(`${POIS[0].name}へ向かえ`, "リングの外にいると削られる");
        break;
      case "poiStart":
        this.banner(POIS[e.poi].boss ? "タイタン出現" : `${POIS[e.poi].name}`, POIS[e.poi].boss ? "足元の衝撃波はジャンプでかわせる" : "ロボット部隊を全滅させろ");
        break;
      case "poiClear":
        if (e.poi + 1 < POIS.length) this.banner(`${POIS[e.poi].name} 制圧`, `次は ${POIS[e.poi + 1].name}。リングが縮み始める`, true);
        break;
      case "extractReady":
        this.banner("タイタン撃破", "ドロップシップに乗れ", true, 3);
        break;
      case "careDrop":
        this.banner("補給ポッド投下", "金色の光の下にレジェンド武器", true);
        break;
      case "down":
        this.banner("ダウン", "3 秒で自己蘇生する");
        break;
      case "wipe":
        this.banner("やり直し", `${POIS[Math.min(s.poi, POIS.length - 1)].name}の入口から。倒した敵はそのまま`);
        break;
      case "bossPhase":
        this.banner("タイタン 怒り状態", "攻撃が速くなる");
        break;
      case "tacticalMiss":
        this.toast("前方に敵がいない", 0);
        break;
      case "ultReady":
        this.toast(isTouch() ? "オーバードライブ 準備完了" : "オーバードライブ 準備完了（Z）", 3);
        break;
    }
  }

  frame(s: State, view: World, dt: number, w: number, h: number) {
    const p = s.player;

    // Objective card.
    const poi = POIS[s.poi];
    const remaining = s.poiActive ? s.enemies.filter((e) => e.poi === s.poi).length + POIS[s.poi].waves.slice(s.wave).reduce((a, wv) => a + wv.length, 0) : 0;
    let text = "";
    if (s.phase === "drop") text = isTouch() ? "降下中：スティックで着地点を選ぶ" : "降下中：WASD で着地点を選ぶ";
    else if (s.phase === "extract") text = "ドロップシップに乗れ";
    else if (s.phase === "done") text = "生還";
    else if (poi && s.poiActive) text = poi.boss ? "タイタンを倒せ" : `${poi.name}のロボットを倒せ`;
    else if (poi) text = `${poi.name}へ向かえ`;
    $("obj-text").textContent = text;
    $("obj-count").textContent = s.poiActive ? `残り ${remaining}` : "";
    const ring = s.ring;
    const outside = dist2d(p.pos, ring) > ring.r && s.phase !== "drop";
    $("obj-ring").textContent = outside ? "リングの外：内側へ戻れ" : ring.shrinking ? `リング縮小中 ${Math.ceil((1 - ring.t) * RING.shrinkTime)} 秒` : "";
    $("fx-ring").style.opacity = outside ? "1" : "0";

    // Objective marker.
    const obj = view.objective(s);
    const marker = $("marker");
    if (obj && s.phase !== "done" && !(s.poiActive && dist2d(p.pos, obj) < 18)) {
      const sp = view.project(obj, w, h);
      let x = sp.x;
      let y = sp.y;
      if (sp.behind) {
        x = w - x;
        y = h - 40;
      }
      x = Math.max(40, Math.min(w - 40, x));
      y = Math.max(90, Math.min(h - 140, y));
      marker.style.display = "flex";
      marker.style.left = `${x}px`;
      marker.style.top = `${y}px`;
      $("marker-dist").textContent = `${Math.round(dist2d(p.pos, obj))}m`;
    } else marker.style.display = "none";

    // Compass: 2 px per degree, centred on the current heading.
    const heading = ((((p.yaw * 180) / Math.PI) % 360) + 360) % 360;
    const half = $("compass").clientWidth / 2;
    $("compass-strip").style.transform = `translateX(${half - (heading + 360) * 2}px)`;
    if (obj) {
      const bearing = (Math.atan2(obj.x - p.pos.x, -(obj.z - p.pos.z)) * 180) / Math.PI;
      let rel = ((bearing - heading + 540) % 360) - 180;
      rel = Math.max(-100, Math.min(100, rel));
      $("compass-obj").style.left = `${half + rel * 2}px`;
    }

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
    $("cells-n").textContent = String(p.batteries);

    // Abilities.
    const tac = $("ab-tac");
    tac.style.setProperty("--p", String(1 - p.tactical / TACTICAL.cooldown));
    tac.className = p.tactical <= 0 ? "ab ready" : "ab cool";
    const ult = $("ab-ult");
    ult.style.setProperty("--p", String(p.ultTime > 0 ? p.ultTime / ULT.duration : p.ult));
    ult.className = p.ult >= 1 ? "ab ult ready" : "ab ult";
    $("ult-pct").textContent = p.ultTime > 0 ? `${Math.ceil(p.ultTime)}s` : `${Math.floor(p.ult * 100)}%`;
    $("fx-ult").style.opacity = p.ultTime > 0 ? "1" : "0";
    // The same charge on the touch buttons.
    const tTac = $("t-tac");
    tTac.style.setProperty("--p", String(1 - p.tactical / TACTICAL.cooldown));
    tTac.classList.toggle("ready", p.tactical <= 0);
    const tUlt = $("t-ult");
    tUlt.style.setProperty("--p", String(p.ultTime > 0 ? p.ultTime / ULT.duration : p.ult));
    tUlt.classList.toggle("ready", p.ult >= 1);
    $("t-ult-pct").textContent = $("ult-pct").textContent;
    $("t-cells").textContent = String(p.batteries);

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
      ammo.textContent = p.ultTime > 0 && i === p.slot ? "∞" : p.reload > 0 && i === p.slot ? "…" : String(mag);
      ammo.style.fontFamily = p.ultTime > 0 && i === p.slot ? "var(--jp)" : "";
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
      sh.style.width = `${(e.shield / Math.max(1, k.shield)) * 100}%`;
      sh.style.background = RARITY_CSS[k.shieldTier];
      (sh.parentElement as HTMLElement).style.display = k.shield > 0 ? "" : "none";
      hp.style.width = `${(Math.max(0, e.hp) / k.hp) * 100}%`;
    }
    // The titan's bar sits at the top of the screen like a boss bar.
    const titan = s.enemies.find((e) => e.kind === "titan" && e.mode !== "spawning");
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

    // Downed / battery progress.
    $("downed").className = p.downed > 0 ? "on" : "";
    $("downed-bar").style.width = `${(1 - p.downed / PLAYER.downedTime) * 100}%`;
    $("battery").className = p.battery > 0 ? "on" : "";
    $("battery-bar").style.width = `${(1 - p.battery / PLAYER.batteryTime) * 100}%`;

    this.bannerT -= dt;
    if (this.bannerT <= 0) $("banner").className = "";
  }

  private prompt(s: State): string {
    const p = s.player;
    if (p.downed > 0 || (s.phase !== "play" && s.phase !== "extract")) return "";
    const r = PLAYER.interactRange;
    const bin = s.bins.find((b) => !b.open && dist2d(b, p.pos) < r && Math.abs(b.y - p.pos.y) < 1.5);
    if (bin) return `${key("E")}補給箱を開ける`;
    if (s.care && s.care.landed && !s.care.open && dist2d(s.care, p.pos) < r + 0.6) return `${key("E")}補給ポッドを開ける`;
    const wl = s.loot
      .filter((l) => l.kind === "weapon" && l.weapon && l.age > 0.4 && dist2d(l.pos, p.pos) < r + 0.3 && Math.abs(l.pos.y - p.pos.y) < 1.5)
      .sort((a, b) => dist2d(a.pos, p.pos) - dist2d(b.pos, p.pos))[0];
    if (wl?.weapon) {
      const swap = p.weapons.includes(null) ? "" : `（${WEAPONS[p.weapons[p.slot]!.kind].name} と交換）`;
      return `${key("E")}<span class="r" style="color:${RARITY_CSS[wl.rarity]}">${WEAPONS[wl.weapon.kind].name}</span> ${RARITY.names[wl.rarity]}を拾う${swap}`;
    }
    return "";
  }

  results(s: State) {
    const r = rank(s);
    $("rank").textContent = r.rank;
    const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
    $("total").textContent = fmt(r.total);
    const st = s.stats;
    const acc = st.shots ? Math.round((st.hits / st.shots) * 100) : 0;
    const crit = st.hits ? Math.round((st.crits / st.hits) * 100) : 0;
    $("stats").innerHTML = [
      ["撃破", st.kills],
      ["与ダメージ", Math.round(st.damage)],
      ["命中率", `${acc}%`],
      ["弱点命中", `${crit}%`],
      ["ダウン", st.downs],
      ["やり直し", st.wipes],
    ]
      .map(([k, v]) => `<span>${k}<b>${v}</b></span>`)
      .join("");
    $("pois").innerHTML = [...POIS.map((p) => p.name), "生還"].map((name, i) => `<span>${name}<b>${fmt(st.poiTimes[i] ?? 0)}</b></span>`).join("");
  }
}
