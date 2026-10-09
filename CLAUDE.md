# CLAUDE.md

HITMARK: a single-player top-down shooter for people who love FPS gunfeel but do not enjoy PvP.
Phaser 4 + TypeScript + Vite, served by a Cloudflare Worker. The brief, mood, and banned looks are
in `docs/brief.md`; read it before changing anything visual.

## Commands

```bash
npm run dev        # Vite dev server
npm run build      # tsc -b + vite build (gate 1)
npm run sim        # headless bot plays every room; fails on broken invariants (gate 2)
npm run shots      # Playwright: plays the build, fails on console errors, saves screenshots (gate 3)
```

A feature is done only when all three gates pass and the screenshots have been looked at.

## Architecture

- `src/sim/` is the game: pure TypeScript, no Phaser, no DOM. `step(state, input)` advances one
  fixed 1/60 s tick. RNG state lives inside the state. Tuning numbers live in `src/sim/config.ts`.
- `src/game/` renders the state with Phaser and turns `state.events` into feel (shake, hit-stop,
  particles, sound). It never changes game rules.
- `src/main.ts` exposes `window.render_game_to_text()` and `window.advanceTime(ms)` for automation.

## Dependencies

Pin exact versions in `package.json`; transitive pins go in `overrides`. Do not take a version
published less than 14 days ago unless it fixes a known vulnerability, and say so in the commit.

## Balance

`docs/balance.md` holds the target curve and the latest `npm run sim` output. Change a number in
`src/sim/config.ts` or `ROOMS` only together with a re-run and an update to that file.
