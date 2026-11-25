/**
 * Outer contested hubs (作り順②): derived from map data, includes the four shore faces,
 * excludes inner hubs. Run: `npx tsx scripts/ringfall-contested-outer.ts`.
 */
import { ROUTE_SHORES, CONTESTED_SHORES, isContestedShore } from "../src/ringfall/meta/neighbours";
import { CONTESTED_OUTER, OUTER_BOUND_NEAR, OUTER_SEA_NEAR, isContestedOuter, outerFacingHubs } from "../src/ringfall/sim/contested-outer";
import { CONTESTED_POIS, isContestedPoi } from "../src/ringfall/sim/island";
import { NODES, type NodeId } from "../src/ringfall/sim/map";

const errors: string[] = [];
const check = (ok: boolean, what: string) => {
  if (!ok) errors.push(what);
};

const outer = outerFacingHubs();
check(outer.length === CONTESTED_OUTER.length, "outerFacingHubs length ≠ CONTESTED_OUTER");
check(
  outer.every((id, i) => id === CONTESTED_OUTER[i]),
  "outerFacingHubs order ≠ CONTESTED_OUTER",
);
check(
  CONTESTED_SHORES.length === CONTESTED_OUTER.length && CONTESTED_SHORES.every((id, i) => id === CONTESTED_OUTER[i]),
  "CONTESTED_SHORES must alias CONTESTED_OUTER",
);
check(
  CONTESTED_POIS.length === CONTESTED_OUTER.length && CONTESTED_POIS.every((id, i) => id === CONTESTED_OUTER[i]),
  "CONTESTED_POIS must match CONTESTED_OUTER",
);

// Original four sea-route faces stay contested.
for (const id of ROUTE_SHORES) {
  check(isContestedShore(id) && isContestedOuter(id) && isContestedPoi(id), `route shore ${id} not contested`);
}

// Inner hubs (judgment: not on hull / not near sea or world edge) stay untakeable.
const innerExpect: NodeId[] = [
  "supply",
  "quarry",
  "relay",
  "yard",
  "smelter",
  "cannery",
  "coldstore",
  "terminal",
  "carpark",
  "control",
  "assembly",
];
for (const id of innerExpect) {
  check(!isContestedShore(id), `inner ${id} must not be contested`);
}

// Every freeable node is either outer or inner; no orphans.
const freeable = new Set(NODES.map((n) => n.id));
for (const id of CONTESTED_OUTER) check(freeable.has(id), `outer ${id} not a freeable node`);
check(CONTESTED_OUTER.length + innerExpect.length === NODES.length, `outer+inner ${CONTESTED_OUTER.length}+${innerExpect.length} ≠ ${NODES.length}`);

// Stable and non-empty.
check(CONTESTED_OUTER.length >= ROUTE_SHORES.length, `outer count ${CONTESTED_OUTER.length} < route shores`);
check(CONTESTED_OUTER.length < NODES.length, "every hub contested — inner set empty");

console.log(
  `contested-outer: ${CONTESTED_OUTER.length} hubs (sea≤${OUTER_SEA_NEAR}m / bound≤${OUTER_BOUND_NEAR}m / hull): ${CONTESTED_OUTER.join(", ")}`,
);
console.log(`inner (${innerExpect.length}): ${innerExpect.join(", ")}`);
console.log(`route shores: ${ROUTE_SHORES.join(", ")}`);

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("contested-outer ok");
