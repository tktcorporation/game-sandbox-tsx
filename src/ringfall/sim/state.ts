import { ALLY, BOOST, DEPOT, ELITE, ENEMIES, META, RAIDERS, REINFORCE, VALUABLES, WORLD, type ValuableKind, PLAYER, ULT, type EnemyKind, type Flank, type HealKind, type Rarity, type ToolKind, type WeaponKind } from "./config";
import { DEPOTS, depotIndex, entryOf, EXTRA_BINS, POIS, poiIndex, poiRegion, regionOf, type EntryId, type ExtractId, type PoiId, type RegionId, type RouteId } from "./map";
import { openRoutes, useRoutes } from "./routes";
import { populate } from "./enemies";
import { placeAlly } from "./ally";
import { groundAt } from "./geom";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Weapon {
  kind: WeaponKind;
  rarity: Rarity;
  mag: number;
  /** Lent for a free raid: it goes back to the trader and never reaches the stash. */
  loan?: boolean;
}

/** What the player takes into a raid. */
export interface Kit {
  weapons: { kind: WeaponKind; rarity: Rarity; loan?: boolean }[];
  armor: Rarity;
  heals: Record<HealKind, number>;
  /** Of `heals`, how many are lent (used first, never brought home). */
  lentHeals: Record<HealKind, number>;
  /** Vault keys taken along, as POI indices. */
  keys: number[];
}

/** The lent kit of a free raid, which is also the default for the gates. */
export const freeKit = (): Kit => ({
  weapons: META.free.weapons.map((w) => ({ ...w, loan: true })),
  armor: 0,
  heals: { ...META.free.heals },
  lentHeals: { ...META.free.heals },
  keys: [],
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
  /** Climbing a ledge: rises at the start point, then moves onto the top. */
  mantle: { t: number; dur: number; from: Vec3; to: Vec3 } | null;
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
  ult: number; // charge 0..1
  /** In the air on the ult's leap, going up and then gliding down; `carry` takes the teammate along. */
  leap: { carry: boolean } | null;
  reveal: number; // seconds left of seeing robots through walls
  stepNoise: number; // seconds until the next sprint footstep sound
  heals: Record<HealKind, number>;
  /** Of `heals`, how many are still lent: used first, and never brought home. */
  lentHeals: Record<HealKind, number>;
  /** Flares carried (0 or 1): they call the plateau pickup. */
  flares: number;
  /** Valuables carried; their worth is the raid's score if the player gets off the island. */
  haul: ValuableKind[];
  /** Keys on the ring, as the POIs whose vaults they open (copies included). They take no bag space. */
  keys: number[];
  /** Tools carried (`TOOLS`): they fill bag slots beside the haul and score nothing, but open a route once home. */
  tools: ToolKind[];
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
  /** Whom it fights: the player, or the teammate when that one is nearer or shooting it. */
  target: "player" | "ally";
  targetT: number;
  /** Seconds since the teammate last hit it. */
  allyHit: number;
  /** A raider: tougher, deadlier, quicker to turn, and it goes round the player's side. */
  elite: boolean;
  /**
   * Its armour plate's tier (0 = none, see PLATE): body hits from weapons of lower
   * rarity are reduced; weak-point hits pass in full.
   */
  plate: Rarity;
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
   * Seconds since this robot itself last saw the player or was hit by them, and where
   * the player was then. A squad that fights shares where it believes the player is,
   * but each member locates the player only with its own eyes (see `located()`).
   */
  blind: number;
  sawAt: Point | null;
  /** Progress (0..1) toward finding the player again after losing them (see AWARE.locate). */
  finding: number;
}

export interface SquadState {
  name: string;
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
  sinceSeen: number; // seconds since any member saw the player while engaged
  last: Point; // where the squad last saw the player
  /** Where the squad has had the player pinned, and for how long (see PINCH); unset until it engages. */
  pin?: Point;
  pinT?: number;
}

export interface Orb {
  id: number;
  pos: Vec3;
  vel: Vec3;
  r: number;
  dmg: number;
  life: number;
  homing: boolean;
}

export interface Shockwave {
  x: number;
  z: number;
  y: number;
  r: number;
  hit: boolean;
  allyHit?: boolean;
}

export type LootKind = "weapon" | "armor" | "heal" | "shard" | "flare" | "valuable" | "key" | "tool";

export interface Loot {
  id: number;
  kind: LootKind;
  weapon?: Weapon;
  heal?: HealKind;
  valuable?: ValuableKind;
  /** For a key: the POI whose vault it opens. */
  key?: number;
  tool?: ToolKind;
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
  /** One of the high-rises' top-floor bins, which also hold a flare. */
  flare: boolean;
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
  | { t: "slide" }
  | { t: "jump" }
  | { t: "mantle" }
  | { t: "land"; speed: number }
  | { t: "pickup"; kind: LootKind; rarity: Rarity; label: string }
  | { t: "locked"; poi: number }
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
  | { t: "enemyFire"; id: number; pos: Vec3 }
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
  | { t: "flareLit" }
  | { t: "shipWave"; id: ExtractId }
  /** A depot was switched on by walking up to it. */
  | { t: "depotOn"; poi: PoiId }
  /** The bag was sent home from a depot: how many valuables, worth how much. */
  | { t: "deposit"; n: number; value: number }
  /** The player chose to leave at a depot, and the countdown started or was broken off. */
  | { t: "leaveStart" }
  | { t: "leaveCancel" }
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
  /** The routes open in this raid's world (`ROUTES` order); `step()` keeps that world in place. */
  routes: RouteId[];
  /** The raid's seed, for what is decided without drawing on `rng` (the tools in the bins). */
  seed: number;
  rng: number;
  nextId: number;
  player: Player;
  ally: Ally;
  /** The player's footsteps on the ground, about a metre apart; the teammate walks them. */
  trail: Vec3[];
  enemies: Enemy[];
  squads: SquadState[];
  orbs: Orb[];
  waves: Shockwave[];
  loot: Loot[];
  bins: Bin[];
  care: CarePackage | null;
  /** POIs the player has come into (for the arrival banner), and those cleared of robots. */
  visited: boolean[];
  cleared: boolean[];
  /** Seconds until the next reinforcement squad beams in, and how many have come. */
  reinforceT: number;
  reinforceN: number;
  /** Seconds until the raiders beam in (Infinity once they have). */
  raiderT: number;
  /** This raid's POI whose bins lean to a rare kind (`BOOST`), as a POI index. */
  boost: { poi: number; kind: ValuableKind };
  outcome: Outcome | null;
  /** Seconds the player has stood ready in an extraction point. */
  extractTime: number;
  /** The pickups called so far (the dropship, the boat), by extraction point. */
  calls: Partial<Record<ExtractId, Call>>;
  /** The way the player left the island. */
  extractedAt: ExtractId | null;
  /** The depots switched on, by place in `DEPOTS`: those of earlier raids and those walked up to in this one. */
  depots: boolean[];
  /** Valuables sent home from a depot this raid: they reach the stash however the raid ends. */
  sent: ValuableKind[];
  /** Tools sent home the same way. */
  sentTools: ToolKind[];
  /** Credits' worth sent home through each depot this raid, by place in `DEPOTS`: it levels that depot (`DEPOT.levels`). */
  sentVia: number[];
  /** Leaving at a depot: which one, and the seconds still to stand there. */
  leaving: { depot: number; t: number } | null;
  /** The depot the raid ended at, if it ended at one. */
  leftAt: PoiId | null;
  /** The explored map, one 0 / 1 per cell (`exploreSize()`, `cellOf()`), carried over from earlier raids. */
  seen: number[];
  /** The cell the player was last marked in, so the map is marked only when they cross into another. */
  cell: number;
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
  swap: boolean;
  slot: number; // -1 none, 0 / 1 select
  /** Use the item that fits best: shield first when it is lower, big items for big gaps. */
  heal: boolean;
  /** The input comes from a touch screen (stronger aim assist, see ASSIST.touchPull). */
  touch: boolean;
  /** The use key never swaps back into armour taken off (the bot keeps the better one). */
  keepArmor?: boolean;
  /** The use key never takes up a tool: the bot plays the gate's raids as they stand without tools. */
  leaveTools?: boolean;
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
  swap: false,
  slot: -1,
  heal: false,
  touch: false,
});

/** Seconds until a called pickup is there: -1 when it has not been called, 0 once it is there. */
export const callLeft = (s: State, id: ExtractId) => s.calls[id]?.t ?? -1;

/** A small integer hash, so the boost and the tools do not draw on the raid's random numbers. */
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
  /** The routes opened in earlier raids: the raid's world has them open. */
  routes?: RouteId[];
}

/**
 * A raid in `region`, on the ground with the teammate beside the player: at one of the region's
 * ways in, or at a depot already on (in that depot's region). The default is the reservoir,
 * which the sim gate plays.
 */
export function newRun(seed = 1, kit: Kit = freeKit(), region: RegionId = "reservoir", start: Start = {}): State {
  const routes = openRoutes(start.routes ?? []);
  useRoutes(routes);
  const from = start.from && start.depots?.includes(start.from) ? DEPOTS[depotIndex(start.from)] : null;
  if (from) region = poiRegion(from.poi).id;
  const ways = regionOf(region).entries;
  const entry = entryOf(start.entry && ways.includes(start.entry) ? start.entry : ways[0]);
  const bins: Bin[] = [];
  let id = 1;
  POIS.forEach((p, poi) => p.bins.forEach((b) => bins.push({ id: id++, x: b.x, y: b.y ?? 0, z: b.z, poi, open: false, flare: false, vault: !!b.vault, outside: false })));
  for (const b of EXTRA_BINS) bins.push({ id: id++, x: b.x, y: b.y ?? 0, z: b.z, poi: poiIndex(b.table), open: false, flare: !!b.flare, vault: false, outside: true });
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
  const s: State = {
    time: 0,
    phase: "play",
    region: regionOf(region).id,
    routes,
    seed: seed >>> 0,
    rng: seed >>> 0 || 1,
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
      ult: ULT.startCharge,
      leap: null,
      reveal: 0,
      stepNoise: 0,
      heals: { ...kit.heals },
      lentHeals: { ...kit.lentHeals },
      flares: 0,
      haul: [],
      keys: [...kit.keys],
      tools: [],
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
    squads: [],
    orbs: [],
    waves: [],
    loot,
    bins,
    care: null,
    visited: POIS.map(() => false),
    cleared: POIS.map(() => false),
    reinforceT: REINFORCE.first,
    reinforceN: 0,
    raiderT: RAIDERS.at,
    boost: boostFor(seed, region),
    outcome: null,
    extractTime: 0,
    calls: {},
    extractedAt: null,
    depots: DEPOTS.map((d) => !!start.depots?.includes(d.poi)),
    sent: [],
    sentTools: [],
    sentVia: DEPOTS.map(() => 0),
    leaving: null,
    leftAt: null,
    seen: start.seen ? decodeSeen(start.seen) : emptySeen(),
    cell: -1,
    events: [],
    stats: { kills: 0, damage: 0, shots: 0, hits: 0, crits: 0, flankHits: 0, titanHits: 0, downs: 0, wipes: 0, cleared: [], allyDamage: 0, allyKills: 0, allyDowns: 0, allyRescues: 0, allyHelped: 0, killsBy: { drone: 0, grunt: 0, charger: 0, heavy: 0, titan: 0 }, vaults: [] },
  };
  if (from) {
    const p = s.player;
    // A few steps back from the depot, facing it and the POI beyond: the depot is in sight and in reach.
    const x = from.x - Math.sin(from.yaw) * DEPOT.back;
    const z = from.z + Math.cos(from.yaw) * DEPOT.back;
    p.pos = { x, y: groundAt(x, z, PLAYER.radius, from.y + 0.3), z };
    p.yaw = from.yaw;
  }
  placeAlly(s);
  populate(s);
  return s;
}

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

/** Deterministic xorshift; the state is the seed so runs replay exactly. */
export function rand(s: State): number {
  let x = s.rng;
  x ^= x << 13;
  x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5;
  x >>>= 0;
  s.rng = x || 1;
  return (s.rng % 1_000_000) / 1_000_000;
}

/** Full health and shield of a robot; raiders have more. */
export const enemyHp = (e: Enemy) => ENEMIES[e.kind].hp * (e.elite ? ELITE.hp : 1);
export const enemyShield = (e: Enemy) => ENEMIES[e.kind].shield * (e.elite ? ELITE.hp : 1);
export const enemyMax = (e: Enemy) => enemyHp(e) + enemyShield(e);

/** Unit vector the player looks along. yaw 0 = -z, yaw +π/2 = +x. */
export function forward(yaw: number, pitch: number): Vec3 {
  const c = Math.cos(pitch);
  return { x: Math.sin(yaw) * c, y: Math.sin(pitch), z: -Math.cos(yaw) * c };
}
