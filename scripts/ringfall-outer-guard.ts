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
  OUTER_GUARD,
  recordOuterLoss,
  shieldRemainingMs,
  utcDay,
  utcDayEnd,
} from "../src/ringfall/meta/outer-guard";
import {
  EXPEDITION,
  islandOp,
  isIslandShielded,
  isShielded,
  markIslandShield,
  NODE_IDS,
  type IslandState,
} from "../worker/island";
import { CONTESTED_SHORES } from "../src/ringfall/meta/neighbours";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 25, 12, 0, 0); // noon UTC — rest of day left
const T1 = T0 + EXPEDITION.protectDays * DAY + 1000;

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
  console.log("pure: lossCap + island shield until UTC day end");
}

// --- Server: first contested mirror take raises island shield; second hub refused ---
{
  const shores = CONTESTED_SHORES.filter((id) => NODE_IDS.includes(id));
  assert.ok(shores.length >= 2, "need ≥2 contested shores");
  const a = shores[0]!;
  const b = shores[1]!;
  const holds: Record<string, string> = { supply: "own" };
  for (const id of shores) holds[id] = "own";
  const s = island(holds, T0);

  const first = op(s, { t: "contestedMirror", shore: a, owner: B.code, name: B.name, at: T1 }, T1);
  assert.equal(first.status, 200, `first take failed: ${JSON.stringify(first.body)}`);
  assert.equal(s.holds[NODE_IDS.indexOf(a)], `rival:${B.code}`);
  assert.ok(isIslandShielded(s, T1), "island shield not raised after first loss");
  assert.ok(isShielded(s, NODE_IDS.indexOf(a), T1), "taken hub not per-hub shielded");
  assert.ok(isShielded(s, NODE_IDS.indexOf(b), T1), "remaining own hub not island-shielded");
  assert.equal(s.taken.n, 1);
  assert.equal(s.shielded?.island, true);

  const second = op(s, { t: "contestedMirror", shore: b, owner: B.code, name: B.name, at: T1 + 1000 }, T1 + 1000);
  assert.equal(second.status, 409, "second outer hub should be refused same day");
  const err = (second.body as { error?: string }).error;
  assert.ok(err === "shielded" || err === "day-limit", `unexpected error ${err}`);
  assert.equal(s.holds[NODE_IDS.indexOf(b)], "own", "second hub ownership flipped despite guard");

  // Next UTC day: second hub can be taken.
  const nextDay = T1 + DAY;
  const later = op(s, { t: "contestedMirror", shore: b, owner: B.code, name: B.name, at: nextDay }, nextDay);
  assert.equal(later.status, 200, `next-day take failed: ${JSON.stringify(later.body)}`);
  assert.equal(s.holds[NODE_IDS.indexOf(b)], `rival:${B.code}`);
  console.log(`server: took ${a}, blocked ${b} same day, took ${b} next day`);
}

// --- Loss cap alone: even without island flag, taken.n >= lossCap blocks ---
{
  const shore = CONTESTED_SHORES.find((id) => NODE_IDS.includes(id))!;
  const s = island({ [shore]: "own", supply: "own" }, T0);
  s.taken = { day: utcDay(T1), n: OUTER_GUARD.lossCap };
  // Force no island flag so we exercise the cap path.
  s.shielded = { day: utcDay(T1), nodes: [], island: false };
  const blocked = op(s, { t: "contestedMirror", shore, owner: B.code, name: B.name, at: T1 }, T1);
  assert.equal(blocked.status, 409);
  assert.equal((blocked.body as { error?: string }).error, "day-limit");
  assert.equal(s.holds[NODE_IDS.indexOf(shore)], "own");
  console.log("server: lossCap alone refuses contestedMirror");
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
