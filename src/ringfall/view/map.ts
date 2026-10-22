import { DEPOT, FACTION, FRONT, NETWORK, RELAY, WORLD } from "../sim/config";
import { frontNodes, nodeHolds, type NodeHold, type OutpostHold } from "../sim/front";
import { offshore } from "../sim/terrain";
import { BOXES, CAMP, DEBRIS_SPOTS, NODES, debrisIndex, DEPOTS, ENTRIES, EXTRACTS, LANDMARKS, OUTPOST_SITES, POIS, REGIONS, regionOf, RELAYS, relayIndex, ROUTES, regionHere, territory, type EntryId, type Faction, type OutpostId, type PoiId, type RegionId, type RouteId } from "../sim/map";
import { HOLD_NAME, type IslandEvent, type PoiHold } from "../sim/island";
import { STREETS } from "../sim/streets";
import { worldKey } from "../sim/routes";
import { DAM_FACE, floorLevel, groundOf, highGround, LEVEL, steepAt, surfaceAt, terrainHeight, type Ground } from "../sim/terrain";
import { cellOf, decodeSeen, exploreSize, type Ally, type Contact, type Player, type RelayMast, type State } from "../sim/state";
import { PAL } from "./models";
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
 * Each POI's standing in the map's marks: muted brick red, amber and steel blue, which read on
 * the sand and stay apart from the loot's colours and the robots' red eyes. The titan's pad,
 * never freed, has a mark of its own in the robots' armour.
 */
export const HOLD_CSS: Record<PoiHold, string> = { held: "#b8412f", thin: "#d4892c", freed: "#3f7cae" };
export const TITAN_CSS = "#262d52";
/** The rogues' (野良機) amber, as their eyes burn: their outposts are squares, apart from the thin POIs' discs and the ways off' yellow diamonds. */
export const ROGUE_CSS = "#e8a628";

/**
 * What the map draws: a raid's state, or the camp's picture of the island between raids (the
 * explored map, the depots on, the routes open, each POI's standing) with no one on it.
 */
export type MapScene = Pick<State, "seen" | "cleared" | "hold" | "depots" | "routes" | "found"> & {
  player?: Pick<Player, "pos" | "yaw">;
  ally?: Pick<Ally, "active" | "pos" | "down">;
  /** The relay masts standing (none while the network is too weak for them), destroyed ones with no health left. */
  relays?: readonly Pick<RelayMast, "id" | "hp">[];
  /** The debris crate of the day's debris fall, or null. */
  debris?: { x: number; z: number; open: boolean } | null;
  /** The salvage crews' members in the player's sight. */
  crews?: readonly { x: number; z: number }[];
  /** The highest threat each POI was freed at (by POI index), shown by its mark when above 0. */
  best?: readonly number[];
  /** Who holds each outpost (`territory()`): the rogues' are marked in their yellow. */
  territory?: Record<OutpostId, Faction>;
  /** The squads the player has seen or heard out between the POIs, and the raid's clock they are timed by. */
  contacts?: readonly Contact[];
  time?: number;
  /** Who holds each node of the front (`NODES` order): the map paints the territory and the front line from it. */
  nodes?: readonly NodeHold[];
  /** The core capture under way, drawn as its meter round the node. */
  capture?: { node: number; t: number } | null;
};

/** The camp's picture of the island between raids, from the profile's explored map, depots, routes and POI standings. */
export function islandScene(p: { seen: string; depots: readonly PoiId[]; routes: readonly RouteId[]; poiState: Record<PoiId, { state: PoiHold }>; outposts?: Partial<Record<OutpostId, OutpostHold>>; network: number; events?: readonly (IslandEvent | null)[]; freedAt?: Partial<Record<PoiId, number>> }): MapScene {
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
    relays: p.network >= NETWORK.relayAt ? RELAYS.map((r) => ({ id: r.id, hp: RELAY.hp })) : [],
    debris: spot && { x: spot.x, z: spot.z, open: false },
    best: POIS.map((o) => p.freedAt?.[o.id] ?? 0),
    territory: territory(p.network),
    nodes: nodeHolds((id) => p.poiState[id].state, p.outposts, p.network),
  };
}

/** Each node's colour on the 戦況図: the player's blue, the network's red, thin orange, the rogues' amber. */
export const NODE_CSS: Record<NodeHold, string> = { freed: "#3f7cae", held: "#b8412f", thin: "#d4892c", rogue: "#e8a628" };

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
  const cols4 = { freed: rgb(NODE_CSS.freed), held: rgb(NODE_CSS.held), thin: rgb(NODE_CSS.thin), rogue: rgb(NODE_CSS.rogue) };
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

  constructor(private readonly canvas: HTMLCanvasElement) {}

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
    type Rect = { x0: number; y0: number; x1: number; y1: number };
    const box = (text: string, x: number, y: number, size: number, left = false): Rect => {
      g.font = font(size);
      const w = g.measureText(text).width;
      const hh = size * dpr * 0.6;
      const x0 = left ? x : inside(text, x) - w / 2;
      return { x0, y0: y - hh, x1: x0 + w, y1: y + hh };
    };
    const taken: Rect[] = [];
    const free = (r: Rect) => !taken.some((t) => r.x0 < t.x1 && r.x1 > t.x0 && r.y0 < t.y1 && r.y1 > t.y0);
    // A POI cleared this raid says so; otherwise its standing on the island, when it is not held.
    const hold = (i: number): PoiHold => s.hold?.[i] ?? "held";
    const poiText = (i: number) => (s.cleared[i] && hold(i) !== "freed" ? `${POIS[i].name}（制圧）` : hold(i) === "held" ? POIS[i].name : `${POIS[i].name}（${HOLD_NAME[hold(i)]}）`);
    POIS.forEach((poi, i) => {
      const p = at(poi.x, poi.z);
      taken.push(box(poiText(i), p.x, p.y - 15 * dpr, 12));
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
      g.restore();
      const text = known ? e.name : `${e.name}（未発見）`;
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
    });
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
      const text = open ? r.name : `${r.name}（閉）`;
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
    // The relay masts standing: a red triangle with the mast's eye, struck through once destroyed.
    for (const m of s.relays ?? []) {
      const r = RELAYS[relayIndex(m.id)];
      const p = at(r.x, r.z);
      const d = 7 * dpr;
      g.save();
      g.lineWidth = 2.5 * dpr;
      g.strokeStyle = "rgba(20,24,40,0.9)";
      g.fillStyle = m.hp > 0 ? HOLD_CSS.held : "#6b6f78";
      g.beginPath();
      g.moveTo(p.x, p.y - d);
      g.lineTo(p.x + d * 0.9, p.y + d * 0.65);
      g.lineTo(p.x - d * 0.9, p.y + d * 0.65);
      g.closePath();
      g.fill();
      g.stroke();
      if (m.hp > 0) {
        g.fillStyle = "#ffd0c4";
        g.beginPath();
        g.arc(p.x, p.y + d * 0.1, d * 0.22, 0, Math.PI * 2);
        g.fill();
      }
      g.restore();
      const text = m.hp > 0 ? r.name : `${r.name}（破壊）`;
      const spot = box(text, p.x, p.y + 14 * dpr, 9);
      if (free(spot)) {
        taken.push(spot);
        label(text, p.x, p.y + 14 * dpr, m.hp > 0 ? "#ffb4a2" : "#9c9586", 9);
      }
    }
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
      const text = s.debris.open ? "破片（空）" : "破片";
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
    // The outposts: a square in the colour of whoever holds it, the rogues' named.
    for (const o of OUTPOST_SITES) {
      const node = s.nodes?.[NODES.findIndex((n) => n.id === o.id)];
      const rogue = node ? node === "rogue" : s.territory?.[o.id] === "rogue";
      const p = at(o.x, o.z);
      const r = 4.5 * dpr;
      g.save();
      g.lineWidth = 2 * dpr;
      g.strokeStyle = "rgba(20,24,40,0.9)";
      g.fillStyle = node === "freed" ? NODE_CSS.freed : rogue ? ROGUE_CSS : HOLD_CSS.held;
      g.strokeRect(p.x - r, p.y - r, r * 2, r * 2);
      g.fillRect(p.x - r, p.y - r, r * 2, r * 2);
      g.restore();
      if (!rogue) continue;
      const text = `${o.name}（野良機）`;
      const spot = box(text, p.x, p.y + 12 * dpr, 9);
      if (free(spot)) {
        taken.push(spot);
        label(text, p.x, p.y + 12 * dpr, ROGUE_CSS, 9);
      }
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
    // The nodes on the front: a white ring with 前線 by it, where the player can strike next; the
    // capture under way as its meter round the ring.
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
        const text = s.capture?.node === i ? `制圧中 ${Math.floor((s.capture.t / FRONT.capture) * 100)}%` : "前線";
        const spot = box(text, p.x + r + 16 * dpr, p.y, 9);
        if (free(spot)) {
          taken.push(spot);
          label(text, p.x + r + 16 * dpr, p.y, "#f4f7ff", 9);
        }
      });
    }
    // POI names go on top, a little above their mark, so an exit nearby does not hide them.
    POIS.forEach((poi, i) => {
      const p = at(poi.x, poi.z);
      label(poiText(i), p.x, p.y - 15 * dpr, s.cleared[i] ? "#cfd6e0" : "#ffffff", 12);
    });
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
