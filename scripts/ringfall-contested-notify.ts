/**
 * Contested attack notifications (TKT-201): win → taken log + trophy loss on defender sync;
 * loss → wiped log + 守りきった +10. Startup card reads the same lines.
 *   npx tsx scripts/ringfall-contested-notify.ts
 */
import assert from "node:assert/strict";
import { applySync, logLine, newsVisible } from "../src/ringfall/meta/expeditions";
import { ROUTE_SHORES } from "../src/ringfall/meta/neighbours";
import { newProfile } from "../src/ringfall/meta/profile";
import { TROPHY } from "../src/ringfall/meta/trophies";
import { rivalHold } from "../src/ringfall/sim/holds";
import { contestedFailed } from "../src/ringfall/sim/front";
import { NODES } from "../src/ringfall/sim/map";
import { awaySheetParts, newsWipedEnemy } from "../src/ringfall/view/copy";
import { islandOp, type IslandState } from "../worker/island";

const shore = ROUTE_SHORES[0]!; // station
const other = ROUTE_SHORES[1]!; // waterworks
const shoreName = NODES.find((n) => n.id === shore)!.name;
const attacker = { code: "ATK001", name: "ツバキ" };

{
  // Pure: contestedFailed drops shores that were captured.
  const tried = [
    { id: shore, owner: "DEF001" },
    { id: other, owner: "DEF002" },
  ];
  assert.deepEqual(
    contestedFailed({ stats: { contestedTried: tried, captured: [shore] } }),
    [{ shore: other, owner: "DEF002" }],
  );
  assert.deepEqual(contestedFailed({ stats: { contestedTried: tried, captured: tried.map((t) => t.id) } }), []);
}

{
  // Defender island: contestedDefend → wiped → applySync awards defend trophies + news line.
  const claim = islandOp(null, { t: "claim", player: { id: "0f8fad5b-d9cb-469f-a165-bbbbbbbbbbb1", name: "アサヒ" }, code: "DEF001" }, 1_000);
  const s = claim.state as IslandState;
  const at = 2_000;
  const r = islandOp(s, { t: "contestedDefend", shore, from: attacker, at }, at);
  assert.equal(r.status, 200);
  const entry = s.log.find((e) => e.t === "wiped" && e.node === shore)!;
  assert.ok(entry);
  assert.equal(entry.by.name, attacker.name);
  const line = logLine(entry);
  assert.equal(line, newsWipedEnemy(shoreName, attacker.name));
  assert.ok(newsVisible(entry));

  const p = newProfile(1);
  const before = p.trophies ?? TROPHY.start;
  const synced = applySync(p, {
    log: { next: entry.seq, entries: [entry] },
  });
  assert.equal(synced.profile.trophies, before + TROPHY.defend);
  assert.ok(synced.notes.some((n) => n.includes("守りきった +10")));
  // Same lines feed the startup card.
  const sheet = awaySheetParts([], [line, ...synced.notes]);
  assert.ok(sheet);
  assert.ok(sheet!.lines.some((l) => l.includes("守りきった")));
}

{
  // Win path: contestedMirror taken → sync deducts trophies; line names the attacker.
  const claim = islandOp(null, { t: "claim", player: { id: "0f8fad5b-d9cb-469f-a165-bbbbbbbbbbb2", name: "アサヒ" }, code: "DEF002" }, 1_000);
  const s = claim.state as IslandState;
  s.holds = s.holds.map((_, i) => (NODES[i]!.id === shore || NODES[i]!.id === "supply" ? "own" : "foe"));
  const at = 3_000;
  const mir = islandOp(s, { t: "contestedMirror", shore, owner: attacker.code, name: attacker.name, at }, at);
  assert.equal(mir.status, 200);
  assert.equal(s.holds[NODES.findIndex((n) => n.id === shore)], rivalHold(attacker.code));
  const taken = s.log.find((e) => e.t === "taken" && e.node === shore)!;
  assert.equal(taken.by.name, attacker.name);
  assert.ok(logLine(taken).includes(attacker.name));

  const p = newProfile(2);
  p.poiState = { ...p.poiState, [shore]: { state: "own" }, supply: { state: "own" } };
  const before = p.trophies ?? TROPHY.start;
  const synced = applySync(p, {
    holds: NODES.map((n) => ({
      id: n.id,
      hold: n.id === shore ? rivalHold(attacker.code) : n.id === "supply" ? ("own" as const) : ("foe" as const),
    })),
    log: { next: taken.seq, entries: [taken] },
  });
  assert.ok((synced.profile.trophies ?? 0) < before);
  assert.ok(synced.notes.some((n) => n.includes("取られた")));
  const sheet = awaySheetParts([], [logLine(taken), ...synced.notes]);
  assert.ok(sheet?.lines.some((l) => l.includes("取られた")));
}

console.log("contested-notify ok");
