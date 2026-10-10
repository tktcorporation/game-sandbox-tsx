import type { Rarity, WeaponKind } from "../sim/config";

/*
 * Synthesized sound. The fight should read by ear: body hits tick, weak-point
 * hits "dink" high, shields crack like glass, kills punch low, and every enemy
 * wind-up whines before it fires.
 */

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noise: AudioBuffer | null = null;
let wind: { src: AudioBufferSourceNode; gain: GainNode } | null = null;

export function unlock() {
  try {
    if (!ctx) {
      ctx = new AudioContext();
      master = ctx.createGain();
      master.gain.value = 0.45;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -16;
      master.connect(comp).connect(ctx.destination);
      noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const d = noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === "suspended") void ctx.resume();
  } catch {
    ctx = null;
  }
}

interface ToneOpts {
  type?: OscillatorType;
  vol?: number;
  to?: number;
  at?: number;
  attack?: number;
}

function tone(freq: number, dur: number, o: ToneOpts = {}) {
  if (!ctx || !master) return;
  const t = ctx.currentTime + (o.at ?? 0);
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = o.type ?? "triangle";
  osc.frequency.setValueAtTime(freq, t);
  if (o.to) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.to), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(o.vol ?? 0.2, t + (o.attack ?? 0.004));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(master);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

function hiss(dur: number, o: { vol?: number; freq?: number; to?: number; q?: number; type?: BiquadFilterType; at?: number; attack?: number } = {}) {
  if (!ctx || !master || !noise) return;
  const t = ctx.currentTime + (o.at ?? 0);
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const f = ctx.createBiquadFilter();
  f.type = o.type ?? "bandpass";
  f.frequency.setValueAtTime(o.freq ?? 1200, t);
  if (o.to) f.frequency.exponentialRampToValueAtTime(o.to, t + dur);
  f.Q.value = o.q ?? 0.8;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(o.vol ?? 0.3, t + (o.attack ?? 0.003));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(master);
  src.start(t, Math.random() * 1.5);
  src.stop(t + dur + 0.02);
}

const GUN: Record<WeaponKind, () => void> = {
  pike: () => {
    hiss(0.09, { freq: 2200, to: 500, vol: 0.32, q: 0.6 });
    tone(140, 0.08, { type: "sine", to: 60, vol: 0.35 });
  },
  hornet: () => {
    hiss(0.06, { freq: 3200, to: 900, vol: 0.24, q: 0.7 });
    tone(220, 0.05, { type: "sine", to: 90, vol: 0.2 });
  },
  maul: () => {
    hiss(0.28, { freq: 900, to: 160, vol: 0.55, q: 0.5 });
    tone(90, 0.22, { type: "sine", to: 40, vol: 0.6 });
  },
  lance: () => {
    hiss(0.2, { freq: 4200, to: 700, vol: 0.4, q: 0.9 });
    tone(320, 0.16, { type: "sawtooth", to: 80, vol: 0.18 });
    tone(70, 0.2, { type: "sine", to: 40, vol: 0.5 });
  },
};

export const sfx = {
  shot(kind: WeaponKind, overdrive: boolean) {
    GUN[kind]();
    if (overdrive) tone(1400, 0.05, { type: "square", vol: 0.04, to: 2200 });
  },
  hit(crit: boolean, shield: boolean) {
    if (crit) {
      tone(2350, 0.11, { type: "sine", vol: 0.24 });
      tone(3520, 0.08, { type: "sine", vol: 0.1, at: 0.01 });
    } else if (shield) tone(1250, 0.05, { type: "square", vol: 0.07, to: 900 });
    else hiss(0.04, { freq: 2600, vol: 0.18, q: 3 });
  },
  shieldBreak(tier: Rarity) {
    const base = [1500, 1800, 2100, 2500][tier];
    hiss(0.35, { freq: 5200, to: 2400, vol: 0.32, q: 1.5 });
    for (let i = 0; i < 4; i++) tone(base * (1 + i * 0.37), 0.18 + i * 0.05, { type: "sine", vol: 0.08, at: i * 0.02 });
  },
  kill(crit: boolean) {
    tone(120, 0.24, { type: "sine", to: 45, vol: 0.55 });
    hiss(0.18, { freq: 600, to: 120, vol: 0.3 });
    tone(crit ? 1760 : 1320, 0.18, { type: "triangle", vol: 0.16, at: 0.04 });
  },
  hurt(shield: boolean) {
    if (shield) tone(520, 0.1, { type: "square", vol: 0.1, to: 300 });
    else tone(110, 0.16, { type: "sawtooth", vol: 0.22, to: 60 });
    hiss(0.08, { freq: 400, vol: 0.2 });
  },
  myShieldBreak() {
    hiss(0.4, { freq: 3800, to: 900, vol: 0.4, q: 1.2 });
    tone(880, 0.3, { type: "sine", to: 330, vol: 0.18 });
  },
  dry() {
    tone(1900, 0.02, { type: "square", vol: 0.06 });
  },
  reload(time: number) {
    hiss(0.05, { freq: 3000, vol: 0.15, q: 4 });
    hiss(0.05, { freq: 2200, vol: 0.18, q: 4, at: time * 0.55 });
  },
  reloaded() {
    hiss(0.04, { freq: 3600, vol: 0.2, q: 5 });
    tone(1600, 0.03, { type: "square", vol: 0.05, at: 0.02 });
  },
  slide() {
    hiss(0.55, { freq: 900, to: 300, vol: 0.18, q: 0.6, attack: 0.03 });
  },
  jump() {
    hiss(0.08, { freq: 500, vol: 0.08 });
  },
  land(speed: number) {
    tone(80, 0.12, { type: "sine", vol: Math.min(0.5, speed * 0.03), to: 45 });
    hiss(0.1, { freq: 300, vol: Math.min(0.3, speed * 0.02) });
  },
  pickup(rarity: Rarity) {
    const notes = [[660, 880], [660, 990], [740, 1110, 1480], [784, 1175, 1568, 2093]][rarity];
    notes.forEach((f, i) => tone(f, 0.16, { type: "triangle", vol: 0.12, at: i * 0.055 }));
  },
  shard() {
    tone(1900 + Math.random() * 300, 0.06, { type: "sine", vol: 0.06 });
  },
  bin() {
    hiss(0.2, { freq: 700, to: 2000, vol: 0.2 });
    tone(330, 0.2, { type: "triangle", vol: 0.12, to: 660 });
  },
  tactical() {
    hiss(0.25, { freq: 6000, to: 1500, vol: 0.3, q: 2 });
    tone(1800, 0.25, { type: "sawtooth", vol: 0.08, to: 300 });
  },
  tacticalMiss() {
    tone(300, 0.1, { type: "square", vol: 0.05 });
  },
  ultReady() {
    [523, 784, 1047].forEach((f, i) => tone(f, 0.2, { type: "triangle", vol: 0.12, at: i * 0.07 }));
  },
  ultStart() {
    tone(110, 0.8, { type: "sawtooth", to: 440, vol: 0.18, attack: 0.05 });
    hiss(0.8, { freq: 300, to: 4000, vol: 0.25, attack: 0.1 });
  },
  ultEnd() {
    tone(440, 0.4, { type: "sawtooth", to: 110, vol: 0.1 });
  },
  battery() {
    tone(400, 1.9, { type: "sine", to: 1200, vol: 0.06, attack: 0.2 });
  },
  batteryDone() {
    tone(1200, 0.2, { type: "sine", vol: 0.15 });
    tone(1800, 0.25, { type: "sine", vol: 0.1, at: 0.06 });
  },
  telegraph(big: boolean) {
    tone(big ? 220 : 600, big ? 0.9 : 0.5, { type: "sawtooth", to: big ? 660 : 1500, vol: big ? 0.08 : 0.035, attack: 0.1 });
  },
  enemyFire(dist: number) {
    tone(520, 0.12, { type: "square", to: 260, vol: Math.max(0.01, 0.08 - dist * 0.0015) });
  },
  lunge() {
    hiss(0.3, { freq: 400, to: 1400, vol: 0.2 });
  },
  spawn() {
    tone(180, 0.5, { type: "sine", to: 720, vol: 0.05, attack: 0.15 });
  },
  stomp() {
    tone(55, 0.7, { type: "sine", to: 30, vol: 0.8 });
    hiss(0.6, { freq: 200, to: 80, vol: 0.5, type: "lowpass" });
  },
  banner() {
    tone(392, 0.3, { type: "triangle", vol: 0.1 });
    tone(587, 0.4, { type: "triangle", vol: 0.1, at: 0.09 });
  },
  ringWarn() {
    for (let i = 0; i < 3; i++) tone(700, 0.18, { type: "square", vol: 0.05, at: i * 0.28 });
  },
  ringHurt() {
    hiss(0.2, { freq: 900, vol: 0.12 });
  },
  careDrop() {
    tone(900, 1.4, { type: "sine", to: 200, vol: 0.06, attack: 0.3 });
  },
  careLand() {
    tone(70, 0.5, { type: "sine", to: 35, vol: 0.6 });
    hiss(0.5, { freq: 300, vol: 0.3 });
  },
  /** A robot heard or glimpsed you and starts looking. */
  suspect() {
    tone(660, 0.12, { type: "triangle", vol: 0.07, to: 990 });
  },
  /** A squad spotted you: everyone in it is now fighting. */
  engage() {
    tone(880, 0.09, { type: "square", vol: 0.07 });
    tone(1320, 0.14, { type: "square", vol: 0.07, at: 0.09 });
  },
  down() {
    tone(330, 0.6, { type: "sawtooth", to: 80, vol: 0.18 });
  },
  revive() {
    [392, 523, 659].forEach((f, i) => tone(f, 0.2, { type: "triangle", vol: 0.12, at: i * 0.08 }));
  },
  victory() {
    [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, 0.45, { type: "triangle", vol: 0.14, at: i * 0.11 }));
  },
};

/** Rushing air while skydiving; volume follows the fall. */
export function setWind(level: number) {
  if (!ctx || !master || !noise) return;
  if (!wind && level > 0) {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = 700;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(f).connect(gain).connect(master);
    src.start();
    wind = { src, gain };
  }
  if (wind) {
    wind.gain.gain.setTargetAtTime(level * 0.22, ctx.currentTime, 0.1);
    if (level <= 0) {
      const w = wind;
      wind = null;
      w.src.stop(ctx.currentTime + 0.5);
    }
  }
}
