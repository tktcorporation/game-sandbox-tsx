/**
 * The RINGFALL model sheets: serves the build, opens the page with `?models` in Chromium and
 * saves every sheet `window.ringfallModelSheet` draws (view/modelsheet.ts: each model under the
 * game's own light, at the game's pixels) to shots/ringfall/models/sheet-<id>.png. Fails on a
 * console error. Looked at before and after a model is changed (docs/ringfall/models.md).
 *
 *   npm run build && npm run models:ringfall -- --sheet [--only robots,guns] [--out dir]
 */
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import { chromium } from "playwright-core";

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const only = arg("--only")?.split(",");
const out = arg("--out") ?? "shots/ringfall/models";

// Where the build leaves the client: dist/client, or the Cloudflare plugin's own output.
const root = ["dist/client", ".cloudflare/output/v0/workers/default/assets"].find((d) => existsSync(join(d, "ringfall/index.html")));
if (!root) {
  console.error("no build found: run `npm run build` first");
  process.exit(1);
}
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
const server = createServer(async (req, res) => {
  let path = join(root, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (path.endsWith("/")) path += "index.html";
  let body;
  try {
    body = await readFile(path);
  } catch {
    return res.writeHead(404).end();
  }
  res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" }).end(body);
}).listen(0);
const port = server.address().port;
await mkdir(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const errors = [];
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => m.type() === "error" && !/fonts\.g|ERR_TUNNEL|net::/.test(m.text()) && errors.push(`console: ${m.text()}`));
await page.goto(`http://localhost:${port}/ringfall/?models`, { waitUntil: "load" });
await page.waitForFunction(() => !!window.ringfallModelSheet, null, { timeout: 60000 });
const ids = await page.evaluate(() => window.ringfallModelSheet.ids());
const unknown = (only ?? []).filter((id) => !ids.includes(id));
if (unknown.length) errors.push(`no such sheet: ${unknown.join(", ")} (there are ${ids.join(", ")})`);
for (const id of ids) {
  if (only && !only.includes(id)) continue;
  const url = await page.evaluate((id) => window.ringfallModelSheet.draw(id), id);
  const file = `${out}/sheet-${id}.png`;
  await writeFile(file, Buffer.from(url.slice(url.indexOf(",") + 1), "base64"));
  console.log(file);
}
await browser.close();
server.close();
if (errors.length) {
  console.error(`model sheets failed:\n${errors.map((e) => `  ${e}`).join("\n")}`);
  process.exit(1);
}
