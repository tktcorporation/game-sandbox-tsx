/**
 * Kenney Tiny series — the Font Awesome of pixel sprites.
 *
 * CC0 (public domain): drop another 16×16 PNG into `src/assets/kenney/`,
 * import it below, and add one line to `KENNEY`. Then:
 *
 *   import { Pixel, KENNEY } from "../assets/kenney";
 *   <Pixel name="barbarian" size={48} />
 *   drawKenney(ctx, "coin", x, y, 24);
 *
 * Browse the rest of the packs at https://kenney.nl/assets (Tiny Dungeon,
 * Tiny Town, Tiny Battle, …). Attribution is optional but appreciated.
 */

import type { Resource, TroopType } from "../game/types";

import axeUrl from "./kenney/axe.png";
import barbarianUrl from "./kenney/barbarian.png";
import battleaxeUrl from "./kenney/battleaxe.png";
import bombUrl from "./kenney/bomb.png";
import bowUrl from "./kenney/bow.png";
import chestUrl from "./kenney/chest.png";
import coinUrl from "./kenney/coin.png";
import dwarfUrl from "./kenney/dwarf.png";
import fighterUrl from "./kenney/fighter.png";
import giantUrl from "./kenney/giant.png";
import hammerUrl from "./kenney/hammer.png";
import keyUrl from "./kenney/key.png";
import knightUrl from "./kenney/knight.png";
import pickaxeUrl from "./kenney/pickaxe.png";
import potionBlueUrl from "./kenney/potion-blue.png";
import potionGreenUrl from "./kenney/potion-green.png";
import potionRedUrl from "./kenney/potion-red.png";
import rangerUrl from "./kenney/ranger.png";
import ringUrl from "./kenney/ring.png";
import shieldUrl from "./kenney/shield.png";
import soldierUrl from "./kenney/soldier.png";
import swordUrl from "./kenney/sword.png";
import villagerUrl from "./kenney/villager.png";
import wizardUrl from "./kenney/wizard.png";

export const KENNEY = {
  barbarian: barbarianUrl,
  ranger: rangerUrl,
  giant: giantUrl,
  wizard: wizardUrl,
  fighter: fighterUrl,
  villager: villagerUrl,
  knight: knightUrl,
  dwarf: dwarfUrl,
  soldier: soldierUrl,
  coin: coinUrl,
  potionBlue: potionBlueUrl,
  potionGreen: potionGreenUrl,
  potionRed: potionRedUrl,
  ring: ringUrl,
  chest: chestUrl,
  shield: shieldUrl,
  sword: swordUrl,
  hammer: hammerUrl,
  axe: axeUrl,
  battleaxe: battleaxeUrl,
  bow: bowUrl,
  pickaxe: pickaxeUrl,
  bomb: bombUrl,
  key: keyUrl,
} as const;

export type KenneyName = keyof typeof KENNEY;

export const TROOP_PIXEL: Record<TroopType, KenneyName> = {
  barbarian: "barbarian",
  archer: "ranger",
  giant: "giant",
};

export const RESOURCE_PIXEL: Record<Resource, KenneyName> = {
  gold: "coin",
  elixir: "potionBlue",
};

const images = new Map<KenneyName, HTMLImageElement>();

function imageOf(name: KenneyName): HTMLImageElement | null {
  if (typeof Image === "undefined") return null;
  let img = images.get(name);
  if (!img) {
    img = new Image();
    img.src = KENNEY[name];
    images.set(name, img);
  }
  return img.complete && img.naturalWidth > 0 ? img : null;
}

/** Kick off decoding so the first canvas frame isn't empty. */
export function preloadKenney(): void {
  for (const name of Object.keys(KENNEY) as KenneyName[]) imageOf(name);
}

export function kenneyReady(name: KenneyName): boolean {
  return imageOf(name) !== null;
}

/** Draw a named 16×16 sprite, nearest-neighbour, centred (or feet-anchored). */
export function drawKenney(
  ctx: CanvasRenderingContext2D,
  name: KenneyName,
  x: number,
  y: number,
  size: number,
  opts?: { alpha?: number; anchor?: "center" | "feet" },
): boolean {
  const img = imageOf(name);
  if (!img) return false;
  const w = size;
  const h = size;
  const dx = x - w / 2;
  const dy = (opts?.anchor ?? "center") === "feet" ? y - h : y - h / 2;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.globalAlpha = opts?.alpha ?? 1;
  ctx.drawImage(img, dx, dy, w, h);
  ctx.restore();
  return true;
}
