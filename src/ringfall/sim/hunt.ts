import { WORLD } from "./config";
import { BOXES, DECKS } from "./map";
import { routeBoxesOpen } from "./geom";
import { highGround, offshore, steepAt, terrainHeight } from "./terrain";

/*
 * How hunting squads (reinforcements and raiders), and fighting squads that have lost the
 * player (see PURSUE), find their way to where they think the player is. A straight walk
 * at the goal, on an island of levels joined by ramps, ends at the first cliff. A distance
 * field over the ground
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

/** Neighbour n's index from a cell's. */
const OFFSET = DI.map((di, n) => DJ[n] * NX + di);
/** For each cell, bit n set when `steps()` lets a walker go to its n-th neighbour; built on first use. */
let mask: Uint8Array | null = null;
function stepMask(): Uint8Array {
  if (mask) return mask;
  const { open, height } = grid();
  const m = new Uint8Array(CELLS);
  for (let k = 0; k < CELLS; k++) {
    if (!open[k]) continue;
    let bits = 0;
    for (let n = 0; n < 8; n++) if (steps(open, height, k, n) >= 0) bits |= 1 << n;
    m[k] = bits;
  }
  mask = m;
  return m;
}
/**
 * Scratch for `fieldTo()`: which cells it has settled, its ring of buckets (a pending
 * distance is at most the longest move past the bucket being settled, so four buckets of RES
 * go round), and the cells of the bucket being settled. A cell's mark counts only for the build
 * that wrote it (`stamp`), so a short build does not clear the whole grid first.
 */
let settled = new Uint32Array(0);
let stamp = 0;
const RING = 4;
const ring = Array.from({ length: RING }, () => new Int32Array(1 << 12));
const ringSize = new Int32Array(RING);
let bucket = new Int32Array(0);

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
 * it, and everywhere no way leads). `order` holds the cells within reach by bands RES wide,
 * nearest band first, and `count` how many there are.
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
  open = height = main = mask = null;
  forgetFields();
}

/** Forgets every field but keeps the grid: a raid starts with none (`newRun()`). */
export function forgetFields() {
  for (const f of cache.values()) spare.push(f);
  cache.clear();
}

/*
 * The arrays of fields dropped from the cache, for the next fields to fill. A field's arrays
 * span the whole grid, and fresh memory costs a page fault for each page it first touches;
 * reused, it does not. A field's distances are finite only at its `order` cells, so putting
 * those back to Infinity readies its arrays for the next: a short field costs its reach, not
 * the grid. Nothing keeps a field past the next `fieldTo()` call.
 */
const spare: { dist: Float32Array; order: Int32Array; count: number }[] = [];

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
  const mask = stepMask();
  const reused = spare.pop();
  const dist = reused?.dist ?? new Float32Array(CELLS).fill(Infinity);
  if (reused) for (let e = 0; e < reused.count; e++) dist[reused.order[e]] = Infinity;
  dist[target] = 0;
  // Dijkstra with the cells kept in buckets RES wide by distance, the cost of the shortest
  // move: a cell relaxed from one in bucket b lands in bucket b + 1 or later, so every cell
  // in a bucket is settled by the time the bucket comes up, and the buckets are taken in turn
  // without a heap. The distances are the same as a heap's (each cell's is the least over its
  // settled neighbours). `order` runs bucket by bucket, nearest bucket first.
  if (settled.length !== CELLS) {
    settled = new Uint32Array(CELLS);
    stamp = 0;
  }
  const done = settled;
  // This build's marks: taken from its bucket, and settled. Older builds' marks are below both.
  const taken = (stamp += 2);
  const isSettled = taken + 1;
  const order = reused?.order ?? new Int32Array(CELLS);
  let count = 0;
  const bucketOf = (d: number) => Math.floor(d / RES) & (RING - 1);
  for (let r = 0; r < RING; r++) ringSize[r] = 0;
  const put = (k: number, d: number) => {
    const r = bucketOf(d);
    if (ringSize[r] === ring[r].length) {
      const grown = new Int32Array(ring[r].length * 2);
      grown.set(ring[r]);
      ring[r] = grown;
    }
    ring[r][ringSize[r]++] = k;
  };
  put(target, 0);
  let pending = 1;
  let past = false;
  for (let b = 0; pending && !past; b++) {
    const r = b & (RING - 1);
    const list = ring[r];
    const n = ringSize[r];
    ringSize[r] = 0;
    pending -= n;
    // This bucket's cells, once each. A bucket that reaches past the reach is the last: the
    // cells in it past the reach are not settled, and nor is any cell after it.
    if (bucket.length < n) bucket = new Int32Array(n * 2);
    let m = 0;
    for (let e = 0; e < n; e++) {
      const k = list[e];
      if (done[k] >= taken || Math.floor(dist[k] / RES) !== b) continue;
      done[k] = taken;
      if (dist[k] > reach) {
        dist[k] = Infinity;
        past = true;
      } else bucket[m++] = k;
    }
    for (let e = 0; e < m; e++) {
      const k = bucket[e];
      done[k] = isSettled;
      order[count++] = k;
      const bits = mask[k];
      for (let q0 = 0; q0 < 8; q0++) {
        if (!(bits & (1 << q0))) continue;
        const q = k + OFFSET[q0];
        if (done[q] >= taken) continue;
        const d = dist[k] + COST[q0];
        if (d < dist[q]) {
          dist[q] = d;
          put(q, dist[q]);
          pending++;
        }
      }
    }
  }
  // Cells reached but not settled lie past the reach: their distances so far are not theirs.
  if (past)
    for (let r = 0; r < RING; r++)
      for (let e = 0; e < ringSize[r]; e++) if (done[ring[r][e]] !== isSettled) dist[ring[r][e]] = Infinity;
  const f = { target, dist, reach, order, count };
  fieldsBuilt++;
  cache.set(target, f);
  if (cache.size > CACHE) {
    // A short field (a squad chasing the player nearby, see PURSUE) goes before a whole-world
    // one: those cost the most to build again, and the hunters following them keep at it.
    let drop = cache.keys().next().value!;
    for (const [k, g] of cache)
      if (g.reach < Infinity && g !== f) {
        drop = k;
        break;
      }
    spare.push(cache.get(drop)!);
    cache.delete(drop);
  }
  return f;
}

/** Whether (x, z) is in a cell of the main walkable ground: a walker there can follow a field. */
export function onMainGround(x: number, z: number): boolean {
  const { main } = grid();
  return !!main[idxZ(z) * NX + idxX(x)];
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
    // The first cell in lo's band, then on through hi's band, keeping those within [lo, hi];
    // put back in row order.
    const band = (k: number) => Math.floor(f.dist[k] / RES);
    const loBand = Math.floor(lo / RES);
    const hiBand = Math.floor(hi / RES);
    let a = 0;
    let b = f.count;
    while (a < b) {
      const m = (a + b) >> 1;
      if (band(f.order[m]) < loBand) a = m + 1;
      else b = m;
    }
    const inBand: number[] = [];
    for (let e = a; e < f.count && band(f.order[e]) <= hiBand; e++) {
      const d = f.dist[f.order[e]];
      if (d >= lo && d <= hi) inBand.push(f.order[e]);
    }
    cells = Int32Array.from(inBand).sort();
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
