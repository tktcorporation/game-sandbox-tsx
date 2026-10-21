import { MODS, ALLY, ASSIST, DEG, DODGE, ELITE, ENEMIES, FLANK, KICK_PATTERN, KICK_RESET, NOISE, PLATE, PLAYER, RARITY, RELAY, RETURN, ROBOT_DROPS, STAGGER, TICK, ULT, VALUABLES, WEAPONS, type Flank, type Rarity, type ValuableKind, type WeaponSpec } from "./config";
import { dropRobotMod, hasMod, modScale } from "./mods";
import { engageSquad, learnSpot, located, makeNoise, shotFromAfar } from "./awareness";
import { POIS } from "./map";
import { los, lookAngles, norm, rayWorld, raySphere, wrapAngle } from "./geom";
import { bodyY, forward, rand, squadKey, weakY, type Enemy, type RelayMast, type SquadState, type State, type Vec3, type Weapon } from "./state";

/*
 * Everything about the player's shots landing on robots: hit boxes, aim assist,
 * damage through shields, kills and their drops.
 */

export const bodyCenter = (e: Enemy): Vec3 => ({ x: e.pos.x, y: e.pos.y + bodyY(e), z: e.pos.z });

export function weakPoint(e: Enemy): Vec3 {
  const k = ENEMIES[e.kind];
  return { x: e.pos.x + Math.sin(e.yaw) * k.weakFwd, y: e.pos.y + weakY(e), z: e.pos.z - Math.cos(e.yaw) * k.weakFwd };
}

export const eyePos = (s: State): Vec3 => {
  const p = s.player;
  return { x: p.pos.x, y: p.pos.y + (p.crouch || p.sliding || p.downed > 0 ? PLAYER.eyeCrouch : PLAYER.eye), z: p.pos.z };
};

export const magSize = (w: Weapon) => Math.round(WEAPONS[w.kind].mag * RARITY.mag[w.rarity]);

/** Assist cone half-angle (radians) for the current ADS state at a distance. */
function coneAt(s: State, dist: number, pelletScale: number, touch: boolean): number {
  const p = s.player;
  const base = (ASSIST.hipCone + (ASSIST.adsCone - ASSIST.hipCone) * p.ads) * (touch ? ASSIST.touchCone : 1);
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

/**
 * Turn the player's view toward the assist target by a fraction of the remaining angle:
 * while aiming down sights (moving or not), and on touch also while firing from the hip.
 */
export function applyPull(s: State, firing: boolean, touch = false) {
  const p = s.player;
  if (!(p.ads > 0.5 || (touch && firing))) return;
  const t = assistTarget(s, ASSIST.pullCone);
  if (!t) return;
  const want = lookAngles(eyePos(s), bodyCenter(t.e));
  const k = Math.min(1, ASSIST.pull * modScale(s.player, "lock") * (touch ? ASSIST.touchPull : 1) * TICK);
  p.yaw += wrapAngle(want.yaw - p.yaw) * k;
  p.pitch += (want.pitch - p.pitch) * k;
}

/** A relay mast's eye, at the top of its post. */
export const mastEye = (m: RelayMast): Vec3 => ({ x: m.x, y: m.y + RELAY.height + RELAY.eyeR * 0.6, z: m.z });

/**
 * Where a ray from `eye` along `dir` first meets a standing relay mast nearer than `limit`:
 * its post (a vertical cylinder up to `RELAY.top` under its eye) or its eye (a sphere on top), or null.
 */
export function rayRelay(s: State, eye: Vec3, dir: Vec3, limit: number): { m: RelayMast; t: number; eye: boolean } | null {
  let best: { m: RelayMast; t: number; eye: boolean } | null = null;
  for (const m of s.relays) {
    if (m.hp <= 0) continue;
    const te = raySphere(eye, dir, mastEye(m), RELAY.eyeR);
    if (te < limit && (!best || te < best.t)) best = { m, t: te, eye: true };
    // The post: the ray's ground track against the circle, then the height where it meets it.
    const ox = eye.x - m.x;
    const oz = eye.z - m.z;
    const a = dir.x * dir.x + dir.z * dir.z;
    if (a < 1e-9) continue;
    const b = ox * dir.x + oz * dir.z;
    const c = ox * ox + oz * oz - RELAY.radius * RELAY.radius;
    const disc = b * b - a * c;
    if (disc < 0) continue;
    const t = (-b - Math.sqrt(disc)) / a;
    const y = eye.y + dir.y * t;
    // The lattice narrows to the housing under the eye: a shot that high goes past it or meets the eye.
    if (t > 0 && t < limit && y >= m.y && y <= m.y + RELAY.height - RELAY.top && (!best || t < best.t)) best = { m, t, eye: false };
  }
  return best;
}

/** A weapon's hit on a relay mast: it loses health, and falls at none (counted for the night's network). */
function damageRelay(s: State, m: RelayMast, dmg: number, eye: boolean, at: Vec3) {
  m.hp = Math.max(0, m.hp - dmg);
  // A hit on a mast counts toward accuracy like one on a robot; its eye is its weak point.
  s.stats.hits++;
  if (eye) s.stats.crits++;
  s.events.push({ t: "relayHit", id: m.id, pos: at, dmg: Math.round(dmg), eye });
  if (m.hp > 0) return;
  s.stats.relays.push(m.id);
  s.events.push({ t: "relayDown", id: m.id, pos: mastEye(m) });
}

function falloff(spec: WeaponSpec, d: number): number {
  if (d <= spec.falloffStart) return 1;
  if (d >= spec.falloffEnd) return spec.falloffMin;
  return 1 - ((d - spec.falloffStart) / (spec.falloffEnd - spec.falloffStart)) * (1 - spec.falloffMin);
}

/** One hitscan ray (one pellet). `touch`: the shot came from a touch screen (a wider assist cone). */
export function fireRay(s: State, w: Weapon, dir: Vec3, touch = false) {
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
    // The nearer of the two: a weak point on the far side of the body is behind armour.
    if (tw < wallT && tw <= tb && (!raw || tw < raw.t)) raw = { e, t: tw, crit: true };
    else if (tb < wallT && (!raw || tb < raw.t)) raw = { e, t: tb, crit: false };
    if (raw) continue;
    const v = { x: c.x - eye.x, y: c.y - eye.y, z: c.z - eye.z };
    const d = Math.hypot(v.x, v.y, v.z);
    if (d > ASSIST.range) continue;
    const ang = Math.acos(Math.max(-1, Math.min(1, (v.x * dir.x + v.y * dir.y + v.z * dir.z) / d)));
    if (ang > coneAt(s, d, pelletScale, touch) + Math.atan(k.radius / Math.max(d, 1))) continue;
    const rank = assistRank(e, ang);
    if (assisted && rank >= assisted.angle) continue;
    if (!los(eye, c)) continue;
    assisted = { e, t: d - k.radius * 0.5, angle: rank };
  }
  const muzzle = { x: eye.x, y: eye.y - 0.15, z: eye.z };
  // A relay mast in front of the robot the shot goes to takes it (no aim assist leads onto one):
  // the robot on the line, else the one aim assist chose.
  const mast = s.relays.length ? rayRelay(s, eye, dir, Math.min(wallT, raw?.t ?? assisted?.t ?? Infinity)) : null;
  if (mast) {
    const at = { x: eye.x + dir.x * mast.t, y: eye.y + dir.y * mast.t, z: eye.z + dir.z * mast.t };
    s.events.push({ t: "tracer", from: muzzle, to: at, hit: true });
    damageRelay(s, mast.m, spec.dmg * RARITY.dmg[w.rarity] * falloff(spec, mast.t) * (mast.eye ? RELAY.eyeMult : 1), mast.eye, at);
    return;
  }
  const hit = raw ?? (assisted ? { e: assisted.e, t: assisted.t, crit: false } : null);
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
  // Facing matters for weapon hits only; counted here so flank hits stay a share of `hits`.
  const flank = flankOf(s, hit.e);
  if (flank === "back" || flank === "ambush") s.stats.flankHits++;
  if (hit.e.kind === "titan") s.stats.titanHits++;
  damageEnemy(s, hit.e, dmg, hit.crit, c, flank, "player", w.rarity);
  // The leech gives shield back for every weak-point hit.
  const p = s.player;
  if (hit.crit && hasMod(p, "leech")) p.shield = Math.min(PLAYER.shieldByTier[p.armor], p.shield + MODS.leech.value);
}

/** Fire the active weapon once: spread, pellets, recoil. */
export function shoot(s: State, w: Weapon, touch = false) {
  const p = s.player;
  const spec = WEAPONS[w.kind];
  const spread = (spec.hipSpread + (spec.adsSpread - spec.hipSpread) * p.ads);
  const aimPitch = p.pitch + p.recoil * DEG;
  const aimYaw = p.yaw + p.recoilYaw * DEG;
  for (let i = 0; i < spec.pellets; i++) {
    const a = rand(s) * Math.PI * 2;
    const r = Math.sqrt(rand(s)) * spread * DEG;
    s.stats.shots++;
    fireRay(s, w, norm(forward(aimYaw + Math.cos(a) * r, aimPitch + Math.sin(a) * r)), touch);
  }
  const steady = (1 - 0.5 * p.ads) * modScale(p, "stock");
  p.recoil += spec.recoil * steady;
  if (s.time - p.lastShot > KICK_RESET) p.spray = 0;
  p.recoilYaw += spec.kick * KICK_PATTERN[p.spray % KICK_PATTERN.length] * steady;
  p.spray++;
  p.lastShot = s.time;
  s.events.push({ t: "shot", weapon: w.kind, rarity: w.rarity });
  makeNoise(s, p.pos.x, p.pos.z, NOISE[w.kind], true);
}

/**
 * Which way a shot meets this robot (see FLANK): from the player unless `from` is given
 * (the teammate's shots). The player's shot on a fighting robot that has not located
 * them itself is an ambush, like one on a robot that never noticed.
 */
export function flankOf(s: State, e: Enemy, from?: Vec3): Flank {
  if (e.kind === "titan") return "none";
  if (e.aware !== "engaged" || (!from && !located(s, e))) return "ambush";
  const off = offFacing(e, from ?? s.player.pos);
  return off < FLANK.frontArc ? "front" : off > FLANK.backArc ? "back" : "side";
}

/** Degrees between where a robot faces and the direction to `from`. */
const offFacing = (e: Enemy, from: Vec3) => Math.abs(wrapAngle(lookAngles(e.pos, from).yaw - e.yaw)) / DEG;

/**
 * `flank` is where a weapon shot met the robot (see flankOf); the arc and other
 * non-weapon damage pass "none" and deal their damage as it is. `by` is who fired:
 * the teammate's damage is counted apart and gives the player part of its ult charge.
 * `rarity` is the firing weapon's, which decides whether the robot's plate takes part
 * of a body hit (see PLATE); damage with none is not a weapon's and passes in full.
 */
export function damageEnemy(s: State, e: Enemy, raw: number, crit: boolean, at: Vec3, flank: Flank = "none", by: "player" | "ally" = "player", rarity?: Rarity) {
  // Callers may hold a list taken before a kill removed this robot (the titan takes its summons with it).
  if (!s.enemies.includes(e)) return;
  const k = ENEMIES[e.kind];
  raw *= flank === "ambush" && (e.kind === "heavy" || e.elite) ? FLANK.ambushTough : FLANK.mult[flank];
  // The back-shot part takes any hit from behind, an ambush on an unaware robot included.
  const behind = flank === "back" || (flank === "ambush" && e.kind !== "titan" && offFacing(e, s.player.pos) > FLANK.backArc);
  if (behind && by === "player") raw *= modScale(s.player, "stalker");
  const quiet = Math.min(e.lastHit, e.allyHit) > DODGE.jinkQuiet;
  const blocked = !crit && rarity !== undefined && e.plate > rarity;
  // A robot hit by the player knows where they are from now on.
  if (by === "player") {
    e.blind = 0;
    e.sawAt = { x: s.player.pos.x, z: s.player.pos.z };
  }
  // The piercer halves what the plate stops of the player's shot.
  if (blocked) raw *= by === "player" && hasMod(s.player, "piercer") ? 1 - (1 - PLATE.mult[e.plate - rarity]) * MODS.piercer.value : PLATE.mult[e.plate - rarity];
  // Being shot gives the player away to the whole squad. A squad already fighting
  // learns where the shot came from and turns there, at its usual turning speed.
  const shooter = by === "ally" ? s.ally.pos : s.player.pos;
  engageSquad(s, e.squad, e, by === "ally" ? shooter : undefined);
  const sq = s.squads[e.squad];
  // Only the player's own shot tells a squad where they are now (see PURSUE), and only the
  // player's shots from beyond the robot's sight are answered from afar (see RETURN).
  if (sq && by === "player") {
    learnSpot(s, e.squad, shooter.x, shooter.z);
    if (shotFromAfar(s, e)) sq.shotT = RETURN.time;
  }
  const before = e.hp + e.shield;
  const hadShield = e.shield > 0;
  const toShield = Math.min(e.shield, raw);
  e.shield -= toShield;
  e.hp -= raw - toShield;
  const dealt = before - Math.max(0, e.hp) - e.shield;
  if (by === "ally") {
    e.allyHit = 0;
    s.stats.allyDamage += dealt;
  } else {
    e.lastHit = 0;
    s.stats.damage += dealt;
  }
  s.events.push({ t: "hit", id: e.id, pos: at, dmg: Math.round(raw), crit, shield: toShield > 0, tier: k.shieldTier, flank, ally: by === "ally", blocked });
  const broke = hadShield && e.shield <= 0;
  if (broke) s.events.push({ t: "shieldBreak", id: e.id, pos: at, tier: k.shieldTier });
  if (e.hp > 0) react(s, e, dealt * (crit ? STAGGER.weak : 1) * (by === "player" ? modScale(s.player, "jolt") : 1), broke, quiet, shooter);
  const p = s.player;
  if (!p.leap && p.ult < 1) {
    p.ult = Math.min(1, p.ult + (dealt / ULT.dmgPerCharge) * k.ult * (by === "ally" ? ALLY.ultShare : 1) * modScale(p, "surge"));
    if (p.ult >= 1) s.events.push({ t: "ultReady" });
  }
  if (e.hp <= 0) kill(s, e, crit, by);
}

/**
 * How a robot that survives a hit reacts (see STAGGER and DODGE): the damage counts
 * toward a stagger, which knocks it back from the shooter and costs it the wind-up or
 * burst it was in; the first hit after a quiet spell makes a moving robot jink.
 * The titan and robots already stunned or beaming in do neither.
 */
function react(s: State, e: Enemy, weight: number, broke: boolean, quiet: boolean, from: Vec3) {
  if (e.kind === "titan" || e.mode === "spawning" || e.mode === "stunned") return;
  e.stagger += weight;
  const k = ENEMIES[e.kind];
  const full = (k.hp + k.shield) * (e.elite ? ELITE.hp : 1);
  const heavy = e.stagger >= STAGGER.share[e.kind] * full;
  const attacking = e.mode === "telegraph" || e.mode === "fire" || e.mode === "lunge";
  // A shield breaking under an attack already under way does not cost that attack: the
  // shield goes within a second of steady fire, and a robot that lost its first wind-up to
  // it would never shoot back at a player standing in front of it.
  if (e.mode !== "staggered" && e.steady <= 0 && (heavy || (broke && !attacking))) {
    const interrupted = attacking;
    // An attack under way or just spent still owes its cooldown: the stagger costs that attack, it never brings the next one sooner.
    if (interrupted || e.mode === "recover") e.cooldown = Math.max(e.cooldown, k.cooldown * 0.8 * (e.elite ? ELITE.cooldown : 1));
    e.mode = "staggered";
    e.timer = heavy ? STAGGER.time[e.kind] : STAGGER.shieldBreak;
    e.shotsLeft = 0;
    e.stagger = 0;
    e.steady = e.timer + STAGGER.steady;
    const dx = e.pos.x - from.x;
    const dz = e.pos.z - from.z;
    const d = Math.hypot(dx, dz) || 1;
    e.vel.x = (dx / d) * STAGGER.knock;
    e.vel.z = (dz / d) * STAGGER.knock;
    s.events.push({ t: "stagger", id: e.id, pos: bodyCenter(e), fromX: from.x, fromZ: from.z, interrupted });
    return;
  }
  if (quiet && e.mode === "move" && e.aware === "engaged") {
    e.jink = DODGE.jinkTime;
    e.strafe = -e.strafe;
  }
}

/**
 * A salvage crew's last member is down: its bag falls at its feet, each valuable as from the bin
 * it was taken out of, so a fetch contract counts it. Thrown round in a ring, drawing nothing.
 */
function dropBag(s: State, sq: SquadState, at: Vec3, byPlayer = true) {
  if (byPlayer) s.stats.crewsDown++;
  const bag = sq.bag ?? [];
  bag.forEach((v, n) => {
    const a = (n / Math.max(1, bag.length)) * Math.PI * 2;
    s.loot.push({ id: s.nextId++, kind: "valuable", valuable: v, rarity: VALUABLES[v].rarity, from: sq.bagAt?.[n] ?? -1, pos: { ...at }, vel: { x: Math.cos(a) * 1.8, y: 4.5, z: Math.sin(a) * 1.8 }, age: 0 });
  });
  sq.bag = [];
  sq.bagAt = [];
}

const SHARDS = { drone: 1, grunt: 1, charger: 1, heavy: 3, titan: 0 } as const;

export function kill(s: State, e: Enemy, crit: boolean, by: "player" | "ally" = "player") {
  s.enemies = s.enemies.filter((o) => o !== e);
  const sq = s.squads[e.squad];
  if (sq && !s.enemies.some((o) => o.squad === e.squad)) {
    s.stats.wiped.push(squadKey(sq));
    if (sq.crew) dropBag(s, sq, bodyCenter(e));
  }
  s.stats.kills++;
  if (by === "ally") s.stats.allyKills++;
  else s.stats.killsBy[e.kind]++;
  const p = s.player;
  const w = p.weapons[p.slot];
  if (w && w.rarity === 3 && by === "player") w.mag = magSize(w);
  const c = bodyCenter(e);
  spoils(s, e, c);
  const last = e.poi >= 0 && !s.enemies.some((o) => o.poi === e.poi);
  const from = by === "ally" ? s.ally.pos : s.player.pos;
  s.events.push({ t: "kill", id: e.id, kind: e.kind, pos: c, crit, last, ally: by === "ally", fromX: from.x, fromZ: from.z });
  if (e.kind === "titan") {
    // The titan's fall takes its summons and everything in the air with it.
    s.orbs = [];
    s.waves = [];
    for (const o of [...s.enemies]) if (o.poi === e.poi) kill(s, o, false, by);
  }
}

/**
 * A robot destroyed by the other faction's fire (see FACTION): it drops what it would for the
 * player, and a salvage crew's last its bag, for whoever comes by after the fight; none of it
 * counts as the player's (no kill, no squad destroyed for a contract).
 */
export function fall(s: State, e: Enemy, by: Enemy | null) {
  s.enemies = s.enemies.filter((o) => o !== e);
  const sq = s.squads[e.squad];
  const c = bodyCenter(e);
  if (sq?.crew && !s.enemies.some((o) => o.squad === e.squad)) dropBag(s, sq, c, false);
  spoils(s, e, c);
  const from = by?.pos ?? e.pos;
  s.events.push({ t: "fall", id: e.id, kind: e.kind, pos: c, rogue: !!e.rogue, fromX: from.x, fromZ: from.z });
}

/** What a destroyed robot leaves at `c`: shield shards, now and then a heal, a valuable by its kind, perhaps a mod part. */
function spoils(s: State, e: Enemy, c: Vec3) {
  for (let i = 0; i < SHARDS[e.kind]; i++) {
    const a = rand(s) * Math.PI * 2;
    s.loot.push({ id: s.nextId++, kind: "shard", rarity: 1, pos: { ...c }, vel: { x: Math.cos(a) * 2.5, y: 4, z: Math.sin(a) * 2.5 }, age: 0 });
  }
  if (e.kind !== "titan" && rand(s) < 0.12) {
    s.loot.push({ id: s.nextId++, kind: "heal", heal: rand(s) < 0.5 ? "cell" : "syringe", rarity: 1, pos: { ...c }, vel: { x: 0, y: 5, z: 0 }, age: 0 });
  }
  // Valuables: a chance of parts from most robots, a board from a heavy, data cores from the titan.
  const scrap = (): ValuableKind[] => {
    let r = rand(s);
    for (const [kind, chance] of ROBOT_DROPS.scrap) if ((r -= chance) < 0) return [kind];
    return [];
  };
  const drops: ValuableKind[] = e.kind === "titan" ? ROBOT_DROPS.titan : e.kind === "heavy" ? ROBOT_DROPS.heavy : scrap();
  for (const v of drops) {
    const a = rand(s) * Math.PI * 2;
    s.loot.push({ id: s.nextId++, kind: "valuable", valuable: v, rarity: VALUABLES[v].rarity, pos: { ...c }, vel: { x: Math.cos(a) * 1.5, y: 5, z: Math.sin(a) * 1.5 }, age: 0 });
  }
  // A mod part, decided by its own hash: the raid's numbers are drawn as without it.
  dropRobotMod(s, e, c);
}
