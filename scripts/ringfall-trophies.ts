/**
 * Trophy ranking + star scoring (docs/ringfall/design-direction.md 「トロフィーは CoC 型」/ TKT-218).
 *   npx tsx scripts/ringfall-trophies.ts
 */
import assert from "node:assert/strict";
import { applySync } from "../src/ringfall/meta/expeditions";
import { ROUTE_SHORES } from "../src/ringfall/meta/neighbours";
import { newProfile, parseProfile, seizeRivalLoot } from "../src/ringfall/meta/profile";
import {
  AI_RAID_STARS,
  SEIZE,
  TROPHY,
  clampTrophies,
  defenceWin,
  gapBonus,
  raidOdds,
  raidTrophyDelta,
  rivalTrophies,
  starGain,
  starsForRaid,
  trophyDelta,
  trophySwap,
  trophiesTable,
} from "../src/ringfall/meta/trophies";
import { rivalHold } from "../src/ringfall/sim/holds";
import { NODES, POIS, nodeIndex, poiIndex } from "../src/ringfall/sim/map";

assert.equal(clampTrophies(-10), 0);
assert.equal(clampTrophies(99999), TROPHY.max);
assert.equal(TROPHY.base, 30);
assert.equal(TROPHY.maxBonus, 20);
assert.equal(TROPHY.failMin, 5);
assert.equal(SEIZE.emptyReserve, 3);
assert.equal(SEIZE.bonus, 2);
assert.equal(AI_RAID_STARS.win, 2);

{
  const even = raidOdds(1000, 1000);
  assert.equal(even.N, TROPHY.base);
  assert.equal(even.M, TROPHY.base);
  // ~200 above → N 40 / M 20; ~200 below → N 20 / M 40.
  assert.equal(raidOdds(1000, 1200).N, 40);
  assert.equal(raidOdds(1000, 1200).M, 20);
  assert.equal(raidOdds(1000, 800).N, 20);
  assert.equal(raidOdds(1000, 800).M, 40);
  assert.equal(gapBonus(1000, 1400), TROPHY.maxBonus);
  assert.equal(trophySwap(1000, 1000).gain, TROPHY.base);
  assert.equal(trophySwap(1000, 1000).fail, TROPHY.base);
}

{
  assert.equal(starGain(30, 3), 30);
  assert.equal(starGain(30, 2), 20);
  assert.equal(starGain(30, 1), 10);
  assert.equal(starGain(30, 0), 0);
  assert.equal(raidTrophyDelta(30, 30, 3), 30);
  assert.equal(raidTrophyDelta(30, 30, 2), 20);
  assert.equal(raidTrophyDelta(30, 30, 1), 10);
  assert.equal(raidTrophyDelta(30, 30, 0), -30);
  assert.equal(raidTrophyDelta(40, 5, 0), -5);
  assert.equal(starsForRaid({ halfDefence: true, captured: false, extracted: false }), 1);
  assert.equal(starsForRaid({ halfDefence: true, captured: true, extracted: false }), 2);
  assert.equal(starsForRaid({ halfDefence: false, captured: true, extracted: true }), 3);
  assert.equal(starsForRaid({ halfDefence: false, captured: false, extracted: false }), 0);
  assert.equal(defenceWin(1000, 1000), 30);
  assert.equal(defenceWin(1000, 1200), 20); // attacker 1000 vs defender 1200 → M of that raidOdds
}

const shore = ROUTE_SHORES[0]!; // station
const shoreI = nodeIndex(shore);

{
  const before = NODES.map(() => "foe" as const);
  const after = [...before];
  before[shoreI] = rivalHold("AAAAAA");
  after[shoreI] = "own";
  // Remote / AI take = ★★ of N (even → 20).
  const d = trophyDelta(1000, before, after);
  assert.equal(d.gained, starGain(TROPHY.base, AI_RAID_STARS.win));
  assert.equal(d.taken.length, 1);
  assert.equal(d.taken[0], shore);
  assert.equal(d.next, 1000 + d.gained);
  const table = trophiesTable([{ code: "AAAAAA", trophies: 1200 }]);
  const gap = trophyDelta(1000, before, after, (o) => rivalTrophies(o, 1000, table));
  assert.equal(gap.gained, starGain(40, AI_RAID_STARS.win));
  const weak = trophyDelta(1000, before, after, (o) => rivalTrophies(o, 1000, trophiesTable([{ code: "AAAAAA", trophies: 800 }])));
  assert.equal(weak.gained, starGain(20, AI_RAID_STARS.win));
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
  assert.equal(p.trophies, TROPHY.start);
  const raw = JSON.parse(JSON.stringify(p));
  raw.v = 31;
  delete raw.trophies;
  const old = parseProfile(raw, 1);
  assert.ok(old);
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
  const again = applySync(profile, { holds: [{ id: shore, hold: rivalHold("ZZZZZZ") }] });
  assert.equal(again.profile.trophies, profile.trophies);
  assert.equal(again.notes.length, 0);
}

// Sync with a wiped log entry awards defence M (even → +30).
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
  const m = defenceWin(before, before); // unknown rival → even
  assert.equal(profile.trophies, before + m);
  assert.ok(notes.length === 1 && notes[0].includes(`守りきった +${m}`));
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
