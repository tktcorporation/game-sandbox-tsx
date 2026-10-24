import { BOXES, BUILT } from "../src/ringfall/sim/map";
import { terrainHeight, steepAt } from "../src/ringfall/sim/terrain";
import { onMainGround } from "../src/ringfall/sim/hunt";
const built = new Set(BUILT);
const near = BOXES.filter((b) => b.x1 > 62 && b.x0 < 80 && b.z1 > -720 && b.z0 < -702);
console.log(near.map((b) => `${built.has(b) ? "B" : "S"} ${b.kind} ${b.x0.toFixed(1)},${b.z0.toFixed(1)}-${b.x1.toFixed(1)},${b.z1.toFixed(1)} y${b.y0.toFixed(1)}-${b.h.toFixed(1)}`).join("\n"));
for (let z = -722; z <= -700; z += 2) { let r = ""; for (let x = 60; x <= 82; x += 1) r += steepAt(x, z) ? "#" : onMainGround(x, z) ? "." : "x"; console.log(z, r, terrainHeight(70, z).toFixed(1)); }
for (let x = 60; x <= 90; x += 3) console.log(x, terrainHeight(x, -712).toFixed(2), steepAt(x,-712));
