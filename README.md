# 🟢 Monster Nest

A **breeding/collection idle game** with async multiplayer battles, built with
**React + TypeScript + Vite** and deployed to **Cloudflare Workers**. The same Worker serves the SPA
*and* the multiplayer API, backed by **Cloudflare D1**.

![stack](https://img.shields.io/badge/stack-Vite%20%2B%20React%20%2B%20Cloudflare%20Workers%20%2B%20D1-orange)

## Gameplay

- **Grow your nest** — small monsters multiply on their own over time (even while you're away),
  mature, and once a species' population crosses its threshold it rolls a weighted-random evolution
  into a new species. ~27 species across 4 tiers, branching from a single starter slime.
- **Collect the dex** — every newly-evolved species gets logged; discover the whole tree by letting
  colonies grow across multiple sessions.
- **Build a squad** — pick up to 5 discovered species to represent you in battle. Owning a bigger
  colony gives a small (capped) combat bonus on top of the species' base stats.
- **Battle asynchronously** — fight a snapshot of another player's squad (or a synthetic AI squad if
  no real match is available yet). Battles auto-resolve as a seeded, replayable log. Wins/losses
  update an Elo-style rating on the server and feed a leaderboard.
- Idle progress (colonies, dex, squad) is saved automatically to `localStorage`; rating and squad
  snapshots sync to the server for multiplayer.

## Tech

| Layer        | Choice                                                                          |
| ------------ | -------------------------------------------------------------------------------- |
| UI           | React 19 + TypeScript, plain CSS                                                |
| State        | [Zustand](https://github.com/pmndrs/zustand) with `persist`                     |
| Idle sim     | Closed-form-ish stepped simulation (`advanceColonies`) — same code path for a 1s tick and a multi-hour offline catch-up |
| Battle       | Seeded, deterministic round-based auto-battle, replayed as a log               |
| Build        | Vite 6 + `@cloudflare/vite-plugin`                                              |
| Backend/host | A single Cloudflare Worker (`worker/index.ts`) serving static assets + the multiplayer API, backed by D1 |

## Project layout

```
worker/index.ts          Cloudflare Worker: serves the SPA + the multiplayer API
worker/schema.sql         D1 schema (players, squads)
src/game/                pure game logic (no React)
  ├─ types.ts            data model
  ├─ species.ts           evolution tree + balance curves
  ├─ logic.ts             advanceColonies (idle sim), squad stats, formatting
  ├─ store.ts             Zustand store (tick / squad / nest / multiplayer actions)
  └─ battle.ts            seeded auto-battle simulation
src/components/          React components (ColonyView, Sheets, BattleView, ResourceBar)
src/ui.ts                ephemeral UI state (mode, active sheet, toasts) + game loop hook
```

## Develop

```bash
npm install
npm run dev          # vite dev server with the Worker (+ local D1) running locally
```

Open http://localhost:5173. Local dev works out of the box against a placeholder D1 database id —
see below before deploying for real.

## Deploy to Cloudflare Workers

```bash
npx wrangler login                              # one-time
npx wrangler d1 create game-sandbox-tsx-db       # paste the returned id into wrangler.jsonc
npx wrangler d1 execute game-sandbox-tsx-db --remote --file=worker/schema.sql
npm run build                                    # type-checks, builds the client + Worker bundle
npm run deploy                                    # build + wrangler deploy
```

The app is configured in `wrangler.jsonc` with Static Assets (SPA fallback) bound as `ASSETS`, plus
a D1 binding (`DB`) for player accounts, squad snapshots, and the leaderboard.

## API

- `POST /api/player/register` `{ name }` → `{ id, token, name, rating }`
- `POST /api/player/sync` (auth) `{ name, dexCount, monsters: {speciesId, count}[] }` → `{ power }`
- `GET /api/opponent?rating=` (auth) → a matched squad (real player or synthetic AI) plus a
  single-use `{ matchId, battleSeed }` ticket
- `POST /api/battle/result` (auth) `{ matchId }` → `{ rating, won }` — the server re-simulates the
  battle itself from the ticket and the caller's last-synced squad; it never trusts a claimed outcome
- `GET /api/leaderboard?limit=` → `{ entries }`
- `GET /api/health` → liveness check

Auth headers: `x-player-id`, `x-player-token` (minted by `/api/player/register`).
