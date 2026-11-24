import * as THREE from "three";
import { AWARE, ENEMIES, HEALS, SIGHT, TOOLS, VALUABLES, WEAPONS, type EnemyKind, type Rarity, type WeaponKind } from "../sim/config";
import { PAL, addPlates, buildAlly, buildBin, buildBoat, buildCare, buildCore, buildDepot, buildDropship, buildEnemy, buildEntryMark, buildGun, buildHands, buildLootItem, buildRingDebris } from "./models";
import { UI } from "./palette";
import { LIGHT, hipFov } from "./world";

/*
 * The model sheet (`?models` on the RINGFALL page): every model `models.ts` builds, drawn as the
 * game draws it (the same flat materials, the game's sun and sky light, its tone mapping and its
 * view), laid out as contact sheets to look a model over before and after changing it.
 * `window.ringfallModelSheet` lists the sheets and draws one to a PNG; `npm run models:ringfall
 * -- --sheet` (scripts/ringfall-models-sheet.mjs) saves them all to shots/ringfall/models/.
 * Loaded only when the page is opened with `?models`, so the game's own bundle does not carry it.
 *
 * A cell is a crop of the game's screen: a view 90° across drawn 1920 by 1080 (`hipFov()`), the
 * camera at eye height `EYE`, the model `dist` metres off, and only the pixels round the model
 * kept, so a model is as many pixels tall here as in play. `zoom` enlarges those pixels without
 * smoothing, for the cells that show a model at the distance it is fought from.
 */

const SCREEN = { w: 1920, h: 1080 };
const EYE = 1.7;
/** The grounds a model is looked at on: the brief's ground colours a robot most often stands on. */
const GROUNDS = { sand: PAL.sand, concrete: PAL.concrete, salt: PAL.salt, rock: PAL.rock, asphalt: PAL.asphalt } as const;
type Ground = keyof typeof GROUNDS;

interface Cell {
  label: string;
  /** The cell's size in the game's pixels, before `zoom`. */
  w: number;
  h: number;
  zoom?: number;
  draw(r: THREE.WebGLRenderer, w: number, h: number): void;
}

interface Sheet {
  id: string;
  title: string;
  /** Rows of cells, built when the sheet is drawn. */
  rows(): Cell[][];
}

/** The world's light on a patch of ground: the game's sun and sky, the sun over the camera's left shoulder. */
function stage(ground: Ground): { scene: THREE.Scene; sun: THREE.DirectionalLight } {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(PAL.skyHorizon);
  scene.fog = new THREE.Fog(LIGHT.haze, 160, 420);
  scene.add(new THREE.HemisphereLight(0xcfe9ff, 0xb98a55, LIGHT.sky));
  const sun = new THREE.DirectionalLight(0xfff1d6, LIGHT.sun);
  sun.castShadow = true;
  sun.shadow.bias = -0.0006;
  sun.shadow.mapSize.set(1024, 1024);
  scene.add(sun, sun.target);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: GROUNDS[ground] }));
  floor.receiveShadow = true;
  scene.add(floor);
  return { scene, sun };
}

function boundsOf(o: THREE.Object3D): THREE.Box3 {
  o.updateMatrixWorld(true);
  const box = new THREE.Box3();
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    // Beams, halos and shields are light, not body: a cell frames what is solid.
    if (m.isMesh && ![m.material].flat().some((mat) => mat.transparent)) box.expandByObject(m);
  });
  return box;
}

interface Shot {
  /** Metres from the camera to the model. */
  dist: number;
  /** The model's turn from facing the camera, radians (0 front, π back). */
  yaw?: number;
  ground?: Ground;
  /** Lifts the model off the ground (a drone flies). */
  lift?: number;
  zoom?: number;
  /** Extra pixels round the model. */
  pad?: number;
  /** The least the cell may be, in the game's pixels; it grows to hold the model. */
  w?: number;
  h?: number;
}

/** A model standing in the world, seen from eye height `shot.dist` metres off, cropped to it. */
function worldCell(label: string, make: () => THREE.Object3D, shot: Shot): Cell {
  const obj = make();
  // Models face -z; the camera stands at +z, so a turn of π faces it.
  const turn = new THREE.Group();
  turn.add(obj);
  turn.rotation.y = Math.PI + (shot.yaw ?? 0);
  turn.position.y = shot.lift ?? 0;
  const box = boundsOf(turn);
  const mid = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const px = SCREEN.w / 2 / shot.dist; // pixels per metre at the model, for a view 90° across
  const pad = shot.pad ?? 24;
  // `w` and `h` are the least a cell may be: a model larger than that still gets all of itself in.
  const w = Math.max(shot.w ?? 0, Math.ceil((Math.hypot(size.x, size.z) * px + pad * 2) / 2) * 2);
  const h = Math.max(shot.h ?? 0, Math.ceil((size.y * px + pad * 2) / 2) * 2);
  return {
    label,
    w,
    h,
    zoom: shot.zoom,
    draw(r, cw, ch) {
      const { scene, sun } = stage(shot.ground ?? "sand");
      scene.add(turn);
      const reach = Math.max(size.x, size.y, size.z) * 0.8 + 1;
      sun.position.set(mid.x - 40, mid.y + 80, mid.z + 30);
      sun.target.position.copy(mid);
      const sc = sun.shadow.camera;
      sc.left = sc.bottom = -reach;
      sc.right = sc.top = reach;
      sc.near = 1;
      sc.far = 220;
      sc.updateProjectionMatrix();
      const cam = new THREE.PerspectiveCamera(hipFov(SCREEN.w / SCREEN.h), SCREEN.w / SCREEN.h, 0.05, 900);
      cam.position.set(0, EYE, shot.dist);
      cam.lookAt(mid);
      cam.setViewOffset(SCREEN.w, SCREEN.h, (SCREEN.w - cw) / 2, (SCREEN.h - ch) / 2, cw, ch);
      r.render(scene, cam);
    },
  };
}

/** The first-person pass as world.ts draws it: the gun's own lights and camera, the gun where the hand holds it. */
function gunCell(kind: WeaponKind, rarity: Rarity, ads: number): Cell {
  // The part of the screen the gun fills: its lower right at the hip, its lower middle when aimed.
  const crop = ads ? { x: 480, y: 420, w: 960, h: 660 } : { x: 800, y: 420, w: 1120, h: 660 };
  return {
    label: `${kind} ${ads ? "aimed" : "hip"} (crop of 1920×1080)`,
    w: crop.w,
    h: crop.h,
    zoom: 0.5,
    draw(r, cw, ch) {
      const { scene } = stage("sand");
      const cam = new THREE.PerspectiveCamera(hipFov(SCREEN.w / SCREEN.h), SCREEN.w / SCREEN.h, 0.05, 900);
      cam.position.set(0, EYE, 0);
      cam.lookAt(0, EYE - 0.25, -10);
      cam.setViewOffset(SCREEN.w, SCREEN.h, crop.x, crop.y, cw, ch);
      r.render(scene, cam);
      r.clearDepth();
      const gunScene = new THREE.Scene();
      gunScene.add(new THREE.HemisphereLight(0xdff2ff, 0x8a6a3a, LIGHT.gunSky));
      const gl = new THREE.DirectionalLight(0xfff1d6, LIGHT.gunSun);
      gl.position.set(-1, 2, 1);
      gunScene.add(gl);
      const hold = new THREE.Group();
      const g = buildGun(kind, rarity);
      g.add(buildHands(kind));
      g.scale.setScalar(0.55);
      g.rotation.y = -0.06;
      hold.add(g);
      hold.position.set(0.2 * (1 - ads), -0.2 + 0.07 * ads, -0.5);
      gunScene.add(hold);
      const gunCam = new THREE.PerspectiveCamera(55 - ads * 8, SCREEN.w / SCREEN.h, 0.01, 10);
      gunCam.setViewOffset(SCREEN.w, SCREEN.h, crop.x, crop.y, cw, ch);
      const auto = r.autoClear;
      r.autoClear = false;
      r.render(gunScene, gunCam);
      r.autoClear = auto;
    },
  };
}

/** A gun from the side under the gun pass's lights, flat on (no perspective): its outline as a drawing would show it. */
function gunProfile(kind: WeaponKind, rarity: Rarity, side: 1 | -1, hands: boolean): Cell {
  const span = 2.3; // metres across the cell
  const w = 760;
  const h = 300;
  return {
    label: `${kind} ${side > 0 ? "right" : "left"} side${hands ? ", hands" : ""}`,
    w,
    h,
    draw(r) {
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(PAL.concrete);
      scene.add(new THREE.HemisphereLight(0xdff2ff, 0x8a6a3a, LIGHT.gunSky));
      const gl = new THREE.DirectionalLight(0xfff1d6, LIGHT.gunSun);
      gl.position.set(side * 1, 2, 1);
      scene.add(gl);
      const g = buildGun(kind, rarity);
      if (hands) g.add(buildHands(kind));
      scene.add(g);
      const cam = new THREE.OrthographicCamera(-span / 2, span / 2, (span * h) / w / 2, (-span * h) / w / 2, 0.01, 10);
      cam.position.set(side * 3, hands ? -0.1 : 0, -0.25);
      cam.lookAt(0, hands ? -0.1 : 0, -0.25);
      r.render(scene, cam);
    },
  };
}

const KINDS = Object.keys(ENEMIES) as EnemyKind[];
const GUNS = Object.keys(WEAPONS) as WeaponKind[];
/** Where a robot is mostly seen from: the distance it fights at (docs/ringfall/models.md). */
const engaged = (k: EnemyKind) => SIGHT[k].range * AWARE.engagedRange;
/** A close look, each kind near enough to fill a cell of about the same height. */
const CLOSE: Record<EnemyKind, number> = { drone: 5, grunt: 8, charger: 6, heavy: 10, titan: 18 };
const lift = (k: EnemyKind) => (ENEMIES[k].fly > 0 ? ENEMIES[k].fly : 0);
const VIEWS: [string, number][] = [
  ["front", 0],
  ["three-quarter", 0.7],
  ["side", Math.PI / 2],
  ["back three-quarter", Math.PI - 0.7],
];

function tinted(kind: EnemyKind, armor: number, light: number, plate?: Rarity): THREE.Object3D {
  const m = buildEnemy(kind);
  m.mats[0].color.setHex(armor);
  m.mats[1]?.color.setHex(light);
  if (plate) addPlates(m, kind, plate);
  return m.root;
}

const SHEETS: Sheet[] = [
  {
    id: "robots",
    title: "Robots, close (grunt at 8 m; drone 5, charger 6, heavy 10, titan 18): the game's pixels",
    rows: () => KINDS.map((k) => VIEWS.map(([name, yaw]) => worldCell(`${k} ${name}, ${CLOSE[k]} m`, () => buildEnemy(k).root, { dist: CLOSE[k], yaw, lift: lift(k) }))),
  },
  {
    id: "robots-range",
    title: "Robots at the distance they fight from (SIGHT × engagedRange), the game's pixels ×6, on each ground",
    rows: () =>
      (Object.keys(GROUNDS) as Ground[]).map((ground) =>
        KINDS.map((k) => worldCell(`${k} ${engaged(k).toFixed(0)} m, ${ground}`, () => buildEnemy(k).root, { dist: engaged(k), yaw: 0.5, lift: lift(k), ground, zoom: 6, w: 132, h: 110, pad: 6 })),
      ),
  },
  {
    id: "robots-line",
    title: "The kinds side by side at 24 m, and the grunt's coats (plated, rogue, the player's, another player's)",
    rows: () => [
      KINDS.map((k) => worldCell(`${k} 24 m`, () => buildEnemy(k).root, { dist: 24, yaw: 0.5, lift: lift(k), zoom: 2, pad: 10 })),
      [
        worldCell("grunt, plate 1", () => tinted("grunt", PAL.armor, PAL.armorLight, 1), { dist: 8, yaw: 0.5 }),
        worldCell("grunt, plate 3", () => tinted("grunt", PAL.armor, PAL.armorLight, 3), { dist: 8, yaw: 0.5 }),
        worldCell("rogue", () => tinted("grunt", PAL.rogueArmor, PAL.rogueArmorLight), { dist: 8, yaw: 0.5 }),
        worldCell("the player's", () => tinted("grunt", PAL.friendArmor, PAL.friendArmorLight), { dist: 8, yaw: 0.5 }),
        worldCell("another player's", () => tinted("grunt", PAL.rivalArmor, PAL.rivalArmorLight), { dist: 8, yaw: 0.5 }),
        worldCell("heavy, plate 2", () => tinted("heavy", PAL.armor, PAL.armorLight, 2), { dist: 10, yaw: 0.5 }),
      ],
    ],
  },
  {
    id: "ally",
    title: "The teammate at 5 m, and at 20 m (×4) beside a grunt",
    rows: () => [
      VIEWS.map(([name, yaw]) => worldCell(`ally ${name}, 5 m`, () => buildAlly().root, { dist: 5, yaw })),
      [
        worldCell("ally and grunt, 20 m", () => {
          const g = new THREE.Group();
          const a = buildAlly().root;
          a.position.x = -1;
          const e = buildEnemy("grunt").root;
          e.position.x = 1;
          g.add(a, e);
          return g;
        }, { dist: 20, yaw: 0.4, zoom: 4, pad: 10 }),
        ...(["concrete", "salt", "asphalt"] as Ground[]).map((ground) => worldCell(`ally 20 m, ${ground}`, () => buildAlly().root, { dist: 20, yaw: 0.5, ground, zoom: 4, pad: 10 })),
      ],
    ],
  },
  {
    id: "guns",
    title: "Guns in the hand, as the first-person pass draws them (half size), and from each side",
    rows: () => GUNS.map((k, i) => [gunCell(k, (i % 4) as Rarity, 0), gunCell(k, (i % 4) as Rarity, 1), gunProfile(k, (i % 4) as Rarity, -1, true), gunProfile(k, (i % 4) as Rarity, 1, false)]),
  },
  {
    id: "loot",
    title: "Loot on the ground from 3 m",
    rows: () => {
      const near = (label: string, make: () => THREE.Object3D) => worldCell(label, make, { dist: 3, yaw: 0.5, w: 240, h: 200 });
      const far = (label: string, make: () => THREE.Object3D) => worldCell(`${label}, 12 m`, make, { dist: 12, yaw: 0.5, w: 30, h: 40, zoom: 4, pad: 8 });
      const keys = <T extends object>(o: T) => Object.keys(o) as (keyof T & string)[];
      return [
        GUNS.map((w, i) => worldCell(`weapon ${w}`, () => buildLootItem("weapon", (i % 4) as Rarity, w), { dist: 3, yaw: 0.5, w: 420, h: 200 })),
        [...(["armor", "key", "mod", "flare", "shard"] as const).map((k) => near(k, () => buildLootItem(k, 1))), ...keys(HEALS).map((h) => near(h, () => buildLootItem("heal", 0, undefined, h)))],
        [...keys(VALUABLES).map((v) => near(v, () => buildLootItem("valuable", 3, undefined, undefined, v))), ...keys(TOOLS).map((t) => near(t, () => buildLootItem("tool", 0, undefined, undefined, undefined, t)))],
        // The same at 12 m, drawn at the game's pixels and enlarged 4 times: what is told apart from across a room.
        [
          ...(["armor", "key", "mod", "flare"] as const).map((k) => far(k, () => buildLootItem(k, 1))),
          ...keys(HEALS).map((h) => far(h, () => buildLootItem("heal", 1, undefined, h))),
          ...keys(VALUABLES).map((v) => far(v, () => buildLootItem("valuable", VALUABLES[v].rarity, undefined, undefined, v))),
          ...keys(TOOLS).map((t) => far(t, () => buildLootItem("tool", 3, undefined, undefined, undefined, t))),
        ],
      ];
    },
  },
  {
    id: "world",
    title: "Things placed in the world",
    rows: () => [
      [
        worldCell("bin, 5 m", () => buildBin().root, { dist: 5, yaw: 0.6 }),
        worldCell("vault, 5 m", () => buildBin(true).root, { dist: 5, yaw: 0.6 }),
        worldCell("depot, 5 m", () => buildDepot().root, { dist: 5, yaw: 0.6 }),
        worldCell("care package, 8 m", () => buildCare(), { dist: 8, yaw: 0.6 }),
        worldCell("way in: fire, 5 m", () => buildEntryMark().fire, { dist: 5, yaw: 0.6 }),
        worldCell("way in: sign, 5 m", () => buildEntryMark().sign, { dist: 5, yaw: Math.PI + 0.4 }),
        worldCell("core's light and flag, 20 m", () => buildCore(6, 0.6).root, { dist: 20, yaw: 0.6 }),
      ],
      [
        worldCell("boat, 30 m", () => buildBoat(), { dist: 30, yaw: 0.9, ground: "salt" }),
        worldCell("dropship, 40 m", () => buildDropship(), { dist: 40, yaw: 0.6, lift: 3, ground: "concrete" }),
        worldCell("ring debris, 40 m", () => buildRingDebris().root, { dist: 40, yaw: 0.6 }),
      ],
    ],
  },
];

const GAP = 12;
const LABEL = 20;
const TITLE = 34;

/** Draws a sheet to a canvas: each cell rendered at its own size, then laid on the sheet under its label. */
function drawSheet(sheet: Sheet): HTMLCanvasElement {
  const rows = sheet.rows();
  const size = (c: Cell) => ({ w: Math.round(c.w * (c.zoom ?? 1)), h: Math.round(c.h * (c.zoom ?? 1)) });
  const rowW = (row: Cell[]) => row.reduce((a, c) => a + size(c).w + GAP, GAP);
  const rowH = (row: Cell[]) => Math.max(...row.map((c) => size(c).h)) + LABEL + GAP;
  const out = document.createElement("canvas");
  out.width = Math.max(...rows.map(rowW), 480);
  out.height = rows.reduce((a, r) => a + rowH(r), TITLE + GAP);
  const g = out.getContext("2d")!;
  g.fillStyle = UI.board;
  g.fillRect(0, 0, out.width, out.height);
  g.fillStyle = UI.paper;
  g.font = "600 16px system-ui, sans-serif";
  g.textBaseline = "middle";
  g.fillText(`RINGFALL models: ${sheet.title}`, GAP, TITLE / 2 + 2);
  g.font = "12px system-ui, sans-serif";
  g.imageSmoothingEnabled = false;
  const r = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  r.setPixelRatio(1);
  r.shadowMap.enabled = true;
  r.toneMapping = THREE.ACESFilmicToneMapping;
  r.toneMappingExposure = LIGHT.exposure;
  let y = TITLE;
  for (const row of rows) {
    let x = GAP;
    for (const c of row) {
      r.setSize(c.w, c.h, false);
      c.draw(r, c.w, c.h);
      const s = size(c);
      g.imageSmoothingEnabled = (c.zoom ?? 1) < 1;
      g.drawImage(r.domElement, x, y + LABEL, s.w, s.h);
      g.fillStyle = UI.mist;
      g.fillText(c.label, x, y + LABEL / 2, s.w);
      x += s.w + GAP;
    }
    y += rowH(row);
  }
  r.dispose();
  r.forceContextLoss();
  return out;
}

const api = {
  /** The sheets' ids, in order. */
  ids: () => SHEETS.map((s) => s.id),
  /** Draws a sheet and returns it as a PNG data URL. */
  draw(id: string): string {
    const sheet = SHEETS.find((s) => s.id === id);
    if (!sheet) throw new Error(`no model sheet "${id}"`);
    return drawSheet(sheet).toDataURL("image/png");
  },
};

declare global {
  interface Window {
    ringfallModelSheet?: typeof api;
  }
}

/** Puts the sheets over the page: a button a sheet, the sheet drawn under them. */
export function setupModelSheet() {
  window.ringfallModelSheet = api;
  const panel = document.createElement("div");
  panel.id = "model-sheet";
  panel.style.cssText = `position:fixed;inset:0;z-index:1000;overflow:auto;background:${UI.board};color:${UI.paper};font:14px system-ui,sans-serif;padding:12px`;
  const bar = document.createElement("div");
  bar.style.cssText = "display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap";
  const view = document.createElement("div");
  const show = (s: Sheet) => view.replaceChildren(drawSheet(s));
  for (const s of SHEETS) {
    const b = document.createElement("button");
    b.textContent = s.id;
    b.style.cssText = "padding:6px 12px;font:inherit";
    b.addEventListener("click", () => show(s));
    bar.append(b);
  }
  panel.append(bar, view);
  document.body.append(panel);
}
