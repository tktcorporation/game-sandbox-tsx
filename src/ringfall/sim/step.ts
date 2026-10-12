import { stepEnemies, stepOrbs, stepWaves } from "./enemies";
import { stepDrop, stepPlayer, tickReveal } from "./player";
import { placeAlly, stepAlly } from "./ally";
import { stepExtract, stepLoot, stepPoi, stepReinforce } from "./world";
import { TICK } from "./config";
import type { Input, State } from "./state";

/** Advance the run by one fixed 1/60 s tick. Pure: no DOM, no clock, no Math.random. */
export function step(s: State, input: Input, prevCrouch: boolean) {
  s.events = [];
  if (s.phase === "done") return;
  s.time += TICK;
  if (s.phase === "drop") {
    if (stepDrop(s, input)) placeAlly(s);
    return;
  }
  stepPlayer(s, input, prevCrouch);
  tickReveal(s);
  stepAlly(s);
  stepEnemies(s);
  stepOrbs(s);
  stepWaves(s);
  stepLoot(s, input);
  stepPoi(s);
  stepReinforce(s);
  stepExtract(s);
}
