import { useMemo, useState } from "react";
import { ELEMENT_LABEL, GENUS_LABEL, RARITY_LABEL, SPECIES } from "../species";
import { useTata } from "../store";
import { TataSprite } from "../TataSprite";
import type { Element, Genus } from "../types";
import { GENERA } from "../types";

export function Album() {
  const tatas = useTata((s) => s.tatas);
  const seen = useTata((s) => s.seen);
  const reset = useTata((s) => s.reset);
  const [genus, setGenus] = useState<Genus | "all">("all");
  const [picked, setPicked] = useState<string | null>(null);
  const owned = useMemo(() => {
    const m = new Map<string, { count: number; shiny: boolean; maxStage: number }>();
    for (const t of tatas) {
      const prev = m.get(t.speciesId);
      if (!prev) m.set(t.speciesId, { count: 1, shiny: t.shiny, maxStage: t.stage });
      else m.set(t.speciesId, { count: prev.count + 1, shiny: prev.shiny || t.shiny, maxStage: Math.max(prev.maxStage, t.stage) });
    }
    return m;
  }, [tatas]);
  const list = genus === "all" ? SPECIES : SPECIES.filter((s) => s.genus === genus);
  const have = owned.size;
  const inspect = picked ? SPECIES.find((s) => s.id === picked) : null;
  const rec = picked ? owned.get(picked) : null;

  return (
    <div className="tata-album">
      <p className="album-count">
        ずかん {have} / {SPECIES.length}
        <span>ピカ {tatas.filter((t) => t.shiny).length}</span>
        <button type="button" className="album-reset" onClick={reset}>
          はじめから
        </button>
      </p>
      <div className="genus-row">
        <button type="button" className={genus === "all" ? "on" : ""} onClick={() => setGenus("all")}>
          すべて
        </button>
        {GENERA.map((g) => (
          <button key={g} type="button" className={genus === g ? "on" : ""} onClick={() => setGenus(g)}>
            {GENUS_LABEL[g]}
          </button>
        ))}
      </div>
      <div className="album-grid">
        {list.map((s) => {
          const got = owned.get(s.id);
          const know = seen.includes(s.id) || !!got;
          return (
            <button
              key={s.id}
              type="button"
              className={`album-cell${got ? " got" : ""}${got?.shiny ? " shiny" : ""}`}
              onClick={() => setPicked(s.id)}
            >
              <TataSprite
                speciesId={s.id}
                stage={got ? (got.maxStage as 0 | 1 | 2 | 3) : 1}
                shiny={!!got?.shiny}
                size={48}
                silhouette={!know}
              />
              <span>{know ? s.name : "？？？"}</span>
            </button>
          );
        })}
      </div>
      {inspect ? (
        <aside className="tata-sheet">
          <button type="button" className="sheet-x" onClick={() => setPicked(null)}>
            とじる
          </button>
          <div className="sheet-hero">
            <TataSprite speciesId={inspect.id} stage={rec ? (rec.maxStage as 0 | 1 | 2 | 3) : 1} shiny={!!rec?.shiny} size={88} silhouette={!seen.includes(inspect.id) && !rec} />
            <div>
              <p className={`el-chip el-${inspect.element}`}>{ELEMENT_LABEL[inspect.element as Element]}</p>
              <h3>{seen.includes(inspect.id) || rec ? inspect.name : "？？？"}</h3>
              <p className="sheet-blurb">
                {seen.includes(inspect.id) || rec ? inspect.blurb : "まだ会っていない。おさんぽで探そう。"}
              </p>
              <p className="sheet-blurb">
                {GENUS_LABEL[inspect.genus]} · {RARITY_LABEL[inspect.rarity]}
                {rec ? ` · ${rec.count}ひき` : ""}
              </p>
            </div>
          </div>
        </aside>
      ) : null}
    </div>
  );
}
