/*
 * The island API's requests (docs/ringfall/multiplayer.md): claiming this player's island, the
 * owner's report and log, any island's public view, and a sortie's report to the island it attacked.
 * Browser only, beside post-raid-summary.ts: the sim and the scripts never import it. Every answer comes back as
 * data, a failure as its error code (meta/island-errors.ts), and nothing throws or logs, so play is
 * the same with no server. Under a browser driver (the shots gate) nothing is sent and every request
 * answers `no-island-server`: the browser logs a refused request's status as a console error.
 */
import { loadIdentity, rememberCode, type Identity } from "./meta/identity";
import { isApiError, type ApiError, type NetError } from "./meta/island-errors";
import { isIslandCode } from "./meta/island-code";
import { parseNeighbours, type Neighbour } from "./meta/neighbours";
import { aiByCode, aiChanges, aiIslands, aiView, withAi } from "./meta/ai-islands";
import { awayAttacks, battleLosses } from "./meta/away-attacks";
import { aiLabel } from "./meta/neighbours";
import { islandDay } from "./meta/days";
import { playerNodes } from "./meta/island";
import { applySync, outerGuardFromView, parseLog, parseView, reportedHolds, reportHolds, type IslandLogEntry, type IslandView, type Synced } from "./meta/island-sync";
import type { Profile } from "./meta/profile";
import { clawBackLine, pushNews } from "./view/copy";
import { clawBack } from "./meta/income";
import { addAttacks } from "./meta/attacks";
import { rivalTrophiesLookup, TROPHY, trophiesTable } from "./meta/trophies";
import type { NodeId } from "./sim/map";
import type { Replay } from "./sim/replay-data";

/** An answer: the body of a success, or why it failed. */
export type Answer<T> = { ok: true; body: T } | { ok: false; error: ApiError | NetError };

const failed = (error: ApiError | NetError): { ok: false; error: ApiError | NetError } => ({ ok: false, error });

/**
 * One request to the API, its body as JSON; a refusal (a status other than 200 or 201, or `ok: false`)
 * is its error code. With `timeout`, the request is aborted after that many milliseconds and fails as
 * `network` (an aborted fetch logs nothing).
 */
/** A signal that aborts after `ms`, also where AbortSignal.timeout is missing (Safari before 16). */
function deadline(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

async function call(path: string, init: RequestInit = {}, timeout?: number): Promise<Answer<unknown>> {
  if (navigator.webdriver) return failed("no-island-server");
  const signal = timeout === undefined ? undefined : deadline(timeout);
  let r: Response;
  try {
    r = await fetch(path, { ...init, signal, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  } catch {
    return failed("network");
  }
  let body: unknown;
  try {
    body = await r.json();
  } catch {
    return failed(signal?.aborted ? "network" : "bad-response");
  }
  const o = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if ((r.status === 200 || r.status === 201) && o.ok === true) return { ok: true, body };
  return failed(isApiError(o.error) ? o.error : "bad-response");
}

const player = (who: Identity) => ({ id: who.id, name: who.name });

/** The claim on its way, shared by every sync that starts before it answers, so one player claims one island. */
let claiming: Promise<Answer<Identity>> | null = null;

/** Claims an island for this player (`POST /api/islands`) and keeps its code with the identity. */
const NEIGHBOURS_KEY = "ringfall.neighbours.v1";

/** The neighbours last read in this page, which outlast storage that is blocked or full. */
let lastNeighbours: Neighbour[] | null = null;

/** The neighbours last read from the server, kept in the browser (not the save: they are the server's, read again at each sync). */
export function cachedNeighbours(): Neighbour[] {
  if (lastNeighbours) return lastNeighbours;
  try {
    return parseNeighbours(JSON.parse(localStorage.getItem(NEIGHBOURS_KEY) ?? "null")) ?? [];
  } catch {
    return [];
  }
}

/** This island's neighbours, read from the server and kept; the kept list when the server cannot be asked. */
export async function readNeighbours(): Promise<Neighbour[]> {
  const who = loadIdentity();
  if (!who.code) return cachedNeighbours();
  const r = await call("/api/neighbours", { headers: { authorization: `Bearer ${who.id}` } });
  const list = r.ok ? parseNeighbours(r.body) : null;
  if (!list) return cachedNeighbours();
  lastNeighbours = list;
  try {
    localStorage.setItem(NEIGHBOURS_KEY, JSON.stringify({ neighbours: list }));
  } catch {
    // Storage blocked: the list lasts for this page.
  }
  void readHoldings(list);
  return list;
}

/** Where the browser keeps the other players' holdings as their islands last showed them. */
const HOLDINGS_KEY = "ringfall.holdings.v1";
/** Each other player's island (by code): the nodes they hold and the 島の守り at each, and until when the island is shielded (0, none). */
export type Holdings = Record<string, { held: string[]; guard: Record<string, number>; until?: number }>;
let lastHoldings: Holdings | null = null;

/** The other players' holdings as last read (the 攻める list's real players); an island shielded at `now` offers none. */
export function cachedHoldings(now = Date.now()): Holdings {
  return attackable(storedHoldings(), now);
}

function storedHoldings(): Holdings {
  if (lastHoldings) return lastHoldings;
  try {
    const raw = JSON.parse(localStorage.getItem(HOLDINGS_KEY) ?? "null");
    return raw && typeof raw === "object" ? (raw as Holdings) : {};
  } catch {
    return {};
  }
}

/** The holdings a sortie can take at `now`: none on an island under its day's shield (a capture there would not take). */
export const attackable = (h: Holdings, now: number): Holdings =>
  Object.fromEntries(Object.entries(h).map(([code, x]) => [code, (x.until ?? 0) > now ? { ...x, held: [] } : x]));

/** What island `v` offers a sortie: the nodes it holds, the 島の守り at each, and until when nothing there can be taken. */
function holdingsOf(v: IslandView): Holdings[string] {
  // A holding under its own day's shield is no target either.
  const held = v.nodes.filter((x) => x.hold === "own" && !x.shielded).map((x) => x.id);
  const guard: Record<string, number> = {};
  for (const q of v.parcels ?? []) guard[q.poi] = (guard[q.poi] ?? 0) + 1;
  // Shielded for the day or still under a new island's protection: nothing to attack until then.
  const until = Math.max(v.shieldUntil, v.protectedUntil);
  return { held, guard, ...(until > 0 ? { until } : {}) };
}

/** Keeps what island `v` (a real player's, just looked at) offers a sortie, so the 攻める list and the signal station show it at once. */
export function rememberHoldings(v: IslandView) {
  const all = { ...storedHoldings(), [v.code]: holdingsOf(v) };
  lastHoldings = all;
  try {
    localStorage.setItem(HOLDINGS_KEY, JSON.stringify(all));
  } catch {
    // Kept for this session only.
  }
}

/** Reads each real neighbour's island for the nodes it holds (a sortie's targets). */
async function readHoldings(list: readonly Neighbour[]) {
  const out: Holdings = {};
  for (const n of list.filter((x) => !x.ai)) {
    const v = await readView(n.code, 4000);
    if (v.ok) out[n.code] = holdingsOf(v.body);
  }
  lastHoldings = out;
  try {
    localStorage.setItem(HOLDINGS_KEY, JSON.stringify(out));
  } catch {
    // Storage blocked: kept for this page.
  }
}

/**
 * A sortie on another player's holding has ended (docs/ringfall/glossary.md 攻め): tell their island
 * whether its core was taken. Best effort: the attacker's own settle never waits on it.
 */
export async function reportRaid(code: string, target: string, captured: boolean, stars?: number, won?: number, replay?: Replay | null): Promise<void> {
  const who = loadIdentity();
  if (!who.code) return;
  const report = { from: { ...player(who), code: who.code }, target, captured, ...(stars !== undefined ? { stars } : {}), ...(won ? { won } : {}) };
  const withRecord = replay ? JSON.stringify({ ...report, replay }) : "";
  // The record rides along while the body fits the server's cap; the result never waits on it.
  await call(`/api/islands/${encodeURIComponent(code)}/raids`, { method: "POST", body: withRecord && withRecord.length <= RAID_BODY ? withRecord : JSON.stringify(report) });
}

/** The longest raid report sent with its record (`MAX_BODY` in worker/api.ts, less headroom). */
const RAID_BODY = 3900;

/**
 * The game's own islands (meta/ai-islands.ts, AI の島) are answered here from the profile the page
 * plays, as their server would answer: `useAi()` names it (main.ts). Their salt is this browser's
 * player, so each player meets their own; under a browser driver it is 0, so the shots gate sees
 * the same islands on any run.
 */
let aiSource: (() => Profile) | null = null;
export const useAi = (get: () => Profile) => {
  aiSource = get;
};

/** The salt of this browser's AI islands. */
export function aiSalt(): number {
  if (navigator.webdriver) return 0;
  let h = 0;
  for (const c of loadIdentity().id) h = (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0;
  return h;
}

/** The slots at sea the server's neighbours hold: the game's islands take the rest. */
const serverSlots = () => cachedNeighbours().map((n) => n.slot);

/** The neighbours as the camp's maps, the horizon and the factory's panel show them: the server's, and the game's own in the slots left free. */
export const neighboursFor = (p: Pick<Profile, "since">): Neighbour[] => withAi(cachedNeighbours(), aiSalt(), islandDay(p), Date.now());

/** The neighbours now, of the profile the page plays (`useAi()`); the server's alone before it is named. */
export const neighboursNow = (): Neighbour[] => (aiSource ? neighboursFor(aiSource()) : cachedNeighbours());

/**
 * Neighbours drawn on maps / horizon (2026-11-26 early-MP).
 * Always shown from the first session, so multiplayer is not gated behind first outer ownership.
 */
export function neighboursOnMap(p: Pick<Profile, "since" | "poiState">): Neighbour[] {
  return neighboursFor(p);
}

/** Raid / live map neighbours for the page's profile (`useAi`), gated like `neighboursOnMap`. */
export const neighboursNowOnMap = (): Neighbour[] => (aiSource ? neighboursOnMap(aiSource()) : []);

/** The AI players' attacks on the holdings since the profile last looked, up to `now` (meta/away-attacks.ts). */
/** The AI players' attacks since `p.attackedAt`; `before`, the profile as those hours began, when `p` has settled a raid since. */
export const awayFor = (p: Profile, now = Date.now(), before?: Profile) => awayAttacks(p, aiSalt(), now, serverSlots(), before && playerNodes(before));
/**
 * The AI players next door, whose names the enemy's squads at the player's holdings go by in a raid
 * (決定 B). With every slot at sea taken by real players, the game's own islands still lend their
 * names: the enemy's squads are always some other player's.
 */
export const raidersFor = (): { code: string; name: string }[] => raiderIslands().map((a) => ({ code: a.code, name: aiLabel(a.name) }));
const raiderIslands = () => {
  const next = aiIslands(aiSalt(), serverSlots());
  return next.length ? next : aiIslands(aiSalt());
};
/** The holdings a raid's battle lost, as the AI players' attacks (`battleLosses()`). */
// Against every one of the game's islands, not the slots free now: the neighbours may have changed since the raid began.
export const lossesFor = (p: Profile, lost: readonly { node: NodeId; by: string }[], now = Date.now()) => battleLosses(p, aiIslands(aiSalt()), lost, now);

/** What changed overnight on neighbour `n` if it is one of the game's own islands (its nodes taken and lost on day `day`); null for a player's. */
export function aiOvernight(n: Neighbour, day: number): { took: NodeId[]; lost: NodeId[] } | null {
  const a = n.ai ? aiByCode(aiSalt(), n.code) : null;
  return a ? aiChanges(a, aiSalt(), day) : null;
}

/** Whether `code` is one of the game's own islands now. */
export const isAi = (code: string): boolean => !!aiByCode(aiSalt(), code, serverSlots());

export function claimIsland(): Promise<Answer<Identity>> {
  claiming ??= claimOnce().finally(() => {
    claiming = null;
  });
  return claiming;
}

async function claimOnce(): Promise<Answer<Identity>> {
  const r = await call("/api/islands", { method: "POST", body: JSON.stringify({ player: player(loadIdentity()) }) });
  if (!r.ok) return r;
  const code = (r.body as { code?: unknown }).code;
  // A code is kept only as the server should hand it out: it goes into URLs and onto the screen.
  return isIslandCode(code) ? { ok: true, body: rememberCode(code) } : failed("bad-response");
}

/** Any island as anyone sees it (`GET /api/islands/:code`). */
export async function readView(code: string, timeout?: number): Promise<Answer<IslandView>> {
  const ai = aiSource && aiByCode(aiSalt(), code, serverSlots());
  if (ai) {
    const p = aiSource!();
    return { ok: true, body: aiView(ai, aiSalt(), islandDay(p)) };
  }
  const r = await call(`/api/islands/${encodeURIComponent(code)}`, {}, timeout);
  if (!r.ok) return r;
  const v = parseView(r.body);
  return v ? { ok: true, body: v } : failed("bad-response");
}

/** What a raid's report says beside the island's holds. */
export interface RaidReport {
  /** Aid parcels left at depots this raid (ux-design C2). */
  parcels?: { poi: string; kind: string; from: { code: string; name: string } }[];
  /** Aid parcel ids taken this raid. */
  takenParcels?: number[];
  /**
   * Contested hubs whose 核 · 制圧 was started against a real neighbour but not finished
   * (TKT-201): defender gets 「… · 守りきった」.
   */
  contestedFailed?: { shore: string; owner: string }[];
}

/** What a sync of this player's own island read: the view, and what to take into the profile. */
export interface OwnSync {
  code: string;
  view: IslandView | null;
  synced: Synced;
  /** Which sync this was, in the order they started (see `takeSync`). */
  ticket: number;
}

/** The last sync of the own island started, after a raid or at the factory's panel. */
let lastSync = 0;
/** The newest sync whose holds and log were taken into the profile. */
let applied = 0;

/**
 * Syncs this player's own island: claims one when the identity has no code yet, sends the owner's
 * report of `p` when `report` (after a settled raid, naming every node taken back still pending,
 * `Profile.retaken`; a first claim always reports, so the server's island starts as the profile's),
 * then reads the log after `p.logSeq` and the island's view. The report resets the server's
 * garrisons, so it is sent only after a raid. `raid` is what else the raid has to tell (島の守り left
 * and taken), which goes with the report.
 */
export async function syncOwn(p: Profile, report: boolean, raid?: RaidReport): Promise<Answer<OwnSync>> {
  const ticket = ++lastSync;
  let who = loadIdentity();
  if (!who.code) {
    const c = await claimIsland();
    if (!c.ok) return c;
    who = c.body;
    report = true;
  }
  const code = encodeURIComponent(who.code!);
  const synced: Synced = {};
  if (report) {
    const retaken = [...p.retaken];
    const r = await call(`/api/islands/${code}`, {
      method: "PUT",
      body: JSON.stringify({
        player: player(who),
        holds: reportHolds(p),
        retaken,
        factory: p.factory,
        day: islandDay(p),
        ...(raid?.parcels?.length ? { parcels: raid.parcels } : {}),
        ...(raid?.takenParcels?.length ? { takenParcels: raid.takenParcels } : {}),
        ...(raid?.contestedFailed?.length ? { contestedFailed: raid.contestedFailed } : {}),
      }),
    });
    if (!r.ok) return r;
    synced.reported = retaken;
    synced.holds = reportedHolds(r.body) ?? undefined;
  }
  const log = await call(`/api/islands/${code}/log?after=${p.logSeq}`, { headers: { authorization: `Bearer ${who.id}` } });
  if (log.ok) synced.log = parseLog(log.body) ?? undefined;
  const view = await readView(who.code!);
  if (view.ok) {
    synced.holds = view.body.nodes;
    synced.parcels = view.body.parcels;
    synced.raided = view.body.raided;
    synced.outerGuard = outerGuardFromView(view.body);
  }
  if (!log.ok && !view.ok && !report) return view;
  // The neighbours read again with every sync, so the camp's maps and the horizon show them without the factory's panel opened.
  await readNeighbours();
  return { ok: true, body: { code: who.code!, view: view.ok ? view.body : null, synced, ticket } };
}

/**
 * The sync's result taken into profile `p`: the profile (itself when nothing changed) and the log's new
 * entries. A sync older than one already taken takes only its report's acknowledgement, so a late
 * answer never puts older holds back over newer ones; a later sync that was dropped or failed leaves
 * an older one free to apply.
 */
/**
 * Only the sync's report acknowledgement taken into `p` (the nodes taken back it reported leave the
 * pending list): for an answer whose holds must not be taken now. It leaves which sync was last taken
 * as it was, so an older sync's answer can still be taken whole.
 */
const tropLookup = (p: Profile) => rivalTrophiesLookup(p.trophies ?? TROPHY.start, trophiesTable(neighboursFor(p)));

export const takeReport = (p: Profile, s: OwnSync): Profile => applySync(p, { reported: s.synced.reported }, tropLookup(p)).profile;

/**
 * The holdings the log says another player took, which the player does not hold after the sync: the
 * income collected from them since they were taken goes back out of the cash (meta/income.ts
 * `clawBack()`, which takes each collection back once). Whether the holding was the player's before
 * this sync is not asked: an earlier sync may have shown it lost (by its holds or `raided`) without
 * the log that tells when.
 */
export function takenBack(_before: Profile, after: Profile, news: readonly IslandLogEntry[]): Profile {
  return takenBackBy(_before, after, news).profile;
}

/** `takenBack()`, with the credits taken back for each log line (by its seq), for the record of it (meta/attacks.ts). */
function takenBackBy(_before: Profile, after: Profile, news: readonly IslandLogEntry[]): { profile: Profile; credits: Record<number, number> } {
  const credits: Record<number, number> = {};
  let { stores, cash } = after;
  for (const e of news) {
    if (!(e.t === "taken" && after.poiState[e.node as NodeId]?.state !== "own")) continue;
    const r = clawBack(stores, cash, [{ node: e.node as NodeId, at: e.at }]);
    stores = r.stores;
    cash -= r.back;
    if (r.back > 0) credits[e.seq] = r.back;
  }
  return { profile: stores === after.stores ? after : { ...after, stores, cash }, credits };
}

export function takeSync(p: Profile, s: OwnSync): { profile: Profile; news: IslandLogEntry[]; notes: string[] } {
  const lookup = tropLookup(p);
  const synced = s.ticket < applied ? applySync(p, { reported: s.synced.reported }, lookup) : ((applied = s.ticket), applySync(p, s.synced, lookup));
  const back = takenBackBy(p, synced.profile, synced.news);
  const attacks = addAttacks(back.profile.attacks, synced.news, back.credits);
  const r = { ...synced, profile: attacks === back.profile.attacks ? back.profile : { ...back.profile, attacks }, notes: [...synced.notes] };
  if (r.profile.cash < synced.profile.cash) r.notes.push(clawBackLine(synced.profile.cash - r.profile.cash));
  // トロフィーの増減は必ず知らせの一行と一緒に Profile.news へ残す.
  if (!r.notes.length) return { profile: r.profile, news: r.news, notes: r.notes };
  return { profile: { ...r.profile, news: pushNews(r.profile.news ?? [], r.notes) }, news: r.news, notes: r.notes };
}
