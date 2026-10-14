import { newProfile, parseProfile, type Profile } from "./profile";

const KEY = "ringfall.profile.v1";

/** The saved profile, or a new one when there is none or storage is unavailable. */
export function loadProfile(): Profile {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return parseProfile(JSON.parse(raw)) ?? newProfile();
  } catch {
    // Private windows and blocked storage: play on with a fresh profile.
  }
  return newProfile();
}

export function saveProfile(p: Profile) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // Same as above: progress is kept for this session only.
  }
}
