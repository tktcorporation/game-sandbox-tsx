# ringfall-fill / nav

Dial/bucket landmark `fill` and optional A* (`searchCells`) for `src/ringfall/sim/nav.ts`, as WASM.

- Rebuild (needs Rust): `npm run build:native`
- Without Rust: committed `src/ringfall/sim/native/fill-wasm.ts` embed is used
- Force TypeScript fill: `RINGFALL_FILL=ts` (weighted / avoid-disk fills always use TS)
- Byte-compare fills: `RINGFALL_FILL=check` or `npm run fill:ringfall`
- Opt-in A*: `RINGFALL_ASTAR=1` (default off — warm raids were not faster); `RINGFALL_ASTAR=check` compares paths

Node sim/bench only; the browser keeps the TypeScript path.
