import { VALUABLES } from "./config";
import type { State } from "./state";

/**
 * Credit total of valuables in the bag (`State.player.haul`) plus those already sent home through
 * a depot this raid (`State.sent`).
 */
export const haulAndSentWorth = (s: State) => [...s.player.haul, ...s.sent].reduce((n, k) => n + VALUABLES[k].value, 0);
