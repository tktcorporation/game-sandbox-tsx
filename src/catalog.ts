export const GAME_IDS = ["clash", "factory"] as const;
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
    playLabel: "Light the furnace",
    origin: "cli-sim-game-escape",
  },
];
