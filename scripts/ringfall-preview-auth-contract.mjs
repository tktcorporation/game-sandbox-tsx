import { fileURLToPath } from "node:url";

// Testable contract only. No SOPS, Cloudflare, OpenTofu, or process-spawn adapter
// is wired here. A real runner needs a separate review and authorization.
export const PREVIEW_ROOT = fileURLToPath(new URL("../infra/ringfall-preview/", import.meta.url));

const fields = ["cloudflare_account_id", "cloudflare_api_token", "preview_state_passphrase"];

function parseDecryptedJson(plaintext) {
  let parsed;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new Error("Preview credential document is invalid");
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object" ||
      Object.keys(parsed).sort().join(",") !== fields.join(",") ||
      fields.some((key) => typeof parsed[key] !== "string")) {
    throw new Error("Preview credential document is invalid");
  }
  if (!/^[0-9a-fA-F]{32}$/.test(parsed.cloudflare_account_id) ||
      !parsed.cloudflare_api_token.trim() || parsed.preview_state_passphrase.length < 32) {
    throw new Error("Preview credential document is invalid");
  }
  return Object.freeze({
    CLOUDFLARE_API_TOKEN: parsed.cloudflare_api_token,
    TF_VAR_cloudflare_account_id: parsed.cloudflare_account_id,
    TF_VAR_preview_state_passphrase: parsed.preview_state_passphrase,
  });
}

// All adapters are required and injectable only in tests today. The child adapter
// receives a fixed cwd and a restricted env; no shell command is constructed.
export async function exercisePreviewAuthContract(adapters) {
  if (!adapters || Object.keys(adapters).sort().join(",") !==
      "acquireWriter,decryptSopsJson,spawnChild" ||
      Object.values(adapters).some((value) => typeof value !== "function")) {
    throw new Error("Preview adapters are incomplete");
  }

  let release;
  try {
    release = await adapters.acquireWriter(PREVIEW_ROOT);
  } catch {
    throw new Error("Preview single writer is unavailable");
  }
  if (typeof release !== "function") throw new Error("Preview single writer is unavailable");

  let failure;
  try {
    const env = parseDecryptedJson(await adapters.decryptSopsJson());
    const result = await adapters.spawnChild({ cwd: PREVIEW_ROOT, env });
    if (result !== 0) throw new Error("child failed");
  } catch {
    failure = new Error("Preview credential contract failed");
  }
  try {
    await release();
  } catch {
    throw new Error("Preview single writer release failed");
  }
  if (failure) throw failure;
}
