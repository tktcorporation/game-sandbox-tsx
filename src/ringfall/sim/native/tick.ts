/**
 * Coarse WASM tick host: enemy/orb SoA + world geom in linear memory, `step_tick` for orbs.
 * Shares the WASM Instance with fill.ts. Default keeps TypeScript `stepOrbs` / `stepEnemies`
 * (bench hash). Opt-in: `?ringfallTick=1` or `RINGFALL_TICK=1`. View reads robot SoA via
 * `syncRobots()` / `robotViews()`. See docs/ringfall/native.md.
 */
import { ENEMIES, TICK } from "../config";
import { BOXES, ROUTES } from "../map";
import { terrainFieldSnapshot } from "../terrain";
import type { Enemy, Orb, State } from "../state";
import { bodyY } from "../state";
import { robotSide } from "../battle";
import { allyUp, hurtAlly } from "../ally";
import { hurtPlayer } from "../player";
import { damageRobot } from "../factions";
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

type Ex = NonNullable<ReturnType<typeof nativeExports>>;

function ex(): Ex | null {
  const e = nativeExports();
  if (!e?.ringfall_sim_step_tick || e.ringfall_sim_abi_version() < 2) return null;
  return e;
}

function mem(e: Ex): WebAssembly.Memory {
  return e.memory;
}

function f32(e: Ex, ptr: number, n: number): Float32Array {
  return new Float32Array(mem(e).buffer, ptr, n);
}
function i32(e: Ex, ptr: number, n: number): Int32Array {
  return new Int32Array(mem(e).buffer, ptr, n);
}
function u8(e: Ex, ptr: number, n: number): Uint8Array {
  return new Uint8Array(mem(e).buffer, ptr, n);
}

let geomEpoch = -1;
let routesKey = "";

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

/** True when an opted-in tick needs geom in WASM (browser SoA is opt-in via TICK too). */
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
  const tPtr = e.ringfall_sim_terrain_begin!(snap.nx, snap.nz, snap.x0, snap.z0, snap.res);
  f32(e, tPtr, snap.field.length).set(snap.field);
  e.ringfall_sim_terrain_commit!();
  const boxes = packBoxes();
  const bPtr = e.ringfall_sim_boxes_begin!(boxes.length / 7);
  f32(e, bPtr, boxes.length).set(boxes);
  e.ringfall_sim_boxes_commit!();
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
};

function bodyHeight(en: Enemy): number {
  const k = ENEMIES[en.kind];
  return Math.max(0.2, bodyY(en) + k.radius);
}

/** Push enemies+friends into WASM SoA (view + orb hits). */
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
  for (let i = 0; i < n; i++) {
    const en = list[i];
    x[i] = en.pos.x;
    y[i] = en.pos.y;
    z[i] = en.pos.z;
    yaw[i] = en.yaw;
    vx[i] = en.vel.x;
    vz[i] = en.vel.z;
    hp[i] = en.hp;
    shield[i] = en.shield;
    duck[i] = en.duck;
    id[i] = en.id;
    kind[i] = KIND_I[en.kind] ?? 0;
    mode[i] = MODE_I[en.mode] ?? 0;
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
  }
  return { n, x, y, z, yaw, vx, vz, hp, shield, duck, id, kind, mode };
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

function pullOrbs(e: Ex, s: State): void {
  const n = s.orbs.length;
  const alive = u8(e, e.ringfall_sim_orb_alive_ptr!(), n);
  const x = f32(e, e.ringfall_sim_orb_x_ptr!(), n);
  const y = f32(e, e.ringfall_sim_orb_y_ptr!(), n);
  const z = f32(e, e.ringfall_sim_orb_z_ptr!(), n);
  const vx = f32(e, e.ringfall_sim_orb_vx_ptr!(), n);
  const vy = f32(e, e.ringfall_sim_orb_vy_ptr!(), n);
  const vz = f32(e, e.ringfall_sim_orb_vz_ptr!(), n);
  const life = f32(e, e.ringfall_sim_orb_life_ptr!(), n);
  const kept: Orb[] = [];
  for (let i = 0; i < n; i++) {
    if (!alive[i]) continue;
    const o = s.orbs[i];
    o.pos.x = x[i];
    o.pos.y = y[i];
    o.pos.z = z[i];
    o.vel.x = vx[i];
    o.vel.y = vy[i];
    o.vel.z = vz[i];
    o.life = life[i];
    kept.push(o);
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

/**
 * Tick-host entry from `step.ts`. Syncs robot SoA when `RINGFALL_TICK` is on.
 * Returns true only when WASM also stepped orbs (`RINGFALL_ORBS=1`).
 */
export function stepTickOrbs(s: State): boolean {
  if (!TICK_WASM) return false;
  const e = ex();
  if (!e || geomEpoch < 0) return false;
  syncRobots(s);
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
  // stepEnemies / sense / combat still TypeScript. Orbs stay TS unless RINGFALL_ORBS=1
  // (WASM los drifts ~1 ULP/tick and changes the bench hash).
  if (!ORBS_WASM) return false;
  syncOrbs(e, s);
  const rc = e.ringfall_step_tick(TICK);
  if (rc !== 0) return false;
  applyHits(e, s);
  pullOrbs(e, s);
  return true;
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
