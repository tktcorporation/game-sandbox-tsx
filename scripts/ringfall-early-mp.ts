/*
 * Early multiplayer surface (2026-11-26): starting footholds, league label, attack list.
 * Run: `npx tsx scripts/ringfall-early-mp.ts`
 */
import assert from "node:assert/strict";
import { AI, START_FOOTHOLDS, aiIsland, withStartingFootholds } from "../src/ringfall/meta/ai-islands";
import { attackScouts } from "../src/ringfall/meta/attack-scout";
import { islandHolds, newIsland } from "../src/ringfall/meta/island";
import { aiOwner } from "../src/ringfall/sim/holds";
import { bindStartingFootholds, newProfile } from "../src/ringfall/meta/profile";
import { leagueOf, LEAGUE, TROPHY } from "../src/ringfall/meta/trophies";
import { frontNodes } from "../src/ringfall/sim/front";
import { NODES, nodeIndex } from "../src/ringfall/sim/map";
import { MP_HOWTO_CARDS, TERM, trophyHead } from "../src/ringfall/view/copy";
import type { Neighbour } from "../src/ringfall/meta/neighbours";

assert.equal(AI.attack, 0.3, "AI.attack early-MP");
assert.equal(START_FOOTHOLDS.length, 2);

const salt = 7;
const seeded = withStartingFootholds(newIsland(), salt);
for (const f of START_FOOTHOLDS) {
  const expect = `rival:${aiOwner(aiIsland(salt, f.slot).code)}`;
  assert.equal(seeded[f.id]?.state, expect, `${f.id} foothold`);
}

const holds = islandHolds({ poiState: seeded });
const front = frontNodes(holds);
for (const f of START_FOOTHOLDS) {
  const i = nodeIndex(f.id);
  assert.ok(front[i], `${f.id} should be on the front with starting shores`);
}

const neighbours: Neighbour[] = START_FOOTHOLDS.map((f) => {
  const a = aiIsland(salt, f.slot);
  return {
    code: a.code,
    name: a.name,
    held: 4,
    total: NODES.length,
    day: 1,
    slot: f.slot,
    trophies: TROPHY.start,
    factory: 0,
    ai: true as const,
  };
});
const rows = attackScouts(seeded, 1, neighbours, TROPHY.start, [], salt, { x: 0, z: 500 });
assert.ok(rows.length >= 2, `attack scouts from footholds, got ${rows.length}`);
assert.ok(rows.every((r) => r.onFront), "footholds on front");

const p = newProfile(salt);
assert.equal(p.poiState.powerplant?.state?.startsWith("rival:"), true);
assert.equal(p.poiState.fuel?.state?.startsWith("rival:"), true);
assert.equal(p.team?.members.length, 4, "team from day 1");
assert.ok(p.teamBattle, "team battle from day 1");

// Codex P2: profile seed ≠ browser aiSalt — bind realigns foothold owners.
const browserSalt = 0;
assert.notEqual(aiIsland(salt, 0).code, aiIsland(browserSalt, 0).code, "salts differ");
const aligned = bindStartingFootholds(p, browserSalt);
for (const f of START_FOOTHOLDS) {
  assert.equal(aligned.poiState[f.id]?.state, `rival:${aiOwner(aiIsland(browserSalt, f.slot).code)}`, `${f.id} realigned`);
}
const alignedNeighbours: Neighbour[] = START_FOOTHOLDS.map((f) => {
  const a = aiIsland(browserSalt, f.slot);
  return {
    code: a.code,
    name: a.name,
    held: 4,
    total: NODES.length,
    day: 1,
    slot: f.slot,
    trophies: TROPHY.start,
    factory: 0,
    ai: true as const,
  };
});
const named = attackScouts(aligned.poiState, 1, alignedNeighbours, TROPHY.start, [], browserSalt, { x: 0, z: 500 });
assert.ok(named.length >= 2);
assert.ok(named.every((r) => !r.ownerName.includes("他のプレイヤー")), named.map((r) => r.ownerName).join(","));

assert.equal(leagueOf(TROPHY.start).name, "銅");
assert.equal(leagueOf(0).name, "見習い");
assert.equal(leagueOf(3400).name, "伝説");
assert.equal(LEAGUE.length, 7);
assert.equal(trophyHead(TROPHY.start), `${TERM.trophy} · 銅`);

assert.equal(MP_HOWTO_CARDS[0]!.title, TERM.seaIslands);
assert.equal(MP_HOWTO_CARDS[1]!.title, TERM.attack);
assert.ok(MP_HOWTO_CARDS[0]!.body.includes("地図"));
assert.ok(MP_HOWTO_CARDS[2]!.body.includes(TERM.team));

console.log(
  "early-mp ok",
  rows.map((r) => r.title).join(" | "),
  trophyHead(TROPHY.start),
  `AI.attack=${AI.attack}`,
);
