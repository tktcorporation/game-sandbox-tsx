import { useEffect, useRef } from "react";
import { BUILDINGS, GRID_H, GRID_W } from "../game/buildings";
import { useGame } from "../game/store";
import { accruedFor, canPlace, formatDuration, formatNumber, now } from "../game/logic";
import { useUi } from "../ui";
import {
  buildDecorations,
  buildingHit,
  dayLight,
  drawAtmosphere,
  drawBuilding,
  drawGround,
  drawNightOverlay,
  drawSky,
  drawVignette,
  postProcess,
  Fx,
  makeView,
  project,
  unproject,
  type BuildingDraw,
  type Camera,
  type IsoView,
} from "../render/iso";

/** real seconds for one full in-game day */
const DAY_LENGTH = 150;

interface DragState {
  id: string;
  size: number;
  constructing: boolean;
  startX: number;
  startY: number;
  moved: boolean;
}

interface Ghost {
  id: string;
  x: number;
  y: number;
  valid: boolean;
}

interface PanState {
  startX: number;
  startY: number;
  camX: number;
  camY: number;
  moved: boolean;
}

interface PinchState {
  dist: number;
  zoom: number;
  midX: number;
  midY: number;
  camX: number;
  camY: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export function Board() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewRef = useRef<IsoView | null>(null);
  const dprRef = useRef(1);
  const camRef = useRef<Camera>({ zoom: 1, panX: 0, panY: 0 });
  const dragRef = useRef<DragState | null>(null);
  const ghostRef = useRef<Ghost | null>(null);
  const panRef = useRef<PanState | null>(null);
  const pinchRef = useRef<PinchState | null>(null);
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const bounceRef = useRef<Map<string, number>>(new Map());
  const seenRef = useRef<Set<string>>(new Set());
  const firstRef = useRef(true);
  const fxRef = useRef<Fx>(new Fx());
  const decoKeyRef = useRef("");
  const decoRef = useRef<ReturnType<typeof buildDecorations>>([]);

  const clampCam = (cam: Camera, W: number, H: number) => {
    cam.zoom = clamp(cam.zoom, 0.7, 2.4);
    cam.panX = clamp(cam.panX, -W * 0.6, W * 0.6);
    cam.panY = clamp(cam.panY, -H * 0.65, H * 0.65);
  };

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    dprRef.current = dpr;
    let raf = 0;
    let last = performance.now();

    const resize = () => {
      const r = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const frame = (time: number) => {
      const dt = Math.min(0.05, (time - last) / 1000);
      last = time;
      const W = canvas.width;
      const H = canvas.height;
      const v = makeView(W, H, { cam: camRef.current });
      viewRef.current = v;
      const t = time / 1000;
      const tNow = now();
      const buildings = useGame.getState().buildings;
      const selectedId = useUi.getState().selectedId;
      const fx = fxRef.current;
      fx.update(dt);

      // detect newly added buildings -> placement bounce
      if (firstRef.current) {
        firstRef.current = false;
        for (const b of buildings) seenRef.current.add(b.id);
      } else {
        for (const b of buildings) {
          if (!seenRef.current.has(b.id)) {
            seenRef.current.add(b.id);
            bounceRef.current.set(b.id, t);
          }
        }
      }

      // occupied cells for terrain decoration (stable until layout changes)
      const occupied = new Set<string>();
      for (const b of buildings) {
        const sz = BUILDINGS[b.type].size;
        for (let yy = 0; yy < sz; yy++)
          for (let xx = 0; xx < sz; xx++) occupied.add(`${b.x + xx},${b.y + yy}`);
      }
      const key = buildings.map((b) => `${b.x},${b.y},${b.type}`).join("|");
      if (key !== decoKeyRef.current) {
        decoKeyRef.current = key;
        decoRef.current = buildDecorations(occupied);
      }

      const dl = dayLight((t / DAY_LENGTH) % 1);

      ctx.clearRect(0, 0, W, H);
      drawSky(ctx, W, H, dl);
      drawGround(ctx, v);

      // depth-sorted render list: decorations + buildings
      type Item = { depth: number; draw: () => void };
      const items: Item[] = [];
      for (const deco of decoRef.current) {
        items.push({ depth: deco.depth, draw: () => deco.draw(ctx, v) });
      }
      const ghost = ghostRef.current;
      for (const b of buildings) {
        const def = BUILDINGS[b.type];
        const isGhost = ghost?.id === b.id;
        const x = isGhost ? ghost!.x : b.x;
        const y = isGhost ? ghost!.y : b.y;
        const accrued = def.production ? accruedFor(b, tNow) : 0;
        const cap = def.production ? def.production.cap(b.level) : 0;

        let squash = 0;
        const bs = bounceRef.current.get(b.id);
        if (bs !== undefined) {
          const e = t - bs;
          if (e > 0.6) bounceRef.current.delete(b.id);
          else squash = Math.cos(e * 20) * 0.22 * Math.exp(-e * 5);
        }

        const draw: BuildingDraw = {
          type: b.type,
          level: b.level,
          x,
          y,
          size: def.size,
          time: t,
          selected: selectedId === b.id,
          constructing: !!b.upgradeDoneAt,
          ambient: !b.upgradeDoneAt,
          night: dl.night,
          squash,
          remainingLabel: b.upgradeDoneAt
            ? formatDuration((b.upgradeDoneAt - tNow) / 1000)
            : undefined,
          collect:
            def.production && accrued >= 1
              ? { kind: def.production.resource, full: accrued >= cap * 0.999 }
              : null,
          showLevel: true,
        };
        items.push({
          depth: y + def.size,
          draw: () => {
            if (isGhost) {
              drawGhostFootprint(ctx, v, x, y, def.size, ghost!.valid);
              ctx.save();
              ctx.globalAlpha = 0.85;
              drawBuilding(ctx, v, draw);
              ctx.restore();
            } else {
              drawBuilding(ctx, v, draw);
            }
          },
        });
      }
      items.sort((a, b) => a.depth - b.depth);
      for (const it of items) it.draw();

      fx.draw(ctx, v);
      drawAtmosphere(ctx, W, H, `rgba(150,178,205,${(0.16 + dl.night * 0.1).toFixed(3)})`);
      drawNightOverlay(ctx, W, H, dl);
      drawVignette(ctx, W, H);
      postProcess(ctx, W, H);

      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const W = canvas.width;
      const H = canvas.height;
      const r = canvas.getBoundingClientRect();
      const cx = (e.clientX - r.left) * dprRef.current;
      const cy = (e.clientY - r.top) * dprRef.current;
      const cam = camRef.current;
      const v0 = makeView(W, H, { cam });
      const g = unproject(v0, cx, cy);
      cam.zoom = clamp(cam.zoom * Math.exp(-e.deltaY * 0.0012), 0.7, 2.4);
      const v1 = makeView(W, H, { cam: { zoom: cam.zoom, panX: 0, panY: 0 } });
      const p = project(v1, g.gx, g.gy);
      cam.panX = cx - p.x;
      cam.panY = cy - p.y;
      clampCam(cam, W, H);
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("wheel", onWheel);
    };
  }, []);

  const toDevice = (e: React.PointerEvent) => {
    const canvas = canvasRef.current!;
    const r = canvas.getBoundingClientRect();
    const dpr = dprRef.current;
    return { x: (e.clientX - r.left) * dpr, y: (e.clientY - r.top) * dpr };
  };

  const topmostAt = (sx: number, sy: number) => {
    const v = viewRef.current;
    if (!v) return null;
    const buildings = useGame.getState().buildings;
    let best: (typeof buildings)[number] | null = null;
    let bestDepth = -Infinity;
    for (const b of buildings) {
      const def = BUILDINGS[b.type];
      if (buildingHit(v, { type: b.type, x: b.x, y: b.y, size: def.size }, sx, sy)) {
        const depth = b.y + def.size;
        if (depth > bestDepth) {
          bestDepth = depth;
          best = b;
        }
      }
    }
    return best;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const { x, y } = toDevice(e);
    pointersRef.current.set(e.pointerId, { x, y });

    if (pointersRef.current.size >= 2) {
      // start pinch — cancel any single-pointer interaction
      dragRef.current = null;
      ghostRef.current = null;
      panRef.current = null;
      const pts = [...pointersRef.current.values()];
      const a = pts[0];
      const b = pts[1];
      const cam = camRef.current;
      pinchRef.current = {
        dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        zoom: cam.zoom,
        midX: (a.x + b.x) / 2,
        midY: (a.y + b.y) / 2,
        camX: cam.panX,
        camY: cam.panY,
      };
      return;
    }

    const b = topmostAt(x, y);
    if (b) {
      dragRef.current = {
        id: b.id,
        size: BUILDINGS[b.type].size,
        constructing: !!b.upgradeDoneAt,
        startX: x,
        startY: y,
        moved: false,
      };
    } else {
      const cam = camRef.current;
      panRef.current = { startX: x, startY: y, camX: cam.panX, camY: cam.panY, moved: false };
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointersRef.current.has(e.pointerId)) return;
    const { x, y } = toDevice(e);
    pointersRef.current.set(e.pointerId, { x, y });
    const canvas = canvasRef.current!;
    const W = canvas.width;
    const H = canvas.height;

    // pinch zoom + pan
    if (pointersRef.current.size >= 2 && pinchRef.current) {
      const pts = [...pointersRef.current.values()];
      const a = pts[0];
      const b = pts[1];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      const cam = camRef.current;
      const pin = pinchRef.current;
      cam.zoom = clamp((pin.zoom * dist) / pin.dist, 0.7, 2.4);
      cam.panX = pin.camX + (midX - pin.midX);
      cam.panY = pin.camY + (midY - pin.midY);
      clampCam(cam, W, H);
      return;
    }

    const drag = dragRef.current;
    const v = viewRef.current;
    if (drag && v && !drag.constructing) {
      if (!drag.moved && Math.hypot(x - drag.startX, y - drag.startY) < 10 * dprRef.current) return;
      drag.moved = true;
      const g = unproject(v, x, y);
      let nx = Math.round(g.gx - drag.size / 2);
      let ny = Math.round(g.gy - drag.size / 2);
      nx = clamp(nx, 0, GRID_W - drag.size);
      ny = clamp(ny, 0, GRID_H - drag.size);
      const valid = canPlace(useGame.getState().buildings, nx, ny, drag.size, drag.id);
      ghostRef.current = { id: drag.id, x: nx, y: ny, valid };
      return;
    }

    const pan = panRef.current;
    if (pan) {
      const dx = x - pan.startX;
      const dy = y - pan.startY;
      if (!pan.moved && Math.hypot(dx, dy) < 8 * dprRef.current) return;
      pan.moved = true;
      const cam = camRef.current;
      cam.panX = pan.camX + dx;
      cam.panY = pan.camY + dy;
      clampCam(cam, W, H);
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;
    if (pointersRef.current.size > 0) {
      // still multi-touch; don't resolve taps yet
      dragRef.current = null;
      panRef.current = null;
      ghostRef.current = null;
      return;
    }

    const drag = dragRef.current;
    const pan = panRef.current;
    dragRef.current = null;
    panRef.current = null;
    const ghost = ghostRef.current;
    ghostRef.current = null;
    const game = useGame.getState();
    const ui = useUi.getState();

    if (drag) {
      if (drag.moved && ghost && ghost.id === drag.id) {
        const ok = game.moveBuilding(drag.id, ghost.x, ghost.y);
        if (ok) bounceRef.current.set(drag.id, performance.now() / 1000);
        else ui.showToast("そこには置けません");
        return;
      }
      const b = game.buildings.find((x) => x.id === drag.id);
      if (!b) return;
      const def = BUILDINGS[b.type];
      const accrued = def.production ? accruedFor(b, now()) : 0;
      if (accrued >= 1 && def.production) {
        game.collect(b.id);
        const res = def.production.resource;
        const cx = b.x + def.size / 2;
        const cy = b.y + def.size / 2;
        fxRef.current.coinBurst(cx, cy, res, 4);
        const v = viewRef.current;
        const canvas = canvasRef.current;
        if (v && canvas) {
          const src = project(v, cx, cy);
          const cr = canvas.getBoundingClientRect();
          const dpr = dprRef.current;
          const chip = document.querySelector(`.res.${res}`) as HTMLElement | null;
          let tx = cr.width * dpr * (res === "gold" ? 0.18 : 0.42);
          let ty = -24 * dpr;
          if (chip) {
            const r = chip.getBoundingClientRect();
            tx = (r.left + r.width / 2 - cr.left) * dpr;
            ty = (r.top + r.height / 2 - cr.top) * dpr;
          }
          fxRef.current.flyToBar(src.x, src.y - v.tw * 0.4, tx, ty, res);
        }
        ui.showToast(`+${formatNumber(accrued)} ${res}`);
      } else {
        ui.select(b.id);
      }
      return;
    }

    // tap on empty ground (no pan movement) -> deselect
    if (pan && !pan.moved) ui.select(null);
  };

  return (
    <div className="board-wrap">
      <canvas
        ref={canvasRef}
        className="board-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
    </div>
  );
}

function drawGhostFootprint(
  ctx: CanvasRenderingContext2D,
  v: IsoView,
  x: number,
  y: number,
  size: number,
  valid: boolean,
) {
  const T = project(v, x, y);
  const R = project(v, x + size, y);
  const B = project(v, x + size, y + size);
  const L = project(v, x, y + size);
  ctx.beginPath();
  ctx.moveTo(T.x, T.y);
  ctx.lineTo(R.x, R.y);
  ctx.lineTo(B.x, B.y);
  ctx.lineTo(L.x, L.y);
  ctx.closePath();
  ctx.fillStyle = valid ? "rgba(95,211,95,0.35)" : "rgba(224,74,74,0.35)";
  ctx.fill();
  ctx.strokeStyle = valid ? "#5fd35f" : "#e04a4a";
  ctx.lineWidth = v.tw * 0.05;
  ctx.stroke();
}
