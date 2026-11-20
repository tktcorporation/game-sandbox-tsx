/**
 * The server's API (worker/api.ts) on a stand-in database: Node's built-in SQLite behind the part of
 * D1's interface the API uses, with migrations/ applied as wrangler applies them.
 *
 * - **no database**: /api/island answers 202 `no-database`; /api/health still answers.
 * - **no tables**: a database bound before its migrations refuses the write: 503 `db-error`, as JSON.
 * - **record**: a valid post answers 200 and writes the player, the island's summary and the raid.
 * - **again**: a second post with a new name renames the player and keeps when they were first seen;
 *   the summary is replaced and a second raid row is added.
 * - **summary**: a raid settled on a profile with a node of its own and one of another player's builds
 *   a post (`islandPost()`) the API takes, whose numbers add up to the island's node count.
 * - **identity**: a saved identity is read back; one made without storage stays the same for the page; an unreadable one is refused, and an unusable name
 *   falls back to the default.
 * - **refused**: a bad id, a number out of range, a body over the limit, a wrong method and an unknown
 *   path answer 400, 400, 413, 405 and 404, and write nothing.
 *
 * Run alone: `npx tsx scripts/ringfall-server.ts`; it ends with "server ok".
 */
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { handleApi, MAX_BODY, parseIslandPost, type ApiEnv, type Db, type DbStatement } from "../worker/api";
import { NODES } from "../src/ringfall/sim/map";
import { rivalHold } from "../src/ringfall/sim/holds";
import { newRun, starterKit } from "../src/ringfall/sim/state";
import { holds } from "../src/ringfall/meta/island";
import { newProfile, settle, type Profile } from "../src/ringfall/meta/profile";
import { islandPost } from "../src/ringfall/meta/summary";
import { defaultName, loadIdentity, parseIdentity } from "../src/ringfall/meta/identity";
import { parseNeighbours } from "../src/ringfall/meta/neighbours";

/** D1's statement over node:sqlite: bind, then run / first / all. */
class Statement implements DbStatement {
  constructor(
    private db: DatabaseSync,
    private sql: string,
    private values: unknown[] = [],
  ) {}
  bind(...values: unknown[]) {
    return new Statement(this.db, this.sql, values);
  }
  private params() {
    return this.values as (string | number | null)[];
  }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.params());
    return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...this.params()) as T | undefined) ?? null;
  }
  async all<T = Record<string, unknown>>() {
    return { success: true, results: this.db.prepare(this.sql).all(...this.params()) as T[] };
  }
  /** The statement run synchronously, inside a batch's transaction. */
  runNow() {
    this.db.prepare(this.sql).run(...this.params());
  }
}

/** D1's database over node:sqlite; `batch()` runs its statements in one transaction, as D1 does. */
class SqliteD1 implements Db {
  constructor(readonly db: DatabaseSync) {}
  prepare(sql: string) {
    return new Statement(this.db, sql);
  }
  async batch(statements: DbStatement[]) {
    this.db.exec("BEGIN");
    try {
      for (const s of statements) (s as Statement).runNow();
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return statements.map(() => ({ success: true }));
  }
}

const errors: string[] = [];
const check = (ok: boolean, what: string) => {
  if (!ok) errors.push(what);
};

const BASE = "https://ringfall.test";
const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const post = (body: unknown, method = "POST", path = "/api/island") =>
  new Request(BASE + path, method === "GET" || method === "HEAD" ? { method } : { method, headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
const valid = (name: string, day: number) => ({
  player: { id: ID, name },
  island: { day, held: 5, enemy: 14, rival: 2, factory: 1, strength: 1 },
  raid: { day: day - 1, outcome: "extracted", captured: 1 },
});

async function answer(env: ApiEnv, req: Request, now?: number) {
  const res = await handleApi(req, env, now);
  if (!res) return { status: 0, body: null as unknown };
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

// --- no database
{
  const env: ApiEnv = {};
  const a = await answer(env, post(valid("ねこ", 3)));
  console.log(`no database: /api/island ${a.status} ${JSON.stringify(a.body)}`);
  check(a.status === 202 && (a.body as { error?: string }).error === "no-database", "no database: /api/island did not answer 202 no-database");
  const h = await answer(env, post(null, "GET", "/api/health"));
  console.log(`no database: /api/health ${h.status} ${JSON.stringify(h.body)}`);
  check(h.status === 200 && (h.body as { ok?: boolean }).ok === true, "no database: /api/health did not answer ok");
  check((await handleApi(post(null, "GET", "/ringfall/"), env)) === null, "no database: a page path was taken by the API");
}

// --- a database without the tables (bound before the migrations ran): the write is refused as JSON
{
  const bare = new SqliteD1(new DatabaseSync(":memory:"));
  const a = await answer({ DB: bare }, post(valid("ねこ", 3)));
  console.log(`no tables: /api/island ${a.status} ${JSON.stringify(a.body)}`);
  check(a.status === 503 && (a.body as { error?: string }).error === "db-error", "no tables: /api/island did not answer 503 db-error");
}

// --- the Worker brings a database up itself (worker/schema.ts): every migration on a bare one, the
// rest on one whose first tables were made by hand at the SQL console (as Preview's and production's
// were), each recorded once; and its list is the migrations folder's
{
  const dir = new URL("../migrations/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const MIGRATIONS = files.map((name) => ({ name, sql: readFileSync(new URL(name, dir), "utf8") }));
  const listed = [...readFileSync(new URL("../worker/migrations.ts", import.meta.url), "utf8").matchAll(/name: "([^"]+\.sql)"/g)].map((m) => m[1]);
  check(listed.join() === files.join(), `migrations: worker/migrations.ts lists ${listed.join()}, the folder holds ${files.join()}`);
  const tables = (db: DatabaseSync) => (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((r) => r.name).join();
  const recorded = (db: DatabaseSync) => (db.prepare("SELECT name FROM schema_migrations ORDER BY name").all() as { name: string }[]).map((r) => r.name).join();
  const bare = new DatabaseSync(":memory:");
  const a = await answer({ DB: new SqliteD1(bare), MIGRATIONS }, post(valid("ねこ", 3)));
  console.log(`migrations: a bare database -> ${a.status}; tables ${tables(bare)}; recorded ${recorded(bare)}`);
  check(a.status === 200, `migrations: a bare database answered ${a.status}, not 200`);
  check(recorded(bare) === files.join(), "migrations: a bare database did not record every migration");
  const byHand = new DatabaseSync(":memory:");
  byHand.exec(readFileSync(new URL(files[0], dir), "utf8").replaceAll("IF NOT EXISTS ", ""));
  const b = await answer({ DB: new SqliteD1(byHand), MIGRATIONS }, post(valid("ねこ", 3)));
  console.log(`migrations: ${files[0]} made by hand -> ${b.status}; tables ${tables(byHand)}; recorded ${recorded(byHand)}`);
  check(b.status === 200 && tables(byHand).includes("islands") && recorded(byHand) === files.join(), "migrations: a database whose first tables were made by hand was not brought up to the rest");
  const again = new SqliteD1(byHand);
  const c = await answer({ DB: again, MIGRATIONS }, post(valid("ねこ", 4)));
  check(c.status === 200 && recorded(byHand) === files.join(), "migrations: a second isolate applying them again failed or recorded twice");
}

// --- a database with the migrations applied in order
const sqlite = new DatabaseSync(":memory:");
sqlite.exec("PRAGMA foreign_keys = ON");
const dir = new URL("../migrations/", import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
for (const f of files) sqlite.exec(readFileSync(new URL(f, dir), "utf8"));
console.log(`migrations: ${files.join(", ")}`);
const env: ApiEnv = { DB: new SqliteD1(sqlite) };
const rows = (sql: string) => sqlite.prepare(sql).all() as Record<string, unknown>[];
const count = (table: string) => Number((sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);

// --- record
{
  const a = await answer(env, post(valid("  ねこ  ", 3)), 1000);
  const players = rows("SELECT * FROM players");
  const summary = rows("SELECT * FROM island_summaries");
  const raids = rows("SELECT * FROM raids");
  console.log(`record: ${a.status} ${JSON.stringify(a.body)}; players ${JSON.stringify(players)}; summary ${JSON.stringify(summary)}; raids ${JSON.stringify(raids)}`);
  check(a.status === 200 && (a.body as { ok?: boolean }).ok === true, "record: a valid post did not answer 200 ok");
  check(players.length === 1 && players[0].name === "ねこ" && players[0].created_at === 1000 && players[0].seen_at === 1000, "record: the player row is not as posted (name trimmed, both times now)");
  check(summary.length === 1 && summary[0].day === 3 && summary[0].held === 5 && summary[0].enemy === 14 && summary[0].rival === 2 && summary[0].factory === 1 && summary[0].strength === 1, "record: the summary row is not as posted");
  check(raids.length === 1 && raids[0].day === 2 && raids[0].outcome === "extracted" && raids[0].captured === 1 && raids[0].at === 1000, "record: the raid row is not as posted");
}

// --- again
{
  const body = valid("いぬ", 4);
  body.island.held = 6;
  const noRaid: Record<string, unknown> = { player: body.player, island: body.island };
  const a = await answer(env, post(body), 2000);
  const b = await answer(env, post(noRaid), 3000);
  const p = rows("SELECT * FROM players")[0];
  const summary = rows("SELECT * FROM island_summaries");
  console.log(`again: ${a.status}, ${b.status} without a raid; player ${JSON.stringify(p)}; summary ${JSON.stringify(summary)}; raids ${count("raids")}`);
  check(a.status === 200 && b.status === 200, "again: a second post did not answer 200");
  check(p.name === "いぬ" && p.created_at === 1000 && p.seen_at === 3000, "again: the rename did not keep created_at or move seen_at");
  check(summary.length === 1 && summary[0].day === 4 && summary[0].held === 6 && summary[0].updated_at === 3000, "again: the summary was not replaced");
  check(count("raids") === 2, "again: the raids are not one row a raid");
}

// --- summary: the supply depot the player's, the relay another player's, the quarry's core captured in the raid
{
  const id = "7c9e6679-7425-40de-944b-e07fc1f0d3c4";
  const base = newProfile(1);
  const p: Profile = { ...base, poiState: { ...base.poiState, supply: { state: "freed" }, relay: { state: rivalHold("rival-1") } } };
  const s = newRun(5, starterKit(), "reservoir", { island: holds(p) });
  s.stats.captured = ["quarry"];
  s.outcome = "extracted";
  const settled = settle(p, s);
  const body = islandPost({ id, name: defaultName(id) }, settled, s);
  const a = await answer(env, post(body), 4000);
  const row = rows(`SELECT * FROM island_summaries WHERE player_id = '${id}'`)[0] ?? {};
  const raid = rows(`SELECT * FROM raids WHERE player_id = '${id}'`)[0] ?? {};
  const i = body.island;
  console.log(`summary: ${JSON.stringify(body)} -> ${a.status}; row ${JSON.stringify(row)}`);
  check(parseIslandPost(JSON.parse(JSON.stringify(body))) !== null, "summary: the API's parser refuses a settled raid's summary");
  check(a.status === 200, `summary: a settled raid's summary answered ${a.status}`);
  check(i.held + i.enemy + i.rival === NODES.length, `summary: held ${i.held} + enemy ${i.enemy} + rival ${i.rival} is not the ${NODES.length} nodes`);
  check(i.held >= 1 && i.day === settled.profile.day && body.raid.day === settled.day && body.raid.captured === 1, "summary: the summary's numbers are not the settled profile's");
  check(row.held === i.held && row.enemy === i.enemy && row.rival === i.rival && row.strength === i.strength && row.factory === i.factory && raid.captured === 1 && raid.outcome === "extracted", "summary: the rows are not the posted summary");
}

// --- identity
{
  const id = "7c9e6679-7425-40de-944b-e07fc1f0d3c4";
  const read = parseIdentity({ id, name: " ねこ " });
  const noName = parseIdentity({ id, name: "あ".repeat(25) });
  console.log(`identity: ${JSON.stringify(read)}, ${JSON.stringify(noName)}, bad id ${JSON.stringify(parseIdentity({ id: "x", name: "a" }))}`);
  check(read?.id === id && read.name === "ねこ", "identity: a saved identity was not read back");
  check(noName?.name === defaultName(id) && defaultName(id) === "プレイヤー-7c9e", "identity: an unusable name did not fall back to the default");
  check(parseIdentity({ id: "x", name: "a" }) === null && parseIdentity(null) === null, "identity: an unreadable identity was taken");
  // Node has no localStorage: every read and write throws, as in a browser with storage blocked.
  const first = loadIdentity();
  const again = loadIdentity();
  console.log(`identity without storage: ${first.id === again.id ? "kept for the page" : "changed"}`);
  check(first.id === again.id && first.name === defaultName(first.id), "identity: without storage the id changed between raids");
}

// --- refused
{
  const before = [count("players"), count("island_summaries"), count("raids")].join("/");
  const cases: [string, Request, number][] = [];
  const badId = valid("ねこ", 5);
  badId.player.id = "not-a-uuid";
  cases.push(["bad id", post(badId), 400]);
  const range = valid("ねこ", 5);
  range.island.held = 65;
  cases.push(["held out of range", post(range), 400]);
  const frac = valid("ねこ", 5);
  frac.island.factory = 1.5;
  cases.push(["factory not whole", post(frac), 400]);
  const outcome = valid("ねこ", 5);
  (outcome.raid as { outcome: string }).outcome = "won";
  cases.push(["unknown outcome", post(outcome), 400]);
  cases.push(["empty name", post(valid("   ", 5)), 400]);
  cases.push(["long name", post(valid("あ".repeat(25), 5)), 400]);
  cases.push(["not json", post("{"), 400]);
  const big = valid("ねこ", 5) as Record<string, unknown>;
  big.pad = "x".repeat(MAX_BODY);
  cases.push(["oversized", post(big), 413]);
  // Streamed in chunks with no Content-Length, past the cap: refused once the cap is passed.
  const chunk = new TextEncoder().encode("x".repeat(1500));
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (pulled++ < 8) c.enqueue(chunk);
      else c.close();
    },
  });
  const streamed = new Request(BASE + "/api/island", { method: "POST", headers: { "content-type": "application/json" }, body: stream, duplex: "half" } as RequestInit);
  check(streamed.headers.get("content-length") === null, "refused: the streamed request carries a Content-Length");
  cases.push(["streamed oversized, no Content-Length", streamed, 413]);
  cases.push(["GET", post(null, "GET"), 405]);
  cases.push(["unknown path", post(valid("ねこ", 5), "POST", "/api/islandz"), 404]);
  cases.push(["unknown path GET", post(null, "GET", "/api/nothing"), 404]);
  for (const [what, req, want] of cases) {
    const a = await answer(env, req);
    console.log(`refused: ${what} -> ${a.status} ${JSON.stringify(a.body)}`);
    check(a.status === want && (a.body as { ok?: boolean }).ok === false, `refused: ${what} answered ${a.status}, not ${want}`);
  }
  const after = [count("players"), count("island_summaries"), count("raids")].join("/");
  console.log(`refused: rows ${before} -> ${after}; streamed chunks pulled ${pulled} of 8`);
  check(pulled < 8, "refused: the streamed body was read past the cap");
  check(before === after, "refused: a refused post wrote rows");
}

// --- neighbours: islands whose owners played lately, nearest in nodes held, the same all week
{
  const DAY = 24 * 3600 * 1000;
  const T = 1_800_000_000_000;
  const ids = Array.from({ length: 9 }, (_, k) => `0f8fad5b-d9cb-469f-a165-${String(700000000000 + k).padStart(12, "0")}`);
  const held = [5, 4, 6, 5, 9, 1, 5, 5, 6];
  for (const [k, id] of ids.entries()) {
    const at = k === 8 ? T - 20 * DAY : T - DAY;
    const r = await answer(env, post({ player: { id, name: `島${k}` }, island: { day: 3, held: held[k], enemy: 21 - held[k], rival: 0, factory: 1, strength: 1 } }), at);
    check(r.status === 200, `neighbours: the summary of island ${k} was not taken`);
    sqlite.prepare("INSERT INTO islands (code, player_id, created_at) VALUES (?1, ?2, ?3)").run(`AB${String(k).padStart(4, "0")}`, id, at);
  }
  // One neighbour's owner has played a raid since: it shows as their last.
  sqlite.prepare("INSERT INTO raids (player_id, day, outcome, captured, at) VALUES (?1, 3, 'extracted', 2, ?2)").run(ids[3], T - 3600_000);
  const ask = (id: string | null, now = T, method = "GET") => answer(env, new Request(BASE + "/api/neighbours", { method, headers: id ? { authorization: `Bearer ${id}` } : {} }), now);
  const a = await ask(ids[0]);
  const list = (a.body as { neighbours?: { code: string; name: string; held: number; total: number }[] }).neighbours ?? [];
  console.log(`neighbours: ${a.status} ${list.map((n) => `${n.code} ${n.name} ${n.held}/${n.total}`).join(", ")}`);
  check(a.status === 200 && list.length === 4, `neighbours: the owner was offered ${list.length}, not 4`);
  check(!list.some((n) => n.code === "AB0000"), "neighbours: the owner's own island was offered");
  check(!list.some((n) => n.code === "AB0008"), "neighbours: an island not played for 20 days was offered");
  check(!list.some((n) => n.code === "AB0004" || n.code === "AB0005"), "neighbours: an island far from the owner's in nodes held was offered over nearer ones");
  check(list.every((n) => n.total === 21), "neighbours: an island's node count is not its summary's");
  check(parseNeighbours(a.body)?.length === 4, "neighbours: the browser does not read the server's answer back");
  // Each neighbour carries what its owner did last: the island summaries were posted without a raid, so none yet.
  const lasts = parseNeighbours(a.body)!.map((n) => [n.code, n.last] as const);
  console.log(`neighbours: last raids ${JSON.stringify(lasts)}`);
  check(lasts.every(([c, l]) => (c === "AB0003" ? l?.captured === 2 && l.home : l === undefined)), "neighbours: a neighbour's last raid is not the one its owner played");
  check(parseNeighbours({ neighbours: [{ code: "bad", name: "x", held: 1, total: 21, day: 1 }] })?.length === 0, "neighbours: the browser took a neighbour with a bad code");
  // The browser keeps the list it read and reads it back as it was, the last raids included.
  const kept = parseNeighbours(a.body)!;
  check(JSON.stringify(parseNeighbours({ neighbours: kept })) === JSON.stringify(kept), "neighbours: the browser's kept list does not read back as it was");
  const again = await ask(ids[0], T + DAY);
  check(JSON.stringify(again.body) === JSON.stringify(a.body), "neighbours: the list changed within the week");
  check(list.every((n, k) => (n as { slot?: number }).slot === k), "neighbours: the picks do not carry their slots at sea in order");
  // A picked neighbour takes many nodes mid-week: the week's picks and their slots stay as drawn.
  const moved = list[1].code;
  const owner = ids[Number(moved.slice(2))];
  await answer(env, post({ player: { id: owner, name: "島" }, island: { day: 4, held: 18, enemy: 3, rival: 0, factory: 1, strength: 2 } }), T + DAY);
  const later = await ask(ids[0], T + 2 * DAY);
  const slots = (b: unknown) => ((b as { neighbours?: { code: string; slot: number }[] }).neighbours ?? []).map((n) => `${n.slot}:${n.code}`).join();
  console.log(`neighbours: after ${moved} took nodes: ${slots(later.body)}`);
  check(slots(later.body) === slots(a.body), "neighbours: a neighbour taking nodes mid-week changed the week's picks or their slots");
  check(((later.body as { neighbours?: { code: string; held: number }[] }).neighbours ?? []).find((n) => n.code === moved)?.held === 18, "neighbours: a kept neighbour's nodes are not read live");
  const none = await ask("0f8fad5b-d9cb-469f-a165-999999999999");
  check(none.status === 200 && ((none.body as { neighbours?: unknown[] }).neighbours ?? [1]).length === 0, "neighbours: a player with no island was offered some");
  const anon = await ask(null);
  check(anon.status === 401, `neighbours: a request without the owner's id answered ${anon.status}, not 401`);
  const put = await ask(ids[0], T, "POST");
  check(put.status === 405, `neighbours: a POST answered ${put.status}, not 405`);
  const bare = await answer({}, new Request(BASE + "/api/neighbours", { headers: { authorization: `Bearer ${ids[0]}` } }));
  check(bare.status === 202, `neighbours: no database answered ${bare.status}, not 202`);
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("server ok");
