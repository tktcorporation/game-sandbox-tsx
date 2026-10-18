import { PLAYER, WORLD } from "./config";
import { los, routeBoxesOpen } from "./geom";
import { BOXES, DECKS, ENTRIES, EXTRACTS, POIS } from "./map";
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
let area = new Int32Array(0);

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
  area = new Int32Array(0);
  moves = new Uint8Array(0);
  fields = [];
  store = new Uint16Array(0);
  landmarkCells = null;
}
function areas(): Int32Array {
  if (area.length) return area;
  blockedCells();
  const label = new Int32Array(NX * NZ);
  const queue = new Int32Array(NX * NZ);
  let next = 0;
  for (let k0 = 0; k0 < NX * NZ; k0++) {
    if (grid[k0] || label[k0]) continue;
    next++;
    label[k0] = next;
    let head = 0;
    let tail = 0;
    queue[tail++] = k0;
    while (head < tail) {
      const cur = queue[head++];
      const ci = cur % NX;
      const cj = (cur / NX) | 0;
      for (let di = -1; di <= 1; di++)
        for (let dj = -1; dj <= 1; dj++) {
          if (!di && !dj) continue;
          const ni = ci + di;
          const nj = cj + dj;
          if (!free(ni, nj)) continue;
          if (di && dj && (!free(ci + di, cj) || !free(ci, cj + dj))) continue;
          const n = nj * NX + ni;
          if (label[n]) continue;
          label[n] = next;
          queue[tail++] = n;
        }
    }
  }
  area = label;
  return label;
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

/*
 * Landmarks for A*'s estimate (the ALT method): fixed points of the map (each POI's middle,
 * the ways off and the ways in), each with the walking distance from it to the cells round
 * it. By the triangle inequality the walk between two cells is at least the difference of
 * their distances from any landmark, which sees the cliffs, walled basins and ridges a walk
 * goes round; the straight-line estimate does not, and with it a search across a region
 * visits most of the ground in the ellipse round its two ends. The estimate never exceeds
 * the true cost, so a search still finds a shortest way. A field is built the first time a
 * search wants it, and which landmarks a search uses depends only on its two ends, so a path
 * does not depend on what was searched before.
 */
const LANDMARKS = [...POIS, ...EXTRACTS, ...ENTRIES].map((p) => ({ x: p.x, z: p.z }));
/*
 * A field counts distance in seventeenths of a cell: a move along a row costs 17 and a
 * diagonal one 24, under A*'s 1.414 by a sixth of a percent, so a field's distances are never
 * longer than A*'s and fit 16 bits as whole numbers. A cell holds its distance plus one; 0 is
 * a cell past `REACH` (or off the landmark's ground).
 */
const PER_CELL = 17;
const FIELD_COST = MOVE_COST.map((c) => (c === 1 ? PER_CELL : 24));
/** How far a field reaches, in its units: a walk of 1400 m, about a region's breadth. */
const REACH = Math.round(1400 / RES) * PER_CELL;
/** Each landmark's field, once built (null for a landmark with no free cell near it). */
let fields: (Uint16Array | null | undefined)[] = [];
/** One buffer for all the fields, allocated whole the first time; a field's pages are touched only where it reaches. */
let store = new Uint16Array(0);
/** Each landmark's free cell, or -1. */
let landmarkCells: Int32Array | null = null;
/** Searches shorter than this many cells as the crow flies do without landmarks: they are cheap anyway. */
const LANDMARK_MIN = 40;

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
 * The lists of a Dial queue for building a field: the costs are whole numbers no larger
 * than 24, so cells are settled bucket by bucket in order of distance without a heap. List
 * nodes are recycled through a free chain.
 */
const BUCKETS = 25;
let poolCell = new Int32Array(1 << 16);
let poolNext = new Int32Array(1 << 16);

function field(n: number): Uint16Array | null {
  const known = fields[n];
  if (known !== undefined) return known;
  const from = landmarkCell(n);
  if (from < 0) return (fields[n] = null);
  const mv = moveMask();
  if (store.length !== LANDMARKS.length * NX * NZ) store = new Uint16Array(LANDMARKS.length * NX * NZ);
  const f = store.subarray(n * NX * NZ, (n + 1) * NX * NZ);
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
      const bits = mv[cur];
      for (let m = 0; m < 8; m++) {
        if (!(bits & (1 << m))) continue;
        const next = cur + MOVE_OFF[m];
        const nd = d + FIELD_COST[m];
        const was = f[next];
        if (nd <= REACH && (was === 0 || nd + 1 < was)) {
          f[next] = nd + 1;
          push(next, nd);
          pending++;
        }
      }
    }
  }
  return (fields[n] = f);
}

/** The landmarks a search from `start` to `goal` (cells) uses: the two nearest the goal and the one nearest the start, on the goal's stretch of ground and reaching it. */
function landmarksFor(start: number, goal: number): Uint16Array[] {
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
  const ks = near(goal).slice(0, 2);
  const s0 = near(start).find((k) => !ks.includes(k));
  if (s0 !== undefined) ks.push(s0);
  return ks.map(field).filter((f): f is Uint16Array => !!f && f[goal] !== 0);
}

/*
 * A*'s per-cell scores, kept between searches. A cell's entries count only when its
 * stamp is the current search's, so a search resets just the cells it reaches
 * instead of the whole grid.
 */
let gScore = new Float32Array(0);
let came = new Int32Array(0);
let closed = new Uint8Array(0);
let stamp = new Uint32Array(0);
let search = 0;
const touch = (k: number) => {
  if (stamp[k] === search) return;
  stamp[k] = search;
  gScore[k] = Infinity;
  came[k] = -1;
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

/** Waypoints (world x, z) from a to b, or null if unreachable; round `avoid` where the way round is not much longer. */
export function findPath(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  avoid?: { x: number; z: number; r: number },
): { x: number; z: number }[] | null {
  blockedCells();
  const s = nearestFree(ax, az);
  const g = nearestFree(bx, bz);
  if (!s || !g) return null;
  if (stamp.length !== NX * NZ) {
    gScore = new Float32Array(NX * NZ);
    came = new Int32Array(NX * NZ);
    closed = new Uint8Array(NX * NZ);
    stamp = new Uint32Array(NX * NZ);
  }
  const start = s[1] * NX + s[0];
  const goal = g[1] * NX + g[0];
  if (areas()[start] !== area[goal]) return null;
  if (++search === 0xffffffff) {
    stamp.fill(0);
    search = 1;
  }
  touch(start);
  touch(goal);
  const mv = moveMask();
  heapSize = 0;
  const gi = g[0];
  const gj = g[1];
  const lms = Math.max(Math.abs(s[0] - gi), Math.abs(s[1] - gj)) >= LANDMARK_MIN ? landmarksFor(start, goal) : [];
  const lmGoal = lms.map((f) => f[goal]);
  const h = (i: number, j: number, k: number) => {
    const dx = Math.abs(i - gi);
    const dz = Math.abs(j - gj);
    let est = Math.max(dx, dz) + 0.414 * Math.min(dx, dz);
    for (let n = 0; n < lms.length; n++) {
      const v = lms[n][k];
      // A cell the field does not reach is at least REACH from its landmark.
      const diff = v ? Math.abs(v - lmGoal[n]) : REACH + 1 - lmGoal[n];
      if (diff > est * PER_CELL) est = diff / PER_CELL;
    }
    return est;
  };
  gScore[start] = 0;
  heapPush(h(s[0], s[1], start), start);
  let expanded = 0;
  // Ground within `avoid` costs this many times as much to cross: walked round where a way round is not too long.
  const AVOID = 5;
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
        came[nIdx] = cur;
        heapPush(ng + h(ni, nj, nIdx), nIdx);
      }
    }
  }
  if (came[goal] < 0 && goal !== start) return null;
  const cells: number[] = [];
  for (let c = goal; c !== -1; c = came[c]) cells.push(c);
  cells.reverse();
  // A straight walk may not reach deeper into `avoid` than its two ends do, or smoothing undoes the way round.
  const cutsAvoid = (p: { x: number; z: number }, q: { x: number; z: number }): boolean => {
    if (!avoid) return false;
    const ex = q.x - p.x;
    const ez = q.z - p.z;
    const len2 = ex * ex + ez * ez;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((avoid.x - p.x) * ex + (avoid.z - p.z) * ez) / len2)) : 0;
    const dx = p.x + ex * t - avoid.x;
    const dz = p.z + ez * t - avoid.z;
    const d2 = dx * dx + dz * dz;
    if (d2 >= ar2) return false;
    const p2 = (p.x - avoid.x) ** 2 + (p.z - avoid.z) ** 2;
    const q2 = (q.x - avoid.x) ** 2 + (q.z - avoid.z) ** 2;
    return d2 < Math.min(p2, q2) - 1e-6;
  };
  // Keep only the cells where a straight walk would be blocked.
  const pts = cells.map((c) => ({ x: centerX(c % NX), z: centerZ((c / NX) | 0) }));
  const out: { x: number; z: number }[] = [];
  let from = { x: ax, z: az };
  let k = 0;
  while (k < pts.length - 1) {
    let far = k + 1;
    while (
      far + 1 < pts.length &&
      clearLine(from.x, from.z, pts[far + 1].x, pts[far + 1].z) &&
      !cutsAvoid(from, pts[far + 1])
    )
      far++;
    out.push(pts[far]);
    from = pts[far];
    k = far;
  }
  out.push({ x: bx, z: bz });
  return out;
}
