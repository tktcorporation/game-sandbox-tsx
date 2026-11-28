/*
 * The core's sortie (sim/jump.ts): at a core of the player's that other players hold too, the use
 * key opens this sheet over the raid, which waits. It lists a few of those players (within the
 * trophy band, nearest first), each with their defence and what the trophies stand to move;
 * choosing one sets out, 戻る goes back to the raid.
 */
import type { SortieTarget } from "../meta/sortie";
import { PHRASE, attackScoutDef, attackScoutTrop, jumpTitle, winBonusMark } from "./copy";
import { flagIcon, SIDE } from "./icons";

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export class JumpSheet {
  open = false;
  private targets: SortieTarget[] = [];
  /** When the sheet opened: the tap that opened it must not also choose the card that came up under the finger. */
  private since = 0;

  /** `go` is called with the player chosen, or null when the sheet is turned back from. */
  constructor(private go: (t: SortieTarget | null) => void) {
    $("jump-back").innerHTML = `${PHRASE.jumpBack}<kbd>Esc</kbd>`;
    $("jump-back").addEventListener("click", () => performance.now() - this.since > 350 && this.answer(-1));
    $("jump-list").addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>("button[data-i]");
      if (el && performance.now() - this.since > 350) this.answer(Number(el.dataset.i));
    });
  }

  show(hubName: string, targets: SortieTarget[]) {
    this.targets = targets;
    this.open = true;
    this.since = performance.now();
    $("jump-title").textContent = jumpTitle(hubName);
    $("jump-list").innerHTML = targets
      .map((t, i) => {
        const bonus = t.winBonus > 0 ? `<small class="scout-bonus">${esc(winBonusMark(t.winBonus))}</small>` : "";
        return `<button type="button" class="attack-row" data-i="${i}" aria-label="${esc(t.title)}">${flagIcon(SIDE.rival)}<span class="attack-body"><span class="attack-title"><b>${esc(t.ownerName)}</b></span><small class="scout-def">${esc(attackScoutDef(t.factory, t.guard))}</small><small class="scout-trop">${esc(attackScoutTrop(t.win, t.lose))}</small>${bonus}</span><kbd>${i + 1}</kbd></button>`;
      })
      .join("");
    $("jump").hidden = false;
    document.body.classList.add("jumping");
  }

  /** A key while the sheet is open: 1 to 3 choose, Esc turns back. True when the key was the sheet's. */
  key(code: string): boolean {
    if (!this.open) return false;
    if (code === "Escape" || code === "Backspace") this.answer(-1);
    else {
      const n = /^(?:Digit|Numpad)([1-9])$/.exec(code);
      if (n && Number(n[1]) <= this.targets.length) this.answer(Number(n[1]) - 1);
    }
    return true;
  }

  private answer(i: number) {
    if (!this.open) return;
    this.open = false;
    $("jump").hidden = true;
    document.body.classList.remove("jumping");
    this.go(this.targets[i] ?? null);
  }
}
