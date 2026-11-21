//! Dial/bucket fill matching `src/ringfall/sim/nav.ts` `fill` bit-for-bit on the packed field.
//! Integer Dial path; optional avoid-disk uses the same f64 centres as the TS (`WORLD` + `RES`).

#![allow(clippy::missing_safety_doc)]

const AVOID: u32 = 5;
const PER_CELL: u32 = 17;
const DIAG: u32 = 24;
const BUCKETS: usize = (DIAG * AVOID + 1) as usize;

const MOVE_DI: [i32; 8] = [-1, -1, -1, 0, 0, 1, 1, 1];
const MOVE_DJ: [i32; 8] = [-1, 0, 1, -1, 1, -1, 0, 1];
const FIELD_COST: [u32; 8] = [DIAG, PER_CELL, DIAG, PER_CELL, PER_CELL, DIAG, PER_CELL, DIAG];

pub struct Engine {
    nx: i32,
    nz: i32,
    moves: Vec<u8>,
    scratch: Vec<u16>,
    move_off: [i32; 8],
    j0: i32,
    lo: Vec<i32>,
    hi: Vec<i32>,
    off: Vec<i32>,
    d: Vec<u16>,
    pool_cell: Vec<i32>,
    pool_next: Vec<i32>,
}

impl Engine {
    fn new(nx: u32, nz: u32) -> Self {
        let nx = nx as i32;
        let nz = nz as i32;
        let cells = (nx as usize).saturating_mul(nz as usize);
        let mut move_off = [0i32; 8];
        for m in 0..8 {
            move_off[m] = MOVE_DJ[m] * nx + MOVE_DI[m];
        }
        Self {
            nx,
            nz,
            moves: vec![0u8; cells],
            scratch: vec![0u16; cells],
            move_off,
            j0: 0,
            lo: Vec::new(),
            hi: Vec::new(),
            off: Vec::new(),
            d: Vec::new(),
            pool_cell: Vec::with_capacity(1 << 16),
            pool_next: Vec::with_capacity(1 << 16),
        }
    }

    fn fill(
        &mut self,
        from: u32,
        reach: u32,
        has_disk: bool,
        disk_x: f64,
        disk_z: f64,
        disk_r: f64,
        wx0: f64,
        wz0: f64,
        res: f64,
    ) {
        let nx = self.nx as usize;
        let nz = self.nz as usize;
        let cells = nx * nz;
        debug_assert_eq!(self.moves.len(), cells);
        debug_assert_eq!(self.scratch.len(), cells);
        let f = &mut self.scratch[..];
        // Scratch stays zero outside the last packed runs (cleared below), as in nav.ts.

        let mut i0 = self.nx;
        let mut i1 = -1i32;
        let mut j0 = self.nz;
        let mut j1 = -1i32;
        let r2 = if has_disk { disk_r * disk_r } else { 0.0 };

        let mut head = [-1i32; BUCKETS];
        self.pool_cell.clear();
        self.pool_next.clear();
        let mut spare = -1i32;

        let push = |c: i32,
                    d: u32,
                    head: &mut [i32; BUCKETS],
                    pool_cell: &mut Vec<i32>,
                    pool_next: &mut Vec<i32>,
                    spare: &mut i32| {
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

        let from = from as usize;
        f[from] = 1;
        push(
            from as i32,
            0,
            &mut head,
            &mut self.pool_cell,
            &mut self.pool_next,
            &mut spare,
        );
        let mut pending = 1u32;
        let mut d = 0u32;
        while pending > 0 {
            let b = (d as usize) % BUCKETS;
            let mut node = head[b];
            head[b] = -1;
            while node >= 0 {
                let cur = self.pool_cell[node as usize] as usize;
                let after = self.pool_next[node as usize];
                self.pool_next[node as usize] = spare;
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
                let mut times = 1u32;
                if has_disk {
                    let dx = wx0 + (ci as f64 + 0.5) * res - disk_x;
                    let dz = wz0 + (cj as f64 + 0.5) * res - disk_z;
                    if dx * dx + dz * dz < r2 {
                        times = AVOID;
                    }
                }
                let bits = self.moves[cur];
                for m in 0..8 {
                    if bits & (1 << m) == 0 {
                        continue;
                    }
                    let next = (cur as i32 + self.move_off[m]) as usize;
                    let nd = d + FIELD_COST[m] * times;
                    let was = f[next];
                    if nd <= reach && (was == 0 || nd + 1 < was as u32) {
                        f[next] = (nd + 1) as u16;
                        push(
                            next as i32,
                            nd,
                            &mut head,
                            &mut self.pool_cell,
                            &mut self.pool_next,
                            &mut spare,
                        );
                        pending += 1;
                    }
                }
            }
            d += 1;
        }

        let rows = if j1 >= j0 { (j1 - j0 + 1) as usize } else { 0 };
        self.j0 = j0;
        self.lo.resize(rows, 0);
        self.hi.resize(rows, 0);
        self.off.resize(rows, 0);
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
            self.lo[r] = a;
            self.hi[r] = b;
            self.off[r] = size;
            size += (b - a + 1).max(0);
        }
        self.d.resize(size as usize, 0);
        for r in 0..rows {
            if self.hi[r] < self.lo[r] {
                continue;
            }
            let row = ((j0 as usize) + r) * nx;
            let mut o = self.off[r] as usize;
            for i in self.lo[r]..=self.hi[r] {
                self.d[o] = f[row + i as usize];
                o += 1;
            }
        }
        // Clear used runs so the next fill starts clean without a full wipe when possible.
        for r in 0..rows {
            if self.hi[r] < self.lo[r] {
                continue;
            }
            let row = ((j0 as usize) + r) * nx;
            for i in self.lo[r]..=self.hi[r] {
                f[row + i as usize] = 0;
            }
        }
        let _ = nz; // grid height kept for API symmetry / future bounds checks
    }
}

#[no_mangle]
pub extern "C" fn ringfall_fill_new(nx: u32, nz: u32) -> *mut Engine {
    if nx == 0 || nz == 0 {
        return std::ptr::null_mut();
    }
    if (nx as u64).saturating_mul(nz as u64) > (isize::MAX as u64) {
        return std::ptr::null_mut();
    }
    Box::into_raw(Box::new(Engine::new(nx, nz)))
}

#[no_mangle]
pub unsafe extern "C" fn ringfall_fill_free(e: *mut Engine) {
    if !e.is_null() {
        drop(Box::from_raw(e));
    }
}

#[no_mangle]
pub unsafe extern "C" fn ringfall_fill_moves_ptr(e: *mut Engine) -> *mut u8 {
    if e.is_null() {
        return std::ptr::null_mut();
    }
    (*e).moves.as_mut_ptr()
}

#[no_mangle]
pub unsafe extern "C" fn ringfall_fill_moves_len(e: *mut Engine) -> u32 {
    if e.is_null() {
        return 0;
    }
    (*e).moves.len() as u32
}

/// Run Dial fill. `has_disk` non-zero enables the avoid-disk cost (AVOID).
#[no_mangle]
pub unsafe extern "C" fn ringfall_fill_run(
    e: *mut Engine,
    from: u32,
    reach: u32,
    has_disk: u32,
    disk_x: f64,
    disk_z: f64,
    disk_r: f64,
    wx0: f64,
    wz0: f64,
    res: f64,
) -> i32 {
    if e.is_null() {
        return -1;
    }
    let eng = &mut *e;
    let cells = eng.moves.len() as u32;
    if from >= cells {
        return -2;
    }
    eng.fill(
        from,
        reach,
        has_disk != 0,
        disk_x,
        disk_z,
        disk_r,
        wx0,
        wz0,
        res,
    );
    0
}

#[no_mangle]
pub unsafe extern "C" fn ringfall_fill_j0(e: *mut Engine) -> i32 {
    if e.is_null() {
        return 0;
    }
    (*e).j0
}

#[no_mangle]
pub unsafe extern "C" fn ringfall_fill_rows(e: *mut Engine) -> u32 {
    if e.is_null() {
        return 0;
    }
    (*e).lo.len() as u32
}

#[no_mangle]
pub unsafe extern "C" fn ringfall_fill_size(e: *mut Engine) -> u32 {
    if e.is_null() {
        return 0;
    }
    (*e).d.len() as u32
}

#[no_mangle]
pub unsafe extern "C" fn ringfall_fill_lo_ptr(e: *mut Engine) -> *const i32 {
    if e.is_null() {
        return std::ptr::null();
    }
    (*e).lo.as_ptr()
}

#[no_mangle]
pub unsafe extern "C" fn ringfall_fill_hi_ptr(e: *mut Engine) -> *const i32 {
    if e.is_null() {
        return std::ptr::null();
    }
    (*e).hi.as_ptr()
}

#[no_mangle]
pub unsafe extern "C" fn ringfall_fill_off_ptr(e: *mut Engine) -> *const i32 {
    if e.is_null() {
        return std::ptr::null();
    }
    (*e).off.as_ptr()
}

#[no_mangle]
pub unsafe extern "C" fn ringfall_fill_d_ptr(e: *mut Engine) -> *const u16 {
    if e.is_null() {
        return std::ptr::null();
    }
    (*e).d.as_ptr()
}
