import { bindings, defineConfig, exports } from "cf/config";
import names from "./infra/ringfall/config.json" with { type: "json" };

// Leave DB absent until the OpenTofu-owned database exists and its SQL has been applied.
// cf can provision an unidentified D1 binding, so never declare DB by name alone.
const databaseId = process.env.RINGFALL_D1_DATABASE_ID;
if (databaseId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(databaseId)) {
  throw new Error("RINGFALL_D1_DATABASE_ID must be a D1 UUID");
}

export default defineConfig({
  worker: {
    name: "game-sandbox-tsx",
    entrypoint: "./worker/index.ts",
    compatibilityDate: "2025-06-01",
    assets: { notFoundHandling: "single-page-application", runWorkerFirst: ["/api/*"] },
    observability: { enabled: true },
    env: {
      ASSETS: bindings.assets(),
      DB: databaseId ? bindings.d1({ name: names.database_name, id: databaseId }) : undefined,
      ISLAND: bindings.durableObject({ worker: "game-sandbox-tsx", exportName: "IslandDO" }),
    },
    exports: { IslandDO: exports.durableObject({ storage: "sqlite" }) },
  },
});
