import { CONQUEST, FRONT, VALUABLES, type ValuableKind } from "./config";
import { battleFocus, meterOf } from "./battle";
import { dist2d } from "./geom";
import { CAMP, DEPOTS, EXTRACTS, NODES, POIS, poiIndex, recordSpot, regionHere, type PoiId, type RecordId, type RegionId } from "./map";
import { frontNodes } from "./front";
import { haulOrigins } from "./world";
import { squadKey, type State } from "./state";

/*
 * The raid's objective as an ordered list of steps (`objectiveSteps()`): what to do now, what
 * finishes it, and where. The objective card, the beacon, the compass marker, the bot and the
 * sim gate all read this one list.
 */

/**
 * What the raid is out to do, as the sim sees it: a node to take by its core, a valuable to bring
 * from a POI's bins, a squad to destroy (by `squadKey()`), or a story record to bring home. The contracts (meta/contracts.ts)
 * and the story give a raid one.
 */
export type Task =
  | { t: "capture"; node: number }
  | { t: "fetch"; poi: PoiId; kind: ValuableKind; n: number }
  | { t: "intercept"; key: string; name: string; region: RegionId; at?: { x: number; z: number } }
  | { t: "record"; id: RecordId };

/** A point a step leads to: the beacon stands there and the compass points at it. */
export interface Spot {
  x: number;
  y: number;
  z: number;
}

/** One step: what to do, what finishes it, how far it has gone (when it counts), where (null for anywhere), and whether it is done. */
export interface Step {
  /** What sort of step: walk somewhere, start a core's capture, hold the core, do the task's deed there, explore, or get off. */
  kind: "go" | "start" | "hold" | "act" | "explore" | "extract";
  label: string;
  until: string;
  progress?: string;
  at: Spot | null;
  done: boolean;
  /** The prompt shown on reaching `at`. */
  near?: string;
}

/** An objective: its title and its steps, the current one being the first not done (`steps.length` once all are). */
export interface Objective {
  title: string;
  steps: Step[];
  current: number;
}

/** Metres from a step's spot at which "go there" counts as arrived. */
export const ARRIVE = 40;

const ground = (x: number, z: number, y = 0): Spot => ({ x, y, z });

/**
 * The nearest way home from where the player stands: a way off of the region they are in (the
 * plateau's only with a flare), a depot on, or the camp's yard in the reservoir.
 */
export function nearestExit(s: State): Spot {
  const p = s.player.pos;
  const region = regionHere(p);
  const ways: Spot[] = [
    ...EXTRACTS.filter((x) => region.exits.includes(x.id) && (!x.needsFlare || s.player.flares > 0)).map((x) => ground(x.x, x.z)),
    ...DEPOTS.filter((d, i) => s.depots[i] && regionHere(d).id === region.id).map((d) => ground(d.x, d.z, d.y)),
    ...(region.id === "reservoir" ? [ground((CAMP.x0 + CAMP.x1) / 2, (CAMP.z0 + CAMP.z1) / 2, CAMP.y)] : []),
  ];
  return ways.reduce((a, b) => (dist2d(b, p) < dist2d(a, p) ? b : a));
}

/** The last step of every objective: off the island alive. */
const extractStep = (s: State): Step => ({
  kind: "extract",
  label: "生きて脱出する",
  until: "脱出地点・起動した中継ボックス・野営地のどれかで帰る",
  at: s.phase === "play" ? nearestExit(s) : null,
  done: s.outcome === "extracted",
});

/** Marks each step done when it or any later one is, so the steps fall in order. */
function settle(title: string, steps: Step[]): Objective {
  for (let k = steps.length - 2; k >= 0; k--) if (steps[k + 1].done) steps[k].done = true;
  const current = steps.findIndex((st) => !st.done);
  return { title, steps, current: current < 0 ? steps.length : current };
}

/** The steps of taking node `i` by its core. */
function captureSteps(s: State, i: number, title: string): Objective {
  const n = NODES[i];
  const core = ground(n.core.x, n.core.z, n.core.y);
  const freed = s.nodes[i] === "freed";
  const under = s.capture?.node === i;
  const c = under ? s.capture : null;
  const front = frontNodes(s.nodes)[i];
  return settle(title, [
    { kind: "go", label: `${n.name}へ向かう`, until: `核の ${ARRIVE} m 以内に着く`, at: core, done: freed || under || dist2d(s.player.pos, core) < ARRIVE },
    { kind: "start", label: "核を起動する", until: front || freed ? "核に触れて使用キー（警報が鳴る）" : "前線の拠点ではない：敵に守られている", at: core, done: freed || under, near: "核に触れて制圧を始める" },
    {
      kind: "hold",
      label: "核を守り抜く",
      until: `核の ${FRONT.radius} m 以内にとどまる・ロボットがいないこと`,
      progress: c ? `${Math.floor(c.t)}/${FRONT.capture} 秒${c.held ? "" : "（止まっている）"}` : `0/${FRONT.capture} 秒`,
      at: core,
      done: freed,
      near: `核の ${FRONT.radius} m 以内にとどまる`,
    },
    extractStep(s),
  ]);
}

/** The squads (by index) that count for a task destroyed under `key`, with members left. */
const squadsUnder = (s: State, key: string) => s.squads.map((q, k) => ({ q, k })).filter(({ q, k }) => squadKey(q) === key && s.enemies.some((e) => e.squad === k));

/** The steps of holding node `i`, the player's, against the squads coming to take it (sim/battle.ts). */
function defendSteps(s: State, i: number): Objective {
  const n = NODES[i];
  const core = ground(n.core.x, n.core.z, n.core.y);
  const m = s.battle ? meterOf(s.battle, i) : null;
  const near = s.enemies.filter((e) => e.battle && dist2d(e.pos, n.core) < CONQUEST.zone * 2).length;
  const coming = !!s.battle && s.battle.squads.some((q) => q.side !== 0 && q.to === i && q.task === "attack");
  const held = s.nodes[i] === "freed";
  return settle(`陣取り戦：${n.name}を守る`, [
    { kind: "go", label: `${n.name}へ向かう`, until: `核の ${ARRIVE} m 以内に着く`, at: core, done: !held || !coming || dist2d(s.player.pos, core) < ARRIVE },
    {
      kind: "act",
      label: "攻めてくる部隊を追い払う",
      until: `核の ${CONQUEST.zone} m 以内に立ち、近づくロボットを倒す`,
      progress: !held ? "取られた" : m ? `敵が制圧中 ${Math.round(m.share * 100)}%` : near ? `敵 ${near} 体` : undefined,
      at: core,
      done: !held || !coming,
      near: `核の ${CONQUEST.zone} m 以内で守る`,
    },
    extractStep(s),
  ]);
}

/**
 * The raid's objective now: a capture under way comes first, then the task the raid was given,
 * then in the day's battle the node it most wants the player at (one of theirs being taken, or
 * one their own robots are taking, `battleFocus()`), then the last node taken (its way out), and
 * with none of those the nearest node on the front in the region the player is in (its capture),
 * or else to explore and get off.
 */
export function objectiveSteps(s: State, task: Task | null = null): Objective {
  if (s.capture && s.nodes[s.capture.node] !== "freed") return captureSteps(s, s.capture.node, `${NODES[s.capture.node].name}の制圧`);
  if (task) return taskSteps(s, task);
  const focus = s.phase === "play" ? battleFocus(s) : null;
  if (focus?.kind === "defend") return defendSteps(s, focus.node);
  if (focus?.kind === "attack") return captureSteps(s, focus.node, `陣取り戦：自軍と${NODES[focus.node].name}を取る`);
  const last = s.stats.captured[s.stats.captured.length - 1];
  if (last) return captureSteps(s, NODES.findIndex((n) => n.id === last), `${NODES.find((n) => n.id === last)?.name}の制圧`);
  const front = frontNodes(s.nodes);
  const region = regionHere(s.player.pos).id;
  const near = NODES.map((n, i) => ({ n, i }))
    .filter(({ n, i }) => front[i] && n.region === region)
    .sort((a, b) => dist2d(a.n.core, s.player.pos) - dist2d(b.n.core, s.player.pos))[0];
  if (near) return captureSteps(s, near.i, `前線：${near.n.name}を取る`);
  return settle("探索して脱出する", [
    { kind: "explore", label: "島を探索する", until: "回収品を 1 つ持つ", at: null, done: s.player.haul.length > 0 || s.sent.length > 0 },
    extractStep(s),
  ]);
}

/** The steps of a given task. */
function taskSteps(s: State, task: Task): Objective {
  const p = s.player.pos;
  switch (task.t) {
    case "capture":
      return captureSteps(s, task.node, `${NODES[task.node].name}の解放`);
    case "fetch": {
      const i = poiIndex(task.poi);
      const poi = POIS[i];
      const got = [...haulOrigins(s.player).map((from, n) => ({ kind: s.player.haul[n], from })), ...s.sent.map((kind, n) => ({ kind, from: s.sentAt[n] ?? -1 }))].filter((v) => v.kind === task.kind && v.from === i).length;
      const bins = s.bins.filter((b) => !b.open && s.fetch?.bins.includes(b.id));
      const bin = bins.sort((a, b) => dist2d(a, p) - dist2d(b, p))[0];
      return settle(`${VALUABLES[task.kind].label}の回収`, [
        { kind: "go", label: `${poi.name}へ向かう`, until: `${poi.name}に入る`, at: ground(poi.x, poi.z), done: got > 0 || dist2d(p, poi) < poi.trigger },
        { kind: "act", label: `${poi.name}の補給箱を開ける`, until: `${VALUABLES[task.kind].label}を ${task.n} 個見つける`, progress: `${Math.min(got, task.n)}/${task.n}`, at: bin ? ground(bin.x, bin.z, bin.y) : null, done: got >= task.n, near: "補給箱を調べる" },
        extractStep(s),
      ]);
    }
    case "intercept": {
      const live = squadsUnder(s, task.key);
      const members = s.enemies.filter((e) => live.some(({ k }) => k === e.squad));
      const lead = members.sort((a, b) => dist2d(a.pos, p) - dist2d(b.pos, p))[0];
      const at = lead ? ground(lead.pos.x, lead.pos.z) : task.at ? ground(task.at.x, task.at.z) : null;
      const beaten = s.stats.wiped.includes(task.key);
      return settle(`${task.name}の迎撃`, [
        { kind: "go", label: "相手のいる辺りへ向かう", until: `${ARRIVE} m 以内に近づく`, at, done: beaten || (!!at && dist2d(p, at) < ARRIVE) },
        { kind: "act", label: `${task.name}を全滅させる`, until: "最後の 1 体まで倒す", progress: members.length ? `残り ${members.length}` : undefined, at, done: beaten },
        extractStep(s),
      ]);
    }
    case "record": {
      const r = recordSpot(task.id);
      const held = s.player.records.includes(task.id) || s.sentRecords.includes(task.id);
      const at = ground(r.x, r.z, r.y);
      return settle(`記録：${r.name}`, [
        { kind: "go", label: `${r.place}へ向かう`, until: `${ARRIVE} m 以内に着く`, at, done: held || dist2d(p, at) < ARRIVE },
        { kind: "act", label: `${r.name}を拾う`, until: "記録に重なって拾う（バッグ 1 枠）", at, done: held, near: `${r.name}を拾う` },
        extractStep(s),
      ]);
    }
  }
}

/** The current step, or null once every step is done. */
export const currentStep = (o: Objective): Step | null => o.steps[o.current] ?? null;
