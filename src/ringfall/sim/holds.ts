/*
 * Who holds a POI on the island, as plain data: the enemy, the player, or another player
 * (docs/ringfall/multiplayer.md). A leaf module (no imports), so that the battle's reckoning
 * (sim/reckon.ts) can run on a server with the same code.
 */

/** A POI another player's expedition took: `rival:` and that player's id. */
export type RivalHold = `rival:${string}`;

/** Who holds a POI: the enemy (red on the maps), the player (blue), or another player (`RivalHold`). */
export type PoiHold = "held" | "freed" | RivalHold;

/** The standing of a POI held by the player with id `owner`. */
export const rivalHold = (owner: string): RivalHold => `rival:${owner}`;

/** The id of the other player holding a POI of standing `h`, or null when the enemy or the player holds it. */
export const rivalOf = (h: PoiHold): string | null => (h === "held" || h === "freed" ? null : h.slice(6));

/** A saved standing; null for anything unreadable. An owner's id is 1 to 64 letters, digits, `-` or `_`. */
export function parseHold(raw: unknown): PoiHold | null {
  if (raw === "held" || raw === "freed") return raw;
  return typeof raw === "string" && /^rival:[A-Za-z0-9_-]{1,64}$/.test(raw) ? (raw as RivalHold) : null;
}
