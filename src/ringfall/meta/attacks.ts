/*
 * 攻められた記録 (docs/ringfall/glossary.md 攻めの記録): the sorties other players made on this
 * player's holdings, as the island's log told them (`IslandLogEntry` with stars), kept on the profile
 * for the signal station to show. Pure.
 */
import type { IslandLogEntry } from "./expeditions";
import { ISLAND_TABLE } from "./island-table";
import { parseReplay, type Replay } from "../sim/replay-data";

/** How many records the profile keeps, newest last (the island keeps as many with their tracks). */
export const ATTACKS_KEPT = 8;

/** One sortie on a holding: when, whose, which, how it ended, what it cost, and the track when sent. */
export interface Attack {
  seq: number;
  at: number;
  by: { code: string; name: string };
  node: string;
  /** Taken (取られた) or held (守りきった). */
  taken: boolean;
  stars: number;
  /** Trophies the attacker won: what this player lost. */
  won?: number;
  /** 拠点の収入 taken back for it (meta/income.ts `clawBack()`), in credits. */
  credits?: number;
  replay?: Replay;
}

const NODE_IDS: readonly string[] = ISLAND_TABLE.nodes.map((n) => n.id);

/** Whether a log line is a sortie's (the `raid` op's, which alone carries stars). */
export const isSortieLine = (e: IslandLogEntry) => (e.t === "taken" || e.t === "wiped") && e.stars !== undefined;

/** The records kept with the sorties among `news`, each holding's income taken back by `credits` (by seq), the newest `ATTACKS_KEPT`. */
export function addAttacks(kept: readonly Attack[], news: readonly IslandLogEntry[], credits: Readonly<Record<number, number>> = {}): Attack[] {
  const fresh = news.filter(isSortieLine).filter((e) => !kept.some((a) => a.seq === e.seq));
  if (!fresh.length) return kept as Attack[];
  const add = fresh.map(
    (e): Attack => ({
      seq: e.seq,
      at: e.at,
      by: { ...e.by },
      node: e.node,
      taken: e.t === "taken",
      stars: e.stars ?? 0,
      ...(e.won ? { won: e.won } : {}),
      ...(credits[e.seq] ? { credits: credits[e.seq] } : {}),
      ...(e.replay ? { replay: e.replay } : {}),
    }),
  );
  return [...kept, ...add].sort((a, b) => a.seq - b.seq).slice(-ATTACKS_KEPT);
}

/** Records read back from a save; anything that does not read is left out. */
export function parseAttacks(raw: unknown): Attack[] {
  if (!Array.isArray(raw)) return [];
  const n = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  return raw
    .flatMap((a): Attack[] => {
      if (!a || typeof a !== "object") return [];
      const o = a as Record<string, unknown>;
      const by = o.by as Record<string, unknown> | undefined;
      if (!n(o.seq) || !n(o.at) || typeof o.node !== "string" || !NODE_IDS.includes(o.node) || !by || typeof by.code !== "string" || typeof by.name !== "string") return [];
      const replay = parseReplay(o.replay, [o.node]);
      return [
        {
          seq: o.seq as number,
          at: o.at as number,
          by: { code: by.code, name: by.name },
          node: o.node,
          taken: o.taken === true,
          stars: n(o.stars) ? Math.min(3, Math.round(o.stars as number)) : 0,
          ...(n(o.won) && (o.won as number) > 0 ? { won: Math.round(o.won as number) } : {}),
          ...(n(o.credits) && (o.credits as number) > 0 ? { credits: Math.round(o.credits as number) } : {}),
          ...(replay ? { replay } : {}),
        },
      ];
    })
    .slice(-ATTACKS_KEPT);
}
