import { useEffect, useRef } from "react";
import { factoryCanPlace, useFactory } from "./store";
import { foundrySound } from "./sound";
import {
  GRID_H,
  GRID_W,
  TICK_MS,
  type Cell,
  type Direction,
  type ItemKind,
  type Machine,
  type MachineKind,
  type PlacementTool,
  dirDelta,
  inBounds,
  machineCost,
  recipeTime,
} from "./types";

const CELL = 56;

interface Cam {
  x: number;
  y: number;
  z: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  color: string;
}

interface Popup {
  x: number;
  y: number;
  text: string;
  life: number;
}

export function FactoryCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const cam: Cam = { x: 9 * CELL, y: 7 * CELL, z: 1 };
    const particles: Particle[] = [];
    const popups: Popup[] = [];
    let lastTickAt = performance.now();
    let prevExport = useFactory.getState().totalExported;
    let raf = 0;
    let running = true;
    let dpr = 1;
    let w = 0;
    let h = 0;
    let tickAcc = 0;
    let last = performance.now();

    const pointers = new Map<number, { x: number; y: number }>();
    let paint = false;
    let panned = false;
    let lastPaintKey = "";
    let pinch0: number | null = null;
    const down = { x: 0, y: 0, cx: 0, cy: 0 };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      dpr = Math.min(2, window.devicePixelRatio || 1);
      w = rect.width;
      h = rect.height;
      canvas.width = Math.max(1, Math.floor(w * dpr));
      canvas.height = Math.max(1, Math.floor(h * dpr));
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const toWorld = (sx: number, sy: number) => ({
      x: cam.x + (sx - w / 2) / cam.z,
      y: cam.y + (sy - h / 2) / cam.z,
    });
    const hitCell = (sx: number, sy: number) => {
      const p = toWorld(sx, sy);
      return { x: Math.floor(p.x / CELL), y: Math.floor(p.y / CELL) };
    };
    const clampCam = () => {
      cam.x = Math.min(GRID_W * CELL, Math.max(0, cam.x));
      cam.y = Math.min(GRID_H * CELL, Math.max(0, cam.y));
    };

    const tryPlace = (x: number, y: number) => {
      const key = `${x},${y}`;
      if (key === lastPaintKey) return;
      lastPaintKey = key;
      const s = useFactory.getState();
      if (s.tool === "none") {
        s.selectCell(x, y);
        return;
      }
      const ok = s.place(x, y);
      if (ok) foundrySound.place();
      else if (s.tool !== "delete") foundrySound.error();
    };

    const onDown = (e: PointerEvent) => {
      foundrySound.prime();
      canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const rect = canvas.getBoundingClientRect();
      down.x = e.clientX - rect.left;
      down.y = e.clientY - rect.top;
      down.cx = cam.x;
      down.cy = cam.y;
      panned = false;
      lastPaintKey = "";
      const tool = useFactory.getState().tool;
      paint = tool === "belt" || tool === "delete";
      if (paint) tryPlace(hitCell(down.x, down.y).x, hitCell(down.x, down.y).y);
    };

    const onMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      useFactory.getState().setHover(hitCell(sx, sy));
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (pointers.size === 2) {
        const pts = [...pointers.values()];
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        if (pinch0 == null) pinch0 = dist;
        else {
          cam.z = Math.min(2.2, Math.max(0.45, cam.z * (dist / pinch0)));
          pinch0 = dist;
        }
        panned = true;
        paint = false;
        return;
      }
      if (paint) {
        const cell = hitCell(sx, sy);
        tryPlace(cell.x, cell.y);
        return;
      }
      const dx = sx - down.x;
      const dy = sy - down.y;
      if (Math.hypot(dx, dy) > 10) {
        panned = true;
        cam.x = down.cx - dx / cam.z;
        cam.y = down.cy - dy / cam.z;
        clampCam();
      }
    };

    const onUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch0 = null;
      if (panned || paint) {
        paint = false;
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const cell = hitCell(e.clientX - rect.left, e.clientY - rect.top);
      const s = useFactory.getState();
      if (s.tool === "none") {
        const mach = machineAt(s.grid, cell.x, cell.y);
        if (mach?.kind === "miner" && s.selected && s.selected.x === cell.x && s.selected.y === cell.y) {
          s.toggleMiner(cell.x, cell.y);
        } else {
          s.selectCell(cell.x, cell.y);
        }
        foundrySound.click();
        return;
      }
      if (s.tool !== "belt" && s.tool !== "delete") tryPlace(cell.x, cell.y);
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const before = toWorld(sx, sy);
      cam.z = Math.min(2.2, Math.max(0.45, cam.z * (e.deltaY > 0 ? 0.92 : 1.08)));
      const after = toWorld(sx, sy);
      cam.x += before.x - after.x;
      cam.y += before.y - after.y;
      clampCam();
    };

    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });

    const spawnExport = (value: number) => {
      const s = useFactory.getState();
      for (let y = 0; y < GRID_H; y++) {
        for (let x = 0; x < GRID_W; x++) {
          const cell = s.grid[y][x];
          if (cell.t !== "machine" || cell.machine.kind !== "exporter") continue;
          const cx = (x + 1) * CELL;
          const cy = (y + 1) * CELL;
          for (let i = 0; i < 10; i++) {
            particles.push({
              x: cx,
              y: cy,
              vx: (Math.random() - 0.5) * 80,
              vy: -40 - Math.random() * 70,
              life: 520,
              max: 520,
              size: 2.5 + Math.random() * 2,
              color: "#ffb020",
            });
          }
          popups.push({ x: cx, y: cy - 8, text: `+$${value}`, life: 700 });
        }
      }
    };

    const sparkWorking = () => {
      const s = useFactory.getState();
      for (let y = 0; y < GRID_H; y++) {
        for (let x = 0; x < GRID_W; x++) {
          const cell = s.grid[y][x];
          if (cell.t !== "machine" || cell.machine.progress <= 0) continue;
          if (Math.random() > 0.16) continue;
          const fire = cell.machine.kind === "smelter";
          particles.push({
            x: (x + 1) * CELL + (Math.random() - 0.5) * 22,
            y: (y + 1) * CELL + (Math.random() - 0.5) * 16,
            vx: (Math.random() - 0.5) * 28,
            vy: fire ? -55 : -18,
            life: fire ? 420 : 260,
            max: 420,
            size: fire ? 2.4 : 1.5,
            color: fire ? (Math.random() > 0.5 ? "#ff7a1a" : "#ffd060") : "#c9b48a",
          });
        }
      }
    };

    const loop = (now: number) => {
      if (!running) return;
      const dt = Math.min(50, now - last);
      last = now;
      tickAcc += dt;
      while (tickAcc >= TICK_MS) {
        useFactory.getState().tick(1);
        lastTickAt = now;
        tickAcc -= TICK_MS;
        const s = useFactory.getState();
        if (s.totalExported > prevExport) {
          spawnExport(s.lastExportValue);
          foundrySound.export(s.lastExportValue);
          prevExport = s.totalExported;
        }
        sparkWorking();
      }
      for (const p of particles) {
        p.x += (p.vx * dt) / 1000;
        p.y += (p.vy * dt) / 1000;
        p.vy += 140 * (dt / 1000);
        p.life -= dt;
      }
      for (let i = particles.length - 1; i >= 0; i--) if (particles[i].life <= 0) particles.splice(i, 1);
      for (const pop of popups) {
        pop.y -= (24 * dt) / 1000;
        pop.life -= dt;
      }
      for (let i = popups.length - 1; i >= 0; i--) if (popups[i].life <= 0) popups.splice(i, 1);

      paintFrame(ctx, w, h, dpr, cam, now, lastTickAt, particles, popups);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("wheel", onWheel);
    };
  }, []);

  return <canvas ref={canvasRef} className="foundry-canvas" />;
}

function paintFrame(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  dpr: number,
  cam: Cam,
  now: number,
  lastTickAt: number,
  particles: Particle[],
  popups: Popup[],
) {
  const s = useFactory.getState();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#14110e";
  ctx.fillRect(0, 0, w, h);

  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.scale(cam.z, cam.z);
  ctx.translate(-cam.x, -cam.y);

  const frac = Math.min(1, (now - lastTickAt) / TICK_MS);
  const vis = visibleRange(cam, w, h);
  drawFloor(ctx, vis);
  drawBelts(ctx, s.grid, vis, now);
  drawMachines(ctx, s.grid, vis, now);
  drawItems(ctx, s.grid, vis, frac, now);
  drawGhost(ctx, s.tool, s.hover, s.money);
  drawSelection(ctx, s.selected, s.grid);

  for (const p of particles) {
    ctx.globalAlpha = Math.max(0, p.life / p.max);
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.font = "800 16px Teko, sans-serif";
  ctx.textAlign = "center";
  for (const pop of popups) {
    ctx.globalAlpha = Math.max(0, pop.life / 700);
    ctx.fillStyle = "#ffd060";
    ctx.fillText(pop.text, pop.x, pop.y);
  }
  ctx.globalAlpha = 1;
  ctx.restore();

  if (s.exportFlash > 0) {
    ctx.fillStyle = `rgba(255, 122, 26, ${0.07 * (s.exportFlash / 12)})`;
    ctx.fillRect(0, 0, w, h);
  }
}

function visibleRange(c: Cam, w: number, h: number) {
  const pad = 2;
  return {
    x0: Math.max(0, Math.floor((c.x - w / 2 / c.z) / CELL) - pad),
    y0: Math.max(0, Math.floor((c.y - h / 2 / c.z) / CELL) - pad),
    x1: Math.min(GRID_W, Math.ceil((c.x + w / 2 / c.z) / CELL) + pad),
    y1: Math.min(GRID_H, Math.ceil((c.y + h / 2 / c.z) / CELL) + pad),
  };
}

function drawFloor(ctx: CanvasRenderingContext2D, vis: { x0: number; y0: number; x1: number; y1: number }) {
  ctx.fillStyle = "#1b1612";
  ctx.fillRect(0, 0, GRID_W * CELL, GRID_H * CELL);
  for (let y = vis.y0; y < vis.y1; y++) {
    for (let x = vis.x0; x < vis.x1; x++) {
      const px = x * CELL;
      const py = y * CELL;
      ctx.fillStyle = (x + y) % 2 === 0 ? "#1e1915" : "#181410";
      ctx.fillRect(px, py, CELL, CELL);
      ctx.strokeStyle = "rgba(70, 58, 44, 0.35)";
      ctx.strokeRect(px + 0.5, py + 0.5, CELL - 1, CELL - 1);
    }
  }
  ctx.strokeStyle = "rgba(255, 122, 26, 0.18)";
  ctx.lineWidth = 3;
  ctx.strokeRect(1.5, 1.5, GRID_W * CELL - 3, GRID_H * CELL - 3);
}

function beltDir(grid: Cell[][], x: number, y: number): Direction {
  const cell = grid[y][x];
  if (cell.t === "belt" && cell.belt.itemFrom) {
    const from = cell.belt.itemFrom;
    if (from === "left") return "right";
    if (from === "right") return "left";
    if (from === "up") return "down";
    return "up";
  }
  for (const dir of ["right", "down", "left", "up"] as Direction[]) {
    const [dx, dy] = dirDelta(dir);
    if (grid[y + dy]?.[x + dx]?.t === "belt") return dir;
  }
  return "right";
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawBelts(
  ctx: CanvasRenderingContext2D,
  grid: Cell[][],
  vis: { x0: number; y0: number; x1: number; y1: number },
  now: number,
) {
  const slide = (now / 90) % CELL;
  for (let y = vis.y0; y < vis.y1; y++) {
    for (let x = vis.x0; x < vis.x1; x++) {
      const cell = grid[y][x];
      if (cell.t !== "belt") continue;
      const px = x * CELL;
      const py = y * CELL;
      ctx.fillStyle = "#2a241c";
      roundRect(ctx, px + 8, py + 8, CELL - 16, CELL - 16, 6);
      ctx.fill();
      ctx.strokeStyle = "#4a3c2c";
      ctx.lineWidth = 2;
      ctx.stroke();
      const dir = beltDir(grid, x, y);
      ctx.save();
      ctx.beginPath();
      roundRect(ctx, px + 10, py + 10, CELL - 20, CELL - 20, 4);
      ctx.clip();
      ctx.strokeStyle = "rgba(255, 168, 72, 0.28)";
      ctx.lineWidth = 2;
      if (dir === "left" || dir === "right") {
        for (let i = -1; i < 4; i++) {
          const ox = px + ((slide + i * 14) % (CELL + 8)) - 4;
          ctx.beginPath();
          ctx.moveTo(ox, py + 12);
          ctx.lineTo(ox + 8, py + CELL - 12);
          ctx.stroke();
        }
      } else {
        for (let i = -1; i < 4; i++) {
          const oy = py + ((slide + i * 14) % (CELL + 8)) - 4;
          ctx.beginPath();
          ctx.moveTo(px + 12, oy);
          ctx.lineTo(px + CELL - 12, oy + 8);
          ctx.stroke();
        }
      }
      ctx.restore();
      if (cell.belt.trailItem && cell.belt.trailTicks > 0) {
        ctx.globalAlpha = 0.2 * (cell.belt.trailTicks / 3);
        drawItemGlyph(ctx, px + CELL / 2, py + CELL / 2, cell.belt.trailItem, 0.7, now);
        ctx.globalAlpha = 1;
      }
    }
  }
}

function drawMachines(
  ctx: CanvasRenderingContext2D,
  grid: Cell[][],
  vis: { x0: number; y0: number; x1: number; y1: number },
  now: number,
) {
  for (let y = vis.y0; y < vis.y1; y++) {
    for (let x = vis.x0; x < vis.x1; x++) {
      const cell = grid[y][x];
      if (cell.t === "machine") drawMachineBody(ctx, x, y, cell.machine, now);
    }
  }
}

function drawMachineBody(ctx: CanvasRenderingContext2D, x: number, y: number, m: Machine, now: number) {
  const px = x * CELL;
  const py = y * CELL;
  const size = CELL * 2;
  const pal = machinePalette(m.kind);
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  roundRect(ctx, px + 6, py + 10, size - 8, size - 8, 10);
  ctx.fill();
  ctx.fillStyle = pal.body;
  roundRect(ctx, px + 4, py + 4, size - 8, size - 10, 10);
  ctx.fill();
  ctx.fillStyle = pal.top;
  roundRect(ctx, px + 4, py + 4, size - 8, 22, 10);
  ctx.fill();
  ctx.strokeStyle = pal.edge;
  ctx.lineWidth = 2.5;
  roundRect(ctx, px + 4, py + 4, size - 8, size - 10, 10);
  ctx.stroke();

  const busy = m.progress > 0;
  const heat = busy ? 0.38 + 0.22 * Math.sin(now / 120) : 0.08;
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  roundRect(ctx, px + 18, py + 32, size - 36, 36, 6);
  ctx.fill();
  const n = parseInt(pal.glow.slice(1), 16);
  ctx.fillStyle = `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${heat})`;
  roundRect(ctx, px + 20, py + 34, size - 40, 32, 5);
  ctx.fill();

  if (busy) {
    const p = Math.min(1, m.progress / recipeTime(m.kind));
    ctx.fillStyle = pal.glow;
    ctx.fillRect(px + 16, py + size - 18, (size - 32) * p, 5);
  }

  ctx.fillStyle = "#f3e6c8";
  ctx.font = "700 11px Karla, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(shortName(m.kind), px + size / 2, py + 20);
  if (m.kind === "miner") {
    ctx.fillStyle = m.mode === "iron" ? "#9aa8b8" : "#e07a3a";
    ctx.fillText(m.mode === "iron" ? "IRON" : "COPPER", px + size / 2, py + size - 22);
  }
  drawMachineGlyph(ctx, px + size / 2, py + 50, m.kind, now, busy);
  const buf = m.kind === "exporter" ? m.inputBuffer.length : m.outputBuffer.length;
  if (buf > 0) {
    ctx.fillStyle = "#ffb020";
    ctx.font = "700 10px Karla, sans-serif";
    ctx.fillText(`${buf} queued`, px + size / 2, py + size - 8);
  }
}

function drawMachineGlyph(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  kind: MachineKind,
  now: number,
  busy: boolean,
) {
  ctx.save();
  ctx.translate(x, y);
  if (kind === "miner") {
    ctx.strokeStyle = "#cfd6de";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-10, -8);
    ctx.lineTo(0, 10 + (busy ? Math.sin(now / 80) * 3 : 0));
    ctx.lineTo(10, -8);
    ctx.stroke();
  } else if (kind === "smelter") {
    ctx.fillStyle = busy ? "#ff7a1a" : "#8a3a12";
    ctx.beginPath();
    ctx.moveTo(-12, 8);
    ctx.lineTo(0, -12);
    ctx.lineTo(12, 8);
    ctx.closePath();
    ctx.fill();
  } else if (kind === "assembler") {
    ctx.strokeStyle = "#e8c15a";
    ctx.lineWidth = 3;
    ctx.strokeRect(-12, -8, 24, 16);
    ctx.fillStyle = "#e8c15a";
    ctx.fillRect(-2, -14 + (busy ? Math.sin(now / 90) * 4 : 0), 4, 10);
  } else if (kind === "exporter") {
    ctx.fillStyle = "#6cb238";
    ctx.fillRect(-14, -4, 28, 12);
    ctx.fillRect(6, -10, 10, 8);
  } else {
    ctx.strokeStyle = "#7ad0a0";
    ctx.lineWidth = 2;
    ctx.strokeRect(-12, -8, 24, 16);
    ctx.fillStyle = "#ffb020";
    ctx.fillRect(-6, -3, 4, 4);
    ctx.fillRect(2, -2, 5, 2);
  }
  ctx.restore();
}

function drawItems(
  ctx: CanvasRenderingContext2D,
  grid: Cell[][],
  vis: { x0: number; y0: number; x1: number; y1: number },
  frac: number,
  now: number,
) {
  for (let y = vis.y0; y < vis.y1; y++) {
    for (let x = vis.x0; x < vis.x1; x++) {
      const cell = grid[y][x];
      if (cell.t !== "belt" || !cell.belt.item) continue;
      let cx = (x + 0.5) * CELL;
      let cy = (y + 0.5) * CELL;
      if (cell.belt.itemFrom) {
        const [dx, dy] = dirDelta(cell.belt.itemFrom);
        const px = (x + dx + 0.5) * CELL;
        const py = (y + dy + 0.5) * CELL;
        cx = px + (cx - px) * frac;
        cy = py + (cy - py) * frac;
      }
      drawItemGlyph(ctx, cx, cy, cell.belt.item, 1, now);
    }
  }
}

function drawItemGlyph(ctx: CanvasRenderingContext2D, x: number, y: number, item: ItemKind, scale: number, now: number) {
  ctx.save();
  ctx.translate(x, y + Math.sin(now / 180 + x) * 1.1);
  ctx.scale(scale, scale);
  switch (item) {
    case "ironOre":
      blob(ctx, "#5d6a78", "#9aa8b8");
      break;
    case "copperOre":
      blob(ctx, "#8a3a18", "#e07a3a");
      break;
    case "ironPlate":
      ctx.fillStyle = "#8ea0b4";
      ctx.fillRect(-8, -5, 16, 10);
      ctx.strokeStyle = "#d5e2ee";
      ctx.strokeRect(-8, -5, 16, 10);
      break;
    case "copperPlate":
      ctx.fillStyle = "#c47832";
      ctx.beginPath();
      ctx.ellipse(0, 0, 9, 6, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    case "gear": {
      ctx.rotate(now / 400);
      ctx.fillStyle = "#e8c15a";
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        ctx.lineTo(Math.cos(a) * 9, Math.sin(a) * 9);
        ctx.lineTo(Math.cos(a + 0.2) * 6, Math.sin(a + 0.2) * 6);
      }
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#2a2118";
      ctx.beginPath();
      ctx.arc(0, 0, 2.4, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "circuit":
      ctx.fillStyle = "#1f6a44";
      ctx.fillRect(-9, -6, 18, 12);
      ctx.fillStyle = "#ffb020";
      ctx.fillRect(-6, -3, 3, 3);
      ctx.fillRect(2, -2, 5, 2);
      break;
  }
  ctx.restore();
}

function blob(ctx: CanvasRenderingContext2D, a: string, b: string) {
  ctx.fillStyle = a;
  ctx.beginPath();
  ctx.arc(-2, 1, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = b;
  ctx.beginPath();
  ctx.arc(2, -2, 5.5, 0, Math.PI * 2);
  ctx.fill();
}

function drawGhost(
  ctx: CanvasRenderingContext2D,
  tool: PlacementTool,
  hover: { x: number; y: number } | null,
  money: number,
) {
  if (!hover || tool === "none" || !inBounds(hover.x, hover.y)) return;
  const ok = factoryCanPlace(hover.x, hover.y);
  ctx.globalAlpha = 0.42;
  if (tool === "belt" || tool === "delete") {
    ctx.fillStyle = ok ? "#ffb020" : "#c44";
    ctx.fillRect(hover.x * CELL + 6, hover.y * CELL + 6, CELL - 12, CELL - 12);
  } else {
    ctx.fillStyle = ok && money >= machineCost(tool) ? "#6cb238" : "#c44";
    roundRect(ctx, hover.x * CELL + 4, hover.y * CELL + 4, CELL * 2 - 8, CELL * 2 - 8, 10);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawSelection(
  ctx: CanvasRenderingContext2D,
  selected: { x: number; y: number } | null,
  grid: Cell[][],
) {
  if (!selected) return;
  const cell = grid[selected.y]?.[selected.x];
  if (!cell || cell.t === "empty") return;
  let x = selected.x;
  let y = selected.y;
  let w = CELL;
  let h = CELL;
  if (cell.t === "machine") {
    w = CELL * 2;
    h = CELL * 2;
  } else if (cell.t === "part") {
    x = cell.ax;
    y = cell.ay;
    w = CELL * 2;
    h = CELL * 2;
  }
  ctx.strokeStyle = "#ffb020";
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(x * CELL + 2, y * CELL + 2, w - 4, h - 4);
  ctx.setLineDash([]);
}

function machineAt(grid: Cell[][], x: number, y: number): Machine | null {
  const cell = grid[y]?.[x];
  if (cell?.t === "machine") return cell.machine;
  if (cell?.t === "part") {
    const a = grid[cell.ay][cell.ax];
    return a.t === "machine" ? a.machine : null;
  }
  return null;
}

function machinePalette(kind: MachineKind) {
  switch (kind) {
    case "miner":
      return { body: "#3a4650", top: "#5a6a78", edge: "#1c242c", glow: "#9aa8b8" };
    case "smelter":
      return { body: "#5a2a16", top: "#8a3a18", edge: "#2a1208", glow: "#ff7a1a" };
    case "assembler":
      return { body: "#4a3a18", top: "#7a5a20", edge: "#2a1c08", glow: "#e8c15a" };
    case "exporter":
      return { body: "#243820", top: "#3a5a32", edge: "#102010", glow: "#6cb238" };
    case "fabricator":
      return { body: "#1c3a32", top: "#2a5a4a", edge: "#0c2018", glow: "#7ad0a0" };
  }
}

function shortName(kind: MachineKind): string {
  switch (kind) {
    case "miner":
      return "MINER";
    case "smelter":
      return "FURNACE";
    case "assembler":
      return "PRESS";
    case "exporter":
      return "DOCK";
    case "fabricator":
      return "BENCH";
  }
}
