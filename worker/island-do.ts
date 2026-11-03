/// <reference types="@cloudflare/workers-types" />

import { advance, islandOp, nextAlarm, type IslandOp, type IslandState } from "./island";

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
    if (r.state && r.changed) await this.ctx.storage.put(KEY, r.state);
    await this.arm(r.state, now);
    return Response.json(r.body, { status: r.status });
  }

  async alarm(): Promise<void> {
    const state = (await this.ctx.storage.get<IslandState>(KEY)) ?? null;
    if (!state) return;
    const now = Date.now();
    const { behind, moved } = advance(state, now);
    if (moved) await this.ctx.storage.put(KEY, state);
    // The alarm that fired is spent: the next goes on at once for an island further behind than one reckoning.
    if (behind) await this.ctx.storage.setAlarm(now + 1);
    else await this.arm(state, now);
  }

  /** Sets the alarm to `nextAlarm()`, or clears it when nothing on the island can change. */
  private async arm(state: IslandState | null, now: number) {
    const at = nextAlarm(state, now);
    const set = await this.ctx.storage.getAlarm();
    if (at === null) {
      if (set !== null) await this.ctx.storage.deleteAlarm();
    } else if (set === null || set > at) await this.ctx.storage.setAlarm(at);
  }
}
