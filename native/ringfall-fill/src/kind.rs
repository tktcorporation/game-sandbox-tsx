//! Kind tables matching `ENEMIES` / `SIGHT` / `TURN` / `DODGE` / `RETURN` in config.ts.
//! Indices: grunt=0, heavy=1, drone=2, charger=3, titan=4 (see tick.ts KIND_I).

#![allow(dead_code)]

pub const KIND_GRUNT: u8 = 0;
pub const KIND_HEAVY: u8 = 1;
pub const KIND_DRONE: u8 = 2;
pub const KIND_CHARGER: u8 = 3;
pub const KIND_TITAN: u8 = 4;
pub const KIND_N: usize = 5;

pub const AWARE_IDLE: u8 = 0;
pub const AWARE_ALERT: u8 = 1;
pub const AWARE_ENGAGED: u8 = 2;

pub const TARGET_PLAYER: u8 = 0;
pub const TARGET_ALLY: u8 = 1;
pub const TARGET_FRIEND: u8 = 2;

pub const MODE_MOVE: u8 = 2;
pub const MODE_TELEGRAPH: u8 = 3;
pub const MODE_FIRE: u8 = 4;
pub const MODE_RECOVER: u8 = 5;
pub const MODE_STAGGERED: u8 = 6;
pub const MODE_SPAWNING: u8 = 7;
pub const MODE_STOMP: u8 = 8;
pub const MODE_LUNGE: u8 = 9;
pub const MODE_STUNNED: u8 = 11;

pub const SQUAD_ENGAGED: u8 = 1;
pub const SQUAD_MOBILE: u8 = 2;
pub const SQUAD_RETREAT: u8 = 4;
pub const SQUAD_PACK: u8 = 8;

#[derive(Clone, Copy)]
pub struct KindSpec {
    pub radius: f64,
    pub body_y: f64,
    pub weak_y: f64,
    pub weak_fwd: f64,
    pub speed: f64,
    pub fly: f64,
    pub range: f64,
    pub telegraph: f64,
    pub cooldown: f64,
    pub shots: i32,
    pub shot_gap: f64,
    pub spread: f64,
    pub orb_speed: f64,
    pub orb_dmg: f64,
    pub orb_r: f64,
    pub sight_range: f64,
    pub sight_fov: f64,
    pub turn: f64,
    pub windup: f64,
    pub return_range: f64,
}

/// Matches KIND_I order: grunt, heavy, drone, charger, titan.
pub const KINDS: [KindSpec; KIND_N] = [
    // grunt
    KindSpec {
        radius: 0.65,
        body_y: 1.2,
        weak_y: 2.0,
        weak_fwd: 0.08,
        speed: 3.2,
        fly: 0.0,
        range: 15.0,
        telegraph: 0.6,
        cooldown: 2.2,
        shots: 3,
        shot_gap: 0.12,
        spread: 0.0,
        orb_speed: 140.0,
        orb_dmg: 21.0,
        orb_r: 0.18,
        sight_range: 45.0,
        sight_fov: 110.0,
        turn: 3.0,
        windup: 0.6,
        return_range: 140.0,
    },
    // heavy
    KindSpec {
        radius: 1.1,
        body_y: 1.8,
        weak_y: 3.0,
        weak_fwd: 0.1,
        speed: 2.0,
        fly: 0.0,
        range: 18.0,
        telegraph: 0.85,
        cooldown: 3.6,
        shots: 5,
        shot_gap: 0.0,
        spread: 5.0,
        orb_speed: 110.0,
        orb_dmg: 18.0,
        orb_r: 0.26,
        sight_range: 42.0,
        sight_fov: 100.0,
        turn: 1.6,
        windup: 0.0,
        return_range: 140.0,
    },
    // drone
    KindSpec {
        radius: 0.55,
        body_y: 0.0,
        weak_y: 0.0,
        weak_fwd: 0.42,
        speed: 4.2,
        fly: 3.4,
        range: 14.0,
        telegraph: 0.55,
        cooldown: 1.6,
        shots: 1,
        shot_gap: 0.0,
        spread: 0.0,
        orb_speed: 120.0,
        orb_dmg: 21.0,
        orb_r: 0.2,
        sight_range: 39.0,
        sight_fov: 150.0,
        turn: 3.6,
        windup: 0.7,
        return_range: 0.0,
    },
    // charger
    KindSpec {
        radius: 0.72,
        body_y: 0.75,
        weak_y: 0.95,
        weak_fwd: 0.62,
        speed: 6.4,
        fly: 0.0,
        range: 0.0,
        telegraph: 0.6,
        cooldown: 1.2,
        shots: 0,
        shot_gap: 0.0,
        spread: 0.0,
        orb_speed: 0.0,
        orb_dmg: 40.0,
        orb_r: 0.0,
        sight_range: 30.0,
        sight_fov: 120.0,
        turn: 3.8,
        windup: 0.0,
        return_range: 0.0,
    },
    // titan
    KindSpec {
        radius: 2.3,
        body_y: 3.2,
        weak_y: 3.4,
        weak_fwd: 2.1,
        speed: 1.6,
        fly: 0.0,
        range: 20.0,
        telegraph: 1.0,
        cooldown: 3.0,
        shots: 6,
        shot_gap: 0.16,
        spread: 0.0,
        orb_speed: 13.0,
        orb_dmg: 9.0,
        orb_r: 0.48,
        sight_range: 51.0,
        sight_fov: 160.0,
        turn: 1.2,
        windup: 0.0,
        return_range: 0.0,
    },
];

pub fn kind(k: u8) -> KindSpec {
    KINDS[(k as usize).min(KIND_N - 1)]
}
