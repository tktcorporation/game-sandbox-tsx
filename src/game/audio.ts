/*
 * Synthesized sound. Every event has its own short, distinct sound so the fight
 * reads by ear: a crit is a high "dink", a kill a low punch, being hit a dull thud.
 * Browsers start audio only after a user gesture, so `unlock()` is called from input handlers.
 */

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuf: AudioBuffer | null = null;

export function unlock() {
  try {
    if (!ctx) {
      ctx = new AudioContext();
      master = ctx.createGain();
      master.gain.value = 0.5;
      const comp = ctx.createDynamicsCompressor();
      master.connect(comp).connect(ctx.destination);
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === "suspended") void ctx.resume();
  } catch {
    ctx = null;
  }
}

export function setVolume(v: number) {
  if (master) master.gain.value = v;
}

function tone(freq: number, dur: number, o: { type?: OscillatorType; vol?: number; to?: number; at?: number } = {}) {
  if (!ctx || !master) return;
  const t = ctx.currentTime + (o.at ?? 0);
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = o.type ?? "square";
  osc.frequency.setValueAtTime(freq, t);
  if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t + dur);
  g.gain.setValueAtTime(o.vol ?? 0.2, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(master);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

function noise(dur: number, o: { vol?: number; lo?: number; hi?: number; at?: number } = {}) {
  if (!ctx || !master || !noiseBuf) return;
  const t = ctx.currentTime + (o.at ?? 0);
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  src.playbackRate.value = 0.8 + Math.random() * 0.4;
  const f = ctx.createBiquadFilter();
  f.type = "bandpass";
  f.frequency.setValueAtTime(o.hi ?? 3000, t);
  if (o.lo) f.frequency.exponentialRampToValueAtTime(o.lo, t + dur);
  f.Q.value = 0.8;
  const g = ctx.createGain();
  g.gain.setValueAtTime(o.vol ?? 0.3, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(master);
  src.start(t, Math.random() * 0.5, dur + 0.05);
}

export const sfx = {
  shot: () => {
    noise(0.07, { vol: 0.32, hi: 5200, lo: 900 });
    tone(150, 0.06, { vol: 0.16, to: 60 });
  },
  hit: () => tone(1500, 0.035, { type: "triangle", vol: 0.12 }),
  crit: () => {
    tone(2400, 0.08, { type: "sine", vol: 0.2 });
    tone(3600, 0.05, { type: "sine", vol: 0.08 });
  },
  kill: (streak: number) => {
    noise(0.22, { vol: 0.45, hi: 1800, lo: 120 });
    tone(110, 0.2, { vol: 0.3, to: 40 });
    tone(660 * Math.pow(2, Math.min(streak - 1, 7) / 12), 0.12, { type: "triangle", vol: 0.12, at: 0.02 });
  },
  last: () => {
    tone(80, 0.6, { type: "sine", vol: 0.45, to: 30 });
    noise(0.6, { vol: 0.35, hi: 900, lo: 60 });
  },
  wall: () => noise(0.03, { vol: 0.06, hi: 6000 }),
  hurt: () => {
    tone(90, 0.3, { type: "sawtooth", vol: 0.3, to: 45 });
    noise(0.2, { vol: 0.4, hi: 600, lo: 100 });
  },
  dash: () => noise(0.16, { vol: 0.22, hi: 600, lo: 3000 }),
  reload: () => {
    tone(420, 0.04, { vol: 0.08 });
    tone(300, 0.05, { vol: 0.08, at: 0.12 });
  },
  reloaded: () => {
    tone(520, 0.04, { vol: 0.1 });
    tone(780, 0.06, { vol: 0.1, at: 0.06 });
  },
  telegraph: () => tone(880, 0.12, { type: "sine", vol: 0.05, to: 1320 }),
  enemyShot: () => tone(240, 0.1, { type: "square", vol: 0.06, to: 120 }),
  rush: () => noise(0.35, { vol: 0.2, hi: 400, lo: 1600 }),
  spawn: () => tone(200, 0.3, { type: "sine", vol: 0.05, to: 500 }),
  clear: () => [0, 4, 7, 12].forEach((s, i) => tone(523 * Math.pow(2, s / 12), 0.25, { type: "triangle", vol: 0.12, at: 0.25 + i * 0.08 })),
  dead: () => [0, -5, -10].forEach((s, i) => tone(300 * Math.pow(2, s / 12), 0.3, { type: "sawtooth", vol: 0.1, at: i * 0.12 })),
};
