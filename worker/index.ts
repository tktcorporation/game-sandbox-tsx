/// <reference types="@cloudflare/workers-types" />

interface Env {
  ASSETS: Fetcher;
}

// Mirror of src/game/buildings.ts grid constants (coupled over the wire — keep
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

/** Base layout: the town hall and storages form a walled core at the far end;
 *  defenses ring the core; resource buildings sprawl outside where raiders can
 *  snack on them. Same seed -> same base. */
function generateBase(seed: number, playerTh: number): EnemyBase {
  const rand = rng(seed);
  const thLevel = Math.max(1, Math.min(6, playerTh + (rand() < 0.4 ? 1 : 0) - (rand() < 0.2 ? 1 : 0)));
  const buildings: EnemyBuilding[] = [];

  const overlaps = (x: number, y: number, size: number) =>
    buildings.some((b) => x < b.x + b.size && x + size > b.x && y < b.y + b.size && y + size > b.y);

  const tryPlaceIn = (
    size: number,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    tries = 50,
  ): { x: number; y: number } | null => {
    const lox = Math.max(0, x0);
    const loy = Math.max(0, y0);
    const hix = Math.min(GRID_W, x1);
    const hiy = Math.min(MAX_ENEMY_ROW, y1);
    if (hix - lox < size || hiy - loy < size) return null;
    for (let i = 0; i < tries; i++) {
      const x = lox + Math.floor(rand() * (hix - lox - size + 1));
      const y = loy + Math.floor(rand() * (hiy - loy - size + 1));
      if (!overlaps(x, y, size)) return { x, y };
    }
    return null;
  };

  const add = (type: string, size: number, level: number, region?: [number, number, number, number]) => {
    const cell = region
      ? (tryPlaceIn(size, ...region) ?? tryPlaceIn(size, 0, 0, GRID_W, MAX_ENEMY_ROW))
      : tryPlaceIn(size, 0, 0, GRID_W, MAX_ENEMY_ROW);
    if (cell) buildings.push({ type, level, x: cell.x, y: cell.y, size });
  };

  const defLevel = () => 1 + Math.floor(rand() * thLevel);

  // --- walled core at the far (top) end: town hall + storages + one tower ---
  const thX = Math.floor((GRID_W - 3) / 2);
  const thY = 1;
  buildings.push({ type: "townhall", level: thLevel, x: thX, y: thY, size: 3 });

  const core: [number, number, number, number] = [thX - 2, thY, thX + 5, thY + 5];
  const storages = Math.floor(rand() * 2) + 1;
  for (let i = 0; i < storages; i++) add("goldstorage", 2, defLevel(), core);
  for (let i = 0; i < storages; i++) add("elixirstorage", 2, defLevel(), core);
  if (thLevel >= 2) add("archertower", 2, defLevel(), core);
  else add("cannon", 2, defLevel(), core);

  // wall ring: bounding box of everything placed so far, expanded by one tile
  let bx0 = GRID_W, by0 = GRID_H, bx1 = 0, by1 = 0;
  for (const b of buildings) {
    bx0 = Math.min(bx0, b.x);
    by0 = Math.min(by0, b.y);
    bx1 = Math.max(bx1, b.x + b.size);
    by1 = Math.max(by1, b.y + b.size);
  }
  const ring: { x: number; y: number }[] = [];
  for (let x = bx0 - 1; x <= bx1; x++) {
    ring.push({ x, y: by0 - 1 });
    ring.push({ x, y: by1 });
  }
  for (let y = by0; y < by1; y++) {
    ring.push({ x: bx0 - 1, y });
    ring.push({ x: bx1, y });
  }
  // lower town halls can't afford the full ring — leave a random gap
  let wallBudget = Math.min(ring.length, thLevel * 6 + 4 + Math.floor(rand() * 6));
  const start = Math.floor(rand() * ring.length);
  const wallLevel = Math.max(1, Math.min(6, thLevel));
  for (let i = 0; i < ring.length && wallBudget > 0; i++) {
    const c = ring[(start + i) % ring.length];
    if (c.x < 0 || c.y < 0 || c.x >= GRID_W || c.y >= MAX_ENEMY_ROW) continue;
    if (overlaps(c.x, c.y, 1)) continue;
    buildings.push({ type: "wall", level: wallLevel, x: c.x, y: c.y, size: 1 });
    wallBudget--;
  }

  // --- outer defenses guarding the approach ---
  const outer: [number, number, number, number] = [bx0 - 4, by0, bx1 + 4, by1 + 4];
  const cannons = 1 + Math.floor(rand() * (thLevel + 1));
  const archers = Math.max(0, Math.floor(rand() * thLevel) - (thLevel >= 2 ? 1 : 0));
  for (let i = 0; i < cannons; i++) add("cannon", 2, defLevel(), outer);
  for (let i = 0; i < archers; i++) add("archertower", 2, defLevel(), outer);

  // --- resource sprawl outside the walls ---
  const mines = 1 + Math.floor(rand() * thLevel);
  const collectors = 1 + Math.floor(rand() * thLevel);
  for (let i = 0; i < mines; i++) add("goldmine", 2, defLevel());
  for (let i = 0; i < collectors; i++) add("elixircollector", 2, defLevel());
  add("barracks", 2, defLevel());
  add("armycamp", 2, defLevel());

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
