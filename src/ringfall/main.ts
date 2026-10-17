import { AWARE, TICK, VALUABLES, WEAPONS } from "./sim/config";
import { Bot, SKILLS } from "./sim/bot";
import { dist2d, groundAt } from "./sim/geom";
import { terrainHeight } from "./sim/terrain";
import { callLeft, freeKit, idleInput, newRun, type GameEvent, type Input, type Kit, type State } from "./sim/state";
import { entryOf, FRAMES, POIS, poiIndex, regionOf, type EntryId, type PoiId, type RegionId } from "./sim/map";
import { settle, type Settlement } from "./meta/profile";
import { loadProfile, saveProfile } from "./meta/storage";
import { Hub } from "./view/hub";
import { step } from "./sim/step";
import { hurtAlly, placeAlly } from "./sim/ally";
import { haulValue } from "./sim/results";
import { bagLoad } from "./sim/world";
import { preferLowPower, savedVolume, setVolume, unlock } from "./view/audio";
import { sfx } from "./view/sfx";
import { Soundscape } from "./view/soundscape";
import { setupSoundCheck } from "./view/soundcheck";
import { Hud } from "./view/hud";
import { World } from "./view/world";
import { Governor, loadChoice, pickTier, QUALITY, type Level, type QualityChoice } from "./view/quality";
import { blockPageZoom, setupTouch } from "./touch";
import "./style.css";

/*
 * Wiring: keyboard and mouse become Input, a fixed 1/60 s loop steps the sim,
 * and each tick's events go to the 3D view, the HUD and the speakers.
 */

const $ = (id: string) => document.getElementById(id)!;
const stage = $("stage");
/** Phones and tablets: touch controls, stronger aim pull, lighter rendering. */
let touchMode = matchMedia("(pointer: coarse)").matches;
/** The tier the device starts on when the choice is automatic, from what the browser tells of it. */
const deviceTier = pickTier({
  coarse: touchMode,
  cores: navigator.hardwareConcurrency || undefined,
  memory: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
  pixels: screen.width * screen.height * devicePixelRatio ** 2,
});
let quality: QualityChoice = loadChoice(location.search);
const startTier = quality === "auto" ? deviceTier : quality;
const world = new World(stage, { tier: startTier, ratio: Math.min(devicePixelRatio, QUALITY[startTier].maxRatio) });
/**
 * Moves the drawing between the quality ladder's levels by the frame times of a raid under way.
 * A tier the player chose stays; only its resolution moves.
 */
let governor = new Governor(startTier, devicePixelRatio, quality !== "auto");
/**
 * Under a browser driver (the shots gate) the governor stays put: what a screenshot shows must not
 * depend on how fast the machine happened to draw.
 */
const automated = navigator.webdriver;
function applyLevel(l: Level) {
  if (l.tier !== world.tier) world.setTier(l.tier);
  world.setRatio(l.ratio);
}
const hud = new Hud();

let state: State = newRun(Date.now() & 0xffff);
let running = false;
let paused = false;
let manual = false; // automation drives time through advanceTime()
/** Automation stepped without drawing: the frame loop leaves the canvas as automation last drew it. */
let quiet = false;
let bot: Bot | null = null;
let acc = 0;
let hitstop = 0;
let slowmo = 0;
let prevCrouch = false;
let sens = 1;

// --- input
const keys = new Set<string>();
const edges = new Set<string>();
const look = { x: 0, y: 0 };
const stick = { x: 0, z: 0 };
let fire = false;
let ads = false;
/** Touch drag pixels are worth this many mouse pixels of turning. */
const TOUCH_LOOK = 2.6;

/** Also picks the light mixer: this runs before the same gesture unlocks audio. */
function enableTouch() {
  touchMode = true;
  preferLowPower(true);
  document.body.classList.add("touch");
}
if (touchMode) enableTouch();
addEventListener("pointerdown", (e) => e.pointerType === "touch" && !touchMode && enableTouch());
blockPageZoom();
setupTouch({
  move: stick,
  look: (dx, dy) => {
    look.x += dx * TOUCH_LOOK * sens;
    look.y += dy * TOUCH_LOOK * sens;
  },
  press: (code) => edges.add(code),
  hold: (code, on) => (on ? keys.add(code) : keys.delete(code)),
  fire: (on) => (fire = on && running && !paused),
  toggleAds: () => (ads = !ads),
  map: () => {
    if (running) hud.toggleMap();
  },
});
// The pause button sits on the open map on a phone (see .map-buttons).
$("map-pause").addEventListener("click", () => {
  hud.toggleMap(false);
  setPaused(true);
});

addEventListener("keydown", (e) => {
  if (e.repeat) return;
  // The map opens over the game straight from the key, whoever is at the controls.
  if (e.code === "KeyM" && running) hud.toggleMap();
  if (e.code === "KeyN" && running) hud.toggleMapView();
  keys.add(e.code);
  edges.add(e.code);
  if (["Space", "KeyC", "ControlLeft", "Tab"].includes(e.code)) e.preventDefault();
});
addEventListener("keyup", (e) => keys.delete(e.code));
/**
 * Pointer lock was refused or is missing (a sandboxed frame, an old browser): the
 * view then follows plain mouse movement over the page instead of locking the cursor.
 */
let noLock = false;
addEventListener("mousemove", (e) => {
  if (document.pointerLockElement !== stage && !(noLock && running && !paused)) return;
  look.x += e.movementX;
  look.y += e.movementY;
});
addEventListener("mousedown", (e) => {
  if (!running || paused) return;
  if (e.button === 0) fire = true;
  if (e.button === 2) ads = true;
});
addEventListener("mouseup", (e) => {
  if (e.button === 0) fire = false;
  if (e.button === 2) ads = false;
});
addEventListener("wheel", () => edges.add("Wheel"), { passive: true });
addEventListener("contextmenu", (e) => e.preventDefault());
addEventListener("blur", () => {
  keys.clear();
  fire = ads = false;
});

function readInput(): Input {
  const inp = idleInput();
  inp.moveZ = (keys.has("KeyW") ? 1 : 0) - (keys.has("KeyS") ? 1 : 0) + stick.z;
  inp.moveX = (keys.has("KeyD") ? 1 : 0) - (keys.has("KeyA") ? 1 : 0) + stick.x;
  inp.touch = touchMode;
  // Aiming slows the view in step with the zoom, so a scope does not swing wildly.
  const pl = state.player;
  const held = pl.weapons[pl.slot];
  const zoom = held ? 1 - pl.ads * (1 - WEAPONS[held.kind].adsFov / 74) : 1;
  const k = 0.0022 * sens * zoom;
  inp.lookX = look.x * k;
  inp.lookY = -look.y * k;
  look.x = look.y = 0;
  inp.fire = fire;
  inp.ads = ads;
  inp.crouch = keys.has("KeyC") || keys.has("ControlLeft");
  inp.jump = edges.has("Space");
  inp.reload = edges.has("KeyR");
  inp.tactical = edges.has("KeyQ");
  inp.ult = edges.has("KeyZ");
  inp.interact = edges.has("KeyE");
  inp.heal = edges.has("KeyH");
  inp.swap = edges.has("Wheel");
  inp.slot = edges.has("Digit1") ? 0 : edges.has("Digit2") ? 1 : -1;
  edges.clear();
  return inp;
}

// --- sound and feel for each event
const sound = new Soundscape();
function onEvent(e: GameEvent, s: State) {
  hud.event(e, s);
  sound.event(e, s);
  if (e.t === "done") {
    // Settle and save at once; only the results screen waits for the moment to play out.
    settlement = settle(hub.profile, s);
    hub.profile = settlement.profile;
    saveProfile(hub.profile);
    setTimeout(finish, s.outcome === "extracted" ? 1400 : 2400);
  }
}

function tick() {
  const inp = bot ? bot.input(state) : readInput();
  step(state, inp, prevCrouch);
  prevCrouch = inp.crouch;
  const feel = world.handle(state, state.events);
  hitstop = Math.max(hitstop, feel.hitstop);
  if (feel.slowmo > 0) slowmo = Math.max(slowmo, feel.slowmo);
  for (const e of state.events) onEvent(e, state);
}

/**
 * The canvas's drawing size, measured from the stage itself. iOS reports `innerWidth` and
 * `innerHeight` from before a rotation on the resize event, which left the picture drawn
 * at the old shape and stretched to the new one; the stage's own box is always current.
 */
function size() {
  const w = Math.max(1, stage.clientWidth || innerWidth);
  const h = Math.max(1, stage.clientHeight || innerHeight);
  world.resize(w, h);
  return { w, h };
}
let dims = size();
new ResizeObserver(() => (dims = size())).observe(stage);

// iPhone Safari cannot put a page in full screen; opened from the home screen it runs
// without the browser's bars, so say how on the title screen there.
const ios = /iP(hone|od)/.test(navigator.userAgent);
const homeScreen = matchMedia("(display-mode: standalone), (display-mode: fullscreen)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
$("install-help").hidden = !(ios && !homeScreen);

/** Keeps the phone's screen awake during a raid; let go when the page is hidden, taken again on return. */
let wake: { release(): Promise<void> } | null = null;
function keepAwake(on: boolean) {
  const lock = (navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> } }).wakeLock;
  if (!on) {
    wake?.release().catch(() => undefined);
    wake = null;
  } else if (lock && !wake && !document.hidden) {
    lock
      .request("screen")
      .then((w) => (wake = w))
      .catch(() => undefined);
  }
}

let last = performance.now();
/** When the last frame was drawn, and the real seconds since then the next draw catches up on. */
let drawnAt = last;
let drawDt = 0;
/** Toggles each animation frame; on the governor's 30 fps rungs only every other one draws. */
let odd = false;
function frame(now: number) {
  // The first frame's timestamp can predate `last` by the seconds the page took to load, and a
  // negative step would grow every fade in the view (the muzzle flash and its light) instead.
  const dt = Math.max(0, Math.min(0.1, (now - last) / 1000));
  last = now;
  if (running && !paused && !manual) {
    let simDt = dt;
    if (hitstop > 0) {
      hitstop -= dt;
      simDt = 0;
    } else if (slowmo > 0) {
      slowmo -= dt;
      simDt = dt * 0.3;
    }
    acc += simDt;
    let n = 0;
    while (acc >= TICK && n < 6) {
      tick();
      acc -= TICK;
      n++;
    }
    if (n === 6) acc = 0;
  }
  odd = !odd;
  drawDt += dt;
  const drawn = !(manual && quiet) && !(governor.level.cap30 && odd);
  if (drawn) {
    world.render(state, drawDt);
    if (running) hud.frame(state, world, drawDt, dims.w, dims.h);
    drawDt = 0;
    if (!automated && running && !paused && !manual) {
      const l = governor.frame(now - drawnAt);
      if (l) applyLevel(l);
    }
    drawnAt = now;
  } else if (manual) drawDt = 0;
  sound.frame(state, world.camera, dt, running && !paused);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// --- screens
function lock() {
  if (bot || manual || touchMode) return;
  if (!stage.requestPointerLock) {
    noLock = true;
    return;
  }
  try {
    const r = stage.requestPointerLock() as unknown as Promise<void> | undefined;
    r?.catch?.(() => (noLock = true));
  } catch {
    noLock = true;
  }
}

/** The kit the raid under way started from, and the region it dropped into. */
let kit: Kit = freeKit();
let region: RegionId = "reservoir";
let settlement: Settlement | null = null;
const hub = new Hub(loadProfile(), start);

function openHub() {
  $("title").hidden = true;
  $("results").hidden = true;
  hub.open();
}

/** `from`: a depot to start at, instead of the way in `entry` of `r`. */
function start(k: Kit, r: RegionId, seed: number, { from, entry }: { from?: PoiId; entry: EntryId }) {
  kit = k;
  region = r;
  settlement = null;
  unlock();
  if (touchMode) {
    // Full screen and landscape where the browser allows it; the game runs either way.
    document.documentElement.requestFullscreen?.().catch(() => undefined);
    (screen.orientation as unknown as { lock?: (o: string) => Promise<void> } | undefined)?.lock?.("landscape").catch(() => undefined);
  }
  document.body.classList.add("playing");
  keepAwake(true);
  world.reset();
  sound.reset();
  state = newRun(seed, kit, region, { depots: hub.profile.depots, seen: hub.profile.seen, from, entry, routes: hub.profile.routes });
  // The ground round where the raid starts is built before its first frame.
  world.prebuild([state.player.pos]);
  governor.settle();
  acc = hitstop = slowmo = 0;
  running = true;
  paused = false;
  $("title").hidden = true;
  $("results").hidden = true;
  $("pause").hidden = true;
  hud.show(true);
  const depot = from && hub.profile.depots.includes(from) ? from : null;
  hud.banner(depot ? `${POIS[poiIndex(depot)].name}の中継ボックス` : entryOf(entry).name, `ここから探索する。拠点と脱出地点は${touchMode ? "地図ボタン" : " M "}の地図で見る`);
  lock();
}

function finish() {
  running = false;
  keepAwake(false);
  document.body.classList.remove("playing");
  fire = ads = false;
  $("banner").className = "";
  hud.show(false);
  hud.results(state, settlement ?? undefined);
  if (state.outcome === "extracted") sfx.extracted();
  else sfx.lost();
  sound.reset();
  $("results").hidden = false;
  if (document.pointerLockElement) document.exitPointerLock();
}

function setPaused(on: boolean) {
  if (!running || bot || manual) return;
  paused = on;
  $("pause").hidden = !on;
  if (on) fire = ads = false;
}

document.addEventListener("pointerlockerror", () => (noLock = true));
document.addEventListener("pointerlockchange", () => {
  if (document.pointerLockElement !== stage && running && state.phase !== "done") setPaused(true);
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) setPaused(true);
  // The system drops the wake lock while the page is hidden.
  wake = null;
  if (!document.hidden && running) keepAwake(true);
});
$("start").addEventListener("click", openHub);
$("restart").addEventListener("click", openHub);
$("resume").addEventListener("click", () => {
  unlock();
  governor.settle();
  setPaused(false);
  lock();
});
stage.addEventListener("click", () => !touchMode && running && !paused && document.pointerLockElement !== stage && lock());
// Browsers start sound only after a gesture; any press on the page counts.
addEventListener("pointerdown", unlock);
addEventListener("keydown", unlock);
for (const id of ["vol", "vol2"]) {
  const el = $(id) as HTMLInputElement;
  el.value = String(savedVolume());
  el.addEventListener("input", () => {
    setVolume(Number(el.value));
    ($("vol") as HTMLInputElement).value = el.value;
    ($("vol2") as HTMLInputElement).value = el.value;
  });
}
setupSoundCheck();
for (const id of ["sens", "sens2"]) {
  const el = $(id) as HTMLInputElement;
  el.addEventListener("input", () => {
    sens = Number(el.value);
    ($("sens") as HTMLInputElement).value = el.value;
    ($("sens2") as HTMLInputElement).value = el.value;
  });
}

// --- automation hooks (Playwright, agents)
declare global {
  interface Window {
    render_game_to_text: () => string;
    advanceTime: (ms: number) => void;
    ringfallStep: (ms: number) => void;
    ringfallDraw: () => void;
    ringfallBot: (skill: string) => void;
    ringfallYaw: () => number;
    ringfallDownAlly: () => void;
    ringfallChargeUlt: () => void;
    ringfallCamera: (x?: number, y?: number, z?: number, yaw?: number, pitch?: number) => void;
    ringfallFrameCost: (frames: number) => { ms: number; calls: number; triangles: number; chunks: number; built: number; of: number };
    ringfallTerrain: (x: number, z: number) => number;
    ringfallFrames: () => Record<string, { x: number; z: number }>;
    ringfallPlace: (x: number, z: number, yaw: number) => void;
  }
}

window.render_game_to_text = () => {
  const s = state;
  const p = s.player;
  return JSON.stringify({
    screen: running ? "game" : !$("results").hidden ? "results" : !$("hub").hidden ? "hub" : !$("ending").hidden ? "ending" : "title",
    profile: { cash: hub.profile.cash, stash: hub.profile.stash.length, raids: hub.profile.raids, hideout: hub.profile.hideout, escaped: !!hub.profile.escaped, seed: hub.profile.seed, routes: hub.profile.routes },
    boost: { ...s.boost, name: POIS[s.boost.poi].name },
    settled: settlement && { home: settlement.home.length, sold: settlement.sold.length, quests: settlement.quests.map((q) => q.id), opened: settlement.opened },
    vaults: s.bins.filter((b) => b.vault).map((b) => ({ poi: b.poi, x: b.x, y: b.y, z: b.z, open: b.open })),
    keys: p.keys,
    phase: s.phase,
    time: +s.time.toFixed(1),
    outcome: s.outcome,
    raid: +s.time.toFixed(1),
    visited: s.visited,
    cleared: s.cleared,
    reinforce: { next: +s.reinforceT.toFixed(1), came: s.reinforceN },
    haul: { items: s.player.haul, tools: s.player.tools, value: haulValue(s), bag: bagLoad(s.player) },
    routes: s.routes,
    depots: s.depots,
    sent: { items: s.sent, value: s.sent.reduce((n, k) => n + VALUABLES[k].value, 0) },
    leaving: s.leaving && +s.leaving.t.toFixed(1),
    leftAt: s.leftAt,
    // A count only: the whole explored map is too long for a line of state.
    seenCells: s.seen.reduce((n, c) => n + c, 0),
    search: s.player.search && { bin: s.player.search.bin, t: +s.player.search.t.toFixed(1) },
    raiders: { next: Number.isFinite(s.raiderT) ? +s.raiderT.toFixed(1) : null },
    player: { x: +p.pos.x.toFixed(1), y: +p.pos.y.toFixed(1), z: +p.pos.z.toFixed(1), hp: Math.round(p.hp), shield: Math.round(p.shield), armor: p.armor, downed: p.downed > 0, weapons: p.weapons.map((w) => w && `${w.kind}${w.rarity}:${w.mag}`), ult: +p.ult.toFixed(2), leap: !!p.leap, reveal: +p.reveal.toFixed(1), crouch: p.crouch },
    ally: { active: s.ally.active, x: +s.ally.pos.x.toFixed(1), y: +s.ally.pos.y.toFixed(1), z: +s.ally.pos.z.toFixed(1), hp: Math.round(s.ally.hp), shield: Math.round(s.ally.shield), down: +s.ally.down.toFixed(1), helped: +s.ally.helped.toFixed(1), rescue: +s.ally.rescue.toFixed(1), target: s.ally.target },
    awaitAlly: p.awaitAlly,
    region: s.region,
    extract: { ship: +callLeft(s, "ship").toFixed(1), boat: +callLeft(s, "boat").toFixed(1), hold: +s.extractTime.toFixed(1), at: s.extractedAt, flares: p.flares },
    enemies: s.enemies.map((e) => ({ kind: e.kind, x: Math.round(e.pos.x), z: Math.round(e.pos.z), y: +e.pos.y.toFixed(1), hp: Math.round(e.hp + e.shield), mode: e.mode, aware: e.aware, detect: +e.detect.toFixed(2), squad: e.squad, target: e.target, ...(e.plate ? { plate: e.plate } : {}) })),
    squads: s.squads.map((q) => ({ name: q.name, poi: q.poi, engaged: q.engaged, lost: q.engaged && q.sinceSeen >= AWARE.trackTime })),
    orbs: s.orbs.length,
    // The first robot shot in the air, for a screenshot of one in flight.
    bolt: s.orbs[0] ? { x: s.orbs[0].pos.x, y: s.orbs[0].pos.y, z: s.orbs[0].pos.z, vx: s.orbs[0].vel.x, vy: s.orbs[0].vel.y, vz: s.orbs[0].vel.z } : null,
    waves: s.waves.length,
    loot: s.loot.length,
    care: s.care ? { landed: s.care.landed, open: s.care.open } : null,
    stats: { ...s.stats, damage: Math.round(s.stats.damage), shots: Math.round(s.stats.shots) },
  });
};

function advance(ms: number, draw: boolean) {
  manual = true;
  quiet = !draw;
  const n = Math.round(ms / 1000 / TICK);
  for (let i = 0; i < n && running; i++) tick();
  if (draw) world.render(state, ms / 1000);
  else world.sync(state, ms / 1000);
  if (running) hud.frame(state, world, ms / 1000, dims.w, dims.h);
}
window.advanceTime = (ms) => advance(ms, true);

/**
 * Automation only: advanceTime without drawing. The scene and the HUD move on as usual but the
 * canvas is left as it was, and the frame loop draws nothing either until advanceTime: drawing in
 * software is most of what a step costs, and a gate waiting on the state need not pay it each step.
 */
window.ringfallStep = (ms) => advance(ms, false);

/** Automation only: draws the scene as the last step left it, before a screenshot of an undrawn step. */
window.ringfallDraw = () => world.draw();

/** Look from a fixed point without touching the run (for screenshots of the island). No arguments: back to the player. */
window.ringfallCamera = (x, y, z, yaw, pitch) => {
  world.cameraOverride = x === undefined ? null : { x, y: y ?? 2, z: z ?? 0, yaw: yaw ?? 0, pitch: pitch ?? 0 };
  world.render(state, 0.016);
};

/** Automation only: fill the ult's charge, to check the leap. */
window.ringfallChargeUlt = () => {
  state.player.ult = 1;
};

/** Automation only: knock the teammate down, to check picking it up. */
window.ringfallDownAlly = () => hurtAlly(state, 9999);

/** Automation only: draws `frames` frames as they stand and reports the average time and the last frame's cost. */
window.ringfallFrameCost = (frames: number) => {
  const t0 = performance.now();
  for (let i = 0; i < frames; i++) world.render(state, 1 / 60);
  return { ms: +((performance.now() - t0) / frames).toFixed(1), ...world.stats() };
};

/** Automation only: where each POI, hamlet and area is written round, to place the screenshot cameras in their frames. */
window.ringfallFrames = () => FRAMES;

/** Automation only: the ground's height at (x, z), to place the screenshot cameras. */
window.ringfallTerrain = (x, z) => terrainHeight(x, z);

/** Automation only: stands the player at (x, z) on the ground facing `yaw`, the teammate beside them (screenshots of one place). */
window.ringfallPlace = (x, z, yaw) => {
  const p = state.player;
  p.pos = { x, y: groundAt(x, z, 0.4, terrainHeight(x, z) + 1), z };
  p.vel = { x: 0, y: 0, z: 0 };
  p.yaw = yaw;
  p.pitch = 0;
  p.onGround = true;
  placeAlly(state);
};

/** The player's exact view yaw (render_game_to_text rounds it away). */
window.ringfallYaw = () => state.player.yaw;

window.ringfallBot = (skill: string) => {
  bot = new Bot(SKILLS.find((k) => k.name === skill) ?? SKILLS[1], 31);
};
