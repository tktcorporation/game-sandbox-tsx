import { useState } from "react";
import { useGame } from "../game/store";
import { capacityOf, formatNumber } from "../game/logic";
import { sound } from "../game/sfx";

export function MuteButton() {
  const [muted, setMuted] = useState(sound.muted);
  return (
    <button
      className="mute-btn"
      aria-label={muted ? "Unmute" : "Mute"}
      onClick={() => {
        sound.unlock();
        setMuted(sound.toggleMuted());
        if (!sound.muted) sound.play("tap");
      }}
    >
      {muted ? "🔇" : "🔊"}
    </button>
  );
}

export function ResourceBar() {
  const { gold, elixir, gems, trophies, buildings } = useGame();
  const goldCap = capacityOf(buildings, "gold");
  const elixirCap = capacityOf(buildings, "elixir");

  return (
    <div className="topbar">
      <div className="res gold">
        <span className="icon">🪙</span>
        <div className="bar">
          <span className="val">{formatNumber(gold)}</span>
          <div className="track">
            <div className="fill gold" style={{ width: `${Math.min(100, (gold / goldCap) * 100)}%` }} />
          </div>
        </div>
      </div>
      <div className="res elixir">
        <span className="icon">🧪</span>
        <div className="bar">
          <span className="val">{formatNumber(elixir)}</span>
          <div className="track">
            <div className="fill elixir" style={{ width: `${Math.min(100, (elixir / elixirCap) * 100)}%` }} />
          </div>
        </div>
      </div>
      <div className="spacer" />
      <div className="res gem">
        <span className="icon">💎</span>
        <span className="val">{formatNumber(gems)}</span>
      </div>
      <div className="res trophy">
        <span className="icon">🏆</span>
        <span className="val">{formatNumber(trophies)}</span>
      </div>
      <MuteButton />
    </div>
  );
}
