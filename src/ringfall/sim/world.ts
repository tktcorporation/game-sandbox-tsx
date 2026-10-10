import { PLAYER, RING, TICK, WORLD } from "./config";
import { dist2d, groundAt } from "./geom";
import { EXTRACT, POIS } from "./map";
import { spawnWave } from "./enemies";
import { hurtPlayer } from "./player";
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
  if (!s.poiActive) {
    if (dist2d(p.pos, poi) < poi.trigger) {
      s.poiActive = true;
      s.wave = 0;
      spawnWave(s);
      s.events.push({ t: "poiStart", poi: s.poi });
    }
    return;
  }
  const alive = s.enemies.filter((e) => e.poi === s.poi).length;
  if (s.wave < poi.waves.length && alive <= 1) {
    if (poi.carePackage && s.wave === 1 && !s.care) {
      const c = poi.carePackage;
      s.care = { x: c.x, z: c.z, y: 70, landed: false, open: false, weapon: { kind: c.weapon[0], rarity: c.weapon[1], mag: -1 } };
      s.events.push({ t: "careDrop", x: c.x, z: c.z });
    }
    spawnWave(s);
  } else if (s.wave >= poi.waves.length && alive === 0) {
    s.events.push({ t: "poiClear", poi: s.poi });
    s.stats.poiTimes.push(s.time - s.poiStart);
    s.poiStart = s.time;
    s.poiActive = false;
    p.selfRevive = 1;
    s.poi++;
    if (s.poi < POIS.length) closeRingTo(s, s.poi);
    else {
      s.phase = "extract";
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
  if (nth !== 1 && table.batteries > 0) spill(s, b.x, b.y, b.z, { kind: "battery", rarity: 1 });
  s.events.push({ t: "binOpen", id: b.id });
}

const weaponLabel = (w: Weapon) => w.kind.toUpperCase();

export function stepLoot(s: State, input: Input) {
  const p = s.player;
  const maxShield = PLAYER.shieldByTier[p.armor];
  if (s.care && !s.care.landed) {
    s.care.y -= 14 * TICK;
    if (s.care.y <= 0) {
      s.care.y = 0;
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
    if (l.kind === "battery" && p.batteries < PLAYER.batteryMax) {
      p.batteries++;
      s.events.push({ t: "pickup", kind: "battery", rarity: 1, label: "シールドバッテリー" });
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

export function stepExtract(s: State) {
  if (s.phase !== "extract") return;
  const p = s.player;
  if (dist2d(p.pos, EXTRACT) < EXTRACT.radius && p.downed <= 0) {
    s.extractTime += TICK;
    if (s.extractTime >= 1.5) {
      s.phase = "done";
      s.stats.poiTimes.push(s.time - s.poiStart);
      s.events.push({ t: "done" });
    }
  } else s.extractTime = 0;
}
