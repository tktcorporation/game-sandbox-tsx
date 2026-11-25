/**
 * Outer contested hubs (作り順②): derived from map data, checked against the Worker-safe table.
 * Run: `npx tsx scripts/ringfall-contested-outer.ts` (fails on drift).
 * `--write` rewrites `src/ringfall/meta/contested-outer-table.ts`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { ROUTE_SHORES, CONTESTED_SHORES, isContestedShore } from "../src/ringfall/meta/neighbours";
import { CONTESTED_OUTER_IDS, CONTESTED_OUTER_TABLE } from "../src/ringfall/meta/contested-outer-table";
import { CONTESTED_OUTER, OUTER_BOUND_NEAR, OUTER_SEA_NEAR, isContestedOuter, outerFacingHubs } from "../src/ringfall/sim/contested-outer";
import { CONTESTED_POIS, isContestedPoi } from "../src/ringfall/sim/island";
import { NODES, type NodeId } from "../src/ringfall/sim/map";

const errors: string[] = [];
const check = (ok: boolean, what: string) => {
  if (!ok) errors.push(what);
};

/** File text for meta/contested-outer-table.ts from the live derivation. */
export function contestedOuterTableSource(): string {
  const ids = outerFacingHubs();
  const rows = ids.map((id) => {
    const n = NODES.find((x) => x.id === id)!;
    const x = Math.round(n.x * 1000) / 1000;
    const z = Math.round(n.z * 1000) / 1000;
    return `  { id: "${id}", x: ${x}, z: ${z} },`;
  });
  return `/*
 * Outer-edge contested hubs (作り順②) as a light table for the Worker and meta code that must
 * not build the world. Written from map data by scripts/ringfall-contested-outer.ts (\`--write\`);
 * that script fails when this file differs from \`outerFacingHubs()\` in sim/contested-outer.ts.
 * Thresholds: OUTER_SEA_NEAR ${OUTER_SEA_NEAR}, OUTER_BOUND_NEAR ${OUTER_BOUND_NEAR} (see contested-outer.ts).
 */

export interface ContestedOuterHub {
  id: string;
  x: number;
  z: number;
}

export const CONTESTED_OUTER_TABLE: readonly ContestedOuterHub[] = [
${rows.join("\n")}
];

/** Outer contested hub ids in \`NODES\` order (same as CONTESTED_OUTER_TABLE). */
export const CONTESTED_OUTER_IDS: readonly string[] = CONTESTED_OUTER_TABLE.map((h) => h.id);
`;
}

const tableFile = new URL("../src/ringfall/meta/contested-outer-table.ts", import.meta.url);
const want = contestedOuterTableSource();
if (process.argv.includes("--write")) writeFileSync(tableFile, want);
const same = readFileSync(tableFile, "utf8") === want;
check(same, "contested-outer-table.ts differs from outerFacingHubs() (run with --write)");

const outer = outerFacingHubs();
check(outer.length === CONTESTED_OUTER.length, "outerFacingHubs length ≠ CONTESTED_OUTER");
check(
  outer.every((id, i) => id === CONTESTED_OUTER[i]),
  "outerFacingHubs order ≠ CONTESTED_OUTER",
);
check(
  CONTESTED_SHORES.length === CONTESTED_OUTER.length && CONTESTED_SHORES.every((id, i) => id === CONTESTED_OUTER[i]),
  "CONTESTED_SHORES must alias table / CONTESTED_OUTER",
);
check(
  CONTESTED_OUTER_IDS.length === outer.length && CONTESTED_OUTER_IDS.every((id, i) => id === outer[i]),
  "CONTESTED_OUTER_IDS must match outerFacingHubs()",
);
check(
  CONTESTED_POIS.length === CONTESTED_OUTER.length && CONTESTED_POIS.every((id, i) => id === CONTESTED_OUTER[i]),
  "CONTESTED_POIS must match CONTESTED_OUTER",
);
check(
  CONTESTED_OUTER_TABLE.every((h) => {
    const n = NODES.find((x) => x.id === h.id);
    return !!n && Math.abs(n.x - h.x) < 0.01 && Math.abs(n.z - h.z) < 0.01;
  }),
  "table x/z must match NODES centres",
);

for (const id of ROUTE_SHORES) {
  check(isContestedShore(id) && isContestedOuter(id) && isContestedPoi(id), `route shore ${id} not contested`);
}

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

const freeable = new Set(NODES.map((n) => n.id));
for (const id of CONTESTED_OUTER) check(freeable.has(id), `outer ${id} not a freeable node`);
check(CONTESTED_OUTER.length + innerExpect.length === NODES.length, `outer+inner ${CONTESTED_OUTER.length}+${innerExpect.length} ≠ ${NODES.length}`);
check(CONTESTED_OUTER.length >= ROUTE_SHORES.length, `outer count ${CONTESTED_OUTER.length} < route shores`);
check(CONTESTED_OUTER.length < NODES.length, "every hub contested — inner set empty");

console.log(
  `contested-outer: ${CONTESTED_OUTER.length} hubs (sea≤${OUTER_SEA_NEAR}m / bound≤${OUTER_BOUND_NEAR}m / hull): ${CONTESTED_OUTER.join(", ")}`,
);
console.log(`table: ${same ? "as outerFacingHubs() gives it" : "DRIFT — run with --write"}`);
console.log(`inner (${innerExpect.length}): ${innerExpect.join(", ")}`);
console.log(`route shores: ${ROUTE_SHORES.join(", ")}`);

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("contested-outer ok");
