/**
 * Map readability shots: departure, raid map (region + whole), minimap,
 * and results day map, at desktop / tablet / phone landscape / phone portrait.
 * Writes to shots/ringfall/map-compare/<tag>/ (pass BEFORE or AFTER as argv[2]).
 *
 *   node scripts/ringfall-shots-map-fit.mjs BEFORE
 *   node scripts/ringfall-shots-map-fit.mjs AFTER
 */
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { chromium } from "playwright-core";

const KEY = "ringfall.profile.v1";
const HELD = ["supply", "quarry", "relay", "station", "waterworks", "lodge", "yard", "smelter", "cannery", "coldstore"];
const SAVE = {
  v: 29,
  cash: 4000,
  raids: 12,
  extracted: 8,
  time: 12000,
  region: "reservoir",
  entry: "beach",
  seed: 4242,
  day: 12,
  factory: 2,
  stash: [],
  entries: ["beach", "checkpoint", "jetty", "outskirts", "quay"],
  depots: HELD,
  seen: "f".repeat(4000),
  quests: { progress: {}, done: [] },
  poiState: Object.fromEntries(HELD.map((id) => [id, { state: "freed" }])),
  logSeq: 0,
  retaken: [],
};
const NEAR = [
  { code: "Z3P9TR", name: "となり", held: 7, total: 21, day: 15, slot: 0, last: { at: Date.now() - 3 * 3600_000, captured: 2, home: true } },
  { code: "K7M2QX", name: "みなと", held: 4, total: 21, day: 9, slot: 2 },
  { code: "H4N8WD", name: "砂丘の人", held: 11, total: 21, day: 22, slot: 3 },
];

const SIZES = [
  { id: "pc", w: 1280, h: 720 },
  { id: "tablet", w: 1024, h: 768 },
  { id: "phone-land", w: 844, h: 390, touch: true },
  { id: "phone-port", w: 390, h: 844, touch: true },
];

const tag = (process.argv[2] ?? "AFTER").toUpperCase() === "BEFORE" ? "before" : "after";
const root = process.env.SHOTS_ROOT ?? ".cloudflare/output/v0/workers/default/assets";
const outRoot = `shots/ringfall/map-compare/${tag}`;
const artRoot = `/opt/cursor/artifacts/map-compare/${tag}`;
await mkdir(outRoot, { recursive: true });
await mkdir(artRoot, { recursive: true });

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
const server = createServer(async (req, res) => {
  let path = join(root, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (path.endsWith("/")) path += "index.html";
  try {
    const body = await readFile(path);
    res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(0);
const port = server.address().port;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});

const notes = [];
const snap = async (pg, name) => {
  const dest = `${outRoot}/${name}.png`;
  await pg.screenshot({ path: dest });
  await pg.screenshot({ path: `${artRoot}/${name}.png` });
};

const measureMap = async (pg, sel) =>
  pg.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const canvas = el.tagName === "CANVAS" ? el : el.querySelector("canvas");
    const cr = canvas?.getBoundingClientRect();
    return {
      box: { w: Math.round(r.width), h: Math.round(r.height), t: Math.round(r.top), b: Math.round(r.bottom), l: Math.round(r.left), right: Math.round(r.right) },
      canvas: cr && { w: Math.round(cr.width), h: Math.round(cr.height), aspect: +(cr.width / cr.height).toFixed(3) },
      win: { w: innerWidth, h: innerHeight },
      clipped: r.bottom > innerHeight + 1 || r.right > innerWidth + 1 || r.left < -1 || r.top < -1,
      aspectVar: getComputedStyle(canvas || el).getPropertyValue("--map-aspect").trim(),
    };
  }, sel);

for (const size of SIZES) {
  const ctx = await browser.newContext({
    viewport: { width: size.w, height: size.h },
    hasTouch: !!size.touch,
    isMobile: !!size.touch,
  });
  const pg = await ctx.newPage();
  await pg.addInitScript(([k, v]) => localStorage.setItem(k, v), [KEY, JSON.stringify(SAVE)]);
  await pg.addInitScript((v) => localStorage.setItem("ringfall.neighbours.v1", v), JSON.stringify({ neighbours: NEAR }));
  await pg.goto(`http://localhost:${port}/ringfall/`, { waitUntil: "load" });
  await pg.waitForTimeout(250);
  // Portrait is blocked by #rotate in play; for map layout shots, hide it so tall viewports still open the screens.
  if (size.h > size.w) {
    await snap(pg, `${size.id}-00-rotate`);
    await pg.evaluate(() => {
      const r = document.getElementById("rotate");
      if (r) r.style.display = "none";
    });
  }
  await pg.click("#start", { force: true });
  await pg.waitForFunction(() => getComputedStyle(document.getElementById("fade")).opacity === "0", null, { timeout: 8000 }).catch(() => {});
  await pg.evaluate(() => window.advanceTime(400));
  if (size.touch) await pg.evaluate(() => document.body.classList.add("touch"));

  // Departure (island overview; 地図の机 deleted)
  await pg.evaluate(() => window.ringfallCamp.toGate());
  await pg.keyboard.down("KeyW");
  for (let i = 0; i < 40; i++) {
    const st = JSON.parse(await pg.evaluate(() => (window.advanceTime(200), window.render_game_to_text())));
    if (st.camp?.depart) break;
  }
  await pg.keyboard.up("KeyW");
  await pg.waitForTimeout(100);
  const depM = await measureMap(pg, "#depart-map");
  const starts = await pg.evaluate(() => {
    const board = document.querySelector("#depart .depart-board")?.getBoundingClientRect();
    return [...document.querySelectorAll("#depart-points button.pick")].map((b) => {
      const q = b.getBoundingClientRect();
      return {
        id: b.dataset.id,
        clipped: !board || q.left < board.left - 1 || q.right > board.right + 1 || q.top < board.top - 1 || q.bottom > board.bottom + 1,
      };
    });
  });
  notes.push({ size: size.id, screen: "depart", ...depM, startsClipped: starts.filter((s) => s.clipped).map((s) => s.id) });
  await snap(pg, `${size.id}-01-depart`);
  await pg.keyboard.press("Enter");
  await pg.waitForTimeout(400);
  for (let i = 0; i < 25; i++) {
    const st = JSON.parse(await pg.evaluate(() => (window.advanceTime(200), window.render_game_to_text())));
    if (st.screen === "game") break;
  }
  await pg.evaluate(() => window.advanceTime(800));

  // Raid map region
  await pg.keyboard.press("KeyM");
  await pg.evaluate(() => window.advanceTime(200));
  await pg.waitForTimeout(80);
  const mapM = await measureMap(pg, "#map-canvas");
  notes.push({ size: size.id, screen: "raid-map-region", ...mapM });
  await snap(pg, `${size.id}-03-raid-map-region`);

  // Whole world
  await pg.keyboard.press("KeyN");
  await pg.evaluate(() => window.advanceTime(200));
  await pg.waitForTimeout(80);
  const wholeM = await measureMap(pg, "#map-canvas");
  notes.push({ size: size.id, screen: "raid-map-whole", ...wholeM });
  await snap(pg, `${size.id}-04-raid-map-whole`);
  await pg.keyboard.press("KeyM");
  await pg.evaluate(() => window.advanceTime(100));

  // Minimap (hidden on small / touch)
  const mini = await measureMap(pg, "#minimap");
  notes.push({ size: size.id, screen: "minimap", ...mini, hidden: await pg.evaluate(() => getComputedStyle(document.getElementById("minimap")).display === "none") });
  if (mini && !(await pg.evaluate(() => getComputedStyle(document.getElementById("minimap")).display === "none"))) {
    await snap(pg, `${size.id}-05-minimap`);
  }

  // Results day map: end the raid alive via home when possible, else force results
  await pg.evaluate(() => {
    if (typeof window.ringfallEnd === "function") window.ringfallEnd("extracted", []);
  });
  await pg.evaluate(() => window.advanceTime(500));
  for (let i = 0; i < 20; i++) {
    const st = JSON.parse(await pg.evaluate(() => (window.advanceTime(200), window.render_game_to_text())));
    const hasDay = await pg.evaluate(() => !!document.getElementById("day-map"));
    if (st.screen === "results" || hasDay) break;
  }
  await pg.waitForTimeout(200);
  const day = await measureMap(pg, "#day-map");
  notes.push({ size: size.id, screen: "results-day", ...day });
  if (day) await snap(pg, `${size.id}-06-results-day`);

  await ctx.close();
  console.log(`ok ${size.id}`);
}

await writeFile(`${outRoot}/notes.json`, JSON.stringify(notes, null, 2));
await writeFile(`${artRoot}/notes.json`, JSON.stringify(notes, null, 2));
console.log(`wrote ${outRoot} (${notes.length} notes)`);
await browser.close();
server.close();
process.exit(0);
