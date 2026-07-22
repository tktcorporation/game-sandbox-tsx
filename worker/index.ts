/// <reference types="@cloudflare/workers-types" />
import { simulateBattle } from "../src/game/battle";
import { squadMonsterStats } from "../src/game/logic";
import { SPECIES, SPECIES_LIST } from "../src/game/species";
import type { SpeciesId, SquadMonster } from "../src/game/types";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
}

const AI_NAMES = [
  "野生の群れ", "さすらいの調教師", "森のライバル", "岩場の使い手", "月夜の挑戦者",
  "波止場のトレーナー", "旅の収集家", "洞窟の番人", "草原の遣い手", "北風の使者",
];

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function squadPower(monsters: SquadMonster[]): number {
  return monsters.reduce((sum, m) => sum + m.hp + m.atk * 3 + m.def * 2, 0);
}

/**
 * Synthetic opponent used whenever no other player's squad is available to match against.
 * Seeded so `/api/battle/result` can regenerate the exact same squad to verify a battle
 * against an AI opponent, without persisting anything for it.
 */
function generateAiSquad(targetRating: number, seed: number): SquadMonster[] {
  const rand = mulberry32(seed);
  const tierBias = Math.min(3, Math.max(0, Math.round((targetRating - 1000) / 300)));
  const pool = SPECIES_LIST.filter((s) => Math.abs(s.tier - tierBias) <= 1);
  const source = pool.length > 0 ? pool : SPECIES_LIST;
  const count = 3 + Math.floor(rand() * 3);
  const monsters: SquadMonster[] = [];
  for (let i = 0; i < count; i++) {
    const species = source[Math.floor(rand() * source.length)];
    const pretendOwned = 5 + Math.floor(rand() * 40);
    monsters.push(squadMonsterStats(species.id, pretendOwned));
  }
  return monsters;
}

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, { headers: { "cache-control": "no-store" }, ...init });
}

function sanitizeName(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim().slice(0, 24) : "";
  return s || `トレーナー${Math.floor(Math.random() * 9000 + 1000)}`;
}

async function authenticate(env: Env, request: Request): Promise<string | null> {
  const id = request.headers.get("x-player-id");
  const token = request.headers.get("x-player-token");
  if (!id || !token) return null;
  const row = await env.DB.prepare("SELECT token FROM players WHERE id = ?").bind(id).first<{ token: string }>();
  if (!row || row.token !== token) return null;
  return id;
}

/** Builds the authoritative SquadMonster list server-side — never trust client-supplied stats. */
function buildValidatedSquad(raw: unknown): SquadMonster[] {
  if (!Array.isArray(raw)) return [];
  const monsters: SquadMonster[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const speciesId = (entry as { speciesId?: unknown }).speciesId;
    const count = (entry as { count?: unknown }).count;
    if (typeof speciesId !== "string" || !(speciesId in SPECIES)) continue;
    if (typeof count !== "number" || !Number.isFinite(count)) continue;
    monsters.push(squadMonsterStats(speciesId as SpeciesId, Math.max(0, count)));
    if (monsters.length >= 5) break;
  }
  return monsters;
}

/** Parses the `ai:<squadSeed>:<rating>` synthetic-opponent id minted by /api/opponent. */
function parseAiOpponentId(id: string): { seed: number; rating: number } | null {
  const parts = id.split(":");
  if (parts.length !== 3 || parts[0] !== "ai") return null;
  const seed = Number(parts[1]);
  const rating = Number(parts[2]);
  if (!Number.isFinite(seed) || !Number.isFinite(rating)) return null;
  return { seed, rating };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return json({ ok: true, time: Date.now() });
    }

    if (url.pathname === "/api/player/register" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const name = sanitizeName((body as { name?: string }).name);
      const id = crypto.randomUUID();
      const token = crypto.randomUUID();
      const now = Date.now();
      await env.DB.prepare(
        "INSERT INTO players (id, token, name, rating, created_at, updated_at) VALUES (?, ?, ?, 1000, ?, ?)",
      )
        .bind(id, token, name, now, now)
        .run();
      return json({ id, token, name, rating: 1000 });
    }

    if (url.pathname === "/api/player/sync" && request.method === "POST") {
      const playerId = await authenticate(env, request);
      if (!playerId) return json({ error: "unauthorized" }, { status: 401 });
      const body = (await request.json().catch(() => ({}))) as {
        name?: string;
        dexCount?: number;
        monsters?: unknown;
      };
      // Client sends only {speciesId, count} — stats are always recomputed here from the real
      // species table so a malicious client can neither crash other players with an unknown
      // speciesId nor inflate its own combat stats.
      const monsters = buildValidatedSquad(body.monsters);
      const power = squadPower(monsters);
      const now = Date.now();
      if (body.name) {
        await env.DB.prepare("UPDATE players SET name = ?, updated_at = ? WHERE id = ?")
          .bind(sanitizeName(body.name), now, playerId)
          .run();
      }
      await env.DB.prepare(
        `INSERT INTO squads (player_id, dex_count, monsters, power, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(player_id) DO UPDATE SET dex_count = excluded.dex_count, monsters = excluded.monsters,
           power = excluded.power, updated_at = excluded.updated_at`,
      )
        .bind(playerId, body.dexCount ?? 0, JSON.stringify(monsters), power, now)
        .run();
      return json({ power });
    }

    if (url.pathname === "/api/opponent" && request.method === "GET") {
      const playerId = url.searchParams.get("playerId") ?? "";
      const rating = Number(url.searchParams.get("rating")) || 1000;
      const rows = await env.DB.prepare(
        `SELECT s.player_id as id, p.name as name, p.rating as rating, s.monsters as monsters
         FROM squads s JOIN players p ON p.id = s.player_id
         WHERE s.player_id != ?
         ORDER BY ABS(p.rating - ?) ASC
         LIMIT 5`,
      )
        .bind(playerId, rating)
        .all<{ id: string; name: string; rating: number; monsters: string }>();

      const candidates = rows.results ?? [];
      if (candidates.length > 0) {
        const pick = candidates[Math.floor(Math.random() * candidates.length)];
        return json({
          id: pick.id,
          name: pick.name,
          rating: pick.rating,
          monsters: JSON.parse(pick.monsters) as SquadMonster[],
        });
      }

      const squadSeed = Math.floor(Math.random() * 1e9);
      const monsters = generateAiSquad(rating, squadSeed);
      return json({
        id: `ai:${squadSeed}:${rating}`,
        name: AI_NAMES[Math.floor(Math.random() * AI_NAMES.length)],
        rating,
        monsters,
      });
    }

    if (url.pathname === "/api/battle/result" && request.method === "POST") {
      const playerId = await authenticate(env, request);
      if (!playerId) return json({ error: "unauthorized" }, { status: 401 });
      const body = (await request.json().catch(() => ({}))) as {
        opponentId?: string;
        battleSeed?: number;
      };
      const opponentId = body.opponentId;
      const battleSeed = Number(body.battleSeed);
      if (typeof opponentId !== "string" || !Number.isFinite(battleSeed)) {
        return json({ error: "invalid request" }, { status: 400 });
      }

      // The battle outcome and the rating delta are always derived server-side — from each
      // side's own last-synced squad (never from client-claimed stats or a claimed win/loss) —
      // so a client can't fabricate a win or inflate the opponent's rating to farm Elo.
      const me = await env.DB.prepare(
        `SELECT p.rating as rating, s.monsters as monsters FROM players p
         LEFT JOIN squads s ON s.player_id = p.id WHERE p.id = ?`,
      )
        .bind(playerId)
        .first<{ rating: number; monsters: string | null }>();
      if (!me || !me.monsters) {
        return json({ error: "sync a squad before battling" }, { status: 400 });
      }
      const myRating = me.rating;
      const mySquad = JSON.parse(me.monsters) as SquadMonster[];

      let opponentSquad: SquadMonster[];
      let opponentRating: number;
      const ai = parseAiOpponentId(opponentId);
      if (ai) {
        opponentRating = ai.rating;
        opponentSquad = generateAiSquad(ai.rating, ai.seed);
      } else {
        const opp = await env.DB.prepare(
          `SELECT p.rating as rating, s.monsters as monsters FROM players p
           JOIN squads s ON s.player_id = p.id WHERE p.id = ?`,
        )
          .bind(opponentId)
          .first<{ rating: number; monsters: string }>();
        if (!opp) return json({ error: "opponent not found" }, { status: 400 });
        opponentRating = opp.rating;
        opponentSquad = JSON.parse(opp.monsters) as SquadMonster[];
      }

      const result = simulateBattle(mySquad, opponentSquad, battleSeed);
      const expected = 1 / (1 + Math.pow(10, (opponentRating - myRating) / 400));
      const K = 24;
      const delta = Math.round(K * ((result.won ? 1 : 0) - expected));
      const newRating = Math.max(0, myRating + delta);
      await env.DB.prepare("UPDATE players SET rating = ?, updated_at = ? WHERE id = ?")
        .bind(newRating, Date.now(), playerId)
        .run();
      return json({ rating: newRating, won: result.won });
    }

    if (url.pathname === "/api/leaderboard" && request.method === "GET") {
      const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit")) || 20));
      const rows = await env.DB.prepare(
        `SELECT p.id as id, p.name as name, p.rating as rating, COALESCE(s.power, 0) as power
         FROM players p LEFT JOIN squads s ON s.player_id = p.id
         ORDER BY p.rating DESC LIMIT ?`,
      )
        .bind(limit)
        .all();
      return json({ entries: rows.results ?? [] });
    }

    // Everything else: serve the built SPA (with SPA fallback configured in wrangler).
    return env.ASSETS.fetch(request);
  },
};
