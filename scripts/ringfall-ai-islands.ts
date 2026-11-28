/**
 * The islands the game runs itself (src/ringfall/meta/ai-islands.ts, docs/ringfall/multiplayer.md
 * AI の島), checked on made-up profiles and one battle:
 *
 * - **slots**: they fill only the slots the server's neighbours leave, with island codes, the same for a salt.
 * - **growth**: each holds more nodes as the days go, never all, and its last raid is a time before now.
 * - **view**: its island as anyone sees it holds the nodes of the day, each with its 島の守り.
 *
 * The game's islands' attacks on the player's holdings are reckoned by real time
 * (meta/away-attacks.ts, scripts/ringfall-early-mp.ts), and the player attacks their holdings by a
 * sortie (meta/sortie.ts, scripts/ringfall-sortie-settle.ts).
 *
 * Run `npx tsx scripts/ringfall-ai-islands.ts`; it exits 1 on the first failure.
 */
import { NODES } from "../src/ringfall/sim/map";
import { aiOwner, parseHold, rivalHold } from "../src/ringfall/sim/holds";
import { isIslandCode } from "../src/ringfall/meta/island-code";
import type { Neighbour } from "../src/ringfall/meta/neighbours";
import { aiHeld, aiIslands, aiNodes, aiView, withAi } from "../src/ringfall/meta/ai-islands";

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

// view: the day's holdings as the island's own, the enemy's next to them open, nothing else.
const first = aiIslands(SALT)[0];
const view = aiView(first, SALT, 10);
const own = view.nodes.filter((n) => n.hold === "own").map((n) => n.id);
if (own.join() !== [...aiNodes(first, SALT, 10)].sort((a, b) => NODES.findIndex((n) => n.id === a) - NODES.findIndex((n) => n.id === b)).join()) fail(`the view holds ${own.join()}`);
if (view.nodes.some((n) => n.hold === "own" && !n.open)) fail("a holding of the island is not open in its view");
if (view.parcels.some((q) => !own.includes(q.poi))) fail("島の守り stand at a node the island does not hold");
if (JSON.stringify(aiView(first, SALT, 10)) !== JSON.stringify(view)) fail("the view differs for one day");
console.log(`view: ${first.name} holds ${own.length}, ${view.parcels.length} 島の守り`);
console.log("ai islands: ok");
