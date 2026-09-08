import { useEffect, useRef, useState } from "react";
import { TROOPS, TROOP_ORDER } from "../game/buildings";
import { Battle, type EnemyBase } from "../game/battle";
import type { BattleStats } from "../game/battle";
import { useGame } from "../game/store";
import { formatNumber } from "../game/logic";
import type { TroopType } from "../game/types";
import { useUi } from "../ui";
import { GameIcon, IconText } from "../ui/icons";
import { Pixel, PixelText } from "../assets/Pixel";
import { RESOURCE_PIXEL, TROOP_PIXEL } from "../assets/kenney";
import {
  buildDecorations,
  dayLight,
  drawAtmosphere,
  drawBuilding,
  drawDeployZone,
  drawGround,
  drawNightOverlay,
  drawSky,
  drawTroop,
  drawVignette,
  postProcess,
  Fx,
  inDeployZone,
  makeView,
  project,
  unproject,
  GRID_H,
  GRID_W,
  type BuildingDraw,
  type IsoView,
} from "../render/iso";

/** raids happen at a dramatic sunset */
const RAID_LIGHT = dayLight(0.49);

export function BattleView({ base, onExit }: { base: EnemyBase; onExit: () => void }) {
  const army = useGame((s) => s.army);
  const applyBattleResult = useGame((s) => s.applyBattleResult);
  const showToast = useUi((s) => s.showToast);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewRef = useRef<IsoView | null>(null);
  const dprRef = useRef(1);
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
    dprRef.current = dpr;

    const resize = () => {
      const r = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const battle = battleRef.current;
    const fx = new Fx();
    fx.onImpact = (gx, gy, kind) => {
      fx.spark(gx, gy, kind === "ball" ? "#ffcaa0" : "#fff2a0");
      if (kind === "ball") fx.shake(3);
    };

    // static occupied set + decorations for the hostile field
    const occupied = new Set<string>();
    for (const b of base.buildings) {
      for (let yy = 0; yy < b.size; yy++)
        for (let xx = 0; xx < b.size; xx++) occupied.add(`${b.x + xx},${b.y + yy}`);
    }
    const decos = buildDecorations(occupied, true);

    const prevHp = new Map<number, number>();
    for (const t of battle.targets) prevHp.set(t.id, t.hp);
    const prevFlash = new Map<number, number>();
    const shotTimer = new Map<number, number>();
    const dmgHp = new Map<number, number>();
    const dmgTimer = new Map<number, number>();
    let slowmo = 0;

    const frame = (time: number) => {
      const realDt = Math.min(0.05, (time - last) / 1000);
      last = time;
      const t = time / 1000;
      if (slowmo > 0) slowmo -= realDt;
      const dt = slowmo > 0 ? realDt * 0.4 : realDt;
      if (!finishedRef.current) battle.step(dt);

      // ---- cosmetic combat events (decoupled from logic) ----
      // building destruction -> explosion (town hall: flash + slow-mo)
      for (const tg of battle.targets) {
        const prev = prevHp.get(tg.id) ?? tg.hp;
        if (prev > 0 && tg.hp <= 0) {
          fx.boom(tg.cx, tg.cy, tg.type === "wall" ? "#9a8e74" : "#b08a55");
          if (tg.type === "townhall") {
            fx.bang();
            fx.shake(14);
            slowmo = 0.6;
          }
        }
        prevHp.set(tg.id, tg.hp);
      }
      // periodic damage numbers on buildings taking hits
      for (const tg of battle.targets) {
        if (tg.hp <= 0) continue;
        const base = dmgHp.get(tg.id);
        if (base === undefined) {
          dmgHp.set(tg.id, tg.hp);
          dmgTimer.set(tg.id, 0.4);
          continue;
        }
        let timer = (dmgTimer.get(tg.id) ?? 0.4) - dt;
        if (timer <= 0) {
          const delta = base - tg.hp;
          if (delta >= 1) fx.damageNumber(tg.cx, tg.cy, `-${Math.round(delta)}`);
          dmgHp.set(tg.id, tg.hp);
          timer = 0.4;
        }
        dmgTimer.set(tg.id, timer);
      }
      // defenses fire visible projectiles at the nearest unit in range
      for (const tg of battle.targets) {
        if (tg.hp <= 0 || !tg.isDefense) continue;
        let timer = (shotTimer.get(tg.id) ?? 0) - dt;
        let best: { x: number; y: number } | null = null;
        let bestD = Infinity;
        for (const u of battle.units) {
          if (u.hp <= 0) continue;
          const d = Math.hypot(tg.cx - u.x, tg.cy - u.y);
          if (d <= tg.range && d < bestD) {
            bestD = d;
            best = { x: u.x, y: u.y };
          }
        }
        if (best && timer <= 0) {
          const kind = tg.type === "archertower" ? "arrow" : "ball";
          fx.shoot(kind, tg.cx, tg.cy, best.x, best.y);
          fx.muzzle(tg.cx, tg.cy);
          timer = kind === "arrow" ? 0.55 : 1.0;
        }
        shotTimer.set(tg.id, timer);
      }
      // melee sparks on troop hits
      for (const u of battle.units) {
        const pf = prevFlash.get(u.id) ?? 0;
        if (u.hp > 0 && pf <= 0 && u.attackFlash > 0) fx.spark(u.x, u.y - 0.3, "#ffe49a");
        prevFlash.set(u.id, u.attackFlash);
      }
      fx.update(dt);

      // ---- render ----
      const W = canvas.width;
      const H = canvas.height;
      const v = makeView(W, H);
      viewRef.current = v;

      ctx.clearRect(0, 0, W, H);
      drawSky(ctx, W, H, RAID_LIGHT);
      fx.beginShake(ctx, t);
      drawGround(ctx, v, { hostile: true });
      if (!finishedRef.current) drawDeployZone(ctx, v, t);

      // defense range rings (ground decal)
      for (const tg of battle.targets) {
        if (tg.hp <= 0 || !tg.isDefense) continue;
        const c = project(v, tg.cx, tg.cy);
        ctx.fillStyle = "rgba(255,80,80,0.06)";
        ctx.strokeStyle = "rgba(255,80,80,0.18)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.ellipse(c.x, c.y, tg.range * v.tw, tg.range * v.th, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }

      // depth-sorted scene: decorations + buildings + units
      type Item = { depth: number; draw: () => void };
      const items: Item[] = [];
      for (const d of decos) items.push({ depth: d.depth, draw: () => d.draw(ctx, v) });
      for (const tg of battle.targets) {
        if (tg.hp <= 0) continue;
        const x = tg.cx - tg.size / 2;
        const y = tg.cy - tg.size / 2;
        const draw: BuildingDraw = {
          type: tg.type,
          level: tg.level,
          x,
          y,
          size: tg.size,
          time: t,
          hpFrac: tg.hp / tg.maxHp,
          ambient: true,
          night: RAID_LIGHT.night,
        };
        items.push({ depth: tg.cy + tg.size / 2, draw: () => drawBuilding(ctx, v, draw) });
      }
      for (const u of battle.units) {
        if (u.hp <= 0) continue;
        items.push({
          depth: u.y,
          draw: () =>
            drawTroop(ctx, v, {
              type: u.type,
              gx: u.x,
              gy: u.y,
              hpFrac: u.hp / u.maxHp,
              flash: u.attackFlash > 0,
              time: t,
              seed: u.id,
            }),
        });
      }
      items.sort((a, b) => a.depth - b.depth);
      for (const it of items) it.draw();

      // effects on top of the scene
      fx.draw(ctx, v);
      fx.endShake(ctx);
      drawAtmosphere(ctx, W, H, "rgba(122,98,150,0.26)");
      drawNightOverlay(ctx, W, H, RAID_LIGHT);
      drawVignette(ctx, W, H);
      postProcess(ctx, W, H);

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
    const v = viewRef.current;
    const canvas = canvasRef.current!;
    if (!v) return;
    const r = canvas.getBoundingClientRect();
    const dpr = dprRef.current;
    const px = (e.clientX - r.left) * dpr;
    const py = (e.clientY - r.top) * dpr;
    const g = unproject(v, px, py);
    if (g.gx < 0 || g.gy < 0 || g.gx > GRID_W || g.gy > GRID_H) return;
    // troops may only land on the player's front beach, then march up-field
    if (!inDeployZone(g.gx, g.gy)) {
      showToast("手前の緑のゾーンから出撃！");
      return;
    }
    battleRef.current.spawn(selected, g.gx, g.gy);
    remainingRef.current = {
      ...remainingRef.current,
      [selected]: remainingRef.current[selected] - 1,
    };
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
        <div className="chip">
          <IconText icon="timer" size={14}>
            {Math.ceil(stats.timeLeft)}s
          </IconText>
        </div>
        <div className="chip stars">{"★".repeat(stats.stars)}{"☆".repeat(3 - stats.stars)}</div>
        <div className="chip">
          <IconText icon="destruction" size={14}>
            {Math.round(stats.destructionPct * 100)}%
          </IconText>
        </div>
      </div>

      {!finished && (
        <div className="deploy-hint">
          <GameIcon name="north" size={14} className="hint-north" />
          手前から出撃して上の敵を攻めろ
        </div>
      )}

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
              <span className="big">
                <Pixel name={TROOP_PIXEL[type]} size={28} />
              </span>
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
          <span className="big">
            <GameIcon name="end" size={26} tone="gold" />
          </span>
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
              <span className="ct gold">
                <PixelText name={RESOURCE_PIXEL.gold} size={16}>
                  +{formatNumber(res.loot.gold)}
                </PixelText>
              </span>
              <span className="ct elixir">
                <PixelText name={RESOURCE_PIXEL.elixir} size={16}>
                  +{formatNumber(res.loot.elixir)}
                </PixelText>
              </span>
            </div>
            <div className="loot-row">
              <span style={{ color: res.trophies >= 0 ? "#b9530f" : "#e04a4a" }}>
                <IconText icon="trophies" tone="trophy" size={16}>
                  {res.trophies >= 0 ? "+" : ""}
                  {res.trophies}
                </IconText>
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
