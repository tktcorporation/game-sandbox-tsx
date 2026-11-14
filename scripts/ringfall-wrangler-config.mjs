import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const names = JSON.parse(readFileSync(resolve(root, 'infra/ringfall/config.json'), 'utf8'));
const base = JSON.parse(readFileSync(resolve(root, 'wrangler.jsonc'), 'utf8'));
const islandBase = readFileSync(resolve(root, 'islands/wrangler.jsonc'), 'utf8');
const args = process.argv.slice(2);
if (args.length !== 3 || !['migration', 'connected'].includes(args[0])) {
  console.error('Usage: node scripts/ringfall-wrangler-config.mjs <migration|connected> <real-database-uuid> <output-path>');
  process.exit(2);
}
const [mode, id, out] = args;
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
  console.error('A real D1 database UUID is required');
  process.exit(2);
}
if (base.d1_databases || base.durable_objects) throw new Error('Base Wrangler config already owns a binding');
for (const [key, value] of Object.entries({ database_binding: 'DB', island_binding: 'ISLAND', island_class: 'IslandDO' })) {
  if (names[key] !== value) throw new Error(`${key} disagrees with Worker code`);
}
if (!islandBase.includes(`"name": "${names.island_worker_name}"`) || !islandBase.includes(`"new_sqlite_classes": ["${names.island_class}"]`)) {
  throw new Error('Island Worker name or SQLite migration disagrees with SSOT');
}
base.d1_databases = [{ binding: names.database_binding, database_name: names.database_name, database_id: id, migrations_dir: 'migrations' }];
if (mode === 'connected') {
  base.durable_objects = { bindings: [{ name: names.island_binding, class_name: names.island_class, script_name: names.island_worker_name }] };
}
writeFileSync(resolve(out), `${JSON.stringify(base, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
