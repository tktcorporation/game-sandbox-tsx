/*
 * The sound engine: everything is synthesized with WebAudio. Cues (sfx.ts) are
 * built from the primitives here and played as voices into four buses
 * (weapons, world, ui, ambience). A positional voice goes through a panner at
 * its source, a low-pass that closes with distance and behind walls, and a send
 * into the shared reverb, whose character follows the space round the listener
 * (a long sparse echo in the open, a short room under a roof).
 *
 * The engine runs on any BaseAudioContext, so the sound check can render every
 * cue offline through the same chain the game uses.
 */

export interface P3 {
  x: number;
  y: number;
  z: number;
}
export type Bus = "weapons" | "world" | "ui" | "amb";

interface Voice {
  out: GainNode;
  end: number;
  /** Rough loudness at the ear, used to drop the quietest when too many play. */
  level: number;
}

/** Decides whether a source is out of the listener's line of sight (soundscape.ts supplies it). */
export type Occluder = (from: P3, to: P3) => boolean;

const VOL_KEY = "ringfall.volume.v1";

export class Mixer {
  readonly ctx: BaseAudioContext;
  readonly lowPower: boolean;
  readonly noise: AudioBuffer;
  /** Brown noise: rumble and wind. */
  readonly rumble: AudioBuffer;
  private readonly buses: Record<Bus, GainNode>;
  /** Ambience sits behind this gain so big moments can push it down. */
  private readonly ambDuck: GainNode;
  readonly verbIn: GainNode;
  private readonly sendOpen: GainNode;
  private readonly sendRoom: GainNode;
  readonly volume: GainNode;
  readonly ear: P3 = { x: 0, y: 0, z: 0 };
  readonly fwd: P3 = { x: 0, y: 0, z: -1 };
  /** 0 in the open .. 1 under a roof. */
  room = 0;
  occluder: Occluder | null = null;
  private voices: Voice[] = [];
  private readonly maxVoices: number;

  constructor(ctx: BaseAudioContext, lowPower: boolean) {
    this.ctx = ctx;
    this.lowPower = lowPower;
    this.maxVoices = lowPower ? 14 : 28;
    this.noise = makeNoise(ctx, 4, false);
    this.rumble = makeNoise(ctx, 4, true);

    // buses -> mix -> glue compressor -> limiter -> volume -> out
    const mix = ctx.createGain();
    mix.gain.value = 1.6;
    const glue = ctx.createDynamicsCompressor();
    glue.threshold.value = -16;
    glue.ratio.value = 4;
    glue.attack.value = 0.004;
    glue.release.value = 0.2;
    const limit = ctx.createDynamicsCompressor();
    limit.threshold.value = -4;
    limit.knee.value = 0;
    limit.ratio.value = 20;
    limit.attack.value = 0.001;
    limit.release.value = 0.08;
    // The limiter's lookahead lets the first millisecond through; a soft clip catches it.
    const clip = ctx.createWaveShaper();
    clip.curve = softClip();
    this.volume = ctx.createGain();
    this.volume.gain.value = loadVolume();
    mix.connect(glue).connect(limit).connect(clip).connect(this.volume).connect(ctx.destination);

    const bus = (v: number) => {
      const g = ctx.createGain();
      g.gain.value = v;
      g.connect(mix);
      return g;
    };
    this.ambDuck = ctx.createGain();
    this.ambDuck.connect(mix);
    const amb = ctx.createGain();
    amb.gain.value = 0.8;
    amb.connect(this.ambDuck);
    this.buses = { weapons: bus(1), world: bus(1), ui: bus(0.85), amb };

    // Reverb: two convolvers, crossfaded by how enclosed the listener is.
    this.verbIn = ctx.createGain();
    const verbOut = ctx.createGain();
    verbOut.gain.value = 0.9;
    verbOut.connect(mix);
    this.sendOpen = ctx.createGain();
    this.sendRoom = ctx.createGain();
    this.sendRoom.gain.value = 0;
    const open = ctx.createConvolver();
    open.buffer = openAir(ctx, lowPower ? 1.4 : 2.6);
    const room = ctx.createConvolver();
    room.buffer = smallRoom(ctx);
    this.verbIn.connect(this.sendOpen).connect(open).connect(verbOut);
    this.verbIn.connect(this.sendRoom).connect(room).connect(verbOut);
  }

  bus(b: Bus): AudioNode {
    return this.buses[b];
  }

  setRoom(room: number) {
    this.room = room;
    const t = this.ctx.currentTime;
    this.sendOpen.gain.setTargetAtTime(1 - room, t, 0.15);
    this.sendRoom.gain.setTargetAtTime(room * 1.3, t, 0.15);
  }

  /** Push the ambience down for a moment (kills, shield breaks, blasts). */
  duck(depth: number, hold: number) {
    const g = this.ambDuck.gain;
    const t = this.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(Math.max(0.05, 1 - depth), t + 0.03);
    g.setTargetAtTime(1, t + 0.03 + hold, 0.35);
  }

  setListener(pos: P3, fwd: P3, up: P3) {
    Object.assign(this.ear, pos);
    Object.assign(this.fwd, fwd);
    const l = this.ctx.listener;
    if (l.positionX) {
      l.positionX.value = pos.x;
      l.positionY.value = pos.y;
      l.positionZ.value = pos.z;
      l.forwardX.value = fwd.x;
      l.forwardY.value = fwd.y;
      l.forwardZ.value = fwd.z;
      l.upX.value = up.x;
      l.upY.value = up.y;
      l.upZ.value = up.z;
    } else {
      l.setPosition(pos.x, pos.y, pos.z);
      l.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
    }
  }

  /**
   * Opens a voice. `level` is the cue's nominal loudness; a positional voice is
   * weighed by its distance too. Returns null when the voice is too quiet to
   * win a slot.
   */
  open(o: VoiceOpts): { input: GainNode; voice: Voice } | null {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    this.voices = this.voices.filter((v) => v.end > t);
    let level = o.level ?? 0.5;
    let lpHz = 20000;
    let occluded = false;
    let dist = 0;
    if (o.pos) {
      dist = Math.hypot(o.pos.x - this.ear.x, o.pos.y - this.ear.y, o.pos.z - this.ear.z);
      const ref = o.ref ?? 4;
      if (dist > (o.maxDist ?? 160)) return null;
      level *= ref / (ref + Math.max(0, dist - ref));
      occluded = o.occluded ?? (dist > 1.5 && this.occluder !== null && this.occluder(this.ear, o.pos));
      lpHz = Math.max(600, 16000 * Math.exp(-dist / 45));
      if (occluded) {
        lpHz = Math.max(320, lpHz * 0.18);
        level *= 0.5;
      }
    }
    if (this.voices.length >= this.maxVoices) {
      let q = 0;
      for (let i = 1; i < this.voices.length; i++) if (this.voices[i].level < this.voices[q].level) q = i;
      const quiet = this.voices[q];
      if (quiet.level >= level) return null;
      quiet.out.gain.cancelScheduledValues(t);
      quiet.out.gain.setTargetAtTime(0, t, 0.01);
      quiet.end = t;
      this.voices.splice(q, 1);
    }

    const input = ctx.createGain();
    const out = ctx.createGain();
    input.connect(out);
    let tail: AudioNode = out;
    if (o.pos) {
      const pan = ctx.createPanner();
      try {
        pan.panningModel = this.lowPower ? "equalpower" : "HRTF";
      } catch {
        pan.panningModel = "equalpower";
      }
      pan.distanceModel = "inverse";
      pan.refDistance = o.ref ?? 4;
      pan.rolloffFactor = 1;
      pan.maxDistance = 10000;
      if (pan.positionX) {
        pan.positionX.value = o.pos.x;
        pan.positionY.value = o.pos.y;
        pan.positionZ.value = o.pos.z;
      } else pan.setPosition(o.pos.x, o.pos.y, o.pos.z);
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = lpHz;
      lp.Q.value = 0.5;
      if (occluded) out.gain.value = 0.55;
      out.connect(pan).connect(lp);
      tail = lp;
    }
    tail.connect(this.buses[o.bus]);
    // Distant and walled-off sounds are heard more through the space than direct.
    const send = (o.send ?? (o.pos ? 0.3 : 0.12)) * (o.pos ? 1 + Math.min(1.5, dist / 40) + (occluded ? 0.8 : 0) : 1);
    if (send > 0) {
      const s = ctx.createGain();
      s.gain.value = Math.min(1.2, send);
      tail.connect(s).connect(this.verbIn);
    }
    const voice: Voice = { out, end: t + 0.5, level };
    this.voices.push(voice);
    return { input, voice };
  }

  /** Voices currently held (for tests). */
  get active() {
    const t = this.ctx.currentTime;
    return this.voices.filter((v) => v.end > t).length;
  }
}

export interface VoiceOpts {
  bus: Bus;
  pos?: P3;
  /** Distance at which the panner starts to attenuate. Loud sources get a larger one. */
  ref?: number;
  level?: number;
  /** Reverb send, 0..1. */
  send?: number;
  /** Beyond this the voice is not played at all. */
  maxDist?: number;
  /** Force the walled-off filter on or off (sound check); otherwise the occluder decides. */
  occluded?: boolean;
}

// --- the active mixer and the voice being built

let mix: Mixer | null = null;
let actx: AudioContext | null = null;
let cur: { input: GainNode; voice: Voice; t0: number } | null = null;
let lowPowerPref = false;

export function getMixer() {
  return mix;
}

/** The sound check swaps in an offline mixer to render a cue, then puts the live one back. */
export function swapMixer(m: Mixer | null): Mixer | null {
  const prev = mix;
  mix = m;
  return prev;
}

export function preferLowPower(on: boolean) {
  lowPowerPref = on;
}

/** Called from user gestures: browsers start audio only after one. */
export function unlock() {
  try {
    if (!actx) {
      actx = new AudioContext({ latencyHint: "interactive" });
      mix = new Mixer(actx, lowPowerPref);
    }
    if (actx.state === "suspended") void actx.resume();
  } catch {
    actx = null;
    mix = null;
  }
}

export function setVolume(v: number) {
  const x = Math.max(0, Math.min(1, v));
  try {
    localStorage.setItem(VOL_KEY, String(x));
  } catch {
    // Private windows and blocked storage: the setting lasts for this page only.
  }
  if (mix) mix.volume.gain.setTargetAtTime(x * x, mix.ctx.currentTime, 0.02);
}

/** The saved volume as the slider shows it (0..1). */
export function savedVolume(): number {
  try {
    const raw = localStorage.getItem(VOL_KEY);
    const v = raw === null ? NaN : Number(raw);
    if (Number.isFinite(v)) return Math.max(0, Math.min(1, v));
  } catch {
    // Same as above.
  }
  return 0.8;
}

/** The slider is perceptual; the gain is its square. */
function loadVolume() {
  const v = savedVolume();
  return v * v;
}

/**
 * Plays one cue as a voice: `body` schedules tones and noise with the
 * primitives below, which all land in this voice.
 */
export function play(o: VoiceOpts, body: () => void) {
  if (!mix) return;
  const v = mix.open(o);
  if (!v) return;
  const prev = cur;
  cur = { input: v.input, voice: v.voice, t0: mix.ctx.currentTime };
  body();
  cur = prev;
}

/** Seconds since the context started (for rate limits). */
export function now() {
  return mix ? mix.ctx.currentTime : 0;
}

function reach(t: number) {
  if (cur && t + 0.05 > cur.voice.end) cur.voice.end = t + 0.05;
}

export interface ToneOpts {
  type?: OscillatorType;
  vol?: number;
  /** Sweep to this frequency over the tone. */
  to?: number;
  at?: number;
  attack?: number;
  /** A short vibrato / wobble: rate in Hz and depth in cents. */
  wobble?: [number, number];
}

export function tone(freq: number, dur: number, o: ToneOpts = {}) {
  if (!mix || !cur) return;
  const ctx = mix.ctx;
  const t = cur.t0 + (o.at ?? 0);
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = o.type ?? "triangle";
  osc.frequency.setValueAtTime(freq, t);
  if (o.to) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.to), t + dur);
  if (o.wobble) {
    const lfo = ctx.createOscillator();
    const depth = ctx.createGain();
    lfo.frequency.value = o.wobble[0];
    depth.gain.value = o.wobble[1];
    lfo.connect(depth).connect(osc.detune);
    lfo.start(t);
    lfo.stop(t + dur + 0.02);
  }
  env(g.gain, t, dur, o.vol ?? 0.2, o.attack ?? 0.004);
  osc.connect(g).connect(cur.input);
  osc.start(t);
  osc.stop(t + dur + 0.02);
  reach(t + dur);
}

export interface NoiseOpts {
  vol?: number;
  freq?: number;
  to?: number;
  q?: number;
  type?: BiquadFilterType;
  at?: number;
  attack?: number;
  /** Brown noise instead of white: deeper, for rumble and debris. */
  brown?: boolean;
}

export function hiss(dur: number, o: NoiseOpts = {}) {
  if (!mix || !cur) return;
  const ctx = mix.ctx;
  const t = cur.t0 + (o.at ?? 0);
  const src = ctx.createBufferSource();
  src.buffer = o.brown ? mix.rumble : mix.noise;
  src.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = o.type ?? "bandpass";
  f.frequency.setValueAtTime(o.freq ?? 1200, t);
  if (o.to) f.frequency.exponentialRampToValueAtTime(o.to, t + dur);
  f.Q.value = o.q ?? 0.8;
  const g = ctx.createGain();
  env(g.gain, t, dur, o.vol ?? 0.3, o.attack ?? 0.003);
  src.connect(f).connect(g).connect(cur.input);
  src.start(t, Math.random() * 3);
  src.stop(t + dur + 0.02);
  reach(t + dur);
}

function env(p: AudioParam, t: number, dur: number, vol: number, attack: number) {
  p.setValueAtTime(0.0001, t);
  p.exponentialRampToValueAtTime(Math.max(0.0002, vol), t + Math.min(attack, dur * 0.5));
  p.exponentialRampToValueAtTime(0.0001, t + dur);
}

/** A number varied by ±`pct` (0.05 = 5 %), so repeats do not sound identical. */
export function vary(x: number, pct: number) {
  return x * (1 + (Math.random() * 2 - 1) * pct);
}

// --- loops (wind, engines): long-lived sources that the soundscape steers each frame

export interface Loop {
  gain: GainNode;
  filter: BiquadFilterNode;
  pan: PannerNode | null;
  lp: BiquadFilterNode | null;
  stop(): void;
}

/** A looping noise (or noise + hum) bed. Starts silent; steer `gain` and `filter`. */
export function loop(o: { bus: Bus; brown?: boolean; type?: BiquadFilterType; freq: number; q?: number; hum?: number; pos?: P3; ref?: number; send?: number }): Loop | null {
  if (!mix) return null;
  const ctx = mix.ctx;
  const src = ctx.createBufferSource();
  src.buffer = o.brown ? mix.rumble : mix.noise;
  src.loop = true;
  const filter = ctx.createBiquadFilter();
  filter.type = o.type ?? "lowpass";
  filter.frequency.value = o.freq;
  filter.Q.value = o.q ?? 0.7;
  const gain = ctx.createGain();
  gain.gain.value = 0;
  src.connect(filter).connect(gain);
  const extra: AudioScheduledSourceNode[] = [];
  if (o.hum) {
    for (const [k, v] of [
      [1, 0.25],
      [2.01, 0.12],
    ]) {
      const h = ctx.createOscillator();
      h.type = "sawtooth";
      h.frequency.value = o.hum * k;
      const hg = ctx.createGain();
      hg.gain.value = v;
      h.connect(hg).connect(filter);
      h.start();
      extra.push(h);
    }
  }
  let pan: PannerNode | null = null;
  let lp: BiquadFilterNode | null = null;
  let tail: AudioNode = gain;
  if (o.pos) {
    pan = ctx.createPanner();
    try {
      pan.panningModel = mix.lowPower ? "equalpower" : "HRTF";
    } catch {
      pan.panningModel = "equalpower";
    }
    pan.distanceModel = "inverse";
    pan.refDistance = o.ref ?? 10;
    pan.maxDistance = 10000;
    lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 8000;
    gain.connect(pan).connect(lp);
    tail = lp;
    placeLoop({ gain, filter, pan, lp, stop: () => undefined }, o.pos);
  }
  tail.connect(mix.bus(o.bus));
  if (o.send) {
    const s = ctx.createGain();
    s.gain.value = o.send;
    tail.connect(s).connect(mix.verbIn);
  }
  src.start(0, Math.random() * 3);
  return {
    gain,
    filter,
    pan,
    lp,
    stop() {
      const t = ctx.currentTime;
      gain.gain.setTargetAtTime(0, t, 0.15);
      src.stop(t + 1);
      for (const e of extra) e.stop(t + 1);
    },
  };
}

/** Moves a positional loop and sets its distance / wall filter. */
export function placeLoop(l: Loop, pos: P3, occluded = false) {
  if (!mix || !l.pan) return;
  const p = l.pan;
  if (p.positionX) {
    p.positionX.value = pos.x;
    p.positionY.value = pos.y;
    p.positionZ.value = pos.z;
  } else p.setPosition(pos.x, pos.y, pos.z);
  const e = mix.ear;
  const d = Math.hypot(pos.x - e.x, pos.y - e.y, pos.z - e.z);
  let hz = Math.max(500, 14000 * Math.exp(-d / 50));
  if (occluded) hz = Math.max(300, hz * 0.2);
  l.lp?.frequency.setTargetAtTime(hz, mix.ctx.currentTime, 0.1);
}

// --- buffers

function makeNoise(ctx: BaseAudioContext, secs: number, brown: boolean) {
  const b = ctx.createBuffer(1, Math.floor(ctx.sampleRate * secs), ctx.sampleRate);
  const d = b.getChannelData(0);
  let last = 0;
  for (let i = 0; i < d.length; i++) {
    const w = Math.random() * 2 - 1;
    if (brown) {
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    } else d[i] = w;
  }
  return b;
}

/**
 * Open air: a few discrete slaps off distant cliffs, then a thin tail. Darker
 * the later it comes, as air takes the highs.
 */
function openAir(ctx: BaseAudioContext, secs: number) {
  const sr = ctx.sampleRate;
  const b = ctx.createBuffer(2, Math.floor(sr * secs), sr);
  const taps = [0.11, 0.23, 0.37, 0.58, 0.83, 1.2];
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      const k = 0.02 + 0.5 * (t / secs);
      lp += (Math.random() * 2 - 1 - lp) * Math.max(0.03, 0.6 - k);
      d[i] = lp * 0.05 * Math.exp(-t * 2.2);
    }
    for (const [n, tap] of taps.entries()) {
      const at = Math.floor((tap + (c ? 0.013 * (n + 1) : 0)) * sr);
      const amp = 0.45 * Math.exp(-tap * 1.6);
      let s = 0;
      for (let j = 0; j < sr * 0.05 && at + j < d.length; j++) {
        s += (Math.random() * 2 - 1 - s) * 0.25;
        d[at + j] += s * amp * Math.exp(-j / (sr * 0.012));
      }
    }
  }
  return b;
}

/** A small concrete room: dense, bright, and gone in a third of a second. */
function smallRoom(ctx: BaseAudioContext) {
  const sr = ctx.sampleRate;
  const b = ctx.createBuffer(2, Math.floor(sr * 0.45), sr);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      d[i] = (Math.random() * 2 - 1) * 0.35 * Math.exp(-t * 13) * (t < 0.004 ? t / 0.004 : 1);
    }
  }
  return b;
}

function softClip() {
  const n = 1024;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(x * 1.1) / Math.tanh(1.1);
  }
  return c;
}
