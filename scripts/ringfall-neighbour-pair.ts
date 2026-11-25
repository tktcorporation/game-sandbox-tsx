/**
 * Mutual weekly neighbour pairing (TKT-201 / worker/neighbour-pair.ts).
 *   npx tsx scripts/ringfall-neighbour-pair.ts
 */
import assert from "node:assert/strict";
import { freeSlot, picksAreMutual, planMutualPicks, type PairCandidate, type PairPick } from "../worker/neighbour-pair";

assert.equal(freeSlot(new Set(), 4, 2), 2);
assert.equal(freeSlot(new Set([2]), 4, 2), 0);
assert.equal(freeSlot(new Set([0, 1, 2, 3]), 4), null);

{
  const pool: PairCandidate[] = [
    { code: "BB0001", playerId: "p1", trophies: 1000 },
    { code: "BB0002", playerId: "p2", trophies: 1010 },
    { code: "BB0003", playerId: "p3", trophies: 990 },
    { code: "BB0004", playerId: "p4", trophies: 1020 },
  ];
  const empty = new Map<string, PairPick[]>();
  const a = planMutualPicks({ code: "AA0000", trophies: 1000 }, pool, 42, empty, 4);
  assert.equal(a.self.length, 4);
  assert.equal(a.reciprocal.length, 4);
  // Every reciprocal lists AA0000 back.
  assert.ok(a.reciprocal.every((r) => r.code === "AA0000"));
  // Reciprocal slots are free and within 0..3.
  assert.ok(a.reciprocal.every((r) => r.slot >= 0 && r.slot < 4));
  // Build the map as if both sides wrote, and check symmetry.
  const byCode = new Map<string, PairPick[]>();
  byCode.set("AA0000", a.self);
  for (const r of a.reciprocal) {
    const cand = pool.find((c) => c.playerId === r.playerId)!;
    byCode.set(cand.code, [...(byCode.get(cand.code) ?? []), { slot: r.slot, code: r.code }]);
  }
  assert.ok(picksAreMutual("AA0000", a.self, byCode), "draw is not mutual");
}

{
  // Prefer already-mutual: B already lists A in slot 1 → A should keep B and prefer slot 1.
  const pool: PairCandidate[] = [
    { code: "BB0001", playerId: "p1", trophies: 1500 }, // far
    { code: "BB0002", playerId: "p2", trophies: 1000 }, // near, already mutual
    { code: "BB0003", playerId: "p3", trophies: 1005 },
  ];
  const existing = new Map<string, PairPick[]>([["p2", [{ slot: 1, code: "AA0000" }]]]);
  const a = planMutualPicks({ code: "AA0000", trophies: 1000 }, pool, 7, existing, 2);
  assert.ok(a.self.some((p) => p.code === "BB0002"), "already-mutual neighbour dropped");
  const b = a.self.find((p) => p.code === "BB0002")!;
  assert.equal(b.slot, 1, `already-mutual should prefer their slot, got ${b.slot}`);
  // No reciprocal write for B (already has us).
  assert.ok(!a.reciprocal.some((r) => r.playerId === "p2"));
}

{
  // Full week without us → skipped.
  const pool: PairCandidate[] = [
    { code: "FULL01", playerId: "pf", trophies: 1000 },
    { code: "OPEN01", playerId: "po", trophies: 1000 },
  ];
  const existing = new Map<string, PairPick[]>([
    [
      "pf",
      [
        { slot: 0, code: "XXXXX1" },
        { slot: 1, code: "XXXXX2" },
        { slot: 2, code: "XXXXX3" },
        { slot: 3, code: "XXXXX4" },
      ],
    ],
  ]);
  const a = planMutualPicks({ code: "AA0000", trophies: 1000 }, pool, 1, existing, 4);
  assert.ok(!a.self.some((p) => p.code === "FULL01"), "full week without us was picked");
  assert.ok(a.self.some((p) => p.code === "OPEN01"), "open neighbour not picked");
}

console.log("neighbour-pair ok");
