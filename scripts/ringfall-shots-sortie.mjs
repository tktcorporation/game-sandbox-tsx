/**
 * Screenshots of a sortie to a neighbour's holding (docs/ringfall/holdings-raid.md): the gate's
 * 攻める list → one holding chosen → the sortie's start at its depot → the results after its time
 * runs out. Run against the build (`npm run build`):
 *
 *   node scripts/ringfall-shots-sortie.mjs
 *
 * Writes to shots/ringfall/sortie/. Fails on a page error or when a step does not come.
 */
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { chromium } from "playwright-core";

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
const out = "shots/ringfall/sortie";
await mkdir(out, { recursive: true });

const errors = [];
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
// SORTIE_PHONE=1 shoots the same loop on a phone held sideways (file names start with m).
const phone = process.env.SORTIE_PHONE === "1";
const pre = phone ? "m" : "";
const ctx = await browser.newContext(phone ? { viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true } : { viewport: { width: 1280, height: 720 } });
const pg = await ctx.newPage();
pg.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
pg.on("console", (m) => m.type() === "error" && !/fonts\.g|ERR_TUNNEL|net::|api\//.test(m.text()) && errors.push(`console: ${m.text()}`));

const read = async () => JSON.parse(await pg.evaluate(() => window.render_game_to_text()));
const shot = async (name) => {
  await pg.evaluate(() => window.ringfallDraw?.());
  await pg.screenshot({ path: `${out}/${pre}${name}.png` });
  console.log("shot", name);
};

// The first-day cards are another shot's: seen already here.
await pg.addInitScript(() => localStorage.setItem("ringfall.mpHowto.v1", "1"));
await pg.goto(`http://localhost:${port}/ringfall/`, { waitUntil: "load" });
await pg.waitForTimeout(400);
await pg.click("#start");
await pg.waitForFunction(() => getComputedStyle(document.getElementById("fade")).opacity === "0", null, { timeout: 8000 }).catch(() => errors.push("fade never cleared"));

// The camp as a day starts: the day's line and 今日の作戦.
await pg.waitForTimeout(500);
await shot("00-camp");
await pg.evaluate(() => window.ringfallCamp.open("signal"));
await pg.waitForTimeout(300);
await shot("00b-signal");
await pg.evaluate(() => window.ringfallCamp.close());
// The gate: the departure opens with the 攻める list.
await pg.evaluate(() => window.ringfallCamp.toGate());
await pg.evaluate(() => window.ringfallCamp.openDepart());
let st = await read();
for (let i = 0; i < 30 && !st.camp?.depart; i++) st = JSON.parse(await pg.evaluate(() => (window.advanceTime(200), window.render_game_to_text())));
if (!st.camp?.depart) errors.push("the departure did not open");
await pg.waitForTimeout(300);
const rows = await pg.locator("#depart-attack-list button[data-owner]").count();
if (!rows) errors.push("the 攻める list has no holding");
await shot("01-depart-list");

// One holding chosen: the objective names it.
if (rows) {
  await pg.locator("#depart-attack-list button[data-owner]").first().click();
  await pg.waitForTimeout(200);
  const goal = await pg.locator("#depart").innerText();
  if (!goal.includes("攻める")) errors.push("the departure's objective does not say 攻める");
  await shot("02-depart-chosen");
  // Clicking the start still lit makes it a raid of the island again (it does not launch the sortie).
  await pg.locator("#depart-points button.pick.on").first().click();
  await pg.waitForTimeout(200);
  if (!(await read()).camp?.depart) errors.push("clicking the lit start launched the sortie");
  else if ((await pg.locator("#depart-attack-list button.on").count()) !== 0) errors.push("clicking the lit start kept the sortie chosen");
  await pg.locator("#depart-attack-list button[data-owner]").first().click();
  await pg.waitForTimeout(200);
  await pg.click("#depart-go");
  await pg.waitForFunction(() => document.body.classList.contains("playing"), null, { timeout: 8000 }).catch(() => errors.push("the sortie did not start"));
  await pg.waitForTimeout(800);
  st = await read();
  await pg.evaluate(() => window.advanceTime(1500));
  await shot("03-sortie-start");
  const text = await read();
  if (text.screen !== "game") errors.push(`screen ${text.screen} after the start`);
  // The time runs out: the sortie ends alive and the results come.
  for (let i = 0; i < 40; i++) {
    const s = JSON.parse(await pg.evaluate(() => (window.ringfallStep(8000), window.render_game_to_text())));
    if (s.screen !== "game") break;
  }
  // The results come a moment after the end (main.ts finish()).
  await pg.waitForFunction(() => !document.getElementById("results").hidden, null, { timeout: 6000 }).catch(() => undefined);
  await pg.waitForTimeout(800);
  const res = await pg.locator("#results").isVisible();
  if (!res) errors.push("no results after the sortie's time");
  await shot("04-results");
  await pg.screenshot({ path: `${out}/${pre}04b-results-full.png`, fullPage: true });
  // Back in the camp: the next day, and what the camp says to do next.
  if (res) {
    await pg.click("#restart");
    await pg.waitForTimeout(1500);
    await shot("05-camp-after");
    await pg.evaluate(() => window.ringfallCamp.open("signal"));
    await pg.waitForTimeout(300);
    await shot("06-signal-after");
    await pg.evaluate(() => window.ringfallCamp.close());
    await pg.evaluate(() => window.ringfallCamp.openDepart());
    await pg.waitForTimeout(400);
    await shot("07-depart-after");
  }
}

await browser.close();
server.close();
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("sortie shots ok");
