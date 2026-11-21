//! Minimal Dial/bucket fill matching RINGFALL's landmark field builder shape
//! (nav.ts `fill`): 8-way grid, costs 17/24, REACH capped, packed row runs.
//! Same inputs as the TS twin in scripts/headroom/fill-bench.ts.

use std::env;
use std::time::Instant;

const PER_CELL: u32 = 17;
const DIAG: u32 = 24;
const AVOID: u32 = 5;
const BUCKETS: usize = (DIAG * AVOID + 1) as usize;

const MOVE_DI: [i32; 8] = [-1, -1, -1, 0, 0, 1, 1, 1];
const MOVE_DJ: [i32; 8] = [-1, 0, 1, -1, 1, -1, 0, 1];
const MOVE_COST: [u32; 8] = [DIAG, PER_CELL, DIAG, PER_CELL, PER_CELL, DIAG, PER_CELL, DIAG];

struct Field {
    d: Vec<u16>,
    j0: i32,
    lo: Vec<i32>,
    hi: Vec<i32>,
    off: Vec<i32>,
}

fn fill(nx: usize, nz: usize, blocked: &[u8], moves: &[u8], from: usize, reach: u32) -> Field {
    let cells = nx * nz;
    let mut f = vec![0u16; cells];
    let mut i0 = nx as i32;
    let mut i1 = -1i32;
    let mut j0 = nz as i32;
    let mut j1 = -1i32;

    let mut head = vec![-1i32; BUCKETS];
    let mut pool_cell: Vec<i32> = Vec::with_capacity(1 << 16);
    let mut pool_next: Vec<i32> = Vec::with_capacity(1 << 16);
    let mut spare = -1i32;

    let mut push = |c: i32, d: u32, head: &mut [i32], pool_cell: &mut Vec<i32>, pool_next: &mut Vec<i32>, spare: &mut i32| {
        let node = if *spare >= 0 {
            let n = *spare;
            *spare = pool_next[n as usize];
            n
        } else {
            let n = pool_cell.len() as i32;
            pool_cell.push(0);
            pool_next.push(-1);
            n
        };
        let b = (d as usize) % BUCKETS;
        pool_cell[node as usize] = c;
        pool_next[node as usize] = head[b];
        head[b] = node;
    };

    f[from] = 1;
    push(from as i32, 0, &mut head, &mut pool_cell, &mut pool_next, &mut spare);
    let mut pending = 1u32;
    let mut d = 0u32;
    while pending > 0 {
        let b = (d as usize) % BUCKETS;
        let mut node = head[b];
        head[b] = -1;
        while node >= 0 {
            let cur = pool_cell[node as usize] as usize;
            let after = pool_next[node as usize];
            pool_next[node as usize] = spare;
            spare = node;
            pending -= 1;
            node = after;
            if f[cur] as u32 != d + 1 {
                continue;
            }
            let cj = (cur / nx) as i32;
            let ci = (cur % nx) as i32;
            if ci < i0 {
                i0 = ci;
            }
            if ci > i1 {
                i1 = ci;
            }
            if cj < j0 {
                j0 = cj;
            }
            if cj > j1 {
                j1 = cj;
            }
            let bits = moves[cur];
            for m in 0..8 {
                if bits & (1 << m) == 0 {
                    continue;
                }
                let ni = ci + MOVE_DI[m];
                let nj = cj + MOVE_DJ[m];
                if ni < 0 || nj < 0 || ni >= nx as i32 || nj >= nz as i32 {
                    continue;
                }
                let next = (nj as usize) * nx + ni as usize;
                if blocked[next] != 0 {
                    continue;
                }
                let nd = d + MOVE_COST[m];
                let was = f[next];
                if nd <= reach && (was == 0 || nd + 1 < was as u32) {
                    f[next] = (nd + 1) as u16;
                    push(next as i32, nd, &mut head, &mut pool_cell, &mut pool_next, &mut spare);
                    pending += 1;
                }
            }
        }
        d += 1;
    }

    let rows = if j1 >= j0 { (j1 - j0 + 1) as usize } else { 0 };
    let mut lo = vec![0i32; rows];
    let mut hi = vec![0i32; rows];
    let mut off = vec![0i32; rows];
    let mut size = 0i32;
    for r in 0..rows {
        let row = ((j0 as usize) + r) * nx;
        let mut a = i0;
        let mut b = i1;
        while a <= b && f[row + a as usize] == 0 {
            a += 1;
        }
        while b >= a && f[row + b as usize] == 0 {
            b -= 1;
        }
        lo[r] = a;
        hi[r] = b;
        off[r] = size;
        size += (b - a + 1).max(0);
    }
    let mut dist = vec![0u16; size as usize];
    for r in 0..rows {
        if hi[r] < lo[r] {
            continue;
        }
        let row = ((j0 as usize) + r) * nx;
        let mut o = off[r] as usize;
        for i in lo[r]..=hi[r] {
            dist[o] = f[row + i as usize];
            o += 1;
        }
    }
    Field {
        d: dist,
        j0,
        lo,
        hi,
        off,
    }
}

fn build_open_grid(nx: usize, nz: usize, wall_step: usize) -> (Vec<u8>, Vec<u8>) {
    let mut blocked = vec![0u8; nx * nz];
    for j in 0..nz {
        for i in 0..nx {
            // A sparse lattice of walls, with doors, so the fill walks around.
            if i % wall_step == 0 && j % 3 != 0 {
                blocked[j * nx + i] = 1;
            }
            if j % wall_step == 0 && i % 3 != 0 {
                blocked[j * nx + i] = 1;
            }
        }
    }
    let mut moves = vec![0u8; nx * nz];
    for j in 0..nz {
        for i in 0..nx {
            if blocked[j * nx + i] != 0 {
                continue;
            }
            let mut bits = 0u8;
            for m in 0..8 {
                let ni = i as i32 + MOVE_DI[m];
                let nj = j as i32 + MOVE_DJ[m];
                if ni < 0 || nj < 0 || ni >= nx as i32 || nj >= nz as i32 {
                    continue;
                }
                if blocked[(nj as usize) * nx + ni as usize] != 0 {
                    continue;
                }
                let di = MOVE_DI[m];
                let dj = MOVE_DJ[m];
                if di != 0
                    && dj != 0
                    && (blocked[(j as i32 * nx as i32 + (i as i32 + di)) as usize] != 0
                        || blocked[((j as i32 + dj) * nx as i32 + i as i32) as usize] != 0)
                {
                    continue;
                }
                bits |= 1 << m;
            }
            moves[j * nx + i] = bits;
        }
    }
    (blocked, moves)
}

fn field_checksum(f: &Field) -> u64 {
    // Match the TS twin: i32 values are mixed as their low 32 bits (>>> 0), not sign-extended.
    let mut h: u64 = 1469598103934665603;
    for &v in &f.d {
        h ^= v as u64;
        h = h.wrapping_mul(1099511628211);
    }
    h ^= f.j0 as u32 as u64;
    h = h.wrapping_mul(1099511628211);
    for &v in &f.lo {
        h ^= v as u32 as u64;
        h = h.wrapping_mul(1099511628211);
    }
    for &v in &f.hi {
        h ^= v as u32 as u64;
        h = h.wrapping_mul(1099511628211);
    }
    h
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let nx: usize = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(800);
    let nz: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(600);
    let iters: usize = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(5);
    let wall_step: usize = args.get(4).and_then(|s| s.parse().ok()).unwrap_or(40);
    let reach = (1100.0_f64 / 0.5).round() as u32 * PER_CELL;

    let (blocked, moves) = build_open_grid(nx, nz, wall_step);
    let from = (nz / 2) * nx + (nx / 2);
    // Warm
    let _ = fill(nx, nz, &blocked, &moves, from, reach);

    let t0 = Instant::now();
    let mut last = Field {
        d: vec![],
        j0: 0,
        lo: vec![],
        hi: vec![],
        off: vec![],
    };
    for _ in 0..iters {
        last = fill(nx, nz, &blocked, &moves, from, reach);
    }
    let ms = t0.elapsed().as_secs_f64() * 1000.0 / iters as f64;
    let chk = field_checksum(&last);
    println!(
        "rust fill nx={} nz={} cells={} iters={} mean_ms={:.2} packed={} checksum={:016x}",
        nx,
        nz,
        nx * nz,
        iters,
        ms,
        last.d.len(),
        chk
    );
}
