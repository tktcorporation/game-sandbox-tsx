/// <reference types="@cloudflare/workers-types" />

import { handleApi } from "./api";

interface Env {
  ASSETS: Fetcher;
  /** RINGFALL's database; absent until one is connected (docs/ringfall/multiplayer.md). */
  DB?: D1Database;
  /** RINGFALL's islands, one Durable Object for each island code, held by the islands Worker (islands/); absent until bound (docs/ringfall/multiplayer.md). */
  ISLAND?: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (await handleApi(request, env)) ?? env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
