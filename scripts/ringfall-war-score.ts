/*
 * War power / raid targeting / bounty / team score (作り順⑥ / meta/war-score.ts):
 *   npx tsx scripts/ringfall-war-score.ts
 *
 * Proves WAR_POWER → field overnight defence, RAID_TARGET trophy band + sort,
 * BOUNTY materials, TEAM_SCORE on TeamBattle.score, Profile v48 migrate (no personal warScore),
 * pouch take-home unchanged by power.
 */
import assert from "node:assert/strict";
import { newProfile, parseProfile, seizeRivalLoot } from "../src/ringfall/meta/profile";
import {
  BOUNTY,
  RAID_TARGET,
  TEAM_SCORE,
  WAR_POWER,
  battlePointsFor,
  bountyOwnersFrom,
  canRaidOwner,
  fieldHoldsOvernight,
  hubDayPoints,
  pickLeader,
  raidTargetRank,
  takeHomeSlots,
  warPowerOf,
} from "../src/ringfall/meta/war-score";
import { rivalOf } from "../src/ringfall/sim/holds";
import {
  autoDefendField,
  settleBattle,
  startBattle,
  tickTeamScore,
  warPowerOf as battleWarPower,
} from "../src/ringfall/meta/team-battle";
import { formTeam } from "../src/ringfall/meta/team";
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
  assert.equal(RAID_TARGET.requireBand, true);
  assert.equal(BOUNTY.extraMaterials, 3);
  assert.equal(TEAM_SCORE.perHubDay, 1);
  assert.equal(TEAM_SCORE.battle.win, 30);
  console.log(
    `tunables: power/outer=${WAR_POWER.perOuter} · band=${RAID_TARGET.trophyBand} · requireBand · bounty+${BOUNTY.extraMaterials} · teamScore hubDay=${TEAM_SCORE.perHubDay}`,
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
  assert.equal(b.score, 0, "new battle starts at team score 0");
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

// --- Raid targeting: trophy band + closeness (no foe-team priority) ---
{
  assert.equal(canRaidOwner("anyone", 1000, 1000), true);
  assert.equal(canRaidOwner("far", 1000, 1500), false, "outside ±400 dropped");
  assert.equal(canRaidOwner("edge", 1000, 1400), true);
  const near = raidTargetRank(1000, 1010, 100);
  const far = raidTargetRank(1000, 1300, 10);
  assert.ok(near < far, "closer trophies rank first even if farther on ground");
  const rows = attackScouts(newIsland(), 1, [], 1000, [], 0, { x: 0, z: 0 }, { foe: null });
  assert.ok(Array.isArray(rows));
  console.log("raid target: trophy band ±400 · closeness first");
}

// --- Leader bounty ---
{
  assert.equal(pickLeader([{ id: "a", outer: 2 }, { id: "b", outer: 5 }, { id: "c", outer: 5, trophies: 10 }]), "c");

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

// --- Team score on the battle (match-only; resets on new battle) ---
{
  const ours = formTeam(SELF, SALT, 1, 2);
  let b = startBattle(ours, SALT, 1);
  assert.equal(b.score, 0);
  const hubs = Object.values(b.holds).filter((h) => h === "ours").length;
  b = tickTeamScore(b);
  assert.equal(b.score, hubDayPoints(hubs));
  b = tickTeamScore(b);
  assert.equal(b.score, hubDayPoints(hubs) * 2);
  const beforeSettle = b.score;
  b = settleBattle(b);
  assert.ok(b.result);
  assert.equal(b.score, beforeSettle + battlePointsFor(b.result!));
  const next = startBattle(ours, SALT, 10);
  assert.equal(next.score, 0, "new battle resets team score");
  console.log(`team score: hub-days + settle ${b.result}=${battlePointsFor(b.result!)} · next=0`);
}

// --- Profile v48: no personal warScore; teamBattle.score present ---
{
  const p = newProfile(9);
  assert.equal(p.v, 48);
  assert.equal("warScore" in p, false, "personal warScore must be gone");
  assert.ok(p.teamBattle);
  assert.equal(p.teamBattle!.score, 0);
  assert.ok(p.teamBattle?.hooks.warPower !== undefined);
  assert.equal(battleWarPower(p.team, p.teamBattle!.hooks), warPowerOf(p.team));

  const raw = JSON.parse(JSON.stringify(p)) as Record<string, unknown>;
  raw.v = 47;
  raw.warScore = { total: 99, outerByDay: [{ day: 1, outer: 3 }], lastBattle: 30 };
  delete (raw.teamBattle as Record<string, unknown>).score;
  const migrated = parseProfile(raw, 9);
  assert.ok(migrated);
  assert.equal(migrated!.v, 48);
  assert.equal("warScore" in migrated!, false);
  assert.ok(migrated!.teamBattle);
  assert.equal(typeof migrated!.teamBattle!.score, "number");
  console.log("profile: v48 teamBattle.score · v47 warScore dropped");
}

console.log("ringfall-war-score: ok");
