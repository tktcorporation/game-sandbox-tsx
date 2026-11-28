import { stepEnemies, stepFriends, stepOrbs, stepWaves } from "./enemies";
import { finishBattle, stepBattle } from "./battle";
import { stepPlayer, tickReveal } from "./player";
import { stepAlly } from "./ally";
import { stepDepots, stepEntries, stepExtract, stepHome, stepLoot, stepParties, stepPoi, stepReinforce, stepSortie } from "./world";
import { TICK } from "./config";
import { stepReplay } from "./replay";
import type { Input, State } from "./state";
import { stepFront, useZones } from "./front";
import { stepAmbush, stepContacts, stepFactions, stepMobiles, stepSweep } from "./factions";

/** Read afresh: each system may have ended the raid. */
const ended = (s: State) => s.phase === "done";

/** The systems of a tick, in order, around the player's (first) and the loot's, which read the input. */
const BEFORE_LOOT: ((s: State) => void)[] = [tickReveal, stepAlly, stepFactions, stepEnemies, stepFriends, stepOrbs, stepWaves];
const AFTER_LOOT: ((s: State) => void)[] = [stepPoi, stepFront, stepBattle, stepReinforce, stepParties, stepMobiles, stepAmbush, stepSweep, stepExtract, stepDepots, stepHome, stepEntries, stepContacts];
/** A sortie's (`State.sortie`): its holding alone, left by its depot or when it ends; none of the island's walkers, timers or ways off. */
const SORTIE_AFTER: ((s: State) => void)[] = [stepPoi, stepFront, stepSortie, stepDepots, stepContacts];

/** Advance the run by one fixed 1/60 s tick. Pure: no DOM, no clock, no Math.random. */
export function step(s: State, input: Input, prevCrouch: boolean) {
  useZones(s);
  // Clear in place: same list the view and the gate read after the tick, without a fresh array each time.
  s.events.length = 0;
  if (s.phase === "done") return;
  tick(s, input, prevCrouch);
  // A sortie's record reads the whole tick's events, the one that ended it included (sim/replay.ts).
  if (s.replay) stepReplay(s);
}

function tick(s: State, input: Input, prevCrouch: boolean) {
  s.time += TICK;
  // A wipe or an extraction ends the raid mid-tick; nothing after it may fire, score or move.
  // The raid is over before the battle may be: the rest of it is reckoned then (sim/battle.ts).
  stepPlayer(s, input, prevCrouch);
  if (ended(s)) {
    finishBattle(s);
    return;
  }
  for (const run of BEFORE_LOOT) {
    run(s);
    if (ended(s)) {
      finishBattle(s);
      return;
    }
  }
  stepLoot(s, input);
  if (ended(s)) {
    finishBattle(s);
    return;
  }
  for (const run of s.sortie ? SORTIE_AFTER : AFTER_LOOT) {
    run(s);
    if (ended(s)) {
      finishBattle(s);
      return;
    }
  }
}
