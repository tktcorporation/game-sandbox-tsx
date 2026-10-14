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

An extraction raid against robots only: skydive onto an island, explore it for valuables, and get
off alive by one of three extraction points, all open from the start. No ring and no set order: the
player chooses which POIs to take and when to leave. First person on three.js. Robots are squads
placed on the island from the start (`POIS[].squads` and `ROAMERS` in `map.ts`, some of them
patrolling the roads), plus reinforcements (`REINFORCE` in `config.ts`) that beam in out of sight
on a timer and come looking, and once per raid an elite squad (`RAIDERS` / `ELITE`) that flanks.
Bins take time to search (`SEARCH`) and valuables fill a bag of `BAG.slots`. The HUD shows no
markers or distances; the island map (`view/map.ts`, M) is where the POIs and exits are. A wipe
ends the raid and loses the haul; `results.ts` scores the haul plus cleared POIs.
Between raids the base (`view/hub.ts`) keeps a stash, a trader and the loadout for the next raid:
`src/ringfall/meta/profile.ts` is its pure logic (`takeKit()` out of the stash, `settle()` after a
raid, the pouch that survives a wipe), `meta/storage.ts` saves it in localStorage, and `META` in
`config.ts` holds its numbers. `newRun(seed, kit)` starts a raid from a kit; the default is the
lent free kit, which is what the sim gate plays.
The trader's quests are data in `meta/quests.ts` (`QUESTS`, credited from a raid's `stats` by
`creditRaid()` inside `settle()`). Each POI has one locked bin (`vault: true` in its `bins`), opened
only with that POI's key; keys drop from the bins of the POI named by its `keyFrom` (`VAULT`).
POIs have a stable `id` (`PoiId` in `map.ts`); saves, quests, `keyFrom` and `EXTRA_BINS` refer to a
POI by it, never by its place in `POIS` (the run's state may index `POIS` internally). The profile
is versioned (`Profile.v`), and `parseProfile()` moves older saves forward.

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
  coordinates. The ground is a height field (`terrain.ts`), a dried-up reservoir: the POIs and
  districts are basins (`BASINS`) at their own `LEVEL` (the lakebed at -7 m, the dam crest at +8,
  the quarry pit at -10...), joined by roads (`ROADS`) that ramp between levels, with unclimbable
  high ground between them, shelves inside the POI basins, the spillway canyon, and cliffs beyond
  the coast; ground steeper than `STEEP` is a wall, dropped down but never climbed. The coast is
  the outline of the land masses in `LANDS` (`offshore()` gives how far a point lies outside it),
  and the world's bounds are `WORLD.x0..x1` and `WORLD.z0..z1` in `config.ts`; no code assumes
  either is centred on the origin. Boxes are
  written on ground at 0 and lifted to their area's level by `onLevel()`, points by `onFloor()`
  (`map.ts`); the ground is pressed flat at that level near every authored box and point.
  `scatterCover()` then fills the open ground with low walls,
  crates, containers and ruins from a fixed seed, keeping clear of authored points and patrol routes. Tuning numbers are in `config.ts`. `npm run sim:ringfall` first checks that every
  authored point (entries, bins, loot, squad posts, patrols) stands on a floor and not inside a box.
- `awareness.ts` decides who knows about the player: sight cones fill a detection meter, noise
  (shots, sprinting) sends squads to look, and at most `AWARE.maxSquads` squads fight at once.
  A fighting squad tracks the player only while a member sees them (`knownSpot()`), turns at `TURN`
  and fires only ahead, and takes more damage from behind (`FLANK`): going round is the intended play.
  `cover.ts` precomputes the spots grunts hide behind. The sim gate's `crowd` column is the most
  squads / robots fighting at once, and `flank` the share of hits from behind or by ambush; keep them
  within the targets in `docs/ringfall/balance.md`.
- `ally.ts` is the teammate: it walks the player's footsteps (`State.trail`), shoots only engaged
  robots, revives the player once the self-revive is spent, and is revived with the use key.
  Robots choose between the player and the teammate in `chooseTarget()` (`enemies.ts`); the sim
  gate's `ally` column is its damage share, downs and revives.
- `EXTRACTS` in `map.ts` are the ways off the island; `stepExtract()` in `world.ts`
  runs them (dropship call and its waves in `SHIP_WAVES`, the flare, the waits). The sim gate's
  `exit` column counts which one each run used; the bot's choice depends on its skill.
- `nav.ts` is ground path finding for the bot only; the game never reads it. Robots beamed in from
  afar (reinforcements and raiders, `SquadState.routed`) find their way: `hunt.ts` builds a
  distance field over the ground (2 m cells; cliffs, high ground and boxes a walker cannot step
  over closed) to where they think the player is, and their walkers follow it whenever they cannot
  see whom they are after, fight or not. They beam in a walk of `REINFORCE.dist` away along it.
  Every other robot walks straight at its goal, and nobody paths inside a building.
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
