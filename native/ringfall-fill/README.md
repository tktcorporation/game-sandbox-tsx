# ringfall-fill (shared WASM)

Dial/bucket landmark `fill`, A*, and the coarse tick host (`sim`: enemy/orb SoA, world geom, `step_tick` for orbs) for browser and Node. See `docs/ringfall/native.md`.

- Rebuild: `npm run build:native` (needs Rust; otherwise the committed embed is kept)
- Smoke: `npm run smoke:native`
- Identity: `npm run fill:ringfall`, `RINGFALL_ASTAR=check`
- Disable: `?ringfallNative=0` / `RINGFALL_FILL=ts`
- A* on (opt-in): `?ringfallAstar=1` / `RINGFALL_ASTAR=1`
- Tick orbs (opt-in): `?ringfallTick=1` / `RINGFALL_TICK=1`
- ABI: `ringfall_sim_abi_version()` = 2

napi-rs is not used here (Node-only). Optional later for multi-threaded Node sim only.
