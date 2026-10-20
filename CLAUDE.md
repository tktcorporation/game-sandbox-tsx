# CLAUDE.md

Two single-player PvE shooters share this Vite project and Cloudflare Worker. Each has its own
page, simulation and gates; they share only `three` and the build.

| Game | Page | Code | Brief |
| --- | --- | --- | --- |
| HITMARK | `/hitmark/` (`hitmark/index.html`) | `src/sim`, `src/game`, `src/game3d` | `docs/brief.md` |
| RINGFALL | `/ringfall/` (`ringfall/index.html`) | `src/ringfall/` | `docs/ringfall/brief.md` |

The root page (`/`, `index.html`) only lists the games and links to each; a new game gets a card
there. Read the game's brief before changing anything visual. A new page needs an entry in
`environments.client.build.rollupOptions.input` in `vite.config.ts`.

## RINGFALL

An extraction raid against robots only: walk in from the edge of one of two regions of one world,
explore it for valuables, and get off alive by one of its extraction points, all open from the start. No ring
and no set order: the player chooses which POIs to take and when to leave. First person on three.js.
The reservoir (south, +z) has four POIs and three ways off; the harbor (north, beyond a mountain
belt) has three POIs and a boat. A pass road from the landing pad and a railway (an embankment from
the east mesa, a bridge over a gorge, a viaduct into the harbor) join them, so a raid may walk from
one to the other. The world is about 1200 by 1880 m (`WORLD` in `config.ts`): the reservoir's island
(about 1120 by 820 m) with the dune coast bulging south of it, a mountain belt at z about -350, and
the harbor's land (radius about 425 m). The reservoir is built at the scale of real places, its
neighbouring POIs and districts 250 to 400 m apart; the harbor's POIs stand 170 to 330 m apart
and are still to be rebuilt the same way.
`REGIONS` in `map.ts` gives each region its POIs, ways off and ways in on foot (`ENTRIES`: a named
point out on its open ground, facing in, out of every robot's sight for the first seconds);
`newRun(seed, kit, region, { entry })` starts on the ground there with the teammate beside the
player (the reservoir and its first way in by default), and the base picks the region and the way
in. There is no drop from the air. The base offers only the ways in the player knows
(`Profile.entries`): a new profile knows the reservoir's first (`FIRST_ENTRY`), and a raid marks
each way in the player walks to, within `ENTRY.radius` on its ground, in `State.found` (the start's
own included; `stepEntries()` in `world.ts`, an `entryFound` event for the HUD's toast), which
`settle()` adds to the profile only when the raid got off alive (`Settlement.learned`). A region
with no known way in and no depot on cannot be chosen (`canStartIn()`); the HUD and the world map
are handed the known list (`Hud.setKnown()`), and each way in has a campfire and signboard in the
view (scenery, no boxes).
Robots are squads placed in the world from the start (`POIS[].squads`, four squads per POI, of two
robots but for the relay's equipment shed and the wreck's beach, which have three: eight or nine a
POI, fought a squad or two at a time (the pad holds the titan and its drones)), and a few `ROAMERS` in `map.ts`, most of them patrolling the roads), drone
packs that fly long loops over the ground between the POIs (`PACKS` in `map.ts`, `PACK` in
`config.ts`: a squad's `sight` noticing from further than its kind's `SIGHT`), and hunting parties
that walk from stop to stop of their region (`PARTY_STOPS` in `map.ts`, `PARTY` in `config.ts`,
`stepParties()` in `world.ts`), replaced out of sight a while after they are wiped out; plus
reinforcements (`REINFORCE` in `config.ts`) that beam in
out of sight on a timer and come looking, and once per raid an elite squad (`RAIDERS` / `ELITE`)
that flanks. The packs' starts and the parties' line-ups, stops, spawns and waits draw on a
random stream of their own (`roamRand()`, `State.roamRng`), so they do not shift the rest of the
raid's draws. Bins take time to search (`SEARCH`) and valuables fill a bag of `BAG.slots`. The HUD
shows no markers or distances, and lists only the ways off of the region the player is in
(`regionHere()`); the world map (`view/map.ts`, M) is where the POIs and exits of both regions are; it opens framed
on the region the player is in (`Region.bounds`) and N switches it to the whole world.
A wipe ends the raid and loses the haul; `results.ts` scores the haul plus cleared POIs.
Between raids the base (`view/hub.ts`) keeps a stash, a trader and the loadout for the next raid:
`src/ringfall/meta/profile.ts` is its pure logic (`takeKit()` out of the stash, `settle()` after a
raid, the pouch that survives a wipe), `meta/storage.ts` saves it in localStorage, and `META` in
`config.ts` holds its numbers. `newRun(seed, kit, region)` starts a raid from a kit; the default is
the lent free kit, which is what the sim gate plays; `Profile.region` and `Profile.entry` remember
the last start.
The trader's quests are data in `meta/quests.ts` (`QUESTS`, credited from a raid's `stats` by
`creditRaid()` inside `settle()`). Each POI has one locked bin (`vault: true` in its `bins`), opened
only with that POI's key; keys drop from the bins of the POI named by its `keyFrom` (`VAULT`).
POIs have a stable `id` (`PoiId` in `map.ts`); saves, quests, `keyFrom` and `EXTRA_BINS` refer to a
POI by it, never by its place in `POIS` (the run's state may index `POIS` internally). The profile
is versioned (`Profile.v`, which is 12), and `parseProfile()` moves older saves forward (a save from
before the ways in starts at its region's first way in; a save from before ways in were learned
knows them all; a save from before v12 drops its explored map, since `cellOf()` follows `WORLD`,
which then grew wider) and moves its
start to one it may choose (`allowedStart()`).
Each POI has a depot on its road (`DEPOTS` in `map.ts`, run by `stepDepots()` in `world.ts`): walking
up switches it on for good, its use key sends the bag home (it survives a wipe) or, with the bag empty,
leaves the raid there; neither works while a robot fighting the player is within `DEPOT.safe`. The profile keeps the depots on (`Profile.depots`), from
which `newRun(seed, kit, region, start)` may begin on the ground, and the explored map (`Profile.seen`).
A start from a depot carries a limited loadout: `loadoutCost()` prices stash weapons, armour and keys
(the lent kit and heals are free), `depotAllowance()` gives the depot's level and budget from the
credits' worth sent through it (`Profile.depotSent`, added up in `settle()` from `State.sentVia`), and
`takeKit(p, loadout, from)` refuses a loadout over it (`fitsStart()`); the numbers are in `DEPOT`.
Some ways are blocked until a tool opens them for good: `ROUTES` in `map.ts` (a stable `RouteId`,
the tool, the obstacle boxes `closed`, what stands once open `open`, and for a way through rock a
`carve`, a trench cut into the terrain only while the route is open). The tools (`TOOLS` in
`config.ts`) lie in the bins of one POI each, decided by `toolIn()` in `world.ts` from the raid's
seed and the bin, never from `rand(s)`; they fill bag slots (`Player.tools`, `bagLoad()`), are taken
with the use key (the bot passes `Input.leaveTools`), go home through a depot (`State.sentTools`) or
the pouch, and `settle()` spends each one home on the first of its routes still closed
(`Profile.routes`, `Settlement.opened`). `newRun(seed, kit, region, { routes })` plays in the world
with those routes open: `routes.ts` keeps one world in place at a time (`useRoutes()`, called by
`newRun()` and every `step()`), carving the terrain (`carveTerrain()`), swapping the routes' boxes in
the collision grid (`setRouteBoxes()` in `geom.ts`) and dropping the bot's and the hunters' grids
(`resetNav()`, `resetHunt()`); the view rebuilds the chunks a route touches when `worldKey()`
changes. With every route closed the terrain, the map's boxes and the walkers' grids are the ones
before routes existed, and the obstacles stand in cliffs and on a deck where path finding does not
go (its grids and its sight checks, `los(a, b, true)`, leave them out).
The hideout is the long-term goal: modules built level by level from specific valuables and
credits taken from the stash (`build()` in `profile.ts`; levels, costs and prerequisites in
`HIDEOUT`, effects in `HIDEOUT_EFFECT`, both in `config.ts`; `meta/hideout.ts` holds the pure
helpers). Their benefits act in the meta: `takeKit()` lends the infirmary's heals, `wares()` sells
up to `shopRarity()`, `stashCap()` and `pouchSlots()` grow, and the radio reports the next raid's
boosted POI. Every raid leans one POI's bins of its region to a rare kind (`State.boost`, from
`boostFor(seed, region)` in `state.ts`, without drawing on the raid's random numbers);
`Profile.seed` is the next raid's seed, fixed at the base so the report comes true. The escape
craft is the last module: its last stage records `Profile.escaped` and the hub shows the ending
once; play goes on. Build quests (`{ t: "build" }`) finish at the base (`claimBuilt()`).
`sources()` derives where each valuable is found from the loot data (`loot.valuable`, `TOP_BINS`,
`VAULT`, `ROBOT_DROPS`), for the hub's hints.

```bash
npm run sim:ringfall     # gate 2: bots of three skills play whole raids headless, in each region,
                         # then the hideout's pacing replays the meta with those raids; raids run
                         # in parallel, one process per core, the reservoir's (the longest) first
                         # (RINGFALL_SIM_JOBS=n to set, 1 = in turn)
npm run shots:ringfall   # gate 3: the build played in Chromium (a reservoir raid to the end, a harbor raid
                         # to its first fight, a tour of both); screenshots in shots/ringfall/
```

- `src/ringfall/sim/` is the game: pure TypeScript, metres and seconds, `step(state, input, prevCrouch)`
  per 1/60 s tick. Aim assist (slowdown, pull, the hit cone) lives here, so bots and people get the
  same help. Every solid is an axis-aligned box spanning `y0..h` in `map.ts` (floors, roofs and bridges
  float); build structures with its `building()` (one storey), `tower()` (several storeys with stairs
  inside, at both ends with `twin`), `bridge()` and `stairs()` helpers, whose risers stay under the
  step-up height, `shell()` (four walls with holes for doors and windows, which must not overlap),
  and the larger pieces made of them: `hall()` (a shed with roller doors, mezzanines and columns),
  `catwalk()`, `gantry()`, `rowHouses()`, `compound()` (a walled yard with gates), `tank()` and
  `lattice()` (an open steel tower with stairs); `lift()`
  raises a structure onto a deck and `paint()` repaints its walls (a ship's hull as steel plate).
  `mezzanine()` is `hall()`'s mezzanine on its own, `disc()` a round of columns, `dish()` a tilted
  parabolic dish of columns, and `strand()` / `stay()` a cable as blocks stepping along it.
  Each POI's buildings are a function of its own (`supply()`, `quarry()`, `relay()`, `pad()`,
  `wreck()`, `yard()`, `smelter()`), as is each district's (`heartTown()`, `damFace()`,
  `plateau()`, `village()`, `factory()`). The helpers take their sizes from a `Scale` (storey,
  walls, doors, windows, roller doors, stair width): `WORKS` for industry (4.5 m storeys,
  half-metre walls, doors 2.4 by 2.8 m, roller doors 6 m high), `HOME` for homes and farms
  (3.2 m storeys, larger rooms and windows), `INTAKE` for the dam's intake tower (5 m storeys), and
  the older `HOUSE` (3.4 m) for the harbor and the drowned town. A function that builds on more
  than one floor returns `Floors` (each group of boxes with the level it stands on; a `loose` group,
  such as a catwalk out over a cliff, is lifted without pressing the ground under it). The
  reservoir's POIs, built to these scales:
  - the supply depot (`WORKS`, about 220 m across, on the dune coast), the base's plant for the
    ring's segments: the assembly hall (`ASSEMBLY`, 150 by 40 m and 40 m high) with a ring segment
    60 m long half built on its floor (`SEGMENT`, `ringSegment()`), overhead cranes whose runway is
    walked from an open stair tower to a cab, one crane fallen onto the floor in steps walked up to
    a mezzanine, its south cladding torn open over the segment (`GASH`) and the rails out of its
    segment door; a long shed 66 m long, a four-storey office block, silos 32 m high, a beached
    tanker whose bow rises 38 m, a watchtower sunk two storeys into a dune, dunes up to 13 m and a
    bluff 26 m over its west side;
  - the quarry (about 250 by 140 m of terraces, rust-red bedrock): a rim yard at 0 with the
    processing plant, terraces at -7 and -16 and the floor at -25, joined by haul roads, iron
    stairs bolted to the terrace walls and a tunnel cut from the top terrace down to the floor
    under the middle one; its landmarks are the bucket-wheel excavator on the top terrace's east
    end (`BWE`, `excavator()`: a machine house climbed by a stair tower, a mast 48 m high, and a
    boom whose walkway steps down over the middle terrace to a cab, the wheel 18 m across cutting
    into the pit's edge) and the conveyor from the plant down to the floor;
  - the relay (an orange sandstone mesa, 170 by 100 m on top at +27.5, cliffs 22 m to its foot):
    the base's station for talking to the ring: a dish 56 m across tilted west (`BIG_DISH`,
    `dish()`), its rim 49 m over the top and its lowest edge reached by a stair tower, two small
    dishes, a red-and-white mast 62 m over the top, the equipment block and a walled compound,
    reached by a road up the scree and a ledge cut into the south face, or by a stair tower bolted
    to the west cliff;
  - the landing pad (a concrete plateau 245 by 135 m at +16 on top of a dam 30 m high over the
    lakebed): the titan's arena, a runway, two hangars, the control tower, and in front of the
    dam the intake tower (stairs down from the crest, windows over the lakebed, shut at the
    bottom) and the outflow pipes; north of it, in the `anchor` area's frame, the tether's anchor
    (`anchor()`, sized by `ANCHOR`): a round plinth 84 m across built of `disc()` columns, flush
    with the pad and so walked onto from it (stairs up from the ground on its north and west), a
    clamp ring on it, and the tether's broken shaft, 22 m square and up to 104 m over the pad,
    with a steel scaffold nine storeys up inside it to a windowed gallery.
  The world was the ground base of an orbital ring (the brief's 「世界の由来」), and the fallen
  tether lies east and west through the anchor in four lengths 12 m across (`TETHER`, each a
  `tetherPiece()`): the root end, its back level with the plinth's top; a corridor through the
  one west of the pass road; rubble stairs up the side of the far west one; gaps between them to
  walk through. Steel tints 5 to 7 are the tether's composite skin, its ribs and its scorch.
  The districts: the drowned town on the lakebed (-14 m, 150 by 210 m, mud banks up to 7 m, a
  church spire, roofs sticking out of the mud, the old bridge's piers, a sunken bus), the
  plateau over its west side, the terraced fields climbing in 4 m steps from +2 to the hill at
  +14 (farmhouses, barns, a windmill, a temple, chest-high dry-stone walls), and the works and
  housing on oil-stained concrete (a sawtooth shed, a water tower 28 m high, a multi-storey car
  park, four blocks of flats). The marsh in the south-west is still open ground.
  The world is laid out area by area (`areas.ts`): each area (a POI with the ground round it, a
  district, the harbor's bay in one piece, the heart of the reservoir round the drowned town) is
  written in a frame of its own, shared by its basins in `terrain.ts` and everything built on it
  in `map.ts`, and `AREA` places that frame in the world (`POI_AT` places each POI's own frame
  inside its area's, which `AT` in `map.ts` follows). The roads, cuts and crags between areas, the
  railway's viaduct and the ways in are written in world coordinates; `FRAMES` names every frame
  (areas as `area:` and the id) for the shots gate's cameras. The ground is a height field (`terrain.ts`): the POIs and districts are basins
  (`BASINS`) at their own `LEVEL` (the quarry floor at -25 m, the lakebed at -14, the harbor's
  salt flats at -3, the fields from +2 to +14, the pass at +15, the dam crest and the pad at +16,
  the mesa at +27.5...), joined by roads (`ROADS`) that ramp between levels, and canyons (`CUTS`:
  the spillway, the gorge under the railway bridge). Nested walled basins make terraces (the
  quarry's): the lowest shape at a point wins, so each sits inside the one above it. Shelves
  (`SHELVES`) can still run along a basin's wall, though none does now. Between them lies open walkable ground, the "ground between" (`betweenAt()`,
  surface `野`): a smooth surface relaxed to meet every basin and road at its level, with low
  rolling hills. Shapes marked `walled` (the lakebed, the quarry pit and most ramps cut into them,
  the railway's embankments, the channel, the headland) take no part in it and keep cliffs all
  round. Unclimbable high ground (capped near `HIGH`, 28 m) is left only in `CRAGS` (the mountain
  belt between the regions and rock outcrops) and beyond the coast; ground steeper than `STEEP` is
  a wall, dropped down but never climbed. Each shape may name its `ground` (`Ground`: dune, mud,
  quarry, sandstone, scrub, oiled, concrete, salt, paved), the colour the renderer and the world
  map paint it in (`groundOf()`); the quarry's and the mesa's also colour the cliffs round them
  (`cliffGround()`). It changes no rule. A road's levels are spaced evenly
  along it, or belong to its points with `atPoints`; a ramp reaches the level of the basin it runs
  into at that basin's edge, or it ends in a cliff. The coast is the outline of the land masses in
  `LANDS` (`offshore()` gives how far a point lies outside it), and the world's bounds are
  `WORLD.x0..x1` and `WORLD.z0..z1` in `config.ts`; no code assumes either is centred on the origin.
  The railway bridge's deck is in `DECKS` (`map.ts`): the bot's and the hunters' path finding and
  the robots' `groundLevel()` treat it as ground, which is how they cross between the regions on it;
  everything else built up off the ground is out of their reach. Boxes are
  written on ground at 0 and lifted to their area's level by `onLevel()`, points by `onFloor()`
  (`map.ts`); the ground is pressed flat at that level near every authored box and point. What
  must stand on a cliff without pressing it (the quarry's conveyor and iron stairs, `cliffStairs()`,
  the stone steps between the fields, the roofs in the mud banks) is laid once the ground is
  built (`LAID`). The ways into the lakebed, the quarry, the pad, up the mesa and through the
  fields are among `KEPT_ROADS`: kept clear of scattered cover and pressed along their middle.
  Hamlets (`HAMLET_FRAMES` in `map.ts`: a few buildings and a bin or two, no robots) stand on the
  ground between, each flat at the level under its middle. Outposts (`OUTPOSTS`: in the harbor a
  substation, a fuel depot, a marshalling yard, a wharf and an engine depot; in the reservoir a
  substation and a pumping station) are larger ones, each with a squad of two (`Hamlet.guard`,
  joined to `ROAMERS`) and its whole yard pressed flat. From them the works run to the POIs
  (`WORKS_LINES`, laid once the ground is built): power lines on pylons, pipelines high enough to
  walk under, and a freight line and its spur with wagons left on them as cover.
  `scatterCover()` then fills the open ground with set pieces in real sizes (sandbag lines,
  road-barrier rows, pallet stacks, container clusters, wrecked trucks, rock outcrops and roofless
  ruins, the vehicles and small things as `prop` boxes drawn by `buildProp()`), each
  region from its own grid and seed (`SCATTER`), sparse on the salt flats and only in clumps
  (`clump()`) on the ground between, keeping clear of
  authored points, patrol routes and the roads that are the only ways between areas (`KEPT_ROADS`,
  also pressed to their own floor). Its clearance tests and the terrain's shapes are looked up in
  spatial buckets (`Near` in `map.ts`, `BUCKETS` in `terrain.ts`, checked against a full scan by
  `checkTerrainIndex()` in the sim gate), so loading stays fast as shapes are added. Places that
  scripts and the world map name are data in `map.ts` (`FRAMES`, `LANDMARKS`, `STOPS`).
  Tuning numbers are in `config.ts`. `npm run sim:ringfall` first
  checks that every authored point (POI entries, ways in, bins, loot, squad posts, patrols) stands
  on a floor and not inside a box, and that the pass and the railway bridge are walkable end to end;
  `checkRoutes()` walks each route closed (the long way round) and open (straight through), with
  the authored points checked again in the world with every route open.
- `awareness.ts` decides who knows about the player: sight cones fill a detection meter, noise
  (shots, sprinting) sends squads to look, and at most `AWARE.maxSquads` squads fight at once.
  A fighting squad tracks the player only while a member sees them (`knownSpot()`), or for up to
  `AWARE.coverHold` while members sit at cover and the player has not moved off (`stepSquads()`).
  Members get their first shot one after another, nearest first (`AWARE.react`); a grunt fires its
  first burst from the open, strafing (`Enemy.opener`), and takes cover after it. A robot turns at `TURN`
  and fires only ahead, and takes more damage from behind (`FLANK`): going round is the intended play.
  Robot shots (`SHOT`, `ENEMIES[].orbSpeed`: 110 to 140 m/s, all but the titan's rockets) cross 40 m
  in about 0.3 s, too fast to sidestep once seen; they are led, re-aimed for every shot while the
  robot sees its target, and stray more with distance. A fighting robot fires at a target it sees
  out to its engaged sight (`SIGHT[].range` times `AWARE.engagedRange`); its preferred distance
  (`ENEMIES[].range`) only steers where it walks. A hit from beyond the robot's engaged sight is
  answered (`RETURN`, `shotFromAfar()` and `fireRange()` in `awareness.ts`): for a few seconds after
  each such hit the squad's grunts and heavies see and fire out to `RETURN.range`, and members
  without a line walk toward the shot; that far off the bolts' stray makes the fire mostly
  suppressing. A burst starts only with the target in sight, so
  the glow means "get behind something", not "step aside". A squad of two or more that has had the
  player pinned to one spot for a few seconds, or has seen them backing away, sends members round it to either side
  (`PINCH`, `pinchSpot()` in `enemies.ts`). A squad that loses sight goes after the player
  (`PURSUE`, `stepSquads()` and `pursuitSpot()`): to the last sighting carried on along their
  motion, its members split to either side of it and then sweep round it; the player's sounds
  and hits on it tell it where they are now (`learnSpot()`), and it gives up only after
  `AWARE.chaseTime` without news. Aim pull (`ASSIST.pull`) works while aiming down sights, not for hip fire on the
  move; healing is slow and heard (`HEALS`, `NOISE.heal`).
  `cover.ts` precomputes the spots grunts hide behind. The sim gate's `crowd` column is the most
  squads / robots fighting at once, and `flank` the share of hits from behind or by ambush; keep them
  within the targets in `docs/ringfall/balance.md`. Its `meet` column is how often the player meets
  robots: the seconds to the first fight, the longest stretch with none, and the squads met per
  raid (of them, those of no POI).
- Some robots wear armour plates (`Enemy.plate`, a rarity tier): body hits from a weapon of lower
  rarity are cut by `PLATE` in `config.ts`, weak points pass in full. Each POI's vault guard
  (`Member.plate` in `map.ts`) and the raiders (`RAIDERS.plate`) wear them.
- `ally.ts` is the teammate: it walks the player's footsteps (`State.trail`), shoots only engaged
  robots, revives the player once the self-revive is spent, and is revived with the use key.
  Robots choose between the player and the teammate in `chooseTarget()` (`enemies.ts`); the sim
  gate's `ally` column is its damage share, downs and revives.
- `EXTRACTS` in `map.ts` are the ways off; `stepExtract()` in `world.ts` runs them: a pickup with
  `call` (the dropship, the boat) is called by standing in it and comes after its time, while robots
  beam in round its `waves` point out of the player's sight and come to look at the pickup (`SHIP_WAVES`; `State.calls` keeps each call); the flare; the waits.
  The sim gate's `exit` column counts which one each run used; the bot leaves by a way off of the
  region it started in, chosen by its skill, and takes only that region's POIs. The gate's raids
  start at the region's ways in in turn (raid `r` at way `r` mod their count).
- `nav.ts` is ground path finding for the bot only (built on first use); the game never reads it.
  Its A* estimates with landmarks (`LANDMARKS`: each POI's middle and the ways off, each with the
  walking distance from it, and for searches that go round the titan's sight the walk round its
  post), so a search stays narrow and still finds a shortest way; the bot keeps a path for as
  long as it serves (`replan()` in `bot.ts`). Robots beamed in from
  afar (reinforcements and raiders, `SquadState.routed`) find their way: `hunt.ts` builds a
  distance field over the ground (2 m cells; cliffs, high ground and boxes a walker cannot step
  over closed) to where they think the player is, and their walkers follow it whenever they cannot
  see whom they are after, fight or not. They beam in a walk of `REINFORCE.dist` away along it,
  and keep re-learning where the player is (`stepReinforce()` in `world.ts`) until one of their
  walkers has found the player itself: a fight only their drone joined, over a cliff, does not
  end the hunt. Walkers of any fighting squad follow such a field too while they cannot see the
  player, out to `PURSUE.reach` metres of walking (`huntStep()` in `enemies.ts`): one field per
  squad, toward the spot it is after, each member leaving it for its own point beside the spot
  only near it (`sideStep()`). Hunting parties walk to their stops by the whole world's field
  (`tripStep()`) but fight as any squad does. Patrols walk their legs straight; a robot a chase took more than
  `STRAY` metres off its post or its leg walks back by a field (`homeStep()`). A short field
  costs its reach, not the grid. Only the player's own sounds and shots re-locate a squad, not
  the teammate's. Robots off the open ground (on a
  roof, inside a building) walk straight at their goal, and nobody paths inside a building.
  The fields are kept for reuse within a raid only: `newRun()` drops them, so a raid plays the
  same whatever ran before it, which is what lets the sim gate share raids among processes.
  The bot (`bot.ts`) opens only bins on the ground and does not climb: each POI keeps ground bins
  by its ways in and floors, and the bot walks the ground's paths up to robots on higher ground (a
  terrace, the mesa) rather than looking for an angle on them from below.
- `src/ringfall/touch.ts` is the phone layout (landscape): a floating stick on the left half, view
  drag on the right half, buttons under the right thumb. It feeds the same `Input` as the keyboard,
  with `input.touch` set so the sim applies `ASSIST.touchPull`. `npm run shots:ringfall` drives it with
  real touch events in a phone-sized viewport before the desktop run.
- `src/ringfall/view/` renders and never changes rules: `world.ts` (three.js), `hud.ts` (DOM),
  and synthesized sound. The view is set by its horizontal angle (`hipFov()` in `world.ts`): 90°
  across, up to 95° on a wide phone, at most 70° up and down on a tall window; aiming narrows it by
  the ratio each weapon's `adsFov` gives against a 74° reference, so a sight zooms the same on
  every screen. `world.ts` cuts the ground and everything built into `CHUNK`-metre
  chunks, each merged into a mesh or two with its colours in the vertices, and skips chunks past
  the fog and robots, bins and loot past the tier's `thingsFar`, so the draw calls stay bounded
  however large the world grows. Chunks within the tier's `trimFar` also carry a shadowless mesh
  of architectural trim (`trim.ts`: storey bands, panel joints, lintels, sills, coping, cladding
  ribs, fittings placed from each box's own numbers), and `scatter.ts` lays stones, stains, cracks
  and tufts on the ground out to `scatterFar` in two instanced meshes, from a hash of each cell.
  Chunks are built only near the camera (`streamChunks()`: at once
  inside the fog, nearest first for the tier's `streamMs` a frame out to a chunk past it) and let
  go past `DROP_AT` times that, and `prebuild()` builds round where a raid starts before its first
  frame. How much is drawn is a quality tier (`quality.ts`: `QUALITY` holds high / medium / low,
  each a pixel-ratio range, antialiasing, the shadow map's size, reach and redraw rate
  (`shadowHz`; medium and low redraw it at that rate or when the camera has moved), the fog's
  distances, `thingsFar` and `streamMs`). `pickTier()` starts a device on one from its pointer,
  cores, memory and screen; `?quality=` or the settings' 画質 overrides it, remembered in
  localStorage. While a raid runs, `Governor` walks a ladder of levels (the pixel ratio stepped
  down within a tier, then the next tier, then low drawn at 30 fps) by the smoothed interval
  between drawn frames: down after 2 s over the budget, up after 12 s within it, a level that
  failed blocked for a time that doubles each failure, so it settles instead of swinging; a
  chosen tier keeps its tier and moves only its resolution. It never runs under a browser driver
  (`navigator.webdriver`) or `advanceTime`, so the shots gate draws the same thing on any machine.
  Nothing is drawn while the page is hidden. None of it changes what robots see (`SIGHT` is far
  inside every tier's fog). `audio.ts` is the sound engine (buses, reverb, voice cap,
  positional voices) and runs on any `BaseAudioContext`; `sfx.ts` holds every cue; `soundscape.ts`
  puts the listener at the camera, tests walls with a few `los()` rays a frame, plays nearby robots'
  steps, the wind, the extraction craft and the ambience, and turns `state.events` into cues.
  `soundcheck.ts` is the `?sfx` panel; `npm run sfx:ringfall` renders every cue offline and fails on
  silent, NaN or clipping ones. `src/ringfall/main.ts` wires input and the fixed-step loop, and
  exposes `window.render_game_to_text()`, `window.advanceTime(ms)`, `window.ringfallBot(skill)`,
  `window.ringfallFrameCost(frames)` (draw calls, triangles, time per frame with and without
  waiting for the GPU, the tier and the pixel ratio, for the shots gate) and
  `window.ringfallQuality(tier)` (draw at a tier; the gate logs the phone at each).
  `window.ringfallStep(ms)` is `advanceTime` without drawing (drawing in software is most of a
  step's cost) and `window.ringfallDraw()` draws the scene as it stands; the shots gate steps
  undrawn while it only waits on the state, and draws before each screenshot and every few steps.
- `docs/ringfall/balance.md` holds the target curve and the latest `npm run sim:ringfall -- 30` output
  (a table per region, and the hideout's pacing table from `scripts/ringfall-pacing.ts`: each skill's
  recorded raids settled in sequence with a greedy spender, the raid at which each level is built).
  Change a number in `config.ts` or `map.ts` only together with a re-run and an update to that file.
  While tuning, `npm run sim:ringfall -- 10` (10 raids per skill and region, about a third of the
  time) is enough to see which way a change moves the tables; the record in that file is 30.

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
