/**
 * The signal station's screenshots for the shots gate (scripts/ringfall-shots.mjs runs them;
 * `node scripts/ringfall-shots-signal.mjs` runs them alone against the build). The other players
 * are the signal station's (信号所): its mark tells of the island's news until it is opened, and
 * its panel lists the other players' islands (one of the game's own, marked AI), the sorties on
 * the player's holdings (攻められた記録) and the news. The factory's panel is the factory's alone.
 * No island server answers under a browser driver, so the profile is the save's.
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
  v: 55, cash: 5000, raids: 12, extracted: 9, time: 9000, region: "reservoir", entry: "beach", seed: 77, day: 13, factory: 2,
  stash: [], entries: ["beach", "checkpoint", "jetty"], depots: HELD, seen: "f".repeat(4000),
  poiState: Object.fromEntries(HELD.map((id) => [id, { state: "own" }])),
  logSeq: 0, retaken: [],
};

const NEAR = [
  { code: "Z3P9TR", name: "となり", held: 7, total: 21, day: 15, slot: 0, last: { at: Date.now() - 3 * 3600_000, captured: 2, home: true } },
  { code: "K7M2QX", name: "みなと", held: 4, total: 21, day: 9, slot: 2 },
  { code: "H4N8WD", name: "砂丘の人", held: 11, total: 21, day: 22, slot: 3, last: { at: Date.now() - 26 * 3600_000, captured: 0, home: false } },
];

/** A page at the camp on `save`, the first camp's cards about the other players already read. */
async function camp(browser, port, save, errors, tag) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const pg = await ctx.newPage();
  pg.on("pageerror", (e) => errors.push(`${tag} pageerror: ${e.message}`));
  pg.on("console", (m) => m.type() === "error" && !/fonts\.g|ERR_TUNNEL|net::/.test(m.text()) && errors.push(`${tag} console: ${m.text()}`));
  await pg.addInitScript(([k, v]) => localStorage.getItem(k) || localStorage.setItem(k, v), [KEY, JSON.stringify(save)]);
  // The neighbours the server offered at the last sync, as the browser keeps them (island-net.ts): drawn out at sea on the camp's maps.
  await pg.addInitScript((v) => localStorage.setItem("ringfall.neighbours.v1", v), JSON.stringify({ neighbours: NEAR }));
  await pg.addInitScript(() => localStorage.setItem("ringfall.mpHowto.v1", "1"));
  await pg.goto(`http://localhost:${port}/ringfall/`, { waitUntil: "load" });
  await pg.waitForTimeout(300);
  await pg.click("#start");
  await pg.waitForFunction(() => getComputedStyle(document.getElementById("fade")).opacity === "0", null, { timeout: 8000 }).catch(() => errors.push(`${tag}: the fade never cleared`));
  await pg.evaluate(() => window.advanceTime(300));
  return { ctx, pg };
}

export async function signalShots({ browser, port, out, errors }) {
  const { ctx, pg } = await camp(browser, port, SAVE, errors, "signal");
  const open = async (station) => {
    if (!(await pg.evaluate((s) => window.ringfallCamp.open(s), station))) errors.push(`signal: ${station} did not open`);
    await pg.evaluate(() => window.advanceTime(400));
  };
  const close = async () => {
    await pg.keyboard.press("Escape");
    await pg.evaluate(() => window.advanceTime(200));
  };
  // The island's news: a holding taken and one that held.
  await pg.evaluate(() =>
    window.ringfallNews([
      { seq: 2, at: 0, t: "taken", node: "lodge", by: { code: "Z3P9TR", name: "となり" }, stars: 3 },
      { seq: 1, at: 0, t: "wiped", node: "quarry", by: { code: "K7M2QX", name: "みなと" } },
    ]),
  );
  // Its mark tells of the news until it is opened.
  const mark = await pg.evaluate(() => JSON.parse(window.render_game_to_text()).camp?.marks?.signal ?? "");
  if (!/知らせ 2/.test(mark)) errors.push(`signal: the signal station's mark reads "${mark}"`);
  // The station itself in the yard: its mast and green lamp, its name and mark over it.
  if (!(await pg.evaluate(() => window.ringfallCamp.walkTo("signal")))) errors.push("signal: could not stand at the signal station");
  await pg.evaluate(() => window.advanceTime(300));
  await pg.screenshot({ path: `${out}/156-camp-signal.png` });
  await open("signal");
  const items = await pg.evaluate(() => document.querySelectorAll(".island-news.signal-news li").length);
  if (items !== 2) errors.push(`signal: the news shows ${items} items, not 2`);
  // News that comes while the station is open shows at once.
  await pg.evaluate(() => window.ringfallNews([{ seq: 3, at: 0, t: "wiped", node: "relay", by: { code: "H4N8WD", name: "砂丘の人" } }]));
  const more = await pg.evaluate(() => document.querySelectorAll(".island-news.signal-news li").length);
  if (more !== 3) errors.push(`signal: news that came with the station open shows ${more} items, not 3`);
  // The other players first: whose, how much they hold, what they did last (the kept list's last raid read back).
  const near = await pg.evaluate(() => [...document.querySelectorAll("#hub-exped .exp-near button")].map((b) => b.textContent));
  // Slot 1 (the waterworks' sea) is left free by the server: one of the game's own islands stands there, marked AI.
  const ai = await pg.evaluate(() => document.querySelectorAll("#hub-exped .exp-near .ai-tag").length);
  if (near.length !== 4 || ai !== 1 || !/となり.*7\/21.*3h.*\+2/.test(near[0] ?? "")) errors.push(`signal: the other players read ${JSON.stringify(near)}, ${ai} marked AI`);
  await pg.screenshot({ path: `${out}/150-signal-news.png` });
  // Looking at one of the game's own islands shows its nodes, read only.
  await pg.click("#hub-exped .exp-near button:has(.ai-tag)");
  await pg.waitForTimeout(200);
  const nodes = await pg.evaluate(() => document.querySelectorAll("#hub-exped .exp-target .exp-nodes .exp-node").length);
  if (!nodes) errors.push("signal: looking at an AI player's island shows no nodes");
  await pg.screenshot({ path: `${out}/154-signal-look.png` });
  await close();
  // The factory's panel is the factory's alone.
  await open("factory");
  if (await pg.evaluate(() => !!document.querySelector("#hub-exped"))) errors.push("signal: the factory's panel holds the signal station's section");
  await pg.screenshot({ path: `${out}/155-factory-only.png` });
  await close();
  await ctx.close();
  await attackShots({ browser, port, out, errors });
}

/**
 * 攻められた記録 on the signal station (view/attacks.ts): a save holding two sorties on the quarry,
 * one with its track; 見る plays it on the holding's small map (drawn whole under a browser driver).
 */
export async function attackShots({ browser, port, out, errors }) {
  const core = { x: -327, z: 132 };
  const path = [];
  // In from the south-west, round the core's west side, onto it, and back out.
  for (let i = 0; i <= 40; i++) {
    const f = i / 40;
    const a = f < 0.6 ? f / 0.6 : 1 - (f - 0.6) / 0.4;
    path.push(Math.round(core.x - 110 * (1 - a) + 14 * Math.sin(f * 9)), Math.round(core.z + 90 * (1 - a) - 10 * Math.cos(f * 7)));
  }
  const replay = {
    node: "quarry",
    every: 3,
    path,
    marks: [
      { t: 40, k: "fall", x: core.x - 40, z: core.z + 30 },
      { t: 55, k: "fall", x: core.x - 18, z: core.z + 12 },
      { t: 70, k: "core", x: core.x, z: core.z },
      { t: 95, k: "taken", x: core.x, z: core.z },
      { t: 120, k: "end", x: path.at(-2), z: path.at(-1) },
    ],
  };
  const now = Date.now();
  const save = {
    ...SAVE,
    poiState: Object.fromEntries(HELD.map((id) => [id, { state: id === "quarry" ? "foe" : "own" }])),
    attacks: [
      { seq: 4, at: now - 26 * 3600_000, by: { code: "K7M2QX", name: "みなと" }, node: "relay", taken: false, stars: 1, won: 6 },
      { seq: 9, at: now - 2 * 3600_000, by: { code: "Z3P9TR", name: "となり" }, node: "quarry", taken: true, stars: 3, won: 28, credits: 140, replay },
    ],
  };
  const { ctx, pg } = await camp(browser, port, save, errors, "attacks");
  if (!(await pg.evaluate(() => window.ringfallCamp.open("signal")))) errors.push("attacks: the signal station did not open");
  await pg.evaluate(() => window.advanceTime(400));
  const rows = await pg.evaluate(() => [...document.querySelectorAll("#hub-attacks .attack-records li")].map((li) => ({ text: li.textContent, watch: !!li.querySelector(".watch") })));
  if (rows.length !== 2 || !/となり/.test(rows[0]?.text ?? "") || !rows[0].watch || rows[1].watch || !/−28/.test(rows[0].text) || !/−140/.test(rows[0].text)) errors.push(`attacks: the signal station's records read ${JSON.stringify(rows)}`);
  if (!rows.length) errors.push(`attacks: panel ${await pg.evaluate(() => (document.getElementById("hub-attacks")?.outerHTML ?? "none").slice(0, 200))}; saved ${await pg.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "{}").attacks?.length, KEY)}`);
  if (!rows.some((r) => r.watch)) {
    await ctx.close();
    return;
  }
  await pg.click("#hub-attacks .watch");
  await pg.waitForTimeout(300);
  const shown = await pg.evaluate(() => {
    const c = document.querySelector("#hub-attacks canvas.attack-map");
    c?.scrollIntoView({ block: "center" });
    return !!c && !c.hidden && c.clientWidth > 100;
  });
  if (!shown) errors.push("attacks: 見る did not show the record's map");
  await pg.waitForTimeout(200);
  await pg.screenshot({ path: `${out}/157-attack-record.png` });
  await ctx.close();
}

// Alone: serve the build and run the signal station's shots.
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
  await signalShots({ browser, port: server.address().port, out, errors });
  await browser.close();
  server.close();
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exit(1);
  }
  console.log("signal shots ok");
}
