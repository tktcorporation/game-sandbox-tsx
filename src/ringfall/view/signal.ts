/*
 * 信号所（Signal Station）パネルの上の部分（`#hub-exped`）: トロフィー、別プレイヤーの島の一覧、自分の島の番号。
 * 開くたびに自分の島をサーバーと同期し、届いた知らせを hub へ渡す。
 */
import { islandDay } from "../meta/days";
import { aiOvernight, isAi, neighboursFor, readNeighbours, readView, rememberHoldings, syncOwn, takeReport, takeSync } from "../island-net";
import { ago, type Neighbour } from "../meta/neighbours";
import type { IslandLogEntry, IslandView } from "../meta/island-sync";
import { parseIslandCode } from "../meta/island-code";
import { errorText } from "../meta/island-errors";
import { type Profile } from "../meta/profile";
import { NODES, nodeIndex } from "../sim/map";
import { lostTodayLine, PHRASE, shieldLine, TERM, trophyHead } from "./copy";
import type { SortieTarget } from "../meta/sortie";
import { checkIcon, clockIcon, coreIcon, crossIcon, flagIcon, lockIcon, SIDE } from "./icons";
import { guardOn, OUTER_GUARD, shieldRemainingMs } from "../meta/outer-guard";

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

export class SignalPanel {
  private conn: Conn = { t: "wait" };
  /** The code typed for another island, as typed. */
  private typed = "";
  /** The island looked up by its code. */
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
    /** The holdings the departure's 攻める list offers (`Hub.sortieTargets()`): an island looked at shows its own with a way to attack each. */
    private targets: () => readonly SortieTarget[] = () => [],
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

  /** The signal station opened: this island read anew. */
  open() {
    this.note = null;
    this.copied = false;
    void this.connect();
  }

  private async connect() {
    const ask = ++this.ask;
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
      // The game's own islands answer without the server.
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
  }

  /** The panel closed: answers to its open still in flight are dropped (a raid may start meanwhile; the next open reads the island again). */
  cancel() {
    this.ask++;
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
    }
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
    if (v.ok) {
      this.target = v.body;
      // A real player's island on the list: what it holds now is what may be attacked, before the list's next read.
      if (!isAi(code) && this.neighbours.some((n) => n.code === code)) rememberHoldings(v.body);
    } else this.note = { text: errorText(v.error), good: false };
    this.paint();
  }

  /** Redraws the section from the profile as it now stands (the hub took a change in from elsewhere). */
  redraw() {
    this.paint();
  }

  /** Redraws the section where the signal station's panel holds it, keeping the code being typed and its focus. */
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
    // Trophy is the signal station's primary ranking readout: large number first.
    const tropN = p.trophies ?? 0;
    const trop = `<div class="exp-trophy"><small>${trophyHead(tropN)}</small><b>${tropN}</b></div>`;
    // 作り順③: island shield / loss cap under the trophy (protected state + remaining time).
    const now = Date.now();
    const remain = shieldRemainingMs(p.outerGuard, now);
    const guard = guardOn(p.outerGuard, now);
    const shield =
      remain > 0
        ? `<p class="exp-shield">${esc(shieldLine(remain))}</p>`
        : guard.lost > 0
          ? `<p class="exp-shield">${esc(lostTodayLine(guard.lost, OUTER_GUARD.lossCap))}</p>`
          : "";
    // The panel's side is already titled 別プレイヤー: the card leads with the trophies and the day's guard.
    const head = `${trop}${shield}`;
    // Without the server only the game's own islands answer.
    const browse = c.t === "ok" || this.neighbours.some((n) => n.ai) ? this.neighboursBoard(p) : "";
    // Island codes: folded away from daily entry (the islands' cards are the primary).
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

  /** Neighbours as a board, plus a looked-up island's nodes (read-only). */
  private neighboursBoard(p: Profile): string {
    const dis = this.busy ? " disabled" : "";
    // The other players' islands: whose, how much they hold; a tap opens a read-only look below.
    const near = this.neighbours.length
      ? `<div class="exp-near">${this.neighbours
          .map((n) => {
            const held = `<span class="exp-held" style="--w:${Math.round((100 * n.held) / Math.max(1, n.total))}%"></span>`;
            const trop = n.trophies != null ? `<small class="exp-n-trop">${TERM.trophy} ${n.trophies.toLocaleString("ja-JP")}</small>` : "";
            const foot = `<small>${coreIcon(SIDE.rival)}${n.held}/${n.total}${lastMarks(n, Date.now())}</small>`;
            const reach = this.conn.t === "ok" || n.ai;
            // TKT-204 案 G: AI is 「名前 · AI」 same as map / news (span kept for style).
            const who = n.ai ? `${esc(n.name)}<span class="ai-tag">AI</span>` : esc(n.name);
            return `<button type="button" class="${this.target?.code === n.code ? "on" : ""}" data-act="exp-island" data-arg="${esc(n.code)}"${reach ? dis : " disabled"}><b>${who}</b>${trop}${held}${foot}${overnight(n, islandDay(p))}</button>`;
          })
          .join("")}</div>`
      : "";
    const t = this.target;
    let pick = "";
    if (t) {
      // The island's holdings that may be attacked now: each opens the departure on the core of the player's island that reaches it (as やり返す goes).
      const open = this.targets().filter((x) => x.code === t.code);
      const nodes = open.length
        ? `<div class="exp-nodes">${open.map((x) => `<button type="button" class="exp-node" data-act="revenge" data-arg="${esc(`${x.owner}|${x.id}`)}">${flagIcon(SIDE.rival)}${esc(x.hubName)}<b>${TERM.seeOnMap}</b></button>`).join("")}</div>`
        : `<p class="lock-note">${lockIcon()}${PHRASE.noAttackTarget}</p>`;
      pick = `<div class="exp-target"><small><b>${esc(t.owner)}</b>の島 <b class="exp-code">${esc(t.code)}</b></small>${nodes}</div>`;
    }
    const note = this.note ? `<p class="exp-note${this.note.good ? " good" : ""}">${esc(this.note.text)}</p>` : "";
    return near + pick + note;
  }
}

