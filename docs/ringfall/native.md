# RINGFALL native (Rust → WASM)

One Rust crate (`native/ringfall-fill/`) compiles to **WASM for both the browser game and the Node sim**. napi-rs is not used for production (Node-only); it remains an optional later path for multi-threaded Node sim (e.g. rayon).

## Goal architecture

Keep sim/game state in WASM linear memory. Cross the JS↔Rust boundary **once per tick** (or a short batch), not once per helper:

| Today (this PR) | Target |
| --- | --- |
| Nav Dial `fill` + optional A* in WASM; moves/fields/path buffers live in the engine | Same nav host, plus SoA for bodies / orbs / awareness |
| TS `step()` still owns the raid | `ringfall_step_tick(dt)` (or N ticks) mutates WASM state; view reads typed-array views |
| Per-call field copies when JS needs a packed field | Prefer views into WASM memory; copy only for disk cache / save |

ABI version: `ringfall_sim_abi_version()` (bump when the tick contract changes).  
`ringfall_step_tick` is a **stub** (`-1` / not implemented) until enough state lives in Rust.

## What runs where

| Surface | WASM | Fallback |
| --- | --- | --- |
| Browser (`/ringfall/`) | Yes, when `WebAssembly` works | TypeScript nav `fill` / A* |
| Node `sim` / `bench` | Same embed | `RINGFALL_FILL=ts` / `RINGFALL_ASTAR=ts` |

Disable: `?ringfallNative=0`, `localStorage.ringfallNative=0`, or the env vars above.  
A* WASM is **opt-in** (`?ringfallAstar=1` / `RINGFALL_ASTAR=1`); warm bench is slower until the tick host avoids per-call field uploads.  
Weighted (avoid-disk) Dial fills stay on TypeScript for now (warm microbenches were slower in WASM).

## Rebuild

```bash
npm run build:native   # needs rustc; otherwise the committed fill-wasm.ts embed is kept
npm run fill:ringfall  # TS vs WASM identity
```

Identity for raids: `npm run bench:ringfall` aggregate hash must stay `83b7a1d3bcf8` while results are unchanged.

## Remaining for a full tick port

1. SoA layout for enemies, player, orbs, squads (deterministic floats / fixed order).
2. Port `stepEnemies` / `sense` / `los` / combat into the crate behind `step_tick`.
3. View and HUD read positions from WASM views (or a thin sync out once per frame).
4. Optional: napi + rayon for Node-only parallel sim workers — never required for the browser.
