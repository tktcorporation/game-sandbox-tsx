/*
 * Small inline icons the DOM screens share, so a meaning reads by shape and colour instead of a
 * sentence (docs/ringfall/island-v2.md, 見せ方). Each shape keeps one meaning on every screen and
 * matches the island map's marks: a diamond is a way off, a teal square a depot, a ring a way in,
 * blue is the player's side and red the enemy's. Drawn as SVG so they need no font; `currentColor`
 * takes the text's colour unless a colour is given.
 */

import { UI, alpha } from "./palette";

const svg = (body: string, cls: string, size = 14) => `<svg class="ico ${cls}" viewBox="0 0 16 16" width="${size}" height="${size}" aria-hidden="true">${body}</svg>`;

/** The player's side and the enemy's, as on the map. */
export const SIDE = { own: UI.own, enemy: UI.foe, rival: UI.rival } as const;

/** A clock: a time left (the battle's end, a craft on its way, a wait). */
export const clockIcon = (c = "currentColor") => svg(`<circle cx="8" cy="8" r="6.2" fill="none" stroke="${c}" stroke-width="1.8"/><path d="M8 4.2 V8 L10.6 9.6" stroke="${c}" stroke-width="1.8" fill="none" stroke-linecap="round"/>`, "clock");

/** A way off, the map's yellow diamond. */
export const exitIcon = (c: string = UI.hot) => svg(`<path d="M8 1.5 L14.5 8 L8 14.5 L1.5 8 Z" fill="${c}" stroke="${alpha(UI.night, 0.85)}" stroke-width="1.2"/>`, "exit");

/** A flare: a lit stick. Hollow and grey when the player has none. */
export const flareIcon = (lit: boolean) =>
  svg(
    lit
      ? `<rect x="6.5" y="7" width="3" height="8" rx="1" fill="${UI.ring}"/><path d="M8 1 C10.5 3.5 10.5 6 8 7 C5.5 6 5.5 3.5 8 1 Z" fill="${UI.hotLight}"/>`
      : `<rect x="6.5" y="7" width="3" height="8" rx="1" fill="none" stroke="${UI.slate}" stroke-width="1.2"/><path d="M8 1 C10.5 3.5 10.5 6 8 7 C5.5 6 5.5 3.5 8 1 Z" fill="none" stroke="${UI.slate}" stroke-width="1.2"/>`,
    "flare",
  );

/** The craft a call brings (the dropship, the boat): an arrow coming down. */
export const callIcon = (c = "currentColor") => svg(`<path d="M8 1.5 V11 M4 7.5 L8 11.5 L12 7.5" stroke="${c}" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M2.5 14.5 H13.5" stroke="${c}" stroke-width="2" stroke-linecap="round"/>`, "call");

/** A robot squad coming down: three red pips under a chevron. */
export const reinforceIcon = (c: string = UI.foeBright) => svg(`<path d="M3 2 L8 6 L13 2" stroke="${c}" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="4" cy="11.5" r="2" fill="${c}"/><circle cx="8" cy="11.5" r="2" fill="${c}"/><circle cx="12" cy="11.5" r="2" fill="${c}"/>`, "reinforce");

/** A node's core in the colour of who holds it; `lock` adds a padlock (the enemy's, not on the front). */
export const coreIcon = (c: string, lock = false) =>
  svg(
    `<path d="M8 1.5 L14 4 V8.5 C14 11.8 11.3 14 8 15 C4.7 14 2 11.8 2 8.5 V4 Z" fill="${c}" stroke="${alpha(UI.night, 0.85)}" stroke-width="1.1"/>` +
      (lock ? `<rect x="5.3" y="7.4" width="5.4" height="4.4" rx="0.8" fill="${UI.board}"/><path d="M6.3 7.4 V6 a1.7 1.7 0 0 1 3.4 0 V7.4" stroke="${UI.board}" stroke-width="1.3" fill="none"/>` : `<circle cx="8" cy="8.3" r="2.2" fill="${UI.paper}"/>`),
    "core",
  );

/** A padlock, for something shut. */
export const lockIcon = (c = "currentColor") => svg(`<rect x="3.5" y="7" width="9" height="7.5" rx="1.2" fill="${c}"/><path d="M5.3 7 V5 a2.7 2.7 0 0 1 5.4 0 V7" stroke="${c}" stroke-width="1.8" fill="none"/>`, "lock");

/** A pushpin, for a starter weapon: it stays pinned in the stash, never lost and never sold. */
export const pinIcon = (c = "currentColor") => svg(`<path d="M5 1.5 H11 L10 6 L12.5 9 H3.5 L6 6 Z" fill="${c}"/><path d="M8 9 V15" stroke="${c}" stroke-width="1.8" stroke-linecap="round"/>`, "pin");


/** A bag: the slots the player carries. */
export const bagIcon = (c = "currentColor") => svg(`<path d="M3 6 H13 L12 15 H4 Z" fill="${c}"/><path d="M5.5 6 V4.5 a2.5 2.5 0 0 1 5 0 V6" stroke="${c}" stroke-width="1.6" fill="none"/>`, "bag");

/** A tick: done. */
export const checkIcon = (c = "currentColor") => svg(`<path d="M2.5 8.5 L6.5 12.5 L13.5 3.5" stroke="${c}" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`, "check");

/** A cross: refused, lost or not allowed. */
export const crossIcon = (c = "currentColor") => svg(`<path d="M3.5 3.5 L12.5 12.5 M12.5 3.5 L3.5 12.5" stroke="${c}" stroke-width="2.4" stroke-linecap="round"/>`, "cross");

/** A crosshair: fighting. */
export const fightIcon = (c = "currentColor") => svg(`<circle cx="8" cy="8" r="5" fill="none" stroke="${c}" stroke-width="1.8"/><path d="M8 1 V4.5 M8 11.5 V15 M1 8 H4.5 M11.5 8 H15" stroke="${c}" stroke-width="1.8" stroke-linecap="round"/>`, "fight");

/** A cross of first aid: picking someone up. */
export const reviveIcon = (c: string = UI.good) => svg(`<path d="M6 2 H10 V6 H14 V10 H10 V14 H6 V10 H2 V6 H6 Z" fill="${c}"/>`, "revive");

/** An eye, open or struck through: whether the robots see the player. */
export const eyeIcon = (c = "currentColor", shut = false) =>
  svg(`<path d="M1 8 C3.5 3.5 12.5 3.5 15 8 C12.5 12.5 3.5 12.5 1 8 Z" fill="none" stroke="${c}" stroke-width="1.6"/><circle cx="8" cy="8" r="2.4" fill="${c}"/>` + (shut ? `<path d="M2.5 14 L13.5 2" stroke="${c}" stroke-width="1.8" stroke-linecap="round"/>` : ""), "eye");

/** A depot, the map's teal square. */
export const depotIcon = (c: string = UI.mateLight) => svg(`<rect x="3" y="3" width="10" height="10" fill="${c}" stroke="${alpha(UI.night, 0.85)}" stroke-width="1.2"/>`, "depot");

/** A way in, the map's ring; dashed for one not yet known. */
export const entryIcon = (known = true, c: string = UI.parch) => svg(`<circle cx="8" cy="8" r="5" fill="none" stroke="${c}" stroke-width="2"${known ? "" : ` stroke-dasharray="2.2 2.2" opacity="0.6"`}/>`, "entry");

/** An arrow up: the next level, something that can be built or raised. */
export const upIcon = (c = "currentColor") => svg(`<path d="M8 2 L14 9 H10 V14 H6 V9 H2 Z" fill="${c}"/>`, "up");

/** A robot of the player's side or the enemy's: a head and shoulders. */
export const robotIcon = (c: string) => svg(`<rect x="4.5" y="1.5" width="7" height="5.5" rx="1" fill="${c}"/><path d="M2 15 V10.5 C2 9 3 8 4.5 8 H11.5 C13 8 14 9 14 10.5 V15 Z" fill="${c}"/>`, "robot");

/** A turret. */
export const turretIcon = (c = "currentColor") => svg(`<rect x="3" y="10" width="10" height="5" fill="${c}"/><rect x="5" y="6" width="6" height="4.5" rx="1" fill="${c}"/><path d="M10 7.5 H15" stroke="${c}" stroke-width="2"/>`, "turret");

/** A heal by what it restores: a shield cell (blue) or health (green). */
export const healIcon = (shield: boolean) => (shield ? svg(`<path d="M8 1.5 L14 4 V8.5 C14 11.8 11.3 14 8 15 C4.7 14 2 11.8 2 8.5 V4 Z" fill="${UI.r1}"/>`, "heal") : reviveIcon(UI.good));

/** A loudspeaker: the action makes noise the robots hear. */
export const noiseIcon = (c = "currentColor") => svg(`<path d="M2 6 H5 L9 2.5 V13.5 L5 10 H2 Z" fill="${c}"/><path d="M11 5.5 C12.3 6.8 12.3 9.2 11 10.5 M12.8 3.8 C15 6 15 10 12.8 12.2" stroke="${c}" stroke-width="1.4" fill="none" stroke-linecap="round"/>`, "noise");

/** The pouch's own colour: what sits in it comes home even from a wipe. Used for its slots on every screen. */
export const POUCH = UI.pouch;

/** The pouch: a small stitched bag in the pouch's colour. */
export const pouchIcon = (c = POUCH) =>
  svg(`<path d="M3 5.5 H13 V12 C13 13.4 12 14.5 10.5 14.5 H5.5 C4 14.5 3 13.4 3 12 Z" fill="${c}"/><path d="M3 5.5 L5 2 H11 L13 5.5" fill="${c}" stroke="${alpha(UI.night, 0.85)}" stroke-width="1"/><path d="M4.8 7.5 V12.2 M11.2 7.5 V12.2" stroke="${alpha(UI.night, 0.7)}" stroke-width="1" stroke-dasharray="1.4 1.2"/>`, "pouch");

/** A mod part, the floor's purple hexagon plate. */
export const modIcon = (c: string = UI.r2) => svg(`<path d="M8 1.5 L13.6 4.75 V11.25 L8 14.5 L2.4 11.25 V4.75 Z" fill="${c}" stroke="${alpha(UI.night, 0.85)}" stroke-width="1.1"/><path d="M8 5 L10.6 6.5 V9.5 L8 11 L5.4 9.5 V6.5 Z" fill="${alpha(UI.white, 0.35)}"/>`, "mod");

/**
 * A supply bin, as the world draws one (a teal crate, its concrete lid raised), holding `inside`
 * (icons' markup) in its mouth: what its search can turn up.
 */
export const binPicture = (inside: string, cls = "") =>
  `<span class="bin-pic ${cls}"><span class="bin-in">${inside}</span><svg class="bin-box" viewBox="0 0 40 22" aria-hidden="true"><path d="M2 3 L38 3 L36 0.5 L4 0.5 Z" fill="${UI.parch}"/><rect x="3" y="4" width="34" height="16" rx="1" fill="${UI.mate}"/><rect x="3" y="16.5" width="34" height="3.5" fill="${UI.parch}"/><path d="M3 4.6 H37" stroke="${UI.white}" stroke-width="1"/></svg></span>`;

/** A gun, side on, in its rarity's colour. */
export const gunIcon = (c = "currentColor") => svg(`<path d="M0.5 5 H12 V4 H15.5 V6.6 H12 V8 H9.6 L9 11.8 H6.8 L7.2 8 H5.2 L4 13.5 H1.2 L2.4 8 H0.5 Z" fill="${c}"/>`, "gun");

/** Body armour, in its level's colour. */
export const armorIcon = (c = "currentColor") => svg(`<path d="M5 1.5 L8 3 L11 1.5 L14 4 L12.5 6.5 V14.5 H3.5 V6.5 L2 4 Z" fill="${c}"/><path d="M8 3 V14.5" stroke="${alpha(UI.night, 0.6)}" stroke-width="1"/>`, "armor");

/** Where the raid starts: a pin in the player's colour, set on the chosen way in or depot. */
export const startIcon = (c: string = SIDE.own) =>
  svg(`<path d="M8 15 C4.5 10.6 2.8 8 2.8 5.9 a5.2 5.2 0 0 1 10.4 0 C13.2 8 11.5 10.6 8 15 Z" fill="${c}" stroke="${UI.paper}" stroke-width="1.3"/><circle cx="8" cy="5.9" r="2" fill="${UI.paper}"/>`, "start");

/** A zipline: a cable sloping between two masts, a pulley on it, in the player's blue. */
export const zipIcon = (c: string = SIDE.own) =>
  svg(`<path d="M2 2 V15 M14 5 V15" stroke="${c}" stroke-width="1.8" stroke-linecap="round"/><path d="M2 3 L14 6" stroke="${c}" stroke-width="1.4"/><circle cx="8" cy="4.6" r="1.7" fill="${c}"/><path d="M8 6.3 V10" stroke="${c}" stroke-width="1.4" stroke-linecap="round"/>`, "zip");

/** The hideout: a small house with a pitched roof. Beside a module's name, a valuable that module's levels still take. */
export const hideoutIcon = (c = "currentColor") =>
  svg(`<path d="M1.5 8 L8 2 L14.5 8" stroke="${c}" stroke-width="1.8" fill="none" stroke-linejoin="round" stroke-linecap="round"/><path d="M3.5 7.5 V14.5 H12.5 V7.5" fill="${c}"/><rect x="6.6" y="10" width="2.8" height="4.5" fill="${alpha(UI.night, 0.85)}"/>`, "hideout");

/** The camp's factory: a sawtooth roof in the player's blue. Beside a level, a valuable that level still takes. */
export const factoryIcon = (c: string = SIDE.own) =>
  svg(`<path d="M1.5 15 V7 L5.5 4 V7 L9.5 4 V7 L13.5 4 V15 Z" fill="${c}"/><rect x="11" y="1.5" width="2" height="4" fill="${c}"/><rect x="4" y="10" width="2.2" height="2.2" fill="${alpha(UI.night, 0.8)}"/><rect x="8.5" y="10" width="2.2" height="2.2" fill="${alpha(UI.night, 0.8)}"/>`, "factory");

/** A paper from the quest board: a quest or the contract taken that asks for the thing beside it. */
export const paperIcon = (c: string = UI.parch) =>
  svg(`<path d="M3 1.5 H10.5 L13 4 V14.5 H3 Z" fill="${c}"/><path d="M10.5 1.5 V4 H13" fill="${alpha(UI.night, 0.35)}"/><path d="M5 7 H11 M5 9.5 H11 M5 12 H9" stroke="${alpha(UI.night, 0.7)}" stroke-width="1.1"/>`, "paper");

/*
 * The hideout's modules each have one mark, drawn both on the module's card in the workshop and
 * wherever its effect shows elsewhere, so the card's mark tells where an upgrade grows: the
 * infirmary's case beside the shelves' issued heals, the storage's crate at the stash's count. The
 * pouch keeps `pouchIcon()` and the factory `factoryIcon()`.
 */

/** The infirmary: a white case with a green cross. Beside a heal count, the heals it issues to every raid. */
export const issueIcon = (c: string = UI.good) =>
  svg(`<rect x="1.5" y="4.5" width="13" height="10" rx="1.4" fill="${UI.paper}"/><path d="M5.5 4.5 V2.5 H10.5 V4.5" stroke="${UI.paper}" stroke-width="1.6" fill="none"/><path d="M6.8 6.5 H9.2 V8.6 H11.3 V11 H9.2 V13.1 H6.8 V11 H4.7 V8.6 H6.8 Z" fill="${c}"/>`, "issue");

/** The storage: a crate on a shelf. Beside the stash's count, the room it gives. */
export const stashIcon = (c: string = UI.sand) =>
  svg(`<rect x="2" y="3" width="12" height="9.5" fill="${c}"/><path d="M2 6.2 H14 M2 9.4 H14" stroke="${alpha(UI.night, 0.55)}" stroke-width="1"/><rect x="6.4" y="4.2" width="3.2" height="1.6" fill="${alpha(UI.night, 0.6)}"/><path d="M1 14.5 H15" stroke="${c}" stroke-width="1.8" stroke-linecap="round"/>`, "stash");

/** A squad of the factory's out at once: the map's blue flag on a white pole (a node that adds one carries the same flag). */
export const flagIcon = (c: string = SIDE.own) =>
  svg(`<path d="M3.5 15 V1.5" stroke="${UI.paper}" stroke-width="1.6" stroke-linecap="round"/><path d="M3.5 1.8 L14 5.4 L3.5 9 Z" fill="${c}"/>`, "flag");

/** A weapon's three numbers, each with its mark: the damage of a shot (a burst), shots a minute (three rounds flying), the magazine. */
export const dmgIcon = (c = "currentColor") => svg(`<path d="M8 1 L9.8 5.6 L14.6 4 L11.6 8 L14.6 12 L9.8 10.4 L8 15 L6.2 10.4 L1.4 12 L4.4 8 L1.4 4 L6.2 5.6 Z" fill="${c}"/>`, "i-dmg", 12);
export const rateIcon = (c = "currentColor") => svg(`<path d="M1 4 H6 L8 5.5 L6 7 H1 Z M5 9 H10 L12 10.5 L10 12 H5 Z M9 4 H13 L15 5.5 L13 7 H9 Z" fill="${c}"/>`, "i-rate", 12);
export const magIcon = (c = "currentColor") => svg(`<path d="M5 1.5 H11 V11 L9.5 14.5 H4.5 L5 11 Z" fill="${c}"/><path d="M5.6 4 H10.4 M5.6 6.5 H10.4 M5.6 9 H10.4" stroke="${alpha(UI.night, 0.7)}" stroke-width="1"/>`, "i-mag", 12);

/** Credits: a coin in the confirm's yellow, before a price or a pay. */
export const coinIcon = (c: string = UI.hot) => svg(`<circle cx="8" cy="8" r="6.2" fill="${c}"/><circle cx="8" cy="8" r="3.4" fill="none" stroke="${alpha(UI.night, 0.55)}" stroke-width="1.4"/>`, "coin", 12);
