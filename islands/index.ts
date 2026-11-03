/// <reference types="@cloudflare/workers-types" />

/*
 * The islands Worker (`ringfall-islands`, islands/wrangler.jsonc): it holds RINGFALL's IslandDO
 * (worker/island-do.ts), apart from the game's Worker, which binds to it by script name
 * (docs/ringfall/multiplayer.md, サーバー). It answers nothing itself: the islands are reached
 * only through that binding.
 */

export { IslandDO } from "../worker/island-do";

export default {
  async fetch(): Promise<Response> {
    return Response.json({ ok: false, error: "not-found" }, { status: 404 });
  },
} satisfies ExportedHandler;
