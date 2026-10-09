import { useEffect, useState } from "react";

/**
 * Per-cabinet persistence. Storage can be missing (private mode, blocked site
 * data), so every access is guarded and the game still runs without it.
 */
const PREFIX = "arcade:";

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? { ...fallback, ...(JSON.parse(raw) as T) } : fallback;
  } catch {
    return fallback;
  }
}

export function store<T>(key: string, value: T): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* progress just won't persist */
  }
}

export function useSaved<T>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(() => load(key, fallback));
  useEffect(() => store(key, value), [key, value]);
  return [value, setValue] as const;
}
