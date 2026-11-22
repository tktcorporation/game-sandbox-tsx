//! Hunt distance field for engaged walkers (port of `src/ringfall/sim/hunt.ts` nextStep/fieldTo).
//! Open/height grids are uploaded from TypeScript once per world (same cells as TS `grid()`).

use std::collections::VecDeque;

const RES: f64 = 2.0;
const INV_RES: f64 = 0.5;
const STEP: f64 = 1.4;
const AHEAD: usize = 2;
const NEAR: i32 = 3;
const CACHE: usize = 8;
/// PURSUE.reach in config.ts
pub const PURSUE_REACH: f64 = 90.0;

const DI: [i32; 8] = [1, -1, 0, 0, 1, 1, -1, -1];
const DJ: [i32; 8] = [0, 0, 1, -1, 1, -1, 1, -1];

struct Field {
    target: i32,
    dist: Vec<f32>,
    reach: f64,
    /// Cells written finite this build (for cheap clear into spare).
    touched: Vec<i32>,
}

pub struct HuntGrid {
    pub ready: bool,
    nx: i32,
    nz: i32,
    x0: f64,
    z0: f64,
    res: f64,
    open: Vec<u8>,
    height: Vec<f32>,
    main: Vec<u8>,
    mask: Vec<u8>,
    move_offset: [i32; 8],
    move_cost: [f64; 8],
    cache: VecDeque<Field>,
    spare: Vec<Field>,
    settled: Vec<u32>,
    stamp: u32,
    stage_open: Vec<u8>,
    stage_height: Vec<f32>,
    stage_main: Vec<u8>,
    stage_mask: Vec<u8>,
}

impl HuntGrid {
    pub fn new() -> Self {
        let move_cost: [f64; 8] = std::array::from_fn(|n| {
            if DI[n] != 0 && DJ[n] != 0 {
                RES * std::f64::consts::SQRT_2
            } else {
                RES
            }
        });
        Self {
            ready: false,
            nx: 0,
            nz: 0,
            x0: 0.0,
            z0: 0.0,
            res: RES,
            open: Vec::new(),
            height: Vec::new(),
            main: Vec::new(),
            mask: Vec::new(),
            move_offset: [0; 8],
            move_cost,
            cache: VecDeque::new(),
            spare: Vec::new(),
            settled: Vec::new(),
            stamp: 0,
            stage_open: Vec::new(),
            stage_height: Vec::new(),
            stage_main: Vec::new(),
            stage_mask: Vec::new(),
        }
    }

    pub fn clear(&mut self) {
        *self = Self::new();
    }

    pub fn begin(&mut self, nx: i32, nz: i32, x0: f64, z0: f64, res: f64) {
        self.ready = false;
        self.cache.clear();
        self.spare.clear();
        self.nx = nx.max(0);
        self.nz = nz.max(0);
        self.x0 = x0;
        self.z0 = z0;
        self.res = if res > 0.0 { res } else { RES };
        let cells = (self.nx * self.nz) as usize;
        self.stage_open.clear();
        self.stage_open.resize(cells, 0);
        self.stage_height.clear();
        self.stage_height.resize(cells, 0.0);
        self.stage_main.clear();
        self.stage_main.resize(cells, 0);
        self.stage_mask.clear();
        self.stage_mask.resize(cells, 0);
        for n in 0..8 {
            self.move_offset[n] = DJ[n] * self.nx + DI[n];
        }
    }

    pub fn open_ptr(&mut self) -> *mut u8 {
        self.stage_open.as_mut_ptr()
    }

    pub fn height_ptr(&mut self) -> *mut f32 {
        self.stage_height.as_mut_ptr()
    }

    pub fn main_ptr(&mut self) -> *mut u8 {
        self.stage_main.as_mut_ptr()
    }

    pub fn mask_ptr(&mut self) -> *mut u8 {
        self.stage_mask.as_mut_ptr()
    }

    pub fn commit(&mut self) {
        let cells = (self.nx * self.nz) as usize;
        if cells == 0 || self.stage_open.len() != cells {
            self.ready = false;
            return;
        }
        self.open = std::mem::take(&mut self.stage_open);
        self.height = std::mem::take(&mut self.stage_height);
        self.main = std::mem::take(&mut self.stage_main);
        self.mask = std::mem::take(&mut self.stage_mask);
        self.cache.clear();
        self.spare.clear();
        self.ready = true;
    }

    fn idx_x(&self, v: f64) -> i32 {
        (((v - self.x0) / self.res).floor() as i32).clamp(0, self.nx - 1)
    }
    fn idx_z(&self, v: f64) -> i32 {
        (((v - self.z0) / self.res).floor() as i32).clamp(0, self.nz - 1)
    }
    fn centre_x(&self, i: i32) -> f64 {
        self.x0 + (i as f64 + 0.5) * self.res
    }
    fn centre_z(&self, j: i32) -> f64 {
        self.z0 + (j as f64 + 0.5) * self.res
    }

    fn steps(&self, k: i32, n: usize) -> i32 {
        let i = k % self.nx;
        let j = (k - i) / self.nx;
        let a = i + DI[n];
        let b = j + DJ[n];
        if a < 0 || b < 0 || a >= self.nx || b >= self.nz {
            return -1;
        }
        let q = b * self.nx + a;
        if self.open[q as usize] == 0
            || (self.height[q as usize] as f64 - self.height[k as usize] as f64).abs() > STEP
        {
            return -1;
        }
        if DI[n] != 0
            && DJ[n] != 0
            && (self.open[(j * self.nx + a) as usize] == 0
                || self.open[(b * self.nx + i) as usize] == 0)
        {
            return -1;
        }
        q
    }

    fn open_cell(&self, x: f64, z: f64) -> i32 {
        // Match hunt.ts openCell: nearest main-ground cell by centre, expanding rings.
        let mut best = -1i32;
        let mut best_d = f64::INFINITY;
        let ci = self.idx_x(x);
        let cj = self.idx_z(z);
        let mut last = 12i32;
        for r in 0..=last {
            for dj in -r..=r {
                for di in -r..=r {
                    if di.abs().max(dj.abs()) != r {
                        continue;
                    }
                    let i = ci + di;
                    let j = cj + dj;
                    if i < 0 || j < 0 || i >= self.nx || j >= self.nz {
                        continue;
                    }
                    let k = j * self.nx + i;
                    if self.main[k as usize] == 0 {
                        continue;
                    }
                    let dx = self.centre_x(i) - x;
                    let dz = self.centre_z(j) - z;
                    let d = (dx * dx + dz * dz).sqrt();
                    if d < best_d {
                        best_d = d;
                        best = k;
                        last = last.min(r + 1);
                    }
                }
            }
        }
        best
    }

    pub fn on_main(&self, x: f64, z: f64) -> bool {
        if !self.ready || self.nx <= 0 {
            return false;
        }
        let i = self.idx_x(x);
        let j = self.idx_z(z);
        self.main[(j * self.nx + i) as usize] != 0
    }

    fn take_scratch(&mut self, cells: usize) -> Field {
        if let Some(mut f) = self.spare.pop() {
            if f.dist.len() == cells {
                for &k in &f.touched {
                    f.dist[k as usize] = f32::INFINITY;
                }
                f.touched.clear();
                return f;
            }
        }
        Field {
            target: -1,
            dist: vec![f32::INFINITY; cells],
            reach: 0.0,
            touched: Vec::with_capacity(4096),
        }
    }

    fn build_field(&mut self, target: i32, reach: f64) -> Field {
        let cells = (self.nx * self.nz) as usize;
        let mut f = self.take_scratch(cells);
        f.target = target;
        const RING: usize = 4;
        let mut ring: [Vec<i32>; RING] = [Vec::new(), Vec::new(), Vec::new(), Vec::new()];
        let mut size = [0usize; RING];
        f.dist[target as usize] = 0.0;
        f.touched.push(target);
        ring[0].push(target);
        size[0] = 1;
        let mut pending = 1usize;
        let mut b = 0i32;
        let mut mark = vec![0u8; cells];
        let reach_ext = if reach.is_finite() {
            reach + (NEAR as f64) * RES * 1.5
        } else {
            reach
        };
        f.reach = reach_ext;
        if self.settled.len() != cells {
            self.settled = vec![0u32; cells];
            self.stamp = 0;
        }
        self.stamp = self.stamp.wrapping_add(1);
        if self.stamp == 0 {
            self.settled.fill(0);
            self.stamp = 1;
        }
        let stamp = self.stamp;
        while pending > 0 {
            let r = (b as usize) & (RING - 1);
            let n = size[r];
            size[r] = 0;
            pending = pending.saturating_sub(n);
            let list = std::mem::take(&mut ring[r]);
            let mut bucket = Vec::with_capacity(n);
            for &k in &list {
                let ku = k as usize;
                if self.settled[ku] == stamp || ((f.dist[ku] as f64 * INV_RES) as i32) != b {
                    continue;
                }
                self.settled[ku] = stamp;
                bucket.push(k);
            }
            for &k in &bucket {
                let bits = self.mask[k as usize];
                if bits == 0 {
                    continue;
                }
                let dk = f.dist[k as usize] as f64;
                for q0 in 0..8 {
                    if bits & (1 << q0) == 0 {
                        continue;
                    }
                    let q = k + self.move_offset[q0];
                    let qu = q as usize;
                    if self.settled[qu] == stamp {
                        continue;
                    }
                    let d = dk + self.move_cost[q0];
                    if reach_ext.is_finite() && d > reach_ext {
                        continue;
                    }
                    if (d as f32) < f.dist[qu] {
                        if f.dist[qu].is_infinite() {
                            f.touched.push(q);
                        }
                        f.dist[qu] = d as f32;
                        let into = ((f.dist[qu] as f64 * INV_RES) as i32 as usize) & (RING - 1);
                        ring[into].push(q);
                        size[into] += 1;
                        pending += 1;
                    }
                }
            }
            b += 1;
            if b > 200_000 {
                break;
            }
        }
        f
    }

    fn ensure_field(&mut self, gx: f64, gz: f64, reach: f64) -> Option<usize> {
        let target = self.open_cell(gx, gz);
        if target < 0 {
            return None;
        }
        let ti = target % self.nx;
        let tj = (target - ti) / self.nx;
        let mut hit: Option<usize> = None;
        let mut hit_d = i32::MAX;
        for (idx, f) in self.cache.iter().enumerate() {
            let fi = f.target % self.nx;
            let fj = (f.target - fi) / self.nx;
            let d = (fi - ti).abs().max((fj - tj).abs());
            if d > NEAR || d >= hit_d {
                continue;
            }
            let walk = f.dist[target as usize] as f64;
            let ok_reach = f.reach
                >= reach
                    + if f.reach.is_finite() {
                        walk
                    } else {
                        0.0
                    };
            if walk <= (NEAR as f64) * RES * 1.5 && ok_reach {
                hit = Some(idx);
                hit_d = d;
            }
        }
        if let Some(idx) = hit {
            let f = self.cache.remove(idx).unwrap();
            self.cache.push_back(f);
            return Some(self.cache.len() - 1);
        }
        let built = self.build_field(target, reach);
        self.cache.push_back(built);
        while self.cache.len() > CACHE {
            let drop_i = self
                .cache
                .iter()
                .position(|g| g.reach.is_finite())
                .unwrap_or(0);
            if let Some(old) = self.cache.remove(drop_i) {
                self.spare.push(old);
            }
        }
        Some(self.cache.len() - 1)
    }

    /// Next waypoint toward (gx,gz) from (x,z), or the goal itself.
    pub fn next_via(&mut self, x: f64, z: f64, gx: f64, gz: f64, reach: f64) -> (f64, f64) {
        if !self.ready {
            return (gx, gz);
        }
        let idx = match self.ensure_field(gx, gz, reach) {
            Some(i) => i,
            None => return (gx, gz),
        };
        let f = &self.cache[idx];
        let mut k = self.open_cell(x, z);
        if k < 0 || !f.dist[k as usize].is_finite() {
            return (gx, gz);
        }
        let target = f.target;
        for _ in 0..AHEAD {
            if k == target {
                return (gx, gz);
            }
            let mut best = k;
            let best_d = f.dist[k as usize];
            for n in 0..8 {
                let q = self.steps(k, n);
                if q >= 0 && f.dist[q as usize] < f.dist[best as usize] {
                    best = q;
                }
            }
            if best == k || f.dist[best as usize] >= best_d {
                break;
            }
            k = best;
        }
        let i = k % self.nx;
        let j = (k - i) / self.nx;
        (self.centre_x(i), self.centre_z(j))
    }
}
