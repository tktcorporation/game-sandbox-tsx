# RINGFALL native（Rust → WASM）

この文書は **実験結果の記録**（なぜ遅かったか／偏ったか）である。本文の数値は実装 PR 上で測ったもの。

`native/ringfall-fill/` と関連スクリプトは [#153](https://github.com/tktcorporation/game-sandbox-tsx/pull/153) / [#155](https://github.com/tktcorporation/game-sandbox-tsx/pull/155) で積み上げ中。**このドキュメント単独の checkout（`main`）にはクレートも `build:native` 等の npm スクリプトもまだ無い。** 本番に napi-rs は使わない。ブラウザと Node で同じ WASM を使う設計。

ナビの Dial `fill` は粗い単位で速い（後述）。ティックホスト（敵・弾・`step_tick`）は上記 PR 上。**既定は TypeScript**（bench ハッシュ `83b7a1d3bcf8`）。WASM tick は等価かつウォーム bench で勝つまで **OFF**。

## なぜこれまでの WASM は遅いか／偏るか

計測とコードから分かったことの整理。**呼び出しそのものが高いわけではない**。遅いのは「毎ティック大量の状態を AoS↔SoA で運び、残りのロジックを TS に残す」形にある。

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

### これから効く形

目標アーキテクチャ（#155 など）:

1. **正本は WASM 線形メモリ**（敵・部隊・弾・ナビ/geom）。TS は不透明なハンドルと、入力・表示に必要な薄い面だけ持つ。
2. ティックは **粗い `step_tick` 1 回**。毎ティックのフル sync/pull をやめる。
3. 読み戻しは **イベント・ヒット・描画用 SoA** など小さく。TypedArray ビューはキャッシュし、メモリ成長時だけ作り直す。
4. hunt / cover / calm / fightFoe も境界の内側へ。TS で via を毎ティック焼く形は過渡措置にすぎない。

統計的等価（ビット一致ハッシュは WASM パスでは不要）と、ウォーム bench の CPU・wall で TS を上回ることの両方が揃うまで、**既定は TypeScript のまま**。

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
