/**
 * Routes the streets between the places the world names, for laying them out by hand rather
 * than at load: `npx tsx scripts/ringfall-roads.ts` prints each street's line, found on a 2 m
 * grid round cliffs, high ground, water and everything built (`BUILT`), preferring level ground,
 * and simplified to as few points as keep it clear. Paste the lines into `STREETS` in
 * `src/ringfall/sim/streets.ts`; run it again when what a street passes changes.
 */
import { WORLD } from "../src/ringfall/sim/config";
import { BUILT } from "../src/ringfall/sim/map";
import { highGround, offshore, steepAt, surfaceAt, terrainHeight } from "../src/ringfall/sim/terrain";
import { ROUTE_PLAN } from "../src/ringfall/sim/streets";

const CELL = 2;
const NX = Math.ceil((WORLD.x1 - WORLD.x0) / CELL);
const NZ = Math.ceil((WORLD.z1 - WORLD.z0) / CELL);
const cx = (i: number) => WORLD.x0 + (i + 0.5) * CELL;
const cz = (j: number) => WORLD.z0 + (j + 0.5) * CELL;

// Blocked: cliffs, high ground, the sea and the channel, and within 3 m of anything built that stands
// on the ground (a roof or a deck overhead does not block).
const blocked = new Uint8Array(NX * NZ);
const nearBuilt = new Float32Array(NX * NZ).fill(99);
for (let j = 0; j < NZ; j++)
  for (let i = 0; i < NX; i++) {
    const x = cx(i);
    const z = cz(j);
    if (steepAt(x, z) || highGround(x, z) || offshore(x, z) > -10 || surfaceAt(x, z) === "水路") blocked[j * NX + i] = 1;
  }
for (const b of BUILT) {
  const g = terrainHeight((b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2);
  if (b.y0 > g + 2.6) continue;
  const i0 = Math.max(0, Math.floor((b.x0 - 8 - WORLD.x0) / CELL));
  const i1 = Math.min(NX - 1, Math.floor((b.x1 + 8 - WORLD.x0) / CELL));
  const j0 = Math.max(0, Math.floor((b.z0 - 8 - WORLD.z0) / CELL));
  const j1 = Math.min(NZ - 1, Math.floor((b.z1 + 8 - WORLD.z0) / CELL));
  for (let j = j0; j <= j1; j++)
    for (let i = i0; i <= i1; i++) {
      const d = Math.hypot(Math.max(b.x0 - cx(i), 0, cx(i) - b.x1), Math.max(b.z0 - cz(j), 0, cz(j) - b.z1));
      const k = j * NX + i;
      nearBuilt[k] = Math.min(nearBuilt[k], d);
      if (d < 3.5) blocked[k] = 1;
    }
}

function route(a: readonly [number, number], b: readonly [number, number]): [number, number][] {
  const toCell = (p: readonly [number, number]) => [Math.floor((p[0] - WORLD.x0) / CELL), Math.floor((p[1] - WORLD.z0) / CELL)];
  const [ai, aj] = toCell(a);
  const [bi, bj] = toCell(b);
  const start = aj * NX + ai;
  const goal = bj * NX + bi;
  const g = new Float32Array(NX * NZ).fill(Infinity);
  const from = new Int32Array(NX * NZ).fill(-1);
  const open: [number, number][] = [];
  const push = (k: number, f: number) => {
    open.push([f, k]);
    let n = open.length - 1;
    while (n > 0) {
      const p = (n - 1) >> 1;
      if (open[p][0] <= open[n][0]) break;
      [open[p], open[n]] = [open[n], open[p]];
      n = p;
    }
  };
  const pop = (): number => {
    const top = open[0][1];
    const last = open.pop()!;
    if (open.length) {
      open[0] = last;
      let n = 0;
      for (;;) {
        const l = 2 * n + 1;
        const r = l + 1;
        let m = n;
        if (l < open.length && open[l][0] < open[m][0]) m = l;
        if (r < open.length && open[r][0] < open[m][0]) m = r;
        if (m === n) break;
        [open[m], open[n]] = [open[n], open[m]];
        n = m;
      }
    }
    return top;
  };
  const h = (k: number) => Math.hypot((k % NX) - bi, Math.floor(k / NX) - bj) * CELL;
  g[start] = 0;
  push(start, h(start));
  while (open.length) {
    const k = pop();
    if (k === goal) break;
    const i = k % NX;
    const j = Math.floor(k / NX);
    const y = terrainHeight(cx(i), cz(j));
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const ni = i + di;
      const nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= NX || nj >= NZ) continue;
      const n = nj * NX + ni;
      // A street may start or end in a gate or beside a wall: the last few metres at either end are open.
      const ends = Math.min(Math.hypot(ni - ai, nj - aj), Math.hypot(ni - bi, nj - bj)) * CELL < 10;
      if (blocked[n] && !ends) continue;
      const run = Math.hypot(di, dj) * CELL;
      const rise = Math.abs(terrainHeight(cx(ni), cz(nj)) - y);
      // Level ground first, then room from buildings, so a street keeps to the open.
      const cost = run * (1 + 6 * (rise / run) ** 2 + (nearBuilt[n] < 8 ? 0.6 : 0));
      if (g[k] + cost < g[n]) {
        g[n] = g[k] + cost;
        from[n] = k;
        push(n, g[n] + h(n));
      }
    }
  }
  if (from[goal] < 0) throw new Error(`no way from ${a} to ${b}`);
  const path: [number, number][] = [];
  for (let k = goal; k >= 0; k = from[k]) path.push([cx(k % NX), cz(Math.floor(k / NX))]);
  path.reverse();
  path[0] = [a[0], a[1]];
  path[path.length - 1] = [b[0], b[1]];
  return simplify(path);
}

/** Whether the straight line from p to q stays on open cells. */
function clearLine(p: [number, number], q: [number, number]): boolean {
  const n = Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / 1);
  for (let s = 1; s < n; s++) {
    const x = p[0] + ((q[0] - p[0]) * s) / n;
    const z = p[1] + ((q[1] - p[1]) * s) / n;
    if (blocked[Math.floor((z - WORLD.z0) / CELL) * NX + Math.floor((x - WORLD.x0) / CELL)]) return false;
  }
  return true;
}

/**
 * As few points as keep the line on open cells: from each kept point, straight on to the furthest
 * point of the path still in clear sight, so a street runs in long straight lengths and turns
 * only where something stands in its way.
 */
function simplify(path: [number, number][]): [number, number][] {
  const out = [path[0]];
  let a = 0;
  while (a < path.length - 1) {
    let b = path.length - 1;
    while (b > a + 1 && !clearLine(path[a], path[b])) b--;
    out.push(path[b]);
    a = b;
  }
  // Points a few metres apart are one bend, not a zigzag: keep the first of each run and the end.
  const merged = [out[0]];
  for (let k = 1; k < out.length; k++) {
    const last = merged[merged.length - 1];
    const end = k === out.length - 1;
    if (Math.hypot(out[k][0] - last[0], out[k][1] - last[1]) >= 12 || end) {
      if (end && merged.length > 1 && Math.hypot(out[k][0] - last[0], out[k][1] - last[1]) < 12) merged.pop();
      merged.push(out[k]);
    }
  }
  return merged.map((p) => [Math.round(p[0]), Math.round(p[1])]);
}

for (const r of ROUTE_PLAN) {
  const line: [number, number][] = [];
  for (let k = 0; k + 1 < r.via.length; k++) {
    const leg = route(r.via[k], r.via[k + 1]);
    line.push(...(k === 0 ? leg : leg.slice(1)));
  }
  console.log(`  { name: ${JSON.stringify(r.name)}, half: ${r.half}, line: ${JSON.stringify(line)} },`);
}
