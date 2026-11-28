/**
 * The sortie set out from a core during a raid of the island (sim/jump.ts, `State.jumps`):
 *
 * - **offer**: at a core of the player's named in `Start.jumps` the use key pushes `sortieOut`; at a
 *   core not named, at the enemy's core, or with no `jumps`, it does not.
 * - **out**: the sortie's run is played at the same node as the other player's, from its depot,
 *   with the health, weapons, heals, bag and keys the player carried; the raid of the island
 *   stands still meanwhile (its clock and robots untouched).
 * - **back**: a sortie ended alive hands back what the player then carries (what it added to the
 *   bag has no POI of this island) and the raid goes on; a wipe there ends the raid as a wipe,
 *   the island's battle reckoned to its end.
 * - **settle**: `settleSortie()` moves the trophies by the stars and records the holding taken,
 *   and counts no raid nor brings anything carried home.
 * - **targets**: `jumpTargets()` offers at most `JUMP.choices` players, all holding that node.
 *
 * `checkJump()` gives the sim gate's error, or null; run alone with `npx tsx scripts/ringfall-jump.ts`.
 */
import { islandDay } from "../src/ringfall/meta/days";
import { withAi } from "../src/ringfall/meta/ai-islands";
import { newProfile, settleSortie } from "../src/ringfall/meta/profile";
import { JUMP, jumpNodes, jumpTargets, sortieStart, sortieTargets } from "../src/ringfall/meta/sortie";
import { TROPHY } from "../src/ringfall/meta/trophies";
import { FRONT, TICK } from "../src/ringfall/sim/config";
import { useCore } from "../src/ringfall/sim/front";
import { dist2d } from "../src/ringfall/sim/geom";
import { jumpBack, jumpOut } from "../src/ringfall/sim/jump";
import { DEPOTS, depotIndex, NODES, nodeIndex, type NodeId } from "../src/ringfall/sim/map";
import { idleInput, newRun, starterKit, type State } from "../src/ringfall/sim/state";
import { step } from "../src/ringfall/sim/step";
import { useCandidates } from "../src/ringfall/sim/world";

const SALT = 4242;
const NOW = Date.UTC(2026, 10, 27, 3);
const HOME: NodeId = "waterworks";
const OWNER = "ai-TEST1";

/** A raid of the island with `HOME` the player's, the player stood at its core with no robot about. */
function atCore(jumps?: NodeId[], own: NodeId[] = [HOME]): State {
  const s = newRun(53, starterKit(), "reservoir", { island: Object.fromEntries(own.map((id) => [id, "own"])), ...(jumps ? { jumps } : {}) });
  const c = NODES[nodeIndex(HOME)].core;
  s.enemies = [];
  s.player.pos = { x: c.x + 2, y: c.y, z: c.z };
  s.player.vel = { x: 0, y: 0, z: 0 };
  return s;
}

const offered = (s: State) => useCandidates(s).some((c) => c.t.kind === "jump");

/** One tick with the use key down: the events pushed. */
function press(s: State): string[] {
  step(s, { ...idleInput(), interact: true }, false);
  return s.events.map((e) => e.t);
}

function parts(): { name: string; err: string | null; line: string }[] {
  const out: { name: string; err: string | null; line: string }[] = [];
  const target = { id: HOME, owner: OWNER, factory: 1, aid: 0, N: 30, M: 10 };

  // offer
  {
    const yes = atCore([HOME]);
    const none = atCore();
    const other = atCore(["supply"]);
    const foe = atCore([HOME], []);
    const pressed = press(atCore([HOME]));
    const err = !offered(yes)
      ? "no sortie offered at a core named in jumps"
      : offered(none)
        ? "a sortie offered with no jumps"
        : offered(other)
          ? "a sortie offered at a core not named"
          : offered(foe)
            ? "a sortie offered at the enemy's core"
            : !pressed.includes("sortieOut")
              ? `the use key pushed ${pressed.join(",") || "nothing"}, not sortieOut`
              : press(atCore()).includes("sortieOut")
                ? "sortieOut pushed with no jumps"
                : null;
    out.push({ name: "offer", err, line: "the use key at a named core of the player's pushes sortieOut; elsewhere it does not" });
  }

  // out
  {
    const s = atCore([HOME]);
    s.player.hp = 61;
    s.player.haul = ["board", "fuse"];
    s.player.haulAt = [3, -1];
    s.player.heals.cell = 5;
    const time = s.time;
    const robots = s.enemies.length;
    const o = jumpOut(s, target, []);
    const depot = DEPOTS[depotIndex(HOME)];
    for (let i = 0; i < 2 / TICK && o.phase === "play"; i++) step(o, idleInput(), false);
    const err = !o.sortie || o.sortie.node !== nodeIndex(HOME) || o.sortie.owner !== OWNER
      ? "the run is no sortie at the same node"
      : dist2d(o.player.pos, depot) > 12
        ? `starts ${dist2d(o.player.pos, depot).toFixed(1)} m from the holding's depot`
        : o.player.haul.join() !== "board,fuse" || o.player.heals.cell !== 5
          ? `carried ${o.player.haul.join()} and ${o.player.heals.cell} cells`
          : o.player.hp > 61.5
            ? `health ${o.player.hp}, not the 61 carried`
            : s.time !== time || s.enemies.length !== robots || s.phase !== "play"
              ? "the raid of the island moved while the sortie was played"
              : o.jumps.length
                ? "a sortie offers a sortie"
                : null;
    out.push({ name: "out", err, line: `the sortie starts ${dist2d(o.player.pos, depot).toFixed(1)} m from the depot with the bag carried; the island's clock stands at ${time.toFixed(1)} s` });
  }

  // back
  {
    const s = atCore([HOME]);
    s.player.haul = ["board"];
    s.player.haulAt = [3];
    const at = { ...s.player.pos };
    const o = jumpOut(s, target, []);
    o.player.haul.push("gyro");
    o.player.haulAt.push(0);
    o.player.hp = 40;
    o.phase = "done";
    o.outcome = "extracted";
    const on = jumpBack(s, o);
    // Down as the sortie's time ran out: back at the core still down, the revive owed.
    const d = atCore([HOME]);
    const fell = jumpOut(d, target, []);
    fell.player.hp = 0;
    fell.player.downed = 7;
    fell.phase = "done";
    fell.outcome = "extracted";
    jumpBack(d, fell);
    const w = atCore([HOME]);
    const dead = jumpOut(w, target, []);
    dead.phase = "done";
    dead.outcome = "dead";
    const gone = jumpBack(w, dead);
    // A raid with a battle: the wipe reckons the rest of it, as any raid's end does.
    const b = newRun(53, starterKit(), "reservoir", { island: { [HOME]: "own" }, jumps: [HOME], battle: { factory: 1 } });
    const lost = jumpOut(b, target, []);
    lost.phase = "done";
    lost.outcome = "dead";
    jumpBack(b, lost);
    const err = !on || s.phase !== "play"
      ? "the raid did not go on after a sortie ended alive"
      : s.player.haul.join() !== "board,gyro" || s.player.haulAt.join() !== "3,-1"
        ? `bag ${s.player.haul.join()} from ${s.player.haulAt.join()}`
        : s.player.hp !== 40
          ? `health ${s.player.hp}, not the 40 brought back`
          : dist2d(s.player.pos, at) > 0.01
            ? "the player is not back where they left"
            : d.player.downed !== 7 || d.phase !== "play"
              ? "a player down as the sortie ended came back standing"
            : gone || w.phase !== "done" || w.outcome !== "dead"
              ? "a wipe in the sortie did not end the raid as a wipe"
              : !b.battle?.done
                ? "a wipe in the sortie left the island's battle not reckoned to its end"
              : null;
    out.push({ name: "back", err, line: "alive: the bag and health come back and the raid goes on; wiped: the raid ends a wipe" });
  }

  // settle
  {
    const p = newProfile(9);
    const s = atCore([HOME]);
    const o = jumpOut(s, target, []);
    o.enemies = [];
    const node = nodeIndex(HOME);
    const c = NODES[node].core;
    o.player.pos = { x: c.x + 2, y: c.y, z: c.z };
    useCore(o, node);
    for (let i = 0; i < (FRONT.capture + 5) / TICK && o.phase === "play" && !o.stats.captured.includes(HOME); i++) {
      step(o, idleInput(), false);
      o.player.hp = 1e7;
    }
    o.player.haul = ["reactor"];
    o.phase = "done";
    o.outcome = "extracted";
    const r = settleSortie(p, o);
    const reactors = (q: typeof p) => q.stash.filter((i) => i.t === "valuable" && i.kind === "reactor").length;
    const err = !o.stats.captured.includes(HOME)
      ? "the core was not taken"
      : r.profile.raids !== p.raids || r.profile.seed !== p.seed
        ? "a sortie from a core counted as a raid"
        : (r.profile.trophies ?? TROPHY.start) <= (p.trophies ?? TROPHY.start)
          ? "the core taken moved no trophies"
          : !r.profile.raided?.some((x) => x.owner === OWNER && x.id === HOME)
            ? "the holding taken was not recorded"
            : reactors(r.profile) !== reactors(p)
              ? "what the player carries came home with the sortie"
              : null;
    out.push({ name: "settle", err, line: `core taken: trophies ${p.trophies ?? TROPHY.start} → ${r.profile.trophies ?? TROPHY.start}, raids ${r.profile.raids}, the bag stays with the player` });
  }

  // targets
  {
    const p = newProfile(9);
    const day = islandDay(p) + 6;
    const all = sortieTargets(withAi([], SALT, day, NOW), SALT, day, p.trophies ?? TROPHY.start, []);
    const nodes = jumpNodes(all);
    const bad = nodes.find((id) => {
      const t = jumpTargets(all, id);
      return !t.length || t.length > JUMP.choices || t.some((x) => x.id !== id) || new Set(t.map((x) => x.owner)).size !== t.length;
    });
    const err = !nodes.length ? "no node of the islands next door to set out against" : bad ? `the targets from ${bad} are wrong` : null;
    out.push({ name: "targets", err, line: `${nodes.length} nodes to set out from, ${Math.max(0, ...nodes.map((id) => jumpTargets(all, id).length))} players at most from one` });
  }
  return out;
}

export function checkJump(): string | null {
  const bad = parts().find((q) => q.err);
  return bad ? `jump ${bad.name}: ${bad.err}` : null;
}

if (process.argv[1]?.endsWith("ringfall-jump.ts")) {
  let failed = false;
  for (const q of parts()) {
    console.log(`${q.err ? "FAIL" : "ok  "} ${q.name}: ${q.err ?? q.line}`);
    failed ||= !!q.err;
  }
  process.exit(failed ? 1 : 0);
}
