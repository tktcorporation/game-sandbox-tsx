/*
 * The island code (docs/ringfall/multiplayer.md): a short public name for a player's island, which
 * others type to send an expedition there. Six characters of Crockford's base32 (no I, L, O or U,
 * so it reads aloud without confusion), the first of the SHA-256 of the player's secret id
 * (`codeOf()`): the code follows from the id, so only the holder of the id can claim its island,
 * and the code tells nothing of the id. A leaf module, so that the browser and the Worker share it.
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

/** The island code of the player with secret id `id`: the first 30 bits of its SHA-256, five bits a character. */
export async function codeOf(id: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id)));
  let code = "";
  for (let k = 0; k < CODE_LENGTH; k++) {
    const bit = k * 5;
    const pair = (digest[bit >> 3] << 8) | digest[(bit >> 3) + 1];
    code += CODE_ALPHABET[(pair >> (11 - (bit & 7))) & 31];
  }
  return code;
}
