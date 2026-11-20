/** A migration's SQL, bundled as text by Vite (worker/migrations.ts). */
declare module "*.sql?raw" {
  const sql: string;
  export default sql;
}
