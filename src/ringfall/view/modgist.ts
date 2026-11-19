/*
 * A mod part's effect as a name and a number, not a sentence (docs/ringfall/ui.md): what it
 * changes, and by how much, read off the part's own value in `MODS` so the two cannot drift. A
 * part that pays for a kind of kill names the kill first. The full sentence (`MODS[k].note`) stays
 * as the hover text.
 */
import { MODS, type ModKind } from "../sim/config";

type Form = "less" | "more" | "times" | "plus" | "none";

const GIST: Record<ModKind, { what: string; form: Form; when?: string }> = {
  leech: { when: "弱点", what: "シールド", form: "plus" },
  hush: { when: "しゃがみ", what: "気づかれる距離", form: "less" },
  grip: { what: "リロード", form: "less" },
  medic: { what: "回復の時間", form: "less" },
  probe: { what: "漁る時間", form: "less" },
  damper: { what: "足音", form: "less" },
  scrambler: { what: "ドローンの検知", form: "less" },
  deflector: { what: "敵弾のそれ", form: "times" },
  medlink: { what: "リオの救助", form: "less" },
  carrier: { what: "リオを起こす", form: "less" },
  piercer: { what: "装甲板", form: "less" },
  jolt: { what: "よろめき", form: "more" },
  lock: { what: "照準の吸い付き", form: "times" },
  stalker: { when: "背後", what: "威力", form: "more" },
  capacitor: { what: "アーク", form: "less" },
  surge: { what: "離脱ジャンプ", form: "more" },
  sponge: { what: "欠片のシールド", form: "times" },
  mender: { what: "自然回復", form: "times" },
  stride: { what: "速さ", form: "more" },
  stock: { what: "反動", form: "less" },
  slipstream: { when: "背後で撃破", what: "速さ", form: "more" },
  recharge: { when: "滑空で撃破", what: "アーク", form: "none" },
  reloader: { when: "背後で撃破", what: "装填", form: "none" },
};

const amount = (v: number, form: Form): string => {
  switch (form) {
    case "less":
      return `−${Math.round((1 - v) * 100)}%`;
    case "more":
      return `+${Math.round((v - 1) * 100)}%`;
    case "times":
      return `×${v}`;
    case "plus":
      return `+${v}`;
    case "none":
      return "";
  }
};

/** The effect of `kind` as HTML: when it applies (if only then), what it changes, and the amount. */
export function modGist(kind: ModKind): string {
  const g = GIST[kind];
  const n = amount(MODS[kind].value, g.form);
  return `<span class="gist">${g.when ? `<em>${g.when}</em>` : ""}${g.what}${n ? `<b>${n}</b>` : ""}</span>`;
}
