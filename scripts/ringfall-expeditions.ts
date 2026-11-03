/**
 * Expeditions on the server (worker/island.ts, worker/api.ts; docs/ringfall/multiplayer.md): the API
 * on a stand-in `ISLAND` namespace whose objects run the island's pure ops in memory, and the
 * island's alarm as `advance()`.
 *
 * - **table**: src/ringfall/meta/island-table.ts is what map.ts gives (`--write` rewrites it).
 * - **no island server**: without the binding, /api/islands/ answers 202 `no-island-server`.
 * - **codes**: a drawn code is six characters of Crockford base32; the identity keeps the one handed out.
 * - **claim**: the server hands out the code, drawing again past codes taken and giving up after
 *   `CLAIM_TRIES`; a report to an unclaimed code is 404, and only the owner's id reports to an island.
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
import { CLAIM_TRIES, handleApi, type ApiEnv, type IslandNamespace } from "../worker/api";
import { advance, EXPEDITION, islandOp, nextAlarm, NODE_IDS, type IslandOp, type IslandState } from "../worker/island";
import { CONQUEST, FACTORY, FACTORY_TOP } from "../src/ringfall/sim/config";
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
const holdsWith = (over: Record<string, string>) => NODE_IDS.map((id) => over[id] ?? "held");
const claimFor = (who: typeof A, now = T0, draw?: () => string) => call("POST", "/api/islands", { player: { id: who.id, name: who.name } }, now, env, draw);
const report = (who: typeof A, holds: string[], factory: number, day: number, now: number) => call("PUT", `/api/islands/${who.code}`, { player: { id: who.id, name: who.name }, holds, factory, day }, now);
/** The owner's log after `after`, read with `id` as the bearer (none for no header). */
const readLog = (code: string, id: string | null, after: number, now: number) => call("GET", `/api/islands/${code}/log?after=${after}`, undefined, now, env, undefined, id === null ? {} : { authorization: `Bearer ${id}` });
const send = (from: typeof A, to: string, target: string, units: number, now: number) => call("POST", `/api/islands/${to}/expeditions`, { from, target, units }, now);
const holdOf = (code: string, node: string) => islands.get(code)!.holds[NODE_IDS.indexOf(node)];
/** The island's alarms from `from` to `to`, every `EXPEDITION.alarmMs`, as IslandDO runs them. */
const alarms = (code: string, from: number, to: number) => {
  for (let t = from; t <= to; t += EXPEDITION.alarmMs) while (advance(islands.get(code)!, t).behind);
};

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
  const r = await report(A, holdsWith({ quarry: "freed", supply: "freed" }), 0, 3, T0);
  const other = await report({ ...B, code: A.code }, holdsWith({}), 0, 1, T0);
  const again = await report({ ...A, name: "ねこ2" }, holdsWith({ quarry: "freed", supply: "freed" }), 0, 4, T0 + 1000);
  const bad = await call("PUT", `/api/islands/${A.code}`, { player: A, holds: ["held"], factory: 0, day: 1 }, T0);
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
  // The name the request carries is ignored: others see the name B's own island keeps.
  const r = await send({ ...B, name: "なりすまし" }, A.code, "quarry", 7, T1);
  const view = await call("GET", `/api/islands/${A.code}`, undefined, T1 + 1000);
  const seen = (view.body.expeditions as { by: { name: string } }[])[0]?.by.name;
  console.log(`capture: the expedition sent as "なりすまし" shows as ${JSON.stringify(seen)}`);
  check(seen === B.name, "capture: the expedition took the name its request carried, not its island's");
  alarms(A.code, T1, T1 + (EXPEDITION.arrive + 300) * 1000);
  const s = islands.get(A.code)!;
  const log = await readLog(A.code, A.id, 0, T1 + (EXPEDITION.arrive + 300) * 1000);
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
  const log = await readLog(A.code, A.id, cursor, T4);
  const entries = log.body.entries as { seq: number; t: string; node: string; by: { code: string } }[];
  const other = await readLog(A.code, B.id, 0, T4);
  const bare = await readLog(A.code, null, 0, T4);
  const inUrl = await call("GET", `/api/islands/${A.code}/log?player=${A.id}`, undefined, T4);
  console.log(`log: no bearer ${bare.status} ${err(bare)}, the id in the URL only ${inUrl.status}`);
  check(bare.status === 401 && inUrl.status === 401, "log: the log was read without the owner's id as the bearer");
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
    let s = op(null, { t: "claim", player: A, code: A.code }, T0);
    s = op(s, { t: "report", player: A, holds: holdsWith({ quarry: "freed", supply: "freed" }) as IslandState["holds"], factory: 2, day: 1 }, T0);
    s = op(s, { t: "expedition", from: B, target: "quarry", kinds: [...FACTORY.levels[FACTORY_TOP].kinds] }, T1);
    return op(s, { t: "expedition", from: C, target: "relay", kinds: [...FACTORY.levels[4].kinds] }, T1);
  };
  const one = make();
  const many = make();
  const end = T1 + 3_600_000;
  while (advance(one, end).behind);
  for (let t = T1; t <= end; t += 7_919) advance(many, t);
  advance(many, end);
  const same = JSON.stringify(one) === JSON.stringify(many);
  console.log(`steady: quarry ${one.holds[NODE_IDS.indexOf("quarry")]}, relay ${one.holds[NODE_IDS.indexOf("relay")]}, ${one.expeditions.length} expeditions left; one alarm and many ${same ? "agree" : "differ"}`);
  check(same, "steady: the island reckoned in one alarm and in many differs");
}

// --- held back, the alarm, and what is stored: on the pure module
{
  const op = (st: IslandState | null, o: IslandOp, t: number) => islandOp(st, o, t);
  const island = (holds: Record<string, string>, factory: number) => {
    const st = op(null, { t: "claim", player: A, code: A.code }, T0).state!;
    op(st, { t: "report", player: A, holds: holdsWith(holds) as IslandState["holds"], factory, day: 1 }, T0);
    return st;
  };
  const run = (st: IslandState, to: number) => {
    while (advance(st, to).behind);
  };
  const quarry = NODE_IDS.indexOf("quarry");

  // Held back: the island has lost its day's nodes before the expedition stands at the owner's quarry.
  const st = island({ quarry: "freed", supply: "freed" }, 2);
  op(st, { t: "expedition", from: B, target: "quarry", kinds: [...FACTORY.levels[FACTORY_TOP].kinds] }, T1);
  st.taken = { day: Math.floor(T1 / DAY), n: EXPEDITION.perDay };
  const units = st.expeditions[0].units.map((u) => u.hp + u.shield).join(",");
  const late = T1 + (EXPEDITION.arrive + 900) * 1000;
  let sent = 0;
  for (let t = T1; t <= late; t += 1000) {
    advance(st, t);
    sent = Math.max(sent, st.defenders.length);
  }
  const kept = st.expeditions[0].units.map((u) => u.hp + u.shield).join(",") === units;
  const waits = nextAlarm(st, late);
  const nextDay = (Math.floor(late / DAY) + 1) * DAY;
  console.log(`held back: arrived ${st.expeditions[0].arrived}, units as sent ${kept}, the owner's squads out ${sent}, quarry ${st.holds[quarry]}; next alarm ${waits === null ? "none" : `${(waits - late) / 1000} s on`} (the next UTC day ${(nextDay - late) / 1000} s on)`);
  check(st.expeditions[0].arrived && kept && sent === 0 && st.holds[quarry] === "freed", "held back: an expedition held back by the day's limit was fought or fought at");
  check(waits === nextDay, "held back: the alarm does not wait for the next UTC day");
  run(st, nextDay + 600_000);
  const fought = st.expeditions.length === 0 || st.expeditions[0].units.map((u) => u.hp + u.shield).join(",") !== units || st.holds[quarry] !== "freed";
  console.log(`held back: the next day quarry ${st.holds[quarry]}, expedition ${st.expeditions[0] ? `${st.expeditions[0].units.length} left` : "gone"}`);
  check(fought, "held back: the expedition did not fight once the next UTC day came");

  // Held back at a node with turrets: when the next day comes, they stand at their posts again.
  {
    const lv = 3;
    const tt = island({ quarry: "freed", supply: "freed" }, lv);
    op(tt, { t: "expedition", from: B, target: "quarry", kinds: ["grunt", "heavy", "drone", "grunt"] }, T1);
    tt.taken = { day: Math.floor(T1 / DAY), n: EXPEDITION.perDay };
    const day2 = (Math.floor(T1 / DAY) + 1) * DAY;
    run(tt, day2 - 1000);
    const before = tt.defenders.filter((d) => d.task === "post").length;
    run(tt, day2 + 2000);
    const posted = tt.defenders.filter((d) => d.task === "post" || d.to === quarry).length;
    console.log(`held back at factory ${lv}: turrets out while held back ${before}, standing when it fights the next day ${tt.defenders.filter((d) => d.task === "post").length} of ${FACTORY.levels[lv].turrets}`);
    check(before === 0 && FACTORY.levels[lv].turrets > 0 && tt.defenders.filter((d) => d.task === "post").length === FACTORY.levels[lv].turrets && posted >= FACTORY.levels[lv].turrets, "held back: the turrets did not stand when the expedition fought the next day");
  }

  // The alarm off the tick grid: an expedition sent 400 ms past a tick rings the alarm at the tick that sees it arrive.
  {
    const g = island({ quarry: "freed", supply: "freed" }, 0);
    const sentAt = T1 + 400;
    op(g, { t: "expedition", from: B, target: "quarry", kinds: ["grunt"] }, sentAt);
    let now = sentAt + 3;
    let rings = 0;
    while (!g.expeditions[0].arrived && rings < 10) {
      now = nextAlarm(g, now)!;
      advance(g, now);
      rings++;
    }
    console.log(`alarm off the grid: arrived ${g.expeditions[0].arrived} after ${rings} rings, ${now - g.expeditions[0].arriveAt} ms after the arrival`);
    check(g.expeditions[0].arrived && rings <= 2 && now - g.expeditions[0].arriveAt < 1000, "alarm: an arrival off the tick grid rang the alarm again and again");
  }

  // The day's limit outlasts the log: wiped expeditions push the day's take out of the log, and it still counts.
  {
    const lim = island({ quarry: "freed", supply: "freed" }, 0);
    op(lim, { t: "expedition", from: B, target: "quarry", kinds: [...FACTORY.levels[FACTORY_TOP].kinds] }, T1);
    run(lim, T1 + 3_600_000);
    for (let k = 0; k < EXPEDITION.logMax; k++) lim.log.push({ seq: ++lim.seq, at: T1 + 3_600_000, t: "wiped", node: "relay", by: C });
    lim.log.splice(0, lim.log.length - EXPEDITION.logMax);
    const takes = lim.log.filter((e) => e.t === "taken").length;
    const r1 = op(lim, { t: "expedition", from: C, target: "station", kinds: ["grunt"] }, T1 + 3_600_000);
    const r2 = op(lim, { t: "expedition", from: C, target: "relay", kinds: ["grunt"] }, T1 + 3_600_000);
    console.log(`day's limit: took the quarry ${lim.holds[quarry] === `rival:${B.code}`}, "taken" left in the log ${takes}, another ${r1.status}, a third ${r2.status} ${(r2.body as { error?: string }).error}`);
    check(lim.holds[quarry] === `rival:${B.code}` && takes === 0 && r1.status === 201 && r2.status === 409, "day's limit: the day's take was forgotten with the log");
  }

  // Two captures on one tick, with one node left of the day's limit: only one is taken.
  {
    const two = island({ quarry: "held", station: "held" }, 0);
    op(two, { t: "expedition", from: B, target: "quarry", kinds: ["grunt"] }, T1);
    op(two, { t: "expedition", from: C, target: "station", kinds: ["grunt"] }, T1);
    run(two, two.expeditions[0].arriveAt + 1000);
    // Both garrisons gone at once, so both meters fill on the same ticks.
    const qi = NODE_IDS.indexOf("quarry");
    const si = NODE_IDS.indexOf("station");
    two.guards[qi] = [];
    two.guards[si] = [];
    // Both accepted while the day had room; another node lost since leaves one of the day's limit.
    two.taken = { day: Math.floor(T1 / DAY), n: EXPEDITION.perDay - 1 };
    // Both meters one tick short of a capture, so both seize on the next tick.
    const almost = CONQUEST.capture - CONQUEST.tick / 2;
    two.meter[qi] = { side: 3, t: almost, owner: B.code };
    two.meter[si] = { side: 3, t: almost, owner: C.code };
    run(two, two.clock + 1000);
    const rivals = [qi, si].filter((i) => two.holds[i].startsWith("rival:")).length;
    console.log(`same tick: ${rivals} of 2 taken with ${EXPEDITION.perDay - 1} left of the day's limit; counted ${two.taken.n}`);
    check(rivals === 1 && two.taken.n === EXPEDITION.perDay, "same tick: captures on one tick went past the day's limit");
  }

  // The alarm: armed while an expedition comes or fights, none once every expedition just holds its node.
  const h = island({ quarry: "freed", supply: "freed" }, 0);
  op(h, { t: "expedition", from: B, target: "quarry", kinds: [...FACTORY.levels[FACTORY_TOP].kinds] }, T1);
  const coming = nextAlarm(h, T1 + 1000);
  run(h, T1 + 3_600_000);
  const after = nextAlarm(h, T1 + 3_600_000);
  console.log(`alarm: while coming ${coming === null ? "none" : `${(coming - T1 - 1000) / 1000} s on`}; holding (${h.expeditions.map((e) => e.holding).join(",")}) ${after === null ? "none" : "armed"}`);
  check(coming === h.expeditions[0].arriveAt && h.expeditions.every((e) => e.holding) && after === null, "alarm: an island whose expeditions all hold their nodes keeps an alarm");

  // Stored: a read of an island where nothing happened changes nothing; a report and a reckoned tick do.
  const q = island({ supply: "freed" }, 0);
  const read = op(q, { t: "view" }, T1 + DAY);
  const log = op(q, { t: "log", player: A.id, after: 0 }, T1 + 2 * DAY);
  const rep = op(q, { t: "report", player: A, holds: holdsWith({ supply: "freed" }) as IslandState["holds"], factory: 0, day: 2 }, T1 + 2 * DAY);
  const moved = op(h, { t: "view" }, T1 + 3_600_000 + 5000);
  op(q, { t: "expedition", from: B, target: "quarry", kinds: ["grunt"] }, T1 + 2 * DAY);
  const ticking = op(q, { t: "view" }, T1 + 2 * DAY + (EXPEDITION.arrive + 5) * 1000);
  console.log(`stored: a quiet view ${read.changed}, the log ${log.changed}, a report ${rep.changed}, a view of an island of holders ${moved.changed}, a view over a fight ${ticking.changed}`);
  check(!read.changed && !log.changed && rep.changed && !moved.changed && ticking.changed, "stored: what an op stores is not what it changed");
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("expeditions ok");
