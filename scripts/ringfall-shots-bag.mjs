/**
 * The bag's screenshots for the shots gate (scripts/ringfall-shots.mjs runs them;
 * `node scripts/ringfall-shots-bag.mjs` runs them alone against dist/client): the bag peek held
 * open over a mixed bag (valuables of several rarities, one of them asked for by the contract
 * taken, a key, a tool, a story record, a mod part worn, what the pouch keeps), the game running
 * on under it, and the card a pickup slides in; on a desktop by Tab and on phones (844×390 and
 * 740×360) by the bag button under real touch events.
 */
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

/** Where the game keeps its profile (src/ringfall/meta/storage.ts). */
const KEY = "ringfall.profile.v1";
/** A mid-game base: the hideout half built, the factory at its first level, the trader's delivery quest open. */
const BASE = {
  v: 13, cash: 6400, raids: 14, extracted: 11, time: 9000, region: "reservoir", seed: 777, day: 15, depots: ["quarry"], seen: "",
  quests: { progress: {}, done: ["grunts", "village", "medbay"] },
  hideout: { infirmary: 1, workbench: 1, storage: 1, radio: 0, pouch: 1 },
  stash: [{ t: "weapon", kind: "pike", rarity: 1 }, { t: "valuable", kind: "fuse" }],
};

export async function bagShots({ browser, port, out, errors }) {
  const read = async (pg) => JSON.parse(await pg.evaluate(() => window.render_game_to_text()));
  const open = async (ctx) => {
    const pg = await ctx.newPage();
    pg.on("pageerror", (e) => errors.push(`bag pageerror: ${e.message}`));
    pg.on("console", (m) => m.type() === "error" && !/fonts\.g|ERR_TUNNEL|net::/.test(m.text()) && errors.push(`bag console: ${m.text()}`));
    await pg.addInitScript(([k, v]) => localStorage.getItem(k) || localStorage.setItem(k, v), [KEY, JSON.stringify(BASE)]);
    await pg.goto(`http://localhost:${port}/ringfall/`, { waitUntil: "load" });
    await pg.waitForTimeout(300);
    return pg;
  };
  /** From the title into a raid out of the camp's gate, with the day's fetch contract taken if the board has one; that contract. */
  const raid = async (pg, touch) => {
    await (touch ? pg.tap("#start") : pg.click("#start"));
    await pg.waitForFunction(() => getComputedStyle(document.getElementById("fade")).opacity === "0", null, { timeout: 8000 }).catch(() => errors.push("bag: the fade never cleared"));
    const id = await pg.evaluate(() => window.ringfallContract.take("fetch"));
    const fetch = id ? await pg.evaluate(([k, i]) => JSON.parse(localStorage.getItem(k)).board.contracts.find((c) => c.id === i), [KEY, id]) : null;
    await pg.evaluate(() => window.ringfallCamp.toGate());
    await pg.keyboard.down("KeyW");
    let st = await read(pg);
    for (let i = 0; i < 30 && st.screen !== "game" && !st.camp?.depart; i++) st = JSON.parse(await pg.evaluate(() => (window.advanceTime(200), window.render_game_to_text())));
    await pg.keyboard.up("KeyW");
    if (st.camp?.depart) {
      await pg.keyboard.press("Enter");
      await pg.waitForTimeout(400);
    }
    for (let i = 0; i < 20 && (await read(pg)).screen !== "game"; i++) await pg.evaluate(() => window.advanceTime(200));
    if ((await read(pg)).screen !== "game") errors.push("bag: no raid started");
    await pg.evaluate(() => window.ringfallStep(1500));
    return fetch;
  };
  /** The mixed bag: a contract's valuable from its POI and one from elsewhere, others of each rarity, a tool, a record, a key, a mod part. */
  const fill = async (pg, fetch, swap = false) => {
    const kind = fetch?.kind ?? "drive";
    // `swap`: a gyro picked up with a full bag, a parts and the fuse left behind for it.
    const haul = swap ? [kind, kind, "board", "parts", "gyro"] : [kind, kind, "board", "parts", "parts", "fuse"];
    const at = [fetch?.poi ?? null, null];
    await pg.evaluate(([h, a]) => window.ringfallBag(h, { at: a, tools: ["cutter"], records: ["tether"], keys: ["relay"] }), [haul, at]);
    await pg.evaluate(() => window.ringfallMods.wear(["grip", "probe"]));
  };
  /** The first pickup card, if it is on screen and seen: inside the window, opaque and visible, it and every parent. */
  const cardSeen = (pg) =>
    pg.evaluate(() => {
      const c = document.querySelector("#bag-cards .bag-card");
      if (!c) return { bad: ["a pickup showed no card"] };
      const r = c.getBoundingClientRect();
      const bad = [];
      if (r.width < 20 || r.height < 10 || r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight) bad.push(`the card is off the screen (${JSON.stringify(r)})`);
      for (let e = c; e; e = e.parentElement) {
        const cs = getComputedStyle(e);
        if (Number(cs.opacity) <= 0.5 || cs.visibility !== "visible" || cs.display === "none") bad.push(`the card is not seen (${e.id || e.className}: opacity ${cs.opacity}, ${cs.visibility}, ${cs.display})`);
      }
      return { bad, rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right } };
    });
  /** Once its slide-in is over. */
  const fits = async (pg) => {
    await pg.waitForTimeout(300);
    return pg.evaluate(() => {
      const el = document.getElementById("bag-peek");
      const r = el.getBoundingClientRect();
      const bad = [];
      if (el.hidden || r.height === 0) bad.push("the peek is not shown");
      if (r.top < -1 || r.bottom > innerHeight + 1 || r.left < -1 || r.right > innerWidth + 1) bad.push(`the peek spills past the screen (${JSON.stringify(r)} of ${innerWidth}×${innerHeight})`);
      if (el.scrollHeight > el.clientHeight + 1) bad.push(`the peek's lines are cut off (${el.scrollHeight} > ${el.clientHeight})`);
      const rows = el.querySelectorAll(".bp-row").length;
      if (rows < 5) bad.push(`the peek shows ${rows} lines`);
      if (!el.querySelector(".bp-row.kept .bp-pouch")) bad.push("no line carries the pouch's mark");
      if (!el.querySelector(".bp-extra .ico.key") || !el.querySelector(".bp-extra .ico.mod")) bad.push("the key or the mod parts are missing");
      if (!el.querySelector(".bp-use .ico.route")) bad.push("the tool shows no route");
      if (!el.querySelector(".bp-use .ico.hideout")) bad.push("no valuable shows a hideout module");
      return bad;
    });
  };

  // A desktop: Tab held shows the bag, the player still walks under it; released, it goes.
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const pg = await open(ctx);
    const fetch = await raid(pg, false);
    await fill(pg, fetch);
    // The cards of what was just put in the bag go first.
    await pg.evaluate(() => window.advanceTime(2600));
    await pg.keyboard.down("Tab");
    const p0 = (await read(pg)).player;
    await pg.keyboard.down("KeyW");
    await pg.evaluate(() => window.advanceTime(600));
    await pg.keyboard.up("KeyW");
    const p1 = (await read(pg)).player;
    if (Math.hypot(p1.x - p0.x, p1.z - p0.z) < 1) errors.push(`bag: the player did not walk with the bag open (${p0.x},${p0.z} -> ${p1.x},${p1.z})`);
    for (const b of await fits(pg)) errors.push(`bag (desktop): ${b}`);
    await pg.evaluate(() => window.ringfallDraw());
    await pg.screenshot({ path: `${out}/bag-1-peek.png` });
    await pg.keyboard.up("Tab");
    await pg.evaluate(() => window.advanceTime(50));
    if (!(await pg.evaluate(() => document.getElementById("bag-peek").hidden))) errors.push("bag: the peek stayed open after Tab was let go");
    // A pickup: a gyro enters the bag, what it took the place of struck through on its card.
    await fill(pg, fetch, true);
    // Past the card's slide-in (0.18 s of the game's time).
    await pg.evaluate(() => window.advanceTime(300));
    await pg.waitForTimeout(300);
    for (const b of (await cardSeen(pg)).bad) errors.push(`bag (desktop): ${b}`);
    if (!(await pg.locator("#bag-cards .bag-card .bp-lost s").count())) errors.push("bag: the card does not strike through what the pickup left behind");
    await pg.evaluate(() => window.ringfallDraw());
    await pg.screenshot({ path: `${out}/bag-2-card.png` });
    await pg.evaluate(() => window.advanceTime(2600));
    if (await pg.locator("#bag-cards .bag-card").count()) errors.push("bag: the pickup's card did not go");
    await ctx.close();
  }
  // Phones on their side: the bag button held under a real touch, at two sizes.
  for (const [w, h] of [[844, 390], [740, 360]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const pg = await open(ctx);
    const cdp = await ctx.newCDPSession(pg);
    const fetch = await raid(pg, true);
    await fill(pg, fetch);
    await pg.evaluate(() => window.advanceTime(2600));
    const bb = await pg.locator("#t-bag").boundingBox();
    if (!bb) errors.push(`bag (${w}×${h}): no bag button`);
    else {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: bb.x + bb.width / 2, y: bb.y + bb.height / 2, id: 7 }] });
      await pg.evaluate(() => window.advanceTime(100));
      for (const b of await fits(pg)) errors.push(`bag (${w}×${h}): ${b}`);
      await pg.evaluate(() => window.ringfallDraw());
      await pg.screenshot({ path: `${out}/m-bag-1-peek-${w}.png` });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await pg.evaluate(() => window.advanceTime(50));
      if (!(await pg.evaluate(() => document.getElementById("bag-peek").hidden))) errors.push(`bag (${w}×${h}): the peek stayed open after the button was let go`);
    }
    await fill(pg, fetch, true);
    // Past the card's slide-in (0.18 s of the game's time).
    await pg.evaluate(() => window.advanceTime(300));
    await pg.waitForTimeout(300);
    const { bad, rect: card } = await cardSeen(pg);
    for (const b of bad) errors.push(`bag (${w}×${h}): ${b}`);
    if (card && card.bottom > h / 2 - 24) errors.push(`bag (${w}×${h}): the card reaches the crosshair (${JSON.stringify(card)})`);
    await pg.evaluate(() => window.ringfallDraw());
    await pg.screenshot({ path: `${out}/m-bag-2-card-${w}.png` });
    await ctx.close();
  }
}

// Alone: serve the build and run the bag's shots.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
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
  const out = "shots/ringfall";
  await mkdir(out, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const errors = [];
  await bagShots({ browser, port: server.address().port, out, errors });
  await browser.close();
  server.close();
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exit(1);
  }
  console.log("bag shots ok");
}
