/**
 * Screenshots for the goal-guidance stack: どこで取れる → 地図で見る → 出撃 → 着地 HUD →
 * ミニマップ / レイド地図. Run against the build (`npm run build`):
 *
 *   node scripts/ringfall-shots-goal-guide.mjs
 *
 * Writes to shots/ringfall/goal-guide/ and /opt/cursor/artifacts/ when present.
 */
import { createServer } from "node:http";
import { readFile, mkdir, copyFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { chromium } from "playwright-core";

const KEY = "ringfall.profile.v1";
const valuables = (list) => list.flatMap(([kind, n]) => Array.from({ length: n }, () => ({ t: "valuable", kind })));
/** Mid-late base: storage needs a data core next; cash for the workshop row to show. */
const BASE = {
  v: 42,
  cash: 8000,
  raids: 16,
  extracted: 12,
  time: 12000,
  region: "reservoir",
  entry: "beach",
  seed: 777,
  day: 18,
  depots: ["supply", "quarry"],
  seen: "",
  entries: ["beach", "checkpoint", "jetty"],
  routes: [],
  known: [],
  pending: [],
  goal: null,
  news: [],
  hideout: { infirmary: 2, workbench: 2, storage: 3, radio: 1, pouch: 1 },
  factory: 2,
  poiState: {
    supply: { state: "own" },
    quarry: { state: "own" },
    weather: { state: "own" },
    waterworks: { state: "foe" },
    relay: { state: "foe" },
  },
  stash: [{ t: "weapon", kind: "pike", rarity: 0 }, { t: "weapon", kind: "talon", rarity: 0 }, ...valuables([["board", 4], ["drive", 3], ["gyro", 3]])],
};

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
const port = server.address().port;
const out = "shots/ringfall/goal-guide";
const artifacts = "/opt/cursor/artifacts";
await mkdir(out, { recursive: true });
await mkdir(artifacts, { recursive: true }).catch(() => undefined);

const errors = [];
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const pg = await ctx.newPage();
pg.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
pg.on("console", (m) => m.type() === "error" && !/fonts\.g|ERR_TUNNEL|net::/.test(m.text()) && errors.push(`console: ${m.text()}`));

await pg.addInitScript(([k, v]) => localStorage.setItem(k, v), [KEY, JSON.stringify(BASE)]);
await pg.goto(`http://localhost:${port}/ringfall/`, { waitUntil: "load" });
await pg.waitForTimeout(400);
await pg.click("#start");
await pg.waitForFunction(() => getComputedStyle(document.getElementById("fade")).opacity === "0", null, { timeout: 8000 }).catch(() => errors.push("fade never cleared"));
await pg.waitForTimeout(100);

const shot = async (name) => {
  const path = `${out}/${name}.png`;
  await pg.screenshot({ path });
  await copyFile(path, `${artifacts}/goal-guide-${name}.png`).catch(() => undefined);
  console.log("shot", name);
};

const read = async () => JSON.parse(await pg.evaluate(() => window.render_game_to_text()));

// 1. Workshop → open どこで取れる for データコア (storage next level).
if (!(await pg.evaluate(() => window.ringfallCamp.walkTo("workshop")))) errors.push("could not stand at workshop");
await pg.evaluate(() => window.advanceTime(100));
await pg.keyboard.press("KeyE");
await pg.evaluate(() => window.advanceTime(50));
await pg.waitForTimeout(200);
if ((await read()).camp?.panel !== "workshop") errors.push("workshop panel did not open");
// Open the storage module so its cost rows (with データコア) show.
const modBtn = pg.locator('#hub-side .up-card[data-mod="storage"] button, #hub-side .up-card[data-mod="storage"]');
if (await modBtn.count()) await modBtn.first().click();
await pg.waitForTimeout(150);
const openCore = pg.locator('button.src-open[data-kind="core"]');
if (!(await openCore.count())) {
  // Fall back: any src-open, or force via evaluate.
  const kinds = await pg.evaluate(() => [...document.querySelectorAll("button.src-open")].map((b) => b.dataset.kind));
  console.log("src-open kinds", kinds);
  if (kinds.includes("core")) await pg.click('button.src-open[data-kind="core"]');
  else errors.push("no どこで取れる for core");
} else {
  await openCore.click();
}
await pg.waitForTimeout(200);
const guide = await pg.locator(".src-guide[data-kind=core]").count();
if (!guide) errors.push("source guide for core did not open");
const titanRow = await pg.locator(".src-guide .src-row", { hasText: "タイタン" }).count();
if (!titanRow) errors.push("タイタン row missing in source guide");
await shot("01-sources-core");

// 1b. 目標にする → 目標にしている
await pg.evaluate(() => document.querySelector('.src-guide button.src-goal[data-kind="core"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
await pg.waitForTimeout(250);
const activeText = await pg.evaluate(() => document.querySelector(".src-guide button.src-goal")?.textContent ?? "");
if (activeText !== "目標にしている") errors.push(`目標にしている not shown after set-goal (got "${activeText}")`);
await shot("01b-goal-active");

// 2. Click 地図で見る on the titan row — sets goal + opens depart.
const mapBtn = pg.locator(".src-guide .src-row", { hasText: "タイタン" }).locator(".src-map");
if (!(await mapBtn.count())) errors.push("地図で見る for タイタン missing");
else await mapBtn.first().click();
await pg.waitForTimeout(400);
await pg.waitForFunction(() => !document.getElementById("depart").hidden, null, { timeout: 5000 }).catch(() => errors.push("depart never opened"));
await pg.waitForTimeout(300);
const goal = await pg.evaluate(() => JSON.parse(localStorage.getItem("ringfall.profile.v1") || "{}").goal);
if (goal !== "core") errors.push(`goal after 地図で見る is ${goal}, want core`);
await shot("02-depart-after-see-on-map");

// 3. Confirm depart from the chosen start (nearest to pad — checkpoint).
await pg.waitForFunction(() => document.querySelectorAll("#depart-points button.pick").length > 0, null, { timeout: 4000 }).catch(() => errors.push("depart starts missing"));
const start = await pg.evaluate(() => {
  const on = document.querySelector("#depart-points button.pick.on");
  return on ? { kind: on.dataset.kind, id: on.dataset.id, text: on.textContent } : null;
});
console.log("chosen start", start);
await pg.click("#depart-go");
await pg.waitForFunction(() => JSON.parse(window.render_game_to_text()).screen === "game", null, { timeout: 8000 }).catch(() => errors.push("raid never started"));
await pg.waitForFunction(() => getComputedStyle(document.getElementById("fade")).opacity === "0", null, { timeout: 8000 }).catch(() => undefined);
await pg.evaluate(() => window.ringfallDraw());
await pg.waitForTimeout(200);
const banner = await pg.evaluate(() => ({
  head: document.getElementById("banner-head")?.textContent,
  sub: document.getElementById("banner-sub")?.textContent,
  cls: document.getElementById("banner")?.className,
}));
console.log("banner", banner);
if (!/着いた/.test(banner.head ?? "") || !/タイタン/.test(banner.sub ?? "")) errors.push(`landing banner reads ${JSON.stringify(banner)}`);
await shot("03-landed-banner");

// 4. Let the banner clear; check compass mark text.
await pg.evaluate(() => window.advanceTime(4000));
await pg.evaluate(() => window.ringfallDraw());
const mark = await pg.evaluate(() => {
  const el = document.getElementById("compass-mark");
  return { hidden: el?.hidden, text: el?.textContent, hunt: el?.classList.contains("hunt") };
});
console.log("compass", mark);
if (mark.hidden || !/タイタン/.test(mark.text ?? "") || !mark.hunt) errors.push(`compass mark reads ${JSON.stringify(mark)}`);
const obj = await pg.evaluate(() => ({
  title: document.getElementById("obj-title")?.textContent,
  text: document.getElementById("obj-text")?.textContent,
}));
console.log("objective", obj);
await shot("04-hud-compass-goal");

// 5. Minimap (corner) — goal pin should be present via canvas; just capture HUD with mini.
await shot("05-minimap-hud");

// 6. Raid map (M) framed on region — expect 発着場 / タイタン / ダム湖.
await pg.keyboard.press("KeyM");
await pg.evaluate(() => window.advanceTime(200));
await pg.evaluate(() => window.ringfallDraw());
await pg.waitForTimeout(300);
await shot("06-raid-map-goal");
// Whole island (N)
await pg.keyboard.press("KeyN");
await pg.evaluate(() => window.advanceTime(200));
await pg.evaluate(() => window.ringfallDraw());
await pg.waitForTimeout(300);
await shot("07-raid-map-world");

await browser.close();
server.close();

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("goal-guide shots ok");
