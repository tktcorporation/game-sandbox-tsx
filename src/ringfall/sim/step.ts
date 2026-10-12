import { stepEnemies, stepOrbs, stepWaves } from "./enemies";
import { stepDrop, stepPlayer, tickReveal } from "./player";
import { placeAlly, stepAlly } from "./ally";
import { stepExtract, stepLoot, stepPoi, stepReinforce } from "./world";
import { TICK } from "./config";
import type { Input, State } from "./state";

/** Read afresh: each system may have ended the raid. */
const ended = (s: State) => s.phase === "done";

/** Advance the run by one fixed 1/60 s tick. Pure: no DOM, no clock, no Math.random. */
export function step(s: State, input: Input, prevCrouch: boolean) {
  s.events = [];
  if (s.phase === "done") return;
  s.time += TICK;
  if (s.phase === "drop") {
    if (stepDrop(s, input)) placeAlly(s);
    return;
  }
  // A wipe or an extraction ends the raid mid-tick; nothing after it may fire, score or move.
  const systems: ((s: State) => void)[] = [
    (s) => stepPlayer(s, input, prevCrouch),
    tickReveal,
    stepAlly,
    stepEnemies,
    stepOrbs,
    stepWaves,
    (s) => stepLoot(s, input),
    stepPoi,
    stepReinforce,
    stepExtract,
  ];
  for (const run of systems) {
    run(s);
    if (ended(s)) return;
  }
}
