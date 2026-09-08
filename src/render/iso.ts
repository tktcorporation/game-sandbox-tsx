// 2.5D village / battle renderer. Buildings are procedural extruded prisms;
// troops, loot and collect chips are Kenney Tiny 16×16 sprites (see src/assets/kenney.ts).

import { drawKenney, preloadPixels } from "../assets/drawPixel";
import { RESOURCE_PIXEL, TROOP_PIXEL } from "../assets/gameSprites";
import { hammer } from "../assets/kenney";
import { DEPLOY_DEPTH, GRID_H, GRID_W } from "../game/buildings";

preloadPixels([...Object.values(TROOP_PIXEL), ...Object.values(RESOURCE_PIXEL), hammer]);

export { GRID_H, GRID_W, DEPLOY_DEPTH };
/** legacy alias: largest grid dimension */
export const GRID = Math.max(GRID_W, GRID_H);

/** fraction of the viewport height kept clear above the far row, so tall
 *  structures on the back edge have somewhere to rise into (and a sliver of
 *  sky reads as a horizon). */
const HEADROOM = 0.14;

export interface IsoView {
  ox: number; // screen-x of grid origin (gx=gy=0 maps here, offset by ox)
  oy: number;
  tw: number; // tile width in px
  th: number; // tile height in px (tw / 2)
}

export interface Pt {
  x: number;
  y: number;
}

export interface Camera {
  zoom: number;
  panX: number;
  panY: number;
}

/** Lay the GRID_W x GRID_H map out as an axis-aligned rectangle that fills the
 *  whole W x H viewport: columns span the full width, rows fill the height
 *  below a small headroom band. `tw` is a tile's screen width, `th` its screen
 *  depth (vertical distance between rows). Row 0 is far (top), the last row is
 *  near (bottom). Camera zoom/pan let the village be explored. */
export function makeView(
  W: number,
  H: number,
  opts?: { lift?: number; cam?: Camera },
): IsoView {
  const zoom = opts?.cam?.zoom ?? 1;
  const top = H * HEADROOM;
  const tw = (W / GRID_W) * zoom;
  const th = ((H - top) / GRID_H) * zoom;
  const fieldW = GRID_W * tw;
  const ox = (W - fieldW) / 2 + (opts?.cam?.panX ?? 0);
  const oy = top + (opts?.cam?.panY ?? 0);
  return { ox, oy, tw, th };
}

/** soft dark vignette over the whole frame — cheap cinematic depth. */
export function drawVignette(ctx: CanvasRenderingContext2D, W: number, H: number): void {
  const g = ctx.createRadialGradient(W / 2, H * 0.42, Math.min(W, H) * 0.3, W / 2, H * 0.5, Math.max(W, H) * 0.78);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(0.7, "rgba(6,10,20,0.12)");
  g.addColorStop(1, "rgba(4,7,16,0.42)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

/** atmospheric perspective: a soft haze that thickens toward the far (top)
 *  edge so distance reads, the way fog grounds an Unreal scene. */
export function drawAtmosphere(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  haze: string,
): void {
  const g = ctx.createLinearGradient(0, 0, 0, H * 0.5);
  g.addColorStop(0, haze);
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H * 0.5);
}

/** cheap cinematic post: a bloom pass (additive blurred highlights) plus a
 *  filmic colour grade (punchier contrast + saturation). Two full-frame
 *  drawImages — all GPU-composited, so it stays light. */
export function postProcess(ctx: CanvasRenderingContext2D, W: number, H: number): void {
  const canvas = ctx.canvas;
  // bloom: add a blurred, brightened copy of the frame back over itself.
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.globalAlpha = 0.26;
  ctx.filter = "blur(7px) brightness(1.32)";
  ctx.drawImage(canvas, 0, 0, W, H);
  ctx.restore();
  ctx.filter = "none";
  // filmic grade: replace the frame with a contrast/saturation-graded copy.
  ctx.save();
  ctx.globalCompositeOperation = "copy";
  ctx.filter = "contrast(1.08) saturate(1.18) brightness(1.01)";
  ctx.drawImage(canvas, 0, 0, W, H);
  ctx.restore();
  ctx.filter = "none";
}

// ---------------------------------------------------------------------------
// Day / night cycle
// ---------------------------------------------------------------------------

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
function mix3(a: number[], b: number[], t: number): string {
  return `rgb(${Math.round(lerp(a[0], b[0], t))},${Math.round(lerp(a[1], b[1], t))},${Math.round(lerp(a[2], b[2], t))})`;
}

export interface DayLight {
  day: number; // 0 night .. 1 noon
  night: number;
  horizonGlow: number;
  sun: number; // -1..1 height
  skyTop: string;
  skyBot: string;
  overlay: { r: number; g: number; b: number; a: number };
}

/** t01 in [0,1): a full day. ~half day, half night with dawn/dusk warmth. */
export function dayLight(t01: number): DayLight {
  const phase = t01 * Math.PI * 2;
  const sun = Math.sin(phase);
  const day = clamp01(sun * 1.7 + 0.28);
  const night = 1 - day;
  const horizonGlow = clamp01(1 - Math.abs(sun) * 2.3);
  const skyTop = mix3([18, 22, 48], [78, 138, 188], day);
  let skyBot = mix3([34, 36, 66], [158, 206, 224], day);
  skyBot = mix3sShim(skyBot, [242, 150, 86], horizonGlow * 0.75);
  return {
    day,
    night,
    horizonGlow,
    sun,
    skyTop,
    skyBot,
    overlay: { r: 12, g: 16, b: 42, a: night * 0.42 },
  };
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
// lerp between an existing "rgb(r,g,b)" string and a target rgb array
function mix3sShim(rgb: string, target: number[], t: number): string {
  const m = rgb.match(/\d+/g)!;
  return mix3([+m[0], +m[1], +m[2]], target, t);
}

export function drawSky(ctx: CanvasRenderingContext2D, W: number, H: number, dl: DayLight): void {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, dl.skyTop);
  g.addColorStop(1, dl.skyBot);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // sun / moon riding an arc; horizontal position tracks sun height
  const t = Math.asin(Math.max(-1, Math.min(1, dl.sun))) / Math.PI + 0.5; // 0..1
  const cx = W * (0.15 + 0.7 * t);
  const cy = H * (0.5 - dl.sun * 0.34);
  const r = Math.min(W, H) * 0.06;
  if (dl.sun > -0.25) {
    const sg = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 2.4);
    sg.addColorStop(0, mix3sShim("rgb(255,240,200)", [255, 180, 120], dl.horizonGlow));
    sg.addColorStop(1, "rgba(255,220,150,0)");
    ctx.fillStyle = sg;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 2.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = mix3sShim("rgb(255,247,224)", [255, 170, 110], dl.horizonGlow);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.fillStyle = "rgba(225,228,240,0.9)";
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.8, 0, Math.PI * 2);
    ctx.fill();
  }
}

export function drawNightOverlay(ctx: CanvasRenderingContext2D, W: number, H: number, dl: DayLight): void {
  if (dl.overlay.a <= 0.01) return;
  ctx.fillStyle = `rgba(${dl.overlay.r},${dl.overlay.g},${dl.overlay.b},${dl.overlay.a})`;
  ctx.fillRect(0, 0, W, H);
}

export function project(v: IsoView, gx: number, gy: number): Pt {
  return { x: v.ox + gx * v.tw, y: v.oy + gy * v.th };
}

export function unproject(v: IsoView, sx: number, sy: number): { gx: number; gy: number } {
  return { gx: (sx - v.ox) / v.tw, gy: (sy - v.oy) / v.th };
}

/** deterministic 0..1 hash from two integers (stable terrain decoration). */
function hash2(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = (h ^ (h >> 13)) * 1274126177;
  return ((h ^ (h >> 16)) >>> 0) / 4294967296;
}

function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.min(255, Math.round(((n >> 16) & 255) * f)));
  const g = Math.max(0, Math.min(255, Math.round(((n >> 8) & 255) * f)));
  const b = Math.max(0, Math.min(255, Math.round((n & 255) * f)));
  return `rgb(${r},${g},${b})`;
}

function poly(ctx: CanvasRenderingContext2D, pts: Pt[]): void {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
}

function fillPoly(ctx: CanvasRenderingContext2D, pts: Pt[], fill: string): void {
  poly(ctx, pts);
  ctx.fillStyle = fill;
  ctx.fill();
}

// ---------------------------------------------------------------------------
// Texture grain — the cheap-but-not-cheap-looking trick. A single chunky
// pixel-noise tile is baked once into an offscreen canvas, then overlaid on
// flat fills with `soft-light` so every surface gets a consistent, crafted
// "texel" grain instead of dead-flat colour. One extra fillRect per face.
// ---------------------------------------------------------------------------

let _noise: CanvasPattern | null = null;
let _noiseTried = false;

function noisePattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  if (_noiseTried) return _noise;
  _noiseTried = true;
  if (typeof document === "undefined") return null;
  const size = 72;
  const texel = 3; // chunky, Minecraft-ish texels
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  if (!g) return null;
  for (let y = 0; y < size; y += texel) {
    for (let x = 0; x < size; x += texel) {
      const n = hash2(x * 12.9 + 1, y * 78.2 + 7); // 0..1, stable
      const d = n - 0.5;
      const a = Math.abs(d) * 0.85;
      g.fillStyle = d >= 0 ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a})`;
      g.fillRect(x, y, texel, texel);
    }
  }
  _noise = ctx.createPattern(c, "repeat");
  return _noise;
}

/** overlay baked grain onto a rect to lift flat fills out of "cheap" territory. */
function grain(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  alpha = 1,
): void {
  const pat = noisePattern(ctx);
  if (!pat) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = "soft-light";
  ctx.fillStyle = pat;
  ctx.fillRect(x, y, w, h);
  ctx.restore();
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// ---------------------------------------------------------------------------
// Ground / terrain
// ---------------------------------------------------------------------------

export function drawGround(
  ctx: CanvasRenderingContext2D,
  v: IsoView,
  opts?: { hostile?: boolean },
): void {
  const hostile = opts?.hostile ?? false;
  const grass = hostile ? "#6b9a48" : "#77ba55";

  const TL = project(v, 0, 0);
  const fieldW = GRID_W * v.tw;
  const fieldH = GRID_H * v.th;

  // one continuous grassy field, only faint per-tile value drift + a gentle
  // far→near light gradient. The baked grain carries the fine texture and
  // masks tile seams, the way Minecraft's per-texel noise hides block edges.
  for (let gy = 0; gy < GRID_H; gy++) {
    const depthShade = 0.94 + (gy / GRID_H) * 0.11;
    for (let gx = 0; gx < GRID_W; gx++) {
      const a = project(v, gx, gy);
      const c = project(v, gx + 1, gy + 1);
      const jitter = hash2(gx * 7 + 3, gy * 11 + 5) * 0.05 - 0.025;
      fillPoly(
        ctx,
        [a, { x: c.x, y: a.y }, c, { x: a.x, y: c.y }],
        shade(grass, depthShade + jitter),
      );
    }
  }

  // baked fine texel grain — masks tile seams and gives the turf its texture.
  grain(ctx, TL.x, TL.y, fieldW, fieldH, 0.6);

  // soft shaded band along the far (top) edge — reads as a horizon ridge
  const grad = ctx.createLinearGradient(0, TL.y - v.th, 0, TL.y + v.th * 1.5);
  grad.addColorStop(0, "rgba(0,0,0,0.22)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(TL.x, TL.y - v.th, GRID_W * v.tw, v.th * 2.5);
}

// ---------------------------------------------------------------------------
// Deploy zone (battle) — the front wedge nearest the player where troops land.
// ---------------------------------------------------------------------------

/** first (near) row that counts as the player's front deploy beach. */
export const DEPLOY_MIN_ROW = GRID_H - DEPLOY_DEPTH;

/** is a (continuous) grid point inside the player's near deploy band? */
export function inDeployZone(gx: number, gy: number): boolean {
  return gx >= 0 && gx <= GRID_W && gy >= DEPLOY_MIN_ROW && gy <= GRID_H;
}

/** highlight the near deploy band with a pulsing tint, front line + up-arrows. */
export function drawDeployZone(ctx: CanvasRenderingContext2D, v: IsoView, time: number): void {
  const pulse = 0.16 + Math.sin(time * 2.2) * 0.06;
  const top = project(v, 0, DEPLOY_MIN_ROW);
  const bot = project(v, GRID_W, GRID_H);
  ctx.fillStyle = `rgba(96,210,128,${pulse.toFixed(3)})`;
  ctx.fillRect(top.x, top.y, bot.x - top.x, bot.y - top.y);

  // bright dashed front line where the deploy band meets enemy ground
  ctx.save();
  ctx.setLineDash([v.tw * 0.28, v.tw * 0.22]);
  ctx.strokeStyle = "rgba(120,240,150,0.8)";
  ctx.lineWidth = Math.max(1.5, v.th * 0.06);
  ctx.beginPath();
  ctx.moveTo(top.x, top.y);
  ctx.lineTo(bot.x, top.y);
  ctx.stroke();
  ctx.restore();

  // upward chevrons reminding which way to push
  const bob = Math.sin(time * 3) * v.th * 0.1;
  const mx = top.x + (bot.x - top.x) / 2;
  const my = (top.y + bot.y) / 2;
  ctx.save();
  ctx.strokeStyle = "rgba(180,255,200,0.85)";
  ctx.lineWidth = Math.max(2, v.tw * 0.05);
  ctx.lineCap = "round";
  for (let k = 0; k < 2; k++) {
    const yy = my - bob - k * v.th * 0.42;
    ctx.beginPath();
    ctx.moveTo(mx - v.tw * 0.34, yy + v.tw * 0.22);
    ctx.lineTo(mx, yy - v.tw * 0.06);
    ctx.lineTo(mx + v.tw * 0.34, yy + v.tw * 0.22);
    ctx.stroke();
  }
  ctx.restore();
  ctx.lineCap = "butt";
}

/** scattered decorations (trees/rocks/bushes) on free tiles, depth-sortable. */
export interface Deco {
  gx: number;
  gy: number;
  depth: number;
  draw: (ctx: CanvasRenderingContext2D, v: IsoView) => void;
}

export function buildDecorations(occupied: Set<string>, hostile = false): Deco[] {
  const out: Deco[] = [];
  for (let gy = 0; gy < GRID_H; gy++) {
    for (let gx = 0; gx < GRID_W; gx++) {
      if (occupied.has(`${gx},${gy}`)) continue;
      const r = hash2(gx * 7 + 1, gy * 13 + 3);
      if (r > 0.12) continue; // sparse
      const kind = r < 0.06 ? "tree" : r < 0.09 ? "bush" : "rock";
      out.push({
        gx: gx + 0.5,
        gy: gy + 0.5,
        depth: gy + 0.5,
        draw: (ctx, v) => drawDeco(ctx, v, gx + 0.5, gy + 0.5, kind, hostile),
      });
    }
  }
  return out;
}

function drawDeco(
  ctx: CanvasRenderingContext2D,
  v: IsoView,
  gx: number,
  gy: number,
  kind: string,
  hostile: boolean,
): void {
  const p = project(v, gx, gy);
  const s = v.tw;
  // shadow
  ctx.fillStyle = "rgba(0,0,0,0.18)";
  ctx.beginPath();
  ctx.ellipse(p.x, p.y, s * 0.22, s * 0.11, 0, 0, Math.PI * 2);
  ctx.fill();
  if (kind === "rock") {
    fillPoly(ctx, [
      { x: p.x - s * 0.16, y: p.y },
      { x: p.x - s * 0.05, y: p.y - s * 0.16 },
      { x: p.x + s * 0.12, y: p.y - s * 0.12 },
      { x: p.x + s * 0.17, y: p.y + s * 0.02 },
    ], "#8d8a82");
    return;
  }
  const leaf = hostile ? "#4f7b3a" : "#3f9d4e";
  if (kind === "bush") {
    ctx.fillStyle = leaf;
    for (const dx of [-0.1, 0.08, 0]) {
      ctx.beginPath();
      ctx.arc(p.x + dx * s, p.y - s * 0.08, s * 0.12, 0, Math.PI * 2);
      ctx.fill();
    }
    return;
  }
  // tree: trunk + canopy
  ctx.fillStyle = "#6b4a2a";
  ctx.fillRect(p.x - s * 0.03, p.y - s * 0.3, s * 0.06, s * 0.3);
  ctx.fillStyle = shade(leaf, 0.85);
  ctx.beginPath();
  ctx.arc(p.x, p.y - s * 0.34, s * 0.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = leaf;
  ctx.beginPath();
  ctx.arc(p.x - s * 0.07, p.y - s * 0.42, s * 0.14, 0, Math.PI * 2);
  ctx.fill();
}

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

interface SpriteDef {
  color: string;
  roof: string;
  trim?: string;
  h: number; // height in tile-widths
  fam: "hall" | "tower" | "tent" | "cannon" | "tank" | "mine" | "storage" | "wall";
}

const SPRITES: Record<string, SpriteDef> = {
  townhall: { color: "#ecdcb0", roof: "#c0392b", trim: "#f5c518", h: 1.0, fam: "hall" },
  goldmine: { color: "#806137", roof: "#f4c430", h: 0.55, fam: "mine" },
  elixircollector: { color: "#7d44a0", roof: "#e09bf2", h: 0.72, fam: "tank" },
  goldstorage: { color: "#8a6e34", roof: "#f4c430", h: 0.7, fam: "storage" },
  elixirstorage: { color: "#6a3a90", roof: "#cf73ef", h: 0.78, fam: "tank" },
  barracks: { color: "#7a4636", roof: "#a8392b", h: 0.72, fam: "hall" },
  armycamp: { color: "#caa46a", roof: "#b5532f", h: 0.42, fam: "tent" },
  cannon: { color: "#70707a", roof: "#3a3a42", h: 0.5, fam: "cannon" },
  archertower: { color: "#90897a", roof: "#7a5a36", h: 1.25, fam: "tower" },
  wall: { color: "#9a8e74", roof: "#7d7058", h: 0.42, fam: "wall" },
};

const FALLBACK: SpriteDef = { color: "#9a9a9a", roof: "#666", h: 0.6, fam: "hall" };

export interface BuildingDraw {
  type: string;
  level: number;
  x: number;
  y: number;
  size: number;
  time: number;
  hpFrac?: number; // <1 => show hp bar (battle)
  selected?: boolean;
  constructing?: boolean;
  remainingLabel?: string;
  collect?: { kind: "gold" | "elixir"; full: boolean } | null;
  showLevel?: boolean;
  /** transient placement bounce: extra vertical scale, eases back to 0 */
  squash?: number;
  /** enable ambient idle animation (chimney smoke / water shimmer) */
  ambient?: boolean;
  /** 0..1 nighttime factor — lights up windows */
  night?: number;
}

const HEIGHT_UNIT = 0.9; // building extrusion height per `h`, in tile-depths
const FOOT_INSET = 0.08; // gap (in tiles) left around a building so neighbours read apart

/** Screen geometry of an extruded box. Its footprint maps to an axis-aligned
 *  rect (x0..x1 wide, yFar..yNear deep) and it rises `h` px toward the camera.
 *  Only the front (south) wall and the top face show — a clean, screen-filling
 *  2.5D look. `baseLift` stacks a smaller box on top of a bigger one. */
interface BoxGeom {
  x0: number;
  x1: number;
  yFar: number;
  yNear: number;
  h: number;
  cx: number;
  cyTop: number;
}

function boxGeom(
  v: IsoView,
  x: number,
  y: number,
  size: number,
  h: number,
  baseLift = 0,
  inset = 0,
): BoxGeom {
  const x0 = v.ox + (x + inset) * v.tw;
  const x1 = v.ox + (x + size - inset) * v.tw;
  const yFar = v.oy + (y + inset) * v.th - baseLift;
  const yNear = v.oy + (y + size - inset) * v.th - baseLift;
  return { x0, x1, yFar, yNear, h, cx: (x0 + x1) / 2, cyTop: (yFar + yNear) / 2 - h };
}

const GLOSS: Record<string, number> = {
  hall: 0.42,
  tower: 0.5,
  tent: 0.26,
  cannon: 0.88,
  tank: 0.92,
  mine: 0.72,
  storage: 0.74,
  wall: 0.32,
};
const glossOf = (fam: string): number => GLOSS[fam] ?? 0.42;

function drawBox(
  ctx: CanvasRenderingContext2D,
  g: BoxGeom,
  color: string,
  lw = 1.2,
  outline = true,
  gloss = 0.42,
): void {
  const { x0, x1, yFar, yNear, h } = g;
  const roofTop = yFar - h;
  const wallTop = yNear - h;
  const w = x1 - x0;
  const roofH = yNear - yFar;

  // --- top (roof) face: lit, warm sunlight, grain ---
  const topGrad = ctx.createLinearGradient(0, roofTop, 0, wallTop);
  topGrad.addColorStop(0, shade(color, 1.06));
  topGrad.addColorStop(1, shade(color, 1.24));
  ctx.fillStyle = topGrad;
  ctx.fillRect(x0, roofTop, w, roofH);
  ctx.fillStyle = "rgba(255,238,198,0.08)"; // warm key light
  ctx.fillRect(x0, roofTop, w, roofH);
  grain(ctx, x0, roofTop, w, roofH, 0.55);
  // glossy specular sheen near the sunlit far edge, scaled by material gloss
  const spec = ctx.createLinearGradient(0, roofTop, 0, roofTop + roofH * 0.6);
  spec.addColorStop(0, `rgba(255,255,255,${(0.08 + gloss * 0.3).toFixed(3)})`);
  spec.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = spec;
  ctx.fillRect(x0, roofTop, w, roofH * 0.6);
  // tight specular hotspot for shiny materials (metal / liquid / gold)
  if (gloss > 0.55) {
    const hx = x0 + w * 0.64;
    const hy = roofTop + roofH * 0.28;
    const hr = w * 0.4;
    const hot = ctx.createRadialGradient(hx, hy, 0, hx, hy, hr);
    hot.addColorStop(0, `rgba(255,255,255,${(gloss * 0.34).toFixed(3)})`);
    hot.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = hot;
    ctx.beginPath();
    ctx.ellipse(hx, hy, hr, hr * 0.55, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // --- front (south) wall: shadowed, cool, grain, contact AO ---
  const wallGrad = ctx.createLinearGradient(0, wallTop, 0, yNear);
  wallGrad.addColorStop(0, shade(color, 0.84));
  wallGrad.addColorStop(1, shade(color, 0.56));
  ctx.fillStyle = wallGrad;
  ctx.fillRect(x0, wallTop, w, h);
  ctx.fillStyle = "rgba(44,58,98,0.07)"; // cool shadow tint
  ctx.fillRect(x0, wallTop, w, h);
  grain(ctx, x0, wallTop, w, h, 0.75);
  // ambient occlusion pooling at the base
  const aoH = Math.min(h * 0.45, h);
  const ao = ctx.createLinearGradient(0, yNear - aoH, 0, yNear);
  ao.addColorStop(0, "rgba(0,0,0,0)");
  ao.addColorStop(1, "rgba(0,0,0,0.26)");
  ctx.fillStyle = ao;
  ctx.fillRect(x0, yNear - aoH, w, aoH);
  // soft inner shade on the left edge / highlight on the right gives roundness
  ctx.fillStyle = "rgba(0,0,0,0.12)";
  ctx.fillRect(x0, wallTop, Math.max(1, w * 0.06), h);
  ctx.fillStyle = "rgba(255,255,255,0.06)";
  ctx.fillRect(x1 - Math.max(1, w * 0.06), wallTop, Math.max(1, w * 0.06), h);

  if (outline) {
    // crisp dark silhouette
    ctx.strokeStyle = "rgba(0,0,0,0.4)";
    ctx.lineWidth = Math.max(1, lw);
    ctx.beginPath();
    ctx.moveTo(x0, roofTop);
    ctx.lineTo(x1, roofTop);
    ctx.lineTo(x1, yNear);
    ctx.lineTo(x0, yNear);
    ctx.closePath();
    ctx.stroke();
    // roof / wall seam
    ctx.beginPath();
    ctx.moveTo(x0, wallTop);
    ctx.lineTo(x1, wallTop);
    ctx.stroke();
    // bright rim along the sunlit top-far edge
    ctx.strokeStyle = "rgba(255,252,236,0.32)";
    ctx.lineWidth = Math.max(1, lw * 0.7);
    ctx.beginPath();
    ctx.moveTo(x0, roofTop + 0.5);
    ctx.lineTo(x1, roofTop + 0.5);
    ctx.stroke();
  }
}

export function drawBuilding(ctx: CanvasRenderingContext2D, v: IsoView, d: BuildingDraw): void {
  const sp = SPRITES[d.type] ?? FALLBACK;
  const levelScale = 1 + (Math.min(d.level, 10) - 1) * 0.05;
  const unit = v.th * HEIGHT_UNIT;
  const h = sp.h * unit * levelScale * (1 + (d.squash ?? 0));
  const lw = Math.max(1, v.tw * 0.04);
  const g = boxGeom(v, d.x, d.y, d.size, h, 0, FOOT_INSET);
  const w = g.x1 - g.x0;

  // directional cast shadow on the ground (sun from the upper-left), softened
  const sx = h * 0.52;
  const sy = h * 0.32;
  ctx.save();
  ctx.globalAlpha = 0.3;
  ctx.filter = `blur(${Math.max(1, v.tw * 0.06)}px)`;
  fillPoly(
    ctx,
    [
      { x: g.x0, y: g.yFar },
      { x: g.x1, y: g.yFar },
      { x: g.x1 + sx, y: g.yFar + sy },
      { x: g.x1 + sx, y: g.yNear + sy },
      { x: g.x0 + sx, y: g.yNear + sy },
      { x: g.x0, y: g.yNear },
    ],
    "#070f06",
  );
  ctx.restore();
  ctx.filter = "none";

  drawBox(ctx, g, sp.color, lw, true, glossOf(sp.fam));

  // night windows on the front wall
  if (d.night && d.night > 0.32 && !d.constructing && sp.fam !== "wall" && sp.fam !== "tent") {
    drawWindows(ctx, g, v, d.night);
  }

  // family-specific structure on top
  drawStructure(ctx, v, d, sp, g, lw);

  // tier studs: gold rivets along the roof's near edge for higher levels
  if (d.level >= 4) {
    ctx.fillStyle = "#f5c518";
    const y = g.yNear - h;
    for (const fx of [0.2, 0.5, 0.8]) {
      ctx.beginPath();
      ctx.arc(g.x0 + w * fx, y, v.tw * 0.04, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ambient chimney smoke for halls
  if (d.ambient && sp.fam === "hall") {
    drawSmoke(ctx, g.cx + v.tw * 0.2, g.cyTop - h * 0.1, v.tw, d.time, d.x * 7 + d.y * 13);
  }

  // selection highlight (village)
  if (d.selected) {
    ctx.strokeStyle = "#ffe06a";
    ctx.lineWidth = v.tw * 0.06;
    ctx.strokeRect(g.x0, g.yFar - h, w, g.yNear - (g.yFar - h));
  }

  // hp bar (battle)
  if (d.hpFrac !== undefined && d.hpFrac < 1) {
    drawBar(ctx, { x: g.cx, y: g.yFar - h - 6 }, w * 0.9, d.hpFrac);
  }

  // level badge (village)
  if (d.showLevel && !d.constructing) {
    drawBadge(ctx, { x: g.x1 - v.tw * 0.12, y: g.yNear - v.th * 0.12 }, String(d.level), v.tw);
  }

  // collect icon bobbing above
  if (d.collect && !d.constructing) {
    const bob = Math.sin(d.time * 3) * v.tw * 0.07;
    drawCollect(ctx, g.cx, g.yFar - h - v.tw * 0.3 + bob, v.tw, d.collect);
  }

  // construction overlay
  if (d.constructing) {
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = "#0b1410";
    ctx.fillRect(g.x0, g.yFar - h, w, g.yNear - (g.yFar - h));
    ctx.restore();
    drawHammer(ctx, g.cx, g.cyTop, v.tw, d.time);
    if (d.remainingLabel) drawLabel(ctx, g.cx, g.yNear - h * 0.5, d.remainingLabel, v.tw);
  }
}

function drawStructure(
  ctx: CanvasRenderingContext2D,
  v: IsoView,
  d: BuildingDraw,
  sp: SpriteDef,
  g: BoxGeom,
  lw: number,
): void {
  const tw = v.tw;
  const w = g.x1 - g.x0;
  switch (sp.fam) {
    case "hall": {
      const ins = d.size * 0.16;
      const r = boxGeom(v, d.x + ins, d.y + ins, d.size - ins * 2, g.h * 0.45, g.h);
      drawBox(ctx, r, sp.roof, lw, true, glossOf(sp.fam));
      if (sp.trim) {
        // gold knob + waving flag on a pole
        ctx.fillStyle = sp.trim;
        ctx.beginPath();
        ctx.arc(r.cx, r.cyTop, tw * 0.07, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#6b4a2a";
        ctx.lineWidth = tw * 0.03;
        ctx.beginPath();
        ctx.moveTo(r.cx, r.cyTop);
        ctx.lineTo(r.cx, r.cyTop - tw * 0.4);
        ctx.stroke();
        const wave = Math.sin(d.time * 4) * tw * 0.03;
        fillPoly(ctx, [
          { x: r.cx, y: r.cyTop - tw * 0.4 },
          { x: r.cx + tw * 0.2, y: r.cyTop - tw * 0.34 + wave },
          { x: r.cx, y: r.cyTop - tw * 0.28 },
        ], "#e23b3b");
      }
      break;
    }
    case "tower": {
      const ins = d.size * 0.2;
      const cap = boxGeom(v, d.x + ins, d.y + ins, d.size - ins * 2, g.h * 0.3, g.h);
      drawBox(ctx, cap, sp.roof, lw, true, glossOf(sp.fam));
      // arrow slit on the front wall
      ctx.fillStyle = "rgba(0,0,0,0.5)";
      ctx.fillRect(g.cx - tw * 0.03, g.yNear - g.h * 0.72, tw * 0.06, g.h * 0.45);
      break;
    }
    case "tent": {
      const ins = d.size * 0.08;
      const roof = boxGeom(v, d.x + ins, d.y + ins, d.size - ins * 2, g.h * 0.55, g.h);
      drawBox(ctx, roof, sp.roof, lw, true, glossOf(sp.fam));
      break;
    }
    case "cannon": {
      // pivot dome + barrel aimed up-field toward the enemy
      ctx.fillStyle = "#2c2c33";
      ctx.beginPath();
      ctx.arc(g.cx, g.cyTop, tw * 0.2 * d.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#1a1a1f";
      ctx.lineCap = "round";
      ctx.lineWidth = tw * 0.16 * d.size;
      ctx.beginPath();
      ctx.moveTo(g.cx, g.cyTop);
      ctx.lineTo(g.cx, g.cyTop - g.h * 0.55 - tw * 0.1);
      ctx.stroke();
      ctx.lineCap = "butt";
      break;
    }
    case "tank": {
      ctx.fillStyle = shade(sp.roof, 1.05);
      ctx.beginPath();
      ctx.ellipse(g.cx, g.cyTop, w * 0.34, v.th * d.size * 0.3, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      ctx.beginPath();
      ctx.ellipse(g.cx - w * 0.1, g.cyTop - v.th * 0.06, w * 0.1, v.th * 0.06, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "mine": {
      fillPoly(ctx, [
        { x: g.cx - w * 0.3, y: g.cyTop + v.th * 0.18 },
        { x: g.cx, y: g.cyTop - v.th * 0.34 },
        { x: g.cx + w * 0.3, y: g.cyTop + v.th * 0.18 },
      ], sp.roof);
      ctx.fillStyle = "#fff2b0";
      ctx.beginPath();
      ctx.arc(g.cx - w * 0.07, g.cyTop, tw * 0.04, 0, Math.PI * 2);
      ctx.arc(g.cx + w * 0.08, g.cyTop + v.th * 0.06, tw * 0.03, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "storage": {
      ctx.fillStyle = sp.roof;
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.ellipse(g.cx, g.cyTop - i * v.th * 0.12, w * 0.26, v.th * 0.12, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case "wall": {
      ctx.strokeStyle = "rgba(0,0,0,0.25)";
      ctx.lineWidth = tw * 0.04;
      ctx.beginPath();
      ctx.moveTo(g.x0 + w * 0.15, g.cyTop);
      ctx.lineTo(g.x1 - w * 0.15, g.cyTop);
      ctx.stroke();
      break;
    }
  }
}

function drawSmoke(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  tw: number,
  time: number,
  seed: number,
): void {
  const n = 3;
  for (let i = 0; i < n; i++) {
    const phase = (time * 0.35 + i / n + (seed % 10) / 10) % 1;
    const rise = phase * tw * 0.95;
    const size = tw * 0.05 + phase * tw * 0.11;
    ctx.globalAlpha = (1 - phase) * 0.32;
    ctx.fillStyle = "#dadada";
    ctx.beginPath();
    ctx.arc(x + Math.sin(phase * 6 + seed) * tw * 0.06, y - rise, size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawWindows(ctx: CanvasRenderingContext2D, g: BoxGeom, v: IsoView, night: number): void {
  const glow = Math.min(1, night);
  const s = v.tw * 0.08;
  const wallTop = g.yNear - g.h;
  const w = g.x1 - g.x0;
  const pane = (px: number, py: number) => {
    const grd = ctx.createRadialGradient(px, py, 0, px, py, s * 2.4);
    grd.addColorStop(0, `rgba(255,212,128,${0.5 * glow})`);
    grd.addColorStop(1, "rgba(255,200,120,0)");
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.arc(px, py, s * 2.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(255,226,156,${0.92 * glow})`;
    ctx.fillRect(px - s / 2, py - s / 2, s, s);
  };
  for (const cx of [0.3, 0.7]) {
    for (const ry of [0.42, 0.74]) {
      pane(g.x0 + w * cx, wallTop + g.h * ry);
    }
  }
}

function drawBar(ctx: CanvasRenderingContext2D, top: Pt, w: number, frac: number): void {
  const x = top.x - w / 2;
  const y = top.y - 8;
  ctx.fillStyle = "rgba(0,0,0,0.65)";
  ctx.fillRect(x - 1, y - 1, w + 2, 6);
  ctx.fillStyle = frac > 0.5 ? "#5fd35f" : frac > 0.25 ? "#f4c430" : "#e04a4a";
  ctx.fillRect(x, y, w * frac, 4);
}

function drawBadge(ctx: CanvasRenderingContext2D, at: Pt, text: string, tw: number): void {
  const r = tw * 0.16;
  ctx.fillStyle = "#11210f";
  ctx.strokeStyle = "#ffe06a";
  ctx.lineWidth = tw * 0.02;
  ctx.beginPath();
  ctx.arc(at.x, at.y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#ffe06a";
  ctx.font = `700 ${Math.round(tw * 0.2)}px "Trebuchet MS", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, at.x, at.y + 0.5);
}

function drawCollect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  tw: number,
  c: { kind: "gold" | "elixir"; full: boolean },
): void {
  const r = tw * 0.16;
  const grd = ctx.createRadialGradient(x, y, 0, x, y, r * 2.2);
  grd.addColorStop(0, c.kind === "gold" ? "rgba(245,197,24,0.5)" : "rgba(196,92,255,0.5)");
  grd.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = grd;
  ctx.beginPath();
  ctx.arc(x, y, r * 2.2, 0, Math.PI * 2);
  ctx.fill();

  const size = Math.max(tw * 0.42, 16);
  if (drawKenney(ctx, RESOURCE_PIXEL[c.kind], x, y, size)) return;

  if (c.kind === "gold") {
    ctx.fillStyle = "#f5c518";
    ctx.strokeStyle = "#9a7400";
    ctx.lineWidth = tw * 0.02;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  } else {
    ctx.fillStyle = "#c45cff";
    ctx.strokeStyle = "#6a2a9a";
    ctx.lineWidth = tw * 0.02;
    ctx.beginPath();
    ctx.moveTo(x, y - r * 1.2);
    ctx.bezierCurveTo(x + r, y - r * 0.2, x + r * 0.8, y + r, x, y + r);
    ctx.bezierCurveTo(x - r * 0.8, y + r, x - r, y - r * 0.2, x, y - r * 1.2);
    ctx.fill();
    ctx.stroke();
  }
}

function drawHammer(ctx: CanvasRenderingContext2D, x: number, y: number, tw: number, time: number): void {
  const swing = Math.sin(time * 6) * 0.5;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-0.6 + swing);
  const size = Math.max(tw * 0.36, 16);
  if (!drawKenney(ctx, hammer, 0, 0, size)) {
    ctx.strokeStyle = "#6b4a2a";
    ctx.lineWidth = tw * 0.05;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, tw * 0.28);
    ctx.stroke();
    ctx.fillStyle = "#9a9a9a";
    ctx.fillRect(-tw * 0.12, -tw * 0.06, tw * 0.24, tw * 0.12);
    ctx.lineCap = "butt";
  }
  ctx.restore();
}

function drawLabel(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, tw: number): void {
  ctx.font = `700 ${Math.round(tw * 0.16)}px "Trebuchet MS", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const w = ctx.measureText(text).width + tw * 0.12;
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  roundRect(ctx, x - w / 2, y - tw * 0.11, w, tw * 0.22, tw * 0.06);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.fillText(text, x, y + 0.5);
}

/** generous hit test against the building silhouette (village tapping). */
export function buildingHit(
  v: IsoView,
  b: { type: string; x: number; y: number; size: number },
  sx: number,
  sy: number,
): boolean {
  const sp = SPRITES[b.type] ?? FALLBACK;
  const h = sp.h * v.th * HEIGHT_UNIT;
  const x0 = v.ox + b.x * v.tw;
  const x1 = v.ox + (b.x + b.size) * v.tw;
  const yTop = v.oy + b.y * v.th - h;
  const yBot = v.oy + (b.y + b.size) * v.th;
  return sx >= x0 && sx <= x1 && sy >= yTop && sy <= yBot;
}

// ---------------------------------------------------------------------------
// Troops
// ---------------------------------------------------------------------------

const TROOP_STYLE: Record<string, { body: string; dark: string; r: number }> = {
  barbarian: { body: "#e0913f", dark: "#8a4f17", r: 0.32 },
  archer: { body: "#54c887", dark: "#1f6b43", r: 0.3 },
  giant: { body: "#d05a5a", dark: "#7a2a2a", r: 0.46 },
};

export interface TroopDraw {
  type: string;
  gx: number;
  gy: number;
  hpFrac: number;
  flash: boolean;
  time: number;
  seed: number;
}

export function drawTroop(ctx: CanvasRenderingContext2D, v: IsoView, t: TroopDraw): void {
  const st = TROOP_STYLE[t.type] ?? TROOP_STYLE.barbarian;
  const p = project(v, t.gx, t.gy);
  const r = st.r * v.tw;
  const bob = Math.abs(Math.sin(t.time * 8 + t.seed)) * v.tw * 0.08;
  const cy = p.y - r * 0.7 - bob;
  const sprite = TROOP_PIXEL[t.type as keyof typeof TROOP_PIXEL];
  const pixelSize = r * 2.6;

  // shadow
  ctx.fillStyle = "rgba(0,0,0,0.25)";
  ctx.beginPath();
  ctx.ellipse(p.x, p.y, r * 0.7, r * 0.32, 0, 0, Math.PI * 2);
  ctx.fill();

  if (t.flash) {
    ctx.fillStyle = "rgba(255,244,176,0.75)";
    ctx.beginPath();
    ctx.ellipse(p.x, p.y - pixelSize * 0.45 - bob, r * 0.85, r, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  const drew = sprite
    ? drawKenney(ctx, sprite, p.x, p.y - bob, pixelSize, { anchor: "feet" })
    : false;

  if (!drew) {
    ctx.fillStyle = t.flash ? "#fff4b0" : st.body;
    ctx.beginPath();
    ctx.ellipse(p.x, cy, r * 0.6, r * 0.78, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = t.flash ? "#fff" : st.dark;
    ctx.beginPath();
    ctx.arc(p.x, cy - r * 0.7, r * 0.42, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.3)";
    ctx.lineWidth = v.tw * 0.02;
    ctx.beginPath();
    ctx.ellipse(p.x, cy, r * 0.6, r * 0.78, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  if (t.hpFrac < 1) {
    const barY = drew ? p.y - pixelSize - 6 - bob : cy - r * 1.4;
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(p.x - r * 0.6, barY, r * 1.2, 4);
    ctx.fillStyle = t.hpFrac > 0.4 ? "#5fd35f" : "#e04a4a";
    ctx.fillRect(p.x - r * 0.6, barY, r * 1.2 * t.hpFrac, 4);
  }
}

// ---------------------------------------------------------------------------
// Effects: particles, projectiles, screen shake
// ---------------------------------------------------------------------------

type PKind = "smoke" | "debris" | "spark" | "flash" | "ring" | "coin" | "text";

interface Particle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  max: number;
  kind: PKind;
  size: number;
  color: string;
  rot: number;
  vrot: number;
  label?: string;
  loot?: "gold" | "elixir";
}

/** screen-space coin that homes toward the resource bar (collect feedback). */
interface Flyer {
  x: number;
  y: number;
  tx: number;
  ty: number;
  t: number;
  dur: number;
  delay: number;
  color: string;
  lift: number;
  loot: "gold" | "elixir";
}

interface Shot {
  kind: "ball" | "arrow";
  fx: number;
  fy: number;
  tx: number;
  ty: number;
  t: number;
  dur: number;
}

const GRAV = 14; // grid units / s^2 for debris z

export class Fx {
  private parts: Particle[] = [];
  private shots: Shot[] = [];
  private flyers: Flyer[] = [];
  private shakeMag = 0;
  private shakeT = 0;
  private flashT = 0;
  onImpact?: (gx: number, gy: number, kind: "ball" | "arrow") => void;

  shake(mag: number): void {
    this.shakeMag = Math.max(this.shakeMag, mag);
    this.shakeT = Math.max(this.shakeT, 0.35);
  }

  /** full-frame white flash, e.g. when the town hall falls. */
  bang(): void {
    this.flashT = 0.5;
  }

  /** floating combat text that rises and fades. */
  damageNumber(gx: number, gy: number, label: string, color = "#ffd0d0"): void {
    this.parts.push({
      x: gx,
      y: gy,
      z: 8,
      vx: 0,
      vy: 0,
      vz: 7,
      life: 0.7,
      max: 0.7,
      kind: "text",
      size: 0.34,
      color,
      rot: 0,
      vrot: 0,
      label,
    });
  }

  /** spawn coins that fly from a world point to a screen-space UI target. */
  flyToBar(sx: number, sy: number, tx: number, ty: number, res: "gold" | "elixir", n = 6): void {
    const color = res === "gold" ? "#f5c518" : "#c45cff";
    for (let i = 0; i < n; i++) {
      this.flyers.push({
        x: sx,
        y: sy,
        tx,
        ty,
        t: 0,
        dur: 0.5 + hash2(i, (sx * 7) | 0) * 0.18,
        delay: i * 0.05,
        color,
        lift: 40 + hash2(i, (sy * 3) | 0) * 50,
        loot: res,
      });
    }
  }

  boom(gx: number, gy: number, color = "#9a7b4a"): void {
    this.shake(8);
    this.parts.push({ x: gx, y: gy, z: 0, vx: 0, vy: 0, vz: 0, life: 0.18, max: 0.18, kind: "flash", size: 1.4, color: "#fff2c0", rot: 0, vrot: 0 });
    this.parts.push({ x: gx, y: gy, z: 0, vx: 0, vy: 0, vz: 0, life: 0.5, max: 0.5, kind: "ring", size: 0.3, color: "rgba(255,200,120,0.8)", rot: 0, vrot: 0 });
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + hash2(i, gx * 31) * 0.6;
      this.parts.push({ x: gx, y: gy, z: 6, vx: Math.cos(a) * 2.4, vy: Math.sin(a) * 2.4, vz: 9 + hash2(i, gy) * 6, life: 0.7, max: 0.7, kind: "debris", size: 0.16, color, rot: hash2(i, 7) * 6, vrot: 6 });
    }
    for (let i = 0; i < 6; i++) {
      const a = hash2(i + 9, gx) * Math.PI * 2;
      this.parts.push({ x: gx, y: gy, z: 8, vx: Math.cos(a) * 0.6, vy: Math.sin(a) * 0.6, vz: 5, life: 1.1, max: 1.1, kind: "smoke", size: 0.4, color: "rgba(70,60,55,0.7)", rot: 0, vrot: 0 });
    }
  }

  spark(gx: number, gy: number, color = "#fff2a0"): void {
    for (let i = 0; i < 3; i++) {
      const a = hash2(i, (gx * 17 + gy * 7) | 0) * Math.PI * 2;
      this.parts.push({ x: gx, y: gy, z: 4, vx: Math.cos(a) * 1.6, vy: Math.sin(a) * 1.6, vz: 3, life: 0.25, max: 0.25, kind: "spark", size: 0.12, color, rot: 0, vrot: 0 });
    }
  }

  muzzle(gx: number, gy: number): void {
    this.parts.push({ x: gx, y: gy, z: 6, vx: 0, vy: 0, vz: 0, life: 0.12, max: 0.12, kind: "flash", size: 0.7, color: "#ffd27a", rot: 0, vrot: 0 });
  }

  /** celebratory burst of coins/elixir blobs when a producer is collected. */
  coinBurst(gx: number, gy: number, res: "gold" | "elixir", n = 7): void {
    const color = res === "gold" ? "#f5c518" : "#c45cff";
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + hash2(i, (gx * 13) | 0);
      this.parts.push({
        x: gx,
        y: gy,
        z: 10,
        vx: Math.cos(a) * 0.7,
        vy: Math.sin(a) * 0.7,
        vz: 11 + hash2(i, gy | 0) * 6,
        life: 0.85,
        max: 0.85,
        kind: "coin",
        size: 0.09,
        color,
        rot: 0,
        vrot: 0,
        loot: res,
      });
    }
  }

  shoot(kind: "ball" | "arrow", fx: number, fy: number, tx: number, ty: number): void {
    const dist = Math.hypot(tx - fx, ty - fy);
    this.shots.push({ kind, fx, fy, tx, ty, t: 0, dur: Math.max(0.15, dist / (kind === "ball" ? 11 : 16)) });
  }

  update(dt: number): void {
    for (const p of this.parts) {
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      p.rot += p.vrot * dt;
      if (p.kind === "debris") {
        p.vz -= GRAV * dt;
        if (p.z < 0) p.life = 0;
      }
      if (p.kind === "smoke") {
        p.size += dt * 0.5;
        p.vz *= 0.96;
      }
      if (p.kind === "coin") p.vz -= GRAV * 0.6 * dt;
      if (p.kind === "text") p.vz *= 0.92;
    }
    this.parts = this.parts.filter((p) => p.life > 0);

    for (const f of this.flyers) f.t += dt;
    this.flyers = this.flyers.filter((f) => f.t < f.delay + f.dur);

    if (this.flashT > 0) this.flashT -= dt;

    for (const s of this.shots) {
      s.t += dt;
      if (s.t >= s.dur) {
        this.onImpact?.(s.tx, s.ty, s.kind);
      }
    }
    this.shots = this.shots.filter((s) => s.t < s.dur);

    if (this.shakeT > 0) {
      this.shakeT -= dt;
      this.shakeMag *= 0.86;
    } else {
      this.shakeMag = 0;
    }
  }

  beginShake(ctx: CanvasRenderingContext2D, time: number): void {
    ctx.save();
    if (this.shakeT > 0) {
      const m = this.shakeMag;
      ctx.translate(Math.sin(time * 80) * m, Math.cos(time * 67) * m);
    }
  }

  endShake(ctx: CanvasRenderingContext2D): void {
    ctx.restore();
  }

  draw(ctx: CanvasRenderingContext2D, v: IsoView): void {
    for (const p of this.parts) {
      const sp = project(v, p.x, p.y);
      const py = sp.y - p.z;
      const a = Math.max(0, p.life / p.max);
      if (p.kind === "flash") {
        const r = p.size * v.tw;
        const g = ctx.createRadialGradient(sp.x, py, 0, sp.x, py, r);
        g.addColorStop(0, p.color);
        g.addColorStop(1, "rgba(255,255,255,0)");
        ctx.globalAlpha = a;
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(sp.x, py, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      } else if (p.kind === "ring") {
        const r = (1 - a) * p.size * v.tw * 4 + v.tw * 0.1;
        ctx.globalAlpha = a;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = v.tw * 0.04;
        ctx.beginPath();
        ctx.ellipse(sp.x, sp.y, r, r * 0.5, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      } else if (p.kind === "smoke") {
        ctx.globalAlpha = a * 0.7;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(sp.x, py, p.size * v.tw, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      } else if (p.kind === "coin") {
        const size = Math.max(p.size * v.tw * 4.2, 14);
        ctx.globalAlpha = Math.min(1, a * 1.4);
        const drew = p.loot
          ? drawKenney(ctx, RESOURCE_PIXEL[p.loot], sp.x, py, size, { alpha: Math.min(1, a * 1.4) })
          : false;
        if (!drew) {
          const r = p.size * v.tw;
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.arc(sp.x, py, r, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = "rgba(255,255,255,0.5)";
          ctx.beginPath();
          ctx.arc(sp.x - r * 0.3, py - r * 0.3, r * 0.35, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      } else if (p.kind === "debris") {
        ctx.save();
        ctx.translate(sp.x, py);
        ctx.rotate(p.rot);
        ctx.globalAlpha = a;
        ctx.fillStyle = p.color;
        const s = p.size * v.tw;
        ctx.fillRect(-s / 2, -s / 2, s, s);
        ctx.restore();
        ctx.globalAlpha = 1;
      } else if (p.kind === "text") {
        ctx.globalAlpha = Math.min(1, a * 1.6);
        ctx.font = `800 ${Math.round(p.size * v.tw)}px "Trebuchet MS", sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.lineWidth = v.tw * 0.03;
        ctx.strokeStyle = "rgba(0,0,0,0.6)";
        ctx.strokeText(p.label ?? "", sp.x, py);
        ctx.fillStyle = p.color;
        ctx.fillText(p.label ?? "", sp.x, py);
        ctx.globalAlpha = 1;
      } else {
        // spark
        ctx.globalAlpha = a;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = v.tw * 0.04;
        ctx.beginPath();
        ctx.moveTo(sp.x, py);
        ctx.lineTo(sp.x - p.vx * v.tw * 0.05, py - p.vy * v.th * 0.05 + p.vz * 0.05);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    for (const s of this.shots) {
      const k = s.t / s.dur;
      const gx = s.fx + (s.tx - s.fx) * k;
      const gy = s.fy + (s.ty - s.fy) * k;
      const p = project(v, gx, gy);
      const arc = Math.sin(k * Math.PI) * v.tw * (s.kind === "ball" ? 0.9 : 0.4);
      const py = p.y - arc;
      if (s.kind === "ball") {
        ctx.fillStyle = "#1c1c22";
        ctx.beginPath();
        ctx.arc(p.x, py, v.tw * 0.1, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.3)";
        ctx.beginPath();
        ctx.arc(p.x - v.tw * 0.03, py - v.tw * 0.03, v.tw * 0.03, 0, Math.PI * 2);
        ctx.fill();
      } else {
        const from = project(v, s.fx, s.fy);
        const dx = p.x - from.x;
        const dy = p.y - arc - from.y;
        const len = Math.hypot(dx, dy) || 1;
        ctx.strokeStyle = "#d9c089";
        ctx.lineWidth = v.tw * 0.03;
        ctx.beginPath();
        ctx.moveTo(p.x, py);
        ctx.lineTo(p.x - (dx / len) * v.tw * 0.3, py - (dy / len) * v.tw * 0.3);
        ctx.stroke();
      }
    }

    // screen-space coins homing toward the resource bar
    for (const f of this.flyers) {
      const k = clamp01((f.t - f.delay) / f.dur);
      if (f.t < f.delay) continue;
      const ease = k * k * (3 - 2 * k);
      const x = f.x + (f.tx - f.x) * ease;
      const y = f.y + (f.ty - f.y) * ease - Math.sin(k * Math.PI) * f.lift;
      const size = Math.max(v.tw * 0.28 * (1 - k * 0.25), 12);
      const alpha = 1 - k * k;
      if (!drawKenney(ctx, RESOURCE_PIXEL[f.loot], x, y, size, { alpha })) {
        const r = v.tw * 0.09 * (1 - k * 0.35);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = f.color;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.55)";
        ctx.beginPath();
        ctx.arc(x - r * 0.3, y - r * 0.3, r * 0.35, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }

    // full-frame white flash (town hall destruction etc.)
    if (this.flashT > 0) {
      ctx.globalAlpha = Math.min(0.7, this.flashT);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      ctx.globalAlpha = 1;
    }
  }
}
