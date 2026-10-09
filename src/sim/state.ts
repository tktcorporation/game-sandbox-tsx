import { ENEMY, PLAYER, WORLD, GUN, type EnemyKind } from "./config";

export interface Vec {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Player {
  pos: Vec;
  vel: Vec;
  aim: number;
  hp: number;
  invuln: number;
  dashTime: number;
  dashCooldown: number;
  dashDir: Vec;
  mag: number;
  reload: number;
  fireCooldown: number;
}

export type EnemyMode = "spawning" | "moving" | "telegraph" | "attacking" | "recover";

export interface Enemy {
  id: number;
  kind: EnemyKind;
  pos: Vec;
  vel: Vec;
  hp: number;
  facing: number;
  mode: EnemyMode;
  timer: number;
  /** Where a rusher committed to charge, fixed at the start of its telegraph. */
  aimLock: number;
}

export interface Bullet {
  id: number;
  from: "player" | "enemy";
  pos: Vec;
  vel: Vec;
  radius: number;
  life: number;
  /** Enemy id this shot was aimed precisely at (before assist), or 0. Only that enemy takes a crit. */
  precise: number;
}

export type GameEvent =
  | { type: "shot"; pos: Vec; angle: number }
  | { type: "hit"; pos: Vec; crit: boolean; enemy: number }
  | { type: "kill"; pos: Vec; kind: EnemyKind; crit: boolean; streak: number; last: boolean }
  | { type: "wallHit"; pos: Vec; from: Bullet["from"] }
  | { type: "hurt"; pos: Vec; hp: number }
  | { type: "dash"; pos: Vec }
  | { type: "reload" }
  | { type: "reloaded" }
  | { type: "telegraph"; enemy: number; kind: EnemyKind }
  | { type: "enemyShot"; pos: Vec }
  | { type: "rush"; pos: Vec }
  | { type: "spawn"; pos: Vec; kind: EnemyKind }
  | { type: "roomStart"; room: number }
  | { type: "roomClear"; room: number; time: number }
  | { type: "dead" }
  | { type: "done" };

export type Phase = "fight" | "clear" | "dead" | "done";

export interface State {
  rng: number;
  tick: number;
  room: number;
  phase: Phase;
  phaseTimer: number;
  /** Ticks spent in the current room's fight. */
  roomTicks: number;
  player: Player;
  enemies: Enemy[];
  bullets: Bullet[];
  cover: Rect[];
  /** Waves still to come in this room; each spawns when the previous is cleared. */
  waves: EnemyKind[][];
  streak: number;
  streakTimer: number;
  roomTimes: number[];
  hitsTaken: number;
  deaths: number;
  shots: number;
  hits: number;
  crits: number;
  nextId: number;
  events: GameEvent[];
}

export interface Input {
  move: Vec;
  /** Aim point in world coordinates. */
  aim: Vec;
  fire: boolean;
  /** True on the tick the dash button is pressed. */
  dash: boolean;
  reload: boolean;
}

export const NO_INPUT: Input = { move: { x: 0, y: 0 }, aim: { x: WORLD.w / 2, y: 0 }, fire: false, dash: false, reload: false };

// --------------------------------------------------------------- rooms

export interface RoomDef {
  /** The single line of coaching shown while this room is fought, or "". */
  hint: string;
  cover: Rect[];
  waves: EnemyKind[][];
  /** Par time in seconds; beating it counts toward the rank. */
  par: number;
}

const c = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });

export const ROOMS: RoomDef[] = [
  { hint: "左クリックで撃つ · 中心に当てると大ダメージ", cover: [], waves: [["drone", "drone", "drone"], ["drone", "drone", "drone", "drone"]], par: 5 },
  { hint: "Space でダッシュ · ダッシュ中は当たらない", cover: [c(300, 210, 40, 120), c(620, 210, 40, 120)], waves: [["rusher", "drone", "drone"], ["rusher", "rusher", "drone", "drone"]], par: 7 },
  { hint: "大きい敵は扇状に撃つ · 遮蔽物で受ける", cover: [c(440, 120, 80, 36), c(440, 384, 80, 36)], waves: [["gunner", "drone", "drone"], ["gunner", "rusher", "drone", "drone"]], par: 8 },
  { hint: "", cover: [c(220, 150, 36, 90), c(704, 300, 36, 90), c(450, 250, 60, 40)], waves: [["drone", "drone", "rusher", "rusher", "drone"], ["gunner", "gunner", "drone", "drone"]], par: 10 },
  { hint: "", cover: [c(180, 240, 120, 32), c(660, 240, 120, 32)], waves: [["rusher", "rusher", "rusher"], ["gunner", "gunner", "drone", "drone"], ["drone", "drone", "drone", "rusher", "rusher"]], par: 13 },
  { hint: "", cover: [c(300, 140, 36, 36), c(624, 140, 36, 36), c(300, 364, 36, 36), c(624, 364, 36, 36)], waves: [["drone", "drone", "drone", "drone", "drone"], ["rusher", "rusher", "gunner", "gunner"], ["gunner", "rusher", "rusher", "drone", "drone"]], par: 15 },
];

// --------------------------------------------------------------- rng

export function rand(s: { rng: number }): number {
  const a = (s.rng + 0x6d2b79f5) | 0;
  s.rng = a;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// --------------------------------------------------------------- creation

function freshPlayer(): Player {
  return {
    pos: { x: WORLD.w / 2, y: WORLD.h - 90 },
    vel: { x: 0, y: 0 },
    aim: -Math.PI / 2,
    hp: PLAYER.hp,
    invuln: 0,
    dashTime: 0,
    dashCooldown: 0,
    dashDir: { x: 0, y: -1 },
    mag: GUN.mag,
    reload: 0,
    fireCooldown: 0,
  };
}

/** Spawn points sit in the upper part of the room, away from cover and from each other. */
export function spawnWave(s: State, kinds: EnemyKind[]) {
  const placed: Vec[] = [];
  for (const kind of kinds) {
    const r = ENEMY[kind].radius;
    let p: Vec = { x: WORLD.w / 2, y: 120 };
    for (let tries = 0; tries < 40; tries++) {
      p = { x: 90 + rand(s) * (WORLD.w - 180), y: 70 + rand(s) * 200 };
      const clearOfCover = s.cover.every((k) => !circleRect(p, r + 20, k));
      const clearOfOthers = placed.every((q) => Math.hypot(q.x - p.x, q.y - p.y) > 90);
      const clearOfPlayer = Math.hypot(s.player.pos.x - p.x, s.player.pos.y - p.y) > 260;
      if (clearOfCover && clearOfOthers && clearOfPlayer) break;
    }
    placed.push(p);
    s.enemies.push({
      id: s.nextId++,
      kind,
      pos: p,
      vel: { x: 0, y: 0 },
      hp: ENEMY[kind].hp,
      facing: Math.PI / 2,
      mode: "spawning",
      timer: 0.7 + placed.length * 0.12,
      aimLock: 0,
    });
    s.events.push({ type: "spawn", pos: p, kind });
  }
}

export function enterRoom(s: State, room: number) {
  const def = ROOMS[room];
  s.room = room;
  s.phase = "fight";
  s.phaseTimer = 0;
  s.roomTicks = 0;
  s.player = freshPlayer();
  s.enemies = [];
  s.bullets = [];
  s.cover = def.cover.map((r) => ({ ...r }));
  s.waves = def.waves.slice(1).map((w) => [...w]);
  s.streak = 0;
  s.streakTimer = 0;
  s.events.push({ type: "roomStart", room });
  spawnWave(s, def.waves[0]);
}

export function newRun(seed: number): State {
  const s: State = {
    rng: seed >>> 0,
    tick: 0,
    room: 0,
    phase: "fight",
    phaseTimer: 0,
    roomTicks: 0,
    player: freshPlayer(),
    enemies: [],
    bullets: [],
    cover: [],
    waves: [],
    streak: 0,
    streakTimer: 0,
    roomTimes: [],
    hitsTaken: 0,
    deaths: 0,
    shots: 0,
    hits: 0,
    crits: 0,
    nextId: 1,
    events: [],
  };
  enterRoom(s, 0);
  return s;
}

// --------------------------------------------------------------- geometry

export function circleRect(p: Vec, r: number, k: Rect): boolean {
  const cx = Math.max(k.x, Math.min(p.x, k.x + k.w));
  const cy = Math.max(k.y, Math.min(p.y, k.y + k.h));
  return (p.x - cx) ** 2 + (p.y - cy) ** 2 < r * r;
}

/** Push a circle out of a rectangle along the shortest axis. */
export function pushOut(p: Vec, r: number, k: Rect) {
  if (!circleRect(p, r, k)) return;
  const left = p.x + r - k.x;
  const right = k.x + k.w - (p.x - r);
  const up = p.y + r - k.y;
  const down = k.y + k.h - (p.y - r);
  const m = Math.min(left, right, up, down);
  if (m === left) p.x -= left;
  else if (m === right) p.x += right;
  else if (m === up) p.y -= up;
  else p.y += down;
}

export function clampToRoom(p: Vec, r: number) {
  p.x = Math.max(WORLD.wall + r, Math.min(WORLD.w - WORLD.wall - r, p.x));
  p.y = Math.max(WORLD.wall + r, Math.min(WORLD.h - WORLD.wall - r, p.y));
}

/** True when the segment a→b crosses no cover. Sampled, which is plenty at these sizes. */
export function lineOfSight(s: State, a: Vec, b: Vec): boolean {
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  const n = Math.ceil(d / 12);
  for (let i = 1; i < n; i++) {
    const p = { x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n };
    if (s.cover.some((k) => p.x > k.x && p.x < k.x + k.w && p.y > k.y && p.y < k.y + k.h)) return false;
  }
  return true;
}

/** The first cover rectangle the segment a→b passes through, if any. */
export function blockingCover(s: State, a: Vec, b: Vec): Rect | undefined {
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  const n = Math.ceil(d / 12);
  for (let i = 1; i < n; i++) {
    const p = { x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n };
    const hit = s.cover.find((k) => p.x > k.x && p.x < k.x + k.w && p.y > k.y && p.y < k.y + k.h);
    if (hit) return hit;
  }
  return undefined;
}

export const angleTo = (a: Vec, b: Vec) => Math.atan2(b.y - a.y, b.x - a.x);
export const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
