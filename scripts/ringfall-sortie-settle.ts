/**
 * The meta of sorties to neighbours' holdings (docs/ringfall/holdings-raid.md, meta/sortie.ts):
 *
 * - **targets**: a new profile's islands next door (the game's own) list their holdings, each
 *   one's owner marked AI, with the defence and the trophy odds.
 * - **win**: a sortie that takes the core and ends alive scores ★★★ (+N trophies), brings the
 *   holding's 島の守り home, records the holding as taken, and leaves the player's own island,
 *   depots, ways in and explored map as they were.
 * - **regrow**: a holding taken is no target for `SORTIE_META.regrow` days, then is again.
 * - **lose**: a sortie wiped with the defence untouched scores 0★ (−M) and records nothing.
 * - **saves**: a v48 save loads as v49 with nothing taken; `raided` survives a round trip.
 *
 * `checkSortieSettle()` gives the sim gate's error, or null; run alone with
 * `npx tsx scripts/ringfall-sortie-settle.ts`.
 */
import { NODES, nodeIndex } from "../src/ringfall/sim/map";
import { FRONT, TICK } from "../src/ringfall/sim/config";
import { useCore } from "../src/ringfall/sim/front";
import { idleInput, newRun, starterKit, type State } from "../src/ringfall/sim/state";
import { step } from "../src/ringfall/sim/step";
import { withAi } from "../src/ringfall/meta/ai-islands";
import { newProfile, parseProfile, settle, type Profile } from "../src/ringfall/meta/profile";
import { SORTIE_META, sortieStart, sortieTargets, type SortieTarget } from "../src/ringfall/meta/sortie";
import { TROPHY } from "../src/ringfall/meta/trophies";

const SALT = 4242;
const NOW = Date.UTC(2026, 10, 27, 3);

const targets = (p: Profile, day = p.day): SortieTarget[] => sortieTargets(withAi([], SALT, day, NOW), SALT, day, p.trophies ?? TROPHY.start, p.raided);

/** A sortie to `t` played out: the defence cleared, the core taken if `take`, then idle until it ends (or wiped if `wipe`). */
function play(t: SortieTarget, take: boolean, wipe = false): State {
  const s = newRun(77, starterKit(), "reservoir", { sortie: sortieStart(t) });
  const node = nodeIndex(t.id);
  if (wipe) {
    s.player.hp = 0;
    s.player.shield = 0;
    s.player.selfRevive = 0;
    s.ally.active = false;
    s.phase = "done";
    s.outcome = "dead";
    return s;
  }
  s.enemies = [];
  if (take) {
    const c = NODES[node].core;
    s.player.pos = { x: c.x + 2, y: c.y, z: c.z };
    useCore(s, node);
  }
  const spot = { ...s.player.pos };
  for (let i = 0; i < 400 / TICK && s.phase === "play"; i++) {
    step(s, idleInput(), false);
    s.player.pos = { ...spot };
    s.player.hp = 1e7;
  }
  return s;
}

function parts(): { name: string; err: string | null; line: string }[] {
  const out: { name: string; err: string | null; line: string }[] = [];
  const p0 = newProfile(9);
  const list = targets(p0);
  {
    const owners = new Set(list.map((t) => t.owner));
    const err = !list.length
      ? "no holding to attack"
      : list.some((t) => !t.ai || !t.owner.startsWith("ai-") || !t.ownerName.includes("AI"))
        ? "a holding not marked AI"
        : list.some((t) => t.win <= 0 || t.lose <= 0)
          ? "a holding with no trophy odds"
          : null;
    out.push({ name: "targets", err, line: `${list.length} holdings of ${owners.size} islands; first ${list[0]?.title} (工場 ${list[0]?.factory}, 守り +${list[0]?.guard}, +${list[0]?.win}/−${list[0]?.lose})` });
  }
  const t = list[0]!;
  {
    const s = play(t, true);
    const r = settle(p0, s);
    const p1 = r.profile;
    const trop = (p1.trophies ?? 0) - (p0.trophies ?? 0);
    const island = JSON.stringify(p0.poiState) === JSON.stringify(p1.poiState);
    const err =
      s.outcome !== "extracted"
        ? `outcome ${s.outcome}`
        : r.trophies?.stars !== 3
          ? `stars ${r.trophies?.stars}`
          : trop !== t.win
            ? `trophies ${trop >= 0 ? "+" : ""}${trop}, not +${t.win}`
            : !island
              ? "the player's island changed"
              : p1.depots.includes(t.id) && !p0.depots.includes(t.id) && p0.poiState[t.id]?.state !== "own"
                ? "the holding's depot came on at home"
                : p1.entries.join() !== p0.entries.join()
                  ? "ways in changed"
                  : p1.seen !== p0.seen
                    ? "the explored map changed"
                    : p1.retaken.length
                      ? `retaken ${p1.retaken.join()}`
                      : !p1.raided.some((x) => x.owner === t.owner && x.id === t.id)
                        ? "the holding is not recorded"
                        : p1.stash.length <= p0.stash.length
                          ? "nothing came home"
                          : null;
    out.push({ name: "win", err, line: `★${r.trophies?.stars} trophies +${trop}, stash ${p0.stash.length}→${p1.stash.length}, day ${p0.day}→${p1.day}` });

    // regrow
    const gone = targets(p1).some((x) => x.owner === t.owner && x.id === t.id);
    const back = targets(p1, p0.day + SORTIE_META.regrow).some((x) => x.owner === t.owner && x.id === t.id);
    out.push({ name: "regrow", err: gone ? "the holding taken is still a target" : !back ? `not a target again after ${SORTIE_META.regrow} days` : null, line: `gone the next day, back on day ${p0.day + SORTIE_META.regrow}` });

    // saves
    const round = parseProfile(JSON.parse(JSON.stringify(p1)));
    const old = parseProfile({ ...JSON.parse(JSON.stringify(p0)), v: 48, raided: undefined });
    const err2 = !round || round.v !== 49 || round.raided.length !== p1.raided.length ? "raided lost on a round trip" : !old || old.v !== 49 || old.raided.length ? "a v48 save does not load clean" : null;
    out.push({ name: "saves", err: err2, line: `v${round?.v}, raided ${round?.raided.length}` });
  }
  // home: the player's own 島の守り at the same POI stays home when the neighbour's holding is taken.
  {
    const home = { ...p0, parcels: [{ id: 901, poi: t.id, kind: "board" as const, from: { code: "", name: "" }, at: 0 }] };
    const s = play(t, true);
    // Something left at the neighbour's depot in the sortie.
    s.leftParcels = [{ poi: t.id, kind: "gyro" }];
    const r = settle(home, s);
    const kept = r.profile.parcels.some((q) => q.id === 901);
    const added = r.profile.parcels.filter((q) => q.id !== 901).length;
    const err = !kept ? "the player's own 島の守り at that POI was seized" : added ? `${added} 島の守り added at home from the neighbour's depot` : null;
    out.push({ name: "home", err, line: `home parcel at ${t.id} ${kept ? "kept" : "gone"}, ${added} added` });
  }
  {
    const s = play(t, false, true);
    const r = settle(p0, s);
    const trop = (r.profile.trophies ?? 0) - (p0.trophies ?? 0);
    const err = r.trophies?.stars !== 0 ? `stars ${r.trophies?.stars}` : trop !== -t.lose ? `trophies ${trop}, not −${t.lose}` : r.profile.raided.length ? "a lost sortie recorded a holding" : null;
    out.push({ name: "lose", err, line: `★0 trophies ${trop}` });
  }
  void FRONT;
  return out;
}

export function checkSortieSettle(): string | null {
  for (const p of parts()) if (p.err) return `sortie settle ${p.name}: ${p.err}`;
  return null;
}

if (process.argv[1]?.endsWith("ringfall-sortie-settle.ts")) {
  let bad = 0;
  for (const p of parts()) {
    console.log(`${p.err ? "FAIL" : "ok  "} ${p.name.padEnd(8)} ${p.line}${p.err ? ` — ${p.err}` : ""}`);
    if (p.err) bad++;
  }
  process.exit(bad ? 1 : 0);
}
