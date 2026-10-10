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

/*
 * Phone in landscape: real touch events (through the DevTools protocol) must move
 * the player with the stick, turn the view, and fire. Then the bot plays to the
 * first fight so the touch layout is captured with enemies on screen.
 */
{
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`mobile pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !/fonts\.g|ERR_TUNNEL|net::/.test(m.text()) && errors.push(`mobile console: ${m.text()}`));
  await page.goto(`http://localhost:${port}/ringfall/`, { waitUntil: "load" });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/m0-title.png` });
  await page.tap("#start");
  if (!(await page.evaluate(() => document.body.classList.contains("touch")))) errors.push("mobile: touch mode did not turn on");
  const cdp = await ctx.newCDPSession(page);
  const touch = (type, points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points });
  const read = async () => JSON.parse(await page.evaluate(() => window.render_game_to_text()));
  const step = (ms) => page.evaluate((t) => window.advanceTime(t), ms);

  // Stick: press on the left, push up -> forward.
  const s0 = await read();
  await touch("touchStart", [{ x: 150, y: 260, id: 1 }]);
  await touch("touchMove", [{ x: 150, y: 200, id: 1 }]);
  await step(600);
  await page.screenshot({ path: `${out}/m1-stick.png` });
  await touch("touchEnd", []);
  const s1 = await read();
  if (!(s1.player.z < s0.player.z - 3)) errors.push(`mobile: stick did not move the player (${s0.player.z} -> ${s1.player.z})`);

  // Land, then turn the view by dragging on the right half.
  for (let i = 0; i < 60 && (await read()).phase === "drop"; i++) await step(100);
  const yaw0 = await page.evaluate(() => window.ringfallYaw());
  await touch("touchStart", [{ x: 560, y: 120, id: 2 }]);
  for (let k = 1; k <= 5; k++) await touch("touchMove", [{ x: 560 + k * 20, y: 120, id: 2 }]);
  await step(50);
  await touch("touchEnd", []);
  const yaw1 = await page.evaluate(() => window.ringfallYaw());
  if (!(yaw1 > yaw0 + 0.2)) errors.push(`mobile: dragging did not turn the view (${yaw0.toFixed(2)} -> ${yaw1.toFixed(2)})`);

  // Fire button: hold for half a second.
  const shots0 = (await read()).stats.shots;
  const fb = await page.locator("#t-fire").boundingBox();
  await touch("touchStart", [{ x: fb.x + fb.width / 2, y: fb.y + fb.height / 2, id: 3 }]);
  await step(500);
  await touch("touchEnd", []);
  const shots1 = (await read()).stats.shots;
  if (!(shots1 > shots0)) errors.push(`mobile: the fire button did not shoot (${shots0} -> ${shots1})`);

  // The page never zooms: browser gestures are off on the root (touch-action
  // narrows down the tree, so the HUD and menus are covered too), and iOS Safari's
  // pinch events, which ignore the viewport meta, are cancelled.
  const zoom = await page.evaluate(() => {
    const pinch = new Event("gesturestart", { bubbles: true, cancelable: true });
    document.getElementById("objective").dispatchEvent(pinch);
    return {
      meta: document.querySelector('meta[name="viewport"]').content,
      body: getComputedStyle(document.body).touchAction,
      pinchCancelled: pinch.defaultPrevented,
    };
  });
  if (!/user-scalable=no/.test(zoom.meta) || !/maximum-scale=1/.test(zoom.meta) || zoom.body !== "none" || !zoom.pinchCancelled)
    errors.push(`mobile: the page can still zoom (${JSON.stringify(zoom)})`);

  // The bot plays to the first fight for a screenshot of the touch layout.
  await page.evaluate((s) => window.ringfallBot(s), skill);
  for (let i = 0; i < 900; i++) {
    await step(100);
    const st = await read();
    if (st.enemies.filter((e) => e.aware === "engaged" && e.mode !== "spawning").length >= 2 && st.orbs >= 1) break;
  }
  await page.screenshot({ path: `${out}/m2-fight.png` });
  console.log(`mobile: stick ${s0.player.z} -> ${s1.player.z}, yaw ${yaw0.toFixed(2)} -> ${yaw1.toFixed(2)}, shots ${shots0} -> ${shots1}`);
  await ctx.close();
}

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

// A tour of the island's buildings and high ground, from fixed cameras.
await page.evaluate(() => {
  document.getElementById("hud").hidden = true;
  document.getElementById("banner").className = "";
});
await page.waitForTimeout(400);
const tour = [
  ["tour-1-town-bridges", -17, 8.4, 14, 1.57, -0.12],
  ["tour-2-town-street", 0, 1.6, 42, 0, 0.05],
  ["tour-3-plateau-top", -52, 8.8, -52, 2.45, -0.1],
  ["tour-4-factory-catwalk", 46, 4.9, 39.3, 1.57, -0.15],
  ["tour-5-canyon-bridge", 52, 1.6, -78, 0, 0.12],
  ["tour-6-quarry-terraces", -100, 1.6, 30, -0.61, 0.05],
];
for (const [name, x, y, z, yaw, pitch] of tour) {
  await page.evaluate(([x, y, z, yaw, pitch]) => window.ringfallCamera(x, y, z, yaw, pitch), [x, y, z, yaw, pitch]);
  await page.screenshot({ path: `${out}/${name}.png` });
}
await page.evaluate(() => {
  window.ringfallCamera();
  document.getElementById("hud").hidden = false;
});

await page.evaluate((s) => window.ringfallBot(s), skill);
const taken = new Set();
const shot = async (name) => {
  if (taken.has(name)) return;
  taken.add(name);
  await page.screenshot({ path: `${out}/${name}.png` });
};
let prevKey = "";
let prevFlank = 0;
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
  const live = s.enemies.filter((e) => e.mode !== "spawning" && e.aware === "engaged");
  const near = (e) => Math.hypot(e.x - s.player.x, e.z - s.player.z);
  if (s.phase === "play") await shot("02-landed");
  if (s.poi === 0 && live.length >= 2 && s.orbs >= 1) await shot("03-fight-supply");
  if (s.stats.kills >= 3 && s.enemies.some((e) => e.mode !== "spawning" && e.hp < 60)) await shot("04-damage-numbers");
  if (s.stats.poiTimes.length >= 2 && !live.length && s.loot >= 3) await shot("05-loot");
  if (s.care && !s.care.landed) await shot("06-care-package");
  if (s.player.ultTime > 4) await shot("07-overdrive");
  if (s.poi === 2 && live.some((e) => e.kind === "heavy") && s.orbs >= 2) await shot("08-relay-heavy");
  if (!live.length && s.enemies.some((e) => (e.aware === "alert" || e.detect > 0.3) && near(e) < 45)) await shot("14-noticed");
  if (s.player.reveal > 2) await shot("15-reveal");
  if (s.stats.flankHits > prevFlank && s.stats.flankHits >= 3) await shot("16-flank-hit");
  prevFlank = s.stats.flankHits;
  if (s.squads.some((q) => q.lost && q.poi === s.poi) && live.length) await shot("17-lost-track");
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
