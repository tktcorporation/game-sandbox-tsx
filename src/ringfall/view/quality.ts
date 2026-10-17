/*
 * How much the renderer draws. Pure data: the World applies a tier's settings. None of it
 * touches the game's rules; robots see no further than `SIGHT` (34 m), well inside every tier's fog.
 */

export type Tier = "high" | "medium" | "low";
export const TIERS: readonly Tier[] = ["high", "medium", "low"];
/** What the player picked in the settings: a tier, or automatic. */
export type QualityChoice = Tier | "auto";

export interface Quality {
  /** Pixel ratio the tier starts at, at most (the device's own ratio may be lower). */
  maxRatio: number;
  /** Multisampling; fixed when the renderer is made, so only the tier the page loads with sets it. */
  antialias: boolean;
  shadowSize: number;
  /** Soft (PCFSoft) or plain (PCF) shadow filtering. */
  softShadows: boolean;
  /** Half the side of the square the sun's shadows cover round the camera, in metres. */
  shadowSpan: number;
  fogNear: number;
  /** Where the fog ends: chunks past it are skipped, and the streaming reaches a chunk past it. */
  fogFar: number;
  /** Robots, bins and loot further than this are not drawn. */
  thingsFar: number;
}

export const QUALITY: Record<Tier, Quality> = {
  high: { maxRatio: 2, antialias: true, shadowSize: 2048, softShadows: true, shadowSpan: 55, fogNear: 110, fogFar: 420, thingsFar: 220 },
  medium: { maxRatio: 1.5, antialias: false, shadowSize: 1024, softShadows: false, shadowSpan: 50, fogNear: 90, fogFar: 320, thingsFar: 180 },
  low: { maxRatio: 1.25, antialias: false, shadowSize: 1024, softShadows: false, shadowSpan: 42, fogNear: 70, fogFar: 240, thingsFar: 150 },
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
 * its full pixel ratio with soft shadows is the cost that makes it stutter and heat up. Few cores,
 * little memory or a large screen to fill each take one step further down.
 */
export function pickTier(h: DeviceHints): Tier {
  const weak = (h.cores !== undefined && h.cores <= 4) || (h.memory !== undefined && h.memory <= 3);
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
