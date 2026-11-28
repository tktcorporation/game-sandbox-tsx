/*
 * Anti-snowball for own-island outer hubs (作り順③):
 *   npx tsx scripts/ringfall-outer-guard.ts
 *
 * Proves OUTER_GUARD.lossCap and island shield hold on the server island
 * (contestedMirror / isShielded) and on the pure client helpers.
 */
import assert from "node:assert/strict";
import {
  canLoseOuter,
  emptyOuterGuard,
  guardOn,
  mergeOuterGuard,
  OUTER_GUARD,
  recordOuterLoss,
  shieldRemainingMs,
  utcDay,
  utcDayEnd,
} from "../src/ringfall/meta/outer-guard";
import { applySync } from "../src/ringfall/meta/island-sync";
import {
  ISLAND_RULES,
  islandOp,
  isIslandShielded,
  isShielded,
  markIslandShield,
  NODE_IDS,
  outerTakenOn,
  type IslandState,
} from "../worker/island";
import { CONTESTED_SHORES } from "../src/ringfall/meta/neighbours";
import { newProfile } from "../src/ringfall/meta/profile";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 25, 12, 0, 0); // noon UTC — rest of day left
const T1 = T0 + ISLAND_RULES.protectDays * DAY + 1000;

const A = { id: "player-a", name: "アリス", code: "AAAAAA" };
const B = { id: "player-b", name: "ボブ", code: "BBBBBB" };

function island(holds: Record<string, string>, since = T0): IslandState {
  const r = islandOp(null, { t: "claim", player: A, code: A.code }, since);
  assert.equal(r.status, 201);
  const s = r.state!;
  for (const [id, h] of Object.entries(holds)) {
    const i = NODE_IDS.indexOf(id);
    assert.ok(i >= 0, `unknown node ${id}`);
    s.holds[i] = h as IslandState["holds"][number];
  }
  return s;
}

function op(s: IslandState, body: Parameters<typeof islandOp>[1], at: number) {
  return islandOp(s, body, at);
}

// --- Pure helpers ---
{
  const g0 = emptyOuterGuard();
  assert.equal(canLoseOuter(g0, T1), true);
  assert.equal(shieldRemainingMs(g0, T1), 0);
  const g1 = recordOuterLoss(g0, T1);
  assert.equal(g1.lost, 1);
  assert.equal(g1.island, true);
  assert.equal(g1.utcDay, utcDay(T1));
  assert.equal(canLoseOuter(g1, T1), false);
  assert.ok(shieldRemainingMs(g1, T1) > 0);
  assert.ok(shieldRemainingMs(g1, T1) <= utcDayEnd(T1) - T1);
  // Next UTC day: shield and loss count reset.
  const next = T1 + DAY;
  assert.equal(canLoseOuter(g1, next), true);
  assert.deepEqual(guardOn(g1, next), { utcDay: utcDay(next), lost: 0, island: false });
  assert.equal(OUTER_GUARD.lossCap, 1, "lossCap should be the tunable constant 1");
  // mergeOuterGuard keeps local AI protection when the server snapshot is empty.
  const local = recordOuterLoss(emptyOuterGuard(), T1);
  const merged = mergeOuterGuard(local, emptyOuterGuard(), T1);
  assert.equal(merged.island, true);
  assert.equal(merged.lost, 1);
  assert.equal(canLoseOuter(merged, T1), false);
  console.log("pure: lossCap + island shield until UTC day end");
}

// --- Server: the first holding a sortie takes raises the island's shield; a second is held the same day ---
{
  const shores = CONTESTED_SHORES.filter((id) => NODE_IDS.includes(id));
  assert.ok(shores.length >= 2, "need ≥2 holdings");
  const a = shores[0]!;
  const b = shores[1]!;
  const holds: Record<string, string> = { supply: "own" };
  for (const id of shores) holds[id] = "own";
  const s = island(holds, T0);
  const raid = (target: string, at: number) => op(s, { t: "raid", from: { code: B.code, name: B.name }, target, captured: true, stars: 3 }, at);

  const first = raid(a, T1);
  assert.equal(first.status, 200, `first take failed: ${JSON.stringify(first.body)}`);
  assert.equal((first.body as { taken?: boolean }).taken, true);
  assert.equal(s.holds[NODE_IDS.indexOf(a)], "foe", "a holding taken did not go back to the robots");
  assert.ok(isIslandShielded(s, T1), "island shield not raised after first loss");
  assert.ok(isShielded(s, NODE_IDS.indexOf(b), T1), "remaining holding not island-shielded");
  assert.equal(outerTakenOn(s, T1), 1);
  assert.equal(s.shielded?.island, true);

  const second = raid(b, T1 + 1000);
  assert.equal((second.body as { taken?: boolean }).taken, false, "a second holding was taken the same day");
  assert.equal(s.holds[NODE_IDS.indexOf(b)], "own", "second holding changed hands despite the guard");
  assert.equal(s.log.at(-1)?.t, "wiped");

  // Next UTC day: the second holding can be taken.
  const later = raid(b, T1 + DAY);
  assert.equal((later.body as { taken?: boolean }).taken, true, `next-day take failed: ${JSON.stringify(later.body)}`);
  assert.equal(s.holds[NODE_IDS.indexOf(b)], "foe");
  console.log(`server: took ${a}, held ${b} the same day, took ${b} the next day`);
}

// --- Loss cap alone: even without the island's flag, outerTaken.n >= lossCap holds ---
{
  const shore = CONTESTED_SHORES.find((id) => NODE_IDS.includes(id))!;
  const s = island({ [shore]: "own", supply: "own" }, T0);
  s.outerTaken = { day: utcDay(T1), n: OUTER_GUARD.lossCap };
  s.shielded = { day: utcDay(T1), nodes: [], island: false };
  const held = op(s, { t: "raid", from: { code: B.code, name: B.name }, target: shore, captured: true, stars: 3 }, T1);
  assert.equal((held.body as { taken?: boolean }).taken, false);
  assert.equal(s.holds[NODE_IDS.indexOf(shore)], "own");
  console.log("server: the loss cap alone holds a holding");
}

// --- applySync keeps local AI protection when server view is empty ---
{
  const now = Date.now();
  const p = newProfile(1);
  p.outerGuard = recordOuterLoss(emptyOuterGuard(), now);
  const synced = applySync(p, {
    outerGuard: { utcDay: utcDay(now), lost: 0, island: false },
  });
  assert.equal(synced.profile.outerGuard?.island, true, "AI local shield cleared by empty server guard");
  assert.equal(synced.profile.outerGuard?.lost, 1);
  assert.equal(canLoseOuter(synced.profile.outerGuard, now), false);
  console.log("client: applySync merges local AI outerGuard with server");
}

// --- markIslandShield helper ---
{
  const s = island({ supply: "own" }, T0);
  markIslandShield(s, T1);
  assert.ok(isIslandShielded(s, T1));
  assert.equal(isIslandShielded(s, T1 + DAY), false);
  console.log("server: markIslandShield day-bounded");
}

console.log("outer-guard ok");
