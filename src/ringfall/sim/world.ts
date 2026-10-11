import { ALLY, HEALS, PLAYER, RING, SHIP_WAVES, TICK, WORLD, type HealKind } from "./config";
import { dist2d, groundAt } from "./geom";
import { EXTRACTS, POIS, type ExtractPoint } from "./map";
import { spawnEnemy } from "./enemies";
import { hurtPlayer } from "./player";
import { raiseAlly, startHelp } from "./ally";
import { rand, type Input, type Loot, type State, type Weapon } from "./state";

/*
 * The run's structure: POIs that wake up when approached, the ring that closes
 * toward the next POI, loot and bins, the care package, and extraction.
 */

export function closeRingTo(s: State, poiIndex: number) {
  const poi = POIS[poiIndex];
  const r = s.ring;
  Object.assign(r, { fromX: r.x, fromZ: r.z, fromR: r.r, toX: poi.x, toZ: poi.z, toR: poi.ring, t: 0, shrinking: true });
  s.events.push({ t: "ringClose", poi: poiIndex });
}

export function stepPoi(s: State) {
  if (s.poi >= POIS.length) return;
  const poi = POIS[s.poi];
  const p = s.player;
  if (!s.poiActive && dist2d(p.pos, poi) < poi.trigger) {
    s.poiActive = true;
    s.events.push({ t: "poiStart", poi: s.poi });
  }
  // The care package drops once the fight at its POI has started.
  if (poi.carePackage && !s.care && s.squads.some((sq) => sq.poi === s.poi && sq.engaged)) {
    const c = poi.carePackage;
    s.care = { x: c.x, z: c.z, y: 70, landed: false, open: false, weapon: { kind: c.weapon[0], rarity: c.weapon[1], mag: -1 } };
    s.events.push({ t: "careDrop", x: c.x, z: c.z });
  }
  // Squads are on the island from the start, so a POI can be cleared before the player arrives.
  const alive = s.enemies.filter((e) => e.poi === s.poi).length;
  if (alive === 0) {
    s.events.push({ t: "poiClear", poi: s.poi });
    s.stats.poiTimes.push(s.time - s.poiStart);
    s.poiStart = s.time;
    s.poiActive = false;
    p.selfRevive = 1;
    raiseAlly(s, "self", ALLY.reviveHp);
    s.poi++;
    if (s.poi < POIS.length) closeRingTo(s, s.poi);
    else {
      s.phase = "extract";
      // Every way off the island is open: the ring lets go of the whole island.
      Object.assign(s.ring, { x: 0, z: 0, r: 260, fromX: 0, fromZ: 0, fromR: 260, toX: 0, toZ: 0, toR: 260, t: 1, shrinking: false });
      s.events.push({ t: "extractReady" });
    }
  }
}

export function stepRing(s: State) {
  const r = s.ring;
  if (r.shrinking) {
    r.t = Math.min(1, r.t + TICK / RING.shrinkTime);
    const k = r.t * r.t * (3 - 2 * r.t);
    r.x = r.fromX + (r.toX - r.fromX) * k;
    r.z = r.fromZ + (r.toZ - r.fromZ) * k;
    r.r = r.fromR + (r.toR - r.fromR) * k;
    if (r.t >= 1) r.shrinking = false;
  }
  const p = s.player;
  if (dist2d(p.pos, r) > r.r) {
    const before = Math.floor((s.time - TICK) * 1);
    if (Math.floor(s.time) !== before) {
      hurtPlayer(s, RING.dmgPerSec, r.x, r.z, true);
      s.events.push({ t: "ringHurt" });
    }
  }
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
  const alive = p.downed <= 0 && (s.phase === "play" || s.phase === "extract");
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
  // Interact: the closest of bin, care package, or weapon within reach.
  type Pick = { d: number; act: () => void };
  const picks: Pick[] = [];
  const level = (y: number) => Math.abs(y - p.pos.y) < 1.5;
  // A downed teammate within reach comes before any loot, however close the loot is (the
  // HUD offers the revive over everything else at the same reach).
  const a = s.ally;
  if (a.active && a.down > 0 && dist2d(a.pos, p.pos) < PLAYER.interactRange + 1 && level(a.pos.y)) {
    startHelp(s);
    return;
  }
  s.bins.forEach((b, i) => {
    if (!b.open && level(b.y)) picks.push({ d: dist2d(b, p.pos), act: () => openBin(s, i) });
  });
  const care = s.care;
  if (care && care.landed && !care.open && level(0))
    picks.push({
      d: dist2d(care, p.pos) - 0.6,
      act: () => {
        care.open = true;
        spill(s, care.x, 0, care.z, { kind: "weapon", rarity: care.weapon.rarity, weapon: care.weapon });
        s.events.push({ t: "binOpen", id: -1 });
      },
    });
  for (const l of s.loot) {
    if (l.kind !== "weapon" || !l.weapon || l.age < 0.4 || !level(l.pos.y)) continue;
    picks.push({ d: dist2d(l.pos, p.pos) - 0.3, act: () => takeWeapon(s, l) });
  }
  const best = picks.filter((k) => k.d < PLAYER.interactRange).sort((a, b) => a.d - b.d)[0];
  best?.act();
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
  if (s.phase !== "extract") return;
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
      s.stats.poiTimes.push(s.time - s.poiStart);
      s.events.push({ t: "done" });
    }
  } else s.extractTime = 0;
}

/** Robots beam in round the pad while the dropship is on its way. */
function shipWave(s: State, ship: ExtractPoint) {
  s.shipWaveT = SHIP_WAVES.every;
  const kinds = SHIP_WAVES.waves[s.shipWave++];
  let squad = s.squads.findIndex((q) => q.name === "増援");
  if (squad < 0) {
    squad = s.squads.length;
    s.squads.push({ name: "増援", poi: -1, patrol: [], leg: 0, engaged: true, sinceSeen: 0, last: { x: ship.x, z: ship.z } });
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
