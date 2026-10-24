import { DEPOT, FACTION, FRONT, WORLD } from "../sim/config";
import { frontNodes, nodeHolds, type NodeHold } from "../sim/front";
import { atRisk, battleMarks, meterOf, type Battle, type Side } from "../sim/battle";
import { offshore } from "../sim/terrain";
import { BOXES, CAMP, DEBRIS_SPOTS, NODES, nodeIndex, TIER, UNLOCKS, debrisIndex, DEPOTS, ENTRIES, EXTRA_BINS, EXTRACTS, LANDMARKS, OUTPOST_SITES, POIS, REGIONS, regionOf, ROUTES, regionHere, type EntryId, type NodeId, type PoiId, type RegionId, type RouteId } from "../sim/map";
import type { IslandEvent, PoiHold } from "../sim/island";
import { STREETS } from "../sim/streets";
import { worldKey } from "../sim/routes";
import { DAM_FACE, floorLevel, groundOf, highGround, LEVEL, steepAt, surfaceAt, terrainHeight, type Ground } from "../sim/terrain";
import { cellOf, decodeSeen, exploreSize, type Ally, type Contact, type Enemy, type Player, type State } from "../sim/state";
import { PAL, RARITY_CSS } from "./models";
import type { ContractMark } from "../meta/contracts";

/*
 * The world map (M, or the map button on a phone): both regions and the ways between
 * them. The HUD shows no markers or distances, so this is where the player finds the
 * POIs and the ways off. The ground and buildings are drawn once; each open frame scales
 * them to the map's size on screen and adds the names, the player, the teammate and
 * which POIs are cleared, with text at a fixed size on screen. North (-z) is up, as on
 * the compass. Ground the player has not walked near (`State.seen`) lies under fog; the
 * POIs and exits show through it, since the map is how a first raid finds its way.
 *
 * The world is tall and narrow, so a map of all of it leaves each region small on a wide
 * screen. It opens framed on the region the player is in (`Region.bounds`), and switches to
 * the whole world and back (N, or its button on a phone).
 */

/** A rectangle of the world in metres. */
type View = { x0: number; z0: number; x1: number; z1: number };
const WHOLE: View = { x0: WORLD.x0, z0: WORLD.z0, x1: WORLD.x1, z1: WORLD.z1 };

/** Metres per map pixel of the ground image. */
const CELL = 1.5;

const css = (c: number) => `#${c.toString(16).padStart(6, "0")}`;

/**
 * Each node's holder on the maps and the island's row of marks: the enemy's red and the
 * player's blue, which read on the sand and stay apart from the loot's colours. The titan's pad,
 * the enemy's for good, has a mark of its own in the robots' armour.
 */
export const HOLD_CSS: Record<PoiHold, string> = { held: "#c8402f", freed: "#3f86c8" };

/**
 * A flare as the HUD's icon draws it, centred on (x, y) and `r` tall from its middle: a red stick
 * under a yellow flame, lit; a grey outline when the flare is gone (its bin searched).
 */
export function drawFlare(g: CanvasRenderingContext2D, x: number, y: number, r: number, lit: boolean) {
  g.save();
  // A dark disc behind it, so it reads on the red and blue ground alike.
  g.fillStyle = "rgba(20,24,40,0.75)";
  g.beginPath();
  g.arc(x, y, r * 1.15, 0, Math.PI * 2);
  g.fill();
  g.lineWidth = Math.max(1, r * 0.18);
  g.strokeStyle = lit ? "rgba(20,24,40,0.9)" : "#8a8f9c";
  const stick = () => {
    g.beginPath();
    g.rect(x - r * 0.22, y - r * 0.05, r * 0.44, r * 1.05);
  };
  const flame = () => {
    g.beginPath();
    g.moveTo(x, y - r);
    g.quadraticCurveTo(x + r * 0.62, y - r * 0.35, x, y - r * 0.05);
    g.quadraticCurveTo(x - r * 0.62, y - r * 0.35, x, y - r);
    g.closePath();
  };
  stick();
  if (lit) {
    g.fillStyle = "#e2563a";
    g.fill();
  }
  g.stroke();
  flame();
  if (lit) {
    g.fillStyle = "#ffd36a";
    g.fill();
  }
  g.stroke();
  g.restore();
}

/** A heater shield centred on (x, y), `r` from its middle to its point, filled in `fill`. */
export function drawShield(g: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string) {
  g.save();
  g.beginPath();
  g.moveTo(x - r * 0.8, y - r * 0.85);
  g.lineTo(x + r * 0.8, y - r * 0.85);
  g.lineTo(x + r * 0.8, y - r * 0.1);
  g.quadraticCurveTo(x + r * 0.75, y + r * 0.6, x, y + r);
  g.quadraticCurveTo(x - r * 0.75, y + r * 0.6, x - r * 0.8, y - r * 0.1);
  g.closePath();
  g.fillStyle = fill;
  g.fill();
  g.lineWidth = Math.max(1, r * 0.22);
  g.strokeStyle = "rgba(20,24,40,0.9)";
  g.stroke();
  g.restore();
}

/**
 * What a node opens (`UNLOCKS`) as a row of small marks from (x, y) rightward: a gun in the colour of
 * the rarity the trader sells, an arrow out of a depot, a squad's flag, a red chevron for where
 * reinforcements land, a boat struck through. Full while `on` (the player holds it), faint else.
 */
export function drawUnlocks(g: CanvasRenderingContext2D, x: number, y: number, id: NodeId, dpr: number, on: boolean) {
  const u = UNLOCKS[id];
  const s = 6 * dpr;
  let cx = x;
  g.save();
  g.globalAlpha = on ? 1 : 0.5;
  g.lineJoin = "round";
  const plate = (w: number) => {
    g.fillStyle = "rgba(20,24,40,0.82)";
    g.fillRect(cx - s * 0.3, y - s * 1.05, w + s * 0.6, s * 2.1);
  };
  if (u.shop !== undefined) {
    plate(s * 2.6);
    // A rifle in profile: stock, body, barrel and magazine.
    g.fillStyle = RARITY_CSS[u.shop];
    g.fillRect(cx, y - s * 0.35, s * 0.7, s * 0.7);
    g.fillRect(cx + s * 0.6, y - s * 0.5, s * 1.2, s * 0.6);
    g.fillRect(cx + s * 1.7, y - s * 0.35, s * 0.9, s * 0.25);
    g.fillRect(cx + s * 1.0, y + s * 0.05, s * 0.35, s * 0.6);
    cx += s * 3.3;
  }
  if (u.depart) {
    plate(s * 1.8);
    // An arrow leaving a box: the start from its depot.
    g.strokeStyle = "#f4f7ff";
    g.lineWidth = 1.6 * dpr;
    g.strokeRect(cx, y - s * 0.1, s * 0.9, s * 0.9);
    g.beginPath();
    g.moveTo(cx + s * 0.45, y + s * 0.35);
    g.lineTo(cx + s * 1.6, y - s * 0.8);
    g.moveTo(cx + s * 0.9, y - s * 0.8);
    g.lineTo(cx + s * 1.6, y - s * 0.8);
    g.lineTo(cx + s * 1.6, y - s * 0.1);
    g.stroke();
    cx += s * 2.5;
  }
  if (u.squad) {
    plate(s * 1.4);
    // A flag in the player's blue.
    g.strokeStyle = "#f4f7ff";
    g.lineWidth = 1.4 * dpr;
    g.beginPath();
    g.moveTo(cx + s * 0.2, y + s * 0.9);
    g.lineTo(cx + s * 0.2, y - s * 0.9);
    g.stroke();
    g.fillStyle = HOLD_CSS.freed;
    g.beginPath();
    g.moveTo(cx + s * 0.2, y - s * 0.9);
    g.lineTo(cx + s * 1.4, y - s * 0.5);
    g.lineTo(cx + s * 0.2, y - s * 0.1);
    g.closePath();
    g.fill();
    cx += s * 2.1;
  }
  if (u.scout) {
    plate(s * 1.6);
    // The compass's chevron for where reinforcements land.
    g.fillStyle = "#ff4d4d";
    g.beginPath();
    g.moveTo(cx, y - s * 0.6);
    g.lineTo(cx + s * 1.6, y - s * 0.6);
    g.lineTo(cx + s * 0.8, y + s * 0.7);
    g.closePath();
    g.fill();
    cx += s * 2.3;
  }
  if (u.shore) {
    plate(s * 2.0);
    // A red boat, struck through.
    g.fillStyle = HOLD_CSS.held;
    g.beginPath();
    g.moveTo(cx, y);
    g.lineTo(cx + s * 2, y);
    g.lineTo(cx + s * 1.6, y + s * 0.6);
    g.lineTo(cx + s * 0.4, y + s * 0.6);
    g.closePath();
    g.fill();
    g.fillRect(cx + s * 0.9, y - s * 0.7, s * 0.25, s * 0.7);
    g.strokeStyle = "#f4f7ff";
    g.lineWidth = 1.6 * dpr;
    g.beginPath();
    g.moveTo(cx - s * 0.1, y + s * 0.8);
    g.lineTo(cx + s * 2.1, y - s * 0.8);
    g.stroke();
  }
  g.restore();
}
export const TITAN_CSS = "#262d52";
/** The outposts' mark: places to loot that nobody's colour claims. */
const OUTPOST_CSS = "#8f8a7c";
/**
 * The rogues' (野良機) colour on maps: a violet, kept apart from the enemy's red, the ways off'
 * yellow diamonds and the contract's gold (on the island their armour stays amber).
 */
export const ROGUE_CSS = "#a47be0";

/**
 * What the map draws: a raid's state, or the camp's picture of the island between raids (the
 * explored map, the depots on, the routes open, each POI's standing) with no one on it.
 */
export type MapScene = Pick<State, "seen" | "cleared" | "hold" | "depots" | "routes" | "found"> & {
  player?: Pick<Player, "pos" | "yaw">;
  ally?: Pick<Ally, "active" | "pos" | "down">;
  /** The debris crate of the day's debris fall, or null. */
  debris?: { x: number; z: number; open: boolean } | null;
  /** The salvage crews' members in the player's sight. */
  crews?: readonly { x: number; z: number }[];
  /** The highest threat each POI was freed at (by POI index), shown by its mark when above 0. */
  best?: readonly number[];
  /** The squads the player has seen or heard out between the POIs, and the raid's clock they are timed by. */
  contacts?: readonly Contact[];
  time?: number;
  /** Who holds each node of the front (`NODES` order): the map paints the territory and the front line from it. */
  nodes?: readonly NodeHold[];
  /** The core capture under way, drawn as its meter round the node. */
  capture?: { node: number; t: number } | null;
  /** The day's battle (sim/battle.ts): its squads, and the nodes the sides are taking. */
  battle?: Battle | null;
  friends?: readonly Enemy[];
  enemies?: readonly Enemy[];
  /** The raid's bins, for the flares still lying on the tall buildings' top floors; without them every flare bin is drawn as not yet searched. */
  bins?: readonly { x: number; z: number; flare: boolean; open: boolean }[];
  /** Ways in learned by the raid just ended (the results), ringed as they turn solid. */
  learned?: readonly EntryId[];
  /** The nodes that changed hands overnight (the results): a ring in the colour they turned. */
  changed?: { gained: readonly NodeId[]; lost: readonly NodeId[] };
  /** The only POIs whose names are written (a small map's), or every POI's when absent. */
  names?: readonly PoiId[];
};

/** A label's box on the canvas, so labels do not overlap. */
type Rect = { x0: number; y0: number; x1: number; y1: number };

/** The sides' colours on the battle map: the player's blue, the enemy's red, the rogues' violet. */
export const SIDE_CSS: Record<Side, string> = { 0: "#4f9bff", 1: "#ff4a3d", 2: ROGUE_CSS };

/** The camp's picture of the island between raids, from the profile's explored map, depots, routes and POI standings. */
export function islandScene(p: { seen: string; depots: readonly PoiId[]; routes: readonly RouteId[]; poiState: Record<PoiId, { state: PoiHold }>; events?: readonly (IslandEvent | null)[]; freedAt?: Partial<Record<PoiId, number>> }): MapScene {
  // Today's debris fall is marked on the map table where the piece will lie.
  const ev = p.events?.[0];
  const spot = ev?.t === "debris" ? DEBRIS_SPOTS[debrisIndex(ev.spot)] : null;
  return {
    seen: decodeSeen(p.seen),
    cleared: POIS.map(() => false),
    hold: POIS.map((o) => p.poiState[o.id].state),
    depots: DEPOTS.map((d) => p.depots.includes(d.poi)),
    routes: [...p.routes],
    found: [],
    debris: spot && { x: spot.x, z: spot.z, open: false },
    best: POIS.map((o) => p.freedAt?.[o.id] ?? 0),
    nodes: nodeHolds((id) => p.poiState[id].state),
  };
}

/** Metres per cell of the territory's paint. */
const LAND = 10;
/** Ground further than this from every node and the camp is nobody's. */
const LAND_REACH = 320;

/**
 * The territory as cells (`LAND` metres): each cell of land belongs to the nearest node of its
 * region, or to the camp (the player's); -2 for the camp, -1 for none. Fixed by the map, so built once.
 */
let landOwner: Int16Array | null = null;
const landSize = () => ({ cols: Math.ceil((WORLD.x1 - WORLD.x0) / LAND), rows: Math.ceil((WORLD.z1 - WORLD.z0) / LAND) });
function owners(): Int16Array {
  if (landOwner) return landOwner;
  const { cols, rows } = landSize();
  const out = new Int16Array(cols * rows).fill(-1);
  const camp = { x: (CAMP.x0 + CAMP.x1) / 2, z: (CAMP.z0 + CAMP.z1) / 2 };
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      const x = WORLD.x0 + (i + 0.5) * LAND;
      const z = WORLD.z0 + (j + 0.5) * LAND;
      if (offshore(x, z) > 0) continue;
      const region = regionHere({ x, z }).id;
      let best = LAND_REACH;
      let who = -1;
      NODES.forEach((n, k) => {
        if (n.region !== region) return;
        const d = Math.hypot(n.x - x, n.z - z);
        if (d < best) [best, who] = [d, k];
      });
      // The camp's own ground, on the beach round it.
      if (region === "reservoir" && Math.hypot(camp.x - x, camp.z - z) < Math.min(best, 110)) who = -2;
      out[j * cols + i] = who;
    }
  return (landOwner = out);
}

/** The territory painted (one pixel a cell) and the front line between the player's ground and the rest, for a set of holds. */
let landPaint: { key: string; image: HTMLCanvasElement; line: [number, number, number, number][] } | null = null;
function paintLand(nodes: readonly NodeHold[]) {
  const key = nodes.join(",");
  if (landPaint?.key === key) return landPaint;
  const { cols, rows } = landSize();
  const own = owners();
  const c = document.createElement("canvas");
  c.width = cols;
  c.height = rows;
  const g = c.getContext("2d")!;
  const img = g.createImageData(cols, rows);
  const rgb = (css: string) => [parseInt(css.slice(1, 3), 16), parseInt(css.slice(3, 5), 16), parseInt(css.slice(5, 7), 16)];
  const cols4 = { freed: rgb(HOLD_CSS.freed), held: rgb(HOLD_CSS.held) };
  const mine = (k: number) => k === -2 || (k >= 0 && nodes[k] === "freed");
  for (let n = 0; n < cols * rows; n++) {
    const k = own[n];
    if (k === -1) continue;
    const col = k === -2 ? cols4.freed : cols4[nodes[k]];
    img.data[n * 4] = col[0];
    img.data[n * 4 + 1] = col[1];
    img.data[n * 4 + 2] = col[2];
    img.data[n * 4 + 3] = 110;
  }
  g.putImageData(img, 0, 0);
  // The front line: every cell edge between the player's ground and a node the player does not hold.
  const line: [number, number, number, number][] = [];
  const at = (i: number, j: number) => own[j * cols + i];
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      const a = at(i, j);
      if (a === -1) continue;
      if (i + 1 < cols) {
        const b = at(i + 1, j);
        if (b !== -1 && mine(a) !== mine(b)) line.push([i + 1, j, i + 1, j + 1]);
      }
      if (j + 1 < rows) {
        const b = at(i, j + 1);
        if (b !== -1 && mine(a) !== mine(b)) line.push([i, j + 1, i + 1, j + 1]);
      }
    }
  return (landPaint = { key, image: c, line });
}

/** The ground image, shared by every map on the page: drawing it takes a while, and it changes only with the world (`worldKey()`). */
let shared: { key: string; image: HTMLCanvasElement } | null = null;

export class IslandMap {
  /** One pixel per explored-map cell, redrawn each open frame and scaled over the ground. */
  private fog: HTMLCanvasElement | null = null;
  private readonly width = Math.ceil((WORLD.x1 - WORLD.x0) / CELL);
  private readonly height = Math.ceil((WORLD.z1 - WORLD.z0) / CELL);

  /** Whether the map shows the whole world rather than the region the player is in. */
  whole = false;
  /** The ways in the base offers; null when the map is drawn without a profile, as all of them. */
  known: EntryId[] | null = null;
  /** The region framed when the scene has no player on it (the camp's map table). */
  region: RegionId = "reservoir";
  /** Where the contract taken for the raid points, marked in the loot's gold; null with none taken. */
  contract: ContractMark | null = null;
  /** The shape last given to the page, which sizes the map by it. */
  private aspect = 0;
  /** The last draw's scale and offset in CSS pixels, for `screenAt()`. */
  private proj: { m: number; ox: number; oy: number } | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {}

  /** Where a world point sat on the canvas at the last draw, in CSS pixels from its top left; null before one. */
  screenAt(x: number, z: number): { x: number; y: number } | null {
    const p = this.proj;
    return p && { x: p.ox + (x - WORLD.x0) * p.m, y: p.oy + (z - WORLD.z0) * p.m };
  }

  /** Map pixel of a world point. */
  private px(x: number, z: number) {
    return { x: (x - WORLD.x0) / CELL, y: (z - WORLD.z0) / CELL };
  }

  /**
   * The part of the world on show: the region the player is in, or all of it. The region's frame
   * grows to take in the player, who may stand on the way between the regions outside it.
   */
  view(s: MapScene): View {
    if (this.whole) return WHOLE;
    if (!s.player) return regionOf(this.region).bounds;
    const b = regionHere(s.player.pos).bounds;
    const { x, z } = s.player.pos;
    const pad = 40;
    return {
      x0: Math.max(WORLD.x0, Math.min(b.x0, x - pad)),
      z0: Math.max(WORLD.z0, Math.min(b.z0, z - pad)),
      x1: Math.min(WORLD.x1, Math.max(b.x1, x + pad)),
      z1: Math.min(WORLD.z1, Math.max(b.z1, z + pad)),
    };
  }

  /**
   * The taken contract's place, dashed in gold under the POI marks: a ring round its POI, a pack's
   * loop, or the frame of the region a hunting party walks, each with 依頼 beside it.
   */
  private drawContract(g: CanvasRenderingContext2D, at: (x: number, z: number) => { x: number; y: number }, dpr: number, label: (text: string, x: number, y: number, color: string, size: number) => void) {
    const c = this.contract;
    if (!c) return;
    const gold = "#ffc93a";
    g.save();
    g.strokeStyle = gold;
    g.lineWidth = 2.5 * dpr;
    g.setLineDash([5 * dpr, 4 * dpr]);
    g.beginPath();
    let tag: { x: number; y: number };
    if (c.t === "poi") {
      const p = at(c.x, c.z);
      g.arc(p.x, p.y, 15 * dpr, 0, Math.PI * 2);
      tag = { x: p.x + 30 * dpr, y: p.y + 2 * dpr };
    } else if (c.t === "loop") {
      c.points.forEach((q, n) => {
        const p = at(q.x, q.z);
        if (n) g.lineTo(p.x, p.y);
        else g.moveTo(p.x, p.y);
      });
      g.closePath();
      const first = at(c.points[0].x, c.points[0].z);
      tag = { x: first.x, y: first.y - 12 * dpr };
    } else {
      const b = regionOf(c.region).bounds;
      const a = at(b.x0, b.z0);
      const z = at(b.x1, b.z1);
      const inset = 6 * dpr;
      g.rect(a.x + inset, a.y + inset, z.x - a.x - inset * 2, z.y - a.y - inset * 2);
      const l = at(regionOf(c.region).label.x, regionOf(c.region).label.z);
      tag = { x: l.x + 40 * dpr, y: l.y + 20 * dpr };
    }
    g.stroke();
    g.restore();
    g.strokeStyle = "rgba(20,24,40,0.85)";
    g.lineWidth = 3 * dpr;
    label("依頼", tag.x, tag.y, gold, 11);
  }

  /**
   * The ground with every box on it. Walkable ground is shaded by level, from the dark
   * quarry pit and the grey lakebed up to the light dam crest and mesa; high ground is
   * dark rock and cliffs darker still, so the ways between levels stand out.
   */
  private build(): HTMLCanvasElement {
    const c = document.createElement("canvas");
    c.width = this.width;
    c.height = this.height;
    const g = c.getContext("2d")!;
    const img = g.createImageData(this.width, this.height);
    const high = [0x8a, 0x4e, 0x32];
    const wall = [0x5e, 0x31, 0x20];
    const dam = [0xcf, 0xc8, 0xb8];
    // Walkable ground by level: below the shore, the shore, then the high levels.
    const floor = (lv: number) => (lv <= LEVEL.lakebed + 0.5 ? [0xb4, 0xa8, 0x8e] : lv < LEVEL.foot - 0.5 ? [0xe2, 0xbf, 0x8a] : [0xf2, 0xda, 0xa8]);
    // Districts with a ground of their own (`Ground`, terrain.ts) keep its colour on the map, a shade lighter.
    const GROUND: Record<Ground, number[]> = {
      salt: [0xf2, 0xec, 0xdc],
      paved: [0xd2, 0xc5, 0xa8],
      dune: [0xf0, 0xdd, 0xb2],
      mud: [0xb4, 0xa8, 0x8e],
      quarry: [0xb8, 0x6a, 0x48],
      sandstone: [0xe6, 0xa0, 0x62],
      scrub: [0xb8, 0xb6, 0x8c],
      oiled: [0xbf, 0xbb, 0xb2],
      concrete: [0xd8, 0xd2, 0xc4],
    };
    const water = [0x5f, 0xa8, 0xa6];
    const paint = (x: number, z: number, lv: number) => {
      const at = surfaceAt(x, z);
      if (at === "水路") return water;
      const g = groundOf(at);
      return g ? GROUND[g] : floor(lv);
    };
    for (let j = 0; j < this.height; j++)
      for (let i = 0; i < this.width; i++) {
        const x = WORLD.x0 + (i + 0.5) * CELL;
        const z = WORLD.z0 + (j + 0.5) * CELL;
        const k = (j * this.width + i) * 4;
        const lv = floorLevel(x, z);
        // A ramp's middle: shade by the ground's own height.
        const col = steepAt(x, z) ? (DAM_FACE(x, z) ? dam : wall) : highGround(x, z) ? high : paint(x, z, Math.min(lv, terrainHeight(x, z)));
        img.data[k] = col[0];
        img.data[k + 1] = col[1];
        img.data[k + 2] = col[2];
        img.data[k + 3] = 255;
      }
    g.putImageData(img, 0, 0);
    // The streets, as wide as they are, in the asphalt's colour.
    g.strokeStyle = css(PAL.asphalt);
    g.lineCap = g.lineJoin = "round";
    for (const st of STREETS) {
      g.lineWidth = Math.max(1.5, this.px(st.half * 2, 0).x - this.px(0, 0).x);
      g.beginPath();
      st.line.forEach(([x, z], n) => {
        const p = this.px(x, z);
        if (n) g.lineTo(p.x, p.y);
        else g.moveTo(p.x, p.y);
      });
      g.stroke();
    }
    g.fillStyle = css(PAL.concreteDark);
    for (const b of BOXES) {
      const a = this.px(b.x0, b.z0);
      const e = this.px(b.x1, b.z1);
      g.fillRect(a.x, a.y, Math.max(1, e.x - a.x), Math.max(1, e.y - a.y));
    }
    return c;
  }

  /** Cells seen when the fog was last drawn: cells are only ever uncovered, so the count says whether it changed. */
  private fogSeen = -1;

  /** The fog as a cell-per-pixel image: opaque where unexplored, clear where seen. */
  private fogImage(seen: number[]): HTMLCanvasElement {
    const { cols, rows } = exploreSize();
    const c = (this.fog ??= Object.assign(document.createElement("canvas"), { width: cols, height: rows }));
    const count = seen.reduce((n, v) => n + v, 0);
    if (count === this.fogSeen) return c;
    this.fogSeen = count;
    const g = c.getContext("2d")!;
    const img = g.createImageData(cols, rows);
    for (let i = 0; i < cols * rows; i++) {
      img.data[i * 4] = 0x1c;
      img.data[i * 4 + 1] = 0x1f;
      img.data[i * 4 + 2] = 0x2a;
      img.data[i * 4 + 3] = seen[i] ? 0 : 250;
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  /**
   * The day's battle on the map: each squad as a chevron in its side's colour pointing to the node
   * it walks to (filled while its robots are in the world, an outline while it is numbers, its
   * members' count beside it), and each node a side's squads are taking with its meter round it.
   */
  private drawBattle(g: CanvasRenderingContext2D, s: MapScene, at: (x: number, z: number) => { x: number; y: number }, dpr: number, label: (t: string, x: number, y: number, c: string, size: number) => void) {
    const b = s.battle!;
    for (const m of battleMarks({ battle: b, friends: (s.friends ?? []) as Enemy[], enemies: (s.enemies ?? []) as Enemy[] })) {
      const p = at(m.x, m.z);
      const to = m.to >= 0 ? at(NODES[m.to].core.x, NODES[m.to].core.z) : p;
      const a = Math.atan2(to.y - p.y, to.x - p.x);
      const r = 6 * dpr;
      g.save();
      g.translate(p.x, p.y);
      if (Math.hypot(to.x - p.x, to.y - p.y) > r) g.rotate(a);
      g.beginPath();
      g.moveTo(r, 0);
      g.lineTo(-r * 0.8, r * 0.75);
      g.lineTo(-r * 0.35, 0);
      g.lineTo(-r * 0.8, -r * 0.75);
      g.closePath();
      g.lineWidth = 1.6 * dpr;
      g.strokeStyle = "rgba(20,24,40,0.95)";
      g.fillStyle = SIDE_CSS[m.side];
      if (m.live) {
        g.fill();
        g.stroke();
      } else {
        g.fillStyle = "rgba(20,24,40,0.6)";
        g.fill();
        g.strokeStyle = SIDE_CSS[m.side];
        g.stroke();
      }
      g.restore();
      label(String(m.n), p.x + 9 * dpr, p.y + 6 * dpr, SIDE_CSS[m.side], 8);
    }
    // A node of the player's the enemy's robots have come to: red rings beating out from it; one the
    // enemy is on its way to take: a single ring, slower.
    const beat = (performance.now() / 900) % 1;
    const slow = (performance.now() / 1600) % 1;
    const risk = s.nodes ? atRisk({ battle: b, nodes: s.nodes }) : [];
    NODES.forEach((n, i) => {
      const hot = !!b.threat?.[i];
      if (!hot && !risk[i]) return;
      const p = at(n.x, n.z);
      g.save();
      for (const k of hot ? [beat, (beat + 0.5) % 1] : [slow]) {
        g.lineWidth = (hot ? 3 : 2) * dpr;
        g.strokeStyle = `rgba(255,59,48,${(1 - k).toFixed(2)})`;
        g.beginPath();
        g.arc(p.x, p.y, (12 + (hot ? 22 : 14) * k) * dpr, 0, Math.PI * 2);
        g.stroke();
      }
      g.restore();
    });
    NODES.forEach((n, i) => {
      const mt = meterOf(b, i);
      if (!mt) return;
      const p = at(n.x, n.z);
      const r = 15 * dpr;
      g.save();
      g.lineWidth = 4 * dpr;
      g.strokeStyle = SIDE_CSS[mt.side];
      g.beginPath();
      g.arc(p.x, p.y, r, -Math.PI / 2, -Math.PI / 2 + mt.share * Math.PI * 2);
      g.stroke();
      g.restore();
    });
  }

  draw(s: MapScene) {
    if (shared?.key !== worldKey()) shared = { key: worldKey(), image: this.build() };
    const base = shared.image;
    const g = this.canvas.getContext("2d")!;
    const v = this.view(s);
    const aspect = (v.x1 - v.x0) / (v.z1 - v.z0);
    // The page sizes the map by this, so it keeps the shape of what it shows.
    if (aspect !== this.aspect) this.canvas.style.setProperty("--map-aspect", `${(this.aspect = aspect)}`);
    // Drawn at the size it is shown, so names stay readable however tall the world is.
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = Math.round((this.canvas.clientWidth || this.width) * dpr);
    const h = Math.round((this.canvas.clientHeight || this.height) * dpr);
    this.canvas.width = w;
    this.canvas.height = h;
    // Screen pixels per metre, the view centred in the canvas (whose shape follows it a frame late when it changes).
    const m = Math.min(w / (v.x1 - v.x0), h / (v.z1 - v.z0));
    const ox = (w - (v.x1 - v.x0) * m) / 2 - (v.x0 - WORLD.x0) * m;
    const oy = (h - (v.z1 - v.z0) * m) / 2 - (v.z0 - WORLD.z0) * m;
    this.proj = { m: m / dpr, ox: ox / dpr, oy: oy / dpr };
    g.fillStyle = "#1c1f2a";
    g.fillRect(0, 0, w, h);
    g.imageSmoothingEnabled = true;
    g.drawImage(base, ox, oy, this.width * CELL * m, this.height * CELL * m);
    // Smoothed, so the fog's edge is soft rather than a staircase of 20 m squares.
    const { cols, rows } = exploreSize();
    g.drawImage(this.fogImage(s.seen), ox, oy, cols * DEPOT.cell * m, rows * DEPOT.cell * m);
    const at = (x: number, z: number) => ({ x: ox + (x - WORLD.x0) * m, y: oy + (z - WORLD.z0) * m });
    // The 戦況図: each node's ground in the colour of who holds it, and the front line drawn thick
    // between the player's ground and the rest.
    if (s.nodes) {
      const land = paintLand(s.nodes);
      const { cols: lc, rows: lr } = landSize();
      g.imageSmoothingEnabled = false;
      g.drawImage(land.image, ox, oy, lc * LAND * m, lr * LAND * m);
      g.imageSmoothingEnabled = true;
      g.save();
      g.strokeStyle = "#f4f7ff";
      g.lineWidth = 3 * dpr;
      g.lineCap = "round";
      g.beginPath();
      for (const [x0, y0, x1, y1] of land.line) {
        g.moveTo(ox + x0 * LAND * m, oy + y0 * LAND * m);
        g.lineTo(ox + x1 * LAND * m, oy + y1 * LAND * m);
      }
      g.stroke();
      g.restore();
    }
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.lineWidth = 3 * dpr;
    g.lineJoin = "round";
    g.strokeStyle = "rgba(20,24,40,0.85)";
    const font = (size: number) => `800 ${size * dpr}px system-ui, sans-serif`;
    // A centred name near the world's edge is moved in so it stays whole on the canvas.
    const inside = (text: string, x: number) => {
      const half = g.measureText(text).width / 2 + 4 * dpr;
      return Math.max(half, Math.min(g.canvas.width - half, x));
    };
    const label = (text: string, x: number, y: number, color: string, size: number, stroke = true) => {
      g.font = font(size);
      if (g.textAlign === "center") x = inside(text, x);
      if (stroke) g.strokeText(text, x, y);
      g.fillStyle = color;
      g.fillText(text, x, y);
    };
    // Where POI and exit names will go. On a small map, a district or region name that would
    // cover one of them is left out: those are the names the player navigates by.
    const box = (text: string, x: number, y: number, size: number, left = false): Rect => {
      g.font = font(size);
      const w = g.measureText(text).width;
      const hh = size * dpr * 0.6;
      const x0 = left ? x : inside(text, x) - w / 2;
      return { x0, y0: y - hh, x1: x0 + w, y1: y + hh };
    };
    const taken: Rect[] = [];
    const free = (r: Rect) => !taken.some((t) => r.x0 < t.x1 && r.x1 > t.x0 && r.y0 < t.y1 && r.y1 > t.y0);
    // A POI cleared this raid gets a tick after its name; who holds it is its mark's colour.
    const hold = (i: number): PoiHold => s.hold?.[i] ?? "held";
    const poiText = (i: number) => (s.cleared[i] && hold(i) !== "freed" ? `${POIS[i].name} ✓` : POIS[i].name);
    // The POI names written: those the scene names (the nodes that changed hands come first), and of
    // the rest none that would cover a name already placed, so a small map shows fewer, whole names.
    const changedIds: readonly string[] = [...(s.changed?.gained ?? []), ...(s.changed?.lost ?? [])];
    const order = POIS.map((_, i) => i).sort((a, b) => Number(changedIds.includes(POIS[b].id)) - Number(changedIds.includes(POIS[a].id)));
    const named: number[] = [];
    for (const i of order) {
      if (s.names && !s.names.includes(POIS[i].id)) continue;
      const p = at(POIS[i].x, POIS[i].z);
      const r = box(poiText(i), p.x, p.y - 15 * dpr, 12);
      if (named.some((j) => {
        const q = at(POIS[j].x, POIS[j].z);
        const t = box(poiText(j), q.x, q.y - 15 * dpr, 12);
        return r.x0 < t.x1 && r.x1 > t.x0 && r.y0 < t.y1 && r.y1 > t.y0;
      }))
        continue;
      named.push(i);
      taken.push(r);
    }
    POIS.forEach((poi, i) => {
      const p = at(poi.x, poi.z);
      taken.push({ x0: p.x - 8 * dpr, y0: p.y - 8 * dpr, x1: p.x + 8 * dpr, y1: p.y + 8 * dpr });
    });
    for (const x of EXTRACTS) {
      const p = at(x.x, x.z);
      const r = 6 * dpr;
      taken.push({ x0: p.x - r, y0: p.y - r, x1: p.x + r, y1: p.y + r });
    }
    // An exit's name sits under its marker, or beside it when another name is already there.
    const exitAt = EXTRACTS.map((x) => {
      const p = at(x.x, x.z);
      g.font = font(10);
      const half = g.measureText(x.short).width / 2 + 9 * dpr;
      const spots = [
        { x: p.x, y: p.y + 13 * dpr },
        { x: p.x - half, y: p.y },
        { x: p.x + half, y: p.y },
        { x: p.x, y: p.y - 13 * dpr },
      ];
      const spot = spots.find((q) => free(box(x.short, q.x, q.y, 10))) ?? spots[0];
      taken.push(box(x.short, spot.x, spot.y, 10));
      return spot;
    });
    // Districts and landmarks between the POIs, small and muted under everything else.
    for (const d of LANDMARKS) {
      // A district's name is learnt by going there.
      if (!s.seen[cellOf(d.x, d.z)]) continue;
      const p = at(d.x, d.z);
      const r = box(d.name, p.x, p.y, 10);
      if (!free(r)) continue;
      taken.push(r);
      label(d.name, p.x, p.y, "#e9dcc2", 10);
    }
    // The ways in: a ring each, where a raid that does not start at a depot begins. One the base
    // does not offer yet, and this raid has not walked to, is faint and dashed: somewhere to aim for.
    for (const e of ENTRIES) {
      const p = at(e.x, e.z);
      const known = !this.known || this.known.includes(e.id) || s.found.includes(e.id);
      const ink = known ? "#e9dcc2" : "rgba(233,220,194,0.5)";
      g.save();
      g.lineWidth = (known ? 2 : 1.5) * dpr;
      g.strokeStyle = ink;
      if (!known) g.setLineDash([2 * dpr, 2 * dpr]);
      g.beginPath();
      g.arc(p.x, p.y, 3.5 * dpr, 0, Math.PI * 2);
      g.stroke();
      // A way in the raid just learned: a wide second ring round it, as it turns solid.
      if (known && s.learned?.includes(e.id)) {
        g.lineWidth = 2 * dpr;
        g.beginPath();
        g.arc(p.x, p.y, 9 * dpr, 0, Math.PI * 2);
        g.stroke();
      }
      g.restore();
      const text = e.name;
      const r = box(text, p.x, p.y + 11 * dpr, 9);
      if (!free(r)) continue;
      taken.push(r);
      label(text, p.x, p.y + 11 * dpr, known ? ink : "#9c9586", 9);
    }
    for (const r of REGIONS) {
      const p = at(r.label.x, r.label.z);
      if (!free(box(r.name, p.x, p.y, 15, true))) continue;
      g.textAlign = "left";
      label(r.name, p.x, p.y, "rgba(255,248,232,0.55)", 15, false);
      g.textAlign = "center";
    }
    EXTRACTS.forEach((x, i) => {
      const p = at(x.x, x.z);
      const r = 6 * dpr;
      g.fillStyle = css(PAL.hot);
      g.beginPath();
      g.moveTo(p.x, p.y - r);
      g.lineTo(p.x + r, p.y);
      g.lineTo(p.x, p.y + r);
      g.lineTo(p.x - r, p.y);
      g.closePath();
      g.fill();
      g.stroke();
      label(x.short, exitAt[i].x, exitAt[i].y, css(PAL.hot), 10);
      // The plateau's pickup wants a flare: the flare's mark rides on its diamond's shoulder.
      if (x.needsFlare) drawFlare(g, p.x + r * 1.6, p.y - r * 1.2, 7 * dpr, true);
    });
    // Where the flares lie: the same mark on the tall buildings' top floors, grey once searched.
    const flares = s.bins ? s.bins.filter((b) => b.flare) : EXTRA_BINS.filter((b) => b.flare).map((b) => ({ ...b, open: false }));
    for (const b of flares) {
      const p = at(b.x, b.z);
      drawFlare(g, p.x, p.y, 6.5 * dpr, !b.open);
    }
    // The routes a tool opens: open ones a solid line, closed ones dashed with a cross at each obstacle.
    for (const r of ROUTES) {
      const open = s.routes.includes(r.id);
      g.save();
      g.lineWidth = 3 * dpr;
      g.strokeStyle = open ? "#6fd0cf" : "#ff8a5c";
      if (!open) g.setLineDash([4 * dpr, 4 * dpr]);
      g.beginPath();
      r.path.forEach((q, n) => {
        const p = at(q.x, q.z);
        if (n) g.lineTo(p.x, p.y);
        else g.moveTo(p.x, p.y);
      });
      g.stroke();
      g.setLineDash([]);
      if (!open)
        for (const a of r.at) {
          const p = at(a.x, a.z);
          const d = 4 * dpr;
          g.lineWidth = 2.5 * dpr;
          g.beginPath();
          g.moveTo(p.x - d, p.y - d);
          g.lineTo(p.x + d, p.y + d);
          g.moveTo(p.x + d, p.y - d);
          g.lineTo(p.x - d, p.y + d);
          g.stroke();
        }
      g.restore();
      // Its name beside its middle, where nothing else is.
      const mid = r.path[Math.floor(r.path.length / 2)];
      const m = at((r.path[0].x + mid.x) / 2, (r.path[0].z + mid.z) / 2);
      const text = r.name;
      g.textAlign = "left";
      const spot = box(text, m.x + 7 * dpr, m.y, 9, true);
      if (free(spot)) {
        taken.push(spot);
        label(text, m.x + 7 * dpr, m.y, open ? "#bfeeee" : "#ffc2a8", 9);
      }
      g.textAlign = "center";
    }
    this.drawContract(g, at, dpr, label);
    // Depots that are on: a teal square each, a place a later raid can start from.
    DEPOTS.forEach((d, i) => {
      if (!s.depots[i]) return;
      const p = at(d.x, d.z);
      const r = 3.5 * dpr;
      g.fillStyle = "#6fd0cf";
      g.strokeRect(p.x - r, p.y - r, r * 2, r * 2);
      g.fillRect(p.x - r, p.y - r, r * 2, r * 2);
    });
    // The debris crate: a gold shard, grey once opened.
    if (s.debris) {
      const p = at(s.debris.x, s.debris.z);
      const d = 7 * dpr;
      g.save();
      g.lineWidth = 2.5 * dpr;
      g.strokeStyle = "rgba(20,24,40,0.9)";
      g.fillStyle = s.debris.open ? "#6b6f78" : "#e0a33a";
      g.beginPath();
      g.moveTo(p.x + d * 0.2, p.y - d);
      g.lineTo(p.x + d * 0.8, p.y - d * 0.1);
      g.lineTo(p.x - d * 0.1, p.y + d);
      g.lineTo(p.x - d * 0.7, p.y + d * 0.05);
      g.closePath();
      g.fill();
      g.stroke();
      g.restore();
      const text = "破片";
      const spot = box(text, p.x, p.y + 14 * dpr, 9);
      if (free(spot)) {
        taken.push(spot);
        label(text, p.x, p.y + 14 * dpr, s.debris.open ? "#9c9586" : "#ffd58a", 9);
      }
    }
    // Salvage crew members in sight: small rust squares.
    for (const c of s.crews ?? []) {
      const p = at(c.x, c.z);
      const r = 3 * dpr;
      g.fillStyle = "#c86f3a";
      g.strokeStyle = "rgba(20,24,40,0.9)";
      g.lineWidth = 1.5 * dpr;
      g.strokeRect(p.x - r, p.y - r, r * 2, r * 2);
      g.fillRect(p.x - r, p.y - r, r * 2, r * 2);
    }
    // The outposts: a small grey square, a place to loot that is no node of the front.
    for (const o of OUTPOST_SITES) {
      const p = at(o.x, o.z);
      const r = 3.5 * dpr;
      g.save();
      g.lineWidth = 1.5 * dpr;
      g.strokeStyle = "rgba(20,24,40,0.9)";
      g.fillStyle = OUTPOST_CSS;
      g.strokeRect(p.x - r, p.y - r, r * 2, r * 2);
      g.fillRect(p.x - r, p.y - r, r * 2, r * 2);
      g.restore();
    }
    // Squads seen or heard out between the POIs, fading over `FACTION.keep`: a dot in their
    // faction's colour where they were, and a burst where the factions were heard fighting.
    for (const c of s.contacts ?? []) {
      const age = (s.time ?? c.t) - c.t;
      const p = at(c.x, c.z);
      g.save();
      g.globalAlpha = Math.max(0.25, 1 - age / FACTION.keep);
      g.fillStyle = c.rogue ? ROGUE_CSS : "#ff5a4f";
      g.strokeStyle = "rgba(20,24,40,0.9)";
      g.lineWidth = 1.5 * dpr;
      g.beginPath();
      if (c.fight) {
        const r0 = 3 * dpr;
        const r1 = 7 * dpr;
        for (let k = 0; k < 16; k++) {
          const a = (k / 16) * Math.PI * 2;
          const r = k % 2 ? r0 : r1;
          if (k) g.lineTo(p.x + Math.cos(a) * r, p.y + Math.sin(a) * r);
          else g.moveTo(p.x + Math.cos(a) * r, p.y + Math.sin(a) * r);
        }
        g.closePath();
      } else g.arc(p.x, p.y, 3 * dpr, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      g.restore();
      if (c.fight && age < 20) {
        const spot = box("交戦", p.x, p.y - 11 * dpr, 9);
        if (free(spot)) {
          taken.push(spot);
          label("交戦", p.x, p.y - 11 * dpr, "#ffe2a8", 9);
        }
      }
    }
    // Each POI's mark at its centre, coloured by who holds it: a disc, or the titan's hexagon.
    POIS.forEach((poi, i) => {
      const p = at(poi.x, poi.z);
      const r = 7 * dpr;
      g.save();
      g.lineWidth = 2.5 * dpr;
      g.strokeStyle = "rgba(20,24,40,0.9)";
      g.beginPath();
      if (poi.boss) {
        for (let k = 0; k < 6; k++) {
          const a = (Math.PI / 3) * k + Math.PI / 6;
          const x = p.x + Math.cos(a) * r * 1.15;
          const y = p.y + Math.sin(a) * r * 1.15;
          if (k) g.lineTo(x, y);
          else g.moveTo(x, y);
        }
        g.closePath();
        g.fillStyle = TITAN_CSS;
      } else {
        g.arc(p.x, p.y, r, 0, Math.PI * 2);
        g.fillStyle = HOLD_CSS[hold(i)];
      }
      g.fill();
      g.stroke();
      if (!poi.boss) {
        // The garrison's plate: a shield in the colour of the rarity that pierces it.
        drawShield(g, p.x, p.y + r * 0.06, r * 0.62, RARITY_CSS[TIER[poi.id as NodeId] ?? 0]);
        // What holding it opens, as small marks beside it: dim while the enemy holds it.
        drawUnlocks(g, p.x + r * 1.45, p.y - r * 0.95, poi.id as NodeId, dpr, hold(i) === "freed");
      }
      if (poi.boss) {
        // The titan's eye, in the robots' red.
        g.fillStyle = HOLD_CSS.held;
        g.beginPath();
        g.arc(p.x, p.y, r * 0.38, 0, Math.PI * 2);
        g.fill();
      }
      // The highest threat it was freed at, as a gold number on a dark tab at the mark's lower right.
      const best = s.best?.[i] ?? 0;
      if (best > 0) {
        g.font = `900 ${10 * dpr}px system-ui, sans-serif`;
        g.textAlign = "center";
        g.textBaseline = "middle";
        const bx = p.x + r * 1.15;
        const by = p.y + r * 0.9;
        g.fillStyle = "rgba(20,24,40,0.92)";
        g.fillRect(bx - 6 * dpr, by - 6 * dpr, 12 * dpr, 12 * dpr);
        g.fillStyle = "#ffcf5a";
        g.fillText(String(best), bx, by + 0.5 * dpr);
      }
      g.restore();
    });
    // The nodes on the front: a white ring, where the player can strike next; the capture under
    // way as its meter round the ring, with its share.
    if (s.nodes) {
      const front = frontNodes(s.nodes);
      NODES.forEach((n, i) => {
        if (!front[i] && s.capture?.node !== i) return;
        const p = at(n.x, n.z);
        const r = 12 * dpr;
        g.save();
        g.lineWidth = 2 * dpr;
        g.strokeStyle = "#f4f7ff";
        g.setLineDash([3 * dpr, 2.5 * dpr]);
        g.beginPath();
        g.arc(p.x, p.y, r, 0, Math.PI * 2);
        g.stroke();
        g.setLineDash([]);
        if (s.capture?.node === i) {
          g.lineWidth = 4 * dpr;
          g.strokeStyle = "#ffc93a";
          g.beginPath();
          g.arc(p.x, p.y, r + 3 * dpr, -Math.PI / 2, -Math.PI / 2 + (Math.min(s.capture.t, FRONT.capture) / FRONT.capture) * Math.PI * 2);
          g.stroke();
        }
        g.restore();
        if (s.capture?.node !== i) return;
        const text = `${Math.floor((s.capture.t / FRONT.capture) * 100)}%`;
        const spot = box(text, p.x + r + 16 * dpr, p.y, 9);
        if (free(spot)) {
          taken.push(spot);
          label(text, p.x + r + 16 * dpr, p.y, "#f4f7ff", 9);
        }
      });
    }
    if (s.battle && s.nodes) this.drawBattle(g, s, at, dpr, label);
    // The nodes that changed hands: a thick ring in the colour each turned.
    for (const [ids, col] of [[s.changed?.gained ?? [], HOLD_CSS.freed], [s.changed?.lost ?? [], HOLD_CSS.held]] as const)
      for (const id of ids) {
        const n = NODES[nodeIndex(id)];
        const p = at(n.x, n.z);
        g.save();
        g.lineWidth = 4 * dpr;
        g.strokeStyle = col;
        g.beginPath();
        g.arc(p.x, p.y, 14 * dpr, 0, Math.PI * 2);
        g.stroke();
        g.restore();
      }
    // POI names go on top, a little above their mark, so an exit nearby does not hide them.
    for (const i of named) {
      const p = at(POIS[i].x, POIS[i].z);
      label(poiText(i), p.x, p.y - 15 * dpr, s.cleared[i] ? "#cfd6e0" : "#ffffff", 12);
    }
    if (s.ally?.active) {
      const a = at(s.ally.pos.x, s.ally.pos.z);
      g.fillStyle = s.ally.down > 0 ? "#ff5a4f" : "#6fd0cf";
      g.beginPath();
      g.arc(a.x, a.y, 4 * dpr, 0, Math.PI * 2);
      g.fill();
    }
    // The player: an arrow pointing the way they face.
    const p = s.player;
    if (!p) return;
    const me = at(p.pos.x, p.pos.z);
    g.save();
    g.translate(me.x, me.y);
    g.rotate(p.yaw);
    g.scale(dpr, dpr);
    g.lineWidth = 3;
    g.fillStyle = "#ffffff";
    g.beginPath();
    g.moveTo(0, -9);
    g.lineTo(6, 6);
    g.lineTo(0, 3);
    g.lineTo(-6, 6);
    g.closePath();
    g.fill();
    g.stroke();
    g.restore();
  }
}
