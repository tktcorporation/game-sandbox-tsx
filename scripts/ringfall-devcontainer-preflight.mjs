import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const expected = {
  node: readFileSync(new URL("../.node-version", import.meta.url), "utf8").trim(),
  tofu: "1.13.2",
  sops: "3.13.2",
  age: "1.3.2",
};

export function checkPreviewContainer({ platform, arch, uid, versions }) {
  const failures = [];
  if (platform !== "linux" || !["arm64", "x64"].includes(arch)) failures.push("Linux arm64/x64 required");
  if (uid === 0 || uid === undefined) failures.push("non-root user required");
  for (const [tool, version] of Object.entries(expected)) {
    if (versions[tool] !== version) failures.push(`${tool} ${version} required`);
  }
  return failures;
}

function versionOf(command, args, pattern) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 5000,
    env: { PATH: process.env.PATH ?? "" },
  });
  if (result.error || result.status !== 0) return null;
  return `${result.stdout}\n${result.stderr}`.match(pattern)?.[1] ?? null;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const failures = checkPreviewContainer({
    platform: process.platform,
    arch: process.arch,
    uid: process.getuid?.(),
    versions: {
      node: process.versions.node,
      tofu: versionOf("tofu", ["version"], /OpenTofu v([0-9]+\.[0-9]+\.[0-9]+)/),
      sops: versionOf("sops", ["--version"], /sops ([0-9]+\.[0-9]+\.[0-9]+)/i),
      age: versionOf("age", ["--version"], /(?:^|\n)(?:age )?v([0-9]+\.[0-9]+\.[0-9]+)/i),
    },
  });
  if (failures.length) {
    console.error(`RINGFALL Preview preflight failed: ${failures.join("; ")}`);
    process.exitCode = 2;
  } else {
    console.log("RINGFALL Preview toolchain ready; state and cloud authorization still require separate review.");
  }
}
