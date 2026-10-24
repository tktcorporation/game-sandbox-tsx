/**
 * The movement's screenshots for the shots gate (scripts/ringfall-shots.mjs runs them at its end;
 * `node scripts/ringfall-shots-movement.mjs` runs them alone against dist/client): the quarry's
 * new ways up, a slide-jump at speed with the view widened and the speed's streaks, a climb and
 * its mantle, a zipline ride and the map with the held ziplines, on a desktop and on a phone
 * driven by real touch events.
 */
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

/** A box to climb from each side: the depot's 4 m block by the supply depot, run at from the west (found by the sim gate's climb check). */
const CLIMB = { x: -19.3, z: 414, yaw: Math.PI / 2 };
/** A level lane on the harbor's salt flats, run east along (the sim gate's course). */
const LANE_Z = 0;

export async function movementShots({ browser, port, out, errors }) {
  const read = (pg) => pg.evaluate(() => window.ringfallMove.state());
  const step = (pg, ms) => pg.evaluate((t) => window.advanceTime(t), ms);
  const quiet = (pg, ms) => pg.evaluate((t) => window.ringfallStep(t), ms);
  const open = async (ctx) => {
    const pg = await ctx.newPage();
    pg.on("pageerror", (e) => errors.push(`movement pageerror: ${e.message}`));
    pg.on("console", (m) => m.type() === "error" && !/fonts\.g|ERR_TUNNEL|net::/.test(m.text()) && errors.push(`movement console: ${m.text()}`));
    await pg.goto(`http://localhost:${port}/ringfall/`, { waitUntil: "load" });
    await pg.waitForTimeout(300);
    return pg;
  };
  /** From the title to a raid out of the camp's gate, on the keyboard. */
  const raid = async (pg, touch) => {
    await (touch ? pg.tap("#start") : pg.click("#start"));
    await pg.waitForFunction(() => getComputedStyle(document.getElementById("fade")).opacity === "0", null, { timeout: 8000 }).catch(() => errors.push("movement: the fade never cleared"));
    await pg.evaluate(() => window.ringfallCamp.toGate());
    await pg.keyboard.down("KeyW");
    let st = JSON.parse(await pg.evaluate(() => window.render_game_to_text()));
    for (let i = 0; i < 30 && st.screen !== "game" && !st.camp?.depart; i++) st = JSON.parse(await pg.evaluate(() => (window.advanceTime(200), window.render_game_to_text())));
    await pg.keyboard.up("KeyW");
    if (st.camp?.depart) {
      await pg.keyboard.press("Enter");
      await pg.waitForTimeout(400);
    }
    for (let i = 0; i < 20 && JSON.parse(await pg.evaluate(() => window.render_game_to_text())).screen !== "game"; i++) await step(pg, 200);
    if (JSON.parse(await pg.evaluate(() => window.render_game_to_text())).screen !== "game") errors.push("movement: no raid started");
    await pg.evaluate(() => window.ringfallMove.quiet());
    await quiet(pg, 4000);
  };
  /** Drawn first: the undrawn steps leave the canvas as it was. */
  const snap = async (pg, path) => {
    await pg.evaluate(() => window.ringfallDraw());
    await pg.screenshot({ path });
  };
  const place = (pg, x, z, yaw) => pg.evaluate(([a, b, c]) => window.ringfallPlace(a, b, c), [x, z, yaw]);
  const camera = async (pg, x, dy, z, yaw, pitch) => {
    const y = (await pg.evaluate(([a, b]) => window.ringfallTerrain(a, b), [x, z])) + dy;
    await pg.evaluate(([a, b, c, d, e]) => window.ringfallCamera(a, b, c, d, e), [x, y, z, yaw, pitch]);
  };
  const lane = async (pg) => {
    const fr = await pg.evaluate(() => window.ringfallFrames());
    return { x: fr["area:bay"].x - 55, z: fr["area:bay"].z - 500 + LANE_Z };
  };

  // --- desktop
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const pg = await open(ctx);
    await raid(pg, false);
    const fov0 = (await read(pg)).fov;

    // The quarry's ways up: from the south rim over the terraces, and from its floor, the wide
    // iron stairs on every side and the lifts' cables climbing out of it.
    const fr = await pg.evaluate(() => window.ringfallFrames());
    const q = fr.quarry;
    await camera(pg, q.x - 10, 45, q.z + 150, 0, -0.42);
    await snap(pg, `${out}/90-quarry-exits.png`);
    await camera(pg, q.x - 30, 1.7, q.z + 14, Math.PI, 0.32);
    await snap(pg, `${out}/91-quarry-floor-up.png`);
    await camera(pg, q.x - 150, 14, q.z - 10, Math.PI / 2, -0.25);
    await snap(pg, `${out}/92-quarry-west.png`);
    await pg.evaluate(() => window.ringfallCamera());
    // Walking up one of them on the keyboard.
    const sw = (await pg.evaluate(() => window.ringfallMove.quarry())).find((e) => e.name === "上段から南西へ");
    await place(pg, sw.x, sw.z, sw.yaw);
    await pg.keyboard.down("KeyW");
    await step(pg, 1300);
    await snap(pg, `${out}/93-quarry-stairs.png`);
    await step(pg, 2500);
    await pg.keyboard.up("KeyW");
    const top = await read(pg);
    if (!(top.y > -2)) errors.push(`movement: walking the quarry's south-west stairs ended at ${top.y.toFixed(1)} m`);

    // A slide-jump chain on the salt flats: sprint, slide, jump, land sliding, jump again.
    const l = await lane(pg);
    await place(pg, l.x, l.z, Math.PI / 2);
    await pg.keyboard.down("KeyW");
    await step(pg, 700);
    let peak = 0;
    for (let k = 0; k < 4; k++) {
      await pg.keyboard.down("KeyC");
      await step(pg, 250);
      await pg.keyboard.press("Space");
      await step(pg, k === 3 ? 260 : 700);
      peak = Math.max(peak, (await read(pg)).speed);
    }
    const fast = await read(pg);
    await snap(pg, `${out}/94-slide-jump.png`);
    await pg.keyboard.up("KeyC");
    await pg.keyboard.up("KeyW");
    if (!(peak > 10) || fast.onGround) errors.push(`movement: the slide-jump chain peaked at ${peak.toFixed(1)} m/s (${JSON.stringify(fast)})`);
    if (!(fast.fov > fov0 + 2)) errors.push(`movement: the view did not widen at speed (${fov0.toFixed(1)} to ${fast.fov.toFixed(1)})`);
    const lines = await pg.evaluate(() => +getComputedStyle(document.getElementById("fx-speed")).opacity);
    if (!(lines > 0.05)) errors.push(`movement: no speed streaks at ${fast.speed.toFixed(1)} m/s`);

    // A climb: running at the 4 m block, up its face hand over hand, then over the top.
    await place(pg, CLIMB.x, CLIMB.z, CLIMB.yaw);
    // Looking up the face, as one climbing does.
    await pg.evaluate(() => window.ringfallMove.look(0.75));
    await pg.keyboard.down("KeyW");
    let climbing = false;
    for (let i = 0; i < 30 && !climbing; i++) {
      await quiet(pg, 50);
      climbing = (await read(pg)).climb;
    }
    await quiet(pg, 300);
    await snap(pg, `${out}/95-climb.png`);
    for (let i = 0; i < 20 && (await read(pg)).mantle; i++) await quiet(pg, 50);
    await pg.keyboard.up("KeyW");
    await step(pg, 100);
    await snap(pg, `${out}/96-climb-top.png`);
    const up = await read(pg);
    if (!climbing || !(up.y > 3.5)) errors.push(`movement: the climb ${climbing ? "" : "never started and "}ended at ${up.y.toFixed(1)} m`);

    // A zipline: every node held, from the mast outside the camp's gate toward the supply depot.
    await pg.evaluate(() => window.ringfallMove.hold());
    const zips = await pg.evaluate(() => window.ringfallMove.zips());
    const camp = zips.find((z) => z.a === "camp");
    await place(pg, camp.from.x - 2, camp.from.z, Math.atan2(camp.to.x - camp.from.x, -(camp.to.z - camp.from.z)));
    await step(pg, 100);
    await snap(pg, `${out}/97-zip-head.png`);
    await pg.keyboard.press("KeyE");
    await step(pg, 2600);
    const ride = await read(pg);
    await snap(pg, `${out}/98-zip-ride.png`);
    if (!ride.zip || !(ride.speed > 15)) errors.push(`movement: the use key at the camp's zipline did not ride it (${JSON.stringify(ride)})`);
    await pg.keyboard.press("Space");
    await step(pg, 300);
    await snap(pg, `${out}/99-zip-jump.png`);
    const off = await read(pg);
    if (off.zip || !(off.speed > 12)) errors.push(`movement: jumping off the zipline did not keep its speed (${JSON.stringify(off)})`);
    // The quarry's north lift, from its floor.
    const lift = zips.find((z) => z.fixed && z.b === "lift:quarry-n");
    if (lift) {
      await pg.evaluate(([i]) => window.ringfallMove.zip(i, 1), [lift.i]);
      await step(pg, 2000);
      await snap(pg, `${out}/9a-quarry-lift.png`);
      await quiet(pg, 6000);
    }
    await pg.keyboard.press("KeyM");
    await step(pg, 100);
    await pg.keyboard.press("KeyN");
    await step(pg, 100);
    await snap(pg, `${out}/9b-map-zips.png`);
    await pg.keyboard.press("KeyN");
    await pg.keyboard.press("KeyM");
    await ctx.close();
  }

  // --- phone, on real touch events: the stick, the crouch held, the jump and the use buttons
  {
    const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const pg = await open(ctx);
    const cdp = await ctx.newCDPSession(pg);
    const touch = (type, points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points });
    const centre = async (sel) => {
      const bb = await pg.locator(sel).boundingBox();
      return bb && { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 };
    };
    await raid(pg, true);
    const stick = { x: 150, y: 260, id: 1 };
    const push = { x: 150, y: 200, id: 1 };
    const l = await lane(pg);
    await place(pg, l.x, l.z, Math.PI / 2);
    await touch("touchStart", [stick]);
    await touch("touchMove", [push]);
    await step(pg, 700);
    const crouch = await centre("#t-crouch");
    const jump = await centre("#t-jump");
    let peak = 0;
    // The crouch button held from here on: a slide now, and a slide on at each landing.
    await touch("touchStart", [push, { ...crouch, id: 2 }]);
    for (let k = 0; k < 3; k++) {
      await step(pg, 250);
      await touch("touchStart", [push, { ...crouch, id: 2 }, { ...jump, id: 3 }]);
      await touch("touchMove", [push, { ...crouch, id: 2 }]);
      await step(pg, k === 2 ? 260 : 700);
      peak = Math.max(peak, (await read(pg)).speed);
    }
    await snap(pg, `${out}/m30-slide-jump.png`);
    await touch("touchEnd", []);
    if (!(peak > 10)) errors.push(`mobile movement: the slide-jump on the touch buttons peaked at ${peak.toFixed(1)} m/s`);

    // A climb on the stick alone.
    await place(pg, CLIMB.x, CLIMB.z, CLIMB.yaw);
    await pg.evaluate(() => window.ringfallMove.look(0.75));
    await touch("touchStart", [stick]);
    await touch("touchMove", [push]);
    let climbing = false;
    for (let i = 0; i < 30 && !climbing; i++) {
      await quiet(pg, 50);
      climbing = (await read(pg)).climb;
    }
    await quiet(pg, 250);
    await snap(pg, `${out}/m31-climb.png`);
    for (let i = 0; i < 20 && (await read(pg)).mantle; i++) await quiet(pg, 50);
    await touch("touchEnd", []);
    if (!climbing || !((await read(pg)).y > 3.5)) errors.push("mobile movement: the stick did not climb the block");

    // A zipline by the use button.
    await pg.evaluate(() => window.ringfallMove.hold());
    const zips = await pg.evaluate(() => window.ringfallMove.zips());
    const camp = zips.find((z) => z.a === "camp");
    await place(pg, camp.from.x - 2, camp.from.z, Math.atan2(camp.to.x - camp.from.x, -(camp.to.z - camp.from.z)));
    await step(pg, 200);
    const use = await centre("#t-use");
    if (!use) errors.push("mobile movement: no use button by the zipline's head");
    else {
      await touch("touchStart", [{ ...use, id: 4 }]);
      await touch("touchEnd", []);
      await step(pg, 2400);
      await snap(pg, `${out}/m32-zip-ride.png`);
      if (!(await read(pg)).zip) errors.push("mobile movement: the use button did not take hold of the zipline");
    }
    await ctx.close();
  }
}

// Alone: serve the build and run the movement's shots.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
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
  const out = "shots/ringfall";
  await mkdir(out, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const errors = [];
  await movementShots({ browser, port: server.address().port, out, errors });
  await browser.close();
  server.close();
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exit(1);
  }
  console.log("movement shots ok");
}
