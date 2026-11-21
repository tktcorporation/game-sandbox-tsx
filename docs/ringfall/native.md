# RINGFALL native (Rust → WASM)

One Rust crate (`native/ringfall-fill/`) compiles to **WASM for both the browser game and the Node sim**. napi-rs is not used for production.

## Architecture

| Layer | Role |
| --- | --- |
| Nav (`fill` / opt-in A*) | Landmark Dial fields; default fill WASM, A* TypeScript |
| Tick host (ABI **2**) | Enemy/orb SoA + terrain/boxes + `los` + `step_tick` (orbs) |
| Default sim path | TypeScript `stepEnemies` / `stepOrbs` — **no** per-tick SoA/geom work |

`ringfall_step_tick` returns **-1** until geom is uploaded; **0** after a successful orb step.

## Switches

| Flag | Effect |
| --- | --- |
| `RINGFALL_FILL=ts` / `?ringfallNative=0` | Disable WASM (nav + tick) |
| `RINGFALL_ASTAR=1` | Opt-in WASM A* (warm is slower) |
| `RINGFALL_TICK=1` | Upload geom + sync robot SoA each tick (orbs still TS) |
| `RINGFALL_ORBS=1` | Also run WASM `step_orbs` (**breaks** bench hash today — ~1 ULP/tick los drift) |

## Identity / speed (measured)

Bench aggregate hash must stay **`83b7a1d3bcf8`** on the default path.

| Path | Warm CPU (this machine) | Hash |
| --- | --- | --- |
| Default (fill WASM, tick off) | ~72–75 s | `83b7a1d3bcf8` |
| `RINGFALL_TICK=1` (SoA sync, TS orbs) | ~73 s | `83b7a1d3bcf8` |
| `RINGFALL_TICK=1 RINGFALL_ORBS=1` | ~61 s | **`61c0935e28ab`** (divergent — not a fair speedup) |

Back-to-back vs #153 tip (`f5eb313`) on the same machine: no default-path regression (both ~70–85 s depending on load; earlier 57.9 vs 69.3 was machine noise).

Cold `findPath`: TS ≈ WASM within noise; identity match (`npm run fill:ringfall`).

## Remaining (full per-tick port)

1. **Bit-identical `los` / terrain rays** (or accept fixed-point) so WASM orbs keep hash `83b7a1d3bcf8`.
2. Port **`stepEnemies` / `sense` / combat FSM** into `step_tick` (hunt fields, collide, factions, RNG order).
3. **Drop AoS `Enemy` objects** — State holds indices into WASM SoA; view already can read typed arrays when tick is on.
4. Until (1)–(3): do **not** expect `RINGFALL_TICK=1` to beat TypeScript on a fair identical-hash comparison. Sync-only tax is noise; divergent orbs look “faster” only because raids take different branches.

## Rebuild

```bash
npm run build:native
npm run smoke:native
npm run fill:ringfall
npm run bench:ringfall   # hash 83b7a1d3bcf8
```
