/**
 * The RINGFALL sound check, headless: serves the build (`npm run build`), opens the page with
 * `?sfx` in Chromium, renders every cue offline through the game's own mixer
 * (window.ringfallSfxCheck) and fails if a cue is silent, has NaN samples or
 * clips, if the voice cap does not hold under a burst, or on any console error.
 * Also saves screenshots of the sound check panel and the pause screen's sliders.
 *
 *   npm run build && npm run sfx:ringfall
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
const out = "shots/ringfall";
await mkdir(out, { recursive: true });

/** A cue whose loudest 20 ms stays under this RMS (about -50 dBFS) counts as silent. */
const SILENT = 0.003;
/** Voices the mixer may hold at once on a desktop (Mixer.maxVoices). */
const MAX_VOICES = 28;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"],
});
const errors = [];
const db = (x) => (x > 0 ? (20 * Math.log10(x)).toFixed(1) : "-inf");
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => m.type() === "error" && !/fonts\.g|ERR_TUNNEL|net::/.test(m.text()) && errors.push(`console: ${m.text()}`));
await page.goto(`http://localhost:${port}/ringfall/?sfx`, { waitUntil: "load" });
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/00-title-sfx.png` });

const panel = await page.evaluate(() => ({ shown: !!document.getElementById("sfx-panel"), buttons: document.querySelectorAll("#sfx-panel [data-cue]").length }));
if (!panel.shown) errors.push("the sound check panel did not appear with ?sfx");

// Clicking a few live buttons (a real AudioContext) must not throw.
for (const id of ["shot-talon", "demo-circle-fire", "hit-crit"]) await page.click(`[data-cue="${id}"]`);
await page.waitForTimeout(400);

/**
 * Each cue's tier and the loudness its tier keeps to (docs/ringfall/sound.md): the loudest 400 ms,
 * K-weighted, in LUFS. A cue whose id matches no tier fails, so a new cue is given one.
 */
const TIERS = [
  { name: "big", lufs: [-24, -12], ids: /^(kill|kill-crit|shield-break-\d|my-shield-break|leap|landing-.*|touchdown-.*|care-land|stomp|telegraph-big|victory|extracted|lost|arrive.*|spawn|core-taken)$/ },
  { name: "shot", lufs: [-30, -12], ids: /^shot-/ },
  { name: "hit", lufs: [-36, -26], ids: /^(hit.*|plate-break-\d)$/ },
  { name: "hand", lufs: [-46, -32], ids: /^(reload-.*|reloaded-.*|dry-.*|bag-peek|search|bin|locked|zip-on|zip-off|zip-cut|shard)$/ },
  { name: "body", lufs: [-42, -26], ids: /^(jump|land|land-hop|slide|slide-jump|mantle|climb|climb-top|hurt|hurt-shield|leap-land|heal-(cell|battery|syringe|medkit))$/ },
  { name: "signal", lufs: [-42, -20], ids: /^(heal-done|suspect|engage|reinforce|raiders|banner|ult-ready|tactical|tactical-miss|threat|alarm|down|revive|ally-down|ally-up|pickup-\d|depot-on|deposit|gate|depot-out)$/ },
  { name: "robot", lufs: [-44, -20], ids: /^(enemy-fire-.*|far-fire|telegraph|lunge|step-.*|swarm|collapse.*|stagger.*|ally-shot|wreck|care-drop)$/ },
  { name: "camp", lufs: [-46, -22], ids: /^(tab|click|buy|sell|deliver|deploy)$/ },
  { name: "air", lufs: [-48, -34], ids: /^(creak|machinery|gull)$/ },
  { name: "music", lufs: [-40, -22], ids: /^music-/ },
  { name: "demo", lufs: null, ids: /^demo-/ },
];
/** Which cue keeps under which, by how many LU: what is heard first stays loudest. */
const UNDER = [
  ...["pike", "hornet", "maul", "lance", "talon"].flatMap((k) => [[`reload-${k}`, `shot-${k}`, 4], [`reloaded-${k}`, `shot-${k}`, 4]]),
  ["hit", "kill", 10],
  ["hit-crit", "kill-crit", 6],
  ["hit", "hit-crit", 3],
  ["climb", "shot-pike", 3],
  ["click", "buy", 3],
  ["step-grunt", "enemy-fire-grunt", 6],
  // The music sits under the guns, and out on the island under the robots too.
  ["music-fight", "shot-pike", 3],
  ["music-explore", "enemy-fire-grunt", 3],
  ["music-explore", "music-fight", 3],
  ...["harbor", "city", "launch"].flatMap((r) => [[`music-${r}-fight`, "shot-pike", 3], [`music-${r}-explore`, "enemy-fire-grunt", 3], [`music-${r}-explore`, `music-${r}-fight`, 3]]),
];
const tierOf = (id) => TIERS.find((t) => t.ids.test(id));
const report = await page.evaluate(() => window.ringfallSfxCheck());
const bad = [];
for (const c of report.cues) {
  const why = [];
  if (c.nan > 0) why.push(`${c.nan} NaN samples`);
  if (c.loud < SILENT) why.push(`silent (loudest 20 ms ${db(c.loud)} dBFS)`);
  if (c.peak > 1) why.push(`peak ${c.peak.toFixed(3)} > 1`);
  if (c.clipped > 0) why.push(`${c.clipped} samples at full scale`);
  const tier = tierOf(c.id);
  if (!tier) why.push("no tier (TIERS)");
  else if (tier.lufs && (c.lufs < tier.lufs[0] || c.lufs > tier.lufs[1])) why.push(`${c.lufs.toFixed(1)} LUFS outside ${tier.name} ${tier.lufs[0]}..${tier.lufs[1]}`);
  if (why.length) bad.push(`${c.id}: ${why.join(", ")}`);
}
const lufsOf = Object.fromEntries(report.cues.map((c) => [c.id, c.lufs]));
for (const [a, b, gap] of UNDER) if (!(lufsOf[a] <= lufsOf[b] - gap)) bad.push(`${a} (${lufsOf[a]?.toFixed(1)}) is not ${gap} LU under ${b} (${lufsOf[b]?.toFixed(1)})`);
if (!(report.mutedPeak < 1e-4)) errors.push(`the music with its slider at zero still peaks at ${db(report.mutedPeak)} dBFS`);
if (report.burstVoices > MAX_VOICES) errors.push(`80 shots at once left ${report.burstVoices} voices playing (cap ${MAX_VOICES})`);

console.log("cue                       tier    peak dBFS   LUFS   len s");
for (const c of report.cues) console.log(`${c.id.padEnd(24)} ${(tierOf(c.id)?.name ?? "-").padEnd(7)} ${db(c.peak).padStart(9)}  ${c.lufs.toFixed(1).padStart(6)}  ${c.len.toFixed(2).padStart(6)}`);
console.log(`\n${report.cues.length} cues, ${panel.buttons} buttons; voices after a burst of 80 shots: ${report.burstVoices}`);

// The pause screen's sliders, shown without starting a raid.
await page.goto(`http://localhost:${port}/ringfall/`, { waitUntil: "load" });
await page.evaluate(() => {
  document.getElementById("title").hidden = true;
  document.getElementById("pause").hidden = false;
});
await page.waitForTimeout(200);
await page.screenshot({ path: `${out}/00-pause.png` });
// The volume slider is saved and read back.
await page.fill("#vol2", "0.35");
await page.dispatchEvent("#vol2", "input");
await page.reload({ waitUntil: "load" });
const vol = await page.evaluate(() => document.getElementById("vol").value);
if (vol !== "0.35") errors.push(`the volume did not survive a reload (got ${vol})`);

await browser.close();
server.close();

for (const b of bad) console.log(`FAIL ${b}`);
for (const e of errors) console.log(`FAIL ${e}`);
if (bad.length || errors.length) process.exit(1);
console.log("sound check passed: no silent, NaN or clipping cue, every cue in its tier (docs/ringfall/sound.md), voice cap holds, no console errors");
