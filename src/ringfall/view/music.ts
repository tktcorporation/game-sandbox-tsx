import type { Mixer } from "./audio";

/*
 * The music, synthesized like every other sound (docs/ringfall/sound.md): one piece in D minor at
 * 92 beats a minute, played as layers that fade in and out with the mood of the moment. The
 * camp and the title are a warm pad and a plucked arpeggio; the raid out on the island keeps to a
 * low pulse and a few notes, so the robots' steps and shots stay on top; an alert adds ticking
 * hats over a tense chord; a fight brings in the drums and a driving bass; a craft called for the
 * way off lifts the chords; the results end on a long chord.
 *
 * Notes are scheduled a little ahead of the audio clock, a 16th at a time. Layers change at once
 * (a fade of about a second); chords change at the next bar. Every choice that varies is a hash
 * of the bar and the step, so the same mood always plays the same way (and renders the same in
 * the sound check).
 */

export type Mood = "off" | "title" | "camp" | "explore" | "alert" | "fight" | "extract" | "result";

type Layer = "pad" | "bass" | "pluck" | "lead" | "kick" | "snare" | "hat";
const LAYERS: Layer[] = ["pad", "bass", "pluck", "lead", "kick", "snare", "hat"];

const BPM = 92;
const STEP = 60 / BPM / 4;
const AHEAD = 0.3;

/** A bar's chord: the bass's root and the pad's notes, as MIDI numbers. */
type Chord = [number, number[]];
const DM9: Chord = [38, [57, 60, 64, 65]];
const BB: Chord = [34, [57, 58, 62, 65]];
const F: Chord = [41, [57, 60, 65, 67]];
const C: Chord = [36, [55, 60, 62, 67]];
const EB: Chord = [39, [55, 58, 63, 67]];
const A: Chord = [33, [57, 61, 64, 69]];
const GM: Chord = [43, [58, 62, 65, 67]];

interface MoodDef {
  /** Each layer's level, 0..1; a layer not named is silent. */
  mix: Partial<Record<Layer, number>>;
  chords: Chord[];
  /** The bass's steps in a bar (of 16), and whether it walks up an octave between them. */
  bass: number[];
  /** The pluck's steps; each takes the next note of the chord. */
  pluck: number[];
  /** A 4-bar phrase for the lead, a step each: a scale degree of D minor's pentatonic, or null. */
  lead?: (number | null)[];
  /** The pad's filter: how bright the chords sound. */
  bright: number;
  /** The mood's loudness against the others: out on the island it keeps under the robots. */
  level: number;
}

/** The whole music's gain: it sits under the guns and the robots (sound.md, tier music). */
const MASTER = 0.07;

const PHRASE_HOME: (number | null)[] = [
  ...[4, null, null, null, 3, null, 2, null, 1, null, null, null, null, null, null, null],
  ...[2, null, null, null, 1, null, 0, null, -1, null, null, null, null, null, null, null],
  ...[4, null, null, 5, 6, null, null, null, 5, null, 4, null, 3, null, null, null],
  ...[2, null, 1, null, 2, null, null, null, null, null, null, null, null, null, null, null],
];
const PHRASE_LIFT: (number | null)[] = [
  ...[5, null, null, null, 6, null, 7, null, 6, null, null, null, 5, null, null, null],
  ...[4, null, null, null, 5, null, 4, null, 2, null, null, null, null, null, null, null],
  ...[5, null, null, null, 6, null, 7, null, 9, null, null, null, 8, null, 7, null],
  ...[6, null, null, null, 5, null, null, null, null, null, null, null, null, null, null, null],
];

const MOODS: Record<Exclude<Mood, "off">, MoodDef> = {
  title: { mix: { pad: 0.8, bass: 0.5, pluck: 0.55, lead: 0.5 }, chords: [DM9, BB, F, C], bass: [0, 10], pluck: [0, 3, 6, 8, 11, 14], lead: PHRASE_HOME, bright: 1400, level: 0.9 },
  camp: { mix: { pad: 0.7, bass: 0.5, pluck: 0.6 }, chords: [DM9, BB, F, C], bass: [0, 10], pluck: [0, 3, 6, 8, 11, 14], bright: 1200, level: 0.9 },
  explore: { mix: { pad: 0.45, bass: 0.6, pluck: 0.35 }, chords: [DM9, DM9, BB, C], bass: [0, 6, 8, 14], pluck: [0, 10], bright: 700, level: 0.27 },
  alert: { mix: { pad: 0.5, bass: 0.7, pluck: 0.3, hat: 0.5 }, chords: [DM9, EB, DM9, C], bass: [0, 2, 4, 6, 8, 10, 12, 14], pluck: [0, 6, 12], bright: 900, level: 0.7 },
  fight: { mix: { pad: 0.45, bass: 0.85, pluck: 0.45, kick: 0.9, snare: 0.7, hat: 0.6 }, chords: [DM9, BB, C, A], bass: [0, 2, 3, 6, 8, 10, 11, 14], pluck: [0, 3, 6, 8, 11, 14], bright: 1100, level: 0.5 },
  extract: { mix: { pad: 0.7, bass: 0.7, pluck: 0.55, lead: 0.45, kick: 0.5, hat: 0.4 }, chords: [F, C, DM9, BB], bass: [0, 4, 8, 12], pluck: [0, 2, 4, 6, 8, 10, 12, 14], lead: PHRASE_LIFT, bright: 1600, level: 0.85 },
  result: { mix: { pad: 0.8, pluck: 0.4, bass: 0.4 }, chords: [F, GM, BB, F], bass: [0], pluck: [0, 6, 12], bright: 1000, level: 1 },
};

/** D minor pentatonic from D4, by degree (negative goes down). */
const PENTA = [0, 3, 5, 7, 10];
const degree = (d: number) => 62 + 12 * Math.floor(d / 5) + PENTA[((d % 5) + 5) % 5];
const hz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);
const hash = (a: number, b: number) => {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 15;
  return ((Math.imul(h, 0x27d4eb2d) >>> 0) % 1000) / 1000;
};

export class Music {
  private readonly m: Mixer;
  private readonly out: Record<Layer, GainNode>;
  private readonly master: GainNode;
  /** The pad's and the pluck's shared filters. */
  private readonly padTone: BiquadFilterNode;
  private readonly leadTone: BiquadFilterNode;
  private mood: Mood = "off";
  /** The mood whose chords the current bar plays. */
  private barMood: Exclude<Mood, "off"> = "camp";
  private bar = 0;
  private step = 0;
  private next = 0;
  private arp = 0;

  constructor(m: Mixer) {
    this.m = m;
    const ctx = m.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(m.bus("music"));
    const bus = this.master;
    this.out = Object.fromEntries(
      LAYERS.map((l) => {
        const g = ctx.createGain();
        g.gain.value = 0;
        g.connect(bus);
        return [l, g];
      }),
    ) as Record<Layer, GainNode>;
    this.padTone = ctx.createBiquadFilter();
    this.padTone.type = "lowpass";
    this.padTone.Q.value = 0.7;
    this.padTone.connect(this.out.pad);
    this.leadTone = ctx.createBiquadFilter();
    this.leadTone.type = "lowpass";
    this.leadTone.frequency.value = 2600;
    this.leadTone.connect(this.out.lead);
    // A little of the open air's reverb, after the master so it fades with the music.
    const send = ctx.createGain();
    send.gain.value = 0.2;
    this.master.connect(send).connect(m.verbIn);
  }

  /** The mood now; the layers fade to its mix, its chords start at the next bar. */
  set(mood: Mood, fade = 1.2) {
    if (mood === this.mood) return;
    const t = this.m.ctx.currentTime;
    if (this.mood === "off" && mood !== "off") {
      this.next = t + 0.05;
      this.step = 0;
      this.barMood = mood;
    }
    this.mood = mood;
    const mix = mood === "off" ? {} : MOODS[mood].mix;
    for (const l of LAYERS) this.out[l].gain.setTargetAtTime(mix[l] ?? 0, t, fade / 3);
    this.master.gain.setTargetAtTime(mood === "off" ? 0 : MASTER * MOODS[mood].level, t, fade / 3);
    if (mood !== "off") this.padTone.frequency.setTargetAtTime(MOODS[mood].bright, t, fade);
  }

  get current(): Mood {
    return this.mood;
  }

  /** Schedules the notes due before `until` on the audio clock (now plus a little, by default). */
  schedule(until = this.m.ctx.currentTime + AHEAD) {
    if (this.mood === "off") return;
    // After a stall (a hidden tab), start again from now rather than catching up.
    if (this.next < this.m.ctx.currentTime - 0.1) this.next = this.m.ctx.currentTime + 0.05;
    while (this.next < until) {
      this.play(this.step, this.next);
      this.next += STEP;
      this.step = (this.step + 1) % 16;
      if (this.step === 0) this.bar++;
    }
  }

  private on(l: Layer): boolean {
    if (this.mood === "off") return false;
    return (MOODS[this.mood].mix[l] ?? 0) > 0 || this.out[l].gain.value > 0.01;
  }

  private play(step: number, t: number) {
    if (step === 0) this.barMood = this.mood === "off" ? this.barMood : this.mood;
    const def = MOODS[this.barMood];
    const [root, notes] = def.chords[this.bar % def.chords.length];
    const bar = STEP * 16;
    if (step === 0 && this.on("pad")) for (const n of notes) this.pad(hz(n), t, bar);
    if (this.on("bass") && def.bass.includes(step)) {
      const up = def.bass.length > 4 && step % 4 === 2 && hash(this.bar, step) > 0.5;
      this.bass(hz(root + (up ? 12 : 0)), t, def.bass.length > 4 ? STEP * 1.6 : STEP * 5);
    }
    if (this.on("pluck") && def.pluck.includes(step) && (def.pluck.length > 2 || hash(this.bar, step) > 0.3)) {
      const n = notes[this.arp++ % notes.length] + 12;
      this.pluck(hz(n), t, 0.6 + 0.4 * hash(step, this.bar));
    }
    if (def.lead && this.on("lead")) {
      const d = def.lead[(this.bar % 4) * 16 + step];
      if (d !== null && d !== undefined) this.lead(hz(degree(d)), t, STEP * 3);
    }
    if (this.on("kick") && (this.barMood === "fight" ? [0, 6, 8].includes(step) : step % 8 === 0)) this.kick(t);
    if (this.on("snare") && (step === 4 || step === 12)) this.snare(t);
    if (this.on("hat") && (this.barMood === "fight" ? step % 2 === 0 || hash(this.bar, step) > 0.7 : step % 4 === 2)) this.hat(t, step % 4 === 2 ? 1 : 0.55);
  }

  private env(g: GainNode, t: number, vol: number, attack: number, hold: number, release: number) {
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + attack);
    g.gain.setValueAtTime(vol, t + attack + hold);
    g.gain.setTargetAtTime(0, t + attack + hold, release / 3);
  }

  private osc(type: OscillatorType, f: number, t: number, len: number, to: AudioNode, vol: number, attack: number, release: number, detune = 0) {
    const ctx = this.m.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.value = f;
    o.detune.value = detune;
    this.env(g, t, vol, attack, Math.max(0, len - attack), release);
    o.connect(g).connect(to);
    o.start(t);
    o.stop(t + len + release * 2);
  }

  private pad(f: number, t: number, len: number) {
    this.osc("sawtooth", f, t, len, this.padTone, 0.03, 0.5, 0.9, -7);
    this.osc("sawtooth", f, t, len, this.padTone, 0.03, 0.5, 0.9, 7);
  }

  private bass(f: number, t: number, len: number) {
    this.osc("sine", f, t, len, this.out.bass, 0.32, 0.01, 0.12);
    this.osc("triangle", f * 2, t, len * 0.7, this.out.bass, 0.08, 0.01, 0.08);
  }

  private pluck(f: number, t: number, vel: number) {
    this.osc("triangle", f, t, 0.02, this.out.pluck, 0.13 * vel, 0.004, 0.35);
    this.osc("sine", f * 2, t, 0.01, this.out.pluck, 0.04 * vel, 0.003, 0.18);
  }

  private lead(f: number, t: number, len: number) {
    this.osc("triangle", f, t, len, this.leadTone, 0.09, 0.03, 0.3);
    this.osc("square", f, t, len, this.leadTone, 0.018, 0.03, 0.25, 4);
  }

  private kick(t: number) {
    const ctx = this.m.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.14);
    this.env(g, t, 0.5, 0.003, 0.02, 0.22);
    o.connect(g).connect(this.out.kick);
    o.start(t);
    o.stop(t + 0.5);
  }

  private noise(t: number, len: number, type: BiquadFilterType, freq: number, vol: number, to: AudioNode) {
    const ctx = this.m.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.m.noise;
    src.loopStart = 0;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = ctx.createGain();
    this.env(g, t, vol, 0.002, 0, len);
    src.connect(f).connect(g).connect(to);
    src.start(t, hash(t * 1000, 7) * 3);
    src.stop(t + len * 2 + 0.05);
  }

  private snare(t: number) {
    this.noise(t, 0.16, "bandpass", 1900, 0.32, this.out.snare);
    this.osc("triangle", 190, t, 0.02, this.out.snare, 0.14, 0.002, 0.08);
  }

  private hat(t: number, accent: number) {
    this.noise(t, 0.04, "highpass", 7500, 0.12 * accent, this.out.hat);
  }
}
