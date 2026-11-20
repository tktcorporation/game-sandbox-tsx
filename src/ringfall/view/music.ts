import type { RegionId } from "../sim/map";
import type { Mixer } from "./audio";

/*
 * The music, synthesized like every other sound (docs/ringfall/sound.md). Two things set it:
 *
 * - the mood of the moment, which sets which layers play: the camp and the title a warm pad and a
 *   plucked arpeggio; the raid out on the island a low pulse and a few notes, so the robots' steps
 *   and shots stay on top; an alert ticking hats over a tense chord; a fight the drums and a
 *   driving bass; a craft called for the way off a lifted progression; the results a long chord;
 * - the region the player is in, which sets the tune itself: its tempo, its key and chords, and
 *   the colour of its pad and its plucked notes. The reservoir's dry lakebed in D minor; the
 *   harbor slower in A minor with a buoy's bell; the machine city faster in E Phrygian on a
 *   ticking square-wave sequence; the launch site in G Lydian, wide and bright, glassy high notes.
 *
 * Notes are scheduled a little ahead of the audio clock, a 16th at a time. Layers fade at once
 * (about a second); a new region's tune and a new mood's chords start at the next bar. Every
 * choice that varies is a hash of the bar and the step, so a mood in a region always plays the
 * same way (and renders the same in the sound check).
 */

export type Mood = "off" | "title" | "camp" | "explore" | "alert" | "fight" | "extract" | "result";
type On = Exclude<Mood, "off">;

type Layer = "pad" | "bass" | "pluck" | "lead" | "kick" | "snare" | "hat";
const LAYERS: Layer[] = ["pad", "bass", "pluck", "lead", "kick", "snare", "hat"];
const AHEAD = 0.3;

/** A bar's chord: the bass's root and the pad's notes, as MIDI numbers. */
type Chord = [number, number[]];
/** What a mood asks of a region's chords. */
type Role = "home" | "roam" | "tense" | "fight" | "lift" | "rest";

interface Tune {
  bpm: number;
  chords: Record<Role, Chord[]>;
  /** The lead's scale from its tonic (MIDI), in semitones. */
  tonic: number;
  scale: number[];
  pad: OscillatorType;
  /** The pad's filter against the mood's: darker below 1, brighter above. */
  bright: number;
  /** How a plucked note sounds: a soft pluck, a buoy's bell, a square-wave tick, a glassy chime. */
  pluck: "pluck" | "bell" | "tick" | "glass";
  /** Out on the island, the pluck plays these steps instead of the mood's (the city's sequence). */
  roamPluck?: number[];
  /** Out on the island, its loudness against the reservoir's: a sparse tune is lifted to match. */
  roamLevel?: number;
}

// The reservoir: D minor.
const DM9: Chord = [38, [57, 60, 64, 65]];
const BB: Chord = [34, [57, 58, 62, 65]];
const F: Chord = [41, [57, 60, 65, 67]];
const C: Chord = [36, [55, 60, 62, 67]];
const EB: Chord = [39, [55, 58, 63, 67]];
const A: Chord = [33, [57, 61, 64, 69]];
const GM: Chord = [43, [58, 62, 65, 67]];
// The harbor: A minor.
const AM9: Chord = [33, [55, 60, 64, 71]];
const FM7: Chord = [29, [57, 60, 64, 65]];
const DM: Chord = [38, [57, 62, 65, 69]];
const EM: Chord = [40, [55, 59, 64, 67]];
const BBH: Chord = [34, [58, 62, 65, 70]];
const E: Chord = [40, [56, 59, 64, 68]];
const G: Chord = [43, [55, 59, 62, 67]];
const CM7: Chord = [36, [55, 59, 64, 67]];
// The machine city: E Phrygian.
const FP: Chord = [41, [57, 60, 64, 65]];
const D: Chord = [38, [57, 62, 66, 69]];
const B: Chord = [35, [54, 59, 63, 66]];
const CC: Chord = [36, [55, 60, 64, 67]];
// The launch site: G Lydian.
const GMA7: Chord = [43, [59, 62, 66, 69]];
const AOG: Chord = [43, [57, 61, 64, 66]];
const EM7: Chord = [40, [59, 62, 64, 67]];
const DADD9: Chord = [38, [57, 62, 64, 66]];
const CLYD: Chord = [36, [59, 62, 64, 67]];

const TUNES: Record<RegionId, Tune> = {
  reservoir: {
    bpm: 92,
    chords: { home: [DM9, BB, F, C], roam: [DM9, DM9, BB, C], tense: [DM9, EB, DM9, C], fight: [DM9, BB, C, A], lift: [F, C, DM9, BB], rest: [F, GM, BB, F] },
    tonic: 62,
    scale: [0, 3, 5, 7, 10],
    pad: "sawtooth",
    bright: 1,
    pluck: "pluck",
  },
  harbor: {
    bpm: 84,
    chords: { home: [AM9, FM7, DM, EM], roam: [AM9, AM9, FM7, EM], tense: [AM9, BBH, AM9, EM], fight: [AM9, FM7, G, E], lift: [CM7, G, AM9, FM7], rest: [FM7, G, AM9, AM9] },
    tonic: 69,
    scale: [0, 3, 5, 7, 10],
    pad: "triangle",
    bright: 0.75,
    pluck: "bell",
    roamLevel: 1.4,
  },
  city: {
    bpm: 104,
    chords: { home: [EM, FP, EM, D], roam: [EM, EM, FP, EM], tense: [EM, FP, EM, FP], fight: [EM, CC, D, B], lift: [G, D, EM, CC], rest: [CC, D, EM, EM] },
    tonic: 64,
    scale: [0, 1, 3, 7, 8],
    pad: "sawtooth",
    bright: 0.85,
    pluck: "tick",
    roamPluck: [0, 2, 4, 6, 8, 10, 12, 14],
  },
  launch: {
    bpm: 88,
    chords: { home: [GMA7, AOG, EM7, DADD9], roam: [GMA7, AOG, GMA7, AOG], tense: [EM7, CLYD, EM7, DADD9], fight: [EM7, CLYD, DADD9, B], lift: [GMA7, DADD9, EM7, CLYD], rest: [CLYD, DADD9, GMA7, GMA7] },
    tonic: 67,
    scale: [0, 2, 4, 7, 9],
    pad: "sawtooth",
    bright: 1.25,
    pluck: "glass",
    roamLevel: 1.6,
  },
};

interface MoodDef {
  /** Each layer's level, 0..1; a layer not named is silent. */
  mix: Partial<Record<Layer, number>>;
  role: Role;
  /** The bass's steps in a bar (of 16). */
  bass: number[];
  /** The pluck's steps; each takes the next note of the chord. */
  pluck: number[];
  /** A 4-bar phrase for the lead, a step each: a degree of the region's scale, or null. */
  lead?: (number | null)[];
  /** The pad's filter: how bright the chords sound. */
  bright: number;
  /** The mood's loudness against the others: out on the island it keeps under the robots. */
  level: number;
}

/** The whole music's gain: it sits under the guns and the robots (sound.md, tier music). */
const MASTER = 0.07;
/** The short phrases' gain: over the explore's pulse, under the core's own cue. */
const STING = 0.09;

const _ = null;
const PHRASE_HOME: (number | null)[] = [
  ...[4, _, _, _, 3, _, 2, _, 1, _, _, _, _, _, _, _],
  ...[2, _, _, _, 1, _, 0, _, -1, _, _, _, _, _, _, _],
  ...[4, _, _, 5, 6, _, _, _, 5, _, 4, _, 3, _, _, _],
  ...[2, _, 1, _, 2, _, _, _, _, _, _, _, _, _, _, _],
];
const PHRASE_LIFT: (number | null)[] = [
  ...[5, _, _, _, 6, _, 7, _, 6, _, _, _, 5, _, _, _],
  ...[4, _, _, _, 5, _, 4, _, 2, _, _, _, _, _, _, _],
  ...[5, _, _, _, 6, _, 7, _, 9, _, _, _, 8, _, 7, _],
  ...[6, _, _, _, 5, _, _, _, _, _, _, _, _, _, _, _],
];

const MOODS: Record<On, MoodDef> = {
  title: { mix: { pad: 0.8, bass: 0.5, pluck: 0.55, lead: 0.5 }, role: "home", bass: [0, 10], pluck: [0, 3, 6, 8, 11, 14], lead: PHRASE_HOME, bright: 1400, level: 0.9 },
  camp: { mix: { pad: 0.7, bass: 0.5, pluck: 0.6 }, role: "home", bass: [0, 10], pluck: [0, 3, 6, 8, 11, 14], bright: 1200, level: 0.9 },
  explore: { mix: { pad: 0.45, bass: 0.6, pluck: 0.35 }, role: "roam", bass: [0, 6, 8, 14], pluck: [0, 10], bright: 700, level: 0.27 },
  alert: { mix: { pad: 0.5, bass: 0.7, pluck: 0.3, hat: 0.5 }, role: "tense", bass: [0, 2, 4, 6, 8, 10, 12, 14], pluck: [0, 6, 12], bright: 900, level: 0.7 },
  fight: { mix: { pad: 0.45, bass: 0.85, pluck: 0.45, kick: 0.9, snare: 0.7, hat: 0.6 }, role: "fight", bass: [0, 2, 3, 6, 8, 10, 11, 14], pluck: [0, 3, 6, 8, 11, 14], bright: 1100, level: 0.5 },
  extract: { mix: { pad: 0.7, bass: 0.7, pluck: 0.55, lead: 0.45, kick: 0.5, hat: 0.4 }, role: "lift", bass: [0, 4, 8, 12], pluck: [0, 2, 4, 6, 8, 10, 12, 14], lead: PHRASE_LIFT, bright: 1600, level: 0.85 },
  result: { mix: { pad: 0.8, pluck: 0.4, bass: 0.4 }, role: "rest", bass: [0], pluck: [0, 6, 12], bright: 1000, level: 1 },
};

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
  /** The pad's and the lead's shared filters. */
  private readonly padTone: BiquadFilterNode;
  private readonly leadTone: BiquadFilterNode;
  /** The short phrases' own gain, straight to the music's bus: they sound whatever the mood's mix. */
  private readonly sting: GainNode;
  private mood: Mood = "off";
  private region: RegionId = "reservoir";
  /** The mood and the region the current bar plays. */
  private barMood: On = "camp";
  private barRegion: RegionId = "reservoir";
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
    this.out = Object.fromEntries(
      LAYERS.map((l) => {
        const g = ctx.createGain();
        g.gain.value = 0;
        g.connect(this.master);
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
    this.sting = ctx.createGain();
    this.sting.gain.value = STING;
    this.sting.connect(m.bus("music"));
  }

  /** The mood and the region now; the layers fade to the mood's mix, the tune follows at the next bar. */
  set(mood: Mood, region: RegionId = this.region, fade = 1.2) {
    if (mood === this.mood && region === this.region) return;
    const t = this.m.ctx.currentTime;
    if (this.mood === "off" && mood !== "off") {
      this.next = t + 0.05;
      this.step = 0;
      this.barMood = mood;
      this.barRegion = region;
    }
    this.mood = mood;
    this.region = region;
    const mix = mood === "off" ? {} : MOODS[mood].mix;
    for (const l of LAYERS) this.out[l].gain.setTargetAtTime(mix[l] ?? 0, t, fade / 3);
    const roam = mood !== "off" && MOODS[mood].role === "roam" ? (TUNES[region].roamLevel ?? 1) : 1;
    this.master.gain.setTargetAtTime(mood === "off" ? 0 : MASTER * MOODS[mood].level * roam, t, fade / 3);
    if (mood !== "off") this.padTone.frequency.setTargetAtTime(MOODS[mood].bright * TUNES[region].bright, t, fade);
  }

  /**
   * A short phrase in the region's key on the next beat, over whatever plays: a core taken (rising
   * to the fifth and the octave), or a raid got off alive (falling home to the tonic, held).
   */
  phrase(kind: "capture" | "home") {
    if (this.mood === "off" && kind === "capture") return;
    const tune = TUNES[this.mood === "off" ? this.region : this.barRegion];
    const beat = 60 / tune.bpm;
    const now = this.m.ctx.currentTime;
    const t0 = this.mood === "off" ? now + 0.05 : this.next + ((4 - (this.step % 4)) % 4) * (beat / 4);
    const degrees = kind === "capture" ? [0, 2, 3, 5] : [5, 4, 2, 0];
    const s = tune.scale;
    degrees.forEach((d, i) => {
      const midi = tune.tonic + 12 * Math.floor(d / s.length) + s[d % s.length];
      const len = i === degrees.length - 1 ? beat * 2 : beat / 2;
      const t = t0 + (i * beat) / 2;
      this.osc("triangle", hz(midi), t, len, this.sting, 0.1, 0.01, 0.4);
      this.osc("sine", hz(midi + 12), t, len * 0.6, this.sting, 0.035, 0.01, 0.3);
    });
    // The last note's chord under it: the tonic's fifth and the octave below.
    const last = t0 + ((degrees.length - 1) * beat) / 2;
    for (const k of [-12, -5]) this.osc("sawtooth", hz(tune.tonic + k), last, beat * 2, this.sting, 0.02, 0.05, 0.6);
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
      this.next += 60 / TUNES[this.barRegion].bpm / 4;
      this.step = (this.step + 1) % 16;
      if (this.step === 0) this.bar++;
    }
  }

  private on(l: Layer): boolean {
    if (this.mood === "off") return false;
    return (MOODS[this.mood].mix[l] ?? 0) > 0 || this.out[l].gain.value > 0.01;
  }

  private play(step: number, t: number) {
    if (step === 0 && this.mood !== "off") {
      this.barMood = this.mood;
      this.barRegion = this.region;
    }
    const def = MOODS[this.barMood];
    const tune = TUNES[this.barRegion];
    const chords = tune.chords[def.role];
    const [root, notes] = chords[this.bar % chords.length];
    const sixteenth = 60 / tune.bpm / 4;
    if (step === 0 && this.on("pad")) for (const n of notes) this.pad(tune.pad, hz(n), t, sixteenth * 16);
    if (this.on("bass") && def.bass.includes(step)) {
      const up = def.bass.length > 4 && step % 4 === 2 && hash(this.bar, step) > 0.5;
      this.bass(hz(root + (up ? 12 : 0)), t, def.bass.length > 4 ? sixteenth * 1.6 : sixteenth * 5);
    }
    const plucks = def.role === "roam" && tune.roamPluck ? tune.roamPluck : def.pluck;
    if (this.on("pluck") && plucks.includes(step) && (plucks.length > 2 || hash(this.bar, step) > 0.3)) {
      const n = notes[this.arp++ % notes.length] + 12;
      this.pluck(tune.pluck, hz(n), t, 0.6 + 0.4 * hash(step, this.bar));
    }
    if (def.lead && this.on("lead")) {
      const d = def.lead[(this.bar % 4) * 16 + step];
      if (d !== null && d !== undefined) {
        const s = tune.scale;
        const midi = tune.tonic + 12 * Math.floor(d / s.length) + s[((d % s.length) + s.length) % s.length];
        this.lead(hz(midi), t, sixteenth * 3);
      }
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

  private pad(type: OscillatorType, f: number, t: number, len: number) {
    // A triangle is far quieter than a sawtooth at the same gain.
    const vol = type === "triangle" ? 0.06 : 0.03;
    this.osc(type, f, t, len, this.padTone, vol, 0.5, 0.9, -7);
    this.osc(type, f, t, len, this.padTone, vol, 0.5, 0.9, 7);
  }

  private bass(f: number, t: number, len: number) {
    this.osc("sine", f, t, len, this.out.bass, 0.32, 0.01, 0.12);
    this.osc("triangle", f * 2, t, len * 0.7, this.out.bass, 0.08, 0.01, 0.08);
  }

  private pluck(kind: Tune["pluck"], f: number, t: number, vel: number) {
    const to = this.out.pluck;
    if (kind === "bell") {
      // A buoy's bell: a partial out of tune with the note, ringing long.
      this.osc("sine", f, t, 0.01, to, 0.1 * vel, 0.003, 1.4);
      this.osc("sine", f * 2.76, t, 0.01, to, 0.035 * vel, 0.002, 0.7);
      this.osc("sine", f * 5.4, t, 0.01, to, 0.012 * vel, 0.002, 0.3);
    } else if (kind === "tick") {
      // A square-wave tick, short and dry: a machine keeping time.
      this.osc("square", f, t, 0.01, to, 0.035 * vel, 0.002, 0.12);
      this.osc("sine", f / 2, t, 0.01, to, 0.05 * vel, 0.002, 0.1);
    } else if (kind === "glass") {
      // A glassy chime an octave up, with a high shimmer.
      this.osc("sine", f * 2, t, 0.01, to, 0.07 * vel, 0.004, 0.9);
      this.osc("sine", f * 6, t, 0.01, to, 0.015 * vel, 0.003, 0.5, 6);
    } else {
      this.osc("triangle", f, t, 0.02, to, 0.13 * vel, 0.004, 0.35);
      this.osc("sine", f * 2, t, 0.01, to, 0.04 * vel, 0.003, 0.18);
    }
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
    // The city's hats ring metallic, higher and tighter.
    const city = this.barRegion === "city";
    this.noise(t, city ? 0.03 : 0.04, city ? "bandpass" : "highpass", city ? 9500 : 7500, 0.12 * accent, this.out.hat);
  }
}
