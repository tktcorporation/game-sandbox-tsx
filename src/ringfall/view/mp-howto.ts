/*
 * First-time multiplayer how-to overlay (TKT-204 案 C): three short cards.
 */
import { markMpHowtoSeen } from "../meta/mp-howto";
import { MP_HOWTO_CARDS, mpHowtoNext, TERM } from "./copy";
import { sfx } from "./sfx";

const $ = (id: string) => document.getElementById(id)!;

/**
 * Shows the three cards once; `done` runs after the last card (出撃などへ戻る).
 * Callers freeze the camp while `#mp-howto` is visible.
 */
export class MpHowto {
  private i = 0;
  private done: (() => void) | null = null;
  open = false;

  constructor() {
    $("mp-howto-next").addEventListener("click", () => this.advance());
    $("mp-howto").addEventListener("keydown", (e) => {
      if (!this.open) return;
      if (e.code === "Enter" || e.code === "Space") {
        e.preventDefault();
        this.advance();
      }
    });
  }

  /** Opens on card 0. No-op if already open. */
  show(done: () => void) {
    if (this.open) return;
    this.open = true;
    this.i = 0;
    this.done = done;
    $("mp-howto").hidden = false;
    this.render();
    ($("mp-howto-next") as HTMLButtonElement).focus();
  }

  private advance() {
    sfx.click();
    if (this.i >= MP_HOWTO_CARDS.length - 1) {
      markMpHowtoSeen();
      this.hide();
      const go = this.done;
      this.done = null;
      go?.();
      return;
    }
    this.i += 1;
    this.render();
  }

  hide() {
    this.open = false;
    $("mp-howto").hidden = true;
  }

  private render() {
    const card = MP_HOWTO_CARDS[this.i]!;
    const n = MP_HOWTO_CARDS.length;
    $("mp-howto-step").textContent = `${this.i + 1} / ${n}`;
    $("mp-howto-title").textContent = card.title;
    $("mp-howto-body").textContent = card.body;
    ($("mp-howto-next") as HTMLButtonElement).textContent = mpHowtoNext(this.i >= n - 1);
    $("mp-howto").setAttribute("aria-label", `${TERM.seaIslands} ${this.i + 1}`);
  }
}
