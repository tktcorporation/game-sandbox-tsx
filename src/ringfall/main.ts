import { spawnEnemy } from "./sim/enemies";
import { AWARE, PLAYER, TICK, VALUABLES, WEAPONS, type EnemyKind } from "./sim/config";
import { Bot, SKILLS } from "./sim/bot";
import { collide, groundAt } from "./sim/geom";
import { terrainHeight } from "./sim/terrain";
import { callLeft, freeKit, idleInput, newRun, type GameEvent, type Input, type Kit, type State } from "./sim/state";
import { CAMP, DEPOTS, entryOf, FRAMES, NODES, POIS, poiIndex, QUARRY_EXITS, ZIPS, type CampSpot, type RegionId, type StationId } from "./sim/map";
import { grabZip } from "./sim/zips";
import { POI_AT } from "./sim/areas";
import { frontNodes, garrisonOf, takeNode, useCore } from "./sim/front";
import { atRisk, battleMarks, departNow, landNow, marchSquad, nodePoint, placeBattleSquad } from "./sim/battle";
import { campSpotAt, newCamp, outOfCamp, stepCamp, walkOut } from "./sim/camp";
import { analyse, raidThreat, settle, takenStory, type Settlement } from "./meta/profile";
import { pouchSlots } from "./meta/hideout";
import { MOD, MODS, type ModKind } from "./sim/config";
import { departDepots, holds, islandHolds } from "./meta/island";
import { nodeRow } from "./view/row";
import { contractProgress, targetKey } from "./meta/contracts";
import { currentStory } from "./meta/story";
import { bodyCenter, eyePos, fireRay, kill } from "./sim/combat";
import { squadKey } from "./sim/state";
import { loadProfile, saveProfile } from "./meta/storage";
import { Hub, type Launch } from "./view/hub";
import { CampView } from "./view/camp";
import { DepartPicker } from "./view/depart";
import { step } from "./sim/step";
import { hurtAlly, placeAlly } from "./sim/ally";
import { haulValue } from "./sim/results";
import { bagLoad } from "./sim/world";
import { preferLowPower, savedVolume, setVolume, unlock } from "./view/audio";
import { sfx } from "./view/sfx";
import { Soundscape } from "./view/soundscape";
import { setupSoundCheck } from "./view/soundcheck";
import { Hud } from "./view/hud";
import { sightZoom, World } from "./view/world";
import { Governor, loadChoice, pickTier, QUALITY, saveChoice, type Level, type QualityChoice, type Tier } from "./view/quality";
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
/** A raid is under way. */
let running = false;
/** The player is in the camp between raids (`state` is the camp's). */
let camping = false;
/** The truck's fade to a raid is under way. */
let fading = false;
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
/** F's switched-on aim in the toggle mode, kept apart so the right button held and released does not undo it. */
let adsLatch = false;
type AdsMode = "hold" | "toggle";
const ADS_KEY = "ringfall-ads-mode";
function loadAdsMode(): AdsMode {
  try {
    return localStorage.getItem(ADS_KEY) === "toggle" ? "toggle" : "hold";
  } catch {
    // Storage blocked (a private window): held, like the right button.
    return "hold";
  }
}
function saveAdsMode(m: AdsMode) {
  try {
    localStorage.setItem(ADS_KEY, m);
  } catch {
    // Not remembered; the choice still holds for this visit.
  }
}
let adsMode = loadAdsMode();
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
  // The departure's check: Enter (or the use key) goes, Esc turns back.
  if (departing) {
    if (e.code === "Enter" || e.code === "NumpadEnter" || e.code === "KeyE") answerDepart(true);
    else if (e.code === "Escape" || e.code === "Backspace") answerDepart(false);
    // The arrows (and A / D) step the start chosen on the map.
    else if (["ArrowRight", "ArrowDown", "KeyD", "Tab"].includes(e.code)) picker.cycle(e.shiftKey && e.code === "Tab" ? -1 : 1);
    else if (["ArrowLeft", "ArrowUp", "KeyA"].includes(e.code)) picker.cycle(-1);
    e.preventDefault();
    return;
  }
  // Esc closes a camp station's panel (the pointer is already free while one is open).
  if (e.code === "Escape" && hub.station) {
    hub.close();
    return;
  }
  // F aims on its own key, for trackpads that cannot hold the right button while clicking to fire.
  if (e.code === "KeyF" && adsMode === "toggle" && running && !paused) adsLatch = !adsLatch;
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
  if (document.pointerLockElement !== stage && !(noLock && (running || (camping && !campFrozen())) && !paused)) return;
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
  fire = ads = adsLatch = false;
});

function readInput(): Input {
  const inp = idleInput();
  inp.moveZ = (keys.has("KeyW") ? 1 : 0) - (keys.has("KeyS") ? 1 : 0) + stick.z;
  inp.moveX = (keys.has("KeyD") ? 1 : 0) - (keys.has("KeyA") ? 1 : 0) + stick.x;
  inp.touch = touchMode;
  // Aiming slows the view in step with the zoom, so a scope does not swing wildly.
  const pl = state.player;
  const held = pl.weapons[pl.slot];
  const zoom = held ? 1 - pl.ads * (1 - sightZoom(WEAPONS[held.kind].adsFov)) : 1;
  const k = 0.0022 * sens * zoom;
  inp.lookX = look.x * k;
  inp.lookY = -look.y * k;
  look.x = look.y = 0;
  inp.fire = fire;
  inp.ads = ads || adsLatch || (adsMode === "hold" && keys.has("KeyF"));
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
    knownBefore = [...hub.profile.known];
    analysed = null;
    settlement = settle(hub.profile, s);
    hub.reload(settlement.profile);
    saveProfile(hub.profile);
    setTimeout(finish, s.outcome === "extracted" ? 1400 : 2400);
  }
}

function tick() {
  if (camping) return campTick();
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

/** Keeps the phone's screen awake in a raid and in the camp; let go when the page is hidden, taken again on return. */
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
/**
 * On the governor's 30 fps rungs frames draw against deadlines a thirtieth of a second apart, so
 * the rate averages 30 at any refresh rate (every other frame at 60 Hz, two of every five at 75 Hz).
 * A deadline that falls more than a frame behind (a stall, a hidden page, the first capped frame)
 * restarts from now.
 */
const CAP_MS = 1000 / 30;
/** Slack for refresh jitter, so a frame a hair early still meets its deadline. */
const CAP_SLACK = 2;
let capDue = 0;
function frame(now: number) {
  // The first frame's timestamp can predate `last` by the seconds the page took to load, and a
  // negative step would grow every fade in the view (the muzzle flash and its light) instead.
  const dt = Math.max(0, Math.min(0.1, (now - last) / 1000));
  last = now;
  if ((running || (camping && !campFrozen())) && !paused && !manual) {
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
  drawDt += dt;
  // Nothing is drawn while the page is hidden: some web views keep calling frames for a page in
  // the background, and drawing there only spends the battery.
  const capped = governor.level.cap30 && now < capDue - CAP_SLACK;
  const drawn = !(manual && quiet) && !capped && !document.hidden;
  if (drawn) {
    world.render(state, drawDt);
    if (running) hud.frame(state, world, drawDt, dims.w, dims.h);
    if (camping) campFrame();
    drawDt = 0;
    if (!automated && running && !paused && !manual) {
      const l = governor.frame(now - drawnAt);
      if (l) applyLevel(l);
    }
    drawnAt = now;
    // The deadline runs only on the capped rungs; off them it is cleared, so the first capped frame draws at once.
    capDue = !governor.level.cap30 ? 0 : now - capDue > CAP_MS ? now + CAP_MS : capDue + CAP_MS;
  } else if (manual) drawDt = 0;
  sound.frame(state, world.camera, dt, (running || camping) && !paused);
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
/** The mod kinds known when the raid ended, and the one analysed on its results (one at most). */
let knownBefore: ModKind[] = [];
let analysed: ModKind | null = null;
const hub = new Hub(loadProfile(), () => lock());
const campView = new CampView();
const picker = new DepartPicker(hub, () => answerDepart(true));
// The title's one line on the goal: the island's six nodes, filled blue as far as this save has taken them.
$("title-row").innerHTML = nodeRow(islandHolds(hub.profile));

/**
 * The departure, while it is up: its map of starts, the kit and the confirm. Opened at the gate on
 * foot (`walk`, where the player stands now; `back` is the last place inside the yard, for a
 * cancel) or at the truck. Either way the start is the one chosen on the map.
 */
let departing: { walk: boolean; back: { x: number; y: number; z: number; yaw: number } | null } | null = null;
/** The last place inside the camp's yard the player stood, for turning back from the gate. */
let inside: { x: number; y: number; z: number; yaw: number } | null = null;

/** The camp stands still while a station's panel, the departure's check or the truck's fade is up. */
const campFrozen = () => hub.station !== null || departing !== null || fading;

/** Fades the screen to the camp's dark and back: `on` covers it at once when `now`, else over its transition. */
function fade(on: boolean, now = false) {
  const el = $("fade");
  if (now) {
    el.style.transition = "none";
    el.classList.toggle("on", on);
    void el.offsetWidth;
    el.style.transition = "";
  } else el.classList.toggle("on", on);
}

/** Wakes the player in the camp, the teammate beside them: from the title, after the results. */
function openCamp() {
  departing = inside = null;
  picker.show(false);
  $("title").hidden = true;
  $("results").hidden = true;
  $("pause").hidden = true;
  hub.close(false);
  running = false;
  camping = true;
  paused = false;
  fading = false;
  fire = ads = adsLatch = false;
  unlock();
  world.reset();
  sound.reset();
  state = newCamp(hub.profile.seed, hub.profile.routes);
  world.campMode = true;
  world.prebuild([state.player.pos]);
  acc = hitstop = slowmo = 0;
  hud.show(false);
  // The raid's red edge and the leap's glow stay where the raid left them: the camp starts clear of both.
  $("fx-hurt").style.opacity = $("fx-ult").style.opacity = "0";
  campView.show(true);
  document.body.classList.add("playing", "camp");
  keepAwake(true);
  fade(true, true);
  requestAnimationFrame(() => fade(false));
  lock();
}

/** Opens a station's panel: the camp stands still and the pointer is let go. */
function openPanel(id: StationId) {
  keys.clear();
  stick.x = stick.z = 0;
  fire = ads = adsLatch = false;
  hub.open(id);
  if (document.pointerLockElement) document.exitPointerLock();
}

/** Puts up the departure: the island with every start on it (the last one chosen), the kit and the objective. */
function askDepart(walk: boolean) {
  departing = { walk, back: walk ? inside : null };
  keys.clear();
  stick.x = stick.z = 0;
  fire = ads = adsLatch = false;
  picker.show(true);
  if (document.pointerLockElement) document.exitPointerLock();
}

/**
 * The departure answered: out into the raid, or back into the yard facing it (from the gate). A
 * start at the gate's own way in walks out where the player stands; any other start, or one from
 * the truck, comes after a fade. A depot the loadout does not fit cannot be departed from.
 */
function answerDepart(go: boolean) {
  const d = departing;
  if (!d || !camping) return;
  if (go && hub.rideRefused()) return;
  departing = null;
  picker.show(false);
  sfx.click();
  if (go) {
    if (d.walk && hub.walksOut()) {
      const launch = hub.launch();
      if (launch) {
        sfx.deploy();
        start(launch, state);
      }
    } else ride();
    return;
  }
  if (d.walk && d.back) {
    const p = state.player;
    p.pos = { x: d.back.x, y: d.back.y, z: d.back.z };
    p.vel = { x: 0, y: 0, z: 0 };
    p.yaw = d.back.yaw + Math.PI;
    placeAlly(state);
  }
  lock();
}

/** A start away from the gate: a fade, then the raid at the start chosen on the departure's map. */
function ride() {
  if (fading || hub.rideRefused()) return;
  fading = true;
  sfx.deploy();
  fade(true);
  setTimeout(() => {
    const go = hub.launch();
    fading = false;
    if (go) start(go);
    requestAnimationFrame(() => fade(false));
  }, 480);
}

/** The use key in the camp: the panel of the station in reach, or the truck. */
function useInCamp() {
  const spot = campSpotAt(state.player.pos);
  if (!spot) return;
  if (spot.id === "vehicle") askDepart(false);
  else openPanel(spot.id);
}

function campTick() {
  const inp = readInput();
  stepCamp(state, inp, prevCrouch);
  prevCrouch = inp.crouch;
  world.handle(state, state.events);
  for (const e of state.events) sound.event(e, state);
  if (inp.interact) useInCamp();
  // Out of the gate: the departure, then the raid starts where the player stands when its start is the gate's own way in.
  else if (outOfCamp(state)) askDepart(true);
  else inside = { ...state.player.pos, yaw: state.player.yaw };
}

function campFrame() {
  const near = campFrozen() ? null : campSpotAt(state.player.pos);
  campView.frame(state, world, dims.w, dims.h, { near, marks: hub.marks(), cash: hub.profile.cash.toLocaleString("ja-JP"), touch: touchMode, today: hub.today(), panel: hub.station !== null || departing !== null });
}

/** `from`: the camp the player walked out of, carried over into the raid where they stand. */
function start(go: Launch, from?: State) {
  kit = go.kit;
  region = go.region;
  settlement = null;
  unlock();
  if (touchMode) {
    // Full screen and landscape where the browser allows it; the game runs either way.
    document.documentElement.requestFullscreen?.().catch(() => undefined);
    (screen.orientation as unknown as { lock?: (o: string) => Promise<void> } | undefined)?.lock?.("landscape").catch(() => undefined);
  }
  hub.close(false);
  camping = false;
  campView.show(false);
  document.body.classList.remove("camp");
  document.body.classList.add("playing");
  keepAwake(true);
  world.reset();
  sound.reset();
  // The story record under way lies on the island, whichever contract was taken.
  const record = currentStory(hub.profile.records)?.id;
  const taken = hub.contract();
  const fetch = taken?.t === "fetch" ? { poi: taken.poi, kind: taken.kind, n: taken.n } : undefined;
  state = newRun(go.seed, kit, region, { depots: hub.profile.depots, seen: hub.profile.seen, from: go.from, entry: go.entry, routes: hub.profile.routes, island: holds(hub.profile), record, fetch, event: hub.profile.events[0], threat: raidThreat(hub.profile), known: hub.profile.known, battle: { factory: hub.profile.factory } });
  hud.setContract(hub.contract(), record ?? null, takenStory(hub.profile));
  world.campMode = false;
  if (from) walkOut(state, from);
  // The ground round where the raid starts is built before its first frame.
  else world.prebuild([state.player.pos]);
  governor.settle();
  acc = hitstop = slowmo = 0;
  running = true;
  paused = false;
  $("title").hidden = true;
  $("results").hidden = true;
  $("pause").hidden = true;
  hud.show(true);
  hud.setKnown(hub.profile.entries);
  hud.setPouch(pouchSlots(hub.profile.hideout));
  const depot = go.from && departDepots(hub.profile).includes(go.from) ? go.from : null;
  hud.banner(depot ? `${POIS[poiIndex(depot)].name}の中継ボックス` : entryOf(go.entry).name);
  lock();
}

function finish() {
  running = false;
  keepAwake(false);
  document.body.classList.remove("playing");
  fire = ads = adsLatch = false;
  $("banner").className = "";
  hud.show(false);
  hud.results(state, settlement ?? undefined, knownBefore, analysed);
  if (state.outcome === "extracted") sfx.extracted();
  else sfx.lost();
  sound.reset();
  $("results").hidden = false;
  if (document.pointerLockElement) document.exitPointerLock();
}

// Analysing a mod part on the results: its kind is known from now on, and the card says so.
$("home").addEventListener("click", (e) => {
  const k = (e.target as HTMLElement).closest<HTMLElement>("[data-analyse]")?.dataset.analyse as ModKind | undefined;
  if (!k || !settlement || analysed) return;
  const next = analyse(hub.profile, settlement, k);
  if (!next) return;
  analysed = k;
  hub.reload(next);
  saveProfile(hub.profile);
  sfx.click();
  hud.results(state, settlement, knownBefore, analysed);
});

function setPaused(on: boolean) {
  if (!(running || (camping && !campFrozen())) || bot || manual) return;
  paused = on;
  $("pause").hidden = !on;
  if (on) fire = ads = adsLatch = false;
}

document.addEventListener("pointerlockerror", () => (noLock = true));
document.addEventListener("pointerlockchange", () => {
  if (document.pointerLockElement !== stage && ((running && state.phase !== "done") || camping)) setPaused(true);
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) setPaused(true);
  // The system drops the wake lock while the page is hidden.
  wake = null;
  if (!document.hidden && (running || camping)) keepAwake(true);
  if (!document.hidden) governor.settle();
});
$("start").addEventListener("click", openCamp);
$("depart-go").addEventListener("click", () => answerDepart(true));
$("depart-cancel").addEventListener("click", () => answerDepart(false));
$("restart").addEventListener("click", openCamp);
$("resume").addEventListener("click", () => {
  unlock();
  governor.settle();
  setPaused(false);
  lock();
});
stage.addEventListener("click", () => !touchMode && (running || (camping && !campFrozen())) && !paused && document.pointerLockElement !== stage && lock());
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
// 画質: automatic follows the device and the governor; a tier pins it, only its resolution moving.
// Antialiasing stays as the page loaded with it: it is fixed when the renderer is made.
for (const id of ["quality", "quality2"]) {
  const el = $(id) as HTMLSelectElement;
  el.value = quality;
  el.addEventListener("change", () => {
    quality = el.value as QualityChoice;
    saveChoice(quality);
    ($("quality") as HTMLSelectElement).value = quality;
    ($("quality2") as HTMLSelectElement).value = quality;
    governor = new Governor(quality === "auto" ? deviceTier : quality, devicePixelRatio, quality !== "auto");
    applyLevel(governor.level);
  });
}
// 覗き方: F aims while held, or each press switches aiming on and off; the right button always aims while held.
for (const id of ["adsmode", "adsmode2"]) {
  const el = $(id) as HTMLSelectElement;
  el.value = adsMode;
  el.addEventListener("change", () => {
    adsMode = el.value === "toggle" ? "toggle" : "hold";
    saveAdsMode(adsMode);
    ads = adsLatch = false;
    ($("adsmode") as HTMLSelectElement).value = adsMode;
    ($("adsmode2") as HTMLSelectElement).value = adsMode;
  });
}
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
    ringfallFrameCost: (frames: number) => { ms: number; syncMs: number; calls: number; triangles: number; chunks: number; built: number; of: number; tier: Tier; ratio: number; fillMs: number; trimMs: number; trims: number; layMs: number };
    ringfallQuality: (tier?: Tier) => { tier: Tier; ratio: number };
    ringfallTerrain: (x: number, z: number) => number;
    ringfallFrames: () => Record<string, { x: number; z: number }>;
    ringfallPlace: (x: number, z: number, yaw: number) => void;
    ringfallMove: {
      quiet: () => void;
      look: (pitch: number) => void;
      hold: () => void;
      zips: () => { i: number; a: string; b: string; fixed: boolean; length: number; from: { x: number; y: number; z: number }; to: { x: number; y: number; z: number } }[];
      zip: (i: number, at: number) => boolean;
      quarry: () => { name: string; x: number; z: number; yaw: number }[];
      state: () => { speed: number; y: number; zip: boolean; climb: boolean; mantle: boolean; sliding: boolean; onGround: boolean; fov: number };
    };
    ringfallFight: (x: number, z: number, apart?: number) => { x: number; z: number }[];
    ringfallPlates: (x: number, z: number, face?: number) => { id: number; x: number; y: number; z: number }[];
    ringfallShoot: (id: number, rarity: number) => { plate: number; left: number } | null;
    ringfallClearPlates: () => void;
    ringfallBattle: (x: number, z: number, apart?: number) => { x: number; z: number }[] | null;
    ringfallWar: {
      land: (boat: boolean) => { x: number; z: number } | null;
      march: (side: 0 | 1 | 2, kinds: string[], from: number, to: number, d: number) => { x: number; z: number; squad: number } | null;
      depart: () => void;
      place: (side: 0 | 1 | 2, kinds: string[], x: number, z: number, attack?: boolean) => number;
      point: (i: number) => { x: number; z: number };
      core: (i: number) => void;
      clear: (i: number) => void;
      take: (i: number, soon?: boolean) => void;
    };
    ringfallContract: {
      take: (type: string) => string | null;
      destroyTarget: () => number;
    };
    ringfallBag: (haul: string[]) => void;
    ringfallEnd: (how: "dead" | "extracted", haul?: string[], found?: string[]) => boolean;
    ringfallMods: {
      wear: (kinds: string[]) => void;
      drop: (kind: string, ahead: number) => void;
    };
    ringfallCamp: {
      spots: () => CampSpot[];
      walkTo: (id: CampSpot["id"]) => boolean;
      toGate: () => void;
      use: () => void;
      open: (id: StationId) => void;
      close: () => void;
    };
  }
}

window.render_game_to_text = () => {
  const s = state;
  const p = s.player;
  return JSON.stringify({
    screen: running ? "game" : !$("results").hidden ? "results" : camping ? "camp" : "title",
    camp: camping ? { panel: hub.station, depart: departing && { walk: departing.walk, ...hub.departure(), start: hub.startPoints().find((q) => q.on) ?? null, starts: hub.startPoints().map((q) => ({ kind: q.kind, id: q.id, region: q.region, open: q.open, over: q.over })), refused: hub.rideRefused() }, today: hub.today(), near: campSpotAt(p.pos)?.id ?? null, lent: hub.lent, ride: { to: hub.rideTo(), refused: hub.rideRefused() }, marks: hub.marks(), fading, board: hub.profile.board.contracts.map((c) => ({ id: c.id, t: c.t })), taken: hub.profile.taken, story: currentStory(hub.profile.records)?.id ?? null } : null,
    profile: { events: hub.profile.events, cash: hub.profile.cash, stash: hub.profile.stash.length, raids: hub.profile.raids, hideout: hub.profile.hideout, seed: hub.profile.seed, routes: hub.profile.routes, entries: hub.profile.entries, day: hub.profile.day, poiState: hub.profile.poiState, threat: hub.profile.threat, known: hub.profile.known, freedAt: hub.profile.freedAt, factory: hub.profile.factory },
    boost: { ...s.boost, name: POIS[s.boost.poi].name },
    strength: s.strength,
    threat: s.threat,
    mods: p.mods,
    modsAround: s.loot.filter((l) => l.kind === "mod").map((l) => ({ mod: l.mod, x: +l.pos.x.toFixed(1), y: +l.pos.y.toFixed(1), z: +l.pos.z.toFixed(1) })),
    event: s.event,
    storm: s.storm,
    debris: s.bins.filter((b) => b.debris).map((b) => ({ x: b.x, y: +b.y.toFixed(1), z: b.z, open: b.open }))[0] ?? null,
    crews: s.squads.flatMap((q, i) => (q.crew ? [{ squad: i, members: s.enemies.filter((e) => e.squad === i).map((e) => ({ x: Math.round(e.pos.x), y: +e.pos.y.toFixed(1), z: Math.round(e.pos.z) })), bin: q.crew.bin >= 0 ? { x: s.bins[q.crew.bin].x, y: s.bins[q.crew.bin].y, z: s.bins[q.crew.bin].z } : null, searching: q.crew.searchT > 0, bag: q.bag ?? [], leaving: q.crew.leaving }] : [])),
    settled: settlement && { event: settlement.event, home: settlement.home.length, sold: settlement.sold.length, quests: settlement.quests.map((q) => q.id), opened: settlement.opened, learned: settlement.learned, day: settlement.day, freed: settlement.freed, front: settlement.front, raid: settlement.raid, after: settlement.after, night: settlement.night, income: settlement.income, contract: settlement.contract && { id: settlement.contract.c.id, t: settlement.contract.c.t, done: settlement.contract.done }, story: settlement.story?.id ?? null, threat: settlement.threat, analysable: settlement.analysable, analysed },
    contract: running && hub.contract() ? { t: hub.contract()!.t, ...contractProgress(hub.contract()!, s) } : null,
    records: s.player.records,
    vaults: s.bins.filter((b) => b.vault).map((b) => ({ poi: b.poi, x: b.x, y: b.y, z: b.z, open: b.open })),
    flares: s.bins.filter((b) => b.flare).map((b) => ({ x: b.x, y: b.y, z: b.z, open: b.open })),
    keys: p.keys,
    phase: s.phase,
    time: +s.time.toFixed(1),
    outcome: s.outcome,
    raid: +s.time.toFixed(1),
    visited: s.visited,
    cleared: s.cleared,
    hold: s.hold,
    reinforce: { next: +s.reinforceT.toFixed(1), came: s.reinforceN },
    haul: { items: s.player.haul, tools: s.player.tools, value: haulValue(s), bag: bagLoad(s.player) },
    routes: s.routes,
    depots: s.depots,
    depotSpots: DEPOTS.map((d) => ({ poi: d.poi, x: d.x, z: d.z, yaw: d.yaw })),
    sent: { items: s.sent, value: s.sent.reduce((n, k) => n + VALUABLES[k].value, 0) },
    leaving: s.leaving && +s.leaving.t.toFixed(1),
    leftAt: s.leftAt,
    home: s.home,
    away: +s.away.toFixed(1),
    found: s.found,
    // A count only: the whole explored map is too long for a line of state.
    seenCells: s.seen.reduce((n, c) => n + c, 0),
    search: s.player.search && { bin: s.player.search.bin, t: +s.player.search.t.toFixed(1) },
    raiders: { next: Number.isFinite(s.raiderT) ? +s.raiderT.toFixed(1) : null },
    player: { x: +p.pos.x.toFixed(1), y: +p.pos.y.toFixed(1), z: +p.pos.z.toFixed(1), hp: Math.round(p.hp), shield: Math.round(p.shield), armor: p.armor, downed: p.downed > 0, weapons: p.weapons.map((w) => w && `${w.kind}${w.rarity}:${w.mag}`), ult: +p.ult.toFixed(2), leap: !!p.leap, reveal: +p.reveal.toFixed(1), crouch: p.crouch, ads: +p.ads.toFixed(2) },
    ally: { active: s.ally.active, x: +s.ally.pos.x.toFixed(1), y: +s.ally.pos.y.toFixed(1), z: +s.ally.pos.z.toFixed(1), hp: Math.round(s.ally.hp), shield: Math.round(s.ally.shield), down: +s.ally.down.toFixed(1), helped: +s.ally.helped.toFixed(1), rescue: +s.ally.rescue.toFixed(1), target: s.ally.target },
    awaitAlly: p.awaitAlly,
    region: s.region,
    extract: { ship: +callLeft(s, "ship").toFixed(1), boat: +callLeft(s, "boat").toFixed(1), hold: +s.extractTime.toFixed(1), at: s.extractedAt, flares: p.flares },
    enemies: s.enemies.map((e) => ({ kind: e.kind, x: Math.round(e.pos.x), z: Math.round(e.pos.z), y: +e.pos.y.toFixed(1), hp: Math.round(e.hp + e.shield), mode: e.mode, aware: e.aware, detect: +e.detect.toFixed(2), squad: e.squad, target: e.target, ...(e.plate ? { plate: e.plate } : {}), ...(e.rogue ? { rogue: true } : {}) })),
    squads: s.squads.map((q) => ({ name: q.name, poi: q.poi, engaged: q.engaged, lost: q.engaged && q.sinceSeen >= AWARE.trackTime, ...(q.rogue ? { rogue: true } : {}), ...(q.mobile ? { mobile: true } : {}), ...(q.foe !== undefined ? { foe: q.foe } : {}), ...(q.ambush ? { ambush: true } : {}) })),
    battle: s.battle && {
      left: Math.max(0, Math.round(s.battle.end - s.battle.now)),
      factory: s.battle.factory,
      done: s.battle.done,
      taken: s.battle.taken,
      meters: NODES.map((n, i) => s.battle!.meter[i] && { id: n.id, side: s.battle!.meter[i]!.side, t: +s.battle!.meter[i]!.t.toFixed(1) }).filter(Boolean),
      squads: battleMarks(s).map((m) => ({ ...m, x: Math.round(m.x), z: Math.round(m.z), to: NODES[m.to]?.id ?? "camp" })),
      friends: s.friends.map((e) => ({ kind: e.kind, x: Math.round(e.pos.x), y: +e.pos.y.toFixed(1), z: Math.round(e.pos.z), hp: Math.round(e.hp + e.shield), mode: e.mode, squad: e.squad, ...(e.post ? { post: true } : {}) })),
      landings: s.battle.landings.map((l) => ({ boat: l.boat, x: l.x, z: l.z, down: l.down })),
      departs: s.battle.departs,
      threat: NODES.filter((_, i) => s.battle!.threat[i]).map((n) => n.id),
      risk: NODES.filter((_, i) => atRisk(s)[i]).map((n) => n.id),
      counters: s.battle.counters.map((c) => ({ node: NODES[c.node].id, at: c.at })),
      counterSquads: s.battle.squads.filter((q) => q.counter).map((q) => ({ to: NODES[q.via.length ? q.via[q.via.length - 1] : q.to]?.id, ashore: q.ashore, x: Math.round(q.x), z: Math.round(q.z), live: q.squad >= 0 })),
      rally: NODES[s.battle.rally]?.id ?? null,
      now: s.battle.now,
    },
    front: { nodes: s.nodes, onFront: frontNodes(s.nodes), capture: s.capture && { node: NODES[s.capture.node].id, t: +s.capture.t.toFixed(1), held: s.capture.held, waves: s.capture.waves }, cores: NODES.map((n) => ({ id: n.id, x: n.core.x, y: +n.core.y.toFixed(1), z: n.core.z })) },
    objective: running ? hud.objective() : null,
    contacts: s.contacts.map((c) => ({ squad: c.squad, x: c.x, z: c.z, age: +(s.time - c.t).toFixed(1), rogue: c.rogue, fight: c.fight })),
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
  for (let i = 0; i < n && (running || (camping && !campFrozen())); i++) tick();
  if (draw) world.render(state, ms / 1000);
  else world.sync(state, ms / 1000);
  if (running) hud.frame(state, world, ms / 1000, dims.w, dims.h);
  if (camping) campFrame();
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

/**
 * Automation only: draws `frames` frames as they stand and reports the averages per frame, with the
 * tier and pixel ratio drawn at. Draw calls and triangles are averaged because the tiers that redraw
 * shadows at their own rate draw the shadow pass on some frames only. `ms` is the time to issue a
 * frame; `syncMs` also waits for the GPU to finish them (a pixel read back at the end).
 */
window.ringfallFrameCost = (frames: number) => {
  let calls = 0;
  let triangles = 0;
  const t0 = performance.now();
  for (let i = 0; i < frames; i++) {
    world.render(state, 1 / 60);
    const st = world.stats();
    calls += st.calls;
    triangles += st.triangles;
  }
  const t1 = performance.now();
  const gl = world.renderer.getContext();
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  const t2 = performance.now();
  return { ...world.stats(), ms: +((t1 - t0) / frames).toFixed(1), syncMs: +((t2 - t0) / frames).toFixed(1), calls: Math.round(calls / frames), triangles: Math.round(triangles / frames) };
};

/** Automation only: draws at `tier` from now on, its resolution pinned at its start (the governor stays off under automation). */
window.ringfallQuality = (tier) => {
  if (tier) {
    governor = new Governor(tier, devicePixelRatio, true);
    applyLevel(governor.level);
  }
  return { tier: world.tier, ratio: world.renderer.getPixelRatio() };
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
  // Whatever it was doing is left behind: a climb, a ride, a slide.
  p.mantle = null;
  p.zip = null;
  p.zipFall = false;
  p.sliding = false;
  placeAlly(state);
};

/**
 * Automation only, for the movement's screenshots: `quiet` takes every robot out of the raid and
 * keeps the hunters away; `look` tilts the view; `hold` makes every node the player's, so every zipline is up; `zips`
 * lists the cables; `zip` takes hold of cable `i` at `at` metres along it; `quarry` gives where
 * each of the quarry's wide stairs is climbed from, facing it; `state` is how the player moves now.
 */
window.ringfallMove = {
  quiet: () => {
    state.enemies = [];
    state.parties = [];
    state.crewsDue = [];
    state.reinforceT = state.raiderT = 1e9;
  },
  look: (pitch) => {
    state.player.pitch = pitch;
  },
  hold: () => {
    state.nodes = state.nodes.map(() => "freed");
  },
  zips: () => ZIPS.map((l, i) => ({ i, a: l.a, b: l.b, fixed: !!l.fixed, length: l.length, from: l.pts[0], to: l.pts[l.pts.length - 1] })),
  zip: (i, at) => {
    grabZip(state, i, at);
    return !!state.player.zip;
  },
  quarry: () => QUARRY_EXITS.map((q) => ({ name: q.name, x: q.x + POI_AT.quarry[0], z: q.z + POI_AT.quarry[1], yaw: { n: 0, e: Math.PI / 2, s: Math.PI, w: -Math.PI / 2 }[q.toward] })),
  state: () => {
    const p = state.player;
    return { speed: Math.hypot(p.vel.x, p.vel.z), y: p.pos.y, zip: !!p.zip, climb: !!p.mantle?.climb, mantle: !!p.mantle, sliding: p.sliding, onGround: p.onGround, fov: world.fov() };
  },
};

/** The player's exact view yaw (render_game_to_text rounds it away). */
window.ringfallYaw = () => state.player.yaw;

/**
 * Automation only: two squads of the factions set down `apart` metres either side of (x, z) on the
 * ground, facing each other and each set on the other (see FACTION), for a screenshot of a fight
 * between them. Returns where each squad stands.
 */
window.ringfallFight = (x, z, apart = 34) => {
  const s = state;
  const at: { x: number; z: number }[] = [];
  for (const rogue of [false, true]) {
    const index = s.squads.length;
    const cx = x + (rogue ? apart / 2 : -apart / 2);
    s.squads.push({ name: rogue ? "野良機" : "網", poi: -1, patrol: [], leg: 0, engaged: false, roam: false, rogue: rogue || undefined, sinceSeen: 0, last: { x: 0, z: 0 } });
    for (const [k, kind] of (["grunt", "grunt", "drone"] as const).entries()) spawnEnemy(s, kind, cx, z + (k - 1) * 3, -1, index, { face: rogue ? -Math.PI / 2 : Math.PI / 2, rogue });
    at.push({ x: cx, z });
  }
  const [a, b] = [s.squads.length - 2, s.squads.length - 1];
  s.squads[a].foe = s.enemies.find((e) => e.squad === b)?.id;
  s.squads[b].foe = s.enemies.find((e) => e.squad === a)?.id;
  s.squads[a].foeT = s.squads[b].foeT = 0;
  return at;
};

/**
 * Automation only: one of the player's own squads and one of the network's set down `apart`
 * metres either side of (x, z) in the day's battle, each set on the other, for a screenshot of a
 * fight between them. Returns where each stands, or null in a raid with no battle.
 */
window.ringfallBattle = (x, z, apart = 30) => {
  const s = state;
  if (!s.battle) return null;
  const ours = placeBattleSquad(s, 0, ["grunt", "heavy", "drone"], x - apart / 2, z);
  const theirs = placeBattleSquad(s, 1, ["grunt", "grunt", "drone"], x + apart / 2, z);
  s.squads[ours].foe = s.enemies.find((e) => e.squad === theirs)?.id;
  s.squads[theirs].foe = s.friends.find((e) => e.squad === ours)?.id;
  s.squads[ours].foeT = s.squads[theirs].foeT = 0;
  return [
    { x: x - apart / 2, z },
    { x: x + apart / 2, z },
  ];
};

/**
 * Automation only, the day's battle: `land` sets the enemy landing a squad now (by boat on the
 * north shore, else by dropship on the pad) and returns where; `march` sets a squad of `side`
 * walking from node `from` to `to` (places in `NODES`, the camp -1, the pad -2, the shore -3,
 * a node's depot 100 + its place), `d` metres along, its robots in the world, and returns where
 * its first stands; `depart` has the factory send its next squad now; `place` sets a squad of
 * `side` down at (x, z) to hold the nearest node, or to attack it; `point` is where a squad
 * stands at such a place; `core` starts the capture of node `i`'s core; `clear` takes node `i`'s
 * garrison out of the raid.
 */
window.ringfallWar = {
  land: (boat: boolean) => landNow(state, boat),
  march: (side: 0 | 1 | 2, kinds: string[], from: number, to: number, d: number) => {
    const k = marchSquad(state, side, kinds as EnemyKind[], from, to, d);
    const lead = [...state.enemies, ...state.friends].find((e) => e.squad === k);
    return lead ? { x: lead.pos.x, z: lead.pos.z, squad: k } : null;
  },
  depart: () => departNow(state),
  place: (side: 0 | 1 | 2, kinds: string[], x: number, z: number, attack = false) => placeBattleSquad(state, side, kinds as EnemyKind[], x, z, attack ? "attack" : "hold"),
  point: (i: number) => nodePoint(i),
  core: (i: number) => useCore(state, i),
  clear: (i: number) => {
    state.enemies = state.enemies.filter((e) => e.battle !== undefined || !garrisonOf(state, i, e.squad));
  },
  // The player takes node `i` now; with `soon`, the enemy's counter-attack on it sets off at once.
  take: (i: number, soon = false) => {
    takeNode(state, i);
    if (soon && state.battle) for (const c of state.battle.counters) c.at = Math.min(c.at, state.battle.now);
  },
};

/**
 * Automation only: a row of grunts and a heavy set down across (x, z), unaware and facing
 * `face`, wearing plates of tiers 0 to 3 from west to east, for a screenshot of the plates'
 * colours. Returns each one's id and where it stands.
 */
window.ringfallPlates = (x, z, face = 0) => {
  const s = state;
  const index = s.squads.length;
  s.squads.push({ name: "装甲", poi: -1, patrol: [], leg: 0, engaged: false, roam: false, sinceSeen: 0, last: { x: 0, z: 0 } });
  return (["grunt", "grunt", "grunt", "heavy"] as const).map((kind, k) => {
    const e = spawnEnemy(s, kind, x + (k - 1.5) * 3.2, z, -1, index, { face, plate: k as 0 | 1 | 2 | 3 });
    return { id: e.id, x: e.pos.x, y: e.pos.y, z: e.pos.z };
  });
};

/** Automation only: takes the robots `ringfallPlates()` set down out of the raid, and the player back to full health, as before them. */
window.ringfallClearPlates = () => {
  const squads = new Set(state.squads.map((q, i) => (q.name === "装甲" ? i : -1)).filter((i) => i >= 0));
  state.enemies = state.enemies.filter((e) => !squads.has(e.squad));
  state.player.hp = PLAYER.hp;
  state.player.shield = PLAYER.shieldByTier[state.player.armor];
};

/**
 * Automation only: one PIKE round of `rarity` from the player's eyes into the body of robot `id`,
 * its events handled as a step's are (sparks, sound, the HUD's number). The robot's plate and
 * health and shield after it, or null with no such robot.
 */
window.ringfallShoot = (id, rarity) => {
  const e = state.enemies.find((o) => o.id === id);
  if (!e) return null;
  const eye = eyePos(state);
  const c = bodyCenter(e);
  const d = Math.hypot(c.x - eye.x, c.y - eye.y, c.z - eye.z) || 1;
  state.events = [];
  fireRay(state, { kind: "pike", rarity: rarity as 0 | 1 | 2 | 3, mag: 1 }, { x: (c.x - eye.x) / d, y: (c.y - eye.y) / d, z: (c.z - eye.z) / d });
  world.handle(state, state.events);
  for (const ev of state.events) onEvent(ev, state);
  return { plate: e.plate, left: Math.round(e.hp + e.shield) };
};

window.ringfallBot = (skill: string) => {
  bot = new Bot(SKILLS.find((k) => k.name === skill) ?? SKILLS[1], 31);
};

/**
 * Automation only: the contract board. `take` takes the day's first contract of `type` in the
 * camp (its id, or null with none); `destroyTarget` destroys every robot of the taken intercept
 * contract's squad in the raid under way, as the player's shots would (the robots destroyed).
 */
window.ringfallContract = {
  take: (type) => {
    const c = hub.profile.board.contracts.find((o) => o.t === type);
    if (!camping || !c) return null;
    hub.profile = { ...hub.profile, taken: c.id };
    saveProfile(hub.profile);
    if (hub.station) hub.render();
    return c.id;
  },
  destroyTarget: () => {
    const c = hub.contract();
    if (!running || c?.t !== "intercept") return 0;
    const key = targetKey(c.target);
    const foes = state.enemies.filter((e) => state.squads[e.squad] && squadKey(state.squads[e.squad]) === key);
    for (const e of foes) kill(state, e, false);
    return foes.length;
  },
};

/**
 * Automation only: mod parts. `wear` puts these kinds on the player in the raid under way (up to
 * the slots); `drop` lays a part of `kind` on the ground `ahead` metres in front of the player.
 */
window.ringfallMods = {
  wear: (kinds) => {
    if (!running) return;
    state.player.mods = kinds.filter((k): k is ModKind => k in MODS).slice(0, MOD.slots);
  },
  drop: (kind, ahead) => {
    if (!running || !(kind in MODS)) return;
    const p = state.player;
    const x = p.pos.x + Math.sin(p.yaw) * ahead;
    const z = p.pos.z - Math.cos(p.yaw) * ahead;
    state.loot.push({ id: -9_000_000 - state.loot.length, kind: "mod", mod: kind as ModKind, rarity: 2, pos: { x, y: groundAt(x, z, 0.2, p.pos.y + 1), z }, vel: { x: 0, y: 0, z: 0 }, age: 1 });
  },
};

/**
 * Automation only: ends the raid under way at once, for screenshots of the results. The bag is
 * filled with `haul` first and `found` added to the ways in walked to; `how` is a wipe ("dead")
 * or getting off alive at the village ("extracted").
 */
/** Automation only: fills the bag with `haul` in the raid under way, for screenshots of the bag's slots. */
window.ringfallBag = (haul) => {
  if (!running) return;
  const p = state.player;
  p.haul = haul.filter((k): k is keyof typeof VALUABLES => k in VALUABLES);
  p.haulAt = p.haul.map(() => -1);
};
window.ringfallEnd = (how, haul = [], found = []) => {
  if (!running || state.phase === "done") return false;
  const p = state.player;
  p.haul = haul.filter((k): k is keyof typeof VALUABLES => k in VALUABLES);
  p.haulAt = p.haul.map(() => -1);
  for (const id of found) if (!state.found.includes(id as never)) state.found.push(id as never);
  state.phase = "done";
  state.outcome = how === "dead" ? "dead" : "extracted";
  if (how !== "dead") state.extractedAt = "village";
  onEvent({ t: "done" }, state);
  return true;
};

/**
 * Automation only: the camp. `walkTo` stands the player within reach of a station or the truck,
 * facing it, on the side toward the yard's middle (false out of the camp); `toGate` stands them
 * just inside the gate facing out; `use` presses the use key where they stand; `open` and `close`
 * open and close a station's panel.
 */
window.ringfallCamp = {
  spots: () => CAMP.spots,
  walkTo: (id) => {
    const c = CAMP.spots.find((q) => q.id === id);
    if (!camping || !c) return false;
    const mx = (CAMP.x0 + CAMP.x1) / 2;
    const mz = (CAMP.z0 + CAMP.z1) / 2;
    const toward = Math.atan2(mx - c.x, mz - c.z);
    const p = state.player;
    for (let k = 0; k < 24; k++) {
      const a = toward + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * (Math.PI / 12);
      for (const d of [c.reach - 0.3, c.reach - 0.7, c.reach - 1.2]) {
        const x = c.x + Math.sin(a) * d;
        const z = c.z + Math.cos(a) * d;
        const y = groundAt(x, z, 0.4, CAMP.y + 0.5);
        if (Math.abs(y - CAMP.y) > 0.3 || collide({ x, y, z }, 0.45)) continue;
        p.pos = { x, y, z };
        p.vel = { x: 0, y: 0, z: 0 };
        p.yaw = Math.atan2(c.x - x, -(c.z - z));
        // Looking at the station's middle, a metre over the floor.
        p.pitch = Math.atan2(1 - PLAYER.eye, d);
        p.onGround = true;
        placeAlly(state);
        return true;
      }
    }
    return false;
  },
  toGate: () => {
    if (!camping) return;
    const p = state.player;
    const x = (CAMP.gate.x0 + CAMP.gate.x1) / 2;
    const z = CAMP.gate.z + 3;
    p.pos = { x, y: groundAt(x, z, 0.4, CAMP.y + 0.5), z };
    p.vel = { x: 0, y: 0, z: 0 };
    p.yaw = 0;
    p.pitch = 0;
    p.onGround = true;
    placeAlly(state);
  },
  use: () => camping && !campFrozen() && useInCamp(),
  open: (id) => camping && openPanel(id),
  close: () => hub.close(),
};
