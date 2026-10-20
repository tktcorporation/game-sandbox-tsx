import * as THREE from "three";
import type { Box } from "../sim/map";
import { PAL } from "./models";

/*
 * Architectural trim: the detail between 0.1 and 1 m that tells a 10 m wall from a 10 cm block.
 * A storey band under each floor, the joints of precast panels, a lintel over each opening and a
 * sill under each window, coping along roof edges and low walls, ribs on steel cladding, and on
 * the outside of larger buildings a downpipe, an air-conditioning unit or a sign. All of it is
 * flat-painted boxes standing a few centimetres off the face, so the silhouettes stay clean; it
 * casts no shadow and is drawn only in the chunks near the camera (the tier's `trimFar`).
 * Everything is placed from the box's own numbers, so it is the same in every run.
 */

/** What trim needs to know about where a box stands. */
export interface TrimSite {
  /** The floor a face whose bottom edge is at `bottom` rests on at (x, z): a box top or the ground. */
  floor(x: number, z: number, bottom: number): number;
  /** Light left at (x, y, z) by what covers it: 1 under open sky. */
  cover(x: number, y: number, z: number): number;
  /** The terrain's height at (x, z). */
  ground(x: number, z: number): number;
}

export const TRIM = {
  /** How far a storey band, a lintel and a coping stand off the face. */
  band: 0.05,
  /** How far a panel joint stands off the face: a dark line, not a ridge. */
  joint: 0.012,
  /** How far a window sill stands off the face. */
  sill: 0.08,
  /** Precast panels' width along a concrete wall, and the steel cladding's rib spacing. */
  panel: 3,
  rib: 0.6,
  /** A wall piece shorter than this over its floor is a low wall or a window's breast: it gets a cap. */
  low: 1.5,
  /** A wall piece standing this far over its floor spans an opening: it gets a lintel. */
  lintel: 0.6,
  /** A wall piece at least this tall gets a storey band, and joints if it is this long. */
  tall: 2.2,
  jointLen: 3.2,
  /** The least length and height of a wall piece that may carry a fitting. */
  fitLen: 3.5,
  fitTall: 2.6,
  /** A tower's storey, for its bands. */
  storey: 3.4,
} as const;

/** One piece of trim: a box centred at (x, y, z), of size sx by sy by sz, painted `color`. */
export interface TrimPiece {
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  color: number;
}

const tone = new Map<string, number>();
/** `color` darkened (k < 1) or lightened (k > 1), clamped. */
function toned(color: number, k: number): number {
  const key = `${color}:${k}`;
  let v = tone.get(key);
  if (v === undefined) {
    const c = new THREE.Color(color);
    v = new THREE.Color(Math.min(1, c.r * k), Math.min(1, c.g * k), Math.min(1, c.b * k)).getHex();
    tone.set(key, v);
  }
  return v;
}

/** A number in 0..1 from a box's corners and a salt: its fittings' dice. */
function dice(b: Box, salt: number): number {
  const v = Math.sin(b.x0 * 12.9898 + b.z0 * 78.233 + b.y0 * 37.719 + b.h * 4.1 + salt * 19.19) * 43758.5453;
  return v - Math.floor(v);
}

/** Adds the trim for box `b` to `out`, as boxes placed in the world. */
export function trimBox(b: Box, out: TrimPiece[], site: TrimSite): void {
  const put = (x: number, y: number, z: number, sx: number, sy: number, sz: number, color: number) => {
    if (sx > 0 && sy > 0 && sz > 0) out.push({ x, y, z, sx, sy, sz, color });
  };
  const w = b.x1 - b.x0;
  const d = b.z1 - b.z0;
  const hgt = b.h - b.y0;
  const cx = (b.x0 + b.x1) / 2;
  const cz = (b.z0 + b.z1) / 2;
  const alongX = w >= d;
  const len = alongX ? w : d;
  const thick = alongX ? d : w;
  const a0 = alongX ? b.x0 : b.z0;
  const a1 = alongX ? b.x1 : b.z1;
  /** A strip along the box's length, centred at `a`, through its thickness and `out` proud of both faces. */
  const along = (a: number, l: number, y: number, hy: number, proud: number, color: number) =>
    alongX ? put(a, y, cz, l, hy, thick + 2 * proud, color) : put(cx, y, a, thick + 2 * proud, hy, l, color);

  if (b.kind === "wall") {
    if (len < 0.8 || hgt < 0.3) return;
    const color = b.tint === 1 ? PAL.concreteDark : b.tint === 2 ? PAL.rust : b.tint === 3 ? PAL.stone : PAL.concrete;
    const mid = (a0 + a1) / 2;
    // The parapet round a roof: a pale coping along its top.
    if (b.tint === 1) {
      along(mid, len + 0.06, b.h + 0.03, 0.06, TRIM.band, PAL.concrete);
      return;
    }
    const lift = b.y0 - site.floor(cx, cz, b.y0);
    if (lift > TRIM.lintel) {
      // Over a door or a window: the lintel, a little wider than the opening.
      if (len <= 6) along(mid, len + 0.24, b.y0 + 0.09, 0.18, TRIM.band, toned(color, 0.86));
      // The storey band runs on over the opening.
      if (hgt >= 0.4 && b.tint !== 3) along(mid, len, b.h - 0.08, 0.16, 0.04, toned(color, 0.84));
      return;
    }
    if (lift > 0.25) return;
    if (hgt <= TRIM.low) {
      // A window's breast (narrow, between two jambs) gets a sill reaching into them; a low wall a coping.
      const sill = len <= 2.6 && b.tint !== 3;
      along(mid, len + (sill ? 0.2 : 0.04), b.h + 0.03, 0.06, sill ? TRIM.sill : TRIM.band, b.tint === 3 ? toned(color, 0.84) : toned(color, 1.08));
      return;
    }
    if (hgt < TRIM.tall || b.tint === 3) return;
    // The storey band under the floor or roof above.
    along(mid, len, b.h - 0.08, 0.16, 0.04, toned(color, 0.84));
    if (b.tint !== 0) return;
    // Precast panels: a joint every few metres, on the same world lines in every piece of a wall.
    if (len >= TRIM.jointLen)
      for (let a = Math.ceil((a0 + 0.5) / TRIM.panel) * TRIM.panel; a < a1 - 0.5; a += TRIM.panel) {
        const y0 = b.y0 + (b.y0 === 0 ? 0.5 : 0);
        const y1 = b.h - 0.16;
        if (alongX) put(a, (y0 + y1) / 2, cz, 0.05, y1 - y0, thick + 2 * TRIM.joint, toned(color, 0.8));
        else put(cx, (y0 + y1) / 2, a, thick + 2 * TRIM.joint, y1 - y0, 0.05, toned(color, 0.8));
      }
    if (len < TRIM.fitLen || hgt < TRIM.fitTall) return;
    fittings(b, site, put, { alongX, cx, cz, a0, a1, len, thick, hgt });
    return;
  }

  if (b.kind === "tower") {
    if (hgt < 4 || w < 3 || d < 3) return;
    const y1 = b.h - 0.6;
    for (let y = b.y0 + TRIM.storey; y < b.h - 1; y += TRIM.storey) put(cx, y, cz, w + 0.08, 0.14, d + 0.08, toned(PAL.concrete, 0.84));
    for (let x = Math.ceil((b.x0 + 0.5) / TRIM.panel) * TRIM.panel; x < b.x1 - 0.5; x += TRIM.panel) put(x, (b.y0 + y1) / 2, cz, 0.05, y1 - b.y0, d + 0.024, toned(PAL.concrete, 0.8));
    for (let z = Math.ceil((b.z0 + 0.5) / TRIM.panel) * TRIM.panel; z < b.z1 - 0.5; z += TRIM.panel) put(cx, (b.y0 + y1) / 2, z, w + 0.024, y1 - b.y0, 0.05, toned(PAL.concrete, 0.8));
    return;
  }

  if (b.kind === "steel") {
    // Steel cladding (thin plate standing a storey or more): vertical ribs, as on the containers.
    if (![0, 3, 4].includes(b.tint % 8) || thick > 1 || len < 3 || hgt < 2) return;
    const color = [PAL.rust, PAL.hull, PAL.steel, PAL.teal, PAL.paint][b.tint % 8];
    for (let a = Math.ceil((a0 + 0.2) / TRIM.rib) * TRIM.rib; a < a1 - 0.2; a += TRIM.rib) {
      if (alongX) put(a, b.y0 + hgt / 2, cz, 0.1, hgt - 0.15, thick + 0.08, toned(color, 0.8));
      else put(cx, b.y0 + hgt / 2, a, thick + 0.08, hgt - 0.15, 0.1, toned(color, 0.8));
    }
  }
}

/**
 * The fittings on the outside face of a concrete wall piece: a downpipe from the roof when the
 * piece is the top storey's, an air-conditioning unit, a sign plate on the ground storey. The
 * outside is the face with open sky over the ground in front of it; a wall with sky on both
 * sides (a yard wall) or neither (inside a building) gets none.
 */
function fittings(
  b: Box,
  site: TrimSite,
  put: (x: number, y: number, z: number, sx: number, sy: number, sz: number, color: number) => void,
  g: { alongX: boolean; cx: number; cz: number; a0: number; a1: number; len: number; thick: number; hgt: number },
) {
  const { alongX, cx, cz, a0, a1, len, thick, hgt } = g;
  const probe = (side: number, y: number) => (alongX ? site.cover(cx, y, cz + side * (thick / 2 + 0.6)) : site.cover(cx + side * (thick / 2 + 0.6), y, cz));
  const yMid = b.y0 + 1.5;
  const plus = probe(1, yMid) >= 1;
  const minus = probe(-1, yMid) >= 1;
  if (plus === minus) return;
  const side = plus ? 1 : -1;
  /** A box against the outside face at `a` along the wall, `out` deep, centred at height y. */
  const onFace = (a: number, y: number, along: number, high: number, out: number, gap: number, color: number) => {
    const off = side * (thick / 2 + gap + out / 2);
    if (alongX) put(a, y, cz + off, along, high, out, color);
    else put(cx + off, y, a, out, high, along, color);
  };
  const top = probe(-side, b.h + 1.2) >= 1;
  const pipe = dice(b, 1);
  if (top && pipe < 0.55) {
    const a = pipe < 0.27 ? a0 + 0.35 : a1 - 0.35;
    const ox = alongX ? a : cx + side * (thick / 2 + 0.2);
    const oz = alongX ? cz + side * (thick / 2 + 0.2) : a;
    const foot = site.floor(ox, oz, b.h);
    const head = b.h + 0.3;
    onFace(a, (foot + head) / 2, 0.11, head - foot, 0.11, 0.04, PAL.steel);
    onFace(a, head - 0.12, 0.24, 0.22, 0.2, 0.02, toned(PAL.steel, 0.85));
  }
  if (len >= 4 && dice(b, 2) < 0.35) {
    const a = a0 + len * (0.28 + 0.12 * dice(b, 3));
    const y = b.y0 + Math.min(hgt - 0.7, 2.3);
    onFace(a, y, 0.9, 0.6, 0.34, 0.02, toned(PAL.paint, 0.92));
    onFace(a, y, 0.46, 0.46, 0.03, 0.36, PAL.steel);
  }
  const groundStorey = b.y0 - site.ground(cx, cz) < 0.5;
  if (groundStorey && dice(b, 4) < 0.25) {
    const a = a0 + len * (0.62 + 0.14 * dice(b, 5));
    const color = [PAL.teal, PAL.rust, PAL.paint][Math.floor(dice(b, 6) * 3)];
    onFace(Math.min(a, a1 - 0.9), b.y0 + Math.min(2.6, hgt - 0.5), 1.5, 0.48, 0.04, 0.01, color);
  }
}
