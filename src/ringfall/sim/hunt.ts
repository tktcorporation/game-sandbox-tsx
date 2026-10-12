import { WORLD } from "./config";
import { highGround, rimRadius, steepAt, terrainHeight } from "./terrain";

/*
 * How hunting squads (reinforcements and raiders) find their way to where they think
 * the player is. Robots otherwise walk straight at their goal, which on an island of
 * levels joined by ramps ends at the first cliff. A distance field over the ground
 * gives every cell the walking distance to the target; a hunter heads for the cell
 * a few steps down that field. It sees only the terrain: boxes are left to a
 * walker's own sidestep, and the cliffs and ramps are what decide the way.
 */

/** Cell size in metres. Ramps are 8 m wide or more, so 2 m cells keep them open. */
const RES = 2;
const N = Math.ceil((WORLD.half * 2) / RES);
/** Height change between neighbouring cells that a walker still takes: a ramp, not a cliff. */
const STEP = 1.4;
/** How far ahead along the field a hunter aims, in cells. */
const AHEAD = 4;

const idx = (v: number) => Math.max(0, Math.min(N - 1, Math.floor((v + WORLD.half) / RES)));
const centre = (i: number) => -WORLD.half + (i + 0.5) * RES;

let open: Uint8Array | null = null;
let height: Float32Array | null = null;

/** Which cells a walker can stand in: not a cliff, not the high ground, not past the coast. */
function grid() {
  if (open && height) return { open, height };
  open = new Uint8Array(N * N);
  height = new Float32Array(N * N);
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const x = centre(i);
      const z = centre(j);
      const k = j * N + i;
      height[k] = terrainHeight(x, z);
      const clear = !steepAt(x, z) && !highGround(x, z) && Math.hypot(x, z) < rimRadius(x, z) - 3;
      open[k] = clear ? 1 : 0;
    }
  return { open, height };
}

/** Walking distance from every cell to one target cell. */
export interface Field {
  target: number;
  dist: Float32Array;
}

let last: Field | null = null;

/** The nearest open cell to (x, z), searching a few cells out; -1 if none. */
function openCell(x: number, z: number): number {
  const { open } = grid();
  const ci = idx(x);
  const cj = idx(z);
  for (let r = 0; r <= 3; r++)
    for (let dj = -r; dj <= r; dj++)
      for (let di = -r; di <= r; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
        const i = ci + di;
        const j = cj + dj;
        if (i >= 0 && j >= 0 && i < N && j < N && open[j * N + i]) return j * N + i;
      }
  return -1;
}

const DI = [1, -1, 0, 0, 1, 1, -1, -1];
const DJ = [0, 0, 1, -1, 1, -1, 1, -1];
const COST = DI.map((di, n) => (di !== 0 && DJ[n] !== 0 ? Math.SQRT2 : 1) * RES);

/**
 * The field toward (x, z), by Dijkstra over open cells. Fields are shared: squads
 * hunting the same spot reuse the last one built.
 */
export function fieldTo(x: number, z: number): Field | null {
  const target = openCell(x, z);
  if (target < 0) return null;
  if (last && last.target === target) return last;
  const { open, height } = grid();
  const dist = new Float32Array(N * N).fill(Infinity);
  dist[target] = 0;
  // Binary heap of cell indices keyed by dist.
  const heap: number[] = [target];
  const push = (k: number) => {
    heap.push(k);
    let c = heap.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (dist[heap[p]] <= dist[heap[c]]) break;
      [heap[p], heap[c]] = [heap[c], heap[p]];
      c = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const end = heap.pop()!;
    if (heap.length) {
      heap[0] = end;
      let c = 0;
      for (;;) {
        const l = 2 * c + 1;
        const r = l + 1;
        let m = c;
        if (l < heap.length && dist[heap[l]] < dist[heap[m]]) m = l;
        if (r < heap.length && dist[heap[r]] < dist[heap[m]]) m = r;
        if (m === c) break;
        [heap[m], heap[c]] = [heap[c], heap[m]];
        c = m;
      }
    }
    return top;
  };
  const done = new Uint8Array(N * N);
  while (heap.length) {
    const k = pop();
    if (done[k]) continue;
    done[k] = 1;
    const i = k % N;
    const j = (k - i) / N;
    for (let n = 0; n < 8; n++) {
      const a = i + DI[n];
      const b = j + DJ[n];
      if (a < 0 || b < 0 || a >= N || b >= N) continue;
      const q = b * N + a;
      if (!open[q] || done[q] || Math.abs(height[q] - height[k]) > STEP) continue;
      // A diagonal step must not cut a cliff corner.
      if (DI[n] && DJ[n] && (!open[j * N + a] || !open[b * N + i])) continue;
      const d = dist[k] + COST[n];
      if (d < dist[q]) {
        dist[q] = d;
        push(q);
      }
    }
  }
  last = { target, dist };
  return last;
}

/** Walking distance from (x, z) along the field, or Infinity when no way leads there. */
export function routeLength(f: Field, x: number, z: number): number {
  const k = openCell(x, z);
  if (k < 0) return Infinity;
  const i = k % N;
  const j = (k - i) / N;
  // Add the step from (x, z) to the centre of the open cell it was snapped to.
  return f.dist[k] + Math.hypot(centre(i) - x, centre(j) - z);
}

/**
 * Where a hunter at (x, z) walks next on its way to the field's target: a few cells
 * down the field, or the target itself once it is that close.
 */
export function nextStep(f: Field, x: number, z: number, to: { x: number; z: number }): { x: number; z: number } {
  const { height } = grid();
  let k = openCell(x, z);
  if (k < 0 || !Number.isFinite(f.dist[k])) return to;
  for (let s = 0; s < AHEAD; s++) {
    if (k === f.target) return to;
    const i = k % N;
    const j = (k - i) / N;
    let best = k;
    for (let n = 0; n < 8; n++) {
      const a = i + DI[n];
      const b = j + DJ[n];
      if (a < 0 || b < 0 || a >= N || b >= N) continue;
      const q = b * N + a;
      if (Math.abs(height[q] - height[k]) > STEP) continue;
      if (f.dist[q] < f.dist[best]) best = q;
    }
    if (best === k) break;
    k = best;
  }
  const i = k % N;
  return { x: centre(i), z: centre((k - i) / N) };
}

/** Centres of the open cells whose walking distance to the field's target is within [lo, hi]. */
export function cellsAround(f: Field, lo: number, hi: number): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = [];
  for (let k = 0; k < f.dist.length; k++) {
    const d = f.dist[k];
    if (d < lo || d > hi) continue;
    const i = k % N;
    out.push({ x: centre(i), z: centre((k - i) / N) });
  }
  return out;
}
