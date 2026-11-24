import { FACTORY_TOP } from "../src/ringfall/sim/config";
import { newIslandCode, parseIslandCode } from "../src/ringfall/meta/island-code";
import { parseHolds, parseLent, parseParcels, parseRetaken, parseTakenParcels, squadKinds, type IslandOp } from "./island";
import type { ApiError } from "../src/ringfall/meta/island-errors";
import { ensureSchema, type Migration } from "./schema";
import { NEIGHBOUR_SLOTS } from "../src/ringfall/meta/neighbours";

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
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
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
  /** The migrations the Worker brings the database up to before it is used (worker/schema.ts); absent, the schema is left as it is. */
  MIGRATIONS?: readonly Migration[];
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

/**
 * 202 Accepted response for optional Worker bindings (D1 DB or ISLAND DO) that are not yet bound.
 * Returns `{ ok: false, error }` with HTTP 202 so clients can skip gracefully without error logging.
 */
const unbound = (error: "no-database" | "no-island-server") => json(202, { ok: false, error });

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
async function claimIsland(request: Request, env: ApiEnv, ns: IslandNamespace, now: number, draw: () => string): Promise<Response> {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const player = isObj(body.raw) ? parsePlayer(body.raw.player) : null;
  if (!player) return fail(400, "bad-request");
  for (let k = 0; k < CLAIM_TRIES; k++) {
    const code = draw();
    const r = await ask(ns, code, { t: "claim", player, code }, now);
    if (r.status === 201) await ownCode(env, code, player.id, now);
    if (r.status !== 409) return r;
  }
  return fail(503, "no-free-code");
}

/**
 * Records that `player` owns island `code`, for the neighbours' list. Only the server calls it, on
 * a claim it made and on a report the island took from its owner, so no client can name a code as
 * theirs. Without the database, or before its migration ran, nothing is kept and nothing fails.
 */
async function ownCode(env: ApiEnv, code: string, player: string, now: number) {
  try {
    await env.DB?.prepare("INSERT INTO islands (code, player_id, created_at) VALUES (?1, ?2, ?3) ON CONFLICT(code) DO UPDATE SET player_id = excluded.player_id").bind(code, player, now).run();
  } catch {
    // The table is not there yet (docs/ringfall/infrastructure.md): the neighbours' list stays empty.
  }
}

/**
 * Whether the island `code` is one of `player`'s neighbours this week whose sea route is shut: its
 * slot's coastal node (`NEIGHBOUR_SLOTS[].shore`) not among the nodes the sender holds. An island
 * that is no neighbour of theirs (named by its code: a friend's, an attacker's answered) is open,
 * as is any when the database cannot be read.
 */
async function isNeighbourRouteShut(env: ApiEnv, player: string, code: string, held: readonly string[], now: number): Promise<boolean> {
  try {
    const pick = (await env.DB?.prepare("SELECT slot FROM neighbour_picks WHERE player_id = ?1 AND week = ?2 AND code = ?3").bind(player, Math.floor(now / NEIGHBOURS.weekMs), code).all<{ slot: number }>())?.results[0];
    const shore = pick ? NEIGHBOUR_SLOTS[pick.slot]?.shore : undefined;
    return !!shore && !held.includes(shore);
  } catch {
    return false;
  }
}

/** How many neighbours an island is offered, and how long a set of them lasts before it is drawn again. */
export const NEIGHBOURS = { count: 4, pool: 24, weekMs: 7 * 24 * 3600 * 1000, activeMs: 14 * 24 * 3600 * 1000 } as const;

/** A neighbour as the owner's camp shows it: whose island, its code, how far its owner has come, and what they did last. */
export interface Neighbour {
  code: string;
  name: string;
  held: number;
  total: number;
  day: number;
  /** When its owner last settled a raid (epoch ms). */
  seen: number;
  /** That raid's cores captured and how it ended; null with no raid recorded. */
  captured: number | null;
  outcome: string | null;
  /** The slot at sea it stands in for the week (NEIGHBOUR_SLOTS), which sets the sea route to it. */
  slot?: number;
}

const mix32 = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

/**
 * The owner's neighbours (`GET /api/neighbours`, the owner's id in the header): islands whose owners
 * played in the last two weeks, nearest in nodes held to the owner's, a few of the nearest drawn by
 * a hash of the owner, the island and the week. The draw is kept for the week, each pick in its slot
 * at sea (`neighbour_picks`), so nodes changing hands in the week neither swap a neighbour nor move
 * one onto another sea route; what is shown of each (nodes held, its last raid) is read live.
 */
async function neighbours(env: ApiEnv, player: string, now: number): Promise<Response> {
  const db = env.DB;
  if (!db) return unbound("no-database");
  try {
    const mine = (await db.prepare("SELECT i.code AS code, s.held AS held FROM islands i LEFT JOIN island_summaries s ON s.player_id = i.player_id WHERE i.player_id = ?1").bind(player).all<{ code: string; held: number | null }>()).results[0];
    if (!mine) return json(200, { ok: true, neighbours: [] });
    const week = Math.floor(now / NEIGHBOURS.weekMs);
    const kept = async () => (await db.prepare("SELECT slot, code FROM neighbour_picks WHERE player_id = ?1 AND week = ?2 ORDER BY slot").bind(player, week).all<{ slot: number; code: string }>()).results;
    let picks = await kept();
    if (!picks.length) {
      // The week's draw: nearness in nodes held first; the week's hash shuffles only islands within a couple of nodes of each other.
      const held = mine.held ?? 0;
      const rows = (
        await db
          .prepare(
            "SELECT i.code AS code, s.held AS held FROM islands i JOIN players p ON p.id = i.player_id JOIN island_summaries s ON s.player_id = i.player_id " +
              "WHERE i.player_id != ?1 AND s.updated_at > ?2 ORDER BY abs(s.held - ?3), s.updated_at DESC LIMIT ?4",
          )
          .bind(player, now - NEIGHBOURS.activeMs, held, NEIGHBOURS.pool)
          .all<{ code: string; held: number }>()
      ).results;
      const drawn = rows
        .map((r) => ({ r, key: Math.abs(r.held - held) + ((mix32(`${mine.code}:${r.code}:${week}`) % 1000) / 1000) * 2 }))
        .sort((a, b) => a.key - b.key)
        .slice(0, NEIGHBOURS.count);
      // Kept for the week (a draw that raced another keeps the first), and last weeks' let go.
      await db.batch([
        db.prepare("DELETE FROM neighbour_picks WHERE player_id = ?1 AND week < ?2").bind(player, week),
        ...drawn.map(({ r }, slot) => db.prepare("INSERT OR IGNORE INTO neighbour_picks (player_id, week, slot, code) VALUES (?1, ?2, ?3, ?4)").bind(player, week, slot, r.code)),
      ]);
      picks = await kept();
    }
    if (!picks.length) return json(200, { ok: true, neighbours: [] });
    // Each pick as it stands now: whose island, how much of it they hold, what they did last.
    const live = (
      await db
        .prepare(
          "SELECT i.code AS code, p.name AS name, s.held AS held, s.held + s.enemy + s.rival AS total, s.day AS day, s.updated_at AS seen, " +
            "(SELECT r.captured FROM raids r WHERE r.player_id = i.player_id ORDER BY r.at DESC LIMIT 1) AS captured, " +
            "(SELECT r.outcome FROM raids r WHERE r.player_id = i.player_id ORDER BY r.at DESC LIMIT 1) AS outcome " +
            `FROM islands i JOIN players p ON p.id = i.player_id JOIN island_summaries s ON s.player_id = i.player_id WHERE i.code IN (${picks.map((_, k) => `?${k + 1}`).join(", ")})`,
        )
        .bind(...picks.map((q) => q.code))
        .all<Neighbour>()
    ).results;
    const byCode = new Map(live.map((r) => [r.code, r]));
    const out = picks.flatMap((q) => {
      const r = byCode.get(q.code);
      return r ? [{ ...r, slot: q.slot }] : [];
    });
    return json(200, { ok: true, neighbours: out });
  } catch {
    return json(200, { ok: true, neighbours: [] });
  }
}

/**
 * /api/islands (a claim) and /api/islands/:code and below (docs/ringfall/multiplayer.md, 遠征): the owner's report (PUT), the
 * island as anyone sees it (GET), the owner's log (GET …/log), the owner's raid taking the
 * expeditions in (POST …/lease), an expedition to it (POST …/expeditions), an X2 assault result
 * (POST …/assault), and its sender calling it home (DELETE …/expeditions/<n>).
 */
async function handleIslands(request: Request, env: ApiEnv, now: number, url: URL, draw: () => string): Promise<Response> {
  if (url.pathname === "/api/islands") {
    if (request.method !== "POST") return notAllowed("POST");
    return env.ISLAND ? claimIsland(request, env, env.ISLAND, now, draw) : unbound("no-island-server");
  }
  const parts = url.pathname.split("/").slice(3);
  const code = parseIslandCode(parts[0]);
  // …/expeditions/<n> names one expedition by the number the island gave it (a recall).
  const recalledExpeditionId = parts.length === 3 && parts[1] === "expeditions" && /^[1-9]\d{0,8}$/.test(parts[2]) ? Number(parts[2]) : null;
  const sub = recalledExpeditionId !== null ? "expedition" : parts.slice(1).join("/");
  if (!code || (sub !== "" && sub !== "log" && sub !== "lease" && sub !== "expeditions" && sub !== "expedition" && sub !== "pings" && sub !== "aid" && sub !== "assault")) return fail(404, "not-found");
  const method = request.method;
  const allow =
    sub === ""
      ? "GET, PUT"
      : sub === "log"
        ? "GET"
        : sub === "expedition"
          ? "DELETE"
          : sub === "lease"
            ? "POST, DELETE"
            : "POST";
  if (!allow.split(", ").includes(method)) return notAllowed(allow);
  const ns = env.ISLAND;
  if (!ns) return unbound("no-island-server");
  if (sub === "" && method === "GET") return ask(ns, code, { t: "view" }, now);
  if (sub === "log" || sub === "lease" || sub === "pings") {
    // The owner's secret id goes in a header, never in the URL, where logs and histories keep it.
    const player = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
    if (!UUID.test(player)) return fail(401, "unauthorized");
    // A raid of the owner's takes the island's expeditions in.
    if (sub === "lease") return ask(ns, code, { t: method === "DELETE" ? "releaseLease" : "lease", player }, now);
    if (sub === "pings") {
      const body = await readJson(request);
      if (body instanceof Response) return body;
      const raw = body.raw;
      if (!isObj(raw) || typeof raw.name !== "string" || !Number.isFinite(raw.x) || !Number.isFinite(raw.z)) return fail(400, "bad-request");
      return ask(ns, code, { t: "ping", player, name: raw.name.slice(0, 32), x: Number(raw.x), z: Number(raw.z) }, now);
    }
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
    const lent = parseLent(raw.lent);
    const parcels = parseParcels(raw.parcels);
    const takenParcels = parseTakenParcels(raw.takenParcels);
    if (!player || !holds || !retaken || !lent || !parcels || !takenParcels || !int(raw.factory, 0, FACTORY_TOP) || !int(raw.day, 0, DAY_MAX)) return fail(400, "bad-request");
    const r = await ask(ns, code, { t: "report", player, holds, retaken, factory: raw.factory, day: raw.day, lent, parcels, takenParcels }, now);
    if (r.status === 200) await ownCode(env, code, player.id, now);
    return r;
  }
  // Aid or an expedition: the sender proves their own island with their id.
  const from = parsePlayer(raw.from);
  const fromCode = isObj(raw.from) ? parseIslandCode(raw.from.code) : null;
  if (!from || !fromCode) return fail(400, "bad-request");
  if (fromCode === code) return fail(403, "own-island");
  const who = await ask(ns, fromCode, { t: "whois", player: from.id }, now);
  if (who.status === 404) return fail(403, "no-own-island");
  if (who.status !== 200) return who.status === 403 ? fail(403, "not-owner") : who;
  // The name others see is the one the sender's island keeps, not one the request names.
  const { factory, name, held, attackers } = (await who.json()) as { factory: number; name: string; held?: string[]; attackers?: string[] };
  // A recall: the sender, shown to own the island the expedition came from, calls it home.
  if (recalledExpeditionId !== null) return ask(ns, code, { t: "recall", from: fromCode, id: recalledExpeditionId }, now);
  // Aid donation (ux-design C2): a valuable left at a depot on the target island for offline defence.
  if (sub === "aid") {
    if (typeof raw.kind !== "string" || !raw.kind || typeof raw.poi !== "string") return fail(400, "bad-request");
    if (!attackers?.includes(code) && (await isNeighbourRouteShut(env, from.id, code, held ?? [], now))) return fail(403, "route-shut");
    return ask(ns, code, { t: "aid", from: { code: fromCode, name }, poi: raw.poi, kind: raw.kind }, now);
  }
  // X2 short-raid result (game-design-review §5.8): after the notice, the attacker reports win/loss.
  if (sub === "assault") {
    if (!int(raw.id, 1, 1e9) || typeof raw.won !== "boolean") return fail(400, "bad-request");
    return ask(ns, code, { t: "assault", from: fromCode, id: raw.id, won: raw.won }, now);
  }
  if (typeof raw.target !== "string" || !int(raw.units, 1, 64)) return fail(400, "bad-request");
  // A neighbour of the sender's this week is reached only by its sea route (the sender holds the node
  // facing it), unless it attacked the sender's island lately: an attack is answered by any way (仕返し).
  if (!attackers?.includes(code) && (await isNeighbourRouteShut(env, from.id, code, held ?? [], now))) return fail(403, "route-shut");
  const kinds = squadKinds(factory);
  if (raw.units > kinds.length) return fail(400, "too-many-units");
  const x2 = raw.x2 === true;
  return ask(ns, code, { t: "expedition", from: { code: fromCode, name }, target: raw.target, kinds: kinds.slice(0, raw.units), ...(x2 ? { x2: true as const } : {}) }, now);
}

/** The answer to a request under /api/, or null for any other path. */
export async function handleApi(request: Request, env: ApiEnv, now = Date.now(), draw: () => string = () => newIslandCode()): Promise<Response | null> {
  const url = new URL(request.url);
  const { pathname } = url;
  if (pathname === "/api/health") return json(200, { ok: true });
  if (pathname !== "/api" && !pathname.startsWith("/api/")) return null;
  // The database brought up to the migrations before anything reads or writes it: a merge that
  // adds one applies it on the deploy's first request. A failure leaves the tables as they were,
  // and the routes below answer as they do without them.
  if (env.DB && env.MIGRATIONS)
    try {
      await ensureSchema(env.DB, env.MIGRATIONS);
    } catch {
      // Tried again on the next request.
    }
  if (pathname === "/api/islands" || pathname.startsWith("/api/islands/")) return handleIslands(request, env, now, url, draw);
  if (pathname === "/api/neighbours") {
    if (request.method !== "GET") return notAllowed("GET");
    const player = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
    if (!UUID.test(player)) return fail(401, "unauthorized");
    return neighbours(env, player, now);
  }
  if (pathname !== "/api/island") return fail(404, "not-found");
  if (request.method !== "POST") return notAllowed("POST");
  if (!env.DB) return unbound("no-database");
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
