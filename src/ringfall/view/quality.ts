/*
 * How much the renderer draws, and how it backs off when the device cannot keep up. Pure logic:
 * the World applies a tier's settings, main.ts feeds the governor its frame times. None of it
 * touches the game's rules; robots see no further than `SIGHT` (51 m at most, the titan), well inside every tier's fog.
 */

export type Tier = "high" | "medium" | "low";
export const TIERS: readonly Tier[] = ["high", "medium", "low"];
/** What the player picked in the settings: a tier, or automatic. */
export type QualityChoice = Tier | "auto";

export interface Quality {
  /** Pixel ratio the tier starts at, at most (the device's own ratio may be lower). */
  maxRatio: number;
  /** The lowest pixel ratio the governor steps down to before it gives up the tier. */
  minRatio: number;
  /** Multisampling; fixed when the renderer is made, so only the tier the page loads with sets it. */
  antialias: boolean;
  shadowSize: number;
  /** Half the side of the square the sun's shadows cover round the camera, in metres. */
  shadowSpan: number;
  /**
   * How often a second the shadow map is redrawn; Infinity redraws it with every frame. Between
   * redraws the ground and buildings shade the same, only a robot's own shadow trails it a little.
   */
  shadowHz: number;
  fogNear: number;
  /** Where the fog ends: chunks past it are skipped, and the streaming reaches a chunk past it. */
  fogFar: number;
  /** Robots, bins and loot further than this are not drawn. */
  thingsFar: number;
  /**
   * Milliseconds a frame may spend building chunks still beyond the fog, nearest first; at least
   * one is built each frame that has any waiting, so streaming keeps ahead of a walker.
   */
  streamMs: number;
  /**
   * Chunks nearer than this carry their architectural trim (trim.ts: storey bands, panel joints,
   * lintels and sills, coping, cladding ribs, fittings); 0 draws none. Farther off it is a few
   * pixels wide and only costs triangles.
   */
  trimFar: number;
  /** Stones, stains, cracks and tufts lie on the ground out to this distance (scatter.ts); 0 lays none. */
  scatterFar: number;
}

export const QUALITY: Record<Tier, Quality> = {
  high: { maxRatio: 2, minRatio: 1, antialias: true, shadowSize: 2048, shadowSpan: 55, shadowHz: Infinity, fogNear: 160, fogFar: 420, thingsFar: 220, streamMs: 6, trimFar: 150, scatterFar: 34 },
  medium: { maxRatio: 1.5, minRatio: 0.75, antialias: false, shadowSize: 1024, shadowSpan: 50, shadowHz: 30, fogNear: 130, fogFar: 320, thingsFar: 180, streamMs: 4, trimFar: 80, scatterFar: 24 },
  low: { maxRatio: 1.25, minRatio: 0.6, antialias: false, shadowSize: 1024, shadowSpan: 42, shadowHz: 15, fogNear: 100, fogFar: 240, thingsFar: 150, streamMs: 3, trimFar: 0, scatterFar: 14 },
};

/** What the browser tells about the device; any of it may be missing. */
export interface DeviceHints {
  coarse: boolean;
  cores?: number;
  /** GiB, rounded down by the browser (Chromium only). */
  memory?: number;
  /** Screen size in device pixels. */
  pixels: number;
}

/**
 * The tier a device starts on. Touch screens start no higher than medium: a phone's GPU drawing
 * its full pixel ratio with soft shadows is the cost that makes it stutter and heat up. Very few
 * cores, little memory or a large screen to fill each take one step further down. The hints are
 * coarse (some browsers report fewer cores than the device has, some no memory at all) and the
 * governor never climbs above the tier it starts on, so only a clear sign starts a device lower.
 */
export function pickTier(h: DeviceHints): Tier {
  const weak = (h.cores !== undefined && h.cores <= 2) || (h.memory !== undefined && h.memory <= 3);
  if (h.coarse) return weak || h.pixels > 4_000_000 ? "low" : "medium";
  return (h.cores !== undefined && h.cores <= 2) || (h.memory !== undefined && h.memory <= 2) ? "medium" : "high";
}

const KEY = "ringfall.quality";
const isChoice = (v: unknown): v is QualityChoice => v === "auto" || TIERS.includes(v as Tier);

/** `?quality=low|medium|high|auto` first (not remembered), then the saved choice, else automatic. */
export function loadChoice(search: string): QualityChoice {
  const q = new URLSearchParams(search).get("quality");
  if (isChoice(q)) return q;
  try {
    const v = localStorage.getItem(KEY);
    if (isChoice(v)) return v;
  } catch {
    // Storage blocked (a private window): automatic.
  }
  return "auto";
}

export function saveChoice(c: QualityChoice) {
  try {
    localStorage.setItem(KEY, c);
  } catch {
    // Not remembered; the choice still holds for this visit.
  }
}

/** A step of the governor's ladder: the tier drawn, at what pixel ratio, and whether every other frame is drawn. */
export interface Level {
  tier: Tier;
  ratio: number;
  cap30: boolean;
}

const STEP = 0.85;
/** One step down from `r`, landing on the floor instead of a hair above it. */
const stepDown = (r: number, floor: number) => (r * STEP < floor * 1.08 ? floor : r * STEP);

/**
 * The levels from the best the device starts at to the cheapest, each costing less per frame's
 * budget than the one before: the pixel ratio stepped down within a tier, then the next tier at
 * the same ratio (shorter view, cheaper shadows), and last the low tier drawn at 30 fps. At 30 fps
 * a frame has twice the time, so that rung starts a step above the floor's area doubled.
 * `pinned` keeps to one tier (the player chose it): only its resolution moves.
 */
export function ladder(start: Tier, dpr: number, pinned: boolean): Level[] {
  const out: Level[] = [];
  const tiers = pinned ? [start] : TIERS.slice(TIERS.indexOf(start));
  let r = Math.min(dpr, QUALITY[start].maxRatio);
  for (const tier of tiers) {
    const q = QUALITY[tier];
    r = Math.min(r, q.maxRatio);
    for (;;) {
      out.push({ tier, ratio: +r.toFixed(3), cap30: false });
      if (r <= q.minRatio) break;
      r = stepDown(r, q.minRatio);
    }
  }
  const last = out[out.length - 1];
  if (last.tier === "low") {
    const floor = QUALITY.low.minRatio;
    for (let c = Math.min(last.ratio * Math.SQRT2, QUALITY.low.maxRatio); ; c = stepDown(c, floor)) {
      out.push({ tier: "low", ratio: +c.toFixed(3), cap30: true });
      if (c <= floor) break;
    }
  }
  return out;
}

/** Frame interval smoothing, seconds. */
const TAU = 1;
/** A reading longer than this is a gap (a hidden tab, a chunk prebuild, a shader compile), not a frame. */
const GAP_MS = 250;
/** This many long intervals running are slow frames, not gaps, and are judged as `GAP_MS` each. */
const GAPS = 3;
/** Over budget when the smoothed interval passes it by this much, for `OVER_FOR` seconds running. */
const OVER = 1.2;
const OVER_FOR = 2;
/** Holding the budget means staying within this of it; after `HOLD_FOR` seconds of that, a step up is tried. */
const HOLD = 1.1;
const HOLD_FOR = 12;
/** Seconds of readings ignored after any change, so its own hitch and settling are not judged. */
const COOLDOWN = 3;
/** After a level fails, seconds before it is tried again; doubled each time it fails, up to `BLOCK_MAX`. */
const BLOCK = 45;
const BLOCK_MAX = 600;

/**
 * Picks the ladder's level from frame intervals. Steps down after `OVER_FOR` s over budget (60 fps,
 * or 30 on the capped rungs), up after `HOLD_FOR` s within it; every change is followed by
 * `COOLDOWN` s of ignored readings. A level that was left for being too slow is not tried again
 * for `BLOCK` s, then twice as long each further time, so a device on the edge of two levels
 * settles on the lower one instead of swinging between them. Intervals come in whole display
 * refreshes, so a step that lightens the GPU may show no change until it crosses one; the governor
 * judges only the budget, never the gain of a single step.
 */
export class Governor {
  readonly levels: Level[];
  private at = 0;
  private avg = 0;
  private wait = COOLDOWN;
  private overT = 0;
  private long = 0;
  private holdT = 0;
  private clock = 0;
  private blocked = new Map<number, { until: number; span: number }>();

  constructor(start: Tier, dpr: number, pinned: boolean) {
    this.levels = ladder(start, dpr, pinned);
  }

  get level(): Level {
    return this.levels[this.at];
  }

  /** Ignore the next `s` seconds of readings: a raid starting, the page coming back into view. */
  settle(s = COOLDOWN) {
    this.wait = Math.max(this.wait, s);
    this.overT = this.holdT = 0;
    this.long = 0;
    this.avg = 0;
  }

  /** One drawn frame `ms` after the last; the new level when it changes, else null. */
  frame(ms: number): Level | null {
    if (!(ms > 0)) return null;
    // One long interval is a gap; several in a row are a device too slow for its level, and count.
    if (ms > GAP_MS) {
      if (++this.long < GAPS) return null;
      ms = GAP_MS;
    } else this.long = 0;
    const s = ms / 1000;
    this.clock += s;
    if (this.wait > 0) {
      this.wait -= s;
      return null;
    }
    this.avg = this.avg ? this.avg + (ms - this.avg) * Math.min(1, s / TAU) : ms;
    const budget = this.level.cap30 ? 1000 / 30 : 1000 / 60;
    if (this.avg > budget * OVER) {
      this.overT += s;
      this.holdT = 0;
    } else {
      this.overT = 0;
      this.holdT = this.avg < budget * HOLD ? this.holdT + s : 0;
    }
    if (this.overT >= OVER_FOR) return this.down();
    if (this.holdT >= HOLD_FOR) return this.up();
    return null;
  }

  private down(): Level | null {
    this.overT = 0;
    if (this.at === this.levels.length - 1) return null;
    const b = this.blocked.get(this.at);
    const span = b ? Math.min(BLOCK_MAX, b.span * 2) : BLOCK;
    this.blocked.set(this.at, { until: this.clock + span, span });
    return this.move(this.at + 1);
  }

  private up(): Level | null {
    this.holdT = 0;
    if (this.at === 0) return null;
    const b = this.blocked.get(this.at - 1);
    if (b && this.clock < b.until) return null;
    return this.move(this.at - 1);
  }

  private move(to: number): Level {
    this.at = to;
    this.settle();
    return this.level;
  }
}
