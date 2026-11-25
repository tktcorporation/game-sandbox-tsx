import { DEPOT, FACTION, FRONT, WORLD } from "../sim/config";
import { ZIPS } from "../sim/map";
import { finaleOpen } from "../meta/island";
import { zipUp } from "../sim/zips";
import { frontNodes, NEIGHBOURS, nodeHolds, type NodeHold } from "../sim/front";
import { atRisk, battleMarks, meterOf, type Battle, type Side } from "../sim/battle";
import { offshore } from "../sim/terrain";
import { BOXES, CAMP, NODES, nodeIndex, poiIndex, TIER, UNLOCKS, DEPOTS, ENTRIES, EXTRA_BINS, EXTRACTS, HOME_REGION, LANDMARKS, OUTPOST_SITES, POIS, REGIONS, regionOf, ROUTES, regionHere, type EntryId, type NodeId, type PoiId, type RegionId, type RouteId } from "../sim/map";
import type { PoiHold } from "../sim/island";
import { isAiOwner, rivalOf } from "../sim/holds";
import { STREETS } from "../sim/streets";
import { worldKey } from "../sim/routes";
import { DAM_FACE, floorLevel, groundOf, highGround, LEVEL, steepAt, surfaceAt, terrainHeight, type Ground } from "../sim/terrain";
import { cellOf, decodeSeen, exploreSize, type Ally, type Contact, type Enemy, type Player, type State } from "../sim/state";
import { PAL, RARITY_CSS } from "./models";
import { NEIGHBOUR_SLOTS, neighbourNameByCode, routeOpen, type Neighbour } from "../meta/neighbours";
import { UI, alpha } from "./palette";

/*
 * The world map (M, or the map button on a phone): every region and the ways between
 * them. The HUD shows no markers or distances, so this is where the player finds the
 * POIs and the ways off. The ground and buildings are drawn once; each open frame scales
 * them to the map's size on screen and adds the names, the player, the teammate and
 * which POIs are cleared, with text at a fixed size on screen. North (-z) is up, as on
 * the compass. Ground the player has not walked near (`State.seen`) lies under fog; the
 * POIs and exits show through it, since the map is how a first raid finds its way.
 *
 * Framing (docs/ringfall/map-readability.md): fit the framed bounds with a pad so edge
 * names stay whole; the raid map opens on the region the player is in and switches to the
 * whole world (N); the departure opens on the whole island. Wheel and pinch zoom, drag to
 * pan, within the fitted frame; off-screen goals get an edge arrow.
 */

/** A rectangle of the world in metres. */
type View = { x0: number; z0: number; x1: number; z1: number };
const WHOLE: View = { x0: WORLD.x0, z0: WORLD.z0, x1: WORLD.x1, z1: WORLD.z1 };

/** Metres of empty margin around a fitted view so names and marks near the edge stay whole. */
export const VIEW_PAD = 110;
/** Closest zoom: fitted view divided by this. */
const ZOOM_MAX = 4;
/** Screen-edge inset for off-screen goal arrows, in CSS pixels. */
const EDGE_INSET = 18;

/** Metres per map pixel of the ground image. */
const CELL = 1.5;

const css = (c: number) => `#${c.toString(16).padStart(6, "0")}`;

/**
 * Each node's holder on the maps and the island's row of marks: the enemy's red and the
 * player's blue, which read on the sand and stay apart from the loot's colours. The titan's pad,
 * the enemy's for good, has a mark of its own in the robots' armour.
 */
export const HOLD_CSS: Record<"foe" | "own", string> = { foe: UI.foe, own: UI.own };

/** Another player's colour on the maps: a green, apart from the two sides', the rogues' violet and the ways off' yellow. */
export const RIVAL_CSS = UI.rival;

/** The colour of a node held `h`: the enemy's, the player's, or another player's. */
export const holdCss = (h: PoiHold) => (h === "foe" || h === "own" ? HOLD_CSS[h] : RIVAL_CSS);

/**
 * A flare as the HUD's icon draws it, centred on (x, y) and `r` tall from its middle: a red stick
 * under a yellow flame, lit; a grey outline when the flare is gone (its bin searched).
 */
export function drawFlare(g: CanvasRenderingContext2D, x: number, y: number, r: number, lit: boolean) {
  g.save();
  // A dark disc behind it, so it reads on the red and blue ground alike.
  g.fillStyle = alpha(UI.night, 0.75);
  g.beginPath();
  g.arc(x, y, r * 1.15, 0, Math.PI * 2);
  g.fill();
  g.lineWidth = Math.max(1, r * 0.18);
  g.strokeStyle = lit ? alpha(UI.night, 0.9) : UI.slate;
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
    g.fillStyle = UI.ring;
    g.fill();
  }
  g.stroke();
  flame();
  if (lit) {
    g.fillStyle = UI.hotLight;
    g.fill();
  }
  g.stroke();
  g.restore();
}

/**
 * What to take before node `node` can be captured, by name: a core is shielded until a node next
 * to it is the player's, so its neighbours on the front (else all its neighbours).
 */
export function shieldedBy(holds: readonly NodeHold[], node: number): string {
  const front = frontNodes(holds);
  const near = NEIGHBOURS[node];
  const take = near.filter((k) => front[k]);
  return (take.length ? take : near).map((k) => NODES[k].name).join("・");
}

/** What a padlocked node's note on the map says: how to open its core to capture. */
export const lockReason = (holds: readonly NodeHold[], node: number) => `先に${shieldedBy(holds, node)}を制圧する`;

/** The enemy's nodes off the front, whose cores refuse capture: the map puts a padlock on each. */
export function lockedNodes(holds: readonly NodeHold[]): boolean[] {
  const front = frontNodes(holds);
  return NODES.map((_, i) => holds[i] !== "own" && !front[i]);
}

/** The padlock of `lockIcon()` (icons.ts) in its 16-unit box, so the map's lock matches the page's. */
const LOCK_SHACKLE = "M5.3 7 V5 a2.7 2.7 0 0 1 5.4 0 V7";
const LOCK_BODY = "M4.7 7 H11.3 A1.2 1.2 0 0 1 12.5 8.2 V13.3 A1.2 1.2 0 0 1 11.3 14.5 H4.7 A1.2 1.2 0 0 1 3.5 13.3 V8.2 A1.2 1.2 0 0 1 4.7 7 Z";

/** A padlock centred on (x, y), `s` across, in `color` on a dark disc that keeps it readable on any ground. */
export function drawLock(g: CanvasRenderingContext2D, x: number, y: number, s: number, color: string) {
  g.save();
  g.fillStyle = alpha(UI.night, 0.92);
  g.beginPath();
  g.arc(x, y, s * 0.62, 0, Math.PI * 2);
  g.fill();
  // The icon's padlock is centred on (8, 8.4) of its box.
  const k = (s * 0.85) / 16;
  g.translate(x - 8 * k, y - 8.4 * k);
  g.scale(k, k);
  g.fillStyle = color;
  g.fill(new Path2D(LOCK_BODY));
  g.strokeStyle = color;
  g.lineWidth = 1.8;
  g.stroke(new Path2D(LOCK_SHACKLE));
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
  g.strokeStyle = alpha(UI.night, 0.9);
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
    g.fillStyle = alpha(UI.night, 0.82);
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
    g.strokeStyle = UI.paper;
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
    g.strokeStyle = UI.paper;
    g.lineWidth = 1.4 * dpr;
    g.beginPath();
    g.moveTo(cx + s * 0.2, y + s * 0.9);
    g.lineTo(cx + s * 0.2, y - s * 0.9);
    g.stroke();
    g.fillStyle = HOLD_CSS.own;
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
    g.fillStyle = UI.alert;
    g.beginPath();
    g.moveTo(cx, y - s * 0.6);
    g.lineTo(cx + s * 1.6, y - s * 0.6);
    g.lineTo(cx + s * 0.8, y + s * 0.7);
    g.closePath();
    g.fill();
    cx += s * 2.3;
  }
  // The smaller gifts, each a mark of its own: a heal's cross in its colour, the leap's wing, a mod part's hexagon, a turret.
  if (u.heal) {
    plate(s * 1.4);
    g.fillStyle = u.heal === "cell" || u.heal === "battery" ? UI.r1 : UI.foeBright;
    const k = u.heal === "battery" || u.heal === "medkit" ? 1.15 : 0.85;
    g.fillRect(cx + s * 0.7 - s * 0.22 * k, y - s * 0.7 * k, s * 0.44 * k, s * 1.4 * k);
    g.fillRect(cx + s * 0.7 - s * 0.7 * k, y - s * 0.22 * k, s * 1.4 * k, s * 0.44 * k);
    cx += s * 2.1;
  }
  if (u.ult) {
    plate(s * 1.6);
    g.fillStyle = UI.r3;
    for (const dy of u.ult >= 1 ? [-0.55, 0.25] : [-0.15]) {
      g.beginPath();
      g.moveTo(cx, y + s * (dy + 0.5));
      g.lineTo(cx + s * 0.8, y + s * (dy - 0.3));
      g.lineTo(cx + s * 1.6, y + s * (dy + 0.5));
      g.lineTo(cx + s * 0.8, y + s * (dy + 0.15));
      g.closePath();
      g.fill();
    }
    cx += s * 2.3;
  }
  if (u.mod) {
    plate(s * 1.5);
    g.fillStyle = RARITY_CSS[2];
    g.beginPath();
    for (let k = 0; k < 6; k++) {
      const a = (Math.PI / 3) * k;
      const px = cx + s * 0.75 + Math.cos(a) * s * 0.75;
      const py = y + Math.sin(a) * s * 0.75;
      if (k) g.lineTo(px, py);
      else g.moveTo(px, py);
    }
    g.closePath();
    g.fill();
    cx += s * 2.2;
  }
  if (u.turret) {
    plate(s * 1.6);
    g.fillStyle = HOLD_CSS.own;
    g.fillRect(cx + s * 0.2, y - s * 0.1, s * 1.1, s * 0.9);
    g.fillRect(cx + s * 0.6, y - s * 0.7, s * 1.1, s * 0.35);
    cx += s * 2.3;
  }
  if (u.shore) {
    plate(s * 2.0);
    // A red boat, struck through.
    g.fillStyle = HOLD_CSS.foe;
    g.beginPath();
    g.moveTo(cx, y);
    g.lineTo(cx + s * 2, y);
    g.lineTo(cx + s * 1.6, y + s * 0.6);
    g.lineTo(cx + s * 0.4, y + s * 0.6);
    g.closePath();
    g.fill();
    g.fillRect(cx + s * 0.9, y - s * 0.7, s * 0.25, s * 0.7);
    g.strokeStyle = UI.paper;
    g.lineWidth = 1.6 * dpr;
    g.beginPath();
    g.moveTo(cx - s * 0.1, y + s * 0.8);
    g.lineTo(cx + s * 2.1, y - s * 0.8);
    g.stroke();
  }
  g.restore();
}
export const TITAN_CSS = UI.titan;
/** The outposts' mark: places to loot that nobody's colour claims. */
const OUTPOST_CSS = UI.parchDim;
/**
 * The rogues' (野良機) colour on maps: a violet, kept apart from the enemy's red and the ways off'
 * yellow diamonds (on the island their armour stays amber).
 */
export const ROGUE_CSS = UI.rogue;

/**
 * What the map draws: a raid's state, or the camp's picture of the island between raids (the
 * explored map, the depots on, the routes open, each POI's standing) with no one on it.
 */
export type MapScene = Pick<State, "seen" | "cleared" | "hold" | "depots" | "routes" | "found"> & {
  player?: Pick<Player, "pos" | "yaw">;
  ally?: Pick<Ally, "active" | "pos" | "down">;
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
  /** The titan's pad is open to the decisive battle (`FINALE`): a gold ring round it. */
  finale?: boolean;
  friends?: readonly Enemy[];
  enemies?: readonly Enemy[];
  /** The raid's bins, for the flares still lying on the tall buildings' top floors; without them every flare bin is drawn as not yet searched. */
  bins?: readonly { x: number; z: number; flare: boolean; open: boolean }[];
  /** Ways in learned by the raid just ended (the results), ringed as they turn solid. */
  learned?: readonly EntryId[];
  /** The nodes that changed hands overnight (the results): a ring in the colour they turned. */
  changed?: { gained: readonly NodeId[]; lost: readonly NodeId[]; /** Nodes whose other player changed (the results), the player's unchanged. */ moved?: readonly NodeId[] };
  /** The only POIs whose names are written (a small map's), or every POI's when absent. */
  names?: readonly PoiId[];
};

/** A label's box on the canvas, so labels do not overlap. */
type Rect = { x0: number; y0: number; x1: number; y1: number };

/** The sides' colours on the battle map: the player's blue, the enemy's red, the rogues' violet, another player's green. */
export const SIDE_CSS: Record<Side, string> = { 0: UI.ownBright, 1: UI.alert, 2: ROGUE_CSS, 3: RIVAL_CSS };

/** The camp's picture of the island between raids, from the profile's explored map, depots, routes and POI standings. */
export function islandScene(p: { seen: string; depots: readonly PoiId[]; routes: readonly RouteId[]; poiState: Record<PoiId, { state: PoiHold }>; freedAt?: Partial<Record<PoiId, number>>; day?: number; seed?: number }): MapScene {
  return {
    seen: decodeSeen(p.seen),
    cleared: POIS.map(() => false),
    hold: POIS.map((o) => p.poiState[o.id].state),
    depots: DEPOTS.map((d) => p.depots.includes(d.poi)),
    routes: [...p.routes],
    found: [],
    best: POIS.map((o) => p.freedAt?.[o.id] ?? 0),
    nodes: nodeHolds((id) => p.poiState[id].state),
    finale: finaleOpen(p),
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
      if (region === HOME_REGION.id && Math.hypot(camp.x - x, camp.z - z) < Math.min(best, 110)) who = -2;
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
  const cols4 = { own: rgb(HOLD_CSS.own), foe: rgb(HOLD_CSS.foe), rival: rgb(RIVAL_CSS) };
  const mine = (k: number) => k === -2 || (k >= 0 && nodes[k] === "own");
  for (let n = 0; n < cols * rows; n++) {
    const k = own[n];
    if (k === -1) continue;
    const h = k === -2 ? "own" : nodes[k];
    const col = h === "own" || h === "foe" ? cols4[h] : cols4.rival;
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
  /** The region framed when the scene has no player on it (the departure's map). */
  region: RegionId = HOME_REGION.id;
  /**
   * Cleared by callers that once marked a taken contract; always null (quest board removed).
   * Kept so hub/depart can still assign without a type error during the cutover.
   */
  contract: null = null;
  /** A short local look-ping (P): a pulse on the map until the HUD clears it. */
  ping: { x: number; z: number } | null = null;
  /** Async look-marks from the island DO (ux-design M6), drawn faint in rival green. */
  remotePings: readonly { x: number; z: number }[] = [];
  /** Async attack/defence traces on bins/roads (ux-design M5), view-only. */
  traces: readonly { x: number; z: number; t: "bin" | "road"; mode?: "raid" | "hold" }[] = [];
  /** POIs that drop the hunt target (目標); marked on the raid / departure map. */
  goalPois: readonly string[] = [];
  /** The shape last given to the page, which sizes the map by it. */
  private aspect = 0;
  /** The last draw's scale and offset in CSS pixels, for `screenAt()`. */
  private proj: { m: number; ox: number; oy: number } | null = null;
  /** Whether the enemy's nodes off the front carry a padlock; the results' small map, which tells the day's changes, leaves them out. */
  locks = true;
  /** Who holds each node and what changed, and nothing else: no names but the scene's, no ways off, depots, routes or what a node opens. The results' map. */
  plain = false;
  /** Other players' islands the server offers this one (meta/neighbours.ts), drawn out at sea on the camp's maps. */
  neighbours: readonly Neighbour[] = [];
  /**
   * The minimap (the HUD's corner): half the side of the square it shows round the player, in metres,
   * and 0 for a map. It draws who holds the ground, the nodes, the ways off as marks, the teammate and
   * the player, and no names: the map (M) is where they are read.
   */
  mini = 0;
  /** What holding each node opens, as small marks beside it: the departure's (a raid's map leaves them out, to read at a glance). */
  unlocks = true;
  /** The node whose padlock was picked, its note drawn beside it; -1 with none. */
  picked = -1;
  /** The padlocks at the last draw, each with its node's mark, in CSS pixels from the canvas's top left. */
  private lockAt: { node: number; x: number; y: number; cx: number; cy: number }[] = [];
  /** The scene last drawn, drawn again when a pick changes the note. */
  private last: MapScene | null = null;
  /**
   * Zoom and pan over the fitted frame: zoom 1 is fit-to-content, higher is closer; ox/oz shift
   * the centre in metres. The minimap ignores it.
   */
  cam = { zoom: 1, ox: 0, oz: 0 };
  /** Called after a pan or zoom so a host (the departure) can re-lay marks. */
  private onNav: (() => void) | null = null;
  private navBound = false;
  private drag: { x: number; y: number; ox: number; oz: number } | null = null;
  private pinch: { dist: number; zoom: number } | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {}

  /** Back to the fitted view (zoom 1, no pan). */
  resetCam() {
    this.cam = { zoom: 1, ox: 0, oz: 0 };
  }

  /**
   * Wheel, drag and pinch on this canvas. Safe to call more than once. `onNav` runs after a change
   * (the departure re-lays its starts). The minimap does not bind.
   */
  bindNav(onNav?: () => void) {
    if (this.mini) return;
    if (onNav) this.onNav = onNav;
    if (this.navBound) return;
    this.navBound = true;
    const el = this.canvas;
    el.style.touchAction = "none";
    el.addEventListener(
      "wheel",
      (e) => {
        if (!this.last) return;
        e.preventDefault();
        const r = el.getBoundingClientRect();
        const old = this.proj;
        const wx = old ? WORLD.x0 + (e.clientX - r.left - old.ox) / old.m : 0;
        const wz = old ? WORLD.z0 + (e.clientY - r.top - old.oy) / old.m : 0;
        const next = Math.min(ZOOM_MAX, Math.max(1, this.cam.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
        if (next === this.cam.zoom) return;
        this.cam.zoom = next;
        this.clampCam(this.last);
        this.draw(this.last);
        // Keep the cursor's world point under the cursor after zooming in.
        // Subtract: a larger cam.ox shifts the view +x and moves drawn points left on screen.
        if (old && this.proj && next > 1) {
          const after = this.screenAt(wx, wz);
          if (after) {
            this.cam.ox -= (e.clientX - r.left - after.x) / this.proj.m;
            this.cam.oz -= (e.clientY - r.top - after.y) / this.proj.m;
            this.clampCam(this.last);
            this.draw(this.last);
          }
        }
        this.onNav?.();
      },
      { passive: false },
    );
    el.addEventListener("pointerdown", (e) => {
      if (!this.last || e.button !== 0) return;
      // Two fingers: pinch; one finger / mouse: pan (padlock pick still runs on the page's capture).
      if (e.pointerType === "touch" && (el as HTMLElement & { _pts?: Map<number, PointerEvent> })._pts?.size) {
        return;
      }
      this.drag = { x: e.clientX, y: e.clientY, ox: this.cam.ox, oz: this.cam.oz };
      el.setPointerCapture(e.pointerId);
      el.style.cursor = "grabbing";
    });
    el.addEventListener("pointermove", (e) => {
      if (!this.drag || !this.last || !this.proj) return;
      this.cam.ox = this.drag.ox - (e.clientX - this.drag.x) / this.proj.m;
      this.cam.oz = this.drag.oz - (e.clientY - this.drag.y) / this.proj.m;
      this.clampCam(this.last);
      this.draw(this.last);
      this.onNav?.();
    });
    const endDrag = () => {
      this.drag = null;
      el.style.cursor = "";
    };
    el.addEventListener("pointerup", endDrag);
    el.addEventListener("pointercancel", endDrag);
    el.addEventListener("dblclick", () => {
      if (!this.last) return;
      this.resetCam();
      this.draw(this.last);
      this.onNav?.();
    });
    // Pinch: track active touch points on the element.
    const pts = new Map<number, PointerEvent>();
    (el as HTMLElement & { _pts?: Map<number, PointerEvent> })._pts = pts;
    el.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "touch") return;
      pts.set(e.pointerId, e);
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        this.pinch = { dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), zoom: this.cam.zoom };
        this.drag = null;
      }
    });
    el.addEventListener("pointermove", (e) => {
      if (e.pointerType !== "touch" || !pts.has(e.pointerId)) return;
      pts.set(e.pointerId, e);
      if (pts.size === 2 && this.pinch && this.last) {
        const [a, b] = [...pts.values()];
        const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        if (this.pinch.dist > 0) {
          this.cam.zoom = Math.min(ZOOM_MAX, Math.max(1, this.pinch.zoom * (dist / this.pinch.dist)));
          this.clampCam(this.last);
          this.draw(this.last);
          this.onNav?.();
        }
      }
    });
    const endTouch = (e: PointerEvent) => {
      pts.delete(e.pointerId);
      if (pts.size < 2) this.pinch = null;
    };
    el.addEventListener("pointerup", endTouch);
    el.addEventListener("pointercancel", endTouch);
  }

  /** Keeps pan so the zoomed window stays over the fitted frame. */
  private clampCam(s: MapScene) {
    const fit = this.fitView(s);
    const z = this.cam.zoom;
    if (z <= 1) {
      this.cam.zoom = 1;
      this.cam.ox = 0;
      this.cam.oz = 0;
      return;
    }
    const maxX = ((fit.x1 - fit.x0) / 2) * (1 - 1 / z);
    const maxZ = ((fit.z1 - fit.z0) / 2) * (1 - 1 / z);
    this.cam.ox = Math.max(-maxX, Math.min(maxX, this.cam.ox));
    this.cam.oz = Math.max(-maxZ, Math.min(maxZ, this.cam.oz));
  }

  /**
   * A click or tap at (clientX, clientY): on a padlock or its node's mark it shows that node's note
   * (a second one on the same lock hides it), anywhere else on the map it hides the note. Returns
   * whether it landed on a padlock, for the page to answer with a sound.
   */
  pick(clientX: number, clientY: number): boolean {
    const r = this.canvas.getBoundingClientRect();
    const x = clientX - r.left;
    const y = clientY - r.top;
    if (x < 0 || y < 0 || x > r.width || y > r.height) return false;
    // A finger's width round the padlock, and the node's mark itself.
    const hit = this.lockAt.find((q) => Math.hypot(q.x - x, q.y - y) < 14 || Math.hypot(q.cx - x, q.cy - y) < 10);
    const next = hit && hit.node !== this.picked ? hit.node : -1;
    if (next !== this.picked) {
      this.picked = next;
      if (this.last) this.draw(this.last);
    }
    return !!hit;
  }

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
   * The fitted part of the world (before zoom/pan), with a pad so edge names stay whole. The
   * region's frame grows to take in the player, who may stand on the way between the regions.
   */
  fitView(s: MapScene): View {
    if (this.mini && s.player) {
      const { x, z } = s.player.pos;
      return { x0: x - this.mini, z0: z - this.mini, x1: x + this.mini, z1: z + this.mini };
    }
    let v: View;
    if (this.whole) v = { ...WHOLE };
    else if (!s.player) v = { ...regionOf(this.region).bounds };
    else {
      const b = regionHere(s.player.pos).bounds;
      const { x, z } = s.player.pos;
      const pad = 40;
      v = {
        x0: Math.min(b.x0, x - pad),
        z0: Math.min(b.z0, z - pad),
        x1: Math.max(b.x1, x + pad),
        z1: Math.max(b.z1, z + pad),
      };
    }
    const p = VIEW_PAD;
    return { x0: v.x0 - p, z0: v.z0 - p, x1: v.x1 + p, z1: v.z1 + p };
  }

  /**
   * The part of the world on show: the fitted frame, then zoom and pan. The minimap stays a
   * square round the player.
   */
  view(s: MapScene): View {
    const fit = this.fitView(s);
    if (this.mini || this.cam.zoom <= 1) return fit;
    const z = this.cam.zoom;
    const cx = (fit.x0 + fit.x1) / 2 + this.cam.ox;
    const cz = (fit.z0 + fit.z1) / 2 + this.cam.oz;
    const hw = (fit.x1 - fit.x0) / 2 / z;
    const hh = (fit.z1 - fit.z0) / 2 / z;
    return { x0: cx - hw, z0: cz - hh, x1: cx + hw, z1: cz + hh };
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
      asphalt: [0x6a, 0x70, 0x77],
      caliche: [0xee, 0xea, 0xde],
      gravel: [0xa8, 0x9c, 0x92],
    };
    const water = [0x5f, 0xa8, 0xa6];
    const lot = [0x9c, 0xa1, 0xa5];
    const paint = (x: number, z: number, lv: number) => {
      const at = surfaceAt(x, z);
      if (at === "水路") return water;
      const g = groundOf(at);
      // East of the dried strait the open ground is the city's grey paving, and west of the dry
      // canyon the launch site's caliche, as the view paints them (ground.ts).
      return g ? GROUND[g] : x > 620 ? lot : x < -605 ? GROUND.caliche : floor(lv);
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
    // Cells are only ever uncovered, so the count of seen cells says whether the fog changed —
    // without scanning the whole grid for a sum when nothing moved.
    let count = 0;
    for (let i = 0; i < seen.length; i++) count += seen[i];
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
      g.strokeStyle = alpha(UI.night, 0.95);
      g.fillStyle = SIDE_CSS[m.side];
      if (m.live) {
        g.fill();
        g.stroke();
      } else {
        g.fillStyle = alpha(UI.night, 0.6);
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
        g.strokeStyle = alpha(UI.alert, Number((1 - k).toFixed(2)));
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
    this.last = s;
    // The minimap draws as plainly as the results' map, but keeps the ways off (as marks) and the player.
    const plain = this.plain || this.mini > 0;
    if (shared?.key !== worldKey()) shared = { key: worldKey(), image: this.build() };
    const base = shared.image;
    const g = this.canvas.getContext("2d")!;
    const v = this.view(s);
    const aspect = (v.x1 - v.x0) / (v.z1 - v.z0);
    // The page sizes the map by this, so it keeps the shape of what it shows.
    if (aspect !== this.aspect) this.canvas.style.setProperty("--map-aspect", `${(this.aspect = aspect)}`);
    // Drawn at the size it is shown, so names stay readable however tall the world is.
    // Reassigning canvas.width clears the buffer and reallocates GPU memory: skip when unchanged
    // (the minimap redraws a few times a second and was paying this every time).
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = Math.round((this.canvas.clientWidth || this.width) * dpr);
    const h = Math.round((this.canvas.clientHeight || this.height) * dpr);
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    // Screen pixels per metre, the view centred in the canvas (whose shape follows it a frame late when it changes).
    const m = Math.min(w / (v.x1 - v.x0), h / (v.z1 - v.z0));
    const ox = (w - (v.x1 - v.x0) * m) / 2 - (v.x0 - WORLD.x0) * m;
    const oy = (h - (v.z1 - v.z0) * m) / 2 - (v.z0 - WORLD.z0) * m;
    this.proj = { m: m / dpr, ox: ox / dpr, oy: oy / dpr };
    g.fillStyle = UI.board;
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
      g.strokeStyle = UI.paper;
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
    // The ziplines up, thin blue lines along their cables (the quarry's lifts in grey): the
    // network the nodes held join. The minimap only strokes cables that cross its view (a long
    // span can pass through without either endpoint inside the square).
    const segHits = (a: { x: number; z: number }, b: { x: number; z: number }) => {
      // Liang–Barsky clip of the segment against the view: any surviving parameter range means it crosses.
      let t0 = 0;
      let t1 = 1;
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const clip = (p: number, q: number) => {
        if (p === 0) return q >= 0;
        const r = q / p;
        if (p < 0) {
          if (r > t1) return false;
          if (r > t0) t0 = r;
        } else {
          if (r < t0) return false;
          if (r < t1) t1 = r;
        }
        return true;
      };
      return clip(-dx, a.x - v.x0) && clip(dx, v.x1 - a.x) && clip(-dz, a.z - v.z0) && clip(dz, v.z1 - a.z) && t0 <= t1;
    };
    g.save();
    g.lineCap = "round";
    ZIPS.forEach((l, i) => {
      if (!zipUp({ nodes: s.nodes ?? [] }, i)) return;
      if (this.mini) {
        let hit = false;
        for (let k = 1; k < l.pts.length; k++) if (segHits(l.pts[k - 1], l.pts[k])) {
          hit = true;
          break;
        }
        if (!hit) return;
      }
      g.strokeStyle = l.fixed ? alpha(UI.mist, 0.9) : UI.ownLight;
      g.lineWidth = (l.fixed ? 1.2 : 1.6) * dpr;
      g.beginPath();
      l.pts.forEach((q, k) => {
        const c = at(q.x, q.z);
        if (k) g.lineTo(c.x, c.y);
        else g.moveTo(c.x, c.y);
      });
      g.stroke();
    });
    g.restore();
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.lineWidth = 3 * dpr;
    g.lineJoin = "round";
    g.strokeStyle = alpha(UI.night, 0.85);
    const font = (size: number) => `800 ${size * dpr}px system-ui, sans-serif`;
    // A point still on (or just past) the canvas: off-view names are skipped, not pinned to the edge.
    const onScreen = (x: number, y: number, margin = 20 * dpr) => x >= -margin && y >= -margin && x <= g.canvas.width + margin && y <= g.canvas.height + margin;
    // A centred name near the framed edge is moved in so it stays whole — only for points already on screen.
    const inside = (text: string, x: number, y: number) => {
      g.font = font(12);
      const half = g.measureText(text).width / 2 + 4 * dpr;
      const yy = Math.max(10 * dpr, Math.min(g.canvas.height - 10 * dpr, y));
      return { x: Math.max(half, Math.min(g.canvas.width - half, x)), y: yy };
    };
    const label = (text: string, x: number, y: number, color: string, size: number, stroke = true) => {
      if (!onScreen(x, y)) return;
      g.font = font(size);
      if (g.textAlign === "center") {
        const p = inside(text, x, y);
        x = p.x;
        y = p.y;
      }
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
      const p = left ? { x, y } : inside(text, x, y);
      const x0 = left ? x : p.x - w / 2;
      return { x0, y0: p.y - hh, x1: x0 + w, y1: p.y + hh };
    };
    const taken: Rect[] = [];
    const free = (r: Rect) => !taken.some((t) => r.x0 < t.x1 && r.x1 > t.x0 && r.y0 < t.y1 && r.y1 > t.y0);
    // A POI the enemy held as the raid began and the player cleared gets a tick after its name; who holds it is its mark's colour.
    const hold = (i: number): PoiHold => s.hold?.[i] ?? "foe";
    const poiText = (i: number) => (s.cleared[i] && hold(i) === "foe" ? `${POIS[i].name} ✓` : POIS[i].name);
    // 方向 A: rival holds (esp. contested coastal hubs) show the owner's name (AI tagged) under the mark.
    const rivalWho = (i: number): string | null => {
      const owner = rivalOf(hold(i));
      if (!owner) return null;
      if (isAiOwner(owner)) {
        const n = neighbourNameByCode(owner, this.neighbours);
        return n ? `${n} AI` : "AI";
      }
      return neighbourNameByCode(owner, this.neighbours) ?? "他のプレイヤー";
    };
    // Another player's POI starts cleared (it stands no garrison): its name is not dimmed for it.
    const dim = (i: number) => s.cleared[i] && rivalOf(hold(i)) === null;
    // The POI names written: those the scene names (the nodes that changed hands come first), and of
    // the rest none that would cover a name already placed, so a small map shows fewer, whole names.
    const changedIds: readonly string[] = [...(s.changed?.gained ?? []), ...(s.changed?.lost ?? [])];
    const order = POIS.map((_, i) => i).sort((a, b) => Number(changedIds.includes(POIS[b].id)) - Number(changedIds.includes(POIS[a].id)));
    const named: number[] = [];
    for (const i of order) {
      if (s.names && !s.names.includes(POIS[i].id)) continue;
      const p = at(POIS[i].x, POIS[i].z);
      // Off the framed view: leave the name out (an edge arrow points at goals instead).
      if (!onScreen(p.x, p.y)) continue;
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
    // The neighbours: other players' islands out at sea, each at a slot of its own, in their green,
    // with whose it is and how many of its nodes its owner holds.
    // Drawn on any map handed them (the camp's two, the raid's), the departure's plain one included.
    for (const n of this.neighbours) {
      const k = n.slot;
      const slot = NEIGHBOUR_SLOTS[k];
      if (!slot) continue;
      const p = at(slot.x, slot.z);
      const r = 13 * dpr;
      if (p.x < -r || p.y < -r || p.x > g.canvas.width + r || p.y > g.canvas.height + r) continue;
      // The sea route from the coast's node: lit while the player holds that node, faint and dashed till then.
      const open = routeOpen(k, (id) => hold(poiIndex(id)) === "own");
      const shore = POIS[poiIndex(slot.shore)];
      const q = at(shore.x, shore.z);
      g.save();
      g.strokeStyle = open ? UI.rivalLight : alpha(UI.paper, 0.3);
      g.lineWidth = (open ? 2 : 1.5) * dpr;
      g.setLineDash(open ? [] : [4 * dpr, 5 * dpr]);
      g.beginPath();
      g.moveTo(q.x, q.y);
      g.lineTo(p.x, p.y);
      g.stroke();
      g.restore();
      g.save();
      g.fillStyle = alpha(UI.rival, open ? 0.6 : 0.3);
      g.strokeStyle = open ? UI.rivalLight : alpha(UI.rivalLight, 0.5);
      g.lineWidth = 1.5 * dpr;
      g.beginPath();
      // A low island: three overlapping rounds, the same shape for every neighbour.
      for (const [dx, dy, rr] of [
        [-0.55, 0.1, 0.7],
        [0.2, -0.15, 0.85],
        [0.75, 0.2, 0.6],
      ])
        g.ellipse(p.x + dx * r, p.y + dy * r, rr * r, rr * r * 0.7, 0, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      g.restore();
      g.textAlign = "center";
      // Whose island and how much of it they hold, in one line over it: a slot near the map's edge keeps it whole.
      label(`${n.name}${n.ai ? " AI" : ""} ${n.held}/${n.total}`, p.x, p.y - r - 4 * dpr, UI.paper, 11);
      taken.push({ x0: p.x - r * 1.6, y0: p.y - r - 12 * dpr, x1: p.x + r * 1.6, y1: p.y + r });
    }
    // Districts and landmarks between the POIs, small and muted under everything else.
    for (const d of plain ? [] : LANDMARKS) {
      // A district's name is learnt by going there.
      if (!s.seen[cellOf(d.x, d.z)]) continue;
      const p = at(d.x, d.z);
      if (!onScreen(p.x, p.y)) continue;
      const r = box(d.name, p.x, p.y, 10);
      if (!free(r)) continue;
      taken.push(r);
      label(d.name, p.x, p.y, UI.parch, 10);
    }
    // The ways in: a ring each, where a raid that does not start at a depot begins. One the base
    // does not offer yet, and this raid has not walked to, is faint and dashed: somewhere to aim for.
    for (const e of plain ? [] : ENTRIES) {
      const p = at(e.x, e.z);
      if (!onScreen(p.x, p.y)) continue;
      const known = !this.known || this.known.includes(e.id) || s.found.includes(e.id);
      const ink = known ? UI.parch : alpha(UI.parch, 0.5);
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
      label(text, p.x, p.y + 11 * dpr, known ? ink : UI.parchDim, 9);
    }
    for (const r of plain ? [] : REGIONS) {
      const p = at(r.label.x, r.label.z);
      if (!onScreen(p.x, p.y)) continue;
      if (!free(box(r.name, p.x, p.y, 15, true))) continue;
      g.textAlign = "left";
      label(r.name, p.x, p.y, alpha(UI.parch, 0.55), 15, false);
      g.textAlign = "center";
    }
    (plain && !this.mini ? [] : EXTRACTS).forEach((x, i) => {
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
      if (!this.mini) label(x.short, exitAt[i].x, exitAt[i].y, css(PAL.hot), 10);
      // The plateau's pickup wants a flare: the flare's mark rides on its diamond's shoulder.
      if (x.needsFlare) drawFlare(g, p.x + r * 1.6, p.y - r * 1.2, 7 * dpr, true);
    });
    // Where the flares lie: the same mark on the tall buildings' top floors, grey once searched.
    const flares = s.bins ? s.bins.filter((b) => b.flare) : EXTRA_BINS.filter((b) => b.flare).map((b) => ({ ...b, open: false }));
    for (const b of plain ? [] : flares) {
      const p = at(b.x, b.z);
      drawFlare(g, p.x, p.y, 6.5 * dpr, !b.open);
    }
    // The routes a tool opens: open ones a solid line, closed ones dashed with a cross at each obstacle.
    for (const r of plain ? [] : ROUTES) {
      const open = s.routes.includes(r.id);
      g.save();
      g.lineWidth = 3 * dpr;
      g.strokeStyle = open ? UI.mateLight : UI.shut;
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
        label(text, m.x + 7 * dpr, m.y, open ? UI.mateLight : UI.peach, 9);
      }
      g.textAlign = "center";
    }
    // Depots that are on: a teal square each, a place a later raid can start from.
    (plain ? [] : DEPOTS).forEach((d, i) => {
      if (!s.depots[i]) return;
      const p = at(d.x, d.z);
      const r = 3.5 * dpr;
      g.fillStyle = UI.mateLight;
      g.strokeRect(p.x - r, p.y - r, r * 2, r * 2);
      g.fillRect(p.x - r, p.y - r, r * 2, r * 2);
    });
    // The outposts: a small grey square, a place to loot that is no node of the front.
    for (const o of plain ? [] : OUTPOST_SITES) {
      const p = at(o.x, o.z);
      const r = 3.5 * dpr;
      g.save();
      g.lineWidth = 1.5 * dpr;
      g.strokeStyle = alpha(UI.night, 0.9);
      g.fillStyle = OUTPOST_CSS;
      g.strokeRect(p.x - r, p.y - r, r * 2, r * 2);
      g.fillRect(p.x - r, p.y - r, r * 2, r * 2);
      g.restore();
    }
    // Squads seen or heard out between the POIs, fading over `FACTION.keep`: a dot in their
    // faction's colour where they were, and a burst where the factions were heard fighting.
    // Rival contacts read as another player's trace (ux-design M3): a thin ring around the dot.
    for (const c of plain ? [] : (s.contacts ?? [])) {
      const age = (s.time ?? c.t) - c.t;
      const p = at(c.x, c.z);
      g.save();
      g.globalAlpha = Math.max(0.25, 1 - age / FACTION.keep);
      g.fillStyle = c.rival ? RIVAL_CSS : c.rogue ? ROGUE_CSS : UI.alert;
      g.strokeStyle = alpha(UI.night, 0.9);
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
      if (c.rival) {
        g.beginPath();
        g.arc(p.x, p.y, 6 * dpr, 0, Math.PI * 2);
        g.strokeStyle = alpha(RIVAL_CSS, 0.7);
        g.lineWidth = 1.2 * dpr;
        g.stroke();
      }
      g.restore();
      if (c.fight && age < 20) {
        const spot = box("交戦", p.x, p.y - 11 * dpr, 9);
        if (free(spot)) {
          taken.push(spot);
          label("交戦", p.x, p.y - 11 * dpr, UI.hotLight, 9);
        }
      }
    }
    // Each POI's mark at its centre, coloured by who holds it: a disc, or the titan's hexagon.
    POIS.forEach((poi, i) => {
      const p = at(poi.x, poi.z);
      const r = 7 * dpr;
      g.save();
      g.lineWidth = 2.5 * dpr;
      g.strokeStyle = alpha(UI.night, 0.9);
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
        g.fillStyle = holdCss(hold(i));
      }
      g.fill();
      g.stroke();
      // 目標の材料が出る拠点: a light ring so the map points the hunt.
      if (!plain && this.goalPois.includes(poi.id)) {
        g.save();
        g.lineWidth = 2.5 * dpr;
        g.strokeStyle = alpha(UI.own, 0.95);
        g.beginPath();
        g.arc(p.x, p.y, r * 1.55, 0, Math.PI * 2);
        g.stroke();
        g.restore();
      }
      if (!poi.boss) {
        // The garrison's plate: a shield in the colour of the rarity that pierces it.
        if (!plain) drawShield(g, p.x, p.y + r * 0.06, r * 0.62, RARITY_CSS[TIER[poi.id as NodeId] ?? 0]);
        // What holding it opens, as small marks beside it: dim while the enemy holds it.
        if (!plain && this.unlocks) drawUnlocks(g, p.x + r * 1.45, p.y - r * 0.95, poi.id as NodeId, dpr, hold(i) === "own");
      }
      if (poi.boss && s.finale) {
        // Open to the decisive battle: a gold ring, pulsing.
        g.save();
        g.lineWidth = 3 * dpr;
        g.strokeStyle = alpha(UI.r3, Number((0.7 + 0.3 * Math.sin(performance.now() / 300)).toFixed(2)));
        g.beginPath();
        g.arc(p.x, p.y, r * 1.75, 0, Math.PI * 2);
        g.stroke();
        g.restore();
      }
      if (poi.boss) {
        // The titan's eye, in the robots' red.
        g.fillStyle = HOLD_CSS.foe;
        g.beginPath();
        g.arc(p.x, p.y, r * 0.38, 0, Math.PI * 2);
        g.fill();
      }
      // The highest threat it was freed at, as a gold number on a dark tab at the mark's lower right.
      const best = s.best?.[i] ?? 0;
      if (best > 0 && !plain) {
        g.font = `900 ${10 * dpr}px system-ui, sans-serif`;
        g.textAlign = "center";
        g.textBaseline = "middle";
        const bx = p.x + r * 1.15;
        const by = p.y + r * 0.9;
        g.fillStyle = alpha(UI.night, 0.92);
        g.fillRect(bx - 6 * dpr, by - 6 * dpr, 12 * dpr, 12 * dpr);
        g.fillStyle = UI.r3;
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
        g.strokeStyle = UI.paper;
        g.setLineDash([3 * dpr, 2.5 * dpr]);
        g.beginPath();
        g.arc(p.x, p.y, r, 0, Math.PI * 2);
        g.stroke();
        g.setLineDash([]);
        if (s.capture?.node === i) {
          g.lineWidth = 4 * dpr;
          g.strokeStyle = UI.r3;
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
          label(text, p.x + r + 16 * dpr, p.y, UI.paper, 9);
        }
      });
    }
    // The enemy's nodes off the front: a padlock at the mark's lower left, since their cores refuse
    // capture until a node next to them is the player's.
    const locked = this.locks && s.nodes ? lockedNodes(s.nodes) : [];
    this.lockAt = [];
    NODES.forEach((n, i) => {
      if (!locked[i]) return;
      const p = at(n.x, n.z);
      const q = { x: p.x - 10.5 * dpr, y: p.y + 7.5 * dpr };
      drawLock(g, q.x, q.y, 14 * dpr, i === this.picked ? UI.r3 : UI.paper);
      this.lockAt.push({ node: i, x: q.x / dpr, y: q.y / dpr, cx: p.x / dpr, cy: p.y / dpr });
    });
    if (!locked[this.picked]) this.picked = -1;
    if (s.battle && s.nodes) this.drawBattle(g, s, at, dpr, label);
    // The nodes that changed hands: a thick ring in the colour each turned (a node lost to another player, or passing between others, in theirs).
    const turned = (id: NodeId) => (s.nodes ? holdCss(s.nodes[nodeIndex(id)]) : HOLD_CSS.foe);
    for (const [ids, col] of [[s.changed?.gained ?? [], () => HOLD_CSS.own], [s.changed?.lost ?? [], turned], [s.changed?.moved ?? [], turned]] as const)
      for (const id of ids) {
        const n = NODES[nodeIndex(id)];
        const p = at(n.x, n.z);
        g.save();
        g.lineWidth = 4 * dpr;
        g.strokeStyle = col(id);
        g.beginPath();
        g.arc(p.x, p.y, 14 * dpr, 0, Math.PI * 2);
        g.stroke();
        g.restore();
      }
    // POI names go on top, a little above their mark, so an exit nearby does not hide them.
    // Rival holds also get the owner's name under the mark (E4).
    for (const i of this.mini ? [] : named) {
      const p = at(POIS[i].x, POIS[i].z);
      label(poiText(i), p.x, p.y - 15 * dpr, dim(i) ? UI.mist : UI.white, 12);
      const who = rivalWho(i);
      if (who) label(who, p.x, p.y + 14 * dpr, RIVAL_CSS, 9);
    }
    if (s.ally?.active) {
      const a = at(s.ally.pos.x, s.ally.pos.z);
      g.fillStyle = s.ally.down > 0 ? UI.alert : UI.mateLight;
      g.beginPath();
      g.arc(a.x, a.y, 4 * dpr, 0, Math.PI * 2);
      g.fill();
    }
    // Async traces (M5): raid = square/cross, hold = diamond — “誰かが先に攻めた／守った”.
    if (!plain && !this.mini)
      for (const tr of this.traces) {
        const q = at(tr.x, tr.z);
        g.save();
        g.globalAlpha = tr.mode === "hold" ? 0.4 : 0.5;
        g.strokeStyle = RIVAL_CSS;
        g.fillStyle = alpha(RIVAL_CSS, 0.35);
        g.lineWidth = 1.2 * dpr;
        if (tr.mode === "hold") {
          const r = 4 * dpr;
          g.beginPath();
          g.moveTo(q.x, q.y - r);
          g.lineTo(q.x + r, q.y);
          g.lineTo(q.x, q.y + r);
          g.lineTo(q.x - r, q.y);
          g.closePath();
          g.stroke();
        } else if (tr.t === "bin") {
          const r = 3.5 * dpr;
          g.strokeRect(q.x - r, q.y - r, r * 2, r * 2);
        } else {
          g.beginPath();
          g.moveTo(q.x - 5 * dpr, q.y);
          g.lineTo(q.x + 5 * dpr, q.y);
          g.moveTo(q.x, q.y - 4 * dpr);
          g.lineTo(q.x, q.y + 4 * dpr);
          g.stroke();
        }
        g.restore();
      }
    // Async look-marks from the island (M6): rival green, under the local cyan pulse.
    if (!plain)
      for (const rp of this.remotePings) {
        const q = at(rp.x, rp.z);
        g.save();
        g.strokeStyle = RIVAL_CSS;
        g.lineWidth = 1.5 * dpr;
        g.globalAlpha = 0.7;
        g.beginPath();
        g.arc(q.x, q.y, 7 * dpr, 0, Math.PI * 2);
        g.stroke();
        g.restore();
      }
    // A local look-ping (P): a cyan pulse, view-only.
    if (this.ping && !plain) {
      const q = at(this.ping.x, this.ping.z);
      g.save();
      g.strokeStyle = UI.ownLight;
      g.lineWidth = 2 * dpr;
      g.globalAlpha = 0.85;
      g.beginPath();
      g.arc(q.x, q.y, 8 * dpr, 0, Math.PI * 2);
      g.stroke();
      g.beginPath();
      g.arc(q.x, q.y, 3 * dpr, 0, Math.PI * 2);
      g.fillStyle = UI.ownLight;
      g.fill();
      g.restore();
    }
    // The player: an arrow pointing the way they face.
    const p = s.player;
    if (p) {
      const me = at(p.pos.x, p.pos.z);
      g.save();
      g.translate(me.x, me.y);
      g.rotate(p.yaw);
      g.scale(dpr, dpr);
      g.lineWidth = 3;
      g.fillStyle = UI.white;
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
    const reason = this.picked >= 0 && s.nodes ? lockReason(s.nodes, this.picked) : "";
    if (reason) this.drawNote(g, at(NODES[this.picked].x, NODES[this.picked].z), reason, dpr);
    // Off-screen goals: an arrow at the canvas edge (Into the Breach / Pokémon GO style).
    if (!plain && !this.mini) this.drawEdgeArrows(g, s, at, dpr);
    // For automation: where the padlocks stand and the note on show.
    const marks = JSON.stringify(this.lockAt.map((q) => [NODES[q.node].id, Math.round(q.x), Math.round(q.y)]));
    if (this.canvas.dataset.locks !== marks) this.canvas.dataset.locks = marks;
    if (this.canvas.dataset.reason !== reason) this.canvas.dataset.reason = reason;
    const ringed = s.nodes ? frontNodes(s.nodes) : [];
    const front = NODES.filter((_, i) => ringed[i]).map((n) => n.id).join(",");
    if (this.canvas.dataset.front !== front) this.canvas.dataset.front = front;
  }

  /**
   * Chevrons at the canvas edge toward goals that sit off the framed view: the player (when
   * panned away) and a node under threat.
   */
  private drawEdgeArrows(g: CanvasRenderingContext2D, s: MapScene, at: (x: number, z: number) => { x: number; y: number }, dpr: number) {
    const goals: { x: number; z: number; color: string }[] = [];
    if (s.player) goals.push({ x: s.player.pos.x, z: s.player.pos.z, color: UI.white });
    if (s.battle?.threat) s.battle.threat.forEach((hot, i) => hot && goals.push({ x: NODES[i].x, z: NODES[i].z, color: UI.alert }));
    // Front nodes only once the player has zoomed or panned: the fitted region already shows its own.
    if (!this.whole && this.cam.zoom > 1 && s.nodes) {
      const front = frontNodes(s.nodes);
      NODES.forEach((n, i) => front[i] && goals.push({ x: n.x, z: n.z, color: UI.paper }));
    }
    const inset = EDGE_INSET * dpr;
    const w = g.canvas.width;
    const h = g.canvas.height;
    for (const goal of goals) {
      const p = at(goal.x, goal.z);
      if (p.x >= inset && p.y >= inset && p.x <= w - inset && p.y <= h - inset) continue;
      const cx = w / 2;
      const cy = h / 2;
      const dx = p.x - cx;
      const dy = p.y - cy;
      if (dx === 0 && dy === 0) continue;
      // Clamp the ray from the centre to the inset rectangle.
      const sx = dx !== 0 ? ((dx > 0 ? w - inset : inset) - cx) / dx : Infinity;
      const sy = dy !== 0 ? ((dy > 0 ? h - inset : inset) - cy) / dy : Infinity;
      const t = Math.min(Math.abs(sx), Math.abs(sy));
      const x = cx + dx * t;
      const y = cy + dy * t;
      const ang = Math.atan2(dy, dx);
      const r = 7 * dpr;
      g.save();
      g.translate(x, y);
      g.rotate(ang);
      g.beginPath();
      g.moveTo(r, 0);
      g.lineTo(-r * 0.75, r * 0.7);
      g.lineTo(-r * 0.35, 0);
      g.lineTo(-r * 0.75, -r * 0.7);
      g.closePath();
      g.fillStyle = goal.color;
      g.strokeStyle = alpha(UI.night, 0.95);
      g.lineWidth = 1.5 * dpr;
      g.fill();
      g.stroke();
      g.restore();
    }
  }

  /** A picked padlock's note under its node's mark, on top of everything: a padlock and how to open the core. */
  private drawNote(g: CanvasRenderingContext2D, p: { x: number; y: number }, text: string, dpr: number) {
    g.save();
    g.font = `800 ${12 * dpr}px system-ui, sans-serif`;
    const pad = 7 * dpr;
    const icon = 13 * dpr;
    const room = g.canvas.width - 8 * dpr - icon - 5 * dpr - pad * 2;
    const lines = wrapNote(g, text, room);
    const lineH = 16 * dpr;
    const w = icon + 5 * dpr + Math.max(...lines.map((l) => g.measureText(l).width)) + pad * 2;
    const h = 8 * dpr + lineH * lines.length;
    // Under the mark, moved in to stay whole on the canvas, or over it near the bottom edge.
    const x = Math.max(4 * dpr, Math.min(g.canvas.width - w - 4 * dpr, p.x - w / 2));
    const below = p.y + 20 * dpr + h < g.canvas.height - 4 * dpr;
    const y = below ? p.y + 20 * dpr : p.y - 28 * dpr - h;
    g.fillStyle = alpha(UI.deep, 0.95);
    g.strokeStyle = UI.r3;
    g.lineWidth = 1.5 * dpr;
    g.beginPath();
    g.rect(x, y, w, h);
    g.fill();
    g.stroke();
    drawLock(g, x + pad + icon / 2, y + h / 2, icon * 1.25, UI.r3);
    g.fillStyle = UI.white;
    g.textAlign = "left";
    g.textBaseline = "middle";
    lines.forEach((l, k) => g.fillText(l, x + pad + icon + 5 * dpr, y + 4 * dpr + lineH * (k + 0.5) + 0.5 * dpr));
    g.restore();
  }
}

/** Lines of a note no wider than `room`, broken after a ・ where one fits, else between any two characters, since the names are Japanese. */
function wrapNote(g: CanvasRenderingContext2D, text: string, room: number): string[] {
  const lines: string[] = [];
  let rest = text;
  while (rest && g.measureText(rest).width > room) {
    let cut = 1;
    while (cut < rest.length && g.measureText(rest.slice(0, cut + 1)).width <= room) cut++;
    const dot = rest.lastIndexOf("・", cut - 1);
    if (dot > 0) cut = dot + 1;
    lines.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) lines.push(rest);
  return lines;
}
