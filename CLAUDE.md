# CLAUDE.md

Two single-player PvE shooters share this Vite project and Cloudflare Worker. Each has its own
page, simulation and gates; they share only `three` and the build.

| Game | Page | Code | Brief |
| --- | --- | --- | --- |
| HITMARK | `/` (`index.html`) | `src/sim`, `src/game`, `src/game3d` | `docs/brief.md` |
| RINGFALL | `/ringfall/` (`ringfall/index.html`) | `src/ringfall/` | `docs/ringfall/brief.md` |

Read the game's brief before changing anything visual. A new page needs an entry in
`environments.client.build.rollupOptions.input` in `vite.config.ts`.

## RINGFALL

A battle-royale-shaped run against robots only: skydive onto an island, clear three POIs while the
ring closes toward the next one, beat the titan, extract. First person on three.js. Robots are
squads placed on the island from the start (`POIS[].squads` and `ROAMERS` in `map.ts`), not waves:
the player finds them and takes them one squad at a time.

```bash
npm run sim:ringfall     # gate 2: bots of three skills play the whole run headless
npm run shots:ringfall   # gate 3: the build played to the end in Chromium; screenshots in shots/ringfall/
```

- `src/ringfall/sim/` is the game: pure TypeScript, metres and seconds, `step(state, input, prevCrouch)`
  per 1/60 s tick. Aim assist (slowdown, pull, the hit cone) lives here, so bots and people get the
  same help. Every solid is an axis-aligned box spanning `y0..h` in `map.ts` (floors, roofs and bridges
  float); build structures with its `building()` (one storey), `tower()` (several storeys with stairs
  inside), `bridge()` and `stairs()` helpers, whose risers stay under the step-up height. Each POI is
  written in its own frame and moved into place by `AT`; the districts between them use island
  coordinates (300 m square, `WORLD.half`). `scatterCover()` then fills the open ground with low walls,
  crates, containers and ruins from a fixed seed, keeping clear of authored points and patrol routes. Tuning numbers are in `config.ts`. `npm run sim:ringfall` first checks that every
  authored point (entries, bins, loot, squad posts, patrols) stands on a floor and not inside a box.
- `awareness.ts` decides who knows about the player: sight cones fill a detection meter, noise
  (shots, sprinting) sends squads to look, and at most `AWARE.maxSquads` squads fight at once.
  A fighting squad tracks the player only while a member sees them (`knownSpot()`), turns at `TURN`
  and fires only ahead, and takes more damage from behind (`FLANK`): going round is the intended play.
  `cover.ts` precomputes the spots grunts hide behind. The sim gate's `crowd` column is the most
  squads / robots fighting at once, and `flank` the share of hits from behind or by ambush; keep them
  within the targets in `docs/ringfall/balance.md`.
- `nav.ts` is ground path finding for the bot only; the game never reads it.
- `src/ringfall/touch.ts` is the phone layout (landscape): a floating stick on the left half, view
  drag on the right half, buttons under the right thumb. It feeds the same `Input` as the keyboard,
  with `input.touch` set so the sim applies `ASSIST.touchPull`. `npm run shots:ringfall` drives it with
  real touch events in a phone-sized viewport before the desktop run.
- `src/ringfall/view/` renders and never changes rules: `world.ts` (three.js), `hud.ts` (DOM),
  `audio.ts` (synthesized). `src/ringfall/main.ts` wires input and the fixed-step loop, and exposes
  `window.render_game_to_text()`, `window.advanceTime(ms)` and `window.ringfallBot(skill)`.
- `docs/ringfall/balance.md` holds the target curve and the latest `npm run sim:ringfall -- 30` output.
  Change a number in `config.ts` or `map.ts` only together with a re-run and an update to that file.

## HITMARK

HITMARK: a single-player shooter for people who love FPS gunfeel but do not enjoy PvP. One
simulation, two views: top-down 2D (Phaser 4) and first-person 3D (three.js), chosen on the title
screen and lazy-loaded. TypeScript + Vite, served by a Cloudflare Worker. The brief, mood, and banned looks are
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
  particles, sound). It never changes game rules. `hud.ts` and `audio.ts` are shared by both views.
- `src/game3d/World.ts` renders the same state in first person: camera yaw is the sim's aim angle
  (1 m = 40 sim px), and 3D-only aids (edge arrows, damage direction) live in the DOM overlay.
- `src/main.ts` exposes `window.render_game_to_text()`, `window.advanceTime(ms)` and
  `window.aimAt(x, y)` (3D) for automation. `npm run shots -- <rooms> 3d,2d` plays both views.

## Dependencies

Pin exact versions in `package.json`; transitive pins go in `overrides`. Do not take a version
published less than 14 days ago unless it fixes a known vulnerability, and say so in the commit.

## Balance

`docs/balance.md` holds the target curve and the latest `npm run sim` output. Change a number in
`src/sim/config.ts` or `ROOMS` only together with a re-run and an update to that file.
