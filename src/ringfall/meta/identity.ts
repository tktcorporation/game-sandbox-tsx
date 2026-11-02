/*
 * The player's anonymous identity for the server (docs/ringfall/multiplayer.md): a random id and a
 * display name, made on first need and kept in the browser's storage under a key of their own,
 * apart from the profile, so that a new profile keeps the same player.
 */

const KEY = "ringfall.player.v1";

export interface Identity {
  /** A random UUID, the player's id on the server. */
  id: string;
  /** The name others see, 1 to 24 characters. */
  name: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The name a new player starts with: `プレイヤー-` and the first four characters of the id. */
export const defaultName = (id: string) => `プレイヤー-${id.slice(0, 4)}`;

/** A saved identity, or null for anything unreadable. */
export function parseIdentity(raw: unknown): Identity | null {
  if (!raw || typeof raw !== "object") return null;
  const { id, name } = raw as Record<string, unknown>;
  if (typeof id !== "string" || !UUID.test(id)) return null;
  const n = typeof name === "string" ? name.trim() : "";
  const chars = [...n].length;
  return { id, name: chars >= 1 && chars <= 24 ? n : defaultName(id) };
}

/**
 * The saved identity, or a new one saved for next time. When storage is unavailable the new one
 * lasts for this page only, and play goes on as ever.
 */
export function loadIdentity(): Identity {
  try {
    const raw = localStorage.getItem(KEY);
    const saved = raw ? parseIdentity(JSON.parse(raw)) : null;
    if (saved) return saved;
  } catch {
    // Private windows and blocked storage: a fresh identity below.
  }
  const id = crypto.randomUUID();
  const made: Identity = { id, name: defaultName(id) };
  try {
    localStorage.setItem(KEY, JSON.stringify(made));
  } catch {
    // Same as above: the identity lasts for this page only.
  }
  return made;
}
