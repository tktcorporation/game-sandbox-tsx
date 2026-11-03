import { isIslandCode, newIslandCode } from "./island-code";

/*
 * The player's anonymous identity for the server (docs/ringfall/multiplayer.md): a random id, a
 * display name and the island's public code, made on first need and kept in the browser's storage under a key of their own,
 * apart from the profile, so that a new profile keeps the same player.
 */

const KEY = "ringfall.player.v1";

export interface Identity {
  /** A random UUID, the player's id on the server. */
  id: string;
  /** The name others see, 1 to 24 characters. */
  name: string;
  /** The island's public code (meta/island-code.ts): what others type to send an expedition to it. The id stays secret. */
  code: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The name a new player starts with: `プレイヤー-` and the first four characters of the id. */
export const defaultName = (id: string) => `プレイヤー-${id.slice(0, 4)}`;

/** A saved identity, or null for anything unreadable. One saved without a usable code gets a new one. */
export function parseIdentity(raw: unknown): Identity | null {
  if (!raw || typeof raw !== "object") return null;
  const { id, name, code } = raw as Record<string, unknown>;
  if (typeof id !== "string" || !UUID.test(id)) return null;
  const n = typeof name === "string" ? name.trim() : "";
  const chars = [...n].length;
  return { id, name: chars >= 1 && chars <= 24 ? n : defaultName(id), code: isIslandCode(code) ? code : newIslandCode() };
}

/** Saves `who` for next time; when storage is unavailable it lasts for this page only, and play goes on. */
function save(who: Identity) {
  try {
    localStorage.setItem(KEY, JSON.stringify(who));
  } catch {
    // Private windows and blocked storage.
  }
}

/** The identity this page settled on, so that it stays the same when storage cannot keep it. */
let current: Identity | null = null;

/**
 * The saved identity, or a new one saved for next time. When storage is unavailable the new one
 * lasts for this page only (every raid of the page sends it), and play goes on as ever.
 */
export function loadIdentity(): Identity {
  if (current) return current;
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    const saved = parseIdentity(parsed);
    if (saved) {
      // One saved without a usable code keeps its id and name and is saved again with the code it was given.
      if ((parsed as Record<string, unknown>).code !== saved.code) save(saved);
      return (current = saved);
    }
  } catch {
    // Private windows and blocked storage: a fresh identity below.
  }
  const id = crypto.randomUUID();
  const made: Identity = { id, name: defaultName(id), code: newIslandCode() };
  save(made);
  return (current = made);
}
