/** The port and carrier's browser gate; also run alone against the build in dist/client. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const KEY = "ringfall.profile.v1";
const NEW_NODES = ["machineworks", "motorpool", "oreworks", "coastport"];
// null height means an actual standing view on the terrain; high views have an absolute height.
export const EXPANSION_VIEWS = [
  ["port-overview", -570, 95, 310, -0.95, -0.35],
  ["oreworks-entry", -620, null, 75, -1.57, 0.10],
  ["oreworks-hall", -720, null, 38, -0.65, 0.25],
  ["oreworks-crane", -785, 19.7, 30, 1.57, 0.02],
  ["workers-quarter", -660, null, 145, -1.57, 0.12],
  ["port-entry", -645, null, 275, -1.57, 0.18],
  ["shiploader", -785, null, 330, -0.7, 0.35],
  ["loader-cab", -827, 22.1, 358, 0, -0.08],
  ["west-weighbridge", -540, null, 190, -2.0, 0.05],
  ["east-inspection", 540, null, 22, 2.35, 0.04],
  ["carrier-overview", 640, 70, 170, 0.9, -0.34],
  ["carrier-entry", 654, null, 67, 1.57, 0.15],
  ["carrier-underpass", 750, null, 30, 1.57, 0],
  ["carrier-deck", 760, 15.7, 42, 0, 0.95],
  ["freight-cradle", 728, null, 174, 2.55, 0.12],
];

export async function expansionShots({ browser, port, out, errors }) {
  // A real pre-port save. The old fronts are held so all four new cores can be tested.
  const profile = { v: 25, seed: 41, cash: 4321, day: 8, stash: [], raids: 0, extracted: 0, region: "reservoir", entry: "beach", entries: ["beach"], poiState: Object.fromEntries(["supply", "quarry", "relay", "station", "waterworks"].map((id) => [id, { state: "freed" }])) };
  const read = (page) => page.evaluate(() => JSON.parse(window.render_game_to_text()));
  const open = async (phone) => {
    const ctx = await browser.newContext({ viewport: phone ? { width: 844, height: 390 } : { width: 1280, height: 720 }, deviceScaleFactor: 1, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
    ctx.setDefaultTimeout(120000);
    // External font availability must not stall a local gameplay check.
    await ctx.route("https://fonts.googleapis.com/**", (r) => r.fulfill({ status: 200, contentType: "text/css", body: "" }));
    await ctx.addInitScript(({ key, profile }) => { if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(profile)); }, { key: KEY, profile });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(`expansion: ${e.message}`));
    page.on("console", (m) => m.type() === "error" && !/fonts\.g|ERR_TUNNEL|net::/.test(m.text()) && errors.push(`expansion: ${m.text()}`));
    await page.goto(`http://localhost:${port}/ringfall/`, { waitUntil: "load" });
    await page.click("#start");
    await page.waitForFunction(() => { const s = JSON.parse(window.render_game_to_text()); return s.screen === "camp" && !s.camp.fading; });
    return { ctx, page };
  };
  const { ctx, page } = await open(false);
  try {
    await page.evaluate(() => { window.ringfallCamp.walkTo("vehicle"); window.ringfallCamp.use(); });
    await page.click("#depart-go");
    await page.waitForFunction(() => JSON.parse(window.render_game_to_text()).screen === "game");
    let s = await read(page);
    assert.equal(s.front.nodes.length, 15);
    // Clear opposition only for this isolated capture check. The sim gate checks the garrisons.
    await page.evaluate(() => window.ringfallMove.quiet());
    for (const id of NEW_NODES) {
      const core = s.front.cores.find((c) => c.id === id);
      assert(core, `${id}: no capturable core`);
      await page.evaluate((c) => { window.ringfallPlace(c.x + 1.4, c.z, -Math.PI / 2); window.ringfallStep(80); }, core);
      await page.keyboard.press("KeyE");
      for (let k = 0; k < 50; k++) await page.evaluate(() => { window.ringfallMove.quiet(); window.ringfallStep(1000); });
      s = await read(page);
      assert(s.stats.captured.includes(id), `${id}: use key did not capture the core`);
      assert.equal(s.front.nodes[s.front.cores.findIndex((c) => c.id === id)], "freed");
      console.log(`expansion core captured: ${id}`);
    }
    for (const [name, ...camera] of EXPANSION_VIEWS) {
      await page.evaluate(([x, y, z, yaw, pitch]) => { window.ringfallPlace(x, z, yaw); window.ringfallStep(80); window.ringfallCamera(x, y ?? window.ringfallTerrain(x, z) + 1.7, z, yaw, pitch); window.ringfallDraw(); }, camera);
      await page.screenshot({ path: `${out}/expansion-${name}.png` });
    }
    await page.evaluate(() => { window.ringfallCamera(); window.ringfallPlace(-730, 170, 0); window.ringfallDraw(); });
    await page.keyboard.press("KeyM");
    await page.evaluate(() => window.advanceTime(16));
    await page.screenshot({ path: `${out}/expansion-map.png` });
    const painted = await page.locator("#map-canvas").evaluate((c) => c.getContext("2d").getImageData(0, 0, c.width, c.height).data.some((v, i) => i % 4 === 3 && v));
    assert(painted, "the territory map was empty");
    await page.keyboard.press("KeyM");
    await page.evaluate(() => window.ringfallEnd("extracted"));
    const saved = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), KEY);
    assert.equal(saved.v, 26);
    assert(NEW_NODES.every((id) => ["held", "freed"].includes(saved.poiState[id]?.state)), "new node ownership was not saved");
    await page.reload({ waitUntil: "load" });
    await page.click("#start");
    await page.waitForFunction(() => JSON.parse(window.render_game_to_text()).screen === "camp");
    // Camp's simulation is scenery; its actual territory comes from the profile in the hub.
    // Depart once more so we check the holders used by the next real raid as well.
    await page.evaluate(() => { window.ringfallCamp.walkTo("vehicle"); window.ringfallCamp.use(); });
    await page.click("#depart-go");
    await page.waitForFunction(() => JSON.parse(window.render_game_to_text()).screen === "game");
    const restored = await read(page);
    for (const id of NEW_NODES) {
      const i = restored.front.cores.findIndex((c) => c.id === id);
      assert.equal(restored.front.nodes[i], saved.poiState[id].state, `${id}: returning/reloading changed its holder`);
    }
    console.log("expansion: ownership persisted through return and reload");
  } finally { await ctx.close(); }
  const mobile = await open(true);
  try {
    const s = await read(mobile.page);
    assert.equal(s.front.nodes.length, 15);
    await mobile.page.evaluate(() => { window.ringfallCamp.open("map"); window.advanceTime(16); });
    await mobile.page.locator("#hub-island-map").waitFor({ state: "visible" });
    await mobile.page.waitForFunction(() => {
      const c = document.getElementById("hub-island-map");
      return c && c.width > 0 && c.getContext("2d").getImageData(0, 0, c.width, c.height).data.some((v, i) => i % 4 === 3 && v);
    });
    await mobile.page.screenshot({ path: `${out}/expansion-mobile-map.png` });
    assert(await mobile.page.locator("#hub").evaluate((e) => e.scrollWidth <= innerWidth + 1), "mobile map panel overflows the viewport");
  } finally { await mobile.ctx.close(); }
  console.log("expansion browser gate passed");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
  const server = createServer(async (req, res) => {
    let path = join("dist/client", decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (path.endsWith("/")) path += "index.html";
    try { const body = await readFile(path); res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" }).end(body); }
    catch { res.writeHead(404).end(); }
  }).listen(0);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const out = "shots/ringfall-expansion", errors = [];
  await mkdir(out, { recursive: true });
  try { await expansionShots({ browser, port: server.address().port, out, errors }); assert.equal(errors.length, 0, errors.join("\n")); }
  finally { await browser.close(); server.close(); }
}
