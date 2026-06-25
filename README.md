# ⚔️ Clash of Sandboxes

A tiny **Clash of Clans–style** base-building & raiding game, built with **React + TypeScript + Vite**
and deployed to **Cloudflare Workers**. The same Worker serves the SPA *and* procedurally generates
the enemy villages you raid.

![stack](https://img.shields.io/badge/stack-Vite%20%2B%20React%20%2B%20Cloudflare%20Workers-orange)

## Gameplay

- **Build your village** on a 16×16 grid: Town Hall, Gold Mines, Elixir Collectors, storages,
  defenses (Cannons, Archer Towers), Walls, Barracks and Army Camps.
- **Gather resources** — mines & collectors fill up over real time; tap to collect (capped by storage).
- **Upgrade everything** — each building has multiple levels with rising costs and build timers,
  gated by your Town Hall level.
- **Train an army** — Barbarians, Archers and Giants, limited by Army Camp housing space.
- **Raid!** — tap **Attack** and the Worker generates a fresh enemy base scaled to your Town Hall.
  Deploy troops by tapping the battlefield; they path to the nearest building (Giants prefer
  defenses) while Cannons and Archer Towers shoot back. Earn **stars**, **loot** and **trophies**
  based on how much you destroy (destroying the Town Hall earns a star — walls don't count toward %).
- Progress is saved automatically to `localStorage`.

## Tech

| Layer        | Choice                                                              |
| ------------ | ------------------------------------------------------------------- |
| UI           | React 19 + TypeScript, plain CSS                                    |
| State        | [Zustand](https://github.com/pmndrs/zustand) with `persist`         |
| Battle       | Custom real-time simulation rendered on `<canvas>` via `rAF`        |
| Build        | Vite 6 + `@cloudflare/vite-plugin`                                  |
| Backend/host | A single Cloudflare Worker (`worker/index.ts`) serving static assets + a `/api/raid` enemy-base generator |

## Project layout

```
worker/index.ts          Cloudflare Worker: serves the SPA + /api/raid, /api/health
src/game/                pure game logic (no React)
  ├─ types.ts            data model
  ├─ buildings.ts        building & troop definitions + balance curves
  ├─ logic.ts            helpers (capacity, placement, production, formatting)
  ├─ store.ts            Zustand store (place / upgrade / collect / train / battle result)
  └─ battle.ts           real-time battle engine
src/components/          React components (Board, ResourceBar, Sheets, BattleView)
src/ui.ts                ephemeral UI state (mode, selection, toasts) + game loop hook
```

## Develop

```bash
npm install
npm run dev          # vite dev server with the Worker running locally
```

Open http://localhost:5173.

## Deploy to Cloudflare Workers

```bash
npm run build        # type-checks, builds the client + Worker bundle
npx wrangler login   # one-time
npm run deploy       # build + wrangler deploy
```

The app is configured in `wrangler.jsonc` with Static Assets (SPA fallback) bound as `ASSETS`.
No database is required — game state lives in the browser; the Worker is stateless and only
generates enemy bases on demand.

## API

- `GET /api/raid?th=<1-6>&seed=<n>` → a procedurally generated enemy base (deterministic per seed).
- `GET /api/health` → liveness check.
