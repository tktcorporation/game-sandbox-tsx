import { PLAYER, WORLD } from "./config";
import { BOXES } from "./map";

/*
 * Ground-level path finding for the bot only (the game never uses it). A 0.5 m grid
 * marks cells a walker on the ground cannot enter; A* finds a way around
 * buildings and rocks, and through doors.
 */

const RES = 0.5;
const N = Math.ceil((WORLD.half * 2) / RES);
const blocked = new Uint8Array(N * N);
const cell = (v: number) => Math.max(0, Math.min(N - 1, Math.floor((v + WORLD.half) / RES)));
const center = (i: number) => -WORLD.half + (i + 0.5) * RES;

{
  // A cell is blocked when any part of it is within a body radius of a box, so a
  // body standing in a free cell never overlaps a wall.
  const r = PLAYER.radius + 0.02;
  for (const b of BOXES) {
    // Only what stops a body standing on the ground: low steps and high floors do not.
    if (b.h <= WORLD.stepUp || b.y0 >= 1.75) continue;
    for (let i = cell(b.x0 - r); i <= cell(b.x1 + r); i++)
      for (let j = cell(b.z0 - r); j <= cell(b.z1 + r); j++) {
        const x0 = -WORLD.half + i * RES;
        const z0 = -WORLD.half + j * RES;
        if (x0 + RES > b.x0 - r && x0 < b.x1 + r && z0 + RES > b.z0 - r && z0 < b.z1 + r) blocked[j * N + i] = 1;
      }
  }
}

const free = (i: number, j: number) => i >= 0 && j >= 0 && i < N && j < N && !blocked[j * N + i];

/** True if the straight line between two points crosses no blocked cell. */
export function clearLine(ax: number, az: number, bx: number, bz: number): boolean {
  const len = Math.hypot(bx - ax, bz - az);
  const n = Math.ceil(len / (RES * 0.4));
  for (let k = 1; k < n; k++) {
    const t = k / n;
    if (!free(cell(ax + (bx - ax) * t), cell(az + (bz - az) * t))) return false;
  }
  return true;
}

/** Nearest free cell to (x, z), searching outward a few metres. */
function nearestFree(x: number, z: number): [number, number] | null {
  const ci = cell(x);
  const cj = cell(z);
  for (let r = 0; r < 8; r++)
    for (let di = -r; di <= r; di++)
      for (let dj = -r; dj <= r; dj++) if (Math.max(Math.abs(di), Math.abs(dj)) === r && free(ci + di, cj + dj)) return [ci + di, cj + dj];
  return null;
}

/**
 * Waypoints (world x, z) from a to b, or null if unreachable. Steps outside `keepIn`
 * (the safe ring, shrunk by a margin) cost extra, so routes around a building stay
 * inside the ring when a way inside exists.
 */
export function findPath(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  keepIn?: { x: number; z: number; r: number },
): { x: number; z: number }[] | null {
  const s = nearestFree(ax, az);
  const g = nearestFree(bx, bz);
  if (!s || !g) return null;
  const start = s[1] * N + s[0];
  const goal = g[1] * N + g[0];
  const gScore = new Float32Array(N * N).fill(Infinity);
  const came = new Int32Array(N * N).fill(-1);
  const closed = new Uint8Array(N * N);
  // Binary heap of [f, index].
  const heap: number[] = [];
  const push = (f: number, idx: number) => {
    heap.push(f, idx);
    let c = heap.length / 2 - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (heap[p * 2] <= heap[c * 2]) break;
      [heap[p * 2], heap[c * 2]] = [heap[c * 2], heap[p * 2]];
      [heap[p * 2 + 1], heap[c * 2 + 1]] = [heap[c * 2 + 1], heap[p * 2 + 1]];
      c = p;
    }
  };
  const pop = (): number => {
    const idx = heap[1];
    const lastIdx = heap.pop()!;
    const lastF = heap.pop()!;
    if (heap.length) {
      heap[0] = lastF;
      heap[1] = lastIdx;
      let c = 0;
      const n = heap.length / 2;
      for (;;) {
        const l = c * 2 + 1;
        const r = l + 1;
        let m = c;
        if (l < n && heap[l * 2] < heap[m * 2]) m = l;
        if (r < n && heap[r * 2] < heap[m * 2]) m = r;
        if (m === c) break;
        [heap[m * 2], heap[c * 2]] = [heap[c * 2], heap[m * 2]];
        [heap[m * 2 + 1], heap[c * 2 + 1]] = [heap[c * 2 + 1], heap[m * 2 + 1]];
        c = m;
      }
    }
    return idx;
  };
  const gi = g[0];
  const gj = g[1];
  const h = (i: number, j: number) => {
    const dx = Math.abs(i - gi);
    const dz = Math.abs(j - gj);
    return Math.max(dx, dz) + 0.414 * Math.min(dx, dz);
  };
  gScore[start] = 0;
  push(h(s[0], s[1]), start);
  let expanded = 0;
  while (heap.length && expanded < 150000) {
    const cur = pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    expanded++;
    if (cur === goal) break;
    const ci = cur % N;
    const cj = (cur / N) | 0;
    for (let di = -1; di <= 1; di++)
      for (let dj = -1; dj <= 1; dj++) {
        if (!di && !dj) continue;
        const ni = ci + di;
        const nj = cj + dj;
        if (!free(ni, nj)) continue;
        if (di && dj && (!free(ci + di, cj) || !free(ci, cj + dj))) continue; // no corner cutting
        const nIdx = nj * N + ni;
        let cost = di && dj ? 1.414 : 1;
        if (keepIn && Math.hypot(center(ni) - keepIn.x, center(nj) - keepIn.z) > keepIn.r) cost += 6;
        const ng = gScore[cur] + cost;
        if (ng < gScore[nIdx]) {
          gScore[nIdx] = ng;
          came[nIdx] = cur;
          push(ng + h(ni, nj), nIdx);
        }
      }
  }
  if (came[goal] < 0 && goal !== start) return null;
  const cells: number[] = [];
  for (let c = goal; c !== -1; c = came[c]) cells.push(c);
  cells.reverse();
  // Keep only the cells where a straight walk would be blocked.
  const pts = cells.map((c) => ({ x: center(c % N), z: center((c / N) | 0) }));
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
