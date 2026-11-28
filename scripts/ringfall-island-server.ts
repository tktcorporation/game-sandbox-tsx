/**
 * The island on the server (worker/island.ts, worker/api.ts; docs/ringfall/multiplayer.md): the API
 * on a stand-in `ISLAND` namespace whose objects run the island's pure ops in memory. Sorties (攻め)
 * on a holding are checked by scripts/ringfall-real-raids.ts, the day's guard by ringfall-outer-guard.ts.
 *
 * - **table**: src/ringfall/meta/island-table.ts is what map.ts gives (`--write` rewrites it).
 * - **no island server**: without the binding, /api/islands/ answers 202 `no-island-server`.
 * - **codes**: a drawn code is six characters of Crockford base32; the identity keeps the one handed out.
 * - **claim**: the server hands out the code, drawing again past codes taken and giving up after
 *   `CLAIM_TRIES`; a report to an unclaimed code is 404, and only the owner's id reports to an island.
 * - **removed**: the routes of expeditions (遠征, removed 2026-11-28) answer 404, and an island
 *   stored with expeditions on it loads without them, a node one held back with the robots.
 * - **retaken**: the owner's report of a node of theirs taken back (named among `retaken`) makes it
 *   theirs and logs it; a report of another player's node as the owner's without naming it there
 *   keeps it the other player's; a malformed `retaken` is refused.
 * - **log**: the owner's log from a cursor holds only what came after it; nobody else reads it.
 * - **public**: what anyone reads of an island holds no player's id, and names as open only
 *   holdings a sortie could take.
 * - **stored**: a read stores nothing; a report does.
 * - **parcels**: 島の守り are left at depots, the pad's among them.
 * - **shield / contested**: a coastal hub taken today cannot flip again until the next UTC day;
 *   contestedMirror sets the neighbour's facing shore to the shared owner.
 *
 * Run alone: `npx tsx scripts/ringfall-island-server.ts`; it ends with "island server ok".
 */
import { readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { CLAIM_TRIES, handleApi, type ApiEnv, type Db, type DbStatement, type IslandNamespace } from "../worker/api";
import { NEIGHBOUR_SLOTS } from "../src/ringfall/meta/neighbours";
import { DEPOT_POIS, ISLAND_RULES, islandOp, migrateIslandState, NODE_IDS, parseParcels, type IslandOp, type IslandState } from "../worker/island";
import { FACTORY_TOP } from "../src/ringfall/sim/config";
import { isIslandCode, newIslandCode } from "../src/ringfall/meta/island-code";
import { loadIdentity, parseIdentity, rememberCode } from "../src/ringfall/meta/identity";
import { islandTableSource } from "./ringfall-island-table";

const errors: string[] = [];
const check = (ok: boolean, what: string) => {
  if (!ok) errors.push(what);
};

// --- table
{
  const file = new URL("../src/ringfall/meta/island-table.ts", import.meta.url);
  const want = islandTableSource();
  if (process.argv.includes("--write")) writeFileSync(file, want);
  const same = readFileSync(file, "utf8") === want;
  console.log(`table: ${NODE_IDS.length} nodes, ${same ? "as map.ts gives it" : "differs from map.ts (run with --write)"}`);
  check(same, "table: src/ringfall/meta/island-table.ts differs from map.ts");
}

// --- island codes, and the identity keeping the one the server handed out
{
  const codes = Array.from({ length: 200 }, () => newIslandCode());
  const id = "7c9e6679-7425-40de-944b-e07fc1f0d3c4";
  const none = parseIdentity({ id, name: "ねこ" });
  const kept = parseIdentity({ id, name: "ねこ", code: "K7M2QX" });
  const bad = parseIdentity({ id, name: "ねこ", code: "OOOOOO" });
  const me = rememberCode("K7M2QX");
  console.log(`codes: ${codes.slice(0, 4).join(" ")}; identity without a code ${JSON.stringify(none?.code)}, with one ${kept?.code}, with a bad one ${JSON.stringify(bad?.code)}; remembered ${loadIdentity().code}`);
  check(codes.every(isIslandCode) && !codes.some((c) => /[ILOU]/.test(c)) && new Set(codes).size > 190, "codes: a drawn code is not 6 characters of Crockford base32");
  check(none?.code === undefined && kept?.code === "K7M2QX" && bad?.code === undefined && me.code === "K7M2QX" && loadIdentity().code === "K7M2QX" && loadIdentity().id === me.id, "codes: the identity does not keep the code the server handed out");
}

/** The stand-in namespace: one island state for each code, run by the island's ops as IslandDO runs them. */
const islands = new Map<string, IslandState | null>();
const ns: IslandNamespace = {
  idFromName: (name) => name,
  get: (id) => ({
    async fetch(req: Request) {
      const { op, now } = (await req.json()) as { op: IslandOp; now: number };
      const r = islandOp(islands.get(id as string) ?? null, op, now);
      islands.set(id as string, r.state);
      return Response.json(r.body, { status: r.status });
    },
  }),
};
const env: ApiEnv = { ISLAND: ns };

const BASE = "https://ringfall.test";
/** A player and, once they have claimed an island, its code. */
const A = { id: "0f8fad5b-d9cb-469f-a165-70867728950e", name: "ねこ", code: "" };
const B = { id: "7c9e6679-7425-40de-944b-e07fc1f0d3c4", name: "いぬ", code: "" };
const C = { id: "16fd2706-8baf-433b-82eb-8c7fada847da", name: "とり", code: "" };
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 1, 3);

async function call(method: string, path: string, body?: unknown, now = T0, e: ApiEnv = env, draw?: () => string, headers: Record<string, string> = {}) {
  const req = new Request(BASE + path, body === undefined ? { method, headers } : { method, headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
  const res = await handleApi(req, e, now, draw);
  if (!res) return { status: 0, body: {} as Record<string, unknown>, text: "" };
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) as Record<string, unknown>, text };
}
const err = (r: { body: Record<string, unknown> }) => r.body.error;
const holdsWith = (over: Record<string, string>) => NODE_IDS.map((id) => over[id] ?? "foe");
const claimFor = (who: typeof A, now = T0, draw?: () => string) => call("POST", "/api/islands", { player: { id: who.id, name: who.name } }, now, env, draw);
const report = (who: typeof A, holds: string[], factory: number, day: number, now: number, retaken: unknown = []) => call("PUT", `/api/islands/${who.code}`, { player: { id: who.id, name: who.name }, holds, retaken, factory, day }, now);
/** The owner's log after `after`, read with `id` as the bearer (none for no header). */
const readLog = (code: string, id: string | null, after: number, now: number) => call("GET", `/api/islands/${code}/log?after=${after}`, undefined, now, env, undefined, id === null ? {} : { authorization: `Bearer ${id}` });
const holdOf = (code: string, node: string) => islands.get(code)!.holds[NODE_IDS.indexOf(node)];
// --- no island server
{
  const c = await call("POST", "/api/islands", { player: A }, T0, {});
  const g = await call("GET", "/api/islands/N3K0AA", undefined, T0, {});
  const p = await call("PUT", "/api/islands/N3K0AA", { player: A, holds: holdsWith({}), factory: 0, day: 1 }, T0, {});
  console.log(`no island server: claim ${c.status}, GET ${g.status} ${g.text}; PUT ${p.status}`);
  check(c.status === 202 && g.status === 202 && err(g) === "no-island-server" && p.status === 202, "no island server: /api/islands did not answer 202 no-island-server");
}

// --- claim: the server hands out the code; a report goes only to an island claimed, from its owner
{
  const a = await claimFor(A);
  A.code = a.body.code as string;
  const b = await claimFor(B);
  B.code = b.body.code as string;
  // A drawn code someone holds is drawn again: the first two draws hit A's and B's islands.
  const seq = [A.code, B.code];
  const c = await claimFor(C, T0, () => seq.shift() ?? newIslandCode());
  C.code = c.body.code as string;
  const stuck = await claimFor({ ...C, id: "6ba7b810-9dad-41d1-80b4-00c04fd430c8" }, T0, () => A.code);
  const noName = await call("POST", "/api/islands", { player: { id: A.id } }, T0);
  const free = "QQQQQQ";
  const unclaimed = await call("PUT", `/api/islands/${free}`, { player: A, holds: holdsWith({}), factory: 0, day: 1 }, T0);
  const r = await report(A, holdsWith({ quarry: "own", supply: "own" }), 0, 3, T0);
  const other = await report({ ...B, code: A.code }, holdsWith({}), 0, 1, T0);
  const again = await report({ ...A, name: "ねこ2" }, holdsWith({ quarry: "own", supply: "own" }), 0, 4, T0 + 1000);
  const bad = await call("PUT", `/api/islands/${A.code}`, { player: A, holds: ["foe"], factory: 0, day: 1 }, T0);
  console.log(`claim: A ${a.status} ${A.code}, B ${b.status} ${B.code}, C after two taken draws ${c.status} ${C.code}, every draw taken ${stuck.status} ${err(stuck)}, no name ${noName.status}`);
  console.log(`claim: a report to an unclaimed code ${unclaimed.status} ${err(unclaimed)} (still unclaimed: ${!islands.get(free)}), the owner's ${r.status}, another player's ${other.status} ${err(other)}, the owner again ${again.status}, short holds ${bad.status}`);
  check(a.status === 201 && b.status === 201 && c.status === 201 && [A.code, B.code, C.code].every(isIslandCode) && new Set([A.code, B.code, C.code]).size === 3, "claim: three claims did not get three codes");
  check(islands.get(A.code)!.owner.id === A.id && islands.get(C.code)!.owner.id === C.id, "claim: a taken draw changed the island's owner");
  check(stuck.status === 503 && err(stuck) === "no-free-code" && CLAIM_TRIES > 1 && noName.status === 400, "claim: a claim with every draw taken did not give up with 503");
  check(unclaimed.status === 404 && !islands.get(free), "claim: a report claimed an island");
  check(r.status === 200 && other.status === 403 && err(other) === "not-owner" && again.status === 200 && bad.status === 400, "claim: a report was taken from someone not the island's owner");
  await report(B, holdsWith({}), FACTORY_TOP, 9, T0);
  await report(C, holdsWith({}), 4, 2, T0);
}


const T1 = T0 + ISLAND_RULES.protectDays * DAY + 1000;
/** An island of A's on the pure module, claimed at `since`, with `holds` set. */
const island = (holds: Record<string, string>, since = T0): IslandState => {
  const st = islandOp(null, { t: "claim", player: A, code: A.code || "AAAAAA" }, since).state!;
  st.holds = holdsWith(holds) as IslandState["holds"];
  return st;
};
const op = (st: IslandState, o: IslandOp, now: number) => islandOp(st, o, now);
const station = NODE_IDS.indexOf("station");

// --- removed: the routes of expeditions are gone, and an island stored with them loads without them
{
  const from = { id: B.id, name: B.name, code: B.code };
  const sent = await call("POST", `/api/islands/${A.code}/expeditions`, { from, target: "quarry", units: 1 }, T1);
  const lease = await call("POST", `/api/islands/${A.code}/lease`, {}, T1, env, undefined, { authorization: `Bearer ${A.id}` });
  const assault = await call("POST", `/api/islands/${A.code}/assault`, { from, id: 1, won: true }, T1);
  const recall = await call("DELETE", `/api/islands/${A.code}/expeditions/1`, { from }, T1);
  console.log(`removed: expeditions ${sent.status}, lease ${lease.status}, assault ${assault.status}, recall ${recall.status}`);
  check([sent, lease, assault, recall].every((r) => r.status === 404), "removed: a route of expeditions still answers");
  const old = island({ supply: "own", quarry: `rival:${B.code}`, station: `rival:${C.code}` }) as IslandState & Record<string, unknown>;
  old.expeditions = [{ id: 3, by: { code: B.code, name: B.name }, target: NODE_IDS.indexOf("quarry"), units: [], sentAt: T0, arriveAt: T0, arrived: true, holding: true }];
  old.defenders = [];
  old.guards = NODE_IDS.map(() => null);
  old.meter = NODE_IDS.map(() => null);
  old.made = 0;
  old.clock = T0;
  old.lease = null;
  old.taken = { day: 0, n: 0 };
  old.log = [
    { seq: 1, at: T0, t: "noticed", node: "quarry", by: { code: B.code, name: B.name } },
    { seq: 2, at: T0, t: "taken", node: "quarry", by: { code: B.code, name: B.name } },
  ] as unknown as IslandState["log"];
  old.seq = 2;
  const view = op(old, { t: "view" }, T1);
  const log = op(old, { t: "log", player: A.id, after: 0 }, T1).body as { entries: { t: string }[]; next: number };
  console.log(`removed: an old island's quarry ${old.holds[NODE_IDS.indexOf("quarry")]}, station ${old.holds[station]}, log ${log.entries.map((e) => e.t).join()} next ${log.next}`);
  check(view.status === 200 && !("expeditions" in old) && !("clock" in old) && !("expeditions" in (view.body as object)), "removed: an old island kept its expeditions");
  check(old.holds[NODE_IDS.indexOf("quarry")] === "foe" && old.holds[station] === `rival:${C.code}`, "removed: a node an expedition held did not go back to the robots, or another did");
  check(log.entries.length === 1 && log.entries[0].t === "taken" && log.next === 2, "removed: the log kept a line of a removed kind");
}

// --- retaken, and the log from the cursor
{
  await report(A, holdsWith({ supply: "own", quarry: "own", station: "own" }), 0, 5, T1);
  // Another player's hold comes only from a contested shore's mirror now.
  const st = islands.get(A.code)!;
  op(st, { t: "contestedMirror", shore: "station", owner: C.code, name: C.name, at: T1 + 1000 }, T1 + 1000);
  const cursor = st.seq - 1;
  const T4 = T1 + DAY;
  const stale = await report(A, holdsWith({ supply: "own", quarry: "own", station: "own" }), 0, 6, T4 - 1000);
  const staleStation = holdOf(A.code, "station");
  const badRetaken = await Promise.all([["nowhere"], ["quarry", "quarry"], "quarry", [...NODE_IDS, "quarry"]].map((x) => report(A, holdsWith({ supply: "own" }), 0, 6, T4 - 500, x)));
  console.log(`retaken: a stale report ${stale.status} (nothing named) left station ${staleStation}; malformed retaken -> ${badRetaken.map((b) => b.status).join()}`);
  check(staleStation === `rival:${C.code}`, "retaken: a report of another player's node as the owner's, not named as taken back, took it back");
  check(badRetaken.every((b) => b.status === 400), "retaken: a malformed list of nodes taken back was accepted");
  const r = await report(A, holdsWith({ supply: "own", quarry: "own", station: "own" }), 0, 7, T4, ["station"]);
  const log = await readLog(A.code, A.id, cursor, T4);
  const entries = log.body.entries as { seq: number; t: string; node: string; by: { code: string } }[];
  const other = await readLog(A.code, B.id, 0, T4);
  const bare = await readLog(A.code, null, 0, T4);
  const inUrl = await call("GET", `/api/islands/${A.code}/log?player=${A.id}`, undefined, T4);
  console.log(`log: no bearer ${bare.status} ${err(bare)}, the id in the URL only ${inUrl.status}, another player's read ${other.status}`);
  console.log(`retaken: report ${r.status}, station ${holdOf(A.code, "station")}; log after ${cursor}: ${JSON.stringify(entries.map((x) => `${x.t} ${x.node} by ${x.by.code}`))}`);
  check(bare.status === 401 && inUrl.status === 401 && other.status === 403, "log: the log was read without the owner's id as the bearer");
  check(r.status === 200 && holdOf(A.code, "station") === "own", "retaken: the owner's report did not take the station back");
  check(entries.length === 2 && entries.every((x) => x.seq > cursor) && entries[0].t === "taken" && entries[1].t === "retaken" && entries[1].by.code === C.code, "log: the entries after the cursor are not the new ones");
}

// --- public
{
  const g = await call("GET", `/api/islands/${A.code.toLowerCase()}`, undefined, T1 + 3 * DAY);
  const ids = [A.id, B.id, C.id].filter((id) => g.text.includes(id));
  const nodes = g.body.nodes as { id: string; hold: string; open: boolean }[];
  const young = op(island({ supply: "own" }, T1), { t: "view" }, T1 + 1000).body as { nodes: { id: string; open: boolean }[] };
  console.log(`public: ${g.status} ${g.text.slice(0, 160)}…; player ids in it: ${ids.length}; open ${nodes.filter((n) => n.open).map((n) => n.id).join()}`);
  check(g.status === 200 && ids.length === 0, "public: the island's view shows a player's id");
  check(nodes.every((n) => n.open === (n.hold === "own")) && nodes.some((n) => n.open), "public: the open nodes are not the holdings");
  check(young.nodes.every((n) => !n.open), "public: a protected island shows a holding open");
}

// --- stored: a read stores nothing; a report does
{
  const q = island({ supply: "own" });
  const read = op(q, { t: "view" }, T1 + DAY);
  const log = op(q, { t: "log", player: A.id, after: 0 }, T1 + 2 * DAY);
  const rep = op(q, { t: "report", player: A, retaken: [], holds: holdsWith({ supply: "own" }) as IslandState["holds"], factory: 0, day: 2 }, T1 + 2 * DAY);
  console.log(`stored: a view ${read.changed}, the log ${log.changed}, a report ${rep.changed}`);
  check(!read.changed && !log.changed && rep.changed, "stored: what an op stores is not what it changed");
}

// --- parcels, legacy holds, and the contested shores
{
  const padOk = parseParcels([{ poi: "pad", kind: "scrap", from: B }]);
  const nodeBad = parseParcels([{ poi: "not-a-poi", kind: "scrap", from: B }]);
  check(!!padOk && padOk.length === 1 && nodeBad === null, "parcels: pad depot refused or a bad poi accepted");
  check(DEPOT_POIS.includes("pad") && DEPOT_POIS.includes("supply"), "parcels: depot list misses pad or supply");
  const aidIsle = island({ quarry: "own", supply: "own" });
  op(aidIsle, { t: "aid", from: B, poi: "supply", kind: "scrap" }, T1);
  op(aidIsle, { t: "aid", from: B, poi: "pad", kind: "scrap" }, T1 + 1);
  console.log(`parcels: ${(aidIsle.parcels ?? []).length} left at depots; pad parse ${padOk?.length}`);
  check((aidIsle.parcels ?? []).length === 2, "aid: donation did not land on the island");

  // Legacy "held" / "freed" backward compatibility on PUT /api/islands/:code
  const T10 = T1 + 10 * DAY;
  const legacyHolds = NODE_IDS.map((id) => (id === "supply" ? "freed" : "held"));
  const legacyRep = await report(A, legacyHolds, 0, 41, T10, ["supply"]);
  check(legacyRep.status === 200, "legacy: report with freed/held refused");
  check(holdOf(A.code, "supply") === "own" && holdOf(A.code, "waterworks") === "foe", "legacy: freed/held not normalized to own/foe");

  // Durable Object / storage load: migrateIslandState normalizes legacy holds in place.
  const stored = migrateIslandState({
    holds: ["freed", "held", "rival:ABC123", "own", "foe"] as IslandState["holds"],
  } as IslandState);
  check(
    stored.holds[0] === "own" && stored.holds[1] === "foe" && stored.holds[2] === "rival:ABC123" && stored.holds[3] === "own" && stored.holds[4] === "foe",
    `legacy DO: migrateIslandState left ${JSON.stringify(stored.holds)}`,
  );
  check(Array.isArray(stored.shielded?.nodes), "legacy DO: migrateIslandState left no shielded");

  // Contested same-day shield + mirror (方向 A / TKT-195): station is a coastal contested hub.
  check(station >= 0 && NEIGHBOUR_SLOTS.some((s) => s.shore === "station"), "shield: station is not a contested shore");
  const shIsle = island({ station: "own", supply: "own", quarry: "own" });
  const shWin = op(shIsle, { t: "contestedMirror", shore: "station", owner: B.code, name: B.name, at: T1 }, T1);
  check(shWin.status === 200 && shIsle.holds[station] === `rival:${B.code}`, "shield: first take of station failed");
  check(!!shIsle.shielded?.nodes.includes(station), "shield: station not shielded after take");
  // Same UTC day: owner cannot retake via report.
  const shRetake = op(
    shIsle,
    { t: "report", player: A, retaken: ["station"], holds: holdsWith({ station: "own", supply: "own", quarry: "own" }) as IslandState["holds"], factory: 0, day: 50 },
    T1 + 2000,
  );
  check(shIsle.holds[station] === `rival:${B.code}` && ((shRetake.body as { shielded?: string[] }).shielded ?? []).includes("station"), "shield: same-day retake of station was allowed");
  // Next UTC day: retake ok.
  const nextDay = T1 + DAY + 1000;
  const shLater = op(
    shIsle,
    { t: "report", player: A, retaken: ["station"], holds: holdsWith({ station: "own", supply: "own", quarry: "own" }) as IslandState["holds"], factory: 0, day: 51 },
    nextDay,
  );
  check(shLater.status === 200 && shIsle.holds[station] === "own", "shield: next-day retake of station refused");
  // Contested take from foe (TKT-201): report returns contestedTaken with from: null.
  const foeIsle = island({ station: "foe", supply: "own" });
  const foeTake = op(
    foeIsle,
    { t: "report", player: A, retaken: ["station"], holds: holdsWith({ station: "own", supply: "own" }) as IslandState["holds"], factory: 0, day: 52 },
    nextDay + DAY,
  );
  check(foeTake.status === 200 && foeIsle.holds[station] === "own", "foe take: station not own");
  const foeBody = foeTake.body as { contestedTaken?: { shore: string; from: string | null }[] };
  check(
    (foeBody.contestedTaken ?? []).some((c) => c.shore === "station" && c.from === null),
    `foe take: contestedTaken missing station/null (${JSON.stringify(foeBody.contestedTaken)})`,
  );
  // Contested mirror: neighbour's facing shore becomes rival:owner (or own).
  const mir = island({ station: "own", supply: "own" });
  const mirSet = op(mir, { t: "contestedMirror", shore: "station", owner: B.code, name: B.name, at: T1 }, T1);
  check(mirSet.status === 200 && mir.holds[station] === `rival:${B.code}` && mir.shielded?.nodes.includes(station), "mirror: set rival hold failed");
  check(mir.log.some((e) => e.t === "taken" && e.by.code === B.code && e.by.name === B.name), "mirror: log missing attacker name");
  const mirAgain = op(mir, { t: "contestedMirror", shore: "station", owner: A.code, at: T1 + 1000 }, T1 + 1000);
  check(mirAgain.status === 409 && (mirAgain.body as { error?: string }).error === "shielded", "mirror: same-day flip was allowed");
  const mirFlip = op(mir, { t: "contestedMirror", shore: "station", owner: A.code, at: T1 + DAY }, T1 + DAY);
  check(mirFlip.status === 200 && mir.holds[station] === "own", "mirror: next-day flip to own refused");
  // 作り順②: an outer hub beyond the four sea-route faces mirrors by the same id.
  const power = NODE_IDS.indexOf("powerplant");
  check(power >= 0 && !NEIGHBOUR_SLOTS.some((s) => s.shore === "powerplant"), "outer: powerplant should be contested but not a sea-route face");
  const mirOuter = island({ powerplant: "own", supply: "own" });
  const mirOuterSet = op(mirOuter, { t: "contestedMirror", shore: "powerplant", owner: B.code, name: B.name, at: T1 }, T1);
  check(
    mirOuterSet.status === 200 && mirOuter.holds[power] === `rival:${B.code}` && mirOuter.shielded?.nodes.includes(power),
    "outer mirror: powerplant rival hold failed",
  );
  const foeOuter = island({ powerplant: "foe", supply: "own" });
  const foeOuterTake = op(
    foeOuter,
    { t: "report", player: A, retaken: ["powerplant"], holds: holdsWith({ powerplant: "own", supply: "own" }) as IslandState["holds"], factory: 0, day: 53 },
    nextDay + DAY * 2,
  );
  const foeOuterBody = foeOuterTake.body as { contestedTaken?: { shore: string; from: string | null }[] };
  check(
    foeOuterTake.status === 200 &&
      foeOuter.holds[power] === "own" &&
      (foeOuterBody.contestedTaken ?? []).some((c) => c.shore === "powerplant" && c.from === null),
    `outer foe take: ${JSON.stringify(foeOuterBody.contestedTaken)}`,
  );
  console.log(`shield: station shielded then retaken next day; mirror flip blocked same day`);

  // Contested defend notice (TKT-201): failed attack logs wiped with attacker name.
  const defIsle = island({ station: "own", supply: "own" });
  const def = op(defIsle, { t: "contestedDefend", shore: "station", from: { code: B.code, name: B.name }, at: T1 + 2 * DAY }, T1 + 2 * DAY);
  check(def.status === 200, "defend: contestedDefend refused");
  check(
    defIsle.log.some((e) => e.t === "wiped" && e.node === "station" && e.by.code === B.code && e.by.name === B.name),
    `defend: wiped log missing (${JSON.stringify(defIsle.log.slice(-1))})`,
  );
  console.log(`defend: ${B.name} failed → wiped log on defender`);
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("island server ok");
