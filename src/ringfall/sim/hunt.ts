import { WORLD } from "./config";
import { BOXES, DECKS, inCamp } from "./map";
import { routeBoxesOpen } from "./geom";
import { highGround, offshore, steepAt, terrainHeight } from "./terrain";
import { hypot2 } from "./hypot";

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
/** 1 / RES, exactly: a distance's bucket is `(d * INV_RES) | 0`, its floor, as distances are finite, not negative and far below 2^31. */
const INV_RES = 1 / RES;
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
  // The camp's are left out: no hunter goes in (`inCamp()` stops it at the fence), so its fence
  // and furniture leave the field over the beach round it as the open sand it would be without them.
  for (const b of [...BOXES, ...routeBoxesOpen]) {
    if (inCamp({ x: (b.x0 + b.x1) / 2, z: (b.z0 + b.z1) / 2 }, 0.5)) continue;
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
/** `OFFSET` and `COST` as typed arrays, for the inner loop of `build()`. */
const MOVE_OFFSET = Int32Array.from(OFFSET);
const MOVE_COST = Float64Array.from(COST);
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
  /** A whole-world field still being found, bucket by bucket as its readers need it (see `Lazy`); null once found. */
  lazy: Lazy | null;
}

/*
 * A whole-world field is found only as far as it is read. Its readers want the walk from one
 * cell (a hunter's, a bin's) or the cells within a band, nearly always far nearer the target
 * than the field's whole reach, which covers half the grid. So `fieldTo()` starts the search
 * and stops, and `settleCell()` / `settleBand()` go on with it bucket by bucket, exactly as
 * `build()` would have gone (the same buckets in the same order, each whole), until the cell
 * asked for is settled or the band is done. After bucket b every cell nearer than (b + 1) RES
 * is settled and every other cell holds a distance at least that (a tentative one, or
 * Infinity), so a reader that compares the cells near the one it asked for sees the same
 * answers as in the found field. A field found to the end is kept like a built one; one dropped
 * before is let go, and found again if asked for again.
 */
type Lazy = { b: number; pending: number; ring: Int32Array[]; size: Int32Array; mark: Uint8Array };
/** Spare marks and rings for lazy fields: fresh memory costs a page fault for each page it first touches. */
const spareMarks: Uint8Array[] = [];
const spareRings: Int32Array[][] = [];

/** Settles the lazy field's next bucket, as `build()` settles a bucket of a field without a reach. */
function settleBucket(f: Field, L: Lazy) {
  const mask = stepMask();
  const dist = f.dist;
  const order = f.order;
  const mark = L.mark;
  const b = L.b++;
  const r = b & (RING - 1);
  const list = L.ring[r];
  const n = L.size[r];
  L.size[r] = 0;
  L.pending -= n;
  if (bucket.length < n) bucket = new Int32Array(n * 2);
  let m = 0;
  for (let e = 0; e < n; e++) {
    const k = list[e];
    if (mark[k] || ((dist[k] * INV_RES) | 0) !== b) continue;
    mark[k] = 1;
    bucket[m++] = k;
  }
  let count = f.count;
  for (let e = 0; e < m; e++) {
    const k = bucket[e];
    order[count++] = k;
    const bits = mask[k];
    if (!bits) continue;
    const dk = dist[k];
    for (let q0 = 0; q0 < 8; q0++) {
      if (!(bits & (1 << q0))) continue;
      const q = k + MOVE_OFFSET[q0];
      if (mark[q]) continue;
      const d = dk + MOVE_COST[q0];
      if (d < dist[q]) {
        dist[q] = d;
        const into = ((dist[q] * INV_RES) | 0) & (RING - 1);
        let cells = L.ring[into];
        if (L.size[into] === cells.length) {
          const grown = new Int32Array(cells.length * 2);
          grown.set(cells);
          cells = L.ring[into] = grown;
        }
        cells[L.size[into]++] = q;
        L.pending++;
      }
    }
  }
  f.count = count;
  if (!L.pending) finish(f, L);
}

/** A lazy field found to the end: kept like a built one, its marks and rings given back. */
function finish(f: Field, L: Lazy) {
  keep(`${f.target}:${f.reach}`, f.dist, f.order, f.count);
  release(f, L);
}

/** Gives back a lazy field's marks and rings, cleared, and leaves the field found as far as it is. */
function release(f: Field, L: Lazy) {
  if (f.count > CLEAR_WHOLE) L.mark.fill(0);
  else for (let e = 0; e < f.count; e++) L.mark[f.order[e]] = 0;
  spareMarks.push(L.mark);
  spareRings.push(L.ring);
  f.lazy = null;
}

/** Goes on with a lazy field until cell k is settled or the field is found. */
function settleCell(f: Field, k: number) {
  const L = f.lazy;
  if (!L) return;
  while (f.lazy && !L.mark[k]) settleBucket(f, L);
}

/** Goes on with a lazy field until bucket `b` (every cell nearer than (b + 1) RES) is settled, or the field is found. */
function settleBand(f: Field, b: number) {
  const L = f.lazy;
  if (!L) return;
  while (f.lazy && L.b <= b) settleBucket(f, L);
}

/** A field leaving the cache for `spare`: a lazy one's tentative cells go back to Infinity and its marks and rings are given back. */
function retire(f: Field): { dist: Float32Array; order: Int32Array; count: number } {
  const L = f.lazy;
  if (L) {
    for (let r = 0; r < RING; r++) for (let e = 0; e < L.size[r]; e++) f.dist[L.ring[r][e]] = Infinity;
    release(f, L);
  }
  return f;
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
  kept.clear();
  keptCells = 0;
  spareMarks.length = 0;
  spareRings.length = 0;
}

/** Forgets every field but keeps the grid: a raid starts with none (`newRun()`). */
export function forgetFields() {
  fieldUses++;
  for (const f of cache.values()) spare.push(retire(f));
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

/*
 * Copies of the fields built lately, by target cell and reach, kept after the cache above has
 * dropped them. A field is fixed by its target cell, its reach and the grid, so one built again
 * for the same target and reach is the copy, written back instead of found again. Squads posted
 * round a few spots ask for the same fields over and over, more of them than the cache keeps;
 * the cache alone decides which field a squad follows, and only the building of a field it
 * has dropped comes from here. A copy holds the field's `order` cells and their distances; every
 * other cell of a field is at Infinity. A field over much of the grid (a whole-world field covers
 * about half of it) that is written back once keeps its distances whole from then on, every cell
 * in its place (`whole`), and is written back again in one copy rather than cell by cell. Many
 * such fields are dropped without being written back, so only those that are pay for the larger
 * copy. Kept across raids, since the grid is the same; dropped with the grid (`resetHunt()`). The
 * oldest copies go once they hold more than `KEPT_CELLS` cells, a whole copy counted by its
 * field's cells too, so the same copies are kept either way.
 */
type Kept = { order: Int32Array; dist: Float32Array; whole: boolean };
const kept = new Map<string, Kept>();
let keptCells = 0;
const KEPT_CELLS = 16_000_000;
/** Cells past which a field's copy keeps its distances whole once it is written back. */
const WHOLE = CELLS / 4;
/** Cells past which a field's arrays are cleared whole: a fill over the grid costs less than the cells one by one. */
const CLEAR_WHOLE = CELLS / 8;

/** Fields built so far: the sim gate checks that alternating targets reuse them. */
export let fieldsBuilt = 0;

/**
 * Counts every look-up in and forgetting of the field cache, so work spread over several calls
 * (`warmLinks()` in battle.ts) can tell whether anything else used the cache in between.
 */
export let fieldUses = 0;

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
        const d = hypot2(centreX(i) - x, centreZ(j) - z);
        if (d < bestD) {
          bestD = d;
          best = j * NX + i;
          last = Math.min(last, r + 1);
        }
      }
  return best;
}


/** A kept copy written back into a field's arrays (cleared to Infinity, unless the copy is whole), as `build()` would write it; returns its cell count. */
function restore(copy: Kept, dist: Float32Array, order: Int32Array, name: string): number {
  // Most recently used goes last, so the oldest is dropped first.
  kept.delete(name);
  kept.set(name, copy);
  const n = copy.order.length;
  order.set(copy.order);
  if (copy.whole) dist.set(copy.dist);
  else {
    for (let e = 0; e < n; e++) dist[copy.order[e]] = copy.dist[e];
    if (n > WHOLE) {
      // Every cell but the field's is at Infinity, so the whole array is the same copy.
      copy.dist = dist.slice();
      copy.whole = true;
    }
  }
  return n;
}

/** Finds the field toward `target` out to `reach` into `dist` (Infinity everywhere) and `order`, keeps a copy, and returns its cell count. */
function build(target: number, reach: number, dist: Float32Array, order: Int32Array, name: string): number {
  const mask = stepMask();
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
  let count = 0;
  for (let r = 0; r < RING; r++) ringSize[r] = 0;
  ring[0][ringSize[0]++] = target;
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
      if (done[k] >= taken || ((dist[k] * INV_RES) | 0) !== b) continue;
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
      if (!bits) continue;
      const dk = dist[k];
      for (let q0 = 0; q0 < 8; q0++) {
        if (!(bits & (1 << q0))) continue;
        const q = k + MOVE_OFFSET[q0];
        if (done[q] >= taken) continue;
        const d = dk + MOVE_COST[q0];
        if (d < dist[q]) {
          dist[q] = d;
          // Into the ring by its distance as stored, a bucket RES wide.
          const into = ((dist[q] * INV_RES) | 0) & (RING - 1);
          let cells = ring[into];
          if (ringSize[into] === cells.length) {
            const grown = new Int32Array(cells.length * 2);
            grown.set(cells);
            cells = ring[into] = grown;
          }
          cells[ringSize[into]++] = q;
          pending++;
        }
      }
    }
  }
  // Cells reached but not settled lie past the reach: their distances so far are not theirs.
  if (past)
    for (let r = 0; r < RING; r++)
      for (let e = 0; e < ringSize[r]; e++) if (done[ring[r][e]] !== isSettled) dist[ring[r][e]] = Infinity;
  keep(name, dist, order, count);
  return count;
}

/** Keeps a copy of a field found (see `kept`). */
function keep(name: string, dist: Float32Array, order: Int32Array, count: number) {
  const copy = { order: order.slice(0, count), dist: new Float32Array(count), whole: false };
  for (let e = 0; e < count; e++) copy.dist[e] = dist[order[e]];
  kept.set(name, copy);
  keptCells += count;
  while (keptCells > KEPT_CELLS && kept.size > 1) {
    const [oldest, c] = kept.entries().next().value!;
    kept.delete(oldest);
    keptCells -= c.order.length;
  }
}

/**
 * The field toward (x, z), by Dijkstra over open cells, out to `reach` metres of walking (all
 * the way by default). Fields are shared: squads hunting the same spot share one, and a few
 * recent ones are kept (see `cache`); a kept field serves any reach up to its own.
 */
export function fieldTo(x: number, z: number, reach = Infinity): Field | null {
  fieldUses++;
  const target = openCell(x, z);
  if (target < 0) return null;
  let hit: Field | undefined;
  let hitD = Infinity;
  const ti = target % NX;
  const tj = (target - ti) / NX;
  for (const f of cache.values()) {
    const fi = f.target % NX;
    const d = Math.max(Math.abs(fi - ti), Math.abs((f.target - fi) / NX - tj));
    // A field serves a target that moved only a short walk from its own (not a few cells off
    // across a cliff), and a short one only while it reaches every cell the new target's field
    // would: one within `reach` of the new target is within `reach` plus that walk of the old.
    // A lazy field's walks up to the one compared below are settled first.
    if (f.lazy && d <= NEAR && d < hitD) settleBand(f, Math.floor((NEAR * RES * 1.5) / RES));
    const walk = f.dist[target];
    if (d <= NEAR && d < hitD && walk <= NEAR * RES * 1.5 && f.reach >= reach + (f.reach < Infinity ? walk : 0)) {
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
  // A short field is built a little past its reach, so a target that moves a few cells still
  // finds it in the cache (see above).
  if (reach < Infinity) reach += NEAR * RES * 1.5;
  const name = `${target}:${reach}`;
  const copy = kept.get(name);
  const reused = spare.pop();
  const dist = reused?.dist ?? new Float32Array(CELLS).fill(Infinity);
  // A whole copy writes every cell; else the last field's cells go back to Infinity.
  if (reused && !copy?.whole) {
    if (reused.count > CLEAR_WHOLE) dist.fill(Infinity);
    else for (let e = 0; e < reused.count; e++) dist[reused.order[e]] = Infinity;
  }
  const order = reused?.order ?? new Int32Array(CELLS);
  let f: Field;
  if (copy) f = { target, dist, reach, order, count: restore(copy, dist, order, name), lazy: null };
  else if (reach === Infinity) {
    // A whole-world field is found only as far as it is read (see `Lazy`).
    const ring = spareRings.pop() ?? Array.from({ length: RING }, () => new Int32Array(1 << 12));
    const L: Lazy = { b: 0, pending: 1, ring, size: new Int32Array(RING), mark: spareMarks.pop() ?? new Uint8Array(CELLS) };
    dist[target] = 0;
    ring[0][L.size[0]++] = target;
    f = { target, dist, reach, order, count: 0, lazy: L };
  } else f = { target, dist, reach, order, count: build(target, reach, dist, order, name), lazy: null };
  fieldsBuilt++;
  // A longer field for a cell that already has a short one replaces it: its arrays go back to `spare`.
  const replaced = cache.get(target);
  if (replaced) {
    cache.delete(target);
    spare.push(retire(replaced));
  }
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
    spare.push(retire(cache.get(drop)!));
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
  settleCell(f, k);
  // Add the step from (x, z) to the centre of the open cell it was snapped to.
  return f.dist[k] + hypot2(centreX(i) - x, centreZ(j) - z);
}

/**
 * Where a hunter at (x, z) walks next on its way to the field's target: a few cells
 * down the field, or the target itself once it is that close.
 */
export function nextStep(f: Field, x: number, z: number, to: { x: number; z: number }): { x: number; z: number } {
  const { open, height } = grid();
  let k = openCell(x, z);
  if (k >= 0) settleCell(f, k);
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
  settleBand(f, hi === Infinity ? Infinity : Math.floor(hi / RES));
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

/**
 * The way a walker takes on the ground from `a` to `b`, as points down the field toward `b` (a
 * cell's centre every `every` cells), ending at `b`; just `[b]` when no way leads there. For walks
 * fixed in advance (a patrol's, see `MOBILES`): it builds a field, so a caller that must leave the
 * fields as they were forgets them after (`forgetFields()`).
 */
export function walkLine(a: { x: number; z: number }, b: { x: number; z: number }, every = 3): { x: number; z: number }[] {
  const d = hypot2(b.x - a.x, b.z - a.z);
  let f = fieldTo(b.x, b.z, Math.max(80, d * 3 + 40));
  if (!f) return [b];
  const { open, height } = grid();
  let k = openCell(a.x, a.z);
  if (k < 0) return [b];
  settleCell(f, k);
  // A way round further than the field first reached (a cliff to go round): looked for further out once.
  if (!Number.isFinite(f.dist[k])) {
    f = fieldTo(b.x, b.z, Math.max(160, d * 6 + 80)) ?? f;
    settleCell(f, k);
  }
  if (!Number.isFinite(f.dist[k])) return [b];
  const out: { x: number; z: number }[] = [];
  for (let n = 1; n < 20_000 && k !== f.target; n++) {
    let best = k;
    for (let q0 = 0; q0 < 8; q0++) {
      const q = steps(open, height, k, q0);
      if (q >= 0 && f.dist[q] < f.dist[best]) best = q;
    }
    if (best === k) break;
    k = best;
    if (n % every === 0) out.push({ x: centreX(k % NX), z: centreZ((k - (k % NX)) / NX) });
  }
  out.push({ x: b.x, z: b.z });
  return out;
}
