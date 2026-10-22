import { stepEnemies, stepFriends, stepOrbs, stepWaves } from "./enemies";
import { finishBattle, stepBattle } from "./battle";
import { stepPlayer, tickReveal } from "./player";
import { stepAlly } from "./ally";
import { stepCrews, stepDepots, stepEntries, stepExtract, stepHome, stepLoot, stepParties, stepPoi, stepReinforce } from "./world";
import { TICK } from "./config";
import type { Input, State } from "./state";
import { useRoutes } from "./routes";
import { stepFront, useZones } from "./front";
import { stepAmbush, stepContacts, stepFactions, stepMobiles, stepSweep } from "./factions";

/** Read afresh: each system may have ended the raid. */
const ended = (s: State) => s.phase === "done";

/** Advance the run by one fixed 1/60 s tick. Pure: no DOM, no clock, no Math.random. */
export function step(s: State, input: Input, prevCrouch: boolean) {
  useRoutes(s.routes);
  useZones(s);
  s.events = [];
  if (s.phase === "done") return;
  s.time += TICK;
  // A wipe or an extraction ends the raid mid-tick; nothing after it may fire, score or move.
  const systems: ((s: State) => void)[] = [
    (s) => stepPlayer(s, input, prevCrouch),
    tickReveal,
    stepAlly,
    stepFactions,
    stepEnemies,
    stepFriends,
    stepOrbs,
    stepWaves,
    (s) => stepLoot(s, input),
    stepPoi,
    stepFront,
    stepBattle,
    stepReinforce,
    stepParties,
    stepMobiles,
    stepAmbush,
    stepSweep,
    stepCrews,
    stepExtract,
    stepDepots,
    stepHome,
    stepEntries,
    stepContacts,
  ];
  for (const run of systems) {
    run(s);
    if (ended(s)) {
      // The raid is over before the battle may be: the rest of it is reckoned now (sim/battle.ts).
      finishBattle(s);
      return;
    }
  }
}
