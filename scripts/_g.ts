import { newRun, idleInput } from "../src/ringfall/sim/state";
import { step } from "../src/ringfall/sim/step";
import { groundAt } from "../src/ringfall/sim/geom";
import { terrainHeight, steepAt } from "../src/ringfall/sim/terrain";
const s = newRun(7); s.phase = "play";
const p = s.player; p.pos = { x: 2, y: groundAt(2, 601.7, 0.4, 99), z: 601.7 }; p.yaw = 0; p.vel = { x: 0, y: 0, z: 0 };
for (let k = 0; k < 36; k++) { step(s, { ...idleInput(), moveZ: 1 }, false); }
console.log(p.pos.z.toFixed(2), p.pos.y.toFixed(2));
for (let z = 602; z > 596; z -= 0.5) console.log(z, terrainHeight(2, z).toFixed(3), steepAt(2, z));
