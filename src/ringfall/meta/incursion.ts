/*
 * 他島への短いレイド（Short Raid / 攻める）のステージ構築モジュール。
 *
 * プレイヤーがお隣の島（他プレイヤーまたはAI）へ出撃する際、相手島全体を模倣するのではなく、
 * ターゲット拠点およびその周辺（最大2ノード）のみを「ライバル占有」として切り出し、
 * 短時間で「核 · 制圧」と「防衛物資の奪取」を行う舞台（IncursionPlan）を構築する。
 *
 * 責務の分離:
 *   - 本モジュール（incursion.ts）: 短いレイドのステージ構築（IncursionPlan）、防衛物資（Parcel）の切り出し。
 *     （Profile.incursionTaken や Settlement.incursion などの永続データ構造に対応）
 *   - assault.ts: 短いレイド出撃エントリ（Outgoing）の管理、勝敗確定、保留報告、トロフィー計算。
 *     （POST /api/islands/:code/assault API に対応）
 *
 * 関連仕様: docs/ringfall/glossary.md, docs/ringfall/pvp-clarity.md
 * （※純粋関数群であり、Start.incursion を設定しない自島レイドのシミュレーション決定性には影響しない）
 */
import type { ValuableKind } from "../sim/config";
import { rivalHold, type PoiHold } from "../sim/holds";
import { DEPOTS, ENTRIES, FRONT_LINKS, NODES, POIS, nodeIndex, poiRegion, regionOf, type EntryId, type NodeId, type PoiId, type RegionId } from "../sim/map";
import type { IslandView } from "./expeditions";
import type { Parcel } from "./parcels";
import { LOCAL_AID } from "./parcels";
import type { AiIsland } from "./ai-islands";

/** 短いレイド（Short Raid）のステージに標的以外に残す隣接ノードの最大数。 */
export const SHORT_RAID_EXTRA = 2;

/**
 * 短いレイドの標的拠点を決定する。
 * 希望の拠点（prefer）が解放中ならそれを優先し、なければ最も近い解放済み拠点を返す。
 * 新規島保護中や解放拠点が1つもない場合は null。
 */
export function shortRaidTarget(view: Pick<IslandView, "nodes" | "protectedUntil">, prefer: NodeId, now = Date.now()): NodeId | null {
  if (islandProtected(view, now)) return null;
  const open = view.nodes.filter((n) => n.hold === "own" && n.open && nodeIndex(n.id) >= 0);
  if (!open.length) return null;
  if (open.some((n) => n.id === prefer)) return prefer;
  const t = NODES[nodeIndex(prefer)];
  open.sort((a, b) => {
    const na = NODES[nodeIndex(a.id)];
    const nb = NODES[nodeIndex(b.id)];
    return Math.hypot(na.x - t.x, na.z - t.z) - Math.hypot(nb.x - t.x, nb.z - t.z);
  });
  return open[0]!.id as NodeId;
}

/** 他島への短いレイド開始に必要なパラメータ（コピーの占有状態、ターゲット、防衛物資など）。 */
export interface IncursionPlan {
  code: string;
  owner: string;
  target: NodeId;
  region: RegionId;
  entry: EntryId;
  /** コピー上の各拠点状態: ステージノードは rival:…、その他は自分側（own）。 */
  island: Partial<Record<PoiId, PoiHold>>;
  /** コピー上に配置された防衛物資（制圧時に「倉庫へ届いた」として獲得）。 */
  parcels: Parcel[];
  /** ステージ上に残す拠点IDリスト（標的が先頭）。 */
  stage: NodeId[];
}

/** 相手島が新規プレイヤー保護期間中（`protectedUntil > now`）かどうか。 */
export const islandProtected = (v: Pick<IslandView, "protectedUntil">, now = Date.now()): boolean =>
  !!v.protectedUntil && v.protectedUntil > now;

/** レイド内での対戦相手ID文字列を生成（AIなら `ai-${code}`、実プレイヤーなら島コード）。 */
export const incursionOwnerId = (code: string, ai: boolean): string => (ai ? `ai-${code}` : code);

/**
 * 短いレイドのステージ範囲を決定する。
 * 標的拠点に加え、相手が保持する接続隣接ノードを距離順に最大 `extra` 個（既定2個）選定する。
 */
export function stageNodes(view: Pick<IslandView, "nodes">, target: NodeId, extra = SHORT_RAID_EXTRA, forceOpen?: NodeId): NodeId[] {
  const ownerHeld = new Set(
    view.nodes.filter((n) => n.hold === "own" && (n.open || n.id === forceOpen)).map((n) => n.id),
  );
  if (!ownerHeld.has(target)) return [];
  const t = NODES[nodeIndex(target)];
  const linked = FRONT_LINKS.flatMap(([a, b]) => {
    // FRONT_LINKS のタプルは [camp | NodeId, NodeId] なので a のみ "camp" を除外する
    if (a === target && ownerHeld.has(b)) return [b];
    if (b === target && a !== "camp" && ownerHeld.has(a)) return [a];
    return [];
  });
  linked.sort((a, b) => {
    const na = NODES[nodeIndex(a)];
    const nb = NODES[nodeIndex(b)];
    return Math.hypot(na.x - t.x, na.z - t.z) - Math.hypot(nb.x - t.x, nb.z - t.z);
  });
  return [target, ...linked.slice(0, Math.max(0, extra))];
}

/**
 * 短いレイド用コピー島の拠点占有マップを生成する。
 * `stage` ノードのみを相手保持（rival:owner）とし、他の非ボスノードは自分側（own = 敵なし）にして
 * 数拠点のみに絞った戦場を形成する。タイタン発射台（pad）は敵（foe）のまま。
 */
export function shortRaidIsland(ownerId: string, stage: readonly NodeId[]): Partial<Record<PoiId, PoiHold>> {
  const on = new Set(stage);
  const out: Partial<Record<PoiId, PoiHold>> = {};
  for (const p of POIS) {
    if (p.boss) {
      out[p.id] = "foe";
      continue;
    }
    out[p.id] = on.has(p.id as NodeId) ? rivalHold(ownerId) : "own";
  }
  return out;
}

/** 対象拠点の地域に対応する進入路（既知のものを優先）を返す。 */
export function entryForTarget(target: NodeId, known: readonly EntryId[] = []): EntryId {
  const region = poiRegion(target);
  const prefer = region.entries.find((e) => known.includes(e));
  return prefer ?? region.entries[0] ?? ENTRIES[0].id;
}

/** 指定拠点に配備されている防衛物資（Parcel）を抽出する。 */
export function parcelsAt(view: Pick<IslandView, "parcels">, poi: PoiId): Parcel[] {
  return (view.parcels ?? []).filter((q) => q.poi === poi);
}

/**
 * AI島が保持している防衛物資を日付やソルトから決定論的に生成する。
 * `taken` に含まれる既奪取物資は除外される。
 */
export function aiDefenceParcels(a: AiIsland, salt: number, day: number, held: readonly NodeId[], taken: readonly number[] = []): Parcel[] {
  const gone = new Set(taken);
  // 中継ボックスの通常素材プールと同じ
  const pool: ValuableKind[] = ["parts", "fuse", "board"];
  const out: Parcel[] = [];
  held.forEach((id, n) => {
    if (!DEPOTS.some((d) => d.poi === id)) return;
    const pid = 1 + ((Math.imul(salt ^ 0x85ebca6b, a.slot + 1) >>> 0) % 90_000) + n;
    if (gone.has(pid)) return;
    const kind = pool[(Math.imul(salt + day, nodeSalt(id) + 1) >>> 0) % pool.length]!;
    out.push({ id: pid, poi: id, kind, from: { code: LOCAL_AID, name: a.name }, at: 0 });
  });
  return out;
}

const nodeSalt = (id: string) => {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0;
  return h >>> 0;
};

/**
 * 短いレイド（Short Raid）の出撃計画を生成する。
 * 相手の解放拠点の中から対象拠点および隣接拠点のみをステージとして抽出し、防衛物資を切り出す。
 * 保護期間中、対象が閉鎖中、または相手が保持していない場合は null。
 */
export function planShortRaid(
  view: IslandView,
  target: string,
  opts: { ai: boolean; known?: readonly EntryId[]; extra?: number; /** 自身の出撃予告が占有中であっても計画を立てる */ ignoreBusy?: boolean } = { ai: false },
): IncursionPlan | null {
  if (islandProtected(view)) return null;
  const node = NODES.find((n) => n.id === target);
  if (!node) return null;
  const slot = view.nodes.find((n) => n.id === target);
  if (!slot || slot.hold !== "own") return null;
  // 相手島ノードは遠征中（自身の襲撃含む）に閉鎖されるため、ignoreBusy で自身の分を許可できる
  if (!slot.open && !opts.ignoreBusy) return null;
  const stage = stageNodes(view, node.id, opts.extra ?? SHORT_RAID_EXTRA, opts.ignoreBusy ? node.id : undefined);
  if (!stage.length) return null;
  const ownerId = incursionOwnerId(view.code, opts.ai);
  const island = shortRaidIsland(ownerId, stage);
  const parcels = stage.flatMap((id) => parcelsAt(view, id));
  return {
    code: view.code,
    owner: view.owner,
    target: node.id,
    region: regionOf(node.region).id,
    entry: entryForTarget(node.id, opts.known),
    island,
    parcels,
    stage,
  };
}

/** 過去にその島から奪取済みの防衛物資IDリストを取得する（セーブデータ管理用）。 */
export function takenOn(list: readonly { code: string; ids: number[] }[] | undefined, code: string): number[] {
  return list?.filter((e) => e.code === code).flatMap((e) => e.ids) ?? [];
}

/** 新たに奪取した防衛物資IDをセーブデータへマージ追記する。 */
export function withTaken(
  list: readonly { code: string; ids: number[] }[] | undefined,
  code: string,
  ids: readonly number[],
): { code: string; ids: number[] }[] {
  if (!ids.length) return list ? [...list] : [];
  const out = [...(list ?? [])];
  const i = out.findIndex((e) => e.code === code);
  if (i < 0) return [...out, { code, ids: [...ids] }];
  const set = new Set([...out[i]!.ids, ...ids]);
  out[i] = { code, ids: [...set] };
  return out;
}

/* =========================================================================
 * レガシー: 廃止された全島ミラー形式（テスト・旧仕様比較用）
 * ========================================================================= */

/**
 * （レガシー全島ミラー用ヘルパー）
 * 相手島の保持ノードをすべて rival:owner としてマップ化する。
 * 現在の短いレイドでは使用せず、`shortRaidIsland` を使用する。
 */
export function viewToRaidIsland(view: Pick<IslandView, "code" | "nodes">, ownerId: string): Partial<Record<PoiId, PoiHold>> {
  const out: Partial<Record<PoiId, PoiHold>> = {};
  for (const p of POIS) {
    if (p.boss) {
      out[p.id] = "foe";
      continue;
    }
    const n = view.nodes.find((x) => x.id === p.id);
    out[p.id] = n?.hold === "own" ? rivalHold(ownerId) : "foe";
  }
  return out;
}

/**
 * （レガシー全島ミラー計画）
 * 短いレイドには `planShortRaid` を使用すること。
 */
export function planIncursion(
  view: IslandView,
  target: string,
  opts: { ai: boolean; known?: readonly EntryId[] } = { ai: false },
): IncursionPlan | null {
  if (islandProtected(view)) return null;
  const node = NODES.find((n) => n.id === target);
  if (!node) return null;
  const slot = view.nodes.find((n) => n.id === target);
  if (!slot?.open) return null;
  const ownerId = incursionOwnerId(view.code, opts.ai);
  const island = viewToRaidIsland(view, ownerId);
  const parcels = parcelsAt(view, node.id);
  return {
    code: view.code,
    owner: view.owner,
    target: node.id,
    region: regionOf(node.region).id,
    entry: entryForTarget(node.id, opts.known),
    island,
    parcels,
    stage: [],
  };
}
