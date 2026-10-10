/**
 * Gate 3 for RINGFALL: the build, played to the end in a real browser.
 * Serves dist/client, checks that real keyboard input moves the player, then lets
 * the built-in bot (window.ringfallBot) play with deterministic time
 * (window.advanceTime). Fails on any console or page error, or if the run stops
 * progressing. Screenshots of each key moment go to shots/ringfall/ for review.
 *
 *   npm run shots:ringfall -- [skill]
 */
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { chromium } from "playwright-core";

const root = "dist/client";
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
const out = "shots/ringfall";
await mkdir(out, { recursive: true });

const skill = process.argv[2] ?? "casual";
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const errors = [];
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => m.type() === "error" && !/fonts\.g|ERR_TUNNEL|net::/.test(m.text()) && errors.push(`console: ${m.text()}`));
await page.goto(`http://localhost:${port}/ringfall/`, { waitUntil: "load" });
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/00-title.png` });
await page.click("#start");
const read = async () => JSON.parse(await page.evaluate(() => window.render_game_to_text()));

// Real keyboard input must reach the sim: holding W during the drop moves the player north.
const before = await read();
await page.keyboard.down("KeyW");
await page.evaluate(() => window.advanceTime(600));
await page.keyboard.up("KeyW");
const after = await read();
if (!(after.player.z < before.player.z - 3)) errors.push(`keyboard: W did not move the player (${before.player.z} -> ${after.player.z})`);
await page.screenshot({ path: `${out}/01-drop.png` });

await page.evaluate((s) => window.ringfallBot(s), skill);
const taken = new Set();
const shot = async (name) => {
  if (taken.has(name)) return;
  taken.add(name);
  await page.screenshot({ path: `${out}/${name}.png` });
};
let prevKey = "";
let lastProgress = 0;
let s = after;
for (let i = 0; i < 25 * 60 * 10; i++) {
  await page.evaluate(() => window.advanceTime(100));
  s = await read();
  const key = `${s.phase}-${s.poi}-${s.enemies.length}-${s.poiActive}-${s.loot}-${s.stats.kills}`;
  if (key !== prevKey) {
    prevKey = key;
    lastProgress = s.time;
  }
  if (s.time - lastProgress > 90) throw new Error(`no progress for 90 s: ${JSON.stringify(s).slice(0, 600)}`);
  const live = s.enemies.filter((e) => e.mode !== "spawning");
  if (s.phase === "play") await shot("02-landed");
  if (s.poi === 0 && s.poiActive && live.length >= 3 && s.orbs >= 2) await shot("03-fight-supply");
  if (s.stats.kills >= 3 && s.enemies.some((e) => e.mode !== "spawning" && e.hp < 60)) await shot("04-damage-numbers");
  if (s.poi >= 1 && !s.poiActive && s.enemies.length === 0 && s.loot >= 3) await shot("05-loot");
  if (s.care && !s.care.landed) await shot("06-care-package");
  if (s.player.ultTime > 4) await shot("07-overdrive");
  if (s.poi === 2 && s.poiActive && live.some((e) => e.kind === "heavy") && s.orbs >= 3) await shot("08-relay-heavy");
  if (s.poi === 3 && live.some((e) => e.kind === "titan") && s.orbs >= 2) await shot("09-titan");
  if (s.waves > 0) await shot("10-stomp");
  if (s.player.downed) await shot("11-downed");
  if (s.phase === "extract") await shot("12-extract");
  if (s.phase === "done") break;
}
if (s.phase !== "done") errors.push(`run did not finish: ${JSON.stringify(s).slice(0, 300)}`);
await page.waitForTimeout(1800);
await page.screenshot({ path: `${out}/13-results.png` });
console.log(JSON.stringify((await read()).stats));
console.log(`screens: ${[...taken].join(", ")}`);
await browser.close();
server.close();
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("no console errors");
