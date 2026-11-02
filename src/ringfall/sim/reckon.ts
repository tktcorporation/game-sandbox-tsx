import { CONQUEST, PLATE, type EnemyKind, type Rarity } from "./config";
import { hypot2 } from "./hypot";
import type { PoiHold } from "./holds";

/*
 * The battle's reckoning in numbers (陣取り戦, sim/battle.ts): the fights and the captures of the
 * squads nobody watches, every `CONQUEST.tick` seconds. Plain data in and out, with no `State` and
 * no world, so that a server can reckon an island nobody plays with the code a raid uses
 * (docs/ringfall/multiplayer.md). The raid gives it the world's share as data: which nodes someone
 * watches, the garrisons' robots, and the robots standing by each core.
 */

/** A side of the battle: the player (0), the enemy (1), the rogues (2), another player (3). */
export type Side = 0 | 1 | 2 | 3;

/** Whose a node's standing is: the player's, the enemy's or another player's (the rogues hold none). */
export const sideOf = (h: PoiHold): Side => (h === "freed" ? 0 : h === "held" ? 1 : 3);

/** A member of a squad while it is numbers: its kind, health and shield. */
export interface Unit {
  kind: EnemyKind;
  hp: number;
  shield: number;
}

/** What a battle squad is about: taking its node, defending it, holding it once there, standing at its core for good as a turret, or coming round the core the player attacks. */
export type Task = "attack" | "defend" | "hold" | "post" | "rally";

/** A capture of a node by a side's squads under way: its side, the seconds held, and for another player's, whose. */
export interface NodeMeter {
  side: Side;
  t: number;
  owner?: string;
}

/**
 * A battle squad as the reckoning sees it: its side (and for another player's, that player's id),
 * members, the node it is bound for, what it is about, where it is, whether it stands at its node,
 * whether it is robots in the world (`live`: the world fights for it), and the seconds before it
 * steps ashore.
 */
export interface ReckonSquad {
  id: number;
  side: Side;
  owner?: string;
  units: Unit[];
  to: number;
  task: Task;
  x: number;
  z: number;
  arrived: boolean;
  live: boolean;
  ashore: number;
}

/** A garrison's robot (a POI's squads: they hold the node for the enemy wherever they are): its side, kind, health, shield and plate. */
export interface Guard {
  side: Side;
  kind: EnemyKind;
  hp: number;
  shield: number;
  plate: Rarity;
}

/** A robot in the world standing by a node's core as a capture counts it: its side, whose for another player's, and whether a battle's (only those attack a node). */
export interface CoreRobot {
  side: Side;
  owner?: string;
  battle: boolean;
}

/**
 * The world by a node's core, where someone watches it or a squad of the battle walks to it in
 * the world: the robots standing there, and how many of the player and the teammate (up, in the
 * raid) stand there too. They hold a node of the player's.
 */
export interface CorePresence {
  robots: CoreRobot[];
  people: number;
}

/** The battle's fights as one reckoning finds them. */
export interface FightField {
  /** Each node's standing, in `NODES` order. */
  holds: readonly PoiHold[];
  squads: readonly ReckonSquad[];
  /** Each node's garrison still standing, in the raid's order. */
  guards: readonly (readonly Guard[])[];
  /** Each node someone watches (the player or the teammate near it): its fights are the world's. */
  watched: readonly boolean[];
  /** The rarity the factory's robots' guns count as against plates. */
  rarity: Rarity;
}

/** What one reckoning's fights leave: the squads still standing, each node's garrison as it is now (those fallen too), and the places in `guards` of those that fell. */
export interface FightResult {
  squads: ReckonSquad[];
  guards: Guard[][];
  fell: number[][];
}

/** The battle's captures as one reckoning finds them. */
export interface CaptureField {
  holds: readonly PoiHold[];
  squads: readonly ReckonSquad[];
  guards: readonly (readonly Guard[])[];
  /** Each node's world by its core, or null where the world does not count. */
  present: readonly (CorePresence | null)[];
  meter: readonly (NodeMeter | null)[];
  /** Each node of the player's whose core hostile robots had come to. */
  threat: readonly boolean[];
}

/**
 * What the captures did, in order: a node's garrison called to its core (`call`), a node of the
 * player's whose core hostile robots have just come to (`threat`), and a node taken (`seize`, by
 * `side`, for another player's `owner`).
 */
export type CaptureEffect = { t: "call"; node: number } | { t: "threat"; node: number } | { t: "seize"; node: number; side: Side; owner?: string };

/** What one reckoning's captures leave. */
export interface CaptureResult {
  holds: PoiHold[];
  squads: ReckonSquad[];
  meter: (NodeMeter | null)[];
  threat: boolean[];
  effects: CaptureEffect[];
}

/** A copy of squads with their members, for a reckoning that leaves its input as it was. */
const copySquads = (qs: readonly ReckonSquad[]): ReckonSquad[] => qs.map((q) => ({ ...q, units: q.units.map((u) => ({ ...u })) }));

const near2d = (a: { x: number; z: number }, b: { x: number; z: number }) => hypot2(a.x - b.x, a.z - b.z);

/**
 * A fighter in a reckoned fight: a squad's member in numbers, or a garrison's robot.
 * `takes(side)` is the share of a hit from `side` that lands (a plate turns what is below it).
 */
type Fighter = { side: Side; kind: EnemyKind; hit: (dmg: number) => void; left: () => number; takes: (from: Side) => number };

const unitFighter = (q: ReckonSquad, u: Unit): Fighter => ({
  side: q.side,
  kind: u.kind,
  hit: (dmg) => {
    const sh = Math.min(u.shield, dmg);
    u.shield -= sh;
    u.hp -= dmg - sh;
  },
  left: () => Math.max(0, u.hp) + Math.max(0, u.shield),
  takes: () => 1,
});

/** A garrison's robot: its plate turns the factory's fire as a weapon of the factory's `rarity`, everyone else's as `PLATE.robots`. */
const guardFighter = (rarity: Rarity) => (e: Guard): Fighter => ({
  side: e.side,
  kind: e.kind,
  hit: (dmg) => {
    const sh = Math.min(e.shield, dmg);
    e.shield -= sh;
    e.hp -= dmg - sh;
  },
  left: () => Math.max(0, e.hp) + Math.max(0, e.shield),
  takes: (from) => {
    const r = from === 0 ? rarity : PLATE.robots;
    return e.plate > r ? PLATE.mult[e.plate - r] : 1;
  },
});

/**
 * One reckoning of a fight between `fighters`: each side's members together deal their damage
 * (`CONQUEST.dps` times `CONQUEST.hit`) for `dt` seconds, shared among the hostile sides there,
 * each side's share landing on its members in order, the first until it is down. A plate turns
 * each attacker's share by that attacker's rarity before it lands, so a share that kills a
 * member is spent only by what the kill took.
 */
function resolve(fighters: Fighter[], dt: number) {
  const sides = [...new Set(fighters.map((f) => f.side))];
  if (sides.length < 2) return;
  const dmg = new Map<Side, number>();
  for (const f of fighters) dmg.set(f.side, (dmg.get(f.side) ?? 0) + CONQUEST.dps[f.kind] * CONQUEST.hit * dt);
  for (const t of sides)
    for (const a of sides) {
      if (a === t) continue;
      let left = (dmg.get(a) ?? 0) / (sides.length - 1);
      for (const f of fighters) {
        if (f.side !== t || left <= 0 || f.left() <= 0) continue;
        const k = f.takes(a);
        // What it has left of health and shield takes the damage; what goes past it falls on the next.
        const lands = Math.min(left * k, f.left());
        f.hit(lands);
        left -= k > 0 ? lands / k : left;
      }
    }
}

/** The fighters of squads in numbers, each squad's members in order. */
const spread = (qs: ReckonSquad[]): Fighter[] => qs.flatMap((q) => q.units.map((u) => unitFighter(q, u)));

/**
 * The fights nobody watches, for `dt` seconds: squads in numbers that meet on the way (within
 * `CONQUEST.meet` of a hostile one) fight each other; squads at a node nobody watches fight its
 * holders there, its whole garrison among them. Members down are gone, and squads with none left
 * that are not robots in the world.
 */
export function reckonFights(f: FightField, dt: number): FightResult {
  const squads = copySquads(f.squads);
  const guards = f.guards.map((g) => g.map((e) => ({ ...e })));
  const fell: number[][] = guards.map(() => []);
  // A squad still in its dropship or boat is in nobody's way.
  const apart = squads.filter((q) => !q.live && q.ashore <= 0);
  // On the way: clusters of squads within `meet` of a hostile one.
  const done = new Set<ReckonSquad>();
  for (const q of apart) {
    if (done.has(q) || (q.arrived && q.task !== "attack")) continue;
    const group = [q];
    for (let k = 0; k < group.length; k++)
      for (const o of apart) if (!group.includes(o) && near2d(o, group[k]) < CONQUEST.meet && (o.side !== group[k].side || group.some((g) => g.side !== o.side))) group.push(o);
    if (new Set(group.map((g) => g.side)).size < 2) continue;
    for (const g of group) done.add(g);
    resolve(spread(group), dt);
  }
  // At the nodes nobody watches: the squads there and the garrison.
  f.holds.forEach((h, i) => {
    if (f.watched[i]) return;
    const here = apart.filter((q) => q.to === i && q.arrived && !done.has(q));
    const owner = sideOf(h);
    if (!here.some((q) => q.side !== owner)) return;
    // The whole garrison comes to its core to hold it.
    const g = owner === 0 ? [] : guards[i];
    resolve([...spread(here), ...g.map(guardFighter(f.rarity))], dt);
    g.forEach((e, k) => e.hp <= 0 && fell[i].push(k));
  });
  for (const q of apart) q.units = q.units.filter((u) => u.hp > 0);
  return { squads: squads.filter((q) => q.live || q.units.length > 0), guards, fell };
}

/** Each node's garrison still standing after the fights. */
export const standing = (r: Pick<FightResult, "guards" | "fell">): Guard[][] => r.guards.map((g, i) => g.filter((_, k) => !r.fell[i].includes(k)));

/**
 * The nodes taken by squads: the squads of a side standing at a node another side holds (in
 * numbers, or as the battle's robots by its core where the world counts), with none of the
 * holder's there, fill the node's meter for `dt` seconds, and take the node at `CONQUEST.capture`.
 * The player and the teammate hold the player's nodes; any of the holder's robots by the core and
 * the garrison, wherever it stands, hold a node of the enemy's. The rogues take nothing, though
 * their robots by a core keep the others from taking it. A node taken: its meter clears, the
 * squads of the side that took it hold it, and those of the side that held it come at it again.
 */
export function reckonCaptures(f: CaptureField, dt: number): CaptureResult {
  const holds = [...f.holds];
  const squads = copySquads(f.squads);
  const meter = f.meter.map((m) => (m ? { ...m } : null));
  const threat = [...f.threat];
  const effects: CaptureEffect[] = [];
  holds.forEach((h, i) => {
    const owner = sideOf(h);
    const att = new Set<Side>();
    // Another player's squads taking it: the first of them names whose it becomes.
    let rival: string | undefined;
    let def = 0;
    // Rogues there take nothing, but keep the others from taking it.
    let rogue = false;
    for (const q of squads) {
      if (q.to !== i || q.live || !q.arrived) continue;
      if (q.side === owner) def++;
      else if (q.side === 2) rogue = true;
      else if (q.task === "attack" || q.task === "rally") {
        att.add(q.side);
        if (q.side === 3) rival ??= q.owner;
      }
    }
    const at = f.present[i];
    if (at) {
      for (const e of at.robots) {
        if (e.side === owner) def++;
        else if (e.side === 2) rogue = true;
        else if (e.battle) {
          att.add(e.side);
          if (e.side === 3) rival ??= e.owner;
        }
      }
      if (owner === 0) def += at.people;
    }
    if (owner !== 0) {
      // The garrison holds its node while it stands: come at, it makes for the core.
      const guards = f.guards[i].length;
      def += guards;
      if (att.size && guards && !meter[i]) effects.push({ t: "call", node: i });
    }
    // Hostile robots at a core of the player's: the core pulses, and the player is called to it.
    const now = owner === 0 && (att.has(1) || att.has(3));
    if (now && !threat[i]) effects.push({ t: "threat", node: i });
    threat[i] = now;
    const m = meter[i];
    if (att.size === 1 && def === 0 && !rogue) {
      const side = [...att][0];
      const who = side === 3 ? rival : undefined;
      if (m && m.side === side && m.owner === who) m.t += dt;
      else meter[i] = who === undefined ? { side, t: dt } : { side, t: dt, owner: who };
      if (meter[i]!.t >= CONQUEST.capture) {
        meter[i] = null;
        holds[i] = side === 0 ? "freed" : side === 3 && who !== undefined ? `rival:${who}` : "held";
        for (const q of squads) {
          if (q.to !== i || q.task === "post") continue;
          if (q.side === side) q.task = "hold";
          else if (q.side === owner) q.task = "attack";
        }
        effects.push(who === undefined ? { t: "seize", node: i, side } : { t: "seize", node: i, side, owner: who });
      }
    } else if (!att.size) meter[i] = null;
  });
  return { holds, squads, meter, threat, effects };
}

/**
 * One reckoning of an island nobody plays, in numbers alone: the fights, then the captures, with
 * no world by any core. What a server runs between raids; a raid runs the two halves with the world's share between them.
 */
export function reckonApart(f: FightField & Pick<CaptureField, "meter" | "threat">, dt: number): FightResult & CaptureResult {
  const fought = reckonFights(f, dt);
  const taken = reckonCaptures({ holds: f.holds, squads: fought.squads, guards: standing(fought), present: f.holds.map(() => null), meter: f.meter, threat: f.threat }, dt);
  return { ...fought, ...taken };
}
