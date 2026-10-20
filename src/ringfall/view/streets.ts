import * as THREE from "three";
import { WORLD } from "../sim/config";
import { LENGTHS, STREETS } from "../sim/streets";
import { terrainHeight } from "../sim/terrain";
import { flat, PAL } from "./models";

/*
 * The streets' surface (sim/streets.ts): asphalt laid over the ground, painted edge lines, and a
 * dashed centre line down the wider ones. Built per chunk with its statics and merged with them.
 */

/** The ground mesh's height at (x, z): its 2 m grid's triangles, as `groundMesh()` in world.ts lays them. */
function meshHeight(x: number, z: number): number {
  const fx = (x - WORLD.x0) / 2;
  const fz = (z - WORLD.z0) / 2;
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  const u = fx - i;
  const v = fz - j;
  const at = (di: number, dj: number) => terrainHeight(WORLD.x0 + (i + di) * 2, WORLD.z0 + (j + dj) * 2);
  if (u + v <= 1) {
    const h00 = at(0, 0);
    return h00 + u * (at(1, 0) - h00) + v * (at(0, 1) - h00);
  }
  const h11 = at(1, 1);
  return h11 + (1 - u) * (at(0, 1) - h11) + (1 - v) * (at(1, 0) - h11);
}

/** How far over the ground each layer lies: the asphalt, then the paint on it. */
const LIFT = 0.07;
const PAINT = 0.11;
/** Metres along a length between the surface's cross-sections. */
const STEP = 1;

/** Adds the triangle p q r ([x, y, z] each), wound to face up whichever way round it was given. */
function tri(out: number[], p: number[], q: number[], r: number[]) {
  const up = (q[2] - p[2]) * (r[0] - p[0]) - (q[0] - p[0]) * (r[2] - p[2]) > 0;
  out.push(...p, ...(up ? q : r), ...(up ? r : q));
}

/** Adds the quad a0 a1 b1 b0 (each [x, z]) at `lift` over the ground. */
function quad(out: number[], a0: number[], a1: number[], b0: number[], b1: number[], lift: number) {
  const v = (p: number[]) => [p[0], meshHeight(p[0], p[1]) + lift, p[1]];
  tri(out, v(a0), v(b0), v(a1));
  tri(out, v(a1), v(b0), v(b1));
}

/**
 * A strip `w` wide whose middle runs `off` metres to the side of the length from `t0` to `t1`
 * metres along it, cut in cross-sections of `cuts` points.
 */
function strip(out: number[], l: (typeof LENGTHS)[number], t0: number, t1: number, off: number, w: number, cuts: number, lift: number) {
  const len = Math.hypot(l.bx - l.ax, l.bz - l.az);
  const ux = (l.bx - l.ax) / len;
  const uz = (l.bz - l.az) / len;
  const at = (t: number, s: number) => [l.ax + ux * t - uz * s, l.az + uz * t + ux * s];
  const n = Math.max(1, Math.ceil((t1 - t0) / STEP));
  for (let k = 0; k < n; k++) {
    const ta = t0 + ((t1 - t0) * k) / n;
    const tb = t0 + ((t1 - t0) * (k + 1)) / n;
    for (let c = 0; c < cuts - 1; c++) {
      const sa = off - w / 2 + (w * c) / (cuts - 1);
      const sb = off - w / 2 + (w * (c + 1)) / (cuts - 1);
      quad(out, at(ta, sa), at(ta, sb), at(tb, sa), at(tb, sb), lift);
    }
  }
}

/** A disc `r` across at (x, z): the asphalt at a street's bend or end, so lengths meet without a gap. */
function disc(out: number[], x: number, z: number, r: number) {
  const N = 16;
  const y = (px: number, pz: number) => meshHeight(px, pz) + LIFT;
  for (let k = 0; k < N; k++) {
    const a = (k / N) * Math.PI * 2;
    const b = ((k + 1) / N) * Math.PI * 2;
    const p = [x + Math.cos(a) * r, z + Math.sin(a) * r];
    const q = [x + Math.cos(b) * r, z + Math.sin(b) * r];
    tri(out, [x, y(x, z), z], [q[0], y(q[0], q[1]), q[1]], [p[0], y(p[0], p[1]), p[1]]);
  }
}

/** The streets' asphalt and paint whose pieces lie inside the box (a chunk), as meshes to merge with its statics. */
export function streetMeshes(box: { x0: number; z0: number; x1: number; z1: number }): THREE.Mesh[] {
  const asphalt: number[] = [];
  const paint: number[] = [];
  const inside = (x: number, z: number) => x >= box.x0 && x < box.x1 && z >= box.z0 && z < box.z1;
  for (const l of LENGTHS) {
    const len = Math.hypot(l.bx - l.ax, l.bz - l.az);
    const h = l.street.half;
    // Each metre of length goes to the chunk its middle lies in.
    for (let t = 0; t < len; t += STEP) {
      const t1 = Math.min(len, t + STEP);
      const mx = l.ax + ((l.bx - l.ax) * (t + t1)) / 2 / len;
      const mz = l.az + ((l.bz - l.az) * (t + t1)) / 2 / len;
      if (!inside(mx, mz)) continue;
      strip(asphalt, l, t, t1, 0, 2 * h, 5, LIFT);
      // Edge lines just inside the asphalt's edges, broken where another street joins.
      for (const s of [-1, 1]) strip(paint, l, t, t1, s * (h - 0.45), 0.15, 2, PAINT);
      // A dashed centre line on a street of two lanes: 3 m painted, 3 m bare.
      if (h >= 4 && Math.floor(t / 3) % 2 === 0) strip(paint, l, t, t1, 0, 0.15, 2, PAINT);
    }
  }
  for (const s of STREETS) for (const [x, z] of s.line) if (inside(x, z)) disc(asphalt, x, z, s.half);
  const mesh = (pos: number[], color: number) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, flat(color));
    m.receiveShadow = true;
    return m;
  };
  const out: THREE.Mesh[] = [];
  if (asphalt.length) out.push(mesh(asphalt, PAL.asphalt));
  if (paint.length) out.push(mesh(paint, PAL.roadPaint));
  return out;
}
