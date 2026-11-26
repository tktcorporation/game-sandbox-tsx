/*
 * TKT-204 案 C: first-time multiplayer guide gate.
 * Run: `npx tsx scripts/ringfall-mp-howto.ts`
 */
import { holdsContested, shouldShowMpHowto } from "../src/ringfall/meta/mp-howto";
import { blankIsland, newIsland } from "../src/ringfall/meta/island";
import { MP_HOWTO_CARDS, TERM } from "../src/ringfall/view/copy";

const empty = blankIsland();
if (holdsContested(empty)) throw new Error("foe island should not hold contested");
if (shouldShowMpHowto(empty)) throw new Error("should not show without contested own");

// New profiles start with sea-route shores → howto can show from day 1.
if (!holdsContested(newIsland())) throw new Error("newIsland should hold starting shores");
if (!shouldShowMpHowto(newIsland())) throw new Error("should show howto on new island");

const own = { ...empty, station: { state: "own" as const } };
if (!holdsContested(own)) throw new Error("station own is contested hold");
// localStorage may be missing in Node — shouldShow uses try/catch; treat as not seen.
if (!shouldShowMpHowto(own)) throw new Error("should show when holding contested and unseen");

if (MP_HOWTO_CARDS.length !== 3) throw new Error(`cards ${MP_HOWTO_CARDS.length}`);
if (MP_HOWTO_CARDS[0]!.title !== TERM.seaIslands) throw new Error("card1 title");
if (!MP_HOWTO_CARDS[0]!.body.includes("地図")) throw new Error("card1 map");
if (MP_HOWTO_CARDS[1]!.title !== TERM.attack) throw new Error("card2 title");
if (MP_HOWTO_CARDS[2]!.title !== TERM.captureCore) throw new Error("card3 title");
if (!MP_HOWTO_CARDS[2]!.body.includes(TERM.trophy)) throw new Error("card3 trophy");
if (!MP_HOWTO_CARDS[2]!.body.includes(TERM.revenge)) throw new Error("card3 revenge");
if (!MP_HOWTO_CARDS[2]!.body.includes(TERM.team)) throw new Error("card3 team");

console.log("mp howto ok", MP_HOWTO_CARDS.map((c) => c.title).join(" → "));
