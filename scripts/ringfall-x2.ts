/**
 * X2 short raid (§5.8): neighbour subset stage → notice (`Outgoing.x2`) → 核 · 制圧 → trophies;
 * home poiState unchanged. Gate path (no Start.incursion) must keep settle identical.
 * Also covers AI 「○○の前線」 departure: home shore is not the raid target (#201).
 *
 * Run: `npx tsx scripts/ringfall-x2.ts`; ends with "x2 ok".
 * Full start-point matrix: `npx tsx scripts/ringfall-depart-bruteforce.ts`.
 */
import { assaultAcked, assaultNoticeSec, assaultOf, assaultReady, assaultWinRejected, assaultWon, scheduleAssault } from "../src/ringfall/meta/assault";
import { fortifiable } from "../src/ringfall/sim/front";
import { planIncursion, planShortRaid, SHORT_RAID_EXTRA, shortRaidTarget, stageNodes } from "../src/ringfall/meta/incursion";
import { aiIsland, aiNodes, aiView, aiNextId } from "../src/ringfall/meta/ai-islands";
import { newProfile, settle, type Profile } from "../src/ringfall/meta/profile";
import { TROPHY } from "../src/ringfall/meta/trophies";
import { idleInput, newRun, starterKit } from "../src/ringfall/sim/state";
import { takeNode } from "../src/ringfall/sim/front";
import { ENTRIES, NODES, nodeIndex, type NodeId } from "../src/ringfall/sim/map";
import { NEIGHBOUR_SLOTS } from "../src/ringfall/meta/neighbours";
import { rivalOf } from "../src/ringfall/sim/holds";
import { step } from "../src/ringfall/sim/step";
import { Hub, isAiFront } from "../src/ringfall/view/hub";
import type { NeighbourFront } from "../src/ringfall/meta/neighbour-front";
import { applySync, type IslandView } from "../src/ringfall/meta/expeditions";
import { holdsOf } from "../src/ringfall/meta/neighbour-front";
import { trophyDelta } from "../src/ringfall/meta/trophies";

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
check(rivalOf(plan!.island[target] ?? "foe") !== null, "plan: target not rival on stage");
// Non-stage freeable nodes are cleared (freed) — short battlefield.
const full = planIncursion(view, target, { ai: true, known: [] });
check(!!full, "full plan for compare");
const shortFreed = NODES.filter((n) => n.id !== "pad" && !plan!.stage.includes(n.id)).every((n) => plan!.island[n.id] === "own");
check(shortFreed, "plan: non-stage not cleared");
const fullRival = NODES.filter((n) => held.includes(n.id)).every((n) => rivalOf(full!.island[n.id] ?? "foe") !== null);
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

// Real and AI neighbour fronts both count as X2 entrances; AI flag drives the notice clock.
{
  const real: NeighbourFront = { name: "となりの前線", x: 0, z: 0, shore: target, code: "ZZZZZZ" };
  const aiFront: NeighbourFront = { name: `${a.name}の前線`, x: 0, z: 0, shore: target, code: a.code, ai: true };
  check(!isAiFront(real) && isAiFront(aiFront), "playable: ai/real clock split wrong");
}

// Real-island target pick: shore preferred when open; else nearest freed open node.
{
  const shutShore: IslandView = {
    code: "AAAAAA",
    owner: "相手",
    day: 3,
    factory: 0,
    protectedUntil: 0,
    nodes: NODES.map((n) => ({
      id: n.id,
      hold: n.id === target ? "foe" : held.includes(n.id) ? "own" : "foe",
      open: n.id !== target && held.includes(n.id),
    })),
    expeditions: [],
    pings: [],
    parcels: [],
  };
  const pick = shortRaidTarget(shutShore, target);
  check(!!pick && pick !== target, "shortRaidTarget: did not fall back from shut shore");
  const busy: IslandView = {
    ...shutShore,
    nodes: shutShore.nodes.map((n) => (n.id === pick ? { ...n, open: false } : n.id === target ? { ...n, hold: "own", open: true } : n)),
  };
  check(shortRaidTarget(busy, target) === target, "shortRaidTarget: preferred shore not chosen when open");
  // Own X2 busy: plan with ignoreBusy.
  const occupied = {
    ...view,
    nodes: view.nodes.map((n) => (n.id === target ? { ...n, open: false } : n)),
  };
  check(!planShortRaid(occupied, target, { ai: false }), "plan: busy without ignoreBusy");
  check(!!planShortRaid(occupied, target, { ai: false, ignoreBusy: true }), "plan: ignoreBusy refused own notice");
}

// Defender sync: hold change deducts trophies once (no double with attacker's settle).
{
  const base = newProfile(17);
  const def: Profile = {
    ...base,
    trophies: TROPHY.start,
    poiState: { ...base.poiState, [target]: { state: "own" } },
  };
  const before = holdsOf(def.poiState);
  const after = before.map((h, i) => (NODES[i]!.id === target ? (`rival:ATTACK` as const) : h));
  const server = NODES.map((n, i) => ({ id: n.id, hold: after[i]! }));
  const { profile } = applySync(def, { holds: server, incoming: [] });
  const lost = TROPHY.start - (profile.trophies ?? TROPHY.start);
  check(lost > 0, "defender sync: trophies did not fall when node taken");
  const again = applySync(profile, { holds: server, incoming: [] });
  check(again.profile.trophies === profile.trophies, "defender sync: trophies double-counted");
  check(trophyDelta(TROPHY.start, before, after).lost === lost, "defender sync: trophyDelta mismatch");
}

// Holding assault is not "ready" — need a fresh notice (Codex #197 P2).
{
  const held = [{ code: a.code, node: target, sentAt: 0, id: 1, units: 2, state: "holding" as const, x2: true as const }];
  check(assaultOf(held, a.code) === null, "holding: still assaultOf");
  const { list, created } = scheduleAssault(held, { code: a.code, node: target, units: 2, id: 2, now: 1_700_000_000_000 });
  check(!!created, "holding: could not reschedule");
  check(list.every((o) => o.state !== "holding" || o.code !== a.code), "holding: old holding kept");
  check(created!.state === "coming", "holding: new not coming");
}

// X2 settle must not unlock home depots from the copy's synthetic frees (Codex #197 P2).
{
  let p: Profile = { ...newProfile(13), day, seed: 13, trophies: TROPHY.start, depots: [], incursionTaken: [] };
  const s = newRun(13, starterKit(), plan!.region, {
    island: plan!.island,
    entry: plan!.entry,
    incursion: { code: plan!.code, owner: plan!.owner, target: plan!.target, parcels: plan!.parcels },
  });
  check(s.depots.some(Boolean), "fixture: copy enabled no depots");
  s.outcome = "extracted";
  const settled = settle(p, s);
  check(settled.profile.depots.length === 0, "settle: x2 unlocked home depots");
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
  check(settled.profile.expeditions.some((e) => e.code === a.code && e.x2Pending), "settle: x2 win not pending confirm");
}

// Defender battle: X2 noticed enables 固める without lending robots (Codex #199 P1).
{
  const home = newRun(31, starterKit(), "reservoir", {
    island: { [target]: "own" },
    battle: { factory: 0, noticed: [target] },
  });
  check(!!home.battle?.noticed.includes(nodeIndex(target)), "noticed: battle missing X2 target");
  check(fortifiable(home, nodeIndex(target)), "noticed: fortifiable false for X2 target");
  check(!home.battle?.rivals.length, "noticed: X2 spawned rival robots");
}

// Pending win rejection rolls back trophies (Codex #199 P2).
{
  const list = assaultWon([{ code: "BBBBBB", node: target, sentAt: 0, id: 3, units: 1, state: "coming", x2: true }], "BBBBBB", 30);
  check(list[0]?.x2Pending && list[0]?.tropGain === 30, "pending: win not marked");
  const { list: rolled, tropGain } = assaultWinRejected(list, "BBBBBB");
  check(tropGain === 30 && !rolled.some((e) => e.code === "BBBBBB"), "pending: reject did not clear");
  const acked = assaultAcked(list, "BBBBBB");
  check(acked.some((e) => e.code === "BBBBBB" && e.state === "holding" && !e.x2Pending), "pending: ack left pending");
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

async function checkDepartAi() {
  const store: Record<string, any> = {};
  (globalThis as any).document ??= {
    getElementById: (id: string) =>
      (store[id] ??= {
        style: { setProperty() {} },
        hidden: true,
        textContent: "",
        innerHTML: "",
        classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
        dataset: {},
        addEventListener() {},
        scrollTop: 0,
      }),
    body: { classList: { contains: () => false } },
    createElement: () => ({ getContext: () => null, style: {} }),
  };
  (globalThis as any).matchMedia ??= () => ({ matches: false });
  (globalThis as any).localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };

  const shores = NEIGHBOUR_SLOTS.map((s) => s.shore);
  const poiState = { ...newProfile(17).poiState };
  for (const id of shores) poiState[id] = { state: "own" };
  const p: Profile = {
    ...newProfile(17),
    day,
    seed: 17,
    entries: ENTRIES.map((e) => e.id),
    depots: [...shores],
    poiState,
  };
  const hub = new Hub(p, () => {});
  const mark = hub.startPoints().find((q) => q.kind === "assault" && q.open);
  check(!!mark, "depart: AI front mark missing");
  if (!mark) return;
  check(!!hub.choose("assault", mark.id), "depart: choose assault failed");
  const first = await hub.departNeighbourFront(1_700_000_000_000);
  check(first?.t === "scheduled", "depart: first confirm not scheduled");
  const notice = assaultOf(hub.profile.expeditions, mark.id);
  check(!!notice?.node, "depart: notice missing node");
  // Stale notice that stored a home shore must still become ready.
  const stale = scheduleAssault([], {
    code: mark.id,
    node: shores[0]!,
    units: 2,
    id: 9,
    now: 1_700_000_000_000 - assaultNoticeSec(true) * 1000 - 1000,
  });
  const hub2 = new Hub({ ...p, expeditions: stale.list }, () => {});
  hub2.choose("assault", mark.id);
  const ready = await hub2.departNeighbourFront(1_700_000_000_000);
  check(ready?.t === "ready", `depart: stale shore notice not ready (${ready?.t})`);
  if (ready?.t === "ready") check(ready.plan.stage.length > 0, "depart: ready plan empty");
  hub2.choose("entry", "beach");
  check((await hub2.departNeighbourFront()) === null, "depart: entry still departNeighbourFront");
}

void checkDepartAi()
  .then(() => {
    console.log(`x2: target ${target}, stage ${stage.join(",")}, notice ${assaultNoticeSec(true)}s`);
    if (errors.length) {
      for (const e of errors) console.error(`FAIL ${e}`);
      process.exit(1);
    }
    console.log("x2 ok");
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
