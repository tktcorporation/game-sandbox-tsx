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

#### なぜフル移植でも遅いか（読み取り）— 区間プロファイルで更新

境界の「呼ぶ回数」や「フルミラー」は ABI 4 よりかなり減ったのに、**ウォームな全レイド**では約 1.6×、長い equiv では約 3.7× 遅い。一方 **固定 30 s の tick-cost**（レイド長のドリフトを除く）では、同期を安くしたあとほぼ互角（TS ~3.5 s / WASM ~3.6 s CPU）まで寄った。区間タイマー（#155、`tick-prof:ringfall`）で内訳を切ると、以前の「計算そのものが遅い」仮説は半分だけ正しい。

##### 区間比較（30 s 固定、reservoir good、seed 1000；`RINGFALL_TICK_PROF=2`）

| 区間 | TS (ms) | WASM (ms) | 読み |
| --- | ---: | ---: | --- |
| sense | ~106–120 | ~46–49 | **Rust が速い**（×2+） |
| calm* | ~149–158 | ~153–157 | ほぼ互角（中に hunt） |
| fightFoe | ~48–51 | ~9–11 | **Rust が速い**（×5） |
| cover* | ~3–4 | ~0.4 | Rust が速い |
| hunt* | ~27–32 | ~38–46 | WASM がやや遅い |
| enemies 合計 | ~573–612 | ~492–507 | **Rust 計算は速い** |
| orbs | ~37–41 | ~1 | **Rust が速い** |
| syncSquads | — | ~150–160（改善後；以前 ~320–380） | 同期の主因 |
| pullRobots | — | ~84 | AoS がボットに必要 |
| Σ sync | — | ~320–330 | 計算の得を打ち消す |

\* hunt/cover は calm/engaged の内側にも入る（二重加算しないこと）。Rust 側はホスト時計 `env.ringfall_now_ns`；JS 側は `process.hrtime`。`node --cpu-prof` でも WASM パスの自己時間は sync / tick 付近に集中。

##### 同期ゼロの上限

- **区間タイマー**: WASM `enemies+orbs` + leftover（`stepSquads` 等）≈ 550 ms 前後 vs TS 敵経路 ≈ 610 ms → **わずかに勝つ見込み**（同期を完全に消せた場合）。
- **`RINGFALL_TICK_NOSYNC=1`**（挙動不正・天井専用）: 30 s bare CPU が TS ~3.5 s → nosync ~2.5 s。ただし AoS が更新されないのでボットの仕事量が減り、**楽観的すぎる**。区間タイマー側の見積もりを正とする。
- 結論: **計算そのものは既に Rust が速い区間が多い**。ウォーム全体で負けている主因は (1) 残同期、(2) レイド長・遭遇のずれ（equiv で BIAS なしでもハッシュは違う）、(3) hunt が TS よりやや高い、の合成。

##### 残同期を減らした結果

`syncSquads` 内の boss 走査が部隊×敵の二重ループだったのを **敵一回走査**に直し、Σ sync が約 550 ms → 約 320 ms。固定 30 s tick-cost は WASM が TS にほぼ並んだ。これ以上の大きな得は **`stepSquads` 自体を Rust に移して syncSquads を消す**か、ボットが SoA/`robotViews()` を直接読むようにして `pullRobots` を薄くする必要がある。どちらも「ティック移植の延長」ではなく、TS 側の世界観を変える作業。

#### 実験としての結論（更新）

- **粗い単位（fill）**: 得になりうる。  
- **敵 AI の計算**: sense / fightFoe / orbs、および enemies 合計では **Rust の方が速い**（区間タイマー）。「WASM は本来速いはず」は計算部分については正しい。  
- **それでも既定 ON にできない理由**: 毎ティックの `syncSquads` + `pullRobots` が計算の得を食べ、ウォームな全レイドではまだ遅い。同期ゼロでも僅差の見込みで、squad AI と AoS ボットを残したままでは頭打ち。  
- hunt は WASM がやや遅く、Infinity reach を hot path から外した近似も残る。  
- 既定は TypeScript、`RINGFALL_TICK=1` は opt-in のまま。計測は `tick-prof:ringfall` / `tick-cost:ringfall`（実装 PR #155）。

## スイッチと検証コマンド（実装 PR 上）

以下のフラグと npm スクリプトは **#153 / #155 がマージされたあとのツリー**（またはそれらのブランチ）で使える。この lessons 文書だけの checkout では `npm run build:native` 等は未定義。

| フラグ | 効果 |
| --- | --- |
| `RINGFALL_FILL=ts` / `?ringfallNative=0` | WASM 全体オフ（ナビ含む） |
| `RINGFALL_ASTAR=1` | WASM A*（ウォームでは遅い） |
| `RINGFALL_TICK=1` | ティックホスト opt-in（既定 OFF） |
| `RINGFALL_TICK_PROF=1` / `=2` | 区間タイマー（2=細かい TS 区間も） |
| `RINGFALL_TICK_NOSYNC=1` | 同期スキップ（天井計測専用・挙動不正） |

```bash
# 実装 PR（#153 / #155）上でのみ:
npm run build:native
npm run smoke:native
npm run fill:ringfall
npm run bench:ringfall          # 既定 → ハッシュ 83b7a1d3bcf8
npm run equiv:ringfall          # TS vs WASM tick の統計等価
npm run tick-cost:ringfall -- 90
npm run tick-prof:ringfall -- 30
RINGFALL_TICK_PROF=2 npm run tick-prof:ringfall -- 30
```
