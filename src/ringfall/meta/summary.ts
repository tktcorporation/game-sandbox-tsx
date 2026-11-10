/*
 * The island's summary the browser sends after a settled raid (docs/ringfall/multiplayer.md, サーバー):
 * the body /api/island takes (`IslandPost` in worker/api.ts). Pure, so the server's gate
 * (scripts/ringfall-server.ts) can build one from a settled raid and post it.
 */
import type { Identity } from "./identity";
import { islandHolds, playerNodes } from "./island";
import type { Settlement } from "./profile";
import { capturedIds, enemyNodes } from "../sim/front";
import { rivalOf } from "../sim/holds";
import { strengthFor, type State } from "../sim/state";

/**
 * The summary of raid `s` settled as `settlement`, posted as `player`. The island's numbers are the
 * profile's after the settle (the next day's); the raid's day is the one it was played on.
 */
export function islandPost(player: Identity, settlement: Settlement, s: Pick<State, "outcome" | "stats">) {
  const p = settlement.profile;
  const holds = islandHolds(p);
  const enemy = enemyNodes(holds);
  return {
    player: { id: player.id, name: player.name },
    island: { day: p.day, held: playerNodes(p).length, enemy, rival: holds.filter((h) => rivalOf(h) !== null).length, factory: p.factory, strength: strengthFor(playerNodes(p).length) },
    raid: { day: settlement.day, outcome: s.outcome === "extracted" ? "extracted" : "dead", captured: capturedIds(s).length },
  };
}
