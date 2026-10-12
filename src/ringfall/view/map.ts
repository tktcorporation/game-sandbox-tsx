import { WORLD } from "../sim/config";
import { BOXES, EXTRACTS, POIS } from "../sim/map";
import { steepAt, terrainHeight } from "../sim/terrain";
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

const css = (c: number) => `#${c.toString(16).padStart(6, "0")}`;

export class IslandMap {
  private base: HTMLCanvasElement | null = null;
  private readonly size = Math.ceil((WORLD.half * 2) / CELL);

  constructor(private readonly canvas: HTMLCanvasElement) {}

  /** Map pixel of a world point. */
  private px(x: number, z: number) {
    return { x: (x + WORLD.half) / CELL, y: (z + WORLD.half) / CELL };
  }

  /** The ground (valleys light, high ground dark, cliffs darker) with every box on it. */
  private build(): HTMLCanvasElement {
    const c = document.createElement("canvas");
    c.width = c.height = this.size;
    const g = c.getContext("2d")!;
    const img = g.createImageData(this.size, this.size);
    const low = [0xe2, 0xbf, 0x8a];
    const high = [0x9a, 0x5a, 0x3a];
    const wall = [0x6e, 0x3b, 0x26];
    for (let j = 0; j < this.size; j++)
      for (let i = 0; i < this.size; i++) {
        const x = -WORLD.half + (i + 0.5) * CELL;
        const z = -WORLD.half + (j + 0.5) * CELL;
        const h = terrainHeight(x, z);
        const k = (j * this.size + i) * 4;
        const col = steepAt(x, z) ? wall : h > 4 ? high : low;
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
    const n = this.size;
    this.canvas.width = this.canvas.height = n;
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
