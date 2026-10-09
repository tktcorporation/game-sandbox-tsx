import Phaser from "phaser";
import { WORLD } from "./sim/config";
import { GameScene } from "./game/Scene";
import { Hud } from "./game/hud";
import "./style.css";

const hud = new Hud();
const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: "stage",
  width: WORLD.w,
  height: WORLD.h,
  backgroundColor: "#0b1240",
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  scene: [],
});
game.scene.add("game", GameScene, true, { hud });

const scene = () => game.scene.getScene("game") as GameScene;

declare global {
  interface Window {
    render_game_to_text: () => string;
    advanceTime: (ms: number) => void;
  }
}

/** Automation hooks (Playwright, agents): a text summary of the state, and deterministic stepping. */
window.render_game_to_text = () => {
  const s = scene().state;
  return JSON.stringify({
    room: s.room + 1,
    phase: s.phase,
    player: { x: Math.round(s.player.pos.x), y: Math.round(s.player.pos.y), hp: s.player.hp, mag: s.player.mag },
    enemies: s.enemies.map((e) => ({ kind: e.kind, x: Math.round(e.pos.x), y: Math.round(e.pos.y), hp: e.hp, mode: e.mode })),
    wavesLeft: s.waves.length,
    bullets: s.bullets.length,
    roomTimes: s.roomTimes.map((t) => +t.toFixed(2)),
  });
};
window.advanceTime = (ms: number) => scene().advance(ms);
