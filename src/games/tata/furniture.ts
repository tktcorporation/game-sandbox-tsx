import type { FurnitureDef } from "./types";

export const FURNITURE: Record<FurnitureDef["id"], FurnitureDef> = {
  nest: {
    id: "nest",
    name: "すやすやベッド",
    w: 1,
    h: 1,
    scrap: 4,
    blurb: "タタがおひるね。きのみがゆっくり貯まる。",
  },
  pool: {
    id: "pool",
    name: "ぽちゃプール",
    w: 2,
    h: 1,
    scrap: 8,
    blurb: "水遊び。ネコオリを入れると…？",
  },
  snack: {
    id: "snack",
    name: "おやつ台",
    w: 1,
    h: 1,
    scrap: 5,
    blurb: "えさやりのきのみが1つお得。",
  },
  lantern: {
    id: "lantern",
    name: "ほたる灯籠",
    w: 1,
    h: 1,
    scrap: 6,
    blurb: "光のタタが次の戦いで少し強い。",
  },
  garden: {
    id: "garden",
    name: "おはな畑",
    w: 1,
    h: 1,
    scrap: 5,
    blurb: "ふれあいで草のタタがきのみを拾う。",
  },
  bounce: {
    id: "bounce",
    name: "ぴょんマット",
    w: 1,
    h: 1,
    scrap: 7,
    blurb: "ふれあいでなつきやすい。",
  },
};

export const FURNITURE_ORDER: FurnitureDef["id"][] = [
  "nest",
  "pool",
  "snack",
  "lantern",
  "garden",
  "bounce",
];
