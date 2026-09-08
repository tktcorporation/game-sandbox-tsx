/// <reference types="@cloudflare/workers-types" />

interface Env {
  ASSETS: Fetcher;
}

// Mirror of src/games/clash/game/buildings.ts grid constants (coupled over the wire — keep
// in sync). Portrait field filling the screen: GRID_W columns, GRID_H rows.
const GRID_W = 10;
const GRID_H = 18;
const DEPLOY_DEPTH = 5;
// Enemy buildings stay in the far rows so the near rows remain a clear landing
// beach for the attacker.
const MAX_ENEMY_ROW = GRID_H - DEPLOY_DEPTH;

type EnemyBuilding = {
  type: string;
  level: number;
  x: number;
  y: number;
  size: number;
};

interface EnemyBase {
  name: string;
  thLevel: number;
  buildings: EnemyBuilding[];
  loot: { gold: number; elixir: number };
  trophyReward: number;
  seed: number;
}

// Lightweight seeded RNG (mulberry32) so a given seed reproduces the same base.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = [
  "Goblin Outpost", "Rival Hold", "Barbarian Camp", "Iron Keep", "Ash Village",
  "Stone Bastion", "Wolf Den", "Frost March", "Sand Fort", "Ember Reach",
];

function tryPlace(
  buildings: EnemyBuilding[],
  size: number,
  rand: () => number,
): { x: number; y: number } | null {
  for (let attempt = 0; attempt < 60; attempt++) {
    const x = Math.floor(rand() * (GRID_W - size + 1));
    const y = Math.floor(rand() * (MAX_ENEMY_ROW - size + 1));
    // keep the front beach clear: the building must stay in the far rows.
    if (y + size > MAX_ENEMY_ROW) continue;
    const overlap = buildings.some((b) => {
      return x < b.x + b.size && x + size > b.x && y < b.y + b.size && y + size > b.y;
    });
    if (!overlap) return { x, y };
  }
  return null;
}

function generateBase(seed: number, playerTh: number): EnemyBase {
  const rand = rng(seed);
  const thLevel = Math.max(1, Math.min(6, playerTh + (rand() < 0.4 ? 1 : 0) - (rand() < 0.2 ? 1 : 0)));
  const buildings: EnemyBuilding[] = [];

  const add = (type: string, size: number, level: number) => {
    const cell = tryPlace(buildings, size, rand);
    if (cell) buildings.push({ type, level, x: cell.x, y: cell.y, size });
  };

  // Town hall sits at the far (top) end, horizontally centred — the prize the
  // attacker pushes toward from the near front.
  const thLvl = thLevel;
  buildings.push({
    type: "townhall",
    level: thLvl,
    x: Math.floor(GRID_W / 2) - 1,
    y: 1,
    size: 3,
  });

  const defLevel = () => 1 + Math.floor(rand() * thLevel);
  const cannons = 1 + Math.floor(rand() * (thLevel + 1));
  const archers = Math.floor(rand() * thLevel);
  const mines = 1 + Math.floor(rand() * thLevel);
  const collectors = 1 + Math.floor(rand() * thLevel);
  const storages = Math.floor(rand() * 2) + 1;
  const walls = thLevel * 3 + Math.floor(rand() * 5);

  for (let i = 0; i < cannons; i++) add("cannon", 2, defLevel());
  for (let i = 0; i < archers; i++) add("archertower", 2, defLevel());
  for (let i = 0; i < mines; i++) add("goldmine", 2, defLevel());
  for (let i = 0; i < collectors; i++) add("elixircollector", 2, defLevel());
  for (let i = 0; i < storages; i++) add("goldstorage", 2, defLevel());
  for (let i = 0; i < storages; i++) add("elixirstorage", 2, defLevel());
  add("barracks", 2, defLevel());
  add("armycamp", 2, defLevel());
  for (let i = 0; i < walls; i++) add("wall", 1, Math.min(thLevel, 4));

  const lootBase = 800 * thLevel;
  const loot = {
    gold: Math.round(lootBase * (0.7 + rand() * 0.9)),
    elixir: Math.round(lootBase * (0.7 + rand() * 0.9)),
  };
  const trophyReward = 12 + thLevel * 4 + Math.floor(rand() * 12);

  return {
    name: NAMES[seed % NAMES.length],
    thLevel,
    buildings,
    loot,
    trophyReward,
    seed,
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, time: Date.now() });
    }

    if (url.pathname === "/api/raid") {
      const th = Math.max(1, Math.min(6, Number(url.searchParams.get("th") ?? "1")));
      const seed = Number(url.searchParams.get("seed")) || Math.floor(Math.random() * 1e9);
      const base = generateBase(seed, th);
      return Response.json(base, {
        headers: { "cache-control": "no-store" },
      });
    }

    // Everything else: serve the built SPA (with SPA fallback configured in wrangler).
    return env.ASSETS.fetch(request);
  },
};
