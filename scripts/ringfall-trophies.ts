/**
 * Trophy ranking numbers + swap (docs/ringfall/design-direction.md 「トロフィーと物資」).
 *   npx tsx scripts/ringfall-trophies.ts
 */
import assert from "node:assert/strict";
import { applySync } from "../src/ringfall/meta/expeditions";
import { CONTESTED_SHORES } from "../src/ringfall/meta/neighbours";
import { newProfile, parseProfile, seizeRivalLoot } from "../src/ringfall/meta/profile";
import { SEIZE, TROPHY, clampTrophies, rivalTrophies, trophyDelta, trophySwap, trophiesTable } from "../src/ringfall/meta/trophies";
import { rivalHold } from "../src/ringfall/sim/holds";
import { NODES, POIS, nodeIndex, poiIndex } from "../src/ringfall/sim/map";

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
  // TKT-201: ~200 above → about +40; ~200 below → about +20 (base 30 ± gap).
  assert.equal(trophySwap(1000, 1200).gain, 40);
  assert.equal(trophySwap(1000, 800).gain, 20);
}

const shore = CONTESTED_SHORES[0]!;
const shoreI = nodeIndex(shore);

{
  const before = NODES.map(() => "foe" as const);
  const after = [...before];
  before[shoreI] = rivalHold("AAAAAA");
  after[shoreI] = "own";
  // Unknown rival → even (always +30).
  const d = trophyDelta(1000, before, after);
  assert.equal(d.gained, TROPHY.base);
  assert.equal(d.taken.length, 1);
  assert.equal(d.taken[0], shore);
  assert.equal(d.next, 1000 + d.gained);
  // Real trophies: rival 200 above → +40.
  const table = trophiesTable([{ code: "AAAAAA", trophies: 1200 }]);
  const gap = trophyDelta(1000, before, after, (o) => rivalTrophies(o, 1000, table));
  assert.equal(gap.gained, 40);
  // Rival 200 below → +20.
  const weak = trophyDelta(1000, before, after, (o) => rivalTrophies(o, 1000, trophiesTable([{ code: "AAAAAA", trophies: 800 }])));
  assert.equal(weak.gained, 20);
}

{
  // Non-contested rival → own does not move trophies.
  const before = NODES.map(() => "foe" as const);
  const after = [...before];
  const supply = nodeIndex("supply");
  before[supply] = rivalHold("AAAAAA");
  after[supply] = "own";
  const d = trophyDelta(1000, before, after);
  assert.equal(d.gained, 0);
  assert.equal(d.taken.length, 0);
  assert.equal(d.next, 1000);
}

{
  const before = NODES.map(() => "foe" as const);
  const after = [...before];
  before[shoreI] = "own";
  after[shoreI] = rivalHold("BBBBBB");
  const d = trophyDelta(1000, before, after);
  assert.ok(d.lost > 0);
  assert.equal(d.dropped.length, 1);
  assert.equal(d.next, 1000 - d.lost);
}

{
  const p = newProfile(1);
  assert.equal(p.v, 42);
  assert.equal(p.trophies, TROPHY.start);
  const raw = JSON.parse(JSON.stringify(p));
  raw.v = 31;
  delete raw.trophies;
  const old = parseProfile(raw, 1);
  assert.ok(old);
  assert.equal(old.v, 42);
  assert.equal(old.trophies, TROPHY.start);
}

// Sync that transfers a contested hub to a rival deducts trophies and leaves a news note.
{
  const p = newProfile(3);
  p.poiState = { ...p.poiState, [shore]: { state: "own" } };
  const before = p.trophies;
  const { profile, notes } = applySync(p, { holds: [{ id: shore, hold: rivalHold("ZZZZZZ") }] });
  assert.ok(profile.trophies! < before);
  assert.ok(notes.length === 1 && notes[0].includes("トロフィー"));
  // A second sync with the same hold does not deduct again.
  const again = applySync(profile, { holds: [{ id: shore, hold: rivalHold("ZZZZZZ") }] });
  assert.equal(again.profile.trophies, profile.trophies);
  assert.equal(again.notes.length, 0);
}

// Sync with a wiped log entry awards defence trophies with the trophy note (知らせとセット).
{
  const p = newProfile(7);
  const before = p.trophies;
  const { profile, notes, news } = applySync(p, {
    log: {
      next: 2,
      entries: [{ seq: 1, at: 0, t: "wiped", node: shore, by: { code: "AAAAAA", name: "ツバキ" } }],
    },
  });
  assert.equal(news.length, 1);
  assert.equal(profile.trophies, before + TROPHY.defend);
  assert.ok(notes.length === 1 && notes[0].includes("守りきった +10"));
}

// 核 · 制圧 loot: empty stock pays emptyReserve + bonus (AI / rival alike).
{
  const p = newProfile(5);
  const hold = POIS.map(() => "foe" as const);
  hold[poiIndex(shore)] = rivalHold("ai-TEST01");
  const loot = seizeRivalLoot(p, {
    hold,
    seed: p.seed,
    stats: { captured: [shore] },
  });
  assert.ok(loot.at.length === 1);
  assert.equal(loot.at[0]!.kinds.length, SEIZE.emptyReserve + SEIZE.bonus);
  assert.equal(loot.items.length, SEIZE.emptyReserve + SEIZE.bonus);
}

console.log("trophies ok");
