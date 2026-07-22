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
  win/loss verdict. The client runs it locally for the instant log/result animation; the Worker
  imports the same function to independently re-derive the real outcome before touching ratings
  (see the Worker section and gotcha below) — it is the single source of truth for combat math,
  don't fork it.

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
- `POST /api/player/sync` — auth'd; client sends `{speciesId, count}[]`, the Worker looks up each
  `speciesId` against the real `SPECIES` table and calls `squadMonsterStats` itself to compute the
  stored stats/power — never trusts client-supplied combat stats (`buildValidatedSquad`)
- `GET /api/opponent` — auth'd; matchmaking always uses the caller's own server-side rating (never
  a query param) — closest-rating real squad, or a synthetic AI squad if none exists yet
  (`generateAiSquad(rating, seed)`). First force-resolves any still-pending match ticket of the
  caller's *as a loss* (see gotcha below), then mints a fresh single-use **match ticket** in the
  `matches` table pinning that exact opponent snapshot + the caller's *own current squad snapshot*
  + a server-chosen `battleSeed`, and returns `{..., matchId, battleSeed, mySquad}`. A partial
  unique index (`matches(player_id) WHERE used_at IS NULL`) enforces at most one live ticket per
  player, so two concurrent calls can't both mint a ticket to cherry-pick from
- `POST /api/battle/result` — auth'd; client sends only `{matchId}`. The Worker atomically claims
  the ticket (`UPDATE ... WHERE used_at IS NULL AND expires_at > now`, rejecting anything already
  used/expired/unknown), then re-simulates the battle itself from the ticket's pinned *both* squads
  + seed — never re-reading `squads` at submission time — and derives the Elo update from that. A
  client can't claim a fabricated win, pick its own opponent/seed to brute-force a favorable
  outcome, replay a match twice, or re-sync a counter-pick after seeing the opponent
- `GET /api/leaderboard` — top players by rating

Everything else falls through to the `ASSETS` binding (SPA fallback configured in `wrangler.jsonc`).

## Cross-cutting gotchas

- **The Worker imports directly from `src/game/`** (`species.ts`, `logic.ts`, `types.ts`,
  `battle.ts`) rather than duplicating game logic — `tsconfig.worker.json` only lists `worker` in
  `include`, but TypeScript still follows and type-checks imports outside that glob, and Vite
  bundles by import graph, not by tsconfig project boundaries, so this works. `squadPower` is still
  hand-duplicated in `worker/index.ts` (kept deliberately simple/inline) — change one side and check
  the other.
- **The Worker never trusts client-reported battle outcomes, combat stats, or match parameters.**
  Earlier drafts trusted whatever the client sent (`monsters` stats, `won`, `opponentRating`, even
  a client-chosen `opponentId`/`battleSeed`, and later a client-chosen matchmaking `rating` query
  param) — that let a client crash other players via an unknown `speciesId`, inflate its own stats,
  claim a fabricated win, or claim a higher rating than it actually has to inflate Elo credit. The
  fix: sync only accepts `{speciesId, count}` and recomputes stats server-side; matchmaking always
  reads the caller's own `players.rating`; `/api/opponent` mints a single-use match ticket pinning
  the exact opponent + seed, and `/api/battle/result` only accepts `{matchId}`, re-simulating from
  that ticket and the caller's *last-synced* squad. If you touch any of these endpoints, keep it
  that way — don't reintroduce a field that lets the client assert its own stats, outcome,
  opponent, seed, or rating.
- **A match ticket pins both squads, not just the opponent's.** Early match-ticket drafts still
  re-read the caller's *current* `squads` row at `/api/battle/result` time — a client could call
  `/api/opponent`, see the opponent's composition, then call `/api/player/sync` again with a squad
  chosen to counter it before submitting the result. `player_monsters` is now captured into the
  `matches` row at mint time and always replayed from there, so nothing synced after seeing the
  opponent can affect an already-minted ticket.
- **Concurrent-safe by construction, not by convention.** The abandoned-ticket forfeit loop and the
  match claim in `/api/battle/result` both use a conditional `UPDATE ... WHERE used_at IS NULL`
  and only act when `meta.changes` shows the row actually changed — never read-then-write without
  that guard, or two racing requests can double-apply a rating change. Minting is guarded the same
  way at the database level: a partial unique index rejects a second concurrent ticket for a player
  who already has one pending, and `/api/opponent` catches that failure and returns 409.
- **Peeking at a match before deciding whether to submit it must not be free.** Because
  `simulateBattle` is deterministic and the opponent + seed are fully disclosed to the client the
  moment `/api/opponent` mints a ticket, a client could otherwise run the battle locally, and only
  ever call `/api/battle/result` for the tickets it would win — silently abandoning the rest costs
  nothing on its own. `/api/opponent` closes this by resolving any of the caller's still-pending
  tickets *as a loss* before minting a new one, so declining to submit an unfavorable match costs
  exactly as much as losing it for real.
- **Known gap: `/api/player/sync` doesn't verify a species was actually discovered, or that
  `count` reflects a real colony.** The server validates `speciesId` against the real species table
  and recomputes stats from it (so a bad id can't crash another player and stats can't be sent
  directly), but it has no independent record of which species a given player has actually evolved
  into or how many they own — that lives only in the client's `localStorage`, by design (see below).
  A client can currently claim any discovered-looking species with an inflated `count` for a
  stronger-than-earned squad. Closing this fully would mean making the server authoritative for
  colonies/dex too, which cuts against the "idle progress lives in the browser" design pillar — this
  is an open decision, not yet resolved one way or the other.
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
