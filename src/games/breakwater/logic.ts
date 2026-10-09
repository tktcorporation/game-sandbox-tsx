import { rand, randInt, shuffle, type Seeded } from "../../arcade/rng";

/*
 * 防波堤 — a telegraphed-attack tactics puzzle.
 *
 * Every enemy shows, before the player moves, the direction it will strike.
 * The strike is resolved relative to where the enemy stands *when the tide
 * turns*, so pushing an enemy one tile changes what it hits. The whole round is
 * deterministic and visible: the player's job is to make every arrow land on
 * something harmless.
 */

export type Dir = 0 | 1 | 2 | 3; // N E S W
export const DIRS: readonly Dir[] = [0, 1, 2, 3];
export const DX = [0, 1, 0, -1] as const;
export const DY = [-1, 0, 1, 0] as const;
export const opposite = (d: Dir) => ((d + 2) % 4) as Dir;

export type Terrain = "ground" | "water" | "rock" | "house" | "rubble";
export type AllyKind = "harpoon" | "cannon" | "chain";
export type EnemyKind = "crab" | "spitter" | "brute";

export interface Ally {
  id: number;
  side: "ally";
  kind: AllyKind;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  moved: boolean;
  acted: boolean;
}

export interface Enemy {
  id: number;
  side: "enemy";
  kind: EnemyKind;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  /** Direction of the strike that lands when the tide turns. */
  intent: Dir | null;
}

export type Actor = Ally | Enemy;

export interface Spawn {
  x: number;
  y: number;
  kind: EnemyKind;
}

export interface State extends Seeded {
  w: number;
  h: number;
  tiles: Terrain[];
  actors: Actor[];
  spawns: Spawn[];
  round: number;
  rounds: number;
  island: number;
  power: number;
  maxPower: number;
  kills: number;
  nextId: number;
  phase: "player" | "won" | "lost";
}

export const ALLY_SPEC: Record<AllyKind, { name: string; move: number; hp: number; verb: string; text: string }> = {
  harpoon: { name: "銛", move: 3, hp: 3, verb: "突く", text: "隣の 1 マスに 2 ダメージ。相手を 1 マス押し出す" },
  cannon: { name: "砲", move: 2, hp: 2, verb: "撃つ", text: "直線上で最初に当たったものに 1 ダメージ。撃った向きへ押す" },
  chain: { name: "鎖", move: 4, hp: 2, verb: "引く", text: "直線 4 マス以内の相手を 1 マス手前へ引く。ダメージなし" },
};

export const ENEMY_SPEC: Record<EnemyKind, { name: string; move: number; hp: number; dmg: number; ranged: boolean }> = {
  crab: { name: "ガニ", move: 2, hp: 2, dmg: 1, ranged: false },
  spitter: { name: "ハキ", move: 2, hp: 1, dmg: 1, ranged: true },
  brute: { name: "ゴウラ", move: 1, hp: 3, dmg: 2, ranged: false },
};

// ---------------------------------------------------------------- geometry

export const inBounds = (s: State, x: number, y: number) => x >= 0 && y >= 0 && x < s.w && y < s.h;
export const tileAt = (s: State, x: number, y: number): Terrain => s.tiles[y * s.w + x];
const setTile = (s: State, x: number, y: number, t: Terrain) => (s.tiles[y * s.w + x] = t);
export const actorAt = (s: State, x: number, y: number) => s.actors.find((a) => a.x === x && a.y === y);
const walkable = (t: Terrain) => t === "ground" || t === "rubble";

/** First tile along a line that something would hit; rocks stop the line, water does not. */
export function traceLine(s: State, x: number, y: number, d: Dir, maxLen = 99): { x: number; y: number } | null {
  for (let i = 1; i <= maxLen; i++) {
    const nx = x + DX[d] * i;
    const ny = y + DY[d] * i;
    if (!inBounds(s, nx, ny)) return null;
    const t = tileAt(s, nx, ny);
    if (actorAt(s, nx, ny) || t === "house" || t === "rock") return { x: nx, y: ny };
  }
  return null;
}

/** Tiles reachable within `range` steps. Units may pass through their own side but not stop on it. */
export function reachable(s: State, a: Actor, range: number): { x: number; y: number }[] {
  const seen = new Map<string, number>([[`${a.x},${a.y}`, 0]]);
  const queue: [number, number, number][] = [[a.x, a.y, 0]];
  const out: { x: number; y: number }[] = [];
  while (queue.length) {
    const [x, y, dist] = queue.shift()!;
    if (dist === range) continue;
    for (const d of DIRS) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      const key = `${nx},${ny}`;
      if (!inBounds(s, nx, ny) || seen.has(key) || !walkable(tileAt(s, nx, ny))) continue;
      const occ = actorAt(s, nx, ny);
      if (occ && occ.side !== a.side) continue;
      seen.set(key, dist + 1);
      queue.push([nx, ny, dist + 1]);
      if (!occ) out.push({ x: nx, y: ny });
    }
  }
  return out;
}

// ------------------------------------------------------------------ damage

export type Fx = { kind: "hit" | "push" | "drown" | "house" | "spawn" | "block"; x: number; y: number; n?: number };

function hurt(s: State, x: number, y: number, n: number, fx: Fx[]) {
  const a = actorAt(s, x, y);
  if (a) {
    a.hp -= n;
    fx.push({ kind: "hit", x, y, n });
    if (a.hp <= 0) {
      s.actors = s.actors.filter((o) => o !== a);
      if (a.side === "enemy") s.kills++;
    }
    return;
  }
  if (tileAt(s, x, y) === "house") {
    setTile(s, x, y, "rubble");
    s.power--;
    fx.push({ kind: "house", x, y });
  }
}

/** Push whatever stands at (x,y) one tile. Blocked pushes bump: 1 damage to the pushed and to what it hit. */
function push(s: State, x: number, y: number, d: Dir, fx: Fx[]) {
  const a = actorAt(s, x, y);
  if (!a) return;
  const nx = x + DX[d];
  const ny = y + DY[d];
  if (!inBounds(s, nx, ny)) return;
  const t = tileAt(s, nx, ny);
  const blocker = actorAt(s, nx, ny);
  if (t === "water" && !blocker) {
    if (a.side === "enemy") {
      s.actors = s.actors.filter((o) => o !== a);
      s.kills++;
      fx.push({ kind: "drown", x: nx, y: ny });
    } else {
      hurt(s, x, y, 1, fx);
      fx.push({ kind: "block", x: nx, y: ny });
    }
    return;
  }
  if (blocker || t === "rock" || t === "house") {
    fx.push({ kind: "block", x: nx, y: ny });
    hurt(s, x, y, 1, fx);
    hurt(s, nx, ny, 1, fx);
    return;
  }
  a.x = nx;
  a.y = ny;
  fx.push({ kind: "push", x: nx, y: ny });
}

// ----------------------------------------------------------------- allies

export function moveAlly(s: State, id: number, x: number, y: number): State {
  const n = structuredClone(s);
  const a = n.actors.find((o) => o.id === id);
  if (!a || a.side !== "ally" || a.moved || a.acted) return s;
  if (!reachable(n, a, ALLY_SPEC[a.kind].move).some((p) => p.x === x && p.y === y)) return s;
  a.x = x;
  a.y = y;
  a.moved = true;
  return n;
}

/** The tile an ally's action in direction `d` would affect, or null if it hits nothing. */
export function actionTarget(s: State, a: Ally, d: Dir): { x: number; y: number } | null {
  if (a.kind === "harpoon") {
    const x = a.x + DX[d];
    const y = a.y + DY[d];
    return inBounds(s, x, y) ? { x, y } : null;
  }
  if (a.kind === "cannon") return traceLine(s, a.x, a.y, d);
  const hit = traceLine(s, a.x, a.y, d, 4);
  return hit && actorAt(s, hit.x, hit.y) ? hit : null;
}

export function act(s: State, id: number, d: Dir): { state: State; fx: Fx[] } {
  const n = structuredClone(s);
  const fx: Fx[] = [];
  const a = n.actors.find((o) => o.id === id);
  if (!a || a.side !== "ally" || a.acted) return { state: s, fx };
  const target = actionTarget(n, a, d);
  a.acted = true;
  a.moved = true;
  if (target) {
    if (a.kind === "harpoon") {
      hurt(n, target.x, target.y, 2, fx);
      push(n, target.x, target.y, d, fx);
    } else if (a.kind === "cannon") {
      hurt(n, target.x, target.y, 1, fx);
      push(n, target.x, target.y, d, fx);
    } else {
      push(n, target.x, target.y, opposite(d), fx);
    }
  }
  checkEnd(n);
  return { state: n, fx };
}

export function rest(s: State, id: number): State {
  const n = structuredClone(s);
  const a = n.actors.find((o) => o.id === id);
  if (a && a.side === "ally") {
    a.moved = true;
    a.acted = true;
  }
  return n;
}

// ---------------------------------------------------------------- enemies

/** Where an enemy's strike lands right now (it follows the enemy if pushed). */
export function strikeTarget(s: State, e: Enemy): { x: number; y: number } | null {
  if (e.intent === null) return null;
  if (ENEMY_SPEC[e.kind].ranged) return traceLine(s, e.x, e.y, e.intent);
  const x = e.x + DX[e.intent];
  const y = e.y + DY[e.intent];
  return inBounds(s, x, y) ? { x, y } : null;
}

function targetValue(s: State, x: number, y: number, self: Enemy, claimed: Set<string>): number {
  const occ = actorAt(s, x, y);
  let v = 0;
  if (occ && occ !== self) v = occ.side === "ally" ? 7 + (occ.hp <= ENEMY_SPEC[self.kind].dmg ? 2 : 0) : -6;
  else if (tileAt(s, x, y) === "house") v = 10;
  if (v > 0 && claimed.has(`${x},${y}`)) v -= 6;
  return v;
}

function houseDistance(s: State, x: number, y: number): number {
  let best = 99;
  for (let yy = 0; yy < s.h; yy++)
    for (let xx = 0; xx < s.w; xx++)
      if (tileAt(s, xx, yy) === "house") best = Math.min(best, Math.abs(xx - x) + Math.abs(yy - y));
  return best;
}

/** Every enemy picks a tile and a strike direction, one after another, so later enemies see earlier choices. */
function plan(s: State) {
  const claimed = new Set<string>();
  for (const e of s.actors) {
    if (e.side !== "enemy") continue;
    const spec = ENEMY_SPEC[e.kind];
    const options = [{ x: e.x, y: e.y }, ...reachable(s, e, spec.move)];
    let best = { x: e.x, y: e.y, d: 0 as Dir, v: -Infinity };
    const ox = e.x;
    const oy = e.y;
    for (const o of options) {
      e.x = o.x;
      e.y = o.y;
      for (const d of DIRS) {
        e.intent = d;
        const t = strikeTarget(s, e);
        let v = t ? targetValue(s, t.x, t.y, e, claimed) : -1;
        v -= houseDistance(s, o.x, o.y) * 0.3;
        v += rand(s) * 0.4;
        if (v > best.v) best = { x: o.x, y: o.y, d, v };
      }
    }
    e.x = ox;
    e.y = oy;
    e.x = best.x;
    e.y = best.y;
    e.intent = best.d;
    const t = strikeTarget(s, e);
    if (t) claimed.add(`${t.x},${t.y}`);
  }
}

/** Island difficulty lives here and in rollKind; tuned against scripts/sim/breakwater.ts. */
function spawnCount(s: State): number {
  if (s.round >= s.rounds) return 0;
  const late = s.round >= 3 ? 1 : 0;
  return 1 + (s.round >= 2 ? 1 : 0) + (s.island >= 2 ? late : 0) + (s.island >= 4 && s.round % 2 === 0 ? 1 : 0) + (s.island >= 6 ? late : 0);
}

/** Later islands breed tougher enemies, so pushing them aside beats trying to kill everything. */
export function enemyHp(island: number, kind: EnemyKind): number {
  return ENEMY_SPEC[kind].hp + Math.floor((island - 1) / 3);
}

function rollKind(s: State): EnemyKind {
  const r = rand(s);
  const bruteChance = s.island >= 2 || s.round >= 3 ? Math.min(0.12 + s.island * 0.03, 0.3) : 0;
  if (r < bruteChance) return "brute";
  return r < bruteChance + 0.32 ? "spitter" : "crab";
}

function announceSpawns(s: State) {
  const open: { x: number; y: number }[] = [];
  for (let y = 0; y < 3; y++)
    for (let x = 0; x < s.w; x++) if (walkable(tileAt(s, x, y)) && !actorAt(s, x, y)) open.push({ x, y });
  shuffle(s, open);
  s.spawns = open.slice(0, spawnCount(s)).map((p) => ({ ...p, kind: rollKind(s) }));
}

function checkEnd(s: State) {
  if (s.power <= 0 || !s.actors.some((a) => a.side === "ally")) s.phase = "lost";
}

/**
 * The tide turns: strikes land in order, then announced spawns surface.
 * Returns each intermediate state so the view can play them back one by one.
 */
export function endTurn(s0: State): { state: State; fx: Fx[] }[] {
  const steps: { state: State; fx: Fx[] }[] = [];
  let s = structuredClone(s0);
  const order = s.actors.filter((a): a is Enemy => a.side === "enemy").map((e) => e.id);
  for (const id of order) {
    const e = s.actors.find((a) => a.id === id);
    if (!e || e.side !== "enemy" || e.intent === null) continue;
    const t = strikeTarget(s, e);
    const fx: Fx[] = [];
    if (t) hurt(s, t.x, t.y, ENEMY_SPEC[e.kind].dmg, fx);
    e.intent = null;
    checkEnd(s);
    steps.push({ state: s, fx });
    s = structuredClone(s);
    if (s.phase === "lost") return steps;
  }

  const fx: Fx[] = [];
  for (const sp of s.spawns) {
    if (actorAt(s, sp.x, sp.y)) {
      hurt(s, sp.x, sp.y, 1, fx);
      fx.push({ kind: "block", x: sp.x, y: sp.y });
      continue;
    }
    s.actors.push({ id: s.nextId++, side: "enemy", kind: sp.kind, x: sp.x, y: sp.y, hp: enemyHp(s.island, sp.kind), maxHp: enemyHp(s.island, sp.kind), intent: null });
    fx.push({ kind: "spawn", x: sp.x, y: sp.y });
  }
  s.spawns = [];
  checkEnd(s);
  if (s.phase === "lost") {
    steps.push({ state: s, fx });
    return steps;
  }

  s.round++;
  if (s.round > s.rounds) {
    s.round = s.rounds;
    s.phase = "won";
    s.actors = s.actors.filter((a) => a.side === "ally");
  } else {
    for (const a of s.actors) if (a.side === "ally") a.moved = a.acted = false;
    plan(s);
    announceSpawns(s);
  }
  steps.push({ state: s, fx });
  return steps;
}

// --------------------------------------------------------------- creation

/**
 * Island 0 is the lesson: one harpoon, one crab, two houses, one tide. The
 * only way to save the house is to push the crab so its arrow points at water.
 */
function practiceIsland(): State {
  const W = "water" as const;
  const G = "ground" as const;
  const H = "house" as const;
  const tiles: Terrain[] = [
    W, W, G, W, W,
    G, H, G, G, G,
    G, G, G, G, G,
    G, G, G, G, G,
    G, G, G, H, G,
  ];
  return {
    rng: 7,
    w: 5,
    h: 5,
    tiles,
    actors: [
      { id: 1, side: "ally", kind: "harpoon", x: 2, y: 3, hp: 3, maxHp: 3, moved: false, acted: false },
      { id: 2, side: "enemy", kind: "crab", x: 2, y: 1, hp: 3, maxHp: 3, intent: 3 },
    ],
    spawns: [],
    round: 1,
    rounds: 1,
    island: 0,
    power: 2,
    maxPower: 2,
    kills: 0,
    nextId: 3,
    phase: "player",
  };
}

export function newIsland(island: number, seed: number): State {
  if (island === 0) return practiceIsland();
  const w = 7;
  const h = 8;
  const s: State = {
    rng: (seed ^ Math.imul(island, 0x9e3779b1)) >>> 0,
    w,
    h,
    tiles: [],
    actors: [],
    spawns: [],
    round: 1,
    rounds: 5,
    island,
    power: 0,
    maxPower: 0,
    kills: 0,
    nextId: 1,
    phase: "player",
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let t: Terrain = "ground";
      if (y === 0) t = rand(s) < 0.75 ? "water" : "ground";
      else if (y === 1) t = rand(s) < 0.3 ? "water" : "ground";
      s.tiles.push(t);
    }
  // Houses sit in the back half, never touching each other in a full row.
  const houseSlots: { x: number; y: number }[] = [];
  for (let y = 4; y < h; y++) for (let x = 0; x < w; x++) houseSlots.push({ x, y });
  shuffle(s, houseSlots);
  const houses = 6;
  for (const p of houseSlots.slice(0, houses)) setTile(s, p.x, p.y, "house");
  s.power = s.maxPower = houses;

  let rocks = 3 + randInt(s, 2);
  while (rocks > 0) {
    const x = randInt(s, w);
    const y = 2 + randInt(s, h - 2);
    if (tileAt(s, x, y) === "ground") {
      setTile(s, x, y, "rock");
      rocks--;
    }
  }

  const free = (y0: number, y1: number) => {
    const out: { x: number; y: number }[] = [];
    for (let y = y0; y <= y1; y++)
      for (let x = 0; x < w; x++) if (tileAt(s, x, y) === "ground" && !actorAt(s, x, y)) out.push({ x, y });
    return shuffle(s, out);
  };
  const kinds: AllyKind[] = ["harpoon", "cannon", "chain"];
  const allySpots = free(3, 6);
  kinds.forEach((kind, i) => {
    const p = allySpots[i];
    const hp = ALLY_SPEC[kind].hp;
    s.actors.push({ id: s.nextId++, side: "ally", kind, x: p.x, y: p.y, hp, maxHp: hp, moved: false, acted: false });
  });
  const startEnemies = 2 + (island >= 4 ? 1 : 0);
  const enemySpots = free(1, 2);
  for (let i = 0; i < startEnemies; i++) {
    const p = enemySpots[i];
    const kind: EnemyKind = i === 0 ? "crab" : rollKind(s);
    const hp = enemyHp(island, kind);
    s.actors.push({ id: s.nextId++, side: "enemy", kind, x: p.x, y: p.y, hp, maxHp: hp, intent: null });
  }
  plan(s);
  announceSpawns(s);
  return s;
}

export function stars(s: State): number {
  if (s.phase !== "won") return 0;
  if (s.power >= s.maxPower - 1) return 3;
  if (s.power * 2 >= s.maxPower) return 2;
  return 1;
}
