import { useEffect, useRef } from "react";
import { BUILDINGS, GRID_SIZE } from "../game/buildings";
import { useGame } from "../game/store";
import { accruedFor, canPlace, formatDuration, formatNumber, now } from "../game/logic";
import { useUi } from "../ui";
import {
  buildDecorations,
  buildingHit,
  drawBuilding,
  drawGround,
  makeView,
  project,
  unproject,
  type BuildingDraw,
  type IsoView,
} from "../render/iso";

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

export function Board() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewRef = useRef<IsoView | null>(null);
  const dprRef = useRef(1);
  const dragRef = useRef<DragState | null>(null);
  const ghostRef = useRef<Ghost | null>(null);
  const decoKeyRef = useRef("");
  const decoRef = useRef<ReturnType<typeof buildDecorations>>([]);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    dprRef.current = dpr;
    let raf = 0;

    const resize = () => {
      const r = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const frame = () => {
      const W = canvas.width;
      const H = canvas.height;
      const v = makeView(W, H);
      viewRef.current = v;
      const t = performance.now() / 1000;
      const tNow = now();
      const buildings = useGame.getState().buildings;
      const selectedId = useUi.getState().selectedId;

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

      ctx.clearRect(0, 0, W, H);
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
        const draw: BuildingDraw = {
          type: b.type,
          level: b.level,
          x,
          y,
          size: def.size,
          time: t,
          selected: selectedId === b.id,
          constructing: !!b.upgradeDoneAt,
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
          depth: x + y + def.size, // front corner depth
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

      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
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
        const depth = b.x + b.y + def.size;
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
    const b = topmostAt(x, y);
    if (!b) {
      dragRef.current = null;
      return;
    }
    dragRef.current = {
      id: b.id,
      size: BUILDINGS[b.type].size,
      constructing: !!b.upgradeDoneAt,
      startX: x,
      startY: y,
      moved: false,
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    const v = viewRef.current;
    if (!drag || !v || drag.constructing) return;
    const { x, y } = toDevice(e);
    if (!drag.moved && Math.hypot(x - drag.startX, y - drag.startY) < 10 * dprRef.current) return;
    drag.moved = true;
    const g = unproject(v, x, y);
    let nx = Math.round(g.gx - drag.size / 2);
    let ny = Math.round(g.gy - drag.size / 2);
    nx = Math.max(0, Math.min(GRID_SIZE - drag.size, nx));
    ny = Math.max(0, Math.min(GRID_SIZE - drag.size, ny));
    const valid = canPlace(useGame.getState().buildings, nx, ny, drag.size, drag.id);
    ghostRef.current = { id: drag.id, x: nx, y: ny, valid };
  };

  const onPointerUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    const ghost = ghostRef.current;
    ghostRef.current = null;
    if (!drag) {
      useUi.getState().select(null);
      return;
    }
    const game = useGame.getState();
    const ui = useUi.getState();
    if (drag.moved && ghost && ghost.id === drag.id) {
      const ok = game.moveBuilding(drag.id, ghost.x, ghost.y);
      if (!ok) ui.showToast("そこには置けません");
      return;
    }
    // tap
    const b = game.buildings.find((x) => x.id === drag.id);
    if (!b) return;
    const def = BUILDINGS[b.type];
    const accrued = def.production ? accruedFor(b, now()) : 0;
    if (accrued >= 1 && def.production) {
      game.collect(b.id);
      ui.showToast(`+${formatNumber(accrued)} ${def.production.resource === "gold" ? "🪙" : "🧪"}`);
    } else {
      ui.select(b.id);
    }
  };

  return (
    <div className="board-wrap">
      <canvas
        ref={canvasRef}
        className="board-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
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
