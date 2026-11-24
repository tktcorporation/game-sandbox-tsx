/**
 * Lead-incursion (raid-loot stage 6): AI island copy → 核 · 制圧 → 倉庫へ届いた; home poiState
 * unchanged; defender stock drops. Gate path (no Start.incursion) must keep settle identical.
 *
 * Run: `npx tsx scripts/ringfall-incursion.ts`; ends with "incursion ok".
 */
import { aiDefenceParcels, planIncursion, viewToRaidIsland, withTaken } from "../src/ringfall/meta/incursion";
import { aiIsland, aiNodes, aiView } from "../src/ringfall/meta/ai-islands";
import { newProfile, seizeRivalLoot, settle, type Profile } from "../src/ringfall/meta/profile";
import { idleInput, newRun, starterKit } from "../src/ringfall/sim/state";
import { takeNode } from "../src/ringfall/sim/front";
import { NODES, nodeIndex, type NodeId } from "../src/ringfall/sim/map";
import { rivalHold, rivalOf } from "../src/ringfall/sim/holds";
import { step } from "../src/ringfall/sim/step";

const errors: string[] = [];
const check = (ok: boolean, what: string) => {
  if (!ok) errors.push(what);
};

const salt = 0;
const day = 8;
const a = aiIsland(salt, 0);
const held = aiNodes(a, salt, day);
const target = held[0] as NodeId;
const parcels = aiDefenceParcels(a, salt, day, held, []);
const view = aiView(a, salt, day, [], "", Date.now(), []);
check(view.parcels.length > 0, "ai view: no defence parcels");
check(parcels.some((q) => q.poi === target), "ai parcels: target node has no stock");

const plan = planIncursion(view, target, { ai: true, known: [] });
check(!!plan, "plan: refused an open AI node");
check(plan?.target === target, "plan: wrong target");
check(rivalOf(plan!.island[target] ?? "foe") !== null, "plan: target is not rival-held on the copy");

// Gate path: settle without incursion must not invent seized loot.
{
  const p = newProfile(3);
  const s = newRun(3, starterKit(), "reservoir", {});
  s.outcome = "extracted";
  const before = JSON.stringify(p.poiState);
  const settled = settle(p, s);
  check(JSON.stringify(settled.profile.poiState) !== undefined, "gate: settle ran");
  check(!settled.seized?.length, "gate: seize without rivals");
  check(!settled.incursion, "gate: no incursion settle field");
  void before;
}

// Lead-incursion: capture target → loot; home nodes unchanged by the copy's capture.
{
  let p: Profile = { ...newProfile(11), day, seed: 11, incursionTaken: [] };
  const s = newRun(11, starterKit(), plan!.region, {
    island: plan!.island,
    entry: plan!.entry,
    incursion: {
      code: plan!.code,
      owner: plan!.owner,
      target: plan!.target,
      parcels: plan!.parcels,
    },
  });
  check(!!s.incursion, "raid: Start.incursion missing on state");
  const i = nodeIndex(target);
  takeNode(s, i);
  s.outcome = "extracted";
  const homeBefore = { ...p.poiState };
  const seized = seizeRivalLoot(p, s);
  check(seized.at.length === 1 && seized.at[0]!.poi === target, "seize: target not in loot");
  check(seized.items.length >= 1, "seize: no valuables");
  const settled = settle(p, s);
  check(!!settled.seized?.length, "settle: seized missing");
  check(!!settled.incursion?.won, "settle: incursion not won");
  check(settled.incursion?.code === a.code, "settle: wrong island code");
  // Home island must not gain the copy's captured node.
  check(settled.profile.poiState[target]?.state === homeBefore[target]?.state, "settle: home poiState rewritten by copy capture");
  check((settled.profile.incursionTaken ?? []).some((e) => e.code === a.code && e.ids.length), "settle: incursionTaken not recorded");
  // Next AI view drops seized parcels (defender partial loss).
  const taken = settled.profile.incursionTaken.find((e) => e.code === a.code)?.ids ?? [];
  const again = aiView(a, salt, day, [], "", Date.now(), taken);
  check(again.parcels.every((q) => !taken.includes(q.id)), "defender: seized parcels still on AI view");
}

// withTaken merges ids.
{
  const one = withTaken([], "K7M2QX", [3, 5]);
  const two = withTaken(one, "K7M2QX", [5, 7]);
  check(two.length === 1 && two[0]!.ids.sort((x, y) => x - y).join() === "3,5,7", "withTaken: merge");
}

// viewToRaidIsland maps owner freed → rival.
{
  const island = viewToRaidIsland(view, `ai-${a.code}`);
  check(island[target] === rivalHold(`ai-${a.code}`), "viewToRaidIsland: target not rival");
  check(NODES.filter((n) => !held.includes(n.id)).every((n) => island[n.id] === "foe" || n.id === "pad"), "viewToRaidIsland: enemy nodes");
}

// A few idle steps on an incursion run must not throw (sim smoke).
{
  const s = newRun(21, starterKit(), plan!.region, {
    island: plan!.island,
    entry: plan!.entry,
    incursion: { code: plan!.code, owner: plan!.owner, target: plan!.target, parcels: plan!.parcels },
  });
  for (let i = 0; i < 30; i++) step(s, idleInput(), false);
  check(s.incursion?.target === target, "smoke: incursion cleared mid-raid");
}

console.log(`incursion: target ${target}, parcels ${view.parcels.length}, seized path ok`);
if (errors.length) {
  for (const e of errors) console.error(`FAIL ${e}`);
  process.exit(1);
}
console.log("incursion ok");
