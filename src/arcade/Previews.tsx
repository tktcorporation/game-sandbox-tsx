import { useEffect, useRef, useState } from "react";
import { newIsland, strikeTarget, DX, DY, type Enemy } from "../games/breakwater/logic";
import { newLevel, step, type State as Fire } from "../games/wildfire/logic";
import { HAZARD_NAME, HAZARDS } from "../games/abyss/logic";

/*
 * The lobby shows each game running on its real rules instead of cover art,
 * so the card itself states what the game is (live demo as the hero).
 */

export function Preview({ id }: { id: string }) {
  if (id === "breakwater") return <BreakwaterPreview />;
  if (id === "wildfire") return <WildfirePreview />;
  return <AbyssPreview />;
}

function BreakwaterPreview() {
  const s = useRef(newIsland(2, 811)).current;
  const T = 20;
  return (
    <svg viewBox={`0 0 ${s.w * T} ${s.h * T}`} className="pv pv-bw" aria-hidden>
      {s.tiles.map((t, i) => {
        const x = (i % s.w) * T;
        const y = Math.floor(i / s.w) * T;
        return (
          <g key={i}>
            <rect x={x} y={y} width={T} height={T} className={`t-${t}`} />
            {t === "house" && <rect x={x + 5} y={y + 6} width={10} height={9} className="house" />}
            {t === "rock" && <rect x={x + 4} y={y + 5} width={12} height={11} rx={3} className="rock" />}
          </g>
        );
      })}
      {s.actors.map((a) => {
        if (a.side !== "enemy") return null;
        const t = strikeTarget(s, a as Enemy);
        return t ? <rect key={`h${a.id}`} x={t.x * T + 1} y={t.y * T + 1} width={T - 2} height={T - 2} className="hit" /> : null;
      })}
      {s.actors.map((a) =>
        a.side === "ally" ? (
          <rect key={a.id} x={a.x * T + 3} y={a.y * T + 3} width={T - 6} height={T - 6} className="ally" />
        ) : (
          <g key={a.id}>
            <circle cx={a.x * T + T / 2} cy={a.y * T + T / 2} r={7} className="enemy" />
            {(a as Enemy).intent !== null && (
              <line
                x1={a.x * T + T / 2}
                y1={a.y * T + T / 2}
                x2={a.x * T + T / 2 + DX[(a as Enemy).intent!] * 14}
                y2={a.y * T + T / 2 + DY[(a as Enemy).intent!] * 14}
                className="arrow"
              />
            )}
          </g>
        ),
      )}
    </svg>
  );
}

function WildfirePreview() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let s: Fire = newLevel(2, 4242);
    let seed = 4242;
    const draw = () => {
      const c = ref.current;
      if (!c) return;
      const g = c.getContext("2d")!;
      const k = c.width / s.w;
      for (let i = 0; i < s.cells.length; i++) {
        const cell = s.cells[i];
        const x = (i % s.w) * k;
        const y = Math.floor(i / s.w) * k;
        g.fillStyle =
          cell.fire > 0 ? (Math.random() < 0.5 ? "#ff6a3d" : "#ffb347")
          : cell.burnt ? "#2b2a28"
          : cell.kind === "water" ? "#3d6475"
          : cell.kind === "rock" ? "#55575a"
          : cell.kind === "village" ? "#e8e4da"
          : cell.kind === "forest" ? "#4d5e45"
          : "#6f7a5e";
        g.fillRect(x, y, k - 1, k - 1);
      }
    };
    draw();
    const t = window.setInterval(() => {
      s = s.over || s.tick > 60 ? newLevel(2, ++seed) : step(s);
      draw();
    }, 220);
    return () => clearInterval(t);
  }, []);
  return <canvas ref={ref} width={280} height={400} className="pv pv-wf" aria-hidden />;
}

const DEMO: ({ g: number } | { h: (typeof HAZARDS)[number] })[] = [{ g: 7 }, { h: "gas" }, { g: 11 }, { g: 5 }, { g: 14 }, { h: "gas" }];

function AbyssPreview() {
  const [n, setN] = useState(1);
  useEffect(() => {
    const t = window.setInterval(() => setN((v) => (v >= DEMO.length + 2 ? 1 : v + 1)), 900);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="pv pv-ab" aria-hidden>
      {DEMO.slice(0, Math.min(n, DEMO.length)).map((c, i) => (
        <div key={i} className={`card ${"g" in c ? "gem" : i === DEMO.length - 1 ? "boom" : "hz"}`}>
          {"g" in c ? <><i />{c.g * (1 + Math.floor(i / 4))}</> : HAZARD_NAME[c.h]}
        </div>
      ))}
    </div>
  );
}
