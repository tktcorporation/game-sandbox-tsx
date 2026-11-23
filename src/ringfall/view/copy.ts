/**
 * Player-visible copy — single source of truth (docs/ringfall/glossary.md).
 *
 * Every UI string for a defined term must come from here (or helpers below).
 * Live wording is unchanged until a 【元/案/理由】 rename is approved; proposals
 * are documented in glossary.md only.
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
  | "fortify"
  | "fortifyCore"
  | "captureCore"
  | "sendToWarehouse"
  | "cutAndExtract"
  | "returningAlive"
  | "arrivedAtWarehouse"
  | "takeBack"
  | "backToCamp"
  | "hideout"
  | "ownRobots"
  | "islandNews"
  | "nightRaid"
  | "wares"
  | "questsAndRecords"
  | "loadout"
  | "seaIslands"
  | "island";

/**
 * Canonical place / action words as the game shows them today.
 * Prefer these in new UI. Synonym cleanups are proposals in glossary.md —
 * do not change a value here without an approved 【元/案/理由】.
 */
export const TERM = {
  camp: "野営地",
  mapTable: "地図の机",
  questBoard: "依頼板",
  stashShelf: "倉庫の棚",
  traderStall: "商人の屋台",
  /** World label + panel head for the hideout station. */
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
  raiseLevel: "次の段を上げる",
  raiseLevelReady: "次の段を上げられる",
  fortify: "固める",
  fortifyCore: "核 · 固める",
  captureCore: "核 · 制圧",
  sendToWarehouse: "倉庫へ送る",
  cutAndExtract: "切り上げて生還",
  returningAlive: "生還中",
  arrivedAtWarehouse: "倉庫へ届いた",
  takeBack: "取り返す",
  backToCamp: "野営地に戻る",
  /** Modules collectively (医務室・作業台…). Not the station name. */
  hideout: "隠れ家",
  ownRobots: "自軍のロボット",
  islandNews: "島の知らせ",
  nightRaid: "夜の襲撃",
  wares: "売り物",
  questsAndRecords: "依頼と記録",
  loadout: "持っていく物",
  seaIslands: "海の向こうの島",
  island: "島",
} as const satisfies Record<TermId, string>;

/**
 * Full live phrases as shown today (including known inconsistencies).
 * Wiring UI through these keeps pixels identical until renames are approved.
 */
export const PHRASE = {
  /** Live tip still says 工房 — proposal: 作業場 (glossary). */
  nextWorkshopRaise: "次：工房 · 次の段を上げる",
  nextFactoryRaise: `${TERM.nextHand}${TERM.factory} · ${TERM.raiseLevel}`,
  nextMapFortifyIncoming: `${TERM.nextHand}${TERM.mapTable} · ${TERM.incomingExpedition}を${TERM.fortify}`,
  nextVehicleOrGate: `${TERM.nextHand}${TERM.vehicle}か${TERM.gate}から${TERM.sortie}`,
  nextQuestPick: `${TERM.nextHand}${TERM.questBoard} · 依頼を選ぶ`,
  nextQuestDeliver: `${TERM.nextHand}${TERM.questBoard} · 納品する`,
  sortieDo: `${TERM.sortie}する`,
  factoryRaiseReady: `${TERM.factory} · ${TERM.raiseLevelReady}`,
  /** Side column title when workshop is open — proposal: 作業場. */
  sideWorkshop: "隠れ家",
  sideFactory: TERM.ownRobots,
  islandGuardVia: `の${TERM.islandGuard}に回る`,
  islandGuardWent: `の${TERM.islandGuard}に回った`,
  /** Live capture prompt — 「を始める」 is part of the line today. */
  captureStart: `${TERM.captureCore}を始める`,
} as const;

export function nextFront(name: string): string {
  return `${TERM.nextHand}${TERM.vehicle}から${TERM.sortie} · ${TERM.front}：${name}`;
}

export function nextTakeBack(name: string): string {
  return `${TERM.nextHand}${TERM.vehicle}から${TERM.sortie} · ${name}を${TERM.takeBack}`;
}

export function moduleRaiseReady(moduleName: string): string {
  return `${moduleName} · ${TERM.raiseLevelReady}`;
}

export function relayOf(poiName: string): string {
  return `${poiName}の${TERM.relayBox}`;
}

/**
 * Hard-banned in UI sources: internal jargon / English. Lint fails.
 */
export const BANNED: { bad: string; keep: TermId; note: string }[] = [
  { bad: "デポ", keep: "relayBox", note: "brief は中継ボックス" },
  { bad: "depot", keep: "relayBox", note: "内部英名をプレイヤーに出さない" },
  { bad: "parcel", keep: "islandGuard", note: "島の守り" },
  { bad: "pad", keep: "core", note: "発着場は拠点名で出す" },
];

/**
 * Known synonyms still live in PHRASE / elsewhere until a rename is approved.
 * Lint warns (does not fail) when these appear as raw literals outside copy.ts.
 */
export const PENDING_SYNONYMS: { bad: string; keep: TermId; note: string }[] = [
  { bad: "工房", keep: "workshop", note: "tip のみ。世界印は作業場" },
];

/** TERM + PHRASE string values, longest first — for lint. */
export const COPY_VALUES = [...Object.values(TERM), ...Object.values(PHRASE)].sort((a, b) => b.length - a.length);
