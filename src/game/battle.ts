import { SPECIES, typeMultiplier } from "./species";
import type { BattleLogEntry, BattleResult, SquadMonster } from "./types";

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function name(m: SquadMonster): string {
  return `${SPECIES[m.speciesId].emoji}${SPECIES[m.speciesId].name}`;
}

export function squadPower(squad: SquadMonster[]): number {
  return squad.reduce((sum, m) => sum + m.hp + m.atk * 3 + m.def * 2, 0);
}

/**
 * Deterministic lane battle: front fighters from each side trade blows until one falls,
 * then the next steps up. Seeded so a battle can be replayed identically from its seed.
 */
export function simulateBattle(mySquad: SquadMonster[], theirSquad: SquadMonster[], seed: number): BattleResult {
  const rand = mulberry32(seed);
  const mine = mySquad.map((m) => ({ ...m, curHp: m.hp }));
  const theirs = theirSquad.map((m) => ({ ...m, curHp: m.hp }));
  const log: BattleLogEntry[] = [];
  const MAX_ROUNDS = 200;

  let mi = 0;
  let ti = 0;
  let rounds = 0;

  log.push({ text: "対戦開始!", side: "system" });

  while (mi < mine.length && ti < theirs.length && rounds < MAX_ROUNDS) {
    rounds += 1;
    const a = mine[mi];
    const b = theirs[ti];

    const dmgToB = Math.max(
      1,
      Math.round(a.atk * typeMultiplier(a.element, b.element) * (0.85 + rand() * 0.3) - b.def * 0.5),
    );
    b.curHp -= dmgToB;
    log.push({ text: `${name(a)} の攻撃! ${name(b)} に ${dmgToB} ダメージ`, side: "mine" });
    if (b.curHp <= 0) {
      log.push({ text: `${name(b)} は倒れた…`, side: "system" });
      ti += 1;
      continue;
    }

    const dmgToA = Math.max(
      1,
      Math.round(b.atk * typeMultiplier(b.element, a.element) * (0.85 + rand() * 0.3) - a.def * 0.5),
    );
    a.curHp -= dmgToA;
    log.push({ text: `${name(b)} の反撃! ${name(a)} に ${dmgToA} ダメージ`, side: "theirs" });
    if (a.curHp <= 0) {
      log.push({ text: `${name(a)} は倒れた…`, side: "system" });
      mi += 1;
    }
  }

  const myRemainingHp = mine.slice(mi).reduce((s, m) => s + Math.max(0, m.curHp), 0);
  const theirRemainingHp = theirs.slice(ti).reduce((s, m) => s + Math.max(0, m.curHp), 0);

  let won: boolean;
  if (mi < mine.length && ti >= theirs.length) won = true;
  else if (ti < theirs.length && mi >= mine.length) won = false;
  else won = myRemainingHp >= theirRemainingHp;

  log.push({ text: won ? "勝利!" : "敗北…", side: "system" });

  return { won, log, myRemainingHp, theirRemainingHp, reward: 0 };
}
