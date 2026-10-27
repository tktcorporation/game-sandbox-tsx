/**
 * Looks at one place of the RINGFALL world in about a minute and a half (the shots gate takes
 * nine), for changing a place and seeing the change: the tour's cameras near it and four views
 * from above round it, drawn by the built game; a top-down crop of it; and how the whole world's
 * ground and boxes moved since the baseline, so a change that reaches past the place is caught too.
 *
 *   npx tsx scripts/ringfall-look.ts <place> [--r 120] [--base] [--no-build]
 *
 * `place` is a frame of `FRAMES` in map.ts (a POI's id, a hamlet's name, "area:" and an area's id)
 * or "x,z" in world metres; `--r` is how far round it counts as the place. The first look at a
 * place, or one with `--base`, saves its pictures as the baseline; later looks compare against it
 * and write `compare-*.png` (baseline left, now right, changed pixels red under them) for a camera
 * with more than 0.3% of its pixels changed; cables and smoke move up to about 0.1% between two
 * looks at the same world. The world's heights have one baseline for all places, saved with it.
 * Out: shots/ringfall/look/<place>/. Builds dist/client first unless `--no-build`.
 */
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { chromium } from "playwright-core";
import { WORLD } from "../src/ringfall/sim/config";
import { BOXES, FRAMES } from "../src/ringfall/sim/map";
import { terrainHeight } from "../src/ringfall/sim/terrain";
import { HARBOR_TOUR, TOUR, place } from "./ringfall-tour.mjs";

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--r");
const R = Number(args[args.indexOf("--r") + 1]) || 120;
const rebase = args.includes("--base");
if (!target) {
  console.error(`usage: npx tsx scripts/ringfall-look.ts <place> [--r 120] [--base] [--no-build]\nplaces: ${Object.keys(FRAMES).join(", ")}, or x,z`);
  process.exit(2);
}
const xz = target.match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
const centre = xz ? { x: +xz[1], z: +xz[2] } : FRAMES[target];
if (!centre) {
  console.error(`no place "${target}"; places: ${Object.keys(FRAMES).join(", ")}, or x,z`);
  process.exit(2);
}
const slug = target.replace(/[^\p{L}\p{N}]+/gu, "-");
const LOOK = "shots/ringfall/look";
const out = `${LOOK}/${slug}`;
const baseDir = `${out}/base`;
mkdirSync(baseDir, { recursive: true });
for (const f of readdirSync(out)) if (f.endsWith(".png")) rmSync(join(out, f));
const t0 = Date.now();
const secs = () => `${((Date.now() - t0) / 1000).toFixed(1)} s`;

if (!args.includes("--no-build")) {
  const b = spawnSync("npx", ["vite", "build", "--logLevel", "error"], { stdio: "inherit" });
  if (b.status !== 0) process.exit(b.status ?? 1);
  console.log(`built (${secs()})`);
}

// --- the world's heights: the ground and the top of what stands on it, on a 4 m grid.
const CELL = 4;
const GW = Math.ceil((WORLD.x1 - WORLD.x0) / CELL);
const GH = Math.ceil((WORLD.z1 - WORLD.z0) / CELL);
const heights = new Float32Array(GW * GH);
for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) heights[j * GW + i] = terrainHeight(WORLD.x0 + (i + 0.5) * CELL, WORLD.z0 + (j + 0.5) * CELL);
for (const b of BOXES) {
  const i0 = Math.max(0, Math.ceil((b.x0 - WORLD.x0) / CELL - 0.5));
  const i1 = Math.min(GW - 1, Math.floor((b.x1 - WORLD.x0) / CELL - 0.5));
  const j0 = Math.max(0, Math.ceil((b.z0 - WORLD.z0) / CELL - 0.5));
  const j1 = Math.min(GH - 1, Math.floor((b.z1 - WORLD.z0) / CELL - 0.5));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (b.h > heights[j * GW + i]) heights[j * GW + i] = b.h;
}
const worldBase = `${LOOK}/world.base.bin`;
const worldLines: string[] = [];
const tooFar = (x: number, z: number) => Math.hypot(x - centre.x, z - centre.z) > R;
if (!rebase && existsSync(worldBase)) {
  const before = new Float32Array(readFileSync(worldBase).buffer.slice(0));
  // Changed cells gathered into 50 m tiles, each named by the frame nearest it.
  const TILE = 50;
  const tiles = new Map<string, { n: number; max: number; x: number; z: number }>();
  for (let j = 0; j < GH; j++)
    for (let i = 0; i < GW; i++) {
      const d = Math.abs(heights[j * GW + i] - before[j * GW + i]);
      if (!(d > 0.05)) continue;
      const x = WORLD.x0 + (i + 0.5) * CELL;
      const z = WORLD.z0 + (j + 0.5) * CELL;
      const k = `${Math.floor(x / TILE)},${Math.floor(z / TILE)}`;
      const t = tiles.get(k) ?? { n: 0, max: 0, x: (Math.floor(x / TILE) + 0.5) * TILE, z: (Math.floor(z / TILE) + 0.5) * TILE };
      t.n++;
      t.max = Math.max(t.max, d);
      tiles.set(k, t);
    }
  const near = (x: number, z: number) => {
    let best = "";
    let bd = Infinity;
    for (const [name, f] of Object.entries(FRAMES)) {
      const d = Math.hypot(f.x - x, f.z - z);
      if (d < bd) [best, bd] = [name, d];
    }
    return `${best} ${Math.round(bd)} m`;
  };
  const list = [...tiles.values()].sort((a, b) => b.n - a.n);
  const outside = list.filter((t) => tooFar(t.x, t.z));
  worldLines.push(`world since the baseline: ${list.reduce((s, t) => s + t.n, 0)} cells of ${CELL} m changed height in ${list.length} tiles of 50 m, ${outside.length} of them beyond ${R} m of ${target}`);
  for (const t of outside.slice(0, 12)) worldLines.push(`  OUTSIDE (${t.x}, ${t.z}) near ${near(t.x, t.z)}: ${t.n} cells, up to ${t.max.toFixed(1)} m`);
  if (outside.length > 12) worldLines.push(`  ... and ${outside.length - 12} more tiles outside`);
} else {
  writeFileSync(worldBase, Buffer.from(heights.buffer));
  worldLines.push("world: baseline saved");
}

// --- a top-down crop of the place.
const top = spawnSync("npx", ["tsx", "scripts/ringfall-topdown.ts", `${out}/topdown.png`, String(centre.x), String(centre.z), String(R * 2)], { stdio: "inherit" });
if (top.status !== 0) process.exit(top.status ?? 1);
console.log(`top-down drawn (${secs()})`);

// --- the cameras: the tour's within the place, and four from above round it.
const frames = FRAMES as Record<string, { x: number; z: number }>;
const cams: [string, number, number, number, number, number, boolean][] = [...TOUR, ...HARBOR_TOUR]
  .map((c) => place(frames, c) as [string, number, number, number, number, number, boolean])
  .filter(([, x, , z]) => !tooFar(x, z));
const D = Math.max(80, R * 0.9);
const g0 = terrainHeight(centre.x, centre.z);
for (const [i, a] of [Math.PI / 4, (3 * Math.PI) / 4, (-3 * Math.PI) / 4, -Math.PI / 4].entries()) {
  const x = centre.x + Math.sin(a) * D;
  const z = centre.z - Math.cos(a) * D;
  const y = Math.max(terrainHeight(x, z), g0) + D * 0.55;
  cams.push([`above-${["ne", "se", "sw", "nw"][i]}`, x, y, z, Math.atan2(centre.x - x, -(centre.z - z)), Math.atan2(g0 - y, D), true]);
}

const root = "dist/client";
const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
const server = createServer((req, res) => {
  let path = join(root, decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname));
  if (path.endsWith("/")) path += "index.html";
  if (!existsSync(path)) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" }).end(readFileSync(path));
}).listen(0);
const port = (server.address() as { port: number }).port;
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const errors: string[] = [];
const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => m.type() === "error" && !/fonts\.g|ERR_TUNNEL|net::/.test(m.text()) && errors.push(`console: ${m.text()}`));
// tsx keeps functions' names with an `__name` helper the page does not have; the functions handed to the page need one.
await page.addInitScript("window.__name = (f) => f");
await page.goto(`http://localhost:${port}/ringfall/`, { waitUntil: "load" });
await page.click("#start");
await page.waitForFunction(() => getComputedStyle(document.getElementById("fade")!).opacity === "0", null, { timeout: 15000 });
// The camp's world, emptied of robots, seen through the game's own canvas with nothing over it.
await page.evaluate(() => {
  const view = [...document.querySelectorAll("canvas")].sort((a, b) => b.width * b.height - a.width * a.height)[0];
  view.id = "look-view";
  // The HUD and the camp's labels are DOM laid over the canvas: hide all but the canvas and what holds it.
  for (const el of document.body.querySelectorAll<HTMLElement>("*")) if (el !== view && !el.contains(view)) el.style.visibility = "hidden";
});
console.log(`page up (${secs()})`);
const view = page.locator("#look-view");

const lines: string[] = [];
for (const [name, x, dy, z, yaw, pitch, abs] of cams) {
  const y = abs ? dy : terrainHeight(x, z) + dy;
  await page.evaluate(([x, y, z, yaw, pitch]) => window.ringfallCamera(x, y, z, yaw, pitch), [x, y, z, yaw, pitch]);
  // Chunks inside the fog are built at once; two more frames let the shadows and the trim settle.
  await page.evaluate(() => (window.ringfallDraw(), window.ringfallDraw()));
  const shot = await view.screenshot({ path: `${out}/${name}.png` });
  console.log(`  ${name} (${secs()})`);
  const basePath = `${baseDir}/${name}.png`;
  if (rebase || !existsSync(basePath)) {
    copyFileSync(`${out}/${name}.png`, basePath);
    lines.push(`${name}: baseline saved`);
    continue;
  }
  const cmp = await page.evaluate(
    async ([a, b]) => {
      const load = (src: string) => new Promise<HTMLImageElement>((ok) => {
        const im = new Image();
        im.onload = () => ok(im);
        im.src = src;
      });
      const [ia, ib] = await Promise.all([load(a), load(b)]);
      const w = ia.width;
      const h = ia.height;
      const c = document.createElement("canvas");
      c.width = w * 2;
      c.height = h * 2;
      const g = c.getContext("2d")!;
      g.drawImage(ia, 0, 0);
      g.drawImage(ib, w, 0);
      const pa = g.getImageData(0, 0, w, h).data;
      const pb = g.getImageData(w, 0, w, h).data;
      const diff = g.createImageData(w, h);
      let changed = 0;
      for (let p = 0; p < pa.length; p += 4) {
        const d = Math.abs(pa[p] - pb[p]) + Math.abs(pa[p + 1] - pb[p + 1]) + Math.abs(pa[p + 2] - pb[p + 2]);
        const grey = (pb[p] + pb[p + 1] + pb[p + 2]) / 9;
        const on = d > 24;
        if (on) changed++;
        diff.data.set(on ? [230, 40, 40, 255] : [grey, grey, grey, 255], p);
      }
      g.putImageData(diff, w / 2, h);
      return { url: c.toDataURL("image/png"), share: changed / (w * h) };
    },
    [`data:image/png;base64,${readFileSync(basePath).toString("base64")}`, `data:image/png;base64,${shot.toString("base64")}`],
  );
  writeFileSync(`${out}/compare-${name}.png`, Buffer.from(cmp.url.split(",")[1], "base64"));
  lines.push(`${name}: ${(cmp.share * 100).toFixed(1)}% of pixels changed${cmp.share > 0.003 ? ` -> compare-${name}.png` : ""}`);
}
await browser.close();
server.close();

console.log(`\n${target} (${Math.round(centre.x)}, ${Math.round(centre.z)}), r ${R} m: ${cams.length} cameras, ${secs()}`);
for (const l of lines) console.log(`  ${l}`);
for (const l of worldLines) console.log(l);
console.log(`pictures: ${out}/ (topdown.png, <camera>.png, compare-<camera>.png)`);
if (errors.length) {
  console.error(`\nthe page reported errors:\n${errors.map((e) => `  ${e}`).join("\n")}`);
  process.exit(1);
}
