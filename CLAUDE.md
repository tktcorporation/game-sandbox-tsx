# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Clash of Sandboxes** — a Clash of Clans–style base-building & raiding game. React 19 + TypeScript SPA, with a single Cloudflare Worker that both serves the static assets *and* exposes `/api/raid` to procedurally generate enemy bases. No database; player state lives entirely in the browser via `localStorage`.

## Commands

```bash
npm install
npm run dev      # Vite dev server + Worker running locally (http://localhost:5173)
npm run build    # tsc -b (type-check) + vite build — run this to verify a change compiles
npm run deploy   # build + wrangler deploy
npm run cf-typegen   # regenerate Worker types from wrangler.jsonc
```

There is **no test runner and no linter** configured. The only verification gate is `npm run build` (the `tsc -b` step type-checks `src` via `tsconfig.app.json` and the Worker via `tsconfig.worker.json`). Always run it after changes.

## Architecture

The codebase splits into three independent layers; understanding their boundaries is the key to working here.

### 1. Pure game logic (`src/game/`) — no React

- `types.ts` — the data model. `BuildingDef` describes a building *kind* (cost/buildTime/production/storage/defense curves as functions of level); `PlacedBuilding` is an instance on the grid. `GameState` is the persisted shape.
- `buildings.ts` — `BUILDINGS` and `TROOPS` lookup tables plus all balance curves and `GRID_SIZE`. **This is the single source of truth for game balance.** Editing a curve here changes costs/HP/production everywhere.
- `logic.ts` — pure helpers (capacity, placement collision, accrued production, town-hall gating, formatting). No state mutation; takes state in, returns values.
- `store.ts` — the Zustand store (`useGame`), wrapped in `persist` (key `clash-of-sandboxes-v1`). All gameplay mutations (place/move/upgrade/collect/train/applyBattleResult) live here. `partialize` controls exactly which fields persist — **if you add a field to `GameState` that must survive reload, add it to `partialize` too.**
- `battle.ts` — the real-time battle engine as a plain `Battle` class (no React). `step(dt)` advances the sim; `stats()`/`result()` derive stars, loot, and trophies.

### 2. React UI (`src/components/`, `src/App.tsx`, `src/ui.ts`)

- `ui.ts` holds **ephemeral** UI state (`useUi`: mode home/battle, selection, toasts) — deliberately *not* persisted, separate store from `useGame`. It also exports `useGameLoop`, which ticks `useGame.tick()` once per second to finalize construction timers and refresh production counters (and re-ticks on tab `visibilitychange`).
- The game has no real-time server tick. Resource production is computed lazily: `accruedFor` calculates how much a building produced since its `lastCollect` timestamp whenever you collect or open the store. The 1s loop only drives UI re-renders and finishes timed constructions.
- `App.tsx` is the root switch between **home** (village) and **battle** views. It calls `GET /api/raid?th=<level>&seed=<n>` to fetch an enemy base, then renders `BattleView`, which instantiates a `Battle` and drives it with `requestAnimationFrame` onto a `<canvas>`.

### 3. Cloudflare Worker (`worker/index.ts`)

A stateless Worker. `fetch` routes `/api/raid` and `/api/health`; everything else falls through to the `ASSETS` binding (SPA fallback configured in `wrangler.jsonc`). `/api/raid` uses a seeded `mulberry32` RNG so a given `seed` deterministically reproduces the same base.

## Cross-cutting gotchas

- **The enemy-base type is duplicated.** `worker/index.ts` defines its own `EnemyBuilding`/`EnemyBase` (using plain `string` building types) and `src/game/battle.ts` defines matching ones. They are coupled by the JSON shape over the wire — change one side and you must change the other. The battle engine looks up the worker's `type` strings against `BUILDINGS`, so the Worker must only emit types present there.
- **Town Hall gates everything.** Building counts (`limitByTh`) and upgrade levels are capped by the current Town Hall level; the Town Hall is the only building not gated by itself. Check `townHallLevel()` / `limitForType()` when touching progression.
- **Walls don't count** toward destruction percentage in battle scoring (matching Clash of Clans) — see `Battle.stats()` and `totalBuildings`.
- Resource collection is clamped to storage `capacityOf(...)`; upgrading a producer first collects pending production so it isn't lost.
