/// <reference types="@cloudflare/workers-types" />

import { advance, busy, EXPEDITION, islandOp, type IslandOp, type IslandState } from "./island";

/*
 * One island's Durable Object (docs/ringfall/multiplayer.md, 戦いの解き方): the only writer of that
 * island's state, addressed by the island's code (`ISLAND.idFromName(code)`). It loads the state,
 * applies one op of worker/island.ts and stores it; its alarm reckons the island while expeditions
 * are on it. The API (worker/api.ts) is its only caller: it posts `{ op, now }` and reads the answer.
 */

const KEY = "island";

export class IslandDO implements DurableObject {
  constructor(
    private ctx: DurableObjectState,
    _env: unknown,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const { op, now } = (await request.json()) as { op: IslandOp; now: number };
    const state = (await this.ctx.storage.get<IslandState>(KEY)) ?? null;
    const r = islandOp(state, op, now);
    if (r.state) await this.ctx.storage.put(KEY, r.state);
    await this.wake(r.state, EXPEDITION.alarmMs);
    return Response.json(r.body, { status: r.status });
  }

  async alarm(): Promise<void> {
    const state = (await this.ctx.storage.get<IslandState>(KEY)) ?? null;
    if (!state) return;
    const behind = advance(state, Date.now());
    await this.ctx.storage.put(KEY, state);
    // The alarm that fired is spent: the next is set here, at once for an island further behind than one reckoning.
    if (busy(state)) await this.ctx.storage.setAlarm(Date.now() + (behind ? 1 : EXPEDITION.alarmMs));
  }

  /** Sets the alarm `ms` from now while expeditions are on the island, unless one is already set. */
  private async wake(state: IslandState | null, ms: number) {
    if (!busy(state) || (await this.ctx.storage.getAlarm()) !== null) return;
    await this.ctx.storage.setAlarm(Date.now() + ms);
  }
}
