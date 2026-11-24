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
  const parts = awaySheetParts([], ["ツバキに補給所を取られた · 島の守りがツバキの倉庫へ", trop]);
  assert.ok(parts);
  assert.deepEqual(parts!.lines, ["ツバキに補給所を取られた · 島の守りがツバキの倉庫へ"]);
  assert.equal(parts!.trop, trop);
}

{
  const parts = awaySheetParts(["古い"], ["古い", "ツバキが浄水場を攻めた · 守りきった"]);
  assert.ok(parts);
  assert.deepEqual(parts!.lines, ["ツバキが浄水場を攻めた · 守りきった"]);
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

// Same wording twice: the second occurrence is still fresh (count, not Set).
{
  const line = "ツバキに補給所を取られた · 島の守りがツバキの倉庫へ";
  const parts = awaySheetParts([line], [line, line]);
  assert.ok(parts);
  assert.deepEqual(parts!.lines, [line]);
  assert.equal(parts!.trop, null);
}

console.log("away sheet ok");
