import assert from "node:assert/strict";
import config from "../cloudflare.config";

const production = "11111111-1111-4111-8111-111111111111";
const preview = "22222222-2222-4222-8222-222222222222";
assert.equal(typeof config, "function");
const evaluate = (isPreview: boolean) => config({ isPreview, mode: "production" });
const worker = (isPreview: boolean) => {
  const result = evaluate(isPreview);
  assert.ok(result.worker);
  return result.worker;
};
const checkSelfBinding = (w: ReturnType<typeof worker>) => {
  assert.equal(w.env?.ISLAND?.type, "durable-object");
  assert.equal(w.env.ISLAND.worker, w.name);
  assert.equal(w.env.ISLAND.exportName, "IslandDO");
  assert.equal(w.exports?.IslandDO?.type, "durable-object");
  assert.equal(w.exports.IslandDO.storage, "sqlite");
  assert.equal(w.env.ASSETS?.type, "assets");
};

delete process.env.RINGFALL_D1_DATABASE_ID;
delete process.env.RINGFALL_PREVIEW_D1_DATABASE_ID;
const unbound = worker(false);
assert.equal(unbound.env?.DB, undefined);
checkSelfBinding(unbound);

process.env.RINGFALL_D1_DATABASE_ID = production;
const bound = worker(false);
assert.equal(bound.env?.DB?.id, production);
assert.equal(bound.env.DB.name, "ringfall");
checkSelfBinding(bound);

assert.throws(() => evaluate(true), /Preview requires RINGFALL_PREVIEW_D1_DATABASE_ID/);
process.env.RINGFALL_PREVIEW_D1_DATABASE_ID = preview;
const isolated = worker(true);
assert.equal(isolated.env?.DB?.id, preview);
assert.equal(isolated.env.DB.name, undefined);
assert.notEqual(isolated.env.DB.id, bound.env.DB?.id);
assert.equal(isolated.name, bound.name);
checkSelfBinding(isolated);
assert.ok(!JSON.stringify(isolated).includes(production));

process.env.RINGFALL_PREVIEW_D1_DATABASE_ID = production;
assert.throws(() => evaluate(true), /Preview D1 must differ/);
process.env.RINGFALL_PREVIEW_D1_DATABASE_ID = "bad";
assert.throws(() => evaluate(true), /RINGFALL_PREVIEW_D1_DATABASE_ID must be a D1 UUID/);
delete process.env.RINGFALL_PREVIEW_D1_DATABASE_ID;
process.env.RINGFALL_D1_DATABASE_ID = "bad";
assert.throws(() => evaluate(false), /RINGFALL_D1_DATABASE_ID must be a D1 UUID/);

console.log("cf config: production/Preview D1 separation and IslandDO self-binding ok");
