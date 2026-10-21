import { recordSpot, type RecordId } from "../sim/map";

/**
 * The story contracts: the day of the Ringfall, told one event at a time, each by a record left
 * in one building. They are offered one at a time, in this order, each once the one before it is
 * home. They are not taken like the board's contracts: the one under way is always on, and only
 * its record lies on the island.
 */
export interface Story {
  id: RecordId;
  title: string;
  /** What the board asks for, in a line. */
  ask: string;
  /** What the record tells, shown on the board once it is home. */
  told: string[];
  /** Credits paid when the record comes home. */
  cash: number;
}

export const STORIES: Story[] = [
  {
    id: "tether",
    title: "折れた昇降路",
    ask: "発着場の北、アンカーの縦穴の足場の下に、昇降路の管制が残した記録がある",
    told: [
      "午前 6 時 12 分、環を支えていた張力が一度に抜けた。",
      "昇降路は上から順に折れ、島の東と西へ倒れた。根元のアンカーだけが立ったまま残った。",
      "管制の最後の行は「上の環と連絡がつかない」。",
    ],
    cash: 800,
  },
  {
    id: "dam",
    title: "割れた堤",
    ask: "湖底の旧市街の北、堤の前に立つ取水塔の制御室に、ダムの運転日誌がある",
    told: [
      "昇降路が倒れた揺れで、堤の継ぎ目に亀裂が入った。",
      "運転員は水門を開けて水位を下げようとした。電力が落ち、水門は半分で止まった。",
      "その夜、堤は放水路の側から割れた。湖は 2 日で干上がり、湖底の町が出てきた。",
    ],
    cash: 1200,
  },
  {
    id: "ship",
    title: "最後の船",
    ask: "港湾地帯の難破船、船尾の上の船橋に、最後の航海日誌がある",
    told: [
      "落ちた日の昼、港から最後の貨物船が出た。積んでいたのは部品ではなく、基地の人たちだった。",
      "湾を出る前に水が引き、船は浅瀬に乗り上げた。",
      "日誌は翌朝で終わる。「全員、北の峠へ歩いて向かう」。",
    ],
    cash: 1600,
  },
  {
    id: "network",
    title: "網を組んだ者",
    ask: "中継塔の機器棟の 3 階に、ロボットの網の設計記録がある",
    told: [
      "保守と警備の機械は、もとは基地の管制から 1 台ずつ指示を受けていた。",
      "管制が黙った 3 日後、中継塔の予備の系統が機械どうしをつなぎ直した。設計者の名は残っていない。",
      "網に残る命令は 1 つ。「基地を守れ。誰も入れるな」。",
    ],
    cash: 2000,
  },
  {
    id: "smelter",
    title: "製錬所の炉",
    ask: "製錬所の制御棟の最上階に、出荷台帳がある",
    told: [
      "製錬所は環の継ぎ手を鋳ていた。最後の 3 か月は、継ぎ手ではなく小型炉心を作っていた。",
      "台帳の宛先は環ではなく、港の船だった。",
      "誰かは、環が落ちることを先に知っていた。",
    ],
    cash: 2500,
  },
];

export const storyOf = (id: RecordId): Story => STORIES.find((t) => t.id === id) ?? STORIES[0];

/** The story contract under way: the first whose record is not home yet; null once all are. */
export const currentStory = (records: readonly RecordId[]): Story | null => STORIES.find((t) => !records.includes(t.id)) ?? null;

/** Where a story's record lies, as a line: the building and its record. */
export const storyWhere = (t: Story) => `${recordSpot(t.id).place}：${recordSpot(t.id).name}`;
