import { rand, shuffle, type Seeded } from "../../arcade/rng";

/*
 * 深淵採掘 — push your luck.
 *
 * Each dive draws cards from one shared deck: gems, and five kinds of hazard
 * with three copies each. The second copy of a hazard kind in the same dive
 * collapses the shaft and the carried gems are lost. The deck's remaining
 * contents are always shown, so the odds of the next step are readable.
 * A collapse also removes that hazard card for the rest of the run, so a bad
 * dive makes later dives safer.
 */

export const HAZARDS = ["rock", "gas", "flood", "bugs", "dark"] as const;
export type Hazard = (typeof HAZARDS)[number];
export const HAZARD_NAME: Record<Hazard, string> = { rock: "落盤", gas: "毒ガス", flood: "浸水", bugs: "岩喰い虫", dark: "暗闇" };
const COPIES = 3;
const GEMS = [1, 2, 3, 4, 5, 5, 7, 7, 9, 11, 11, 13, 14, 15, 17];

export type Card = { kind: "gem"; value: number } | { kind: "hazard"; h: Hazard };

export interface Dive {
  deck: Card[];
  drawn: Card[];
  carry: number;
  o2: number;
  seen: Hazard[];
  helmetUsed: boolean;
  lanternUsed: boolean;
  peek: "hazard" | "safe" | null;
  end: null | "banked" | "bust" | "air";
}

export type Item = "rope" | "lantern" | "helmet";
export const SHOP: Record<Item, { name: string; cost: number; max: number; text: string }> = {
  rope: { name: "命綱", cost: 30, max: 1, text: "崩落しても、持っている宝石の半分を持ち帰る" },
  lantern: { name: "探照灯", cost: 20, max: 1, text: "潜行ごとに 1 回、次の 1 枚が危険かどうか分かる" },
  helmet: { name: "鉄兜", cost: 45, max: 1, text: "潜行ごとに 1 回、崩落を耐える" },
};

export interface Run extends Seeded {
  dive: number;
  dives: number;
  bank: number;
  /** Hazard copies permanently removed by earlier collapses. */
  removed: Record<Hazard, number>;
  owned: Record<Item, number>;
  current: Dive | null;
  history: { carry: number; end: Dive["end"]; depth: number; cards: Card["kind"][] }[];
}

export const BASE_O2 = 12;

/** Depth multiplies the value of gems found there: 1× for the first 4 cards, then 2×, then 3×. */
export const tier = (depth: number) => 1 + Math.floor((depth - 1) / 4);

export function newRun(seed: number): Run {
  return {
    rng: seed >>> 0,
    dive: 0,
    dives: 6,
    bank: 0,
    removed: { rock: 0, gas: 0, flood: 0, bugs: 0, dark: 0 },
    owned: { rope: 0, lantern: 0, helmet: 0 },
    current: null,
    history: [],
  };
}

export function beginDive(r0: Run): Run {
  const r = structuredClone(r0);
  if (r.dive >= r.dives) return r0;
  const deck: Card[] = GEMS.map((value) => ({ kind: "gem", value }));
  for (const h of HAZARDS) for (let i = 0; i < COPIES - r.removed[h]; i++) deck.push({ kind: "hazard", h });
  shuffle(r, deck);
  r.dive++;
  r.current = {
    deck,
    drawn: [],
    carry: 0,
    o2: BASE_O2,
    seen: [],
    helmetUsed: false,
    lanternUsed: false,
    peek: null,
    end: null,
  };
  return r;
}

const isDeadly = (d: Dive, c: Card) => c.kind === "hazard" && d.seen.includes(c.h);

/** Probability that the next card collapses the shaft. */
export function bustChance(d: Dive): number {
  if (!d.deck.length) return 0;
  const deadly = d.deck.filter((c) => isDeadly(d, c)).length;
  const p = deadly / d.deck.length;
  return d.peek === "safe" ? 0 : d.peek === "hazard" ? deadlyShareOfHazards(d) : p;
}

function deadlyShareOfHazards(d: Dive): number {
  const hz = d.deck.filter((c) => c.kind === "hazard");
  return hz.length ? hz.filter((c) => isDeadly(d, c)).length / hz.length : 0;
}

export function descend(r0: Run): Run {
  const d0 = r0.current;
  if (!d0 || d0.end || d0.o2 <= 0 || !d0.deck.length) return r0;
  const r = structuredClone(r0);
  const d = r.current!;
  const card = d.deck.shift()!;
  d.drawn.push(card);
  d.o2--;
  d.peek = null;
  if (card.kind === "gem") d.carry += card.value * tier(d.drawn.length);
  else if (d.seen.includes(card.h)) {
    if (r.owned.helmet && !d.helmetUsed) d.helmetUsed = true;
    else {
      d.end = "bust";
      r.removed[card.h]++;
      d.carry = r.owned.rope ? Math.floor(d.carry / 2) : 0;
      bank(r);
      return r;
    }
  } else d.seen.push(card.h);
  if (d.o2 <= 0 || !d.deck.length) {
    d.end = "air";
    bank(r);
  }
  return r;
}

export function ascend(r0: Run): Run {
  if (!r0.current || r0.current.end) return r0;
  const r = structuredClone(r0);
  r.current!.end = "banked";
  bank(r);
  return r;
}

function bank(r: Run) {
  r.bank += r.current!.carry;
  close(r);
}

function close(r: Run) {
  const d = r.current!;
  r.history.push({ carry: d.carry, end: d.end, depth: d.drawn.length, cards: d.drawn.map((c) => c.kind) });
}

export function useLantern(r0: Run): Run {
  const d0 = r0.current;
  if (!d0 || d0.end || !r0.owned.lantern || d0.lanternUsed || !d0.deck.length) return r0;
  const r = structuredClone(r0);
  const d = r.current!;
  d.lanternUsed = true;
  d.peek = d.deck[0].kind === "hazard" ? "hazard" : "safe";
  return r;
}

export function canBuy(r: Run, item: Item): boolean {
  return r.owned[item] < SHOP[item].max && r.bank >= SHOP[item].cost && (!r.current || !!r.current.end) && r.dive < r.dives;
}

export function buy(r0: Run, item: Item): Run {
  if (!canBuy(r0, item)) return r0;
  const r = structuredClone(r0);
  r.bank -= SHOP[item].cost;
  r.owned[item]++;
  return r;
}

export const finished = (r: Run) => r.dive >= r.dives && !!r.current?.end;

export function remaining(d: Dive) {
  const hazards = Object.fromEntries(HAZARDS.map((h) => [h, 0])) as Record<Hazard, number>;
  let gems = 0;
  for (const c of d.deck) {
    if (c.kind === "gem") gems++;
    else hazards[c.h]++;
  }
  return { gems, hazards, total: d.deck.length };
}

export function newSeed(): number {
  const s = { rng: Date.now() >>> 0 };
  return Math.floor(rand(s) * 2 ** 31);
}

/** Spoiler-free result, one line per dive, no link (Wordle). */
export function shareText(r: Run, label: string): string {
  const lines = r.history.map((h) => {
    const cards = h.cards.map((k, i) => (k === "gem" ? "💎" : i === h.cards.length - 1 && h.end === "bust" ? "💥" : "⚠️")).join("");
    return `${cards}${h.end === "bust" ? "" : "⬆️"} ${h.carry}`;
  });
  return [`深淵採掘 ${label} ${r.bank}`, ...lines].join("\n");
}
