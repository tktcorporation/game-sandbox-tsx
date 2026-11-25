/**
 * Brute-force every departure start under several island states: choose → launch.
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

const errors: string[] = [];
const fail = (msg: string) => {
  errors.push(msg);
  console.error("FAIL", msg);
};

const freeAll = (p: Profile): Profile => {
  const poiState = { ...p.poiState };
  for (const n of NODES) if (n.id !== "pad") poiState[n.id] = { state: "own" };
  return {
    ...p,
    poiState,
    depots: NODES.filter((n) => n.id !== "pad").map((n) => n.id),
    entries: ENTRIES.map((e) => e.id),
  };
};

const freeIds = (p: Profile, ids: PoiId[]): Profile => {
  const poiState = { ...p.poiState };
  for (const id of ids) poiState[id] = { state: "own" };
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
  { name: "shores-open", build: (p) => freeIds(p, NEIGHBOUR_SLOTS.map((s) => s.shore)) },
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
];

function simulateDepart(hub: Hub): { ok: boolean; kind: string; detail: string } {
  const on = hub.startPoints().find((q) => q.on);
  if (!on) return { ok: false, kind: "none", detail: "no start on" };
  if (hub.rideRefused()) return { ok: false, kind: "refused", detail: hub.rideRefused() };
  const launch = hub.launch();
  if (!launch) return { ok: false, kind: "launch-null", detail: on.name };
  return { ok: true, kind: "home-raid", detail: `${on.kind}:${on.name} → ${launch.region}/${launch.entry}` };
}

async function main() {
  for (const sc of scenarios) {
    console.log(`\n== ${sc.name} ==`);
    const p = sc.build(newProfile(42));
    const hub = new Hub(p, () => {});
    const pts = hub.startPoints();
    console.log(`starts=${pts.length} open=${pts.filter((q) => q.open).length}`);

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
      const result = simulateDepart(h);
      if (!result.ok) fail(`${sc.name}: ${q.kind}:${q.name} → ${result.kind} ${result.detail}`);
      else console.log(`  ok ${q.kind}:${q.name} → ${result.kind}`);
    }

    for (const q of pts.filter((s) => !s.open)) {
      const h = new Hub(structuredClone(p), () => {});
      if (h.choose(q.kind, q.id)) fail(`${sc.name}: shut ${q.kind}:${q.name} was choosable`);
    }
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