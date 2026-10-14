import type { EnemyKind, ValuableKind } from "../sim/config";
import { POIS, type ExtractId, type PoiId, type RegionId } from "../sim/map";
import type { State } from "../sim/state";
import { haulValue } from "../sim/results";

/**
 * What a quest asks for. Kills, clears and vaults count even on a wipe; leaving needs
 * getting off. A vault goal may name the POI whose vault it wants, and a haul goal the
 * region the raid dropped into.
 */
export type Goal =
  | { t: "kill"; kind: EnemyKind; n: number }
  | { t: "clear"; poi: PoiId }
  | { t: "vault"; poi?: PoiId }
  | { t: "extract"; exit: ExtractId }
  | { t: "haul"; value: number; region?: RegionId }
  | { t: "deliver"; valuable: ValuableKind; n: number };

/** Reward items, written like stash items (kept loose here to avoid a cycle with profile.ts). */
export type RewardItem =
  | { t: "weapon"; kind: "pike" | "hornet" | "maul" | "lance" | "talon"; rarity: 0 | 1 | 2 | 3 }
  | { t: "armor"; tier: 1 | 2 | 3 }
  | { t: "heal"; kind: "cell" | "battery" | "syringe" | "medkit" }
  | { t: "key"; poi: PoiId };

export interface Quest {
  id: string;
  title: string;
  /** The trader's ask, in a line. */
  text: string;
  goal: Goal;
  /** Quests that must be done before this one is offered. */
  after: string[];
  reward: { cash: number; items: RewardItem[] };
}

/**
 * The trader's quests, in the order they open up. They lead round the reservoir first:
 * the near POIs, a vault once a key is in hand, the titan. Then over the mountains to the
 * harbor: the wreck, the yard's vault, the boat, and a haul brought out of the harbor.
 */
export const QUESTS: Quest[] = [
  { id: "grunts", title: "見張りの間引き", text: "グラントを 8 体倒す", goal: { t: "kill", kind: "grunt", n: 8 }, after: [], reward: { cash: 600, items: [{ t: "heal", kind: "cell" }, { t: "heal", kind: "cell" }] } },
  { id: "village", title: "静かな帰り道", text: "廃村から脱出する", goal: { t: "extract", exit: "village" }, after: [], reward: { cash: 500, items: [{ t: "heal", kind: "syringe" }, { t: "heal", kind: "syringe" }] } },
  { id: "parts", title: "部品の回収", text: "部品を 3 個納品する", goal: { t: "deliver", valuable: "parts", n: 3 }, after: ["grunts"], reward: { cash: 500, items: [{ t: "weapon", kind: "pike", rarity: 1 }] } },
  { id: "drones", title: "ドローン落とし", text: "ドローンを 4 機倒す", goal: { t: "kill", kind: "drone", n: 4 }, after: ["grunts"], reward: { cash: 700, items: [{ t: "heal", kind: "battery" }] } },
  { id: "quarry", title: "採掘場の制圧", text: "採掘場を制圧する", goal: { t: "clear", poi: "quarry" }, after: ["parts"], reward: { cash: 1000, items: [{ t: "armor", tier: 2 }] } },
  { id: "heavies", title: "重機の解体", text: "ヘビーを 4 体倒す", goal: { t: "kill", kind: "heavy", n: 4 }, after: ["drones"], reward: { cash: 1200, items: [{ t: "weapon", kind: "lance", rarity: 2 }] } },
  { id: "relay", title: "中継塔の奪還", text: "中継塔を制圧する", goal: { t: "clear", poi: "relay" }, after: ["quarry"], reward: { cash: 1500, items: [{ t: "key", poi: "supply" }] } },
  { id: "vault", title: "保管庫の中身", text: "どこかの保管庫を開ける", goal: { t: "vault" }, after: ["relay"], reward: { cash: 2000, items: [{ t: "key", poi: "relay" }] } },
  { id: "drives", title: "記憶装置の納品", text: "記憶装置を 2 個納品する", goal: { t: "deliver", valuable: "drive", n: 2 }, after: ["relay"], reward: { cash: 1500, items: [{ t: "weapon", kind: "hornet", rarity: 3 }] } },
  { id: "titan", title: "タイタン討伐", text: "発着場を制圧する", goal: { t: "clear", poi: "pad" }, after: ["heavies", "vault"], reward: { cash: 4000, items: [{ t: "weapon", kind: "talon", rarity: 3 }] } },
  { id: "haul", title: "大荷物", text: "回収品 3000 以上を持って脱出する", goal: { t: "haul", value: 3000 }, after: ["titan"], reward: { cash: 3000, items: [{ t: "armor", tier: 3 }] } },
  { id: "wreck", title: "難破船の調査", text: "港湾地帯の難破船を制圧する", goal: { t: "clear", poi: "wreck" }, after: ["haul"], reward: { cash: 3000, items: [{ t: "key", poi: "yard" }] } },
  { id: "boat", title: "船で帰る", text: "埠頭のボートで脱出する", goal: { t: "extract", exit: "boat" }, after: ["haul"], reward: { cash: 2000, items: [{ t: "heal", kind: "battery" }, { t: "heal", kind: "battery" }] } },
  { id: "yardVault", title: "ヤードの保管庫", text: "コンテナヤードの保管庫を開ける", goal: { t: "vault", poi: "yard" }, after: ["wreck"], reward: { cash: 3500, items: [{ t: "weapon", kind: "maul", rarity: 3 }] } },
  { id: "harborHaul", title: "港の積み荷", text: "港湾地帯に降りて、回収品 4000 以上を持って脱出する", goal: { t: "haul", value: 4000, region: "harbor" }, after: ["boat", "yardVault"], reward: { cash: 5000, items: [{ t: "weapon", kind: "pike", rarity: 3 }] } },
];

/** How much a goal needs (a count, or 1 for a yes/no goal). */
export const need = (g: Goal) => (g.t === "kill" || g.t === "deliver" ? g.n : 1);

/** Quest progress kept in the profile: counts for open quests, and the ids done. */
export interface QuestLog {
  progress: Record<string, number>;
  done: string[];
}

export const emptyLog = (): QuestLog => ({ progress: {}, done: [] });

/** Quests offered now: not done, with everything they come after done. */
export const offered = (log: QuestLog) => QUESTS.filter((q) => !log.done.includes(q.id) && q.after.every((a) => log.done.includes(a)));

/** What one raid adds to a goal. Deliveries are made at the base, not in a raid. */
export function raidCredit(g: Goal, s: State): number {
  const out = s.outcome === "extracted";
  switch (g.t) {
    case "kill":
      return s.stats.killsBy[g.kind];
    case "clear":
      return s.stats.cleared.some((i) => POIS[i].id === g.poi) ? 1 : 0;
    case "vault":
      return s.stats.vaults.some((i) => !g.poi || POIS[i].id === g.poi) ? 1 : 0;
    case "extract":
      return out && s.extractedAt === g.exit ? 1 : 0;
    case "haul":
      return out && haulValue(s) >= g.value && (!g.region || s.region === g.region) ? 1 : 0;
    case "deliver":
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
