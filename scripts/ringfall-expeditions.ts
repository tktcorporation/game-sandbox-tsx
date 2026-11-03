/**
 * Expeditions on the server (worker/island.ts, worker/api.ts; docs/ringfall/multiplayer.md): the API
 * on a stand-in `ISLAND` namespace whose objects run the island's pure ops in memory, and the
 * island's alarm as `advance()`.
 *
 * - **table**: src/ringfall/meta/island-table.ts is what map.ts gives (`--write` rewrites it).
 * - **no island server**: without the binding, /api/islands/ answers 202 `no-island-server`.
 * - **claim**: an owner's first report claims a code; another player's report to it is refused.
 * - **refused**: an expedition to the sender's own island, to the titan's pad, to the node next to
 *   the camp, to an island still protected, past the island's or the day's limit, with more units
 *   than the sender's factory makes, or from a sender who does not own the island they name.
 * - **capture**: an expedition takes a node of the owner's the factory barely defends, and one of
 *   the enemy's lightly garrisoned; the reports after keep them the other player's.
 * - **wiped**: a small expedition against a strong garrison is wiped out.
 * - **retaken**: the owner's report of a node of theirs taken back makes it theirs and logs it.
 * - **log**: the owner's log from a cursor holds only what came after it; nobody else reads it.
 * - **public**: what anyone reads of an island holds no player's id.
 * - **steady**: the island reckoned in one alarm or in many small ones ends the same.
 *
 * Run alone: `npx tsx scripts/ringfall-expeditions.ts`; it ends with "expeditions ok".
 */
import { readFileSync, writeFileSync } from "node:fs";
import { handleApi, type ApiEnv, type IslandNamespace } from "../worker/api";
import { advance, EXPEDITION, islandOp, NODE_IDS, type IslandOp, type IslandState } from "../worker/island";
import { FACTORY, FACTORY_TOP } from "../src/ringfall/sim/config";
import { isIslandCode, newIslandCode } from "../src/ringfall/meta/island-code";
import { loadIdentity, parseIdentity } from "../src/ringfall/meta/identity";
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

// --- island codes and the identity's code
{
  const codes = Array.from({ length: 200 }, newIslandCode);
  const id = "7c9e6679-7425-40de-944b-e07fc1f0d3c4";
  const old = parseIdentity({ id, name: "ねこ" });
  const kept = parseIdentity({ id, name: "ねこ", code: "K7M2QX" });
  const me = loadIdentity();
  console.log(`codes: ${codes.slice(0, 4).join(" ")}; identity without a code gets ${old?.code}, one with keeps ${kept?.code}; this page ${me.code}`);
  check(codes.every(isIslandCode) && !codes.some((c) => /[ILOU]/.test(c)), "codes: a new code is not 6 characters of Crockford base32");
  check(!!old && isIslandCode(old.code) && kept?.code === "K7M2QX" && loadIdentity().code === me.code && isIslandCode(me.code), "codes: the identity's code is missing or changes");
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
const A = { id: "0f8fad5b-d9cb-469f-a165-70867728950e", name: "ねこ", code: "N3K0AA" };
const B = { id: "7c9e6679-7425-40de-944b-e07fc1f0d3c4", name: "いぬ", code: "D0GB2Z" };
const C = { id: "16fd2706-8baf-433b-82eb-8c7fada847da", name: "とり", code: "T0R1QQ" };
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 1, 3);

async function call(method: string, path: string, body?: unknown, now = T0, e: ApiEnv = env) {
  const req = new Request(BASE + path, body === undefined ? { method } : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const res = await handleApi(req, e, now);
  if (!res) return { status: 0, body: {} as Record<string, unknown>, text: "" };
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) as Record<string, unknown>, text };
}
const err = (r: { body: Record<string, unknown> }) => r.body.error;
const holdsWith = (over: Record<string, string>) => NODE_IDS.map((id) => over[id] ?? "held");
const report = (who: typeof A, holds: string[], factory: number, day: number, now: number) => call("PUT", `/api/islands/${who.code}`, { player: { id: who.id, name: who.name }, holds, factory, day }, now);
const send = (from: typeof A, to: string, target: string, units: number, now: number) => call("POST", `/api/islands/${to}/expeditions`, { from, target, units }, now);
const holdOf = (code: string, node: string) => islands.get(code)!.holds[NODE_IDS.indexOf(node)];
/** The island's alarms from `from` to `to`, every `EXPEDITION.alarmMs`, as IslandDO runs them. */
const alarms = (code: string, from: number, to: number) => {
  for (let t = from; t <= to; t += EXPEDITION.alarmMs) while (advance(islands.get(code)!, t));
};

// --- no island server
{
  const g = await call("GET", `/api/islands/${A.code}`, undefined, T0, {});
  const p = await call("PUT", `/api/islands/${A.code}`, { player: A, holds: holdsWith({}), factory: 0, day: 1 }, T0, {});
  console.log(`no island server: GET ${g.status} ${g.text}; PUT ${p.status}`);
  check(g.status === 202 && err(g) === "no-island-server" && p.status === 202, "no island server: /api/islands/ did not answer 202 no-island-server");
}

// --- claim
{
  const a = await report(A, holdsWith({ quarry: "freed", supply: "freed" }), 0, 3, T0);
  const b = await report({ ...B, code: A.code }, holdsWith({}), 0, 1, T0);
  const again = await report({ ...A, name: "ねこ2" }, holdsWith({ quarry: "freed", supply: "freed" }), 0, 4, T0 + 1000);
  const bad = await call("PUT", `/api/islands/${A.code}`, { player: A, holds: ["held"], factory: 0, day: 1 }, T0);
  console.log(`claim: first ${a.status}, another player ${b.status} ${err(b)}, the owner again ${again.status}, short holds ${bad.status}`);
  check(a.status === 201 && b.status === 403 && err(b) === "not-owner" && again.status === 200 && bad.status === 400, "claim: the code was not claimed by the first report alone");
  await report(B, holdsWith({}), FACTORY_TOP, 9, T0);
  await report(C, holdsWith({}), 4, 2, T0);
}

// --- refused
const T1 = T0 + EXPEDITION.protectDays * DAY + 1000;
{
  const cases: [string, Promise<{ status: number; body: Record<string, unknown> }>, number, string][] = [
    ["protected", send(B, A.code, "quarry", 7, T0 + DAY), 403, "protected"],
    ["own island", send(A, A.code, "quarry", 2, T1), 403, "own-island"],
    ["the titan's pad", send(B, A.code, "pad", 7, T1), 403, "closed-node"],
    ["next to the camp", send(B, A.code, "supply", 7, T1), 403, "closed-node"],
    ["unknown node", send(B, A.code, "moon", 7, T1), 400, "bad-request"],
    ["more units than the factory makes", send(C, A.code, "quarry", FACTORY.levels[4].kinds.length + 1, T1), 400, "too-many-units"],
    ["sender not the owner of their code", send({ ...C, id: B.id }, A.code, "quarry", 2, T1), 403, "not-owner"],
    ["sender with no island", send({ ...C, code: "ZZZZZZ" }, A.code, "quarry", 2, T1), 403, "no-own-island"],
    ["no island there", send(B, "QQQQQQ", "quarry", 2, T1), 404, "no-island"],
  ];
  for (const [what, p, status, error] of cases) {
    const r = await p;
    console.log(`refused: ${what} -> ${r.status} ${err(r)}`);
    check(r.status === status && err(r) === error, `refused: ${what} answered ${r.status} ${err(r)}, not ${status} ${error}`);
  }
  check(islands.get(A.code)!.expeditions.length === 0, "refused: a refused expedition was kept");
}

// --- capture: the owner's quarry (factory 0: one squad of two grunts) by B's whole squad
let cursor = 0;
{
  const r = await send(B, A.code, "quarry", 7, T1);
  const view = await call("GET", `/api/islands/${A.code}`, undefined, T1 + 1000);
  alarms(A.code, T1, T1 + (EXPEDITION.arrive + 300) * 1000);
  const s = islands.get(A.code)!;
  const log = await call("GET", `/api/islands/${A.code}/log?player=${A.id}`, undefined, T1 + (EXPEDITION.arrive + 300) * 1000);
  cursor = log.body.next as number;
  const e = s.expeditions[0];
  console.log(`capture: sent ${r.status} ${r.text}; quarry ${holdOf(A.code, "quarry")}, expedition ${e ? `${e.units.length} left, holding ${e.holding}` : "gone"}; log ${JSON.stringify((log.body.entries as { t: string; node: string }[]).map((x) => `${x.t} ${x.node}`))}`);
  check(r.status === 201, "capture: the expedition was not accepted");
  check(view.text.includes('"state":"coming"'), "capture: the island's view does not show the expedition coming");
  check(holdOf(A.code, "quarry") === `rival:${B.code}` && !!e?.holding, "capture: the expedition did not take the quarry");
  // The owner's report cannot give the quarry back: it stays B's.
  const back = await report(A, holdsWith({ supply: "freed", quarry: "held" }), 0, 5, T1 + 400_000);
  console.log(`capture: the owner's report of the quarry as the enemy's -> ${back.status}, quarry ${holdOf(A.code, "quarry")}`);
  check(holdOf(A.code, "quarry") === `rival:${B.code}`, "capture: the owner's report erased a node given to another player");
}

// --- the day's limit, the island's limit, and a lightly garrisoned node of the enemy's
const T2 = T1 + 400_000;
{
  const st = await send(C, A.code, "station", FACTORY.levels[4].kinds.length, T2);
  const day = await send(B, A.code, "relay", 7, T2);
  console.log(`limits: station ${st.status}; a third the same day -> ${day.status} ${err(day)}`);
  check(st.status === 201 && day.status === 409 && err(day) === "day-limit", "limits: the day's limit was not kept");
  alarms(A.code, T2, T2 + (EXPEDITION.arrive + 600) * 1000);
  const T3 = T2 + DAY;
  const r = await send(B, A.code, "robotworks", 2, T3);
  const full = await send(B, A.code, "relay", 7, T3);
  console.log(`limits: station ${holdOf(A.code, "station")}; next day robotworks ${r.status}, a fourth -> ${full.status} ${err(full)}`);
  check(holdOf(A.code, "station") === `rival:${C.code}`, "capture: C's expedition did not take the lightly garrisoned station");
  check(r.status === 201 && full.status === 409 && err(full) === "island-full", "limits: the island's limit was not kept");
  // --- wiped: two grunts against the robot works' garrison
  alarms(A.code, T3, T3 + (EXPEDITION.arrive + 600) * 1000);
  const s = islands.get(A.code)!;
  const left = s.expeditions.find((e) => e.target === NODE_IDS.indexOf("robotworks"));
  const guards = s.guards[NODE_IDS.indexOf("robotworks")];
  console.log(`wiped: robotworks ${holdOf(A.code, "robotworks")}, expedition ${left ? "still there" : "gone"}, garrison ${guards?.length} of 10 standing`);
  check(!left && holdOf(A.code, "robotworks") === "held", "wiped: the small expedition was not wiped out by the strong garrison");
}

// --- retaken, and the log from the cursor
{
  const T4 = T1 + 3 * DAY;
  const r = await report(A, holdsWith({ supply: "freed", quarry: "freed" }), 0, 7, T4);
  const log = await call("GET", `/api/islands/${A.code}/log?player=${A.id}&after=${cursor}`, undefined, T4);
  const entries = log.body.entries as { seq: number; t: string; node: string; by: { code: string } }[];
  const other = await call("GET", `/api/islands/${A.code}/log?player=${B.id}`, undefined, T4);
  console.log(`retaken: report ${r.status}, quarry ${holdOf(A.code, "quarry")}, station ${holdOf(A.code, "station")}; log after ${cursor}: ${JSON.stringify(entries.map((x) => `${x.t} ${x.node} by ${x.by.code}`))}; another player's read ${other.status}`);
  check(holdOf(A.code, "quarry") === "freed" && !islands.get(A.code)!.expeditions.some((e) => e.by.code === B.code && e.target === NODE_IDS.indexOf("quarry")), "retaken: the owner's report did not take the quarry back");
  check(holdOf(A.code, "station") === `rival:${C.code}`, "retaken: a node the owner did not take back changed hands");
  check(entries.every((x) => x.seq > cursor) && entries.some((x) => x.t === "retaken" && x.node === "quarry") && entries.some((x) => x.t === "taken" && x.node === "station") && entries.some((x) => x.t === "wiped" && x.node === "robotworks"), "log: the entries after the cursor are not the new ones");
  check(!entries.some((x) => x.t === "taken" && x.node === "quarry"), "log: an entry before the cursor came again");
  check(other.status === 403, "log: another player read the owner's log");
}

// --- public
{
  const g = await call("GET", `/api/islands/${A.code.toLowerCase()}`, undefined, T1 + 3 * DAY);
  const ids = [A.id, B.id, C.id].filter((id) => g.text.includes(id));
  console.log(`public: ${g.status} ${g.text.slice(0, 160)}…; player ids in it: ${ids.length}`);
  check(g.status === 200 && ids.length === 0 && (g.body.nodes as { id: string; open: boolean }[]).find((n) => n.id === "supply")?.open === false, "public: the island's view shows a player's id or opens the camp's node");
}

// --- steady: one alarm or many
{
  const op = (s: IslandState | null, o: IslandOp, t: number) => islandOp(s, o, t).state!;
  const make = () => {
    let s = op(null, { t: "report", player: A, code: A.code, holds: holdsWith({ quarry: "freed", supply: "freed" }) as IslandState["holds"], factory: 2, day: 1 }, T0);
    s = op(s, { t: "expedition", from: B, target: "quarry", kinds: [...FACTORY.levels[FACTORY_TOP].kinds] }, T1);
    return op(s, { t: "expedition", from: C, target: "relay", kinds: [...FACTORY.levels[4].kinds] }, T1);
  };
  const one = make();
  const many = make();
  const end = T1 + 3_600_000;
  while (advance(one, end));
  for (let t = T1; t <= end; t += 7_919) advance(many, t);
  advance(many, end);
  const same = JSON.stringify(one) === JSON.stringify(many);
  console.log(`steady: quarry ${one.holds[NODE_IDS.indexOf("quarry")]}, relay ${one.holds[NODE_IDS.indexOf("relay")]}, ${one.expeditions.length} expeditions left; one alarm and many ${same ? "agree" : "differ"}`);
  check(same, "steady: the island reckoned in one alarm and in many differs");
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("expeditions ok");
