import { BUILDINGS } from "./buildings";
import { TROOPS } from "./buildings";
import type { TroopType } from "./types";

export interface EnemyBuilding {
  type: string;
  level: number;
  x: number;
  y: number;
  size: number;
}

export interface EnemyBase {
  name: string;
  thLevel: number;
  buildings: EnemyBuilding[];
  loot: { gold: number; elixir: number };
  trophyReward: number;
  seed: number;
}

interface Target {
  id: number;
  type: string;
  level: number;
  cx: number;
  cy: number;
  size: number;
  hp: number;
  maxHp: number;
  isDefense: boolean;
  dps: number;
  range: number;
  cooldown: number;
}

interface Unit {
  id: number;
  type: TroopType;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  dps: number;
  speed: number;
  range: number;
  prefersDefense: boolean;
  targetId: number | null;
  attackFlash: number;
}

export interface BattleStats {
  destructionPct: number;
  stars: number;
  townHallDestroyed: boolean;
  troopsAlive: number;
  timeLeft: number;
  over: boolean;
}

function buildingMaxHp(type: string, level: number): number {
  const def = BUILDINGS[type as keyof typeof BUILDINGS];
  if (!def) return 200;
  if (def.defense) return def.defense.hp(level);
  if (def.hp) return def.hp(level);
  return 300;
}

export class Battle {
  base: EnemyBase;
  targets: Target[] = [];
  units: Unit[] = [];
  time = 0;
  maxTime = 90;
  private idSeq = 1;
  private totalBuildings: number;
  private armyUsed: Record<TroopType, number> = { barbarian: 0, archer: 0, giant: 0 };
  private explosions: { x: number; y: number; t: number }[] = [];

  constructor(base: EnemyBase) {
    this.base = base;
    for (const b of base.buildings) {
      const def = BUILDINGS[b.type as keyof typeof BUILDINGS];
      const maxHp = buildingMaxHp(b.type, b.level);
      this.targets.push({
        id: this.idSeq++,
        type: b.type,
        level: b.level,
        cx: b.x + b.size / 2,
        cy: b.y + b.size / 2,
        size: b.size,
        hp: maxHp,
        maxHp,
        isDefense: !!def?.defense && def.defense.range > 0,
        dps: def?.defense ? def.defense.dps(b.level) : 0,
        range: def?.defense?.range ?? 0,
        cooldown: 0,
      });
    }
    // walls don't count toward destruction percentage (as in Clash of Clans)
    this.totalBuildings = this.targets.filter((t) => t.type !== "wall").length;
  }

  get explosionList() {
    return this.explosions;
  }

  get used() {
    return this.armyUsed;
  }

  /** deploy a troop at tile coordinates */
  spawn(type: TroopType, x: number, y: number) {
    const t = TROOPS[type];
    this.armyUsed[type] += 1;
    this.units.push({
      id: this.idSeq++,
      type,
      x,
      y,
      hp: t.hp,
      maxHp: t.hp,
      dps: t.dps,
      speed: t.speed,
      range: t.range,
      prefersDefense: t.prefersDefense,
      targetId: null,
      attackFlash: 0,
    });
  }

  private gap(u: Unit, t: Target): number {
    const dx = t.cx - u.x;
    const dy = t.cy - u.y;
    return Math.hypot(dx, dy) - t.size / 2;
  }

  private pickTarget(u: Unit): Target | null {
    const alive = this.targets.filter((t) => t.hp > 0);
    if (alive.length === 0) return null;
    let pool = alive;
    if (u.prefersDefense) {
      const defenses = alive.filter((t) => t.isDefense);
      if (defenses.length) pool = defenses;
    }
    let best: Target | null = null;
    let bestD = Infinity;
    for (const t of pool) {
      const d = this.gap(u, t);
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    }
    return best;
  }

  step(dt: number) {
    this.time += dt;

    // units act
    for (const u of this.units) {
      if (u.hp <= 0) continue;
      u.attackFlash = Math.max(0, u.attackFlash - dt);
      let target = u.targetId ? this.targets.find((t) => t.id === u.targetId && t.hp > 0) ?? null : null;
      if (!target) {
        target = this.pickTarget(u);
        u.targetId = target?.id ?? null;
      }
      if (!target) continue;
      const gap = this.gap(u, target);
      if (gap > u.range) {
        const dx = target.cx - u.x;
        const dy = target.cy - u.y;
        const len = Math.hypot(dx, dy) || 1;
        const move = Math.min(u.speed * dt, gap);
        u.x += (dx / len) * move;
        u.y += (dy / len) * move;
      } else {
        target.hp -= u.dps * dt;
        u.attackFlash = 0.12;
        if (target.hp <= 0) {
          this.explosions.push({ x: target.cx, y: target.cy, t: 0.5 });
          u.targetId = null;
        }
      }
    }

    // defenses fire at nearest unit in range
    for (const t of this.targets) {
      if (t.hp <= 0 || !t.isDefense) continue;
      t.cooldown = Math.max(0, t.cooldown - dt);
      let best: Unit | null = null;
      let bestD = Infinity;
      for (const u of this.units) {
        if (u.hp <= 0) continue;
        const d = Math.hypot(t.cx - u.x, t.cy - u.y);
        if (d <= t.range && d < bestD) {
          bestD = d;
          best = u;
        }
      }
      if (best) best.hp -= t.dps * dt;
    }

    // age explosions
    for (const e of this.explosions) e.t -= dt;
    this.explosions = this.explosions.filter((e) => e.t > 0);
  }

  stats(): BattleStats {
    const destroyed = this.targets.filter((t) => t.hp <= 0 && t.type !== "wall").length;
    const destructionPct = this.totalBuildings ? destroyed / this.totalBuildings : 0;
    const th = this.targets.find((t) => t.type === "townhall");
    const townHallDestroyed = th ? th.hp <= 0 : false;
    let stars = 0;
    if (destructionPct >= 0.5) stars++;
    if (townHallDestroyed) stars++;
    if (destructionPct >= 1) stars++;
    const troopsAlive = this.units.filter((u) => u.hp > 0).length;
    const timeLeft = Math.max(0, this.maxTime - this.time);
    const noTroopsLeftToFight = troopsAlive === 0 && this.units.length > 0;
    const over =
      destructionPct >= 1 || timeLeft <= 0 || noTroopsLeftToFight;
    return { destructionPct, stars, townHallDestroyed, troopsAlive, timeLeft, over };
  }

  result(): { loot: { gold: number; elixir: number }; trophies: number } {
    const s = this.stats();
    const loot = {
      gold: Math.round(this.base.loot.gold * s.destructionPct),
      elixir: Math.round(this.base.loot.elixir * s.destructionPct),
    };
    // trophy math: gain on win (>=1 star), small loss on total failure
    let trophies: number;
    if (s.stars >= 1) {
      trophies = Math.round((this.base.trophyReward * s.stars) / 3) + s.stars;
    } else {
      trophies = -Math.round(this.base.trophyReward / 3);
    }
    return { loot, trophies };
  }
}
