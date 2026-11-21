# RINGFALL native (Rust → WASM)

One Rust crate (`native/ringfall-fill/`) compiles to **WASM for both the browser game and the Node sim**. napi-rs is not used for production (Node-only); it remains an optional later path for multi-threaded Node sim (e.g. rayon).

## Goal architecture

Keep sim/game state in WASM linear memory. Cross the JS↔Rust boundary **once per tick** (or a short batch), not once per helper:

| Today | Target |
| --- | --- |
| Nav Dial `fill` + opt-in A*; tick host holds enemy/orb SoA + world geom | Same + full `stepEnemies` / combat FSM in Rust |
| `ringfall_step_tick` advances **orbs** when `RINGFALL_TICK=1` (default still TS) | `step_tick` owns enemies + orbs + awareness; view reads typed-array views only |
| View syncs robot SoA each frame (`syncRobots`) and reads `x/y/z/yaw` views | No AoS copy for poses |
| TS `stepEnemies` / `sense` / combat still own AI | Port behind `step_tick` |

ABI version: `ringfall_sim_abi_version()` = **2** (bump when the tick contract changes).  
Without geom uploaded, `ringfall_step_tick` returns **-1**.

## What runs where

| Surface | WASM | Fallback |
| --- | --- | --- |
| Browser (`/ringfall/`) | fill + SoA views; orbs if `?ringfallTick=1` | TypeScript |
| Node `sim` / `bench` | Same embed; tick off by default | `RINGFALL_FILL=ts` / omit `RINGFALL_TICK` |

Disable native: `?ringfallNative=0`, `localStorage.ringfallNative=0`, or `RINGFALL_FILL=ts`.  
A* WASM opt-in: `?ringfallAstar=1` / `RINGFALL_ASTAR=1`.  
Tick (orbs) opt-in: `?ringfallTick=1` / `RINGFALL_TICK=1` (`check` reserved).

Weighted (avoid-disk) Dial fills stay on TypeScript for now.

## Rebuild

```bash
npm run build:native   # needs rustc; otherwise the committed embed is kept
npm run smoke:native
npm run fill:ringfall  # TS vs WASM fill identity
```

Identity for raids: `npm run bench:ringfall` aggregate hash must stay `83b7a1d3bcf8` while results are unchanged (default path: fill WASM, A* TS, tick TS).

## Remaining for a full tick port

1. Port `stepEnemies` FSM (`calm`, cover, fire, hunt) into `step_tick` with bit-identical order.
2. Port `sense` / squad awareness (engage/alert side effects) using in-WASM `los`.
3. Player combat (`damageEnemy`) and faction fights fully inside the host.
4. Drop dual AoS: State holds indices into WASM SoA (or view-only sync out).
5. Optional: napi + rayon for Node-only parallel sim workers — never required for the browser.
