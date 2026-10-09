import { useEffect, useMemo, useRef, useState } from "react";
import { Frame } from "../../arcade/Frame";
import { shake } from "../../arcade/juice";
import { useSaved } from "../../arcade/save";
import { sfx } from "../../arcade/sfx";
import {
  act, actionTarget, ALLY_SPEC, DIRS, DX, DY, endTurn, ENEMY_SPEC, moveAlly, newIsland, reachable, rest, stars,
  strikeTarget, tileAt,
  type Actor, type Ally, type Dir, type Enemy, type Fx, type State,
} from "./logic";
import "./breakwater.css";

const T = 56;
const islandSeed = (n: number) => Math.imul(n, 7919) + 17;

type Mode = "move" | "act";
interface Save {
  unlocked: number;
  best: Record<number, number>;
}

/** What changes between the current board and a previewed one, drawn as overlays (Into the Breach). */
interface Diff {
  moved: { from: { x: number; y: number }; to: { x: number; y: number }; side: Actor["side"] }[];
  dmg: { x: number; y: number; n: number; dies: boolean }[];
  houses: { x: number; y: number }[];
}

function diff(before: State, after: State): Diff {
  const d: Diff = { moved: [], dmg: [], houses: [] };
  for (const a of before.actors) {
    const b = after.actors.find((o) => o.id === a.id);
    if (!b) d.dmg.push({ x: a.x, y: a.y, n: a.hp, dies: true });
    else {
      if (b.x !== a.x || b.y !== a.y) d.moved.push({ from: { x: a.x, y: a.y }, to: { x: b.x, y: b.y }, side: a.side });
      if (b.hp < a.hp) d.dmg.push({ x: b.x, y: b.y, n: a.hp - b.hp, dies: false });
    }
  }
  before.tiles.forEach((t, i) => {
    if (t === "house" && after.tiles[i] !== "house") d.houses.push({ x: i % before.w, y: Math.floor(i / before.w) });
  });
  return d;
}

const COACH: Record<string, string> = {
  pick: "銛を選ぶ",
  move: "青いマスへ移動",
  aim: "黄色の的でガニを押す",
  confirm: "矢印の先が変わった。もう一度タップで実行",
  tide: "潮を進める",
};

export default function Breakwater() {
  const [save, setSave] = useSaved<Save>("breakwater-v2", { unlocked: 0, best: {} });
  const [state, setState] = useState(() => newIsland(save.unlocked, islandSeed(save.unlocked)));
  const [history, setHistory] = useState<State[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [mode, setMode] = useState<Mode>("move");
  const [pending, setPending] = useState<Dir | null>(null);
  const [acting, setActing] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [fx, setFx] = useState<Fx[]>([]);
  const [picker, setPicker] = useState(false);
  const timers = useRef<number[]>([]);
  const queue = useRef<{ state: State; fx: Fx[] }[]>([]);
  const board = useRef<HTMLDivElement>(null);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const start = (n: number) => {
    timers.current.forEach(clearTimeout);
    setState(newIsland(n, islandSeed(n)));
    setHistory([]);
    setSelected(null);
    setPending(null);
    setPlaying(false);
    setActing(null);
    setFx([]);
    setPicker(false);
  };

  const unit = state.actors.find((a) => a.id === selected);
  const ally = unit?.side === "ally" ? unit : undefined;

  const preview = useMemo(() => (ally && pending !== null ? act(state, ally.id, pending) : null), [state, ally, pending]);
  const shown = preview?.state ?? state;
  const delta = useMemo(() => (preview ? diff(state, preview.state) : null), [state, preview]);

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
    if (s.phase === "won") {
      const st = stars(s);
      setSave((v) => ({
        unlocked: Math.max(v.unlocked, s.island + 1),
        best: { ...v.best, [s.island]: Math.max(v.best[s.island] ?? 0, st) },
      }));
      sfx.win();
    } else if (s.phase === "lost") sfx.lose();
  };

  const play = (f: Fx[]) => {
    setFx(f);
    if (f.some((e) => e.kind === "house")) {
      sfx.house();
      shake(board.current, 8);
    } else if (f.some((e) => e.kind === "drown")) sfx.splash();
    else if (f.some((e) => e.kind === "hit")) {
      sfx.hit();
      shake(board.current, 2);
    } else if (f.some((e) => e.kind === "push")) sfx.push();
    if (f.some((e) => e.kind === "spawn")) sfx.spawn();
    timers.current.push(window.setTimeout(() => setFx([]), 450));
  };

  const tapTile = (x: number, y: number) => {
    if (playing) return fastForward();
    if (state.phase !== "player") return;
    const target = actTiles.find((t) => t.x === x && t.y === y);
    if (ally && target) {
      if (pending === target.d) {
        const r = act(state, ally.id, target.d);
        commit(r.state);
        play(r.fx);
        setPending(null);
        setSelected(null);
        record(r.state);
      } else {
        setPending(target.d);
        sfx.select();
      }
      return;
    }
    setPending(null);
    if (ally && moveTiles.some((t) => t.x === x && t.y === y)) {
      commit(moveAlly(state, ally.id, x, y));
      setMode("act");
      sfx.move();
      return;
    }
    const who = state.actors.find((a) => a.x === x && a.y === y);
    if (who) {
      setSelected(who.id);
      sfx.tap();
      if (who.side === "ally") setMode(who.moved ? "act" : "move");
    } else setSelected(null);
  };

  const undo = () => {
    const prev = history.at(-1);
    if (!prev) return;
    setState(prev);
    setHistory((h) => h.slice(0, -1));
    setPending(null);
    sfx.tap();
  };

  const finish = (last: State) => {
    setPlaying(false);
    setActing(null);
    setHistory([]);
    record(last);
  };

  /** Strikes resolve one enemy at a time so the player can check the plan; a tap skips to the end. */
  const tide = () => {
    if (playing || state.phase !== "player") return;
    setSelected(null);
    setPending(null);
    setPlaying(true);
    const enemies = state.actors.filter((a) => a.side === "enemy" && a.intent !== null).map((a) => a.id);
    const steps = endTurn(state);
    queue.current = steps;
    steps.forEach((step, i) => {
      timers.current.push(window.setTimeout(() => setActing(enemies[i] ?? null), 200 + i * 560));
      timers.current.push(
        window.setTimeout(() => {
          setState(step.state);
          play(step.fx);
          if (i === steps.length - 1) finish(step.state);
        }, 480 + i * 560),
      );
    });
  };

  const fastForward = () => {
    const last = queue.current.at(-1);
    if (!last) return;
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setState(last.state);
    setFx([]);
    finish(last.state);
  };

  const allies = state.actors.filter((a): a is Ally => a.side === "ally");
  const idle = allies.filter((a) => !a.acted).length;
  const threats = shown.actors.filter((a): a is Enemy => a.side === "enemy" && a.intent !== null);
  const enemyOrder = new Map(state.actors.filter((a) => a.side === "enemy").map((e, i) => [e.id, i + 1]));
  const threatened = houseThreats(shown);

  const coach =
    state.island !== 0 || state.phase !== "player" || playing
      ? null
      : pending !== null ? COACH.confirm
      : !ally ? (allies[0]?.acted ? COACH.tide : COACH.pick)
      : !ally.moved ? COACH.move
      : !ally.acted ? COACH.aim
      : COACH.tide;

  return (
    <Frame
      title="防波堤"
      className="bw"
      right={
        <button className="bw-island" onClick={() => setPicker(true)}>
          {state.island === 0 ? "練習" : `島 ${state.island}`}
        </button>
      }
    >
      <div className="bw-hud">
        <div className="bw-tide" aria-label={`潮 ${state.round} / ${state.rounds}`}>
          <span className="lbl">潮</span>
          {Array.from({ length: state.rounds }, (_, i) => (
            <i key={i} className={i < state.round - 1 ? "done" : i === state.round - 1 ? "now" : ""} />
          ))}
        </div>
        <div className="bw-grid" aria-label={`家 ${shown.power} / ${shown.maxPower}`}>
          {Array.from({ length: state.maxPower }, (_, i) => (
            <i key={i} className={i >= shown.power ? "lost" : i >= shown.power - threatened ? "warn" : ""} />
          ))}
          <span className="lbl">家</span>
        </div>
      </div>

      <div className="bw-board-wrap" ref={board} onClick={() => playing && fastForward()}>
        <svg className="bw-board" viewBox={`-4 -22 ${state.w * T + 8} ${state.h * T + 26}`} role="grid">
          <defs>
            <pattern id="bw-hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="7" height="7" fill="rgba(255,91,69,.14)" />
              <line x1="0" y1="0" x2="0" y2="7" stroke="rgba(255,91,69,.7)" strokeWidth="2.4" />
            </pattern>
            <marker id="bw-arrow" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="4.5" markerHeight="4.5" orient="auto">
              <path d="M0 0L10 5L0 10z" fill="var(--threat)" />
            </marker>
            <marker id="bw-push" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="4" markerHeight="4" orient="auto">
              <path d="M0 0L10 5L0 10z" fill="var(--push)" />
            </marker>
          </defs>

          {shown.tiles.map((t, i) => (
            <Tile key={i} t={t} x={i % state.w} y={Math.floor(i / state.w)} doomed={!!delta?.houses.some((h) => h.x === i % state.w && h.y === Math.floor(i / state.w))} />
          ))}

          {threats.map((e) => {
            const t = strikeTarget(shown, e);
            return t ? <rect key={`h${e.id}`} x={t.x * T + 2} y={t.y * T + 2} width={T - 4} height={T - 4} fill="url(#bw-hatch)" className={acting === e.id ? "bw-hot" : ""} /> : null;
          })}

          {shown.spawns.map((sp, i) => (
            <g key={`s${i}`} transform={`translate(${sp.x * T + T / 2} ${sp.y * T + T / 2})`} className="bw-spawn">
              <rect x={-T * 0.34} y={-T * 0.34} width={T * 0.68} height={T * 0.68} />
              <text y="5">{ENEMY_SPEC[sp.kind].name[0]}</text>
            </g>
          ))}

          {moveTiles.map((p) => (
            <rect key={`m${p.x},${p.y}`} className="bw-move" x={p.x * T + 6} y={p.y * T + 6} width={T - 12} height={T - 12} />
          ))}

          {delta?.moved.map((m, i) => (
            <g key={`g${i}`} className="bw-ghost">
              <rect x={m.from.x * T + 10} y={m.from.y * T + 10} width={T - 20} height={T - 20} />
              <line x1={m.from.x * T + T / 2} y1={m.from.y * T + T / 2} x2={m.to.x * T + T / 2 - (m.to.x - m.from.x) * 16} y2={m.to.y * T + T / 2 - (m.to.y - m.from.y) * 16} markerEnd="url(#bw-push)" />
            </g>
          ))}

          {threats.map((e) => (
            <Strike key={`a${e.id}`} s={shown} e={e} hot={acting === e.id} />
          ))}

          {shown.actors.map((a) => (
            <Token key={a.id} a={a} order={a.side === "enemy" ? enemyOrder.get(a.id) : undefined} selected={a.id === selected} spent={a.side === "ally" && a.acted} hot={acting === a.id} />
          ))}

          {delta?.dmg.map((d, i) => (
            <g key={`d${i}`} className={`bw-dmg ${d.dies ? "dies" : ""}`} transform={`translate(${d.x * T + T - 12} ${d.y * T + 12})`}>
              <rect x={-12} y={-10} width={24} height={18} />
              <text y={4}>{d.dies ? "×" : `-${d.n}`}</text>
            </g>
          ))}

          {actTiles.map((p) => (
            <g key={`t${p.d}`} className={`bw-aim ${pending === p.d ? "on" : ""}`} transform={`translate(${p.x * T + T / 2} ${p.y * T + T / 2})`}>
              <rect x={-T * 0.4} y={-T * 0.4} width={T * 0.8} height={T * 0.8} />
              <path d={aimPath(p.d)} />
            </g>
          ))}

          {fx.map((f, i) => (
            <rect key={`f${i}`} className={`bw-fx ${f.kind}`} x={f.x * T + 4} y={f.y * T + 4} width={T - 8} height={T - 8} />
          ))}

          {shown.tiles.map((_, i) => {
            const x = i % state.w;
            const y = Math.floor(i / state.w);
            return <rect key={`hit${i}`} x={x * T} y={y * T} width={T} height={T} fill="transparent" onClick={(e) => { e.stopPropagation(); tapTile(x, y); }} />;
          })}
        </svg>
        {coach && <div className="bw-coach">{coach}</div>}
        {playing && <div className="bw-coach dim">タップで早送り</div>}
      </div>

      <div className="bw-dock">
        <div className="bw-units">
          {(["harpoon", "cannon", "chain"] as const).map((kind) => {
            const a = allies.find((u) => u.kind === kind);
            if (!a && state.island === 0) return null;
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
                  sfx.tap();
                }}
              >
                <span className="k">{spec.name}</span>
                <span className="hp">{Array.from({ length: spec.hp }, (_, i) => <i key={i} className={a && i < a.hp ? "on" : ""} />)}</span>
                <span className="st">{!a ? "沈黙" : a.acted ? "行動済" : a.moved ? spec.verb : `移動 ${spec.move}`}</span>
              </button>
            );
          })}
        </div>

        <div className="bw-panel">
          {ally ? (
            <>
              <p className="bw-help">
                <b>{ALLY_SPEC[ally.kind].verb}</b>
                {ALLY_SPEC[ally.kind].text}
              </p>
              <div className="bw-modes">
                <button className={mode === "move" ? "on" : ""} disabled={ally.moved || ally.acted} onClick={() => { setMode("move"); setPending(null); }}>移動</button>
                <button className={mode === "act" ? "on" : ""} disabled={ally.acted} onClick={() => setMode("act")}>{ALLY_SPEC[ally.kind].verb}</button>
                <button disabled={ally.acted} onClick={() => { commit(rest(state, ally.id)); setSelected(null); }}>待機</button>
              </div>
            </>
          ) : unit?.side === "enemy" ? (
            <p className="bw-help">
              <b className="threat">{ENEMY_SPEC[unit.kind].name}</b>
              体力 {unit.hp} · {ENEMY_SPEC[unit.kind].ranged ? "直線上の最初の相手" : "隣の 1 マス"}に {ENEMY_SPEC[unit.kind].dmg} · {enemyOrder.get(unit.id)} 番目
            </p>
          ) : (
            <p className="bw-help muted">斜線のマスが、潮が変わると攻撃される。</p>
          )}
        </div>

        <div className="bw-actions">
          <button className="btn ghost" disabled={!history.length || playing} onClick={undo}>戻す</button>
          <button className="btn primary" disabled={playing || state.phase !== "player"} onClick={tide}>
            潮を進める
            {idle > 0 && !playing ? <small>{idle} 体が未行動</small> : null}
          </button>
        </div>
      </div>

      {state.phase !== "player" && !playing && (
        <div className="sheet-wrap">
          <div className="sheet">
            <h2 className={state.phase === "won" ? "" : "threat"}>{state.phase === "won" ? "守り切った" : "島は沈んだ"}</h2>
            {state.phase === "won" ? (
              <div className="stars">{[1, 2, 3].map((i) => <span key={i} className={i <= stars(state) ? "on" : ""}>★</span>)}</div>
            ) : (
              <p className="bw-why">{allies.length === 0 ? "守り手が全員倒れた" : "家がすべて壊れた"}。同じ盤面でやり直せる。</p>
            )}
            <p className="bw-why num">残った家 {state.power}/{state.maxPower} · 撃退 {state.kills}</p>
            <div className="row">
              <button className="btn ghost" onClick={() => start(state.island)}>もう一度</button>
              {state.phase === "won" ? (
                <button className="btn primary" onClick={() => start(state.island + 1)}>{state.island === 0 ? "島 1 へ" : "次の島へ"}</button>
              ) : (
                <button className="btn primary" onClick={() => start(state.island)}>同じ島をやり直す</button>
              )}
            </div>
          </div>
        </div>
      )}

      {picker && (
        <div className="sheet-wrap" onClick={() => setPicker(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h2>島を選ぶ</h2>
            <div className="level-grid">
              {Array.from({ length: save.unlocked + 1 }, (_, i) => i).map((n) => (
                <button key={n} onClick={() => start(n)} className={n === state.island ? "on" : ""}>
                  <b>{n === 0 ? "練" : n}</b>
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

function houseThreats(s: State): number {
  const hit = new Set<string>();
  for (const a of s.actors) {
    if (a.side !== "enemy") continue;
    const t = strikeTarget(s, a);
    if (t && tileAt(s, t.x, t.y) === "house") hit.add(`${t.x},${t.y}`);
  }
  return hit.size;
}

function Tile({ t, x, y, doomed }: { t: State["tiles"][number]; x: number; y: number; doomed: boolean }) {
  const px = x * T;
  const py = y * T;
  if (t === "water")
    return (
      <g className="bw-water">
        <rect x={px} y={py} width={T} height={T} />
        <path d={`M${px + 12} ${py + 26} h10 M${px + 30} ${py + 34} h12`} />
      </g>
    );
  return (
    <g>
      <rect className={`bw-ground ${(x + y) % 2 ? "alt" : ""} ${t === "rubble" ? "rubble" : ""}`} x={px + 1} y={py + 1} width={T - 2} height={T - 2} />
      {t === "rock" && <path className="bw-rock" d={`M${px + 12} ${py + 44} L${px + 16} ${py + 18} L${px + 30} ${py + 11} L${px + 44} ${py + 22} L${px + 44} ${py + 44} Z`} />}
      {t === "house" && (
        <g className={`bw-house ${doomed ? "doomed" : ""}`}>
          <rect x={px + 12} y={py + 20} width={32} height={26} />
          <rect className="roof" x={px + 9} y={py + 14} width={38} height={8} />
          <rect className="win" x={px + 18} y={py + 28} width={6} height={6} />
          <rect className="win" x={px + 32} y={py + 28} width={6} height={6} />
        </g>
      )}
      {t === "rubble" && <path className="bw-ruin" d={`M${px + 12} ${py + 44} l8 -8 l6 4 l8 -10 l10 14 Z`} />}
    </g>
  );
}

function Token({ a, order, selected, spent, hot }: { a: Actor; order?: number; selected: boolean; spent: boolean; hot: boolean }) {
  const cx = a.x * T + T / 2;
  const cy = a.y * T + T / 2;
  const isAlly = a.side === "ally";
  const label = isAlly ? ALLY_SPEC[a.kind].name : ENEMY_SPEC[a.kind].name[0];
  return (
    <g className={`bw-token ${a.side} ${a.kind} ${selected ? "sel" : ""} ${spent ? "spent" : ""} ${hot ? "hot" : ""}`} style={{ transform: `translate(${cx}px, ${cy}px)` }}>
      {isAlly ? <rect x={-19} y={-19} width={38} height={38} /> : <path d="M0 -21 L21 0 L0 21 L-21 0Z" />}
      <text y={6}>{label}</text>
      <g transform="translate(0 25)">
        {Array.from({ length: a.maxHp }, (_, i) => (
          <rect key={i} className={i < a.hp ? "pip on" : "pip"} x={(i - a.maxHp / 2) * 7 + 0.5} y={-2} width={6} height={4} />
        ))}
      </g>
      {!isAlly && order !== undefined && (a as Enemy).intent !== null && (
        <g transform="translate(0 -30)" className="bw-intent">
          <rect x={-17} y={-8} width={34} height={15} />
          <text y={3.5}>
            {order}·⚔{ENEMY_SPEC[a.kind].dmg}
          </text>
        </g>
      )}
    </g>
  );
}

function Strike({ s, e, hot }: { s: State; e: Enemy; hot: boolean }) {
  const t = strikeTarget(s, e);
  if (e.intent === null) return null;
  const sx = e.x * T + T / 2 + DX[e.intent] * 22;
  const sy = e.y * T + T / 2 + DY[e.intent] * 22;
  const end = t ?? { x: e.x + DX[e.intent] * 1.4, y: e.y + DY[e.intent] * 1.4 };
  const ex = end.x * T + T / 2 - DX[e.intent] * 12;
  const ey = end.y * T + T / 2 - DY[e.intent] * 12;
  return (
    <g className={`bw-strike ${ENEMY_SPEC[e.kind].ranged ? "ranged" : ""} ${hot ? "hot" : ""}`}>
      <line x1={sx} y1={sy} x2={ex} y2={ey} markerEnd="url(#bw-arrow)" />
    </g>
  );
}

function aimPath(d: Dir) {
  const r = 9;
  return [
    `M${-r} ${r / 2} L0 ${-r / 2} L${r} ${r / 2}`,
    `M${-r / 2} ${-r} L${r / 2} 0 L${-r / 2} ${r}`,
    `M${-r} ${-r / 2} L0 ${r / 2} L${r} ${-r / 2}`,
    `M${r / 2} ${-r} L${-r / 2} 0 L${r / 2} ${r}`,
  ][d];
}
