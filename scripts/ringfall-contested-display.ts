/**
 * Contested hub display after a mirror sync (TKT-201): mergeHolds brings rival:neighbour,
 * and next hand shows 「{誰}の{拠点}」 when that code is among お隣.
 *   npx tsx scripts/ringfall-contested-display.ts
 */
import assert from "node:assert/strict";
import { applySync, mergeHolds } from "../src/ringfall/meta/expeditions";
import { CONTESTED_SHORES, type Neighbour } from "../src/ringfall/meta/neighbours";
import { newProfile } from "../src/ringfall/meta/profile";
import { rivalHold } from "../src/ringfall/sim/holds";
import { NODES } from "../src/ringfall/sim/map";
import { rivalFrontPick } from "../src/ringfall/view/hub";
import { nextAttack } from "../src/ringfall/view/copy";

const shore = CONTESTED_SHORES[0]!; // station
const shoreName = NODES.find((n) => n.id === shore)!.name;
const neighCode = "NEGH01";
const neighName = "ツバキ";

const neighbours: Neighbour[] = [
  { code: neighCode, name: neighName, held: 4, total: 21, day: 5, slot: 0, trophies: 1000 },
];

const store = new Map<string, string>();
(globalThis as { localStorage: Storage }).localStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => void store.set(k, v),
  removeItem: (k) => void store.delete(k),
  clear: () => void store.clear(),
  key: () => null,
  length: 0,
};
store.set("ringfall.neighbours.v1", JSON.stringify({ neighbours }));

{
  const p = newProfile(1);
  p.poiState = { ...p.poiState, [shore]: { state: "own" }, supply: { state: "own" } };
  const server = NODES.map((n) => ({
    id: n.id,
    hold: n.id === shore ? rivalHold(neighCode) : n.id === "supply" ? ("own" as const) : ("foe" as const),
  }));
  const merged = mergeHolds(p.poiState, server);
  assert.equal(merged[shore]?.state, rivalHold(neighCode));

  const lost = applySync(p, { holds: server });
  assert.ok((lost.profile.trophies ?? 0) < (p.trophies ?? 0));
  assert.ok(lost.notes.some((n) => n.includes("取られた")));

  const pick = rivalFrontPick(lost.profile);
  assert.ok(pick, "rivalFrontPick missed contested rival hub");
  assert.equal(pick!.name, `${neighName}の${shoreName}`);
  assert.ok(nextAttack(pick!.name).includes(pick!.name));
}

{
  // Idempotent sync: already rival → no second trophy hit; label still named.
  const p = newProfile(2);
  p.poiState = { ...p.poiState, [shore]: { state: rivalHold(neighCode) }, supply: { state: "own" } };
  const before = p.trophies;
  const again = applySync(p, {
    holds: NODES.map((n) => ({
      id: n.id,
      hold: n.id === shore ? rivalHold(neighCode) : n.id === "supply" ? ("own" as const) : ("foe" as const),
    })),
  });
  assert.equal(again.profile.trophies, before);
  assert.equal(again.notes.length, 0);
  assert.equal(rivalFrontPick(again.profile)?.name, `${neighName}の${shoreName}`);
}

console.log("contested-display ok");
