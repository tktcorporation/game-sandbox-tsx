/**
 * Contested coastal hubs (方向 A / TKT-195): rival-held hubs stand 工場 + 島の守り as garrison.
 * Run: `npx tsx scripts/ringfall-contested.ts`.
 */
import { FACTORY } from "../src/ringfall/sim/config";
import { NODES, poiIndex, type NodeId } from "../src/ringfall/sim/map";
import { CONTESTED_SHORES, neighbourNameByCode } from "../src/ringfall/meta/neighbours";
import { contestedOwned, newIsland, nonContestedNodeCount, type Island } from "../src/ringfall/meta/island";
import { contestedDefence } from "../src/ringfall/meta/contested-defence";
import { rivalHold } from "../src/ringfall/sim/holds";
import { DEFENCE_AID, defenceKinds, garrison, isContestedPoi } from "../src/ringfall/sim/island";
import { newRun, starterKit } from "../src/ringfall/sim/state";
import { LOCAL_AID } from "../src/ringfall/meta/parcels";

const errors: string[] = [];
const check = (ok: boolean, what: string) => {
  if (!ok) errors.push(what);
};

check(CONTESTED_SHORES.length === 4, `contested: expected 4 shores, got ${CONTESTED_SHORES.length}`);
check(nonContestedNodeCount() === NODES.length - 4, `contested: non-contested count ${nonContestedNodeCount()}`);
check(
  CONTESTED_SHORES.every((id) => isContestedPoi(id)),
  "contested: sim isContestedPoi misses a shore",
);

const island = (own: NodeId[], rival?: Partial<Record<NodeId, string>>): Island => {
  const poiState = newIsland();
  for (const id of own) poiState[id] = { state: "own" };
  for (const [id, who] of Object.entries(rival ?? {})) poiState[id as NodeId] = { state: rivalHold(who!) };
  return poiState;
};

// Contested owned tracks player-held contested hubs only.
{
  check(contestedOwned({ poiState: island(["station"]) }).join() === "station", "contestedOwned missed station");
  check(contestedOwned({ poiState: island([], { station: "NEIGH1" }) }).length === 0, "rival station in contestedOwned");
}

// Garrison: rival contested hub with defence → factory kinds (+ aid grunts); without → empty.
{
  const i = poiIndex("station");
  const hold = rivalHold("OWNER1");
  check(garrison(i, hold).length === 0, "garrison: rival without defence should be empty");
  check(garrison(i, "own").length === 0, "garrison: own should be empty");
  const sq = garrison(i, hold, { factory: 2, aid: DEFENCE_AID });
  check(sq.length === 1, `garrison: expected 1 squad, got ${sq.length}`);
  const expect = defenceKinds(2).length + DEFENCE_AID;
  check(sq[0]!.members.length === expect, `garrison: members ${sq[0]!.members.length}, want ${expect} (kinds+aid)`);
}

// newRun: contested rival with Start.defence stands robots and is not cleared; sim gate unchanged.
{
  const owner = "OWNER1";
  const s = newRun(42, starterKit(), "reservoir", {
    island: { station: rivalHold(owner), supply: "foe" },
    defence: [{ owner, factory: 1 }],
    parcels: [
      { id: 1, poi: "station", kind: "parts", from: { code: LOCAL_AID, name: "" } },
      { id: 2, poi: "station", kind: "fuse", from: { code: LOCAL_AID, name: "" } },
      { id: 3, poi: "station", kind: "wire", from: { code: LOCAL_AID, name: "" } },
    ],
  });
  const i = poiIndex("station");
  check(!s.cleared[i], "newRun: contested rival with defence must not start cleared");
  const at = s.enemies.filter((e) => e.poi === i && e.rival === owner);
  const expect = FACTORY.levels[1].kinds.length + DEFENCE_AID; // aid capped at 2 despite 3 parcels
  check(at.length === expect, `newRun: garrison robots ${at.length}, want ${expect}`);
  check((s.defenceAid[i] ?? 0) === DEFENCE_AID, `newRun: defenceAid ${s.defenceAid[i]}, want ${DEFENCE_AID}`);
}

// Gate-style raid (no defence) keeps rival cleared / no robots at station.
{
  const s = newRun(42, starterKit(), "reservoir", { island: { station: rivalHold("OWNER1") } });
  const i = poiIndex("station");
  check(s.cleared[i], "newRun: rival without defence starts cleared");
  check(s.enemies.filter((e) => e.poi === i).length === 0, "newRun: no defence → no robots at station");
}

// contestedDefence lists owners of contested rival holds.
{
  const poiState = island(["supply"], { station: "NEIGH1", waterworks: "ai-ABCDE123" });
  // ai owner needs valid code shape; use plain neighbour for station only.
  const list = contestedDefence(island(["supply"], { station: "NEIGH1" }), 10, [{ code: "NEIGH1", name: "ツバキ", held: 4, total: 21, day: 10, slot: 0, factory: 3 }], 1);
  check(list.length === 1 && list[0]!.owner === "NEIGH1" && list[0]!.factory === 3, `contestedDefence: ${JSON.stringify(list)}`);
  void poiState;
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

console.log(`contested: ${CONTESTED_SHORES.join(", ")}; non-contested ${nonContestedNodeCount()}`);

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("contested ok");
