import { ALLY, ENEMIES, HEALS, PLAYER, REINFORCE, SHIP_WAVES, TICK, VALUABLES, WORLD, type HealKind } from "./config";
import { dist2d, groundAt, los, solidAt } from "./geom";
import { steepAt, terrainHeight } from "./terrain";
import { EXTRACTS, POIS, type ExtractPoint } from "./map";
import { spawnEnemy, spawnSpot } from "./enemies";
import { raiseAlly, startHelp } from "./ally";
import { rand, type Input, type Loot, type State, type Weapon } from "./state";

/*
 * The raid's structure: POIs that fall when their robots are beaten, loot and bins,
 * the care package, reinforcements that keep coming, and the ways off the island.
 * There is no set order: the player chooses where to go and when to leave.
 */

/** The uncleared POI whose area the player stands in, or -1. A fight with its robots counts as being there. */
export function poiAt(s: State): number {
  const p = s.player;
  return POIS.findIndex((poi, i) => !s.cleared[i] && (dist2d(p.pos, poi) < poi.trigger || s.enemies.some((e) => e.poi === i && e.aware === "engaged")));
}

export function stepPoi(s: State) {
  const p = s.player;
  POIS.forEach((poi, i) => {
    if (!s.visited[i] && dist2d(p.pos, poi) < poi.trigger) {
      s.visited[i] = true;
      s.events.push({ t: "poiStart", poi: i });
    }
    // The care package drops once a fight at its POI has started.
    if (poi.carePackage && !s.care && s.squads.some((sq) => sq.poi === i && sq.engaged)) {
      const c = poi.carePackage;
      s.care = { x: c.x, z: c.z, y: 70, landed: false, open: false, weapon: { kind: c.weapon[0], rarity: c.weapon[1], mag: -1 } };
      s.events.push({ t: "careDrop", x: c.x, z: c.z });
    }
    if (s.cleared[i] || s.enemies.some((e) => e.poi === i)) return;
    // Every robot of this POI is down: the self-revive comes back and the teammate gets up.
    s.cleared[i] = true;
    s.stats.cleared.push(i);
    p.selfRevive = 1;
    raiseAlly(s, "self", ALLY.reviveHp);
    s.events.push({ t: "poiClear", poi: i });
    if (poi.boss) s.events.push({ t: "titanDown" });
  });
}

/** A reinforcement squad beams in out of the player's sight and comes looking for them. */
export function stepReinforce(s: State) {
  if (s.phase !== "play") return;
  // Hunting squads get a fresh idea of where the player is every few seconds, not a live track.
  const p0 = s.player.pos;
  const refresh = Math.round(s.time / TICK) % Math.round(REINFORCE.huntEvery / TICK) === 0;
  s.squads.forEach((q, i) => {
    if (!q.hunt) return;
    if (q.engaged) {
      q.hunt = false;
      return;
    }
    if (!refresh) return;
    for (const e of s.enemies)
      if (e.squad === i && e.aware === "alert") {
        e.goal = { x: p0.x, z: p0.z };
        e.searchT = Math.max(e.searchT, REINFORCE.huntEvery + 2);
      }
  });
  s.reinforceT -= TICK;
  if (s.reinforceT > 0) return;
  s.reinforceT = REINFORCE.every;
  const p = s.player;
  const eye = { x: p.pos.x, y: p.pos.y + 1.5, z: p.pos.z };
  const [near, far] = REINFORCE.dist;
  const kinds = REINFORCE.waves[Math.min(s.reinforceN, REINFORCE.waves.length - 1)];
  // Where each member stands round the squad's spot, and the top of its body there:
  // every one of them must be out of sight, a hovering drone included.
  const posts = (x: number, z: number) =>
    kinds.map((kind, i) => {
      const mx = x + (i % 2 ? 1.8 : -1.8) * Math.min(i, 1);
      const mz = z + i * 1.6;
      const at = spawnSpot(kind, mx, mz);
      return { x: at.x, y: at.y + ENEMIES[kind].bodyY + ENEMIES[kind].radius, z: at.z, mx, mz }; // the top of its body
    });
  // Somewhere on open ground at the right distance, out of sight; the best of a few tries.
  // The first tries also want a way in clear of buildings; failing that, a clear valley floor will do.
  let at: { x: number; z: number } | null = null;
  for (let i = 0; i < 80 && !at; i++) {
    const strict = i < 40;
    const a = rand(s) * Math.PI * 2;
    const d = near + rand(s) * (far - near);
    const x = p.pos.x + Math.sin(a) * d;
    const z = p.pos.z - Math.cos(a) * d;
    if (Math.hypot(x, z) > WORLD.half - 30 || steepAt(x, z)) continue;
    const g = groundAt(x, z, 1, 99);
    if (g > terrainHeight(x, z) + 0.3 || terrainHeight(x, z) > 4) continue; // valley floor only, not a roof or the high ground
    if (los(eye, { x, y: g + 1.5, z }) || posts(x, z).some((q) => los(eye, q))) continue;
    if (!walkable(x, z, p.pos.x, p.pos.z, strict)) continue;
    at = { x, z };
  }
  if (!at) {
    s.reinforceT = 5; // try again shortly
    return;
  }
  s.reinforceN++;
  const squad = s.squads.length;
  s.squads.push({ name: "増援", poi: -1, patrol: [], leg: 0, engaged: false, roam: true, hunt: true, sinceSeen: 0, last: { x: p.pos.x, z: p.pos.z } });
  const spots = posts(at.x, at.z);
  kinds.forEach((kind, i) => {
    const e = spawnEnemy(s, kind, spots[i].mx, spots[i].mz, -1, squad, { appear: true });
    e.aware = "alert";
    e.goal = { x: p.pos.x, z: p.pos.z };
    e.searchT = 40;
    e.detect = 0.3;
  });
  s.events.push({ t: "reinforce", x: at.x, z: at.z });
}

/** Just above the 1.2 m a ground robot climbs (`CLIMB` in enemies.ts): low cover does not block it. */
const CLIMB_OVER = 1.3;

/**
 * A robot walking straight from (x, z) to (tx, tz) stays on the valley floor: no cliff and no
 * high ground, and with `solids` nothing taller than a robot can step onto. Robots walk straight
 * at their goal, so a route that needs a door or stairs would leave them stuck at a wall.
 */
function walkable(x: number, z: number, tx: number, tz: number, solids: boolean): boolean {
  const n = Math.ceil(Math.hypot(tx - x, tz - z) / 1);
  for (let i = 1; i < n; i++) {
    const qx = x + ((tx - x) * i) / n;
    const qz = z + ((tz - z) * i) / n;
    if (steepAt(qx, qz) || terrainHeight(qx, qz) > 4) return false;
    const g = terrainHeight(qx, qz);
    if (solids && solidAt(qx, g + CLIMB_OVER, qz)) return false;
  }
  return true;
}

function spill(s: State, x: number, y: number, z: number, item: Omit<Loot, "id" | "pos" | "vel" | "age">) {
  const p = s.player;
  const a = Math.atan2(p.pos.z - z, p.pos.x - x) + (rand(s) - 0.5) * 1.6;
  // Gentle toss so loot from a roof bin stays on the roof.
  const sp = y > 0.5 ? 1.2 : 2.6;
  s.loot.push({ ...item, id: s.nextId++, pos: { x, y: y + 1.0, z }, vel: { x: Math.cos(a) * sp, y: 4.2, z: Math.sin(a) * sp }, age: 0 });
}

/** Small items turn up twice as often as big ones. */
function rollHeal(s: State): HealKind {
  const r = rand(s);
  return r < 0.33 ? "cell" : r < 0.66 ? "syringe" : r < 0.83 ? "battery" : "medkit";
}

function openBin(s: State, binIndex: number) {
  const b = s.bins[binIndex];
  b.open = true;
  const table = POIS[b.poi].loot;
  const nth = s.bins.filter((o) => o.poi === b.poi).indexOf(b);
  if (table.weapon.length) {
    const [kind, rarity] = table.weapon[Math.floor(rand(s) * table.weapon.length)];
    spill(s, b.x, b.y, b.z, { kind: "weapon", rarity, weapon: { kind, rarity, mag: -1 } });
  }
  if (table.armor.length && nth !== 0) spill(s, b.x, b.y, b.z, { kind: "armor", rarity: table.armor[nth % table.armor.length] });
  for (let i = 0; i < table.heals; i++) spill(s, b.x, b.y, b.z, { kind: "heal", heal: rollHeal(s), rarity: 1 });
  if (b.flare) spill(s, b.x, b.y, b.z, { kind: "flare", rarity: 3 });
  // One valuable per bin; the high-rises' top floors are worth the climb.
  const valuable = b.flare ? (rand(s) < 0.4 ? "core" : "board") : table.valuable;
  spill(s, b.x, b.y, b.z, { kind: "valuable", valuable, rarity: valuable === "core" ? 3 : valuable === "board" ? 2 : 1 });
  s.events.push({ t: "binOpen", id: b.id });
}

const weaponLabel = (w: Weapon) => w.kind.toUpperCase();

export function stepLoot(s: State, input: Input) {
  const p = s.player;
  const maxShield = PLAYER.shieldByTier[p.armor];
  if (s.care && !s.care.landed) {
    s.care.y -= 14 * TICK;
    const ground = groundAt(s.care.x, s.care.z, 0.8, s.care.y);
    if (s.care.y <= ground) {
      s.care.y = ground;
      s.care.landed = true;
      s.events.push({ t: "careLand", x: s.care.x, z: s.care.z });
    }
  }
  const alive = p.downed <= 0 && s.phase === "play";
  s.loot = s.loot.filter((l) => {
    l.age += TICK;
    const d = Math.hypot(l.pos.x - p.pos.x, l.pos.z - p.pos.z, l.pos.y - (p.pos.y + 0.8));
    if (l.kind === "shard" && l.age > 0.35 && d < PLAYER.shardMagnet && alive) {
      const sp = 16;
      l.vel = { x: ((p.pos.x - l.pos.x) / d) * sp, y: ((p.pos.y + 0.8 - l.pos.y) / d) * sp, z: ((p.pos.z - l.pos.z) / d) * sp };
      l.pos.x += l.vel.x * TICK;
      l.pos.y += l.vel.y * TICK;
      l.pos.z += l.vel.z * TICK;
      if (d < 0.9) {
        if (p.shield < maxShield) p.shield = Math.min(maxShield, p.shield + PLAYER.shardShield);
        else p.hp = Math.min(PLAYER.hp, p.hp + PLAYER.shardShield / 2);
        s.events.push({ t: "pickup", kind: "shard", rarity: 1, label: "" });
        return false;
      }
      return true;
    }
    l.vel.y -= WORLD.gravity * TICK;
    l.pos.x += l.vel.x * TICK;
    l.pos.y += l.vel.y * TICK;
    l.pos.z += l.vel.z * TICK;
    const g = groundAt(l.pos.x, l.pos.z, 0.2, l.pos.y + 0.3);
    if (l.pos.y <= g) {
      l.pos.y = g;
      l.vel.x *= 0.5;
      l.vel.z *= 0.5;
      l.vel.y = 0;
    }
    if (!alive || l.age < 0.4) return true;
    const near = Math.hypot(l.pos.x - p.pos.x, l.pos.z - p.pos.z) < PLAYER.pickupRange && Math.abs(l.pos.y - p.pos.y) < 2;
    if (!near) return true;
    if (l.kind === "heal" && l.heal && p.heals[l.heal] < HEALS[l.heal].max) {
      p.heals[l.heal]++;
      s.events.push({ t: "pickup", kind: "heal", rarity: 1, label: HEALS[l.heal].label });
      return false;
    }
    if (l.kind === "valuable" && l.valuable) {
      p.haul.push(l.valuable);
      const v = VALUABLES[l.valuable];
      s.events.push({ t: "pickup", kind: "valuable", rarity: l.rarity, label: `${v.label} +${v.value}` });
      return false;
    }
    if (l.kind === "flare" && p.flares < 1) {
      p.flares = 1;
      s.events.push({ t: "pickup", kind: "flare", rarity: 3, label: "発煙筒" });
      return false;
    }
    if (l.kind === "armor" && l.rarity > p.armor) {
      p.armor = l.rarity;
      p.shield = PLAYER.shieldByTier[p.armor];
      s.events.push({ t: "pickup", kind: "armor", rarity: l.rarity, label: "アーマー" });
      return false;
    }
    return true;
  });

  if (!input.interact || !alive) return;
  const t = useTarget(s);
  if (t?.kind === "ally") startHelp(s);
  else if (t?.kind === "bin") openBin(s, t.index);
  else if (t?.kind === "care") openCare(s);
  else if (t?.kind === "weapon") takeWeapon(s, t.loot);
}

/** What one press of the use key acts on. The HUD shows its prompt from the same choice. */
export type UseTarget = { kind: "ally" } | { kind: "bin"; index: number } | { kind: "care" } | { kind: "weapon"; loot: Loot };

/**
 * A downed teammate within reach comes first, however close any loot is; otherwise
 * the closest of bin, care package or weapon within reach.
 */
export function useTarget(s: State): UseTarget | null {
  const p = s.player;
  const level = (y: number) => Math.abs(y - p.pos.y) < 1.5;
  const a = s.ally;
  if (a.active && a.down > 0 && dist2d(a.pos, p.pos) < PLAYER.interactRange + 1 && level(a.pos.y)) return { kind: "ally" };
  const picks: { d: number; t: UseTarget }[] = [];
  s.bins.forEach((b, index) => {
    if (!b.open && level(b.y)) picks.push({ d: dist2d(b, p.pos), t: { kind: "bin", index } });
  });
  const care = s.care;
  if (care && care.landed && !care.open && level(care.y)) picks.push({ d: dist2d(care, p.pos) - 0.6, t: { kind: "care" } });
  for (const l of s.loot) {
    if (l.kind !== "weapon" || !l.weapon || l.age < 0.4 || !level(l.pos.y)) continue;
    picks.push({ d: dist2d(l.pos, p.pos) - 0.3, t: { kind: "weapon", loot: l } });
  }
  return picks.filter((k) => k.d < PLAYER.interactRange).sort((x, y) => x.d - y.d)[0]?.t ?? null;
}

function openCare(s: State) {
  const care = s.care;
  if (!care) return;
  care.open = true;
  spill(s, care.x, care.y, care.z, { kind: "weapon", rarity: care.weapon.rarity, weapon: care.weapon });
  s.events.push({ t: "binOpen", id: -1 });
}

export function takeWeapon(s: State, l: Loot) {
  const p = s.player;
  const w = l.weapon!;
  s.loot = s.loot.filter((o) => o !== l);
  const empty = p.weapons.indexOf(null);
  if (empty >= 0) {
    p.weapons[empty] = { ...w };
    p.slot = empty;
  } else {
    const old = p.weapons[p.slot]!;
    p.weapons[p.slot] = { ...w };
    s.loot.push({ id: s.nextId++, kind: "weapon", rarity: old.rarity, weapon: old, pos: { ...l.pos }, vel: { x: 0, y: 2, z: 0 }, age: 0 });
  }
  p.reload = 0;
  p.cooldown = 0.3;
  s.events.push({ t: "pickup", kind: "weapon", rarity: w.rarity, label: weaponLabel(w) });
}

/** The extraction point the player stands in, if any. */
export function extractHere(s: State): ExtractPoint | null {
  const p = s.player;
  return EXTRACTS.find((x) => dist2d(p.pos, x) < x.radius && Math.abs(p.pos.y - groundAt(x.x, x.z, 0.4, 99)) < 1.5) ?? null;
}

/** Whether an extraction point can be used now (the dropship has landed, the player has a flare). */
export function extractReady(s: State, x: ExtractPoint): boolean {
  if (x.call) return s.shipCall === 0;
  if (x.needsFlare) return s.player.flares > 0;
  return true;
}

export function stepExtract(s: State) {
  if (s.phase !== "play") return;
  const p = s.player;
  const here = p.downed > 0 ? null : extractHere(s);
  const ship = EXTRACTS.find((x) => x.call)!;
  if (here === ship && s.shipCall < 0) {
    s.shipCall = ship.call!;
    s.shipWaveT = SHIP_WAVES.first;
    s.events.push({ t: "shipCalled" });
  }
  if (s.shipCall > 0) {
    s.shipCall = Math.max(0, s.shipCall - TICK);
    if (s.shipCall === 0) s.events.push({ t: "shipLanded" });
    s.shipWaveT -= TICK;
    if (s.shipWaveT <= 0 && s.shipWave < SHIP_WAVES.waves.length) shipWave(s, ship);
  }
  if (here && extractReady(s, here)) {
    if (here.needsFlare && s.extractTime === 0) s.events.push({ t: "flareLit" });
    s.extractTime += TICK;
    if (s.extractTime >= here.hold) {
      if (here.needsFlare) p.flares--;
      s.extractedAt = here.id;
      s.phase = "done";
      s.outcome = "extracted";
      s.events.push({ t: "done" });
    }
  } else s.extractTime = 0;
}

/** The squad the dropship's waves join, kept apart from the timed reinforcements. */
export const SHIP_SQUAD = "降下部隊";

/** Robots beam in round the pad while the dropship is on its way. */
function shipWave(s: State, ship: ExtractPoint) {
  s.shipWaveT = SHIP_WAVES.every;
  const kinds = SHIP_WAVES.waves[s.shipWave++];
  let squad = s.squads.findIndex((q) => q.name === SHIP_SQUAD);
  if (squad < 0) {
    squad = s.squads.length;
    s.squads.push({ name: SHIP_SQUAD, poi: -1, patrol: [], leg: 0, engaged: true, roam: true, sinceSeen: 0, last: { x: ship.x, z: ship.z } });
  }
  const pad = POIS[POIS.length - 1];
  for (const kind of kinds) {
    if (s.enemies.filter((e) => e.squad === squad).length >= SHIP_WAVES.maxAlive) break;
    const a = rand(s) * Math.PI * 2;
    const e = spawnEnemy(s, kind, pad.x + Math.sin(a) * SHIP_WAVES.radius, pad.z - Math.cos(a) * SHIP_WAVES.radius, -1, squad, { appear: true });
    e.aware = "engaged";
    e.detect = 1;
  }
  s.squads[squad].engaged = true;
  s.squads[squad].sinceSeen = 0;
  s.events.push({ t: "shipWave" });
}
