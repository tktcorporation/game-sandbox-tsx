import { useEffect } from "react";
import { BattleView } from "./components/BattleView";
import { ColonyView } from "./components/ColonyView";
import { ResourceBar } from "./components/ResourceBar";
import { Dex, Leaderboard, Settings, SquadBuilder } from "./components/Sheets";
import { useGameLoop, useUi } from "./ui";

export default function App() {
  useGameLoop();
  const mode = useUi((s) => s.mode);
  const setMode = useUi((s) => s.setMode);
  const sheet = useUi((s) => s.sheet);
  const setSheet = useUi((s) => s.setSheet);
  const toasts = useUi((s) => s.toasts);
  const dismissToast = useUi((s) => s.dismissToast);

  if (mode === "battle") {
    return (
      <div className="app">
        <BattleView onExit={() => setMode("home")} />
      </div>
    );
  }

  return (
    <div className="app">
      <ResourceBar />
      <ColonyView />

      <div className="actionbar">
        <button className="action-btn" onClick={() => setSheet("dex")}>
          <span className="ai">📖</span>
          図鑑
        </button>
        <button className="action-btn" onClick={() => setSheet("squad")}>
          <span className="ai">⚔️</span>
          編成
        </button>
        <button className="action-btn attack" onClick={() => setMode("battle")}>
          <span className="ai">🗡️</span>
          対戦
        </button>
        <button className="action-btn" onClick={() => setSheet("leaderboard")}>
          <span className="ai">🏆</span>
          ランク
        </button>
        <button className="action-btn more" style={{ flex: 0.6 }} onClick={() => setSheet("settings")}>
          <span className="ai">⚙️</span>
        </button>
      </div>

      {sheet === "dex" && <Dex onClose={() => setSheet(null)} />}
      {sheet === "squad" && <SquadBuilder onClose={() => setSheet(null)} />}
      {sheet === "leaderboard" && <Leaderboard onClose={() => setSheet(null)} />}
      {sheet === "settings" && <Settings onClose={() => setSheet(null)} />}

      <div className="toast-stack">
        {toasts.map((t) => (
          <ToastView key={t.id} id={t.id} msg={t.msg} onDone={dismissToast} />
        ))}
      </div>
    </div>
  );
}

function ToastView({ id, msg, onDone }: { id: number; msg: string; onDone: (id: number) => void }) {
  useEffect(() => {
    const t = setTimeout(() => onDone(id), 3200);
    return () => clearTimeout(t);
  }, [id, onDone]);
  return <div className="toast">{msg}</div>;
}
