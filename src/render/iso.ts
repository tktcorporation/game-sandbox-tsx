// Isometric procedural renderer — zero external assets.
// Projects the 16x16 grid into a 2.5D diamond and draws every building / troop
// as a shaded extruded prism with per-type structure, lighting and effects.
//
// All coordinates are in *device pixels* (callers size the canvas with dpr and
// draw without ctx.scale, matching the project's existing convention).

import { GRID_SIZE } from "../game/buildings";

export const GRID = GRID_SIZE;

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

/** Fit the whole grid (plus headroom for tall buildings) inside W x H. */
export function makeView(
  W: number,
  H: number,
  opts?: { lift?: number; cam?: Camera },
): IsoView {
  const margin = 0.94;
  const twByW = (W * margin) / GRID;
  // diamond height is GRID*th = GRID*tw/2; reserve ~1.7 tiles of vertical
  // headroom for tall structures rising above the back row.
  const twByH = (H * margin) / (GRID / 2 + 1.7);
  const zoom = opts?.cam?.zoom ?? 1;
  const tw = Math.min(twByW, twByH) * zoom;
  const th = tw / 2;
  const diamondH = GRID * th;
  const ox = W / 2 + (opts?.cam?.panX ?? 0);
  const oy = (H - diamondH) / 2 + tw * (opts?.lift ?? 0.85) + (opts?.cam?.panY ?? 0);
  return { ox, oy, tw, th };
}

/** soft dark vignette over the whole frame — cheap cinematic depth. */
export function drawVignette(ctx: CanvasRenderingContext2D, W: number, H: number): void {
  const g = ctx.createRadialGradient(W / 2, H * 0.42, Math.min(W, H) * 0.3, W / 2, H * 0.5, Math.max(W, H) * 0.75);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, "rgba(0,0,0,0.34)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

export function project(v: IsoView, gx: number, gy: number): Pt {
  return { x: v.ox + (gx - gy) * (v.tw / 2), y: v.oy + (gx + gy) * (v.th / 2) };
}

export function unproject(v: IsoView, sx: number, sy: number): { gx: number; gy: number } {
  const a = (sx - v.ox) / (v.tw / 2);
  const b = (sy - v.oy) / (v.th / 2);
  return { gx: (a + b) / 2, gy: (b - a) / 2 };
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

function centroid(pts: Pt[]): Pt {
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p.x;
    y += p.y;
  }
  return { x: x / pts.length, y: y / pts.length };
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
  const lightG = hostile ? "#6f9a4e" : "#7cc15a";
  const darkG = hostile ? "#5d8741" : "#69ad49";
  const edge = hostile ? "#3f5e2c" : "#4f7d32";
  const edgeDark = hostile ? "#2c4420" : "#37571f";

  // floating-island base: extrude the whole plate downward for depth
  const T = project(v, 0, 0);
  const R = project(v, GRID, 0);
  const B = project(v, GRID, GRID);
  const L = project(v, 0, GRID);
  const depth = v.tw * 0.55;
  const down = (p: Pt): Pt => ({ x: p.x, y: p.y + depth });
  fillPoly(ctx, [L, B, down(B), down(L)], edgeDark);
  fillPoly(ctx, [B, R, down(R), down(B)], edge);

  // grass checker
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      const a = project(v, gx, gy);
      const b = project(v, gx + 1, gy);
      const c = project(v, gx + 1, gy + 1);
      const d = project(v, gx, gy + 1);
      const base = (gx + gy) % 2 === 0 ? lightG : darkG;
      const jitter = hash2(gx, gy) * 0.08 - 0.04;
      fillPoly(ctx, [a, b, c, d], shade(base, 1 + jitter));
    }
  }

  // subtle grid lines
  ctx.strokeStyle = "rgba(0,0,0,0.06)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= GRID; i++) {
    const p0 = project(v, i, 0);
    const p1 = project(v, i, GRID);
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(p1.x, p1.y);
    const q0 = project(v, 0, i);
    const q1 = project(v, GRID, i);
    ctx.moveTo(q0.x, q0.y);
    ctx.lineTo(q1.x, q1.y);
    ctx.stroke();
  }

  // bright top rim of the plate
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.lineWidth = 2;
  poly(ctx, [T, R, B, L]);
  ctx.stroke();
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
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      if (occupied.has(`${gx},${gy}`)) continue;
      const r = hash2(gx * 7 + 1, gy * 13 + 3);
      if (r > 0.12) continue; // sparse
      const kind = r < 0.06 ? "tree" : r < 0.09 ? "bush" : "rock";
      out.push({
        gx: gx + 0.5,
        gy: gy + 0.5,
        depth: gx + gy + 0.5,
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
}

/** corners of a box: ground + lifted-top, given footprint + height in px. */
type BaseCorners = { T: Pt; R: Pt; B: Pt; L: Pt; Tt: Pt; Rt: Pt; Bt: Pt; Lt: Pt };
type Corners = BaseCorners & { tlw: () => number };

function boxCorners(v: IsoView, x: number, y: number, size: number, hPx: number, lift = 0): BaseCorners {
  const g = (gx: number, gy: number): Pt => {
    const p = project(v, gx, gy);
    return { x: p.x, y: p.y - lift };
  };
  const T = g(x, y);
  const R = g(x + size, y);
  const B = g(x + size, y + size);
  const L = g(x, y + size);
  const up = (p: Pt): Pt => ({ x: p.x, y: p.y - hPx });
  return { T, R, B, L, Tt: up(T), Rt: up(R), Bt: up(B), Lt: up(L) };
}

function drawBox(
  ctx: CanvasRenderingContext2D,
  c: Corners,
  color: string,
  outline = true,
): void {
  fillPoly(ctx, [c.L, c.B, c.Bt, c.Lt], shade(color, 0.7)); // left wall
  fillPoly(ctx, [c.B, c.R, c.Rt, c.Bt], shade(color, 0.84)); // right wall
  fillPoly(ctx, [c.Tt, c.Rt, c.Bt, c.Lt], shade(color, 1.12)); // top
  if (outline) {
    ctx.strokeStyle = "rgba(0,0,0,0.32)";
    ctx.lineWidth = Math.max(1, c.tlw());
    poly(ctx, [c.Tt, c.Rt, c.R, c.B, c.L, c.Lt]);
    ctx.stroke();
  }
}

export function drawBuilding(ctx: CanvasRenderingContext2D, v: IsoView, d: BuildingDraw): void {
  const sp = SPRITES[d.type] ?? FALLBACK;
  const levelScale = 1 + (Math.min(d.level, 10) - 1) * 0.05;
  const baseH = sp.h * v.tw * levelScale * (1 + (d.squash ?? 0));
  const lw = v.tw * 0.03;

  // ground shadow
  const sh = boxCorners(v, d.x, d.y, d.size, 0);
  ctx.save();
  ctx.globalAlpha = 0.22;
  fillPoly(
    ctx,
    [
      { x: sh.T.x + v.tw * 0.12, y: sh.T.y + v.th * 0.18 },
      { x: sh.R.x + v.tw * 0.18, y: sh.R.y + v.th * 0.18 },
      { x: sh.B.x + v.tw * 0.18, y: sh.B.y + v.th * 0.22 },
      { x: sh.L.x + v.tw * 0.12, y: sh.L.y + v.th * 0.22 },
    ],
    "#000",
  );
  ctx.restore();

  const c = Object.assign(boxCorners(v, d.x, d.y, d.size, baseH), { tlw: () => lw }) as Corners;
  drawBox(ctx, c, sp.color);

  // family-specific structure on the top face
  drawStructure(ctx, v, d, sp, baseH);

  // ambient idle: chimney smoke on halls/barracks
  if (d.ambient && sp.fam === "hall") {
    const tc = boxCorners(v, d.x, d.y, d.size, baseH);
    const cc = centroid([tc.Tt, tc.Rt, tc.Bt, tc.Lt]);
    drawSmoke(ctx, cc.x + v.tw * 0.16, cc.y - v.tw * 0.18, v.tw, d.time, d.x * 7 + d.y * 13);
  }

  // selection highlight (village)
  if (d.selected) {
    ctx.strokeStyle = "#ffe06a";
    ctx.lineWidth = v.tw * 0.06;
    poly(ctx, [c.T, c.R, c.B, c.L]);
    ctx.stroke();
  }

  // hp bar (battle)
  if (d.hpFrac !== undefined && d.hpFrac < 1) {
    drawBar(ctx, c.Tt, v.tw * d.size * 0.6, d.hpFrac);
  }

  // level badge (village)
  if (d.showLevel && !d.constructing) {
    drawBadge(ctx, c.B, String(d.level), v.tw);
  }

  // collect icon bobbing above
  if (d.collect && !d.constructing) {
    const top = centroid([c.Tt, c.Rt, c.Bt, c.Lt]);
    const bob = Math.sin(d.time * 3) * v.tw * 0.07;
    drawCollect(ctx, top.x, top.y - v.tw * 0.35 + bob, v.tw, d.collect);
  }

  // construction overlay
  if (d.constructing) {
    ctx.save();
    ctx.globalAlpha = 0.5;
    fillPoly(ctx, [c.Tt, c.Rt, c.Bt, c.Lt], "#0b1410");
    fillPoly(ctx, [c.L, c.B, c.Bt, c.Lt], "#0b1410");
    fillPoly(ctx, [c.B, c.R, c.Rt, c.Bt], "#0b1410");
    ctx.restore();
    const top = centroid([c.Tt, c.Rt, c.Bt, c.Lt]);
    drawHammer(ctx, top.x, top.y - v.tw * 0.1, v.tw, d.time);
    if (d.remainingLabel) drawLabel(ctx, top.x, top.y + v.tw * 0.18, d.remainingLabel, v.tw);
  }
}

function drawStructure(
  ctx: CanvasRenderingContext2D,
  v: IsoView,
  d: BuildingDraw,
  sp: SpriteDef,
  baseH: number,
): void {
  const lw = v.tw * 0.03;
  const tlw = () => lw;
  const top = (x: number, y: number, size: number, h: number) =>
    Object.assign(boxCorners(v, x, y, size, h, baseH), { tlw }) as Corners;

  switch (sp.fam) {
    case "hall": {
      // pitched roof prism
      const ins = d.size * 0.16;
      const r = top(d.x + ins, d.y + ins, d.size - ins * 2, baseH * 0.45);
      drawBox(ctx, r, sp.roof);
      if (sp.trim) {
        // golden ridge dot + flag
        const c = centroid([r.Tt, r.Rt, r.Bt, r.Lt]);
        ctx.fillStyle = sp.trim;
        ctx.beginPath();
        ctx.arc(c.x, c.y, v.tw * 0.07, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#6b4a2a";
        ctx.lineWidth = v.tw * 0.03;
        ctx.beginPath();
        ctx.moveTo(c.x, c.y);
        ctx.lineTo(c.x, c.y - v.tw * 0.34);
        ctx.stroke();
        const wave = Math.sin(d.time * 4) * v.tw * 0.03;
        fillPoly(ctx, [
          { x: c.x, y: c.y - v.tw * 0.34 },
          { x: c.x + v.tw * 0.18, y: c.y - v.tw * 0.3 + wave },
          { x: c.x, y: c.y - v.tw * 0.24 },
        ], "#e23b3b");
      }
      break;
    }
    case "tower": {
      // battlement cap: smaller box + notches
      const ins = d.size * 0.2;
      const cap = top(d.x + ins, d.y + ins, d.size - ins * 2, baseH * 0.22);
      drawBox(ctx, cap, sp.roof);
      // arrow slit on front-right wall
      const m = centroid([cap.B, cap.R, cap.Rt, cap.Bt]);
      ctx.fillStyle = "rgba(0,0,0,0.5)";
      ctx.fillRect(m.x - v.tw * 0.02, m.y - v.tw * 0.18, v.tw * 0.04, v.tw * 0.18);
      break;
    }
    case "tent": {
      const ins = d.size * 0.1;
      const r = top(d.x + ins, d.y + ins, d.size - ins * 2, baseH * 0.7);
      drawBox(ctx, r, sp.roof);
      break;
    }
    case "cannon": {
      // pivot dome + barrel pointing up-right
      const tc = boxCorners(v, d.x, d.y, d.size, baseH);
      const cen = centroid([tc.Tt, tc.Bt, tc.Rt, tc.Lt]);
      ctx.fillStyle = "#2c2c33";
      ctx.beginPath();
      ctx.arc(cen.x, cen.y, v.tw * 0.16, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#1a1a1f";
      ctx.lineCap = "round";
      ctx.lineWidth = v.tw * 0.13;
      ctx.beginPath();
      ctx.moveTo(cen.x, cen.y);
      ctx.lineTo(cen.x + v.tw * 0.34, cen.y - v.tw * 0.2);
      ctx.stroke();
      ctx.lineCap = "butt";
      break;
    }
    case "tank": {
      const tc = boxCorners(v, d.x, d.y, d.size, baseH);
      const cen = centroid([tc.Tt, tc.Bt, tc.Rt, tc.Lt]);
      // domed liquid top
      ctx.fillStyle = shade(sp.roof, 1.05);
      ctx.beginPath();
      ctx.ellipse(cen.x, cen.y, v.tw * d.size * 0.32, v.tw * d.size * 0.17, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      ctx.beginPath();
      ctx.ellipse(cen.x - v.tw * 0.07, cen.y - v.tw * 0.03, v.tw * 0.07, v.tw * 0.035, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "mine": {
      const tc = boxCorners(v, d.x, d.y, d.size, baseH);
      const cen = centroid([tc.Tt, tc.Bt, tc.Rt, tc.Lt]);
      // ore pile
      fillPoly(ctx, [
        { x: cen.x - v.tw * 0.2, y: cen.y + v.tw * 0.04 },
        { x: cen.x, y: cen.y - v.tw * 0.2 },
        { x: cen.x + v.tw * 0.2, y: cen.y + v.tw * 0.04 },
      ], sp.roof);
      ctx.fillStyle = "#fff2b0";
      ctx.beginPath();
      ctx.arc(cen.x - v.tw * 0.05, cen.y - v.tw * 0.04, v.tw * 0.03, 0, Math.PI * 2);
      ctx.arc(cen.x + v.tw * 0.06, cen.y, v.tw * 0.025, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "storage": {
      const tc = boxCorners(v, d.x, d.y, d.size, baseH);
      const cen = centroid([tc.Tt, tc.Bt, tc.Rt, tc.Lt]);
      ctx.fillStyle = sp.roof;
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.ellipse(cen.x, cen.y - i * v.tw * 0.07, v.tw * 0.16, v.tw * 0.07, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case "wall": {
      const cn = Object.assign(boxCorners(v, d.x, d.y, d.size, baseH), { tlw }) as Corners;
      // brick groove line across the top
      ctx.strokeStyle = "rgba(0,0,0,0.25)";
      ctx.lineWidth = v.tw * 0.02;
      const a = centroid([cn.Tt, cn.Lt]);
      const b = centroid([cn.Rt, cn.Bt]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
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
  // soft glow
  const grd = ctx.createRadialGradient(x, y, 0, x, y, r * 2.2);
  grd.addColorStop(0, c.kind === "gold" ? "rgba(245,197,24,0.5)" : "rgba(196,92,255,0.5)");
  grd.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = grd;
  ctx.beginPath();
  ctx.arc(x, y, r * 2.2, 0, Math.PI * 2);
  ctx.fill();

  if (c.kind === "gold") {
    ctx.fillStyle = "#f5c518";
    ctx.strokeStyle = "#9a7400";
    ctx.lineWidth = tw * 0.02;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#b8860b";
    ctx.font = `800 ${Math.round(tw * 0.2)}px "Trebuchet MS", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("$", x, y + 0.5);
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
  ctx.strokeStyle = "#6b4a2a";
  ctx.lineWidth = tw * 0.05;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, tw * 0.28);
  ctx.stroke();
  ctx.fillStyle = "#9a9a9a";
  ctx.fillRect(-tw * 0.12, -tw * 0.06, tw * 0.24, tw * 0.12);
  ctx.restore();
  ctx.lineCap = "butt";
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
  const c = boxCorners(v, b.x, b.y, b.size, sp.h * v.tw);
  return pointInPoly(sx, sy, [c.Tt, c.Rt, c.R, c.B, c.L, c.Lt]);
}

function pointInPoly(px: number, py: number, pts: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x;
    const yi = pts[i].y;
    const xj = pts[j].x;
    const yj = pts[j].y;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
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

  // shadow
  ctx.fillStyle = "rgba(0,0,0,0.25)";
  ctx.beginPath();
  ctx.ellipse(p.x, p.y, r * 0.7, r * 0.32, 0, 0, Math.PI * 2);
  ctx.fill();

  // body
  ctx.fillStyle = t.flash ? "#fff4b0" : st.body;
  ctx.beginPath();
  ctx.ellipse(p.x, cy, r * 0.6, r * 0.78, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = t.flash ? "#fff" : st.dark;
  ctx.beginPath();
  ctx.arc(p.x, cy - r * 0.7, r * 0.42, 0, Math.PI * 2); // head
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.3)";
  ctx.lineWidth = v.tw * 0.02;
  ctx.beginPath();
  ctx.ellipse(p.x, cy, r * 0.6, r * 0.78, 0, 0, Math.PI * 2);
  ctx.stroke();

  if (t.hpFrac < 1) {
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(p.x - r * 0.6, cy - r * 1.4, r * 1.2, 4);
    ctx.fillStyle = t.hpFrac > 0.4 ? "#5fd35f" : "#e04a4a";
    ctx.fillRect(p.x - r * 0.6, cy - r * 1.4, r * 1.2 * t.hpFrac, 4);
  }
}

// ---------------------------------------------------------------------------
// Effects: particles, projectiles, screen shake
// ---------------------------------------------------------------------------

type PKind = "smoke" | "debris" | "spark" | "flash" | "ring" | "coin";

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
  private shakeMag = 0;
  private shakeT = 0;
  onImpact?: (gx: number, gy: number, kind: "ball" | "arrow") => void;

  shake(mag: number): void {
    this.shakeMag = Math.max(this.shakeMag, mag);
    this.shakeT = Math.max(this.shakeT, 0.35);
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
    }
    this.parts = this.parts.filter((p) => p.life > 0);

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
        const r = p.size * v.tw;
        ctx.globalAlpha = Math.min(1, a * 1.4);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(sp.x, py, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.5)";
        ctx.beginPath();
        ctx.arc(sp.x - r * 0.3, py - r * 0.3, r * 0.35, 0, Math.PI * 2);
        ctx.fill();
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
  }
}
