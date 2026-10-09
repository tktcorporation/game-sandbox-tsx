import { useEffect, useRef, useState } from "react";
import { Frame } from "../../arcade/Frame";
import { shake } from "../../arcade/juice";
import { useSaved } from "../../arcade/save";
import { sfx } from "../../arcade/sfx";
import {
  arrival, burning, canDig, canDouse, crewEvery, dig, douse, DOUSE_COST, DOUSE_SHAPE, idx, MAX_CREWS, newLevel, stars,
  step, value, villages, WIND_EVERY, DX, DY,
  type Cell, type Dir, type State,
} from "./logic";
import "./wildfire.css";

const TICK_MS = 800;
/** While a finger is on the board, time runs at this speed (Bad North). */
const PLAN_SCALE = 0.25;
/** A house shows a warning ring once fire could reach it within this many ticks (Mini Metro). */
const WARN_TICKS = 7;
const levelSeed = (n: number) => Math.imul(n, 104729) + 3;

type Tool = "dig" | "douse";
interface Save {
  unlocked: number;
  best: Record<number, number>;
}

export default function Wildfire() {
  const [save, setSave] = useSaved<Save>("wildfire-v2", { unlocked: 1, best: {} });
  const [state, setState] = useState(() => newLevel(save.unlocked, levelSeed(save.unlocked)));
  const [started, setStarted] = useState(false);
  const [paused, setPaused] = useState(false);
  const [holding, setHolding] = useState(false);
  const [tool, setTool] = useState<Tool>("dig");
  const [picker, setPicker] = useState(false);
  const [crewFill, setCrewFill] = useState(0);
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const live = useRef(state);
  live.current = state;
  const view = useRef({ hover: null as { x: number; y: number } | null, tool, holding, dugAt: new Map<number, number>(), eta: new Float64Array(0) as Float64Array });
  view.current.tool = tool;
  view.current.holding = holding;
  const lastCell = useRef(-1);
  const digCount = useRef(0);

  const start = (level: number) => {
    setState(newLevel(level, levelSeed(level)));
    setStarted(false);
    setPaused(false);
    setPicker(false);
    setTool("dig");
    view.current.dugAt.clear();
  };

  // One clock drives both simulation and rendering; holding the board slows the clock.
  useEffect(() => {
    let raf = 0;
    let prev = performance.now();
    let acc = 0;
    let warned = new Set<number>();
    const loop = (t: number) => {
      const dt = Math.min(100, t - prev);
      prev = t;
      const s = live.current;
      const running = started && !paused && !s.over;
      if (running) {
        acc += dt * (view.current.holding ? PLAN_SCALE : 1);
        if (acc >= TICK_MS) {
          acc -= TICK_MS;
          const n = step(s);
          if (n.wind !== s.wind) {
            sfx.wind();
            shake(wrap.current, 1);
          }
          if (n.crews > s.crews) sfx.crew();
          if (villages(n).alive < villages(s).alive) {
            sfx.house();
            shake(wrap.current, 6);
          }
          const eta = arrival(n);
          const now = new Set<number>();
          n.cells.forEach((c, i) => c.kind === "village" && !c.burnt && eta[i] < WARN_TICKS && now.add(i));
          if ([...now].some((i) => !warned.has(i))) sfx.warn();
          warned = now;
          view.current.eta = eta;
          live.current = n;
          setState(n);
        }
        setCrewFill(acc / TICK_MS);
      }
      const c = canvas.current;
      if (c) render(c, live.current, t, view.current);
      raf = requestAnimationFrame(loop);
    };
    view.current.eta = arrival(live.current);
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [started, paused]);

  useEffect(() => {
    if (!state.over) return;
    const st = stars(state);
    setSave((v) => ({
      unlocked: st > 0 ? Math.max(v.unlocked, state.level + 1) : v.unlocked,
      best: { ...v.best, [state.level]: Math.max(v.best[state.level] ?? 0, st) },
    }));
    if (st > 0) sfx.win();
    else sfx.lose();
  }, [state.over]);

  const cellFrom = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * state.w);
    const y = Math.floor(((e.clientY - r.top) / r.height) * state.h);
    return x >= 0 && y >= 0 && x < state.w && y < state.h ? { x, y } : null;
  };

  const apply = (p: { x: number; y: number }) => {
    const s = live.current;
    const i = idx(s, p.x, p.y);
    if (tool === "dig") {
      if (i === lastCell.current || !canDig(s, p.x, p.y)) return;
      lastCell.current = i;
      const n = dig(s, p.x, p.y);
      view.current.dugAt.set(i, performance.now());
      view.current.eta = arrival(n);
      sfx.dig(digCount.current++);
      live.current = n;
      setState(n);
    } else if (canDouse(s)) {
      const n = douse(s, p.x, p.y);
      sfx.douse();
      shake(wrap.current, 3);
      view.current.eta = arrival(n);
      live.current = n;
      setState(n);
      setTool("dig");
    }
  };

  const down = (e: React.PointerEvent) => {
    if (state.over) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setHolding(true);
    lastCell.current = -1;
    digCount.current = 0;
    const p = cellFrom(e);
    if (p) apply(p);
  };
  const moveP = (e: React.PointerEvent) => {
    const p = cellFrom(e);
    view.current.hover = p;
    if (holding && p && tool === "dig") apply(p);
  };
  const up = () => setHolding(false);

  const v = villages(state);
  const saved = Math.round((value(state) / state.startValue) * 100);
  const heat = 1 - saved / 100;
  const atRisk = state.cells.reduce((n, c, i) => n + (c.kind === "village" && !c.burnt && (view.current.eta[i] ?? 99) < WARN_TICKS ? 1 : 0), 0);

  return (
    <Frame
      title="延焼線"
      className={`wf ${holding && started ? "planning" : ""}`}
      style={{ "--heat": heat } as React.CSSProperties}
      right={
        <button className="wf-level" onClick={() => setPicker(true)}>
          山 {state.level}
        </button>
      }
    >
      <div className="wf-hud">
        <div className="wf-forecast" aria-label={`風 ${DIR_JA[state.wind]}。${state.windIn} 後に ${DIR_JA[state.nextWind]}`}>
          <div className="now">
            <Arrow d={state.wind} />
            <span>今の風</span>
          </div>
          <div className="next">
            <div className="dial" style={{ "--p": state.windIn / WIND_EVERY } as React.CSSProperties}>
              <Arrow d={state.nextWind} />
            </div>
            <span>
              次 <b className="num">{state.windIn}</b>
            </span>
          </div>
        </div>
        <div className="wf-stats">
          <div className={atRisk ? "risk" : ""}>
            <b className="num">{v.alive}</b>
            <span>/{v.total} 家{atRisk ? ` · ${atRisk} 危険` : ""}</span>
          </div>
          <div>
            <b className="num">{saved}</b>
            <span>% 森</span>
          </div>
        </div>
      </div>

      <div className="wf-board" ref={wrap}>
        <canvas
          ref={canvas}
          width={state.w * 52}
          height={state.h * 52}
          onPointerDown={down}
          onPointerMove={moveP}
          onPointerUp={up}
          onPointerCancel={up}
          onPointerLeave={() => (view.current.hover = null)}
          style={{ aspectRatio: `${state.w} / ${state.h}` }}
        />
        {holding && started && !state.over && <div className="wf-slow">時間 ×{PLAN_SCALE}</div>}
        {!started && !state.over && (
          <div className="wf-start">
            <p>なぞって防火帯を掘る。指を置いている間、時間はゆっくり進む。</p>
            <button
              className="btn primary"
              onClick={() => {
                setStarted(true);
                sfx.wind();
              }}
            >
              火が回り始める
            </button>
          </div>
        )}
      </div>

      <div className="wf-dock">
        <div className="wf-crews" aria-label={`作業員 ${state.crews} / ${MAX_CREWS}`}>
          {Array.from({ length: MAX_CREWS }, (_, i) => (
            <i
              key={i}
              className={i < state.crews ? "on" : i === state.crews ? "filling" : ""}
              style={i === state.crews ? ({ "--f": (state.crewTimer + crewFill) / crewEvery(state.level) } as React.CSSProperties) : undefined}
            />
          ))}
          <span>作業員</span>
        </div>
        <div className="wf-tools">
          <button className={`tool ${tool === "dig" ? "on" : ""}`} onClick={() => setTool("dig")}>
            <b>掘る</b>
            <small>1 人 / マス</small>
          </button>
          <button className={`tool ${tool === "douse" ? "on" : ""}`} disabled={!canDouse(state)} onClick={() => setTool("douse")}>
            <b>放水</b>
            <small>{DOUSE_COST} 人 / 十字</small>
            {!canDouse(state) && <span className="cool" style={{ "--p": state.crews / DOUSE_COST } as React.CSSProperties} />}
          </button>
          <button className="tool pause" disabled={!started || state.over} onClick={() => setPaused((p) => !p)} aria-label={paused ? "再開" : "一時停止"}>
            {paused ? <svg viewBox="0 0 24 24"><path d="M7 5l12 7-12 7z" /></svg> : <svg viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14" /><rect x="14" y="5" width="4" height="14" /></svg>}
          </button>
        </div>
      </div>

      {state.over && (
        <div className="sheet-wrap">
          <div className="sheet">
            <h2 className={v.alive === v.total ? "" : "threat"}>{v.alive === v.total ? "村を守り切った" : v.alive === 0 ? "村は焼け落ちた" : "鎮火した"}</h2>
            <div className="stars">{[1, 2, 3].map((i) => <span key={i} className={i <= stars(state) ? "on" : ""}>★</span>)}</div>
            <p className="wf-why num">守った家 {v.alive}/{v.total} · 残った森 {saved}% · ★3 は全部の家と森 45%</p>
            <div className="row">
              <button className="btn ghost" onClick={() => start(state.level)}>もう一度</button>
              {stars(state) > 0 ? (
                <button className="btn primary" onClick={() => start(state.level + 1)}>次の山へ</button>
              ) : (
                <button className="btn primary" onClick={() => start(state.level)}>同じ山をやり直す</button>
              )}
            </div>
          </div>
        </div>
      )}

      {picker && (
        <div className="sheet-wrap" onClick={() => setPicker(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h2>山を選ぶ</h2>
            <div className="level-grid">
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
      <p className="sr" aria-live="polite">{started && burning(state) > 0 ? `燃えているマス ${burning(state)}` : ""}</p>
    </Frame>
  );
}

const DIR_JA = ["北へ", "東へ", "南へ", "西へ"] as const;

function Arrow({ d }: { d: Dir }) {
  return (
    <svg viewBox="0 0 40 40" className="wf-arrow" style={{ transform: `rotate(${d * 90}deg)` }} aria-hidden>
      <path d="M20 34V9M9 19L20 8l11 11" />
    </svg>
  );
}

// ------------------------------------------------------------------ render

function hash(i: number) {
  let x = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  return ((x >>> 0) % 1000) / 1000;
}

const C = {
  grass: ["#6b7558", "#677153", "#6f795c"],
  forest: "#46553f",
  tree: "#33402f",
  water: "#3a5d6e",
  rock: "#55585b",
  burnt: "#262524",
  dug: "#7d6448",
  trench: "#5a4732",
  wall: "#e7e9e4",
  roof: "#b8bdb6",
};

interface View {
  hover: { x: number; y: number } | null;
  tool: Tool;
  holding: boolean;
  dugAt: Map<number, number>;
  eta: Float64Array;
}

function render(c: HTMLCanvasElement, s: State, t: number, v: View) {
  const g = c.getContext("2d")!;
  const k = c.width / s.w;
  for (let y = 0; y < s.h; y++)
    for (let x = 0; x < s.w; x++) {
      const i = idx(s, x, y);
      drawCell(g, s, s.cells[i], x, y, k, i, t, v.dugAt.get(i));
    }

  // Wind streaks drift downwind across the whole board.
  g.strokeStyle = "rgba(255,255,255,0.14)";
  g.lineWidth = k * 0.07;
  for (let i = 0; i < 18; i++) {
    const p = ((t / 2400 + hash(i * 7)) % 1) * 1.4 - 0.2;
    const across = hash(i * 13);
    const len = k * 1.3;
    const vertical = s.wind % 2 === 0;
    const along = p * (vertical ? c.height : c.width);
    const side = across * (vertical ? c.width : c.height);
    const forward = s.wind === 1 || s.wind === 2;
    const pos = forward ? along : (vertical ? c.height : c.width) - along;
    const x0 = vertical ? side : pos;
    const y0 = vertical ? pos : side;
    g.beginPath();
    g.moveTo(x0, y0);
    g.lineTo(x0 - DX[s.wind] * len, y0 - DY[s.wind] * len);
    g.stroke();
  }

  // Warning rings on houses the fire can reach soon; the ring fills as it closes in.
  for (let i = 0; i < s.cells.length; i++) {
    const cell = s.cells[i];
    if (cell.kind !== "village" || cell.burnt || cell.fire > 0) continue;
    const eta = v.eta[i] ?? Infinity;
    if (eta >= WARN_TICKS) continue;
    const x = (i % s.w) * k + k / 2;
    const y = Math.floor(i / s.w) * k + k / 2;
    const p = 1 - eta / WARN_TICKS;
    g.lineWidth = k * 0.12;
    g.strokeStyle = "rgba(0,0,0,0.5)";
    g.beginPath();
    g.arc(x, y, k * 0.62, 0, Math.PI * 2);
    g.stroke();
    g.strokeStyle = "#ff5b45";
    g.beginPath();
    g.arc(x, y, k * 0.62, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * p);
    g.stroke();
  }

  if (v.hover && !s.over) {
    const cells = v.tool === "douse" ? DOUSE_SHAPE.map(([dx, dy]) => [v.hover!.x + dx, v.hover!.y + dy]) : [[v.hover.x, v.hover.y]];
    const ok = v.tool === "douse" ? canDouse(s) : canDig(s, v.hover.x, v.hover.y);
    g.strokeStyle = ok ? "#ffd43b" : "rgba(255,91,69,0.8)";
    g.lineWidth = k * 0.08;
    for (const [x, y] of cells) if (x >= 0 && y >= 0 && x < s.w && y < s.h) g.strokeRect(x * k + 3, y * k + 3, k - 6, k - 6);
  }
}

function drawCell(g: CanvasRenderingContext2D, s: State, cell: Cell, x: number, y: number, k: number, i: number, t: number, dugAt?: number) {
  const px = x * k;
  const py = y * k;
  const r = hash(i);
  if (cell.kind === "water") {
    g.fillStyle = C.water;
    g.fillRect(px, py, k, k);
    g.fillStyle = "rgba(220,240,255,0.18)";
    g.fillRect(px + k * 0.2, py + k * (0.45 + 0.05 * Math.sin(t / 500 + r * 6)), k * 0.5, k * 0.07);
    return;
  }
  if (cell.kind === "rock") {
    g.fillStyle = C.rock;
    g.fillRect(px, py, k, k);
    g.fillStyle = "#6b6e71";
    g.fillRect(px + k * 0.2, py + k * 0.3, k * 0.6, k * 0.5);
    return;
  }
  if (cell.burnt) {
    g.fillStyle = C.burnt;
    g.fillRect(px, py, k, k);
    if (cell.kind !== "grass") {
      g.fillStyle = "#141414";
      g.fillRect(px + k * 0.44, py + k * 0.3, k * 0.12, k * 0.5);
    }
    if (Math.sin(t / 260 + r * 20) > 0.9) {
      g.fillStyle = "rgba(255,120,50,0.7)";
      g.fillRect(px + k * r, py + k * hash(i + 3), k * 0.08, k * 0.08);
    }
    return;
  }
  if (cell.dug) {
    // Trenches connect to neighbouring trenches so a dragged line reads as one firebreak (Townscaper).
    const age = dugAt ? Math.min(1, (performance.now() - dugAt) / 160) : 1;
    g.fillStyle = C.grass[Math.floor(r * 3)];
    g.fillRect(px, py, k, k);
    g.fillStyle = C.dug;
    const m = k * 0.18 * age;
    const inset = k * 0.5 - m - k * 0.14 * age;
    g.fillRect(px + inset, py + inset, k - inset * 2, k - inset * 2);
    for (const d of [0, 1, 2, 3] as Dir[]) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= s.w || ny >= s.h || !s.cells[idx(s, nx, ny)].dug) continue;
      if (d === 0) g.fillRect(px + inset, py, k - inset * 2, inset);
      if (d === 2) g.fillRect(px + inset, py + k - inset, k - inset * 2, inset);
      if (d === 3) g.fillRect(px, py + inset, inset, k - inset * 2);
      if (d === 1) g.fillRect(px + k - inset, py + inset, inset, k - inset * 2);
    }
    g.fillStyle = C.trench;
    g.fillRect(px + k * 0.42, py + k * 0.42, k * 0.16, k * 0.16);
    return;
  }
  g.fillStyle = C.grass[Math.floor(r * 3)];
  g.fillRect(px, py, k, k);
  if (cell.kind === "forest") {
    g.fillStyle = C.forest;
    g.fillRect(px, py, k, k);
    g.fillStyle = C.tree;
    for (const [ox, oy] of [[0.28, 0.3], [0.62, 0.42], [0.38, 0.66]] as const) {
      g.beginPath();
      g.moveTo(px + k * ox, py + k * (oy - 0.18));
      g.lineTo(px + k * (ox + 0.14), py + k * (oy + 0.12));
      g.lineTo(px + k * (ox - 0.14), py + k * (oy + 0.12));
      g.fill();
    }
  } else if (cell.kind === "village") {
    g.fillStyle = C.wall;
    g.fillRect(px + k * 0.18, py + k * 0.36, k * 0.64, k * 0.48);
    g.fillStyle = C.roof;
    g.fillRect(px + k * 0.12, py + k * 0.24, k * 0.76, k * 0.16);
    g.fillStyle = "#3b4040";
    g.fillRect(px + k * 0.42, py + k * 0.56, k * 0.16, k * 0.28);
  }
  if (cell.wet > 0) {
    g.fillStyle = `rgba(76,178,255,${0.1 + cell.wet * 0.025})`;
    g.fillRect(px, py, k, k);
  }
  if (cell.fire > 0) {
    const f = 0.55 + 0.45 * Math.sin(t / 80 + r * 30);
    g.fillStyle = `rgba(255,${80 + f * 50},50,${0.75 + f * 0.2})`;
    g.fillRect(px, py, k, k);
    g.fillStyle = `rgba(255,214,90,${0.6 * f})`;
    const h = k * (0.5 + 0.25 * f);
    g.beginPath();
    g.moveTo(px + k * 0.5, py + k * 0.9 - h);
    g.lineTo(px + k * 0.82, py + k * 0.9);
    g.lineTo(px + k * 0.18, py + k * 0.9);
    g.fill();
  }
}
