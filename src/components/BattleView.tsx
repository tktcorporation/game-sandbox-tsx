import { useEffect, useRef, useState } from "react";
import { GRID_SIZE, BUILDINGS, TROOPS, TROOP_ORDER } from "../game/buildings";
import { Battle, type EnemyBase } from "../game/battle";
import type { BattleStats } from "../game/battle";
import { useGame } from "../game/store";
import { formatNumber } from "../game/logic";
import type { TroopType } from "../game/types";
import { useUi } from "../ui";

const EMOJI: Record<string, string> = Object.fromEntries(
  Object.values(BUILDINGS).map((d) => [d.type, d.emoji]),
);

export function BattleView({ base, onExit }: { base: EnemyBase; onExit: () => void }) {
  const army = useGame((s) => s.army);
  const applyBattleResult = useGame((s) => s.applyBattleResult);
  const showToast = useUi((s) => s.showToast);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const battleRef = useRef<Battle>(new Battle(base));
  const [selected, setSelected] = useState<TroopType>(
    TROOP_ORDER.find((t) => army[t] > 0) ?? "barbarian",
  );
  const [stats, setStats] = useState<BattleStats>(battleRef.current.stats());
  const [finished, setFinished] = useState(false);
  const finishedRef = useRef(false);
  const remainingRef = useRef<Record<TroopType, number>>({ ...army });

  // main render + simulation loop
  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    let raf = 0;
    let last = performance.now();
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    const resize = () => {
      const r = canvas.getBoundingClientRect();
      canvas.width = r.width * dpr;
      canvas.height = r.height * dpr;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const frame = (t: number) => {
      const dt = Math.min(0.05, (t - last) / 1000);
      last = t;
      const battle = battleRef.current;
      if (!finishedRef.current) battle.step(dt);

      const W = canvas.width;
      const H = canvas.height;
      const side = Math.min(W, H);
      const cell = side / GRID_SIZE;
      const ox = (W - side) / 2;
      const oy = (H - side) / 2;
      const gx = (v: number) => ox + v * cell;
      const gy = (v: number) => oy + v * cell;

      ctx.clearRect(0, 0, W, H);
      // board
      ctx.fillStyle = "#5e9c48";
      ctx.fillRect(ox, oy, side, side);
      ctx.strokeStyle = "rgba(0,0,0,0.12)";
      ctx.lineWidth = 1;
      for (let i = 0; i <= GRID_SIZE; i++) {
        ctx.beginPath();
        ctx.moveTo(gx(i), oy);
        ctx.lineTo(gx(i), oy + side);
        ctx.moveTo(ox, gy(i));
        ctx.lineTo(ox + side, gy(i));
        ctx.stroke();
      }

      // defense ranges
      for (const tg of battle.targets) {
        if (tg.hp <= 0 || !tg.isDefense) continue;
        ctx.beginPath();
        ctx.fillStyle = "rgba(255,80,80,0.06)";
        ctx.arc(gx(tg.cx), gy(tg.cy), tg.range * cell, 0, Math.PI * 2);
        ctx.fill();
      }

      // buildings
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (const tg of battle.targets) {
        if (tg.hp <= 0) continue;
        const px = gx(tg.cx - tg.size / 2);
        const py = gy(tg.cy - tg.size / 2);
        const s = tg.size * cell;
        ctx.fillStyle = tg.type === "wall" ? "#7a542f" : "rgba(20,40,15,0.35)";
        roundRect(ctx, px + 2, py + 2, s - 4, s - 4, 5);
        ctx.fill();
        if (tg.type !== "wall") {
          ctx.font = `${s * 0.5}px serif`;
          ctx.fillText(EMOJI[tg.type] ?? "❓", gx(tg.cx), gy(tg.cy));
        }
        // hp bar
        const hpFrac = tg.hp / tg.maxHp;
        if (hpFrac < 1) {
          ctx.fillStyle = "#000";
          ctx.fillRect(px + 4, py - 2, s - 8, 4);
          ctx.fillStyle = hpFrac > 0.4 ? "#5fd35f" : "#e04a4a";
          ctx.fillRect(px + 4, py - 2, (s - 8) * hpFrac, 4);
        }
      }

      // units
      for (const u of battle.units) {
        if (u.hp <= 0) continue;
        const px = gx(u.x);
        const py = gy(u.y);
        ctx.beginPath();
        ctx.fillStyle = u.attackFlash > 0 ? "#fff3a0" : "rgba(40,90,200,0.85)";
        ctx.arc(px, py, cell * 0.42, 0, Math.PI * 2);
        ctx.fill();
        ctx.font = `${cell * 0.6}px serif`;
        ctx.fillText(TROOPS[u.type].emoji, px, py);
        const hpFrac = u.hp / u.maxHp;
        if (hpFrac < 1) {
          ctx.fillStyle = "#000";
          ctx.fillRect(px - cell * 0.4, py - cell * 0.55, cell * 0.8, 3);
          ctx.fillStyle = "#5fd35f";
          ctx.fillRect(px - cell * 0.4, py - cell * 0.55, cell * 0.8 * hpFrac, 3);
        }
      }

      // explosions
      for (const e of battle.explosionList) {
        ctx.font = `${cell * (1.2 - e.t)}px serif`;
        ctx.fillText("💥", gx(e.x), gy(e.y));
      }

      const s = battle.stats();
      setStats(s);
      if (s.over && !finishedRef.current) {
        finishedRef.current = true;
        setFinished(true);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  const deploy = (e: React.PointerEvent) => {
    if (finishedRef.current) return;
    if (remainingRef.current[selected] <= 0) {
      showToast("No more " + TROOPS[selected].name + "s");
      return;
    }
    const canvas = canvasRef.current!;
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = canvas.width;
    const H = canvas.height;
    const side = Math.min(W, H);
    const cell = side / GRID_SIZE;
    const ox = (W - side) / 2;
    const oy = (H - side) / 2;
    const px = (e.clientX - r.left) * dpr;
    const py = (e.clientY - r.top) * dpr;
    const tx = (px - ox) / cell;
    const ty = (py - oy) / cell;
    if (tx < 0 || ty < 0 || tx > GRID_SIZE || ty > GRID_SIZE) return;
    battleRef.current.spawn(selected, tx, ty);
    remainingRef.current = { ...remainingRef.current, [selected]: remainingRef.current[selected] - 1 };
    // force re-render of dock counts
    setStats(battleRef.current.stats());
  };

  const endBattle = () => {
    const res = battleRef.current.result();
    applyBattleResult({
      loot: res.loot,
      trophies: res.trophies,
      armyUsed: battleRef.current.used,
    });
    onExit();
  };

  const totalArmy = TROOP_ORDER.reduce((n, t) => n + army[t], 0);
  const res = finished ? battleRef.current.result() : null;

  return (
    <div className="battle-root">
      <canvas ref={canvasRef} className="battle-canvas" onPointerDown={deploy} />
      <div className="battle-hud">
        <div className="chip">⏱ {Math.ceil(stats.timeLeft)}s</div>
        <div className="chip stars">{"★".repeat(stats.stars)}{"☆".repeat(3 - stats.stars)}</div>
        <div className="chip">💥 {Math.round(stats.destructionPct * 100)}%</div>
      </div>

      <div className="troop-dock">
        {TROOP_ORDER.map((type) => {
          const remaining = remainingRef.current[type];
          return (
            <button
              key={type}
              className={`troop-btn ${selected === type ? "active" : ""}`}
              disabled={remaining <= 0}
              onClick={() => setSelected(type)}
            >
              <span className="cnt">{remaining}</span>
              <span className="big">{TROOPS[type].emoji}</span>
              <span className="nm">{TROOPS[type].name}</span>
            </button>
          );
        })}
        <button
          className="troop-btn"
          onClick={() => {
            finishedRef.current = true;
            setFinished(true);
          }}
        >
          <span className="big">🏁</span>
          <span className="nm">End</span>
        </button>
      </div>

      {totalArmy === 0 && !finished && (
        <div className="result-overlay">
          <div className="result-card">
            <h2>No army!</h2>
            <p>Train troops at the Barracks before attacking.</p>
            <button className="btn primary" onClick={onExit}>
              Back to village
            </button>
          </div>
        </div>
      )}

      {finished && res && (
        <div className="result-overlay">
          <div className="result-card">
            <h2>{stats.stars > 0 ? "Victory!" : "Defeated"}</h2>
            <div className="big-stars">
              {"★".repeat(stats.stars)}
              {"☆".repeat(3 - stats.stars)}
            </div>
            <p>{Math.round(stats.destructionPct * 100)}% destroyed</p>
            <div className="loot-row">
              <span className="ct gold">🪙 +{formatNumber(res.loot.gold)}</span>
              <span className="ct elixir">🧪 +{formatNumber(res.loot.elixir)}</span>
            </div>
            <div className="loot-row">
              <span style={{ color: res.trophies >= 0 ? "#ff9d3c" : "#e04a4a" }}>
                🏆 {res.trophies >= 0 ? "+" : ""}
                {res.trophies}
              </span>
            </div>
            <button className="btn primary" onClick={endBattle}>
              Return to village
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
