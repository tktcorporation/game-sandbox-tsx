/*
 * 信号所（Signal Station）パネル: お隣の島リスト、トロフィー、島の知らせ、自島コードの確認。
 *
 * 能動的な遠征送信・出ている遠征一覧は置かない。本パネルはお隣の偵察、トロフィー、島の番号の確認を担う（`#hub-exped`）。
 */
import { aiOvernight, flushRecalls, isAi, neighboursFor, readNeighbours, readView, refreshAi, syncOwn, takeReport, takeSync } from "../island-net";
import { ago, NEIGHBOUR_SLOTS, routeOpen, type Neighbour } from "../meta/neighbours";
import { playerNodes } from "../meta/island";
import { expeditionsOut, numbered, dropStale, recallAll, refreshOutgoing, type IslandLogEntry, type IslandView } from "../meta/expeditions";
import { parseIslandCode } from "../meta/island-code";
import { errorText } from "../meta/island-errors";
import type { Profile } from "../meta/profile";
import { NODES, nodeIndex } from "../sim/map";
import { TERM } from "./copy";
import { checkIcon, clockIcon, coreIcon, crossIcon, flagIcon, lockIcon, SIDE } from "./icons";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const nodeName = (id: string) => NODES[nodeIndex(id)]?.name ?? id;

/** What a neighbour's owner did last, as marks: how long ago, and that raid's cores taken (✓ home, ✗ wiped); nothing before a raid is known. */
export function lastMarks(n: Neighbour, now: number): string {
  if (!n.last) return "";
  const cores = n.last.captured ? `<span class="cores">${coreIcon(SIDE.rival)}+${n.last.captured}</span>` : "";
  return `<span class="last">${clockIcon()}${ago(n.last.at, now)}${cores}${n.last.home ? checkIcon() : crossIcon()}</span>`;
}

/** What changed overnight on one of the game's own islands, as marks: the nodes it took (+) and lost (−), by name; nothing for a player's. */
function overnight(n: Neighbour, day: number): string {
  const c = aiOvernight(n, day);
  if (!c || (!c.took.length && !c.lost.length)) return "";
  return `<small class="overnight">${c.took.map((id) => `<b class="took">+${esc(nodeName(id))}</b>`).join("")}${c.lost.map((id) => `<b class="lost">−${esc(nodeName(id))}</b>`).join("")}</small>`;
}

/** Where the section stands with the server: asking, no server, a failure, or connected. */
type Conn = { t: "wait" } | { t: "none" } | { t: "error"; error: string } | { t: "ok"; code: string; view: IslandView | null };

export class ExpeditionPanel {
  private conn: Conn = { t: "wait" };
  /** The code typed for another island, as typed. */
  private typed = "";
  /** The island looked up by its code (看板; no send under E4). */
  private target: IslandView | null = null;
  /** The last request's outcome, in a line. */
  private note: { text: string; good: boolean } | null = null;
  private busy = false;
  private copied = false;
  /** Bumped by each open, so a late answer to an earlier one is dropped. */
  private ask = 0;
  /** An island to look up as soon as the panel is connected (friends' code fold). */
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

  /** The signal station's expeditions section opened: this island read anew, and the expeditions out with it. */
  open() {
    this.note = null;
    this.copied = false;
    void this.connect();
  }

  private async connect() {
    const ask = ++this.ask;
    // A send whose answer never came (a tab closed while it was out) gives its squad back.
    const p0 = refreshAi(this.get());
    // Codex / PR6: 出ている遠征 UI 削除後もセーブやセッションに残る遠征は引き上げ → flushRecalls が DELETE。
    const retired = recallAll(dropStale(p0.expeditions, Date.now()).filter((e) => e.state !== "sending" && e.id > 0));
    if (retired !== p0.expeditions || p0 !== this.get()) this.put({ ...p0, expeditions: retired });
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

  /** The panel closed: answers to its open still in flight are dropped (a raid may start meanwhile; the next open reads the island again). */
  cancel() {
    this.ask++;
  }

  /** The expeditions out, each as its island shows it now. */
  private async refresh(mine: string, ask: number) {
    const asked = numbered(this.get().expeditions);
    const codes = [...new Set(expeditionsOut(this.get()).map((e) => e.code))];
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
    if (this.busy) return;
    if (act === "exp-retry") void this.connect();
    else if (act === "exp-copy") void this.copy();
    else if (act === "exp-look") void this.look();
    else if (act === "exp-island") {
      this.typed = arg;
      void this.look();
    }   }

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

  /** Redraws the section from the profile as it now stands (the hub took a change in from elsewhere). */
  redraw() {
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
    const c = this.conn;
    // The head: the neighbours, and the factory's squads out on expeditions of all it keeps out.
    // Trophy is the signal station's primary ranking readout (map table removed): large number first.
    const trop = `<div class="exp-trophy"><small>${TERM.trophy}</small><b>${p.trophies ?? 0}</b></div>`;
    // No 「遠征 n/m」 in the head — that looked like an attack entry (CoC: 信号所 is news / お隣 / トロフィー only).
    const head = `${trop}<div class="mod-head"><strong>${flagIcon()}お隣の島</strong></div>`;
    // Without the server only the game's own islands answer; with none of them either, nothing can be sent.
    const browse = c.t === "ok" || this.neighbours.some((n) => n.ai) ? this.neighboursBoard(p) : "";
    // Island codes: folded away from daily entry (お隣 cards are the primary).
    const dis = this.busy ? " disabled" : "";
    const openCodes = this.answering || this.typed ? " open" : "";
    const own =
      c.t === "wait"
        ? `<p class="exp-wait">…</p>`
        : c.t === "none"
          ? `<p class="lock-note">${lockIcon()}${errorText("no-island-server")}</p>`
          : c.t === "error"
            ? `<p class="lock-note">${lockIcon()}${esc(errorText(c.error))}<button type="button" data-act="exp-retry">もう一度</button></p>`
            : `<details class="exp-codes${openCodes}"${openCodes ? " open" : ""}><summary>島の番号</summary>` +
              `<div class="exp-own"><small>自分の島</small><b class="exp-code">${esc(c.code)}</b><button type="button" data-act="exp-copy">${this.copied ? "コピーした" : "コピー"}</button></div>` +
              `<div class="exp-send"><input id="exp-code" type="text" inputmode="text" maxlength="6" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="友達の島の番号" value="${esc(this.typed)}"><button type="button" data-act="exp-look"${dis}>見る</button></div></details>`;
    return `<div class="mod open up-card exp-card">${head}<div class="mod-body">${browse}<div class="exp-foot">${own}</div></div></div>`;
  }

  /** Neighbours as a board, plus a looked-up island's nodes (read-only; no send button). */
  private neighboursBoard(p: Profile): string {
    const dis = this.busy ? " disabled" : "";
    // The neighbours: whose island, how much they hold; a tap opens a read-only look below.
    const mine = new Set<string>(playerNodes(p));
    const near = this.neighbours.length
      ? `<div class="exp-near">${this.neighbours
          .map((n) => {
            const k = n.slot;
            const open = routeOpen(k, (id) => mine.has(id));
            const held = `<span class="exp-held" style="--w:${Math.round((100 * n.held) / Math.max(1, n.total))}%"></span>`;
            const trop = n.trophies != null ? `<small class="exp-n-trop">${TERM.trophy} ${n.trophies.toLocaleString("ja-JP")}</small>` : "";
            const foot = open ? `<small>${coreIcon(SIDE.rival)}${n.held}/${n.total}${lastMarks(n, Date.now())}</small>` : `<small class="shut">${lockIcon()}${esc(nodeName(NEIGHBOUR_SLOTS[k].shore))}</small>`;
            const reach = open && (this.conn.t === "ok" || n.ai);
            // TKT-204 案 G: AI is 「名前 · AI」 same as map / news (span kept for style).
            const who = n.ai ? `${esc(n.name)}<span class="ai-tag">AI</span>` : esc(n.name);
            return `<button type="button" class="${this.target?.code === n.code ? "on" : ""}${open ? "" : " shut"}" data-act="exp-island" data-arg="${esc(n.code)}"${reach ? dis : " disabled"}><b>${who}</b>${trop}${held}${foot}${overnight(n, p.day)}</button>`;
          })
          .join("")}</div>`
      : "";
    const t = this.target;
    let pick = "";
    if (t) {
      const open = t.nodes.filter((n) => n.open && nodeIndex(n.id) >= 0);
      const nodes = open.length
        ? `<div class="exp-nodes">${open.map((n) => `<span class="exp-node">${coreIcon(n.hold === "own" ? SIDE.rival : SIDE.enemy)}${esc(nodeName(n.id))}</span>`).join("")}</div>`
        : `<p class="lock-note">${lockIcon()}公開の拠点なし</p>`;
      pick = `<div class="exp-target"><small><b>${esc(t.owner)}</b>の島 <b class="exp-code">${esc(t.code)}</b></small>${nodes}</div>`;
    }
    const note = this.note ? `<p class="exp-note${this.note.good ? " good" : ""}">${esc(this.note.text)}</p>` : "";
    return near + pick + note;
  }
}

