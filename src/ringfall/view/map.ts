import { WORLD } from "../sim/config";
import { BOXES, EXTRACTS, POIS } from "../sim/map";
import { DAM_FACE, floorLevel, highGround, LEVEL, steepAt, terrainHeight } from "../sim/terrain";
import type { State } from "../sim/state";
import { PAL } from "./models";

/*
 * The island map (M, or the map button on a phone). The HUD shows no markers or
 * distances, so this is where the player finds the POIs and the ways off the island.
 * The ground and buildings are drawn once; each open frame adds the player, the
 * teammate and which POIs are cleared. North (-z) is up, as on the compass.
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
] as const;

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
    for (let j = 0; j < this.height; j++)
      for (let i = 0; i < this.width; i++) {
        const x = WORLD.x0 + (i + 0.5) * CELL;
        const z = WORLD.z0 + (j + 0.5) * CELL;
        const k = (j * this.width + i) * 4;
        const lv = floorLevel(x, z);
        // A ramp's middle: shade by the ground's own height.
        const col = steepAt(x, z) ? (DAM_FACE(x, z) ? dam : wall) : highGround(x, z) ? high : floor(Math.min(lv, terrainHeight(x, z)));
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
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    g.drawImage(this.base, 0, 0);
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.lineWidth = 3;
    g.strokeStyle = "rgba(20,24,40,0.85)";
    const label = (text: string, x: number, y: number, color: string, size: number) => {
      g.font = `800 ${size}px system-ui, sans-serif`;
      g.strokeText(text, x, y);
      g.fillStyle = color;
      g.fillText(text, x, y);
    };
    // Districts and landmarks between the POIs, small and muted under everything else.
    for (const d of DISTRICTS) {
      const p = this.px(d.x, d.z);
      label(d.name, p.x, p.y, "#e9dcc2", 10);
    }
    for (const x of EXTRACTS) {
      const p = this.px(x.x, x.z);
      g.fillStyle = css(PAL.hot);
      g.beginPath();
      g.moveTo(p.x, p.y - 6);
      g.lineTo(p.x + 6, p.y);
      g.lineTo(p.x, p.y + 6);
      g.lineTo(p.x - 6, p.y);
      g.closePath();
      g.fill();
      g.stroke();
      label(x.short, p.x, p.y + 14, css(PAL.hot), 10);
    }
    // POI names go on top, a little above their centre, so an exit nearby does not hide them.
    POIS.forEach((poi, i) => {
      const p = this.px(poi.x, poi.z);
      label(s.cleared[i] ? `${poi.name}（制圧）` : poi.name, p.x, p.y - 10, s.cleared[i] ? "#cfd6e0" : "#ffffff", 13);
    });
    if (s.ally.active) {
      const a = this.px(s.ally.pos.x, s.ally.pos.z);
      g.fillStyle = s.ally.down > 0 ? "#ff5a4f" : "#6fd0cf";
      g.beginPath();
      g.arc(a.x, a.y, 4, 0, Math.PI * 2);
      g.fill();
    }
    // The player: an arrow pointing the way they face.
    const p = s.player;
    const at = this.px(p.pos.x, p.pos.z);
    g.save();
    g.translate(at.x, at.y);
    g.rotate(p.yaw);
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
