/*
 * 他島への短いレイド（攻める）の出撃エントリ管理・勝敗確定・保留報告・トロフィー追跡。
 *
 * プレイヤーがお隣の島へ攻め込む際、工場の部隊派遣（NPC遠征）と同じ Outgoing レコード構造を流用し、
 * `x2: true` フラグを付与して「プレイヤー主導の短期レイド出撃」として管理する。
 *
 * 責務の分離:
 *   - 本モジュール（assault.ts）: 短いレイド出撃枠の管理、勝敗確定（Won/Lost）、相手サーバーへの報告（POST .../assault）とトロフィー増減。
 *   - incursion.ts: 短いレイドのステージ構築（IncursionPlan）、対象拠点選定、防衛物資の切り出し。
 *
 * 主経路（CoC型: FEATURES.reactiveDefense = false）:
 *   事前の予告猶予時間はなく、出撃地図から即座に短いレイドへ出撃可能。
 *   レイドでの制圧成功（assaultWon）または失敗（assaultLost）を記録し、
 *   相手サーバーへの報告完了（assaultAcked）または拒否（assaultWinRejected）まで状態を追跡する。
 *
 * 休止機能（FEATURES.reactiveDefense = true）:
 *   出撃前に相手島へ事前予告を登録し、猶予時間（12時間など）が経過するまで出撃を待機させる。
 *
 * 関連仕様: docs/ringfall/glossary.md, docs/ringfall/pvp-clarity.md
 * （※純粋関数群であり、クライアントバンドルから worker を import してはならない）
 */
import { AI } from "./ai-islands";
import { expeditionsOut, type Outgoing } from "./expeditions";
import { reactiveDefenseOn } from "./features";
import type { NodeId } from "../sim/map";

/* =========================================================================
 * 主経路: 出撃エントリの取得・作成・勝敗更新・報告追跡
 * ========================================================================= */

/**
 * 指定の島に対して現在アクティブな短いレイドの出撃エントリを取得する。
 * （holding / gone / recalling 以外の進行中エントリ）
 */
export function assaultOf(list: readonly Outgoing[], code: string): Outgoing | null {
  return expeditionsOut({ expeditions: list }).find((o) => o.code === code && o.state !== "holding") ?? null;
}

/**
 * 出撃マップからのお隣への攻め（短いレイド）をスケジュールし、出撃エントリ（x2: true）を作成する。
 * すでに該当島へのアクティブな出撃が存在する場合は何もしない（冪等）。
 * 過去の完了済み（holding / gone）で保留報告（x2Pending）のないエントリは事前に整理する。
 */
export function scheduleAssault(
  list: readonly Outgoing[],
  opts: { code: string; node: NodeId; units: number; id: number; now?: number },
): { list: Outgoing[]; created: Outgoing | null } {
  const now = opts.now ?? Date.now();
  if (assaultOf(list, opts.code)) return { list: [...list], created: null };
  // 完了済みかつ未送信報告のない過去の短いレイドエントリ（o.x2）を除去して新しい出撃枠を空ける
  // （工場の通常NPC遠征の holding は消さない）
  const cleared = list.filter((o) => !(o.x2 && o.code === opts.code && (o.state === "holding" || o.state === "gone") && !o.x2Pending));
  const created: Outgoing = {
    code: opts.code,
    node: opts.node,
    sentAt: now,
    id: opts.id,
    units: opts.units,
    state: "coming",
    x2: true,
  };
  return { list: [...cleared, created], created };
}

/**
 * 短いレイドで標的拠点の制圧に成功した際、出撃エントリを holding（保持中）へ更新する。
 * サーバーへの報告完了待ちとして x2Pending: true および獲得トロフィーを記録する。
 */
export function assaultWon(list: readonly Outgoing[], code: string, tropGain = 0): Outgoing[] {
  return list.map((o) =>
    o.code === code && o.state !== "gone" && o.state !== "recalling"
      ? {
          ...o,
          state: "holding" as const,
          ...(o.x2 && o.id > 0 ? { x2Pending: true as const, ...(tropGain > 0 ? { tropGain } : {}) } : {}),
        }
      : o,
  );
}

/**
 * 短いレイドで標的拠点を制圧できなかった（全滅・撤退）際、出撃エントリを gone（消滅）へ更新する。
 * サーバーへ結果を報告するため、未報告時は x2Pending: true を保持する。
 */
export function assaultLost(list: readonly Outgoing[], code: string): Outgoing[] {
  return list.map((o) =>
    o.code === code && (o.state === "coming" || o.state === "attacking" || o.state === "waiting")
      ? { ...o, state: "gone" as const, ...(o.x2 && o.id > 0 ? { x2Pending: true as const } : {}), tropGain: undefined }
      : o,
  );
}

/**
 * 防衛側の島サーバーが短いレイド結果を受理した後に呼ばれ、x2Pending フラグを解除する。
 * 報告済みの gone エントリはリストから掃除される。
 */
export function assaultAcked(list: readonly Outgoing[], code: string): Outgoing[] {
  return list
    .map((o) => (o.code === code && o.x2Pending ? { ...o, x2Pending: undefined, tropGain: undefined } : o))
    .filter((o) => o.state !== "gone" || o.x2Pending);
}

/**
 * サーバーから勝利報告が拒否された（日跨ぎ制限・相手による要塞化など）場合に呼ばれ、
 * holding 状態を取り消して gone にし、ローカルで加算していたトロフィー獲得量を巻き戻す。
 */
export function assaultWinRejected(list: readonly Outgoing[], code: string): { list: Outgoing[]; tropGain: number } {
  let tropGain = 0;
  const next = list
    .map((o) => {
      if (o.code !== code || !o.x2Pending) return o;
      tropGain += o.tropGain ?? 0;
      return { ...o, state: "gone" as const, x2Pending: undefined, tropGain: undefined };
    })
    .filter((o) => o.state !== "gone" || o.x2Pending);
  return { list: next, tropGain };
}

/* =========================================================================
 * 休止機能: 反応型守り（FEATURES.reactiveDefense = true）用 事前予告タイマー
 * ========================================================================= */

/** 実プレイヤー島への襲撃予告時間（12時間 = 43,200秒）。worker/island.ts の EXPEDITION.notice と同期。 */
export const ASSAULT_NOTICE = 12 * 3600;

/**
 * 短いレイド出撃が可能になるまでの事前猶予秒数。
 * 主経路（既定: FEATURES.reactiveDefense = false）では 0秒（即座に出撃可能）。
 * 休止機能ON時: AI島なら数分（AI.coming * 60）、実プレイヤー島なら12時間。
 */
export const assaultNoticeSec = (ai: boolean): number => {
  if (!reactiveDefenseOn()) return 0;
  return ai ? AI.coming * 60 : ASSAULT_NOTICE;
};

/** 事前予告猶予時間が経過し、短いレイドへ出撃可能になったかどうか。 */
export function assaultReady(o: Pick<Outgoing, "sentAt">, ai: boolean, now = Date.now()): boolean {
  return now >= o.sentAt + assaultNoticeSec(ai) * 1000;
}

/** 短いレイド出撃が可能になるまでの残り待ち秒数（出撃可能なら 0）。 */
export function assaultLeft(o: Pick<Outgoing, "sentAt">, ai: boolean, now = Date.now()): number {
  return Math.max(0, Math.ceil((o.sentAt + assaultNoticeSec(ai) * 1000 - now) / 1000));
}
