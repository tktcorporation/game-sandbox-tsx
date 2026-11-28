import { ALLY, BOOST, DEPOT, SORTIE, SWEEP, DUCK, ELITE, ENEMIES, META, MOD_START, STRENGTH, VALUABLES, WORLD, type ModKind, type ValuableKind, PLAYER, ULT, type EnemyKind, type Flank, type HealKind, type Rarity, type WeaponKind } from "./config";
import { DEPOTS, depotIndex, entryOf, EXTRA_BINS, HOME_REGION, NODES, POIS, nodeIndex, poiIndex, poiRegion, regionOf, UNLOCKS, type EntryId, type ExtractId, type PoiId, type RegionId, type NodeId } from "./map";
import { populate } from "./enemies";
import { placeParties } from "./world";
import { placeAlly } from "./ally";
import { groundAt } from "./geom";
import { forgetFields } from "./hunt";
import { DEFENCE_AID, defencePool, isContestedPoi, type PoiHold } from "./island";
import { rivalHold, rivalOf } from "./holds";
import { enemyNodes, nodeHolds, ownNodes, useZones, type NodeHold } from "./front";
import { initBattle, type Battle, type BattleStart, type Side } from "./battle";
import { newReplay, type Replay } from "./replay";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Weapon {
  kind: WeaponKind;
  rarity: Rarity;
  mag: number;
  /** A starter weapon (`META.starter`): it never left the stash, so it is not lost with the raid nor brought home. */
  starter?: boolean;
}

/** What the player takes into a raid. */
export interface Kit {
  weapons: { kind: WeaponKind; rarity: Rarity; starter?: boolean }[];
  armor: Rarity;
  /** Heals carried: those issued to every raid and those taken from the stash, alike. */
  heals: Record<HealKind, number>;
}

/** The starter weapons with the heals issued to every raid: a new player's kit, and the default for the gates. */
export const starterKit = (): Kit => ({
  weapons: META.starter.weapons.map((w) => ({ ...w, starter: true })),
  armor: 0,
  heals: { ...META.starter.heals },
});

export interface Player {
  pos: Vec3;
  vel: Vec3;
  yaw: number; // 0 looks toward -z (north), positive turns toward +x... see forward()
  pitch: number;
  hp: number;
  shield: number;
  armor: Rarity;
  onGround: boolean;
  crouch: boolean;
  sliding: boolean;
  /**
   * Climbing a ledge: rises at the start point for `up` of the time, then moves onto the top.
   * `climb` is a wall or a cliff climbed hand over hand (`CLIMB`), not a plain mantle.
   */
  mantle: { t: number; dur: number; from: Vec3; to: Vec3; up: number; climb: boolean } | null;
  /** Seconds a jump pressed in the air waits for the ground (`PLAYER.jumpBuffer`). */
  jumpBuf: number;
  /** The height last stood at: in the air, a cliff's face above it is a wall. */
  airFrom: number;
  /** Riding a zipline (zips.ts): `at` metres along line `line`, going `dir` (+1 toward its end), at `speed`. */
  zip: { line: number; at: number; dir: 1 | -1; speed: number; carry: boolean } | null;
  /** Off a zipline with the teammate carried along: it comes down beside the player on landing. */
  zipFall: boolean;
  /** Seconds before a cable let go of can be taken hold of again (`ZIP.regrip`). */
  zipRegrip: number;
  sprinting: boolean;
  forwardHeld: number;
  weapons: (Weapon | null)[];
  slot: number;
  cooldown: number;
  reload: number; // seconds left, 0 = not reloading
  triggerHeld: boolean;
  ads: number; // 0..1
  recoil: number; // degrees currently kicked up, recovers
  /** Degrees currently kicked sideways (positive to the right), recovers like `recoil`. */
  recoilYaw: number;
  /** Shots in the current spray: the place in `KICK_PATTERN`. */
  spray: number;
  /** `State.time` of the last shot, to tell when a spray ends. */
  lastShot: number;
  tactical: number; // cooldown left
  /** Seconds left of the slipstream part's speed (`MOD.haste`). */
  haste: number;
  ult: number; // charge 0..1
  /** In the air on the ult's leap, going up and then gliding down; `carry` takes the teammate along. */
  leap: { carry: boolean } | null;
  reveal: number; // seconds left of seeing robots through walls
  stepNoise: number; // seconds until the next sprint footstep sound
  heals: Record<HealKind, number>;
  /** Valuables carried; their worth is the raid's score if the player gets off the island. */
  haul: ValuableKind[];
  /**
   * The POI (index) whose bin each valuable of `haul` came out of, at the same place; -1 for one
   * found anywhere else.
   */
  haulAt: number[];
  /** Mod parts worn (`MODS`), the one worn longest first: at most `MOD.slots`, gone when the raid ends. */
  mods: ModKind[];
  /** The bin being searched and for how long, or null. */
  search: { bin: number; t: number } | null;
  /** The item being used and the seconds left; shooting cancels it without using it. */
  healing: { kind: HealKind; t: number } | null;
  sinceHurt: number;
  downed: number; // seconds left while downed
  /** Out of self-revives and down: waiting for the teammate, wiped when `downed` runs out. */
  awaitAlly: boolean;
  selfRevive: number;
  iframes: number;
}

/** The teammate (see ALLY). */
export interface Ally {
  /** False until it is stood beside the player as the raid starts. */
  active: boolean;
  pos: Vec3;
  vel: Vec3;
  yaw: number;
  pitch: number;
  hp: number;
  shield: number;
  /** Seconds until it stands up on its own; 0 = up. */
  down: number;
  /** Seconds of the player's revive done on it. */
  helped: number;
  /** Seconds into picking the player up. */
  rescue: number;
  /** The robot it shoots (id), 0 for none. */
  target: number;
  pickT: number;
  cooldown: number;
  shots: number;
  sinceHurt: number;
  /** Index into State.trail of the next footstep to walk to. */
  crumb: number;
  /** Climbing a ledge the player climbed: seconds left with gravity off. */
  climb: number;
  stuckT: number;
  last: Point;
  shortcutT: number;
}

export type EnemyMode = "spawning" | "move" | "telegraph" | "fire" | "lunge" | "recover" | "stomp" | "stunned" | "staggered";

/**
 * What a robot knows. idle: at its post or on patrol. alert: heard or glimpsed
 * something and is looking ("?"). engaged: fighting, with its whole squad ("!").
 */
export type Awareness = "idle" | "alert" | "engaged";

export interface Point {
  x: number;
  z: number;
}

export interface Enemy {
  id: number;
  kind: EnemyKind;
  pos: Vec3;
  vel: Vec3;
  yaw: number;
  hp: number;
  shield: number;
  mode: EnemyMode;
  timer: number;
  cooldown: number;
  shotsLeft: number;
  strafe: number; // +1 / -1
  poi: number;
  lastHit: number; // seconds since the player last hit it (for the HUD bar)
  /** Seconds since its last burst at the player or the teammate ended (see SHOT.share). */
  fired: number;
  aimYaw: number;
  aimPitch: number;
  summoned: number; // titan: how many summons used
  squad: number; // index into State.squads
  aware: Awareness;
  detect: number; // 0..1, full = engage
  home: Vec3; // post to return to
  face: number; // yaw watched at the post
  lookT: number; // idle head-turn phase
  goal: Point | null; // alert: where to search
  searchT: number;
  cover: Point | null; // engaged grunt: where it hides
  peek: Point | null; // and where it steps out to shoot
  coverT: number; // seconds until it re-checks its cover
  /**
   * Whom it fights: the player, the teammate when that one is nearer or shooting it, or one of
   * the player's own robots (`friendId`, see SUPPORT).
   */
  target: "player" | "ally" | "friend";
  targetT: number;
  /** The player's own robot (id) it fights while `target` is "friend". */
  friendId?: number;
  /** Seconds since the teammate last hit it. */
  allyHit: number;
  /** The player's own robot (id) that last hit it, and the raid's time then (see SUPPORT.hit). */
  friendBy?: number;
  friendAt?: number;
  /** A raider: tougher, deadlier, quicker to turn, and it goes round the player's side. */
  elite: boolean;
  /**
   * Its armour plate's tier (0 = none, see PLATE): body hits from weapons of lower
   * rarity are reduced; weak-point hits pass in full.
   */
  plate: Rarity;
  /** The plate it came with, kept once a piercing hit breaks it off: what it drops (`robotGear()`). */
  wore: Rarity;
  /** Seconds until it may change strafe direction. */
  strafeT: number;
  /** Seconds left of a jink: a fast sidestep the other way after being hit. */
  jink: number;
  /** Damage counted toward a stagger, decaying over `STAGGER.window`. */
  stagger: number;
  /** Seconds left in which it cannot be staggered again. */
  steady: number;
  /** The side of its cover a grunt steps out to next (+1 / -1): it alternates. */
  peekSide: number;
  /**
   * A grunt that has not yet fired since its squad engaged: seeing its target, it fires
   * that first burst from where it stands, strafing, and takes cover only after it.
   */
  opener: boolean;
  /**
   * Seconds a grunt has been walking toward its cover or peek spot (`stuckTo`) without getting
   * any closer: pressed against a corner its body does not fit past (see COVER.stuck).
   */
  stuckT: number;
  stuckTo: Point | null;
  /**
   * Seconds since this robot itself last saw the player or was hit by them, and where
   * the player was then. A squad that fights shares where it believes the player is,
   * but each member locates the player only with its own eyes (see `located()`).
   */
  blind: number;
  sawAt: Point | null;
  /** Progress (0..1) toward finding the player again after losing them (see AWARE.locate). */
  finding: number;
  /** How far down a grunt has crouched behind its cover (0 standing, 1 crouched; see DUCK). */
  duck: number;
  /** One of the rogues (野良機, see FACTION); the network's otherwise. */
  rogue?: boolean;
  /** One of the player's own robots (`State.friends`, the factory's): it fights the network and the rogues, never the player or the teammate. */
  friend?: boolean;
  /** One of another player's robots (a holding's defence in a sortie; side 3): that player's id. It fights the player and every faction. */
  rival?: string;
  /** A robot of a battle squad (`BattleSquad.id`, sim/battle.ts): it walks onto the player's nodes, and the garrisons fight it. */
  battle?: number;
  /** The AI player an enemy's battle robot is shown as (`BattleSquad.by`): drawn in another player's colour; no rule reads it. */
  by?: string;
  /** A turret: it never leaves the core it stands at. */
  post?: boolean;
}

/** A robot's body-sphere centre and weak point above its feet, lowered while it crouches. */
export const bodyY = (e: Enemy) => ENEMIES[e.kind].bodyY - e.duck * DUCK.body;
export const weakY = (e: Enemy) => ENEMIES[e.kind].weakY - e.duck * DUCK.head;

export interface SquadState {
  name: string;
  /** A wave of the siege of this node (a place in `NODES`): it leaves with the garrison once the node is taken. */
  siege?: number;
  poi: number; // -1 for optional squads between POIs
  patrol: Point[];
  leg: number; // next patrol waypoint
  engaged: boolean;
  /** Walks the roads: hears gunfire from further away. */
  roam: boolean;
  /** A reinforcement squad that keeps heading for the player until it first finds them. */
  hunt?: boolean;
  /**
   * Beamed in from afar (reinforcements, raiders): its walkers find their way by the
   * ground's field (hunt.ts) whenever they cannot see whom they are after, fight or not,
   * so one member's sighting does not strand the rest behind a cliff.
   */
  routed?: boolean;
  /** Raiders: elite members, and a closer hunt. */
  elite?: boolean;
  /** How far its members notice the player, in place of their kind's `SIGHT` range: a drone pack (`PACK`). */
  sight?: number;
  /** A drone pack: it flies its loop at `PACK.pace`. */
  pack?: boolean;
  /** A hunting party (`PARTY`): the stop of `PARTY_STOPS[region]` it is making for or lingering at. */
  party?: PartyTrip;
  /** Where a calm squad walks by the ground's way, and stands once there (a siege's walk-off, sim/front.ts). */
  walk?: Point;
  sinceSeen: number; // seconds since any member saw the player while engaged
  /** Seconds left in which its members answer the player's shots from as far as `RETURN.range` (see RETURN). */
  shotT?: number;
  /** Seconds the squad has kept the player in hand from behind cover since a member last saw them (see AWARE.coverHold). */
  hold?: number;
  last: Point; // where the squad last saw the player
  /** Where the squad has had the player pinned, and for how long (see PINCH); unset until it engages. */
  pin?: Point;
  pinT?: number;
  /** The player's motion when last seen, and how long they have been seen backing away (see PINCH). */
  vel?: Point;
  backT?: number;
  /**
   * Where the squad goes after the player while it has lost them (see PURSUE), and the way it
   * came at it from (a unit vector); unset while it sees them.
   */
  chase?: Point;
  chaseDir?: Point;
  /** Seconds since the squad last saw, heard or was hit by the player (see AWARE.chaseTime). */
  chaseT?: number;
  /** A rogue squad (see FACTION). */
  rogue?: boolean;
  /** The other faction's robot (id) the squad is fighting while it is not fighting the player, the seconds since a member last saw it, and where. */
  foe?: number;
  foeT?: number;
  foeAt?: Point;
  /** Seconds until its fire at the other faction is next heard (see FACTION.every). */
  heardT?: number;
  /** A squad walking one of `MOBILES` (its `patrol` is the walk, out and back). */
  mobile?: string;
  /** Where its leader stood when its walk was last checked for being stuck, and for how long since (see PATROL.stuck). */
  mark?: Point;
  markT?: number;
  /** Waiting at a choke point for the player (see AMBUSH): where, facing which way, for how much longer. */
  ambush?: { at: Point; face: number; t: number };
  /** Seconds it has fought the player this time, while it sees them (see SPLIT). */
  fightT?: number;
  /** Seconds left of being sent after the player (see SWEEP). */
  sweep?: number;
  /** Seconds left of walking off a node the player took (`FRONT.retreat`): it fights nobody, and is gone at 0. */
  retreat?: number;
  /** The player's own squad (its robots are in `State.friends`). */
  friend?: boolean;
  /** Another player's squad: that player's id. */
  rival?: string;
  /** The battle squad it is in the world (`BattleSquad.id`, sim/battle.ts). */
  battle?: number;
  /** A squad of the player's coming to the core of the node the player attacks: it goes at its fighting pace (sim/battle.ts `rally`). */
  rush?: boolean;
}

export interface Orb {
  id: number;
  pos: Vec3;
  vel: Vec3;
  r: number;
  dmg: number;
  life: number;
  homing: boolean;
  /** A shot at the other faction (see FACTION): the robot (id) that fired it, which hits robots of the other faction too. */
  by?: number;
  /** Fired by a rogue. */
  rogue?: boolean;
  /** Fired by one of the player's own robots: it never hits the player or the teammate. */
  friend?: boolean;
  /** Fired by one of another player's robots. */
  rival?: boolean;
  /** Fired by a robot shown as an AI player's (`Enemy.by`): drawn in another player's colour; no rule reads it. */
  ai?: true;
}

export interface Shockwave {
  x: number;
  z: number;
  y: number;
  r: number;
  hit: boolean;
  allyHit?: boolean;
}

export type LootKind = "weapon" | "armor" | "heal" | "shard" | "valuable" | "mod";

export interface Loot {
  id: number;
  kind: LootKind;
  weapon?: Weapon;
  heal?: HealKind;
  valuable?: ValuableKind;
  mod?: ModKind;
  /** For a part a taken core laid out (`coreReward()`): the node, as a place in `NODES`. One of a node's is taken, by the use key; the rest go with it. */
  choice?: number;
  /** For a valuable: the POI (index) whose bin it came out of, kept through the bag (`Player.haulAt`). */
  from?: number;
  /** Armour the player took off: it can be put back on with the use key, and its shield is not refilled. */
  worn?: boolean;
  rarity: Rarity;
  pos: Vec3;
  vel: Vec3;
  age: number;
}

export interface Bin {
  id: number;
  x: number;
  y: number;
  z: number;
  poi: number;
  open: boolean;
  /** One of the tall buildings' top-floor bins, which hold the best (`TOP_BINS`) and take longer to search. */
  top: boolean;
  /** Locked: opened only with the key of its POI. */
  vault: boolean;
  /** Out on the island between the POIs: `poi` only picks its loot table, and it never holds a key. */
  outside: boolean;
}

export interface CarePackage {
  x: number;
  z: number;
  y: number;
  landed: boolean;
  open: boolean;
  weapon: Weapon;
}

export type Phase = "play" | "done";

/** How a raid ended: off the island with what was carried, or wiped out. */
export type Outcome = "extracted" | "dead";

export type GameEvent =
  | { t: "shot"; weapon: WeaponKind; rarity: Rarity }
  | { t: "tracer"; from: Vec3; to: Vec3; hit: boolean }
  | { t: "impact"; pos: Vec3 }
  | { t: "hit"; id: number; pos: Vec3; dmg: number; crit: boolean; shield: boolean; tier: Rarity; flank: Flank; ally: boolean; /** A plate took part of this hit. */ blocked: boolean }
  | { t: "shieldBreak"; id: number; pos: Vec3; tier: Rarity }
  | { t: "plateBreak"; id: number; pos: Vec3; tier: Rarity }
  /** A robot reels from the damage it took; a wind-up it was in is lost. `fromX/Z` is where the shot came from. */
  | { t: "stagger"; id: number; pos: Vec3; fromX: number; fromZ: number; interrupted: boolean }
  | { t: "kill"; id: number; kind: EnemyKind; pos: Vec3; crit: boolean; last: boolean; ally: boolean; /** Where the killing shot came from, so the wreck falls away from it. */ fromX: number; fromZ: number }
  | { t: "allyShot"; from: Vec3; to: Vec3; hit: boolean }
  | { t: "allyHurt"; dmg: number }
  | { t: "allyDown" }
  | { t: "allyUp"; by: "player" | "self" }
  | { t: "allyRescue" }
  | { t: "awaitAlly" }
  | { t: "hurt"; dmg: number; fromX: number; fromZ: number; shieldBroke: boolean; shield: boolean }
  | { t: "down" }
  | { t: "revive" }
  | { t: "wipe" }
  | { t: "reload"; time: number }
  | { t: "reloaded" }
  | { t: "dry" }
  /** A slide; `chain` when a landing with the crouch held slid on. */
  | { t: "slide"; chain?: boolean }
  | { t: "jump" }
  | { t: "mantle" }
  /** A wall or cliff climbed hand over hand, `rise` metres up; `top` when the hands reach its top. */
  | { t: "climb"; rise: number }
  | { t: "climbTop" }
  /** A jump out of a slide, at `speed` along the ground. */
  | { t: "slideJump"; speed: number }
  /** On and off a zipline; `cut` when the line was cut under the rider (an end lost). */
  | { t: "zipOn"; line: number }
  | { t: "zipOff"; line: number; cut: boolean }
  | { t: "land"; speed: number }
  | { t: "pickup"; kind: LootKind; rarity: Rarity; label: string; valuable?: ValuableKind }
  | { t: "binOpen"; id: number }
  | { t: "tactical"; targets: Vec3[] }
  | { t: "tacticalMiss" }
  | { t: "ultReady" }
  | { t: "leap" }
  /** The ult was pressed under a roof: nothing happens and the charge is kept. */
  | { t: "leapBlocked" }
  | { t: "leapLand" }
  | { t: "healStart"; kind: HealKind }
  | { t: "healDone"; kind: HealKind }
  | { t: "telegraph"; id: number }
  | { t: "enemyFire"; id: number; pos: Vec3; /** At the other faction (see FACTION), toward this point. */ foe?: Vec3; rogue?: boolean; /** One of the player's own robots. */ friend?: boolean; /** One of another player's robots. */ rival?: boolean; /** Shown as an AI player's (`Enemy.by`). */ ai?: true }
  /** A robot hit by the other faction's fire, and one destroyed by it (see FACTION). */
  | { t: "robotHit"; id: number; pos: Vec3 }
  | { t: "fall"; id: number; kind: EnemyKind; pos: Vec3; rogue: boolean; friend?: boolean; /** One of another player's robots. */ rival?: true; fromX: number; fromZ: number }
  | { t: "lunge"; id: number }
  | { t: "spawn"; id: number; pos: Vec3 }
  | { t: "suspect"; id: number }
  | { t: "engage"; squad: number; id: number }
  | { t: "calm"; squad: number }
  | { t: "poiStart"; poi: number }
  | { t: "poiClear"; poi: number }
  | { t: "reinforce"; x: number; z: number }
  | { t: "careDrop"; x: number; z: number }
  | { t: "careLand"; x: number; z: number }
  | { t: "stomp"; x: number; z: number }
  | { t: "stompTelegraph"; id: number }
  | { t: "bossPhase" }
  | { t: "titanDown" }
  | { t: "searchStart"; id: number }
  | { t: "raiders"; x: number; z: number }
  /** A pickup that has to be called (the dropship, the boat) was called, came, or had robots beam in round it. */
  | { t: "shipCalled"; id: ExtractId }
  | { t: "shipLanded"; id: ExtractId }
  | { t: "shipWave"; id: ExtractId }
  /** A depot was switched on by walking up to it. */
  | { t: "depotOn"; poi: PoiId }
  /** A way in on foot was walked to for the first time this raid. */
  | { t: "entryFound"; id: EntryId }
  /** The bag was sent home from a depot: how many valuables, worth how much. */
  /** `left` = bag items not sent (no room); `full` = nothing sent because stash room was 0. */
  | { t: "deposit"; n: number; value: number; left?: number; room?: number; full?: boolean }
  /** The player chose to leave at a depot, and the countdown started or was broken off. */
  | { t: "leaveStart" }
  | { t: "leaveCancel" }
  /** A core's capture started (the alarm), was refused off the front, and the node was taken (places in `NODES`). */
  | { t: "coreStart"; node: number }
  /** The raid's momentum rose to `level` (`MOMENTUM`). */
  | { t: "momentum"; level: number }
  /** A wave of a core's siege is announced (its beam stands at x, z; wave `wave` of `of`), and its squad steps out. */
  | { t: "siegeWarn"; node: number; x: number; z: number; wave: number; of: number }
  | { t: "siegeLand"; x: number; z: number }
  | { t: "coreShielded"; node: number }
  | { t: "coreTaken"; node: number }
  /**
   * The battle (sim/battle.ts): a node changed hands; a squad of the factory came out of the camp's
   * gate or a node's depot at (x, z); a dropship or a boat set off to land the enemy's squad at (x, z);
   * the enemy's robots came to a core of the player's; and the battle's time ran out with the player still out.
   */
  | { t: "nodeTaken"; node: number; side: Side; /** The AI player a holding of the player's went to (`BattleSquad.by`). */ by?: string }
  | { t: "squadOut"; side: Side; node: number; x: number; z: number; gate: boolean }
  | { t: "landing"; boat: boolean; x: number; z: number }
  | { t: "nodeThreat"; node: number }
  /** The enemy's counter-attack on a node the player took a while ago set off (`COUNTER`). */
  | { t: "counter"; node: number }
  | { t: "timeUp" }
  /** A sortie's time ran out (`stepSortie()`): it ends alive with the stars as they stand. */
  | { t: "sortieUp" }
  /** The player walked off a sortie's holding (`stepSortie()`): it ends alive. */
  | { t: "sortieLeft" }
  /** The use key at a core of the player's that other players hold too (`State.jumps`): the view offers the sortie from it (sim/jump.ts). */
  | { t: "sortieOut"; node: number }
  | { t: "done" };

export interface Stats {
  kills: number;
  damage: number;
  shots: number;
  hits: number;
  crits: number;
  /** Hits from behind a robot, or before it noticed or located the player (see FLANK). */
  flankHits: number;
  /** Hits on the titan, which has no back or side (see FLANK): left out of the flank share. */
  titanHits: number;
  downs: number;
  wipes: number;
  /** The POIs cleared, in the order they fell. */
  cleared: number[];
  allyDamage: number;
  allyKills: number;
  allyDowns: number;
  /** Times the teammate picked the player up, and the player picked the teammate up. */
  allyRescues: number;
  allyHelped: number;
  /** Robots the player (not the teammate) brought down, by kind. */
  killsBy: Record<EnemyKind, number>;
  /** POIs whose vault the player opened. */
  vaults: number[];
  /** Squads destroyed to the last member, by `squadKey()`. */
  wiped: string[];
  /** The nodes taken by their cores (`NODES` ids), in the order they fell. */
  captured: NodeId[];
  /**
   * Contested coastal hubs whose core capture was started this raid while a real neighbour held
   * them (TKT-201): owner island code. Failed ones (not in `captured`) notify the defender.
   */
  contestedTried: { id: NodeId; owner: string }[];
}

/**
 * A hunting party's way between its region's stops: the stop it is going to, the seconds it still
 * lingers there once arrived (0 while walking), and where its leader stood when the walk was last
 * checked for being stuck, and for how long since (see PARTY.stuck).
 */
export interface PartyTrip {
  region: RegionId;
  stop: number;
  linger: number;
  mark: Point;
  markT: number;
}

/** One of a region's hunting parties: its squad while it lives (-1 once wiped out), and the seconds until its replacement beams in. */
export interface PartySlot {
  region: RegionId;
  squad: number;
  wait: number;
}

/** A squad of robots the player has seen or heard out between the POIs (`State.contacts`). */
export interface Contact {
  squad: number;
  x: number;
  z: number;
  t: number;
  rogue: boolean;
  /** Another player's squad. */
  rival?: true;
  /** Whether the squad was heard fighting lately, and when it last was (seeing it does not refresh this). */
  fight: boolean;
  fightT: number;
}

/** A called pickup on its way: seconds until it is there (0 = there), and the robots that beam in meanwhile. */
export interface Call {
  t: number;
  wave: number;
  waveT: number;
  /** The squad this pickup's waves join (-1 until the first wave), so each pickup counts its own robots. */
  squad: number;
}

export interface State {
  time: number;
  phase: Phase;
  /** The region the raid started in. */
  region: RegionId;
  /** The raid's seed, for what is decided without drawing on `rng` (the mod parts in the bins). */
  seed: number;
  rng: number;
  /**
   * The random numbers of the drone packs' starts and the hunting parties' stops, spawns and
   * waits (`roamRand()`): a stream of their own, so the robots between the POIs do not shift
   * what the rest of the raid draws.
   */
  roamRng: number;
  nextId: number;
  player: Player;
  ally: Ally;
  /** The player's footsteps on the ground, about a metre apart; the teammate walks them. */
  trail: Vec3[];
  enemies: Enemy[];
  /** The player's own robots in the world (the factory's squads near the player, sim/battle.ts). */
  friends: Enemy[];
  squads: SquadState[];
  orbs: Orb[];
  waves: Shockwave[];
  loot: Loot[];
  bins: Bin[];
  care: CarePackage | null;
  /** POIs the player has come into (for the arrival banner), and those cleared of robots. */
  visited: boolean[];
  cleared: boolean[];
  /**
   * Who holds each POI on the island this raid, by POI index (`PoiHold`): its garrison. A freed
   * POI starts cleared, with no robots and its depot on.
   */
  hold: PoiHold[];
  /**
   * Factory level of each rival owner defending contested coastal hubs this raid (`Start.defence`).
   * Empty when the sim gate plays (no rivals → bench hash unchanged).
   */
  defence: Record<string, number>;
  /** Extra 島の守り grunts at contested POI indices (from `Start.parcels` counts, capped at DEFENCE_AID). */
  defenceAid: Record<number, number>;
  /**
   * 「攻める」raid (TKT-218): N/M odds, defence HP pool, damage dealt toward ★1.
   * Null when the gate did not pick a rival hub (field / sim gate).
   */
  attack: {
    id: NodeId;
    owner: string;
    N: number;
    M: number;
    /** Total HP+shield of that hub's defence at raid start. */
    defenceMax: number;
    /** Damage the player / teammate dealt to that defence. */
    defenceDealt: number;
  } | null;
  /** Seconds until the next reinforcement squad beams in, and how many have come. */
  reinforceT: number;
  reinforceN: number;
  /** Seconds until the raiders beam in (Infinity once they have). */
  raiderT: number;
  /** The enemy's strength the raid is played at (`STRENGTH.levels`), from the nodes it holds: it sets the hunters' times and numbers. */
  strength: number;
  /** The mod kinds the profile knows: the bins hold only these (`binMod()`). */
  known: ModKind[];
  /** A factor on every mod part's chance: 1, or 0 for a raid without parts (the sim gate's check of their independence). */
  modOdds: number;
  /** This raid's POI whose bins lean to a rare kind (`BOOST`), as a POI index. */
  boost: { poi: number; kind: ValuableKind };
  outcome: Outcome | null;
  /** Seconds the player has stood ready in an extraction point. */
  extractTime: number;
  /** The pickups called so far (the dropship, the boat), by extraction point. */
  calls: Partial<Record<ExtractId, Call>>;
  /** The hunting parties, `PARTY.count` per region. */
  parties: PartySlot[];
  /** The way the player left the island. */
  extractedAt: ExtractId | null;
  /** The depots switched on, by place in `DEPOTS`: those of earlier raids and those walked up to in this one. */
  depots: boolean[];
  /** Valuables sent home from a depot this raid: they reach the stash however the raid ends. */
  sent: ValuableKind[];
  /** Tools sent home the same way. */
  /** Where each of `sent` came from, as `Player.haulAt`. */
  sentAt: number[];
  /**
   * Free stash slots left for depot sends this raid (set at start from the profile after takeKit).
   * Decremented on each deposit; Infinity when the start omitted it (sim gate). 0 means 倉庫が満杯
   * and the bag may still leave with the player.
   */
  stashRoom: number;
  /** Wanted valuables at raid start (depot send priority); empty when omitted. */
  stashWant: Partial<Record<ValuableKind, number>>;
  /** Hunt target valuable this raid (目標); null when none. */
  goal: ValuableKind | null;
  /** Goal progress at raid start: have / need (stash + still wanted). */
  goalNeed: number;
  goalHave: number;
  /**
   * A sortie to a neighbour's holding (`Start.sortie`, docs/ringfall/holdings-raid.md): the node
   * and POI attacked, its owner, when time runs out and how far from the core the player may walk
   * before the sortie ends. Null for a raid of the player's own island.
   */
  sortie: { node: number; poi: number; owner: string; end: number; leave: number } | null;
  /**
   * The nodes (indices) of the player's whose core a sortie may set out from (`Start.jumps`): another
   * player holds the same node on their island. The use key there pushes `sortieOut`; no rule reads it.
   */
  jumps: number[];
  /** A sortie's record for its holding's owner (sim/replay.ts); null for any other raid. */
  replay: Replay | null;
  /**
   * Defence stock queued this raid when the player deposits at a depot (`leftParcels` only;
   * not world pickups). The sim gate never deposits, so the bench hash is unchanged.
   */
  parcels: WorldParcel[];
  /** Parcels left at depots this raid (to report / keep on the island). */
  leftParcels: { poi: PoiId; kind: ValuableKind }[];
  /** Parcel ids taken this raid (cleared from the island on report). */
  takenParcels: number[];
  /** Leaving at a depot: which one, and the seconds still to stand there. */
  leaving: { depot: number; t: number } | null;
  /** The depot the raid ended at, if it ended at one. */
  leftAt: PoiId | null;
  /** Seconds the player has spent outside the camp's yard this raid (`HOME`). */
  away: number;
  /** The raid ended by walking back into the camp. */
  home: boolean;
  /** Who holds each node of the front (`NODES` order) this raid: as the island stood at the start, then as it changes hands. */
  nodes: NodeHold[];
  /**
   * The core capture under way (`FRONT`): its node, the seconds of the meter filled, whether it
   * filled this tick, the waves of its siege called so far (`FRONT.siege`), the seconds before
   * the next may be tried, and the wave announced and on its way (`coming`: where its beam stands,
   * the raid's time it steps out at, where each member will stand, which wave of how many, and
   * whether it wears the node's plate); null for none.
   */
  capture: {
    node: number;
    t: number;
    held: boolean;
    waves: number;
    wait: number;
    coming: { x: number; z: number; at: number; kinds: EnemyKind[]; spots: { mx: number; mz: number }[]; from: string; wave: number; of: number; guard: boolean } | null;
  } | null;
  /**
   * What the player has seen or heard of the robots out between the POIs, for the map: each squad
   * (by index) where it was last seen or heard, when, whether it is the rogues', and whether that
   * was fighting the other faction (see FACTION).
   */
  contacts: Contact[];
  /** Seconds until the factions next look for each other, the contacts are next updated, and ambushes next thought about. */
  factionT: number;
  contactT: number;
  ambushT: number;
  /** Seconds since a robot last fought the player (see SWEEP). */
  quietT: number;
  /** The day's battle (陣取り戦, sim/battle.ts), or null for a raid that has none (the sim gate's tables). */
  battle: Battle | null;
  /** The ways in walked to this raid (`ENTRY`), the start's own first unless it began at a depot: the base learns them if the player gets off alive. */
  found: EntryId[];
  /** The explored map, one 0 / 1 per cell (`exploreSize()`, `cellOf()`), carried over from earlier raids. */
  seen: number[];
  /** The cell the player was last marked in, so the map is marked only when they cross into another. */
  cell: number;
  /**
   * The use key's sticky focus (`useTarget`): a stable id (`bin:3`, `loot:12`, `core:1`…) so the
   * prompt and the press stay on one thing while several overlap; null when nothing is in reach.
   */
  useFocus: string | null;
  /**
   * The focus was chosen with the cycle key: keep it until it leaves reach or the player cycles
   * again, so a HUD frame's ordinary `useTarget` does not snap back to the best-scoring candidate.
   */
  useHeld: boolean;
  events: GameEvent[];
  stats: Stats;
}

export interface Input {
  moveX: number; // -1 left .. 1 right
  moveZ: number; // -1 back .. 1 forward
  lookX: number; // radians, positive turns right
  lookY: number; // radians, positive looks up
  fire: boolean;
  ads: boolean;
  jump: boolean;
  crouch: boolean;
  reload: boolean;
  tactical: boolean;
  ult: boolean;
  interact: boolean;
  /**
   * Cycle the use key's sticky focus among candidates in reach (`USE`, `useTarget`): edge-triggered
   * on the keyboard (`cycleUse` in view/keys.ts).
   */
  cycleUse: boolean;
  swap: boolean;
  slot: number; // -1 none, 0 / 1 select
  /** Use the item that fits best: shield first when it is lower, big items for big gaps. */
  heal: boolean;
  /** The input comes from a touch screen (stronger aim assist, see ASSIST.touchPull). */
  touch: boolean;
  /** The use key never swaps back into armour taken off (the bot keeps the better one). */
  keepArmor?: boolean;
  /** Mod parts are neither put on by walking over them nor by the use key: the bot plays without them. */
  leaveMods?: boolean;
  /**
   * No climbing walls or cliffs (`CLIMB`): the bot's paths (nav.ts) run on the ground, so it only
   * mantles low ledges in the air as it always has.
   */
  noClimb?: boolean;
}

export const idleInput = (): Input => ({
  moveX: 0,
  moveZ: 0,
  lookX: 0,
  lookY: 0,
  fire: false,
  ads: false,
  jump: false,
  crouch: false,
  reload: false,
  tactical: false,
  ult: false,
  interact: false,
  cycleUse: false,
  swap: false,
  slot: -1,
  heal: false,
  touch: false,
});

/** Seconds until a called pickup is there: -1 when it has not been called, 0 once it is there. */
export const callLeft = (s: State, id: ExtractId) => s.calls[id]?.t ?? -1;

/** A small integer hash, so the boost does not draw on the raid's random numbers. */
export function mix(n: number): number {
  let h = Math.imul((n >>> 0) ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * The POI of `region` whose bins lean rare in the raid started from `seed`, and the kind
 * they lean to: one of its table's kinds of rarity 2 or more.
 */
export function boostFor(seed: number, region: RegionId): { poi: number; kind: ValuableKind } {
  const h = mix(seed);
  const ids = regionOf(region).pois;
  const poi = poiIndex(ids[h % ids.length]);
  const rare = POIS[poi].loot.valuable.map(([k]) => k).filter((k) => VALUABLES[k].rarity >= 2);
  return { poi, kind: rare[(h >>> 8) % rare.length] };
}

/** Bin weights in the boosted POI: its kind as often as `BOOST.share` times all the rest. */
export function boosted(table: [ValuableKind, number][], kind: ValuableKind): [ValuableKind, number][] {
  const total = table.reduce((n, [, w]) => n + w, 0);
  return [...table.filter(([k]) => k !== kind), [kind, total * BOOST.share + (table.find(([k]) => k === kind)?.[1] ?? 0)]];
}

/** The explored map's size in cells, over the world's bounds. */
export const exploreSize = () => ({ cols: Math.ceil((WORLD.x1 - WORLD.x0) / DEPOT.cell), rows: Math.ceil((WORLD.z1 - WORLD.z0) / DEPOT.cell) });

/** The explored map's cell holding (x, z), row by row from the world's north-west corner; -1 outside the world. */
export function cellOf(x: number, z: number): number {
  const { cols, rows } = exploreSize();
  const c = Math.floor((x - WORLD.x0) / DEPOT.cell);
  const r = Math.floor((z - WORLD.z0) / DEPOT.cell);
  return c < 0 || r < 0 || c >= cols || r >= rows ? -1 : r * cols + c;
}

const emptySeen = () => new Array<number>(exploreSize().cols * exploreSize().rows).fill(0);

/** The explored map for saving: four cells to a hex digit. */
export function encodeSeen(seen: number[]): string {
  let out = "";
  for (let i = 0; i < seen.length; i += 4) out += ((seen[i] ? 1 : 0) | (seen[i + 1] ? 2 : 0) | (seen[i + 2] ? 4 : 0) | (seen[i + 3] ? 8 : 0)).toString(16);
  return out;
}

/** A saved explored map; one of another size keeps the cells both have, and anything unreadable counts as unexplored. */
export function decodeSeen(str: string): number[] {
  const seen = emptySeen();
  for (let i = 0; i < str.length && i * 4 < seen.length; i++) {
    const n = parseInt(str[i], 16);
    if (Number.isNaN(n)) continue;
    for (let b = 0; b < 4 && i * 4 + b < seen.length; b++) seen[i * 4 + b] = (n >> b) & 1;
  }
  return seen;
}

/**
 * What a raid carries over from earlier ones: the depots on, the explored map, and where it
 * starts: a depot (`from`, which counts only when it is among `depots`) or else a way in
 * (`entry`) of its region.
 */
export interface Start {
  depots?: PoiId[];
  from?: PoiId;
  /** A way in on foot; left out, or not one of the region's, the region's first. */
  entry?: EntryId;
  seen?: string;
  /** Who holds each POI (meta/island.ts); left out, every POI is held. The titan's pad is always held. */
  island?: Partial<Record<PoiId, PoiHold>>;
  /** The mod kinds the profile knows; left out, `MOD_START`. */
  known?: ModKind[];
  /** No mod part anywhere in the raid (for the sim gate's check that they draw on nothing). */
  noMods?: boolean;
  /** The day's battle (陣取り戦) and what the player brings to it; left out, the raid has none. */
  battle?: BattleStart;
  /**
   * Parcels at depots from the island / profile (ux-design C2). For contested hubs another player
   * holds, counts at those POIs become 島の守り grunts in the defence (`DEFENCE_AID` cap). Left
   * out, none — the sim gate and campaigns omit them, so their hashes stay put.
   */
  parcels?: readonly { id: number; poi: PoiId; kind: ValuableKind; from: { code: string; name: string } }[];
  /**
   * Factory level of each rival owner whose contested coastal hub stands a defence this raid
   * (方向 A: 工場の部隊). Left out, rival contested hubs stay empty (sim gate / no neighbours).
   */
  defence?: readonly { owner: string; factory: number }[];
  /**
   * Free stash slots for 中継ボックス sends this raid. Left out, unlimited (sim gate / campaigns:
   * deposit never runs there, so hashes stay put when omitted).
   */
  stashRoom?: number;
  /**
   * Valuables the hideout / factory still want at raid start (for depot send order).
   * Left out, depot sends in bag order.
   */
  stashWant?: Partial<Record<ValuableKind, number>>;
  /** Hunt target for this raid (目標 · n / m). Left out, none. */
  goal?: ValuableKind | null;
  goalHave?: number;
  goalNeed?: number;
  /**
   * 「攻める」target chosen at the gate (TKT-218): star scoring +N/−M for this hub only.
   * Left out, no star raid (overnight / sync still move trophies).
   */
  attack?: { id: NodeId; owner: string; N: number; M: number };
  /**
   * A sortie to a neighbour's holding (docs/ringfall/holdings-raid.md): the raid is played at that
   * node alone, starting at its depot, with only the owner's defence (their factory's kinds and up
   * to `DEFENCE_AID` grunts of 島の守り) standing; no other robot, bin or timer of the island.
   * `N` / `M` are the stars' trophy odds (`raidOdds()`), scored as `attack` is. Overrides `island`,
   * `from`, `entry`, `battle`, `defence`, `parcels` and `attack`.
   */
  sortie?: { id: NodeId; owner: string; factory: number; aid?: number; N: number; M: number };
  /** The nodes whose core, while the player's, a sortie may set out from (`State.jumps`). None for a sortie. */
  jumps?: NodeId[];
}

/** A parcel on the ground by a depot this raid. */
export interface WorldParcel {
  id: number;
  poi: PoiId;
  kind: ValuableKind;
  from: { code: string; name: string };
  x: number;
  y: number;
  z: number;
  /** Taken into the bag this raid. */
  taken: boolean;
}

/** What the enemy's strength sets in a raid. */
export const strengthLevel = (s: Pick<State, "strength">) => STRENGTH.levels[s.strength];

/**
 * The enemy's strength with `held` of the nodes the player's (`STRENGTH.byShare`). A share is
 * reached when `held` is at least the share of the node count rounded up; the small allowance
 * keeps a share that lands on a whole count (0.5 of 10 nodes) from rounding up past it in floating point.
 */
export const strengthFor = (held: number) => STRENGTH.byShare.find(([share]) => held >= Math.ceil(share * NODES.length - 1e-9))?.[1] ?? 0;

/**
 * The reinforcements' first time and interval and the raiders' time of a raid at the enemy's
 * strength `strength`.
 */
export function raidClock(strength: number) {
  const l = STRENGTH.levels[strength];
  return { first: l.reinforce.first, every: l.reinforce.every, raiders: l.raiders };
}

/**
 * A raid in `region`, on the ground with the teammate beside the player: at one of the region's
 * ways in, or at a depot already on (in that depot's region). The default is the reservoir,
 * which the sim gate plays.
 */
export function newRun(seed = 1, kit: Kit = starterKit(), region: RegionId = HOME_REGION.id, start: Start = {}): State {
  // The hunters' fields kept from an earlier raid would steer this one's hunters near the
  // same spots: a raid starts with none, so it plays the same whatever was played before it.
  forgetFields();
  const sortie = start.sortie && nodeIndex(start.sortie.id) >= 0 && start.sortie.owner ? start.sortie : null;
  if (sortie) start = sortieStart(start, sortie);
  const hold = POIS.map((p): PoiHold => (p.boss ? "foe" : (start.island?.[p.id] ?? "foe")));
  const nodes = nodeHolds((id) => hold[poiIndex(id)]);
  // A raid whose start names no island is the one the balance tables are played on.
  const strength = start.island ? strengthFor(ownNodes(nodes)) : STRENGTH.play;
  const clock = raidClock(strength);
  const owned = (poi: PoiId) => hold[poiIndex(poi)] === "own";
  // An owned POI's depot is on, so a raid may start from it too.
  const depotsOn = DEPOTS.map((d) => !!start.depots?.includes(d.poi) || owned(d.poi) || sortie?.id === d.poi);
  const from = start.from && (start.depots?.includes(start.from) || owned(start.from) || sortie?.id === start.from) ? DEPOTS[depotIndex(start.from)] : null;
  if (from) region = poiRegion(from.poi).id;
  const ways = regionOf(region).entries;
  const entry = entryOf(start.entry && ways.includes(start.entry) ? start.entry : ways[0]);
  const bins: Bin[] = [];
  let id = 1;
  POIS.forEach((p, poi) => p.bins.forEach((b) => bins.push({ id: id++, x: b.x, y: b.y ?? 0, z: b.z, poi, open: false, top: false, vault: !!b.vault, outside: false })));
  for (const b of EXTRA_BINS) bins.push({ id: id++, x: b.x, y: b.y ?? 0, z: b.z, poi: poiIndex(b.table), open: false, top: !!b.top, vault: false, outside: true });
  const loot: Loot[] = [];
  POIS.forEach((p) =>
    p.floor.forEach((f) => {
      const pos = { x: f.x, y: f.y ?? 0, z: f.z };
      const vel = { x: 0, y: 0, z: 0 };
      if (f.weapon) loot.push({ id: id++, kind: "weapon", rarity: f.weapon[1], weapon: { kind: f.weapon[0], rarity: f.weapon[1], mag: -1 }, pos, vel, age: 99 });
      if (f.armor !== undefined) loot.push({ id: id++, kind: "armor", rarity: f.armor, pos, vel, age: 99 });
      if (f.heal) loot.push({ id: id++, kind: "heal", heal: f.heal, rarity: 1, pos, vel, age: 99 });
    }),
  );
  const defence: Record<string, number> = {};
  if (sortie) defence[sortie.owner] = sortie.factory;
  for (const d of start.defence ?? []) {
    if (typeof d.owner === "string" && d.owner && Number.isFinite(d.factory)) defence[d.owner] = d.factory;
  }
  // 島の守り stock at contested hubs another player holds → up to DEFENCE_AID grunts in that garrison.
  const defenceAid: Record<number, number> = {};
  if (sortie) defenceAid[poiIndex(sortie.id)] = Math.max(0, Math.min(DEFENCE_AID, Math.floor(sortie.aid ?? 0)));
  for (const q of start.parcels ?? []) {
    const i = poiIndex(q.poi);
    if (i < 0 || !isContestedPoi(i)) continue;
    const who = rivalOf(hold[i] ?? "foe");
    if (!who || defence[who] === undefined) continue;
    defenceAid[i] = Math.min(DEFENCE_AID, (defenceAid[i] ?? 0) + 1);
  }
  const s: State = {
    time: 0,
    phase: "play",
    region: regionOf(region).id,
    seed: seed >>> 0,
    rng: seed >>> 0 || 1,
    roamRng: mix(seed) || 1,
    nextId: id,
    player: {
      pos: { x: entry.x, y: groundAt(entry.x, entry.z, PLAYER.radius, 99), z: entry.z },
      vel: { x: 0, y: 0, z: 0 },
      yaw: entry.yaw,
      pitch: 0,
      hp: PLAYER.hp,
      shield: PLAYER.shieldByTier[kit.armor],
      armor: kit.armor,
      onGround: true,
      crouch: false,
      sliding: false,
      mantle: null,
      jumpBuf: 0,
      airFrom: 0,
      zip: null,
      zipFall: false,
      zipRegrip: 0,
      sprinting: false,
      forwardHeld: 0,
      weapons: [0, 1].map((i) => (kit.weapons[i] ? { ...kit.weapons[i], mag: -1 } : null)),
      slot: 0,
      cooldown: 0,
      reload: 0,
      triggerHeld: false,
      ads: 0,
      recoil: 0,
      recoilYaw: 0,
      spray: 0,
      lastShot: -99,
      tactical: 0,
      haste: 0,
      ult: ULT.startCharge,
      leap: null,
      reveal: 0,
      stepNoise: 0,
      heals: { ...kit.heals },
      haul: [],
      haulAt: [],
      mods: [],
      search: null,
      healing: null,
      sinceHurt: 99,
      downed: 0,
      awaitAlly: false,
      selfRevive: 1,
      iframes: 0,
    },
    ally: newAlly(entry),
    trail: [],
    enemies: [],
    friends: [],
    squads: [],
    orbs: [],
    waves: [],
    loot,
    bins,
    care: null,
    visited: POIS.map(() => false),
    // An owned POI has nothing left to clear: it is not cleared again, and does not count as cleared this raid.
    // A POI with no garrison standing (the player's, or another player's without contested defence) starts cleared.
    cleared: hold.map((h, i) => {
      // A sortie is played at its holding alone: no other POI stands robots to clear, nor counts as cleared.
      if (sortie && POIS[i].id !== sortie.id) return true;
      if (h === "foe") return false;
      const who = rivalOf(h);
      if (who && (isContestedPoi(i) || POIS[i].id === sortie?.id) && defence[who] !== undefined) return false;
      return true;
    }),
    hold,
    defence,
    defenceAid,
    attack: (() => {
      const a = sortie ? { id: sortie.id, owner: sortie.owner, N: sortie.N, M: sortie.M } : start.attack;
      if (!a) return null;
      const poi = poiIndex(a.id);
      if (poi < 0 || (!sortie && !isContestedPoi(poi))) return null;
      const who = rivalOf(hold[poi] ?? "foe");
      if (!who || who !== a.owner) return null;
      const factory = defence[who] ?? 0;
      const aid = defenceAid[poi] ?? 0;
      return {
        id: a.id,
        owner: a.owner,
        N: Math.max(1, Math.round(a.N)),
        M: Math.max(1, Math.round(a.M)),
        defenceMax: defencePool(factory, aid),
        defenceDealt: 0,
      };
    })(),
    reinforceT: sortie ? Infinity : clock.first,
    reinforceN: 0,
    raiderT: sortie ? Infinity : clock.raiders,
    strength,
    known: [...(start.known ?? MOD_START)],
    modOdds: start.noMods ? 0 : 1,
    boost: boostFor(seed, region),
    outcome: null,
    extractTime: 0,
    calls: {},
    parties: [],
    extractedAt: null,
    depots: depotsOn,
    sent: [],
    sentAt: [],
    stashRoom: start.stashRoom ?? Infinity,
    stashWant: { ...(start.stashWant ?? {}) },
    goal: start.goal ?? null,
    goalHave: start.goalHave ?? 0,
    goalNeed: start.goalNeed ?? 0,
    sortie: sortie
      ? (() => {
          const node = nodeIndex(sortie.id);
          const core = NODES[node].core;
          const d = DEPOTS[depotIndex(sortie.id)];
          return { node, poi: poiIndex(sortie.id), owner: sortie.owner, end: SORTIE.time, leave: Math.hypot(d.x - core.x, d.z - core.z) + SORTIE.leave };
        })()
      : null,
    jumps: sortie ? [] : (start.jumps ?? []).map((id) => nodeIndex(id)).filter((i) => i >= 0),
    replay: sortie ? newReplay(nodeIndex(sortie.id)) : null,
    // Parcels are island-DO defence stock, not in-raid pickups (ux-design: one primary at the depot).
    parcels: [],
    leftParcels: [],
    takenParcels: [],
    leaving: null,
    leftAt: null,
    away: 0,
    home: false,
    found: from || sortie ? [] : [entry.id],
    nodes,
    capture: null,
    contacts: [],
    factionT: 0,
    contactT: 0,
    ambushT: 0,
    // The walk in from the edge is quiet by design: no sweep before the first fight, or a minute and more in (see SWEEP).
    quietT: -SWEEP.start,
    battle: null,
    seen: start.seen ? decodeSeen(start.seen) : emptySeen(),
    cell: -1,
    useFocus: null,
    useHeld: false,
    events: [],
    stats: { kills: 0, damage: 0, shots: 0, hits: 0, crits: 0, flankHits: 0, titanHits: 0, downs: 0, wipes: 0, cleared: [], allyDamage: 0, allyKills: 0, allyDowns: 0, allyRescues: 0, allyHelped: 0, killsBy: { drone: 0, grunt: 0, charger: 0, heavy: 0, titan: 0 }, vaults: [], wiped: [], captured: [], contestedTried: [] },
  };
  if (from) {
    const p = s.player;
    // A few steps back from the depot, facing it and the POI beyond: the depot is in sight and in reach.
    const x = from.x - Math.sin(from.yaw) * DEPOT.back;
    const z = from.z + Math.cos(from.yaw) * DEPOT.back;
    p.pos = { x, y: groundAt(x, z, PLAYER.radius, from.y + 0.3), z };
    p.yaw = from.yaw;
  }
  if (s.sortie) {
    // A sortie is played at the holding alone: only its own bins and floor loot are there.
    const at = s.sortie.poi;
    const there = POIS[at];
    s.bins = s.bins.filter((b) => b.poi === at && !b.outside);
    s.loot = s.loot.filter((l) => Math.hypot(l.pos.x - there.x, l.pos.z - there.z) < there.trigger);
  }
  useZones(s);
  // What the nodes held give a raid at its start (`UNLOCKS`): the leap's charge, and one mod part the profile knows, picked from the seed.
  NODES.forEach((n, i) => {
    if (s.nodes[i] !== "own") return;
    const u = UNLOCKS[n.id];
    if (u.ult) s.player.ult = Math.min(1, s.player.ult + u.ult);
    if (u.mod && s.modOdds > 0 && s.known.length && !s.player.mods.length) s.player.mods.push(s.known[(mix(Math.imul(seed + 7, 0x9e3779b1)) >>> 0) % s.known.length]);
  });
  placeAlly(s);
  populate(s);
  // The battle's walks are traced now, and the fields that traced them forgotten, before anything else builds one.
  if (start.battle) s.battle = initBattle(s, start.battle);
  if (!s.sortie) placeParties(s);
  return s;
}

/**
 * The start of a sortie (`Start.sortie`): the holding is the owner's and every other POI the
 * enemy's (whose robots `populate()` leaves out), at the holding's depot, with no battle.
 */
function sortieStart(start: Start, sortie: NonNullable<Start["sortie"]>): Start {
  const { battle: _b, defence: _d, parcels: _p, attack: _a, entry: _e, island: _i, depots: _dp, ...rest } = start;
  return { ...rest, island: { [sortie.id]: rivalHold(sortie.owner) }, from: sortie.id };
}

/**
 * A squad's name for wiped-squad tracking: a drone pack by its own name, a hunting party by
 * its region (its line-up changes from raid to raid), any other squad by its name.
 */
export const squadKey = (sq: Pick<SquadState, "name" | "party">) => (sq.party ? partyKey(sq.party.region) : sq.name);

/** The key every hunting party of `region` is destroyed under. */
export const partyKey = (region: RegionId) => `party:${region}`;

/** The teammate before it is stood beside the player (`placeAlly()`), at `at`. */
export function newAlly(at: { x: number; z: number; yaw: number }): Ally {
  return {
    active: false,
    pos: { x: at.x, y: 0, z: at.z },
    vel: { x: 0, y: 0, z: 0 },
    yaw: at.yaw,
    pitch: 0,
    hp: ALLY.hp,
    shield: ALLY.shield,
    down: 0,
    helped: 0,
    rescue: 0,
    target: 0,
    pickT: 0,
    cooldown: 0,
    shots: 0,
    sinceHurt: 99,
    crumb: 0,
    climb: 0,
    stuckT: 0,
    last: { x: at.x, z: at.z },
    shortcutT: 0,
  };
}

/** One step of a deterministic xorshift. */
function xorshift(x: number): number {
  x ^= x << 13;
  x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5;
  return x >>> 0 || 1;
}

/** Deterministic xorshift; the state is the seed so runs replay exactly. */
export function rand(s: State): number {
  s.rng = xorshift(s.rng);
  return (s.rng % 1_000_000) / 1_000_000;
}

/** The same on the packs' and parties' own stream (`State.roamRng`). */
export function roamRand(s: State): number {
  s.roamRng = xorshift(s.roamRng);
  return (s.roamRng % 1_000_000) / 1_000_000;
}

/** Full health and shield of a robot; raiders have more. */
export const enemyHp = (e: Enemy) => ENEMIES[e.kind].hp * (e.elite ? ELITE.hp : 1);
export const enemyShield = (e: Enemy) => ENEMIES[e.kind].shield * (e.elite ? ELITE.hp : 1);
export const enemyMax = (e: Enemy) => enemyHp(e) + enemyShield(e);

/** Scratch for `forward()`: rewritten each call; callers must read it before the next `forward()`. */
const forwardOut: Vec3 = { x: 0, y: 0, z: 0 };

/** Unit vector the player looks along. yaw 0 = -z, yaw +π/2 = +x. */
export function forward(yaw: number, pitch: number): Vec3 {
  const c = Math.cos(pitch);
  forwardOut.x = Math.sin(yaw) * c;
  forwardOut.y = Math.sin(pitch);
  forwardOut.z = -Math.cos(yaw) * c;
  return forwardOut;
}
