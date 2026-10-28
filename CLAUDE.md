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
The reservoir (south, +z) has six POIs and three ways off; the harbor (north, beyond a mountain
belt) has six POIs and a boat. A pass road from the landing pad and a railway (an embankment from
the east mesa, a bridge over a gorge, a viaduct into the harbor) join them, so a raid may walk from
one to the other. The world is about 1200 by 1880 m (`WORLD` in `config.ts`): the reservoir's island
(about 1120 by 820 m) with the dune coast bulging south of it, a mountain belt at z about -350, and
the harbor's land (radius about 425 m). The reservoir is built at the scale of real places, its
neighbouring POIs and districts 250 to 400 m apart; the harbor's POIs stand 270 to 330 m apart;
all three are built at that scale. Five smaller walled works stand on the open ground between them
(the weather station, the waterworks, the lodge at the pass's foot, the cannery, the cold store), each
a POI of two squads 110 to 200 m from its neighbours.
`REGIONS` in `map.ts` gives each region its POIs, ways off and ways in on foot (`ENTRIES`: a named
point out on its open ground, facing in, out of every robot's sight for the first seconds);
`newRun(seed, kit, region, { entry })` starts on the ground there with the teammate beside the
player (the reservoir and its first way in by default), and the departure's map picks the way in (or a
depot) at the moment of leaving. There is no drop from the air. It offers only the ways in the player knows
(`Profile.entries`): a new profile knows the reservoir's first (`FIRST_ENTRY`), and a raid marks
each way in the player walks to, within `ENTRY.radius` on its ground, in `State.found` (the start's
own included; `stepEntries()` in `world.ts`, an `entryFound` event for the HUD's toast), which
`settle()` adds to the profile only when the raid got off alive (`Settlement.learned`). A region
with no known way in and no depot on cannot be chosen (`canStartIn()`); the HUD and the world map
are handed the known list (`Hud.setKnown()`), and each way in has a campfire and signboard in the
view (scenery, no boxes).
Robots are squads placed in the world from the start (`POIS[].squads`, four squads per POI, of two
robots but for the relay's equipment shed and the wreck's beach, which have three; about half of
them walk a beat outside their POI (`MOBILES`), so four or five stand at a POI, fought a squad or
two at a time (the pad holds the titan and its drones), a few `ROAMERS` in `map.ts`, most of them
patrolling the roads, and the walks of `MOBILES`: the beats, the enemy's patrols and convoy and
the rogues' walks, see `factions.ts` below), drone
packs that fly long loops over the ground between the POIs (`PACKS` in `map.ts`, `PACK` in
`config.ts`: a squad's `sight` noticing from further than its kind's `SIGHT`), and hunting parties
that walk from stop to stop of their region (`PARTY_STOPS` in `map.ts`, `PARTY` in `config.ts`,
`stepParties()` in `world.ts`), replaced out of sight a while after they are wiped out; plus
reinforcements (`REINFORCE` in `config.ts`) that beam in
out of sight on a timer and come looking, and once per raid an elite squad (`RAIDERS` / `ELITE`)
that flanks. The packs' starts and the parties' line-ups, stops, spawns and waits draw on a
random stream of their own (`roamRand()`, `State.roamRng`), so they do not shift the rest of the
raid's draws. Bins take time to search (`SEARCH`) and valuables fill a bag of `BAG.slots`. The HUD
shows no markers or distances but one: the current objective step's destination, as a light
beacon in the world and a marker with its distance on the compass (the steps come from
`objectiveSteps()` in `sim/objective.ts`, which the HUD, the bot and the sim gate all read). It
lists only the ways off of the region the player is in
(`regionHere()`); the world map (`view/map.ts`, M) is where the POIs and exits of both regions are; it opens framed
on the region the player is in (`Region.bounds`) and N switches it to the whole world.
A wipe ends the raid and loses the haul (`haulValue()` in `results.ts` is its worth). The results
screen gives no grade or score: it leads with the day (the island's map and its tug-of-war bar, in
beats: the nodes that changed hands in the raid, those the battle took after the player left under
the depot's mark, and those the night took under the moon, each ringed and turning to its new
colour, from the settlement's `raid`, `after` and `night`), then the haul.
Clearing a POI's garrison is 掃討 in the UI; 制圧 is only the capture of a core.
Between raids the player walks a camp in the world (`CAMP` in `map.ts`, a fenced yard on the south
beach behind the reservoir's first way in): `sim/camp.ts` holds its state (`newCamp()`, a raid's
emptied of robots, its clock standing) and its step (`stepCamp()`: walking only, weapons lowered).
Its stations (map table, quest board, shelves, stall, workshop, factory) open the panels of `view/hub.ts` by
the use key. Walking out of the gate and the use key at the truck by it both open the departure
(`view/depart.ts`, `#depart`): the island drawn whole with every start on it (`Hub.startPoints()`:
known ways in as solid rings, ways in not known yet dashed and shut, depots switched on as teal
squares with their allowance as small boxes, red past it, a padlock on a region no raid may start
in yet), the last start chosen, and beside it the kit, the objective (`Hub.departure()`) and the
confirm. A click or tap chooses a start (`Hub.choose()`); the confirm, Enter, the use key or a
second click on the chosen start goes, the arrows step the choice, Esc turns back into the yard.
A depot the loadout does not fit (`fitsStart()`) cannot be confirmed. From the gate, a start at
`FIRST_ENTRY` walks out where the player stands (`walkOut()`); any other start comes after a fade.
The chosen depot is kept by the hub between departures, not in the profile. The
camp shows the day's line and a 今日の作戦 card (`Hub.today()`). No robot
walks into the yard (`inCamp()` in `enemies.ts`); during a raid they see and shoot into it as
anywhere. Walking back into it during a raid, after `HOME.away` seconds outside and with no robot
fighting the player within `DEPOT.safe`, ends the raid alive with the bag (`stepHome()` in
`world.ts`, `State.home`). The hunters' field (`hunt.ts`) leaves the camp's boxes out and nothing
beams in by the yard, so the gate's raids play as without it.
`window.ringfallCamp` stands the player at a station or the gate for the shots gate. The base
keeps a stash, a trader and the loadout for the next raid:
`src/ringfall/meta/profile.ts` is its pure logic (`takeKit()` out of the stash, `settle()` after a
raid, the pouch that survives a wipe), `meta/storage.ts` saves it in localStorage, and `META` in
`config.ts` holds its numbers. `newRun(seed, kit, region)` starts a raid from a kit; the default is
`starterKit()` (the starter weapons and the issued heals), which is what the sim gate plays;
`Profile.region` and `Profile.entry` remember the last start. The stash always holds the starter
weapons (`META.starter.weapons`, PIKE and TALON common, stash items marked `starter`): `withStarters()`
keeps them there in `newProfile()`, `parseProfile()` and `settle()`, `takeKit()` sends them along
without taking them out, so no raid loses them, `sell()` refuses them, and they take no stash room
(`stashUsed()`) nor depot allowance (`itemCost()`). A loadout that picks no weapon picks them
(`armed()`). `META.starter.heals` and the infirmary's are issued to every raid on top of what it
takes (`issuedHeals()`), and what is left of them comes home like any other heal. `takeKit()`
records what it took (`Profile.lastKit`) and the shelves pick it again while the stash holds things
like it, a weapon slot left empty taking a starter weapon (`recallLoadout()`). The valuables still wanted (`wanted()`, for the stash's notes and the order in
which `settle()` keeps what fits) count the factory's levels as well as the hideout's.
The trader's quests are data in `meta/quests.ts` (`QUESTS`: four intro quests; credited from a raid's `stats` by `creditRaid()` inside `settle()`). The quest board
also holds the day's contracts (`meta/contracts.ts`): `makeBoard()` builds 3 or 4 from
`Profile.seed`, `Profile.day`, the island and the hideout (take a POI on the front by its core,
fetch a valuable from a POI's bins, destroy a drone pack or a region's hunting party; numbers in
`CONTRACT`), kept in
`Profile.board` for the day; the player takes one (`Profile.taken`), the story record under way
(`STORY_TAKEN`, which makes the record the objective), or none, and `settle()` pays it
when `contractDone()` holds (fetch counts only valuables tagged with their bin's POI,
`Player.haulAt` / `State.sentAt`; intercept reads `Stats.wiped`, by `squadKey()`). Five story
contracts (`meta/story.ts`) follow one at a time: the one under way lays its record at its
`RECORD_SPOTS` place in `map.ts` (`Start.record`), a bag slot that comes home into
`Profile.records`. The bots take no contract and carry no record. Each POI has one locked bin (`vault: true` in its `bins`), opened
only with that POI's key; keys drop from the bins of the POI named by its `keyFrom` (`VAULT`).
POIs have a stable `id` (`PoiId` in `map.ts`); saves, quests, `keyFrom` and `EXTRA_BINS` refer to a
POI by it, never by its place in `POIS` (the run's state may index `POIS` internally). The profile
is versioned (`Profile.v`, which is 23), and `parseProfile()` moves older saves forward (a save from
before the ways in starts at its region's first way in; a save from before ways in were learned
knows them all; a save from before v12 drops its explored map, since `cellOf()` follows `WORLD`,
which then grew wider; a save from before v13 starts on the day after its raids with every POI
held; a save from before v14 keeps only the quests that still exist; a save from before v16 has a
quiet day and tomorrow's event drawn; a save from before v17 knows the starting mod kinds and plays
at threat 0; a save from before v19 has the factory at level 0; a save from before v20 remembers no
loadout; a save from before v22 has its POIs freed or thin the player's and the rest the enemy's,
and drops the network, its pressure, the outposts' standing and the battles' points; a save from
before v23 gains the starter weapons) and moves its
start to one it may choose (`allowedStart()`).
Each island day has at most one event (`EVENTS` in `config.ts`, `IslandEvent` in `sim/island.ts`):
`advanceDay()` turns yesterday's forecast into today's and draws tomorrow's from `Profile.seed` and
the day (`eventFor()` in `meta/island.ts`), kept in `Profile.events` (today, tomorrow) and passed to
the raid as `Start.event`. A debris fall puts a crate (`Bin.debris`, `DEBRIS`) and its guards at one
of `DEBRIS_SPOTS` (`map.ts`; the wreck is drawn by the view only); a storm scales the robots' sight
(`sightScale()`, `STORM`); a crews' visit brings a salvage crew. Salvage crews (`CREW`, only on a
crews' visit, `crewsFor()`; `stepCrews()` in `world.ts`) beam into the starting region, walk to
the unopened ground-level POI bins nearest by the walk, take each one's
valuable into `SquadState.bag` (dropped with its bins' POIs when the last member dies, in
`combat.ts`) and leave by the region's nearest way off (`Stats.crewsOut`), the bag lost. Crews and
the debris guards draw on their
own stream (`crewRand()`), so the raid's other random numbers are drawn as without them.
Each POI has a depot on its road (`DEPOTS` in `map.ts`, run by `stepDepots()` in `world.ts`): walking
up switches it on for good, its use key sends the bag home (it survives a wipe) or, with the bag empty,
leaves the raid there; neither works while a robot fighting the player is within `DEPOT.safe`. The profile keeps the depots on (`Profile.depots`) and the explored map (`Profile.seen`);
`newRun(seed, kit, region, start)` may begin on the ground at a depot that a node held opens a start from
(`departDepots()` in `meta/island.ts`: the supply depot's and the yard's, `UNLOCKS[].depart`).
A start from a depot carries a limited loadout: `loadoutCost()` prices stash weapons, armour and keys
(the starter weapons and heals are free), `depotAllowance()` gives the depot's level and budget from the
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
The island has a state between raids (`docs/ringfall/island-v2.md`): one settled raid is one
day (`Profile.day`), and each POI is the enemy's (`held`) or the player's (`freed`)
(`Profile.poiState`). `meta/island.ts` holds the pure rules: `advanceDay()` (called by `settle()`)
makes the player's each node whose core the raid captured, however the raid ended, or with a
battle takes every node as the battle ended (`RaidDay.battle`), then the night's attacks
(`nightRaids()`, `NIGHT` in `config.ts`: nodes next to the enemy's ground fall by chance, less when
guarded and with the factory's level, a hash of the raid's seed, the day and the node), switches
the player's depots on, and pays `FRONT.income` a node (`frontIncome()`). A node is lost only to the
enemy's squads in a battle or to the night; nothing goes thin and nothing lapses. The titan's pad is never the player's. A
raid reads the standings through `newRun(seed, kit, region, { island })` (`State.hold`):
`garrison()` in `sim/island.ts` stands every squad of a held POI and none of a freed one, which
starts cleared, its vault open without the key (`canOpen()` in `world.ts`) and its depot on. With
no `island` every POI is held, which the sim gate plays.
The enemy's strength (`STRENGTH` in `config.ts`, `State.strength`, `strengthLevel()`) follows the
nodes the enemy holds (`STRENGTH.byHeld`, `strengthFor()` in `state.ts`, `enemyNodes()` in
`front.ts`): it sets the reinforcement and raider times, the hunting parties per region, the drone
packs flying (`activePacks()`, from the seed), the rogue patrols (`ROGUE.patrols`), the capture's
push (`FRONT.push`) and the battle's enemy squads (`CONQUEST.net`). With every node the enemy's a
raid plays at `STRENGTH.play` (2), whose numbers are the island's own, so the sim gate's tables
keep the island's numbers. A node's garrison (its POI's squads, and those of them out on a beat)
wears plates of the node's `TIER` (`tierPlated()` in `sim/island.ts`, `PLATE.garrison`, a hash of the
seed and the robot's id), and plain grunts and heavies elsewhere wear a tier-1 plate only at a
raised threat (`netPlated()`).
Mod parts (`MODS` in `config.ts`, `sim/mods.ts`) are the raid's own build: three body slots
(`Player.mods`), lost when the raid ends, each setting one number the sim already reads
(`modScale()`). Bins hold kinds the profile knows (`State.known`, `Profile.known`), robots any;
which bin or robot holds one is a hash of the seed and the bin or robot (`binMod()`, `robotMod()`),
never `rand(s)`, and the bot passes `Input.leaveMods`, so the gate's raids play as without them. A
raid got off alive may analyse one worn part on its results (`analyse()` in `profile.ts`). The
強度 (`THREAT`, `Profile.threat`, `newRun(..., { threat })`) belongs to the contract taken: it is
chosen on that contract's card on the board, taking another contract starts it at 0, and a raid
with no contract plays at 0 (`raidThreat()`). 0 is the island's raid at the enemy's strength;
higher scales its times and plates (`raidClock()`, `netPlated()`), the range robots answer shots
from afar, the mod parts' odds, and the contract's pay (`threatPay()`). `Profile.freedAt` keeps
each POI's best 強度 for the map.
The front (`docs/ringfall/island-v2.md`): the eleven freeable POIs are the nodes (`NODES` in
`map.ts`, linked along the roads by the fifteen `FRONT_LINKS`, in loops, each with its depth `TIER`); the
outposts are places to loot with an enemy guard, no nodes, and the rogues hold no ground.
`sim/front.ts` holds the rules. A node next to the player's ground (the camp and the player's
nodes) is on the front; only its core, a pillar near its middle, can be captured (`FRONT` in
`config.ts`): the use key starts it, the meter fills while the player holds the core's ground with
no robot on it, the garrison comes and squads push in from the neighbouring nodes. A node taken is
the player's at once (no robot enters `FRONT.zone`) and stays so overnight; clearing a POI of its
robots does not take it. The bot captures the front's cores in its region whose garrison's plates
its best gun pierces, `Skill.capture` a raid (`Skill.battle` in a battle), and then leaves; it takes on
no POI two tiers past its best gun. With no contract taken (and
the story record not taken), the objective card points at the front (`objectiveSteps()`), and the
record has a line of its own.
A raid of the island is one battle (陣取り戦, `sim/battle.ts`, `CONQUEST` in `config.ts`), given by
`newRun(..., { battle: { factory } })` (`State.battle`); a raid without it, as the sim gate's tables
play, has none. It lasts `CONQUEST.time` seconds, the raid's time limit (`timeUp`: still out is a
wipe); there are no points and no winner: whoever holds each node as it ends holds it the next day.
Squads (`BattleSquad`) come out of the nodes: the player's from the camp's factory (`FACTORY`,
`Profile.factory`, built at its station like a hideout module, `buildFactory()`), the enemy's the
more the more it holds (also from `NET_EDGE` and in answer to the player's ground), and the
rogues' from the wild now and then (`CONQUEST.rogue`), which fight at a node and move on but take
none. They walk the links (`walkLine()` paths traced as
the raid starts, then forgotten), attack a neighbouring node or defend one of their side's, and take
a node by standing at its core for `CONQUEST.capture` seconds with none of its holders there (its
garrison counts wherever it stands and comes to the core). Near the player or the teammate
(`CONQUEST.near`) a squad is robots in the world: the player's own in `State.friends` (`Enemy.friend`,
blue; they fight the other sides with the faction rules and their shots never hit the player or the
teammate, `stepFriends()` in `enemies.ts`; a squad of them within `SUPPORT.reach` of the player or the
teammate goes for the robots fighting them, seen or not, `support()` in `factions.ts`), the others in `State.enemies` (`Enemy.battle`, which may
walk onto the player's nodes and which garrisons fight, `hostile()`); beyond `CONQUEST.far` it is
numbers again, with each member's health as it was. Away from both, fights and captures are
reckoned every `CONQUEST.tick` seconds in numbers, and when the raid ends early `finishBattle()`
reckons the rest so; it pushes no event. The night counts the nodes as the battle ended
(`RaidDay.battle`). `battleFocus()` gives the objective (`objectiveSteps()`) and the bot a node of the
player's under attack, or one their robots are taking.
The battle is meant to be seen (island-v2.md, 手触り). The enemy's squads land (`landingPlan()`): by
dropship on the titan's pad (`PAD`) or by boat up the harbor's channel on the north shore (`SHORE`,
not while the player holds the wreck), stepping ashore `CONQUEST.land` seconds after setting off
(`BattleSquad.ashore`; `Battle.landings` for the view, event `landing`), and walk across the enemy's
nodes (`BattleSquad.via`) to a node of the player's. The factory's squads come out of the camp's
gate (setting off from the camp or the node by it) or a held node's depot (`DEPOT + k`;
`Battle.departs`, event `squadOut`), and one goes to hold each bare node of the player's next to
the enemy before any attacks. Walking a link in the world a battle squad goes in a column
(`CONQUEST.column`, `inColumn()` in `enemies.ts`). The player's squads within `CONQUEST.rally.reach`
of the node the player attacks (a front node whose core is within `rally.near`, or the core being
captured) come round its core (task `rally`, `Battle.rally`). The enemy's robots at a core of the
player's set `Battle.threat` (event `nodeThreat`): the core pulses red in the world and on the
map, and a red arrow at the screen's edge points to it (`threatMarks()` in `hud.ts`). A node that
turns the player's draws a counter-attack (`COUNTER`, `dueCounter()` in `front.ts`, `Battle.counters`):
`COUNTER.delay` seconds on a squad lands bound for it (event `counter`, `BattleSquad.counter`), on top
of the enemy's limit; `atRisk()` gives the player's nodes an enemy squad is bound for or is taking
(a slower pulse on the map, the core and the bar's blue end), `countered()` those a landed
counter-attack walks to (a smaller arrow at the screen's edge). `Battle.left` keeps the nodes as the
player left, so the results tell the battle after leaving from the raid.
`view/battle.ts` draws the battle from afar: the landing craft and their beams, the battle's
robots past `thingsFar` and the squads that are numbers out to the fog as instanced figures
(`columnPoints()`), and the gate's and the depots' light as the factory's squads come out.
The long-term goal is how many of the eleven nodes the player holds (`view/row.ts` draws them as
one tug-of-war bar, blue from the left and red from the right, a segment a node, at the title, the
HUD's top, the camp's line, the map table and the results; its boundary slides when a node changes
hands and flickers while one is fought over); there is no ending. The hideout is the mid-term one: five modules built level by level from specific
valuables and credits taken from the stash, each level needing only the module's level before it
(`build()` in `profile.ts`; levels and costs in `HIDEOUT`, effects in `HIDEOUT_EFFECT`, both in `config.ts`; `meta/hideout.ts` holds the pure
helpers). The workshop's cards and the factory's show each level's effect as was → now with what
grows lit, and a ladder of the levels when opened (`moduleGauges()`, `factoryGauges()` in
`view/hub.ts`); each module's mark (`MODULE_ICON`, drawn in `view/icons.ts`) also stands where its
effect shows (the shelves' issued heals, the stash's count, the trader's materials, the map table's
report, the pouch). Their benefits act in the meta: `takeKit()` lends the infirmary's heals, the workbench
raises the valuables the trader sells (`materialRarity()`), `stashCap()` and `pouchSlots()` grow, and the radio reports the next raid's
boosted POI. Every raid leans one POI's bins of its region to a rare kind (`State.boost`, from
`boostFor(seed, region)` in `state.ts`, without drawing on the raid's random numbers);
`Profile.seed` is the next raid's seed, fixed at the base so the report comes true. The top levels
ask for the data core or the small reactor. Build quests (`{ t: "build" }`) finish at the base (`claimBuilt()`).
`sources()` derives where each valuable is found from the loot data (`loot.valuable`, `TOP_BINS`,
`VAULT`, `ROBOT_DROPS`), for the workshop's hints.

```bash
npm run sim:ringfall     # gate 2: bots of three skills play whole raids headless, in each region,
                         # then the hideout's pacing replays the meta with those raids, then each
                         # skill plays 30 days on one profile with the island carried, each
                         # raid a battle with the factory the profile has built
                         # (scripts/ringfall-campaign.ts, also runnable alone); raids run
                         # in parallel, one process per core, the reservoir's (the longest) first,
                         # beside the campaign's months (a process per skill, started first)
                         # (RINGFALL_SIM_JOBS=n to set, 1 = in turn)
npm run models:ringfall  # the model rules (docs/ringfall/models.md): budgets, palette, hit spheres;
                         # fails when one is broken, silhouettes in shots/ringfall/models/
npm run look:ringfall -- <place> [--r 120] [--base]
                         # one place in about a minute and a half: the tour's cameras near it
                         # (scripts/ringfall-tour.mjs, shared with gate 3) and four from above,
                         # a top-down crop, each compared with the place's baseline, and every
                         # 4 m cell of the world whose ground or boxes changed, those past the place first;
                         # and the place measured as ground to fight over (field below), compared with
                         # its baseline's numbers; take a baseline with --base before changing a place, look after
npm run field:ringfall -- <place>|--all [--r 120]
                         # cover and sight of a place in seconds (docs/ringfall/field.md): cover within
                         # 8 m, sight, lanes past a grunt's engaged sight, exposed ground; a map in
                         # shots/ringfall/field/; no pass or fail, the numbers move with a change
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
  `wreck()`, `yard()`, `smelter()`, `station()`, `waterworks()`, `lodge()`, `cannery()`, `coldstore()`), as is each district's (`heartTown()`, `damFace()`,
  `plateau()`, `village()`, `factory()`). The helpers take their sizes from a `Scale` (storey,
  walls, doors, windows, roller doors, stair width): `WORKS` for industry (4.5 m storeys,
  half-metre walls, doors 2.4 by 2.8 m, roller doors 6 m high), `HOME` for homes and farms
  (3.2 m storeys, larger rooms and windows), `INTAKE` for the dam's intake tower (5 m storeys), and
  the older `HOUSE` (3.4 m) for the drowned town and the harbor's smaller buildings. A function that builds on more
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
    into the pit's edge) and the conveyor from the plant down to the floor; its ways up are wide iron
    stairs from the top terrace onto the ground on five sides and between the terraces
    (`QUARRY_EXITS`, `rimStairs()`, from the floor as it lies at each foot), and two lifts from the
    floor to the south and north rim (`QUARRY_LIFTS`: cables ridden as the ziplines are, always up),
    which the sim gate walks and rides (`checkQuarryExits()`);
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
  In the harbor the smelter (`WORKS`, about 110 by 60 m inside its fence) is a blast furnace
  works: the furnace's hearth against the cast house, its shaft to a railed deck 34 m up reached
  by an open stair tower, its top and uptakes past 50 m; three hot-blast stoves 32 m high in a
  row east of it, the skip incline climbing to its top over the north lane, ore heaps along the
  north edge either side of the road out, the rolling mill bridged at roof height to the cast
  house and to the five-storey control block, the dust catcher, two stacks (60 and 48 m) and a
  cooling tower to the west and south-west, slag heaps to the east. The container yard
  (`YARD_BLOCKS`, about 150 by 90 m inside its fence) stacks 40-foot containers up to four high
  in blocks, alleys between their groups of rows, a rubber-tyred gantry (`GANTRIES`) over a north
  and a south block climbed from the main lane, a low island of boxes down that lane, an apron in
  the south-east where the street and the roads from the viaduct come in, the three-storey
  terminal office and the gate house; north of its fence two quay cranes (`QUAY_CRANES`,
  `quayCrane()`) straddle the freight line, their booms 40 m up over the old sea floor, the east
  one climbed by an open stair tower to its deck 34 m up. The wreck (`SHIP`, `wreck()`) is a
  container feeder 140 m long and 26 m in the beam lying on the old bay floor: three `WORKS`
  storeys of hull holed on both sides, bulkheads cutting the holds, stairs at both ends to the
  main deck, deck cargo stacked in bays (`DECK_BAYS`) with gaps between them, the accommodation
  block five storeys over the deck with the bridge's wings over both sides, the funnel, and
  containers lost overboard on the sand. Its gangway route climbs the north side to the deck.
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
  substation and a pumping station) are larger ones, each with a squad of two (three at the node and the dock town below; `Hamlet.guard`,
  joined to `ROAMERS`) and its whole yard pressed flat. From them the works run to the POIs
  (`WORKS_LINES`, laid once the ground is built): power lines on pylons, pipelines high enough to
  walk under, and a freight line and its spur with wagons left on them as cover. The harbor's
  sixth and seventh outposts have no lines: where the ring came down on the dry bay north of the
  wreck. The ring's node (`ringNode()`, sized by `NODE`) is a steel drum standing at the bottom
  of a crater (`CRATERS` in `terrain.ts`, a bump in the ground's field with gaps to walk down
  through), corridors running straight in at ground level to its core and a glowing column
  (`GLOWS`, drawn by the view) seen across the bay, a ring of halls a storey up round them, a roof,
  a breach torn open where a piece of the ring struck it. West of it the dock town
  (`harborTown()`, sized by `TOWN`) is blocks round a freight station with the line on a viaduct
  round it at roof height; the line's spur east toward the node broke where the ring came down,
  and falls in strides into the node's west corridor (`TOWN_SPUR_FALL`, laid once the ground is
  built). An outpost may name a `yard`, the ground pressed flat round it, which is walked ground
  (`FlatShape.walked`): `highGround()` measures it against the levels pressed under it
  (`baseLevel()`), not the field, so a raised yard and the crater's rim are walkable.
  Perimeter fences (`FENCES` / `FENCE_RUNS` in `map.ts`, boxes of kind `fence`) close the open
  ground round some of the base's works: they stop bodies, not sight or shots (`rayWorld()` in
  `geom.ts` passes them, `cover.ts` offers no cover behind them), and leave a gate wherever a
  street or a kept road crosses and a gap wherever something built stands in the way.
  The ring's own wreckage (`RING_WRECKS` / `RING_RUNS` in `map.ts`, laid once the ground is built)
  lies on the open ground of both regions: box girders 20 m across whose backs stand 18 m over the
  ground, in lengths along x or z that close the open ground into ways. They are crossed only where
  they are broken (gaps between lengths), through a hollow length (`tunnel`, its sides torn open),
  over a length leaning across one (`lean`, its high end an arch to walk under) or up a heap of
  rubble (`rubble`) onto the back, whose far side is a drop with no way back up. Like the fences
  they are in `PLACED`, so the streets route round them.
  Towns (`TOWN_FRAMES` in `map.ts`: the lakeside town on the reservoir's ring road) are streets of
  houses, shops and a filling station, each building at the level of the ground under its own
  middle so a town follows the land, with a squad walking their streets (joined to `ROAMERS`).
  Streets (`STREETS` in `streets.ts`) join the POIs, outposts, hamlets and ways in over the open
  ground. They change no ground: `scripts/ringfall-roads.ts` routes them round cliffs, high ground,
  water and `PLACED` (everything placed before the streets are lined) and prints the lines pasted into
  `STREETS` from `ROUTE_PLAN`; the view lays their asphalt and paint (`view/streets.ts`, merged into
  each chunk), the world map draws them, and `STREET_SIDE` in `map.ts` lines them with lamp posts,
  signposts and queues of abandoned traffic. `offStreet()` is the lookup the scatter and the view use.
  `scatterCover()` then fills the open ground with set pieces in real sizes (sandbag lines,
  road-barrier rows, pallet stacks, container clusters, wrecked trucks, rock outcrops and roofless
  ruins, the vehicles and small things as `prop` boxes drawn by `buildProp()`), each
  region from its own grid and seed (`SCATTER`), sparse on the salt flats, off the streets'
  asphalt, and on the ground between gathered along the streets with only a few clumps
  (`clump()`) away from them, keeping clear of the stops and parties' stops (`STOPS`, `PARTY_STOPS`),
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
- The player moves fast (`PLAYER`, `CLIMB`, `ZIP` in `config.ts`, `player.ts`): a sprint of 7.6 m/s;
  a jump out of a slide adds `slideJumpBoost` up to `slideJumpMax` (a faster slide keeps its own
  speed), the air keeps it, a landing with the crouch held slides on (event `slide` with `chain`),
  and above a sprint's speed the ground bleeds the speed off at `overspeedDecel` while the player
  pushes that way; a jump pressed in the air waits `jumpBuffer` for the ground. Running or jumping
  into a wall or cliff whose top is within `CLIMB.reach` of the feet climbs it hand over hand and
  mantles over (`tryClimb()`, `ledgeAhead()`, the wall read by `boxTopAt()` in `geom.ts`); the top
  must be ground to stand on, never the high ground (`highGround()`), past the coast, or a fence,
  and a ledge within `MANTLE.reach` in the air is the plain mantle as before. A cliff's face is a
  wall at any speed: on foot the body never rises onto steep terrain above its feet (a step that
  would slides along the face on one axis), and in the air never onto steep terrain above the
  ground it left (`Player.airFrom`, `offFace()`), so neither running nor hopping creeps up the
  crags. Ziplines (`zips.ts`): `layZips()` in `ziplayout.ts` lays a cable for each link of
  `FRONT_LINKS` between mast spots near both ends' cores (`mastSpots()` in `map.ts`; the camp's
  outside its gate), the tightest line over the ground and everything built, over pylons whose
  legs stand on open ground, as `ZIPS` (`ZIP_MISSING` names a link with none, `ZIP_BOXES` the
  masts and pylons, last in `BOXES`; the scattered cover keeps out from under the cables). A
  cable is up while the player holds both ends (`zipUp()`; the camp always), so lines come and
  go as nodes change hands, and a rider whose cable is cut falls. The use key near a cable that is
  up (`useTarget()`, kind `zip`) or a jump into one (`grabInAir()`) takes hold; the rider goes the
  way they face at `ZIP.speed`, slows over `ZIP.brake` to `ZIP.arrive` and lets go at the end, and
  a jump lets go anywhere with the speed kept. A teammate beside the player in sight rides behind
  them and comes down beside them on landing (`Player.zip.carry`, `zipFall`), as on the leap;
  else it catches up as ever. Robots never ride; a rider is shot as anyone. The bot passes
  `Input.noClimb`: it neither climbs nor rides, since its paths (`nav.ts`) run on the ground. The
  sim gate checks all of it (`scripts/ringfall-movement.ts`) and prints the course times (sprint,
  slide-jump chain, zipline over 120 m of the salt flats), the climbs and the cables in balance.md.
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
  suppressing. A target standing still is pressed (`SHOT.still` to `SHOT.follow`): a tighter stray
  and fan, a shot more a burst, a short pause and a quicker next wind-up, so trading shots in the
  open with one robot head-on is about even, and moving, going round or ducking behind cover wins
  it; robots shooting at the same target lengthen each other's pauses (`SHOT.share`), so two do not
  fire twice as hard as one. Past the distance it likes, a robot steps in while it winds up and
  fires (`DODGE.closeIn`). The sim gate's `duel` lines (`scripts/ringfall-duel.ts`, runnable alone
  for the whole table) are one robot against a lone player in the open, standing, strafing,
  shooting its back and from behind a low wall; keep them within the targets in balance.md.
  A burst starts only with the target in sight, so
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
  raid (of them, those of no POI); `c/min` is the squads met per minute of raid.
- `factions.ts` is the robots between the POIs. The walks of `MOBILES` (`map.ts`) go out and back
  between nodes by a way traced once per world on the ground's fields (`walkLine()` in `hunt.ts`;
  the fields are forgotten at the raid's start, so a raid plays the same in any process). The robots
  are of two factions (`FACTION`): the enemy (red) and the rogues (yellow, `Enemy.rogue`), hostile
  to each other and to the player. The rogues hold no ground (every outpost's guard is the
  enemy's); `ROGUE` gives how many of their ranked walks go out at the enemy's strength. Squads out between the POIs find the other faction by square and fight it with the shots
  they fire at the player (`fightFoe()` in `enemies.ts`, `damageRobot()`, `fall()` in `combat.ts`);
  POI garrisons take no part. Squads that move about make for where the player is heading
  (`interceptSpot()` in `awareness.ts`, `INTERCEPT`), squads of three or more split at once
  (`SPLIT`), calm walks wait at choke points for a loaded player near a way off (`AMBUSH`, `GATES`,
  `RING_GAPS`), and the enemy sends one after a quiet stretch (`SWEEP`). What the player saw or
  heard of them is `State.contacts`, drawn on the map. `checkFactions()`, `checkPatrols()`,
  `checkIntercept()` and `checkSplit()` in the sim gate check them.
- Some robots wear armour plates (`Enemy.plate`, a rarity tier, drawn in that rarity's colour on the
  chest and shoulders): body hits from a weapon of lower rarity are cut by `PLATE.mult` in
  `config.ts` and show no damage number (sparks and a ping instead), weak points pass in full. A
  node's garrison wears its `TIER`'s plates (the vault guard, `Member.plate` in `map.ts`, at least
  `VAULT.guardPlate`), the raiders `RAIDERS.plate`. A piercing hit that lands with the shield gone breaks the
  plate off (`plateBreak`; `Enemy.wore` keeps what it came with). The factory's robots hit plates as
  the trader's shelf arms them (`factoryRarity()` in `battle.ts`), the rogues as `PLATE.robots`.
  Plain bins hold gear seldom and never past rare (`BIN_GEAR`, a hash of the seed and the bin);
  epic and legendary guns come from vaults, plated robots and raiders (`robotGear()` in
  `combat.ts`, a hash of the seed and the robot), the titan and the trader.
- What holding a node opens is data in `map.ts` (`UNLOCKS`, read through `unlocked()` in
  `meta/island.ts` and `heldUnlocks()` in `battle.ts`), and lasts while it is held: the trader's
  gear up to `shop` (`shopRarity()`, which `wares()` sells; common with no node), a start from its
  depot (`depart`), the factory's extra squads (`squad`, `factoryMax()`), the reinforcements'
  landing on the compass (`scout`, the HUD's red chevron), no boats on the north shore (`shore`,
  `CONQUEST.net.shore`). The world map draws each node's plate as a shield and what it opens as
  small marks beside it (`drawShield()`, `drawUnlocks()` in `view/map.ts`); the trader's shelf
  shows the rarities lit by the nodes held.
- `ally.ts` is the teammate: it walks the player's footsteps (`State.trail`), shoots only engaged
  robots, revives the player once the self-revive is spent, and is revived with the use key.
  Robots choose between the player and the teammate in `chooseTarget()` (`enemies.ts`), and in a
  battle also the player's own robots (`friendTarget()`, `SUPPORT`: a robot of theirs in sight, or
  one that has just hit it, is fought with the faction rules' `fightFoe()` while the squad stays
  engaged with the player, and does not give up the chase while one fights them, `stepSquads()`);
  the sim gate's `ally` column is its damage share, downs and revives, and `checkSupport()`
  (`scripts/ringfall-support.ts`) checks that the player's robots help and that a squad fighting
  them stays engaged after losing the player.
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
  The bot (`bot.ts`) opens only bins on the ground and does not climb or ride a zipline: each POI keeps ground bins
  by its ways in and floors, and the bot walks the ground's paths up to robots on higher ground (a
  terrace, the mesa) rather than looking for an angle on them from below.
- `src/ringfall/touch.ts` is the phone layout (landscape): a floating stick on the left half, view
  drag on the right half, buttons under the right thumb (the bag button, held, beside the arc). It feeds the same `Input` as the keyboard,
  with `input.touch` set so the sim applies `ASSIST.touchPull`. `npm run shots:ringfall` drives it with
  real touch events in a phone-sized viewport before the desktop run.
- `src/ringfall/view/` renders and never changes rules: `world.ts` (three.js), `hud.ts` (DOM),
  and synthesized sound. `bag.ts` (`Hud.bag`) is the bag peek, shown while Tab or the phone's bag
  button is held, the game running on under it with nothing to manage, and the card a pickup slides
  in: each thing carried as its slots in its rarity's colour, its name, credits and what it is for
  (the hideout module and factory level whose next level takes it, the quests and the contract
  taken that ask for it, the route a tool opens) as the base's marks, and the pouch's mark on what
  a wipe keeps. It reads the state and the profile the raid started from (`BagView.setProfile()`),
  and finds a pickup by comparing what is carried frame to frame. Past a sprint's speed the view widens with the speed (up to 12° on a
  zipline, half on a phone), `#fx-speed` streaks the screen's edges (hud.ts sets its opacity) and
  the wind's rush grows (soundscape.ts); a climb nods the view with each pull and dips it over the
  top; the cables are drawn while up (`World.cables`), and the world map draws them as thin blue
  lines (the quarry's lifts grey). `window.ringfallMove` stands the movement's shots up
  (`scripts/ringfall-shots-movement.mjs`). The view is set by its horizontal angle (`hipFov()` in `world.ts`): 90°
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
  Nothing is drawn while the page is hidden. What never moves once placed (the chunks, the scatter, the cores, bins and
  depots, the robots' merged armour) is fixed by `still()` in `models.ts`, and the scene itself
  does not move: their matrices are worked out once, not every frame; a part the view poses each
  frame is named to `still()` as moving. In the camp's idle time `readyRaid()` (`main.ts`) traces
  the battle's walks for the next raid (`warmLinks()` in `sim/battle.ts`: the walks the raid's
  own `initBattle()` would trace, from the same empty field cache) and readies the shaders of
  what a raid draws (`World.precompile()`), so neither the raid's start nor its first robot of a
  kind stops for them. The HUD measures the compass only when its size changes. None of it changes what robots see (`SIGHT` is far
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
  recorded raids settled in sequence with a greedy spender, the raid at which each level is built
  and every module stands at its top level,
  and the island campaign from `scripts/ringfall-campaign.ts`: the nodes held, the enemy's strength
  and the factory's level at days 5, 10, 20 and 30 of a month on one profile per skill, the first
  day each tier was held, and the nodes held, the best gun carried and the nodes changing hands by
  day; the campaign's bot builds the factory, then buys the best rifle and armour the trader's shelf
  holds and carries them).
  Change a number in `config.ts` or `map.ts` only together with a re-run and an update to that file.
  While tuning, `npm run sim:ringfall -- 10` (10 raids per skill and region, about a third of the
  time) is enough to see which way a change moves the tables; the record in that file is 30.
- The sim gate's speed is kept up as a matter of course, without being asked. Every change that
  touches `src/ringfall/sim/` or the sim scripts records the `npm run sim:ringfall -- 30` time
  beside the one before it, both taken back to back on the same machine, in the 測った重さ section of
  `docs/ringfall/balance.md`. When the gate has grown by a fifth or more since the last speed-up
  recorded there, profile it (`node --cpu-prof` on a few raids) and make the hot paths cheaper in
  the same change or the next one. A speed-up must leave the gate's output identical line for line;
  one that changes the output (thinking less often for far squads, say) is a tuning change,
  recorded with a re-run like any other.

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
