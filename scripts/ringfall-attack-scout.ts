/*
 * TKT-204 案 B: attack scout list for the departure screen.
 * Run: `npx tsx scripts/ringfall-attack-scout.ts`
 */
import { attackScouts, revengeNode, revengeNodeFromLine } from "../src/ringfall/meta/attack-scout";
import { TROPHY } from "../src/ringfall/meta/trophies";
import type { Neighbour } from "../src/ringfall/meta/neighbours";
import { newIsland, type Island } from "../src/ringfall/meta/island";
import {
  TERM,
  attackScoutDef,
  attackScoutTrop,
  attackGoal,
  attackCapturePrompt,
  attackCapturing,
  attackSeized,
  newsIncursion,
} from "../src/ringfall/view/copy";
import { revengeable } from "../src/ringfall/meta/expeditions";

const OWN = ["supply", "quarry", "relay", "station", "lodge", "yard", "smelter", "cannery", "coldstore"] as const;

const poiState: Island = {
  ...newIsland(),
  ...Object.fromEntries(OWN.map((id) => [id, { state: "own" as const }])),
  waterworks: { state: "rival:TTHKQB" },
  robotworks: { state: "rival:ai-AK7M2X" },
};

const neighbours: Neighbour[] = [
  { code: "TTHKQB", name: "ツバキ", held: 7, total: 22, day: 18, slot: 1, trophies: 1060, factory: 3 },
  { code: "AK7M2X", name: "カゲウツ", held: 9, total: 21, day: 20, slot: 0, trophies: 1151, factory: 2, ai: true },
];

const rows = attackScouts(poiState, 14, neighbours, TROPHY.start, [], 0, { x: 0, z: 500 });
if (!rows.length) throw new Error("expected attack scouts");
const water = rows.find((r) => r.id === "waterworks");
if (!water) throw new Error("waterworks missing");
if (water.title !== "ツバキの浄水場") throw new Error(`title ${water.title}`);
if (!water.onFront) throw new Error("waterworks should be on front (station held)");
if (water.factory !== 3) throw new Error(`factory ${water.factory}`);
if (water.trop < 1) throw new Error(`trop ${water.trop}`);
if (attackGoal(water.title) !== "ツバキの浄水場を攻める") throw new Error("attackGoal");
if (!attackScoutDef(water.factory, water.guard).includes("工場")) throw new Error("scout def");
if (!attackScoutTrop(water.win, water.lose).includes("トロフィー")) throw new Error("scout trop");
if (!attackScoutTrop(water.win, water.lose).includes(`+${water.win}`)) throw new Error("scout trop +N");
if (!attackScoutTrop(water.win, water.lose).includes(`−${water.lose}`)) throw new Error("scout trop −M");
// TKT-219: winBonus is league ★★★ materials (銅 at start → 1).
if (typeof water.winBonus !== "number" || water.winBonus < 0) throw new Error("winBonus");

const ai = rows.find((r) => r.id === "robotworks");
if (!ai) throw new Error("robotworks missing");
if (!ai.ownerName.includes("AI")) throw new Error(`AI label ${ai.ownerName}`);
if (!ai.title.includes(" · AI")) throw new Error(`AI title ${ai.title}`);

const taken = { seq: 1, at: 0, t: "taken" as const, node: "waterworks" as const, by: { code: "TTHKQB", name: "ツバキ" } };
if (!revengeable(taken)) throw new Error("revengeable");
if (revengeNode(poiState, taken) !== "waterworks") throw new Error("revengeNode");
const line = "ツバキに浄水場を取られた · 島の守りがツバキの倉庫へ";
if (revengeNodeFromLine(poiState, line) !== "waterworks") throw new Error("revengeNodeFromLine");
if (TERM.revenge !== "やり返す") throw new Error("TERM.revenge");
const cleared = { ...poiState, waterworks: { state: "own" as const } };
if (revengeNodeFromLine(cleared, line) !== null) throw new Error("revenge gone after retake");

if (attackCapturePrompt(water.title) !== "ツバキの浄水場を攻める") throw new Error("attackCapturePrompt");
if (attackCapturing(water.title) !== "ツバキの浄水場を制圧") throw new Error("attackCapturing");
if (attackSeized(water.title) !== "ツバキの浄水場を制圧した") throw new Error("attackSeized");
const seized = newsIncursion("ツバキ", "浄水場", true, 33);
if (!seized.includes("を制圧した") || seized.includes("を取った")) throw new Error(`newsIncursion ${seized}`);

console.log("attack scout ok", rows.map((r) => `${r.title} front=${r.onFront} trop=+${r.trop}`).join(" | "));
console.log("revenge ok");
console.log("attack result copy ok", seized);
