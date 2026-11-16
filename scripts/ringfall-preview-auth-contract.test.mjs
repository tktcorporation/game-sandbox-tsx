import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PREVIEW_ROOT, exercisePreviewAuthContract } from "./ringfall-preview-auth-contract.mjs";

const token = "fake-token-never-log";
const passphrase = "fake-passphrase-of-at-least-32-characters";
const account = "a".repeat(32);
const document = JSON.stringify({
  cloudflare_account_id: account,
  cloudflare_api_token: token,
  preview_state_passphrase: passphrase,
});
const root = fileURLToPath(new URL("../infra/ringfall-preview/", import.meta.url));
assert.equal(PREVIEW_ROOT, root);
const contractSource = readFileSync(new URL("./ringfall-preview-auth-contract.mjs", import.meta.url), "utf8");
assert.doesNotMatch(contractSource, /node:child_process|\b(?:exec|spawn|eval)\s*\(/);
const packageScripts = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts;
assert.ok(Object.entries(packageScripts).every(([name, command]) =>
  name.startsWith("test:") || !command.includes("ringfall-preview-auth-contract")));

let busy = false;
let releases = 0;
let spawns = 0;
const acquireWriter = async (cwd) => {
  assert.equal(cwd, root);
  if (busy) throw new Error("lock busy");
  busy = true;
  return () => { busy = false; releases++; };
};
const spawnChild = async ({ cwd, env }) => {
  spawns++;
  assert.equal(cwd, root);
  assert.deepEqual(Object.keys(env).sort(), [
    "CLOUDFLARE_API_TOKEN", "TF_VAR_cloudflare_account_id", "TF_VAR_preview_state_passphrase",
  ].sort());
  assert.equal(env.CLOUDFLARE_API_TOKEN, token);
  assert.equal(env.TF_VAR_cloudflare_account_id, account);
  assert.equal(env.TF_VAR_preview_state_passphrase, passphrase);
  return 0;
};
const adapters = { acquireWriter, decryptSopsJson: async () => document, spawnChild };

await exercisePreviewAuthContract(adapters);
assert.equal(releases, 1);
assert.equal(spawns, 1);

for (const invalid of ["not json", "{}", JSON.stringify({ ...JSON.parse(document), extra: "x" }),
  JSON.stringify({ ...JSON.parse(document), cloudflare_api_token: "" }),
  JSON.stringify({ ...JSON.parse(document), preview_state_passphrase: "short" })]) {
  await assert.rejects(exercisePreviewAuthContract({ ...adapters, decryptSopsJson: async () => invalid }),
    /Preview credential contract failed/);
}
assert.equal(spawns, 1);
assert.equal(releases, 6);

await assert.rejects(exercisePreviewAuthContract({ ...adapters, cwd: "/tmp/other-root" }),
  /Preview adapters are incomplete/);
await assert.rejects(exercisePreviewAuthContract({ ...adapters, decryptSopsJson: undefined }),
  /Preview adapters are incomplete/);

let finish;
const waiting = exercisePreviewAuthContract({ ...adapters, spawnChild: () => new Promise((resolve) => { finish = resolve; }) });
await new Promise((resolve) => setImmediate(resolve));
await assert.rejects(exercisePreviewAuthContract(adapters), /Preview single writer is unavailable/);
finish(0);
await waiting;

await assert.rejects(exercisePreviewAuthContract({ ...adapters, spawnChild: async () => { throw new Error(token); } }),
  (error) => !error.message.includes(token) && /Preview credential contract failed/.test(error.message));
assert.equal(busy, false);
console.log("Preview auth contract: fixed root, fixed keys, child-only env, fail-closed and writer checks ok");
