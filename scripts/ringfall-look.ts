/**
 * Looks at one place of the RINGFALL world in about a minute and a half (the shots gate takes
 * nine), for changing a place and seeing the change: the tour's cameras near it and four views
 * from above round it, drawn by the built game; a top-down crop of it; and how the whole world's
 * ground and boxes changed since the baseline, so a change that reaches past the place is caught too.
 *
 *   npx tsx scripts/ringfall-look.ts <place> [--r 120] [--base] [--no-build]
 *
 * `place` is a frame of `FRAMES` in map.ts (a POI's id, a hamlet's name, "area:" and an area's id)
 * or "x,z" in world metres; `--r` is how far round it counts as the place. The first look at a
 * place, or one with `--base`, saves its pictures as the baseline; later looks compare against it
 * and write `compare-*.png` (baseline left, now right, changed pixels red under them) for a camera
 * with more than 0.3% of its pixels changed; cables and smoke move up to about 0.1% between two
 * looks at the same world. The place's baseline also keeps the whole world's grid (heights and
 * what stands in each 4 m cell), compared at every later look of that place.
 * Out: shots/ringfall/look/<place>/. Builds dist/client first; `--no-build` uses the last build
 * and stops if it is older than src/ringfall.
 */
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { chromium } from "playwright-core";
import { WORLD } from "../src/ringfall/sim/config";
import { BOXES, FRAMES, ROUTES, type Box } from "../src/ringfall/sim/map";
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
// One directory per place, no two places sharing one: frame names hold only letters, digits and
// ":" (never "_"), and a point keeps its signs and decimals.
const slug = xz ? `xz_${+xz[1]}_${+xz[2]}` : target.replaceAll(":", "_");
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
} else {
  // The heights below come from the source as it is; the pictures from the last build. A build
  // older than the source would compare an old world's pictures with a new world's heights.
  const newest = (dir: string): number =>
    readdirSync(dir, { withFileTypes: true }).reduce((m, e) => Math.max(m, e.isDirectory() ? newest(join(dir, e.name)) : statSync(join(dir, e.name)).mtimeMs), 0);
  const built = "dist/client/ringfall/index.html";
  if (!existsSync(built) || statSync(built).mtimeMs < Math.max(newest("src/ringfall"), statSync("ringfall/index.html").mtimeMs)) {
    console.error("--no-build: dist/client is older than src/ringfall; build first, or leave out --no-build");
    process.exit(2);
  }
}

// --- the world on a 4 m grid: per cell, the ground at its centre and the top of whatever stands on
// any part of it, and a fingerprint of those boxes, so a box moved, resized or removed changes its
// cells even when no top changes height. The routes' obstacles count too, closed and open, which
// the collision grid swaps in apart from BOXES.
const CELL = 4;
const GW = Math.ceil((WORLD.x1 - WORLD.x0) / CELL);
const GH = Math.ceil((WORLD.z1 - WORLD.z0) / CELL);
const heights = new Float32Array(GW * GH);
const prints = new Uint32Array(GW * GH);
for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) heights[j * GW + i] = terrainHeight(WORLD.x0 + (i + 0.5) * CELL, WORLD.z0 + (j + 0.5) * CELL);
// The view draws a prop's wrapping and a rock's chips from the box's number in the order it builds
// them (`buildStatic(b, n)`: BOXES, then the routes' boxes), so for those two kinds the number is
// part of what is seen, and a box added before them changes them all.
const DRAWN_BY_NUMBER = new Set(["prop", "rock"]);
const boxPrint = (b: Box, n: number) => {
  let h = 2166136261;
  for (const v of [b.x0, b.z0, b.x1, b.z1, b.y0, b.h, b.tint, DRAWN_BY_NUMBER.has(b.kind) ? n : -1]) h = Math.imul(h ^ Math.round(v * 100), 16777619);
  for (const c of b.kind) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
};
const lay = (b: Box, n: number, tall: boolean) => {
  const i0 = Math.max(0, Math.floor((b.x0 - WORLD.x0) / CELL));
  const i1 = Math.min(GW - 1, Math.floor((b.x1 - WORLD.x0 - 1e-6) / CELL));
  const j0 = Math.max(0, Math.floor((b.z0 - WORLD.z0) / CELL));
  const j1 = Math.min(GH - 1, Math.floor((b.z1 - WORLD.z0 - 1e-6) / CELL));
  const f = boxPrint(b, n);
  for (let j = j0; j <= j1; j++)
    for (let i = i0; i <= i1; i++) {
      // XOR, so the print does not depend on the order the boxes are listed in.
      prints[j * GW + i] ^= f;
      if (tall && b.h > heights[j * GW + i]) heights[j * GW + i] = b.h;
    }
};
BOXES.forEach((b, n) => lay(b, n, true));
// Numbered as the view numbers them: closed in the world the look shows (no route opened), open as when all are.
ROUTES.flatMap((r) => r.closed).forEach((b, n) => lay(b, BOXES.length + n, true));
ROUTES.flatMap((r) => r.open).forEach((b, n) => lay(b, BOXES.length + n, false));
// The world's baseline is kept with the place's, so a baseline taken at another place never
// stands in for this one's; it records its grid, so a grid of another size is never compared.
const worldBin = `${baseDir}/world.bin`;
const worldMeta = `${baseDir}/world.json`;
// `print` is the fingerprint's version: raise it when boxPrint() or lay() change what they hash, so
// a baseline hashed the old way is never compared.
const meta = { gw: GW, gh: GH, cell: CELL, x0: WORLD.x0, z0: WORLD.z0, print: 2 };
const worldLines: string[] = [];
const tooFar = (x: number, z: number) => Math.hypot(x - centre.x, z - centre.z) > R;
const saved = existsSync(worldMeta) ? (JSON.parse(readFileSync(worldMeta, "utf8")) as typeof meta & { at: string }) : null;
const sameGrid = !!saved && (Object.keys(meta) as (keyof typeof meta)[]).every((k) => saved[k] === meta[k]);
if (!rebase && saved && existsSync(worldBin) && !sameGrid) {
  worldLines.push("world: NOT COMPARED, the grid is not the baseline's (WORLD or the tool changed); take one with --base");
} else if (!rebase && saved && existsSync(worldBin)) {
  const raw = readFileSync(worldBin);
  const before = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + GW * GH * 4));
  const beforePrints = new Uint32Array(raw.buffer.slice(raw.byteOffset + GW * GH * 4, raw.byteOffset + GW * GH * 8));
  // Changed cells gathered into 50 m tiles, each named by the frame nearest it.
  const TILE = 50;
  // Each cell is in or past the place by its own centre; a tile counts its cells past the place
  // apart from the rest, so a tile across the edge reports only what lies beyond it.
  const tiles = new Map<string, { n: number; out: number; outMax: number; x: number; z: number }>();
  for (let j = 0; j < GH; j++)
    for (let i = 0; i < GW; i++) {
      const c = j * GW + i;
      const d = Math.abs(heights[c] - before[c]);
      if (!(d > 0.05) && prints[c] === beforePrints[c]) continue;
      const x = WORLD.x0 + (i + 0.5) * CELL;
      const z = WORLD.z0 + (j + 0.5) * CELL;
      const k = `${Math.floor(x / TILE)},${Math.floor(z / TILE)}`;
      const t = tiles.get(k) ?? { n: 0, out: 0, outMax: 0, x: (Math.floor(x / TILE) + 0.5) * TILE, z: (Math.floor(z / TILE) + 0.5) * TILE };
      t.n++;
      if (tooFar(x, z)) {
        t.out++;
        t.outMax = Math.max(t.outMax, d);
      }
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
  const outside = list.filter((t) => t.out > 0).sort((a, b) => b.out - a.out);
  worldLines.push(
    `world since the baseline of ${saved.at}: ${list.reduce((s, t) => s + t.n, 0)} cells of ${CELL} m changed (height or what stands there) in ${list.length} tiles of 50 m, ${outside.length} of them beyond ${R} m of ${target}`,
  );
  for (const t of outside.slice(0, 12)) worldLines.push(`  OUTSIDE tile (${t.x}, ${t.z}) near ${near(t.x, t.z)}: ${t.out} cells, height up to ${t.outMax.toFixed(1)} m`);
  if (outside.length > 12) worldLines.push(`  ... and ${outside.length - 12} more tiles outside`);
} else {
  writeFileSync(worldBin, Buffer.concat([Buffer.from(heights.buffer), Buffer.from(prints.buffer)]));
  writeFileSync(worldMeta, JSON.stringify({ ...meta, at: new Date().toISOString() }));
  worldLines.push("world: baseline saved");
}

// --- a top-down crop of the place.
const top = spawnSync("npx", ["tsx", "scripts/ringfall-topdown.ts", `${out}/topdown.png`, String(centre.x), String(centre.z), String(R * 2)], { stdio: "inherit" });
if (top.status !== 0) process.exit(top.status ?? 1);
console.log(`top-down drawn (${secs()})`);

// --- the cameras: the tour's within the place, and four from above round it. Each carries the
// placement it was asked for (`spec`), which the baseline is checked against: a tour camera's
// numbers, or an above camera's direction, the place's centre and the radius (its height follows the ground, so a change
// to the place moves it without making it another camera).
interface Cam {
  name: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  abs: boolean;
  spec: string;
}
const frames = FRAMES as Record<string, { x: number; z: number }>;
const cams: Cam[] = [...TOUR, ...HARBOR_TOUR]
  .map((c) => {
    const [name, x, y, z, yaw, pitch, abs] = place(frames, c) as [string, number, number, number, number, number, boolean];
    return { name, x, y, z, yaw, pitch, abs, spec: JSON.stringify([x, y, z, yaw, pitch, abs].map((v) => (typeof v === "number" ? +v.toFixed(3) : v))) };
  })
  .filter((c) => !tooFar(c.x, c.z));
const D = Math.max(80, R * 0.9);
const g0 = terrainHeight(centre.x, centre.z);
for (const [i, a] of [Math.PI / 4, (3 * Math.PI) / 4, (-3 * Math.PI) / 4, -Math.PI / 4].entries()) {
  const dir = ["ne", "se", "sw", "nw"][i];
  const x = centre.x + Math.sin(a) * D;
  const z = centre.z - Math.cos(a) * D;
  const y = Math.max(terrainHeight(x, z), g0) + D * 0.55;
  cams.push({ name: `above-${dir}`, x, y, z, yaw: Math.atan2(centre.x - x, -(centre.z - z)), pitch: Math.atan2(g0 - y, D), abs: true, spec: `above ${dir} of (${+centre.x.toFixed(3)}, ${+centre.z.toFixed(3)}) r ${R}` });
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

// Each camera's `spec` is kept beside the baseline: a picture is compared only with one taken from
// the same camera, so a look with another --r or an edited tour asks for a new baseline instead.
const camsPath = `${baseDir}/cameras.json`;
const baseCams: Record<string, string> = existsSync(camsPath) ? JSON.parse(readFileSync(camsPath, "utf8")) : {};
const lines: string[] = [];
for (const { name, x, y: dy, z, yaw, pitch, abs, spec } of cams) {
  const y = abs ? dy : terrainHeight(x, z) + dy;
  await page.evaluate(([x, y, z, yaw, pitch]) => window.ringfallCamera(x, y, z, yaw, pitch), [x, y, z, yaw, pitch]);
  // Chunks inside the fog are built at once; two more frames let the shadows and the trim settle.
  await page.evaluate(() => (window.ringfallDraw(), window.ringfallDraw()));
  const shot = await view.screenshot({ path: `${out}/${name}.png` });
  console.log(`  ${name} (${secs()})`);
  const basePath = `${baseDir}/${name}.png`;
  if (rebase || !existsSync(basePath)) {
    copyFileSync(`${out}/${name}.png`, basePath);
    baseCams[name] = spec;
    lines.push(`${name}: baseline saved`);
    continue;
  }
  if (baseCams[name] !== spec) {
    lines.push(`${name}: NOT COMPARED, the camera is not where the baseline was taken from (another --r, the place or the tour moved); take one with --base`);
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
writeFileSync(camsPath, JSON.stringify(baseCams, null, 1));
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
