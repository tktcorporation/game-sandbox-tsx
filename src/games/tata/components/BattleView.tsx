import { useEffect, useMemo, useState } from "react";
import { buildRaid, countersOf, raidRoster, TataBattle, wavesClearedOf, type BattleSnapshot, type Raid } from "../battle";
import { ELEMENT_LABEL, speciesOf } from "../species";
import { battleRewards, elementMod, hasFurniture, labelTata, partyOf, tataAtk, tataHp } from "../logic";
import { useTata } from "../store";
import { TataSprite, ZombieSprite } from "../TataSprite";
import { ELEMENTS, type Element, type OwnedTata, type PartySlot } from "../types";

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
  const raidSeed = useTata((s) => s.raidSeed);
  const raid = useMemo(() => buildRaid(raidSeed), [raidSeed]);

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
          <p>とっぱ {snap.wavesCleared}</p>
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
              <b className={`el-dot el-${z.element}`}>{ELEMENT_LABEL[z.element]}</b>
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
              {snap.won
                ? "陣形と相性が光った。"
                : `波${snap.wavesCleared + 1}で倒れた。${snap.wavesCleared >= 2 ? "相性を変えるか、えさで育てよう。" : "おうちに帰って、えさをあげよう。"}`}
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

  const counters = countersOf(raid);
  return (
    <div className="tata-prep">
      <RaidCard raid={raid} counters={counters} />
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
            <MatchTag element={speciesOf(t.speciesId).element} raid={raid} />
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
            const b = new TataBattle(live, lantern, raid);
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

function RaidCard({ raid, counters }: { raid: Raid; counters: Element[] }) {
  const roster = raidRoster(raid);
  return (
    <section className="raid-card" aria-label="つぎの襲撃">
      <header>
        <strong>つぎの襲撃</strong>
        <span>
          ゆうり:
          {counters.map((e) => (
            <i key={e} className={`el-chip el-${e}`}>
              {ELEMENT_LABEL[e]}
            </i>
          ))}
        </span>
      </header>
      <ol className="raid-waves">
        {roster.map((w) => (
          <li key={w.wave}>
            <span className="wave-no">波{w.wave}</span>
            {ELEMENTS.filter((e) => (w.counts[e] ?? 0) > 0).map((e) => (
              <i key={e} className={`el-chip el-${e}`}>
                {ELEMENT_LABEL[e]}×{w.counts[e]}
              </i>
            ))}
            {w.boss ? <i className="boss-mark">おおゾンビ</i> : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** how this tata's element fares against the raid theme: 有利 / 不利 / nothing */
function MatchTag({ element, raid }: { element: Element; raid: Raid }) {
  const theme = [raid.primary, raid.secondary];
  const strong = theme.some((z) => elementMod(element, z) > 1);
  const weak = theme.some((z) => elementMod(z, element) > 1);
  if (strong && !weak) return <b className="match good">ゆうり</b>;
  if (weak && !strong) return <b className="match bad">ふり</b>;
  return null;
}

function TataCard({ tata, lantern }: { tata: OwnedTata; lantern: boolean }) {
  const spec = speciesOf(tata.speciesId);
  return (
    <div className="tata-card">
      <TataSprite speciesId={tata.speciesId} stage={tata.stage} shiny={tata.shiny} size={56} mood="fight" />
      <p>
        {labelTata(tata)}
        <small>
          <i className={`el-chip el-${spec.element}`}>{ELEMENT_LABEL[spec.element]}</i> HP{tataHp(tata)} ATK
          {tataAtk(tata, lantern)}
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
