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
 * 出撃地図から即座に短いレイドへ出撃可能（事前予告の待ち時間なし）。
 * レイドでの制圧成功（assaultWon）または失敗（assaultLost）を記録し、
 * 相手サーバーへの報告完了（assaultAcked）または拒否（assaultWinRejected）まで状態を追跡する。
 *
 * 関連仕様: docs/ringfall/glossary.md, docs/ringfall/pvp-clarity.md
 * （※純粋関数群であり、クライアントバンドルから worker を import してはならない）
 */
import { expeditionsOut, type Outgoing } from "./expeditions";
import type { NodeId } from "../sim/map";

/* =========================================================================
 * 出撃エントリの取得・作成・勝敗更新・報告追跡
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
 * 出撃可否（待ち時間なし: 常に即出撃）
 * ========================================================================= */

/** 短いレイド出撃までの事前猶予秒数。反応型守りの予告待ちは廃止済み: 常に 0。 */
export const assaultNoticeSec = (_ai: boolean): number => 0;

/** 短いレイドへ出撃可能か。待ち時間なしのため常に true。 */
export function assaultReady(_o: Pick<Outgoing, "sentAt">, _ai: boolean, _now = Date.now()): boolean {
  return true;
}

/** 短いレイド出撃までの残り待ち秒数。待ち時間なしのため常に 0。 */
export function assaultLeft(_o: Pick<Outgoing, "sentAt">, _ai: boolean, _now = Date.now()): number {
  return 0;
}
