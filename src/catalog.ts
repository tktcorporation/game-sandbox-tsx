export const GAME_IDS = ["clash", "factory", "tata"] as const;
export type GameId = (typeof GAME_IDS)[number];

export function isGameId(value: string): value is GameId {
  return (GAME_IDS as readonly string[]).includes(value);
}

export interface GameEntry {
  id: GameId;
  title: string;
  kicker: string;
  tagline: string;
  blurb: string;
  playLabel: string;
  origin?: string;
}

export const GAMES: GameEntry[] = [
  {
    id: "clash",
    title: "Clash of Sandboxes",
    kicker: "Village raid",
    tagline: "Raise a hall. Raid a neighbour.",
    blurb:
      "Build a sunny 16×16 village, collect gold and elixir, train an army, then raid a procedurally generated enemy base.",
    playLabel: "Enter the village",
  },
  {
    id: "factory",
    title: "Tiny Foundry",
    kicker: "Flow factory",
    tagline: "Watch the line come alive.",
    blurb:
      "A visual port of Tiny Factory from cli-sim-game-escape. Lay miners, belts and furnaces, then follow ore as it melts, meshes, and ships.",
    playLabel: "Clock in",
    origin: "cli-sim-game-escape",
  },
  {
    id: "tata",
    title: "モンスターサバイバル",
    kicker: "Felt ranch",
    tagline: "Collect tatas. House them. Dunk zombies.",
    blurb:
      "Over 100 plump tatas hide in the dusk meadow. Feed them through four evolutions, set a three-slot formation against zombie waves, and build a felt garden they actually want to live in.",
    playLabel: "Pick a tata",
  },
];
