// Sense + calm + fightFoe + cover + engaged combat FSM (included into sim.rs, ABI 6).

const DEG: f64 = PI / 180.0;
const LEDGE: f64 = 1.0;
const CLIMB_LIM: f64 = 1.2;
const STEP_UP: f64 = 0.45;
const WORLD_G: f64 = 15.0;
const WX0: f64 = -1340.0;
const WX1: f64 = 1120.0;
const WZ0: f64 = -1220.0;
const WZ1: f64 = 660.0;

const CHARGER_LUNGE_SPEED: f64 = 19.0;
const CHARGER_LUNGE_TIME: f64 = 0.38;
const CHARGER_LUNGE_RANGE: f64 = 8.0;
const CHARGER_HIT_R: f64 = 1.3;

const ELITE_DMG: f64 = 1.3;
const ELITE_COOLDOWN: f64 = 0.75;
const ELITE_TURN: f64 = 1.2;
const ELITE_FIRE_CONE: f64 = 50.0;

const SHOT_LEAD: f64 = 0.85;
const SHOT_SPREAD: f64 = 1.5;
const SHOT_STILL: f64 = 1.0;
const SHOT_STEADY: f64 = 0.77;
const SHOT_FAN: f64 = 0.36;
const SHOT_EXTRA: i32 = 1;
const SHOT_PRESS: f64 = 0.23;
const SHOT_FOLLOW: f64 = 0.6;
const SHOT_FOLLOW_WINDOW: f64 = 1.5;
const SHOT_SHARE: f64 = 5.0;
const SHOT_SHARE_WINDOW: f64 = 2.5;

const AWARE_CLOSE: f64 = 4.5;
const AWARE_CROUCH_RANGE: f64 = 0.55;
const AWARE_CROUCH_RATE: f64 = 0.6;
const AWARE_FILL_NEAR: f64 = 0.35;
const AWARE_FILL_FAR: f64 = 1.5;
const AWARE_SUSPICIOUS: f64 = 0.3;
const AWARE_DECAY: f64 = 0.25;
const AWARE_SEARCH: f64 = 9.0;
const AWARE_LOSE: f64 = 8.0;
const AWARE_IDLE_SPEED: f64 = 0.45;
const AWARE_MAX_SQUADS: i32 = 2;
const AWARE_JOIN_CLOSE: f64 = 5.0;
const AWARE_ENGAGED_FOV: f64 = 1.2;
const AWARE_ENGAGED_RANGE: f64 = 1.25;
const AWARE_TRACK: f64 = 0.4;
const AWARE_FIRE_CONE: f64 = 40.0;
const AWARE_LOCATE: f64 = 0.5;
const AWARE_FIND_KEEP: f64 = 1.0;
const AWARE_REACT0: f64 = 0.25;
const AWARE_REACT1: f64 = 0.45;

const FLANK_BLIND: f64 = 2.5;
const FLANK_MOVED: f64 = 6.0;

const DODGE_STRAFE: f64 = 1.0;
const DODGE_CLOSE_IN: f64 = 1.0;
const DODGE_EVERY0: f64 = 0.4;
const DODGE_EVERY1: f64 = 1.1;
const DODGE_FLIP: f64 = 0.65;
const DODGE_JINK_SPEED: f64 = 1.5;

const DUCK_RATE: f64 = 5.0;
const PATROL_SIGHT: f64 = 0.6;
const STAGGER_WINDOW: f64 = 0.7;
const STRAY: f64 = 12.0;
const SWEEP_PACE: f64 = 1.2;
const CREW_PACE: f64 = 0.7;
const PARTY_PACE: f64 = 0.7;
const PACK_PACE: f64 = 0.9;
const PATROL_PACE: f64 = 1.35;
const CONQUEST_COLUMN: f64 = 2.8;
const FAR_THINK_EVERY: u32 = 4;

impl Sim {
    fn hypot2(x: f64, z: f64) -> f64 {
        (x * x + z * z).sqrt()
    }

    /// Engaged walker next waypoint (hunt.ts `huntStep`), or the goal when flying / off ground.
    fn engaged_via(&mut self, i: usize, gx: f64, gz: f64) -> (f64, f64) {
        let kind = self.kind_of(i);
        if kind.fly > 0.0 {
            return (gx, gz);
        }
        let sq = self.robot_squad[i];
        let routed = sq >= 0
            && (sq as usize) < self.n_squads as usize
            && self.squad_flags[sq as usize] & SQUAD_ROUTED != 0;
        let x = self.robot_x[i] as f64;
        let z = self.robot_z[i] as f64;
        if !routed && !self.hunt.on_main(x, z) {
            return (gx, gz);
        }
        let reach = if routed {
            f64::INFINITY
        } else {
            PURSUE_REACH
        };
        self.hunt.next_via(x, z, gx, gz, reach)
    }

    fn wrap_angle(a: f64) -> f64 {
        a.sin().atan2(a.cos())
    }

    fn xorshift(x: u32) -> u32 {
        let mut x = x;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        if x == 0 {
            1
        } else {
            x
        }
    }

    fn draw(&mut self) -> f64 {
        self.rng = Self::xorshift(self.rng);
        (self.rng % 1_000_000) as f64 / 1_000_000.0
    }

    fn kind_of(&self, i: usize) -> KindSpec {
        kind(self.robot_kind[i])
    }

    fn weak_y(&self, i: usize) -> f64 {
        let k = self.kind_of(i);
        k.weak_y - self.robot_duck[i] as f64 * 0.8
    }

    fn body_y_of(&self, i: usize) -> f64 {
        let k = self.kind_of(i);
        k.body_y - self.robot_duck[i] as f64 * 0.8
    }

    fn muzzle(&self, i: usize) -> (f64, f64, f64) {
        let x = self.robot_x[i] as f64;
        let y = self.robot_y[i] as f64;
        let z = self.robot_z[i] as f64;
        let yaw = self.robot_yaw[i] as f64;
        let k = self.kind_of(i);
        if self.robot_kind[i] == KIND_DRONE {
            (
                x + yaw.sin() * k.weak_fwd,
                y + self.weak_y(i),
                z - yaw.cos() * k.weak_fwd,
            )
        } else {
            (x, y + self.weak_y(i) - 0.1, z)
        }
    }

    fn head_of(&self, i: usize) -> (f64, f64, f64) {
        (
            self.robot_x[i] as f64,
            self.robot_y[i] as f64 + self.weak_y(i).max(0.2),
            self.robot_z[i] as f64,
        )
    }

    fn look_angles(from: (f64, f64, f64), to: (f64, f64, f64)) -> (f64, f64) {
        let dx = to.0 - from.0;
        let dz = to.2 - from.2;
        let yaw = dx.atan2(-dz);
        let pitch = (to.1 - from.1).atan2(Self::hypot2(dx, dz));
        (yaw, pitch)
    }

    fn ground_at(&self, x: f64, z: f64, r: f64, feet: f64) -> f64 {
        let t = self.terrain_height(x, z);
        let mut g = if t <= feet + STEP_UP { t } else { f64::NEG_INFINITY };
        let cx0 = ((x - r) / CELL).floor() as i32;
        let cx1 = ((x + r) / CELL).floor() as i32;
        let cz0 = ((z - r) / CELL).floor() as i32;
        let cz1 = ((z + r) / CELL).floor() as i32;
        for cx in cx0..=cx1 {
            for cz in cz0..=cz1 {
                if let Some(c) = self.cell_at(cx, cz) {
                    for &bi in &self.cell_ids[c] {
                        let b = &self.boxes[bi as usize];
                        let bh = b.h as f64;
                        if bh > feet + STEP_UP || bh <= g {
                            continue;
                        }
                        if x + r * 0.7 < b.x0 as f64
                            || x - r * 0.7 > b.x1 as f64
                            || z + r * 0.7 < b.z0 as f64
                            || z - r * 0.7 > b.z1 as f64
                        {
                            continue;
                        }
                        g = bh;
                    }
                }
            }
        }
        if g == f64::NEG_INFINITY {
            t
        } else {
            g
        }
    }

    fn collide_body(&mut self, i: usize, r: f64, height: f64) -> bool {
        let mut px = self.robot_x[i] as f64;
        let py = self.robot_y[i] as f64;
        let mut pz = self.robot_z[i] as f64;
        let mut touched = false;
        let cx0 = ((px - r) / CELL).floor() as i32 - 1;
        let cx1 = ((px + r) / CELL).floor() as i32 + 1;
        let cz0 = ((pz - r) / CELL).floor() as i32 - 1;
        let cz1 = ((pz + r) / CELL).floor() as i32 + 1;
        for cx in cx0..=cx1 {
            for cz in cz0..=cz1 {
                if let Some(c) = self.cell_at(cx, cz) {
                    for &bi in &self.cell_ids[c] {
                        let b = self.boxes[bi as usize];
                        if (b.h as f64) <= py + STEP_UP || (b.y0 as f64) >= py + height {
                            continue;
                        }
                        let qx = (px).clamp(b.x0 as f64, b.x1 as f64);
                        let qz = (pz).clamp(b.z0 as f64, b.z1 as f64);
                        let dx = px - qx;
                        let dz = pz - qz;
                        let d2 = dx * dx + dz * dz;
                        if d2 >= r * r {
                            continue;
                        }
                        touched = true;
                        if d2 > 1e-8 {
                            let d = d2.sqrt();
                            px = qx + (dx / d) * r;
                            pz = qz + (dz / d) * r;
                        } else {
                            let out = [
                                px - b.x0 as f64 + r,
                                b.x1 as f64 - px + r,
                                pz - b.z0 as f64 + r,
                                b.z1 as f64 - pz + r,
                            ];
                            let m = out[0].min(out[1]).min(out[2]).min(out[3]);
                            if m == out[0] {
                                px = b.x0 as f64 - r;
                            } else if m == out[1] {
                                px = b.x1 as f64 + r;
                            } else if m == out[2] {
                                pz = b.z0 as f64 - r;
                            } else {
                                pz = b.z1 as f64 + r;
                            }
                        }
                    }
                }
            }
        }
        px = px.clamp(WX0 + r, WX1 - r);
        pz = pz.clamp(WZ0 + r, WZ1 - r);
        self.robot_x[i] = px as f32;
        self.robot_z[i] = pz as f32;
        touched
    }

    fn fly_height(&self, x: f64, z: f64) -> f64 {
        let t = self.terrain_height(x, z) + kind(KIND_DRONE).fly;
        let g = self.ground_at(x, z, 1.2, 99.0) + 2.4;
        t.max(g)
    }

    /// Simplified `moveBody` / `stepBody`: terrain + AABB, no camp/zone.
    fn move_body(&mut self, i: usize, vx: f64, vz: f64, dt: f64) -> bool {
        let k = self.kind_of(i);
        let mut rvx = self.robot_vx[i] as f64;
        let mut rvz = self.robot_vz[i] as f64;
        let mut rvy = self.robot_vy[i] as f64;
        rvx += (vx - rvx) * (dt * 8.0).min(1.0);
        rvz += (vz - rvz) * (dt * 8.0).min(1.0);
        let bx = self.robot_x[i] as f64;
        let bz = self.robot_z[i] as f64;
        self.robot_x[i] = (bx + rvx * dt) as f32;
        self.robot_z[i] = (bz + rvz * dt) as f32;
        if k.fly > 0.0 {
            let want = self.fly_height(self.robot_x[i] as f64, self.robot_z[i] as f64);
            let y = self.robot_y[i] as f64;
            self.robot_y[i] = (y + (want - y) * (dt * 2.5).min(1.0)) as f32;
            self.robot_vx[i] = rvx as f32;
            self.robot_vz[i] = rvz as f32;
            self.robot_vy[i] = 0.0;
            return false;
        }
        let height = k.body_y + k.radius;
        let blocked = self.collide_body(i, k.radius, height);
        let here = self.ground_at(bx, bz, k.radius, self.robot_y[i] as f64);
        let there = self.ground_at(
            self.robot_x[i] as f64,
            self.robot_z[i] as f64,
            k.radius,
            self.robot_y[i] as f64,
        );
        let home_y = self.robot_home_y[i] as f64;
        let home_g = self.terrain_height(self.robot_home_x[i] as f64, self.robot_home_z[i] as f64);
        let home_high = home_y > home_g + 0.6;
        let ground_here = self.terrain_height(self.robot_x[i] as f64, self.robot_z[i] as f64);
        let climbs_up = !home_high && there > ground_here + CLIMB_LIM;
        if there < here - LEDGE || (home_high && (there - home_y).abs() > 0.3) || climbs_up {
            self.robot_x[i] = bx as f32;
            self.robot_z[i] = bz as f32;
            self.robot_vx[i] = 0.0;
            self.robot_vz[i] = 0.0;
            return true;
        }
        let mut py = self.robot_y[i] as f64;
        if there >= py {
            py = there;
            rvy = 0.0;
        } else {
            rvy -= WORLD_G * dt;
            py = (py + rvy * dt).max(there);
            if py == there {
                rvy = 0.0;
            }
        }
        self.robot_y[i] = py as f32;
        self.robot_vx[i] = rvx as f32;
        self.robot_vz[i] = rvz as f32;
        self.robot_vy[i] = rvy as f32;
        let moved = Self::hypot2(self.robot_x[i] as f64 - bx, self.robot_z[i] as f64 - bz);
        blocked && moved < Self::hypot2(vx, vz) * dt * 0.4
    }

    fn turn_at(&mut self, i: usize, yaw: f64, rate: f64, dt: f64) {
        let cur = self.robot_yaw[i] as f64;
        let diff = Self::wrap_angle(yaw - cur);
        let max = rate * dt;
        self.robot_yaw[i] = (cur + diff.clamp(-max, max)) as f32;
    }

    fn facing(&self, i: usize, at_x: f64, at_z: f64) -> bool {
        let (yaw, _) = Self::look_angles(
            (self.robot_x[i] as f64, 0.0, self.robot_z[i] as f64),
            (at_x, 0.0, at_z),
        );
        let cone = if self.robot_elite[i] != 0 {
            ELITE_FIRE_CONE
        } else {
            AWARE_FIRE_CONE
        };
        Self::wrap_angle(yaw - self.robot_yaw[i] as f64).abs() < cone * DEG
    }

    fn sight_on(&mut self, i: usize, at_x: f64, at_z: f64, chest: (f64, f64, f64)) -> bool {
        if !self.facing(i, at_x, at_z) {
            return false;
        }
        let m = self.muzzle(i);
        self.los(m, chest, false)
    }

    fn lead_aim(&mut self, i: usize, at: (f64, f64, f64), vel: (f64, f64, f64)) {
        let k = self.kind_of(i);
        let from = self.muzzle(i);
        let t = (Self::hypot3(at.0 - from.0, at.1 - from.1, at.2 - from.2) / k.orb_speed.max(1.0))
            * SHOT_LEAD;
        let (yaw, pitch) = Self::look_angles(from, (at.0 + vel.0 * t, at.1, at.2 + vel.2 * t));
        self.robot_aim_yaw[i] = yaw as f32;
        self.robot_aim_pitch[i] = pitch as f32;
    }

    fn windup_step(&mut self, i: usize, ux: f64, uz: f64, closer: bool, dt: f64) {
        let k = self.kind_of(i);
        let w = k.windup * k.speed;
        if w <= 0.0 {
            self.move_body(i, 0.0, 0.0, dt);
            return;
        }
        let f = if closer { w * DODGE_CLOSE_IN } else { 0.0 };
        let strafe = self.robot_strafe[i] as f64;
        if self.move_body(i, -uz * strafe * w + ux * f, ux * strafe * w + uz * f, dt) {
            self.robot_strafe[i] = -self.robot_strafe[i];
        }
    }

    fn fire_range(&self, i: usize) -> f64 {
        let k = self.kind_of(i);
        let sight = k.sight_range * self.sight_scale * AWARE_ENGAGED_RANGE;
        let sq = self.robot_squad[i];
        let answering = sq >= 0
            && (sq as usize) < self.n_squads as usize
            && self.squad_shot_t[sq as usize] > 0.0;
        if answering {
            let rr = k.return_range * self.threat_range * self.sight_scale;
            sight.max(rr)
        } else {
            sight
        }
    }

    fn located(&self, i: usize) -> bool {
        if (self.robot_blind[i] as f64) < FLANK_BLIND {
            return true;
        }
        if self.robot_has_saw[i] != 0
            && (self.robot_blind[i] as f64) < AWARE_LOSE
            && Self::hypot2(
                self.robot_saw_x[i] as f64 - self.px,
                self.robot_saw_z[i] as f64 - self.pz,
            ) < FLANK_MOVED
        {
            return true;
        }
        let sq = self.robot_squad[i];
        self.robot_kind[i] == KIND_CHARGER
            && self.robot_aware[i] == AWARE_ENGAGED
            && sq >= 0
            && (sq as usize) < self.n_squads as usize
            && self.squad_since_seen[sq as usize] < AWARE_TRACK as f32
    }

    fn known_spot(&self, i: usize) -> (f64, f64, bool) {
        let sq = self.robot_squad[i];
        if sq < 0 || (sq as usize) >= self.n_squads as usize {
            return (self.px, self.pz, true);
        }
        let s = sq as usize;
        if self.squad_since_seen[s] < AWARE_TRACK as f32 {
            return (self.px, self.pz, true);
        }
        if self.squad_has_chase[s] != 0 {
            (self.squad_chase_x[s] as f64, self.squad_chase_z[s] as f64, false)
        } else {
            (self.squad_last_x[s] as f64, self.squad_last_z[s] as f64, false)
        }
    }

    fn fighting_squads(&self) -> i32 {
        let mut n = 0;
        for s in 0..self.n_squads as usize {
            if self.squad_flags[s] & SQUAD_ENGAGED == 0 {
                continue;
            }
            let mut alive = false;
            for i in 0..self.n_robots as usize {
                if self.robot_squad[i] == s as i32
                    && self.robot_flags[i] & ROBOT_FRIEND == 0
                    && self.robot_hp[i] > 0.0
                {
                    alive = true;
                    break;
                }
            }
            if alive {
                n += 1;
            }
        }
        n
    }

    fn may_engage(&self, i: usize) -> bool {
        let sq = self.robot_squad[i];
        if sq >= 0
            && (sq as usize) < self.n_squads as usize
            && self.squad_flags[sq as usize] & SQUAD_ENGAGED != 0
        {
            return true;
        }
        if self.robot_kind[i] == KIND_TITAN {
            return true;
        }
        if Self::hypot2(self.robot_x[i] as f64 - self.px, self.robot_z[i] as f64 - self.pz)
            < AWARE_JOIN_CLOSE
        {
            return true;
        }
        self.fighting_squads() < AWARE_MAX_SQUADS
    }

    fn engage_squad(&mut self, squad: i32, _by: usize) {
        if squad < 0 || (squad as usize) >= self.n_squads as usize {
            return;
        }
        let s = squad as usize;
        if self.squad_flags[s] & SQUAD_ENGAGED != 0 || self.squad_flags[s] & SQUAD_RETREAT != 0 {
            return;
        }
        self.squad_flags[s] |= SQUAD_ENGAGED;
        self.squad_since_seen[s] = 0.0;
        self.squad_chase_t[s] = 0.0;
        self.squad_last_x[s] = self.px as f32;
        self.squad_last_z[s] = self.pz as f32;
        self.squad_has_chase[s] = 0;
        self.squad_pin_t[s] = 0.0;
        // Order members by distance to player for react stagger.
        let mut order: Vec<(f64, usize)> = Vec::new();
        for i in 0..self.n_robots as usize {
            if self.robot_squad[i] != squad || self.robot_flags[i] & ROBOT_FRIEND != 0 {
                continue;
            }
            let d = Self::hypot2(self.robot_x[i] as f64 - self.px, self.robot_z[i] as f64 - self.pz);
            order.push((d, i));
        }
        order.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        for (n, &(_, i)) in order.iter().enumerate() {
            if self.robot_mode[i] == MODE_SPAWNING {
                self.robot_aware[i] = AWARE_ENGAGED;
                self.robot_detect[i] = 1.0;
                self.robot_has_goal[i] = 0;
                continue;
            }
            self.robot_aware[i] = AWARE_ENGAGED;
            self.robot_detect[i] = 1.0;
            self.robot_has_goal[i] = 0;
            self.robot_opener[i] = 1;
            let react = AWARE_REACT0 + AWARE_REACT1 * n as f64;
            if (self.robot_cooldown[i] as f64) < react {
                self.robot_cooldown[i] = react as f32;
            }
        }
    }

    /// Mirror of awareness.ts `sense`. Returns whether the robot sees the player.
    fn sense(&mut self, i: usize, dt: f64) -> bool {
        let sq = self.robot_squad[i];
        if sq >= 0
            && (sq as usize) < self.n_squads as usize
            && self.squad_flags[sq as usize] & SQUAD_RETREAT != 0
        {
            return false;
        }
        let mut seen = false;
        if self.phase_play != 0 && self.player_downed == 0 {
            let low = self.crouch != 0 && self.sliding == 0;
            let ty = self.py + if low { 1.0 } else { 1.5 };
            let ey = self.robot_y[i] as f64 + self.weak_y(i).max(0.2);
            let dx = self.px - self.robot_x[i] as f64;
            let dy = ty - ey;
            let dz = self.pz - self.robot_z[i] as f64;
            let k = self.kind_of(i);
            let engaged = self.robot_aware[i] == AWARE_ENGAGED;
            let mut range = {
                let base = if sq >= 0
                    && (sq as usize) < self.n_squads as usize
                    && self.squad_sight[sq as usize] > 0.0
                {
                    self.squad_sight[sq as usize] as f64
                } else {
                    k.sight_range
                };
                let mut r = base * self.sight_scale;
                if engaged {
                    r *= AWARE_ENGAGED_RANGE;
                } else if low {
                    r *= AWARE_CROUCH_RANGE; // hush mod ignored
                }
                if sq >= 0
                    && (sq as usize) < self.n_squads as usize
                    && self.squad_flags[sq as usize] & SQUAD_MOBILE != 0
                    && !engaged
                {
                    r *= PATROL_SIGHT;
                }
                r
            };
            if engaged {
                let answering = sq >= 0
                    && (sq as usize) < self.n_squads as usize
                    && self.squad_shot_t[sq as usize] > 0.0;
                if answering {
                    let rr = k.return_range * self.threat_range * self.sight_scale;
                    range = range.max(rr);
                }
            }
            let reach = AWARE_CLOSE.max(range) * 1.001;
            let d2 = dx * dx + dy * dy + dz * dz;
            let d = if d2 > reach * reach {
                f64::INFINITY
            } else {
                d2.sqrt()
            };
            let mut in_view = d < AWARE_CLOSE;
            if !in_view && d < range {
                let fov = k.sight_fov * if engaged { AWARE_ENGAGED_FOV } else { 1.0 };
                let yaw_to = dx.atan2(-dz);
                in_view = Self::wrap_angle(yaw_to - self.robot_yaw[i] as f64).abs() < (fov / 2.0) * DEG;
            }
            if in_view {
                seen = self.los(
                    (self.robot_x[i] as f64, ey, self.robot_z[i] as f64),
                    (self.px, ty, self.pz),
                    false,
                );
            }
            if !seen {
                self.robot_finding[i] =
                    (self.robot_finding[i] as f64 - dt / AWARE_FIND_KEEP).max(0.0) as f32;
            } else {
                if engaged && !self.located(i) && d >= AWARE_CLOSE {
                    let rate = (1.0
                        / ((AWARE_FILL_NEAR + AWARE_FILL_FAR * (d / range)) * AWARE_LOCATE))
                        * if low { AWARE_CROUCH_RATE } else { 1.0 };
                    self.robot_finding[i] = (self.robot_finding[i] as f64 + rate * dt) as f32;
                } else {
                    self.robot_finding[i] = 1.0;
                }
                if self.robot_finding[i] >= 1.0 {
                    self.robot_blind[i] = 0.0;
                    self.robot_saw_x[i] = self.px as f32;
                    self.robot_saw_z[i] = self.pz as f32;
                    self.robot_has_saw[i] = 1;
                    self.robot_finding[i] = 0.0;
                }
            }
            if seen && !engaged {
                let rate = (1.0 / (AWARE_FILL_NEAR + AWARE_FILL_FAR * (d / range)))
                    * if low { AWARE_CROUCH_RATE } else { 1.0 }
                    * if self.robot_aware[i] == AWARE_ALERT {
                        1.6
                    } else {
                        1.0
                    };
                self.robot_detect[i] = (self.robot_detect[i] as f64 + rate * dt).min(1.0) as f32;
                if self.robot_detect[i] >= 1.0 && !self.may_engage(i) {
                    self.robot_detect[i] = 0.95;
                }
                if self.robot_detect[i] >= 1.0 {
                    self.engage_squad(sq, i);
                } else if self.robot_detect[i] as f64 >= AWARE_SUSPICIOUS {
                    if self.robot_aware[i] == AWARE_IDLE {
                        self.robot_aware[i] = AWARE_ALERT;
                    }
                    self.robot_goal_x[i] = self.px as f32;
                    self.robot_goal_z[i] = self.pz as f32;
                    self.robot_has_goal[i] = 1;
                    self.robot_search_t[i] = AWARE_SEARCH as f32;
                }
            }
            if seen && engaged && sq >= 0 && (sq as usize) < self.n_squads as usize {
                let s = sq as usize;
                self.squad_since_seen[s] = 0.0;
                self.squad_pin_t[s] = self.squad_pin_t[s]; // hold cleared in TS stepSquads
                self.squad_chase_t[s] = 0.0;
                self.squad_last_x[s] = self.px as f32;
                self.squad_last_z[s] = self.pz as f32;
                self.squad_has_chase[s] = 0;
            }
        }
        if !seen && self.robot_aware[i] != AWARE_ENGAGED {
            self.robot_detect[i] =
                (self.robot_detect[i] as f64 - AWARE_DECAY * dt).max(0.0) as f32;
        }
        seen
    }

    fn spawn_orb(&mut self, i: usize, yaw_off: f64, wide: f64, foe: bool) {
        let k = self.kind_of(i);
        if k.orb_speed <= 0.0 || k.orb_r <= 0.0 {
            return;
        }
        let from = self.muzzle(i);
        let r = (-2.0 * (self.draw() + 1e-9).ln()).sqrt();
        let a = self.draw() * PI * 2.0;
        let stray = SHOT_SPREAD * wide * DEG;
        let yaw = self.robot_aim_yaw[i] as f64 + yaw_off + r * a.cos() * stray;
        let pitch = self.robot_aim_pitch[i] as f64 + r * a.sin() * stray;
        let c = pitch.cos();
        let elite = if self.robot_elite[i] != 0 {
            ELITE_DMG
        } else {
            1.0
        };
        let n = self.n_orbs as usize;
        self.ensure_orbs(n + 1);
        self.orb_x[n] = from.0 as f32;
        self.orb_y[n] = from.1 as f32;
        self.orb_z[n] = from.2 as f32;
        self.orb_vx[n] = (yaw.sin() * c * k.orb_speed) as f32;
        self.orb_vy[n] = (pitch.sin() * k.orb_speed) as f32;
        self.orb_vz[n] = (-yaw.cos() * c * k.orb_speed) as f32;
        self.orb_r[n] = k.orb_r as f32;
        self.orb_dmg[n] = (k.orb_dmg * elite) as f32;
        self.orb_life[n] = 5.0;
        if foe {
            self.orb_flags[n] = ORB_HAS_BY;
            self.orb_by[n] = self.robot_id[i];
        } else {
            self.orb_flags[n] = 0;
            self.orb_by[n] = -1;
        }
        self.orb_side[n] = if self.robot_flags[i] & ROBOT_FRIEND != 0 {
            0
        } else {
            self.robot_side[i]
        };
        self.orb_alive[n] = 1;
        self.n_orbs = (n + 1) as u32;
        let _ = self.next_id; // orb ids assigned on pull in TS
        self.next_id = self.next_id.wrapping_add(1);
    }

    fn others_firing(&self, i: usize) -> f64 {
        let mut n = 0.0;
        let tgt = self.robot_target[i];
        for o in 0..self.n_robots as usize {
            if o == i || self.robot_aware[o] != AWARE_ENGAGED || self.robot_target[o] != tgt {
                continue;
            }
            if self.robot_kind[o] == KIND_TITAN || self.robot_flags[o] & ROBOT_FRIEND != 0 {
                continue;
            }
            let mode = self.robot_mode[o];
            if mode == MODE_TELEGRAPH
                || mode == MODE_FIRE
                || (self.robot_fired[o] as f64) < SHOT_SHARE_WINDOW
            {
                n += 1.0;
            }
        }
        n
    }

    fn choose_target(&mut self, i: usize, dt: f64) {
        if self.ally_up == 0 {
            self.robot_target[i] = TARGET_PLAYER;
            return;
        }
        if self.player_downed != 0 {
            self.robot_target[i] = TARGET_ALLY;
            return;
        }
        self.robot_target_t[i] = (self.robot_target_t[i] as f64 - dt) as f32;
        if self.robot_target_t[i] > 0.0 {
            return;
        }
        self.robot_target_t[i] = 1.5;
        // Prefer nearer of player / ally (LOS bonus skipped for speed).
        let dp = Self::hypot2(
            self.robot_x[i] as f64 - self.px,
            self.robot_z[i] as f64 - self.pz,
        );
        let da = Self::hypot2(
            self.robot_x[i] as f64 - self.ax,
            self.robot_z[i] as f64 - self.az,
        ) + 1.0; // aggroBias-ish
        self.robot_target[i] = if da < dp { TARGET_ALLY } else { TARGET_PLAYER };
    }

    /// Engaged combat FSM (move / telegraph / fire / lunge / recover). Titan: hold + turn.
    fn step_engaged(&mut self, i: usize, dt: f64) {
        if self.robot_kind[i] == KIND_TITAN {
            let (yaw, _) = Self::look_angles(
                (self.robot_x[i] as f64, 0.0, self.robot_z[i] as f64),
                (self.px, 0.0, self.pz),
            );
            let cur = self.robot_yaw[i] as f64;
            self.robot_yaw[i] =
                (cur + Self::wrap_angle(yaw - cur) * (dt * 1.5).min(1.0)) as f32;
            self.move_body(i, 0.0, 0.0, dt);
            return;
        }
        self.choose_target(i, dt);
        if self.robot_target[i] == TARGET_FRIEND {
            self.robot_target[i] = TARGET_PLAYER;
        }
        let at_ally = self.robot_target[i] == TARGET_ALLY;
        let (t_x, t_y, t_z, t_up, t_vx, t_vz) = if at_ally {
            (
                self.ax,
                self.ay,
                self.az,
                self.ally_up != 0,
                self.avx,
                self.avz,
            )
        } else {
            (
                self.px,
                self.py,
                self.pz,
                self.player_downed == 0,
                self.pvx,
                self.pvz,
            )
        };
        let t_chest = (
            t_x,
            t_y + if at_ally {
                1.1
            } else if self.crouch != 0 || self.sliding != 0 {
                0.75
            } else {
                1.1
            },
            t_z,
        );
        let (known_x, known_z, live) = if at_ally {
            (t_x, t_z, true)
        } else {
            self.known_spot(i)
        };
        if !at_ally
            && self.robot_kind[i] == KIND_GRUNT
            && self.robot_elite[i] == 0
            && self.from_cover(
                i,
                known_x,
                known_z,
                live,
                t_chest,
                t_up,
                t_vx,
                t_vz,
                dt,
            )
        {
            return;
        }
        let dx = known_x - self.robot_x[i] as f64;
        let dz = known_z - self.robot_z[i] as f64;
        let d = Self::hypot2(dx, dz).max(1e-3);
        if self.robot_mode[i] != MODE_LUNGE && Self::hypot2(dx, dz) > 0.5 {
            let turn = self.kind_of(i).turn
                * if self.robot_elite[i] != 0 {
                    ELITE_TURN
                } else {
                    1.0
                };
            self.turn_at(i, dx.atan2(-dz), turn, dt);
        }
        let k = self.kind_of(i);
        match self.robot_mode[i] {
            MODE_MOVE => {
                let sees = live
                    && self.facing(i, t_x, t_z)
                    && {
                        let m = self.muzzle(i);
                        self.los(m, t_chest, false)
                    };
                // Hunt via: in-WASM field toward known / pursuit goal.
                let (tx, tz, vd, has_via) = if !sees {
                    let (tx, tz) = self.engaged_via(i, known_x, known_z);
                    let vd = Self::hypot2(
                        tx - self.robot_x[i] as f64,
                        tz - self.robot_z[i] as f64,
                    )
                    .max(1e-3);
                    (tx, tz, vd, true)
                } else {
                    (known_x, known_z, d, false)
                };
                let ux = (tx - self.robot_x[i] as f64) / vd;
                let uz = (tz - self.robot_z[i] as f64) / vd;
                let mut along = 0.0;
                // At a hunt/search waypoint with nobody in view: stand (TS `after && !afterVia`).
                if has_via && vd < 1.5 && !sees {
                    along = 0.0;
                } else if !sees || d > k.range + 4.0 {
                    along = 1.0;
                } else if !at_ally && !self.located(i) && self.robot_finding[i] <= 0.0 {
                    along = 1.0;
                } else if d < k.range - 4.0 {
                    along = -0.7;
                }
                let side = (if self.robot_kind[i] == KIND_CHARGER {
                    0.55
                } else if sees {
                    DODGE_STRAFE
                } else {
                    0.8
                }) * if self.robot_jink[i] > 0.0 {
                    DODGE_JINK_SPEED
                } else {
                    1.0
                };
                let strafe = self.robot_strafe[i] as f64;
                let vx = (ux * along - uz * strafe * side) * k.speed;
                let vz = (uz * along + ux * strafe * side) * k.speed;
                if self.move_body(i, vx, vz, dt) {
                    self.robot_strafe[i] = -self.robot_strafe[i];
                } else if self.robot_jink[i] <= 0.0 {
                    self.robot_strafe_t[i] = (self.robot_strafe_t[i] as f64 - dt) as f32;
                    if self.robot_strafe_t[i] <= 0.0 {
                        self.robot_strafe_t[i] =
                            (DODGE_EVERY0 + self.draw() * (DODGE_EVERY1 - DODGE_EVERY0)) as f32;
                        if self.draw() < DODGE_FLIP {
                            self.robot_strafe[i] = -self.robot_strafe[i];
                        }
                    }
                }
                self.robot_cooldown[i] = (self.robot_cooldown[i] as f64 - dt) as f32;
                let ready = self.robot_cooldown[i] <= 0.0
                    && sees
                    && t_up
                    && (at_ally || self.located(i));
                let eye = self.head_of(i);
                let reach =
                    Self::hypot3(t_chest.0 - eye.0, t_chest.1 - eye.1, t_chest.2 - eye.2);
                let far = if at_ally {
                    k.sight_range * self.sight_scale * AWARE_ENGAGED_RANGE
                } else {
                    self.fire_range(i)
                };
                if ready
                    && (if self.robot_kind[i] == KIND_CHARGER {
                        d < CHARGER_LUNGE_RANGE
                    } else {
                        reach < far
                    })
                {
                    self.robot_mode[i] = MODE_TELEGRAPH;
                    let follow = if (self.robot_fired[i] as f64) < SHOT_FOLLOW_WINDOW {
                        SHOT_FOLLOW
                    } else {
                        1.0
                    };
                    self.robot_timer[i] = (k.telegraph * follow) as f32;
                    self.lead_aim(i, t_chest, (t_vx, 0.0, t_vz));
                }
            }
            MODE_TELEGRAPH => {
                self.windup_step(i, dx / d, dz / d, d > k.range + 4.0, dt);
                self.robot_timer[i] = (self.robot_timer[i] as f64 - dt) as f32;
                if self.sight_on(i, t_x, t_z, t_chest) {
                    self.lead_aim(i, t_chest, (t_vx, 0.0, t_vz));
                }
                if self.robot_timer[i] <= 0.0 {
                    if self.robot_kind[i] == KIND_CHARGER {
                        self.robot_mode[i] = MODE_LUNGE;
                        self.robot_timer[i] = CHARGER_LUNGE_TIME as f32;
                        self.robot_shots_left[i] = 1;
                        self.robot_yaw[i] = self.robot_aim_yaw[i];
                    } else if self.sight_on(i, t_x, t_z, t_chest) {
                        self.robot_mode[i] = MODE_FIRE;
                        self.robot_timer[i] = 0.0;
                        let still = Self::hypot2(t_vx, t_vz) < SHOT_STILL;
                        self.robot_shots_left[i] =
                            k.shots + if k.spread == 0.0 && still { SHOT_EXTRA } else { 0 };
                    } else {
                        self.robot_mode[i] = MODE_MOVE;
                        self.robot_cooldown[i] = 0.5;
                    }
                }
            }
            MODE_FIRE => {
                self.windup_step(i, dx / d, dz / d, d > k.range + 4.0, dt);
                self.robot_timer[i] = (self.robot_timer[i] as f64 - dt) as f32;
                if self.robot_timer[i] <= 0.0 && self.robot_shots_left[i] > 0 {
                    if self.sight_on(i, t_x, t_z, t_chest) {
                        self.lead_aim(i, t_chest, (t_vx, 0.0, t_vz));
                    }
                    let still = Self::hypot2(t_vx, t_vz) < SHOT_STILL;
                    let wide = if still { SHOT_STEADY } else { 1.0 };
                    if k.spread > 0.0 {
                        let fan = k.spread * if still { SHOT_FAN } else { 1.0 };
                        let shots = k.shots;
                        for s in 0..shots {
                            let off = ((s as f64 - (shots as f64 - 1.0) / 2.0) * fan * PI) / 180.0;
                            self.spawn_orb(i, off, wide, false);
                        }
                        self.robot_shots_left[i] = 0;
                    } else {
                        self.spawn_orb(i, 0.0, wide, false);
                        self.robot_shots_left[i] -= 1;
                        self.robot_timer[i] = k.shot_gap as f32;
                    }
                }
                if self.robot_shots_left[i] <= 0 {
                    self.robot_mode[i] = MODE_MOVE;
                    self.robot_opener[i] = 0;
                    let still = Self::hypot2(t_vx, t_vz) < SHOT_STILL;
                    let elite = if self.robot_elite[i] != 0 {
                        ELITE_COOLDOWN
                    } else {
                        1.0
                    };
                    let share = 1.0 + SHOT_SHARE * self.others_firing(i);
                    let press = if still { SHOT_PRESS } else { 1.0 };
                    let cd = k.cooldown * (0.8 + self.draw() * 0.4) * elite * press * share;
                    self.robot_cooldown[i] = cd as f32;
                    self.robot_fired[i] = 0.0;
                    self.robot_peek_side[i] = -self.robot_peek_side[i];
                    self.robot_cover_t[i] = 0.0;
                }
            }
            MODE_LUNGE => {
                let yaw = self.robot_yaw[i] as f64;
                let vx = yaw.sin() * CHARGER_LUNGE_SPEED;
                let vz = -yaw.cos() * CHARGER_LUNGE_SPEED;
                self.robot_vx[i] = vx as f32;
                self.robot_vz[i] = vz as f32;
                let hit_wall = self.move_body(i, vx, vz, dt);
                if self.robot_shots_left[i] > 0 {
                    let pr = Self::hypot2(
                        self.px - self.robot_x[i] as f64,
                        self.pz - self.robot_z[i] as f64,
                    );
                    if pr < CHARGER_HIT_R + PLAYER_RADIUS
                        && (self.py - self.robot_y[i] as f64).abs() < 1.4
                    {
                        self.robot_shots_left[i] = 0;
                        self.hits.push(HitEvent {
                            orb: 0,
                            kind: HIT_PLAYER,
                            _pad: [0; 3],
                            target_id: -1,
                            dmg: k.orb_dmg as f32,
                            from_x: self.robot_x[i],
                            from_z: self.robot_z[i],
                        });
                    }
                    if self.ally_up != 0 {
                        let ar = Self::hypot2(
                            self.ax - self.robot_x[i] as f64,
                            self.az - self.robot_z[i] as f64,
                        );
                        if ar < CHARGER_HIT_R + ALLY_RADIUS
                            && (self.ay - self.robot_y[i] as f64).abs() < 1.4
                        {
                            self.robot_shots_left[i] = 0;
                            self.hits.push(HitEvent {
                                orb: 0,
                                kind: HIT_ALLY,
                                _pad: [0; 3],
                                target_id: -1,
                                dmg: k.orb_dmg as f32,
                                from_x: self.robot_x[i],
                                from_z: self.robot_z[i],
                            });
                        }
                    }
                }
                self.robot_timer[i] = (self.robot_timer[i] as f64 - dt) as f32;
                if self.robot_timer[i] <= 0.0 || hit_wall {
                    self.robot_mode[i] = MODE_RECOVER;
                    self.robot_timer[i] = 1.0;
                }
            }
            MODE_RECOVER => {
                self.move_body(i, 0.0, 0.0, dt);
                self.robot_timer[i] = (self.robot_timer[i] as f64 - dt) as f32;
                if self.robot_timer[i] <= 0.0 {
                    self.robot_mode[i] = MODE_MOVE;
                    self.robot_cooldown[i] =
                        (k.cooldown * (0.8 + self.draw() * 0.4)) as f32;
                }
            }
            _ => {
                self.move_body(i, 0.0, 0.0, dt);
            }
        }
    }

    /// Advance all enemy robots one tick (friends skipped). Orbs may be spawned.
    pub fn step_enemies(&mut self, dt: f64) {
        let stagger_decay = (-TICK / STAGGER_WINDOW).exp();
        let n = self.n_robots as usize;
        for i in 0..n {
            if self.robot_flags[i] & ROBOT_FRIEND != 0 {
                continue;
            }
            if self.robot_hp[i] <= 0.0 {
                continue;
            }
            self.robot_last_hit[i] = (self.robot_last_hit[i] as f64 + dt) as f32;
            self.robot_fired[i] = (self.robot_fired[i] as f64 + dt) as f32;
            self.robot_ally_hit[i] = (self.robot_ally_hit[i] as f64 + dt) as f32;
            self.robot_blind[i] = (self.robot_blind[i] as f64 + dt) as f32;
            self.robot_jink[i] = (self.robot_jink[i] as f64 - dt).max(0.0) as f32;
            self.robot_steady[i] = (self.robot_steady[i] as f64 - dt).max(0.0) as f32;
            self.robot_stagger[i] = (self.robot_stagger[i] as f64 * stagger_decay) as f32;
            self.robot_duck[i] =
                (self.robot_duck[i] as f64 - DUCK_RATE * dt).max(0.0) as f32;

            if self.robot_mode[i] == MODE_SPAWNING {
                self.robot_timer[i] = (self.robot_timer[i] as f64 - dt) as f32;
                if self.robot_timer[i] <= 0.0 {
                    self.robot_mode[i] = MODE_MOVE;
                    let k = self.kind_of(i);
                    self.robot_cooldown[i] = (k.cooldown * (0.4 + self.draw() * 0.5)) as f32;
                }
                continue;
            }
            self.sense(i, dt);
            let mode = self.robot_mode[i];
            if mode == MODE_STUNNED || mode == MODE_STAGGERED {
                self.robot_timer[i] = (self.robot_timer[i] as f64 - dt) as f32;
                self.move_body(i, 0.0, 0.0, dt);
                if self.robot_timer[i] <= 0.0 {
                    let cool = if mode == MODE_STAGGERED { 0.4 } else { 0.6 };
                    if (self.robot_cooldown[i] as f64) < cool {
                        self.robot_cooldown[i] = cool as f32;
                    }
                    self.robot_mode[i] = MODE_MOVE;
                }
                continue;
            }
            if self.robot_aware[i] != AWARE_ENGAGED {
                // Titan wake when player enters arena.
                if self.robot_kind[i] == KIND_TITAN
                    && Self::hypot2(
                        self.robot_x[i] as f64 - self.px,
                        self.robot_z[i] as f64 - self.pz,
                    ) < 24.0
                    && self.player_downed == 0
                    && self.phase_play != 0
                {
                    self.engage_squad(self.robot_squad[i], i);
                } else {
                    let sq = self.robot_squad[i];
                    if sq >= 0
                        && (sq as usize) < self.n_squads as usize
                        && self.squad_near[sq as usize] == 0
                        && (self.world_tick.wrapping_add(sq as u32)) % FAR_THINK_EVERY != 0
                    {
                        self.move_body(i, 0.0, 0.0, dt);
                        continue;
                    }
                    let foe = self.foe_index(i);
                    if foe >= 0 {
                        self.fight_foe(i, foe as usize, dt);
                    } else {
                        self.calm(i, dt);
                    }
                    continue;
                }
            }
            if self.robot_aware[i] == AWARE_ENGAGED {
                self.step_engaged(i, dt);
            }
        }
    }
    fn walk_to(
        &mut self,
        i: usize,
        tx: f64,
        tz: f64,
        speed: f64,
        face: bool,
        dt: f64,
    ) -> bool {
        let dx = tx - self.robot_x[i] as f64;
        let dz = tz - self.robot_z[i] as f64;
        let d = Self::hypot2(dx, dz);
        if d < 0.35 {
            self.move_body(i, 0.0, 0.0, dt);
            return true;
        }
        if face {
            let yaw = dx.atan2(-dz);
            let cur = self.robot_yaw[i] as f64;
            self.robot_yaw[i] =
                (cur + Self::wrap_angle(yaw - cur) * (dt * 4.0).min(1.0)) as f32;
        }
        if self.move_body(i, (dx / d) * speed, (dz / d) * speed, dt) {
            self.robot_strafe[i] = -self.robot_strafe[i];
        }
        false
    }

    fn on_walkable(&self, i: usize) -> bool {
        let k = self.kind_of(i);
        k.fly == 0.0 && self.hunt.on_main(self.robot_x[i] as f64, self.robot_z[i] as f64)
    }

    /// Sticky hunt vias: rebuild at most every VIA_REFRESH ticks unless the goal moved.
    const VIA_REFRESH: u32 = 12;

    fn sticky_via(&mut self, i: usize, gx: f64, gz: f64, reach: f64) -> (f64, f64) {
        let x = self.robot_x[i] as f64;
        let z = self.robot_z[i] as f64;
        // Refresh sparsely — full Dijkstra every tick is what blew warm bench.
        if self.robot_has_via[i] != 0
            && self.world_tick.wrapping_add(i as u32) % Self::VIA_REFRESH != 0
        {
            let vd = Self::hypot2(
                self.robot_via_x[i] as f64 - x,
                self.robot_via_z[i] as f64 - z,
            );
            if vd > 0.4 {
                return (self.robot_via_x[i] as f64, self.robot_via_z[i] as f64);
            }
        }
        let (vx, vz) = self.hunt.next_via(x, z, gx, gz, reach);
        self.robot_via_x[i] = vx as f32;
        self.robot_via_z[i] = vz as f32;
        self.robot_has_via[i] = 1;
        (vx, vz)
    }

    fn hunt_step(&mut self, i: usize, gx: f64, gz: f64, reach: f64) -> (f64, f64) {
        if !self.on_walkable(i) {
            return (gx, gz);
        }
        self.sticky_via(i, gx, gz, reach)
    }

    fn trip_step(&mut self, i: usize, gx: f64, gz: f64) -> (f64, f64) {
        let x = self.robot_x[i] as f64;
        let z = self.robot_z[i] as f64;
        let beside = self.hunt.on_main(x + 2.0, z)
            || self.hunt.on_main(x - 2.0, z)
            || self.hunt.on_main(x, z + 2.0)
            || self.hunt.on_main(x, z - 2.0);
        if !self.on_walkable(i) && !beside {
            return (gx, gz);
        }
        // Never build a whole-world field on the hot path (ABI5 warm regression).
        let d = Self::hypot2(gx - x, gz - z);
        let reach = (d * 3.0 + 40.0).max(80.0).min(220.0);
        self.sticky_via(i, gx, gz, reach)
    }

    fn home_step(&mut self, i: usize, gx: f64, gz: f64) -> (f64, f64) {
        let sq = self.robot_squad[i];
        if sq >= 0
            && (sq as usize) < self.n_squads as usize
            && self.squad_flags[sq as usize] & SQUAD_ROUTED != 0
        {
            return (gx, gz);
        }
        if !self.on_walkable(i) {
            return (gx, gz);
        }
        self.sticky_via(i, gx, gz, PURSUE_REACH)
    }

    fn to_segment(px: f64, pz: f64, ax: f64, az: f64, bx: f64, bz: f64) -> f64 {
        let dx = bx - ax;
        let dz = bz - az;
        let l2 = dx * dx + dz * dz;
        let t = if l2 > 0.0 {
            ((px - ax) * dx + (pz - az) * dz) / l2
        } else {
            0.0
        }
        .clamp(0.0, 1.0);
        Self::hypot2(px - ax - dx * t, pz - az - dz * t)
    }

    fn squad_slot(&self, i: usize) -> usize {
        let sq = self.robot_squad[i];
        if sq < 0 {
            return 0;
        }
        let mut slot = 0usize;
        for j in 0..i {
            if self.robot_squad[j] != sq {
                continue;
            }
            if self.robot_flags[j] & ROBOT_FRIEND != 0 {
                continue;
            }
            if self.robot_hp[j] > 0.0 {
                slot += 1;
            }
        }
        slot
    }

    fn foe_index(&self, i: usize) -> i32 {
        let sq = self.robot_squad[i];
        if sq < 0 || (sq as usize) >= self.n_squads as usize {
            return -1;
        }
        let foe_id = self.squad_foe_id[sq as usize];
        if foe_id < 0 {
            return -1;
        }
        for j in 0..self.n_robots as usize {
            if self.robot_id[j] == foe_id && self.robot_hp[j] > 0.0 {
                return j as i32;
            }
        }
        -1
    }

    fn calm_look(&mut self, i: usize, flags: u8, dt: f64) {
        let look = self.robot_look_t[i] as f64;
        if flags & CALM_LOOK_ALERT != 0 {
            self.robot_yaw[i] = (self.robot_yaw[i] as f64 + look.sin() * 1.3 * dt * 1.6) as f32;
        } else if flags & CALM_LOOK_PARTY != 0 {
            self.robot_yaw[i] = (self.robot_yaw[i] as f64 + look.sin() * 0.7 * dt * 0.9) as f32;
        } else if flags & CALM_LOOK_AMBUSH != 0 {
            let face = self.robot_face[i] as f64 + look.sin() * 0.5 * 0.4;
            let cur = self.robot_yaw[i] as f64;
            self.robot_yaw[i] =
                (cur + Self::wrap_angle(face - cur) * (dt * 2.0).min(1.0)) as f32;
        } else if flags & CALM_LOOK_HOME != 0 {
            let face = self.robot_face[i] as f64 + look.sin() * 0.45 * 0.7;
            let cur = self.robot_yaw[i] as f64;
            self.robot_yaw[i] =
                (cur + Self::wrap_angle(face - cur) * (dt * 1.5).min(1.0)) as f32;
        }
    }

    fn calm_flags_for(&self, sq: usize) -> u8 {
        if self.squad_boss[sq] != 0 {
            return CALM_BOSS | CALM_LOOK_HOME;
        }
        if self.squad_has_walk[sq] != 0 || self.squad_has_party[sq] != 0 {
            return CALM_LOOK_PARTY;
        }
        if self.squad_has_ambush[sq] != 0 {
            return CALM_LOOK_AMBUSH;
        }
        CALM_LOOK_HOME
    }

    fn calm(&mut self, i: usize, dt: f64) {
        self.robot_look_t[i] = (self.robot_look_t[i] as f64 + dt) as f32;
        let mode = self.robot_mode[i];
        if mode != MODE_MOVE && mode != MODE_SPAWNING {
            self.robot_mode[i] = MODE_MOVE;
        }
        let k = self.kind_of(i);
        let slow = k.speed * AWARE_IDLE_SPEED;
        let sq_i = self.robot_squad[i];
        let flags = if sq_i >= 0 && (sq_i as usize) < self.n_squads as usize {
            self.calm_flags_for(sq_i as usize)
        } else {
            CALM_LOOK_HOME
        };

        if self.robot_aware[i] == AWARE_ALERT {
            self.robot_search_t[i] = (self.robot_search_t[i] as f64 - dt) as f32;
            if flags & CALM_BOSS != 0 {
                if self.robot_has_goal[i] != 0 {
                    let gx = self.robot_goal_x[i] as f64;
                    let gz = self.robot_goal_z[i] as f64;
                    let yaw = (gx - self.robot_x[i] as f64).atan2(-(gz - self.robot_z[i] as f64));
                    let cur = self.robot_yaw[i] as f64;
                    self.robot_yaw[i] =
                        (cur + Self::wrap_angle(yaw - cur) * (dt * 2.0).min(1.0)) as f32;
                }
                let hx = self.robot_home_x[i] as f64;
                let hz = self.robot_home_z[i] as f64;
                if Self::hypot2(hx - self.robot_x[i] as f64, hz - self.robot_z[i] as f64) > 0.8 {
                    self.walk_to(i, hx, hz, slow, true, dt);
                } else {
                    self.move_body(i, 0.0, 0.0, dt);
                }
            } else if self.robot_has_goal[i] != 0 {
                let gx = self.robot_goal_x[i] as f64;
                let gz = self.robot_goal_z[i] as f64;
                let d = Self::hypot2(gx - self.robot_x[i] as f64, gz - self.robot_z[i] as f64);
                if d > 2.5 {
                    let sweep = sq_i >= 0
                        && (sq_i as usize) < self.n_squads as usize
                        && self.squad_flags[sq_i as usize] & SQUAD_SWEEP != 0;
                    let sp = if sweep {
                        k.speed * SWEEP_PACE
                    } else {
                        slow * 1.4
                    };
                    let (vx, vz) = self.hunt_step(i, gx, gz, PURSUE_REACH);
                    self.walk_to(i, vx, vz, sp, true, dt);
                } else {
                    self.move_body(i, 0.0, 0.0, dt);
                    self.calm_look(i, CALM_LOOK_ALERT, dt);
                }
            } else {
                self.move_body(i, 0.0, 0.0, dt);
                self.calm_look(i, CALM_LOOK_ALERT, dt);
            }
            if self.robot_search_t[i] <= 0.0 {
                self.robot_aware[i] = AWARE_IDLE;
                self.robot_has_goal[i] = 0;
            }
            return;
        }

        if sq_i < 0 || (sq_i as usize) >= self.n_squads as usize {
            if Self::hypot2(
                self.robot_home_x[i] as f64 - self.robot_x[i] as f64,
                self.robot_home_z[i] as f64 - self.robot_z[i] as f64,
            ) > 0.8
            {
                let (hx, hz) = (
                    self.robot_home_x[i] as f64,
                    self.robot_home_z[i] as f64,
                );
                let via = if Self::hypot2(hx - self.robot_x[i] as f64, hz - self.robot_z[i] as f64)
                    > STRAY
                {
                    self.home_step(i, hx, hz)
                } else {
                    (hx, hz)
                };
                self.walk_to(i, via.0, via.1, slow, true, dt);
            } else {
                self.move_body(i, 0.0, 0.0, dt);
                self.calm_look(i, CALM_LOOK_HOME, dt);
            }
            return;
        }

        let sq = sq_i as usize;
        let slot = self.squad_slot(i);

        if self.squad_has_walk[sq] != 0 {
            let wx = self.squad_walk_x[sq] as f64;
            let wz = self.squad_walk_z[sq] as f64;
            let to_x = wx + (if slot % 2 == 1 { 1.6 } else { -1.6 }) * (slot.min(1) as f64);
            let to_z = wz + slot as f64 * 1.4;
            let pace = slow
                * if self.squad_flags[sq] & SQUAD_CREW != 0 {
                    CREW_PACE
                } else {
                    PARTY_PACE
                };
            if Self::hypot2(to_x - self.robot_x[i] as f64, to_z - self.robot_z[i] as f64) > 0.8 {
                let via = self.trip_step(i, to_x, to_z);
                self.walk_to(i, via.0, via.1, pace, true, dt);
            } else {
                self.move_body(i, 0.0, 0.0, dt);
                self.calm_look(i, CALM_LOOK_PARTY, dt);
            }
            return;
        }

        if self.squad_has_party[sq] != 0 {
            let px = self.squad_party_x[sq] as f64;
            let pz = self.squad_party_z[sq] as f64;
            let to_x = px + (if slot % 2 == 1 { 1.6 } else { -1.6 }) * (slot.min(1) as f64);
            let to_z = pz + slot as f64 * 1.4;
            if Self::hypot2(to_x - self.robot_x[i] as f64, to_z - self.robot_z[i] as f64) > 0.8 {
                let via = self.trip_step(i, to_x, to_z);
                self.walk_to(i, via.0, via.1, slow * PARTY_PACE, true, dt);
            } else {
                self.move_body(i, 0.0, 0.0, dt);
                self.calm_look(i, CALM_LOOK_PARTY, dt);
            }
            return;
        }

        if self.squad_has_ambush[sq] != 0 {
            let ax = self.squad_ambush_x[sq] as f64;
            let az = self.squad_ambush_z[sq] as f64;
            let to_x = ax + (if slot % 2 == 1 { 2.2 } else { -2.2 }) * (slot.min(1) as f64);
            let to_z = az + slot as f64 * 1.8;
            self.robot_face[i] = self.squad_ambush_face[sq];
            if Self::hypot2(to_x - self.robot_x[i] as f64, to_z - self.robot_z[i] as f64) > 1.0 {
                let via = if Self::hypot2(to_x - self.robot_x[i] as f64, to_z - self.robot_z[i] as f64)
                    > STRAY
                {
                    self.home_step(i, to_x, to_z)
                } else {
                    (to_x, to_z)
                };
                self.walk_to(i, via.0, via.1, slow * 1.6, true, dt);
            } else {
                self.move_body(i, 0.0, 0.0, dt);
                self.calm_look(i, CALM_LOOK_AMBUSH, dt);
            }
            return;
        }

        if self.squad_has_patrol[sq] != 0 && self.robot_kind[i] != KIND_TITAN {
            let wx = self.squad_patrol_x[sq] as f64;
            let wz = self.squad_patrol_z[sq] as f64;
            let to_x = wx + (if slot % 2 == 1 { 1.6 } else { -1.6 }) * (slot.min(1) as f64);
            let to_z = wz + slot as f64 * 1.4;
            let prev_x = self.squad_patrol_prev_x[sq] as f64;
            let prev_z = self.squad_patrol_prev_z[sq] as f64;
            let diverted = Self::to_segment(
                self.robot_x[i] as f64,
                self.robot_z[i] as f64,
                prev_x,
                prev_z,
                wx,
                wz,
            ) > STRAY;
            let via = if diverted {
                self.home_step(i, to_x, to_z)
            } else {
                (to_x, to_z)
            };
            let mut pace = self.squad_patrol_pace[sq] as f64;
            if pace <= 0.0 {
                pace = if self.squad_flags[sq] & SQUAD_PACK != 0 {
                    k.speed * PACK_PACE
                } else if self.squad_flags[sq] & (SQUAD_MOBILE | SQUAD_BATTLE) != 0 {
                    slow * PATROL_PACE
                } else {
                    slow
                };
            }
            let arrived = self.walk_to(i, via.0, via.1, pace, true, dt);
            if arrived && !diverted && slot == 0 {
                self.squad_leg[sq] = self.squad_leg[sq].wrapping_add(1);
            }
            return;
        }

        let hx = self.robot_home_x[i] as f64;
        let hz = self.robot_home_z[i] as f64;
        if Self::hypot2(hx - self.robot_x[i] as f64, hz - self.robot_z[i] as f64) > 0.8 {
            let via = if Self::hypot2(hx - self.robot_x[i] as f64, hz - self.robot_z[i] as f64) > STRAY
            {
                self.home_step(i, hx, hz)
            } else {
                (hx, hz)
            };
            self.walk_to(i, via.0, via.1, slow, true, dt);
        } else {
            self.move_body(i, 0.0, 0.0, dt);
            self.calm_look(i, CALM_LOOK_HOME, dt);
        }
    }

    fn fight_foe(&mut self, i: usize, foe: usize, dt: f64) {
        if foe >= self.n_robots as usize || self.robot_hp[foe] <= 0.0 {
            return;
        }
        let k = self.kind_of(i);
        let fx = self.robot_x[foe] as f64;
        let fy = self.robot_y[foe] as f64;
        let fz = self.robot_z[foe] as f64;
        let at = (fx, fy + self.body_y_of(foe), fz);
        let dx = fx - self.robot_x[i] as f64;
        let dz = fz - self.robot_z[i] as f64;
        let d = Self::hypot2(dx, dz).max(1e-3);
        let ux = dx / d;
        let uz = dz / d;
        let mode = self.robot_mode[i];
        if mode != MODE_TELEGRAPH && mode != MODE_FIRE {
            self.robot_mode[i] = MODE_MOVE;
        }
        self.turn_at(i, dx.atan2(-dz), k.turn, dt);
        let sees = self.sight_on(i, fx, fz, at);
        let fvx = self.robot_vx[foe] as f64;
        let fvz = self.robot_vz[foe] as f64;
        match self.robot_mode[i] {
            MODE_MOVE => {
                let (vx, vz) = if !sees {
                    if d > 3.0 {
                        let (tx, tz) = self.home_step(i, fx, fz);
                        let td = Self::hypot2(
                            tx - self.robot_x[i] as f64,
                            tz - self.robot_z[i] as f64,
                        )
                        .max(1e-3);
                        (
                            ((tx - self.robot_x[i] as f64) / td) * k.speed,
                            ((tz - self.robot_z[i] as f64) / td) * k.speed,
                        )
                    } else {
                        (ux * k.speed, uz * k.speed)
                    }
                } else {
                    let along = if self.robot_kind[i] == KIND_CHARGER || d > k.range + 4.0 {
                        1.0
                    } else if d < k.range - 4.0 {
                        -0.7
                    } else {
                        0.0
                    };
                    let side = if self.robot_kind[i] == KIND_CHARGER {
                        0.3
                    } else {
                        DODGE_STRAFE
                    };
                    let strafe = self.robot_strafe[i] as f64;
                    (
                        (ux * along - uz * strafe * side) * k.speed,
                        (uz * along + ux * strafe * side) * k.speed,
                    )
                };
                if self.robot_flags[i] & ROBOT_POST != 0 {
                    self.move_body(i, 0.0, 0.0, dt);
                } else if self.move_body(i, vx, vz, dt) {
                    self.robot_strafe[i] = -self.robot_strafe[i];
                } else {
                    self.robot_strafe_t[i] = (self.robot_strafe_t[i] as f64 - dt) as f32;
                    if self.robot_strafe_t[i] <= 0.0 {
                        self.robot_strafe_t[i] =
                            (DODGE_EVERY0 + self.draw() * (DODGE_EVERY1 - DODGE_EVERY0)) as f32;
                        if self.draw() < DODGE_FLIP {
                            self.robot_strafe[i] = -self.robot_strafe[i];
                        }
                    }
                }
                self.robot_cooldown[i] = (self.robot_cooldown[i] as f64 - dt) as f32;
                if self.robot_kind[i] == KIND_CHARGER {
                    let foe_r = self.robot_radius[foe] as f64;
                    if self.robot_cooldown[i] <= 0.0
                        && d < CHARGER_HIT_R + foe_r + 0.4
                        && (fy - self.robot_y[i] as f64).abs() < 1.6
                    {
                        self.robot_cooldown[i] = k.cooldown as f32;
                        self.hits.push(HitEvent {
                            orb: 0,
                            kind: HIT_ROBOT,
                            _pad: [0; 3],
                            target_id: self.robot_id[foe],
                            dmg: k.orb_dmg as f32,
                            from_x: self.robot_x[i],
                            from_z: self.robot_z[i],
                        });
                    }
                    return;
                }
                let eye = self.head_of(i);
                let reach = Self::hypot3(at.0 - eye.0, at.1 - eye.1, at.2 - eye.2);
                let far = k.sight_range * self.sight_scale * AWARE_ENGAGED_RANGE;
                if self.robot_cooldown[i] <= 0.0 && sees && reach < far {
                    self.robot_mode[i] = MODE_TELEGRAPH;
                    self.robot_timer[i] = k.telegraph as f32;
                    self.lead_aim(i, at, (fvx, 0.0, fvz));
                }
            }
            MODE_TELEGRAPH => {
                self.windup_step(i, ux, uz, false, dt);
                self.robot_timer[i] = (self.robot_timer[i] as f64 - dt) as f32;
                if sees {
                    self.lead_aim(i, at, (fvx, 0.0, fvz));
                }
                if self.robot_timer[i] <= 0.0 {
                    if sees {
                        self.robot_mode[i] = MODE_FIRE;
                        self.robot_timer[i] = 0.0;
                        self.robot_shots_left[i] = k.shots;
                    } else {
                        self.robot_mode[i] = MODE_MOVE;
                        self.robot_cooldown[i] = 0.5;
                    }
                }
            }
            MODE_FIRE => {
                self.windup_step(i, ux, uz, false, dt);
                self.robot_timer[i] = (self.robot_timer[i] as f64 - dt) as f32;
                if self.robot_timer[i] <= 0.0 && self.robot_shots_left[i] > 0 {
                    if sees {
                        self.lead_aim(i, at, (fvx, 0.0, fvz));
                    }
                    if k.spread > 0.0 {
                        let shots = k.shots;
                        for s in 0..shots {
                            let off = ((s as f64 - (shots as f64 - 1.0) / 2.0) * k.spread * PI)
                                / 180.0;
                            self.spawn_orb(i, off, 1.0, true);
                        }
                        self.robot_shots_left[i] = 0;
                    } else {
                        self.spawn_orb(i, 0.0, 1.0, true);
                        self.robot_shots_left[i] -= 1;
                        self.robot_timer[i] = k.shot_gap as f32;
                    }
                }
                if self.robot_shots_left[i] <= 0 {
                    self.robot_mode[i] = MODE_MOVE;
                    self.robot_cooldown[i] = (k.cooldown * (0.8 + self.draw() * 0.4)) as f32;
                }
            }
            _ => {
                self.move_body(i, 0.0, 0.0, dt);
            }
        }
    }

    fn same_floor(&self, from_x: f64, from_y: f64, from_z: f64, c: crate::cover_grid::CoverPt) -> bool {
        let t_ground = self.terrain_height(from_x, from_z);
        if (c.y - t_ground).abs() < 0.3 {
            return true;
        }
        let d = Self::hypot2(c.x - from_x, c.z - from_z);
        let n = (d / 0.5).ceil() as i32;
        for step in 1..n {
            let t = step as f64 / n as f64;
            let x = from_x + (c.x - from_x) * t;
            let z = from_z + (c.z - from_z) * t;
            let g = self.ground_at(x, z, 0.3, c.y + 0.3);
            if (g - c.y).abs() > COVER_LEVEL {
                return false;
            }
        }
        true
    }

    fn solid_at_y(&self, x: f64, y: f64, z: f64) -> bool {
        let feet = y;
        let g = self.ground_at(x, z, 0.3, feet + 0.5);
        g > feet + 0.8
    }

    fn find_cover(
        &mut self,
        i: usize,
        threat_x: f64,
        threat_z: f64,
        threat_y: f64,
    ) -> Option<(f64, f64, f64, f64)> {
        if !self.covers.ready() {
            return None;
        }
        let search = COVER_SEARCH;
        let head_y = threat_y + 1.5;
        let chest_y = threat_y + 1.1;
        let ex = self.robot_x[i] as f64;
        let ez = self.robot_z[i] as f64;
        let ey = self.robot_y[i] as f64;
        let mut cands: Vec<(u32, f64, f64)> = Vec::new();
        for idx in self.covers.near(ex, ez, search) {
            let c = self.covers.get(idx);
            let d = Self::hypot2(c.x - ex, c.z - ez);
            let dp = Self::hypot2(c.x - threat_x, c.z - threat_z);
            if d >= search || (c.y - ey).abs() > COVER_LEVEL {
                continue;
            }
            if dp <= COVER_MIN_FROM_PLAYER || dp >= COVER_MAX_FROM_PLAYER {
                continue;
            }
            let mut taken = false;
            for j in 0..self.n_robots as usize {
                if j == i || self.robot_has_cover[j] == 0 {
                    continue;
                }
                if Self::hypot2(
                    self.robot_cover_spot_x[j] as f64 - c.x,
                    self.robot_cover_spot_z[j] as f64 - c.z,
                ) < 1.5
                {
                    taken = true;
                    break;
                }
            }
            if taken {
                continue;
            }
            cands.push((idx, d, dp));
        }
        cands.sort_by(|a, b| {
            let sa = a.1 + (a.2 - 16.0).abs() * 0.3;
            let sb = b.1 + (b.2 - 16.0).abs() * 0.3;
            sa.partial_cmp(&sb).unwrap_or(std::cmp::Ordering::Equal)
        });
        cands.truncate(14);
        for &(idx, _, _) in &cands {
            let c = self.covers.get(idx);
            if self.los((c.x, c.y + COVER_TALL_Y, c.z), (threat_x, head_y, threat_z), false) {
                continue;
            }
            if !self.same_floor(ex, ey, ez, c) {
                continue;
            }
            for sign in [self.robot_peek_side[i] as f64, -self.robot_peek_side[i] as f64] {
                let peek_x = c.x + c.tx * sign * COVER_PEEK_DIST;
                let peek_z = c.z + c.tz * sign * COVER_PEEK_DIST;
                let pg = c.y;
                if (self.ground_at(peek_x, peek_z, 0.3, pg + 0.3) - pg).abs() > 0.3 {
                    continue;
                }
                if self.solid_at_y(peek_x, pg + 1.0, peek_z) {
                    continue;
                }
                if self.los((peek_x, pg + 1.6, peek_z), (threat_x, chest_y, threat_z), false) {
                    return Some((c.x, c.z, peek_x, peek_z));
                }
            }
        }
        None
    }

    /// Returns true when the grunt spent the tick in cover FSM (skip engaged move).
    fn from_cover(
        &mut self,
        i: usize,
        known_x: f64,
        known_z: f64,
        live: bool,
        t_chest: (f64, f64, f64),
        t_up: bool,
        t_vx: f64,
        t_vz: f64,
        dt: f64,
    ) -> bool {
        let k = self.kind_of(i);
        if self.robot_mode[i] != MODE_MOVE {
            return false;
        }
        if self.robot_target[i] == TARGET_PLAYER && !self.located(i) {
            return false;
        }
        if self.robot_opener[i] != 0
            && live
            && t_up
            && self.facing(i, t_chest.0, t_chest.2)
            && self.los(self.muzzle(i), t_chest, false)
        {
            return false;
        }
        self.robot_cover_t[i] = (self.robot_cover_t[i] as f64 - dt) as f32;
        if self.robot_cover_t[i] <= 0.0 || (self.robot_last_hit[i] as f64) < TICK * 1.5 {
            if let Some((cx, cz, px, pz)) =
                self.find_cover(i, known_x, known_z, t_chest.1 - 1.1)
            {
                self.robot_cover_spot_x[i] = cx as f32;
                self.robot_cover_spot_z[i] = cz as f32;
                self.robot_peek_x[i] = px as f32;
                self.robot_peek_z[i] = pz as f32;
                self.robot_has_cover[i] = 1;
            } else {
                self.robot_has_cover[i] = 0;
            }
            self.robot_cover_t[i] = 2.5;
        }
        if self.robot_has_cover[i] == 0 {
            return false;
        }
        self.robot_cooldown[i] = (self.robot_cooldown[i] as f64 - dt) as f32;
        let out = self.robot_cooldown[i] <= 0.0;
        let to_x = if out {
            self.robot_peek_x[i] as f64
        } else {
            self.robot_cover_spot_x[i] as f64
        };
        let to_z = if out {
            self.robot_peek_z[i] as f64
        } else {
            self.robot_cover_spot_z[i] as f64
        };
        if self.robot_stuck_x[i] as f64 != to_x || self.robot_stuck_z[i] as f64 != to_z {
            self.robot_stuck_x[i] = to_x as f32;
            self.robot_stuck_z[i] = to_z as f32;
            self.robot_stuck_t[i] = 0.0;
        }
        let before = Self::hypot2(
            self.robot_x[i] as f64 - to_x,
            self.robot_z[i] as f64 - to_z,
        );
        let arrived = self.walk_to(i, to_x, to_z, k.speed, false, dt);
        let after = Self::hypot2(
            self.robot_x[i] as f64 - to_x,
            self.robot_z[i] as f64 - to_z,
        );
        if before - after < k.speed * TICK * COVER_STUCK_PROGRESS {
            self.robot_stuck_t[i] = (self.robot_stuck_t[i] as f64 + dt) as f32;
        } else {
            self.robot_stuck_t[i] = 0.0;
        }
        let there = arrived || (self.robot_stuck_t[i] as f64) >= COVER_STUCK_TIME;
        if !out && there {
            self.robot_duck[i] =
                (self.robot_duck[i] as f64 + 2.0 * DUCK_RATE * dt).min(1.0) as f32;
        }
        let shows = out
            && live
            && t_up
            && self.facing(i, t_chest.0, t_chest.2)
            && self.los(
                (
                    self.robot_x[i] as f64,
                    self.robot_y[i] as f64 + self.weak_y(i),
                    self.robot_z[i] as f64,
                ),
                t_chest,
                false,
            );
        if out && (there || shows) {
            if shows {
                self.robot_mode[i] = MODE_TELEGRAPH;
                self.robot_timer[i] = k.telegraph as f32;
                let ox = self.robot_peek_x[i] as f64 - self.robot_cover_spot_x[i] as f64;
                let oz = self.robot_peek_z[i] as f64 - self.robot_cover_spot_z[i] as f64;
                self.robot_strafe[i] = if -(t_chest.2 - self.robot_z[i] as f64) * ox
                    + (t_chest.0 - self.robot_x[i] as f64) * oz
                    >= 0.0
                {
                    1.0
                } else {
                    -1.0
                };
                self.lead_aim(i, t_chest, (t_vx, 0.0, t_vz));
            } else {
                self.robot_peek_side[i] = -self.robot_peek_side[i];
                self.robot_cover_t[i] = 0.0;
                self.robot_cooldown[i] = 0.4;
            }
        }
        true
    }}
