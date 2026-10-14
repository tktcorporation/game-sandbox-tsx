import { WORLD } from "../sim/config";
import { BOXES, EXTRACTS, POIS, REGIONS } from "../sim/map";
import { DAM_FACE, floorLevel, highGround, LEVEL, steepAt, surfaceAt, terrainHeight } from "../sim/terrain";
import type { State } from "../sim/state";
import { PAL } from "./models";

/*
 * The world map (M, or the map button on a phone): both regions and the ways between
 * them. The HUD shows no markers or distances, so this is where the player finds the
 * POIs and the ways off. The ground and buildings are drawn once; each open frame scales
 * them to the map's size on screen and adds the names, the player, the teammate and
 * which POIs are cleared, with text at a fixed size on screen. North (-z) is up, as on
 * the compass.
 */

/** Metres per map pixel of the ground image. */
const CELL = 1.5;

/** Names on the map for the districts and landmarks between the POIs. */
const DISTRICTS = [
  { name: "湖底の旧市街", x: 0, z: -22 },
  { name: "堤", x: 0, z: -79 },
  { name: "放水路", x: 50, z: -72 },
  { name: "尾根", x: -50, z: 62 },
  { name: "工場", x: 57, z: 60 },
  { name: "住宅地", x: 112, z: 24 },
  { name: "峠", x: -60, z: -236 },
  { name: "鉄橋", x: 140, z: -190 },
  { name: "駅", x: 108, z: -228 },
  { name: "港町", x: 20, z: -312 },
  { name: "高架", x: 30, z: -362 },
  { name: "塩田", x: -10, z: -480 },
  { name: "灯台", x: -116, z: -538 },
  { name: "水路", x: 140, z: -604 },
] as const;

/** Where each region's name goes, large and faint under everything. */
const REGION_LABELS: Record<string, { x: number; z: number }> = { reservoir: { x: -150, z: 120 }, harbor: { x: -150, z: -270 } };

const css = (c: number) => `#${c.toString(16).padStart(6, "0")}`;

export class IslandMap {
  private base: HTMLCanvasElement | null = null;
  private readonly width = Math.ceil((WORLD.x1 - WORLD.x0) / CELL);
  private readonly height = Math.ceil((WORLD.z1 - WORLD.z0) / CELL);

  constructor(private readonly canvas: HTMLCanvasElement) {
    // The page sizes the map by this, so it keeps the world's shape.
    canvas.style.setProperty("--map-aspect", `${this.width / this.height}`);
  }

  /** Map pixel of a world point. */
  private px(x: number, z: number) {
    return { x: (x - WORLD.x0) / CELL, y: (z - WORLD.z0) / CELL };
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

  draw(s: State) {
    this.base ??= this.build();
    const g = this.canvas.getContext("2d")!;
    // Drawn at the size it is shown, so names stay readable however tall the world is.
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = Math.round((this.canvas.clientWidth || this.width) * dpr);
    const h = Math.round((this.canvas.clientHeight || this.height) * dpr);
    this.canvas.width = w;
    this.canvas.height = h;
    const k = w / this.width;
    g.imageSmoothingEnabled = true;
    g.drawImage(this.base, 0, 0, w, h);
    const at = (x: number, z: number) => {
      const p = this.px(x, z);
      return { x: p.x * k, y: p.y * k };
    };
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.lineWidth = 3 * dpr;
    g.lineJoin = "round";
    g.strokeStyle = "rgba(20,24,40,0.85)";
    const font = (size: number) => `800 ${size * dpr}px system-ui, sans-serif`;
    const label = (text: string, x: number, y: number, color: string, size: number, stroke = true) => {
      g.font = font(size);
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
      const x0 = left ? x : x - w / 2;
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
    for (const d of DISTRICTS) {
      const p = at(d.x, d.z);
      const r = box(d.name, p.x, p.y, 10);
      if (!free(r)) continue;
      taken.push(r);
      label(d.name, p.x, p.y, "#e9dcc2", 10);
    }
    for (const r of REGIONS) {
      const p = at(REGION_LABELS[r.id].x, REGION_LABELS[r.id].z);
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
