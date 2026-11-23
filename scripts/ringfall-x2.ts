/**
 * X2 short raid (§5.8): neighbour subset stage → notice (`Outgoing.x2`) → 核 · 制圧 → trophies;
 * home poiState unchanged. Gate path (no Start.incursion) must keep settle identical.
 *
 * Run: `npx tsx scripts/ringfall-x2.ts`; ends with "x2 ok".
 */
import { assaultNoticeSec, assaultOf, assaultReady, scheduleAssault } from "../src/ringfall/meta/assault";
import { planIncursion, planShortRaid, SHORT_RAID_EXTRA, stageNodes } from "../src/ringfall/meta/incursion";
import { aiIsland, aiNodes, aiView, aiNextId } from "../src/ringfall/meta/ai-islands";
import { newProfile, settle, type Profile } from "../src/ringfall/meta/profile";
import { TROPHY } from "../src/ringfall/meta/trophies";
import { idleInput, newRun, starterKit } from "../src/ringfall/sim/state";
import { takeNode } from "../src/ringfall/sim/front";
import { NODES, nodeIndex, type NodeId } from "../src/ringfall/sim/map";
import { rivalOf } from "../src/ringfall/sim/holds";
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
const view = aiView(a, salt, day, [], "", Date.now(), []);
check(view.parcels.length > 0, "ai view: no defence parcels");

const stage = stageNodes(view, target);
check(stage[0] === target, "stage: target first");
check(stage.length >= 1 && stage.length <= 1 + SHORT_RAID_EXTRA, `stage: size ${stage.length}`);

const plan = planShortRaid(view, target, { ai: true, known: [] });
check(!!plan, "planShortRaid: refused an open AI node");
check(plan?.stage.length === stage.length, "plan: stage mismatch");
check(rivalOf(plan!.island[target] ?? "held") !== null, "plan: target not rival on stage");
// Non-stage freeable nodes are cleared (freed) — short battlefield.
const full = planIncursion(view, target, { ai: true, known: [] });
check(!!full, "full plan for compare");
const shortFreed = NODES.filter((n) => n.id !== "pad" && !plan!.stage.includes(n.id)).every((n) => plan!.island[n.id] === "freed");
check(shortFreed, "plan: non-stage not cleared");
const fullRival = NODES.filter((n) => held.includes(n.id)).every((n) => rivalOf(full!.island[n.id] ?? "held") !== null);
check(fullRival, "full plan still mirrors all owner nodes");

// Notice: schedule then ready only after assaultNoticeSec (AI uses AI.coming minutes).
{
  const now = 1_700_000_000_000;
  const { list, created } = scheduleAssault([], { code: a.code, node: target, units: 2, id: 1, now });
  check(!!created, "schedule: not created");
  check(created?.x2 === true, "schedule: not marked x2");
  check(assaultOf(list, a.code)?.state === "coming", "schedule: not coming");
  check(!assaultReady(created!, true, now + 1000), "notice: ready too early");
  check(assaultReady(created!, true, now + assaultNoticeSec(true) * 1000), "notice: not ready after window");
  // Own X2 notice must not close the target (Codex P1 busy).
  const withNotice = aiView(a, salt, day, list, "", now + assaultNoticeSec(true) * 1000, []);
  const slot = withNotice.nodes.find((n) => n.id === target);
  check(!!slot?.open, "notice: target busy from own x2");
  check(!!planShortRaid(withNotice, target, { ai: true }), "notice: plan blocked by own x2");
}

// Gate path: settle without incursion must not invent X2 fields.
{
  const p = newProfile(3);
  const s = newRun(3, starterKit(), "reservoir", {});
  s.outcome = "extracted";
  const settled = settle(p, s);
  check(!settled.incursion, "gate: no incursion settle field");
  check(settled.profile.trophies === TROPHY.start, "gate: trophies drifted");
}

// X2 win: capture target → trophies up; home nodes unchanged; assault → holding.
{
  let p: Profile = { ...newProfile(11), day, seed: 11, trophies: TROPHY.start, incursionTaken: [] };
  const id = aiNextId(p.expeditions, a.code);
  const { list } = scheduleAssault(p.expeditions, { code: a.code, node: target, units: 2, id, now: Date.now() - assaultNoticeSec(true) * 1000 - 1000 });
  p = { ...p, expeditions: list };
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
  takeNode(s, nodeIndex(target));
  s.outcome = "extracted";
  const homeBefore = { ...p.poiState };
  const beforeTrop = p.trophies;
  const settled = settle(p, s);
  check(!!settled.incursion?.won, "settle: x2 not won");
  check((settled.trophies?.after ?? 0) > beforeTrop, "settle: trophies did not rise");
  check(settled.profile.poiState[target]?.state === homeBefore[target]?.state, "settle: home poiState rewritten");
  check(settled.profile.expeditions.some((e) => e.code === a.code && e.state === "holding"), "settle: assault not holding");
}

// Smoke steps on a short-raid run.
{
  const s = newRun(21, starterKit(), plan!.region, {
    island: plan!.island,
    entry: plan!.entry,
    incursion: { code: plan!.code, owner: plan!.owner, target: plan!.target, parcels: plan!.parcels },
  });
  for (let i = 0; i < 30; i++) step(s, idleInput(), false);
  check(s.incursion?.target === target, "smoke: incursion cleared mid-raid");
}

console.log(`x2: target ${target}, stage ${stage.join(",")}, notice ${assaultNoticeSec(true)}s`);
if (errors.length) {
  for (const e of errors) console.error(`FAIL ${e}`);
  process.exit(1);
}
console.log("x2 ok");
