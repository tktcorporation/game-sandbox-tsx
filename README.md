# Sandbox Arcade

判断をひとつずつ中心に据えた、3 台のブラウザゲーム。設計と UI は、モダンなゲーム 30 本から抽出した原則（[`docs/game-essence.md`](docs/game-essence.md)）に寄せている。React 19 + TypeScript の SPA を、1 つの Cloudflare Worker が配信する。進行はブラウザの `localStorage` にだけ保存する。

| ゲーム | 中心の判断 | 形式 |
| --- | --- | --- |
| **防波堤** | 予告された攻撃の矢印を、押し出しでどこへ逸らすか | ターン制の戦術パズル。島ごとに 5 ターン守る |
| **延焼線** | 風が変わる前に、どの森を諦めて防火帯を掘るか | リアルタイム（一時停止可）。1 面約 1 分 |
| **深淵採掘** | あと一歩潜るか、引き返して持ち帰るか | 押し引き。6 回潜った合計が得点 |

## 開発

```bash
npm install
npm run dev                      # http://localhost:5173
npm run build                    # 型チェック + ビルド。変更の検証ゲート
npm run sim -- breakwater 30     # ヘッドレスシム（breakwater | wildfire | abyss）
npm run deploy                   # build + wrangler deploy
```

テストランナーは無い。各ゲームのロジックは React を含まない純粋関数で、`scripts/sim/` のシムが数値の回帰確認を兼ねる。

## 構成

```
src/App.tsx                 ハッシュルーター（#/ がロビー、#/<id> がゲーム）
src/arcade/cabinets.ts      ゲームの登録簿。ゲームを足すときはここに 1 件足す
src/arcade/Lobby.tsx        ロビー
src/arcade/Frame.tsx        各ゲーム共通の戻るボタンと見出し
src/arcade/rng.ts           状態に 1 つの整数で持てるシード付き乱数
src/arcade/save.ts          localStorage の読み書き（使えない環境でも動く）
src/arcade/sfx.ts           WebAudio で合成する効果音（状態変化ごとに別の音）
src/arcade/juice.ts         結果の大きさに比例する画面の揺れ、数え上げ
src/arcade/Previews.tsx     ロビーのカードで各ゲームの本物のロジックを動かす
src/games/<id>/logic.ts     ゲームのルール（純粋関数）
src/games/<id>/Game.tsx     画面
scripts/sim/<id>.ts         ヘッドレスシム
worker/index.ts             静的配信と /api/health
```

各ゲームは `React.lazy` で読み込むので、ロビーを開いた時点では遊ばないゲームのコードを読まない。
