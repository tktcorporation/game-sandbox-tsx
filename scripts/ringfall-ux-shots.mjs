/**
 * UX audit screenshots for docs/ringfall/ux-design.md.
 * Serves the build, walks camp → raid, and captures key states into docs/ringfall/img/.
 *
 *   node scripts/ringfall-ux-shots.mjs [--tag before|after]
 */
import { createServer } from "node:http";
import { readFile, mkdir, copyFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { chromium } from "playwright-core";

const tag = process.argv.includes("--tag") ? process.argv[process.argv.indexOf("--tag") + 1] : "shot";
const root = process.env.SHOTS_ROOT ?? ".cloudflare/output/v0/workers/default/assets";
const out = "docs/ringfall/img";
const art = "/opt/cursor/artifacts";
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
await mkdir(out, { recursive: true });
await mkdir(art, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/home/ubuntu/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

const read = () => page.evaluate(() => JSON.parse(window.render_game_to_text()));
const shot = async (name) => {
  await page.evaluate(() => window.ringfallDraw());
  const file = `${tag}-${name}.png`;
  await page.screenshot({ path: `${out}/${file}` });
  await copyFile(`${out}/${file}`, `${art}/${file}`).catch(() => undefined);
  console.log(`shot ${file}`);
};
const quiet = async (ms, n = 1) => {
  for (let i = 0; i < n; i++) {
    await page.evaluate((t) => window.ringfallStep(t), ms);
    if ((i + 1) % 8 === 0) await page.evaluate(() => window.ringfallDraw());
  }
  await page.evaluate(() => window.ringfallDraw());
};
const faded = async () => {
  await page.waitForFunction(() => getComputedStyle(document.getElementById("fade")).opacity === "0", null, { timeout: 8000 }).catch(() => errors.push("fade"));
};

await page.goto(`http://localhost:${port}/ringfall/`, { waitUntil: "load" });
await page.waitForFunction(() => typeof window.render_game_to_text === "function");
await shot("01-title");

await page.click("#start");
await faded();
await quiet(200, 5);
await shot("02-camp");

// Signal station (multiplayer surface).
if (await page.evaluate(() => window.ringfallCamp.walkTo("signal"))) {
  await quiet(100, 2);
  await page.keyboard.press("KeyE");
  await quiet(100, 3);
  await shot("03-signal");
  await page.keyboard.press("Escape");
  await quiet(100, 2);
}

// Stash panel.
if (await page.evaluate(() => window.ringfallCamp.walkTo("stash"))) {
  await quiet(100, 2);
  await page.keyboard.press("KeyE");
  await quiet(100, 3);
  await shot("04-stash");
  await page.keyboard.press("Escape");
  await quiet(100, 2);
}

// Departure map.
await page.evaluate(() => window.ringfallCamp.toGate());
await page.keyboard.down("KeyW");
let st = await read();
for (let i = 0; i < 40 && st.screen !== "game" && !st.camp?.depart; i++) {
  st = JSON.parse(await page.evaluate(() => (window.advanceTime(200), window.render_game_to_text())));
}
await page.keyboard.up("KeyW");
if (st.camp?.depart) {
  await page.waitForFunction(() => !document.getElementById("depart").hidden, null, { timeout: 4000 });
  await shot("05-depart");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => JSON.parse(window.render_game_to_text()).screen === "game", null, { timeout: 8000 }).catch(() => undefined);
  await faded();
}
st = await read();
if (st.screen !== "game") {
  console.error("failed to start raid", st.screen);
  process.exit(1);
}
await quiet(200, 10);
await shot("06-spawn");

// Place at a ground bin with a dropped weapon beside it (clustered interact).
await page.evaluate(() => {
  window.ringfallMove.quiet();
  const st = JSON.parse(window.render_game_to_text());
  // Prefer a supply bin near y≈0; fall back to any closed bin.
  const bins = st.vaults?.length >= 0 ? null : null;
  void bins;
  void st;
});
const clustered = await page.evaluate(() => {
  // Read bins from the live state via place helper: stand on a known supply ground bin.
  // Coordinates from map (supply ground bin around -46, 445).
  window.ringfallPlace(-46, 445, 0);
  // Age a fake weapon next to the player by ending nothing — drop via bag helper if available.
  if (typeof window.ringfallBag === "function") {
    // Ensure something to interact with: open nothing, just stand at bin.
  }
  return window.render_game_to_text();
});
void clustered;
await quiet(100, 4);
await page.evaluate(() => window.ringfallDraw());
await shot("07-explore");
// Focused interact at the bin (prompt + use mark).
await quiet(50, 2);
await shot("07b-interact-focus");

// Use bot for a short stretch to reach combat / loot.
await page.evaluate(() => window.ringfallBot("casual"));
for (let i = 0; i < 200; i++) {
  await page.evaluate(() => window.ringfallStep(250));
  if ((i + 1) % 12 === 0) {
    await page.evaluate(() => window.ringfallDraw());
    st = await read();
    if (i === 24) await shot("08-bot-early");
    if (st.prompt && /補給箱|保管庫|E/.test(document.getElementById("prompt")?.textContent || "")) {
      await shot("09-interact-prompt");
      break;
    }
    if (st.phase === "done") break;
  }
}
st = await read();
const promptText = await page.evaluate(() => document.getElementById("prompt")?.textContent || "");
if (!/補給箱|保管庫/.test(promptText)) {
  // One more pass looking for any prompt.
  for (let i = 0; i < 120 && st.phase === "play"; i++) {
    await page.evaluate(() => window.ringfallStep(250));
    if ((i + 1) % 10 === 0) {
      await page.evaluate(() => window.ringfallDraw());
      const p = await page.evaluate(() => document.getElementById("prompt")?.textContent || "");
      if (p) {
        await shot("09-interact-prompt");
        break;
      }
      st = await read();
    }
  }
}

await page.keyboard.down("Tab");
await quiet(50, 2);
await shot("10-bag");
await page.keyboard.up("Tab");
await quiet(50, 2);

await page.keyboard.press("KeyM");
await quiet(100, 3);
await shot("11-map");
await page.keyboard.press("KeyM");
await quiet(100, 2);

// Continue bot until fight or end.
for (let i = 0; i < 400 && (await read()).phase === "play"; i++) {
  await page.evaluate(() => window.ringfallStep(300));
  if ((i + 1) % 15 === 0) {
    await page.evaluate(() => window.ringfallDraw());
    const aware = await page.evaluate(() => document.querySelectorAll("#aware-layer .aw.engaged, #aware-layer .aw.alert").length);
    if (aware > 0) {
      await shot("12-combat");
      break;
    }
  }
}
if (!(await read()).phase || (await read()).phase === "play") {
  // Force a combat-ish frame if we got engagement marks earlier; otherwise still capture HUD mid-raid.
  await page.evaluate(() => window.ringfallDraw());
  await shot("12-combat");
}

// Let bot finish or wipe for results.
for (let i = 0; i < 800 && (await read()).phase === "play"; i++) {
  await page.evaluate(() => window.ringfallStep(400));
  if ((i + 1) % 20 === 0) await page.evaluate(() => window.ringfallDraw());
}
await page.evaluate(() => window.ringfallDraw());
st = await read();
if (st.phase === "done" || !document.getElementById("results")?.hidden) {
  // Wait for results UI.
  await page.waitForTimeout(500);
  await page.evaluate(() => window.ringfallDraw());
  await shot("13-results");
} else {
  await shot("13-midraid-end");
}

await browser.close();
server.close();
if (errors.length) {
  console.error("errors:", errors.slice(0, 8));
  process.exit(1);
}
console.log(`ux shots done (${tag})`);
