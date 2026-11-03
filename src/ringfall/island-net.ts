/*
 * The island API's requests (docs/ringfall/multiplayer.md, 島の番号と遠征の API): claiming this
 * player's island, the owner's report and log, any island's public view, and sending an expedition.
 * Browser only, beside net.ts: the sim and the scripts never import it. Every answer comes back as
 * data, a failure as its error code (meta/island-errors.ts), and nothing throws or logs, so play is
 * the same with no server. Under a browser driver (the shots gate) nothing is sent and every request
 * answers `no-island-server`: the browser logs a refused request's status as a console error.
 */
import { loadIdentity, rememberCode, type Identity } from "./meta/identity";
import { isApiError, type ApiError, type NetError } from "./meta/island-errors";
import { isIslandCode } from "./meta/island-code";
import { applySync, parseLog, parseView, reportedHolds, reportHolds, sendUnits, type IslandLogEntry, type IslandView, type Synced } from "./meta/expeditions";
import type { Profile } from "./meta/profile";

/** An answer: the body of a success, or why it failed. */
export type Answer<T> = { ok: true; body: T } | { ok: false; error: ApiError | NetError };

const failed = (error: ApiError | NetError): { ok: false; error: ApiError | NetError } => ({ ok: false, error });

/** One request to the API, its body as JSON; a refusal (a status other than 200 or 201, or `ok: false`) is its error code. */
async function call(path: string, init: RequestInit = {}): Promise<Answer<unknown>> {
  if (navigator.webdriver) return failed("no-island-server");
  let r: Response;
  try {
    r = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  } catch {
    return failed("network");
  }
  let body: unknown;
  try {
    body = await r.json();
  } catch {
    return failed("bad-response");
  }
  const o = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if ((r.status === 200 || r.status === 201) && o.ok === true) return { ok: true, body };
  return failed(isApiError(o.error) ? o.error : "bad-response");
}

const player = (who: Identity) => ({ id: who.id, name: who.name });

/** Claims an island for this player (`POST /api/islands`) and keeps its code with the identity. */
export async function claimIsland(): Promise<Answer<Identity>> {
  const r = await call("/api/islands", { method: "POST", body: JSON.stringify({ player: player(loadIdentity()) }) });
  if (!r.ok) return r;
  const code = (r.body as { code?: unknown }).code;
  // A code is kept only as the server should hand it out: it goes into URLs and onto the screen.
  return isIslandCode(code) ? { ok: true, body: rememberCode(code) } : failed("bad-response");
}

/** Any island as anyone sees it (`GET /api/islands/:code`). */
export async function readView(code: string): Promise<Answer<IslandView>> {
  const r = await call(`/api/islands/${encodeURIComponent(code)}`);
  if (!r.ok) return r;
  const v = parseView(r.body);
  return v ? { ok: true, body: v } : failed("bad-response");
}

/** Sends an expedition from this island's factory to node `node` of island `code` (`POST …/expeditions`): its number on that island. */
export async function sendExpedition(p: Pick<Profile, "factory">, code: string, node: string): Promise<Answer<{ id: number }>> {
  const who = loadIdentity();
  if (!who.code) return failed("no-own-island");
  const r = await call(`/api/islands/${encodeURIComponent(code)}/expeditions`, { method: "POST", body: JSON.stringify({ from: { ...player(who), code: who.code }, target: node, units: sendUnits(p) }) });
  if (!r.ok) return r;
  const id = (r.body as { id?: unknown }).id;
  return Number.isInteger(id) ? { ok: true, body: { id: id as number } } : failed("bad-response");
}

/** What a sync of this player's own island read: the view, and what to take into the profile. */
export interface OwnSync {
  code: string;
  view: IslandView | null;
  synced: Synced;
}

/**
 * Syncs this player's own island: claims one when the identity has no code yet, sends the owner's
 * report of `p` when `report` is given (after a settled raid, with the nodes it took back from other
 * players, `retakenNodes()`; a first claim always reports, so the server's island starts as the
 * profile's), then reads the log after `p.logSeq` and the island's view. The report resets the
 * server's garrisons, so it is sent only after a raid.
 */
export async function syncOwn(p: Profile, report: { retaken: readonly string[] } | null): Promise<Answer<OwnSync>> {
  let who = loadIdentity();
  if (!who.code) {
    const c = await claimIsland();
    if (!c.ok) return c;
    who = c.body;
    report ??= { retaken: [] };
  }
  const code = encodeURIComponent(who.code!);
  const synced: Synced = {};
  if (report) {
    const r = await call(`/api/islands/${code}`, { method: "PUT", body: JSON.stringify({ player: player(who), holds: reportHolds(p), retaken: report.retaken, factory: p.factory, day: p.day }) });
    if (!r.ok) return r;
    synced.holds = reportedHolds(r.body) ?? undefined;
  }
  const log = await call(`/api/islands/${code}/log?after=${p.logSeq}`, { headers: { authorization: `Bearer ${who.id}` } });
  if (log.ok) synced.log = parseLog(log.body) ?? undefined;
  const view = await readView(who.code!);
  if (view.ok) synced.holds = view.body.nodes;
  if (!log.ok && !view.ok && !report) return view;
  return { ok: true, body: { code: who.code!, view: view.ok ? view.body : null, synced } };
}

/** The sync's result taken into profile `p`: the profile (itself when nothing changed) and the log's new entries. */
export const takeSync = (p: Profile, s: OwnSync): { profile: Profile; news: IslandLogEntry[] } => applySync(p, s.synced);
