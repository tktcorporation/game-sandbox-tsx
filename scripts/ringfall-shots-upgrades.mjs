/**
 * The upgrades' screenshots for the shots gate (scripts/ringfall-shots.mjs runs them;
 * `node scripts/ringfall-shots-upgrades.mjs` runs them alone against dist/client): the workshop's
 * hideout cards (each with its mark and the next level's gain, was → now), a module opened to its
 * ladder of levels and what the next takes, the factory's card, and the places the same marks
 * stand where the effects show (the shelves' issued heals and pouch, the stash's count, the
 * trader's materials, the map table's report). On a desktop and on a phone on its side under real
 * touch events; every panel must fit the window.
 */
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

/** Where the game keeps its profile (src/ringfall/meta/storage.ts). */
const KEY = "ringfall.profile.v1";
const valuables = (list) => list.flatMap(([kind, n]) => Array.from({ length: n }, () => ({ t: "valuable", kind })));
/** A mid-game base: every module at Lv1 (the storage at 2), the factory at Lv1, the quarry held (its squad flag, the rare shelf). */
const BASE = {
  v: 19, cash: 5200, raids: 14, extracted: 11, time: 9000, region: "reservoir", seed: 777, day: 12, depots: ["supply", "quarry"], seen: "",
  quests: { progress: {}, done: ["grunts", "village", "medbay", "parts"] },
  hideout: { infirmary: 1, workbench: 1, storage: 2, radio: 1, pouch: 1 },
  factory: 1,
  poiState: { supply: { state: "freed" }, quarry: { state: "freed" }, relay: { state: "held" }, pad: { state: "held" }, wreck: { state: "held" }, yard: { state: "held" }, smelter: { state: "held" } },
  stash: [{ t: "weapon", kind: "pike", rarity: 1 }, { t: "heal", kind: "cell" }, ...valuables([["fuse", 3], ["parts", 5], ["wire", 3], ["board", 2], ["drive", 1]])],
};
/** The module each mark belongs to (view/icons.ts), as its class on the card's svg. */
const MARKS = { infirmary: "issue", workbench: "bench", storage: "stash", radio: "radio", pouch: "pouch" };

export async function upgradeShots({ browser, port, out, errors }) {
  const read = async (pg) => JSON.parse(await pg.evaluate(() => window.render_game_to_text()));
  const spills = (pg) =>
    pg.evaluate(() => {
      const bad = [];
      for (const el of document.querySelectorAll("#hub .hub-inner, #hub .hub-head, #hub-side, #hub-stash, #hub .hub-foot, #hub-side .up-card, #hub-side .shelf-mats")) {
        const r = el.getBoundingClientRect();
        if (r.width && r.right > innerWidth + 1) bad.push(`${el.id || el.className} ends at ${Math.round(r.right)}`);
        if (el.scrollWidth > el.clientWidth + 1) bad.push(`${el.id || el.className} scrolls sideways`);
      }
      // Two lines of a card's gain row must not sit on each other.
      for (const row of document.querySelectorAll("#hub-side .gain-row, #hub-side .ladder li")) {
        const kids = [...row.children].map((c) => c.getBoundingClientRect()).filter((r) => r.width);
        for (let i = 0; i < kids.length; i++)
          for (let j = i + 1; j < kids.length; j++) {
            const a = kids[i];
            const b = kids[j];
            if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) bad.push(`overlap in ${row.className}`);
          }
      }
      return bad;
    });
  const open = async (ctx, phone) => {
    const pg = await ctx.newPage();
    pg.on("pageerror", (e) => errors.push(`upgrades pageerror: ${e.message}`));
    pg.on("console", (m) => m.type() === "error" && !/fonts\.g|ERR_TUNNEL|net::/.test(m.text()) && errors.push(`upgrades console: ${m.text()}`));
    await pg.addInitScript(([k, v]) => localStorage.setItem(k, v), [KEY, JSON.stringify(BASE)]);
    await pg.goto(`http://localhost:${port}/ringfall/`, { waitUntil: "load" });
    await pg.waitForTimeout(300);
    if (phone) await pg.evaluate(() => Object.defineProperty(screen, "orientation", { value: undefined, configurable: true }));
    await (phone ? pg.tap("#start") : pg.click("#start"));
    await pg.waitForFunction(() => getComputedStyle(document.getElementById("fade")).opacity === "0", null, { timeout: 8000 }).catch(() => errors.push("upgrades: the fade never cleared"));
    await pg.waitForTimeout(100);
    return pg;
  };
  /** Stands at a station and opens its panel: the use key, or the use button tapped through `cdp`. */
  const station = async (pg, id, cdp) => {
    if (!(await pg.evaluate((i) => window.ringfallCamp.walkTo(i), id))) errors.push(`upgrades: could not stand at ${id}`);
    await pg.evaluate(() => window.advanceTime(100));
    if (cdp) {
      const bb = await pg.locator("#t-use").boundingBox();
      if (bb) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: bb.x + bb.width / 2, y: bb.y + bb.height / 2, id: 51 }] });
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      } else errors.push(`upgrades: no use button at ${id}`);
    } else await pg.keyboard.press("KeyE");
    await pg.evaluate(() => window.advanceTime(50));
    await pg.waitForTimeout(150);
    if ((await read(pg)).camp?.panel !== id) errors.push(`upgrades: the use key at ${id} opened no panel`);
  };
  const close = (pg, phone) => (phone ? pg.tap("#hub-close") : pg.click("#hub-close"));
  const check = async (pg, where) => {
    for (const s of await spills(pg)) errors.push(`upgrades ${where}: ${s}`);
  };

  for (const phone of [false, true]) {
    const ctx = phone ? await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }) : await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const pg = await open(ctx, phone);
    const cdp = phone ? await ctx.newCDPSession(pg) : undefined;
    const shot = (name) => pg.screenshot({ path: `${out}/${phone ? "m-" : ""}up-${name}.png` });
    const where = phone ? "phone" : "1280x720";
    const tap = (sel) => (phone ? pg.tap(sel) : pg.click(sel));

    // The workshop: each module's card carries its mark and, but for one at its top, the next level's gain as was → now.
    await station(pg, "workshop", cdp);
    const cards = await pg.evaluate(() =>
      [...document.querySelectorAll("#hub-side .up-card[data-mod]")].map((c) => ({ m: c.dataset.mod, mark: c.querySelector(".mod-head strong .ico")?.classList[1], delta: c.querySelectorAll(".gain-row .delta").length, gain: c.querySelectorAll(".gain-row .now .gain").length })),
    );
    for (const c of cards) if (c.mark !== MARKS[c.m] || !c.delta || !c.gain) errors.push(`upgrades: the ${c.m} card reads ${JSON.stringify(c)}`);
    if (cards.length !== 5) errors.push(`upgrades: the workshop lists ${cards.length} modules`);
    await check(pg, `${where} workshop`);
    await shot("1-workshop");
    // A module opened: its ladder (the levels built ticked, the next one lit) above what the next level takes, set apart.
    for (const [m, n] of [["infirmary", 2], ["pouch", 3]]) {
      await tap(`#hub-side [data-act=mod][data-arg=${m}]`);
      await pg.waitForTimeout(100);
      const ladder = await pg.evaluate(() => [...document.querySelectorAll("#hub-side .mod.open .ladder li")].map((l) => l.className));
      const costApart = await pg.locator("#hub-side .mod.open .mod-cost .req").count();
      if (ladder.length !== 4 - (m === "pouch") || ladder[1] !== "cur" || ladder[2] !== "next" || !costApart) errors.push(`upgrades: the ${m} opened reads ${JSON.stringify(ladder)}, ${costApart} needs`);
      await pg.evaluate(() => document.querySelector("#hub-side .mod.open")?.scrollIntoView({ block: "start" }));
      await check(pg, `${where} ${m} opened`);
      await shot(`${n}-workshop-${m}`);
    }
    await close(pg, phone);

    // The factory: its card with the squad it makes, the next level's gain, and the ladder; the quarry held adds a flag.
    await station(pg, "factory", cdp);
    const factory = await pg.evaluate(() => ({
      flag: document.querySelectorAll("#hub-side .from-nodes .ico.flag").length,
      gains: document.querySelectorAll("#hub-side .gain-row .delta").length,
      ladder: [...document.querySelectorAll("#hub-side .ladder li")].map((l) => l.className),
      build: document.querySelector("#hub-side [data-act=factory]")?.textContent,
    }));
    if (!factory.flag || !factory.gains || factory.ladder.length !== 9 || factory.ladder[1] !== "cur" || factory.build !== "Lv2") errors.push(`upgrades: the factory reads ${JSON.stringify(factory)}`);
    await check(pg, `${where} factory`);
    await shot("4-factory");
    await close(pg, phone);

    // Where the marks stand again: the shelves' issued heals beside the infirmary's case, the pouch, the stash's crate.
    await station(pg, "stash", cdp);
    const shelves = await pg.evaluate(() => ({
      issued: document.querySelectorAll("#hub-side .slot.count .issued .ico.issue").length,
      pouch: document.querySelectorAll("#hub-side .slot.pouch .ico.pouch").length,
      crate: document.querySelectorAll("#hub-stash-count .ico.stash").length,
    }));
    if (shelves.issued !== 2 || !shelves.pouch || !shelves.crate) errors.push(`upgrades: the shelves read ${JSON.stringify(shelves)}`);
    await check(pg, `${where} shelves`);
    await shot("5-shelves-marks");
    await close(pg, phone);
    // The trader's materials under the workbench's wrench, lit to the rarity it lets the trader sell.
    await station(pg, "shop", cdp);
    const lit = await pg.locator("#hub-side .shelf-mats > div.on .ico.bench").count();
    if (lit !== 3) errors.push(`upgrades: the trader's materials light ${lit} rarities at workbench Lv1`);
    await check(pg, `${where} shop`);
    await shot("6-shop-materials");
    await close(pg, phone);
    // The radio's mast at the map table's report.
    await station(pg, "map", cdp);
    if (!(await pg.locator("#hub-side .slot.intel .ico.radio").count())) errors.push("upgrades: the map table's report carries no radio mast");
    await close(pg, phone);
    await ctx.close();
  }
}

// Alone: serve the build and run the upgrades' shots.
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
  await upgradeShots({ browser, port: server.address().port, out, errors });
  await browser.close();
  server.close();
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exit(1);
  }
  console.log("upgrade shots ok");
}
