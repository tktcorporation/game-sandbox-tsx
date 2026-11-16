import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkPreviewContainer } from "./ringfall-devcontainer-preflight.mjs";

const config = JSON.parse(readFileSync(new URL("../.devcontainer/devcontainer.json", import.meta.url), "utf8"));
const node = readFileSync(new URL("../.node-version", import.meta.url), "utf8").trim();
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
assert.equal(config.image, `node:${node}-bookworm`);
assert.equal(pkg.devDependencies.cf, "1.0.0-beta.24");
assert.equal(config.remoteUser, "node");
assert.equal(config.containerUser, "node");
assert.equal(config.updateRemoteUserUID, true);
assert.deepEqual(config.mounts, []);
assert.equal(config.workspaceMount, "source=${localWorkspaceFolder},target=/workspace/game-sandbox-tsx,type=bind");
assert.ok(config.runArgs.includes("--cap-drop=ALL"));
assert.ok(config.runArgs.includes("--security-opt=no-new-privileges"));
assert.ok(!Object.keys(config).some((key) => /privileged|features|postCreateCommand|postStartCommand|onCreateCommand|initializeCommand|remoteEnv|containerEnv/.test(key)));
assert.doesNotMatch(JSON.stringify(config), /docker\.sock|\/var\/run|\/Users\/|\/home\/|\.ssh|1password|sops|secret|token|deploy|apply|init|plan/i);
const source = readFileSync(new URL("./ringfall-devcontainer-preflight.mjs", import.meta.url), "utf8");
assert.doesNotMatch(source, /\b(?:eval|execSync)\s*\(|["'](?:init|plan|apply|import|deploy|decrypt)["']/);
const valid = { platform: "linux", arch: "arm64", uid: 1000, versions: { node, tofu: "1.13.2", sops: "3.13.2", age: "1.3.2" } };
assert.deepEqual(checkPreviewContainer(valid), []);
assert.deepEqual(checkPreviewContainer({ ...valid, arch: "x64" }), []);
for (const invalid of [
  { ...valid, uid: 0 },
  { ...valid, platform: "darwin" },
  { ...valid, versions: { ...valid.versions, tofu: null } },
  { ...valid, versions: { ...valid.versions, sops: "3.13.3" } },
]) assert.ok(checkPreviewContainer(invalid).length);
console.log("RINGFALL DevContainer static and preflight checks ok");
