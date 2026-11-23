/**
 * Brute-force every departure start under several island states: choose → gapDepart → launch.
 * Run: `npx tsx scripts/ringfall-depart-bruteforce.ts`
 */
const store: Record<string, any> = {};
(globalThis as any).document = {
  getElementById: (id: string) => {
    if (!store[id]) {
      store[id] = {
        style: { setProperty() {}, cssText: "" },
        hidden: true,
        textContent: "",
        innerHTML: "",
        classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
        dataset: {},
        addEventListener() {},
        scrollTop: 0,
        getBoundingClientRect: () => ({ width: 640, height: 420, left: 0, top: 0, right: 640, bottom: 420 }),
      };
    }
    return store[id];
  },
  body: { classList: { contains: () => false } },
  createElement: () => ({ getContext: () => null, style: {}, width: 0, height: 0 }),
};
(globalThis as any).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
(globalThis as any).addEventListener = () => {};
(globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
(globalThis as any).HTMLCanvasElement = class {};
(globalThis as any).Image = class {
  onload: (() => void) | null = null;
  set src(_: string) {
    queueMicrotask(() => this.onload?.());
  }
};

import { ENTRIES, NODES, type PoiId } from "../src/ringfall/sim/map";
import { NEIGHBOUR_SLOTS } from "../src/ringfall/meta/neighbours";
import { newProfile, type Profile } from "../src/ringfall/meta/profile";
import { Hub } from "../src/ringfall/view/hub";
import { assaultNoticeSec, scheduleAssault } from "../src/ringfall/meta/assault";
import { aiNextId } from "../src/ringfall/meta/ai-islands";

const errors: string[] = [];
const fail = (msg: string) => {
  errors.push(msg);
  console.error("FAIL", msg);
};

const freeAll = (p: Profile): Profile => {
  const poiState = { ...p.poiState };
  for (const n of NODES) if (n.id !== "pad") poiState[n.id] = { state: "freed" };
  return {
    ...p,
    poiState,
    depots: NODES.filter((n) => n.id !== "pad").map((n) => n.id),
    entries: ENTRIES.map((e) => e.id),
  };
};

const freeIds = (p: Profile, ids: PoiId[]): Profile => {
  const poiState = { ...p.poiState };
  for (const id of ids) poiState[id] = { state: "freed" };
  return {
    ...p,
    poiState,
    depots: [...new Set([...p.depots, ...ids])],
    entries: ENTRIES.map((e) => e.id),
  };
};

type Scenario = { name: string; build: (p: Profile) => Profile };

const scenarios: Scenario[] = [
  { name: "new-profile", build: (p) => p },
  { name: "all-entries-no-nodes", build: (p) => ({ ...p, entries: ENTRIES.map((e) => e.id) }) },
  { name: "shores-open-ai-fronts", build: (p) => freeIds(p, NEIGHBOUR_SLOTS.map((s) => s.shore)) },
  { name: "all-nodes-freed", build: freeAll },
  {
    name: "supply-freed-depot",
    build: (p) => freeIds({ ...p, entries: ENTRIES.map((e) => e.id) }, ["supply"]),
  },
  {
    name: "rival-on-front",
    build: (p) => {
      const q = freeIds(p, ["supply", "quarry"]);
      return {
        ...q,
        poiState: { ...q.poiState, relay: { state: "rival:PLAYERX" } },
        entries: ENTRIES.map((e) => e.id),
        depots: ["supply", "quarry"],
      };
    },
  },
  {
    name: "assault-notice-pending",
    build: (p) => {
      const q = freeIds(p, NEIGHBOUR_SLOTS.map((s) => s.shore));
      const hub0 = new Hub(q, () => {});
      const assaults = hub0.startPoints().filter((s) => s.kind === "assault");
      if (!assaults.length) return q;
      const code = assaults[0].id;
      const id = aiNextId(q.expeditions, code);
      const { list } = scheduleAssault(q.expeditions, {
        code,
        node: NEIGHBOUR_SLOTS[0].shore,
        units: 2,
        id,
        now: Date.now(),
      });
      return { ...q, expeditions: list };
    },
  },
  {
    name: "assault-notice-ready",
    build: (p) => {
      // Day late enough that AI islands hold some nodes; notice stores the *home* shore on purpose
      // (the pre-fix bug) so ready must recover via assaultTarget.
      const q = { ...freeIds(p, NEIGHBOUR_SLOTS.map((s) => s.shore)), day: 12 };
      const hub0 = new Hub(q, () => {});
      const assaults = hub0.startPoints().filter((s) => s.kind === "assault");
      if (!assaults.length) return q;
      const code = assaults[0].id;
      const id = aiNextId(q.expeditions, code);
      const { list } = scheduleAssault(q.expeditions, {
        code,
        node: NEIGHBOUR_SLOTS[0].shore,
        units: 2,
        id,
        now: Date.now() - assaultNoticeSec(true) * 1000 - 1000,
      });
      return { ...q, expeditions: list };
    },
  },
];

/** Simulate answerDepart decision for a chosen open start. */
async function simulateDepart(hub: Hub): Promise<{ ok: boolean; kind: string; detail: string }> {
  const on = hub.startPoints().find((q) => q.on);
  if (!on) return { ok: false, kind: "none", detail: "no start on" };
  if (hub.rideRefused()) return { ok: false, kind: "refused", detail: hub.rideRefused() };
  const gap = await hub.gapDepart();
  if (on.kind === "assault") {
    if (!gap) return { ok: false, kind: "assault-no-gap", detail: on.name };
    // Hard fail: ready path could not pick any raidable node (fortified / empty).
    if (gap.t === "waiting" && gap.toast.includes("攻められない")) {
      return { ok: false, kind: "unraidable", detail: gap.toast };
    }
    if (gap.t === "scheduled" || gap.t === "waiting") return { ok: true, kind: gap.t, detail: gap.toast };
    if (gap.t === "ready") {
      const launch = hub.launch(gap.plan);
      return launch ? { ok: true, kind: "short-raid", detail: `${on.name}→${gap.plan.target}` } : { ok: false, kind: "launch-null", detail: on.name };
    }
  }
  if (gap) return { ok: false, kind: "hijack", detail: `${on.kind}:${on.name} → ${gap.t}` };
  const launch = hub.launch();
  if (!launch) return { ok: false, kind: "launch-null", detail: on.name };
  if (launch.incursion) return { ok: false, kind: "unexpected-incursion", detail: on.name };
  return { ok: true, kind: "home-raid", detail: `${on.kind}:${on.name} → ${launch.region}/${launch.entry}` };
}

async function main() {
  for (const sc of scenarios) {
    console.log(`\n== ${sc.name} ==`);
    const p = sc.build(newProfile(42));
    const hub = new Hub(p, () => {});
    const pts = hub.startPoints();
    console.log(
      `starts=${pts.length} open=${pts.filter((q) => q.open).length} assault=${pts
        .filter((q) => q.kind === "assault")
        .map((q) => q.name)
        .join(",") || "—"}`,
    );

    for (const q of pts.filter((s) => s.open)) {
      const h = new Hub(structuredClone(p), () => {});
      if (!h.choose(q.kind, q.id)) {
        fail(`${sc.name}: choose failed for open ${q.kind}:${q.name}`);
        continue;
      }
      const on = h.startPoints().find((s) => s.on);
      if (!on || on.kind !== q.kind || on.id !== q.id) {
        fail(`${sc.name}: after choose, on=${on?.kind}:${on?.id} expected ${q.kind}:${q.id}`);
      }
      const result = await simulateDepart(h);
      if (!result.ok) fail(`${sc.name}: ${q.kind}:${q.name} → ${result.kind} ${result.detail}`);
      else console.log(`  ok ${q.kind}:${q.name} → ${result.kind}`);
      if (sc.name === "assault-notice-ready" && q.kind === "assault" && q.id === pts.find((s) => s.kind === "assault")?.id && result.kind !== "short-raid") {
        fail(`${sc.name}: ${q.name} expected short-raid after notice, got ${result.kind}`);
      }
    }

    for (const q of pts.filter((s) => !s.open)) {
      const h = new Hub(structuredClone(p), () => {});
      if (h.choose(q.kind, q.id)) fail(`${sc.name}: shut ${q.kind}:${q.name} was choosable`);
    }
  }

  {
    console.log("\n== sticky-assaultAim ==");
    const p = freeIds(newProfile(7), NEIGHBOUR_SLOTS.map((s) => s.shore));
    const hub = new Hub(p, () => {});
    const assault = hub.startPoints().find((q) => q.kind === "assault" && q.open);
    const entry = hub.startPoints().find((q) => q.kind === "entry" && q.open);
    if (!assault || !entry) fail("sticky: missing assault or entry");
    else {
      hub.choose("assault", assault.id);
      const gap1 = await hub.gapDepart();
      if (!gap1) fail("sticky: assault did not arm gapDepart");
      hub.choose("entry", entry.id);
      const gap2 = await hub.gapDepart();
      if (gap2) fail(`sticky: entry still hijacked → ${gap2.t}`);
      const on = hub.startPoints().find((q) => q.on);
      if (on?.kind !== "entry" || on.id !== entry.id) fail(`sticky: on=${on?.kind}:${on?.id}`);
      const launch = hub.launch();
      if (!launch || launch.incursion) fail("sticky: launch wrong after clearing assault");
      console.log("  ok assault→entry clears gapDepart");
    }
  }

  {
    console.log("\n== assault-reschedule ==");
    const p = freeIds(newProfile(9), NEIGHBOUR_SLOTS.map((s) => s.shore));
    const hub = new Hub(p, () => {});
    const assault = hub.startPoints().find((q) => q.kind === "assault" && q.open)!;
    hub.choose("assault", assault.id);
    const a = await hub.gapDepart();
    if (a?.t !== "scheduled") fail(`reschedule: first=${a?.t}`);
    const b = await hub.gapDepart();
    if (b?.t !== "waiting") fail(`reschedule: second=${b?.t}`);
    console.log("  ok scheduled then waiting");
  }

  if (errors.length) {
    console.error(`\n${errors.length} failure(s)`);
    process.exit(1);
  }
  console.log("\ndepart bruteforce ok");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
