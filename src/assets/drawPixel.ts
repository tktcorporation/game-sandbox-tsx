const images = new Map<string, HTMLImageElement>();

function imageOf(src: string): HTMLImageElement | null {
  if (typeof Image === "undefined") return null;
  let img = images.get(src);
  if (!img) {
    img = new Image();
    img.src = src;
    images.set(src, img);
  }
  return img.complete && img.naturalWidth > 0 ? img : null;
}

/** Decode just the URLs this entry actually imported. */
export function preloadPixels(srcs: readonly string[]): void {
  for (const src of srcs) imageOf(src);
}

/** Blit a sprite URL, nearest-neighbour, centred (or feet-anchored). */
export function drawKenney(
  ctx: CanvasRenderingContext2D,
  src: string,
  x: number,
  y: number,
  size: number,
  opts?: { alpha?: number; anchor?: "center" | "feet" },
): boolean {
  const img = imageOf(src);
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
