import { stepEnemies, stepOrbs, stepWaves } from "./enemies";
import { stepPlayer, tickReveal } from "./player";
import { stepAlly } from "./ally";
import { stepDepots, stepEntries, stepExtract, stepLoot, stepPoi, stepReinforce } from "./world";
import { TICK } from "./config";
import type { Input, State } from "./state";
import { useRoutes } from "./routes";

/** Read afresh: each system may have ended the raid. */
const ended = (s: State) => s.phase === "done";

/** Advance the run by one fixed 1/60 s tick. Pure: no DOM, no clock, no Math.random. */
export function step(s: State, input: Input, prevCrouch: boolean) {
  useRoutes(s.routes);
  s.events = [];
  if (s.phase === "done") return;
  s.time += TICK;
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
    stepDepots,
    stepEntries,
  ];
  for (const run of systems) {
    run(s);
    if (ended(s)) return;
  }
}
