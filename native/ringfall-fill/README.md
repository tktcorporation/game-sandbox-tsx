# ringfall-fill

Dial/bucket landmark `fill` for `src/ringfall/sim/nav.ts`, compiled to WASM.

- Rebuild (needs Rust): `npm run build:native`
- Without Rust: the committed `src/ringfall/sim/native/fill-wasm.ts` embed is used as-is
- Force TypeScript fill: `RINGFALL_FILL=ts`
- Byte-compare both: `RINGFALL_FILL=check` or `npm run fill:ringfall`

Node sim/bench only; the browser keeps the TypeScript path.
