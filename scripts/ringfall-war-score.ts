/*
 * War power / raid targeting / bounty / scoring (作り順⑥ / meta/war-score.ts):
 *   npx tsx scripts/ringfall-war-score.ts
 *
 * Proves WAR_POWER → field overnight defence, RAID_TARGET sort, BOUNTY materials,
 * WAR_SCORE window + battle points, Profile v48 migrate, pouch take-home unchanged by power.
 */
import assert from "node:assert/strict";
import { newProfile, parseProfile, seizeRivalLoot } from "../src/ringfall/meta/profile";
import {
  BOUNTY,
  RAID_TARGET,
  WAR_POWER,
  WAR_SCORE,
  addBattleScore,
  bountyOwnersFrom,
  canRaidOwner,
  emptyWarScore,
  fieldHoldsOvernight,
  foeOwnerKeys,
  holdPointsOf,
  pickLeader,
  raidTargetRank,
  recordOuterDay,
  takeHomeSlots,
  warPowerOf,
} from "../src/ringfall/meta/war-score";
import { rivalOf } from "../src/ringfall/sim/holds";
import {
  autoDefendField,
  startBattle,
  warPowerOf as battleWarPower,
} from "../src/ringfall/meta/team-battle";
import { formTeam, TEAM } from "../src/ringfall/meta/team";
import { emptyHideout } from "../src/ringfall/meta/hideout";
import { SEIZE } from "../src/ringfall/meta/trophies";
import { attackScouts } from "../src/ringfall/meta/attack-scout";
import { newIsland } from "../src/ringfall/meta/island";
import { META } from "../src/ringfall/sim/config";
import { POIS, poiIndex } from "../src/ringfall/sim/map";
import { CONTESTED_SHORES } from "../src/ringfall/meta/neighbours";
import { rivalHold, type PoiHold } from "../src/ringfall/sim/holds";

const SELF = { id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", name: "テスト", code: "ABCDEF" };
const SALT = 42;

// --- Tunables ---
{
  assert.equal(WAR_POWER.perOuter, 1);
  assert.equal(WAR_POWER.defendGap, 0);
  assert.equal(RAID_TARGET.trophyBand, 400);
  assert.equal(RAID_TARGET.requireNearOrFoe, false);
  assert.equal(BOUNTY.extraMaterials, 3);
  assert.equal(WAR_SCORE.windowDays, 7);
  assert.equal(WAR_SCORE.battle.win, 30);
  console.log(
    `tunables: power/outer=${WAR_POWER.perOuter} · band=${RAID_TARGET.trophyBand} · bounty+${BOUNTY.extraMaterials} · window=${WAR_SCORE.windowDays}d`,
  );
}

// --- War power from outer hubs ---
{
  const weak = formTeam(SELF, SALT, 1, 1);
  const strong = formTeam(SELF, SALT, 1, 6);
  assert.equal(warPowerOf(weak), 1 + weak.members.filter((m) => m.ai).reduce((n, m) => n + m.outer, 0));
  assert.ok(warPowerOf(strong) > warPowerOf(weak));
  assert.equal(takeHomeSlots(emptyHideout(), warPowerOf(strong)), META.pouch, "war power must not raise pouch");
  console.log(`power: weak ${warPowerOf(weak)} / strong ${warPowerOf(strong)} · pouch ${takeHomeSlots(emptyHideout())}`);
}

// --- Field overnight defence weighted by power ---
{
  const ours = formTeam(SELF, SALT, 1, 8);
  let b = startBattle(ours, SALT, 1);
  assert.ok((b.hooks.warPower ?? 0) >= 8);
  assert.ok((b.hooks.foeWarPower ?? 0) >= 0);
  assert.ok(b.hooks.bountyTarget);
  const before = Object.values(b.holds).filter((h) => h === "ours").length;
  // Strong ours vs weak foe snapshot: should hold.
  b = { ...b, hooks: { ...b.hooks, warPower: 20, foeWarPower: 2 } };
  b = autoDefendField(b, 1, ours);
  assert.equal(Object.values(b.holds).filter((h) => h === "ours").length, before, "strong side holds overnight");
  // Weak ours: lose one hub when not sortied.
  b = { ...b, hooks: { ...b.hooks, warPower: 0, foeWarPower: 10 }, sortied: [] };
  const mid = Object.values(b.holds).filter((h) => h === "ours").length;
  b = autoDefendField(b, 1, formTeam(SELF, SALT, 1, 0));
  assert.equal(Object.values(b.holds).filter((h) => h === "ours").length, mid - 1, "weak side loses one hub");
  assert.equal(fieldHoldsOvernight(5, 5), true);
  assert.equal(fieldHoldsOvernight(4, 5), false);
  console.log("field: war-power overnight defence ok");
}

// --- Raid targeting prefer / rank ---
{
  const foe = startBattle(formTeam(SELF, SALT, 1, 0), SALT, 1).foe;
  const keys = foeOwnerKeys(foe);
  assert.ok(keys.size >= TEAM.size);
  const m0 = foe.members[0]!;
  assert.equal(canRaidOwner(`ai-${m0.code}`, 1000, 1000, keys), true);
  assert.equal(canRaidOwner("zzzzzz", 1000, 1000, keys), true, "requireNearOrFoe off → anyone");
  const near = raidTargetRank("other", 1000, 1010, keys, 10);
  const far = raidTargetRank("other", 1000, 1800, keys, 10);
  assert.ok(near < far, "closer trophies rank first");
  const foeRank = raidTargetRank(`ai-${m0.code}`, 1000, 1800, keys, 100);
  const otherRank = raidTargetRank("other", 1000, 1000, keys, 1);
  assert.ok(foeRank < otherRank, "foe team beats trophy-near stranger");
  console.log("raid target: prefer foe team + trophy proximity");
}

// --- Leader bounty ---
{
  assert.equal(pickLeader([{ id: "a", outer: 2 }, { id: "b", outer: 5 }, { id: "c", outer: 5, trophies: 10 }]), "c");
  const rows = attackScouts(newIsland(), 1, [], 1000, [], 0, { x: 0, z: 0 }, { foe: null });
  assert.ok(Array.isArray(rows));

  // Rank among ALL holders at raid start — capturing only the weak rival pays no bounty.
  const weak = "ai-WEAK01";
  const strong = "ai-STRNG1";
  const shores = CONTESTED_SHORES.filter((id) => poiIndex(id) >= 0);
  assert.ok(shores.length >= 3, "need ≥3 contested shores for bounty test");
  const hold = POIS.map((): PoiHold => "foe");
  hold[poiIndex(shores[0]!)] = rivalHold(weak);
  hold[poiIndex(shores[1]!)] = rivalHold(strong);
  hold[poiIndex(shores[2]!)] = rivalHold(strong);
  const p = newProfile(5);
  const base = SEIZE.emptyReserve + SEIZE.bonus;
  const heldBy = new Map<string, number>();
  for (const h of hold) {
    const who = rivalOf(h);
    if (!who) continue;
    heldBy.set(who, (heldBy.get(who) ?? 0) + 1);
  }
  assert.equal(heldBy.get(strong), 2);
  assert.equal(heldBy.get(weak), 1);
  assert.equal(bountyOwnersFrom(heldBy, [weak]).has(weak), false, "weak alone is not the leader");
  assert.equal(bountyOwnersFrom(heldBy, [strong]).has(strong), true, "strong is the leader");
  const weakLoot = seizeRivalLoot(p, { hold, seed: p.seed, stats: { captured: [shores[0]!] } }, bountyOwnersFrom(heldBy, [weak]));
  assert.equal(weakLoot.at[0]!.kinds.length, base, "weak capture must not pay leader bounty");
  const strongLoot = seizeRivalLoot(
    p,
    { hold, seed: p.seed, stats: { captured: [shores[1]!] } },
    bountyOwnersFrom(heldBy, [strong]),
  );
  assert.equal(
    strongLoot.at[0]!.kinds.length,
    base + BOUNTY.extraMaterials,
    "capturing the leader pays bounty",
  );
  console.log(`bounty: leader +${BOUNTY.extraMaterials} materials · weak=${base} strong=${base + BOUNTY.extraMaterials}`);
}

// --- Score window + battle points ---
{
  let s = emptyWarScore();
  s = recordOuterDay(s, 1, 3);
  s = recordOuterDay(s, 2, 4);
  assert.equal(holdPointsOf(s), 3 + 4);
  s = addBattleScore(s, "win");
  assert.equal(s.lastBattle, WAR_SCORE.battle.win);
  assert.equal(s.total, 3 + 4 + WAR_SCORE.battle.win);
  // Window trims days older than windowDays.
  s = recordOuterDay(s, 1 + WAR_SCORE.windowDays, 1);
  assert.ok(!s.outerByDay.some((x) => x.day === 1), "day 1 dropped from window");
  assert.ok(s.total >= WAR_SCORE.battle.win, "battle points survive window trim");
  console.log(`score: hold ${holdPointsOf(s)} + battles · total ${s.total}`);
}

// --- Profile v48 + migrate from v47 ---
{
  const p = newProfile(9);
  assert.equal(p.v, 48);
  assert.ok(p.warScore);
  assert.equal(p.warScore.total, 0);
  assert.ok(p.teamBattle?.hooks.warPower !== undefined);
  assert.equal(battleWarPower(p.team, p.teamBattle!.hooks), warPowerOf(p.team));

  const raw = JSON.parse(JSON.stringify(p)) as Record<string, unknown>;
  raw.v = 47;
  delete raw.warScore;
  const migrated = parseProfile(raw, 9);
  assert.ok(migrated);
  assert.equal(migrated!.v, 48);
  assert.ok(migrated!.warScore);
  assert.equal(migrated!.warScore.total, 0);
  console.log("profile: v48 new + v47→v48 migrate");
}

console.log("ringfall-war-score: ok");
