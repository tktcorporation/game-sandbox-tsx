import { ALLY, AWARE, BAG, ENEMIES, HEALS, PLAYER, RAIDERS, REINFORCE, SEARCH, SHIP_WAVES, TICK, TOP_BINS, VALUABLES, VAULT, WORLD, type HealKind } from "./config";
import { dist2d, groundAt, los, solidAt } from "./geom";
import { highGround, steepAt, terrainHeight } from "./terrain";
import { EXTRACTS, POIS, type ExtractPoint } from "./map";
import { spawnEnemy, spawnSpot } from "./enemies";
import { cellsAround, fieldTo, nextStep } from "./hunt";
import { raiseAlly, startHelp } from "./ally";
import { boosted, callLeft, rand, type Input, type Loot, type State, type Weapon } from "./state";
import type { EnemyKind, ValuableKind } from "./config";
import { makeNoise } from "./awareness";

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
      s.care = { x: c.x, z: c.z, y: terrainHeight(c.x, c.z) + 70, landed: false, open: false, weapon: { kind: c.weapon[0], rarity: c.weapon[1], mag: -1 } };
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

/**
 * Reinforcement squads beam in out of the player's sight on a timer and come looking for them;
 * once in the raid, so do the raiders, who keep after the player more closely and fight better.
 */
export function stepReinforce(s: State) {
  if (s.phase !== "play") return;
  // Hunting squads get a fresh idea of where the player is every few seconds, not a live track.
  const p0 = s.player.pos;
  const tick = Math.round(s.time / TICK);
  s.squads.forEach((q, i) => {
    if (!q.hunt) return;
    if (q.engaged) {
      q.hunt = false;
      return;
    }
    const every = q.elite ? RAIDERS.huntEvery : REINFORCE.huntEvery;
    if (tick % Math.round(every / TICK) !== 0) return;
    for (const e of s.enemies)
      if (e.squad === i && e.aware === "alert") {
        e.goal = { x: p0.x, z: p0.z };
        e.searchT = Math.max(e.searchT, every + 2);
      }
  });
  // Nobody beams in on top of the titan fight; the raiders wait for any fight to end, then come.
  const titanFight = s.enemies.some((e) => e.kind === "titan" && e.aware === "engaged");
  const fighting = s.enemies.some((e) => e.aware === "engaged" && e.mode !== "spawning");
  s.raiderT -= TICK;
  if (s.raiderT <= 0 && !fighting) s.raiderT = beamIn(s, RAIDERS.kinds, RAIDERS.name, true) ? Infinity : 5;
  // A wave held back by the titan fight waits at 0 and comes the moment it ends.
  s.reinforceT = Math.max(0, s.reinforceT - TICK);
  if (s.reinforceT > 0 || titanFight) return;
  const kinds = REINFORCE.waves[Math.min(s.reinforceN, REINFORCE.waves.length - 1)];
  if (!beamIn(s, kinds, "増援", false)) {
    s.reinforceT = 5; // try again shortly
    return;
  }
  s.reinforceT = REINFORCE.every;
  s.reinforceN++;
}

/** Beam a hunting squad in somewhere the player cannot see; false when no such spot turned up. */
function beamIn(s: State, kinds: readonly EnemyKind[], name: string, elite: boolean): boolean {
  const p = s.player;
  const eye = { x: p.pos.x, y: p.pos.y + 1.5, z: p.pos.z };
  const [near, far] = REINFORCE.dist;
  // Where each member stands round the squad's spot, and the top of its body there:
  // every one of them must be out of sight, a hovering drone included.
  const posts = (x: number, z: number) =>
    kinds.map((kind, i) => {
      const mx = x + (i % 2 ? 1.8 : -1.8) * Math.min(i, 1);
      const mz = z + i * 1.6;
      const at = spawnSpot(kind, mx, mz);
      return { x: at.x, y: at.y + ENEMIES[kind].bodyY + ENEMIES[kind].radius, z: at.z, mx, mz }; // the top of its body
    });
  // Somewhere on open ground a walk of the right length away (along the ramps, not as the
  // crow flies), out of sight; the best of a few tries. The first tries also want the first
  // stretch of that walk clear of cover a robot cannot step over; failing that, any will do.
  const field = fieldTo(p.pos.x, p.pos.z);
  const cells = field ? cellsAround(field, near, far) : [];
  let at: { x: number; z: number } | null = null;
  for (let i = 0; i < 80 && !at && cells.length; i++) {
    const c = cells[Math.floor(rand(s) * cells.length)];
    const x = c.x + (rand(s) - 0.5) * 1.5;
    const z = c.z + (rand(s) - 0.5) * 1.5;
    const g = groundAt(x, z, 1, 99);
    if (steepAt(x, z) || g > terrainHeight(x, z) + 0.3) continue; // open ground, not a roof
    const spots = posts(x, z);
    // Every member lands on the same open ground, not up on the high ground beside it.
    if (spots.some((q) => steepAt(q.mx, q.mz) || highGround(q.mx, q.mz))) continue;
    if (los(eye, { x, y: g + 1.5, z }) || spots.some((q) => los(eye, q))) continue;
    const next = nextStep(field!, x, z, p.pos);
    if (i < 40 && !clearWalk(x, z, next.x, next.z)) continue;
    at = { x, z };
  }
  if (!at) return false;
  const squad = s.squads.length;
  s.squads.push({ name, poi: -1, patrol: [], leg: 0, engaged: false, roam: true, hunt: true, routed: true, elite, sinceSeen: 0, last: { x: p.pos.x, z: p.pos.z } });
  const spots = posts(at.x, at.z);
  kinds.forEach((kind, i) => {
    const e = spawnEnemy(s, kind, spots[i].mx, spots[i].mz, -1, squad, { appear: true, elite, plate: elite ? RAIDERS.plate : 0 });
    e.aware = "alert";
    e.goal = { x: p.pos.x, z: p.pos.z };
    e.searchT = 40;
    e.detect = 0.3;
  });
  s.events.push({ t: elite ? "raiders" : "reinforce", x: at.x, z: at.z });
  return true;
}

/** Half the width of the lane a walking robot needs: the heavy's body radius. */
const LANE = 1;

/**
 * No box in a robot-wide lane from (x, z) to (tx, tz) that a walker could not step over
 * (WORLD.stepUp; a crate or a low wall stops it). Hunters follow the ground's field but
 * walk straight between its steps, so cover across a step would leave them pressed against it.
 */
function clearWalk(x: number, z: number, tx: number, tz: number): boolean {
  const len = Math.hypot(tx - x, tz - z);
  const n = Math.ceil(len / 0.5);
  const sx = (-(tz - z) / (len || 1)) * LANE;
  const sz = ((tx - x) / (len || 1)) * LANE;
  for (let i = 1; i < n; i++) {
    const qx = x + ((tx - x) * i) / n;
    const qz = z + ((tz - z) * i) / n;
    const h = terrainHeight(qx, qz) + WORLD.stepUp + 0.05;
    if (solidAt(qx, h, qz) || solidAt(qx + sx, h, qz + sz) || solidAt(qx - sx, h, qz - sz)) return false;
  }
  return true;
}

function spill(s: State, x: number, y: number, z: number, item: Omit<Loot, "id" | "pos" | "vel" | "age">) {
  const p = s.player;
  const a = Math.atan2(p.pos.z - z, p.pos.x - x) + (rand(s) - 0.5) * 1.6;
  // Gentle toss so loot from a roof bin stays on the roof.
  const sp = y > terrainHeight(x, z) + 0.5 ? 1.2 : 2.6;
  s.loot.push({ ...item, id: s.nextId++, pos: { x, y: y + 1.0, z }, vel: { x: Math.cos(a) * sp, y: 4.2, z: Math.sin(a) * sp }, age: 0 });
}

/** Small items turn up twice as often as big ones. */
function rollHeal(s: State): HealKind {
  const r = rand(s);
  return r < 0.33 ? "cell" : r < 0.66 ? "syringe" : r < 0.83 ? "battery" : "medkit";
}

/** A pick from `[item, weight]` pairs. */
function weighted<T>(s: State, list: [T, number][]): T {
  let r = rand(s) * list.reduce((n, [, w]) => n + w, 0);
  for (const [item, w] of list) if ((r -= w) < 0) return item;
  return list[list.length - 1][0];
}

const spillValuable = (s: State, b: { x: number; y: number; z: number }, valuable: ValuableKind) =>
  spill(s, b.x, b.y, b.z, { kind: "valuable", valuable, rarity: VALUABLES[valuable].rarity });

function openBin(s: State, binIndex: number) {
  const b = s.bins[binIndex];
  b.open = true;
  s.events.push({ t: "binOpen", id: b.id });
  if (b.vault) {
    const [kind, rarity] = VAULT.weapon[Math.floor(rand(s) * VAULT.weapon.length)];
    spill(s, b.x, b.y, b.z, { kind: "weapon", rarity, weapon: { kind, rarity, mag: -1 } });
    spill(s, b.x, b.y, b.z, { kind: "armor", rarity: VAULT.armor });
    for (let i = 0; i < VAULT.heals; i++) spill(s, b.x, b.y, b.z, { kind: "heal", heal: rollHeal(s), rarity: 1 });
    for (const v of VAULT.valuables[Math.floor(rand(s) * VAULT.valuables.length)]) spillValuable(s, b, v);
    if (!s.stats.vaults.includes(b.poi)) s.stats.vaults.push(b.poi);
    return;
  }
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
  // In the raid's boosted POI, its own bins lean to one rare kind (`BOOST`).
  const kinds = !b.outside && b.poi === s.boost.poi ? boosted(table.valuable, s.boost.kind) : table.valuable;
  spillValuable(s, b, b.flare ? weighted(s, TOP_BINS) : weighted(s, kinds));
  // Keys lie only in the POIs themselves, so each one is found where the route says.
  if (!b.outside && rand(s) < VAULT.keyChance) {
    const vault = POIS.findIndex((v) => v.keyFrom === POIS[b.poi].id);
    spill(s, b.x, b.y, b.z, { kind: "key", key: vault, rarity: 3 });
  }
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
  const shed: Loot[] = [];
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
    if (l.kind === "valuable" && l.valuable && bagUsed(p.haul) + VALUABLES[l.valuable].size <= BAG.slots) {
      p.haul.push(l.valuable);
      const v = VALUABLES[l.valuable];
      s.events.push({ t: "pickup", kind: "valuable", rarity: l.rarity, label: `${v.label} +${v.value}` });
      return false;
    }
    if (l.kind === "key" && l.key !== undefined) {
      // A second copy is kept too: it comes home as a spare (one carried is lost on a wipe).
      p.keys.push(l.key);
      s.events.push({ t: "pickup", kind: "key", rarity: 3, label: `${POIS[l.key].name}の鍵` });
      return false;
    }
    if (l.kind === "flare" && p.flares < 1) {
      p.flares = 1;
      s.events.push({ t: "pickup", kind: "flare", rarity: 3, label: "発煙筒" });
      return false;
    }
    if (l.kind === "armor" && l.rarity > p.armor) {
      wearArmor(s, l, shed);
      return false;
    }
    return true;
  });
  s.loot.push(...shed);

  stepSearch(s, alive);
  if (!input.interact || !alive) return;
  const t = useTarget(s, !input.keepArmor);
  if (t?.kind === "ally") startHelp(s);
  else if (t?.kind === "bin") startSearch(s, t.index);
  else if (t?.kind === "care") openCare(s);
  else if (t?.kind === "weapon") takeWeapon(s, t.loot);
  else if (t?.kind === "swap") swapInto(s, t.loot);
  else if (t?.kind === "armor") {
    const shed: Loot[] = [];
    s.loot = s.loot.filter((o) => o !== t.loot);
    wearArmor(s, t.loot, shed);
    s.loot.push(...shed);
  }
}

/**
 * Puts on armour from the ground. What was worn is left there (`shed`), marked worn so it
 * can be put back on; fresh armour fills the shield, worn armour keeps what is left of it.
 */
function wearArmor(s: State, l: Loot, shed: Loot[]) {
  const p = s.player;
  if (p.armor > 0) shed.push({ id: s.nextId++, kind: "armor", rarity: p.armor, worn: true, pos: { ...l.pos }, vel: { x: 0, y: 2, z: 0 }, age: 0 });
  p.armor = l.rarity;
  const max = PLAYER.shieldByTier[p.armor];
  p.shield = l.worn ? Math.min(p.shield, max) : max;
  s.events.push({ t: "pickup", kind: "armor", rarity: l.rarity, label: "アーマー" });
}

/** Bag slots the haul takes up. */
export const bagUsed = (haul: ValuableKind[]) => haul.reduce((n, k) => n + VALUABLES[k].size, 0);

/**
 * What would make room for `kind` in a full bag: the set of items (their indices) that frees
 * enough slots for the least value, fewest items on a tie. Null when no set frees enough or
 * the cheapest one is worth as much as `kind`. The bag holds at most `BAG.slots` items, so
 * trying every set is cheap.
 */
export function makeRoom(haul: ValuableKind[], kind: ValuableKind): number[] | null {
  const need = bagUsed(haul) + VALUABLES[kind].size - BAG.slots;
  if (need <= 0) return [];
  let best: { set: number[]; lost: number } | null = null;
  for (let mask = 1; mask < 1 << haul.length; mask++) {
    const set = haul.map((_, i) => i).filter((i) => mask & (1 << i));
    if (set.reduce((n, i) => n + VALUABLES[haul[i]].size, 0) < need) continue;
    const lost = set.reduce((n, i) => n + VALUABLES[haul[i]].value, 0);
    if (!best || lost < best.lost || (lost === best.lost && set.length < best.set.length)) best = { set, lost };
  }
  return best && best.lost < VALUABLES[kind].value ? best.set : null;
}

/** Drop the cheapest items on the ground and bag the better one. */
function swapInto(s: State, l: Loot) {
  const p = s.player;
  const out = l.valuable ? makeRoom(p.haul, l.valuable) : null;
  if (!out || !l.valuable) return;
  const dropped = out.map((i) => p.haul[i]);
  p.haul = p.haul.filter((_, i) => !out.includes(i));
  for (const k of dropped) spillValuable(s, p.pos, k);
  s.loot = s.loot.filter((o) => o !== l);
  p.haul.push(l.valuable);
  const v = VALUABLES[l.valuable];
  s.events.push({ t: "pickup", kind: "valuable", rarity: l.rarity, label: `${v.label} +${v.value}（${dropped.map((k) => VALUABLES[k].label).join("・")}を捨てた）` });
}

function startSearch(s: State, bin: number) {
  const p = s.player;
  if (p.search?.bin === bin) return;
  if (s.bins[bin].vault && !p.keys.includes(s.bins[bin].poi)) {
    s.events.push({ t: "locked", poi: s.bins[bin].poi });
    return;
  }
  p.search = { bin, t: 0 };
  const b = s.bins[bin];
  makeNoise(s, b.x, b.z, SEARCH.noise);
  s.events.push({ t: "searchStart", id: b.id });
}

/** A search goes on while the player stays at the bin with free hands; done, the bin spills open. */
function stepSearch(s: State, alive: boolean) {
  const p = s.player;
  const q = p.search;
  if (!q) return;
  const b = s.bins[q.bin];
  const beside = b && !b.open && dist2d(b, p.pos) < PLAYER.interactRange + 0.4 && Math.abs(b.y - p.pos.y) < 1.5;
  if (!alive || !beside || p.triggerHeld || p.healing) {
    p.search = null;
    return;
  }
  q.t += TICK;
  if (q.t >= searchTime(b)) {
    p.search = null;
    openBin(s, q.bin);
  }
}

export const searchTime = (b: { flare: boolean; vault: boolean }) => (b.vault ? SEARCH.vaultTime : b.flare ? SEARCH.flareTime : SEARCH.time);

/** What one press of the use key acts on. The HUD shows its prompt from the same choice. */
export type UseTarget = { kind: "ally" } | { kind: "bin"; index: number } | { kind: "care" } | { kind: "weapon"; loot: Loot } | { kind: "swap"; loot: Loot } | { kind: "armor"; loot: Loot };

/**
 * A downed teammate within reach comes first, however close any loot is; otherwise
 * the closest of bin, care package or weapon within reach.
 */
export function useTarget(s: State, armor = true): UseTarget | null {
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
    if (l.age < 0.4 || !level(l.pos.y)) continue;
    if (l.kind === "weapon" && l.weapon) picks.push({ d: dist2d(l.pos, p.pos) - 0.3, t: { kind: "weapon", loot: l } });
    // Armour the player took off can go back on; fresh armour is only ever an upgrade, put on by walking over it.
    // It yields to a bin or a weapon at the same distance, since it lies where the upgrade was found.
    else if (armor && l.kind === "armor" && l.worn && l.rarity !== p.armor) picks.push({ d: dist2d(l.pos, p.pos) + 0.3, t: { kind: "armor", loot: l } });
    // A valuable that does not fit is worth a press when something cheaper can make way.
    else if (l.kind === "valuable" && l.valuable && makeRoom(p.haul, l.valuable)?.length) picks.push({ d: dist2d(l.pos, p.pos) - 0.3, t: { kind: "swap", loot: l } });
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

/** Whether an extraction point can be used now (its pickup has come, the player has a flare). */
export function extractReady(s: State, x: ExtractPoint): boolean {
  if (x.call) return callLeft(s, x.id) === 0;
  if (x.needsFlare) return s.player.flares > 0;
  return true;
}

export function stepExtract(s: State) {
  if (s.phase !== "play") return;
  const p = s.player;
  const here = p.downed > 0 ? null : extractHere(s);
  // Standing in a pickup that has to be called calls it; it comes after its time, with robots beaming in round it.
  if (here?.call && !s.calls[here.id]) {
    s.calls[here.id] = { t: here.call, wave: 0, waveT: SHIP_WAVES.first, squad: -1 };
    s.events.push({ t: "shipCalled", id: here.id });
  }
  for (const x of EXTRACTS) {
    const c = s.calls[x.id];
    if (!c || c.t <= 0) continue;
    c.t = Math.max(0, c.t - TICK);
    if (c.t === 0) s.events.push({ t: "shipLanded", id: x.id });
    c.waveT -= TICK;
    if (c.waveT <= 0 && c.wave < SHIP_WAVES.waves.length) shipWave(s, x);
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

/** The name of the squads a called pickup's waves join, kept apart from the timed reinforcements. */
export const SHIP_SQUAD = "降下部隊";

/** Robots beam in round a called pickup (the landing pad, the quay) while it is on its way. */
function shipWave(s: State, ship: ExtractPoint) {
  const c = s.calls[ship.id]!;
  c.waveT = SHIP_WAVES.every;
  const kinds = SHIP_WAVES.waves[c.wave++];
  let squad = c.squad;
  if (squad < 0) {
    squad = c.squad = s.squads.length;
    // Routed like reinforcements: they beam in behind cover, so they must find their way round it to the pickup.
    s.squads.push({ name: SHIP_SQUAD, poi: -1, patrol: [], leg: 0, engaged: false, roam: true, routed: true, sinceSeen: 0, last: { x: ship.x, z: ship.z } });
  }
  const at = ship.waves ?? ship;
  const p = s.player;
  const eye = { x: p.pos.x, y: p.pos.y + 1.6, z: p.pos.z };
  for (const kind of kinds) {
    if (s.enemies.filter((e) => e.squad === squad).length >= SHIP_WAVES.maxAlive) break;
    // Like reinforcements, they beam in where the player cannot see them (a few tries round the ring), and come.
    const start = rand(s) * Math.PI * 2;
    let a = start;
    for (let i = 0; i < 12; i++) {
      const t = start + (i * Math.PI * 2) / 12;
      const x = at.x + Math.sin(t) * SHIP_WAVES.radius;
      const z = at.z - Math.cos(t) * SHIP_WAVES.radius;
      if (!los(eye, { x, y: terrainHeight(x, z) + 1.5, z })) {
        a = t;
        break;
      }
    }
    const e = spawnEnemy(s, kind, at.x + Math.sin(a) * SHIP_WAVES.radius, at.z - Math.cos(a) * SHIP_WAVES.radius, -1, squad, { appear: true });
    // A squad already fighting takes its new members straight into the fight.
    if (s.squads[squad].engaged) {
      e.aware = "engaged";
      e.detect = 1;
      continue;
    }
    // Otherwise they come to the pickup looking for whoever called it: a player in cover near it sees them first.
    e.aware = "alert";
    e.detect = AWARE.suspicious;
    e.goal = { x: ship.x, z: ship.z };
    e.searchT = (c.t > 0 ? c.t : 0) + 20;
  }
  s.events.push({ t: "shipWave", id: ship.id });
}
