/*
 * The island API's requests (docs/ringfall/multiplayer.md, 島の番号と遠征の API): claiming this
 * player's island, the owner's report and log, any island's public view, and sending an expedition.
 * Browser only, beside post-raid-summary.ts: the sim and the scripts never import it. Every answer comes back as
 * data, a failure as its error code (meta/island-errors.ts), and nothing throws or logs, so play is
 * the same with no server. Under a browser driver (the shots gate) nothing is sent and every request
 * answers `no-island-server`: the browser logs a refused request's status as a console error.
 */
import { loadIdentity, rememberCode, type Identity } from "./meta/identity";
import { isApiError, type ApiError, type NetError } from "./meta/island-errors";
import { isIslandCode } from "./meta/island-code";
import { parseNeighbours, type Neighbour } from "./meta/neighbours";
import { aiByCode, aiChanges, aiRefresh, aiView, withAi } from "./meta/ai-islands";
import { awayAttacks } from "./meta/away-attacks";
import { playerNodes } from "./meta/island";
import { answerRecall, applySync, incomingOf, outerGuardFromView, parseLease, parseLog, parseView, reportedHolds, reportHolds, type Incoming, type IslandLogEntry, type IslandView, type LentIn, type Synced } from "./meta/expeditions";
import type { Profile } from "./meta/profile";
import { pushNews } from "./view/copy";
import { rivalTrophiesLookup, TROPHY, trophiesTable } from "./meta/trophies";
import type { NodeId } from "./sim/map";

/** An answer: the body of a success, or why it failed. */
export type Answer<T> = { ok: true; body: T } | { ok: false; error: ApiError | NetError };

const failed = (error: ApiError | NetError): { ok: false; error: ApiError | NetError } => ({ ok: false, error });

/**
 * Milliseconds each request of a send (the own island's view, then the expedition) waits before it
 * gives up as `network`: the two together end well inside `SENDING_MS`, so a send still out is never
 * dropped as unanswered and then answered.
 */
export const SEND_TIMEOUT_MS = 20_000;

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
  return list;
}

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
export const neighboursFor = (p: Pick<Profile, "day">): Neighbour[] => withAi(cachedNeighbours(), aiSalt(), p.day, Date.now());

/** The neighbours now, of the profile the page plays (`useAi()`); the server's alone before it is named. */
export const neighboursNow = (): Neighbour[] => (aiSource ? neighboursFor(aiSource()) : cachedNeighbours());

/**
 * Neighbours drawn on maps / horizon (2026-11-26 early-MP).
 * Always shown from the first session — sea-route open/shut still gates expeditions (`routeOpen`),
 * but the islands themselves stay visible so multiplayer is not gated behind first outer ownership.
 */
export function neighboursOnMap(p: Pick<Profile, "day" | "poiState">): Neighbour[] {
  return neighboursFor(p);
}

/** Raid / live map neighbours for the page's profile (`useAi`), gated like `neighboursOnMap`. */
export const neighboursNowOnMap = (): Neighbour[] => (aiSource ? neighboursOnMap(aiSource()) : []);

/** The expeditions coming at this island: the server's warnings. */
export const incomingFor = (p: Profile): Incoming[] => p.incoming;

/** The AI players' attacks on the holdings since the profile last looked, up to `now` (meta/away-attacks.ts). */
/** The AI players' attacks since `p.attackedAt`; `before`, the profile as those hours began, when `p` has settled a raid since. */
export const awayFor = (p: Profile, now = Date.now(), before?: Profile) => awayAttacks(p, aiSalt(), now, serverSlots(), before && playerNodes(before));

/** The expeditions with those on the game's islands brought up to now: the profile itself when none changes. */
export function refreshAi(p: Profile): Profile {
  // Every slot's: an island the server's neighbour has since replaced still ends its expeditions on their clock.
  const expeditions = aiRefresh(p.expeditions, aiSalt(), [], Date.now());
  return expeditions === p.expeditions ? p : { ...p, expeditions };
}

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
    return { ok: true, body: aiView(ai, aiSalt(), p.day, p.expeditions, loadIdentity().code ?? "", Date.now(), []) };
  }
  const r = await call(`/api/islands/${encodeURIComponent(code)}`, {}, timeout);
  if (!r.ok) return r;
  const v = parseView(r.body);
  return v ? { ok: true, body: v } : failed("bad-response");
}

/** What a raid's report says beside the island's holds: what became of the expeditions it took in. */
export interface RaidReport {
  lent: { id: number; left: number; waiting?: true }[];
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

/**
 * The owner's raid takes in the expeditions on the island (`POST …/lease`): the island leaves them
 * alone until the raid's report, or until `until`. With no island yet, or no server, nothing.
 */
export async function leaseOwn(timeout = SEND_TIMEOUT_MS): Promise<Answer<{ until: number; expeditions: LentIn[] }>> {
  await releasing;
  const who = loadIdentity();
  if (!who.code) return failed("no-own-island");
  const r = await call(`/api/islands/${encodeURIComponent(who.code)}/lease`, { method: "POST", headers: { authorization: `Bearer ${who.id}` } }, timeout);
  if (!r.ok) return r;
  const l = parseLease(r.body);
  return l ? { ok: true, body: l } : failed("bad-response");
}

/** Gives back a lease no raid will use (`DELETE …/lease`): the island goes on reckoning its expeditions at once. Nothing waits on it. */
export function releaseLease(): Promise<void> {
  releasing = releasing.then(async () => {
    const who = loadIdentity();
    if (!who.code) return;
    await call(`/api/islands/${encodeURIComponent(who.code)}/lease`, { method: "DELETE", headers: { authorization: `Bearer ${who.id}` } }, SEND_TIMEOUT_MS);
  });
  return releasing;
}

/**
 * The releases on their way, one after another. A lease is asked for only once they have been
 * answered: a release still out when the next departure opens would otherwise reach the island after
 * that departure's lease and take it away from the raid that uses it.
 */
let releasing: Promise<void> = Promise.resolve();

/* postMark / sendAid removed from the player-facing loop (ux-design Round 3 simplify).
 * Island DO may still accept report parcels from deposits; defence spend stays server-side. */

/** Calls expedition `id` on island `code` home (`DELETE …/expeditions/<id>`), as its sender. */
export async function recallExpedition(code: string, id: number): Promise<Answer<unknown>> {
  // Every slot's: an island the server's neighbour has since replaced still lets its expeditions go.
  if (aiSource && aiByCode(aiSalt(), code)) return { ok: true, body: { ok: true } };
  const who = loadIdentity();
  if (!who.code) return failed("no-own-island");
  return call(`/api/islands/${encodeURIComponent(code)}/expeditions/${id}`, { method: "DELETE", body: JSON.stringify({ from: { ...player(who), code: who.code } }) }, SEND_TIMEOUT_MS);
}

/**
 * Tells the islands of the expeditions called home (`recalling`), one after another: each the island
 * let go, or no longer had, leaves the list. One that could not be told stays, to be told at the next sync.
 */
export async function flushRecalls(get: () => Profile, put: (p: Profile) => void): Promise<void> {
  for (const o of get().expeditions.filter((e) => e.state === "recalling")) {
    const r = await recallExpedition(o.code, o.id);
    if (!r.ok && r.error !== "no-expedition" && r.error !== "no-island") continue;
    const p = get();
    const expeditions = answerRecall(p.expeditions, o);
    if (expeditions.length !== p.expeditions.length) put({ ...p, expeditions });
  }
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
 * garrisons, so it is sent only after a raid. `raid` is what the raid made of the expeditions it took
 * in (`lent`), which go with the report.
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
        day: p.day,
        ...(raid?.lent.length ? { lent: raid.lent } : {}),
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
    synced.incoming = incomingOf(view.body);
    synced.parcels = view.body.parcels;
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

export function takeSync(p: Profile, s: OwnSync): { profile: Profile; news: IslandLogEntry[]; notes: string[] } {
  const lookup = tropLookup(p);
  const r = s.ticket < applied ? applySync(p, { reported: s.synced.reported }, lookup) : ((applied = s.ticket), applySync(p, s.synced, lookup));
  // トロフィーの増減は必ず知らせの一行と一緒に Profile.news へ残す.
  if (!r.notes.length) return { profile: r.profile, news: r.news, notes: r.notes };
  return { profile: { ...r.profile, news: pushNews(r.profile.news ?? [], r.notes) }, news: r.news, notes: r.notes };
}
