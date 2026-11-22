# RINGFALL native (Rust → WASM)

One Rust crate (`native/ringfall-fill/`) compiles to **WASM for both the browser game and the Node sim**. napi-rs is not used for production.

## Architecture

| Layer | Role |
| --- | --- |
| Nav (`fill` / opt-in A*) | Landmark Dial fields; default fill WASM, A* TypeScript |
| Tick host (ABI **4**) | SoA + geom + hunt grid + `los` + `step_tick` (sense + engaged combat + orbs + hunt vias); fromCover skip + pursuit vias from TS; engage events on pull |
| After WASM tick | TypeScript `tickNonEngaged` (full `calm` + `fightFoe`) — restores patrol/roam encounters |
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

## Speed (hybrid ABI 4 + in-WASM hunt vias, this machine)

| Measurement | TS | WASM tick | Notes |
| --- | ---: | ---: | --- |
| Warm bench CPU | ~66.5 s | ~76.5 s | WASM **still slower** (full AoS↔SoA sync remains) |
| Fixed 90 s sim CPU | ~6.1 s | ~5.9 s | ~×1.05 |
| Fixed 90 s sim wall | ~2.7 s | ~2.8 s | ~×0.98 |
| Default path hash | `83b7a1d3bcf8` | — | must hold with tick off |

**Plain reading:** equivalence is acceptable; **do not turn tick on by default** until warm bench beats TS. Hunt vias now run in WASM (grid uploaded once); TypedArray views are cached; the draw path no longer re-pushes SoA. Remaining tax is the per-tick full sync + TS calm/fightFoe. An earlier attempt to move full calm into WASM (ABI 5) regressed CPU badly and was reverted.

## Ported vs still TypeScript

**WASM when TICK on:** sense, engage (+ events on pull), engaged FSM, orbs, hunt vias (grid uploaded once), fromCover skip  
**TypeScript after tick:** full `calm` (patrol/party/ambush/walk), `fightFoe`  
**Still TS-only:** stepSquads, fromCover / pursuit prep, pinch/flank open field, titan special AI, friends, AoS store (full sync still each tick; TypedArray views cached)

## Rebuild / check

```bash
npm run build:native && npm run smoke:native   # abi=4
npm run bench:ringfall                         # hash 83b7a1d3bcf8
RINGFALL_TICK=1 npm run bench:ringfall
npm run equiv:ringfall
npm run tick-cost:ringfall -- 90
RINGFALL_TICK=1 npx tsx scripts/ringfall-tick-smoke.ts
```
