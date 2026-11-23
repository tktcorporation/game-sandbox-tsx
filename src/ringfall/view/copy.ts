/**
 * Player-visible copy — single source of truth (docs/ringfall/glossary.md).
 *
 * Every UI string for a defined term must come from here (or helpers below).
 * Renames go through 【元/案/理由】 in glossary.md, then change values here.
 *
 * Lint: `npm run lint:ringfall-copy` — fails on banned synonyms and on raw
 * literals of TERM / PHRASE values outside this file and the allowlist.
 */

/** Stable ids for player-facing place / action terms (one concept = one id). */
export type TermId =
  | "camp"
  | "mapTable"
  | "questBoard"
  | "stashShelf"
  | "traderStall"
  | "workshop"
  | "factory"
  | "signal"
  | "vehicle"
  | "gate"
  | "relayBox"
  | "warehouse"
  | "islandGuard"
  | "incomingExpedition"
  | "expedition"
  | "core"
  | "front"
  | "sortie"
  | "nextHand"
  | "raiseLevel"
  | "raiseLevelReady"
  | "nextLevel"
  | "lastLevel"
  | "fortify"
  | "fortifyCore"
  | "captureCore"
  | "sendToWarehouse"
  | "cutAndExtract"
  | "returningAlive"
  | "arrivedAtWarehouse"
  | "attack"
  | "sendExpedition"
  | "backToCamp"
  | "hideout"
  | "islandNews"
  | "nightRaid"
  | "wares"
  | "questsAndRecords"
  | "loadout"
  | "seaIslands"
  | "island"
  | "trophy"
  | "shortRaid";

/**
 * Canonical place / action words as the game shows them.
 * Prefer these in new UI. Change a value only with an approved 【元/案/理由】.
 */
export const TERM = {
  camp: "野営地",
  mapTable: "地図の机",
  questBoard: "依頼板",
  stashShelf: "倉庫の棚",
  traderStall: "商人の屋台",
  /** World label + panel head/side for the hideout station. */
  workshop: "作業場",
  factory: "工場",
  signal: "信号所",
  vehicle: "車両",
  gate: "門",
  relayBox: "中継ボックス",
  warehouse: "倉庫",
  islandGuard: "島の守り",
  incomingExpedition: "来る遠征",
  expedition: "遠征",
  core: "核",
  front: "前線",
  sortie: "出撃",
  nextHand: "次：",
  /** One-line change if the user prefers another verb (glossary). */
  raiseLevel: "レベルを上げる",
  raiseLevelReady: "レベルを上げられる",
  nextLevel: "次のレベル",
  lastLevel: "最後のレベル",
  fortify: "固める",
  fortifyCore: "核 · 固める",
  captureCore: "核 · 制圧",
  sendToWarehouse: "倉庫へ送る",
  cutAndExtract: "切り上げて生還",
  returningAlive: "生還中",
  arrivedAtWarehouse: "倉庫へ届いた",
  /**
   * Map attack on a rival hold / neighbour front (E4). Was 取り返す.
   * 【元】取り返す 【案】攻める — docs/ringfall/glossary.md (adopted).
   */
  attack: "攻める",
  /**
   * Legacy expedition verb (signal-station button removed under E4).
   * 【元】送る 【案】遠征に出す — adopted, then button abolished.
   * 倉庫へ送る is TERM.sendToWarehouse; BANNED 「送る」 is exact-match only.
   */
  sendExpedition: "遠征に出す",
  backToCamp: "野営地に戻る",
  /** Modules collectively (医務室・作業台…). Not the station name. */
  hideout: "隠れ家",
  islandNews: "島の知らせ",
  nightRaid: "夜の襲撃",
  wares: "売り物",
  questsAndRecords: "依頼と記録",
  loadout: "持っていく物",
  seaIslands: "海の向こうの島",
  island: "島",
  /** Ranking T1 — signal station / map table. */
  trophy: "トロフィー",
  /**
   * X2 short raid onto a neighbour island's subset (§5.8).
   * 【元】（なし・写し全体） 【案】短いレイド 【理由】段階6を避けつつ他島へ攻めに行く感。
   */
  shortRaid: "短いレイド",
} as const satisfies Record<TermId, string>;

/** Full live phrases built from TERM. */
export const PHRASE = {
  nextWorkshopRaise: `${TERM.nextHand}${TERM.workshop} · ${TERM.raiseLevel}`,
  nextFactoryRaise: `${TERM.nextHand}${TERM.factory} · ${TERM.raiseLevel}`,
  nextMapFortifyIncoming: `${TERM.nextHand}${TERM.mapTable} · ${TERM.incomingExpedition}を${TERM.fortify}`,
  nextVehicleOrGate: `${TERM.nextHand}${TERM.vehicle}か${TERM.gate}から${TERM.sortie}`,
  nextQuestPick: `${TERM.nextHand}${TERM.questBoard} · 依頼を選ぶ`,
  nextQuestDeliver: `${TERM.nextHand}${TERM.questBoard} · 納品する`,
  sortieDo: `${TERM.sortie}する`,
  factoryRaiseReady: `${TERM.factory} · ${TERM.raiseLevelReady}`,
  sideWorkshop: TERM.workshop,
  sideFactory: TERM.factory,
  islandGuardVia: `の${TERM.islandGuard}に回る`,
  islandGuardWent: `の${TERM.islandGuard}に回った`,
  /** Live capture prompt — 「を始める」 is part of the line today. */
  captureStart: `${TERM.captureCore}を始める`,
} as const;

/** Toast after confirming 遠征に出す (past of TERM.sendExpedition). */
export function expeditionSentTo(place: string): string {
  return `${place}へ遠征に出した`;
}

export function nextFront(name: string): string {
  return `${TERM.nextHand}${TERM.vehicle}から${TERM.sortie} · ${TERM.front}：${name}`;
}

/** First sessions: same as nextFront, with 核 · 制圧 so the line's middle is named. */
export function nextFrontCapture(name: string): string {
  return `${TERM.nextHand}${TERM.vehicle}から${TERM.sortie} · ${TERM.front}：${name} · ${TERM.captureCore}`;
}

/** Next-hand line for a rival hold on the front (E4: 攻める). */
export function nextAttack(name: string): string {
  return `${TERM.nextHand}${TERM.vehicle}から${TERM.sortie} · ${name}を${TERM.attack}`;
}

/** Gap A / X2: notice posted (same vocabulary as 来る遠征). */
export function assaultNoticeTo(name: string): string {
  return `${name}へ${TERM.incomingExpedition}の予告を立てた`;
}

/** Gap A / X2: still inside the notice window. */
export function assaultWaitHours(name: string, hours: number): string {
  return `${name}を${TERM.attack} · あと約 ${hours} 時間（${TERM.incomingExpedition}と同じ予告）`;
}

/**
 * X2 ready but the target cannot be raided (fortified / taken / no view).
 * 【元】（なし） 【案】〜は固められていて攻められない 【理由】来る遠征と同じ「固める」語で拒否理由を出す。
 */
export function assaultFortified(name: string): string {
  return `${name}は${TERM.fortify}られていて攻められない`;
}

/** Next-hand while an X2 assault is in its notice window. */
export function nextAssaultWait(name: string, hours: number): string {
  return `${TERM.nextHand}${name}を${TERM.attack} · 予告 あと約 ${hours} 時間`;
}

/** Next-hand when the X2 short raid may start. */
export function nextShortRaid(name: string): string {
  return `${TERM.nextHand}${TERM.vehicle}から${TERM.shortRaid} · ${name}を${TERM.attack}`;
}

export function moduleRaiseReady(moduleName: string): string {
  return `${moduleName} · ${TERM.raiseLevelReady}`;
}

export function relayOf(poiName: string): string {
  return `${poiName}の${TERM.relayBox}`;
}

/**
 * Hard-banned in UI sources. Lint fails.
 * Adopted synonyms from glossary live here (not in PENDING).
 */
export const BANNED: { bad: string; keep: TermId; note: string }[] = [
  { bad: "デポ", keep: "relayBox", note: "brief は中継ボックス" },
  { bad: "depot", keep: "relayBox", note: "内部英名をプレイヤーに出さない" },
  { bad: "parcel", keep: "islandGuard", note: "島の守り" },
  { bad: "pad", keep: "core", note: "発着場は拠点名で出す" },
  { bad: "工房", keep: "workshop", note: "画面ラベルは作業場" },
  { bad: "自軍のロボット", keep: "factory", note: "側タイトルも工場" },
  { bad: "次の段を上げる", keep: "raiseLevel", note: "レベルを上げる" },
  { bad: "次の段を上げられる", keep: "raiseLevelReady", note: "レベルを上げられる" },
  { bad: "段を上げる", keep: "raiseLevel", note: "レベルを上げる" },
  { bad: "遠征の知らせ", keep: "islandNews", note: "島の知らせに統合" },
  { bad: "仕返し", keep: "attack", note: "地図で攻める（E4）。信号所ボタンは置かない" },
  { bad: "取り返す", keep: "attack", note: "攻めるに統合（E4）" },
  /**
   * Exact match only in lint (送る ⊂ 倉庫へ送る). 中継ボックスの「倉庫へ送る」は別 TERM.
   */
  { bad: "送る", keep: "sendExpedition", note: "旧・遠征に出す。倉庫へ送るは別語。ボタンは廃止" },
];

/**
 * Pending renames (glossary 【元/案/理由】). Lint warns only after TERM[keep] no longer equals
 * `bad` (so the live SoT can keep the old word until approval). Nested-in-other-TERM bad
 * words use exact match (same as BANNED) so 倉庫へ送る is never flagged for 送る.
 */
export const PENDING_SYNONYMS: { bad: string; keep: TermId; note: string }[] = [];

/** TERM + PHRASE string values, longest first — for lint. */
export const COPY_VALUES = [...Object.values(TERM), ...Object.values(PHRASE)].sort((a, b) => b.length - a.length);
