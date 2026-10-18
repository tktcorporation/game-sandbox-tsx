import { DEPOT, WORLD } from "../sim/config";
import { BOXES, DEPOTS, ENTRIES, EXTRACTS, LANDMARKS, POIS, REGIONS, ROUTES, regionHere, type EntryId } from "../sim/map";
import { worldKey } from "../sim/routes";
import { DAM_FACE, floorLevel, highGround, LEVEL, steepAt, surfaceAt, terrainHeight } from "../sim/terrain";
import { cellOf, exploreSize, type State } from "../sim/state";
import { PAL } from "./models";

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

export class IslandMap {
  private base: HTMLCanvasElement | null = null;
  /** The world (`worldKey()`) the ground image was drawn from: a raid with other routes open redraws it. */
  private baseKey = "";
  /** One pixel per explored-map cell, redrawn each open frame and scaled over the ground. */
  private fog: HTMLCanvasElement | null = null;
  private readonly width = Math.ceil((WORLD.x1 - WORLD.x0) / CELL);
  private readonly height = Math.ceil((WORLD.z1 - WORLD.z0) / CELL);

  /** Whether the map shows the whole world rather than the region the player is in. */
  whole = false;
  /** The ways in the base offers; null when the map is drawn without a profile, as all of them. */
  known: EntryId[] | null = null;
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
  view(s: State): View {
    if (this.whole) return WHOLE;
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
    // Walkable ground by level: pit, lakebed, shore, then the high levels.
    const floor = (lv: number) =>
      lv <= LEVEL.pit + 0.5 ? [0x8f, 0x86, 0x74] : lv <= LEVEL.lakebed + 0.5 ? [0xb4, 0xa8, 0x8e] : lv < LEVEL.ridge - 0.5 ? [0xe2, 0xbf, 0x8a] : [0xf2, 0xda, 0xa8];
    // The harbor's salt flats, its paved town and quays, and its channel of water.
    const salt = [0xf2, 0xec, 0xdc];
    const paved = [0xd2, 0xc5, 0xa8];
    const water = [0x5f, 0xa8, 0xa6];
    const paint = (x: number, z: number, lv: number) => {
      const at = surfaceAt(x, z);
      if (at === "塩田" || at === "難破船") return salt;
      if (at === "水路") return water;
      if (at === "港町" || at === "埠頭" || at === "高架下") return paved;
      return floor(lv);
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

  draw(s: State) {
    if (this.baseKey !== worldKey()) this.base = null;
    this.baseKey = worldKey();
    this.base ??= this.build();
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
    g.drawImage(this.base, ox, oy, this.width * CELL * m, this.height * CELL * m);
    // Smoothed, so the fog's edge is soft rather than a staircase of 20 m squares.
    const { cols, rows } = exploreSize();
    g.drawImage(this.fogImage(s.seen), ox, oy, cols * DEPOT.cell * m, rows * DEPOT.cell * m);
    const at = (x: number, z: number) => ({ x: ox + (x - WORLD.x0) * m, y: oy + (z - WORLD.z0) * m });
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
    const poiText = (i: number) => (s.cleared[i] ? `${POIS[i].name}（制圧）` : POIS[i].name);
    POIS.forEach((poi, i) => {
      const p = at(poi.x, poi.z);
      taken.push(box(poiText(i), p.x, p.y - 9 * dpr, 12));
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
    // Depots that are on: a teal square each, a place a later raid can start from.
    DEPOTS.forEach((d, i) => {
      if (!s.depots[i]) return;
      const p = at(d.x, d.z);
      const r = 3.5 * dpr;
      g.fillStyle = "#6fd0cf";
      g.strokeRect(p.x - r, p.y - r, r * 2, r * 2);
      g.fillRect(p.x - r, p.y - r, r * 2, r * 2);
    });
    // POI names go on top, a little above their centre, so an exit nearby does not hide them.
    POIS.forEach((poi, i) => {
      const p = at(poi.x, poi.z);
      label(poiText(i), p.x, p.y - 9 * dpr, s.cleared[i] ? "#cfd6e0" : "#ffffff", 12);
    });
    if (s.ally.active) {
      const a = at(s.ally.pos.x, s.ally.pos.z);
      g.fillStyle = s.ally.down > 0 ? "#ff5a4f" : "#6fd0cf";
      g.beginPath();
      g.arc(a.x, a.y, 4 * dpr, 0, Math.PI * 2);
      g.fill();
    }
    // The player: an arrow pointing the way they face.
    const p = s.player;
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
