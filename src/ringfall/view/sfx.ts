import type { EnemyKind, HealKind, Rarity, WeaponKind } from "../sim/config";
import { getMixer, hiss, play, tone, vary, type P3, type VoiceOpts } from "./audio";

/*
 * Every cue in the game. The fight should read by ear: body hits tick, weak-point
 * hits "dink" high, shields crack like glass, kills punch low, every enemy wind-up
 * whines before it fires, and enemy sounds come from where they happen.
 * The player's own sounds are centred; everything a robot, the teammate or the
 * world does is positional (`pos`).
 */

const room = () => getMixer()?.room ?? 0;
const duck = (depth: number, hold: number) => getMixer()?.duck(depth, hold);

const own = (level: number, body: () => void, send = 0.12) => play({ bus: "weapons", level, send }, body);
const ui = (level: number, body: () => void) => play({ bus: "ui", level, send: 0.04 }, body);
const me = (level: number, body: () => void, send = 0.1) => play({ bus: "world", level, send }, body);
const at = (pos: P3, o: Partial<VoiceOpts>, body: () => void) => play({ bus: "world", level: 0.5, ref: 5, ...o, pos }, body);

// --- guns: a mechanical click, a body thump, a high crack and a tail that rings
// out further in the open than under a roof.

interface GunSound {
  click: number;
  body: [number, number, number, number]; // from Hz, to Hz, seconds, volume
  crack: [number, number, number, number, number]; // from Hz, to Hz, seconds, volume, Q
  ring?: [number, number, number, number]; // sawtooth bite: from, to, seconds, volume
  boom?: [number, number, number]; // brown-noise boom: cutoff, seconds, volume
  tail: [number, number]; // seconds, volume in the open
  echoes: number[]; // seconds after the shot, open air only
  vary: number;
  cycle?: (t: number) => void; // pump or bolt after the shot
}

const GUNS: Record<WeaponKind, GunSound> = {
  pike: { click: 0.08, body: [160, 55, 0.09, 0.6], crack: [3400, 900, 0.07, 0.55, 0.7], ring: [900, 220, 0.035, 0.06], tail: [0.4, 0.1], echoes: [0.28], vary: 0.05 },
  hornet: { click: 0.07, body: [230, 90, 0.05, 0.5], crack: [4400, 1500, 0.045, 0.55, 0.8], ring: [1300, 400, 0.025, 0.04], tail: [0.2, 0.05], echoes: [], vary: 0.08 },
  maul: {
    click: 0.08,
    body: [100, 34, 0.3, 0.75],
    crack: [1900, 320, 0.13, 0.36, 0.5],
    boom: [700, 0.4, 0.6],
    tail: [0.8, 0.16],
    echoes: [0.3, 0.62],
    vary: 0.06,
    cycle: (t) => {
      hiss(0.05, { freq: 1800, q: 3, vol: 0.14, at: t });
      hiss(0.06, { freq: 1200, q: 3, vol: 0.16, at: t + 0.13 });
      tone(240, 0.05, { type: "square", vol: 0.04, at: t + 0.13, to: 160 });
    },
  },
  lance: { click: 0.08, body: [85, 40, 0.18, 0.55], crack: [5400, 900, 0.12, 0.5, 1], ring: [440, 110, 0.12, 0.12], tail: [0.7, 0.14], echoes: [0.27, 0.6], vary: 0.04 },
  talon: {
    click: 0.09,
    body: [62, 26, 0.45, 0.85],
    crack: [6200, 420, 0.2, 0.6, 0.9],
    ring: [320, 60, 0.2, 0.16],
    boom: [500, 0.6, 0.6],
    tail: [1.3, 0.2],
    echoes: [0.34, 0.74, 1.2],
    vary: 0.03,
    cycle: (t) => {
      hiss(0.04, { freq: 2600, q: 4, vol: 0.14, at: t });
      hiss(0.05, { freq: 1700, q: 3, vol: 0.13, at: t + 0.16 });
      hiss(0.03, { freq: 3400, q: 5, vol: 0.15, at: t + 0.32 });
    },
  },
};

function gun(g: GunSound) {
  const k = vary(1, g.vary);
  const open = 1 - room();
  hiss(0.012, { freq: 6500 * k, q: 2, vol: g.click, type: "bandpass" });
  tone(g.body[0] * k, g.body[2], { type: "sine", to: g.body[1], vol: g.body[3] });
  hiss(g.crack[2], { freq: g.crack[0] * k, to: g.crack[1], vol: g.crack[3], q: g.crack[4] });
  if (g.ring) tone(g.ring[0] * k, g.ring[2], { type: "sawtooth", to: g.ring[1], vol: g.ring[3] });
  if (g.boom) hiss(g.boom[1], { brown: true, type: "lowpass", freq: g.boom[0], to: 60, vol: g.boom[2], q: 0.4 });
  // The tail: longer and louder outside, a short slap indoors.
  hiss(g.tail[0] * (0.4 + 0.6 * open), { type: "lowpass", freq: 1400 * k, to: 220, vol: g.tail[1] * (0.4 + 0.6 * open), attack: 0.02, q: 0.5, at: 0.02 });
  g.echoes.forEach((t, i) => {
    if (open < 0.3) return;
    hiss(0.18 + i * 0.06, { type: "lowpass", freq: 900 / (1 + i * 0.6), to: 200, vol: (0.11 * open) / (1 + i), attack: 0.01, at: t + Math.random() * 0.03 });
  });
  g.cycle?.(0.45);
}

const RELOAD: Record<WeaponKind, "mag" | "shells" | "bolt"> = { pike: "mag", hornet: "mag", lance: "mag", maul: "shells", talon: "bolt" };

const latch = (at: number, freq: number, vol = 0.16) => {
  hiss(0.03, { freq, q: 5, vol, at });
  tone(freq * 0.4, 0.03, { type: "square", vol: vol * 0.25, at });
};

/** The enemy's plasma bolt, by kind. */
const BOLT: Record<EnemyKind, [number, number]> = { drone: [760, 380], grunt: [540, 250], charger: [400, 200], heavy: [300, 130], titan: [200, 80] };

export const sfx = {
  shot(kind: WeaponKind) {
    own(kind === "talon" ? 1 : kind === "hornet" ? 0.5 : 0.8, () => gun(GUNS[kind]), kind === "talon" || kind === "lance" ? 0.35 : 0.2);
  },
  hit(crit: boolean, shield: boolean, flank = false, plate = false) {
    ui(0.4, () => {
      // A hit from behind rings a little brighter on top of the usual sound.
      if (flank) tone(1760, 0.07, { type: "triangle", vol: 0.2, to: 2640 });
      if (crit) {
        tone(vary(2350, 0.02), 0.13, { type: "sine", vol: 0.45 });
        tone(3520, 0.09, { type: "sine", vol: 0.2, at: 0.008 });
        tone(4700, 0.04, { type: "triangle", vol: 0.1 });
        hiss(0.02, { freq: 6000, q: 2, vol: 0.3 });
      } else if (plate) {
        // A plate turning the round aside: a high metallic ping, partials out of tune with each
        // other, and the round whining off, in place of the body hit's bright tick.
        const f = vary(3100, 0.05);
        tone(f, 0.16, { type: "sine", vol: 0.26 });
        tone(f * 1.47, 0.11, { type: "sine", vol: 0.14 });
        tone(f * 2.13, 0.07, { type: "sine", vol: 0.08 });
        tone(vary(5200, 0.06), 0.14, { type: "triangle", vol: 0.05, to: 2200, at: 0.02 });
        hiss(0.02, { freq: 7000, q: 3, vol: 0.35 });
      } else if (shield) {
        tone(vary(1250, 0.04), 0.05, { type: "square", vol: 0.2, to: 900 });
        tone(vary(2900, 0.04), 0.04, { type: "triangle", vol: 0.3, to: 2200 });
        hiss(0.035, { freq: 6500, q: 2, vol: 0.6 });
      } else {
        tone(vary(1900, 0.04), 0.045, { type: "triangle", vol: 0.4, to: 1300 });
        hiss(0.045, { freq: vary(2600, 0.06), vol: 0.7, q: 1.5 });
        tone(vary(620, 0.05), 0.035, { type: "square", vol: 0.12, to: 300 });
      }
    });
  },
  shieldBreak(tier: Rarity) {
    duck(0.35, 0.15);
    ui(0.6, () => {
      const base = [1500, 1800, 2100, 2500][tier];
      hiss(0.35, { freq: 5200, to: 2400, vol: 0.3, q: 1.5 });
      hiss(0.08, { type: "highpass", freq: 3000, vol: 0.22 });
      for (let i = 0; i < 6; i++) tone(base * (1 + i * 0.37 + Math.random() * 0.08), 0.12 + i * 0.05, { type: "sine", vol: 0.06, at: i * 0.017 + Math.random() * 0.01 });
      // Shards tinkling down.
      for (let i = 0; i < 5; i++) tone(vary(base * 2.2, 0.25), 0.05, { type: "sine", vol: 0.03, at: 0.1 + Math.random() * 0.3 });
    });
  },
  /** A plate cracking and falling off a robot (rarity colour `tier`): a crack, then plates clattering down. */
  plateBreak(tier: Rarity) {
    ui(0.55, () => {
      const base = [900, 1000, 1150, 1300][tier];
      hiss(0.06, { type: "highpass", freq: 2500, vol: 0.35 });
      tone(vary(base, 0.04), 0.1, { type: "square", vol: 0.1, to: base * 0.6 });
      tone(vary(base * 2.7, 0.04), 0.14, { type: "sine", vol: 0.12 });
      // The pieces hit the ground a moment later.
      for (let i = 0; i < 3; i++) tone(vary(base * 1.9, 0.12), 0.05, { type: "triangle", vol: 0.06, at: 0.16 + i * 0.07 });
      hiss(0.05, { brown: true, type: "lowpass", freq: 900, vol: 0.2, at: 0.18 });
    });
  },
  kill(crit: boolean) {
    duck(0.45, 0.25);
    own(0.7, () => {
      tone(120, 0.26, { type: "sine", to: 40, vol: 0.55 });
      hiss(0.22, { brown: true, type: "lowpass", freq: 900, to: 100, vol: 0.45 });
      hiss(0.12, { freq: 1500, to: 400, vol: 0.18 });
      tone(700, 0.35, { type: "sawtooth", to: 70, vol: 0.05, at: 0.03 });
    });
    // The confirm: a rising two-note chime heard over any gunfire, unlike every hit sound, so a
    // kill is known without looking. A weak-point kill adds a third, higher note.
    ui(0.55, () => {
      tone(1318, 0.09, { type: "triangle", vol: 0.32, at: 0.04 });
      tone(1976, 0.2, { type: "triangle", vol: 0.3, at: 0.11 });
      tone(3952, 0.12, { type: "sine", vol: 0.06, at: 0.11 });
      if (crit) tone(2637, 0.22, { type: "triangle", vol: 0.22, at: 0.18 });
    });
  },
  /** A robot's wreck hitting the ground where it fell: struck steel and a scrape. */
  collapse(pos: P3, big: boolean) {
    at(pos, { level: big ? 0.4 : 0.3, ref: big ? 9 : 6 }, () => {
      const t = 0.42;
      tone(vary(big ? 70 : 110, 0.05), 0.2, { type: "sine", to: 40, vol: 0.08, at: t });
      tone(vary(big ? 380 : 610, 0.05), 0.16, { type: "square", vol: 0.015, to: big ? 300 : 470, at: t });
      tone(vary(1450, 0.04), 0.22, { type: "sine", vol: 0.025, at: t + 0.01 });
      hiss(0.3, { type: "bandpass", freq: 2400, to: 900, q: 1.2, vol: 0.035, at: t + 0.03 });
    });
  },
  /** A robot reeling from damage: servos grinding down; a lost wind-up also fizzles out. */
  stagger(pos: P3 | undefined, interrupted: boolean) {
    const body = () => {
      tone(vary(520, 0.05), 0.18, { type: "square", vol: 0.13, to: 180 });
      hiss(0.12, { type: "bandpass", freq: 1800, to: 700, q: 2, vol: 0.32 });
      if (interrupted) tone(vary(1500, 0.03), 0.16, { type: "sawtooth", vol: 0.08, to: 300, at: 0.02 });
    };
    if (pos) at(pos, { level: 0.5, ref: 7 }, body);
    else ui(0.4, body);
  },
  hurt(shield: boolean) {
    me(0.5, () => {
      if (shield) {
        tone(520, 0.1, { type: "square", vol: 0.22, to: 300 });
        hiss(0.07, { freq: 4200, q: 1.5, vol: 0.35 });
      } else {
        tone(110, 0.16, { type: "sawtooth", vol: 0.4, to: 55 });
        hiss(0.12, { brown: true, type: "lowpass", freq: 500, vol: 0.9 });
      }
      hiss(0.08, { freq: 400, vol: 0.4 });
    });
  },
  myShieldBreak() {
    duck(0.5, 0.3);
    me(0.8, () => {
      hiss(0.45, { freq: 3800, to: 900, vol: 0.38, q: 1.2 });
      for (let i = 0; i < 4; i++) tone(vary(1700 + i * 520, 0.05), 0.2, { type: "sine", vol: 0.05, at: i * 0.02 });
      tone(880, 0.35, { type: "sine", to: 300, vol: 0.16 });
    });
  },
  dry(kind: WeaponKind = "pike") {
    own(0.2, () => {
      const r = RELOAD[kind];
      hiss(0.025, { freq: r === "bolt" ? 2600 : r === "shells" ? 1600 : 3600, q: 2, vol: 0.8 });
      tone(r === "shells" ? 900 : 1900, 0.025, { type: "square", vol: 0.22 });
    });
  },
  reload(time: number, kind: WeaponKind = "pike") {
    own(0.3, () => {
      const r = RELOAD[kind];
      if (r === "mag") {
        latch(0.02, 2800);
        hiss(0.08, { freq: 900, q: 2, vol: 0.1, at: 0.06 }); // the mag slides out
        latch(time * 0.55, 1900, 0.2); // in
        tone(140, 0.05, { type: "sine", vol: 0.12, at: time * 0.55 });
      } else if (r === "shells") {
        const n = Math.max(2, Math.round(time / 0.35));
        for (let i = 0; i < n; i++) {
          const t = 0.08 + (i * (time - 0.25)) / n;
          hiss(0.04, { freq: vary(1500, 0.08), q: 3, vol: 0.14, at: t });
          tone(vary(320, 0.05), 0.04, { type: "triangle", vol: 0.06, at: t + 0.01 });
        }
      } else {
        latch(0.04, 2400); // bolt up
        hiss(0.07, { freq: 1300, q: 3, vol: 0.1, at: 0.12 }); // back
        latch(time * 0.5, 1800, 0.18);
      }
    });
  },
  reloaded(kind: WeaponKind = "pike") {
    own(0.3, () => {
      const r = RELOAD[kind];
      if (r === "shells") {
        hiss(0.05, { freq: 1800, q: 2, vol: 0.4 });
        hiss(0.06, { freq: 1100, q: 2, vol: 0.45, at: 0.12 });
      } else {
        hiss(0.04, { freq: r === "bolt" ? 2900 : 3600, q: 3, vol: 0.45 });
        tone(1600, 0.03, { type: "square", vol: 0.12, at: 0.02 });
        hiss(0.03, { freq: 2200, q: 3, vol: 0.32, at: 0.09 });
      }
    });
  },
  slide() {
    me(0.3, () => hiss(0.55, { freq: 900, to: 300, vol: 0.17, q: 0.6, attack: 0.03 }));
  },
  jump() {
    me(0.15, () => {
      hiss(0.08, { freq: 500, vol: 0.35 });
      hiss(0.07, { brown: true, type: "lowpass", freq: 400, vol: 0.8 });
    });
  },
  mantle() {
    me(0.2, () => {
      hiss(0.12, { freq: 1100, to: 600, vol: 0.1, q: 1.5 });
      tone(90, 0.08, { type: "sine", vol: 0.15, at: 0.05 });
    });
  },
  land(speed: number) {
    me(Math.min(0.6, speed * 0.04), () => {
      tone(80, 0.12, { type: "sine", vol: Math.min(0.5, speed * 0.03), to: 45 });
      hiss(0.1, { freq: 300, vol: Math.min(0.3, speed * 0.02) });
      hiss(0.06, { freq: 2000, q: 2, vol: Math.min(0.1, speed * 0.008) });
    });
  },
  pickup(rarity: Rarity) {
    ui(0.3, () => {
      const notes = [[660, 880], [660, 990], [740, 1110, 1480], [784, 1175, 1568, 2093]][rarity];
      notes.forEach((f, i) => tone(f, 0.16, { type: "triangle", vol: 0.12, at: i * 0.055 }));
      if (rarity === 3) notes.forEach((f, i) => tone(f * 2, 0.3, { type: "sine", vol: 0.03, at: 0.2 + i * 0.04 }));
    });
  },
  shard() {
    ui(0.1, () => tone(vary(2000, 0.08), 0.06, { type: "sine", vol: 0.25 }));
  },
  /** Rummaging through a bin: dry scrapes, loud enough to give the player away. */
  search() {
    me(0.25, () => {
      for (let i = 0; i < 5; i++) hiss(vary(0.18, 0.3), { freq: vary(700, 0.3), to: vary(1300, 0.2), vol: 0.1, at: i * 0.32 + Math.random() * 0.08 });
      for (let i = 0; i < 4; i++) tone(vary(240, 0.2), 0.04, { type: "square", vol: 0.025, at: 0.15 + i * 0.4 });
    });
  },
  bin() {
    ui(0.35, () => {
      hiss(0.2, { freq: 700, to: 2000, vol: 0.18 });
      tone(330, 0.2, { type: "triangle", vol: 0.12, to: 660 });
      tone(990, 0.12, { type: "triangle", vol: 0.06, at: 0.12 });
    });
  },
  /** A locked bin without its key. */
  locked() {
    ui(0.25, () => {
      tone(180, 0.08, { type: "square", vol: 0.07 });
      hiss(0.04, { freq: 1600, q: 4, vol: 0.12 });
      tone(150, 0.1, { type: "square", vol: 0.06, at: 0.1 });
    });
  },
  /** A depot switching on as the player walks up: a relay clunk, then a rising two-note chime. */
  depotOn() {
    ui(0.3, () => {
      hiss(0.05, { freq: 900, q: 3, vol: 0.14 });
      tone(110, 0.08, { type: "square", vol: 0.05, to: 80 });
      tone(587, 0.18, { type: "sine", vol: 0.12, at: 0.1 });
      tone(880, 0.3, { type: "sine", vol: 0.1, at: 0.2 });
    });
  },
  /** The bag going home from a depot: a hatch, a pneumatic whoosh away, a confirming ping. */
  deposit() {
    ui(0.35, () => {
      tone(220, 0.06, { type: "square", vol: 0.06, to: 160 });
      hiss(0.45, { freq: 600, to: 3200, q: 1.2, vol: 0.14, attack: 0.05, at: 0.06 });
      tone(1175, 0.25, { type: "triangle", vol: 0.09, at: 0.48 });
    });
  },
  tactical() {
    me(0.5, () => {
      hiss(0.25, { freq: 6000, to: 1500, vol: 0.28, q: 2 });
      tone(1800, 0.25, { type: "sawtooth", vol: 0.07, to: 300 });
      tone(2400, 0.4, { type: "sine", vol: 0.05, to: 3600, at: 0.05 });
    });
  },
  tacticalMiss() {
    ui(0.15, () => tone(300, 0.1, { type: "square", vol: 0.18 }));
  },
  ultReady() {
    ui(0.3, () => [523, 784, 1047].forEach((f, i) => tone(f, 0.2, { type: "triangle", vol: 0.12, at: i * 0.07 })));
  },
  leap() {
    duck(0.6, 0.8);
    me(0.8, () => {
      tone(90, 0.7, { type: "sawtooth", to: 520, vol: 0.16, attack: 0.02 });
      hiss(0.9, { freq: 200, to: 5000, vol: 0.28, attack: 0.03 });
      tone(55, 0.4, { type: "sine", to: 30, vol: 0.5 });
      hiss(0.3, { brown: true, type: "lowpass", freq: 600, vol: 0.4 });
    }, 0.3);
  },
  leapLand() {
    me(0.5, () => {
      hiss(0.3, { freq: 2000, to: 200, vol: 0.16 });
      tone(70, 0.25, { type: "sine", to: 35, vol: 0.4 });
    });
  },
  heal(kind: HealKind) {
    me(0.15, () => {
      if (kind === "cell" || kind === "battery") {
        const d = kind === "battery" ? 2.2 : 1.1;
        tone(400, d, { type: "sine", to: 1200, vol: 0.05, attack: 0.2 });
        tone(800, d, { type: "triangle", to: 2400, vol: 0.02, attack: 0.3, wobble: [11, 30] });
      } else {
        const d = kind === "medkit" ? 2.7 : 1.2;
        hiss(0.15, { freq: 1800, q: 2, vol: 0.08 }); // the cap
        hiss(d * 0.6, { freq: 3000, q: 1, vol: 0.03, at: 0.2, attack: 0.1 });
        tone(260, 0.06, { type: "triangle", vol: 0.05, at: d * 0.75 });
      }
    });
  },
  healDone() {
    ui(0.3, () => {
      tone(1200, 0.2, { type: "sine", vol: 0.14 });
      tone(1800, 0.25, { type: "sine", vol: 0.09, at: 0.06 });
    });
  },
  /** A robot charging a shot: a rising whine from where it stands. */
  telegraph(big: boolean, pos?: P3) {
    const body = () => {
      tone(big ? 220 : 600, big ? 0.9 : 0.5, { type: "sawtooth", to: big ? 660 : 1500, vol: big ? 0.14 : 0.08, attack: 0.1 });
      tone(big ? 110 : 300, big ? 0.9 : 0.5, { type: "square", to: big ? 330 : 750, vol: big ? 0.05 : 0.025, attack: 0.15 });
    };
    if (pos) at(pos, { level: big ? 0.6 : 0.45, ref: big ? 10 : 6 }, body);
    else me(0.4, body);
  },
  enemyFire(pos: P3, kind: EnemyKind = "grunt") {
    const [f, to] = BOLT[kind];
    at(pos, { level: 0.6, ref: 6, send: 0.35 }, () => {
      tone(vary(f, 0.05), 0.14, { type: "square", to, vol: 0.3 });
      tone(vary(f * 1.5, 0.05), 0.08, { type: "sawtooth", to: to * 1.5, vol: 0.12 });
      hiss(0.1, { freq: 2400, to: 700, q: 1, vol: 0.4 });
      tone(90, 0.08, { type: "sine", to: 50, vol: 0.3 });
    });
  },
  /**
   * Robots fighting each other far off (see FACTION): the bolt's crack dulled by the distance, a low
   * thump and a long rolling tail, carrying several hundred metres so a fight can be heard and found.
   */
  farFire(pos: P3, kind: EnemyKind = "grunt") {
    const [f] = BOLT[kind];
    at(pos, { level: 0.55, ref: 55, maxDist: 520, send: 0.5 }, () => {
      hiss(0.09, { type: "bandpass", freq: vary(f * 2.2, 0.08), to: f, q: 1.4, vol: 0.32 });
      tone(vary(120, 0.1), 0.12, { type: "sine", to: 55, vol: 0.4 });
      hiss(0.7, { type: "lowpass", brown: true, freq: 520, to: 140, vol: 0.28, attack: 0.03, at: 0.05 });
    });
  },
  lunge(pos?: P3) {
    const body = () => {
      hiss(0.3, { freq: 400, to: 1400, vol: 0.45 });
      tone(160, 0.3, { type: "sawtooth", to: 520, vol: 0.14 });
    };
    if (pos) at(pos, { level: 0.6, ref: 6 }, body);
    else me(0.4, body);
  },
  /** A robot beaming in. */
  spawn(pos?: P3) {
    const body = () => {
      tone(180, 0.5, { type: "sine", to: 720, vol: 0.12, attack: 0.15 });
      hiss(0.5, { freq: 800, to: 5000, q: 2, vol: 0.1, attack: 0.2 });
      tone(60, 0.25, { type: "sine", to: 40, vol: 0.25, at: 0.45 });
    };
    if (pos) at(pos, { level: 0.5, ref: 8, maxDist: 200 }, body);
    else me(0.3, body);
  },
  stomp(pos?: P3) {
    duck(0.6, 0.5);
    const body = () => {
      tone(55, 0.7, { type: "sine", to: 30, vol: 0.8 });
      hiss(0.6, { brown: true, freq: 300, to: 80, vol: 0.7, type: "lowpass" });
      hiss(0.25, { freq: 1200, to: 300, vol: 0.15 });
    };
    if (pos) at(pos, { level: 1, ref: 18, maxDist: 220, send: 0.4 }, body);
    else me(1, body);
  },
  /** A robot's footfall or hover nearby (soundscape.ts rate-limits these). */
  step(pos: P3, kind: EnemyKind, servo: boolean) {
    const heavy = kind === "heavy" || kind === "titan";
    at(pos, { level: heavy ? 0.3 : 0.15, ref: heavy ? 5 : 2.5, maxDist: heavy ? 40 : 22, send: 0.15 }, () => {
      if (kind === "drone") {
        tone(vary(190, 0.04), 0.4, { type: "sawtooth", vol: 0.04, wobble: [23, 40], attack: 0.1 });
        hiss(0.4, { freq: 1600, q: 3, vol: 0.03, attack: 0.1 });
        return;
      }
      const f = kind === "titan" ? 45 : kind === "heavy" ? 70 : kind === "charger" ? 120 : 95;
      tone(vary(f, 0.08), heavy ? 0.22 : 0.08, { type: "sine", to: f * 0.6, vol: heavy ? 0.5 : 0.3 });
      hiss(0.025, { freq: vary(heavy ? 1800 : 3200, 0.1), q: 3, vol: heavy ? 0.12 : 0.16 });
      if (heavy) hiss(0.18, { brown: true, type: "lowpass", freq: 400, vol: 0.3 });
      if (servo) tone(vary(kind === "charger" ? 1300 : 900, 0.1), 0.14, { type: "sawtooth", to: vary(1400, 0.1), vol: 0.025, attack: 0.03, at: 0.03 });
    });
  },
  /** A drone pack's rotors in chorus, carrying across open ground far past one drone's hover (soundscape.ts repeats it). */
  swarm(pos: P3) {
    at(pos, { level: 0.35, ref: 14, maxDist: 130, send: 0.35 }, () => {
      tone(vary(180, 0.03), 1.1, { type: "sawtooth", vol: 0.05, wobble: [19, 30], attack: 0.3 });
      tone(vary(232, 0.03), 1.1, { type: "sawtooth", vol: 0.035, wobble: [27, 25], attack: 0.35 });
      hiss(1.1, { freq: 1400, q: 2, vol: 0.04, attack: 0.35 });
    });
  },
  /** Reinforcements or raiders landing somewhere out of sight. */
  arrive(pos: P3, elite: boolean) {
    at(pos, { level: 0.8, ref: 25, maxDist: 400, send: 0.6 }, () => {
      hiss(1.1, { freq: 300, to: 3000, q: 1.5, vol: 0.25, attack: 0.6 });
      tone(elite ? 110 : 140, 1.1, { type: "sawtooth", to: elite ? 330 : 420, vol: 0.08, attack: 0.7 });
      tone(48, 0.6, { type: "sine", to: 30, vol: 0.6, at: 1 });
      hiss(0.5, { brown: true, type: "lowpass", freq: 500, to: 90, vol: 0.5, at: 1 });
    });
  },
  /** The care package falling from the sky. */
  careDrop(pos?: P3) {
    const body = () => {
      tone(900, 1.4, { type: "sine", to: 200, vol: 0.08, attack: 0.3 });
      hiss(1.4, { freq: 3000, to: 600, q: 2, vol: 0.06, attack: 0.4 });
    };
    if (pos) at(pos, { level: 0.6, ref: 30, maxDist: 400, send: 0.4 }, body);
    else me(0.4, body);
  },
  careLand(pos?: P3) {
    duck(0.4, 0.3);
    const body = () => {
      tone(70, 0.5, { type: "sine", to: 35, vol: 0.6 });
      hiss(0.5, { brown: true, type: "lowpass", freq: 600, vol: 0.5 });
      hiss(0.2, { freq: 2200, q: 3, vol: 0.12, at: 0.05 });
    };
    if (pos) at(pos, { level: 0.9, ref: 20, maxDist: 400, send: 0.5 }, body);
    else me(0.8, body);
  },
  /** The teammate's rifle: the same gun, where the teammate stands. */
  allyShot(pos: P3) {
    at(pos, { bus: "weapons", level: 0.45, ref: 6, send: 0.35 }, () => {
      hiss(0.07, { freq: vary(2000, 0.06), to: 500, vol: 0.28, q: 0.6 });
      tone(vary(140, 0.05), 0.07, { type: "sine", to: 60, vol: 0.3 });
      hiss(0.25, { type: "lowpass", freq: 1200, to: 250, vol: 0.06, at: 0.02, attack: 0.02 });
    });
  },
  /** A robot the teammate brought down. */
  wreck(pos: P3) {
    at(pos, { level: 0.5, ref: 6 }, () => {
      hiss(0.25, { brown: true, type: "lowpass", freq: 800, to: 120, vol: 0.4 });
      tone(600, 0.3, { type: "sawtooth", to: 60, vol: 0.05 });
    });
  },
  // --- alerts: centred, they are messages rather than sounds in the world
  /** A robot heard or glimpsed you and starts looking. */
  suspect() {
    ui(0.2, () => tone(660, 0.12, { type: "triangle", vol: 0.3, to: 990 }));
  },
  /** A squad spotted you: everyone in it is now fighting. */
  engage() {
    ui(0.3, () => {
      tone(880, 0.09, { type: "square", vol: 0.06 });
      tone(1320, 0.14, { type: "square", vol: 0.06, at: 0.09 });
    });
  },
  banner() {
    ui(0.3, () => {
      tone(392, 0.3, { type: "triangle", vol: 0.1 });
      tone(587, 0.4, { type: "triangle", vol: 0.1, at: 0.09 });
    });
  },
  reinforce() {
    ui(0.25, () => {
      for (let i = 0; i < 3; i++) tone(700, 0.18, { type: "square", vol: 0.045, at: i * 0.28 });
    });
  },
  /** A core's capture starts: the network's alarm, a rising two-tone wail three times over. */
  alarm() {
    ui(0.3, () => {
      for (let i = 0; i < 3; i++) {
        tone(520, 0.32, { type: "sawtooth", to: 880, vol: 0.05, at: i * 0.7 });
        tone(880, 0.3, { type: "sawtooth", to: 520, vol: 0.05, at: i * 0.7 + 0.34 });
      }
    });
  },
  /** A node taken: the network's signal dies and the camp's answers, a falling note and a bright rising pair. */
  coreTaken() {
    ui(0.3, () => {
      tone(330, 0.5, { type: "sawtooth", to: 90, vol: 0.06 });
      tone(523, 0.25, { type: "triangle", vol: 0.1, at: 0.45 });
      tone(784, 0.45, { type: "triangle", vol: 0.1, at: 0.62 });
    });
  },
  /** The raiders arrive: a low two-note horn. */
  raiders() {
    ui(0.3, () => {
      tone(147, 0.6, { type: "sawtooth", vol: 0.08 });
      tone(110, 0.9, { type: "sawtooth", vol: 0.08, at: 0.45 });
    });
  },
  allyDown() {
    ui(0.3, () => {
      tone(587, 0.25, { type: "triangle", vol: 0.12, to: 294 });
      tone(440, 0.35, { type: "triangle", vol: 0.1, to: 220, at: 0.18 });
    });
  },
  allyUp() {
    ui(0.3, () => {
      tone(523, 0.16, { type: "triangle", vol: 0.1 });
      tone(784, 0.22, { type: "triangle", vol: 0.1, at: 0.08 });
    });
  },
  down() {
    duck(0.5, 1);
    me(0.4, () => {
      tone(330, 0.6, { type: "sawtooth", to: 80, vol: 0.16 });
      hiss(0.5, { brown: true, type: "lowpass", freq: 400, vol: 0.3 });
    });
  },
  revive() {
    ui(0.3, () => [392, 523, 659].forEach((f, i) => tone(f, 0.2, { type: "triangle", vol: 0.12, at: i * 0.08 })));
  },
  victory() {
    ui(0.4, () => [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, 0.45, { type: "triangle", vol: 0.13, at: i * 0.11 })));
  },
  // --- base and results
  tab() {
    ui(0.15, () => {
      hiss(0.025, { freq: 4000, q: 2, vol: 0.6 });
      tone(880, 0.06, { type: "triangle", vol: 0.35 });
    });
  },
  click() {
    ui(0.1, () => tone(1200, 0.04, { type: "triangle", vol: 0.4 }));
  },
  buy() {
    ui(0.3, () => {
      [1568, 2093].forEach((f, i) => tone(f, 0.12, { type: "square", vol: 0.04, at: i * 0.06 }));
      for (let i = 0; i < 3; i++) hiss(0.04, { freq: vary(5200, 0.1), q: 6, vol: 0.08, at: 0.03 + i * 0.05 });
    });
  },
  sell() {
    ui(0.3, () => {
      for (let i = 0; i < 4; i++) tone(vary(2600, 0.06), 0.06, { type: "sine", vol: 0.05, at: i * 0.04 });
      tone(1047, 0.18, { type: "triangle", vol: 0.08, at: 0.12 });
    });
  },
  deliver() {
    ui(0.4, () => {
      [659, 784, 988, 1319].forEach((f, i) => tone(f, 0.22, { type: "triangle", vol: 0.11, at: i * 0.09 }));
      tone(1976, 0.5, { type: "sine", vol: 0.04, at: 0.36 });
    });
  },
  deploy() {
    ui(0.4, () => {
      hiss(0.7, { freq: 300, to: 2500, q: 1, vol: 0.12, attack: 0.3 });
      tone(196, 0.5, { type: "sawtooth", to: 392, vol: 0.05, attack: 0.2 });
      tone(784, 0.25, { type: "triangle", vol: 0.08, at: 0.5 });
    });
  },
  extracted() {
    ui(0.5, () => {
      [392, 523, 659, 784].forEach((f, i) => tone(f, 0.5, { type: "triangle", vol: 0.1, at: i * 0.12 }));
      [523, 659, 784].forEach((f) => tone(f * 2, 0.9, { type: "sine", vol: 0.04, at: 0.5 }));
    });
  },
  lost() {
    ui(0.4, () => {
      [392, 349, 311, 233].forEach((f, i) => tone(f, 0.55, { type: "triangle", vol: 0.1, at: i * 0.22, to: f * 0.97 }));
      tone(58, 1.2, { type: "sine", vol: 0.15, at: 0.66 });
    });
  },
  // --- ambience one-shots (soundscape.ts places them)
  creak(pos: P3) {
    at(pos, { bus: "amb", level: 0.12, ref: 20, maxDist: 300, send: 0.6, occluded: false }, () => {
      const f = vary(170, 0.25);
      tone(f, 1.1, { type: "sawtooth", to: f * vary(1.3, 0.1), vol: 0.035, attack: 0.3, wobble: [7, 25] });
      tone(f * 2.7, 0.8, { type: "triangle", to: f * 3.1, vol: 0.012, attack: 0.3 });
    });
  },
  machinery(pos: P3) {
    at(pos, { bus: "amb", level: 0.12, ref: 30, maxDist: 400, send: 0.7, occluded: false }, () => {
      for (let i = 0; i < 3; i++) {
        tone(vary(62, 0.05), 0.5, { type: "sawtooth", vol: 0.05, at: i * 0.6, attack: 0.1 });
        hiss(0.12, { freq: 1400, q: 4, vol: 0.03, at: i * 0.6 + 0.3 });
      }
    });
  },
  gull(pos: P3) {
    at(pos, { bus: "amb", level: 0.12, ref: 25, maxDist: 400, send: 0.5, occluded: false }, () => {
      const n = 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) {
        const f = vary(1500, 0.1);
        tone(f, 0.22, { type: "triangle", to: f * 0.62, vol: 0.03, at: i * 0.28, attack: 0.02, wobble: [30, 60] });
      }
    });
  },
};
