import { Suspense, useEffect, useState } from "react";
import { CABINETS } from "./arcade/cabinets";
import { Lobby } from "./arcade/Lobby";

const routeOf = () => location.hash.replace(/^#\/?/, "");

/** Hash routing keeps the build a static SPA: `#/` is the lobby, `#/<cabinet id>` a game. */
export function App() {
  const [route, setRoute] = useState(routeOf);
  useEffect(() => {
    const on = () => {
      setRoute(routeOf());
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  const cab = CABINETS.find((c) => c.id === route);
  if (!cab) return <Lobby />;
  return (
    <Suspense fallback={<div className="loading" style={{ background: cab.hue.bg, color: cab.hue.ink }}>{cab.title}</div>}>
      <cab.Game />
    </Suspense>
  );
}
