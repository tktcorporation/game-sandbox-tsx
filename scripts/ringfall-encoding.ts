/** Offline UTF-8 boundary checks for the D1 API and the real IslandDO.fetch path. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { TextDecoder, TextEncoder } from "node:util";
import { fileURLToPath, URL } from "node:url";
import { handleApi, type ApiEnv, type Db, type DbStatement, type IslandNamespace } from "../worker/api";
import { IslandDO } from "../worker/island-do";
import { defaultName } from "../src/ringfall/meta/identity";

const id = "98810000-0000-4000-8000-000000000001";
const code = "ABC123";
const normal = defaultName(id);
const alreadyMangled = "繝励Ξ繧､繝､繝ｼ-9881";
const at = 1_700_000_000_000;
const url = "https://ringfall.test";

async function decoded(response: Response, expected: string) {
  assert.equal(response.headers.get("content-type")?.split(";")[0], "application/json");
  const bytes = new Uint8Array(await response.arrayBuffer());
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  assert.deepEqual(bytes, new TextEncoder().encode(raw));
  assert.ok(raw.includes(expected), "the response bytes must contain the exact name as UTF-8 JSON");
  return JSON.parse(raw) as Record<string, unknown>;
}

class Statement implements DbStatement {
  private args: (string | number | null)[] = [];
  constructor(private readonly sql: string, private readonly sqlite: DatabaseSync) {}
  bind(...values: unknown[]) {
    this.args = values as (string | number | null)[];
    return this;
  }
  async run() {
    return this.runNow();
  }
  runNow() { return this.sqlite.prepare(this.sql).run(...this.args); }
  async all<T = Record<string, unknown>>() {
    return { results: this.sqlite.prepare(this.sql).all(...this.args) as T[] };
  }
}

const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(fileURLToPath(new URL("../migrations/0001_init.sql", import.meta.url)), "utf8"));
const db: Db = {
  prepare: (sql) => new Statement(sql, sqlite),
  batch: async (statements) => {
    sqlite.exec("BEGIN");
    try {
      for (const statement of statements) (statement as Statement).runNow();
      sqlite.exec("COMMIT");
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
    return statements.map(() => ({ success: true }));
  },
};

async function saveToD1(name: string) {
  const response = await handleApi(new Request(`${url}/api/island`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ player: { id, name }, island: { day: 1, held: 0, enemy: 21, rival: 0, factory: 0, strength: 0 } }),
  }), { DB: db }, at);
  assert.equal(response?.status, 200);
  assert.equal((await decoded(response!, '"ok":true')).ok, true);
  const row = sqlite.prepare("SELECT name FROM players WHERE id = ?").get(id) as { name: string };
  assert.equal(row.name, name, "the SQL row must keep the exact posted name");
}

class MemoryStorage {
  private state: unknown;
  private alarm: number | null = null;
  async get<T>() { return this.state as T | undefined; }
  async put(_key: string, value: unknown) { this.state = structuredClone(value); }
  async getAlarm() { return this.alarm; }
  async setAlarm(at: number) { this.alarm = at; }
  async deleteAlarm() { this.alarm = null; }
  storedOwnerName() { return (this.state as { owner?: { name?: string } } | undefined)?.owner?.name; }
}

const storage = new MemoryStorage();
const state = { storage } as unknown as DurableObjectState;
let object = new IslandDO(state, {});
const islands: IslandNamespace = {
  idFromName: (name) => name,
  get: () => ({ fetch: (request) => object.fetch(request) }),
};
const env: ApiEnv = { ISLAND: islands };

async function claim(name: string) {
  const response = await handleApi(new Request(`${url}/api/islands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ player: { id, name } }),
  }), env, at, () => code);
  assert.equal(response?.status, 201);
  assert.equal((await decoded(response!, `"code":"${code}"`)).code, code);
  assert.equal(storage.storedOwnerName(), name, "IslandDO storage must keep the exact claimed name");
}

async function publicName(name: string) {
  const response = await handleApi(new Request(`${url}/api/islands/${code}`), env, at);
  assert.equal(response?.status, 200);
  assert.equal((await decoded(response!, `"owner":"${name}"`)).owner, name);
}

assert.equal(normal, "プレイヤー-9881");
await saveToD1(normal);
await claim(normal);
object = new IslandDO(state, {}); // The same stored state after a new DO instance loads it.
await publicName(normal);

// A previously mangled name is distinguishable from a decoding error: the server preserves it.
await saveToD1(alreadyMangled);
const report = await handleApi(new Request(`${url}/api/islands/${code}`, {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ player: { id, name: alreadyMangled }, holds: Array(21).fill("foe"), retaken: [], factory: 0, day: 1 }),
}), env, at);
assert.equal(report?.status, 200);
assert.equal(storage.storedOwnerName(), alreadyMangled);
object = new IslandDO(state, {});
await publicName(alreadyMangled);

console.log("encoding boundaries ok: D1 bind, DO storage, public GET UTF-8 bytes");
