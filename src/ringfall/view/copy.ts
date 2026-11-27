/**
 * Player-visible copy — single source of truth (docs/ringfall/glossary.md).
 *
 * Every UI string for a defined term must come from here (or helpers below).
 * Renames go through 【元/案/理由】 in glossary.md, then change values here.
 *
 * Lint: `npm run lint:ringfall-copy` — fails on banned synonyms and on raw
 * literals of TERM / PHRASE values outside this file and the allowlist.
 */
import { leagueOf } from "../meta/trophies";

/** Stable ids for player-facing place / action terms (one concept = one id). */
export type TermId =
  | "camp"
  | "stashShelf"
  | "traderStall"
  | "workshop"
  | "factory"
  | "signal"
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
  | "captureCore"
  | "sendToWarehouse"
  | "cutAndExtract"
  | "returningAlive"
  | "arrivedAtWarehouse"
  | "attack"
  | "contest"
  | "revenge"
  | "today"
  | "shielding"
  | "lostToday"
  | "sendExpedition"
  | "backToCamp"
  | "hideout"
  | "islandNews"
  | "wares"
  | "loadout"
  | "seaIslands"
  | "island"
  | "trophy"
  | "league"
  | "organize"
  | "broughtHome"
  | "putInWarehouse"
  | "confirmOrganize"
  | "whereFound"
  | "seeOnMap"
  | "setGoal"
  | "goalActive"
  | "goal"
  | "landed";

/**
 * Canonical place / action words as the game shows them.
 * Prefer these in new UI. Change a value only with an approved 【元/案/理由】.
 */
export const TERM = {
  camp: "野営地",
  stashShelf: "倉庫の棚",
  traderStall: "商人の屋台",
  /** World label + panel head/side for the hideout station. */
  workshop: "作業場",
  factory: "工場",
  signal: "信号所",
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
   * Contested coastal hub not yet held by anyone (TKT-204 案 A).
   * 【元】（なし） 【案】取り合う 【理由】誰と取り合う拠点かを先に見せる
   */
  contest: "取り合う",
  /**
   * Defence-log → attack (TKT-204 案 F / CoC revenge).
   * 【元】（なし）／仕返し 【案】やり返す 【理由】取られた行から攻め先へ
   */
  revenge: "やり返す",
  /** The calendar day the player is on (glossary.md 日 / 今日). No count of days is shown. */
  today: "今日",
  /**
   * Island-wide shield after an outer hub is taken (作り順③).
   * 【元】（なし）／保護中（新規島） 【案】守り中 【理由】取られたあとの島全体の盾。新規保護と語を分けず「守り」に寄せる
   */
  shielding: "守り中",
  /**
   * Loss-cap readout for outer hubs (作り順③).
   * 【元】（なし） 【案】今日取られた 【理由】喪失上限が見える。内部名は出さない
   */
  lostToday: "今日取られた",
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
  wares: "売り物",
  loadout: "持っていく物",
  /**
   * 信号所の側見出し。カード見出し「お隣の島」と同じ語に揃える。
   * 【元】海の向こうの島 【案】お隣の島 【理由】同じパネルで別名をやめる
   */
  seaIslands: "お隣の島",
  island: "島",
  /** Ranking T1 — signal station / results. */
  trophy: "トロフィー",
  /**
   * Trophy band label (CoC league; display from day 1).
   * 【元】（なし） 【案】リーグ 【理由】帯の名前の見出し。数値帯は trophies.leagueOf
   */
  league: "リーグ",
  /**
   * Post-raid stash tidy (モンハンの報酬画面にあたる).
   * 【元】（なし） 【案】倉庫の整理 【理由】倉庫・倉庫の棚と同じ語でつなぐ
   */
  organize: "倉庫の整理",
  /** Results / organize column for items that came home this raid. */
  broughtHome: "持ち帰った物",
  /** Organize action: move a pending item into the stash. */
  putInWarehouse: "倉庫に入れる",
  /** Organize confirm (enabled when pending is empty). */
  confirmOrganize: "確定",
  /** Entry on a material row to open sources. */
  whereFound: "どこで取れる",
  /** Sources → set that valuable as the goal and open the departure map on that POI. */
  seeOnMap: "地図で見る",
  /** Mark a valuable as the hunt target. */
  setGoal: "目標にする",
  /**
   * Shown instead of 目標にする while that valuable is already the hunt target.
   * 【元】目標にする（押しても状態が分からない） 【案】目標にしている 【理由】いまの目標が一目で分かる
   */
  goalActive: "目標にしている",
  /** Raid toast / map prefix for the hunt target. */
  goal: "目標",
  /**
   * Landing banner verb after the region name.
   * 【元】（なし） 【案】に着いた 【理由】着地で今いる地域を言う
   */
  landed: "に着いた",
} as const satisfies Record<TermId, string>;

/** Full live phrases built from TERM. */
export const PHRASE = {
  nextWorkshopRaise: `${TERM.nextHand}${TERM.workshop} · ${TERM.raiseLevel}`,
  nextFactoryRaise: `${TERM.nextHand}${TERM.factory} · ${TERM.raiseLevel}`,
  /** Departure opens only at the gate (車両 deleted 2026-11-24). */
  nextGate: `${TERM.nextHand}${TERM.gate}から${TERM.sortie}`,
  sortieDo: `${TERM.sortie}する`,
  factoryRaiseReady: `${TERM.factory} · ${TERM.raiseLevelReady}`,
  sideWorkshop: TERM.workshop,
  sideFactory: TERM.factory,
  islandGuardVia: `の${TERM.islandGuard}に回る`,
  islandGuardWent: `の${TERM.islandGuard}に回った`,
  /** Live capture prompt — 「を始める」 is part of the line today. */
  captureStart: `${TERM.captureCore}を始める`,
  /**
   * Trader / shelves when the warehouse is full and another level exists.
   * 【元】倉庫が満杯：売るか、倉庫の棚で倉庫を上げる
   * 【案】倉庫が満杯：売るか、作業場で倉庫を上げる
   * 【理由】上げる入口を作業場に一本化した（屋台の満杯案内も同じ）
   */
  warehouseFullRaise: `${TERM.warehouse}が満杯：売るか、${TERM.workshop}で${TERM.warehouse}を上げる`,
  /** Shelves when full at the top warehouse level (sell only). */
  warehouseFullSell: `${TERM.warehouse}が満杯：売る`,
  /**
   * Results line when overflow waits for 倉庫の整理 (no silent sale).
   * 【元】倉庫に入らなかった n 点 …クレジット
   * 【案】倉庫に入りきらない n 点 · 倉庫の整理
   * 【理由】売ったのではなく、これから選ぶことを示す
   */
  stashOverflowOrganize: `${TERM.warehouse}に入りきらない`,
  /** Next hand while pending remains. */
  nextOrganize: `${TERM.nextHand}${TERM.stashShelf} · ${TERM.organize}`,
  /** Results / news after organize sold chosen items. */
  organizeSold: `${TERM.organize}で売った`,
  /**
   * Depot tip when the stash has no free slots.
   * 【元】（なし） 【案】中継ボックス · 倉庫が満杯
   * 【理由】送れないことをその場で。「倉庫が満杯」は商人の屋台で使っている語
   */
  relayWarehouseFull: `${TERM.relayBox} · ${TERM.warehouse}が満杯`,
  /** Partial depot send: rest stayed in the bag. */
  bagKept: "点はバッグに残った",
} as const;

/**
 * Landing banner when a hunt goal is set: 「ダム湖に着いた」.
 * 【元】入口名だけ 【案】{地域}に着いた 【理由】目標の地域と揃える
 */
export const landedIn = (region: string) => `${region}${TERM.landed}`;

/**
 * Landing banner sub: 「タイタンは発着場（474 m）」.
 * 【元】（なし） 【案】{入手先}は{拠点}（○ m） 【理由】着地で目標までの距離
 */
export const goalIsAt = (where: string, place: string, metres: number) => `${where}は${place}（${metres} m）`;

/**
 * Compass mark when hunting: 「タイタン 474m」.
 * 【元】距離だけ 【案】{入手先} ○m 【理由】何へ向かうか分かる
 */
export const goalCompass = (where: string, metres: number) => `${where} ${metres}m`;

/** Toast after confirming 遠征に出す (past of TERM.sendExpedition). */
export function expeditionSentTo(place: string): string {
  return `${place}へ遠征に出した`;
}

/**
 * 島の知らせ（来た遠征）の一語印。自分の遠征の印（EXP_OUT_WORD）と「全滅」を共有しない。
 * wiped = 相手の隊を撃退した／retaken = 核 · 制圧で戻した。
 */
export const LOG_WORD = {
  noticed: TERM.expedition,
  landed: "上陸",
  taken: "奪取",
  wiped: "撃退",
  retaken: "制圧",
  released: "手放し",
  recalled: "撤収",
} as const;

/**
 * 島の知らせ（自分の遠征の結果）の一語印。
 * wiped = 自分の隊が攻めきれなかった（相手を撃退した「撃退」と別語）。
 */
export const EXP_OUT_WORD = {
  held: "取った",
  wiped: "攻めきれず",
  lost: "失った",
} as const;

/** 今日の作戦・出撃の行名（同じ一手は同じ行名）。 */
export const PLAN_GOAL = "目的";

/** 信号所に残す島の知らせの件数（2026-11-24 決定）。 */
export const NEWS_KEEP = 10;

/**
 * お隣の拠点を制圧した／攻めきれなかった一行（リザルト／信号所）。
 * 【元】{お隣}の{拠点}を取った · トロフィー +n · 倉庫へ届く
 * 【案】{お隣}の{拠点}を制圧した · … 【理由】核のプロンプトと同じ攻めの物語（TKT-204 案 E）
 */
export function newsIncursion(owner: string, node: string, won: boolean, trop?: number): string {
  if (won) {
    const tropBit = trop != null && trop > 0 ? ` · ${TERM.trophy} +${trop}` : "";
    return `${owner}の${node}を制圧した${tropBit} · 倉庫へ届く`;
  }
  return `${owner}の${node}を攻めきれなかった`;
}

/**
 * Live core prompt for a rival-held hub (TKT-204 案 E).
 * 【元】E 核 · 制圧を始める 浄水場 【案】E ツバキの浄水場を攻める
 */
export function attackCapturePrompt(whoHub: string): string {
  return attackGoal(whoHub);
}

/**
 * Mid-capture / toast while holding a rival hub's core (TKT-204 案 E).
 * 【元】核 · 制圧 浄水場 【案】ツバキの浄水場を制圧
 */
export function attackCapturing(whoHub: string): string {
  return `${whoHub}を制圧`;
}

/**
 * Toast / result after seizing a rival hub (TKT-204 案 E).
 * 【元】制圧した · 浄水場 【案】ツバキの浄水場を制圧した
 */
export function attackSeized(whoHub: string): string {
  return `${whoHub}を制圧した`;
}

/**
 * トロフィーの前後と内訳（リザルト／信号所／起動時）。増減が無い側は出さない。
 * 【元】トロフィー {前} → {後}（取った +a · 取られた −b）
 * 【案】…（取った +a · 守りきった +d · 取られた −b）
 * 【理由】攻め／守りの内訳（design-direction トロフィーと物資）
 */
export function trophyLine(before: number, after: number, gained = 0, lost = 0, defended = 0, failed = 0): string {
  const parts: string[] = [];
  if (gained > 0) parts.push(`取った +${gained}`);
  if (defended > 0) parts.push(`守りきった +${defended}`);
  if (failed > 0) parts.push(`攻めきれず −${failed}`);
  if (lost > 0) parts.push(`取られた −${lost}`);
  const mid = parts.length ? `（${parts.join(" · ")}）` : "";
  return `${TERM.trophy} ${before.toLocaleString("ja-JP")} → ${after.toLocaleString("ja-JP")}${mid}`;
}

/**
 * Trophy header label with league band (day-1 surface).
 * 【元】トロフィー 【案】トロフィー · 銅 【理由】リーグ帯を常時見せる（開始 1000＝銅）
 */
export function trophyHead(trophies: number): string {
  return `${TERM.trophy} · ${leagueOf(trophies).name}`;
}

/** 島の知らせの控え: 新しい行を先頭に足し、最新 NEWS_KEEP 件だけ残す。 */
export function pushNews(prev: readonly string[], lines: readonly string[]): string[] {
  const fresh = lines.map((s) => s.trim()).filter(Boolean);
  if (!fresh.length) return prev.length ? [...prev] : [];
  return [...fresh, ...prev].slice(0, NEWS_KEEP);
}

/**
 * 起動時の一枚（留守中の対人）: 控えに増えた行のうち、トロフィー行は別枠、残りは島の知らせ。
 * 同じ文が二度入っても件数で差を取る（Set だと二度目が落ちる）。どちらも空なら null。
 */
export function awaySheetParts(
  beforeNews: readonly string[],
  afterNews: readonly string[],
): { lines: string[]; trop: string | null } | null {
  const left = new Map<string, number>();
  for (const l of beforeNews) {
    if (!l.trim()) continue;
    left.set(l, (left.get(l) ?? 0) + 1);
  }
  const fresh: string[] = [];
  for (const l of afterNews) {
    if (!l.trim()) continue;
    const n = left.get(l) ?? 0;
    if (n > 0) left.set(l, n - 1);
    else fresh.push(l);
  }
  if (!fresh.length) return null;
  const trop = fresh.find((l) => l.startsWith(TERM.trophy)) ?? null;
  const lines = trop ? fresh.filter((l) => l !== trop) : fresh;
  if (!lines.length && !trop) return null;
  return { lines, trop };
}

/** 島の知らせ: 核 · 制圧で拠点を戻した行（旧・取り返した）。 */
export function newsRetaken(at: string): string {
  return `${at}を制圧した · 倉庫へ届く`;
}

/**
 * 島の知らせ: 相手の攻めを守りきった行。
 * 【元】{拠点}で{誰}の遠征隊を撃退した
 * 【案】{誰}が{拠点}を攻めた · 守りきった
 * 【理由】相手の普段のレイドで攻められる。育てた守りが効いたことを言う（方向 A）
 */
export function newsWipedEnemy(at: string, who: string): string {
  return `${who}が${at}を${TERM.attack} · 守りきった`;
}

/** 自分の遠征の結果を一文に（信号所の title・控え）。 */
export function expOutLine(n: { t: keyof typeof EXP_OUT_WORD; name: string; node: string }): string {
  const at = n.node;
  if (n.t === "held") return `${n.name}の島の${at}を遠征隊が取った`;
  if (n.t === "wiped") return `${n.name}の島の${at}で遠征隊が攻めきれなかった`;
  return `${n.name}の島の${at}を失った`;
}

export function nextFront(name: string): string {
  return `${TERM.nextHand}${TERM.gate}から${TERM.sortie} · ${TERM.front}：${name}`;
}

/** First sessions: same as nextFront, with 核 · 制圧 so the line's middle is named. */
export function nextFrontCapture(name: string): string {
  return `${TERM.nextHand}${TERM.gate}から${TERM.sortie} · ${TERM.front}：${name} · ${TERM.captureCore}`;
}

/** Next-hand line for a rival hold on the front (E4: 攻める). */
export function nextAttack(name: string): string {
  return `${TERM.nextHand}${TERM.gate}から${TERM.sortie} · ${name}を${TERM.attack}`;
}

/**
 * Goal / 今日の作戦 / 出撃の目的 for a rival hub (TKT-204 案 D).
 * 【元】前線：浄水場 【案】ツバキの浄水場を攻める 【理由】野営と出撃を同じ言い方に
 */
export function attackGoal(whoHub: string): string {
  return `${whoHub}を${TERM.attack}`;
}

/**
 * Scout defence line under an 攻める row (TKT-204 案 B).
 * 【元】（なし） 【案】工場 Lv3 · 島の守り 1 【理由】CoC の攻撃前の守り要約
 */
export function attackScoutDef(factory: number, guard: number): string {
  return `${TERM.factory} Lv${factory} · ${TERM.islandGuard} ${guard}`;
}

/**
 * Island shield remaining time (作り順③).
 * 【元】（なし） 【案】守り中 · あと 3:24 【理由】残り時間が分かる（CoC の盾タイマー）
 */
export function shieldLine(remainMs: number): string {
  const sec = Math.max(0, Math.ceil(remainMs / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const clock = h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
  return `${TERM.shielding} · あと ${clock}`;
}

/**
 * Outer-hub loss cap readout (作り順③).
 * 【元】（なし） 【案】今日取られた 1/1 【理由】喪失上限が見える
 */
export function lostTodayLine(lost: number, cap: number): string {
  return `${TERM.lostToday} ${lost}/${cap}`;
}

/**
 * League band change on results (TKT-219).
 * 【元】（なし） 【案】リーグ · 銅 → 銀 【理由】昇格・降格が一目で分かる
 */
export function leagueChangeLine(from: string, to: string): string {
  return `${TERM.league} · ${from} → ${to}`;
}

/**
 * League win-bonus materials preview / results (TKT-219).
 * 【元】（なし） 【案】物資 +3 【理由】勝ちボーナスをトロフィーと分けて見せる
 */
export function winBonusMark(n: number): string {
  return `物資 +${n}`;
}

/**
 * Scout odds under an 攻める row (TKT-218).
 * 【元】トロフィー +32 【案】トロフィー +N / −M 【理由】取れば +N・失敗で −M を攻める前に見せる
 */
export function attackScoutTrop(win: number, lose: number): string {
  return `${TERM.trophy} +${win} / −${lose}`;
}

/**
 * Raid star + trophy delta on results (TKT-218).
 * 【元】（なし） 【案】★★☆ · トロフィー +20 【理由】星と増減をリザルトに出す
 */
export function raidStarsLine(stars: number, delta: number): string {
  const s = Math.max(0, Math.min(3, Math.round(stars)));
  const marks = `${"★".repeat(s)}${"☆".repeat(3 - s)}`;
  const signed = delta > 0 ? `+${delta}` : delta < 0 ? `−${-delta}` : "+0";
  return `${marks} · ${TERM.trophy} ${signed}`;
}

/**
 * First-time multiplayer guide cards (TKT-204 案 C / 2026-11-26 early-MP).
 * Shown at first camp (not only at the gate).
 */
export const MP_HOWTO_CARDS: readonly { title: string; body: string }[] = [
  {
    title: TERM.seaIslands,
    // 【元】お隣の島は最初から外側の拠点を攻めてくる。
    // 【案】地図にも最初から出る、を足す 【理由】初日可視化：隣島の存在を地図で先に見せる
    // 【元】…外側の拠点を攻めてくる。
    // 【案】島で占領した拠点を攻めてくる 【理由】攻められる場所＝占領した陣地（holdings-raid.md）
    body: `${TERM.seaIslands}は地図に最初から出る。留守のあいだ、島で占領した拠点を攻めてくる。`,
  },
  {
    title: TERM.attack,
    // 【元】「攻める」で相手の拠点を選んで出撃。…／前線の拠点
    // 【案】門の一覧を先に言う 【理由】攻めるリストが初日の入口だと分かる
    // 【元】門の「攻める」に相手の拠点が一覧で出る。取れば…
    // 【案】選ぶとその拠点へ短く攻めに行く、を足す 【理由】攻めは相手の島への短い出撃（holdings-raid.md）
    body: `門の「${TERM.attack}」に別プレイヤーの陣地が一覧で出る。選ぶとその拠点へ短く攻めに行く。取れば${TERM.trophy}が増える。`,
  },
  {
    title: TERM.captureCore,
    // 【元】相手の拠点を核 · 制圧すると…
    // 【案】相手の拠点の核を制圧すると… 【理由】ユーザー承認済み（TKT-218）
    body: `相手の拠点の核を制圧すると${TERM.trophy}が増える。取られたら${TERM.islandNews}から${TERM.revenge}。`,
  },
];

/** Guide next / done button labels (TKT-204 案 C). */
export const mpHowtoNext = (last: boolean): string => (last ? "分かった" : "次へ");

/** Re-export for view callers (canonical: meta/neighbours.ts). */
export { aiLabel } from "../meta/neighbours";

/** 拠点の収入 collected at the camp (glossary.md 拠点の収入): made by the clock at each holding. */
export function incomeLine(credits: number): string {
  return `拠点の収入 +${credits.toLocaleString("ja-JP")} クレジット`;
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
  { bad: "仕返し", keep: "revenge", note: "やり返す（TKT-204 案 F）。旧・遠征送りは廃止" },
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
