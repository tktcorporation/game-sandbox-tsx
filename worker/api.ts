/*
 * RINGFALL's API under /api/ (docs/ringfall/multiplayer.md, サーバー). A plain handler of a request
 * and the Worker's bindings, so that scripts/ringfall-server.ts can run it on a stand-in database.
 *
 * The database binding is optional: until one is connected (the steps are in the doc), every route
 * but /api/health answers 503 and the game plays as ever.
 */

/** The part of D1's statement the API uses. */
export interface DbStatement {
  bind(...values: unknown[]): DbStatement;
  run(): Promise<unknown>;
}

/** The part of a D1 database the API uses: `D1Database` satisfies it. */
export interface Db {
  prepare(sql: string): DbStatement;
  batch(statements: DbStatement[]): Promise<unknown[]>;
}

export interface ApiEnv {
  DB?: Db;
}

/** The largest body /api/island reads, in bytes: a summary is a few hundred. */
export const MAX_BODY = 4096;

const OUTCOMES = ["extracted", "dead"] as const;

/** What /api/island records: the player, their island after a settled raid, and the raid. */
export interface IslandPost {
  player: { id: string; name: string };
  island: { day: number; held: number; enemy: number; rival: number; factory: number; strength: number };
  raid?: { day: number; outcome: (typeof OUTCOMES)[number]; captured: number };
}

const json = (status: number, body: unknown) => Response.json(body, { status });
const fail = (status: number, error: string) => json(status, { ok: false, error });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const int = (v: unknown, lo: number, hi: number): v is number => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;

/** Node counts are bounded well above the island's node count, so a map that grows is still taken. */
const NODES_MAX = 64;
const DAY_MAX = 100000;
const LEVEL_MAX = 10;

/** A valid post, or null. Names are trimmed and counted in characters (1 to 24). */
export function parseIslandPost(raw: unknown): IslandPost | null {
  if (!isObj(raw) || !isObj(raw.player) || !isObj(raw.island)) return null;
  const { id, name } = raw.player;
  if (typeof id !== "string" || !UUID.test(id) || typeof name !== "string") return null;
  const trimmed = name.trim();
  const chars = [...trimmed].length;
  if (chars < 1 || chars > 24) return null;
  const i = raw.island;
  if (!int(i.day, 0, DAY_MAX) || !int(i.held, 0, NODES_MAX) || !int(i.enemy, 0, NODES_MAX) || !int(i.rival, 0, NODES_MAX)) return null;
  if (!int(i.factory, 0, LEVEL_MAX) || !int(i.strength, 0, LEVEL_MAX)) return null;
  const post: IslandPost = {
    player: { id, name: trimmed },
    island: { day: i.day, held: i.held, enemy: i.enemy, rival: i.rival, factory: i.factory, strength: i.strength },
  };
  if (raw.raid !== undefined) {
    const r = raw.raid;
    if (!isObj(r) || !int(r.day, 0, DAY_MAX) || !(OUTCOMES as readonly unknown[]).includes(r.outcome) || !int(r.captured, 0, NODES_MAX)) return null;
    post.raid = { day: r.day, outcome: r.outcome as (typeof OUTCOMES)[number], captured: r.captured };
  }
  return post;
}

/**
 * The body as text, or null when it is longer than `MAX_BODY` bytes. A declared length over the cap
 * is refused before reading; otherwise the body is read chunk by chunk and dropped as soon as it
 * passes the cap, so a body with no or a false length is never held whole.
 */
async function readBody(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** Records a post in one batch: the player (keeping when they were first seen), the island, and the raid. */
async function record(db: Db, post: IslandPost, now: number) {
  const { player, island, raid } = post;
  const statements = [
    db
      .prepare("INSERT INTO players (id, name, created_at, seen_at) VALUES (?1, ?2, ?3, ?3) ON CONFLICT(id) DO UPDATE SET name = excluded.name, seen_at = excluded.seen_at")
      .bind(player.id, player.name, now),
    db
      .prepare(
        "INSERT INTO island_summaries (player_id, day, held, enemy, rival, factory, strength, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) " +
          "ON CONFLICT(player_id) DO UPDATE SET day = excluded.day, held = excluded.held, enemy = excluded.enemy, rival = excluded.rival, factory = excluded.factory, strength = excluded.strength, updated_at = excluded.updated_at",
      )
      .bind(player.id, island.day, island.held, island.enemy, island.rival, island.factory, island.strength, now),
  ];
  if (raid) statements.push(db.prepare("INSERT INTO raids (player_id, day, outcome, captured, at) VALUES (?1, ?2, ?3, ?4, ?5)").bind(player.id, raid.day, raid.outcome, raid.captured, now));
  await db.batch(statements);
}

/** The answer to a request under /api/, or null for any other path. */
export async function handleApi(request: Request, env: ApiEnv, now = Date.now()): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (pathname === "/api/health") return json(200, { ok: true });
  if (pathname !== "/api" && !pathname.startsWith("/api/")) return null;
  if (pathname !== "/api/island") return fail(404, "not-found");
  if (request.method !== "POST") return new Response(JSON.stringify({ ok: false, error: "method-not-allowed" }), { status: 405, headers: { "content-type": "application/json", allow: "POST" } });
  if (!env.DB) return fail(503, "no-database");
  const text = await readBody(request);
  if (text === null) return fail(413, "too-large");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail(400, "bad-request");
  }
  const post = parseIslandPost(raw);
  if (!post) return fail(400, "bad-request");
  await record(env.DB, post, now);
  return json(200, { ok: true });
}
