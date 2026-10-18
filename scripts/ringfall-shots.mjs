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
/** Where the game keeps its profile (src/ringfall/meta/storage.ts). */
const KEY = "ringfall.profile.v1";
/** A save from before ways in were learned: it loads knowing every way in, so a start in the harbor can be chosen. */
const KNOWS_ALL = JSON.stringify({ v: 10, cash: 1500, stash: [], raids: 0, extracted: 0, region: "reservoir" });
await mkdir(out, { recursive: true });

const skill = process.argv[2] ?? "casual";
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const errors = [];

/*
 * Drawing a frame in software is most of what a step costs, so stretches that only wait on the
 * state step without drawing (window.ringfallStep). The scene is drawn before every screenshot
 * and frame-cost report, at the end of every such stretch, and every DRAW_EVERY steps within one,
 * so an error that drawing raises still shows up in the console while what it drew is on screen.
 */
const DRAW_EVERY = 10;
/** One undrawn step and the state after it, in one round trip. */
const quietStep = async (pg, ms) =>
  JSON.parse(await pg.evaluate((t) => (window.ringfallStep(t), window.render_game_to_text()), ms));
const draw = (pg) => pg.evaluate(() => window.ringfallDraw());
/** Undrawn steps while `going(state)` holds, at most `max`; draws as above. The state at the end. */
const stepWhile = async (pg, ms, max, going) => {
  let st = JSON.parse(await pg.evaluate(() => window.render_game_to_text()));
  for (let i = 0; i < max && going(st); i++) {
    st = await quietStep(pg, ms);
    if ((i + 1) % DRAW_EVERY === 0) await draw(pg);
  }
  await draw(pg);
  return st;
};
let lapAt = Date.now();
/** Wall time per section, to see where the gate's time goes. */
const lap = (name) => {
  const now = Date.now();
  console.log(`time: ${name} ${((now - lapAt) / 1000).toFixed(1)} s`);
  lapAt = now;
};

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

  // Turn the view by dragging on the right half.
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
  // It opens on the region the player is in; its own button shows the whole world, and back.
  const mapAspect = () => page.evaluate(() => +getComputedStyle(document.getElementById("map-canvas")).getPropertyValue("--map-aspect"));
  const regionAspect = await mapAspect();
  await tap("#map-zoom", 12);
  await step(200);
  const worldAspect = await mapAspect();
  if (!(worldAspect < regionAspect * 0.8)) errors.push(`mobile: the map's zoom button did not show the whole world (shape ${regionAspect.toFixed(2)} -> ${worldAspect.toFixed(2)})`);
  await page.screenshot({ path: `${out}/m4-map-world.png` });
  await tap("#map-zoom", 13);
  await step(200);
  if ((await mapAspect()) !== regionAspect) errors.push("mobile: the map's zoom button did not go back to the region");
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
  if ((await stepWhile(page, 250, 60, (st) => st.player.leap)).player.leap) errors.push("mobile: the leap never came down");

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
    const st = await quietStep(page, 100);
    if (st.enemies.filter((e) => e.aware === "engaged" && e.mode !== "spawning").length >= 2 && st.orbs >= 1) break;
    if ((i + 1) % DRAW_EVERY === 0) await draw(page);
  }
  await draw(page);
  await page.screenshot({ path: `${out}/m2-fight.png` });
  console.log(`mobile: stick ${s0.player.z} -> ${s1.player.z}, yaw ${yaw0.toFixed(2)} -> ${yaw1.toFixed(2)}, shots ${shots0} -> ${shots1}`);
  console.log(`mobile reservoir frame: ${JSON.stringify(await page.evaluate(() => window.ringfallFrameCost(20)))}`);
  await ctx.close();
  lap("phone, reservoir");
}

/*
 * Phone again, starting in the harbor: the base's choice of region and way in works by touch,
 * the raid starts on the ground at that way in, and the map shows both regions.
 */
// A fresh profile on a phone on its side: the harbor is locked, and the base still says how to open it.
{
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`mobile fresh pageerror: ${e.message}`));
  await page.goto(`http://localhost:${port}/ringfall/`, { waitUntil: "load" });
  await page.waitForTimeout(400);
  await page.evaluate(() => Object.defineProperty(screen, "orientation", { value: undefined, configurable: true }));
  await page.tap("#start");
  await page.waitForTimeout(200);
  const lock = await page.evaluate(() => {
    const el = document.querySelector("#hub-lock");
    return el && !el.hidden && el.textContent ? getComputedStyle(el).display : "missing";
  });
  if (lock === "none" || lock === "missing") errors.push(`mobile: the locked region's hint is not shown (${lock})`);
  await page.screenshot({ path: `${out}/m7-hub-locked.png` });
  await ctx.close();
}
{
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`mobile harbor pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !/fonts\.g|ERR_TUNNEL|net::/.test(m.text()) && errors.push(`mobile harbor console: ${m.text()}`));
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [KEY, KNOWS_ALL]);
  await page.goto(`http://localhost:${port}/ringfall/`, { waitUntil: "load" });
  await page.waitForTimeout(400);
  await page.evaluate(() => Object.defineProperty(screen, "orientation", { value: undefined, configurable: true }));
  await page.tap("#start");
  await page.waitForTimeout(200);
  await page.tap("#hub-region [data-arg=harbor]");
  await page.waitForTimeout(100);
  await page.tap("#hub-region [data-act=entry][data-arg=quay]");
  await page.waitForTimeout(100);
  await page.screenshot({ path: `${out}/m6-hub-harbor.png` });
  await page.tap("#hub-free");
  const read = async () => JSON.parse(await page.evaluate(() => window.render_game_to_text()));
  const step = (ms) => page.evaluate((t) => window.advanceTime(t), ms);
  const st = await read();
  // The quay's way in lies at the harbor's north-east, past the town and the wreck.
  if (st.region !== "harbor" || st.phase !== "play" || !(st.player.z < -800 && st.player.x > 100)) errors.push(`mobile harbor: the raid started in ${st.region} at ${st.player.x},${st.player.z} (${st.phase})`);
  await step(300);
  await page.screenshot({ path: `${out}/m7-harbor-start.png` });
  const bb = await page.locator("#t-map").boundingBox();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: bb.x + bb.width / 2, y: bb.y + bb.height / 2, id: 1 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await step(200);
  await page.screenshot({ path: `${out}/m8-map-harbor.png` });
  console.log(`mobile harbor frame: ${JSON.stringify(await page.evaluate(() => window.ringfallFrameCost(20)))}`);
  // The same view drawn at the cheaper tiers: what the governor falls back to on a phone that
  // cannot hold 60 fps. Logged only; software drawing's times say nothing absolute.
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: bb.x + bb.width / 2, y: bb.y + bb.height / 2, id: 1 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  for (const tier of ["high", "medium", "low"]) {
    await page.evaluate((t) => window.ringfallQuality(t), tier);
    await step(100);
    console.log(`mobile harbor frame (${tier}): ${JSON.stringify(await page.evaluate(() => window.ringfallFrameCost(20)))}`);
    await page.screenshot({ path: `${out}/m9-harbor-${tier}.png` });
  }
  await ctx.close();
  lap("phone, harbor");
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
  lap("no pointer lock");
}

// A fresh profile walks to a way in it does not know: the toast says it is remembered, the camp marks it, and the map tells it from those still unknown.
{
  const pg = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  pg.on("pageerror", (e) => errors.push(`way in pageerror: ${e.message}`));
  pg.on("console", (m) => m.type() === "error" && !/fonts\.g|ERR_TUNNEL|net::/.test(m.text()) && errors.push(`way in console: ${m.text()}`));
  await pg.goto(`http://localhost:${port}/ringfall/`, { waitUntil: "load" });
  await pg.click("#start");
  await pg.click("#hub-free");
  await pg.evaluate(() => window.advanceTime(100));
  // The east checkpoint's way in (470, -30) faces west: stand 8 m inside it, looking out at its camp.
  await pg.evaluate(() => window.ringfallPlace(462, -30, Math.PI / 2));
  await pg.evaluate(() => window.advanceTime(300));
  const st = JSON.parse(await pg.evaluate(() => window.render_game_to_text()));
  const toast = await pg.evaluate(() => document.getElementById("toasts").textContent);
  if (st.found.join() !== "beach,checkpoint" || !/この場所を覚えた：東の検問道/.test(toast)) errors.push(`way in: walking to the checkpoint found ${st.found.join()}, toast "${toast}"`);
  await pg.screenshot({ path: `${out}/32-entry-found.png` });
  await pg.keyboard.press("KeyM");
  await pg.evaluate(() => window.advanceTime(100));
  await pg.screenshot({ path: `${out}/33-map-entries.png` });
  await pg.keyboard.press("KeyN");
  await pg.evaluate(() => window.advanceTime(100));
  await pg.screenshot({ path: `${out}/34-map-entries-whole.png` });
  await pg.close();
  lap("way in found");
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
  // The start choice: the harbor shows its line, and the raid below starts in the reservoir.
  // A fresh profile knows only the reservoir's first way in: the harbor is shown locked, with how to open it.
  const harborLocked = await page.locator("#hub-region button.locked").count();
  const entriesOffered = await page.locator("#hub-region [data-act=entry]").count();
  await page.screenshot({ path: `${out}/00-hub-region.png` });
  if (harborLocked !== 1 || entriesOffered !== 1 || !/港湾地帯：峠/.test(await page.evaluate(() => document.getElementById("hub-lock").textContent))) errors.push(`hub: a fresh profile offers ${entriesOffered} ways in and ${harborLocked} locked regions, or the harbor's hint did not show`);
  await page.click("#hub-go");
  const h2 = await read();
  if (h2.screen !== "game") errors.push(`hub: deploying did not start the raid (${h2.screen})`);
  // The magazine is left out: the frame loop may already have stepped the raid and loaded it.
  if (h2.player.weapons.map((w) => w?.split(":")[0]).join() !== "pike1,hornet0") errors.push(`hub: the raid did not start with the picked weapons (${h2.player.weapons.join()})`);
  if (h2.profile.stash !== h1.profile.stash - 2) errors.push(`hub: the picked weapons stayed in the stash (${h1.profile.stash} -> ${h2.profile.stash})`);
  lap("base");
}

// Real keyboard input must reach the sim: holding W at the start moves the player north (the beach faces north).
const before = await read();
await page.keyboard.down("KeyW");
await page.evaluate(() => window.advanceTime(600));
await page.keyboard.up("KeyW");
const after = await read();
if (!(after.player.z < before.player.z - 3)) errors.push(`keyboard: W did not move the player (${before.player.z} -> ${after.player.z})`);
await page.screenshot({ path: `${out}/01-start.png` });
// The start's banner names the way in and sends the player to the map (M), since the HUD has no markers to follow.
const startBanner = await page.evaluate(() => document.getElementById("banner").textContent);
if (!/地図/.test(startBanner) || /目印/.test(startBanner) || !/南の浜/.test(startBanner)) errors.push(`start banner does not name the way in and point at the map: ${startBanner}`);

// A tour of the island's buildings and high ground, from fixed cameras.
await page.evaluate(() => {
  document.getElementById("hud").hidden = true;
  document.getElementById("banner").className = "";
});
await page.waitForTimeout(400);
// A camera written in the frame of a POI (by its id), a hamlet (by its name) or an area ("area:" and its id): [x, y, z].
const frames = await page.evaluate(() => window.ringfallFrames());
const at = (frame, dx, y, dz) => [frames[frame].x + dx, y, frames[frame].z + dz];
const tour = [
  // The reservoir, at eye height unless marked absolute (a crest, a floor up a tower).
  ["tour-1-lakebed-from-dam", ...at("area:heart", 0, 17.7, -120), Math.PI, -0.25, true],
  ["tour-2-dam-face", ...at("area:heart", 0, 1.7, -70), 0, 0.25],
  ["tour-3-town-street", ...at("area:heart", 0, 1.7, 45), 0, 0.05],
  ["tour-4-church-spire", ...at("area:heart", -5, 1.7, 15), -0.7, 0.3],
  ["tour-5-spillway", ...at("area:heart", 112, 1.7, -108), 0, 0.15],
  ["tour-6-quarry-pit", ...at("quarry", 20, 1.7, -75), Math.PI, -0.3],
  ["tour-7-high-rise-view", ...at("area:heart", -26, 4.6, -14), 2.5, -0.25, true],
  ["tour-8-plateau-over-lakebed", ...at("area:heart", -95, 1.7, -5), 1.57, -0.15],
  ["tour-9-terraced-fields", ...at("village", 60, 1.7, 75), -0.66, 0.08],
  ["tour-10-over-supply", ...at("supply", 130, 45, -120), -2.32, -0.3, true],
  ["tour-11-mesa-relay", ...at("relay", -50, 1.7, 25), 1.08, 0.3],
];
for (const [name, x, dy, z, yaw, pitch, abs] of tour) {
  const y = abs ? dy : (await page.evaluate(([x, z]) => window.ringfallTerrain(x, z), [x, z])) + dy;
  await page.evaluate(([x, y, z, yaw, pitch]) => window.ringfallCamera(x, y, z, yaw, pitch), [x, y, z, yaw, pitch]);
  await page.screenshot({ path: `${out}/${name}.png` });
}
// The harbor and the ways there. Heights are above the ground at the camera, or absolute (a deck, a roof).
const harborTour = [
  ["tour-12-pass-saddle", ...at("area:pass", -60, 1.7, -228), 0.05, -0.05],
  ["tour-13-railway-bridge", ...at("area:railway", 100, 1.7, -191), 1.45, 0.32],
  ["tour-14-bridge-deck", ...at("area:railway", 122, 11.8, -168), 0, -0.04, true],
  // Under the viaduct's corner, looking west along it.
  ["tour-15-viaduct", 165, 1.7, -622, -1.42, 0.16],
  ["tour-16-wreck", ...at("wreck", -12, 1.7, 40), 0.12, 0.1],
  ["tour-17-wreck-deck", ...at("wreck", -50, 8.8, 2), 1.5, 0.02, true],
  ["tour-18-yard-alley", ...at("yard", -38, 1.7, -13.5), 1.57, 0.02],
  ["tour-19-yard-crane", ...at("yard", 24, 13.6 + 1.6, -5), 3.1, -0.42, true],
  ["tour-20-smelter", ...at("smelter", -22, 1.7, 32), 0.4, 0.16],
  ["tour-21-lighthouse", ...at("area:bay", -66, 1.7, -514), -0.97, 0.22],
  ["tour-22-lighthouse-view", ...at("area:bay", -112.9, 33.4, -552), 1.45, -0.2, true],
  ["tour-23-salt-flats", ...at("area:bay", -40, 1.7, -468), 0.75, 0.0],
  ["tour-24-quay-boat", ...at("area:bay", 94, 1.7, -578), 1.32, -0.1],
  // The open ground between the areas, its outcrops and hamlets.
  ["tour-25-open-ground", 60, 1.7, 250, -0.3, 0.0],
  ["tour-26-west-farm", ...at("西の農場", 20, 1.7, 18), -0.84, 0.05],
  ["tour-27-water-tower", ...at("給水所", -25, 1.7, -20), 2.24, 0.08],
  ["tour-28-checkpoint", ...at("東の検問所", -25, 5, 17), 0.97, -0.08],
  ["tour-29-fishing-village", ...at("西の漁村", 25, 1.7, 20), -0.9, 0.05],
  ["tour-30-signal-box", ...at("信号所", 20, 1.7, 20), -0.79, 0.08],
  ["tour-31-reservoir-from-above", 0, 150, 560, 0, -0.36, true],
  // The routes' obstacles, all closed in this fresh profile: the tunnel's two choked mouths,
  // the dam's chained gallery door, the wreck's gangway hauled up against its hull.
  ["tour-32-tunnel-rubble", 40, 1.7, -287, 0, 0.12],
  ["tour-33-tunnel-rubble-north", 40, 1.7, -422, Math.PI, 0.12],
  ["tour-34-dam-gate", ...at("area:heart", 20, 1.7, -97), 0, 0.12],
  // The open ground north of the landing pad, toward the mountains, and the harbor's south plain from the pass.
  ["tour-36-north-of-pad", ...at("pad", -30, 1.7, -110), 0.2, 0.05],
  ["tour-37-harbor-plain", -96, 1.7, -440, 0.3, -0.04],
  ["tour-35-gangway-hauled", ...at("wreck", -37, 1.7, -17), Math.PI - 0.45, 0.5],
  // Each POI's landmark from the way in, and the smelter's roofs from the bridge between its halls.
  ["tour-38-supply-silos", ...at("supply", 20, 1.7, 170), -0.16, 0.08],
  // The supply depot at its own scale, from eye height: the tanker's bow over the beach, the
  // street between the office block and the east warehouse, the yard from the east dune's crest.
  ["tour-46-supply-tanker-from-beach", ...at("supply", 30, 1.7, 160), 0.2, 0.15],
  ["tour-47-supply-street", ...at("supply", 10, 1.7, 0), 0, 0.06],
  ["tour-48-supply-dune-crest", ...at("supply", 90, 1.7, 22), -2.2, -0.04],
  ["tour-39-quarry-plant", ...at("quarry", -10, 1.7, 25), 0, 0.2],
  ["tour-40-relay-mast", ...at("relay", -20, 1.7, 20), 0.91, 0.35],
  ["tour-41-pad-hangars", ...at("pad", 0, 1.7, 60), 0, 0.1],
  // The reservoir's POIs and districts at their own scale, from eye height: the quarry's
  // terraces from its floor and its tunnel, the mesa from its foot and from its ledge road,
  // the pad's runway, the intake tower before the dam, the fields from the hill and the
  // windmill, the sawtooth works and the car park, the drowned town from a roof.
  ["tour-49-quarry-from-floor", ...at("quarry", -30, 1.7, 30), 1.57, 0.2],
  ["tour-50-quarry-tunnel", ...at("quarry", -60, 1.7, 22), -1.57, 0.05],
  ["tour-51-mesa-from-foot", ...at("relay", -130, 1.7, 60), 1.2, 0.25],
  ["tour-52-mesa-ledge", ...at("relay", 30, 1.7, 52), -1.57, 0.05],
  ["tour-53-pad-runway", ...at("pad", 60, 1.7, -42), -1.57, 0.02],
  ["tour-54-intake-tower", ...at("area:heart", -20, 1.7, -60), -0.4, 0.35],
  ["tour-55-fields-from-hill", ...at("village", -10, 1.7, -50), Math.PI, -0.1],
  ["tour-56-windmill", ...at("village", -25, 1.7, -15), -0.2, 0.25],
  ["tour-57-factory-sawtooth", ...at("factory", -55, 1.7, 10), 0, 0.12],
  ["tour-58-housing-carpark", ...at("factory", 30, 1.7, 20), 0.6, 0.12],
  ["tour-59-drowned-roofs", ...at("area:heart", 10, -8.9, -20), 0.8, -0.05, true],
  ["tour-42-wreck-length", ...at("wreck", 40, 1.7, 50), -0.67, 0.12],
  ["tour-43-yard-gantries", ...at("yard", 0, 1.7, 60), 0, 0.12],
  ["tour-44-smelter-chimneys", ...at("smelter", 20, 1.7, 70), -0.28, 0.18],
  ["tour-45-smelter-roofs", ...at("smelter", -6, 3 + 13.6 + 1.7, -6), Math.PI / 2, -0.08, true],
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
lap("start and tour");

// Knock the teammate down and pick it up by hand: its tag and the prompt show, one press
// of E starts the help, and it stands up after standing by it.
// The keyboard check above walked the player off: stand the teammate beside them again, as a raid starts.
const here = (await read()).player;
await page.evaluate(([x, z]) => window.ringfallPlace(x, z, window.ringfallYaw()), [here.x, here.z]);
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
await stepWhile(page, 250, 60, (st) => st.player.leap);
await page.keyboard.up("KeyW");
const l2 = await read();
const glided = Math.hypot(l2.player.x - l0.player.x, l2.player.z - l0.player.z);
const mateGap = Math.hypot(l2.ally.x - l2.player.x, l2.ally.z - l2.player.z);
if (l2.player.leap || glided < 30 || mateGap > 4) errors.push(`leap: landed ${l2.player.leap ? "never" : ""} ${glided.toFixed(0)} m away, teammate ${mateGap.toFixed(1)} m off`);
await page.screenshot({ path: `${out}/07-leap-landed.png` });
lap("teammate and leap");

await page.evaluate((s) => window.ringfallBot(s), skill);
const taken = new Set();
const shot = async (name) => {
  if (taken.has(name)) return;
  taken.add(name);
  await draw(page);
  await page.screenshot({ path: `${out}/${name}.png` });
};
let prevKey = "";
let prevFlank = 0;
let lastProgress = 0;
// A kill is shot once the wreck has had time to fall over.
let prevKills = 0;
let wreckAt = -1;
let wreckSpot = null;
let prevEnemies = [];
let s = after;
for (let i = 0; i < 25 * 60 * 10; i++) {
  s = await quietStep(page, 100);
  if ((i + 1) % DRAW_EVERY === 0) await draw(page);
  const key = `${s.phase}-${s.cleared.join("")}-${s.enemies.length}-${s.loot}-${s.stats.kills}-${s.haul.value}`;
  if (key !== prevKey) {
    prevKey = key;
    lastProgress = s.time;
  }
  if (s.time - lastProgress > 90) {
    await draw(page);
    await page.screenshot({ path: `${out}/stall.png` });
    const near = s.enemies.filter((e) => Math.hypot(e.x - s.player.x, e.z - s.player.z) < 70);
    throw new Error(`no progress for 90 s: player ${JSON.stringify(s.player)} ally ${JSON.stringify(s.ally)} cleared ${s.cleared} near ${JSON.stringify(near)}`);
  }
  const live = s.enemies.filter((e) => e.mode !== "spawning" && e.aware === "engaged");
  const near = (e) => Math.hypot(e.x - s.player.x, e.z - s.player.z);
  const at = (poi) => live.some((e) => s.squads[e.squad].poi === poi);
  if (s.phase === "play" && !taken.has("02-start")) {
    await shot("02-start");
    // The ways off the island are open from the start and listed on the objective card.
    const lines = await page.evaluate(() => document.getElementById("obj-exits").children.length);
    if (lines !== 3) errors.push(`start: the objective card lists ${lines} ways out, not 3`);
    // The map (M) is the only place that shows where the POIs and the ways out are.
    await page.keyboard.press("KeyM");
    await page.evaluate(() => window.advanceTime(100));
    const open = await page.evaluate(() => !document.getElementById("map").hidden);
    await shot("23-map");
    // N shows the whole world, and back to the region the player is in.
    const shape = () => page.evaluate(() => +getComputedStyle(document.getElementById("map-canvas")).getPropertyValue("--map-aspect"));
    const regionShape = await shape();
    await page.keyboard.press("KeyN");
    await page.evaluate(() => window.advanceTime(100));
    const worldShape = await shape();
    await shot("23-map-world");
    await page.keyboard.press("KeyN");
    await page.evaluate(() => window.advanceTime(100));
    if (!(worldShape < regionShape * 0.8) || (await shape()) !== regionShape) errors.push(`map: N did not switch to the whole world and back (shape ${regionShape} -> ${worldShape})`);
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
    // The supply's vault guard, from 3 m in front of it (it faces west): its plate reads on its chest.
    const guard = s.enemies.find((e) => e.plate > 0 && s.squads[e.squad].poi === 0);
    if (!guard) errors.push("plates: the supply's vault guard wears none");
    else {
      const cx = guard.x - 3;
      await page.evaluate(([x, y, z, w]) => window.ringfallCamera(x, y, z, w, -0.05), [cx, guard.y + 1.5, guard.z, Math.atan2(guard.x - cx, 0)]);
      await shot("28-plate");
      await page.evaluate(() => window.ringfallCamera());
    }
  }
  if (at(0) && live.length >= 2 && s.orbs >= 1) await shot("03-fight-supply");
  // A robot reeling from a burst, close enough to see its pose.
  if (live.some((e) => e.mode === "staggered" && near(e) < 30)) await shot("32-stagger");
  if (s.stats.kills > prevKills && wreckAt < 0 && !taken.has("33-wreck")) {
    // The robot that is gone since the last step, nearest the player: that is where the wreck lies.
    const gone = prevEnemies.filter((o) => !s.enemies.some((e) => e.kind === o.kind && Math.hypot(e.x - o.x, e.z - o.z) < 2));
    gone.sort((a, b) => near(a) - near(b));
    if (gone[0] && gone[0].kind !== "drone") {
      wreckSpot = gone[0];
      wreckAt = s.time + 0.8;
    }
  }
  prevKills = s.stats.kills;
  prevEnemies = s.enemies;
  if (wreckAt >= 0 && s.time >= wreckAt) {
    // From 4 m off, a little above: the fallen body on the ground.
    const w = wreckSpot;
    const cx = w.x + 3;
    const cz = w.z + 3;
    await page.evaluate(([x, y, z, yaw]) => window.ringfallCamera(x, y, z, yaw, -0.32), [cx, w.y + 2.2, cz, Math.atan2(w.x - cx, -(w.z - cz))]);
    await shot("33-wreck");
    await page.evaluate(() => window.ringfallCamera());
    wreckAt = -1;
  }
  // A robot's shot in flight, seen from beside its path: fast shots are drawn as stretched bolts.
  // Read afresh: shots taken earlier in this step may have moved time on.
  const fresh = !taken.has("27-bolt") && s.bolt ? await read() : null;
  // A shot in a fight on the ground, near the player: not one fired up at the leap.
  const nearBolt = fresh?.bolt && Math.abs(fresh.bolt.y - fresh.player.y) < 4 && Math.hypot(fresh.bolt.x - fresh.player.x, fresh.bolt.z - fresh.player.z) < 40;
  if (nearBolt && Math.hypot(fresh.bolt.vx, fresh.bolt.vz) > 30) {
    const b = fresh.bolt;
    const sp = Math.hypot(b.vx, b.vy, b.vz);
    const ux = b.vx / sp;
    const uz = b.vz / sp;
    const hl = Math.hypot(ux, uz) || 1;
    // 3 m to the side of its path, level with it, looking straight at it.
    const cx = b.x + (-uz / hl) * 3;
    const cz = b.z + (ux / hl) * 3;
    const yaw = Math.atan2(b.x - cx, -(b.z - cz));
    console.log(`bolt at ${b.x.toFixed(1)},${b.y.toFixed(1)},${b.z.toFixed(1)} speed ${sp.toFixed(0)}, camera ${cx.toFixed(1)},${cz.toFixed(1)} yaw ${yaw.toFixed(2)}`);
    await page.evaluate(([x, y, z, w]) => window.ringfallCamera(x, y, z, w, 0), [cx, b.y, cz, yaw]);
    await shot("27-bolt");
    await page.evaluate(() => window.ringfallCamera());
  }
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
if (!taken.has("27-bolt")) errors.push("no robot shot was caught in flight for 27-bolt");
console.log(`outcome: ${s.outcome}`);
// A drawn step hands drawing back to the frame loop: the results are shot over the scene, and
// the phone-sized resize below clears the canvas, which only the frame loop draws again.
await page.evaluate(() => window.advanceTime(0));
lap("raid");
// The results come up a moment after the raid ends (on a timer of the page's own clock).
await page.waitForFunction(() => !document.getElementById("results").hidden, null, { timeout: 10000 }).catch(() => undefined);
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
  lap("results");
}

// A second raid, into the harbor: the bot starts at its first way in and plays to its first fight.
// The first raid did not walk to the harbor, so the save is made to know every way in, and the page reloaded to read it.
{
  await page.evaluate((k) => {
    const p = JSON.parse(localStorage.getItem(k));
    localStorage.setItem(k, JSON.stringify({ ...p, entries: ["beach", "checkpoint", "jetty", "outskirts", "quay", "shore"] }));
  }, KEY);
  await page.reload({ waitUntil: "load" });
  await page.click("#start");
  await page.evaluate((s) => window.ringfallBot(s), skill);
  await page.click("#hub-region [data-arg=harbor]");
  await page.screenshot({ path: `${out}/27-hub-harbor.png` });
  await page.click("#hub-free");
  await page.evaluate(() => window.advanceTime(1500));
  await draw(page);
  await page.screenshot({ path: `${out}/28-harbor-start.png` });
  const h = await read();
  if (h.region !== "harbor" || !(h.player.z < -400) || h.phase !== "play") errors.push(`harbor raid: started in ${h.region} at ${h.player.x},${h.player.z} (${h.phase})`);
  const lines = await page.evaluate(() => document.getElementById("obj-exits").children.length);
  if (lines !== 1) errors.push(`harbor raid: the objective card lists ${lines} ways out, not the boat alone`);
  console.log(`desktop harbor frame: ${JSON.stringify(await page.evaluate(() => window.ringfallFrameCost(20)))}`);
  await page.keyboard.press("KeyM");
  await page.evaluate(() => window.advanceTime(100));
  await page.screenshot({ path: `${out}/30-map-harbor.png` });
  await page.keyboard.press("KeyM");
  let fought = false;
  for (let i = 0; i < 3000 && !fought; i++) {
    const st = await quietStep(page, 100);
    if (st.phase !== "play") break;
    fought = st.enemies.filter((e) => e.aware === "engaged" && e.mode !== "spawning").length >= 1 && st.orbs >= 1;
    if ((i + 1) % DRAW_EVERY === 0) await draw(page);
  }
  await draw(page);
  await page.screenshot({ path: `${out}/31-harbor-fight.png` });
  const end = await read();
  console.log(`harbor raid: fought ${fought}, cleared ${end.stats.cleared.join(",") || "-"}, at ${end.player.x},${end.player.z}`);
  lap("harbor raid");
}
// The desktop page is done with; left open it draws the harbor every frame, and the pages
// below, each a fresh load, would share the machine with it.
await page.close();

/*
 * The hideout, from saved profiles: a mid-game base (the tab, a module's needs with where
 * they are found, building, the radio's report, the warning before selling a needed part)
 * on the desktop and a phone on its side, then the escape craft's last stage and the ending.
 */
const bag = (list) => list.flatMap(([kind, n]) => Array.from({ length: n }, () => ({ t: "valuable", kind })));
const midGame = {
  v: 6, cash: 6400, raids: 14, extracted: 11, time: 9000, region: "reservoir", seed: 777, escaped: null, depots: ["quarry", "wreck"], seen: "",
  quests: { progress: {}, done: ["grunts", "village", "power", "parts", "drones"] },
  hideout: { generator: 2, infirmary: 1, workbench: 1, storage: 1, radio: 1, pouch: 1, craft: 0 },
  stash: [{ t: "weapon", kind: "pike", rarity: 1 }, { t: "heal", kind: "cell" }, ...bag([["fuse", 5], ["parts", 4], ["wire", 5], ["board", 4], ["drive", 1], ["gyro", 1]])],
};
const lastStage = {
  ...midGame, cash: 63000, raids: 36, extracted: 29, time: 22000, seed: 31,
  hideout: { generator: 3, infirmary: 3, workbench: 2, storage: 3, radio: 2, pouch: 2, craft: 3 },
  stash: bag([["reactor", 1], ["core", 1], ["gyro", 4], ["drive", 3], ["board", 2]]),
};
const withProfile = async (ctx, profile) => {
  const pg = await ctx.newPage();
  pg.on("pageerror", (e) => errors.push(`hideout pageerror: ${e.message}`));
  pg.on("console", (m) => m.type() === "error" && !/fonts\.g|ERR_TUNNEL|net::/.test(m.text()) && errors.push(`hideout console: ${m.text()}`));
  await pg.addInitScript(([k, v]) => localStorage.setItem(k, v), [KEY, JSON.stringify(profile)]);
  await pg.goto(`http://localhost:${port}/ringfall/`, { waitUntil: "load" });
  await pg.waitForTimeout(300);
  return pg;
};
const readOf = async (pg) => JSON.parse(await pg.evaluate(() => window.render_game_to_text()));
/** Hub and ending parts that spill past the screen, or lists that scroll sideways. */
const spills = (pg) =>
  pg.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll("#hub .hub-inner, #hub .hub-tabs, #hub-side, #hub-stash, #hub .hub-foot, #ending .ending-inner, #ending-back")) {
      const r = el.getBoundingClientRect();
      if (r.width && (r.right > innerWidth + 1 || r.bottom > innerHeight + 1)) out.push(`${el.id || el.className} ends at ${Math.round(r.right)}x${Math.round(r.bottom)}`);
      if (el.scrollWidth > el.clientWidth + 1) out.push(`${el.id || el.className} scrolls sideways`);
    }
    return out;
  });
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const pg = await withProfile(ctx, midGame);
  await pg.click("#start");
  // The radio (Lv1) names the POI whose bins lean rare in the next raid.
  const intel = await pg.evaluate(() => document.querySelector("#hub-side .intel")?.textContent ?? "");
  await pg.click('#hub [data-act=tab][data-arg=hideout]');
  const mods = await pg.locator("#hub-side .mod").count();
  if (mods !== 7) errors.push(`hideout: the tab lists ${mods} modules, not 7`);
  await pg.screenshot({ path: `${out}/40-hideout.png` });
  // The generator's next level lacks parts: each shows how many are short and where they are found.
  await pg.click('#hub-side [data-act=mod][data-arg=generator]');
  const hints = await pg.locator("#hub-side .mod.open .req small").allTextContents();
  if (hints.length < 2 || !hints.every((h) => /%/.test(h))) errors.push(`hideout: the generator's needs show no places to find them (${hints.join(" / ")})`);
  if (!(await pg.locator("#hub-side .mod.open .req:not(.ok)").count()) || !(await pg.locator("#hub-side .mod.open [data-act=build]").isDisabled())) errors.push("hideout: the generator's missing parts are not marked, or it can be built");
  await pg.screenshot({ path: `${out}/41-hideout-needs.png` });
  // Building the storage's next level takes its parts and makes room.
  const h0 = await readOf(pg);
  await pg.click('#hub-side [data-act=mod][data-arg=storage]');
  await pg.click('#hub-side [data-act=build][data-arg=storage]');
  const h1 = await readOf(pg);
  if (h1.profile.hideout.storage !== 2 || h1.profile.stash >= h0.profile.stash || !/\/ 60/.test(await pg.textContent("#hub-stash-count"))) errors.push(`hideout: building the storage left ${JSON.stringify(h1.profile)}`);
  await pg.screenshot({ path: `${out}/42-hideout-built.png` });
  // Selling a part the hideout still needs asks a second press.
  await pg.click('#hub [data-act=tab][data-arg=shop]');
  const board = pg.locator("#hub-stash [data-act=sell]", { hasText: "回路基板" });
  await board.click();
  const warned = await pg.locator("#hub-stash .warn").count();
  const h2 = await readOf(pg);
  if (!warned || h2.profile.stash !== h1.profile.stash) errors.push("hideout: a needed board was sold without a warning");
  await pg.screenshot({ path: `${out}/43-hub-sell-warn.png` });
  await board.click();
  if ((await readOf(pg)).profile.stash !== h1.profile.stash - 1) errors.push("hideout: the second press did not sell the board");
  // The raid deployed next is the one the radio told of.
  await pg.click('#hub [data-act=tab][data-arg=kit]');
  await pg.click("#hub-free");
  const raid = await readOf(pg);
  if (!intel.includes(raid.boost.name)) errors.push(`hideout: the radio said "${intel}", the raid boosts ${raid.boost.name}`);
  await ctx.close();
  lap("hideout");
}
{
  const ctx = await browser.newContext({ viewport: { width: 740, height: 360 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const pg = await withProfile(ctx, midGame);
  await pg.tap("#start");
  await pg.tap('#hub [data-act=tab][data-arg=hideout]');
  await pg.waitForTimeout(100);
  let fit = await spills(pg);
  await pg.screenshot({ path: `${out}/m10-hideout.png` });
  await pg.tap('#hub-side [data-act=mod][data-arg=craft]');
  await pg.locator("#hub-side .mod.open").scrollIntoViewIfNeeded();
  fit = fit.concat(await spills(pg));
  await pg.screenshot({ path: `${out}/m11-hideout-craft.png` });
  await pg.tap('#hub [data-act=tab][data-arg=kit]');
  fit = fit.concat(await spills(pg));
  await pg.screenshot({ path: `${out}/m12-hub-intel.png` });
  // The starts row holds the depots too; it scrolls on its own and stays inside the screen.
  await pg.tap("#hub-region [data-act=from][data-arg=wreck]");
  fit = fit.concat(await spills(pg));
  const row = await pg.evaluate(() => document.getElementById("hub-region").getBoundingClientRect().right);
  if (row > 741) fit.push(`hub-region ends at ${Math.round(row)}`);
  await pg.screenshot({ path: `${out}/m14-hub-depot.png` });
  if (fit.length) errors.push(`hideout on a phone: ${[...new Set(fit)].join(", ")} (740x360)`);
  await ctx.close();
  lap("hideout, phone");
}
/*
 * A depot: the base offers the depots on as starts, the raid begins on the ground beside one
 * with its prompt, the map lies under fog except round where the player has been, and leaving
 * there ends the raid as extracted at that depot.
 */
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  // An epic armour in the stash: with the rare PIKE (2) it is over a level 0 depot's allowance (2).
  const pg = await withProfile(ctx, { ...midGame, stash: [...midGame.stash, { t: "armor", tier: 2 }] });
  await pg.click("#start");
  const starts = await pg.locator("#hub-region [data-act=from]").count();
  if (starts !== 2) errors.push(`depot: the base offers ${starts} depots to start from, not 2`);
  await pg.click("#hub-region [data-act=from][data-arg=quarry]");
  await pg.screenshot({ path: `${out}/46-hub-depots.png` });
  // The depot's allowance: the PIKE fits it, the armour on top does not, and a start at a way in lifts the limit.
  const allowance = () => pg.evaluate(() => document.querySelector("#hub-side .slot.depot")?.textContent ?? "");
  const goOff = () => pg.locator("#hub-go").isDisabled();
  await pg.locator("#hub-stash [data-act=pick]", { hasText: "PIKE" }).click();
  const fits = await allowance();
  if (!/Lv0/.test(fits) || !/2 \/ 2/.test(fits) || !/1,500/.test(fits) || (await goOff())) errors.push(`depot: with the PIKE the allowance reads "${fits}", start ${(await goOff()) ? "disabled" : "enabled"}`);
  await pg.screenshot({ path: `${out}/46-hub-depot-budget.png` });
  await pg.locator("#hub-stash [data-act=pick]", { hasText: "アーマー" }).click();
  const over = await allowance();
  if (!/4 \/ 2/.test(over) || !(await goOff()) || !/持ち込み枠/.test(await pg.getAttribute("#hub-go", "title"))) errors.push(`depot: over the allowance it reads "${over}" and the start is ${(await goOff()) ? "disabled" : "enabled"}`);
  await pg.screenshot({ path: `${out}/46-hub-depot-over.png` });
  await pg.click("#hub-region [data-arg=reservoir]");
  if ((await goOff()) || (await allowance())) errors.push("depot: switching to a way in did not lift the allowance");
  await pg.click("#hub-region [data-act=from][data-arg=quarry]");
  await pg.click("#hub-free");
  await pg.evaluate(() => window.advanceTime(500));
  const d0 = await readOf(pg);
  if (d0.screen !== "game" || d0.phase !== "play" || d0.region !== "reservoir" || !d0.ally.active) errors.push(`depot: starting at the quarry depot left ${d0.screen} ${d0.phase} in ${d0.region}, ally ${d0.ally.active}`);
  const prompt = await pg.textContent("#prompt");
  if (!/切り上げる/.test(prompt)) errors.push(`depot: standing at it with an empty bag prompts "${prompt}"`);
  await pg.screenshot({ path: `${out}/47-depot.png` });
  await pg.keyboard.press("KeyE");
  await pg.evaluate(() => window.advanceTime(1000));
  const d1 = await readOf(pg);
  if (d1.leaving === null) errors.push(`depot: the use key did not start leaving (${d1.phase})`);
  await pg.screenshot({ path: `${out}/48-depot-leaving.png` });
  // The map, once the start's banner is gone; leaving goes on under it.
  await pg.keyboard.press("KeyM");
  await pg.evaluate(() => window.advanceTime(1000));
  const cells = d1.seenCells;
  if (!(cells > 0 && cells <= 9)) errors.push(`depot: a fresh map has ${cells} cells explored, not the few round the start`);
  await pg.screenshot({ path: `${out}/49-map-fog.png` });
  await pg.keyboard.press("KeyM");
  await pg.evaluate(() => window.advanceTime(4000));
  await pg.waitForFunction(() => !document.getElementById("results").hidden, null, { timeout: 10000 }).catch(() => undefined);
  const d2 = await readOf(pg);
  if (d2.outcome !== "extracted" || d2.leftAt !== "quarry" || d2.screen !== "results") errors.push(`depot: leaving ended ${d2.outcome} at ${d2.leftAt} on ${d2.screen}`);
  if (!/中継ボックス/.test(await pg.textContent("#stats"))) errors.push("depot: the results do not say the raid ended at the depot");
  await pg.screenshot({ path: `${out}/50-results-depot.png` });
  await ctx.close();
  lap("depot");
}
/*
 * The routes a tool opens: listed under the hideout, closed (the obstacle, its prompt naming the
 * tool, the map's dashed line) and then open in a profile that has them all (the tunnel walked
 * through on the keyboard, the dam's gallery and the gangway seen from inside, the map's lines).
 */
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const pg = await withProfile(ctx, { ...midGame, v: 9, routes: [] });
  await pg.click("#start");
  await pg.click('#hub [data-act=tab][data-arg=hideout]');
  const shut = await pg.locator("#hub-side .route").allTextContents();
  if (shut.length !== 3 || !shut.every((t) => /閉鎖/.test(t) && /箱にある/.test(t))) errors.push(`routes: the hideout lists ${JSON.stringify(shut)}`);
  await pg.locator("#hub-side .route").first().scrollIntoViewIfNeeded();
  await pg.screenshot({ path: `${out}/51-hub-routes.png` });
  await pg.click('#hub [data-act=tab][data-arg=kit]');
  await pg.click("#hub-region [data-arg=reservoir]");
  await pg.click("#hub-free");
  await pg.evaluate(() => window.advanceTime(3000));
  // Before the dam's gallery door, facing it.
  await pg.evaluate(() => {
    const h = window.ringfallFrames()["area:heart"];
    window.ringfallPlace(20 + h.x, -102.6 + h.z, 0);
  });
  await pg.evaluate(() => window.advanceTime(300));
  const prompt = await pg.textContent("#prompt");
  if (!/ダムの点検通路/.test(prompt) || !/ボルトカッターがあれば開く/.test(prompt)) errors.push(`routes: before the dam's door the prompt reads "${prompt}"`);
  await pg.screenshot({ path: `${out}/52-route-closed.png` });
  await pg.keyboard.press("KeyM");
  await pg.evaluate(() => window.advanceTime(200));
  await pg.screenshot({ path: `${out}/53-map-routes.png` });
  await pg.keyboard.press("KeyM");
  await ctx.close();
}
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const pg = await withProfile(ctx, { ...midGame, v: 9, routes: ["tunnel", "dam", "gangway"] });
  await pg.click("#start");
  await pg.click('#hub [data-act=tab][data-arg=hideout]');
  const open = await pg.locator("#hub-side .route").allTextContents();
  if (open.length !== 3 || !open.every((t) => /開通/.test(t))) errors.push(`routes: with every route open the hideout lists ${JSON.stringify(open)}`);
  await pg.click('#hub [data-act=tab][data-arg=kit]');
  await pg.click("#hub-region [data-arg=reservoir]");
  await pg.click("#hub-free");
  await pg.evaluate(() => window.advanceTime(3000));
  const r = await readOf(pg);
  if (r.routes.join() !== "tunnel,dam,gangway") errors.push(`routes: the raid's world has ${r.routes.join() || "none"} open`);
  // Inside, from fixed cameras: the tunnel under the mountains, the gallery climbing through the dam, the gangway.
  const fr = await pg.evaluate(() => window.ringfallFrames());
  const views = [
    ["54-tunnel-open", 40, 1.6, -306, 0, 0.05],
    ["55-dam-gallery-open", 20 + fr["area:heart"].x, 1.6, -101 + fr["area:heart"].z, 0, 0.32],
    ["56-gangway-open", -40 + fr.wreck.x, 1.7, -16 + fr.wreck.z, Math.PI - 0.6, 0.35],
  ];
  for (const [name, x, dy, z, yaw, pitch] of views) {
    const y = (await pg.evaluate(([x, z]) => window.ringfallTerrain(x, z), [x, z])) + dy;
    await pg.evaluate(([x, y, z, yaw, pitch]) => window.ringfallCamera(x, y, z, yaw, pitch), [x, y, z, yaw, pitch]);
    await pg.screenshot({ path: `${out}/${name}.png` });
  }
  await pg.evaluate(() => window.ringfallCamera());
  // Walked on the keyboard from the tunnel's south mouth to its north one.
  await pg.evaluate(() => window.ringfallPlace(40, -268, 0));
  await pg.keyboard.down("KeyW");
  for (let i = 0; i < 40 && (await readOf(pg)).player.z > -430; i++) await pg.evaluate(() => window.advanceTime(1000));
  await pg.keyboard.up("KeyW");
  const through = await readOf(pg);
  if (through.player.z > -430 || Math.abs(through.player.x - 40) > 3) errors.push(`routes: walking the open tunnel ended at ${through.player.x},${through.player.z}`);
  await pg.screenshot({ path: `${out}/57-tunnel-walked.png` });
  await pg.keyboard.press("KeyM");
  await pg.evaluate(() => window.advanceTime(200));
  await pg.screenshot({ path: `${out}/58-map-routes-open.png` });
  await ctx.close();
}
for (const [size, name] of [[{ width: 1280, height: 720 }, "44-ending"], [{ width: 740, height: 360 }, "m13-ending"]]) {
  const phone = size.width < 800;
  const ctx = await browser.newContext({ viewport: size, ...(phone ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}) });
  const pg = await withProfile(ctx, lastStage);
  const press = (sel) => (phone ? pg.tap(sel) : pg.click(sel));
  await press("#start");
  await press('#hub [data-act=tab][data-arg=hideout]');
  await press('#hub-side [data-act=mod][data-arg=craft]');
  await press('#hub-side [data-act=build][data-arg=craft]');
  await pg.waitForTimeout(200);
  const e = await readOf(pg);
  if (e.screen !== "ending" || !e.profile.escaped || e.profile.hideout.craft !== 4) errors.push(`ending: finishing the craft showed ${e.screen} (${JSON.stringify(e.profile.hideout)})`);
  const stats = await pg.locator("#ending-stats > div").count();
  if (stats !== 4) errors.push(`ending: ${stats} stats, not 4`);
  const fit = await spills(pg);
  if (fit.length) errors.push(`ending (${size.width}x${size.height}): ${fit.join(", ")}`);
  await pg.screenshot({ path: `${out}/${name}.png` });
  await press("#ending-back");
  const back = await readOf(pg);
  if (back.screen !== "hub" || !/完成/.test(await pg.textContent("#hub-record"))) errors.push(`ending: going on left ${back.screen} without the craft marked done`);
  if (!phone) {
    await press('#hub [data-act=tab][data-arg=hideout]');
    if (!(await pg.locator("#hub-side .escaped").count())) errors.push("ending: the hideout does not show the craft done");
    await pg.screenshot({ path: `${out}/45-hideout-done.png` });
  }
  await ctx.close();
}
lap("ending");
console.log(`screens: ${[...taken].join(", ")}`);
await browser.close();
server.close();
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("no console errors");
