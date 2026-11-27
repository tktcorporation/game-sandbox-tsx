/**
 * A sortie to a neighbour's holding (docs/ringfall/holdings-raid.md, `Start.sortie`):
 *
 * - **start**: the raid starts at the holding's depot, in its region, with that depot on; no way in is learned.
 * - **alone**: only the owner's defence stands (their factory's kinds and the 島の守り grunts), round the core,
 *   as robots of that owner; no beat, walk, pack, roamer, party, reinforcement or raider.
 * - **bins**: only the holding's own bins and floor loot are there.
 * - **core**: the holding's core is capturable (it is not on the player's front); no siege comes to it;
 *   taking it with the defence gone gives ★2 territory in `State.attack`.
 * - **time**: the sortie ends alive when its time runs out (`sortieUp`), and when the player walks off (`sortieLeft`).
 * - **none**: a raid without `sortie` has none of it (the gate's raids play as before).
 *
 * `checkSortie()` gives the sim gate's error, or null; run this file alone
 * (`npx tsx scripts/ringfall-sortie.ts`) for each part's lines.
 */
import { DEFENCE_AID, defenceKinds } from "../src/ringfall/sim/island";
import { DEPOTS, depotIndex, NODES, nodeIndex, POIS, poiIndex, poiRegion, type NodeId } from "../src/ringfall/sim/map";
import { capturable, useCore } from "../src/ringfall/sim/front";
import { DEPOT, FRONT, SORTIE, TICK } from "../src/ringfall/sim/config";
import { idleInput, newRun, starterKit, type State } from "../src/ringfall/sim/state";
import { step } from "../src/ringfall/sim/step";
import { objectiveSteps } from "../src/ringfall/sim/objective";
import { dist2d } from "../src/ringfall/sim/geom";

const OWNER = "ai-TEST1";
const TARGET: NodeId = "waterworks";

const sortie = (id: NodeId = TARGET, factory = 2, aid = 2): State =>
  newRun(31, starterKit(), "reservoir", { sortie: { id, owner: OWNER, factory, aid, N: 30, M: 10 } });

/** Steps `s` idle for up to `limit` seconds (or until `done`), the player kept alive where it stands; the events seen. */
function run(s: State, limit: number, hold = true, done: () => boolean = () => false): string[] {
  const seen: string[] = [];
  const spot = { ...s.player.pos };
  for (let i = 0; i < limit / TICK && s.phase === "play"; i++) {
    step(s, idleInput(), false);
    for (const e of s.events) seen.push(e.t);
    if (hold) s.player.pos = { ...spot };
    s.player.hp = 1e7;
    if (done()) break;
  }
  return seen;
}

function parts(): { name: string; err: string | null; line: string }[] {
  const out: { name: string; err: string | null; line: string }[] = [];
  const poi = poiIndex(TARGET);
  const node = nodeIndex(TARGET);
  const depot = DEPOTS[depotIndex(TARGET)];

  // start
  {
    const s = sortie();
    const d = dist2d(s.player.pos, depot);
    const err =
      s.region !== poiRegion(TARGET).id
        ? `region ${s.region}, not the holding's ${poiRegion(TARGET).id}`
        : d > DEPOT.back + 1
          ? `starts ${d.toFixed(1)} m from the holding's depot`
          : !s.depots[depotIndex(TARGET)]
            ? "the holding's depot is off"
            : s.found.length
              ? `learns ways in ${s.found.join(",")}`
              : !s.sortie || s.sortie.node !== node
                ? "no sortie on the state"
                : null;
    out.push({ name: "start", err, line: `${d.toFixed(1)} m from the depot, region ${s.region}` });
  }

  // alone
  {
    const s = sortie(TARGET, 2, 5);
    const want = defenceKinds(2).length + DEFENCE_AID;
    const core = NODES[node].core;
    const far = s.enemies.filter((e) => dist2d(e.pos, core) > 12);
    const notRival = s.enemies.filter((e) => e.rival !== OWNER);
    const timers = [s.reinforceT, s.raiderT].filter((t) => Number.isFinite(t));
    const err =
      s.enemies.length !== want
        ? `${s.enemies.length} robots stand, not the owner's ${want}`
        : far.length
          ? `${far.length} robots stand off the core`
          : notRival.length
            ? `${notRival.length} robots are not the owner's`
            : s.parties.length
              ? `${s.parties.length} hunting parties`
              : timers.length
                ? "reinforcement or raider clocks run"
                : null;
    // A minute on: nothing more has come.
    const before = s.enemies.length;
    const seen = run(s, 60);
    const clears = seen.filter((t) => t === "poiClear" || t === "titanDown").length;
    const later =
      s.enemies.length > before
        ? `${s.enemies.length - before} more robots came in a minute`
        : clears || s.stats.cleared.length
          ? `${clears} clear events, ${s.stats.cleared.length} POIs counted cleared with the defence standing`
          : null;
    out.push({ name: "alone", err: err ?? later, line: `${s.enemies.length} robots (${defenceKinds(2).join("+")} +${DEFENCE_AID} grunts), parties ${s.parties.length}` });
  }

  // bins
  {
    const s = sortie();
    const elsewhere = s.bins.filter((b) => b.poi !== poi);
    const own = POIS[poi].bins.length;
    const err = elsewhere.length ? `${elsewhere.length} bins of other POIs` : s.bins.length !== own ? `${s.bins.length} bins, not the holding's ${own}` : null;
    out.push({ name: "bins", err, line: `${s.bins.length} bins, ${s.loot.length} floor loot` });
  }

  // core
  {
    const s = sortie();
    const ok = capturable(s, node);
    const others = NODES.filter((_, i) => i !== node && capturable(s, i)).length;
    // The defence gone, the player on the core: the capture fills with no siege.
    s.enemies = [];
    const core = NODES[node].core;
    s.player.pos = { x: core.x + 2, y: core.y, z: core.z };
    useCore(s, node);
    const seen = run(s, FRONT.capture + 10, true, () => s.nodes[node] === "own");
    const siege = seen.filter((t) => t === "siegeWarn" || t === "siegeLand").length;
    const title = objectiveSteps(s).title;
    const err = !ok
      ? "the holding's core is not capturable"
      : others
        ? `${others} other cores capturable`
        : s.nodes[node] !== "own"
          ? "the core was not taken"
          : siege
            ? `${siege} siege events`
            : !s.stats.captured.includes(TARGET)
              ? "the capture is not counted"
              : !title.includes("攻める")
                ? `objective "${title}"`
                : null;
    out.push({ name: "core", err, line: `taken at ${Math.round(s.time)} s, siege events ${siege}, objective "${title}"` });
  }

  // time
  {
    const s = sortie();
    s.enemies = [];
    const seen = run(s, SORTIE.time + 5);
    const t = Math.round(s.time);
    const err = s.phase !== "done" || s.outcome !== "extracted" ? `phase ${s.phase} outcome ${s.outcome} at ${t} s` : !seen.includes("sortieUp") ? "no sortieUp" : Math.abs(t - SORTIE.time) > 1 ? `ended at ${t} s` : null;
    out.push({ name: "time", err, line: `ended at ${t} s, ${s.outcome}` });

    const w = sortie();
    w.enemies = [];
    const core = NODES[node].core;
    // Out past the leave line, away from the core.
    const dx = depot.x - core.x;
    const dz = depot.z - core.z;
    const l = Math.hypot(dx, dz) || 1;
    const r = w.sortie!.leave + 5;
    const x = core.x + (dx / l) * r;
    const z = core.z + (dz / l) * r;
    w.player.pos = { x, y: w.player.pos.y, z };
    const left = run(w, 2);
    const err2 = w.outcome !== "extracted" || !left.includes("sortieLeft") ? `walking off: outcome ${w.outcome}` : null;
    out.push({ name: "leave", err: err2, line: `leave line ${Math.round(w.sortie!.leave)} m from the core` });
  }

  // none
  {
    const s = newRun(31, starterKit(), "reservoir");
    const err = s.sortie !== null ? "a plain raid has a sortie" : s.enemies.length < 40 ? `a plain raid stands ${s.enemies.length} robots` : null;
    out.push({ name: "none", err, line: `plain raid: ${s.enemies.length} robots, ${s.bins.length} bins` });
  }
  return out;
}

export function checkSortie(): string | null {
  for (const p of parts()) if (p.err) return `sortie ${p.name}: ${p.err}`;
  return null;
}

if (process.argv[1]?.endsWith("ringfall-sortie.ts")) {
  let bad = 0;
  for (const p of parts()) {
    console.log(`${p.err ? "FAIL" : "ok  "} ${p.name.padEnd(6)} ${p.line}${p.err ? ` — ${p.err}` : ""}`);
    if (p.err) bad++;
  }
  process.exit(bad ? 1 : 0);
}
