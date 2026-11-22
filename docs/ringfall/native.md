# RINGFALL native（Rust → WASM）

この文書は **実験結果の記録**（なぜ遅かったか／偏ったか）である。本文の数値は実装 PR 上で測ったもの。

`native/ringfall-fill/` と関連スクリプトは [#153](https://github.com/tktcorporation/game-sandbox-tsx/pull/153) / [#155](https://github.com/tktcorporation/game-sandbox-tsx/pull/155) で積み上げ中。**このドキュメント単独の checkout（`main`）にはクレートも `build:native` 等の npm スクリプトもまだ無い。** 本番に napi-rs は使わない。ブラウザと Node で同じ WASM を使う設計。

ナビの Dial `fill` は粗い単位で速い（後述）。ティックホスト（敵・弾・`step_tick`）は上記 PR 上で ABI 6 まで移植したが、**ウォームでは TS より遅い**（後述）。**既定は TypeScript**（bench ハッシュ `83b7a1d3bcf8`）。WASM tick は等価かつウォーム bench で勝つまで **OFF**（現状は勝っていない）。

## なぜこれまでの WASM は遅いか／偏るか

計測とコードから分かったことの整理。**呼び出しそのものが高いわけではない**。ABI 4 までは「毎ティック大量の状態を AoS↔SoA で運び、残りのロジックを TS に残す」が主因だった。ABI 6 でその形をかなり解消してもウォームで約 1.6× 遅く、残りは hunt 場・薄い同期・このワークロードでの TS JIT 競争力、と読める（後述）。

### 呼び出し境界は安い

JS↔WASM の関数呼び出しは、現代のエンジンでは「細かい移植を諦める理由」にならない。

- [Mozilla Hacks (2018): Calls between JavaScript and WebAssembly are finally fast](https://hacks.mozilla.org/2018/10/calls-between-javascript-and-webassembly-are-finally-fast-%F0%9F%8E%89/) — Firefox で JS→WASM / WASM→JS が非インラインの JS→JS より速くなった、という報告。
- [V8 release v9.0](https://v8.dev/blog/v8-release-90) — JS→Wasm wrapper のインライン（実験フラグ当時）。引数変換のフレームを削る。
- [The Rust Wasm Book — Calling between JS and Rust](https://rustwasm.github.io/docs/book/) — 境界をまたぐ回数より、**渡すデータの粒度**が支配的、という実務上の指針に合う。

RINGFALL でも、`ringfall_step_tick` を 1 回叩くこと自体は問題にならない。重いのはその前後の同期である。

### fill が速い理由（粗い粒度）

Landmark Dial の距離場 `fill` は、ワールド格子を **一度に** WASM 線形メモリへ載せ、長い探索を中で回す。プロセスをまたいでも同じ答え（実装 PR 上の `npm run fill:ringfall`）。ウォームなレイドでは場はほぼ建たないので全体時間は揺れの範囲だが、**コールドの単発探索**では TS より速いことがある。成功パターンは「大きな仕事を 1 回の境界の向こうでやる」こと。

### A*（opt-in）がウォームで約 1.34× 遅かった理由

同じクレートに A* も載せたが、ウォーム bench では WASM A* オンが **77.6 s**、TS A*（fill のみ WASM）が **57.9 s**（どちらもハッシュ `83b7a1d3bcf8`）。ボットの経路は **短いクエリが頻繁**で、境界のセットアップと実装差が効き、粗い fill ほどの得がない。そのため A* は `RINGFALL_ASTAR=1` の opt-in のまま。

### ABI 3: 速く見えたが偏った

`sense` + 交戦 FSM + 弾を `step_tick` に載せた段階。固定 90 s シミュでは CPU が TS より大幅に短いこともあったが、ベンチ全体のハッシュは分かれ、等価では:

| 指標 | TS | WASM | 問題 |
| --- | ---: | ---: | --- |
| met | ~7.9 | ~2.5 | **BIAS** |
| metAway | ~5.0 | ~0.7 | **BIAS** |

原因の要点:

1. WASM が部隊を交戦にしても `{ t: "engage" }` を出さず、表の `met` が数え損ねた。
2. Rust 側の `calm` がスタブで、巡回・パーティ・待ち伏せを歩かない → 路上の遭遇（metAway）が潰れた。
3. 交戦中の接近が直線（hunt の距離場なし）→ 再接近・再交戦が減る。
4. `fightFoe` / cover が未移植 → キル・ダメージもずれる。

「ハッシュが違うから速い」は、レイドが短く・静かになった見かけであることが多い。

### ABI 4（ハイブリッド）: 等価は通ったがウォームで遅い

対策として:

- pull 時に新規交戦で `engage` イベントを出す
- 交戦前に TS が hunt via / `fromCover` skip を SoA に書く（`prepareWasmTick`）
- WASM のあと TS が完全な `calm` + `fightFoe`（`tickNonEngaged`）

実装 PR 上の `npm run equiv:ringfall`（N=30×10）では **BIAS なし**（met 7.87→7.13、kills/damage もノイズ内）。一方ウォーム bench はおよそ **CPU 58 s → 64 s**、wall も同様に悪化した。

コード上の税（`tick.ts` を数えた値）:

- 毎ティック `syncRobots` / `syncSquads` / `syncOrbs` で敵・部隊・弾の **ほぼ全フィールド**を AoS→SoA に書き、`pull*` で読み戻す
- `ringfall_sim_*_ptr` 系がファイル内で **約 150 回超**、`Float32Array` / `Int32Array` / `Uint8Array` の生成が **約 160 回**（ビューはメモリ成長のたびに取り直す必要はあるが、毎ティック全部作り直している）
- そのうえ TS が `prepareWasmTick`（hunt / fromCover）と `tickNonEngaged`（calm / fightFoe）を回す

つまり遅い主因は「JS→WASM の 1 コール」ではなく、**毎ティックの全状態ミラー + 残ロジックが二重**なこと。

### ABI 5: calm を WASM に移しても退行

`calm` / `fightFoe` を Rust に移し `tickNonEngaged` を外した。等価の N=5 では遭遇は近かったが、via / foe / calm 用フラグを **毎ティック TS が全ロボット分計算して書き込む**準備が残り、ウォーム bench は大幅に悪化した（例: 合計 CPU が TS の約 2 倍）。「ロジックを移した」のに **準備の同期税が残る**と得にならない。リバート済み。

### ABI 6: 目標形まで移植してもウォームで負けた

「正本を WASM に寄せ、毎ティックのフル AoS↔SoA をやめる」を実際にやった結果。#155（ABI 6）の最終形:

**移植したもの**

- `sense` + 交戦 FSM + 弾（orbs）
- `fromCover` / cover 選択、完全な `calm`、`fightFoe`
- hunt vias（格子は geom と一緒に一度アップロード；`trip_step` / sticky via）
- ロボットは **adopt-once**（毎ティックの全ロボット押しは廃止）
- `prepareWasmTick` / `tickNonEngaged` は削除

**残した薄い境界（毎ティック）**

- 部隊の目的地など squad SoA の同期（`stepSquads` / factions はまだ TS）
- プレイヤー戦闘結果の hp / aware patch
- orb sync、イベント・ヒット・描画用 SoA の pull（TypedArray ビューはキャッシュ）

**このマシンでの最終数値**（`RINGFALL_EQUIV_N=30` と同じウォーム pass）:

| | TS | WASM tick |
| --- | ---: | ---: |
| Warm bench CPU | **55.5 s** | **89.7 s**（~1.62×） |
| Warm bench wall | **47.6 s** | **82.6 s** |
| Equiv N=30 合計 CPU | 1239 s | 4635 s（~3.7×） |
| Bench ハッシュ | `83b7a1d3bcf8` | `372dee3422fc` |

等価は **BIAS なし**（exit 0）。hits / flanks / quiet などに `~` はあるが、systematic bias フラグは立たない。ビット一致は不要・未達。

つまり **等価は取れたが、速くはならなかった**。既定 ON の条件（ウォーム CPU・wall で TS を上回る）は満たしていない。

#### なぜフル移植でも遅いか（読み取り）

境界の「呼ぶ回数」や「フルミラー」は ABI 4 よりかなり減ったのに、ウォームで約 1.6×、長い equiv では約 3.7× 遅い。主因の候補を重い順に書く。

1. **hunt 距離場のコストが tick の中心に残った**  
   calm の巡回・パーティ・帰り道は `trip_step` / sticky via で格子を読む。ABI 5 直後に reach を `Infinity` 相当で全ワールド Dijkstra にすると、都市・発射場のウォームが百秒台に爆発した（その後 reach 上限 + `VIA_REFRESH=12` の sticky で ~90 s 台まで戻した）。TS 側の hunt も同じ格子だが、**ウォームな V8 の上で長年回ってきた経路**と、WASM 内の素直な実装では定数倍が違う。 sticky は焼き直しを減らすが、calm が多いレイドでは場の構築・走査がまだ支配的。

2. **毎ティック残る squad sync + robot pull**  
   部隊の目的地・交戦フラグはまだ TS の `stepSquads` が決め、SoA に書く。描画・イベント用にロボット SoA を読む。フル AoS 押しよりは軽いが、レイド中のロボット数百・毎ティックでは無視できない。squad と friends / titan 特殊も境界の外なので、「1 回の `step_tick` で閉じる」にはなっていない。

3. **アルゴリズム差と安全側の切り捨て**  
   全ワールド場を hot path から外したのは正しさより速度のためで、TS の `Infinity` reach と完全同一ではない。sticky via は目標が動くまで古い via を使う。等価のノイズ（flanks 多め、quiet 長め、kills やや少なめ）はここに触れている可能性が高い。**等価ゲートは通るが、速くするための近似がさらに場を触る**とまた偏る、というトレードオフが残る。

4. **このワークロードでは TS の JIT が十分強い**  
   敵ティックは「巨大な密行列」ではなく、分岐の多い短いループ・浮動小数・格子の読み書きの積み重ね。V8 はホットな TS をインライン・型特化できる一方、WASM はポータブルな線形メモリ演算で勝つ設計。fill のような **一度に長い探索**では WASM が効き、**毎フレーム細かく回る AI** では「Rust にしたから速い」が自動では出ない、というのが今回の empirically な結論に近い。

5. **二重の世界観の税がゼロにはならない**  
   プロファイル・ハブ・描画・ボット・ゲートは AoS の `State` を前提にする。正本を WASM に寄せても、採用・パッチ・pull・ビューの変換層は残る。ゲーム全体を SoA / WASM 前提に書き直すなら別だが、**既存 TS シミュの上にティックだけ載せる**範囲では、その層の固定費がウォーム差の一部を説明する。

#### 実験としての結論

- **粗い単位（fill）**: 得になりうる。  
- **細かい毎ティック AI を境界ごと移植**: 等価は取れる（ABI 6）が、この規模・このマシンでは **TS より速いとは言えない**。  
- 呼び出し境界は安く、フル sync を減らしても、**hunt と残同期と JIT 差**で負けが残る。  
- 既定を TypeScript に戻し、WASM tick は opt-in のまま置くのが妥当。これ以上の最適化は「別プロダクトとしてシミュを書き直す」か「hunt を根本的に安くする」領域で、今回のポートの延長だけでは回収しにくい。

## スイッチと検証コマンド（実装 PR 上）

以下のフラグと npm スクリプトは **#153 / #155 がマージされたあとのツリー**（またはそれらのブランチ）で使える。この lessons 文書だけの checkout では `npm run build:native` 等は未定義。

| フラグ | 効果 |
| --- | --- |
| `RINGFALL_FILL=ts` / `?ringfallNative=0` | WASM 全体オフ（ナビ含む） |
| `RINGFALL_ASTAR=1` | WASM A*（ウォームでは遅い） |
| `RINGFALL_TICK=1` | ティックホスト opt-in（既定 OFF） |

```bash
# 実装 PR（#153 / #155）上でのみ:
npm run build:native
npm run smoke:native
npm run fill:ringfall
npm run bench:ringfall          # 既定 → ハッシュ 83b7a1d3bcf8
npm run equiv:ringfall          # TS vs WASM tick の統計等価
npm run tick-cost:ringfall -- 90
```
