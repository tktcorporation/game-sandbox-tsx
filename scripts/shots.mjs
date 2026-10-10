/**
 * Gate 3: build output played in a real browser.
 * Serves dist/client, clicks start, then plays by reading window.render_game_to_text(),
 * aiming the real mouse at the nearest enemy and stepping with window.advanceTime().
 * Fails on any console error or page error, or if the run stops progressing.
 * Screenshots go to shots/ (git-ignored) for the agent and humans to inspect.
 */
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { chromium } from "playwright-core";

const root = "dist/client";
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
const server = createServer(async (req, res) => {
  const path = join(root, decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/\/$/, "/index.html"));
  let body;
  try {
    body = await readFile(path);
  } catch {
    return res.writeHead(404).end();
  }
  res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" }).end(body);
}).listen(0);
const port = server.address().port;
await mkdir("shots", { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium" });
const errors = [];
// With no room argument the gate plays the whole run, so a bare `npm run shots` covers every room.
const until = Number(process.argv[2] ?? Infinity);
const modes = (process.argv[3] ?? "3d,2d").split(",");
const sizes = modes.map((mode) => ({ name: mode, mode, width: 1280, height: 720 }));

for (const size of sizes) {
  const page = await browser.newPage({ viewport: size, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !/fonts\.g/.test(m.text()) && errors.push(`console: ${m.text()}`));
  await page.goto(`http://localhost:${port}/`, { waitUntil: "networkidle" });
  await page.screenshot({ path: `shots/${size.name}-0-title.png` });
  await page.click(size.mode === "3d" ? "#start3d" : "#start");
  await page.waitForFunction(() => JSON.parse(window.render_game_to_text()).phase !== "title");
  await page.waitForSelector("canvas");
  await page.waitForTimeout(300);

  const box = await page.locator("canvas").boundingBox();
  const toPage = (x, y) => ({ x: box.x + (x / 960) * box.width, y: box.y + (y / 540) * box.height });
  const read = async () => JSON.parse(await page.evaluate(() => window.render_game_to_text()));

  let shotsTaken = new Set();
  let lastProgress = 0;
  let prevKey = "";
  for (let i = 0; i < 2400; i++) {
    const s = await read();
    const key = `${s.room}-${s.enemies.length}-${s.wavesLeft}-${s.phase}`;
    if (key !== prevKey) {
      lastProgress = i;
      prevKey = key;
    }
    if (i - lastProgress > 600) throw new Error(`no progress for 60 s at ${key}`);
    const live = s.enemies.filter((e) => e.mode !== "spawning");
    const target = live.sort((a, b) => Math.hypot(a.x - s.player.x, a.y - s.player.y) - Math.hypot(b.x - s.player.x, b.y - s.player.y))[0];
    // In room 3, hold fire for a moment so the screenshot shows enemy telegraphs and bullets.
    const holdFire = s.room === 3 && !shotsTaken.has("threat") && live.length >= 3;
    if (holdFire && s.bullets >= 3) {
      shotsTaken.add("threat");
      await page.screenshot({ path: `shots/${size.name}-r3-threat.png` });
    }
    if (target && !holdFire) {
      if (size.mode === "3d") {
        await page.evaluate(([x, y]) => window.aimAt(x, y), [target.x, target.y]);
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      } else {
        const p = toPage(target.x, target.y);
        await page.mouse.move(p.x, p.y);
      }
      await page.mouse.down();
    } else await page.mouse.up();
    // Strafe in a slow circle so the player is not a sitting target.
    const keys = [["KeyA", "KeyW"], ["KeyW", "KeyD"], ["KeyD", "KeyS"], ["KeyS", "KeyA"]][Math.floor(i / 12) % 4];
    for (const k of keys) await page.keyboard.down(k);
    await page.evaluate(() => window.advanceTime(100));
    for (const k of keys) await page.keyboard.up(k);

    const tag = `${s.room}-${s.phase}`;
    const fightShot = s.phase === "fight" && live.length >= 2 && s.bullets >= 2;
    if ((fightShot || s.phase === "clear") && !shotsTaken.has(tag)) {
      shotsTaken.add(tag);
      await page.screenshot({ path: `shots/${size.name}-r${s.room}-${s.phase}.png` });
    }
    if (s.room > until || s.phase === "done") break;
  }
  await page.mouse.up();
  await page.evaluate(() => window.advanceTime(1800));
  await page.waitForTimeout(500);
  await page.screenshot({ path: `shots/${size.name}-z-end.png` });
  console.log(`${size.name}: ${JSON.stringify(await read())}`);
  await page.close();
}

await browser.close();
server.close();
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("no console errors");
