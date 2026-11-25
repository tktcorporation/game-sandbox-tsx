/*
 * 4-person teams (作り順④ / meta/team.ts):
 *   npx tsx scripts/ringfall-team.ts
 *
 * Proves TEAM.size seats, AI fill, outer-hub growth, Profile v46 migrate, and ensureTeam refresh.
 */
import assert from "node:assert/strict";
import { CONTESTED_OUTER } from "../src/ringfall/sim/contested-outer";
import { newIsland } from "../src/ringfall/meta/island";
import { bindTeam, newProfile, parseProfile, type Profile } from "../src/ringfall/meta/profile";
import {
  TEAM,
  aiMateIsland,
  aiMateOuter,
  ensureTeam,
  formTeam,
  memberLabel,
  parseTeam,
  selfOuterCount,
  teamIdFor,
} from "../src/ringfall/meta/team";

const SALT = 42;
const SELF = { id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", name: "テスト", code: "ABCDEF" };

// --- Size + AI fill ---
{
  const t = formTeam(SELF, SALT, 1, 0);
  assert.equal(t.members.length, TEAM.size);
  assert.equal(t.members.filter((m) => !m.ai).length, 1);
  assert.equal(t.members.filter((m) => m.ai).length, TEAM.size - 1);
  assert.equal(t.members[0]!.id, SELF.id);
  assert.equal(t.members[0]!.outer, 0);
  for (const m of t.members.filter((x) => x.ai)) {
    assert.ok(m.id.startsWith("ai-"));
    assert.ok(m.code.length >= 4);
    assert.equal(memberLabel(m).endsWith(" · AI"), true);
  }
  assert.equal(t.id, teamIdFor(SELF.id));
  console.log(`form: ${t.members.map((m) => memberLabel(m)).join(" / ")}`);
}

// --- AI outer growth + salt stability ---
{
  const a = aiMateIsland(SALT, 0);
  const b = aiMateIsland(SALT, 0);
  assert.deepEqual(a, b, "same salt/slot → same AI mate island");
  const other = aiMateIsland(SALT + 1, 0);
  assert.notEqual(a.code, other.code, "different salt → different code");
  const byDay = [1, 5, 10, 20, 40].map((d) => aiMateOuter(SALT, 0, d));
  assert.ok(byDay[4]! >= byDay[0]!, `outer should climb: ${byDay.join(",")}`);
  assert.ok(byDay.every((n) => n >= 0 && n <= CONTESTED_OUTER.length));
  console.log(`ai outer: ${byDay.join(" / ")} on days 1 5 10 20 40 (cap ${CONTESTED_OUTER.length})`);
}

// --- ensureTeam refreshes self outer, keeps AI seats ---
{
  const t0 = formTeam(SELF, SALT, 5, 0);
  const codes = t0.members.filter((m) => m.ai).map((m) => m.code);
  const t1 = ensureTeam(t0, SELF, SALT, 5, 3);
  assert.equal(t1.members[0]!.outer, 3);
  assert.deepEqual(
    t1.members.filter((m) => m.ai).map((m) => m.code),
    codes,
    "AI seats should keep their codes",
  );
  const t2 = ensureTeam(null, SELF, SALT, 1, 0);
  assert.equal(t2.members.length, TEAM.size);
  console.log("ensure: refresh outer, keep AI codes");
}

// --- parseTeam rejects bad shapes ---
{
  assert.equal(parseTeam(null), null);
  assert.equal(parseTeam({ id: "t", members: [] }), null);
  assert.ok(parseTeam(formTeam(SELF, SALT, 1, 0)));
  console.log("parse: rejects empty, accepts formTeam");
}

// --- Profile v46 + migrate from v45 ---
{
  const p = newProfile(7);
  assert.equal(p.v, 46);
  assert.equal(p.team.members.length, TEAM.size);
  assert.equal(selfOuterCount(p), 0);

  const raw = JSON.parse(JSON.stringify(p)) as Record<string, unknown>;
  raw.v = 45;
  delete raw.team;
  const migrated = parseProfile(raw, 7);
  assert.ok(migrated);
  assert.equal(migrated!.v, 46);
  assert.equal(migrated!.team.members.length, TEAM.size);
  assert.ok(migrated!.team.members.some((m) => m.ai));
  console.log("profile: v46 new + v45→v46 migrate");
}

// --- bindTeam replaces seed-self with identity ---
{
  const p = newProfile(3);
  const bound = bindTeam(p, SELF, SALT);
  assert.equal(bound.team.members[0]!.id, SELF.id);
  assert.equal(bound.team.members[0]!.name, SELF.name);
  assert.equal(bound.team.members.filter((m) => m.ai).length, TEAM.size - 1);
  // Holding outer hubs updates self count.
  const poiState = { ...bound.poiState };
  for (const id of CONTESTED_OUTER.slice(0, 2)) poiState[id] = { state: "own" };
  const held: Profile = { ...bound, poiState };
  const refreshed = bindTeam(held, SELF, SALT);
  assert.equal(refreshed.team.members[0]!.outer, 2);
  console.log(`bind: self outer ${refreshed.team.members[0]!.outer} / ${CONTESTED_OUTER.length}`);
}

// --- Contested island empty still yields a team ---
{
  const island = newIsland();
  assert.equal(selfOuterCount({ poiState: island }), 0);
  console.log("ok");
}
