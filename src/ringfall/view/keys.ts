/*
 * The keyboard and mouse bindings, and the list of them shown on the title and pause screens.
 * `main.ts` reads its keys from `BIND`, and `KEYS` names every action of `BIND`, so a binding
 * added or moved shows in the list without anyone editing it.
 */

/** Each action's keys as `KeyboardEvent.code`; `Mouse0`/`Mouse2` are mouse buttons, `Wheel` the wheel. */
export const BIND = {
  forward: ["KeyW"],
  left: ["KeyA"],
  back: ["KeyS"],
  right: ["KeyD"],
  fire: ["Mouse0"],
  ads: ["Mouse2"],
  /** Aims on its own key, held or switched (the settings' 覗き方). */
  aim: ["KeyF"],
  jump: ["Space"],
  crouch: ["KeyC", "ControlLeft"],
  reload: ["KeyR"],
  slot1: ["Digit1"],
  slot2: ["Digit2"],
  swap: ["Wheel"],
  tactical: ["KeyQ"],
  ult: ["KeyZ"],
  heal: ["KeyH"],
  use: ["KeyE"],
  bag: ["Tab"],
  map: ["KeyM"],
  mapView: ["KeyN"],
} as const satisfies Record<string, readonly string[]>;
export type Action = keyof typeof BIND;

/** Whether `code` is one of the action's keys. */
export const bound = (a: Action, code: string) => (BIND[a] as readonly string[]).includes(code);

/** One row of the list: its key caps and its name (the HUD's and the touch buttons' word for it). */
interface Row {
  name: string;
  /** Actions whose keys are the caps, in order. */
  of?: Action[];
  /** Caps not bound in `BIND`: the mouse turning the view, Esc releasing the pointer. */
  caps?: string[];
  /** Its caps run together as one (W A S D as `WASD`). */
  joined?: boolean;
  /** Works only in a raid: hidden on the camp's pause screen. */
  raid?: boolean;
}

export const KEYS: Row[] = [
  { name: "移動", of: ["forward", "left", "back", "right"], joined: true },
  { name: "視点", caps: ["マウス"] },
  { name: "撃つ", of: ["fire"], raid: true },
  { name: "覗く", of: ["ads", "aim"], raid: true },
  { name: "ジャンプ", of: ["jump"] },
  { name: "しゃがむ", of: ["crouch"] },
  { name: "リロード", of: ["reload"], raid: true },
  { name: "持ち替え", of: ["slot1", "slot2", "swap"], raid: true },
  { name: "アーク", of: ["tactical"], raid: true },
  { name: "離脱ジャンプ", of: ["ult"], raid: true },
  { name: "回復", of: ["heal"], raid: true },
  { name: "調べる・拾う", of: ["use"] },
  { name: "バッグ", of: ["bag"], raid: true },
  { name: "地図", of: ["map"], raid: true },
  { name: "全体地図", of: ["mapView"], raid: true },
  { name: "一時停止", caps: ["Esc"] },
];

// An action left out of the list is a console error, which the shots gate fails on.
for (const a of Object.keys(BIND) as Action[]) if (!KEYS.some((r) => r.of?.includes(a))) console.error(`keys: ${a} is bound but not listed`);

const CAP: Record<string, string> = { Mouse0: "左クリック", Mouse2: "右クリック", Wheel: "ホイール", Space: "Space", ControlLeft: "Ctrl", Tab: "Tab" };
const capOf = (code: string) => CAP[code] ?? code.replace(/^(Key|Digit)/, "");

/** The list as markup: a grid of key caps and names. */
export function keysHtml(): string {
  return KEYS.map((r) => {
    const caps = r.caps ?? (r.of ?? []).flatMap((a) => BIND[a].map(capOf));
    const kbd = (r.joined ? [caps.join("")] : caps).map((c) => `<kbd>${c}</kbd>`).join("");
    return `<li${r.raid ? ' class="raid"' : ""}><span class="caps">${kbd}</span>${r.name}</li>`;
  }).join("");
}
