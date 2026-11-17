import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
const cfPackage = fileURLToPath(import.meta.resolve("cf/package.json"));
const cfRoot = dirname(cfPackage);
assert.equal(JSON.parse(readFileSync(cfPackage, "utf8")).version, "1.0.0-beta.24");
const productionId = "11111111-1111-4111-8111-111111111111";
const previewId = "22222222-2222-4222-8222-222222222222";

// Local build only. Deliberately pass no Cloudflare account or credential variables.
const build = spawnSync(process.execPath, [resolve(cfRoot, "bin/cf"), "build", "--mode", "production"], {
  cwd: repo,
  env: {
    PATH: `${resolve(repo, "node_modules/.bin")}:${process.env.PATH ?? ""}`,
    CLOUDFLARE_PREVIEW_BUILD: "true",
    RINGFALL_D1_DATABASE_ID: productionId,
    RINGFALL_PREVIEW_D1_DATABASE_ID: previewId,
  },
  encoding: "utf8",
  timeout: 180_000,
});
assert.equal(build.status, 0, build.stderr || build.error?.message);

const readOutput = (name) => JSON.parse(readFileSync(resolve(repo, ".cloudflare/output/v0", name), "utf8"));
const root = readOutput("config.json");
const worker = readOutput("workers/default/worker.config.json");
assert.deepEqual(root.buildContext, { isPreview: true, mode: "production" });
assert.equal(worker.name, "game-sandbox-tsx");
assert.deepEqual(worker.env.DB, { type: "d1", id: previewId });
assert.deepEqual(worker.env.ISLAND, { type: "unsafe:durable_object_namespace", class_name: "IslandDO" });
assert.deepEqual(worker.exports.IslandDO, { type: "durable-object", storage: "sqlite" });
assert.ok(!JSON.stringify(worker).includes(productionId));
assert.match(readFileSync(resolve(repo, ".cloudflare/output/v0/workers/default/bundle/index.js"), "utf8"), /export\s*\{[^}]*\bIslandDO\b[^}]*\}/s);

// This is the exact @cloudflare/config copy bundled with the pinned cf CLI.
const configModule = pathToFileURL(resolve(cfRoot, "node_modules/@cloudflare/config/dist/index.mjs"));
const { convertToWranglerConfig } = await import(configModule.href);
const { manifest: _manifest, ...builtWorker } = worker;
const upload = convertToWranglerConfig({ worker: builtWorker, containers: [] });
assert.deepEqual(upload.unsafe?.bindings, [{ type: "durable_object_namespace", class_name: "IslandDO", name: "ISLAND" }]);
assert.deepEqual(upload.d1_databases, [{ binding: "DB", database_id: previewId }]);
assert.equal(upload.exports.IslandDO.storage, "sqlite");
assert.ok(!JSON.stringify(upload).includes("script_name"));
assert.ok(!JSON.stringify(upload).includes(productionId));
console.log("cf Preview output: isolated D1 and self IslandDO binding without script_name ok");
