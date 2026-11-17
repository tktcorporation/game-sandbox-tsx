import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = resolve(fileURLToPath(new URL("../infra/ringfall-preview/", import.meta.url)));
const [command, ...extra] = process.argv.slice(2);

if (extra.length || !["fmt", "preflight"].includes(command)) {
  console.error("Only 'fmt' and 'preflight' are available. State operations require a separately reviewed backend and runner.");
  process.exit(2);
}

if (command === "preflight") {
  if (!/^[0-9a-fA-F]{32}$/.test(process.env.TF_VAR_cloudflare_account_id ?? "")) {
    console.error("Set TF_VAR_cloudflare_account_id to the verified account ID before preflight.");
    process.exit(2);
  }
  console.log("Preview root selected. Account ID format checked; authoritative state and backend still require independent review. State commands are disabled.");
} else {
  // fmt needs no account credentials. Do not pass inherited tokens or TF_VARs to it.
  const result = spawnSync("tofu", ["fmt", "-check"], {
    cwd: root,
    env: { PATH: process.env.PATH ?? "" },
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`Unable to run tofu fmt: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}
