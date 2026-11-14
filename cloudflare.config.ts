import { bindings, defineConfig, exports } from "cf/config";
import names from "./infra/ringfall/config.json" with { type: "json" };

const workerName = "game-sandbox-tsx";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default defineConfig(({ isPreview }) => {
  // Production may stay unbound until OpenTofu and SQL are ready. Every Preview needs
  // an already-provisioned D1: cf must never create one or borrow production's.
  const databaseId = isPreview ? process.env.RINGFALL_PREVIEW_D1_DATABASE_ID : process.env.RINGFALL_D1_DATABASE_ID;
  if (isPreview && !databaseId) throw new Error("Preview requires RINGFALL_PREVIEW_D1_DATABASE_ID");
  if (databaseId && !uuid.test(databaseId)) throw new Error(`${isPreview ? "RINGFALL_PREVIEW_D1_DATABASE_ID" : "RINGFALL_D1_DATABASE_ID"} must be a D1 UUID`);
  if (isPreview && databaseId === process.env.RINGFALL_D1_DATABASE_ID) throw new Error("Preview D1 must differ from production D1");

  return {
    worker: {
      name: workerName,
      entrypoint: "./worker/index.ts",
      compatibilityDate: "2025-06-01",
      assets: { notFoundHandling: "single-page-application", runWorkerFirst: ["/api/*"] },
      observability: { enabled: true },
      env: {
        ASSETS: bindings.assets(),
        DB: databaseId
          ? bindings.d1(isPreview ? { id: databaseId } : { name: names.database_name, id: databaseId })
          : undefined,
        ISLAND: bindings.durableObject({ worker: workerName, exportName: "IslandDO" }),
      },
      exports: { IslandDO: exports.durableObject({ storage: "sqlite" }) },
    },
  };
});
