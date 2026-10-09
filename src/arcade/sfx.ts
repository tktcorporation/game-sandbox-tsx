import { load, store } from "./save";

/*
 * Every state change gets its own short synthesized sound, so the game can be
 * followed by ear. WebAudio only starts after a user gesture, so the context
 * is created lazily on the first call that follows one.
 */

let ctx: AudioContext | null = null;
let muted = load("muted", { on: false }).on;

export const isMuted = () => muted;
export function setMuted(on: boolean) {
  muted = on;
  store("muted", { on });
}

function ac(): AudioContext | null {
  if (muted) return null;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function tone(freq: number, dur: number, opts: { type?: OscillatorType; vol?: number; slide?: number; delay?: number } = {}) {
  const c = ac();
  if (!c) return;
  const t = c.currentTime + (opts.delay ?? 0);
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = opts.type ?? "triangle";
  o.frequency.setValueAtTime(freq, t);
  if (opts.slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * opts.slide), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(opts.vol ?? 0.12, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(c.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}

function noise(dur: number, opts: { vol?: number; freq?: number; delay?: number } = {}) {
  const c = ac();
  if (!c) return;
  const t = c.currentTime + (opts.delay ?? 0);
  const buf = c.createBuffer(1, Math.ceil(c.sampleRate * dur), c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
  const src = c.createBufferSource();
  src.buffer = buf;
  const f = c.createBiquadFilter();
  f.type = "lowpass";
  f.frequency.value = opts.freq ?? 1200;
  const g = c.createGain();
  g.gain.value = opts.vol ?? 0.18;
  src.connect(f).connect(g).connect(c.destination);
  src.start(t);
}

/** Semitone steps above a base pitch: used for rising sequences. */
const semi = (base: number, n: number) => base * Math.pow(2, n / 12);

export const sfx = {
  tap: () => tone(660, 0.05, { type: "square", vol: 0.04 }),
  select: () => tone(520, 0.08, { vol: 0.08, slide: 1.3 }),
  move: () => tone(380, 0.09, { vol: 0.07, slide: 1.4 }),
  push: () => {
    noise(0.12, { vol: 0.12, freq: 700 });
    tone(180, 0.12, { type: "square", vol: 0.05, slide: 0.6 });
  },
  hit: (n = 1) => {
    noise(0.1, { vol: 0.16, freq: 2400 });
    tone(220 - n * 30, 0.16, { type: "sawtooth", vol: 0.07, slide: 0.5 });
  },
  house: () => {
    noise(0.45, { vol: 0.28, freq: 500 });
    tone(110, 0.4, { type: "sawtooth", vol: 0.08, slide: 0.4 });
  },
  splash: () => noise(0.35, { vol: 0.16, freq: 3000 }),
  spawn: () => tone(140, 0.25, { type: "square", vol: 0.05, slide: 1.8 }),
  warn: () => {
    tone(880, 0.07, { type: "square", vol: 0.04 });
    tone(880, 0.07, { type: "square", vol: 0.04, delay: 0.12 });
  },
  wind: () => noise(0.6, { vol: 0.1, freq: 900 }),
  dig: (i = 0) => {
    noise(0.07, { vol: 0.14, freq: 900 });
    tone(semi(300, i % 8), 0.06, { vol: 0.05 });
  },
  crew: () => tone(1040, 0.06, { vol: 0.04 }),
  douse: () => noise(0.5, { vol: 0.2, freq: 5000 }),
  flipTick: () => tone(1200, 0.03, { type: "square", vol: 0.025 }),
  gem: (step: number) => tone(semi(523, step), 0.14, { vol: 0.09 }),
  bust: () => {
    noise(0.7, { vol: 0.3, freq: 400 });
    tone(90, 0.6, { type: "sawtooth", vol: 0.1, slide: 0.5 });
  },
  bank: () => [0, 4, 7, 12].forEach((s, i) => tone(semi(523, s), 0.18, { vol: 0.08, delay: i * 0.07 })),
  win: () => [0, 4, 7, 12, 16].forEach((s, i) => tone(semi(392, s), 0.22, { vol: 0.09, delay: i * 0.09 })),
  lose: () => [0, -3, -7].forEach((s, i) => tone(semi(330, s), 0.3, { type: "sawtooth", vol: 0.05, delay: i * 0.14 })),
};
