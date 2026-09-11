/**
 * Headless balance sim for モンスターサバイバル battles.
 *
 *   npx tsx scripts/sim/tata-battle.ts [runs=200]
 *
 * Each reference party is run against raids whose theme it counters
 * ("matched"), raids it neither counters nor is weak to ("neutral"), and raids
 * whose theme preys on it ("weak"). Compare the table against
 * .claude/skills/game-design-loop/references/tata-targets.md before and after
 * touching any number in src/games/tata/{logic,battle,species}.ts.
 */
import { buildRaid, TataBattle, wavesClearedOf, type Raid } from "../../src/games/tata/battle";
import { elementMod, hatchTata, mulberry32 } from "../../src/games/tata/logic";
import { SPECIES } from "../../src/games/tata/species";
import { ELEMENTS, type Element, type OwnedTata, type PartySlot, type Role, type Species, type Stage } from "../../src/games/tata/types";

interface Member {
  role: Role;
  stage: Stage;
  power?: number;
}

export interface Scenario {
  name: string;
  party: Member[];
  lantern?: boolean;
}

export const SCENARIOS: Scenario[] = [
  { name: "start (dps+tank, st1)", party: [{ role: "dps", stage: 1 }, { role: "tank", stage: 1 }] },
  { name: "start + 1 catch (st0)", party: [{ role: "dps", stage: 1 }, { role: "tank", stage: 1 }, { role: "dps", stage: 0 }] },
  { name: "fed (st2 x2 + st1)", party: [{ role: "dps", stage: 2 }, { role: "tank", stage: 2 }, { role: "dps", stage: 1 }] },
  { name: "mid (st2 x3, pw3)", party: [{ role: "dps", stage: 2, power: 3 }, { role: "tank", stage: 2, power: 3 }, { role: "dps", stage: 2, power: 3 }] },
  { name: "late (st3 x3, pw6)", party: [{ role: "dps", stage: 3, power: 6 }, { role: "tank", stage: 3, power: 6 }, { role: "dps", stage: 3, power: 6 }] },
];

type Matchup = "matched" | "neutral" | "weak";

/** elements the player would pick for this raid under each matchup */
function elementsFor(raid: Raid, m: Matchup): Element[] {
  const theme: Element[] = [raid.primary, raid.secondary];
  if (m === "matched") return ELEMENTS.filter((e) => elementMod(e, raid.primary) > 1);
  if (m === "weak") return ELEMENTS.filter((e) => elementMod(raid.primary, e) > 1);
  return ELEMENTS.filter((e) => theme.every((z) => elementMod(e, z) === 1 && elementMod(z, e) === 1));
}

/** cheapest common species of the wanted element and role (rarity 1 first) */
function pickSpecies(element: Element, role: Role, nth: number): Species {
  const pool = SPECIES.filter((sp) => sp.element === element && sp.rarity <= 2).sort(
    (a, b) => Number(b.role === role) - Number(a.role === role) || a.rarity - b.rarity,
  );
  return pool[nth % pool.length]!;
}

export function buildParty(members: Member[], raid: Raid, m: Matchup): OwnedTata[] {
  const els = elementsFor(raid, m);
  return members.slice(0, 3).map((mem, i) => {
    const el = els[i % els.length]!;
    const t = hatchTata(pickSpecies(el, mem.role, i).id, false);
    t.stage = mem.stage;
    t.power = mem.power ?? 0;
    t.partySlot = i as PartySlot;
    return t;
  });
}

export function runOne(party: OwnedTata[], raid: Raid, lantern = false): { waves: number; won: boolean; seconds: number } {
  const b = new TataBattle(party, lantern, raid);
  const dt = 1 / 30;
  let guard = 0;
  while (!b.over && guard < 30 * 600) {
    b.tick(dt);
    guard += 1;
  }
  return { waves: wavesClearedOf(b), won: b.won, seconds: b.time };
}

interface Row {
  hist: number[];
  n: number;
  wins: number;
  secs: number;
}

function emptyRow(): Row {
  return { hist: new Array(6).fill(0), n: 0, wins: 0, secs: 0 };
}

export function runScenario(sc: Scenario, runs: number): Record<Matchup, Row> {
  const rng = mulberry32(1234);
  const rows: Record<Matchup, Row> = { matched: emptyRow(), neutral: emptyRow(), weak: emptyRow() };
  for (let i = 0; i < runs; i++) {
    const raid = buildRaid(Math.floor(rng() * 1e9));
    for (const m of ["matched", "neutral", "weak"] as Matchup[]) {
      const party = buildParty(sc.party, raid, m);
      const r = runOne(party, raid, sc.lantern);
      const row = rows[m];
      row.hist[r.waves] += 1;
      row.n += 1;
      if (r.won) row.wins += 1;
      row.secs += r.seconds;
    }
  }
  return rows;
}

function fmt(row: Row): string {
  if (row.n === 0) return "  (no raids)";
  const cols = row.hist.map((c) => `${Math.round((c / row.n) * 100)}%`.padStart(6)).join("");
  return cols + `${Math.round((row.wins / row.n) * 100)}%`.padStart(7) + (row.secs / row.n).toFixed(0).padStart(6);
}

function main() {
  const runs = Number(process.argv[2] ?? 200);
  console.log(`raids per cell: ${runs}   (columns = waves cleared)`);
  console.log("scenario / matchup".padEnd(36) + [0, 1, 2, 3, 4, 5].map((w) => `w${w}`.padStart(6)).join("") + "   win%  avg s");
  for (const sc of SCENARIOS) {
    const rows = runScenario(sc, runs);
    console.log(sc.name);
    for (const m of ["matched", "neutral", "weak"] as Matchup[]) {
      console.log(`  ${m}`.padEnd(36) + fmt(rows[m]));
    }
  }
}

main();
