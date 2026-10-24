import { BOXES, ZIP_BOXES } from "../src/ringfall/sim/map";
const z = new Set(ZIP_BOXES);
for (const b of BOXES) if (b.x0 < 6 && b.x1 > -2 && b.z0 < 600 && b.z1 > 590) console.log(z.has(b) ? "ZIP" : "", b.kind, b.tint, b.x0.toFixed(2), b.x1.toFixed(2), b.z0.toFixed(2), b.z1.toFixed(2), b.y0.toFixed(2), b.h.toFixed(2));
