import { useGame } from "../game/store";
import { dexProgress, formatNumber } from "../game/logic";

export function ResourceBar() {
  const shineStones = useGame((s) => s.shineStones);
  const rating = useGame((s) => s.rating);
  const dex = useGame((s) => s.dex);
  const { discovered, total } = dexProgress(dex);

  return (
    <div className="topbar">
      <div className="res shine">
        <span className="icon">✨</span>
        <span className="val">{formatNumber(shineStones)}</span>
      </div>
      <div className="res dex">
        <span className="icon">📖</span>
        <span className="val">
          {discovered}/{total}
        </span>
      </div>
      <div className="spacer" />
      <div className="res rating">
        <span className="icon">🏆</span>
        <span className="val">{formatNumber(rating)}</span>
      </div>
    </div>
  );
}
