import { newRun, freeKit, idleInput } from "../src/ringfall/sim/state";
import { step } from "../src/ringfall/sim/step";
import { PARTY_STOPS } from "../src/ringfall/sim/map";
import { TICK } from "../src/ringfall/sim/config";
import { onMainGround } from "../src/ringfall/sim/hunt";
const s = newRun(3, freeKit(), "reservoir");
s.player.iframes = 1e9; s.reinforceT = s.raiderT = 1e9;
s.parties = s.parties.filter((q) => q.region === "harbor");
s.enemies = s.enemies.filter((e) => s.parties.some((q) => q.squad === e.squad));
for (let i = 0; i < 600 / TICK; i++) {
  step(s, idleInput(), false);
  if (i % 300 === 0) for (const q of s.parties) { const t = s.squads[q.squad].party!; const l = s.enemies.find((e) => e.squad === q.squad)!; console.log((i*TICK).toFixed(0), q.squad, PARTY_STOPS.harbor[t.stop].name, l.pos.x.toFixed(0), l.pos.z.toFixed(0), l.pos.y.toFixed(1), t.linger.toFixed(0), onMainGround(l.pos.x,l.pos.z), l.aware, l.mode); }
}
