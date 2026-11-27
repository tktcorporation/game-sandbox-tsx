/*
 * 留守のあいだの攻め（docs/ringfall/glossary.md 決定 B）: 自分の陣地を取りうるのは別プレイヤーだけ。
 * 本物の人の攻めはサーバーが届けるまで、AI プレイヤーが現実の時間で陣地を攻めてくる。
 *
 * 一時間ごとに一度、AI プレイヤーのどれかが攻めに来るかを引く（島の種と時刻のハッシュ。乱数は使わない）。
 * 来たら陣地の一つを選び、攻め手の工場と守り（工場のレベル＋その陣地の島の守り）を比べて勝ち負けを決める。
 * 取られた陣地は持ち主の島でロボットの側に戻り（攻めた側の物にはならない）、その陣地の島の守りは攻め手の倉庫へ。
 * 取られたらその日は島全体が守られ（盾）、一日に失うのは `OUTER_GUARD.lossCap` まで。
 */
import { nodeIndex, POIS, type NodeId } from "../sim/map";
import { FACTORY_TOP } from "../sim/config";
import { DEFENCE_AID } from "../sim/island";
import { aiIslands, type AiIsland } from "./ai-islands";
import type { IslandLogEntry } from "./expeditions";
import { playerNodes, type Island } from "./island";
import { aiLabel } from "./neighbours";
import { canLoseOuter, emptyOuterGuard, recordOuterLoss, type OuterGuard } from "./outer-guard";
import type { Parcel } from "./parcels";
import { clampTrophies, raidOdds, TROPHY } from "./trophies";
import { accrue, emptyStores, type Stores } from "./income";

export const AWAY = {
  /** One draw an hour. */
  hour: 3_600_000,
  /** The chance an hour that one of the AI players attacks (about one attack every two-thirds of a day away). */
  chance: 0.06,
  /** A long absence is reckoned over its last this many hours only. */
  catchUp: 48,
  /** The attacker's factory: this many of the player's holdings make one level. */
  perLevel: 3,
  /** How sharply the gap between attack and defence decides (a level of gap ≈ ±0.25 on the odds). */
  slope: 0.25,
} as const;

const hash = (...xs: number[]) => {
  let h = 2166136261;
  for (const x of xs) {
    h ^= x | 0;
    h = Math.imul(h, 16777619);
    h ^= h >>> 13;
  }
  return h >>> 0;
};
const unit = (...xs: number[]) => (hash(...xs) % 100_000) / 100_000;

type Seen = { poiState: Island; parcels: readonly Parcel[]; factory: number; trophies: number; outerGuard: OuterGuard; attackedAt: number; stores: Stores };

/** What the hours since the last look brought: the profile after them and the island's news of them. */
export interface AwayResult<P> {
  profile: P;
  news: IslandLogEntry[];
  /** Trophies lost to holdings taken (defences are paid by the caller with `defenceWin`). */
  lost: number;
  /** Credits waiting at the holdings taken, which the attackers carried off (拠点の収入). */
  stolen: number;
}

/** The odds an attacker of factory `attack` takes a holding defended by `defence` (factory + its 島の守り). */
export const takeOdds = (attack: number, defence: number): number => Math.max(0.1, Math.min(0.9, 0.5 + (attack - defence) * AWAY.slope));

/** The AI players' attacks on the player's holdings between `p.attackedAt` and `now`. */
/**
 * `held`, when given, is the holdings as the reckoned hours began (a profile settled since may hold nodes it took
 * after them): an attack picks only among those still held.
 */
export function awayAttacks<P extends Seen>(p: P, salt: number, now: number, taken: readonly number[] = [], held?: readonly NodeId[]): AwayResult<P> {
  const news: IslandLogEntry[] = [];
  const first = Math.max(Math.floor(p.attackedAt / AWAY.hour) + 1, Math.floor(now / AWAY.hour) - AWAY.catchUp + 1);
  const last = Math.floor(now / AWAY.hour);
  // A fresh profile starts counting now: nothing came before the player was here.
  if (!p.attackedAt || last < first) return { profile: { ...p, attackedAt: p.attackedAt || now }, news, lost: 0, stolen: 0 };
  const islands = aiIslands(salt, taken);
  let poiState = p.poiState;
  let parcels = [...p.parcels];
  let guard = p.outerGuard ?? emptyOuterGuard();
  let trophies = p.trophies ?? TROPHY.start;
  let lost = 0;
  let stolen = 0;
  let stores = p.stores ?? emptyStores();
  let checked = now;
  for (let h = first; h <= last; h++) {
    if (!islands.length || unit(salt, h, 3) >= AWAY.chance) continue;
    const at = h * AWAY.hour + (hash(salt, h, 5) % AWAY.hour);
    // An attack not due yet waits for the next look: the clock stops just before its hour.
    if (at > now) {
      checked = h * AWAY.hour - 1;
      break;
    }
    const own = playerNodes({ poiState }).filter((id) => !POIS[nodeIndex(id)]?.boss && (!held || held.includes(id)));
    if (!own.length) continue;
    const node: NodeId = own[hash(salt, h, 7) % own.length]!;
    const a: AiIsland = islands[hash(salt, h, 11) % islands.length]!;
    const by = { code: a.code, name: aiLabel(a.name) };
    const attack = Math.min(FACTORY_TOP, Math.floor(own.length / AWAY.perLevel));
    const guardAt = Math.min(DEFENCE_AID, parcels.filter((q) => q.poi === node).length);
    const odds = takeOdds(attack, p.factory + guardAt / 2);
    if (canLoseOuter(guard, at) && unit(salt, h, 13) < odds) {
      // What the holding made up to the attack goes with it.
      stores = accrue(stores, poiState, at);
      stolen += Math.floor(stores.at[node] ?? 0);
      stores = { ...stores, at: { ...stores.at, [node]: 0 } };
      poiState = { ...poiState, [node]: { state: "foe" } };
      parcels = parcels.filter((q) => q.poi !== node);
      guard = recordOuterLoss(guard, at);
      const { N } = raidOdds(trophies, trophies);
      lost += N;
      trophies = clampTrophies(trophies - N);
      news.push({ seq: 0, at, t: "taken", node, by });
    } else news.push({ seq: 0, at, t: "wiped", node, by });
  }
  return { profile: { ...p, poiState, parcels, outerGuard: guard, trophies, attackedAt: checked, stores }, news, lost, stolen };
}

/**
 * The holdings a raid's battle lost to the enemy's squads, which go by AI players' names in the
 * raid (`BattleSquad.by`, 決定 B): told as those players' attacks, each costing trophies as one
 * while away does and counting toward the day's loss cap. The battle has already given the node
 * back to the robots; an owner not among `islands` (the raid's raiders) is left out.
 */
export function battleLosses<P extends Seen>(p: P, islands: readonly AiIsland[], lost: readonly { node: NodeId; by: string }[], now: number): AwayResult<P> {
  const news: IslandLogEntry[] = [];
  let trophies = p.trophies ?? TROPHY.start;
  let guard = p.outerGuard ?? emptyOuterGuard();
  let parcels = [...p.parcels];
  let n = 0;
  for (const l of lost) {
    const a = islands.find((x) => x.code === l.by);
    if (!a) continue;
    const { N } = raidOdds(trophies, trophies);
    n += N;
    trophies = clampTrophies(trophies - N);
    guard = recordOuterLoss(guard, now);
    parcels = parcels.filter((q) => q.poi !== l.node);
    news.push({ seq: 0, at: now, t: "taken", node: l.node, by: { code: a.code, name: aiLabel(a.name) } });
  }
  if (!news.length) return { profile: p, news, lost: 0, stolen: 0 };
  return { profile: { ...p, trophies, outerGuard: guard, parcels }, news, lost: n, stolen: 0 };
}
