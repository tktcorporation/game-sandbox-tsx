/*
 * The island code (docs/ringfall/multiplayer.md): a short public name for a player's island, which
 * others type to send an expedition there. Six characters of Crockford's base32 (no I, L, O or U,
 * so it reads aloud without confusion). The server draws it when a player claims their island
 * (`POST /api/islands`, worker/api.ts): a code a client could choose or compute could be claimed by
 * someone else first. It names the island only: the player's id stays the secret that proves who
 * owns it. A leaf module, so that the browser and the Worker share it.
 */

/** Crockford's base32 alphabet: the digits and the letters but I, L, O and U. */
export const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The characters of an island code. */
export const CODE_LENGTH = 6;

const CODE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

/** Whether `s` is an island code as written (upper case). */
export const isIslandCode = (s: unknown): s is string => typeof s === "string" && CODE.test(s);

/** A code typed by a person: upper-cased and trimmed, or null when it is not one. */
export function parseIslandCode(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const up = s.trim().toUpperCase();
  return isIslandCode(up) ? up : null;
}

/** A new random code from `bytes` (the platform's random source by default). 32 divides 256, so each byte's low five bits pick a character evenly. */
export function newIslandCode(bytes: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  return [...bytes(CODE_LENGTH)].map((b) => CODE_ALPHABET[b & 31]).join("");
}
