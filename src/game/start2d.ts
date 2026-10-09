import Phaser from "phaser";
import { WORLD } from "../sim/config";
import { GameScene } from "./Scene";
import type { Hud } from "./hud";

/** Boots the top-down Phaser view and resolves once its scene has created the run. */
export function start2d(hud: Hud): Promise<GameScene> {
  return new Promise((resolve) => {
    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: "stage",
      width: WORLD.w,
      height: WORLD.h,
      backgroundColor: "#0b1240",
      scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
      scene: [],
    });
    game.events.once(Phaser.Core.Events.READY, () => {
      game.scene.add("game", GameScene, true, { hud, onReady: resolve });
    });
  });
}
