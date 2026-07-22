import type { Element, SpeciesDef, SpeciesId } from "./types";

/** Base combat stats scale with tier depth; `boost` flags the rarer, light-leaning branch. */
function stats(tier: number, boost = false) {
  const mult = boost ? 1.25 : 1;
  return {
    hp: Math.round(14 * Math.pow(2.5, tier) * mult),
    atk: Math.round(4 * Math.pow(2.3, tier) * mult),
    def: Math.round(3 * Math.pow(2.2, tier) * mult),
  };
}

// Pacing curves indexed by tier (0 = starter .. 3 = final form).
// GROWTH_RATE is a continuous-compounding per-second rate; doubling times work out to
// roughly 15min / 25min / 40min / 70min per tier, so a fresh save reaches its first
// evolution in about an hour and a full tier-0-to-tier-3 line takes a few hours —
// paced for a casual idle game, not something that clears in minutes.
const EVOLVE_THRESHOLD = [20, 30, 50, Infinity];
const MATURITY_SECONDS = [180, 300, 600, Infinity];
// Cap always sits comfortably above that tier's own evolve threshold so a colony can
// actually reach it at nestLevel 0 — nest upgrades add headroom, they aren't required.
const BASE_CAP = [50, 55, 70, 40];
const GROWTH_RATE = [0.00077, 0.00046, 0.00029, 0.00017];
const EVOLVE_BATCH = [10, 15, 20, 0];

function def(
  id: SpeciesId,
  name: string,
  emoji: string,
  element: Element,
  tier: number,
  evolvesTo: { target: SpeciesId; weight: number }[],
  boost = false,
): SpeciesDef {
  return {
    id,
    name,
    emoji,
    element,
    tier,
    baseStats: stats(tier, boost),
    evolveThreshold: EVOLVE_THRESHOLD[tier],
    maturitySeconds: MATURITY_SECONDS[tier],
    // 0.7 here used to round below EVOLVE_THRESHOLD[2] (70*0.7 = 49 < 50) for boosted tier-2
    // species, stranding them just short of their own evolution threshold at nestLevel 0.
    baseCap: BASE_CAP[tier] * (boost ? 0.85 : 1),
    growthRate: GROWTH_RATE[tier] * (boost ? 0.8 : 1),
    evolveBatch: EVOLVE_BATCH[tier],
    evolvesTo,
  };
}

export const SPECIES: Record<SpeciesId, SpeciesDef> = {
  slime: def("slime", "スライム", "🟢", "neutral", 0, [
    { target: "aqua_slime", weight: 40 },
    { target: "ember_slime", weight: 40 },
    { target: "rock_slime", weight: 15 },
    { target: "prism_slime", weight: 5 },
  ]),

  aqua_slime: def("aqua_slime", "ミズスライム", "🔵", "water", 1, [
    { target: "aqua_newt", weight: 55 },
    { target: "tide_serpent", weight: 30 },
    { target: "moon_jelly", weight: 15 },
  ]),
  ember_slime: def("ember_slime", "ホムラスライム", "🔴", "fire", 1, [
    { target: "cinder_pup", weight: 55 },
    { target: "salamander", weight: 30 },
    { target: "sun_hatchling", weight: 15 },
  ]),
  rock_slime: def("rock_slime", "ツチスライム", "🟤", "earth", 1, [
    { target: "pebble_golem", weight: 55 },
    { target: "mossback", weight: 30 },
    { target: "gleam_stone", weight: 15 },
  ]),
  prism_slime: def(
    "prism_slime",
    "キラリスライム",
    "✨",
    "light",
    1,
    [
      { target: "prism_fox", weight: 70 },
      { target: "starlit_owl", weight: 30 },
    ],
    true,
  ),

  aqua_newt: def("aqua_newt", "ミズトカゲ", "🦎", "water", 2, [{ target: "leviathan_spawn", weight: 100 }]),
  tide_serpent: def("tide_serpent", "シオリュウ", "🐍", "water", 2, [{ target: "abyss_serpent", weight: 100 }]),
  moon_jelly: def("moon_jelly", "ツキクラゲ", "🪼", "light", 2, [{ target: "lunar_jelly", weight: 100 }], true),
  cinder_pup: def("cinder_pup", "ヒノコ", "🐶", "fire", 2, [{ target: "ember_wolf", weight: 100 }]),
  salamander: def("salamander", "イモリオン", "🦎", "fire", 2, [{ target: "inferno_drake", weight: 100 }]),
  sun_hatchling: def("sun_hatchling", "ヒナタマゴ", "🐣", "light", 2, [{ target: "solar_phoenix", weight: 100 }], true),
  pebble_golem: def("pebble_golem", "コイシゴーレム", "🪨", "earth", 2, [{ target: "iron_golem", weight: 100 }]),
  mossback: def("mossback", "コケガメ", "🐢", "earth", 2, [{ target: "ancient_tortoise", weight: 100 }]),
  gleam_stone: def("gleam_stone", "ヒカリイシ", "💎", "light", 2, [{ target: "crystal_titan", weight: 100 }], true),
  prism_fox: def("prism_fox", "プリズムギツネ", "🦊", "light", 2, [{ target: "celestial_fox", weight: 100 }], true),
  starlit_owl: def("starlit_owl", "ホシフクロウ", "🦉", "light", 2, [{ target: "astral_owl", weight: 100 }], true),

  leviathan_spawn: def("leviathan_spawn", "リヴァイアサンの子", "🐳", "water", 3, []),
  abyss_serpent: def("abyss_serpent", "深淵の大蛇", "🌊", "water", 3, []),
  lunar_jelly: def("lunar_jelly", "月影クラゲ", "🌙", "light", 3, [], true),
  ember_wolf: def("ember_wolf", "焔狼", "🔥", "fire", 3, []),
  inferno_drake: def("inferno_drake", "業火竜", "🐉", "fire", 3, []),
  solar_phoenix: def("solar_phoenix", "太陽の不死鳥", "☀️", "light", 3, [], true),
  iron_golem: def("iron_golem", "鋼鉄巨像", "🗿", "earth", 3, []),
  ancient_tortoise: def("ancient_tortoise", "古代の大亀", "🐢", "earth", 3, []),
  crystal_titan: def("crystal_titan", "水晶の巨神", "💠", "light", 3, [], true),
  celestial_fox: def("celestial_fox", "天狐", "🦊", "light", 3, [], true),
  astral_owl: def("astral_owl", "星詠みの梟", "🌟", "light", 3, [], true),
};

export const SPECIES_LIST = Object.values(SPECIES);

export const STARTER_SPECIES: SpeciesId = "slime";

/** Simple triangle: fire > earth > water > fire. Neutral/light sit outside the triangle. */
export function typeMultiplier(attacker: Element, defender: Element): number {
  if (attacker === defender) return 1;
  const beats: Partial<Record<Element, Element>> = { fire: "earth", earth: "water", water: "fire" };
  if (beats[attacker] === defender) return 1.25;
  if (beats[defender] === attacker) return 0.8;
  if (attacker === "light") return 1.1;
  return 1;
}

export function capOf(speciesId: SpeciesId, nestLevel: number): number {
  const s = SPECIES[speciesId];
  return Math.round(s.baseCap * (1 + nestLevel * 0.5));
}

/** Small, capped bonus for owning a large colony — rewards accumulation without dwarfing tier progression. */
export function swarmBonus(count: number): number {
  return Math.min(0.5, count / 150);
}

export function nestUpgradeCost(nestLevel: number): number {
  return Math.round(50 * Math.pow(1.6, nestLevel));
}
