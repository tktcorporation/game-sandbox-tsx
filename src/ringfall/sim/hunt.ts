import { WORLD } from "./config";
import { BOXES, DECKS } from "./map";
import { routeBoxesOpen } from "./geom";
import { highGround, offshore, steepAt, terrainHeight } from "./terrain";

/*
 * How hunting squads (reinforcements and raiders) find their way to where they think
 * the player is. Robots otherwise walk straight at their goal, which on an island of
 * levels joined by ramps ends at the first cliff. A distance field over the ground
 * gives every cell the walking distance to the target; a hunter heads for the cell
 * a few steps down that field. Cliffs, high ground and anything built that a walker
 * cannot step over close a cell, so the way goes up the ramps and round the houses;
 * the inside of a building is closed too (a hunter waits at its doors). The railway
 * bridge's deck (DECKS) is ground at its own height, so the way between the regions
 * goes over the pass or across the bridge.
 */

/** Cell size in metres. Ramps are 8 m wide or more, so 2 m cells keep them open. */
const RES = 2;
const NX = Math.ceil((WORLD.x1 - WORLD.x0) / RES);
const NZ = Math.ceil((WORLD.z1 - WORLD.z0) / RES);
const CELLS = NX * NZ;
/** Height change between neighbouring cells that a walker still takes: a ramp, not a cliff. */
const STEP = 1.4;
/** How far ahead along the field a hunter aims, in cells: short enough not to cut a corner. */
const AHEAD = 2;
/** Room a walker's body needs round a box: a cell this close to one is closed. */
const BODY = 0.5;

const idxX = (v: number) => Math.max(0, Math.min(NX - 1, Math.floor((v - WORLD.x0) / RES)));
const idxZ = (v: number) => Math.max(0, Math.min(NZ - 1, Math.floor((v - WORLD.z0) / RES)));
const centreX = (i: number) => WORLD.x0 + (i + 0.5) * RES;
const centreZ = (j: number) => WORLD.z0 + (j + 0.5) * RES;

let open: Uint8Array | null = null;
let height: Float32Array | null = null;
/** Open cells joined to the island's main walkable ground (not a pocket inside a building or on a rock). */
let main: Uint8Array | null = null;

/** Which cells a walker can stand in: not a cliff, not the high ground, not past the coast. */
function grid() {
  if (open && height && main) return { open, height, main };
  open = new Uint8Array(CELLS);
  height = new Float32Array(CELLS);
  for (let j = 0; j < NZ; j++)
    for (let i = 0; i < NX; i++) {
      const x = centreX(i);
      const z = centreZ(j);
      const k = j * NX + i;
      height[k] = terrainHeight(x, z);
      const clear = !steepAt(x, z) && !highGround(x, z) && offshore(x, z) < -3;
      open[k] = clear ? 1 : 0;
    }
  // Boxes in a walker's way: higher than a step above the ground and low enough to walk into.
  for (const b of [...BOXES, ...routeBoxesOpen]) {
    const t = terrainHeight((b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2);
    if (b.h - t <= WORLD.stepUp || b.y0 - t >= 1.75) continue;
    for (let j = idxZ(b.z0 - BODY); j <= idxZ(b.z1 + BODY); j++)
      for (let i = idxX(b.x0 - BODY); i <= idxX(b.x1 + BODY); i++) {
        const x = centreX(i);
        const z = centreZ(j);
        // The cell's middle within a body's reach of the box.
        if (x > b.x0 - BODY - RES / 2 && x < b.x1 + BODY + RES / 2 && z > b.z0 - BODY - RES / 2 && z < b.z1 + BODY + RES / 2) open[j * NX + i] = 0;
      }
  }
  for (const d of DECKS)
    for (let j = idxZ(d.z0); j <= idxZ(d.z1); j++)
      for (let i = idxX(d.x0); i <= idxX(d.x1); i++) {
        const x = centreX(i);
        const z = centreZ(j);
        if (x < d.x0 || x > d.x1 || z < d.z0 || z > d.z1) continue;
        open[j * NX + i] = 1;
        height[j * NX + i] = d.y;
      }
  main = mainGround(open, height);
  return { open, height, main };
}

const DI = [1, -1, 0, 0, 1, 1, -1, -1];
const DJ = [0, 0, 1, -1, 1, -1, 1, -1];
const COST = DI.map((di, n) => (di !== 0 && DJ[n] !== 0 ? Math.SQRT2 : 1) * RES);

/** Whether a walker steps from cell k to its n-th neighbour q: both open, no cliff between, no corner cut. */
function steps(open: Uint8Array, height: Float32Array, k: number, n: number): number {
  const i = k % NX;
  const j = (k - i) / NX;
  const a = i + DI[n];
  const b = j + DJ[n];
  if (a < 0 || b < 0 || a >= NX || b >= NZ) return -1;
  const q = b * NX + a;
  if (!open[q] || Math.abs(height[q] - height[k]) > STEP) return -1;
  if (DI[n] && DJ[n] && (!open[j * NX + a] || !open[b * NX + i])) return -1;
  return q;
}

/** The largest set of open cells a walker can get between: the island's walkable ground. */
function mainGround(open: Uint8Array, height: Float32Array): Uint8Array {
  const label = new Int32Array(CELLS).fill(-1);
  let best = -1;
  let bestSize = 0;
  const queue = new Int32Array(CELLS);
  for (let start = 0, id = 0; start < CELLS; start++) {
    if (!open[start] || label[start] >= 0) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    label[start] = id;
    while (head < tail) {
      const k = queue[head++];
      for (let n = 0; n < 8; n++) {
        const q = steps(open, height, k, n);
        if (q >= 0 && label[q] < 0) {
          label[q] = id;
          queue[tail++] = q;
        }
      }
    }
    if (tail > bestSize) {
      bestSize = tail;
      best = id;
    }
    id++;
  }
  const out = new Uint8Array(CELLS);
  for (let k = 0; k < CELLS; k++) if (label[k] === best) out[k] = 1;
  return out;
}

/**
 * Walking distance from every cell to one target cell, out to `reach` metres (Infinity beyond
 * it, and everywhere no way leads). `order` holds the cells within reach, nearest first, and
 * `count` how many there are.
 */
export interface Field {
  target: number;
  dist: Float32Array;
  reach: number;
  order: Int32Array;
  count: number;
}

/**
 * Fields built lately, by target cell, oldest first. Squads hunting the player and the
 * teammate at once (or several spots) each keep theirs instead of rebuilding every tick.
 */
const cache = new Map<number, Field>();
const CACHE = 8;
/**
 * A target that has moved this many cells or fewer from a cached field's keeps that field:
 * hunters walk to its cell and the last few metres straight (see nextStep). A running
 * target so costs a field every few metres instead of every cell it enters.
 */
const NEAR = 3;
/**
 * Forgets the grid and every field, for a world whose open routes changed (routes.ts): they are
 * built again on first use.
 */
export function resetHunt() {
  open = height = main = null;
  cache.clear();
}

/** Fields built so far: the sim gate checks that alternating targets reuse them. */
export let fieldsBuilt = 0;

/**
 * The nearest open cell to (x, z), searching out as far as from the middle of the factory
 * hall or the plateau's rock; -1 if none. A player inside a building or up on a rock is
 * hunted to the ground just outside it.
 */
function openCell(x: number, z: number): number {
  const { main } = grid();
  const ci = idxX(x);
  const cj = idxZ(z);
  // Nearest by the cell's centre, not the first in scan order: a walker pressed against a box
  // stands in a cell the box closes, and an open cell across the box's corner would send it
  // straight into the box. A cell one ring further out can be nearer than a corner of the
  // ring that first had one, so that ring is searched too.
  let best = -1;
  let bestD = Infinity;
  let last = 12;
  for (let r = 0; r <= last; r++)
    for (let dj = -r; dj <= r; dj++)
      for (let di = -r; di <= r; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
        const i = ci + di;
        const j = cj + dj;
        if (i < 0 || j < 0 || i >= NX || j >= NZ || !main[j * NX + i]) continue;
        const d = Math.hypot(centreX(i) - x, centreZ(j) - z);
        if (d < bestD) {
          bestD = d;
          best = j * NX + i;
          last = Math.min(last, r + 1);
        }
      }
  return best;
}


/**
 * The field toward (x, z), by Dijkstra over open cells, out to `reach` metres of walking (all
 * the way by default). Fields are shared: squads hunting the same spot share one, and a few
 * recent ones are kept (see `cache`); a kept field serves any reach up to its own.
 */
export function fieldTo(x: number, z: number, reach = Infinity): Field | null {
  const target = openCell(x, z);
  if (target < 0) return null;
  let hit: Field | undefined;
  let hitD = Infinity;
  const ti = target % NX;
  const tj = (target - ti) / NX;
  for (const f of cache.values()) {
    const fi = f.target % NX;
    const d = Math.max(Math.abs(fi - ti), Math.abs((f.target - fi) / NX - tj));
    if (d <= NEAR && d < hitD && f.reach >= reach) {
      hit = f;
      hitD = d;
    }
  }
  if (hit) {
    // Most recently used goes last, so the oldest is dropped first.
    cache.delete(hit.target);
    cache.set(hit.target, hit);
    return hit;
  }
  const { open, height } = grid();
  const dist = new Float32Array(CELLS).fill(Infinity);
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
  const done = new Uint8Array(CELLS);
  const order = new Int32Array(CELLS);
  let count = 0;
  while (heap.length) {
    const k = pop();
    if (done[k]) continue;
    // Cells come out nearest first: once one is past the reach, every one left is too.
    if (dist[k] > reach) {
      dist[k] = Infinity;
      break;
    }
    done[k] = 1;
    order[count++] = k;
    for (let n = 0; n < 8; n++) {
      const q = steps(open, height, k, n);
      if (q < 0 || done[q]) continue;
      const d = dist[k] + COST[n];
      if (d < dist[q]) {
        dist[q] = d;
        push(q);
      }
    }
  }
  // Cells reached but not settled lie past the reach: their distances so far are not theirs.
  for (const k of heap) if (!done[k]) dist[k] = Infinity;
  const f = { target, dist, reach, order, count };
  fieldsBuilt++;
  cache.set(target, f);
  if (cache.size > CACHE) cache.delete(cache.keys().next().value!);
  return f;
}

/** Walking distance from (x, z) along the field, or Infinity when no way leads there. */
export function routeLength(f: Field, x: number, z: number): number {
  const k = openCell(x, z);
  if (k < 0) return Infinity;
  const i = k % NX;
  const j = (k - i) / NX;
  // Add the step from (x, z) to the centre of the open cell it was snapped to.
  return f.dist[k] + Math.hypot(centreX(i) - x, centreZ(j) - z);
}

/**
 * Where a hunter at (x, z) walks next on its way to the field's target: a few cells
 * down the field, or the target itself once it is that close.
 */
export function nextStep(f: Field, x: number, z: number, to: { x: number; z: number }): { x: number; z: number } {
  const { open, height } = grid();
  let k = openCell(x, z);
  if (k < 0 || !Number.isFinite(f.dist[k])) return to;
  for (let s = 0; s < AHEAD; s++) {
    if (k === f.target) return to;
    let best = k;
    for (let n = 0; n < 8; n++) {
      const q = steps(open, height, k, n);
      if (q >= 0 && f.dist[q] < f.dist[best]) best = q;
    }
    if (best === k) break;
    k = best;
  }
  const i = k % NX;
  return { x: centreX(i), z: centreZ((k - i) / NX) };
}

/**
 * Centres of the open cells whose walking distance to the field's target is within [lo, hi], in
 * the cells' own order (row by row). Found among the field's cells nearest first, so the cost
 * follows the band's size rather than the world's.
 */
export function cellsAround(f: Field, lo: number, hi: number): { x: number; z: number }[] {
  let cells: Int32Array;
  if (hi === Infinity) {
    // Cells no way leads to are at Infinity and in the band too; only a full scan has them.
    const all: number[] = [];
    for (let k = 0; k < f.dist.length; k++) if (f.dist[k] >= lo) all.push(k);
    cells = Int32Array.from(all);
  } else {
    // The first cell at lo or further, then on while within hi; put back in row order.
    let a = 0;
    let b = f.count;
    while (a < b) {
      const m = (a + b) >> 1;
      if (f.dist[f.order[m]] < lo) a = m + 1;
      else b = m;
    }
    let e = a;
    while (e < f.count && f.dist[f.order[e]] <= hi) e++;
    cells = f.order.slice(a, e).sort();
  }
  const out: { x: number; z: number }[] = new Array(cells.length);
  for (let n = 0; n < cells.length; n++) {
    const k = cells[n];
    const i = k % NX;
    out[n] = { x: centreX(i), z: centreZ((k - i) / NX) };
  }
  return out;
}

/** The cell at (x, z) as the field sees it: open, its height, and whether it is on the main walkable ground. For the sim gate's checks. */
export function cellAt(x: number, z: number): { open: boolean; height: number; main: boolean } {
  const { open, height, main } = grid();
  const k = idxZ(z) * NX + idxX(x);
  return { open: !!open[k], height: height[k], main: !!main[k] };
}
