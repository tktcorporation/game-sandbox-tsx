import { useEffect, useState } from "react";
import { isGameId, type GameId } from "./catalog";
import { Hub } from "./hub/Hub";
import ClashApp from "./games/clash/App";
import FactoryApp from "./games/factory/FactoryApp";
import TataApp from "./games/tata/App";

function parseHash(): GameId | null {
  const raw = location.hash.replace(/^#\/?/, "").split("/")[0] ?? "";
  return isGameId(raw) ? raw : null;
}

export default function App() {
  const [game, setGame] = useState<GameId | null>(parseHash);

  useEffect(() => {
    const sync = () => setGame(parseHash());
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  const play = (id: GameId) => {
    location.hash = `#/${id}`;
  };

  const leave = () => {
    location.hash = "";
  };

  if (game === "clash") return <ClashApp onLeave={leave} />;
  if (game === "factory") return <FactoryApp onLeave={leave} />;
  if (game === "tata") return <TataApp onLeave={leave} />;
  return <Hub onPlay={play} />;
}
