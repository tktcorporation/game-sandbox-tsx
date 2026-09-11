# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Sandbox Arcade** — a multi-game React 19 + TypeScript SPA. A single Cloudflare Worker
serves the static assets *and* exposes `/api/raid` for Clash of Sandboxes. No database;
player state lives in the browser via `localStorage`.

The lobby (`src/hub/Hub.tsx`) is the catalog, same idea as `cli-sim-game-escape`'s
`Game` trait + `create_game`. Register a game in `src/catalog.ts` and mount it from
`src/App.tsx` (hash route `#/<id>`).

Current cabinets:

- **Clash of Sandboxes** (`src/games/clash/`) — Clash of Clans–style base builder & raider
- **Tiny Foundry** (`src/games/factory/`) — visual port of Tiny Factory from cli-sim-game-escape
- **モンスターサバイバル** (`src/games/tata/`) — collect 120 tatas, evolve, house, fight zombies

## Commands

```bash
npm install
npm run dev      # Vite dev server + Worker running locally (http://localhost:5173)
npm run build    # tsc -b (type-check) + vite build — run this to verify a change compiles
npm run deploy   # build + wrangler deploy
npm run cf-typegen   # regenerate Worker types from wrangler.jsonc
```

There is **no test runner and no linter** configured. The only verification gate is `npm run build`.
Always run it after changes.

```bash
npm run sim:tata -- 150   # headless balance sim for モンスターサバイバル battles
```

## Designing or improving a game

Use the `game-design-loop` skill (`.claude/skills/game-design-loop/SKILL.md`) before touching
game logic, balance numbers, or a game screen. It defines a game as a loop of
information → decision → verb → feedback, checks that the decision is real, and requires a
headless sim (`scripts/sim/`) plus a target curve
(`.claude/skills/game-design-loop/references/<game>-targets.md`) before any number changes.
Each cycle ends by appending a generalized lesson to
`.claude/skills/game-design-loop/references/lessons.md`; the skill grows from those.

## Architecture

### Catalog / shell

- `src/catalog.ts` — `GameId`, copy, play labels. Adding a game starts here.
- `src/App.tsx` — reads `location.hash`, renders Hub or a game, `onLeave` clears the hash.
- `src/shell/ArcadeBack.tsx` — shared “back to arcade” control.
- Each game owns its CSS, Zustand store, and canvas/DOM view. Do not leak Clash tokens
  into Foundry or vice versa.

### Clash of Sandboxes (`src/games/clash/`)

Pure game logic (`game/`) has no React.

- `game/types.ts` — `BuildingDef`, `PlacedBuilding`, `GameState`
- `game/buildings.ts` — `BUILDINGS` / `TROOPS` + balance curves. **Single source of truth for Clash balance.**
- `game/logic.ts` — capacity, placement, production, town-hall gating
- `game/store.ts` — Zustand persist key `clash-of-sandboxes-v1`. If you add a persisted
  `GameState` field, add it to `partialize` too.
- `game/battle.ts` — real-time battle engine
- `ui.ts` — ephemeral UI (mode, selection, toasts) + 1s `useGameLoop`

Resource production is lazy (`accruedFor`). The 1s loop only drives UI and finishes constructions.

### Tiny Foundry (`src/games/factory/`)

Port of cli-sim-game-escape's Tiny Factory simulation, with a canvas view.

- `types.ts` — grid, machines, belts, items. Machines occupy 2×2; belts auto-route.
- `logic.ts` — pure tick / place / miner-mode. 10 ticks/sec. Keep behaviour aligned with
  the Rust original unless you are changing balance on purpose.
- `store.ts` — Zustand persist key `tiny-foundry-v1`
- `FactoryCanvas.tsx` — pan/zoom, drag-paint belts, interpolated items, particles

Core loop: miner → belt → smelter → (assembler / fabricator) → exporter.

### モンスターサバイバル (`src/games/tata/`)

Collect-evolve-battle-build. Pure logic in `logic.ts` / `battle.ts` / `species.ts`.

- `species.ts` — 120 tata species, 6 elements, 4 evo names. **Single source of truth for Tata identity.**
- `logic.ts` — stamina stroll, feed/evolve, furniture placement, party, nest berries
- `battle.ts` — real-time 3-slot formation vs zombie waves. A raid (`buildRaid(seed)`) is fixed
  before the fight so the prep screen can show the roster; it has a primary/secondary element
  theme, waves open only after the previous one dies (or a grace period), and damage has a
  small seeded swing. Element wheel: fire>grass>earth>water>fire, light↔dark
- `store.ts` — Zustand persist key `tata-survival-v1`. New persisted fields go in `partialize`
- `TataSprite.tsx` — SVG felt bodies by shape/stage/shiny
- Four screens: おうち (yard), おさんぽ (stroll catch), たたかい (formation + waves), ずかん (dex)

Starters are フルッグ / ヒノマル / ネコオリ; ナンモナイシ always tags along. Putting ネコオリ on the pool is a real bonus. Shiny (`ピカ`) can roll on catch or on the stage-3 evolution.

### Cloudflare Worker (`worker/index.ts`)

Stateless. `fetch` routes `/api/raid` and `/api/health`; everything else falls through to
`ASSETS` (SPA fallback in `wrangler.jsonc`). `/api/raid` uses seeded `mulberry32`.

## Cross-cutting gotchas

- **The enemy-base type is duplicated.** `worker/index.ts` and `src/games/clash/game/battle.ts`
  share a JSON shape. The battle engine looks up `type` strings against `BUILDINGS`.
- **Town Hall gates Clash.** Building counts and upgrade levels cap on TH level.
- **Walls don't count** toward Clash destruction percentage.
- Foundry belts are undirected: items remember `itemFrom` and refuse to backtrack.
- Foundry machines that are not miners/exporters need belts on the 2×2 rim to receive input.
