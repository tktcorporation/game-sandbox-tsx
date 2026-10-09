/**
 * Headless sim for 防波堤. Compares three players on the same islands:
 *   idle    — ends every turn without acting
 *   random  — random legal move + action per unit
 *   greedy  — tries every unit order, each unit picks its best (move, action)
 *             by looking one tide ahead. No search across turns.
 * A human with undo and preview should land between greedy and perfect.
 */
import {
  act, ALLY_SPEC, DIRS, endTurn, moveAlly, newIsland, reachable, rest, stars,
  type Ally, type State,
} from "../../src/games/breakwater/logic";

type Policy = (s: State, roll: () => number) => State;

const allies = (s: State) => s.actors.filter((a): a is Ally => a.side === "ally");

function score(s: State): number {
  const after = endTurn(s).at(-1)!.state;
  if (after.phase === "lost") return -1000 + after.power * 10;
  let v = after.power * 12 + after.kills * 2;
  for (const a of after.actors) v += a.side === "ally" ? 3 * a.hp + 4 : -a.hp;
  return v;
}

function options(s: State, id: number): State[] {
  const a = s.actors.find((o) => o.id === id) as Ally;
  const spots = [{ x: a.x, y: a.y }, ...reachable(s, a, ALLY_SPEC[a.kind].move)];
  const out: State[] = [];
  for (const p of spots) {
    const moved = p.x === a.x && p.y === a.y ? s : moveAlly(s, id, p.x, p.y);
    out.push(rest(moved, id));
    for (const d of DIRS) out.push(act(moved, id, d).state);
  }
  return out;
}

const idle: Policy = (s) => s;

const random: Policy = (s, roll) => {
  for (const a of allies(s)) {
    if (!s.actors.some((o) => o.id === a.id) || s.phase !== "player") continue;
    const opts = options(s, a.id);
    s = opts[Math.floor(roll() * opts.length)];
  }
  return s;
};

const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
const greedy: Policy = (s0) => {
  let best = s0;
  let bestV = score(s0);
  for (const perm of perms) {
    const ids = allies(s0).map((a) => a.id);
    let s = s0;
    for (const i of perm) {
      if (ids[i] === undefined || !s.actors.some((a) => a.id === ids[i])) continue;
      let pick = s;
      let pv = -Infinity;
      for (const o of options(s, ids[i])) {
        const v = score(o);
        if (v > pv) { pv = v; pick = o; }
      }
      s = pick;
    }
    const v = score(s);
    if (v > bestV) { bestV = v; best = s; }
  }
  return best;
};

function play(island: number, seed: number, policy: Policy) {
  let r = seed * 7919 + 1;
  const roll = () => ((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let s = newIsland(island, seed);
  while (s.phase === "player") {
    s = policy(s, roll);
    if (s.phase !== "player") break;
    s = endTurn(s).at(-1)!.state;
  }
  return { won: s.phase === "won", power: s.power, stars: stars(s), round: s.round };
}

const runs = Number(process.argv[2] ?? 40);
const islands = (process.argv[3] ?? "1,3,6").split(",").map(Number);
const only = process.argv[4];
const policies = ([["idle", idle], ["random", random], ["greedy", greedy]] as [string, Policy][]).filter(([n]) => !only || n === only);
console.log(`islands × policy, ${runs} seeds each. stars: 0=lost`);
console.log("island policy   win%  ★0   ★1   ★2   ★3   avg power left");
for (const island of islands) {
  for (const [name, p] of policies) {
    const st = [0, 0, 0, 0];
    let wins = 0;
    let pw = 0;
    for (let i = 0; i < runs; i++) {
      const r = play(island, 1000 + i, p);
      st[r.stars]++;
      if (r.won) wins++;
      pw += r.power;
    }
    const pct = (n: number) => `${Math.round((n / runs) * 100)}%`.padStart(4);
    console.log(`${String(island).padStart(6)} ${name.padEnd(7)} ${pct(wins)} ${st.map(pct).join(" ")}   ${(pw / runs).toFixed(1)}`);
  }
}
