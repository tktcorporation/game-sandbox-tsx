/**
 * Multiplayer how-to shots (TKT-204): depart map with sea neighbours / contested rival hold,
 * and camp tip wording. Writes before|after under shots/ringfall/mp-howto/ and docs/ringfall/img/mp-howto/.
 *
 *   node scripts/ringfall-shots-mp-howto.mjs BEFORE
 *   node scripts/ringfall-shots-mp-howto.mjs AFTER
 */
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { readFile, mkdir, copyFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { chromium } from "playwright-core";

const KEY = "ringfall.profile.v1";
const tag = (process.argv[2] ?? "BEFORE").toUpperCase() === "AFTER" ? "after" : "before";

/** Contested shores open (station held) + rival hold on 浄水場 so tip / map show 攻める. */
const OWN = ["supply", "quarry", "relay", "station", "lodge", "yard", "smelter", "cannery", "coldstore"];
const SAVE = {
  v: 42,
  cash: 5000,
  raids: 14,
  extracted: 10,
  time: 14000,
  region: "reservoir",
  entry: "beach",
  seed: 4242,
  day: 14,
  factory: 3,
  cycle: 0,
  cycleDay: 14,
  liberations: [],
  stash: [
    { t: "weapon", kind: "pike", rarity: 0, starter: true },
    { t: "weapon", kind: "talon", rarity: 0, starter: true },
  ],
  entries: ["beach", "checkpoint", "jetty", "outskirts", "quay"],
  depots: OWN,
  seen: "",
  poiState: {
    ...Object.fromEntries(OWN.map((id) => [id, { state: "own" }])),
    // 浄水場 held by real neighbour ツバキ (slot 1 faces waterworks)
    waterworks: { state: "rival:TTHKQB" },
  },
  incoming: [],
  expeditions: [],
  logSeq: 0,
  retaken: [],
  trophies: 1000,
  known: [],
  routes: [],
  depotSent: {},
  lastKit: null,
  news: [],
  pending: [],
  goal: null,
  freedAt: {},
  threat: 0,
  parcels: [],
  hideout: { infirmary: 1, workbench: 1, radio: 1, pouch: 1, storage: 1 },
};

// Crockford base32 island codes only (no I/L/O/U).
// Real ツバキ vs AI カゲウツ · AI (TKT-204 案 G — names no longer collide).
const NEAR = [
  { code: "TTHKQB", name: "ツバキ", held: 7, total: 22, day: 18, slot: 1, trophies: 1060, factory: 3, last: { at: Date.now() - 2 * 3600_000, captured: 1, home: true } },
  { code: "AK7M2X", name: "カゲウツ", held: 9, total: 21, day: 20, slot: 0, trophies: 1151, factory: 2, ai: true },
  { code: "MNT04X", name: "みなと", held: 4, total: 22, day: 11, slot: 2, trophies: 980 },
  { code: "ASB811", name: "アラシヤマ", held: 9, total: 21, day: 19, slot: 3, trophies: 1155, factory: 2, ai: true },
];

const root = process.env.SHOTS_ROOT ?? ".cloudflare/output/v0/workers/default/assets";
const outRoot = `shots/ringfall/mp-howto/${tag}`;
const docRoot = `docs/ringfall/img/mp-howto`;
const artRoot = `/opt/cursor/artifacts/mp-howto/${tag}`;
await mkdir(outRoot, { recursive: true });
await mkdir(docRoot, { recursive: true });
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

const chrome =
  process.env.CHROMIUM_PATH ??
  ["/opt/pw-browsers/chromium", "/usr/local/bin/google-chrome", "/usr/bin/google-chrome"].find((p) => existsSync(p)) ??
  "/usr/local/bin/google-chrome";

const browser = await chromium.launch({
  executablePath: chrome,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});

const snap = async (pg, name) => {
  const file = `${name}.png`;
  const dest = `${outRoot}/${file}`;
  await pg.screenshot({ path: dest });
  await pg.screenshot({ path: `${artRoot}/${file}` }).catch(() => undefined);
  await copyFile(dest, `${docRoot}/${tag}-${file}`);
  console.log("shot", `${tag}-${file}`);
};

const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const pg = await ctx.newPage();
pg.on("pageerror", (e) => console.error("pageerror", e.message));
await pg.addInitScript(([k, v]) => localStorage.setItem(k, v), [KEY, JSON.stringify(SAVE)]);
await pg.addInitScript((v) => localStorage.setItem("ringfall.neighbours.v1", v), JSON.stringify({ neighbours: NEAR }));
await pg.goto(`http://localhost:${port}/ringfall/`, { waitUntil: "load" });
await pg.waitForTimeout(300);
await pg.click("#start", { force: true });
await pg.waitForFunction(() => getComputedStyle(document.getElementById("fade")).opacity === "0", null, { timeout: 8000 }).catch(() => {});
await pg.evaluate(() => window.advanceTime(500));

// Camp with tip / 今日の作戦
await snap(pg, "01-camp");

// Departure map (sea lines + corner neighbours, or after: hub flags)
if (!(await pg.evaluate(() => window.ringfallCamp.openDepart()))) {
  console.error("openDepart failed");
}
await pg.waitForFunction(() => !document.getElementById("depart")?.hidden, null, { timeout: 6000 }).catch(() => {});
await pg.waitForTimeout(300);
await snap(pg, "02-depart");

// Signal station neighbours
await pg.keyboard.press("Escape");
await pg.waitForTimeout(200);
await pg.evaluate(() => window.ringfallCamp.walkTo("signal"));
await pg.evaluate(() => window.advanceTime(100));
await pg.keyboard.press("KeyE");
await pg.evaluate(() => window.advanceTime(50));
await pg.waitForTimeout(300);
await snap(pg, "03-signal");

await browser.close();
server.close();
console.log(`mp-howto ${tag} shots written to ${outRoot} and ${docRoot}`);
