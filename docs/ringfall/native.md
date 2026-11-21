# RINGFALL native (Rust → WASM)

One Rust crate (`native/ringfall-fill/`) compiles to **WASM for both the browser game and the Node sim**. napi-rs is not used for production.

## Architecture

| Layer | Role |
| --- | --- |
| Nav (`fill` / opt-in A*) | Landmark Dial fields; default fill WASM, A* TypeScript |
| Tick host (ABI **4**) | Enemy/orb SoA + terrain/boxes + `los` + `step_tick` (sense + engaged combat + orbs); hunt vias + fromCover skip from TS |
| Default sim path | TypeScript `stepEnemies` / `stepOrbs` — **no** per-tick SoA/geom work |
| Browser default | Tick **off** until statistical equivalence passes (same as Node) |

`ringfall_step_tick` returns **-1** until geom is uploaded; **0** after enemies then orbs.

## Switches

| Flag | Effect |
| --- | --- |
| `RINGFALL_FILL=ts` / `?ringfallNative=0` | Disable WASM (nav + tick) |
| `RINGFALL_ASTAR=1` | Opt-in WASM A* (warm is slower) |
| `RINGFALL_TICK=1` | Geom + sync → WASM **enemies + orbs** (orbs folded into tick) |
| `RINGFALL_TICK=0` / `?ringfallTick=0` | Force TypeScript enemies + orbs (fallback) |
| Browser default | Tick **off** until equiv passes |
| Node default | Tick **off** (bench hash stays on TypeScript) |

## Equivalence criterion (tick on)

Bit-identical bench hash is **not** required when the tick host is on. Small float drift (~1 ULP/tick in `los` / terrain rays) can change individual hits; that is accepted.

Validation is **statistical**:

```bash
npm run equiv:ringfall          # N=30 per bench job × 10 jobs, TS ∥ WASM
npm run equiv:ringfall -- 10    # shorter
RINGFALL_EQUIV_N=3 npm run equiv:ringfall
```

Compares pooled means/SD of raid aggregates with a Welch t-test. **BIAS** when p&lt;0.05 and |Δ| &gt; pooled SD; `~` when p&lt;0.05 with a material but smaller gap. Exit 0 even when hashes differ; real crashes fail. Raids stuck at the 30‑minute LIMIT are soft-counted as wipes.

### Latest N=30 pool (300 raids/mode) — before hybrid calm/vias

| metric | mean TS | mean WASM | Δ | flag |
| --- | ---: | ---: | ---: | --- |
| extracted | 0.60 | 0.58 | +0.02 | |
| minutes | 5.62 | 6.27 | −0.64 | |
| haul | 561 | 496 | +65 | |
| kills | 14.3 | 11.7 | +2.5 | ~ |
| damage | 1390 | 1086 | +304 | ~ |
| downs | 1.08 | 1.16 | −0.08 | |
| met | 7.87 | 2.53 | +5.35 | **BIAS** |
| metAway | 5.02 | 0.69 | +4.33 | **BIAS** |
| firstMeet | 34 s | 104 s | −70 | ~ |
| quiet | 71 s | 102 s | −31 | ~ |

**Root cause (fixed in hybrid path):** WASM engages did not emit `{t:"engage"}` (met undercount); Rust `calm` was a stub (roamers never walked → metAway collapse); engaged move was straight-line (no hunt vias); no `fightFoe` for non-engaged.

**Hybrid now (ABI 4):** engage events on pull; skip Rust calm → TS `tickNonEngaged` (calm + fightFoe); hunt vias + fromCover skip synced into SoA. Browser stays opt-in until a fresh N=30 pool clears met/metAway BIAS.

Per-tick cost (fixed sim time):

```bash
npm run tick-cost:ringfall -- 90
```

| | CPU | wall | speedup |
| --- | ---: | ---: | --- |
| TS (90 s sim) | 14.9 s | 10.2 s | — |
| WASM tick | 5.3 s | 3.2 s | CPU **×2.8**, wall **×3.2** |

So the tick host **is** faster per sim-second. Equiv wall is higher for WASM when engagement is weaker — not because each tick is slower.

## Identity / speed (bench)

| Path | Warm CPU | Warm wall | Aggregate hash |
| --- | ---: | ---: | --- |
| Default (tick off) | ~60–64 s | ~53–56 s | **`83b7a1d3bcf8`** (must hold) |
| `RINGFALL_TICK=1` | ~52–56 s | ~50–52 s | diverges (expected) |

Cold `findPath`: TS ≈ WASM within noise; identity match (`npm run fill:ringfall`).

## Ported vs still TypeScript

**In WASM (`step_tick`) when TICK on:**
- `sense` (detection fill, engage)
- Engaged combat FSM: move / telegraph / fire / lunge / recover (+ stunned/staggered/spawning)
- Orb spawn + `step_orbs` (hits via hit buffer)
- Simple `moveBody` (terrain + AABB)
- Engaged move toward TS-supplied hunt vias (`robot_via_*`) when set
- Skip engaged step when TS `fromCover` already moved (`robot_skip`)

**Still TypeScript (hybrid after / before WASM):**
- `stepSquads` (before WASM tick)
- `tickNonEngaged`: full `calm` (patrol / party / ambush / hunt fields) + `fightFoe`
- `prepareWasmTick`: `fromCover` + hunt/pursuit vias written into SoA
- Engage `{t:"engage"}` events emitted on pull when WASM newly engages a squad
- Titan special AI (WASM holds + turns only)
- Friends (`stepFriends`), waves, player, loot, battle reckon
- View metadata (plate, rogue colours); poses can read SoA when tick is on

`Enemy` AoS objects remain the store for TS systems; during a tick the WASM SoA is authoritative for engaged combat and is pulled back. Full drop of AoS (indices-only State) is not done yet.

## Rebuild / check

```bash
npm run build:native
npm run smoke:native
npm run fill:ringfall
npm run bench:ringfall                 # tick off → hash 83b7a1d3bcf8
RINGFALL_TICK=1 npm run bench:ringfall
npm run equiv:ringfall
npm run tick-cost:ringfall -- 90
RINGFALL_TICK=1 npx tsx scripts/ringfall-tick-smoke.ts
# browser (Vite up): node scripts/ringfall-tick-browser-smoke.mjs
```
