import { FACTORY_TOP } from "../src/ringfall/sim/config";
import { newIslandCode, parseIslandCode } from "../src/ringfall/meta/island-code";
import { parseHolds, parseRetaken, squadKinds, type IslandOp } from "./island";
import type { ApiError } from "../src/ringfall/meta/island-errors";

/*
 * RINGFALL's API under /api/ (docs/ringfall/multiplayer.md, サーバー). A plain handler of a request
 * and the Worker's bindings, so that scripts/ringfall-server.ts and scripts/ringfall-expeditions.ts
 * can run it on stand-ins.
 *
 * The bindings are optional: until a database is connected (the steps are in the doc), a valid
 * request to /api/island answers 202 `no-database` (a success, so the browser logs nothing) and the
 * game plays as ever; a write the database refuses answers 503 `db-error`. Likewise a request to
 * /api/islands/ answers 202 `no-island-server` without the `ISLAND` Durable Object binding.
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

/** The part of a Durable Object stub the API uses. */
export interface IslandStub {
  fetch(request: Request): Promise<Response>;
}

/** The part of a Durable Object namespace the API uses: `DurableObjectNamespace` satisfies it. */
export interface IslandNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): IslandStub;
}

export interface ApiEnv {
  DB?: Db;
  /** The islands: one IslandDO (worker/island-do.ts) for each, by its code; absent until bound. */
  ISLAND?: IslandNamespace;
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
const fail = (status: number, error: ApiError) => json(status, { ok: false, error });

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

const notAllowed = (allow: string) => new Response(JSON.stringify({ ok: false, error: "method-not-allowed" satisfies ApiError }), { status: 405, headers: { "content-type": "application/json", allow } });

/** The body as JSON; a Response for a body over the cap (413) or not JSON (400). */
async function readJson(request: Request): Promise<{ raw: unknown } | Response> {
  const text = await readBody(request);
  if (text === null) return fail(413, "too-large");
  try {
    return { raw: JSON.parse(text) };
  } catch {
    return fail(400, "bad-request");
  }
}

/** A player as a request names them: their secret id and a name of 1 to 24 characters, trimmed. */
function parsePlayer(raw: unknown): { id: string; name: string } | null {
  if (!isObj(raw)) return null;
  const { id, name } = raw;
  if (typeof id !== "string" || !UUID.test(id) || typeof name !== "string") return null;
  const trimmed = name.trim();
  const chars = [...trimmed].length;
  return chars >= 1 && chars <= 24 ? { id, name: trimmed } : null;
}

/** Op `op` of island `code`, answered by its Durable Object at `now`. */
async function ask(ns: IslandNamespace, code: string, op: IslandOp, now: number): Promise<Response> {
  try {
    return await ns.get(ns.idFromName(code)).fetch(new Request("https://island/op", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op, now }) }));
  } catch {
    return fail(503, "island-error");
  }
}

/** Codes drawn for one claim before it gives up: with 32^6 codes, a collision is rare and several in a row mean something is wrong. */
export const CLAIM_TRIES = 8;

/**
 * A claim (`POST /api/islands`): the server draws a code and asks that island's object to take
 * the player as its owner, drawing again while the code is someone's. A client never names the code
 * of the island it claims, so nobody can claim another's.
 */
async function claimIsland(request: Request, ns: IslandNamespace, now: number, draw: () => string): Promise<Response> {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const player = isObj(body.raw) ? parsePlayer(body.raw.player) : null;
  if (!player) return fail(400, "bad-request");
  for (let k = 0; k < CLAIM_TRIES; k++) {
    const code = draw();
    const r = await ask(ns, code, { t: "claim", player, code }, now);
    if (r.status !== 409) return r;
  }
  return fail(503, "no-free-code");
}

/**
 * /api/islands (a claim) and /api/islands/:code and below (docs/ringfall/multiplayer.md, 遠征): the owner's report (PUT), the
 * island as anyone sees it (GET), the owner's log (GET …/log) and an expedition to it (POST
 * …/expeditions).
 */
async function handleIslands(request: Request, env: ApiEnv, now: number, url: URL, draw: () => string): Promise<Response> {
  if (url.pathname === "/api/islands") {
    if (request.method !== "POST") return notAllowed("POST");
    return env.ISLAND ? claimIsland(request, env.ISLAND, now, draw) : fail(202, "no-island-server");
  }
  const parts = url.pathname.split("/").slice(3);
  const code = parseIslandCode(parts[0]);
  const sub = parts.slice(1).join("/");
  if (!code || (sub !== "" && sub !== "log" && sub !== "expeditions")) return fail(404, "not-found");
  const method = request.method;
  const allow = sub === "" ? "GET, PUT" : sub === "log" ? "GET" : "POST";
  if (!allow.split(", ").includes(method)) return notAllowed(allow);
  const ns = env.ISLAND;
  if (!ns) return fail(202, "no-island-server");
  if (sub === "" && method === "GET") return ask(ns, code, { t: "view" }, now);
  if (sub === "log") {
    // The owner's secret id goes in a header, never in the URL, where logs and histories keep it.
    const player = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
    if (!UUID.test(player)) return fail(401, "unauthorized");
    const after = Number(url.searchParams.get("after") ?? 0);
    if (!int(after, 0, Number.MAX_SAFE_INTEGER)) return fail(400, "bad-request");
    return ask(ns, code, { t: "log", player, after }, now);
  }
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const raw = body.raw;
  if (!isObj(raw)) return fail(400, "bad-request");
  if (sub === "") {
    const player = parsePlayer(raw.player);
    const holds = parseHolds(raw.holds);
    const retaken = parseRetaken(raw.retaken);
    if (!player || !holds || !retaken || !int(raw.factory, 0, FACTORY_TOP) || !int(raw.day, 0, DAY_MAX)) return fail(400, "bad-request");
    return ask(ns, code, { t: "report", player, holds, retaken, factory: raw.factory, day: raw.day }, now);
  }
  // An expedition: the sender proves their own island with their id, whose factory sets the squad they may send.
  const from = parsePlayer(raw.from);
  const fromCode = isObj(raw.from) ? parseIslandCode(raw.from.code) : null;
  if (!from || !fromCode || typeof raw.target !== "string" || !int(raw.units, 1, 64)) return fail(400, "bad-request");
  if (fromCode === code) return fail(403, "own-island");
  const who = await ask(ns, fromCode, { t: "whois", player: from.id }, now);
  if (who.status === 404) return fail(403, "no-own-island");
  if (who.status !== 200) return who.status === 403 ? fail(403, "not-owner") : who;
  // The name others see is the one the sender's island keeps, not one the request names.
  const { factory, name } = (await who.json()) as { factory: number; name: string };
  const kinds = squadKinds(factory);
  if (raw.units > kinds.length) return fail(400, "too-many-units");
  return ask(ns, code, { t: "expedition", from: { code: fromCode, name }, target: raw.target, kinds: kinds.slice(0, raw.units) }, now);
}

/** The answer to a request under /api/, or null for any other path. */
export async function handleApi(request: Request, env: ApiEnv, now = Date.now(), draw: () => string = () => newIslandCode()): Promise<Response | null> {
  const url = new URL(request.url);
  const { pathname } = url;
  if (pathname === "/api/health") return json(200, { ok: true });
  if (pathname !== "/api" && !pathname.startsWith("/api/")) return null;
  if (pathname === "/api/islands" || pathname.startsWith("/api/islands/")) return handleIslands(request, env, now, url, draw);
  if (pathname !== "/api/island") return fail(404, "not-found");
  if (request.method !== "POST") return notAllowed("POST");
  if (!env.DB) return fail(202, "no-database");
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const post = parseIslandPost(body.raw);
  if (!post) return fail(400, "bad-request");
  try {
    await record(env.DB, post, now);
  } catch {
    return fail(503, "db-error");
  }
  return json(200, { ok: true });
}
