/**
 * Trophy T1: take a rival node → gain; lose to a rival → lose. Gap scales the swap.
 *   npx tsx scripts/ringfall-trophies.ts
 */
import assert from "node:assert/strict";
import { newProfile, parseProfile } from "../src/ringfall/meta/profile";
import { TROPHY, clampTrophies, trophyDelta, trophySwap } from "../src/ringfall/meta/trophies";
import { rivalHold } from "../src/ringfall/sim/holds";
import { NODES } from "../src/ringfall/sim/map";

assert.equal(clampTrophies(-10), 0);
assert.equal(clampTrophies(99999), TROPHY.max);

{
  const even = trophySwap(1000, 1000);
  assert.equal(even.gain, TROPHY.base);
  const up = trophySwap(1000, 1400);
  assert.ok(up.gain > TROPHY.base);
  const down = trophySwap(1400, 1000);
  assert.ok(down.gain < TROPHY.base);
}

{
  const before = NODES.map(() => "held" as const);
  const after = [...before];
  const i = 0;
  before[i] = rivalHold("AAAAAA");
  after[i] = "freed";
  const d = trophyDelta(1000, before, after);
  assert.ok(d.gained >= TROPHY.base - TROPHY.maxBonus);
  assert.equal(d.taken.length, 1);
  assert.equal(d.next, 1000 + d.gained);
}

{
  const before = NODES.map(() => "held" as const);
  const after = [...before];
  before[0] = "freed";
  after[0] = rivalHold("BBBBBB");
  const d = trophyDelta(1000, before, after);
  assert.ok(d.lost > 0);
  assert.equal(d.dropped.length, 1);
  assert.equal(d.next, 1000 - d.lost);
}

{
  const p = newProfile(1);
  assert.equal(p.v, 32);
  assert.equal(p.trophies, TROPHY.start);
  const raw = JSON.parse(JSON.stringify(p));
  raw.v = 31;
  delete raw.trophies;
  const old = parseProfile(raw, 1);
  assert.ok(old);
  assert.equal(old.v, 32);
  assert.equal(old.trophies, TROPHY.start);
}

console.log("trophies ok");
