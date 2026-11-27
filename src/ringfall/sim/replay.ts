/*
 * 攻めの記録（docs/ringfall/glossary.md 攻め）: a sortie keeps where its attacker went and what
 * happened, so the holding's owner can watch it in 島の知らせ. Recording only: no rule reads it, it
 * draws on no random numbers, and a raid without a sortie records nothing.
 *
 * The path is the attacker's ground position every `REPLAY.every` seconds, in whole metres; the
 * marks are the moments worth a pin (the core's capture begun and done, a defender down, the
 * attacker down, the end). Small enough to travel with the raid's report.
 */
import { NODES } from "./map";
import type { State } from "./state";
import { REPLAY, type Replay, type ReplayMark } from "./replay-data";

export { REPLAY, type Replay, type ReplayMark } from "./replay-data";

const at = (x: number) => Math.round(x);

/** A fresh record for a sortie at node `node`. */
export const newReplay = (node: number): Replay => ({ node: NODES[node].id, every: REPLAY.every, path: [], marks: [] });

/** One tick of the record: a point when one is due, a mark for each moment this tick's events tell. */
export function stepReplay(s: State) {
  const r = s.replay;
  if (!r) return;
  const p = s.player.pos;
  const t = Math.round(s.time);
  const mark = (k: ReplayMark["k"], x: number, z: number) => {
    if (r.marks.length < REPLAY.marks) r.marks.push({ t, k, x: at(x), z: at(z) });
  };
  if (r.path.length / 2 < REPLAY.points && s.time >= (r.path.length / 2) * r.every) r.path.push(at(p.x), at(p.z));
  for (const e of s.events) {
    if (e.t === "coreStart") mark("core", NODES[e.node].core.x, NODES[e.node].core.z);
    else if (e.t === "coreTaken") mark("taken", NODES[e.node].core.x, NODES[e.node].core.z);
    else if (e.t === "kill") mark("fall", e.pos.x, e.pos.z);
    else if (e.t === "down") mark("down", p.x, p.z);
  }
  if (s.phase === "done" && r.marks.at(-1)?.k !== "end") {
    if (r.marks.length >= REPLAY.marks) r.marks.pop();
    r.marks.push({ t, k: "end", x: at(p.x), z: at(p.z) });
  }
}
