import { speciesOf } from "./species";
import { elementMod, mulberry32, tataAtk, tataHp } from "./logic";
import { ELEMENTS, type Element, type OwnedTata, type Stage } from "./types";

export type ZombieKind = "walker" | "runner" | "brute" | "boss";

export interface BattleActor {
  id: string;
  side: "tata" | "zombie";
  name: string;
  element: Element;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  atk: number;
  range: number;
  speed: number;
  cd: number;
  maxCd: number;
  flash: number;
  shiny?: boolean;
  stage?: Stage;
  speciesId?: string;
  kind?: ZombieKind;
  slot?: number;
  wave?: number;
}

export interface BattleFlash {
  x: number;
  y: number;
  t: number;
  tint: string;
}

export interface BattleSnapshot {
  tatas: BattleActor[];
  zombies: BattleActor[];
  flashes: BattleFlash[];
  wave: number;
  wavesCleared: number;
  maxWaves: number;
  time: number;
  over: boolean;
  won: boolean;
  incoming: number;
}

export const MAX_WAVES = 5;
/** seconds a wave may drag on before the next one opens anyway */
const WAVE_GRACE = 14;
const FIELD_W = 100;
const FIELD_H = 100;

export interface WaveSpawn {
  wave: number;
  /** seconds after the wave opens */
  at: number;
  kind: ZombieKind;
  element: Element;
  y: number;
}

/**
 * A raid is decided before the fight starts so the prep screen can show the
 * roster. The player's real decision is "which three tatas answer this roster";
 * the two-element theme is what makes that decision have a right-ish answer.
 */
export interface Raid {
  seed: number;
  primary: Element;
  secondary: Element;
  spawns: WaveSpawn[];
}

export interface WaveRoster {
  wave: number;
  counts: Partial<Record<Element, number>>;
  boss: boolean;
}

function zombieStats(kind: ZombieKind, wave: number): { hp: number; atk: number; speed: number; range: number; cd: number; name: string } {
  const w = 1 + (wave - 1) * 0.45;
  if (kind === "walker") return { hp: 24 * w, atk: 6 * w, speed: 11, range: 8, cd: 0.9, name: "よたゾンビ" };
  if (kind === "runner") return { hp: 15 * w, atk: 6 * w, speed: 20, range: 7, cd: 0.7, name: "はしりゾンビ" };
  if (kind === "brute") return { hp: 52 * w, atk: 10 * w, speed: 8, range: 9, cd: 1.15, name: "よろいゾンビ" };
  return { hp: 95 * w, atk: 12 * w, speed: 9, range: 10, cd: 1.05, name: "おおゾンビ" };
}

export function buildRaid(seed: number): Raid {
  const rng = mulberry32(seed);
  const primary = ELEMENTS[Math.floor(rng() * ELEMENTS.length)]!;
  let secondary = ELEMENTS[Math.floor(rng() * ELEMENTS.length)]!;
  while (secondary === primary) secondary = ELEMENTS[Math.floor(rng() * ELEMENTS.length)]!;
  const spawns: WaveSpawn[] = [];
  for (let wave = 1; wave <= MAX_WAVES; wave++) {
    const count = 2 + wave;
    let t = 0.4;
    for (let i = 0; i < count; i++) {
      const lane = Math.floor(rng() * 5);
      const y = 18 + lane * 16;
      let kind: ZombieKind = "walker";
      if (wave >= 2 && i % 3 === 0) kind = "runner";
      if (wave >= 3 && i % 4 === 1) kind = "brute";
      if (wave === MAX_WAVES && i === count - 1) kind = "boss";
      const roll = rng();
      const element: Element =
        roll < 0.62 ? primary : roll < 0.9 ? secondary : ELEMENTS[Math.floor(rng() * ELEMENTS.length)]!;
      spawns.push({ wave, at: t, kind, element, y });
      t += 0.55 - wave * 0.04;
    }
  }
  return { seed, primary, secondary, spawns };
}

export function raidRoster(raid: Raid): WaveRoster[] {
  const out: WaveRoster[] = [];
  for (let wave = 1; wave <= MAX_WAVES; wave++) {
    const counts: Partial<Record<Element, number>> = {};
    let boss = false;
    for (const s of raid.spawns) {
      if (s.wave !== wave) continue;
      counts[s.element] = (counts[s.element] ?? 0) + 1;
      if (s.kind === "boss") boss = true;
    }
    out.push({ wave, counts, boss });
  }
  return out;
}

export type Matchup = "strong" | "weak" | "even";

/**
 * How an element fares against the raid's two-element theme. "strong" means it
 * preys on at least one theme element and neither theme element preys on it;
 * "weak" means a theme element preys on it and it preys on none.
 */
export function matchupOf(element: Element, raid: Raid): Matchup {
  const theme = [raid.primary, raid.secondary];
  const strong = theme.some((z) => elementMod(element, z) > 1);
  const weak = theme.some((z) => elementMod(z, element) > 1);
  if (strong && !weak) return "strong";
  if (weak && !strong) return "weak";
  return "even";
}

/** elements worth bringing against this raid */
export function countersOf(raid: Raid): Element[] {
  return ELEMENTS.filter((e) => matchupOf(e, raid) === "strong");
}

export class TataBattle {
  tatas: BattleActor[] = [];
  zombies: BattleActor[] = [];
  flashes: BattleFlash[] = [];
  wave = 1;
  wavesCleared = 0;
  maxWaves = MAX_WAVES;
  time = 0;
  over = false;
  won = false;
  readonly raid: Raid;
  private seq = 1;
  private spawnI = 0;
  private rng: () => number;
  private deadByWave: number[] = new Array(MAX_WAVES + 1).fill(0);
  private sizeByWave: number[] = new Array(MAX_WAVES + 1).fill(0);
  /** when the current wave opened; the next opens once it is dead or WAVE_GRACE passed */
  private waveOpenedAt = 0;

  constructor(party: OwnedTata[], lantern: boolean, raid: Raid) {
    this.raid = raid;
    this.rng = mulberry32(raid.seed ^ 0x5bd1e995);
    for (const s of raid.spawns) this.sizeByWave[s.wave] += 1;
    const slots = [0, 1, 2];
    const positions = [
      { x: 22, y: 32 },
      { x: 22, y: 68 },
      { x: 38, y: 50 },
    ];
    party.slice(0, 3).forEach((tata, i) => {
      const spec = speciesOf(tata.speciesId);
      const slot = tata.partySlot ?? (slots[i] as 0 | 1 | 2);
      const back = slot === 2;
      const hp = tataHp(tata);
      const atk = tataAtk(tata, lantern);
      this.tatas.push({
        id: tata.uid,
        side: "tata",
        name: spec.name,
        element: spec.element,
        x: positions[i]!.x,
        y: positions[i]!.y,
        hp,
        maxHp: hp,
        atk,
        range: back ? 34 : spec.role === "dps" ? 26 : 18,
        speed: 0,
        cd: 0,
        maxCd: spec.role === "dps" ? 0.62 : spec.role === "support" ? 0.85 : 0.95,
        flash: 0,
        shiny: tata.shiny,
        stage: tata.stage,
        speciesId: tata.speciesId,
        slot,
      });
    });
  }

  private id(): string {
    return `z${this.seq++}`;
  }

  private spawn(s: WaveSpawn) {
    const st = zombieStats(s.kind, s.wave);
    this.zombies.push({
      id: this.id(),
      side: "zombie",
      name: st.name,
      element: s.element,
      x: 98,
      y: s.y,
      hp: st.hp,
      maxHp: st.hp,
      atk: st.atk,
      range: st.range,
      speed: st.speed,
      cd: 0.2,
      maxCd: st.cd,
      flash: 0,
      kind: s.kind,
      wave: s.wave,
    });
  }

  tick(dt: number) {
    if (this.over) return;
    this.time += dt;
    const spawns = this.raid.spawns;

    while (this.spawnI < spawns.length) {
      const next = spawns[this.spawnI]!;
      if (next.wave !== this.wave) {
        const prevDead = this.deadByWave[this.wave] >= this.sizeByWave[this.wave];
        const overdue = this.time - this.waveOpenedAt >= WAVE_GRACE;
        if (!prevDead && !overdue) break;
        this.wave = next.wave;
        this.waveOpenedAt = this.time;
      }
      if (next.at > this.time - this.waveOpenedAt) break;
      this.spawn(next);
      this.spawnI += 1;
    }

    this.flashes = this.flashes.filter((f) => {
      f.t -= dt;
      return f.t > 0;
    });

    for (const z of this.zombies) {
      if (z.hp <= 0) continue;
      z.flash = Math.max(0, z.flash - dt);
      z.cd = Math.max(0, z.cd - dt);
      const target = nearest(z, this.tatas);
      if (!target) continue;
      const d = dist(z, target);
      if (d > z.range) {
        const nx = (target.x - z.x) / d;
        const ny = (target.y - z.y) / d;
        z.x += nx * z.speed * dt;
        z.y += ny * z.speed * dt * 0.35;
        z.x = Math.max(8, Math.min(FIELD_W, z.x));
        z.y = Math.max(10, Math.min(FIELD_H - 10, z.y));
      } else if (z.cd <= 0) {
        this.hit(z, target);
        z.cd = z.maxCd;
      }
    }

    for (const t of this.tatas) {
      if (t.hp <= 0) continue;
      t.flash = Math.max(0, t.flash - dt);
      t.cd = Math.max(0, t.cd - dt);
      const target = nearest(t, this.zombies);
      if (!target) continue;
      const d = dist(t, target);
      if (d <= t.range && t.cd <= 0) {
        this.hit(t, target);
        t.cd = t.maxCd;
      }
    }

    for (const z of this.zombies) {
      if (z.hp <= 0 && z.wave !== undefined) this.deadByWave[z.wave] += 1;
    }
    this.tatas = this.tatas.filter((a) => a.hp > 0);
    this.zombies = this.zombies.filter((a) => a.hp > 0);

    let cleared = 0;
    for (let w = 1; w <= MAX_WAVES; w++) {
      if (this.deadByWave[w] >= this.sizeByWave[w]) cleared = w;
      else break;
    }
    this.wavesCleared = cleared;

    if (this.tatas.length === 0) {
      this.over = true;
      this.won = false;
      return;
    }
    if (this.spawnI >= spawns.length && this.zombies.length === 0) {
      this.over = true;
      this.won = true;
      this.wave = MAX_WAVES;
      this.wavesCleared = MAX_WAVES;
    }
  }

  private hit(from: BattleActor, to: BattleActor) {
    const mod = elementMod(from.element, to.element);
    const swing = 0.85 + this.rng() * 0.3;
    const dmg = Math.max(1, Math.round(from.atk * mod * swing));
    to.hp -= dmg;
    to.flash = 0.18;
    from.flash = 0.12;
    this.flashes.push({
      x: (from.x + to.x) / 2,
      y: (from.y + to.y) / 2,
      t: 0.22,
      tint: from.side === "tata" ? (mod > 1 ? "super" : "persimmon") : "rot",
    });
    if (to.hp <= 0) to.hp = 0;
  }

  snapshot(): BattleSnapshot {
    return {
      tatas: this.tatas.map((a) => ({ ...a })),
      zombies: this.zombies.map((a) => ({ ...a })),
      flashes: this.flashes.map((f) => ({ ...f })),
      wave: this.wave,
      wavesCleared: this.wavesCleared,
      maxWaves: this.maxWaves,
      time: this.time,
      over: this.over,
      won: this.won,
      incoming: this.raid.spawns.length - this.spawnI + this.zombies.filter((z) => z.hp > 0).length,
    };
  }
}

function dist(a: BattleActor, b: BattleActor): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

function nearest(from: BattleActor, pool: BattleActor[]): BattleActor | null {
  let best: BattleActor | null = null;
  let bestD = Infinity;
  for (const p of pool) {
    if (p.hp <= 0) continue;
    const d = dist(from, p);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

export function wavesClearedOf(b: TataBattle): number {
  return b.wavesCleared;
}
