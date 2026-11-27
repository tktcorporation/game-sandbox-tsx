/*
 * Sorties on other players' holdings (docs/ringfall/glossary.md 攻め, 決定 B, sync A: the attacker
 * reports the result, the owner hears of it at the next sync):
 *   - the island takes a `raid` op: captured, the holding goes back to the robots with its 島の守り
 *     and the owner's log says 取られた; not captured, 守りきった; the day's loss cap holds
 *   - the owner's sync makes the holding the robots' and costs trophies
 *   - the 攻める list offers a real neighbour's holdings
 * Run: `npx tsx scripts/ringfall-real-raids.ts`
 */
import assert from "node:assert/strict";
import { islandOp, NODE_IDS, shieldNode, type IslandOp, type IslandState } from "../worker/island";
import { applySync, type IslandLogEntry } from "../src/ringfall/meta/expeditions";
import { newProfile } from "../src/ringfall/meta/profile";
import { sortieTargets } from "../src/ringfall/meta/sortie";
import type { Neighbour } from "../src/ringfall/meta/neighbours";
import { NODES } from "../src/ringfall/sim/map";

const A = { id: "00000000-0000-4000-8000-00000000000a", name: "アオ", code: "AAAAA1" };
const B = { code: "BBBBB2", name: "ベニ" };
const T0 = Date.UTC(2026, 10, 2, 3);
const holdsWith = (own: string[]) => NODE_IDS.map((id) => (own.includes(id) ? "own" : "foe")) as IslandState["holds"];
const op = (s: IslandState | null, o: IslandOp, t: number) => islandOp(s, o, t);

// The island: A holds supply and quarry, with a parcel at supply.
let s = op(null, { t: "claim", player: { id: A.id, name: A.name }, code: A.code }, T0).state!;
s = op(s, { t: "report", player: { id: A.id, name: A.name }, retaken: [], holds: holdsWith(["supply", "quarry"]), factory: 1, day: 1, parcels: [{ poi: "supply", kind: "board", from: { code: A.code, name: A.name } }] }, T0).state!;

// Not captured: 守りきった, nothing changes hands.
let r = op(s, { t: "raid", from: B, target: "quarry", captured: false }, T0 + 1000);
assert.equal(r.status, 200);
assert.equal(r.state!.holds[NODE_IDS.indexOf("quarry")], "own");
assert.equal(r.state!.log.at(-1)?.t, "wiped");

// Captured: back to the robots, its 島の守り with the attacker, 取られた in the log.
r = op(r.state, { t: "raid", from: B, target: "supply", captured: true }, T0 + 2000);
assert.equal(r.status, 200);
assert.deepEqual((r.body as { taken: boolean; parcels: string[] }).parcels, ["board"]);
assert.equal(r.state!.holds[NODE_IDS.indexOf("supply")], "foe");
assert.equal((r.state!.parcels ?? []).filter((q) => q.poi === "supply").length, 0);
assert.equal(r.state!.log.at(-1)?.t, "taken");

// The same day: the island is shielded, a second capture does not take.
r = op(r.state, { t: "raid", from: B, target: "quarry", captured: true }, T0 + 3000);
assert.equal(r.state!.holds[NODE_IDS.indexOf("quarry")], "own", "two holdings lost on one day");

// A node not held is no target.
assert.equal(op(r.state, { t: "raid", from: B, target: "relay", captured: true }, T0 + 4000).status, 409);

// A report from the owner's copy older than the loss does not undo it; one showing it lost clears the mark.
const stale = op(structuredClone(r.state), { t: "report", player: { id: A.id, name: A.name }, retaken: [], holds: holdsWith(["supply", "quarry"]), factory: 1, day: 1 }, T0 + 5000);
assert.equal(stale.state!.holds[NODE_IDS.indexOf("supply")], "foe", "a stale report gave the holding taken back");
const seen = op(structuredClone(stale.state), { t: "report", player: { id: A.id, name: A.name }, retaken: [], holds: holdsWith(["quarry"]), factory: 1, day: 1 }, T0 + 6000).state!;
assert.deepEqual(seen.raided ?? [], []);
// Taken back in the owner's raid: named among retaken, it is theirs again.
const back = op(structuredClone(stale.state), { t: "report", player: { id: A.id, name: A.name }, retaken: ["supply"], holds: holdsWith(["supply", "quarry"]), factory: 1, day: 1 }, T0 + 6000).state!;
assert.equal(back.holds[NODE_IDS.indexOf("supply")], "own");

// A contested shore shielded for the day is not taken by a sortie.
{
  const wi = NODE_IDS.indexOf("wreck");
  let w = op(null, { t: "claim", player: { id: A.id, name: A.name }, code: A.code }, T0).state!;
  w = op(w, { t: "report", player: { id: A.id, name: A.name }, retaken: [], holds: holdsWith(["wreck"]), factory: 1, day: 1 }, T0).state!;
  shieldNode(w, wi, T0);
  const hit = op(w, { t: "raid", from: B, target: "wreck", captured: true }, T0 + 1000);
  assert.equal(hit.state!.holds[wi], "own", "a shielded holding was taken");
  assert.equal((hit.body as { taken: boolean }).taken, false);
}

// The owner's sync: supply goes back to the robots and costs trophies.
const p = { ...newProfile(5), poiState: { ...newProfile(5).poiState, supply: { state: "own" as const }, quarry: { state: "own" as const } } };
const log: IslandLogEntry[] = r.state!.log.map((e) => ({ seq: e.seq, at: e.at, t: e.t as IslandLogEntry["t"], node: e.node, by: e.by }));
const synced = applySync(p, { log: { entries: log, next: r.state!.seq }, holds: NODE_IDS.map((id, i) => ({ id, hold: r.state!.holds[i] })) });
assert.equal(synced.profile.poiState.supply.state, "foe", "the owner still holds the holding taken");
assert.equal(synced.profile.poiState.quarry.state, "own");
assert.ok(synced.notes.some((l) => l.includes("取られた −") && l.includes("守りきった +")), `the trophy line was ${synced.notes.join()}`);

// The 攻める list: a real neighbour's holdings.
const n: Neighbour = { code: B.code, name: B.name, held: 2, total: NODES.length, day: 3, slot: 1, trophies: 1000, factory: 2 };
const rows = sortieTargets([n], 0, 3, 1000, [], { [B.code]: { held: ["quarry", "relay"], guard: { relay: 1 } } });
const real = rows.filter((t) => !t.ai);
assert.deepEqual(real.map((t) => t.id).sort(), ["quarry", "relay"]);
assert.equal(real.find((t) => t.id === "relay")?.guard, 1);
assert.equal(real[0]!.owner, B.code);

console.log("real raids ok", real.map((t) => t.title).join(" | "));
