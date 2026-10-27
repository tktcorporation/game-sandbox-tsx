/**
 * Measures every model `src/ringfall/view/models.ts` builds and checks it against the model rules
 * in `docs/ringfall/models.md`: triangles, meshes, materials, colours outside the palette, size,
 * the smallest feature and the distance past which it is under a pixel, and, for each robot, how
 * its silhouette and the sim's hit spheres (`ENEMIES[].radius` at `bodyY`, `weakR` at `weakY`)
 * cover each other. Writes the table to stdout (Markdown) and, per robot, a front and a side
 * silhouette with the hit spheres over it to `shots/ringfall/models/`, for checking by eye. Exits
 * 1, naming what broke, when a model breaks a rule (`BUDGET`, the palette, `ROBOT_FLOOR`).
 *
 *   npx tsx scripts/ringfall-models.ts [--json]
 *
 * Runs headless: only the halo texture touches the DOM, and a stub canvas stands in for it.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

// The halo sprite draws a gradient on a canvas; nothing here renders it, so a stub will do.
const stubCtx = { createRadialGradient: () => ({ addColorStop() {} }), fillRect() {}, fillStyle: "" };
(globalThis as { document?: unknown }).document = { createElement: () => ({ width: 0, height: 0, getContext: () => stubCtx }) };

const THREE = await import("three");
const M = await import("../src/ringfall/view/models");
const { ENEMIES, HEALS, TOOLS, VALUABLES, WEAPONS: WEAPON_SPECS } = await import("../src/ringfall/sim/config");
type EnemyKind = keyof typeof ENEMIES;
type Object3D = import("three").Object3D;

/** One screen pixel at distance d, for a view 90° across drawn 1920 pixels wide (`hipFov()`): 2·d·tan 45° / 1920. */
const PIXEL_PER_M = 1920 / 2;
const GRID = 0.02; // silhouette cell, metres

/**
 * The model rules (docs/ringfall/models.md). Budgets per group sit a fifth to a third above the
 * largest model of the group as measured when they were set, so they hold today's look and stop a
 * model doubling its cost unnoticed. The robots' floors keep their look and their hit spheres no
 * further apart than they are now; raise a floor only together with the model or the sim.
 */
const BUDGET: Record<Entry["group"], { tris: number; meshes: number; materials: number }> = {
  robot: { tris: 1000, meshes: 16, materials: 12 },
  ally: { tris: 400, meshes: 20, materials: 8 },
  gun: { tris: 520, meshes: 6, materials: 5 },
  loot: { tris: 400, meshes: 8, materials: 5 },
  world: { tris: 200, meshes: 13, materials: 7 },
  wreck: { tris: 600, meshes: 36, materials: 5 },
};
const ROBOT_FLOOR = { hitShareFront: 0.6, hitShareSide: 0.7, airShareFrontMax: 0.4 };

const PALETTE = new Set<number>([...Object.values(M.PAL).filter((v): v is number => typeof v === "number"), ...M.RARITY_COLOR, ...Object.values(M.PROP_PAL).flat()]);

interface Entry {
  id: string;
  group: "robot" | "ally" | "gun" | "loot" | "world" | "wreck";
  root: Object3D;
  robot?: EnemyKind;
}

const ENEMY_KINDS = Object.keys(ENEMIES) as EnemyKind[];
// The kinds come from the game's own tables, so a kind added there is measured here too.
const WEAPONS = Object.keys(WEAPON_SPECS) as (keyof typeof WEAPON_SPECS)[];
const keys = <T extends object>(o: T) => Object.keys(o) as (keyof T)[];
const entries: Entry[] = [
  ...ENEMY_KINDS.map((k): Entry => ({ id: k, group: "robot", root: M.buildEnemy(k).root, robot: k })),
  { id: "ally", group: "ally", root: M.buildAlly().root },
  ...WEAPONS.map((w): Entry => ({ id: w, group: "gun", root: M.buildGun(w, 0) })),
  ...WEAPONS.map((w): Entry => ({ id: `hands:${w}`, group: "gun", root: M.buildHands(w) })),
  // Every loot item buildLootItem draws: a dropped gun is the gun's model scaled, so it counts as a gun.
  ...WEAPONS.map((w): Entry => ({ id: `loot:${w}`, group: "gun", root: M.buildLootItem("weapon", 0, w) })),
  // The loot kinds with no table of their own (LootKind in sim/state.ts); a new one is added here.
  ...(["armor", "key", "record", "mod", "flare", "shard"] as const).map((k): Entry => ({ id: `loot:${k}`, group: "loot", root: M.buildLootItem(k, 0) })),
  ...keys(HEALS).map((h): Entry => ({ id: `loot:${h}`, group: "loot", root: M.buildLootItem("heal", 0, undefined, h) })),
  ...keys(VALUABLES).map((v): Entry => ({ id: `loot:${v}`, group: "loot", root: M.buildLootItem("valuable", 3, undefined, undefined, v) })),
  ...keys(TOOLS).map((t): Entry => ({ id: `loot:${t}`, group: "loot", root: M.buildLootItem("tool", 0, undefined, undefined, undefined, t) })),
  { id: "bin", group: "world", root: M.buildBin().root },
  { id: "vault", group: "world", root: M.buildBin(true).root },
  { id: "depot", group: "world", root: M.buildDepot().root },
  { id: "care", group: "world", root: M.buildCare() },
  { id: "boat", group: "world", root: M.buildBoat() },
  { id: "dropship", group: "world", root: M.buildDropship() },
  { id: "core", group: "world", root: M.buildCore(6, 0.6).root },
  { id: "entry-fire", group: "world", root: M.buildEntryMark().fire },
  { id: "entry-sign", group: "world", root: M.buildEntryMark().sign },
  { id: "ring-debris", group: "wreck", root: M.buildRingDebris().root },
  { id: "beacon", group: "world", root: M.buildBeacon() },
  { id: "flare-smoke", group: "world", root: M.buildFlareSmoke() },
];

interface Measure {
  id: string;
  group: Entry["group"];
  tris: number;
  meshes: number;
  materials: number;
  offPalette: string[];
  size: [number, number, number];
  /** The smallest part's middle extent: a rod's thickness, a plate's narrower side. */
  feature: number;
  featurePart: string;
  /** Past this distance the smallest feature is under one pixel. */
  featureFarM: number;
  robot?: RobotMeasure;
}

interface RobotMeasure {
  /** Share of the silhouette the hit spheres cover, front and side: what a shot at what is seen hits. */
  hitShareFront: number;
  hitShareSide: number;
  /** Share of the hit spheres' outline over empty air, front: a shot at nothing that still hits. */
  airShareFront: number;
  /** The eye lens inside the weak point's sphere. */
  eyeInWeak: boolean;
  /** Below this height nothing is hittable while the model still stands there. */
  hitFloor: number;
}

/** Halos, shields and loot beams are effects drawn see-through or additive, not the model's body. */
const isEffect = (m: import("three").Mesh) => [m.material].flat().some((mat) => mat.transparent);

/** Each connected piece of a geometry (triangles sharing a vertex position), as its local extent along x, y, z. */
function partSizes(g: import("three").BufferGeometry): [number, number, number][] {
  const pos = g.attributes.position;
  const n = g.index ? g.index.count : pos.count;
  const vi = (k: number) => (g.index ? g.index.getX(k) : k);
  const key = (i: number) => `${pos.getX(i).toFixed(4)},${pos.getY(i).toFixed(4)},${pos.getZ(i).toFixed(4)}`;
  const id = new Map<string, number>();
  const parent: number[] = [];
  const find = (a: number): number => (parent[a] === a ? a : (parent[a] = find(parent[a])));
  const node = (i: number) => {
    const k = key(i);
    let v = id.get(k);
    if (v === undefined) {
      v = parent.length;
      id.set(k, v);
      parent.push(v);
    }
    return v;
  };
  for (let t = 0; t < n; t += 3) {
    const a = node(vi(t));
    parent[find(node(vi(t + 1)))] = find(a);
    parent[find(node(vi(t + 2)))] = find(a);
  }
  const boxes = new Map<number, import("three").Box3>();
  const v = new THREE.Vector3();
  for (let k = 0; k < n; k++) {
    const i = vi(k);
    const r = find(id.get(key(i))!);
    let b = boxes.get(r);
    if (!b) boxes.set(r, (b = new THREE.Box3()));
    b.expandByPoint(v.fromBufferAttribute(pos, i));
  }
  return [...boxes.values()].map((b) => {
    const s = b.getSize(new THREE.Vector3());
    return [s.x, s.y, s.z];
  });
}

const hex = (c: number) => `#${c.toString(16).padStart(6, "0")}`;

function meshesOf(root: Object3D): import("three").Mesh[] {
  root.updateMatrixWorld(true);
  const out: import("three").Mesh[] = [];
  root.traverse((o) => {
    if ((o as import("three").Mesh).isMesh && o.visible) out.push(o as import("three").Mesh);
  });
  return out;
}

function measure(e: Entry): Measure {
  const meshes = meshesOf(e.root);
  let tris = 0;
  const mats = new Set<import("three").Material>();
  const off = new Set<number>();
  let feature = Infinity;
  let featurePart = "";
  const scale = new THREE.Vector3();
  for (const m of meshes) {
    const g = m.geometry;
    tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
    for (const mat of [m.material].flat()) {
      mats.add(mat);
      const c = (mat as { color?: import("three").Color }).color;
      if (c && !PALETTE.has(c.getHex())) off.add(c.getHex());
    }
  }
  // Parts are merged per material (compact()), so a part is a connected piece of a mesh.
  const solid = meshes.filter((m) => !isEffect(m));
  for (const m of solid) {
    m.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);
    for (const dims of partSizes(m.geometry)) {
      const d = [dims[0] * Math.abs(scale.x), dims[1] * Math.abs(scale.y), dims[2] * Math.abs(scale.z)].sort((a, b) => a - b);
      if (d[1] < feature) {
        feature = d[1];
        featurePart = `${d.map((v) => v.toFixed(2)).join("×")} ${hex((m.material as { color?: import("three").Color }).color?.getHex() ?? 0)}`;
      }
    }
  }
  const box = new THREE.Box3();
  for (const m of solid) box.expandByObject(m);
  const size = box.getSize(new THREE.Vector3());
  const out: Measure = {
    id: e.id,
    group: e.group,
    tris,
    meshes: meshes.length,
    materials: mats.size,
    offPalette: [...off].map(hex),
    size: [size.x, size.y, size.z].map((v) => +v.toFixed(2)) as [number, number, number],
    feature: +feature.toFixed(3),
    featurePart,
    featureFarM: +(feature * PIXEL_PER_M).toFixed(0),
  };
  if (e.robot) out.robot = robot(e.robot, meshes);
  return out;
}

/** An orthographic silhouette on a GRID-metre raster: `axis` "front" looks along -z (x, y), "side" along x (z, y). */
interface Raster {
  x0: number;
  y0: number;
  w: number;
  h: number;
  cells: Uint8Array;
}

function silhouette(meshes: import("three").Mesh[], axis: "front" | "side", pad: { x0: number; x1: number; y0: number; y1: number }): Raster {
  const x0 = pad.x0;
  const y0 = pad.y0;
  const w = Math.ceil((pad.x1 - pad.x0) / GRID);
  const h = Math.ceil((pad.y1 - y0) / GRID);
  const cells = new Uint8Array(w * h);
  const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  for (const m of meshes) {
    const g = m.geometry;
    const pos = g.attributes.position;
    const n = g.index ? g.index.count : pos.count;
    for (let t = 0; t < n; t += 3) {
      for (let k = 0; k < 3; k++) v[k].fromBufferAttribute(pos, g.index ? g.index.getX(t + k) : t + k).applyMatrix4(m.matrixWorld);
      const p = v.map((q) => [((axis === "front" ? q.x : q.z) - x0) / GRID, (q.y - y0) / GRID]);
      const minX = Math.max(0, Math.floor(Math.min(p[0][0], p[1][0], p[2][0])));
      const maxX = Math.min(w - 1, Math.ceil(Math.max(p[0][0], p[1][0], p[2][0])));
      const minY = Math.max(0, Math.floor(Math.min(p[0][1], p[1][1], p[2][1])));
      const maxY = Math.min(h - 1, Math.ceil(Math.max(p[0][1], p[1][1], p[2][1])));
      const area = (p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[2][0] - p[0][0]) * (p[1][1] - p[0][1]);
      if (Math.abs(area) < 1e-9) continue;
      for (let j = minY; j <= maxY; j++)
        for (let i = minX; i <= maxX; i++) {
          const cx = i + 0.5;
          const cy = j + 0.5;
          const e0 = (p[1][0] - p[0][0]) * (cy - p[0][1]) - (p[1][1] - p[0][1]) * (cx - p[0][0]);
          const e1 = (p[2][0] - p[1][0]) * (cy - p[1][1]) - (p[2][1] - p[1][1]) * (cx - p[1][0]);
          const e2 = (p[0][0] - p[2][0]) * (cy - p[2][1]) - (p[0][1] - p[2][1]) * (cx - p[2][0]);
          if ((e0 >= 0 && e1 >= 0 && e2 >= 0) || (e0 <= 0 && e1 <= 0 && e2 <= 0)) cells[j * w + i] = 1;
        }
    }
  }
  return { x0, y0, w, h, cells };
}

/** The sim's hit spheres for a robot at the origin facing -z (yaw 0), as (horizontal, y, r) in the view's plane. */
function spheres(kind: EnemyKind, axis: "front" | "side"): [number, number, number][] {
  const k = ENEMIES[kind];
  return [
    [0, k.bodyY, k.radius],
    [axis === "front" ? 0 : -k.weakFwd, k.weakY, k.weakR],
  ];
}

const inSpheres = (s: [number, number, number][], x: number, y: number) => s.some(([cx, cy, r]) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r);

function robot(kind: EnemyKind, meshes: import("three").Mesh[]): RobotMeasure {
  const k = ENEMIES[kind];
  // The halo and shield are effects, not body: leave out what is drawn additively or see-through.
  const body = meshes.filter((m) => !isEffect(m));
  const box = new THREE.Box3();
  for (const m of body) box.expandByObject(m);
  const reach = Math.max(box.max.x, -box.min.x, box.max.z, -box.min.z, k.radius, k.weakFwd + k.weakR) + 0.1;
  const top = Math.max(box.max.y, k.weakY + k.weakR, k.bodyY + k.radius) + 0.1;
  // A drone floats with its local zero at its body's centre, so the raster starts at whatever is lowest.
  const bottom = Math.min(box.min.y, k.weakY - k.weakR, k.bodyY - k.radius) - 0.1;
  const shares: Record<"front" | "side", { hit: number; air: number }> = { front: { hit: 0, air: 0 }, side: { hit: 0, air: 0 } };
  for (const axis of ["front", "side"] as const) {
    const r = silhouette(body, axis, { x0: -reach, x1: reach, y0: bottom, y1: top });
    const s = spheres(kind, axis);
    let sil = 0;
    let hit = 0;
    let sph = 0;
    let air = 0;
    for (let j = 0; j < r.h; j++)
      for (let i = 0; i < r.w; i++) {
        const x = r.x0 + (i + 0.5) * GRID;
        const y = r.y0 + (j + 0.5) * GRID;
        const on = r.cells[j * r.w + i] === 1;
        const inS = inSpheres(s, x, y);
        if (on) sil++;
        if (on && inS) hit++;
        if (inS) sph++;
        if (inS && !on) air++;
      }
    shares[axis] = { hit: sil ? hit / sil : 0, air: sph ? air / sph : 0 };
    writeSilhouette(`${kind}-${axis}`, r, s);
  }
  const eye = meshes.find((m) => [m.material].flat().some((mat) => (mat as { color?: import("three").Color }).color?.getHex() === M.PAL.eye && !mat.transparent));
  const ep = eye ? new THREE.Vector3().setFromMatrixPosition(eye.matrixWorld) : null;
  const eyeInWeak = !!ep && ep.distanceTo(new THREE.Vector3(0, k.weakY, -k.weakFwd)) <= k.weakR;
  return {
    hitShareFront: +shares.front.hit.toFixed(2),
    hitShareSide: +shares.side.hit.toFixed(2),
    airShareFront: +shares.front.air.toFixed(2),
    eyeInWeak,
    hitFloor: +Math.max(0, Math.min(k.bodyY - k.radius, k.weakY - k.weakR)).toFixed(2),
  };
}

// --- silhouettes for checking by eye: grey where only the model is (a shot there misses), green
// where model and hit sphere meet, red where only the sphere is (a shot at air that hits).
const OUT = "shots/ringfall/models";
mkdirSync(OUT, { recursive: true });

function writeSilhouette(name: string, r: Raster, s: [number, number, number][]) {
  const S = 2; // pixels per cell
  const W = r.w * S;
  const H = r.h * S;
  const img = new Uint8Array(W * H * 3).fill(250);
  for (let j = 0; j < r.h; j++)
    for (let i = 0; i < r.w; i++) {
      const on = r.cells[j * r.w + i] === 1;
      const inS = inSpheres(s, r.x0 + (i + 0.5) * GRID, r.y0 + (j + 0.5) * GRID);
      const c = on && inS ? [70, 160, 90] : on ? [120, 120, 130] : inS ? [225, 80, 80] : null;
      if (!c) continue;
      for (let dy = 0; dy < S; dy++)
        for (let dx = 0; dx < S; dx++) img.set(c, ((H - 1 - (j * S + dy)) * W + i * S + dx) * 3);
    }
  writePng(`${OUT}/${name}.png`, W, H, img);
}

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
function writePng(path: string, W: number, H: number, img: Uint8Array) {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let j = 0; j < H; j++) Buffer.from(img.subarray(j * W * 3, (j + 1) * W * 3)).copy(raw, j * (W * 3 + 1) + 1);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  writeFileSync(path, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())]));
}

const results = entries.map(measure);

function violations(r: Measure): string[] {
  const out: string[] = [];
  const b = BUDGET[r.group];
  if (r.tris > b.tris) out.push(`${r.tris} triangles, over the ${r.group} budget of ${b.tris}`);
  if (r.meshes > b.meshes) out.push(`${r.meshes} meshes, over the ${r.group} budget of ${b.meshes}`);
  if (r.materials > b.materials) out.push(`${r.materials} materials, over the ${r.group} budget of ${b.materials}`);
  if (r.offPalette.length) out.push(`colours outside the palette: ${r.offPalette.join(" ")} (name them in PAL)`);
  const k = r.robot;
  if (k) {
    if (!k.eyeInWeak) out.push("the eye lens is outside the weak point's hit sphere");
    if (k.hitShareFront < ROBOT_FLOOR.hitShareFront) out.push(`hit share front ${k.hitShareFront} < ${ROBOT_FLOOR.hitShareFront}`);
    if (k.hitShareSide < ROBOT_FLOOR.hitShareSide) out.push(`hit share side ${k.hitShareSide} < ${ROBOT_FLOOR.hitShareSide}`);
    if (k.airShareFront > ROBOT_FLOOR.airShareFrontMax) out.push(`air share front ${k.airShareFront} > ${ROBOT_FLOOR.airShareFrontMax}`);
  }
  return out.map((v) => `${r.id}: ${v}`);
}
const failed = results.flatMap(violations);

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(results, null, 2));
} else {
  console.log("| model | tris | meshes | mats | size w×h×d (m) | smallest feature (m) | under 1 px past (m) | off-palette |");
  console.log("| --- | --: | --: | --: | --- | --: | --: | --- |");
  for (const r of results)
    console.log(`| ${r.id} | ${r.tris} | ${r.meshes} | ${r.materials} | ${r.size.join(" × ")} | ${Number.isFinite(r.feature) ? `${r.feature} (${r.featurePart})` : "— (effect only)"} | ${Number.isFinite(r.featureFarM) ? r.featureFarM : "—"} | ${r.offPalette.join(" ") || "—"} |`);
  console.log("\n| robot | hit share front | hit share side | air share front | eye in weak point | nothing hittable below (m) |");
  console.log("| --- | --: | --: | --: | --- | --: |");
  for (const r of results.filter((x) => x.robot))
    console.log(`| ${r.id} | ${r.robot!.hitShareFront} | ${r.robot!.hitShareSide} | ${r.robot!.airShareFront} | ${r.robot!.eyeInWeak ? "yes" : "**no**"} | ${r.robot!.hitFloor} |`);
  console.log(`\nsilhouettes: ${OUT}/<robot>-front.png, -side.png (grey: model only, green: model and hit sphere, red: hit sphere only)`);
}

if (failed.length) {
  console.error(`\nmodel rules broken (docs/ringfall/models.md):\n${failed.map((f) => `  ${f}`).join("\n")}`);
  process.exit(1);
}
console.error(`\n${results.length} models within the rules`);
