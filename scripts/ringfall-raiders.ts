/**
 * 決定 B (docs/ringfall/glossary.md): the player's holdings are taken only by other players. In a
 * raid's battle the enemy's squads that come at the player's holdings go by the names of the AI
 * players next door (`BattleStart.raiders`, `BattleSquad.by`): a holding they take is told as that
 * player's attack, costing trophies as one while away does (`battleLosses()`).
 *
 * - **names only**: a battle given raiders plays exactly as one given none (the same nodes, the same
 *   changes of hands, at the same times).
 * - **named**: each holding the enemy took from the player carries a raider's name.
 * - **news**: `battleLosses()` tells each as 取られた by that AI player and takes trophies.
 *
 * Run alone: `npx tsx scripts/ringfall-raiders.ts`.
 */
import assert from "node:assert/strict";
import { NODES, type NodeId } from "../src/ringfall/sim/map";
import { finishBattle, lostToRaiders } from "../src/ringfall/sim/battle";
import { newRun, starterKit } from "../src/ringfall/sim/state";
import { holds } from "../src/ringfall/meta/island";
import { newProfile, type Profile } from "../src/ringfall/meta/profile";
import { aiIslands } from "../src/ringfall/meta/ai-islands";
import { battleLosses } from "../src/ringfall/meta/away-attacks";
import { TROPHY } from "../src/ringfall/meta/trophies";

const SALT = 7;
const raiders = aiIslands(SALT).map((a) => a.code);

/** A profile holding `own`, its factory at 0, so the enemy's squads take some of it back. */
function island(own: NodeId[]): Profile {
  const p = newProfile(8);
  const poiState = { ...p.poiState };
  for (const id of own) poiState[id] = { state: "own" };
  return { ...p, poiState, factory: 0 };
}

/** The battle of a raid of `p` reckoned to its end at once, in numbers. */
function battle(p: Profile, seed: number, named: boolean) {
  const s = newRun(seed, starterKit(), "reservoir", { island: holds(p), battle: { factory: p.factory, ...(named ? { raiders } : {}) } });
  finishBattle(s);
  return s;
}

const own = NODES.filter((n) => !n.boss).slice(0, 8).map((n) => n.id);
let lostAll = 0;
for (const seed of [3, 11, 29]) {
  const p = island(own);
  const plain = battle(p, seed, false);
  const named = battle(p, seed, true);
  assert.deepEqual(named.nodes, plain.nodes, `seed ${seed}: names changed the battle`);
  assert.deepEqual(
    named.battle!.taken.map(({ node, side, t }) => ({ node, side, t })),
    plain.battle!.taken,
    `seed ${seed}: names changed who took what`,
  );
  // Every holding the enemy took from the player went by a raider's name.
  const fromPlayer = named.battle!.taken.filter((t, k, all) => t.side === 1 && (all.slice(0, k).filter((x) => x.node === t.node).at(-1)?.side ?? (p.poiState[t.node]?.state === "own" ? 0 : 1)) === 0);
  for (const t of fromPlayer) assert.ok(t.by !== undefined && raiders.includes(t.by), `seed ${seed}: ${t.node} lost with no AI player's name`);
  assert.ok(plain.battle!.taken.every((t) => !("by" in t)), "a battle with no raiders named one");
  const lost = lostToRaiders(named.battle!, named.nodes);
  lostAll += lost.length;
  // The news: each lost holding an AI player's attack, trophies down as one while away.
  const r = battleLosses({ ...p, poiState: { ...p.poiState } }, aiIslands(SALT), lost, Date.UTC(2026, 10, 27));
  assert.equal(r.news.length, lost.length);
  assert.ok(r.news.every((e) => e.t === "taken" && e.by.name.length > 0));
  if (lost.length) assert.ok((r.profile.trophies ?? TROPHY.start) < (p.trophies ?? TROPHY.start), "a holding lost cost no trophies");
  console.log(`seed ${seed}: taken from the player ${fromPlayer.length}, lost at the end ${lost.length}`);
}
// Every slot at sea a real player's: the game's own islands still lend the enemy's squads their names.
assert.ok(aiIslands(SALT, [0, 1, 2, 3]).length === 0 && aiIslands(SALT).length > 0);
assert.ok(lostAll > 0, "no battle took a holding: the check proves nothing");
console.log("raiders ok");
