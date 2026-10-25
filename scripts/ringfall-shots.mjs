/**
 * Gate 3 for RINGFALL: the build, played to the end in a real browser.
 * Serves dist/client, checks that real keyboard input moves the player, then lets
 * the built-in bot (window.ringfallBot) play with deterministic time
 * (window.advanceTime). Fails on any console or page error, or if the run stops
 * progressing. Screenshots of each key moment go to shots/ringfall/ for review.
 *
 *   npm run shots:ringfall -- [skill]
 */
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { chromium } from "playwright-core";
import { movementShots } from "./ringfall-shots-movement.mjs";
import { bagShots } from "./ringfall-shots-bag.mjs";
import { upgradeShots } from "./ringfall-shots-upgrades.mjs";

const root = "dist/client";
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
const server = createServer(async (req, res) => {
  let path = join(root, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (path.endsWith("/")) path += "index.html";
  let body;
  try {
    body = await readFile(path);
  } catch {
    return res.writeHead(404).end();
  }
  res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" }).end(body);
}).listen(0);
const port = server.address().port;
const out = "shots/ringfall";
/** Where the game keeps its profile (src/ringfall/meta/storage.ts). */
const KEY = "ringfall.profile.v1";
/** A save from before ways in were learned: it loads knowing every way in, so a start in the harbor can be chosen. */
const KNOWS_ALL = JSON.stringify({ v: 10, cash: 1500, stash: [], raids: 0, extracted: 0, region: "reservoir" });
await mkdir(out, { recursive: true });

const skill = process.argv[2] ?? "casual";
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const errors = [];

/*
 * Drawing a frame in software is most of what a step costs, so stretches that only wait on the
 * state step without drawing (window.ringfallStep). The scene is drawn before every screenshot
 * and frame-cost report, at the end of every such stretch, and every DRAW_EVERY steps within one,
 * so an error that drawing raises still shows up in the console while what it drew is on screen.
 */
const DRAW_EVERY = 10;
/** One undrawn step and the state after it, in one round trip. */
const quietStep = async (pg, ms) =>
  JSON.parse(await pg.evaluate((t) => (window.ringfallStep(t), window.render_game_to_text()), ms));
const draw = (pg) => pg.evaluate(() => window.ringfallDraw());
/** Undrawn steps while `going(state)` holds, at most `max`; draws as above. The state at the end. */
const stepWhile = async (pg, ms, max, going) => {
  let st = JSON.parse(await pg.evaluate(() => window.render_game_to_text()));
  for (let i = 0; i < max && going(st); i++) {
    st = await quietStep(pg, ms);
    if ((i + 1) % DRAW_EVERY === 0) await draw(pg);
  }
  await draw(pg);
  return st;
};
let lapAt = Date.now();
/** Wall time per section, to see where the gate's time goes. */
const lap = (name) => {
  const now = Date.now();
  console.log(`time: ${name} ${((now - lapAt) / 1000).toFixed(1)} s`);
  lapAt = now;
};

/*
 * The camp between raids (src/ringfall/sim/camp.ts): the title's start wakes the player in it,
 * a station's panel opens by the use key (or the use button) standing at it, and the gate and the
 * truck both open the departure, whose map chooses the start: the gate's own way in walks out onto
 * the south beach, any other start comes after a fade.
 */
const readPage = async (pg) => JSON.parse(await pg.evaluate(() => window.render_game_to_text()));
/** Until the fade to and from the camp's dark (under a second) has cleared the screen. */
const faded = async (pg) => {
  await pg.waitForFunction(() => getComputedStyle(document.getElementById("fade")).opacity === "0", null, { timeout: 8000 }).catch(() => errors.push("camp: the fade never cleared the screen"));
  await pg.waitForTimeout(100);
};
/** The camp after the title's start: waking fades in from dark, so the screen is let clear first. */
const toCamp = async (pg, touch = false) => {
  await (touch ? pg.tap("#start") : pg.click("#start"));
  await faded(pg);
};
/** Stands at a station (or the truck) and presses the use key, or taps the use button with `cdp`; the camp's state after. */
const useStation = async (pg, id, cdp) => {
  if (!(await pg.evaluate((i) => window.ringfallCamp.walkTo(i), id))) errors.push(`camp: could not stand at ${id}`);
  await pg.evaluate(() => window.advanceTime(100));
  if (cdp) {
    const bb = await pg.locator("#t-use").boundingBox();
    if (!bb) errors.push(`camp: no use button at ${id}`);
    else {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: bb.x + bb.width / 2, y: bb.y + bb.height / 2, id: 41 }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    }
  } else await pg.keyboard.press("KeyE");
  await pg.evaluate(() => window.advanceTime(50));
  await pg.waitForTimeout(100);
  const st = await readPage(pg);
  if (id !== "vehicle" && st.camp?.panel !== id) errors.push(`camp: the use key at ${id} opened ${st.camp?.panel}`);
  return st;
};
/** Closes the station's panel open now by its close button. */
const closePanel = async (pg, touch = false) => {
  await (touch ? pg.tap("#hub-close") : pg.click("#hub-close"));
  if ((await readPage(pg)).camp?.panel) errors.push("camp: the close button left the panel open");
};
/** Until the departure is up with its map drawn and its starts set on it. */
/**
 * The pause screen as Esc shows it (automation never pauses, so it is shown by hand over the frame),
 * checked to fit the window unscrolled with the controls listed `rows` (0: none, as on a phone).
 */
const pauseShot = async (pg, name, rows, tag) => {
  await pg.evaluate(() => (document.getElementById("pause").hidden = false));
  await pg.screenshot({ path: `${out}/${name}.png` });
  const fit = await pg.evaluate(() => {
    const box = document.querySelector("#pause .title-inner").getBoundingClientRect();
    const shown = [...document.querySelectorAll("#pause-keys li")].filter((li) => li.getClientRects().length > 0);
    const over = shown.some((a, i) => shown.slice(i + 1).some((b) => {
      const p = a.getBoundingClientRect(), q = b.getBoundingClientRect();
      return p.left < q.right && q.left < p.right && p.top < q.bottom && q.top < p.bottom;
    }));
    return { top: box.top, bottom: box.bottom, left: box.left, right: box.right, w: innerWidth, h: innerHeight, rows: shown.length, over };
  });
  await pg.evaluate(() => (document.getElementById("pause").hidden = true));
  if (fit.top < 0 || fit.bottom > fit.h || fit.left < 0 || fit.right > fit.w) errors.push(`${tag}: the pause screen does not fit the window (${JSON.stringify(fit)})`);
  if (fit.rows !== rows) errors.push(`${tag}: the pause screen lists ${fit.rows} controls, not ${rows}`);
  if (fit.over) errors.push(`${tag}: the pause screen's controls overlap`);
};
const departUp = (pg) =>
  pg.waitForFunction(() => !document.getElementById("depart").hidden && document.querySelectorAll("#depart-points button.pick").length > 0, null, { timeout: 4000 }).catch(() => errors.push("depart: the map of starts never came up"));
/** Chooses a start on the departure's map (`kind` "entry" or "depot"), by a click or a tap with `touch`; the departure's state after. */
const pickStart = async (pg, kind, id, touch = false) => {
  const sel = `#depart-points button.pick[data-kind=${kind}][data-id=${id}]`;
  await (touch ? pg.tap(sel) : pg.click(sel));
  await pg.waitForTimeout(80);
  const d = (await readPage(pg)).camp?.depart;
  if (d?.start?.kind !== kind || d?.start?.id !== id) errors.push(`depart: choosing ${kind} ${id} left the start at ${JSON.stringify(d?.start)}`);
  return d;
};
/** Whether the departure fits the screen: its panel and every start on the map inside the window, none clipped. */
const departFits = (pg) =>
  pg.evaluate(() => {
    const bad = [];
    const r = document.querySelector("#depart .depart-inner").getBoundingClientRect();
    if (r.bottom > innerHeight + 1 || r.right > innerWidth + 1 || r.left < -1 || r.top < -1) bad.push("the departure spills past the screen");
    for (const b of document.querySelectorAll("#depart-points button.pick")) {
      const q = b.getBoundingClientRect();
      if (q.left < r.left - 1 || q.right > r.right + 1 || q.top < r.top - 1 || q.bottom > r.bottom + 1) bad.push(`start ${b.dataset.id} clipped`);
    }
    const go = document.getElementById("depart-go").getBoundingClientRect();
    if (go.bottom > innerHeight + 1 || go.right > innerWidth + 1) bad.push("the confirm is off the screen");
    return bad;
  });
/**
 * The departure, once it is up: it lists the kit and the objective; `pick` ([kind, id]) chooses
 * the start on its map first; `shot` saves it; the confirm (Enter, or a tap with `touch`) starts the raid.
 */
const confirmDepart = async (pg, { touch = false, shot = "", pick = null } = {}) => {
  await departUp(pg);
  if (pick) await pickStart(pg, pick[0], pick[1], touch);
  const st = await readPage(pg);
  const text = await pg.textContent("#depart");
  if (!st.camp?.depart || !/武器/.test(text) || !/回復/.test(text) || !/目的/.test(text)) errors.push(`depart: the check reads ${JSON.stringify(st.camp?.depart)} "${text}"`);
  if (shot) await pg.screenshot({ path: `${out}/${shot}.png` });
  await (touch ? pg.tap("#depart-go") : pg.keyboard.press("Enter"));
  return st.camp?.depart;
};
/** Out of the camp's gate on foot, W held: the departure's check comes up at the gate, and the raid starts once it is confirmed. The state once out. */
const walkOutOfGate = async (pg, shot = "") => {
  await pg.evaluate(() => window.ringfallCamp.toGate());
  await pg.keyboard.down("KeyW");
  let st = await readPage(pg);
  for (let i = 0; i < 30 && st.screen !== "game" && !st.camp?.depart; i++) st = JSON.parse(await pg.evaluate(() => (window.advanceTime(200), window.render_game_to_text())));
  await pg.keyboard.up("KeyW");
  if (st.camp?.depart) {
    await confirmDepart(pg, { shot });
    st = await readPage(pg);
  }
  if (st.screen !== "game") errors.push(`camp: walking out of the gate left the screen at ${st.screen} (${st.player.x},${st.player.z})`);
  return st;
};
/** By the truck from its use key, or its use button with `cdp`: the departure (choosing `pick` on its map), a fade, then the raid. The state once it is under way. */
const rideOut = async (pg, cdp, shot = "", pick = null) => {
  await useStation(pg, "vehicle", cdp);
  await confirmDepart(pg, { touch: !!cdp, shot, pick });
  await pg.waitForFunction(() => JSON.parse(window.render_game_to_text()).screen === "game", null, { timeout: 5000 }).catch(() => undefined);
  await faded(pg);
  const st = await readPage(pg);
  if (st.screen !== "game") errors.push(`camp: the truck did not start a raid (${st.screen})`);
  return st;
};
/** Camp panel parts that spill past the screen, or lists that scroll sideways. */
/**
 * The objective step's beacon (sim/objective.ts) from far off: a fixed camera 170 m short of the
 * step's place on the player's side, 30 m over the ground, facing it; then back to the player.
 * False when the step has no place.
 */
const beaconShot = async (pg, name) => {
  const s = JSON.parse(await pg.evaluate(() => window.render_game_to_text()));
  const at = s.objective?.steps[s.objective.current]?.at;
  if (!at) return false;
  const d = Math.hypot(s.player.x - at.x, s.player.z - at.z) || 1;
  const x = at.x + ((s.player.x - at.x) / d) * 170;
  const z = at.z + ((s.player.z - at.z) / d) * 170;
  const y = (await pg.evaluate(([qx, qz]) => window.ringfallTerrain(qx, qz), [x, z])) + 30;
  await pg.evaluate(([cx, cy, cz, yaw, pitch]) => window.ringfallCamera(cx, cy, cz, yaw, pitch), [x, y, z, Math.atan2(at.x - x, -(at.z - z)), -0.12]);
  await pg.screenshot({ path: `${out}/${name}.png` });
  await pg.evaluate(() => window.ringfallCamera());
  return true;
};

const spills = (pg) =>
  pg.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll("#hub .hub-inner, #hub .hub-head, #hub-side, #hub-stash, #hub-region, #hub .hub-foot")) {
      const r = el.getBoundingClientRect();
      if (r.width && (r.right > innerWidth + 1 || r.bottom > innerHeight + 1)) out.push(`${el.id || el.className} ends at ${Math.round(r.right)}x${Math.round(r.bottom)}`);
      if (el.scrollWidth > el.clientWidth + 1) out.push(`${el.id || el.className} scrolls sideways`);
    }
    return out;
  });

/*
 * Phone in landscape: real touch events (through the DevTools protocol) open a camp station's
 * panel by the use button and walk out of the gate on the stick, then move the player with the
 * stick, turn the view, and fire. Then the bot plays to the first fight so the touch layout is
 * captured with enemies on screen.
 */
{
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`mobile pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !/fonts\.g|ERR_TUNNEL|net::/.test(m.text()) && errors.push(`mobile console: ${m.text()}`));
  await page.goto(`http://localhost:${port}/ringfall/`, { waitUntil: "load" });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/m0-title.png` });
  // Turning the phone: the picture is drawn at the new shape, not the old one stretched.
  // (Checked before starting: once the game asks for full screen, the window no longer follows the viewport here.)
  await page.setViewportSize({ width: 740, height: 360 });
  // The resize is reported on a later frame; give it up to 3 s on a slow software renderer.
  await page
    .waitForFunction(() => {
      const c = document.querySelector("#stage canvas");
      return Math.abs(c.width / c.height - 740 / 360) < 0.02;
    }, null, { timeout: 3000 })
    .catch(() => undefined);
  const shape = await page.evaluate(() => {
    const c = document.querySelector("#stage canvas");
    return { w: c.width, h: c.height };
  });
  if (Math.abs(shape.w / shape.h - 740 / 360) > 0.02) errors.push(`mobile: after a resize the canvas is ${shape.w}x${shape.h}, not 740:360`);
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(300);
  // Some phone browsers and web views have no Screen Orientation API; starting must not depend on it.
  await page.evaluate(() => Object.defineProperty(screen, "orientation", { value: undefined, configurable: true }));
  await toCamp(page, true);
  await page.screenshot({ path: `${out}/m0-camp.png` });
  if (!(await page.evaluate(() => document.body.classList.contains("touch")))) errors.push("mobile: touch mode did not turn on");
  if ((await readPage(page)).screen !== "camp") errors.push("mobile: the start button did not wake the player in the camp");
  const cdp = await ctx.newCDPSession(page);
  const touch = (type, points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points });
  const read = async () => JSON.parse(await page.evaluate(() => window.render_game_to_text()));
  const step = (ms) => page.evaluate((t) => window.advanceTime(t), ms);
  // The shelves' panel by the use button: it fits the phone's screen, and its close button closes it.
  await page.evaluate(() => window.ringfallCamp.walkTo("stash"));
  await step(100);
  await page.screenshot({ path: `${out}/m0-camp-stash.png` });
  await useStation(page, "stash", cdp);
  const panelFit = await spills(page);
  if (panelFit.length) errors.push(`mobile: the shelves' panel ${panelFit.join(", ")} (844x390)`);
  await page.screenshot({ path: `${out}/m0-panel-stash.png` });
  await closePanel(page, true);
  // The board by the use button: it fits the screen, and a tap takes the day's fetch.
  await useStation(page, "quests", cdp);
  const boardFit = await spills(page);
  if (boardFit.length) errors.push(`mobile: the board's panel ${boardFit.join(", ")} (844x390)`);
  await page.screenshot({ path: `${out}/m0-panel-quests.png` });
  await page.tap("#hub-side .quest.contract[data-type=fetch] [data-act=take]");
  const mt = (await read()).camp;
  if (mt.board.find((c) => c.id === mt.taken)?.t !== "fetch") errors.push("mobile: tapping the fetch did not take it");
  await page.locator("#hub-side .quest.contract.taken").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${out}/m0-panel-quests-taken.png` });
  await closePanel(page, true);
  // Out of the gate on the stick: the raid starts where the player walks out.
  await page.evaluate(() => window.ringfallCamp.toGate());
  await step(100);
  await page.screenshot({ path: `${out}/m0-camp-gate.png` });
  await touch("touchStart", [{ x: 150, y: 260, id: 1 }]);
  await touch("touchMove", [{ x: 150, y: 200, id: 1 }]);
  for (let i = 0; i < 20 && (await read()).screen !== "game" && !(await read()).camp?.depart; i++) await step(200);
  await touch("touchEnd", []);
  // The departure's check at the gate: cancelled once (back inside, turned round), then confirmed.
  if ((await read()).camp?.depart) {
    const fit = await page.evaluate(() => {
      const r = document.querySelector("#depart .depart-inner").getBoundingClientRect();
      return r.bottom <= innerHeight + 1 && r.right <= innerWidth + 1;
    });
    if (!fit) errors.push("mobile: the departure's check spills past the screen");
    await page.screenshot({ path: `${out}/m0-depart.png` });
    await page.tap("#depart-cancel");
    const back = await read();
    if (back.camp?.depart || back.screen !== "camp") errors.push(`mobile: cancelling the departure left ${back.screen} ${JSON.stringify(back.camp?.depart)}`);
    await touch("touchStart", [{ x: 150, y: 260, id: 1 }]);
    await touch("touchMove", [{ x: 150, y: 140, id: 1 }]);
    await step(400);
    await touch("touchEnd", []);
    await page.evaluate(() => window.ringfallCamp.toGate());
    await touch("touchStart", [{ x: 150, y: 260, id: 1 }]);
    await touch("touchMove", [{ x: 150, y: 200, id: 1 }]);
    for (let i = 0; i < 20 && !(await read()).camp?.depart && (await read()).screen !== "game"; i++) await step(200);
    await touch("touchEnd", []);
    await confirmDepart(page, { touch: true });
    await step(50);
  }
  if ((await read()).screen !== "game") errors.push("mobile: walking out of the gate on the stick did not start the raid");
  if (!(await page.evaluate(() => document.body.classList.contains("playing")))) errors.push("mobile: the raid is not playing");

  // Stick: press on the left, push up -> forward.
  const s0 = await read();
  await touch("touchStart", [{ x: 150, y: 260, id: 1 }]);
  await touch("touchMove", [{ x: 150, y: 200, id: 1 }]);
  await step(600);
  await page.screenshot({ path: `${out}/m1-stick.png` });
  await pauseShot(page, "m1-pause", 0, "mobile");
  // The objective card shows the fetch taken as its steps: the title, the step and what finishes it.
  if (!(await page.evaluate(() => /回収/.test(document.getElementById("obj-title").textContent) && document.getElementById("obj-text").textContent.length > 0))) errors.push("mobile: the objective card does not show the fetch taken");
  await page.screenshot({ path: `${out}/m1-objective.png`, clip: { x: 0, y: 0, width: 844, height: 110 } });
  if (!(await page.evaluate(() => !document.getElementById("compass-mark").hidden && /\d+m/.test(document.getElementById("compass-mark").textContent)))) errors.push("mobile: no compass marker for the objective's step");
  await touch("touchEnd", []);
  const s1 = await read();
  if (!(s1.player.z < s0.player.z - 3)) errors.push(`mobile: stick did not move the player (${s0.player.z} -> ${s1.player.z})`);
  // The objective step's beacon from far off.
  if (!(await beaconShot(page, "m1-beacon"))) errors.push(`mobile: the objective's step has no place (${JSON.stringify(s1.objective)})`);

  // Turn the view by dragging on the right half.
  const yaw0 = await page.evaluate(() => window.ringfallYaw());
  await touch("touchStart", [{ x: 560, y: 120, id: 2 }]);
  for (let k = 1; k <= 5; k++) await touch("touchMove", [{ x: 560 + k * 20, y: 120, id: 2 }]);
  await step(50);
  await touch("touchEnd", []);
  const yaw1 = await page.evaluate(() => window.ringfallYaw());
  if (!(yaw1 > yaw0 + 0.2)) errors.push(`mobile: dragging did not turn the view (${yaw0.toFixed(2)} -> ${yaw1.toFixed(2)})`);

  // Fire button: hold for half a second.
  const shots0 = (await read()).stats.shots;
  const fb = await page.locator("#t-fire").boundingBox();
  await touch("touchStart", [{ x: fb.x + fb.width / 2, y: fb.y + fb.height / 2, id: 3 }]);
  await step(500);
  await touch("touchEnd", []);
  const shots1 = (await read()).stats.shots;
  if (!(shots1 > shots0)) errors.push(`mobile: the fire button did not shoot (${shots0} -> ${shots1})`);

  // The weapon cards are tappable (they switch weapons): a tap on each card shown
  // lands on the card itself, not on the view-turning zone under it.
  for (const id of ["slot-0", "slot-1"]) {
    const hit = await page.evaluate((cardId) => {
      const r = document.getElementById(cardId).getBoundingClientRect();
      if (!r.width) return true; // an empty slot is not shown
      return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest(`#${cardId}`) !== null;
    }, id);
    if (!hit) errors.push(`mobile: a tap on the weapon card ${id} does not reach it`);
  }

  // The starting sniper: tap its card, aim, and the scope covers the view.
  const tap = async (sel, id) => {
    const bb = await page.locator(sel).boundingBox();
    await touch("touchStart", [{ x: bb.x + bb.width / 2, y: bb.y + bb.height / 2, id }]);
    await touch("touchEnd", []);
  };
  await tap("#slot-1", 4);
  await step(400);
  await tap("#t-ads", 5);
  await step(400);
  await page.screenshot({ path: `${out}/m3-scope.png` });
  if (!(await page.evaluate(() => document.getElementById("scope").classList.contains("on")))) errors.push("mobile: aiming the sniper did not show the scope");
  await tap("#t-ads", 6);
  await tap("#slot-0", 7);
  await step(300);

  // The map button opens the map, and the map's own close button (the map covers the
  // map button) closes it again, both by a tap.
  const mapOpen = () => page.evaluate(() => !document.getElementById("map").hidden);
  await tap("#t-map", 8);
  await step(200);
  if (!(await mapOpen())) errors.push("mobile: the map button did not open the map");
  await page.screenshot({ path: `${out}/m4-map.png` });
  // It opens on the region the player is in; its own button shows the whole world, and back.
  const mapAspect = () => page.evaluate(() => +getComputedStyle(document.getElementById("map-canvas")).getPropertyValue("--map-aspect"));
  const regionAspect = await mapAspect();
  await tap("#map-zoom", 12);
  await step(200);
  const worldAspect = await mapAspect();
  if (!(worldAspect < regionAspect * 0.8)) errors.push(`mobile: the map's zoom button did not show the whole world (shape ${regionAspect.toFixed(2)} -> ${worldAspect.toFixed(2)})`);
  await page.screenshot({ path: `${out}/m4-map-world.png` });
  await tap("#map-zoom", 13);
  await step(200);
  if ((await mapAspect()) !== regionAspect) errors.push("mobile: the map's zoom button did not go back to the region");
  await tap("#map-close", 9);
  await step(200);
  if (await mapOpen()) errors.push("mobile: the map's close button did not close it");
  // The pause button lives on the open map (automation never pauses, so only the tap closing the map shows here).
  await tap("#t-map", 10);
  await step(200);
  await tap("#map-pause", 11);
  await step(200);
  if (await mapOpen()) errors.push("mobile: the map's pause button did not take the map away");

  // The ult button leaps: up into the sky, then a glide down.
  const g0 = await read();
  await page.evaluate(() => window.ringfallChargeUlt());
  await tap("#t-ult", 12);
  await step(900);
  const g1 = await read();
  await page.screenshot({ path: `${out}/m5-leap.png` });
  if (!g1.player.leap || !(g1.player.y > g0.player.y + 10)) errors.push(`mobile: the ult button did not leap (${JSON.stringify(g1.player)})`);
  if ((await stepWhile(page, 250, 60, (st) => st.player.leap)).player.leap) errors.push("mobile: the leap never came down");

  // The page never zooms: browser gestures are off on the root (touch-action
  // narrows down the tree, so the HUD and menus are covered too), and iOS Safari's
  // pinch events, which ignore the viewport meta, are cancelled.
  const zoom = await page.evaluate(() => {
    const pinch = new Event("gesturestart", { bubbles: true, cancelable: true });
    document.getElementById("objective").dispatchEvent(pinch);
    return {
      meta: document.querySelector('meta[name="viewport"]').content,
      body: getComputedStyle(document.body).touchAction,
      pinchCancelled: pinch.defaultPrevented,
    };
  });
  if (!/user-scalable=no/.test(zoom.meta) || !/maximum-scale=1/.test(zoom.meta) || zoom.body !== "none" || !zoom.pinchCancelled)
    errors.push(`mobile: the page can still zoom (${JSON.stringify(zoom)})`);
  // Edge to edge on a phone: drawn under the notch and home bar (the HUD keeps clear by the
  // safe-area insets), and installable to the home screen as a landscape full-screen app.
  if (!/viewport-fit=cover/.test(zoom.meta)) errors.push("mobile: the viewport does not cover the whole screen");
  const manifest = await page.evaluate(async () => {
    const link = document.querySelector('link[rel="manifest"]');
    const r = link && (await fetch(link.href));
    return r?.ok ? r.json() : null;
  });
  if (manifest?.display !== "fullscreen" || manifest?.orientation !== "landscape") errors.push(`mobile: no landscape full-screen manifest (${JSON.stringify(manifest)})`);

  // The bot plays to the first fight for a screenshot of the touch layout.
  await page.evaluate((s) => window.ringfallBot(s), skill);
  for (let i = 0; i < 900; i++) {
    const st = await quietStep(page, 100);
    if (st.enemies.filter((e) => e.aware === "engaged" && e.mode !== "spawning").length >= 2 && st.orbs >= 1) break;
    if ((i + 1) % DRAW_EVERY === 0) await draw(page);
  }
  await draw(page);
  await page.screenshot({ path: `${out}/m2-fight.png` });
  console.log(`mobile: stick ${s0.player.z} -> ${s1.player.z}, yaw ${yaw0.toFixed(2)} -> ${yaw1.toFixed(2)}, shots ${shots0} -> ${shots1}`);
  console.log(`mobile reservoir frame: ${JSON.stringify(await page.evaluate(() => window.ringfallFrameCost(20)))}`);
  await ctx.close();
  lap("phone, reservoir");
}

/*
 * Phone again, starting in the harbor: the base's choice of region and way in works by touch,
 * the raid starts on the ground at that way in, and the map shows both regions.
 */
// A fresh profile on a phone on its side: the harbor is locked, its button showing its ways in still to find.
{
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`mobile fresh pageerror: ${e.message}`));
  await page.goto(`http://localhost:${port}/ringfall/`, { waitUntil: "load" });
  await page.waitForTimeout(400);
  await page.evaluate(() => Object.defineProperty(screen, "orientation", { value: undefined, configurable: true }));
  await toCamp(page, true);
  // The departure from the truck: the harbor carries a padlock, its three ways in dashed and shut.
  await useStation(page, "vehicle", await ctx.newCDPSession(page));
  await departUp(page);
  const locks = await page.locator("#depart-points .region-lock .ico.lock").count();
  const shut = await page.locator("#depart-points button.pick.entry.shut:disabled").count();
  const open = await page.locator("#depart-points button.pick:not(:disabled)").count();
  if (locks !== 1 || shut !== 5 || open !== 1) errors.push(`mobile: a fresh departure shows ${locks} padlocks, ${shut} ways in shut and ${open} to choose`);
  const fit = await departFits(page);
  if (fit.length) errors.push(`mobile departure (844x390): ${fit.join(", ")}`);
  await page.screenshot({ path: `${out}/m7-depart-locked.png` });
  await ctx.close();
}
{
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`mobile harbor pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !/fonts\.g|ERR_TUNNEL|net::/.test(m.text()) && errors.push(`mobile harbor console: ${m.text()}`));
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [KEY, KNOWS_ALL]);
  await page.goto(`http://localhost:${port}/ringfall/`, { waitUntil: "load" });
  await page.waitForTimeout(400);
  await page.evaluate(() => Object.defineProperty(screen, "orientation", { value: undefined, configurable: true }));
  await toCamp(page, true);
  const cdp = await ctx.newCDPSession(page);
  // The truck's prompt opens the departure; the quay is tapped on its map and the confirm rides there.
  await page.evaluate(() => window.ringfallCamp.walkTo("vehicle"));
  await page.evaluate(() => window.advanceTime(100));
  const truck = await page.textContent("#camp-prompt");
  if (!/出撃/.test(truck)) errors.push(`mobile harbor: the truck's prompt reads "${truck}"`);
  await page.screenshot({ path: `${out}/m6-camp-truck.png` });
  await useStation(page, "vehicle", cdp);
  await departUp(page);
  await pickStart(page, "entry", "quay", true);
  const fitH = await departFits(page);
  if (fitH.length) errors.push(`mobile departure (844x390): ${fitH.join(", ")}`);
  await page.screenshot({ path: `${out}/m6-depart-harbor.png` });
  await page.tap("#depart-go");
  await page.waitForFunction(() => JSON.parse(window.render_game_to_text()).screen === "game", null, { timeout: 5000 }).catch(() => undefined);
  await faded(page);
  const read = async () => JSON.parse(await page.evaluate(() => window.render_game_to_text()));
  const step = (ms) => page.evaluate((t) => window.advanceTime(t), ms);
  const st = await read();
  // The quay's way in lies at the harbor's north-east, past the town and the wreck.
  if (st.region !== "harbor" || st.phase !== "play" || !(st.player.z < -800 && st.player.x > 100)) errors.push(`mobile harbor: the raid started in ${st.region} at ${st.player.x},${st.player.z} (${st.phase})`);
  await step(300);
  await page.screenshot({ path: `${out}/m7-harbor-start.png` });
  const bb = await page.locator("#t-map").boundingBox();
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: bb.x + bb.width / 2, y: bb.y + bb.height / 2, id: 1 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await step(200);
  await page.screenshot({ path: `${out}/m8-map-harbor.png` });
  console.log(`mobile harbor frame: ${JSON.stringify(await page.evaluate(() => window.ringfallFrameCost(20)))}`);
  // The same view drawn at the cheaper tiers: what the governor falls back to on a phone that
  // cannot hold 60 fps. Logged only; software drawing's times say nothing absolute.
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: bb.x + bb.width / 2, y: bb.y + bb.height / 2, id: 1 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  for (const tier of ["high", "medium", "low"]) {
    await page.evaluate((t) => window.ringfallQuality(t), tier);
    await step(100);
    console.log(`mobile harbor frame (${tier}): ${JSON.stringify(await page.evaluate(() => window.ringfallFrameCost(20)))}`);
    await page.screenshot({ path: `${out}/m9-harbor-${tier}.png` });
  }
  await ctx.close();
  lap("phone, harbor");
}

// Without pointer lock (a sandboxed frame), the mouse still turns the view.
{
  const p2 = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  p2.on("pageerror", (e) => errors.push(`no-lock pageerror: ${e.message}`));
  await p2.addInitScript(() => {
    Element.prototype.requestPointerLock = undefined;
  });
  await p2.goto(`http://localhost:${port}/ringfall/`, { waitUntil: "load" });
  await toCamp(p2);
  const y0 = await p2.evaluate(() => window.ringfallYaw());
  await p2.mouse.move(640, 360);
  await p2.mouse.move(840, 360, { steps: 10 });
  await p2.waitForTimeout(300);
  const y1 = await p2.evaluate(() => window.ringfallYaw());
  if (!(Math.abs(y1 - y0) > 0.05)) errors.push(`no pointer lock: the mouse did not turn the view in the camp (${y0.toFixed(2)} -> ${y1.toFixed(2)})`);
  await p2.close();
  lap("no pointer lock");
}

// A fresh profile walks to a way in it does not know: the toast shows it as the map's dashed ring with its name, the camp marks it, and the map tells it from those still unknown.
{
  const pg = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  pg.on("pageerror", (e) => errors.push(`way in pageerror: ${e.message}`));
  pg.on("console", (m) => m.type() === "error" && !/fonts\.g|ERR_TUNNEL|net::/.test(m.text()) && errors.push(`way in console: ${m.text()}`));
  await pg.goto(`http://localhost:${port}/ringfall/`, { waitUntil: "load" });
  await toCamp(pg);
  await walkOutOfGate(pg);
  await pg.evaluate(() => window.advanceTime(100));
  // The east checkpoint's way in (470, -30) faces west: stand 8 m inside it, looking out at its camp.
  await pg.evaluate(() => window.ringfallPlace(462, -30, Math.PI / 2));
  await pg.evaluate(() => window.advanceTime(300));
  const st = JSON.parse(await pg.evaluate(() => window.render_game_to_text()));
  const toast = await pg.evaluate(() => [...document.querySelectorAll("#toasts .toast")].map((t) => (t.querySelector(".ico.entry") ? "◯" : "") + t.textContent).join("|"));
  if (st.found.join() !== "beach,checkpoint" || !/◯東の検問道/.test(toast)) errors.push(`way in: walking to the checkpoint found ${st.found.join()}, toast "${toast}"`);
  await pg.screenshot({ path: `${out}/32-entry-found.png` });
  await pg.keyboard.press("KeyM");
  await pg.evaluate(() => window.advanceTime(100));
  await pg.screenshot({ path: `${out}/33-map-entries.png` });
  await pg.keyboard.press("KeyN");
  await pg.evaluate(() => window.advanceTime(100));
  await pg.screenshot({ path: `${out}/34-map-entries-whole.png` });
  await pg.close();
  lap("way in found");
}

const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => m.type() === "error" && !/fonts\.g|ERR_TUNNEL|net::/.test(m.text()) && errors.push(`console: ${m.text()}`));
await page.goto(`http://localhost:${port}/ringfall/`, { waitUntil: "load" });
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/00-title.png` });
await page.click("#start");
const read = async () => JSON.parse(await page.evaluate(() => window.render_game_to_text()));

// The camp: each station seen and its panel opened by the use key; a common LANCE bought from the
// trader (holding no node it sells common gear only), then taken with a stash weapon out of the gate into the raid.
{
  await faded(page);
  const h0 = await read();
  if (h0.screen !== "camp" || h0.camp?.panel !== null) errors.push(`camp: the start button opened ${h0.screen}, not the camp`);
  await page.screenshot({ path: `${out}/00-camp.png` });
  await pauseShot(page, "00-camp-pause", 6, "camp");
  const seen = async (id) => {
    await page.evaluate((i) => window.ringfallCamp.walkTo(i), id);
    await page.evaluate(() => window.advanceTime(100));
    const prompt = await page.textContent("#camp-prompt");
    if (!prompt) errors.push(`camp: no prompt at ${id}`);
    await page.screenshot({ path: `${out}/00-camp-${id}.png` });
  };
  await seen("shop");
  await useStation(page, "shop");
  await page.screenshot({ path: `${out}/00-panel-shop.png` });
  if ((await page.locator("#hub-side .shelf-tiers .tier.on").count()) !== 1 || (await page.locator("#hub-side [data-act=buy]", { hasText: "レア" }).count())) errors.push("camp: holding no node the trader's shelf is not common only");
  await page.click('#hub-side [data-act=buy][data-arg="3"]');
  const h1 = await read();
  if (!(h1.profile.cash < h0.profile.cash && h1.profile.stash === h0.profile.stash + 1)) errors.push(`camp: buying did not take cash and fill the stash (${JSON.stringify(h0.profile)} -> ${JSON.stringify(h1.profile)})`);
  // Esc closes a panel, and the camp walks on.
  await page.keyboard.press("Escape");
  if ((await read()).camp?.panel) errors.push("camp: Esc did not close the trader's panel");
  await seen("quests");
  if (!/依頼/.test((await read()).camp.marks.quests)) errors.push(`camp: the board carries no mark with contracts on it and none taken (${JSON.stringify((await read()).camp.marks)})`);
  await useStation(page, "quests");
  const quests = await page.locator("#hub-side .quest:not(.contract):not(.story)").count();
  const contracts = await page.locator("#hub-side .quest.contract").count();
  const stories = await page.locator("#hub-side .quest.story").count();
  if (quests !== 2 || contracts < 3 || contracts > 4 || stories !== 1) errors.push(`camp: the board offers ${quests} intro quests (not 2), ${contracts} contracts and ${stories} story contracts at the start`);
  await page.screenshot({ path: `${out}/00-panel-quests.png` });
  // Taking the day's intercept: it is marked taken, and the board's mark goes.
  await page.click("#hub-side .quest.contract[data-type=intercept] [data-act=take]");
  const tk = await read();
  if (!tk.camp.taken || tk.camp.board.find((c) => c.id === tk.camp.taken)?.t !== "intercept" || !(await page.locator("#hub-side .quest.contract.taken").count()) || /依頼/.test(tk.camp.marks.quests)) errors.push(`camp: taking the intercept left ${JSON.stringify(tk.camp)}`);
  await page.screenshot({ path: `${out}/00-panel-quests-taken.png` });
  await page.locator("#hub-side .quest.story").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${out}/00-panel-quests-story.png` });
  await closePanel(page);
  await seen("workshop");
  await useStation(page, "workshop");
  await page.screenshot({ path: `${out}/00-panel-workshop.png` });
  await closePanel(page);
  // The map table shows the island and chooses no start: that is the departure's.
  await seen("map");
  await useStation(page, "map");
  if ((await page.locator("#hub-side [data-act=entry], #hub-side [data-act=region], #hub-side [data-act=from]").count()) || !(await page.locator("#hub-island-map").count())) errors.push("camp: the map table still chooses a start, or shows no island");
  await page.screenshot({ path: `${out}/00-panel-map.png` });
  await closePanel(page);
  // The departure from the truck: a fresh profile knows only the reservoir's first way in, so the harbor carries a padlock and its ways in are dashed; cancelled with Esc.
  await useStation(page, "vehicle");
  await departUp(page);
  const harborLocked = await page.locator("#depart-points .region-lock").count();
  const entriesOffered = await page.locator("#depart-points button.pick.entry:not(:disabled)").count();
  const harborRings = await page.locator("#depart-points button.pick.entry.shut").count();
  const fresh = (await readPage(page)).camp.depart;
  if (harborLocked !== 1 || entriesOffered !== 1 || harborRings !== 5 || fresh?.start?.id !== "beach") errors.push(`camp: a fresh departure offers ${entriesOffered} ways in, ${harborLocked} locked regions, ${harborRings} ways in to find, starting at ${fresh?.start?.id}`);
  await page.screenshot({ path: `${out}/00-depart-locked.png` });
  await page.keyboard.press("Escape");
  if ((await readPage(page)).camp?.depart) errors.push("camp: Esc did not close the departure");
  await seen("stash");
  await useStation(page, "stash");
  // The starter weapons come picked; the LANCE and then the HORNET take their places.
  await page.locator("#hub-stash [data-act=pick]", { hasText: "LANCE" }).click();
  await page.locator("#hub-stash [data-act=pick]", { hasText: "HORNET" }).click();
  // Each weapon shows its numbers, in the stash's list and in the picked slots.
  const stats = await page.locator("#hub-side .slot .stat").allTextContents();
  if (stats.length !== 2 || !stats.every((t) => /威力 \d+.*毎分 \d+ 発.*弾倉 \d+/.test(t)) || !(await page.locator("#hub-stash .item small", { hasText: "毎分" }).count())) errors.push(`camp: the shelves' weapons show ${JSON.stringify(stats)}`);
  await page.screenshot({ path: `${out}/00-panel-stash.png` });
  await closePanel(page);
  await seen("vehicle");
  await page.evaluate(() => window.ringfallCamp.toGate());
  await page.evaluate(() => window.advanceTime(100));
  await page.screenshot({ path: `${out}/00-camp-gate.png` });
  const h2 = await walkOutOfGate(page, "00-depart");
  // The magazine is left out: the frame loop may already have stepped the raid and loaded it.
  if (h2.player.weapons.map((w) => w?.split(":")[0]).join() !== "lance0,hornet0") errors.push(`camp: the raid did not start with the picked weapons (${h2.player.weapons.join()})`);
  if (h2.profile.stash !== h1.profile.stash - 2) errors.push(`camp: the picked weapons stayed in the stash (${h1.profile.stash} -> ${h2.profile.stash})`);
  if (h2.region !== "reservoir" || h2.phase !== "play" || !h2.ally.active || Math.hypot(h2.ally.x - h2.player.x, h2.ally.z - h2.player.z) > 6) errors.push(`camp: out of the gate the raid is ${h2.region} ${h2.phase}, teammate ${JSON.stringify(h2.ally)}`);
  lap("camp");
}

// Real keyboard input must reach the sim: holding W at the start moves the player north (the beach faces north).
const before = await read();
await page.keyboard.down("KeyW");
await page.evaluate(() => window.advanceTime(600));
await page.keyboard.up("KeyW");
const after = await read();
if (!(after.player.z < before.player.z - 3)) errors.push(`keyboard: W did not move the player (${before.player.z} -> ${after.player.z})`);
// F aims without the right button: held in the default mode, switched on and off by each press in the other.
{
  const adsAfter = async (ms) => (await page.evaluate((t) => window.advanceTime(t), ms), (await read()).player.ads);
  await page.keyboard.down("KeyF");
  const held = await adsAfter(500);
  await page.keyboard.up("KeyF");
  const let_go = await adsAfter(500);
  await page.evaluate(() => {
    const el = document.getElementById("adsmode2");
    el.value = "toggle";
    el.dispatchEvent(new Event("change"));
  });
  await page.keyboard.press("KeyF");
  const switchedOn = await adsAfter(500);
  // The right button held and let go leaves F's switched-on aim as it was.
  await page.mouse.down({ button: "right" });
  await adsAfter(200);
  await page.mouse.up({ button: "right" });
  const afterRight = await adsAfter(500);
  await page.keyboard.press("KeyF");
  const switchedOff = await adsAfter(500);
  await page.evaluate(() => {
    const el = document.getElementById("adsmode2");
    el.value = "hold";
    el.dispatchEvent(new Event("change"));
  });
  if (!(held > 0.9 && let_go < 0.1 && switchedOn > 0.9 && afterRight > 0.9 && switchedOff < 0.1)) errors.push(`F aim: held ${held}, let go ${let_go}, switched on ${switchedOn}, after the right button ${afterRight}, off ${switchedOff}`);
}
await page.screenshot({ path: `${out}/01-start.png` });
await pauseShot(page, "01-pause", 16, "raid");
// The start's banner names the way in, and only that.
const startBanner = await page.evaluate(() => ({ head: document.getElementById("banner-head").textContent, sub: document.getElementById("banner-sub").textContent }));
if (!/南の浜/.test(startBanner.head) || startBanner.sub) errors.push(`start banner does not name only the way in: ${JSON.stringify(startBanner)}`);

// A tour of the island's buildings and high ground, from fixed cameras.
await page.evaluate(() => {
  document.getElementById("hud").hidden = true;
  document.getElementById("banner").className = "";
});
await page.waitForTimeout(400);
// A camera written in the frame of a POI (by its id), a hamlet (by its name) or an area ("area:" and its id): [x, y, z].
const frames = await page.evaluate(() => window.ringfallFrames());
const at = (frame, dx, y, dz) => [frames[frame].x + dx, y, frames[frame].z + dz];
const tour = [
  // The reservoir, at eye height unless marked absolute (a crest, a floor up a tower).
  ["tour-1-lakebed-from-dam", ...at("area:heart", 0, 17.7, -120), Math.PI, -0.25, true],
  ["tour-2-dam-face", ...at("area:heart", 0, 1.7, -70), 0, 0.25],
  ["tour-3-town-street", ...at("area:heart", 0, 1.7, 45), 0, 0.05],
  ["tour-4-church-spire", ...at("area:heart", -5, 1.7, 15), -0.7, 0.3],
  ["tour-5-spillway", ...at("area:heart", 112, 1.7, -108), 0, 0.15],
  ["tour-6-quarry-pit", ...at("quarry", 20, 1.7, -75), Math.PI, -0.3],
  ["tour-7-high-rise-view", ...at("area:heart", -26, 4.6, -14), 2.5, -0.25, true],
  ["tour-8-plateau-over-lakebed", ...at("area:heart", -95, 1.7, -5), 1.57, -0.15],
  ["tour-9-terraced-fields", ...at("area:village", 60, 1.7, 75), -0.66, 0.08],
  ["tour-10-over-supply", ...at("supply", 130, 45, -120), -2.32, -0.3, true],
  ["tour-11-mesa-relay", ...at("relay", -50, 1.7, 25), 1.08, 0.3],
  // The tether's anchor over the titan's arena, the view south from its gallery over the pad, the
  // fallen tether from beside it and through its corridor, and both from above the pad.
  ["tour-60-anchor-from-pad", ...at("pad", 30, 1.7, 20), -0.15, 0.32],
  ["tour-61-anchor-gallery", ...at("area:anchor", 0, 16 + 34.3 + 1.6, 7.5), Math.PI, -0.3, true],
  ["tour-62-fallen-tether", ...at("area:anchor", -66, 1.7, 30), -1.25, 0.06],
  ["tour-63-tether-corridor", ...at("area:anchor", -86, 1.7, 0), -1.57, 0.02],
  ["tour-64-anchor-and-tether", ...at("area:anchor", -20, 70, 110), -0.55, -0.42, true],
];
for (const [name, x, dy, z, yaw, pitch, abs] of tour) {
  const y = abs ? dy : (await page.evaluate(([x, z]) => window.ringfallTerrain(x, z), [x, z])) + dy;
  await page.evaluate(([x, y, z, yaw, pitch]) => window.ringfallCamera(x, y, z, yaw, pitch), [x, y, z, yaw, pitch]);
  await page.screenshot({ path: `${out}/${name}.png` });
}
// The harbor and the ways there. Heights are above the ground at the camera, or absolute (a deck, a roof).
const harborTour = [
  ["tour-12-pass-saddle", ...at("area:pass", -60, 1.7, -228), 0.05, -0.05],
  ["tour-13-railway-bridge", ...at("area:railway", 100, 1.7, -191), 1.45, 0.32],
  ["tour-14-bridge-deck", ...at("area:railway", 122, 11.8, -168), 0, -0.04, true],
  // Under the viaduct's corner, looking west along it.
  ["tour-15-viaduct", 165, 1.7, -622, -1.42, 0.16],
  ["tour-16-wreck", ...at("wreck", -12, 1.7, 40), 0.12, 0.1],
  ["tour-17-wreck-deck", ...at("wreck", -38, -3 + 13.5 + 1.7, 4), 1.5, 0.02, true],
  ["tour-17b-wreck-bridge-wing", ...at("wreck", 58, -3 + 13.5 + 13.6 + 1.7, -19), -1.57, -0.18, true],
  ["tour-18-yard-alley", ...at("yard", -46, 1.7, -29.5), 1.57, 0.02],
  ["tour-19-yard-crane", ...at("yard", 46.4, 13.6 + 1.6, 14), 0, -0.2, true],
  ["tour-19b-yard-quay-crane", ...at("yard", 46, 34 + 1.7, -45), Math.PI, -0.3, true],
  ["tour-20-smelter", ...at("smelter", 8, 1.7, 44), 0, 0.14],
  ["tour-21-lighthouse", ...at("area:bay", -66, 1.7, -514), -0.97, 0.22],
  ["tour-22-lighthouse-view", ...at("area:bay", -112.9, 33.4, -552), 1.45, -0.2, true],
  ["tour-23-salt-flats", ...at("area:bay", -40, 1.7, -468), 0.75, 0.0],
  ["tour-24-quay-boat", ...at("area:bay", 94, 1.7, -578), 1.32, -0.1],
  // The open ground between the areas, its outcrops and hamlets.
  ["tour-25-open-ground", 60, 1.7, 250, -0.3, 0.0],
  ["tour-26-west-farm", ...at("西の農場", 20, 1.7, 18), -0.84, 0.05],
  ["tour-27-water-tower", ...at("給水所", -25, 1.7, -20), 2.24, 0.08],
  ["tour-28-checkpoint", ...at("東の検問所", -25, 5, 17), 0.97, -0.08],
  ["tour-29-fishing-village", ...at("西の漁村", 25, 1.7, 20), -0.9, 0.05],
  ["tour-30-signal-box", ...at("信号所", 20, 1.7, 20), -0.79, 0.08],
  ["tour-31-reservoir-from-above", 0, 150, 560, 0, -0.36, true],
  // The routes' obstacles, all closed in this fresh profile: the tunnel's two choked mouths,
  // the dam's chained gallery door, the wreck's gangway hauled up against its hull.
  ["tour-32-tunnel-rubble", 40, 1.7, -287, 0, 0.12],
  ["tour-33-tunnel-rubble-north", 40, 1.7, -422, Math.PI, 0.12],
  ["tour-34-dam-gate", ...at("area:heart", 20, 1.7, -97), 0, 0.12],
  // The open ground north of the landing pad, toward the mountains, and the harbor's south plain from the pass.
  ["tour-36-north-of-pad", ...at("pad", -30, 1.7, -110), 0.2, 0.05],
  ["tour-37-harbor-plain", -96, 1.7, -440, 0.3, -0.04],
  ["tour-35-gangway-hauled", ...at("wreck", -31, 1.7, -30), Math.PI - 0.45, 0.5],
  // Each POI's landmark from the way in, and the smelter's roofs from the bridge between its halls.
  ["tour-38-supply-silos", ...at("supply", 20, 1.7, 170), -0.16, 0.08],
  // The supply depot at its own scale, from eye height: the tanker's bow over the beach, the
  // street between the assembly hall and the long shed, the yard from the east dune's crest.
  ["tour-46-supply-tanker-from-beach", ...at("supply", 30, 1.7, 160), 0.2, 0.15],
  ["tour-47-supply-street", ...at("supply", -40, 1.7, -15), 1.62, 0.1],
  ["tour-48-supply-dune-crest", ...at("supply", 90, 1.7, 22), -2.2, -0.04],
  // The ring-segment assembly hall: its south face torn open over the segment, the floor from its
  // west end along the segment and the cranes, and the hall from the crane runway's walkway.
  ["tour-65-assembly-hall", ...at("supply", 0, 1.7, 8), -0.15, 0.32],
  ["tour-66-assembly-floor", ...at("supply", -64, 1.7, -30), 1.4, 0.15],
  ["tour-67-assembly-crane-walk", ...at("supply", -66, 28.8, -58.4), 1.85, -0.4, true],
  ["tour-39-quarry-plant", ...at("quarry", -10, 1.7, 25), 0, 0.2],
  // The bucket-wheel excavator from the rim yard, from beside its crawlers, and down its boom from the machine house's roof.
  ["tour-68-quarry-excavator", ...at("quarry", 60, 1.7, -95), 3.05, 0.15],
  ["tour-69-excavator-crawlers", ...at("quarry", 70, 1.7, 40), 0.71, 0.35],
  ["tour-70-excavator-boom", ...at("quarry", 96, 11.6, 12), -1.57, -0.2, true],
  ["tour-40-relay-mast", ...at("relay", -20, 1.7, 20), -0.57, 0.35],
  // The big dish: from the mesa's top, from its gallery into the bowl, and over the works from the south-west.
  ["tour-71-relay-dish", ...at("relay", -20, 1.7, 20), 1.2, 0.35],
  ["tour-72-dish-gallery", ...at("relay", 14.5, 39.3, -5), 1.57, 0.25, true],
  ["tour-73-dish-from-works", ...at("relay", -60, 1.7, 230), 0.2, 0.12],
  ["tour-41-pad-hangars", ...at("pad", 0, 1.7, 60), 0, 0.1],
  // The reservoir's POIs and districts at their own scale, from eye height: the quarry's
  // terraces from its floor and its tunnel, the mesa from its foot and from its ledge road,
  // the pad's runway, the intake tower before the dam, the fields from the hill and the
  // windmill, the sawtooth works and the car park, the drowned town from a roof.
  ["tour-49-quarry-from-floor", ...at("quarry", -30, 1.7, 30), 1.57, 0.2],
  ["tour-50-quarry-tunnel", ...at("quarry", -60, 1.7, 22), -1.57, 0.05],
  ["tour-51-mesa-from-foot", ...at("relay", -130, 1.7, 60), 1.2, 0.25],
  ["tour-52-mesa-ledge", ...at("relay", 30, 1.7, 52), -1.57, 0.05],
  ["tour-53-pad-runway", ...at("pad", 60, 1.7, -42), -1.57, 0.02],
  ["tour-54-intake-tower", ...at("area:heart", -20, 1.7, -60), -0.4, 0.35],
  ["tour-55-fields-from-hill", ...at("area:village", -10, 1.7, -50), Math.PI, -0.1],
  ["tour-56-windmill", ...at("area:village", -25, 1.7, -15), -0.2, 0.25],
  ["tour-57-factory-sawtooth", ...at("area:factory", -55, 1.7, 10), 0, 0.12],
  ["tour-58-housing-carpark", ...at("area:factory", 30, 1.7, 20), 0.6, 0.12],
  ["tour-59-drowned-roofs", ...at("area:heart", 10, -8.9, -20), 0.8, -0.05, true],
  ["tour-42-wreck-length", ...at("wreck", 40, 1.7, 50), -0.67, 0.12],
  ["tour-43-yard-gantries", ...at("yard", 0, 1.7, 60), 0, 0.12],
  ["tour-44-smelter-chimneys", ...at("smelter", 20, 1.7, 70), -0.28, 0.18],
  ["tour-45-smelter-deck", ...at("smelter", -14, 3 + 34 + 1.7, -4), Math.PI / 2, -0.22, true],
  // The outposts between the POIs, and the works that lead from one to the next: the power line
  // north from the substation toward the quay, the freight line east past the yard.
  ["tour-74-substation", ...at("変電所", -40, 1.7, 25), 1.01, 0.12],
  ["tour-75-fuel-depot", ...at("燃料基地", -45, 1.7, 30), 0.98, 0.1],
  ["tour-76-marshalling-yard", ...at("貨物操車場", 45, 1.7, 40), -0.84, 0.08],
  ["tour-77-power-line", 112, 1.7, -660, -0.08, 0.15],
  ["tour-78-freight-line", -175, 1.7, -775, 1.4, 0.04],
  ["tour-79-pipeline", 330, 1.7, -800, -1.2, 0.12],
  ["tour-80-harbor-from-above", 0, 230, -520, 0, -0.5, true],
  ["tour-81-wharf", ...at("荷揚げ場", 30, 1.7, 40), -0.64, 0.12],
  ["tour-82-engine-depot", ...at("保線基地", -35, 1.7, 40), 0.72, 0.08],
  ["tour-83-east-substation", ...at("東の変電所", -45, 1.7, 30), 0.98, 0.12],
  ["tour-84-pumping-station", ...at("揚水ポンプ場", -45, 1.7, 35), 0.91, 0.08],
  // The streets, the town on the ring road, and the fences with their gates.
  ["tour-85-town-street", ...at("湖畔の町", -45, 1.7, -7), 1.6, 0.04],
  ["tour-86-town-from-above", ...at("湖畔の町", 0, 45, 55), 0, -0.6],
  ["tour-87-ring-road-traffic", 170, 1.7, 212, -1.6, 0.02],
  ["tour-88-yard-fence", -120, 1.7, -648, -0.67, 0.05],
  ["tour-89-supply-fence", -30, 1.7, 285, 3.14, 0.05],
  // The ring's wreckage: a gap between lengths, the tunnel, a leaning length, the canyon on the east shore.
  ["tour-90-ring-wreck-south-of-quarry", -300, 1.7, 320, -0.4, 0.1],
  ["tour-91-ring-wreck-tunnel", -340, 1.7, 230, 1.57, 0],
  ["tour-92-ring-wreck-leaning", -334, 22, 300, 0, -0.1],
  ["tour-93-ring-wreck-east-shore", 400, 1.7, 125, 1.57, 0.06],
  ["tour-94-ring-wreck-harbor", -240, 1.7, -490, 0, 0.08],
];
for (const [name, x, dy, z, yaw, pitch, abs] of harborTour) {
  const y = abs ? dy : (await page.evaluate(([x, z]) => window.ringfallTerrain(x, z), [x, z])) + dy;
  await page.evaluate(([x, y, z, yaw, pitch]) => window.ringfallCamera(x, y, z, yaw, pitch), [x, y, z, yaw, pitch]);
  await page.screenshot({ path: `${out}/${name}.png` });
}

// The robots out between the POIs: a rogue squad and an enemy patrol on its walk up close, a fight
// between the factions seen from far off, and the map with the fight heard.
{
  // A camera `d` metres from the robot `e`, `side` radians round from the way it faces, `up` metres over the ground, looking at it.
  const lookAt = async (name, e, d, side, up) => {
    const a = side;
    const x = e.x + Math.sin(a) * d;
    const z = e.z - Math.cos(a) * d;
    const g = await page.evaluate(([x, z]) => window.ringfallTerrain(x, z), [x, z]);
    const y = Math.max(g, e.y) + up;
    const yaw = Math.atan2(e.x - x, -(e.z - z));
    const pitch = Math.atan2(e.y + 1.2 - y, Math.hypot(e.x - x, e.z - z));
    await page.evaluate(([x, y, z, yaw, pitch]) => window.ringfallCamera(x, y, z, yaw, pitch), [x, y, z, yaw, pitch]);
    await page.screenshot({ path: `${out}/${name}.png` });
  };
  const st = await read();
  const lead = (pick) => {
    const i = st.squads.findIndex(pick);
    return i < 0 ? null : (st.enemies.find((e) => e.squad === i && e.kind !== "drone") ?? st.enemies.find((e) => e.squad === i) ?? null);
  };
  const rogue = lead((q) => q.rogue && q.mobile);
  if (!rogue) errors.push("factions: no rogue squad on a walk at the start of a reservoir raid");
  else await lookAt("faction-1-rogue-squad", rogue, 9, 2.2, 1.8);
  const patrol = lead((q) => q.mobile && !q.rogue && /警邏|車列/.test(q.name));
  if (!patrol) errors.push("factions: no enemy patrol on a walk at the start of a reservoir raid");
  else await lookAt("faction-2-patrol-road", patrol, 13, 2.6, 2.4);
  // A fight staged on the open ground south of the lakebed, in earshot of the player at the beach.
  await page.evaluate(() => window.ringfallFight(60, 250));
  await page.evaluate(() => window.ringfallStep(2500));
  let bolts = 0;
  for (let i = 0; i < 120 && !bolts; i++) bolts = (await quietStep(page, 30)).orbs;
  const fx = 150;
  const fz = 330;
  const fy = (await page.evaluate(([x, z]) => window.ringfallTerrain(x, z), [fx, fz])) + 30;
  await page.evaluate(([x, y, z, yaw, pitch]) => window.ringfallCamera(x, y, z, yaw, pitch), [fx, fy, fz, Math.atan2(60 - fx, -(250 - fz)), -0.2]);
  await page.screenshot({ path: `${out}/faction-3-firefight-far.png` });
  const heard = await read();
  if (!bolts) errors.push("factions: the staged fight fired no bolt in 6 s");
  if (!heard.contacts.some((c) => c.fight)) errors.push(`factions: the player ${Math.round(Math.hypot(heard.player.x - 60, heard.player.z - 250))} m off did not hear the staged fight`);
  await page.evaluate(() => {
    window.ringfallCamera();
    document.getElementById("hud").hidden = false;
  });
  await page.keyboard.press("KeyM");
  await page.evaluate(() => window.advanceTime(50));
  await page.keyboard.press("KeyN");
  await page.evaluate(() => window.advanceTime(50));
  await page.screenshot({ path: `${out}/faction-4-map-fight.png` });
  await page.keyboard.press("KeyN");
  await page.keyboard.press("KeyM");
  await page.evaluate(() => window.advanceTime(50));
  await page.evaluate(() => {
    document.getElementById("hud").hidden = true;
  });
}
await page.evaluate(() => {
  window.ringfallCamera();
  document.getElementById("hud").hidden = false;
});
lap("start and tour");

// Armour plates up close: a row of robots in each plate's colour (none, rare blue, epic purple,
// legendary gold); a common round off a purple plate (sparks, no number), then epic rounds
// through it until the plate breaks off (numbers, and the plate gone).
{
  const p0 = await read();
  const yaw0 = await page.evaluate(() => window.ringfallYaw());
  const row = await page.evaluate(([x, z]) => window.ringfallPlates(x, z, Math.PI), [p0.player.x, p0.player.z - 10]);
  const mid = { x: (row[1].x + row[2].x) / 2, y: row[1].y, z: row[1].z };
  await page.evaluate(([x, y, z]) => window.ringfallCamera(x, y + 2, z + 6.5, 0, -0.12), [mid.x, mid.y, mid.z]);
  await page.evaluate(() => window.advanceTime(16));
  await page.screenshot({ path: `${out}/plates-1-colours.png` });
  const purple = row[2];
  await page.evaluate(([x, z, tx, tz]) => window.ringfallPlace(x, z, Math.atan2(tx - x, -(tz - z))), [purple.x, purple.z + 9, purple.x, purple.z]);
  await page.evaluate(() => window.ringfallCamera());
  await page.evaluate(() => window.advanceTime(16));
  const before = await page.locator("#dmg-layer .dmg, .dmg").count();
  const off = await page.evaluate((id) => window.ringfallShoot(id, 0), purple.id);
  await page.evaluate(() => window.advanceTime(16));
  const after = await page.locator("#dmg-layer .dmg, .dmg").count();
  if (!off || off.plate !== 2 || after !== before || (await page.getAttribute("#hitmark", "class")) !== "plate") errors.push(`plates: a common round on a purple plate left ${JSON.stringify(off)}, ${after - before} new numbers, the hit mark "${await page.getAttribute("#hitmark", "class")}"`);
  await page.screenshot({ path: `${out}/plates-2-deflect.png` });
  let through = off;
  for (let i = 0; i < 40 && through && through.plate > 0; i++) {
    through = await page.evaluate((id) => window.ringfallShoot(id, 2), purple.id);
    await page.evaluate(() => window.ringfallStep(50));
  }
  await page.evaluate(() => window.advanceTime(16));
  if (!through || through.plate !== 0 || !(await page.locator(".dmg").count())) errors.push(`plates: epic rounds left the purple plate at ${JSON.stringify(through)}, numbers ${await page.locator(".dmg").count()}`);
  await page.screenshot({ path: `${out}/plates-3-broken.png` });
  // The rest of the gate plays on as if they had never come: the robots gone, the player back where they stood.
  await page.evaluate(([x, z, yaw]) => {
    window.ringfallClearPlates();
    window.ringfallPlace(x, z, yaw);
  }, [p0.player.x, p0.player.z, yaw0]);
  await page.evaluate(() => window.advanceTime(16));
  lap("plates");
}

// Knock the teammate down and pick it up by hand: its tag and the prompt show, one press
// of E starts the help, and it stands up after standing by it.
// The keyboard check above walked the player off: stand the teammate beside them again, as a raid starts.
const here = (await read()).player;
await page.evaluate(([x, z]) => window.ringfallPlace(x, z, window.ringfallYaw()), [here.x, here.z]);
// The teammate up close, from a fixed camera in front of it.
const mate = (await read()).ally;
await page.evaluate((a) => {
  document.getElementById("hud").hidden = true;
  window.ringfallCamera(a.x + 2.2, a.y + 1.5, a.z - 2.2, -2.36, -0.12);
}, mate);
await page.screenshot({ path: `${out}/18-teammate.png` });
await page.evaluate(() => {
  window.ringfallCamera();
  document.getElementById("hud").hidden = false;
});
await page.evaluate(() => window.ringfallDownAlly());
await page.evaluate(() => window.advanceTime(300));
await page.screenshot({ path: `${out}/18-teammate-down.png` });
// Down, the teammate's row shows a cross and its seconds, and the prompt the first-aid mark and its name.
const downUi = await page.evaluate(() => ({ prompt: document.getElementById("prompt").textContent, aid: !!document.querySelector("#prompt .ico.revive"), tag: getComputedStyle(document.getElementById("mate-tag")).display, row: document.getElementById("mate").className, cross: !!document.querySelector("#mate-state .ico.cross") }));
if (!/リオ/.test(downUi.prompt) || !downUi.aid || downUi.tag === "none" || downUi.row !== "down" || !downUi.cross) errors.push(`teammate down: HUD did not show it (${JSON.stringify(downUi)})`);
await page.keyboard.press("KeyE");
await page.evaluate(() => window.advanceTime(3400));
const helped = await read();
if (helped.ally.down > 0 || helped.stats.allyHelped !== 1) errors.push(`teammate down: E did not pick it up (${JSON.stringify(helped.ally)})`);

// The ult: leap with the teammate beside, glide forward, and land together.
const l0 = await read();
await page.evaluate(() => window.ringfallChargeUlt());
await page.keyboard.press("KeyZ");
await page.keyboard.down("KeyW");
await page.evaluate(() => window.advanceTime(1600));
await page.screenshot({ path: `${out}/07-leap.png` });
const l1 = await read();
if (!l1.player.leap || !(l1.player.y > l0.player.y + 15)) errors.push(`leap: Z did not leap (${JSON.stringify(l1.player)})`);
await stepWhile(page, 250, 60, (st) => st.player.leap);
await page.keyboard.up("KeyW");
const l2 = await read();
const glided = Math.hypot(l2.player.x - l0.player.x, l2.player.z - l0.player.z);
const mateGap = Math.hypot(l2.ally.x - l2.player.x, l2.ally.z - l2.player.z);
if (l2.player.leap || glided < 30 || mateGap > 4) errors.push(`leap: landed ${l2.player.leap ? "never" : ""} ${glided.toFixed(0)} m away, teammate ${mateGap.toFixed(1)} m off`);
await page.screenshot({ path: `${out}/07-leap-landed.png` });
lap("teammate and leap");

await page.evaluate((s) => window.ringfallBot(s), skill);
const taken = new Set();
const shot = async (name) => {
  if (taken.has(name)) return;
  taken.add(name);
  await draw(page);
  // A frame in the middle of a fight, effects and bolts in it, can take software drawing well over
  // the default 30 s; the shot waits for it rather than failing the gate.
  await page.screenshot({ path: `${out}/${name}.png`, timeout: 180000 });
};
let prevKey = "";
let prevFlank = 0;
let lastProgress = 0;
// Where the bot stood at the last progress: ground covered counts too, since the walk between
// POIs and to a way off takes minutes at the world's scale. A bot stuck going back and forth
// on one spot stays within a few metres of it.
let progressAt = null;
// A kill is shot once the wreck has had time to fall over.
let prevKills = 0;
let wreckAt = -1;
let wreckSpot = null;
let prevEnemies = [];
let s = after;
for (let i = 0; i < 25 * 60 * 10; i++) {
  s = await quietStep(page, 100);
  if ((i + 1) % DRAW_EVERY === 0) await draw(page);
  const key = `${s.phase}-${s.cleared.join("")}-${s.enemies.length}-${s.loot}-${s.stats.kills}-${s.haul.value}`;
  const walked = !progressAt || Math.hypot(s.player.x - progressAt.x, s.player.z - progressAt.z) > 25;
  if (key !== prevKey || walked) {
    prevKey = key;
    lastProgress = s.time;
    progressAt = { x: s.player.x, z: s.player.z };
  }
  if (s.time - lastProgress > 90) {
    await draw(page);
    await page.screenshot({ path: `${out}/stall.png` });
    const near = s.enemies.filter((e) => Math.hypot(e.x - s.player.x, e.z - s.player.z) < 70);
    throw new Error(`no progress for 90 s: player ${JSON.stringify(s.player)} ally ${JSON.stringify(s.ally)} cleared ${s.cleared} near ${JSON.stringify(near)}`);
  }
  const live = s.enemies.filter((e) => e.mode !== "spawning" && e.aware === "engaged");
  const near = (e) => Math.hypot(e.x - s.player.x, e.z - s.player.z);
  const at = (poi) => live.some((e) => s.squads[e.squad].poi === poi);
  if (s.phase === "play" && !taken.has("02-start")) {
    await shot("02-start");
    // The taken intercept is the objective card's objective, as its steps, and the map marks where it is.
    const line = await page.evaluate(() => document.getElementById("obj-title").textContent + "｜" + document.getElementById("obj-text").textContent + "｜" + document.getElementById("obj-n").textContent);
    if (!/迎撃/.test(line) || !/1\/3/.test(line) || s.contract?.t !== "intercept") errors.push(`contract: the objective card reads "${line}" for ${JSON.stringify(s.contract)}`);
    await page.locator("#objective").screenshot({ path: `${out}/02-objective-contract.png` });
    // The compass's one marker, at the objective step's place, with its distance.
    const mark = await page.evaluate(() => ({ hidden: document.getElementById("compass-mark").hidden, text: document.getElementById("compass-mark").textContent }));
    if (mark.hidden || !/\d+m/.test(mark.text)) errors.push(`objective: the compass marker is ${JSON.stringify(mark)}`);
    await page.screenshot({ path: `${out}/front-1-compass.png`, clip: { x: 1280 / 2 - 260, y: 0, width: 520, height: 120 } });
    // The beacon from far off: a camera 170 m short of the step's place, over the roofs, facing it.
    if (!(await beaconShot(page, "front-2-beacon-far"))) errors.push(`objective: the first step has no place (${JSON.stringify(s.objective)})`);
    // The ways off the island are open from the start and listed on the objective card.
    const lines = await page.evaluate(() => document.getElementById("obj-exits").children.length);
    if (lines !== 3) errors.push(`start: the objective card lists ${lines} ways out, not 3`);
    // The map (M) is the only place that shows where the POIs and the ways out are.
    await page.keyboard.press("KeyM");
    await page.evaluate(() => window.advanceTime(100));
    const open = await page.evaluate(() => !document.getElementById("map").hidden);
    await shot("23-map");
    // N shows the whole world, and back to the region the player is in.
    const shape = () => page.evaluate(() => +getComputedStyle(document.getElementById("map-canvas")).getPropertyValue("--map-aspect"));
    const regionShape = await shape();
    await page.keyboard.press("KeyN");
    await page.evaluate(() => window.advanceTime(100));
    const worldShape = await shape();
    await shot("23-map-world");
    await page.keyboard.press("KeyN");
    await page.evaluate(() => window.advanceTime(100));
    if (!(worldShape < regionShape * 0.8) || (await shape()) !== regionShape) errors.push(`map: N did not switch to the whole world and back (shape ${regionShape} -> ${worldShape})`);
    await page.keyboard.press("KeyM");
    await page.evaluate(() => window.advanceTime(100));
    const closed = await page.evaluate(() => document.getElementById("map").hidden);
    if (!open || !closed) errors.push(`map: M opened ${open}, closed again ${closed}`);
    // The intercept's squad is destroyed, as the player's shots would: the results show it done.
    const gone = await page.evaluate(() => window.ringfallContract.destroyTarget());
    const struck = await quietStep(page, 100);
    if (!gone || !struck.contract?.met) errors.push(`contract: destroying the target (${gone} robots) left ${JSON.stringify(struck.contract)}`);
    console.log(`desktop reservoir frame: ${JSON.stringify(await page.evaluate(() => window.ringfallFrameCost(20)))}`);
    // A vault, from just in front of it: the locked crate reads apart from the supply bins.
    // The quarry's stands on an open terrace, so the camera has a clear view of it.
    const v = s.vaults.find((b) => b.poi === 1);
    if (s.vaults.length !== 12 || !v) errors.push(`vaults: ${s.vaults.length} in the world`);
    else {
      await page.evaluate((b) => window.ringfallCamera(b.x + 0.4, b.y + 1.6, b.z + 2.6, 0.12, -0.42), v);
      await shot("26-vault");
      await page.evaluate(() => window.ringfallCamera());
    }
    // The supply's vault guard, from 3 m in front of it (it faces west): its plate reads on its chest.
    const guard = s.enemies.find((e) => e.plate > 0 && s.squads[e.squad].poi === 0);
    if (!guard) errors.push("plates: the supply's vault guard wears none");
    else {
      const cx = guard.x - 3;
      await page.evaluate(([x, y, z, w]) => window.ringfallCamera(x, y, z, w, -0.05), [cx, guard.y + 1.5, guard.z, Math.atan2(guard.x - cx, 0)]);
      await shot("28-plate");
      await page.evaluate(() => window.ringfallCamera());
    }
  }
  if (at(0) && live.length >= 2 && s.orbs >= 1) await shot("03-fight-supply");
  // The capture of a core: the step card on the hold with its seconds, the core's light pulsing; then the node taken.
  if (s.front?.capture && s.front.capture.t > 8 && !taken.has("front-3-capture")) {
    await shot("front-3-capture");
    await page.locator("#objective").screenshot({ path: `${out}/front-3-step-card.png` });
    if (s.objective?.steps[s.objective.current]?.label !== "核を守り抜く") errors.push(`objective: during a capture the step is ${JSON.stringify(s.objective)}`);
  }
  // The node taken: its core from a few metres off, lit blue with the flag up.
  if (s.stats.captured?.length && !taken.has("front-4-taken")) {
    const c = s.front.cores.find((k) => k.id === s.stats.captured[0]);
    const x = c.x - 9;
    const z = c.z + 9;
    await page.evaluate(([cx, cy, cz, yaw]) => window.ringfallCamera(cx, cy, cz, yaw, 0.05), [x, c.y + 2.2, z, Math.atan2(c.x - x, -(c.z - z))]);
    await shot("front-4-taken");
    await page.evaluate(() => window.ringfallCamera());
    if (s.front.nodes[s.front.cores.indexOf(c)] !== "freed") errors.push(`front: the node captured is ${s.front.nodes[s.front.cores.indexOf(c)]}`);
  }
  // A robot reeling from a burst, close enough to see its pose.
  if (live.some((e) => e.mode === "staggered" && near(e) < 30)) await shot("32-stagger");
  if (s.stats.kills > prevKills && wreckAt < 0 && !taken.has("33-wreck")) {
    // The robot that is gone since the last step, nearest the player: that is where the wreck lies.
    const gone = prevEnemies.filter((o) => !s.enemies.some((e) => e.kind === o.kind && Math.hypot(e.x - o.x, e.z - o.z) < 2));
    gone.sort((a, b) => near(a) - near(b));
    if (gone[0] && gone[0].kind !== "drone") {
      wreckSpot = gone[0];
      wreckAt = s.time + 0.8;
    }
  }
  prevKills = s.stats.kills;
  prevEnemies = s.enemies;
  if (wreckAt >= 0 && s.time >= wreckAt) {
    // From 4 m off, a little above: the fallen body on the ground.
    const w = wreckSpot;
    const cx = w.x + 3;
    const cz = w.z + 3;
    await page.evaluate(([x, y, z, yaw]) => window.ringfallCamera(x, y, z, yaw, -0.32), [cx, w.y + 2.2, cz, Math.atan2(w.x - cx, -(w.z - cz))]);
    await shot("33-wreck");
    await page.evaluate(() => window.ringfallCamera());
    wreckAt = -1;
  }
  // A robot's shot in flight, seen from beside its path: fast shots are drawn as stretched bolts.
  // Read afresh: shots taken earlier in this step may have moved time on.
  const fresh = !taken.has("27-bolt") && s.bolt ? await read() : null;
  // A shot in a fight on the ground, near the player: not one fired up at the leap.
  const nearBolt = fresh?.bolt && Math.abs(fresh.bolt.y - fresh.player.y) < 4 && Math.hypot(fresh.bolt.x - fresh.player.x, fresh.bolt.z - fresh.player.z) < 40;
  if (nearBolt && Math.hypot(fresh.bolt.vx, fresh.bolt.vz) > 30) {
    const b = fresh.bolt;
    const sp = Math.hypot(b.vx, b.vy, b.vz);
    const ux = b.vx / sp;
    const uz = b.vz / sp;
    const hl = Math.hypot(ux, uz) || 1;
    // 3 m to the side of its path, level with it, looking straight at it.
    const cx = b.x + (-uz / hl) * 3;
    const cz = b.z + (ux / hl) * 3;
    const yaw = Math.atan2(b.x - cx, -(b.z - cz));
    console.log(`bolt at ${b.x.toFixed(1)},${b.y.toFixed(1)},${b.z.toFixed(1)} speed ${sp.toFixed(0)}, camera ${cx.toFixed(1)},${cz.toFixed(1)} yaw ${yaw.toFixed(2)}`);
    await page.evaluate(([x, y, z, w]) => window.ringfallCamera(x, y, z, w, 0), [cx, b.y, cz, yaw]);
    await shot("27-bolt");
    await page.evaluate(() => window.ringfallCamera());
  }
  if (s.stats.kills >= 3 && s.enemies.some((e) => e.mode !== "spawning" && e.hp < 60)) await shot("04-damage-numbers");
  if (s.stats.cleared.length >= 2 && !live.length && s.loot >= 3) await shot("05-loot");
  if (s.care && !s.care.landed) await shot("06-care-package");
  if (at(2) && live.some((e) => e.kind === "heavy") && s.orbs >= 2) await shot("08-relay-heavy");
  if (!live.length && s.enemies.some((e) => (e.aware === "alert" || e.detect > 0.3) && near(e) < 45)) await shot("14-noticed");
  if (s.player.reveal > 2) await shot("15-reveal");
  if (s.stats.flankHits > prevFlank && s.stats.flankHits >= 3) await shot("16-flank-hit");
  prevFlank = s.stats.flankHits;
  if (s.squads.some((q) => q.lost) && live.length) await shot("17-lost-track");
  if (live.some((e) => e.kind === "titan") && s.orbs >= 2) await shot("09-titan");
  if (s.waves > 0) await shot("10-stomp");
  if (s.player.downed) await shot("11-downed");
  if (s.ally.target && live.length >= 2 && Math.hypot(s.ally.x - s.player.x, s.ally.z - s.player.z) > 3) await shot("19-teammate-fight");
  if (s.extract.hold > 0 || s.extract.ship > 0) await shot("12-extract");
  if (s.extract.ship > 0 && live.length >= 2) await shot("20-ship-waves");
  if (s.reinforce.came > 0 && live.some((e) => s.squads[e.squad].name === "増援")) await shot("21-reinforce");
  if (s.haul.value >= 1000 && !live.length) await shot("22-haul");
  if (s.search) await shot("24-search");
  if (s.enemies.some((e) => s.squads[e.squad].name === "レイダー" && e.mode !== "spawning" && near(e) < 40)) await shot("25-raiders");
  if (s.phase === "done") break;
}
// The bot can be wiped out now that robots hit hard; a raid that ends either way has played through.
// Getting off the island is checked by the sim's extraction scenarios.
if (s.phase !== "done" || !s.outcome) errors.push(`run did not finish: ${JSON.stringify(s).slice(0, 300)}`);
if (!taken.has("27-bolt")) errors.push("no robot shot was caught in flight for 27-bolt");
console.log(`outcome: ${s.outcome}`);
// A drawn step hands drawing back to the frame loop: the results are shot over the scene, and
// the phone-sized resize below clears the canvas, which only the frame loop draws again.
await page.evaluate(() => window.advanceTime(0));
lap("raid");
// The results come up a moment after the raid ends (on a timer of the page's own clock).
await page.waitForFunction(() => !document.getElementById("results").hidden, null, { timeout: 10000 }).catch(() => undefined);
await page.screenshot({ path: `${out}/13-results.png` });
console.log(JSON.stringify((await read()).stats));
// The results on a phone on its side: both columns and the button fit the screen.
{
  await page.setViewportSize({ width: 740, height: 360 });
  await page.waitForTimeout(300);
  const fit = await page.evaluate(() => {
    const out = [];
    for (const id of ["home", "restart", "day-result", "haul-line", "stats-box"]) {
      const r = document.getElementById(id).getBoundingClientRect();
      if (r.width && (r.right > innerWidth + 1 || r.bottom > innerHeight + 1)) out.push(`${id} ${Math.round(r.right)}x${Math.round(r.bottom)}`);
    }
    return out;
  });
  // The day's outcome leads the results: the island's map and its bar, played in beats to the day's end; no grade, score or headline.
  await page.waitForFunction(() => document.getElementById("day-beat")?.dataset.beat === "done", null, { timeout: 15000 }).catch(() => undefined);
  const day = await page.evaluate(() => ({
    map: !!document.getElementById("day-map") && !document.getElementById("day-map").hidden && document.getElementById("day-map").getBoundingClientRect().height > 50,
    bar: document.querySelector("#day-result .tug")?.getAttribute("aria-label") ?? "",
    text: document.getElementById("day-result").textContent,
  }));
  const settledDay = await read();
  const heldNow = settledDay.profile && Object.entries(settledDay.profile.poiState).filter(([id, o]) => id !== "pad" && o.state === "freed").length;
  if (!day.map || day.bar !== `${heldNow} / 11` || /陣取り戦|勝ち|負け|網/.test(day.text) || (await page.locator("#rank, #total").count())) errors.push(`results: the day reads ${JSON.stringify(day)} for ${JSON.stringify(settledDay.settled?.front)}`);
  if (fit.length) errors.push(`results on a phone: ${fit.join(", ")} past the 740x360 screen`);
  await page.screenshot({ path: `${out}/m9-results.png` });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.waitForTimeout(200);
}
{
  const r = await read();
  if (!r.settled) errors.push("results: the raid was not settled into the profile");
  if (!r.settled?.contract?.done || !(await page.evaluate(() => !!document.querySelector("#home .contract.done")))) errors.push(`results: the intercept destroyed shows ${JSON.stringify(r.settled?.contract)}`);
  await page.click("#restart");
  const h = await read();
  if (h.screen !== "camp" || h.profile.raids !== 1 || h.camp.panel !== null) errors.push(`results: back to the camp shows ${h.screen} with ${h.profile.raids} raids`);
  await faded(page);
  await page.screenshot({ path: `${out}/14-camp-after.png` });
  lap("results");
}

// A second raid, into the harbor: the bot starts at its first way in and plays to its first fight.
// The first raid did not walk to the harbor, so the save is made to know every way in, and the page reloaded to read it.
{
  await page.evaluate((k) => {
    const p = JSON.parse(localStorage.getItem(k));
    localStorage.setItem(k, JSON.stringify({ ...p, entries: ["beach", "checkpoint", "jetty", "outskirts", "quay", "shore"] }));
  }, KEY);
  await page.reload({ waitUntil: "load" });
  await toCamp(page);
  await page.evaluate((s) => window.ringfallBot(s), skill);
  await rideOut(page, undefined, "27-depart-truck", ["entry", "outskirts"]);
  await page.evaluate(() => window.advanceTime(1500));
  await draw(page);
  await page.screenshot({ path: `${out}/28-harbor-start.png` });
  const h = await read();
  if (h.region !== "harbor" || !(h.player.z < -400) || h.phase !== "play") errors.push(`harbor raid: started in ${h.region} at ${h.player.x},${h.player.z} (${h.phase})`);
  const lines = await page.evaluate(() => document.getElementById("obj-exits").children.length);
  if (lines !== 1) errors.push(`harbor raid: the objective card lists ${lines} ways out, not the boat alone`);
  console.log(`desktop harbor frame: ${JSON.stringify(await page.evaluate(() => window.ringfallFrameCost(20)))}`);
  await page.keyboard.press("KeyM");
  await page.evaluate(() => window.advanceTime(100));
  await page.screenshot({ path: `${out}/30-map-harbor.png` });
  await page.keyboard.press("KeyM");
  let fought = false;
  for (let i = 0; i < 3000 && !fought; i++) {
    const st = await quietStep(page, 100);
    if (st.phase !== "play") break;
    fought = st.enemies.filter((e) => e.aware === "engaged" && e.mode !== "spawning").length >= 1 && st.orbs >= 1;
    if ((i + 1) % DRAW_EVERY === 0) await draw(page);
  }
  await draw(page);
  await page.screenshot({ path: `${out}/31-harbor-fight.png` });
  const end = await read();
  console.log(`harbor raid: fought ${fought}, cleared ${end.stats.cleared.join(",") || "-"}, at ${end.player.x},${end.player.z}`);
  lap("harbor raid");
}
// The desktop page is done with; left open it draws the harbor every frame, and the pages
// below, each a fresh load, would share the machine with it.
await page.close();

/*
 * The hideout, from saved profiles: a mid-game base (the tab, a module's needs with where
 * they are found, building, the radio's report, the warning before selling a needed part)
 * on the desktop and a phone on its side.
 */
const bag = (list) => list.flatMap(([kind, n]) => Array.from({ length: n }, () => ({ t: "valuable", kind })));
const midGame = {
  v: 6, cash: 6400, raids: 14, extracted: 11, time: 9000, region: "reservoir", seed: 777, depots: ["quarry", "wreck"], seen: "",
  quests: { progress: {}, done: ["grunts", "village", "medbay", "parts"] },
  hideout: { infirmary: 1, workbench: 1, storage: 1, radio: 1, pouch: 1 },
  stash: [{ t: "weapon", kind: "pike", rarity: 1 }, { t: "heal", kind: "cell" }, ...bag([["fuse", 5], ["parts", 4], ["wire", 5], ["board", 4], ["drive", 1], ["gyro", 1]])],
};
/** The mid-game base holding the supply depot and the yard, whose depots open starts (`UNLOCKS`). */
const depotGame = {
  ...midGame, v: 13, day: 15, depots: ["supply", "yard"],
  poiState: { supply: { state: "freed" }, quarry: { state: "held" }, relay: { state: "held" }, pad: { state: "held" }, wreck: { state: "held" }, yard: { state: "freed" }, smelter: { state: "held" } },
};
const withProfile = async (ctx, profile) => {
  const pg = await ctx.newPage();
  pg.on("pageerror", (e) => errors.push(`hideout pageerror: ${e.message}`));
  pg.on("console", (m) => m.type() === "error" && !/fonts\.g|ERR_TUNNEL|net::/.test(m.text()) && errors.push(`hideout console: ${m.text()}`));
  await pg.addInitScript(([k, v]) => localStorage.setItem(k, v), [KEY, JSON.stringify(profile)]);
  await pg.goto(`http://localhost:${port}/ringfall/`, { waitUntil: "load" });
  await pg.waitForTimeout(300);
  return pg;
};
const readOf = async (pg) => JSON.parse(await pg.evaluate(() => window.render_game_to_text()));
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const pg = await withProfile(ctx, midGame);
  await toCamp(pg);
  // The stations with something to act on carry a mark over them: the workshop has a module to build, the map table the radio's report.
  const c0 = await readOf(pg);
  if (!c0.camp.marks.workshop || !c0.camp.marks.map) errors.push(`camp: the marks read ${JSON.stringify(c0.camp.marks)}`);
  await pg.evaluate(() => window.ringfallCamp.walkTo("map"));
  await pg.evaluate(() => window.advanceTime(100));
  await pg.screenshot({ path: `${out}/40-camp-marks.png` });
  // The radio (Lv1) names the POI whose bins lean rare in the next raid.
  await useStation(pg, "map");
  const intel = await pg.evaluate(() => document.querySelector("#hub-side .intel")?.textContent ?? "");
  await closePanel(pg);
  await useStation(pg, "workshop");
  const mods = await pg.locator("#hub-side .mod").count();
  if (mods !== 5) errors.push(`hideout: the tab lists ${mods} modules, not 5`);
  await pg.screenshot({ path: `${out}/40-hideout.png` });
  // The radio's top level lacks parts: each shows how many are short and where they are found.
  await pg.click('#hub-side [data-act=mod][data-arg=radio]');
  const hints = await pg.locator("#hub-side .mod.open .req small").allTextContents();
  if (hints.length < 2 || !hints.every((h) => /%/.test(h))) errors.push(`hideout: the radio's needs show no places to find them (${hints.join(" / ")})`);
  if (!(await pg.locator("#hub-side .mod.open .req:not(.ok)").count()) || !(await pg.locator("#hub-side .mod.open [data-act=build]").isDisabled())) errors.push("hideout: the radio's missing parts are not marked, or it can be built");
  await pg.screenshot({ path: `${out}/41-hideout-needs.png` });
  // Building the storage's next level takes its parts and makes room.
  const h0 = await readOf(pg);
  await pg.click('#hub-side [data-act=mod][data-arg=storage]');
  await pg.click('#hub-side [data-act=build][data-arg=storage]');
  const h1 = await readOf(pg);
  if (h1.profile.hideout.storage !== 2 || h1.profile.stash >= h0.profile.stash || !/\/ 60/.test(await pg.textContent("#hub-stash-count"))) errors.push(`hideout: building the storage left ${JSON.stringify(h1.profile)}`);
  await pg.screenshot({ path: `${out}/42-hideout-built.png` });
  // Selling a part the hideout still needs asks a second press.
  await closePanel(pg);
  await useStation(pg, "shop");
  const board = pg.locator("#hub-stash [data-act=sell]", { hasText: "回路基板" });
  await board.click();
  const warned = await pg.locator("#hub-stash .warn").count();
  const h2 = await readOf(pg);
  if (!warned || h2.profile.stash !== h1.profile.stash) errors.push("hideout: a needed board was sold without a warning");
  await pg.screenshot({ path: `${out}/43-hub-sell-warn.png` });
  await board.click();
  if ((await readOf(pg)).profile.stash !== h1.profile.stash - 1) errors.push("hideout: the second press did not sell the board");
  // The starter weapons stand at the head of the stash with their pins, and the trader buys neither: no button, no price.
  const pinned = await pg.evaluate(() => [...document.querySelectorAll("#hub-stash .item")].filter((e) => e.querySelector(".starter")).map((e) => ({ button: e.tagName === "BUTTON", price: /売る/.test(e.textContent ?? "") })));
  if (pinned.length !== 2 || pinned.some((x) => x.button || x.price)) errors.push(`hideout: the trader's side shows the starter weapons as ${JSON.stringify(pinned)}`);
  await pg.locator("#hub-stash .item", { has: pg.locator(".starter") }).first().click({ force: true });
  if ((await readOf(pg)).profile.stash !== h1.profile.stash - 1) errors.push("hideout: clicking a starter weapon at the trader sold it");
  await pg.screenshot({ path: `${out}/43-hub-shop-starters.png` });
  // The raid walked out to next is the one the radio told of.
  await closePanel(pg);
  await useStation(pg, "stash");
  // With no last raid's loadout the shelves pick the starter weapons, each marked with its pin.
  const picked = (await readOf(pg)).camp.weapons;
  if (picked.length !== 2 || !picked.every((w) => w.starter) || (await pg.locator("#hub-side .slot .starter").count()) !== 2) errors.push(`camp: the shelves picked ${JSON.stringify(picked)}, not the two starter weapons with their pins`);
  await pg.screenshot({ path: `${out}/44-shelves-starters.png` });
  await closePanel(pg);
  const raid = await walkOutOfGate(pg);
  if (!intel.includes(raid.boost.name)) errors.push(`hideout: the radio said "${intel}", the raid boosts ${raid.boost.name}`);
  await ctx.close();
  lap("hideout");
}
{
  const ctx = await browser.newContext({ viewport: { width: 740, height: 360 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  // An epic armour in the stash, for the departure past a depot's allowance below.
  const pg = await withProfile(ctx, { ...depotGame, stash: [...midGame.stash, { t: "armor", tier: 2 }] });
  await toCamp(pg, true);
  const cdp = await ctx.newCDPSession(pg);
  await useStation(pg, "workshop", cdp);
  await pg.waitForTimeout(100);
  let fit = await spills(pg);
  await pg.screenshot({ path: `${out}/m10-hideout.png` });
  await pg.tap('#hub-side [data-act=mod][data-arg=pouch]');
  await pg.locator("#hub-side .mod.open").scrollIntoViewIfNeeded();
  fit = fit.concat(await spills(pg));
  await pg.screenshot({ path: `${out}/m11-hideout-module.png` });
  await closePanel(pg, true);
  await useStation(pg, "map", cdp);
  fit = fit.concat(await spills(pg));
  await pg.screenshot({ path: `${out}/m12-map-intel.png` });
  await closePanel(pg, true);
  // The departure holds the depots too, tapped on its map, and stays inside the screen.
  await useStation(pg, "vehicle", cdp);
  await departUp(pg);
  await pickStart(pg, "depot", "yard", true);
  fit = fit.concat(await departFits(pg));
  await pg.screenshot({ path: `${out}/m14-depart-depot.png` });
  await pg.tap("#depart-cancel");
  // The rare PIKE and an epic armour are past a level 0 depot's allowance: the yard's boxes turn red and the confirm is shut.
  await useStation(pg, "stash", cdp);
  await pg.locator("#hub-stash [data-act=pick]", { hasText: "PIKE レア" }).tap();
  await pg.locator("#hub-stash [data-act=pick]", { hasText: "アーマー" }).tap();
  await closePanel(pg, true);
  await useStation(pg, "vehicle", cdp);
  await departUp(pg);
  const overM = (await readOf(pg)).camp.depart;
  if (overM?.start?.id !== "yard" || !overM.refused || !(await pg.locator("#depart-go:disabled").count()) || !(await pg.locator("#depart-points button.pick.on.over .mini i.over").count())) errors.push(`mobile depot: over the allowance the departure reads ${JSON.stringify(overM?.start)} refused "${overM?.refused}"`);
  fit = fit.concat(await departFits(pg));
  await pg.screenshot({ path: `${out}/m14-depart-over.png` });
  await pg.tap("#depart-go", { force: true });
  if ((await readOf(pg)).screen !== "camp") errors.push("mobile depot: the shut confirm still departed");
  await pg.tap("#depart-cancel");
  await useStation(pg, "shop", cdp);
  fit = fit.concat(await spills(pg));
  await pg.screenshot({ path: `${out}/m15-panel-shop.png` });
  if (fit.length) errors.push(`hideout on a phone: ${[...new Set(fit)].join(", ")} (740x360)`);
  await ctx.close();
  lap("hideout, phone");
}
/*
 * The board some days in, from a saved profile: the intro quests done, two records home and their
 * text on the board, a contract to free a POI taken, on the desktop and a phone on its side.
 */
{
  const storyGame = {
    v: 14, cash: 3200, stash: [], raids: 8, extracted: 6, time: 4000, region: "reservoir", entry: "beach", entries: ["beach", "checkpoint", "jetty", "outskirts", "quay", "shore"], seed: 4321, day: 9,
    quests: { progress: {}, done: ["grunts", "village", "power", "parts"] },
    hideout: { generator: 1, infirmary: 1, workbench: 0, storage: 0, radio: 0, pouch: 0, craft: 0 },
    records: ["tether", "dam"],
  };
  for (const phone of [false, true]) {
    const ctx = await browser.newContext(phone ? { viewport: { width: 740, height: 360 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 720 } });
    const pg = await withProfile(ctx, storyGame);
    await toCamp(pg, phone);
    const cdp = phone ? await ctx.newCDPSession(pg) : undefined;
    await useStation(pg, "quests", cdp);
    const intro = await pg.locator("#hub-side .quest:not(.contract):not(.story)").count();
    const told = await pg.locator("#hub-side details.told").count();
    const now = await pg.textContent("#hub-side .quest.story strong");
    if (told !== 2 || !/最後の船/.test(now)) errors.push(`board: with two records home it shows ${told} told and "${now}" under way`);
    const sel = "#hub-side .quest.contract[data-type=free] [data-act=take]";
    await (phone ? pg.tap(sel) : pg.click(sel));
    const st = await readOf(pg);
    if (st.camp.board.find((c) => c.id === st.camp.taken)?.t !== "free") errors.push(`board: taking the free contract left ${JSON.stringify(st.camp)}`);
    let fit = await spills(pg);
    await pg.screenshot({ path: `${out}/${phone ? "m16" : "50"}-board.png` });
    await pg.locator("#hub-side details.told[open]").scrollIntoViewIfNeeded();
    fit = fit.concat(await spills(pg));
    await pg.screenshot({ path: `${out}/${phone ? "m16" : "50"}-board-story.png` });
    // The map table marks the taken contract's POI on the island.
    await closePanel(pg, phone);
    await useStation(pg, "map", cdp);
    if (!(await pg.locator("#hub-side .hub-taken").count())) errors.push("board: the map table does not name the contract taken");
    fit = fit.concat(await spills(pg));
    await pg.screenshot({ path: `${out}/${phone ? "m16" : "50"}-map-contract.png` });
    if (fit.length) errors.push(`board${phone ? " on a phone" : ""}: ${[...new Set(fit)].join(", ")}`);
    await ctx.close();
  }
  lap("board");
}

/*
 * A depot: the base offers the depots on as starts, the raid begins on the ground beside one
 * with its prompt, the map lies under fog except round where the player has been, and leaving
 * there ends the raid as extracted at that depot.
 */
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  // An epic armour in the stash: with the rare PIKE (2) it is over a level 0 depot's allowance (2).
  const pg = await withProfile(ctx, { ...depotGame, stash: [...midGame.stash, { t: "armor", tier: 2 }] });
  await toCamp(pg);
  // The departure from the truck offers the two depots that open a start; the supply depot is chosen and the departure cancelled.
  await useStation(pg, "vehicle");
  await departUp(pg);
  const starts = await pg.locator("#depart-points button.pick.depot:not(:disabled)").count();
  if (starts !== 2) errors.push(`depot: the departure offers ${starts} depots to start from, not 2`);
  await pickStart(pg, "depot", "supply");
  await pg.screenshot({ path: `${out}/46-depart-depot.png` });
  await pg.keyboard.press("Escape");
  // The depot's allowance: the PIKE fits it, the armour on top does not (the departure refuses), and a start at a way in lifts the limit.
  const allowance = () => pg.evaluate(() => document.querySelector("#hub-side .slot.depot")?.textContent ?? "");
  const refused = async () => (await readOf(pg)).camp.ride.refused;
  await useStation(pg, "stash");
  await pg.locator("#hub-stash [data-act=pick]", { hasText: "PIKE レア" }).click();
  const fits = await allowance();
  if (!/Lv0/.test(fits) || !/2 \/ 2/.test(fits) || !/1,500/.test(fits) || (await refused())) errors.push(`depot: with the PIKE the allowance reads "${fits}", the departure ${(await refused()) || "goes"}`);
  await pg.screenshot({ path: `${out}/46-stash-depot-budget.png` });
  await pg.locator("#hub-stash [data-act=pick]", { hasText: "アーマー" }).click();
  const over = await allowance();
  if (!/4 \/ 2/.test(over) || !/持ち込み枠/.test(await refused())) errors.push(`depot: over the allowance it reads "${over}" and the departure ${(await refused()) || "goes"}`);
  await pg.screenshot({ path: `${out}/46-stash-depot-over.png` });
  await closePanel(pg);
  // Over the allowance the departure opens on the depot in red, its confirm shut: Enter stays in the camp.
  await useStation(pg, "vehicle");
  await departUp(pg);
  const overD = (await readOf(pg)).camp.depart;
  const red = await pg.locator("#depart-points button.pick.on.over .mini i.over").count();
  if (overD?.start?.id !== "supply" || !overD.refused || red !== 2 || !(await pg.locator("#depart-go:disabled").count()) || !(await pg.locator("#depart-carry .depart-carry.over").count())) errors.push(`depot: over the allowance the departure reads ${JSON.stringify(overD?.start)} refused "${overD?.refused}", ${red} red boxes`);
  await pg.screenshot({ path: `${out}/46-depart-over.png` });
  await pg.keyboard.press("Enter");
  await pg.evaluate(() => window.advanceTime(100));
  await pg.waitForTimeout(500);
  if ((await readOf(pg)).screen !== "camp" || !(await readOf(pg)).camp.depart) errors.push(`depot: over the allowance Enter left ${(await readOf(pg)).screen}`);
  // A way in lifts the limit: no boxes, the confirm open.
  const toWay = await pickStart(pg, "entry", "beach");
  if (toWay?.refused || (await pg.locator("#depart-carry .depart-carry").count()) || (await pg.locator("#depart-go:disabled").count())) errors.push("depot: choosing a way in did not lift the allowance");
  await pg.screenshot({ path: `${out}/46-depart-entry.png` });
  await pickStart(pg, "depot", "supply");
  await pg.keyboard.press("Escape");
  await useStation(pg, "stash");
  // The rare PIKE and the armour put back: the starter TALON alone costs nothing.
  await pg.locator("#hub-stash [data-act=pick]", { hasText: "PIKE レア" }).click();
  await pg.locator("#hub-stash [data-act=pick]", { hasText: "アーマー" }).click();
  await closePanel(pg);
  await rideOut(pg);
  await pg.evaluate(() => window.advanceTime(500));
  const d0 = await readOf(pg);
  if (d0.screen !== "game" || d0.phase !== "play" || d0.region !== "reservoir" || !d0.ally.active) errors.push(`depot: starting at the supply depot left ${d0.screen} ${d0.phase} in ${d0.region}, ally ${d0.ally.active}`);
  const prompt = await pg.textContent("#prompt");
  if (!/切り上げる/.test(prompt)) errors.push(`depot: standing at it with an empty bag prompts "${prompt}"`);
  await pg.screenshot({ path: `${out}/47-depot.png` });
  await pg.keyboard.press("KeyE");
  await pg.evaluate(() => window.advanceTime(1000));
  const d1 = await readOf(pg);
  if (d1.leaving === null) errors.push(`depot: the use key did not start leaving (${d1.phase})`);
  await pg.screenshot({ path: `${out}/48-depot-leaving.png` });
  // The map, once the start's banner is gone; leaving goes on under it.
  await pg.keyboard.press("KeyM");
  await pg.evaluate(() => window.advanceTime(1000));
  const cells = d1.seenCells;
  if (!(cells > 0 && cells <= 9)) errors.push(`depot: a fresh map has ${cells} cells explored, not the few round the start`);
  await pg.screenshot({ path: `${out}/49-map-fog.png` });
  await pg.keyboard.press("KeyM");
  await pg.evaluate(() => window.advanceTime(4000));
  await pg.waitForFunction(() => !document.getElementById("results").hidden, null, { timeout: 10000 }).catch(() => undefined);
  const d2 = await readOf(pg);
  if (d2.outcome !== "extracted" || d2.leftAt !== "supply" || d2.screen !== "results") errors.push(`depot: leaving ended ${d2.outcome} at ${d2.leftAt} on ${d2.screen}`);
  if (!/中継ボックス/.test(await pg.textContent("#stats"))) errors.push("depot: the results do not say the raid ended at the depot");
  await pg.screenshot({ path: `${out}/50-results-depot.png` });
  await ctx.close();
  lap("depot");
}
/*
 * The routes a tool opens: listed under the hideout, closed (the obstacle, its prompt naming the
 * tool, the map's dashed line) and then open in a profile that has them all (the tunnel walked
 * through on the keyboard, the dam's gallery and the gangway seen from inside, the map's lines).
 */
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const pg = await withProfile(ctx, { ...midGame, v: 9, routes: [] });
  await toCamp(pg);
  await useStation(pg, "workshop");
  // A shut route: the map's dashed line, a padlock, the tool that opens it and the POI whose bins hold it.
  const shut = await pg.evaluate(() => [...document.querySelectorAll("#hub-side .quest.route:not(.open)")].map((r) => (r.querySelector(".ico.route.shut") && r.querySelector(".ico.lock") ? "🔒" : "") + r.textContent));
  if (shut.length !== 3 || !shut.every((t) => /^🔒.*(キット|カッター).*(採掘場|コンテナヤード)/.test(t))) errors.push(`routes: the hideout lists ${JSON.stringify(shut)}`);
  await pg.locator("#hub-side .route").first().scrollIntoViewIfNeeded();
  await pg.screenshot({ path: `${out}/51-workshop-routes.png` });
  await closePanel(pg);
  await walkOutOfGate(pg);
  await pg.evaluate(() => window.advanceTime(3000));
  // Before the dam's gallery door, facing it.
  await pg.evaluate(() => {
    const h = window.ringfallFrames()["area:heart"];
    window.ringfallPlace(20 + h.x, -102.6 + h.z, 0);
  });
  await pg.evaluate(() => window.advanceTime(300));
  const prompt = await pg.textContent("#prompt");
  const padlock = await pg.locator("#prompt .ico.lock").count();
  if (!/ダムの点検通路/.test(prompt) || !/ボルトカッター/.test(prompt) || !padlock) errors.push(`routes: before the dam's door the prompt reads "${prompt}" (${padlock} padlocks)`);
  await pg.screenshot({ path: `${out}/52-route-closed.png` });
  await pg.keyboard.press("KeyM");
  await pg.evaluate(() => window.advanceTime(200));
  await pg.screenshot({ path: `${out}/53-map-routes.png` });
  await pg.keyboard.press("KeyM");
  await ctx.close();
}
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const pg = await withProfile(ctx, { ...midGame, v: 9, routes: ["tunnel", "dam", "gangway"] });
  await toCamp(pg);
  await useStation(pg, "workshop");
  const open = await pg.evaluate(() => [...document.querySelectorAll("#hub-side .quest.route")].map((r) => (r.classList.contains("open") && r.querySelector(".ico.route.open") && !r.querySelector(".ico.lock") ? "" : "shut:") + r.textContent));
  if (open.length !== 3 || open.some((t) => t.startsWith("shut:"))) errors.push(`routes: with every route open the hideout lists ${JSON.stringify(open)}`);
  await closePanel(pg);
  await walkOutOfGate(pg);
  await pg.evaluate(() => window.advanceTime(3000));
  const r = await readOf(pg);
  if (r.routes.join() !== "tunnel,dam,gangway") errors.push(`routes: the raid's world has ${r.routes.join() || "none"} open`);
  // Inside, from fixed cameras: the tunnel under the mountains, the gallery climbing through the dam, the gangway.
  const fr = await pg.evaluate(() => window.ringfallFrames());
  const views = [
    ["54-tunnel-open", 40, 1.6, -306, 0, 0.05],
    ["55-dam-gallery-open", 20 + fr["area:heart"].x, 1.6, -101 + fr["area:heart"].z, 0, 0.32],
    ["56-gangway-open", -40 + fr.wreck.x, 1.7, -31 + fr.wreck.z, Math.PI - 0.6, 0.35],
  ];
  for (const [name, x, dy, z, yaw, pitch] of views) {
    const y = (await pg.evaluate(([x, z]) => window.ringfallTerrain(x, z), [x, z])) + dy;
    await pg.evaluate(([x, y, z, yaw, pitch]) => window.ringfallCamera(x, y, z, yaw, pitch), [x, y, z, yaw, pitch]);
    await pg.screenshot({ path: `${out}/${name}.png` });
  }
  await pg.evaluate(() => window.ringfallCamera());
  // Walked on the keyboard from the tunnel's south mouth to its north one.
  await pg.evaluate(() => window.ringfallPlace(40, -268, 0));
  await pg.keyboard.down("KeyW");
  for (let i = 0; i < 40 && (await readOf(pg)).player.z > -430; i++) await pg.evaluate(() => window.advanceTime(1000));
  await pg.keyboard.up("KeyW");
  const through = await readOf(pg);
  if (through.player.z > -430 || Math.abs(through.player.x - 40) > 3) errors.push(`routes: walking the open tunnel ended at ${through.player.x},${through.player.z}`);
  await pg.screenshot({ path: `${out}/57-tunnel-walked.png` });
  await pg.keyboard.press("KeyM");
  await pg.evaluate(() => window.advanceTime(200));
  await pg.screenshot({ path: `${out}/58-map-routes-open.png` });
  await ctx.close();
}
/*
 * The island's state, from a profile saved before the six-node island on day 6: the supply depot
 * and the wreck freed, the quarry thin, which loads as three nodes the player's. The camp's line
 * of the day and the map table fill three of the row's six marks, the raid's map paints the
 * player's ground blue and the enemy's red with the front between, the HUD's row under the
 * compass shows the same, and coming home ends the day on the results' map.
 */
const islandDay = {
  v: 13, cash: 2400, stash: [], raids: 5, extracted: 4, time: 3600, region: "reservoir", entry: "beach", seed: 4242, escaped: null,
  entries: ["beach", "checkpoint", "jetty", "outskirts", "quay", "shore"], depots: ["supply", "wreck"], seen: "f".repeat(4000),
  quests: { progress: {}, done: [] }, day: 6,
  poiState: { supply: { state: "freed", lastVisit: 3 }, quarry: { state: "thin", lastVisit: 4 }, relay: { state: "held", lastVisit: 0 }, pad: { state: "held", lastVisit: 0 }, wreck: { state: "freed", lastVisit: 5 }, yard: { state: "held", lastVisit: 0 }, smelter: { state: "held", lastVisit: 0 } },
};
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const pg = await withProfile(ctx, islandDay);
  await toCamp(pg);
  const c = await readOf(pg);
  // The player's count at the tug of war's blue end.
  const own = async (sel) => Number((await pg.locator(`${sel} .tug-n.own`).first().textContent().catch(() => "-1")) ?? -1);
  // The nodes a profile holds: the day's battle, reckoned to its end, may have taken some back.
  const mine = (p) => Object.entries(p.poiState).filter(([id, o]) => id !== "pad" && o.state === "freed").length;
  if (c.profile.day !== 6 || c.profile.poiState.quarry.state !== "freed" || (await own("#camp-row")) !== 3) errors.push(`island: the camp reads day ${c.profile.day}, the quarry ${c.profile.poiState.quarry.state}, ${await own("#camp-row")} of the row filled`);
  await pg.evaluate(() => window.ringfallCamp.walkTo("map"));
  await pg.evaluate(() => window.advanceTime(100));
  await pg.screenshot({ path: `${out}/70-island-camp-row.png` });
  await useStation(pg, "map");
  await pg.waitForTimeout(300);
  if ((await own("#hub-side .hub-row")) !== 3 || (await pg.locator("#hub-side .tomorrow, #hub-side .hub-net, #hub-side .score-days").count())) errors.push(`island: the map table fills ${await own("#hub-side .hub-row")} of the row, or still shows the network or the battles`);
  const fit = await spills(pg);
  if (fit.length) errors.push(`island map table (1280x720): ${fit.join(", ")}`);
  await pg.screenshot({ path: `${out}/71-island-panel.png` });
  await closePanel(pg);
  const run = await walkOutOfGate(pg);
  const at = (id) => run.enemies.filter((e) => run.squads[e.squad].poi === id).length;
  if (run.hold.join() !== "freed,freed,held,held,freed,held,held,held,held,held,held,held" || at(0) !== 0 || at(1) !== 0 || at(4) !== 0 || !(at(2) > 0)) errors.push(`island raid: holds ${run.hold.join()}, robots at the supply depot ${at(0)}, the quarry ${at(1)}, the wreck ${at(4)}, the relay ${at(2)}`);
  // The way in's banner has gone by the time the map is opened; the HUD is drawn for the screenshot.
  await pg.evaluate(() => window.ringfallStep(4000));
  await pg.screenshot({ path: `${out}/72-island-hud-row.png`, clip: { x: 1280 / 2 - 260, y: 0, width: 520, height: 120 } });
  if ((await own("#island-row")) !== 3) errors.push(`island raid: the HUD's row fills ${await own("#island-row")}`);
  await pg.keyboard.press("KeyM");
  await pg.evaluate(() => window.advanceTime(100));
  await pg.screenshot({ path: `${out}/72-island-map.png` });
  await pg.keyboard.press("KeyN");
  await pg.evaluate(() => window.advanceTime(100));
  await pg.screenshot({ path: `${out}/73-island-map-whole.png` });
  await pg.keyboard.press("KeyN");
  await pg.keyboard.press("KeyM");
  // Home again after time away: the raid ends alive, the day with it.
  await pg.evaluate(() => window.ringfallStep(7000));
  await pg.evaluate(() => {
    const m = window.ringfallCamp.spots().find((q) => q.id === "map");
    window.ringfallPlace(m.x + 7, m.z + 11, 0);
  });
  await pg.evaluate(() => window.advanceTime(200));
  await pg.waitForFunction(() => !document.getElementById("results").hidden, null, { timeout: 10000 }).catch(() => undefined);
  const r = await readOf(pg);
  await pg.waitForFunction(() => document.getElementById("day-beat")?.dataset.beat === "done", null, { timeout: 15000 }).catch(() => undefined);
  if (r.screen !== "results" || r.settled?.day !== 6 || r.profile.day !== 7 || (await own("#day-result")) !== mine(r.profile) || !(await pg.locator("#day-map").count())) errors.push(`island results: ${r.screen}, day ${r.settled?.day} -> ${r.profile.day}, ${await own("#day-result")} of the row filled for ${mine(r.profile)} nodes held`);
  await pg.waitForTimeout(1200);
  await pg.screenshot({ path: `${out}/74-island-results.png` });
  await pg.setViewportSize({ width: 740, height: 360 });
  await pg.waitForTimeout(300);
  await pg.screenshot({ path: `${out}/m20-island-results.png` });
  // Back in the camp after the results: the day's line and 今日の作戦, on the phone-sized screen.
  await pg.click("#restart");
  await faded(pg);
  const plan = await pg.textContent("#camp-plan");
  if (!/今日の作戦/.test(plan) || !/攻める拠点/.test(plan) || !/7 日目/.test(await pg.textContent("#camp-hint")) || (await own("#camp-row")) !== mine(r.profile)) errors.push(`island: the camp after the results reads "${plan}" / "${await pg.textContent("#camp-hint")}"`);
  await pg.screenshot({ path: `${out}/m20-camp-today.png` });
  await ctx.close();
}
{
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const pg = await withProfile(ctx, islandDay);
  await pg.evaluate(() => Object.defineProperty(screen, "orientation", { value: undefined, configurable: true }));
  await toCamp(pg, true);
  const cdp = await ctx.newCDPSession(pg);
  await useStation(pg, "map", cdp);
  await pg.waitForTimeout(300);
  const fit = await spills(pg);
  if (fit.length) errors.push(`island map table (phone): ${fit.join(", ")}`);
  await pg.screenshot({ path: `${out}/m21-island-panel.png` });
  await closePanel(pg, true);
  await rideOut(pg, cdp);
  await pg.evaluate(() => window.ringfallStep(4000));
  const bb = await pg.locator("#t-map").boundingBox();
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: bb.x + bb.width / 2, y: bb.y + bb.height / 2, id: 1 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await pg.evaluate(() => window.advanceTime(200));
  await pg.screenshot({ path: `${out}/m22-island-map.png` });
  await ctx.close();
}
lap("island");

/*
 * The island's events: the map table lists today's and tomorrow's (a debris fall, then a storm)
 * and its mark names tomorrow's; a debris fall's day puts the ring's piece, its crate and its
 * guards on the ground between and a mark on the map; a storm brings the fog in; a crews' visit
 * sends salvage crews to the bins. Phones look at the map table and the storm.
 */
{
  const evGame = (events) => ({
    v: 16, cash: 2400, stash: [], raids: 8, extracted: 6, time: 5000, region: "reservoir", entry: "beach", entries: ["beach", "checkpoint", "jetty", "outskirts", "quay", "shore"], seed: 2468, day: 9,
    network: 2, pressure: 0.5, depots: ["supply"], events,
    quests: { progress: {}, done: ["grunts", "village", "power", "parts"] },
    hideout: { generator: 1, infirmary: 1, workbench: 0, storage: 0, radio: 0, pouch: 0, craft: 0 },
    records: [],
    poiState: { supply: { state: "freed", lastVisit: 8, since: 0 } },
  });
  const raidOf = async (pg, phone, cdp) => {
    if (phone) await rideOut(pg, cdp);
    else await walkOutOfGate(pg);
    await pg.evaluate(() => window.ringfallStep(3000));
    return readOf(pg);
  };
  // The map table, today a debris fall and tomorrow a storm.
  for (const phone of [false, true]) {
    const ctx = await browser.newContext(phone ? { viewport: { width: 740, height: 360 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 720 } });
    const pg = await withProfile(ctx, evGame([{ t: "debris", spot: "southwest" }, { t: "storm" }]));
    await toCamp(pg, phone);
    const cdp = phone ? await ctx.newCDPSession(pg) : undefined;
    const c0 = await readOf(pg);
    if (!/明日 嵐/.test(c0.camp?.marks.map ?? "")) errors.push(`events: the map table's mark reads "${c0.camp?.marks.map}"`);
    await useStation(pg, "map", cdp);
    const list = await pg.textContent("#hub-side .events");
    if (!/破片の落下/.test(list) || !/南西の野/.test(list) || !/嵐/.test(list) || (await pg.locator("#hub-side .events .ev-icon").count()) !== 2) errors.push(`events: the map table lists "${list}"`);
    const fit = await spills(pg);
    if (fit.length) errors.push(`events map table${phone ? " on a phone" : ""}: ${[...new Set(fit)].join(", ")}`);
    await pg.locator("#hub-side .events").scrollIntoViewIfNeeded();
    await pg.screenshot({ path: `${out}/${phone ? "m23" : "57"}-map-events.png` });
    await closePanel(pg, phone);
    if (!phone) {
      // The debris fall in the raid: the crate and its guards at the spot, the wreck beside it, a mark on the map.
      const r = await raidOf(pg, phone, cdp);
      if (r.event?.t !== "debris" || !r.debris || Math.hypot(r.debris.x + 200, r.debris.z - 400) > 1) errors.push(`events: the debris raid has ${JSON.stringify({ event: r.event, debris: r.debris })}`);
      if (!/破片の落下/.test(await pg.textContent("#obj-event"))) errors.push("events: the objective card does not name the debris fall");
      await pg.keyboard.press("KeyM");
      await pg.evaluate(() => window.advanceTime(100));
      await pg.screenshot({ path: `${out}/59-map-debris.png` });
      await pg.keyboard.press("KeyM");
      const d = r.debris;
      const [vx, vz] = [d.x + 20, d.z - 18];
      const yaw = Math.atan2(d.x - 5 - vx, -(d.z + 6 - vz));
      await pg.evaluate(([x, z, w]) => window.ringfallPlace(x, z, w), [vx, vz, yaw]);
      for (let i = 0; i < 40; i++) await pg.evaluate(() => window.advanceTime(100));
      await pg.evaluate(([x, z, w]) => window.ringfallCamera(x, window.ringfallTerrain(x, z) + 5, z, w, -0.1), [vx, vz, yaw]);
      await draw(pg);
      await pg.screenshot({ path: `${out}/58-debris.png` });
      await pg.evaluate(() => window.ringfallCamera());
    }
    await ctx.close();
  }
  // A storm: the fog in close and the light grey, in the robots' sight as in the view.
  for (const phone of [false, true]) {
    const ctx = await browser.newContext(phone ? { viewport: { width: 740, height: 360 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 720 } });
    const pg = await withProfile(ctx, evGame([{ t: "storm" }, null]));
    await toCamp(pg, phone);
    const cdp = phone ? await ctx.newCDPSession(pg) : undefined;
    const r = await raidOf(pg, phone, cdp);
    if (!r.storm) errors.push(`events: the storm raid is not stormy (${JSON.stringify(r.event)})`);
    await pg.evaluate(() => window.advanceTime(500));
    await pg.screenshot({ path: `${out}/${phone ? "m24" : "60"}-storm.png` });
    await ctx.close();
  }
  // A crews' visit: the intercept names the salvage crews; one of them is caught searching a bin.
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const pg = await withProfile(ctx, evGame([{ t: "crews" }, null]));
    await toCamp(pg);
    const id = await pg.evaluate(() => window.ringfallContract.take("intercept"));
    if (!id) errors.push("events: a crews' visit offers no intercept");
    const r0 = await raidOf(pg, false);
    if (!/回収部隊/.test(r0.contract?.line ?? "")) errors.push(`events: the intercept taken on a crews' visit reads ${JSON.stringify(r0.contract)}`);
    const st = await stepWhile(pg, 500, 900, (x) => x.phase === "play" && !x.crews.some((c) => c.searching && c.members.length));
    const c = st.crews.find((q) => q.searching && q.members.length);
    if (!c) errors.push(`events: no salvage crew searched a bin (${JSON.stringify(st.crews)})`);
    else {
      const b = c.bin;
      const m = c.members[0];
      const dx = m.x - b.x;
      const dz = m.z - b.z;
      const len = Math.hypot(dx, dz) || 1;
      // From the bin's side away from the crew, 10 m back and raised, looking at both.
      const vx = b.x - (dx / len) * 10 + 3;
      const vz = b.z - (dz / len) * 10 + 3;
      const yaw = Math.atan2((b.x + m.x) / 2 - vx, -((b.z + m.z) / 2 - vz));
      await pg.evaluate(([x, z, w]) => window.ringfallCamera(x, window.ringfallTerrain(x, z) + 3.5, z, w, -0.18), [vx, vz, yaw]);
      await draw(pg);
      await pg.screenshot({ path: `${out}/61-crew-loot.png` });
      await pg.evaluate(() => window.ringfallCamera());
      console.log(`crew: searching at ${b.x},${b.z} with bag ${c.bag.join(",") || "-"} at ${st.time} s`);
    }
    await ctx.close();
  }
  lap("events");
}
/*
 * Mod parts and the 強度. A contract taken on the board is given 強度 3 (desktop and phone), which
 * the raid plays at and the objective card names, and the map marks each POI's best; three
 * parts worn show on the HUD (desktop and phone), the vitals still clear of the objective card;
 * a part on the ground is drawn and named by the prompt, and the use key swaps it in for the
 * oldest; home alive, the results offer the parts for analysis, and analysing one learns its kind.
 */
{
  const modGame = {
    v: 17, cash: 2400, stash: [], raids: 8, extracted: 6, time: 5000, region: "reservoir", entry: "beach", entries: ["beach", "checkpoint", "jetty", "outskirts", "quay", "shore"], seed: 2468, day: 9,
    network: 2, pressure: 0.5, depots: ["supply"], events: [null, null], threat: 0, known: ["leech", "hush", "grip", "medic", "probe", "damper"], freedAt: { supply: 3 },
    quests: { progress: {}, done: ["grunts", "village", "power", "parts"] },
    hideout: { generator: 1, infirmary: 1, workbench: 0, storage: 0, radio: 0, pouch: 0, craft: 0 },
    records: [],
    poiState: { supply: { state: "freed", lastVisit: 8, since: 0 } },
  };
  const overlap = (pg) =>
    pg.evaluate(() => {
      const a = document.getElementById("objective").getBoundingClientRect();
      const b = document.getElementById("vitals").getBoundingClientRect();
      const m = document.getElementById("mods").getBoundingClientRect();
      const out = [];
      if (a.bottom > b.top && a.top < b.bottom && a.right > b.left && a.left < b.right) out.push(`the objective card (to ${Math.round(a.bottom)}) runs into the vitals (from ${Math.round(b.top)})`);
      if (m.right > b.right + 1 || m.left < b.left - 1) out.push("the mod chips spill out of the vitals");
      for (const i of document.querySelectorAll("#mods i")) if (i.scrollWidth > i.clientWidth + 1 && !/…/.test(i.textContent)) out.push(`the chip "${i.textContent}" is cut`);
      return out;
    });
  for (const phone of [false, true]) {
    const tag = (d, m) => `${out}/${phone ? m : d}`;
    const ctx = await browser.newContext(phone ? { viewport: { width: 740, height: 360 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 720 } });
    const pg = await withProfile(ctx, modGame);
    await toCamp(pg, phone);
    const cdp = phone ? await ctx.newCDPSession(pg) : undefined;
    // The 強度 is chosen for a contract on the board: the taken card offers it, what it gives first.
    await useStation(pg, "quests", cdp);
    const first = "#hub-side .quest.contract [data-act=take]";
    await (phone ? pg.tap(first) : pg.click(first));
    const pick = "#hub-side .quest.contract.taken .strength [data-act=strength][data-arg$=':3']";
    await (phone ? pg.tap(pick) : pg.click(pick));
    await pg.waitForTimeout(100);
    const c1 = await readOf(pg);
    const text = await pg.textContent("#hub-side .quest.contract.taken");
    if (c1.profile.threat !== 3 || !c1.camp.taken || /網/.test(text) || !/補給所 3/.test(text) || !/報酬 ×/.test(text)) errors.push(`threat: the board's 強度 left ${c1.profile.threat} (taken ${c1.camp.taken}) and reads "${text}"`);
    const fit = await spills(pg);
    if (fit.length) errors.push(`board 強度${phone ? " on a phone" : ""}: ${[...new Set(fit)].join(", ")}`);
    await pg.locator("#hub-side .quest.contract.taken").scrollIntoViewIfNeeded();
    await pg.screenshot({ path: tag("80-board-strength.png", "m30-board-strength.png") });
    // The map table has no 強度 of its own; it marks each POI's best.
    await closePanel(pg, phone);
    await useStation(pg, "map", cdp);
    if (await pg.locator("#hub-side .hub-threat, #hub-side [data-act=threat]").count()) errors.push("threat: the map table still offers a threat of its own");
    await pg.locator("#hub-island-map").scrollIntoViewIfNeeded();
    await pg.screenshot({ path: tag("80-map-threat-best.png", "m30-map-threat-best.png") });
    await closePanel(pg, phone);
    if (phone) await rideOut(pg, cdp);
    else await walkOutOfGate(pg);
    await pg.evaluate(() => window.ringfallStep(1500));
    const r0 = await readOf(pg);
    if (r0.threat !== 3 || !/強度 3/.test(await pg.textContent("#obj-raid"))) errors.push(`threat: the raid plays at ${r0.threat} and the card reads "${await pg.textContent("#obj-raid")}"`);
    await pg.evaluate(() => window.ringfallMods.wear(["leech", "scrambler", "capacitor"]));
    await pg.evaluate(() => window.advanceTime(100));
    const chips = await pg.locator("#mods i").allTextContents();
    if (chips.join() !== "コイル,撹乱器,アーク") errors.push(`mods: the HUD shows ${chips.join()}`);
    const lay = await overlap(pg);
    if (lay.length) errors.push(`mods HUD${phone ? " on a phone" : ""}: ${lay.join(", ")}`);
    await pg.screenshot({ path: tag("81-hud-mods.png", "m31-hud-mods.png") });
    if (!phone) {
      // A part on the ground before the player: its chip drawn and named by the prompt; the use key swaps it in.
      await pg.evaluate(() => window.ringfallMods.drop("deflector", 1.8));
      await pg.evaluate(() => window.advanceTime(300));
      const prompt = await pg.textContent("#prompt");
      const off = await pg.evaluate(() => document.querySelector("#prompt s")?.textContent ?? "");
      if (!/偏向膜/.test(prompt) || off !== "吸電コイル") errors.push(`mods: at a part on the ground the prompt reads "${prompt}", striking "${off}"`);
      // Looking down at the part from just behind the player: the chip and its beam, with the prompt.
      await pg.evaluate(() => {
        const st = JSON.parse(window.render_game_to_text()).player;
        const yaw = window.ringfallYaw();
        window.ringfallCamera(st.x - Math.sin(yaw) * 1.2, st.y + 2.2, st.z + Math.cos(yaw) * 1.2, yaw, -0.7);
      });
      await draw(pg);
      await pg.screenshot({ path: `${out}/82-mod-floor.png` });
      await pg.evaluate(() => window.ringfallCamera());
      await pg.keyboard.press("KeyE");
      await pg.evaluate(() => window.advanceTime(200));
      const r1 = await readOf(pg);
      if (r1.mods.join() !== "scrambler,capacitor,deflector" || !r1.modsAround.some((m) => m.mod === "leech")) errors.push(`mods: the use key left ${r1.mods.join()} worn and ${JSON.stringify(r1.modsAround)} on the ground`);
    }
    // Home through the camp's yard, alive with the parts: the results offer them for analysis.
    await pg.evaluate(() => window.ringfallStep(9000));
    await pg.evaluate(() => {
      const m = window.ringfallCamp.spots().find((q) => q.id === "map");
      window.ringfallPlace(m.x + 7, m.z + 11, 0);
    });
    await pg.evaluate(() => window.advanceTime(200));
    await pg.waitForFunction(() => !document.getElementById("results").hidden, null, { timeout: 10000 }).catch(() => undefined);
    const r2 = await readOf(pg);
    const cards = await pg.locator("#home .analyse [data-analyse]").count();
    if (r2.screen !== "results" || r2.settled?.threat !== 3 || r2.settled?.analysable?.length !== 3 || cards !== 3) errors.push(`mods: the results offer ${JSON.stringify(r2.settled && { threat: r2.settled.threat, analysable: r2.settled.analysable })} (${cards} cards)`);
    await pg.locator("#home .analyse").scrollIntoViewIfNeeded().catch(() => undefined);
    await pg.screenshot({ path: tag("83-results-analysis.png", "m33-results-analysis.png") });
    const card = "#home .analyse [data-analyse=scrambler]";
    await (phone ? pg.tap(card) : pg.click(card));
    await pg.waitForTimeout(100);
    const r3 = await readOf(pg);
    const after = await pg.textContent("#home .analyse");
    if (!r3.profile.known.includes("scrambler") || r3.settled?.analysed !== "scrambler" || !(await pg.locator("#home .analyse [data-analyse=scrambler].done").count()) || (await pg.locator("#home .analyse button:not([disabled])").count())) errors.push(`mods: analysing the scrambler left ${JSON.stringify({ known: r3.profile.known, analysed: r3.settled?.analysed })} "${after}"`);
    await pg.locator("#home .analyse").scrollIntoViewIfNeeded().catch(() => undefined);
    await pg.screenshot({ path: tag("84-results-analysed.png", "m34-results-analysed.png") });
    await ctx.close();
  }
  lap("mods");
}
console.log(`screens: ${[...taken].join(", ")}`);
/*
 * The day's battle (陣取り戦): a profile on day 9 with the supply depot and the quarry the
 * player's, the factory at level 3, saved with the last days' battles' points (dropped on load).
 * The factory's panel and the map table's row; out of the gate, the row under the compass, one
 * of the player's own squads fighting one of the enemy's in front of the player, and the battle
 * map with the squads, on the desktop and a phone on its side.
 */
/**
 * The battle as it is seen and heard (docs/ringfall/island-v2.md, 手触り), in a raid of the battle
 * day: a dropship coming down on the pad seen from afar, a column of the enemy's on its walk, a
 * core of the player's pulsing with the enemy's robots at it (and the red mark at the screen's
 * edge, then over the core, and the map's rings), the camp's gate lit as a column of the
 * factory's walks out, and the player's squads gathered round a core the player takes.
 */
async function warShots(pg, phone, tag) {
  const look = async (x, y, z, tx, ty, tz) => {
    const d = Math.hypot(tx - x, tz - z);
    await pg.evaluate(([cx, cy, cz, yaw, pitch]) => window.ringfallCamera(cx, cy, cz, yaw, pitch), [x, y, z, Math.atan2(tx - x, -(tz - z)), Math.atan2(ty - y, d)]);
  };
  const ground = (x, z) => pg.evaluate(([a, b]) => window.ringfallTerrain(a, b), [x, z]);
  const st0 = await readOf(pg);
  const idx = (id) => st0.front.cores.findIndex((c) => c.id === id);
  // Stand the player where the scene is drawn from, out of the robots' way.
  const stand = (x, z, yaw = 0) => pg.evaluate(([a, b, c]) => window.ringfallPlace(a, b, c), [x, z, yaw]);
  // 1. A dropship comes down on the pad, seen from the ground 220 m off.
  const land = await pg.evaluate(() => window.ringfallWar.land(false));
  if (!land) errors.push("war: no landing in a battle raid");
  else {
    const vx = land.x - 160;
    const vz = land.z + 150;
    await stand(vx, vz);
    await pg.evaluate(() => window.ringfallStep(7000));
    const gy = await ground(vx, vz);
    await look(vx, gy + 6, vz, land.x, gy + 60, land.z);
    await draw(pg);
    await pg.screenshot({ path: tag(0, "war-dropship-far") });
    const st = await readOf(pg);
    if (!st.battle.landings.some((l) => !l.boat && st.battle.now < l.down)) errors.push(`war: the dropship's landing is ${JSON.stringify(st.battle.landings)} at ${st.battle.now}`);
    await pg.evaluate(() => window.ringfallStep(9000));
    await draw(pg);
    await pg.screenshot({ path: tag(1, "war-dropship-down") });
  }
  // 2. A column of the enemy's on its walk from the pad to the quarry, seen from beside the way.
  const col = await pg.evaluate(([to]) => window.ringfallWar.march(1, ["grunt", "grunt", "grunt", "heavy"], -2, to, 140), [idx("quarry")]);
  if (!col) errors.push("war: no column set walking");
  else {
    await stand(col.x + 120, col.z + 110);
    await pg.evaluate(() => window.ringfallStep(8000));
    const st = await readOf(pg);
    const them = st.enemies.filter((e) => Math.hypot(e.x - col.x, e.z - col.z) < 40);
    const lead = them[0] ?? col;
    const back = them.at(-1) ?? col;
    const dx = lead.x - back.x;
    const dz = lead.z - back.z;
    const l = Math.hypot(dx, dz) || 1;
    // From the side of the column, a little ahead of its middle.
    const mx = (lead.x + back.x) / 2;
    const mz = (lead.z + back.z) / 2;
    const cx = mx - (dz / l) * 20 + (dx / l) * 12;
    const cz = mz + (dx / l) * 20 + (dz / l) * 12;
    const gy = await ground(cx, cz);
    await look(cx, gy + 11, cz, mx, (await ground(mx, mz)) + 1.2, mz);
    await draw(pg);
    await pg.screenshot({ path: tag(2, "war-column") });
    if (them.length < 4 || l < 6) errors.push(`war: the column is ${them.length} robots ${Math.round(l)} m long`);
  }
  await pg.evaluate(() => window.ringfallCamera());
  // 3. The enemy's robots at the quarry's core, the player's: the core pulses, a red mark at the screen's edge, rings on the map.
  const q = st0.front.cores[idx("quarry")];
  await pg.evaluate(([x, z]) => window.ringfallWar.place(1, ["grunt", "grunt", "heavy"], x, z), [q.x + 4, q.z + 3]);
  // The player 160 m off, facing away from it.
  await stand(q.x + 150, q.z + 60, Math.atan2(150, -60));
  await pg.evaluate(() => window.ringfallStep(2500));
  const th = await readOf(pg);
  if (!th.battle.threat.includes("quarry")) errors.push(`war: robots at the quarry's core set no threat (${JSON.stringify(th.battle.threat)})`);
  await draw(pg);
  await pg.screenshot({ path: tag(3, "war-threat-edge") });
  const mark = await pg.evaluate(() => [...document.querySelectorAll(".threat-mark")].filter((e) => e.style.display !== "none").map((e) => e.getBoundingClientRect()));
  if (mark.length !== 1) errors.push(`war: ${mark.length} threat marks on the screen`);
  await look(q.x + 26, q.y + 9, q.z + 30, q.x, q.y + 3, q.z);
  await pg.evaluate(() => window.advanceTime(400));
  await pg.screenshot({ path: tag(4, "war-threat-core") });
  await pg.evaluate(() => window.ringfallCamera());
  await pg.keyboard.press("KeyM");
  await pg.evaluate(() => window.advanceTime(300));
  await pg.screenshot({ path: tag(5, "war-threat-map") });
  await pg.keyboard.press("KeyM");
  // 4. The camp's gate lit as a squad of the factory's comes out, walking off in a column.
  const gate = await pg.evaluate(() => window.ringfallWar.point(-1));
  await stand(gate.x + 30, gate.z - 70);
  await pg.evaluate(() => window.ringfallWar.depart());
  await pg.evaluate(() => window.ringfallStep(2600));
  const gy = await ground(gate.x - 12, gate.z - 20);
  await look(gate.x - 12, gy + 4, gate.z - 20, gate.x, gy + 1.5, gate.z + 9);
  await pg.evaluate(() => window.advanceTime(300));
  await pg.screenshot({ path: tag(6, "war-gate") });
  const gs = await readOf(pg);
  if (!gs.battle.departs.some((d) => d.from === -1 && gs.battle.now - d.at < 8)) errors.push(`war: no squad came out of the gate (${JSON.stringify(gs.battle.departs)})`);
  // 5. The player takes a core of the front (the relay), and the squads near gather round it.
  const r = st0.front.cores[idx("relay")];
  // The player sets the capture going from down the road, its garrison already beaten; two squads of the player's come up and stand round the core.
  await pg.evaluate(([i]) => window.ringfallWar.clear(i), [idx("relay")]);
  await stand(r.x - 50, r.z + 60, Math.atan2(50, -60));
  await pg.evaluate(([x, z]) => {
    window.ringfallWar.place(0, ["grunt", "grunt", "heavy"], x - 40, z + 45, true);
    window.ringfallWar.place(0, ["grunt", "heavy", "drone"], x - 30, z + 55, true);
  }, [r.x, r.z]);
  await pg.evaluate(([i]) => window.ringfallWar.core(i), [idx("relay")]);
  let ga = await readOf(pg);
  const round = () => ga.battle.friends.filter((e) => !e.post && Math.hypot(e.x - r.x, e.z - r.z) < 22);
  for (let k = 0; k < 16 && round().length < 5; k++) {
    await pg.evaluate(([x, z]) => window.ringfallPlace(x, z, Math.atan2(50, -60)), [r.x - 50, r.z + 60]);
    ga = await quietStep(pg, 5000);
  }
  if (ga.battle.rally !== "relay" || round().length < 5) errors.push(`war: rallying to the relay (${ga.battle.rally}), ${round().length} of the player's robots round its core`);
  await look(r.x - 34, r.y + 9, r.z + 40, r.x, r.y + 1, r.z);
  await pg.evaluate(() => window.advanceTime(200));
  await pg.screenshot({ path: tag(7, "war-rally") });
  await pg.evaluate(() => window.ringfallCamera());
  console.log(`${phone ? "mobile" : "desktop"} war frame: ${JSON.stringify(await pg.evaluate(() => window.ringfallFrameCost(20)))}`);
}

const battleDay = {
  v: 19, cash: 26000, raids: 8, extracted: 6, time: 5400, region: "reservoir", entry: "beach", seed: 5151, escaped: null,
  stash: [{ t: "valuable", kind: "board" }, { t: "valuable", kind: "board" }, { t: "valuable", kind: "drive" }],
  entries: ["beach", "checkpoint", "jetty", "outskirts", "quay", "shore"], depots: ["supply", "quarry"], seen: "f".repeat(4000),
  quests: { progress: {}, done: [] }, day: 9, network: 1, factory: 3,
  poiState: { supply: { state: "freed", lastVisit: 8 }, quarry: { state: "freed", lastVisit: 8 }, relay: { state: "held", lastVisit: 0 }, pad: { state: "held", lastVisit: 0 }, wreck: { state: "held", lastVisit: 0 }, yard: { state: "held", lastVisit: 0 }, smelter: { state: "held", lastVisit: 0 } },
  scores: [
    { day: 4, score: [19800, 26400, 7100], won: false },
    { day: 5, score: [23900, 20200, 6800], won: true },
    { day: 6, score: [22100, 23300, 7500], won: false },
    { day: 7, score: [26800, 18100, 6600], won: true },
    { day: 8, score: [29400, 15900, 6200], won: true },
  ],
};
for (const phone of [false, true]) {
  const ctx = phone ? await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }) : await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const pg = await withProfile(ctx, battleDay);
  if (phone) await pg.evaluate(() => Object.defineProperty(screen, "orientation", { value: undefined, configurable: true }));
  const tag = (n, name) => `${out}/${phone ? `m${40 + n}` : `${90 + n}`}-${name}.png`;
  await toCamp(pg, phone);
  const cdp = phone ? await ctx.newCDPSession(pg) : undefined;
  const c = await readOf(pg);
  if (c.profile.factory !== 3 || "scores" in c.profile) errors.push(`battle: the camp reads the factory at ${c.profile.factory}, battles ${JSON.stringify(c.profile.scores)}`);
  if (!phone) {
    // The station from the yard: its container on the south fence, the blue robot by it, its name over it.
    await pg.evaluate(() => window.ringfallCamp.walkTo("factory"));
    const f = await pg.evaluate(() => window.ringfallCamp.spots().find((q) => q.id === "factory"));
    await pg.evaluate(([x, y, z]) => window.ringfallCamera(x, y, z, Math.PI, -0.18), [f.x + 1, f.y + 2.6, f.z - 8]);
    await pg.evaluate(() => window.advanceTime(100));
    await pg.screenshot({ path: tag(0, "camp-factory") });
    await pg.evaluate(() => window.ringfallCamera());
  }
  await useStation(pg, "factory", cdp);
  await pg.waitForTimeout(200);
  const panel = await pg.textContent("#hub-side");
  const build = await pg.textContent("#hub-side [data-act=factory]").catch(() => "");
  if (!/Lv3/.test(panel) || build !== "Lv4" || /陣取り戦|網/.test(panel)) errors.push(`battle: the factory's panel reads "${panel.slice(0, 200)}"`);
  const fit = await spills(pg);
  if (fit.length) errors.push(`battle factory panel (${phone ? "phone" : "1280x720"}): ${fit.join(", ")}`);
  await pg.screenshot({ path: tag(1, "panel-factory") });
  await closePanel(pg, phone);
  // The trader's shelf by the nodes held: the supply depot and the quarry light common, rare and epic.
  await useStation(pg, "shop", cdp);
  await pg.waitForTimeout(200);
  const lit = await pg.locator("#hub-side .shelf-tiers .tier.on").count();
  const epics = await pg.locator('#hub-side [data-act=buy]', { hasText: "エピック" }).count();
  const legends = await pg.locator('#hub-side [data-act=buy]', { hasText: "レジェンド" }).count();
  if (lit !== 3 || !epics || legends) errors.push(`battle: holding the supply depot and the quarry the shelf lights ${lit} rarities, sells ${epics} epic and ${legends} legendary things`);
  const fitShop = await spills(pg);
  if (fitShop.length) errors.push(`battle shop panel (${phone ? "phone" : "1280x720"}): ${fitShop.join(", ")}`);
  await pg.screenshot({ path: tag(8, "panel-shop-nodes") });
  await closePanel(pg, phone);
  await useStation(pg, "map", cdp);
  await pg.waitForTimeout(300);
  const tugOwn = async (sel) => Number((await pg.locator(`${sel} .tug-n.own`).first().textContent().catch(() => "-1")) ?? -1);
  if ((await tugOwn("#hub-side .hub-row")) !== 2) errors.push("battle: the map table's row does not fill the two nodes held");
  await pg.screenshot({ path: tag(2, "panel-map-row") });
  await closePanel(pg, phone);
  // The camp's line of the day, its row, and 今日の作戦.
  const today = await pg.textContent("#camp");
  if (!/9 日目/.test(today) || !/攻める拠点/.test(today) || (await tugOwn("#camp-row")) !== 2) errors.push(`battle: the camp's day reads "${today.slice(0, 300)}"`);
  await pg.screenshot({ path: tag(6, "camp-today") });
  const run = await walkOutOfGate(pg);
  if (!run.battle || run.battle.factory !== 3) errors.push(`battle: the raid out of the gate has ${JSON.stringify(run.battle && { factory: run.battle.factory })}`);
  // The way in's banner has gone; the turrets stand at the nodes the player holds.
  await pg.evaluate(() => window.ringfallStep(4000));
  // With no contract taken, the objective is the front, not the story record, which has a line of its own.
  const card = await pg.evaluate(() => ({ title: document.getElementById("obj-title").textContent, story: document.getElementById("obj-story").hidden ? "" : document.getElementById("obj-story").textContent }));
  if (/記録/.test(card.title) || !/(前線|陣取り戦|制圧)/.test(card.title) || !/記録/.test(card.story)) errors.push(`battle: with no contract the objective card reads ${JSON.stringify(card)}`);
  await draw(pg);
  await pg.screenshot({ path: tag(7, "objective-front") });
  const hud = await pg.evaluate(() => ({ own: Number(document.querySelector("#island-row .tug-n.own")?.textContent), all: document.querySelector("#island-row .tug")?.getAttribute("aria-label"), text: document.getElementById("island-row").textContent }));
  const deadline = await pg.evaluate(() => document.querySelector("#obj-raid .deadline .ico.clock") ? document.querySelector("#obj-raid .deadline").textContent : "");
  if (hud.own !== 2 || hud.all !== "2 / 11" || hud.text.trim() !== "29" || !/^\d+:\d\d$/.test(deadline)) errors.push(`battle: the HUD's row reads ${JSON.stringify(hud)}, the card "${deadline}"`);
  const st = await readOf(pg);
  if (st.battle.squads.filter((q) => q.side === 0).length < 2) errors.push(`battle: ${st.battle.squads.filter((q) => q.side === 0).length} of the player's squads at the start (the turrets at two nodes)`);
  // A fight in front of the player: the player's squad on the left, the enemy's on the right.
  const p = st.player;
  const yaw = await pg.evaluate(() => window.ringfallYaw());
  const fx = p.x + Math.sin(yaw) * 30;
  const fz = p.z - Math.cos(yaw) * 30;
  await pg.evaluate(([x, z]) => window.ringfallBattle(x, z, 22), [fx, fz]);
  const hp = (q) => q.battle.friends.reduce((n, e) => n + e.hp, 0) + q.enemies.filter((e) => Math.hypot(e.x - fx, e.z - fz) < 40).reduce((n, e) => n + e.hp, 0);
  const h0 = hp(await readOf(pg));
  await pg.evaluate(() => window.advanceTime(3200));
  await pg.screenshot({ path: tag(3, "battle-fight") });
  console.log(`${phone ? "mobile" : "desktop"} battle frame: ${JSON.stringify(await pg.evaluate(() => window.ringfallFrameCost(20)))}`);
  const after = await readOf(pg);
  if (!(hp(after) < h0)) errors.push(`battle: the player's squad and the enemy's did not fight (${h0} -> ${hp(after)})`);
  await pg.keyboard.press("KeyM");
  await pg.evaluate(() => window.advanceTime(100));
  await pg.screenshot({ path: tag(4, "battle-map") });
  await pg.keyboard.press("KeyN");
  await pg.evaluate(() => window.advanceTime(100));
  await pg.screenshot({ path: tag(5, "battle-map-whole") });
  await pg.keyboard.press("KeyN");
  await pg.keyboard.press("KeyM");
  lap(`battle, ${phone ? "phone" : "desktop"}`);
  await warShots(pg, phone, (n, name) => `${out}/${phone ? `m${50 + n}` : `${100 + n}`}-${name}.png`);
  lap(`war, ${phone ? "phone" : "desktop"}`);
  await ctx.close();
}

/*
 * The push and pull (docs/ringfall/island-v2.md, 押し合い), from a profile on day 12 holding the
 * supply depot, the quarry and the weather station (its seed one whose night takes some of them back): a node built on the open ground
 * (the waterworks) seen from its gate; the player takes it, and the enemy's counter-attack lands
 * and walks to it (the arrow at the screen's edge, the HUD's bar pulsing at its blue end, the
 * map's ring); the player leaves at the waterworks' depot with the counter-attack on its way;
 * and the results play the raid's change, the battle after the player left (the depot's mark)
 * and the night's attacks (the moon), the bar sliding at each.
 */
const pushDay = {
  v: 22, cash: 3000, raids: 11, extracted: 9, time: 6000, region: "reservoir", entry: "beach", seed: 5006, escaped: null,
  stash: [], entries: ["beach", "checkpoint", "jetty", "outskirts", "quay", "shore"], depots: ["supply", "quarry", "station"], seen: "f".repeat(4000),
  quests: { progress: {}, done: [] }, day: 12, factory: 0,
  poiState: { supply: { state: "freed" }, quarry: { state: "freed" }, station: { state: "freed" } },
};
for (const phone of [false, true]) {
  const ctx = phone ? await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }) : await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const pg = await withProfile(ctx, pushDay);
  if (phone) await pg.evaluate(() => Object.defineProperty(screen, "orientation", { value: undefined, configurable: true }));
  const tag = (n, name) => `${out}/${phone ? `m${80 + n}` : `${120 + n}`}-${name}.png`;
  await toCamp(pg, phone);
  if (!phone) {
    await pg.waitForTimeout(200);
    await pg.screenshot({ path: tag(9, "camp-bar") });
  }
  const run = await walkOutOfGate(pg);
  if (!run.battle) errors.push("push-pull: the raid has no battle");
  const look = async (x, y, z, tx, ty, tz) => {
    const d = Math.hypot(tx - x, tz - z);
    await pg.evaluate(([cx, cy, cz, yaw, pitch]) => window.ringfallCamera(cx, cy, cz, yaw, pitch), [x, y, z, Math.atan2(tx - x, -(tz - z)), Math.atan2(ty - y, d)]);
  };
  const ground = (x, z) => pg.evaluate(([a, b]) => window.ringfallTerrain(a, b), [x, z]);
  const stand = (x, z, yaw = 0) => pg.evaluate(([a, b, c]) => window.ringfallPlace(a, b, c), [x, z, yaw]);
  const W = run.front.cores.findIndex((c) => c.id === "waterworks");
  const core = run.front.cores[W];
  // 0. The waterworks, a node built on the open ground: its walled yard, tanks and pump hall from outside its south gate.
  await stand(core.x - 10, core.z + 75, 0);
  await pg.evaluate(() => window.ringfallStep(1500));
  const gy = await ground(core.x - 18, core.z + 62);
  await look(core.x - 18, gy + 14, core.z + 62, core.x, core.y + 2, core.z - 6);
  await draw(pg);
  await pg.screenshot({ path: tag(0, "node-waterworks") });
  await pg.evaluate(() => window.ringfallCamera());
  // 1. The player takes it; the counter-attack sets off at once and lands at the pad.
  await pg.evaluate(([i]) => window.ringfallWar.clear(i), [W]);
  await pg.evaluate(([i]) => window.ringfallWar.take(i, true), [W]);
  let st = await quietStep(pg, 1500);
  if (st.front.nodes[W] !== "freed" || !st.battle.counterSquads.some((q) => q.to === "waterworks")) errors.push(`push-pull: taking the waterworks set off no counter-attack (${JSON.stringify(st.battle.counterSquads)})`);
  // Off towards the camp, facing west with the waterworks off to the right: the counter-attack ashore and walking, the arrow at the screen's edge.
  const away = { x: core.x - 120, z: core.z + 110 };
  for (let k = 0; k < 12 && !st.battle.counterSquads.some((q) => q.to === "waterworks" && q.ashore <= 0); k++) {
    await stand(away.x, away.z, -Math.PI / 2);
    st = await quietStep(pg, 2000);
  }
  if (!st.battle.risk.includes("waterworks")) errors.push(`push-pull: the waterworks is not at risk with the counter-attack on its way (${JSON.stringify(st.battle.risk)})`);
  await stand(away.x, away.z, -Math.PI / 2);
  await pg.evaluate(() => window.advanceTime(300));
  const arrow = await pg.evaluate(() => [...document.querySelectorAll(".threat-mark")].filter((e) => e.style.display !== "none").map((e) => e.className));
  if (!arrow.length) errors.push("push-pull: no arrow points at the waterworks while the counter-attack walks to it");
  await pg.screenshot({ path: tag(1, "counter-arrow") });
  if (!phone) await pg.screenshot({ path: tag(3, "risk-bar"), clip: { x: 1280 / 2 - 260, y: 0, width: 520, height: 120 } });
  const risk = await pg.evaluate(() => document.querySelector("#island-row .tug.at-risk") !== null);
  if (!risk) errors.push("push-pull: the HUD's bar does not pulse with a node at risk");
  if (phone) {
    const cdp = await ctx.newCDPSession(pg);
    const bb = await pg.locator("#t-map").boundingBox();
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: bb.x + bb.width / 2, y: bb.y + bb.height / 2, id: 1 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await pg.evaluate(() => window.advanceTime(300));
    await pg.screenshot({ path: tag(2, "counter-map") });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: bb.x + bb.width / 2, y: bb.y + bb.height / 2, id: 1 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } else {
    await pg.keyboard.press("KeyM");
    await pg.evaluate(() => window.advanceTime(300));
    await pg.screenshot({ path: tag(2, "counter-map") });
    await pg.keyboard.press("KeyM");
  }
  // The results' beats slowed, so each is shot while it is up.
  await pg.evaluate(() => (window.ringfallBeatGap = 5000));
  // 2. At the waterworks' depot with the counter-attack on its way: the bar pulses as the player leaves.
  const dep = st.depotSpots.find((d) => d.poi === "waterworks");
  await stand(dep.x + Math.sin(dep.yaw) * 1.2, dep.z - Math.cos(dep.yaw) * 1.2, dep.yaw + Math.PI);
  await pg.evaluate(() => window.advanceTime(300));
  if (phone) {
    const bb = await pg.locator("#t-use").boundingBox();
    const cdp = await ctx.newCDPSession(pg);
    if (bb) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: bb.x + bb.width / 2, y: bb.y + bb.height / 2, id: 41 }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    }
  } else await pg.keyboard.press("KeyE");
  await pg.evaluate(() => window.advanceTime(800));
  const leaving = await readOf(pg);
  if (leaving.leaving === null || !leaving.battle.risk.includes("waterworks")) errors.push(`push-pull: leaving at the waterworks' depot reads leaving ${leaving.leaving}, at risk ${JSON.stringify(leaving.battle.risk)}`);
  await pg.screenshot({ path: tag(4, "depot-risk") });
  await pg.evaluate(() => window.advanceTime(5000));
  await pg.waitForFunction(() => !document.getElementById("results").hidden, null, { timeout: 10000 }).catch(() => undefined);
  const r = await readOf(pg);
  const set = r.settled;
  if (r.screen !== "results" || !set || !set.raid.gained.includes("waterworks") || !set.after.lost.includes("waterworks")) errors.push(`push-pull: the results read ${r.screen}, raid ${JSON.stringify(set?.raid)}, after ${JSON.stringify(set?.after)}`);
  if (!set?.night.lost.length) errors.push(`push-pull: the night took nothing (${JSON.stringify(set?.night)})`);
  // The beats, each shot as it comes up (`data-beat` on the beat's mark): the raid's change, the battle after leaving, the night.
  const beatOf = (b) => pg.waitForFunction((x) => document.getElementById("day-beat")?.dataset.beat === x, b, { timeout: 25000 }).then(() => true, () => false);
  if (!(await beatOf("raid"))) errors.push("push-pull: the results never showed the raid's beat");
  await pg.waitForTimeout(1200);
  await pg.screenshot({ path: tag(5, "results-raid") });
  if (!(await beatOf("after")) || !/depot/.test(await pg.evaluate(() => document.querySelector("#day-beat .ico")?.getAttribute("class") ?? ""))) errors.push("push-pull: the results' beat after leaving did not show the depot's mark");
  await pg.waitForTimeout(1200);
  await pg.screenshot({ path: tag(6, "results-after-leaving") });
  if (!(await beatOf("night")) || !/night/.test(await pg.evaluate(() => document.querySelector("#day-beat .ico")?.getAttribute("class") ?? ""))) errors.push("push-pull: the results' night beat did not show the moon");
  await pg.waitForTimeout(1200);
  await pg.screenshot({ path: tag(7, "results-night") });
  const bar = await pg.evaluate(() => document.querySelector("#day-result .tug")?.getAttribute("aria-label"));
  const held = Object.entries(r.profile.poiState).filter(([id, o]) => id !== "pad" && o.state === "freed").length;
  if (bar !== `${held} / 11`) errors.push(`push-pull: the results' bar reads ${bar} for ${held} nodes held`);
  await ctx.close();
  lap(`push-pull, ${phone ? "phone" : "desktop"}`);
}

/*
 * Six rules the screens show by layout, colour and motion instead of a sentence
 * (docs/ringfall/island-v2.md, 見せ方), on the desktop and a phone on its side: the carry-in
 * allowance as boxes (the starter weapons and heals outside them), the pouch's slots in its colour (the
 * shelves, the HUD's bag, a wipe's results), one contract a raid (the others pale) and a new day's
 * papers sliding onto the board, the flare's smoke over a tall building's top floor and its mark
 * by the plateau's pickup on the map, the ways in a raid learned turning from dashed to solid,
 * and an analysed mod part dropping into a supply bin.
 */
for (const phone of [false, true]) {
  const ctx = await browser.newContext(phone ? { viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 720 } });
  const pg = await withProfile(ctx, { ...depotGame, stash: [{ t: "weapon", kind: "pike", rarity: 1 }, { t: "armor", tier: 1 }, { t: "heal", kind: "cell" }, ...bag([["fuse", 2], ["board", 2]])] });
  const name = (n) => `${out}/${phone ? "m-" : ""}rules-${n}.png`;
  const snap = (n) => pg.screenshot({ path: name(n) });
  const why = phone ? "rules on a phone" : "rules";
  await toCamp(pg);
  // Carry-in boxes: the PIKE fills its two boxes, armour on top spills past them in red; the heals sit outside.
  await useStation(pg, "vehicle");
  await departUp(pg);
  await pickStart(pg, "depot", "supply", phone);
  await pg.keyboard.press("Escape");
  await useStation(pg, "stash");
  await pg.locator("#hub-stash [data-act=pick]", { hasText: "PIKE レア" }).click();
  const boxes = await pg.evaluate(() => ({ full: document.querySelectorAll("#hub-side .slot.depot .seg:not(.empty)").length, free: document.querySelectorAll("#hub-side .slot.depot .free span").length, pouch: document.querySelectorAll("#hub-side .slot.pouch .seg.pouch").length }));
  if (boxes.full !== 1 || boxes.free < 1 || boxes.pouch !== 3) errors.push(`${why}: the carry-in boxes read ${JSON.stringify(boxes)}`);
  await snap("1-carry");
  await pg.locator("#hub-stash [data-act=pick]", { hasText: "アーマー" }).click();
  if (!(await pg.locator("#hub-side .slot.depot .seg.over").count())) errors.push(`${why}: armour past the allowance is not marked over`);
  await snap("1-carry-over");
  await pg.locator("#hub-side .slot.pouch").scrollIntoViewIfNeeded();
  await snap("2-pouch-shelf");
  await pg.locator("#hub-stash [data-act=pick]", { hasText: "アーマー" }).click();
  await closePanel(pg);
  await useStation(pg, "vehicle");
  await pg.waitForFunction(() => !document.getElementById("depart").hidden, null, { timeout: 4000 }).catch(() => undefined);
  if (!(await pg.locator("#depart-carry .seg").count())) errors.push(`${why}: the departure's check shows no carry-in boxes`);
  await snap("1-carry-depart");
  await pg.keyboard.press("Escape");
  await pg.waitForTimeout(200);
  // One contract a raid: taking one pales the rest.
  await useStation(pg, "quests");
  await pg.locator("#hub-side .quest.contract [data-act=take]").first().click();
  const papers = await pg.evaluate(() => ({ all: document.querySelectorAll("#hub-side .quest.contract").length, dim: document.querySelectorAll("#hub-side .quest.contract.dim").length }));
  if (papers.all < 2 || papers.dim !== papers.all - 1) errors.push(`${why}: with a contract taken the board reads ${JSON.stringify(papers)}`);
  await snap("5-board-taken");
  await closePanel(pg);
  await rideOut(pg);
  await pg.evaluate(() => window.advanceTime(2500));
  // The bag's slots: the pouch's, outlined in its colour, hold what it would keep.
  await pg.evaluate(() => window.ringfallBag(["drive", "board", "parts", "parts", "gyro"]));
  await pg.evaluate(() => window.advanceTime(100));
  const cells = await pg.evaluate(() => ({ pouch: document.querySelectorAll("#obj-bag .bag-cells i.p").length, kept: document.querySelectorAll("#obj-bag .bag-cells i.k").length }));
  if (cells.pouch !== 3 || cells.kept < 1) errors.push(`${why}: the bag's slots read ${JSON.stringify(cells)}`);
  await pg.locator("#objective").screenshot({ path: name("2-pouch-bag") });
  // The flare: its mark by the plateau's pickup and on the tall buildings, then its smoke from 140 m off.
  await pg.keyboard.press("KeyM");
  await pg.evaluate(() => window.advanceTime(200));
  await snap("3-flare-map");
  await pg.keyboard.press("KeyM");
  {
    const st = await readOf(pg);
    const f = [...st.flares].sort((a, b) => Math.hypot(a.x - st.player.x, a.z - st.player.z) - Math.hypot(b.x - st.player.x, b.z - st.player.z))[0];
    if (!f || f.open) errors.push(`${why}: no unsearched flare bin in the raid (${JSON.stringify(st.flares)})`);
    else {
      const d = Math.hypot(st.player.x - f.x, st.player.z - f.z) || 1;
      const x = f.x + ((st.player.x - f.x) / d) * 140;
      const z = f.z + ((st.player.z - f.z) / d) * 140;
      const y = (await pg.evaluate(([qx, qz]) => window.ringfallTerrain(qx, qz), [x, z])) + 3;
      await pg.evaluate(([cx, cy, cz, yaw, pitch]) => window.ringfallCamera(cx, cy, cz, yaw, pitch), [x, y, z, Math.atan2(f.x - x, -(f.z - z)), 0.12]);
      await snap("3-flare-smoke");
      await pg.evaluate(() => window.ringfallCamera());
    }
  }
  // A wipe: what the pouch kept in its colour, the rest struck through.
  await pg.evaluate(() => window.ringfallEnd("dead", ["drive", "board", "parts", "parts", "gyro"]));
  await pg.waitForFunction(() => !document.getElementById("results").hidden, null, { timeout: 10000 }).catch(() => undefined);
  await pg.waitForTimeout(1500);
  const wipe = await pg.evaluate(() => ({ kept: document.querySelectorAll("#haul-line .pouch-kept").length, lost: document.querySelectorAll("#haul-line .lost").length }));
  if (wipe.kept < 1 || wipe.lost < 2) errors.push(`${why}: a wipe's results read ${JSON.stringify(wipe)}`);
  await snap("2-pouch-wipe");
  // The next day's board: its papers slide in.
  await pg.click("#restart");
  await faded(pg);
  await useStation(pg, "quests");
  if (!(await pg.locator("#hub-side .board.fresh").count())) errors.push(`${why}: the next day's board did not put up new papers`);
  await pg.waitForTimeout(150);
  await snap("5-board-new-sliding");
  await pg.waitForTimeout(1100);
  await snap("5-board-new");
  await closePanel(pg);
  // Home alive with two harbor ways in found and three mod parts worn: the rings turn solid, an analysed part drops into a bin.
  await rideOut(pg);
  await pg.evaluate(() => window.ringfallMods.wear(["jolt", "stock", "probe"]));
  await pg.evaluate(() => window.advanceTime(500));
  await pg.evaluate(() => window.ringfallEnd("extracted", ["board"], ["quay", "shore"]));
  await pg.waitForFunction(() => !document.getElementById("results").hidden, null, { timeout: 10000 }).catch(() => undefined);
  await pg.waitForTimeout(300);
  await snap("6-learn-dashed");
  await pg.waitForTimeout(1800);
  const learned = await pg.locator("#home .learned").count();
  if (learned !== 2) errors.push(`${why}: the results show ${learned} ways in learned, not 2`);
  await snap("6-learn-solid");
  const pick = pg.locator("#home [data-analyse]:not([disabled])").first();
  if (!(await pg.locator("#home .bin-pic.out").count()) || !(await pick.count())) errors.push(`${why}: no new mod part over a bin to analyse`);
  else {
    await snap("4-analyse");
    await pick.click();
    await pg.waitForTimeout(900);
    if (!(await pg.locator("#home .bin-pic.drop").count())) errors.push(`${why}: the analysed part did not drop into its bin`);
    await snap("4-analysed");
  }
  // The board's strength row: the bin's mod parts, one more known.
  await pg.click("#restart");
  await faded(pg);
  await useStation(pg, "quests");
  await pg.locator("#hub-side .quest.contract [data-act=take]").first().click();
  const known = await pg.textContent("#hub-side .strength p.bins");
  if (!/7 \/ 20/.test(known ?? "")) errors.push(`${why}: the board's bin shows "${known}" mod parts known`);
  await pg.locator("#hub-side .strength p.bins").scrollIntoViewIfNeeded();
  await snap("4-board-bin");
  // The departure: the harbor's ways in, learned, as solid rings that can be chosen, its padlock gone.
  await closePanel(pg);
  await useStation(pg, "vehicle");
  await departUp(pg);
  const learnt = ((await readOf(pg)).camp.depart?.starts ?? []).filter((q) => q.kind === "entry" && q.region === "harbor" && q.open);
  if (!learnt.length || (await pg.locator("#depart-points .region-lock").count())) errors.push(`${why}: the departure offers ${learnt.length} harbor ways in once learned`);
  if (learnt[0]) await pickStart(pg, "entry", learnt[0].id, phone);
  await snap("6-depart-learned");
  await pg.keyboard.press("Escape");
  await ctx.close();
  lap(`rules, ${phone ? "phone" : "desktop"}`);
}
await movementShots({ browser, port, out, errors });
lap("movement");
await bagShots({ browser, port, out, errors });
lap("bag");
await upgradeShots({ browser, port, out, errors });
lap("upgrades");
await browser.close();
server.close();
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("no console errors");
