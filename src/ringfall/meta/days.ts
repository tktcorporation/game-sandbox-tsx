/*
 * 日（docs/ringfall/glossary.md「時間」）: 日は現実の暦の一日で、日本時間の 0 時で替わる。
 * 出撃しても攻めても日は進まない。島の日数（AI プレイヤーの育ち、攻め先の入れ替わり）は
 * 島が始まった日（`Profile.since`）から数えた暦の日数。
 */

/** One day in ms. */
export const DAY = 86_400_000;
/** Japan's offset from UTC: the day turns at 0:00 in Japan. */
const JST = 9 * 3_600_000;

/** The calendar day (Japan) that holds `t`, counted from the epoch. */
export const calendarDay = (t: number): number => Math.floor((t + JST) / DAY);

/**
 * The island's day at `now`: 1 on the calendar day it started (`since`), 2 the next, and so on.
 * An island not started yet (`since` 0) is on its first day.
 */
export const islandDay = (p: { since: number }, now = Date.now()): number =>
  p.since > 0 ? Math.max(1, calendarDay(now) - calendarDay(p.since) + 1) : 1;

/** The `since` that puts an island on day `day` at `now` (an older save's count of raids, kept as calendar days). */
export const sinceFor = (day: number, now = Date.now()): number => now - (Math.max(1, Math.floor(day)) - 1) * DAY;
