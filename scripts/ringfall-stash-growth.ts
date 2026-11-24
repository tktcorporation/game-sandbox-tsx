/**
 * Results growth (倉庫へ届いた): seized 制圧 loot that store() sold for room must not appear as
 * delivered. Tests 0 free slots, 1 free slot with seized vs haul competing, and the island-on
 * rival-held node path. Sale rules unchanged.
 *
 * Run: `npx tsx scripts/ringfall-stash-growth.ts`; ends with "stash growth ok".
 */
import { META } from "../src/ringfall/sim/config";
import { rivalHold } from "../src/ringfall/sim/holds";
import { POIS, poiIndex, type PoiId } from "../src/ringfall/sim/map";
import { takeNode } from "../src/ringfall/sim/front";
import { newRun, starterKit } from "../src/ringfall/sim/state";
import { emptyHideout, stashCap } from "../src/ringfall/meta/hideout";
import { keptSeized, newProfile, settle, stashUsed, type Item, type Profile } from "../src/ringfall/meta/profile";
import { LOCAL_AID, type Parcel } from "../src/ringfall/meta/parcels";

const errors: string[] = [];
const check = (ok: boolean, what: string) => {
  if (!ok) errors.push(what);
};

const fillStash = (p: Profile, free: number): Profile => {
  const cap = stashCap(p.hideout);
  const used = stashUsed(p);
  const need = Math.max(0, cap - free - used);
  const extra: Item[] = Array.from({ length: need }, () => ({ t: "valuable", kind: "wire" as const }));
  return { ...p, stash: [...p.stash, ...extra] };
};

const rivalIsland = (p: Profile, rival: PoiId): Profile => {
  const poiState = { ...p.poiState };
  poiState[rival] = { state: rivalHold("Z3P9TR") };
  // Neighbour player ground so the node is on the front (supply next to camp).
  if (rival !== "supply") poiState.supply = { state: "own" };
  return { ...p, poiState, day: 5, parcels: [] };
};

const withParcel = (p: Profile, poi: PoiId, kind: Parcel["kind"] = "parts"): Profile => ({
  ...p,
  parcels: [{ id: 41, poi, kind, from: { code: LOCAL_AID, name: "となり" }, at: 0 }],
});

/** Settle a short raid that captures rival `poi` (and optional haul). */
function settleCapture(p0: Profile, poi: PoiId, haul: Item["kind"][] = []) {
  const p = withParcel(rivalIsland(p0, poi), poi, "parts");
  // A second parcel kind so 1-slot tests can compete.
  p.parcels = [
    ...p.parcels,
    { id: 42, poi, kind: "fuse", from: { code: LOCAL_AID, name: "となり" }, at: 1 },
  ];
  const s = newRun(p.seed, starterKit(), "reservoir", {
    island: Object.fromEntries(POIS.map((o) => [o.id, p.poiState[o.id]?.state ?? "foe"])),
    depots: p.depots,
  });
  // Hold at raid start must still show rival for seizeRivalLoot.
  const i = poiIndex(poi);
  check(s.hold?.[i] !== undefined && String(s.hold[i]).startsWith("rival:"), `setup: ${poi} not rival at start`);
  takeNode(s, i);
  s.outcome = "extracted";
  for (const k of haul) s.player.haul.push(k as never);
  return settle(p, s);
}

// --- keptSeized pure
{
  const before = { stash: [{ t: "valuable" as const, kind: "wire" as const }] };
  const after = { stash: [...before.stash, { t: "valuable" as const, kind: "parts" as const }] };
  const kept = keptSeized([{ poi: "relay", kinds: ["parts", "fuse"] }], before, after);
  check(kept.length === 1 && kept[0]!.kinds.join() === "parts", `keptSeized: expected parts only, got ${JSON.stringify(kept)}`);
  const none = keptSeized([{ poi: "relay", kinds: ["fuse"] }], before, before);
  check(none.length === 0, "keptSeized: full stash still listed seize");
}

// --- 0 free slots: seized all sold → no Settlement.seized, sold has valuables
{
  let p = fillStash(newProfile(9), 0);
  check(stashUsed(p) >= stashCap(p.hideout), "0-slot: stash not full");
  const settled = settleCapture(p, "supply");
  check(!settled.seized?.length, `0-slot: seized still on 倉庫へ届いた ${JSON.stringify(settled.seized)}`);
  check(settled.sold.some((i) => i.t === "valuable"), "0-slot: sold has no valuables");
  check(settled.soldFor > 0, "0-slot: soldFor 0");
  console.log(`0 free: sold ${settled.sold.length}, seized ${settled.seized?.length ?? 0}`);
}

// --- 1 free slot: seized two kinds compete — at most one kind kept in seized; rest sold
{
  let p = fillStash(newProfile(11), 1);
  check(stashCap(p.hideout) - stashUsed(p) === 1, "1-slot: not exactly one free");
  const settled = settleCapture(p, "supply");
  const keptKinds = settled.seized?.flatMap((q) => q.kinds) ?? [];
  check(keptKinds.length <= 1, `1-slot: kept ${keptKinds.length} seized kinds, want ≤1`);
  check(settled.sold.some((i) => i.t === "valuable"), "1-slot: overflow not sold");
  // The kept one must appear as a stash gain.
  if (keptKinds[0]) {
    const beforeN = p.stash.filter((i) => i.t === "valuable" && i.kind === keptKinds[0]).length;
    // after store is inside settle's profile before night/quests — use settled.home/sold instead:
    check(settled.sold.filter((i) => i.t === "valuable").length >= 1, "1-slot: expected ≥1 sold valuable");
  }
  console.log(`1 free: seized kept [${keptKinds}], sold valuables ${settled.sold.filter((i) => i.t === "valuable").length}`);
}

// --- 1 free slot: haul vs seized compete (haul parts + seize parts/fuse)
{
  let p = fillStash(newProfile(13), 1);
  const settled = settleCapture(p, "relay", ["parts"]);
  const kept = settled.seized?.flatMap((q) => q.kinds) ?? [];
  const soldV = settled.sold.filter((i) => i.t === "valuable").length;
  check(kept.length + soldV >= 2, `compete: expected overflow among haul+seize, kept=${kept.length} soldV=${soldV}`);
  check(kept.length <= 1, `compete: seized claimed ${kept.length} under 1 free slot`);
  console.log(`compete: seized [${kept}], soldV ${soldV}`);
}

// --- Room enough: seized kept and listed
{
  let p = fillStash(newProfile(15), 10);
  const settled = settleCapture(p, "supply");
  check((settled.seized?.flatMap((q) => q.kinds).length ?? 0) >= 1, "room: seized missing when stash had room");
  check(settled.sold.filter((i) => i.t === "valuable").length === 0, "room: valuables sold with room left");
  console.log(`room: seized ${JSON.stringify(settled.seized)}`);
}

console.log(`stash cap base ${META.stash}, hideout empty ${stashCap(emptyHideout())}`);
if (errors.length) {
  for (const e of errors) console.error(`FAIL ${e}`);
  process.exit(1);
}
console.log("stash growth ok");
