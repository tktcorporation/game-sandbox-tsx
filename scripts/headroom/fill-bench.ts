/**
 * TS twin of headroom/rust-fill: same Dial fill on a synthetic grid, same checksum.
 *
 *   npx tsx scripts/headroom/fill-bench.ts [nx] [nz] [iters] [wallStep]
 */
const PER_CELL = 17;
const DIAG = 24;
const AVOID = 5;
const BUCKETS = DIAG * AVOID + 1;
const MOVE_DI = [-1, -1, -1, 0, 0, 1, 1, 1];
const MOVE_DJ = [-1, 0, 1, -1, 1, -1, 0, 1];
const MOVE_COST = [DIAG, PER_CELL, DIAG, PER_CELL, PER_CELL, DIAG, PER_CELL, DIAG];

type Field = { d: Uint16Array; j0: number; lo: Int32Array; hi: Int32Array; off: Int32Array };

function fill(nx: number, nz: number, blocked: Uint8Array, moves: Uint8Array, from: number, reach: number): Field {
  const cells = nx * nz;
  const f = new Uint16Array(cells);
  let i0 = nx;
  let i1 = -1;
  let j0 = nz;
  let j1 = -1;
  const head = new Int32Array(BUCKETS).fill(-1);
  let poolCell = new Int32Array(1 << 16);
  let poolNext = new Int32Array(1 << 16);
  let used = 0;
  let spare = -1;
  const push = (c: number, d: number) => {
    let node = spare;
    if (node >= 0) spare = poolNext[node];
    else {
      if (used === poolCell.length) {
        const cells2 = new Int32Array(used * 2);
        cells2.set(poolCell);
        poolCell = cells2;
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
      if (f[cur] !== d + 1) continue;
      const cj = (cur / nx) | 0;
      const ci = cur - cj * nx;
      if (ci < i0) i0 = ci;
      if (ci > i1) i1 = ci;
      if (cj < j0) j0 = cj;
      if (cj > j1) j1 = cj;
      const bits = moves[cur];
      for (let m = 0; m < 8; m++) {
        if (!(bits & (1 << m))) continue;
        const ni = ci + MOVE_DI[m];
        const nj = cj + MOVE_DJ[m];
        if (ni < 0 || nj < 0 || ni >= nx || nj >= nz) continue;
        const next = nj * nx + ni;
        if (blocked[next]) continue;
        const nd = d + MOVE_COST[m];
        const was = f[next];
        if (nd <= reach && (was === 0 || nd + 1 < was)) {
          f[next] = nd + 1;
          push(next, nd);
          pending++;
        }
      }
    }
  }
  const rows = Math.max(0, j1 - j0 + 1);
  const lo = new Int32Array(rows);
  const hi = new Int32Array(rows);
  const off = new Int32Array(rows);
  let size = 0;
  for (let r = 0; r < rows; r++) {
    const row = (j0 + r) * nx;
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
    const row = (j0 + r) * nx;
    d.set(f.subarray(row + lo[r], row + hi[r] + 1), off[r]);
  }
  return { d, j0, lo, hi, off };
}

function buildOpenGrid(nx: number, nz: number, wallStep: number): { blocked: Uint8Array; moves: Uint8Array } {
  const blocked = new Uint8Array(nx * nz);
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      if (i % wallStep === 0 && j % 3 !== 0) blocked[j * nx + i] = 1;
      if (j % wallStep === 0 && i % 3 !== 0) blocked[j * nx + i] = 1;
    }
  const moves = new Uint8Array(nx * nz);
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      if (blocked[j * nx + i]) continue;
      let bits = 0;
      for (let m = 0; m < 8; m++) {
        const ni = i + MOVE_DI[m];
        const nj = j + MOVE_DJ[m];
        if (ni < 0 || nj < 0 || ni >= nx || nj >= nz) continue;
        if (blocked[nj * nx + ni]) continue;
        const di = MOVE_DI[m];
        const dj = MOVE_DJ[m];
        if (di && dj && (blocked[j * nx + (i + di)] || blocked[(j + dj) * nx + i])) continue;
        bits |= 1 << m;
      }
      moves[j * nx + i] = bits;
    }
  return { blocked, moves };
}

function checksum(f: Field): string {
  let h = 1469598103934665603n;
  for (let i = 0; i < f.d.length; i++) {
    h ^= BigInt(f.d[i]);
    h = (h * 1099511628211n) & 0xffffffffffffffffn;
  }
  h ^= BigInt(f.j0 >>> 0);
  h = (h * 1099511628211n) & 0xffffffffffffffffn;
  for (let i = 0; i < f.lo.length; i++) {
    h ^= BigInt(f.lo[i] >>> 0);
    h = (h * 1099511628211n) & 0xffffffffffffffffn;
  }
  for (let i = 0; i < f.hi.length; i++) {
    h ^= BigInt(f.hi[i] >>> 0);
    h = (h * 1099511628211n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

const nx = Number(process.argv[2] ?? 800);
const nz = Number(process.argv[3] ?? 600);
const iters = Number(process.argv[4] ?? 5);
const wallStep = Number(process.argv[5] ?? 40);
const reach = Math.round(1100 / 0.5) * PER_CELL;
const { blocked, moves } = buildOpenGrid(nx, nz, wallStep);
const from = ((nz / 2) | 0) * nx + ((nx / 2) | 0);
fill(nx, nz, blocked, moves, from, reach);
const t0 = performance.now();
let last!: Field;
for (let i = 0; i < iters; i++) last = fill(nx, nz, blocked, moves, from, reach);
const ms = (performance.now() - t0) / iters;
console.log(`ts fill nx=${nx} nz=${nz} cells=${nx * nz} iters=${iters} mean_ms=${ms.toFixed(2)} packed=${last.d.length} checksum=${checksum(last)}`);
