/*
 * The factory's expeditions (docs/ringfall/multiplayer.md, 工場の遠征): this island's code, the
 * expeditions out and how they stand, and sending one to another player's island by its code. A
 * section of the factory's panel that draws itself apart from the rest of the hub (`#hub-exped`),
 * so a request's answer redraws it without touching the panel around it or the code being typed.
 * With no server it says so in one line and nothing else changes.
 */
import { readView, sendExpedition, syncOwn, takeSync } from "../island-net";
import { alive, canSend, factorySquads, homeSquads, refreshOutgoing, sendUnits, squadsAway, STATE_NAME, type IslandLogEntry, type IslandView } from "../meta/expeditions";
import { parseIslandCode } from "../meta/island-code";
import { errorText } from "../meta/island-errors";
import type { Profile } from "../meta/profile";
import { NODES, nodeIndex } from "../sim/map";
import { coreIcon, flagIcon, lockIcon, robotIcon, SIDE } from "./icons";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const nodeName = (id: string) => NODES[nodeIndex(id)]?.name ?? id;

/** Where the section stands with the server: asking, no server, a failure, or connected. */
type Conn = { t: "wait" } | { t: "none" } | { t: "error"; error: string } | { t: "ok"; code: string; view: IslandView | null };

export class ExpeditionPanel {
  private conn: Conn = { t: "wait" };
  /** The code typed for another island, as typed. */
  private typed = "";
  /** The island looked up by its code, and the node picked on it. */
  private target: IslandView | null = null;
  private pick: string | null = null;
  /** The last request's outcome, in a line. */
  private note: { text: string; good: boolean } | null = null;
  private busy = false;
  private copied = false;
  /** Bumped by each open, so a late answer to an earlier one is dropped. */
  private ask = 0;

  constructor(
    private get: () => Profile,
    private put: (p: Profile) => void,
    private news: (entries: IslandLogEntry[]) => void,
  ) {
    const hub = document.getElementById("hub")!;
    hub.addEventListener("input", (e) => {
      const el = e.target as HTMLInputElement;
      if (el.id === "exp-code") this.typed = el.value;
    });
    hub.addEventListener("keydown", (e) => {
      if ((e.target as HTMLElement).id === "exp-code" && (e.key === "Enter" || e.code === "NumpadEnter")) {
        e.preventDefault();
        void this.look();
      }
    });
  }

  /** The factory's panel opened: this island read anew, and the expeditions out with it. */
  open() {
    this.note = null;
    this.copied = false;
    void this.connect();
  }

  private async connect() {
    const ask = ++this.ask;
    if (this.conn.t !== "ok") this.conn = { t: "wait" };
    this.paint();
    const r = await syncOwn(this.get(), false);
    if (ask !== this.ask) {
      // Closed meanwhile: a first claim's report still clears the nodes taken back it named.
      if (r.ok && r.body.synced.reported?.length) {
        const { profile } = takeSync(this.get(), { ...r.body, synced: { reported: r.body.synced.reported } });
        if (profile !== this.get()) this.put(profile);
      }
      return;
    }
    if (!r.ok) {
      this.conn = r.error === "no-island-server" || r.error === "no-database" ? { t: "none" } : { t: "error", error: r.error };
      return this.paint();
    }
    this.conn = { t: "ok", code: r.body.code, view: r.body.view };
    const { profile, news } = takeSync(this.get(), r.body);
    if (profile !== this.get()) this.put(profile);
    if (news.length) this.news(news);
    this.paint();
    await this.refresh(r.body.code, ask);
    if (ask === this.ask) this.paint();
  }

  /** The panel closed: answers to its open still in flight are dropped (a raid may start meanwhile; the next open reads the island again). */
  cancel() {
    this.ask++;
  }

  /** The expeditions out, each as its island shows it now. */
  private async refresh(mine: string, ask: number) {
    const codes = [...new Set(alive(this.get()).map((e) => e.code))];
    if (!codes.length) return;
    const views: Record<string, IslandView | null> = {};
    for (const c of codes) {
      const v = await readView(c);
      views[c] = v.ok ? v.body : null;
    }
    if (ask !== this.ask) return;
    const p = this.get();
    const expeditions = refreshOutgoing(p.expeditions, mine, views);
    if (expeditions.some((e, i) => e !== p.expeditions[i])) this.put({ ...p, expeditions });
  }

  /** Handles one of the section's buttons (`exp-…`). */
  act(act: string, arg: string) {
    if (this.busy && act !== "exp-node") return;
    if (act === "exp-retry") void this.connect();
    else if (act === "exp-copy") void this.copy();
    else if (act === "exp-look") void this.look();
    else if (act === "exp-node") {
      this.pick = this.pick === arg ? null : arg;
      this.paint();
    } else if (act === "exp-send") void this.send();
  }

  private async copy() {
    if (this.conn.t !== "ok") return;
    try {
      await navigator.clipboard.writeText(this.conn.code);
      this.copied = true;
    } catch {
      // No clipboard here: the code stays on screen to copy by hand.
      this.copied = false;
    }
    this.paint();
  }

  private async look() {
    if (this.conn.t !== "ok") return;
    const code = parseIslandCode(this.typed);
    this.target = null;
    this.pick = null;
    if (!code) {
      this.note = { text: "島の番号は英数字 6 文字", good: false };
      return this.paint();
    }
    if (code === this.conn.code) {
      this.note = { text: errorText("own-island"), good: false };
      return this.paint();
    }
    this.busy = true;
    this.note = null;
    this.paint();
    const v = await readView(code);
    this.busy = false;
    if (v.ok) this.target = v.body;
    else this.note = { text: errorText(v.error), good: false };
    this.paint();
  }

  private async send() {
    const t = this.target;
    const node = this.pick;
    if (!t || !node || this.conn.t !== "ok" || !canSend(this.get())) return;
    this.busy = true;
    this.paint();
    const r = await sendExpedition(this.get(), t.code, node);
    this.busy = false;
    if (r.ok) {
      const p = this.get();
      this.put({ ...p, expeditions: [...p.expeditions, { code: t.code, node: node as Profile["expeditions"][number]["node"], sentAt: Date.now(), id: r.body.id, units: sendUnits(p), state: "coming" }] });
      this.note = { text: `${nodeName(node)}へ送った`, good: true };
      this.pick = null;
      const again = await readView(t.code);
      if (again.ok && this.target?.code === t.code) this.target = again.body;
    } else this.note = { text: errorText(r.error), good: false };
    this.paint();
  }

  /** Redraws the section where the factory's panel holds it, keeping the code being typed and its focus. */
  private paint() {
    const el = document.getElementById("hub-exped");
    if (!el) return;
    const input = document.getElementById("exp-code") as HTMLInputElement | null;
    const focused = !!input && document.activeElement === input;
    el.innerHTML = this.html();
    if (focused) (document.getElementById("exp-code") as HTMLInputElement | null)?.focus();
  }

  /** The section as HTML. */
  html(): string {
    const p = this.get();
    const away = squadsAway(p);
    const head = `<div class="mod-head"><strong>${flagIcon()}遠征</strong><span></span><b>${flagIcon()}${away} / ${factorySquads(p)}</b></div>`;
    const c = this.conn;
    const status =
      c.t === "wait"
        ? `<p class="exp-wait">…</p>`
        : c.t === "none"
          ? `<p class="lock-note">${lockIcon()}${errorText("no-island-server")}</p>`
          : c.t === "error"
            ? `<p class="lock-note">${lockIcon()}${esc(errorText(c.error))}<button type="button" data-act="exp-retry">もう一度</button></p>`
            : `<div class="exp-own"><small>自分の島</small><b class="exp-code">${esc(c.code)}</b><button type="button" data-act="exp-copy">${this.copied ? "コピーした" : "コピー"}</button>${c.view?.expeditions.length ? `<small class="exp-in">${coreIcon(SIDE.rival)}来ている遠征 <b>${c.view.expeditions.length}</b></small>` : ""}</div>`;
    const out = p.expeditions.length
      ? `<div class="exp-list">${p.expeditions
          .map((e) => `<div class="req exp-out ${e.state}"><span><b class="exp-code">${esc(e.code)}</b>${esc(nodeName(e.node))}</span><b>${STATE_NAME[e.state]}</b><small>${robotIcon(SIDE.own)}${e.units}</small></div>`)
          .join("")}</div>`
      : "";
    // What sending costs: each expedition out keeps one squad fewer out on this island.
    const cost = away ? `<div class="exp-cost"><span>${flagIcon()}島の守り<b>${homeSquads(p)}</b></span><span>${flagIcon()}遠征<b>${away}</b></span></div>` : "";
    return `<div class="mod open up-card exp-card">${head}<div class="mod-body">${status}${out}${cost}${c.t === "ok" ? this.sendForm(p) : ""}</div></div>`;
  }

  /** The form that sends one: the other island's code, its nodes that take an expedition, and the button. */
  private sendForm(p: Profile): string {
    const dis = this.busy ? " disabled" : "";
    const form = `<div class="exp-send"><input id="exp-code" type="text" inputmode="text" maxlength="6" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="相手の島の番号" value="${esc(this.typed)}"><button type="button" data-act="exp-look"${dis}>見る</button></div>`;
    const t = this.target;
    let pick = "";
    if (t) {
      // On another island its owner's nodes are another player's (green) and the rest the enemy's (red).
      const open = t.nodes.filter((n) => n.open && nodeIndex(n.id) >= 0);
      const nodes = open.length
        ? `<div class="exp-nodes">${open.map((n) => `<button type="button" class="${this.pick === n.id ? "on" : ""}" data-act="exp-node" data-arg="${esc(n.id)}">${coreIcon(n.hold === "freed" ? SIDE.rival : SIDE.enemy)}${esc(nodeName(n.id))}</button>`).join("")}</div>`
        : `<p class="lock-note">${lockIcon()}遠征を受ける拠点なし</p>`;
      const room = canSend(p);
      const go = open.length
        ? room
          ? `<button type="button" class="exp-go" data-act="exp-send"${this.pick && !this.busy ? "" : " disabled"}>送る<span class="bots">${Array.from({ length: sendUnits(p) }, () => robotIcon(SIDE.own)).join("")}</span></button>`
          : `<p class="lock-note">${lockIcon()}部隊が出払っている</p>`
        : "";
      pick = `<div class="exp-target"><small><b>${esc(t.owner)}</b>の島 <b class="exp-code">${esc(t.code)}</b></small>${nodes}${go}</div>`;
    }
    const note = this.note ? `<p class="exp-note${this.note.good ? " good" : ""}">${esc(this.note.text)}</p>` : "";
    return form + pick + note;
  }
}

