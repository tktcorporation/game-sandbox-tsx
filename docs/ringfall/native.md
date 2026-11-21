# RINGFALL native (Rust → WASM)

One Rust crate (`native/ringfall-fill/`) compiles to **WASM for both the browser game and the Node sim**. napi-rs is not used for production.

## Architecture

| Layer | Role |
| --- | --- |
| Nav (`fill` / opt-in A*) | Landmark Dial fields; default fill WASM, A* TypeScript |
| Tick host (ABI **3**) | Enemy/orb SoA + terrain/boxes + `los` + `step_tick` (sense + engaged combat + orbs) |
| Default sim path (Node) | TypeScript `stepEnemies` / `stepOrbs` — **no** per-tick SoA/geom work |
| Browser default | Tick **on** (same WASM module as Node) |

`ringfall_step_tick` returns **-1** until geom is uploaded; **0** after enemies then orbs.

## Switches

| Flag | Effect |
| --- | --- |
| `RINGFALL_FILL=ts` / `?ringfallNative=0` | Disable WASM (nav + tick) |
| `RINGFALL_ASTAR=1` | Opt-in WASM A* (warm is slower) |
| `RINGFALL_TICK=1` | Geom + sync → WASM **enemies + orbs** (orbs folded into tick) |
| `RINGFALL_TICK=0` / `?ringfallTick=0` | Force TypeScript enemies + orbs (fallback) |
| Browser default | Tick **on** unless explicitly `0` |
| Node default | Tick **off** (bench hash stays on TypeScript) |

## Equivalence criterion (tick on)

Bit-identical bench hash is **not** required when the tick host is on. Small float drift (~1 ULP/tick in `los` / terrain rays) can change individual hits; that is accepted.

Validation is **statistical**:

```bash
npm run equiv:ringfall          # N=30 per bench job × 10 jobs, TS ∥ WASM
npm run equiv:ringfall -- 10    # shorter
```

Compares pooled means/SD of raid aggregates with a Welch t-test. **BIAS** when p&lt;0.05 and |Δ| &gt; pooled SD; `~` when p&lt;0.05 with a material but smaller gap. Exit 0 even when hashes differ; real crashes fail. Raids stuck at the 30‑minute LIMIT are soft-counted as wipes.

### Latest N=30 pool (300 raids/mode)

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

**Plain reading:** extract rate / downs / haul are close. WASM combat meets fewer squads and deals less damage (hunt / cover / `fightFoe` / full calm still TypeScript; sense+FSM+orbs are WASM). Not yet “no systematic bias” on engagement metrics — keep iterating or keep tick opt-in for balance-sensitive work.

Per-tick cost (fixed sim time):

```bash
npm run tick-cost:ringfall -- 90
```

| | CPU | wall | speedup |
| --- | ---: | ---: | ---: |
| TS (90 s sim) | 14.9 s | 10.2 s | — |
| WASM tick | 5.3 s | 3.2 s | CPU **×2.8**, wall **×3.2** |

So the tick host **is** faster per sim-second. Equiv wall is higher for WASM because raids run longer / quieter with weaker engagement — not because each tick is slower.

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
- Calm: walk toward goal / home (no full patrol / hunt fields)

**Still TypeScript (AoS mirror kept for these):**
- `stepSquads` (before WASM tick)
- Cover peeking (`fromCover`), pinch / flank / hunt distance fields
- `fightFoe` / faction fights
- Titan special AI (WASM holds + turns only)
- Friends (`stepFriends`), waves, player, loot, battle reckon
- View metadata (plate, rogue colours); poses can read SoA when tick is on

`Enemy` AoS objects remain the store for TS systems; during a tick the WASM SoA is authoritative and is pulled back. Full drop of AoS (indices-only State) is not done yet.

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
