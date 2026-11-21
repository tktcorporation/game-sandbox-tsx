# RINGFALL sim 高速化の余地（実測レポート）

試作コードはマージ前提ではない。測定マシン: **4 論理コア**（`nproc`）。基準ハッシュ `83b7a1d3bcf8`（`bench:ringfall` 10 本、`FAR_THINK.every=4`）。PR #149 の Nav キャッシュ等とは別ブランチ `cursor/ringfall-sim-headroom-6332`。

再現:

```bash
npx tsx scripts/headroom/parallel-bench.ts
npx tsx scripts/headroom/far-think-probe.ts
npx tsx scripts/headroom/trials-probe.ts
npx tsx scripts/headroom/algo-probe.ts
npx tsx scripts/headroom/fill-bench.ts
(cd headroom/rust-fill && cargo run --release)
```

---

## 1. 並列化

**独立性:** 腕前×地域の各レイド（および battle 2 本）はシードと入力が自己完結。共有は読み取り専用の地形／Nav フィールドのみ。プロセスを分けても同一入力なら同一 `RaidResult`（ハッシュ一致）。

**実測**（`scripts/headroom/parallel-bench.ts`、fork ワーカー、jobs=10）:

| 方式 | wall | CPU（親 or 合計） | hash |
| --- | --- | --- | --- |
| 直列 | 50.7 s | 66.5 s | `83b7a1d3bcf8` |
| 並列 workers=4 | 31.4 s | 親 0.2 s | `83b7a1d3bcf8` |

- **壁時計 1.62×**、`hashes_match=true`。
- 理想は ~3–4× だが、レイド長が偏る（reservoir beginner ~14 s vs harbor good ~3.5 s）ためロードバランスで頭打ち。
- worker_threads でも同様の壁時計改善が期待できるが、地形・TypedArray の共有コストと、Node の CPU バウンドでは **プロセス並列と大差ない**見込み。
- **工数:** ベンチ／`sim:ringfall` のオーケストレーションだけなら小（半日〜1 日）。ゲーム内ランタイムにはほぼ不要。
- **結果同一性:** レイド単位では完全一致。集計の順序だけ揃えれば表のハッシュも一致。

**予想倍率（全体）:** CI／ローカル表で **1.5–2.5× wall**（コア数とジョブ数に依存）。単一レイドの中は並列化しにくい（共有 State）。

---

## 2. Rust / WASM

### Dial `fill` 最小ベンチ（同一入力・同一 checksum）

合成格子 `800×600`、5 回平均（`scripts/headroom/fill-bench.ts` ↔ `headroom/rust-fill`）:

| 実装 | mean | packed | checksum |
| --- | --- | --- | --- |
| TS | 31.02 ms | 479550 | `61ac29a264056de6` |
| Rust (release, LTO) | 12.71 ms | 479550 | `61ac29a264056de6` |

- **カーネル単独 ≈ 2.4×**。整数 Dial なので決定性は自明（浮動小数なし）。
- 本番の landmark `fill` は **NavStore 温存後はほぼ走らない**。冷えた世界読み込み数秒のうちの一部が対象。ウォーム `bench:ringfall` の ~50–60 s CPU にはほぼ効かない。

### 全体移植の見込み

| 項目 | 見積もり |
| --- | --- |
| ホットパス（fill / findPath / los）だけ WASM | 各 2–4× の可能性。ただし **JS↔WASM を毎ティック呼ぶと境界コストで相殺**しやすい。`los` は TS で ~1.9 µs/回 × 大量呼び出し。 |
| sim 全体を Rust に閉じる | 体感 **1.5–3×** の CPU（V8 が既に TypedArray／整数ホットパスをかなり速い）。 |
| 決定性 | 整数パスは移植容易。`Math.random` 相当はシード RNG をビット一致で移植。浮動小数は加算順を固定すれば現実的（現状も決定的シード）。 |
| 工数 | ホットパス 1 本の FFI: 中（数日）。sim 全体: 大（コード量大・境界設計・二重実装期間）。 |
| 境界 | 入力をまとめて渡す／sim 全体を Rust 側で回す必要あり。セル配列を毎フレームコピーすると **負けうる**。 |

**おすすめ:** 全体 Rust 化は費用対効果が低い。まず並列と TS 側アルゴリズム／FAR_THINK。fill はキャッシュ済みなので優先度低。

---

## 3. アルゴリズム・データ構造

`scripts/headroom/algo-probe.ts`（1 レイド標本 + 合成）:

### FAR_THINK が既に削っている量

1 本の reservoir beginner 標本（~18k tick）:

- enemy スロットの **97.9% が calm_far**
- `every=4` 時点で敵思考回数は every=1 の **~0.27** まで落ちている
- every=8 / 16 にすると理論上さらに 0.14 / 0.08 だが、下の実測どおり **全体 CPU への寄与は限定的**

### `separate` 形状

列ソート掃引 vs 素朴近傍（既にセル粗視化あり）:

| N | naive | sweep | 倍率 |
| --- | --- | --- | --- |
| 40 | 16.0 ms | 9.5 ms | 1.68× |
| 80 | 29.4 | 27.1 | 1.09× |
| 160 | 73.0 | 54.2 | 1.35× |
| 320 | 276.9 | 186.6 | 1.48× |

実戦の walker 数は小さく、**追加の空間ハッシュで期待できるのは数％級**。

### SoA / TypedArray

AoS オブジェクト vs Float64 SoA のマイクロベンチは **SoA が 0.88×（むしろ遅い）**。V8 上では敵オブジェクトの SoA 化は優先度低。パス／距離場の TypedArray 化は既に進行済み（PR #149 系）。

### 理論上の上限（同一性を保つ範囲）

| レバー | 理論 | 実測感 |
| --- | --- | --- |
| レイド並列 | コア数まで | **1.62× / 4c** |
| 遠方 AI 間引き強化 | 敵思考の残り ~1/2 | 全体 **~1.1×**（下記） |
| 差分更新・空間索引 | separate / 近傍クエリ | **~1.05–1.2×** 見込み |
| 全 sim Rust | 定数倍 | **~1.5–3×**、工数大 |

毎ティック全掃引のうち、calm_far は既に間引き済み。残りは engaged／近傍とプレイヤー／味方 bot・物理。

---

## 4. 結果を変える選択肢

### `FAR_THINK.every`（10 レイド bench）

| every | CPU | wall | vs every=4 | hash 同一 |
| --- | ---: | ---: | ---: | --- |
| 1 | 77.3 s | 62.3 s | 1.43× | 否 |
| 2 | 54.2 | 50.7 | 1.01× | 否 |
| **4** | **53.9** | **52.7** | **1.00** | **基準** |
| 8 | 49.1 | 47.5 | **0.91×（~9% 短縮）** | 否 |
| 16 | 56.4 | 54.9 | 1.05× | 否 |

- every=2 と 4 はほぼ同速（既にボトルネックが遠方 AI 以外へ移動）。
- every=16 は **遅くなった**（更新疎で経路／交戦が悪化するノイズの可能性）。結果はすべてハッシュ不一致＝**統計もプレイも変わる**。

### 試行数 `n`（reservoir × 3 skills の 1 表）

| n | wall | cpu | alive% (beg/cas/good) |
| ---: | ---: | ---: | --- |
| 5 | 95.9 s | 107.8 s | 60 / 80 / 60 |
| 10 | 168.3 | 171.2 | 70 / 70 / 70 |
| 12 | 200.2 | 203.5 | 67 / 75 / 75 |
| 20 | 341.7 | 347.5 | 65 / 55 / 75 |
| 30 | 499.1 | 506.7 | 60 / 50 / 77 |

壁時計は **ほぼ n に線形**（n=10→30 で ~3.0×）。alive% は n で数ポイントぶれる。

**fold 分散**（reservoir beginner、4 折り・互いに素なシード）:

| n | folds alive% | mean | sd |
| ---: | --- | ---: | ---: |
| 5 | 60, 80, 100, 80 | 80.0 | **14.1** |
| 10 | 70, 80, 70, 80 | 75.0 | **5.0** |
| 20 | 65, 75, 55, 75 | 67.5 | 8.3 |

目安: n=10→5 で壁時計 **~1.8× 速い**が SD は ~3×。n=20 は折り数が 4 だと SD 自体がまだ揺れる（ここでは 8.3）。既定の **n≈10** が費用対効果の甘い所。n=30 まで伸ばしても表の alive% は数十ポイント級で揺れ続ける。

---

## おすすめの順番

1. **ベンチ／表のプロセス並列**（同一性維持、実測 1.62×、工数小）
2. **TS 側の残りホットパス**（PR #149 継続: Nav／los／bot。同一性維持、累積で十数％級）
3. **試行数の運用**（n=10 前後を既定、急ぐとき n=5。結果のぶれを許容）
4. **`FAR_THINK.every=8` の検討**（~9% だが結果変更。バランス再計測が必要）
5. **Rust 全体移植は後回し**（fill 単体 2.4× でもウォーム bench に効きにくい。全体 1.5–3× 見込み・工数大）

---

## 付録: 成果物

| パス | 内容 |
| --- | --- |
| `scripts/headroom/parallel-bench.ts` | 直列 vs fork 並列 |
| `scripts/headroom/far-think-probe.ts` | `FAR_THINK.every` 掃引 |
| `scripts/headroom/trials-probe.ts` | 試行数と fold 分散 |
| `scripts/headroom/algo-probe.ts` | calm 比率・separate・SoA |
| `scripts/headroom/fill-bench.ts` | TS Dial fill |
| `headroom/rust-fill/` | Rust 同一アルゴリズム |
