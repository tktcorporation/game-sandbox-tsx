import { useGame } from "../game/store";
import { capacityOf, formatNumber } from "../game/logic";
import { GameIcon } from "../ui/icons";

export function ResourceBar() {
  const { gold, elixir, gems, trophies, buildings } = useGame();
  const goldCap = capacityOf(buildings, "gold");
  const elixirCap = capacityOf(buildings, "elixir");

  return (
    <div className="topbar">
      <div className="res gold">
        <span className="icon">
          <GameIcon name="gold" size={18} tone="gold" />
        </span>
        <div className="bar">
          <span className="val">{formatNumber(gold)}</span>
          <div className="track">
            <div className="fill gold" style={{ width: `${Math.min(100, (gold / goldCap) * 100)}%` }} />
          </div>
        </div>
      </div>
      <div className="res elixir">
        <span className="icon">
          <GameIcon name="elixir" size={18} tone="elixir" />
        </span>
        <div className="bar">
          <span className="val">{formatNumber(elixir)}</span>
          <div className="track">
            <div className="fill elixir" style={{ width: `${Math.min(100, (elixir / elixirCap) * 100)}%` }} />
          </div>
        </div>
      </div>
      <div className="spacer" />
      <div className="res gem">
        <span className="icon">
          <GameIcon name="gems" size={18} tone="gem" />
        </span>
        <span className="val">{formatNumber(gems)}</span>
      </div>
      <div className="res trophy">
        <span className="icon">
          <GameIcon name="trophies" size={18} tone="trophy" />
        </span>
        <span className="val">{formatNumber(trophies)}</span>
      </div>
    </div>
  );
}
