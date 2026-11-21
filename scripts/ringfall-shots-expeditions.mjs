/**
 * The expeditions' screenshots for the shots gate (scripts/ringfall-shots.mjs runs them;
 * `node scripts/ringfall-shots-expeditions.mjs` runs them alone against the build): a profile
 * another player's expedition is sent at (`Profile.incoming`) with expeditions of its own out. The
 * map table marks the node sent at with a green arrow and lists who is coming; the other islands
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
  cycle: 0, cycleDay: 1, liberations: [],
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
  // The landing is 5.4 hours from when these screens are shot, not from when the gate started: the map table rounds it up to 6.
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
  if (!/となり.*中継塔.*6h/.test(news)) errors.push(`expeditions: the map table's warning reads "${news}"`);
  await pg.screenshot({ path: `${out}/150-expeditions-map.png` });
  await close();
  // The island's news as marks: someone's attack offers 仕返し, which opens the factory on their island.
  await pg.evaluate(() =>
    window.ringfallNews([
      { seq: 2, at: 0, t: "taken", node: "yard", by: { code: "Z3P9TR", name: "となり" } },
      { seq: 1, at: 0, t: "wiped", node: "quarry", by: { code: "K7M2QX", name: "みなと" } },
    ]),
  );
  // The other islands are the signal station's (信号所), not the map table's: its mark tells of the news until it is opened.
  const mark = await pg.evaluate(() => JSON.parse(window.render_game_to_text()).camp?.marks?.signal ?? "");
  if (!/知らせ 2/.test(mark)) errors.push(`expeditions: the signal station's mark reads "${mark}"`);
  await open("map");
  const onMap = await pg.evaluate(() => document.querySelectorAll("#hub-side .island-news:not(.incoming), #hub-side .revenge").length);
  if (onMap) errors.push(`expeditions: the map table still lists ${onMap} pieces of the other islands' news`);
  await close();
  // The station itself in the yard: its mast and green lamp, its name and mark over it.
  if (!(await pg.evaluate(() => window.ringfallCamp.walkTo("signal")))) errors.push("expeditions: could not stand at the signal station");
  await pg.evaluate(() => window.advanceTime(300));
  await pg.screenshot({ path: `${out}/156-camp-signal.png` });
  await open("signal");
  const answer = await pg.evaluate(() => ({ items: document.querySelectorAll(".island-news.signal-news li").length, buttons: document.querySelectorAll(".island-news .revenge").length }));
  if (answer.items !== 2 || answer.buttons !== 1) errors.push(`expeditions: the signal station's news shows ${answer.items} items and ${answer.buttons} 仕返し, not 2 and 1`);
  // The neighbours first: whose, how much they hold, what they did last (the kept list's last raid read back).
  const near = await pg.evaluate(() => [...document.querySelectorAll("#hub-exped .exp-near button")].map((b) => b.textContent));
  // Slot 1 (the waterworks' sea) is left free by the server: one of the game's own islands stands there, marked AI.
  const ai = await pg.evaluate(() => document.querySelectorAll("#hub-exped .exp-near .ai-tag").length);
  if (near.length !== 4 || ai !== 1 || !/となり.*7\/21.*3h.*\+2/.test(near[0] ?? "")) errors.push(`expeditions: the signal station's neighbours read ${JSON.stringify(near)}, ${ai} marked AI`);
  await pg.screenshot({ path: `${out}/150-expeditions-news.png` });
  await pg.click(".island-news .revenge");
  await pg.evaluate(() => window.advanceTime(200));
  const panel = await pg.evaluate(() => JSON.parse(window.render_game_to_text()).camp?.panel ?? null);
  if (panel !== "signal") errors.push(`expeditions: 仕返し opened ${panel}, not the signal station`);
  await close();
  // The factory's panel is the factory's alone: the squads out on expeditions in a line, nothing to send from.
  await open("factory");
  const factory = await pg.evaluate(() => ({ exped: !!document.querySelector("#hub-exped"), away: document.querySelector(".factory-away")?.textContent ?? "" }));
  if (factory.exped || !/遠征\s*2/.test(factory.away)) errors.push(`expeditions: the factory's panel reads ${JSON.stringify(factory)}`);
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
  if (before.length !== 2 || !before.every((e) => e.recall) || !/保持中/.test(before[0].text) || !/足止め/.test(before[1].text)) errors.push(`expeditions: the factory lists ${JSON.stringify(before)}`);
  await pg.waitForTimeout(100);
  await pg.screenshot({ path: `${out}/151-expeditions-signal.png` });
  // Called home: its squad is back at once, and it waits for its island to be told.
  await pg.click("#hub-exped .exp-out .exp-recall");
  await pg.waitForTimeout(200);
  const after = await list();
  const away = await pg.evaluate(() => document.querySelector("#hub-exped .mod-head b")?.textContent ?? "");
  if (!/引き上げ中/.test(after[0]?.text ?? "") || after[0].recall || !/遠征 1 \//.test(away.trim())) errors.push(`expeditions: after a recall the factory lists ${JSON.stringify(after)} with ${away} away`);
  await pg.screenshot({ path: `${out}/152-expeditions-recalled.png` });
  // The game's own island facing the waterworks answers with no server: its nodes open, and one sent goes on its way.
  await pg.click("#hub-exped .exp-near button:has(.ai-tag)");
  await pg.waitForTimeout(200);
  const nodes = await pg.evaluate(() => document.querySelectorAll("#hub-exped .exp-target .exp-nodes button").length);
  if (!nodes) errors.push("expeditions: the game's own island shows no node to send to");
  else {
    await pg.click("#hub-exped .exp-target .exp-nodes button");
    await pg.click("#hub-exped .exp-go");
    await pg.waitForTimeout(300);
    const sent = await list();
    if (sent.length !== 3 || !/向かっている/.test(sent[2]?.text ?? "")) errors.push(`expeditions: after sending to the game's own island the factory lists ${JSON.stringify(sent)}`);
  }
  await pg.screenshot({ path: `${out}/154-expeditions-ai.png` });
  await close();
  // The departure's map carries the arrow.
  await pg.evaluate(() => window.ringfallCamp.toGate());
  await pg.keyboard.down("KeyW");
  let st = JSON.parse(await pg.evaluate(() => window.render_game_to_text()));
  for (let i = 0; i < 30 && !st.camp?.depart; i++) st = JSON.parse(await pg.evaluate(() => (window.advanceTime(200), window.render_game_to_text())));
  await pg.keyboard.up("KeyW");
  if (!st.camp?.depart) errors.push("expeditions: the departure did not open");
  const row = st.camp?.depart?.rows?.find((r) => r[0] === "来る遠征")?.[1] ?? "";
  if (!/となり/.test(row) || !/固め/.test(row)) errors.push(`expeditions: the departure's warning reads "${row}"`);
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
