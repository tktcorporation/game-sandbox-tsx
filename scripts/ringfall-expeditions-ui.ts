/**
 * The game's side of expeditions (docs/ringfall/multiplayer.md, 工場の遠征), on the pure rules of
 * src/ringfall/meta/expeditions.ts and the server's own answers (worker/island.ts):
 *
 * - **merge**: the server's holds come into the profile: another player's node it reports is theirs,
 *   a node the profile gave another player that the server does not is as the server has it, and the
 *   player's own nodes stay as the profile has them; nothing changed is the same object.
 * - **retaken**: the report names as taken back the nodes whose core the raid captured and the nodes
 *   another player held as it began that are the player's after it; a node the profile still calls
 *   its own after another player took it on the server is not named, so the report leaves it theirs.
 * - **log**: the log's entries after the last one taken in are news once, and the number moves on.
 * - **answers**: an island's view, its log and a report's holds as worker/island.ts answers them are
 *   read back; an expedition out takes the state its island shows, and one missing there is gone.
 * - **cost**: each expedition out takes one of the squads the factory keeps out: in the battle, a
 *   factory whose one squad is away sends none, and one with none away sends its squad.
 * - **income**: each node the expeditions hold pays `FRONT.income` at the settle, and those gone are dropped.
 * - **saves**: a v26 save loads as v27 with no expedition and no log read; a v27 save keeps both.
 * - **errors**: every error code the API can answer with has a line, and the Worker's sources use no other.
 *
 * Run alone: `npx tsx scripts/ringfall-expeditions-ui.ts`; it ends with "expeditions ui ok".
 */
import { readdirSync, readFileSync } from "node:fs";
import { FACTORY, FRONT } from "../src/ringfall/sim/config";
import { NODES } from "../src/ringfall/sim/map";
import { rivalHold } from "../src/ringfall/sim/holds";
import { idleInput, newRun, starterKit, type State } from "../src/ringfall/sim/state";
import { step } from "../src/ringfall/sim/step";
import { holds } from "../src/ringfall/meta/island";
import { newProfile, parseProfile, settle, type Profile } from "../src/ringfall/meta/profile";
import { API_ERRORS, ERROR_TEXT, errorText } from "../src/ringfall/meta/island-errors";
import { applySync, retakenNodes, awayIncome, canSend, factorySquads, homeSquads, logLine, mergeHolds, parseLog, parseOutgoing, parseView, refreshOutgoing, reportedHolds, reportHolds, squadsAway, type IslandLogEntry, type Outgoing } from "../src/ringfall/meta/expeditions";
import { EXPEDITION, islandOp, publicView, type IslandState } from "../worker/island";
import { handleApi } from "../worker/api";

const errors: string[] = [];
const check = (ok: boolean, what: string) => {
  if (!ok) errors.push(what);
};

const A = "K7M2QX";
const B = "Z3P9TR";
const ID_A = "7c9e6679-7425-40de-944b-e07fc1f0d3c4";
const ID_B = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";

/** A new profile with `freed` the player's and `rival` held by island `B`. */
function island(freed: string[], rival: string[] = []): Profile {
  const p = newProfile(3);
  const poiState = { ...p.poiState };
  for (const id of freed) poiState[id as keyof typeof poiState] = { state: "freed" };
  for (const id of rival) poiState[id as keyof typeof poiState] = { state: rivalHold(B) };
  return { ...p, poiState };
}

// --- merge
{
  const p = island(["supply", "quarry"], ["relay"]);
  const server = NODES.map((n) => ({ id: n.id, hold: n.id === "wreck" ? rivalHold(A) : "held" as const }));
  const m = mergeHolds(p.poiState, server);
  console.log(`merge: supply ${m.supply.state}, quarry ${m.quarry.state}, relay ${m.relay.state}, wreck ${m.wreck.state}, pad ${m.pad.state}`);
  check(m.supply.state === "freed" && m.quarry.state === "freed", "merge: the player's own nodes did not stay the player's");
  check(m.relay.state === "held", "merge: a node the server no longer gives another player stayed theirs");
  check(m.wreck.state === rivalHold(A), "merge: a node the server gives another player is not theirs");
  check(m.pad.state === "held", "merge: the titan's pad changed");
  check(mergeHolds(m, server) === m, "merge: a merge that changes nothing made a new island");
  check(p.poiState.relay.state === rivalHold(B), "merge: the profile's island was changed in place");
}

// --- retaken: what the report names, and what the server does with it
{
  const before = island(["supply", "quarry"], ["relay", "wreck"]);
  const after = island(["supply", "quarry", "relay", "station"], ["wreck"]);
  const named = retakenNodes(before, after, ["station"]);
  console.log(`retaken: named ${named.join()}`);
  check(named.join() === "relay,station", `retaken: the report names ${named.join()} as taken back, not the relay (another player's at the start) and the station (its core captured)`);
  // The server: island A's quarry another player's; a report from a profile that still calls it the owner's.
  const t0 = 1_700_000_000_000;
  const own = islandOp(null, { t: "claim", player: { id: ID_A, name: "わたし" }, code: A }, t0).state as IslandState;
  own.holds[NODES.findIndex((n) => n.id === "quarry")] = rivalHold(B);
  const stale = island(["supply", "quarry"]);
  const say = (retaken: string[]) => islandOp(own, { t: "report", player: { id: ID_A, name: "わたし" }, holds: reportHolds(stale), retaken, factory: 0, day: 2 }, t0 + 1000);
  const kept = reportedHolds(say(retakenNodes(stale, stale, [])).body)?.find((n) => n.id === "quarry")?.hold;
  const back = reportedHolds(say(["quarry"]).body)?.find((n) => n.id === "quarry")?.hold;
  console.log(`retaken: a stale profile's report leaves the quarry ${kept}; one naming it ${back}`);
  check(kept === rivalHold(B) && back === "freed", "retaken: the server's answer to a report does not follow what it names as taken back");
}

// --- log
{
  const by = { code: B, name: "となり" };
  const entries: IslandLogEntry[] = [
    { seq: 1, at: 1, t: "landed", node: "relay", by },
    { seq: 2, at: 2, t: "taken", node: "relay", by },
    { seq: 3, at: 3, t: "released", node: "relay", by },
  ];
  const p = { ...island(["supply"]), logSeq: 1 };
  const first = applySync(p, { log: { entries, next: 3 } });
  const again = applySync(first.profile, { log: { entries, next: 3 } });
  console.log(`log: news ${first.news.map((e) => e.seq).join()} -> "${first.news.map(logLine).join(" / ")}"; seq ${first.profile.logSeq}; again ${again.news.length}`);
  check(first.news.map((e) => e.seq).join() === "2,3" && first.profile.logSeq === 3, "log: the new entries were not taken once");
  check(again.news.length === 0 && again.profile === first.profile, "log: entries already taken in came again");
  for (const t of ["landed", "taken", "wiped", "retaken", "released"] as const) check(logLine({ seq: 1, at: 0, t, node: "relay", by }).includes(NODES.find((n) => n.id === "relay")!.name), `log: the line for ${t} does not name the node`);
}

// --- answers: the server's own state, read back
{
  const DAY = 86_400_000;
  const t0 = 1_700_000_000_000;
  const claim = (id: string, code: string) => islandOp(null, { t: "claim", player: { id, name: code === A ? "わたし" : "となり" }, code }, t0).state as IslandState;
  const a = claim(ID_A, A);
  const b = claim(ID_B, B);
  const p = island(["supply", "quarry"]);
  const rep = islandOp(a, { t: "report", player: { id: ID_A, name: "わたし" }, holds: reportHolds(p), retaken: [], factory: 2, day: 4 }, t0 + 1000);
  const back = reportedHolds(rep.body);
  check(!!back && back.find((n) => n.id === "supply")?.hold === "freed" && back.length === NODES.length, `answers: a report's holds read back as ${JSON.stringify(back)}`);
  const now = t0 + EXPEDITION.protectDays * DAY + 1000;
  const view = parseView(JSON.parse(JSON.stringify(publicView(a, now))));
  const open = view?.nodes.filter((n) => n.open).map((n) => n.id) ?? [];
  const sent = islandOp(a, { t: "expedition", from: { code: B, name: "となり" }, target: open[0], kinds: [...FACTORY.levels[1].kinds] }, now);
  const seen = parseView(JSON.parse(JSON.stringify(publicView(a, now + 1000))));
  const out: Outgoing[] = [
    { code: A, node: open[0] as Outgoing["node"], sentAt: now, id: (sent.body as { id: number }).id, units: 3, state: "coming" },
    { code: A, node: "wreck", sentAt: now, id: 99, units: 3, state: "attacking" },
    { code: "QQQQQQ", node: "yard", sentAt: now, id: 7, units: 3, state: "holding" },
  ];
  const fresh = refreshOutgoing(out, B, { [A]: seen, QQQQQQ: null });
  console.log(`answers: view of ${view?.code} by ${view?.owner}, ${open.length} nodes open; expedition ${sent.status}; out ${fresh.map((o) => `${o.node}:${o.state}`).join(" ")}`);
  check(!!view && view.code === A && view.owner === "わたし" && view.nodes.length === NODES.length && open.length > 0, "answers: an island's view did not read back");
  check(sent.status === 201 && !!seen && seen.expeditions.length === 1, "answers: the expedition sent is not in the view");
  check(fresh[0].state === "coming" && fresh[1].state === "gone" && fresh[2] === out[2], `answers: the expeditions out refreshed to ${JSON.stringify(fresh)}`);
  // The log: island A's owner reads the expedition's landing once it stands at its node.
  const logged = islandOp(a, { t: "log", player: ID_A, after: 0 }, now + EXPEDITION.arrive * 1000 + 60_000);
  const log = parseLog(JSON.parse(JSON.stringify(logged.body)));
  check(!!log && log.entries.some((e) => e.t === "landed" && e.by.code === B) && log.next >= 1, `answers: the log read back as ${JSON.stringify(log)}`);
  check(parseView({ ok: true, code: "nope" }) === null && parseLog({ entries: "x" }) === null && reportedHolds({ holds: [] }) === null, "answers: an unreadable answer was read");
  void b;
}

// --- cost
{
  const away = (n: number, state: Outgoing["state"] = "coming"): Outgoing[] => Array.from({ length: n }, (_, i) => ({ code: A, node: NODES[i].id, sentAt: 0, id: i + 1, units: 2, state }));
  const p0 = { ...island([]), factory: 2 };
  const p1 = { ...p0, expeditions: [...away(1), ...away(1, "gone")] };
  const p2 = { ...p0, expeditions: away(3) };
  console.log(`cost: factory Lv2 keeps ${factorySquads(p0)}; one away leaves ${homeSquads(p1)} (away ${squadsAway(p1)}), three leave ${homeSquads(p2)}; can send ${canSend(p1)} / ${canSend(p2)}`);
  check(squadsAway(p1) === 1 && homeSquads(p1) === factorySquads(p0) - 1 && homeSquads(p2) === 0 && canSend(p1) && !canSend(p2), "cost: the squads away are not taken from the factory's");
  // In the battle: a factory of level 0 keeps one squad out; with it away, none comes out.
  const squadsOut = (away: number) => {
    const s: State = newRun(9, starterKit(), "reservoir", { island: holds(island(["supply"])), battle: { factory: 0, ...(away ? { away } : {}) } });
    const b = s.battle!;
    b.made = [FACTORY.levels[0].every, -1e12, -1e12];
    for (let i = 0; i < 600; i++) step(s, idleInput(), false);
    return b.squads.filter((q) => q.side === 0 && q.task !== "post").length;
  };
  const none = squadsOut(0);
  const one = squadsOut(1);
  console.log(`cost: the battle's factory sends ${none} squad(s) with none away, ${one} with its one squad away`);
  check(none === 1 && one === 0, "cost: the battle's factory does not keep the squad away at home");
}

// --- income
{
  const base = island(["supply"]);
  const exps: Outgoing[] = [
    { code: A, node: "relay", sentAt: 0, id: 1, units: 2, state: "holding" },
    { code: A, node: "quarry", sentAt: 0, id: 2, units: 2, state: "coming" },
    { code: B, node: "wreck", sentAt: 0, id: 3, units: 2, state: "gone" },
  ];
  const s1 = newRun(5, starterKit(), "reservoir", { island: holds(base) });
  s1.outcome = "extracted";
  const s2 = newRun(5, starterKit(), "reservoir", { island: holds(base) });
  s2.outcome = "extracted";
  const plain = settle(base, s1);
  const away = settle({ ...base, expeditions: exps }, s2);
  console.log(`income: plain ${plain.profile.cash} (${JSON.stringify(plain.awayIncome)}), with a node held away ${away.profile.cash} (+${away.awayIncome}); expeditions kept ${away.profile.expeditions.map((e) => e.state).join()}`);
  check(awayIncome({ expeditions: exps }) === FRONT.income, "income: the nodes held away do not pay FRONT.income each");
  check(away.profile.cash - plain.profile.cash === FRONT.income && away.awayIncome === FRONT.income && plain.awayIncome === undefined, "income: the settle does not pay the nodes held away");
  check(away.profile.expeditions.map((e) => e.state).join() === "holding,coming", "income: the settle did not drop the expeditions gone");
}

// --- saves
{
  const p = { ...newProfile(4), expeditions: [{ code: A, node: "relay" as const, sentAt: 5, id: 2, units: 3, state: "holding" as const }], logSeq: 7 };
  const v27 = parseProfile(JSON.parse(JSON.stringify(p)));
  const v26 = parseProfile(JSON.parse(JSON.stringify({ ...p, v: 26 })));
  const bad = parseOutgoing([{ code: "lower1", node: "relay", sentAt: 0, id: 1, units: 1, state: "coming" }, { code: A, node: "nowhere", sentAt: 0, id: 1, units: 1, state: "coming" }, { code: A, node: "relay", sentAt: 0, id: 1, units: 1, state: "lost" }, "x"]);
  console.log(`saves: v27 keeps ${v27?.expeditions.length} expedition(s), seq ${v27?.logSeq}; v26 loads as v${v26?.v} with ${v26?.expeditions.length}, seq ${v26?.logSeq}; bad entries kept ${bad.length}`);
  check(v27?.v === 27 && JSON.stringify(v27.expeditions) === JSON.stringify(p.expeditions) && v27.logSeq === 7, "saves: a v27 save did not keep its expeditions and log number");
  check(v26?.v === 27 && v26.expeditions.length === 0 && v26.logSeq === 0, "saves: a v26 save did not load with no expedition and no log read");
  check(bad.length === 0, "saves: a malformed expedition was kept");
  check(newProfile(1).expeditions.length === 0 && newProfile(1).logSeq === 0, "saves: a new profile has expeditions or a log read");
}

// --- errors
{
  const missing = API_ERRORS.filter((e) => !ERROR_TEXT[e]?.trim());
  // Every literal error the Worker's sources write, beside the ones its types allow.
  const files = [...readdirSync(new URL("../worker/", import.meta.url)).map((f) => `../worker/${f}`), ...readdirSync(new URL("../islands/", import.meta.url)).map((f) => `../islands/${f}`)].filter((f) => f.endsWith(".ts"));
  const used = new Set<string>();
  for (const f of files) {
    const text = readFileSync(new URL(f, import.meta.url), "utf8");
    for (const m of text.matchAll(/fail\((?:\d+,\s*)?"([a-z-]+)"\)|error:\s*"([a-z-]+)"/g)) used.add(m[1] ?? m[2]);
  }
  const unknown = [...used].filter((e) => !(API_ERRORS as readonly string[]).includes(e));
  const none = await handleApi(new Request("https://x/api/islands", { method: "POST", body: "{}" }), {});
  const noneBody = (await none!.json()) as { error: string };
  console.log(`errors: ${API_ERRORS.length} codes, ${used.size} used in the Worker; no server answers ${none!.status} ${noneBody.error} -> "${errorText(noneBody.error)}"`);
  check(!missing.length, `errors: no line for ${missing.join(", ")}`);
  check(!unknown.length, `errors: the Worker answers with codes not listed: ${unknown.join(", ")}`);
  check(used.size >= 15, `errors: only ${used.size} codes found in the Worker's sources`);
  check(none!.status === 202 && errorText(noneBody.error) === "島のサーバーにつながっていません", "errors: the no-server answer does not read as no server");
  check(errorText("something-else") === ERROR_TEXT["bad-response"], "errors: an unknown code is not read as an unreadable answer");
}

if (errors.length) {
  for (const e of errors) console.error(e);
  process.exit(1);
}
console.log("expeditions ui ok");
