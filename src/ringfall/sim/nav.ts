import { PLAYER, WORLD } from "./config";
import { los, routeBoxesOpen } from "./geom";
import { BOXES, DECKS } from "./map";
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

/** Forgets the grid and its stretches, for a world whose open routes changed (routes.ts): both are built again on first use. */
export function resetNav() {
  grid = new Uint8Array(0);
  area = new Int32Array(0);
  moves = new Uint8Array(0);
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
  const h = (i: number, j: number) => {
    const dx = Math.abs(i - gi);
    const dz = Math.abs(j - gj);
    return Math.max(dx, dz) + 0.414 * Math.min(dx, dz);
  };
  gScore[start] = 0;
  heapPush(h(s[0], s[1]), start);
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
        heapPush(ng + h(ni, nj), nIdx);
      }
    }
  }
  if (came[goal] < 0 && goal !== start) return null;
  const cells: number[] = [];
  for (let c = goal; c !== -1; c = came[c]) cells.push(c);
  cells.reverse();
  // Keep only the cells where a straight walk would be blocked.
  const pts = cells.map((c) => ({ x: centerX(c % NX), z: centerZ((c / NX) | 0) }));
  const out: { x: number; z: number }[] = [];
  let from = { x: ax, z: az };
  let k = 0;
  while (k < pts.length - 1) {
    let far = k + 1;
    while (far + 1 < pts.length && clearLine(from.x, from.z, pts[far + 1].x, pts[far + 1].z)) far++;
    out.push(pts[far]);
    from = pts[far];
    k = far;
  }
  out.push({ x: bx, z: bz });
  return out;
}
