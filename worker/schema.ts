import type { Db } from "./api";

/*
 * The database's schema kept up by the Worker itself (docs/ringfall/infrastructure.md, D1 schema):
 * the first API request an isolate serves applies, in order, each migration in migrations/ not yet
 * recorded in `schema_migrations`, then records it. So a merge that adds a migration needs no hand
 * at the SQL console: production's deploy and a PR's Preview each bring their database up on their
 * first request. Every migration is written to run again harmlessly (`IF NOT EXISTS`), so a database
 * whose tables were made by hand before this existed is taken as it is, and two isolates applying
 * the same migration at once do no harm.
 */

/** A migration: its file's name (the order and the record) and its SQL. */
export interface Migration {
  name: string;
  sql: string;
}

/** The statements of a migration's SQL: comments dropped, split at each `;`. */
export function statements(sql: string): string[] {
  return sql
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Each database's bringing up in this isolate, once; a failed one is tried again on the next request. */
const schemaReadyPromises = new WeakMap<Db, Promise<void>>();

/** Applies the migrations `db` has not recorded, each with its record in one batch (a transaction on D1). */
export function ensureSchema(db: Db, migrations: readonly Migration[]): Promise<void> {
  let p = schemaReadyPromises.get(db);
  if (!p) {
    p = apply(db, migrations).catch((e) => {
      schemaReadyPromises.delete(db);
      throw e;
    });
    schemaReadyPromises.set(db, p);
  }
  return p;
}

async function apply(db: Db, migrations: readonly Migration[]) {
  await db.prepare("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)").run();
  const done = new Set((await db.prepare("SELECT name FROM schema_migrations").all<{ name: string }>()).results.map((r) => r.name));
  for (const m of [...migrations].sort((a, b) => a.name.localeCompare(b.name))) {
    if (done.has(m.name)) continue;
    await db.batch([...statements(m.sql).map((s) => db.prepare(s)), db.prepare("INSERT OR IGNORE INTO schema_migrations (name, applied_at) VALUES (?1, ?2)").bind(m.name, Date.now())]);
  }
}
