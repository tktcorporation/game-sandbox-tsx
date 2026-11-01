import type { Enemy, State } from "./state";

/*
 * Each squad's robots, in the order of `s.enemies`, for the systems that ask for a squad's
 * members once per squad or per member every tick (`calm()`, `stepSquads()`, the walks' and
 * parties' steps). `s.enemies` changes only by a push (a robot spawned) or by a new list (one
 * destroyed; a robot of the battle's pushed and at once popped into `s.friends` is seen by no
 * one in between), and a robot never changes squad, so the lists hold until its length or identity
 * changes.
 */
let membersFrom: Enemy[] | null = null;
let membersLength = -1;
const bySquad = new Map<number, Enemy[]>();
const NO_MEMBERS: Enemy[] = [];
/** The robots of squad `squad`, as `s.enemies.filter((o) => o.squad === squad)` gives them. Read only. */
export function squadMembers(s: State, squad: number): readonly Enemy[] {
  if (membersFrom !== s.enemies || membersLength !== s.enemies.length) {
    membersFrom = s.enemies;
    membersLength = s.enemies.length;
    bySquad.clear();
    for (const o of s.enemies) {
      const list = bySquad.get(o.squad);
      if (list) list.push(o);
      else bySquad.set(o.squad, [o]);
    }
  }
  return bySquad.get(squad) ?? NO_MEMBERS;
}
