/*
 * The islands the game runs itself (docs/ringfall/multiplayer.md, AI の島): while the server offers
 * fewer neighbours than the sea has slots (few players, or no server at all), each empty slot holds
 * an island of the game's own, which lives as a player's would. Each day of the player's it takes or
 * loses a node of its own island, plays a raid now and then by the clock, and builds its factory up.
 * Its holdings are sortie targets as a player's are (meta/sortie.ts), and it attacks the player's
 * holdings by the clock while the player is away (meta/away-attacks.ts). It is marked AI wherever
 * it is shown. Pure: everything follows from a salt (the browser's player, so two players meet
 * different islands), the profile and the clock, with nothing kept but what the profile already
 * keeps (the nodes held); the browser's requests are answered from here (island-net.ts).
 */
import { FACTORY_TOP, type ValuableKind } from "../sim/config";
import { aiOwner, isAiOwner, type PoiHold } from "../sim/holds";
import { DEPOTS, FRONT_LINKS, NODES, nodeIndex, type NodeId, type PoiId } from "../sim/map";
import { CODE_ALPHABET, CODE_LENGTH } from "./island-code";
import type { IslandView } from "./island-sync";
import { LOCAL_AID, type Parcel } from "./parcels";
import { aiLabel, NEIGHBOUR_MAX, NEIGHBOUR_SLOTS, type Neighbour } from "./neighbours";
import { TROPHY, clampTrophies } from "./trophies";
import { OUTER_GUARD } from "./outer-guard";

/** The numbers of the game's islands. */
export const AI = {
  /** The nodes it holds on its island's first day, and how many more a day (one rate a slot), and the most. */
  held: { first: 2, rate: [0.42, 0.5, 0.36, 0.56] as const, spare: 2 },
  /** The days to each level of its factory. */
  factoryDays: 5,
  /** The hours between its raids (one a slot), by the clock. */
  every: [6, 9, 7, 11] as const,
};

/**
 * AI owners' names (TKT-204 案 G): a pool that does not overlap common player short names
 * (旧: ツバキ / ミナト / スバル など). Display always adds 「 · AI」 via `aiLabel()` in copy.ts.
 * A few a slot; the salt picks one. Similar length so the cards keep their size.
 */
const NAMES: readonly (readonly string[])[] = [
  ["カゲウツ", "イソナミ", "オキカゼ"],
  ["ヤマビコ", "サワタリ", "ホシクズ"],
  ["クロサキ", "キンロウ", "ギンカゼ"],
  ["アラシヤマ", "シオサイ", "カスミメ"],
];

/** A small integer hash of a few numbers. */
function hash(...xs: number[]): number {
  let h = 0x811c9dc5;
  for (const x of xs) {
    h = Math.imul(h ^ (x >>> 0), 0x01000193) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
    h ^= h >>> 12;
  }
  return h >>> 0;
}
const unit = (...xs: number[]) => (hash(...xs) % 100_000) / 100_000;

/** One of the game's islands, as it stands in its slot whatever day it is. */
export interface AiIsland {
  slot: number;
  code: string;
  name: string;
}

/** The game's island in slot `k` for `salt`: its code (an island code, never handed out by the server but by the slim chance of a draw) and its owner's name. */
export function aiIsland(salt: number, k: number): AiIsland {
  const code = Array.from({ length: CODE_LENGTH }, (_, i) => CODE_ALPHABET[hash(salt, k, 31 + i) % CODE_ALPHABET.length]).join("");
  const names = NAMES[k % NAMES.length];
  return { slot: k, code, name: names[hash(salt, k, 7) % names.length] };
}

/** The game's islands in the slots `taken` leaves free. */
export const aiIslands = (salt: number, taken: readonly number[] = []): AiIsland[] =>
  NEIGHBOUR_SLOTS.map((_, k) => k).filter((k) => !taken.includes(k)).slice(0, NEIGHBOUR_MAX).map((k) => aiIsland(salt, k));

/** The game's island of code `code` among those `taken` leaves free, or null. */
export const aiByCode = (salt: number, code: string, taken: readonly number[] = []): AiIsland | null => aiIslands(salt, taken).find((a) => a.code === code) ?? null;

/** The game's island whose battle owner is `owner` (`aiOwner()`), or null. */
export const aiByOwner = (salt: number, owner: string | null, taken: readonly number[] = []): AiIsland | null => (isAiOwner(owner) ? aiByCode(salt, owner!.slice(3), taken) : null);

/**
 * The nodes of its own island in the order it takes them: out from the camp along the front's
 * links, a hash of the island breaking each step's ties, so each island grows its own way.
 */
function takeOrder(a: AiIsland, salt: number): NodeId[] {
  const out: NodeId[] = [];
  let front = FRONT_LINKS.filter((l) => l[0] === "camp").map((l) => l[1]);
  while (out.length < NODES.length && front.length) {
    const next = [...front].sort((x, y) => hash(salt, a.slot, nodeIndex(x)) - hash(salt, a.slot, nodeIndex(y)))[0];
    out.push(next);
    const seen = new Set<string>(out);
    front = [...new Set(FRONT_LINKS.flatMap((l) => (l[0] === "camp" ? [] : seen.has(l[0]) && !seen.has(l[1]) ? [l[1]] : seen.has(l[1]) && !seen.has(l[0]) ? [l[0]] : [])))] as NodeId[];
  }
  return out;
}

/** How many nodes its island holds on day `day` of the player's: a steady climb at its slot's rate, a day's ups and downs, never all. */
export function aiHeld(a: AiIsland, salt: number, day: number): number {
  const d = Math.max(1, day);
  const climb = AI.held.first + (d - 1) * AI.held.rate[a.slot % AI.held.rate.length];
  const wobble = (hash(salt, a.slot, d, 3) % 3) - 1;
  return Math.max(1, Math.min(NODES.length - AI.held.spare, Math.round(climb) + wobble));
}

/** The nodes its island holds on day `day`. */
export const aiNodes = (a: AiIsland, salt: number, day: number): NodeId[] => takeOrder(a, salt).slice(0, aiHeld(a, salt, day));

/** Its factory's level on day `day`. */
export const aiFactory = (day: number) => Math.max(0, Math.min(FACTORY_TOP, Math.floor((Math.max(1, day) - 1) / AI.factoryDays)));

/** Its last raid by `now`: when (its raids come every few hours by the clock), the cores it took (the nodes it gained since yesterday) and whether it got home. */
export function aiLast(a: AiIsland, salt: number, day: number, now: number): NonNullable<Neighbour["last"]> {
  const every = AI.every[a.slot % AI.every.length] * 3_600_000;
  const off = hash(salt, a.slot, 5) % every;
  const at = Math.floor((now - off) / every) * every + off;
  const captured = Math.max(0, aiHeld(a, salt, day) - aiHeld(a, salt, day - 1));
  return { at, captured, home: hash(salt, a.slot, day, 9) % 5 !== 0 };
}

/**
 * Ranking standings for an AI neighbour: near `TROPHY.start`, nudged by how many nodes it holds
 * so the map can show a number beside the name (お隣の組み合わせは本物の島のトロフィーで組む).
 */
export const aiTrophies = (a: AiIsland, salt: number, day: number): number =>
  clampTrophies(TROPHY.start + (aiHeld(a, salt, day) - AI.held.first) * 20 + ((hash(salt, a.slot, 41) % 41) - 20));

/** Its island as a neighbour of the player on day `day`, at `now`. */
export const aiNeighbour = (a: AiIsland, salt: number, day: number, now: number): Neighbour => ({
  code: a.code,
  name: a.name,
  held: aiHeld(a, salt, day),
  total: NODES.length,
  day,
  slot: a.slot,
  factory: aiFactory(day),
  trophies: aiTrophies(a, salt, day),
  last: aiLast(a, salt, day, now),
  ai: true,
});

const nodeSalt = (id: string) => {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0;
  return h >>> 0;
};

/**
 * AI islands' 島の守り at depots on nodes they hold (for contested-coast defence views).
 * `taken` lists parcel ids already seized from this island in older saves.
 */
export function aiDefenceParcels(a: AiIsland, salt: number, day: number, held: readonly NodeId[], taken: readonly number[] = []): Parcel[] {
  const gone = new Set(taken);
  const pool: ValuableKind[] = ["parts", "fuse", "board"];
  const out: Parcel[] = [];
  held.forEach((id, n) => {
    if (!DEPOTS.some((d) => d.poi === id)) return;
    const pid = 1 + ((Math.imul(salt ^ 0x85ebca6b, a.slot + 1) >>> 0) % 90_000) + n;
    if (gone.has(pid)) return;
    const kind = pool[(Math.imul(salt + day, nodeSalt(id) + 1) >>> 0) % pool.length]!;
    out.push({ id: pid, poi: id as PoiId, kind, from: { code: LOCAL_AID, name: a.name }, at: 0 });
  });
  return out;
}

/** The server's neighbours with the game's islands in the slots it leaves free, in slot order. */
export function withAi(server: readonly Neighbour[], salt: number, day: number, now: number): Neighbour[] {
  const taken = server.map((n) => n.slot);
  return [...server, ...aiIslands(salt, taken).map((a) => aiNeighbour(a, salt, day, now))].sort((x, y) => x.slot - y.slot);
}

/** What changed on its island overnight: the nodes it took, and those it lost. */
export function aiChanges(a: AiIsland, salt: number, day: number): { took: NodeId[]; lost: NodeId[] } {
  const now = aiNodes(a, salt, day);
  const before = aiNodes(a, salt, day - 1);
  return { took: now.filter((id) => !before.includes(id)), lost: before.filter((id) => !now.includes(id)) };
}

/**
 * Its island as anyone sees it (as `GET /api/islands/:code` would answer): its nodes, those it holds
 * and the enemy's next to them marked `open`, and the 島の守り at its holdings.
 */
export function aiView(
  a: AiIsland,
  salt: number,
  day: number,
  /** Parcel ids already removed from this island's defence stock (legacy saves). */
  seized: readonly number[] = [],
): IslandView {
  const held = aiNodes(a, salt, day);
  const own = new Set<string>(held);
  const near = new Set<string>(FRONT_LINKS.flatMap((l) => (l[0] === "camp" ? [] : own.has(l[0]) && !own.has(l[1]) ? [l[1]] : own.has(l[1]) && !own.has(l[0]) ? [l[0]] : [])));
  const nodes = NODES.map((n) => ({ id: n.id as string, hold: (own.has(n.id) ? "own" : "foe") as PoiHold, open: own.has(n.id) || near.has(n.id) }));
  return {
    code: a.code,
    owner: aiLabel(a.name),
    day,
    factory: aiFactory(day),
    protectedUntil: 0,
    shieldUntil: 0,
    outerLost: 0,
    outerLossCap: OUTER_GUARD.lossCap,
    nodes,
    // No sortie of another player reaches the game's own islands: nothing taken to reconcile.
    raided: [],
    parcels: aiDefenceParcels(a, salt, day, held, seized),
  };
}
