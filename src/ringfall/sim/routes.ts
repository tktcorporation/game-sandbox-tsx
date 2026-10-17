import { TOOLS } from "./config";
import { dist2d, setRouteBoxes } from "./geom";
import { resetHunt } from "./hunt";
import { ROUTE_PROMPT, ROUTES, type Route, type RouteId } from "./map";
import { resetNav } from "./nav";
import { carveTerrain } from "./terrain";
import type { Vec3 } from "./state";

/*
 * Which routes are open (`ROUTES`) shapes the world itself: the ground carved through the rock,
 * the boxes that stand, and everything derived from them (the walkers' grids in nav.ts and
 * hunt.ts, the view's chunks). The routes open change only between raids, while the world is
 * read from everywhere, every tick, through module-level fields and grids. So one world is in
 * place at a time, switched in place by `useRoutes()`: a handful of terrain cells and boxes put
 * back and redone, and the walkers' grids dropped to be built again on first use. Every raid
 * starts by putting its own in place, and `step()` checks it each tick (a string compare), so a
 * raid always plays in its own world even when another ran in between. With every route closed
 * the world is the map's own, cell for cell and box for box, plus the obstacles.
 */

/** The open routes of the world now in place, as their ids joined in `ROUTES` order. */
let current = "";

/** The open routes in `ROUTES` order, without repeats or unknown ids. */
export const openRoutes = (open: readonly string[]): RouteId[] => ROUTES.filter((r) => open.includes(r.id)).map((r) => r.id);

/** Puts in place the world with exactly the routes in `open` open; nothing to do when it already is. */
export function useRoutes(open: readonly RouteId[]) {
  const on = ROUTES.filter((r) => open.includes(r.id));
  const k = on.map((r) => r.id).join(",");
  if (k === current) return;
  current = k;
  carveTerrain(on.flatMap((r) => (r.carve ? [r.carve] : [])));
  setRouteBoxes(
    ROUTES.filter((r) => !on.includes(r)).flatMap((r) => r.closed),
    on.flatMap((r) => r.open),
  );
  resetNav();
  resetHunt();
}

/** The world in place, as a key: it changes whenever `useRoutes()` puts another in place. */
export const worldKey = () => current;

/** The closed route whose obstacle a body at `p` stands before (within `ROUTE_PROMPT`, on its level), or null. */
export function routeBefore(p: Vec3, open: readonly RouteId[]): Route | null {
  for (const r of ROUTES) {
    if (open.includes(r.id)) continue;
    if (r.at.some((a) => dist2d(a, p) < ROUTE_PROMPT && Math.abs(a.y - p.y) < 2.5)) return r;
  }
  return null;
}

/** The routes a tool opens, in the order it opens them. */
export const routesFor = (tool: keyof typeof TOOLS): Route[] => ROUTES.filter((r) => r.tool === tool);
