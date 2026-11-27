/*
 * 拠点の収入（docs/ringfall/glossary.md 決定 A）: 陣地ごとに現実の時間で溜まり、野営地で受け取る。
 * レイドの回数では増えない。一つの陣地に溜まるのは `INCOME.cap` 時間分まで（取りに来ないと止まる）。
 * 陣地を攻められて取られると、そこに溜まっていた分は攻め手が持っていく（meta/away-attacks.ts）。
 * 取られたと分かる前に受け取ってしまった分は、分かった時点でお金から引く（`clawBack()`）。
 */
import { NODES, type NodeId } from "../sim/map";
import { playerNodes, type Island } from "./island";

export const INCOME = {
  /** Credits a holding makes an hour. */
  perHour: 60,
  /** Hours a holding fills before it stops (about a working day away). */
  cap: 12,
} as const;

const HOUR = 3_600_000;

/** What the holdings have made and not yet been collected, and when they were last brought up to date. */
export interface Stores {
  /** Credits waiting at each holding. */
  at: Partial<Record<NodeId, number>>;
  /** When `at` was last brought up to date (ms; 0 before the first look). */
  since: number;
  /**
   * What each holding paid at its recent collections, and when (oldest first, the last `PAID_KEEP`):
   * those after the holding turns out to have been taken are taken back (`clawBack()`).
   */
  paid?: Partial<Record<NodeId, Paid[]>>;
}

/** One collection from a holding. */
export type Paid = { at: number; n: number };

/** How many collections a holding keeps a record of: enough for every raid home before the next sync. */
export const PAID_KEEP = 8;

export const emptyStores = (): Stores => ({ at: {}, since: 0 });

/** The most a holding holds. */
export const storeCap = (): number => INCOME.perHour * INCOME.cap;

/** The stores brought up to `now`: each holding of `poiState` fills by the hours since, to its cap; a node no longer held keeps nothing. */
export function accrue(s: Stores, poiState: Island, now: number): Stores {
  const own = new Set(playerNodes({ poiState }));
  // The records of collections stay: a holding's loss may be learned only later (`clawBack()`).
  const paid = s.paid ? { paid: s.paid } : {};
  if (!s.since) return { at: Object.fromEntries([...own].map((id) => [id, s.at[id] ?? 0])), since: now, ...paid };
  const hours = Math.max(0, now - s.since) / HOUR;
  const at: Partial<Record<NodeId, number>> = {};
  // A holding taken since the last look starts making from now.
  for (const id of own) at[id] = id in s.at ? Math.min(storeCap(), (s.at[id] ?? 0) + hours * INCOME.perHour) : 0;
  return { at, since: Math.max(s.since, now), ...paid };
}

/** The credits waiting at all holdings: each holding's whole credits. */
export const waiting = (s: Stores): number => NODES.reduce((n, x) => n + Math.floor(s.at[x.id] ?? 0), 0);

/** Collects what the holdings made up to `now`: the whole credits, each holding keeping the fraction of a credit it has not finished. */
export function collect(s: Stores, poiState: Island, now: number): { credits: number; stores: Stores } {
  const up = accrue(s, poiState, now);
  const credits = waiting(up);
  const at: Partial<Record<NodeId, number>> = {};
  const paid: Partial<Record<NodeId, Paid[]>> = { ...(s.paid ?? {}) };
  for (const id of Object.keys(up.at) as NodeId[]) {
    const v = up.at[id] ?? 0;
    at[id] = v - Math.floor(v);
    if (Math.floor(v) > 0) paid[id] = [...(paid[id] ?? []), { at: now, n: Math.floor(v) }].slice(-PAID_KEEP);
  }
  return { credits, stores: { at, since: up.since, paid } };
}

/**
 * The holdings another player took (`lost`: which, and when) whose last collection came after: what
 * they paid then was the taker's (carried off as a holding taken carries what it made), so it comes
 * out of `cash` again, as far as there is cash. The credits taken back and the stores without those records.
 */
export function clawBack(s: Stores, cash: number, lost: readonly { node: NodeId; at: number }[]): { stores: Stores; back: number } {
  const paid = { ...(s.paid ?? {}) };
  let back = 0;
  for (const l of lost) {
    const p = paid[l.node];
    if (!p) continue;
    // Every collection after the holding was taken, however many raids came home before the loss was known.
    for (const q of p) if (q.at > l.at) back += q.n;
    const kept = p.filter((q) => q.at <= l.at);
    if (kept.length) paid[l.node] = kept;
    else delete paid[l.node];
  }
  back = Math.min(back, Math.max(0, cash));
  return { stores: { ...s, paid }, back };
}

/** Saved stores, or empty when missing / unreadable. */
export function parseStores(raw: unknown): Stores {
  if (!raw || typeof raw !== "object") return emptyStores();
  const o = raw as Record<string, unknown>;
  const at: Partial<Record<NodeId, number>> = {};
  if (o.at && typeof o.at === "object")
    for (const n of NODES) {
      const v = (o.at as Record<string, unknown>)[n.id];
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) at[n.id] = Math.min(storeCap(), v);
    }
  const since = typeof o.since === "number" && Number.isFinite(o.since) ? Math.max(0, o.since) : 0;
  const paid: Partial<Record<NodeId, Paid[]>> = {};
  const one = (v: unknown): Paid[] => {
    const q = v as { at?: unknown; n?: unknown } | null;
    return q && typeof q.at === "number" && Number.isFinite(q.at) && typeof q.n === "number" && Number.isFinite(q.n) && q.n > 0 ? [{ at: q.at, n: Math.floor(q.n) }] : [];
  };
  if (o.paid && typeof o.paid === "object")
    for (const n of NODES) {
      const v = (o.paid as Record<string, unknown>)[n.id];
      // A list of collections, or one as saves kept it before the list.
      const list = (Array.isArray(v) ? v.flatMap(one) : one(v)).slice(-PAID_KEEP);
      if (list.length) paid[n.id] = list;
    }
  return Object.keys(paid).length ? { at, since, paid } : { at, since };
}
