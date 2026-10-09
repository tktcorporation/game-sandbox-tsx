import { useEffect, useRef, useState } from "react";
import { Frame } from "../../arcade/Frame";
import { useSaved } from "../../arcade/save";
import {
  burning, canDig, canDouse, crewEvery, dig, douse, DOUSE_COST, DOUSE_SHAPE, idx, MAX_CREWS, newLevel, stars,
  step, value, villages, WIND_EVERY, DX, DY,
  type Cell, type Dir, type State,
} from "./logic";
import "./wildfire.css";

const CELL = 26;
const TICK_MS = 800;
const levelSeed = (n: number) => Math.imul(n, 104729) + 3;

type Tool = "dig" | "douse";
interface Save {
  unlocked: number;
  best: Record<number, number>;
}

export default function Wildfire() {
  const [save, setSave] = useSaved<Save>("wildfire", { unlocked: 1, best: {} });
  const [state, setState] = useState(() => newLevel(save.unlocked, levelSeed(save.unlocked)));
  const [running, setRunning] = useState(false);
  const [started, setStarted] = useState(false);
  const [tool, setTool] = useState<Tool>("dig");
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const [picker, setPicker] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const live = useRef(state);
  live.current = state;
  const hoverRef = useRef(hover);
  hoverRef.current = hover;
  const toolRef = useRef(tool);
  toolRef.current = tool;

  const start = (level: number) => {
    setState(newLevel(level, levelSeed(level)));
    setRunning(false);
    setStarted(false);
    setPicker(false);
    setTool("dig");
  };

  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => {
      setState((s) => {
        const n = step(s);
        if (n.over) setRunning(false);
        return n;
      });
    }, TICK_MS);
    return () => clearInterval(t);
  }, [running]);

  useEffect(() => {
    if (!state.over) return;
    const st = stars(state);
    setSave((v) => ({
      unlocked: st > 0 ? Math.max(v.unlocked, state.level + 1) : v.unlocked,
      best: { ...v.best, [state.level]: Math.max(v.best[state.level] ?? 0, st) },
    }));
  }, [state.over]);

  // Render loop is independent from the simulation tick so flames can flicker.
  useEffect(() => {
    let raf = 0;
    const draw = (t: number) => {
      const c = canvas.current;
      if (c) render(c, live.current, t, hoverRef.current, toolRef.current);
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  const cellFrom = (e: React.PointerEvent) => {
    const r = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * state.w);
    const y = Math.floor(((e.clientY - r.top) / r.height) * state.h);
    return x >= 0 && y >= 0 && x < state.w && y < state.h ? { x, y } : null;
  };

  const tap = (e: React.PointerEvent) => {
    const p = cellFrom(e);
    if (!p || state.over) return;
    if (tool === "dig") setState((s) => dig(s, p.x, p.y));
    else {
      setState((s) => douse(s, p.x, p.y));
      setTool("dig");
    }
  };

  const v = villages(state);
  const saved = Math.round((value(state) / state.startValue) * 100);
  const forecastSoon = state.windIn <= 4;

  return (
    <Frame
      title="延焼線"
      className="wf"
      right={
        <button className="wf-level" onClick={() => setPicker(true)}>
          山 {state.level}
        </button>
      }
    >
      <div className="wf-hud">
        <div className="wf-wind" aria-label={`風 ${dirLabel(state.wind)}、${state.windIn} 秒後に ${dirLabel(state.nextWind)}`}>
          <WindArrow d={state.wind} big />
          <div className="wf-forecast">
            <span>次の風</span>
            <div className={`wf-next ${forecastSoon ? "soon" : ""}`}>
              <WindArrow d={state.nextWind} />
              <svg viewBox="0 0 36 36" className="wf-ring">
                <circle cx="18" cy="18" r="15" />
                <circle cx="18" cy="18" r="15" className="fg" style={{ strokeDashoffset: 94.2 * (state.windIn / WIND_EVERY) }} />
              </svg>
            </div>
          </div>
        </div>
        <div className="wf-stats">
          <div>
            <b>{v.alive}</b>
            <span>/{v.total} 家</span>
          </div>
          <div>
            <b>{saved}</b>
            <span>% 森</span>
          </div>
        </div>
      </div>

      <div className="wf-board">
        <canvas
          ref={canvas}
          width={state.w * CELL * 2}
          height={state.h * CELL * 2}
          onPointerDown={tap}
          onPointerMove={(e) => setHover(cellFrom(e))}
          onPointerLeave={() => setHover(null)}
          style={{ aspectRatio: `${state.w} / ${state.h}` }}
        />
        {!started && !state.over && (
          <div className="wf-brief">
            <p>
              火は<strong>風下へ</strong>速く燃え広がる。風は南・南東・南西の間で変わり、右上が次の風。
              作業員 1 人で 1 マス掘れる。燃えるものの無いマスで火は止まる。
            </p>
            <button
              onClick={() => {
                setStarted(true);
                setRunning(true);
              }}
            >
              火が回り始める
            </button>
            <small>止めている間も掘れる。まず村の風下側を見て。</small>
          </div>
        )}
      </div>

      <div className="wf-crews" aria-label={`作業員 ${state.crews} / ${MAX_CREWS}`}>
        {Array.from({ length: MAX_CREWS }, (_, i) => (
          <i key={i} className={i < state.crews ? "on" : ""} />
        ))}
        <span>作業員 · {crewEvery(state.level) * TICK_MS / 1000} 秒で 1 人戻る</span>
      </div>

      <div className="wf-tools">
        <button className={tool === "dig" ? "on" : ""} onClick={() => setTool("dig")}>
          <b>掘る</b>
          <small>1 人 · 1 マス</small>
        </button>
        <button className={tool === "douse" ? "on" : ""} disabled={!canDouse(state)} onClick={() => setTool("douse")}>
          <b>放水</b>
          <small>{DOUSE_COST} 人 · 十字に消火</small>
        </button>
        <button className="wf-pause" disabled={!started || state.over} onClick={() => setRunning((r) => !r)} aria-label={running ? "一時停止" : "再開"}>
          {running ? (
            <svg viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
          ) : (
            <svg viewBox="0 0 24 24"><path d="M7 5l12 7-12 7z" /></svg>
          )}
        </button>
      </div>

      {state.over && (
        <div className="wf-over">
          <div className="card">
            <h2>{v.alive === v.total ? "村を守り切った" : v.alive === 0 ? "村は焼け落ちた" : "鎮火した"}</h2>
            <div className="wf-stars">{[1, 2, 3].map((i) => <span key={i} className={i <= stars(state) ? "on" : ""}>★</span>)}</div>
            <p>
              守った家 {v.alive}/{v.total} · 残った森 {saved}%
            </p>
            <p className="sub">★3 は家をすべて守り、森を 45% 以上残す</p>
            <div className="row">
              <button className="ghost" onClick={() => start(state.level)}>もう一度</button>
              {stars(state) > 0 && <button className="primary" onClick={() => start(state.level + 1)}>次の山へ</button>}
            </div>
          </div>
        </div>
      )}

      {picker && (
        <div className="wf-over" onClick={() => setPicker(false)}>
          <div className="card" onClick={(e) => e.stopPropagation()}>
            <h2>山を選ぶ</h2>
            <div className="wf-levels">
              {Array.from({ length: save.unlocked }, (_, i) => i + 1).map((n) => (
                <button key={n} className={n === state.level ? "on" : ""} onClick={() => start(n)}>
                  <b>{n}</b>
                  <span>{"★".repeat(save.best[n] ?? 0) || "—"}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      <p className="wf-live" aria-live="polite">{burning(state) > 0 && started ? `燃えているマス ${burning(state)}` : ""}</p>
    </Frame>
  );
}

const dirLabel = (d: Dir) => ["北へ", "東へ", "南へ", "西へ"][d];

function WindArrow({ d, big }: { d: Dir; big?: boolean }) {
  return (
    <svg viewBox="0 0 40 40" className={`wf-arrow ${big ? "big" : ""}`} style={{ transform: `rotate(${d * 90}deg)` }} aria-hidden>
      <path d="M20 34V8M10 17l10-10 10 10" />
    </svg>
  );
}

// ------------------------------------------------------------------ render

function hash(i: number) {
  let x = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  return ((x >>> 0) % 1000) / 1000;
}

function render(c: HTMLCanvasElement, s: State, t: number, hover: { x: number; y: number } | null, tool: Tool) {
  const g = c.getContext("2d")!;
  const k = c.width / s.w;
  g.clearRect(0, 0, c.width, c.height);
  for (let y = 0; y < s.h; y++)
    for (let x = 0; x < s.w; x++) drawCell(g, s.cells[idx(s, x, y)], x * k, y * k, k, idx(s, x, y), t);

  // Wind streaks drifting downwind.
  g.strokeStyle = "rgba(255,255,255,0.18)";
  g.lineWidth = k * 0.06;
  g.lineCap = "round";
  for (let i = 0; i < 16; i++) {
    const phase = ((t / 2600 + hash(i * 7)) % 1) * 1.4 - 0.2;
    const base = hash(i * 13) * (s.wind % 2 === 0 ? c.width : c.height);
    const along = phase * (s.wind % 2 === 0 ? c.height : c.width);
    const len = k * 1.2;
    let x0: number;
    let y0: number;
    if (s.wind === 2) [x0, y0] = [base, along];
    else if (s.wind === 0) [x0, y0] = [base, c.height - along];
    else if (s.wind === 1) [x0, y0] = [along, base];
    else [x0, y0] = [c.width - along, base];
    g.beginPath();
    g.moveTo(x0, y0);
    g.lineTo(x0 - DX[s.wind] * len, y0 - DY[s.wind] * len);
    g.stroke();
  }

  if (hover && !s.over) {
    const cells = tool === "douse" ? DOUSE_SHAPE.map(([dx, dy]) => [hover.x + dx, hover.y + dy]) : [[hover.x, hover.y]];
    const ok = tool === "douse" ? canDouse(s) : canDig(s, hover.x, hover.y);
    g.strokeStyle = ok ? (tool === "douse" ? "#8fd3ff" : "#f6e7d0") : "rgba(255,90,60,0.8)";
    g.lineWidth = k * 0.09;
    for (const [x, y] of cells) if (x >= 0 && y >= 0 && x < s.w && y < s.h) g.strokeRect(x * k + 2, y * k + 2, k - 4, k - 4);
  }
}

function drawCell(g: CanvasRenderingContext2D, cell: Cell, px: number, py: number, k: number, i: number, t: number) {
  const r = hash(i);
  if (cell.kind === "water") {
    g.fillStyle = "#3a6f8f";
    g.fillRect(px, py, k, k);
    g.strokeStyle = "rgba(220,240,255,0.3)";
    g.lineWidth = k * 0.06;
    g.beginPath();
    const wob = Math.sin(t / 600 + r * 6) * k * 0.06;
    g.moveTo(px + k * 0.2, py + k * 0.5 + wob);
    g.quadraticCurveTo(px + k * 0.5, py + k * 0.35 + wob, px + k * 0.8, py + k * 0.5 + wob);
    g.stroke();
    return;
  }
  if (cell.kind === "rock") {
    g.fillStyle = "#5d5650";
    g.fillRect(px, py, k, k);
    g.fillStyle = "#7a726a";
    g.beginPath();
    g.ellipse(px + k / 2, py + k * 0.58, k * 0.34, k * 0.26, 0, 0, Math.PI * 2);
    g.fill();
    return;
  }
  if (cell.burnt) {
    g.fillStyle = r < 0.5 ? "#2e2925" : "#34302b";
    g.fillRect(px, py, k, k);
    if (cell.kind === "forest" || cell.kind === "village") {
      g.fillStyle = "#1a1714";
      g.fillRect(px + k * 0.45, py + k * 0.35, k * 0.1, k * 0.45);
    }
    const ember = Math.sin(t / 300 + r * 20);
    if (ember > 0.85) {
      g.fillStyle = "rgba(255,120,40,0.6)";
      g.fillRect(px + k * r, py + k * hash(i + 3), k * 0.08, k * 0.08);
    }
    return;
  }
  if (cell.dug) {
    g.fillStyle = "#7a5638";
    g.fillRect(px, py, k, k);
    g.strokeStyle = "#5e412a";
    g.lineWidth = k * 0.07;
    for (let j = 1; j < 4; j++) {
      g.beginPath();
      g.moveTo(px + (k * j) / 4, py + k * 0.15);
      g.lineTo(px + (k * j) / 4, py + k * 0.85);
      g.stroke();
    }
    return;
  }
  // grass base
  g.fillStyle = r < 0.33 ? "#a3b86b" : r < 0.66 ? "#9bb265" : "#a8bd70";
  g.fillRect(px, py, k, k);
  if (cell.kind === "forest") {
    g.fillStyle = r < 0.5 ? "#3f6b3a" : "#46743f";
    for (const [ox, oy, sz] of [[0.3, 0.55, 0.3], [0.68, 0.5, 0.28], [0.5, 0.82, 0.24]] as const) {
      g.beginPath();
      g.moveTo(px + k * ox, py + k * (oy - sz));
      g.lineTo(px + k * (ox + sz * 0.6), py + k * (oy + sz * 0.4));
      g.lineTo(px + k * (ox - sz * 0.6), py + k * (oy + sz * 0.4));
      g.closePath();
      g.fill();
    }
  } else if (cell.kind === "village") {
    g.fillStyle = "#e9dcc2";
    g.fillRect(px + k * 0.2, py + k * 0.45, k * 0.6, k * 0.42);
    g.fillStyle = "#c8553d";
    g.beginPath();
    g.moveTo(px + k * 0.1, py + k * 0.5);
    g.lineTo(px + k * 0.5, py + k * 0.15);
    g.lineTo(px + k * 0.9, py + k * 0.5);
    g.closePath();
    g.fill();
  } else if (r > 0.7) {
    g.strokeStyle = "#86a055";
    g.lineWidth = k * 0.05;
    g.beginPath();
    g.moveTo(px + k * 0.4, py + k * 0.7);
    g.lineTo(px + k * 0.45, py + k * 0.5);
    g.moveTo(px + k * 0.55, py + k * 0.7);
    g.lineTo(px + k * 0.6, py + k * 0.52);
    g.stroke();
  }
  if (cell.wet > 0) {
    g.fillStyle = `rgba(110,180,230,${0.12 + cell.wet * 0.03})`;
    g.fillRect(px, py, k, k);
  }
  if (cell.fire > 0) {
    const f = 0.55 + 0.45 * Math.sin(t / 90 + r * 30);
    g.fillStyle = `rgba(255,${110 + f * 60},40,${0.55 + f * 0.3})`;
    g.fillRect(px, py, k, k);
    g.fillStyle = `rgba(255,230,140,${0.5 * f})`;
    const h = k * (0.45 + 0.25 * f);
    g.beginPath();
    g.moveTo(px + k * 0.5, py + k - h - k * 0.1);
    g.quadraticCurveTo(px + k * 0.85, py + k * 0.75, px + k * 0.5, py + k * 0.92);
    g.quadraticCurveTo(px + k * 0.15, py + k * 0.75, px + k * 0.5, py + k - h - k * 0.1);
    g.fill();
  }
}
