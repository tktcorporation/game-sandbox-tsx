/**
 * Headless check that walking an elemental patch actually biases catches.
 *
 *   npx tsx scripts/sim/tata-stroll.ts [runs=2000]
 *
 * Prints, per patch, how often an encounter is of that patch's element,
 * for an empty dex and for a half-full one.
 */
import { initialState, mulberry32, stroll, STROLL_PATCHES } from "../../src/games/tata/logic";
import { SPECIES, speciesOf } from "../../src/games/tata/species";

const runs = Number(process.argv[2] ?? 2000);
const rng = mulberry32(99);

function rate(ownedIds: string[]): string {
  const base = initialState();
  const owned = SPECIES.filter((s) => ownedIds.includes(s.id)).map((s) => ({
    uid: s.id,
    speciesId: s.id,
    stage: 0 as const,
    shiny: false,
    xp: 0,
    bond: 0,
    power: 0,
    lastPetAt: 0,
    partySlot: null,
  }));
  return STROLL_PATCHES.map((p, i) => {
    let hits = 0;
    let encounters = 0;
    for (let r = 0; r < runs; r++) {
      const state = { ...base, stamina: 8, tatas: owned };
      const res = stroll(state, Math.floor(rng() * 1e9), i);
      if (res.find.kind !== "tata") continue;
      encounters += 1;
      if (speciesOf(res.find.speciesId).element === p.element) hits += 1;
    }
    return `${p.element.padEnd(6)} ${Math.round((hits / encounters) * 100)}%`;
  }).join("  ");
}

console.log(`share of encounters matching the patch element (${runs} strolls per patch)`);
const ids = (n: number) => SPECIES.slice(0, n).map((s) => s.id);
const allOf = (el: string) => SPECIES.filter((s) => s.element === el).map((s) => s.id);
console.log(`empty dex      : ${rate([])}`);
console.log(`60 owned       : ${rate(ids(60))}`);
console.log(`all fire owned : ${rate(allOf("fire"))}`);
