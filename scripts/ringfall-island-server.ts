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
 * - **removed**: the routes of expeditions (遠征), look-marks and gifts of 島の守り (removed
 *   2026-11-28) answer 404, and an island stored with expeditions or another player's node on it
 *   loads without them, each such node back with the robots.
 * - **retaken**: a holding a sortie took stays the robots' through a report that still calls it the
 *   owner's, until the report names it among `retaken`; a malformed `retaken` is refused.
 * - **log**: the owner's log from a cursor holds only what came after it; nobody else reads it.
 * - **public**: what anyone reads of an island holds no player's id, and names as open only
 *   holdings a sortie could take.
 * - **stored**: a read stores nothing; a report does.
 * - **parcels**: 島の守り are left at depots by the owner's report, the pad's among them.
 *
 * Run alone: `npx tsx scripts/ringfall-island-server.ts`; it ends with "island server ok".
 */
import { readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { CLAIM_TRIES, handleApi, type ApiEnv, type Db, type DbStatement, type IslandNamespace } from "../worker/api";
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
  const ping = await call("POST", `/api/islands/${A.code}/pings`, { name: "x", x: 0, z: 0 }, T1, env, undefined, { authorization: `Bearer ${A.id}` });
  const aid = await call("POST", `/api/islands/${A.code}/aid`, { from, poi: "supply", kind: "scrap" }, T1);
  console.log(`removed: expeditions ${sent.status}, lease ${lease.status}, assault ${assault.status}, recall ${recall.status}, pings ${ping.status}, aid ${aid.status}`);
  check([sent, lease, assault, recall, ping, aid].every((r) => r.status === 404), "removed: a removed route still answers");
  const old = island({ supply: "own", quarry: `rival:${B.code}`, station: `rival:${C.code}` }) as IslandState & Record<string, unknown>;
  old.expeditions = [{ id: 3, by: { code: B.code, name: B.name }, target: NODE_IDS.indexOf("quarry"), units: [], sentAt: T0, arriveAt: T0, arrived: true, holding: true }];
  old.defenders = [];
  old.guards = NODE_IDS.map(() => null);
  old.meter = NODE_IDS.map(() => null);
  old.made = 0;
  old.clock = T0;
  old.lease = null;
  old.taken = { day: 0, n: 0 };
  old.pings = [{ id: 9, x: 0, z: 0, by: "x", until: T1 + DAY }];
  old.log = [
    { seq: 1, at: T0, t: "noticed", node: "quarry", by: { code: B.code, name: B.name } },
    { seq: 2, at: T0, t: "taken", node: "quarry", by: { code: B.code, name: B.name } },
  ] as unknown as IslandState["log"];
  old.seq = 2;
  const view = op(old, { t: "view" }, T1);
  const log = op(old, { t: "log", player: A.id, after: 0 }, T1).body as { entries: { t: string }[]; next: number };
  console.log(`removed: an old island's quarry ${old.holds[NODE_IDS.indexOf("quarry")]}, station ${old.holds[station]}, log ${log.entries.map((e) => e.t).join()} next ${log.next}`);
  check(view.status === 200 && !("expeditions" in old) && !("clock" in old) && !("pings" in old) && !("expeditions" in (view.body as object)), "removed: an old island kept its expeditions or look-marks");
  check(old.holds[NODE_IDS.indexOf("quarry")] === "foe" && old.holds[station] === "foe" && old.holds[NODE_IDS.indexOf("supply")] === "own", "removed: another player's node did not go back to the robots, or the owner's changed");
  check(log.entries.length === 1 && log.entries[0].t === "taken" && log.next === 2, "removed: the log kept a line of a removed kind");
}

// --- retaken, and the log from the cursor
{
  await report(A, holdsWith({ supply: "own", quarry: "own", station: "own" }), 0, 5, T1);
  // C's sortie takes A's station: it is the robots' on A's island, and A's log says who.
  const st = islands.get(A.code)!;
  const cursor = st.seq;
  const taken = op(st, { t: "raid", from: { code: C.code, name: C.name }, target: "station", captured: true, stars: 3 }, T1 + 1000);
  const T4 = T1 + DAY;
  const stale = await report(A, holdsWith({ supply: "own", quarry: "own", station: "own" }), 0, 6, T4 - 1000);
  const staleStation = holdOf(A.code, "station");
  const badRetaken = await Promise.all([["nowhere"], ["quarry", "quarry"], "quarry", [...NODE_IDS, "quarry"]].map((x) => report(A, holdsWith({ supply: "own" }), 0, 6, T4 - 500, x)));
  console.log(`retaken: taken ${taken.status}; a stale report ${stale.status} (nothing named) left station ${staleStation}; malformed retaken -> ${badRetaken.map((b) => b.status).join()}`);
  check(taken.status === 200 && staleStation === "foe", "retaken: a report from before the loss gave the holding back");
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
  check(entries.length === 1 && entries[0].seq > cursor && entries[0].t === "taken" && entries[0].by.code === C.code, "log: the entries after the cursor are not the new ones");
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

// --- parcels and legacy holds
{
  const padOk = parseParcels([{ poi: "pad", kind: "scrap", from: B }]);
  const nodeBad = parseParcels([{ poi: "not-a-poi", kind: "scrap", from: B }]);
  check(!!padOk && padOk.length === 1 && nodeBad === null, "parcels: pad depot refused or a bad poi accepted");
  check(DEPOT_POIS.includes("pad") && DEPOT_POIS.includes("supply"), "parcels: depot list misses pad or supply");
  const left = island({ quarry: "own", supply: "own" });
  const me = { code: left.owner.code, name: A.name };
  op(left, { t: "report", player: A, retaken: [], holds: holdsWith({ quarry: "own", supply: "own" }) as IslandState["holds"], factory: 0, day: 3, parcels: [{ id: 0, poi: "supply", kind: "scrap", from: me, at: 0 }, { id: 0, poi: "pad", kind: "scrap", from: me, at: 0 }] }, T1);
  console.log(`parcels: ${(left.parcels ?? []).length} left at depots; pad parse ${padOk?.length}`);
  check((left.parcels ?? []).length === 2, "parcels: what a report left is not on the island");

  // Legacy "held" / "freed" backward compatibility on PUT /api/islands/:code
  const T10 = T1 + 10 * DAY;
  const legacyHolds = NODE_IDS.map((id) => (id === "supply" ? "freed" : "held"));
  const legacyRep = await report(A, legacyHolds, 0, 41, T10, ["supply"]);
  check(legacyRep.status === 200, "legacy: report with freed/held refused");
  check(holdOf(A.code, "supply") === "own" && holdOf(A.code, "waterworks") === "foe", "legacy: freed/held not normalized to own/foe");

  // Durable Object / storage load: migrateIslandState normalizes legacy holds in place; another player's node goes back to the robots.
  const stored = migrateIslandState({
    holds: ["freed", "held", "rival:ABC123", "own", "foe"] as IslandState["holds"],
  } as IslandState);
  check(
    stored.holds[0] === "own" && stored.holds[1] === "foe" && stored.holds[2] === "foe" && stored.holds[3] === "own" && stored.holds[4] === "foe",
    `legacy DO: migrateIslandState left ${JSON.stringify(stored.holds)}`,
  );
  check(Array.isArray(stored.shielded?.nodes), "legacy DO: migrateIslandState left no shielded");
  console.log(`legacy: ${JSON.stringify(stored.holds)}`);
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("island server ok");
