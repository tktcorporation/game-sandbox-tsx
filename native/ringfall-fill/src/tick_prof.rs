//! Optional section timers for the coarse tick (host clock via `env.ringfall_now_ns`).
//! Off by default — zero cost when `enabled == 0`.

/// Indices into `TickProf::ns` / exported f64 buffer (ms when read from JS).
pub const SEC_SENSE: usize = 0;
pub const SEC_CALM: usize = 1;
pub const SEC_FIGHT_FOE: usize = 2;
pub const SEC_COVER: usize = 3;
pub const SEC_HUNT: usize = 4;
pub const SEC_ENGAGED: usize = 5;
pub const SEC_ORBS: usize = 6;
pub const SEC_ENEMIES: usize = 7;
pub const SEC_TICK: usize = 8;
pub const SEC_N: usize = 9;

pub const CNT_HUNT_BUILDS: usize = 0;
pub const CNT_HUNT_CELLS: usize = 1;
pub const CNT_CALM: usize = 2;
pub const CNT_FIGHT: usize = 3;
pub const CNT_COVER: usize = 4;
pub const CNT_SENSE: usize = 5;
pub const CNT_ENGAGED: usize = 6;
pub const CNT_N: usize = 7;

#[link(wasm_import_module = "env")]
extern "C" {
    fn ringfall_now_ns() -> f64;
}

#[inline]
pub fn now_ns() -> f64 {
    unsafe { ringfall_now_ns() }
}

#[derive(Clone)]
pub struct TickProf {
    pub enabled: u8,
    pub ns: [f64; SEC_N],
    pub counts: [u64; CNT_N],
}

impl TickProf {
    pub fn new() -> Self {
        Self {
            enabled: 0,
            ns: [0.0; SEC_N],
            counts: [0; CNT_N],
        }
    }

    pub fn reset(&mut self) {
        self.ns = [0.0; SEC_N];
        self.counts = [0; CNT_N];
    }

    #[inline]
    pub fn add(&mut self, sec: usize, dt_ns: f64) {
        if self.enabled != 0 && sec < SEC_N {
            self.ns[sec] += dt_ns;
        }
    }

    #[inline]
    pub fn count(&mut self, idx: usize, n: u64) {
        if self.enabled != 0 && idx < CNT_N {
            self.counts[idx] = self.counts[idx].saturating_add(n);
        }
    }
}

/// Scoped timer: records into `prof.ns[sec]` when enabled.
pub struct Scope<'a> {
    prof: &'a mut TickProf,
    sec: usize,
    t0: f64,
    active: bool,
}

impl<'a> Scope<'a> {
    #[inline]
    pub fn new(prof: &'a mut TickProf, sec: usize) -> Self {
        let active = prof.enabled != 0;
        let t0 = if active { now_ns() } else { 0.0 };
        Self {
            prof,
            sec,
            t0,
            active,
        }
    }
}

impl Drop for Scope<'_> {
    #[inline]
    fn drop(&mut self) {
        if self.active {
            let dt = now_ns() - self.t0;
            if dt > 0.0 {
                self.prof.add(self.sec, dt);
            }
        }
    }
}
