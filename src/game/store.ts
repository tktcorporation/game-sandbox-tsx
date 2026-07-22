import { create } from "zustand";
import { persist } from "zustand/middleware";
import { simulateBattle, squadPower } from "./battle";
import { advanceColonies, colonyOf, now } from "./logic";
import { STARTER_SPECIES, nestUpgradeCost } from "./species";
import type {
  BattleResult,
  Colony,
  EvolutionEvent,
  GameState,
  LeaderboardEntry,
  Opponent,
  SpeciesId,
} from "./types";

const MAX_SQUAD_SIZE = 5;

interface Store extends GameState {
  /** last battle fought, kept for the battle view — not persisted */
  lastBattleResult: BattleResult | null;
  /** opponent currently loaded for the battle view — not persisted */
  opponent: Opponent | null;
  leaderboard: LeaderboardEntry[];
  syncing: boolean;

  tick: () => EvolutionEvent[];
  setSquad: (ids: SpeciesId[]) => void;
  setPlayerName: (name: string) => void;
  upgradeNest: () => { ok: boolean; reason?: string };
  registerPlayer: (name: string) => Promise<void>;
  ensurePlayer: () => Promise<void>;
  syncSquad: () => Promise<void>;
  fetchOpponent: () => Promise<Opponent | null>;
  resolveBattle: (opponent: Opponent) => Promise<BattleResult>;
  fetchLeaderboard: () => Promise<void>;
  reset: () => void;
}

function createInitialState(): GameState {
  const t = now();
  const starter: Colony = { speciesId: STARTER_SPECIES, count: 1, growth: 0, updatedAt: t };
  return {
    playerId: null,
    playerToken: null,
    playerName: "",
    rating: 1000,
    colonies: [starter],
    dex: [STARTER_SPECIES],
    shineStones: 20,
    nestLevel: 0,
    squad: [STARTER_SPECIES],
    lastTick: t,
  };
}

async function api(state: GameState, path: string, init?: RequestInit) {
  const headers: Record<string, string> = { "content-type": "application/json", ...(init?.headers as Record<string, string> | undefined) };
  if (state.playerId && state.playerToken) {
    headers["x-player-id"] = state.playerId;
    headers["x-player-token"] = state.playerToken;
  }
  const res = await fetch(path, { ...init, headers });
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`);
  return res.json();
}

export const useGame = create<Store>()(
  persist(
    (set, get) => ({
      ...createInitialState(),
      lastBattleResult: null,
      opponent: null,
      leaderboard: [],
      syncing: false,

      tick: () => {
        const state = get();
        const t = now();
        const dtSeconds = (t - state.lastTick) / 1000;
        const { colonies, dex, events } = advanceColonies(state.colonies, state.dex, state.nestLevel, dtSeconds);
        const stamped = colonies.map((c) => ({ ...c, updatedAt: t }));
        const shineFromEvolutions = events.reduce((sum, e) => sum + e.amount, 0);
        set({ colonies: stamped, dex, lastTick: t, shineStones: state.shineStones + shineFromEvolutions });
        return events;
      },

      setSquad: (ids) => {
        const state = get();
        const owned = ids.filter((id) => state.dex.includes(id) && (colonyOf(state.colonies, id)?.count ?? 0) >= 1);
        const deduped = Array.from(new Set(owned)).slice(0, MAX_SQUAD_SIZE);
        set({ squad: deduped.length > 0 ? deduped : state.squad });
      },

      setPlayerName: (name) => set({ playerName: name.trim().slice(0, 24) }),

      upgradeNest: () => {
        const state = get();
        const cost = nestUpgradeCost(state.nestLevel);
        if (state.shineStones < cost) return { ok: false, reason: "きらめき石が足りません" };
        set({ shineStones: state.shineStones - cost, nestLevel: state.nestLevel + 1 });
        return { ok: true };
      },

      registerPlayer: async (name) => {
        const state = get();
        const data = await api(state, "/api/player/register", {
          method: "POST",
          body: JSON.stringify({ name }),
        });
        set({ playerId: data.id, playerToken: data.token, playerName: data.name, rating: data.rating });
      },

      ensurePlayer: async () => {
        const state = get();
        if (state.playerId && state.playerToken) return;
        await get().registerPlayer(state.playerName || `トレーナー${Math.floor(Math.random() * 9000 + 1000)}`);
      },

      syncSquad: async () => {
        set({ syncing: true });
        try {
          await get().ensurePlayer();
          const fresh = get();
          // Send only {speciesId, count} — the Worker recomputes stats from the real species
          // table server-side, so it never has to trust client-reported combat stats.
          const monsters = fresh.squad.map((id) => ({ speciesId: id, count: colonyOf(fresh.colonies, id)?.count ?? 0 }));
          await api(fresh, "/api/player/sync", {
            method: "POST",
            body: JSON.stringify({ name: fresh.playerName, dexCount: fresh.dex.length, monsters }),
          });
        } finally {
          set({ syncing: false });
        }
      },

      fetchOpponent: async () => {
        try {
          // Sync first so the match the server mints is pinned to the squad actually fielded.
          await get().syncSquad();
          const state = get();
          // Matchmaking rating is derived server-side from the authenticated player, not a
          // query param — nothing to pass here.
          const data = await api(state, "/api/opponent");
          set({ opponent: data });
          return data as Opponent;
        } catch {
          return null;
        }
      },

      resolveBattle: async (opponent) => {
        const state = get();
        // Use the squad snapshot the ticket was pinned against, not live colonies — the idle
        // loop keeps growing colonies while the player sits on the preview, and simulating with
        // fresher counts here could show a win the server (replaying the synced snapshot) then
        // records as a loss.
        const result = simulateBattle(opponent.mySquad, opponent.monsters, opponent.battleSeed);
        const reward = result.won ? 40 + Math.round(opponent.rating / 40) : 10;
        const finalResult: BattleResult = { ...result, reward };
        set({ shineStones: state.shineStones + reward, lastBattleResult: finalResult });
        try {
          // The server re-simulates the battle itself from the matchId's pinned opponent/seed
          // and the caller's own last-synced squad — it never trusts a client-claimed outcome.
          const data = await api(get(), "/api/battle/result", {
            method: "POST",
            body: JSON.stringify({ matchId: opponent.matchId }),
          });
          if (typeof data.rating === "number") set({ rating: data.rating });
        } catch {
          // offline / no backend reachable — local reward still applies
        }
        return finalResult;
      },

      fetchLeaderboard: async () => {
        const state = get();
        try {
          const data = await api(state, "/api/leaderboard?limit=20");
          set({ leaderboard: data.entries ?? [] });
        } catch {
          set({ leaderboard: [] });
        }
      },

      reset: () => set({ ...createInitialState(), lastBattleResult: null, opponent: null, leaderboard: [] }),
    }),
    {
      name: "clash-of-sandboxes-v1",
      partialize: (s) => ({
        playerId: s.playerId,
        playerToken: s.playerToken,
        playerName: s.playerName,
        rating: s.rating,
        colonies: s.colonies,
        dex: s.dex,
        shineStones: s.shineStones,
        nestLevel: s.nestLevel,
        squad: s.squad,
        lastTick: s.lastTick,
      }),
    },
  ),
);

export { squadPower };
