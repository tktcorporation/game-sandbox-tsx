/*
 * The screens' colours, each named for what it means (docs/ringfall/ui.md). The DOM takes them
 * from the stylesheet's `:root` (`--foe`, and `--foe-rgb` for a see-through one), the canvas maps
 * and the inline icons from here; `npm run lint:ringfall` fails when the two disagree, or when a
 * colour is written anywhere else in the screens' code. The world's own colours are `PAL` in
 * models.ts.
 *
 * A colour is added here, with its meaning, before it is used. A meaning that has a colour takes
 * that colour on every screen: the enemy's ground is `foe` on the maps, the row and the legend.
 */
export const UI = {
  // The page.
  sky: "#7ec8e3",
  sand: "#d9a868",
  white: "#ffffff",
  /** Black, for shadows and dimming only. */
  shade: "#000000",
  /** The plates' navy: every panel and card is this, see-through. */
  ink: "#141a33",
  /** Outlines and discs behind marks on the maps, so they read on any ground. */
  night: "#141828",
  /** The maps' table: the ground a map is drawn on. */
  board: "#1c1f2a",
  /** A screen that covers the game (the world map, the departure). */
  deep: "#0e101c",
  /** The scope's black. */
  scope: "#050608",
  /** Lines and text on the maps: a white that leans blue. */
  paper: "#f4f7ff",
  /** Quiet lines and locks. */
  mist: "#c8cbd6",
  /** What is spent, stopped or absent. */
  slate: "#9aa3b5",
  slateDim: "#5a5f6e",
  /** Place names on the maps and the day's notes: a warm off-white. */
  parch: "#e9dcc2",
  parchDim: "#9c9586",

  // What the player acts on.
  /** The next thing to do: the objective, a confirm, a way off, a weak-point hit. */
  hot: "#ffe23d",
  hotLight: "#ffe27a",
  hotDim: "#c9b25a",
  /** The ring's orange: the title, the fire buttons, flares and fire. */
  ring: "#ff5a2a",
  /** A caution that is not yet a danger: seen, flanked, paused. */
  amber: "#ff9a3c",
  /** Enemy bolts, and nothing else. */
  orb: "#ff3fb0",

  // The sides.
  /** The player's ground, squads and marks. */
  own: "#3f86c8",
  ownBright: "#4f9bff",
  ownLight: "#8cc4f4",
  /** The enemy's ground. */
  foe: "#c8402f",
  /** The enemy moving: squads, contacts, a core under threat. */
  alert: "#ff4a3d",
  /** The enemy in a line of text or an icon. */
  foeBright: "#ff6b5a",
  foeSoft: "#ff8a7a",
  /** A warning in a line of text. */
  peach: "#ffb08f",
  /** Another player's ground and squads. */
  rival: "#3fae6e",
  rivalLight: "#8fd8ac",
  /** The rogues. */
  rogue: "#a47be0",
  /** The titan and its pad: the robots' armour. */
  titan: "#262d52",
  titanLight: "#7f89c4",
  /** The teammate. */
  mate: "#2f7f86",
  mateLight: "#6fd0cf",

  // The player's body.
  /** The player's own peril: low health, downed, where a hit came from. */
  danger: "#ff4458",
  blood: "#c81428",
  hpHeal: "#e0475a",
  /** Health given back: a revive, an issued heal. */
  good: "#7fe08a",

  // Loot.
  r0: "#eeeeee",
  r1: "#45a6ff",
  r2: "#b65cff",
  r3: "#ffc93a",
  /** The pouch: what comes home even from a wipe. */
  pouch: "#e8b07a",

  // The island's day.
  debris: "#e0a33a",
  crews: "#c86f3a",
  /** A route still shut. */
  shut: "#ff8a5c",
} as const;

export type UiColour = keyof typeof UI;

/** A colour of `UI` seen through: `alpha(UI.night, 0.9)`. */
export function alpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Loot's colours by rarity. */
export const RARITY_UI = [UI.r0, UI.r1, UI.r2, UI.r3] as const;
