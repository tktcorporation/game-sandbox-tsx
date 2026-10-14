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
  // Turning the phone: the picture is drawn at the new shape, not the old one stretched.
  // (Checked before starting: once the game asks for full screen, the window no longer follows the viewport here.)
  await page.setViewportSize({ width: 740, height: 360 });
  // The resize is reported on a later frame; give it up to 3 s on a slow software renderer.
  await page
    .waitForFunction(() => {
      const c = document.querySelector("#stage canvas");
      return Math.abs(c.width / c.height - 740 / 360) < 0.02;
    }, null, { timeout: 3000 })
    .catch(() => undefined);
  const shape = await page.evaluate(() => {
    const c = document.querySelector("#stage canvas");
    return { w: c.width, h: c.height };
  });
  if (Math.abs(shape.w / shape.h - 740 / 360) > 0.02) errors.push(`mobile: after a resize the canvas is ${shape.w}x${shape.h}, not 740:360`);
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(300);
  // Some phone browsers and web views have no Screen Orientation API; starting must not depend on it.
  await page.evaluate(() => Object.defineProperty(screen, "orientation", { value: undefined, configurable: true }));
  await page.tap("#start");
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${out}/m0-hub.png` });
  await page.tap("#hub-free");
  if (!(await page.evaluate(() => document.body.classList.contains("touch")))) errors.push("mobile: touch mode did not turn on");
  if (!(await page.evaluate(() => document.body.classList.contains("playing")))) errors.push("mobile: the start button did not start the game");
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

  // The weapon cards are tappable (they switch weapons): a tap on each card shown
  // lands on the card itself, not on the view-turning zone under it.
  for (const id of ["slot-0", "slot-1"]) {
    const hit = await page.evaluate((cardId) => {
      const r = document.getElementById(cardId).getBoundingClientRect();
      if (!r.width) return true; // an empty slot is not shown
      return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest(`#${cardId}`) !== null;
    }, id);
    if (!hit) errors.push(`mobile: a tap on the weapon card ${id} does not reach it`);
  }

  // The starting sniper: tap its card, aim, and the scope covers the view.
  const tap = async (sel, id) => {
    const bb = await page.locator(sel).boundingBox();
    await touch("touchStart", [{ x: bb.x + bb.width / 2, y: bb.y + bb.height / 2, id }]);
    await touch("touchEnd", []);
  };
  await tap("#slot-1", 4);
  await step(400);
  await tap("#t-ads", 5);
  await step(400);
  await page.screenshot({ path: `${out}/m3-scope.png` });
  if (!(await page.evaluate(() => document.getElementById("scope").classList.contains("on")))) errors.push("mobile: aiming the sniper did not show the scope");
  await tap("#t-ads", 6);
  await tap("#slot-0", 7);
  await step(300);

  // The map button opens the map, and the map's own close button (the map covers the
  // map button) closes it again, both by a tap.
  const mapOpen = () => page.evaluate(() => !document.getElementById("map").hidden);
  await tap("#t-map", 8);
  await step(200);
  if (!(await mapOpen())) errors.push("mobile: the map button did not open the map");
  await page.screenshot({ path: `${out}/m4-map.png` });
  await tap("#map-close", 9);
  await step(200);
  if (await mapOpen()) errors.push("mobile: the map's close button did not close it");
  // The pause button lives on the open map (automation never pauses, so only the tap closing the map shows here).
  await tap("#t-map", 10);
  await step(200);
  await tap("#map-pause", 11);
  await step(200);
  if (await mapOpen()) errors.push("mobile: the map's pause button did not take the map away");

  // The ult button leaps: up into the sky, then a glide down.
  const g0 = await read();
  await page.evaluate(() => window.ringfallChargeUlt());
  await tap("#t-ult", 12);
  await step(900);
  const g1 = await read();
  await page.screenshot({ path: `${out}/m5-leap.png` });
  if (!g1.player.leap || !(g1.player.y > g0.player.y + 10)) errors.push(`mobile: the ult button did not leap (${JSON.stringify(g1.player)})`);
  for (let i = 0; i < 60 && (await read()).player.leap; i++) await step(250);
  if ((await read()).player.leap) errors.push("mobile: the leap never came down");

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
  // Edge to edge on a phone: drawn under the notch and home bar (the HUD keeps clear by the
  // safe-area insets), and installable to the home screen as a landscape full-screen app.
  if (!/viewport-fit=cover/.test(zoom.meta)) errors.push("mobile: the viewport does not cover the whole screen");
  const manifest = await page.evaluate(async () => {
    const link = document.querySelector('link[rel="manifest"]');
    const r = link && (await fetch(link.href));
    return r?.ok ? r.json() : null;
  });
  if (manifest?.display !== "fullscreen" || manifest?.orientation !== "landscape") errors.push(`mobile: no landscape full-screen manifest (${JSON.stringify(manifest)})`);

  // The bot plays to the first fight for a screenshot of the touch layout.
  await page.evaluate((s) => window.ringfallBot(s), skill);
  for (let i = 0; i < 900; i++) {
    await step(100);
    const st = await read();
    if (st.enemies.filter((e) => e.aware === "engaged" && e.mode !== "spawning").length >= 2 && st.orbs >= 1) break;
  }
  await page.screenshot({ path: `${out}/m2-fight.png` });
  console.log(`mobile: stick ${s0.player.z} -> ${s1.player.z}, yaw ${yaw0.toFixed(2)} -> ${yaw1.toFixed(2)}, shots ${shots0} -> ${shots1}`);
  console.log(`mobile reservoir frame: ${JSON.stringify(await page.evaluate(() => window.ringfallFrameCost(20)))}`);
  await ctx.close();
}

/*
 * Phone again, dropping into the harbor: the base's landing choice works by touch, the raid
 * starts over the harbor, and the map shows both regions.
 */
{
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`mobile harbor pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !/fonts\.g|ERR_TUNNEL|net::/.test(m.text()) && errors.push(`mobile harbor console: ${m.text()}`));
  await page.goto(`http://localhost:${port}/ringfall/`, { waitUntil: "load" });
  await page.waitForTimeout(400);
  await page.evaluate(() => Object.defineProperty(screen, "orientation", { value: undefined, configurable: true }));
  await page.tap("#start");
  await page.waitForTimeout(200);
  await page.tap("#hub-region [data-arg=harbor]");
  await page.waitForTimeout(100);
  await page.screenshot({ path: `${out}/m6-hub-harbor.png` });
  await page.tap("#hub-free");
  const read = async () => JSON.parse(await page.evaluate(() => window.render_game_to_text()));
  const step = (ms) => page.evaluate((t) => window.advanceTime(t), ms);
  for (let i = 0; i < 80 && (await read()).phase === "drop"; i++) await step(100);
  const st = await read();
  if (st.region !== "harbor" || !(st.player.z < -250)) errors.push(`mobile harbor: the raid landed in ${st.region} at ${st.player.x},${st.player.z}`);
  await step(300);
  await page.screenshot({ path: `${out}/m7-harbor-landed.png` });
  const bb = await page.locator("#t-map").boundingBox();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: bb.x + bb.width / 2, y: bb.y + bb.height / 2, id: 1 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await step(200);
  await page.screenshot({ path: `${out}/m8-map-harbor.png` });
  console.log(`mobile harbor frame: ${JSON.stringify(await page.evaluate(() => window.ringfallFrameCost(20)))}`);
  await ctx.close();
}

// Without pointer lock (a sandboxed frame), the mouse still turns the view.
{
  const p2 = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  p2.on("pageerror", (e) => errors.push(`no-lock pageerror: ${e.message}`));
  await p2.addInitScript(() => {
    Element.prototype.requestPointerLock = undefined;
  });
  await p2.goto(`http://localhost:${port}/ringfall/`, { waitUntil: "load" });
  await p2.click("#start");
  await p2.click("#hub-free");
  await p2.waitForTimeout(300);
  const y0 = await p2.evaluate(() => window.ringfallYaw());
  await p2.mouse.move(640, 360);
  await p2.mouse.move(840, 360, { steps: 10 });
  await p2.waitForTimeout(300);
  const y1 = await p2.evaluate(() => window.ringfallYaw());
  if (!(Math.abs(y1 - y0) > 0.05)) errors.push(`no pointer lock: the mouse did not turn the view (${y0.toFixed(2)} -> ${y1.toFixed(2)})`);
  await p2.close();
}

const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => m.type() === "error" && !/fonts\.g|ERR_TUNNEL|net::/.test(m.text()) && errors.push(`console: ${m.text()}`));
await page.goto(`http://localhost:${port}/ringfall/`, { waitUntil: "load" });
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/00-title.png` });
await page.click("#start");
const read = async () => JSON.parse(await page.evaluate(() => window.render_game_to_text()));

// The base: buy a rare PIKE from the trader, then take it and a stash weapon into the raid.
{
  const h0 = await read();
  if (h0.screen !== "hub") errors.push(`hub: the start button opened ${h0.screen}, not the base`);
  await page.screenshot({ path: `${out}/00-hub.png` });
  await page.click('#hub [data-act=tab][data-arg=shop]');
  await page.click('#hub-side [data-act=buy][data-arg="1"]');
  const h1 = await read();
  if (!(h1.profile.cash < h0.profile.cash && h1.profile.stash === h0.profile.stash + 1)) errors.push(`hub: buying did not take cash and fill the stash (${JSON.stringify(h0.profile)} -> ${JSON.stringify(h1.profile)})`);
  await page.screenshot({ path: `${out}/00-hub-shop.png` });
  await page.click('#hub [data-act=tab][data-arg=quests]');
  const quests = await page.locator("#hub-side .quest").count();
  if (quests !== 2) errors.push(`hub: the trader offers ${quests} quests at the start, not 2`);
  await page.screenshot({ path: `${out}/00-hub-quests.png` });
  await page.click('#hub [data-act=tab][data-arg=kit]');
  const picks = page.locator("#hub-stash [data-act=pick]");
  await picks.nth(2).click();
  await picks.nth(1).click();
  await page.screenshot({ path: `${out}/00-hub-kit.png` });
  // The landing choice: the harbor shows its line, and the raid below drops into the reservoir.
  await page.click("#hub-region [data-arg=harbor]");
  await page.screenshot({ path: `${out}/00-hub-region.png` });
  if (!/港/.test(await page.evaluate(() => document.getElementById("hub-region").textContent))) errors.push("hub: the harbor's line did not show");
  await page.click("#hub-region [data-arg=reservoir]");
  await page.click("#hub-go");
  const h2 = await read();
  if (h2.screen !== "game") errors.push(`hub: deploying did not start the raid (${h2.screen})`);
  if (h2.player.weapons.join() !== "pike1:-1,hornet0:-1") errors.push(`hub: the raid did not start with the picked weapons (${h2.player.weapons.join()})`);
  if (h2.profile.stash !== h1.profile.stash - 2) errors.push(`hub: the picked weapons stayed in the stash (${h1.profile.stash} -> ${h2.profile.stash})`);
}

// Real keyboard input must reach the sim: holding W during the drop moves the player north.
const before = await read();
await page.keyboard.down("KeyW");
await page.evaluate(() => window.advanceTime(600));
await page.keyboard.up("KeyW");
const after = await read();
if (!(after.player.z < before.player.z - 3)) errors.push(`keyboard: W did not move the player (${before.player.z} -> ${after.player.z})`);
await page.screenshot({ path: `${out}/01-drop.png` });
// The drop banner sends the player to the map (M), since the HUD has no markers to follow.
const dropBanner = await page.evaluate(() => document.getElementById("banner").textContent);
if (!/地図/.test(dropBanner) || /目印/.test(dropBanner)) errors.push(`drop banner does not point at the map: ${dropBanner}`);

// A tour of the island's buildings and high ground, from fixed cameras.
await page.evaluate(() => {
  document.getElementById("hud").hidden = true;
  document.getElementById("banner").className = "";
});
await page.waitForTimeout(400);
const tour = [
  ["tour-1-lakebed-from-dam", 0, 11.6, -77, Math.PI, -0.25],
  ["tour-2-dam-face", 0, -5.4, -40, 0, 0.22],
  ["tour-3-town-street", 0, -5.4, 36, 0, 0.05],
  ["tour-4-east-ramp", 16, -5.4, 4, 1.3, 0.1],
  ["tour-5-spillway", 52, -8.4, -78, 0, 0.3],
  ["tour-6-quarry-pit", -84, -2.4, 44, -0.63, -0.15],
  ["tour-7-high-rise-view", -2.5, 11.6, -10.2, Math.PI, -0.3],
  ["tour-8-plateau-over-lakebed", -40, 6.4, -46, 1.57, -0.15],
  ["tour-9-ridge", -50, 10.1, 70, -1.57, -0.1],
  ["tour-10-over-supply", 45, 34, 104, -1.57, -0.35],
  ["tour-11-mesa-relay", 66, 8.6, -30, 1.57, 0.02],
];
for (const [name, x, y, z, yaw, pitch] of tour) {
  await page.evaluate(([x, y, z, yaw, pitch]) => window.ringfallCamera(x, y, z, yaw, pitch), [x, y, z, yaw, pitch]);
  await page.screenshot({ path: `${out}/${name}.png` });
}
// The harbor and the ways there. Heights are above the ground at the camera, or absolute (a deck, a roof).
const harborTour = [
  ["tour-12-pass-saddle", -60, 1.7, -228, 0.05, -0.05],
  ["tour-13-railway-bridge", 100, 1.7, -191, 1.45, 0.32],
  ["tour-14-bridge-deck", 122, 11.8, -168, 0, -0.04, true],
  ["tour-15-viaduct", 112, 1.7, -352, -1.57, 0.12],
  ["tour-16-wreck", -2, 1.7, -522, 0.12, 0.1],
  ["tour-17-wreck-deck", -30, 8.8, -560, 1.5, 0.02, true],
  ["tour-18-yard-alley", -138, 1.7, -413.5, 1.57, 0.02],
  ["tour-19-yard-crane", -100, 15.4 + 1.6, -405, 3.1, -0.42, true],
  ["tour-20-smelter", 118, 1.7, -384, 0, 0.18],
  ["tour-21-lighthouse", -66, 1.7, -514, -0.97, 0.22],
  ["tour-22-lighthouse-view", -114, 33.5, -551, 1.5, -0.22, true],
  ["tour-23-salt-flats", -40, 1.7, -468, 0.75, 0.0],
  ["tour-24-quay-boat", 70, 1.7, -566, 1.57, -0.05],
];
for (const [name, x, dy, z, yaw, pitch, abs] of harborTour) {
  const y = abs ? dy : (await page.evaluate(([x, z]) => window.ringfallTerrain(x, z), [x, z])) + dy;
  await page.evaluate(([x, y, z, yaw, pitch]) => window.ringfallCamera(x, y, z, yaw, pitch), [x, y, z, yaw, pitch]);
  await page.screenshot({ path: `${out}/${name}.png` });
}
await page.evaluate(() => {
  window.ringfallCamera();
  document.getElementById("hud").hidden = false;
});

// Land, then knock the teammate down and pick it up by hand: its tag and the prompt
// show, one press of E starts the help, and it stands up after standing by it.
for (let i = 0; i < 100 && (await read()).phase === "drop"; i++) await page.evaluate(() => window.advanceTime(200));
// The teammate up close, from a fixed camera in front of it.
const mate = (await read()).ally;
await page.evaluate((a) => {
  document.getElementById("hud").hidden = true;
  window.ringfallCamera(a.x + 2.2, a.y + 1.5, a.z - 2.2, -2.36, -0.12);
}, mate);
await page.screenshot({ path: `${out}/18-teammate.png` });
await page.evaluate(() => {
  window.ringfallCamera();
  document.getElementById("hud").hidden = false;
});
await page.evaluate(() => window.ringfallDownAlly());
await page.evaluate(() => window.advanceTime(300));
await page.screenshot({ path: `${out}/18-teammate-down.png` });
const downUi = await page.evaluate(() => ({ prompt: document.getElementById("prompt").textContent, tag: getComputedStyle(document.getElementById("mate-tag")).display, row: document.getElementById("mate-state").textContent }));
if (!/リオを起こす/.test(downUi.prompt) || downUi.tag === "none" || !/ダウン/.test(downUi.row)) errors.push(`teammate down: HUD did not show it (${JSON.stringify(downUi)})`);
await page.keyboard.press("KeyE");
await page.evaluate(() => window.advanceTime(3400));
const helped = await read();
if (helped.ally.down > 0 || helped.stats.allyHelped !== 1) errors.push(`teammate down: E did not pick it up (${JSON.stringify(helped.ally)})`);

// The ult: leap with the teammate beside, glide forward, and land together.
const l0 = await read();
await page.evaluate(() => window.ringfallChargeUlt());
await page.keyboard.press("KeyZ");
await page.keyboard.down("KeyW");
await page.evaluate(() => window.advanceTime(1600));
await page.screenshot({ path: `${out}/07-leap.png` });
const l1 = await read();
if (!l1.player.leap || !(l1.player.y > l0.player.y + 15)) errors.push(`leap: Z did not leap (${JSON.stringify(l1.player)})`);
for (let i = 0; i < 60 && (await read()).player.leap; i++) await page.evaluate(() => window.advanceTime(250));
await page.keyboard.up("KeyW");
const l2 = await read();
const glided = Math.hypot(l2.player.x - l0.player.x, l2.player.z - l0.player.z);
const mateGap = Math.hypot(l2.ally.x - l2.player.x, l2.ally.z - l2.player.z);
if (l2.player.leap || glided < 30 || mateGap > 4) errors.push(`leap: landed ${l2.player.leap ? "never" : ""} ${glided.toFixed(0)} m away, teammate ${mateGap.toFixed(1)} m off`);
await page.screenshot({ path: `${out}/07-leap-landed.png` });

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
  const key = `${s.phase}-${s.cleared.join("")}-${s.enemies.length}-${s.loot}-${s.stats.kills}-${s.haul.value}`;
  if (key !== prevKey) {
    prevKey = key;
    lastProgress = s.time;
  }
  if (s.time - lastProgress > 90) throw new Error(`no progress for 90 s: ${JSON.stringify(s).slice(0, 600)}`);
  const live = s.enemies.filter((e) => e.mode !== "spawning" && e.aware === "engaged");
  const near = (e) => Math.hypot(e.x - s.player.x, e.z - s.player.z);
  const at = (poi) => live.some((e) => s.squads[e.squad].poi === poi);
  if (s.phase === "play" && !taken.has("02-landed")) {
    await shot("02-landed");
    // The ways off the island are open from the start and listed on the objective card.
    const lines = await page.evaluate(() => document.getElementById("obj-exits").children.length);
    if (lines !== 3) errors.push(`landed: the objective card lists ${lines} ways out, not 3`);
    // The map (M) is the only place that shows where the POIs and the ways out are.
    await page.keyboard.press("KeyM");
    await page.evaluate(() => window.advanceTime(100));
    const open = await page.evaluate(() => !document.getElementById("map").hidden);
    await shot("23-map");
    await page.keyboard.press("KeyM");
    await page.evaluate(() => window.advanceTime(100));
    const closed = await page.evaluate(() => document.getElementById("map").hidden);
    if (!open || !closed) errors.push(`map: M opened ${open}, closed again ${closed}`);
    console.log(`desktop reservoir frame: ${JSON.stringify(await page.evaluate(() => window.ringfallFrameCost(20)))}`);
    // A vault, from just in front of it: the locked crate reads apart from the supply bins.
    // The quarry's stands on an open terrace, so the camera has a clear view of it.
    const v = s.vaults.find((b) => b.poi === 1);
    if (s.vaults.length !== 7 || !v) errors.push(`vaults: ${s.vaults.length} in the world`);
    else {
      await page.evaluate((b) => window.ringfallCamera(b.x + 0.4, b.y + 1.6, b.z + 2.6, 0.12, -0.42), v);
      await shot("26-vault");
      await page.evaluate(() => window.ringfallCamera());
    }
  }
  if (at(0) && live.length >= 2 && s.orbs >= 1) await shot("03-fight-supply");
  if (s.stats.kills >= 3 && s.enemies.some((e) => e.mode !== "spawning" && e.hp < 60)) await shot("04-damage-numbers");
  if (s.stats.cleared.length >= 2 && !live.length && s.loot >= 3) await shot("05-loot");
  if (s.care && !s.care.landed) await shot("06-care-package");
  if (at(2) && live.some((e) => e.kind === "heavy") && s.orbs >= 2) await shot("08-relay-heavy");
  if (!live.length && s.enemies.some((e) => (e.aware === "alert" || e.detect > 0.3) && near(e) < 45)) await shot("14-noticed");
  if (s.player.reveal > 2) await shot("15-reveal");
  if (s.stats.flankHits > prevFlank && s.stats.flankHits >= 3) await shot("16-flank-hit");
  prevFlank = s.stats.flankHits;
  if (s.squads.some((q) => q.lost) && live.length) await shot("17-lost-track");
  if (live.some((e) => e.kind === "titan") && s.orbs >= 2) await shot("09-titan");
  if (s.waves > 0) await shot("10-stomp");
  if (s.player.downed) await shot("11-downed");
  if (s.ally.target && live.length >= 2 && Math.hypot(s.ally.x - s.player.x, s.ally.z - s.player.z) > 3) await shot("19-teammate-fight");
  if (s.extract.hold > 0 || s.extract.ship > 0) await shot("12-extract");
  if (s.extract.ship > 0 && live.length >= 2) await shot("20-ship-waves");
  if (s.reinforce.came > 0 && live.some((e) => s.squads[e.squad].name === "増援")) await shot("21-reinforce");
  if (s.haul.value >= 1000 && !live.length) await shot("22-haul");
  if (s.search) await shot("24-search");
  if (s.enemies.some((e) => s.squads[e.squad].name === "レイダー" && e.mode !== "spawning" && near(e) < 40)) await shot("25-raiders");
  if (s.phase === "done") break;
}
// The bot can be wiped out now that robots hit hard; a raid that ends either way has played through.
// Getting off the island is checked by the sim's extraction scenarios.
if (s.phase !== "done" || !s.outcome) errors.push(`run did not finish: ${JSON.stringify(s).slice(0, 300)}`);
console.log(`outcome: ${s.outcome}`);
await page.waitForTimeout(1800);
await page.screenshot({ path: `${out}/13-results.png` });
console.log(JSON.stringify((await read()).stats));
// The results on a phone on its side: both columns and the button fit the screen.
{
  await page.setViewportSize({ width: 740, height: 360 });
  await page.waitForTimeout(300);
  const fit = await page.evaluate(() => {
    const out = [];
    for (const id of ["home", "restart", "stats", "pois"]) {
      const r = document.getElementById(id).getBoundingClientRect();
      if (r.width && (r.right > innerWidth + 1 || r.bottom > innerHeight + 1)) out.push(`${id} ${Math.round(r.right)}x${Math.round(r.bottom)}`);
    }
    return out;
  });
  if (fit.length) errors.push(`results on a phone: ${fit.join(", ")} past the 740x360 screen`);
  await page.screenshot({ path: `${out}/m9-results.png` });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.waitForTimeout(200);
}
{
  const r = await read();
  if (!r.settled) errors.push("results: the raid was not settled into the profile");
  await page.click("#restart");
  const h = await read();
  if (h.screen !== "hub" || h.profile.raids !== 1) errors.push(`results: back to base shows ${h.screen} with ${h.profile.raids} raids`);
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${out}/14-hub-after.png` });
}

// A second raid, into the harbor: the bot (still at the controls) drops there and plays to its first fight.
{
  await page.click("#hub-region [data-arg=harbor]");
  await page.screenshot({ path: `${out}/27-hub-harbor.png` });
  await page.click("#hub-free");
  await page.evaluate(() => window.advanceTime(1500));
  await page.screenshot({ path: `${out}/28-harbor-drop.png` });
  for (let i = 0; i < 100 && (await read()).phase === "drop"; i++) await page.evaluate(() => window.advanceTime(200));
  const h = await read();
  if (h.region !== "harbor" || !(h.player.z < -250) || h.phase !== "play") errors.push(`harbor raid: landed in ${h.region} at ${h.player.x},${h.player.z} (${h.phase})`);
  await page.evaluate(() => window.advanceTime(400));
  await page.screenshot({ path: `${out}/29-harbor-landed.png` });
  const lines = await page.evaluate(() => document.getElementById("obj-exits").children.length);
  if (lines !== 1) errors.push(`harbor raid: the objective card lists ${lines} ways out, not the boat alone`);
  console.log(`desktop harbor frame: ${JSON.stringify(await page.evaluate(() => window.ringfallFrameCost(20)))}`);
  await page.keyboard.press("KeyM");
  await page.evaluate(() => window.advanceTime(100));
  await page.screenshot({ path: `${out}/30-map-harbor.png` });
  await page.keyboard.press("KeyM");
  let fought = false;
  for (let i = 0; i < 3000 && !fought; i++) {
    await page.evaluate(() => window.advanceTime(100));
    const st = await read();
    if (st.phase !== "play") break;
    fought = st.enemies.filter((e) => e.aware === "engaged" && e.mode !== "spawning").length >= 1 && st.orbs >= 1;
  }
  await page.screenshot({ path: `${out}/31-harbor-fight.png` });
  const end = await read();
  console.log(`harbor raid: fought ${fought}, cleared ${end.stats.cleared.join(",") || "-"}, at ${end.player.x},${end.player.z}`);
}
console.log(`screens: ${[...taken].join(", ")}`);
await browser.close();
server.close();
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("no console errors");
