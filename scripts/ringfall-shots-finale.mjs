/**
 * The decisive battle's screenshots for the shots gate (scripts/ringfall-shots.mjs runs them;
 * `node scripts/ringfall-shots-finale.mjs` runs them alone against dist/client): a profile on its
 * second round holding sixteen nodes, two of them by the titan's pad. The camp names the round
 * beside the day and its card the decisive battle; the map table rings the pad in gold; and the
 * raid walked out of the gate has the titan as its objective.
 */
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

/** Where the game keeps its profile (src/ringfall/meta/storage.ts). */
const KEY = "ringfall.profile.v1";
const HELD = ["supply", "quarry", "relay", "station", "waterworks", "lodge", "yard", "smelter", "cannery", "coldstore", "carpark", "terminal", "highrise", "control", "fuel", "assembly"];
const FINALE = {
  v: 28, cash: 9000, raids: 40, extracted: 30, time: 30000, region: "reservoir", entry: "beach", seed: 4242, day: 41, factory: 4,
  cycle: 1, cycleDay: 22, liberations: [21],
  stash: [], entries: ["beach", "checkpoint", "jetty"], depots: HELD, seen: "f".repeat(4000),
  quests: { progress: {}, done: [] },
  poiState: Object.fromEntries(HELD.map((id) => [id, { state: "freed" }])),
};

export async function finaleShots({ browser, port, out, errors }) {
  const read = async (pg) => JSON.parse(await pg.evaluate(() => window.render_game_to_text()));
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const pg = await ctx.newPage();
  pg.on("pageerror", (e) => errors.push(`finale pageerror: ${e.message}`));
  pg.on("console", (m) => m.type() === "error" && !/fonts\.g|ERR_TUNNEL|net::/.test(m.text()) && errors.push(`finale console: ${m.text()}`));
  await pg.addInitScript(([k, v]) => localStorage.getItem(k) || localStorage.setItem(k, v), [KEY, JSON.stringify(FINALE)]);
  await pg.goto(`http://localhost:${port}/ringfall/`, { waitUntil: "load" });
  await pg.waitForTimeout(300);
  await pg.click("#start");
  await pg.waitForFunction(() => getComputedStyle(document.getElementById("fade")).opacity === "0", null, { timeout: 8000 }).catch(() => errors.push("finale: the fade never cleared"));
  await pg.evaluate(() => window.advanceTime(300));
  // The camp: the round beside the day, and the card's first line the decisive battle.
  const head = await pg.evaluate(() => document.getElementById("camp-hint")?.textContent ?? "");
  const card = await pg.evaluate(() => document.body.innerText);
  if (!/41 日目・2 周目/.test(head)) errors.push(`finale: the camp's day line reads "${head}"`);
  if (!/決戦/.test(card)) errors.push("finale: the camp's card does not name the decisive battle");
  await pg.screenshot({ path: `${out}/140-finale-camp.png` });
  // The map table: the pad ringed in gold.
  if (!(await pg.evaluate(() => window.ringfallCamp.walkTo("map")))) errors.push("finale: could not stand at the map table");
  await pg.evaluate(() => window.advanceTime(100));
  await pg.keyboard.press("KeyE");
  await pg.evaluate(() => window.advanceTime(400));
  await pg.screenshot({ path: `${out}/141-finale-map.png` });
  await pg.keyboard.press("Escape");
  await pg.evaluate(() => window.advanceTime(200));
  // Out of the gate: the raid's objective is the titan.
  await pg.evaluate(() => window.ringfallCamp.toGate());
  await pg.keyboard.down("KeyW");
  let st = await read(pg);
  for (let i = 0; i < 30 && st.screen !== "game" && !st.camp?.depart; i++) st = JSON.parse(await pg.evaluate(() => (window.advanceTime(200), window.render_game_to_text())));
  await pg.keyboard.up("KeyW");
  if (st.camp?.depart) {
    await pg.screenshot({ path: `${out}/142-finale-depart.png` });
    await pg.keyboard.press("Enter");
    await pg.waitForTimeout(400);
  }
  for (let i = 0; i < 20 && (await read(pg)).screen !== "game"; i++) await pg.evaluate(() => window.advanceTime(200));
  st = await read(pg);
  if (st.screen !== "game") errors.push(`finale: no raid started (${st.screen})`);
  await pg.evaluate(() => window.advanceTime(1500));
  st = await read(pg);
  if (st.objective?.title !== "決戦") errors.push(`finale: the raid's objective is ${JSON.stringify(st.objective?.title)}`);
  await pg.screenshot({ path: `${out}/143-finale-raid.png` });
  await ctx.close();
}

// Alone: serve the build and run the finale's shots.
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
  await finaleShots({ browser, port: server.address().port, out, errors });
  await browser.close();
  server.close();
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exit(1);
  }
  console.log("finale shots ok");
}
