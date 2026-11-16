import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(fileURLToPath(new URL("../", import.meta.url)));
const script = join(repo, "scripts/ringfall-preview-tofu.mjs");
const productionRoot = readFileSync(join(repo, "infra/ringfall/main.tf"), "utf8");
const previewRoot = readFileSync(join(repo, "infra/ringfall-preview/main.tf"), "utf8");
assert.match(productionRoot, /resource "cloudflare_d1_database" "ringfall"/);
assert.doesNotMatch(productionRoot, /resource "cloudflare_d1_database" "ringfall_preview"/);
assert.match(previewRoot, /resource "cloudflare_d1_database" "ringfall_preview"/);
assert.doesNotMatch(previewRoot, /resource "cloudflare_d1_database" "ringfall"/);
assert.doesNotMatch(`${productionRoot}\n${previewRoot}`, /module "|backend "/);
assert.match(previewRoot, /\.\.\/ringfall\/config\.json/);
const fakeBin = mkdtempSync(join(tmpdir(), "ringfall-tofu-stub-"));
const stub = join(fakeBin, "tofu");
writeFileSync(stub, "#!/bin/sh\nprintf 'cwd=%s args=%s token=%s\\n' \"$PWD\" \"$*\" \"${CLOUDFLARE_API_TOKEN:-}\"\n");
chmodSync(stub, 0o700);

const run = (args, env = {}) => spawnSync(process.execPath, [script, ...args], {
  cwd: tmpdir(),
  env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, CLOUDFLARE_API_TOKEN: "secret-sentinel", ...env },
  encoding: "utf8",
});

try {
  const fmt = run(["fmt"]);
  assert.equal(fmt.status, 0, fmt.stderr);
  assert.match(fmt.stdout, new RegExp(`cwd=${join(repo, "infra/ringfall-preview")} args=fmt -check token=\\n`));
  assert.ok(!fmt.stdout.includes("secret-sentinel"));

  for (const args of [["plan"], ["init"], ["apply"], ["import"], ["state"], ["fmt", "-chdir=infra/ringfall"]]) {
    const denied = run(args);
    assert.equal(denied.status, 2, args.join(" "));
    assert.ok(!denied.stdout.includes("cwd="));
  }

  const missing = run(["preflight"], { TF_VAR_cloudflare_account_id: "" });
  assert.equal(missing.status, 2);
  const fakeAccount = "a".repeat(32);
  const preflight = run(["preflight"], { TF_VAR_cloudflare_account_id: fakeAccount });
  assert.equal(preflight.status, 0, preflight.stderr);
  assert.ok(!`${preflight.stdout}${preflight.stderr}`.includes(fakeAccount));
  assert.ok(!`${preflight.stdout}${preflight.stderr}`.includes("secret-sentinel"));
  assert.match(preflight.stdout, /State commands are disabled/);
  console.log("Preview Tofu runner: fixed root, disabled state commands, missing account rejection, no token output ok");
} finally {
  rmSync(fakeBin, { recursive: true, force: true });
}
