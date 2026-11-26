/**
 * The islands the game runs itself (src/ringfall/meta/ai-islands.ts, docs/ringfall/multiplayer.md
 * AI の島), checked on made-up profiles and one battle:
 *
 * - **slots**: they fill only the slots the server's neighbours leave, with island codes, the same for a salt.
 * - **growth**: each holds more nodes as the days go, never all, and its last raid is a time before now.
 * - **attack**: none before `AI.start` or while the player holds no node facing one; with one held,
 *   some days one comes at that node, more often while the player's expedition is on it.
 * - **battle**: the day's expedition, lent to a raid as the server's are, takes the undefended node;
 *   the settle keeps it as the island's, the news says so, the server's report has it as the enemy's,
 *   a sync from the server leaves it, and the next raid stands the island's squad at it.
 * - **sent**: the player's expedition goes on its way, fights, and then holds or is gone, on the clock.
 *
 * Run `npx tsx scripts/ringfall-ai-islands.ts`; it exits 1 on the first failure.
 */
import { TICK } from "../src/ringfall/sim/config";
import { NODES, nodeIndex, poiIndex, type NodeId } from "../src/ringfall/sim/map";
import { contestedDefence } from "../src/ringfall/meta/contested-defence";
import { aiOwner, parseHold, rivalHold, rivalOf } from "../src/ringfall/sim/holds";
import { finishBattle } from "../src/ringfall/sim/battle";
import { idleInput, newRun, starterKit, type State } from "../src/ringfall/sim/state";
import { step } from "../src/ringfall/sim/step";
import { blankIsland, holds, type Island } from "../src/ringfall/meta/island";
import { newProfile, settle, type Profile } from "../src/ringfall/meta/profile";
import { mergeHolds, reportHolds, type Outgoing } from "../src/ringfall/meta/expeditions";
import { isIslandCode } from "../src/ringfall/meta/island-code";
import { NEIGHBOUR_SLOTS, type Neighbour } from "../src/ringfall/meta/neighbours";
import { AI, aiAttack, aiHeld, aiIncoming, aiIslands, aiLent, aiOutcome, aiRaidNews, aiRefresh, aiRivals, aiView, withAi } from "../src/ringfall/meta/ai-islands";

const fail = (msg: string): never => {
  console.error(`ai islands: ${msg}`);
  process.exit(1);
};
const SALT = 0;
const NOW = Date.UTC(2026, 10, 20, 12);

// slots: a server neighbour in slot 1 leaves slots 0, 2 and 3 to the game's islands.
const server: Neighbour = { code: "ABCDEF", name: "誰か", held: 5, total: NODES.length, day: 9, slot: 1 };
const near = withAi([server], SALT, 9, NOW);
if (near.map((n) => n.slot).join() !== "0,1,2,3") fail(`slots read ${near.map((n) => n.slot).join()}`);
if (near[1] !== server || near.filter((n) => n.ai).length !== 3) fail("the server's neighbour is not kept in its slot");
for (const n of near.filter((x) => x.ai)) if (!isIslandCode(n.code) || !parseHold(rivalHold(aiOwner(n.code)))) fail(`island ${n.name} has code ${n.code}`);
if (JSON.stringify(withAi([], SALT, 9, NOW).map((n) => n.code)) !== JSON.stringify(withAi([], SALT, 9, NOW).map((n) => n.code))) fail("the islands differ for one salt");
if (withAi([], 1, 9, NOW).map((n) => n.code).join() === withAi([], 2, 9, NOW).map((n) => n.code).join()) fail("two salts meet the same islands");
console.log(`slots: ${near.map((n) => `${n.slot}:${n.name}${n.ai ? "(AI)" : ""}`).join(" ")}`);

// growth
for (const a of aiIslands(SALT)) {
  const by = [1, 5, 10, 20, 30, 60].map((d) => aiHeld(a, SALT, d));
  if (by[5] <= by[0] || by.some((h) => h < 1 || h >= NODES.length)) fail(`${a.name} holds ${by.join(",")} by day`);
  const last = withAi([], SALT, 10, NOW).find((n) => n.code === a.code)!.last!;
  if (last.at > NOW || NOW - last.at > 12 * 3_600_000) fail(`${a.name}'s last raid at ${NOW - last.at} ms ago`);
  console.log(`growth: ${a.name} holds ${by.join(" / ")} on days 1 5 10 20 30 60`);
}

// attack — build from blankIsland so closed-route cases are not polluted by starting shores.
const at = (day: number, freed: NodeId[], expeditions: Outgoing[] = []): Profile => {
  const p = newProfile(3);
  const poiState = { ...blankIsland() } as Island;
  for (const id of freed) poiState[id] = { state: "own" };
  return { ...p, day, poiState, expeditions };
};
const shore = NEIGHBOUR_SLOTS[0].shore;
if (AI.start !== 1 || AI.scoutDay !== 1) fail(`AI.start/scoutDay should be 1, got ${AI.start}/${AI.scoutDay}`);
if (aiAttack(at(0, ["supply", shore]), SALT, []) !== null) fail("an island attacked on day 0");
for (let d = AI.start; d < AI.start + 40; d++) if (aiAttack(at(d, ["supply"]), SALT, []) !== null) fail(`an island attacked on day ${d} with no sea route open`);
// The first scout: once a facing route is open (from day 1), whatever the day's draw; a small squad.
const scout = aiAttack(at(AI.scoutDay, ["supply", shore]), SALT, [], false);
if (!scout?.scout || scout.node !== shore) fail(`the first scout reads ${JSON.stringify(scout)}`);
if (aiAttack(at(AI.scoutDay, ["supply"]), SALT, [], false) !== null) fail("a scout came with no sea route open");
if (aiAttack(at(0, ["supply", shore]), SALT, [], false) !== null) fail("a scout came on day 0");
const scoutLent = aiLent(at(AI.scoutDay, ["supply", shore]), SALT, [], false);
if (scoutLent.length !== 1 || scoutLent[0].kinds.join() !== AI.scout.join()) fail(`the scout lent reads ${JSON.stringify(scoutLent)}`);
console.log(`scout: ${scout.island.name} on day ${AI.scoutDay}, ${AI.scout.length} robots`);

// New profiles start with all four shores → routes open on day 1 without capturing robots.
{
  const fresh = newProfile(3);
  const hit = aiAttack({ ...fresh, day: 1 }, SALT, [], false);
  if (!hit?.scout) fail(`fresh profile day-1 scout missing: ${JSON.stringify(hit)}`);
  console.log(`start shores: day-1 scout from ${hit.island.name} at ${hit.node}`);
}
let days = 0;
let answered = 0;
const first = aiIslands(SALT)[0];
const sent: Outgoing = { code: first.code, node: "supply", sentAt: NOW, id: 1, units: 3, state: "coming" };
for (let d = AI.start; d < AI.start + 200; d++) {
  const x = aiAttack(at(d, ["supply", shore]), SALT, []);
  if (x && (x.island.slot !== 0 || x.node !== shore)) fail(`day ${d}'s expedition from slot ${x.island.slot} at ${x.node}`);
  if (x) days++;
  if (aiAttack(at(d, ["supply", shore], [sent]), SALT, [])) answered++;
}
if (days < 20 || days > 80 || answered <= days) fail(`expeditions on ${days} days of 200, ${answered} while the player's is on the island`);
console.log(`attack: ${days} days of 200 with the station held, ${answered} with an expedition on its island`);

// battle: a day on which the slot-0 island comes at the station, held by nobody.
let day = AI.start;
while (!aiAttack(at(day, ["supply", shore]), SALT, [])) day++;
const p = at(day, ["supply", shore]);
const lent = aiLent(p, SALT, []);
if (lent.length !== 1 || lent[0].target !== shore || lent[0].by.code !== aiOwner(first.code)) fail(`the day's lent read ${JSON.stringify(lent)}`);
if (aiIncoming(p, SALT, []).length !== 1) fail("the camp is not warned of the day's expedition");
const s = newRun(21, starterKit(), "reservoir", { island: holds(p), battle: { factory: 0, rivals: aiRivals(lent) } });
s.reinforceT = s.raiderT = 1e9;
s.parties = [];
s.ally.active = false;
const STATION = nodeIndex(shore);
// The enemy's and the factory's squads leave the station to the expedition.
const b = s.battle!;
const spot = { ...s.player.pos };
let t = 0;
for (; t < 1500 / TICK && s.phase === "play" && s.nodes[STATION] === "own"; t++) {
  b.squads = b.squads.filter((q) => q.side === 3);
  s.enemies = s.enemies.filter((e) => e.rival);
  step(s, idleInput(), false);
  s.player.pos = { ...spot };
  s.player.hp = 1e7;
}
if (t * TICK > AI.landAt + 300) fail(`the expedition took ${Math.round(t * TICK)} s to take the node it came down by`);
if (rivalOf(s.nodes[STATION]) !== aiOwner(first.code)) fail(`the expedition left the station ${s.nodes[STATION]} after ${Math.round(t * TICK)} s`);
console.log(`battle: ${first.name} took the ${NODES[STATION].name} ${Math.round(t * TICK)} s in`);
s.outcome = "extracted";
finishBattle(s);
const after = settle(p, s).profile;
if (after.poiState[shore].state !== rivalHold(aiOwner(first.code))) fail(`the next day the station is ${after.poiState[shore].state}`);
const news = aiRaidNews(p, after, SALT, [], NOW);
if (news.length !== 1 || news[0].t !== "taken" || news[0].by.code !== first.code) fail(`the news read ${JSON.stringify(news)}`);
if (reportHolds(after)[NODES.findIndex((n) => n.id === shore)] !== "foe") fail("the report gives the server the island's node");
const synced = mergeHolds(after.poiState, NODES.map((n) => ({ id: n.id, hold: n.id === shore ? "foe" : after.poiState[n.id].state })));
if (synced[shore].state !== after.poiState[shore].state) fail("a sync from the server undid the island's node");
// Contested coastal hubs (方向 A): defence is 工場 + 島の守り as POI garrison, not a battle holding squad.
const owner = aiOwner(first.code);
const next = aiLent(after, SALT, []);
if (next.some((l) => l.target === shore && l.state === "holding")) fail("contested shore still gets a battle holding lent");
const def = contestedDefence(after.poiState, after.day, [], SALT);
if (!def.some((d) => d.owner === owner)) fail(`contestedDefence missed ${owner}: ${JSON.stringify(def)}`);
const ns = newRun(22, starterKit(), "reservoir", {
  island: holds(after),
  battle: { factory: 0, rivals: aiRivals(next) },
  defence: def,
});
const poi = poiIndex(shore);
if (ns.cleared[poi]) fail("the contested station starts cleared despite defence");
if (!ns.enemies.some((e) => e.poi === poi && e.rival === owner)) fail("the island's 工場 defence does not stand at the station in the next raid");
// A player's island the server offers in that slot later: the node stays the AI island's, and defence still stands.
const defKept = contestedDefence(after.poiState, after.day, [], SALT);
if (!defKept.some((d) => d.owner === owner)) fail("the island's defence leaves the station once a player's island takes its slot");
console.log("battle: kept overnight, reported as the enemy's, kept through a sync, held in the next raid");

// sent: the player's expedition on its way, fighting, then holding or gone; the view shows it while it is out.
const go = (min: number, o: Outgoing) => aiOutcome(first, SALT, o, o.sentAt + min * 60_000);
let held = 0;
for (let k = 1; k <= 60; k++) {
  const o: Outgoing = { code: first.code, node: NODES[k % NODES.length].id, sentAt: NOW + k * 7_777_777, id: k, units: 3, state: "coming" };
  if (go(1, o) !== "coming" || go(AI.coming + 1, o) !== "attacking") fail(`expedition ${k} is ${go(1, o)} then ${go(AI.coming + 1, o)}`);
  const end = go(AI.coming + AI.fighting + 1, o);
  if (end === "holding") {
    held++;
    if (go(AI.coming + AI.fighting + (AI.hold[1] + 1) * 60, o) !== "gone") fail(`expedition ${k} still holds past ${AI.hold[1]} h`);
  } else if (end !== "gone") fail(`expedition ${k} ended ${end}`);
}
if (held < 15 || held > 50) fail(`${held} of 60 expeditions took their node`);
const out: Outgoing[] = [{ ...sent, sentAt: NOW }];
if (aiView(first, SALT, 10, out, "MINE00", NOW + 60_000).expeditions.length !== 1) fail("the island's view does not show the expedition on its way");
const busyView = aiView(first, SALT, 10, out, "MINE00", NOW + 60_000);
if (busyView.nodes.find((n) => n.id === sent.node)?.open) fail("a node the player's expedition is on still takes another");
const after2 = aiView(first, SALT, 10, out, "MINE00", NOW + (AI.coming + AI.fighting + (AI.hold[1] + 2) * 60) * 60_000);
if (!after2.nodes.find((n) => n.id === sent.node)?.open && aiView(first, SALT, 10, [], "", NOW).nodes.find((n) => n.id === sent.node)?.open) fail("a node stays shut after the expedition on it is gone");
const fresh = aiRefresh(out, SALT, [], NOW + (AI.coming + 1) * 60_000);
if (fresh === out || fresh[0].state !== "attacking") fail("the refresh does not bring the expedition up to the clock");
if (aiRefresh(fresh, SALT, [], NOW + (AI.coming + 2) * 60_000) !== fresh) fail("a refresh with nothing changed made a new list");
console.log(`sent: ${held} of 60 expeditions took their node`);
console.log("ai islands: ok");
