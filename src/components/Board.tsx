import { useEffect, useRef, useState } from "react";
import { BUILDINGS, GRID_SIZE } from "../game/buildings";
import { useGame } from "../game/store";
import { accruedFor, formatDuration, formatNumber, now } from "../game/logic";
import type { PlacedBuilding } from "../game/types";
import { useUi } from "../ui";

function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize(Math.min(r.width, r.height));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, size };
}

export function Board() {
  const buildings = useGame((s) => s.buildings);
  const moveBuilding = useGame((s) => s.moveBuilding);
  const { ref, size } = useElementSize<HTMLDivElement>();
  const cell = size / GRID_SIZE;

  return (
    <div className="board-wrap" ref={ref}>
      <div className="board" style={{ width: size, height: size }}>
        {buildings.map((b) => (
          <Tile key={b.id} b={b} cell={cell} onMove={moveBuilding} />
        ))}
      </div>
    </div>
  );
}

interface TileProps {
  b: PlacedBuilding;
  cell: number;
  onMove: (id: string, x: number, y: number) => boolean;
}

function Tile({ b, cell, onMove }: TileProps) {
  const def = BUILDINGS[b.type];
  const select = useUi((s) => s.select);
  const selectedId = useUi((s) => s.selectedId);
  const collect = useGame((s) => s.collect);
  const showToast = useUi((s) => s.showToast);

  const drag = useRef<{ startX: number; startY: number; moved: boolean } | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null);

  const constructing = !!b.upgradeDoneAt;
  const accrued = def.production ? accruedFor(b, now()) : 0;
  const fullPct = def.production ? accrued / def.production.cap(b.level) : 0;

  const x = ghost?.x ?? b.x;
  const y = ghost?.y ?? b.y;

  const pct = (v: number) => `${(v / GRID_SIZE) * 100}%`;

  const onPointerDown = (e: React.PointerEvent) => {
    if (constructing) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startY: e.clientY, moved: false };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current || !cell) return;
    const dx = e.clientX - drag.current.startX;
    const dy = e.clientY - drag.current.startY;
    if (!drag.current.moved && Math.hypot(dx, dy) < 8) return;
    drag.current.moved = true;
    const board = (e.currentTarget as HTMLElement).parentElement!.getBoundingClientRect();
    let nx = Math.round((e.clientX - board.left) / cell - def.size / 2);
    let ny = Math.round((e.clientY - board.top) / cell - def.size / 2);
    nx = Math.max(0, Math.min(GRID_SIZE - def.size, nx));
    ny = Math.max(0, Math.min(GRID_SIZE - def.size, ny));
    setGhost({ x: nx, y: ny });
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.moved && ghost) {
      const ok = onMove(b.id, ghost.x, ghost.y);
      if (!ok) showToast("Can't place there");
      setGhost(null);
      return;
    }
    setGhost(null);
    // treat as a tap
    if (accrued >= 1) {
      collect(b.id);
      const r = def.production!.resource;
      showToast(`+${formatNumber(accrued)} ${r === "gold" ? "🪙" : "🧪"}`);
    } else {
      select(b.id);
    }
  };

  return (
    <div
      className={`tile ${b.type === "wall" ? "wall" : ""} ${selectedId === b.id ? "selected" : ""}`}
      style={{
        left: pct(x),
        top: pct(y),
        width: pct(def.size),
        height: pct(def.size),
        fontSize: cell * def.size * 0.5,
        zIndex: ghost ? 5 : undefined,
        opacity: ghost ? 0.85 : 1,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {b.type !== "wall" && <span className="emoji">{def.emoji}</span>}
      {!constructing && <span className="level-badge">{b.level}</span>}
      {!constructing && def.production && accrued >= 1 && (
        <span className={`collect-badge ${def.production.resource}`}>
          {fullPct >= 0.999 ? "FULL" : formatNumber(accrued)}
        </span>
      )}
      {constructing && (
        <div className="build-progress">
          <span className="clock">🔨</span>
          <span>{formatDuration((b.upgradeDoneAt! - now()) / 1000)}</span>
        </div>
      )}
    </div>
  );
}
