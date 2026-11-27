/*
 * First-time multiplayer how-to (TKT-204 案 C / 2026-11-26 early-MP): three cards
 * on the first camp session (and again before depart if still unseen). New profiles
 * hold sea-route shores from day 1, so the gate is open immediately. Seen flag is
 * local only (no Profile.v bump).
 */
import type { Island } from "./island";

const KEY = "ringfall.mpHowto.v1";

/** Whether the player holds any node (a holding other players may attack). */
export function holdsContested(poiState: Island): boolean {
  return Object.values(poiState).some((x) => x?.state === "own");
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

/**
 * Show once: holds a contested hub (new profiles: from day 1) and has not seen the cards.
 * Callers show this at camp open first; depart keeps a fallback.
 */
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
