# RINGFALL native (Rust → WASM)

One Rust crate (`native/ringfall-fill/`) compiles to **WASM for both the browser game and the Node sim**. napi-rs is not used for production.

## Architecture

| Layer | Role |
| --- | --- |
| Nav (`fill` / opt-in A*) | Landmark Dial fields; default fill WASM, A* TypeScript |
| Tick host (ABI **5**) | Enemy/orb SoA + terrain/boxes + `los` + `step_tick` (sense + calm + fightFoe + engaged + orbs); hunt vias / fromCover skip / foe idx / calm speed+flags from TS |
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

### Latest N=5 pool (50 raids/mode) — ABI 5 calm+fightFoe in WASM

| metric | mean TS | mean WASM | Δ | flag |
| --- | ---: | ---: | ---: | --- |
| extracted | 0.60 | 0.56 | +0.04 | |
| minutes | 4.99 | 5.15 | −0.16 | |
| kills | 13.2 | 13.0 | +0.2 | |
| damage | 1321 | 1339 | −18 | |
| downs | 1.18 | 1.20 | −0.02 | |
| met | 7.36 | 7.24 | +0.12 | |
| metAway | 4.76 | 4.32 | +0.44 | |
| firstMeet | 36 s | 35 s | +1 | |

No metric flagged for systematic bias.

Per-tick cost (fixed sim time):

```bash
npm run tick-cost:ringfall -- 90
```

| | CPU | wall | speedup |
| --- | ---: | ---: | --- |
| TS (90 s sim) | 14.2 s | 10.7 s | — |
| WASM tick | 7.0 s | 4.6 s | CPU **×2.0**, wall **×2.3** |

## Identity / speed (bench)

| Path | Warm CPU | Warm wall | Aggregate hash |
| --- | ---: | ---: | --- |
| Default (tick off) | ~60–64 s | ~53–56 s | **`83b7a1d3bcf8`** (must hold) |
| `RINGFALL_TICK=1` | diverges (more fights = different raid length) | — | diverges (expected) |

Cold `findPath`: TS ≈ WASM within noise; identity match (`npm run fill:ringfall`).

## Ported vs still TypeScript

**In WASM (`step_tick`) when TICK on:**
- `sense` (detection fill, engage)
- `calm` (alert search, patrol / party / ambush / walk / home hold+look)
- `fightFoe` (faction duel: move / telegraph / fire / charger melee)
- Engaged combat FSM: move / telegraph / fire / lunge / recover (+ stunned/staggered/spawning)
- Orb spawn + `step_orbs` (hits via hit buffer; foe orbs carry `by`)
- Simple `moveBody` (terrain + AABB)
- Engaged/calm move toward TS-supplied hunt vias (`robot_via_*`) when set
- Skip engaged step when TS `fromCover` already moved (`robot_skip`)
- Patrol `squad.leg` advance when calm arrives with `CALM_ADVANCE`

**Still TypeScript (prep / pull around WASM):**
- `stepSquads` (before WASM tick)
- `prepareWasmTick`: `fromCover` + hunt/trip/home vias + foe index (`foeOf`) + calm speed/flags
- Engage `{t:"engage"}` events and `fightHeard` on pull
- Titan special AI beyond wake+hold (WASM holds + turns only while engaged)
- Friends (`stepFriends`), waves, player, loot, battle reckon
- View metadata (plate, rogue colours); poses can read SoA when tick is on

`Enemy` AoS objects remain the store for TS systems; during a tick the WASM SoA is authoritative for enemies and is pulled back. Full drop of AoS (indices-only State) is not done yet.

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
