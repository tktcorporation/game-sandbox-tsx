import type { EnemyKind, ModuleId, ValuableKind } from "../sim/config";
import { POIS, type ExtractId, type PoiId } from "../sim/map";
import type { State } from "../sim/state";

/**
 * What a quest asks for. Kills and clears count even on a wipe; leaving needs getting off. A
 * delivery is handed over at the base from the stash, and a build goal is met at the base, by the
 * hideout reaching a level.
 */
export type Goal =
  | { t: "kill"; kind: EnemyKind; n: number }
  | { t: "clear"; poi: PoiId }
  | { t: "extract"; exit: ExtractId }
  | { t: "deliver"; valuable: ValuableKind; n: number }
  | { t: "build"; module: ModuleId; level: number };

/** Reward items, written like stash items (kept loose here to avoid a cycle with profile.ts). */
export type RewardItem =
  | { t: "weapon"; kind: "pike" | "hornet" | "maul" | "lance" | "talon"; rarity: 0 | 1 | 2 | 3 }
  | { t: "armor"; tier: 1 | 2 | 3 }
  | { t: "heal"; kind: "cell" | "battery" | "syringe" | "medkit" }
  | { t: "key"; poi: PoiId }
  | { t: "valuable"; kind: ValuableKind };

export interface Quest {
  id: string;
  title: string;
  /** The trader's ask, in a line. */
  text: string;
  goal: Goal;
  /** Quests that must be done before this one is offered. */
  after: string[];
  reward: { cash: number; items: RewardItem[] };
  /** An intro quest, teaching the basics: the board lists these above the day's contracts. */
  intro?: true;
}

/**
 * The trader's quests, in the order they open up. The intro quests teach the basics (fighting a
 * squad, getting off, building, handing items in) and are listed above the board until done; the
 * day's contracts send the player round the island after them. The escape craft's line opens once
 * the generator is built: each of its quests points at where the craft's parts are and pays some
 * of them, and the last is the craft itself.
 */
export const QUESTS: Quest[] = [
  { id: "grunts", title: "見張りの間引き", text: "グラントを 8 体倒す", goal: { t: "kill", kind: "grunt", n: 8 }, after: [], reward: { cash: 600, items: [{ t: "heal", kind: "cell" }, { t: "heal", kind: "cell" }] }, intro: true },
  { id: "village", title: "静かな帰り道", text: "廃村から脱出する", goal: { t: "extract", exit: "village" }, after: [], reward: { cash: 500, items: [{ t: "heal", kind: "syringe" }, { t: "heal", kind: "syringe" }] }, intro: true },
  { id: "power", title: "明かりを点ける", text: "隠れ家の発電機を Lv1 にする", goal: { t: "build", module: "generator", level: 1 }, after: ["grunts"], reward: { cash: 400, items: [{ t: "valuable", kind: "wire" }] }, intro: true },
  { id: "parts", title: "部品の回収", text: "部品を 3 個納品する", goal: { t: "deliver", valuable: "parts", n: 3 }, after: ["grunts"], reward: { cash: 500, items: [{ t: "weapon", kind: "pike", rarity: 1 }] }, intro: true },
  { id: "craft", title: "脱出艇の話", text: "隠れ家の脱出艇の船体を塞ぐ", goal: { t: "build", module: "craft", level: 1 }, after: ["power"], reward: { cash: 2000, items: [{ t: "valuable", kind: "gyro" }] } },
  { id: "navigator", title: "航法装置", text: "脱出艇に航法装置を据える。ジャイロと記憶装置は難破船の箱に多い", goal: { t: "build", module: "craft", level: 2 }, after: ["craft"], reward: { cash: 2500, items: [{ t: "valuable", kind: "core" }, { t: "valuable", kind: "drive" }] } },
  { id: "control", title: "制御系", text: "脱出艇の制御系をつなぐ。データコアは発着場のタイタンと最上階の箱", goal: { t: "build", module: "craft", level: 3 }, after: ["navigator"], reward: { cash: 3000, items: [{ t: "valuable", kind: "core" }] } },
  { id: "furnace", title: "製錬所の炉", text: "製錬所を制圧する。小型炉心はそこの箱に眠る", goal: { t: "clear", poi: "smelter" }, after: ["control"], reward: { cash: 3000, items: [{ t: "valuable", kind: "reactor" }] } },
  { id: "escape", title: "島を出る", text: "脱出艇の機関に火を入れる", goal: { t: "build", module: "craft", level: 4 }, after: ["furnace"], reward: { cash: 0, items: [] } },
];

/** How much a goal needs (a count, or 1 for a yes/no goal). */
export const need = (g: Goal) => (g.t === "kill" || g.t === "deliver" ? g.n : 1);

/** Build goals the hideout already meets. */
export const built = (g: Goal, h: Record<ModuleId, number>) => g.t === "build" && h[g.module] >= g.level;

/** Quest progress kept in the profile: counts for open quests, and the ids done. */
export interface QuestLog {
  progress: Record<string, number>;
  done: string[];
}

export const emptyLog = (): QuestLog => ({ progress: {}, done: [] });

/** The ids of every quest there is: a save's log keeps only these. */
export const QUEST_IDS = new Set(QUESTS.map((q) => q.id));

/** Quests offered now: not done, with everything they come after done. */
export const offered = (log: QuestLog) => QUESTS.filter((q) => !log.done.includes(q.id) && q.after.every((a) => log.done.includes(a)));

/** What one raid adds to a goal. Deliveries and builds are made at the base, not in a raid. */
export function raidCredit(g: Goal, s: State): number {
  const out = s.outcome === "extracted";
  switch (g.t) {
    case "kill":
      return s.stats.killsBy[g.kind];
    // A freed POI has no robots left to clear: coming into it counts, so a quest opened after it was freed can still be done.
    case "clear":
      return s.stats.cleared.some((i) => POIS[i].id === g.poi) || (s.stats.captured ?? []).includes(g.poi as never) || POIS.some((p, i) => p.id === g.poi && s.hold?.[i] === "freed" && s.visited[i]) ? 1 : 0;
    case "extract":
      return out && s.extractedAt === g.exit ? 1 : 0;
    case "deliver":
    case "build":
      return 0;
  }
}

/** The log after a raid, and the quests the raid finished (their rewards are not paid here). */
export function creditRaid(log: QuestLog, s: State): { log: QuestLog; finished: Quest[] } {
  const progress = { ...log.progress };
  const finished: Quest[] = [];
  for (const q of offered(log)) {
    const got = raidCredit(q.goal, s);
    if (!got) continue;
    progress[q.id] = Math.min(need(q.goal), (progress[q.id] ?? 0) + got);
    if (progress[q.id] >= need(q.goal)) finished.push(q);
  }
  for (const q of finished) delete progress[q.id];
  return { log: { progress, done: [...log.done, ...finished.map((q) => q.id)] }, finished };
}
