import type { EventKind } from "../sim/config";
import type { IslandEvent } from "../sim/island";
import { eventName, eventText } from "../meta/island";
import { DEBRIS_SPOTS, debrisIndex } from "../sim/map";
import type { State } from "../sim/state";

/*
 * The island's events as the camp's map table, the objective card and the results show them:
 * a small icon of its own for each, and its line.
 */

/** Each event's mark colour, from the palette the map already uses (the loot's gold, the haze, the crews' rust). */
const TINT: Record<EventKind, string> = { debris: "#e0a33a", storm: "#8d9aa8", crews: "#c86f3a" };

/** A 16 px icon for an event, drawn inline so it needs no font: a falling shard, a cloud, a crate. */
export function eventIcon(t: EventKind): string {
  const c = TINT[t];
  const body = {
    debris: `<path d="M9 1 L13 6 L8 15 L5 9 Z" fill="${c}"/><path d="M3 2 L6 6 M1 6 L4 8" stroke="${c}" stroke-width="1.4" stroke-linecap="round"/>`,
    storm: `<path d="M4 10 a3 3 0 0 1 1-5.8 a4 4 0 0 1 7.5 1 a2.5 2.5 0 0 1 0 4.8 Z" fill="${c}"/><path d="M8 11 L6.5 14 H9 L7.5 16" stroke="#e8edf3" stroke-width="1.3" fill="none" stroke-linejoin="round"/>`,
    crews: `<rect x="2" y="6" width="12" height="8" rx="1" fill="${c}"/><path d="M2 9 H14 M6 6 V4 H10 V6" stroke="#1b1f2a" stroke-width="1.2" fill="none"/>`,
  }[t];
  return `<svg class="ev-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">${body}</svg>`;
}

/** An event in a line with its icon and name: 「[icon] 嵐：…」, or the quiet day's line. */
export function eventRow(ev: IslandEvent | null, quiet = "出来事はない"): string {
  if (!ev) return `<span class="ev quiet">${quiet}</span>`;
  return `<span class="ev ev-${ev.t}">${eventIcon(ev.t)}<b>${eventName(ev)}</b>${eventText(ev)}</span>`;
}

/** The day's event as the objective card words it in a raid, in one short line. */
export function raidEventLine(s: Pick<State, "event" | "stats" | "crewsDue">): string {
  const ev = s.event;
  if (!ev) return "";
  const head = `${eventIcon(ev.t)}${eventName(ev)}：`;
  switch (ev.t) {
    case "debris":
      return `${head}${DEBRIS_SPOTS[debrisIndex(ev.spot)].place}に破片の箱（地図の印）`;
    case "storm":
      return `${head}ロボットの視界は 6 割`;
    case "crews":
      return `${head}回収部隊 ${s.stats.crewsIn} 組が来た${s.crewsDue.length ? `・あと ${s.crewsDue.length} 組` : ""}`;
  }
}
