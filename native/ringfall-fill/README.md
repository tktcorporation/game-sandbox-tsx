# ringfall-fill (shared WASM)

Dial fill, opt-in A*, and tick host (enemy/orb SoA, geom, `los`, `step_tick` orbs) for browser + Node. See `docs/ringfall/native.md`.

```bash
npm run build:native
npm run smoke:native
npm run fill:ringfall
```

- Disable: `RINGFALL_FILL=ts` / `?ringfallNative=0`
- A* opt-in: `RINGFALL_ASTAR=1`
- Tick SoA: `RINGFALL_TICK=1` (orbs stay TS; hash kept)
- WASM orbs: `RINGFALL_ORBS=1` (drifts hash today)
- ABI: `ringfall_sim_abi_version()` = 5
