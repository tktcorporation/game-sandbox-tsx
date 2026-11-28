/// <reference types="@cloudflare/workers-types" />

import { islandOp, migrateIslandState, type IslandOp, type IslandState } from "./island";

/*
 * One island's Durable Object (docs/ringfall/multiplayer.md, 戦いの解き方): the only writer of that
 * island's state, addressed by the island's code (`ISLAND.idFromName(code)`). It loads the state,
 * applies one op of worker/island.ts and stores it. The API (worker/api.ts) is its only caller: it posts `{ op, now }` and reads the answer.
 */

const KEY = "island";

export class IslandDO implements DurableObject {
  constructor(
    private ctx: DurableObjectState,
    _env: unknown,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const { op, now } = (await request.json()) as { op: IslandOp; now: number };
    const raw = (await this.ctx.storage.get<IslandState>(KEY)) ?? null;
    const state = raw ? migrateIslandState(raw) : null;
    const r = islandOp(state, op, now);
    if (r.state && r.changed) await this.ctx.storage.put(KEY, r.state);
    return Response.json(r.body, { status: r.status });
  }

  /** An alarm left set by an island from before expeditions were removed: nothing to do, and none is set again. */
  async alarm(): Promise<void> {}
}
