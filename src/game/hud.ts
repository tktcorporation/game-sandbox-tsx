import { GUN, PLAYER } from "../sim/config";
import { ROOMS, type State } from "../sim/state";
import { rank, totalTime } from "../sim/step";

/**
 * DOM overlay for everything with type: the remaining-enemy count, ammo, health,
 * banners and the results card. Only what the player needs for the next decision
 * stays on screen during a fight.
 */
export class Hud {
  onRestart = () => {};
  onDash = () => {};
  onStart = (_mode: "2d" | "3d") => {};
  private el = (id: string) => document.getElementById(id)!;
  private bannerTimer = 0;
  private last = { remaining: -1, mag: -1, hp: -1, room: -1 };

  constructor() {
    this.el("restart").addEventListener("click", () => this.onRestart());
    this.el("dash-btn").addEventListener("pointerdown", (e) => {
      e.preventDefault();
      this.onDash();
    });
    this.el("start").addEventListener("click", () => this.onStart("2d"));
    this.el("start3d").addEventListener("click", () => this.onStart("3d"));
  }

  title(show: boolean) {
    this.el("title").hidden = !show;
    this.el("hud").hidden = show;
  }

  touchMode() {
    document.body.classList.add("touch");
  }

  banner(head: string, sub: string, minor = false) {
    const b = this.el("banner");
    b.classList.toggle("minor", minor);
    this.el("banner-head").textContent = head;
    this.el("banner-sub").textContent = sub;
    b.classList.remove("show");
    void b.offsetWidth;
    b.classList.add("show");
    document.body.classList.add("banner-on");
    window.clearTimeout(this.bannerTimer);
    this.bannerTimer = window.setTimeout(() => {
      b.classList.remove("show");
      document.body.classList.remove("banner-on");
    }, 1500);
  }

  hurt(k: number) {
    this.el("vignette").style.opacity = String(k);
  }

  update(s: State, bloom: number) {
    const remaining = s.enemies.length + s.waves.reduce((n, w) => n + w.length, 0);
    if (remaining !== this.last.remaining) {
      const n = this.el("remaining-n");
      n.textContent = String(remaining);
      n.classList.remove("tick");
      void n.offsetWidth;
      n.classList.add("tick");
      this.last.remaining = remaining;
    }
    if (s.room !== this.last.room) {
      this.el("room").textContent = `ROOM ${s.room + 1}/${ROOMS.length}`;
      this.el("hint").textContent = ROOMS[s.room].hint;
      this.last.room = s.room;
    }
    const p = s.player;
    if (p.mag !== this.last.mag) {
      this.el("mag").textContent = p.reload > 0 ? "--" : String(p.mag);
      this.el("mag-bar").style.transform = `scaleX(${p.mag / GUN.mag})`;
      this.last.mag = p.mag;
    }
    this.el("ammo").classList.toggle("reloading", p.reload > 0);
    this.el("ammo").classList.toggle("low", p.mag > 0 && p.mag <= 6 && p.reload <= 0);
    if (p.hp !== this.last.hp) {
      this.el("hp").innerHTML = Array.from({ length: PLAYER.hp }, (_, i) => `<i class="${i < p.hp ? "on" : ""}"></i>`).join("");
      this.last.hp = p.hp;
    }
    this.el("timer").textContent = (s.roomTicks / 60).toFixed(1);
    this.el("par").textContent = `目標 ${ROOMS[s.room].par}`;
    this.el("streak").textContent = s.streak >= 2 && s.streakTimer > 0 ? `${s.streak} STREAK` : "";
    this.el("dash-btn").classList.toggle("cool", p.dashCooldown > 0);
    void bloom;
  }

  results(s: State | null) {
    const r = this.el("results");
    r.hidden = !s;
    if (!s) return;
    const g = rank(s);
    this.el("rank").textContent = g;
    this.el("rank").dataset.rank = g;
    this.el("total").textContent = `${totalTime(s).toFixed(1)} 秒`;
    const acc = s.shots ? Math.round((s.hits / s.shots) * 100) : 0;
    const crit = s.hits ? Math.round((s.crits / s.hits) * 100) : 0;
    this.el("stats").innerHTML = [
      ["被弾", `${s.hitsTaken}`],
      ["命中率", `${acc}%`],
      ["クリティカル", `${crit}%`],
      ["ダウン", `${s.deaths}`],
    ].map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join("");
    this.el("rooms").innerHTML = ROOMS.map((room, i) => {
      const t = s.roomTimes[i] ?? 0;
      return `<div class="${t <= room.par ? "under" : ""}"><span>${i + 1}</span><b>${t.toFixed(1)}</b></div>`;
    }).join("");
  }
}
