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
import { AI, aiHeld, aiIslands, aiOutcome, aiRefresh, aiView, withAi } from "../src/ringfall/meta/ai-islands";

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

// The game's islands' attacks on the player's holdings are reckoned by real time (meta/away-attacks.ts, scripts/ringfall-early-mp.ts).
const first = aiIslands(SALT)[0];
const sent: Outgoing = { code: first.code, node: "supply", sentAt: NOW, id: 1, units: 3, state: "coming" };

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
