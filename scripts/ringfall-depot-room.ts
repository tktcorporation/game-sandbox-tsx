/**
 * 中継ボックス stash room: partial send, full → leave with bag, sim gate omits room (unlimited).
 * Run: `npx tsx scripts/ringfall-depot-room.ts`
 */
import { DEPOT } from "../src/ringfall/sim/config";
import { newRun, starterKit, idleInput } from "../src/ringfall/sim/state";
import { DEPOTS, depotIndex } from "../src/ringfall/sim/map";
import { step } from "../src/ringfall/sim/step";
import { depotInReach } from "../src/ringfall/sim/world";

const errors: string[] = [];
const check = (ok: boolean, what: string) => {
  if (!ok) errors.push(what);
};

const PAD = depotIndex("pad");
const d = DEPOTS[PAD]!;

function atDepot(room: number) {
  const s = newRun(9, starterKit(), "reservoir", { depots: ["pad"], stashRoom: room, stashWant: { reactor: 1 } });
  s.depots[PAD] = true;
  s.player.pos = { x: d.x, y: d.y, z: d.z };
  s.player.haul = ["wire", "reactor", "parts"];
  s.player.haulAt = [-1, -1, -1];
  s.player.tools = [];
  s.phase = "play";
  return s;
}

// Unlimited (sim gate default): send all
{
  const s = newRun(9, starterKit(), "reservoir", { depots: ["pad"] });
  s.depots[PAD] = true;
  s.player.pos = { x: d.x, y: d.y, z: d.z };
  s.player.haul = ["wire", "parts"];
  s.player.haulAt = [-1, -1];
  const inp = idleInput();
  inp.interact = true;
  step(s, inp, false);
  check(s.sent.length === 2 && s.player.haul.length === 0, `unlimited sent ${s.sent.length} left ${s.player.haul.length}`);
  check(s.stashRoom === Infinity, "unlimited stashRoom");
}

// Room 1: send wanted reactor first, leave 2 in bag
{
  const s = atDepot(1);
  const inp = idleInput();
  inp.interact = true;
  step(s, inp, false);
  check(s.sent.length === 1 && s.sent[0] === "reactor", `room1 sent ${JSON.stringify(s.sent)}`);
  check(s.player.haul.length === 2, `room1 bag ${s.player.haul.length}`);
  check(s.stashRoom === 0, `room1 left room ${s.stashRoom}`);
  const dep = s.events.find((e) => e.t === "deposit");
  check(!!dep && dep.t === "deposit" && dep.left === 2, `room1 left flag ${JSON.stringify(dep)}`);
}

// Room 0: full toast path + leave with bag
{
  const s = atDepot(0);
  check(depotInReach(s) === PAD, "room0 in reach");
  const inp = idleInput();
  inp.interact = true;
  step(s, inp, false);
  check(s.player.haul.length === 3, "room0 kept bag");
  check(s.sent.length === 0, "room0 sent none");
  check(!!s.leaving, "room0 leaving");
  const dep = s.events.find((e) => e.t === "deposit");
  check(!!dep && dep.t === "deposit" && dep.full === true, `room0 full event ${JSON.stringify(dep)}`);
  // Stand through leave timer
  s.leaving!.t = DEPOT.leave;
  for (let i = 0; i < Math.ceil(DEPOT.leave / (1 / 60)) + 2; i++) step(s, idleInput(), false);
  check(s.outcome === "extracted" && s.player.haul.length === 3, `room0 extracted haul ${s.player.haul.length} outcome ${s.outcome}`);
}

if (errors.length) {
  for (const e of errors) console.error(`FAIL ${e}`);
  process.exit(1);
}
console.log("depot room ok");
