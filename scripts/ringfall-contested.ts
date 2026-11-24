/**
 * Contested coastal hubs (方向 A / TKT-195): あと N counts them when owned, and 16 is reachable
 * without taking any of the four. Run: `npx tsx scripts/ringfall-contested.ts`.
 */
import { FINALE } from "../src/ringfall/sim/config";
import { NODES, type NodeId } from "../src/ringfall/sim/map";
import { CONTESTED_SHORES, neighbourNameByCode } from "../src/ringfall/meta/neighbours";
import { contestedOwned, liberationStatus, newIsland, nonContestedNodeCount, type Island } from "../src/ringfall/meta/island";
import { rivalHold } from "../src/ringfall/sim/holds";

const errors: string[] = [];
const check = (ok: boolean, what: string) => {
  if (!ok) errors.push(what);
};

check(CONTESTED_SHORES.length === 4, `contested: expected 4 shores, got ${CONTESTED_SHORES.length}`);
check(nonContestedNodeCount() === NODES.length - 4, `contested: non-contested count ${nonContestedNodeCount()}`);
check(nonContestedNodeCount() >= FINALE.nodes, `contested: 16 not reachable without contested (${nonContestedNodeCount()} < ${FINALE.nodes})`);

const island = (own: NodeId[], rival?: Partial<Record<NodeId, string>>): Island => {
  const poiState = newIsland();
  for (const id of own) poiState[id] = { state: "own" };
  for (const [id, who] of Object.entries(rival ?? {})) poiState[id as NodeId] = { state: rivalHold(who!) };
  return poiState;
};

// Zero owned → あと 16.
{
  const st = liberationStatus({ poiState: island([]) });
  check(st.kind === "nodes" && st.left === FINALE.nodes, `あと N: empty island left ${JSON.stringify(st)}, want ${FINALE.nodes}`);
}

// Owning one contested hub reduces left by 1.
{
  const st = liberationStatus({ poiState: island(["station"]) });
  check(st.kind === "nodes" && st.left === FINALE.nodes - 1, `あと N: station owned left ${JSON.stringify(st)}`);
  check(contestedOwned({ poiState: island(["station"]) }).join() === "station", "あと N: contestedOwned missed station");
}

// Rival-held contested hub does not count toward N.
{
  const st = liberationStatus({ poiState: island(["supply"], { station: "NEIGH1" }) });
  check(st.kind === "nodes" && st.left === FINALE.nodes - 1, `あと N: rival station counted (${JSON.stringify(st)})`);
  check(contestedOwned({ poiState: island([], { station: "NEIGH1" }) }).length === 0, "あと N: rival station in contestedOwned");
}

// 16 non-contested owns → landing or finale path (need pad neighbour).
{
  const non = NODES.filter((n) => !CONTESTED_SHORES.includes(n.id)).map((n) => n.id).slice(0, FINALE.nodes);
  const st = liberationStatus({ poiState: island(non) });
  check(st.kind === "landing" || st.kind === "finale", `あと N: 16 non-contested -> ${st.kind}, want landing|finale`);
}

// Owner labels resolve by code, never by the current slot occupant (Codex).
{
  const neigh = [
    { code: "AAAAAA", name: "スロットの人" },
    { code: "NEIGH1", name: "ツバキ" },
  ];
  check(neighbourNameByCode("NEIGH1", neigh) === "ツバキ", "owner label: known code missed");
  check(neighbourNameByCode("GONE01", neigh) === null, "owner label: unknown code invented a name");
  check(neighbourNameByCode("ai-NEIGH1", neigh) === "ツバキ", "owner label: ai- prefix missed");
}

console.log(`contested: ${CONTESTED_SHORES.join(", ")}; non-contested ${nonContestedNodeCount()}; FINALE ${FINALE.nodes}`);

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("contested ok");
