/*
 * Small inline icons the DOM screens share, so a meaning reads by shape and colour instead of a
 * sentence (docs/ringfall/island-v2.md, 見せ方). Each shape keeps one meaning on every screen and
 * matches the island map's marks: a diamond is a way off, a teal square a depot, a ring a way in,
 * blue is the player's side and red the enemy's. Drawn as SVG so they need no font; `currentColor`
 * takes the text's colour unless a colour is given.
 */

const svg = (body: string, cls: string, size = 14) => `<svg class="ico ${cls}" viewBox="0 0 16 16" width="${size}" height="${size}" aria-hidden="true">${body}</svg>`;

/** The player's side and the enemy's, as on the map. */
export const SIDE = { own: "#3f86c8", enemy: "#c8402f" } as const;

/** A clock: a time left (the battle's end, a craft on its way, a wait). */
export const clockIcon = (c = "currentColor") => svg(`<circle cx="8" cy="8" r="6.2" fill="none" stroke="${c}" stroke-width="1.8"/><path d="M8 4.2 V8 L10.6 9.6" stroke="${c}" stroke-width="1.8" fill="none" stroke-linecap="round"/>`, "clock");

/** A way off, the map's yellow diamond. */
export const exitIcon = (c = "#ffe23d") => svg(`<path d="M8 1.5 L14.5 8 L8 14.5 L1.5 8 Z" fill="${c}" stroke="rgba(20,24,40,0.85)" stroke-width="1.2"/>`, "exit");

/** A flare: a lit stick. Hollow and grey when the player has none. */
export const flareIcon = (lit: boolean) =>
  svg(
    lit
      ? `<rect x="6.5" y="7" width="3" height="8" rx="1" fill="#e2563a"/><path d="M8 1 C10.5 3.5 10.5 6 8 7 C5.5 6 5.5 3.5 8 1 Z" fill="#ffd36a"/>`
      : `<rect x="6.5" y="7" width="3" height="8" rx="1" fill="none" stroke="#8a8f9c" stroke-width="1.2"/><path d="M8 1 C10.5 3.5 10.5 6 8 7 C5.5 6 5.5 3.5 8 1 Z" fill="none" stroke="#8a8f9c" stroke-width="1.2"/>`,
    "flare",
  );

/** The craft a call brings (the dropship, the boat): an arrow coming down. */
export const callIcon = (c = "currentColor") => svg(`<path d="M8 1.5 V11 M4 7.5 L8 11.5 L12 7.5" stroke="${c}" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M2.5 14.5 H13.5" stroke="${c}" stroke-width="2" stroke-linecap="round"/>`, "call");

/** A robot squad coming down: three red pips under a chevron. */
export const reinforceIcon = (c = "#ff6b5a") => svg(`<path d="M3 2 L8 6 L13 2" stroke="${c}" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="4" cy="11.5" r="2" fill="${c}"/><circle cx="8" cy="11.5" r="2" fill="${c}"/><circle cx="12" cy="11.5" r="2" fill="${c}"/>`, "reinforce");

/** A node's core in the colour of who holds it; `lock` adds a padlock (the enemy's, not on the front). */
export const coreIcon = (c: string, lock = false) =>
  svg(
    `<path d="M8 1.5 L14 4 V8.5 C14 11.8 11.3 14 8 15 C4.7 14 2 11.8 2 8.5 V4 Z" fill="${c}" stroke="rgba(20,24,40,0.85)" stroke-width="1.1"/>` +
      (lock ? `<rect x="5.3" y="7.4" width="5.4" height="4.4" rx="0.8" fill="#1b1f2a"/><path d="M6.3 7.4 V6 a1.7 1.7 0 0 1 3.4 0 V7.4" stroke="#1b1f2a" stroke-width="1.3" fill="none"/>` : `<circle cx="8" cy="8.3" r="2.2" fill="#f4f7ff"/>`),
    "core",
  );

/** A padlock, for something shut. */
export const lockIcon = (c = "currentColor") => svg(`<rect x="3.5" y="7" width="9" height="7.5" rx="1.2" fill="${c}"/><path d="M5.3 7 V5 a2.7 2.7 0 0 1 5.4 0 V7" stroke="${c}" stroke-width="1.8" fill="none"/>`, "lock");

/** A key. */
export const keyIcon = (c = "currentColor") => svg(`<circle cx="5" cy="8" r="3.3" fill="none" stroke="${c}" stroke-width="2"/><path d="M8.2 8 H14.5 M12.2 8 V11 M14.2 8 V10.4" stroke="${c}" stroke-width="2" stroke-linecap="round"/>`, "key");

/** A bag: the slots the player carries. */
export const bagIcon = (c = "currentColor") => svg(`<path d="M3 6 H13 L12 15 H4 Z" fill="${c}"/><path d="M5.5 6 V4.5 a2.5 2.5 0 0 1 5 0 V6" stroke="${c}" stroke-width="1.6" fill="none"/>`, "bag");

/** A tick: done. */
export const checkIcon = (c = "currentColor") => svg(`<path d="M2.5 8.5 L6.5 12.5 L13.5 3.5" stroke="${c}" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`, "check");

/** A cross: refused, lost or not allowed. */
export const crossIcon = (c = "currentColor") => svg(`<path d="M3.5 3.5 L12.5 12.5 M12.5 3.5 L3.5 12.5" stroke="${c}" stroke-width="2.4" stroke-linecap="round"/>`, "cross");

/** A crosshair: fighting. */
export const fightIcon = (c = "currentColor") => svg(`<circle cx="8" cy="8" r="5" fill="none" stroke="${c}" stroke-width="1.8"/><path d="M8 1 V4.5 M8 11.5 V15 M1 8 H4.5 M11.5 8 H15" stroke="${c}" stroke-width="1.8" stroke-linecap="round"/>`, "fight");

/** A cross of first aid: picking someone up. */
export const reviveIcon = (c = "#7fe08a") => svg(`<path d="M6 2 H10 V6 H14 V10 H10 V14 H6 V10 H2 V6 H6 Z" fill="${c}"/>`, "revive");

/** An eye, open or struck through: whether the robots see the player. */
export const eyeIcon = (c = "currentColor", shut = false) =>
  svg(`<path d="M1 8 C3.5 3.5 12.5 3.5 15 8 C12.5 12.5 3.5 12.5 1 8 Z" fill="none" stroke="${c}" stroke-width="1.6"/><circle cx="8" cy="8" r="2.4" fill="${c}"/>` + (shut ? `<path d="M2.5 14 L13.5 2" stroke="${c}" stroke-width="1.8" stroke-linecap="round"/>` : ""), "eye");

/** A depot, the map's teal square. */
export const depotIcon = (c = "#6fd0cf") => svg(`<rect x="3" y="3" width="10" height="10" fill="${c}" stroke="rgba(20,24,40,0.85)" stroke-width="1.2"/>`, "depot");

/** A way in, the map's ring; dashed for one not yet known. */
export const entryIcon = (known = true, c = "#e9dcc2") => svg(`<circle cx="8" cy="8" r="5" fill="none" stroke="${c}" stroke-width="2"${known ? "" : ` stroke-dasharray="2.2 2.2" opacity="0.6"`}/>`, "entry");

/** An arrow up: the next level, something that can be built or raised. */
export const upIcon = (c = "currentColor") => svg(`<path d="M8 2 L14 9 H10 V14 H6 V9 H2 Z" fill="${c}"/>`, "up");

/** A robot of the player's side or the enemy's: a head and shoulders. */
export const robotIcon = (c: string) => svg(`<rect x="4.5" y="1.5" width="7" height="5.5" rx="1" fill="${c}"/><path d="M2 15 V10.5 C2 9 3 8 4.5 8 H11.5 C13 8 14 9 14 10.5 V15 Z" fill="${c}"/>`, "robot");

/** A turret. */
export const turretIcon = (c = "currentColor") => svg(`<rect x="3" y="10" width="10" height="5" fill="${c}"/><rect x="5" y="6" width="6" height="4.5" rx="1" fill="${c}"/><path d="M10 7.5 H15" stroke="${c}" stroke-width="2"/>`, "turret");

/** A route a tool opens, as the map draws it: a solid teal line when open, a dashed orange one when shut. */
export const routeIcon = (open: boolean) =>
  `<svg class="ico route ${open ? "open" : "shut"}" viewBox="0 0 24 12" width="24" height="12" aria-hidden="true">${
    open
      ? `<path d="M1.5 6 H22.5" stroke="#6fd0cf" stroke-width="3" stroke-linecap="round"/>`
      : `<path d="M1.5 6 H22.5" stroke="#ff8a5c" stroke-width="3" stroke-dasharray="3.5 2.5"/><path d="M9 2 L15 10 M15 2 L9 10" stroke="#ff8a5c" stroke-width="2"/>`
  }</svg>`;

/** A heal by what it restores: a shield cell (blue) or health (green). */
export const healIcon = (shield: boolean) => (shield ? svg(`<path d="M8 1.5 L14 4 V8.5 C14 11.8 11.3 14 8 15 C4.7 14 2 11.8 2 8.5 V4 Z" fill="#4fb6ff"/>`, "heal") : reviveIcon("#7fe08a"));

/** A loudspeaker: the action makes noise the robots hear. */
export const noiseIcon = (c = "currentColor") => svg(`<path d="M2 6 H5 L9 2.5 V13.5 L5 10 H2 Z" fill="${c}"/><path d="M11 5.5 C12.3 6.8 12.3 9.2 11 10.5 M12.8 3.8 C15 6 15 10 12.8 12.2" stroke="${c}" stroke-width="1.4" fill="none" stroke-linecap="round"/>`, "noise");

/** The night between two days: a crescent moon (the enemy's attacks overnight, meta/island.ts `nightRaids()`). */
export const nightIcon = (c = "#c9d3ff") => svg(`<path d="M10.5 1.8 A6.6 6.6 0 1 0 14.2 11 A5.4 5.4 0 0 1 10.5 1.8 Z" fill="${c}"/>`, "night");

/** The pouch's own colour: what sits in it comes home even from a wipe. Used for its slots on every screen. */
export const POUCH = "#e8b07a";

/** The pouch: a small stitched bag in the pouch's colour. */
export const pouchIcon = (c = POUCH) =>
  svg(`<path d="M3 5.5 H13 V12 C13 13.4 12 14.5 10.5 14.5 H5.5 C4 14.5 3 13.4 3 12 Z" fill="${c}"/><path d="M3 5.5 L5 2 H11 L13 5.5" fill="${c}" stroke="rgba(20,24,40,0.85)" stroke-width="1"/><path d="M4.8 7.5 V12.2 M11.2 7.5 V12.2" stroke="rgba(20,24,40,0.7)" stroke-width="1" stroke-dasharray="1.4 1.2"/>`, "pouch");

/** A mod part, the floor's purple hexagon plate. */
export const modIcon = (c = "#b65cff") => svg(`<path d="M8 1.5 L13.6 4.75 V11.25 L8 14.5 L2.4 11.25 V4.75 Z" fill="${c}" stroke="rgba(20,24,40,0.85)" stroke-width="1.1"/><path d="M8 5 L10.6 6.5 V9.5 L8 11 L5.4 9.5 V6.5 Z" fill="rgba(255,255,255,0.35)"/>`, "mod");

/**
 * A supply bin, as the world draws one (a teal crate, its concrete lid raised), holding `inside`
 * (icons' markup) in its mouth: what its search can turn up.
 */
export const binPicture = (inside: string, cls = "") =>
  `<span class="bin-pic ${cls}"><span class="bin-in">${inside}</span><svg class="bin-box" viewBox="0 0 40 22" aria-hidden="true"><path d="M2 3 L38 3 L36 0.5 L4 0.5 Z" fill="#cfc8b8"/><rect x="3" y="4" width="34" height="16" rx="1" fill="#2f7f86"/><rect x="3" y="16.5" width="34" height="3.5" fill="#cfc8b8"/><path d="M3 4.6 H37" stroke="#ffffff" stroke-width="1"/></svg></span>`;

/** A gun, side on, in its rarity's colour. */
export const gunIcon = (c = "currentColor") => svg(`<path d="M0.5 5 H12 V4 H15.5 V6.6 H12 V8 H9.6 L9 11.8 H6.8 L7.2 8 H5.2 L4 13.5 H1.2 L2.4 8 H0.5 Z" fill="${c}"/>`, "gun");

/** Body armour, in its level's colour. */
export const armorIcon = (c = "currentColor") => svg(`<path d="M5 1.5 L8 3 L11 1.5 L14 4 L12.5 6.5 V14.5 H3.5 V6.5 L2 4 Z" fill="${c}"/><path d="M8 3 V14.5" stroke="rgba(20,24,40,0.6)" stroke-width="1"/>`, "armor");

/** Where the raid starts: a pin in the player's colour, set on the chosen way in or depot. */
export const startIcon = (c: string = SIDE.own) =>
  svg(`<path d="M8 15 C4.5 10.6 2.8 8 2.8 5.9 a5.2 5.2 0 0 1 10.4 0 C13.2 8 11.5 10.6 8 15 Z" fill="${c}" stroke="#f4f7ff" stroke-width="1.3"/><circle cx="8" cy="5.9" r="2" fill="#f4f7ff"/>`, "start");
