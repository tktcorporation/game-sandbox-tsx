//! Shared RINGFALL nav/sim WASM (browser + Node). Dial fill + A*, plus a coarse tick host
//! (`sim` module: enemy/orb SoA, world geom, `step_tick`). See docs/ringfall/native.md.
//!
//! Dial/bucket fill matches `src/ringfall/sim/nav.ts` `fill` on the packed field.
//! Integer Dial path; optional avoid-disk uses the same f64 centres as the TS (`WORLD` + `RES`).

#![allow(clippy::missing_safety_doc)]

mod sim;

const AVOID: u32 = 5;
const PER_CELL: u32 = 17;
const DIAG: u32 = 24;
const BUCKETS: usize = (DIAG * AVOID + 1) as usize;

const MOVE_DI: [i32; 8] = [-1, -1, -1, 0, 0, 1, 1, 1];
const MOVE_DJ: [i32; 8] = [-1, 0, 1, -1, 1, -1, 0, 1];
const FIELD_COST: [u32; 8] = [DIAG, PER_CELL, DIAG, PER_CELL, PER_CELL, DIAG, PER_CELL, DIAG];
/// Same literals as nav.ts `MOVE_COST` (diagonal 1.414).
const MOVE_COST_F: [f64; 8] = [1.414, 1.0, 1.414, 1.0, 1.0, 1.414, 1.0, 1.414];
const NONE: u8 = 255;
const LANDMARK_SLOTS: usize = 64;

#[derive(Clone, Default)]
struct PackedField {
    j0: i32,
    lo: Vec<i32>,
    hi: Vec<i32>,
    off: Vec<i32>,
    d: Vec<u16>,
}

impl PackedField {
    fn at(&self, i: i32, j: i32) -> u16 {
        let r = j - self.j0;
        if r < 0 || r as usize >= self.lo.len() {
            return 0;
        }
        let r = r as usize;
        if i < self.lo[r] || i > self.hi[r] {
            return 0;
        }
        self.d[(self.off[r] + i - self.lo[r]) as usize]
    }
}

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
    /// Landmark plain/weighted fields uploaded for A* (index = slot).
    fields: Vec<Option<PackedField>>,
    /// A* scratch: 8 bytes/cell (f32 g, u16 stamp, u8 came, u8 closed) via raw parts.
    rec: Vec<u8>,
    search_id: u16,
    heap: Vec<f64>,
    heap_size: usize,
    path: Vec<i32>,
    wx0: f64,
    wz0: f64,
    res: f64,
    reach: u32,
    lm_slot: [u8; 8],
    lm_round: [u8; 8],
    up_lo: Vec<i32>,
    up_hi: Vec<i32>,
    up_off: Vec<i32>,
    up_d: Vec<u16>,
    /// Expanded landmark fields for fast A* heuristics (0 = unreachable).
    flat: Vec<Vec<u16>>,
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
            fields: vec![None; LANDMARK_SLOTS],
            rec: Vec::new(),
            search_id: 0,
            heap: vec![0f64; 1 << 18],
            heap_size: 0,
            path: Vec::new(),
            wx0: 0.0,
            wz0: 0.0,
            res: 0.5,
            reach: 0,
            lm_slot: [0; 8],
            lm_round: [0; 8],
            up_lo: Vec::new(),
            up_hi: Vec::new(),
            up_off: Vec::new(),
            up_d: Vec::new(),
            flat: vec![Vec::new(); LANDMARK_SLOTS],
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

    fn set_world(&mut self, wx0: f64, wz0: f64, res: f64, reach: u32) {
        self.wx0 = wx0;
        self.wz0 = wz0;
        self.res = res;
        self.reach = reach;
    }

    fn expand_flat(&mut self, slot: usize) {
        let cells = (self.nx as usize) * (self.nz as usize);
        let nx = self.nx;
        let Some(f) = self.fields.get(slot).and_then(|x| x.as_ref()) else {
            self.flat[slot].clear();
            return;
        };
        let mut flat = vec![0u16; cells];
        for r in 0..f.lo.len() {
            if f.hi[r] < f.lo[r] { continue; }
            let j = f.j0 + r as i32;
            let row = (j as usize) * (nx as usize);
            let mut o = f.off[r] as usize;
            for i in f.lo[r]..=f.hi[r] {
                flat[row + i as usize] = f.d[o];
                o += 1;
            }
        }
        self.flat[slot] = flat;
    }

    fn store_last_field(&mut self, slot: usize) {
        if slot >= LANDMARK_SLOTS {
            return;
        }
        self.fields[slot] = Some(PackedField {
            j0: self.j0,
            lo: self.lo.clone(),
            hi: self.hi.clone(),
            off: self.off.clone(),
            d: self.d.clone(),
        });
        self.flat[slot].clear(); // expand lazily on A*
    }

    fn upload_field(&mut self, slot: usize, j0: i32, lo: &[i32], hi: &[i32], off: &[i32], d: &[u16]) {
        if slot >= LANDMARK_SLOTS {
            return;
        }
        self.fields[slot] = Some(PackedField {
            j0,
            lo: lo.to_vec(),
            hi: hi.to_vec(),
            off: off.to_vec(),
            d: d.to_vec(),
        });
        self.flat[slot].clear();
    }

    fn field_at_flat(flat: &[Vec<u16>], slot: usize, idx: usize) -> u16 {
        flat.get(slot).and_then(|f| f.get(idx).copied()).unwrap_or(0)
    }

    fn stamp_of(rec: &[u8], k: usize) -> u16 {
        let o = k * 8 + 4;
        u16::from_le_bytes([rec[o], rec[o + 1]])
    }

    fn set_stamp(rec: &mut [u8], k: usize, s: u16) {
        let o = k * 8 + 4;
        let b = s.to_le_bytes();
        rec[o] = b[0];
        rec[o + 1] = b[1];
    }

    fn g_of(rec: &[u8], k: usize) -> f32 {
        let o = k * 8;
        f32::from_le_bytes([rec[o], rec[o + 1], rec[o + 2], rec[o + 3]])
    }

    fn set_g(rec: &mut [u8], k: usize, g: f32) {
        let o = k * 8;
        let b = g.to_le_bytes();
        rec[o] = b[0];
        rec[o + 1] = b[1];
        rec[o + 2] = b[2];
        rec[o + 3] = b[3];
    }

    fn touch(&mut self, k: usize) {
        if Self::stamp_of(&self.rec, k) == self.search_id {
            return;
        }
        Self::set_stamp(&mut self.rec, k, self.search_id);
        Self::set_g(&mut self.rec, k, f32::INFINITY);
        self.rec[k * 8 + 6] = NONE;
        self.rec[k * 8 + 7] = 0;
    }

    fn heap_push(&mut self, f: f64, k: i32) {
        if self.heap_size * 2 + 2 > self.heap.len() {
            self.heap.resize(self.heap.len() * 2, 0.0);
        }
        let mut c = self.heap_size;
        self.heap_size += 1;
        while c > 0 {
            let p = (c - 1) >> 1;
            if self.heap[p * 2] <= f {
                break;
            }
            self.heap[c * 2] = self.heap[p * 2];
            self.heap[c * 2 + 1] = self.heap[p * 2 + 1];
            c = p;
        }
        self.heap[c * 2] = f;
        self.heap[c * 2 + 1] = k as f64;
    }

    fn heap_pop(&mut self) -> i32 {
        let top = self.heap[1] as i32;
        self.heap_size -= 1;
        let n = self.heap_size;
        if n > 0 {
            let f = self.heap[n * 2];
            let k = self.heap[n * 2 + 1];
            let mut c = 0usize;
            loop {
                let l = c * 2 + 1;
                let r = l + 1;
                let mut m = c;
                let mut mf = f;
                if l < n && self.heap[l * 2] < mf {
                    m = l;
                    mf = self.heap[l * 2];
                }
                if r < n && self.heap[r * 2] < mf {
                    m = r;
                    mf = self.heap[r * 2];
                }
                if m == c {
                    break;
                }
                self.heap[c * 2] = mf;
                self.heap[c * 2 + 1] = self.heap[m * 2 + 1];
                c = m;
            }
            self.heap[c * 2] = f;
            self.heap[c * 2 + 1] = k;
        }
        top
    }

    /// A* matching nav.ts `searchCells`. Landmark slots in `lm_slot`/`lm_round` (len `lm_n`).
    fn astar(
        &mut self,
        start: i32,
        goal: i32,
        si: i32,
        sj: i32,
        gi: i32,
        gj: i32,
        has_avoid: bool,
        avoid_x: f64,
        avoid_z: f64,
        avoid_r: f64,
        lm_slot: &[u8],
        lm_round: &[u8],
    ) -> bool {
        let nx = self.nx;
        let cells = (nx as usize) * (self.nz as usize);
        if start < 0 || goal < 0 || start as usize >= cells || goal as usize >= cells {
            return false;
        }
        if self.rec.len() != cells * 8 {
            self.rec.resize(cells * 8, 0);
        }
        if self.search_id == 0xffff {
            for k in 0..cells {
                Self::set_stamp(&mut self.rec, k, 0);
            }
            self.search_id = 0;
        }
        self.search_id = self.search_id.wrapping_add(1);
        if self.search_id == 0 {
            self.search_id = 1;
        }
        self.touch(start as usize);
        self.touch(goal as usize);
        self.heap_size = 0;

        let lm_n = lm_slot.len().min(lm_round.len());
        for n in 0..lm_n {
            let slot = lm_slot[n] as usize;
            if self.flat.get(slot).map(|f| f.is_empty()).unwrap_or(true) {
                self.expand_flat(slot);
            }
        }
        let goal_idx = (gj * nx + gi) as usize;
        let mut lm_goal = [0f64; 8];
        for n in 0..lm_n {
            lm_goal[n] = Self::field_at_flat(&self.flat, lm_slot[n] as usize, goal_idx) as f64;
        }
        let reach = self.reach as f64;
        let per = PER_CELL as f64;
        let wx0 = self.wx0;
        let wz0 = self.wz0;
        let res = self.res;
        let ar2 = if has_avoid { avoid_r * avoid_r } else { 0.0 };
        let nx_usize = nx as usize;

        let h = |flat: &[Vec<u16>], i: i32, j: i32| -> f64 {
            let dx = (i - gi).abs() as f64;
            let dz = (j - gj).abs() as f64;
            let mut est = dx.max(dz) + 0.414 * dx.min(dz);
            let idx = (j as usize) * nx_usize + i as usize;
            for n in 0..lm_n {
                let v = Self::field_at_flat(flat, lm_slot[n] as usize, idx) as f64;
                let diff = if v == 0.0 {
                    reach + 1.0 - lm_goal[n]
                } else if lm_round[n] != 0 {
                    v - lm_goal[n]
                } else {
                    (v - lm_goal[n]).abs()
                };
                if diff > est * per {
                    est = diff / per;
                }
            }
            est
        };

        Self::set_g(&mut self.rec, start as usize, 0.0);
        let h0 = h(&self.flat, si, sj);
        self.heap_push(h0, start);

        let mut expanded = 0u32;
        while self.heap_size > 0 && expanded < 1_500_000 {
            let cur = self.heap_pop();
            let cur_u = cur as usize;
            if self.rec[cur_u * 8 + 7] != 0 {
                continue;
            }
            self.rec[cur_u * 8 + 7] = 1;
            expanded += 1;
            if cur == goal {
                break;
            }
            let cj = cur / nx;
            let ci = cur - cj * nx;
            let bits = self.moves[cur_u];
            let g_cur = Self::g_of(&self.rec, cur_u) as f64;
            for n in 0..8 {
                if bits & (1 << n) == 0 {
                    continue;
                }
                let ni = ci + MOVE_DI[n];
                let nj = cj + MOVE_DJ[n];
                let n_idx = cur + self.move_off[n];
                let n_u = n_idx as usize;
                self.touch(n_u);
                let mut cost = MOVE_COST_F[n];
                if has_avoid {
                    let dx = wx0 + (ni as f64 + 0.5) * res - avoid_x;
                    let dz = wz0 + (nj as f64 + 0.5) * res - avoid_z;
                    if dx * dx + dz * dz < ar2 {
                        cost *= AVOID as f64;
                    }
                }
                let ng = g_cur + cost;
                let was = Self::g_of(&self.rec, n_u) as f64;
                if ng < was {
                    Self::set_g(&mut self.rec, n_u, ng as f32);
                    self.rec[n_u * 8 + 6] = n as u8;
                    let fscore = ng + h(&self.flat, ni, nj);
                    self.heap_push(fscore, n_idx);
                }
            }
        }

        if self.rec[goal as usize * 8 + 6] == NONE && goal != start {
            self.path.clear();
            return false;
        }
        self.path.clear();
        self.path.push(goal);
        let mut c = goal;
        while c != start {
            let came = self.rec[c as usize * 8 + 6] as usize;
            c -= self.move_off[came];
            self.path.push(c);
        }
        self.path.reverse();
        true
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


#[no_mangle]
pub unsafe extern "C" fn ringfall_nav_set_world(e: *mut Engine, wx0: f64, wz0: f64, res: f64, reach: u32) {
    if e.is_null() { return; }
    (*e).set_world(wx0, wz0, res, reach);
}

#[no_mangle]
pub unsafe extern "C" fn ringfall_nav_store_last(e: *mut Engine, slot: u32) {
    if e.is_null() { return; }
    (*e).store_last_field(slot as usize);
}


#[no_mangle]
pub unsafe extern "C" fn ringfall_nav_lm_slot_ptr(e: *mut Engine) -> *mut u8 {
    if e.is_null() { return std::ptr::null_mut(); }
    (*e).lm_slot.as_mut_ptr()
}

#[no_mangle]
pub unsafe extern "C" fn ringfall_nav_lm_round_ptr(e: *mut Engine) -> *mut u8 {
    if e.is_null() { return std::ptr::null_mut(); }
    (*e).lm_round.as_mut_ptr()
}

#[no_mangle]
pub unsafe extern "C" fn ringfall_nav_upload_begin(e: *mut Engine, rows: u32, size: u32) -> i32 {
    if e.is_null() { return -1; }
    let eng = &mut *e;
    eng.up_lo.resize(rows as usize, 0);
    eng.up_hi.resize(rows as usize, 0);
    eng.up_off.resize(rows as usize, 0);
    eng.up_d.resize(size as usize, 0);
    0
}

#[no_mangle]
pub unsafe extern "C" fn ringfall_nav_upload_lo_ptr(e: *mut Engine) -> *mut i32 {
    if e.is_null() { return std::ptr::null_mut(); }
    (*e).up_lo.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_nav_upload_hi_ptr(e: *mut Engine) -> *mut i32 {
    if e.is_null() { return std::ptr::null_mut(); }
    (*e).up_hi.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_nav_upload_off_ptr(e: *mut Engine) -> *mut i32 {
    if e.is_null() { return std::ptr::null_mut(); }
    (*e).up_off.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_nav_upload_d_ptr(e: *mut Engine) -> *mut u16 {
    if e.is_null() { return std::ptr::null_mut(); }
    (*e).up_d.as_mut_ptr()
}

#[no_mangle]
pub unsafe extern "C" fn ringfall_nav_upload_commit(e: *mut Engine, slot: u32, j0: i32) -> i32 {
    if e.is_null() { return -1; }
    let eng = &mut *e;
    eng.upload_field(slot as usize, j0, &eng.up_lo.clone(), &eng.up_hi.clone(), &eng.up_off.clone(), &eng.up_d.clone());
    0
}
/// Landmark slots must be written to `ringfall_nav_lm_slot_ptr` / `_round_ptr` first.
/// Returns 1 if path found, 0 if none, <0 on error.
#[no_mangle]
pub unsafe extern "C" fn ringfall_nav_astar(
    e: *mut Engine,
    start: i32,
    goal: i32,
    si: i32,
    sj: i32,
    gi: i32,
    gj: i32,
    has_avoid: u32,
    avoid_x: f64,
    avoid_z: f64,
    avoid_r: f64,
    lm_n: u32,
) -> i32 {
    if e.is_null() { return -1; }
    let lm_n = lm_n.min(8) as usize;
    let eng = &mut *e;
    let lm_slot = eng.lm_slot[..lm_n].to_vec();
    let lm_round = eng.lm_round[..lm_n].to_vec();
    let ok = eng.astar(
        start, goal, si, sj, gi, gj,
        has_avoid != 0, avoid_x, avoid_z, avoid_r,
        &lm_slot, &lm_round,
    );
    if ok { 1 } else { 0 }
}

#[no_mangle]
pub unsafe extern "C" fn ringfall_nav_path_len(e: *mut Engine) -> u32 {
    if e.is_null() { return 0; }
    (*e).path.len() as u32
}

#[no_mangle]
pub unsafe extern "C" fn ringfall_nav_path_ptr(e: *mut Engine) -> *const i32 {
    if e.is_null() { return std::ptr::null(); }
    (*e).path.as_ptr()
}

/// Bump when the coarse tick / memory layout contract changes (docs/ringfall/native.md).
pub const SIM_ABI_VERSION: u32 = 2;

#[no_mangle]
pub extern "C" fn ringfall_sim_abi_version() -> u32 {
    SIM_ABI_VERSION
}

/// Advance the in-WASM sim by `dt` seconds (orbs today; enemies still TS).
/// Returns 0 on success, -1 if geom/SoA not ready.
#[no_mangle]
pub extern "C" fn ringfall_step_tick(dt: f32) -> i32 {
    sim::ringfall_sim_step_tick(dt)
}
