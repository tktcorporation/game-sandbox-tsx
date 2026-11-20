import type { Migration } from "./schema";
import init from "../migrations/0001_init.sql?raw";
import islands from "../migrations/0002_islands.sql?raw";

/**
 * Every migration in migrations/, in order, as the Worker applies them (worker/schema.ts). A new
 * migration file is added here too; scripts/ringfall-server.ts fails when the two lists differ.
 */
export const MIGRATIONS: readonly Migration[] = [
  { name: "0001_init.sql", sql: init },
  { name: "0002_islands.sql", sql: islands },
];
