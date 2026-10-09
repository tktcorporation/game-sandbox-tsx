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
    decision: "予告された攻撃の矢印を、押し出しでどこへ逸らすか。",
    tags: ["戦術パズル", "1 島 5 ターン"],
    hue: { bg: "#17324d", ink: "#f2ece0", accent: "#e2603f" },
    Game: lazy(() => import("../games/breakwater/Game")),
  },
  {
    id: "wildfire",
    title: "延焼線",
    reading: "えんしょうせん",
    decision: "風が変わる前に、どの森を諦めて防火帯を掘るか。",
    tags: ["リアルタイム", "1 面 約 1 分"],
    hue: { bg: "#2a2420", ink: "#f6e7d0", accent: "#ff8a3d" },
    Game: lazy(() => import("../games/wildfire/Game")),
  },
  {
    id: "abyss",
    title: "深淵採掘",
    reading: "しんえんさいくつ",
    decision: "あと一歩潜るか、ここで引き返して持ち帰るか。",
    tags: ["押し引き", "6 潜行"],
    hue: { bg: "#0f2e2e", ink: "#e8f0e6", accent: "#e8b54a" },
    Game: lazy(() => import("../games/abyss/Game")),
  },
];
