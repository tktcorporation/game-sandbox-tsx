/*
 * The factory's expeditions (docs/ringfall/multiplayer.md, 工場の遠征): this island's code, the
 * expeditions out and how they stand, and sending one to another player's island by its code. A
 * section of the factory's panel that draws itself apart from the rest of the hub (`#hub-exped`),
 * so a request's answer redraws it without touching the panel around it or the code being typed.
 * With no server it says so in one line and nothing else changes.
 */
import { flushRecalls, isAi, neighboursFor, readNeighbours, readView, refreshAi, SEND_TIMEOUT_MS, sendExpedition, syncOwn, takeReport, takeSync } from "../island-net";
import { ago, NEIGHBOUR_SLOTS, routeOpen, type Neighbour } from "../meta/neighbours";
import { playerNodes } from "../meta/island";
import { alive, numbered, answerSend, recallAll, sentKey, canSend, dropStale, factoryAhead, factorySquads, homeSquads, refreshOutgoing, sendingEntry, sendKinds, squadsAway, STATE_NAME, type IslandLogEntry, type IslandView } from "../meta/expeditions";
import { parseIslandCode } from "../meta/island-code";
import { errorText } from "../meta/island-errors";
import type { Profile } from "../meta/profile";
import { NODES, nodeIndex, type NodeId } from "../sim/map";
import { checkIcon, clockIcon, coreIcon, crossIcon, flagIcon, lockIcon, robotIcon, SIDE } from "./icons";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const nodeName = (id: string) => NODES[nodeIndex(id)]?.name ?? id;

/** What a neighbour's owner did last, as marks: how long ago, and that raid's cores taken (✓ home, ✗ wiped); nothing before a raid is known. */
export function lastMarks(n: Neighbour, now: number): string {
  if (!n.last) return "";
  const cores = n.last.captured ? `<span class="cores">${coreIcon(SIDE.rival)}+${n.last.captured}</span>` : "";
  return `<span class="last">${clockIcon()}${ago(n.last.at, now)}${cores}${n.last.home ? checkIcon() : crossIcon()}</span>`;
}

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
  /** An island to look up as soon as the panel is connected: one whose attack is being answered (仕返し). */
  private answering: string | null = null;
  /** The islands the server offers as neighbours: a tap looks one up, as typing its code does. */
  private neighbours: Neighbour[] = [];

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
    // A send whose answer never came (a tab closed while it was out) gives its squad back.
    const p0 = refreshAi(this.get());
    const kept = dropStale(p0.expeditions, Date.now());
    if (kept !== p0.expeditions || p0 !== this.get()) this.put({ ...p0, expeditions: kept });
    // The neighbours as last read, and the game's own islands in the slots they leave, before the server answers.
    this.neighbours = neighboursFor(this.get());
    if (this.conn.t !== "ok") this.conn = { t: "wait" };
    this.paint();
    const r = await syncOwn(this.get(), false);
    if (ask !== this.ask) {
      // Closed meanwhile: a first claim's report still clears the nodes taken back it named.
      if (r.ok && r.body.synced.reported?.length) {
        const profile = takeReport(this.get(), r.body);
        if (profile !== this.get()) this.put(profile);
      }
      return;
    }
    if (!r.ok) {
      this.conn = r.error === "no-island-server" || r.error === "no-database" ? { t: "none" } : { t: "error", error: r.error };
      // The game's own islands answer without the server: their recalls go through at once.
      await flushRecalls(this.get, this.put);
      if (this.answering && isAi(this.answering)) {
        this.answering = null;
        void this.look();
      }
      return this.paint();
    }
    this.conn = { t: "ok", code: r.body.code, view: r.body.view };
    if (this.answering) {
      this.answering = null;
      void this.look();
    }
    const { profile, news } = takeSync(this.get(), r.body);
    if (profile !== this.get()) this.put(profile);
    if (news.length) this.news(news);
    this.paint();
    await readNeighbours();
    if (ask === this.ask) {
      this.neighbours = neighboursFor(this.get());
      this.paint();
    }
    await flushRecalls(this.get, this.put);
    await this.refresh(r.body.code, ask);
    if (ask === this.ask) this.paint();
  }

  /** Answers an attack from island `code`: the panel, opened next, looks it up as if its code were typed. */
  revenge(code: string) {
    this.answering = code;
    this.typed = code;
  }

  /** The panel closed: answers to its open still in flight are dropped (a raid may start meanwhile; the next open reads the island again). */
  cancel() {
    this.ask++;
  }

  /** The expeditions out, each as its island shows it now. */
  private async refresh(mine: string, ask: number) {
    const asked = numbered(this.get().expeditions);
    const codes = [...new Set(alive(this.get()).map((e) => e.code))];
    if (!codes.length) return;
    const views: Record<string, IslandView | null> = {};
    for (const c of codes) {
      const v = await readView(c);
      views[c] = v.ok ? v.body : null;
    }
    if (ask !== this.ask) return;
    const p = this.get();
    const expeditions = refreshOutgoing(p.expeditions, mine, views, asked);
    if (expeditions.some((e, i) => e !== p.expeditions[i])) this.put({ ...p, expeditions });
  }

  /** Handles one of the section's buttons (`exp-…`). */
  act(act: string, arg: string) {
    if (this.busy && act !== "exp-node") return;
    if (act === "exp-retry") void this.connect();
    else if (act === "exp-copy") void this.copy();
    else if (act === "exp-look") void this.look();
    else if (act === "exp-island") {
      this.typed = arg;
      void this.look();
    }
    else if (act === "exp-node") {
      this.pick = this.pick === arg ? null : arg;
      this.paint();
    } else if (act === "exp-send") void this.send();
    else if (act === "exp-recall") void this.recall(arg);
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
    const code = parseIslandCode(this.typed);
    // The game's own islands are looked at without the server; any other needs it.
    if (this.conn.t !== "ok" && !(code && isAi(code))) return;
    this.target = null;
    this.pick = null;
    if (!code) {
      this.note = { text: "島の番号は英数字 6 文字", good: false };
      return this.paint();
    }
    if (this.conn.t === "ok" && code === this.conn.code) {
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

  /**
   * Calls the expedition of key `key` (`sentKey()`) home: its squad is back with the factory at once,
   * and the island it was on is told (again at the next sync if it could not be).
   */
  private async recall(key: string) {
    const p = this.get();
    const expeditions = recallAll(p.expeditions, (o) => sentKey(o) === key);
    if (expeditions === p.expeditions) return;
    this.put({ ...p, expeditions });
    this.paint();
    await flushRecalls(this.get, this.put);
    this.paint();
  }

  /** The factory level the server has for this island, as its view last read it; null before it is read. */
  private serverFactory(): number | null {
    return this.conn.t === "ok" && this.conn.view ? this.conn.view.factory : null;
  }

  /**
   * Sends one. The expedition is in the profile at once (`sending`), so its squad is taken while the
   * request is out, a raid started meanwhile included; the answer makes it the server's expedition
   * or takes it out again, and is applied to the profile even when the panel closed meanwhile. The
   * squad is the one the server allows: that of the factory level it has for this island, read anew.
   */
  private async send() {
    const t = this.target;
    const node = this.pick;
    const c = this.conn;
    if (!t || !node || !canSend(this.get())) return;
    if (isAi(t.code)) return this.sendAi(t, node as NodeId);
    if (c.t !== "ok") return;
    const p0 = this.get();
    const pending = sendingEntry(t.code, node as NodeId, sendKinds(this.serverFactory() ?? p0.factory).length, Date.now());
    this.put({ ...p0, expeditions: [...p0.expeditions, pending] });
    this.busy = true;
    this.note = null;
    this.paint();
    let units = 0;
    let r: Awaited<ReturnType<typeof sendExpedition>>;
    // Whatever goes wrong on the way, the send ends: its squad comes back and the panel answers again.
    try {
      const own = await readView(c.code, SEND_TIMEOUT_MS);
      if (own.ok && this.conn.t === "ok" && this.conn.code === c.code) this.conn = { ...this.conn, view: own.body };
      const level = own.ok ? own.body.factory : (c.view?.factory ?? null);
      units = level === null ? 0 : sendKinds(level).length;
      r = level === null ? { ok: false as const, error: own.ok ? ("bad-response" as const) : own.error } : await sendExpedition(t.code, node, units);
    } catch {
      r = { ok: false, error: "network" };
    }
    const p = this.get();
    this.put({ ...p, expeditions: answerSend(p.expeditions, pending, r.ok ? r.body.id : null, units) });
    this.busy = false;
    if (r.ok) {
      this.note = { text: `${nodeName(node)}へ送った`, good: true };
      this.pick = null;
      const again = await readView(t.code);
      if (again.ok && this.target?.code === t.code) this.target = again.body;
    } else this.note = { text: errorText(r.error), good: false };
    this.paint();
  }

  /**
   * Sends one to the game's own island `t`: it takes it at once (island-net.ts answers for it), the
   * squad the camp's factory makes now, with no report to wait for.
   */
  private async sendAi(t: IslandView, node: NodeId) {
    const p0 = this.get();
    const units = sendKinds(p0.factory).length;
    const pending = sendingEntry(t.code, node, units, Date.now());
    this.put({ ...p0, expeditions: [...p0.expeditions, pending] });
    const r = await sendExpedition(t.code, node, units);
    const p = this.get();
    this.put({ ...p, expeditions: answerSend(p.expeditions, pending, r.ok ? r.body.id : null, units) });
    this.note = r.ok ? { text: `${nodeName(node)}へ送った`, good: true } : { text: errorText(r.error), good: false };
    if (r.ok) this.pick = null;
    const again = await readView(t.code);
    if (again.ok && this.target?.code === t.code) this.target = again.body;
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
          .map((e) => `<div class="req exp-out ${e.state}"><span><b class="exp-code">${esc(e.code)}</b>${esc(nodeName(e.node))}</span><b>${STATE_NAME[e.state]}</b><small>${robotIcon(SIDE.own)}${e.units}</small>${e.id > 0 && (e.state === "coming" || e.state === "attacking" || e.state === "waiting" || e.state === "holding") ? `<button type="button" class="exp-recall" data-act="exp-recall" data-arg="${esc(sentKey(e))}">引き上げる</button>` : ""}</div>`)
          .join("")}</div>`
      : "";
    // What sending costs: each expedition out (one being sent too) keeps one squad fewer out on this island.
    const cost = away ? `<div class="exp-cost"><span>${flagIcon()}島の守り<b>${homeSquads(p)}</b></span><span>${flagIcon()}遠征<b>${away}</b></span></div>` : "";
    return `<div class="mod open up-card exp-card">${head}<div class="mod-body">${status}${out}${cost}${c.t === "ok" || this.neighbours.some((n) => n.ai) ? this.sendForm(p) : ""}</div></div>`;
  }

  /** The form that sends one: the other island's code, its nodes that take an expedition, and the button. */
  private sendForm(p: Profile): string {
    const dis = this.busy ? " disabled" : "";
    // The neighbours first: whose island, how much of it its owner holds; a tap opens it below. One
    // whose sea route is shut (the node facing it not held) shows that node, padlocked.
    const mine = new Set<string>(playerNodes(p));
    const near = this.neighbours.length
      ? `<div class="exp-near">${this.neighbours
          .map((n) => {
            const k = n.slot;
            const open = routeOpen(k, (id) => mine.has(id));
            const held = `<span class="exp-held" style="--w:${Math.round((100 * n.held) / Math.max(1, n.total))}%"></span>`;
            const foot = open ? `<small>${coreIcon(SIDE.rival)}${n.held}/${n.total}${lastMarks(n, Date.now())}</small>` : `<small class="shut">${lockIcon()}${esc(nodeName(NEIGHBOUR_SLOTS[k].shore))}</small>`;
            // Without the server only the game's own islands answer.
            const reach = open && (this.conn.t === "ok" || n.ai);
            return `<button type="button" class="${this.target?.code === n.code ? "on" : ""}${open ? "" : " shut"}" data-act="exp-island" data-arg="${esc(n.code)}"${reach ? dis : " disabled"}><b>${esc(n.name)}${n.ai ? `<span class="ai-tag">AI</span>` : ""}</b>${held}${foot}</button>`;
          })
          .join("")}</div>`
      : "";
    const form = near + (this.conn.t !== "ok" ? "" : `<div class="exp-send"><input id="exp-code" type="text" inputmode="text" maxlength="6" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="相手の島の番号" value="${esc(this.typed)}"><button type="button" data-act="exp-look"${dis}>見る</button></div>`);
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
          ? `<button type="button" class="exp-go" data-act="exp-send"${this.pick && !this.busy ? "" : " disabled"}>送る<span class="bots">${sendKinds(this.serverFactory() ?? p.factory)
              .map(() => robotIcon(SIDE.own))
              .join("")}</span></button>` + (factoryAhead(p, this.serverFactory() ?? p.factory) ? `<p class="exp-wait">工場の段は次のレイドの後に島へ届く</p>` : "")
          : `<p class="lock-note">${lockIcon()}部隊が出払っている</p>`
        : "";
      pick = `<div class="exp-target"><small><b>${esc(t.owner)}</b>の島 <b class="exp-code">${esc(t.code)}</b></small>${nodes}${go}</div>`;
    }
    const note = this.note ? `<p class="exp-note${this.note.good ? " good" : ""}">${esc(this.note.text)}</p>` : "";
    return form + pick + note;
  }
}

