/**
 * Coarse WASM tick host: enemy/orb SoA + world geom in linear memory.
 * With `RINGFALL_TICK` on: sync → `step_tick` (enemies then orbs) → pull + applyHits.
 * Default (Node / tick off) keeps TypeScript `stepOrbs` / `stepEnemies`. See docs/ringfall/native.md.
 */
import { ENEMIES, TICK, THREAT } from "../config";
import { BOXES, ROUTES } from "../map";
import { huntGridSnapshot } from "../hunt";
import { terrainFieldSnapshot } from "../terrain";
import { sightScale, type Enemy, type Orb, type State } from "../state";
import { bodyY } from "../state";
import { robotSide } from "../battle";
import { allyUp, hurtAlly } from "../ally";
import { hurtPlayer } from "../player";
import { damageRobot } from "../factions";
import { threatOf } from "../mods";
import { nativeExports } from "./fill";
import { ORBS_WASM, TICK_CHECK, TICK_WASM } from "./tick-flag";

const FLAG_FENCE = 1;
const FLAG_OBSTACLE = 2;
const ORB_HOMING = 1;
const ORB_FRIEND = 2;
const ORB_HAS_BY = 4;
const ROBOT_FRIEND = 1;
const ROBOT_BATTLE = 2;
const ROBOT_POI = 4;
const ROBOT_TITAN = 8;
const ROBOT_SPAWNING = 16;

const SQUAD_ENGAGED = 1;
const SQUAD_MOBILE = 2;
const SQUAD_RETREAT = 4;
const SQUAD_PACK = 8;
const SQUAD_ROUTED = 16;

const ABI_MIN = 4;

type Ex = NonNullable<ReturnType<typeof nativeExports>>;

function ex(): Ex | null {
  const e = nativeExports();
  if (!e?.ringfall_sim_step_tick || e.ringfall_sim_abi_version() < ABI_MIN) return null;
  return e;
}

function mem(e: Ex): WebAssembly.Memory {
  return e.memory;
}

/** TypedArray views on WASM memory — recreate only when the buffer grows or SoA begins. */
let viewBufLen = -1;
const viewF32 = new Map<string, Float32Array>();
const viewI32 = new Map<string, Int32Array>();
const viewU8 = new Map<string, Uint8Array>();

function bumpViews(e: Ex): void {
  const len = mem(e).buffer.byteLength;
  if (len !== viewBufLen) {
    viewBufLen = len;
    viewF32.clear();
    viewI32.clear();
    viewU8.clear();
  }
}

function invalidateViews(): void {
  viewF32.clear();
  viewI32.clear();
  viewU8.clear();
  viewBufLen = -1;
}

function f32(e: Ex, ptr: number, n: number): Float32Array {
  bumpViews(e);
  const key = `${ptr}:${n}`;
  let v = viewF32.get(key);
  const buf = mem(e).buffer;
  if (v && v.buffer === buf) return v;
  v = new Float32Array(buf, ptr, n);
  viewF32.set(key, v);
  return v;
}
function i32(e: Ex, ptr: number, n: number): Int32Array {
  bumpViews(e);
  const key = `${ptr}:${n}`;
  let v = viewI32.get(key);
  const buf = mem(e).buffer;
  if (v && v.buffer === buf) return v;
  v = new Int32Array(buf, ptr, n);
  viewI32.set(key, v);
  return v;
}
function u8(e: Ex, ptr: number, n: number): Uint8Array {
  bumpViews(e);
  const key = `${ptr}:${n}`;
  let v = viewU8.get(key);
  const buf = mem(e).buffer;
  if (v && v.buffer === buf) return v;
  v = new Uint8Array(buf, ptr, n);
  viewU8.set(key, v);
  return v;
}

let geomEpoch = -1;
let routesKey = "";

/** Pre-tick extras from TypeScript: hunt vias + fromCover skip (same order as syncRobots). */
let prepN = 0;
let prepViaX: Float32Array | null = null;
let prepViaZ: Float32Array | null = null;
let prepHasVia: Uint8Array | null = null;
let prepSkip: Uint8Array | null = null;

/** Fill SoA extras before `stepTick` (hunt vias + fromCover skip). */
export function setTickPrep(
  n: number,
  viaX: Float32Array,
  viaZ: Float32Array,
  hasVia: Uint8Array,
  skip: Uint8Array,
): void {
  prepN = n;
  prepViaX = viaX;
  prepViaZ = viaZ;
  prepHasVia = hasVia;
  prepSkip = skip;
}

function packBoxes(): Float32Array {
  const closed = new Set(ROUTES.flatMap((r) => r.closed));
  const all = [...BOXES, ...ROUTES.flatMap((r) => [...r.closed, ...r.open])];
  const out = new Float32Array(all.length * 7);
  for (let i = 0; i < all.length; i++) {
    const b = all[i];
    const o = i * 7;
    out[o] = b.x0;
    out[o + 1] = b.z0;
    out[o + 2] = b.x1;
    out[o + 3] = b.z1;
    out[o + 4] = b.y0;
    out[o + 5] = b.h;
    let flags = 0;
    if (b.kind === "fence") flags |= FLAG_FENCE;
    if (closed.has(b)) flags |= FLAG_OBSTACLE;
    out[o + 6] = flags;
  }
  return out;
}

function geomWanted(): boolean {
  return TICK_WASM;
}

/** Upload terrain + boxes once per world/routes (browser view / RINGFALL_TICK). */
export function uploadGeom(epoch: number, routes: readonly string[]): boolean {
  if (!geomWanted()) return false;
  const e = ex();
  if (!e) return false;
  const key = routes.slice().sort().join(",");
  if (geomEpoch === epoch && routesKey === key) return true;
  const snap = terrainFieldSnapshot();
  if (!snap) return false;
  e.ringfall_sim_reset!();
  invalidateViews();
  const tPtr = e.ringfall_sim_terrain_begin!(snap.nx, snap.nz, snap.x0, snap.z0, snap.res);
  f32(e, tPtr, snap.field.length).set(snap.field);
  e.ringfall_sim_terrain_commit!();
  const boxes = packBoxes();
  const bPtr = e.ringfall_sim_boxes_begin!(boxes.length / 7);
  f32(e, bPtr, boxes.length).set(boxes);
  e.ringfall_sim_boxes_commit!();
  // Hunt walkability once per world (TS grid + mask) — engaged vias compute inside WASM.
  if (
    e.ringfall_sim_hunt_begin &&
    e.ringfall_sim_hunt_open_ptr &&
    e.ringfall_sim_hunt_height_ptr &&
    e.ringfall_sim_hunt_main_ptr &&
    e.ringfall_sim_hunt_mask_ptr &&
    e.ringfall_sim_hunt_commit
  ) {
    const h = huntGridSnapshot();
    e.ringfall_sim_hunt_begin(h.nx, h.nz, h.x0, h.z0, h.res);
    u8(e, e.ringfall_sim_hunt_open_ptr(), h.open.length).set(h.open);
    f32(e, e.ringfall_sim_hunt_height_ptr(), h.height.length).set(h.height);
    u8(e, e.ringfall_sim_hunt_main_ptr(), h.main.length).set(h.main);
    u8(e, e.ringfall_sim_hunt_mask_ptr(), h.mask.length).set(h.mask);
    e.ringfall_sim_hunt_commit();
  }
  geomEpoch = epoch;
  routesKey = key;
  e.ringfall_sim_set_ready!(1);
  return true;
}

export type RobotViews = {
  n: number;
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  yaw: Float32Array;
  vx: Float32Array;
  vz: Float32Array;
  hp: Float32Array;
  shield: Float32Array;
  duck: Float32Array;
  id: Int32Array;
  kind: Uint8Array;
  mode: Uint8Array;
};

const KIND_I: Record<string, number> = { grunt: 0, heavy: 1, drone: 2, charger: 3, titan: 4 };
const KIND_S = ["grunt", "heavy", "drone", "charger", "titan"] as const;
const MODE_I: Record<string, number> = {
  idle: 0,
  alert: 1,
  move: 2,
  telegraph: 3,
  fire: 4,
  recover: 5,
  staggered: 6,
  spawning: 7,
  stomp: 8,
  lunge: 9,
  dead: 10,
  stunned: 11,
};
const MODE_S = [
  "idle",
  "alert",
  "move",
  "telegraph",
  "fire",
  "recover",
  "staggered",
  "spawning",
  "stomp",
  "lunge",
  "dead",
  "stunned",
] as const;
const AWARE_I: Record<string, number> = { idle: 0, alert: 1, engaged: 2 };
const AWARE_S = ["idle", "alert", "engaged"] as const;
const TARGET_I: Record<string, number> = { player: 0, ally: 1, friend: 2 };
const TARGET_S = ["player", "ally", "friend"] as const;

function bodyHeight(en: Enemy): number {
  const k = ENEMIES[en.kind];
  return Math.max(0.2, bodyY(en) + k.radius);
}

/** Push enemies+friends into WASM SoA (combat + orb hits). */
export function syncRobots(s: State): RobotViews | null {
  const e = ex();
  if (!e || geomEpoch < 0) return null;
  const list = s.friends.length ? [...s.enemies, ...s.friends] : s.enemies;
  const n = list.length;
  e.ringfall_sim_robots_begin!(n);
  const x = f32(e, e.ringfall_sim_robot_x_ptr!(), n);
  const y = f32(e, e.ringfall_sim_robot_y_ptr!(), n);
  const z = f32(e, e.ringfall_sim_robot_z_ptr!(), n);
  const yaw = f32(e, e.ringfall_sim_robot_yaw_ptr!(), n);
  const vx = f32(e, e.ringfall_sim_robot_vx_ptr!(), n);
  const vy = f32(e, e.ringfall_sim_robot_vy_ptr!(), n);
  const vz = f32(e, e.ringfall_sim_robot_vz_ptr!(), n);
  const hp = f32(e, e.ringfall_sim_robot_hp_ptr!(), n);
  const shield = f32(e, e.ringfall_sim_robot_shield_ptr!(), n);
  const duck = f32(e, e.ringfall_sim_robot_duck_ptr!(), n);
  const id = i32(e, e.ringfall_sim_robot_id_ptr!(), n);
  const kind = u8(e, e.ringfall_sim_robot_kind_ptr!(), n);
  const mode = u8(e, e.ringfall_sim_robot_mode_ptr!(), n);
  const flags = u8(e, e.ringfall_sim_robot_flags_ptr!(), n);
  const radius = f32(e, e.ringfall_sim_robot_radius_ptr!(), n);
  const bodyH = f32(e, e.ringfall_sim_robot_body_h_ptr!(), n);
  const side = u8(e, e.ringfall_sim_robot_side_ptr!(), n);
  const aware = u8(e, e.ringfall_sim_robot_aware_ptr!(), n);
  const detect = f32(e, e.ringfall_sim_robot_detect_ptr!(), n);
  const finding = f32(e, e.ringfall_sim_robot_finding_ptr!(), n);
  const blind = f32(e, e.ringfall_sim_robot_blind_ptr!(), n);
  const sawX = f32(e, e.ringfall_sim_robot_saw_x_ptr!(), n);
  const sawZ = f32(e, e.ringfall_sim_robot_saw_z_ptr!(), n);
  const hasSaw = u8(e, e.ringfall_sim_robot_has_saw_ptr!(), n);
  const timer = f32(e, e.ringfall_sim_robot_timer_ptr!(), n);
  const cooldown = f32(e, e.ringfall_sim_robot_cooldown_ptr!(), n);
  const shotsLeft = i32(e, e.ringfall_sim_robot_shots_left_ptr!(), n);
  const strafe = f32(e, e.ringfall_sim_robot_strafe_ptr!(), n);
  const strafeT = f32(e, e.ringfall_sim_robot_strafe_t_ptr!(), n);
  const jink = f32(e, e.ringfall_sim_robot_jink_ptr!(), n);
  const steady = f32(e, e.ringfall_sim_robot_steady_ptr!(), n);
  const stagger = f32(e, e.ringfall_sim_robot_stagger_ptr!(), n);
  const aimYaw = f32(e, e.ringfall_sim_robot_aim_yaw_ptr!(), n);
  const aimPitch = f32(e, e.ringfall_sim_robot_aim_pitch_ptr!(), n);
  const opener = u8(e, e.ringfall_sim_robot_opener_ptr!(), n);
  const peekSide = f32(e, e.ringfall_sim_robot_peek_side_ptr!(), n);
  const coverT = f32(e, e.ringfall_sim_robot_cover_t_ptr!(), n);
  const elite = u8(e, e.ringfall_sim_robot_elite_ptr!(), n);
  const target = u8(e, e.ringfall_sim_robot_target_ptr!(), n);
  const targetT = f32(e, e.ringfall_sim_robot_target_t_ptr!(), n);
  const squad = i32(e, e.ringfall_sim_robot_squad_ptr!(), n);
  const friendId = i32(e, e.ringfall_sim_robot_friend_id_ptr!(), n);
  const poi = i32(e, e.ringfall_sim_robot_poi_ptr!(), n);
  const lastHit = f32(e, e.ringfall_sim_robot_last_hit_ptr!(), n);
  const fired = f32(e, e.ringfall_sim_robot_fired_ptr!(), n);
  const allyHit = f32(e, e.ringfall_sim_robot_ally_hit_ptr!(), n);
  const homeX = f32(e, e.ringfall_sim_robot_home_x_ptr!(), n);
  const homeY = f32(e, e.ringfall_sim_robot_home_y_ptr!(), n);
  const homeZ = f32(e, e.ringfall_sim_robot_home_z_ptr!(), n);
  const goalX = f32(e, e.ringfall_sim_robot_goal_x_ptr!(), n);
  const goalZ = f32(e, e.ringfall_sim_robot_goal_z_ptr!(), n);
  const hasGoal = u8(e, e.ringfall_sim_robot_has_goal_ptr!(), n);
  const searchT = f32(e, e.ringfall_sim_robot_search_t_ptr!(), n);
  const viaX = f32(e, e.ringfall_sim_robot_via_x_ptr!(), n);
  const viaZ = f32(e, e.ringfall_sim_robot_via_z_ptr!(), n);
  const hasVia = u8(e, e.ringfall_sim_robot_has_via_ptr!(), n);
  const skip = u8(e, e.ringfall_sim_robot_skip_ptr!(), n);
  for (let i = 0; i < n; i++) {
    const en = list[i];
    x[i] = en.pos.x;
    y[i] = en.pos.y;
    z[i] = en.pos.z;
    yaw[i] = en.yaw;
    vx[i] = en.vel.x;
    vy[i] = en.vel.y;
    vz[i] = en.vel.z;
    hp[i] = en.hp;
    shield[i] = en.shield;
    duck[i] = en.duck;
    id[i] = en.id;
    kind[i] = KIND_I[en.kind] ?? 0;
    mode[i] = MODE_I[en.mode] ?? MODE_I.move;
    let f = 0;
    if (en.friend) f |= ROBOT_FRIEND;
    if (en.battle) f |= ROBOT_BATTLE;
    if (en.poi >= 0) f |= ROBOT_POI;
    if (en.kind === "titan") f |= ROBOT_TITAN;
    if (en.mode === "spawning") f |= ROBOT_SPAWNING;
    flags[i] = f;
    radius[i] = ENEMIES[en.kind].radius;
    bodyH[i] = bodyHeight(en);
    side[i] = robotSide(en);
    aware[i] = AWARE_I[en.aware] ?? 0;
    detect[i] = en.detect;
    finding[i] = en.finding;
    blind[i] = en.blind;
    if (en.sawAt) {
      sawX[i] = en.sawAt.x;
      sawZ[i] = en.sawAt.z;
      hasSaw[i] = 1;
    } else {
      hasSaw[i] = 0;
    }
    timer[i] = en.timer;
    cooldown[i] = en.cooldown;
    shotsLeft[i] = en.shotsLeft;
    strafe[i] = en.strafe;
    strafeT[i] = en.strafeT;
    jink[i] = en.jink;
    steady[i] = en.steady;
    stagger[i] = en.stagger;
    aimYaw[i] = en.aimYaw;
    aimPitch[i] = en.aimPitch;
    opener[i] = en.opener ? 1 : 0;
    peekSide[i] = en.peekSide;
    coverT[i] = en.coverT;
    elite[i] = en.elite ? 1 : 0;
    target[i] = TARGET_I[en.target] ?? 0;
    targetT[i] = en.targetT;
    squad[i] = en.squad;
    friendId[i] = en.friendId ?? -1;
    poi[i] = en.poi;
    lastHit[i] = en.lastHit;
    fired[i] = en.fired;
    allyHit[i] = en.allyHit;
    homeX[i] = en.home.x;
    homeY[i] = en.home.y;
    homeZ[i] = en.home.z;
    if (en.goal) {
      goalX[i] = en.goal.x;
      goalZ[i] = en.goal.z;
      hasGoal[i] = 1;
    } else {
      hasGoal[i] = 0;
    }
    searchT[i] = en.searchT;
    if (prepHasVia && i < prepN) {
      viaX[i] = prepViaX![i];
      viaZ[i] = prepViaZ![i];
      hasVia[i] = prepHasVia[i];
      skip[i] = prepSkip![i];
    } else {
      hasVia[i] = 0;
      skip[i] = 0;
    }
  }
  return { n, x, y, z, yaw, vx, vz, hp, shield, duck, id, kind, mode };
}

function syncSquads(e: Ex, s: State): void {
  const n = s.squads.length;
  e.ringfall_sim_squads_begin!(n);
  const since = f32(e, e.ringfall_sim_squad_since_seen_ptr!(), n);
  const shotT = f32(e, e.ringfall_sim_squad_shot_t_ptr!(), n);
  const lastX = f32(e, e.ringfall_sim_squad_last_x_ptr!(), n);
  const lastZ = f32(e, e.ringfall_sim_squad_last_z_ptr!(), n);
  const chaseX = f32(e, e.ringfall_sim_squad_chase_x_ptr!(), n);
  const chaseZ = f32(e, e.ringfall_sim_squad_chase_z_ptr!(), n);
  const hasChase = u8(e, e.ringfall_sim_squad_has_chase_ptr!(), n);
  const chaseT = f32(e, e.ringfall_sim_squad_chase_t_ptr!(), n);
  const pinT = f32(e, e.ringfall_sim_squad_pin_t_ptr!(), n);
  const sight = f32(e, e.ringfall_sim_squad_sight_ptr!(), n);
  const flags = u8(e, e.ringfall_sim_squad_flags_ptr!(), n);
  for (let i = 0; i < n; i++) {
    const sq = s.squads[i];
    since[i] = sq.sinceSeen;
    shotT[i] = sq.shotT ?? 0;
    lastX[i] = sq.last.x;
    lastZ[i] = sq.last.z;
    if (sq.chase) {
      chaseX[i] = sq.chase.x;
      chaseZ[i] = sq.chase.z;
      hasChase[i] = 1;
    } else {
      hasChase[i] = 0;
    }
    chaseT[i] = sq.chaseT ?? 0;
    pinT[i] = sq.pinT ?? 0;
    sight[i] = sq.sight ?? 0;
    let f = 0;
    if (sq.engaged) f |= SQUAD_ENGAGED;
    if (sq.mobile) f |= SQUAD_MOBILE;
    if (sq.retreat !== undefined) f |= SQUAD_RETREAT;
    if (sq.pack) f |= SQUAD_PACK;
    if (sq.routed) f |= SQUAD_ROUTED;
    flags[i] = f;
  }
}

function syncOrbs(e: Ex, s: State): void {
  const n = s.orbs.length;
  e.ringfall_sim_orbs_begin!(n);
  const x = f32(e, e.ringfall_sim_orb_x_ptr!(), n);
  const y = f32(e, e.ringfall_sim_orb_y_ptr!(), n);
  const z = f32(e, e.ringfall_sim_orb_z_ptr!(), n);
  const vx = f32(e, e.ringfall_sim_orb_vx_ptr!(), n);
  const vy = f32(e, e.ringfall_sim_orb_vy_ptr!(), n);
  const vz = f32(e, e.ringfall_sim_orb_vz_ptr!(), n);
  const r = f32(e, e.ringfall_sim_orb_r_ptr!(), n);
  const dmg = f32(e, e.ringfall_sim_orb_dmg_ptr!(), n);
  const life = f32(e, e.ringfall_sim_orb_life_ptr!(), n);
  const flags = u8(e, e.ringfall_sim_orb_flags_ptr!(), n);
  const by = i32(e, e.ringfall_sim_orb_by_ptr!(), n);
  const side = u8(e, e.ringfall_sim_orb_side_ptr!(), n);
  for (let i = 0; i < n; i++) {
    const o = s.orbs[i];
    x[i] = o.pos.x;
    y[i] = o.pos.y;
    z[i] = o.pos.z;
    vx[i] = o.vel.x;
    vy[i] = o.vel.y;
    vz[i] = o.vel.z;
    r[i] = o.r;
    dmg[i] = o.dmg;
    life[i] = o.life;
    let f = 0;
    if (o.homing) f |= ORB_HOMING;
    if (o.friend) f |= ORB_FRIEND;
    if (o.by !== undefined) f |= ORB_HAS_BY;
    flags[i] = f;
    by[i] = o.by ?? -1;
    side[i] = o.friend ? 0 : o.rival ? 3 : o.rogue ? 2 : 1;
  }
}

function applyHits(e: Ex, s: State): void {
  const n = e.ringfall_sim_hits_len!();
  if (!n) return;
  const ptr = e.ringfall_sim_hits_ptr!();
  const bytes = new DataView(mem(e).buffer, ptr, n * 24);
  for (let i = 0; i < n; i++) {
    const o = i * 24;
    const kind = bytes.getUint8(o + 4);
    const targetId = bytes.getInt32(o + 8, true);
    const dmg = bytes.getFloat32(o + 12, true);
    const fromX = bytes.getFloat32(o + 16, true);
    const fromZ = bytes.getFloat32(o + 20, true);
    if (kind === 0) hurtPlayer(s, dmg, fromX, fromZ);
    else if (kind === 1) hurtAlly(s, dmg);
    else if (kind === 2) {
      const v = s.enemies.find((en) => en.id === targetId) ?? s.friends.find((en) => en.id === targetId);
      if (v) damageRobot(s, v, dmg, null);
    }
  }
}

function pullRobots(e: Ex, s: State): void {
  const list = s.friends.length ? [...s.enemies, ...s.friends] : s.enemies;
  const n = Math.min(list.length, e.ringfall_sim_n_robots?.() ?? 0);
  if (!n) return;
  const x = f32(e, e.ringfall_sim_robot_x_ptr!(), n);
  const y = f32(e, e.ringfall_sim_robot_y_ptr!(), n);
  const z = f32(e, e.ringfall_sim_robot_z_ptr!(), n);
  const yaw = f32(e, e.ringfall_sim_robot_yaw_ptr!(), n);
  const vx = f32(e, e.ringfall_sim_robot_vx_ptr!(), n);
  const vy = f32(e, e.ringfall_sim_robot_vy_ptr!(), n);
  const vz = f32(e, e.ringfall_sim_robot_vz_ptr!(), n);
  const duck = f32(e, e.ringfall_sim_robot_duck_ptr!(), n);
  const mode = u8(e, e.ringfall_sim_robot_mode_ptr!(), n);
  const aware = u8(e, e.ringfall_sim_robot_aware_ptr!(), n);
  const detect = f32(e, e.ringfall_sim_robot_detect_ptr!(), n);
  const finding = f32(e, e.ringfall_sim_robot_finding_ptr!(), n);
  const blind = f32(e, e.ringfall_sim_robot_blind_ptr!(), n);
  const sawX = f32(e, e.ringfall_sim_robot_saw_x_ptr!(), n);
  const sawZ = f32(e, e.ringfall_sim_robot_saw_z_ptr!(), n);
  const hasSaw = u8(e, e.ringfall_sim_robot_has_saw_ptr!(), n);
  const timer = f32(e, e.ringfall_sim_robot_timer_ptr!(), n);
  const cooldown = f32(e, e.ringfall_sim_robot_cooldown_ptr!(), n);
  const shotsLeft = i32(e, e.ringfall_sim_robot_shots_left_ptr!(), n);
  const strafe = f32(e, e.ringfall_sim_robot_strafe_ptr!(), n);
  const strafeT = f32(e, e.ringfall_sim_robot_strafe_t_ptr!(), n);
  const jink = f32(e, e.ringfall_sim_robot_jink_ptr!(), n);
  const steady = f32(e, e.ringfall_sim_robot_steady_ptr!(), n);
  const stagger = f32(e, e.ringfall_sim_robot_stagger_ptr!(), n);
  const aimYaw = f32(e, e.ringfall_sim_robot_aim_yaw_ptr!(), n);
  const aimPitch = f32(e, e.ringfall_sim_robot_aim_pitch_ptr!(), n);
  const opener = u8(e, e.ringfall_sim_robot_opener_ptr!(), n);
  const peekSide = f32(e, e.ringfall_sim_robot_peek_side_ptr!(), n);
  const coverT = f32(e, e.ringfall_sim_robot_cover_t_ptr!(), n);
  const target = u8(e, e.ringfall_sim_robot_target_ptr!(), n);
  const targetT = f32(e, e.ringfall_sim_robot_target_t_ptr!(), n);
  const friendId = i32(e, e.ringfall_sim_robot_friend_id_ptr!(), n);
  const lastHit = f32(e, e.ringfall_sim_robot_last_hit_ptr!(), n);
  const fired = f32(e, e.ringfall_sim_robot_fired_ptr!(), n);
  const allyHit = f32(e, e.ringfall_sim_robot_ally_hit_ptr!(), n);
  const goalX = f32(e, e.ringfall_sim_robot_goal_x_ptr!(), n);
  const goalZ = f32(e, e.ringfall_sim_robot_goal_z_ptr!(), n);
  const hasGoal = u8(e, e.ringfall_sim_robot_has_goal_ptr!(), n);
  const searchT = f32(e, e.ringfall_sim_robot_search_t_ptr!(), n);
  for (let i = 0; i < n; i++) {
    const en = list[i];
    if (en.friend) continue; // friends stepped in TS
    en.pos.x = x[i];
    en.pos.y = y[i];
    en.pos.z = z[i];
    en.yaw = yaw[i];
    en.vel.x = vx[i];
    en.vel.y = vy[i];
    en.vel.z = vz[i];
    en.duck = duck[i];
    const m = MODE_S[mode[i]] ?? "move";
    if (m !== "idle" && m !== "alert" && m !== "dead") en.mode = m as Enemy["mode"];
    en.aware = AWARE_S[aware[i]] ?? en.aware;
    en.detect = detect[i];
    en.finding = finding[i];
    en.blind = blind[i];
    en.sawAt = hasSaw[i] ? { x: sawX[i], z: sawZ[i] } : null;
    en.timer = timer[i];
    en.cooldown = cooldown[i];
    en.shotsLeft = shotsLeft[i];
    en.strafe = strafe[i] < 0 ? -1 : 1;
    en.strafeT = strafeT[i];
    en.jink = jink[i];
    en.steady = steady[i];
    en.stagger = stagger[i];
    en.aimYaw = aimYaw[i];
    en.aimPitch = aimPitch[i];
    en.opener = opener[i] !== 0;
    en.peekSide = peekSide[i] < 0 ? -1 : 1;
    en.coverT = coverT[i];
    en.target = TARGET_S[target[i]] ?? "player";
    en.targetT = targetT[i];
    if (friendId[i] >= 0) en.friendId = friendId[i];
    en.lastHit = lastHit[i];
    en.fired = fired[i];
    en.allyHit = allyHit[i];
    en.goal = hasGoal[i] ? { x: goalX[i], z: goalZ[i] } : null;
    en.searchT = searchT[i];
  }
}

function pullSquads(e: Ex, s: State, wasEngaged: boolean[]): void {
  const n = s.squads.length;
  if (!n) return;
  const since = f32(e, e.ringfall_sim_squad_since_seen_ptr!(), n);
  const shotT = f32(e, e.ringfall_sim_squad_shot_t_ptr!(), n);
  const lastX = f32(e, e.ringfall_sim_squad_last_x_ptr!(), n);
  const lastZ = f32(e, e.ringfall_sim_squad_last_z_ptr!(), n);
  const chaseX = f32(e, e.ringfall_sim_squad_chase_x_ptr!(), n);
  const chaseZ = f32(e, e.ringfall_sim_squad_chase_z_ptr!(), n);
  const hasChase = u8(e, e.ringfall_sim_squad_has_chase_ptr!(), n);
  const chaseT = f32(e, e.ringfall_sim_squad_chase_t_ptr!(), n);
  const pinT = f32(e, e.ringfall_sim_squad_pin_t_ptr!(), n);
  const flags = u8(e, e.ringfall_sim_squad_flags_ptr!(), n);
  for (let i = 0; i < n; i++) {
    const sq = s.squads[i];
    sq.sinceSeen = since[i];
    sq.shotT = shotT[i] || undefined;
    sq.last = { x: lastX[i], z: lastZ[i] };
    sq.chase = hasChase[i] ? { x: chaseX[i], z: chaseZ[i] } : undefined;
    sq.chaseT = chaseT[i] || undefined;
    sq.pinT = pinT[i] || undefined;
    const now = (flags[i] & SQUAD_ENGAGED) !== 0;
    // Mirror engageSquad's event so met / firstMeet count WASM engages.
    if (!wasEngaged[i] && now) {
      let id = -1;
      for (const en of s.enemies) {
        if (en.squad !== i) continue;
        if (en.aware === "engaged") {
          id = en.id;
          break;
        }
        if (id < 0) id = en.id;
      }
      s.events.push({ t: "engage", squad: i, id });
    }
    sq.engaged = now;
  }
}

function pullOrbs(e: Ex, s: State): void {
  const nWasm = e.ringfall_sim_n_orbs?.() ?? s.orbs.length;
  const alive = u8(e, e.ringfall_sim_orb_alive_ptr!(), nWasm);
  const x = f32(e, e.ringfall_sim_orb_x_ptr!(), nWasm);
  const y = f32(e, e.ringfall_sim_orb_y_ptr!(), nWasm);
  const z = f32(e, e.ringfall_sim_orb_z_ptr!(), nWasm);
  const vx = f32(e, e.ringfall_sim_orb_vx_ptr!(), nWasm);
  const vy = f32(e, e.ringfall_sim_orb_vy_ptr!(), nWasm);
  const vz = f32(e, e.ringfall_sim_orb_vz_ptr!(), nWasm);
  const r = f32(e, e.ringfall_sim_orb_r_ptr!(), nWasm);
  const dmg = f32(e, e.ringfall_sim_orb_dmg_ptr!(), nWasm);
  const life = f32(e, e.ringfall_sim_orb_life_ptr!(), nWasm);
  const flags = u8(e, e.ringfall_sim_orb_flags_ptr!(), nWasm);
  const by = i32(e, e.ringfall_sim_orb_by_ptr!(), nWasm);
  const side = u8(e, e.ringfall_sim_orb_side_ptr!(), nWasm);
  const kept: Orb[] = [];
  const prev = s.orbs;
  for (let i = 0; i < nWasm; i++) {
    if (!alive[i]) continue;
    if (i < prev.length) {
      const o = prev[i];
      o.pos.x = x[i];
      o.pos.y = y[i];
      o.pos.z = z[i];
      o.vel.x = vx[i];
      o.vel.y = vy[i];
      o.vel.z = vz[i];
      o.life = life[i];
      kept.push(o);
    } else {
      // Spawned in WASM this tick.
      const o: Orb = {
        id: s.nextId++,
        pos: { x: x[i], y: y[i], z: z[i] },
        vel: { x: vx[i], y: vy[i], z: vz[i] },
        r: r[i],
        dmg: dmg[i],
        life: life[i],
        homing: (flags[i] & ORB_HOMING) !== 0,
        friend: (flags[i] & ORB_FRIEND) !== 0 || undefined,
        by: (flags[i] & ORB_HAS_BY) !== 0 ? by[i] : undefined,
        rogue: side[i] === 2 || undefined,
        rival: side[i] === 3 || undefined,
      };
      kept.push(o);
    }
  }
  s.orbs = kept;
}

export function tickMode(): "off" | "wasm" | "check" {
  if (TICK_CHECK) return "check";
  if (TICK_WASM) return "wasm";
  return "off";
}

export function tickAvailable(): boolean {
  return !!ex() && geomEpoch >= 0;
}

/** Set when `stepTick` succeeded this sim tick — `stepOrbsMaybe` skips TypeScript orbs. */
let tickDone = false;
export function markTickDone(): void {
  tickDone = true;
}
export function consumeTickDone(): boolean {
  const v = tickDone;
  tickDone = false;
  return v;
}

/**
 * Full WASM tick: sync robots+squads+orbs → step_tick (enemies then orbs) → pull + hits.
 * Returns true when WASM ran (TS should skip stepEnemies combat and stepOrbs).
 */
export function stepTick(s: State): boolean {
  if (!TICK_WASM) return false;
  const e = ex();
  if (!e || geomEpoch < 0) return false;
  const wasEngaged = s.squads.map((sq) => !!sq.engaged);
  syncRobots(s);
  syncSquads(e, s);
  syncOrbs(e, s);
  const p = s.player;
  e.ringfall_sim_set_player!(
    p.pos.x,
    p.pos.y,
    p.pos.z,
    p.crouch || p.sliding ? 1 : 0,
    p.sliding ? 1 : 0,
    s.ally.pos.x,
    s.ally.pos.y,
    s.ally.pos.z,
    allyUp(s) ? 1 : 0,
    s.stats.wipes,
  );
  e.ringfall_sim_set_combat!(
    p.vel.x,
    p.vel.y,
    p.vel.z,
    s.ally.vel.x,
    s.ally.vel.y,
    s.ally.vel.z,
    p.downed > 0 ? 1 : 0,
    s.phase === "play" ? 1 : 0,
    sightScale(s),
    threatOf(s).range,
    s.rng >>> 0,
    s.nextId >>> 0,
  );
  const rc = e.ringfall_step_tick(TICK);
  if (rc !== 0) return false;
  pullRobots(e, s);
  pullSquads(e, s, wasEngaged);
  applyHits(e, s);
  pullOrbs(e, s);
  if (e.ringfall_sim_get_rng) s.rng = e.ringfall_sim_get_rng() || 1;
  if (e.ringfall_sim_get_next_id) s.nextId = e.ringfall_sim_get_next_id();
  return true;
}

/** @deprecated alias — prefer `stepTick`. */
export function stepTickOrbs(s: State): boolean {
  return stepTick(s);
}

export function robotViews(): RobotViews | null {
  const e = ex();
  if (!e || !e.ringfall_sim_n_robots) return null;
  const n = e.ringfall_sim_n_robots();
  if (!n) return null;
  return {
    n,
    x: f32(e, e.ringfall_sim_robot_x_ptr!(), n),
    y: f32(e, e.ringfall_sim_robot_y_ptr!(), n),
    z: f32(e, e.ringfall_sim_robot_z_ptr!(), n),
    yaw: f32(e, e.ringfall_sim_robot_yaw_ptr!(), n),
    vx: f32(e, e.ringfall_sim_robot_vx_ptr!(), n),
    vz: f32(e, e.ringfall_sim_robot_vz_ptr!(), n),
    hp: f32(e, e.ringfall_sim_robot_hp_ptr!(), n),
    shield: f32(e, e.ringfall_sim_robot_shield_ptr!(), n),
    duck: f32(e, e.ringfall_sim_robot_duck_ptr!(), n),
    id: i32(e, e.ringfall_sim_robot_id_ptr!(), n),
    kind: u8(e, e.ringfall_sim_robot_kind_ptr!(), n),
    mode: u8(e, e.ringfall_sim_robot_mode_ptr!(), n),
  };
}

export function wasmLos(ax: number, ay: number, az: number, bx: number, by: number, bz: number, paths = false): boolean | null {
  const e = ex();
  if (!e || geomEpoch < 0 || !e.ringfall_sim_los) return null;
  return e.ringfall_sim_los(ax, ay, az, bx, by, bz, paths ? 1 : 0) !== 0;
}

export function tickStatus(): { tick: boolean; abi: number | null; geom: boolean; mode: string; orbs: boolean } {
  const e = ex();
  return {
    tick: !!e,
    abi: e ? e.ringfall_sim_abi_version() : null,
    geom: geomEpoch >= 0,
    mode: tickMode(),
    orbs: ORBS_WASM,
  };
}

// silence unused (KIND_S kept for debugging / future decode)
void KIND_S;
void THREAT;
