import { useMemo } from "react";
import { buildRaid, countersOf } from "../battle";
import { ELEMENT_LABEL, RARITY_LABEL, speciesOf } from "../species";
import { catchCost, currentStamina, STROLL_PATCHES } from "../logic";
import { STAMINA_MAX } from "../types";
import { useTata } from "../store";
import { TataSprite } from "../TataSprite";

export function Stroll() {
  const stamina = useTata((s) => currentStamina(s));
  const clock = useTata((s) => s.clock);
  void clock;
  const last = useTata((s) => s.lastStroll);
  const encounter = useTata((s) => s.encounter);
  const go = useTata((s) => s.goStroll);
  const catchWild = useTata((s) => s.catchWild);
  const shoo = useTata((s) => s.shooWild);
  const berries = useTata((s) => s.berries);
  const raidSeed = useTata((s) => s.raidSeed);
  const counters = useMemo(() => countersOf(buildRaid(raidSeed)), [raidSeed]);

  return (
    <div className="tata-stroll">
      <p className="stroll-lead">
        つぎの襲撃にゆうり:
        {counters.map((e) => (
          <i key={e} className={`el-chip el-${e}`}>
            {ELEMENT_LABEL[e]}
          </i>
        ))}
      </p>
      <div className="stroll-meadow">
        <span className="stroll-sun" />
        {STROLL_PATCHES.map((p, i) => (
          <button
            key={p.element}
            type="button"
            className={`tuft${counters.includes(p.element) ? " want" : ""}`}
            style={{ left: `${p.x}%`, top: `${p.y}%`, transform: `rotate(${p.rot}deg)` }}
            onClick={() => go(i)}
            aria-label={`${p.name}（${ELEMENT_LABEL[p.element]}のタタが多い）`}
          >
            <svg viewBox="0 0 64 40" width="72" height="44" aria-hidden>
              <path d="M 4 36 Q 16 4 32 28 Q 40 6 60 36 Z" fill="#3d7a38" stroke="#2a3a14" strokeWidth="2" />
              <path d="M 12 36 Q 24 12 36 34" fill="#4e9444" />
            </svg>
            <b className={`el-chip el-${p.element}`}>{ELEMENT_LABEL[p.element]}</b>
          </button>
        ))}
      </div>
      <p className="stroll-stam">
        げんき {stamina}/{STAMINA_MAX}
        <span className="stam-pips">
          {Array.from({ length: STAMINA_MAX }, (_, i) => (
            <i key={i} className={i < stamina ? "on" : ""} />
          ))}
        </span>
      </p>
      <p className="stroll-log">{last}</p>
      {encounter ? (
        <aside className="tata-sheet encounter">
          <div className="sheet-hero">
            <TataSprite speciesId={encounter.speciesId} stage={0} shiny={encounter.shiny} size={96} mood="idle" />
            <div>
              <p className={`el-chip el-${speciesOf(encounter.speciesId).element}`}>
                {ELEMENT_LABEL[speciesOf(encounter.speciesId).element]}
              </p>
              <h3>
                {encounter.shiny ? "ピカ" : "やせいの"}
                {speciesOf(encounter.speciesId).name}
              </h3>
              <p className="sheet-blurb">{speciesOf(encounter.speciesId).blurb}</p>
              <p className="sheet-blurb">{RARITY_LABEL[speciesOf(encounter.speciesId).rarity]}</p>
            </div>
          </div>
          <div className="sheet-actions">
            <button type="button" className="btn-hero" onClick={catchWild}>
              なつく <small>きのみ {catchCost(encounter.speciesId)}/{berries}</small>
            </button>
            <button type="button" className="btn-sub" onClick={shoo}>
              にがす
            </button>
          </div>
        </aside>
      ) : null}
    </div>
  );
}
