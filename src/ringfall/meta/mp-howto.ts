/*
 * First-time multiplayer how-to (TKT-204 案 C): three cards when the player first
 * holds a contested coastal hub. Seen flag is local only (no Profile.v bump).
 */
import { CONTESTED_SHORES } from "./neighbours";
import type { Island } from "./island";

const KEY = "ringfall.mpHowto.v1";

/** Whether any contested coastal hub is the player's. */
export function holdsContested(poiState: Island): boolean {
  return CONTESTED_SHORES.some((id) => poiState[id]?.state === "own");
}

/** Already dismissed the three cards on this browser. */
export function mpHowtoSeen(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function markMpHowtoSeen(): void {
  try {
    localStorage.setItem(KEY, "1");
  } catch {
    /* ignore quota / private mode */
  }
}

/** Show once: holds a contested hub and has not seen the cards. */
export function shouldShowMpHowto(poiState: Island): boolean {
  return holdsContested(poiState) && !mpHowtoSeen();
}

/** Automation / shots: clear the seen flag. */
export function resetMpHowtoSeen(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
