//! Cover spots uploaded once from TypeScript `COVERS` (see `cover.ts`). 16 m spatial squares.

use std::collections::HashMap;

const COVER_SQUARE: f64 = 16.0;
const COVER_TALL: f64 = 1.5;
const COVER_OFFSET: f64 = 0.9;
const COVER_SPACING: f64 = 1.6;
const COVER_PEEK: f64 = 1.4;
pub const COVER_SEARCH: f64 = 14.0;
pub const COVER_LEVEL: f64 = 1.2;
pub const COVER_MIN_FROM_PLAYER: f64 = 6.0;
pub const COVER_MAX_FROM_PLAYER: f64 = 34.0;
pub const COVER_STUCK_PROGRESS: f64 = 0.2;
pub const COVER_STUCK_TIME: f64 = 0.4;

const WX0: f64 = -1340.0;
const WX1: f64 = 1120.0;
const WZ0: f64 = -1220.0;
const WZ1: f64 = 660.0;

#[derive(Clone, Copy)]
pub struct CoverPt {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub tx: f64,
    pub tz: f64,
}

pub struct CoverGrid {
    pts: Vec<CoverPt>,
    squares: HashMap<i64, Vec<u32>>,
    stage: Vec<f32>,
}

impl CoverGrid {
    pub fn new() -> Self {
        Self {
            pts: Vec::new(),
            squares: HashMap::new(),
            stage: Vec::new(),
        }
    }

    pub fn clear(&mut self) {
        self.pts.clear();
        self.squares.clear();
        self.stage.clear();
    }

    pub fn begin(&mut self, n: usize) {
        self.clear();
        self.stage.resize(n * 5, 0.0);
    }

    pub fn stage_ptr(&mut self) -> *mut f32 {
        self.stage.as_mut_ptr()
    }

    pub fn commit(&mut self) {
        let n = self.stage.len() / 5;
        self.pts.reserve(n);
        self.squares.clear();
        for i in 0..n {
            let o = i * 5;
            let p = CoverPt {
                x: self.stage[o] as f64,
                y: self.stage[o + 1] as f64,
                z: self.stage[o + 2] as f64,
                tx: self.stage[o + 3] as f64,
                tz: self.stage[o + 4] as f64,
            };
            let idx = self.pts.len() as u32;
            self.pts.push(p);
            let si = (p.x / COVER_SQUARE).floor() as i32;
            let sj = (p.z / COVER_SQUARE).floor() as i32;
            let key = square_key(si, sj);
            self.squares.entry(key).or_default().push(idx);
        }
        self.stage.clear();
    }

    pub fn ready(&self) -> bool {
        !self.pts.is_empty()
    }

    pub fn get(&self, idx: u32) -> CoverPt {
        self.pts[idx as usize]
    }

    pub fn near(&self, x: f64, z: f64, r: f64) -> Vec<u32> {
        let mut found = Vec::new();
        let i0 = ((x - r) / COVER_SQUARE).floor() as i32;
        let i1 = ((x + r) / COVER_SQUARE).floor() as i32;
        let j0 = ((z - r) / COVER_SQUARE).floor() as i32;
        let j1 = ((z + r) / COVER_SQUARE).floor() as i32;
        for si in i0..=i1 {
            for sj in j0..=j1 {
                if let Some(list) = self.squares.get(&square_key(si, sj)) {
                    for &n in list {
                        found.push(n);
                    }
                }
            }
        }
        found.sort_unstable();
        found.dedup();
        found
    }
}

fn square_key(i: i32, j: i32) -> i64 {
    (i as i64 + 4096) * 8192 + (j as i64 + 4096)
}

fn hypot2(x: f64, z: f64) -> f64 {
    (x * x + z * z).sqrt()
}

fn in_world(x: f64, z: f64, margin: f64) -> bool {
    x >= WX0 + margin && x <= WX1 - margin && z >= WZ0 + margin && z <= WZ1 - margin
}

pub const COVER_PEEK_DIST: f64 = COVER_PEEK;
pub const COVER_TALL_Y: f64 = COVER_TALL;