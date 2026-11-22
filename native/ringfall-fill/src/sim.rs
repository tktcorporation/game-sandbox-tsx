//! Coarse per-tick sim host: enemy/orb SoA + world geom (boxes + terrain) in WASM linear
//! memory. `step_tick` advances enemies (sense + calm + fightFoe + engaged FSM) then orbs.
//! ABI 6: cover grid, squad calm destinations, hunt vias in-WASM.
//! See docs/ringfall/native.md.

#![allow(dead_code)]

use crate::cover_grid::{
    CoverGrid, COVER_LEVEL, COVER_MAX_FROM_PLAYER, COVER_MIN_FROM_PLAYER, COVER_PEEK_DIST,
    COVER_SEARCH, COVER_STUCK_PROGRESS, COVER_STUCK_TIME, COVER_TALL_Y,
};
use crate::hunt_grid::{HuntGrid, PURSUE_REACH};
use crate::kind::*;
use crate::tick_prof::{self, TickProf, SEC_ENEMIES, SEC_ORBS, SEC_TICK};
use std::f64::consts::PI;

const CELL: f64 = 8.0;
const TICK: f64 = 1.0 / 60.0;
const PLAYER_RADIUS: f64 = 0.4;
const ALLY_RADIUS: f64 = 0.4;
const TITAN_HOMING: f64 = 0.55; // TITAN.homing in config.ts

const FLAG_FENCE: u8 = 1;
const FLAG_OBSTACLE: u8 = 2; // closed-route obstacle (paths skip)

const HIT_PLAYER: u8 = 0;
const HIT_ALLY: u8 = 1;
const HIT_ROBOT: u8 = 2;

const ORB_HOMING: u8 = 1;
const ORB_FRIEND: u8 = 2;
const ORB_HAS_BY: u8 = 4;

const ROBOT_FRIEND: u8 = 1;
const ROBOT_BATTLE: u8 = 2;
const ROBOT_POI: u8 = 4;
const ROBOT_TITAN: u8 = 8;
const ROBOT_SPAWNING: u8 = 16;

#[repr(C)]
#[derive(Clone, Copy)]
struct PackedBox {
    x0: f32,
    z0: f32,
    x1: f32,
    z1: f32,
    y0: f32,
    h: f32,
    flags: u8,
    _pad: [u8; 3],
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct HitEvent {
    pub orb: u32,
    pub kind: u8,
    pub _pad: [u8; 3],
    pub target_id: i32,
    pub dmg: f32,
    pub from_x: f32,
    pub from_z: f32,
}

pub struct Sim {
    // --- geom ---
    boxes: Vec<PackedBox>,
    cell_min_cx: i32,
    cell_max_cx: i32,
    cell_min_cz: i32,
    cell_max_cz: i32,
    cell_span_z: i32,
    cell_ids: Vec<Vec<u32>>,
    seen_by: Vec<i32>,
    ray_id: i32,
    terrain: Vec<f32>,
    t_nx: i32,
    t_nz: i32,
    t_x0: f64,
    t_z0: f64,
    t_res: f64,
    geom_ready: bool,

    // --- player / ally snapshot ---
    px: f64,
    py: f64,
    pz: f64,
    pvx: f64,
    pvy: f64,
    pvz: f64,
    crouch: u8,
    sliding: u8,
    player_downed: u8,
    phase_play: u8,
    ax: f64,
    ay: f64,
    az: f64,
    avx: f64,
    avy: f64,
    avz: f64,
    ally_up: u8,
    sight_scale: f64,
    threat_range: f64,
    rng: u32,
    next_id: u32,

    // --- enemy / friend robots (SoA for view + orb hits + combat) ---
    pub n_robots: u32,
    pub robot_id: Vec<i32>,
    pub robot_x: Vec<f32>,
    pub robot_y: Vec<f32>,
    pub robot_z: Vec<f32>,
    pub robot_yaw: Vec<f32>,
    pub robot_vx: Vec<f32>,
    pub robot_vy: Vec<f32>,
    pub robot_vz: Vec<f32>,
    pub robot_hp: Vec<f32>,
    pub robot_shield: Vec<f32>,
    pub robot_duck: Vec<f32>,
    pub robot_kind: Vec<u8>,
    pub robot_mode: Vec<u8>,
    pub robot_flags: Vec<u8>,
    pub robot_radius: Vec<f32>,
    pub robot_body_h: Vec<f32>,
    pub robot_side: Vec<u8>,
    pub robot_aware: Vec<u8>,
    pub robot_detect: Vec<f32>,
    pub robot_finding: Vec<f32>,
    pub robot_blind: Vec<f32>,
    pub robot_saw_x: Vec<f32>,
    pub robot_saw_z: Vec<f32>,
    pub robot_has_saw: Vec<u8>,
    pub robot_timer: Vec<f32>,
    pub robot_cooldown: Vec<f32>,
    pub robot_shots_left: Vec<i32>,
    pub robot_strafe: Vec<f32>,
    pub robot_strafe_t: Vec<f32>,
    pub robot_jink: Vec<f32>,
    pub robot_steady: Vec<f32>,
    pub robot_stagger: Vec<f32>,
    pub robot_aim_yaw: Vec<f32>,
    pub robot_aim_pitch: Vec<f32>,
    pub robot_opener: Vec<u8>,
    pub robot_peek_side: Vec<f32>,
    pub robot_cover_t: Vec<f32>,
    pub robot_elite: Vec<u8>,
    pub robot_target: Vec<u8>,
    pub robot_target_t: Vec<f32>,
    pub robot_squad: Vec<i32>,
    pub robot_friend_id: Vec<i32>,
    pub robot_poi: Vec<i32>,
    pub robot_last_hit: Vec<f32>,
    pub robot_fired: Vec<f32>,
    pub robot_ally_hit: Vec<f32>,
    pub robot_home_x: Vec<f32>,
    pub robot_home_y: Vec<f32>,
    pub robot_home_z: Vec<f32>,
    pub robot_goal_x: Vec<f32>,
    pub robot_goal_z: Vec<f32>,
    pub robot_has_goal: Vec<u8>,
    pub robot_search_t: Vec<f32>,
    /// Hunt waypoint from TypeScript (`huntStep`); when set, engaged move walks toward it.
    pub robot_via_x: Vec<f32>,
    pub robot_via_z: Vec<f32>,
    pub robot_has_via: Vec<u8>,
    pub robot_look_t: Vec<f32>,
    pub robot_face: Vec<f32>,
    pub robot_cover_spot_x: Vec<f32>,
    pub robot_cover_spot_z: Vec<f32>,
    pub robot_peek_x: Vec<f32>,
    pub robot_peek_z: Vec<f32>,
    pub robot_has_cover: Vec<u8>,
    pub robot_stuck_x: Vec<f32>,
    pub robot_stuck_z: Vec<f32>,
    pub robot_stuck_t: Vec<f32>,

    // --- squads (subset for sense / knownSpot / engage / calm) ---
    pub n_squads: u32,
    pub squad_since_seen: Vec<f32>,
    pub squad_shot_t: Vec<f32>,
    pub squad_last_x: Vec<f32>,
    pub squad_last_z: Vec<f32>,
    pub squad_chase_x: Vec<f32>,
    pub squad_chase_z: Vec<f32>,
    pub squad_has_chase: Vec<u8>,
    pub squad_chase_t: Vec<f32>,
    pub squad_pin_t: Vec<f32>,
    pub squad_sight: Vec<f32>,
    pub squad_flags: Vec<u8>,
    pub squad_leg: Vec<i32>,
    pub squad_foe_id: Vec<i32>,
    pub squad_walk_x: Vec<f32>,
    pub squad_walk_z: Vec<f32>,
    pub squad_has_walk: Vec<u8>,
    pub squad_ambush_x: Vec<f32>,
    pub squad_ambush_z: Vec<f32>,
    pub squad_ambush_face: Vec<f32>,
    pub squad_has_ambush: Vec<u8>,
    pub squad_party_x: Vec<f32>,
    pub squad_party_z: Vec<f32>,
    pub squad_has_party: Vec<u8>,
    pub squad_patrol_x: Vec<f32>,
    pub squad_patrol_z: Vec<f32>,
    pub squad_patrol_prev_x: Vec<f32>,
    pub squad_patrol_prev_z: Vec<f32>,
    pub squad_has_patrol: Vec<u8>,
    pub squad_patrol_pace: Vec<f32>,
    pub squad_near: Vec<u8>,
    pub squad_boss: Vec<u8>,

    // --- orbs ---
    pub n_orbs: u32,
    pub orb_x: Vec<f32>,
    pub orb_y: Vec<f32>,
    pub orb_z: Vec<f32>,
    pub orb_vx: Vec<f32>,
    pub orb_vy: Vec<f32>,
    pub orb_vz: Vec<f32>,
    pub orb_r: Vec<f32>,
    pub orb_dmg: Vec<f32>,
    pub orb_life: Vec<f32>,
    pub orb_flags: Vec<u8>,
    pub orb_by: Vec<i32>,
    pub orb_side: Vec<u8>,
    pub orb_alive: Vec<u8>,

    pub hits: Vec<HitEvent>,
    wipes: u32,
    tick_ready: bool,
    /// Staging for box upload (n*7 f32: x0,z0,x1,z1,y0,h,flags).
    box_stage: Vec<f32>,
    /// Engaged walker vias (hunt.ts grid uploaded once per world).
    pub hunt: HuntGrid,
    pub covers: CoverGrid,
    /// Raid tick index (TypeScript `Math.round(time / TICK)`) for FAR_THINK.
    pub world_tick: u32,
    /// Section timers (opt-in via `ringfall_sim_prof_enable`).
    pub prof: TickProf,
    prof_ms_scratch: [f64; tick_prof::SEC_N],
    prof_cnt_scratch: [u64; tick_prof::CNT_N],
}

impl Sim {
    pub fn new() -> Self {
        Self {
            boxes: Vec::new(),
            cell_min_cx: 0,
            cell_max_cx: -1,
            cell_min_cz: 0,
            cell_max_cz: -1,
            cell_span_z: 0,
            cell_ids: Vec::new(),
            seen_by: Vec::new(),
            ray_id: 0,
            terrain: Vec::new(),
            t_nx: 0,
            t_nz: 0,
            t_x0: 0.0,
            t_z0: 0.0,
            t_res: 1.0,
            geom_ready: false,
            px: 0.0,
            py: 0.0,
            pz: 0.0,
            pvx: 0.0,
            pvy: 0.0,
            pvz: 0.0,
            crouch: 0,
            sliding: 0,
            player_downed: 0,
            phase_play: 1,
            ax: 0.0,
            ay: 0.0,
            az: 0.0,
            avx: 0.0,
            avy: 0.0,
            avz: 0.0,
            ally_up: 0,
            sight_scale: 1.0,
            threat_range: 1.0,
            rng: 1,
            next_id: 1,
            n_robots: 0,
            robot_id: Vec::new(),
            robot_x: Vec::new(),
            robot_y: Vec::new(),
            robot_z: Vec::new(),
            robot_yaw: Vec::new(),
            robot_vx: Vec::new(),
            robot_vy: Vec::new(),
            robot_vz: Vec::new(),
            robot_hp: Vec::new(),
            robot_shield: Vec::new(),
            robot_duck: Vec::new(),
            robot_kind: Vec::new(),
            robot_mode: Vec::new(),
            robot_flags: Vec::new(),
            robot_radius: Vec::new(),
            robot_body_h: Vec::new(),
            robot_side: Vec::new(),
            robot_aware: Vec::new(),
            robot_detect: Vec::new(),
            robot_finding: Vec::new(),
            robot_blind: Vec::new(),
            robot_saw_x: Vec::new(),
            robot_saw_z: Vec::new(),
            robot_has_saw: Vec::new(),
            robot_timer: Vec::new(),
            robot_cooldown: Vec::new(),
            robot_shots_left: Vec::new(),
            robot_strafe: Vec::new(),
            robot_strafe_t: Vec::new(),
            robot_jink: Vec::new(),
            robot_steady: Vec::new(),
            robot_stagger: Vec::new(),
            robot_aim_yaw: Vec::new(),
            robot_aim_pitch: Vec::new(),
            robot_opener: Vec::new(),
            robot_peek_side: Vec::new(),
            robot_cover_t: Vec::new(),
            robot_elite: Vec::new(),
            robot_target: Vec::new(),
            robot_target_t: Vec::new(),
            robot_squad: Vec::new(),
            robot_friend_id: Vec::new(),
            robot_poi: Vec::new(),
            robot_last_hit: Vec::new(),
            robot_fired: Vec::new(),
            robot_ally_hit: Vec::new(),
            robot_home_x: Vec::new(),
            robot_home_y: Vec::new(),
            robot_home_z: Vec::new(),
            robot_goal_x: Vec::new(),
            robot_goal_z: Vec::new(),
            robot_has_goal: Vec::new(),
            robot_search_t: Vec::new(),
            robot_via_x: Vec::new(),
            robot_via_z: Vec::new(),
            robot_has_via: Vec::new(),
            robot_look_t: Vec::new(),
            robot_face: Vec::new(),
            robot_cover_spot_x: Vec::new(),
            robot_cover_spot_z: Vec::new(),
            robot_peek_x: Vec::new(),
            robot_peek_z: Vec::new(),
            robot_has_cover: Vec::new(),
            robot_stuck_x: Vec::new(),
            robot_stuck_z: Vec::new(),
            robot_stuck_t: Vec::new(),
            n_squads: 0,
            squad_since_seen: Vec::new(),
            squad_shot_t: Vec::new(),
            squad_last_x: Vec::new(),
            squad_last_z: Vec::new(),
            squad_chase_x: Vec::new(),
            squad_chase_z: Vec::new(),
            squad_has_chase: Vec::new(),
            squad_chase_t: Vec::new(),
            squad_pin_t: Vec::new(),
            squad_sight: Vec::new(),
            squad_flags: Vec::new(),
            squad_leg: Vec::new(),
            squad_foe_id: Vec::new(),
            squad_walk_x: Vec::new(),
            squad_walk_z: Vec::new(),
            squad_has_walk: Vec::new(),
            squad_ambush_x: Vec::new(),
            squad_ambush_z: Vec::new(),
            squad_ambush_face: Vec::new(),
            squad_has_ambush: Vec::new(),
            squad_party_x: Vec::new(),
            squad_party_z: Vec::new(),
            squad_has_party: Vec::new(),
            squad_patrol_x: Vec::new(),
            squad_patrol_z: Vec::new(),
            squad_patrol_prev_x: Vec::new(),
            squad_patrol_prev_z: Vec::new(),
            squad_has_patrol: Vec::new(),
            squad_patrol_pace: Vec::new(),
            squad_near: Vec::new(),
            squad_boss: Vec::new(),
            n_orbs: 0,
            orb_x: Vec::new(),
            orb_y: Vec::new(),
            orb_z: Vec::new(),
            orb_vx: Vec::new(),
            orb_vy: Vec::new(),
            orb_vz: Vec::new(),
            orb_r: Vec::new(),
            orb_dmg: Vec::new(),
            orb_life: Vec::new(),
            orb_flags: Vec::new(),
            orb_by: Vec::new(),
            orb_side: Vec::new(),
            orb_alive: Vec::new(),
            hits: Vec::new(),
            wipes: 0,
            tick_ready: false,
            box_stage: Vec::new(),
            hunt: HuntGrid::new(),
            covers: CoverGrid::new(),
            world_tick: 0,
            prof: TickProf::new(),
            prof_ms_scratch: [0.0; tick_prof::SEC_N],
            prof_cnt_scratch: [0; tick_prof::CNT_N],
        }
    }

    fn ensure_robots(&mut self, n: usize) {
        self.robot_id.resize(n, 0);
        self.robot_x.resize(n, 0.0);
        self.robot_y.resize(n, 0.0);
        self.robot_z.resize(n, 0.0);
        self.robot_yaw.resize(n, 0.0);
        self.robot_vx.resize(n, 0.0);
        self.robot_vy.resize(n, 0.0);
        self.robot_vz.resize(n, 0.0);
        self.robot_hp.resize(n, 0.0);
        self.robot_shield.resize(n, 0.0);
        self.robot_duck.resize(n, 0.0);
        self.robot_kind.resize(n, 0);
        self.robot_mode.resize(n, MODE_MOVE);
        self.robot_flags.resize(n, 0);
        self.robot_radius.resize(n, 0.4);
        self.robot_body_h.resize(n, 1.7);
        self.robot_side.resize(n, 0);
        self.robot_aware.resize(n, AWARE_IDLE);
        self.robot_detect.resize(n, 0.0);
        self.robot_finding.resize(n, 0.0);
        self.robot_blind.resize(n, 0.0);
        self.robot_saw_x.resize(n, 0.0);
        self.robot_saw_z.resize(n, 0.0);
        self.robot_has_saw.resize(n, 0);
        self.robot_timer.resize(n, 0.0);
        self.robot_cooldown.resize(n, 0.0);
        self.robot_shots_left.resize(n, 0);
        self.robot_strafe.resize(n, 1.0);
        self.robot_strafe_t.resize(n, 0.0);
        self.robot_jink.resize(n, 0.0);
        self.robot_steady.resize(n, 0.0);
        self.robot_stagger.resize(n, 0.0);
        self.robot_aim_yaw.resize(n, 0.0);
        self.robot_aim_pitch.resize(n, 0.0);
        self.robot_opener.resize(n, 0);
        self.robot_peek_side.resize(n, 1.0);
        self.robot_cover_t.resize(n, 0.0);
        self.robot_elite.resize(n, 0);
        self.robot_target.resize(n, TARGET_PLAYER);
        self.robot_target_t.resize(n, 0.0);
        self.robot_squad.resize(n, -1);
        self.robot_friend_id.resize(n, -1);
        self.robot_poi.resize(n, -1);
        self.robot_last_hit.resize(n, 99.0);
        self.robot_fired.resize(n, 99.0);
        self.robot_ally_hit.resize(n, 99.0);
        self.robot_home_x.resize(n, 0.0);
        self.robot_home_y.resize(n, 0.0);
        self.robot_home_z.resize(n, 0.0);
        self.robot_goal_x.resize(n, 0.0);
        self.robot_goal_z.resize(n, 0.0);
        self.robot_has_goal.resize(n, 0);
        self.robot_search_t.resize(n, 0.0);
        self.robot_via_x.resize(n, 0.0);
        self.robot_via_z.resize(n, 0.0);
        self.robot_has_via.resize(n, 0);
        self.robot_look_t.resize(n, 0.0);
        self.robot_face.resize(n, 0.0);
        self.robot_cover_spot_x.resize(n, 0.0);
        self.robot_cover_spot_z.resize(n, 0.0);
        self.robot_peek_x.resize(n, 0.0);
        self.robot_peek_z.resize(n, 0.0);
        self.robot_has_cover.resize(n, 0);
        self.robot_stuck_x.resize(n, 0.0);
        self.robot_stuck_z.resize(n, 0.0);
        self.robot_stuck_t.resize(n, 0.0);
    }

    fn ensure_squads(&mut self, n: usize) {
        self.squad_since_seen.resize(n, 0.0);
        self.squad_shot_t.resize(n, 0.0);
        self.squad_last_x.resize(n, 0.0);
        self.squad_last_z.resize(n, 0.0);
        self.squad_chase_x.resize(n, 0.0);
        self.squad_chase_z.resize(n, 0.0);
        self.squad_has_chase.resize(n, 0);
        self.squad_chase_t.resize(n, 0.0);
        self.squad_pin_t.resize(n, 0.0);
        self.squad_sight.resize(n, 0.0);
        self.squad_flags.resize(n, 0);
        self.squad_leg.resize(n, 0);
        self.squad_foe_id.resize(n, -1);
        self.squad_walk_x.resize(n, 0.0);
        self.squad_walk_z.resize(n, 0.0);
        self.squad_has_walk.resize(n, 0);
        self.squad_ambush_x.resize(n, 0.0);
        self.squad_ambush_z.resize(n, 0.0);
        self.squad_ambush_face.resize(n, 0.0);
        self.squad_has_ambush.resize(n, 0);
        self.squad_party_x.resize(n, 0.0);
        self.squad_party_z.resize(n, 0.0);
        self.squad_has_party.resize(n, 0);
        self.squad_patrol_x.resize(n, 0.0);
        self.squad_patrol_z.resize(n, 0.0);
        self.squad_patrol_prev_x.resize(n, 0.0);
        self.squad_patrol_prev_z.resize(n, 0.0);
        self.squad_has_patrol.resize(n, 0);
        self.squad_patrol_pace.resize(n, 1.0);
        self.squad_near.resize(n, 0);
        self.squad_boss.resize(n, 0);
    }

    fn ensure_orbs(&mut self, n: usize) {
        self.orb_x.resize(n, 0.0);
        self.orb_y.resize(n, 0.0);
        self.orb_z.resize(n, 0.0);
        self.orb_vx.resize(n, 0.0);
        self.orb_vy.resize(n, 0.0);
        self.orb_vz.resize(n, 0.0);
        self.orb_r.resize(n, 0.0);
        self.orb_dmg.resize(n, 0.0);
        self.orb_life.resize(n, 0.0);
        self.orb_flags.resize(n, 0);
        self.orb_by.resize(n, -1);
        self.orb_side.resize(n, 0);
        self.orb_alive.resize(n, 0);
    }

    pub fn set_terrain(&mut self, nx: i32, nz: i32, x0: f64, z0: f64, res: f64) {
        self.t_nx = nx;
        self.t_nz = nz;
        self.t_x0 = x0;
        self.t_z0 = z0;
        self.t_res = res;
        self.terrain.resize((nx as usize).saturating_mul(nz as usize), 0.0);
    }

    pub fn set_boxes(&mut self, n: usize) {
        self.boxes.resize(n, PackedBox { x0: 0.0, z0: 0.0, x1: 0.0, z1: 0.0, y0: 0.0, h: 0.0, flags: 0, _pad: [0; 3] });
        self.seen_by.resize(n, 0);
    }

    pub fn rebuild_grid(&mut self) {
        if self.boxes.is_empty() {
            self.cell_ids.clear();
            self.geom_ready = !self.terrain.is_empty();
            return;
        }
        let mut min_cx = i32::MAX;
        let mut max_cx = i32::MIN;
        let mut min_cz = i32::MAX;
        let mut max_cz = i32::MIN;
        for b in &self.boxes {
            min_cx = min_cx.min((b.x0 as f64 / CELL).floor() as i32);
            max_cx = max_cx.max((b.x1 as f64 / CELL).floor() as i32);
            min_cz = min_cz.min((b.z0 as f64 / CELL).floor() as i32);
            max_cz = max_cz.max((b.z1 as f64 / CELL).floor() as i32);
        }
        self.cell_min_cx = min_cx;
        self.cell_max_cx = max_cx;
        self.cell_min_cz = min_cz;
        self.cell_max_cz = max_cz;
        self.cell_span_z = max_cz - min_cz + 1;
        let ncells = ((max_cx - min_cx + 1) as usize).saturating_mul(self.cell_span_z as usize);
        self.cell_ids = vec![Vec::new(); ncells];
        for (i, b) in self.boxes.iter().enumerate() {
            let cx0 = (b.x0 as f64 / CELL).floor() as i32;
            let cx1 = (b.x1 as f64 / CELL).floor() as i32;
            let cz0 = (b.z0 as f64 / CELL).floor() as i32;
            let cz1 = (b.z1 as f64 / CELL).floor() as i32;
            for cx in cx0..=cx1 {
                for cz in cz0..=cz1 {
                    if let Some(c) = self.cell_at(cx, cz) {
                        self.cell_ids[c].push(i as u32);
                    }
                }
            }
        }
        self.geom_ready = !self.terrain.is_empty();
    }

    fn cell_at(&self, cx: i32, cz: i32) -> Option<usize> {
        if cx < self.cell_min_cx || cx > self.cell_max_cx || cz < self.cell_min_cz || cz > self.cell_max_cz {
            return None;
        }
        Some(((cx - self.cell_min_cx) * self.cell_span_z + (cz - self.cell_min_cz)) as usize)
    }

    pub fn terrain_height(&self, x: f64, z: f64) -> f64 {
        let fx = (x - self.t_x0) / self.t_res;
        let fz = (z - self.t_z0) / self.t_res;
        if self.terrain.is_empty() || fx < 0.0 || fz < 0.0 || fx >= (self.t_nx - 1) as f64 || fz >= (self.t_nz - 1) as f64 {
            // Outside: clamp to rim cell (close enough for bolts near the coast).
            let i = fx.floor().clamp(0.0, (self.t_nx - 1).max(0) as f64) as i32;
            let j = fz.floor().clamp(0.0, (self.t_nz - 1).max(0) as f64) as i32;
            if self.terrain.is_empty() {
                return 0.0;
            }
            return self.terrain[(j * self.t_nx + i) as usize] as f64;
        }
        let i = fx.floor() as i32;
        let j = fz.floor() as i32;
        let u = fx - i as f64;
        let v = fz - j as f64;
        let a = self.terrain[(j * self.t_nx + i) as usize] as f64;
        let b = self.terrain[(j * self.t_nx + i + 1) as usize] as f64;
        let c = self.terrain[((j + 1) * self.t_nx + i) as usize] as f64;
        let d = self.terrain[((j + 1) * self.t_nx + i + 1) as usize] as f64;
        a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
    }

    fn ray_box(o: (f64, f64, f64), d: (f64, f64, f64), b: &PackedBox, max_t: f64) -> f64 {
        let mut t0 = 0.0;
        let mut t1 = max_t;
        let slab = |o: f64, d: f64, lo: f64, hi: f64, t0: &mut f64, t1: &mut f64| -> bool {
            if d.abs() < 1e-9 {
                return o >= lo && o <= hi;
            }
            let mut a = (lo - o) / d;
            let mut c = (hi - o) / d;
            if a > c {
                std::mem::swap(&mut a, &mut c);
            }
            if a > *t0 {
                *t0 = a;
            }
            if c < *t1 {
                *t1 = c;
            }
            *t0 <= *t1
        };
        if !slab(o.0, d.0, b.x0 as f64, b.x1 as f64, &mut t0, &mut t1) {
            return f64::INFINITY;
        }
        if !slab(o.1, d.1, b.y0 as f64, b.h as f64, &mut t0, &mut t1) {
            return f64::INFINITY;
        }
        if !slab(o.2, d.2, b.z0 as f64, b.z1 as f64, &mut t0, &mut t1) {
            return f64::INFINITY;
        }
        t0
    }

    fn ray_terrain(&self, o: (f64, f64, f64), d: (f64, f64, f64), max_t: f64) -> f64 {
        let mut prev = 0.0;
        let mut t = 0.0;
        for _ in 0..400 {
            if t >= max_t {
                break;
            }
            let gap = o.1 + d.1 * t - self.terrain_height(o.0 + d.0 * t, o.2 + d.2 * t);
            if gap < 0.0 {
                let mut lo = prev;
                let mut hi = t;
                for _ in 0..6 {
                    let m = (lo + hi) * 0.5;
                    if o.1 + d.1 * m < self.terrain_height(o.0 + d.0 * m, o.2 + d.2 * m) {
                        hi = m;
                    } else {
                        lo = m;
                    }
                }
                return hi.min(max_t);
            }
            prev = t;
            let step = (gap * 0.8).clamp(0.4, 4.0);
            let next = (t + step).min(max_t);
            if next == t {
                break;
            }
            t = next;
        }
        let end = o.1 + d.1 * max_t - self.terrain_height(o.0 + d.0 * max_t, o.2 + d.2 * max_t);
        if end < 0.0 {
            prev.max(max_t - 0.4)
        } else {
            max_t
        }
    }

    pub fn ray_world(&mut self, o: (f64, f64, f64), d: (f64, f64, f64), max_t: f64, paths: bool, fences: bool) -> f64 {
        let mut t = max_t;
        self.ray_id = self.ray_id.wrapping_add(1);
        let ray_id = self.ray_id;
        let mut cx = (o.0 / CELL).floor() as i32;
        let mut cz = (o.2 / CELL).floor() as i32;
        let ax = d.0.abs();
        let az = d.2.abs();
        let step_x = if d.0 > 0.0 { 1 } else { -1 };
        let step_z = if d.2 > 0.0 { 1 } else { -1 };
        let dt_x = if ax > 1e-9 { CELL / ax } else { f64::INFINITY };
        let dt_z = if az > 1e-9 { CELL / az } else { f64::INFINITY };
        let mut next_x = if ax > 1e-9 {
            if d.0 > 0.0 {
                ((cx + 1) as f64 * CELL - o.0) / ax
            } else {
                (o.0 - cx as f64 * CELL) / ax
            }
        } else {
            f64::INFINITY
        };
        let mut next_z = if az > 1e-9 {
            if d.2 > 0.0 {
                ((cz + 1) as f64 * CELL - o.2) / az
            } else {
                (o.2 - cz as f64 * CELL) / az
            }
        } else {
            f64::INFINITY
        };
        loop {
            if let Some(c) = self.cell_at(cx, cz) {
                let ids = &self.cell_ids[c];
                for &bi in ids {
                    let i = bi as usize;
                    if self.seen_by[i] == ray_id {
                        continue;
                    }
                    self.seen_by[i] = ray_id;
                    let b = &self.boxes[i];
                    if paths && (b.flags & FLAG_OBSTACLE) != 0 {
                        continue;
                    }
                    let is_fence = (b.flags & FLAG_FENCE) != 0;
                    if is_fence != fences {
                        continue;
                    }
                    let bt = Self::ray_box(o, d, b, t);
                    if bt < t {
                        t = bt;
                    }
                }
            }
            if next_x.min(next_z) > t {
                return if fences { t } else { self.ray_terrain(o, d, t) };
            }
            if next_x < next_z {
                cx += step_x;
                next_x += dt_x;
            } else {
                cz += step_z;
                next_z += dt_z;
            }
        }
    }

    pub fn los(&mut self, a: (f64, f64, f64), b: (f64, f64, f64), paths: bool) -> bool {
        let dx = b.0 - a.0;
        let dy = b.1 - a.1;
        let dz = b.2 - a.2;
        let len = (dx * dx + dy * dy + dz * dz).sqrt();
        if len < 1e-6 {
            return true;
        }
        let d = (dx / len, dy / len, dz / len);
        self.ray_world(a, d, len, paths, false) >= len - 0.05
    }

    fn hypot3(x: f64, y: f64, z: f64) -> f64 {
        (x * x + y * y + z * z).sqrt()
    }

    fn axis_dist(p: (f64, f64, f64), at_x: f64, at_z: f64, qy: f64, h: f64) -> f64 {
        let t = if h > 1e-9 { ((p.1 - qy) / h).clamp(0.0, 1.0) } else { 0.0 };
        let dx = p.0 - at_x;
        let dy = p.1 - (qy + h * t);
        let dz = p.2 - at_z;
        (dx * dx + dy * dy + dz * dz).sqrt()
    }

    /// Matches `sweptHit` in enemies.ts (segment vs vertical capsule).
    fn swept_hit(
        from: (f64, f64, f64),
        to: (f64, f64, f64),
        r: f64,
        body: (f64, f64, f64),
        top: f64,
    ) -> Option<(f64, (f64, f64, f64))> {
        let dx = to.0 - from.0;
        let dy = to.1 - from.1;
        let dz = to.2 - from.2;
        let qy = body.1 + 0.4;
        let h = (top - 0.4).max(0.0);
        let wx = from.0 - body.0;
        let wy = from.1 - qy;
        let wz = from.2 - body.2;
        let dd = dx * dx + dy * dy + dz * dz;
        let de = dy * h;
        let ee = h * h;
        let dw = dx * wx + dy * wy + dz * wz;
        let ew = h * wy;
        let den = dd * ee - de * de;
        let mut s_p = if den > 1e-9 { (de * ew - ee * dw) / den } else { 0.0 };
        s_p = s_p.clamp(0.0, 1.0);
        let mut t_p = if ee > 1e-9 { (de * s_p + ew) / ee } else { 0.0 };
        if t_p < 0.0 || t_p > 1.0 {
            t_p = t_p.clamp(0.0, 1.0);
            s_p = if dd > 1e-9 { ((de * t_p - dw) / dd).clamp(0.0, 1.0) } else { 0.0 };
        }
        let point = |k: f64| (from.0 + dx * k, from.1 + dy * k, from.2 + dz * k);
        let dist = |k: f64| Self::axis_dist(point(k), body.0, body.2, qy, h);
        if dist(s_p) >= r {
            return None;
        }
        if dist(0.0) < r {
            return Some((0.0, point(0.0)));
        }
        let mut lo = 0.0;
        let mut hi = s_p;
        for _ in 0..20 {
            let mid = (lo + hi) * 0.5;
            if dist(mid) < r {
                hi = mid;
            } else {
                lo = mid;
            }
        }
        Some((hi, point(hi)))
    }

    pub fn step_orbs(&mut self, dt: f64) {
        self.hits.clear();
        let n = self.n_orbs as usize;
        let wipes0 = self.wipes;
        let player_h = if self.crouch != 0 || self.sliding != 0 { 1.1 } else { 1.7 };
        for i in 0..n {
            if self.orb_alive[i] == 0 {
                continue;
            }
            if self.wipes != wipes0 {
                self.orb_alive[i] = 0;
                continue;
            }
            let flags = self.orb_flags[i];
            if flags & ORB_HOMING != 0 {
                let sp = Self::hypot3(self.orb_vx[i] as f64, self.orb_vy[i] as f64, self.orb_vz[i] as f64);
                let tx = self.px - self.orb_x[i] as f64;
                let ty = (self.py + 1.0) - self.orb_y[i] as f64;
                let tz = self.pz - self.orb_z[i] as f64;
                let tl = Self::hypot3(tx, ty, tz).max(1.0);
                let k = TITAN_HOMING * dt;
                self.orb_vx[i] = (self.orb_vx[i] as f64 + ((tx / tl) * sp - self.orb_vx[i] as f64) * k) as f32;
                self.orb_vy[i] = (self.orb_vy[i] as f64 + ((ty / tl) * sp - self.orb_vy[i] as f64) * k) as f32;
                self.orb_vz[i] = (self.orb_vz[i] as f64 + ((tz / tl) * sp - self.orb_vz[i] as f64) * k) as f32;
            }
            let from = (
                self.orb_x[i] as f64,
                self.orb_y[i] as f64,
                self.orb_z[i] as f64,
            );
            self.orb_x[i] = (from.0 + self.orb_vx[i] as f64 * dt) as f32;
            self.orb_y[i] = (from.1 + self.orb_vy[i] as f64 * dt) as f32;
            self.orb_z[i] = (from.2 + self.orb_vz[i] as f64 * dt) as f32;
            self.orb_life[i] = (self.orb_life[i] as f64 - dt) as f32;
            let to = (self.orb_x[i] as f64, self.orb_y[i] as f64, self.orb_z[i] as f64);
            let r = self.orb_r[i] as f64;
            let clear = |sim: &mut Sim, at: (f64, f64, f64)| {
                sim.los(from, at, false) && sim.los((from.0, from.1 - r, from.2), (at.0, at.1 - r, at.2), false)
            };

            let friend = flags & ORB_FRIEND != 0;
            let mut player_hit: Option<(f64, (f64, f64, f64))> = None;
            let mut ally_hit: Option<(f64, (f64, f64, f64))> = None;
            if !friend {
                if let Some(h) = Self::swept_hit(from, to, r + PLAYER_RADIUS, (self.px, self.py, self.pz), player_h) {
                    if clear(self, h.1) {
                        player_hit = Some(h);
                    }
                }
                if self.ally_up != 0 {
                    if let Some(h) = Self::swept_hit(from, to, r + ALLY_RADIUS, (self.ax, self.ay, self.az), 1.7) {
                        if clear(self, h.1) {
                            ally_hit = Some(h);
                        }
                    }
                }
            }

            let mut robot: Option<(usize, f64)> = None;
            if flags & ORB_HAS_BY != 0 {
                let ox = to.0;
                let oz = to.2;
                let orb_side = self.orb_side[i];
                let by = self.orb_by[i];
                let mut shooter_battle = false;
                let mut shooter_friend = false;
                for j in 0..self.n_robots as usize {
                    if self.robot_id[j] == by {
                        shooter_battle = self.robot_flags[j] & ROBOT_BATTLE != 0;
                        shooter_friend = self.robot_flags[j] & ROBOT_FRIEND != 0;
                        break;
                    }
                }
                for j in 0..self.n_robots as usize {
                    if self.robot_side[j] == orb_side {
                        continue;
                    }
                    let f = self.robot_flags[j];
                    if f & ROBOT_TITAN != 0 || f & ROBOT_SPAWNING != 0 {
                        continue;
                    }
                    if f & ROBOT_POI != 0 && !friend && !shooter_battle && !shooter_friend {
                        // battle flag on orb's shooter — approximate: skip garrison unless friend/battle shooter
                        continue;
                    }
                    // Spatial filter ~8m neighbourhood
                    let dx = self.robot_x[j] as f64 - ox;
                    let dz = self.robot_z[j] as f64 - oz;
                    if dx * dx + dz * dz > 24.0 * 24.0 {
                        continue;
                    }
                    let rh = self.robot_body_h[j] as f64;
                    let rr = self.robot_radius[j] as f64;
                    let body = (self.robot_x[j] as f64, self.robot_y[j] as f64, self.robot_z[j] as f64);
                    if let Some(h) = Self::swept_hit(from, to, r + rr, body, rh) {
                        if clear(self, h.1) {
                            if robot.map(|(_, s)| h.0 < s).unwrap_or(true) {
                                robot = Some((j, h.0));
                            }
                        }
                    }
                }
            }

            if let Some((j, s)) = robot {
                let take = player_hit.map(|(ps, _)| s < ps).unwrap_or(true)
                    && ally_hit.map(|(as_, _)| s < as_).unwrap_or(true);
                if take {
                    self.hits.push(HitEvent {
                        orb: i as u32,
                        kind: HIT_ROBOT,
                        _pad: [0; 3],
                        target_id: self.robot_id[j],
                        dmg: self.orb_dmg[i],
                        from_x: (from.0 - self.orb_vx[i] as f64 * 0.0) as f32,
                        from_z: from.2 as f32,
                    });
                    self.orb_alive[i] = 0;
                    continue;
                }
            }
            if let Some((as_, _)) = ally_hit {
                let take = player_hit.map(|(ps, _)| as_ < ps).unwrap_or(true);
                if take {
                    self.hits.push(HitEvent {
                        orb: i as u32,
                        kind: HIT_ALLY,
                        _pad: [0; 3],
                        target_id: -1,
                        dmg: self.orb_dmg[i],
                        from_x: from.0 as f32,
                        from_z: from.2 as f32,
                    });
                    self.orb_alive[i] = 0;
                    continue;
                }
            }
            if player_hit.is_some() {
                self.hits.push(HitEvent {
                    orb: i as u32,
                    kind: HIT_PLAYER,
                    _pad: [0; 3],
                    target_id: -1,
                    dmg: self.orb_dmg[i],
                    from_x: (from.0) as f32,
                    from_z: from.2 as f32,
                });
                self.orb_alive[i] = 0;
                continue;
            }
            if self.orb_life[i] <= 0.0 || to.1 < self.terrain_height(to.0, to.2) {
                self.orb_alive[i] = 0;
                continue;
            }
            if !clear(self, to) {
                self.orb_alive[i] = 0;
                continue;
            }
        }
    }

    /// Advance one sim tick: enemies (sense + combat) then orbs. Returns 0 on success, -1 if not ready.
    pub fn step_tick(&mut self, dt: f32) -> i32 {
        if !self.geom_ready || !self.tick_ready {
            return -1;
        }
        let dt = if dt <= 0.0 { TICK } else { dt as f64 };
        let on = self.prof.enabled != 0;
        let t0 = if on { tick_prof::now_ns() } else { 0.0 };
        let te0 = t0;
        self.step_enemies(dt);
        if on {
            let t1 = tick_prof::now_ns();
            self.prof.add(SEC_ENEMIES, t1 - te0);
            let to0 = t1;
            self.step_orbs(dt);
            let t2 = tick_prof::now_ns();
            self.prof.add(SEC_ORBS, t2 - to0);
            self.prof.add(SEC_TICK, t2 - t0);
        } else {
            self.step_orbs(dt);
        }
        0
    }
}

include!("enemies_tick.rs");

static mut SIM: Option<Sim> = None;

pub fn sim() -> &'static mut Sim {
    unsafe {
        if SIM.is_none() {
            SIM = Some(Sim::new());
        }
        SIM.as_mut().unwrap()
    }
}

// --- C ABI ---

#[no_mangle]
pub extern "C" fn ringfall_sim_reset() {
    *sim() = Sim::new();
}

#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_terrain_begin(nx: i32, nz: i32, x0: f64, z0: f64, res: f64) -> *mut f32 {
    let s = sim();
    s.set_terrain(nx, nz, x0, z0, res);
    s.terrain.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn ringfall_sim_terrain_commit() {
    let s = sim();
    s.geom_ready = !s.terrain.is_empty() && !s.boxes.is_empty();
}

#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_boxes_begin(n: u32) -> *mut f32 {
    let s = sim();
    s.box_stage.clear();
    s.box_stage.resize(n as usize * 7, 0.0);
    s.box_stage.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn ringfall_sim_boxes_commit() {
    let s = sim();
    let n = s.box_stage.len() / 7;
    s.set_boxes(n);
    for i in 0..n {
        let o = i * 7;
        s.boxes[i] = PackedBox {
            x0: s.box_stage[o],
            z0: s.box_stage[o + 1],
            x1: s.box_stage[o + 2],
            z1: s.box_stage[o + 3],
            y0: s.box_stage[o + 4],
            h: s.box_stage[o + 5],
            flags: s.box_stage[o + 6] as u8,
            _pad: [0; 3],
        };
    }
    s.box_stage.clear();
    s.rebuild_grid();
}

/// Upload hunt.ts open/height grid (same WORLD + RES=2 cells). Call after boxes_commit.
#[no_mangle]
pub extern "C" fn ringfall_sim_hunt_begin(nx: i32, nz: i32, x0: f64, z0: f64, res: f64) {
    sim().hunt.begin(nx, nz, x0, z0, res);
}

#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_hunt_open_ptr() -> *mut u8 {
    sim().hunt.open_ptr()
}

#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_hunt_height_ptr() -> *mut f32 {
    sim().hunt.height_ptr()
}

#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_hunt_main_ptr() -> *mut u8 {
    sim().hunt.main_ptr()
}

#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_hunt_mask_ptr() -> *mut u8 {
    sim().hunt.mask_ptr()
}

#[no_mangle]
pub extern "C" fn ringfall_sim_hunt_commit() {
    sim().hunt.commit();
}

#[no_mangle]
pub extern "C" fn ringfall_sim_set_player(
    x: f32,
    y: f32,
    z: f32,
    crouch: u8,
    sliding: u8,
    ax: f32,
    ay: f32,
    az: f32,
    ally_up: u8,
    wipes: u32,
) {
    let s = sim();
    s.px = x as f64;
    s.py = y as f64;
    s.pz = z as f64;
    s.crouch = crouch;
    s.sliding = sliding;
    s.ax = ax as f64;
    s.ay = ay as f64;
    s.az = az as f64;
    s.ally_up = ally_up;
    s.wipes = wipes;
}

/// Extra player/ally/raid params for combat (ABI 3).
#[no_mangle]
pub extern "C" fn ringfall_sim_set_combat(
    pvx: f32,
    pvy: f32,
    pvz: f32,
    avx: f32,
    avy: f32,
    avz: f32,
    player_downed: u8,
    phase_play: u8,
    sight_scale: f32,
    threat_range: f32,
    rng: u32,
    next_id: u32,
) {
    let s = sim();
    s.pvx = pvx as f64;
    s.pvy = pvy as f64;
    s.pvz = pvz as f64;
    s.avx = avx as f64;
    s.avy = avy as f64;
    s.avz = avz as f64;
    s.player_downed = player_downed;
    s.phase_play = phase_play;
    s.sight_scale = sight_scale as f64;
    s.threat_range = threat_range as f64;
    s.rng = if rng == 0 { 1 } else { rng };
    s.next_id = next_id;
}

#[no_mangle]
pub extern "C" fn ringfall_sim_get_rng() -> u32 {
    sim().rng
}

#[no_mangle]
pub extern "C" fn ringfall_sim_get_next_id() -> u32 {
    sim().next_id
}

#[no_mangle]
pub extern "C" fn ringfall_sim_squads_begin(n: u32) -> i32 {
    let s = sim();
    s.ensure_squads(n as usize);
    s.n_squads = n;
    0
}

#[no_mangle]
pub extern "C" fn ringfall_sim_robots_begin(n: u32) -> i32 {
    let s = sim();
    s.ensure_robots(n as usize);
    s.n_robots = n;
    0
}

#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_x_ptr() -> *mut f32 {
    sim().robot_x.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_y_ptr() -> *mut f32 {
    sim().robot_y.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_z_ptr() -> *mut f32 {
    sim().robot_z.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_yaw_ptr() -> *mut f32 {
    sim().robot_yaw.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_vx_ptr() -> *mut f32 {
    sim().robot_vx.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_vz_ptr() -> *mut f32 {
    sim().robot_vz.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_hp_ptr() -> *mut f32 {
    sim().robot_hp.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_shield_ptr() -> *mut f32 {
    sim().robot_shield.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_duck_ptr() -> *mut f32 {
    sim().robot_duck.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_id_ptr() -> *mut i32 {
    sim().robot_id.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_kind_ptr() -> *mut u8 {
    sim().robot_kind.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_mode_ptr() -> *mut u8 {
    sim().robot_mode.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_flags_ptr() -> *mut u8 {
    sim().robot_flags.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_radius_ptr() -> *mut f32 {
    sim().robot_radius.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_body_h_ptr() -> *mut f32 {
    sim().robot_body_h.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_side_ptr() -> *mut u8 {
    sim().robot_side.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_vy_ptr() -> *mut f32 {
    sim().robot_vy.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_aware_ptr() -> *mut u8 {
    sim().robot_aware.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_detect_ptr() -> *mut f32 {
    sim().robot_detect.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_finding_ptr() -> *mut f32 {
    sim().robot_finding.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_blind_ptr() -> *mut f32 {
    sim().robot_blind.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_saw_x_ptr() -> *mut f32 {
    sim().robot_saw_x.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_saw_z_ptr() -> *mut f32 {
    sim().robot_saw_z.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_has_saw_ptr() -> *mut u8 {
    sim().robot_has_saw.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_timer_ptr() -> *mut f32 {
    sim().robot_timer.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_cooldown_ptr() -> *mut f32 {
    sim().robot_cooldown.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_shots_left_ptr() -> *mut i32 {
    sim().robot_shots_left.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_strafe_ptr() -> *mut f32 {
    sim().robot_strafe.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_strafe_t_ptr() -> *mut f32 {
    sim().robot_strafe_t.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_jink_ptr() -> *mut f32 {
    sim().robot_jink.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_steady_ptr() -> *mut f32 {
    sim().robot_steady.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_stagger_ptr() -> *mut f32 {
    sim().robot_stagger.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_aim_yaw_ptr() -> *mut f32 {
    sim().robot_aim_yaw.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_aim_pitch_ptr() -> *mut f32 {
    sim().robot_aim_pitch.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_opener_ptr() -> *mut u8 {
    sim().robot_opener.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_peek_side_ptr() -> *mut f32 {
    sim().robot_peek_side.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_cover_t_ptr() -> *mut f32 {
    sim().robot_cover_t.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_elite_ptr() -> *mut u8 {
    sim().robot_elite.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_target_ptr() -> *mut u8 {
    sim().robot_target.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_target_t_ptr() -> *mut f32 {
    sim().robot_target_t.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_squad_ptr() -> *mut i32 {
    sim().robot_squad.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_friend_id_ptr() -> *mut i32 {
    sim().robot_friend_id.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_poi_ptr() -> *mut i32 {
    sim().robot_poi.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_last_hit_ptr() -> *mut f32 {
    sim().robot_last_hit.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_fired_ptr() -> *mut f32 {
    sim().robot_fired.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_ally_hit_ptr() -> *mut f32 {
    sim().robot_ally_hit.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_home_x_ptr() -> *mut f32 {
    sim().robot_home_x.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_home_y_ptr() -> *mut f32 {
    sim().robot_home_y.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_home_z_ptr() -> *mut f32 {
    sim().robot_home_z.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_goal_x_ptr() -> *mut f32 {
    sim().robot_goal_x.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_goal_z_ptr() -> *mut f32 {
    sim().robot_goal_z.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_has_goal_ptr() -> *mut u8 {
    sim().robot_has_goal.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_search_t_ptr() -> *mut f32 {
    sim().robot_search_t.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_via_x_ptr() -> *mut f32 {
    sim().robot_via_x.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_via_z_ptr() -> *mut f32 {
    sim().robot_via_z.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_has_via_ptr() -> *mut u8 {
    sim().robot_has_via.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_look_t_ptr() -> *mut f32 {
    sim().robot_look_t.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_face_ptr() -> *mut f32 {
    sim().robot_face.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_cover_spot_x_ptr() -> *mut f32 {
    sim().robot_cover_spot_x.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_cover_spot_z_ptr() -> *mut f32 {
    sim().robot_cover_spot_z.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_peek_x_ptr() -> *mut f32 {
    sim().robot_peek_x.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_peek_z_ptr() -> *mut f32 {
    sim().robot_peek_z.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_has_cover_ptr() -> *mut u8 {
    sim().robot_has_cover.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_stuck_x_ptr() -> *mut f32 {
    sim().robot_stuck_x.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_stuck_z_ptr() -> *mut f32 {
    sim().robot_stuck_z.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_robot_stuck_t_ptr() -> *mut f32 {
    sim().robot_stuck_t.as_mut_ptr()
}

#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_squad_since_seen_ptr() -> *mut f32 {
    sim().squad_since_seen.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_squad_shot_t_ptr() -> *mut f32 {
    sim().squad_shot_t.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_squad_last_x_ptr() -> *mut f32 {
    sim().squad_last_x.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_squad_last_z_ptr() -> *mut f32 {
    sim().squad_last_z.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_squad_chase_x_ptr() -> *mut f32 {
    sim().squad_chase_x.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_squad_chase_z_ptr() -> *mut f32 {
    sim().squad_chase_z.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_squad_has_chase_ptr() -> *mut u8 {
    sim().squad_has_chase.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_squad_chase_t_ptr() -> *mut f32 {
    sim().squad_chase_t.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_squad_pin_t_ptr() -> *mut f32 {
    sim().squad_pin_t.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_squad_sight_ptr() -> *mut f32 {
    sim().squad_sight.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_squad_flags_ptr() -> *mut u8 {
    sim().squad_flags.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_squad_leg_ptr() -> *mut i32 {
    sim().squad_leg.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_squad_foe_id_ptr() -> *mut i32 {
    sim().squad_foe_id.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_squad_walk_x_ptr() -> *mut f32 {
    sim().squad_walk_x.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_squad_walk_z_ptr() -> *mut f32 {
    sim().squad_walk_z.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_squad_has_walk_ptr() -> *mut u8 {
    sim().squad_has_walk.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_squad_ambush_x_ptr() -> *mut f32 {
    sim().squad_ambush_x.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_squad_ambush_z_ptr() -> *mut f32 {
    sim().squad_ambush_z.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_squad_ambush_face_ptr() -> *mut f32 {
    sim().squad_ambush_face.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_squad_has_ambush_ptr() -> *mut u8 {
    sim().squad_has_ambush.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_squad_party_x_ptr() -> *mut f32 {
    sim().squad_party_x.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_squad_party_z_ptr() -> *mut f32 {
    sim().squad_party_z.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_squad_has_party_ptr() -> *mut u8 {
    sim().squad_has_party.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_squad_patrol_x_ptr() -> *mut f32 {
    sim().squad_patrol_x.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_squad_patrol_z_ptr() -> *mut f32 {
    sim().squad_patrol_z.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_squad_patrol_prev_x_ptr() -> *mut f32 {
    sim().squad_patrol_prev_x.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_squad_patrol_prev_z_ptr() -> *mut f32 {
    sim().squad_patrol_prev_z.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_squad_has_patrol_ptr() -> *mut u8 {
    sim().squad_has_patrol.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_squad_patrol_pace_ptr() -> *mut f32 {
    sim().squad_patrol_pace.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_squad_near_ptr() -> *mut u8 {
    sim().squad_near.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_squad_boss_ptr() -> *mut u8 {
    sim().squad_boss.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn ringfall_sim_covers_begin(n: u32) -> i32 {
    sim().covers.begin(n as usize);
    0
}

#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_covers_ptr() -> *mut f32 {
    sim().covers.stage_ptr()
}

#[no_mangle]
pub extern "C" fn ringfall_sim_covers_commit() {
    sim().covers.commit();
}

#[no_mangle]
pub extern "C" fn ringfall_sim_set_tick(tick: u32) {
    sim().world_tick = tick;
}

#[no_mangle]
pub extern "C" fn ringfall_sim_n_orbs() -> u32 {
    sim().n_orbs
}

#[no_mangle]
pub extern "C" fn ringfall_sim_orbs_begin(n: u32) -> i32 {
    let s = sim();
    s.ensure_orbs(n as usize);
    s.n_orbs = n;
    for i in 0..n as usize {
        s.orb_alive[i] = 1;
    }
    0
}

#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_orb_x_ptr() -> *mut f32 {
    sim().orb_x.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_orb_y_ptr() -> *mut f32 {
    sim().orb_y.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_orb_z_ptr() -> *mut f32 {
    sim().orb_z.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_orb_vx_ptr() -> *mut f32 {
    sim().orb_vx.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_orb_vy_ptr() -> *mut f32 {
    sim().orb_vy.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_orb_vz_ptr() -> *mut f32 {
    sim().orb_vz.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_orb_r_ptr() -> *mut f32 {
    sim().orb_r.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_orb_dmg_ptr() -> *mut f32 {
    sim().orb_dmg.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_orb_life_ptr() -> *mut f32 {
    sim().orb_life.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_orb_flags_ptr() -> *mut u8 {
    sim().orb_flags.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_orb_by_ptr() -> *mut i32 {
    sim().orb_by.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_orb_side_ptr() -> *mut u8 {
    sim().orb_side.as_mut_ptr()
}
#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_orb_alive_ptr() -> *mut u8 {
    sim().orb_alive.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn ringfall_sim_set_ready(ready: u8) {
    sim().tick_ready = ready != 0;
}

#[no_mangle]
pub extern "C" fn ringfall_sim_n_robots() -> u32 {
    sim().n_robots
}

#[no_mangle]
pub extern "C" fn ringfall_sim_hits_len() -> u32 {
    sim().hits.len() as u32
}

#[no_mangle]
pub unsafe extern "C" fn ringfall_sim_hits_ptr() -> *const HitEvent {
    sim().hits.as_ptr()
}

#[no_mangle]
pub extern "C" fn ringfall_sim_los(ax: f32, ay: f32, az: f32, bx: f32, by: f32, bz: f32, paths: u8) -> u8 {
    if !sim().geom_ready {
        return 0;
    }
    if sim().los((ax as f64, ay as f64, az as f64), (bx as f64, by as f64, bz as f64), paths != 0) {
        1
    } else {
        0
    }
}

#[no_mangle]
pub extern "C" fn ringfall_sim_step_tick(dt: f32) -> i32 {
    sim().step_tick(dt)
}

#[no_mangle]
pub extern "C" fn ringfall_sim_prof_enable(on: u8) {
    sim().prof.enabled = if on != 0 { 1 } else { 0 };
    if on != 0 {
        sim().prof.reset();
        sim().hunt.builds = 0;
        sim().hunt.cells_touched = 0;
    }
}

#[no_mangle]
pub extern "C" fn ringfall_sim_prof_reset() {
    sim().prof.reset();
    sim().hunt.builds = 0;
    sim().hunt.cells_touched = 0;
}

#[no_mangle]
pub extern "C" fn ringfall_sim_prof_ms_len() -> u32 {
    tick_prof::SEC_N as u32
}

#[no_mangle]
pub extern "C" fn ringfall_sim_prof_ms_ptr() -> *const f64 {
    let s = sim();
    for i in 0..tick_prof::SEC_N {
        s.prof_ms_scratch[i] = s.prof.ns[i] * 1e-6;
    }
    s.prof_ms_scratch.as_ptr()
}

#[no_mangle]
pub extern "C" fn ringfall_sim_prof_counts_len() -> u32 {
    tick_prof::CNT_N as u32
}

#[no_mangle]
pub extern "C" fn ringfall_sim_prof_counts_ptr() -> *const u64 {
    let s = sim();
    for i in 0..tick_prof::CNT_N {
        s.prof_cnt_scratch[i] = s.prof.counts[i];
    }
    s.prof_cnt_scratch.as_ptr()
}

// silence unused import warning if PI unused
#[allow(dead_code)]
fn _pi() -> f64 {
    PI
}
