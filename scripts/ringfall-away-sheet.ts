/**
 * Boot defence sheet (TKT-192 PR6): awaySheetParts splits fresh news vs trophy line.
 *   npx tsx scripts/ringfall-away-sheet.ts
 */
import assert from "node:assert/strict";
import { awaySheetParts, TERM, trophyLine } from "../src/ringfall/view/copy";

assert.equal(awaySheetParts([], []), null);
assert.equal(awaySheetParts(["a"], ["a"]), null);

{
  const trop = trophyLine(1000, 970, 0, 30);
  const parts = awaySheetParts([], ["ツバキに補給所を取られた · 島の守りが削られた", trop]);
  assert.ok(parts);
  assert.deepEqual(parts!.lines, ["ツバキに補給所を取られた · 島の守りが削られた"]);
  assert.equal(parts!.trop, trop);
}

{
  const parts = awaySheetParts(["古い"], ["古い", "浄水場でツバキの遠征隊を撃退した"]);
  assert.ok(parts);
  assert.deepEqual(parts!.lines, ["浄水場でツバキの遠征隊を撃退した"]);
  assert.equal(parts!.trop, null);
}

{
  const trop = trophyLine(900, 930, 30, 0);
  const parts = awaySheetParts([], [trop]);
  assert.ok(parts);
  assert.deepEqual(parts!.lines, []);
  assert.equal(parts!.trop, trop);
  assert.ok(parts!.trop!.startsWith(TERM.trophy));
}

console.log("away sheet ok");
