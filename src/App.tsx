import { useEffect, useState } from "react";
import { Board } from "./components/Board";
import { ResourceBar } from "./components/ResourceBar";
import { Army, BuildingInfo, HelpReset, Shop } from "./components/Sheets";
import { BattleView } from "./components/BattleView";
import type { EnemyBase } from "./game/battle";
import { useGame } from "./game/store";
import { townHallLevel } from "./game/logic";
import { useGameLoop, useUi } from "./ui";

type Sheet = "shop" | "army" | "settings" | null;

export default function App() {
  useGameLoop();
  const mode = useUi((s) => s.mode);
  const setMode = useUi((s) => s.setMode);
  const selectedId = useUi((s) => s.selectedId);
  const select = useUi((s) => s.select);
  const toast = useUi((s) => s.toast);

  const buildings = useGame((s) => s.buildings);
  const collectAll = useGame((s) => s.collectAll);

  const [sheet, setSheet] = useState<Sheet>(null);
  const [base, setBase] = useState<EnemyBase | null>(null);
  const [finding, setFinding] = useState(false);

  const findMatch = async () => {
    setFinding(true);
    const th = townHallLevel(buildings);
    const seed = Math.floor(Math.random() * 1_000_000_000);
    try {
      const res = await fetch(`/api/raid?th=${th}&seed=${seed}`);
      const data = (await res.json()) as EnemyBase;
      setBase(data);
      setMode("battle");
    } catch {
      useUi.getState().showToast("Could not find a match — try again");
    } finally {
      setFinding(false);
    }
  };

  if (mode === "battle" && base) {
    return (
      <div className="app">
        <BattleView
          base={base}
          onExit={() => {
            setMode("home");
            setBase(null);
          }}
        />
      </div>
    );
  }

  return (
    <div className="app">
      <ResourceBar />
      <Board />

      <div className="actionbar">
        <button className="action-btn shop" onClick={() => setSheet("shop")}>
          <span className="ai">🛠️</span>
          Build
        </button>
        <button className="action-btn shop" onClick={collectAll}>
          <span className="ai">💰</span>
          Collect
        </button>
        <button className="action-btn army" onClick={() => setSheet("army")}>
          <span className="ai">⚔️</span>
          Army
        </button>
        <button className="action-btn attack" onClick={findMatch} disabled={finding}>
          <span className="ai">{finding ? "⏳" : "🗡️"}</span>
          {finding ? "Finding…" : "Attack"}
        </button>
        <button className="action-btn shop" style={{ flex: 0.6 }} onClick={() => setSheet("settings")}>
          <span className="ai">⚙️</span>
          More
        </button>
      </div>

      {sheet === "shop" && <Shop onClose={() => setSheet(null)} />}
      {sheet === "army" && <Army onClose={() => setSheet(null)} />}
      {sheet === "settings" && (
        <SettingsSheet onClose={() => setSheet(null)} />
      )}
      {selectedId && <BuildingInfo id={selectedId} onClose={() => select(null)} />}

      {toast && <ToastView key={toast.id} msg={toast.msg} />}
    </div>
  );
}

function SettingsSheet({ onClose }: { onClose: () => void }) {
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h2>
          ⚙️ More
          <button onClick={onClose}>✕</button>
        </h2>
        <p className="hint">
          Clash of Sandboxes — a tiny Clash of Clans–style base builder. Built with React + Vite,
          served from a Cloudflare Worker that also generates the enemy bases you raid.
        </p>
        <HelpReset />
      </div>
    </div>
  );
}

function ToastView({ msg }: { msg: string }) {
  const clearToast = useUi((s) => s.clearToast);
  useEffect(() => {
    const t = setTimeout(clearToast, 1600);
    return () => clearTimeout(t);
  }, [msg, clearToast]);
  if (!msg) return null;
  return <div className="toast">{msg}</div>;
}
