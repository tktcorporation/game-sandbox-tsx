/*
 * Sends the island's summary to the server after each settled raid (docs/ringfall/multiplayer.md,
 * サーバー). Browser only: the sim and the scripts never import it. Nothing waits on the answer and
 * every failure is dropped without a word, so play is the same with the server down or without a
 * database (202, `no-database`). Under a browser driver (the shots gate) nothing is sent: the browser logs a
 * refused request's status as a console error, which the gate counts as a failure.
 */
import { loadIdentity } from "./meta/identity";
import type { Settlement } from "./meta/profile";
import { islandPost } from "./meta/summary";
import type { State } from "./sim/state";

/** Posts the summary of raid `s` settled as `settlement`, and forgets it. */
export function sendIsland(settlement: Settlement, s: Pick<State, "outcome" | "stats">) {
  if (navigator.webdriver) return;
  try {
    const body = JSON.stringify(islandPost(loadIdentity(), settlement, s));
    fetch("/api/island", { method: "POST", keepalive: true, headers: { "content-type": "application/json" }, body }).catch(() => {});
  } catch {
    // No network API, or the summary could not be built: the raid is settled all the same.
  }
}
