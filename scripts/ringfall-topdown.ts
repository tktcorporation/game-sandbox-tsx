/**
 * Writes a top-down picture of the world (terrain shaded by height, cliffs dark, boxes
 * grey, POIs, robots, each region's ways in and the ways off) to the path given, for
 * checking a layout by eye: `npx tsx scripts/ringfall-topdown.ts out.png [x z size]`
 * (the optional square, centre and side in metres, zooms in on one place).
 */
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { WORLD } from "../src/ringfall/sim/config";
import { BOXES, EXTRACTS, POIS, ENTRIES, ROAMERS } from "../src/ringfall/sim/map";
import { terrainHeight, steepAt } from "../src/ringfall/sim/terrain";

const [cx, cz, size] = process.argv.slice(3).map(Number);
const spanX = size || WORLD.x1 - WORLD.x0;
const spanZ = size || WORLD.z1 - WORLD.z0;
const ox = size ? cx - spanX / 2 : WORLD.x0;
const oz = size ? cz - spanZ / 2 : WORLD.z0;
const PX = Math.max(1, Math.round(860 / Math.max(spanX, spanZ))); // pixels per metre
const W = Math.round(spanX * PX);
const HT = Math.round(spanZ * PX);
const img = new Uint8Array(W * HT * 3);
const put = (x: number, z: number, c: [number, number, number]) => {
  const i = Math.floor((x - ox) * PX);
  const j = Math.floor((z - oz) * PX);
  if (i < 0 || j < 0 || i >= W || j >= HT) return;
  img.set(c, (j * W + i) * 3);
};
for (let j = 0; j < HT; j++)
  for (let i = 0; i < W; i++) {
    const x = i / PX + ox;
    const z = j / PX + oz;
    const h = terrainHeight(x, z);
    const k = Math.max(0, Math.min(1, (h + 8) / 40));
    let c: [number, number, number] = [Math.round(200 * (0.55 + 0.45 * k)), Math.round(165 * (0.55 + 0.45 * k)), Math.round(110 * (0.55 + 0.45 * k))];
    if (steepAt(x, z)) c = [120, 60, 40];
    else if (Math.abs(h % 4) < 0.25) c = [c[0] - 30, c[1] - 30, c[2] - 30];
    img.set(c, (j * W + i) * 3);
  }
for (const b of BOXES)
  for (let x = b.x0; x <= b.x1; x += 1 / PX) for (let z = b.z0; z <= b.z1; z += 1 / PX) put(x, z, b.y0 > 0.5 && b.y0 > terrainHeight(x, z) + 0.5 ? [150, 150, 170] : [90, 90, 100]);
const dot = (x: number, z: number, r: number, c: [number, number, number]) => {
  for (let a = -r; a <= r; a += 1 / PX) for (let b = -r; b <= r; b += 1 / PX) if (a * a + b * b <= r * r) put(x + a, z + b, c);
};
for (const p of POIS) {
  for (let a = 0; a < Math.PI * 2; a += 0.01) put(p.x + Math.cos(a) * p.trigger, p.z + Math.sin(a) * p.trigger, [255, 90, 40]);
  for (const sq of p.squads) for (const m of sq.members) dot(m.x, m.z, 1.5, [220, 30, 60]);
  dot(p.entry.x, p.entry.z, 2, [40, 200, 80]);
}
for (const sq of ROAMERS) for (const m of sq.members) dot(m.x, m.z, 1.5, [160, 20, 160]);
for (const e of ENTRIES) dot(e.x, e.z, 3, [40, 120, 255]);
for (const x of EXTRACTS) dot(x.x, x.z, 3, [255, 255, 255]);

// Minimal PNG writer.
const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf: Uint8Array) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Uint8Array) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};
const raw = Buffer.alloc((W * 3 + 1) * HT);
for (let j = 0; j < HT; j++) {
  raw[j * (W * 3 + 1)] = 0;
  Buffer.from(img.subarray(j * W * 3, (j + 1) * W * 3)).copy(raw, j * (W * 3 + 1) + 1);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(HT, 4);
ihdr[8] = 8;
ihdr[9] = 2;
writeFileSync(process.argv[2] ?? "topdown.png", Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())]));
