/**
 * The game's side of the island server (docs/ringfall/multiplayer.md), on the pure rules of
 * src/ringfall/meta/island-sync.ts and the server's own answers (worker/island.ts):
 *
 * - **merge**: the server's holds come into the profile: another player's node it reports is theirs,
 *   a node the profile gave another player that the server does not is as the server has it, and the
 *   player's own nodes stay as the profile has them; nothing changed is the same object.
 * - **retaken**: the report names as taken back the nodes whose core the raid captured and the nodes
 *   another player held as it began that are the player's after it; a node the profile still calls
 *   its own after another player took it on the server is not named, so the report leaves it theirs.
 *   The settle keeps them pending (`Profile.retaken`) by the island the raid started with, so a sync
 *   that merged another player's hold mid-raid cannot make the report name that node.
 * - **pending**: after a failed report a sync keeps a node taken back the player's and pending; the
 *   next report names it, takes it back on the server, and its answer clears it.
 * - **log**: the log's entries after the last one taken in are news once, and the number moves on;
 *   a line of a kind since removed (遠征) is left out.
 * - **answers**: an island's view, its log and a report's holds as worker/island.ts answers them are
 *   read back.
 * - **saves**: a current save keeps its log position and pending retakes; older ones drop what was
 *   removed (`expeditions`, `incoming`, `team`).
 * - **errors**: every error code the API can answer with has a line, and the Worker's sources use no other.
 *
 * Run alone: `npx tsx scripts/ringfall-island-sync.ts`; it ends with "island sync ok".
 */
import { readdirSync, readFileSync } from "node:fs";
import { FACTORY_TOP } from "../src/ringfall/sim/config";
import { finishBattle } from "../src/ringfall/sim/battle";
import { NODES } from "../src/ringfall/sim/map";
import { rivalHold } from "../src/ringfall/sim/holds";
import { newRun, starterKit } from "../src/ringfall/sim/state";
import { blankIsland, holds } from "../src/ringfall/meta/island";
import { newProfile, parseProfile, settle, type Profile } from "../src/ringfall/meta/profile";
import { API_ERRORS, ERROR_TEXT, errorText } from "../src/ringfall/meta/island-errors";
import { applySync, logLine, mergeHolds, parseLog, parseView, reportedHolds, reportHolds, retakenNodes, type IslandLogEntry } from "../src/ringfall/meta/island-sync";
import { islandOp, publicView, type IslandState } from "../worker/island";
import { handleApi } from "../worker/api";
import { readView, takeReport, takeSync } from "../src/ringfall/island-net";

const errors: string[] = [];
const check = (ok: boolean, what: string) => {
  if (!ok) errors.push(what);
};

const A = "K7M2QX";
const B = "Z3P9TR";
const ID_A = "7c9e6679-7425-40de-944b-e07fc1f0d3c4";
const ID_B = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";

/** A new profile with `freed` the player's and `rival` held by island `B` (blank base — no starting shores). */
function island(freed: string[], rival: string[] = []): Profile {
  const p = newProfile(3);
  const poiState = { ...blankIsland() };
  for (const id of freed) poiState[id as keyof typeof poiState] = { state: "own" };
  for (const id of rival) poiState[id as keyof typeof poiState] = { state: rivalHold(B) };
  return { ...p, poiState };
}

// --- merge
{
  const p = island(["supply", "quarry"], ["relay"]);
  const server = NODES.map((n) => ({ id: n.id, hold: n.id === "wreck" ? rivalHold(A) : "foe" as const }));
  const m = mergeHolds(p.poiState, server);
  console.log(`merge: supply ${m.supply.state}, quarry ${m.quarry.state}, relay ${m.relay.state}, wreck ${m.wreck.state}, pad ${m.pad.state}`);
  check(m.supply.state === "own" && m.quarry.state === "own", "merge: the player's own nodes did not stay the player's");
  check(m.relay.state === "foe", "merge: a node the server no longer gives another player stayed theirs");
  check(m.wreck.state === rivalHold(A), "merge: a node the server gives another player is not theirs");
  check(m.pad.state === "foe", "merge: the titan's pad changed");
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
  check(kept === rivalHold(B) && back === "own", "retaken: the server's answer to a report does not follow what it names as taken back");
}

// --- retaken at the settle: by the island the raid started with
{
  // A raid whose core capture of the relay, another player's at its start, takes it back.
  const start = island(["supply"], ["relay"]);
  const s = newRun(5, starterKit(), "reservoir", { island: holds(start) });
  s.stats.captured = ["relay"];
  s.outcome = "extracted";
  const won = settle(start, s);
  // A raid that started with the quarry the player's; mid-raid a sync gave the profile the quarry as another player's.
  const stale = island(["supply", "quarry"]);
  // End the unattended battle where it stands. This tests the settle's comparison to the
  // raid-start snapshot, independent of later combat or balance changes at the quarry.
  const b = newRun(7, starterKit(), "reservoir", { island: holds(stale), battle: { factory: FACTORY_TOP } });
  b.outcome = "extracted";
  if (!b.battle) throw new Error("retaken fixture: expected a battle");
  b.battle.end = b.battle.now;
  finishBattle(b);
  const merged = { ...stale, poiState: { ...stale.poiState, quarry: { state: rivalHold(B) } } };
  const mid = settle(merged, b);
  const naive = retakenNodes(merged, mid.profile, []);
  console.log(`retaken at the settle: a captured relay -> pending ${won.profile.retaken.join() || "none"}; mid-raid merge: quarry after ${mid.profile.poiState.quarry.state}, pending ${mid.profile.retaken.join() || "none"} (by the profile at the settle it would be ${naive.join() || "none"})`);
  check(won.profile.retaken.join() === "relay" && won.profile.poiState.relay.state === "own", "retaken at the settle: the relay taken back is not pending");
  check(mid.profile.poiState.quarry.state === "own" && naive.includes("quarry"), "retaken at the settle: the mid-raid case does not end with the quarry the player's (the check below would prove nothing)");
  check(!mid.profile.retaken.includes("quarry"), "retaken at the settle: a sync during the raid made the report name a node that was the player's at its start");
  check(settle(won.profile, newRun(7, starterKit(), "reservoir", { island: holds(won.profile) })).profile.retaken.join() === "relay", "retaken at the settle: a pending node was dropped by the next settle");
}

// --- pending: a failed report, a panel sync, then a report that lands
{
  const t0 = 1_700_000_000_000;
  const own = islandOp(null, { t: "claim", player: { id: ID_A, name: "わたし" }, code: A }, t0).state as IslandState;
  const Q = NODES.findIndex((n) => n.id === "quarry");
  own.holds[Q] = rivalHold(B);
  // The raid took the quarry back; its report failed, so the server still gives it to B.
  const p = { ...island(["supply", "quarry"]), retaken: ["quarry" as const] };
  const panel = applySync(p, { holds: parseView(JSON.parse(JSON.stringify(publicView(own, t0 + 1000))))!.nodes });
  const rep = islandOp(own, { t: "report", player: { id: ID_A, name: "わたし" }, holds: reportHolds(panel.profile), retaken: [...panel.profile.retaken], factory: 0, day: 2 }, t0 + 2000);
  const landed = applySync(panel.profile, { reported: [...panel.profile.retaken], holds: reportedHolds(rep.body)! });
  console.log(`pending: after a failed report a panel sync leaves the quarry ${panel.profile.poiState.quarry.state}, pending ${panel.profile.retaken.join()}; the next report ${rep.status} -> server ${own.holds[Q]}, pending ${landed.profile.retaken.join() || "none"}`);
  check(panel.profile.poiState.quarry.state === "own" && panel.profile.retaken.join() === "quarry", "pending: a sync turned a node taken back, its report not landed, back to another player's");
  check(rep.status === 200 && own.holds[Q] === "own", "pending: the next report did not take the pending node back on the server");
  check(landed.profile.retaken.length === 0 && landed.profile.poiState.quarry.state === "own", "pending: the report's answer did not clear the pending node");
}

// --- log
{
  const by = { code: B, name: "となり" };
  const entries: IslandLogEntry[] = [
    { seq: 1, at: 1, t: "wiped", node: "relay", by },
    { seq: 2, at: 2, t: "taken", node: "relay", by, stars: 3 },
    { seq: 3, at: 3, t: "retaken", node: "relay", by },
  ];
  const p = { ...island(["supply"]), logSeq: 1 };
  const first = applySync(p, { log: { entries, next: 3 } });
  const again = applySync(first.profile, { log: { entries, next: 3 } });
  console.log(`log: news ${first.news.map((e) => e.seq).join()} -> "${first.news.map(logLine).join(" / ")}"; seq ${first.profile.logSeq}; again ${again.news.length}`);
  check(first.news.map((e) => e.seq).join() === "2,3" && first.profile.logSeq === 3, "log: the new entries were not taken once");
  check(again.news.length === 0 && again.profile === first.profile, "log: entries already taken in came again");
  for (const t of ["taken", "wiped", "retaken"] as const) check(logLine({ seq: 1, at: 0, t, node: "relay", by }).includes(NODES.find((n) => n.id === "relay")!.name), `log: the line for ${t} does not name the node`);
  // A line of a kind the game no longer has (an expedition's) is left out; the number still moves on.
  const old = parseLog({ entries: [{ seq: 4, at: 4, t: "landed", node: "relay", by }, { seq: 5, at: 5, t: "wiped", node: "relay", by }], next: 5 });
  check(old?.entries.map((e) => e.seq).join() === "5" && old.next === 5, `log: a removed kind read back as ${JSON.stringify(old)}`);
}

// --- answers: the server's own state, read back
{
  const DAY = 86_400_000;
  const t0 = 1_700_000_000_000;
  const a = islandOp(null, { t: "claim", player: { id: ID_A, name: "わたし" }, code: A }, t0).state as IslandState;
  const p = island(["supply", "quarry"]);
  const rep = islandOp(a, { t: "report", player: { id: ID_A, name: "わたし" }, holds: reportHolds(p), retaken: [], factory: 2, day: 4 }, t0 + 1000);
  const back = reportedHolds(rep.body);
  check(!!back && back.find((n) => n.id === "supply")?.hold === "own" && back.length === NODES.length, `answers: a report's holds read back as ${JSON.stringify(back)}`);
  const now = t0 + 30 * DAY;
  const view = parseView(JSON.parse(JSON.stringify(publicView(a, now))));
  console.log(`answers: view of ${view?.code} by ${view?.owner}, factory ${view?.factory}, holds ${view?.nodes.filter((n) => n.hold === "own").map((n) => n.id).join()}`);
  check(!!view && view.code === A && view.owner === "わたし" && view.factory === 2 && view.nodes.length === NODES.length && view.nodes.filter((n) => n.hold === "own").map((n) => n.id).sort().join() === "quarry,supply", "answers: an island's view did not read back");
  // The log: island A's owner reads another player's sortie on a holding.
  islandOp(a, { t: "raid", from: { code: B, name: "となり" }, target: "supply", captured: false }, now + 1000);
  const log = parseLog(JSON.parse(JSON.stringify(islandOp(a, { t: "log", player: ID_A, after: 0 }, now + 2000).body)));
  check(!!log && log.entries.some((e) => e.t === "wiped" && e.by.code === B && e.node === "supply") && log.next >= 1, `answers: the log read back as ${JSON.stringify(log)}`);
  check(parseView({ ok: true, code: "nope" }) === null && parseLog({ entries: "x" }) === null && reportedHolds({ holds: [] }) === null, "answers: an unreadable answer was read");
}

// --- a sync that a later one started after takes only its report's acknowledgement
{
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: false, error: "no-island-server" }), { status: 202 })) as typeof fetch;
  const base = { ...island(["supply"]), retaken: ["quarry"] } as Profile;
  globalThis.fetch = real;
  const server = NODES.map((n) => ({ id: n.id, hold: n.id === "supply" ? rivalHold(A) : ("foe" as const) }));
  const log = { entries: [{ seq: 99, at: 0, t: "taken", node: "supply", by: { code: A, name: "x" } }], next: 99 } as never;
  // Tickets as syncOwn hands them out: an older one (100) and a later one (101).
  const older = { code: A, view: null, ticket: 100, synced: { holds: server, reported: ["quarry"] as never, log } };
  const later = { code: A, view: null, ticket: 101, synced: {} };
  // A later sync that never applies, or only acknowledges its report (panel closed, next raid under way), leaves the older one to apply.
  takeReport(base, later);
  const alone = takeSync(base, older);
  console.log(`older sync with the later one dropped: supply ${alone.profile.poiState.supply.state}, news ${alone.news.length}`);
  check(alone.profile.poiState.supply.state === rivalHold(A) && alone.news.length === 1, "stale sync: an older answer was dropped although no later one applied");
  // Once the later one applied, the older answer takes only its acknowledgement.
  takeSync(base, later);
  const old = takeSync(base, older);
  console.log(`stale sync: supply ${old.profile.poiState.supply.state}, pending ${old.profile.retaken.join(",") || "none"}, news ${old.news.length}`);
  check(old.profile.poiState.supply.state === "own" && old.profile.retaken.length === 0 && old.news.length === 0, "stale sync: an answer a later sync superseded took its older holds or log");
}

// --- readView gives up as network when the server never answers
{
  const real = globalThis.fetch;
  globalThis.fetch = ((_: unknown, init?: RequestInit) =>
    new Promise((_ok, fail) => init?.signal?.addEventListener("abort", () => fail(init.signal!.reason)))) as typeof fetch;
  const alive = setInterval(() => {}, 1000);
  const t = performance.now();
  const view = await readView(B, 50);
  const took = Math.round(performance.now() - t);
  clearInterval(alive);
  globalThis.fetch = real;
  console.log(`timeout: view ${JSON.stringify(view)} in ${took} ms`);
  check(!view.ok && view.error === "network" && took < 2000, "timeout: readView did not give up as network");
}

// --- saves
{
  const p = { ...newProfile(4), logSeq: 7, retaken: ["quarry" as const, "relay" as const] };
  const current = parseProfile(JSON.parse(JSON.stringify(p)));
  const old = { expeditions: [{ code: A, node: "relay", sentAt: 5, id: 2, units: 3, state: "holding" }], incoming: [{ id: 1, by: { code: B, name: "x" }, node: "relay", arriveAt: 9, state: "coming" }] };
  const v54 = parseProfile(JSON.parse(JSON.stringify({ ...p, ...old, v: 54 })));
  const v27 = parseProfile(JSON.parse(JSON.stringify({ ...p, ...old, v: 27 })));
  const { logSeq: _logSeq, retaken: _retaken, ...beforeV27 } = p;
  const v26 = parseProfile(JSON.parse(JSON.stringify({ ...beforeV27, v: 26 })));
  console.log(`saves: current v${current?.v}, v54 -> v${v54?.v}, v27 -> v${v27?.v} seq ${v27?.logSeq}; v26 -> v${v26?.v} seq ${v26?.logSeq}`);
  check(current?.v === 55 && current.logSeq === 7 && current.retaken.join() === "quarry,relay", "saves: a current save did not keep its log position and nodes taken back");
  check(v54?.v === 55 && !("expeditions" in v54) && !("incoming" in v54) && v54.logSeq === 7, "saves: a v54 save kept its expeditions / incoming");
  check(v27?.v === 55 && !("expeditions" in v27) && v27.logSeq === 7 && v27.retaken.join() === "quarry,relay", "saves: a v27 save did not keep log and nodes taken back");
  check(v26?.v === 55 && v26.logSeq === 0 && v26.retaken.length === 0, "saves: a v26 save did not load with no log read and nothing taken back");
  check(current?.outerGuard && current.outerGuard.lost === 0 && !current.outerGuard.island, "saves: outerGuard missing on current");
  check(parseProfile(JSON.parse(JSON.stringify({ ...p, v: 44 })))?.outerGuard.lost === 0, "saves: v44 did not gain empty outerGuard");
  check(!!current && !("team" in current) && !("teamBattle" in current), "saves: team / teamBattle kept on current");
  {
    const fromV49 = parseProfile(JSON.parse(JSON.stringify({ ...p, v: 49, team: { id: "t", salt: 1, members: [] }, teamBattle: { days: 3 } })));
    check(!!fromV49 && fromV49.v === 55 && !("team" in fromV49) && !("teamBattle" in fromV49), "saves: a v49 save kept its team / teamBattle");
  }
  check(parseProfile(JSON.parse(JSON.stringify({ ...p, retaken: ["quarry", "quarry", "nowhere", 3] })))?.retaken.join() === "quarry", "saves: malformed nodes taken back were kept");
  check(newProfile(1).logSeq === 0 && !("expeditions" in newProfile(1)), "saves: a new profile has a log read or expeditions");
  check(current?.news.length === 0 && parseProfile(JSON.parse(JSON.stringify({ ...p, v: 39 })))?.news.length === 0, "saves: v39/current have empty news archive");
  check(parseProfile(JSON.parse(JSON.stringify({ ...p, news: ["x", "y"] })))?.news.join() === "x,y", "saves: news archive did not round-trip");
}

// --- errors
{
  const missing = API_ERRORS.filter((e) => !ERROR_TEXT[e]?.trim());
  // Every literal error the Worker's sources write, beside the ones its types allow.
  const files = readdirSync(new URL("../worker/", import.meta.url)).map((f) => `../worker/${f}`).filter((f) => f.endsWith(".ts"));
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

// Two syncs that start before the first claim answers share it: one player claims one island.
{
  const { claimIsland } = await import("../src/ringfall/island-net");
  let claims = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/islands" && init?.method === "POST") claims++;
    await new Promise((r) => setTimeout(r, 20));
    return new Response(JSON.stringify({ ok: true, code: "K7M2QX" }), { status: 201, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const [a, b] = await Promise.all([claimIsland(), claimIsland()]);
  globalThis.fetch = realFetch;
  const codes = [a, b].map((r) => (r.ok ? r.body.code : null));
  console.log(`claim: two at once -> ${claims} request(s), codes ${codes.join(",")}`);
  if (claims !== 1 || codes[0] !== "K7M2QX" || codes[1] !== "K7M2QX") errors.push("claim: two syncs at once claimed two islands");
}

if (errors.length) {
  for (const e of errors) console.error(e);
  process.exit(1);
}
console.log("island sync ok");
