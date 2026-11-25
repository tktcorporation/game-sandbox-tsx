/**
 * Trophy ranking numbers + swap (docs/ringfall/design-direction.md 「トロフィーと物資」).
 *   npx tsx scripts/ringfall-trophies.ts
 */
import assert from "node:assert/strict";
import { applySync } from "../src/ringfall/meta/expeditions";
import { newProfile, parseProfile } from "../src/ringfall/meta/profile";
import { SEIZE, TROPHY, clampTrophies, trophyDelta, trophySwap } from "../src/ringfall/meta/trophies";
import { rivalHold } from "../src/ringfall/sim/holds";
import { NODES } from "../src/ringfall/sim/map";

assert.equal(clampTrophies(-10), 0);
assert.equal(clampTrophies(99999), TROPHY.max);
assert.equal(TROPHY.defend, 10);
assert.ok(TROPHY.defend < TROPHY.base);
assert.equal(SEIZE.emptyReserve, 3);
assert.equal(SEIZE.bonus, 2);

{
  const even = trophySwap(1000, 1000);
  assert.equal(even.gain, TROPHY.base);
  const up = trophySwap(1000, 1400);
  assert.ok(up.gain > TROPHY.base);
  const down = trophySwap(1400, 1000);
  assert.ok(down.gain < TROPHY.base);
}

{
  const before = NODES.map(() => "foe" as const);
  const after = [...before];
  const i = 0;
  before[i] = rivalHold("AAAAAA");
  after[i] = "own";
  const d = trophyDelta(1000, before, after);
  assert.ok(d.gained >= TROPHY.base - TROPHY.maxBonus);
  assert.equal(d.taken.length, 1);
  assert.equal(d.next, 1000 + d.gained);
}

{
  const before = NODES.map(() => "foe" as const);
  const after = [...before];
  before[0] = "own";
  after[0] = rivalHold("BBBBBB");
  const d = trophyDelta(1000, before, after);
  assert.ok(d.lost > 0);
  assert.equal(d.dropped.length, 1);
  assert.equal(d.next, 1000 - d.lost);
}

{
  const p = newProfile(1);
  assert.equal(p.v, 41);
  assert.equal(p.trophies, TROPHY.start);
  const raw = JSON.parse(JSON.stringify(p));
  raw.v = 31;
  delete raw.trophies;
  const old = parseProfile(raw, 1);
  assert.ok(old);
  assert.equal(old.v, 41);
  assert.equal(old.trophies, TROPHY.start);
}

// Sync that transfers a freed node to a rival deducts trophies (Codex P2) and leaves a news note.
{
  const p = newProfile(3);
  const id = NODES[0].id;
  p.poiState = { ...p.poiState, [id]: { state: "own" } };
  const before = p.trophies;
  const { profile, notes } = applySync(p, { holds: [{ id, hold: rivalHold("ZZZZZZ") }] });
  assert.ok(profile.trophies! < before);
  assert.ok(notes.length === 1 && notes[0].includes("トロフィー"));
  // A second sync with the same hold does not deduct again.
  const again = applySync(profile, { holds: [{ id, hold: rivalHold("ZZZZZZ") }] });
  assert.equal(again.profile.trophies, profile.trophies);
  assert.equal(again.notes.length, 0);
}

console.log("trophies ok");
