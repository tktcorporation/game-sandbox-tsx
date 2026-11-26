/*
 * Team-battle field lifecycle (作り順⑤ / meta/team-battle.ts):
 *   npx tsx scripts/ringfall-team-battle.ts
 *
 * Proves TEAM_BATTLE.days, matchmaking AI foe, field holds, sortie mark, auto-defence,
 * period settle win/loss, Profile v47 migrate, and field-raid island merge.
 */
import assert from "node:assert/strict";
import { newProfile, parseProfile, settle, bindTeamBattle } from "../src/ringfall/meta/profile";
import {
  TEAM_BATTLE,
  FIELD_NAME,
  applyFieldCaptures,
  autoDefendField,
  battleDue,
  battleOpen,
  daysLeft,
  ensureBattle,
  formFoeTeam,
  hubCounts,
  markSortie,
  mergeFieldHolds,
  openingHolds,
  outcomeOf,
  settleBattle,
  startBattle,
} from "../src/ringfall/meta/team-battle";
import { FIELD_HUBS, FIELD_NODES } from "../src/ringfall/sim/team-field";
import { fieldStars } from "../src/ringfall/meta/trophies";
import { advanceDay, raidDay } from "../src/ringfall/meta/island";
import { formTeam, TEAM } from "../src/ringfall/meta/team";
import { newRun, starterKit } from "../src/ringfall/sim/state";
import { POIS } from "../src/ringfall/sim/map";

const SELF = { id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", name: "テスト", code: "ABCDEF" };
const SALT = 42;

// --- Tunables + field map ---
{
  assert.equal(TEAM_BATTLE.days, 3, "period is 3 days");
  assert.equal(FIELD_HUBS.length, TEAM_BATTLE.hubs);
  assert.equal(FIELD_NAME, "荒地の戦場");
  assert.ok(FIELD_NODES.length === FIELD_HUBS.length);
  console.log(`field: ${FIELD_NAME} · ${FIELD_HUBS.map((h) => h.name).join(" / ")} · ${TEAM_BATTLE.days} days`);
}

// --- Matchmaking: AI foe fill ---
{
  const ours = formTeam(SELF, SALT, 1, 2);
  const b = startBattle(ours, SALT, 1);
  assert.equal(b.foe.members.length, TEAM.size);
  assert.ok(b.foe.members.every((m) => m.ai));
  assert.equal(b.days, TEAM_BATTLE.days);
  assert.equal(b.result, null);
  const n = hubCounts(b.holds);
  assert.equal(n.ours, TEAM_BATTLE.startOurs);
  assert.equal(n.ours + n.theirs, TEAM_BATTLE.hubs);
  const foe2 = formFoeTeam(SALT, 1, 0);
  assert.equal(foe2.members.length, TEAM.size);
  console.log(`match: ours ${n.ours} / foe ${n.theirs} · foe ${b.foe.members.map((m) => m.name).join(",")}`);
}

// --- Sortie + capture + auto-defence ---
{
  let b = startBattle(formTeam(SELF, SALT, 1, 0), SALT, 1);
  const firstTheirs = FIELD_HUBS.find((h) => b.holds[h.id] === "theirs")!;
  b = applyFieldCaptures(b, [firstTheirs.node]);
  assert.equal(b.holds[firstTheirs.id], "ours");
  // Without sortie that day, overnight takes one of ours when foe power wins (⑥).
  const before = hubCounts(b.holds).ours;
  b = { ...b, hooks: { ...b.hooks, warPower: 0, foeWarPower: 10 } };
  b = autoDefendField(b, 1);
  assert.equal(hubCounts(b.holds).ours, before - 1);
  // With sortie, overnight leaves holds alone.
  b = markSortie(b, 2);
  const mid = hubCounts(b.holds).ours;
  b = autoDefendField(b, 2);
  assert.equal(hubCounts(b.holds).ours, mid);
  console.log("sortie / capture / auto-defence ok");
}

// --- Period settle ---
{
  let b = startBattle(formTeam(SELF, SALT, 5, 0), SALT, 5);
  assert.equal(battleOpen(b, 5), true);
  assert.equal(daysLeft(b, 5), 3);
  assert.equal(battleDue(b, 7), false);
  assert.equal(battleDue(b, 8), true);
  // Give us the majority then settle.
  for (const h of FIELD_HUBS) b = { ...b, holds: { ...b.holds, [h.id]: "ours" } };
  b = settleBattle(b);
  assert.equal(b.result, "win");
  assert.equal(outcomeOf(openingHolds()), TEAM_BATTLE.startOurs > TEAM_BATTLE.hubs - TEAM_BATTLE.startOurs ? "win" : "loss");
  // TKT-219: all hubs → ★★★ (trophies do not move).
  assert.equal(fieldStars(TEAM_BATTLE.hubs, TEAM_BATTLE.hubs), 3);
  assert.equal(fieldStars(0, TEAM_BATTLE.hubs), 0);
  // ensureBattle opens the next match after the period.
  const next = ensureBattle(b, formTeam(SELF, SALT, 8, 0), SALT, 8);
  assert.equal(next.result, null);
  assert.equal(next.started, 8);
  console.log(`settle: win → next battle day ${next.started} · ★3`);
}

// --- Profile carries teamBattle (v48 current; v46 migrates in) ---
{
  const p = newProfile(9);
  assert.equal(p.v, 48);
  assert.ok(p.teamBattle);
  assert.equal(p.teamBattle!.days, TEAM_BATTLE.days);
  assert.equal(battleOpen(p.teamBattle, p.day), true);

  const raw = JSON.parse(JSON.stringify(p)) as Record<string, unknown>;
  raw.v = 46;
  delete raw.teamBattle;
  const migrated = parseProfile(raw, 9);
  assert.ok(migrated);
  assert.equal(migrated!.v, 48);
  assert.ok(migrated!.teamBattle);
  assert.equal(migrated!.teamBattle!.foe.members.length, TEAM.size);
  console.log("profile: v48 teamBattle + v46→v48 migrate");
}

// --- Field raid island merge + settle does not rewrite home poiState ---
{
  const p0 = bindTeamBattle(newProfile(11), SALT);
  const homeBefore = JSON.stringify(p0.poiState);
  const b = p0.teamBattle!;
  const island = mergeFieldHolds(
    POIS.map((x) => x.id),
    new Set(POIS.filter((x) => x.boss).map((x) => x.id)),
    b,
  );
  for (const h of FIELD_HUBS) {
    assert.equal(island[h.node], b.holds[h.id] === "ours" ? "own" : "foe");
  }
  const pad = POIS.find((x) => x.boss)!;
  assert.equal(island[pad.id], "foe");
  // A freeable non-field node is own (cleared).
  const other = POIS.find((x) => !x.boss && !FIELD_NODES.includes(x.id as (typeof FIELD_NODES)[number]))!;
  assert.equal(island[other.id], "own");

  const s = newRun(p0.seed, starterKit(), "harbor", {
    island,
    teamField: true,
    entry: "outskirts",
  });
  assert.equal(s.teamField, true);
  // Owned field hubs (and non-field "cleared" nodes) switch depots on in the raid — must not stick to the home profile.
  assert.ok(s.depots.some(Boolean), "field raid enables synthetic depots");
  assert.ok(s.found.includes("outskirts"), "field start walks the battlefield entry");
  // Force extract without captures.
  s.outcome = "extracted";
  s.player.haul = [];
  // The ordinary overnight pass lights home boxes at owned shores even
  // when the sortie did not use any home boxes.
  const homeDepotsAfterNight = advanceDay(p0, { ...raidDay(s), captured: [], battle: undefined }).profile.depots;
  assert.ok(homeDepotsAfterNight.length > 0, "owned home shores light their own boxes");
  const depotSentBefore = JSON.stringify(p0.depotSent);
  const entriesBefore = [...p0.entries];
  const settled = settle(p0, s);
  assert.equal(JSON.stringify(settled.profile.poiState), homeBefore, "home island unchanged by field raid");
  assert.deepEqual(settled.profile.depots, homeDepotsAfterNight, "field depots stay off the home profile");
  assert.equal(JSON.stringify(settled.profile.depotSent), depotSentBefore, "field sends do not level home depots");
  assert.deepEqual(settled.profile.entries, entriesBefore, "battlefield entry is not learned as a home way in");
  assert.ok(settled.profile.teamBattle);
  assert.ok(settled.profile.teamBattle!.sortied.includes(p0.day));
  console.log("field raid: home poiState/depots/entries intact, sortie marked");
}

console.log("ringfall-team-battle: ok");
