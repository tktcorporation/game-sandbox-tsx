import { AWARE, TICK } from "./sim/config";
import { Bot, SKILLS } from "./sim/bot";
import { dist2d } from "./sim/geom";
import { idleInput, newRun, type GameEvent, type Input, type State } from "./sim/state";
import { step } from "./sim/step";
import { setWind, sfx, unlock } from "./view/audio";
import { Hud } from "./view/hud";
import { World } from "./view/world";
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
const world = new World(stage, { lowPower: touchMode });
const hud = new Hud();

let state: State = newRun(Date.now() & 0xffff);
let running = false;
let paused = false;
let manual = false; // automation drives time through advanceTime()
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

function enableTouch() {
  touchMode = true;
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
  pause: () => setPaused(true),
});

addEventListener("keydown", (e) => {
  if (e.repeat) return;
  keys.add(e.code);
  edges.add(e.code);
  if (["Space", "KeyC", "ControlLeft", "Tab"].includes(e.code)) e.preventDefault();
});
addEventListener("keyup", (e) => keys.delete(e.code));
addEventListener("mousemove", (e) => {
  if (document.pointerLockElement !== stage) return;
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
  const k = 0.0022 * sens;
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
  inp.battery = edges.has("KeyH");
  inp.swap = edges.has("Wheel");
  inp.slot = edges.has("Digit1") ? 0 : edges.has("Digit2") ? 1 : -1;
  edges.clear();
  return inp;
}

// --- sound and feel for each event
function onEvent(e: GameEvent, s: State) {
  hud.event(e, s);
  const p = s.player;
  switch (e.t) {
    case "shot":
      sfx.shot(e.weapon, p.ultTime > 0);
      break;
    case "hit":
      sfx.hit(e.crit, e.shield, e.flank === "back" || e.flank === "ambush");
      break;
    case "shieldBreak":
      sfx.shieldBreak(e.tier);
      break;
    case "kill":
      sfx.kill(e.crit);
      break;
    case "hurt":
      if (e.shieldBroke) sfx.myShieldBreak();
      else sfx.hurt(e.shield);
      break;
    case "dry":
      sfx.dry();
      break;
    case "reload":
      sfx.reload(e.time);
      break;
    case "reloaded":
      sfx.reloaded();
      break;
    case "slide":
      sfx.slide();
      break;
    case "jump":
      sfx.jump();
      break;
    case "land":
      sfx.land(e.speed);
      break;
    case "pickup":
      if (e.kind === "shard") sfx.shard();
      else sfx.pickup(e.rarity);
      break;
    case "binOpen":
      sfx.bin();
      break;
    case "tactical":
      sfx.tactical();
      break;
    case "tacticalMiss":
      sfx.tacticalMiss();
      break;
    case "ultReady":
      sfx.ultReady();
      break;
    case "ultStart":
      sfx.ultStart();
      break;
    case "ultEnd":
      sfx.ultEnd();
      break;
    case "batteryStart":
      sfx.battery();
      break;
    case "batteryDone":
      sfx.batteryDone();
      break;
    case "telegraph": {
      const en = s.enemies.find((x) => x.id === e.id);
      if (en && dist2d(en.pos, p.pos) < 45) sfx.telegraph(en.kind === "titan" || en.kind === "heavy");
      break;
    }
    case "stompTelegraph":
      sfx.telegraph(true);
      break;
    case "enemyFire":
      sfx.enemyFire(Math.hypot(e.pos.x - p.pos.x, e.pos.z - p.pos.z));
      break;
    case "lunge":
      sfx.lunge();
      break;
    case "spawn":
      sfx.spawn();
      break;
    case "stomp":
      sfx.stomp();
      break;
    case "suspect":
      sfx.suspect();
      break;
    case "engage":
      sfx.engage();
      break;
    case "poiStart":
    case "poiClear":
    case "landed":
      sfx.banner();
      break;
    case "ringClose":
      if (e.poi > 0) sfx.ringWarn();
      break;
    case "ringHurt":
      sfx.ringHurt();
      break;
    case "careDrop":
      sfx.careDrop();
      break;
    case "careLand":
      sfx.careLand();
      break;
    case "down":
      sfx.down();
      break;
    case "revive":
      sfx.revive();
      break;
    case "extractReady":
      sfx.victory();
      break;
    case "done":
      sfx.victory();
      setTimeout(finish, 1400);
      break;
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

function size() {
  const w = innerWidth;
  const h = innerHeight;
  world.resize(w, h);
  return { w, h };
}
let dims = size();
addEventListener("resize", () => (dims = size()));

let last = performance.now();
function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
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
  setWind(running && state.phase === "drop" ? 1 : 0);
  world.render(state, dt);
  if (running) hud.frame(state, world, dt, dims.w, dims.h);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// --- screens
function lock() {
  if (bot || manual || touchMode) return;
  try {
    const r = stage.requestPointerLock() as unknown as Promise<void> | undefined;
    r?.catch?.(() => undefined);
  } catch {
    /* pointer lock unavailable: the game still runs */
  }
}

function start() {
  unlock();
  if (touchMode) {
    // Full screen and landscape where the browser allows it; the game runs either way.
    document.documentElement.requestFullscreen?.().catch(() => undefined);
    (screen.orientation as unknown as { lock?: (o: string) => Promise<void> }).lock?.("landscape").catch(() => undefined);
  }
  document.body.classList.add("playing");
  world.reset();
  state = newRun(Date.now() & 0xffff);
  acc = hitstop = slowmo = 0;
  running = true;
  paused = false;
  $("title").hidden = true;
  $("results").hidden = true;
  $("pause").hidden = true;
  hud.show(true);
  hud.banner("降下", `${touchMode ? "スティック" : "WASD"}で着地点を選ぶ。黄色の目印が最初の拠点`);
  lock();
}

function finish() {
  running = false;
  document.body.classList.remove("playing");
  fire = ads = false;
  $("banner").className = "";
  hud.show(false);
  hud.results(state);
  $("results").hidden = false;
  if (document.pointerLockElement) document.exitPointerLock();
}

function setPaused(on: boolean) {
  if (!running || bot || manual) return;
  paused = on;
  $("pause").hidden = !on;
  if (on) fire = ads = false;
}

document.addEventListener("pointerlockchange", () => {
  if (document.pointerLockElement !== stage && running && state.phase !== "done") setPaused(true);
});
document.addEventListener("visibilitychange", () => document.hidden && setPaused(true));
$("start").addEventListener("click", start);
$("restart").addEventListener("click", start);
$("resume").addEventListener("click", () => {
  unlock();
  setPaused(false);
  lock();
});
stage.addEventListener("click", () => !touchMode && running && !paused && document.pointerLockElement !== stage && lock());
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
    ringfallBot: (skill: string) => void;
    ringfallYaw: () => number;
    ringfallCamera: (x?: number, y?: number, z?: number, yaw?: number, pitch?: number) => void;
  }
}

window.render_game_to_text = () => {
  const s = state;
  const p = s.player;
  return JSON.stringify({
    screen: running ? "game" : $("results").hidden ? "title" : "results",
    phase: s.phase,
    time: +s.time.toFixed(1),
    poi: s.poi,
    poiActive: s.poiActive,
    player: { x: +p.pos.x.toFixed(1), y: +p.pos.y.toFixed(1), z: +p.pos.z.toFixed(1), hp: Math.round(p.hp), shield: Math.round(p.shield), armor: p.armor, downed: p.downed > 0, weapons: p.weapons.map((w) => w && `${w.kind}${w.rarity}:${w.mag}`), ult: +p.ult.toFixed(2), ultTime: +p.ultTime.toFixed(1), reveal: +p.reveal.toFixed(1), crouch: p.crouch },
    enemies: s.enemies.map((e) => ({ kind: e.kind, x: Math.round(e.pos.x), z: Math.round(e.pos.z), y: +e.pos.y.toFixed(1), hp: Math.round(e.hp + e.shield), mode: e.mode, aware: e.aware, detect: +e.detect.toFixed(2), squad: e.squad })),
    squads: s.squads.map((q) => ({ name: q.name, poi: q.poi, engaged: q.engaged, lost: q.engaged && q.sinceSeen >= AWARE.trackTime })),
    orbs: s.orbs.length,
    waves: s.waves.length,
    loot: s.loot.length,
    care: s.care ? { landed: s.care.landed, open: s.care.open } : null,
    stats: { ...s.stats, damage: Math.round(s.stats.damage), shots: Math.round(s.stats.shots) },
  });
};

window.advanceTime = (ms: number) => {
  manual = true;
  const n = Math.round(ms / 1000 / TICK);
  for (let i = 0; i < n && running; i++) tick();
  world.render(state, ms / 1000);
  if (running) hud.frame(state, world, ms / 1000, dims.w, dims.h);
};

/** Look from a fixed point without touching the run (for screenshots of the island). No arguments: back to the player. */
window.ringfallCamera = (x, y, z, yaw, pitch) => {
  world.cameraOverride = x === undefined ? null : { x, y: y ?? 2, z: z ?? 0, yaw: yaw ?? 0, pitch: pitch ?? 0 };
  world.render(state, 0.016);
};

/** The player's exact view yaw (render_game_to_text rounds it away). */
window.ringfallYaw = () => state.player.yaw;

window.ringfallBot = (skill: string) => {
  bot = new Bot(SKILLS.find((k) => k.name === skill) ?? SKILLS[1], 31);
};
