import { Hud } from "./game/hud";
import { unlock } from "./game/audio";
import type { State } from "./sim/state";
import "./style.css";

/**
 * Both views play the same simulation (src/sim). Each is loaded only when chosen,
 * so the title screen never downloads Phaser and three.js together.
 */
interface Mode {
  state: State;
  advance(ms: number): void;
  aimAt?(x: number, y: number): void;
}

const hud = new Hud();
let active: Mode | null = null;

hud.onStart = async (mode) => {
  unlock();
  hud.title(false);
  if (mode === "3d") {
    const { World3D } = await import("./game3d/World");
    active = new World3D(hud, document.getElementById("stage")!);
  } else {
    const { start2d } = await import("./game/start2d");
    active = await start2d(hud);
  }
};

declare global {
  interface Window {
    render_game_to_text: () => string;
    advanceTime: (ms: number) => void;
    aimAt: (x: number, y: number) => void;
  }
}

/** Automation hooks (Playwright, agents): a text summary of the state, deterministic stepping, and 3D aiming. */
window.render_game_to_text = () => {
  if (!active) return JSON.stringify({ phase: "title" });
  const s = active.state;
  return JSON.stringify({
    room: s.room + 1,
    phase: s.phase,
    player: { x: Math.round(s.player.pos.x), y: Math.round(s.player.pos.y), hp: s.player.hp, mag: s.player.mag, aim: +s.player.aim.toFixed(3) },
    enemies: s.enemies.map((e) => ({ kind: e.kind, x: Math.round(e.pos.x), y: Math.round(e.pos.y), hp: e.hp, mode: e.mode })),
    wavesLeft: s.waves.length,
    bullets: s.bullets.length,
    roomTimes: s.roomTimes.map((t) => +t.toFixed(2)),
  });
};
window.advanceTime = (ms: number) => active?.advance(ms);
window.aimAt = (x: number, y: number) => active?.aimAt?.(x, y);
