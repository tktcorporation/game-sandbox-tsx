import { useEffect, useState } from "react";
import { ArcadeBack } from "../../shell/ArcadeBack";
import { Board } from "./components/Board";
import { ResourceBar } from "./components/ResourceBar";
import { Army, BuildingInfo, HelpReset, Shop } from "./components/Sheets";
import { BattleView } from "./components/BattleView";
import type { EnemyBase } from "./game/battle";
import { useGame } from "./game/store";
import { townHallLevel } from "./game/logic";
import { useGameLoop, useUi } from "./ui";
import { GameIcon } from "../../ui/icons";
import "./clash.css";

type Sheet = "shop" | "army" | "settings" | null;

export default function ClashApp({ onLeave }: { onLeave: () => void }) {
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
      <div className="clash-root">
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
    <div className="clash-root">
      <ResourceBar leading={<ArcadeBack onLeave={onLeave} />} />
      <Board />

      <div className="actionbar">
        <button className="action-btn shop" onClick={() => setSheet("shop")}>
          <span className="ai">
            <GameIcon name="build" size={20} />
          </span>
          Build
        </button>
        <button className="action-btn collect" onClick={collectAll}>
          <span className="ai">
            <GameIcon name="collect" size={20} />
          </span>
          Collect
        </button>
        <button className="action-btn army" onClick={() => setSheet("army")}>
          <span className="ai">
            <GameIcon name="army" size={20} />
          </span>
          Army
        </button>
        <button className="action-btn attack" onClick={findMatch} disabled={finding}>
          <span className="ai">
            <GameIcon name={finding ? "wait" : "attack"} size={20} />
          </span>
          {finding ? "Finding…" : "Attack"}
        </button>
        <button className="action-btn more" style={{ flex: 0.6 }} onClick={() => setSheet("settings")}>
          <span className="ai">
            <GameIcon name="more" size={20} />
          </span>
          More
        </button>
      </div>

      {sheet === "shop" && <Shop onClose={() => setSheet(null)} />}
      {sheet === "army" && <Army onClose={() => setSheet(null)} />}
      {sheet === "settings" && (
        <SettingsSheet onClose={() => setSheet(null)} onLeave={onLeave} />
      )}
      {selectedId && <BuildingInfo id={selectedId} onClose={() => select(null)} />}

      {toast && <ToastView key={toast.id} msg={toast.msg} />}
    </div>
  );
}

function SettingsSheet({ onClose, onLeave }: { onClose: () => void; onLeave: () => void }) {
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h2>
          <span className="sheet-title">
            <GameIcon name="more" size={22} tone="ink" />
            More
          </span>
          <button onClick={onClose} aria-label="Close">
            <GameIcon name="close" size={16} tone="cream" />
          </button>
        </h2>
        <p className="hint">
          Clash of Sandboxes — a tiny Clash of Clans–style base builder. Built with React + Vite,
          served from a Cloudflare Worker that also generates the enemy bases you raid.
        </p>
        <button className="btn ghost" onClick={onLeave}>
          Return to Arcade
        </button>
        <HelpReset />
        <p className="hint attrib">
          HUD glyphs from{" "}
          <a href="https://game-icons.net/" target="_blank" rel="noreferrer">
            Game-icons.net
          </a>{" "}
          (Lorc, Delapouite &amp; contributors, CC BY 3.0) via{" "}
          <a href="https://react-icons.github.io/react-icons/" target="_blank" rel="noreferrer">
            react-icons
          </a>
          . Pixel sprites from{" "}
          <a href="https://kenney.nl/assets" target="_blank" rel="noreferrer">
            Kenney.nl
          </a>{" "}
          Tiny Dungeon / Tiny Town (CC0).
        </p>
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
