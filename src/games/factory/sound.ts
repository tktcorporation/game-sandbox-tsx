const AudioCtx =
  window.AudioContext ??
  (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  if (!AudioCtx) return null;
  if (!ctx) {
    try {
      ctx = new AudioCtx();
    } catch {
      return null;
    }
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

function tone(type: OscillatorType, freq: number, dur: number, gain: number, delay = 0) {
  const c = audio();
  if (!c) return;
  const t0 = c.currentTime + delay;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.008);
  g.gain.linearRampToValueAtTime(0, t0 + dur);
  osc.connect(g).connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

export const foundrySound = {
  prime() {
    audio();
  },
  click() {
    tone("square", 760, 0.04, 0.04);
  },
  place() {
    tone("triangle", 420, 0.07, 0.07);
    tone("sine", 840, 0.08, 0.04, 0.03);
  },
  error() {
    tone("square", 160, 0.12, 0.05);
  },
  export(value: number) {
    const base = 480 + Math.min(value, 50) * 6;
    tone("triangle", base, 0.08, 0.08);
    tone("sine", base * 1.5, 0.12, 0.05, 0.05);
  },
};
