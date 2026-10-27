import { hypot2 } from "./hypot";
/**
 * The streets: paved roads over the open ground that join the POIs, the outposts, the hamlets and
 * the ways in, in the world's coordinates. They change no ground (the terrain's own `ROADS` do):
 * the view lays a road surface along each, and the map lines them with what a road has (lamp
 * posts, signposts, traffic left where it stopped) and gathers the scattered cover to them, so
 * the open ground reads as country crossed by roads rather than as waste.
 */

/** A street: its centre line through `line`, `half` metres either side of it. */
export interface Street {
  name: string;
  half: number;
  line: readonly (readonly [number, number])[];
}

/**
 * What `scripts/ringfall-roads.ts` routes: each street through its `via` points in order, round
 * cliffs, high ground, water and buildings. Its output is `STREETS`.
 */
export const ROUTE_PLAN: { name: string; half: number; via: readonly (readonly [number, number])[] }[] = [
  { name: "東部工業道路", half: 4, via: [[470, -30], [550, 20], [640, 70], [705, 70]] },
  { name: "工業地帯の連絡路", half: 4, via: [[760, 118], [750, 190], [720, 300], [720, 312]] },
  { name: "機械工場の補給路", half: 4, via: [[665, 360], [600, 410], [400, 440], [200, 465]] },
  { name: "西の半島の道", half: 4, via: [[-470, 200], [-570, 200], [-650, 170], [-730, 170], [-730, 70]] },
  { name: "西の海岸道", half: 3, via: [[-730, 170], [-790, 190], [-820, 235]] },
  // --- the reservoir: a ring round the lakebed joining the POIs, and the ways out from it.
  { name: "湖の南の通り", half: 4, via: [[0, 236], [0, 296]] },
  { name: "町の横通り", half: 3, via: [[-52, 238], [-52, 290]] },
  { name: "南の環状路（西）", half: 4, via: [[0, 236], [-110, 238], [-170, 110], [-265, 10]] },
  { name: "北西の道", half: 3, via: [[-265, 10], [-215, -95]] },
  { name: "南の環状路（東）", half: 4, via: [[0, 236], [88, 204], [250, 205], [342, 190]] },
  { name: "工場への道", half: 3, via: [[250, 205], [270, 250]] },
  { name: "台地の麓の道", half: 4, via: [[125, 75], [200, 108], [188, 30], [210, -50]] },
  { name: "牧場の道", half: 3, via: [[200, 108], [250, 205]] },
  { name: "変電所への道", half: 3, via: [[210, -50], [270, -175]] },
  { name: "検問道", half: 4, via: [[330, -175], [425, -90], [470, -30]] },
  { name: "浜の道", half: 3, via: [[0, 534], [20, 585]] },
  // --- the harbor: from the town and the yard out to the outposts and the quay.
  { name: "港町の通り", half: 4, via: [[40, -590], [45, -675]] },
  { name: "変電所の通り", half: 4, via: [[105, -675], [166, -697]] },
  { name: "燃料基地への道", half: 3, via: [[205, -735], [315, -750]] },
  { name: "埠頭の道", half: 3, via: [[350, -780], [262, -845], [215, -940], [110, -955]] },
  { name: "操車場の道", half: 3, via: [[-335, -665], [-240, -680], [-167, -690]] },
  { name: "漁村の道", half: 3, via: [[-335, -730], [-300, -815], [-280, -935]] },
  { name: "難破船への道", half: 3, via: [[-245, -965], [-4, -932]] },
];

/** The streets as routed (`ROUTE_PLAN`). */
export const STREETS: readonly Street[] = [
  { name: "東部工業道路", half: 4, line: [[470, -30], [550, 20], [640, 70], [705, 70]] },
  { name: "工業地帯の連絡路", half: 4, line: [[760, 118], [750, 190], [720, 300], [720, 312]] },
  { name: "機械工場の補給路", half: 4, line: [[665, 360], [600, 410], [400, 440], [323, 403], [223, 437], [200, 465]] },
  { name: "西の半島の道", half: 4, line: [[-470, 200], [-465, 189], [-515, 187], [-570, 200], [-650, 170], [-730, 170], [-730, 70]] },
  { name: "西の海岸道", half: 3, line: [[-730, 170], [-790, 190], [-819, 223], [-820, 235]] },
  { name: "湖の南の通り", half: 4, line: [[0, 236], [0, 296]] },
  { name: "町の横通り", half: 3, line: [[-52, 238], [-52, 290]] },
  { name: "南の環状路（西）", half: 4, line: [[0, 236], [-110, 238], [-170, 110], [-211, 49], [-265, 10]] },
  { name: "北西の道", half: 3, line: [[-265, 10], [-209, -77], [-215, -95]] },
  { name: "南の環状路（東）", half: 4, line: [[0, 236], [88, 204], [250, 205], [309, 191], [342, 190]] },
  { name: "工場への道", half: 3, line: [[250, 205], [259, 239], [270, 250]] },
  { name: "台地の麓の道", half: 4, line: [[125, 75], [200, 108], [188, 30], [210, -50]] },
  { name: "牧場の道", half: 3, line: [[200, 108], [250, 205]] },
  { name: "変電所への道", half: 3, line: [[210, -50], [270, -175]] },
  { name: "検問道", half: 4, line: [[330, -175], [425, -90], [470, -30]] },
  { name: "浜の道", half: 3, line: [[0, 534], [20, 585]] },
  { name: "港町の通り", half: 4, line: [[40, -590], [45, -675]] },
  { name: "変電所の通り", half: 4, line: [[105, -675], [147, -693], [166, -697]] },
  { name: "燃料基地への道", half: 3, line: [[205, -735], [221, -735], [275, -763], [315, -750]] },
  { name: "埠頭の道", half: 3, line: [[350, -780], [262, -845], [243, -857], [235, -907], [215, -940], [153, -957], [110, -955]] },
  { name: "操車場の道", half: 3, line: [[-335, -665], [-295, -665], [-240, -680], [-191, -675], [-177, -683], [-167, -690]] },
  { name: "漁村の道", half: 3, line: [[-335, -730], [-300, -815], [-287, -925], [-280, -935]] },
  { name: "難破船への道", half: 3, line: [[-245, -965], [-117, -973], [-63, -943], [-4, -932]] },
];

/** One straight length of a street. */
export interface Length {
  street: Street;
  ax: number;
  az: number;
  bx: number;
  bz: number;
}

/** Every street cut into its straight lengths. */
export const LENGTHS: readonly Length[] = STREETS.flatMap((s) =>
  s.line.slice(1).map((q, k) => ({ street: s, ax: s.line[k][0], az: s.line[k][1], bx: q[0], bz: q[1] })),
);

/** The lengths that pass within reach of each 32 m square, so a lookup reads only the few near it. */
const SQUARE = 32;
const REACH = 40;
const near = new Map<number, Length[]>();
for (const l of LENGTHS)
  for (let j = Math.floor((Math.min(l.az, l.bz) - REACH) / SQUARE); j <= Math.floor((Math.max(l.az, l.bz) + REACH) / SQUARE); j++)
    for (let i = Math.floor((Math.min(l.ax, l.bx) - REACH) / SQUARE); i <= Math.floor((Math.max(l.ax, l.bx) + REACH) / SQUARE); i++) {
      const k = j * 4096 + i;
      const list = near.get(k);
      if (list) list.push(l);
      else near.set(k, [l]);
    }

/** Distance from (x, z) to the length's centre line. */
export function toLength(l: Length, x: number, z: number): number {
  const dx = l.bx - l.ax;
  const dz = l.bz - l.az;
  const t = Math.max(0, Math.min(1, ((x - l.ax) * dx + (z - l.az) * dz) / (dx * dx + dz * dz || 1)));
  return hypot2(x - (l.ax + dx * t), z - (l.az + dz * t));
}

/**
 * How far (x, z) lies outside the nearest street's surface: negative on it, up to `REACH` metres
 * off it; beyond that, `REACH`.
 */
export function offStreet(x: number, z: number, exclude?: ReadonlySet<string>): number {
  const list = near.get(Math.floor(z / SQUARE) * 4096 + Math.floor(x / SQUARE));
  let best: number = REACH;
  if (list) for (const l of list) if (!exclude?.has(l.street.name)) best = Math.min(best, toLength(l, x, z) - l.street.half);
  return best;
}
