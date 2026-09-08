# Sandbox Arcade

A tiny **multi-game** React sandbox. Pick a cabinet in the lobby, play, and jump back.
Player state lives in the browser (`localStorage`). A Cloudflare Worker serves the SPA
and generates enemy villages for Clash of Sandboxes.

Inspired by the game-catalog pattern in [cli-sim-game-escape](https://github.com/tktcorporation/cli-sim-game-escape).

## Games

| Cabinet | What it is |
| --- | --- |
| **Clash of Sandboxes** | Clash of Clans–style village builder & raider (the original game in this repo) |
| **Tiny Foundry** | Visual port of Tiny Factory. Lay miners, belts and furnaces, then watch ore flow |

Tiny Foundry keeps the original simulation (2×2 machines, auto-routing belts, iron/copper
lines, circuits) and rebuilds the view: interpolated items, rolling belts, furnace sparks,
and export bursts instead of terminal cells.

## Tech

| Layer        | Choice                                                              |
| ------------ | ------------------------------------------------------------------- |
| UI           | React 19 + TypeScript, plain CSS                                    |
| State        | [Zustand](https://github.com/pmndrs/zustand) with `persist`         |
| Battle / factory | Custom simulations rendered on `<canvas>` via `rAF`             |
| Build        | Vite 6 + `@cloudflare/vite-plugin`                                  |
| Backend/host | A single Cloudflare Worker serving static assets + `/api/raid`      |

## Project layout

```
src/App.tsx                 hash router: lobby / clash / factory
src/catalog.ts              game list (add an entry here to register a game)
src/hub/Hub.tsx             arcade lobby
src/games/clash/            Clash of Sandboxes
src/games/factory/          Tiny Foundry (logic + canvas)
worker/index.ts             SPA + /api/raid, /api/health
```

Hash routes: `#/clash`, `#/factory`. Empty hash is the lobby.

## Develop

```bash
npm install
npm run dev          # vite dev server with the Worker running locally
```

Open http://localhost:5173.

## Deploy to Cloudflare Workers

```bash
npm run build
npx wrangler login   # one-time
npm run deploy
```

No database. Clash progress uses `clash-of-sandboxes-v1`; Foundry uses `tiny-foundry-v1`.

## API

- `GET /api/raid?th=<1-6>&seed=<n>` → a procedurally generated enemy base (deterministic per seed).
- `GET /api/health` → liveness check.
