import type { PoiId } from "./map";
/**
 * Every tuning number of RINGFALL. Units are metres, seconds and degrees unless noted.
 * Change a number here only together with a re-run of `npm run sim:ringfall` and an
 * update to docs/ringfall/balance.md.
 */

export const TICK = 1 / 60;
export const DEG = Math.PI / 180;

export const WORLD = {
  /**
   * The world's bounds on each axis: the reservoir in the south (+z), the harbor in the
   * north. The coast's cliffs (terrain.ts) stop bodies well inside them.
   */
  x0: -440,
  x1: 460,
  z0: -1220,
  z1: 660,
  gravity: 15,
  stepUp: 0.45,
};

export const PLAYER = {
  radius: 0.4,
  eye: 1.6,
  eyeCrouch: 1.0,
  hp: 100,
  walk: 4.6,
  sprint: 7.2,
  crouch: 2.6,
  accel: 70, // reaches top speed in ~0.1 s
  airAccel: 14,
  jump: 5.4,
  slideStart: 9.6, // speed set at slide start when slower
  slideFriction: 4.2,
  slideMin: 4.0,
  /** Share of gravity along the ground that pulls a slide down a slope, and its top speed. */
  slideSlope: 0.7,
  slideMax: 15,
  autoSprintAfter: 0.2, // forward input without firing for this long turns into a sprint
  regenDelay: 5,
  regenPerSec: 6,
  /** Health comes back on its own only this far; above it takes a syringe or a med kit. */
  regenCap: 30,
  shieldByTier: [25, 50, 75, 100],
  downedTime: 3,
  reviveHp: 60,
  reviveIframes: 1.5,
  shardShield: 8,
  shardMagnet: 7,
  pickupRange: 2.6,
  interactRange: 2.4,
};

/**
 * Climbing over a ledge in the air while pushing toward it. Hands reach `reach`
 * above the feet, so a jump clears about 2.9 m: crates, containers, low walls and
 * rock shelves, but not a storey (3.4 m).
 */
export const MANTLE = {
  reach: 1.9,
  /** Seconds to climb the full reach; a lower ledge is quicker. */
  time: 0.5,
  /** How far past the body the hands look for the edge, and where the feet land. */
  probe: 0.2,
  land: 0.5,
  /** Speed kept after climbing, along the way the player faced. */
  exitSpeed: 4,
};

export type HealKind = "cell" | "battery" | "syringe" | "medkit";

/**
 * Healing items. Small ones are quick and top up; big ones fill but leave the player
 * slow and unable to shoot for longer, and every one is heard nearby (`NOISE.heal`), so
 * healing belongs after breaking contact, not in the middle of a fight. `amount` 0 fills.
 */
export const HEALS: Record<HealKind, { label: string; short: string; shield: boolean; amount: number; time: number; max: number }> = {
  cell: { label: "シールドセル", short: "セル", shield: true, amount: 25, time: 1.8, max: 6 },
  battery: { label: "シールドバッテリー", short: "バッテリー", shield: true, amount: 0, time: 3.6, max: 3 },
  syringe: { label: "注射器", short: "注射器", shield: false, amount: 25, time: 2.1, max: 4 },
  medkit: { label: "医療キット", short: "医療キット", shield: false, amount: 0, time: 4.5, max: 2 },
};
export const HEAL_KINDS = Object.keys(HEALS) as HealKind[];

export const ASSIST = {
  /**
   * Half-angle of the cone in which a shot that misses the hitbox still hits the enemy.
   * Narrow enough that a strafing robot has to be tracked: a crosshair left where the
   * robot was misses once it has moved a body width.
   */
  hipCone: 1.5,
  adsCone: 2.1,
  /** Touch input: the cone is this much wider, since a thumb tracks a jinking target less closely than a mouse. */
  touchCone: 1.35,
  /** Extra metres of tolerance far away, so distant enemies are not impossible. */
  farPadding: 0.2,
  /** Look sensitivity multiplier while the crosshair is near an enemy. */
  slowdown: 0.55,
  slowCone: 9,
  /**
   * Fraction of the angle to the target closed per second while aiming down sights, moving
   * or not. Hip fire gets no pull: the help goes to the deliberate aimed shot, not to
   * strafing and spraying.
   */
  pull: 1.6,
  /**
   * Touch aiming: pull also works while firing from the hip, and this much faster.
   * A thumb cannot hold aim and track at once the way a mouse hand can.
   */
  touchPull: 1.8,
  pullCone: 12,
  range: 70,
};

export type WeaponKind = "pike" | "hornet" | "maul" | "lance" | "talon";
export type Rarity = 0 | 1 | 2 | 3; // white, blue, purple, gold

export interface WeaponSpec {
  name: string;
  label: string;
  dmg: number;
  pellets: number;
  interval: number; // seconds between shots
  auto: boolean;
  mag: number;
  reload: number;
  hipSpread: number;
  adsSpread: number;
  falloffStart: number;
  falloffEnd: number;
  falloffMin: number;
  crit: number;
  recoil: number; // degrees of pitch kick per shot
  /** Degrees of sideways kick per shot, scaled by `KICK_PATTERN` along a spray (0: none). */
  kick: number;
  /**
   * The vertical view while aiming, in degrees, written against a 74° vertical hip view: the view
   * (view/world.ts) narrows by the same ratio of half-angle tangents from whatever hip view the screen has.
   */
  adsFov: number;
  /** Aiming looks through a scope: the view zooms to adsFov behind a round sight, with no gun in view. */
  scope?: true;
}

export const WEAPONS: Record<WeaponKind, WeaponSpec> = {
  pike: { name: "PIKE", label: "アサルトライフル", dmg: 14, pellets: 1, interval: 0.1, auto: true, mag: 24, reload: 1.6, hipSpread: 1.3, adsSpread: 0.3, falloffStart: 40, falloffEnd: 70, falloffMin: 0.7, crit: 1.75, recoil: 0.32, kick: 0.32, adsFov: 52 },
  hornet: { name: "HORNET", label: "サブマシンガン", dmg: 10, pellets: 1, interval: 0.066, auto: true, mag: 26, reload: 1.3, hipSpread: 2.0, adsSpread: 0.9, falloffStart: 18, falloffEnd: 40, falloffMin: 0.55, crit: 1.6, recoil: 0.22, kick: 0.28, adsFov: 60 },
  maul: { name: "MAUL", label: "ショットガン", dmg: 11, pellets: 8, interval: 0.8, auto: false, mag: 6, reload: 2.2, hipSpread: 5.0, adsSpread: 3.6, falloffStart: 9, falloffEnd: 22, falloffMin: 0.3, crit: 1.5, recoil: 2.2, kick: 0.9, adsFov: 62 },
  // A bolt-action sniper: one hit drops most robots that have not noticed the player.
  talon: { name: "TALON", label: "スナイパー", dmg: 90, pellets: 1, interval: 1.2, auto: false, mag: 5, reload: 2.6, hipSpread: 4.5, adsSpread: 0, falloffStart: 999, falloffEnd: 1000, falloffMin: 1, crit: 2.0, recoil: 3.2, kick: 0, adsFov: 18, scope: true },
  lance: { name: "LANCE", label: "マークスマン", dmg: 48, pellets: 1, interval: 0.36, auto: false, mag: 10, reload: 2.0, hipSpread: 1.6, adsSpread: 0, falloffStart: 999, falloffEnd: 1000, falloffMin: 1, crit: 2.0, recoil: 1.6, kick: 0.5, adsFov: 38 },
};

/**
 * The sideways kick along a spray, shot by shot: a drift right, a swing left, back
 * right, repeating. Fixed rather than random, so holding the trigger is a pattern the
 * player learns to pull against. The spray restarts after `KICK_RESET` s without a shot.
 */
export const KICK_PATTERN = [0.3, 0.6, 0.9, 1, 0.7, 0.2, -0.4, -0.9, -1, -0.8, -0.3, 0.3, 0.8, 1, 0.6, 0, -0.6, -1, -0.9, -0.4];
export const KICK_RESET = 0.35;

/** Interval multiplier when a semi-auto weapon repeats because the trigger is held. */
export const SEMI_HOLD = 1.3;

/** Per-rarity multipliers. Gold also reloads the magazine on every kill. */
export const RARITY = {
  names: ["コモン", "レア", "エピック", "レジェンド"],
  mag: [1, 1.25, 1.5, 1.5],
  dmg: [1, 1, 1.1, 1.15],
  reload: [1, 0.95, 0.9, 0.85],
};

export const TACTICAL = {
  cooldown: 12,
  range: 32,
  cone: 75,
  maxTargets: 4,
  dmg: 40,
  stun: 1.3,
};

/**
 * The ult: a leap straight up into the sky and a glide away, to break off a fight that
 * is going wrong. It goes up only under open sky, carries a teammate standing close,
 * and comes down only on low ground. The launch is loud, and in the air
 * the robots can still see and shoot: where to glide to decides whether it works.
 */
export const ULT = {
  dmgPerCharge: 1100, // damage dealt for a full charge
  /** Charge gained per second on top of the damage: a full gauge in 150 s of doing nothing. */
  perSec: 1 / 150,
  startCharge: 0.5,
  /** Upward speed at launch (m/s): about 26 m up under the island's gravity. */
  rise: 28,
  /** Fastest the glide sinks (m/s) once past the top. */
  fall: 8,
  /** Horizontal speed steered in the air (m/s) and how quickly it is reached. */
  glide: 15,
  glideAccel: 20,
  /** Seconds of glide ahead checked for high ground, which the glider keeps out of. */
  edgeLook: 0.4,
  /** Open sky needed above the head to go up at all. */
  headroom: 8,
  /** A standing teammate within this many metres comes along. */
  carry: 20,
};

export type EnemyKind = "drone" | "grunt" | "charger" | "heavy" | "titan";

export interface EnemySpec {
  hp: number;
  shield: number;
  shieldTier: Rarity;
  radius: number; // body sphere radius
  bodyY: number; // body sphere centre above feet
  weakY: number;
  weakR: number;
  weakFwd: number; // weak point offset toward facing
  speed: number;
  fly: number; // hover height, 0 = walks
  range: number; // preferred distance to the player
  telegraph: number;
  cooldown: number;
  shots: number;
  shotGap: number;
  spread: number; // degrees between pellets of one volley (fan)
  orbSpeed: number;
  orbDmg: number;
  orbR: number;
  ult: number; // ult charge multiplier for damage to this kind
}

export const ENEMIES: Record<EnemyKind, EnemySpec> = {
  drone: { hp: 70, shield: 0, shieldTier: 0, radius: 0.55, bodyY: 0, weakY: 0, weakR: 0.24, weakFwd: 0.42, speed: 4.2, fly: 3.4, range: 14, telegraph: 0.55, cooldown: 1.6, shots: 1, shotGap: 0, spread: 0, orbSpeed: 62, orbDmg: 21, orbR: 0.2, ult: 1 },
  grunt: { hp: 140, shield: 70, shieldTier: 1, radius: 0.6, bodyY: 1.1, weakY: 1.86, weakR: 0.27, weakFwd: 0.08, speed: 3.2, fly: 0, range: 15, telegraph: 0.6, cooldown: 1.5, shots: 3, shotGap: 0.16, spread: 0, orbSpeed: 76, orbDmg: 20, orbR: 0.18, ult: 1 },
  charger: { hp: 120, shield: 50, shieldTier: 0, radius: 0.72, bodyY: 0.75, weakY: 0.95, weakR: 0.3, weakFwd: 0.62, speed: 6.4, fly: 0, range: 0, telegraph: 0.6, cooldown: 1.2, shots: 0, shotGap: 0, spread: 0, orbSpeed: 0, orbDmg: 40, orbR: 0, ult: 1 },
  heavy: { hp: 270, shield: 130, shieldTier: 2, radius: 0.95, bodyY: 1.4, weakY: 2.35, weakR: 0.36, weakFwd: 0.1, speed: 2.0, fly: 0, range: 18, telegraph: 0.85, cooldown: 3.2, shots: 5, shotGap: 0, spread: 9, orbSpeed: 54, orbDmg: 18, orbR: 0.26, ult: 1 },
  titan: { hp: 3200, shield: 1000, shieldTier: 3, radius: 2.3, bodyY: 3.2, weakY: 3.4, weakR: 0.75, weakFwd: 2.1, speed: 1.6, fly: 0, range: 20, telegraph: 1.0, cooldown: 3.0, shots: 6, shotGap: 0.16, spread: 0, orbSpeed: 13, orbDmg: 9, orbR: 0.48, ult: 0.5 },
};

export const CHARGER = { lungeSpeed: 19, lungeTime: 0.38, lungeRange: 8, hitRadius: 1.3 };

export const TITAN = {
  stompRange: 26,
  stompSpeed: 15,
  stompDmg: 24,
  stompHeight: 0.7, // feet above ground needed to jump over the wave
  stompTelegraph: 1.1,
  homing: 0.55, // radians per second the rockets turn
  summonAt: [0.66, 0.33],
  enrageAt: 0.5,
};

/**
 * What a raid scores when the player gets off the island: the value carried out,
 * plus a bonus for each POI cleared and for the titan. A raid that ends in a wipe
 * scores nothing.
 */
export const SCORE = {
  poi: 400,
  titan: 1500,
  /** Lowest score for each rank, best first. */
  ranks: [
    ["S", 4500],
    ["A", 3000],
    ["B", 1500],
    ["C", 0],
  ] as const,
};

export type ValuableKind = "fuse" | "parts" | "wire" | "board" | "drive" | "gyro" | "core" | "reactor";

/**
 * Things worth carrying out. Every bin holds one (which kinds is the POI's `loot.valuable`);
 * robots drop some; the best sit up high, in the vaults or with the titan. Small and dear
 * (the drive) is what a pouch wants; big and dear (the reactor) has to be carried home.
 */
export const VALUABLES: Record<ValuableKind, { label: string; value: number; size: number; rarity: Rarity }> = {
  fuse: { label: "ヒューズ", value: 60, size: 1, rarity: 1 },
  parts: { label: "部品", value: 100, size: 1, rarity: 1 },
  wire: { label: "銅線の束", value: 180, size: 2, rarity: 1 },
  board: { label: "回路基板", value: 300, size: 2, rarity: 2 },
  drive: { label: "記憶装置", value: 450, size: 1, rarity: 2 },
  gyro: { label: "ジャイロ", value: 650, size: 2, rarity: 3 },
  core: { label: "データコア", value: 1000, size: 3, rarity: 3 },
  reactor: { label: "小型炉心", value: 2200, size: 4, rarity: 3 },
};

/** What the top-floor bins of the high-rises hold instead of their table's valuable, with weights. */
export const TOP_BINS: [ValuableKind, number][] = [["core", 2], ["gyro", 1], ["board", 2]];

/**
 * Valuables robots drop: the titan and heavies always theirs, the others one of `scrap`
 * with its chance (one roll for the lot).
 */
export const ROBOT_DROPS = {
  titan: ["core", "core"] as ValuableKind[],
  heavy: ["board"] as ValuableKind[],
  scrap: [["fuse", 0.15], ["parts", 0.15]] as [ValuableKind, number][],
};

/**
 * Each raid, one POI of the region dropped into has bins that lean rare: they hold `kind`
 * (one of the rarer kinds of its own table) as often as `share` times everything else
 * together. Which POI and kind follow from the raid's seed (`boostFor()` in state.ts), so
 * the base's radio can tell them before the raid.
 */
export const BOOST = { share: 1 };

/** The bag the valuables go in: what does not fit stays on the ground unless something cheaper makes way. */
export const BAG = { slots: 10 };

/**
 * The depots outside the POIs (`DEPOTS`): walked up to once, one stays on for good. Its use
 * key sends the bag home, or, with the bag empty, leaves the raid there; a later raid may
 * start from any depot already on. The map is uncovered cell by cell where the player walks.
 */
export const DEPOT = {
  /** Metres: walking this close switches a depot on. */
  radius: 6,
  /** Seconds standing at it after choosing to leave. */
  leave: 5,
  /** Metres behind a depot a raid started there begins: inside its reach (PLAYER.interactRange + 1). */
  back: 2.5,
  /**
   * Metres: a robot fighting the player this close shuts the depots (about twice a robot's
   * sight). One further off is outrun: the titan, which never stands down, shuts only depots
   * near its arena.
   */
  safe: 60,
  /** Metres: a side of one cell of the explored map. */
  cell: 20,
  /** Cells uncovered round the player's own, each way. */
  sight: 1,
  /**
   * Credits' worth sent home through one depot, over all raids, that each level of it needs.
   * A start at a depot skips the walk in from the region's edge and begins beside a POI with the teammate, so the gear it
   * may carry is earned at that depot: the more it has been trusted with, the more it lets in.
   */
  levels: [0, 1500, 5000, 12000],
  /** Loadout points a raid started from a depot may carry, by that depot's level. A start at a way in has no limit. */
  budget: [2, 4, 6, 9],
  /**
   * Points a stash weapon costs, by rarity. The lent free kit and every heal cost nothing: a
   * start with them alone is always allowed, so a depot never locks the player out.
   */
  weaponCost: [1, 2, 3, 4],
  /** Points armour costs, by tier (tier 0 is no armour). */
  armorCost: [0, 1, 2, 3],
  /** Points a vault key costs: it opens a POI's best bin, worth a step of rarity in a weapon. */
  keyCost: 1,
};

/**
 * The ways in on foot (`ENTRIES`) a player has walked to: one reached in a raid that ends with
 * the player off alive can be chosen at the base from then on. A player starts knowing only
 * the reservoir's first.
 */
export const ENTRY = {
  /** Metres: walking this close to a way in, on its ground, finds it. */
  radius: 10,
  /** Metres above or below the ground there that still counts as on it (not a bridge or roof overhead). */
  rise: 3,
};

/**
 * Between raids: what the player keeps, what things cost, and what is lost. Whatever is
 * taken into a raid is lost with it on a wipe, except what fits in the pouch: the most
 * valuable things in the bag, up to its slots. A raid with the free kit risks nothing:
 * its gear is lent and goes back at the end, whatever happens.
 */
export const META = {
  /** Things the stash holds (each weapon, armour, item or valuable is one). */
  stash: 40,
  /** Bag slots (as `VALUABLES[].size`) whose contents come home even from a wipe. */
  pouch: 2,
  start: {
    cash: 1500,
    weapons: [{ kind: "pike", rarity: 0 }, { kind: "hornet", rarity: 0 }] as { kind: WeaponKind; rarity: Rarity }[],
    heals: { cell: 2, battery: 0, syringe: 2, medkit: 0 } as Record<HealKind, number>,
  },
  /** The lent kit of a free raid. */
  free: {
    weapons: [{ kind: "pike", rarity: 0 }, { kind: "talon", rarity: 0 }] as { kind: WeaponKind; rarity: Rarity }[],
    heals: { cell: 2, battery: 0, syringe: 2, medkit: 0 } as Record<HealKind, number>,
  },
  /** Trader prices. A weapon's price is its base times its rarity's factor. */
  weapon: { pike: 600, hornet: 500, maul: 700, lance: 900, talon: 1200 } as Record<WeaponKind, number>,
  rarityFactor: [1, 2.5, 5, 9],
  /** Armour by tier (1 to 3); tier 0 is none. */
  armor: [0, 400, 1200, 3000],
  heal: { cell: 60, battery: 250, syringe: 60, medkit: 250 } as Record<HealKind, number>,
  /** What a key counts as for selling (the trader never sells keys). */
  key: 800,
  /** Share of the price the trader pays for gear (valuables sell at their full value). */
  sellShare: 0.4,
  /** The best rarity of weapon and tier of armour the trader sells; better is found in raids. */
  shopRarity: 1 as Rarity,
  /**
   * The trader also sells valuables, at `markup` times their value: those no rarer than
   * the gear it sells (`shopRarity`, raised by the workbench), so the common parts never
   * hold the hideout up and credits buy the rarer ones once the workbench is built.
   */
  materials: { markup: 2 },
};

export type ModuleId = "generator" | "infirmary" | "workbench" | "storage" | "radio" | "pouch" | "craft";

/** One level of a hideout module: what it takes from the stash, and the module levels it needs first. */
export interface ModuleLevel {
  items: [ValuableKind, number][];
  cash: number;
  needs: [ModuleId, number][];
  /** What this level does, in a line, for the base. */
  does: string;
}

/**
 * The hideout at the base: modules built level by level from specific valuables and some
 * credits, all taken from the stash. The generator powers the rest; the escape craft is the
 * last project, and finishing it ends the playthrough (the game goes on after).
 * Each level's effect is the number at its place in the module's own list below
 * (index 0 is the module unbuilt).
 */
export const HIDEOUT: Record<ModuleId, { name: string; note: string; levels: ModuleLevel[] }> = {
  generator: {
    name: "発電機",
    note: "ほかの設備の上の段に電気を回す",
    levels: [
      { items: [["fuse", 4], ["wire", 1]], cash: 300, needs: [], does: "設備の Lv1 を動かせる" },
      { items: [["fuse", 4], ["wire", 3], ["board", 3]], cash: 1500, needs: [], does: "設備の Lv2 を動かせる" },
      { items: [["board", 4], ["drive", 3], ["gyro", 2]], cash: 4000, needs: [["workbench", 1]], does: "設備の Lv3 と脱出艇の制御系を動かせる" },
    ],
  },
  infirmary: {
    name: "医務室",
    note: "毎回のレイドに回復を持たせる（貸出装備でも）",
    levels: [
      { items: [["parts", 3], ["fuse", 2]], cash: 500, needs: [["generator", 1]], does: "注射器 +1" },
      { items: [["parts", 3], ["board", 3]], cash: 1500, needs: [["generator", 2]], does: "注射器 +1、シールドセル +2" },
      { items: [["board", 3], ["drive", 2], ["gyro", 2]], cash: 3000, needs: [["generator", 3]], does: "注射器 +2、シールドセル +2、医療キット +1" },
    ],
  },
  workbench: {
    name: "作業台",
    note: "商人が売る武器とアーマー、材料の質が上がる",
    levels: [
      { items: [["parts", 4], ["wire", 2]], cash: 800, needs: [["generator", 1]], does: "商人がエピックまで売る。回路基板と記憶装置も売る" },
      { items: [["board", 4], ["drive", 2], ["gyro", 3]], cash: 3500, needs: [["generator", 2]], does: "商人がレジェンドまで売る。ジャイロ、データコア、小型炉心も売る" },
    ],
  },
  storage: {
    name: "倉庫",
    note: "倉庫に置ける数が増える",
    levels: [
      { items: [["parts", 3], ["wire", 2]], cash: 600, needs: [], does: "倉庫 +10" },
      { items: [["wire", 3], ["board", 3]], cash: 1500, needs: [["generator", 1]], does: "倉庫 +10" },
      { items: [["board", 3], ["drive", 2], ["gyro", 2]], cash: 3000, needs: [["generator", 2]], does: "倉庫 +10" },
    ],
  },
  radio: {
    name: "無線機",
    note: "出撃前に島の様子が分かる",
    levels: [
      { items: [["wire", 2], ["board", 2], ["drive", 1]], cash: 1200, needs: [["generator", 1]], does: "珍しい物が多い拠点が分かる" },
      { items: [["board", 3], ["drive", 2], ["gyro", 2]], cash: 3000, needs: [["generator", 2]], does: "その拠点で出やすい物と、レイダーの降りる時刻も分かる" },
    ],
  },
  pouch: {
    name: "ポーチ",
    note: "倒れても残る枠が増える",
    levels: [
      { items: [["wire", 2], ["board", 2]], cash: 1000, needs: [], does: "ポーチ 3 枠" },
      { items: [["drive", 3], ["gyro", 2]], cash: 2500, needs: [["generator", 2]], does: "ポーチ 4 枠" },
    ],
  },
  craft: {
    name: "脱出艇",
    note: "直せば島を出られる",
    levels: [
      { items: [["wire", 4], ["board", 4]], cash: 12500, needs: [["generator", 2], ["workbench", 1]], does: "船体を塞ぐ" },
      { items: [["gyro", 5], ["drive", 4], ["board", 4]], cash: 25000, needs: [["radio", 1]], does: "航法装置を据える" },
      { items: [["core", 3], ["board", 6], ["gyro", 4]], cash: 40000, needs: [["generator", 3], ["radio", 2]], does: "制御系をつなぐ" },
      { items: [["reactor", 1], ["core", 1], ["gyro", 4], ["drive", 3]], cash: 60000, needs: [["workbench", 2]], does: "機関に火を入れる" },
    ],
  },
};

/** The hideout's effects, by module level (index 0 is unbuilt), on top of `META`'s base numbers. */
export const HIDEOUT_EFFECT = {
  /** Heals the infirmary adds to every raid's kit, lent like the free kit's. */
  infirmary: [{}, { syringe: 1 }, { syringe: 1, cell: 2 }, { syringe: 2, cell: 2, medkit: 1 }] as Partial<Record<HealKind, number>>[],
  /** Steps of rarity the trader sells above `META.shopRarity`. */
  workbench: [0, 1, 2],
  /** Room in the stash above `META.stash`. */
  storage: [0, 10, 20, 30],
  /** Pouch slots above `META.pouch`. */
  pouch: [0, 1, 2],
};

/**
 * Searching a bin takes time with the hands busy and makes a noise; a top-floor bin
 * of a high-rise takes longer. Moving away, shooting or healing breaks it off.
 */
export const SEARCH = { time: 2.2, flareTime: 3.5, vaultTime: 5, noise: 9 };

/**
 * Vaults: one locked bin per POI, opened only with that POI's key. A key turns up in the
 * bins of the POI before it (`(poi + 3) % 4`, so the supply depot's key is at the landing
 * pad), comes home like any other find and opens its vault on every later raid.
 */
export const VAULT = {
  keyChance: 0.15,
  weapon: [["talon", 3], ["lance", 3], ["pike", 3], ["hornet", 3], ["maul", 2]] as [WeaponKind, Rarity][],
  armor: 3 as Rarity,
  /**
   * The plate (see PLATE) of the guard posted nearest each vault. The guard stands in a POI
   * the raid clears on its way, so its plate stays light: a rare gun pierces it and the free
   * kit's common one still does half.
   */
  guardPlate: 1 as Rarity,
  valuables: [["reactor"], ["core", "drive"], ["gyro", "drive", "drive"]] as ValuableKind[][],
  heals: 2,
};

export type ToolKind = "cutter" | "charge";

/**
 * Tools open the blocked routes (`ROUTES` in map.ts) for good once one reaches the stash.
 * Each lies in the bins of one POI (`from`): every bin there but the vault holds it with
 * `chance`, decided from the raid's seed and the bin rather than the raid's random numbers, so
 * the rest of every bin's loot is the same with tools as without. A tool fills `size` bag
 * slots, and one whose routes are all open sells for `value`.
 */
export const TOOLS: Record<ToolKind, { label: string; size: number; value: number; from: PoiId; chance: number }> = {
  cutter: { label: "ボルトカッター", size: 2, value: 700, from: "yard", chance: 0.1 },
  charge: { label: "発破キット", size: 3, value: 900, from: "quarry", chance: 0.1 },
};
export const TOOL_KINDS = Object.keys(TOOLS) as ToolKind[];

/**
 * Reinforcements: a squad beams in somewhere `dist` metres from the player, out of
 * sight, every `every` seconds after the first `first`, and comes looking for them.
 * Later waves are bigger. The longer a raid lasts, the more is hunting the player. The gap
 * between waves leaves a quiet walk between the fights a wave brings.
 */
export const REINFORCE = {
  first: 180,
  every: 150,
  /** Seconds between fresh guesses of where the player is while a reinforcement squad hunts. */
  huntEvery: 8,
  dist: [55, 110] as const,
  waves: [
    ["grunt", "drone"],
    ["grunt", "drone", "charger"],
    ["grunt", "grunt", "drone", "charger"],
    ["heavy", "grunt", "drone", "drone"],
  ] as EnemyKind[][],
};

/**
 * The raiders: one elite squad that beams in once the raid has gone on a while and hunts
 * the player down, closer on their heels than reinforcements. In a fight one member holds
 * the player's attention while the others go wide to the sides.
 */
export const RAIDERS = {
  at: 480,
  name: "レイダー",
  kinds: ["grunt", "grunt", "grunt"] as EnemyKind[],
  huntEvery: 4,
  /** The elite squad wears plates (see PLATE): a common gun does half its damage to their bodies. */
  plate: 2 as Rarity,
};

/** How much tougher, deadlier and quicker an elite robot (a raider) is than a plain one. */
export const ELITE = {
  hp: 1.5,
  dmg: 1.3,
  cooldown: 0.75,
  turn: 1.2,
  /** Degrees either side of facing it can fire into (`AWARE.fireCone` for plain robots). */
  fireCone: 50,
  /** How far to the side of the player a flanking raider goes. */
  flankDist: 11,
};

/**
 * A squad of two or more that has had the player pinned to one spot for `after` seconds
 * (the spot it last saw them at has moved less than `radius` metres) goes round it: one
 * member keeps facing and shooting at the spot, the others walk to points `dist` metres
 * to either side of it, across the line from that member. Staying put in front of a squad
 * gets the player caught between two; moving or breaking line of sight is the answer.
 */
export const PINCH = { after: 4, radius: 4, dist: 10 };

/**
 * Robot fire: shots are fast enough that a sidestep in the open does not get out of the
 * way at fighting ranges, so the glow before a burst means "get behind something". Each
 * shot aims at the target's chest led by `lead` of its motion over the flight time, and is
 * aimed afresh for every shot of a burst while the robot sees its target. Every shot also
 * strays by a random angle (`spread` degrees, standard deviation), which matters only far
 * off: up close a burst lands, from beyond 30 m a good part of it misses.
 */
export const SHOT = { lead: 0.85, spread: 1.5 };

/**
 * How robots notice the player. Each robot has a view cone; while it sees the
 * player its detection fills (faster up close), and at full the whole squad
 * engages. Crouching shrinks the range and slows the fill.
 */
export const SIGHT: Record<EnemyKind, { range: number; fov: number }> = {
  drone: { range: 26, fov: 150 },
  grunt: { range: 30, fov: 110 },
  charger: { range: 20, fov: 120 },
  heavy: { range: 28, fov: 100 },
  titan: { range: 34, fov: 160 },
};

export const AWARE = {
  /** Within this distance a robot senses the player in any direction. */
  closeSense: 4.5,
  crouchRange: 0.55,
  crouchRate: 0.6,
  /** Seconds to fill detection at point-blank, plus this much more at the edge of sight. */
  fillNear: 0.35,
  fillFar: 1.5,
  /** Detection at which a robot turns to look (the "?" state). */
  suspicious: 0.3,
  decay: 0.25,
  /** An alerted robot searches this long before going back to its post. */
  searchTime: 9,
  /** An engaged squad that has not seen the player this long goes back to searching. */
  loseTime: 8,
  idleSpeed: 0.45, // fraction of combat speed while patrolling or searching
  /**
   * At most this many squads fight at once. Another squad that spots the player
   * keeps searching ("?") until one of them is down, unless the player comes within
   * `joinClose` metres or shoots it. This keeps a POI a series of fights, not a crowd.
   */
  maxSquads: 2,
  joinClose: 5,
  /** A fighting robot looks wider and further than a calm one, but never behind itself. */
  engagedFov: 1.2,
  engagedRange: 1.25,
  /** A squad tracks the player's true position only this long after a member last saw them. */
  trackTime: 0.4,
  /** A robot fires only when the player is within this many degrees of where it faces. */
  fireCone: 40,
  /**
   * A fighting robot that has not located the player (see FLANK.blindTime) finds them in
   * this share of the time a calm one takes to notice them at that distance.
   */
  locate: 0.75,
};

/**
 * Turning speed in radians per second while fighting. A robot cannot snap round,
 * so circling to its side or back while it faces the last known position works.
 */
export const TURN: Record<EnemyKind, number> = {
  drone: 3.6,
  grunt: 3.0,
  charger: 3.8,
  heavy: 1.6,
  titan: 1.2,
};

export type Flank = "front" | "side" | "back" | "ambush" | "none";

/**
 * Damage by where the shot comes from, measured from the way the robot faces. The
 * first hit on a robot that has not noticed the player is an ambush, and so is a hit
 * on a fighting robot that has not located the player itself. The titan
 * takes plain damage from every side.
 */
export const FLANK = {
  frontArc: 55, // degrees either side of facing
  backArc: 115, // beyond this many degrees from facing
  mult: { front: 0.75, side: 1, back: 2.2, ambush: 3, none: 1 } satisfies Record<Flank, number>,
  /**
   * Heavies and raiders brace for the first shot: an ambush on them counts this much
   * instead of `mult.ambush`, so a sniper's opener drops a grunt or a drone outright but
   * only opens a fight with the big ones.
   */
  ambushTough: 1.5,
  /**
   * A fighting robot that has gone this many seconds without seeing the player, or being
   * hit by them, while the player moved away from where it saw them (`moved`), has lost
   * them (and so has one that has not seen them for `AWARE.loseTime`, wherever they are):
   * it must find them again before it fires (`AWARE.locate`), and the player's hits
   * on it until then are an ambush. One hit wakes the whole squad, but the members that
   * never saw the player are still there for the taking, and so is a squad that lost the
   * player behind cover and is shot from somewhere new.
   */
  blindTime: 1.5,
  /** Metres the player must move from where a robot last saw them for it to lose them. */
  moved: 4,
};

/**
 * Armour plates. Some robots wear a plate of tier 1-3 (0 is none). A weapon pierces a
 * plate of tier up to its own rarity; a body hit from a weapon of lower rarity deals
 * `mult[plate - rarity]` of its damage. Weak-point hits always pass in full, and damage
 * that does not come from a weapon (the arc) is never reduced, so a plated robot is
 * an aim check or a reason to bring better gear, never a wall.
 */
export const PLATE = {
  mult: [1, 0.6, 0.5, 0.35] as number[],
};

/**
 * How a fighting robot moves. It strafes across the player's view while it sees them,
 * changes direction every so often, and keeps sidestepping through its wind-up and burst
 * (`windup`, a fraction of its speed: the heavy plants its feet to fire, the charger
 * holds its lane). The first hit after a quiet spell makes it jink the other way, faster,
 * for `jinkTime` s.
 */
export const DODGE = {
  /** Fraction of its speed a robot strafes at between attacks while it sees its target. */
  strafe: 1,
  windup: { drone: 0.7, grunt: 0.6, charger: 0, heavy: 0, titan: 0 } satisfies Record<EnemyKind, number>,
  /** Seconds between chances to change direction, and the chance it does. */
  every: [0.4, 1.1] as const,
  flip: 0.65,
  jinkTime: 0.35,
  jinkSpeed: 1.5,
  /** Seconds without being hit before the next hit makes it jink. */
  jinkQuiet: 1.2,
};

/**
 * Robots react to being shot. Every hit flinches the model (drawn only). Damage landed
 * within a short window adds up, and once it passes `share` of the robot's full health
 * and shield it staggers: it reels back for `time` s, and a wind-up or burst it was in
 * is lost. Weak-point damage counts `weak` times. A shield breaking staggers it briefly
 * too. After a stagger it shrugs hits off for `steady` s, so steady fire is rewarded
 * with one interrupt per robot rather than a robot that never shoots back.
 */
export const STAGGER = {
  /** Seconds over which damage counts toward a stagger (an exponential window). */
  window: 0.7,
  share: { drone: 0.35, grunt: 0.3, charger: 0.3, heavy: 0.22, titan: 99 } satisfies Record<EnemyKind, number>,
  weak: 1.6,
  time: { drone: 0.45, grunt: 0.6, charger: 0.7, heavy: 0.5, titan: 0 } satisfies Record<EnemyKind, number>,
  shieldBreak: 0.3,
  steady: 1.8,
  /** Speed (m/s) it is knocked back from the shot that staggers it. */
  knock: 2.5,
};

/** A grunt left alone below this share of its health and shield falls back to cover and hides longer. */
export const FALLBACK = { below: 0.4, hide: [2.2, 3.2] as const };

/** How far a sound carries, in metres. Robots inside it come to look. */
export const NOISE = {
  pike: 16,
  hornet: 13,
  maul: 15,
  lance: 22,
  talon: 30,
  arc: 10,
  sprintStep: 8,
  slide: 10,
  /** Using a healing item: the click of a cell or the hiss of a syringe. */
  heal: 9,
  /** The ult's launch: everyone round about hears where the player went up. */
  leap: 30,
  /** Squads that roam the roads (and reinforcements) hear gunfire this many times further and come to look. */
  roamMult: 2.5,
  /** Within this fraction of a sound's radius, a robot that can see the spot engages at once. */
  engageInside: 0.35,
};

export const COVER = {
  /** Gap between a cover point and the box face. */
  offset: 0.9,
  spacing: 1.6,
  /** How far sideways a robot steps out of cover to shoot. */
  peek: 1.4,
  search: 14,
  /** Metres between a cover spot's surface and a robot's feet for it to take that cover: its own level only. */
  level: 1.2,
  minFromPlayer: 6,
  maxFromPlayer: 34,
  /** Seconds a robot stays behind cover between shots. */
  hide: [1.4, 2.4] as const,
};

/**
 * The teammate. It walks the player's footsteps a few metres behind, shoots only
 * robots that are already fighting (so it never gives a sneaking player away), and
 * draws some of the fire. It picks the player up once the self-revive is spent;
 * the player picks it up by standing over it and pressing the use key.
 */
export const ALLY = {
  name: "リオ",
  hp: 100,
  shield: 75,
  radius: 0.4,
  walk: 4.6,
  run: 7.0,
  /** It keeps about this far behind the player, measured along the footsteps. */
  follow: 5,
  /** Further than this, or stuck for `stuckTime` s, it moves up to a point just behind the player. */
  catchUp: 38,
  stuckTime: 2.5,
  range: 48,
  dmg: 11,
  interval: 0.11,
  burst: 6,
  pause: [0.6, 1.1] as const,
  /** Chance a shot lands: `hitNear` up close, falling to `hitFar` at `range`. */
  hitNear: 0.8,
  hitFar: 0.3,
  crit: 0.15,
  critMult: 1.5,
  /** Radians per second it turns toward a target. */
  turn: 6,
  /** Share of the ult charge its damage gives the player. */
  ultShare: 0.5,
  regenDelay: 4,
  shieldRegen: 15,
  hpRegen: 8,
  /** Seconds for it to pick the player up, and for the player to pick it up. */
  reviveTime: 4,
  helpTime: 3,
  reviveHp: 60,
  /** A downed teammate stands up on its own after this long, or when the objective is cleared. */
  selfUp: 30,
  /** How long a player out of self-revives waits for the teammate before the wipe. */
  bleedout: 30,
  /** Metres a robot adds to the teammate's distance when choosing whom to shoot: the player is the main target. */
  aggroBias: 1,
  noise: 16,
  /** The rarity its gun counts as against plates (see PLATE): it pierces tier 1 only. */
  rarity: 1 as Rarity,
};

/**
 * Robots that beam in around a called pickup while it is on its way: a wave every `every`
 * seconds, at most `maxAlive` of them up at once. Waiting at a pickup is a fight from cover
 * against a few robots at a time, not a hold against a crowd: with fire that finds anyone
 * in the open, a crowd would decide the raid at its very end.
 */
export const SHIP_WAVES = {
  every: 7,
  first: 3,
  radius: 18,
  maxAlive: 3,
  waves: [["grunt"], ["drone", "grunt"], ["charger"], ["drone"]] as EnemyKind[][],
};

/** Seconds the arc shows every robot within range through walls. */
export const REVEAL = { time: 5, range: 40 };
