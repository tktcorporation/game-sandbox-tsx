/**
 * In-browser performance sample for RINGFALL (real play path: sim + sync + draw + HUD).
 * Serves the build, starts a reservoir raid, walks a fixed path, and prints section timings.
 *
 *   npm run build && npm run perf:ringfall
 *   CHROMIUM_PATH=/usr/local/bin/google-chrome npm run perf:ringfall -- --out shots/ringfall/perf-after.json
 *
 * SwiftShader / software GL numbers are not absolute GPU truth; they compare CPU main-thread
 * cost and quality-governor reactions before/after a change on the same machine.
 */
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { chromium } from "playwright-core";

const root = process.env.SHOTS_ROOT ?? ".cloudflare/output/v0/workers/default/assets";
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

const args = process.argv.slice(2);
const outArg = args.includes("--out") ? args[args.indexOf("--out") + 1] : args.find((a) => a.startsWith("--out="))?.slice(6);
const out = outArg ?? "shots/ringfall/perf.json";
const steps = Number(args.find((a, i) => args[i - 1] === "--steps") ?? 240);
const quality = args.find((a, i) => args[i - 1] === "--quality") ?? "high";

await mkdir("shots/ringfall", { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/local/bin/google-chrome",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(msg.text());
});

await page.goto(`http://127.0.0.1:${port}/ringfall/?quality=${quality}`, { waitUntil: "networkidle" });
await page.waitForFunction(() => typeof window.ringfallPerf === "function" && typeof window.ringfallCamp === "object");

await page.evaluate(() => {
  document.getElementById("start")?.click();
});
await page.waitForFunction(() => JSON.parse(window.render_game_to_text()).screen === "camp", null, { timeout: 15000 });
await page.evaluate(() => window.ringfallCamp.toGate());
await page.keyboard.down("KeyW");
for (let i = 0; i < 40; i++) {
  const st = JSON.parse(await page.evaluate(() => (window.advanceTime(200), window.render_game_to_text())));
  if (st.screen === "game" || st.camp?.depart) break;
}
await page.keyboard.up("KeyW");
const mid = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
if (mid.camp?.depart) {
  await page.waitForFunction(() => !document.getElementById("depart").hidden && document.querySelectorAll("#depart-points button.pick").length > 0, null, { timeout: 5000 });
  await page.keyboard.press("Enter");
}
await page.waitForFunction(() => JSON.parse(window.render_game_to_text()).screen === "game", null, { timeout: 10000 });
// Let the raid settle and prebuilt chunks finish.
await page.evaluate(() => window.advanceTime(500));
await page.evaluate(() => window.ringfallDraw());

// Supply POI approach: dense buildings + open ground, typical stutter site.
const place = await page.evaluate(() => {
  const f = window.ringfallFrames();
  const at = f.supply ?? f["area:heart"] ?? { x: 0, z: 200 };
  return { x: at.x + 40, z: at.z + 80, yaw: -0.4 };
});

const sample = await page.evaluate(
  ({ steps, place, quality }) =>
    window.ringfallPerf({
      steps,
      stepMs: 16,
      place,
      path: { dx: 0.7, dz: -0.25 },
      quality,
      govern: true,
    }),
  { steps, place, quality },
);

// A long straight walk that keeps entering unloaded fog: stresses chunk streaming hitches.
const hitch = await page.evaluate((quality) => {
  window.ringfallQuality(quality);
  return window.ringfallPerf({
    steps: 180,
    stepMs: 16,
    place: { x: -200, z: 100, yaw: 1.2 },
    path: { dx: 1.4, dz: 0.4 },
    quality,
    govern: true,
  });
}, quality);

const still = await page.evaluate((q) => {
  window.ringfallQuality(q);
  return window.ringfallFrameCost(30);
}, quality);

const report = {
  at: new Date().toISOString(),
  quality,
  place,
  steps,
  sample,
  hitch,
  still,
  errors,
};

console.log(JSON.stringify(report, null, 2));
await writeFile(out, JSON.stringify(report, null, 2));
console.log(`wrote ${out}`);

await browser.close();
server.close();
if (errors.length) {
  console.error(`page errors: ${errors.join(" | ")}`);
  process.exit(1);
}
