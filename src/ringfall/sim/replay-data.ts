/*
 * 攻めの記録 as plain data (sim/replay.ts records it): its shape, its limits and its reading back.
 * No imports, so the island server (worker/island.ts) reads it without the world. Sized to travel
 * inside a report's body (`MAX_BODY` in worker/api.ts, 4 KiB): a whole sortie is about 2 KiB.
 */
export const REPLAY = {
  /** Seconds between two points of the path. */
  every: 3,
  /** The most points a path keeps (a sortie lasts `SORTIE.time`, 300 s). */
  points: 110,
  /** The most marks kept. */
  marks: 30,
} as const;

/** A moment of a sortie: the capture begun (`core`) and done (`taken`), a defender down (`fall`), the attacker down (`down`), the end (`end`). */
export type ReplayMark = { t: number; k: "core" | "taken" | "fall" | "down" | "end"; x: number; z: number };

/** A sortie's record: the holding's node, seconds between points, the path as x, z pairs, and its marks. */
export interface Replay {
  node: string;
  every: number;
  path: number[];
  marks: ReplayMark[];
}

const KINDS: readonly ReplayMark["k"][] = ["core", "taken", "fall", "down", "end"];
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A record read back from the server or a save (its node one of `nodes`), or null for anything that does not read. */
export function parseReplay(raw: unknown, nodes: readonly string[]): Replay | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.node !== "string" || !nodes.includes(o.node)) return null;
  const every = num(o.every) && o.every > 0 && o.every <= 10 ? o.every : REPLAY.every;
  const path = Array.isArray(o.path) ? o.path.slice(0, REPLAY.points * 2).filter(num).map(Math.round) : [];
  const marks = Array.isArray(o.marks)
    ? o.marks.slice(0, REPLAY.marks).flatMap((m) => {
        if (!m || typeof m !== "object") return [];
        const q = m as Record<string, unknown>;
        return num(q.t) && KINDS.includes(q.k as never) && num(q.x) && num(q.z) ? [{ t: Math.round(q.t), k: q.k as ReplayMark["k"], x: Math.round(q.x), z: Math.round(q.z) }] : [];
      })
    : [];
  return { node: o.node, every, path: path.length % 2 ? path.slice(0, -1) : path, marks };
}
