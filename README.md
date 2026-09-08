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
| **モンスターサバイバル** | Collect 120 felt tatas, feed them through four evolutions, house them, and fight zombie waves |

Tiny Foundry keeps the original simulation (2×2 machines, auto-routing belts, iron/copper
lines, circuits) and rebuilds the view: interpolated items, rolling belts, furnace sparks,
and export bursts instead of terminal cells.

## Assets

Two catalogs, both Font-Awesome-style (`import` a name, use it):

| Layer | Pack | License | Where |
| --- | --- | --- | --- |
| **HUD glyphs** (buttons, chrome) | [Game-icons.net](https://game-icons.net/) via [`react-icons/gi`](https://react-icons.github.io/react-icons/icons/gi/) | CC BY 3.0 | `src/ui/icons.tsx` |
| **Pixel sprites** (warriors, coins, potions) | [Kenney](https://kenney.nl/assets) Tiny Dungeon + Tiny Town | CC0 | `src/assets/kenney.ts` |

Village / battle *buildings* are still drawn procedurally (`src/games/clash/render/iso.ts`). Troops, loot pops and resource chips use Kenney 16×16 sprites.

Named imports are tree-shaken — only the tiles you import land in the bundle:

```ts
import { barbarian, coin } from "./assets/kenney";
import { Pixel } from "./assets/Pixel";
import { drawKenney } from "./assets/drawPixel";

<Pixel src={barbarian} size={48} />
drawKenney(ctx, coin, x, y, 24);
```

Add another pixel: drop a PNG into `src/assets/kenney/`, add one `export { default as myTile } from "./kenney/my-tile.png"` in `src/assets/kenney.ts`, then import `myTile`. Do not `import * as Kenney`.

Kenney publishes dozens of matching Tiny packs (Battle, Farm, RPG, …) — same 16×16 style, all CC0.

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
src/App.tsx                 hash router: lobby / clash / factory / tata
src/catalog.ts              game list (add an entry here to register a game)
src/hub/Hub.tsx             arcade lobby
src/games/clash/            Clash of Sandboxes
src/games/factory/          Tiny Foundry (logic + canvas)
src/games/tata/             モンスターサバイバル (collect / evolve / house / raid)
src/ui/icons.tsx            Game-icons.net catalog (react-icons/gi) used by Clash HUD
src/assets/kenney.ts        tree-shakeable Kenney Tiny URL exports (CC0)
src/assets/gameSprites.ts   troop/resource picks actually used by Clash
src/assets/drawPixel.ts     canvas blit for imported sprite URLs
src/assets/Pixel.tsx        <Pixel src={coin} /> / <PixelText>
worker/index.ts             SPA + /api/raid, /api/health
```

Hash routes: `#/clash`, `#/factory`, `#/tata`. Empty hash is the lobby.

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

No database. Clash progress uses `clash-of-sandboxes-v1`; Foundry uses `tiny-foundry-v1`; Tata uses `tata-survival-v1`.

## API

- `GET /api/raid?th=<1-6>&seed=<n>` → a procedurally generated enemy base (deterministic per seed).
- `GET /api/health` → liveness check.
