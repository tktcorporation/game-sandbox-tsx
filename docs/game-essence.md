# モダンなゲーム 30 本から抽出した設計のエッセンス

このアーケードの 3 本（防波堤・延焼線・深淵採掘）は、以下のエッセンスに寄せて作る。新しいゲームを足すときも、まずこの表の原則に照らす。

## 調べたゲーム

| 系統 | ゲーム |
| ---- | ------ |
| 戦術・パズル | Into the Breach、Slay the Spire、Balatro、Baba Is You、Hitman GO / Lara Croft GO、Monument Valley、Mini Metro、Islanders、Dorfromantik、Inscryption |
| リアルタイム・経営 | Mini Motorways、Bad North、Frostpunk、Dome Keeper、Vampire Survivors、Townscaper、Factorio、Kingdom Two Crowns、Cult of the Lamb、Loop Hero |
| 押し引き・モバイル | Luck be a Landlord、Dicey Dungeons、Peglin、Hades、Marvel Snap、Clash Royale、Wordle、Threes!、Alto's Odyssey、CloverPit / Buckshot Roulette |

## 12 の原則

| # | 原則 | 主な出典 | このアーケードでの実装 |
| - | ---- | -------- | ---------------------- |
| 1 | 結果を、確定する前に正確に見せる | Into the Breach、Islanders、Slay the Spire | 1 つの純粋関数がプレビューと本番の両方を計算する。プレビューは盤面の上に差分（ダメージ数・押し出し矢印・壊れる家）で重ねる |
| 2 | 脅威は自分の意図を先に宣言する | Into the Breach、Slay the Spire、Hitman GO | 敵の頭上に「アイコン＋最終値」のチップ、攻撃先のマスに斜線、順番が効くときは番号 |
| 3 | 取り消しを安くすると、試すことが怖くなくなる | Baba Is You、Into the Breach | 状態の履歴スタック。同じシードで即やり直し |
| 4 | 解決は 1 手ずつ再生し、タップで早送りできる | Into the Breach、Balatro、Wordle | 150〜500ms 間隔の段階再生。各段で発生源が跳ね、数値が浮く |
| 5 | 演出の強さを結果の大きさに比例させる | Balatro、Inscryption | 画面の揺れと音程を log(値) に比例させる |
| 6 | 失敗の予兆は全体バーではなく、危ない物の上に出す | Mini Metro、Mini Motorways、Cult of the Lamb | 脅かされている家に、満ちていくリングを付ける |
| 7 | 「自分」「脅威」「操作できる」「報酬」を色の文法で分ける | Into the Breach、Monument Valley、Balatro、Clash Royale | 意味色 5 つを全ゲームで共有し、装飾には使わない |
| 8 | 世界はくすませ、信号だけを鮮やかにする | Into the Breach、Frostpunk、Mini Metro、Bad North | 地形の彩度を抑え、高彩度は意図・風・オッズ・宝石だけに使う |
| 9 | 最初の 1 分で本物のループを遊ばせ、文章を削る | Factorio、Marvel Snap（画面の文は 8 語まで）、Baba Is You | 説明の段落を置かない。最初の面は動詞 1 つ、ヒントは 1 行 |
| 10 | 判断するときだけ時間を遅くする | Bad North、Vampire Survivors、Loop Hero、Mini Metro | 延焼線は、指を置いている間だけ時間が 0.25 倍になる |
| 11 | 撤退を、値段の付いた成功として見せる | Marvel Snap（Escaped!）、Loop Hero、Hades | 深淵採掘の「浮上」は金色の成功画面。崩落は同じ配置の赤 |
| 12 | 最も繰り返す操作を一番気持ちよくする | Dorfromantik、Threes!、Townscaper | 掘る・押す・めくるに、ばねの動き・音・小さな粒を付ける |

## ゲームごとの対応

**防波堤**（Into the Breach、Slay the Spire、Hitman GO、Baba Is You）

- 行動を選ぶと、実行前の盤面に差分が重なる。元の位置の影、押し出し先への矢印、`-2` の札、壊れる家の点滅（原則 1）
- 敵の頭上に「⚔2」のような意図チップと行動順（原則 2）
- 潮の解決は敵 1 体ずつ。家が壊れると画面が揺れる。タップで早送り（原則 4・5）
- 最初の島は 5×5 の盤に銛 1 体と敵 1 体。「押して、矢印を家から外す」の 1 行だけ（原則 9）

**延焼線**（Frostpunk、Mini Metro、Bad North、Kingdom Two Crowns、Clash Royale）

- 次の風を画面で最大の HUD にし、切り替わりまでを円で示す（Frostpunk の予報）
- 盤面に指を置いている間は時間が 0.25 倍になり、なぞった線がそのまま防火帯になる（原則 10、Mini Motorways の道を引く操作）
- 火が近い家に、満ちていくリングを付ける（原則 6）
- 作業員は数字ではなく粒で並べ、回復中の粒は液体のように満ちる（Kingdom、Clash Royale）
- 燃えた割合に応じて画面全体の色温度が上がる（Alto's Odyssey の進行と連動するパレット）

**深淵採掘**（Buckshot Roulette、Luck be a Landlord、Balatro、Marvel Snap、Hades、Wordle、Dome Keeper）

- 残りの枚数は見せ、順番は隠す。確率は数値で出さない（Buckshot Roulette）
- めくる瞬間に間を置き、カードを裏返す。宝石は倍率込みで数え上げ、深いほど音が上がる（原則 4・5）
- 「潜る」ボタン自体に次の倍率を載せる（Hades の扉の報酬表示）
- 浮上は金色の成功、崩落は同じ配置で赤く、失った額に取り消し線（原則 11）
- 潜るほど背景が暗く沈む（Alto's Odyssey）
- 補給所は縦長カード 3 枚の下から出るシート（Hades、Balatro）
- 結果を、リンクを含まない絵文字 1 行ずつで共有できる（Wordle）

## 共通の UI

- 主な操作は画面の下半分に置く。主ボタンは黄色（Clash Royale、Marvel Snap）
- 状態が変わるたびに、それぞれ別の短い音を鳴らす。目を閉じても状況が分かる音にする（Bad North）。音は最初の操作の後から鳴らし、消音を切り替えられる
- 負けた画面からは、同じ盤面のやり直しを 1 タップで始められる（Hades、Wordle）
