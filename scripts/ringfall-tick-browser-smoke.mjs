/**
 * Browser smoke: Vite /ringfall/ with default tick (ABI 3).
 *   npx vite --host 127.0.0.1 --port 5173   # already running
 *   node scripts/ringfall-tick-browser-smoke.mjs
 */
import { chromium } from "playwright-core";

const chrome = process.env.CHROME || "/home/ubuntu/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome";
const url = process.env.RINGFALL_URL || "http://127.0.0.1:5173/ringfall/";

const browser = await chromium.launch({ executablePath: chrome, headless: true });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push("console:" + m.text());
});

await page.goto(url, { waitUntil: "networkidle", timeout: 120000 });
await page.waitForFunction(() => typeof window.ringfallNative === "function", null, { timeout: 120000 });
await page.waitForTimeout(1500);
const before = await page.evaluate(() => window.ringfallNative());
// Title → camp → gate → short raid so geom uploads under default browser tick.
await page.evaluate(() => {
  const w = window;
  const start = document.getElementById("start");
  if (start) start.click();
});
await page.waitForTimeout(800);
await page.evaluate(() => {
  if (window.ringfallCamp?.toGate) window.ringfallCamp.toGate();
});
await page.waitForTimeout(200);
await page.evaluate(() => {
  // Open depart and confirm if helpers exist; else click depart-go.
  const go = document.getElementById("depart-go");
  const use = window.ringfallCamp?.use;
  if (use) use();
  if (go) go.click();
});
await page.waitForTimeout(1500);
await page.evaluate(() => {
  if (window.ringfallBot) window.ringfallBot("casual");
  if (window.advanceTime) window.advanceTime(4000);
});
await page.waitForTimeout(500);
const after = await page.evaluate(() => window.ringfallNative());
const text = await page.evaluate(() => (typeof window.render_game_to_text === "function" ? String(window.render_game_to_text()).slice(0, 240) : null));

console.log(JSON.stringify({ before, after, errors: errors.slice(0, 12), text }, null, 2));
await browser.close();

if (errors.length) {
  console.error("browser-tick-smoke: page errors");
  process.exit(2);
}
if (!after?.tick?.tick || (after.tick.abi ?? 0) < 3) {
  console.error("browser-tick-smoke: tick host not ready", after?.tick);
  process.exit(3);
}
if (after.tick.mode !== "wasm") {
  console.error("browser-tick-smoke: expected default wasm tick in browser", after.tick);
  process.exit(4);
}
console.log("browser-tick-smoke: ok mode=wasm abi=" + after.tick.abi + " geom=" + after.tick.geom);
