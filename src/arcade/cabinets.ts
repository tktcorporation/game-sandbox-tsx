import { lazy, type ComponentType, type LazyExoticComponent } from "react";

/**
 * The arcade's only registry. A cabinet is a lazily loaded component plus the
 * copy the lobby needs; adding a game means adding one entry here.
 */
export interface Cabinet {
  id: string;
  title: string;
  reading: string;
  /** The one decision the game is built around, in a sentence. */
  decision: string;
  tags: string[];
  hue: { bg: string; ink: string; accent: string };
  Game: LazyExoticComponent<ComponentType>;
}

export const CABINETS: Cabinet[] = [
  {
    id: "breakwater",
    title: "防波堤",
    reading: "ぼうはてい",
    decision: "敵の攻撃は予告どおりに来る。押して、矢印の先をずらす。",
    tags: ["戦術パズル", "1 島 5 ターン"],
    hue: { bg: "#1b2733", ink: "#e9eef2", accent: "#ff5b45" },
    Game: lazy(() => import("../games/breakwater/Game")),
  },
  {
    id: "wildfire",
    title: "延焼線",
    reading: "えんしょうせん",
    decision: "次の風を読んで、どの森を諦めるか決める。",
    tags: ["リアルタイム", "1 面 約 1 分"],
    hue: { bg: "#23251f", ink: "#eef0e8", accent: "#ff7a3d" },
    Game: lazy(() => import("../games/wildfire/Game")),
  },
  {
    id: "abyss",
    title: "深淵採掘",
    reading: "しんえんさいくつ",
    decision: "もう 1 枚めくるか、ここで浮上するか。",
    tags: ["押し引き", "6 潜行"],
    hue: { bg: "#121a22", ink: "#e6eef5", accent: "#49e0b0" },
    Game: lazy(() => import("../games/abyss/Game")),
  },
];
