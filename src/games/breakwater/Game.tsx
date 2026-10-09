import { useEffect, useMemo, useRef, useState } from "react";
import { Frame } from "../../arcade/Frame";
import { useSaved } from "../../arcade/save";
import {
  act, actionTarget, ALLY_SPEC, DIRS, endTurn, ENEMY_SPEC, moveAlly, newIsland, reachable, rest, stars,
  strikeTarget, tileAt, DX, DY,
  type Actor, type Ally, type Dir, type Enemy, type Fx, type State,
} from "./logic";
import "./breakwater.css";

const T = 56; // tile size in SVG units
const islandSeed = (n: number) => Math.imul(n, 7919) + 17;

type Mode = "move" | "act";
interface Save {
  unlocked: number;
  best: Record<number, number>;
}

export default function Breakwater() {
  const [save, setSave] = useSaved<Save>("breakwater", { unlocked: 1, best: {} });
  const [island, setIsland] = useState(save.unlocked);
  const [state, setState] = useState(() => newIsland(island, islandSeed(island)));
  const [history, setHistory] = useState<State[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [mode, setMode] = useState<Mode>("move");
  const [pending, setPending] = useState<Dir | null>(null);
  const [playing, setPlaying] = useState(false);
  const [fx, setFx] = useState<Fx[]>([]);
  const [picker, setPicker] = useState(false);
  const timers = useRef<number[]>([]);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const start = (n: number) => {
    timers.current.forEach(clearTimeout);
    setIsland(n);
    setState(newIsland(n, islandSeed(n)));
    setHistory([]);
    setSelected(null);
    setPending(null);
    setPlaying(false);
    setFx([]);
    setPicker(false);
  };

  const unit = state.actors.find((a) => a.id === selected);
  const ally = unit?.side === "ally" ? unit : undefined;

  const preview = useMemo(() => {
    if (!ally || pending === null) return null;
    return act(state, ally.id, pending);
  }, [state, ally, pending]);
  const shown = preview?.state ?? state;

  const moveTiles = useMemo(() => {
    if (!ally || mode !== "move" || ally.moved || ally.acted || playing) return [];
    return reachable(state, ally, ALLY_SPEC[ally.kind].move);
  }, [state, ally, mode, playing]);

  const actTiles = useMemo(() => {
    if (!ally || mode !== "act" || ally.acted || playing) return [];
    return DIRS.flatMap((d) => {
      const t = actionTarget(state, ally, d);
      return t ? [{ ...t, d }] : [];
    });
  }, [state, ally, mode, playing]);

  const commit = (next: State) => {
    setHistory((h) => [...h, state]);
    setState(next);
  };

  const record = (s: State) => {
    if (s.phase !== "won") return;
    const st = stars(s);
    setSave((v) => ({
      unlocked: Math.max(v.unlocked, s.island + 1),
      best: { ...v.best, [s.island]: Math.max(v.best[s.island] ?? 0, st) },
    }));
  };

  const tapTile = (x: number, y: number) => {
    if (playing || state.phase !== "player") return;
    const target = actTiles.find((t) => t.x === x && t.y === y);
    if (ally && target) {
      if (pending === target.d) {
        const r = act(state, ally.id, target.d);
        commit(r.state);
        flash(r.fx);
        setPending(null);
        setSelected(null);
        record(r.state);
      } else setPending(target.d);
      return;
    }
    setPending(null);
    if (ally && moveTiles.some((t) => t.x === x && t.y === y)) {
      commit(moveAlly(state, ally.id, x, y));
      setMode("act");
      return;
    }
    const who = state.actors.find((a) => a.x === x && a.y === y);
    if (who) {
      setSelected(who.id);
      if (who.side === "ally") setMode(who.moved ? "act" : "move");
    } else setSelected(null);
  };

  const flash = (f: Fx[]) => {
    setFx(f);
    timers.current.push(window.setTimeout(() => setFx([]), 420));
  };

  const undo = () => {
    const prev = history.at(-1);
    if (!prev) return;
    setState(prev);
    setHistory((h) => h.slice(0, -1));
    setPending(null);
  };

  const tide = () => {
    if (playing || state.phase !== "player") return;
    setSelected(null);
    setPending(null);
    setPlaying(true);
    const steps = endTurn(state);
    steps.forEach((step, i) => {
      timers.current.push(
        window.setTimeout(() => {
          setState(step.state);
          flash(step.fx);
          if (i === steps.length - 1) {
            setPlaying(false);
            setHistory([]);
            record(step.state);
          }
        }, 380 + i * 520),
      );
    });
  };

  const allies = state.actors.filter((a): a is Ally => a.side === "ally");
  const idle = allies.filter((a) => !a.acted).length;
  const threats = shown.actors.filter((a): a is Enemy => a.side === "enemy" && a.intent !== null);
  const enemyOrder = new Map(state.actors.filter((a) => a.side === "enemy").map((e, i) => [e.id, i + 1]));

  return (
    <Frame
      title="防波堤"
      className="bw"
      right={
        <button className="bw-island" onClick={() => setPicker(true)}>
          島 {state.island}
        </button>
      }
    >
      <div className="bw-status">
        <div className="bw-round" aria-label={`ターン ${state.round} / ${state.rounds}`}>
          {Array.from({ length: state.rounds }, (_, i) => (
            <span key={i} className={i < state.round - 1 ? "done" : i === state.round - 1 ? "now" : ""} />
          ))}
          <b>潮 {state.round}/{state.rounds}</b>
        </div>
        <div className="bw-power" aria-label={`家 ${shown.power} / ${shown.maxPower}`}>
          {Array.from({ length: state.maxPower }, (_, i) => (
            <HouseIcon key={i} lost={i >= shown.power} warn={i >= shown.power - countHouseThreats(shown)} />
          ))}
        </div>
      </div>

      <div className="bw-board-wrap">
        <svg className="bw-board" viewBox={`-6 -6 ${state.w * T + 12} ${state.h * T + 12}`} role="grid">
          <defs>
            <pattern id="bw-hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="8" height="8" fill="rgba(226,96,63,.18)" />
              <line x1="0" y1="0" x2="0" y2="8" stroke="rgba(226,96,63,.55)" strokeWidth="3" />
            </pattern>
            <marker id="bw-arrow" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="5" markerHeight="5" orient="auto">
              <path d="M0 0L10 5L0 10z" fill="#e2603f" />
            </marker>
          </defs>

          {shown.tiles.map((t, i) => {
            const x = i % state.w;
            const y = Math.floor(i / state.w);
            return <Tile key={i} t={t} x={x} y={y} />;
          })}

          {threats.map((e) => {
            const t = strikeTarget(shown, e);
            return t ? <rect key={`h${e.id}`} x={t.x * T + 2} y={t.y * T + 2} width={T - 4} height={T - 4} rx="6" fill="url(#bw-hatch)" /> : null;
          })}

          {shown.spawns.map((sp, i) => (
            <g key={`s${i}`} transform={`translate(${sp.x * T + T / 2} ${sp.y * T + T / 2})`} className="bw-spawn">
              <circle r={T * 0.34} />
              <text y="5">{ENEMY_SPEC[sp.kind].name[0]}</text>
            </g>
          ))}

          {moveTiles.map((p) => (
            <rect key={`m${p.x},${p.y}`} className="bw-move" x={p.x * T + 5} y={p.y * T + 5} width={T - 10} height={T - 10} rx="8" />
          ))}

          {threats.map((e) => (
            <Strike key={`a${e.id}`} s={shown} e={e} />
          ))}

          {shown.actors.map((a) => (
            <Token
              key={a.id}
              a={a}
              order={a.side === "enemy" ? enemyOrder.get(a.id) : undefined}
              selected={a.id === selected}
              spent={a.side === "ally" && a.acted}
            />
          ))}

          {actTiles.map((p) => (
            <g key={`t${p.d}`} className={`bw-aim ${pending === p.d ? "on" : ""}`} transform={`translate(${p.x * T + T / 2} ${p.y * T + T / 2})`}>
              <circle r={T * 0.42} />
              <path d={aimPath(p.d)} />
            </g>
          ))}

          {fx.map((f, i) => (
            <circle key={`f${i}`} className={`bw-fx ${f.kind}`} cx={f.x * T + T / 2} cy={f.y * T + T / 2} r={T * 0.45} />
          ))}

          {shown.tiles.map((_, i) => {
            const x = i % state.w;
            const y = Math.floor(i / state.w);
            return <rect key={`hit${i}`} x={x * T} y={y * T} width={T} height={T} fill="transparent" onClick={() => tapTile(x, y)} />;
          })}
        </svg>
        {pending !== null && <div className="bw-hint">結果をプレビュー中 · もう一度タップで実行</div>}
      </div>

      <div className="bw-units">
        {(["harpoon", "cannon", "chain"] as const).map((kind) => {
          const a = allies.find((u) => u.kind === kind);
          const spec = ALLY_SPEC[kind];
          return (
            <button
              key={kind}
              className={`bw-unit ${a && a.id === selected ? "sel" : ""} ${!a ? "dead" : a.acted ? "spent" : ""}`}
              disabled={!a || playing}
              onClick={() => {
                if (!a) return;
                setSelected(a.id);
                setPending(null);
                setMode(a.moved ? "act" : "move");
              }}
            >
              <span className="k">{spec.name}</span>
              <span className="hp">{a ? Array.from({ length: a.maxHp }, (_, i) => <i key={i} className={i < a.hp ? "on" : ""} />) : "沈黙"}</span>
              <span className="st">{!a ? "" : a.acted ? "済" : a.moved ? "移動済" : `移動 ${spec.move}`}</span>
            </button>
          );
        })}
      </div>

      <div className="bw-panel">
        {ally ? (
          <>
            <p className="bw-help">
              <b>{ALLY_SPEC[ally.kind].verb}</b> {ALLY_SPEC[ally.kind].text}
            </p>
            <div className="bw-modes">
              <button className={mode === "move" ? "on" : ""} disabled={ally.moved || ally.acted} onClick={() => { setMode("move"); setPending(null); }}>移動</button>
              <button className={mode === "act" ? "on" : ""} disabled={ally.acted} onClick={() => setMode("act")}>{ALLY_SPEC[ally.kind].verb}</button>
              <button disabled={ally.acted} onClick={() => { commit(rest(state, ally.id)); setSelected(null); }}>待機</button>
            </div>
          </>
        ) : unit?.side === "enemy" ? (
          <p className="bw-help">
            <b>{ENEMY_SPEC[unit.kind].name}</b> 体力 {unit.hp}/{unit.maxHp} · {ENEMY_SPEC[unit.kind].ranged ? "直線上の最初の相手" : "隣の 1 マス"}に {ENEMY_SPEC[unit.kind].dmg} ダメージ · {enemyOrder.get(unit.id)} 番目に動く
          </p>
        ) : (
          <p className="bw-help muted">赤い斜線のマスが、潮が変わると攻撃される。駒を選んで、矢印の先を家から逸らす。</p>
        )}
      </div>

      <div className="bw-actions">
        <button className="ghost" disabled={!history.length || playing} onClick={undo}>戻す</button>
        <button className="primary" disabled={playing || state.phase !== "player"} onClick={tide}>
          潮を進める{idle > 0 && !playing ? <small>{idle} 体が未行動</small> : null}
        </button>
      </div>

      {state.phase !== "player" && !playing && (
        <div className="bw-over">
          <div className="card">
            <h2>{state.phase === "won" ? "島を守った" : "島は沈んだ"}</h2>
            {state.phase === "won" ? (
              <div className="bw-stars">{[1, 2, 3].map((i) => <span key={i} className={i <= stars(state) ? "on" : ""}>★</span>)}</div>
            ) : (
              <p>{allies.length === 0 ? "守り手が全員倒れた。" : "家がすべて壊された。"}同じ島を何度でもやり直せる。</p>
            )}
            <p className="sub">残った家 {state.power}/{state.maxPower} · 撃退 {state.kills}</p>
            <div className="row">
              <button className="ghost" onClick={() => start(state.island)}>もう一度</button>
              {state.phase === "won" && <button className="primary" onClick={() => start(state.island + 1)}>次の島へ</button>}
            </div>
          </div>
        </div>
      )}

      {picker && (
        <div className="bw-over" onClick={() => setPicker(false)}>
          <div className="card" onClick={(e) => e.stopPropagation()}>
            <h2>島を選ぶ</h2>
            <div className="bw-isles">
              {Array.from({ length: Math.max(save.unlocked, 1) }, (_, i) => i + 1).map((n) => (
                <button key={n} onClick={() => start(n)} className={n === state.island ? "on" : ""}>
                  <b>{n}</b>
                  <span>{"★".repeat(save.best[n] ?? 0) || "—"}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </Frame>
  );
}

function countHouseThreats(s: State): number {
  const hit = new Set<string>();
  for (const a of s.actors) {
    if (a.side !== "enemy") continue;
    const t = strikeTarget(s, a);
    if (t && tileAt(s, t.x, t.y) === "house") hit.add(`${t.x},${t.y}`);
  }
  return hit.size;
}

function Tile({ t, x, y }: { t: State["tiles"][number]; x: number; y: number }) {
  const px = x * T;
  const py = y * T;
  if (t === "water")
    return (
      <g className="bw-water">
        <rect x={px} y={py} width={T} height={T} />
        <path d={`M${px + 10} ${py + 24} q7 -6 14 0 t14 0 M${px + 18} ${py + 38} q7 -6 14 0 t14 0`} />
      </g>
    );
  return (
    <g>
      <rect className={`bw-ground ${(x + y) % 2 ? "alt" : ""} ${t === "rubble" ? "rubble" : ""}`} x={px} y={py} width={T} height={T} />
      {t === "rock" && <path className="bw-rock" d={`M${px + 10} ${py + 44} L${px + 18} ${py + 18} L${px + 32} ${py + 12} L${px + 46} ${py + 26} L${px + 46} ${py + 44} Z`} />}
      {t === "house" && (
        <g className="bw-house">
          <rect x={px + 13} y={py + 26} width={30} height={20} />
          <path d={`M${px + 9} ${py + 28} L${px + 28} ${py + 12} L${px + 47} ${py + 28} Z`} />
          <rect className="door" x={px + 24} y={py + 34} width={8} height={12} />
        </g>
      )}
      {t === "rubble" && <path className="bw-ruin" d={`M${px + 14} ${py + 42} l8 -10 l6 6 l8 -12 l6 16 Z`} />}
    </g>
  );
}

function Token({ a, order, selected, spent }: { a: Actor; order?: number; selected: boolean; spent: boolean }) {
  const cx = a.x * T + T / 2;
  const cy = a.y * T + T / 2;
  const label = a.side === "ally" ? ALLY_SPEC[a.kind].name : ENEMY_SPEC[a.kind].name[0];
  return (
    <g className={`bw-token ${a.side} ${a.kind} ${selected ? "sel" : ""} ${spent ? "spent" : ""}`} style={{ transform: `translate(${cx}px, ${cy}px)` }}>
      {a.side === "ally" ? <rect x={-20} y={-20} width={40} height={40} rx={9} /> : <circle r={19} />}
      <text y={6}>{label}</text>
      <g transform="translate(0 25)">
        {Array.from({ length: a.maxHp }, (_, i) => (
          <rect key={i} className={i < a.hp ? "pip on" : "pip"} x={(i - a.maxHp / 2) * 8 + 1} y={-3} width={6} height={5} rx={1} />
        ))}
      </g>
      {order !== undefined && (
        <g transform="translate(16 -16)" className="bw-order">
          <circle r={8} />
          <text y={3.5}>{order}</text>
        </g>
      )}
    </g>
  );
}

function Strike({ s, e }: { s: State; e: Enemy }) {
  const t = strikeTarget(s, e);
  if (e.intent === null) return null;
  const sx = e.x * T + T / 2 + DX[e.intent] * 20;
  const sy = e.y * T + T / 2 + DY[e.intent] * 20;
  const end = t ?? { x: e.x + DX[e.intent] * 1.4, y: e.y + DY[e.intent] * 1.4 };
  const ex = end.x * T + T / 2 - DX[e.intent] * 14;
  const ey = end.y * T + T / 2 - DY[e.intent] * 14;
  return (
    <g className={`bw-strike ${ENEMY_SPEC[e.kind].ranged ? "ranged" : ""}`}>
      <line x1={sx} y1={sy} x2={ex} y2={ey} markerEnd="url(#bw-arrow)" />
      {t && (
        <text className="bw-dmg" x={t.x * T + T - 10} y={t.y * T + 16}>
          {ENEMY_SPEC[e.kind].dmg}
        </text>
      )}
    </g>
  );
}

function aimPath(d: Dir) {
  const r = 10;
  const pts = [
    `M${-r} ${r / 2} L0 ${-r / 2} L${r} ${r / 2}`,
    `M${-r / 2} ${-r} L${r / 2} 0 L${-r / 2} ${r}`,
    `M${-r} ${-r / 2} L0 ${r / 2} L${r} ${-r / 2}`,
    `M${r / 2} ${-r} L${-r / 2} 0 L${r / 2} ${r}`,
  ];
  return pts[d];
}

function HouseIcon({ lost, warn }: { lost: boolean; warn: boolean }) {
  return (
    <svg viewBox="0 0 20 20" className={`bw-hicon ${lost ? "lost" : warn ? "warn" : ""}`} aria-hidden>
      <path d="M2 10L10 3l8 7v8H2z" />
    </svg>
  );
}
