export type Element = "neutral" | "water" | "fire" | "earth" | "light";

export type SpeciesId =
  | "slime"
  | "aqua_slime"
  | "ember_slime"
  | "rock_slime"
  | "prism_slime"
  | "aqua_newt"
  | "tide_serpent"
  | "moon_jelly"
  | "cinder_pup"
  | "salamander"
  | "sun_hatchling"
  | "pebble_golem"
  | "mossback"
  | "gleam_stone"
  | "prism_fox"
  | "starlit_owl"
  | "leviathan_spawn"
  | "abyss_serpent"
  | "lunar_jelly"
  | "ember_wolf"
  | "inferno_drake"
  | "solar_phoenix"
  | "iron_golem"
  | "ancient_tortoise"
  | "crystal_titan"
  | "celestial_fox"
  | "astral_owl";

export interface SpeciesEvolutionOption {
  target: SpeciesId;
  weight: number;
}

export interface SpeciesDef {
  id: SpeciesId;
  name: string;
  emoji: string;
  element: Element;
  /** 0 = starter, higher = deeper into the evolution tree (rarer, stronger) */
  tier: number;
  /** base combat stats before swarm bonus */
  baseStats: { hp: number; atk: number; def: number };
  /** population needed (once mature) before an evolution roll can trigger */
  evolveThreshold: number;
  /** seconds for a fresh individual to reach maturity (eligible to evolve) */
  maturitySeconds: number;
  /** population cap before the nest-level multiplier */
  baseCap: number;
  /** population growth rate per second (continuous compounding) */
  growthRate: number;
  /** how many individuals convert away when an evolution roll fires */
  evolveBatch: number;
  /** weighted possible next species; empty = final form */
  evolvesTo: SpeciesEvolutionOption[];
}

/** One population bucket: all individuals of a species currently in a player's nest. */
export interface Colony {
  speciesId: SpeciesId;
  count: number;
  /** 0..1, individuals below 1 are not yet eligible to trigger an evolution roll */
  growth: number;
  /** epoch ms of last accrual computation */
  updatedAt: number;
}

export interface EvolutionEvent {
  from: SpeciesId;
  to: SpeciesId;
  amount: number;
  at: number;
}

export interface SquadMonster {
  speciesId: SpeciesId;
  hp: number;
  atk: number;
  def: number;
  element: Element;
}

export interface Opponent {
  id: string;
  name: string;
  rating: number;
  monsters: SquadMonster[];
  /** Server-issued single-use match ticket — required to submit /api/battle/result. */
  matchId: string;
  /** Server-chosen combat rng seed for this match; the client can't pick its own. */
  battleSeed: number;
  /** The caller's own squad snapshot this ticket is pinned against — use this, not live
   * colonies, so the local instant simulation always matches the server's replay. */
  mySquad: SquadMonster[];
}

export interface BattleLogEntry {
  text: string;
  side: "mine" | "theirs" | "system";
}

export interface BattleResult {
  won: boolean;
  log: BattleLogEntry[];
  myRemainingHp: number;
  theirRemainingHp: number;
  reward: number;
}

export interface LeaderboardEntry {
  id: string;
  name: string;
  rating: number;
  power: number;
}

export interface GameState {
  playerId: string | null;
  playerToken: string | null;
  playerName: string;
  rating: number;

  colonies: Colony[];
  /** discovered species, in order of first discovery */
  dex: SpeciesId[];

  shineStones: number;
  nestLevel: number;

  /** up to 5 species chosen to represent the player in battle */
  squad: SpeciesId[];

  lastTick: number;
}
