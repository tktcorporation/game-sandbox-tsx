import { ASSIST, DEG, ENEMIES, FLANK, NOISE, PLAYER, RARITY, TICK, ULT, WEAPONS, type Flank, type WeaponSpec } from "./config";
import { engageSquad, makeNoise } from "./awareness";
import { POIS } from "./map";
import { los, lookAngles, norm, rayWorld, raySphere, wrapAngle } from "./geom";
import { forward, rand, type Enemy, type State, type Vec3, type Weapon } from "./state";

/*
 * Everything about the player's shots landing on robots: hit boxes, aim assist,
 * damage through shields, kills and their drops.
 */

export const bodyCenter = (e: Enemy): Vec3 => ({ x: e.pos.x, y: e.pos.y + ENEMIES[e.kind].bodyY, z: e.pos.z });

export function weakPoint(e: Enemy): Vec3 {
  const k = ENEMIES[e.kind];
  return { x: e.pos.x + Math.sin(e.yaw) * k.weakFwd, y: e.pos.y + k.weakY, z: e.pos.z - Math.cos(e.yaw) * k.weakFwd };
}

export const eyePos = (s: State): Vec3 => {
  const p = s.player;
  return { x: p.pos.x, y: p.pos.y + (p.crouch || p.sliding || p.downed > 0 ? PLAYER.eyeCrouch : PLAYER.eye), z: p.pos.z };
};

export const magSize = (w: Weapon) => Math.round(WEAPONS[w.kind].mag * RARITY.mag[w.rarity]);

/** Assist cone half-angle (radians) for the current ADS and overdrive state at a distance. */
function coneAt(s: State, dist: number, pelletScale: number): number {
  const p = s.player;
  const base = p.ultTime > 0 ? ASSIST.ultCone : ASSIST.hipCone + (ASSIST.adsCone - ASSIST.hipCone) * p.ads;
  return base * DEG * pelletScale + Math.atan(ASSIST.farPadding / Math.max(dist, 1));
}

const targetable = (e: Enemy) => e.mode !== "spawning";

/**
 * The enemy the crosshair is "on" for look slowdown and pull: smallest angle to
 * its body within `cone`, in range and in sight.
 */
export function assistTarget(s: State, coneDeg: number): { e: Enemy; angle: number } | null {
  const p = s.player;
  const eye = eyePos(s);
  const dir = forward(p.yaw, p.pitch);
  let best: { e: Enemy; angle: number } | null = null;
  for (const e of s.enemies) {
    if (!targetable(e)) continue;
    const c = bodyCenter(e);
    const v = { x: c.x - eye.x, y: c.y - eye.y, z: c.z - eye.z };
    const d = Math.hypot(v.x, v.y, v.z);
    if (d > ASSIST.range) continue;
    const ang = Math.acos(Math.max(-1, Math.min(1, (v.x * dir.x + v.y * dir.y + v.z * dir.z) / d)));
    const pad = Math.atan(ENEMIES[e.kind].radius / Math.max(d, 1));
    if (ang - pad > coneDeg * DEG) continue;
    const rank = assistRank(e, ang);
    if (best && rank >= best.angle) continue;
    if (!los(eye, c)) continue;
    best = { e, angle: rank };
  }
  return best;
}

/**
 * Sort key for aim assist: the angle off the crosshair, with robots that have not
 * noticed the player ranked after every one that has. A near miss in a fight then
 * lands on the fight, not on a sleeping squad behind it (a direct hit still does).
 */
const assistRank = (e: Enemy, angle: number) => (e.aware === "idle" ? angle + 10 : angle);

/** Turn the player's view toward the assist target by a fraction of the remaining angle. */
export function applyPull(s: State, moving: boolean, firing: boolean, touch = false) {
  const p = s.player;
  const strong = p.ultTime > 0;
  const engaged = firing || p.ads > 0.5;
  if (!strong && !(engaged && (moving || touch))) return;
  const t = assistTarget(s, ASSIST.pullCone * (strong ? 1.6 : 1));
  if (!t) return;
  const want = lookAngles(eyePos(s), bodyCenter(t.e));
  const k = Math.min(1, (strong ? ASSIST.ultPull : ASSIST.pull * (touch ? ASSIST.touchPull : 1)) * TICK);
  p.yaw += wrapAngle(want.yaw - p.yaw) * k;
  p.pitch += (want.pitch - p.pitch) * k;
}

function falloff(spec: WeaponSpec, d: number): number {
  if (d <= spec.falloffStart) return 1;
  if (d >= spec.falloffEnd) return spec.falloffMin;
  return 1 - ((d - spec.falloffStart) / (spec.falloffEnd - spec.falloffStart)) * (1 - spec.falloffMin);
}

/** One hitscan ray (one pellet). */
export function fireRay(s: State, w: Weapon, dir: Vec3) {
  const spec = WEAPONS[w.kind];
  const eye = eyePos(s);
  const wallT = rayWorld(eye, dir, 140);
  let raw: { e: Enemy; t: number; crit: boolean } | null = null;
  let assisted: { e: Enemy; t: number; angle: number } | null = null;
  const pelletScale = spec.pellets > 1 ? 0.6 : 1;
  for (const e of s.enemies) {
    if (!targetable(e)) continue;
    const k = ENEMIES[e.kind];
    const c = bodyCenter(e);
    const tw = raySphere(eye, dir, weakPoint(e), k.weakR);
    const tb = raySphere(eye, dir, c, k.radius);
    if (tw < wallT && (!raw || tw < raw.t)) raw = { e, t: tw, crit: true };
    else if (tb < wallT && (!raw || tb < raw.t)) raw = { e, t: tb, crit: false };
    if (raw) continue;
    const v = { x: c.x - eye.x, y: c.y - eye.y, z: c.z - eye.z };
    const d = Math.hypot(v.x, v.y, v.z);
    if (d > ASSIST.range) continue;
    const ang = Math.acos(Math.max(-1, Math.min(1, (v.x * dir.x + v.y * dir.y + v.z * dir.z) / d)));
    if (ang > coneAt(s, d, pelletScale) + Math.atan(k.radius / Math.max(d, 1))) continue;
    const rank = assistRank(e, ang);
    if (assisted && rank >= assisted.angle) continue;
    if (!los(eye, c)) continue;
    assisted = { e, t: d - k.radius * 0.5, angle: rank };
  }
  const hit = raw ?? (assisted ? { e: assisted.e, t: assisted.t, crit: false } : null);
  const muzzle = { x: eye.x, y: eye.y - 0.15, z: eye.z };
  if (!hit) {
    const end = { x: eye.x + dir.x * wallT, y: eye.y + dir.y * wallT, z: eye.z + dir.z * wallT };
    s.events.push({ t: "tracer", from: muzzle, to: end, hit: false });
    if (wallT < 140) s.events.push({ t: "impact", pos: end });
    return;
  }
  const c = raw ? { x: eye.x + dir.x * hit.t, y: eye.y + dir.y * hit.t, z: eye.z + dir.z * hit.t } : hit.crit ? weakPoint(hit.e) : bodyCenter(hit.e);
  s.events.push({ t: "tracer", from: muzzle, to: c, hit: true });
  const dmg = spec.dmg * RARITY.dmg[w.rarity] * falloff(spec, hit.t) * (hit.crit ? spec.crit : 1);
  s.stats.hits++;
  if (hit.crit) s.stats.crits++;
  damageEnemy(s, hit.e, dmg, hit.crit, c);
}

/** Fire the active weapon once: spread, pellets, recoil. */
export function shoot(s: State, w: Weapon) {
  const p = s.player;
  const spec = WEAPONS[w.kind];
  const spread = (spec.hipSpread + (spec.adsSpread - spec.hipSpread) * p.ads) * (p.ultTime > 0 ? 0.5 : 1);
  const aimPitch = p.pitch + p.recoil * DEG;
  for (let i = 0; i < spec.pellets; i++) {
    const a = rand(s) * Math.PI * 2;
    const r = Math.sqrt(rand(s)) * spread * DEG;
    s.stats.shots++;
    fireRay(s, w, norm(forward(p.yaw + Math.cos(a) * r, aimPitch + Math.sin(a) * r)));
  }
  p.recoil += spec.recoil * (1 - 0.5 * p.ads);
  s.events.push({ t: "shot", weapon: w.kind, rarity: w.rarity });
  makeNoise(s, p.pos.x, p.pos.z, NOISE[w.kind]);
}

/** Which way a shot from the player meets this robot (see FLANK). */
export function flankOf(s: State, e: Enemy): Flank {
  if (e.kind === "titan") return "none";
  if (e.aware !== "engaged") return "ambush";
  const off = Math.abs(wrapAngle(lookAngles(e.pos, s.player.pos).yaw - e.yaw)) / DEG;
  return off < FLANK.frontArc ? "front" : off > FLANK.backArc ? "back" : "side";
}

export function damageEnemy(s: State, e: Enemy, raw: number, crit: boolean, at: Vec3) {
  // Callers may hold a list taken before a kill removed this robot (the titan takes its summons with it).
  if (!s.enemies.includes(e)) return;
  const k = ENEMIES[e.kind];
  const flank = flankOf(s, e);
  raw *= FLANK.mult[flank];
  if (flank === "back" || flank === "ambush") s.stats.flankHits++;
  // Being shot gives the player away to the whole squad.
  engageSquad(s, e.squad, e);
  const before = e.hp + e.shield;
  const hadShield = e.shield > 0;
  const toShield = Math.min(e.shield, raw);
  e.shield -= toShield;
  e.hp -= raw - toShield;
  const dealt = before - Math.max(0, e.hp) - e.shield;
  e.lastHit = 0;
  s.stats.damage += dealt;
  s.events.push({ t: "hit", id: e.id, pos: at, dmg: Math.round(raw), crit, shield: toShield > 0, tier: k.shieldTier, flank });
  if (hadShield && e.shield <= 0) s.events.push({ t: "shieldBreak", id: e.id, pos: at, tier: k.shieldTier });
  const p = s.player;
  if (p.ultTime <= 0 && p.ult < 1) {
    p.ult = Math.min(1, p.ult + (dealt / ULT.dmgPerCharge) * k.ult);
    if (p.ult >= 1) s.events.push({ t: "ultReady" });
  }
  if (e.hp <= 0) kill(s, e, crit);
}

const SHARDS = { drone: 1, grunt: 1, charger: 1, heavy: 3, titan: 0 } as const;

export function kill(s: State, e: Enemy, crit: boolean) {
  s.enemies = s.enemies.filter((o) => o !== e);
  s.stats.kills++;
  const p = s.player;
  const w = p.weapons[p.slot];
  if (w && w.rarity === 3) w.mag = magSize(w);
  const c = bodyCenter(e);
  for (let i = 0; i < SHARDS[e.kind]; i++) {
    const a = rand(s) * Math.PI * 2;
    s.loot.push({ id: s.nextId++, kind: "shard", rarity: 1, pos: { ...c }, vel: { x: Math.cos(a) * 2.5, y: 4, z: Math.sin(a) * 2.5 }, age: 0 });
  }
  if (e.kind !== "titan" && rand(s) < 0.12) {
    s.loot.push({ id: s.nextId++, kind: "battery", rarity: 1, pos: { ...c }, vel: { x: 0, y: 5, z: 0 }, age: 0 });
  }
  const last = e.poi === s.poi && s.poi < POIS.length && !s.enemies.some((o) => o.poi === s.poi);
  s.events.push({ t: "kill", id: e.id, kind: e.kind, pos: c, crit, last });
  if (e.kind === "titan") {
    // The titan's fall takes its summons and everything in the air with it.
    s.orbs = [];
    s.waves = [];
    for (const o of [...s.enemies]) if (o.poi === e.poi) kill(s, o, false);
  }
}
