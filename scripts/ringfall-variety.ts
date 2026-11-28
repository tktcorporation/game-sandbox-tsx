/**
 * Measures how a place of the RINGFALL world is built, against the rules of
 * docs/ringfall/field-design.md: cover should come mostly from large pieces that read as what
 * they are (a bunker, a tank farm, a gantry), the loose cover that is left should not be the
 * same object over and over, and no two large pieces of one place should be the same shape.
 * `ringfall-field.ts` measures how the ground plays; this measures what it is made of.
 *
 *   npx tsx scripts/ringfall-variety.ts <place> [--r 120]   one place, with what repeats and where
 *   npx tsx scripts/ringfall-variety.ts --all [--r 120]     every POI, one line each
 *
 * The boxes within `r` of the place are joined into pieces: boxes that touch or overlap
 * (within `TOUCH`) are one piece. A piece whose footprint is at least `STRUCTURE.area` square
 * metres, or whose top is at least `STRUCTURE.tall` metres up on a footprint of at least
 * `STRUCTURE.post` (a mast or a lamp post is neither), is a structure; the rest are loose.
 * Fences and the ziplines' masts are left out (a fence is no cover, a mast is no place), and so
 * are loose pieces too small to hide behind (`LOOSE_MIN`: posts, rails, paint on the ground).
 * - struct: the share of the cover spots robots use (`COVERS`) that stand against a structure.
 * - top: the share of the loose pieces that are the one most common object (`signature()`: its
 *   kind, tint, and size to half a metre), and which object that is.
 * - kinds: how many different loose objects there are (signatures).
 * - twins: structures that have the same shape as another structure of the place (`shapeKey()`:
 *   footprint and height to a metre, box count and kinds), as pairs; rows built on purpose (a
 *   terrace of houses) count too, so read the list.
 * - generic: the share of the loose pieces that are an object found in half or more of all the
 *   POIs (the same thing everywhere, `genericSigs()`).
 * - scattered: the share of the loose pieces placed by `scatterCover()` and the streets' side
 *   (not in `BUILT`), which follow the scatter's rules rather than the place's.
 * - landmark: the tallest structure's top over the place's ground, and how much taller it is than
 *   the next one (a place reads from afar by one silhouette that stands out).
 * No pass or fail; the targets are in docs/ringfall/field-design.md.
 */
import { COVER } from "../src/ringfall/sim/config";
import { coversNear } from "../src/ringfall/sim/cover";
import { groundLevel } from "../src/ringfall/sim/geom";
import { BOXES, BUILT, FRAMES, POIS, PROP, ZIP_BOXES, type Box } from "../src/ringfall/sim/map";

/** Boxes this close count as touching, metres. */
const TOUCH = 0.3;
/** What makes a piece a structure rather than loose cover. */
export const STRUCTURE = { area: 60, tall: 4, post: 4 } as const;
/** A loose piece lower or smaller than this is no cover and is not counted. */
export const LOOSE_MIN = { h: 1, area: 1 } as const;

export interface Piece {
  boxes: Box[];
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  top: number;
  /** Footprint of its bounding rectangle, m². */
  area: number;
  structure: boolean;
  /** Placed by the place's own code (in `BUILT`), not by the scatter. */
  authored: boolean;
}

export interface Variety {
  pieces: Piece[];
  structures: number;
  loose: number;
  /** Share of the cover spots against a structure. */
  structShare: number;
  /** The most common loose object, its share of the loose pieces and its count. */
  top: { sig: string; share: number; n: number };
  /** Distinct loose objects. */
  kinds: number;
  /** Simpson's diversity of the loose objects: the chance two picked at random differ. */
  diversity: number;
  /** Pairs of structures with the same shape. */
  twins: [Piece, Piece][];
  /** Share of the loose pieces that the scatter placed. */
  scattered: number;
  /** Share of the loose pieces that are an object found at half or more of the POIs. */
  generic: number;
  /** Tallest structure's top over the ground at the place, and its lead over the next. */
  landmark: { h: number; lead: number; at: Piece | null };
  /** The loose objects by count, most first. */
  loosePieces: [string, Piece[]][];
}

const PROP_NAME = Object.fromEntries(Object.entries(PROP).map(([k, v]) => [v, k])) as Record<number, string>;

/** A loose piece as an object: what its biggest box is, and its size to half a metre. */
export function signature(p: Piece): string {
  const b = p.boxes.reduce((a, c) => ((c.x1 - c.x0) * (c.z1 - c.z0) > (a.x1 - a.x0) * (a.z1 - a.z0) ? c : a));
  const half = (v: number) => Math.round(v * 2) / 2;
  const [w, d] = [half(p.x1 - p.x0), half(p.z1 - p.z0)].sort((a, c) => a - c);
  const what = b.kind === "prop" ? (PROP_NAME[b.tint] ?? `prop${b.tint}`) : `${b.kind}${b.tint ? `:${b.tint}` : ""}`;
  const parts = p.boxes.length > 1 ? ` ×${p.boxes.length}` : "";
  return `${what} ${w}x${d}x${half(p.top - p.boxes.reduce((m, c) => Math.min(m, c.y0), Infinity))}${parts}`;
}

/** A structure's shape: footprint (either way round) and height to a metre, box count and kinds. */
export function shapeKey(p: Piece): string {
  const [w, d] = [Math.round(p.x1 - p.x0), Math.round(p.z1 - p.z0)].sort((a, c) => a - c);
  const kinds = [...new Set(p.boxes.map((b) => b.kind))].sort().join("+");
  return `${w}x${d}x${Math.round(p.top)} ${p.boxes.length} ${kinds}`;
}

function touches(a: Box, b: Box): boolean {
  return a.x0 <= b.x1 + TOUCH && b.x0 <= a.x1 + TOUCH && a.z0 <= b.z1 + TOUCH && b.z0 <= a.z1 + TOUCH && a.y0 <= b.h + TOUCH && b.y0 <= a.h + TOUCH;
}

const zips = new Set<Box>(ZIP_BOXES);
const built = new Set<Box>(BUILT);

/** The boxes within r of the centre joined into pieces. */
export function piecesNear(c: { x: number; z: number }, r: number): Piece[] {
  const boxes = BOXES.filter((b) => b.kind !== "fence" && !zips.has(b) && Math.hypot((b.x0 + b.x1) / 2 - c.x, (b.z0 + b.z1) / 2 - c.z) <= r);
  // Union-find over a 16 m grid of the boxes, so each box is tested only against its neighbours.
  const up = boxes.map((_, i) => i);
  const find = (i: number): number => (up[i] === i ? i : (up[i] = find(up[i])));
  const grid = new Map<string, number[]>();
  const G = 16;
  boxes.forEach((b, i) => {
    for (let gx = Math.floor((b.x0 - TOUCH) / G); gx <= Math.floor((b.x1 + TOUCH) / G); gx++)
      for (let gz = Math.floor((b.z0 - TOUCH) / G); gz <= Math.floor((b.z1 + TOUCH) / G); gz++) {
        const k = `${gx},${gz}`;
        const list = grid.get(k) ?? [];
        for (const j of list) if (touches(b, boxes[j])) up[find(i)] = find(j);
        list.push(i);
        grid.set(k, list);
      }
  });
  const groups = new Map<number, Box[]>();
  boxes.forEach((b, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), b]);
  });
  return [...groups.values()].map((bs) => {
    const x0 = Math.min(...bs.map((b) => b.x0));
    const z0 = Math.min(...bs.map((b) => b.z0));
    const x1 = Math.max(...bs.map((b) => b.x1));
    const z1 = Math.max(...bs.map((b) => b.z1));
    const top = Math.max(...bs.map((b) => b.h));
    const bottom = Math.min(...bs.map((b) => b.y0));
    const area = (x1 - x0) * (z1 - z0);
    return { boxes: bs, x0, z0, x1, z1, top, area, structure: area >= STRUCTURE.area || (top - bottom >= STRUCTURE.tall && area >= STRUCTURE.post), authored: bs.some((b) => built.has(b)) };
  });
}

/** The piece a cover spot stands against: the nearest within its offset from a box's face. */
function pieceOf(pieces: Piece[], x: number, y: number, z: number): Piece | null {
  let best: Piece | null = null;
  let bestD = COVER.offset + 0.4;
  for (const p of pieces) {
    if (x < p.x0 - bestD || x > p.x1 + bestD || z < p.z0 - bestD || z > p.z1 + bestD) continue;
    for (const b of p.boxes) {
      if (b.h - y < COVER.tall || b.y0 > y + 0.5) continue;
      const dx = Math.max(b.x0 - x, 0, x - b.x1);
      const dz = Math.max(b.z0 - z, 0, z - b.z1);
      const d = Math.hypot(dx, dz);
      if (d < bestD) [bestD, best] = [d, p];
    }
  }
  return best;
}

const counts = (p: Piece) => p.structure || (p.top - Math.min(...p.boxes.map((b) => b.y0)) >= LOOSE_MIN.h && p.area >= LOOSE_MIN.area);

let generic: Set<string> | null = null;
/** The loose objects found at half or more of the POIs, within `r` of each. */
export function genericSigs(r: number): Set<string> {
  if (generic) return generic;
  const seen = new Map<string, number>();
  const frames = FRAMES as Record<string, { x: number; z: number }>;
  let n = 0;
  for (const poi of POIS) {
    const c = frames[poi.id];
    if (!c) continue;
    n++;
    const sigs = new Set(piecesNear(c, r).filter((p) => !p.structure && counts(p)).map(signature));
    for (const s of sigs) seen.set(s, (seen.get(s) ?? 0) + 1);
  }
  generic = new Set([...seen].filter(([, k]) => k >= n / 2).map(([s]) => s));
  return generic;
}

export function measureVariety(c: { x: number; z: number }, r: number): Variety {
  const pieces = piecesNear(c, r).filter(counts);
  const structures = pieces.filter((p) => p.structure);
  const loose = pieces.filter((p) => !p.structure);
  const everywhere = genericSigs(r);
  let against = 0;
  let total = 0;
  for (const s of coversNear(c.x, c.z, r)) {
    if (Math.hypot(s.x - c.x, s.z - c.z) > r) continue;
    const p = pieceOf(pieces, s.x, s.y, s.z);
    if (!p) continue;
    total++;
    if (p.structure) against++;
  }
  const bySig = new Map<string, Piece[]>();
  for (const p of loose) bySig.set(signature(p), [...(bySig.get(signature(p)) ?? []), p]);
  const loosePieces = [...bySig.entries()].sort((a, b) => b[1].length - a[1].length);
  const [topSig, topList] = loosePieces[0] ?? ["-", []];
  const diversity = loose.length > 1 ? 1 - loosePieces.reduce((s, [, l]) => s + (l.length / loose.length) ** 2, 0) : 0;
  const byShape = new Map<string, Piece[]>();
  for (const p of structures) byShape.set(shapeKey(p), [...(byShape.get(shapeKey(p)) ?? []), p]);
  const twins: [Piece, Piece][] = [];
  for (const list of byShape.values()) for (let i = 1; i < list.length; i++) twins.push([list[0], list[i]]);
  const ground = groundLevel(c.x, c.z);
  const tall = [...structures].sort((a, b) => b.top - a.top);
  const h = tall[0] ? tall[0].top - ground : 0;
  const lead = tall[1] ? tall[0].top - tall[1].top : h;
  return {
    pieces,
    structures: structures.length,
    loose: loose.length,
    structShare: total ? against / total : 0,
    top: { sig: topSig, share: loose.length ? topList.length / loose.length : 0, n: topList.length },
    kinds: loosePieces.length,
    diversity,
    twins,
    scattered: loose.length ? loose.filter((p) => !p.authored).length / loose.length : 0,
    generic: loose.length ? loose.filter((p) => everywhere.has(signature(p))).length / loose.length : 0,
    landmark: { h, lead, at: tall[0] ?? null },
    loosePieces,
  };
}

/** The numbers `ringfall-look.ts` keeps in a place's baseline and compares. */
export function varietyNumbers(v: Variety) {
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return { struct: r2(v.structShare), top: r2(v.top.share), kinds: v.kinds, twins: v.twins.length, generic: r2(v.generic), landmark: Math.round(v.landmark.h), lead: Math.round(v.landmark.lead) };
}

const pct = (v: number) => `${Math.round(v * 100)}%`.padStart(4);

export function varietyLine(v: Variety): string {
  return `struct ${pct(v.structShare)}  top ${pct(v.top.share)} (${v.top.sig})  kinds ${String(v.kinds).padStart(3)}  twins ${String(v.twins.length).padStart(2)}  generic ${pct(v.generic)}  scattered ${pct(v.scattered)}  landmark ${v.landmark.h.toFixed(0)} m (+${v.landmark.lead.toFixed(0)})  pieces ${v.structures}/${v.loose}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const R = Number(args[args.indexOf("--r") + 1]) || 120;
  const target = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--r");
  const frames = FRAMES as Record<string, { x: number; z: number }>;
  if (args.includes("--all")) {
    for (const p of POIS) {
      const c = frames[p.id];
      if (c) console.log(`${p.id.padEnd(12)} ${varietyLine(measureVariety(c, R))}`);
    }
  } else {
    const centre = target ? frames[target] : undefined;
    if (!target || !centre) {
      console.error(`usage: npx tsx scripts/ringfall-variety.ts <place>|--all [--r 120]\nplaces: ${Object.keys(FRAMES).join(", ")}`);
      process.exit(2);
    }
    const v = measureVariety(centre, R);
    const at = (p: Piece) => `(${((p.x0 + p.x1) / 2 - centre.x).toFixed(0)}, ${((p.z0 + p.z1) / 2 - centre.z).toFixed(0)})`;
    console.log(varietyLine(v));
    const everywhere = genericSigs(R);
    console.log(`\nloose objects, most used first (place's own / scattered; * found at half the POIs or more), at metres from the place's middle:`);
    for (const [sig, list] of v.loosePieces.slice(0, 10)) {
      const own = list.filter((p) => p.authored).length;
      console.log(`  ${String(list.length).padStart(3)}${everywhere.has(sig) ? "*" : " "} ${sig.padEnd(28)} ${own}/${list.length - own}  ${list.slice(0, 6).map(at).join(" ")}${list.length > 6 ? " …" : ""}`);
    }
    if (v.twins.length) {
      console.log(`\nstructures of the same shape:`);
      for (const [a, b] of v.twins) console.log(`  ${shapeKey(a).padEnd(32)} ${at(a)} = ${at(b)}`);
    }
    if (v.landmark.at) console.log(`\nlandmark: ${shapeKey(v.landmark.at)} at ${at(v.landmark.at)}, top ${v.landmark.h.toFixed(0)} m over the place's ground`);
  }
}
