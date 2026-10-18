import { PLAYER, WORLD } from "./config";
import { los, routeBoxesOpen } from "./geom";
import { BOXES, DECKS, EXTRACTS, POIS } from "./map";
import { steepAt, terrainHeight } from "./terrain";

/*
 * Ground-level path finding for the bot only (the game never uses it). A 0.5 m grid
 * marks cells a walker on the ground cannot enter; A* finds a way around
 * buildings and rocks, and through doors. The railway bridge's deck counts as ground
 * (DECKS), so a path crosses the gorge on it. The grid is built on first use.
 */

const RES = 0.5;
const NX = Math.ceil((WORLD.x1 - WORLD.x0) / RES);
const NZ = Math.ceil((WORLD.z1 - WORLD.z0) / RES);
/** Blocked cells, filled by `blockedCells()` on first use. */
let grid = new Uint8Array(0);
const cellX = (v: number) => Math.max(0, Math.min(NX - 1, Math.floor((v - WORLD.x0) / RES)));
const cellZ = (v: number) => Math.max(0, Math.min(NZ - 1, Math.floor((v - WORLD.z0) / RES)));
const centerX = (i: number) => WORLD.x0 + (i + 0.5) * RES;
const centerZ = (j: number) => WORLD.z0 + (j + 0.5) * RES;

function blockedCells(): Uint8Array {
  if (grid.length) return grid;
  const blocked = new Uint8Array(NX * NZ);
  // A cell is blocked when any part of it is within a body radius of a box, so a
  // body standing in a free cell never overlaps a wall.
  const r = PLAYER.radius + 0.02;
  for (const b of [...BOXES, ...routeBoxesOpen]) {
    // Only what stops a body standing on the ground: low steps and high floors do not.
    const t = terrainHeight((b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2);
    if (b.h - t <= WORLD.stepUp || b.y0 - t >= 1.75) continue;
    for (let i = cellX(b.x0 - r); i <= cellX(b.x1 + r); i++)
      for (let j = cellZ(b.z0 - r); j <= cellZ(b.z1 + r); j++) {
        const x0 = WORLD.x0 + i * RES;
        const z0 = WORLD.z0 + j * RES;
        if (x0 + RES > b.x0 - r && x0 < b.x1 + r && z0 + RES > b.z0 - r && z0 < b.z1 + r) blocked[j * NX + i] = 1;
      }
  }
  // Cliffs, and ground a body's width from one.
  for (let j = 0; j < NZ; j++)
    for (let i = 0; i < NX; i++) {
      const x = centerX(i);
      const z = centerZ(j);
      if (steepAt(x, z) || steepAt(x + r, z) || steepAt(x - r, z) || steepAt(x, z + r) || steepAt(x, z - r)) blocked[j * NX + i] = 1;
    }
  // A deck is open between its railings (its rectangle already keeps a body clear of them);
  // round it, wherever the ground lies well below, the drop is closed.
  for (const d of DECKS)
    for (let i = cellX(d.x0 - 2); i <= cellX(d.x1 + 2); i++)
      for (let j = cellZ(d.z0 - 2); j <= cellZ(d.z1 + 2); j++) {
        const x = centerX(i);
        const z = centerZ(j);
        const on = x >= d.x0 && x <= d.x1 && z >= d.z0 && z <= d.z1;
        if (on) blocked[j * NX + i] = 0;
        else if (terrainHeight(x, z) < d.y - 2) blocked[j * NX + i] = 1;
      }
  grid = blocked;
  return blocked;
}

const free = (i: number, j: number) => i >= 0 && j >= 0 && i < NX && j < NZ && !grid[j * NX + i];

/*
 * Which connected stretch of open ground each free cell belongs to (0 for blocked cells),
 * the same 8-way moves A* makes. A search between two stretches has no answer, and
 * finding that out by A* means visiting every cell of the start's stretch, which spans
 * both regions; the labels answer it at once.
 */
let area: Uint16Array | Int32Array = new Uint16Array(0);

/*
 * The 8-way moves A* makes, in the order it tries them (di outer, dj inner), with the step
 * to the neighbour's index and its cost. Bit n of a cell's `moves` is set when move n from
 * it is allowed: the neighbour is free and the move cuts no corner. A search looks this up
 * once per cell it expands instead of testing up to five cells for each of its moves.
 */
const MOVE_DI = [-1, -1, -1, 0, 0, 1, 1, 1];
const MOVE_DJ = [-1, 0, 1, -1, 1, -1, 0, 1];
const MOVE_OFF = MOVE_DI.map((di, n) => MOVE_DJ[n] * NX + di);
const MOVE_COST = MOVE_DI.map((di, n) => (di && MOVE_DJ[n] ? 1.414 : 1));
let moves = new Uint8Array(0);
function moveMask(): Uint8Array {
  if (moves.length) return moves;
  blockedCells();
  const m = new Uint8Array(NX * NZ);
  for (let cj = 0; cj < NZ; cj++)
    for (let ci = 0; ci < NX; ci++) {
      if (grid[cj * NX + ci]) continue;
      let bits = 0;
      for (let n = 0; n < 8; n++) {
        const di = MOVE_DI[n];
        const dj = MOVE_DJ[n];
        if (!free(ci + di, cj + dj)) continue;
        if (di && dj && (!free(ci + di, cj) || !free(ci, cj + dj))) continue;
        bits |= 1 << n;
      }
      m[cj * NX + ci] = bits;
    }
  moves = m;
  return m;
}

/** Forgets the grid, its stretches and the landmarks' fields, for a world whose open routes changed (routes.ts): all are built again on first use. */
export function resetNav() {
  grid = new Uint8Array(0);
  area = new Uint16Array(0);
  moves = new Uint8Array(0);
  fields = [];
  weighted = { disk: null, fields: [] };
  landmarkCells = null;
}
function areas(): Uint16Array | Int32Array {
  if (area.length) return area;
  const mv = moveMask();
  // The stretches number a few hundred: two bytes a cell, or four for a world cut into more.
  for (const wide of [false, true]) {
    const label = wide ? new Int32Array(NX * NZ) : new Uint16Array(NX * NZ);
    // A breadth-first fill holds only its front, a ring that grows when it fills.
    let ring = new Int32Array(1 << 16);
    let next = 0;
    for (let k0 = 0; k0 < NX * NZ && (wide || next < 0xffff); k0++) {
      if (grid[k0] || label[k0]) continue;
      next++;
      label[k0] = next;
      let head = 0;
      let size = 0;
      ring[size++] = k0;
      while (size) {
        const cur = ring[head];
        head = (head + 1) & (ring.length - 1);
        size--;
        const bits = mv[cur];
        for (let n = 0; n < 8; n++) {
          if (!(bits & (1 << n))) continue;
          const k = cur + MOVE_OFF[n];
          if (label[k]) continue;
          label[k] = next;
          if (size === ring.length) {
            const grown = new Int32Array(ring.length * 2);
            for (let e = 0; e < size; e++) grown[e] = ring[(head + e) & (ring.length - 1)];
            ring = grown;
            head = 0;
          }
          ring[(head + size) & (ring.length - 1)] = k;
          size++;
        }
      }
    }
    if (wide || next < 0xffff) {
      area = label;
      return label;
    }
  }
  return area;
}

/** True if the straight line between two points crosses no blocked cell. */
export function clearLine(ax: number, az: number, bx: number, bz: number): boolean {
  blockedCells();
  const len = Math.hypot(bx - ax, bz - az);
  const n = Math.ceil(len / (RES * 0.4));
  for (let k = 1; k < n; k++) {
    const t = k / n;
    if (!free(cellX(ax + (bx - ax) * t), cellZ(az + (bz - az) * t))) return false;
  }
  return true;
}

/**
 * Nearest free cell to (x, z), searching outward a few metres. A point in a closed cell
 * (a stairwell, a gap between crates) is matched to a free cell on its own side of the
 * walls round it: the closest one in waist-high sight, or else the closest one.
 */
function nearestFree(x: number, z: number): [number, number] | null {
  const ci = cellX(x);
  const cj = cellZ(z);
  if (free(ci, cj)) return [ci, cj];
  const y = terrainHeight(x, z) + 1;
  let fallback: [number, number] | null = null;
  for (let r = 1; r < 8; r++) {
    const ring: [number, number, number][] = [];
    for (let di = -r; di <= r; di++)
      for (let dj = -r; dj <= r; dj++)
        if (Math.max(Math.abs(di), Math.abs(dj)) === r && free(ci + di, cj + dj)) ring.push([ci + di, cj + dj, Math.hypot(centerX(ci + di) - x, centerZ(cj + dj) - z)]);
    ring.sort((a, b) => a[2] - b[2]);
    for (const [i, j] of ring) {
      fallback ??= [i, j];
      const cx = centerX(i);
      const cz = centerZ(j);
      if (los({ x, y, z }, { x: cx, y: terrainHeight(cx, cz) + 1, z: cz }, true)) return [i, j];
    }
  }
  return fallback;
}

/** Ground within a search's `avoid` costs this many times as much to cross: walked round where a way round is not too long. */
const AVOID = 5;

/*
 * Landmarks for A*'s estimate (the ALT method): fixed points of the map (each POI's middle
 * and the ways off), each with the walking distance from it to the cells round
 * it. By the triangle inequality the walk between two cells is at least the difference of
 * their distances from any landmark, which sees the cliffs, walled basins and ridges a walk
 * goes round; the straight-line estimate does not, and with it a search across a region
 * visits most of the ground in the ellipse round its two ends. The estimate never exceeds
 * the true cost, so a search still finds a shortest way. A field is built the first time a
 * search wants it, and which landmarks a search uses depends only on its two ends, so a path
 * does not depend on what was searched before.
 */
const LANDMARKS = [...POIS, ...EXTRACTS].map((p) => ({ x: p.x, z: p.z }));
/*
 * A field counts distance in seventeenths of a cell: a move along a row costs 17 and a
 * diagonal one 24, under A*'s 1.414 by a sixth of a percent, so a field's distances are never
 * longer than A*'s and fit 16 bits as whole numbers. A cell holds its distance plus one; 0 is
 * a cell past `REACH` (or off the landmark's ground).
 */
const PER_CELL = 17;
const FIELD_COST = MOVE_COST.map((c) => (c === 1 ? PER_CELL : 24));
/** How far a field reaches, in its units: a walk of 1100 m. A cell further out still has the reach for its bound. */
const REACH = Math.round(1100 / RES) * PER_CELL;
/**
 * A field keeps, row by row, only the run of cells from the first it reaches to the last: rows
 * `j0` to `j0 + lo.length - 1`, row j's run from column `lo` to `hi` packed at `off` in `d`.
 * Most of the grid is sea, rock or past the reach, and a field held whole would take 18 MB.
 * A cell outside its row's run is one the field does not reach.
 */
type Field = { d: Uint16Array; j0: number; lo: Int32Array; hi: Int32Array; off: Int32Array };
const fieldAt = (f: Field, i: number, j: number): number => {
  const r = j - f.j0;
  if (r < 0 || r >= f.lo.length || i < f.lo[r] || i > f.hi[r]) return 0;
  return f.d[f.off[r] + i - f.lo[r]];
};
/** Each landmark's field, once built (null for a landmark with no free cell near it). */
let fields: (Field | null | undefined)[] = [];
/** The whole grid while a field is built, kept clear between builds. */
let scratch = new Uint16Array(0);
/*
 * Each landmark's field of the walk to it round `weighted.disk`, whose ground costs AVOID times
 * as much to cross, as A* charges it: for searches whose `avoid` holds that disk (the titan
 * on its post). Its estimate counts the way round, which a field of the plain walk does not:
 * with that alone, a search whose way goes round the titan's sight visits the ground between
 * the straight line and the way round.
 */
let weighted: { disk: { x: number; z: number; r: number } | null; fields: (Field | null | undefined)[] } = { disk: null, fields: [] };
/** Each landmark's free cell, or -1. */
let landmarkCells: Int32Array | null = null;
/** Searches shorter than this many cells as the crow flies do without landmarks: they are cheap anyway. */
const LANDMARK_MIN = 40;
/** A search uses the walks round the disk only when the disk comes within this many metres of the straight line between its ends. */
const DISK_NEAR = 300;

function landmarkCell(n: number): number {
  if (!landmarkCells) {
    landmarkCells = new Int32Array(LANDMARKS.length);
    LANDMARKS.forEach((l, k) => {
      const c = nearestFree(l.x, l.z);
      landmarkCells![k] = c ? c[1] * NX + c[0] : -1;
    });
  }
  return landmarkCells[n];
}

/*
 * The lists of a Dial queue for building a field: the costs are whole numbers no larger than
 * the dearest move, so cells are settled bucket by bucket in order of distance without a
 * heap. List nodes are recycled through a free chain.
 */
const BUCKETS = 24 * AVOID + 1;
let poolCell = new Int32Array(1 << 16);
let poolNext = new Int32Array(1 << 16);

/**
 * Fills `f` with each cell's walk to `from` (plus one). A move costs AVOID times as much when
 * it ends within `disk`, as A* charges it, so the walk is searched backwards from `from`: a
 * cell is reached from its neighbour by the move from the cell into the neighbour.
 */
function fill(from: number, disk: { x: number; z: number; r: number } | null): Field {
  const mv = moveMask();
  if (scratch.length !== NX * NZ) scratch = new Uint16Array(NX * NZ);
  const f = scratch;
  let i0 = NX;
  let i1 = -1;
  let j0 = NZ;
  let j1 = -1;
  const r2 = disk ? disk.r * disk.r : 0;
  const head = new Int32Array(BUCKETS).fill(-1);
  let used = 0;
  let spare = -1;
  const push = (c: number, d: number) => {
    let node = spare;
    if (node >= 0) spare = poolNext[node];
    else {
      if (used === poolCell.length) {
        const cells = new Int32Array(used * 2);
        cells.set(poolCell);
        poolCell = cells;
        const next = new Int32Array(used * 2);
        next.set(poolNext);
        poolNext = next;
      }
      node = used++;
    }
    const b = d % BUCKETS;
    poolCell[node] = c;
    poolNext[node] = head[b];
    head[b] = node;
  };
  f[from] = 1;
  push(from, 0);
  let pending = 1;
  for (let d = 0; pending; d++) {
    const b = d % BUCKETS;
    let node = head[b];
    head[b] = -1;
    while (node >= 0) {
      const cur = poolCell[node];
      const after = poolNext[node];
      poolNext[node] = spare;
      spare = node;
      pending--;
      node = after;
      // A cell is in a bucket once for each time its distance went down; only the last counts.
      if (f[cur] !== d + 1) continue;
      const ci = cur % NX;
      const cj = (cur / NX) | 0;
      if (ci < i0) i0 = ci;
      if (ci > i1) i1 = ci;
      if (cj < j0) j0 = cj;
      if (cj > j1) j1 = cj;
      let times = 1;
      if (disk) {
        const dx = centerX(cur % NX) - disk.x;
        const dz = centerZ((cur / NX) | 0) - disk.z;
        if (dx * dx + dz * dz < r2) times = AVOID;
      }
      const bits = mv[cur];
      for (let m = 0; m < 8; m++) {
        if (!(bits & (1 << m))) continue;
        const next = cur + MOVE_OFF[m];
        const nd = d + FIELD_COST[m] * times;
        const was = f[next];
        if (nd <= REACH && (was === 0 || nd + 1 < was)) {
          f[next] = nd + 1;
          push(next, nd);
          pending++;
        }
      }
    }
  }
  // Row by row into a field of its own, and the scratch cleared for the next build.
  const rows = Math.max(0, j1 - j0 + 1);
  const lo = new Int32Array(rows);
  const hi = new Int32Array(rows);
  const off = new Int32Array(rows);
  let size = 0;
  for (let r = 0; r < rows; r++) {
    const row = (j0 + r) * NX;
    let a = i0;
    let b = i1;
    while (a <= b && !f[row + a]) a++;
    while (b >= a && !f[row + b]) b--;
    lo[r] = a;
    hi[r] = b;
    off[r] = size;
    size += Math.max(0, b - a + 1);
  }
  const d = new Uint16Array(size);
  for (let r = 0; r < rows; r++) {
    if (hi[r] < lo[r]) continue;
    const row = (j0 + r) * NX;
    d.set(f.subarray(row + lo[r], row + hi[r] + 1), off[r]);
    f.fill(0, row + lo[r], row + hi[r] + 1);
  }
  return { d, j0, lo, hi, off };
}

function field(n: number): Field | null {
  const known = fields[n];
  if (known !== undefined) return known;
  const from = landmarkCell(n);
  return (fields[n] = from < 0 ? null : fill(from, null));
}

/** Landmark n's walk round `disk`, kept for that disk (another disk starts the set again). */
function weightedField(n: number, disk: { x: number; z: number; r: number }): Field | null {
  const w = weighted;
  if (!w.disk || w.disk.x !== disk.x || w.disk.z !== disk.z || w.disk.r !== disk.r) {
    w.disk = { ...disk };
    w.fields = [];
  }
  const known = w.fields[n];
  if (known !== undefined) return known;
  const from = landmarkCell(n);
  return (w.fields[n] = from < 0 ? null : fill(from, w.disk));
}

/** A landmark's field for a search, and whether it is a walk round a disk (good only for the bound toward the landmark). */
type Landmark = { f: Field; round: boolean };

/**
 * The landmarks a search from `start` to `goal` (cells) uses: the two nearest the goal and the
 * one nearest the start, on the goal's stretch of ground and reaching it. With `disk` (ground
 * the search's `avoid` covers) near the way, the two by the goal give their walks round it.
 */
function landmarksFor(start: number, goal: number, disk: { x: number; z: number; r: number } | null): Landmark[] {
  const label = areas();
  const near = (c: number) => {
    const x = c % NX;
    const z = (c / NX) | 0;
    const ks: { k: number; d: number }[] = [];
    for (let k = 0; k < LANDMARKS.length; k++) {
      const lc = landmarkCell(k);
      if (lc < 0 || label[lc] !== label[goal]) continue;
      ks.push({ k, d: ((lc % NX) - x) ** 2 + (((lc / NX) | 0) - z) ** 2 });
    }
    return ks.sort((a, b) => a.d - b.d || a.k - b.k).map((e) => e.k);
  };
  const gi = goal % NX;
  const gj = (goal / NX) | 0;
  const ks = near(goal).slice(0, 2);
  const s0 = near(start).find((k) => !ks.includes(k));
  const out: Landmark[] = [];
  for (const k of ks) {
    const f = disk ? weightedField(k, disk) : field(k);
    if (f && fieldAt(f, gi, gj)) out.push({ f, round: !!disk });
  }
  if (s0 !== undefined) {
    const f = field(s0);
    if (f && fieldAt(f, gi, gj)) out.push({ f, round: false });
  }
  return out;
}

/**
 * The disk of `avoid.home` if a search may use the walks round it: it lies inside `avoid`
 * (every cell A* charges for it, A* charges for `avoid` too, so the walks stay no longer than
 * A*'s) and near the straight line between the search's ends.
 */
function diskFor(avoid: Avoid | undefined, sx: number, sz: number, gx: number, gz: number): { x: number; z: number; r: number } | null {
  const home = avoid?.home;
  if (!avoid || !home || Math.hypot(home.x - avoid.x, home.z - avoid.z) + home.r > avoid.r - 0.01) return null;
  const ex = gx - sx;
  const ez = gz - sz;
  const len2 = ex * ex + ez * ez;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((home.x - sx) * ex + (home.z - sz) * ez) / len2)) : 0;
  return Math.hypot(sx + ex * t - home.x, sz + ez * t - home.z) < home.r + DISK_NEAR ? home : null;
}

/*
 * A*'s per-cell scores, kept between searches. A cell's entries count only when its
 * stamp is the current search's, so a search resets just the cells it reaches
 * instead of the whole grid; the stamps are two bytes, and all are cleared when the count of
 * searches runs out. `came` is the move that reached a cell (NONE for none), a byte rather than
 * the cell it came from. Small entries touch less memory, and fresh memory is slow to touch (a
 * page fault for each page).
 */
const NONE = 255;
let gScore = new Float32Array(0);
let came = new Uint8Array(0);
let closed = new Uint8Array(0);
let stamp = new Uint16Array(0);
let search = 0;
const touch = (k: number) => {
  if (stamp[k] === search) return;
  stamp[k] = search;
  gScore[k] = Infinity;
  came[k] = NONE;
  closed[k] = 0;
};

/*
 * A*'s open list: a binary heap of (f, cell) pairs side by side in one array, kept between
 * searches and grown as needed. Which of two cells with the same f comes out first follows
 * from these exact comparisons, and with it the path among equally short ones.
 */
let heap = new Float64Array(1 << 17);
let heapSize = 0;
function heapPush(f: number, k: number) {
  if (heapSize * 2 === heap.length) {
    const grown = new Float64Array(heap.length * 2);
    grown.set(heap);
    heap = grown;
  }
  const h = heap;
  let c = heapSize++;
  while (c > 0) {
    const p = (c - 1) >> 1;
    if (h[p * 2] <= f) break;
    h[c * 2] = h[p * 2];
    h[c * 2 + 1] = h[p * 2 + 1];
    c = p;
  }
  h[c * 2] = f;
  h[c * 2 + 1] = k;
}
function heapPop(): number {
  const h = heap;
  const top = h[1];
  const n = --heapSize;
  if (n) {
    // The last pair sinks from the root, below each child strictly smaller than it.
    const f = h[n * 2];
    const k = h[n * 2 + 1];
    let c = 0;
    for (;;) {
      const l = c * 2 + 1;
      const r = l + 1;
      let m = c;
      let mf = f;
      if (l < n && h[l * 2] < mf) {
        m = l;
        mf = h[l * 2];
      }
      if (r < n && h[r * 2] < mf) {
        m = r;
        mf = h[r * 2];
      }
      if (m === c) break;
      h[c * 2] = mf;
      h[c * 2 + 1] = h[m * 2 + 1];
      c = m;
    }
    h[c * 2] = f;
    h[c * 2 + 1] = k;
  }
  return top;
}

/**
 * Ground a search goes round where the way round is not much longer: a disk whose cells cost
 * AVOID times as much to cross. `home` is a disk inside it that stays where it is (the titan's
 * post), for which the landmarks keep walks round it.
 */
export type Avoid = { x: number; z: number; r: number; home?: { x: number; z: number; r: number } };

/** Waypoints (world x, z) from a to b, or null if unreachable; round `avoid` where the way round is not much longer. */
export function findPath(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  avoid?: Avoid,
): { x: number; z: number }[] | null {
  blockedCells();
  const s = nearestFree(ax, az);
  const g = nearestFree(bx, bz);
  if (!s || !g) return null;
  if (stamp.length !== NX * NZ) {
    gScore = new Float32Array(NX * NZ);
    came = new Uint8Array(NX * NZ);
    closed = new Uint8Array(NX * NZ);
    stamp = new Uint16Array(NX * NZ);
  }
  const start = s[1] * NX + s[0];
  const goal = g[1] * NX + g[0];
  if (areas()[start] !== area[goal]) return null;
  if (++search === 0xffff) {
    stamp.fill(0);
    search = 1;
  }
  touch(start);
  touch(goal);
  const mv = moveMask();
  heapSize = 0;
  const gi = g[0];
  const gj = g[1];
  const lms = Math.max(Math.abs(s[0] - gi), Math.abs(s[1] - gj)) >= LANDMARK_MIN ? landmarksFor(start, goal, diskFor(avoid, centerX(s[0]), centerZ(s[1]), centerX(gi), centerZ(gj))) : [];
  const lmF = lms.map((l) => l.f);
  const lmGoal = lms.map((l) => fieldAt(l.f, gi, gj));
  const lmRound = lms.map((l) => l.round);
  const h = (i: number, j: number, k: number) => {
    const dx = Math.abs(i - gi);
    const dz = Math.abs(j - gj);
    let est = Math.max(dx, dz) + 0.414 * Math.min(dx, dz);
    for (let n = 0; n < lmF.length; n++) {
      const v = fieldAt(lmF[n], i, j);
      // A cell the field does not reach is further than REACH from its landmark. A walk round a
      // disk is not the same both ways, so its field bounds only the way toward the landmark.
      const diff = !v ? REACH + 1 - lmGoal[n] : lmRound[n] ? v - lmGoal[n] : Math.abs(v - lmGoal[n]);
      if (diff > est * PER_CELL) est = diff / PER_CELL;
    }
    return est;
  };
  gScore[start] = 0;
  heapPush(h(s[0], s[1], start), start);
  let expanded = 0;
  const ar2 = avoid ? avoid.r * avoid.r : 0;
  while (heapSize && expanded < 1_500_000) {
    // The heap keeps cells as doubles; as a small integer again the index arithmetic below stays integer.
    const cur = heapPop() | 0;
    if (closed[cur]) continue;
    closed[cur] = 1;
    expanded++;
    if (cur === goal) break;
    const cj = (cur / NX) | 0;
    const ci = cur - cj * NX;
    const bits = mv[cur];
    for (let n = 0; n < 8; n++) {
      if (!(bits & (1 << n))) continue;
      const ni = ci + MOVE_DI[n];
      const nj = cj + MOVE_DJ[n];
      const nIdx = cur + MOVE_OFF[n];
      touch(nIdx);
      let cost = MOVE_COST[n];
      if (avoid) {
        const dx = centerX(ni) - avoid.x;
        const dz = centerZ(nj) - avoid.z;
        if (dx * dx + dz * dz < ar2) cost *= AVOID;
      }
      const ng = gScore[cur] + cost;
      if (ng < gScore[nIdx]) {
        gScore[nIdx] = ng;
        came[nIdx] = n;
        heapPush(ng + h(ni, nj, nIdx), nIdx);
      }
    }
  }
  if (came[goal] === NONE && goal !== start) return null;
  const cells: number[] = [goal];
  for (let c = goal; c !== start; c -= MOVE_OFF[came[c]]) cells.push(c - MOVE_OFF[came[c]]);
  cells.reverse();
  // A straight walk may not reach deeper into `avoid` than its two ends do, or smoothing undoes the way round.
  const cutsAvoid = (px: number, pz: number, qx: number, qz: number): boolean => {
    if (!avoid) return false;
    const ex = qx - px;
    const ez = qz - pz;
    const len2 = ex * ex + ez * ez;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((avoid.x - px) * ex + (avoid.z - pz) * ez) / len2)) : 0;
    const dx = px + ex * t - avoid.x;
    const dz = pz + ez * t - avoid.z;
    const d2 = dx * dx + dz * dz;
    if (d2 >= ar2) return false;
    const p2 = (px - avoid.x) ** 2 + (pz - avoid.z) ** 2;
    const q2 = (qx - avoid.x) ** 2 + (qz - avoid.z) ** 2;
    return d2 < Math.min(p2, q2) - 1e-6;
  };
  // Keep only the cells where a straight walk would be blocked. A cell's centre is worked out
  // where it is wanted: a path holds hundreds of cells and keeps a few.
  const cx = (n: number) => centerX(cells[n] % NX);
  const cz = (n: number) => centerZ((cells[n] / NX) | 0);
  const out: { x: number; z: number }[] = [];
  let fromX = ax;
  let fromZ = az;
  let k = 0;
  while (k < cells.length - 1) {
    let far = k + 1;
    while (far + 1 < cells.length && clearLine(fromX, fromZ, cx(far + 1), cz(far + 1)) && !cutsAvoid(fromX, fromZ, cx(far + 1), cz(far + 1))) far++;
    fromX = cx(far);
    fromZ = cz(far);
    out.push({ x: fromX, z: fromZ });
    k = far;
  }
  out.push({ x: bx, z: bz });
  return out;
}
