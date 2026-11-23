/**
 * Gap A: neighbour front marks when the route is open and that neighbour has no foothold.
 *   npx tsx scripts/ringfall-neighbour-front.ts
 */
import assert from "node:assert/strict";
import { neighbourFronts, neighbourFrontPick } from "../src/ringfall/meta/neighbour-front";
import { NEIGHBOUR_SLOTS } from "../src/ringfall/meta/neighbours";
import type { Neighbour } from "../src/ringfall/meta/neighbours";
import { newIsland } from "../src/ringfall/meta/island";
import { rivalHold } from "../src/ringfall/sim/holds";
import { NODES, nodeIndex } from "../src/ringfall/sim/map";
import { aiOwner } from "../src/ringfall/sim/holds";

const neighbours: Neighbour[] = [
  { code: "AAAAAA", name: "となり", held: 7, total: 21, day: 3, slot: 0 },
  { code: "BBBBBB", name: "ツバキ", held: 4, total: 21, day: 2, slot: 1, ai: true },
];

// No shore held → no fronts.
{
  const island = newIsland();
  assert.equal(neighbourFronts(island, neighbours).length, 0);
}

// Hold shore of slot 0 → one front for となり.
{
  const island = newIsland();
  const shore = NEIGHBOUR_SLOTS[0].shore;
  island[shore] = { state: "freed" };
  const fronts = neighbourFronts(island, neighbours);
  assert.equal(fronts.length, 1);
  assert.equal(fronts[0].name, "となりの前線");
  assert.equal(fronts[0].shore, shore);
  const pick = neighbourFrontPick(island, neighbours, { x: 0, z: 0 });
  assert.equal(pick?.name, "となりの前線");
}

// Foothold of that neighbour removes the mark.
{
  const island = newIsland();
  const shore = NEIGHBOUR_SLOTS[0].shore;
  island[shore] = { state: "freed" };
  const other = NODES.find((n) => n.id !== shore)!;
  island[other.id] = { state: rivalHold("AAAAAA") };
  assert.equal(neighbourFronts(island, neighbours).length, 0);
}

// AI foothold keyed as aiOwner(code).
{
  const island = newIsland();
  const shore = NEIGHBOUR_SLOTS[1].shore;
  island[shore] = { state: "freed" };
  assert.equal(neighbourFronts(island, neighbours).some((f) => f.code === "BBBBBB"), true);
  const other = NODES.find((n) => n.id !== shore && nodeIndex(n.id) >= 0)!;
  island[other.id] = { state: rivalHold(aiOwner("BBBBBB")) };
  assert.equal(neighbourFronts(island, neighbours).some((f) => f.code === "BBBBBB"), false);
}

console.log("neighbour front ok");
