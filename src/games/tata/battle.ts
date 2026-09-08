import { speciesOf } from "./species";
import { elementMod, tataAtk, tataHp } from "./logic";
import type { Element, OwnedTata, Stage } from "./types";

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
  maxWaves: number;
  time: number;
  over: boolean;
  won: boolean;
  incoming: number;
}

const MAX_WAVES = 5;
const FIELD_W = 100;
const FIELD_H = 100;

interface WaveSpawn {
  at: number;
  kind: ZombieKind;
  y: number;
}

function zombieStats(kind: ZombieKind, wave: number): { hp: number; atk: number; speed: number; range: number; cd: number; element: Element; name: string } {
  const w = 1 + (wave - 1) * 0.22;
  if (kind === "walker") return { hp: 28 * w, atk: 6 * w, speed: 11, range: 8, cd: 0.9, element: "dark", name: "よたゾンビ" };
  if (kind === "runner") return { hp: 18 * w, atk: 7 * w, speed: 20, range: 7, cd: 0.7, element: "dark", name: "はしりゾンビ" };
  if (kind === "brute") return { hp: 55 * w, atk: 10 * w, speed: 8, range: 9, cd: 1.15, element: "earth", name: "よろいゾンビ" };
  return { hp: 120 * w, atk: 14 * w, speed: 9, range: 10, cd: 1.05, element: "dark", name: "おおゾンビ" };
}

function buildWaves(seed: number): WaveSpawn[] {
  const spawns: WaveSpawn[] = [];
  let t = 0.4;
  for (let wave = 1; wave <= MAX_WAVES; wave++) {
    const count = 3 + wave;
    for (let i = 0; i < count; i++) {
      const lane = (i * 37 + wave * 13 + seed) % 5;
      const y = 18 + lane * 16;
      let kind: ZombieKind = "walker";
      if (wave >= 2 && i % 3 === 0) kind = "runner";
      if (wave >= 3 && i % 4 === 1) kind = "brute";
      if (wave === MAX_WAVES && i === count - 1) kind = "boss";
      spawns.push({ at: t, kind, y });
      t += 0.55 - wave * 0.04;
    }
    t += 1.8;
  }
  return spawns;
}

export class TataBattle {
  tatas: BattleActor[] = [];
  zombies: BattleActor[] = [];
  flashes: BattleFlash[] = [];
  wave = 1;
  maxWaves = MAX_WAVES;
  time = 0;
  over = false;
  won = false;
  private seq = 1;
  private spawns: WaveSpawn[];
  private spawnI = 0;

  constructor(party: OwnedTata[], lantern: boolean, seed: number) {
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
    this.spawns = buildWaves(seed);
  }

  private id(): string {
    return `z${this.seq++}`;
  }

  private spawn(s: WaveSpawn) {
    const st = zombieStats(s.kind, this.wave);
    this.zombies.push({
      id: this.id(),
      side: "zombie",
      name: st.name,
      element: st.element,
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
    });
  }

  tick(dt: number) {
    if (this.over) return;
    this.time += dt;
    const currentWave = Math.min(MAX_WAVES, 1 + Math.floor(this.time / 9));
    if (currentWave !== this.wave && !this.over) this.wave = currentWave;

    while (this.spawnI < this.spawns.length && this.spawns[this.spawnI]!.at <= this.time) {
      this.spawn(this.spawns[this.spawnI]!);
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

    this.tatas = this.tatas.filter((a) => a.hp > 0);
    this.zombies = this.zombies.filter((a) => a.hp > 0);

    if (this.tatas.length === 0) {
      this.over = true;
      this.won = false;
      return;
    }
    if (this.spawnI >= this.spawns.length && this.zombies.length === 0) {
      this.over = true;
      this.won = true;
      this.wave = MAX_WAVES;
    }
  }

  private hit(from: BattleActor, to: BattleActor) {
    const mod = elementMod(from.element, to.element);
    const dmg = Math.max(1, Math.round(from.atk * mod));
    to.hp -= dmg;
    to.flash = 0.18;
    from.flash = 0.12;
    this.flashes.push({
      x: (from.x + to.x) / 2,
      y: (from.y + to.y) / 2,
      t: 0.22,
      tint: from.side === "tata" ? "persimmon" : "rot",
    });
    if (to.hp <= 0) to.hp = 0;
  }

  snapshot(): BattleSnapshot {
    return {
      tatas: this.tatas.map((a) => ({ ...a })),
      zombies: this.zombies.map((a) => ({ ...a })),
      flashes: this.flashes.map((f) => ({ ...f })),
      wave: this.wave,
      maxWaves: this.maxWaves,
      time: this.time,
      over: this.over,
      won: this.won,
      incoming: this.spawns.length - this.spawnI + this.zombies.filter((z) => z.hp > 0).length,
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
  if (b.won) return MAX_WAVES;
  return Math.max(0, b.wave - 1);
}

