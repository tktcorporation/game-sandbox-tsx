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
import { applySync, parseLog, parseView, type IslandLogEntry } from "../src/ringfall/meta/expeditions";
import { raidOdds, rivalTrophies, starGain } from "../src/ringfall/meta/trophies";
import { keepParcels, newProfile, parseProfile } from "../src/ringfall/meta/profile";
import { addAttacks, ATTACKS_KEPT } from "../src/ringfall/meta/attacks";
import { sortieTargets } from "../src/ringfall/meta/sortie";
import { attackable, takenBack } from "../src/ringfall/island-net";
import type { Neighbour } from "../src/ringfall/meta/neighbours";
import { NODES } from "../src/ringfall/sim/map";

const A = { id: "00000000-0000-4000-8000-00000000000a", name: "アオ", code: "AAAAA1" };
const B = { code: "BBBBB2", name: "ベニ" };
const T0 = Date.UTC(2026, 10, 2, 3);
// Islands claimed a month before, past a new island's protection.
const OLD = T0 - 30 * 86_400_000;
const holdsWith = (own: string[]) => NODE_IDS.map((id) => (own.includes(id) ? "own" : "foe")) as IslandState["holds"];
const op = (s: IslandState | null, o: IslandOp, t: number) => islandOp(s, o, t);

// The island: A holds supply and quarry, with a parcel at supply.
let s = op(null, { t: "claim", player: { id: A.id, name: A.name }, code: A.code }, OLD).state!;
s = op(s, { t: "report", player: { id: A.id, name: A.name }, retaken: [], holds: holdsWith(["supply", "quarry"]), factory: 1, day: 1, parcels: [{ poi: "supply", kind: "board", from: { code: A.code, name: A.name } }] }, T0).state!;

// Not captured: 守りきった, nothing changes hands.
let r = op(s, { t: "raid", from: B, target: "quarry", captured: false }, T0 + 1000);
assert.equal(r.status, 200);
assert.equal(r.state!.holds[NODE_IDS.indexOf("quarry")], "own");
assert.equal(r.state!.log.at(-1)?.t, "wiped");

// Captured: back to the robots, its 島の守り off the island (never the attacker's: the owner keeps their things), 取られた in the log.
r = op(r.state, { t: "raid", from: B, target: "supply", captured: true, stars: 3, won: 31 }, T0 + 2000);
assert.equal(r.status, 200);
assert.equal((r.body as { parcels?: string[] }).parcels, undefined, "the attacker was handed the owner's 島の守り");
assert.equal(r.state!.log.at(-1)?.won, 31);
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
  let w = op(null, { t: "claim", player: { id: A.id, name: A.name }, code: A.code }, OLD).state!;
  w = op(w, { t: "report", player: { id: A.id, name: A.name }, retaken: [], holds: holdsWith(["wreck"]), factory: 1, day: 1 }, T0).state!;
  shieldNode(w, wi, T0);
  const hit = op(w, { t: "raid", from: B, target: "wreck", captured: true }, T0 + 1000);
  assert.equal(hit.state!.holds[wi], "own", "a shielded holding was taken");
  const seen = parseView(op(w, { t: "view" }, T0 + 1000).body);
  assert.equal(seen?.nodes.find((n) => n.id === "wreck")?.shielded, true, "the island's view hides a holding's own shield");
  assert.equal((hit.body as { taken: boolean }).taken, false);
}

// The owner's sync: supply goes back to the robots and costs trophies.
const p = { ...newProfile(5), poiState: { ...newProfile(5).poiState, supply: { state: "own" as const }, quarry: { state: "own" as const } } };
const log: IslandLogEntry[] = r.state!.log.map((e) => ({ seq: e.seq, at: e.at, t: e.t as IslandLogEntry["t"], node: e.node, by: e.by }));
const synced = applySync(p, { log: { entries: log, next: r.state!.seq }, holds: NODE_IDS.map((id, i) => ({ id, hold: r.state!.holds[i] })) });
assert.equal(synced.profile.poiState.supply.state, "foe", "the owner still holds the holding taken");
assert.equal(synced.profile.poiState.quarry.state, "own");
assert.ok(synced.notes.some((l) => l.includes("取られた −") && l.includes("守りきった +")), `the trophy line was ${synced.notes.join()}`);

// Stars travel with the report: the owner loses what the attacker won.
{
  let w = op(null, { t: "claim", player: { id: A.id, name: A.name }, code: A.code }, OLD).state!;
  w = op(w, { t: "report", player: { id: A.id, name: A.name }, retaken: [], holds: holdsWith(["supply", "quarry"]), factory: 1, day: 1 }, T0).state!;
  const two = op(structuredClone(w), { t: "raid", from: B, target: "supply", captured: true, stars: 2 }, T0 + 1000).state!;
  assert.equal(two.log.at(-1)?.stars, 2);
  const one = op(structuredClone(w), { t: "raid", from: B, target: "supply", captured: false, stars: 1 }, T0 + 1000).state!;
  assert.equal(one.log.at(-1)?.t, "wiped");
  assert.equal(one.log.at(-1)?.stars, 1);
  const legacy = op(structuredClone(w), { t: "raid", from: B, target: "supply", captured: true }, T0 + 1000).state!;
  assert.equal(legacy.log.at(-1)?.stars, 3, "a report with no stars counts a capture as ★★★");
  const own = { ...newProfile(5), trophies: 1000, poiState: { ...newProfile(5).poiState, supply: { state: "own" as const } } };
  const sync = (st: IslandState) =>
    applySync(own, {
      log: { entries: parseLog({ entries: st.log, next: st.seq })!.entries, next: st.seq },
      holds: NODE_IDS.map((id, i) => ({ id, hold: st.holds[i] })),
    }).profile.trophies!;
  const { N } = raidOdds(rivalTrophies(B.code, 1000), 1000);
  assert.equal(1000 - sync(two), starGain(N, 2), "a ★★ capture cost the owner more than the attacker won");
  assert.equal(1000 - sync(one), starGain(N, 1), "a ★ without the core paid the owner a defence");
}

// The 攻める list: a real neighbour's holdings.
const n: Neighbour = { code: B.code, name: B.name, held: 2, total: NODES.length, day: 3, slot: 1, trophies: 1000, factory: 2 };
const rows = sortieTargets([n], 0, 3, 1000, [], { [B.code]: { held: ["quarry", "relay"], guard: { relay: 1 } } });
const real = rows.filter((t) => !t.ai);
assert.deepEqual(real.map((t) => t.id).sort(), ["quarry", "relay"]);
assert.equal(real.find((t) => t.id === "relay")?.guard, 1);
assert.equal(real[0]!.owner, B.code);

// An island under its day's shield offers no holding to attack until the shield ends.
{
  const h = { [B.code]: { held: ["quarry"], guard: {}, until: T0 + 1000 } };
  assert.deepEqual(attackable(h, T0)[B.code]!.held, [], "a shielded island's holdings were offered");
  assert.deepEqual(attackable(h, T0 + 2000)[B.code]!.held, ["quarry"]);
}
// A new island's protection: a sortie in its first days takes nothing.
{
  const fresh = op(null, { t: "claim", player: { id: A.id, name: A.name }, code: A.code }, T0).state!;
  const rep = op(fresh, { t: "report", player: { id: A.id, name: A.name }, retaken: [], holds: holdsWith(["supply"]), factory: 1, day: 1 }, T0).state!;
  const hit = op(structuredClone(rep), { t: "raid", from: B, target: "supply", captured: true, stars: 3 }, T0 + 1000);
  assert.equal(hit.status, 403, "a protected island was raided");
}
// The owner loses what the attacker's settle counted, not what today's standings would give.
{
  const own = { ...newProfile(5), trophies: 1000, poiState: { ...newProfile(5).poiState, supply: { state: "own" as const } } };
  const e: IslandLogEntry = { seq: 1, at: T0, t: "taken", node: "supply", by: B, stars: 3, won: 31 };
  const r2 = applySync(own, { log: { entries: [e], next: 1 }, holds: NODE_IDS.map((id) => ({ id, hold: "foe" as const })) });
  assert.equal(1000 - r2.profile.trophies!, 31);
}
// A report that does not say what it won: the line comes back with what the sync took off, for the record.
{
  const own = { ...newProfile(5), trophies: 1000, poiState: { ...newProfile(5).poiState, supply: { state: "own" as const } } };
  const e: IslandLogEntry = { seq: 1, at: T0, t: "taken", node: "supply", by: B, stars: 2 };
  const r4 = applySync(own, { log: { entries: [e], next: 1 }, holds: NODE_IDS.map((id) => ({ id, hold: "foe" as const })) });
  assert.ok(r4.news[0].won, "the line came back without its cost");
  assert.equal(r4.news[0].won, 1000 - r4.profile.trophies!, "the record's cost is not what was taken off");
}
// A holding taken whose log line has scrolled away is lost all the same, from the view's list.
{
  const own = { ...newProfile(5), logSeq: 500, poiState: { ...newProfile(5).poiState, supply: { state: "own" as const } } };
  const r3 = applySync(own, { log: { entries: [], next: 500 }, holds: NODE_IDS.map((id) => ({ id, hold: id === "supply" ? ("foe" as const) : ("foe" as const) })), raided: ["supply"] });
  assert.equal(r3.profile.poiState.supply.state, "foe", "a holding taken stayed the owner's once its log line was gone");
  // Taken back in a raid whose report has not reached the island: a sync that does not report keeps it the player's.
  const r5 = applySync({ ...own, retaken: ["supply" as const] }, { log: { entries: [], next: 500 }, holds: NODE_IDS.map((id) => ({ id, hold: "foe" as const })), raided: ["supply"] });
  assert.equal(r5.profile.poiState.supply.state, "own", "a holding taken back went to the robots before its report reached the island");
}
// The island's report drops 島の守り at a node its owner reports lost (an AI player's attack).
{
  let w = op(null, { t: "claim", player: { id: A.id, name: A.name }, code: A.code }, OLD).state!;
  w = op(w, { t: "report", player: { id: A.id, name: A.name }, retaken: [], holds: holdsWith(["supply"]), factory: 1, day: 1, parcels: [{ poi: "supply", kind: "board", from: { code: A.code, name: A.name } }] }, T0).state!;
  w = op(w, { t: "report", player: { id: A.id, name: A.name }, retaken: [], holds: holdsWith([]), factory: 1, day: 1 }, T0 + 1000).state!;
  assert.equal((w.parcels ?? []).length, 0, "島の守り stood at a node its owner lost");
}
// A holding lost: its 島の守り come back to the owner's stash; those at holdings still held stay.
{
  const base = newProfile(5);
  const before = { ...base, poiState: { ...base.poiState, supply: { state: "own" as const }, quarry: { state: "own" as const } }, parcels: [
    { id: 1, poi: "supply" as const, kind: "board" as const, from: B, at: T0 },
    { id: 2, poi: "quarry" as const, kind: "fuse" as const, from: B, at: T0 },
  ] };
  const after = { ...before, poiState: { ...before.poiState, supply: { state: "foe" as const } }, parcels: before.parcels.filter((q) => q.poi !== "supply") };
  const r = keepParcels(before, after);
  assert.deepEqual(r.back.map((q) => q.id), [1]);
  assert.equal(r.profile.stash.filter((i) => i.t === "valuable" && i.kind === "board").length - before.stash.filter((i) => i.t === "valuable" && i.kind === "board").length + (r.profile.pending.length - before.pending.length), 1, "the 島の守り of the holding lost did not come home");
  assert.deepEqual(r.profile.parcels.map((q) => q.id), [2]);
  assert.equal(keepParcels(r.profile, r.profile).back.length, 0, "came home twice");
}
// A sortie's record (攻めの記録) rides on its log line to the owner; only the latest few keep theirs.
{
  let w = op(null, { t: "claim", player: { id: A.id, name: A.name }, code: A.code }, OLD).state!;
  w = op(w, { t: "report", player: { id: A.id, name: A.name }, retaken: [], holds: holdsWith(["supply"]), factory: 1, day: 1 }, T0).state!;
  const rec = (n: number) => ({ node: "supply", every: 3, path: [n, 0, n + 1, 1], marks: [{ t: 3, k: "end" as const, x: n, z: 0 }] });
  for (let k = 0; k < 10; k++) w = op(w, { t: "raid", from: B, target: "supply", captured: false, replay: rec(k) }, T0 + 1000 * (k + 1)).state!;
  const kept = w.log.filter((e) => e.replay);
  assert.equal(kept.length, 8, `${kept.length} records kept`);
  assert.equal(kept.at(-1)?.replay?.path[0], 9);
  const read = parseLog(op(w, { t: "log", player: A.id, after: 0 }, T0 + 20_000).body);
  assert.deepEqual(read?.entries.at(-1)?.replay, rec(9), "the owner's log lost the record");
  // One naming another node than its line's does not read.
  assert.equal(parseLog({ entries: [{ ...read!.entries.at(-1)!, replay: { ...rec(1), node: "quarry" } }], next: 1 })?.entries[0].replay, undefined);
}
// The owner keeps the sorties on their holdings (攻められた記録): fresh ones once, the newest few, across a save.
{
  const line = (seq: number, t: "taken" | "wiped", replay?: IslandLogEntry["replay"]): IslandLogEntry => ({ seq, at: T0 + seq, t, node: "supply", by: B, stars: t === "taken" ? 3 : 1, won: 20, ...(replay ? { replay } : {}) });
  const rec = { node: "supply", every: 3, path: [1, 2, 3, 4], marks: [{ t: 3, k: "taken" as const, x: 1, z: 2 }] };
  const expedition: IslandLogEntry = { seq: 2, at: T0, t: "taken", node: "quarry", by: B };
  let kept = addAttacks([], [line(1, "taken", rec), expedition, line(3, "wiped")], { 1: 120 });
  assert.deepEqual(kept.map((a) => [a.seq, a.taken, a.credits ?? 0, !!a.replay]), [[1, true, 120, true], [3, false, 0, false]], "an expedition's line is no sortie's record");
  assert.equal(addAttacks(kept, [line(1, "taken")]), kept, "a record kept twice");
  for (let k = 10; k < 20; k++) kept = addAttacks(kept, [line(k, "wiped")]);
  assert.equal(kept.length, ATTACKS_KEPT);
  assert.equal(kept.at(-1)?.seq, 19);
  const p = { ...newProfile(5), attacks: addAttacks([], [line(1, "taken", rec)], { 1: 120 }) };
  assert.deepEqual(parseProfile(JSON.parse(JSON.stringify(p)))?.attacks, p.attacks, "the records did not survive a save");
  assert.deepEqual(parseProfile({ ...JSON.parse(JSON.stringify(p)), v: 53 })?.attacks, [], "a v53 save kept records");
}
// The log comes a sync after the holds showed the holding lost: its income still comes back, once.
{
  const base = newProfile(5);
  const gone = { ...base, cash: 1000, poiState: { ...base.poiState, supply: { state: "foe" as const } }, stores: { at: {}, since: T0, paid: { supply: [{ at: T0 + 7_200_000, n: 120 }] } } };
  const line: IslandLogEntry = { seq: 5, at: T0 + 3_600_000, t: "taken", node: "supply", by: B, stars: 3 };
  const once = takenBack(gone, gone, [line]);
  assert.equal(once.cash, 880, "the income of a holding lost a sync earlier stayed paid");
  assert.equal(takenBack(once, once, [line]).cash, 880, "taken back twice");
}
console.log("real raids ok", real.map((t) => t.title).join(" | "));
