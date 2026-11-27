/*
 * Early multiplayer surface: the island a new profile starts with, the AI players' attacks on the
 * holdings while away (meta/away-attacks.ts, glossary.md 決定 B), league label, howto cards.
 * Run: `npx tsx scripts/ringfall-early-mp.ts`
 */
import assert from "node:assert/strict";
import { AWAY, awayAttacks } from "../src/ringfall/meta/away-attacks";
import { parseIsland, playerNodes } from "../src/ringfall/meta/island";
import { rivalOf } from "../src/ringfall/sim/holds";
import { newProfile, parseProfile } from "../src/ringfall/meta/profile";
import { leagueOf, LEAGUE, TROPHY } from "../src/ringfall/meta/trophies";
import { MP_HOWTO_CARDS, TERM, trophyHead } from "../src/ringfall/view/copy";
import { ROUTE_SHORES } from "../src/ringfall/meta/neighbours";
import { DAY_MS, utcDay } from "../src/ringfall/meta/outer-guard";

const salt = 7;
const p = newProfile(salt);
assert.ok(Object.values(p.poiState).every((x) => !rivalOf(x.state)), "no other player's node on a new island");

// Starter ownership belongs only to newly created profiles, not to missing save data.
const firstShore = ROUTE_SHORES[0]!;
const secondShore = ROUTE_SHORES[1]!;
assert.ok(ROUTE_SHORES.every((id) => p.poiState[id].state === "own"), "new profile still owns all four shores");
const legacy = parseProfile({ ...p, v: 12, poiState: undefined });
assert.ok(legacy);
assert.ok(ROUTE_SHORES.every((id) => legacy.poiState[id].state === "foe"), "pre-island saves gain no shores");
const noIsland = parseIsland(undefined);
assert.ok(ROUTE_SHORES.every((id) => noIsland[id].state === "foe"), "missing entire island gains no shores");
const partial = parseProfile({ ...p, poiState: { [firstShore]: { state: "own" }, [secondShore]: { state: "foe" } } });
assert.ok(partial);
assert.equal(partial.poiState[firstShore].state, "own", "explicit ownership survives");
assert.ok(ROUTE_SHORES.filter((id) => id !== firstShore).every((id) => partial.poiState[id].state === "foe"),
  "explicit enemy and omitted starter shores both stay enemy");
assert.deepEqual(parseProfile(JSON.parse(JSON.stringify(p)))?.poiState, p.poiState, "full current save unchanged");

// Away attacks: the first look starts the clock and brings nothing.
const T0 = Date.UTC(2026, 10, 1);
const first = awayAttacks(p, salt, T0);
assert.equal(first.news.length, 0, "the first look brought attacks");
assert.equal(first.profile.attackedAt, T0);
// A month away (reckoned over the last AWAY.catchUp hours): attacks come, at most lossCap lost a UTC day.
let q = first.profile;
let taken = 0;
let held = 0;
for (let d = 1; d <= 30; d++) {
  const r = awayAttacks(q, salt, T0 + d * DAY_MS);
  const lost = r.news.filter((e) => e.t === "taken");
  const days = new Set(lost.map((e) => utcDay(e.at)));
  assert.equal(days.size, lost.length, `two holdings lost on one day (day ${d})`);
  for (const e of lost) assert.equal(r.profile.poiState[e.node as keyof typeof r.profile.poiState]?.state, "foe", "a holding taken did not go back to the robots");
  assert.ok(r.news.every((e) => e.at > q.attackedAt && e.at <= T0 + d * DAY_MS), "an attack outside the hours reckoned");
  if (lost.length) assert.ok((r.profile.trophies ?? 0) < (q.trophies ?? TROPHY.start), "a holding taken cost no trophies");
  taken += lost.length;
  held += r.news.length - lost.length;
  q = r.profile;
}
assert.ok(taken > 0 && held > 0, `a month brought taken ${taken}, held ${held}`);
// Same profile, same hours: the same attacks.
assert.deepEqual(awayAttacks(first.profile, salt, T0 + 3 * DAY_MS).news, awayAttacks(first.profile, salt, T0 + 3 * DAY_MS).news);
// Nothing held: nothing to attack.
const bare = { ...first.profile, poiState: parseIsland(undefined) };
assert.equal(playerNodes(bare).length, 0);
assert.equal(awayAttacks(bare, salt, T0 + 2 * DAY_MS).news.length, 0, "an attack on an island holding nothing");
// A holding taken in a raid since the hours began is not among those attacked in them.
{
  const before = playerNodes(first.profile);
  const won = { ...first.profile, poiState: { ...first.profile.poiState, station: { state: "own" as const } } };
  assert.ok(!before.includes("station"));
  const r = awayAttacks(won, salt, T0 + 2 * DAY_MS, [], before);
  assert.ok(r.news.every((e) => e.node !== "station"), "an attack before the raid took a node the raid captured");
  assert.equal(r.profile.poiState.station.state, "own");
}
// v50 saves: other players' nodes on the player's island go back to the robots.
const v50 = parseProfile({ ...p, v: 50, poiState: { ...p.poiState, fuel: { state: "rival:ai-ABC123" } } });
assert.equal(v50?.poiState.fuel.state, "foe", "a v50 save kept another player's node on the player's island");

assert.equal(leagueOf(TROPHY.start).name, "銅");
assert.equal(leagueOf(0).name, "見習い");
assert.equal(leagueOf(3400).name, "伝説");
assert.equal(LEAGUE.length, 7);
assert.equal(trophyHead(TROPHY.start), `${TERM.trophy} · 銅`);

assert.equal(MP_HOWTO_CARDS[0]!.title, TERM.seaIslands);
assert.equal(MP_HOWTO_CARDS[1]!.title, TERM.attack);
assert.ok(MP_HOWTO_CARDS[0]!.body.includes("地図"));

console.log("early-mp ok", trophyHead(TROPHY.start), `away: a month took ${taken}, held ${held} (chance ${AWAY.chance}/h)`);
