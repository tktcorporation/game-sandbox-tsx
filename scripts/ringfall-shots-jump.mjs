/**
 * Screenshots of the core's sortie (docs/ringfall/holdings-raid.md, sim/jump.ts): the signal
 * station's holding → the departure naming the node to take first → a raid of the island → the
 * player's core other players hold too → the sheet of those players → the sortie at one's same
 * node → back at the core, the raid going on. Run against the build (`npm run build`):
 *
 *   node scripts/ringfall-shots-jump.mjs
 *
 * Writes to shots/ringfall/jump/ (a phone held sideways too, its files starting with m). Fails on
 * a page error or when a step does not come.
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
const out = "shots/ringfall/jump";
await mkdir(out, { recursive: true });

const errors = [];
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});

for (const phone of [false, true]) {
  const pre = phone ? "m" : "";
  const fail = (m) => errors.push(`${phone ? "phone" : "desktop"}: ${m}`);
  const ctx = await browser.newContext(phone ? { viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true } : { viewport: { width: 1280, height: 720 } });
  const pg = await ctx.newPage();
  pg.on("pageerror", (e) => fail(`pageerror: ${e.message}`));
  pg.on("console", (m) => m.type() === "error" && !/fonts\.g|ERR_TUNNEL|net::|api\//.test(m.text()) && fail(`console: ${m.text()}`));
  const press = (sel) => (phone ? pg.tap(sel) : pg.click(sel));
  const shot = async (name) => {
    await pg.screenshot({ path: `${out}/${pre}${name}.png` });
    console.log("shot", pre + name);
  };

  // The first-day cards are another shot's: seen already here.
  await pg.addInitScript(() => localStorage.setItem("ringfall.mpHowto.v1", "1"));
  await pg.goto(`http://localhost:${port}/ringfall/`, { waitUntil: "load" });
  await pg.waitForTimeout(400);
  await press("#start");
  await pg.waitForTimeout(1500);

  // The signal station: a player's card opens their holdings; one opens the departure on the core that reaches it.
  await pg.evaluate(() => window.ringfallCamp.open("signal"));
  await pg.waitForTimeout(400);
  await pg.locator("#hub [data-act=exp-island]:not([disabled])").first().click();
  await pg.waitForTimeout(300);
  if (!(await pg.locator("#hub .exp-nodes [data-act=revenge]").count())) fail("a player's card shows no holding");
  await shot("01-signal-holding");
  await pg.locator("#hub .exp-nodes [data-act=revenge]").first().click();
  await pg.waitForFunction(() => !document.getElementById("depart")?.hidden, null, { timeout: 6000 }).catch(() => fail("the departure did not open from the holding"));
  await pg.waitForTimeout(400);
  const reach = await pg.evaluate(() => (document.getElementById("depart-reach").hidden ? "" : document.getElementById("depart-reach").innerText));
  if (!/先に.+を取る|の核から攻める/.test(reach)) fail(`the departure names no core to set out from: "${reach}"`);
  if (await pg.locator("#depart-mode, #depart-attack-list").count()) fail("the departure still has its two ways out");
  await shot("02-depart-reach");

  // A raid of the island: with the node held, its core offers the sortie.
  await press("#depart-go");
  await pg.waitForTimeout(2500);
  const nodes = await pg.evaluate(() => {
    window.ringfallMove.quiet();
    window.ringfallMove.hold();
    return window.ringfallJump.nodes();
  });
  if (!nodes.length) {
    fail("no node of the islands next door to set out against");
    continue;
  }
  await pg.evaluate((id) => window.ringfallJump.stand(id), nodes[0]);
  await pg.waitForTimeout(600);
  await shot("03-core-prompt");
  if (phone) await pg.tap("#t-use");
  else await pg.keyboard.press("KeyE");
  await pg.waitForTimeout(500);
  const rows = await pg.locator("#jump:not([hidden]) #jump-list button").count();
  if (rows < 1 || rows > 3) fail(`the sheet offers ${rows} players`);
  await shot("04-sheet");

  // The sortie: at the other player's same node, from its depot; walking off it ends it alive.
  if (phone) await pg.tap("#jump-list button");
  else await pg.keyboard.press("Digit1");
  await pg.waitForTimeout(2000);
  if (!(await pg.evaluate(() => window.ringfallJump.away()))) fail("no sortie was set out on");
  await shot("05-sortie");
  await pg.evaluate(() => window.ringfallJump.walkOff());
  await pg.waitForTimeout(3500);
  const back = JSON.parse(await pg.evaluate(() => window.render_game_to_text()));
  if (await pg.evaluate(() => window.ringfallJump.away())) fail("the sortie did not come back to the core");
  else if (back.phase !== "play") fail(`back at the core the raid is ${back.phase}, not going on`);
  await shot("06-back-at-core");
  await ctx.close();
}

await browser.close();
server.close();
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("jump shots ok");
