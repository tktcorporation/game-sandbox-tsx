/**
 * The expeditions' screenshots for the shots gate (scripts/ringfall-shots.mjs runs them;
 * `node scripts/ringfall-shots-expeditions.mjs` runs them alone against the build): a profile
 * another player's expedition is sent at (`Profile.incoming`) with expeditions of its own out. The
 * departure map may mark neighbours; the other islands
 * are the signal station's (信号所): its mark tells of the island's news, its panel lists the
 * neighbours (one of the game's own, marked AI), the news with 仕返し and the expeditions out, each
 * that can be called home with its button, and calling one home gives its squad back at once; the
 * factory's panel says only how many squads are out; the departure's map carries the arrow too, and its side names the node and what to do. No island server
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
  stash: [], entries: ["beach", "checkpoint", "jetty"], depots: HELD, seen: "f".repeat(4000),
  quests: { progress: {}, done: [] },
  poiState: { ...Object.fromEntries(HELD.map((id) => [id, { state: "freed" }])), yard: { state: "rival:Z3P9TR" } },
  incoming: [{ id: 3, by: { code: "Z3P9TR", name: "となり" }, node: "relay", arriveAt: 0, state: "coming" }],
  expeditions: [
    { code: "K7M2QX", node: "quarry", sentAt: 1, id: 4, units: 4, state: "holding" },
    { code: "K7M2QX", node: "smelter", sentAt: 2, id: 6, units: 4, state: "waiting" },
  ],
  logSeq: 0, retaken: [],
};

const NEAR = [
  { code: "Z3P9TR", name: "となり", held: 7, total: 21, day: 15, slot: 0, last: { at: Date.now() - 3 * 3600_000, captured: 2, home: true } },
  { code: "K7M2QX", name: "みなと", held: 4, total: 21, day: 9, slot: 2 },
  { code: "H4N8WD", name: "砂丘の人", held: 11, total: 21, day: 22, slot: 3, last: { at: Date.now() - 26 * 3600_000, captured: 0, home: false } },
];

export async function expeditionShots({ browser, port, out, errors }) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const pg = await ctx.newPage();
  pg.on("pageerror", (e) => errors.push(`expeditions pageerror: ${e.message}`));
  pg.on("console", (m) => m.type() === "error" && !/fonts\.g|ERR_TUNNEL|net::/.test(m.text()) && errors.push(`expeditions console: ${m.text()}`));
  await pg.addInitScript(([k, v]) => localStorage.getItem(k) || localStorage.setItem(k, v), [KEY, JSON.stringify({ ...SAVE, incoming: SAVE.incoming.map((e) => ({ ...e, arriveAt: Date.now() + 5.4 * 3_600_000 })) })]);
  // The neighbours the server offered at the last sync, as the browser keeps them (island-net.ts): drawn out at sea on the camp's maps.
  await pg.addInitScript((v) => localStorage.setItem("ringfall.neighbours.v1", v), JSON.stringify({ neighbours: NEAR }));
  // The landing is 5.4 hours from when these screens are shot, not from when the gate started.
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
  // 地図の机 deleted: open refused; 来る遠征 warnings stay gone.
  if (await pg.evaluate(() => window.ringfallCamp.open("map"))) errors.push("expeditions: open(map) still worked");
  // The island's news as marks (E4: no 遠征に出す answer button).
  await pg.evaluate(() =>
    window.ringfallNews([
      { seq: 2, at: 0, t: "taken", node: "yard", by: { code: "Z3P9TR", name: "となり" } },
      { seq: 1, at: 0, t: "wiped", node: "quarry", by: { code: "K7M2QX", name: "みなと" } },
    ]),
  );
  // The other islands are the signal station's (信号所): its mark tells of the news until it is opened.
  const mark = await pg.evaluate(() => JSON.parse(window.render_game_to_text()).camp?.marks?.signal ?? "");
  if (!/知らせ 2/.test(mark)) errors.push(`expeditions: the signal station's mark reads "${mark}"`);
  // The station itself in the yard: its mast and green lamp, its name and mark over it.
  if (!(await pg.evaluate(() => window.ringfallCamp.walkTo("signal")))) errors.push("expeditions: could not stand at the signal station");
  await pg.evaluate(() => window.advanceTime(300));
  await pg.screenshot({ path: `${out}/156-camp-signal.png` });
  await open("signal");
  const answer = await pg.evaluate(() => ({ items: document.querySelectorAll(".island-news.signal-news li").length, buttons: document.querySelectorAll(".island-news .revenge, #hub-exped .exp-go").length }));
  if (answer.items !== 2 || answer.buttons !== 0) errors.push(`expeditions: the signal station's news shows ${answer.items} items and ${answer.buttons} send/revenge buttons (E4 expects 2 and 0)`);
  // News that comes while the station is open shows at once.
  await pg.evaluate(() => window.ringfallNews([{ seq: 3, at: 0, t: "landed", node: "relay", by: { code: "H4N8WD", name: "砂丘の人" } }]));
  const more = await pg.evaluate(() => document.querySelectorAll(".island-news.signal-news li").length);
  if (more !== 3) errors.push(`expeditions: news that came with the signal station open shows ${more} items, not 3`);
  // The neighbours first: whose, how much they hold, what they did last (the kept list's last raid read back).
  const near = await pg.evaluate(() => [...document.querySelectorAll("#hub-exped .exp-near button")].map((b) => b.textContent));
  // Slot 1 (the waterworks' sea) is left free by the server: one of the game's own islands stands there, marked AI.
  const ai = await pg.evaluate(() => document.querySelectorAll("#hub-exped .exp-near .ai-tag").length);
  if (near.length !== 4 || ai !== 1 || !/となり.*7\/21.*3h.*\+2/.test(near[0] ?? "")) errors.push(`expeditions: the signal station's neighbours read ${JSON.stringify(near)}, ${ai} marked AI`);
  await pg.screenshot({ path: `${out}/150-expeditions-news.png` });
  await close();
  // The factory's panel is the factory's alone (Option A: no expedition line).
  await open("factory");
  const factory = await pg.evaluate(() => ({ exped: !!document.querySelector("#hub-exped"), away: !!document.querySelector(".factory-away") }));
  if (factory.exped || factory.away) errors.push(`expeditions: the factory's panel still shows expeditions ${JSON.stringify(factory)}`);
  await pg.screenshot({ path: `${out}/155-expeditions-factory-only.png` });
  await close();
  // The signal station: the expeditions out, each with its state and its recall.
  await open("signal");
  const list = () =>
    pg.evaluate(() => {
      document.querySelector("#hub-exped")?.scrollIntoView({ block: "end" });
      return [...document.querySelectorAll("#hub-exped .exp-out")].map((el) => ({ state: el.className, text: el.textContent, recall: !!el.querySelector(".exp-recall") }));
    });
  const before = await list();
  if (before.length !== 2 || !before.every((e) => e.recall) || !/保持中/.test(before[0].text) || !/足止め/.test(before[1].text)) errors.push(`expeditions: the signal station lists ${JSON.stringify(before)}`);
  // Head must not look like an attack entry (no 「遠征 n/m」).
  const head = await pg.evaluate(() => document.querySelector("#hub-exped .mod-head")?.textContent ?? "");
  if (/遠征\s*\d/.test(head)) errors.push(`expeditions: signal head still looks like an attack entry: "${head}"`);
  await pg.waitForTimeout(100);
  await pg.screenshot({ path: `${out}/151-expeditions-signal.png` });
  // Called home: its squad is back at once, and it waits for its island to be told.
  await pg.click("#hub-exped .exp-out .exp-recall");
  await pg.waitForTimeout(200);
  const after = await list();
  const cost = await pg.evaluate(() => document.querySelector("#hub-exped .exp-cost")?.textContent ?? "");
  if (!/引き上げ中/.test(after[0]?.text ?? "") || after[0].recall || !/遠征\s*1/.test(cost)) errors.push(`expeditions: after a recall the list is ${JSON.stringify(after)} with cost "${cost}"`);
  await pg.screenshot({ path: `${out}/152-expeditions-recalled.png` });
  // E4: looking up an AI neighbour shows open nodes read-only, with no send button.
  await pg.click("#hub-exped .exp-near button:has(.ai-tag)");
  await pg.waitForTimeout(200);
  const look = await pg.evaluate(() => ({
    nodes: document.querySelectorAll("#hub-exped .exp-target .exp-nodes .exp-node").length,
    send: !!document.querySelector("#hub-exped .exp-go"),
  }));
  if (!look.nodes || look.send) errors.push(`expeditions: AI neighbour look reads ${JSON.stringify(look)} (expect nodes > 0, no send)`);
  await pg.screenshot({ path: `${out}/154-expeditions-ai.png` });
  await close();
  // The departure's map carries the arrow.
  await pg.evaluate(() => window.ringfallCamp.toGate());
  await pg.keyboard.down("KeyW");
  let st = JSON.parse(await pg.evaluate(() => window.render_game_to_text()));
  for (let i = 0; i < 30 && !st.camp?.depart; i++) st = JSON.parse(await pg.evaluate(() => (window.advanceTime(200), window.render_game_to_text())));
  await pg.keyboard.up("KeyW");
  if (!st.camp?.depart) errors.push("expeditions: the departure did not open");
  const incomingRow = st.camp?.depart?.rows?.find((r) => r[0] === "来る遠征");
  if (incomingRow) errors.push(`expeditions: depart still lists 来る遠征: ${JSON.stringify(incomingRow)}`);
  const assault = st.camp?.depart?.starts?.find((s) => s.kind === "assault");
  if (assault) errors.push("expeditions: depart still has removed assault start");
  await pg.screenshot({ path: `${out}/153-expeditions-depart.png` });
  // Into the raid: AI scout still lands (auto defence) — banner is fine; no pre-raid warning.
  await pg.keyboard.press("Enter");
  let raid = null;
  for (let i = 0; i < 40 && !raid?.battle; i++) raid = JSON.parse(await pg.evaluate(() => (window.ringfallStep(200), window.render_game_to_text())));
  if (!raid?.battle) errors.push("expeditions: the raid did not start");
  else {
    let head = "";
    for (let t = 0; t < 260 && !/遠征隊/.test(head); t += 2) head = await pg.evaluate(() => (window.ringfallStep(2000), document.getElementById("banner-head")?.textContent ?? ""));
    const sub = await pg.evaluate(() => document.getElementById("banner-sub")?.textContent ?? "");
    if (!/(ツバキ|アサギ|シオン)の遠征隊/.test(head) || !/浄水場/.test(sub)) errors.push(`expeditions: the scout's landing reads "${head}" "${sub}"`);
    await pg.evaluate(() => window.ringfallDraw?.());
    await pg.screenshot({ path: `${out}/158-expeditions-landing.png` });
  }
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
    v: 54,
    poiState: Object.fromEntries(HELD.map((id) => [id, { state: id === "quarry" ? "foe" : "own" }])),
    incoming: [],
    expeditions: [],
    attacks: [
      { seq: 4, at: now - 26 * 3600_000, by: { code: "K7M2QX", name: "みなと" }, node: "relay", taken: false, stars: 1, won: 6 },
      { seq: 9, at: now - 2 * 3600_000, by: { code: "Z3P9TR", name: "となり" }, node: "quarry", taken: true, stars: 3, won: 28, credits: 140, replay },
    ],
  };
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const pg = await ctx.newPage();
  pg.on("pageerror", (e) => errors.push(`attacks pageerror: ${e.message}`));
  await pg.addInitScript(([k, v]) => localStorage.getItem(k) || localStorage.setItem(k, v), [KEY, JSON.stringify(save)]);
  await pg.addInitScript((v) => localStorage.setItem("ringfall.neighbours.v1", v), JSON.stringify({ neighbours: NEAR }));
  // The first camp's cards about the other islands, already read.
  await pg.addInitScript(() => localStorage.setItem("ringfall.mpHowto.v1", "1"));
  await pg.goto(`http://localhost:${port}/ringfall/`, { waitUntil: "load" });
  await pg.waitForTimeout(300);
  await pg.click("#start");
  await pg.waitForFunction(() => getComputedStyle(document.getElementById("fade")).opacity === "0", null, { timeout: 8000 }).catch(() => errors.push("attacks: the fade never cleared"));
  await pg.evaluate(() => window.advanceTime(300));
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
