import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const repo = resolve(fileURLToPath(new URL("../", import.meta.url)));
const ignored = [
  "terraform.tfstate", "terraform.tfstate.backup", "state/preview.tfstate.backup",
  "terraform.tfvars", "preview.auto.tfvars.json", "secrets.tfvars.json",
  ".terraform/providers/provider", "terraform.tfstate.d/preview/terraform.tfstate",
  ".terraform.tfstate.lock.info", "plans/preview", "preview.tfplan", "preview.tfplan.json",
  "preview.plan", "preview.plan.json", "plan.out", "plan.out.json",
];
const tracked = ["main.tf", "config.json", ".terraform.lock.hcl", "README.md"];

for (const root of ["infra/ringfall", "infra/ringfall-preview"]) {
  for (const [paths, expected] of [[ignored, 0], [tracked, 1]]) {
    for (const path of paths) {
      // No files are created: check-ignore evaluates synthetic paths from stdin.
      const result = spawnSync("git", ["check-ignore", "--no-index", "-q", "--stdin"], {
        cwd: repo,
        input: `${root}/${path}\n`,
        encoding: "utf8",
      });
      assert.equal(result.status, expected, `${root}/${path}: ${result.stderr}`);
      assert.equal(result.stdout, "");
    }
  }
}

for (const path of ["scripts/ringfall-preview-tofu.test.mjs", "scripts/ringfall-tofu-ignore.test.mjs"]) {
  const result = spawnSync("git", ["check-ignore", "--no-index", "-q", "--stdin"], {
    cwd: repo, input: `${path}\n`, encoding: "utf8",
  });
  assert.equal(result.status, 1, path);
}

console.log("RINGFALL OpenTofu ignore: both roots protect state, vars, providers and plans; config remains trackable");
