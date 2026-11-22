# RINGFALL native (Rust → WASM)

One Rust crate (`native/ringfall-fill/`) compiles to **WASM for both the browser game and the Node sim**. napi-rs is not used for production.

## Architecture

| Layer | Role |
| --- | --- |
| Nav (`fill` / opt-in A*) | Landmark Dial fields; default fill WASM, A* TypeScript |
| Tick host (ABI **6**) | SoA + geom + hunt + covers; `step_tick` owns sense + cover + calm + fightFoe + engaged + orbs; robots adopted once (no full AoS push each tick); squad destinations synced each tick |
| Default (browser + Node) | Tick **off** (opt-in `RINGFALL_TICK=1` / `?ringfallTick=1`) |

`ringfall_step_tick` returns **-1** until geom is uploaded; **0** after enemies then orbs.

## Switches

| Flag | Effect |
| --- | --- |
| `RINGFALL_FILL=ts` / `?ringfallNative=0` | Disable WASM (nav + tick) |
| `RINGFALL_ASTAR=1` | Opt-in WASM A* (warm is slower) |
| `RINGFALL_TICK=1` | Opt-in WASM sense + engaged + orbs (+ TS calm/fightFoe after) |
| Browser / Node default | **off** |

## Equivalence criterion (tick on)

Bit-identical bench hash is **not** required when the tick host is on. Small float drift (~1 ULP/tick) is accepted.

```bash
npm run equiv:ringfall          # N=30 × 10 jobs, TS ∥ WASM, Welch
```

**BIAS** when p&lt;0.05 and |Δ| &gt; pooled SD. Stuck@LIMIT soft-counted as wipe.

### Latest N=30 pool (hybrid ABI 4) — **no BIAS**

| metric | mean TS | mean WASM | Δ | p | flag |
| --- | ---: | ---: | ---: | ---: | --- |
| extracted | 0.600 | 0.543 | +0.057 | 0.16 | |
| minutes | 5.62 | 5.06 | +0.56 | 0.06 | |
| haul | 561 | 444 | +117 | 0.04 | |
| kills | 14.25 | 12.81 | +1.44 | 0.08 | |
| damage | 1390 | 1232 | +158 | 0.08 | |
| downs | 1.08 | 1.30 | −0.22 | 0.02 | |
| met | 7.87 | 7.13 | +0.74 | 0.08 | |
| metAway | 5.02 | 4.46 | +0.56 | 0.08 | |
| firstMeet | 34.0 | 33.5 | +0.5 | 0.76 | |
| quiet | 71.2 | 70.3 | +1.0 | 0.82 | |

kills/damage are within noise (no BIAS / no `~`). Earlier BIAS on `met`/`metAway` was fixed by engage events + TS calm/fightFoe + hunt vias.

## Speed (ABI 6 full enemy tick, this machine)

| Measurement | TS | WASM tick | Notes |
| --- | ---: | ---: | --- |
| Warm bench CPU | 55.5 s | 89.7 s | WASM **still slower** (~1.62×) |
| Warm bench wall | 47.6 s | 82.6 s | same pass as equiv N=30 |
| Equiv N=30 CPU | 1239 s | 4635 s | pooled 10 jobs; no BIAS |
| Default path hash | `83b7a1d3bcf8` | `372dee3422fc` | default OFF keeps TS hash |

**Plain reading:** cover/calm/fightFoe are in WASM and robots are adopted once; `equiv:ringfall` N=30 has **no systematic bias**. Still **do not turn tick on by default** — warm bench loses ~1.6× and full equiv wall is ~3.8×. Remaining tax is hunt fields for calm walks (sticky vias; whole-world Dijkstra banned) and per-tick squad destination sync + robot pull. An earlier ABI 5 calm port with per-tick TS via prep was worse and reverted.

## Ported vs still TypeScript

**WASM when TICK on:** sense, engage (+ events on pull), cover, calm, fightFoe, engaged FSM, orbs, hunt vias  
**Still TS-only:** stepSquads / stepFactions (feeds squad SoA), player combat → hp patch, friends, titan special AI, pinch/flank extras  
**Sync:** adopt robots once; each tick patch hp/aware + squad destinations + orbs; pull robot views/events

## Rebuild / check

```bash
npm run build:native && npm run smoke:native   # abi=4
npm run bench:ringfall                         # hash 83b7a1d3bcf8
RINGFALL_TICK=1 npm run bench:ringfall
npm run equiv:ringfall
npm run tick-cost:ringfall -- 90
RINGFALL_TICK=1 npx tsx scripts/ringfall-tick-smoke.ts
```
