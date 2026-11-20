import { newProfile, parseProfile, type Profile } from "./profile";

const KEY = "ringfall.profile.v1";

/**
 * A new profile's seed: the clock, so each player's island differs, but a fixed one under a browser
 * driver, so the shots gate plays the same board and the same raids however late it runs.
 */
const freshSeed = () => (typeof navigator !== "undefined" && navigator.webdriver ? 1 : Date.now());

/** The saved profile, or a new one when there is none or storage is unavailable. */
export function loadProfile(): Profile {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return parseProfile(JSON.parse(raw), freshSeed()) ?? newProfile(freshSeed());
  } catch {
    // Private windows and blocked storage: play on with a fresh profile.
  }
  return newProfile(freshSeed());
}

export function saveProfile(p: Profile) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // Same as above: progress is kept for this session only.
  }
}
