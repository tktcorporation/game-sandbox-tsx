/**
 * Browser smoke: Vite /ringfall/ — default tick must stay OFF until equiv+speed are accepted.
 * Optional: RINGFALL_URL='…/ringfall/?ringfallTick=1' to exercise WASM.
 *
 *   npx vite --host 127.0.0.1 --port 5173
 *   node scripts/ringfall-tick-browser-smoke.mjs
 */
import { chromium } from "playwright-core";

const chrome = process.env.CHROME || "/home/ubuntu/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome";
const url = process.env.RINGFALL_URL || "http://127.0.0.1:5173/ringfall/";
const wantWasm = /ringfallTick=1|ringfallTick=wasm|ringfallTick=on|ringfallTick=true/.test(url);

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
const native = await page.evaluate(() => window.ringfallNative());
console.log(JSON.stringify({ wantWasm, native, errors: errors.slice(0, 8) }, null, 2));
await browser.close();

if (errors.length) {
  console.error("browser-tick-smoke: page errors");
  process.exit(2);
}
if (!native?.tick) {
  console.error("browser-tick-smoke: missing tick status");
  process.exit(3);
}
if (wantWasm) {
  if (native.tick.mode !== "wasm" || (native.tick.abi ?? 0) < 4) {
    console.error("browser-tick-smoke: expected wasm tick", native.tick);
    process.exit(4);
  }
} else if (native.tick.mode !== "off") {
  console.error("browser-tick-smoke: expected default mode=off", native.tick);
  process.exit(4);
}
console.log("browser-tick-smoke: ok mode=" + native.tick.mode + " abi=" + native.tick.abi);
