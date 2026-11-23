/*
 * X2 assault notice (docs/ringfall/game-design-review.md §5.8): scheduling an attack on a
 * neighbour's island raises the same 来る遠征 warning the defender already knows
 * (`EXPEDITION.notice` in worker/island.ts for real islands, `AI.coming` for the game's).
 * Pure: the profile's `expeditions` Outgoing list carries the notice; the short raid starts
 * only once it is ready. Do not import the worker from the client bundle.
 */
import { AI } from "./ai-islands";
import { alive, type Outgoing } from "./expeditions";
import type { NodeId } from "../sim/map";

/** Same seconds as `EXPEDITION.notice` (worker/island.ts) — keep in lockstep. */
export const ASSAULT_NOTICE = 12 * 3600;

/** Seconds of advance notice before an X2 short raid may start. */
export const assaultNoticeSec = (ai: boolean): number => (ai ? AI.coming * 60 : ASSAULT_NOTICE);

/** An outbound assault notice still open for a short raid (not holding / gone / recalling). */
export function assaultOf(list: readonly Outgoing[], code: string): Outgoing | null {
  return alive({ expeditions: list }).find((o) => o.code === code && o.state !== "holding") ?? null;
}

/** Whether the notice has elapsed and the short raid may begin. */
export function assaultReady(o: Pick<Outgoing, "sentAt">, ai: boolean, now = Date.now()): boolean {
  return now >= o.sentAt + assaultNoticeSec(ai) * 1000;
}

/** Seconds left until the short raid may begin (0 when ready). */
export function assaultLeft(o: Pick<Outgoing, "sentAt">, ai: boolean, now = Date.now()): number {
  return Math.max(0, Math.ceil((o.sentAt + assaultNoticeSec(ai) * 1000 - now) / 1000));
}

/**
 * Schedule a map-entry assault (穴 A / 攻める). Reuses Outgoing so AI views and the signal
 * station's 「出ている遠征」 show the same 来る遠征 shape. Idempotent while one is alive for `code`.
 */
export function scheduleAssault(
  list: readonly Outgoing[],
  opts: { code: string; node: NodeId; units: number; id: number; now?: number },
): { list: Outgoing[]; created: Outgoing | null } {
  const now = opts.now ?? Date.now();
  if (assaultOf(list, opts.code)) return { list: [...list], created: null };
  // A completed X2 (`holding`) must not block a fresh notice — drop it before scheduling.
  const cleared = list.filter((o) => !(o.code === opts.code && (o.state === "holding" || o.state === "gone")));
  const created: Outgoing = {
    code: opts.code,
    node: opts.node,
    sentAt: now,
    id: opts.id,
    units: opts.units,
    state: "coming",
    x2: true,
  };
  return { list: [...cleared, created], created };
}

/** Mark the assault holding after a successful X2 制圧 (defender lost the node on their copy). */
export function assaultWon(list: readonly Outgoing[], code: string): Outgoing[] {
  return list.map((o) => (o.code === code && o.state !== "gone" && o.state !== "recalling" ? { ...o, state: "holding" as const } : o));
}

/** Drop / mark gone when the short raid failed to take the target. */
export function assaultLost(list: readonly Outgoing[], code: string): Outgoing[] {
  return list.map((o) => (o.code === code && (o.state === "coming" || o.state === "attacking" || o.state === "waiting") ? { ...o, state: "gone" as const } : o));
}
