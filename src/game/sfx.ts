// Procedural audio — every sound is synthesized with WebAudio, zero assets.
// The AudioContext can only start after a user gesture, so callers must invoke
// `sound.unlock()` from a pointer/key handler once; everything else no-ops
// safely until then. Mute preference persists across sessions.

export type SfxName =
  | "tap"
  | "error"
  | "place"
  | "build"
  | "finish"
  | "coin"
  | "elixir"
  | "train"
  | "deploy"
  | "arrow"
  | "shot"
  | "boom"
  | "bigboom"
  | "star"
  | "victory"
  | "defeat";

export type MusicMode = "village" | "battle" | null;

const MUTE_KEY = "cos-muted";

/** storage can be blocked entirely (sandboxed iframe, opaque origin) — a
 *  throwing read at module load would blank the app before React mounts. */
function readMutePref(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

/** tiny haptic tick on supporting devices; silently no-ops elsewhere. */
export function buzz(ms: number | number[]): void {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* not supported */
  }
}

interface ToneOpts {
  freq: number;
  /** end frequency for a pitch slide (defaults to freq) */
  to?: number;
  dur: number;
  type?: OscillatorType;
  vol?: number;
  attack?: number;
  delay?: number;
}

class Sound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private musicTimer: number | null = null;
  private beat = 0;
  private mode: MusicMode = null;
  private _muted = readMutePref();

  get muted(): boolean {
    return this._muted;
  }

  /** create the AudioContext — call from a user-gesture handler. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.master.gain.value = this._muted ? 0 : 0.5;
    this.master.connect(this.ctx.destination);
    this.musicBus = this.ctx.createGain();
    this.musicBus.gain.value = 0.3;
    this.musicBus.connect(this.master);
    if (this.mode) this.startScheduler();
  }

  setMuted(m: boolean): void {
    this._muted = m;
    try {
      localStorage.setItem(MUTE_KEY, m ? "1" : "0");
    } catch {
      /* private mode */
    }
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(m ? 0 : 0.5, this.ctx.currentTime, 0.05);
    }
  }

  toggleMuted(): boolean {
    this.setMuted(!this._muted);
    return this._muted;
  }

  // ---- one-shot effects --------------------------------------------------

  play(name: SfxName): void {
    const ctx = this.ctx;
    if (!ctx || this._muted) return;
    switch (name) {
      case "tap":
        this.tone({ freq: 660, to: 880, dur: 0.07, type: "triangle", vol: 0.25 });
        break;
      case "error":
        this.tone({ freq: 220, to: 160, dur: 0.16, type: "square", vol: 0.16 });
        break;
      case "place":
        this.tone({ freq: 180, to: 90, dur: 0.14, type: "triangle", vol: 0.5 });
        this.noise(0.06, 900, 0.2);
        break;
      case "build":
        // two hammer knocks
        this.noise(0.05, 1600, 0.3);
        this.tone({ freq: 240, to: 180, dur: 0.08, vol: 0.3 });
        this.noise(0.05, 1600, 0.3, 0.14);
        this.tone({ freq: 260, to: 190, dur: 0.08, vol: 0.3, delay: 0.14 });
        break;
      case "finish":
        this.arp([523, 659, 784], 0.09, "triangle", 0.3);
        break;
      case "coin":
        this.arp([784, 988, 1319], 0.055, "square", 0.14);
        break;
      case "elixir":
        this.arp([392, 523, 659], 0.07, "sine", 0.3);
        this.tone({ freq: 1200, to: 400, dur: 0.18, type: "sine", vol: 0.08 });
        break;
      case "train":
        this.tone({ freq: 330, to: 494, dur: 0.1, type: "triangle", vol: 0.3 });
        this.tone({ freq: 494, to: 659, dur: 0.08, type: "triangle", vol: 0.24, delay: 0.09 });
        break;
      case "deploy":
        this.tone({ freq: 500, to: 300, dur: 0.09, type: "triangle", vol: 0.35 });
        this.noise(0.04, 2400, 0.12);
        break;
      case "arrow":
        this.noise(0.09, 3200, 0.18);
        break;
      case "shot":
        this.tone({ freq: 150, to: 70, dur: 0.12, type: "triangle", vol: 0.3 });
        this.noise(0.08, 700, 0.2);
        break;
      case "boom":
        this.tone({ freq: 110, to: 40, dur: 0.35, type: "sine", vol: 0.7 });
        this.noise(0.3, 500, 0.5);
        break;
      case "bigboom":
        this.tone({ freq: 90, to: 30, dur: 0.8, type: "sine", vol: 0.9 });
        this.noise(0.7, 350, 0.7);
        this.noise(0.25, 2000, 0.3);
        break;
      case "star":
        this.arp([880, 1109, 1319, 1760], 0.07, "triangle", 0.26);
        break;
      case "victory":
        this.arp([523, 659, 784, 1047, 784, 1047], 0.13, "triangle", 0.3);
        this.tone({ freq: 262, dur: 0.9, type: "triangle", vol: 0.12, delay: 0.2 });
        break;
      case "defeat":
        this.tone({ freq: 392, to: 370, dur: 0.3, type: "triangle", vol: 0.24 });
        this.tone({ freq: 330, to: 311, dur: 0.32, type: "triangle", vol: 0.24, delay: 0.3 });
        this.tone({ freq: 262, to: 233, dur: 0.6, type: "triangle", vol: 0.24, delay: 0.62 });
        break;
    }
  }

  // ---- generative background music ---------------------------------------

  music(mode: MusicMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.beat = 0;
    if (this.musicTimer !== null) {
      window.clearInterval(this.musicTimer);
      this.musicTimer = null;
    }
    if (mode && this.ctx) this.startScheduler();
  }

  private startScheduler(): void {
    if (this.musicTimer !== null) return;
    // one scheduling tick per musical 8th note
    const step = () => {
      if (!this.ctx || this._muted || !this.mode) return;
      this.scheduleBeat(this.beat++);
    };
    step();
    this.musicTimer = window.setInterval(step, this.mode === "battle" ? 250 : 320);
  }

  /** village: warm slow pads + sparse pentatonic plucks.
   *  battle: minor drone, drums and urgent plucks. */
  private scheduleBeat(b: number): void {
    const battle = this.mode === "battle";
    // chord roots: I vi IV V (major) / i VI III VII (minor-ish) — as Hz
    const prog = battle ? [220, 174.6, 130.8, 196] : [261.6, 220, 174.6, 196];
    const bar = Math.floor(b / 8) % prog.length;
    const root = prog[bar];

    // pad chord at the start of each bar
    if (b % 8 === 0) {
      const third = root * (battle ? 1.189 : 1.26); // minor vs major third
      const fifth = root * 1.5;
      for (const f of [root, third, fifth]) {
        this.pad(f, battle ? 2.0 : 2.7, battle ? 0.05 : 0.06);
      }
    }
    // pluck melody: pentatonic over the root
    const scale = battle ? [1, 1.189, 1.335, 1.5, 1.782] : [1, 1.125, 1.26, 1.5, 1.682];
    if ((battle && b % 2 === 0) || (!battle && this.rand(b) < 0.4)) {
      const n = scale[Math.floor(this.rand(b * 7 + 1) * scale.length)];
      const oct = this.rand(b * 3 + 2) < 0.3 ? 4 : 2;
      this.pluck(root * n * oct, battle ? 0.05 : 0.055);
    }
    // battle percussion
    if (battle) {
      if (b % 4 === 0) this.kick();
      if (b % 4 === 2) this.noiseAt(0.05, 5000, 0.05); // hat
    }
  }

  private rand(n: number): number {
    const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  }

  private pad(freq: number, dur: number, vol: number): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    for (const detune of [-6, 6]) {
      const o = ctx.createOscillator();
      o.type = "triangle";
      o.frequency.value = freq;
      o.detune.value = detune;
      const f = ctx.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.value = 900;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vol, t + dur * 0.3);
      g.gain.linearRampToValueAtTime(0, t + dur);
      o.connect(f).connect(g).connect(this.musicBus!);
      o.start(t);
      o.stop(t + dur);
    }
  }

  private pluck(freq: number, vol: number): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = "triangle";
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    o.connect(g).connect(this.musicBus!);
    o.start(t);
    o.stop(t + 0.5);
  }

  private kick(): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(130, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.16, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    o.connect(g).connect(this.musicBus!);
    o.start(t);
    o.stop(t + 0.18);
  }

  private noiseAt(dur: number, cutoff: number, vol: number): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const src = this.noiseSource(dur);
    const f = ctx.createBiquadFilter();
    f.type = "highpass";
    f.frequency.value = cutoff;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.musicBus!);
    src.start(t);
  }

  // ---- synth primitives ----------------------------------------------------

  private tone(o: ToneOpts): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime + (o.delay ?? 0);
    const osc = ctx.createOscillator();
    osc.type = o.type ?? "sine";
    osc.frequency.setValueAtTime(o.freq, t);
    if (o.to && o.to !== o.freq) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.to), t + o.dur);
    const g = ctx.createGain();
    const vol = o.vol ?? 0.3;
    const attack = o.attack ?? 0.005;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
    osc.connect(g).connect(this.master!);
    osc.start(t);
    osc.stop(t + o.dur + 0.02);
  }

  private arp(freqs: number[], step: number, type: OscillatorType, vol: number): void {
    freqs.forEach((f, i) => this.tone({ freq: f, dur: step * 2.2, type, vol, delay: i * step }));
  }

  private noiseSource(dur: number): AudioBufferSourceNode {
    const ctx = this.ctx!;
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    return src;
  }

  private noise(dur: number, cutoff: number, vol: number, delay = 0): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime + delay;
    const src = this.noiseSource(dur);
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.setValueAtTime(cutoff, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(60, cutoff * 0.25), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master!);
    src.start(t);
  }
}

export const sound = new Sound();
