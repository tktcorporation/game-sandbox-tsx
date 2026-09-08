import { useEffect, useState } from "react";
import { TataBattle, wavesClearedOf, type BattleSnapshot } from "../battle";
import { ELEMENT_LABEL, speciesOf } from "../species";
import { battleRewards, hasFurniture, labelTata, partyOf, tataAtk, tataHp } from "../logic";
import { useTata } from "../store";
import { TataSprite, ZombieSprite } from "../TataSprite";
import type { OwnedTata, PartySlot } from "../types";

export function BattleView() {
  const tatas = useTata((s) => s.tatas);
  const furniture = useTata((s) => s.furniture);
  const party = partyOf({ tatas });
  const lantern = hasFurniture({ furniture }, "lantern");
  const [fight, setFight] = useState<TataBattle | null>(null);
  const [snap, setSnap] = useState<BattleSnapshot | null>(null);
  const fillParty = useTata((s) => s.fillParty);
  const setParty = useTata((s) => s.setParty);
  const applyRewards = useTata((s) => s.applyRewards);

  useEffect(() => {
    if (!fight) return;
    let raf = 0;
    let last = performance.now();
    const loop = (t: number) => {
      const dt = Math.min(0.05, (t - last) / 1000);
      last = t;
      fight.tick(dt);
      setSnap(fight.snapshot());
      if (!fight.over) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [fight]);

  if (fight && snap) {
    return (
      <div className="tata-battle">
        <header className="battle-hud">
          <p>
            波 {snap.wave}/{snap.maxWaves}
          </p>
          <p>のこり {snap.incoming}</p>
        </header>
        <div className="battle-field">
          {snap.tatas.map((a) => (
            <div
              key={a.id}
              className={`battler tata${a.flash > 0 ? " hit" : ""}`}
              style={{ left: `${a.x}%`, top: `${a.y}%` }}
            >
              {a.speciesId ? (
                <TataSprite speciesId={a.speciesId} stage={a.stage ?? 1} shiny={!!a.shiny} size={56} mood="fight" />
              ) : null}
              <i className="hp" style={{ width: `${(a.hp / a.maxHp) * 100}%` }} />
            </div>
          ))}
          {snap.zombies.map((z) => (
            <div
              key={z.id}
              className={`battler zom${z.flash > 0 ? " hit" : ""}`}
              style={{ left: `${z.x}%`, top: `${z.y}%` }}
            >
              <ZombieSprite kind={z.kind ?? "walker"} size={z.kind === "boss" ? 64 : 48} />
              <i className="hp z" style={{ width: `${(z.hp / z.maxHp) * 100}%` }} />
            </div>
          ))}
          {snap.flashes.map((f, i) => (
            <span key={i} className={`b-flash ${f.tint}`} style={{ left: `${f.x}%`, top: `${f.y}%` }} />
          ))}
        </div>
        {snap.over ? (
          <div className="tata-sheet encounter">
            <h3>{snap.won ? "ゾンビ、たいさん！" : "タタたちが倒れた…"}</h3>
            <p className="sheet-blurb">
              {snap.won ? "陣形と相性が光った。" : "おうちに帰って、えさをあげよう。"}
            </p>
            <button
              type="button"
              className="btn-hero"
              onClick={() => {
                const waves = wavesClearedOf(fight);
                const r = battleRewards(waves, snap.won);
                applyRewards(r.berries, r.shards, r.scrap, waves);
              }}
            >
              おうちへ
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="tata-prep">
      <p className="prep-lead">3ひきのじんけい。まえが盾、うしろが遠距離。火は草に強い。</p>
      <div className="prep-slots">
        {([0, 1, 2] as PartySlot[]).map((slot) => {
          const t = tatas.find((x) => x.partySlot === slot);
          return (
            <div key={slot} className="prep-slot">
              <span>{slot === 2 ? "うしろ" : slot === 0 ? "まえ左" : "まえ右"}</span>
              {t ? <TataCard tata={t} lantern={lantern} /> : <div className="prep-empty">空き</div>}
            </div>
          );
        })}
      </div>
      <div className="prep-bench">
        {tatas.map((t) => (
          <button
            key={t.uid}
            type="button"
            className={`bench${t.partySlot !== null ? " in" : ""}`}
            onClick={() => {
              const next = t.partySlot === null ? (emptySlot(tatas) as PartySlot | null) : null;
              if (t.partySlot !== null) setParty(t.uid, null);
              else if (next !== null) setParty(t.uid, next);
            }}
          >
            <TataSprite speciesId={t.speciesId} stage={t.stage} shiny={t.shiny} size={44} />
            <em>{labelTata(t)}</em>
          </button>
        ))}
      </div>
      <div className="prep-actions">
        <button type="button" className="btn-sub" onClick={fillParty}>
          おまかせ
        </button>
        <button
          type="button"
          className="btn-hero"
          disabled={party.length === 0}
          onClick={() => {
            const live = partyOf(useTata.getState());
            if (live.length === 0) return;
            const seed = (Math.random() * 1e9) | 0;
            const b = new TataBattle(live, lantern, seed);
            setFight(b);
            setSnap(b.snapshot());
          }}
        >
          しゅつじん！
        </button>
      </div>
    </div>
  );
}

function TataCard({ tata, lantern }: { tata: OwnedTata; lantern: boolean }) {
  const spec = speciesOf(tata.speciesId);
  return (
    <div className="tata-card">
      <TataSprite speciesId={tata.speciesId} stage={tata.stage} shiny={tata.shiny} size={56} mood="fight" />
      <p>
        {labelTata(tata)}
        <small>
          {ELEMENT_LABEL[spec.element]} HP{tataHp(tata)} ATK{tataAtk(tata, lantern)}
        </small>
      </p>
    </div>
  );
}

function emptySlot(tatas: OwnedTata[]): PartySlot | null {
  for (const s of [0, 1, 2] as PartySlot[]) {
    if (!tatas.some((t) => t.partySlot === s)) return s;
  }
  return null;
}
