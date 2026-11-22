/**
 * Unit checks for the use key's targeting (distance + facing + priority + hysteresis + cycle).
 *
 *   npx tsx scripts/ringfall-use.ts
 */
import assert from "node:assert/strict";
import { idleInput, newRun } from "../src/ringfall/sim/state";
import { USE } from "../src/ringfall/sim/config";
import { useCandCount, useCandidates, useFocusMark, useTarget } from "../src/ringfall/sim/world";
import { POIS } from "../src/ringfall/sim/map";
import { groundAt } from "../src/ringfall/sim/geom";
import { terrainHeight } from "../src/ringfall/sim/terrain";

const s = newRun(1);
const p = s.player;

// Stand at a ground-level closed bin at the supply depot; drop a weapon on it so two compete.
const bin = s.bins.find((b) => !b.open && b.poi === 0 && Math.abs(b.y - terrainHeight(b.x, b.z)) < 1.5)!;
assert.ok(bin, "supply has a ground-level closed bin");
const y = groundAt(bin.x, bin.z, 0.4, bin.y + 0.3);
p.pos = { x: bin.x, y, z: bin.z };
p.yaw = 0;
s.loot.push({
  id: 9_001,
  kind: "weapon",
  rarity: 1,
  weapon: { kind: "pike", rarity: 1, mag: -1 },
  pos: { x: bin.x + 0.15, y: bin.y, z: bin.z + 0.15 },
  vel: { x: 0, y: 0, z: 0 },
  age: 2,
});

const cands = useCandidates(s);
assert.ok(cands.length >= 2, `expected bin+weapon, got ${cands.map((c) => c.id).join(",")}`);
assert.equal(cands[0].t.kind, "bin", `bin should beat weapon at the same spot (prefer), got ${cands[0].t.kind}`);

const first = useTarget(s);
assert.equal(first?.kind, "bin");
assert.equal(s.useFocus?.startsWith("bin:"), true);
assert.ok(useFocusMark(s), "focus mark stands under the target");

// Facing the weapon and away from the bin should prefer the weapon once hysteresis allows.
const weapon = s.loot.find((l) => l.id === 9_001)!;
p.yaw = Math.atan2(weapon.pos.x - p.pos.x, -(weapon.pos.z - p.pos.z));
// Nudge closer to the weapon so facing + distance beat the sticky bin by USE.stick.
p.pos = { x: weapon.pos.x - Math.sin(p.yaw) * 0.4, y, z: weapon.pos.z + Math.cos(p.yaw) * 0.4 };
const faced = useCandidates(s);
const binCand = faced.find((c) => c.t.kind === "bin");
const gunCand = faced.find((c) => c.t.kind === "weapon");
assert.ok(binCand && gunCand, "both still in reach while facing the gun");
// Stick keeps the bin until the gun beats it by USE.stick.
s.useFocus = binCand!.id;
const stuck = useTarget(s);
if (gunCand!.score + USE.stick < binCand!.score) {
  assert.equal(stuck?.kind, "weapon", "hysteresis releases when facing strongly prefers the other");
} else {
  assert.equal(stuck?.kind, "bin", "hysteresis holds when the other is only slightly better");
  // Cycle must still move focus.
  const cycled = useTarget(s, true, true, true, true, true);
  assert.ok(cycled);
  assert.notEqual(s.useFocus, binCand!.id, "cycle advances sticky focus");
  assert.equal(useCandCount(s) >= 2, true);
}

// Cycle walks every candidate then wraps.
s.useFocus = null;
const ordered = useCandidates(s).map((c) => c.id);
assert.ok(ordered.length >= 2);
const seen: string[] = [];
for (let i = 0; i < ordered.length; i++) {
  useTarget(s, true, true, true, true, i > 0);
  seen.push(s.useFocus!);
}
assert.deepEqual(seen, ordered, "cycle follows score order");
useTarget(s, true, true, true, true, true);
assert.equal(s.useFocus, ordered[0], "cycle wraps");

// Ally hard-first: a downed teammate beats any loot.
s.ally.active = true;
s.ally.down = 2;
s.ally.pos = { ...p.pos };
const ally = useTarget(s);
assert.equal(ally?.kind, "ally");
assert.equal(useCandCount(s), 1);

// Input.cycleUse path: stepLoot-style call with cycle flag only.
s.ally.down = 0;
s.useFocus = null;
useTarget(s);
const before = s.useFocus;
useTarget(s, true, true, true, true, true);
assert.notEqual(s.useFocus, before);

// Idle input still carries cycleUse: false (determinism of the default).
assert.equal(idleInput().cycleUse, false);

console.log(`use targeting ok: ${POIS[0].name} bin+weapon, facing, stick=${USE.stick}, cycle, ally`);
