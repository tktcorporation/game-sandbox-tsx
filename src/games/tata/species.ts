import type { Element, Genus, Rarity, Role, Shape, Species, Stage } from "./types";

type Row = [
  id: string,
  name: string,
  genus: Genus,
  element: Element,
  rarity: Rarity,
  shape: Shape,
  hue: number,
  role: Role,
  hp: number,
  atk: number,
  blurb: string,
];

const EVO: Record<string, [string, string, string, string]> = {
  fulugg: ["ちびフルッグ", "フルッグ", "ダレフルッグ", "オオフルッグ"],
  nanmonaishi: ["ただのいし", "ナンモナイシ", "ちょっとあるいし", "なんかすごいし"],
  nekoori: ["こねこおり", "ネコオリ", "オオネコオリ", "ネコオリアー"],
  hinomaru: ["ちびヒノマル", "ヒノマル", "アツヒノマル", "ヒノマルオー"],
};

const ROWS: Row[] = [
  ["fulugg", "フルッグ", "frog", "water", 3, "frog", 148, "tank", 46, 9, "よだれをたらすカエル。お腹が空くと全世界が敵。"],
  ["keropoyo", "ケロポヨ", "frog", "water", 1, "frog", 132, "dps", 28, 11, "ぴょんぴょん跳ねて自分でも驚く。"],
  ["gerorin", "ゲロりん", "frog", "water", 1, "frog", 118, "support", 30, 8, "ゲロッと鳴くだけで雨雲が寄ってくる。"],
  ["amegaeru", "あめがえる", "frog", "water", 2, "frog", 200, "support", 32, 10, "雨粒を背負った旅がえる。"],
  ["doropyon", "どろぴょん", "frog", "earth", 1, "frog", 32, "tank", 40, 7, "泥の中が一番落ち着く。"],
  ["awagaeru", "あわガエル", "frog", "water", 1, "frog", 175, "support", 26, 9, "泡の帽子が自慢。"],
  ["tsukikero", "つきケロ", "frog", "light", 2, "frog", 48, "dps", 30, 13, "満月の夜だけよく跳ねる。"],
  ["nijipyoko", "にじぴょこ", "frog", "light", 2, "frog", 280, "dps", 29, 12, "虹色の腹がぴかぴか光る。"],
  ["iwagaeru", "いわがえる", "frog", "earth", 1, "frog", 24, "tank", 44, 6, "岩に擬態しすぎて動けない日がある。"],
  ["hinogero", "ほのげろ", "frog", "fire", 2, "frog", 18, "dps", 27, 14, "口から小さな花火。危ない。"],

  ["nanmonaishi", "ナンモナイシ", "stone", "earth", 2, "stone", 28, "tank", 52, 5, "しょんぼりしたただの石。でも仲間。"],
  ["koroishi", "ころいし", "stone", "earth", 1, "stone", 22, "dps", 34, 8, "坂道が好き。止まらない。"],
  ["maruiwa", "まるいわ", "stone", "earth", 1, "stone", 36, "tank", 48, 6, "転がると幸せそうな音がする。"],
  ["sabiishi", "さびいし", "stone", "earth", 1, "stone", 16, "tank", 42, 7, "錆びたのに新しい友達。"],
  ["hoshiishi", "ほしのいし", "stone", "light", 2, "stone", 52, "support", 36, 10, "夜になると小さな星が浮かぶ。"],
  ["dokanko", "どかんこ", "stone", "earth", 1, "stone", 14, "tank", 50, 6, "どかんと落ちるのが仕事。"],
  ["tsutsuishi", "つついし", "stone", "earth", 1, "stone", 40, "support", 38, 8, "筒みたいに空洞。風が鳴る。"],
  ["nikoishi", "にこいし", "stone", "light", 1, "stone", 44, "support", 36, 9, "笑っているように見えるただの割れ目。"],
  ["kuroiwa", "くろいわ", "stone", "dark", 2, "stone", 250, "tank", 54, 7, "夜の道の番人。重い。"],
  ["kinnoishi", "きんのいし", "stone", "light", 3, "stone", 46, "dps", 40, 14, "金に見える。食べられない。"],

  ["nekoori", "ネコオリ", "cat", "grass", 3, "cat", 88, "dps", 34, 15, "折り紙好きのネコ。プールが意外と好き。"],
  ["miketchi", "みけっち", "cat", "grass", 1, "cat", 28, "dps", 30, 12, "三色の毛並みが毎日ちょっと違う。"],
  ["kuroneko", "くろねこ", "cat", "dark", 2, "cat", 260, "dps", 31, 14, "路地の王。縁起は人による。"],
  ["shironyan", "しろにゃん", "cat", "light", 1, "cat", 42, "support", 28, 10, "真っ白でよく紛失する。"],
  ["toramaru", "とらまる", "cat", "fire", 1, "cat", 22, "dps", 32, 13, "しましまは炎の名残らしい。"],
  ["nekomochi", "ねこもち", "cat", "earth", 1, "cat", 34, "tank", 38, 9, "もちもちでつぶれない。"],
  ["sunyaa", "すにゃー", "cat", "light", 1, "cat", 200, "support", 26, 11, "あくびが攻撃。"],
  ["higenyan", "ひげにゃん", "cat", "grass", 1, "cat", 96, "dps", 29, 12, "ひげで天気がわかる。"],
  ["nekozabu", "ねこざぶ", "cat", "water", 2, "cat", 168, "tank", 36, 11, "水に強い珍しいネコ。"],
  ["tsukineko", "つきねこ", "cat", "dark", 2, "cat", 270, "dps", 30, 15, "月夜にだけ本気を出す。"],

  ["piyomaru", "ぴよまる", "bird", "light", 1, "bird", 50, "dps", 24, 12, "丸いのに飛ぶ気満々。"],
  ["sorauso", "そらうそ", "bird", "light", 1, "bird", 205, "support", 26, 10, "空の噂を運んでくる。"],
  ["kotoriko", "ことりこ", "bird", "grass", 1, "bird", 92, "dps", 25, 11, "木の実を隠しすぎて自分で迷う。"],
  ["fukurori", "ふくろうり", "bird", "dark", 2, "bird", 30, "support", 32, 11, "夜勤の知恵袋。"],
  ["hatopoppo", "はとぽっぽ", "bird", "earth", 1, "bird", 210, "support", 28, 9, "ぽっぽと鳴くだけで安心する。"],
  ["karasuke", "からすけ", "bird", "dark", 1, "bird", 255, "dps", 27, 13, "光るものに弱い。"],
  ["tsubamen", "つばめん", "bird", "water", 1, "bird", 188, "dps", 24, 14, "雨の日の曲芸飛行。"],
  ["niwatorin", "にわとりん", "bird", "fire", 1, "bird", 12, "tank", 36, 10, "朝に強い。夜に弱い。"],
  ["penginko", "ペンギンコ", "bird", "water", 2, "bird", 214, "tank", 38, 10, "飛べないことを誇りにしている。"],
  ["horohoro", "ほろほろ", "bird", "earth", 1, "bird", 38, "support", 30, 9, "ほろほろ鳴いて土を耕す。"],

  ["hinomaru", "ヒノマル", "blob", "fire", 2, "blob", 16, "dps", 30, 14, "丸い火だんご。触るとあったかい。"],
  ["mizupuni", "みずぷに", "blob", "water", 1, "blob", 192, "support", 28, 9, "ぷにぷにで水を含む。"],
  ["moripuyo", "もりぷよ", "blob", "grass", 1, "blob", 110, "support", 29, 9, "苔の香りがする。"],
  ["doropuni", "どろぷに", "blob", "earth", 1, "blob", 26, "tank", 40, 7, "踏んでも壊れない泥。"],
  ["hikarin", "ひかりん", "blob", "light", 2, "blob", 54, "support", 26, 12, "夜道の豆ランプ。"],
  ["yamipuni", "やみぷに", "blob", "dark", 2, "blob", 268, "dps", 28, 13, "暗い部屋が好き。"],
  ["nijipuyo", "にじぷよ", "blob", "light", 3, "blob", 300, "dps", 32, 15, "虹を丸めたようなぷよ。"],
  ["awapuni", "あわぷに", "blob", "water", 1, "blob", 180, "support", 24, 8, "はじけるとしゃぼんだまの泡。"],
  ["tsukupurin", "つきプリン", "blob", "light", 1, "blob", 46, "support", 27, 10, "月見のおやつ。"],
  ["denpuni", "でんぷに", "blob", "fire", 2, "blob", 48, "dps", 26, 15, "静電気をためこむ。"],

  ["imomushu", "いもむしゅ", "bug", "grass", 1, "bug", 100, "tank", 34, 7, "将来の夢はちょうちょ。まだ早い。"],
  ["tentou", "てんとう", "bug", "fire", 1, "bug", 8, "dps", 26, 12, "点の数は気分。"],
  ["kabutomaru", "カブトまる", "bug", "earth", 2, "bug", 34, "tank", 42, 11, "角はまだ柔らかい。"],
  ["chochoko", "ちょうちょこ", "bug", "light", 1, "bug", 310, "dps", 22, 13, "羽音が鈴。"],
  ["mitsubacchi", "みつばっち", "bug", "grass", 1, "bug", 42, "support", 24, 11, "はちみつを配る係。"],
  ["arinko", "ありんこ", "bug", "earth", 1, "bug", 20, "tank", 30, 8, "行列を作らずに迷う。"],
  ["kamakirin", "かまきりん", "bug", "grass", 2, "bug", 118, "dps", 28, 16, "かまは折りたたみ式。"],
  ["dangomushi", "だんごむし", "bug", "earth", 1, "bug", 18, "tank", 36, 6, "丸くなると無敵（気分）。"],
  ["hotarun", "ホタルン", "bug", "light", 2, "bug", 58, "support", 24, 12, "お尻のランプは充電式。"],
  ["battarin", "バッタリン", "bug", "grass", 1, "bug", 86, "dps", 25, 13, "跳ねすぎてどこかへ行く。"],

  ["kingyo", "きんぎょ", "fish", "water", 1, "fish", 12, "dps", 26, 11, "鉢から出たがっている。"],
  ["kuragee", "くらげぇ", "fish", "water", 1, "fish", 188, "support", 30, 8, "ぷかぷかが仕事。"],
  ["takopuni", "たこぷに", "fish", "dark", 1, "fish", 330, "dps", 28, 12, "吸盤で友情を確認する。"],
  ["ikasumi", "いかすみ", "fish", "dark", 2, "fish", 248, "dps", 29, 14, "墨で逃げるのが得意。"],
  ["samerin", "サメリン", "fish", "water", 3, "fish", 210, "dps", 36, 16, "歯はたくさん、悪意はゼロ。"],
  ["hitodeen", "ヒトデーン", "fish", "water", 1, "fish", 16, "support", 32, 8, "星型なのに海が好き。"],
  ["ebirin", "エビリン", "fish", "fire", 1, "fish", 8, "dps", 24, 13, "ゆでられる前に逃げた。"],
  ["unagin", "うなぎん", "fish", "dark", 2, "fish", 236, "dps", 30, 14, "ぬるぬるで捕まりにくい。"],
  ["irukako", "イルカコ", "fish", "water", 2, "fish", 198, "support", 34, 11, "ジャンプのたびに笑顔。"],
  ["manbou", "マンボウ", "fish", "water", 2, "fish", 176, "tank", 48, 7, "横向きに漂う哲学者。"],

  ["kinokoko", "きのここ", "shroom", "grass", 1, "shroom", 14, "support", 30, 8, "森の床の案内係。"],
  ["dokukinoko", "どくきのこ", "shroom", "dark", 2, "shroom", 280, "dps", 28, 14, "毒々しいが根はいい子。"],
  ["hikaridake", "ひかりだけ", "shroom", "light", 2, "shroom", 70, "support", 26, 11, "洞窟の常夜灯。"],
  ["matsutaken", "まつたけん", "shroom", "earth", 3, "shroom", 30, "support", 34, 12, "香りで仲間を集める。"],
  ["shimejii", "しめじぃ", "shroom", "grass", 1, "shroom", 40, "support", 28, 8, "群れるのが好き。"],
  ["namekoppe", "なめこっぺ", "shroom", "earth", 1, "shroom", 24, "tank", 36, 7, "ぬめぬめ防御。"],
  ["eringin", "えりんぎん", "shroom", "grass", 1, "shroom", 48, "tank", 38, 9, "軸が太い。自信家。"],
  ["toryufu", "トリュフ", "shroom", "dark", 3, "shroom", 20, "support", 32, 13, "土の中の宝物。"],
  ["maitake", "まいたけ", "shroom", "grass", 1, "shroom", 96, "support", 29, 9, "舞うたびに胞子がきらきら。"],
  ["shiitaken", "しいたけん", "shroom", "earth", 1, "shroom", 22, "tank", 34, 8, "傘が日除けになる。"],

  ["hoshiboshi", "ほしぼし", "star", "light", 1, "star", 50, "dps", 24, 12, "夜空から落ちてきた豆粒。"],
  ["otsukisama", "おつきさま", "star", "light", 2, "star", 44, "support", 30, 11, "丸い月を真似した星。"],
  ["nijiboshi", "にじぼし", "star", "light", 2, "star", 310, "dps", 26, 14, "虹をひと口サイズに。"],
  ["suisein", "すいせいん", "star", "dark", 2, "star", 220, "dps", 28, 15, "しっぽが長い流れ星。"],
  ["kumowata", "くもわた", "star", "water", 1, "star", 200, "support", 32, 8, "綿菓子みたいな雲。"],
  ["kaminarin", "かみなりん", "star", "fire", 2, "star", 48, "dps", 27, 16, "小さな雷。耳鳴り注意。"],
  ["amagumo", "あまぐも", "star", "water", 1, "star", 210, "support", 30, 9, "泣き虫の雲。"],
  ["yukidaru", "ゆきだる", "star", "water", 1, "star", 190, "tank", 40, 7, "春が苦手。"],
  ["soyokaze", "そよかぜ", "star", "grass", 1, "star", 120, "support", 24, 10, "風を丸めたもの。"],
  ["nijikake", "にじのかけら", "star", "light", 3, "star", 290, "dps", 28, 16, "虹の破片。踏むと音がする。"],

  ["mokodora", "もこドラ", "drake", "fire", 3, "drake", 18, "tank", 44, 14, "もこもこの幼竜。炎はまだ温かい。"],
  ["hinadora", "ひなドラ", "drake", "fire", 2, "drake", 12, "dps", 32, 15, "ひななのに威厳を練習中。"],
  ["mizuryu", "みずりゅう", "drake", "water", 3, "drake", 196, "dps", 38, 15, "川を滑る水竜。"],
  ["moedora", "もえドラ", "drake", "fire", 3, "drake", 8, "dps", 36, 17, "いつも少し焦げている。"],
  ["morinoryu", "もりのりゅう", "drake", "grass", 3, "drake", 124, "tank", 42, 13, "苔を生やした森の竜。"],
  ["tsuchiryu", "つちりゅう", "drake", "earth", 3, "drake", 28, "tank", 50, 12, "土竜。穴を掘るのが仕事。"],
  ["hikaryu", "ひかりゅう", "drake", "light", 4, "drake", 52, "dps", 40, 18, "光のうろこがまぶしい。"],
  ["yamiryuu", "やみりゅう", "drake", "dark", 4, "drake", 264, "dps", 42, 18, "影をまとった夜の竜。"],
  ["nijidora", "にじドラ", "drake", "light", 4, "drake", 300, "dps", 38, 19, "虹を食べて育った竜。"],
  ["oudora", "おうドラ", "drake", "fire", 4, "drake", 36, "tank", 48, 17, "王冠が似合う王様ドラ。"],

  ["nuibake", "ぬいばけ", "ghost", "dark", 1, "ghost", 320, "support", 28, 9, "ぬいぐるみのおばけ。縫い目が愛。"],
  ["teruteru", "てるてる", "ghost", "water", 1, "ghost", 180, "support", 26, 8, "晴れを祈る係。"],
  ["kasaobake", "かさおばけ", "ghost", "dark", 1, "ghost", 240, "dps", 30, 11, "一本足で跳ねる傘。"],
  ["hitodama", "ひとだま", "ghost", "fire", 2, "ghost", 14, "dps", 24, 15, "青白い火。触ると冷たい。"],
  ["nurikabe", "ぬりかべ", "ghost", "earth", 2, "ghost", 30, "tank", 56, 5, "道をふさいで笑っている。"],
  ["karakasa", "からかさ", "ghost", "dark", 1, "ghost", 220, "dps", 27, 12, "古い傘の成れの果て。"],
  ["ayakashi", "あやかし", "ghost", "dark", 3, "ghost", 276, "dps", 34, 16, "霧の中から手を振る。"],
  ["kitsunebi", "きつねび", "ghost", "fire", 2, "ghost", 24, "dps", 28, 15, "狐の火。悪戯好き。"],
  ["nuribon", "ぬりぼん", "ghost", "earth", 1, "ghost", 26, "tank", 40, 7, "壁に貼りつく弟分。"],
  ["yurein", "ゆうれいん", "ghost", "dark", 2, "ghost", 250, "support", 30, 12, "シーツおばけの正統派。"],

  ["purinko", "プリンコ", "sweet", "light", 1, "sweet", 46, "support", 28, 9, "ぷるぷるのおやつ魂。"],
  ["dorayaki", "どらやき", "sweet", "earth", 1, "sweet", 28, "tank", 36, 8, "あんこが詰まっている。"],
  ["taiyaki", "たいやき", "sweet", "fire", 1, "sweet", 18, "dps", 30, 11, "頭から食べるか尾から食べるかで割れる。"],
  ["dangon", "だんごん", "sweet", "grass", 1, "sweet", 12, "support", 32, 8, "三兄弟で一本の串。"],
  ["monaka", "もなか", "sweet", "earth", 1, "sweet", 32, "tank", 34, 8, "パリパリの鎧。"],
  ["youkan", "ようかん", "sweet", "dark", 1, "sweet", 340, "tank", 38, 7, "ねっとり防御。"],
  ["anmitsu", "あんみつ", "sweet", "water", 1, "sweet", 170, "support", 27, 10, "寒天の海を漂う。"],
  ["mitarashi", "みたらし", "sweet", "fire", 2, "sweet", 22, "dps", 29, 13, "たれが武器。"],
  ["kakigoori", "かきごおり", "sweet", "water", 2, "sweet", 188, "dps", 26, 14, "頭がつめたい。考えもつめたい。"],
  ["wataamen", "わたあめん", "sweet", "light", 2, "sweet", 320, "support", 24, 12, "風が吹くと半分解ける。"],
];

function defaultEvo(name: string): [string, string, string, string] {
  return [`ちび${name}`, name, `でか${name}`, `${name}オー`];
}

function satFor(rarity: Rarity, element: Element): number {
  const base = 48 + rarity * 8;
  if (element === "dark") return base - 6;
  if (element === "light") return base + 4;
  return base;
}

function litFor(element: Element): number {
  if (element === "dark") return 38;
  if (element === "light") return 62;
  if (element === "fire") return 54;
  return 50;
}

export const SPECIES: Species[] = ROWS.map((row) => {
  const [id, name, genus, element, rarity, shape, hue, role, hp, atk, blurb] = row;
  return {
    id,
    name,
    genus,
    element,
    rarity,
    shape,
    hue,
    sat: satFor(rarity, element),
    lit: litFor(element),
    role,
    baseHp: hp,
    baseAtk: atk,
    blurb,
    evoNames: EVO[id] ?? defaultEvo(name),
  };
});

export const SPECIES_BY_ID: Record<string, Species> = Object.fromEntries(SPECIES.map((s) => [s.id, s]));

export const STARTERS = ["fulugg", "hinomaru", "nekoori"] as const;

export const ELEMENT_LABEL: Record<Element, string> = {
  fire: "火",
  water: "水",
  grass: "草",
  earth: "土",
  light: "光",
  dark: "闇",
};

export const GENUS_LABEL: Record<Genus, string> = {
  frog: "カエル",
  stone: "イシ",
  cat: "ネコ",
  bird: "トリ",
  blob: "プリ",
  bug: "ムシ",
  fish: "ウオ",
  shroom: "ダケ",
  star: "ホシ",
  drake: "リュウ",
  ghost: "バケ",
  sweet: "オヤツ",
};

export const RARITY_LABEL: Record<Rarity, string> = {
  1: "ふつう",
  2: "めずらしい",
  3: "レア",
  4: "でんせつ",
};

export const STAGE_LABEL: Record<Stage, string> = {
  0: "たまごごろ",
  1: "こども",
  2: "おとな",
  3: "かくせい",
};

export function speciesOf(id: string): Species {
  const s = SPECIES_BY_ID[id];
  if (!s) throw new Error(`unknown tata ${id}`);
  return s;
}

export function displayName(species: Species, stage: Stage, shiny: boolean): string {
  const base = species.evoNames[stage];
  return shiny ? `ピカ${base}` : base;
}

/** Fire beats grass, grass beats earth, earth beats water, water beats fire. Light and dark beat each other. */
export function elementMod(atk: Element, def: Element): number {
  if (atk === def) return 1;
  const wheel: Record<Element, Element> = {
    fire: "grass",
    grass: "earth",
    earth: "water",
    water: "fire",
    light: "dark",
    dark: "light",
  };
  if (wheel[atk] === def) return 1.5;
  if (wheel[def] === atk) return 0.7;
  return 1;
}
