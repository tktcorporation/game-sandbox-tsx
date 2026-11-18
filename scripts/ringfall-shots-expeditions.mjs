/**
 * The expeditions' screenshots for the shots gate (scripts/ringfall-shots.mjs runs them;
 * `node scripts/ringfall-shots-expeditions.mjs` runs them alone against the build): a profile
 * another player's expedition is sent at (`Profile.incoming`) with expeditions of its own out. The
 * map table marks the node sent at with a green arrow and lists who is coming; the factory's panel
 * lists the expeditions out, each that can be called home with its button, and calling one home
 * gives its squad back at once; the departure's map carries the arrow too. No island server
 * answers under a browser driver, so the profile is the save's.
 */
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

/** Where the game keeps its profile (src/ringfall/meta/storage.ts). */
const KEY = "ringfall.profile.v1";
const HELD = ["supply", "quarry", "relay", "station", "waterworks", "lodge"];
const SAVE = {
  v: 29, cash: 5000, raids: 12, extracted: 9, time: 9000, region: "reservoir", entry: "beach", seed: 77, day: 13, factory: 2,
  cycle: 0, cycleDay: 1, liberations: [],
  stash: [], entries: ["beach", "checkpoint", "jetty"], depots: HELD, seen: "f".repeat(4000),
  quests: { progress: {}, done: [] },
  poiState: { ...Object.fromEntries(HELD.map((id) => [id, { state: "freed" }])), yard: { state: "rival:Z3P9TR" } },
  incoming: [{ id: 3, by: { code: "Z3P9TR", name: "となり" }, node: "relay", arriveAt: Date.now() + 5.4 * 3_600_000, state: "coming" }],
  expeditions: [
    { code: "K7M2QX", node: "quarry", sentAt: 1, id: 4, units: 4, state: "holding" },
    { code: "K7M2QX", node: "smelter", sentAt: 2, id: 6, units: 4, state: "waiting" },
  ],
  logSeq: 0, retaken: [],
};

export async function expeditionShots({ browser, port, out, errors }) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const pg = await ctx.newPage();
  pg.on("pageerror", (e) => errors.push(`expeditions pageerror: ${e.message}`));
  pg.on("console", (m) => m.type() === "error" && !/fonts\.g|ERR_TUNNEL|net::/.test(m.text()) && errors.push(`expeditions console: ${m.text()}`));
  await pg.addInitScript(([k, v]) => localStorage.getItem(k) || localStorage.setItem(k, v), [KEY, JSON.stringify(SAVE)]);
  await pg.goto(`http://localhost:${port}/ringfall/`, { waitUntil: "load" });
  await pg.waitForTimeout(300);
  await pg.click("#start");
  await pg.waitForFunction(() => getComputedStyle(document.getElementById("fade")).opacity === "0", null, { timeout: 8000 }).catch(() => errors.push("expeditions: the fade never cleared"));
  await pg.evaluate(() => window.advanceTime(300));
  const open = async (station) => {
    if (!(await pg.evaluate((s) => window.ringfallCamp.walkTo(s), station))) errors.push(`expeditions: could not stand at ${station}`);
    await pg.evaluate(() => window.advanceTime(100));
    await pg.keyboard.press("KeyE");
    await pg.evaluate(() => window.advanceTime(400));
  };
  const close = async () => {
    await pg.keyboard.press("Escape");
    await pg.evaluate(() => window.advanceTime(200));
  };
  // The map table: who is coming at which node, and how long there is.
  await open("map");
  const news = await pg.evaluate(() => document.querySelector(".island-news.incoming")?.textContent ?? "");
  if (!/となりの遠征隊が.+を狙っている.+あと約 6 時間/.test(news)) errors.push(`expeditions: the map table's warning reads "${news}"`);
  await pg.screenshot({ path: `${out}/150-expeditions-map.png` });
  await close();
  // The factory's panel: the expeditions out, each with its state and its recall.
  await open("factory");
  const list = () =>
    pg.evaluate(() => {
      document.querySelector("#hub-exped")?.scrollIntoView({ block: "end" });
      return [...document.querySelectorAll("#hub-exped .exp-out")].map((el) => ({ state: el.className, text: el.textContent, recall: !!el.querySelector(".exp-recall") }));
    });
  const before = await list();
  if (before.length !== 2 || !before.every((e) => e.recall) || !/保持中/.test(before[0].text) || !/足止め/.test(before[1].text)) errors.push(`expeditions: the factory lists ${JSON.stringify(before)}`);
  await pg.waitForTimeout(100);
  await pg.screenshot({ path: `${out}/151-expeditions-factory.png` });
  // Called home: its squad is back at once, and it waits for its island to be told.
  await pg.click("#hub-exped .exp-out .exp-recall");
  await pg.waitForTimeout(200);
  const after = await list();
  const away = await pg.evaluate(() => document.querySelector("#hub-exped .mod-head b")?.textContent ?? "");
  if (!/引き上げ中/.test(after[0]?.text ?? "") || after[0].recall || !/^1 \//.test(away.trim())) errors.push(`expeditions: after a recall the factory lists ${JSON.stringify(after)} with ${away} away`);
  await pg.screenshot({ path: `${out}/152-expeditions-recalled.png` });
  await close();
  // The departure's map carries the arrow.
  await pg.evaluate(() => window.ringfallCamp.toGate());
  await pg.keyboard.down("KeyW");
  let st = JSON.parse(await pg.evaluate(() => window.render_game_to_text()));
  for (let i = 0; i < 30 && !st.camp?.depart; i++) st = JSON.parse(await pg.evaluate(() => (window.advanceTime(200), window.render_game_to_text())));
  await pg.keyboard.up("KeyW");
  if (!st.camp?.depart) errors.push("expeditions: the departure did not open");
  await pg.screenshot({ path: `${out}/153-expeditions-depart.png` });
  await ctx.close();
}

// Alone: serve the build and run the expeditions' shots.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
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
  const out = "shots/ringfall";
  await mkdir(out, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const errors = [];
  await expeditionShots({ browser, port: server.address().port, out, errors });
  await browser.close();
  server.close();
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exit(1);
  }
  console.log("expedition shots ok");
}
