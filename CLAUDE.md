# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Monster Nest** — a breeding/collection idle game with async multiplayer battles. Small monsters
multiply in your nest, mature, and once a species+stage colony crosses its population threshold it
rolls a weighted-random evolution into a new species — a branching dex to discover over many idle
sessions. Trained squads (up to 5 monsters) fight other players asynchronously: you battle a
snapshot of their squad (or a synthetic AI opponent if none is available), Elo-style rating updates
server-side, and a leaderboard ranks everyone.

React 19 + TypeScript SPA, with a single Cloudflare Worker that serves the static assets *and*
exposes the multiplayer API, backed by Cloudflare D1 (SQLite). Per-player idle progress (colonies,
dex, squad) lives entirely in the browser via `localStorage`; only the squad snapshot, rating, and
leaderboard are server-side.

## Commands

```bash
npm install
npm run dev      # Vite dev server + Worker running locally (http://localhost:5173)
npm run build    # tsc -b (type-check) + vite build — run this to verify a change compiles
npm run deploy   # build + wrangler deploy
npm run cf-typegen   # regenerate Worker types from wrangler.jsonc
```

There is **no test runner and no linter** configured. The only verification gate is `npm run build`
(the `tsc -b` step type-checks `src` via `tsconfig.app.json` and the Worker via
`tsconfig.worker.json`, and the Worker project transitively pulls in and type-checks whatever it
imports from `src/game`). Always run it after changes.

### D1 setup (one-time, needed before a real deploy)

`wrangler.jsonc` ships with a placeholder `database_id` — local dev works with it as-is (local D1 is
an on-disk SQLite emulation keyed by binding name, no Cloudflare account needed), but a real deploy
needs a provisioned database:

```bash
npx wrangler d1 create game-sandbox-tsx-db        # paste the returned id into wrangler.jsonc
npx wrangler d1 execute game-sandbox-tsx-db --local  --file=worker/schema.sql   # local dev
npx wrangler d1 execute game-sandbox-tsx-db --remote --file=worker/schema.sql   # before deploy
```

## Architecture

The codebase splits into three independent layers; understanding their boundaries is the key to
working here.

### 1. Pure game logic (`src/game/`) — no React

- `types.ts` — the data model. `SpeciesDef` describes a monster *species* (base stats, growth/cap/
  threshold curves, weighted `evolvesTo` options); `Colony` is a population bucket the player
  actually owns (`speciesId` + `count` + `growth` maturity + `updatedAt`). `GameState` is the
  persisted shape.
- `species.ts` — `SPECIES` (the full evolution tree, ~27 species across 4 tiers) and the pacing
  curves (`EVOLVE_THRESHOLD`, `MATURITY_SECONDS`, `BASE_CAP`, `GROWTH_RATE`, `EVOLVE_BATCH`),
  `typeMultiplier` (the water/fire/earth triangle + light), `capOf`, `swarmBonus`,
  `nestUpgradeCost`. **This is the single source of truth for game balance.** Editing a curve here
  changes growth speed, evolution pacing, and combat stats everywhere. `GROWTH_RATE` is a
  continuous-compounding per-second rate — small changes have an outsized effect (see the comment
  above it for the doubling-time math); don't tune it by feel without recomputing that.
- `logic.ts` — `advanceColonies`, the idle simulation core. Given a colony list and an elapsed
  `dtSeconds`, it grows each population toward its cap, advances maturity, and cascades weighted
  evolutions once a colony is mature and past its threshold — run in bounded fixed-size steps so a
  1s UI tick and a multi-hour offline gap use the exact same code path (long gaps just get coarser
  per-step resolution, capped at `MAX_STEPS` so cost stays bounded). Population inflow from an
  evolution event is clamped to the target's cap same as organic growth — never let a species
  exceed `capOf(...)` regardless of source. Also: `squadMonsterStats` (base stats + capped swarm
  bonus), `dexProgress`, `formatNumber`/`formatDuration`.
- `store.ts` — the Zustand store (`useGame`), wrapped in `persist` (key `clash-of-sandboxes-v1`).
  `partialize` controls exactly which fields persist — **if you add a field to `GameState` that
  must survive reload, add it to `partialize` too.** `tick()` calls `advanceColonies` and writes the
  result straight back to the store, so it must never run before the persisted save has finished
  loading (see the `useGameLoop` gotcha below). Multiplayer actions (`registerPlayer`,
  `ensurePlayer`, `syncSquad`, `fetchOpponent`, `resolveBattle`, `fetchLeaderboard`) call the Worker
  API with `x-player-id`/`x-player-token` headers; `ensurePlayer()` lazily registers an anonymous
  player+token on first use so nothing requires an explicit sign-up step.
- `battle.ts` — `simulateBattle`, a seeded deterministic lane battle (front fighters from each squad
  trade blows until one falls, next steps up) producing a `BattleLogEntry[]` for playback plus a
  win/loss verdict. `squadPower` is the same power formula the Worker uses server-side for the
  leaderboard — keep them in sync if you change it (see gotcha below).

### 2. React UI (`src/components/`, `src/App.tsx`, `src/ui.ts`)

- `ui.ts` holds **ephemeral** UI state (`useUi`: mode home/battle, active sheet, toast queue) —
  deliberately *not* persisted, separate store from `useGame`. It also exports `useGameLoop`, which
  ticks `useGame.tick()` once per second (and on tab `visibilitychange`) and turns any evolution
  events the tick returns into grouped toasts.
- The game has no real-time server tick for idle progress — everything is lazy/closed-form via
  `advanceColonies`, called from `tick()`.
- `App.tsx` is the root switch between **home** (nest/colony view) and **battle** views, plus the
  sheet overlays (`Dex`, `SquadBuilder`, `Leaderboard`, `Settings` from `Sheets.tsx`).
- `BattleView.tsx` fetches an opponent, lets the player start the fight, then reveals
  `simulateBattle`'s log line-by-line before showing the win/loss result and reward.

### 3. Cloudflare Worker (`worker/index.ts`)

A Worker backed by D1 (binding `DB`, schema in `worker/schema.sql`). Routes:

- `GET /api/health`
- `POST /api/player/register` — creates an anonymous player (`crypto.randomUUID()` id + token)
- `POST /api/player/sync` — auth'd; upserts the caller's squad snapshot + computed power
- `GET /api/opponent` — closest-rating real squad, or a synthetic AI squad if none exists yet
- `POST /api/battle/result` — auth'd; Elo-style rating update
- `GET /api/leaderboard` — top players by rating

Everything else falls through to the `ASSETS` binding (SPA fallback configured in `wrangler.jsonc`).

## Cross-cutting gotchas

- **The Worker imports directly from `src/game/`** (`species.ts`, `logic.ts`, `types.ts`) rather
  than duplicating species data — `tsconfig.worker.json` only lists `worker` in `include`, but
  TypeScript still follows and type-checks imports outside that glob, and Vite bundles by import
  graph, not by tsconfig project boundaries, so this works. The wire coupling that *does* exist is
  the `SquadMonster` JSON shape and the `squadPower` formula, which is hand-duplicated in
  `worker/index.ts` (kept deliberately simple/inline rather than imported, since the Worker needs
  its own copy to score squads it never runs `simulateBattle` on) — change one side and check the
  other.
- **`useGameLoop`'s first tick must wait for persist hydration.** `tick()` reads `state.lastTick`
  and writes straight back to the store; if it ran before `zustand/persist` finished loading
  `localStorage`, it would stamp the fresh default state over real saved progress before hydration
  got a chance to restore it. `useGameLoop` guards this with
  `useGame.persist.hasHydrated()` / `onFinishHydration`. Don't add another place that calls
  `tick()` (or otherwise reads/writes `lastTick`) without the same guard.
- **Evolution inflow must respect the population cap.** When a colony cascades into a new species,
  the target bucket's count is clamped with `Math.min(capOf(target, nestLevel), ...)` in
  `advanceColonies` — without that clamp a source colony that cascades many times in one offline
  catch-up can push its target far past its intended cap.
- **Cap must stay above threshold.** Each tier's `BASE_CAP` in `species.ts` is set comfortably above
  that tier's own `EVOLVE_THRESHOLD` so a colony can actually reach the threshold at `nestLevel` 0 —
  nest upgrades (`upgradeNest`, paid in `shineStones`) add headroom, they aren't required to
  progress. If you rebalance one, check the other.
- **No real login** — `ensurePlayer()` mints an anonymous id+token pair stored in `localStorage`
  alongside the rest of `GameState`; there's no password/email, so losing localStorage loses the
  account. This is an intentional MVP simplification, not an oversight.
