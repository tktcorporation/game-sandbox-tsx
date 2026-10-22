import { VALUABLES } from "./config";
import type { State } from "./state";

/** Worth of everything the player carries and has sent home from a depot. */
export const haulValue = (s: State) => [...s.player.haul, ...s.sent].reduce((n, k) => n + VALUABLES[k].value, 0);
