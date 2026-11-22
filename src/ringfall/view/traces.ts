/*
 * Passive traces when other players are in the loop (ux-design M5): faint marks only, no legend
 * or player-facing name. View-only from a hash of the raid's seed and a stable id — never draws
 * on `rand(s)`, so the sim gate's hash stays put.
 */
import { mix } from "../sim/state";
import { STREETS } from "../sim/streets";

/** One faint mark: bin / road, and whether it reads as a past raid or a hold. */
export type TraceSpot = { x: number; z: number; t: "bin" | "road"; mode: "raid" | "hold" };

/** Uniform [0, 1) from seed + salt + id (same family as `binMod` / tools). */
const hashed = (seed: number, salt: number, id: number) =>
  mix(Math.imul(seed ^ 0x5a1e7ace, 0x9e3779b1) + Math.imul(id, 7919) + Math.imul(salt + 1, 104729)) / 4294967296;

/**
 * Traces for a raid that has other players in the loop (`owners` non-empty: incoming, lent, aid).
 * Density is low; capped so the map stays readable. Empty owners → none (the sim gate and lone raids).
 */
export function raidTraces(
  seed: number,
  bins: readonly { id: number; x: number; z: number }[],
  owners: readonly string[],
): TraceSpot[] {
  if (!owners.length) return [];
  const out: TraceSpot[] = [];
  for (const b of bins) {
    if (hashed(seed, 1, b.id) < 0.1) {
      out.push({ x: b.x, z: b.z, t: "bin", mode: hashed(seed, 3, b.id) < 0.45 ? "raid" : "hold" });
    }
  }
  STREETS.forEach((s, si) => {
    for (let i = 0; i + 1 < s.line.length; i++) {
      const a = s.line[i];
      const b = s.line[i + 1];
      if (hashed(seed, 2, si * 997 + i) >= 0.07) continue;
      const id = si * 997 + i;
      out.push({
        x: (a[0] + b[0]) * 0.5,
        z: (a[1] + b[1]) * 0.5,
        t: "road",
        mode: hashed(seed, 4, id) < 0.45 ? "raid" : "hold",
      });
    }
  });
  out.sort((a, b) => a.x - b.x || a.z - b.z || a.t.localeCompare(b.t) || a.mode.localeCompare(b.mode));
  return out.slice(0, 28);
}
