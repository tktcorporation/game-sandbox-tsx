/*
 * The player's anonymous identity for the server (docs/ringfall/multiplayer.md): a random id and a
 * display name, made on first need and kept in the browser's storage under a key of their own,
 * apart from the profile, so that a new profile keeps the same player.
 */

import { isIslandCode } from "./island-code";

const KEY = "ringfall.player.v1";

export interface Identity {
  /** A random UUID, the player's id on the server. */
  id: string;
  /** The name others see, 1 to 24 characters. */
  name: string;
  /** The island's public code (meta/island-code.ts), as the server handed it out when the player claimed their island; absent until then. */
  code?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The name a new player starts with: `プレイヤー-` and the first four characters of the id. */
export const defaultName = (id: string) => `プレイヤー-${id.slice(0, 4)}`;

/** A saved identity, or null for anything unreadable. */
export function parseIdentity(raw: unknown): Identity | null {
  if (!raw || typeof raw !== "object") return null;
  const { id, name, code } = raw as Record<string, unknown>;
  if (typeof id !== "string" || !UUID.test(id)) return null;
  const n = typeof name === "string" ? name.trim() : "";
  const chars = [...n].length;
  const who: Identity = { id, name: chars >= 1 && chars <= 24 ? n : defaultName(id) };
  if (isIslandCode(code)) who.code = code;
  return who;
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
    const saved = raw ? parseIdentity(JSON.parse(raw)) : null;
    if (saved) return (current = saved);
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
  return (current = made);
}

/** Keeps the island code the server handed out (`POST /api/islands`) with the identity, for this page and, where storage works, the next. */
export function rememberCode(code: string): Identity {
  const who = { ...loadIdentity(), code };
  current = who;
  try {
    localStorage.setItem(KEY, JSON.stringify(who));
  } catch {
    // Without storage the code lasts for this page; the next page claims an island again.
  }
  return who;
}
