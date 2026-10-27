# RINGFALL のフィールドの測り方

場所（POI や地区）を作ったり変えたりしたときに、戦う地面としてどう変わったかを数字と地図で見るための決めごと。`npm run field:ringfall` が測り、`npm run look:ringfall` が同じ測定を場所の基準と比べる。

測るのは sim が使うデータそのもので、見た目からの推測ではない。遮蔽物はロボットが隠れる地点（`sim/cover.ts` の `COVERS`）、見通しはロボットの視線と弾が使う判定（`sim/geom.ts` の `rayWorld`）。フェンスは視線も弾も通すので、遮蔽物にも視線を遮るものにも数えない。

## 測るもの

場所の中心から `--r`（既定 120 m）の内側にある、4 m 間隔の歩ける地点を測る。海、高地、崖、箱の中の地点は除く。

| 項目 | 意味 | 基準の値 |
| --- | --- | --- |
| cover within 8 m | 同じ高さの遮蔽物が 8 m 以内にある地点の割合 | 8 m はスプリント（7.6 m/s）でおよそ 1 秒 |
| cover median | 遮蔽物までの距離の中央値 | 40 m 以内に無い地点は 40 m と数える |
| sight median | 立った目の高さから 16 方向へ水平に見て、箱か地面に当たるまでの距離の中央値 | 120 m で打ち切る |
| looks past 56 m | 16 方向の視線のうち 56 m より先まで通る割合 | 56 m は grunt の交戦中の視界（`SIGHT.grunt.range × AWARE.engagedRange`） |
| exposed | 8 m 以内に遮蔽物が無く、16 方向の半分以上が 56 m より先まで通る地点の割合 | 遠くから撃たれ、逃げ込む所も無い開けた地面 |

数字に合否は無い。開けた港のように、見通しの良さを狙った場所もあるからだ。場所を変える前に基準を取り、変えた後に数字がどちらへ動いたかを、狙いと照らして確かめる。

## 使い方

```bash
npm run field:ringfall -- <場所> [--r 120]   # 1 か所を数秒で。地図は shots/ringfall/field/<場所>.png
npm run field:ringfall -- --all              # 全 POI を 1 行ずつ
npm run look:ringfall -- <場所> --base       # 変える前に、画面・世界・フィールドの基準を取る
npm run look:ringfall -- <場所>              # 変えた後に、基準からの動きを見る
```

地図（`field.png`）は左が遮蔽物までの距離（8 m 以内は緑、40 m に向けて黄から赤）、右が見通し（短いと濃い青、56 m を超えると白）。赤い枠の地点が exposed。暗い灰色は箱。

look は数字を基準と並べて出す（例: `coverMedian 6.4 -> 6.2`）。測り方を変えたとき（`ringfall-look.ts` の `fieldMeta.version`）や `--r` が基準と違うときは、比べずに NOT COMPARED と出す。

## 今の測定

`npm run field:ringfall -- --all`（半径 120 m）。

| POI | 地点 | cover within 8 m | cover median | sight median | looks past 56 m | exposed |
| --- | --: | --: | --: | --: | --: | --: |
| supply | 2569 | 59% | 6.4 m | 25 m | 26% | 15% |
| quarry | 2291 | 55% | 7.1 m | 29 m | 31% | 18% |
| relay | 2541 | 39% | 11.3 m | 44 m | 39% | 27% |
| pad | 2160 | 63% | 5.9 m | 42 m | 39% | 21% |
| wreck | 2601 | 40% | 10.8 m | 62 m | 47% | 40% |
| yard | 2504 | 42% | 9.9 m | 50 m | 45% | 32% |
| smelter | 2408 | 51% | 7.7 m | 56 m | 44% | 30% |
| station | 2350 | 29% | 16.1 m | 60 m | 47% | 42% |
| waterworks | 2195 | 38% | 12.1 m | 43 m | 36% | 26% |
| lodge | 2223 | 31% | 14.4 m | 41 m | 37% | 21% |
| cannery | 2632 | 42% | 9.7 m | 60 m | 47% | 39% |
| coldstore | 2582 | 43% | 9.9 m | 64 m | 50% | 41% |

貯水池の POI（supply、quarry、pad）は exposed が 15〜21% で、港の POI（wreck、station、cannery、coldstore）は 40% 前後になる。港の塩田の広い平地がそのまま出ている。
