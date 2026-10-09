# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Sandbox Arcade** — three browser games, each built around one decision, in a React 19 +
TypeScript SPA. A single Cloudflare Worker serves the static build (plus `/api/health`).
No database; progress lives in `localStorage` via `src/arcade/save.ts`.

## Commands

```bash
npm install
npm run dev                    # Vite dev server + Worker (http://localhost:5173)
npm run build                  # tsc -b + vite build — the verification gate; run after every change
npm run sim -- <game> [runs]   # headless balance sim: breakwater | wildfire | abyss
npm run deploy                 # build + wrangler deploy
```

There is no test runner and no linter. `npm run build` and the sims are the only gates.

## Designing or changing a game

Use the `game-design-loop` skill before touching rules, numbers, or a game screen. Each game's
target curve and latest sim output live in
`.claude/skills/game-design-loop/references/<game>-targets.md`; change a number only together
with a re-run of its sim and an update to that file.

## Design principles

`docs/game-essence.md` holds 12 principles distilled from ~30 modern games (Into the Breach,
Mini Metro, Balatro, Frostpunk, Marvel Snap, …) and how each cabinet applies them. Read it before
changing a game's UI or feel. Shared rules that follow from it:

- Five signal colours in `src/styles.css` (`--threat`, `--ally`, `--act`, `--gain`, `--push`) mean
  the same thing in every game and are never used for decoration; the world stays desaturated.
- Show the result before commit (diff overlays), resolve step by step with tap-to-skip, scale shake
  and sound with outcome size (`src/arcade/juice.ts`, `src/arcade/sfx.ts`).
- No rule paragraphs on screen: one-line coaching on the first level only.

## Architecture

- `src/arcade/cabinets.ts` is the only registry: id, copy, colours, and a `React.lazy` import.
  Adding a game = one entry here + `src/games/<id>/{logic.ts,Game.tsx}` + `scripts/sim/<id>.ts`.
- `src/App.tsx` routes on `location.hash` (`#/` lobby, `#/<id>` game).
- `src/arcade/rng.ts` keeps RNG state as one integer inside the game state, so states are plain
  data: `structuredClone` gives undo, previews, and deterministic sims for free.
- Game logic never imports React. Views hold state with `useState`; no global store.
- Each game owns its CSS file, scoped under a class prefix (`.bw-`, `.wf-`, `.ab-`).

### 防波堤 (`src/games/breakwater/`)

Telegraphed-attack tactics on a 7×8 grid. Enemies pick a tile and a strike direction during
their plan; strikes resolve **relative to where the enemy stands when the turn ends**, so pushes
redirect them. `endTurn` returns every intermediate state for playback. The view previews any
action by rendering `act(...)` on a clone before committing. Island difficulty lives in
`spawnCount`, `rollKind`, and `enemyHp`. Each island uses a fixed seed so retries are the same puzzle.

### 延焼線 (`src/games/wildfire/`)

Cellular fire on a 14×20 grid, one `step` per 800 ms. Spread is strongly downwind; embers can
jump one tile downwind, so single-tile breaks leak. The wind never blows north and its next
direction is forecast with a countdown. Rendering is a canvas `requestAnimationFrame` loop
separate from the simulation tick.

### 深淵採掘 (`src/games/abyss/`)

Incan-Gold-style push-your-luck. One deck per dive: 15 gems + 5 hazard kinds × 3. A second copy
of a seen hazard collapses the dive and permanently removes that card. Gem value multiplies by
depth tier. The view shows remaining deck counts so the odds are readable. Shop items are tuned
so buying is a real choice (see the abyss targets file).
