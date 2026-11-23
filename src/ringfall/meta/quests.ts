import type { EnemyKind, ModuleId, ValuableKind } from "../sim/config";
import { POIS, type ExtractId, type NodeId, type PoiId } from "../sim/map";
import type { State } from "../sim/state";
import { questBoardOn } from "./features";

/**
 * What a quest asks for. Kills and clears count even on a wipe; leaving needs getting off. A
 * capture counts only when the raid got off alive (teach: 前線の核を制圧して持ち帰る). A
 * delivery is handed over at the base from the stash, and a build goal is met at the base, by the
 * hideout reaching a level.
 */
export type Goal =
  | { t: "kill"; kind: EnemyKind; n: number }
  | { t: "clear"; poi: PoiId }
  | { t: "capture"; n: number }
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
 * The trader's quests: the intro quests, teaching the basics (the front's core, fighting a squad,
 * getting off, building, handing items in), listed above the board until done; the day's contracts
 * send the player round the island after them. `front` is first in the list so the board and the
 * camp's next hand teach 出撃 → 前線の核 · 制圧 → 持ち帰る before the other intros.
 */
export const QUESTS: Quest[] = [
  { id: "front", title: "前線を一つ", text: "前線の核を1つ制圧して生還する", goal: { t: "capture", n: 1 }, after: [], reward: { cash: 700, items: [{ t: "heal", kind: "cell" }, { t: "heal", kind: "syringe" }] }, intro: true },
  { id: "grunts", title: "見張りの間引き", text: "グラントを 8 体倒す", goal: { t: "kill", kind: "grunt", n: 8 }, after: [], reward: { cash: 600, items: [{ t: "heal", kind: "cell" }, { t: "heal", kind: "cell" }] }, intro: true },
  { id: "village", title: "静かな帰り道", text: "廃村から脱出する", goal: { t: "extract", exit: "village" }, after: [], reward: { cash: 500, items: [{ t: "heal", kind: "syringe" }, { t: "heal", kind: "syringe" }] }, intro: true },
  { id: "medbay", title: "手当ての備え", text: "隠れ家の医務室を Lv1 にする", goal: { t: "build", module: "infirmary", level: 1 }, after: ["grunts"], reward: { cash: 400, items: [{ t: "valuable", kind: "wire" }] }, intro: true },
  { id: "parts", title: "部品の回収", text: "部品を 3 個納品する", goal: { t: "deliver", valuable: "parts", n: 3 }, after: ["grunts"], reward: { cash: 500, items: [{ t: "weapon", kind: "pike", rarity: 1 }] }, intro: true },
];

/** How much a goal needs (a count, or 1 for a yes/no goal). */
export const need = (g: Goal) => (g.t === "kill" || g.t === "deliver" || g.t === "capture" ? g.n : 1);

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

/**
 * Quests offered now: not done, with everything they come after done.
 * Empty while the 依頼板 is off (`FEATURES.questBoard`) so settle / bag / tips earn nothing from them.
 */
export const offered = (log: QuestLog) => (questBoardOn() ? QUESTS.filter((q) => !log.done.includes(q.id) && q.after.every((a) => log.done.includes(a))) : []);

/**
 * The front intro is still open: first sessions put 前線の核 · 制圧 on the next hand.
 * When the board is off this is always false — use `teachFrontCapture()` in the hub instead.
 */
export const introFrontOpen = (log: QuestLog) => offered(log).some((q) => q.id === "front");

/**
 * A save from before the front intro (Profile.v < 31): if it already finished another intro,
 * count front done so mid-game players are not sent back to the first lesson. Never apply when
 * `front` is already in progress — that is a current profile's tutorial state.
 */
export function withFrontMigrated(done: string[], progress: Record<string, number> = {}): string[] {
  if (done.includes("front") || progress.front !== undefined) return done;
  if (done.some((id) => id === "grunts" || id === "village" || id === "medbay" || id === "parts")) return [...done, "front"];
  return done;
}

/** What one raid adds to a goal. Deliveries and builds are made at the base, not in a raid. */
export function raidCredit(g: Goal, s: State): number {
  const out = s.outcome === "extracted";
  switch (g.t) {
    case "kill":
      return s.stats.killsBy[g.kind];
    // A freed POI has no robots left to clear: coming into it counts, so a quest opened after it was freed can still be done.
    case "clear":
      return s.stats.cleared.some((i) => POIS[i].id === g.poi) || (s.stats.captured ?? []).includes(g.poi as never) || POIS.some((p, i) => p.id === g.poi && s.hold?.[i] === "freed" && s.visited[i]) ? 1 : 0;
    case "capture":
      // Alive only: wipe teaches the fight, but the line is 制圧して持ち帰る.
      return out ? Math.min(g.n, (s.stats.captured as NodeId[] | undefined)?.length ?? 0) : 0;
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
