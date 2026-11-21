# ringfall-fill (shared WASM)

Dial/bucket landmark `fill` and A* for `src/ringfall/sim/nav.ts`, compiled to WASM for **browser and Node**. See `docs/ringfall/native.md`.

- Rebuild: `npm run build:native` (needs Rust; otherwise the committed embed is kept)
- Smoke: `node scripts/ringfall-native-smoke.mjs`
- Identity: `npm run fill:ringfall`, `RINGFALL_ASTAR=check`
- Disable: `?ringfallNative=0` / `RINGFALL_FILL=ts`
- A* on (opt-in): `?ringfallAstar=1` / `RINGFALL_ASTAR=1`
- Future tick host: `ringfall_step_tick` (stub −1 until sim state lives in WASM)

napi-rs is not used here (Node-only). Optional later for multi-threaded Node sim only.
